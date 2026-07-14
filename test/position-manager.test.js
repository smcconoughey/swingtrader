import test from "node:test";
import assert from "node:assert/strict";

import {
  createManagementPlan,
  evaluatePosition,
  managementPlanFor,
} from "../position-manager.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 13, 16, 0, 0);

function basePosition(overrides = {}) {
  return {
    ticker: "TEST",
    type: "call",
    entryPremium: 1,
    intendedEntryPremium: 1.25,
    entrySpot: 100,
    entryAtrPct: 1.5,
    dte: 30,
    dteRemaining: 25,
    openTime: NOW - 2 * DAY,
    qty: 1,
    originalQty: 1,
    trimLevel: 0,
    bestPnlPct: 0,
    bestExitPnlPct: 0,
    ...overrides,
  };
}

function marchPlan(position, overrides = {}) {
  return {
    ...createManagementPlan({
      profitTarget: 0.12,
      trim1Pct: 0.10,
      trim2Pct: 0.18,
      stopLoss: -0.25,
      bullEntry: 64,
      bearEntry: 36,
    }, position, NOW),
    ...overrides,
  };
}

function evaluate(positionOverrides = {}, marketOverrides = {}, signalOverrides = {}, planOverrides = {}) {
  const position = basePosition(positionOverrides);
  const plan = marchPlan(position, planOverrides);
  return evaluatePosition({
    position,
    plan,
    market: {
      spot: 100,
      mark: 1,
      bid: 1,
      dteRemaining: position.dteRemaining,
      requireExecutableBid: true,
      etHour: 11,
      isFriday: false,
      ...marketOverrides,
    },
    signals: { score: 70, ...signalOverrides },
    now: NOW,
  });
}

test("SPY regression: intended limit is ignored and a shallow long-DTE premium loss is not a stop", () => {
  const decision = evaluate(
    {
      ticker: "SPY",
      entryPremium: 4.69,
      intendedEntryPremium: 5.23,
      entrySpot: 755,
      dte: 15,
      dteRemaining: 15,
      openTime: NOW - 40 * 60_000,
      entryAtrPct: 0.8,
    },
    { spot: 752, mark: 3.30, bid: 3.24, dteRemaining: 15 },
    { score: 72 },
  );

  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "HOLD_THESIS");
  assert.ok(decision.metrics.exitPnlPct < -0.30);
  assert.ok(decision.metrics.exitPnlPct > decision.plan.disasterFloor);
});

test("one-contract position banks at trim-one threshold instead of entering a no-op dead zone", () => {
  const decision = evaluate({}, { mark: 1.12, bid: 1.11 });
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "SINGLE_CONTRACT_BANK");
  assert.equal(decision.qty, 1);
});

test("multi-contract position still performs a partial first trim", () => {
  const decision = evaluate({ qty: 4, originalQty: 4 }, { mark: 1.12, bid: 1.11 });
  assert.equal(decision.action, "trim");
  assert.equal(decision.reasonCode, "TRIM_1");
  assert.equal(decision.qty, 1);
});

test("quick-bank plan closes the post-trim remainder at target instead of advertising a dead trim two", () => {
  const decision = evaluate(
    { qty: 3, originalQty: 4, trimLevel: 1 },
    { mark: 1.14, bid: 1.13 },
  );
  assert.equal(decision.plan.exitMode, "quick_bank");
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "PROFIT_TARGET");
});

test("runner plan reaches trim two before its higher final target", () => {
  const position = basePosition({ qty: 4, originalQty: 4, trimLevel: 1 });
  const plan = createManagementPlan({
    profitTarget: 0.80,
    trim1Pct: 0.30,
    trim2Pct: 0.60,
  }, position, NOW);
  const decision = evaluatePosition({
    position,
    plan,
    market: {
      spot: 100,
      mark: 1.68,
      bid: 1.65,
      dteRemaining: 25,
      requireExecutableBid: true,
      etHour: 11,
      isFriday: false,
    },
    signals: { score: 70 },
    now: NOW,
  });
  assert.equal(plan.exitMode, "runner");
  assert.equal(decision.action, "trim");
  assert.equal(decision.reasonCode, "TRIM_2");
});

