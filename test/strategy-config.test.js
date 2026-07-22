import test from "node:test";
import assert from "node:assert/strict";

import { completeStrategyConfig, QUICK_PROFIT_CONFIG } from "../strategy-config.js";
import { createManagementPlan, evaluatePosition } from "../position-manager.js";
import { sizeLongOptionEntry } from "../risk-governor.js";

test("quick profits atomically clears stale exit and reward-risk values", () => {
  const current = {
    broker: "robinhood",
    singleContractBankPct: 0.50,
    profitTarget: 0.80,
    trim1Pct: 0.30,
    trim2Pct: 0.60,
    minimumRewardRisk: 1.50,
    exitMode: "runner",
  };
  const baseline = {
    liveEntriesEnabled: true,
    riskPerTradePct: 0.005,
    maxPortfolioRiskPct: 0.02,
  };

  const config = completeStrategyConfig(current, baseline, QUICK_PROFIT_CONFIG);

  assert.equal(config.broker, "robinhood");
  assert.equal(config.liveEntriesEnabled, true);
  assert.equal(config.profitTarget, 0.12);
  assert.equal(config.stopLoss, -0.20);
  assert.equal(config.trim1Pct, 0.12);
  assert.equal(config.trim2Pct, 0.12);
  assert.equal(config.singleContractBankPct, 0.12);
  assert.equal(config.minimumRewardRisk, 0.35);
  assert.equal(config.exitMode, "quick_bank");
  assert.equal(config.adaptiveProfitTarget, true);
  assert.equal(config.adaptiveTargetMinPct, 0.10);
  assert.equal(config.adaptiveTargetMaxPct, 0.15);
  assert.equal(config.adaptiveTargetFallbackPct, 0.12);
  assert.equal(config.adaptiveTargetReachRate, 0.65);
  assert.equal(config.positionManagementMs, 5_000);
  assert.equal(config.riskPerTradePct, 0.02);
  assert.equal(config.maxPortfolioRiskPct, 0.04);
  assert.equal(config.maxPositionPct, 0.10);
  assert.equal(config.dailyLossLimitPct, 0.04);
  assert.equal(config.maxDayTrades, 2);
});

test("quick profits closes a one-contract position at the visible 12% fallback target", () => {
  const now = Date.now();
  const position = {
    ticker: "SPY",
    type: "call",
    strike: 750,
    qty: 1,
    originalQty: 1,
    trimLevel: 0,
    entryPremium: 1,
    entrySpot: 750,
    openTime: now - 60_000,
    dte: 21,
  };
  const plan = createManagementPlan(QUICK_PROFIT_CONFIG, position, now);
  const decision = evaluatePosition({
    position,
    plan,
    market: {
      spot: 752,
      bid: 1.12,
      mark: 1.13,
      dteRemaining: 21,
      requireExecutableBid: true,
      etHour: 11,
      isFriday: false,
    },
    signals: { score: 75 },
    now,
  });

  assert.equal(plan.singleContractBankPct, 0.12);
  assert.equal(decision.action, "close");
  assert.equal(decision.reasonCode, "PROFIT_TARGET");
});

test("quick profits can fund one tight-spread contract in an $850 account", () => {
  const decision = sizeLongOptionEntry({
    accountEquity: 850,
    cash: 850,
    entryPrice: 0.50,
    stopLossPct: QUICK_PROFIT_CONFIG.stopLoss,
    profitTargetPct: QUICK_PROFIT_CONFIG.profitTarget,
    minimumRewardRisk: QUICK_PROFIT_CONFIG.minimumRewardRisk,
    riskPerTradePct: QUICK_PROFIT_CONFIG.riskPerTradePct,
    maxPositionPct: QUICK_PROFIT_CONFIG.maxPositionPct,
    aggregateRiskBudgetDollars: 850 * QUICK_PROFIT_CONFIG.maxPortfolioRiskPct,
    exitFrictionDollarsPerContract: 1,
    entryFeePerContract: 0.03,
    exitFeePerContract: 0.03,
  });

  assert.equal(decision.approved, true);
  assert.ok(decision.quantity >= 1);
  assert.ok(decision.metrics.expectedMaxLossDollars <= 17);
});
