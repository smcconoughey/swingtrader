import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBrokerOrderOwner,
  classifyWorkingOptionOrders,
  mayMutateBrokerOrder,
} from "../order-authority.js";

test("unmatched broker order is operator-owned and immutable", () => {
  const order = { id: "manual-1", chain_symbol: "RTX", state: "confirmed" };
  assert.equal(classifyBrokerOrderOwner(order, {}), "operator");
  const [classification] = classifyWorkingOptionOrders([order], {}, () => false);
  assert.equal(classification.owner, "operator");
  assert.equal(mayMutateBrokerOrder(classification), false);
});

test("persisted bot id or ref is automation-owned", () => {
  const meta = { "O:RTX": { exitOrderId: "bot-1", entryOrderRefId: "entry-ref" } };
  assert.equal(classifyBrokerOrderOwner({ id: "bot-1" }, meta), "automation");
  assert.equal(classifyBrokerOrderOwner({ ref_id: "entry-ref" }, meta), "automation");
  assert.equal(mayMutateBrokerOrder({ owner: "automation" }), true);
});

test("ownership is independent for two contracts on the same ticker", () => {
  const meta = { "O:RTX:2026-08-21": { exitOrderId: "bot-aug" } };
  const rows = classifyWorkingOptionOrders([
    { id: "bot-aug", chain_symbol: "RTX", option_id: "aug-id" },
    { id: "manual-sep", chain_symbol: "RTX", option_id: "sep-id" },
  ], meta, () => false);
  assert.deepEqual(rows.map(row => [row.contractKey, row.owner]), [
    ["id:aug-id", "automation"],
    ["id:sep-id", "operator"],
  ]);
});

test("instrument URL and bare UUID resolve to the same exact contract", () => {
  const rows = classifyWorkingOptionOrders([
    { id: "manual", instrument_id: "https://api.robinhood.com/options/instruments/abc-123/", state: "confirmed" },
  ], {}, order => order.state === "filled");

  assert.equal(rows[0].contractKey, "id:abc-123");
});
