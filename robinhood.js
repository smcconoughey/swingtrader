/**
 * robinhood.js — Robinhood Agentic Trading MCP Client (Equity + Options)
 *
 * Communicates with Robinhood's official MCP server over Streamable HTTP.
 * MCP = Model Context Protocol (JSON-RPC 2.0 over HTTP).
 *
 * Supports equity AND options trading via MCP tools. Tool availability is
 * auto-detected at init via tools/list. Use RH_OPTIONS_ONLY (bot.js) to disable
 * equity fallback when options tools are available.
 *
 * Auth: OAuth tokens cached by mcp-remote in ~/.mcp-auth/, or ROBINHOOD_ACCESS_TOKEN env var.
 */

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import {
  robinhoodAccountAllowlistFromEnv,
  selectRobinhoodTradingAccount,
} from "./live-broker-safety.js";

// ─── Configuration ───

const MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const OAUTH_META_URL = "https://agent.robinhood.com/.well-known/oauth-authorization-server";
const TOKEN_FILE = "rh_tokens.json";
// Robinhood's legacy public app client_id. Only valid for tokens minted by the classic
// api.robinhood.com OAuth flow — NOT for tokens from agent.robinhood.com dynamic client
// registration (those must refresh with their own registered client_id). Last-resort fallback.
const LEGACY_CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBbFS";
const LEGACY_TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";

// ─── State ───

let accessToken = null;
let refreshToken = null;
// OAuth client identity the tokens were minted under. The agentic OAuth flow uses dynamic
// client registration, so each auth run gets a fresh client_id — refresh_token grants are
// only honored for that same client_id, which is why these must be persisted with the tokens.
let oauthClientId = null;
let oauthTokenEndpoint = null;
let sessionId = null;
let mcpInitialized = false;
let discoveredAccountNumber = null;
let discoveredTools = new Set();
let discoveredToolSchemas = new Map();
let optionsSupported = false;
let lastInitError = null;

// `mcpInitialized` only records that the initialize handshake once succeeded; it does not prove
// the session or broker authorization is still usable. Keep explicit probe state so callers can
// distinguish a fresh read-only broker check from that cached transport flag.
let healthStatus = "unknown";
let lastHealthCheckAt = null;
let lastHealthSuccessAt = null;
let lastHealthFailureAt = null;
let lastHealthError = null;
let healthCheckInProgress = null;

function robinhoodAccountRows(raw) {
  const body = raw?.data ?? raw;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.accounts)) return body.accounts;
  if (Array.isArray(body?.results)) return body.results;
  if (body && typeof body === "object" && (body.account_number || body.account_id)) return [body];
  return [];
}

function selectedRobinhoodAccount(raw) {
  return selectRobinhoodTradingAccount(robinhoodAccountRows(raw), {
    allowlist: robinhoodAccountAllowlistFromEnv(process.env),
  });
}

// ─── Token Refresh ───

let refreshInProgress = null;

// Resolve the token endpoint for refresh: prefer the endpoint stored alongside the tokens,
// then the live OAuth metadata, then the legacy endpoint as a last resort.
async function resolveTokenEndpoint() {
  if (oauthTokenEndpoint) return oauthTokenEndpoint;
  try {
    const res = await fetch(OAUTH_META_URL);
    if (res.ok) {
      const meta = await res.json();
      if (meta.token_endpoint) {
        oauthTokenEndpoint = meta.token_endpoint;
        return oauthTokenEndpoint;
      }
    }
  } catch { }
  return LEGACY_TOKEN_ENDPOINT;
}

async function tryRefreshToken() {
  if (!refreshToken) return false;
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    try {
      console.log("  [RH] Access token expired — attempting refresh...");
      const endpoint = await resolveTokenEndpoint();
      const clientId = oauthClientId || LEGACY_CLIENT_ID;
      if (!oauthClientId) {
        console.log("  [RH] WARN: no OAuth client_id stored with tokens — refreshing with the legacy app id. If this token came from the agentic OAuth flow, refresh will fail; re-auth from the dashboard to store the client_id.");
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastInitError = `Token refresh failed (HTTP ${res.status}) — re-authenticate from the dashboard`;
        console.log(`  [RH] Token refresh failed: HTTP ${res.status} @ ${endpoint} (client ${clientId.slice(0, 8)}...) — ${errText.slice(0, 200)}`);
        return false;
      }

      const data = await res.json();
      if (data.access_token) {
        accessToken = data.access_token;
        if (data.refresh_token) refreshToken = data.refresh_token;
        saveTokens();
        sessionId = null;
        mcpInitialized = false;
        discoveredAccountNumber = null;
        console.log("  [RH] Token refreshed successfully");
        return true;
      }
      return false;
    } catch (e) {
      console.log(`  [RH] Token refresh error: ${e.message}`);
      return false;
    } finally {
      refreshInProgress = null;
    }
  })();
  return refreshInProgress;
}

