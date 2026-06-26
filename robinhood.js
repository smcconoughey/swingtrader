/**
 * robinhood.js — Robinhood Agentic Trading MCP Client (Equity + Options)
 *
 * Communicates with Robinhood's official MCP server over Streamable HTTP.
 * MCP = Model Context Protocol (JSON-RPC 2.0 over HTTP).
 *
 * Supports equity AND options trading via MCP tools. Tool availability is
 * auto-detected at init via tools/list — if the server exposes options tools,
 * robinhood.optionsEnabled is true and all option methods are live.
 *
 * Auth: OAuth tokens cached by mcp-remote in ~/.mcp-auth/, or ROBINHOOD_ACCESS_TOKEN env var.
 */

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

// ─── Configuration ───

const MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const TOKEN_FILE = "rh_tokens.json";

// ─── State ───

let accessToken = null;
let refreshToken = null;
let sessionId = null;
let mcpInitialized = false;
let discoveredAccountNumber = null;
let discoveredTools = new Set();
let optionsSupported = false;

// ─── MCP Transport Layer ───

let rpcId = 1;

async function mcpCall(method, params = {}) {
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

async function callTool(toolName, args = {}) {
  return mcpCall("tools/call", {
    name: toolName,
    arguments: args,
  });
}

function extractContent(result) {
  // MCP tool results come as { content: [{ type: "text", text: "..." }] }
  if (!result?.content) return result;
  const textParts = result.content.filter(c => c.type === "text");
  if (textParts.length === 0) return result;
  const combined = textParts.map(c => c.text).join("\n");
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
  // Priority 1: env var
  const envToken = (process.env.ROBINHOOD_ACCESS_TOKEN || "").trim();
  if (envToken) {
    accessToken = envToken;
    refreshToken = (process.env.ROBINHOOD_REFRESH_TOKEN || "").trim() || null;
    return true;
  }

  // Priority 2: local token file (written by bot dashboard)
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (data.accessToken) {
        accessToken = data.accessToken;
        refreshToken = data.refreshToken || null;
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

  buildOCC,
  parseOCC,

  async init() {
    if (!loadTokens()) {
      console.log("  [RH] No Robinhood token found. Set ROBINHOOD_ACCESS_TOKEN env var or connect via Cursor MCP.");
      return false;
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
          const optionTools = [...discoveredTools].filter(t => /option/i.test(t));
          optionsSupported = optionTools.length >= 2; // need at least positions + order placement
          console.log(`  [RH] Discovered ${discoveredTools.size} MCP tools.${optionsSupported ? ` OPTIONS ENABLED (${optionTools.join(", ")})` : " Options tools not found — equity only."}`);
        }
      } catch (e) {
        console.log(`  [RH] tools/list unavailable (${e.message}) — assuming equity only`);
      }

      // Auto-discover the agentic account
      try {
        let accounts = await robinhood.getAccounts();
        if (accounts && accounts.data && Array.isArray(accounts.data.accounts)) {
          accounts = accounts.data.accounts;
        } else if (accounts && Array.isArray(accounts.accounts)) {
          accounts = accounts.accounts;
        }

        if (Array.isArray(accounts)) {
          const agentic = accounts.find(a => a.agentic_allowed || a.is_agentic || a.nickname === "Agentic");
          if (agentic) {
            discoveredAccountNumber = agentic.account_number || agentic.account_id;
            console.log(`  [RH] Agentic account discovered: ${discoveredAccountNumber}`);
          } else if (accounts.length > 0) {
            discoveredAccountNumber = accounts[0].account_number || accounts[0].account_id;
            console.log(`  [RH] Using first account: ${discoveredAccountNumber} (no explicit agentic flag found)`);
          }
        } else if (typeof accounts === "object" && accounts.account_number) {
          discoveredAccountNumber = accounts.account_number;
          console.log(`  [RH] Account discovered: ${discoveredAccountNumber}`);
        }
      } catch (e) {
        console.log(`  [RH] Account discovery failed: ${e.message}`);
      }

      console.log(`  [RH] Robinhood Agentic Trading connected ✓${optionsSupported ? " (equity + options)" : " (equity only)"}`);
      return true;
    } catch (e) {
      console.log(`  [RH] MCP init failed: ${e.message}`);
      mcpInitialized = false;
      return false;
    }
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
    const result = await callTool("get_equity_orders", { account_number: acctNum, ...filters });
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
    const result = await callTool("cancel_equity_order", { account_number: acctNum, order_id: orderId });
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
    const result = await callTool(toolName, { account_number: acctNum });
    return extractContent(result);
  },

  async getOptionsOrders(filters = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("get_options_orders") ? "get_options_orders"
      : discoveredTools.has("get_option_orders") ? "get_option_orders"
      : "get_options_orders";
    const result = await callTool(toolName, { account_number: acctNum, ...filters });
    return extractContent(result);
  },

  async getOptionMarketData(symbols, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    const syms = Array.isArray(symbols) ? symbols : [symbols];
    const toolName = discoveredTools.has("get_options_market_data") ? "get_options_market_data"
      : discoveredTools.has("get_option_market_data") ? "get_option_market_data"
      : "get_options_market_data";
    const args = { symbols: syms.map(s => s.toUpperCase()) };
    if (acctNum) args.account_number = acctNum;
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  async reviewOptionOrder({ symbol, expirationDate, strikePrice, optionType, side, quantity, type, limitPrice, stopPrice, timeInForce, refId } = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("review_option_order") ? "review_option_order"
      : discoveredTools.has("review_options_order") ? "review_options_order"
      : "review_option_order";
    const args = {
      account_number: acctNum,
      symbol: symbol.toUpperCase(),
      expiration_date: expirationDate,
      strike_price: String(strikePrice),
      option_type: optionType,
      side,
      quantity: String(quantity),
      type: type || "limit",
    };
    if (limitPrice) args.limit_price = String(limitPrice);
    if (stopPrice) args.stop_price = String(stopPrice);
    if (timeInForce) args.time_in_force = timeInForce;
    if (refId) args.ref_id = refId;
    const result = await callTool(toolName, args);
    return extractContent(result);
  },

  async placeOptionOrder({ symbol, expirationDate, strikePrice, optionType, side, quantity, type, limitPrice, stopPrice, timeInForce, refId } = {}, accountNumber) {
    if (!optionsSupported) throw new Error("Options not supported on this MCP session");
    const acctNum = accountNumber || discoveredAccountNumber;
    if (!acctNum) throw new Error("No account number");
    const toolName = discoveredTools.has("place_option_order") ? "place_option_order"
      : discoveredTools.has("place_options_order") ? "place_options_order"
      : "place_option_order";
    const args = {
      account_number: acctNum,
      symbol: symbol.toUpperCase(),
      expiration_date: expirationDate,
      strike_price: String(strikePrice),
      option_type: optionType,
      side,
      quantity: String(quantity),
      type: type || "limit",
      ref_id: refId || crypto.randomUUID(),
    };
    if (limitPrice) args.limit_price = String(limitPrice);
    if (stopPrice) args.stop_price = String(stopPrice);
    if (timeInForce) args.time_in_force = timeInForce || "gfd";

    const occ = buildOCC(symbol, expirationDate, optionType, parseFloat(strikePrice));
    console.log(`  [RH] Placing OPTION ${side.toUpperCase()} ${quantity}x ${occ} (${type || "limit"}${limitPrice ? ` @ $${limitPrice}` : ""})`);

    const result = await callTool(toolName, args);
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
    const result = await callTool(toolName, { account_number: acctNum, order_id: orderId });
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

  // ─── Token Management ───

  setToken(token) {
    accessToken = token;
    saveTokens();
  },
};

export { robinhood };
export default robinhood;
