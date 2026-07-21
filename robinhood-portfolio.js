/**
 * Robinhood portfolio / trade-history helpers.
 *
 * The MCP get_portfolio payload exposes both:
 *   - equity_value: stock holdings only (often "0" on an options-only cash account)
 *   - total_value: full account value (cash + options + equities)
 *
 * Preferring equity_value via ?? / || incorrectly pins brokerEquity at 0 whenever
 * there are no stock holdings, which forces the cash+rhUnsettled fallback and
 * double-counts today's option sale proceeds.
 */

export function parseMoneyAmount(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    return parseMoneyAmount(value.amount ?? value.value ?? value.buying_power ?? null);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[$,]/g, "");
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function firstPositiveAmount(...candidates) {
  for (const candidate of candidates) {
    const amount = parseMoneyAmount(candidate);
    if (amount != null && amount > 0) return amount;
  }
  return null;
}

function firstNonNegativeAmount(...candidates) {
  for (const candidate of candidates) {
    const amount = parseMoneyAmount(candidate);
    if (amount != null && amount >= 0) return amount;
  }
  return null;
}

/**
 * Normalize any get_portfolio envelope into equity + buying-power fields.
 * Accepts raw MCP content, `{ data: ... }`, or `{ results: [...] }`.
 */
export function extractRobinhoodPortfolioFields(raw) {
  const env = raw && raw.data ? raw.data : raw;
  const port = env?.results?.[0] ?? env?.portfolio ?? env;
  if (!port || typeof port !== "object") {
    return {
      totalEquity: null,
      buyingPower: null,
      cash: null,
      equityValue: null,
      optionsValue: null,
      source: null,
    };
  }

  const equityValue = firstNonNegativeAmount(port.equity_value);
  const optionsValue = firstNonNegativeAmount(port.options_value);
  const cash = firstNonNegativeAmount(port.cash);

  // Account value must come from total_* fields first. equity_value alone is the
  // stock sleeve and is routinely 0 on options-only accounts.
  const totalEquity = firstPositiveAmount(
    port.total_value,
    port.total_equity,
    port.portfolio_value,
    port.equity,
    port.market_value,
    port.total_market_value,
    port.extended_hours_equity,
    // Last resort: sum sleeves when the broker omits total_value.
    (equityValue ?? 0) + (optionsValue ?? 0) + (cash ?? 0) > 0
      ? (equityValue ?? 0) + (optionsValue ?? 0) + (cash ?? 0)
      : null,
    // Only if nothing else exists and equity_value itself is > 0.
    equityValue,
  );

  const buyingPower = firstNonNegativeAmount(
    port.buying_power?.buying_power,
    port.buying_power,
    port.options_buying_power,
    port.cash,
  );

  let source = null;
  if (parseMoneyAmount(port.total_value) > 0) source = "total_value";
  else if (parseMoneyAmount(port.total_equity) > 0) source = "total_equity";
  else if (parseMoneyAmount(port.portfolio_value) > 0) source = "portfolio_value";
  else if (totalEquity != null) source = "derived";

  return {
    totalEquity,
    buyingPower,
    cash,
    equityValue,
    optionsValue,
    source,
  };
}

function localTradeKey(trade) {
  if (!trade || typeof trade !== "object") return null;
  const occ = String(trade.occSymbol || trade.occ || "").toUpperCase();
  const ticker = String(trade.ticker || trade.symbol || "").toUpperCase();
  const type = String(trade.type || trade.option_type || "").toLowerCase();
  const strike = Number(trade.strike || trade.strike_price || 0);
  const closeDate = String(trade.closeDate || trade.close_date || trade.date || "").slice(0, 10);
  const qty = Number(trade.qty || trade.quantity || 0);
  if (occ) return `occ:${occ}|${closeDate}|q${qty}`;
  if (ticker && type && strike > 0) return `sym:${ticker}|${type}|${strike}|${closeDate}|q${qty}`;
  if (ticker) return `sym:${ticker}|${closeDate}|q${qty}`;
  return null;
}

function normalizeBrokerPnlRows(raw) {
  const env = raw && raw.data ? raw.data : raw;
  const rows = Array.isArray(env) ? env
    : Array.isArray(env?.results) ? env.results
      : Array.isArray(env?.trades) ? env.trades
        : Array.isArray(env?.history) ? env.history
          : Array.isArray(env?.items) ? env.items
            : [];
  return rows.filter(row => row && typeof row === "object");
}

/**
 * Compare local closed-trade history against Robinhood get_pnl_trade_history rows.
 * Returns broker-only / local-only keys so operators can spot missing syncs.
 */
export function diffRobinhoodTradeHistory(localHistory = [], brokerRaw = null) {
  const local = (Array.isArray(localHistory) ? localHistory : [])
    .filter(t => t && typeof t.pnlDollar === "number" && !t._pendingFill);
  const brokerRows = normalizeBrokerPnlRows(brokerRaw);

  const localByKey = new Map();
  for (const trade of local) {
    const key = localTradeKey(trade);
    if (!key) continue;
    const bucket = localByKey.get(key) || [];
    bucket.push(trade);
    localByKey.set(key, bucket);
  }

  const brokerByKey = new Map();
  const brokerNormalized = [];
  for (const row of brokerRows) {
    const normalized = {
      ticker: row.symbol || row.ticker || row.chain_symbol || null,
      type: row.option_type || row.type || null,
      strike: row.strike_price ?? row.strike ?? null,
      occSymbol: row.occ_symbol || row.option_symbol || row.symbol || null,
      qty: Number(row.quantity ?? row.qty ?? row.contracts ?? 0) || null,
      closeDate: String(row.close_date || row.date || row.closing_date || row.trade_date || "").slice(0, 10) || null,
      pnlDollar: parseMoneyAmount(row.realized_pnl ?? row.pnl ?? row.profit_loss ?? row.amount),
      raw: row,
    };
    brokerNormalized.push(normalized);
    const key = localTradeKey(normalized);
    if (!key) continue;
    const bucket = brokerByKey.get(key) || [];
    bucket.push(normalized);
    brokerByKey.set(key, bucket);
  }

  const missingLocally = [];
  for (const [key, rows] of brokerByKey) {
    const localCount = localByKey.get(key)?.length || 0;
    if (rows.length > localCount) {
      missingLocally.push(...rows.slice(localCount));
    }
  }

  const missingAtBroker = [];
  for (const [key, rows] of localByKey) {
    const brokerCount = brokerByKey.get(key)?.length || 0;
    if (rows.length > brokerCount) {
      missingAtBroker.push(...rows.slice(brokerCount).map(t => ({
        ticker: t.ticker,
        type: t.type,
        strike: t.strike,
        occSymbol: t.occSymbol,
        qty: t.qty,
        closeDate: t.closeDate,
        pnlDollar: t.pnlDollar,
        reason: t.reason,
      })));
    }
  }

  const localPnl = local.reduce((sum, t) => sum + (Number(t.pnlDollar) || 0), 0);
  const brokerPnl = brokerNormalized.reduce((sum, t) => sum + (Number(t.pnlDollar) || 0), 0);

  return {
    localTradeCount: local.length,
    brokerTradeCount: brokerNormalized.length,
    localPnl: +localPnl.toFixed(2),
    brokerPnl: +brokerPnl.toFixed(2),
    pnlGap: +(brokerPnl - localPnl).toFixed(2),
    missingLocally,
    missingAtBroker,
    brokerRows: brokerNormalized,
  };
}
