export const QUICK_PROFIT_CONFIG = Object.freeze({
  profitTarget: 0.12,
  stopLoss: -0.20,
  trim1Pct: 0.12,
  trim2Pct: 0.12,
  singleContractBankPct: 0.12,
  minimumRewardRisk: 0.35,
  exitMode: "quick_bank",
  adaptiveProfitTarget: true,
  adaptiveTargetMinPct: 0.10,
  adaptiveTargetMaxPct: 0.15,
  adaptiveTargetFallbackPct: 0.12,
  adaptiveTargetReachRate: 0.65,
  adaptiveTargetLookback: 20,
  adaptiveTargetMinSamples: 5,
  profitLockArmPct: 0.08,
  peakGivebackMin: 0.025,
  peakGivebackFrac: 0.25,
  positionManagementMs: 5_000,
  riskPerTradePct: 0.02,
  maxPortfolioRiskPct: 0.04,
  maxPositionPct: 0.10,
  dailyLossLimitPct: 0.04,
  maxDayTrades: 2,
  maxPositions: 3,
});

/**
 * Build an atomic strategy configuration. The complete baseline intentionally overwrites every
 * strategy-owned field before the preset override is applied, preventing stale exit/risk values
 * from surviving a strategy switch.
 */
export function completeStrategyConfig(current = {}, baseline = {}, override = {}) {
  return { ...current, ...baseline, ...override };
}
