import "dotenv/config";
import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import http from "http";
import { TwitterApi } from "twitter-api-v2";
import { Resvg } from "@resvg/resvg-js";

// ─── Technical Analysis Engine (ported from live-swing-simulator.jsx) ───

const calcEMA = (data, period) => {
  const k = 2 / (period + 1);
  let ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
};

const calcRSI = (data, period = 14) => {
  let g = [], l = [];
  for (let i = 1; i < data.length; i++) { const d = data[i] - data[i - 1]; g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0); }
  let rsi = new Array(period).fill(50);
  let ag = g.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = l.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < g.length; i++) {
    ag = (ag * (period - 1) + g[i]) / period; al = (al * (period - 1) + l[i]) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
};

const calcATR = (h, l, c, period = 14) => {
  let trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let atr = [trs.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < trs.length; i++) atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period);
  return atr;
};

function runAnalysis(candles) {
  if (!candles || candles.length < 55) return null;
  const closes = candles.map(d => d.c), highs = candles.map(d => d.h), lows = candles.map(d => d.l), volumes = candles.map(d => d.v);
  const ema8 = calcEMA(closes, 8), ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes, 14), atr = calcATR(highs, lows, closes, 14);
  const L = closes.length - 1, c = closes[L];
  const aligned = ema8[L] > ema21[L] && ema21[L] > ema50[L];
  const bearish = ema8[L] < ema21[L] && ema21[L] < ema50[L];
  const spread = ((ema8[L] - ema50[L]) / ema50[L]) * 100;
  const avgV20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgV5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vr = avgV20 > 0 ? avgV5 / avgV20 : 1;
  const pb8 = c <= ema8[L] * 1.005 && c >= ema8[L] * 0.99;
  const pb21 = c <= ema21[L] * 1.005 && c >= ema21[L] * 0.99;
  const rV = rsi[rsi.length - 1] || 50;
  const aV = atr[atr.length - 1] || c * 0.02;

  const sigs = [];

  // ─── Bullish score (0 to 100) ───
  let bull = 0;
  if (aligned) { bull += 25; sigs.push({ t: "bull", text: "EMA Stack Aligned (8>21>50)" }); }
  const xover = ema8[L] > ema21[L] && L >= 3 && ema8[L - 3] <= ema21[L - 3];
  if (xover) { bull += 20; sigs.push({ t: "bull", text: "Fresh 8/21 EMA Bullish Crossover" }); }
  if (aligned && pb8 && vr < 0.85) { bull += 20; sigs.push({ t: "bull", text: "Pullback to 8 EMA on low volume" }); }
  else if (aligned && pb21 && vr < 0.85) { bull += 15; sigs.push({ t: "bull", text: "Pullback to 21 EMA on low volume" }); }
  if (vr > 1.15 && aligned) { bull += 15; sigs.push({ t: "bull", text: "Volume expanding with trend" }); }
  if (rV > 50 && rV < 70 && aligned) { bull += 10; sigs.push({ t: "bull", text: `RSI ${rV.toFixed(0)} — healthy bullish momentum` }); }
  if (rV <= 30) { bull += 10; sigs.push({ t: "bull", text: `RSI ${rV.toFixed(0)} — oversold, bounce candidate` }); }

  let hh = 0, hl = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] > highs[i]) hh++; if (lows[i + 1] > lows[i]) hl++; }
  const trendUp = ((hh + hl) / 18) * 100;
  if (trendUp > 60) { bull += 10; sigs.push({ t: "bull", text: `Uptrend structure ${trendUp.toFixed(0)}%` }); }

  // ─── SRxTrades: Undercut & Reclaim (bullish reversal) ───
  const ur = detectUndercutReclaim(candles);
  if (ur.detected) {
    const urBoost = Math.round(ur.quality * 0.25); // Up to +25 bull score
    bull += urBoost;
    sigs.push({ t: "bull", text: `U&R detected (${ur.quality}/100) — ${ur.reasons.slice(0, 2).join(", ")}` });
  }

  // ─── Bearish score (0 to 100) ───
  let bear = 0;
  if (bearish) { bear += 25; sigs.push({ t: "bear", text: "EMA Stack Bearish (8<21<50)" }); }
  const xoverBear = ema8[L] < ema21[L] && L >= 3 && ema8[L - 3] >= ema21[L - 3];
  if (xoverBear) { bear += 20; sigs.push({ t: "bear", text: "Fresh 8/21 EMA Bearish Crossover" }); }
  // Bounce to EMA resistance in downtrend
  const res8 = c >= ema8[L] * 0.995 && c <= ema8[L] * 1.01;
  const res21 = c >= ema21[L] * 0.995 && c <= ema21[L] * 1.01;
  if (bearish && res8 && vr < 0.85) { bear += 20; sigs.push({ t: "bear", text: "Rejection at 8 EMA resistance on low volume" }); }
  else if (bearish && res21 && vr < 0.85) { bear += 15; sigs.push({ t: "bear", text: "Rejection at 21 EMA resistance on low volume" }); }
  if (vr > 1.15 && bearish) { bear += 15; sigs.push({ t: "bear", text: "Volume expanding with downtrend" }); }
  if (rV >= 70) { bear += 10; sigs.push({ t: "bear", text: `RSI ${rV.toFixed(0)} — overbought, reversal candidate` }); }
  if (rV < 50 && rV > 30 && bearish) { bear += 10; sigs.push({ t: "bear", text: `RSI ${rV.toFixed(0)} — bearish momentum` }); }

  // Downtrend structure: lower highs and lower lows
  let lh = 0, ll = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] < highs[i]) lh++; if (lows[i + 1] < lows[i]) ll++; }
  const trendDn = ((lh + ll) / 18) * 100;
  if (trendDn > 60) { bear += 10; sigs.push({ t: "bear", text: `Downtrend structure ${trendDn.toFixed(0)}%` }); }

  // ─── SRxTrades: Uppercut / Failed Breakout (bearish reversal) ───
  const uc = detectUppercut(candles);
  if (uc.detected) {
    const ucBoost = Math.round(uc.quality * 0.25); // Up to +25 bear score
    bear += ucBoost;
    sigs.push({ t: "bear", text: `Uppercut detected (${uc.quality}/100) — ${uc.reasons.slice(0, 2).join(", ")}` });
  }

  // Price distance from 50 EMA — further below = stronger bear
  if (bearish && spread < -1) { bear += 5; sigs.push({ t: "bear", text: `Price ${Math.abs(spread).toFixed(1)}% below 50 EMA` }); }

  // Clamp
  bull = Math.max(0, Math.min(100, bull));
  bear = Math.max(0, Math.min(100, bear));

  // Combined score: positive = bullish, negative = bearish. Range -100 to +100.
  // Map to 0-100 for display: 50 = neutral, >50 = bullish, <50 = bearish
  const netScore = bull - bear;
  const displayScore = Math.max(0, Math.min(100, 50 + netScore / 2));

  let sig;
  if (displayScore >= 70) sig = "STRONG BUY";
  else if (displayScore >= 55) sig = "BUY WATCH";
  else if (displayScore >= 45) sig = "NEUTRAL";
  else if (displayScore >= 30) sig = "SELL WATCH";
  else sig = "STRONG SELL";

  return {
    score: Math.round(displayScore), bullScore: bull, bearScore: bear,
    signal: sig, sigs, price: c,
    ema8v: ema8[L], ema21v: ema21[L], ema50v: ema50[L],
    aligned, bearish, spread, rsi: rV, atr: aV, atrPct: (aV / c) * 100, vr,
    stop: +(c - aV * 1.5).toFixed(2), t1: +(c + aV * 2).toFixed(2), t2: +(c + aV * 3).toFixed(2),
    rr: ((aV * 2) / Math.max(0.01, aV * 1.5)).toFixed(1),
  };
}

// ─── Short-Term Analysis (7-day focus for contract-duration signals) ───

function runShortTermAnalysis(candles) {
  if (!candles || candles.length < 15) return null;

  // Use only last 14 candles (≈2 weeks) — matches 7-day contract horizon
  const recent = candles.slice(-14);
  const closes = recent.map(d => d.c), highs = recent.map(d => d.h), lows = recent.map(d => d.l), volumes = recent.map(d => d.v);
  const L = closes.length - 1, c = closes[L];

  // Fast EMAs: 3/5/8 on the short window
  const ema3 = calcEMA(closes, 3), ema5 = calcEMA(closes, 5), ema8 = calcEMA(closes, 8);
  // Short RSI (5-period)
  const rsi5 = calcRSI(closes, 5);
  const rV = rsi5[rsi5.length - 1] || 50;

  // Momentum: % change over 1d, 3d, 5d, 7d
  const mom1d = L >= 1 ? ((c - closes[L - 1]) / closes[L - 1]) * 100 : 0;
  const mom3d = L >= 3 ? ((c - closes[L - 3]) / closes[L - 3]) * 100 : 0;
  const mom5d = L >= 5 ? ((c - closes[L - 5]) / closes[L - 5]) * 100 : 0;
  const mom7d = L >= 7 ? ((c - closes[L - 7]) / closes[L - 7]) * 100 : 0;

  // Volume trend: last 3 days vs prior 5 days
  const recentV3 = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const priorV5 = volumes.slice(-8, -3).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-8, -3).length);
  const vr = priorV5 > 0 ? recentV3 / priorV5 : 1;

  // Fast EMA alignment
  const aligned = ema3[L] > ema5[L] && ema5[L] > ema8[L];
  const bearish = ema3[L] < ema5[L] && ema5[L] < ema8[L];
  const spread = ((ema3[L] - ema8[L]) / ema8[L]) * 100;

  // Recent high/low range
  const recentHigh = Math.max(...highs.slice(-7));
  const recentLow = Math.min(...lows.slice(-7));
  const range7d = ((recentHigh - recentLow) / recentLow) * 100;
  const nearHigh = c >= recentHigh * 0.995;
  const nearLow = c <= recentLow * 1.005;

  // Trend structure over last 7 days
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = Math.max(0, L - 6); i < L; i++) {
    if (highs[i + 1] > highs[i]) hh++; else lh++;
    if (lows[i + 1] > lows[i]) hl++; else ll++;
  }

  const sigs = [];

  // ─── Short-term Bull Score ───
  let bull = 0;
  if (aligned) { bull += 20; sigs.push({ t: "bull", text: "Fast EMA aligned (3>5>8)" }); }
  const xover = ema3[L] > ema5[L] && L >= 2 && ema3[L - 2] <= ema5[L - 2];
  if (xover) { bull += 20; sigs.push({ t: "bull", text: "Fresh 3/5 EMA bullish crossover" }); }
  if (mom3d > 1.5) { bull += 15; sigs.push({ t: "bull", text: `3-day momentum +${mom3d.toFixed(1)}%` }); }
  else if (mom3d > 0.5) { bull += 8; sigs.push({ t: "bull", text: `3-day momentum +${mom3d.toFixed(1)}%` }); }
  if (mom7d > 3) { bull += 10; sigs.push({ t: "bull", text: `7-day momentum +${mom7d.toFixed(1)}%` }); }
  if (nearHigh && vr > 1.1) { bull += 15; sigs.push({ t: "bull", text: "Near 7d high on expanding volume" }); }
  if (rV <= 25) { bull += 10; sigs.push({ t: "bull", text: `RSI(5) ${rV.toFixed(0)} — oversold bounce setup` }); }
  if (rV > 55 && rV < 75 && aligned) { bull += 10; sigs.push({ t: "bull", text: `RSI(5) ${rV.toFixed(0)} — strong momentum` }); }
  const upTrend = ((hh + hl) / 12) * 100;
  if (upTrend > 65) { bull += 10; sigs.push({ t: "bull", text: `7d uptrend ${upTrend.toFixed(0)}%` }); }

  // ─── SRxTrades: Short-term U&R (bullish reversal on recent candles) ───
  const stUr = detectUndercutReclaim(candles);
  if (stUr.detected) {
    const urBoost = Math.round(stUr.quality * 0.20); // Up to +20 in short-term
    bull += urBoost;
    sigs.push({ t: "bull", text: `[ST] U&R setup (${stUr.quality}/100) — ${stUr.reasons.slice(0, 2).join(", ")}` });
  }

  // ─── Short-term Bear Score ───
  let bear = 0;
  if (bearish) { bear += 20; sigs.push({ t: "bear", text: "Fast EMA bearish (3<5<8)" }); }
  const xoverBear = ema3[L] < ema5[L] && L >= 2 && ema3[L - 2] >= ema5[L - 2];
  if (xoverBear) { bear += 20; sigs.push({ t: "bear", text: "Fresh 3/5 EMA bearish crossover" }); }
  if (mom3d < -1.5) { bear += 15; sigs.push({ t: "bear", text: `3-day momentum ${mom3d.toFixed(1)}%` }); }
  else if (mom3d < -0.5) { bear += 8; sigs.push({ t: "bear", text: `3-day momentum ${mom3d.toFixed(1)}%` }); }
  if (mom7d < -3) { bear += 10; sigs.push({ t: "bear", text: `7-day momentum ${mom7d.toFixed(1)}%` }); }
  if (nearLow && vr > 1.1) { bear += 15; sigs.push({ t: "bear", text: "Near 7d low on expanding volume" }); }
  if (rV >= 75) { bear += 10; sigs.push({ t: "bear", text: `RSI(5) ${rV.toFixed(0)} — overbought reversal setup` }); }
  if (rV < 45 && rV > 25 && bearish) { bear += 10; sigs.push({ t: "bear", text: `RSI(5) ${rV.toFixed(0)} — bearish pressure` }); }

  // ─── SRxTrades: Short-term Uppercut (bearish failed breakout) ───
  const stUc = detectUppercut(candles);
  if (stUc.detected) {
    const ucBoost = Math.round(stUc.quality * 0.20);
    bear += ucBoost;
    sigs.push({ t: "bear", text: `[ST] Uppercut/Failed BO (${stUc.quality}/100) — ${stUc.reasons.slice(0, 2).join(", ")}` });
  }
  const dnTrend = ((lh + ll) / 12) * 100;
  if (dnTrend > 65) { bear += 10; sigs.push({ t: "bear", text: `7d downtrend ${dnTrend.toFixed(0)}%` }); }

  bull = Math.max(0, Math.min(100, bull));
  bear = Math.max(0, Math.min(100, bear));
  const netScore = bull - bear;
  const displayScore = Math.max(0, Math.min(100, 50 + netScore / 2));

  let sig;
  if (displayScore >= 70) sig = "STRONG BUY";
  else if (displayScore >= 55) sig = "BUY WATCH";
  else if (displayScore >= 45) sig = "NEUTRAL";
  else if (displayScore >= 30) sig = "SELL WATCH";
  else sig = "STRONG SELL";

  return {
    score: Math.round(displayScore), bullScore: bull, bearScore: bear,
    signal: sig, sigs, price: c,
    ema3v: ema3[L], ema5v: ema5[L], ema8v: ema8[L],
    aligned, bearish, spread, rsi: rV,
    mom1d, mom3d, mom5d, mom7d,
    vr, range7d, nearHigh, nearLow,
    recentHigh, recentLow,
  };
}

// ─── Blended Score (60% short-term, 40% long-term) ───

function blendScores(longTerm, shortTerm) {
  if (!shortTerm) return longTerm;
  if (!longTerm) return shortTerm;
  const blended = Math.round(shortTerm.score * 0.6 + longTerm.score * 0.4);
  return {
    score: blended,
    signal: blended >= 70 ? "STRONG BUY" : blended >= 55 ? "BUY WATCH" : blended >= 45 ? "NEUTRAL" : blended >= 30 ? "SELL WATCH" : "STRONG SELL",
    longTerm, shortTerm,
  };
}

// ─── Options Helpers (ported from live-swing-simulator.jsx) ───

function optPrice(spot, strike, dte, iv, type = "call") {
  const t = dte / 365;
  const intr = type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  return Math.max(0.05, +(intr + spot * iv * Math.sqrt(t) * 0.4).toFixed(2));
}

function optGreeks(spot, strike, dte, iv, type = "call") {
  const t = Math.max(dte / 365, 0.001);
  const d = type === "call"
    ? Math.min(0.99, Math.max(0.01, 0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)))
    : Math.max(-0.99, Math.min(-0.01, -0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)));
  return { delta: +d.toFixed(3), theta: +(-(spot * iv) / (2 * Math.sqrt(t) * 365) * 0.4).toFixed(3) };
}

// ─── Constants ───

const REGIME_TICKERS = ["SPY", "QQQ"];
const WATCHLIST_REFRESH_MS = 4 * 60 * 60_000; // refresh every 4 hours

