import test from "node:test";
import assert from "node:assert/strict";

import {
  accountSeries,
  commandCenterHTML,
  escapeDashboardHTML,
  preferredDashboardAccountId,
  rankCommandCenterIdeas,
} from "../dashboard-command-center.js";
import { traderDashboardPageHTML } from "../trader-dashboard-page.js";

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

test("account trend keeps real market days and removes weekends", () => {
  const friday = Date.parse("2026-07-31T16:00:00-04:00");
  const saturday = Date.parse("2026-08-01T12:00:00-04:00");
  const monday = Date.parse("2026-08-03T16:00:00-04:00");
  const series = accountSeries([
    { ts: friday, value: 475 },
    { ts: saturday, value: 480 },
    { ts: monday, value: 490 },
  ], Date.parse("2026-08-04T12:00:00-04:00"));

  assert.deepEqual(series.map(point => point.y), [475, 490]);
  assert.deepEqual(series.map(point => point.x), [0, 1]);
});

test("Robinhood is the dashboard default while a valid explicit account remains selectable", () => {
  assert.equal(preferredDashboardAccountId(["paper", "robinhood"]), "robinhood");
  assert.equal(preferredDashboardAccountId(["paper", "robinhood"], "paper"), "paper");
  assert.equal(preferredDashboardAccountId(["paper", "robinhood"], "missing"), "robinhood");
});

test("focused page contains only the working dashboard shell", () => {
  const html = traderDashboardPageHTML('<div id="trader-app">Focused</div>');
  assert.match(html, /id="trader-app"/);
  assert.match(html, /data-panel-target/);
  assert.doesNotMatch(html, /30-second read/i);
  assert.doesNotMatch(html, /deep-dive/);
  assert.doesNotMatch(html, /Trade History/);
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
      candles: {
        SPY: [{ c: 600 }, { c: 606 }],
        QQQ: [{ c: 500 }, { c: 490 }],
      },
      portfolioHistory: [
        { ts: Date.now() - 86_400_000, value: 470 },
        { ts: Date.now(), value: 480 },
      ],
    },
  };

  const html = commandCenterHTML({
    acct,
    pv: 480,
    pnlPct: -4,
    posSource: [],
    accountOptions: [{ id: "robinhood", name: "Robinhood Live", pv: 480 }],
  });

  assert.match(html, /id="panel-market"/);
  assert.match(html, /id="panel-account"/);
  assert.match(html, /id="panel-trades"/);
  assert.match(html, /id="panel-ideas"/);
  assert.match(html, /id="mobile-account-select"/);
  assert.match(html, /id="chat-window"/);
  assert.match(html, /Message Jarvis/);
  assert.match(html, /PROFIT-ONLY/);
  assert.match(html, /\/ticker\/RTX\?a=robinhood/);
  assert.match(html, /Watch &lt;RTX&gt; closely/);
  assert.doesNotMatch(html, /Watch <RTX>/);
  assert.doesNotMatch(html, /30-second read/i);
});
