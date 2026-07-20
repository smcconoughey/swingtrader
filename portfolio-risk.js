const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function tradingWeekKey(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return null;
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

export function rollPortfolioRiskState(previous = {}, { pv, dateKey, now = Date.now() } = {}) {
  const value = finite(pv);
  const weekKey = tradingWeekKey(dateKey);
  const next = {
    consecutiveLosses: Math.max(0, Math.floor(finite(previous.consecutiveLosses) ?? 0)),
    cooldownUntil: Math.max(0, finite(previous.cooldownUntil) ?? 0),
    highWaterPV: finite(previous.highWaterPV),
    weekKey: previous.weekKey || null,
    weekStartPV: finite(previous.weekStartPV),
    lastUpdatedAt: now,
    haltNotified: previous.haltNotified || null,
  };
  if (value != null && value > 0) {
    if (!(next.highWaterPV > 0) || value > next.highWaterPV) {
      next.highWaterPV = value;
      next.haltNotified = null;
    }
    if (weekKey && (next.weekKey !== weekKey || !(next.weekStartPV > 0))) {
      next.weekKey = weekKey;
      next.weekStartPV = value;
      if (next.haltNotified === "weekly") next.haltNotified = null;
    }
  }
  return next;
}

export function recordPortfolioOutcome(previous = {}, {
  pnlDollar,
  now = Date.now(),
  lossCooldownMs = 60 * 60_000,
} = {}) {
  const next = { ...previous };
  const pnl = finite(pnlDollar);
  if (pnl == null) return next;
  if (pnl < 0) {
    next.consecutiveLosses = Math.max(0, Math.floor(finite(next.consecutiveLosses) ?? 0)) + 1;
    next.cooldownUntil = Math.max(finite(next.cooldownUntil) ?? 0, now + lossCooldownMs);
  } else if (pnl > 0) {
    next.consecutiveLosses = 0;
  }
  next.lastOutcomeAt = now;
  return next;
}

export function portfolioEntryBlock({ risk = {}, pv, config = {}, now = Date.now() } = {}) {
  const value = finite(pv);
  if (value > 0) {
    const weeklyLimit = finite(config.weeklyLossLimitPct);
    if (weeklyLimit > 0 && risk.weekStartPV > 0) {
      const drawdownPct = (value - risk.weekStartPV) / risk.weekStartPV;
      if (drawdownPct <= -weeklyLimit) return { kind: "weekly_loss", drawdownPct, baseline: risk.weekStartPV };
    }
    const highWaterLimit = finite(config.highWaterDrawdownLimitPct);
    if (highWaterLimit > 0 && risk.highWaterPV > 0) {
      const drawdownPct = (value - risk.highWaterPV) / risk.highWaterPV;
      if (drawdownPct <= -highWaterLimit) return { kind: "high_water_drawdown", drawdownPct, baseline: risk.highWaterPV };
    }
  }
  if ((finite(risk.cooldownUntil) ?? 0) > now) {
    return { kind: "loss_cooldown", until: risk.cooldownUntil };
  }
  const maxLosses = finite(config.maxConsecutiveLosses);
  if (maxLosses > 0 && (finite(risk.consecutiveLosses) ?? 0) >= maxLosses) {
    return { kind: "consecutive_losses", losses: risk.consecutiveLosses, limit: maxLosses };
  }
  return null;
}
