const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;

const positive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function normalizeOptionId(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const uuidMatches = raw.match(UUID_RE);
  if (uuidMatches?.length) return uuidMatches[uuidMatches.length - 1].toLowerCase();
  const clean = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const tail = clean.slice(clean.lastIndexOf("/") + 1).trim();
  return (tail || clean).toLowerCase() || null;
}

export function normalizeExpiration(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ts = Date.parse(`${raw}T16:00:00Z`);
  return Number.isFinite(ts) ? raw : null;
}

export function optionExpirationTimestamp(value) {
  const expiration = normalizeExpiration(value);
  if (!expiration) return 0;
  const [year, month, day] = expiration.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 16));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(probe);
  const part = type => Number(parts.find(item => item.type === type)?.value);
  const localizedAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  const offsetMs = localizedAsUtc - probe.getTime();
  return Date.UTC(year, month - 1, day, 16) - offsetMs;
}

export function parseOccSymbol(value) {
  const match = String(value || "").toUpperCase().match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;
  const [, ticker, yy, mm, dd, cp, strikeRaw] = match;
  const expiration = normalizeExpiration(`20${yy}-${mm}-${dd}`);
  if (!expiration) return null;
  return {
    ticker,
    expiration,
    type: cp === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

function optionIds(value, { allowBareId = false } = {}) {
  if (!value || typeof value !== "object") return [];
  const raw = [
    value.option_id,
    value.optionId,
    value.instrument_id,
    value.instrumentId,
    value.instrument,
    value.option,
    ...(allowBareId ? [value.id] : []),
  ];
  return [...new Set(raw.map(normalizeOptionId).filter(Boolean))];
}

function orderLegs(order) {
  return Array.isArray(order?.legs) && order.legs.length ? order.legs : [order];
}

function legIdentity(leg, order = {}) {
  const typeCandidate = leg?.option_type || order.option_type
    || (["call", "put"].includes(String(leg?.type || "").toLowerCase()) ? leg.type : "");
  const typeRaw = String(typeCandidate || "").toLowerCase();
  const type = typeRaw === "call" || typeRaw === "put" ? typeRaw : null;
  const strike = positive(leg?.strike_price ?? leg?.strike ?? order.strike_price ?? order.strike);
  const expiration = normalizeExpiration(
    leg?.expiration_date ?? leg?.expiration ?? order.expiration_date ?? order.expiration,
  );
  const ticker = String(leg?.chain_symbol || leg?.symbol || order.chain_symbol || order.symbol || "").toUpperCase() || null;
  return { type, strike, expiration, ticker };
}

/** Resolve contract fields only from a record/leg carrying the exact option instrument id. */
export function resolveExactOptionIdentity(instrumentId, records = []) {
  const expected = normalizeOptionId(instrumentId);
  if (!expected) return null;
  for (const record of records || []) {
    const legs = orderLegs(record);
    const isInstrumentRecord = legs.length === 1 && legs[0] === record && !Array.isArray(record?.legs);
    for (const leg of legs) {
      const ids = optionIds(leg, { allowBareId: isInstrumentRecord });
      if (!ids.includes(expected)) continue;
      const identity = legIdentity(leg, record);
      if (!identity.type || !(identity.strike > 0) || !identity.expiration) continue;
      return { ...identity, instrumentId: expected };
    }
  }
  return null;
}

export function isVerifiedRobinhoodContract(position = {}) {
  if (position.contractIdentityVerified !== true) return false;
  if (position.type !== "call" && position.type !== "put") return false;
  if (!(Number(position.strike) > 0) || !(Number(position.expiryDate) > 0)) return false;

  const instrumentId = normalizeOptionId(position.instrumentUrl || position.instrumentId || position.optionId);
  const verifiedInstrumentId = normalizeOptionId(position.verifiedInstrumentId);
  const occ = parseOccSymbol(position.occSymbol);
  if (!instrumentId && !occ) return false;
  if (instrumentId && verifiedInstrumentId !== instrumentId) return false;
  if (!occ) return true;

  const expiry = new Date(Number(position.expiryDate)).toISOString().slice(0, 10);
  return occ.ticker === String(position.ticker || "").toUpperCase()
    && occ.type === position.type
    && Math.abs(occ.strike - Number(position.strike)) < 0.001
    && occ.expiration === expiry;
}

export function exactOptionQuoteMatches(position = {}, quote = {}) {
  const expectedId = normalizeOptionId(position.instrumentUrl || position.instrumentId || position.optionId);
  const candidateIds = optionIds(quote, { allowBareId: true });
  if (expectedId && candidateIds.length) return candidateIds.includes(expectedId);

  const expectedOcc = parseOccSymbol(position.occSymbol);
  if (!expectedOcc) return false;
  const rawOcc = quote.occ_symbol || quote.occSymbol || quote.symbol || quote.option_symbol || null;
  const candidateOcc = parseOccSymbol(rawOcc);
  return !!candidateOcc
    && candidateOcc.ticker === expectedOcc.ticker
    && candidateOcc.type === expectedOcc.type
    && candidateOcc.expiration === expectedOcc.expiration
    && Math.abs(candidateOcc.strike - expectedOcc.strike) < 0.001;
}

export function optionOrderId(order = {}) {
  const value = order.id ?? order.order_id ?? null;
  return value == null ? null : String(value);
}

export function optionOrderRefId(order = {}) {
  const value = order.ref_id ?? order.refId ?? order.client_order_id ?? null;
  return value == null ? null : String(value);
}

export function optionOrderTime(order = {}) {
  const raw = order.last_transaction_at || order.executed_at || order.updated_at
    || order.created_at || order.create_date || null;
  const ts = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function sideMatches(order, side) {
  if (!side) return true;
  return orderLegs(order).some(leg => {
    const rawSide = String(leg?.side || order.side || "").toLowerCase();
    const effect = String(leg?.position_effect || order.position_effect || "").toLowerCase();
    return side === "buy"
      ? (rawSide.includes("buy") && (!effect || effect === "open"))
      : (rawSide.includes("sell") && (!effect || effect === "close"));
  });
}

/**
 * Fail-closed order matcher. An expected order/ref id must exist and match exactly. Without one,
 * an exact instrument id or OCC is mandatory; ticker/type alone is never sufficient.
 */
export function findExactOptionOrder(orders = [], {
  orderId = null,
  refId = null,
  instrumentId = null,
  occSymbol = null,
  side = null,
  submittedAt = 0,
  now = Date.now(),
} = {}) {
  const expectedOrderId = orderId == null ? null : String(orderId);
  const expectedRefId = refId == null ? null : String(refId);
  const expectedInstrumentId = normalizeOptionId(instrumentId);
  const expectedOcc = parseOccSymbol(occSymbol);
  if (!expectedOrderId && !expectedRefId && !expectedInstrumentId && !expectedOcc) return null;

  const candidates = (orders || []).filter(order => {
    // This bot only submits single-leg option orders. Reject spreads/rolls outright so a
    // sell/close leg and the expected instrument cannot be satisfied by two different legs.
    if (orderLegs(order).length !== 1) return false;
    if (expectedOrderId) {
      if (optionOrderId(order) !== expectedOrderId) return false;
    } else if (expectedRefId && optionOrderRefId(order) !== expectedRefId) {
      return false;
    }
    if (!sideMatches(order, side)) return false;

    const timestamp = optionOrderTime(order);
    if (submittedAt > 0 && (!(timestamp > 0) || timestamp < submittedAt - 60_000)) return false;
    if (timestamp > now + 60_000) return false;

    if (expectedInstrumentId) {
      const exactLeg = orderLegs(order).some(leg => optionIds(leg).includes(expectedInstrumentId));
      if (!exactLeg) return false;
    } else if (expectedOcc) {
      const exactLeg = orderLegs(order).some(leg => {
        const identity = legIdentity(leg, order);
        return identity.ticker === expectedOcc.ticker
          && identity.type === expectedOcc.type
          && identity.expiration === expectedOcc.expiration
          && identity.strike != null
          && Math.abs(identity.strike - expectedOcc.strike) < 0.001;
      });
      if (!exactLeg) return false;
    }
    return true;
  });

  candidates.sort((a, b) => optionOrderTime(b) - optionOrderTime(a));
  return candidates[0] || null;
}

export function optionOrderExecutions(order = {}) {
  const executions = [];
  for (const leg of orderLegs(order)) {
    if (Array.isArray(leg?.executions)) executions.push(...leg.executions);
  }
  if (Array.isArray(order.executions)) executions.push(...order.executions);
  const seen = new Set();
  return executions.filter(execution => {
    const key = execution?.id || `${execution?.timestamp || ""}:${execution?.price || ""}:${execution?.quantity || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function optionOrderExecutedQuantity(order = {}) {
  const processed = positive(order.processed_quantity ?? order.filled_quantity ?? order.cumulative_quantity);
  if (processed != null) return processed;
  const executions = optionOrderExecutions(order);
  if (executions.length) {
    return executions.reduce((sum, execution) => sum + (positive(execution?.quantity) || 0), 0);
  }
  return 0;
}

export function optionOrderAverageFillPrice(order = {}) {
  const processedPremium = positive(order.processed_premium);
  const processedQuantity = positive(order.processed_quantity ?? order.filled_quantity ?? order.cumulative_quantity);
  if (processedPremium != null && processedQuantity != null) {
    return processedPremium / (processedQuantity * 100);
  }
  const executions = optionOrderExecutions(order)
    .map(execution => ({ price: positive(execution?.price), qty: positive(execution?.quantity) }))
    .filter(row => row.price != null && row.qty != null);
  if (executions.length) {
    const qty = executions.reduce((sum, row) => sum + row.qty, 0);
    return qty > 0 ? executions.reduce((sum, row) => sum + row.price * row.qty, 0) / qty : null;
  }
  return null;
}

/** Cumulative executed premium in per-share-dollars × contracts (e.g. 0.80 × 2 = 1.60). */
export function optionOrderExecutedGross(order = {}) {
  const processedPremium = positive(order.processed_premium);
  if (processedPremium != null) return processedPremium / 100;
  const executions = optionOrderExecutions(order)
    .map(execution => ({ price: positive(execution?.price), qty: positive(execution?.quantity) }))
    .filter(row => row.price != null && row.qty != null);
  if (executions.length) return executions.reduce((sum, row) => sum + row.price * row.qty, 0);
  return 0;
}

export function optionOrderRemainingQuantity(order = {}) {
  const pending = Number(order.pending_quantity ?? order.remaining_quantity);
  if (Number.isFinite(pending) && pending >= 0) return pending;
  const requested = positive(order.quantity);
  return requested == null ? null : Math.max(0, requested - optionOrderExecutedQuantity(order));
}

export function optionOrderIsTerminal(order = {}) {
  const state = String(order.state || order.status || "").toLowerCase();
  return ["filled", "rejected", "cancelled", "canceled", "failed", "voided", "expired", "error"].includes(state);
}
