/**
 * Live-broker config normalization.
 *
 * Capital Preservation is an explicit strategy preset (see bot.js CAPITAL_PRESERVATION_TRACK).
 * It is NOT a silent overwrite layer on every settings save / process boot.
 *
 * This module only:
 *   1. Migrates the retired "march1m" deadline preset onto capital rails once
 *   2. Applies wide sanity clamps (so a typo cannot set −500% stops, etc.)
 *   3. Keeps live self-learning / self-promotion disabled
 *
 * User choices for allocation, cash reserve, profit target, stop, and live entries stick.
 */

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
  liveEntriesEnabled: false,
  useCashReserve: true,
});

/** Absolute sanity bounds — not strategy policy. */
const LIVE_SANITY = Object.freeze({
  minAllocationPct: 0.01,
  maxAllocationPct: 1.0,
  minRiskPerTradePct: 0.001,
  maxRiskPerTradePct: 0.10,
  minPortfolioRiskPct: 0.005,
  maxPortfolioRiskPct: 0.50,
  minDailyLossLimitPct: 0.005,
  maxDailyLossLimitPct: 0.50,
  minWeeklyLossLimitPct: 0.01,
  maxWeeklyLossLimitPct: 1.0,
  minDrawdownLimitPct: 0.02,
  maxDrawdownLimitPct: 0.50,
  minStopLoss: -0.50,
  maxStopLoss: -0.05,
  minProfitTarget: 0.05,
  maxProfitTarget: 5.0,
  maxConsecutiveLosses: 20,
  maxDayTrades: 20,
  maxPositions: 20,
});

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clean = value => +value.toFixed(6);

function applyCapitalPresetDefaults(next) {
  const policy = CAPITAL_PRESERVATION_POLICY;
  next.riskPerTradePct = policy.riskPerTradePct;
  next.maxPortfolioRiskPct = policy.maxPortfolioRiskPct;
  next.maxPositionPct = policy.maxPositionPct;
  next.baseRiskPct = policy.maxPositionPct;
  next.dailyLossLimitPct = policy.dailyLossLimitPct;
  next.weeklyLossLimitPct = policy.weeklyLossLimitPct;
  next.highWaterDrawdownLimitPct = policy.highWaterDrawdownLimitPct;
  next.maxConsecutiveLosses = policy.maxConsecutiveLosses;
  next.maxDayTrades = policy.maxDayTrades;
  next.maxPositions = policy.maxPositions;
  next.stopLoss = policy.stopLoss;
  next.profitTarget = policy.profitTarget;
  next.trim1Pct = policy.trim1Pct;
  next.trim2Pct = policy.trim2Pct;
  next.singleContractBankPct = policy.singleContractBankPct;
  next.minimumRewardRisk = policy.minimumRewardRisk;
  next.useCashReserve = true;
  next.liveEntriesEnabled = false;
  next.strategyPreset = "capital";
}

/**
 * Normalize live account config. User-facing knobs are preserved; only retired presets
 * and absurd out-of-range values are rewritten.
 */
