import test from "node:test";
import assert from "node:assert/strict";

import {
  EXIT_INFLIGHT_GRACE_MS,
  chooseOptionSellLimit,
  exitIntentWithinGrace,
  exitLimitSanityCheck,
  isEmergencyExitReason,
  mergeInflightTickers,
} from "../exit-execution.js";

test("PATH regression: $0.25 bid vs ~$0.86 mark implies phantom spot slip — refuse", () => {
  const sanity = exitLimitSanityCheck({
    limit: 0.25,
    bid: 0.25,
    ask: 0.90,
    mark: 0.86,
    spot: 11.70,
    entrySpot: 11.63,
    entryPremium: 0.85,
    delta: 0.45,
    optionType: "call",
    reason: "time-decay exit -6% after 9.0d",
  });
  assert.equal(sanity.ok, false);
  assert.match(sanity.reason, /phantom underlying|no matching spot slip|book dislocation/);
});

test("real adverse stock slip can justify a deep premium sell", () => {
  // δ0.50 × $3 spot drop = $1.50 premium — selling $0.40 vs $0.90 mark after a crash is explained.
  const sanity = exitLimitSanityCheck({
    limit: 0.40,
    bid: 0.40,
    ask: 0.45,
    mark: 0.42,
    spot: 9.00,
    entrySpot: 12.00,
    entryPremium: 1.80,
    delta: 0.50,
    optionType: "call",
    reason: "spot stop: underlying down 25%",
  });
  assert.equal(sanity.ok, true);
});

test("sane bid near mark is allowed for profit banks", () => {
  const sanity = exitLimitSanityCheck({
    limit: 0.83,
    bid: 0.83,
    ask: 0.89,
    mark: 0.86,
    spot: 11.70,
    entrySpot: 11.63,
    entryPremium: 0.85,
    delta: 0.55,
    optionType: "call",
    reason: "single-contract profit bank +12%",
  });
  assert.equal(sanity.ok, true);
});

test("entry collapse without spot slip is refused even if mark is also dirty", () => {
  // Contaminated mark=0.30 still can't explain $0.85→$0.25 with flat stock.
  const sanity = exitLimitSanityCheck({
    limit: 0.25,
    bid: 0.25,
    ask: 0.30,
    mark: 0.28,
    spot: 11.70,
    entrySpot: 11.63,
    entryPremium: 0.85,
    delta: 0.45,
    optionType: "call",
    reason: "time-decay exit",
  });
  assert.equal(sanity.ok, false);
  assert.match(sanity.reason, /collapses premium|phantom|spot only slipped/);
});

test("isEmergencyExitReason recognizes time-critical and confirmed protective exits", () => {
  assert.equal(isEmergencyExitReason("DTE critical (2.1d remaining)"), true);
  assert.equal(isEmergencyExitReason("low-DTE tight stop -22% (4.0d left)"), true);
  assert.equal(isEmergencyExitReason("disaster stop -70%"), true);
  assert.equal(isEmergencyExitReason("confirmed premium stop -27% (limit -25%)"), true);
  assert.equal(isEmergencyExitReason("sustained wide-book premium stop -32% after 3.0m"), true);
  assert.equal(isEmergencyExitReason("time-decay exit -6% after 9.0d"), false);
  assert.equal(isEmergencyExitReason("spot stop: underlying down 5%"), false);
});

test("a confirmed premium stop on a coherent NBBO is not vetoed by delta attribution", () => {
  const sanity = exitLimitSanityCheck({
    limit: 0.72,
    bid: 0.72,
    ask: 0.76,
    mark: 0.74,
    referencePrice: 0.74,
    spot: 100,
    entrySpot: 100,
    entryPremium: 1,
    delta: 0.40,
    optionType: "call",
    reason: "confirmed premium stop -28% (limit -25%)",
  });

  assert.equal(sanity.ok, true);
  assert.equal(sanity.confirmedBook, true);
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

test("bank intent submits at the executable bid rather than an unfilled midpoint", () => {
  const result = chooseOptionSellLimit({ bid: 0.83, ask: 0.91, mark: 0.87, priceMode: "bank" });
  assert.equal(result.limit, 0.83);
  assert.equal(result.executableNow, true);
});

test("patient pricing may rest at midpoint", () => {
  const result = chooseOptionSellLimit({ bid: 0.76, ask: 0.84, priceMode: "patient" });
  assert.equal(result.limit, 0.80);
});

test("wide-book stop escalation starts with a patient protective limit above the raw bid", () => {
  const result = chooseOptionSellLimit({
    bid: 0.68,
    ask: 1.12,
    mark: 0.90,
    priceMode: "patient",
    protective: true,
  });

  assert.equal(result.limit, 0.79);
  assert.ok(result.limit > 0.68);
  assert.ok(result.spreadPct > 0.20);
});

test("wide-book escalation sanity allows patient pricing but rejects a phantom raw bid", () => {
  const common = {
    bid: 0.25,
    ask: 1.45,
    mark: 0.85,
    referencePrice: 0.85,
    spot: 11.70,
    entrySpot: 11.63,
    entryPremium: 0.85,
    delta: 0.45,
    optionType: "call",
    reason: "sustained wide-book premium stop -71% after 3.0m (patient protective exit)",
  };

  const patient = exitLimitSanityCheck({ ...common, limit: 0.75 });
  const raw = exitLimitSanityCheck({ ...common, limit: 0.25 });

  assert.equal(patient.ok, true);
  assert.equal(raw.ok, false);
  assert.equal(raw.rawWideBookBid, true);
  assert.match(raw.reason, /raw wide-book bid|not corroborated/);
});

test("wide-book protective retries step down without ever entering the quarantined raw-bid band", () => {
  const common = {
    bid: 0.68,
    ask: 1.12,
    mark: 0.90,
    referencePrice: 0.90,
    spot: 100,
    entrySpot: 100,
    entryPremium: 1,
    delta: 0.40,
    optionType: "call",
    reason: "sustained wide-book premium stop -32% after 3.0m (patient protective exit)",
  };
  const sequence = [0, 1, 2, 3].map(exitAttempts => {
    const pricing = chooseOptionSellLimit({
      ...common,
      priceMode: "patient",
      protective: true,
      exitAttempts,
    });
    const sanity = exitLimitSanityCheck({ ...common, limit: pricing.limit });
    return { ...pricing, sanity };
  });

  assert.deepEqual(sequence.map(step => step.limit), [0.79, 0.74, 0.70, 0.70]);
  assert.ok(sequence.every(step => step.limit > common.bid + 0.01));
  assert.ok(sequence.every(step => step.sanity.ok));
  assert.equal(sequence[0].operatorEscalation, false);
  assert.equal(sequence[2].operatorEscalation, true);
  assert.match(sequence[2].escalationReason, /guarded floor/i);
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
