import test from "node:test";
import assert from "node:assert/strict";

import {
  clearEntryOrderTracking,
  entryIntentSatisfiedByHolding,
  exactOptionQuoteMatches,
  findBrokerCloseFillForPosition,
  findExactOptionOrder,
  isVerifiedRobinhoodContract,
  normalizeOptionId,
  optionOrderAverageFillPrice,
  optionOrderExecutedQuantity,
  optionOrderIsTerminal,
  resolveExactOptionIdentity,
  optionExpirationTimestamp,
} from "../robinhood-safety.js";

const CURRENT_ID = "a22787a7-ccf6-40bd-8b02-5fa6630cb108";
const OLD_ID = "11111111-1111-4111-8111-111111111111";

function order(id, expiration, overrides = {}) {
  return {
    id: `order-${id}`,
    chain_symbol: "PATH",
    state: "filled",
    updated_at: "2026-07-13T15:00:00Z",
    legs: [{
      option_id: id,
      side: "buy",
      position_effect: "open",
      option_type: "call",
      strike_price: "12",
      expiration_date: expiration,
      ...overrides,
    }],
  };
}

test("exact option identity ignores an older same-ticker call listed first", () => {
  const resolved = resolveExactOptionIdentity(
    `https://api.robinhood.com/options/instruments/${CURRENT_ID}/`,
    [order(OLD_ID, "2026-07-17"), order(CURRENT_ID, "2026-08-07")],
  );
  assert.deepEqual(resolved, {
    ticker: "PATH",
    type: "call",
    strike: 12,
    expiration: "2026-08-07",
    instrumentId: CURRENT_ID,
  });
});

test("same ticker/type/strike without the held instrument id remains unresolved", () => {
  assert.equal(resolveExactOptionIdentity(CURRENT_ID, [order(OLD_ID, "2026-07-17")]), null);
});

test("exact option instrument record resolves by its bare UUID id", () => {
  const resolved = resolveExactOptionIdentity(CURRENT_ID, [{
    id: CURRENT_ID,
    chain_symbol: "PATH",
    type: "call",
    strike_price: "12.0000",
    expiration_date: "2026-08-07",
  }]);
  assert.equal(resolved?.expiration, "2026-08-07");
  assert.equal(resolved?.strike, 12);
});

test("URL-form and UUID-form option ids normalize to the same value", () => {
  assert.equal(normalizeOptionId(`https://api.robinhood.com/options/instruments/${CURRENT_ID}/`), CURRENT_ID);
});

test("option expiry timestamp is 4 PM New York across daylight-saving seasons", () => {
  assert.equal(new Date(optionExpirationTimestamp("2026-08-07")).toISOString(), "2026-08-07T20:00:00.000Z");
  assert.equal(new Date(optionExpirationTimestamp("2027-01-15")).toISOString(), "2027-01-15T21:00:00.000Z");
});

test("unmatched singleton quote is rejected", () => {
  const position = { instrumentUrl: CURRENT_ID, occSymbol: "PATH260807C00012000" };
  assert.equal(exactOptionQuoteMatches(position, { option_id: OLD_ID, bid_price: "0.76" }), false);
  assert.equal(exactOptionQuoteMatches(position, {
    option_id: OLD_ID,
    symbol: "PATH260807C00012000",
    bid_price: "0.76",
  }), false);
});

test("verified contract requires exact identity, expiry, strike, and option type", () => {
  const base = {
    ticker: "PATH",
    type: "call",
    strike: 12,
    expiryDate: Date.parse("2026-08-07T16:00:00Z"),
    occSymbol: "PATH260807C00012000",
    instrumentUrl: CURRENT_ID,
    verifiedInstrumentId: CURRENT_ID,
    contractIdentityVerified: true,
  };
  assert.equal(isVerifiedRobinhoodContract(base), true);
  assert.equal(isVerifiedRobinhoodContract({ ...base, expiryDate: 0 }), false);
  assert.equal(isVerifiedRobinhoodContract({ ...base, contractIdentityVerified: false }), false);
  assert.equal(isVerifiedRobinhoodContract({ ...base, verifiedInstrumentId: OLD_ID }), false);
});

