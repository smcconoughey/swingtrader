const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const cents = value => +Math.max(0.01, value).toFixed(2);

// Longer than the Robinhood stale-order watchdog. A just-submitted order can be absent from the
// broker's next "confirmed" snapshot; retaining our local intent prevents a duplicate sell.
export const EXIT_INFLIGHT_GRACE_MS = 4 * 60_000;

// How large a "phantom" underlying move (implied by premium gap / |δ|) we tolerate from book noise.
// PATH 7/16: $0.25 bid vs ~$0.86 mark at δ≈0.45 implied ~11% phantom stock slip with no real move.
export const EXIT_PHANTOM_SPOT_PCT = 0.02; // 2% of spot
export const EXIT_PHANTOM_SPOT_FLOOR = 0.05; // never sweat nickels
export const EXIT_JUSTIFIED_CUSHION = 1.75; // allow IV/spread/gamma beyond pure delta×spot

/**
 * True only for capital-preservation emergencies (DTE blow-up / premium disaster).
 * Those still use the same price physics — just a wider cushion — never a blind dump.
 */
export function isEmergencyExitReason(reason = "") {
  return /dte critical|low-?dte|disaster|expir(?:y|ing)|premium collapse|confirmed premium stop|wide-book premium stop/i.test(String(reason || ""));
}

function absDelta(delta, fallback = 0.40) {
  const d = Math.abs(Number(delta));
  if (Number.isFinite(d) && d >= 0.05) return Math.min(d, 0.95);
  return fallback;
}

/**
 * A sell limit far below the live mark is only "real" if the underlying also slipped enough
 * for delta to explain the premium drop. Otherwise the bid is a book dislocation (PATH $0.25
 * fill while mark ~$0.85) — refuse it.
 */
