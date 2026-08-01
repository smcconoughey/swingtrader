import test from "node:test";
import assert from "node:assert/strict";

import { validateEntryDecision } from "../llm-validation.js";

test("strict entry schema normalizes a valid one-based contract selection", () => {
  assert.deepEqual(validateEntryDecision({
    approve: true,
    confidence: 75,
    concerns: ["earnings soon"],
    reasoning: " setup is valid ",
    suggestion: " wait for volume ",
    contractIdx: 2,
  }, { candidateCount: 3 }), {
    approve: true,
    confidence: 75,
    concerns: ["earnings soon"],
    reasoning: "setup is valid",
    suggestion: "wait for volume",
    contractIdx: 1,
  });
});

test("string false and unbounded confidence fail closed", () => {
  assert.throws(() => validateEntryDecision({
    approve: "false",
    confidence: 50,
    concerns: [],
    reasoning: "no",
    suggestion: "pass",
  }), /approve must be boolean/);
  assert.throws(() => validateEntryDecision({
    approve: true,
    confidence: 500,
    concerns: [],
    reasoning: "yes",
    suggestion: "buy",
  }), /confidence/);
});

test("invalid or missing contract indices do not silently select contract zero", () => {
  const base = {
    approve: true,
    confidence: 75,
    concerns: [],
    reasoning: "yes",
    suggestion: "buy",
  };
  assert.throws(() => validateEntryDecision(base, { candidateCount: 3 }), /contractIdx/);
  assert.throws(() => validateEntryDecision({ ...base, contractIdx: 9 }, { candidateCount: 3 }), /contractIdx/);
});

test("structured trade plan preserves thesis and structural invalidation", () => {
  const result = validateEntryDecision({
    approve: true,
    confidence: 82,
    concerns: [],
    reasoning: "Evidence supports the entry.",
    suggestion: "Enter on confirmation.",
    tradePlan: {
      thesis: "Relative strength continues.",
      entryTrigger: "Break above the morning high on volume.",
      invalidation: "Daily close below the reclaimed 21 EMA.",
      firstTarget: "$220 resistance.",
      stretchTarget: "$228.",
      timeHorizon: "One to three weeks.",
      uncertainty: "Macro reversal.",
    },
  });

  assert.equal(result.tradePlan.invalidation, "Daily close below the reclaimed 21 EMA.");
  assert.equal(result.tradePlan.timeHorizon, "One to three weeks.");
});
