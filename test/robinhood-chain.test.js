import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRobinhoodOptionChain, robinhoodChainInstrumentIds } from "../robinhood-chain.js";

const NOW = Date.parse("2026-08-01T12:00:00-04:00");

test("Robinhood instruments and exact quotes normalize into candidate-builder shape", () => {
  const instruments = { results: [{
    id: "abc",
    chain_symbol: "RTX",
    expiration_date: "2026-08-21",
    strike_price: "220",
    type: "call",
  }] };
  const quotes = { results: [{
    instrument: "https://api.robinhood.com/options/instruments/abc/",
    bid_price: "2.72",
    ask_price: "3.00",
    open_interest: "1800",
    volume: "250",
    implied_volatility: "0.31",
    greeks: { delta: "0.48", theta: "-0.08" },
  }] };

  assert.deepEqual(robinhoodChainInstrumentIds(instruments, { symbol: "RTX", spot: 215, now: NOW }), ["abc"]);
  const chain = normalizeRobinhoodOptionChain(instruments, quotes, { symbol: "RTX", spot: 215, now: NOW });
  assert.equal(chain[0].dataSource, "robinhood");
  assert.equal(chain[0].options.CALL[0].bid, 2.72);
  assert.equal(chain[0].options.CALL[0].delta, 0.48);
});

test("chain normalization rejects crossed or out-of-horizon contracts", () => {
  const instruments = [{ id: "bad", chain_symbol: "RTX", expiration_date: "2026-08-07", strike_price: 220, type: "call" }];
  const quotes = [{ instrument_id: "bad", bid_price: 3, ask_price: 2 }];
  assert.deepEqual(normalizeRobinhoodOptionChain(instruments, quotes, { symbol: "RTX", spot: 215, now: NOW }), []);
});