// ─── MCP Transport Layer ───

let rpcId = 1;

async function mcpCall(method, params = {}, _retried = false) {
  if (!accessToken) throw new Error("Robinhood not authenticated. Set ROBINHOOD_ACCESS_TOKEN or connect via mcp-remote.");

  const body = {
    jsonrpc: "2.0",
    id: rpcId++,
    method,
    params,
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`,
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response headers
  const newSessionId = res.headers.get("mcp-session-id");
  if (newSessionId) sessionId = newSessionId;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");

    // Auto-refresh on 401/403 and retry once
    if ((res.status === 401 || res.status === 403) && !_retried && refreshToken) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        // Re-init and re-authorize the account with the refreshed in-memory token. Never retry a
        // broker call when strict account discovery failed, and do not reload a stale env token.
        if (method !== "initialize") {
          let reinitialized = false;
          try { reinitialized = await robinhood.init({ reload: false }); } catch { }
          if (!reinitialized) {
            throw new Error(`Robinhood token refreshed but account re-authorization failed: ${lastInitError || "unknown error"}`);
          }
          assertSelectedAccountArgs(params?.arguments || {});
        }
        return mcpCall(method, params, true);
      }
    }

    throw new Error(`MCP HTTP ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // Handle SSE responses (text/event-stream)
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          lastData = JSON.parse(line.slice(6));
        } catch { }
      }
    }
    if (lastData?.result) return lastData.result;
    if (lastData?.error) throw new Error(`MCP error: ${JSON.stringify(lastData.error)}`);
    return lastData;
  }

  // Handle standard JSON-RPC response
  const json = await res.json();
  if (json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

// ─── MCP Tool Calls ───

function assertSelectedAccountArgs(args = {}) {
  if (!Object.prototype.hasOwnProperty.call(args, "account_number")) return;
  const requested = args.account_number == null ? "" : String(args.account_number);
  if (!discoveredAccountNumber || requested !== String(discoveredAccountNumber)) {
    throw new Error(
      `Robinhood account safety block: tool requested ${requested || "no account"}, selected ${discoveredAccountNumber || "none"}`,
    );
  }
}

async function callTool(toolName, args = {}) {
  assertSelectedAccountArgs(args);
  return mcpCall("tools/call", {
    name: toolName,
    arguments: args,
  });
}

function schemaAccepts(toolName, prop) {
  const schema = discoveredToolSchemas.get(toolName);
  if (!schema || !schema.properties) return true;
  return prop in schema.properties;
}

function buildSchemaArgs(toolName, candidateArgs) {
  const schema = discoveredToolSchemas.get(toolName);
  if (!schema || !schema.properties) return candidateArgs;
  const filtered = {};
  for (const [k, v] of Object.entries(candidateArgs)) {
    if (k in schema.properties && v !== undefined && v !== null) filtered[k] = v;
  }
  return filtered;
}

function idempotencySchemaError(toolName) {
  const error = new Error(
    `Robinhood safety block: discovered ${toolName} schema does not accept ref_id; `
    + "refusing to place an option order whose idempotency key would be discarded",
  );
  error.code = "RH_IDEMPOTENCY_UNSUPPORTED";
  error.idempotencyUnsupported = true;
  return error;
}

// Find the first discovered tool whose name matches any of the given regexes, tried in order.
// Lets us bind to whatever the MCP server actually named a tool instead of hardcoding guesses.
function findTool(...patterns) {
  for (const pat of patterns) {
    for (const name of discoveredTools) {
      if (pat.test(name)) return name;
    }
  }
  return null;
}

function extractContent(result) {
  // MCP tool results come as { content: [{ type: "text", text: "..." }] }
  if (!result?.content) return result;
  const textParts = result.content.filter(c => c.type === "text");
  const combined = textParts.map(c => c.text).join("\n");
  // Per the MCP spec, a failed tool execution (e.g. Robinhood rejecting an order — insufficient
  // buying power, invalid instrument, etc.) is signaled via isError:true on an otherwise-normal
  // 200/JSON-RPC-success response, NOT a thrown transport error. mcpCall() only throws on HTTP/
  // JSON-RPC-level failures, so without this check a broker-side order rejection was silently
  // returned as if it were a successful placement — callers never entered their catch block, so
  // cash got decremented and a "trade placed" push notification fired for an order that never
  // reached Robinhood.
  if (result.isError) {
    const error = new Error(combined || "Robinhood MCP tool call failed (isError, no detail text)");
    error.brokerRejected = true;
    throw error;
  }
  if (textParts.length === 0) return result;
  try { return JSON.parse(combined); } catch { return combined; }
}

// ─── OCC Symbol Helpers ───

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

function parseOCC(occ) {
  const m = (occ || "").toUpperCase().match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, ticker, yy, mm, dd, cp, strikeStr] = m;
  return {
    ticker,
    expiration: `20${yy}-${mm}-${dd}`,
    type: cp === "C" ? "call" : "put",
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

// ─── Token Loading ───

function loadTokens() {
  // OAuth client identity can come from env regardless of where the tokens come from.
  oauthClientId = (process.env.ROBINHOOD_CLIENT_ID || "").trim() || oauthClientId;
  oauthTokenEndpoint = (process.env.ROBINHOOD_TOKEN_ENDPOINT || "").trim() || oauthTokenEndpoint;

  // Priority 1: env var
  const envToken = (process.env.ROBINHOOD_ACCESS_TOKEN || "").trim();
  if (envToken) {
    accessToken = envToken;
    refreshToken = (process.env.ROBINHOOD_REFRESH_TOKEN || "").trim() || null;
    // Even with env tokens, pick up a persisted client_id/endpoint (from a prior dashboard auth)
    // so refresh still works when ROBINHOOD_CLIENT_ID isn't set.
    try {
      if (!oauthClientId && fs.existsSync(TOKEN_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
        oauthClientId = data.clientId || null;
        oauthTokenEndpoint = oauthTokenEndpoint || data.tokenEndpoint || null;
      }
    } catch { }
    return true;
  }

  // Priority 2: local token file (written by bot dashboard)
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (data.accessToken) {
        accessToken = data.accessToken;
        refreshToken = data.refreshToken || null;
        oauthClientId = oauthClientId || data.clientId || null;
        oauthTokenEndpoint = oauthTokenEndpoint || data.tokenEndpoint || null;
        return true;
      }
    }
  } catch { }

  // Priority 3: mcp-remote cached tokens (from Cursor MCP connection)
  try {
    const mcpAuthDir = path.join(os.homedir(), ".mcp-auth");
    if (fs.existsSync(mcpAuthDir)) {
      const dirs = fs.readdirSync(mcpAuthDir).filter(d => d.startsWith("mcp-remote"));
      for (const dir of dirs) {
        const dirPath = path.join(mcpAuthDir, dir);
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith("_tokens.json"));
        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8"));
            if (data.access_token) {
              accessToken = data.access_token;
              refreshToken = data.refresh_token || null;
              console.log(`  [RH] Loaded token from mcp-remote cache: ${dir}/${file}`);
              saveTokens();
              return true;
            }
          } catch { }
        }
      }
    }
  } catch { }

  return false;
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      accessToken,
      refreshToken,
      // Persist the OAuth client identity so refresh_token grants work across restarts.
      clientId: oauthClientId,
      tokenEndpoint: oauthTokenEndpoint,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.error(`  [RH] Failed to save tokens: ${e.message}`);
  }
}

