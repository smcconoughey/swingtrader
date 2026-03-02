import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import http from "http";

// ─── Technical Analysis Engine (ported from live-swing-simulator.jsx) ───

const calcEMA = (data, period) => {
  const k = 2 / (period + 1);
  let ema = [data[0]];
  for (let i = 1; i < data.length; i++) ema.push(data[i] * k + ema[i - 1] * (1 - k));
  return ema;
};

const calcRSI = (data, period = 14) => {
  let g = [], l = [];
  for (let i = 1; i < data.length; i++) { const d = data[i] - data[i - 1]; g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0); }
  let rsi = new Array(period).fill(50);
  let ag = g.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = l.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < g.length; i++) {
    ag = (ag * (period - 1) + g[i]) / period; al = (al * (period - 1) + l[i]) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
};

const calcATR = (h, l, c, period = 14) => {
  let trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let atr = [trs.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < trs.length; i++) atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period);
  return atr;
};

function runAnalysis(candles) {
  if (!candles || candles.length < 55) return null;
  const closes = candles.map(d => d.c), highs = candles.map(d => d.h), lows = candles.map(d => d.l), volumes = candles.map(d => d.v);
  const ema8 = calcEMA(closes, 8), ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes, 14), atr = calcATR(highs, lows, closes, 14);
  const L = closes.length - 1, c = closes[L];
  const aligned = ema8[L] > ema21[L] && ema21[L] > ema50[L];
  const bearish = ema8[L] < ema21[L] && ema21[L] < ema50[L];
  const spread = ((ema8[L] - ema50[L]) / ema50[L]) * 100;
  const avgV20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgV5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vr = avgV20 > 0 ? avgV5 / avgV20 : 1;
  const pb8 = c <= ema8[L] * 1.005 && c >= ema8[L] * 0.99;
  const pb21 = c <= ema21[L] * 1.005 && c >= ema21[L] * 0.99;
  const rV = rsi[rsi.length - 1] || 50;
  const aV = atr[atr.length - 1] || c * 0.02;

  const sigs = [];

  // ─── Bullish score (0 to 100) ───
  let bull = 0;
  if (aligned) { bull += 25; sigs.push({ t: "bull", text: "EMA Stack Aligned (8>21>50)" }); }
  const xover = ema8[L] > ema21[L] && L >= 3 && ema8[L - 3] <= ema21[L - 3];
  if (xover) { bull += 20; sigs.push({ t: "bull", text: "Fresh 8/21 EMA Bullish Crossover" }); }
  if (aligned && pb8 && vr < 0.85) { bull += 20; sigs.push({ t: "bull", text: "Pullback to 8 EMA on low volume" }); }
  else if (aligned && pb21 && vr < 0.85) { bull += 15; sigs.push({ t: "bull", text: "Pullback to 21 EMA on low volume" }); }
  if (vr > 1.15 && aligned) { bull += 15; sigs.push({ t: "bull", text: "Volume expanding with trend" }); }
  if (rV > 50 && rV < 70 && aligned) { bull += 10; sigs.push({ t: "bull", text: `RSI ${rV.toFixed(0)} — healthy bullish momentum` }); }
  if (rV <= 30) { bull += 10; sigs.push({ t: "bull", text: `RSI ${rV.toFixed(0)} — oversold, bounce candidate` }); }

  let hh = 0, hl = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] > highs[i]) hh++; if (lows[i + 1] > lows[i]) hl++; }
  const trendUp = ((hh + hl) / 18) * 100;
  if (trendUp > 60) { bull += 10; sigs.push({ t: "bull", text: `Uptrend structure ${trendUp.toFixed(0)}%` }); }

  // ─── Bearish score (0 to 100) ───
  let bear = 0;
  if (bearish) { bear += 25; sigs.push({ t: "bear", text: "EMA Stack Bearish (8<21<50)" }); }
  const xoverBear = ema8[L] < ema21[L] && L >= 3 && ema8[L - 3] >= ema21[L - 3];
  if (xoverBear) { bear += 20; sigs.push({ t: "bear", text: "Fresh 8/21 EMA Bearish Crossover" }); }
  // Bounce to EMA resistance in downtrend
  const res8 = c >= ema8[L] * 0.995 && c <= ema8[L] * 1.01;
  const res21 = c >= ema21[L] * 0.995 && c <= ema21[L] * 1.01;
  if (bearish && res8 && vr < 0.85) { bear += 20; sigs.push({ t: "bear", text: "Rejection at 8 EMA resistance on low volume" }); }
  else if (bearish && res21 && vr < 0.85) { bear += 15; sigs.push({ t: "bear", text: "Rejection at 21 EMA resistance on low volume" }); }
  if (vr > 1.15 && bearish) { bear += 15; sigs.push({ t: "bear", text: "Volume expanding with downtrend" }); }
  if (rV >= 70) { bear += 10; sigs.push({ t: "bear", text: `RSI ${rV.toFixed(0)} — overbought, reversal candidate` }); }
  if (rV < 50 && rV > 30 && bearish) { bear += 10; sigs.push({ t: "bear", text: `RSI ${rV.toFixed(0)} — bearish momentum` }); }

  // Downtrend structure: lower highs and lower lows
  let lh = 0, ll = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] < highs[i]) lh++; if (lows[i + 1] < lows[i]) ll++; }
  const trendDn = ((lh + ll) / 18) * 100;
  if (trendDn > 60) { bear += 10; sigs.push({ t: "bear", text: `Downtrend structure ${trendDn.toFixed(0)}%` }); }

  // Price distance from 50 EMA — further below = stronger bear
  if (bearish && spread < -1) { bear += 5; sigs.push({ t: "bear", text: `Price ${Math.abs(spread).toFixed(1)}% below 50 EMA` }); }

  // Clamp
  bull = Math.max(0, Math.min(100, bull));
  bear = Math.max(0, Math.min(100, bear));

  // Combined score: positive = bullish, negative = bearish. Range -100 to +100.
  // Map to 0-100 for display: 50 = neutral, >50 = bullish, <50 = bearish
  const netScore = bull - bear;
  const displayScore = Math.max(0, Math.min(100, 50 + netScore / 2));

  let sig;
  if (displayScore >= 70) sig = "STRONG BUY";
  else if (displayScore >= 55) sig = "BUY WATCH";
  else if (displayScore >= 45) sig = "NEUTRAL";
  else if (displayScore >= 30) sig = "SELL WATCH";
  else sig = "STRONG SELL";

  return {
    score: Math.round(displayScore), bullScore: bull, bearScore: bear,
    signal: sig, sigs, price: c,
    ema8v: ema8[L], ema21v: ema21[L], ema50v: ema50[L],
    aligned, bearish, spread, rsi: rV, atr: aV, atrPct: (aV / c) * 100, vr,
    stop: +(c - aV * 1.5).toFixed(2), t1: +(c + aV * 2).toFixed(2), t2: +(c + aV * 3).toFixed(2),
    rr: ((aV * 2) / Math.max(0.01, aV * 1.5)).toFixed(1),
  };
}

// ─── Options Helpers (ported from live-swing-simulator.jsx) ───

function optPrice(spot, strike, dte, iv, type = "call") {
  const t = dte / 365;
  const intr = type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  return Math.max(0.05, +(intr + spot * iv * Math.sqrt(t) * 0.4).toFixed(2));
}

