import test from "node:test";
import assert from "node:assert/strict";

import { applyLiveRiskPolicy, normalizeLiveRiskConfig } from "../live-risk-policy.js";

test("the retired full-cash preset migrates to bounded capital-preservation settings", () => {
  const { config, changes } = normalizeLiveRiskConfig({
    broker: "robinhood",
    strategyPreset: "march1m",
    baseRiskPct: 1,
    profitTarget: 0.12,
    stopLoss: -0.25,
    dailyLossLimitPct: 0.22,
    maxConsecutiveLosses: 4,
    maxDayTrades: 3,
    maxPositions: 6,
    useCashReserve: false,
    learningEnabled: true,
  });

  assert.equal(config.strategyPreset, "capital");
  assert.equal(config.baseRiskPct, 0.10);
  assert.equal(config.riskPerTradePct, 0.005);
  assert.equal(config.maxPositionPct, 0.10);
  assert.equal(config.stopLoss, -0.20);
  assert.equal(config.profitTarget, 0.40);
  assert.equal(config.dailyLossLimitPct, 0.02);
  assert.equal(config.maxConsecutiveLosses, 2);
  assert.equal(config.maxDayTrades, 2);
  assert.equal(config.maxPositions, 3);
  assert.equal(config.useCashReserve, true);
  assert.equal(config.learningEnabled, false);
  assert.equal(config.liveEntriesEnabled, false);
  assert.ok(changes.length > 0);
});

test("users can raise allocation and disable cash reserve without silent reset", () => {
  const { config } = normalizeLiveRiskConfig({
    broker: "robinhood",
    strategyPreset: "quicktp",
    baseRiskPct: 0.35,
    maxPositionPct: 0.10, // stale ceiling from old hard rail
    profitTarget: 0.20,
    stopLoss: -0.20,
    useCashReserve: false,
    liveEntriesEnabled: true,
    dailyLossLimitPct: 0.05,
    maxConsecutiveLosses: 3,
  });

  assert.equal(config.strategyPreset, "quicktp");
  assert.equal(config.baseRiskPct, 0.35);
  assert.equal(config.maxPositionPct, 0.35);
  assert.equal(config.profitTarget, 0.20);
  assert.equal(config.stopLoss, -0.20);
  assert.equal(config.useCashReserve, false);
  assert.equal(config.liveEntriesEnabled, true);
  assert.equal(config.dailyLossLimitPct, 0.05);
  assert.equal(config.maxConsecutiveLosses, 3);
});

test("quick-profit targets are not inflated by a hidden 1.5R floor", () => {
  const { config } = normalizeLiveRiskConfig({
    profitTarget: 0.20,
    stopLoss: -0.20,
    minimumRewardRisk: 1.5,
  });
  assert.equal(config.profitTarget, 0.20);
});

test("absurd out-of-range values are still sanity-clamped", () => {
  const { config } = normalizeLiveRiskConfig({
    baseRiskPct: 5,
    stopLoss: -2,
    profitTarget: 0.001,
  });
  assert.equal(config.baseRiskPct, 1);
  assert.equal(config.maxPositionPct, 1);
  assert.equal(config.stopLoss, -0.50);
  assert.equal(config.profitTarget, 0.05);
});

test("paper accounts are not rewritten by the live policy", () => {
  const account = { config: { broker: "paper", baseRiskPct: 0.50, useCashReserve: false } };
  assert.deepEqual(applyLiveRiskPolicy(account), []);
  assert.equal(account.config.baseRiskPct, 0.50);
  assert.equal(account.config.useCashReserve, false);
});
