const LIMIT_NAMES = Object.freeze({
  riskPerTrade: "per-trade risk",
  aggregateOpenRisk: "aggregate open risk",
  maxPositionPct: "maximum position percentage",
  maxPositionDollars: "maximum position dollars",
  cash: "available cash",
  minimumRewardRisk: "minimum reward/risk",
});

const finite = value => Number.isFinite(value);

function rounded(value, places = 6) {
  if (!finite(value)) return null;
  return +value.toFixed(places);
}

function contractsWithin(budget, perContract) {
  if (budget == null) return null;
  // Avoid rejecting an exactly funded contract because of binary floating-point dust. The
  // tolerance is applied to the dimensionless ratio so adding it cannot overflow a large budget.
  const ratio = budget / perContract;
  if (!finite(ratio) || ratio >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
  return Math.max(0, Math.floor(ratio + tolerance));
}

function materiallyBelow(value, threshold) {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(threshold)) * 8;
  return value < threshold - tolerance;
}

function invalidDecision(errors) {
  return {
    approved: false,
    quantity: 0,
    reasonCode: "INVALID_INPUT",
    reason: `invalid risk-governor input: ${errors.join("; ")}`,
    failedLimits: [],
    bindingLimits: [],
    metrics: null,
  };
}

/**
 * Size a long option entry from the loss that would be realized at its configured stop.
 *
 * Percentage inputs are fractions: 0.01 is 1%. stopLossPct may use the repository's signed
 * convention (-0.25) or the equivalent positive loss fraction (0.25). Reward/risk uses the net
 * target profit and net stop loss after modeled friction and fees, so the 1.5R default is not
 * defeated by trading costs. All friction and fee inputs are dollar costs per contract except
 * entryFrictionPct, which is a fraction of premium notional. openRiskDollars is the current
 * maximum loss across open positions, not their cost.
 *
 * This function is deliberately pure and fail-closed. It does not mutate its input, inspect
 * account state, fetch quotes, or round a requested quantity up to fit an allocation target.
 */