test("one-contract runner arms EMA management at trim two instead of issuing an impossible trim", () => {
  const position = basePosition({ qty: 1, originalQty: 2, trimLevel: 1 });
  const plan = createManagementPlan({
    profitTarget: 0.80,
    trim1Pct: 0.30,
    trim2Pct: 0.60,
  }, position, NOW);
  const decision = evaluatePosition({
    position,
    plan,
    market: {
      spot: 100,
      mark: 1.68,
      bid: 1.65,
      dteRemaining: 25,
      requireExecutableBid: true,
      etHour: 11,
      isFriday: false,
    },
    signals: { score: 70 },
    now: NOW,
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "RUNNER_ARMED");
  assert.equal(decision.statePatch.trimLevel, 2);
});

test("runner is not converted into a quick-bank exit by pre-trim giveback", () => {
  const position = basePosition({ qty: 4, originalQty: 4, trimLevel: 0, bestExitPnlPct: 0.25 });
  const plan = createManagementPlan({ profitTarget: 0.80, trim1Pct: 0.30, trim2Pct: 0.60 }, position, NOW);
  const decision = evaluatePosition({
    position,
    plan,
    market: {
      spot: 100,
      mark: 1.15,
      bid: 1.14,
      dteRemaining: 25,
      requireExecutableBid: true,
      etHour: 15.9,
      isFriday: false,
    },
    signals: { score: 70 },
    now: NOW,
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "HOLD_THESIS");
});

test("peak giveback is managed before 3 PM", () => {
  const decision = evaluate(
    { bestExitPnlPct: 0.20 },
    { mark: 1.13, bid: 1.09, etHour: 11 },
  );
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "PEAK_GIVEBACK");
});

test("profit decisions use executable bid rather than a flattering mark", () => {
  const decision = evaluate({}, { mark: 1.20, bid: 1.08 });
  assert.equal(decision.action, "hold");
  assert.equal(decision.metrics.markPnlPct.toFixed(2), "0.20");
  assert.equal(decision.metrics.exitPnlPct.toFixed(2), "0.08");
});

test("live option with no exact executable bid cannot produce an order intent", () => {
  const decision = evaluate({}, { mark: 1.20, bid: 0 });
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "NO_EXECUTABLE_BID");
});

test("unverified Robinhood contract holds before false critical-DTE logic can run", () => {
  const position = basePosition({
    ticker: "SPY",
    strike: 755,
    dte: 0,
    dteRemaining: 0,
    expiryDate: 0,
    contractIdentityVerified: false,
  });
  const decision = evaluatePosition({
    position,
    plan: marchPlan(position),
    market: {
      spot: 755,
      mark: 3.30,
      bid: 3.24,
      dteRemaining: 0,
      requireExecutableBid: true,
      requireVerifiedContract: true,
      contractIdentityVerified: false,
      requireFreshQuote: true,
      quoteAsOf: NOW,
      maxQuoteAgeMs: 45_000,
    },
    signals: { score: 72 },
    now: NOW,
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "UNKNOWN_CONTRACT");
});

test("stale exact-contract quote holds instead of submitting from an old bid", () => {
  const position = basePosition({ contractIdentityVerified: true });
  const decision = evaluatePosition({
    position,
    plan: marchPlan(position),
    market: {
      spot: 100,
      mark: 1.20,
      bid: 1.15,
      dteRemaining: 25,
      requireExecutableBid: true,
      requireVerifiedContract: true,
      contractIdentityVerified: true,
      requireFreshQuote: true,
      quoteAsOf: NOW - 45_001,
      maxQuoteAgeMs: 45_000,
    },
    signals: { score: 70 },
    now: NOW,
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "STALE_CONTRACT_QUOTE");
});

test("long-dated option down 6% after two days holds when thesis remains intact", () => {
  const decision = evaluate(
    { dte: 31, dteRemaining: 25, openTime: NOW - 2 * DAY },
    { mark: 0.96, bid: 0.94, dteRemaining: 25 },
    { score: 68 },
  );
  assert.equal(decision.action, "hold");
  assert.equal(decision.reasonCode, "HOLD_THESIS");
  assert.ok(decision.metrics.lifeConsumed < 0.35);
});

test("time decay exits only after meaningful life consumption and a weak thesis", () => {
  const decision = evaluate(
    { dte: 30, dteRemaining: 9, openTime: NOW - 21 * DAY },
    { mark: 0.92, bid: 0.90, dteRemaining: 9 },
    { score: 45 },
  );
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "TIME_DECAY_INVALIDATION");
});

test("an existing position keeps its frozen plan after account preset changes", () => {
  const position = basePosition();
  const frozen = createManagementPlan({ profitTarget: 0.12, trim1Pct: 0.10, trim2Pct: 0.18 }, position, NOW);
  position.managementPlan = frozen;
  const restored = managementPlanFor(position, { profitTarget: 0.80, trim1Pct: 0.30 }, NOW + DAY);
  assert.equal(restored, frozen);
  assert.equal(restored.profitTarget, 0.12);
  assert.equal(restored.trim1Pct, 0.10);
});

test("an imported broker position reconstructs its original option lifetime", () => {
  const position = basePosition({
    dte: 0,
    dteRemaining: 25,
    openTime: NOW - 6 * DAY,
    expiryDate: NOW + 25 * DAY,
  });
  const plan = createManagementPlan({}, position, NOW);
  assert.equal(plan.initialDte, 31);
});

test("critical DTE wins when profit and protective rules are simultaneously true", () => {
  const decision = evaluate(
    { dte: 30, dteRemaining: 2 },
    { mark: 1.25, bid: 1.20, dteRemaining: 2 },
  );
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "DTE_CRITICAL");
});