async function fetchDynamicWatchlist() {
  const symbols = new Set(REGIME_TICKERS);
  const headers = { "User-Agent": "Mozilla/5.0" };

  // 1. Most active US stocks
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=15&lang=en-US&region=US",
      { headers }
    );
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
    }
  } catch { }

  // 2. Trending tickers
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v1/finance/trending/US?count=10&lang=en-US",
      { headers }
    );
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
    }
  } catch { }

  // 3. Top gainers / losers (high momentum)
  for (const scrId of ["day_gainers", "day_losers"]) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=8&lang=en-US&region=US`,
        { headers }
      );
      if (r.ok) {
        const d = await r.json();
        const quotes = d?.finance?.result?.[0]?.quotes || [];
        for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
      }
    } catch { }
  }

  return [...symbols];
}

async function refreshWatchlist(acct) {
  const now = Date.now();
  if (now - acct.lastWatchlistRefresh < WATCHLIST_REFRESH_MS && acct.dynamicWatchlist.length > 0) return;
  acct.lastWatchlistRefresh = now;

  log(acct, "WATCHLIST: Refreshing from market data...");
  const raw = await fetchDynamicWatchlist();

  const blocked = new Set(["UVXY", "VIX", "VXX", "SVXY", "VIXY", "UVIX"]);

  const filtered = raw.filter(sym =>
    !blocked.has(sym) || REGIME_TICKERS.includes(sym)
  );

  const hinted = acct.tickers.filter(t => !filtered.includes(t));
  acct.dynamicWatchlist = [...new Set([...REGIME_TICKERS, ...filtered, ...hinted])];

  log(acct, `WATCHLIST: ${acct.dynamicWatchlist.length} tickers — ${acct.dynamicWatchlist.slice(0, 15).join(", ")}${acct.dynamicWatchlist.length > 15 ? "..." : ""}`);
  acct.tickers = [...acct.dynamicWatchlist];
}

function getActiveTickers(acct) {
  const base = acct.dynamicWatchlist.length > 0 ? acct.dynamicWatchlist : acct.tickers;
  const hinted = acct.tickers.filter(t => !base.includes(t));
  return [...new Set([...base, ...hinted])];
}

const STATE_FILE = process.env.STATE_FILE || "state.json";
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || (process.env.STATE_FILE ? process.env.STATE_FILE.replace(/state\.json$/, "accounts.json") : "accounts.json");
const HINT_FILE = "hint.txt";
const CYCLE_MS = 60_000;       // 60s between cycles
const API_DELAY = 150;         // 150ms between API calls (Finnhub free tier)
const DEFAULT_IV = 0.30;

// ─── Trimming & EOD/EOW Constants ───
const EOD_FREEZE_HOUR = 15;    // No new entries after 3:00 PM ET
const EOD_TIGHTEN_HOUR = 15.5; // Tighten stops after 3:30 PM ET
const EOW_TRIM_HOUR = 14;      // Friday profit-taking starts at 2:00 PM ET
const LOW_DTE_THRESHOLD = 3;   // Accelerate exits when DTE <= 3
const CRITICAL_DTE = 2;        // Force-close when DTE <= 2

const CLAUDE_API_KEY = (process.env.CLAUDE_API_KEY || "").trim();

// ─── Default Account Config ───

const DEFAULT_CONFIG = {
  startingCash: 200,
  goal: 200_000,
  baseRiskPct: 0.15,
  profitTarget: 0.40,
  stopLoss: -0.35,
  bullEntry: 65,
  bearEntry: 35,
  trim1Pct: 0.25,
  trim2Pct: 0.50,
  maxPositions: null,
  minSetupQuality: 50,
  customPromptSuffix: "",
};

// ─── Multi-Account Runtime ───

const accounts = new Map();

function createAccountRuntime(id, name, config, state) {
  return {
    id,
    name: name || id,
    createdAt: Date.now(),
    paused: false,
    config: { ...DEFAULT_CONFIG, ...config },
    state: state || {
      cash: (config && config.startingCash) || DEFAULT_CONFIG.startingCash,
      positions: [],
      history: [],
      dayTrades: [],
    },
    dashboard: {
      quotes: {},
      analyses: {},
      shortTermAnalyses: {},
      candles: {},
      lastCycle: null,
      cycleLog: [],
      marketOpen: false,
      decisions: [],
      positionDetails: [],
      portfolioHistory: [],
    },
    candleCache: {},
    lastCandleDate: null,
    activeHints: [],
    lastHintContent: "",
    currentRegime: { mode: "unknown", riskScale: 1.0, label: "UNKNOWN" },
    riskPct: (config && config.baseRiskPct) || DEFAULT_CONFIG.baseRiskPct,
    dynamicWatchlist: [],
    tickers: ["SPY", "QQQ"],
    lastWatchlistRefresh: 0,
    lastNewsScan: 0,
    latestNewsBrief: "",
  };
}

// ─── Account Persistence ───

function loadAccounts() {
  // Try accounts.json first
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
      if (data.meta && data.accounts) {
        for (const [id, acctData] of Object.entries(data.accounts)) {
          const acct = createAccountRuntime(id, acctData.name, acctData.config, acctData.state);
          acct.paused = acctData.paused || false;
          acct.createdAt = acctData.createdAt || Date.now();
          accounts.set(id, acct);
        }
        return true;
      }
    }
  } catch (e) {
    console.error(`WARN: Failed to load accounts.json — ${e.message}`);
  }

  // Migrate from state.json
  try {
    if (fs.existsSync(STATE_FILE)) {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (old && typeof old.cash === "number") {
        const config = { ...DEFAULT_CONFIG, startingCash: DEFAULT_CONFIG.startingCash };
        const state = {
          cash: old.cash,
          positions: old.positions || [],
          history: old.history || [],
          dayTrades: old.dayTrades || [],
        };
        const acct = createAccountRuntime("default", "Original Strategy", config, state);
        accounts.set("default", acct);

        // Backup old state.json
        try {
          fs.copyFileSync(STATE_FILE, STATE_FILE + ".backup");
        } catch { }

        // Save as accounts.json
        saveAccounts();
        console.log("Migrated state.json → accounts.json (backup saved as state.json.backup)");
        return true;
      }
    }
  } catch (e) {
    console.error(`WARN: Failed to migrate state.json — ${e.message}`);
  }

  return false;
}

function saveAccounts() {
  const data = { meta: { version: 1 }, accounts: {} };
  for (const [id, acct] of accounts) {
    data.accounts[id] = {
      id: acct.id,
      name: acct.name,
      createdAt: acct.createdAt,
      paused: acct.paused,
      config: acct.config,
      state: acct.state,
    };
  }
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`WARN: Failed to save accounts — ${e.message}`);
  }
}

// ─── Logging ───

function log(acct, msg) {
  if (typeof acct === "string") {
    // Called as log("msg") — global log without account context
    msg = acct;
    const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    const line = `[${now}] ${msg}`;
    console.log(line);
    return;
  }
  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const prefix = accounts.size > 1 ? `[${acct.id}] ` : "";
  const line = `[${now}] ${prefix}${msg}`;
  console.log(line);
  acct.dashboard.cycleLog.push(line);
  if (acct.dashboard.cycleLog.length > 200) acct.dashboard.cycleLog.shift();
}

// Append-only trade log for Monte Carlo training
function logTrade(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync("trades.log", line);
  } catch { }
}

// ─── X (Twitter) Integration ───

const ENABLE_TWEETS = process.env.ENABLE_TWEETS === "true";
const X_DAILY_CAP = parseInt(process.env.X_DAILY_CAP) || 30;
let xClient = null;
let xTweetCount = 0;
let xTweetDate = null;
let lastWatchlistTweetDate = null;

function initTwitterClient() {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log("  X/Twitter: Missing API keys — tweeting disabled (dry-run logs only)");
    return null;
  }
  try {
    const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
    console.log("  X/Twitter: Client initialized ✓");
    return client;
  } catch (e) {
    console.log(`  X/Twitter: Init failed — ${e.message}`);
    return null;
  }
}

function canTweet() {
  const today = getETDateStr();
  if (xTweetDate !== today) { xTweetCount = 0; xTweetDate = today; }
  return xTweetCount < X_DAILY_CAP;
}

async function tweetWithChart(text, pngBuffer) {
  if (!canTweet()) { console.log(`  [X] Daily cap reached (${X_DAILY_CAP}), skipping tweet`); return; }
  if (!ENABLE_TWEETS || !xClient) {
    console.log(`  [X DRY-RUN] ${text.slice(0, 120)}...`);
    if (pngBuffer) console.log(`  [X DRY-RUN] (chart image: ${(pngBuffer.length / 1024).toFixed(0)}KB)`);
    return;
  }
  try {
    if (pngBuffer) {
      const mediaId = await xClient.v1.uploadMedia(pngBuffer, { mimeType: "image/png" });
      await xClient.v2.tweet({ text, media: { media_ids: [mediaId] } });
    } else {
      await xClient.v2.tweet({ text });
    }
    xTweetCount++;
    console.log(`  [X] Tweeted (${xTweetCount}/${X_DAILY_CAP} today)`);
  } catch (e) {
    console.log(`  [X] Tweet failed — ${e.message}`);
  }
}

function renderChartPNG(candles, ticker, analysis, shortTermAnalysis, quote) {
  if (!candles || candles.length < 3) return null;
  try {
    const W = 1100, H = 500, PAD = 50;
    const cls = candles.map(c => c.c), hs = candles.map(c => c.h), ls = candles.map(c => c.l), vs = candles.map(c => c.v);
    const emas = [
      { period: 8, color: "#4ecdc4", label: "EMA 8", data: calcEMA(cls, 8) },
      { period: 21, color: "#ff6b35", label: "EMA 21", data: calcEMA(cls, 21) },
      { period: 50, color: "#a78bfa", label: "EMA 50", data: calcEMA(cls, 50) },
    ];
    const allP = [...hs, ...ls];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 40) - 20;
    const x = i => PAD + (i / Math.max(1, cls.length - 1)) * (W - PAD);

    // Candlestick bars
    const bars = candles.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00ff88" : "#ff4444";
      const bw = Math.max(4, (W - PAD) / candles.length - 1.5);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bot - top);
      return `<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1"/>
        <rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${bodyH}" fill="${color}" rx="0.5"/>`;
    }).join("");

    // EMA overlay paths
    const emaPaths = emas.map(e =>
      `<path d="${e.data.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${e.color}" stroke-width="2" opacity="0.85"/>`
    ).join("");

    // Price labels on right side
    const pLabels = [mn, mn + rng * 0.25, mn + rng * 0.5, mn + rng * 0.75, mx].map(p =>
      `<text x="${W + 8}" y="${y(p)}" fill="#888" font-size="11" font-family="monospace" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    // Volume bars at bottom
    const maxV = Math.max(...vs);
    const avgV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const VH = 60;
    const volBars = vs.map((v, i) => {
      const bw = Math.max(4, (W - PAD) / vs.length - 1.5);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw / 2}" y="${H + 20 + VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00ff8850' : '#ffffff18'}" rx="0.5"/>`;
    }).join("");

    // Info overlay
    const score = analysis?.score ?? "?";
    const signal = analysis?.signal ?? "?";
    const rsi = analysis?.rsi?.toFixed(1) ?? "?";
    const stScore = shortTermAnalysis?.score ?? "?";
    const price = quote?.c?.toFixed(2) ?? "?";
    const chg = quote?.dp != null ? `${quote.dp >= 0 ? "+" : ""}${quote.dp.toFixed(1)}%` : "";
    const chgColor = (quote?.dp ?? 0) >= 0 ? "#00ff88" : "#ff4444";
    const scoreColor = score >= 65 ? "#00ff88" : score <= 35 ? "#ff4444" : "#ffd93d";

    const signalsList = [
      ...(analysis?.sigs?.slice(0, 3)?.map(s => s.text) || []),
      ...(shortTermAnalysis?.sigs?.slice(0, 2)?.map(s => `[7d] ${s.text}`) || []),
    ];
    const signalsText = signalsList.map((s, i) =>
      `<text x="20" y="${H + VH + 70 + i * 18}" fill="#aaa" font-size="12" font-family="monospace">• ${s.length > 60 ? s.slice(0, 57) + "..." : s}</text>`
    ).join("");

    // EMA legend
    const legendY = 30;
    const legend = emas.map((e, i) =>
      `<rect x="${20 + i * 130}" y="${legendY - 6}" width="12" height="3" fill="${e.color}" rx="1"/>
       <text x="${36 + i * 130}" y="${legendY}" fill="${e.color}" font-size="11" font-family="monospace">${e.label} (${e.data[e.data.length - 1]?.toFixed(2) ?? "?"})</text>`
    ).join("");

    const totalH = H + VH + 40 + signalsList.length * 18 + 20;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${totalH}" viewBox="0 0 1200 ${totalH}">
      <rect width="1200" height="${totalH}" fill="#0a0a14" rx="12"/>
      <text x="20" y="22" fill="#fff" font-size="18" font-weight="bold" font-family="monospace">$${ticker}</text>
      <text x="${20 + ticker.length * 12 + 10}" y="22" fill="#888" font-size="14" font-family="monospace">$${price}</text>
      <text x="${20 + ticker.length * 12 + 80}" y="22" fill="${chgColor}" font-size="14" font-family="monospace">${chg}</text>
      <text x="${W - 20}" y="22" fill="${scoreColor}" font-size="16" font-weight="bold" font-family="monospace" text-anchor="end">Score: ${score}/100 ${signal}</text>
      <text x="${W + 60}" y="22" fill="#888" font-size="12" font-family="monospace">RSI: ${rsi} | 7d: ${stScore}</text>
      ${legend}
      <g transform="translate(0, 10)">
        ${bars}
        ${emaPaths}
        ${pLabels}
        ${volBars}
      </g>
      <line x1="20" y1="${H + VH + 40}" x2="${W + 60}" y2="${H + VH + 40}" stroke="#222" stroke-width="1"/>
      <text x="20" y="${H + VH + 58}" fill="#666" font-size="11" font-family="monospace">Key Signals:</text>
      ${signalsText}
      <text x="1180" y="${totalH - 10}" fill="#333" font-size="10" font-family="monospace" text-anchor="end">SwingTrader Bot</text>
    </svg>`;

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
    const rendered = resvg.render();
    return rendered.asPng();
  } catch (e) {
    console.log(`  [X] Chart render failed for ${ticker}: ${e.message}`);
    return null;
  }
}

async function tweetTradeEntry(acct, result, analysis, shortTermAnalysis, quote) {
  const signals = [
    ...(analysis?.sigs?.slice(0, 2)?.map(s => s.text) || []),
    ...(shortTermAnalysis?.sigs?.slice(0, 1)?.map(s => `[7d] ${s.text}`) || []),
  ].join(", ");
  const stScore = shortTermAnalysis?.score ?? "?";
  const ltScore = analysis ? Math.round(50 + (analysis.bullScore - analysis.bearScore) / 2) : "?";
  const text = `🟢 $${result.ticker} — Entered $${result.strike} ${result.type.toUpperCase()} ${result.dte}DTE

Blended: ${analysis?.score ?? "?"}/100 (7d:${stScore} 90d:${ltScore})
RSI: ${analysis?.rsi?.toFixed(1) ?? "?"} | Setup: ${result.setupQuality}/100
Signals: ${signals || "Multiple confirmations"}
Claude: APPROVED (${result.claudeConfidence}%)

#SwingTrader #Options`;

  const chart = renderChartPNG(acct.candleCache[result.ticker], result.ticker, analysis, shortTermAnalysis, quote);
  await tweetWithChart(text, chart);
}

async function tweetTradeExit(acct, pos, trade) {
  const emoji = trade.pnlPct >= 0 ? "💰" : "🔴";
  const pnlStr = `${trade.pnlPct >= 0 ? "+" : ""}${(trade.pnlPct * 100).toFixed(0)}%`;
  const held = ((Date.now() - pos.openTime) / 86400_000).toFixed(1);
  const trimLabel = trade.qty < pos.qty ? `Trimmed ${trade.qty}/${pos.qty}` : "Closed";
  const text = `${emoji} $${pos.ticker} — ${trimLabel} $${pos.strike} ${pos.type.toUpperCase()} ${pnlStr}

Held ${held} days | ${trade.reason}
Setup: ${pos.setupQuality ?? "?"}/100 | Claude: ${pos.claudeConfidence ?? "?"}%

#SwingTrader #Options`;

  await tweetWithChart(text, null);
}