function optGreeks(spot, strike, dte, iv, type = "call") {
  const t = Math.max(dte / 365, 0.001);
  const d = type === "call"
    ? Math.min(0.99, Math.max(0.01, 0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)))
    : Math.max(-0.99, Math.min(-0.01, -0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)));
  return { delta: +d.toFixed(3), theta: +(-(spot * iv) / (2 * Math.sqrt(t) * 365) * 0.4).toFixed(3) };
}

// ─── Constants ───

let TICKERS = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "META", "AMZN", "GOOGL", "AMD"];
const STATE_FILE = "state.json";
const HINT_FILE = "hint.txt";
const CYCLE_MS = 60_000;       // 60s between cycles
const API_DELAY = 150;         // 150ms between API calls (Finnhub free tier)
const MAX_POSITIONS = Infinity; // No hard limit — bot manages liquidity dynamically
const RISK_PCT = 0.15;         // 15% of portfolio per trade — balanced across more plays
const PROFIT_TARGET = 0.40;    // Take profits at +40% (compound faster)
const STOP_LOSS = -0.35;       // Wider stop to avoid premature exits on volatile plays
const DEFAULT_IV = 0.30;
const BULL_ENTRY = 65;         // Buy calls when score >= 65 (bullish)
const BEAR_ENTRY = 35;         // Buy puts when score <= 35 (bearish)

const STARTING_CASH = 25_000;
const GOAL = 200_000;
const CLAUDE_API_KEY = "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";
const INIT_STATE = { cash: 25_000, positions: [], history: [], dayTrades: [], apiKey: "" };

// ─── Logging ───

// log() is defined below after dashboard state init, so it can capture lines for the web UI

// ─── State Persistence ───

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (e) {
    log(`WARN: Failed to load state — ${e.message}`);
  }
  return null;
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`WARN: Failed to save state — ${e.message}`);
  }
}

// Append-only trade log for Monte Carlo training
function logTrade(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync("trades.log", line);
  } catch {}
}

// ─── Market Hours ───

function getETDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function isMarketOpen() {
  const et = getETDate();
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 AM (570) to 4:00 PM (960)
}

function getETDateStr() {
  return getETDate().toISOString().slice(0, 10);
}

// ─── PDT Enforcement ───

function getBusinessDaysAgo(n) {
  const d = getETDate();
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return d.toISOString().slice(0, 10);
}

function cleanDayTrades(state) {
  const cutoff = getBusinessDaysAgo(5);
  state.dayTrades = state.dayTrades.filter(dt => dt.date >= cutoff);
}

function countRecentDayTrades(state) {
  const cutoff = getBusinessDaysAgo(5);
  return state.dayTrades.filter(dt => dt.date >= cutoff).length;
}

function wouldBeDayTrade(position) {
  return position.openDate === getETDateStr();
}

function canClosePDT(state, position) {
  if (!wouldBeDayTrade(position)) return true; // not a day trade, always OK
  return countRecentDayTrades(state) < 3;
}

function recordDayTrade(state, position) {
  if (wouldBeDayTrade(position)) {
    state.dayTrades.push({
      date: getETDateStr(),
      ticker: position.ticker,
      strike: position.strike,
      type: position.type,
    });
  }
}

// ─── API Layer ───

async function fetchQuote(sym, key) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`);
  if (!r.ok) throw new Error(`Quote error ${r.status}`);
  return r.json();
}

async function fetchCandles(sym, key) {
  // Try Finnhub first
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}&token=${key}`);
    if (r.ok) {
      const d = await r.json();
      if (d.s === "ok" && d.c) {
        return d.c.map((c, i) => ({ c, h: d.h[i], l: d.l[i], o: d.o[i], v: d.v[i], t: d.t[i] }));
      }
    }
  } catch {}

  // Fallback: Yahoo Finance (no API key needed)
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${from}&period2=${to}&interval=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Yahoo error ${r.status}`);
    const d = await r.json();
    const q = d.chart?.result?.[0];
    if (!q || !q.indicators?.quote?.[0]) return null;
    const ts = q.timestamp;
    const ohlcv = q.indicators.quote[0];
    return ts.map((t, i) => ({
      c: ohlcv.close[i], h: ohlcv.high[i], l: ohlcv.low[i],
      o: ohlcv.open[i], v: ohlcv.volume[i], t,
    })).filter(c => c.c != null);
  } catch (e) {
    throw new Error(`Candle fetch failed for ${sym}: ${e.message}`);
  }
}

async function validateKey(key) {
  try {
    const q = await fetchQuote("AAPL", key);
    return q && typeof q.c === "number" && q.c > 0;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Prompt for API Key ───

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── Portfolio Helpers ───

function portfolioValue(state, quotes) {
  let val = state.cash;
  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    val += currentPremium * pos.qty * 100;
  }
  return val;
}

function signalLabel(score) {
  if (score >= 70) return "STRONG BUY";
  if (score >= 55) return "BUY WATCH";
  if (score >= 45) return "NEUTRAL";
  if (score >= 30) return "SELL WATCH";
  return "STRONG SELL";
}

// ─── Claude Hint System ───
// Write to hint.txt anytime to push the bot in a direction.
// e.g. "check out PLTR, its being used in the iran war and may move"
// Claude interprets the hint and returns structured trading bias.

let activeHints = [];        // Array of { ticker, bias, direction, reasoning, expiresAt }
let lastHintContent = "";    // Track file changes

async function callClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Claude API ${r.status}: ${err}`);
  }
  const data = await r.json();
  return data.content[0].text;
}

async function processHint(hintText, state) {
  const portfolioContext = `Portfolio: $${state.cash.toFixed(0)} cash, ${state.positions.length} positions open (${state.positions.map(p => `${p.ticker} ${p.type}`).join(", ") || "none"}). Current watchlist: ${TICKERS.join(", ")}.`;

  const prompt = `You are a trading bot's AI advisor. The user gave this hint to guide their options trading bot:

"${hintText}"

${portfolioContext}

Interpret this hint and respond with ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "tickers": [{"symbol": "PLTR", "direction": "bullish", "bias": 25, "reasoning": "short explanation"}],
  "removeTickers": [],
  "urgency": "high",
  "advice": "one sentence summary of action"
}

Rules:
- "bias" is a score adjustment from -30 to +30 added to the technical analysis score
- "direction" is "bullish" or "bearish"
- If the hint mentions a new ticker not in the watchlist, include it in tickers with appropriate bias
- "removeTickers" only if the user explicitly says to stop watching something
- "urgency": "high" (act now), "medium" (watch closely), "low" (keep in mind)
- Keep reasoning very brief
- You can return multiple tickers if the hint implies it`;

  try {
    const raw = await callClaude(prompt);
    // Parse JSON — handle potential markdown wrapping
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    log(`CLAUDE WARN: Failed to parse hint response — ${e.message}`);
    return null;
  }
}