test("exact order id is strict and multi-execution fill uses cumulative quantity and VWAP", () => {
  const target = {
    id: "exit-1",
    state: "partially_filled",
    updated_at: "2026-07-13T15:02:00Z",
    legs: [{
      option_id: CURRENT_ID,
      side: "sell",
      position_effect: "close",
      executions: [
        { id: "x1", price: "0.80", quantity: "1" },
        { id: "x2", price: "0.90", quantity: "2" },
      ],
    }],
  };
  const wrong = { ...target, id: "exit-2" };
  const found = findExactOptionOrder([wrong, target], {
    orderId: "exit-1",
    refId: "ref-not-returned-by-order-list",
    instrumentId: CURRENT_ID,
    side: "sell",
    submittedAt: Date.parse("2026-07-13T15:00:00Z"),
  });
  assert.equal(found, target);
  assert.equal(optionOrderExecutedQuantity(found), 3);
  assert.equal(optionOrderAverageFillPrice(found).toFixed(4), "0.8667");
  assert.equal(optionOrderIsTerminal(found), false);
});

test("multi-leg rolls cannot satisfy side and identity on different legs", () => {
  const roll = {
    id: "roll-1",
    state: "filled",
    updated_at: "2026-07-13T15:02:00Z",
    legs: [
      {
        option_id: CURRENT_ID,
        side: "buy",
        position_effect: "open",
        option_type: "call",
        strike_price: "12",
        expiration_date: "2026-08-07",
      },
      {
        option_id: OLD_ID,
        side: "sell",
        position_effect: "close",
        option_type: "call",
        strike_price: "12",
        expiration_date: "2026-07-17",
      },
    ],
  };

  assert.equal(findExactOptionOrder([roll], {
    instrumentId: CURRENT_ID,
    side: "sell",
  }), null);
  // Even the leg whose identity and side agree is rejected: bot reconciliation is single-leg only.
  assert.equal(findExactOptionOrder([roll], {
    instrumentId: OLD_ID,
    side: "sell",
  }), null);
});

test("canceled partial order remains discoverable by exact id", () => {
  const partial = {
    id: "exit-canceled",
    state: "cancelled",
    processed_quantity: "1",
    processed_premium: "76",
    updated_at: "2026-07-13T15:05:00Z",
    legs: [{ option_id: CURRENT_ID, side: "sell", position_effect: "close" }],
  };
  const found = findExactOptionOrder([partial], {
    orderId: "exit-canceled",
    instrumentId: CURRENT_ID,
    side: "sell",
  });
  assert.equal(found, partial);
  assert.equal(optionOrderExecutedQuantity(found), 1);
  assert.equal(optionOrderAverageFillPrice(found), 0.76);
  assert.equal(optionOrderIsTerminal(found), true);
});

test("processed premium is divided by cumulative processed quantity, not treated as a quote", () => {
  const orderSnapshot = { processed_quantity: "2", processed_premium: "160" };
  assert.equal(optionOrderExecutedQuantity(orderSnapshot), 2);
  assert.equal(optionOrderAverageFillPrice(orderSnapshot), 0.80);
});

test("expired and error orders are terminal while replaced remains unresolved", () => {
  assert.equal(optionOrderIsTerminal({ state: "expired" }), true);
  assert.equal(optionOrderIsTerminal({ status: "ERROR" }), true);
  assert.equal(optionOrderIsTerminal({ state: "replaced" }), false);
  assert.equal(optionOrderIsTerminal({ state: "confirmed" }), false);
});

test("an exact fully established holding releases stale entry quarantine", () => {
  const placedAt = Date.parse("2026-07-13T15:00:00Z");
  const meta = {
    entryOrderId: "entry-1",
    entryOrderRefId: "ref-1",
    entryOrderPlacedAt: placedAt,
    entryFirstPlacedAt: placedAt,
    entryOrderLimit: 2.18,
    entryOrderCtx: { ticker: "KO", qty: 1 },
  };

  assert.equal(entryIntentSatisfiedByHolding(meta, {
    heldQuantity: 1,
    averageFillPrice: 2.24,
    positionCreatedAt: placedAt + 30_000,
  }), true);
  assert.equal(clearEntryOrderTracking(meta), true);
  assert.equal(meta.entryOrderPlacedAt, undefined);
  assert.equal(meta.entryOrderCtx, undefined);
  assert.equal(meta.entryOrderLimit, 2.18);
});