export function exitLimitSanityCheck({
  limit,
  bid,
  ask,
  mark,
  referencePrice,
  spot = null,
  entrySpot = null,
  entryPremium = null,
  delta = null,
  optionType = "call",
  atrPct = null,
  reason = "",
} = {}) {
  const liveLimit = positive(limit);
  if (liveLimit == null) return { ok: false, reason: "no executable sell limit" };

  const liveBid = positive(bid);
  const liveAsk = positive(ask);
  const liveMark = positive(mark);
  const mid = liveBid != null && liveAsk != null && liveAsk >= liveBid
    ? (liveBid + liveAsk) / 2
    : null;
  const fair = liveMark ?? mid ?? positive(referencePrice);
  if (!(fair > 0)) return { ok: true, reason: null };

  const gapVsFair = fair - liveLimit;
  const d = absDelta(delta);
  const spotNow = positive(spot) ?? positive(entrySpot);
  const emergency = isEmergencyExitReason(reason);
  const wideBookPremiumStop = /wide-book premium stop/i.test(String(reason || ""));
  const atrFrac = Number.isFinite(atrPct) && atrPct > 0 ? atrPct / 100 : 0.02;
  // Book noise allowance in premium-$: half-spread, ~δ×(2% spot), and a slice of ATR.
  const halfSpread = liveBid != null && liveAsk != null ? (liveAsk - liveBid) / 2 : 0;
  const spotNoise = spotNow != null
    ? d * spotNow * Math.max(EXIT_PHANTOM_SPOT_PCT, atrFrac * 0.5)
    : EXIT_PHANTOM_SPOT_FLOOR;
  const noiseAllow = Math.max(EXIT_PHANTOM_SPOT_FLOOR, halfSpread, spotNoise);
  const cushion = emergency ? EXIT_JUSTIFIED_CUSHION * 1.5 : EXIT_JUSTIFIED_CUSHION;

  // A confirmed premium stop reaches here only after the lifecycle manager observed repeated
  // exact-contract bids over time. Once the current NBBO is also coherent and reasonably tight,
  // Greek attribution must not veto the protective exit: IV crush and theta can legitimately
  // damage premium without a delta-sized underlying move.
  const liveSpreadPct = mid > 0 && liveBid != null && liveAsk != null ? (liveAsk - liveBid) / mid : Infinity;
  if (emergency && liveBid != null && liveAsk != null && liveAsk >= liveBid
      && liveSpreadPct <= 0.20 && liveLimit <= liveBid + 0.01) {
    return { ok: true, reason: null, fair: mid, gapVsFair: Math.max(0, mid - liveLimit), confirmedBook: true };
  }

  // The weak side of a deliberately wide book remains untrusted even after the lifecycle's
  // three-minute escalation. The first patient limit can rest near fair value; a later retry at
  // a raw phantom bid is rejected until the mark/mid converges enough to corroborate it.
  if (wideBookPremiumStop && liveSpreadPct > 0.20 && liveBid != null
      && liveLimit <= liveBid + 0.01 && gapVsFair > Math.max(0.05, fair * 0.15)) {
    return {
      ok: false,
      reason: `raw wide-book bid $${liveLimit.toFixed(2)} is not corroborated by mark/mid $${fair.toFixed(2)} — keep patient protective limit`,
      fair,
      gapVsFair,
      rawWideBookBid: true,
    };
  }

  // 1) Mark already embeds the current spot. A bid far below mark implies a phantom extra
  //    underlying move that is not in the quote — refuse unless that gap is just noise.
  if (gapVsFair > noiseAllow * cushion) {
    const phantomSpotMove = gapVsFair / d;
    const phantomPct = spotNow != null && spotNow > 0 ? phantomSpotMove / spotNow : null;
    const phantomLabel = phantomPct != null
      ? ` (~${(phantomPct * 100).toFixed(1)}% phantom underlying @ δ${d.toFixed(2)})`
      : ` (~$${phantomSpotMove.toFixed(2)} phantom underlying @ δ${d.toFixed(2)})`;
    return {
      ok: false,
      reason: `sell $${liveLimit.toFixed(2)} is $${gapVsFair.toFixed(2)} below mark/mid $${fair.toFixed(2)}${phantomLabel} with no matching spot slip — book dislocation`,
      fair,
      gapVsFair,
      phantomSpotMove,
      phantomPct,
    };
  }

  // 2) Vs entry: a huge premium collapse also needs a real adverse stock move of size drop/δ.
  //    Catches contaminated marks that sit near a garbage bid.
  const basis = positive(entryPremium);
  const basisSpot = positive(entrySpot);
  if (basis != null && basisSpot != null && spotNow != null && liveLimit < basis) {
    const dropFromEntry = basis - liveLimit;
    const spotMove = spotNow - basisSpot;
    const adverseSpot = optionType === "put" ? Math.max(0, spotMove) : Math.max(0, -spotMove);
    const justified = d * adverseSpot * cushion + noiseAllow;
    if (dropFromEntry > justified) {
      const needSpot = Math.max(0, (dropFromEntry - noiseAllow) / (d * cushion));
      const adversePct = (adverseSpot / basisSpot) * 100;
      return {
        ok: false,
        reason: `sell $${liveLimit.toFixed(2)} collapses premium $${dropFromEntry.toFixed(2)} from entry $${basis.toFixed(2)} but spot only slipped ${adversePct.toFixed(1)}% (need ~$${needSpot.toFixed(2)} / ${((needSpot / basisSpot) * 100).toFixed(1)}% adverse @ δ${d.toFixed(2)})`,
        fair,
        gapVsFair: dropFromEntry,
        phantomSpotMove: needSpot,
        phantomPct: needSpot / basisSpot,
      };
    }
  }

  return { ok: true, reason: null, fair, gapVsFair: Math.max(0, gapVsFair) };
}

/**
 * Translate a manager price mode into a concrete sell limit.
 * "bank" and "marketable" mean what they say: use the executable bid now.
 */