async function tweetWatchlistSummary(acct, decisions, regime) {
  const today = getETDateStr();
  if (lastWatchlistTweetDate === today) return;
  lastWatchlistTweetDate = today;

  const bulls = decisions.filter(d => d.finalScore >= 65).sort((a, b) => b.finalScore - a.finalScore).slice(0, 5);
  const bears = decisions.filter(d => d.finalScore <= 35).sort((a, b) => a.finalScore - b.finalScore).slice(0, 3);
  const neutral = decisions.filter(d => d.finalScore > 35 && d.finalScore < 65 && d.finalScore >= 50).sort((a, b) => b.finalScore - a.finalScore).slice(0, 3);

  if (bulls.length === 0 && bears.length === 0) return;

  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let text = `📊 Watchlist Update — ${date}\n\n`;
  if (bulls.length) text += `🟢 ${bulls.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  if (bears.length) text += `🔴 ${bears.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  if (neutral.length) text += `⏳ ${neutral.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  text += `\nRegime: ${regime?.mode?.toUpperCase() ?? "?"} | ${acct.state.positions.length} positions open\n\n#SwingTrader #Watchlist`;

  // Render chart for top bull ticker if available
  let chart = null;
  if (bulls.length > 0) {
    const topTicker = bulls[0].ticker;
    const topAnalysis = acct.dashboard.analyses[topTicker];
    const topST = acct.dashboard.shortTermAnalyses[topTicker];
    const topQuote = acct.dashboard.quotes[topTicker];
    chart = renderChartPNG(acct.candleCache[topTicker], topTicker, topAnalysis, topST, topQuote);
  }
  await tweetWithChart(text, chart);
}

// ─── Market Regime (SPY/QQQ EMA health) ───

function getMarketRegime(candleCache) {
  const spyCandles = candleCache["SPY"];
  const qqqCandles = candleCache["QQQ"];
  if (!spyCandles || !qqqCandles || spyCandles.length < 55 || qqqCandles.length < 55) {
    return { mode: "unknown", riskScale: 0.5, label: "UNKNOWN (no data)", spyAbove: null, qqqAbove: null };
  }

  function checkAboveEMAs(candles) {
    const closes = candles.map(d => d.c);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const L = closes.length - 1;
    const c = closes[L];
    const above8 = c > ema8[L];
    const above21 = c > ema21[L];
    const above50 = c > ema50[L];
    const aligned = ema8[L] > ema21[L] && ema21[L] > ema50[L];
    return { above8, above21, above50, aligned, allAbove: above8 && above21 && above50 };
  }

  const spy = checkAboveEMAs(spyCandles);
  const qqq = checkAboveEMAs(qqqCandles);

  let mode, riskScale, label;
  if (spy.allAbove && qqq.allAbove) {
    mode = "risk-on";
    riskScale = 1.0;
    label = "RISK-ON — SPY+QQQ above all EMAs, full conviction";
  } else if (spy.allAbove || qqq.allAbove) {
    mode = "cautious";
    riskScale = 0.5;
    label = `CAUTIOUS — ${spy.allAbove ? 'SPY' : 'QQQ'} strong, ${spy.allAbove ? 'QQQ' : 'SPY'} mixed`;
  } else if (spy.above50 && qqq.above50) {
    mode = "choppy";
    riskScale = 0.35;
    label = "CHOPPY — above 50 EMA but EMA stack broken";
  } else {
    mode = "risk-off";
    riskScale = 0.25;
    label = "RISK-OFF — below key EMAs, reduce exposure";
  }

  return { mode, riskScale, label, spyAbove: spy, qqqAbove: qqq };
}

// ─── Earnings Calendar Check (Finnhub) ───

async function checkEarnings(ticker, apiKey) {
  try {
    const now = getETDate();
    const from = now.toISOString().slice(0, 10);
    const futureDate = new Date(now.getTime() + 4 * 86400_000); // 4 days out
    const to = futureDate.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${apiKey}`);
    if (!r.ok) return { hasEarnings: false, daysUntil: null };
    const data = await r.json();
    const earnings = data.earningsCalendar || [];
    if (earnings.length === 0) return { hasEarnings: false, daysUntil: null };
    const nextEarning = earnings[0];
    const earningDate = new Date(nextEarning.date);
    const daysUntil = Math.ceil((earningDate - now) / 86400_000);
    return { hasEarnings: daysUntil <= 3, daysUntil, date: nextEarning.date };
  } catch {
    return { hasEarnings: false, daysUntil: null };
  }
}

// ─── Consolidation / Tightness Detection (SRxTrades "staircase" setup quality) ───

function detectConsolidation(candles) {
  if (!candles || candles.length < 20) return { quality: 0, tight: false };

  const recent = candles.slice(-10);
  const closes = recent.map(d => d.c);
  const highs = recent.map(d => d.h);
  const lows = recent.map(d => d.l);
  const volumes = recent.map(d => d.v);

  // 1. Range tightness: how narrow is the price range over last 10 candles?
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;
  // Tighter range = higher score. Sweet spot: 2-5% range
  let tightnessScore = 0;
  if (rangePct < 3) tightnessScore = 30;
  else if (rangePct < 5) tightnessScore = 25;
  else if (rangePct < 8) tightnessScore = 15;
  else if (rangePct < 12) tightnessScore = 5;

  // 2. Volume declining during consolidation (coiled spring)
  const firstHalfVol = volumes.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const secondHalfVol = volumes.slice(5).reduce((a, b) => a + b, 0) / 5;
  let volDeclineScore = 0;
  if (firstHalfVol > 0) {
    const volRatio = secondHalfVol / firstHalfVol;
    if (volRatio < 0.7) volDeclineScore = 25;      // Strong volume decline
    else if (volRatio < 0.85) volDeclineScore = 15;  // Moderate decline
    else if (volRatio < 1.0) volDeclineScore = 8;    // Slight decline
  }

  // 3. Price above moving averages during base
  const allCandles = candles;
  const allCloses = allCandles.map(d => d.c);
  const ema8 = calcEMA(allCloses, 8);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;
  const price = allCloses[L];
  let emaScore = 0;
  if (price > ema8[L] && price > ema21[L] && price > ema50[L]) emaScore = 25;
  else if (price > ema21[L] && price > ema50[L]) emaScore = 15;
  else if (price > ema50[L]) emaScore = 8;

  // 4. Breakout detection: latest close near/above range high with volume expansion
  const latestVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  let breakoutScore = 0;
  if (price >= rangeHigh * 0.995 && latestVol > avgVol * 1.3) {
    breakoutScore = 20; // Breaking out of consolidation on volume!
  } else if (price >= rangeHigh * 0.99) {
    breakoutScore = 10; // Near breakout level
  }

  const quality = Math.min(100, tightnessScore + volDeclineScore + emaScore + breakoutScore);
  return {
    quality,
    tight: rangePct < 8,
    rangePct: rangePct.toFixed(1),
    volDeclining: secondHalfVol < firstHalfVol * 0.85,
    aboveEMAs: emaScore >= 15,
    breakingOut: breakoutScore >= 15,
    components: { tightnessScore, volDeclineScore, emaScore, breakoutScore },
  };
}

// ─── SRxTrades: Undercut & Reclaim / Uppercut Detection ───

function detectUndercutReclaim(candles) {
  // Bullish reversal: price undercuts a key low then reclaims it with strength
  // Best in leading stocks near 21 EMA or 50 MA
  if (!candles || candles.length < 20) return { detected: false };

  const recent = candles.slice(-5);
  const prior = candles.slice(-20, -5);
  const allCloses = candles.map(d => d.c);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;

  // Find the key low from prior candles (well-defined swing low)
  const priorLows = prior.map(d => d.l);
  const keyLow = Math.min(...priorLows);
  // Also check prior day's low and recent swing low (last 10 candles)
  const recentSwingLows = candles.slice(-10, -3).map(d => d.l);
  const swingLow = recentSwingLows.length > 0 ? Math.min(...recentSwingLows) : keyLow;
  const testLevel = Math.min(keyLow, swingLow);

  // Check if any recent candle undercut the key low
  let undercutCandle = -1;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].l < testLevel * 0.998) { // Broke below by at least 0.2%
      undercutCandle = i;
    }
  }
  if (undercutCandle === -1) return { detected: false };

  // Check for reclaim: latest candle(s) must close back above the key low
  const lastCandle = recent[recent.length - 1];
  const reclaimed = lastCandle.c > testLevel * 1.001; // Closed above by 0.1%+
  if (!reclaimed) return { detected: false };

  // Quality scoring
  let quality = 0;
  const reasons = [];

  // 1. Wick characteristic on undercut candle (long lower wick = liquidity grab)
  const uc = recent[undercutCandle];
  const bodySize = Math.abs(uc.c - uc.o);
  const lowerWick = Math.min(uc.o, uc.c) - uc.l;
  if (lowerWick > bodySize * 1.5) { quality += 20; reasons.push("Long lower wick (liquidity grab)"); }
  else if (lowerWick > bodySize) { quality += 10; reasons.push("Lower wick present"); }

  // 2. Volume on undercut and reclaim
  const avgVol = prior.map(d => d.v).reduce((a, b) => a + b, 0) / prior.length;
  if (uc.v > avgVol * 1.3) { quality += 15; reasons.push("High volume on undercut"); }
  if (lastCandle.v > avgVol * 1.2) { quality += 15; reasons.push("Strong volume on reclaim"); }

  // 3. Strong reclaim candle (bullish close, little hesitation)
  if (lastCandle.c > lastCandle.o) { quality += 10; reasons.push("Bullish reclaim candle"); }
  const reclaimStrength = (lastCandle.c - testLevel) / testLevel * 100;
  if (reclaimStrength > 1) { quality += 10; reasons.push(`Strong reclaim +${reclaimStrength.toFixed(1)}%`); }

  // 4. Near key EMAs (highest probability U&Rs per SRxTrades)
  const nearEma21 = Math.abs(testLevel - ema21[L]) / ema21[L] < 0.03;
  const nearEma50 = Math.abs(testLevel - ema50[L]) / ema50[L] < 0.03;
  if (nearEma21 || nearEma50) { quality += 15; reasons.push(`Near ${nearEma21 ? '21' : '50'} EMA support`); }

  // 5. Quick undercut (not a sustained breakdown)
  const daysBelowKey = recent.filter(c => c.l < testLevel).length;
  if (daysBelowKey <= 2) { quality += 10; reasons.push("Quick undercut (1-2 candles)"); }

  quality = Math.min(100, quality);

  return {
    detected: quality >= 30,
    quality,
    keyLevel: testLevel,
    reclaimPrice: lastCandle.c,
    reasons,
    pattern: "Undercut & Reclaim",
    bias: "bullish",
  };
}

function detectUppercut(candles) {
  // Bearish reversal (failed breakout): price breaks above key resistance then fails back below
  // "Breakout buyers and late longs get trapped at the highs, adding selling pressure"
  if (!candles || candles.length < 20) return { detected: false };

  const recent = candles.slice(-5);
  const prior = candles.slice(-20, -5);
  const allCloses = candles.map(d => d.c);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;

  // Find key resistance: prior highs, range highs
  const priorHighs = prior.map(d => d.h);
  const keyHigh = Math.max(...priorHighs);
  const recentSwingHighs = candles.slice(-10, -3).map(d => d.h);
  const swingHigh = recentSwingHighs.length > 0 ? Math.max(...recentSwingHighs) : keyHigh;
  const testLevel = Math.max(keyHigh, swingHigh);

  // Check if any recent candle broke above the key high
  let uppercutCandle = -1;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].h > testLevel * 1.002) { // Broke above by at least 0.2%
      uppercutCandle = i;
    }
  }
  if (uppercutCandle === -1) return { detected: false };

  // Check for reclaim back below: latest candle must close below the key high
  const lastCandle = recent[recent.length - 1];
  const reclaimed = lastCandle.c < testLevel * 0.999; // Closed below by 0.1%+
  if (!reclaimed) return { detected: false };

  // Quality scoring
  let quality = 0;
  const reasons = [];

  // 1. Upper wick on uppercut candle (trap candle)
  const uc = recent[uppercutCandle];
  const bodySize = Math.abs(uc.c - uc.o);
  const upperWick = uc.h - Math.max(uc.o, uc.c);
  if (upperWick > bodySize * 1.5) { quality += 20; reasons.push("Long upper wick (bull trap)"); }
  else if (upperWick > bodySize) { quality += 10; reasons.push("Upper wick present"); }

  // 2. Volume on the failed breakout
  const avgVol = prior.map(d => d.v).reduce((a, b) => a + b, 0) / prior.length;
  if (uc.v > avgVol * 1.3) { quality += 15; reasons.push("High volume on failed breakout"); }
  if (lastCandle.v > avgVol * 1.2) { quality += 15; reasons.push("Strong selling volume on reclaim"); }

  // 3. Bearish reclaim candle
  if (lastCandle.c < lastCandle.o) { quality += 10; reasons.push("Bearish reversal candle"); }
  const reclaimStrength = (testLevel - lastCandle.c) / testLevel * 100;
  if (reclaimStrength > 1) { quality += 10; reasons.push(`Strong rejection -${reclaimStrength.toFixed(1)}%`); }

  // 4. Near overhead MAs (resistance confirmation)
  const nearEma21 = Math.abs(testLevel - ema21[L]) / ema21[L] < 0.03;
  const nearEma50 = Math.abs(testLevel - ema50[L]) / ema50[L] < 0.03;
  if (nearEma21 || nearEma50) { quality += 15; reasons.push(`Failed at ${nearEma21 ? '21' : '50'} EMA resistance`); }

  // 5. Quick break above (not a sustained breakout)
  const daysAboveKey = recent.filter(c => c.h > testLevel).length;
  if (daysAboveKey <= 2) { quality += 10; reasons.push("Quick trap (1-2 candles above)"); }

  quality = Math.min(100, quality);

  return {
    detected: quality >= 30,
    quality,
    keyLevel: testLevel,
    reclaimPrice: lastCandle.c,
    reasons,
    pattern: "Uppercut (Failed Breakout)",
    bias: "bearish",
  };
}

// ─── Market Hours ───

function getETDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function isMarketOpen() {
  const et = getETDate();
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 AM (570) to 4:00 PM (960)
}

function getETDateStr() {
  return getETDate().toISOString().slice(0, 10);
}

// ─── PDT Enforcement ───

function getBusinessDaysAgo(n) {
  const d = getETDate();
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return d.toISOString().slice(0, 10);
}

function cleanDayTrades(state) {
  const cutoff = getBusinessDaysAgo(5);
  state.dayTrades = state.dayTrades.filter(dt => dt.date >= cutoff);
}

function countRecentDayTrades(state) {
  const cutoff = getBusinessDaysAgo(5);
  return state.dayTrades.filter(dt => dt.date >= cutoff).length;
}

function wouldBeDayTrade(position) {
  return position.openDate === getETDateStr();
}

function canClosePDT(state, position) {
  if (!wouldBeDayTrade(position)) return true; // not a day trade, always OK
  return countRecentDayTrades(state) < 3;
}

function recordDayTrade(state, position) {
  if (wouldBeDayTrade(position)) {
    state.dayTrades.push({
      date: getETDateStr(),
      ticker: position.ticker,
      strike: position.strike,
      type: position.type,
    });
  }
}

// ─── API Layer ───

async function fetchQuote(sym, key) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`);
    if (r.ok) {
      const data = await r.json();
      if (data && data.c > 0) return data;
    }
  } catch { }
  // Fallback: Yahoo Finance realtime quote
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Quote error ${r.status}`);
  const d = await r.json();
  const meta = d.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error(`No Yahoo quote for ${sym}`);
  return { c: meta.regularMarketPrice, h: meta.regularMarketDayHigh || meta.regularMarketPrice, l: meta.regularMarketDayLow || meta.regularMarketPrice, o: meta.regularMarketOpen || meta.regularMarketPrice, pc: meta.chartPreviousClose || meta.previousClose || 0 };
}

async function fetchCandles(sym, key) {
  // Try Finnhub first
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}&token=${key}`);
    if (r.ok) {
      const d = await r.json();
      if (d.s === "ok" && d.c) {
        return d.c.map((c, i) => ({ c, h: d.h[i], l: d.l[i], o: d.o[i], v: d.v[i], t: d.t[i] }));
      }
    }
  } catch { }

  // Fallback: Yahoo Finance (no API key needed)
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${from}&period2=${to}&interval=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Yahoo error ${r.status}`);
    const d = await r.json();
    const q = d.chart?.result?.[0];
    if (!q || !q.indicators?.quote?.[0]) return null;
    const ts = q.timestamp;
    const ohlcv = q.indicators.quote[0];
    return ts.map((t, i) => ({
      c: ohlcv.close[i], h: ohlcv.high[i], l: ohlcv.low[i],
      o: ohlcv.open[i], v: ohlcv.volume[i], t,
    })).filter(c => c.c != null);
  } catch (e) {
    throw new Error(`Candle fetch failed for ${sym}: ${e.message}`);
  }
}

async function validateKey(key) {
  try {
    const q = await fetchQuote("AAPL", key);
    return q && typeof q.c === "number" && q.c > 0;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Prompt for API Key ───

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── Portfolio Helpers ───

function portfolioValue(state, quotes) {
  let val = state.cash;
  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    val += currentPremium * pos.qty * 100;
  }
  return val;
}

function signalLabel(score) {
  if (score >= 70) return "STRONG BUY";
  if (score >= 55) return "BUY WATCH";
  if (score >= 45) return "NEUTRAL";
  if (score >= 30) return "SELL WATCH";
  return "STRONG SELL";
}

// ─── Claude API Usage Tracking (global/shared) ───
let claudeCallCount = 0;
let claudeTotalInputTokens = 0;
let claudeTotalOutputTokens = 0;
const HAIKU_INPUT_COST = 1.00 / 1_000_000;   // $1.00 per 1M input tokens
const HAIKU_OUTPUT_COST = 5.00 / 1_000_000;  // $5.00 per 1M output tokens

function getClaudeCost() {
  return (claudeTotalInputTokens * HAIKU_INPUT_COST + claudeTotalOutputTokens * HAIKU_OUTPUT_COST);
}

async function callClaude(prompt, retries = 3) {
  if (!CLAUDE_API_KEY) throw new Error("CLAUDE_API_KEY not set");
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      const retryable = [429, 500, 502, 503, 504, 529].includes(r.status);
      if (retryable && attempt < retries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw new Error(`Claude API ${r.status}: ${err}`);
    }
    const data = await r.json();
    claudeCallCount++;
    if (data.usage) {
      claudeTotalInputTokens += data.usage.input_tokens || 0;
      claudeTotalOutputTokens += data.usage.output_tokens || 0;
    }
    return data.content[0].text;
  }
}

async function processHint(hintText, acct) {
  const state = acct.state;
  const portfolioContext = `Portfolio: $${state.cash.toFixed(0)} cash, ${state.positions.length} positions open (${state.positions.map(p => `${p.ticker} ${p.type}`).join(", ") || "none"}). Current watchlist: ${acct.tickers.join(", ")}.`;

  const promptText = `You are a trading bot's AI advisor. The user gave this hint to guide their options trading bot:

"${hintText}"

${portfolioContext}

Interpret this hint and respond with ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "tickers": [{"symbol": "PLTR", "direction": "bullish", "bias": 25, "reasoning": "short explanation"}],
  "removeTickers": [],
  "urgency": "high",
  "advice": "one sentence summary of action"
}

