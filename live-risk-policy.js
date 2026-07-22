/**
 * Live-broker config normalization.
 *
 * This layer backfills missing, visible controls only. Explicit settings are never silently
 * clamped or replaced: the dashboard shows them and the risk governor rejects invalid inputs with
 * a visible reason instead of running a different strategy than the operator selected.
 */

export const CAPITAL_PRESERVATION_POLICY = Object.freeze({
  riskPerTradePct: 0.005,
  maxPortfolioRiskPct: 0.02,
  maxPositionPct: 0.10,
  dailyLossLimitPct: 0.02,
  weeklyLossLimitPct: 0.04,
  highWaterDrawdownLimitPct: 0.05,
  maxConsecutiveLosses: 2,
  maxDayTrades: 2,
  maxPositions: 3,
  stopLoss: -0.20,
  profitTarget: 0.40,
  trim1Pct: 0.20,
  trim2Pct: 0.40,
  singleContractBankPct: 0.40,
  minimumRewardRisk: 1.5,
  liveEntriesEnabled: true,
});

export const LIVE_RISK_DEFAULTS = Object.freeze({
  riskPerTradePct: CAPITAL_PRESERVATION_POLICY.riskPerTradePct,
  maxPortfolioRiskPct: CAPITAL_PRESERVATION_POLICY.maxPortfolioRiskPct,
  maxPositionPct: CAPITAL_PRESERVATION_POLICY.maxPositionPct,
  dailyLossLimitPct: CAPITAL_PRESERVATION_POLICY.dailyLossLimitPct,
  weeklyLossLimitPct: CAPITAL_PRESERVATION_POLICY.weeklyLossLimitPct,
  highWaterDrawdownLimitPct: CAPITAL_PRESERVATION_POLICY.highWaterDrawdownLimitPct,
  maxConsecutiveLosses: CAPITAL_PRESERVATION_POLICY.maxConsecutiveLosses,
  maxDayTrades: CAPITAL_PRESERVATION_POLICY.maxDayTrades,
  minimumRewardRisk: 1.0,
  liveEntriesEnabled: true,
});

const finite = value => Number.isFinite(Number(value));

export function normalizeLiveRiskConfig(config = {}) {
  const next = { ...config };

  for (const [key, value] of Object.entries(LIVE_RISK_DEFAULTS)) {
    if (next[key] === undefined) next[key] = value;
  }
  if (next.singleContractBankPct === undefined) {
    next.singleContractBankPct = finite(next.profitTarget)
      ? Number(next.profitTarget)
      : CAPITAL_PRESERVATION_POLICY.singleContractBankPct;
  }

  const changes = [];
  for (const [key, value] of Object.entries(next)) {
    if (config[key] !== value) changes.push({ key, before: config[key], after: value });
  }
  return { config: next, changes };
}

export function applyLiveRiskPolicy(account) {
  if (!account?.config || !["robinhood", "tradier"].includes(account.config.broker)) return [];
  const { config, changes } = normalizeLiveRiskConfig(account.config);
  account.config = config;
  return changes;
}
