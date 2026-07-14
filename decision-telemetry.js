const HORIZONS = [
  ["m15", 15 * 60_000],
  ["h1", 60 * 60_000],
  ["h4", 4 * 60 * 60_000],
];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function directionAdjustedReturnPct(action, entrySpot, currentSpot) {
  if (!finite(entrySpot) || entrySpot <= 0 || !finite(currentSpot) || currentSpot <= 0) return null;
  const direction = action === "BUY PUT" ? -1 : 1;
  return direction * (currentSpot / entrySpot - 1) * 100;
}

export function selectionFingerprint(row) {
  return (row?.ranked || [])
    .filter(item => item.eligibility === "executable")
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .map(item => `${item.ticker}:${item.action}:${item.contract?.occSymbol || `${item.contract?.expiryStr || ""}:${item.contract?.strike || ""}`}`)
    .join("|");
}

export function shouldRecordSelectionCohort(journal, row, minRepeatMs = 30 * 60_000) {
  const comparable = (row?.ranked || []).filter(item => item.eligibility === "executable");
  if (comparable.length < 2) return false;
  if ((row.ranked || []).some(item => item.outcome === "entered" || item.outcome === "ordered")) return true;

  const fingerprint = selectionFingerprint(row);
  if (!fingerprint) return false;
  const previous = [...(journal || [])].reverse().find(item => selectionFingerprint(item) === fingerprint);
  return !previous || !finite(previous.at) || row.at - previous.at >= minRepeatMs;
}

export function applyUnderlyingSnapshots(journal, quotes, asOf = Date.now()) {
  return (journal || []).map(row => {
    if (!finite(row?.at) || row.at >= asOf) return row;
    let changed = false;
    const ranked = (row.ranked || []).map(item => {
      if (item.eligibility !== "executable" || !finite(item.entrySpot)) return item;
      const currentSpot = quotes?.[item.ticker]?.c;
      const currentPct = directionAdjustedReturnPct(item.action, item.entrySpot, currentSpot);
      if (currentPct == null) return item;

      const prior = item.forward || {};
      const forward = {
        ...prior,
        asOf,
        currentSpot,
        currentPct: +currentPct.toFixed(3),
        bestPct: +Math.max(prior.bestPct ?? -Infinity, currentPct).toFixed(3),
        worstPct: +Math.min(prior.worstPct ?? Infinity, currentPct).toFixed(3),
      };
      const age = asOf - row.at;
      for (const [name, threshold] of HORIZONS) {
        if (age >= threshold && !forward[name]) {
          forward[name] = { asOf, spot: currentSpot, pct: +currentPct.toFixed(3) };
        }
      }
      changed = true;
      return { ...item, forward };
    });
    return changed ? { ...row, ranked } : row;
  });
}

export function summarizeRankOne(journal, horizon = "h1") {
  const cohorts = [];
  for (const row of journal || []) {
    const comparable = (row.ranked || [])
      .filter(item => item.eligibility === "executable" && finite(item.forward?.[horizon]?.pct))
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    if (comparable.length < 2 || comparable[0].rank !== 1) continue;
    const top = comparable[0].forward[horizon].pct;
    const alternatives = comparable.slice(1).map(item => item.forward[horizon].pct);
    const bestAlternative = Math.max(...alternatives);
    const meanAlternative = alternatives.reduce((sum, value) => sum + value, 0) / alternatives.length;
    cohorts.push({ top, bestAlternative, meanAlternative });
  }
  if (!cohorts.length) return { n: 0, hitRate: null, meanLift: null, meanRegret: null };
  return {
    n: cohorts.length,
    hitRate: cohorts.filter(c => c.top >= c.bestAlternative).length / cohorts.length,
    meanLift: cohorts.reduce((sum, c) => sum + c.top - c.meanAlternative, 0) / cohorts.length,
    meanRegret: cohorts.reduce((sum, c) => sum + Math.max(0, c.bestAlternative - c.top), 0) / cohorts.length,
  };
}
