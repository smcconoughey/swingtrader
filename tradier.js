/**
 * tradier.js — Tradier Brokerage + Market Data arm
 *
 * A self-contained client for Tradier's REST API, mirroring the shape of robinhood.js.
 * Tradier is both a market-data provider (real-time quotes + full option chains with
 * ORATS Greeks/IV) AND a broker (equity + native options order execution), so this module
 * doubles as the bot's accurate data feed and an optional live-execution venue.
 *
 * The bot continues to use its existing LLM (Claude/Gemini) and news (Finnhub) pipeline —
 * Tradier only supplies price/options market data and (optionally) order execution.
 *
 * Auth: a single bearer access token (no OAuth dance for personal tokens).
 *   - Production token (with a funded brokerage account) → real-time data.
 *   - Sandbox token → delayed/simulated data, good for development.
 *
 * Env vars:
 *   TRADIER_ACCESS_TOKEN   — required
 *   TRADIER_ENV            — "production" (default) | "sandbox"
 *   TRADIER_ACCOUNT_ID     — optional; auto-discovered from the user profile if omitted
 *
 * Usage:
 *   import { tradier } from './tradier.js';
 *   await tradier.init();
 *   const q = await tradier.getQuote('AAPL');
 *   const chain = await tradier.getOptionsChainNormalized('AAPL'); // Finnhub-shaped
 */

import fetch from "node-fetch";
import fs from "fs";
import crypto from "crypto";

// ─── Configuration ───

const ENV = (process.env.TRADIER_ENV || "production").toLowerCase();
const BASE_URL = ENV === "sandbox"
  ? "https://sandbox.tradier.com/v1"
  : "https://api.tradier.com/v1";

const TOKEN_FILE = "tradier_tokens.json";
const PENDING_ORDERS_FILE = "tradier_pending.json";

// How far out (in days) to pull option expirations, and how many expirations to fetch per chain
// request. Each expiration is a separate Tradier call, so we cap to stay within rate limits.
const CHAIN_MAX_DTE = 45;
const CHAIN_MIN_DTE = 7;
const CHAIN_MAX_EXPIRIES = 8;

// ─── State ───

let accessToken = null;
let accountId = null;
let connected = false;
let pendingOrders = [];

// ─── HTTP Transport ───

async function apiGet(path, params = {}) {
  if (!accessToken) throw new Error("Tradier not authenticated. Set TRADIER_ACCESS_TOKEN.");
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Tradier GET ${path} → HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function apiSend(method, path, form = {}) {
  if (!accessToken) throw new Error("Tradier not authenticated. Set TRADIER_ACCESS_TOKEN.");
  const body = new URLSearchParams(form).toString();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Tradier ${method} ${path} → HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// Tradier collapses single-element arrays into a bare object. Always coerce to an array.
function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// ─── Token Persistence ───

function loadTokens() {
  const envToken = (process.env.TRADIER_ACCESS_TOKEN || "").trim();
  if (envToken) {
    accessToken = envToken;
    accountId = (process.env.TRADIER_ACCOUNT_ID || "").trim() || null;
    return true;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      accessToken = data.accessToken || null;
      accountId = data.accountId || null;
      return !!accessToken;
    }
  } catch { }
  return false;
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      accessToken,
      accountId,
      env: ENV,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.error(`  [TR] Failed to save tokens: ${e.message}`);
  }
}

// ─── Pending Orders (approval queue) ───

function loadPendingOrders() {
  try {
    if (fs.existsSync(PENDING_ORDERS_FILE)) {
      pendingOrders = JSON.parse(fs.readFileSync(PENDING_ORDERS_FILE, "utf-8"));
    }
  } catch { pendingOrders = []; }
}

function savePendingOrders() {
  try {
    fs.writeFileSync(PENDING_ORDERS_FILE, JSON.stringify(pendingOrders, null, 2));
  } catch { }
}

// ─── OCC Option Symbol Builder ───
// e.g. buildOCC("SPY", "2026-06-19", "call", 450) → "SPY260619C00450000"
function buildOCC(symbol, expiration, type, strike) {
  const d = new Date(expiration);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const cp = type.toLowerCase().startsWith("c") ? "C" : "P";
  const strikeInt = Math.round(strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, "0");
  return `${symbol.toUpperCase()}${yy}${mm}${dd}${cp}${strikeStr}`;
}

// ─── Public API ───

