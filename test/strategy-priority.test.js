import test from "node:test";
import assert from "node:assert/strict";

import {
  directionalConviction,
  directionalSetupQuality,
  contractExecutionScore,
  completeTradeScore,
  entryPriority,
  momentumEntryGate,
  rankEntryCandidates,
  rankPreparedEntries,
} from "../strategy-priority.js";

test("setup quality cannot use an uptrend to qualify a bearish entry", () => {
  const put = directionalSetupQuality(
    { quality: 80, bullishQuality: 80, bearishQuality: 20 },
    { quality: 90, direction: "up" },
    false,
  );
  assert.deepEqual(put, {
    quality: 20,
    baseQuality: 20,
    momentumQuality: 0,
    directionMatched: false,
  });
});

test("direction-matched momentum may qualify calls and puts symmetrically", () => {
  assert.equal(directionalSetupQuality({}, { quality: 75, direction: "up" }, true).quality, 75);
  assert.equal(directionalSetupQuality({}, { quality: 75, direction: "down" }, false).quality, 75);
});

test("directional conviction makes lower put scores stronger", () => {
  assert.equal(directionalConviction({ action: "BUY CALL", finalScore: 82 }), 82);
  assert.equal(directionalConviction({ action: "BUY PUT", finalScore: 10 }), 90);
  assert.equal(directionalConviction({ action: "BUY PUT", finalScore: 34 }), 66);
});

test("strong bearish setup ranks above weaker bearish setup", () => {
  const decisions = [
    { ticker: "WEAK", action: "BUY PUT", finalScore: 34 },
    { ticker: "STRONG", action: "BUY PUT", finalScore: 10 },
  ];
  const shortTerm = {
    WEAK: { mom1d: -2, mom3d: -3 },
    STRONG: { mom1d: -2, mom3d: -3 },
  };
  const quotes = { WEAK: { dp: -2 }, STRONG: { dp: -2 } };
  assert.deepEqual(rankEntryCandidates(decisions, shortTerm, quotes).map(x => x.ticker), ["STRONG", "WEAK"]);
});

test("aligned momentum breaks ties without overpowering conviction", () => {
  const moving = entryPriority(
    { action: "BUY CALL", finalScore: 75 },
    { mom1d: 3, mom3d: 5 },
    { dp: 2.5 },
  );
  const flat = entryPriority(
    { action: "BUY CALL", finalScore: 75 },
    { mom1d: 0.2, mom3d: 0.3 },
    { dp: 0.1 },
  );
  assert.ok(moving > flat);
  assert.ok(entryPriority({ action: "BUY CALL", finalScore: 90 }, {}, {}) > moving);
});

test("mid-tier call is blocked on flat tape", () => {
  assert.match(
    momentumEntryGate({}, { score: 75 }, { mom1d: 0.4 }, { dp: 0.8 }, true),
    /day flat/,
  );
});

test("exceptional call may enter on flat tape but never against the tape", () => {
  assert.equal(momentumEntryGate({}, { score: 85 }, { mom1d: 0.1 }, { dp: 0.1 }, true), null);
  assert.match(
    momentumEntryGate({}, { score: 85 }, { mom1d: -2 }, { dp: -3 }, true),
    /against the trade/,
  );
});

test("exceptional put may enter on flat tape but never against the tape", () => {
  assert.equal(momentumEntryGate({}, { score: 15 }, { mom1d: -0.1 }, { dp: -0.1 }, false), null);
  assert.match(
    momentumEntryGate({}, { score: 15 }, { mom1d: 2 }, { dp: 3 }, false),
    /against the trade/,
  );
});

test("momentum gate can be explicitly disabled", () => {
  assert.equal(momentumEntryGate({ momentumGate: false }, { score: 70 }, {}, { dp: -10 }, true), null);
});

test("contract execution score rewards tight liquid contracts near target delta and DTE", () => {
  const clean = contractExecutionScore({ spreadPct: 4, oi: 5000, volume: 900, delta: 0.55, dte: 28 });
  const costly = contractExecutionScore({ spreadPct: 28, oi: 6, volume: 0, delta: 0.40, dte: 14 });
  assert.ok(clean > 90);
  assert.ok(costly < 35);
});

test("complete trade score can move a superior executable package ahead of a ticker-only leader", () => {
  const prepared = [
    {
      ticker: "FLASHY",
      dec: { ticker: "FLASHY", action: "BUY CALL", finalScore: 82 },
      preflight: {
        setupQuality: 56,
        claudeConfidence: 60,
        contract: { spreadPct: 28, oi: 6, volume: 0, delta: 0.40, dte: 14 },
      },
    },
    {
      ticker: "CLEAN",
      dec: { ticker: "CLEAN", action: "BUY CALL", finalScore: 77 },
      preflight: {
        setupQuality: 92,
        claudeConfidence: 88,
        contract: { spreadPct: 4, oi: 5000, volume: 900, delta: 0.55, dte: 28 },
      },
    },
  ];
  const st = { FLASHY: { mom1d: 3, mom3d: 4 }, CLEAN: { mom1d: 2, mom3d: 4 } };
  const quotes = { FLASHY: { dp: 3 }, CLEAN: { dp: 2 } };
  const ranked = rankPreparedEntries(prepared, st, quotes);
  assert.equal(ranked[0].ticker, "CLEAN");
  assert.ok(ranked[0].packagePriority > ranked[1].packagePriority);
});

test("complete trade score is symmetric for equally strong calls and puts", () => {
  const preflight = {
    setupQuality: 80,
    claudeConfidence: 80,
    contract: { spreadPct: 8, oi: 1000, volume: 100, delta: 0.55, dte: 28 },
  };
  const call = completeTradeScore(
    { action: "BUY CALL", finalScore: 85 },
    { mom1d: 2, mom3d: 4 },
    { dp: 2 },
    preflight,
  );
  const put = completeTradeScore(
    { action: "BUY PUT", finalScore: 15 },
    { mom1d: -2, mom3d: -4 },
    { dp: -2 },
    preflight,
  );
  assert.equal(call.score, put.score);
});
