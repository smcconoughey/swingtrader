import test from "node:test";
import assert from "node:assert/strict";

import {
  EXIT_INFLIGHT_GRACE_MS,
  chooseOptionSellLimit,
  exitIntentWithinGrace,
  mergeInflightTickers,
} from "../exit-execution.js";

test("profit-bank sell limit is the executable bid, never a midpoint", () => {
  const result = chooseOptionSellLimit({
    bid: 0.76,
    ask: 0.84,
    mark: 0.80,
    referencePrice: 0.80,
    priceMode: "bank",
  });
  assert.equal(result.limit, 0.76);
  assert.equal(result.executableNow, true);
});

test("marketable protective exit also uses the exact bid", () => {
  const result = chooseOptionSellLimit({
    bid: 3.24,
    ask: 3.34,
    mark: 3.29,
    priceMode: "marketable",
    protective: true,
  });
  assert.equal(result.limit, 3.24);
});

test("marketable protective retry crosses one tick after a stale first attempt", () => {
  const result = chooseOptionSellLimit({
    bid: 3.24,
    ask: 3.34,
    mark: 3.29,
    priceMode: "marketable",
    protective: true,
    exitAttempts: 1,
  });
  assert.equal(result.limit, 3.23);
});

test("bank intent is blocked when there is no executable bid", () => {
  const result = chooseOptionSellLimit({ ask: 0.84, mark: 0.80, priceMode: "bank" });
  assert.equal(result.limit, null);
});

test("patient pricing may rest at midpoint", () => {
  const result = chooseOptionSellLimit({ bid: 0.76, ask: 0.84, priceMode: "patient" });
  assert.equal(result.limit, 0.80);
});

test("persisted exit intent survives broker snapshot lag through the stale-order window", () => {
  const placedAt = Date.UTC(2026, 6, 13, 15, 0, 0);
  const meta = { exitOrderPlacedAt: placedAt, exitOrderTicker: "PATH" };
  assert.equal(exitIntentWithinGrace(meta, placedAt + 3 * 60_000), true);
  assert.equal(exitIntentWithinGrace(meta, placedAt + EXIT_INFLIGHT_GRACE_MS + 1), false);
});

test("failed broker snapshot preserves prior locks and fresh local exit intents", () => {
  const now = Date.UTC(2026, 6, 13, 15, 0, 0);
  const merged = mergeInflightTickers({
    brokerTickers: [],
    previousTickers: ["SPY"],
    brokerSnapshotComplete: false,
    localIntents: [{ ticker: "PATH", placedAt: now - 30_000, graceMs: EXIT_INFLIGHT_GRACE_MS }],
    now,
  });
  assert.deepEqual([...merged].sort(), ["PATH", "SPY"]);
});

test("successful empty broker snapshot releases expired local exit intent", () => {
  const now = Date.UTC(2026, 6, 13, 15, 0, 0);
  const merged = mergeInflightTickers({
    brokerTickers: [],
    previousTickers: ["PATH"],
    brokerSnapshotComplete: true,
    localIntents: [{ ticker: "PATH", placedAt: now - EXIT_INFLIGHT_GRACE_MS - 1, graceMs: EXIT_INFLIGHT_GRACE_MS }],
    now,
  });
  assert.deepEqual([...merged], []);
});
