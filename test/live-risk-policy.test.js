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

test("users may tighten live risk rails but cannot loosen them", () => {
  const { config } = normalizeLiveRiskConfig({
    riskPerTradePct: 0.0025,
    maxPositionPct: 0.05,
    dailyLossLimitPct: 0.01,
    stopLoss: -0.10,
    profitTarget: 0.10,
  });

  assert.equal(config.riskPerTradePct, 0.0025);
  assert.equal(config.maxPositionPct, 0.05);
  assert.equal(config.dailyLossLimitPct, 0.01);
  assert.equal(config.stopLoss, -0.10);
  assert.equal(config.profitTarget, 0.15);
});

test("paper accounts are not rewritten by the live policy", () => {
  const account = { config: { broker: "paper", baseRiskPct: 0.50 } };
  assert.deepEqual(applyLiveRiskPolicy(account), []);
  assert.equal(account.config.baseRiskPct, 0.50);
});
