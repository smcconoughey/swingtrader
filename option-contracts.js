export const FEE_PER_CONTRACT = 0.35;
export const MIN_OPTION_DELTA = 0.40;
export const PREFERRED_DELTA_MIN = 0.45;
export const PREFERRED_DELTA_MAX = 0.70;
export const MAX_OTM_MONEYNESS = 0.06;
export const MAX_ITM_MONEYNESS = 0.15;
export const MAX_ENTRY_SPREAD_PCT = 0.30;
export const MAX_ENTRY_OVERPAY_PCT = 0.15;
export const MAX_ENTRY_IV = 1.50;

export function buildCandidateContracts(chain, type, spotPrice, maxCandidates = 12, now = Date.now()) {
  const typeKey = type.toUpperCase();
  const candidates = [];

  for (const exp of chain) {
    // Date-only strings parse as UTC; applying setHours() afterward can move the contract to the
    // prior calendar day in US time zones. Preserve the broker's YYYY-MM-DD as a local date.
    const expiryDt = new Date(`${exp.expirationDate}T16:00:00`);
    const dte = Math.round((expiryDt.getTime() - now) / 86400_000);
    if (dte < 14 || dte > 45) continue;

    const contracts = exp.options?.[typeKey] || [];
    for (const c of contracts) {
      if (!c.strike || c.strike <= 0) continue;
      if (!c.bid || c.bid <= 0) continue;
      if (!c.ask || c.ask <= 0 || c.ask < c.bid) continue;
      if ((c.openInterest || 0) < 100 && (c.volume || 0) < 50) continue;

      const mid = +((c.bid + c.ask) / 2).toFixed(2);
      if (mid < 0.25) continue;

      const moneyness = typeKey === "CALL"
        ? (c.strike - spotPrice) / spotPrice
        : (spotPrice - c.strike) / spotPrice;
      if (moneyness < -MAX_ITM_MONEYNESS || moneyness > MAX_OTM_MONEYNESS) continue;

      const spread = +(c.ask - c.bid).toFixed(2);
      const spreadPct = mid > 0 ? spread / mid : 1;
      if (spreadPct > 0.40 && mid > 0.10) continue;
      const roundTripFrictionPct = ((c.ask - c.bid) + (2 * FEE_PER_CONTRACT / 100)) / c.ask;

      const iv = c.impliedVolatility > 0 ? c.impliedVolatility : null;
      const delta = c.delta != null ? c.delta : null;
      if (iv != null && iv > MAX_ENTRY_IV) continue;
      if (delta != null && Math.abs(delta) < MIN_OPTION_DELTA) continue;

      const feeDragPct = mid > 0 ? (2 * FEE_PER_CONTRACT) / (mid * 100) : 0;
      const smallCapPenalty = spotPrice < 10 ? 0.6 : spotPrice < 20 ? 0.3 : 0;
      const dtePenalty = Math.abs(dte - 28);
      const liqScore = Math.log1p((c.openInterest || 0) + (c.volume || 0));
      const absD = delta != null ? Math.abs(delta) : 0;
      const deltaBonus = absD >= PREFERRED_DELTA_MIN && absD <= PREFERRED_DELTA_MAX ? 2.0
        : absD >= MIN_OPTION_DELTA ? 0.6 : 0;
      const otmPenalty = Math.max(0, moneyness) * 6;
      const quality = liqScore - spreadPct * 3 - dtePenalty * 0.1 - feeDragPct * 4
        - smallCapPenalty + deltaBonus - otmPenalty;

      candidates.push({
        dataSource: exp.dataSource || "unknown",
        occSymbol: c.occSymbol || c.symbol || null,
        strike: c.strike,
        expiryDate: expiryDt.getTime(),
        expiryStr: exp.expirationDate,
        dte,
        mid,
        bid: c.bid,
        ask: +(c.ask || 0).toFixed(2),
        iv,
        delta,
        gamma: c.gamma ?? null,
        theta: c.theta ?? null,
        vega: c.vega ?? null,
        oi: c.openInterest || 0,
        volume: c.volume || 0,
        spread,
        spreadPct: +(spreadPct * 100).toFixed(1),
        roundTripFrictionPct: +(roundTripFrictionPct * 100).toFixed(1),
        feeDragPct: +(feeDragPct * 100).toFixed(1),
        quality,
      });
    }
  }

  candidates.sort((a, b) => b.quality - a.quality);
  return candidates.slice(0, maxCandidates);
}

export function entryLimitPrice(bid, ask, mid, conviction) {
  const m = +(+mid).toFixed(2);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return m;
  const aggression = Math.max(0, Math.min(1, conviction));
  const price = mid + aggression * (ask - mid);
  const ceiling = +(mid * (1 + MAX_ENTRY_OVERPAY_PCT)).toFixed(2);
  return +Math.min(ceiling, Math.min(ask, Math.max(bid, price))).toFixed(2);
}
