import "dotenv/config";
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

// ─── Short-Term Analysis (7-day focus for contract-duration signals) ───

function runShortTermAnalysis(candles) {
  if (!candles || candles.length < 15) return null;

  // Use only last 14 candles (≈2 weeks) — matches 7-day contract horizon
  const recent = candles.slice(-14);
  const closes = recent.map(d => d.c), highs = recent.map(d => d.h), lows = recent.map(d => d.l), volumes = recent.map(d => d.v);
  const L = closes.length - 1, c = closes[L];

  // Fast EMAs: 3/5/8 on the short window
  const ema3 = calcEMA(closes, 3), ema5 = calcEMA(closes, 5), ema8 = calcEMA(closes, 8);
  // Short RSI (5-period)
  const rsi5 = calcRSI(closes, 5);
  const rV = rsi5[rsi5.length - 1] || 50;

  // Momentum: % change over 1d, 3d, 5d, 7d
  const mom1d = L >= 1 ? ((c - closes[L - 1]) / closes[L - 1]) * 100 : 0;
  const mom3d = L >= 3 ? ((c - closes[L - 3]) / closes[L - 3]) * 100 : 0;
  const mom5d = L >= 5 ? ((c - closes[L - 5]) / closes[L - 5]) * 100 : 0;
  const mom7d = L >= 7 ? ((c - closes[L - 7]) / closes[L - 7]) * 100 : 0;

  // Volume trend: last 3 days vs prior 5 days
  const recentV3 = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const priorV5 = volumes.slice(-8, -3).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-8, -3).length);
  const vr = priorV5 > 0 ? recentV3 / priorV5 : 1;

  // Fast EMA alignment
  const aligned = ema3[L] > ema5[L] && ema5[L] > ema8[L];
  const bearish = ema3[L] < ema5[L] && ema5[L] < ema8[L];
  const spread = ((ema3[L] - ema8[L]) / ema8[L]) * 100;

  // Recent high/low range
  const recentHigh = Math.max(...highs.slice(-7));
  const recentLow = Math.min(...lows.slice(-7));
  const range7d = ((recentHigh - recentLow) / recentLow) * 100;
  const nearHigh = c >= recentHigh * 0.995;
  const nearLow = c <= recentLow * 1.005;

  // Trend structure over last 7 days
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = Math.max(0, L - 6); i < L; i++) {
    if (highs[i + 1] > highs[i]) hh++; else lh++;
    if (lows[i + 1] > lows[i]) hl++; else ll++;
  }

  const sigs = [];

  // ─── Short-term Bull Score ───
  let bull = 0;
  if (aligned) { bull += 20; sigs.push({ t: "bull", text: "Fast EMA aligned (3>5>8)" }); }
  const xover = ema3[L] > ema5[L] && L >= 2 && ema3[L - 2] <= ema5[L - 2];
  if (xover) { bull += 20; sigs.push({ t: "bull", text: "Fresh 3/5 EMA bullish crossover" }); }
  if (mom3d > 1.5) { bull += 15; sigs.push({ t: "bull", text: `3-day momentum +${mom3d.toFixed(1)}%` }); }
  else if (mom3d > 0.5) { bull += 8; sigs.push({ t: "bull", text: `3-day momentum +${mom3d.toFixed(1)}%` }); }
  if (mom7d > 3) { bull += 10; sigs.push({ t: "bull", text: `7-day momentum +${mom7d.toFixed(1)}%` }); }
  if (nearHigh && vr > 1.1) { bull += 15; sigs.push({ t: "bull", text: "Near 7d high on expanding volume" }); }
  if (rV <= 25) { bull += 10; sigs.push({ t: "bull", text: `RSI(5) ${rV.toFixed(0)} — oversold bounce setup` }); }
  if (rV > 55 && rV < 75 && aligned) { bull += 10; sigs.push({ t: "bull", text: `RSI(5) ${rV.toFixed(0)} — strong momentum` }); }
  const upTrend = ((hh + hl) / 12) * 100;
  if (upTrend > 65) { bull += 10; sigs.push({ t: "bull", text: `7d uptrend ${upTrend.toFixed(0)}%` }); }

  // ─── Short-term Bear Score ───
  let bear = 0;
  if (bearish) { bear += 20; sigs.push({ t: "bear", text: "Fast EMA bearish (3<5<8)" }); }
  const xoverBear = ema3[L] < ema5[L] && L >= 2 && ema3[L - 2] >= ema5[L - 2];
  if (xoverBear) { bear += 20; sigs.push({ t: "bear", text: "Fresh 3/5 EMA bearish crossover" }); }
  if (mom3d < -1.5) { bear += 15; sigs.push({ t: "bear", text: `3-day momentum ${mom3d.toFixed(1)}%` }); }
  else if (mom3d < -0.5) { bear += 8; sigs.push({ t: "bear", text: `3-day momentum ${mom3d.toFixed(1)}%` }); }
  if (mom7d < -3) { bear += 10; sigs.push({ t: "bear", text: `7-day momentum ${mom7d.toFixed(1)}%` }); }
  if (nearLow && vr > 1.1) { bear += 15; sigs.push({ t: "bear", text: "Near 7d low on expanding volume" }); }
  if (rV >= 75) { bear += 10; sigs.push({ t: "bear", text: `RSI(5) ${rV.toFixed(0)} — overbought reversal setup` }); }
  if (rV < 45 && rV > 25 && bearish) { bear += 10; sigs.push({ t: "bear", text: `RSI(5) ${rV.toFixed(0)} — bearish pressure` }); }
  const dnTrend = ((lh + ll) / 12) * 100;
  if (dnTrend > 65) { bear += 10; sigs.push({ t: "bear", text: `7d downtrend ${dnTrend.toFixed(0)}%` }); }

  bull = Math.max(0, Math.min(100, bull));
  bear = Math.max(0, Math.min(100, bear));
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
    ema3v: ema3[L], ema5v: ema5[L], ema8v: ema8[L],
    aligned, bearish, spread, rsi: rV,
    mom1d, mom3d, mom5d, mom7d,
    vr, range7d, nearHigh, nearLow,
    recentHigh, recentLow,
  };
}

// ─── Blended Score (60% short-term, 40% long-term) ───

function blendScores(longTerm, shortTerm) {
  if (!shortTerm) return longTerm;
  if (!longTerm) return shortTerm;
  const blended = Math.round(shortTerm.score * 0.6 + longTerm.score * 0.4);
  return {
    score: blended,
    signal: blended >= 70 ? "STRONG BUY" : blended >= 55 ? "BUY WATCH" : blended >= 45 ? "NEUTRAL" : blended >= 30 ? "SELL WATCH" : "STRONG SELL",
    longTerm, shortTerm,
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
const BASE_RISK_PCT = 0.15;    // 15% of portfolio per trade — adjusted by market regime
let RISK_PCT = BASE_RISK_PCT;  // Dynamic — scaled by regime
const PROFIT_TARGET = 0.40;    // Take profits at +40% (compound faster)
const STOP_LOSS = -0.35;       // Wider stop to avoid premature exits on volatile plays
const DEFAULT_IV = 0.30;
const BULL_ENTRY = 65;         // Buy calls when score >= 65 (bullish)
const BEAR_ENTRY = 35;         // Buy puts when score <= 35 (bearish)

// ─── Trimming & EOD/EOW Constants ───
const TRIM_1_PCT = 0.25;       // First trim at +25% profit
const TRIM_2_PCT = 0.50;       // Second trim at +50% profit
const EOD_FREEZE_HOUR = 15;    // No new entries after 3:00 PM ET
const EOD_TIGHTEN_HOUR = 15.5; // Tighten stops after 3:30 PM ET
const EOW_TRIM_HOUR = 14;      // Friday profit-taking starts at 2:00 PM ET
const LOW_DTE_THRESHOLD = 3;   // Accelerate exits when DTE <= 3
const CRITICAL_DTE = 2;        // Force-close when DTE <= 2

const STARTING_CASH = 25_000;
const GOAL = 200_000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
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
  } catch { }
}

