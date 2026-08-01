import { activeDirectivesFor } from "./operator-directives.js";

export function escapeDashboardHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const finite = value => Number.isFinite(Number(value));
const money = value => finite(value) ? `$${Number(value).toFixed(0)}` : "—";
const shortText = (value, length = 170) => escapeDashboardHTML(String(value || "").replace(/\s+/g, " ").trim().slice(0, length));

export function rankCommandCenterIdeas(decisions = [], quotes = {}, limit = 8) {
  const actionRank = action => {
    if (action === "BUY CALL" || action === "BUY PUT") return 4;
    if (action === "BLOCKED") return 3;
    if (action === "WAIT") return 2;
    if (action === "HOLD") return 1;
    return 0;
  };
  return decisions
    .filter(d => d?.ticker && finite(d.finalScore) && actionRank(d.action) > 0)
    .map(d => {
      const score = Number(d.finalScore);
      const quote = quotes[d.ticker] || {};
      const conviction = Math.abs(score - 50) * 2;
      return {
        ...d,
        score,
        conviction,
        priority: finite(d.entryPriority) ? Number(d.entryPriority) : conviction,
        dayPct: finite(quote.dp) ? Number(quote.dp) : null,
        price: finite(quote.c) ? Number(quote.c) : (finite(d.price) ? Number(d.price) : null),
        actionRank: actionRank(d.action),
      };
    })
    .sort((a, b) => b.actionRank - a.actionRank || b.priority - a.priority || b.conviction - a.conviction)
    .slice(0, Math.max(0, limit));
}

function weekdayInNewYork(ts) {
  try {
    return !["Sat", "Sun"].includes(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(new Date(ts)));
  } catch {
    const day = new Date(ts).getUTCDay();
    return day !== 0 && day !== 6;
  }
}

function downsample(points, max = 180) {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * stride)]);
}

function normalizedMarketSeries(candles, limit = 45) {
  const points = (Array.isArray(candles) ? candles : [])
    .filter(candle => finite(candle?.c))
    .slice(-limit);
  if (points.length < 2) return [];
  const base = Number(points[0].c);
  if (!(base > 0)) return [];
  return points.map((point, index) => ({ x: index, y: (Number(point.c) / base - 1) * 100 }));
}

export function accountSeries(history, now = Date.now()) {
  const cutoff = now - 31 * 86_400_000;
  const points = (Array.isArray(history) ? history : [])
    .filter(point => finite(point?.ts) && finite(point?.value) && point.ts >= cutoff && weekdayInNewYork(point.ts))
    .map((point, index) => ({ x: index, y: Number(point.value), ts: Number(point.ts) }));
  return downsample(points);
}

export function preferredDashboardAccountId(accountIds = [], requestedId = null) {
  const ids = Array.from(accountIds || []);
  if (requestedId && ids.includes(requestedId)) return requestedId;
  if (ids.includes("robinhood")) return "robinhood";
  return ids[0] || null;
}

function lineChartSVG(series, { valueFormatter = value => value.toFixed(1), baseline = null } = {}) {
  const usable = series.filter(item => Array.isArray(item.points) && item.points.length >= 2);
  if (!usable.length) return `<div class="chart-empty">Waiting for market data</div>`;
  const width = 720, height = 220, left = 42, right = 14, top = 14, bottom = 28;
  const allValues = usable.flatMap(item => item.points.map(point => point.y));
  if (finite(baseline)) allValues.push(Number(baseline));
  let min = Math.min(...allValues), max = Math.max(...allValues);
  const pad = Math.max((max - min) * 0.12, Math.abs(max || min) * 0.015, 0.25);
  min -= pad; max += pad;
  const range = Math.max(0.0001, max - min);
  const maxLength = Math.max(...usable.map(item => item.points.length));
  const xOf = index => left + (index / Math.max(1, maxLength - 1)) * (width - left - right);
  const yOf = value => top + (max - value) / range * (height - top - bottom);
  const grid = [0, .5, 1].map(frac => {
    const value = max - frac * range;
    const y = yOf(value);
    return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" class="chart-grid"/><text x="${left - 7}" y="${(y + 3).toFixed(1)}" class="chart-axis" text-anchor="end">${escapeDashboardHTML(valueFormatter(value))}</text>`;
  }).join("");
  const baseLine = finite(baseline) && Number(baseline) >= min && Number(baseline) <= max
    ? `<line x1="${left}" y1="${yOf(Number(baseline)).toFixed(1)}" x2="${width - right}" y2="${yOf(Number(baseline)).toFixed(1)}" class="chart-baseline"/>`
    : "";
  const lines = usable.map(item => {
    const points = item.points.map((point, index) => `${xOf(index).toFixed(1)},${yOf(point.y).toFixed(1)}`).join(" ");
    const last = item.points[item.points.length - 1];
    return `<polyline points="${points}" class="chart-line" style="stroke:${item.color}"/><circle cx="${xOf(item.points.length - 1).toFixed(1)}" cy="${yOf(last.y).toFixed(1)}" r="3.5" style="fill:${item.color}"/>`;
  }).join("");
  return `<svg class="merged-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">${grid}${baseLine}${lines}</svg>`;
}

