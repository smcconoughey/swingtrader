import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAutomationAuthority,
  automationEntryBlock,
  isProfitTakingExit,
  PROFIT_ONLY_MODE,
} from "../automation-authority.js";

const position = { ticker: "RTX", entryPremium: 4.20 };

test("profit-only mode keeps every new entry analysis-only", () => {
  assert.match(automationEntryBlock({ automationMode: PROFIT_ONLY_MODE }), /analysis-only/i);
  assert.equal(automationEntryBlock({ automationMode: "full" }), null);
});

test("profit-only mode allows an executable gain", () => {
  const decision = {
    action: "close",
    reasonCode: "PROFIT_TARGET",
    executionPrice: 4.80,
    metrics: { exitPnlPct: 0.1428 },
  };
  assert.equal(isProfitTakingExit(position, decision), true);
  assert.equal(applyAutomationAuthority({ automationMode: PROFIT_ONLY_MODE }, position, decision), decision);
});

test("profit-only mode converts every loss exit into advisory hold", () => {
  const decision = {
    action: "close",
    reasonCode: "DTE_CRITICAL",
    reason: "expiry pressure",
    executionPrice: 2.80,
    qty: 1,
    urgency: "urgent",
    priceMode: "marketable",
    metrics: { exitPnlPct: -0.333 },
  };
  const out = applyAutomationAuthority({ automationMode: PROFIT_ONLY_MODE }, position, decision);
  assert.equal(out.action, "hold");
  assert.equal(out.reasonCode, "HOLD_PROFIT_ONLY_MODE");
  assert.equal(out.qty, 0);
  assert.match(out.reason, /no broker order sent/i);
});

test("profit-only mode does not treat breakeven as profit", () => {
  const decision = {
    action: "trim",
    executionPrice: 4.20,
    metrics: { exitPnlPct: 0 },
  };
  assert.equal(isProfitTakingExit(position, decision), false);
});

test("paper and other automation modes keep the lifecycle decision unchanged", () => {
  const decision = { action: "close", executionPrice: 2, metrics: { exitPnlPct: -0.5 } };
  assert.equal(applyAutomationAuthority({ automationMode: "full" }, position, decision), decision);
});