Rules:
- "bias" is a score adjustment from -30 to +30 added to the technical analysis score
- "direction" is "bullish" or "bearish"
- If the hint mentions a new ticker not in the watchlist, include it in tickers with appropriate bias
- "removeTickers" only if the user explicitly says to stop watching something
- "urgency": "high" (act now), "medium" (watch closely), "low" (keep in mind)
- Keep reasoning very brief
- You can return multiple tickers if the hint implies it`;

  try {
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    log(acct, `CLAUDE WARN: Failed to parse hint response — ${e.message}`);
    return null;
  }
}

async function checkHints(acct) {
  // Check file-based hints (for default account or single-account mode)
  try {
    const hintFile = accounts.size <= 1 ? HINT_FILE : `hint-${acct.id}.txt`;
    if (!fs.existsSync(hintFile)) return;
    const content = fs.readFileSync(hintFile, "utf-8").trim();
    if (!content || content === acct.lastHintContent) return;

    acct.lastHintContent = content;
    log(acct, `HINT RECEIVED: "${content}"`);

    const result = await processHint(content, acct);
    if (!result) return;

    applyHintResult(acct, result);

    // Clear the hint file after processing
    fs.writeFileSync(hintFile, "");

  } catch (e) {
    log(acct, `HINT ERROR: ${e.message}`);
  }
}

function applyHintResult(acct, result) {
  log(acct, `CLAUDE SAYS: ${result.advice}`);

  for (const t of result.tickers || []) {
    if (!acct.tickers.includes(t.symbol)) {
      acct.tickers.push(t.symbol);
      log(acct, `WATCHLIST +${t.symbol} (${t.direction}, bias ${t.bias > 0 ? "+" : ""}${t.bias})`);
    } else {
      log(acct, `BIAS ${t.symbol}: ${t.bias > 0 ? "+" : ""}${t.bias} (${t.direction}) — ${t.reasoning}`);
    }

    const existing = acct.activeHints.findIndex(h => h.ticker === t.symbol);
    const hint = {
      ticker: t.symbol,
      bias: t.bias,
      direction: t.direction,
      reasoning: t.reasoning,
      expiresAt: Date.now() + 4 * 60 * 60_000,
    };
    if (existing >= 0) acct.activeHints[existing] = hint;
    else acct.activeHints.push(hint);
  }

  for (const sym of result.removeTickers || []) {
    acct.tickers = acct.tickers.filter(t => t !== sym);
    acct.activeHints = acct.activeHints.filter(h => h.ticker !== sym);
    log(acct, `WATCHLIST -${sym}`);
  }
}

function getHintBias(acct, ticker) {
  const now = Date.now();
  acct.activeHints = acct.activeHints.filter(h => h.expiresAt > now);
  const hint = acct.activeHints.find(h => h.ticker === ticker);
  return hint ? hint.bias : 0;
}

function getActiveHintsSummary(acct) {
  const now = Date.now();
  acct.activeHints = acct.activeHints.filter(h => h.expiresAt > now);
  if (acct.activeHints.length === 0) return "";
  return " | Hints: " + acct.activeHints.map(h => {
    const mins = Math.round((h.expiresAt - now) / 60_000);
    return `${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${mins}m left)`;
  }).join(", ");
}

// ─── Auto News Scanner (runs every 3 hours) ───

const NEWS_INTERVAL = 3 * 60 * 60_000; // 3 hours

async function fetchMarketNews(apiKey, tickers) {
  const headlines = [];

  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${apiKey}`);
    if (r.ok) {
      const articles = await r.json();
      for (const a of articles.slice(0, 15)) {
        headlines.push({ title: a.headline, source: a.source, time: a.datetime, summary: a.summary?.slice(0, 200) || "" });
      }
    }
  } catch { }

  for (const ticker of tickers.slice(0, 5)) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${todayStr()}&to=${todayStr()}&token=${apiKey}`);
      if (r.ok) {
        const articles = await r.json();
        for (const a of articles.slice(0, 3)) {
          headlines.push({ title: a.headline, source: a.source, ticker, summary: a.summary?.slice(0, 200) || "" });
        }
      }
      await delay(API_DELAY);
    } catch { }
  }

  return headlines;
}

function todayStr() {
  const d = getETDate();
  return d.toISOString().slice(0, 10);
}

async function runNewsScan(acct, apiKey) {
  const now = Date.now();
  if (now - acct.lastNewsScan < NEWS_INTERVAL) return;
  acct.lastNewsScan = now;

  const state = acct.state;
  log(acct, "NEWS SCAN: Fetching latest market headlines...");

  const headlines = await fetchMarketNews(apiKey, acct.tickers);
  if (headlines.length === 0) {
    log(acct, "NEWS SCAN: No headlines fetched");
    return;
  }

  const headlineText = headlines.map((h, i) =>
    `${i + 1}. [${h.source}${h.ticker ? ` / ${h.ticker}` : ""}] ${h.title}${h.summary ? ` — ${h.summary}` : ""}`
  ).join("\n");

  const positionContext = state.positions.length > 0
    ? `Current positions: ${state.positions.map(p => `${p.ticker} ${p.type.toUpperCase()} $${p.strike}`).join(", ")}`
    : "No open positions";

  const promptText = `You are a trading bot's market intelligence system. Analyze these headlines for anything that could drastically impact markets in the next few hours.

CURRENT HEADLINES:
${headlineText}

PORTFOLIO CONTEXT:
Cash: $${state.cash.toFixed(0)} | ${positionContext}
Watchlist: ${acct.tickers.join(", ")}

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "severity": "normal" | "elevated" | "critical",
  "blackSwan": false,
  "summary": "1-2 sentence market read",
  "impacts": [
    {"ticker": "SPY", "direction": "bearish", "bias": -15, "reasoning": "brief reason"}
  ],
  "newTickers": [],
  "actionAdvice": "what the bot should consider doing",
  "riskLevel": "low" | "medium" | "high"
}

Rules:
- "severity": "normal" = business as usual, "elevated" = notable event moving markets, "critical" = black swan / crash / emergency
- "blackSwan": true only for genuinely extreme events (war escalation, market crash, major bank failure, pandemic, etc.)
- "bias" adjustments: normal news ±5-10, big news ±15-20, black swan ±25-30
- "impacts" only for tickers meaningfully affected — don't list every ticker
- "newTickers" if a stock not on the watchlist is suddenly very relevant
- If severity is critical, actionAdvice should recommend defensive positioning
- Be concise. Only flag what actually matters for short-term options trading.`;

  try {
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(cleaned);

    const sevColor = result.severity === "critical" ? "!!!" : result.severity === "elevated" ? "!!" : "";
    log(acct, `NEWS ${sevColor}${result.severity.toUpperCase()}: ${result.summary}`);
    acct.latestNewsBrief = `[${result.severity.toUpperCase()}] ${result.summary}`;

    if (result.blackSwan) {
      log(acct, "BLACK SWAN DETECTED — Claude recommends defensive action");
      log(acct, `ACTION ADVICE: ${result.actionAdvice}`);
    }

    for (const impact of result.impacts || []) {
      if (!acct.tickers.includes(impact.ticker) && impact.ticker) {
        acct.tickers.push(impact.ticker);
        log(acct, `NEWS WATCHLIST +${impact.ticker}`);
      }

      const existing = acct.activeHints.findIndex(h => h.ticker === impact.ticker);
      const hint = {
        ticker: impact.ticker,
        bias: impact.bias,
        direction: impact.direction,
        reasoning: `[NEWS] ${impact.reasoning}`,
        expiresAt: Date.now() + 3 * 60 * 60_000,
      };
      if (existing >= 0) acct.activeHints[existing] = hint;
      else acct.activeHints.push(hint);

      log(acct, `NEWS BIAS: ${impact.ticker} ${impact.bias > 0 ? "+" : ""}${impact.bias} (${impact.direction}) — ${impact.reasoning}`);
    }

    for (const ticker of result.newTickers || []) {
      if (!acct.tickers.includes(ticker)) {
        acct.tickers.push(ticker);
        log(acct, `NEWS WATCHLIST +${ticker}`);
      }
    }

    if (result.severity === "critical" || result.severity === "elevated") {
      log(acct, `NEWS ADVICE: ${result.actionAdvice}`);
    }

    return result;
  } catch (e) {
    log(acct, `NEWS SCAN ERROR: ${e.message}`);
    return null;
  }
}

// ─── Claude Pre-Entry Validation ───

async function validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime) {
  const cfg = acct.config;
  const promptText = `You are a trading bot's risk management system. Evaluate this potential options trade:

Ticker: ${ticker}
Price: $${quote.c.toFixed(2)}
Direction: ${analysis.score >= cfg.bullEntry ? 'BULLISH (buying calls)' : 'BEARISH (buying puts)'}
Technical Score: ${analysis.score}/100
RSI: ${analysis.rsi?.toFixed(1) || 'N/A'}
EMA Stack: ${analysis.aligned ? 'Aligned bullish (8>21>50)' : analysis.bearish ? 'Aligned bearish' : 'Mixed'}
Setup Quality: ${setupQuality.quality}/100 (${setupQuality.tight ? 'tight base' : 'wide range'}, ${setupQuality.breakingOut ? 'breaking out' : 'no breakout'}, vol ${setupQuality.volDeclining ? 'declining' : 'not declining'})
Market Regime: ${regime.label}
${earningsInfo.hasEarnings ? `EARNINGS in ${earningsInfo.daysUntil} days (${earningsInfo.date})` : 'No upcoming earnings within 3 days'}
Contract: 7DTE options, 1 strike OTM
${cfg.customPromptSuffix ? `\nAdditional context: ${cfg.customPromptSuffix}` : ''}

Evaluate:
1. Is this a quality setup (consolidation→breakout) or chasing an extended move?
2. Any obvious risks for holding this 7-day options contract?
3. Is the sector/theme strong enough to support this swing?

Respond with ONLY valid JSON (no markdown, no backticks):
{"approve": true, "confidence": 75, "concerns": [], "suggestion": "brief advice"}`;

  try {
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    log(acct, `CLAUDE VALIDATE WARN: Parse failed — ${e.message}. Defaulting to approve.`);
    return { approve: true, confidence: 50, concerns: ["validation parse failed"], suggestion: "proceeding with caution" };
  }
}

// ─── Entry Logic (enhanced with setup quality, EOD freeze, Claude validation) ───

async function tryEntry(acct, ticker, analysis, quote, regime, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  if (state.positions.some(p => p.ticker === ticker)) return null;
  if (state.cash < cfg.startingCash) return null;

  // Early exit: skip tickers that aren't actionable (WAIT zone) before any expensive checks
  if (analysis.score < cfg.bullEntry && analysis.score > cfg.bearEntry) return null;

  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  if (etHour >= EOD_FREEZE_HOUR && analysis.score < 80 && analysis.score > 20) {
    return { skipped: true, reason: `EOD freeze (${etHour.toFixed(1)} >= ${EOD_FREEZE_HOUR}h, score ${analysis.score} not extreme enough)` };
  }

  const setupQuality = detectConsolidation(acct.candleCache[ticker]);
  const minQuality = acct.config.minSetupQuality ?? 50;
  if (setupQuality.quality < minQuality) {
    return { skipped: true, reason: `Low setup quality ${setupQuality.quality}/100 (need >=${minQuality}, range ${setupQuality.rangePct}%, need consolidation→breakout)` };
  }

  // ─── Local pre-filters (catch what Claude would reject without API call) ───
  const isBullish = analysis.score >= cfg.bullEntry;
  const isBearish = analysis.score <= cfg.bearEntry;

  // RSI conflict: overbought buying calls, not-oversold buying puts
  if (isBullish && analysis.rsi > 70) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} overbought — chasing extended move, high reversal risk for calls` };
  }
  if (isBearish && analysis.rsi > 30 && analysis.rsi < 55 && !analysis.bearish) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} neutral with non-bearish EMA stack — weak put setup` };
  }

  // Risk-off regime contradicts bullish calls
  if (isBullish && regime.mode === "risk-off" && !analysis.aligned) {
    return { skipped: true, reason: `Risk-off regime + misaligned EMAs contradicts bullish call bias` };
  }

  // Range too wide — extended move, not consolidation
  const maxRange = minQuality < 30 ? 30 : 15;
  if (parseFloat(setupQuality.rangePct) > maxRange) {
    return { skipped: true, reason: `Range ${setupQuality.rangePct}% too wide (max ${maxRange}%) — extended move, not consolidation setup` };
  }

  let earningsInfo = { hasEarnings: false, daysUntil: null };
  try {
    earningsInfo = await checkEarnings(ticker, apiKey);
    await delay(API_DELAY);
  } catch { }
  if (earningsInfo.hasEarnings) {
    return { skipped: true, reason: `Earnings in ${earningsInfo.daysUntil} days (${earningsInfo.date}) — too risky for 7DTE options` };
  }

  let claudeResult = { approve: true, confidence: 70, concerns: [], suggestion: "" };
  try {
    claudeResult = await validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime);
    log(acct, `CLAUDE VALIDATE ${ticker}: ${claudeResult.approve ? 'APPROVED' : 'REJECTED'} (${claudeResult.confidence}%) — ${claudeResult.suggestion}${claudeResult.concerns.length ? ' | Concerns: ' + claudeResult.concerns.join(', ') : ''}`);
  } catch (e) {
    log(acct, `CLAUDE VALIDATE ${ticker}: Error — ${e.message}, proceeding anyway`);
  }

  if (!claudeResult.approve) {
    return { skipped: true, reason: `Claude rejected: ${claudeResult.suggestion} (${claudeResult.concerns.join(', ')})` };
  }

  const spot = quote.c;
  const maxRisk = state.cash * acct.riskPct;

  let type, strike, dte;

  if (analysis.score >= cfg.bullEntry) {
    type = "call";
    const atm = Math.round(spot / 5) * 5;
    strike = atm + 5;
    dte = 7;
  } else if (analysis.score <= cfg.bearEntry) {
    type = "put";
    const atm = Math.round(spot / 5) * 5;
    strike = atm - 5;
    dte = 7;
  } else {
    return null;
  }

  const premium = optPrice(spot, strike, dte, DEFAULT_IV, type);
  const costPer = premium * 100;
  let qty = Math.max(1, Math.floor(maxRisk / costPer));
  let totalCost = qty * costPer;

  if (costPer > state.cash) return null;
  if (totalCost > state.cash) { qty = Math.floor(state.cash / costPer); totalCost = qty * costPer; }

  const position = {
    ticker, type, strike, dte,
    dteRemaining: dte,
    entryPremium: premium,
    entrySpot: spot,
    qty,
    originalQty: qty,
    cost: totalCost,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,
    bestPnlPct: 0,
    claudeConfidence: claudeResult.confidence,
    setupQuality: setupQuality.quality,
  };

  state.cash -= totalCost;
  state.positions.push(position);

  return position;
}

// ─── Exit Logic (with trimming support) ───

function closePosition(acct, pos, currentPremium, reason, qtyToClose) {
  const state = acct.state;
  const qty = qtyToClose || pos.qty;
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
  const pnlDollar = (currentPremium - pos.entryPremium) * qty * 100;

  if (!canClosePDT(state, pos)) {
    const used = countRecentDayTrades(state);
    log(acct, `PDT BLOCKED: Cannot close ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} — ${used}/3 day trades used`);
    return null;
  }

  const proceeds = currentPremium * qty * 100;
  state.cash += proceeds;
  recordDayTrade(state, pos);

  const dtUsed = countRecentDayTrades(state);
  const trade = { ...pos, qty: qty, closePremium: currentPremium, pnlDollar, pnlPct, reason };
  logTrade(trade);

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(acct, `${trimLabel}: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);
  if (wouldBeDayTrade(pos)) {
    log(acct, `PDT CHECK: ${dtUsed}/3 day trades used (rolling 5 days)`);
  }

  // Tweet trade exit
  tweetTradeExit(acct, pos, trade).catch(e => console.log(`  [X] Exit tweet error: ${e.message}`));

  return trade;
}

