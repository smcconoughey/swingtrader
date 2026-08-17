import crypto from "node:crypto";

export const ENTRY_APPROVAL = "entry";
export const LOSS_EXIT_APPROVAL = "loss_exit";

const ACTIVE_STATUSES = new Set(["pending", "approved", "executing"]);
const FINAL_STATUSES = new Set(["executed", "rejected", "expired", "failed"]);
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_APPROVAL_HISTORY = 100;

const finite = value => Number.isFinite(Number(value));
const normalizedText = value => String(value || "").trim();

function queueFor(state = {}) {
  if (!Array.isArray(state.tradeApprovals)) state.tradeApprovals = [];
  return state.tradeApprovals;
}

function normalizedProposal(proposal = {}) {
  const kind = proposal.kind === LOSS_EXIT_APPROVAL ? LOSS_EXIT_APPROVAL : ENTRY_APPROVAL;
  const contractKey = normalizedText(proposal.contractKey).toUpperCase();
  const ticker = normalizedText(proposal.ticker).toUpperCase();
  const quantity = Math.max(0, Math.floor(Number(proposal.quantity) || 0));
  const limitPrice = finite(proposal.limitPrice) ? +Number(proposal.limitPrice).toFixed(2) : null;
  if (!contractKey || !ticker || quantity < 1 || !(limitPrice > 0)) {
    throw new TypeError("trade approval requires ticker, exact contractKey, quantity, and positive limitPrice");
  }
  return {
    ...proposal,
    kind,
    contractKey,
    ticker,
    quantity,
    limitPrice,
    side: kind === ENTRY_APPROVAL ? "buy_to_open" : "sell_to_close",
  };
}

export function tradeApprovalFingerprint(proposal = {}) {
  const normalized = normalizedProposal(proposal);
  return [normalized.kind, normalized.contractKey, normalized.side, normalized.quantity].join("|");
}

function priceWithinAuthority(row, proposal) {
  if (proposal.kind === ENTRY_APPROVAL) return proposal.limitPrice <= row.limitPrice;
  return proposal.limitPrice >= row.limitPrice;
}

function expireStale(queue, now) {
  for (const row of queue) {
    if (ACTIVE_STATUSES.has(row.status) && Number(row.expiresAt) <= now) {
      row.status = "expired";
      row.resolvedAt = now;
    }
  }
}

function trimHistory(state) {
  const queue = queueFor(state);
  if (queue.length <= MAX_APPROVAL_HISTORY) return;
  const active = queue.filter(row => ACTIVE_STATUSES.has(row.status));
  const final = queue.filter(row => FINAL_STATUSES.has(row.status))
    .sort((a, b) => Number(b.resolvedAt || b.createdAt || 0) - Number(a.resolvedAt || a.createdAt || 0));
  state.tradeApprovals = [...active, ...final.slice(0, Math.max(0, MAX_APPROVAL_HISTORY - active.length))];
}

export function requestTradeApproval(state, rawProposal, {
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  idFactory = () => crypto.randomUUID(),
} = {}) {
  const proposal = normalizedProposal(rawProposal);
  const fingerprint = tradeApprovalFingerprint(proposal);
  const queue = queueFor(state);
  expireStale(queue, now);

  const reusable = [...queue].reverse().find(row =>
    row.fingerprint === fingerprint
    && (row.status === "pending" || row.status === "approved")
    && Number(row.expiresAt) > now
    && priceWithinAuthority(row, proposal));
  if (reusable) {
    reusable.lastSeenAt = now;
    reusable.currentLimitPrice = proposal.limitPrice;
    return { approval: reusable, authorized: reusable.status === "approved", created: false };
  }

  const rejected = [...queue].reverse().find(row =>
    row.fingerprint === fingerprint
    && row.status === "rejected"
    && Number(row.expiresAt) > now
    && priceWithinAuthority(row, proposal));
  if (rejected) {
    rejected.lastSeenAt = now;
    rejected.currentLimitPrice = proposal.limitPrice;
    return { approval: rejected, authorized: false, created: false, rejected: true };
  }

  for (const row of queue) {
    if (row.fingerprint === fingerprint && (row.status === "pending" || row.status === "approved")) {
      row.status = "expired";
      row.resolvedAt = now;
      row.resolutionReason = "price moved outside approved boundary";
    }
  }

  const approval = {
    ...proposal,
    id: idFactory(),
    fingerprint,
    status: "pending",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
    currentLimitPrice: proposal.limitPrice,
  };
  queue.push(approval);
  trimHistory(state);
  return { approval, authorized: false, created: true, rejected: false };
}

export function approveTradeApproval(state, id, now = Date.now()) {
  const queue = queueFor(state);
  expireStale(queue, now);
  const approval = queue.find(row => row.id === id);
  if (!approval) return { ok: false, reason: "approval not found" };
  if (approval.status !== "pending") return { ok: false, reason: `approval is ${approval.status}`, approval };
  approval.status = "approved";
  approval.approvedAt = now;
  return { ok: true, approval };
}

export function rejectTradeApproval(state, id, now = Date.now()) {
  const approval = queueFor(state).find(row => row.id === id);
  if (!approval) return { ok: false, reason: "approval not found" };
  if (approval.status !== "pending" && approval.status !== "approved") {
    return { ok: false, reason: `approval is ${approval.status}`, approval };
  }
  approval.status = "rejected";
  approval.resolvedAt = now;
  return { ok: true, approval };
}

export function cancelTradeApproval(state, id, now = Date.now()) {
  const queue = queueFor(state);
  expireStale(queue, now);
  const approval = queue.find(row => row.id === id);
  if (!approval) return { ok: false, reason: "approval not found" };
  if (approval.status !== "approved") {
    return { ok: false, reason: approval.status === "executing"
      ? "broker submission has already started"
      : `approval is ${approval.status}`, approval };
  }
  approval.status = "rejected";
  approval.canceledAt = now;
  approval.resolvedAt = now;
  approval.resolutionReason = "operator canceled queued approval";
  return { ok: true, approval };
}

export function beginApprovedTrade(state, rawProposal, now = Date.now()) {
  const proposal = normalizedProposal(rawProposal);
  const fingerprint = tradeApprovalFingerprint(proposal);
  const queue = queueFor(state);
  expireStale(queue, now);
  const approval = [...queue].reverse().find(row =>
    row.fingerprint === fingerprint
    && row.status === "approved"
    && Number(row.expiresAt) > now
    && priceWithinAuthority(row, proposal));
  if (!approval) return { ok: false, reason: "operator approval required" };
  approval.status = "executing";
  approval.executionStartedAt = now;
  approval.executionLimitPrice = proposal.limitPrice;
  return { ok: true, approval };
}

export function finishApprovedTrade(state, id, { ok, reason = null, now = Date.now() } = {}) {
  const approval = queueFor(state).find(row => row.id === id);
  if (!approval) return { ok: false, reason: "approval not found" };
  approval.status = ok ? "executed" : "failed";
  approval.resolvedAt = now;
  approval.resolutionReason = reason;
  trimHistory(state);
  return { ok: true, approval };
}

export function pendingTradeApprovals(state, now = Date.now()) {
  const queue = queueFor(state);
  expireStale(queue, now);
  return queue.filter(row => row.status === "pending").sort((a, b) => a.createdAt - b.createdAt);
}
