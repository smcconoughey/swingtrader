import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateLongOptionOpenRisk,
  computeLongOptionOpenRisk,
  longOptionContractKey,
} from "../open-risk.js";

const OCC = "KO260821C00085000";

test("counts a filled position once when its local metadata is the same settled intent", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{ occSymbol: OCC, type: "call", qty: 1, entryPremium: 2.24 }],
    metadata: {
      [OCC]: {
        entryPremium: 2.24,
        originalQty: 1,
        plannedRiskDollars: 45,
        entryOrderPlacedAt: 100,
        entryOrderCtx: { ticker: "KO", expStr: "2026-08-21", strike: 85, optionType: "call", qty: 1 },
      },
    },
  });

  assert.equal(result.totalRiskDollars, 45);
  assert.deepEqual(result.quantities, { filled: 1, working: 0, local: 0, total: 1 });
  assert.deepEqual(result.breakdown[0].quantities, { filled: 1, working: 0, local: 0, total: 1 });
  assert.equal(result.breakdown[0].components[0].method, "persisted-planned-risk");
});

test("adds a partial fill and only the broker order remainder for one exact contract", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{ occSymbol: OCC, type: "call", qty: 1, maxLossPerContract: 30 }],
    pendingOrders: [{
      option_symbol: OCC,
      side: "buy_to_open",
      status: "partially_filled",
      quantity: 3,
      filled_quantity: 1,
      order_id: "order-1",
    }],
    metadata: {
      [OCC]: {
        entryOrderId: "order-1",
        entryOrderPlacedAt: 100,
        entryOrderCtx: { ticker: "KO", expStr: "2026-08-21", strike: 85, optionType: "call", qty: 3 },
        riskGovernor: { maxLossPerContract: 30 },
      },
    },
  });

  assert.equal(result.totalRiskDollars, 90);
  assert.deepEqual(result.quantities, { filled: 1, working: 2, local: 0, total: 3 });
  assert.equal(result.breakdown.length, 1);
  assert.deepEqual(result.breakdown[0].quantities, { filled: 1, working: 2, local: 0, total: 3 });
});

test("prefers an explicit remaining quantity, including an explicit zero", () => {
  const input = {
    pendingOrders: [
      { occ: OCC, side: "buy", quantity: 5, remaining_quantity: 2, maxLossPerContract: 20 },
      { occ: "FIG260731C00023000", side: "buy", quantity: 5, remaining_quantity: 0, maxLossPerContract: 20 },
    ],
  };
  const result = calculateLongOptionOpenRisk(input);

  assert.equal(result.totalRiskDollars, 40);
  assert.deepEqual(result.quantities, { filled: 0, working: 2, local: 0, total: 2 });
  assert.equal(result.ignored.some(row => row.reason === "no-remaining-quantity"), true);
});

test("derives a remainder from Tradier exec quantity and Robinhood nested executions", () => {
  const result = computeLongOptionOpenRisk({
    pendingOrders: [
      {
        occ: OCC,
        side: "buy_to_open",
        quantity: 4,
        exec_quantity: 1,
        order_id: "tradier-partial",
        maxLossPerContract: 10,
      },
      {
        occ: "FIG260731C00023000",
        side: "buy_to_open",
        quantity: 4,
        legs: [{ executions: [{ quantity: "1" }, { quantity: "2" }] }],
        order_id: "rh-partial",
        maxLossPerContract: 10,
      },
    ],
  });

  assert.equal(result.totalRiskDollars, 40);
  assert.equal(result.quantities.working, 4);
});

test("does not double count mirrored pending-position and pending-order views", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{
      _pending: true,
      occSymbol: OCC,
      type: "call",
      qty: 2,
      orderId: "order-1",
      maxLossPerContract: 25,
    }],
    pendingOrders: [{
      option_symbol: OCC,
      side: "buy_to_open",
      remaining_quantity: 2,
      order_id: "order-1",
      maxLossPerContract: 25,
    }],
  });

  assert.equal(result.totalRiskDollars, 50);
  assert.equal(result.quantities.working, 2);
  assert.equal(result.breakdown[0].components.length, 1);
});