async function checkHints(state) {
  try {
    if (!fs.existsSync(HINT_FILE)) return;
    const content = fs.readFileSync(HINT_FILE, "utf-8").trim();
    if (!content || content === lastHintContent) return;

    lastHintContent = content;
    log(`HINT RECEIVED: "${content}"`);

    const result = await processHint(content, state);
    if (!result) return;

    log(`CLAUDE SAYS: ${result.advice}`);

    // Process ticker additions
    for (const t of result.tickers || []) {
      // Add to watchlist if new
      if (!TICKERS.includes(t.symbol)) {
        TICKERS.push(t.symbol);
        log(`WATCHLIST +${t.symbol} (${t.direction}, bias ${t.bias > 0 ? "+" : ""}${t.bias})`);
      } else {
        log(`BIAS ${t.symbol}: ${t.bias > 0 ? "+" : ""}${t.bias} (${t.direction}) — ${t.reasoning}`);
      }

      // Set active hint bias — expires in 4 hours
      const existing = activeHints.findIndex(h => h.ticker === t.symbol);
      const hint = {
        ticker: t.symbol,
        bias: t.bias,
        direction: t.direction,
        reasoning: t.reasoning,
        expiresAt: Date.now() + 4 * 60 * 60_000,
      };
      if (existing >= 0) activeHints[existing] = hint;
      else activeHints.push(hint);
    }

    // Process removals
    for (const sym of result.removeTickers || []) {
      TICKERS = TICKERS.filter(t => t !== sym);
      activeHints = activeHints.filter(h => h.ticker !== sym);
      log(`WATCHLIST -${sym}`);
    }

    // Clear the hint file after processing
    fs.writeFileSync(HINT_FILE, "");

  } catch (e) {
    log(`HINT ERROR: ${e.message}`);
  }
}

function getHintBias(ticker) {
  const now = Date.now();
  // Clean expired hints
  activeHints = activeHints.filter(h => h.expiresAt > now);
  const hint = activeHints.find(h => h.ticker === ticker);
  return hint ? hint.bias : 0;
}

function getActiveHintsSummary() {
  const now = Date.now();
  activeHints = activeHints.filter(h => h.expiresAt > now);
  if (activeHints.length === 0) return "";
  return " | Hints: " + activeHints.map(h => {
    const mins = Math.round((h.expiresAt - now) / 60_000);
    return `${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${mins}m left)`;
  }).join(", ");
}

// ─── Auto News Scanner (runs every 3 hours) ───

const NEWS_INTERVAL = 3 * 60 * 60_000; // 3 hours
let lastNewsScan = 0;
let latestNewsBrief = "";

async function fetchMarketNews(apiKey) {
  const headlines = [];

  // Finnhub general market news
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${apiKey}`);
    if (r.ok) {
      const articles = await r.json();
      for (const a of articles.slice(0, 15)) {
        headlines.push({ title: a.headline, source: a.source, time: a.datetime, summary: a.summary?.slice(0, 200) || "" });
      }
    }
  } catch {}

  // Finnhub market-wide news for our tickers
  for (const ticker of TICKERS.slice(0, 5)) { // top 5 to save API calls
    try {
      const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${todayStr()}&to=${todayStr()}&token=${apiKey}`);
      if (r.ok) {
        const articles = await r.json();
        for (const a of articles.slice(0, 3)) {
          headlines.push({ title: a.headline, source: a.source, ticker, summary: a.summary?.slice(0, 200) || "" });
        }
      }
      await delay(API_DELAY);
    } catch {}
  }

  return headlines;
}

function todayStr() {
  const d = getETDate();
  return d.toISOString().slice(0, 10);
}

async function runNewsScan(state) {
  const now = Date.now();
  if (now - lastNewsScan < NEWS_INTERVAL) return;
  lastNewsScan = now;

  log("NEWS SCAN: Fetching latest market headlines...");

  const headlines = await fetchMarketNews(state.apiKey);
  if (headlines.length === 0) {
    log("NEWS SCAN: No headlines fetched");
    return;
  }

  const headlineText = headlines.map((h, i) =>
    `${i + 1}. [${h.source}${h.ticker ? ` / ${h.ticker}` : ""}] ${h.title}${h.summary ? ` — ${h.summary}` : ""}`
  ).join("\n");

  const positionContext = state.positions.length > 0
    ? `Current positions: ${state.positions.map(p => `${p.ticker} ${p.type.toUpperCase()} $${p.strike}`).join(", ")}`
    : "No open positions";

  const prompt = `You are a trading bot's market intelligence system. Analyze these headlines for anything that could drastically impact markets in the next few hours.

CURRENT HEADLINES:
${headlineText}

PORTFOLIO CONTEXT:
Cash: $${state.cash.toFixed(0)} | ${positionContext}
Watchlist: ${TICKERS.join(", ")}

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "severity": "normal" | "elevated" | "critical",
  "blackSwan": false,
  "summary": "1-2 sentence market read",
  "impacts": [
    {"ticker": "SPY", "direction": "bearish", "bias": -15, "reasoning": "brief reason"}
  ],
  "newTickers": [],
  "actionAdvice": "what the bot should consider doing",
  "riskLevel": "low" | "medium" | "high"
}

Rules:
- "severity": "normal" = business as usual, "elevated" = notable event moving markets, "critical" = black swan / crash / emergency
- "blackSwan": true only for genuinely extreme events (war escalation, market crash, major bank failure, pandemic, etc.)
- "bias" adjustments: normal news ±5-10, big news ±15-20, black swan ±25-30
- "impacts" only for tickers meaningfully affected — don't list every ticker
- "newTickers" if a stock not on the watchlist is suddenly very relevant
- If severity is critical, actionAdvice should recommend defensive positioning
- Be concise. Only flag what actually matters for short-term options trading.`;

  try {
    const raw = await callClaude(prompt);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(cleaned);

    // Log the scan
    const sevColor = result.severity === "critical" ? "!!!" : result.severity === "elevated" ? "!!" : "";
    log(`NEWS ${sevColor}${result.severity.toUpperCase()}: ${result.summary}`);
    latestNewsBrief = `[${result.severity.toUpperCase()}] ${result.summary}`;

    if (result.blackSwan) {
      log("BLACK SWAN DETECTED — Claude recommends defensive action");
      log(`ACTION ADVICE: ${result.actionAdvice}`);
    }

    // Apply impacts as hint biases
    for (const impact of result.impacts || []) {
      if (!TICKERS.includes(impact.ticker) && impact.ticker) {
        TICKERS.push(impact.ticker);
        log(`NEWS WATCHLIST +${impact.ticker}`);
      }

      const existing = activeHints.findIndex(h => h.ticker === impact.ticker);
      const hint = {
        ticker: impact.ticker,
        bias: impact.bias,
        direction: impact.direction,
        reasoning: `[NEWS] ${impact.reasoning}`,
        expiresAt: Date.now() + 3 * 60 * 60_000, // expires at next scan
      };
      if (existing >= 0) activeHints[existing] = hint;
      else activeHints.push(hint);

      log(`NEWS BIAS: ${impact.ticker} ${impact.bias > 0 ? "+" : ""}${impact.bias} (${impact.direction}) — ${impact.reasoning}`);
    }

    // Add new tickers from news
    for (const ticker of result.newTickers || []) {
      if (!TICKERS.includes(ticker)) {
        TICKERS.push(ticker);
        log(`NEWS WATCHLIST +${ticker}`);
      }
    }

    // If critical, also log the advice prominently
    if (result.severity === "critical" || result.severity === "elevated") {
      log(`NEWS ADVICE: ${result.actionAdvice}`);
    }

    return result;
  } catch (e) {
    log(`NEWS SCAN ERROR: ${e.message}`);
    return null;
  }
}

function getNewsBrief() {
  return latestNewsBrief;
}

// ─── Entry Logic ───

