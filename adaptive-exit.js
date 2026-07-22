const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Select a quick-profit boundary from recent, confirmed executable high-water marks.
 * Callers are responsible for passing only real, confirmed outcomes; rows without an
 * executable bestExitPnlPct are excluded here so midpoint or synthetic marks cannot train it.
 */
export function deriveAdaptiveExitProfile(history = [], config = {}, optionType = null) {
  const minTargetPct = clamp(finite(config.adaptiveTargetMinPct, 0.10), 0.01, 1);
  const maxTargetPct = clamp(
    finite(config.adaptiveTargetMaxPct, 0.15),
    minTargetPct,
    1,
  );
  const fallbackTargetPct = clamp(
    finite(config.adaptiveTargetFallbackPct, 0.12),
    minTargetPct,
    maxTargetPct,
  );
  const requiredReachRate = clamp(finite(config.adaptiveTargetReachRate, 0.65), 0.01, 1);
  const lookback = Math.max(1, Math.round(finite(config.adaptiveTargetLookback, 20)));
  const minSamples = Math.max(1, Math.round(finite(config.adaptiveTargetMinSamples, 5)));

  const eligible = (Array.isArray(history) ? history : []).filter(trade => (
    trade
    && trade.type !== "equity"
    && trade.optionsSource !== "synthetic"
    && !trade._pending
    && !trade._pendingFill
    && !trade._estimated
    && Number.isFinite(Number(trade.bestExitPnlPct))
  ));
  const typed = optionType ? eligible.filter(trade => trade.type === optionType) : [];
  const pool = (optionType && typed.length >= minSamples ? typed : eligible).slice(-lookback);
  const source = optionType && typed.length >= minSamples ? optionType : "all options";
  const peaks = pool.map(trade => Math.max(0, Number(trade.bestExitPnlPct)));

  let targetPct = fallbackTargetPct;
  let reachRate = peaks.length
    ? peaks.filter(peak => peak >= targetPct).length / peaks.length
    : null;
  let basis = "fallback";

  if (peaks.length >= minSamples) {
    const candidates = [];
    for (let pct = Math.round(minTargetPct * 100); pct <= Math.round(maxTargetPct * 100); pct += 1) {
      candidates.push(pct / 100);
    }
    const rows = candidates.map(candidate => ({
      candidate,
      rate: peaks.filter(peak => peak >= candidate).length / peaks.length,
    }));
    const qualified = rows.filter(row => row.rate >= requiredReachRate);
    const selected = qualified.length ? qualified[qualified.length - 1] : rows[0];
    targetPct = selected.candidate;
    reachRate = selected.rate;
    basis = qualified.length ? "recent reach rate" : "recent minimum boundary";
  }

  const profitLockArmPct = +clamp(targetPct - 0.04, 0.06, 0.10).toFixed(4);
  return {
    version: 1,
    targetPct,
    minTargetPct,
    maxTargetPct,
    fallbackTargetPct,
    requiredReachRate,
    sampleSize: peaks.length,
    minSamples,
    lookback,
    source,
    basis,
    reachRate,
    profitLockArmPct,
    peakGivebackMin: clamp(finite(config.peakGivebackMin, 0.025), 0.005, 0.25),
    peakGivebackFrac: clamp(finite(config.peakGivebackFrac, 0.25), 0.05, 1),
  };
}
