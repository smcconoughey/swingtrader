const TERMINAL_STATUSES = new Set([
  "filled", "canceled", "cancelled", "rejected", "expired", "error",
]);

const finitePositive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function tradierOrderId(order = {}) {
  return order.id ?? order.order_id ?? null;
}

export function tradierOrderIsTerminal(order = {}) {
  return TERMINAL_STATUSES.has(String(order.status || order.state || "").toLowerCase());
}

export function tradierOrderExecutedQuantity(order = {}) {
  // `quantity` is requested size, not proof of execution. Only execution-specific fields count.
  const explicit = finitePositive(
    order.exec_quantity
      ?? order.executed_quantity
      ?? order.filled_quantity
      ?? order.quantity_filled,
  );
  if (explicit > 0) return explicit;
  // A terminal `filled` status is itself authoritative proof that the whole requested quantity ran.
  return String(order.status || order.state || "").toLowerCase() === "filled"
    ? finitePositive(order.quantity)
    : 0;
}

export function tradierOrderAverageFillPrice(order = {}) {
  const average = finitePositive(order.avg_fill_price ?? order.average_fill_price);
  if (average > 0) return average;
  // Tradier documents `last_fill_price` as only the latest execution slice, while
  // `exec_quantity` is cumulative. It is therefore a valid cumulative price only when exactly
  // one contract/share executed; for multi-fill orders, fail closed until avg_fill_price exists.
  return tradierOrderExecutedQuantity(order) === 1
    ? finitePositive(order.last_fill_price)
    : 0;
}

function orderTimestamp(order = {}) {
  // Creation time identifies the submission. Transaction time may be the much-later fill and is
  // unsuitable for deciding whether a no-ID legacy intent owns this order.
  const raw = order.create_date ?? order.created_at ?? order.transaction_date ?? order.updated_at;
  const parsed = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSellToClose(order = {}) {
  const side = String(order.side || "").toLowerCase();
  return side === "sell_to_close" || side === "sell";
}

/**
 * Match an exit intent to one broker order. Exact order identity wins. The legacy fallback is
 * deliberately fail-closed: if more than one same-contract/order-size candidate exists, none is
 * selected, because guessing can book one execution more than once.
 */
export function matchTradierExitOrder(orders = [], trade = {}, claimedOrderIds = new Set()) {
  const exactId = trade._exitOrderId != null ? String(trade._exitOrderId) : null;
  if (exactId) {
    if (claimedOrderIds.has(exactId)) return null;
    return orders.find(order => String(tradierOrderId(order) ?? "") === exactId) || null;
  }

  const occ = String(trade._occ || "");
  const submittedAt = Number(trade._exitSubmittedAt) || 0;
  const requestedQty = finitePositive(trade._requestedQty ?? trade.qty);
  const candidates = orders.filter(order => {
    const id = tradierOrderId(order);
    if (id != null && claimedOrderIds.has(String(id))) return false;
    if (!isSellToClose(order)) return false;
    if (String(order.option_symbol || order.symbol || "") !== occ) return false;
    const requestedByBroker = finitePositive(order.quantity);
    if (requestedQty > 0 && requestedByBroker > 0 && requestedByBroker !== requestedQty) return false;
    const at = orderTimestamp(order);
    return at > 0 && at >= submittedAt - 60_000 && at <= submittedAt + 5 * 60_000;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Compute the newly-confirmed part of a cumulative Tradier execution. Callers persist the returned
 * cumulative values, so repeated broker snapshots never double-book the same contracts.
 */
export function tradierFillDelta(trade = {}, order = {}, feePerContract = 0) {
  const requestedQty = finitePositive(trade._requestedQty ?? trade.qty);
  const cumulativeQty = tradierOrderExecutedQuantity(order);
  const averageFillPrice = tradierOrderAverageFillPrice(order);
  if (!(requestedQty > 0)) return { ok: false, reason: "missing requested quantity" };
  if (cumulativeQty > requestedQty + 1e-9) {
    return { ok: false, reason: "broker execution exceeds requested quantity" };
  }
  if (cumulativeQty > 0 && !(averageFillPrice > 0)) {
    return { ok: false, reason: "executed quantity has no authoritative fill price" };
  }

  const bookedQty = Math.max(0, Number(trade._bookedFillQty) || 0);
  const bookedRealPnl = Number(trade._bookedRealPnl) || 0;
  if (cumulativeQty + 1e-9 < bookedQty) {
    return { ok: false, reason: "broker cumulative quantity regressed" };
  }

  const entryCostPerContract = finitePositive(trade._entryCostPerContract)
    || finitePositive(trade.entryPremium) * 100;
  const exitFees = feePerContract * cumulativeQty;
  const grossProceeds = averageFillPrice * cumulativeQty * 100;
  const netProceeds = grossProceeds - exitFees;
  const costBasis = entryCostPerContract * cumulativeQty;
  const cumulativeRealPnl = netProceeds - costBasis;

  return {
    ok: true,
    terminal: tradierOrderIsTerminal(order),
    requestedQty,
    cumulativeQty,
    deltaQty: cumulativeQty - bookedQty,
    averageFillPrice,
    grossProceeds,
    netProceeds,
    exitFees,
    costBasis,
    cumulativeRealPnl,
    deltaRealPnl: cumulativeRealPnl - bookedRealPnl,
  };
}

/**
 * Apply only the newly-authoritative execution delta to an exact-OCC trim tier. The returned meta
 * is a copy so callers can persist it atomically; submissions and unfilled quantities never advance
 * trimLevel.
 */
export function applyTradierTrimFill(meta = {}, trade = {}, fill = {}) {
  const next = { ...meta };
  const level = Math.floor(Number(trade._trimTargetLevel) || 0);
  const deltaQty = finitePositive(fill.deltaQty);
  if (!(level > 0) || !(deltaQty > 0)) {
    return { meta: next, updated: false, completed: false, level: level || null };
  }

  const targetQty = Math.max(
    finitePositive(fill.requestedQty),
    finitePositive(trade._trimTargetQty),
    finitePositive(next.trimPendingTargetQty),
  );
  if (!(targetQty > 0)) {
    return { meta: next, updated: false, completed: false, level };
  }

  if (Number(next.trimPendingLevel) !== level) {
    next.trimPendingLevel = level;
    next.trimPendingTargetQty = targetQty;
    next.trimPendingFilledQty = 0;
  }
  next.trimPendingTargetQty = Math.max(finitePositive(next.trimPendingTargetQty), targetQty);
  next.trimPendingFilledQty = Math.min(
    next.trimPendingTargetQty,
    finitePositive(next.trimPendingFilledQty) + deltaQty,
  );
  const completed = next.trimPendingFilledQty >= next.trimPendingTargetQty - 1e-9;
  if (completed) {
    next.trimLevel = Math.max(Math.floor(Number(next.trimLevel) || 0), level);
    delete next.trimPendingLevel;
    delete next.trimPendingTargetQty;
    delete next.trimPendingFilledQty;
  }

  return {
    meta: next,
    updated: true,
    completed,
    level,
    targetQty,
    filledQty: completed ? targetQty : next.trimPendingFilledQty,
  };
}

export function isConfirmedTradeOutcome(trade = {}) {
  return !trade._pendingFill && !trade._nonFill && !trade._fillUnresolved;
}
