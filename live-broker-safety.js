export const CANONICAL_LIVE_BROKERS = Object.freeze({
  robinhood: "robinhood",
  tradier: "tradier",
});

const LIVE_BROKERS = new Set(Object.values(CANONICAL_LIVE_BROKERS));

function normalizedAccountId(value) {
  // Runtime ids are authorization identities, not labels. Only the two exact canonical ids own
  // process-global credentials; case/whitespace variants are separate and must remain paper.
  return String(value || "");
}

export function canonicalLiveBrokerForAccount(accountId) {
  return CANONICAL_LIVE_BROKERS[normalizedAccountId(accountId)] || null;
}

export function isCanonicalLiveAccount(accountId) {
  return canonicalLiveBrokerForAccount(accountId) != null;
}

/**
 * Broker credentials are process-global, so only one runtime may own each real broker. Canonical
 * live runtimes keep their broker binding; every other persisted/runtime account is paper-only.
 */
export function sanitizeRuntimeBrokerConfig(accountId, config = {}) {
  const before = { ...config };
  const next = { ...config };
  const canonicalBroker = canonicalLiveBrokerForAccount(accountId);
  const requestedBroker = String(next.broker || "paper").toLowerCase();

  if (canonicalBroker) {
    next.broker = canonicalBroker;
  } else if (LIVE_BROKERS.has(requestedBroker)) {
    next.broker = "paper";
    next.autoExecute = false;
    next.tradeWhenClosed = false;
    next.liveEntriesEnabled = false;
  } else {
    next.broker = "paper";
  }

  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (before[key] !== next[key]) changes.push({ key, before: before[key], after: next[key] });
  }
  return { config: next, changes, canonicalBroker };
}

function accountNumber(record) {
  // Do not fall back to a generic `id`: some broker responses use that for an internal record
  // UUID, which must never silently become the account used for order placement.
  const value = record?.account_number ?? record?.account_id ?? record?.accountNumber;
  return value == null || value === "" ? null : String(value);
}

function affirmative(value) {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

export function isExplicitlyAgenticAccount(record) {
  return affirmative(record?.agentic_allowed) || affirmative(record?.is_agentic);
}

export function robinhoodAccountAllowlistFromEnv(env = {}) {
  const raw = env.ROBINHOOD_ACCOUNT_ALLOWLIST ?? env.ROBINHOOD_ACCOUNT_NUMBER ?? "";
  return [...new Set(String(raw).split(",").map(value => value.trim()).filter(Boolean))];
}

/** Select exactly one explicitly authorized Robinhood account; ambiguity always fails closed. */
export function selectRobinhoodTradingAccount(records, { allowlist = [] } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const normalized = rows
    .map(record => ({ record, accountNumber: accountNumber(record) }))
    .filter(row => row.accountNumber != null);
  const allowed = new Set((allowlist || []).map(String));

  if (allowed.size > 0) {
    const matches = normalized.filter(row => allowed.has(row.accountNumber));
    if (matches.length !== 1) {
      return {
        accountNumber: null,
        mode: "allowlist",
        reason: `configured Robinhood account allowlist matched ${matches.length} accounts; exactly one is required`,
      };
    }
    return { accountNumber: matches[0].accountNumber, mode: "allowlist", reason: null };
  }

  const agentic = normalized.filter(row => isExplicitlyAgenticAccount(row.record));
  if (agentic.length !== 1) {
    return {
      accountNumber: null,
      mode: "agentic",
      reason: `Robinhood discovery found ${agentic.length} explicitly agentic accounts; exactly one is required`,
    };
  }
  return { accountNumber: agentic[0].accountNumber, mode: "agentic", reason: null };
}

/**
 * The automated lifecycle is long-options-only. Negative quantity or an explicit short side must
 * be quarantined so it can never reach a sell_to_close path.
 */
export function classifyLongOptionHolding({ quantity, positionSide = null } = {}) {
  const parsedQuantity = Number(quantity);
  const side = String(positionSide || "").trim().toLowerCase();
  const explicitlyShort = side === "short" || side.startsWith("short_") || side === "sell_short";

  if (!Number.isFinite(parsedQuantity) || parsedQuantity === 0) {
    return { manageable: false, quarantine: false, quantity: 0, reason: "no open quantity" };
  }
  if (parsedQuantity < 0 || explicitlyShort) {
    return {
      manageable: false,
      quarantine: true,
      quantity: Math.abs(parsedQuantity),
      reason: explicitlyShort ? `explicit short option side (${side})` : "negative option quantity",
    };
  }
  return { manageable: true, quarantine: false, quantity: parsedQuantity, reason: null };
}