test("sums distinct working orders from one broker view", () => {
  const result = computeLongOptionOpenRisk({
    pendingOrders: [
      { occ: OCC, side: "buy_to_open", qty: 1, id: "a", maxLossPerContract: 25 },
      { occ: OCC, side: "buy_to_open", qty: 2, id: "b", maxLossPerContract: 25 },
    ],
  });

  assert.equal(result.totalRiskDollars, 75);
  assert.equal(result.quantities.working, 3);
  assert.equal(result.breakdown[0].components.length, 2);
});

test("local metadata supplies only requested risk not visible at the broker", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{ occSymbol: OCC, type: "call", qty: 1, entryPremium: 2 }],
    metadata: {
      [OCC]: {
        originalQty: 3,
        plannedRiskDollars: 90,
        entryOrderPlacedAt: 100,
        entryOrderCtx: { ticker: "KO", expStr: "2026-08-21", strike: 85, optionType: "call", qty: 3 },
      },
    },
  });

  assert.equal(result.totalRiskDollars, 90);
  assert.deepEqual(result.quantities, { filled: 1, working: 0, local: 2, total: 3 });
  assert.equal(result.breakdown[0].components.find(row => row.source === "local").riskDollars, 60);
});

test("planned total risk is divided by original quantity after a trim", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{
      occSymbol: OCC,
      type: "call",
      qty: 1,
      originalQty: 4,
      plannedRiskDollars: 120,
      entryPremium: 2,
    }],
  });

  assert.equal(result.totalRiskDollars, 30);
  assert.equal(result.breakdown[0].components[0].riskPerContract, 30);
});

test("fallback estimate includes stop loss, modeled friction, and round-trip fees", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{ occSymbol: OCC, type: "call", qty: 2, entryPremium: 2 }],
    stopLossPct: -0.20,
    entryFrictionPct: 0.025,
    frictionDollarsPerContract: 5,
    entryFeePerContract: 0.35,
    exitFeePerContract: 0.35,
  });

  // Per contract: $40 premium loss + $5 percentage friction + $5 dollar friction + $0.70 fees.
  assert.equal(result.totalRiskDollars, 101.4);
  assert.equal(result.breakdown[0].components[0].riskPerContract, 50.7);
  assert.equal(result.breakdown[0].components[0].method, "estimated-premium-stop-costs");
});

test("ignores equities, closing orders, terminal orders, and short-option rows", () => {
  const result = computeLongOptionOpenRisk({
    positions: [
      { ticker: "KO", type: "equity", qty: 10, entryPremium: 60 },
      { occSymbol: OCC, type: "call", positionSide: "short", qty: 1, entryPremium: 2 },
    ],
    pendingOrders: [
      { occ: OCC, side: "sell_to_close", qty: 1, price: 2 },
      { occ: OCC, side: "buy_to_open", status: "canceled", qty: 1, price: 2 },
    ],
  });

  assert.equal(result.totalRiskDollars, 0);
  assert.deepEqual(result.quantities, { filled: 0, working: 0, local: 0, total: 0 });
});

test("returns null total and diagnostics instead of treating unknown exposure as zero risk", () => {
  const result = computeLongOptionOpenRisk({
    positions: [{ occSymbol: OCC, type: "call", qty: 1 }],
  });

  assert.equal(result.complete, false);
  assert.equal(result.totalRiskDollars, null);
  assert.equal(result.knownRiskDollars, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].quantity, 1);
});

test("canonical tuple identity matches an OCC metadata key", () => {
  const tuple = {
    ticker: "ko",
    expirationDate: "2026-08-21T16:00:00-04:00",
    type: "call",
    strike: 85,
  };
  assert.equal(longOptionContractKey(tuple), `OCC:${OCC}`);

  const result = computeLongOptionOpenRisk({
    positions: [{ ...tuple, qty: 1, entryPremium: 2 }],
    metadata: { [OCC]: { riskGovernor: { maxLossPerContract: 22 } } },
  });
  assert.equal(result.totalRiskDollars, 22);
});

test("does not mutate positions, pending rows, or metadata", () => {
  const input = {
    positions: [{ occSymbol: OCC, type: "call", qty: 1, entryPremium: 2 }],
    pendingOrders: [{ occ: OCC, side: "buy", remaining_quantity: 1, price: 2 }],
    metadata: { [OCC]: { managementPlan: { stopLoss: -0.25 } } },
  };
  const before = structuredClone(input);
  computeLongOptionOpenRisk(input);
  assert.deepEqual(input, before);
});
