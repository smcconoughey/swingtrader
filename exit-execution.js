const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const cents = value => +Math.max(0.01, value).toFixed(2);

// Longer than the Robinhood stale-order watchdog. A just-submitted order can be absent from the
// broker's next "confirmed" snapshot; retaining our local intent prevents a duplicate sell.
export const EXIT_INFLIGHT_GRACE_MS = 4 * 60_000;

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
  let limit = mid;

  if (executableNow) {
    if (liveBid == null) return { limit: null, mid, spreadPct, executableNow };
    // A protective limit at the displayed bid can miss in a falling market. The first retry crosses
    // one tick; a sell limit below the bid still fills at the best available price, never worse than
    // its limit. Profit-bank orders remain at the bid and do not donate the extra tick.
    limit = priceMode === "marketable" && exitAttempts >= 1
      ? Math.max(0.01, liveBid - 0.01)
      : liveBid;
  } else if (exitAttempts >= 2 && liveBid != null) {
    // Patient orders get two attempts. After that, cross one tick to make the limit unambiguous.
    limit = Math.max(0.01, liveBid - 0.01);
  } else if (protective) {
    if (spreadPct <= wideSpreadPct && liveBid != null) {
      limit = liveBid;
    } else {
      limit = Math.max(liveBid ?? 0, mid * (1 - maxConcessionPct));
    }
  }

  return { limit: cents(limit), mid, spreadPct, executableNow };
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
