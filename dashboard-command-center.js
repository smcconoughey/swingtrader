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
const compactReason = value => escapeDashboardHTML(String(value || "No rationale captured").slice(0, 220));
const money = value => finite(value) ? `$${Number(value).toFixed(0)}` : "—";

export function rankCommandCenterIdeas(decisions = [], quotes = {}, limit = 10) {
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
      const priority = finite(d.entryPriority) ? Number(d.entryPriority) : conviction;
      return {
        ...d,
        score,
        conviction,
        priority,
        dayPct: finite(quote.dp) ? Number(quote.dp) : null,
        price: finite(quote.c) ? Number(quote.c) : (finite(d.price) ? Number(d.price) : null),
        actionRank: actionRank(d.action),
      };
    })
    .sort((a, b) => b.actionRank - a.actionRank || b.priority - a.priority || b.conviction - a.conviction)
    .slice(0, Math.max(0, limit));
}

function ideaCardHTML(idea, acctId, featured = false) {
  const bullish = idea.action === "BUY CALL" || (idea.action !== "BUY PUT" && idea.score >= 50);
  const direction = bullish ? "CALL BIAS" : "PUT BIAS";
  const status = idea.action === "BUY CALL" || idea.action === "BUY PUT"
    ? "REVIEW NOW"
    : idea.action === "BLOCKED"
      ? "SETUP, NOT EXECUTABLE"
      : idea.action === "HOLD" ? "HELD" : "DEVELOPING";
  const move = idea.dayPct == null ? "day —" : `${idea.dayPct >= 0 ? "+" : ""}${idea.dayPct.toFixed(1)}% today`;
  const signals = Array.isArray(idea.signals) && idea.signals.length
    ? idea.signals.slice(0, 2).map(s => escapeDashboardHTML(s)).join(" · ")
    : compactReason(idea.reason);
  const href = `/ticker/${encodeURIComponent(idea.ticker)}?a=${encodeURIComponent(acctId)}`;

  return `<a class="trade-idea ${featured ? "featured" : ""}" href="${href}">
    <div class="trade-idea-top">
      <span class="trade-symbol">${escapeDashboardHTML(idea.ticker)}</span>
      <span class="trade-status ${idea.action === "BLOCKED" ? "warn" : bullish ? "bull" : "bear"}">${status}</span>
    </div>
    <div class="trade-idea-quote"><b>${idea.price == null ? "—" : `$${idea.price.toFixed(2)}`}</b><span>${move}</span><span>${direction}</span><span>score ${idea.score}</span></div>
    <div class="trade-idea-reason">${signals}</div>
    <div class="trade-idea-more">Open thesis, chart, contract and wider analysis <span>›</span></div>
  </a>`;
}

function positionCardHTML(position, state, acctId) {
  const pnlPct = Number(position.pnlPct || 0) * 100;
  const pnlDollar = Number(position.pnlDollar || 0);
  const plan = position.tradePlan || position.ai?.tradePlan || {};
  const directives = activeDirectivesFor(state, position.ticker).map(d =>
    d.kind === "no_realized_loss" ? "NO LOSS EXIT" : "ADVICE ONLY");
  if (position._operatorWorkingOrder) directives.unshift("MANUAL ORDER OWNS EXIT");
  const authority = directives.length
    ? `<div class="position-authority">${directives.map(escapeDashboardHTML).join(" · ")}</div>` : "";
  const option = position.type === "equity"
    ? "SHARES"
    : `${String(position.type || "?").toUpperCase()} ${position.strike > 0 ? `$${position.strike}` : ""}`;
  const detail = plan.thesis || position.claudeReasoning || position.claudeSuggestion || "Open the position view for its live thesis and exit context.";
  const href = `/ticker/${encodeURIComponent(position.ticker)}?a=${encodeURIComponent(acctId)}`;

  return `<a class="position-brief" href="${href}">
    <div class="position-brief-top"><span><b>${escapeDashboardHTML(position.ticker)}</b> · ${escapeDashboardHTML(option)} · ${Number(position.qty || 0)}x</span><strong class="${pnlPct >= 0 ? "positive" : "negative"}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%</strong></div>
    <div class="position-brief-numbers"><span>Stock ${position.spot == null ? "—" : `$${Number(position.spot).toFixed(2)}`}</span><span>Contract ${position.curPremium == null ? "—" : `$${Number(position.curPremium).toFixed(2)}`}</span><span>${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)}</span><span>${position.dteLeft == null ? "—" : `${Number(position.dteLeft).toFixed(0)}d`} left</span></div>
    ${authority}
    <div class="position-thesis">${compactReason(detail)}</div>
    <div class="trade-idea-more">Position thesis, chart and exit plan <span>›</span></div>
  </a>`;
}

