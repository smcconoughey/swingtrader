import test from "node:test";
import assert from "node:assert/strict";

import {
  applyUnderlyingSnapshots,
  directionAdjustedReturnPct,
  selectionFingerprint,
  shouldRecordSelectionCohort,
  summarizeRankOne,
} from "../decision-telemetry.js";

test("direction-adjusted returns treat puts symmetrically", () => {
  assert.equal(directionAdjustedReturnPct("BUY CALL", 100, 110), 10.000000000000009);
  assert.equal(directionAdjustedReturnPct("BUY PUT", 100, 90), 9.999999999999998);
  assert.equal(directionAdjustedReturnPct("BUY PUT", 100, 110), -10.000000000000009);
});

test("selection fingerprint is rank ordered and contract specific", () => {
  const row = { ranked: [
    { ticker: "B", action: "BUY PUT", rank: 2, eligibility: "executable", contract: { occSymbol: "B2" } },
    { ticker: "A", action: "BUY CALL", rank: 1, eligibility: "executable", contract: { occSymbol: "A1" } },
  ] };
  assert.equal(selectionFingerprint(row), "A:BUY CALL:A1|B:BUY PUT:B2");
});

test("identical opportunities are deduplicated until the repeat interval", () => {
  const ranked = [
    { ticker: "A", action: "BUY CALL", rank: 1, eligibility: "executable" },
    { ticker: "B", action: "BUY CALL", rank: 2, eligibility: "executable" },
  ];
  const first = { at: 1_000, ranked };
  assert.equal(shouldRecordSelectionCohort([], first), true);
  assert.equal(shouldRecordSelectionCohort([first], { at: 1_000 + 10 * 60_000, ranked }), false);
  assert.equal(shouldRecordSelectionCohort([first], { at: 1_000 + 31 * 60_000, ranked }), true);
});

test("forward snapshots preserve missing data and resolve fixed horizons", () => {
  const at = 1_000;
  const journal = [{ at, ranked: [
    { ticker: "CALL", action: "BUY CALL", rank: 1, eligibility: "executable", entrySpot: 100 },
    { ticker: "PUT", action: "BUY PUT", rank: 2, eligibility: "executable", entrySpot: 50 },
    { ticker: "MISS", action: "BUY CALL", rank: 3, eligibility: "executable", entrySpot: 20 },
  ] }];
  const out = applyUnderlyingSnapshots(journal, { CALL: { c: 105 }, PUT: { c: 45 } }, at + 61 * 60_000);
  assert.equal(out[0].ranked[0].forward.h1.pct, 5);
  assert.equal(out[0].ranked[1].forward.h1.pct, 10);
  assert.equal(out[0].ranked[2].forward, undefined);
});

test("rank-one summary reports hit rate, lift, and regret", () => {
  const journal = [
    { ranked: [
      { rank: 1, eligibility: "executable", forward: { h1: { pct: 5 } } },
      { rank: 2, eligibility: "executable", forward: { h1: { pct: 2 } } },
    ] },
    { ranked: [
      { rank: 1, eligibility: "executable", forward: { h1: { pct: -1 } } },
      { rank: 2, eligibility: "executable", forward: { h1: { pct: 3 } } },
    ] },
  ];
  assert.deepEqual(summarizeRankOne(journal), { n: 2, hitRate: 0.5, meanLift: -0.5, meanRegret: 2 });
});