function tryEntry(state, ticker, analysis, quote) {
  if (state.positions.some(p => p.ticker === ticker)) return null;
  if (state.cash < 200) return null; // Need minimum cash to open a position

  const spot = quote.c;
  const maxRisk = state.cash * RISK_PCT;

  let type, strike, dte;

  if (analysis.score >= BULL_ENTRY) {
    // Strong bullish → buy OTM calls
    type = "call";
    const atm = Math.round(spot / 5) * 5;
    strike = atm + 5; // 1 strike OTM
    dte = 7;
  } else if (analysis.score <= BEAR_ENTRY) {
    // Strong bearish → buy OTM puts
    type = "put";
    const atm = Math.round(spot / 5) * 5;
    strike = atm - 5; // 1 strike OTM
    dte = 7;
  } else {
    return null; // Neutral zone — no edge, wait
  }

  const premium = optPrice(spot, strike, dte, DEFAULT_IV, type);
  const costPer = premium * 100; // 1 contract = 100 shares
  let qty = Math.max(1, Math.floor(maxRisk / costPer));
  let totalCost = qty * costPer;

  // If we can't even afford 1 contract, skip
  if (costPer > state.cash) return null;
  // Cap to what we can afford
  if (totalCost > state.cash) { qty = Math.floor(state.cash / costPer); totalCost = qty * costPer; }

  const position = {
    ticker, type, strike, dte,
    dteRemaining: dte,
    entryPremium: premium,
    entrySpot: spot,
    qty,
    cost: totalCost,
    openDate: getETDateStr(),
    openTime: Date.now(),
  };

  state.cash -= totalCost;
  state.positions.push(position);

  return position;
}

// ─── Exit Logic ───

