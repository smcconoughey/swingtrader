import test from "node:test";
import assert from "node:assert/strict";

import {
  commandCenterHTML,
  escapeDashboardHTML,
  rankCommandCenterIdeas,
} from "../dashboard-command-center.js";

test("rankCommandCenterIdeas puts actionable and preflight-blocked setups ahead of background waits", () => {
  const decisions = [
    { ticker: "WAIT", action: "WAIT", finalScore: 92, reason: "developing" },
    { ticker: "CALL", action: "BUY CALL", finalScore: 71, entryPriority: 61, reason: "ready" },
    { ticker: "BLOCK", action: "BLOCKED", finalScore: 76, entryPriority: 88, reason: "spread widened" },
    { ticker: "SKIP", action: "SKIP", finalScore: 99, reason: "no data" },
  ];
  const ranked = rankCommandCenterIdeas(decisions, { CALL: { c: 100, dp: 2.5 } }, 10);

  assert.deepEqual(ranked.map(row => row.ticker), ["CALL", "BLOCK", "WAIT"]);
  assert.equal(ranked[0].price, 100);
  assert.equal(ranked[0].dayPct, 2.5);
});

test("escapeDashboardHTML prevents scanner and chat text from becoming markup", () => {
  assert.equal(escapeDashboardHTML('<img src=x onerror="bad">'), "&lt;img src=x onerror=&quot;bad&quot;&gt;");
});

test("commandCenterHTML renders the phone-first decision surface and preserves drill-down links", () => {
  const acct = {
    id: "robinhood",
    name: "Robinhood Live",
    config: { broker: "robinhood" },
    state: { cash: 125, operatorDirectives: {} },
    chatHistory: [{ role: "ai", content: "Watch <RTX> closely", ts: Date.now() }],
    dashboard: {
      marketOpen: true,
      quotes: { RTX: { c: 188.25, dp: 1.4 } },
      decisions: [{ ticker: "RTX", action: "BUY CALL", finalScore: 78, entryPriority: 83, reason: "trend and catalyst align", signals: ["volume expansion"] }],
    },
  };

  const html = commandCenterHTML({
    acct,
    pv: 480,
    pnlPct: -4,
    posSource: [],
    dailyTape: { score: 7, label: "clean", summary: "Breadth is improving." },
    latestNewsBrief: "Defense leads.",
    currentRegime: { mode: "risk-on", label: "Risk on" },
  });

  assert.match(html, /Your 30-second read/);
  assert.match(html, /Best opportunities now/);
  assert.match(html, /Other trades worth seeing/);
  assert.match(html, /Text Jarvis/);
  assert.match(html, /\/ticker\/RTX\?a=robinhood/);
  assert.match(html, /Watch &lt;RTX&gt; closely/);
  assert.doesNotMatch(html, /Watch <RTX>/);
});