export function chooseOptionSellLimit({
  bid,
  ask,
  mark,
  referencePrice,
  priceMode = "patient",
  protective = false,
  exitAttempts = 0,
  wideSpreadPct = 0.20,
  maxConcessionPct = 0.12,
} = {}) {
  const liveBid = positive(bid);
  const liveAsk = positive(ask);
  const fallback = positive(mark) ?? positive(referencePrice);
  const mid = liveBid != null && liveAsk != null && liveAsk >= liveBid
    ? (liveBid + liveAsk) / 2
    : fallback;
  if (!(mid > 0)) return { limit: null, mid: null, spreadPct: null, executableNow: false };

  const spreadPct = liveBid != null && liveAsk != null ? (liveAsk - liveBid) / mid : 0;
  const executableNow = priceMode === "bank" || priceMode === "marketable";
  const attempts = Math.max(0, Math.floor(Number(exitAttempts) || 0));
  let operatorEscalation = false;
  let escalationReason = null;
  let limit = mid;

  if (executableNow) {
    if (liveBid == null) return { limit: null, mid, spreadPct, executableNow };
    // A protective limit at the displayed bid can miss in a falling market. The first retry crosses
    // one tick; a sell limit below the bid still fills at the best available price, never worse than
    // its limit. Profit-bank orders remain at the bid and do not donate the extra tick.
    limit = priceMode === "marketable" && attempts >= 1
      ? Math.max(0.01, liveBid - 0.01)
      : liveBid;
  } else if (protective) {
    if (spreadPct <= wideSpreadPct && liveBid != null) {
      limit = liveBid;
    } else {
      // A sustained wide book is specifically the case where the raw bid is untrusted. Escalate a
      // patient protective order in bounded steps, but never let a retry jump to that quarantined
      // bid (the prior attempt>=2 branch did exactly that and was then rejected forever by the
      // sanity layer). Two cents above the displayed bid is the smallest cent-denominated guard
      // that remains outside the raw-bid rejection band.
      const guardedBid = liveBid != null ? liveBid + 0.02 : 0;
      const concession = Math.min(0.36, maxConcessionPct * (1 + attempts * 0.5));
      limit = Math.max(guardedBid, mid * (1 - concession));
      const atGuardedFloor = liveBid != null && limit <= guardedBid + 0.005;
      if (atGuardedFloor && attempts >= 2) {
        operatorEscalation = true;
        escalationReason = `wide-book protective exit reached guarded floor above bid after ${attempts + 1} attempts`;
      }
    }
  } else if (attempts >= 2 && liveBid != null) {
    // Non-protective patient orders may eventually cross one tick. Protective wide-book orders are
    // handled above and can never fall through to a quarantined raw bid.
    limit = Math.max(0.01, liveBid - 0.01);
  }

  return { limit: cents(limit), mid, spreadPct, executableNow, operatorEscalation, escalationReason };
}

export function exitIntentWithinGrace(meta = {}, now = Date.now(), graceMs = EXIT_INFLIGHT_GRACE_MS) {
  const placedAt = Number(meta.exitOrderPlacedAt);
  if (!(placedAt > 0)) return false;
  const age = Math.max(0, now - placedAt);
  return age <= graceMs;
}

export function mergeInflightTickers({
  brokerTickers = [],
  previousTickers = [],
  brokerSnapshotComplete = true,
  localIntents = [],
  now = Date.now(),
} = {}) {
  const merged = new Set([...brokerTickers].map(value => String(value).toUpperCase()).filter(Boolean));
  // An API failure is not proof that every working order disappeared.
  if (!brokerSnapshotComplete) {
    for (const ticker of previousTickers) if (ticker) merged.add(String(ticker).toUpperCase());
  }
  for (const intent of localIntents) {
    if (!intent?.ticker || !(intent.placedAt > 0)) continue;
    const age = Math.max(0, now - intent.placedAt);
    if (age <= intent.graceMs) merged.add(String(intent.ticker).toUpperCase());
  }
  return merged;
}