function positionCardHTML(position, state, acctId) {
  const pnlPct = Number(position.pnlPct || 0) * 100;
  const pnlDollar = Number(position.pnlDollar || 0);
  const directives = activeDirectivesFor(state, position.ticker).map(d =>
    d.kind === "no_realized_loss" ? "NO LOSS EXIT" : "ADVICE ONLY");
  if (position._operatorWorkingOrder) directives.unshift("MANUAL ORDER");
  const option = position.type === "equity" ? "SHARES" : `${String(position.type || "?").toUpperCase()} ${position.strike > 0 ? `$${position.strike}` : ""}`;
  const plan = position.tradePlan || position.ai?.tradePlan || {};
  const href = `/ticker/${encodeURIComponent(position.ticker)}?a=${encodeURIComponent(acctId)}`;
  return `<a class="compact-trade" href="${href}">
    <div class="compact-trade-head"><b>${escapeDashboardHTML(position.ticker)}</b><strong class="${pnlPct >= 0 ? "positive" : "negative"}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%</strong></div>
    <div class="compact-meta"><span>${escapeDashboardHTML(option)}</span><span>${Number(position.qty || 0)}x</span><span>${position.dteLeft == null ? "—" : `${Number(position.dteLeft).toFixed(0)}d`}</span><span>${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)}</span></div>
    <div class="compact-meta"><span>Stock ${position.spot == null ? "—" : `$${Number(position.spot).toFixed(2)}`}</span><span>Option ${position.curPremium == null ? "—" : `$${Number(position.curPremium).toFixed(2)}`}</span><span>Target ${position.profitTarget?.premium ? `$${position.profitTarget.premium}` : "—"}</span></div>
    ${directives.length ? `<div class="authority-line">${directives.map(escapeDashboardHTML).join(" · ")}</div>` : ""}
    ${plan.thesis ? `<p>${shortText(plan.thesis, 135)}</p>` : ""}
  </a>`;
}

function ideaCardHTML(idea, acctId) {
  const bullish = idea.action === "BUY CALL" || (idea.action !== "BUY PUT" && idea.score >= 50);
  const status = idea.action === "BUY CALL" || idea.action === "BUY PUT" ? "READY" : idea.action === "BLOCKED" ? "BLOCKED" : "WATCH";
  const move = idea.dayPct == null ? "—" : `${idea.dayPct >= 0 ? "+" : ""}${idea.dayPct.toFixed(1)}%`;
  const reason = Array.isArray(idea.signals) && idea.signals.length ? idea.signals.slice(0, 2).join(" · ") : idea.reason;
  const href = `/ticker/${encodeURIComponent(idea.ticker)}?a=${encodeURIComponent(acctId)}`;
  return `<a class="compact-idea" href="${href}">
    <div><b>${escapeDashboardHTML(idea.ticker)}</b><span>${idea.price == null ? "—" : `$${idea.price.toFixed(2)}`}</span><span class="${idea.dayPct >= 0 ? "positive" : "negative"}">${move}</span></div>
    <div><span>${bullish ? "CALL" : "PUT"}</span><span>Score ${idea.score}</span><span class="idea-state ${status.toLowerCase()}">${status}</span></div>
    <p>${shortText(reason, 145)}</p>
  </a>`;
}

