import test from "node:test";
import assert from "node:assert/strict";

import { createManagementPlan, evaluatePosition } from "../position-manager.js";

const NOW = Date.parse("2026-07-17T15:00:00-04:00");
const DAY = 86_400_000;

function evaluateLive(position, { bid, ask, mark = (bid + ask) / 2, trail = [], plan = null }) {
  const complete = {
    type: "call",
    qty: 1,
    originalQty: 1,
    trimLevel: 0,
    entrySpot: 100,
    entryAtrPct: 2,
    dte: 28,
    dteRemaining: 20,
    openTime: NOW - 3 * DAY,
    ...position,
    markTrail: trail,
  };
  const frozen = plan || createManagementPlan({
    profitTarget: 0.20,
    trim1Pct: 0.10,
    trim2Pct: 0.18,
    stopLoss: -0.35,
  }, complete, NOW - 3 * DAY);
  return evaluatePosition({
    position: complete,
    plan: frozen,
    market: {
      spot: complete.entrySpot,
      bid,
      ask,
      mark,
      dteRemaining: complete.dteRemaining,
      requireExecutableBid: true,
      requireVerifiedContract: true,
      contractIdentityVerified: true,
      requireFreshQuote: true,
      quoteAsOf: NOW,
      maxQuoteAgeMs: 45_000,
      underlyingQuoteFresh: false,
      etHour: 11,
    },
    now: NOW,
  });
}

test("FIG and HPE replay: repeated executable losses stop near the hard limit", () => {
  const fig = evaluateLive(
    { ticker: "FIG", entryPremium: 2.96 },
    {
      bid: 2.01,
      ask: 2.18,
      trail: [
        { ts: NOW - 120_000, bid: 2.16, bookCoherent: true },
        { ts: NOW - 60_000, bid: 2.10, bookCoherent: true },
        { ts: NOW, bid: 2.01, bookCoherent: true },
      ],
    },
  );
  const hpe = evaluateLive(
    { ticker: "HPE", entryPremium: 4.70 },
    {
      bid: 2.37,
      ask: 2.65,
      trail: [
        { ts: NOW - 120_000, bid: 2.55, bookCoherent: true },
        { ts: NOW - 60_000, bid: 2.45, bookCoherent: true },
        { ts: NOW, bid: 2.37, bookCoherent: true },
      ],
    },
  );

  assert.equal(fig.reasonCode, "PREMIUM_STOP");
  assert.equal(hpe.reasonCode, "PREMIUM_STOP");
  assert.equal(fig.plan.stopLoss, -0.25);
  assert.equal(hpe.plan.stopLoss, -0.25);
});

test("KO replay: an unlocked one-lot banks the executable +10% touch", () => {
  const ko = evaluateLive(
    { ticker: "KO", entryPremium: 2.24, entrySpot: 84.64 },
    { bid: 2.47, ask: 2.52 },
  );
  assert.equal(ko.reasonCode, "SINGLE_CONTRACT_BANK");
  assert.equal(ko.action, "close");
});

test("PATH replay: a phantom wide bid is quarantined but a coherent +16% bid banks", () => {
  const position = { ticker: "PATH", entryPremium: 0.85, entrySpot: 11.95 };
  const phantom = evaluateLive(position, {
    bid: 0.25,
    ask: 1.45,
    mark: 0.85,
    trail: [{ ts: NOW, bid: 0.25, mark: 0.85 }],
  });
  const realProfit = evaluateLive(position, {
    bid: 0.99,
    ask: 1.02,
    mark: 1.005,
  });

  assert.equal(phantom.reasonCode, "PREMIUM_STOP_CONFIRMING");
  assert.equal(realProfit.reasonCode, "SINGLE_CONTRACT_BANK");
});
