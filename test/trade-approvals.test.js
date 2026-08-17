import test from "node:test";
import assert from "node:assert/strict";

import {
  ENTRY_APPROVAL,
  LOSS_EXIT_APPROVAL,
  approveTradeApproval,
  beginApprovedTrade,
  cancelTradeApproval,
  finishApprovedTrade,
  pendingTradeApprovals,
  rejectTradeApproval,
  requestTradeApproval,
} from "../trade-approvals.js";

const entry = (overrides = {}) => ({
  kind: ENTRY_APPROVAL,
  ticker: "SPY",
  contractKey: "SPY260918C00700000",
  quantity: 1,
  limitPrice: 4.25,
  ...overrides,
});

test("entry approval is durable, one-shot, and capped at the approved buy price", () => {
  const state = {};
  const requested = requestTradeApproval(state, entry(), { now: 100, idFactory: () => "entry-1" });
  assert.equal(requested.created, true);
  assert.equal(requested.authorized, false);
  assert.equal(approveTradeApproval(state, "entry-1", 200).ok, true);

  assert.equal(requestTradeApproval(state, entry({ limitPrice: 4.20 }), { now: 300 }).authorized, true);
  assert.equal(beginApprovedTrade(state, entry({ limitPrice: 4.20 }), 301).ok, true);
  assert.equal(beginApprovedTrade(state, entry({ limitPrice: 4.20 }), 302).ok, false);
  assert.equal(finishApprovedTrade(state, "entry-1", { ok: true, now: 400 }).approval.status, "executed");
});

test("a higher entry price invalidates approval and creates a fresh request", () => {
  const state = {};
  requestTradeApproval(state, entry(), { now: 100, idFactory: () => "old" });
  approveTradeApproval(state, "old", 200);
  const next = requestTradeApproval(state, entry({ limitPrice: 4.26 }), {
    now: 300,
    idFactory: () => "new",
  });
  assert.equal(next.approval.id, "new");
  assert.equal(next.authorized, false);
  assert.equal(state.tradeApprovals.find(row => row.id === "old").status, "expired");
});

test("an approved trade can be canceled while queued but not after submission starts", () => {
  const queued = {};
  requestTradeApproval(queued, entry(), { now: 100, idFactory: () => "cancel-me" });
  approveTradeApproval(queued, "cancel-me", 200);
  const canceled = cancelTradeApproval(queued, "cancel-me", 300);
  assert.equal(canceled.ok, true);
  assert.equal(canceled.approval.status, "rejected");
  assert.equal(canceled.approval.resolutionReason, "operator canceled queued approval");
  assert.equal(beginApprovedTrade(queued, entry(), 400).ok, false);

  const submitting = {};
  requestTradeApproval(submitting, entry(), { now: 100, idFactory: () => "too-late" });
  approveTradeApproval(submitting, "too-late", 200);
  beginApprovedTrade(submitting, entry(), 300);
  assert.equal(cancelTradeApproval(submitting, "too-late", 301).ok, false);
});

test("loss approval authorizes the approved price or better, never a worse loss", () => {
  const state = {};
  const loss = entry({ kind: LOSS_EXIT_APPROVAL, limitPrice: 2.00 });
  requestTradeApproval(state, loss, { now: 100, idFactory: () => "loss-1" });
  approveTradeApproval(state, "loss-1", 200);
  assert.equal(beginApprovedTrade(state, { ...loss, limitPrice: 2.05 }, 300).ok, true);

  const state2 = {};
  requestTradeApproval(state2, loss, { now: 100, idFactory: () => "loss-2" });
  approveTradeApproval(state2, "loss-2", 200);
  assert.equal(beginApprovedTrade(state2, { ...loss, limitPrice: 1.99 }, 300).ok, false);
});

test("pending approvals can be rejected and expire", () => {
  const state = {};
  requestTradeApproval(state, entry(), { now: 100, ttlMs: 1_000, idFactory: () => "reject-me" });
  assert.equal(rejectTradeApproval(state, "reject-me", 200).ok, true);
  assert.equal(requestTradeApproval(state, entry(), { now: 300 }).rejected, true);
  assert.equal(pendingTradeApprovals(state, 300).length, 0);

  requestTradeApproval(state, entry(), { now: 400, ttlMs: 1_000, idFactory: () => "expire-me" });
  assert.equal(pendingTradeApprovals(state, 1_401).length, 0);
});
