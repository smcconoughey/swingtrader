/**
 * Entry-order halt policy for live brokers.
 *
 * Independent audits found in-flight buys that could outlive a pause or disabled entry toggle.
 * These helpers are pure so the fail-closed rules can be unit-tested without loading bot.js.
 */

/**
 * Why live buy placement / ambiguous buy replay must stop. Protective sells are unaffected.
 * @returns {string|null} human reason, or null when buy work is allowed
 */
export function entryBuyHaltReason(acct = {}) {
  const broker = acct?.config?.broker;
  if (broker !== "tradier" && broker !== "robinhood") return null;
  if (acct.config?.liveEntriesEnabled !== true) {
    return "live-entry toggle off";
  }
  if (acct.paused) {
    return `pause (${acct.pausedBy || "manual"})`;
  }
  return null;
}

/** Ambiguous buy submissions may only be idempotently replayed when entries are fully armed. */
export function ambiguousBuyReplayAllowed(acct = {}) {
  return entryBuyHaltReason(acct) == null;
}

/**
 * Broker-visible working buys must be canceled on any entry halt (risk, user pause, entry toggle).
 * Ambiguous submissions without an order id cannot be canceled remotely — they stay quarantined
 * and must not be replayed (see ambiguousBuyReplayAllowed).
 */
export function shouldCancelWorkingBuysOnHalt(acct = {}) {
  return entryBuyHaltReason(acct) != null;
}