export function sizeLongOptionEntry(input = {}) {
  const {
    accountEquity,
    cash,
    entryPrice,
    stopLossPct,
    profitTargetPct,
    minimumRewardRisk = 1.5,
    riskPerTradePct,
    maxPositionPct = null,
    maxPositionDollars = null,
    aggregateRiskBudgetDollars = null,
    openRiskDollars = 0,
    contractMultiplier = 100,
    entryFrictionPct = 0,
    entryFrictionDollarsPerContract = 0,
    exitFrictionDollarsPerContract = 0,
    entryFeePerContract = 0,
    exitFeePerContract = 0,
  } = input ?? {};
  const errors = [];
  if (!finite(accountEquity) || accountEquity <= 0) errors.push("accountEquity must be > 0");
  if (!finite(cash) || cash < 0) errors.push("cash must be >= 0");
  if (!finite(entryPrice) || entryPrice <= 0) errors.push("entryPrice must be > 0");
  if (!finite(stopLossPct) || Math.abs(stopLossPct) <= 0 || Math.abs(stopLossPct) > 1) {
    errors.push("stopLossPct must be a non-zero fraction no greater than 1");
  }
  if (!finite(profitTargetPct) || profitTargetPct <= 0) {
    errors.push("profitTargetPct must be > 0");
  }
  if (!finite(minimumRewardRisk) || minimumRewardRisk < 0) {
    errors.push("minimumRewardRisk must be >= 0");
  }
  if (!finite(riskPerTradePct) || riskPerTradePct < 0 || riskPerTradePct > 1) {
    errors.push("riskPerTradePct must be between 0 and 1");
  }
  if (maxPositionPct != null && (!finite(maxPositionPct) || maxPositionPct < 0 || maxPositionPct > 1)) {
    errors.push("maxPositionPct must be null or between 0 and 1");
  }
  if (maxPositionDollars != null && (!finite(maxPositionDollars) || maxPositionDollars < 0)) {
    errors.push("maxPositionDollars must be null or >= 0");
  }
  if (aggregateRiskBudgetDollars != null
      && (!finite(aggregateRiskBudgetDollars) || aggregateRiskBudgetDollars < 0)) {
    errors.push("aggregateRiskBudgetDollars must be null or >= 0");
  }
  if (!finite(openRiskDollars) || openRiskDollars < 0) errors.push("openRiskDollars must be >= 0");
  if (!finite(contractMultiplier) || contractMultiplier <= 0) {
    errors.push("contractMultiplier must be > 0");
  }
  if (!finite(entryFrictionPct) || entryFrictionPct < 0) {
    errors.push("entryFrictionPct must be >= 0");
  }

  const dollarCostInputs = {
    entryFrictionDollarsPerContract,
    exitFrictionDollarsPerContract,
    entryFeePerContract,
    exitFeePerContract,
  };
  for (const [name, value] of Object.entries(dollarCostInputs)) {
    if (!finite(value) || value < 0) errors.push(`${name} must be >= 0`);
  }

  if (errors.length > 0) return invalidDecision(errors);

  const stopLossFraction = Math.abs(stopLossPct);
  const stopPrice = entryPrice * (1 - stopLossFraction);
  const entryNotionalPerContract = entryPrice * contractMultiplier;
  const premiumLossAtStopPerContract = (entryPrice - stopPrice) * contractMultiplier;
  const entryFrictionPerContract = (entryNotionalPerContract * entryFrictionPct)
    + entryFrictionDollarsPerContract;
  const totalFeesPerContract = entryFeePerContract + exitFeePerContract;
  const maxLossPerContract = premiumLossAtStopPerContract
    + entryFrictionPerContract
    + exitFrictionDollarsPerContract
    + totalFeesPerContract;
  const cashRequiredPerContract = entryNotionalPerContract
    + entryFrictionPerContract
    + entryFeePerContract;
  const targetPrice = entryPrice * (1 + profitTargetPct);
  const grossProfitAtTargetPerContract = (targetPrice - entryPrice) * contractMultiplier;
  const netProfitAtTargetPerContract = grossProfitAtTargetPerContract
    - entryFrictionPerContract
    - exitFrictionDollarsPerContract
    - totalFeesPerContract;
  const configuredRewardRiskRatio = profitTargetPct / stopLossFraction;
  const rewardRiskRatio = netProfitAtTargetPerContract / maxLossPerContract;

  const derivedValues = {
    entryNotionalPerContract,
    premiumLossAtStopPerContract,
    entryFrictionPerContract,
    maxLossPerContract,
    cashRequiredPerContract,
    targetPrice,
    grossProfitAtTargetPerContract,
    netProfitAtTargetPerContract,
    configuredRewardRiskRatio,
    rewardRiskRatio,
  };
  const invalidDerived = Object.entries(derivedValues)
    .filter(([, value]) => !finite(value))
    .map(([name]) => `${name} exceeds numeric range`);
  if (!(maxLossPerContract > 0)) invalidDerived.push("maxLossPerContract must be > 0");
  if (!(cashRequiredPerContract > 0)) invalidDerived.push("cashRequiredPerContract must be > 0");
  if (invalidDerived.length > 0) return invalidDecision(invalidDerived);

  const tradeRiskBudget = accountEquity * riskPerTradePct;
  const positionPctBudget = maxPositionPct == null ? null : accountEquity * maxPositionPct;
  const aggregateRiskRemaining = aggregateRiskBudgetDollars == null
    ? null
    : Math.max(0, aggregateRiskBudgetDollars - openRiskDollars);

  const constraintRows = [
    {
      key: "riskPerTrade",
      category: "risk",
      budgetDollars: tradeRiskBudget,
      perContractDollars: maxLossPerContract,
    },
    ...(aggregateRiskRemaining == null ? [] : [{
      key: "aggregateOpenRisk",
      category: "risk",
      budgetDollars: aggregateRiskRemaining,
      perContractDollars: maxLossPerContract,
    }]),
    ...(positionPctBudget == null ? [] : [{
      key: "maxPositionPct",
      category: "allocation",
      budgetDollars: positionPctBudget,
      perContractDollars: cashRequiredPerContract,
    }]),
    ...(maxPositionDollars == null ? [] : [{
      key: "maxPositionDollars",
      category: "allocation",
      budgetDollars: maxPositionDollars,
      perContractDollars: cashRequiredPerContract,
    }]),
    {
      key: "cash",
      category: "allocation",
      budgetDollars: cash,
      perContractDollars: cashRequiredPerContract,
    },
  ].map(row => ({ ...row, maxContracts: contractsWithin(row.budgetDollars, row.perContractDollars) }));

  const quantity = Math.min(...constraintRows.map(row => row.maxContracts));
  const failedRows = constraintRows.filter(row => row.maxContracts < 1);
  const failedLimits = failedRows.map(row => row.key);
  const minimumCapacity = Math.min(...constraintRows.map(row => row.maxContracts));
  const bindingLimits = constraintRows
    .filter(row => row.maxContracts === minimumCapacity)
    .map(row => row.key);

  const constraints = Object.fromEntries(constraintRows.map(row => [row.key, {
    category: row.category,
    budgetDollars: rounded(row.budgetDollars),
    perContractDollars: rounded(row.perContractDollars),
    maxContracts: row.maxContracts,
  }]));

  const metrics = {
    accountEquity: rounded(accountEquity),
    availableCash: rounded(cash),
    entryPrice: rounded(entryPrice),
    stopLossFraction: rounded(stopLossFraction),
    stopPrice: rounded(stopPrice),
    profitTargetFraction: rounded(profitTargetPct),
    targetPrice: rounded(targetPrice),
    configuredRewardRiskRatio: rounded(configuredRewardRiskRatio),
    rewardRiskRatio: rounded(rewardRiskRatio),
    minimumRewardRisk: rounded(minimumRewardRisk),
    contractMultiplier: rounded(contractMultiplier),
    entryNotionalPerContract: rounded(entryNotionalPerContract),
    premiumLossAtStopPerContract: rounded(premiumLossAtStopPerContract),
    entryFrictionPerContract: rounded(entryFrictionPerContract),
    exitFrictionPerContract: rounded(exitFrictionDollarsPerContract),
    entryFeePerContract: rounded(entryFeePerContract),
    exitFeePerContract: rounded(exitFeePerContract),
    cashRequiredPerContract: rounded(cashRequiredPerContract),
    maxLossPerContract: rounded(maxLossPerContract),
    grossProfitAtTargetPerContract: rounded(grossProfitAtTargetPerContract),
    netProfitAtTargetPerContract: rounded(netProfitAtTargetPerContract),
    tradeRiskBudgetDollars: rounded(tradeRiskBudget),
    aggregateRiskBudgetDollars: rounded(aggregateRiskBudgetDollars),
    openRiskDollars: rounded(openRiskDollars),
    aggregateRiskRemainingDollars: rounded(aggregateRiskRemaining),
    positionPctBudgetDollars: rounded(positionPctBudget),
    maxPositionDollars: rounded(maxPositionDollars),
    expectedMaxLossDollars: rounded(quantity * maxLossPerContract),
    entryCashRequiredDollars: rounded(quantity * cashRequiredPerContract),
    postTradeAggregateOpenRiskDollars: rounded(openRiskDollars + (quantity * maxLossPerContract)),
    constraints,
  };

  if (quantity < 1) {
    const failedRisk = failedRows.some(row => row.category === "risk");
    const failedAllocation = failedRows.some(row => row.category === "allocation");
    const reasonCode = failedRisk && failedAllocation
      ? "ONE_CONTRACT_EXCEEDS_RISK_AND_ALLOCATION"
      : failedRisk
        ? "ONE_CONTRACT_EXCEEDS_RISK"
        : "ONE_CONTRACT_EXCEEDS_ALLOCATION";
    const labels = failedLimits.map(key => LIMIT_NAMES[key]).join(", ");
    return {
      approved: false,
      quantity: 0,
      reasonCode,
      reason: `one contract exceeds: ${labels}`,
      failedLimits,
      bindingLimits,
      metrics,
    };
  }

  if (materiallyBelow(rewardRiskRatio, minimumRewardRisk)) {
    return {
      approved: false,
      quantity: 0,
      reasonCode: "REWARD_RISK_BELOW_MINIMUM",
      reason: `net reward/risk ${rewardRiskRatio.toFixed(2)}R is below minimum ${minimumRewardRisk.toFixed(2)}R`,
      failedLimits: ["minimumRewardRisk"],
      bindingLimits,
      metrics: {
        ...metrics,
        riskSizedQuantity: quantity,
        expectedMaxLossDollars: 0,
        entryCashRequiredDollars: 0,
        postTradeAggregateOpenRiskDollars: rounded(openRiskDollars),
      },
    };
  }

  const labels = bindingLimits.map(key => LIMIT_NAMES[key]).join(", ");
  return {
    approved: true,
    quantity,
    reasonCode: "APPROVED",
    reason: `approved ${quantity} contract${quantity === 1 ? "" : "s"}; limited by ${labels}`,
    failedLimits: [],
    bindingLimits,
    metrics,
  };
}
