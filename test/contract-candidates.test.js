import test from "node:test";
import assert from "node:assert/strict";

import { buildCandidateContracts, entryLimitPrice } from "../option-contracts.js";

const NOW = new Date("2026-07-13T12:00:00-05:00").getTime();

function chainWith(options) {
  return [{ expirationDate: "2026-08-07", dataSource: "tradier", options: { CALL: options, PUT: [] } }];
}

function contract(overrides = {}) {
  return {
    occSymbol: "XYZ260807C00100000",
    strike: 100,
    bid: 1.00,
    ask: 1.04,
    openInterest: 500,
    volume: 80,
    impliedVolatility: 0.45,
    delta: 0.55,
    theta: -0.04,
    ...overrides,
  };
}

test("candidate builder rejects missing and crossed asks", () => {
  const out = buildCandidateContracts(chainWith([
    contract({ ask: 0 }),
    contract({ occSymbol: "CROSSED", bid: 1.10, ask: 1.00 }),
    contract({ occSymbol: "VALID" }),
  ]), "call", 100, 12, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].occSymbol, "VALID");
});

test("candidate builder preserves expiration date, source, Greeks, and executable friction", () => {
  const [out] = buildCandidateContracts(chainWith([contract()]), "call", 100, 12, NOW);
  const expiry = new Date(out.expiryDate);
  assert.equal(`${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`, "2026-08-07");
  assert.equal(out.expiryStr, "2026-08-07");
  assert.equal(out.dataSource, "tradier");
  assert.equal(out.theta, -0.04);
  assert.ok(out.roundTripFrictionPct > 4 && out.roundTripFrictionPct < 5);
});

test("candidate builder requires meaningful OI or volume", () => {
  const out = buildCandidateContracts(chainWith([
    contract({ occSymbol: "EMPTY", openInterest: 99, volume: 49 }),
    contract({ occSymbol: "OI", openInterest: 100, volume: 0 }),
    contract({ occSymbol: "FLOW", openInterest: 0, volume: 50 }),
  ]), "call", 100, 12, NOW);
  assert.deepEqual(new Set(out.map(x => x.occSymbol)), new Set(["OI", "FLOW"]));
});

test("candidate builder fails closed when delta is missing or below the live minimum", () => {
  const out = buildCandidateContracts(chainWith([
    contract({ occSymbol: "MISSING", delta: null }),
    contract({ occSymbol: "NAN", delta: "not-a-number" }),
    contract({ occSymbol: "LOW", delta: 0.20 }),
    contract({ occSymbol: "VALID", delta: 0.45 }),
  ]), "call", 100, 12, NOW);

  assert.deepEqual(out.map(row => row.occSymbol), ["VALID"]);
});

test("entry limit remains between bid and ask and respects the overpay ceiling", () => {
  assert.equal(entryLimitPrice(1, 1.20, 1.10, 0), 1.10);
  assert.equal(entryLimitPrice(1, 1.20, 1.10, 1), 1.20);
  assert.equal(entryLimitPrice(1, 2, 1.10, 1), 1.26);
});
