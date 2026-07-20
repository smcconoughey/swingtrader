import test from "node:test";
import assert from "node:assert/strict";

import { sizeLongOptionEntry } from "../risk-governor.js";

function baseInput(overrides = {}) {
  return {
    accountEquity: 10_000,
    cash: 10_000,
    entryPrice: 1,
    stopLossPct: -0.25,
    profitTargetPct: 0.50,
    riskPerTradePct: 0.01,
    maxPositionPct: 0.25,
    ...overrides,
  };
}

test("sizes long options from loss at stop rather than capital allocation", () => {
  const result = sizeLongOptionEntry(baseInput());

  assert.equal(result.approved, true);
  assert.equal(result.quantity, 4);
  assert.deepEqual(result.bindingLimits, ["riskPerTrade"]);
  assert.equal(result.metrics.tradeRiskBudgetDollars, 100);
  assert.equal(result.metrics.maxLossPerContract, 25);
  assert.equal(result.metrics.expectedMaxLossDollars, 100);
  assert.equal(result.metrics.constraints.maxPositionPct.maxContracts, 25);
});

test("charges entry friction and round-trip fees against risk conservatively", () => {
  const result = sizeLongOptionEntry(baseInput({
    profitTargetPct: 0.60,
    entryFrictionPct: 0.05,
    entryFeePerContract: 0.35,
    exitFeePerContract: 0.35,
  }));

  assert.equal(result.approved, true);
  assert.equal(result.quantity, 3);
  assert.equal(result.metrics.premiumLossAtStopPerContract, 25);
  assert.equal(result.metrics.entryFrictionPerContract, 5);
  assert.equal(result.metrics.maxLossPerContract, 30.7);
  assert.equal(result.metrics.cashRequiredPerContract, 105.35);
  assert.equal(result.metrics.expectedMaxLossDollars, 92.1);
  assert.equal(result.metrics.rewardRiskRatio, 1.76873);
});

test("rejects a configured payoff below the default 1.5R minimum", () => {
  const result = sizeLongOptionEntry(baseInput({ profitTargetPct: 0.12 }));

  assert.equal(result.approved, false);
  assert.equal(result.quantity, 0);
  assert.equal(result.reasonCode, "REWARD_RISK_BELOW_MINIMUM");
  assert.deepEqual(result.failedLimits, ["minimumRewardRisk"]);
  assert.match(result.reason, /0\.48R.*1\.50R/);
  assert.equal(result.metrics.configuredRewardRiskRatio, 0.48);
  assert.equal(result.metrics.rewardRiskRatio, 0.48);
  assert.equal(result.metrics.minimumRewardRisk, 1.5);
  assert.equal(result.metrics.riskSizedQuantity, 4);
  assert.equal(result.metrics.expectedMaxLossDollars, 0);
});

test("allows an explicit reward/risk threshold override", () => {
  const result = sizeLongOptionEntry(baseInput({
    profitTargetPct: 0.12,
    minimumRewardRisk: 0.40,
  }));

  assert.equal(result.approved, true);
  assert.equal(result.metrics.rewardRiskRatio, 0.48);
  assert.equal(result.metrics.minimumRewardRisk, 0.4);
});

test("accepts an exact 1.5R payoff despite floating-point representation", () => {
  const result = sizeLongOptionEntry(baseInput({
    stopLossPct: -0.10,
    profitTargetPct: 0.15,
  }));

  assert.equal(result.approved, true);
  assert.equal(result.metrics.rewardRiskRatio, 1.5);
});

test("enforces position percentage, dollar cap, and cash as independent ceilings", () => {
  const result = sizeLongOptionEntry(baseInput({
    riskPerTradePct: 0.10,
    maxPositionPct: 0.05,
    maxPositionDollars: 350,
    cash: 250,
  }));

  assert.equal(result.approved, true);
  assert.equal(result.quantity, 2);
  assert.deepEqual(result.bindingLimits, ["cash"]);
  assert.equal(result.metrics.constraints.riskPerTrade.maxContracts, 40);
  assert.equal(result.metrics.constraints.maxPositionPct.maxContracts, 5);
  assert.equal(result.metrics.constraints.maxPositionDollars.maxContracts, 3);
  assert.equal(result.metrics.constraints.cash.maxContracts, 2);
  assert.equal(result.metrics.entryCashRequiredDollars, 200);
});