function tryExits(acct, quotes) {
  const state = acct.state;
  const cfg = acct.config;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const elapsed = (Date.now() - pos.openTime) / (86400_000);
    pos.dteRemaining = Math.max(0, pos.dte - elapsed);

    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;

    if (!pos.bestPnlPct) pos.bestPnlPct = 0;
    if (pnlPct > pos.bestPnlPct) pos.bestPnlPct = pnlPct;
    if (!pos.trimLevel) pos.trimLevel = 0;
    if (!pos.originalQty) pos.originalQty = pos.qty;

    let reason = null;
    let fullClose = false;

    if (pos.dteRemaining <= CRITICAL_DTE) {
      reason = `DTE critical (${pos.dteRemaining.toFixed(1)}d remaining)`;
      fullClose = true;
    }
    else if (pnlPct <= cfg.stopLoss) {
      reason = `stop loss ${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    else if (pos.dteRemaining <= 1) {
      reason = "DTE expiring";
      fullClose = true;
    }
    else if (pnlPct >= cfg.profitTarget) {
      reason = `profit target +${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    else if (pos.trimLevel === 0 && pnlPct >= cfg.trim1Pct) {
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `trim 1 (+${(pnlPct * 100).toFixed(0)}%, locking gains)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 1;
          log(acct, `TRIM STRATEGY: ${pos.ticker} — sold ${trimQty}/${pos.originalQty}, stop moved to breakeven`);
        }
      }
      remaining.push(pos);
      continue;
    }
    else if (pos.trimLevel === 1 && pnlPct >= cfg.trim2Pct) {
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `trim 2 (+${(pnlPct * 100).toFixed(0)}%, trailing EMAs)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 2;
          log(acct, `TRIM STRATEGY: ${pos.ticker} — sold ${trimQty} more, trailing with 8 EMA`);
        }
      }
      remaining.push(pos);
      continue;
    }
    else if (pos.trimLevel >= 1 && pnlPct <= 0) {
      reason = `breakeven stop (post-trim, was +${(pos.bestPnlPct * 100).toFixed(0)}%)`;
      fullClose = true;
    }
    else if (pos.trimLevel >= 2 && pnlPct <= 0.15) {
      reason = `trailing stop (post-trim2, locked +15%)`;
      fullClose = true;
    }

    if (!reason) { remaining.push(pos); continue; }

    if (fullClose) {
      const trade = closePosition(acct, pos, currentPremium, reason);
      if (trade) {
        closed.push(trade);
      } else {
        remaining.push(pos);
      }
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── Signal-Based Exit ───

function trySignalExits(acct, quotes, analyses) {
  const state = acct.state;
  const cfg = acct.config;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const a = analyses[pos.ticker];
    if (!a) { remaining.push(pos); continue; }

    let reversed = false;
    if (pos.type === "call" && a.score <= cfg.bearEntry) reversed = true;
    if (pos.type === "put" && a.score >= cfg.bullEntry) reversed = true;

    if (!reversed) { remaining.push(pos); continue; }

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);

    const trade = closePosition(acct, pos, currentPremium, "signal reversed");
    if (trade) {
      closed.push(trade);
    } else {
      remaining.push(pos);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── EOD / EOW Theta-Aware Exits ───

function tryTimeBasedExits(acct, quotes) {
  const state = acct.state;
  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  const isFriday = et.getDay() === 5;

  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    let reason = null;

    if (isFriday && etHour >= EOW_TRIM_HOUR) {
      if (pnlPct >= 0.20) {
        reason = `EOW profit lock +${(pnlPct * 100).toFixed(0)}% (Fri ${etHour.toFixed(1)}h, avoid weekend theta)`;
      } else if (pos.dteRemaining <= CRITICAL_DTE) {
        reason = `EOW + low DTE (${pos.dteRemaining.toFixed(1)}d, Fri close)`;
      }
    }

    if (!reason && etHour >= EOD_TIGHTEN_HOUR) {
      if (pnlPct >= 0.10 && pos.trimLevel === 0) {
        reason = `EOD lock +${(pnlPct * 100).toFixed(0)}% (3:30 PM tighten, protecting overnight)`;
      }
    }

    if (!reason && pos.dteRemaining <= LOW_DTE_THRESHOLD && pnlPct >= 0.20) {
      reason = `low DTE accelerated exit +${(pnlPct * 100).toFixed(0)}% (${pos.dteRemaining.toFixed(1)}d left, theta accelerating)`;
    }

    if (!reason) { remaining.push(pos); continue; }

    const trade = closePosition(acct, pos, currentPremium, reason);
    if (trade) {
      closed.push(trade);
    } else {
      remaining.push(pos);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── EMA Trailing Exits (trim 3 & 4 — SRxTrades 8/21 EMA trail) ───

function tryEMATrailingExits(acct, quotes) {
  const state = acct.state;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if ((pos.trimLevel || 0) < 2) { remaining.push(pos); continue; }

    const candles = acct.candleCache[pos.ticker];
    if (!candles || candles.length < 22) { remaining.push(pos); continue; }

    const closes = candles.map(d => d.c);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const L = closes.length - 1;
    const price = closes[L];

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    let reason = null;

    const below8 = pos.type === "call" ? price < ema8[L] : price > ema8[L];
    const below21 = pos.type === "call" ? price < ema21[L] : price > ema21[L];

    if (pos.trimLevel === 2 && below8) {
      const trimQty = Math.max(1, Math.floor((pos.originalQty || pos.qty) * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `8 EMA break (trim 3, trailing 21 EMA with remainder)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 3;
          log(acct, `EMA TRAIL: ${pos.ticker} broke 8 EMA — sold ${trimQty}, trailing 21 EMA with ${pos.qty} left`);
        }
      }
      remaining.push(pos);
      continue;
    }

    if (pos.trimLevel === 3 && below21) {
      reason = "21 EMA break (final exit per SRxTrades trail)";
    }

    if (reason) {
      const trade = closePosition(acct, pos, currentPremium, reason);
      if (trade) {
        closed.push(trade);
      } else {
        remaining.push(pos);
      }
    } else {
      remaining.push(pos);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── Dashboard State — now per-account in acct.dashboard ───

// ─── Web Dashboard ───

const DASH_PORT = parseInt(process.env.PORT) || 3000;

function dashboardHTML(acct) {
  const state = acct.state;
  const dashboard = acct.dashboard;
  const cfg = acct.config;
  const STARTING_CASH = cfg.startingCash;
  const GOAL = cfg.goal;
  const PROFIT_TARGET = cfg.profitTarget;
  const STOP_LOSS = cfg.stopLoss;
  const BULL_ENTRY = cfg.bullEntry;
  const BEAR_ENTRY = cfg.bearEntry;
  const RISK_PCT = acct.riskPct;
  const currentRegime = acct.currentRegime;
  const pv = portfolioValue(state, dashboard.quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  const progress = ((pv / GOAL) * 100).toFixed(1);
  const dtCount = countRecentDayTrades(state);

  // Build position details on-the-fly if no cycle has run yet
  let posSource = dashboard.positionDetails;
  if (posSource.length === 0 && state.positions.length > 0) {
    posSource = state.positions.map(pos => {
      const q = dashboard.quotes[pos.ticker];
      const spot = q ? q.c : pos.entrySpot;
      const elapsed = (Date.now() - pos.openTime) / 86400_000;
      const dteLeft = Math.max(0, pos.dte - elapsed);
      const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type);
      const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
      const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;
      const profitPrice = pos.entryPremium * (1 + PROFIT_TARGET);
      const stopPrice = pos.entryPremium * (1 + STOP_LOSS);
      const isDayTrade = pos.openDate === getETDateStr();
      const pdtStatus = isDayTrade ? `Day trade (${dtCount}/3 used)` : "Swing (not a day trade)";
      return {
        ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
        profitTarget: { pct: `+${(PROFIT_TARGET * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
        stopLoss: { pct: `${(STOP_LOSS * 100).toFixed(0)}%`, premium: stopPrice.toFixed(2) },
        pctToProfit: ((profitPrice - curPremium) / curPremium * 100).toFixed(1),
        pctToStop: ((stopPrice - curPremium) / curPremium * 100).toFixed(1),
        pdtStatus,
        greeks: optGreeks(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type),
      };
    });
  }

  const posRows = posSource.length > 0 ? posSource.map(p => {
    const color = p.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    const q = dashboard.quotes[p.ticker];
    const spotChg = q && q.d != null ? q.d : 0;
    const spotChgPct = q && q.dp != null ? q.dp : 0;
    const spotColor = spotChg >= 0 ? "#00ff88" : "#ff4444";
    const spotFromEntry = p.spot && p.entrySpot ? ((p.spot - p.entrySpot) / p.entrySpot * 100) : 0;
    const spotFromEntryColor = spotFromEntry >= 0 ? "#00ff88" : "#ff4444";
    return `<tr>
      <td><a href="/ticker/${p.ticker}"><b>${p.ticker}</b></a></td><td>${p.type.toUpperCase()}</td><td>$${p.strike}</td>
      <td style="white-space:nowrap">$${p.spot.toFixed(2)}<br><span style="color:${spotColor};font-size:10px">${spotChg >= 0 ? "+" : ""}${spotChg.toFixed(2)} (${spotChgPct >= 0 ? "+" : ""}${spotChgPct.toFixed(1)}%)</span><br><span style="color:${spotFromEntryColor};font-size:10px">from entry: ${spotFromEntry >= 0 ? "+" : ""}${spotFromEntry.toFixed(1)}%</span></td>
      <td>${p.dteLeft.toFixed(1)}d</td><td>${p.qty}</td>
      <td>$${p.entryPremium.toFixed(2)}</td><td>$${p.curPremium.toFixed(2)}</td>
      <td style="color:${color}">${p.pnlPct >= 0 ? "+" : ""}${(p.pnlPct * 100).toFixed(1)}% ($${p.pnlDollar.toFixed(0)})</td>
      <td><span style="color:#00ff88">TP $${p.profitTarget.premium}</span> (${p.pctToProfit}% away)</td>
      <td><span style="color:#ff4444">SL $${p.stopLoss.premium}</span> (${p.pctToStop}% away)</td>
      <td style="font-size:10px;color:#888">δ${p.greeks.delta} θ${p.greeks.theta}<br>${p.pdtStatus}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="12" style="opacity:.5">No open positions</td></tr>';

  // Decision reasoning panel
  const decisionRows = dashboard.decisions.map(d => {
    const actionColor = d.action === "BUY CALL" ? "#00ff88" : d.action === "BUY PUT" ? "#ff4444" :
      d.action === "HOLD" ? "#4ecdc4" : d.action === "BLOCKED" ? "#ffd93d" : "#666";
    const hintStr = d.hintBias ? ` <span style="color:#a78bfa">${d.hintBias > 0 ? "+" : ""}${d.hintBias}</span>` : "";
    const stColor = d.shortTermScore != null ? (d.shortTermScore >= 55 ? "#00ff88" : d.shortTermScore >= 45 ? "#888" : "#ff4444") : "#555";
    const ltColor = d.longTermScore != null ? (d.longTermScore >= 55 ? "#00ff88" : d.longTermScore >= 45 ? "#888" : "#ff4444") : "#555";
    const mc = v => v > 0 ? "#00ff88" : v < 0 ? "#ff4444" : "#888";
    return `<tr>
      <td><a href="/ticker/${d.ticker}"><b>${d.ticker}</b></a></td>
      <td>${d.price ? "$" + d.price.toFixed(2) : "—"}</td>
      <td><span style="color:${stColor}">${d.shortTermScore ?? "—"}</span>/<span style="color:${ltColor}">${d.longTermScore ?? "—"}</span>${hintStr} → <b>${d.finalScore ?? "—"}</b></td>
      <td style="color:${actionColor}"><b>${d.action}</b></td>
      <td style="font-size:11px">${d.reason || "—"}</td>
      <td style="font-size:10px;color:#888">${d.ema8 ? `8:${d.ema8} 21:${d.ema21} 50:${d.ema50}` : "—"}</td>
      <td style="font-size:10px;color:#888">${d.stEma3 ? `3:${d.stEma3} 5:${d.stEma5} 8:${d.stEma8}` : "—"}</td>
      <td style="font-size:10px;color:#888">${d.rsi ? `RSI14:${d.rsi} RSI5:${d.stRsi ?? "—"} ATR:${d.atrPct}% VR:${d.vr}` : "—"}</td>
      <td style="font-size:10px">${d.mom1d != null ? `<span style="color:${mc(+d.mom1d)}">1d:${d.mom1d}%</span> <span style="color:${mc(+d.mom3d)}">3d:${d.mom3d}%</span> <span style="color:${mc(+d.mom7d)}">7d:${d.mom7d}%</span>` : "—"}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="9" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const analysisRows = Object.entries(dashboard.analyses).map(([ticker, a]) => {
    const q = dashboard.quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "—";
    const ahPrice = q && q.dp !== undefined ? `<span style="color:${q.d >= 0 ? '#00ff88' : '#ff4444'};font-size:10px">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2) ?? ''} (${q.dp?.toFixed(1) ?? ''}%)</span>` : "";
    const st = dashboard.shortTermAnalyses[ticker];
    const sigColor = a.signal === "STRONG BUY" ? "#00ff88" : a.signal === "BUY WATCH" ? "#ffd93d" : a.signal === "NEUTRAL" ? "#888" : a.signal === "SELL WATCH" ? "#ff8c42" : "#ff4444";
    const stColor = st ? (st.score >= 65 ? "#00ff88" : st.score >= 55 ? "#ffd93d" : st.score >= 45 ? "#888" : st.score >= 35 ? "#ff8c42" : "#ff4444") : "#555";
    const hintBias = getHintBias(acct, ticker);
    const hintTag = hintBias !== 0 ? ` <span style="color:#a78bfa">[${hintBias > 0 ? "+" : ""}${hintBias}]</span>` : "";
    const momStr = st ? `<span style="color:${st.mom1d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(1)}%</span>` : "—";
    return `<tr><td><a href="/ticker/${ticker}">${ticker}</a></td><td>${price} ${ahPrice}</td>
      <td><b style="color:${sigColor}">${a.score}</b></td>
      <td style="color:${stColor}">${st ? st.score : '—'}</td>
      <td style="color:${sigColor}">${a.signal}${hintTag}</td>
      <td>${a.rsi.toFixed(0)}</td><td>${st ? st.rsi.toFixed(0) : '—'}</td><td>${momStr}</td><td>${a.atrPct.toFixed(1)}%</td><td>${a.vr.toFixed(2)}</td></tr>`;
  }).join("") || '<tr><td colspan="10" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const historyRows = state.history.slice(-20).reverse().map(h => {
    const color = h.pnlDollar >= 0 ? "#00ff88" : "#ff4444";
    return `<tr><td>${h.ticker}</td><td>${h.type.toUpperCase()}</td><td>$${h.strike}</td>
      <td>$${h.entryPremium.toFixed(2)}</td><td>$${(h.closePremium || 0).toFixed(2)}</td>
      <td style="color:${color}">${h.pnlDollar >= 0 ? "+" : ""}$${h.pnlDollar.toFixed(0)} (${(h.pnlPct * 100).toFixed(0)}%)</td>
      <td>${h.reason || "—"}</td></tr>`;
  }).join("") || '<tr><td colspan="7" style="opacity:.5">No trades yet</td></tr>';

  const hints = acct.activeHints.map(h => {
    const mins = Math.round((h.expiresAt - Date.now()) / 60_000);
    return `<span class="hint">${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${h.direction}, ${mins}m left) — ${h.reasoning}</span>`;
  }).join("") || '<span style="opacity:.5">None active. Write to hint.txt to add.</span>';

  const logLines = dashboard.cycleLog.slice(-50).reverse().map(l =>
    l.replace(/\[(\d+:\d+:\d+)\]/, '<span style="color:#666">[$1]</span>')
      .replace(/(TRADE:|EXIT:|HINT RECEIVED:|CLAUDE SAYS:)/g, '<b style="color:#a78bfa">$1</b>')
      .replace(/(PDT BLOCKED:)/g, '<b style="color:#ff4444">$1</b>')
      .replace(/(STRONG BUY)/g, '<span style="color:#00ff88">$1</span>')
      .replace(/(AVOID)/g, '<span style="color:#ff4444">$1</span>')
  ).join("<br>");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Swing Trader Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:13px;padding:20px}
  h1{color:#00ff88;font-size:20px;margin-bottom:4px}
  .sub{color:#666;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:16px}
  .card h2{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:24px;margin-bottom:8px}
  .stat .val{font-size:22px;font-weight:800;color:#00ff88}
  .stat .lbl{font-size:10px;color:#666;text-transform:uppercase}
  .stat.warn .val{color:#ffd93d}
  .stat.neg .val{color:#ff4444}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;color:#666;font-size:10px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #1e1e2e}
  td{padding:6px 8px;border-bottom:1px solid #0e0e16}
  tr:hover{background:#ffffff05}
  a{color:#4ecdc4;text-decoration:none}a:hover{text-decoration:underline}
  .log{background:#08080c;border-radius:6px;padding:12px;max-height:300px;overflow-y:auto;line-height:1.6;font-size:11px}
  .hint{display:inline-block;background:#a78bfa20;border:1px solid #a78bfa40;border-radius:4px;padding:2px 8px;margin:2px 4px;font-size:11px;color:#a78bfa}
  .progress{background:#1e1e2e;border-radius:4px;height:20px;margin:8px 0;overflow:hidden}
  .progress-bar{height:100%;background:linear-gradient(90deg,#00ff88,#4ecdc4);border-radius:4px;transition:width .5s}
  .hint-form{margin-top:8px}
  .hint-form input{background:#0a0a0f;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:4px;width:70%;font-family:inherit;font-size:12px}
  .hint-form button{background:#a78bfa;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px}
  .market-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}
  .open{background:#00ff8830;color:#00ff88}
  .closed{background:#ff444430;color:#ff4444}
  .flash{animation:flash .4s}
  @keyframes flash{0%{background:#ffffff15}100%{background:transparent}}
  .tab-bar{background:#0a0a12;border-bottom:1px solid #222;padding:6px 12px 0}
  .tab-row{display:flex;flex-wrap:wrap;gap:4px;align-items:stretch}
  .acct-tab{display:flex;flex-direction:column;align-items:center;padding:8px 16px 6px;background:#14141e;border:1px solid #222;border-bottom:none;border-radius:8px 8px 0 0;color:#888;text-decoration:none;font-size:11px;min-width:100px;transition:all .2s}
  .acct-tab:hover{background:#1a1a2e;color:#fff}
  .acct-tab.active{background:#1a1a2e;border-color:#333;color:#fff;border-bottom:2px solid #00ff88}
  .acct-tab.new-tab{border-style:dashed;color:#555;justify-content:center}
  .acct-tab.new-tab:hover{color:#00ff88;border-color:#00ff88}
  .tab-name{font-weight:700;font-size:12px}
  .tab-pv{font-size:14px;font-weight:700;color:#fff}
  .tab-pnl{font-size:11px}
  .tab-status{font-size:8px}
  .global-stats{display:flex;gap:16px;padding:6px 0;font-size:11px;color:#666}
  .global-stats b{color:#fff}
  .acct-actions{padding:4px 0;display:flex;gap:8px}
  .acct-btn{padding:4px 12px;border:1px solid #333;border-radius:4px;background:#14141e;color:#888;cursor:pointer;font-size:11px}
  .acct-btn:hover{background:#1e1e30;color:#fff}
  .acct-btn.pause:hover{border-color:#ffd93d;color:#ffd93d}
  .acct-btn.resume:hover{border-color:#00ff88;color:#00ff88}
  .acct-btn.delete:hover{border-color:#ff4444;color:#ff4444}
</style></head><body>
${tabBarHTML(acct.id)}
${accountActionsHTML(acct.id)}
<h1>${acct.name || "Swing Trader"}</h1>
<div class="sub">$${STARTING_CASH} → $${GOAL.toLocaleString()} Challenge &nbsp;|&nbsp; <span class="market-badge ${dashboard.marketOpen ? "open" : "closed"}" id="mkt-badge">${dashboard.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span> &nbsp;|&nbsp; <span id="live-indicator" style="color:#00ff88">LIVE</span> updates every 5s &nbsp;|&nbsp; <span id="pv-header">$${pv.toFixed(0)}</span> <span id="pnl-header" style="color:${pnlPct >= 0 ? '#00ff88' : '#ff4444'}">(${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</span> &nbsp;|&nbsp; <span style="color:${currentRegime.mode === 'risk-on' ? '#00ff88' : currentRegime.mode === 'cautious' ? '#ffd93d' : '#ff4444'};font-size:10px">${currentRegime.mode.toUpperCase()}</span> &nbsp;|&nbsp; <span style="color:#a78bfa;font-size:10px" title="Claude Haiku 4.5 API calls this session">🤖 ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>${acct.paused ? ' &nbsp;|&nbsp; <span style="color:#ff4444;font-weight:bold">⏸ PAUSED</span>' : ''}</div>

<div class="grid">
  <div class="card">
    <h2>Portfolio</h2>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">$${pv.toFixed(0)}</div><div class="lbl">Total Value</div></div>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">${pnlPct >= 0 ? "+" : ""}${pnlPct}%</div><div class="lbl">P&L</div></div>
    <div class="stat"><div class="val">$${state.cash.toFixed(0)}</div><div class="lbl">Cash</div></div>
    <div class="stat warn"><div class="val">${dtCount}/3</div><div class="lbl">PDT Used</div></div>
    <div class="progress"><div class="progress-bar" style="width:${Math.min(100, progress)}%"></div></div>
    <div style="font-size:11px;color:#666">${progress}% to $${GOAL.toLocaleString()} goal</div>
  </div>
  <div class="card">
    <h2>Claude Hints &amp; News Intel</h2>
    <div style="margin-bottom:8px;padding:6px 10px;background:#0a0a0f;border-radius:4px;font-size:11px;border-left:3px solid ${(acct.latestNewsBrief || "").includes("CRITICAL") ? "#ff4444" : (acct.latestNewsBrief || "").includes("ELEVATED") ? "#ffd93d" : "#333"}">${acct.latestNewsBrief || '<span style="opacity:.4">News scan runs every 3 hours...</span>'}</div>
    <div style="margin-bottom:8px">${hints}</div>
    <form class="hint-form" method="POST" action="/hint?a=${acct.id}">
      <input name="hint" placeholder='e.g. "PLTR looks bullish, iran war catalyst"' autocomplete="off">
      <button type="submit">Send Hint</button>
    </form>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Open Positions (${state.positions.length})</h2>
  <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Stock Price</th><th>DTE</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L</th><th>Profit Target</th><th>Stop Loss</th><th>Greeks / PDT</th></tr>${posRows}</table>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Bot Thinking — Decision Reasoning</h2>
  <div style="font-size:10px;color:#555;margin-bottom:8px">Score 50=neutral · ≥${BULL_ENTRY} buy calls · ≤${BEAR_ENTRY} buy puts · Risk: ${(RISK_PCT * 100)}%/trade · TP: +${(PROFIT_TARGET * 100)}% · SL: ${(STOP_LOSS * 100)}%</div>
  <table><tr><th>Ticker</th><th>Price</th><th>Score (7d/90d→blend→final)</th><th>Decision</th><th>Reasoning</th><th>EMAs (8/21/50)</th><th>7d EMAs (3/5/8)</th><th>Indicators</th><th>Momentum</th></tr>${decisionRows}</table>
</div>

<div class="grid">
  <div class="card">
    <h2>Analysis (${Object.keys(dashboard.analyses).length} tickers)</h2>
    <table><tr><th>Ticker</th><th>Price</th><th>Score</th><th>7d</th><th>Signal</th><th>RSI(14)</th><th>RSI(5)</th><th>1d Mom</th><th>ATR%</th><th>Vol Ratio</th></tr>${analysisRows}</table>
  </div>
  <div class="card">
    <h2>Trade History (last 20)</h2>
    <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>${historyRows}</table>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Portfolio Value Over Time</h2>
  ${(() => {
      const hist = dashboard.portfolioHistory || [];
      if (hist.length < 2) return '<span style="opacity:.5;font-size:12px">Collecting data — chart appears after 2+ cycles...</span>';
      const W = 900, H = 180, PAD = 48;
      const vals = hist.map(h => h.value);
      const times = hist.map(h => h.ts);
      const minV = Math.min(...vals, STARTING_CASH);
      const maxV = Math.max(...vals, STARTING_CASH * 1.1);
      const minT = times[0], maxT = times[times.length - 1];
      const xOf = t => PAD + (t - minT) / Math.max(1, maxT - minT) * (W - PAD * 2);
      const yOf = v => H - PAD / 2 - (v - minV) / Math.max(1, maxV - minV) * (H - PAD);
      const pts = hist.map(h => `${xOf(h.ts).toFixed(1)},${yOf(h.value).toFixed(1)}`).join(' ');
      const lastVal = vals[vals.length - 1];
      const color = lastVal >= STARTING_CASH ? '#00ff88' : '#ff4444';
      const startY = yOf(STARTING_CASH).toFixed(1);
      const goalY = yOf(GOAL) > 0 ? yOf(GOAL).toFixed(1) : '4';
      const labelTime = t => { const d = new Date(t); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); };
      return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">
      <defs><linearGradient id="pvgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.25"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <!-- baseline -->
      <line x1="${PAD}" y1="${startY}" x2="${W - PAD}" y2="${startY}" stroke="#ffffff22" stroke-width="1" stroke-dasharray="4,4"/>
      <text x="${PAD - 4}" y="${Number(startY) + 4}" fill="#ffffff44" font-size="10" text-anchor="end">$${STARTING_CASH.toLocaleString()}</text>
      <!-- goal line -->
      <line x1="${PAD}" y1="${goalY}" x2="${W - PAD}" y2="${goalY}" stroke="#ffd93d33" stroke-width="1" stroke-dasharray="3,6"/>
      <!-- area fill -->
      <polygon points="${pts} ${xOf(maxT).toFixed(1)},${H - PAD / 2} ${xOf(minT).toFixed(1)},${H - PAD / 2}" fill="url(#pvgrad)"/>
      <!-- line -->
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <!-- current value dot + label -->
      <circle cx="${xOf(maxT).toFixed(1)}" cy="${yOf(lastVal).toFixed(1)}" r="4" fill="${color}"/>
      <text x="${Math.min(xOf(maxT) + 6, W - PAD - 60)}" y="${Math.min(yOf(lastVal) - 6, H - PAD / 2 - 10)}" fill="${color}" font-size="11" font-weight="bold">$${lastVal.toFixed(0)}</text>
      <!-- x-axis labels -->
      <text x="${PAD}" y="${H - 6}" fill="#ffffff44" font-size="9">${labelTime(minT)}</text>
      <text x="${W - PAD}" y="${H - 6}" fill="#ffffff44" font-size="9" text-anchor="end">${labelTime(maxT)}</text>
    </svg>`;
    })()}
</div>

<div class="card" style="margin-top:16px">
  <h2>Live Log</h2>
  <div class="log" id="live-log">${logLines || '<span style="opacity:.5">Waiting for first cycle...</span>'}</div>
</div>

<script>
let prevPrices = {};
async function pollLive() {
  try {
    const r = await fetch('/api/live?a=${acct.id}');
    const d = await r.json();
    // Update header
    const pvEl = document.getElementById('pv-header');
    const pnlEl = document.getElementById('pnl-header');
    if (pvEl) {
      pvEl.textContent = '$' + d.pv.toFixed(0);
      const pnl = ((d.pv - ${STARTING_CASH}) / ${STARTING_CASH} * 100).toFixed(1);
      pnlEl.textContent = '(' + (pnl >= 0 ? '+' : '') + pnl + '%)';
      pnlEl.style.color = pnl >= 0 ? '#00ff88' : '#ff4444';
    }
    // Pulse indicator
    const ind = document.getElementById('live-indicator');
    if (ind) { ind.style.opacity = '1'; setTimeout(() => ind.style.opacity = '.4', 200); }
  } catch(e) {}
}
setInterval(pollLive, 5000);
pollLive();
</script>

</body></html>`;
}

function tickerDetailHTML(sym, acct) {
  const state = acct.state;
  const dashboard = acct.dashboard;
  const candles = dashboard.candles[sym];
  const a = dashboard.analyses[sym];
  const q = dashboard.quotes[sym];
  const dec = dashboard.decisions.find(d => d.ticker === sym);
  const pos = dashboard.positionDetails.find(p => p.ticker === sym);
  const hintBias = getHintBias(acct, sym);
  const hint = acct.activeHints.find(h => h.ticker === sym);

  const st = dashboard.shortTermAnalyses[sym];

  // Helper: build SVG candlestick chart from a set of candles with EMA overlays
  function buildChart(cdata, emas, W, H) {
    if (!cdata || cdata.length < 3) return { chart: '<div style="color:#555">No data</div>', volume: '' };
    const cls = cdata.map(c => c.c), hs = cdata.map(c => c.h), ls = cdata.map(c => c.l), vs = cdata.map(c => c.v);
    const emaLines = emas.map(e => ({ data: calcEMA(cls, e.period), color: e.color, label: e.label }));
    const allP = [...hs, ...ls];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 20) - 10;
    const x = i => (i / Math.max(1, cls.length - 1)) * W;

    const bars = cdata.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00ff88" : "#ff4444";
      const bw = Math.max(3, W / cdata.length - 1);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bot - top);
      return `<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1"/>
        <rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${bodyH}" fill="${color}" rx="0.5"/>`;
    }).join("");

    const emaPaths = emaLines.map(e =>
      `<path d="${e.data.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${e.color}" stroke-width="1.5" opacity="0.8"/>`
    ).join("");

    const pLabels = [mn, mn + rng * 0.25, mn + rng * 0.5, mn + rng * 0.75, mx].map(p =>
      `<text x="${W + 5}" y="${y(p)}" fill="#555" font-size="9" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    const legend = emaLines.map(e =>
      `<span style="color:${e.color}">\u2501 ${e.label} (${e.data[e.data.length - 1].toFixed(2)})</span>`
    ).join(" &nbsp; ");

    const chart = `<svg viewBox="0 0 ${W + 60} ${H}" style="width:100%;height:${H}px">
      ${bars}${emaPaths}${pLabels}
    </svg>
    <div style="font-size:10px;margin-top:4px;color:#666">${legend}</div>`;

    const maxV = Math.max(...vs);
    const avgV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const VH = 60;
    const volBars = vs.map((v, i) => {
      const bw = Math.max(3, W / vs.length - 1);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw / 2}" y="${VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00ff8850' : '#ffffff18'}" rx="0.5"/>`;
    }).join("");
    const volume = `<svg viewBox="0 0 ${W + 60} ${VH}" style="width:100%;height:${VH}px">
      <line x1="0" y1="${VH - (avgV / maxV) * VH}" x2="${W}" y2="${VH - (avgV / maxV) * VH}" stroke="#ffffff15" stroke-dasharray="3 2"/>
      ${volBars}
    </svg>`;

    return { chart, volume };
  }

  // 90-day chart with EMA 8/21/50
  const longChart = buildChart(candles, [
    { period: 8, color: "#4ecdc4", label: "EMA 8" },
    { period: 21, color: "#ff6b35", label: "EMA 21" },
    { period: 50, color: "#a78bfa", label: "EMA 50" },
  ], 700, 250);

  // 7-day chart (last 14 candles) with EMA 3/5/8
  const shortCandles = candles ? candles.slice(-14) : null;
  const shortChart = buildChart(shortCandles, [
    { period: 3, color: "#00d4ff", label: "EMA 3" },
    { period: 5, color: "#ffd93d", label: "EMA 5" },
    { period: 8, color: "#ff6b9d", label: "EMA 8" },
  ], 700, 250);

  const chartSVG = longChart.chart;
  const volumeSVG = longChart.volume;

  // Position info block
  let posBlock = '<div style="color:#555">No position in this ticker</div>';
  if (pos) {
    const color = pos.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    const posSpotChg = q && q.d != null ? q.d : 0;
    const posSpotChgPct = q && q.dp != null ? q.dp : 0;
    const posSpotColor = posSpotChg >= 0 ? "#00ff88" : "#ff4444";
    const posSpotFromEntry = pos.spot && pos.entrySpot ? ((pos.spot - pos.entrySpot) / pos.entrySpot * 100) : 0;
    const posSpotEntryColor = posSpotFromEntry >= 0 ? "#00ff88" : "#ff4444";
    posBlock = `
      <div class="stat"><div class="val">${pos.type.toUpperCase()}</div><div class="lbl">Type</div></div>
      <div class="stat"><div class="val">$${pos.strike}</div><div class="lbl">Strike</div></div>
      <div class="stat"><div class="val">${pos.qty}</div><div class="lbl">Contracts</div></div>
      <div class="stat"><div class="val">${pos.dteLeft.toFixed(1)}d</div><div class="lbl">DTE Left</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">$${pos.spot.toFixed(2)}</div><div class="lbl">Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotColor}">${posSpotChg >= 0 ? "+" : ""}${posSpotChg.toFixed(2)} (${posSpotChgPct >= 0 ? "+" : ""}${posSpotChgPct.toFixed(1)}%)</div><div class="lbl">Today's Move</div></div>
      <div class="stat"><div class="val">$${pos.entrySpot.toFixed(2)}</div><div class="lbl">Entry Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotEntryColor}">${posSpotFromEntry >= 0 ? "+" : ""}${posSpotFromEntry.toFixed(1)}%</div><div class="lbl">Stock Since Entry</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">$${pos.entryPremium.toFixed(2)}</div><div class="lbl">Entry Premium</div></div>
      <div class="stat"><div class="val">$${pos.curPremium.toFixed(2)}</div><div class="lbl">Current Premium</div></div>
      <div class="stat ${pos.pnlPct >= 0 ? '' : 'neg'}"><div class="val" style="color:${color}">${(pos.pnlPct * 100).toFixed(1)}% ($${pos.pnlDollar.toFixed(0)})</div><div class="lbl">P&L</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val" style="color:#00ff88">$${pos.profitTarget.premium}</div><div class="lbl">TP (${pos.profitTarget.pct})</div></div>
      <div class="stat"><div class="val" style="color:#ff4444">$${pos.stopLoss.premium}</div><div class="lbl">SL (${pos.stopLoss.pct})</div></div>
      <div class="stat"><div class="val">${pos.pctToProfit}%</div><div class="lbl">To Profit</div></div>
      <div class="stat"><div class="val">${pos.pctToStop}%</div><div class="lbl">To Stop</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">${pos.greeks.delta}</div><div class="lbl">Delta</div></div>
      <div class="stat"><div class="val">${pos.greeks.theta}</div><div class="lbl">Theta/day</div></div>
      <div class="stat"><div class="val">${pos.pdtStatus}</div><div class="lbl">PDT Status</div></div>`;
  }

  // Decision block
  let decBlock = '';
  if (dec) {
    const actionColor = dec.action === "BUY CALL" ? "#00ff88" : dec.action === "BUY PUT" ? "#ff4444" :
      dec.action === "HOLD" ? "#4ecdc4" : dec.action === "BLOCKED" ? "#ffd93d" : "#666";
    decBlock = `
      <div class="stat"><div class="val">${dec.rawScore ?? '—'}</div><div class="lbl">Raw Score</div></div>
      <div class="stat"><div class="val">${dec.finalScore ?? '—'}</div><div class="lbl">Final Score</div></div>
      <div class="stat"><div class="val" style="color:${actionColor}">${dec.action}</div><div class="lbl">Decision</div></div>
      <div style="margin:8px 0;color:#aaa;font-size:12px">${dec.reason}</div>
      <div style="margin-top:8px">${(dec.signals || []).map(s => '<div style="color:#888;font-size:11px;padding:2px 0">• ' + s + '</div>').join('')}</div>`;
  }

  // Analysis stats
  let statsBlock = '<div style="color:#555">No analysis data</div>';
  if (a) {
    const sigColor = a.signal === "STRONG BUY" ? "#00ff88" : a.signal === "BUY WATCH" ? "#ffd93d" : a.signal === "NEUTRAL" ? "#888" : a.signal === "SELL WATCH" ? "#ff8c42" : "#ff4444";
    statsBlock = `
      <div class="stat"><div class="val" style="color:${sigColor}">${a.score}</div><div class="lbl">Score</div></div>
      <div class="stat"><div class="val" style="color:${sigColor}">${a.signal}</div><div class="lbl">Signal</div></div>
      <div class="stat"><div class="val">${a.rsi.toFixed(1)}</div><div class="lbl">RSI (14)</div></div>
      <div class="stat"><div class="val">${a.atrPct.toFixed(2)}%</div><div class="lbl">ATR %</div></div>
      <div class="stat"><div class="val">${a.vr.toFixed(2)}</div><div class="lbl">Vol Ratio</div></div>
      <div class="stat"><div class="val">${a.aligned ? "YES" : "NO"}</div><div class="lbl">EMA Aligned</div></div>
      <div class="stat"><div class="val">${a.spread?.toFixed(2) || '—'}%</div><div class="lbl">EMA Spread</div></div>
      <div class="stat"><div class="val">$${a.stop}</div><div class="lbl">ATR Stop</div></div>
      <div class="stat"><div class="val">$${a.t1}</div><div class="lbl">Target 1</div></div>
      <div class="stat"><div class="val">$${a.t2}</div><div class="lbl">Target 2</div></div>
      <div class="stat"><div class="val">${a.rr}x</div><div class="lbl">R:R Ratio</div></div>`;
  }

  const hintBlock = hint
    ? `<div class="hint">${hint.direction} bias ${hint.bias > 0 ? '+' : ''}${hint.bias} — ${hint.reasoning} (expires ${Math.round((hint.expiresAt - Date.now()) / 60000)}m)</div>`
    : '<span style="color:#555">No active hint for this ticker</span>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${sym} — Swing Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:13px;padding:20px}
  h1{color:#00ff88;font-size:20px;margin-bottom:4px}
  a{color:#4ecdc4;text-decoration:none}a:hover{text-decoration:underline}
  .sub{color:#666;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:16px}
  .card h2{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:20px;margin-bottom:8px}
  .stat .val{font-size:16px;font-weight:800;color:#00ff88}
  .stat .lbl{font-size:10px;color:#666;text-transform:uppercase}
  .stat.neg .val{color:#ff4444}
  .hint{display:inline-block;background:#a78bfa20;border:1px solid #a78bfa40;border-radius:4px;padding:4px 10px;font-size:11px;color:#a78bfa}
</style></head><body>
<h1><a href="/">← Back</a> &nbsp; ${sym} ${q ? '$' + q.c.toFixed(2) : ''}
${q ? `<span style="font-size:13px;color:${q.d >= 0 ? '#00ff88' : '#ff4444'}">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2)} (${q.dp?.toFixed(2)}%)</span>` : ''}</h1>
<div class="sub">${pos ? pos.type.toUpperCase() + ' $' + pos.strike + ' | ' + pos.qty + ' contracts' : 'Not currently held'} &nbsp;|&nbsp; Auto-refreshes every 30s
${q?.t ? ` &nbsp;|&nbsp; Last: ${new Date(q.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ''}</div>

<div class="card" style="margin-bottom:16px;border-color:#00d4ff40">
  <h2 style="color:#00d4ff">7-Day Chart (Contract Window) — Fast EMAs 3/5/8</h2>
  ${shortChart.chart}
  <div style="margin-top:8px">${shortChart.volume}</div>
  ${st ? `<div style="margin-top:12px;display:flex;gap:20px;flex-wrap:wrap">
    <div class="stat"><div class="val" style="color:${st.score >= 55 ? '#00ff88' : st.score >= 45 ? '#888' : '#ff4444'}">${st.score}</div><div class="lbl">7d Score</div></div>
    <div class="stat"><div class="val" style="color:${st.signal.includes('BUY') ? '#00ff88' : st.signal.includes('SELL') ? '#ff4444' : '#888'}">${st.signal}</div><div class="lbl">7d Signal</div></div>
    <div class="stat"><div class="val" style="color:${st.mom1d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(2)}%</div><div class="lbl">1d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom3d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom3d >= 0 ? '+' : ''}${st.mom3d.toFixed(2)}%</div><div class="lbl">3d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom7d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom7d >= 0 ? '+' : ''}${st.mom7d.toFixed(2)}%</div><div class="lbl">7d Momentum</div></div>
    <div class="stat"><div class="val">${st.rsi.toFixed(0)}</div><div class="lbl">RSI (5)</div></div>
    <div class="stat"><div class="val">${st.range7d.toFixed(1)}%</div><div class="lbl">7d Range</div></div>
    <div class="stat"><div class="val">$${st.recentHigh.toFixed(2)}</div><div class="lbl">7d High${st.nearHigh ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">$${st.recentLow.toFixed(2)}</div><div class="lbl">7d Low${st.nearLow ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">${st.vr.toFixed(2)}</div><div class="lbl">Vol Ratio</div></div>
  </div>
  <div style="margin-top:8px">${st.sigs.map(s => '<span style="color:' + (s.t === 'bull' ? '#00ff88' : '#ff4444') + ';font-size:11px;margin-right:12px">• ' + s.text + '</span>').join('')}</div>` : ''}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>90-Day Chart — EMAs 8/21/50</h2>
  ${chartSVG}
  <div style="margin-top:8px">${volumeSVG || '<div style="color:#555">No volume data</div>'}</div>
</div>

<div class="grid">
  <div class="card">
    <h2>90-Day Analysis & Indicators</h2>
    ${statsBlock}
  </div>
  <div class="card">
    <h2>Bot Decision (Blended 60% 7d / 40% 90d)</h2>
    ${decBlock || '<div style="color:#555">No decision data yet</div>'}
    <hr style="border-color:#1e1e2e;margin:12px 0">
    <h2 style="margin-top:8px">News/Hint Bias</h2>
    ${hintBlock}
  </div>
</div>

${pos ? '<div class="card" style="margin-top:16px"><h2>Position Details</h2>' + posBlock + '</div>' : ''}

</body></html>`;
}

// ─── Tab Bar HTML ───

function tabBarHTML(activeId) {
  let totalPV = 0;
  const tabs = [];
  for (const [id, acct] of accounts) {
    const pv = portfolioValue(acct.state, acct.dashboard.quotes);
    totalPV += pv;
    const pnl = ((pv - acct.config.startingCash) / acct.config.startingCash * 100).toFixed(1);
    const color = pnl >= 0 ? "#00ff88" : "#ff4444";
    const isActive = id === activeId;
    const statusDot = acct.paused ? "🔴" : "🟢";
    tabs.push(`<a href="/?a=${id}" class="acct-tab ${isActive ? "active" : ""}" title="${acct.name}">
      <span class="tab-status">${statusDot}</span>
      <span class="tab-name">${acct.name}</span>
      <span class="tab-pv">$${pv.toFixed(0)}</span>
      <span class="tab-pnl" style="color:${color}">${pnl >= 0 ? "+" : ""}${pnl}%</span>
    </a>`);
  }
  return `<div class="tab-bar">
  <div class="tab-row">${tabs.join("")}
    <a href="#" class="acct-tab new-tab" onclick="document.getElementById('acct-modal').style.display='flex';return false">+ New Account</a>
  </div>
  <div class="global-stats">
    <span>Total PV: <b>$${totalPV.toFixed(0)}</b></span>
    <span style="color:#a78bfa">🤖 Claude: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>
    <span>${accounts.size} account${accounts.size !== 1 ? "s" : ""}</span>
  </div>
</div>

<!-- Account Management Modal -->
<div id="acct-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center">
  <div style="background:#14141e;border:1px solid #333;border-radius:12px;padding:24px;max-width:420px;width:90%">
    <h2 style="margin:0 0 16px;color:#fff">New Account</h2>
    <form method="POST" action="/api/accounts">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Account Name</label>
      <input name="name" value="Strategy 2" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Starting Cash ($)</label>
      <input name="startingCash" type="number" value="200" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Risk per Trade (%)</label>
      <input name="baseRiskPct" type="number" step="0.01" value="15" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Profit Target (%)</label>
      <input name="profitTarget" type="number" step="1" value="40" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Stop Loss (%)</label>
      <input name="stopLoss" type="number" step="1" value="-35" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Goal ($)</label>
      <input name="goal" type="number" value="200000" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Min Setup Quality (0-100, lower = more aggressive)</label>
      <input name="minSetupQuality" type="number" value="50" min="0" max="100" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Custom Prompt Suffix (optional)</label>
      <input name="customPromptSuffix" value="" placeholder="e.g. Focus on tech sector only" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:16px;box-sizing:border-box">
      <div style="display:flex;gap:8px">
        <button type="submit" style="flex:1;padding:10px;background:#00ff88;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Create Account</button>
        <button type="button" onclick="document.getElementById('acct-modal').style.display='none'" style="flex:1;padding:10px;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer">Cancel</button>
      </div>
    </form>
  </div>
</div>`;
}

function accountActionsHTML(acctId) {
  const acct = accounts.get(acctId);
  if (!acct) return "";
  const cfg = acct.config;
  return `<div class="acct-actions">
    <button type="button" class="acct-btn edit" onclick="document.getElementById('edit-modal').style.display='flex'">⚙ Settings</button>
    <form method="POST" action="/api/accounts/${acctId}/pause" style="display:inline">
      <button type="submit" class="acct-btn ${acct.paused ? "resume" : "pause"}">${acct.paused ? "▶ Resume" : "⏸ Pause"}</button>
    </form>
    ${acctId !== "default" ? `<form method="POST" action="/api/accounts/${acctId}/delete" style="display:inline" onsubmit="return confirm('Delete account ${acct.name}? This cannot be undone.')">
      <button type="submit" class="acct-btn delete">🗑 Delete</button>
    </form>` : ""}
  </div>
  <div id="edit-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center">
    <div style="background:#14141e;border:1px solid #333;border-radius:12px;padding:24px;max-width:420px;width:90%">
      <h2 style="margin:0 0 16px;color:#fff">Settings: ${acct.name}</h2>
      <form method="POST" action="/api/accounts/${acctId}/config">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Risk per Trade (%)</label>
        <input name="baseRiskPct" type="number" step="0.01" value="${(cfg.baseRiskPct * 100).toFixed(1)}" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Profit Target (%)</label>
        <input name="profitTarget" type="number" step="1" value="${(cfg.profitTarget * 100).toFixed(0)}" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Stop Loss (%)</label>
        <input name="stopLoss" type="number" step="1" value="${(cfg.stopLoss * 100).toFixed(0)}" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Goal ($)</label>
        <input name="goal" type="number" value="${cfg.goal}" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Max Positions (blank = unlimited)</label>
        <input name="maxPositions" type="number" value="${cfg.maxPositions || ""}" placeholder="unlimited" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Min Setup Quality (0=trade anything, 50=default, 100=perfect setups only)</label>
        <input name="minSetupQuality" type="number" value="${cfg.minSetupQuality ?? 50}" min="0" max="100" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#888">Custom Prompt Suffix</label>
        <input name="customPromptSuffix" value="${(cfg.customPromptSuffix || "").replace(/"/g, "&quot;")}" placeholder="e.g. Focus on tech sector only" style="width:100%;padding:8px;background:#0a0a0f;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:16px;box-sizing:border-box">
        <div style="display:flex;gap:8px">
          <button type="submit" style="flex:1;padding:10px;background:#a78bfa;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Save Settings</button>
          <button type="button" onclick="document.getElementById('edit-modal').style.display='none'" style="flex:1;padding:10px;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer">Cancel</button>
        </div>
      </form>
    </div>
  </div>`;
}

function startDashboard(defaultAcct, apiKey) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Resolve active account from ?a= param
    const acctId = url.searchParams.get("a") || accounts.keys().next().value;
    const activeAcct = accounts.get(acctId) || accounts.values().next().value;
    const state = activeAcct.state;
    const dashboard = activeAcct.dashboard;

    // ─── Account CRUD API ───

    if (req.method === "POST" && pathname === "/api/accounts") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const name = params.get("name") || `Account ${accounts.size + 1}`;
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `acct-${Date.now()}`;
        if (accounts.has(id)) { res.writeHead(302, { Location: `/?a=${id}` }); res.end(); return; }
        const config = {
          startingCash: parseFloat(params.get("startingCash")) || 200,
          goal: parseFloat(params.get("goal")) || 200000,
          baseRiskPct: (parseFloat(params.get("baseRiskPct")) || 15) / 100,
          profitTarget: (parseFloat(params.get("profitTarget")) || 40) / 100,
          stopLoss: (parseFloat(params.get("stopLoss")) || -35) / 100,
          bullEntry: 65, bearEntry: 35, trim1Pct: 0.25, trim2Pct: 0.50,
          minSetupQuality: parseInt(params.get("minSetupQuality")) || 50,
          customPromptSuffix: params.get("customPromptSuffix") || "",
        };
        const newAcct = createAccountRuntime(id, name, config);
        newAcct.state.apiKey = apiKey;
        accounts.set(id, newAcct);
        saveAccounts();
        console.log(`  [${id}] Created account: ${name}`);
        res.writeHead(302, { Location: `/?a=${id}` });
        res.end();
      });
      return;
    }

    const pauseMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/pause$/);
    if (req.method === "POST" && pauseMatch) {
      const id = pauseMatch[1];
      const target = accounts.get(id);
      if (target) { target.paused = !target.paused; saveAccounts(); console.log(`  [${id}] ${target.paused ? "Paused" : "Resumed"}`); }
      res.writeHead(302, { Location: `/?a=${id}` });
      res.end();
      return;
    }

    const delMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/delete$/);
    if (req.method === "POST" && delMatch) {
      const id = delMatch[1];
      if (id !== "default" && accounts.has(id)) { accounts.delete(id); saveAccounts(); console.log(`  [${id}] Deleted`); }
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    const cfgMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/config$/);
    if (req.method === "POST" && cfgMatch) {
      const id = cfgMatch[1];
      const target = accounts.get(id);
      if (!target) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const cfg = target.config;
        if (params.has("baseRiskPct")) cfg.baseRiskPct = parseFloat(params.get("baseRiskPct")) / 100;
        if (params.has("profitTarget")) cfg.profitTarget = parseFloat(params.get("profitTarget")) / 100;
        if (params.has("stopLoss")) cfg.stopLoss = parseFloat(params.get("stopLoss")) / 100;
        if (params.has("goal")) cfg.goal = parseFloat(params.get("goal")) || cfg.goal;
        if (params.get("maxPositions")) cfg.maxPositions = parseInt(params.get("maxPositions")) || null;
        else cfg.maxPositions = null;
        if (params.has("minSetupQuality")) cfg.minSetupQuality = parseInt(params.get("minSetupQuality")) ?? 50;
        cfg.customPromptSuffix = params.get("customPromptSuffix") || "";
        target.riskPct = cfg.baseRiskPct * (target.currentRegime?.riskScale || 0.5);
        saveAccounts();
        console.log(`  [${id}] Config updated: risk=${(cfg.baseRiskPct * 100).toFixed(1)}% target=${(cfg.profitTarget * 100)}% stop=${(cfg.stopLoss * 100)}% minQuality=${cfg.minSetupQuality}`);
        res.writeHead(302, { Location: `/?a=${id}` });
        res.end();
      });
      return;
    }

    if (pathname === "/api/accounts" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const list = [];
      for (const [id, a] of accounts) {
        const pv = portfolioValue(a.state, a.dashboard.quotes);
        list.push({ id, name: a.name, paused: a.paused, cash: a.state.cash, positions: a.state.positions.length, trades: a.state.history.length, pv, pnl: ((pv - a.config.startingCash) / a.config.startingCash * 100).toFixed(1), config: a.config });
      }
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/global") {
      let totalPV = 0, totalPositions = 0, totalTrades = 0;
      for (const [, a] of accounts) { totalPV += portfolioValue(a.state, a.dashboard.quotes); totalPositions += a.state.positions.length; totalTrades += a.state.history.length; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ accounts: accounts.size, totalPV, totalPositions, totalTrades, claudeCalls: claudeCallCount, claudeCost: getClaudeCost() }));
      return;
    }

    // ─── Existing routes (scoped to activeAcct) ───

    if (req.method === "POST" && pathname === "/hint") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const hintText = params.get("hint");
        if (hintText) {
          log(activeAcct, `HINT (via dashboard): "${hintText}"`);
          // Process hint directly via Claude instead of file
          try {
            const result = await processHint(hintText, activeAcct);
            if (result) applyHintResult(activeAcct, result);
          } catch (e) {
            log(activeAcct, `HINT ERROR: ${e.message}`);
          }
        }
        res.writeHead(302, { Location: `/?a=${acctId}` });
        res.end();
      });
      return;
    }

    const tickerMatch = pathname.match(/^\/ticker\/([A-Z]+)$/);
    if (tickerMatch) {
      const sym = tickerMatch[1];
      try {
        if (!dashboard.candles[sym] && apiKey) dashboard.candles[sym] = await fetchCandles(sym, apiKey);
        if (!dashboard.quotes[sym] && apiKey) dashboard.quotes[sym] = await fetchQuote(sym, apiKey);
        if (dashboard.candles[sym] && !dashboard.analyses[sym]) {
          const a = runAnalysis(dashboard.candles[sym]); if (a) dashboard.analyses[sym] = a;
          const st = runShortTermAnalysis(dashboard.candles[sym]); if (st) dashboard.shortTermAnalyses[sym] = st;
        }
      } catch (e) { log(activeAcct, `WARN: On-demand fetch for ${sym} failed — ${e.message}`); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(tickerDetailHTML(sym, activeAcct));
      return;
    }

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ cash: state.cash, positions: state.positions, history: state.history.slice(-50), dayTrades: state.dayTrades, quotes: dashboard.quotes, analyses: Object.fromEntries(Object.entries(dashboard.analyses).map(([k, v]) => [k, { score: v.score, signal: v.signal, price: v.price, rsi: v.rsi }])), activeHints: activeAcct.activeHints, portfolioValue: portfolioValue(state, dashboard.quotes), marketOpen: dashboard.marketOpen, log: dashboard.cycleLog.slice(-50) }));
      return;
    }

    if (pathname === "/api/live") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const tickers = {};
      for (const [sym, q] of Object.entries(dashboard.quotes)) {
        const a = dashboard.analyses[sym]; const st = dashboard.shortTermAnalyses[sym];
        const pos = state.positions.find(p => p.ticker === sym);
        let posPnl = null;
        if (pos) { const spot = q ? q.c : pos.entrySpot; const elapsed = (Date.now() - pos.openTime) / 86400_000; const dteLeft = Math.max(0, pos.dte - elapsed); const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type); posPnl = { pct: ((curPremium - pos.entryPremium) / pos.entryPremium * 100).toFixed(1), dollar: ((curPremium - pos.entryPremium) * pos.qty * 100).toFixed(0) }; }
        tickers[sym] = { c: q.c, pc: q.pc, d: q.d, dp: q.dp, h: q.h, l: q.l, score: a?.score, signal: a?.signal, stScore: st?.score, mom1d: st?.mom1d, mom3d: st?.mom3d, mom7d: st?.mom7d, held: !!pos, type: pos?.type, posPnl };
      }
      res.end(JSON.stringify({ tickers, pv: portfolioValue(state, dashboard.quotes), cash: state.cash, open: state.positions.length, marketOpen: dashboard.marketOpen, lastCycle: dashboard.lastCycle }));
      return;
    }

    // Dashboard HTML
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHTML(activeAcct));
  });

  server.listen(DASH_PORT, () => { console.log(`  Dashboard running at http://localhost:${DASH_PORT}`); });
  server.on("error", (e) => { if (e.code === "EADDRINUSE") { console.log(`  WARN: Port ${DASH_PORT} in use, trying ${DASH_PORT + 1}`); server.listen(DASH_PORT + 1); } });
}

// ─── Shared Market Data Fetch (rate limit protection) ───

async function fetchSharedMarketData(apiKey, sharedCandleCache) {
  // Collect union of all accounts' tickers
  const allTickers = new Set();
  for (const [, acct] of accounts) {
    if (acct.paused) continue;
    // Refresh watchlist for each account first
    await refreshWatchlist(acct);
    for (const t of getActiveTickers(acct)) allTickers.add(t);
    // Also include position tickers
    for (const p of acct.state.positions) allTickers.add(p.ticker);
  }

  const tickerList = [...allTickers];
  const sharedQuotes = {};

  // Fetch quotes once for all tickers
  for (const ticker of tickerList) {
    try {
      sharedQuotes[ticker] = await fetchQuote(ticker, apiKey);
      await delay(API_DELAY);
    } catch (e) { }
  }

  // Fetch candles for tickers not already cached
  for (const ticker of tickerList) {
    if (!sharedCandleCache[ticker]) {
      try {
        sharedCandleCache[ticker] = await fetchCandles(ticker, apiKey);
        await delay(API_DELAY);
      } catch (e) { }
    } else if (sharedQuotes[ticker]) {
      // Update latest candle with current quote
      const q = sharedQuotes[ticker];
      const last = sharedCandleCache[ticker][sharedCandleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }

  return { sharedQuotes, tickerList };
}

// ─── Main Trading Cycle ───

async function runCycle(acct, sharedQuotes, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  log(acct, "MARKET OPEN — Starting auto-trade cycle");
  dash.marketOpen = true;

  const quotes = {};
  const analyses = {};

  const activeTickers = getActiveTickers(acct);
  const positionTickers = state.positions.map(p => p.ticker).filter(t => !activeTickers.includes(t));
  const allTickers = [...activeTickers, ...positionTickers];

  // Use shared quotes (fetched once for all accounts)
  for (const ticker of allTickers) {
    if (sharedQuotes[ticker]) quotes[ticker] = sharedQuotes[ticker];
  }

  // Update candle cache latest values from quotes
  for (const ticker of allTickers) {
    if (acct.candleCache[ticker] && quotes[ticker]) {
      const q = quotes[ticker];
      const last = acct.candleCache[ticker][acct.candleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }

  await refreshWatchlist(acct);
  await checkHints(acct);
  await runNewsScan(acct, apiKey);

  const shortTermAnalyses = {};
  const decisions = [];
  for (const ticker of allTickers) {
    const candles = acct.candleCache[ticker];
    if (!candles) { decisions.push({ ticker, action: "SKIP", reason: "No candle data" }); continue; }
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) { decisions.push({ ticker, action: "SKIP", reason: "Insufficient data (<55 candles)" }); continue; }

    if (st) shortTermAnalyses[ticker] = st;

    const blended = blendScores(a, st);
    const effectiveScore = blended.score;

    const hintBias = getHintBias(acct, ticker);
    const rawScore = effectiveScore;
    let finalScore = effectiveScore;
    if (hintBias !== 0) {
      finalScore = Math.max(0, Math.min(100, effectiveScore + hintBias));
      a.hintBoosted = true;
    }
    a.score = finalScore;
    a.signal = signalLabel(finalScore);
    a.blendedRaw = effectiveScore;
    a.shortTermScore = st ? st.score : null;
    a.longTermScore = a.score !== finalScore ? rawScore : a.score;
    analyses[ticker] = a;

    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    const stTag = st ? ` (7d:${st.score} 90d:${a.blendedRaw !== undefined ? Math.round(a.bullScore * 0.5 + 50 - a.bearScore * 0.5) : '?'})` : "";
    log(acct, `${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag}${stTag} | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    const dec = { ticker, price: q?.c, rawScore, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    const lowCash = state.cash < cfg.startingCash;

    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = a ? Math.round(50 + (a.bullScore - a.bearScore) / 2) : null;
    dec.blendedScore = effectiveScore;

    if (finalScore >= cfg.bullEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY CALL"; dec.reason = `Bullish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else if (finalScore <= cfg.bearEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY PUT"; dec.reason = `Bearish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else {
      dec.action = "WAIT";
      if (finalScore >= 55) dec.reason = `Score ${finalScore} — leaning bullish but need >=${cfg.bullEntry} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else if (finalScore >= 45) dec.reason = `Score ${finalScore} — neutral (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else dec.reason = `Score ${finalScore} — leaning bearish but need <=${cfg.bearEntry} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.stEma3 = st?.ema3v?.toFixed(2); dec.stEma5 = st?.ema5v?.toFixed(2); dec.stEma8 = st?.ema8v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.stRsi = st?.rsi?.toFixed(1);
    dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.mom1d = st?.mom1d?.toFixed(2); dec.mom3d = st?.mom3d?.toFixed(2); dec.mom7d = st?.mom7d?.toFixed(2);
    dec.signals = [...(a.sigs?.map(s => s.text) || []), ...(st?.sigs?.map(s => `[7d] ${s.text}`) || [])];
    decisions.push(dec);
  }
  dash.decisions = decisions;
  dash.shortTermAnalyses = shortTermAnalyses;

  cleanDayTrades(state);

  const regime = getMarketRegime(acct.candleCache);
  acct.currentRegime = regime;
  acct.riskPct = cfg.baseRiskPct * regime.riskScale;
  log(acct, `REGIME: ${regime.label} | Risk: ${(acct.riskPct * 100).toFixed(1)}% per trade (${regime.riskScale}x base)`);

  tryTimeBasedExits(acct, quotes);
  tryExits(acct, quotes);
  trySignalExits(acct, quotes, analyses);
  tryEMATrailingExits(acct, quotes);

  for (const ticker of activeTickers) {
    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;

    const result = await tryEntry(acct, ticker, a, q, regime, apiKey);
    if (result && result.skipped) {
      log(acct, `SKIP ${ticker}: ${result.reason}`);
      const dec = decisions.find(d => d.ticker === ticker);
      if (dec && (dec.action === "BUY CALL" || dec.action === "BUY PUT")) {
        dec.action = "BLOCKED";
        dec.reason = result.reason;
      }
    } else if (result && result.ticker) {
      log(acct, `TRADE: BUY ${result.qty}x ${result.ticker} $${result.strike} ${result.type.toUpperCase()} ${result.dte}d @ $${result.entryPremium.toFixed(2)} ($${result.cost.toFixed(0)}) [setup:${result.setupQuality}/100 claude:${result.claudeConfidence}%]`);
      // Tweet trade entry with chart
      const a = analyses[ticker];
      const st = shortTermAnalyses[ticker];
      const q = quotes[ticker];
      tweetTradeEntry(acct, result, a, st, q).catch(e => console.log(`  [X] Entry tweet error: ${e.message}`));
    }
  }

  dash.positionDetails = buildPositionDetails(acct, quotes);

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  const progress = ((pv / cfg.goal) * 100).toFixed(1);
  log(acct, `Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Goal: ${progress}% of $${cfg.goal.toLocaleString()} | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | ${countRecentDayTrades(state)}/3 PDT | ${regime.mode.toUpperCase()}${getActiveHintsSummary(acct)}`);

  // Tweet daily watchlist summary (once per day)
  tweetWatchlistSummary(acct, decisions, regime).catch(e => console.log(`  [X] Watchlist tweet error: ${e.message}`));

  dash.quotes = quotes;
  dash.analyses = analyses;
  dash.shortTermAnalyses = shortTermAnalyses;
  dash.candles = acct.candleCache;
  dash.lastCycle = Date.now();

  dash.portfolioHistory = dash.portfolioHistory || [];
  dash.portfolioHistory.push({ ts: Date.now(), value: pv });
  if (dash.portfolioHistory.length > 500) dash.portfolioHistory.shift();

  saveAccounts();
}

function buildPositionDetails(acct, quotes) {
  const state = acct.state;
  const cfg = acct.config;
  return state.positions.map(pos => {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const elapsed = (Date.now() - pos.openTime) / 86400_000;
    const dteLeft = Math.max(0, pos.dte - elapsed);
    const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type);
    const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
    const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;
    const profitPrice = pos.entryPremium * (1 + cfg.profitTarget);
    const stopLossPrice = pos.entryPremium * (1 + cfg.stopLoss);
    const isDayTrade = pos.openDate === getETDateStr();
    const pdtStatus = isDayTrade ? `Day trade (${countRecentDayTrades(state)}/3 used)` : "Swing (not a day trade)";

    let effectiveStop;
    if ((pos.trimLevel || 0) >= 2) effectiveStop = pos.entryPremium * 1.15;
    else if ((pos.trimLevel || 0) >= 1) effectiveStop = pos.entryPremium;
    else effectiveStop = stopLossPrice;

    return {
      ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
      profitTarget: { pct: `+${(cfg.profitTarget * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
      stopLoss: { pct: `${(cfg.stopLoss * 100).toFixed(0)}%`, premium: effectiveStop.toFixed(2) },
      pctToProfit: ((profitPrice - curPremium) / curPremium * 100).toFixed(1),
      pctToStop: ((effectiveStop - curPremium) / curPremium * 100).toFixed(1),
      pdtStatus,
      greeks: optGreeks(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type),
    };
  });
}

// ─── After-Hours Scan (analysis only, no trades) ───

async function runAfterHoursScan(acct, sharedQuotes, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  log(acct, "AFTER-HOURS SCAN — Fetching data for analysis (no trades)");

  const quotes = {};
  const analyses = {};
  const shortTermAnalyses = {};

  const activeTickers2 = getActiveTickers(acct);
  const positionTickers2 = state.positions.map(p => p.ticker).filter(t => !activeTickers2.includes(t));
  const allTickers2 = [...activeTickers2, ...positionTickers2];

  // Use shared quotes
  for (const ticker of allTickers2) {
    if (sharedQuotes[ticker]) quotes[ticker] = sharedQuotes[ticker];
  }

  await refreshWatchlist(acct);
  await checkHints(acct);
  await runNewsScan(acct, apiKey);

  const decisions = [];
  for (const ticker of allTickers2) {
    const candles = acct.candleCache[ticker];
    if (!candles) { decisions.push({ ticker, action: "SKIP", reason: "No candle data" }); continue; }
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) { decisions.push({ ticker, action: "SKIP", reason: "Insufficient data" }); continue; }

    if (st) shortTermAnalyses[ticker] = st;

    const blended = blendScores(a, st);
    const hintBias = getHintBias(acct, ticker);
    let finalScore = blended.score;
    if (hintBias !== 0) {
      finalScore = Math.max(0, Math.min(100, finalScore + hintBias));
      a.hintBoosted = true;
    }
    a.score = finalScore;
    a.signal = signalLabel(finalScore);
    a.blendedRaw = blended.score;
    a.shortTermScore = st ? st.score : null;
    analyses[ticker] = a;

    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    log(acct, `${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag} (7d:${st?.score ?? '?'}) | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    const dec = { ticker, price: q?.c, rawScore: blended.score, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = Math.round(50 + (a.bullScore - a.bearScore) / 2);
    dec.blendedScore = blended.score;
    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;

    if (finalScore >= cfg.bullEntry) {
      dec.action = alreadyHeld ? "HOLD" : "PLAN BUY CALL";
      dec.reason = alreadyHeld ? "Already in position" : `Bullish ${finalScore}/100 — will buy at open (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    } else if (finalScore <= cfg.bearEntry) {
      dec.action = alreadyHeld ? "HOLD" : "PLAN BUY PUT";
      dec.reason = alreadyHeld ? "Already in position" : `Bearish ${finalScore}/100 — will buy at open (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    } else {
      dec.action = "WATCH";
      dec.reason = `Score ${finalScore} — monitoring (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.stEma3 = st?.ema3v?.toFixed(2); dec.stEma5 = st?.ema5v?.toFixed(2); dec.stEma8 = st?.ema8v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.stRsi = st?.rsi?.toFixed(1);
    dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.mom1d = st?.mom1d?.toFixed(2); dec.mom3d = st?.mom3d?.toFixed(2); dec.mom7d = st?.mom7d?.toFixed(2);
    dec.signals = [...(a.sigs?.map(s => s.text) || []), ...(st?.sigs?.map(s => `[7d] ${s.text}`) || [])];
    decisions.push(dec);
  }

  dash.positionDetails = buildPositionDetails(acct, quotes);
  dash.quotes = quotes;
  dash.analyses = analyses;
  dash.shortTermAnalyses = shortTermAnalyses;
  dash.candles = acct.candleCache;
  dash.decisions = decisions;
  dash.lastCycle = Date.now();

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  log(acct, `AFTER-HOURS — Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open${getActiveHintsSummary(acct)}`);
}

// ─── Main Loop ───

async function main() {
  console.log("\n  ╔═══════════════════════════════════════════════╗");
  console.log("  ║  Swing Trader — Auto-Trading Bot v1.0         ║");
  console.log("  ║  Multi-Account · Dynamic Watchlist · PDT      ║");
  console.log("  ║  Headless · Finnhub · Aggressive Mode          ║");
  console.log("  ╚═══════════════════════════════════════════════╝\n");

  // Force reset: wipe accounts file so loadAccounts creates fresh default
  if (process.env.FORCE_RESET_STATE === "true") {
    try { fs.unlinkSync(ACCOUNTS_FILE); } catch { }
    try { fs.unlinkSync(STATE_FILE); } catch { }
    console.log("  FORCE RESET: Wiped state files. Starting fresh.\n");
  }

  // Load accounts (migrates from legacy state.json if needed)
  loadAccounts();

  // Get API key from env or first account's state, or prompt
  let apiKey = process.env.FINNHUB_API_KEY || "";
  if (!apiKey) {
    // Check if any account has a stored key
    for (const [, acct] of accounts) {
      if (acct.state.apiKey) { apiKey = acct.state.apiKey; break; }
    }
  }
  if (!apiKey) {
    console.log("  No API key found. Get a free key at https://finnhub.io/\n");
    const key = await prompt("  Enter Finnhub API key: ");
    if (!key) { console.log("  No key provided. Exiting."); process.exit(1); }
    console.log("  Validating API key...");
    const valid = await validateKey(key);
    if (!valid) { console.log("  Invalid API key. Exiting."); process.exit(1); }
    apiKey = key;
  } else {
    console.log("  Validating API key...");
    const valid = await validateKey(apiKey);
    if (!valid) { console.log("  Stored API key is invalid. Exiting."); process.exit(1); }
    console.log("  API key valid.\n");
  }

  // Log Claude API key status
  if (CLAUDE_API_KEY) {
    console.log(`  Claude API key: ${CLAUDE_API_KEY.slice(0, 12)}...${CLAUDE_API_KEY.slice(-4)} (${CLAUDE_API_KEY.length} chars)`);
  } else {
    console.log("  WARNING: No CLAUDE_API_KEY set — news scans and entry validation will fail");
  }

  // Initialize X/Twitter client
  xClient = initTwitterClient();
  if (ENABLE_TWEETS && xClient) {
    console.log(`  X/Twitter: LIVE mode — tweets enabled (cap: ${X_DAILY_CAP}/day)`);
  } else if (!ENABLE_TWEETS) {
    console.log("  X/Twitter: DRY-RUN mode — set ENABLE_TWEETS=true to post live");
  }

  // Store apiKey in each account state for backwards compat
  for (const [, acct] of accounts) acct.state.apiKey = apiKey;

  // Log account info
  for (const [id, acct] of accounts) {
    console.log(`  [${id}] ${acct.name} — Cash: $${acct.state.cash.toFixed(0)} | ${acct.state.positions.length} positions | ${acct.state.history.length} trades`);
  }
  console.log("");

  // Get primary account for dashboard (first account)
  const primaryAcct = accounts.values().next().value;

  // Start web dashboard  
  startDashboard(primaryAcct, apiKey);

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      console.log(`\n  Received ${sig} — saving all accounts and exiting...`);
      saveAccounts();
      process.exit(0);
    });
  }

  let sharedCandleCache = {};
  let lastCandleDate = null;
  let lastCycleTime = Date.now();

  // Run initial scan immediately on startup
  console.log("  Running startup scan...\n");
  try {
    const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
    // Copy shared candles into each account's cache
    for (const [, acct] of accounts) {
      Object.assign(acct.candleCache, sharedCandleCache);
    }
    for (const [, acct] of accounts) {
      if (acct.paused) continue;
      await runAfterHoursScan(acct, sharedQuotes, apiKey);
    }
  } catch (e) {
    console.log(`  WARN: Startup scan failed — ${e.message}`);
  }

  // Main loop
  while (true) {
    const gap = Date.now() - lastCycleTime;
    if (gap > 5 * 60_000) {
      console.log(`  WAKE DETECTED — ${(gap / 60_000).toFixed(0)}m gap. Re-syncing...`);
      sharedCandleCache = {};
      for (const [, acct] of accounts) acct.candleCache = {};
    }
    lastCycleTime = Date.now();

    if (isMarketOpen()) {
      const today = getETDateStr();
      if (lastCandleDate !== today) {
        sharedCandleCache = {};
        for (const [, acct] of accounts) acct.candleCache = {};
        lastCandleDate = today;
      }

      try {
        const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
        // Sync shared candles into each account's cache
        for (const [, acct] of accounts) {
          for (const [ticker, candles] of Object.entries(sharedCandleCache)) {
            if (!acct.candleCache[ticker]) acct.candleCache[ticker] = candles;
          }
        }

        for (const [, acct] of accounts) {
          if (acct.paused) continue;
          try {
            await runCycle(acct, sharedQuotes, apiKey);
          } catch (e) {
            log(acct, `ERROR in cycle: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`  ERROR in shared fetch: ${e.message}`);
      }

      saveAccounts();
      console.log("");
      await delay(CYCLE_MS);
    } else {
      // After hours
      try {
        const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
        for (const [, acct] of accounts) {
          for (const [ticker, candles] of Object.entries(sharedCandleCache)) {
            if (!acct.candleCache[ticker]) acct.candleCache[ticker] = candles;
          }
        }

        for (const [, acct] of accounts) {
          if (acct.paused) continue;
          await runAfterHoursScan(acct, sharedQuotes, apiKey);
        }
      } catch (e) {
        console.log(`  WARN: After-hours scan failed — ${e.message}`);
      }

      saveAccounts();
      await delay(900_000); // 15 min after hours
    }
  }
}


// ─── Start ───
main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
