/**
 * robinhood.js — Lightweight Robinhood Agentic Trading MCP Client
 *
 * Communicates with Robinhood's official MCP server over Streamable HTTP.
 * MCP = Model Context Protocol (JSON-RPC 2.0 over HTTP).
 *
 * Usage:
 *   import { robinhood } from './robinhood.js';
 *   await robinhood.init();
 *   const acct = await robinhood.getAccount();
 *   await robinhood.placeStockOrder('AAPL', 'buy', 10, 'market');
 */

import fetch from "node-fetch";
import fs from "fs";
import crypto from "crypto";

// ─── Configuration ───

const MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const TOKEN_FILE = "rh_tokens.json";
const PENDING_ORDERS_FILE = "rh_pending.json";

// ─── State ───

let accessToken = null;
let refreshToken = null;
let sessionId = null;
let mcpInitialized = false;

// Pending orders awaiting user approval
let pendingOrders = [];

// ─── MCP Transport Layer ───

let rpcId = 1;

async function mcpCall(method, params = {}) {
  if (!accessToken) throw new Error("Robinhood not authenticated. Set ROBINHOOD_ACCESS_TOKEN or run auth flow.");

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

  // Include Mcp-Session-Id if we have one (required after initialize)
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

  // Handle SSE responses (text/event-stream) — some MCP servers use SSE for tool results
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

// ─── Token Persistence ───

function loadTokens() {
  // Priority: env var > file
  const envToken = (process.env.ROBINHOOD_ACCESS_TOKEN || "").trim();
  if (envToken) {
    accessToken = envToken;
    refreshToken = (process.env.ROBINHOOD_REFRESH_TOKEN || "").trim() || null;
    return true;
  }

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      accessToken = data.accessToken || null;
      refreshToken = data.refreshToken || null;
      return !!accessToken;
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

// ─── Public API ───

const robinhood = {
  // Whether the module is connected and ready
  get isConnected() { return !!accessToken && mcpInitialized; },
  get isAuthenticated() { return !!accessToken; },
  get pendingOrders() { return [...pendingOrders]; },

  /**
   * Initialize the MCP session.
   * Must be called once before any tool calls.
   */
  async init() {
    if (!loadTokens()) {
      console.log("  [RH] No Robinhood token found. Set ROBINHOOD_ACCESS_TOKEN env var.");
      console.log("  [RH] To authenticate: visit https://agent.robinhood.com and connect your agent.");
      return false;
    }

    try {
      // MCP initialize handshake
      const initResult = await mcpCall("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "swingtrader-bot",
          version: "1.0.0",
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
      loadPendingOrders();
      console.log("  [RH] Robinhood Agentic Trading connected ✓");
      return true;
    } catch (e) {
      console.log(`  [RH] MCP init failed: ${e.message}`);
      mcpInitialized = false;
      return false;
    }
  },

  /**
   * Get account info (buying power, portfolio value, etc.)
   */
  async getAccount() {
    const result = await callTool("robinhood_get_account");
    return extractContent(result);
  },

  /**
   * Get portfolio summary (all positions with P&L)
   */
  async getPortfolio() {
    const result = await callTool("robinhood_get_portfolio");
    return extractContent(result);
  },

  /**
   * Get stock quote
   */
  async getQuote(symbol) {
    const result = await callTool("robinhood_get_stock_quote", { symbol: symbol.toUpperCase() });
    return extractContent(result);
  },

  /**
   * Place a stock order (equities only for now)
   * @param {string} symbol - Ticker (e.g., "AAPL")
   * @param {string} side - "buy" or "sell"
   * @param {number} quantity - Number of shares
   * @param {string} orderType - "market" or "limit"
   * @param {number} [limitPrice] - Required for limit orders
   * @returns {object} Order confirmation
   */
  async placeStockOrder(symbol, side, quantity, orderType = "market", limitPrice = null) {
    const args = {
      symbol: symbol.toUpperCase(),
      side,
      quantity,
      order_type: orderType,
    };
    if (orderType === "limit" && limitPrice) {
      args.limit_price = limitPrice;
    }

    console.log(`  [RH] Placing ${side.toUpperCase()} ${quantity} ${symbol} (${orderType}${limitPrice ? ` @ $${limitPrice}` : ""})`);

    const result = await callTool("robinhood_place_stock_order", args);
    const parsed = extractContent(result);
    console.log(`  [RH] Order result:`, typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200));
    return parsed;
  },

  /**
   * Get all open orders
   */
  async getOrders() {
    const result = await callTool("robinhood_get_orders");
    return extractContent(result);
  },

  /**
   * Cancel an order by ID
   */
  async cancelOrder(orderId) {
    const result = await callTool("robinhood_cancel_order", { order_id: orderId });
    return extractContent(result);
  },

  /**
   * Get order status by ID
   */
  async getOrderStatus(orderId) {
    const result = await callTool("robinhood_get_order_status", { order_id: orderId });
    return extractContent(result);
  },

  /**
   * Get options chain for a symbol
   */
  async getOptions(symbol) {
    const result = await callTool("robinhood_get_options", { symbol: symbol.toUpperCase() });
    return extractContent(result);
  },

  /**
   * Get historical price data for a symbol
   */
  async getHistoricals(symbol, span = "year", interval = "day") {
    const result = await callTool("robinhood_get_historicals", { symbol: symbol.toUpperCase(), span, interval });
    return extractContent(result);
  },

  /**
   * Get all accounts info
   */
  async getAccounts() {
    const result = await callTool("robinhood_get_accounts");
    return extractContent(result);
  },

  // ─── Approval Queue ───

  /**
   * Queue an order for approval instead of executing immediately.
   * Returns the pending order object with a unique ID.
   */
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

  /**
   * Approve a pending order and execute it.
   */
  async approveOrder(orderId) {
    const idx = pendingOrders.findIndex(o => o.id === orderId);
    if (idx === -1) throw new Error(`Pending order ${orderId} not found`);

    const order = pendingOrders[idx];
    order.status = "approved";

    try {
      const result = await this.placeStockOrder(
        order.symbol,
        order.side,
        order.quantity,
        order.orderType || "market",
        order.limitPrice
      );
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

  /**
   * Reject a pending order.
   */
  rejectOrder(orderId) {
    const idx = pendingOrders.findIndex(o => o.id === orderId);
    if (idx === -1) throw new Error(`Pending order ${orderId} not found`);
    const order = pendingOrders.splice(idx, 1)[0];
    order.status = "rejected";
    order.rejectedAt = new Date().toISOString();
    savePendingOrders();
    return order;
  },

  /**
   * Convert a bot options signal into an equity order.
   * Maps: CALL signal → BUY shares, PUT signal → SELL shares (or skip if no position).
   * Returns order details suitable for queueOrder() or direct execution.
   */
  convertOptionsToEquity(ticker, direction, spotPrice, riskBudget) {
    const side = direction === "BULLISH" ? "buy" : "sell";
    // Calculate share count based on risk budget
    const quantity = Math.max(1, Math.floor(riskBudget / spotPrice));

    return {
      symbol: ticker,
      side,
      quantity,
      orderType: "market",
      spotPrice,
      riskBudget,
      originalDirection: direction,
      conversionNote: `Options ${direction} signal → ${side.toUpperCase()} ${quantity} shares @ ~$${spotPrice.toFixed(2)}`,
    };
  },

  /**
   * Set the access token programmatically (e.g. from dashboard auth flow)
   */
  setToken(token) {
    accessToken = token;
    saveTokens();
  },
};

export { robinhood };
export default robinhood;