test("rejects instead of rounding up when one contract exceeds per-trade risk", () => {
  const result = sizeLongOptionEntry(baseInput({
    accountEquity: 1_000,
    riskPerTradePct: 0.01,
    maxPositionPct: 1,
  }));

  assert.equal(result.approved, false);
  assert.equal(result.quantity, 0);
  assert.equal(result.reasonCode, "ONE_CONTRACT_EXCEEDS_RISK");
  assert.deepEqual(result.failedLimits, ["riskPerTrade"]);
  assert.match(result.reason, /per-trade risk/);
  assert.equal(result.metrics.maxLossPerContract, 25);
  assert.equal(result.metrics.tradeRiskBudgetDollars, 10);
});

test("rejects when one contract exceeds an allocation ceiling despite fitting risk", () => {
  const result = sizeLongOptionEntry(baseInput({
    entryPrice: 2,
    maxPositionPct: 1,
    maxPositionDollars: 150,
  }));

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "ONE_CONTRACT_EXCEEDS_ALLOCATION");
  assert.deepEqual(result.failedLimits, ["maxPositionDollars"]);
  assert.equal(result.metrics.cashRequiredPerContract, 200);
  assert.equal(result.metrics.constraints.riskPerTrade.maxContracts, 2);
});

test("sizes against remaining aggregate open-risk capacity", () => {
  const result = sizeLongOptionEntry(baseInput({
    aggregateRiskBudgetDollars: 150,
    openRiskDollars: 90,
  }));

  assert.equal(result.approved, true);
  assert.equal(result.quantity, 2);
  assert.deepEqual(result.bindingLimits, ["aggregateOpenRisk"]);
  assert.equal(result.metrics.aggregateRiskRemainingDollars, 60);
  assert.equal(result.metrics.constraints.aggregateOpenRisk.maxContracts, 2);
  assert.equal(result.metrics.expectedMaxLossDollars, 50);
  assert.equal(result.metrics.postTradeAggregateOpenRiskDollars, 140);
});

test("rejects when remaining aggregate risk cannot hold one contract", () => {
  const result = sizeLongOptionEntry(baseInput({
    aggregateRiskBudgetDollars: 150,
    openRiskDollars: 140,
  }));

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "ONE_CONTRACT_EXCEEDS_RISK");
  assert.deepEqual(result.failedLimits, ["aggregateOpenRisk"]);
  assert.equal(result.metrics.aggregateRiskRemainingDollars, 10);
});

test("reports both risk and allocation failures when neither can fund one contract", () => {
  const result = sizeLongOptionEntry(baseInput({
    accountEquity: 1_000,
    cash: 50,
    riskPerTradePct: 0.01,
    maxPositionPct: 1,
  }));

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "ONE_CONTRACT_EXCEEDS_RISK_AND_ALLOCATION");
  assert.deepEqual(result.failedLimits, ["riskPerTrade", "cash"]);
});

test("reports an unfundable contract before a simultaneously weak payoff", () => {
  const result = sizeLongOptionEntry(baseInput({
    cash: 0,
    profitTargetPct: 0.12,
  }));

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "ONE_CONTRACT_EXCEEDS_ALLOCATION");
  assert.deepEqual(result.failedLimits, ["cash"]);
  assert.equal(result.metrics.rewardRiskRatio, 0.48);
});

test("fails closed with explicit validation errors", () => {
  const input = baseInput({
    accountEquity: Number.NaN,
    stopLossPct: 25,
    entryFeePerContract: -1,
  });
  const snapshot = structuredClone(input);
  const result = sizeLongOptionEntry(input);

  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(result.metrics, null);
  assert.match(result.reason, /accountEquity/);
  assert.match(result.reason, /stopLossPct/);
  assert.match(result.reason, /entryFeePerContract/);
  assert.deepEqual(input, snapshot);
});

test("fails closed when individually finite inputs overflow derived contract values", () => {
  const result = sizeLongOptionEntry(baseInput({ entryPrice: Number.MAX_VALUE }));

  assert.equal(result.approved, false);
  assert.equal(result.quantity, 0);
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.match(result.reason, /entryNotionalPerContract exceeds numeric range/);
});

test("never returns an infinite quantity for very large finite budgets", () => {
  const result = sizeLongOptionEntry(baseInput({
    accountEquity: Number.MAX_VALUE,
    cash: Number.MAX_VALUE,
    entryPrice: 1e300,
    contractMultiplier: 1,
    riskPerTradePct: 1,
    maxPositionPct: 1,
  }));

  assert.equal(result.approved, true);
  assert.equal(Number.isSafeInteger(result.quantity), true);
  assert.equal(Number.isFinite(result.quantity), true);
});

test("null input fails closed instead of throwing", () => {
  const result = sizeLongOptionEntry(null);

  assert.equal(result.approved, false);
  assert.equal(result.quantity, 0);
  assert.equal(result.reasonCode, "INVALID_INPUT");
});