const tradier = {
  get isConnected() { return connected; },
  get isAuthenticated() { return !!accessToken; },
  get environment() { return ENV; },
  get accountId() { return accountId; },
  get pendingOrders() { return [...pendingOrders]; },

  /**
   * Verify the token, discover the account id, and mark the arm connected.
   */
  async init() {
    if (!loadTokens()) {
      console.log("  [TR] No Tradier token found. Set TRADIER_ACCESS_TOKEN env var.");
      return false;
    }
    try {
      // Discover the account id from the user profile unless one was provided.
      if (!accountId) {
        const profile = await apiGet("/user/profile");
        const accts = asArray(profile?.profile?.account);
        if (accts.length > 0) accountId = accts[0].account_number;
      }
      // A market-data probe doubles as an auth check.
      await apiGet("/markets/clock");
      connected = true;
      loadPendingOrders();
      console.log(`  [TR] Tradier connected ✓ (${ENV}${accountId ? `, account ${accountId}` : ", data-only"})`);
      return true;
    } catch (e) {
      console.log(`  [TR] init failed: ${e.message}`);
      connected = false;
      return false;
    }
  },

  // ─── Market Data ───

  /**
   * Market clock / status.
   */
  async getClock() {
    const data = await apiGet("/markets/clock");
    return data?.clock || null;
  },

  /**
   * Real-time quote for a single symbol, normalized to the bot's shape
   * ({ c, h, l, o, pc, bid, ask, volume }).
   */
  async getQuote(symbol) {
    const data = await apiGet("/markets/quotes", { symbols: symbol.toUpperCase(), greeks: "false" });
    const q = asArray(data?.quotes?.quote)[0];
    if (!q) return null;
    return normalizeQuote(q);
  },

  /**
   * Batch real-time quotes. Returns a map of { SYMBOL: normalizedQuote }.
   */
  async getQuotes(symbols) {
    const list = symbols.map(s => s.toUpperCase()).join(",");
    const data = await apiGet("/markets/quotes", { symbols: list, greeks: "false" });
    const out = {};
    for (const q of asArray(data?.quotes?.quote)) {
      if (q && q.symbol) out[q.symbol] = normalizeQuote(q);
    }
    return out;
  },

  /**
   * Daily historical candles, normalized to [{ c, h, l, o, v, t }] (t = unix seconds).
   */
  async getHistoricals(symbol, days = 90) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const fmt = d => d.toISOString().slice(0, 10);
    const data = await apiGet("/markets/history", {
      symbol: symbol.toUpperCase(),
      interval: "daily",
      start: fmt(start),
      end: fmt(end),
    });
    const days_ = asArray(data?.history?.day);
    return days_.map(d => ({
      c: d.close, h: d.high, l: d.low, o: d.open, v: d.volume,
      t: Math.floor(new Date(d.date).getTime() / 1000),
    })).filter(c => c.c != null);
  },

  /**
   * Available option expiration dates (YYYY-MM-DD strings) for a symbol.
   */
  async getOptionExpirations(symbol) {
    const data = await apiGet("/markets/options/expirations", {
      symbol: symbol.toUpperCase(),
      includeAllRoots: "true",
      strikes: "false",
    });
    return asArray(data?.expirations?.date);
  },

  /**
   * Raw option chain (single expiration) with Greeks/IV from Tradier.
   */
  async getOptionChain(symbol, expiration) {
    const data = await apiGet("/markets/options/chains", {
      symbol: symbol.toUpperCase(),
      expiration,
      greeks: "true",
    });
    return asArray(data?.options?.option);
  },

  /**
   * Full option chain across near-dated expirations, normalized into the same shape the bot's
   * buildCandidateContracts() expects from Finnhub:
   *   [{ expirationDate, options: { CALL: [...], PUT: [...] } }]
   * Each contract: { strike, bid, ask, openInterest, volume, impliedVolatility, delta }.
   */
  async getOptionsChainNormalized(symbol) {
    const now = Date.now();
    let expirations = await this.getOptionExpirations(symbol);
    // Keep expirations within the swing horizon, then cap the count to bound API calls.
    expirations = expirations
      .map(date => {
        const ts = new Date(`${date}T16:00:00`).getTime();
        const dte = Math.round((ts - now) / 86400_000);
        return { date, dte };
      })
      .filter(e => e.dte >= CHAIN_MIN_DTE && e.dte <= CHAIN_MAX_DTE)
      .sort((a, b) => a.dte - b.dte)
      .slice(0, CHAIN_MAX_EXPIRIES);

    const out = [];
    for (const exp of expirations) {
      let contracts;
      try {
        contracts = await this.getOptionChain(symbol, exp.date);
      } catch {
        continue;
      }
      const CALL = [];
      const PUT = [];
      for (const c of contracts) {
        const g = c.greeks || {};
        const norm = {
          strike: c.strike,
          bid: c.bid,
          ask: c.ask,
          openInterest: c.open_interest || 0,
          volume: c.volume || 0,
          impliedVolatility: g.mid_iv ?? g.smv_vol ?? null,
          delta: g.delta ?? null,
          gamma: g.gamma ?? null,
          theta: g.theta ?? null,
          vega: g.vega ?? null,
        };
        if ((c.option_type || "").toLowerCase() === "call") CALL.push(norm);
        else if ((c.option_type || "").toLowerCase() === "put") PUT.push(norm);
      }
      out.push({ expirationDate: exp.date, options: { CALL, PUT } });
    }
    return out.length > 0 ? out : null;
  },

  /**
   * Live quote for a specific OCC option symbol (for marking open positions to market).
   * Returns { bid, ask, last, mid, iv, delta, theta } or null.
   */
  async getOptionQuote(occSymbol) {
    const data = await apiGet("/markets/quotes", { symbols: occSymbol, greeks: "true" });
    const q = asArray(data?.quotes?.quote)[0];
    if (!q) return null;
    const g = q.greeks || {};
    const mid = q.bid != null && q.ask != null ? +(((q.bid + q.ask) / 2)).toFixed(2) : q.last;
    return { bid: q.bid, ask: q.ask, last: q.last, mid, iv: g.mid_iv ?? null, delta: g.delta ?? null, theta: g.theta ?? null };
  },

  // ─── Account ───

  async getAccount() {
    if (!accountId) throw new Error("No Tradier account id (data-only token).");
    const data = await apiGet(`/accounts/${accountId}/balances`);
    return data?.balances || null;
  },

  async getPositions() {
    if (!accountId) throw new Error("No Tradier account id (data-only token).");
    const data = await apiGet(`/accounts/${accountId}/positions`);
    return asArray(data?.positions?.position);
  },

  async getOrders() {
    if (!accountId) throw new Error("No Tradier account id (data-only token).");
    const data = await apiGet(`/accounts/${accountId}/orders`);
    return asArray(data?.orders?.order);
  },

  // ─── Execution ───

  /**
   * Place an equity order.
   */
  async placeStockOrder(symbol, side, quantity, orderType = "market", limitPrice = null, duration = "day") {
    if (!accountId) throw new Error("No Tradier account id — cannot place orders with a data-only token.");
    const form = {
      class: "equity",
      symbol: symbol.toUpperCase(),
      side, // buy | sell | sell_short | buy_to_cover
      quantity,
      type: orderType, // market | limit | stop | stop_limit
      duration,
    };
    if ((orderType === "limit" || orderType === "stop_limit") && limitPrice) form.price = limitPrice;
    console.log(`  [TR] EQUITY ${side.toUpperCase()} ${quantity} ${symbol} (${orderType}${limitPrice ? ` @ $${limitPrice}` : ""})`);
    const data = await apiSend("POST", `/accounts/${accountId}/orders`, form);
    return data?.order || data;
  },

  /**
   * Place a native options order. side: buy_to_open | sell_to_close | sell_to_open | buy_to_close.
   */
  async placeOptionOrder(symbol, expiration, optionType, strike, side, quantity, orderType = "limit", limitPrice = null, duration = "day") {
    if (!accountId) throw new Error("No Tradier account id — cannot place orders with a data-only token.");
    const occ = buildOCC(symbol, expiration, optionType, strike);
    const form = {
      class: "option",
      symbol: symbol.toUpperCase(),
      option_symbol: occ,
      side,
      quantity,
      type: orderType,
      duration,
    };
    if ((orderType === "limit" || orderType === "stop_limit") && limitPrice) form.price = limitPrice;
    console.log(`  [TR] OPTION ${side.toUpperCase()} ${quantity} ${occ} (${orderType}${limitPrice ? ` @ $${limitPrice}` : ""})`);
    const data = await apiSend("POST", `/accounts/${accountId}/orders`, form);
    return data?.order || data;
  },

  async cancelOrder(orderId) {
    if (!accountId) throw new Error("No Tradier account id.");
    const data = await apiSend("DELETE", `/accounts/${accountId}/orders/${orderId}`);
    return data?.order || data;
  },

  // ─── Approval Queue (mirrors robinhood.js) ───

  queueOrder(details) {
    const order = {
      id: crypto.randomUUID(),
      ...details,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    pendingOrders.push(order);
    savePendingOrders();
    return order;
  },

  async approveOrder(orderId) {
    const idx = pendingOrders.findIndex(o => o.id === orderId);
    if (idx === -1) throw new Error(`Pending order ${orderId} not found`);
    const order = pendingOrders[idx];
    order.status = "approved";
    try {
      let result;
      if (order.assetClass === "option") {
        result = await this.placeOptionOrder(
          order.symbol, order.expiration, order.optionType, order.strike,
          order.side, order.quantity, order.orderType || "limit", order.limitPrice
        );
      } else {
        result = await this.placeStockOrder(
          order.symbol, order.side, order.quantity, order.orderType || "market", order.limitPrice
        );
      }
      order.status = "executed";
      order.result = result;
      order.executedAt = new Date().toISOString();
    } catch (e) {
      order.status = "failed";
      order.error = e.message;
    }
    pendingOrders.splice(idx, 1);
    savePendingOrders();
    return order;
  },

  rejectOrder(orderId) {
    const idx = pendingOrders.findIndex(o => o.id === orderId);
    if (idx === -1) throw new Error(`Pending order ${orderId} not found`);
    const order = pendingOrders.splice(idx, 1)[0];
    order.status = "rejected";
    order.rejectedAt = new Date().toISOString();
    savePendingOrders();
    return order;
  },

  setToken(token, acctId = null) {
    accessToken = token;
    if (acctId) accountId = acctId;
    saveTokens();
  },

  buildOCC,
};

function normalizeQuote(q) {
  return {
    c: q.last ?? q.close ?? null,
    h: q.high ?? q.last ?? null,
    l: q.low ?? q.last ?? null,
    o: q.open ?? q.last ?? null,
    pc: q.prevclose ?? 0,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    volume: q.volume ?? 0,
  };
}

export { tradier };
export default tradier;