// ─── Market Regime (SPY/QQQ EMA health) ───

let currentRegime = { mode: "unknown", riskScale: 1.0, label: "UNKNOWN" };

function getMarketRegime(candleCache) {
  const spyCandles = candleCache["SPY"];
  const qqqCandles = candleCache["QQQ"];
  if (!spyCandles || !qqqCandles || spyCandles.length < 55 || qqqCandles.length < 55) {
    return { mode: "unknown", riskScale: 0.5, label: "UNKNOWN (no data)", spyAbove: null, qqqAbove: null };
  }

  function checkAboveEMAs(candles) {
    const closes = candles.map(d => d.c);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const L = closes.length - 1;
    const c = closes[L];
    const above8 = c > ema8[L];
    const above21 = c > ema21[L];
    const above50 = c > ema50[L];
    const aligned = ema8[L] > ema21[L] && ema21[L] > ema50[L];
    return { above8, above21, above50, aligned, allAbove: above8 && above21 && above50 };
  }

  const spy = checkAboveEMAs(spyCandles);
  const qqq = checkAboveEMAs(qqqCandles);

  let mode, riskScale, label;
  if (spy.allAbove && qqq.allAbove) {
    mode = "risk-on";
    riskScale = 1.0;
    label = "RISK-ON — SPY+QQQ above all EMAs, full conviction";
  } else if (spy.allAbove || qqq.allAbove) {
    mode = "cautious";
    riskScale = 0.5;
    label = `CAUTIOUS — ${spy.allAbove ? 'SPY' : 'QQQ'} strong, ${spy.allAbove ? 'QQQ' : 'SPY'} mixed`;
  } else if (spy.above50 && qqq.above50) {
    mode = "choppy";
    riskScale = 0.35;
    label = "CHOPPY — above 50 EMA but EMA stack broken";
  } else {
    mode = "risk-off";
    riskScale = 0.25;
    label = "RISK-OFF — below key EMAs, reduce exposure";
  }

  return { mode, riskScale, label, spyAbove: spy, qqqAbove: qqq };
}

// ─── Earnings Calendar Check (Finnhub) ───

