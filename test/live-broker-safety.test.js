import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalLiveBrokerForAccount,
  classifyLongOptionHolding,
  isCanonicalLiveAccount,
  robinhoodAccountAllowlistFromEnv,
  sanitizeRuntimeBrokerConfig,
  selectRobinhoodTradingAccount,
} from "../live-broker-safety.js";

test("only canonical runtime ids retain process-global live broker bindings", () => {
  assert.equal(canonicalLiveBrokerForAccount("robinhood"), "robinhood");
  assert.equal(canonicalLiveBrokerForAccount("tradier"), "tradier");
  assert.equal(isCanonicalLiveAccount("strategy-2"), false);

  const duplicate = sanitizeRuntimeBrokerConfig("strategy-2", {
    broker: "robinhood",
    autoExecute: true,
    tradeWhenClosed: true,
    liveEntriesEnabled: true,
  });
  assert.deepEqual(duplicate.config, {
    broker: "paper",
    autoExecute: false,
    tradeWhenClosed: false,
    liveEntriesEnabled: false,
  });
  assert.ok(duplicate.changes.some(change => change.key === "broker"));

  const robinhood = sanitizeRuntimeBrokerConfig("robinhood", { broker: "paper", autoExecute: true });
  assert.equal(robinhood.config.broker, "robinhood");
  assert.equal(robinhood.config.autoExecute, true);

  const uppercaseDuplicate = sanitizeRuntimeBrokerConfig("TRADIER", { broker: "tradier", autoExecute: true });
  assert.equal(uppercaseDuplicate.config.broker, "paper");
  assert.equal(uppercaseDuplicate.config.autoExecute, false);
});

test("Robinhood discovery requires one explicit agentic account when no allowlist exists", () => {
  const one = selectRobinhoodTradingAccount([
    { account_number: "PERSONAL", nickname: "Agentic" },
    { account_number: "AGENTIC", agentic_allowed: true },
  ]);
  assert.equal(one.accountNumber, "AGENTIC");
  assert.equal(one.mode, "agentic");

  const none = selectRobinhoodTradingAccount([{ account_number: "PERSONAL" }]);
  assert.equal(none.accountNumber, null);
  assert.match(none.reason, /found 0 explicitly agentic/i);

  const ambiguous = selectRobinhoodTradingAccount([
    { account_number: "A", agentic_allowed: true },
    { account_number: "B", is_agentic: "true" },
  ]);
  assert.equal(ambiguous.accountNumber, null);
  assert.match(ambiguous.reason, /found 2 explicitly agentic/i);
});

test("a configured Robinhood allowlist selects exactly one matching account", () => {
  assert.deepEqual(
    robinhoodAccountAllowlistFromEnv({ ROBINHOOD_ACCOUNT_ALLOWLIST: " B, A, B " }),
    ["B", "A"],
  );
  assert.deepEqual(
    robinhoodAccountAllowlistFromEnv({ ROBINHOOD_ACCOUNT_NUMBER: "A" }),
    ["A"],
  );

  const selected = selectRobinhoodTradingAccount([
    { account_number: "A" },
    { account_number: "B" },
  ], { allowlist: ["B"] });
  assert.equal(selected.accountNumber, "B");
  assert.equal(selected.mode, "allowlist");

  const ambiguous = selectRobinhoodTradingAccount([
    { account_number: "A" },
    { account_number: "B" },
  ], { allowlist: ["A", "B"] });
  assert.equal(ambiguous.accountNumber, null);

  const missing = selectRobinhoodTradingAccount([{ account_number: "A" }], { allowlist: ["B"] });
  assert.equal(missing.accountNumber, null);
});

test("non-long option holdings are quarantined before long lifecycle management", () => {
  assert.deepEqual(classifyLongOptionHolding({ quantity: 2, positionSide: "long" }), {
    manageable: true,
    quarantine: false,
    quantity: 2,
    reason: null,
  });

  const negative = classifyLongOptionHolding({ quantity: -1 });
  assert.equal(negative.manageable, false);
  assert.equal(negative.quarantine, true);
  assert.equal(negative.quantity, 1);
  assert.match(negative.reason, /negative/i);

  const explicitShort = classifyLongOptionHolding({ quantity: 1, positionSide: "short" });
  assert.equal(explicitShort.manageable, false);
  assert.equal(explicitShort.quarantine, true);
  assert.match(explicitShort.reason, /explicit short/i);

  const shortCall = classifyLongOptionHolding({ quantity: 1, positionSide: "short_call" });
  assert.equal(shortCall.manageable, false);
  assert.equal(shortCall.quarantine, true);

  const flat = classifyLongOptionHolding({ quantity: 0, positionSide: "short" });
  assert.equal(flat.manageable, false);
  assert.equal(flat.quarantine, false);
});
