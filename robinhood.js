/**
 * robinhood.js — Robinhood Agentic Trading MCP Client
 *
 * Communicates with Robinhood's official MCP server over Streamable HTTP.
 * MCP = Model Context Protocol (JSON-RPC 2.0 over HTTP).
 *
 * Supports equity trading via the 10 official MCP tools:
 *   get_accounts, get_portfolio, get_equity_positions, get_equity_quotes,
 *   get_equity_orders, get_equity_tradability, review_equity_order,
 *   place_equity_order, cancel_equity_order, search
 *
 * Auth: OAuth tokens cached by mcp-remote in ~/.mcp-auth/, or ROBINHOOD_ACCESS_TOKEN env var.
 *
 * Usage:
 *   import { robinhood } from './robinhood.js';
 *   await robinhood.init();
 *   const acct = await robinhood.getAccount();
 *   await robinhood.placeEquityOrder({ symbol: 'AAPL', side: 'buy', type: 'limit', quantity: '10', limitPrice: '150.00' });
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
      // Find the most recent token file across all mcp-remote versions
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
              // Auto-persist to rh_tokens.json so it survives restarts/deploys
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

  /**
   * Initialize the MCP session. Must be called once before any tool calls.
   */
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
          version: "2.0.0",
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

      // Auto-discover the agentic account
      try {
        let accounts = await robinhood.getAccounts();
        if (accounts && accounts.data && Array.isArray(accounts.data.accounts)) {
          accounts = accounts.data.accounts;
        } else if (accounts && Array.isArray(accounts.accounts)) {
          accounts = accounts.accounts;
        }

        if (Array.isArray(accounts)) {
          // Find the agentic-allowed account
          const agentic = accounts.find(a => a.agentic_allowed || a.is_agentic || a.nickname === "Agentic");
          if (agentic) {
            discoveredAccountNumber = agentic.account_number || agentic.account_id;
            console.log(`  [RH] Agentic account discovered: ${discoveredAccountNumber}`);
          } else if (accounts.length > 0) {
            // Fall back to first account
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

      console.log(`  [RH] Robinhood Agentic Trading connected ✓`);
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

  // ─── Orders ───

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

  // ─── Token Management ───

  setToken(token) {
    accessToken = token;
    saveTokens();
  },
};

export { robinhood };
export default robinhood;