test("DTE-aware structural stop is symmetric for calls and puts", () => {
  const callDecision = evaluate(
    { type: "call", entryAtrPct: 2, entrySpot: 100 },
    { spot: 95.9, mark: 0.90, bid: 0.88 },
  );
  const putDecision = evaluate(
    { type: "put", entryAtrPct: 2, entrySpot: 100 },
    { spot: 104.1, mark: 0.90, bid: 0.88 },
    { score: 25 },
  );
  assert.equal(callDecision.reasonCode, "STRUCTURAL_SPOT_STOP");
  assert.equal(putDecision.reasonCode, "STRUCTURAL_SPOT_STOP");
});

test("stale underlying quote suppresses a structural spot exit", () => {
  const freshDecision = evaluate(
    { type: "call", entryAtrPct: 2, entrySpot: 100 },
    { spot: 95.9, mark: 0.90, bid: 0.88 },
  );
  const staleDecision = evaluate(
    { type: "call", entryAtrPct: 2, entrySpot: 100 },
    { spot: 95.9, mark: 0.90, bid: 0.88, underlyingQuoteFresh: false },
  );

  assert.equal(freshDecision.reasonCode, "STRUCTURAL_SPOT_STOP");
  assert.equal(staleDecision.action, "hold");
  assert.equal(staleDecision.reasonCode, "HOLD_THESIS");
  assert.equal(staleDecision.metrics.underlyingQuoteFresh, false);
});

test("stale underlying quote suppresses thesis invalidation", () => {
  const freshDecision = evaluate(
    { type: "call", entrySpot: 100 },
    { spot: 97.5, mark: 0.92, bid: 0.90 },
    { score: 30 },
  );
  const staleDecision = evaluate(
    { type: "call", entrySpot: 100 },
    { spot: 97.5, mark: 0.92, bid: 0.90, underlyingQuoteFresh: false },
    { score: 30 },
  );

  assert.equal(freshDecision.reasonCode, "THESIS_INVALIDATED");
  assert.equal(staleDecision.action, "hold");
  assert.equal(staleDecision.reasonCode, "HOLD_THESIS");
  assert.equal(staleDecision.metrics.thesisState, "unknown");
});

test("stale underlying quote does not suppress an exact-bid premium disaster exit", () => {
  const decision = evaluate(
    { type: "call", entrySpot: 100 },
    { spot: 95, mark: 0.40, bid: 0.39, underlyingQuoteFresh: false },
    { score: 20, break8: true, stalling: true },
  );

  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "PREMIUM_DISASTER");
});

test("stale underlying quote suppresses EMA and analysis-derived stall exits", () => {
  const position = basePosition({ qty: 1, originalQty: 2, trimLevel: 2 });
  const plan = createManagementPlan({
    profitTarget: 0.80,
    trim1Pct: 0.30,
    trim2Pct: 0.60,
  }, position, NOW);
  const market = {
    spot: 100,
    mark: 1.22,
    bid: 1.20,
    dteRemaining: 25,
    requireExecutableBid: true,
    underlyingQuoteFresh: false,
    etHour: 15.2,
    isFriday: false,
  };

  const emaDecision = evaluatePosition({
    position,
    plan,
    market: { ...market, etHour: 11 },
    signals: { score: 20, break8: true },
    now: NOW,
  });
  const stallDecision = evaluatePosition({
    position,
    plan,
    market,
    signals: { score: 20, stalling: true },
    now: NOW,
  });

  assert.equal(emaDecision.action, "hold");
  assert.equal(emaDecision.reasonCode, "HOLD_THESIS");
  assert.equal(stallDecision.action, "hold");
  assert.equal(stallDecision.reasonCode, "HOLD_THESIS");
});

test("manager state tracks mark and executable high-water marks independently", () => {
  const decision = evaluate(
    { bestPnlPct: 0.15, bestExitPnlPct: 0.08 },
    { mark: 1.18, bid: 1.09 },
    {},
    { profitLockArmPct: 0.20 },
  );
  assert.equal(decision.statePatch.bestPnlPct.toFixed(2), "0.18");
  assert.equal(decision.statePatch.bestExitPnlPct.toFixed(2), "0.09");
});
