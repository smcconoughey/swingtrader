import test from "node:test";
import assert from "node:assert/strict";

import { deriveAdaptiveExitProfile } from "../adaptive-exit.js";

const trade = (bestExitPnlPct, type = "call", extra = {}) => ({
  type,
  strike: 100,
  optionsSource: "robinhood",
  bestExitPnlPct,
  pnlDollar: bestExitPnlPct >= 0.1 ? 10 : -10,
  ...extra,
});

test("adaptive exit uses the visible 12% fallback until five executable samples exist", () => {
  const profile = deriveAdaptiveExitProfile([trade(0.18), trade(0.09)], {}, "call");
  assert.equal(profile.targetPct, 0.12);
  assert.equal(profile.basis, "fallback");
  assert.equal(profile.sampleSize, 2);
  assert.equal(profile.minSamples, 5);
  assert.equal(profile.profitLockArmPct, 0.08);
});

test("adaptive exit selects the highest 10-15% boundary reached by at least 65%", () => {
  const peaks = [0.18, 0.17, 0.16, 0.15, 0.14, 0.13, 0.12, 0.11, 0.04, 0];
  const profile = deriveAdaptiveExitProfile(peaks.map(value => trade(value)), {}, "call");
  assert.equal(profile.targetPct, 0.12);
  assert.equal(profile.reachRate, 0.7);
  assert.equal(profile.basis, "recent reach rate");
});

test("adaptive exit prefers direction-specific evidence once that sample is large enough", () => {
  const calls = [0.15, 0.15, 0.15, 0.15, 0.15].map(value => trade(value, "call"));
  const puts = [0.10, 0.10, 0.10, 0.10, 0.10].map(value => trade(value, "put"));
  const profile = deriveAdaptiveExitProfile([...calls, ...puts], {}, "call");
  assert.equal(profile.source, "call");
  assert.equal(profile.sampleSize, 5);
  assert.equal(profile.targetPct, 0.15);
});

test("adaptive exit refuses synthetic, pending, estimated, and mark-only observations", () => {
  const profile = deriveAdaptiveExitProfile([
    trade(0.15),
    trade(0.30, "call", { optionsSource: "synthetic" }),
    trade(0.30, "call", { _pendingFill: true }),
    trade(0.30, "call", { _estimated: true }),
    { type: "call", optionsSource: "robinhood", bestPnlPct: 0.50 },
  ], {}, "call");
  assert.equal(profile.sampleSize, 1);
  assert.equal(profile.targetPct, 0.12);
});