async function checkEarnings(ticker, apiKey) {
  try {
    const now = getETDate();
    const from = now.toISOString().slice(0, 10);
    const futureDate = new Date(now.getTime() + 4 * 86400_000); // 4 days out
    const to = futureDate.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${apiKey}`);
    if (!r.ok) return { hasEarnings: false, daysUntil: null };
    const data = await r.json();
    const earnings = data.earningsCalendar || [];
    if (earnings.length === 0) return { hasEarnings: false, daysUntil: null };
    const nextEarning = earnings[0];
    const earningDate = new Date(nextEarning.date);
    const daysUntil = Math.ceil((earningDate - now) / 86400_000);
    return { hasEarnings: daysUntil <= 3, daysUntil, date: nextEarning.date };
  } catch {
    return { hasEarnings: false, daysUntil: null };
  }
}

// ─── Consolidation / Tightness Detection (SRxTrades "staircase" setup quality) ───

function detectConsolidation(candles) {
  if (!candles || candles.length < 20) return { quality: 0, tight: false };

  const recent = candles.slice(-10);
  const closes = recent.map(d => d.c);
  const highs = recent.map(d => d.h);
  const lows = recent.map(d => d.l);
  const volumes = recent.map(d => d.v);

  // 1. Range tightness: how narrow is the price range over last 10 candles?
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;
  // Tighter range = higher score. Sweet spot: 2-5% range
  let tightnessScore = 0;
  if (rangePct < 3) tightnessScore = 30;
  else if (rangePct < 5) tightnessScore = 25;
  else if (rangePct < 8) tightnessScore = 15;
  else if (rangePct < 12) tightnessScore = 5;

  // 2. Volume declining during consolidation (coiled spring)
  const firstHalfVol = volumes.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const secondHalfVol = volumes.slice(5).reduce((a, b) => a + b, 0) / 5;
  let volDeclineScore = 0;
  if (firstHalfVol > 0) {
    const volRatio = secondHalfVol / firstHalfVol;
    if (volRatio < 0.7) volDeclineScore = 25;      // Strong volume decline
    else if (volRatio < 0.85) volDeclineScore = 15;  // Moderate decline
    else if (volRatio < 1.0) volDeclineScore = 8;    // Slight decline
  }

  // 3. Price above moving averages during base
  const allCandles = candles;
  const allCloses = allCandles.map(d => d.c);
  const ema8 = calcEMA(allCloses, 8);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;
  const price = allCloses[L];
  let emaScore = 0;
  if (price > ema8[L] && price > ema21[L] && price > ema50[L]) emaScore = 25;
  else if (price > ema21[L] && price > ema50[L]) emaScore = 15;
  else if (price > ema50[L]) emaScore = 8;

  // 4. Breakout detection: latest close near/above range high with volume expansion
  const latestVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  let breakoutScore = 0;
  if (price >= rangeHigh * 0.995 && latestVol > avgVol * 1.3) {
    breakoutScore = 20; // Breaking out of consolidation on volume!
  } else if (price >= rangeHigh * 0.99) {
    breakoutScore = 10; // Near breakout level
  }

  const quality = Math.min(100, tightnessScore + volDeclineScore + emaScore + breakoutScore);
  return {
    quality,
    tight: rangePct < 8,
    rangePct: rangePct.toFixed(1),
    volDeclining: secondHalfVol < firstHalfVol * 0.85,
    aboveEMAs: emaScore >= 15,
    breakingOut: breakoutScore >= 15,
    components: { tightnessScore, volDeclineScore, emaScore, breakoutScore },
  };
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
  } catch { }

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

// ─── Claude API Usage Tracking ───
let claudeCallCount = 0;
let claudeTotalInputTokens = 0;
let claudeTotalOutputTokens = 0;
const HAIKU_INPUT_COST = 1.00 / 1_000_000;   // $1.00 per 1M input tokens
const HAIKU_OUTPUT_COST = 5.00 / 1_000_000;  // $5.00 per 1M output tokens

function getClaudeCost() {
  return (claudeTotalInputTokens * HAIKU_INPUT_COST + claudeTotalOutputTokens * HAIKU_OUTPUT_COST);
}

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
  claudeCallCount++;
  if (data.usage) {
    claudeTotalInputTokens += data.usage.input_tokens || 0;
    claudeTotalOutputTokens += data.usage.output_tokens || 0;
  }
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
  } catch { }

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
    } catch { }
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

// ─── Claude Pre-Entry Validation ───

async function validateEntryWithClaude(ticker, quote, analysis, setupQuality, earningsInfo, regime) {
  const prompt = `You are a trading bot's risk management system. Evaluate this potential options trade:

Ticker: ${ticker}
Price: $${quote.c.toFixed(2)}
Direction: ${analysis.score >= BULL_ENTRY ? 'BULLISH (buying calls)' : 'BEARISH (buying puts)'}
Technical Score: ${analysis.score}/100
RSI: ${analysis.rsi?.toFixed(1) || 'N/A'}
EMA Stack: ${analysis.aligned ? 'Aligned bullish (8>21>50)' : analysis.bearish ? 'Aligned bearish' : 'Mixed'}
Setup Quality: ${setupQuality.quality}/100 (${setupQuality.tight ? 'tight base' : 'wide range'}, ${setupQuality.breakingOut ? 'breaking out' : 'no breakout'}, vol ${setupQuality.volDeclining ? 'declining' : 'not declining'})
Market Regime: ${regime.label}
${earningsInfo.hasEarnings ? `⚠️ EARNINGS in ${earningsInfo.daysUntil} days (${earningsInfo.date})` : 'No upcoming earnings within 3 days'}
Contract: 7DTE options, 1 strike OTM

Evaluate:
1. Is this a quality setup (consolidation→breakout) or chasing an extended move?
2. Any obvious risks for holding this 7-day options contract?
3. Is the sector/theme strong enough to support this swing?

Respond with ONLY valid JSON (no markdown, no backticks):
{"approve": true, "confidence": 75, "concerns": [], "suggestion": "brief advice"}`;

  try {
    const raw = await callClaude(prompt);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    log(`CLAUDE VALIDATE WARN: Parse failed — ${e.message}. Defaulting to approve.`);
    return { approve: true, confidence: 50, concerns: ["validation parse failed"], suggestion: "proceeding with caution" };
  }
}

// ─── Entry Logic (enhanced with setup quality, EOD freeze, Claude validation) ───

async function tryEntry(state, ticker, analysis, quote, candleCache, regime) {
  if (state.positions.some(p => p.ticker === ticker)) return null;
  if (state.cash < 200) return null;

  // EOD entry freeze — no new positions after 3:00 PM ET (except very strong signals)
  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  if (etHour >= EOD_FREEZE_HOUR && analysis.score < 80 && analysis.score > 20) {
    return { skipped: true, reason: `EOD freeze (${etHour.toFixed(1)} >= ${EOD_FREEZE_HOUR}h, score ${analysis.score} not extreme enough)` };
  }

  // Setup quality check — require minimum consolidation quality
  const setupQuality = detectConsolidation(candleCache[ticker]);
  if (setupQuality.quality < 30) {
    return { skipped: true, reason: `Low setup quality ${setupQuality.quality}/100 (range ${setupQuality.rangePct}%, need consolidation→breakout)` };
  }

  // Earnings check — don't enter within 3 days of earnings
  let earningsInfo = { hasEarnings: false, daysUntil: null };
  try {
    earningsInfo = await checkEarnings(ticker, state.apiKey);
    await delay(API_DELAY);
  } catch { }
  if (earningsInfo.hasEarnings) {
    return { skipped: true, reason: `Earnings in ${earningsInfo.daysUntil} days (${earningsInfo.date}) — too risky for 7DTE options` };
  }

  // Claude pre-entry validation
  let claudeResult = { approve: true, confidence: 70, concerns: [], suggestion: "" };
  try {
    claudeResult = await validateEntryWithClaude(ticker, quote, analysis, setupQuality, earningsInfo, regime);
    log(`CLAUDE VALIDATE ${ticker}: ${claudeResult.approve ? '✓ APPROVED' : '✗ REJECTED'} (${claudeResult.confidence}%) — ${claudeResult.suggestion}${claudeResult.concerns.length ? ' | Concerns: ' + claudeResult.concerns.join(', ') : ''}`);
  } catch (e) {
    log(`CLAUDE VALIDATE ${ticker}: Error — ${e.message}, proceeding anyway`);
  }

  if (!claudeResult.approve) {
    return { skipped: true, reason: `Claude rejected: ${claudeResult.suggestion} (${claudeResult.concerns.join(', ')})` };
  }

  const spot = quote.c;
  const maxRisk = state.cash * RISK_PCT;

  let type, strike, dte;

  if (analysis.score >= BULL_ENTRY) {
    type = "call";
    const atm = Math.round(spot / 5) * 5;
    strike = atm + 5;
    dte = 7;
  } else if (analysis.score <= BEAR_ENTRY) {
    type = "put";
    const atm = Math.round(spot / 5) * 5;
    strike = atm - 5;
    dte = 7;
  } else {
    return null;
  }

  const premium = optPrice(spot, strike, dte, DEFAULT_IV, type);
  const costPer = premium * 100;
  let qty = Math.max(1, Math.floor(maxRisk / costPer));
  let totalCost = qty * costPer;

  if (costPer > state.cash) return null;
  if (totalCost > state.cash) { qty = Math.floor(state.cash / costPer); totalCost = qty * costPer; }

  const position = {
    ticker, type, strike, dte,
    dteRemaining: dte,
    entryPremium: premium,
    entrySpot: spot,
    qty,
    originalQty: qty,    // Track original size for trimming
    cost: totalCost,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,         // 0=none, 1=first trim, 2=second, 3=third, 4=fully closed
    bestPnlPct: 0,        // Track high-water mark for trailing stops
    claudeConfidence: claudeResult.confidence,
    setupQuality: setupQuality.quality,
  };

  state.cash -= totalCost;
  state.positions.push(position);

  return position;
}

// ─── Exit Logic (with trimming support) ───

function closePosition(state, pos, currentPremium, reason, qtyToClose) {
  const qty = qtyToClose || pos.qty;
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
  const pnlDollar = (currentPremium - pos.entryPremium) * qty * 100;

  if (!canClosePDT(state, pos)) {
    const used = countRecentDayTrades(state);
    log(`PDT BLOCKED: Cannot close ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} — ${used}/3 day trades used`);
    return null;
  }

  const proceeds = currentPremium * qty * 100;
  state.cash += proceeds;
  recordDayTrade(state, pos);

  const dtUsed = countRecentDayTrades(state);
  const trade = { ...pos, qty: qty, closePremium: currentPremium, pnlDollar, pnlPct, reason };
  logTrade(trade);

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(`${trimLabel}: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);
  if (wouldBeDayTrade(pos)) {
    log(`PDT CHECK: ${dtUsed}/3 day trades used (rolling 5 days)`);
  }

  return trade;
}