function chatHistoryHTML(history = []) {
  if (!history.length) {
    return `<div class="chat-empty">Text Jarvis like you would text a trading partner. Ask for the best trade, challenge a thesis, or give a durable instruction.</div>`;
  }
  return history.slice(-12).map(message => {
    const user = message.role === "user";
    const ageMs = Math.max(0, Date.now() - Number(message.ts || Date.now()));
    const age = ageMs < 3_600_000 ? `${Math.max(1, Math.round(ageMs / 60_000))}m` : `${Math.round(ageMs / 3_600_000)}h`;
    const content = escapeDashboardHTML(message.content).replace(/\n/g, "<br>");
    return `<div class="chat-message ${user ? "from-user" : "from-jarvis"}">
      <div class="chat-speaker">${user ? "YOU" : "JARVIS"} · ${age}</div>
      <div class="chat-bubble">${content}</div>
    </div>`;
  }).join("");
}

export function commandCenterHTML({
  acct,
  pv,
  pnlPct,
  posSource,
  dailyTape,
  latestNewsBrief,
  currentRegime,
  spectator = false,
}) {
  const state = acct.state;
  const allDecisions = Array.isArray(acct.dashboard?.decisions) ? acct.dashboard.decisions : [];
  const ideas = rankCommandCenterIdeas(allDecisions, acct.dashboard?.quotes, 10);
  const featured = ideas.slice(0, 3);
  const wider = ideas.slice(3);
  const reviewNow = allDecisions.filter(i => i.action === "BUY CALL" || i.action === "BUY PUT").length;
  const regimeLabel = String(currentRegime?.label || currentRegime?.mode || "unknown").toUpperCase();
  const marketClass = currentRegime?.mode === "risk-on" ? "positive" : currentRegime?.mode === "risk-off" ? "negative" : "caution";
  const tapeLine = dailyTape
    ? `${dailyTape.score}/10 ${dailyTape.label || "tape"} · ${dailyTape.summary || ""}`
    : "Tape score is still loading; no hidden tape veto is being applied.";
  const marketBrief = latestNewsBrief || "The hourly market brief has not populated yet.";
  const activeAccount = escapeDashboardHTML(acct.name || "Swing Trader");
  const topTicker = featured[0]?.ticker || "the strongest setup";
  const positionCards = posSource.length
    ? posSource.map(p => positionCardHTML(p, state, acct.id)).join("")
    : `<div class="rail-empty">No open positions. Cash is available for a setup that survives contract and execution review.</div>`;
  const ideaCards = featured.length
    ? featured.map((idea, index) => ideaCardHTML(idea, acct.id, index === 0)).join("")
    : `<div class="rail-empty">No ranked setups have populated yet. Ask Jarvis to analyze a ticker directly while the scanner catches up.</div>`;
  const widerCards = wider.length
    ? wider.map(idea => ideaCardHTML(idea, acct.id, false)).join("")
    : `<div class="rail-empty">No additional near-misses are populated yet.</div>`;

  return `<section class="jarvis-shell" id="jarvis">
    <main class="jarvis-chat-card">
      <div class="jarvis-chat-head">
        <div><div class="jarvis-kicker">PERSONAL TRADING COPILOT</div><h2>Jarvis</h2></div>
        <div class="jarvis-live"><span></span>${acct.dashboard?.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</div>
      </div>

      <div class="chat-stream" id="chat-stream">
        <div class="chat-message from-jarvis snapshot-message">
          <div class="chat-speaker">JARVIS · NOW</div>
          <div class="chat-bubble">
            <div class="snapshot-lead">Your 30-second read</div>
            <div class="snapshot-stats">
              <div><span>ACCOUNT</span><b>${money(pv)}</b><small class="${Number(pnlPct) >= 0 ? "positive" : "negative"}">${Number(pnlPct) >= 0 ? "+" : ""}${Number(pnlPct).toFixed(1)}%</small></div>
              <div><span>AVAILABLE</span><b>${money(state.cash)}</b><small>buying power</small></div>
              <div><span>POSITIONS</span><b>${posSource.length}</b><small>${reviewNow} idea${reviewNow === 1 ? "" : "s"} to review</small></div>
              <div><span>REGIME</span><b class="${marketClass}">${escapeDashboardHTML(regimeLabel)}</b><small>${dailyTape ? `tape ${dailyTape.score}/10` : "tape pending"}</small></div>
            </div>
            <div class="snapshot-callout"><b>Focus:</b> ${featured[0] ? `${escapeDashboardHTML(featured[0].ticker)} is the highest-ranked current setup shown below.` : "No current setup has earned the top slot yet."} Tap any idea for the full thesis and contract context.</div>
          </div>
        </div>

        <div class="intel-in-chat">
          <div class="intel-title"><span>Best opportunities now</span><small>${allDecisions.length} scanned · strongest ${ideas.length} shown</small></div>
          <div class="idea-stack">${ideaCards}</div>
          <details class="wider-ideas">
            <summary>Other trades worth seeing <span>${wider.length}</span></summary>
            <div class="idea-stack">${widerCards}</div>
          </details>
        </div>

        ${chatHistoryHTML(acct.chatHistory || [])}
      </div>

      ${spectator ? `<div class="spectator-compose">Spectator mode · conversation is read-only</div>` : `<div class="quick-prompts">
        <button type="button" data-prompt="What is the best trade right now, and what would invalidate it?">Best trade now</button>
        <button type="button" data-prompt="Compare ${escapeDashboardHTML(topTicker)} with the next three best setups, including what the scanner may be missing.">Compare top ideas</button>
        <button type="button" data-prompt="What good trades are close but not currently being considered, and why?">What are we missing?</button>
        <button type="button" data-prompt="Review every open position, working order, profit opportunity, and thesis risk.">Review positions</button>
      </div>
      <form class="jarvis-compose" method="POST" action="/hint?a=${encodeURIComponent(acct.id)}">
        <textarea id="jarvis-input" name="hint" rows="1" placeholder="Text Jarvis about a trade or give an instruction…" autocomplete="off"></textarea>
        <button type="submit" aria-label="Send to Jarvis">↑</button>
      </form>
      <div class="compose-note">Jarvis can analyze and remember directives. Broker orders still follow the account's explicit execution mode.</div>`}
    </main>

    <aside class="insight-rail" id="positions">
      <section class="rail-card">
        <div class="rail-title"><span>Open positions</span><b>${posSource.length}</b></div>
        <div class="position-stack">${positionCards}</div>
      </section>
      <section class="rail-card" id="market-pulse">
        <div class="rail-title"><span>Market pulse</span><b class="${marketClass}">${escapeDashboardHTML(regimeLabel)}</b></div>
        <div class="market-copy"><b>Tape</b> · ${compactReason(tapeLine)}</div>
        <div class="market-copy"><b>News</b> · ${compactReason(marketBrief)}</div>
        <a class="rail-link" href="#deep-dive">Open charts, full analysis and logs <span>›</span></a>
      </section>
      <section class="rail-card account-rail" id="account-summary">
        <div class="rail-title"><span>${activeAccount}</span><b>${acct.config?.broker === "robinhood" ? "RH LIVE" : "PAPER"}</b></div>
        <div class="account-mini-grid"><div><span>Equity</span><b>${money(pv)}</b></div><div><span>Cash</span><b>${money(state.cash)}</b></div></div>
        <a class="rail-link" href="#account-controls">Settings and account controls <span>›</span></a>
      </section>
    </aside>
  </section>
  <nav class="mobile-dock" aria-label="Dashboard sections">
    <a href="#jarvis"><span>◉</span>Jarvis</a>
    <a href="#positions"><span>${posSource.length}</span>Positions</a>
    <a href="#market-pulse"><span>↗</span>Market</a>
    <a href="#deep-dive"><span>•••</span>More</a>
  </nav>`;
}
