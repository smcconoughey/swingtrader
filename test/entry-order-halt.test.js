import test from "node:test";
import assert from "node:assert/strict";

import {
  ambiguousBuyReplayAllowed,
  entryBuyHaltReason,
  shouldCancelWorkingBuysOnHalt,
} from "../entry-order-halt.js";

test("observation lock blocks ambiguous buy replay and requires canceling working buys", () => {
  const acct = {
    paused: false,
    config: { broker: "robinhood", liveEntriesEnabled: false },
  };
  assert.equal(entryBuyHaltReason(acct), "observation lock");
  assert.equal(ambiguousBuyReplayAllowed(acct), false);
  assert.equal(shouldCancelWorkingBuysOnHalt(acct), true);
});

test("risk pause blocks buy replay even when live entries are armed", () => {
  const acct = {
    paused: true,
    pausedBy: "risk",
    config: { broker: "robinhood", liveEntriesEnabled: true },
  };
  assert.equal(entryBuyHaltReason(acct), "pause (risk)");
  assert.equal(ambiguousBuyReplayAllowed(acct), false);
  assert.equal(shouldCancelWorkingBuysOnHalt(acct), true);
});

test("armed live account with no pause may replay an ambiguous buy under the same ref", () => {
  const acct = {
    paused: false,
    config: { broker: "robinhood", liveEntriesEnabled: true },
  };
  assert.equal(entryBuyHaltReason(acct), null);
  assert.equal(ambiguousBuyReplayAllowed(acct), true);
  assert.equal(shouldCancelWorkingBuysOnHalt(acct), false);
});

test("paper accounts are outside the live entry-halt policy", () => {
  const acct = {
    paused: true,
    config: { broker: "paper", liveEntriesEnabled: false },
  };
  assert.equal(entryBuyHaltReason(acct), null);
  assert.equal(ambiguousBuyReplayAllowed(acct), true);
  assert.equal(shouldCancelWorkingBuysOnHalt(acct), false);
});