function tryExits(state, quotes, candleCache) {
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const elapsed = (Date.now() - pos.openTime) / (86400_000);
    pos.dteRemaining = Math.max(0, pos.dte - elapsed);

    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;

    // Track high-water mark
    if (!pos.bestPnlPct) pos.bestPnlPct = 0;
    if (pnlPct > pos.bestPnlPct) pos.bestPnlPct = pnlPct;
    if (!pos.trimLevel) pos.trimLevel = 0;
    if (!pos.originalQty) pos.originalQty = pos.qty;

    let reason = null;
    let fullClose = false;

    // === Critical DTE — force close everything at DTE <= 2 ===
    if (pos.dteRemaining <= CRITICAL_DTE) {
      reason = `DTE critical (${pos.dteRemaining.toFixed(1)}d remaining)`;
      fullClose = true;
    }
    // === Stop loss — always full close ===
    else if (pnlPct <= STOP_LOSS) {
      reason = `stop loss ${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    // === DTE expiring soon — full close ===
    else if (pos.dteRemaining <= 1) {
      reason = "DTE expiring";
      fullClose = true;
    }
    // === Profit target hit — full close on remaining ===
    else if (pnlPct >= PROFIT_TARGET) {
      reason = `profit target +${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    // === TRIMMING STRATEGY (SRxTrades 1/4th exits) ===
    else if (pos.trimLevel === 0 && pnlPct >= TRIM_1_PCT) {
      // First trim: sell 25% at +25%, move stop to breakeven
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(state, pos, currentPremium, `trim 1 (+${(pnlPct * 100).toFixed(0)}%, locking gains)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 1;
          log(`TRIM STRATEGY: ${pos.ticker} — sold ${trimQty}/${pos.originalQty}, stop moved to breakeven`);
        }
      }
      remaining.push(pos);
      continue;
    }
    else if (pos.trimLevel === 1 && pnlPct >= TRIM_2_PCT) {
      // Second trim: sell another 25% at +50%
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(state, pos, currentPremium, `trim 2 (+${(pnlPct * 100).toFixed(0)}%, trailing EMAs)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 2;
          log(`TRIM STRATEGY: ${pos.ticker} — sold ${trimQty} more, trailing with 8 EMA`);
        }
      }
      remaining.push(pos);
      continue;
    }
    // After trim 1, stop loss moves to breakeven
    else if (pos.trimLevel >= 1 && pnlPct <= 0) {
      reason = `breakeven stop (post-trim, was +${(pos.bestPnlPct * 100).toFixed(0)}%)`;
      fullClose = true;
    }
    // After trim 2, trail with 15% profit floor
    else if (pos.trimLevel >= 2 && pnlPct <= 0.15) {
      reason = `trailing stop (post-trim2, locked +15%)`;
      fullClose = true;
    }

    if (!reason) { remaining.push(pos); continue; }

    if (fullClose) {
      const trade = closePosition(state, pos, currentPremium, reason);
      if (trade) {
        closed.push(trade);
      } else {
        remaining.push(pos); // PDT blocked
      }
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
    if (pos.type === "call" && a.score <= BEAR_ENTRY) reversed = true;
    if (pos.type === "put" && a.score >= BULL_ENTRY) reversed = true;

    if (!reversed) { remaining.push(pos); continue; }

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);

    const trade = closePosition(state, pos, currentPremium, "signal reversed");
    if (trade) {
      closed.push(trade);
    } else {
      remaining.push(pos); // PDT blocked
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── EOD / EOW Theta-Aware Exits ───

function tryTimeBasedExits(state, quotes) {
  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  const dayOfWeek = et.getDay(); // 0=Sun, 5=Fri
  const isFriday = dayOfWeek === 5;

  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    let reason = null;

    // Friday afternoon: close profitable positions to avoid weekend theta crush
    if (isFriday && etHour >= EOW_TRIM_HOUR) {
      if (pnlPct >= 0.20) {
        reason = `EOW profit lock +${(pnlPct * 100).toFixed(0)}% (Fri ${etHour.toFixed(1)}h, avoid weekend theta)`;
      } else if (pos.dteRemaining <= CRITICAL_DTE) {
        reason = `EOW + low DTE (${pos.dteRemaining.toFixed(1)}d, Fri close)`;
      }
    }

    // Last hour: tighten stops on profitable positions to protect gains overnight
    if (!reason && etHour >= EOD_TIGHTEN_HOUR) {
      if (pnlPct >= 0.10 && pos.trimLevel === 0) {
        // Profitable but untrimmed — lock it in before close
        reason = `EOD lock +${(pnlPct * 100).toFixed(0)}% (3:30 PM tighten, protecting overnight)`;
      }
    }

    // Low DTE acceleration: when DTE <= 3, lower profit target
    if (!reason && pos.dteRemaining <= LOW_DTE_THRESHOLD && pnlPct >= 0.20) {
      reason = `low DTE accelerated exit +${(pnlPct * 100).toFixed(0)}% (${pos.dteRemaining.toFixed(1)}d left, theta accelerating)`;
    }

    if (!reason) { remaining.push(pos); continue; }

    const trade = closePosition(state, pos, currentPremium, reason);
    if (trade) {
      closed.push(trade);
    } else {
      remaining.push(pos);
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── EMA Trailing Exits (trim 3 & 4 — SRxTrades 8/21 EMA trail) ───

function tryEMATrailingExits(state, quotes, candleCache) {
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if ((pos.trimLevel || 0) < 2) { remaining.push(pos); continue; } // Only for positions past trim 2

    const candles = candleCache[pos.ticker];
    if (!candles || candles.length < 22) { remaining.push(pos); continue; }

    const closes = candles.map(d => d.c);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const L = closes.length - 1;
    const price = closes[L];

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = optPrice(spot, pos.strike, pos.dteRemaining, DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    let reason = null;

    // For calls: bearish when price closes below EMA
    // For puts: bullish when price closes above EMA (trend reversing against us)
    const below8 = pos.type === "call" ? price < ema8[L] : price > ema8[L];
    const below21 = pos.type === "call" ? price < ema21[L] : price > ema21[L];

    if (pos.trimLevel === 2 && below8) {
      // Third trim: price broke 8 EMA
      const trimQty = Math.max(1, Math.floor((pos.originalQty || pos.qty) * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(state, pos, currentPremium, `8 EMA break (trim 3, trailing 21 EMA with remainder)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 3;
          log(`EMA TRAIL: ${pos.ticker} broke 8 EMA — sold ${trimQty}, trailing 21 EMA with ${pos.qty} left`);
        }
      }
      remaining.push(pos);
      continue;
    }

    if (pos.trimLevel === 3 && below21) {
      // Final exit: price broke 21 EMA
      reason = "21 EMA break (final exit per SRxTrades trail)";
    }

    if (reason) {
      const trade = closePosition(state, pos, currentPremium, reason);
      if (trade) {
        closed.push(trade);
      } else {
        remaining.push(pos);
      }
    } else {
      remaining.push(pos);
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
  shortTermAnalyses: {},  // 7-day focused analysis
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

  // Build position details on-the-fly if no cycle has run yet
  let posSource = dashboard.positionDetails;
  if (posSource.length === 0 && state.positions.length > 0) {
    posSource = state.positions.map(pos => {
      const q = dashboard.quotes[pos.ticker];
      const spot = q ? q.c : pos.entrySpot;
      const elapsed = (Date.now() - pos.openTime) / 86400_000;
      const dteLeft = Math.max(0, pos.dte - elapsed);
      const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type);
      const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
      const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;
      const profitPrice = pos.entryPremium * (1 + PROFIT_TARGET);
      const stopPrice = pos.entryPremium * (1 + STOP_LOSS);
      const isDayTrade = pos.openDate === getETDateStr();
      const pdtStatus = isDayTrade ? `Day trade (${dtCount}/3 used)` : "Swing (not a day trade)";
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
  }

  const posRows = posSource.length > 0 ? posSource.map(p => {
    const color = p.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    const q = dashboard.quotes[p.ticker];
    const spotChg = q && q.d != null ? q.d : 0;
    const spotChgPct = q && q.dp != null ? q.dp : 0;
    const spotColor = spotChg >= 0 ? "#00ff88" : "#ff4444";
    const spotFromEntry = p.spot && p.entrySpot ? ((p.spot - p.entrySpot) / p.entrySpot * 100) : 0;
    const spotFromEntryColor = spotFromEntry >= 0 ? "#00ff88" : "#ff4444";
    return `<tr>
      <td><a href="/ticker/${p.ticker}"><b>${p.ticker}</b></a></td><td>${p.type.toUpperCase()}</td><td>$${p.strike}</td>
      <td style="white-space:nowrap">$${p.spot.toFixed(2)}<br><span style="color:${spotColor};font-size:10px">${spotChg >= 0 ? "+" : ""}${spotChg.toFixed(2)} (${spotChgPct >= 0 ? "+" : ""}${spotChgPct.toFixed(1)}%)</span><br><span style="color:${spotFromEntryColor};font-size:10px">from entry: ${spotFromEntry >= 0 ? "+" : ""}${spotFromEntry.toFixed(1)}%</span></td>
      <td>${p.dteLeft.toFixed(1)}d</td><td>${p.qty}</td>
      <td>$${p.entryPremium.toFixed(2)}</td><td>$${p.curPremium.toFixed(2)}</td>
      <td style="color:${color}">${p.pnlPct >= 0 ? "+" : ""}${(p.pnlPct * 100).toFixed(1)}% ($${p.pnlDollar.toFixed(0)})</td>
      <td><span style="color:#00ff88">TP $${p.profitTarget.premium}</span> (${p.pctToProfit}% away)</td>
      <td><span style="color:#ff4444">SL $${p.stopLoss.premium}</span> (${p.pctToStop}% away)</td>
      <td style="font-size:10px;color:#888">δ${p.greeks.delta} θ${p.greeks.theta}<br>${p.pdtStatus}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="12" style="opacity:.5">No open positions</td></tr>';

  // Decision reasoning panel
  const decisionRows = dashboard.decisions.map(d => {
    const actionColor = d.action === "BUY CALL" ? "#00ff88" : d.action === "BUY PUT" ? "#ff4444" :
      d.action === "HOLD" ? "#4ecdc4" : d.action === "BLOCKED" ? "#ffd93d" : "#666";
    const hintStr = d.hintBias ? ` <span style="color:#a78bfa">${d.hintBias > 0 ? "+" : ""}${d.hintBias}</span>` : "";
    const stColor = d.shortTermScore != null ? (d.shortTermScore >= 55 ? "#00ff88" : d.shortTermScore >= 45 ? "#888" : "#ff4444") : "#555";
    const ltColor = d.longTermScore != null ? (d.longTermScore >= 55 ? "#00ff88" : d.longTermScore >= 45 ? "#888" : "#ff4444") : "#555";
    const mc = v => v > 0 ? "#00ff88" : v < 0 ? "#ff4444" : "#888";
    return `<tr>
      <td><a href="/ticker/${d.ticker}"><b>${d.ticker}</b></a></td>
      <td>${d.price ? "$" + d.price.toFixed(2) : "—"}</td>
      <td><span style="color:${stColor}">${d.shortTermScore ?? "—"}</span>/<span style="color:${ltColor}">${d.longTermScore ?? "—"}</span>${hintStr} → <b>${d.finalScore ?? "—"}</b></td>
      <td style="color:${actionColor}"><b>${d.action}</b></td>
      <td style="font-size:11px">${d.reason || "—"}</td>
      <td style="font-size:10px;color:#888">${d.ema8 ? `8:${d.ema8} 21:${d.ema21} 50:${d.ema50}` : "—"}</td>
      <td style="font-size:10px;color:#888">${d.stEma3 ? `3:${d.stEma3} 5:${d.stEma5} 8:${d.stEma8}` : "—"}</td>
      <td style="font-size:10px;color:#888">${d.rsi ? `RSI14:${d.rsi} RSI5:${d.stRsi ?? "—"} ATR:${d.atrPct}% VR:${d.vr}` : "—"}</td>
      <td style="font-size:10px">${d.mom1d != null ? `<span style="color:${mc(+d.mom1d)}">1d:${d.mom1d}%</span> <span style="color:${mc(+d.mom3d)}">3d:${d.mom3d}%</span> <span style="color:${mc(+d.mom7d)}">7d:${d.mom7d}%</span>` : "—"}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="9" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const analysisRows = Object.entries(dashboard.analyses).map(([ticker, a]) => {
    const q = dashboard.quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "—";
    const ahPrice = q && q.dp !== undefined ? `<span style="color:${q.d >= 0 ? '#00ff88' : '#ff4444'};font-size:10px">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2) ?? ''} (${q.dp?.toFixed(1) ?? ''}%)</span>` : "";
    const st = dashboard.shortTermAnalyses[ticker];
    const sigColor = a.signal === "STRONG BUY" ? "#00ff88" : a.signal === "BUY WATCH" ? "#ffd93d" : a.signal === "NEUTRAL" ? "#888" : a.signal === "SELL WATCH" ? "#ff8c42" : "#ff4444";
    const stColor = st ? (st.score >= 65 ? "#00ff88" : st.score >= 55 ? "#ffd93d" : st.score >= 45 ? "#888" : st.score >= 35 ? "#ff8c42" : "#ff4444") : "#555";
    const hintBias = getHintBias(ticker);
    const hintTag = hintBias !== 0 ? ` <span style="color:#a78bfa">[${hintBias > 0 ? "+" : ""}${hintBias}]</span>` : "";
    const momStr = st ? `<span style="color:${st.mom1d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(1)}%</span>` : "—";
    return `<tr><td><a href="/ticker/${ticker}">${ticker}</a></td><td>${price} ${ahPrice}</td>
      <td><b style="color:${sigColor}">${a.score}</b></td>
      <td style="color:${stColor}">${st ? st.score : '—'}</td>
      <td style="color:${sigColor}">${a.signal}${hintTag}</td>
      <td>${a.rsi.toFixed(0)}</td><td>${st ? st.rsi.toFixed(0) : '—'}</td><td>${momStr}</td><td>${a.atrPct.toFixed(1)}%</td><td>${a.vr.toFixed(2)}</td></tr>`;
  }).join("") || '<tr><td colspan="10" style="opacity:.5">Waiting for first cycle...</td></tr>';

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
  .flash{animation:flash .4s}
  @keyframes flash{0%{background:#ffffff15}100%{background:transparent}}
</style></head><body>
<h1>SWINGERS Auto-Trading Bot</h1>
<div class="sub">$25K → $200K Challenge &nbsp;|&nbsp; <span class="market-badge ${dashboard.marketOpen ? "open" : "closed"}" id="mkt-badge">${dashboard.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span> &nbsp;|&nbsp; <span id="live-indicator" style="color:#00ff88">LIVE</span> updates every 5s &nbsp;|&nbsp; <span id="pv-header">$${pv.toFixed(0)}</span> <span id="pnl-header" style="color:${pnlPct >= 0 ? '#00ff88' : '#ff4444'}">(${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</span> &nbsp;|&nbsp; <span style="color:${currentRegime.mode === 'risk-on' ? '#00ff88' : currentRegime.mode === 'cautious' ? '#ffd93d' : '#ff4444'};font-size:10px">${currentRegime.mode.toUpperCase()}</span> &nbsp;|&nbsp; <span style="color:#a78bfa;font-size:10px" title="Claude Haiku 4.5 API calls this session">🤖 ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span></div>

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
  <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Stock Price</th><th>DTE</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L</th><th>Profit Target</th><th>Stop Loss</th><th>Greeks / PDT</th></tr>${posRows}</table>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Bot Thinking — Decision Reasoning</h2>
  <div style="font-size:10px;color:#555;margin-bottom:8px">Score 50=neutral · ≥${BULL_ENTRY} buy calls · ≤${BEAR_ENTRY} buy puts · Risk: ${(RISK_PCT * 100)}%/trade · TP: +${(PROFIT_TARGET * 100)}% · SL: ${(STOP_LOSS * 100)}%</div>
  <table><tr><th>Ticker</th><th>Price</th><th>Score (7d/90d→blend→final)</th><th>Decision</th><th>Reasoning</th><th>EMAs (8/21/50)</th><th>7d EMAs (3/5/8)</th><th>Indicators</th><th>Momentum</th></tr>${decisionRows}</table>
</div>

<div class="grid">
  <div class="card">
    <h2>Analysis (${Object.keys(dashboard.analyses).length} tickers)</h2>
    <table><tr><th>Ticker</th><th>Price</th><th>Score</th><th>7d</th><th>Signal</th><th>RSI(14)</th><th>RSI(5)</th><th>1d Mom</th><th>ATR%</th><th>Vol Ratio</th></tr>${analysisRows}</table>
  </div>
  <div class="card">
    <h2>Trade History (last 20)</h2>
    <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>${historyRows}</table>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Live Log</h2>
  <div class="log" id="live-log">${logLines || '<span style="opacity:.5">Waiting for first cycle...</span>'}</div>
</div>

<script>
let prevPrices = {};
async function pollLive() {
  try {
    const r = await fetch('/api/live');
    const d = await r.json();
    // Update header
    const pvEl = document.getElementById('pv-header');
    const pnlEl = document.getElementById('pnl-header');
    if (pvEl) {
      pvEl.textContent = '$' + d.pv.toFixed(0);
      const pnl = ((d.pv - ${STARTING_CASH}) / ${STARTING_CASH} * 100).toFixed(1);
      pnlEl.textContent = '(' + (pnl >= 0 ? '+' : '') + pnl + '%)';
      pnlEl.style.color = pnl >= 0 ? '#00ff88' : '#ff4444';
    }
    // Pulse indicator
    const ind = document.getElementById('live-indicator');
    if (ind) { ind.style.opacity = '1'; setTimeout(() => ind.style.opacity = '.4', 200); }
  } catch(e) {}
}
setInterval(pollLive, 5000);
pollLive();
</script>

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

  const st = dashboard.shortTermAnalyses[sym];

  // Helper: build SVG candlestick chart from a set of candles with EMA overlays
  function buildChart(cdata, emas, W, H) {
    if (!cdata || cdata.length < 3) return { chart: '<div style="color:#555">No data</div>', volume: '' };
    const cls = cdata.map(c => c.c), hs = cdata.map(c => c.h), ls = cdata.map(c => c.l), vs = cdata.map(c => c.v);
    const emaLines = emas.map(e => ({ data: calcEMA(cls, e.period), color: e.color, label: e.label }));
    const allP = [...hs, ...ls];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 20) - 10;
    const x = i => (i / Math.max(1, cls.length - 1)) * W;

    const bars = cdata.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00ff88" : "#ff4444";
      const bw = Math.max(3, W / cdata.length - 1);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bot - top);
      return `<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1"/>
        <rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${bodyH}" fill="${color}" rx="0.5"/>`;
    }).join("");

    const emaPaths = emaLines.map(e =>
      `<path d="${e.data.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${e.color}" stroke-width="1.5" opacity="0.8"/>`
    ).join("");

    const pLabels = [mn, mn + rng * 0.25, mn + rng * 0.5, mn + rng * 0.75, mx].map(p =>
      `<text x="${W + 5}" y="${y(p)}" fill="#555" font-size="9" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    const legend = emaLines.map(e =>
      `<span style="color:${e.color}">\u2501 ${e.label} (${e.data[e.data.length - 1].toFixed(2)})</span>`
    ).join(" &nbsp; ");

    const chart = `<svg viewBox="0 0 ${W + 60} ${H}" style="width:100%;height:${H}px">
      ${bars}${emaPaths}${pLabels}
    </svg>
    <div style="font-size:10px;margin-top:4px;color:#666">${legend}</div>`;

    const maxV = Math.max(...vs);
    const avgV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const VH = 60;
    const volBars = vs.map((v, i) => {
      const bw = Math.max(3, W / vs.length - 1);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw / 2}" y="${VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00ff8850' : '#ffffff18'}" rx="0.5"/>`;
    }).join("");
    const volume = `<svg viewBox="0 0 ${W + 60} ${VH}" style="width:100%;height:${VH}px">
      <line x1="0" y1="${VH - (avgV / maxV) * VH}" x2="${W}" y2="${VH - (avgV / maxV) * VH}" stroke="#ffffff15" stroke-dasharray="3 2"/>
      ${volBars}
    </svg>`;

    return { chart, volume };
  }

  // 90-day chart with EMA 8/21/50
  const longChart = buildChart(candles, [
    { period: 8, color: "#4ecdc4", label: "EMA 8" },
    { period: 21, color: "#ff6b35", label: "EMA 21" },
    { period: 50, color: "#a78bfa", label: "EMA 50" },
  ], 700, 250);

  // 7-day chart (last 14 candles) with EMA 3/5/8
  const shortCandles = candles ? candles.slice(-14) : null;
  const shortChart = buildChart(shortCandles, [
    { period: 3, color: "#00d4ff", label: "EMA 3" },
    { period: 5, color: "#ffd93d", label: "EMA 5" },
    { period: 8, color: "#ff6b9d", label: "EMA 8" },
  ], 700, 250);

  const chartSVG = longChart.chart;
  const volumeSVG = longChart.volume;

  // Position info block
  let posBlock = '<div style="color:#555">No position in this ticker</div>';
  if (pos) {
    const color = pos.pnlPct >= 0 ? "#00ff88" : "#ff4444";
    const posSpotChg = q && q.d != null ? q.d : 0;
    const posSpotChgPct = q && q.dp != null ? q.dp : 0;
    const posSpotColor = posSpotChg >= 0 ? "#00ff88" : "#ff4444";
    const posSpotFromEntry = pos.spot && pos.entrySpot ? ((pos.spot - pos.entrySpot) / pos.entrySpot * 100) : 0;
    const posSpotEntryColor = posSpotFromEntry >= 0 ? "#00ff88" : "#ff4444";
    posBlock = `
      <div class="stat"><div class="val">${pos.type.toUpperCase()}</div><div class="lbl">Type</div></div>
      <div class="stat"><div class="val">$${pos.strike}</div><div class="lbl">Strike</div></div>
      <div class="stat"><div class="val">${pos.qty}</div><div class="lbl">Contracts</div></div>
      <div class="stat"><div class="val">${pos.dteLeft.toFixed(1)}d</div><div class="lbl">DTE Left</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">$${pos.spot.toFixed(2)}</div><div class="lbl">Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotColor}">${posSpotChg >= 0 ? "+" : ""}${posSpotChg.toFixed(2)} (${posSpotChgPct >= 0 ? "+" : ""}${posSpotChgPct.toFixed(1)}%)</div><div class="lbl">Today's Move</div></div>
      <div class="stat"><div class="val">$${pos.entrySpot.toFixed(2)}</div><div class="lbl">Entry Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotEntryColor}">${posSpotFromEntry >= 0 ? "+" : ""}${posSpotFromEntry.toFixed(1)}%</div><div class="lbl">Stock Since Entry</div></div>
      <hr style="border-color:#1e1e2e;margin:12px 0">
      <div class="stat"><div class="val">$${pos.entryPremium.toFixed(2)}</div><div class="lbl">Entry Premium</div></div>
      <div class="stat"><div class="val">$${pos.curPremium.toFixed(2)}</div><div class="lbl">Current Premium</div></div>
      <div class="stat ${pos.pnlPct >= 0 ? '' : 'neg'}"><div class="val" style="color:${color}">${(pos.pnlPct * 100).toFixed(1)}% ($${pos.pnlDollar.toFixed(0)})</div><div class="lbl">P&L</div></div>
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
      <div style="margin-top:8px">${(dec.signals || []).map(s => '<div style="color:#888;font-size:11px;padding:2px 0">• ' + s + '</div>').join('')}</div>`;
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
    ? `<div class="hint">${hint.direction} bias ${hint.bias > 0 ? '+' : ''}${hint.bias} — ${hint.reasoning} (expires ${Math.round((hint.expiresAt - Date.now()) / 60000)}m)</div>`
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
<h1><a href="/">← Back</a> &nbsp; ${sym} ${q ? '$' + q.c.toFixed(2) : ''}
${q ? `<span style="font-size:13px;color:${q.d >= 0 ? '#00ff88' : '#ff4444'}">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2)} (${q.dp?.toFixed(2)}%)</span>` : ''}</h1>
<div class="sub">${pos ? pos.type.toUpperCase() + ' $' + pos.strike + ' | ' + pos.qty + ' contracts' : 'Not currently held'} &nbsp;|&nbsp; Auto-refreshes every 30s
${q?.t ? ` &nbsp;|&nbsp; Last: ${new Date(q.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ''}</div>

<div class="card" style="margin-bottom:16px;border-color:#00d4ff40">
  <h2 style="color:#00d4ff">7-Day Chart (Contract Window) — Fast EMAs 3/5/8</h2>
  ${shortChart.chart}
  <div style="margin-top:8px">${shortChart.volume}</div>
  ${st ? `<div style="margin-top:12px;display:flex;gap:20px;flex-wrap:wrap">
    <div class="stat"><div class="val" style="color:${st.score >= 55 ? '#00ff88' : st.score >= 45 ? '#888' : '#ff4444'}">${st.score}</div><div class="lbl">7d Score</div></div>
    <div class="stat"><div class="val" style="color:${st.signal.includes('BUY') ? '#00ff88' : st.signal.includes('SELL') ? '#ff4444' : '#888'}">${st.signal}</div><div class="lbl">7d Signal</div></div>
    <div class="stat"><div class="val" style="color:${st.mom1d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(2)}%</div><div class="lbl">1d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom3d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom3d >= 0 ? '+' : ''}${st.mom3d.toFixed(2)}%</div><div class="lbl">3d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom7d >= 0 ? '#00ff88' : '#ff4444'}">${st.mom7d >= 0 ? '+' : ''}${st.mom7d.toFixed(2)}%</div><div class="lbl">7d Momentum</div></div>
    <div class="stat"><div class="val">${st.rsi.toFixed(0)}</div><div class="lbl">RSI (5)</div></div>
    <div class="stat"><div class="val">${st.range7d.toFixed(1)}%</div><div class="lbl">7d Range</div></div>
    <div class="stat"><div class="val">$${st.recentHigh.toFixed(2)}</div><div class="lbl">7d High${st.nearHigh ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">$${st.recentLow.toFixed(2)}</div><div class="lbl">7d Low${st.nearLow ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">${st.vr.toFixed(2)}</div><div class="lbl">Vol Ratio</div></div>
  </div>
  <div style="margin-top:8px">${st.sigs.map(s => '<span style="color:' + (s.t === 'bull' ? '#00ff88' : '#ff4444') + ';font-size:11px;margin-right:12px">• ' + s.text + '</span>').join('')}</div>` : ''}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>90-Day Chart — EMAs 8/21/50</h2>
  ${chartSVG}
  <div style="margin-top:8px">${volumeSVG || '<div style="color:#555">No volume data</div>'}</div>
</div>

<div class="grid">
  <div class="card">
    <h2>90-Day Analysis & Indicators</h2>
    ${statsBlock}
  </div>
  <div class="card">
    <h2>Bot Decision (Blended 60% 7d / 40% 90d)</h2>
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

    // JSON API — full state
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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

    // JSON API — lightweight live ticker (polled every 5s)
    if (req.url === "/api/live") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const tickers = {};
      for (const [sym, q] of Object.entries(dashboard.quotes)) {
        const a = dashboard.analyses[sym];
        const st = dashboard.shortTermAnalyses[sym];
        const pos = state.positions.find(p => p.ticker === sym);
        let posPnl = null;
        if (pos) {
          const spot = q ? q.c : pos.entrySpot;
          const elapsed = (Date.now() - pos.openTime) / 86400_000;
          const dteLeft = Math.max(0, pos.dte - elapsed);
          const curPremium = optPrice(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type);
          posPnl = { pct: ((curPremium - pos.entryPremium) / pos.entryPremium * 100).toFixed(1), dollar: ((curPremium - pos.entryPremium) * pos.qty * 100).toFixed(0) };
        }
        tickers[sym] = {
          c: q.c, pc: q.pc, d: q.d, dp: q.dp, h: q.h, l: q.l,
          score: a?.score, signal: a?.signal, stScore: st?.score,
          mom1d: st?.mom1d, mom3d: st?.mom3d, mom7d: st?.mom7d,
          held: !!pos, type: pos?.type, posPnl,
        };
      }
      res.end(JSON.stringify({
        tickers,
        pv: portfolioValue(state, dashboard.quotes),
        cash: state.cash,
        open: state.positions.length,
        marketOpen: dashboard.marketOpen,
        lastCycle: dashboard.lastCycle,
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

  // Run dual-timeframe analysis on each ticker (with hint bias applied)
  const shortTermAnalyses = {};
  const decisions = [];
  for (const ticker of TICKERS) {
    const candles = candleCache[ticker];
    if (!candles) { decisions.push({ ticker, action: "SKIP", reason: "No candle data" }); continue; }
    const a = runAnalysis(candles);          // 90-day long-term
    const st = runShortTermAnalysis(candles); // 7-day short-term
    if (!a) { decisions.push({ ticker, action: "SKIP", reason: "Insufficient data (<55 candles)" }); continue; }

    // Store short-term analysis for dashboard
    if (st) shortTermAnalyses[ticker] = st;

    // Blend scores: 60% short-term (matches contract duration), 40% long-term (context)
    const blended = blendScores(a, st);
    const effectiveScore = blended.score;
    const effectiveSignal = blended.signal;

    // Apply Claude hint bias on the blended score
    const hintBias = getHintBias(ticker);
    const rawScore = effectiveScore;
    let finalScore = effectiveScore;
    if (hintBias !== 0) {
      finalScore = Math.max(0, Math.min(100, effectiveScore + hintBias));
      a.hintBoosted = true;
    }
    // Update the long-term analysis object with blended+hint final score for compatibility
    a.score = finalScore;
    a.signal = signalLabel(finalScore);
    a.blendedRaw = effectiveScore;
    a.shortTermScore = st ? st.score : null;
    a.longTermScore = a.score !== finalScore ? rawScore : a.score; // store the pre-hint blended
    analyses[ticker] = a;

    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    const stTag = st ? ` (7d:${st.score} 90d:${a.blendedRaw !== undefined ? Math.round(a.bullScore * 0.5 + 50 - a.bearScore * 0.5) : '?'})` : "";
    log(`${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag}${stTag} | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    // Build decision reasoning
    const dec = { ticker, price: q?.c, rawScore, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    const lowCash = state.cash < 200; // effectively no buying power

    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = a ? Math.round(50 + (a.bullScore - a.bearScore) / 2) : null;
    dec.blendedScore = effectiveScore;

    // Use the final (blended + hint) score for entry decisions
    if (finalScore >= BULL_ENTRY) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY CALL"; dec.reason = `Bullish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else if (finalScore <= BEAR_ENTRY) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY PUT"; dec.reason = `Bearish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else {
      dec.action = "WAIT";
      if (finalScore >= 55) dec.reason = `Score ${finalScore} — leaning bullish but need ≥${BULL_ENTRY} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else if (finalScore >= 45) dec.reason = `Score ${finalScore} — neutral (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else dec.reason = `Score ${finalScore} — leaning bearish but need ≤${BEAR_ENTRY} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.stEma3 = st?.ema3v?.toFixed(2); dec.stEma5 = st?.ema5v?.toFixed(2); dec.stEma8 = st?.ema8v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.stRsi = st?.rsi?.toFixed(1);
    dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.mom1d = st?.mom1d?.toFixed(2); dec.mom3d = st?.mom3d?.toFixed(2); dec.mom7d = st?.mom7d?.toFixed(2);
    dec.signals = [...(a.sigs?.map(s => s.text) || []), ...(st?.sigs?.map(s => `[7d] ${s.text}`) || [])];
    decisions.push(dec);
  }
  dashboard.decisions = decisions;
  dashboard.shortTermAnalyses = shortTermAnalyses;

  // Clean old day trades
  cleanDayTrades(state);

  // ─── Market Regime Check ───
  const regime = getMarketRegime(candleCache);
  currentRegime = regime;
  RISK_PCT = BASE_RISK_PCT * regime.riskScale;
  log(`REGIME: ${regime.label} | Risk: ${(RISK_PCT * 100).toFixed(1)}% per trade (${regime.riskScale}x base)`);

  // ─── Exit cascade (order matters: time-based → core → signal → EMA trailing) ───

  // 1. EOD/EOW theta-aware exits first (most urgent)
  tryTimeBasedExits(state, quotes);

  // 2. Core exits: profit target, stop loss, DTE, trimming
  tryExits(state, quotes, candleCache);

  // 3. Signal-based exits (trend reversal)
  trySignalExits(state, quotes, analyses);

  // 4. EMA trailing exits for positions past trim 2
  tryEMATrailingExits(state, quotes, candleCache);

  // ─── Entry logic (async — Claude validation per entry) ───
  for (const ticker of TICKERS) {
    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;

    const result = await tryEntry(state, ticker, a, q, candleCache, regime);
    if (result && result.skipped) {
      log(`SKIP ${ticker}: ${result.reason}`);
      // Update decision reasoning for dashboard
      const dec = decisions.find(d => d.ticker === ticker);
      if (dec && (dec.action === "BUY CALL" || dec.action === "BUY PUT")) {
        dec.action = "BLOCKED";
        dec.reason = result.reason;
      }
    } else if (result && result.ticker) {
      log(`TRADE: BUY ${result.qty}x ${result.ticker} $${result.strike} ${result.type.toUpperCase()} ${result.dte}d @ $${result.entryPremium.toFixed(2)} ($${result.cost.toFixed(0)}) [setup:${result.setupQuality}/100 claude:${result.claudeConfidence}%]`);
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
    const stopLossPrice = pos.entryPremium * (1 + STOP_LOSS);
    const isDayTrade = pos.openDate === getETDateStr();
    const pdtStatus = isDayTrade ? `Day trade (${countRecentDayTrades(state)}/3 used)` : "Swing (not a day trade)";

    // Effective stop depends on trim level
    let effectiveStop;
    if ((pos.trimLevel || 0) >= 2) effectiveStop = pos.entryPremium * 1.15; // +15% floor
    else if ((pos.trimLevel || 0) >= 1) effectiveStop = pos.entryPremium;    // breakeven
    else effectiveStop = stopLossPrice;

    return {
      ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
      profitTarget: { pct: `+${(PROFIT_TARGET * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
      stopLoss: { pct: `${(STOP_LOSS * 100).toFixed(0)}%`, premium: effectiveStop.toFixed(2) },
      pctToProfit: ((profitPrice - curPremium) / curPremium * 100).toFixed(1),
      pctToStop: ((effectiveStop - curPremium) / curPremium * 100).toFixed(1),
      pdtStatus,
      greeks: optGreeks(spot, pos.strike, dteLeft, DEFAULT_IV, pos.type),
    };
  });

  // Summary
  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  const progress = ((pv / GOAL) * 100).toFixed(1);
  log(`Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Goal: ${progress}% of $${GOAL.toLocaleString()} | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | ${countRecentDayTrades(state)}/3 PDT | ${regime.mode.toUpperCase()}${getActiveHintsSummary()}`);

  // Update dashboard state
  dashboard.quotes = quotes;
  dashboard.analyses = analyses;
  dashboard.shortTermAnalyses = shortTermAnalyses;
  dashboard.candles = candleCache;
  dashboard.lastCycle = Date.now();

  saveState(state);
  return { quotes, analyses, candleCache };
}

// ─── After-Hours Scan (analysis only, no trades) ───

async function runAfterHoursScan(state, candleCache) {
  log("AFTER-HOURS SCAN — Fetching data for analysis (no trades)");

  const quotes = {};
  const analyses = {};
  const shortTermAnalyses = {};

  // Fetch quotes (Finnhub returns last close + change data even after hours)
  for (const ticker of TICKERS) {
    try {
      quotes[ticker] = await fetchQuote(ticker, state.apiKey);
      await delay(API_DELAY);
    } catch (e) {
      log(`WARN: Failed to fetch quote for ${ticker} — ${e.message}`);
    }
  }

  // Fetch candles if not cached
  for (const ticker of TICKERS) {
    if (!candleCache[ticker]) {
      try {
        candleCache[ticker] = await fetchCandles(ticker, state.apiKey);
        await delay(API_DELAY);
      } catch (e) {
        log(`WARN: Failed to fetch candles for ${ticker} — ${e.message}`);
      }
    }
  }

  // Check hints
  await checkHints(state);

  // Run news scan
  await runNewsScan(state);

  // Run dual-timeframe analysis
  const decisions = [];
  for (const ticker of TICKERS) {
    const candles = candleCache[ticker];
    if (!candles) { decisions.push({ ticker, action: "SKIP", reason: "No candle data" }); continue; }
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) { decisions.push({ ticker, action: "SKIP", reason: "Insufficient data" }); continue; }

    if (st) shortTermAnalyses[ticker] = st;

    const blended = blendScores(a, st);
    const hintBias = getHintBias(ticker);
    let finalScore = blended.score;
    if (hintBias !== 0) {
      finalScore = Math.max(0, Math.min(100, finalScore + hintBias));
      a.hintBoosted = true;
    }
    a.score = finalScore;
    a.signal = signalLabel(finalScore);
    a.blendedRaw = blended.score;
    a.shortTermScore = st ? st.score : null;
    analyses[ticker] = a;

    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    log(`${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag} (7d:${st?.score ?? '?'}) | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    const dec = { ticker, price: q?.c, rawScore: blended.score, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = Math.round(50 + (a.bullScore - a.bearScore) / 2);
    dec.blendedScore = blended.score;
    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;

    if (finalScore >= BULL_ENTRY) {
      dec.action = alreadyHeld ? "HOLD" : "PLAN BUY CALL";
      dec.reason = alreadyHeld ? "Already in position" : `Bullish ${finalScore}/100 — will buy at open (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    } else if (finalScore <= BEAR_ENTRY) {
      dec.action = alreadyHeld ? "HOLD" : "PLAN BUY PUT";
      dec.reason = alreadyHeld ? "Already in position" : `Bearish ${finalScore}/100 — will buy at open (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    } else {
      dec.action = "WATCH";
      dec.reason = `Score ${finalScore} — monitoring (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.stEma3 = st?.ema3v?.toFixed(2); dec.stEma5 = st?.ema5v?.toFixed(2); dec.stEma8 = st?.ema8v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.stRsi = st?.rsi?.toFixed(1);
    dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.mom1d = st?.mom1d?.toFixed(2); dec.mom3d = st?.mom3d?.toFixed(2); dec.mom7d = st?.mom7d?.toFixed(2);
    dec.signals = [...(a.sigs?.map(s => s.text) || []), ...(st?.sigs?.map(s => `[7d] ${s.text}`) || [])];
    decisions.push(dec);
  }

  // Build position details
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

  // Update dashboard
  dashboard.quotes = quotes;
  dashboard.analyses = analyses;
  dashboard.shortTermAnalyses = shortTermAnalyses;
  dashboard.candles = candleCache;
  dashboard.decisions = decisions;
  dashboard.lastCycle = Date.now();

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  log(`AFTER-HOURS — Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open${getActiveHintsSummary()}`);

  return candleCache;
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

  // Pre-populate Finnhub key from .env if not already saved in state
  if (!state.apiKey && process.env.FINNHUB_API_KEY) {
    state.apiKey = process.env.FINNHUB_API_KEY;
  }

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

  // Run initial scan immediately on startup (even after hours) so dashboard has data
  log("Running startup scan...");
  try {
    candleCache = await runAfterHoursScan(state, candleCache);
  } catch (e) {
    log(`WARN: Startup scan failed — ${e.message}`);
  }
  console.log("");

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

      // Run after-hours analysis scan every 15 minutes
      try {
        candleCache = await runAfterHoursScan(state, candleCache);
      } catch (e) {
        log(`WARN: After-hours scan failed — ${e.message}`);
      }

      // Still check hints while market is closed
      await checkHints(state);

      // Scan every 15 minutes after hours
      await delay(900_000);
    }
  }
}

// ─── Start ───
main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
