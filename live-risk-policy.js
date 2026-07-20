export const CAPITAL_PRESERVATION_POLICY = Object.freeze({
  riskPerTradePct: 0.005,
  maxRiskPerTradePct: 0.01,
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
  // No admissible sample currently proves a positive live edge. New entries remain in observation
  // mode until a future forward-validation release explicitly re-arms them; exits stay automated.
  liveEntriesEnabled: false,
});

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clean = value => +value.toFixed(6);

/**
 * Normalize a live account into hard capital-preservation bounds. Lower user-selected limits are
 * retained; settings may tighten these rails but cannot silently loosen them.
 */
export function normalizeLiveRiskConfig(config = {}) {
  const policy = CAPITAL_PRESERVATION_POLICY;
  const next = { ...config };
  const retiredDeadlinePreset = next.strategyPreset === "march1m";

  next.riskPerTradePct = clamp(finite(next.riskPerTradePct, policy.riskPerTradePct), 0.001, policy.maxRiskPerTradePct);
  next.maxPortfolioRiskPct = clamp(
    finite(next.maxPortfolioRiskPct, policy.maxPortfolioRiskPct),
    next.riskPerTradePct,
    policy.maxPortfolioRiskPct,
  );
  next.maxPositionPct = clamp(finite(next.maxPositionPct, policy.maxPositionPct), 0.01, policy.maxPositionPct);
  // `baseRiskPct` is the legacy premium-allocation field. Keep it as an allocation ceiling only.
  next.baseRiskPct = clamp(finite(next.baseRiskPct, next.maxPositionPct), 0.01, next.maxPositionPct);
  next.dailyLossLimitPct = clamp(finite(next.dailyLossLimitPct, policy.dailyLossLimitPct), 0.005, policy.dailyLossLimitPct);
  next.weeklyLossLimitPct = clamp(finite(next.weeklyLossLimitPct, policy.weeklyLossLimitPct), 0.01, policy.weeklyLossLimitPct);
  next.highWaterDrawdownLimitPct = clamp(finite(next.highWaterDrawdownLimitPct, policy.highWaterDrawdownLimitPct), 0.02, policy.highWaterDrawdownLimitPct);
  next.maxConsecutiveLosses = Math.round(clamp(finite(next.maxConsecutiveLosses, policy.maxConsecutiveLosses), 1, policy.maxConsecutiveLosses));
  next.maxDayTrades = Math.round(clamp(finite(next.maxDayTrades, policy.maxDayTrades), 1, policy.maxDayTrades));
  next.maxPositions = Math.round(clamp(finite(next.maxPositions, policy.maxPositions), 1, policy.maxPositions));
  next.stopLoss = Math.max(-0.20, Math.min(-0.05, finite(next.stopLoss, policy.stopLoss)));
  next.minimumRewardRisk = Math.max(policy.minimumRewardRisk, finite(next.minimumRewardRisk, policy.minimumRewardRisk));
  next.profitTarget = clean(Math.max(
    retiredDeadlinePreset ? policy.profitTarget : finite(next.profitTarget, policy.profitTarget),
    Math.abs(next.stopLoss) * next.minimumRewardRisk,
  ));
  next.trim1Pct = clamp(finite(next.trim1Pct, policy.trim1Pct), 0.10, next.profitTarget);
  next.trim2Pct = clamp(finite(next.trim2Pct, policy.trim2Pct), next.trim1Pct, next.profitTarget);
  next.singleContractBankPct = clean(Math.max(
    finite(next.singleContractBankPct, next.profitTarget),
    Math.abs(next.stopLoss) * next.minimumRewardRisk,
  ));
  next.useCashReserve = true;
  next.learningEnabled = false;
  next.allowLiveSelfPromotion = false;
  next.liveEntriesEnabled = false;
  if (retiredDeadlinePreset) next.strategyPreset = "capital";

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