function chatHistoryHTML(history) {
  if (!history.length) return `<div class="chat-empty">No messages yet.</div>`;
  return history.slice(-40).map(message => {
    const user = message.role === "user";
    const time = finite(message.ts) ? new Date(Number(message.ts)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return `<div class="chat-row ${user ? "from-user" : "from-jarvis"}"><div class="chat-label">${user ? "You" : "Jarvis"}${time ? ` · ${time}` : ""}</div><div class="chat-text">${escapeDashboardHTML(message.content).replace(/\n/g, "<br>")}</div></div>`;
  }).join("");
}

export function commandCenterHTML({ acct, pv, pnlPct, posSource, accountOptions = [], spectator = false }) {
  const dashboard = acct.dashboard || {};
  const decisions = Array.isArray(dashboard.decisions) ? dashboard.decisions : [];
  const ideas = rankCommandCenterIdeas(decisions, dashboard.quotes, 8);
  const spy = normalizedMarketSeries(dashboard.candles?.SPY);
  const qqq = normalizedMarketSeries(dashboard.candles?.QQQ);
  const spyPerf = spy.length ? spy[spy.length - 1].y : null;
  const qqqPerf = qqq.length ? qqq[qqq.length - 1].y : null;
  const portfolio = accountSeries(dashboard.portfolioHistory);
  const accountChart = lineChartSVG([{ points: portfolio, color: "#6a4df4" }], { valueFormatter: value => `$${Math.round(value)}`, baseline: acct.config?.startingCash });
  const marketChart = lineChartSVG([
    { points: spy, color: "#138f86" },
    { points: qqq, color: "#6a4df4" },
  ], { valueFormatter: value => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`, baseline: 0 });
  const options = accountOptions.map(option => `<option value="${encodeURIComponent(option.id)}" ${option.id === acct.id ? "selected" : ""}>${escapeDashboardHTML(option.name)} · ${money(option.pv)}</option>`).join("");
  const positions = posSource.length ? posSource.map(position => positionCardHTML(position, acct.state, acct.id)).join("") : `<div class="panel-empty">No open trades</div>`;
  const considered = ideas.length ? ideas.map(idea => ideaCardHTML(idea, acct.id)).join("") : `<div class="panel-empty">No considered trades yet</div>`;
  const automationLabel = acct.config?.broker === "robinhood" ? "PROFIT-ONLY" : "PAPER";

  return `<div class="trader-app" id="trader-app">
    <header class="trader-header">
      <select id="mobile-account-select" aria-label="Account">${options}</select>
      <div class="header-right"><span class="market-dot ${dashboard.marketOpen ? "is-open" : ""}">${dashboard.marketOpen ? "OPEN" : "CLOSED"}</span><span class="automation-mode">${automationLabel}</span><button type="button" class="desktop-chat-trigger" data-open-chat>Chat</button></div>
    </header>

    <div class="panel-grid">
      <section class="dashboard-panel active" id="panel-market" data-panel="market">
        <div class="panel-head"><h2>Market</h2><span>45 sessions</span></div>
        <div class="chart-legend"><span><i style="background:#138f86"></i>SPY <b class="${spyPerf >= 0 ? "positive" : "negative"}">${spyPerf == null ? "—" : `${spyPerf >= 0 ? "+" : ""}${spyPerf.toFixed(1)}%`}</b></span><span><i style="background:#6a4df4"></i>QQQ <b class="${qqqPerf >= 0 ? "positive" : "negative"}">${qqqPerf == null ? "—" : `${qqqPerf >= 0 ? "+" : ""}${qqqPerf.toFixed(1)}%`}</b></span></div>
        ${marketChart}
      </section>

      <section class="dashboard-panel" id="panel-account" data-panel="account">
        <div class="panel-head"><h2>Account</h2><span>1 month · market days</span></div>
        <div class="account-strip"><div><span>Equity</span><b>${money(pv)}</b></div><div><span>Cash</span><b>${money(acct.state.cash)}</b></div><div><span>Return</span><b class="${Number(pnlPct) >= 0 ? "positive" : "negative"}">${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct).toFixed(1)}%</b></div></div>
        ${accountChart}
      </section>

      <section class="dashboard-panel" id="panel-trades" data-panel="trades">
        <div class="panel-head"><h2>Open trades</h2><span>${posSource.length}</span></div>
        <div class="bounded-list">${positions}</div>
      </section>

      <section class="dashboard-panel" id="panel-ideas" data-panel="ideas">
        <div class="panel-head"><h2>Considered trades</h2><span>${decisions.length} scanned · ${ideas.length} shown</span></div>
        <div class="bounded-list">${considered}</div>
      </section>
    </div>

    <nav class="mobile-dock" aria-label="Dashboard sections">
      <button type="button" data-panel-target="market"><span>⌁</span>Market</button>
      <button type="button" data-panel-target="account"><span>◒</span>Account</button>
      <button type="button" data-panel-target="trades"><span>${posSource.length}</span>Trades</button>
      <button type="button" data-panel-target="ideas"><span>${ideas.length}</span>Ideas</button>
      <button type="button" data-open-chat><span>↑</span>Chat</button>
    </nav>

    <section class="chat-window" id="chat-window" aria-hidden="true">
      <div class="chat-window-head"><b>Jarvis</b><button type="button" data-close-chat aria-label="Close chat">Done</button></div>
      <div class="chat-history" id="chat-history">${chatHistoryHTML(acct.chatHistory || [])}</div>
      ${spectator ? `<div class="chat-readonly">Read-only</div>` : `<form class="chat-compose" method="POST" action="/hint?a=${encodeURIComponent(acct.id)}"><textarea id="jarvis-input" name="hint" rows="1" placeholder="Message Jarvis" autocomplete="off"></textarea><button type="submit" aria-label="Send">↑</button></form>`}
    </section>
  </div>`;
}