function tryExits(state, quotes) {
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    // Decay DTE based on time elapsed
    const elapsed = (Date.now() - pos.openTime) / (86400_000);
    pos.dteRemaining = Math.max(0, pos.dte - elapsed);

    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    const pnlDollar = (currentPremium - pos.entryPremium) * pos.qty * 100;

    let reason = null;

    if (pnlPct >= PROFIT_TARGET) {
      reason = `profit target +${(pnlPct * 100).toFixed(0)}%`;
    } else if (pnlPct <= STOP_LOSS) {
      reason = `stop loss ${(pnlPct * 100).toFixed(0)}%`;
    } else if (pos.dteRemaining <= 1) {
      reason = "DTE expiring";
    }

    if (!reason) { remaining.push(pos); continue; }

    // PDT check
    if (!canClosePDT(state, pos)) {
      const used = countRecentDayTrades(state);
      log(`PDT BLOCKED: Cannot close ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} — ${used}/3 day trades used (opened today)`);
      remaining.push(pos);
      continue;
    }

    // Execute close
    const proceeds = currentPremium * pos.qty * 100;
    state.cash += proceeds;
    recordDayTrade(state, pos);

    const dtUsed = countRecentDayTrades(state);
    const trade = { ...pos, closePremium: currentPremium, pnlDollar, pnlPct, reason };
    closed.push(trade);
    logTrade(trade);

    log(`EXIT: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);
    if (wouldBeDayTrade(pos)) {
      log(`PDT CHECK: ${dtUsed}/3 day trades used (rolling 5 days)`);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── Signal-Based Exit ───

function trySignalExits(state, quotes, analyses) {
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const a = analyses[pos.ticker];
    if (!a) { remaining.push(pos); continue; }

    let reversed = false;
    if (pos.type === "call" && a.score <= BEAR_ENTRY) reversed = true; // Was bullish, now bearish
    if (pos.type === "put" && a.score >= BULL_ENTRY) reversed = true;  // Was bearish, now bullish

    if (!reversed) { remaining.push(pos); continue; }

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    const pnlDollar = (currentPremium - pos.entryPremium) * pos.qty * 100;

    if (!canClosePDT(state, pos)) {
      const used = countRecentDayTrades(state);
      log(`PDT BLOCKED: Cannot close ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} on signal reversal — ${used}/3 day trades used`);
      remaining.push(pos);
      continue;
    }

    const proceeds = currentPremium * pos.qty * 100;
    state.cash += proceeds;
    recordDayTrade(state, pos);

    const dtUsed = countRecentDayTrades(state);
    const trade = { ...pos, closePremium: currentPremium, pnlDollar, pnlPct, reason: "signal reversed" };
    closed.push(trade);
    logTrade(trade);

    log(`EXIT: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — signal reversed`);
    if (wouldBeDayTrade(pos)) {
      log(`PDT CHECK: ${dtUsed}/3 day trades used (rolling 5 days)`);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── Dashboard State (shared with web server) ───

const dashboard = {
  quotes: {},
  analyses: {},
  candles: {},      // Candle cache for chart rendering
  lastCycle: null,
  cycleLog: [],     // Last 200 log lines
  marketOpen: false,
  decisions: [],    // Per-ticker decision reasoning each cycle
  positionDetails: [], // Enriched position info with stops/targets
};

function log(msg) {
  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const line = `[${now}] ${msg}`;
  console.log(line);
  dashboard.cycleLog.push(line);
  if (dashboard.cycleLog.length > 200) dashboard.cycleLog.shift();
}

// ─── Web Dashboard ───

const DASH_PORT = 3000;

function dashboardHTML(state) {
  const pv = portfolioValue(state, dashboard.quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  const progress = ((pv / GOAL) * 100).toFixed(1);
  const dtCount = countRecentDayTrades(state);

  const posRows = dashboard.positionDetails.length > 0 ? dashboard.positionDetails.map(p => {
    const color = p.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    const profitBar = Math.min(100, Math.max(0, (p.pnlPct / PROFIT_TARGET) * 100));
    const stopBar = Math.min(100, Math.max(0, (p.pnlPct / STOP_LOSS) * 100));
    return `<tr>
      <td><a href="/ticker/${p.ticker}"><b>${p.ticker}</b></a></td><td>${p.type.toUpperCase()}</td><td>$${p.strike}</td>
      <td>${p.dteLeft.toFixed(1)}d</td><td>${p.qty}</td>
      <td>$${p.entryPremium.toFixed(2)}</td><td>$${p.curPremium.toFixed(2)}</td>
      <td style="color:${color}">${p.pnlPct >= 0 ? "+" : ""}${(p.pnlPct * 100).toFixed(1)}% ($${p.pnlDollar.toFixed(0)})</td>
      <td><span style="color:#00ff88">TP $${p.profitTarget.premium}</span> (${p.pctToProfit}% away)</td>
      <td><span style="color:#ff4444">SL $${p.stopLoss.premium}</span> (${p.pctToStop}% away)</td>
      <td style="font-size:10px;color:#888">δ${p.greeks.delta} θ${p.greeks.theta}<br>${p.pdtStatus}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="11" style="opacity:.5">No open positions</td></tr>';

  // Decision reasoning panel
  const decisionRows = dashboard.decisions.map(d => {
    const actionColor = d.action === "BUY CALL" ? "#00ff88" : d.action === "BUY PUT" ? "#ff4444" :
      d.action === "HOLD" ? "#4ecdc4" : d.action === "BLOCKED" ? "#ffd93d" : "#666";
    const hintStr = d.hintBias ? ` <span style="color:#a78bfa">${d.hintBias > 0 ? "+" : ""}${d.hintBias}</span>` : "";
    const sigList = (d.signals || []).map(s => `<span style="color:#555;font-size:10px">• ${s}</span>`).join("<br>");
    return `<tr>
      <td><a href="/ticker/${d.ticker}"><b>${d.ticker}</b></a></td>
      <td>${d.price ? "$" + d.price.toFixed(2) : "—"}</td>
      <td>${d.rawScore ?? "—"}${hintStr} → <b>${d.finalScore ?? "—"}</b></td>
      <td style="color:${actionColor}"><b>${d.action}</b></td>
      <td style="font-size:11px">${d.reason || "—"}</td>
      <td style="font-size:10px;color:#888">${d.ema8 ? `8:${d.ema8} 21:${d.ema21} 50:${d.ema50}` : "—"}</td>
      <td style="font-size:10px;color:#888">${d.rsi ? `RSI:${d.rsi} ATR:${d.atrPct}% VR:${d.vr}` : "—"}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="7" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const analysisRows = Object.entries(dashboard.analyses).map(([ticker, a]) => {
    const q = dashboard.quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "—";
    const sigColor = a.signal === "STRONG BUY" ? "#00ff88" : a.signal === "BUY WATCH" ? "#ffd93d" : a.signal === "NEUTRAL" ? "#888" : a.signal === "SELL WATCH" ? "#ff8c42" : "#ff4444";
    const hintBias = getHintBias(ticker);
    const hintTag = hintBias !== 0 ? ` <span style="color:#a78bfa">[${hintBias > 0 ? "+" : ""}${hintBias}]</span>` : "";
    return `<tr><td><a href="/ticker/${ticker}">${ticker}</a></td><td>${price}</td><td><b style="color:${sigColor}">${a.score}</b></td>
      <td style="color:${sigColor}">${a.signal}${hintTag}</td>
      <td>${a.rsi.toFixed(0)}</td><td>${a.atrPct.toFixed(1)}%</td><td>${a.vr.toFixed(2)}</td></tr>`;
  }).join("") || '<tr><td colspan="7" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const historyRows = state.history.slice(-20).reverse().map(h => {
    const color = h.pnlDollar >= 0 ? "#00ff88" : "#ff4444";
    return `<tr><td>${h.ticker}</td><td>${h.type.toUpperCase()}</td><td>$${h.strike}</td>
      <td>$${h.entryPremium.toFixed(2)}</td><td>$${(h.closePremium || 0).toFixed(2)}</td>
      <td style="color:${color}">${h.pnlDollar >= 0 ? "+" : ""}$${h.pnlDollar.toFixed(0)} (${(h.pnlPct * 100).toFixed(0)}%)</td>
      <td>${h.reason || "—"}</td></tr>`;
  }).join("") || '<tr><td colspan="7" style="opacity:.5">No trades yet</td></tr>';

  const hints = activeHints.map(h => {
    const mins = Math.round((h.expiresAt - Date.now()) / 60_000);
    return `<span class="hint">${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${h.direction}, ${mins}m left) — ${h.reasoning}</span>`;
  }).join("") || '<span style="opacity:.5">None active. Write to hint.txt to add.</span>';

  const logLines = dashboard.cycleLog.slice(-50).reverse().map(l =>
    l.replace(/\[(\d+:\d+:\d+)\]/, '<span style="color:#666">[$1]</span>')
     .replace(/(TRADE:|EXIT:|HINT RECEIVED:|CLAUDE SAYS:)/g, '<b style="color:#a78bfa">$1</b>')
     .replace(/(PDT BLOCKED:)/g, '<b style="color:#ff4444">$1</b>')
     .replace(/(STRONG BUY)/g, '<span style="color:#00ff88">$1</span>')
     .replace(/(AVOID)/g, '<span style="color:#ff4444">$1</span>')
  ).join("<br>");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Swingers Bot Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:13px;padding:20px}
  h1{color:#00ff88;font-size:20px;margin-bottom:4px}
  .sub{color:#666;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:16px}
  .card h2{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:24px;margin-bottom:8px}
  .stat .val{font-size:22px;font-weight:800;color:#00ff88}
  .stat .lbl{font-size:10px;color:#666;text-transform:uppercase}
  .stat.warn .val{color:#ffd93d}
  .stat.neg .val{color:#ff4444}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;color:#666;font-size:10px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #1e1e2e}
  td{padding:6px 8px;border-bottom:1px solid #0e0e16}
  tr:hover{background:#ffffff05}
  a{color:#4ecdc4;text-decoration:none}a:hover{text-decoration:underline}
  .log{background:#08080c;border-radius:6px;padding:12px;max-height:300px;overflow-y:auto;line-height:1.6;font-size:11px}
  .hint{display:inline-block;background:#a78bfa20;border:1px solid #a78bfa40;border-radius:4px;padding:2px 8px;margin:2px 4px;font-size:11px;color:#a78bfa}
  .progress{background:#1e1e2e;border-radius:4px;height:20px;margin:8px 0;overflow:hidden}
  .progress-bar{height:100%;background:linear-gradient(90deg,#00ff88,#4ecdc4);border-radius:4px;transition:width .5s}
  .hint-form{margin-top:8px}
  .hint-form input{background:#0a0a0f;border:1px solid #333;color:#e0e0e0;padding:8px 12px;border-radius:4px;width:70%;font-family:inherit;font-size:12px}
  .hint-form button{background:#a78bfa;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px}
  .market-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}
  .open{background:#00ff8830;color:#00ff88}
  .closed{background:#ff444430;color:#ff4444}
</style></head><body>
<h1>SWINGERS Auto-Trading Bot</h1>
<div class="sub">$25K → $200K Challenge &nbsp;|&nbsp; <span class="market-badge ${dashboard.marketOpen ? "open" : "closed"}">${dashboard.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span> &nbsp;|&nbsp; Auto-refreshes every 30s</div>

<div class="grid">
  <div class="card">
    <h2>Portfolio</h2>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">$${pv.toFixed(0)}</div><div class="lbl">Total Value</div></div>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">${pnlPct >= 0 ? "+" : ""}${pnlPct}%</div><div class="lbl">P&L</div></div>
    <div class="stat"><div class="val">$${state.cash.toFixed(0)}</div><div class="lbl">Cash</div></div>
    <div class="stat warn"><div class="val">${dtCount}/3</div><div class="lbl">PDT Used</div></div>
    <div class="progress"><div class="progress-bar" style="width:${Math.min(100, progress)}%"></div></div>
    <div style="font-size:11px;color:#666">${progress}% to $${GOAL.toLocaleString()} goal</div>
  </div>
  <div class="card">
    <h2>Claude Hints &amp; News Intel</h2>
    <div style="margin-bottom:8px;padding:6px 10px;background:#0a0a0f;border-radius:4px;font-size:11px;border-left:3px solid ${latestNewsBrief.includes("CRITICAL") ? "#ff4444" : latestNewsBrief.includes("ELEVATED") ? "#ffd93d" : "#333"}">${latestNewsBrief || '<span style="opacity:.4">News scan runs every 3 hours...</span>'}</div>
    <div style="margin-bottom:8px">${hints}</div>
    <form class="hint-form" method="POST" action="/hint">
      <input name="hint" placeholder='e.g. "PLTR looks bullish, iran war catalyst"' autocomplete="off">
      <button type="submit">Send Hint</button>
    </form>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Open Positions (${state.positions.length})</h2>
  <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>DTE</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L</th><th>Profit Target</th><th>Stop Loss</th><th>Greeks / PDT</th></tr>${posRows}</table>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Bot Thinking — Decision Reasoning</h2>
  <div style="font-size:10px;color:#555;margin-bottom:8px">Score 50=neutral · ≥${BULL_ENTRY} buy calls · ≤${BEAR_ENTRY} buy puts · Risk: ${(RISK_PCT*100)}%/trade · TP: +${(PROFIT_TARGET*100)}% · SL: ${(STOP_LOSS*100)}%</div>
  <table><tr><th>Ticker</th><th>Price</th><th>Score (raw→final)</th><th>Decision</th><th>Reasoning</th><th>EMAs (8/21/50)</th><th>Indicators</th></tr>${decisionRows}</table>
</div>

<div class="grid">
  <div class="card">
    <h2>Analysis (${Object.keys(dashboard.analyses).length} tickers)</h2>
    <table><tr><th>Ticker</th><th>Price</th><th>Score</th><th>Signal</th><th>RSI</th><th>ATR%</th><th>Vol Ratio</th></tr>${analysisRows}</table>
  </div>
  <div class="card">
    <h2>Trade History (last 20)</h2>
    <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>${historyRows}</table>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Live Log</h2>
  <div class="log">${logLines || '<span style="opacity:.5">Waiting for first cycle...</span>'}</div>
</div>

</body></html>`;
}

function tickerDetailHTML(sym, state) {
  const candles = dashboard.candles[sym];
  const a = dashboard.analyses[sym];
  const q = dashboard.quotes[sym];
  const dec = dashboard.decisions.find(d => d.ticker === sym);
  const pos = dashboard.positionDetails.find(p => p.ticker === sym);
  const hintBias = getHintBias(sym);
  const hint = activeHints.find(h => h.ticker === sym);

  // Build SVG chart from candles
  let chartSVG = '<div style="color:#555;padding:40px;text-align:center">No candle data available</div>';
  let emaChartSVG = '';
  let volumeSVG = '';

  if (candles && candles.length > 10) {
    const W = 700, H = 250;
    const closes = candles.map(c => c.c);
    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const vols = candles.map(c => c.v);
    const ema8 = calcEMA(closes, 8), ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50);

    const allPrices = [...highs, ...lows];
    const mn = Math.min(...allPrices) * 0.998, mx = Math.max(...allPrices) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 20) - 10;
    const x = i => (i / (closes.length - 1)) * W;

    // Candlestick chart
    const candleBars = candles.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00ff88" : "#ff4444";
      const bw = Math.max(2, W / candles.length - 1);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bot - top);
      return `<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1"/>
        <rect x="${x(i) - bw/2}" y="${top}" width="${bw}" height="${bodyH}" fill="${green ? color : color}" rx="0.5"/>`;
    }).join("");

    // EMA lines
    const emaPath = (arr, color) => arr.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");

    // Price labels on right axis
    const priceLabels = [mn, mn + rng * 0.25, mn + rng * 0.5, mn + rng * 0.75, mx].map(p =>
      `<text x="${W + 5}" y="${y(p)}" fill="#555" font-size="9" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    chartSVG = `<svg viewBox="0 0 ${W + 60} ${H}" style="width:100%;height:${H}px">
      <defs><linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00ff8815"/><stop offset="100%" stop-color="#00ff8802"/></linearGradient></defs>
      ${candleBars}
      <path d="${emaPath(ema8, '#4ecdc4')}" fill="none" stroke="#4ecdc4" stroke-width="1.5" opacity="0.8"/>
      <path d="${emaPath(ema21, '#ff6b35')}" fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>
      <path d="${emaPath(ema50, '#a78bfa')}" fill="none" stroke="#a78bfa" stroke-width="1.5" opacity="0.7"/>
      ${priceLabels}
    </svg>
    <div style="font-size:10px;margin-top:4px;color:#666">
      <span style="color:#4ecdc4">━ EMA 8 (${ema8[ema8.length-1].toFixed(2)})</span> &nbsp;
      <span style="color:#ff6b35">━ EMA 21 (${ema21[ema21.length-1].toFixed(2)})</span> &nbsp;
      <span style="color:#a78bfa">━ EMA 50 (${ema50[ema50.length-1].toFixed(2)})</span>
    </div>`;

    // Volume chart
    const maxV = Math.max(...vols);
    const avgV = vols.reduce((a, b) => a + b, 0) / vols.length;
    const VH = 60;
    const volBars = vols.map((v, i) => {
      const bw = Math.max(2, W / vols.length - 1);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw/2}" y="${VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00ff8850' : '#ffffff18'}" rx="0.5"/>`;
    }).join("");
    volumeSVG = `<svg viewBox="0 0 ${W + 60} ${VH}" style="width:100%;height:${VH}px">
      <line x1="0" y1="${VH - (avgV/maxV)*VH}" x2="${W}" y2="${VH - (avgV/maxV)*VH}" stroke="#ffffff15" stroke-dasharray="3 2"/>
      ${volBars}
    </svg>`;
  }

  // Position info block
  let posBlock = '<div style="color:#555">No position in this ticker</div>';
  if (pos) {
    const color = pos.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    posBlock = `
      <div class="stat"><div class="val">${pos.type.toUpperCase()}</div><div class="lbl">Type</div></div>
      <div class="stat"><div class="val">$${pos.strike}</div><div class="lbl">Strike</div></div>
      <div class="stat"><div class="val">${pos.qty}</div><div class="lbl">Contracts</div></div>
      <div class="stat"><div class="val">${pos.dteLeft.toFixed(1)}d</div><div class="lbl">DTE Left</div></div>
      <div class="stat"><div class="val">$${pos.entryPremium.toFixed(2)}</div><div class="lbl">Entry Premium</div></div>
      <div class="stat"><div class="val">$${pos.curPremium.toFixed(2)}</div><div class="lbl">Current Premium</div></div>
      <div class="stat ${pos.pnlPct >= 0 ? '' : 'neg'}"><div class="val" style="color:${color}">${(pos.pnlPct*100).toFixed(1)}% ($${pos.pnlDollar.toFixed(0)})</div><div class="lbl">P&L</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val" style="color:#00ff88">$${pos.profitTarget.premium}</div><div class="lbl">TP (${pos.profitTarget.pct})</div></div>
      <div class="stat"><div class="val" style="color:#ff4444">$${pos.stopLoss.premium}</div><div class="lbl">SL (${pos.stopLoss.pct})</div></div>
      <div class="stat"><div class="val">${pos.pctToProfit}%</div><div class="lbl">To Profit</div></div>
      <div class="stat"><div class="val">${pos.pctToStop}%</div><div class="lbl">To Stop</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">${pos.greeks.delta}</div><div class="lbl">Delta</div></div>
      <div class="stat"><div class="val">${pos.greeks.theta}</div><div class="lbl">Theta/day</div></div>
      <div class="stat"><div class="val">${pos.pdtStatus}</div><div class="lbl">PDT Status</div></div>`;
  }

  // Decision block
  let decBlock = '';
  if (dec) {
    const actionColor = dec.action === "BUY CALL" ? "#00ff88" : dec.action === "BUY PUT" ? "#ff4444" :
      dec.action === "HOLD" ? "#4ecdc4" : dec.action === "BLOCKED" ? "#ffd93d" : "#666";
    decBlock = `
      <div class="stat"><div class="val">${dec.rawScore ?? '—'}</div><div class="lbl">Raw Score</div></div>
      <div class="stat"><div class="val">${dec.finalScore ?? '—'}</div><div class="lbl">Final Score</div></div>
      <div class="stat"><div class="val" style="color:${actionColor}">${dec.action}</div><div class="lbl">Decision</div></div>
      <div style="margin:8px 0;color:#aaa;font-size:12px">${dec.reason}</div>
      <div style="margin-top:8px">${(dec.signals||[]).map(s => '<div style="color:#888;font-size:11px;padding:2px 0">• ' + s + '</div>').join('')}</div>`;
  }

  // Analysis stats
  let statsBlock = '<div style="color:#555">No analysis data</div>';
  if (a) {
    const sigColor = a.signal === "STRONG BUY" ? "#00ff88" : a.signal === "BUY WATCH" ? "#ffd93d" : a.signal === "NEUTRAL" ? "#888" : a.signal === "SELL WATCH" ? "#ff8c42" : "#ff4444";
    statsBlock = `
      <div class="stat"><div class="val" style="color:${sigColor}">${a.score}</div><div class="lbl">Score</div></div>
      <div class="stat"><div class="val" style="color:${sigColor}">${a.signal}</div><div class="lbl">Signal</div></div>
      <div class="stat"><div class="val">${a.rsi.toFixed(1)}</div><div class="lbl">RSI (14)</div></div>
      <div class="stat"><div class="val">${a.atrPct.toFixed(2)}%</div><div class="lbl">ATR %</div></div>
      <div class="stat"><div class="val">${a.vr.toFixed(2)}</div><div class="lbl">Vol Ratio</div></div>
      <div class="stat"><div class="val">${a.aligned ? "YES" : "NO"}</div><div class="lbl">EMA Aligned</div></div>
      <div class="stat"><div class="val">${a.spread?.toFixed(2) || '—'}%</div><div class="lbl">EMA Spread</div></div>
      <div class="stat"><div class="val">$${a.stop}</div><div class="lbl">ATR Stop</div></div>
      <div class="stat"><div class="val">$${a.t1}</div><div class="lbl">Target 1</div></div>
      <div class="stat"><div class="val">$${a.t2}</div><div class="lbl">Target 2</div></div>
      <div class="stat"><div class="val">${a.rr}x</div><div class="lbl">R:R Ratio</div></div>`;
  }

  const hintBlock = hint
    ? `<div class="hint">${hint.direction} bias ${hint.bias > 0 ? '+' : ''}${hint.bias} — ${hint.reasoning} (expires ${Math.round((hint.expiresAt - Date.now())/60000)}m)</div>`
    : '<span style="color:#555">No active hint for this ticker</span>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${sym} — Swingers Bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:13px;padding:20px}
  h1{color:#00ff88;font-size:20px;margin-bottom:4px}
  a{color:#4ecdc4;text-decoration:none}a:hover{text-decoration:underline}
  .sub{color:#666;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#12121a;border:1px solid #1e1e2e;border-radius:8px;padding:16px}
  .card h2{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:20px;margin-bottom:8px}
  .stat .val{font-size:16px;font-weight:800;color:#00ff88}
  .stat .lbl{font-size:10px;color:#666;text-transform:uppercase}
  .stat.neg .val{color:#ff4444}
  .hint{display:inline-block;background:#a78bfa20;border:1px solid #a78bfa40;border-radius:4px;padding:4px 10px;font-size:11px;color:#a78bfa}
</style></head><body>
<h1><a href="/">← Back</a> &nbsp; ${sym} ${q ? '$' + q.c.toFixed(2) : ''}</h1>
<div class="sub">${pos ? pos.type.toUpperCase() + ' $' + pos.strike + ' | ' + pos.qty + ' contracts' : 'Not currently held'} &nbsp;|&nbsp; Auto-refreshes every 30s</div>

<div class="card" style="margin-bottom:16px">
  <h2>Price Chart (90 days) — Candlesticks + EMAs</h2>
  ${chartSVG}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Volume</h2>
  ${volumeSVG || '<div style="color:#555">No volume data</div>'}
</div>

<div class="grid">
  <div class="card">
    <h2>Analysis & Indicators</h2>
    ${statsBlock}
  </div>
  <div class="card">
    <h2>Bot Decision</h2>
    ${decBlock || '<div style="color:#555">No decision data yet</div>'}
    <hr style="border-color:#1e1e2e;margin:12px 0">
    <h2 style="margin-top:8px">News/Hint Bias</h2>
    ${hintBlock}
  </div>
</div>

${pos ? '<div class="card" style="margin-top:16px"><h2>Position Details</h2>' + posBlock + '</div>' : ''}

</body></html>`;
}

function startDashboard(state) {
  const server = http.createServer(async (req, res) => {
    // Handle hint submission via POST
    if (req.method === "POST" && req.url === "/hint") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const hint = params.get("hint");
        if (hint) {
          fs.writeFileSync(HINT_FILE, hint);
          log(`HINT (via dashboard): "${hint}"`);
        }
        res.writeHead(302, { Location: "/" });
        res.end();
      });
      return;
    }

    // Ticker detail page
    const tickerMatch = req.url.match(/^\/ticker\/([A-Z]+)$/);
    if (tickerMatch) {
      const sym = tickerMatch[1];
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(tickerDetailHTML(sym, state));
      return;
    }

    // JSON API
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        cash: state.cash,
        positions: state.positions,
        history: state.history.slice(-50),
        dayTrades: state.dayTrades,
        quotes: dashboard.quotes,
        analyses: Object.fromEntries(Object.entries(dashboard.analyses).map(([k, v]) => [k, { score: v.score, signal: v.signal, price: v.price, rsi: v.rsi }])),
        activeHints,
        portfolioValue: portfolioValue(state, dashboard.quotes),
        marketOpen: dashboard.marketOpen,
        log: dashboard.cycleLog.slice(-50),
      }));
      return;
    }

    // Dashboard HTML
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHTML(state));
  });

  server.listen(DASH_PORT, () => {
    log(`Dashboard running at http://localhost:${DASH_PORT}`);
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      log(`WARN: Dashboard port ${DASH_PORT} in use, trying ${DASH_PORT + 1}`);
      server.listen(DASH_PORT + 1);
    }
  });
}

// ─── Main Trading Cycle ───

async function runCycle(state, candleCache) {
  log("MARKET OPEN — Starting auto-trade cycle");
  dashboard.marketOpen = true;

  const quotes = {};
  const analyses = {};

  // Fetch quotes for all tickers
  for (const ticker of TICKERS) {
    try {
      quotes[ticker] = await fetchQuote(ticker, state.apiKey);
      await delay(API_DELAY);
    } catch (e) {
      log(`WARN: Failed to fetch quote for ${ticker} — ${e.message}`);
    }
  }

  // Fetch candles if not cached this session
  for (const ticker of TICKERS) {
    if (!candleCache[ticker]) {
      try {
        candleCache[ticker] = await fetchCandles(ticker, state.apiKey);
        await delay(API_DELAY);
      } catch (e) {
        log(`WARN: Failed to fetch candles for ${ticker} — ${e.message}`);
      }
    } else if (quotes[ticker]) {
      // Update latest candle with current quote
      const q = quotes[ticker];
      const last = candleCache[ticker][candleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }

  // Check for new hints from user (via hint.txt)
  await checkHints(state);

  // Auto news scan every 3 hours
  await runNewsScan(state);

  // Run analysis on each ticker (with hint bias applied)
  const decisions = [];
  for (const ticker of TICKERS) {
    const candles = candleCache[ticker];
    if (!candles) { decisions.push({ ticker, action: "SKIP", reason: "No candle data" }); continue; }
    const a = runAnalysis(candles);
    if (!a) { decisions.push({ ticker, action: "SKIP", reason: "Insufficient data (<55 candles)" }); continue; }

    // Apply Claude hint bias
    const hintBias = getHintBias(ticker);
    const rawScore = a.score;
    if (hintBias !== 0) {
      a.score = Math.max(0, Math.min(100, a.score + hintBias));
      a.signal = signalLabel(a.score);
      a.hintBoosted = true;
    }
    analyses[ticker] = a;
    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    log(`${ticker} ${price} | Score: ${a.score} ${a.signal}${hintTag} | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    // Build decision reasoning
    const dec = { ticker, price: q?.c, rawScore, finalScore: a.score, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    const lowCash = state.cash < 200; // effectively no buying power

    // Score: 50 = neutral, >65 = buy calls, <35 = buy puts
    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;
    if (a.score >= BULL_ENTRY) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY CALL"; dec.reason = `Bullish ${a.score}/100 (bull:${a.bullScore} bear:${a.bearScore})`; }
    } else if (a.score <= BEAR_ENTRY) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY PUT"; dec.reason = `Bearish ${a.score}/100 (bull:${a.bullScore} bear:${a.bearScore})`; }
    } else {
      dec.action = "WAIT";
      if (a.score >= 55) dec.reason = `Score ${a.score} — leaning bullish but need ≥${BULL_ENTRY}`;
      else if (a.score >= 45) dec.reason = `Score ${a.score} — neutral, no clear edge`;
      else dec.reason = `Score ${a.score} — leaning bearish but need ≤${BEAR_ENTRY}`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.signals = a.sigs?.map(s => s.text) || [];
    decisions.push(dec);
  }
  dashboard.decisions = decisions;

  // Clean old day trades
  cleanDayTrades(state);

  // Exit logic — profit/loss/DTE exits first
  tryExits(state, quotes);

  // Signal-based exits
  trySignalExits(state, quotes, analyses);

  // Entry logic
  for (const ticker of TICKERS) {
    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;

    const pos = tryEntry(state, ticker, a, q);
    if (pos) {
      log(`TRADE: BUY ${pos.qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pos.dte}d @ $${pos.entryPremium.toFixed(2)} ($${pos.cost.toFixed(0)})`);
    }
  }

  // Build enriched position details for dashboard
  dashboard.positionDetails = state.positions.map(pos => {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const elapsed = (Date.now() - pos.openTime) / 86400_000;
    const dteLeft = Math.max(0, pos.dte - elapsed);
    const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type);
    const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
    const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;
    const profitPrice = pos.entryPremium * (1 + PROFIT_TARGET);
    const stopPrice = pos.entryPremium * (1 + STOP_LOSS);
    const isDayTrade = pos.openDate === getETDateStr();
    const pdtStatus = isDayTrade ? `Day trade (${countRecentDayTrades(state)}/3 used)` : "Swing (not a day trade)";

    return {
      ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
      profitTarget: { pct: `+${(PROFIT_TARGET * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
      stopLoss: { pct: `${(STOP_LOSS * 100).toFixed(0)}%`, premium: stopPrice.toFixed(2) },
      pctToProfit: ((profitPrice - curPremium) / curPremium * 100).toFixed(1),
      pctToStop: ((stopPrice - curPremium) / curPremium * 100).toFixed(1),
      pdtStatus,
      greeks: optGreeks(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type),
    };
  });

  // Summary
  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  const progress = ((pv / GOAL) * 100).toFixed(1);
  log(`Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Goal: ${progress}% of $${GOAL.toLocaleString()} | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | ${countRecentDayTrades(state)}/3 PDT${getActiveHintsSummary()}`);

  // Update dashboard state
  dashboard.quotes = quotes;
  dashboard.analyses = analyses;
  dashboard.candles = candleCache;
  dashboard.lastCycle = Date.now();

  saveState(state);
  return { quotes, analyses, candleCache };
}

// ─── Main Loop ───

async function main() {
  console.log("\n  ╔═══════════════════════════════════════════════╗");
  console.log("  ║  SWINGERS — Auto-Trading Bot v1.0             ║");
  console.log("  ║  $25,000 → $200,000 Challenge · PDT Enforced  ║");
  console.log("  ║  Headless · Finnhub · Aggressive Mode          ║");
  console.log("  ╚═══════════════════════════════════════════════╝\n");

  // Load or initialize state
  let state = loadState() || { ...INIT_STATE };

  // Prompt for API key if missing
  if (!state.apiKey) {
    console.log("  No API key found. Get a free key at https://finnhub.io/\n");
    const key = await prompt("  Enter Finnhub API key: ");
    if (!key) { console.log("  No key provided. Exiting."); process.exit(1); }

    log("Validating API key...");
    const valid = await validateKey(key);
    if (!valid) { console.log("  Invalid API key or connection error. Exiting."); process.exit(1); }

    state.apiKey = key;
    saveState(state);
    log("API key validated and saved.");
  } else {
    log(`Loaded state — Cash: $${state.cash.toFixed(0)} | ${state.positions.length} positions | ${state.history.length} trades`);

    // Revalidate stored key
    log("Validating stored API key...");
    const valid = await validateKey(state.apiKey);
    if (!valid) {
      log("Stored API key is invalid. Please delete state.json and restart.");
      process.exit(1);
    }
    log("API key valid.");
  }

  console.log("");
  log(`Watching: ${TICKERS.join(", ")}`);
  log(`PDT status: ${countRecentDayTrades(state)}/3 day trades in rolling 5 days`);
  log(`Positions: ${state.positions.length} open (no limit — cash-managed)`);
  log(`Claude hints: Write to hint.txt to push the bot in a direction`);
  log(`  e.g. echo "check out PLTR, iran war catalyst" > hint.txt`);
  console.log("");

  // Start web dashboard
  startDashboard(state);

  // Graceful shutdown — save state on exit
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      log(`Received ${sig} — saving state and exiting...`);
      saveState(state);
      process.exit(0);
    });
  }

  let candleCache = {};
  let lastCandleDate = null;
  let lastCycleTime = Date.now();

  // Main loop
  while (true) {
    // Detect sleep/wake gap — if >5 min since last cycle, we likely woke from sleep
    const gap = Date.now() - lastCycleTime;
    if (gap > 5 * 60_000) {
      log(`WAKE DETECTED — ${(gap / 60_000).toFixed(0)}m gap since last cycle. Re-syncing...`);
      candleCache = {}; // Force candle refresh after sleep
    }
    lastCycleTime = Date.now();

    if (isMarketOpen()) {
      // Reset candle cache on new trading day
      const today = getETDateStr();
      if (lastCandleDate !== today) {
        candleCache = {};
        lastCandleDate = today;
      }

      try {
        const result = await runCycle(state, candleCache);
        candleCache = result.candleCache;
      } catch (e) {
        log(`ERROR in cycle: ${e.message}`);
      }

      console.log("");
      await delay(CYCLE_MS);
    } else {
      const et = getETDate();
      const day = et.getDay();
      const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day];
      const time = et.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: true });
      dashboard.marketOpen = false;
      log(`MARKET CLOSED (${dayName} ${time} ET) — Portfolio: $${state.cash.toFixed(0)} cash | ${state.positions.length} open positions`);
      log("Waiting for market hours (Mon-Fri 9:30 AM - 4:00 PM ET)...");

      // Still check hints while market is closed
      await checkHints(state);

      // Sleep longer outside market hours — check every 5 minutes
      await delay(300_000);
    }
  }
}

// ─── Start ───
main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
