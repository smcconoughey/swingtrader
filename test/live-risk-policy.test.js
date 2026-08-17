import test from "node:test";
import assert from "node:assert/strict";

import { applyLiveRiskPolicy, normalizeLiveRiskConfig } from "../live-risk-policy.js";

test("explicit live settings are never silently rewritten", () => {
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

  assert.equal(config.strategyPreset, "march1m");
  assert.equal(config.baseRiskPct, 1);
  assert.equal(config.riskPerTradePct, 0.005);
  assert.equal(config.maxPositionPct, 0.10);
  assert.equal(config.stopLoss, -0.25);
  assert.equal(config.profitTarget, 0.12);
  assert.equal(config.dailyLossLimitPct, 0.22);
  assert.equal(config.maxConsecutiveLosses, 4);
  assert.equal(config.maxDayTrades, 3);
  assert.equal(config.maxPositions, 6);
  assert.equal(config.useCashReserve, false);
  assert.equal(config.learningEnabled, true);
  assert.equal(config.liveEntriesEnabled, true);
  assert.equal(config.requireEntryApproval, true);
  assert.equal(config.requireLossExitApproval, true);
  assert.ok(changes.length > 0);
});

test("quick-profit values remain exactly as configured", () => {
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
  assert.equal(config.profitTarget, 0.10);
  assert.equal(config.liveEntriesEnabled, true);
});

test("allocation, reserve, and even invalid explicit values remain visible rather than silently clamped", () => {
  const { config } = normalizeLiveRiskConfig({
    broker: "robinhood",
    baseRiskPct: 5,
    maxPositionPct: 0.35,
    stopLoss: -2,
    profitTarget: 0.001,
    useCashReserve: false,
    liveEntriesEnabled: true,
  });
  assert.equal(config.baseRiskPct, 5);
  assert.equal(config.maxPositionPct, 0.35);
  assert.equal(config.stopLoss, -2);
  assert.equal(config.profitTarget, 0.001);
  assert.equal(config.useCashReserve, false);
  assert.equal(config.liveEntriesEnabled, true);
});

test("paper accounts are not rewritten by the live policy", () => {
  const account = { config: { broker: "paper", baseRiskPct: 0.50, useCashReserve: false } };
  assert.deepEqual(applyLiveRiskPolicy(account), []);
  assert.equal(account.config.baseRiskPct, 0.50);
  assert.equal(account.config.useCashReserve, false);
});

test("legacy Robinhood account keeps the pre-Jarvis analysis and migrates execution once", () => {
  const account = {
    config: {
      broker: "robinhood",
      useCashReserve: true,
      maxDayTrades: 2,
    },
  };
  const changes = applyLiveRiskPolicy(account);

  assert.equal(account.config.traderCopilotVersion, 3);
  assert.equal(account.config.liveEntriesEnabled, true);
  assert.equal(account.config.autoExecute, true);
  assert.equal(account.config.requireEntryApproval, true);
  assert.equal(account.config.requireLossExitApproval, true);
  assert.equal(account.config.entrySizingMode, "one_contract");
  assert.equal(account.config.portfolioHaltsEnabled, false);
  assert.equal(account.config.useCashReserve, false);
  assert.equal(account.config.maxDayTrades, null);
  assert.equal(account.config.maxPositions, null);
  assert.equal(account.config.strategyPreset, "quicktp");
  assert.equal(account.config.dailyObjectivePct, 0.10);
  assert.equal(account.config.profitTarget, 0.12);
  assert.equal(account.config.stopLoss, -0.20);
  assert.equal(account.config.adaptiveProfitTarget, true);
  assert.equal(account.config.maxTradeSize, null);
  assert.ok(changes.length > 0);

  assert.deepEqual(applyLiveRiskPolicy(account), []);
});
