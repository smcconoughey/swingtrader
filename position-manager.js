const DAY_MS = 86_400_000;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function optionDisasterFloorForStop(stopLoss = -0.35) {
  const configured = Number.isFinite(stopLoss) && stopLoss < 0 ? stopLoss : -0.35;
  return Math.min(configured * 1.8, -0.60);
}

/**
 * Freeze the policy that will manage a position for its entire lifetime.
 * Account preset changes affect future entries, never a holding that is already open.
 */
export function createManagementPlan(config = {}, position = {}, now = Date.now()) {
  const profitTarget = Number.isFinite(config.profitTarget) && config.profitTarget > 0
    ? config.profitTarget : 0.40;
  const trim1Pct = Number.isFinite(config.trim1Pct) && config.trim1Pct > 0
    ? config.trim1Pct : Math.min(0.25, profitTarget);
  const trim2Pct = Number.isFinite(config.trim2Pct) && config.trim2Pct > trim1Pct
    ? config.trim2Pct : Math.max(trim1Pct, profitTarget);
  const stopLoss = Number.isFinite(config.stopLoss) && config.stopLoss < 0
    ? config.stopLoss : -0.35;
  const inferredExitMode = profitTarget > trim2Pct ? "runner" : "quick_bank";
  const exitMode = config.exitMode === "runner" && profitTarget > trim2Pct
    ? "runner" : config.exitMode === "quick_bank" ? "quick_bank" : inferredExitMode;
  const brokerLifetimeDte = position.expiryDate > 0 && position.openTime > 0
    ? Math.max(0, (position.expiryDate - position.openTime) / DAY_MS)
    : 0;
  const initialDte = position.type === "equity"
    ? 0
    : Math.max(0, brokerLifetimeDte, finite(position.dte, finite(position.dteRemaining, 0)));

  return {
    version: 1,
    createdAt: now,
    initialDte,
    profitTarget,
    trim1Pct,
    trim2Pct,
    exitMode,
    singleContractBankPct: Math.min(profitTarget, trim1Pct),
    stopLoss,
    disasterFloor: optionDisasterFloorForStop(stopLoss),
    bullEntry: finite(config.bullEntry, 65),
    bearEntry: finite(config.bearEntry, 35),
    signalExitScoreMargin: 3,
    signalExitMinLoss: -0.05,
    spotStopFloor: 0.04,
    lowDteThreshold: 5,
    criticalDte: 3,
    lowDteLoss: -0.20,
    lowDteProfit: 0.20,
    profitLockArmPct: Math.min(0.10, profitTarget, trim1Pct),
    peakGivebackFrac: 0.30,
    peakGivebackMin: 0.04,
    staleMinHeldDays: 3,
    staleLifeConsumed: 0.35,
    staleDteThreshold: 10,
    staleLossPct: -0.05,
    staleMaxPeakPct: 0.05,
    eodSoftHour: 15.0,
    eodTightenHour: 15.75,
    eowHour: 14.0,
    eodSoftMinPnl: 0.10,
    eodHardMinPnl: 0.10,
    eowSoftMinPnl: 0.10,
    eowHardMinPnl: 0.20,
    nearTargetFrac: 0.70,
  };
}

export function managementPlanFor(position = {}, config = {}, now = Date.now()) {
  const existing = position.managementPlan;
  if (existing && existing.version === 1) return existing;
  return createManagementPlan(config, position, now);
}

function premiumTrailStalling(trail = []) {
  const recent = trail.slice(-5)
    .map(point => finite(point.bid, finite(point.exitPrice, finite(point.mark, 0))))
    .filter(price => price > 0);
  if (recent.length < 4) return false;
  const peak = Math.max(...recent);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const offPeak = (peak - last) / peak >= 0.015;
  const flatNet = Math.abs(last - first) / peak <= 0.025;
  const declining = last <= recent[recent.length - 2] && last <= recent[recent.length - 3];
  return offPeak && (flatNet || declining);
}

