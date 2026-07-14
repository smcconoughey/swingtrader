function sessionChangePct(quote) {
  if (typeof quote?.dp === "number" && Number.isFinite(quote.dp)) return quote.dp;
  if (typeof quote?.d === "number" && Number.isFinite(quote.d) && quote?.pc > 0) {
    return (quote.d / quote.pc) * 100;
  }
  return null;
}

function finiteOr(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

// Convert both trade directions to the same scale: higher always means stronger conviction.
// A 10-score put is therefore conviction 90, not weaker than a 34-score put.
export function directionalConviction(decision) {
  const score = finiteOr(decision?.finalScore, 50);
  return decision?.action === "BUY PUT" ? 100 - score : score;
}

// Prefer names that are actually moving in the trade direction among similarly strong setups.
// Score/conviction remains the main input; momentum only reorders nearby candidates.
export function entryPriority(decision, shortTerm, quote) {
  const conviction = directionalConviction(decision);
  const mom1d = finiteOr(shortTerm?.mom1d);
  const mom3d = finiteOr(shortTerm?.mom3d);
  const dayPct = sessionChangePct(quote) ?? 0;
  const direction = decision?.action === "BUY PUT" ? -1 : 1;

  return conviction
    + Math.max(-8, Math.min(12, direction * mom1d * 1.5))
    + Math.max(-4, Math.min(6, direction * mom3d * 0.4))
    + Math.max(-3, Math.min(5, direction * dayPct * 0.35));
}

// Reject trades moving against their direction at every score. Only the flat-tape requirement
// is waived for exceptional scores, allowing a high-conviction setup to enter before momentum.
export function momentumEntryGate(cfg, analysis, shortTerm, quote, isBullish) {
  if (cfg?.momentumGate === false) return null;

  const mom1d = typeof shortTerm?.mom1d === "number" && Number.isFinite(shortTerm.mom1d)
    ? shortTerm.mom1d
    : null;
  const dayPct = sessionChangePct(quote);
  const score = finiteOr(analysis?.score, 50);

  if (isBullish) {
    if (dayPct != null && dayPct < -0.5) {
      return `Momentum gate — call blocked: day ${dayPct.toFixed(2)}% against the trade`;
    }
    if (mom1d != null && mom1d < -0.5) {
      return `Momentum gate — call blocked: 1d mom ${mom1d.toFixed(2)}% against the trade`;
    }
    if (score < 80) {
      if (dayPct != null && dayPct < 1.25) {
        return `Momentum gate — bullish score ${score} but day flat (${dayPct.toFixed(2)}%) — prefer a name that's actually moving`;
      }
      if (dayPct == null && mom1d != null && mom1d < 1.0) {
        return `Momentum gate — bullish score ${score} but 1d mom flat (${mom1d.toFixed(2)}%) — prefer a name that's actually moving`;
      }
    }
  } else {
    if (dayPct != null && dayPct > 0.5) {
      return `Momentum gate — put blocked: day ${dayPct.toFixed(2)}% against the trade`;
    }
    if (mom1d != null && mom1d > 0.5) {
      return `Momentum gate — put blocked: 1d mom ${mom1d.toFixed(2)}% against the trade`;
    }
    if (score > 20) {
      if (dayPct != null && dayPct > -1.25) {
        return `Momentum gate — bearish score ${score} but day flat (${dayPct.toFixed(2)}%) — prefer a name that's actually moving`;
      }
      if (dayPct == null && mom1d != null && mom1d > -1.0) {
        return `Momentum gate — bearish score ${score} but 1d mom flat (${mom1d.toFixed(2)}%) — prefer a name that's actually moving`;
      }
    }
  }
  return null;
}

export function rankEntryCandidates(decisions, shortTermAnalyses, quotes) {
  return decisions
    .filter(decision => decision.action === "BUY CALL" || decision.action === "BUY PUT")
    .map(decision => ({
      ticker: decision.ticker,
      priority: entryPriority(decision, shortTermAnalyses?.[decision.ticker], quotes?.[decision.ticker]),
      dec: decision,
    }))
    .sort((a, b) => b.priority - a.priority || a.ticker.localeCompare(b.ticker));
}

export function contractExecutionScore(contract) {
  if (!contract) return 60; // Equity/synthetic paper trades: neutral, not a fake liquidity edge.

  const frictionPct = finiteOr(contract.roundTripFrictionPct, finiteOr(contract.spreadPct, 40));
  // Full credit at <=2% executable friction, zero at >=15%.
  const spread = clamp((15 - frictionPct) / 13 * 100);

  const liquidity = clamp(Math.log10(Math.max(1, finiteOr(contract.oi) + finiteOr(contract.volume) + 1)) * 25);

  const rawDelta = typeof contract.delta === "number" && Number.isFinite(contract.delta)
    ? Math.abs(contract.delta)
    : null;
  const delta = rawDelta == null ? 50 : clamp(100 - Math.abs(rawDelta - 0.55) * 250);

  const dte = typeof contract.dte === "number" && Number.isFinite(contract.dte)
    ? clamp(100 - Math.abs(contract.dte - 28) * 4)
    : 50;

  return 0.35 * spread + 0.25 * liquidity + 0.25 * delta + 0.15 * dte;
}

export function completeTradeScore(decision, shortTerm, quote, preflight) {
  const technical = clamp(directionalConviction(decision));
  const setup = clamp(finiteOr(preflight?.setupQuality, 50));
  const confidence = clamp(finiteOr(preflight?.claudeConfidence, 50));
  const contract = contractExecutionScore(preflight?.contract || null);

  const direction = decision?.action === "BUY PUT" ? -1 : 1;
  const alignedMom1d = direction * finiteOr(shortTerm?.mom1d);
  const alignedMom3d = direction * finiteOr(shortTerm?.mom3d);
  const alignedDay = direction * (sessionChangePct(quote) ?? 0);
  const momentum = clamp(50 + alignedMom1d * 7 + alignedMom3d * 2 + alignedDay * 5);

  const score = 0.30 * technical
    + 0.25 * setup
    + 0.20 * contract
    + 0.15 * momentum
    + 0.10 * confidence;

  return {
    score,
    components: { technical, setup, contract, momentum, confidence },
  };
}

export function rankPreparedEntries(prepared, shortTermAnalyses, quotes) {
  return prepared
    .map(item => {
      const ranked = completeTradeScore(
        item.dec,
        shortTermAnalyses?.[item.ticker],
        quotes?.[item.ticker],
        item.preflight,
      );
      return { ...item, packagePriority: ranked.score, components: ranked.components };
    })
    .sort((a, b) => b.packagePriority - a.packagePriority || a.ticker.localeCompare(b.ticker));
}