export function normalizeLiveRiskConfig(config = {}) {
  const next = { ...config };
  const retiredDeadlinePreset = next.strategyPreset === "march1m";
  if (retiredDeadlinePreset) applyCapitalPresetDefaults(next);

  const allocation = clamp(
    finite(next.baseRiskPct, finite(next.maxPositionPct, 0.15)),
    LIVE_SANITY.minAllocationPct,
    LIVE_SANITY.maxAllocationPct,
  );
  next.baseRiskPct = clean(allocation);
  // Allocation in the Settings UI is `baseRiskPct`. Keep the governor ceiling in lockstep so a
  // higher spend % is not silently ignored by maxPositionPct leftover from the old 10% rail.
  next.maxPositionPct = clean(clamp(
    Math.max(finite(next.maxPositionPct, allocation), allocation),
    LIVE_SANITY.minAllocationPct,
    LIVE_SANITY.maxAllocationPct,
  ));

  next.riskPerTradePct = clean(clamp(
    finite(next.riskPerTradePct, CAPITAL_PRESERVATION_POLICY.riskPerTradePct),
    LIVE_SANITY.minRiskPerTradePct,
    LIVE_SANITY.maxRiskPerTradePct,
  ));
  next.maxPortfolioRiskPct = clean(clamp(
    finite(next.maxPortfolioRiskPct, Math.max(next.riskPerTradePct * 4, 0.02)),
    Math.max(LIVE_SANITY.minPortfolioRiskPct, next.riskPerTradePct),
    LIVE_SANITY.maxPortfolioRiskPct,
  ));

  if (next.dailyLossLimitPct != null && next.dailyLossLimitPct !== "") {
    next.dailyLossLimitPct = clean(clamp(
      finite(next.dailyLossLimitPct, CAPITAL_PRESERVATION_POLICY.dailyLossLimitPct),
      LIVE_SANITY.minDailyLossLimitPct,
      LIVE_SANITY.maxDailyLossLimitPct,
    ));
  }
  if (next.weeklyLossLimitPct != null && next.weeklyLossLimitPct !== "") {
    next.weeklyLossLimitPct = clean(clamp(
      finite(next.weeklyLossLimitPct, CAPITAL_PRESERVATION_POLICY.weeklyLossLimitPct),
      LIVE_SANITY.minWeeklyLossLimitPct,
      LIVE_SANITY.maxWeeklyLossLimitPct,
    ));
  }
  if (next.highWaterDrawdownLimitPct != null && next.highWaterDrawdownLimitPct !== "") {
    next.highWaterDrawdownLimitPct = clean(clamp(
      finite(next.highWaterDrawdownLimitPct, CAPITAL_PRESERVATION_POLICY.highWaterDrawdownLimitPct),
      LIVE_SANITY.minDrawdownLimitPct,
      LIVE_SANITY.maxDrawdownLimitPct,
    ));
  }

  if (next.maxConsecutiveLosses != null && next.maxConsecutiveLosses !== "") {
    next.maxConsecutiveLosses = Math.round(clamp(
      finite(next.maxConsecutiveLosses, 3),
      1,
      LIVE_SANITY.maxConsecutiveLosses,
    ));
  }
  if (next.maxDayTrades != null && next.maxDayTrades !== "") {
    next.maxDayTrades = Math.round(clamp(
      finite(next.maxDayTrades, 3),
      1,
      LIVE_SANITY.maxDayTrades,
    ));
  }
  if (next.maxPositions != null && next.maxPositions !== "") {
    next.maxPositions = Math.round(clamp(
      finite(next.maxPositions, 3),
      1,
      LIVE_SANITY.maxPositions,
    ));
  }

  next.stopLoss = clean(clamp(
    finite(next.stopLoss, -0.20),
    LIVE_SANITY.minStopLoss,
    LIVE_SANITY.maxStopLoss,
  ));
  next.profitTarget = clean(clamp(
    finite(next.profitTarget, 0.40),
    LIVE_SANITY.minProfitTarget,
    LIVE_SANITY.maxProfitTarget,
  ));
  if (next.trim1Pct != null) {
    next.trim1Pct = clean(clamp(finite(next.trim1Pct, 0.20), 0.05, next.profitTarget));
  }
  if (next.trim2Pct != null) {
    next.trim2Pct = clean(clamp(
      finite(next.trim2Pct, Math.max(next.trim1Pct || 0.20, 0.40)),
      next.trim1Pct || 0.05,
      next.profitTarget,
    ));
  }
  if (next.singleContractBankPct != null) {
    next.singleContractBankPct = clean(clamp(
      finite(next.singleContractBankPct, next.profitTarget),
      0.05,
      Math.max(next.profitTarget, 1),
    ));
  }

  // Explicit booleans — never force cash reserve or observation-only mode back on.
  next.useCashReserve = next.useCashReserve === true;
  next.liveEntriesEnabled = next.liveEntriesEnabled === true;
  next.learningEnabled = false;
  next.allowLiveSelfPromotion = false;

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