// ─── Public API ───

const robinhood = {
  get isConnected() { return !!accessToken && mcpInitialized; },
  get isAuthenticated() { return !!accessToken; },
  get accountNumber() { return discoveredAccountNumber; },
  get optionsEnabled() { return optionsSupported; },
  get availableTools() { return [...discoveredTools]; },
  get toolSchemas() { return Object.fromEntries(discoveredToolSchemas); },
  // Option-related tool names + their input-param names, for diagnostics.
  get optionToolInfo() {
    const info = {};
    for (const name of discoveredTools) {
      if (!/option/i.test(name)) continue;
      const schema = discoveredToolSchemas.get(name);
      info[name] = schema?.properties ? Object.keys(schema.properties) : [];
    }
    return info;
  },
  get lastInitError() { return lastInitError; },
  get healthStatus() { return healthStatus; },
  get lastHealthCheckAt() { return lastHealthCheckAt; },
  get lastHealthSuccessAt() { return lastHealthSuccessAt; },
  get lastHealthFailureAt() { return lastHealthFailureAt; },
  get lastHealthError() { return lastHealthError; },
  get health() {
    return {
      status: healthStatus,
      checking: !!healthCheckInProgress,
      lastCheckAt: lastHealthCheckAt,
      lastSuccessAt: lastHealthSuccessAt,
      lastFailureAt: lastHealthFailureAt,
      error: lastHealthError,
      authenticated: !!accessToken,
      initialized: mcpInitialized,
      connected: !!accessToken && mcpInitialized,
      probe: "get_accounts",
    };
  },

  buildOCC,
  parseOCC,

  async init({ reload = true } = {}) {
    lastInitError = null;
    // Invalidate execution state before any token/account discovery work. Even a token-loading
    // failure must leave the client disconnected instead of retaining a prior account binding.
    discoveredAccountNumber = null;
    mcpInitialized = false;
    if (reload) {
      accessToken = null;
      sessionId = null;
    }
    if (reload || !accessToken) {
      if (!loadTokens()) {
        lastInitError = "No Robinhood token found";
        console.log("  [RH] No Robinhood token found. Set ROBINHOOD_ACCESS_TOKEN env var or connect via Cursor MCP.");
        return false;
      }
    }

    try {
      const initResult = await mcpCall("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "swingtrader-bot",
          version: "3.0.0",
        },
      });

      console.log("  [RH] MCP session initialized. Server:", initResult?.serverInfo?.name || "unknown");

      // Send initialized notification
      await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });

      mcpInitialized = true;

      // Discover available tools — detect options support dynamically
      try {
        const toolsResult = await mcpCall("tools/list", {});
        const toolsList = toolsResult?.tools || toolsResult || [];
        if (Array.isArray(toolsList)) {
          discoveredTools = new Set(toolsList.map(t => t.name || t));
          discoveredToolSchemas = new Map();
          for (const t of toolsList) {
            if (t.name && t.inputSchema) discoveredToolSchemas.set(t.name, t.inputSchema);
          }
          const optionTools = [...discoveredTools].filter(t => /option/i.test(t));
          optionsSupported = optionTools.length >= 2;
          console.log(`  [RH] Discovered ${discoveredTools.size} MCP tools.${optionsSupported ? ` OPTIONS ENABLED (${optionTools.join(", ")})` : " Options tools not found — equity only."}`);
          if (discoveredToolSchemas.size > 0) {
            const watchlistTools = [...discoveredToolSchemas.keys()].filter(n => /watchlist/i.test(n));
            if (watchlistTools.length > 0) {
              for (const wt of watchlistTools) {
                const schema = discoveredToolSchemas.get(wt);
                const props = schema?.properties ? Object.keys(schema.properties) : [];
                console.log(`  [RH]   ${wt} params: [${props.join(", ")}]`);
              }
            }
          }
        }
      } catch (e) {
        console.log(`  [RH] tools/list unavailable (${e.message}) — assuming equity only`);
      }

      // A process-global execution client must resolve to one explicitly authorized account. Never
      // fall back to "the first" account: profile ordering is not an authorization boundary.
      const accounts = await robinhood.getAccounts();
      const selection = selectedRobinhoodAccount(accounts);
      if (!selection.accountNumber) {
        throw new Error(`Robinhood account safety block: ${selection.reason}`);
      }
      discoveredAccountNumber = selection.accountNumber;
      console.log(`  [RH] Trading account selected (${selection.mode}): ${discoveredAccountNumber}`);

      console.log(`  [RH] Robinhood Agentic Trading connected ✓${optionsSupported ? " (equity + options)" : " (equity only)"}`);
      return true;
    } catch (e) {
      lastInitError = e.message;
      console.log(`  [RH] MCP init failed: ${e.message}`);
      mcpInitialized = false;
      return false;
    }
  },

  // Exercise a real, read-only broker tool call. A successful initialize handshake can outlive
  // the underlying MCP session, so consumers should use this probe for watchdog decisions instead
  // of treating `isConnected` as a perpetual health signal. Failures deliberately invalidate the
  // cached session and force a full init before trading resumes.
  async healthCheck() {
    if (healthCheckInProgress) return healthCheckInProgress;

    healthStatus = "checking";
    const checkPromise = (async () => {
      try {
        if (!accessToken) throw new Error("Robinhood not authenticated");
        const result = await callTool("get_accounts", {});
        const accounts = extractContent(result);
        if (!discoveredAccountNumber) {
          throw new Error("Robinhood trading account was not safely selected during initialization");
        }
        const selection = selectedRobinhoodAccount(accounts);
        if (!selection.accountNumber) throw new Error(`Robinhood account safety block: ${selection.reason}`);
        if (selection.accountNumber !== discoveredAccountNumber) {
          throw new Error(
            `Robinhood account safety block: probe selected ${selection.accountNumber}, expected ${discoveredAccountNumber}`,
          );
        }

        const checkedAt = Date.now();
        mcpInitialized = true;
        healthStatus = "healthy";
        lastHealthCheckAt = checkedAt;
        lastHealthSuccessAt = checkedAt;
        lastHealthError = null;
        return true;
      } catch (error) {
        const checkedAt = Date.now();
        mcpInitialized = false;
        sessionId = null;
        discoveredAccountNumber = null;
        healthStatus = "unhealthy";
        lastHealthCheckAt = checkedAt;
        lastHealthFailureAt = checkedAt;
        lastHealthError = error?.message || String(error);
        return false;
      }
    })();
    healthCheckInProgress = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (healthCheckInProgress === checkPromise) healthCheckInProgress = null;
    }
  },

  // Alias for callers that use probe-oriented naming. Retains the same boolean contract.
  async probe() {
    return this.healthCheck();
  },

  // ─── Account & Portfolio ───

  async getAccounts() {
    const result = await callTool("get_accounts");
    return extractContent(result);
  },

  async getPortfolio(accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number — call getAccounts() first");
    const result = await callTool("get_portfolio", { account_number: acctNum });
    return extractContent(result);
  },

  async getPositions(accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number — call getAccounts() first");
    const result = await callTool("get_equity_positions", { account_number: acctNum });
    return extractContent(result);
  },

  // ─── Market Data ───

  async getQuotes(symbols) {
    const syms = Array.isArray(symbols) ? symbols : [symbols];
    const result = await callTool("get_equity_quotes", { symbols: syms.map(s => s.toUpperCase()) });
    return extractContent(result);
  },

  async checkTradability(symbols, accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const syms = Array.isArray(symbols) ? symbols : [symbols];
    const result = await callTool("get_equity_tradability", {
      account_number: acctNum,
      symbols: syms.map(s => s.toUpperCase()),
    });
    return extractContent(result);
  },

  async search(query) {
    const result = await callTool("search", { query });
    return extractContent(result);
  },

  // ─── Equity Orders ───

  async getOrders(filters = {}, accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = buildSchemaArgs("get_equity_orders", { account_number: acctNum, ...filters });
    const result = await callTool("get_equity_orders", args);
    return extractContent(result);
  },

  async reviewEquityOrder({ symbol, side, type, quantity, dollarAmount, limitPrice, stopPrice, timeInForce, marketHours } = {}, accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = { account_number: acctNum, symbol: symbol.toUpperCase(), side, type };
    if (quantity) args.quantity = String(quantity);
    if (dollarAmount) args.dollar_amount = String(dollarAmount);
    if (limitPrice) args.limit_price = String(limitPrice);
    if (stopPrice) args.stop_price = String(stopPrice);
    if (timeInForce) args.time_in_force = timeInForce;
    if (marketHours) args.market_hours = marketHours;
    const result = await callTool("review_equity_order", args);
    return extractContent(result);
  },

  async placeEquityOrder({ symbol, side, type, quantity, dollarAmount, limitPrice, stopPrice, timeInForce, marketHours, refId } = {}, accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = {
      account_number: acctNum,
      symbol: symbol.toUpperCase(),
      side,
      type,
      ref_id: refId || crypto.randomUUID(),
    };
    if (quantity) args.quantity = String(quantity);
    if (dollarAmount) args.dollar_amount = String(dollarAmount);
    if (limitPrice) args.limit_price = String(limitPrice);
    if (stopPrice) args.stop_price = String(stopPrice);
    if (timeInForce) args.time_in_force = timeInForce || "gfd";
    if (marketHours) args.market_hours = marketHours;

    console.log(`  [RH] Placing ${side.toUpperCase()} ${quantity || '$' + dollarAmount} ${symbol} (${type}${limitPrice ? ` @ $${limitPrice}` : ""})`);

    const result = await callTool("place_equity_order", args);
    const parsed = extractContent(result);
    console.log(`  [RH] Order result:`, typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200));
    return parsed;
  },

  async cancelOrder(orderId, accountNumber) {
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = buildSchemaArgs("cancel_equity_order", { account_number: acctNum, order_id: orderId });
    const result = await callTool("cancel_equity_order", args);
    return extractContent(result);
  },

  // ─── Options ───

  async getOptionsPositions(accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    // Try known tool name variants
    const toolName = discoveredTools.has("get_options_positions") ? "get_options_positions"
      : discoveredTools.has("get_option_positions") ? "get_option_positions"
      : "get_options_positions";
    const args = buildSchemaArgs(toolName, { account_number: acctNum, nonzero: true });
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  async getOptionsOrders(filters = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("get_options_orders") ? "get_options_orders"
      : discoveredTools.has("get_option_orders") ? "get_option_orders"
      : "get_options_orders";
    const args = buildSchemaArgs(toolName, { account_number: acctNum, ...filters });
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  // Accepts either option instrument ids (UUIDs from the positions endpoint) or OCC/ticker
  // symbols. The actual MCP tool name for option market data is NOT get_options_market_data on
  // this server (that name errors as "unknown tool"), so we discover it by pattern and pass the
  // value under every plausible param key — buildSchemaArgs keeps only the ones the tool declares.
  async getOptionMarketData(symbolsOrIds, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    const list = (Array.isArray(symbolsOrIds) ? symbolsOrIds : [symbolsOrIds]).filter(Boolean).map(String);
    // Exact names observed on the live MCP server first; regex discovery as fallback.
    const toolName = discoveredTools.has("get_option_quotes") ? "get_option_quotes"
      : discoveredTools.has("get_options_quotes") ? "get_options_quotes"
      : findTool(
        /options?_market_?data/i,
        /options?_quotes?/i,
        /(market_?data|quote)s?.*options?/i,
        /options?.*(market_?data|quote)/i,
      );
    if (!toolName) {
      const optTools = [...discoveredTools].filter(t => /option/i.test(t)).join(", ");
      throw new Error(`no option market-data tool discovered (option tools: ${optTools})`);
    }
    // ids kept raw (UUIDs are case-sensitive-ish); symbols upper-cased (tickers/OCC).
    const idsRaw = list;
    const symsUpper = list.map(s => s.toUpperCase());
    const args = buildSchemaArgs(toolName, {
      account_number: acctNum,
      symbols: symsUpper, symbol: symsUpper[0],
      ids: idsRaw, id: idsRaw[0],
      option_ids: idsRaw, option_id: idsRaw[0],
      instrument_ids: idsRaw, instrument_id: idsRaw[0],
      instruments: idsRaw,
    });
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  async getOptionInstruments(symbolOrOpts = {}) {
    const toolName = discoveredTools.has("get_option_instruments") ? "get_option_instruments"
      : discoveredTools.has("get_options_instruments") ? "get_options_instruments"
      : null;
    if (!toolName) throw new Error("get_option_instruments not available");
    const opts = typeof symbolOrOpts === "string"
      ? { chain_symbol: symbolOrOpts }
      : (symbolOrOpts || {});
    const idsRaw = Array.isArray(opts.ids) ? opts.ids.filter(Boolean).join(",")
      : (opts.ids || opts.id || null);
    const symbol = opts.chain_symbol || opts.symbol || null;
    const args = idsRaw
      ? buildSchemaArgs(toolName, {
          ids: idsRaw, id: String(idsRaw).split(",")[0],
          option_ids: idsRaw, option_id: String(idsRaw).split(",")[0],
        })
      : buildSchemaArgs(toolName, {
          chain_symbol: String(symbol || "").toUpperCase(),
          symbol: String(symbol || "").toUpperCase(),
          symbols: symbol ? [String(symbol).toUpperCase()] : [],
          expiration_dates: opts.expiration_dates || undefined,
          type: opts.type || undefined,
          strike_price: opts.strike_price || undefined,
          state: opts.state || "active",
        });
    return extractContent(await callTool(toolName, args));
  },

  // Resolve the option instrument UUID for a specific contract. Orders (place/review) reference
  // the contract only by option_id, but our chain candidates come from Tradier/Finnhub which don't
  // carry Robinhood's id — so we look it up by chain_symbol + expiration + strike + type.
  async resolveOptionId(symbol, expirationDate, optionType, strikePrice, accountNumber) {
    const toolName = discoveredTools.has("get_option_instruments") ? "get_option_instruments"
      : findTool(/option_instruments/i);
    if (!toolName) throw new Error("get_option_instruments not available");
    const exp = String(expirationDate).slice(0, 10);
    const args = buildSchemaArgs(toolName, {
      chain_symbol: String(symbol).toUpperCase(),
      expiration_dates: exp,
      strike_price: Number(strikePrice).toFixed(4),
      type: String(optionType).toLowerCase(),
      state: "active",
    });
    const res = extractContent(await callTool(toolName, args));
    const raw = res && res.data ? res.data : res;
    const items = Array.isArray(raw) ? raw
      : Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.instruments) ? raw.instruments
      : Array.isArray(raw?.option_instruments) ? raw.option_instruments : [];
    const want = Number(strikePrice);
    const match = items.find(it => {
      const s = parseFloat(it.strike_price ?? it.strike ?? 0);
      const t = String(it.type || it.option_type || "").toLowerCase();
      const e = String(it.expiration_date || it.expiration || "").slice(0, 10);
      return (!want || Math.abs(s - want) < 0.01)
        && (!optionType || t === String(optionType).toLowerCase())
        && (!exp || e === exp);
    }) || null;
    return match ? (match.id || match.option_id || match.instrument_id || null) : null;
  },

  async getPnlTradeHistory({ span = "all", symbol = null, cursor = null, accountNumber } = {}) {
    if (!discoveredTools.has("get_pnl_trade_history")) {
      throw new Error("get_pnl_trade_history not available on this MCP session");
    }
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = buildSchemaArgs("get_pnl_trade_history", {
      account_number: acctNum,
      span,
      symbol: symbol ? String(symbol).toUpperCase() : undefined,
      cursor: cursor || undefined,
    });
    return extractContent(await callTool("get_pnl_trade_history", args));
  },

  async getRealizedPnl({
    span = "3month",
    startDate = null,
    endDate = null,
    assetClasses = null,
    accountNumber,
  } = {}) {
    if (!discoveredTools.has("get_realized_pnl")) {
      throw new Error("get_realized_pnl not available on this MCP session");
    }
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const args = buildSchemaArgs("get_realized_pnl", {
      account_number: acctNum,
      span: (startDate || endDate) ? undefined : span,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      asset_classes: assetClasses || undefined,
    });
    return extractContent(await callTool("get_realized_pnl", args));
  },

  async getHistoricals(symbol, span = "year", interval = "day") {
    const toolName = discoveredTools.has("get_historicals") ? "get_historicals"
      : discoveredTools.has("get_stock_historicals") ? "get_stock_historicals"
      : discoveredTools.has("get_equity_historicals") ? "get_equity_historicals"
      : null;
    if (!toolName) throw new Error("historicals tool not available");
    const args = buildSchemaArgs(toolName, {
      symbol: symbol.toUpperCase(),
      symbols: [symbol.toUpperCase()],
      span,
      interval,
    });
    return extractContent(await callTool(toolName, args));
  },

  // Build the exact wire args for place_option_order / review_option_order. The tool takes a
  // single-leg `legs` array (option_id + side + position_effect) and a top-level `price`, NOT the
  // flat symbol/strike/limit_price fields — additionalProperties:false rejects anything else.
  async _buildOptionOrderArgs({ acctNum, symbol, expirationDate, strikePrice, optionType, side, quantity, type, limitPrice, stopPrice, timeInForce, refId, optionId, positionEffect }) {
    let instrId = optionId;
    if (!instrId) instrId = await this.resolveOptionId(symbol, expirationDate, optionType, strikePrice, acctNum);
    if (!instrId) throw new Error(`could not resolve option_id for ${symbol} $${strikePrice} ${optionType} ${expirationDate}`);
    // Compound sides (buy_to_open / sell_to_close / ...) → leg side + position_effect.
    const s = String(side || "").toLowerCase();
    const legSide = s.includes("sell") ? "sell" : "buy";
    const posEffect = positionEffect
      || (s.includes("close") ? "close" : s.includes("open") ? "open" : (legSide === "buy" ? "open" : "close"));
    const ordType = type || "limit";
    const args = {
      account_number: acctNum,
      legs: [{ option_id: instrId, side: legSide, position_effect: posEffect, ratio_quantity: 1 }],
      type: ordType,
      quantity: String(parseInt(quantity, 10) || quantity),
      time_in_force: timeInForce || "gfd",
      ref_id: refId || crypto.randomUUID(),
    };
    // price only for limit / stop_limit; stop_price only for stop_limit / stop_market.
    if ((ordType === "limit" || ordType === "stop_limit") && limitPrice != null) args.price = String(limitPrice);
    if ((ordType === "stop_limit" || ordType === "stop_market") && stopPrice != null) args.stop_price = String(stopPrice);
    return { args, optionId: instrId, legSide, posEffect, ordType };
  },

  async reviewOptionOrder(params = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("review_option_order") ? "review_option_order"
      : findTool(/review_options?_order/i) || "review_option_order";
    const { args } = await this._buildOptionOrderArgs({ ...params, acctNum });
    // review takes chain_symbol + underlying_type (for fees/collateral) instead of ref_id.
    if (params.symbol) { args.chain_symbol = String(params.symbol).toUpperCase(); args.underlying_type = "equity"; }
    const result = await callTool(toolName, buildSchemaArgs(toolName, args));
    return extractContent(result);
  },

  async placeOptionOrder(params = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("place_option_order") ? "place_option_order"
      : findTool(/place_options?_order/i) || "place_option_order";
    const callerSuppliedRefId = Object.prototype.hasOwnProperty.call(params, "refId")
      && params.refId !== undefined && params.refId !== null;
    if (callerSuppliedRefId && !schemaAccepts(toolName, "ref_id")) {
      throw idempotencySchemaError(toolName);
    }
    const { args, optionId, legSide, posEffect } = await this._buildOptionOrderArgs({ ...params, acctNum });
    const wireArgs = buildSchemaArgs(toolName, args);
    // A caller-supplied ref is persisted specifically so an ambiguous submission can be replayed
    // under the same broker idempotency key. Silently schema-filtering it creates duplicate-order
    // risk, so stop before the placement RPC whenever the discovered schema would drop it.
    if (callerSuppliedRefId && !Object.prototype.hasOwnProperty.call(wireArgs, "ref_id")) {
      throw idempotencySchemaError(toolName);
    }
    const label = params.symbol
      ? buildOCC(params.symbol, params.expirationDate, params.optionType || "call", parseFloat(params.strikePrice) || 0)
      : optionId;
    console.log(`  [RH] Placing OPTION ${legSide}/${posEffect} ${args.quantity}x ${label} (${args.type}${args.price ? ` @ $${args.price}` : ""})`);

    const result = await callTool(toolName, wireArgs);
    const parsed = extractContent(result);
    console.log(`  [RH] Option order result:`, typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200));
    return parsed;
  },

  async cancelOptionOrder(orderId, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("cancel_option_order") ? "cancel_option_order"
      : discoveredTools.has("cancel_options_order") ? "cancel_options_order"
      : "cancel_option_order";
    const args = buildSchemaArgs(toolName, { account_number: acctNum, order_id: orderId });
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  async checkOptionsTradability(symbols, accountNumber) {
    if (!optionsSupported) return null;
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("get_options_tradability") ? "get_options_tradability"
      : discoveredTools.has("get_option_tradability") ? "get_option_tradability"
      : null;
    if (!toolName) return null;
    const syms = Array.isArray(symbols) ? symbols : [symbols];
    const result = await callTool(toolName, { account_number: acctNum, symbols: syms.map(s => s.toUpperCase()) });
    return extractContent(result);
  },

  // ─── Watchlists ───

  async getWatchlists() {
    if (!discoveredTools.has("get_watchlists")) throw new Error("get_watchlists not available");
    return extractContent(await callTool("get_watchlists", {}));
  },

  async getWatchlistItems(watchlist) {
    const toolName = discoveredTools.has("get_watchlist_items") ? "get_watchlist_items" : null;
    if (!toolName) throw new Error("get_watchlist_items not available");
    const args = buildSchemaArgs(toolName, {
      watchlist,
      name: watchlist,
      account_number: discoveredAccountNumber,
    });
    return extractContent(await callTool(toolName, args));
  },

  async getOptionWatchlist(watchlist) {
    if (!discoveredTools.has("get_option_watchlist")) throw new Error("get_option_watchlist not available");
    const args = buildSchemaArgs("get_option_watchlist", {
      watchlist,
      name: watchlist,
      account_number: discoveredAccountNumber,
    });
    return extractContent(await callTool("get_option_watchlist", args));
  },

  async createWatchlist(name, description = "") {
    if (!discoveredTools.has("create_watchlist")) throw new Error("create_watchlist not available");
    const candidateArgs = { name, account_number: discoveredAccountNumber };
    if (description) candidateArgs.description = description;
    const args = buildSchemaArgs("create_watchlist", candidateArgs);
    return extractContent(await callTool("create_watchlist", args));
  },

  async addToWatchlist(symbol, watchlist) {
    if (!discoveredTools.has("add_to_watchlist")) throw new Error("add_to_watchlist not available");
    const args = buildSchemaArgs("add_to_watchlist", {
      symbol: symbol.toUpperCase(),
      symbols: [symbol.toUpperCase()],
      watchlist,
      name: watchlist,
      account_number: discoveredAccountNumber,
    });
    return extractContent(await callTool("add_to_watchlist", args));
  },

  async addOptionToWatchlist({ symbol, expirationDate, strikePrice, optionType, watchlist } = {}) {
    if (!discoveredTools.has("add_option_to_watchlist")) throw new Error("add_option_to_watchlist not available");
    const args = buildSchemaArgs("add_option_to_watchlist", {
      symbol: symbol.toUpperCase(),
      symbols: [symbol.toUpperCase()],
      expiration_date: expirationDate,
      strike_price: String(strikePrice),
      option_type: optionType,
      watchlist,
      name: watchlist,
      account_number: discoveredAccountNumber,
    });
    return extractContent(await callTool("add_option_to_watchlist", args));
  },

  async removeFromWatchlist(symbol, watchlist) {
    if (!discoveredTools.has("remove_from_watchlist")) throw new Error("remove_from_watchlist not available");
    const args = buildSchemaArgs("remove_from_watchlist", {
      symbol: symbol.toUpperCase(),
      symbols: [symbol.toUpperCase()],
      watchlist,
      name: watchlist,
      account_number: discoveredAccountNumber,
    });
    return extractContent(await callTool("remove_from_watchlist", args));
  },

  // ─── Token Management ───

  // meta: { clientId, tokenEndpoint } — the OAuth client identity the tokens were minted under
  // (from dynamic client registration). Required for refresh_token grants to succeed later.
  setToken(token, refresh = null, meta = {}) {
    accessToken = (token || "").trim() || null;
    discoveredAccountNumber = null;
    mcpInitialized = false;
    sessionId = null;
    refreshToken = refresh != null ? String(refresh).trim() || null : refreshToken;
    if (meta.clientId) oauthClientId = meta.clientId;
    if (meta.tokenEndpoint) oauthTokenEndpoint = meta.tokenEndpoint;
    if (!accessToken) {
      refreshToken = null;
      oauthClientId = null;
      oauthTokenEndpoint = null;
      healthStatus = "unknown";
      lastHealthError = null;
      try { fs.unlinkSync(TOKEN_FILE); } catch { }
      return;
    }
    healthStatus = "unknown";
    lastHealthError = null;
    saveTokens();
  },

  async refreshAuth() {
    return tryRefreshToken();
  },
};

export { robinhood };
export default robinhood;
