import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTradierTrimFill,
  isConfirmedTradeOutcome,
  matchTradierExitOrder,
  tradierFillDelta,
  tradierOrderExecutedQuantity,
  tradierOrderIsTerminal,
} from "../tradier-fill-accounting.js";

const trade = {
  _occ: "SPY260821C00600000",
  _exitSubmittedAt: Date.parse("2026-07-17T15:00:00Z"),
  _requestedQty: 2,
  _entryCostPerContract: 100,
  entryPremium: 1,
};

test("requested order quantity is never treated as executed quantity", () => {
  assert.equal(tradierOrderExecutedQuantity({ status: "canceled", quantity: 2 }), 0);
  assert.equal(tradierOrderExecutedQuantity({ status: "filled", quantity: 2 }), 2);
});

test("pending and unresolved non-fills remain permanently ineligible outcomes", () => {
  assert.equal(isConfirmedTradeOutcome({}), true);
  assert.equal(isConfirmedTradeOutcome({ _pendingFill: true }), false);
  assert.equal(isConfirmedTradeOutcome({ _nonFill: true }), false);
  assert.equal(isConfirmedTradeOutcome({ _fillUnresolved: true }), false);
});

test("partial-then-cancelled execution is terminal but books only the actual fill", () => {
  const result = tradierFillDelta(trade, {
    status: "canceled",
    quantity: 2,
    exec_quantity: 1,
    avg_fill_price: 1.25,
  }, 0.05);

  assert.equal(tradierOrderIsTerminal({ status: "canceled" }), true);
  assert.equal(result.ok, true);
  assert.equal(result.terminal, true);
  assert.equal(result.cumulativeQty, 1);
  assert.equal(result.deltaQty, 1);
  assert.equal(result.netProceeds, 124.95);
  assert.ok(Math.abs(result.deltaRealPnl - 24.95) < 1e-9);
});

test("cumulative snapshots book only newly executed quantity and P&L", () => {
  const result = tradierFillDelta({
    ...trade,
    _bookedFillQty: 1,
    _bookedRealPnl: 24.95,
  }, {
    status: "filled",
    quantity: 2,
    exec_quantity: 2,
    avg_fill_price: 1.30,
  }, 0.05);

  assert.equal(result.deltaQty, 1);
  assert.ok(Math.abs(result.cumulativeRealPnl - 59.90) < 1e-9);
  assert.ok(Math.abs(result.deltaRealPnl - 34.95) < 1e-9);
});

test("trim tier advances only after authoritative fills complete the persisted exact-OCC target", () => {
  const trimTrade = {
    ...trade,
    _trimTargetLevel: 1,
    _trimTargetQty: 2,
  };
  const submittedOnly = applyTradierTrimFill({}, trimTrade, { requestedQty: 2, deltaQty: 0 });
  assert.equal(submittedOnly.updated, false);
  assert.equal(submittedOnly.meta.trimLevel, undefined);

  const firstFill = applyTradierTrimFill({
    trimPendingLevel: 1,
    trimPendingTargetQty: 2,
    trimPendingFilledQty: 0,
  }, trimTrade, { requestedQty: 2, deltaQty: 1 });
  assert.equal(firstFill.completed, false);
  assert.equal(firstFill.meta.trimLevel, undefined);
  assert.equal(firstFill.meta.trimPendingFilledQty, 1);

  // A retry requests only the remaining contract, but retains the original 2-contract tier target.
  const completed = applyTradierTrimFill(firstFill.meta, trimTrade, { requestedQty: 1, deltaQty: 1 });
  assert.equal(completed.completed, true);
  assert.equal(completed.meta.trimLevel, 1);
  assert.equal(completed.meta.trimPendingLevel, undefined);
  assert.equal(completed.meta.trimPendingTargetQty, undefined);
  assert.equal(completed.meta.trimPendingFilledQty, undefined);
});

test("exact order id wins while ambiguous fallback refuses to guess", () => {
  const orders = [
    { id: 10, side: "sell_to_close", option_symbol: trade._occ, quantity: 2, create_date: "2026-07-17T15:00:01Z" },
    { id: 11, side: "sell_to_close", option_symbol: trade._occ, quantity: 2, create_date: "2026-07-17T15:00:02Z" },
  ];
  assert.equal(matchTradierExitOrder(orders, trade), null);
  assert.equal(matchTradierExitOrder(orders, { ...trade, _exitOrderId: 11 })?.id, 11);
  assert.equal(matchTradierExitOrder(orders, { ...trade, _exitOrderId: 11 }, new Set(["11"])), null);
});

test("legacy no-id fallback cannot steal a later same-contract order", () => {
  const later = {
    id: 12,
    side: "sell_to_close",
    option_symbol: trade._occ,
    quantity: 2,
    create_date: "2026-07-17T16:00:00Z",
  };
  assert.equal(matchTradierExitOrder([later], trade), null);
});

test("an execution larger than the submitted intent fails closed", () => {
  const result = tradierFillDelta(trade, {
    status: "filled",
    exec_quantity: 3,
    avg_fill_price: 1.20,
  }, 0.05);
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds requested/i);
});

test("a last-fill price cannot masquerade as the average of a cumulative multi-fill", () => {
  const multiFill = tradierFillDelta(trade, {
    status: "filled",
    exec_quantity: 2,
    last_fill_price: 1.25,
  }, 0.05);
  assert.equal(multiFill.ok, false);
  assert.match(multiFill.reason, /authoritative fill price/i);

  const singleFill = tradierFillDelta({ ...trade, _requestedQty: 1 }, {
    status: "filled",
    exec_quantity: 1,
    last_fill_price: 1.25,
  }, 0.05);
  assert.equal(singleFill.ok, true);
  assert.equal(singleFill.averageFillPrice, 1.25);
});
