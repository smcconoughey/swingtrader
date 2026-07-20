import test from "node:test";
import assert from "node:assert/strict";

import {
  portfolioEntryBlock,
  recordPortfolioOutcome,
  rollPortfolioRiskState,
  tradingWeekKey,
} from "../portfolio-risk.js";

test("week keys roll on Monday and treat Sunday as the prior week", () => {
  assert.equal(tradingWeekKey("2026-07-19"), "2026-07-13");
  assert.equal(tradingWeekKey("2026-07-20"), "2026-07-20");
});

test("portfolio high water persists while the weekly baseline rolls", () => {
  const friday = rollPortfolioRiskState({}, { pv: 1_000, dateKey: "2026-07-17", now: 1 });
  const monday = rollPortfolioRiskState(friday, { pv: 950, dateKey: "2026-07-20", now: 2 });
  assert.equal(monday.highWaterPV, 1_000);
  assert.equal(monday.weekStartPV, 950);
  assert.equal(monday.weekKey, "2026-07-20");
});

test("loss streak and cooldown persist across daily resets until a win", () => {
  const first = recordPortfolioOutcome({}, { pnlDollar: -10, now: 1_000, lossCooldownMs: 60_000 });
  const second = recordPortfolioOutcome(first, { pnlDollar: -5, now: 2_000, lossCooldownMs: 60_000 });
  assert.equal(second.consecutiveLosses, 2);
  assert.equal(portfolioEntryBlock({ risk: second, pv: 1_000, config: { maxConsecutiveLosses: 2 }, now: 3_000 }).kind, "loss_cooldown");
  const winner = recordPortfolioOutcome(second, { pnlDollar: 1, now: 100_000 });
  assert.equal(winner.consecutiveLosses, 0);
});

test("weekly and high-water drawdown blocks do not reset each day", () => {
  const risk = {
    consecutiveLosses: 0,
    cooldownUntil: 0,
    weekStartPV: 1_000,
    highWaterPV: 1_100,
  };
  const weekly = portfolioEntryBlock({
    risk,
    pv: 955,
    config: { weeklyLossLimitPct: 0.04, highWaterDrawdownLimitPct: 0.20 },
  });
  assert.equal(weekly.kind, "weekly_loss");
  const highWater = portfolioEntryBlock({
    risk,
    pv: 1_040,
    config: { weeklyLossLimitPct: 0.20, highWaterDrawdownLimitPct: 0.05 },
  });
  assert.equal(highWater.kind, "high_water_drawdown");
});