test("partial or unrelated holdings cannot release an entry quarantine", () => {
  const placedAt = Date.parse("2026-07-13T15:00:00Z");
  const meta = {
    entryOrderPlacedAt: placedAt,
    entryOrderLimit: 2,
    entryOrderCtx: { ticker: "KO", qty: 2 },
  };

  assert.equal(entryIntentSatisfiedByHolding(meta, {
    heldQuantity: 1,
    averageFillPrice: 2,
    positionCreatedAt: placedAt + 30_000,
  }), false);
  assert.equal(entryIntentSatisfiedByHolding(meta, {
    heldQuantity: 2,
    averageFillPrice: 2,
    positionCreatedAt: placedAt + 2 * 60 * 60_000,
  }), false);
});

test("broker close fill is found for a flat account when holdings disappear", () => {
  const HPE_ID = "22df30c2-c1ef-4278-a87f-54bdc10f3686";
  const openTime = Date.parse("2026-07-14T13:59:01Z");
  const closeOrder = {
    id: "6a5e2351-c90c-4a9a-b8dc-9256ce79ce2c",
    chain_symbol: "HPE",
    state: "filled",
    updated_at: "2026-07-20T13:32:01.699055Z",
    processed_quantity: "1.00000",
    processed_premium: "241",
    legs: [{
      option_id: HPE_ID,
      side: "sell",
      position_effect: "close",
      expiration_date: "2026-08-21",
      strike_price: "50.0000",
      option_type: "call",
      executions: [{
        price: "2.41000000",
        quantity: "1.00000",
        timestamp: "2026-07-20T13:32:01.388000Z",
      }],
    }],
  };
  const oldKoClose = {
    id: "old-ko-close",
    chain_symbol: "KO",
    state: "filled",
    updated_at: "2026-07-06T13:42:37Z",
    processed_quantity: "1.00000",
    processed_premium: "260",
    legs: [{
      option_id: "84569651-cb1b-442c-a403-261b0ed50a0e",
      side: "sell",
      position_effect: "close",
      expiration_date: "2026-08-21",
      strike_price: "85.0000",
      option_type: "call",
      executions: [{ price: "2.60000000", quantity: "1.00000", timestamp: "2026-07-06T13:42:37Z" }],
    }],
  };

  const match = findBrokerCloseFillForPosition([oldKoClose, closeOrder], {
    instrumentId: HPE_ID,
    occSymbol: "HPE260821C00050000",
    openTime,
    expectedQty: 1,
    now: Date.parse("2026-07-21T12:00:00Z"),
  });

  assert.equal(match?.fillPrice, 2.41);
  assert.equal(match?.executedQty, 1);
  assert.equal(match?.order?.id, closeOrder.id);
});

test("broker close fill ignores sells before the position opened or already booked", () => {
  const HPE_ID = "22df30c2-c1ef-4278-a87f-54bdc10f3686";
  const openTime = Date.parse("2026-07-14T13:59:01Z");
  const closeOrder = {
    id: "booked-close",
    state: "filled",
    updated_at: "2026-07-20T13:32:01Z",
    processed_quantity: "1.00000",
    processed_premium: "241",
    legs: [{
      option_id: HPE_ID,
      side: "sell",
      position_effect: "close",
      expiration_date: "2026-08-21",
      strike_price: "50.0000",
      option_type: "call",
      executions: [{ price: "2.41000000", quantity: "1.00000", timestamp: "2026-07-20T13:32:01Z" }],
    }],
  };

  assert.equal(findBrokerCloseFillForPosition([closeOrder], {
    instrumentId: HPE_ID,
    openTime: openTime - 86400000,
    expectedQty: 1,
    excludeOrderIds: ["booked-close"],
    now: Date.parse("2026-07-21T12:00:00Z"),
  }), null);
});