function thesisState(position, signals, plan, adverseSpotMove) {
  const score = signals && Number.isFinite(signals.score) ? signals.score : null;
  if (score == null) {
    return { state: "unknown", reversed: false, deepReversal: false, weak: false, spotAgainst: adverseSpotMove >= 0.02 };
  }

  const type = position.type;
  const reversed = type === "put" ? score >= plan.bullEntry : score <= plan.bearEntry;
  const deepReversal = type === "put"
    ? score >= plan.bullEntry + plan.signalExitScoreMargin
    : score <= plan.bearEntry - plan.signalExitScoreMargin;
  const weak = type === "put" ? score > 50 : score < 50;
  return {
    state: reversed ? "reversed" : weak ? "weak" : "intact",
    reversed,
    deepReversal,
    weak,
    spotAgainst: adverseSpotMove >= 0.02,
  };
}

function makeDecision(base, action, reasonCode, reason, extras = {}) {
  return {
    ...base,
    action,
    reasonCode,
    reason,
    qty: action === "hold" ? 0 : (extras.qty ?? base.positionQty),
    urgency: extras.urgency || "routine",
    priceMode: extras.priceMode || (action === "hold" ? "none" : "patient"),
    statePatch: extras.statePatch ? { ...base.statePatch, ...extras.statePatch } : base.statePatch,
  };
}

/**
 * Pure position-lifecycle evaluator. It never places an order or mutates the position.
 * Profit rules use the executable exit price (the live bid for broker-held options), while
 * valuation/high-water telemetry keeps the mark separately.
 */
