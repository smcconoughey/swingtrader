import test from "node:test";
import assert from "node:assert/strict";
import {
  activeDirectivesFor,
  applyOperatorDirectives,
  automatedExitBlock,
  parseOperatorDirectives,
} from "../operator-directives.js";

test("don't sell for a loss creates a durable ticker directive", () => {
  const parsed = parseOperatorDirectives("Don't sell RTX for a loss", { openTickers: ["RTX", "KO"] });
  assert.deepEqual(parsed.map(({ kind, scope, enabled }) => ({ kind, scope, enabled })), [
    { kind: "no_realized_loss", scope: "RTX", enabled: true },
  ]);
  const state = {};
  applyOperatorDirectives(state, parsed, 123);
  assert.equal(activeDirectivesFor(state, "RTX")[0].expiresAt, null);
  assert.equal(automatedExitBlock({ state, ticker: "RTX", entryPremium: 4.2, proposedExitPrice: 2.72 }).reasonCode, "HOLD_USER_NO_LOSS");
  assert.equal(automatedExitBlock({ state, ticker: "RTX", entryPremium: 4.2, proposedExitPrice: 4.2 }), null);
});

test("global no-loss directive applies to every position and can be cleared", () => {
  const state = {};
  applyOperatorDirectives(state, parseOperatorDirectives("Never sell for a loss"), 100);
  assert.equal(automatedExitBlock({ state, ticker: "KO", entryPremium: 2, proposedExitPrice: 1 }).reasonCode, "HOLD_USER_NO_LOSS");
  applyOperatorDirectives(state, parseOperatorDirectives("Allow selling for a loss"), 200);
  assert.equal(automatedExitBlock({ state, ticker: "KO", entryPremium: 2, proposedExitPrice: 1 }), null);
});

test("manual-only directive blocks every automated exit", () => {
  const state = {};
  applyOperatorDirectives(state, parseOperatorDirectives("I will manage RTX manually", { openTickers: ["RTX"] }));
  assert.equal(automatedExitBlock({ state, ticker: "RTX", entryPremium: 4.2, proposedExitPrice: 8 }).reasonCode, "HOLD_USER_MANUAL_ONLY");
});
