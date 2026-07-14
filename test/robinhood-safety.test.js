import test from "node:test";
import assert from "node:assert/strict";

import {
  exactOptionQuoteMatches,
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