export function evaluatePosition({
  position = {},
  market = {},
  signals = {},
  plan: suppliedPlan = null,
  config = {},
  now = Date.now(),
} = {}) {
  const plan = suppliedPlan || managementPlanFor(position, config, now);
  const isEquity = position.type === "equity";
  const entryPremium = finite(position.entryPremium, 0);
  const spot = finite(market.spot, finite(position.entrySpot, 0));
  const mark = isEquity
    ? finite(market.mark, spot)
    : finite(market.mark, finite(market.bid, 0));
  const bid = finite(market.bid, 0);
  const requireExecutableBid = !!market.requireExecutableBid && !isEquity;
  const requireVerifiedContract = !!market.requireVerifiedContract && !isEquity;
  const contractIdentityVerified = market.contractIdentityVerified === true;
  const requireFreshQuote = !!market.requireFreshQuote && !isEquity;
  // Callers may fall back to a cached underlying quote when its live refresh fails. That fallback
  // is still useful for display, but it must not authorize exits derived from spot or indicators.
  // Default true preserves existing behavior for callers that provide a current market snapshot.
  const underlyingQuoteFresh = market.underlyingQuoteFresh !== false;
  const quoteAsOf = finite(market.quoteAsOf, 0);
  const quoteAgeMs = quoteAsOf > 0 ? Math.max(0, now - quoteAsOf) : Infinity;
  const maxQuoteAgeMs = Math.max(1, finite(market.maxQuoteAgeMs, 45_000));
  const exitPrice = isEquity ? mark : (bid > 0 ? bid : (requireExecutableBid ? 0 : mark));
  const dteRemaining = isEquity ? 0 : Math.max(0, finite(market.dteRemaining, finite(position.dteRemaining, plan.initialDte)));
  const heldDays = position.openTime > 0 ? Math.max(0, (now - position.openTime) / DAY_MS) : 0;
  const initialDte = Math.max(plan.initialDte || 0, dteRemaining);
  const lifeConsumed = initialDte > 0 ? clamp(1 - dteRemaining / initialDte, 0, 1) : 0;
  const markPnlPct = entryPremium > 0 && mark > 0 ? (mark - entryPremium) / entryPremium : 0;
  const exitPnlPct = entryPremium > 0 && exitPrice > 0 ? (exitPrice - entryPremium) / entryPremium : 0;
  const bestMarkPnlPct = Math.max(finite(position.bestPnlPct, 0), markPnlPct);
  const bestExitPnlPct = Math.max(finite(position.bestExitPnlPct, 0), exitPnlPct);
  const givebackPct = Math.max(0, bestExitPnlPct - exitPnlPct);
  const spotMove = position.entrySpot > 0 && spot > 0 ? (spot - position.entrySpot) / position.entrySpot : 0;
  const adverseSpotMove = isEquity ? -spotMove : (position.type === "put" ? spotMove : -spotMove);
  const atrPct = Math.max(0, finite(position.entryAtrPct, 0) / 100);
  const atrMultiple = dteRemaining >= 21 ? 2.0 : dteRemaining <= 7 ? 1.25 : 1.5;
  const spotStopThreshold = Math.max(plan.spotStopFloor, atrPct * atrMultiple);
  const thesis = underlyingQuoteFresh
    ? thesisState(position, signals, plan, adverseSpotMove)
    : thesisState(position, {}, plan, 0);
  const qty = Math.max(0, finite(position.qty, 0));
  const originalQty = Math.max(qty, finite(position.originalQty, qty));
  const trimLevel = Math.max(0, finite(position.trimLevel, 0));
  const exitMode = plan.exitMode || (plan.profitTarget > plan.trim2Pct ? "runner" : "quick_bank");
  const nearTarget = exitPnlPct >= plan.profitTarget * plan.nearTargetFrac;
  const givebackThreshold = Math.max(plan.peakGivebackMin, bestExitPnlPct * plan.peakGivebackFrac);
  // A runner is a distinct mandate: before trim two is completed, universal +10% locks must not
  // silently turn +30/+60/+80 policy into quick-bank behavior. Protective rules still apply.
  const runnerArmed = exitMode !== "runner" || trimLevel >= 2;
  const givingBack = runnerArmed
    && bestExitPnlPct >= plan.profitLockArmPct
    && givebackPct >= givebackThreshold;
  const stalling = premiumTrailStalling(position.markTrail || [])
    || (underlyingQuoteFresh && !!signals.stalling);
  const etHour = finite(market.etHour, 0);
  const isFriday = !!market.isFriday;

  const base = {
    action: "hold",
    reasonCode: "HOLD",
    reason: "hold",
    qty: 0,
    urgency: "routine",
    priceMode: "none",
    executionPrice: exitPrice,
    markPrice: mark,
    positionQty: qty,
    plan,
    statePatch: {
      managementPlan: plan,
      bestPnlPct: bestMarkPnlPct,
      bestExitPnlPct,
      lastManagerEvalAt: now,
    },
    metrics: {
      markPnlPct,
      exitPnlPct,
      bestMarkPnlPct,
      bestExitPnlPct,
      givebackPct,
      givebackThreshold,
      dteRemaining,
      heldDays,
      lifeConsumed,
      adverseSpotMove,
      spotStopThreshold,
      thesisState: thesis.state,
      quoteMode: requireExecutableBid ? "live-bid" : (bid > 0 ? "bid" : "mark"),
      contractIdentityVerified,
      quoteAgeMs,
      underlyingQuoteFresh,
    },
  };

  if (requireVerifiedContract && !contractIdentityVerified) {
    return makeDecision(base, "hold", "UNKNOWN_CONTRACT", "hold: exact option identity and expiry are not verified");
  }
  if (requireFreshQuote && quoteAgeMs > maxQuoteAgeMs) {
    return makeDecision(base, "hold", "STALE_CONTRACT_QUOTE", "hold: exact-contract quote is stale or missing");
  }
  if (!(entryPremium > 0) || !(mark > 0) || !(spot > 0)) {
    return makeDecision(base, "hold", "INVALID_POSITION_STATE", "hold: incomplete entry or market state");
  }
  if (requireExecutableBid && !(bid > 0)) {
    return makeDecision(base, "hold", "NO_EXECUTABLE_BID", "hold: no current executable bid for this exact contract");
  }

  // Capital-protection rules. Time remaining changes the ATR allowance, but never turns a
  // shallow premium print into a stop by itself.
  if (isEquity && exitPnlPct <= plan.stopLoss) {
    return makeDecision(base, "close", "EQUITY_STOP", `stop loss ${(exitPnlPct * 100).toFixed(0)}%`, { urgency: "protective", priceMode: "marketable" });
  }
  if (!isEquity && dteRemaining <= plan.criticalDte) {
    return makeDecision(base, "close", "DTE_CRITICAL", `DTE critical (${dteRemaining.toFixed(1)}d remaining)`, { urgency: "urgent", priceMode: "marketable" });
  }
  if (underlyingQuoteFresh && adverseSpotMove >= spotStopThreshold) {
    const moveLabel = isEquity ? "stock down" : `underlying ${position.type === "put" ? "up" : "down"}`;
    return makeDecision(base, "close", "STRUCTURAL_SPOT_STOP", `spot stop: ${moveLabel} ${(adverseSpotMove * 100).toFixed(1)}% from entry (DTE-aware threshold ${(spotStopThreshold * 100).toFixed(1)}%, ATR ${(atrPct * 100).toFixed(1)}%)`, { urgency: "protective", priceMode: "marketable" });
  }
  if (!isEquity && dteRemaining <= plan.lowDteThreshold && exitPnlPct <= plan.lowDteLoss) {
    return makeDecision(base, "close", "LOW_DTE_LOSS", `low-DTE tight stop ${(exitPnlPct * 100).toFixed(0)}% (${dteRemaining.toFixed(1)}d left, theta accelerating)`, { urgency: "urgent", priceMode: "marketable" });
  }
  if (!isEquity && exitPnlPct <= plan.disasterFloor) {
    return makeDecision(base, "close", "PREMIUM_DISASTER", `disaster stop ${(exitPnlPct * 100).toFixed(0)}% (premium collapse past ${(plan.disasterFloor * 100).toFixed(0)}%)`, { urgency: "protective", priceMode: "marketable" });
  }

  const underwater = exitPnlPct <= plan.signalExitMinLoss;
  const signalInvalidated = thesis.reversed && (
    (thesis.deepReversal && thesis.spotAgainst) ||
    (underwater && (dteRemaining <= plan.staleDteThreshold || lifeConsumed >= 0.50))
  );
  if (underlyingQuoteFresh && signalInvalidated) {
    return makeDecision(base, "close", "THESIS_INVALIDATED", `signal reversed with confirmation (${thesis.state}, ${(exitPnlPct * 100).toFixed(0)}%, ${dteRemaining.toFixed(1)}d left)`, { urgency: "protective", priceMode: "marketable" });
  }

  const staleAndWeak = !isEquity
    && underlyingQuoteFresh
    && heldDays >= plan.staleMinHeldDays
    && exitPnlPct <= plan.staleLossPct
    && bestExitPnlPct < plan.staleMaxPeakPct
    && thesis.weak
    && (lifeConsumed >= plan.staleLifeConsumed || dteRemaining <= plan.staleDteThreshold);
  if (staleAndWeak) {
    return makeDecision(base, "close", "TIME_DECAY_INVALIDATION", `time-decay exit ${(exitPnlPct * 100).toFixed(0)}% after ${heldDays.toFixed(1)}d (${(lifeConsumed * 100).toFixed(0)}% of option life used, thesis ${thesis.state})`, { urgency: "protective", priceMode: "marketable" });
  }

  if (qty === 1 && trimLevel === 0 && exitPnlPct >= plan.singleContractBankPct) {
    return makeDecision(base, "close", "SINGLE_CONTRACT_BANK", `single-contract profit bank +${(exitPnlPct * 100).toFixed(0)}% (cannot partial-trim)`, { qty: 1, priceMode: "bank" });
  }
  if (trimLevel === 0 && exitPnlPct >= plan.trim1Pct && qty > 1) {
    const trimQty = Math.min(qty - 1, Math.max(1, Math.floor(originalQty * 0.25)));
    return makeDecision(base, "trim", "TRIM_1", `trim 1 (+${(exitPnlPct * 100).toFixed(0)}%, executable gain)`, { qty: trimQty, priceMode: "bank" });
  }
  if (exitMode === "runner" && trimLevel === 1 && exitPnlPct >= plan.trim2Pct) {
    if (qty === 1) {
      return makeDecision(
        base,
        "hold",
        "RUNNER_ARMED",
        `runner armed at +${(exitPnlPct * 100).toFixed(0)}%; trailing final contract with 8/21 EMA`,
        { statePatch: { trimLevel: 2 } },
      );
    }
    const trimQty = Math.min(qty - 1, Math.max(1, Math.floor(originalQty * 0.25)));
    return makeDecision(base, "trim", "TRIM_2", `trim 2 (+${(exitPnlPct * 100).toFixed(0)}%, trailing EMAs)`, { qty: trimQty, priceMode: "bank" });
  }

  // Profit-taking is evaluated against what a buyer is bidding now, not the midpoint shown in P&L.
  // In quick-bank mode this closes the post-trim remainder. Runner mode reaches trim two first,
  // leaving a real window for the 8/21 EMA trail before the higher final target.
  if (exitPnlPct >= plan.profitTarget) {
    return makeDecision(base, "close", "PROFIT_TARGET", `profit target +${(exitPnlPct * 100).toFixed(0)}% on executable price`, { priceMode: "bank" });
  }
  if (trimLevel >= 1 && exitPnlPct <= 0) {
    return makeDecision(base, "close", "POST_TRIM_BREAKEVEN", `breakeven stop (post-trim, executable peak +${(bestExitPnlPct * 100).toFixed(0)}%)`, { urgency: "protective", priceMode: "marketable" });
  }
  if (trimLevel >= 2 && exitPnlPct <= 0.15) {
    return makeDecision(base, "close", "POST_TRIM_TRAIL", "trailing stop (post-trim2, locked +15%)", { urgency: "protective", priceMode: "marketable" });
  }

  // This lifecycle giveback lock is intentionally time-of-day independent. A worthwhile winner
  // that fades at 11 AM deserves the same response as one that fades after 3 PM.
  if (givingBack) {
    return makeDecision(base, "close", "PEAK_GIVEBACK", `profit giveback lock ${(exitPnlPct * 100).toFixed(0)}% (executable peak +${(bestExitPnlPct * 100).toFixed(0)}%)`, { priceMode: "bank" });
  }

  if (runnerArmed && isFriday && etHour >= plan.eowHour) {
    if (exitPnlPct >= plan.eowHardMinPnl) {
      return makeDecision(base, "close", "EOW_PROFIT_LOCK", `EOW profit lock +${(exitPnlPct * 100).toFixed(0)}%`, { priceMode: "bank" });
    }
    if (exitPnlPct >= plan.eowSoftMinPnl && (stalling || nearTarget)) {
      return makeDecision(base, "close", "EOW_SOFT_LOCK", `EOW soft lock +${(exitPnlPct * 100).toFixed(0)}% (${nearTarget ? "near target" : "move stalling"})`, { priceMode: "bank" });
    }
  }
  if (runnerArmed && etHour >= plan.eodSoftHour && etHour < plan.eodTightenHour
      && exitPnlPct >= plan.eodSoftMinPnl && (stalling || nearTarget)) {
    return makeDecision(base, "close", "EOD_SOFT_LOCK", `EOD soft lock +${(exitPnlPct * 100).toFixed(0)}% (${nearTarget ? "near target" : "move stalling"})`, { priceMode: "bank" });
  }
  if (runnerArmed && etHour >= plan.eodTightenHour && exitPnlPct >= plan.eodHardMinPnl) {
    return makeDecision(base, "close", "EOD_PROFIT_LOCK", `EOD lock +${(exitPnlPct * 100).toFixed(0)}% (3:45 PM tighten)`, { priceMode: "bank" });
  }
  if (!isEquity && dteRemaining <= plan.lowDteThreshold && exitPnlPct >= plan.lowDteProfit) {
    return makeDecision(base, "close", "LOW_DTE_PROFIT", `low DTE accelerated exit +${(exitPnlPct * 100).toFixed(0)}% (${dteRemaining.toFixed(1)}d left)`, { priceMode: "bank" });
  }

  if (underlyingQuoteFresh && trimLevel === 2 && signals.break8) {
    if (qty === 1) {
      return makeDecision(base, "close", "EMA8_FINAL", "8 EMA break (single-contract remainder)", { priceMode: "bank" });
    }
    const trimQty = Math.min(qty - 1, Math.max(1, Math.floor(originalQty * 0.25)));
    return makeDecision(base, "trim", "EMA8_TRIM", "8 EMA break (trim 3, trailing 21 EMA with remainder)", { qty: trimQty, priceMode: "bank" });
  }
  if (underlyingQuoteFresh && trimLevel === 3 && signals.break21) {
    return makeDecision(base, "close", "EMA21_FINAL", "21 EMA break (final exit)", { priceMode: "bank" });
  }

  let holdReason = `hold: ${dteRemaining.toFixed(1)}d remain; executable P&L ${(exitPnlPct * 100).toFixed(0)}%; thesis ${thesis.state}`;
  if (!isEquity && exitPnlPct < 0 && lifeConsumed < plan.staleLifeConsumed && !signalInvalidated) {
    holdReason = `hold: time remains (${dteRemaining.toFixed(1)}d, ${(lifeConsumed * 100).toFixed(0)}% life used) and thesis is not invalidated`;
  }
  return makeDecision(base, "hold", "HOLD_THESIS", holdReason);
}
