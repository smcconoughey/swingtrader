import "dotenv/config";
import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import http from "http";
import crypto from "crypto";
import { TwitterApi } from "twitter-api-v2";
import { Resvg } from "@resvg/resvg-js";
import webpush from "web-push";
import { robinhood } from "./robinhood.js";
import { tradier } from "./tradier.js";
import { directionalSetupQuality, entryPriority, momentumEntryGate, rankEntryCandidates, rankPreparedEntries } from "./strategy-priority.js";
import { applyUnderlyingSnapshots, shouldRecordSelectionCohort, summarizeRankOne } from "./decision-telemetry.js";
import {
  createManagementPlan,
  evaluatePosition,
  managementPlanFor,
} from "./position-manager.js";
import {
  FEE_PER_CONTRACT,
  MIN_OPTION_DELTA,
  PREFERRED_DELTA_MIN,
  PREFERRED_DELTA_MAX,
  MAX_ENTRY_SPREAD_PCT,
  MAX_ENTRY_OVERPAY_PCT,
  buildCandidateContracts,
  entryLimitPrice,
} from "./option-contracts.js";
import {
  EXIT_INFLIGHT_GRACE_MS,
  chooseOptionSellLimit,
  exitIntentWithinGrace,
  exitLimitSanityCheck,
  mergeInflightTickers,
} from "./exit-execution.js";
import { ExecutionLane } from "./execution-lane.js";
import { applyLiveRiskPolicy, CAPITAL_PRESERVATION_POLICY } from "./live-risk-policy.js";
import { sizeLongOptionEntry } from "./risk-governor.js";
import { portfolioEntryBlock, recordPortfolioOutcome, rollPortfolioRiskState } from "./portfolio-risk.js";
import { validateEntryDecision } from "./llm-validation.js";
import { computeLongOptionOpenRisk } from "./open-risk.js";
import {
  classifyLongOptionHolding,
  isCanonicalLiveAccount,
  sanitizeRuntimeBrokerConfig,
} from "./live-broker-safety.js";
import {
  ambiguousBuyReplayAllowed,
  entryBuyHaltReason,
  shouldCancelWorkingBuysOnHalt,
} from "./entry-order-halt.js";
import {
  applyTradierTrimFill,
  isConfirmedTradeOutcome,
  matchTradierExitOrder,
  tradierFillDelta,
} from "./tradier-fill-accounting.js";
import {
  diffRobinhoodTradeHistory,
  extractRobinhoodPortfolioFields,
} from "./robinhood-portfolio.js";
import {
  clearEntryOrderTracking,
  entryIntentSatisfiedByHolding,
  exactOptionQuoteMatches,
  findBrokerCloseFillForPosition,
  findExactOptionOrder,
  isVerifiedRobinhoodContract,
  normalizeOptionId,
  optionOrderAverageFillPrice,
  optionOrderId,
  optionOrderExecutedGross,
  optionOrderExecutedQuantity,
  optionOrderIsTerminal,
  optionOrderRemainingQuantity,
  optionExpirationTimestamp,
  parseOccSymbol,
  resolveExactOptionIdentity,
} from "./robinhood-safety.js";

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

  // ─── SRxTrades: Undercut & Reclaim (bullish reversal) ───
  const ur = detectUndercutReclaim(candles);
  if (ur.detected) {
    const urBoost = Math.round(ur.quality * 0.25); // Up to +25 bull score
    bull += urBoost;
    sigs.push({ t: "bull", text: `U&R detected (${ur.quality}/100) — ${ur.reasons.slice(0, 2).join(", ")}` });
  }

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

  // ─── SRxTrades: Uppercut / Failed Breakout (bearish reversal) ───
  const uc = detectUppercut(candles);
  if (uc.detected) {
    const ucBoost = Math.round(uc.quality * 0.25); // Up to +25 bear score
    bear += ucBoost;
    sigs.push({ t: "bear", text: `Uppercut detected (${uc.quality}/100) — ${uc.reasons.slice(0, 2).join(", ")}` });
  }

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

  // ─── SRxTrades: Short-term U&R (bullish reversal on recent candles) ───
  const stUr = detectUndercutReclaim(candles);
  if (stUr.detected) {
    const urBoost = Math.round(stUr.quality * 0.20); // Up to +20 in short-term
    bull += urBoost;
    sigs.push({ t: "bull", text: `[ST] U&R setup (${stUr.quality}/100) — ${stUr.reasons.slice(0, 2).join(", ")}` });
  }

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

  // ─── SRxTrades: Short-term Uppercut (bearish failed breakout) ───
  const stUc = detectUppercut(candles);
  if (stUc.detected) {
    const ucBoost = Math.round(stUc.quality * 0.20);
    bear += ucBoost;
    sigs.push({ t: "bear", text: `[ST] Uppercut/Failed BO (${stUc.quality}/100) — ${stUc.reasons.slice(0, 2).join(", ")}` });
  }
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

// ─── Realistic fill model for PAPER / SIMULATED accounts ───
// Live broker accounts (Tradier/Robinhood) fill at real market prices. Paper & backtest accounts are
// priced off the theoretical mid (optPrice), and were filling with NO spread — buying at the mid and
// selling at the mid. That let the sim "sell at the top with no real buyer," overstating gains. This
// pegs paper fills to a realistic bid/ask around the mid: BUY at the ask (mid+half), SELL at the bid
// (mid-half). Cheap/OTM contracts get a wider modeled spread — exactly where gains were most inflated.
// IMPORTANT: this only changes the recorded FILL PRICE; it does NOT change which trades fire or when
// (entry signals, stops, targets all still evaluate on the mid), so the winning strategy is untouched.
function posMoneyness(type, spot, strike) {
  if (!(spot > 0)) return 0;
  return type === "put" ? (spot - strike) / spot : (strike - spot) / spot; // +ve = out-of-the-money
}
function modeledSpreadFrac(mid, moneyness = 0) {
  if (!(mid > 0)) return 0.50;
  const cheap = Math.min(0.35, 0.06 / mid);   // cheaper premium → wider %-spread (tick-size effect)
  const otm = Math.max(0, moneyness) * 1.2;   // far OTM → thinner market, wider spread / no buyer
  return Math.min(0.60, 0.05 + cheap + otm);  // total bid/ask spread as a fraction of mid
}
function simFillPrice(mid, moneyness, side) {
  const half = modeledSpreadFrac(mid, moneyness) / 2;
  const px = side === "buy" ? mid * (1 + half) : mid * (1 - half);
  return Math.max(0.01, +px.toFixed(2));
}

function optGreeks(spot, strike, dte, iv, type = "call") {
  const t = Math.max(dte / 365, 0.001);
  const d = type === "call"
    ? Math.min(0.99, Math.max(0.01, 0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)))
    : Math.max(-0.99, Math.min(-0.01, -0.5 + (spot - strike) / (spot * iv * Math.sqrt(t) * 2.5)));
  return { delta: +d.toFixed(3), theta: +(-(spot * iv) / (2 * Math.sqrt(t) * 365) * 0.4).toFixed(3) };
}

// ─── Constants ───

const REGIME_TICKERS = ["SPY", "QQQ"];
const WATCHLIST_REFRESH_MS = 4 * 60 * 60_000; // refresh every 4 hours

// ─── Sector Mapping ───
// Coarse sector lookup for concentration-risk enforcement. Goal isn't perfect taxonomy —
// it's "if I already hold 2 oil names, don't let me triple-down before the next OPEC headline."
// Unknown tickers default to "OTHER" which gets no concentration penalty.
const SECTOR_MAP = {
  // Energy / oil & gas
  CL: "ENERGY", XLE: "ENERGY", USO: "ENERGY", UGA: "ENERGY", OIL: "ENERGY", BP: "ENERGY",
  XOM: "ENERGY", CVX: "ENERGY", OXY: "ENERGY", DVN: "ENERGY", COP: "ENERGY", SLB: "ENERGY",
  RIG: "ENERGY", HAL: "ENERGY", EOG: "ENERGY", PSX: "ENERGY", MPC: "ENERGY", VLO: "ENERGY",
  PXD: "ENERGY", FANG: "ENERGY", APA: "ENERGY", HES: "ENERGY", BKR: "ENERGY",
  // Crypto miners / data-center infra
  CIFR: "AI_INFRA", WULF: "AI_INFRA", HUT: "AI_INFRA", NBIS: "AI_INFRA", WGMI: "AI_INFRA",
  CRWV: "AI_INFRA", MARA: "AI_INFRA", RIOT: "AI_INFRA", IREN: "AI_INFRA", BTDR: "AI_INFRA",
  CORZ: "AI_INFRA", APLD: "AI_INFRA", CLSK: "AI_INFRA", BITF: "AI_INFRA", HIVE: "AI_INFRA",
  // Space / aerospace mobility
  BKSY: "SPACE", PL: "SPACE", LUNR: "SPACE", RKLB: "SPACE", ASTS: "SPACE", RDW: "SPACE",
  SPCE: "SPACE", JOBY: "SPACE", ACHR: "SPACE", PSIX: "SPACE", LILM: "SPACE",
  FLY: "SPACE", SATL: "SPACE", VOYG: "SPACE", SPCX: "SPACE",
  // Semiconductors (AI + general)
  NVDA: "SEMI", AMD: "SEMI", MU: "SEMI", INTC: "SEMI", AMKR: "SEMI", AVGO: "SEMI",
  TSM: "SEMI", QCOM: "SEMI", NXPI: "SEMI", MXL: "SEMI", AXTI: "SEMI", NVTS: "SEMI",
  ARM: "SEMI", MRVL: "SEMI", LSCC: "SEMI", ON: "SEMI", SWKS: "SEMI", QRVO: "SEMI",
  ASML: "SEMI", AMAT: "SEMI", LRCX: "SEMI", KLAC: "SEMI", ADI: "SEMI", TXN: "SEMI",
  MCHP: "SEMI", SMCI: "SEMI", ALAB: "SEMI", CRDO: "SEMI",
  // AI storage / servers / networking
  SNDK: "AI_STORAGE", WDC: "AI_STORAGE", STX: "AI_STORAGE", DELL: "AI_STORAGE",
  HPE: "AI_STORAGE", PSTG: "AI_STORAGE",
  ANET: "AI_NETWORKING", CIEN: "AI_NETWORKING", COHR: "AI_NETWORKING", LITE: "AI_NETWORKING",
  // Data-center electrical, thermal, grid and construction infrastructure
  VRT: "POWER_INFRA", ETN: "POWER_INFRA", PWR: "POWER_INFRA", POWL: "POWER_INFRA",
  NVT: "POWER_INFRA", EME: "POWER_INFRA",
  // Quantum computing — separate sector since it moves as a group on quantum news
  IONQ: "QUANTUM", RGTI: "QUANTUM", QBTS: "QUANTUM", QUBT: "QUANTUM", QSI: "QUANTUM",
  ARQQ: "QUANTUM",
  // Mega-cap tech
  AAPL: "MEGA_TECH", MSFT: "MEGA_TECH", GOOGL: "MEGA_TECH", GOOG: "MEGA_TECH",
  META: "MEGA_TECH", AMZN: "MEGA_TECH", ORCL: "MEGA_TECH", NFLX: "MEGA_TECH",
  // Enterprise software
  CRM: "SOFTWARE", NOW: "SOFTWARE", SHOP: "SOFTWARE", TEAM: "SOFTWARE",
  ZM: "SOFTWARE", DDOG: "SOFTWARE", SNOW: "SOFTWARE", FIG: "SOFTWARE",
  HUBS: "SOFTWARE", PATH: "SOFTWARE", DOCS: "SOFTWARE", PCOR: "SOFTWARE",
  ADBE: "SOFTWARE", INTU: "SOFTWARE", WDAY: "SOFTWARE", MDB: "SOFTWARE",
  ESTC: "SOFTWARE", CFLT: "SOFTWARE", VEEV: "SOFTWARE", SPLK: "SOFTWARE",
  ASAN: "SOFTWARE", MNDY: "SOFTWARE", BILL: "SOFTWARE", AI: "SOFTWARE",
  PLTR: "SOFTWARE", APP: "SOFTWARE", ROKU: "SOFTWARE",
  // Cybersecurity — moves together on breach/CISA headlines
  CRWD: "CYBER", PANW: "CYBER", ZS: "CYBER", NET: "CYBER", FTNT: "CYBER",
  S: "CYBER", OKTA: "CYBER", CYBR: "CYBER", RBRK: "CYBER", QLYS: "CYBER",
  TENB: "CYBER", VRNS: "CYBER",
  // EV / auto
  TSLA: "EV_AUTO", F: "EV_AUTO", GM: "EV_AUTO", RIVN: "EV_AUTO", LCID: "EV_AUTO",
  NIO: "EV_AUTO", LI: "EV_AUTO", XPEV: "EV_AUTO", STLA: "EV_AUTO", TM: "EV_AUTO",
  CHPT: "EV_AUTO", BLNK: "EV_AUTO",
  // Pharma / healthcare large-cap
  PFE: "PHARMA", LLY: "PHARMA", NVO: "PHARMA", MRK: "PHARMA", ABBV: "PHARMA",
  BMY: "PHARMA", AMGN: "PHARMA", JNJ: "PHARMA", GILD: "PHARMA", BIIB: "PHARMA",
  REGN: "PHARMA", VRTX: "PHARMA", TEVA: "PHARMA",
  // Managed care / health services
  UNH: "HEALTH", HUM: "HEALTH", CNC: "HEALTH", CI: "HEALTH", ELV: "HEALTH",
  CVS: "HEALTH", DXCM: "HEALTH", ISRG: "HEALTH", MDT: "HEALTH",
  // Biotech (mid-cap movers)
  BEAM: "BIOTECH", CRSP: "BIOTECH", NTLA: "BIOTECH", CMPS: "BIOTECH",
  GHRS: "BIOTECH", MIRM: "BIOTECH", AXSM: "BIOTECH", KNSA: "BIOTECH",
  IBRX: "BIOTECH", ZLAB: "BIOTECH", APLS: "BIOTECH", MRNS: "BIOTECH",
  SAVA: "BIOTECH", IOVA: "BIOTECH", DNLI: "BIOTECH", CYTK: "BIOTECH",
  RVMD: "BIOTECH", VKTX: "BIOTECH",
  // Banks / payments
  V: "FINANCIALS", MA: "FINANCIALS", JPM: "FINANCIALS", GS: "FINANCIALS",
  MS: "FINANCIALS", BAC: "FINANCIALS", WFC: "FINANCIALS", BLK: "FINANCIALS",
  SCHW: "FINANCIALS", HOOD: "FINANCIALS", SOFI: "FINANCIALS", NU: "FINANCIALS",
  C: "FINANCIALS", USB: "FINANCIALS", PNC: "FINANCIALS", AXP: "FINANCIALS",
  PYPL: "FINANCIALS", SQ: "FINANCIALS", AFRM: "FINANCIALS",
  // Crypto-adjacent (move with BTC, not with broader financials)
  COIN: "CRYPTO_ADJ", MSTR: "CRYPTO_ADJ", BITX: "CRYPTO_ADJ", IBIT: "CRYPTO_ADJ",
  GBTC: "CRYPTO_ADJ", ETHE: "CRYPTO_ADJ", BITO: "CRYPTO_ADJ",
  // Defense / aerospace
  LMT: "DEFENSE", RTX: "DEFENSE", NOC: "DEFENSE", GD: "DEFENSE", LDOS: "DEFENSE",
  KTOS: "DEFENSE", AVAV: "DEFENSE", BA: "DEFENSE", HII: "DEFENSE", TDG: "DEFENSE",
  CW: "DEFENSE",
  // Industrial / machinery
  CAT: "INDUSTRIAL", DE: "INDUSTRIAL", MMM: "INDUSTRIAL", HON: "INDUSTRIAL",
  EMR: "INDUSTRIAL", GE: "INDUSTRIAL", ETN: "INDUSTRIAL", PH: "INDUSTRIAL",
  ITW: "INDUSTRIAL", ROK: "INDUSTRIAL",
  // Comms / telecom / media
  NOK: "COMMS", VZ: "COMMS", T: "COMMS", TMUS: "COMMS", ERIC: "COMMS",
  CMCSA: "COMMS", DIS: "COMMS", CHTR: "COMMS", WBD: "COMMS", PARA: "COMMS",
  SPOT: "COMMS",
  // Indexes
  SPY: "INDEX", QQQ: "INDEX", QQQM: "INDEX", DIA: "INDEX", IWM: "INDEX",
  VOO: "INDEX", VTI: "INDEX", MDY: "INDEX",
  // Bonds / rates / commodities ETFs
  TLT: "BONDS", SCHP: "BONDS", IEF: "BONDS", AGG: "BONDS", BND: "BONDS",
  GLD: "PRECIOUS", SLV: "PRECIOUS", GDX: "PRECIOUS", GDXJ: "PRECIOUS",
  // Homebuilders / real estate
  TPH: "HOMEBUILDER", LEN: "HOMEBUILDER", DHI: "HOMEBUILDER", NVR: "HOMEBUILDER",
  KBH: "HOMEBUILDER", PHM: "HOMEBUILDER", TOL: "HOMEBUILDER",
  // REITs (rate-sensitive)
  O: "REIT", AMT: "REIT", PLD: "REIT", EQIX: "REIT", DLR: "REIT", SPG: "REIT",
  PSA: "REIT", CCI: "REIT", WELL: "REIT",
  // Solar / clean energy
  ENPH: "SOLAR", SEDG: "SOLAR", FSLR: "SOLAR", RUN: "SOLAR", PLUG: "SOLAR",
  FCEL: "SOLAR", BE: "SOLAR", NOVA: "SOLAR", ARRY: "SOLAR", SHLS: "SOLAR",
  // Nuclear / uranium / power-for-AI — hot 2026 theme as AI data centers chase baseload
  OKLO: "NUCLEAR", SMR: "NUCLEAR", CCJ: "NUCLEAR", UEC: "NUCLEAR", LEU: "NUCLEAR",
  BWXT: "NUCLEAR", URA: "NUCLEAR", NLR: "NUCLEAR", CEG: "NUCLEAR", VST: "NUCLEAR",
  TLN: "NUCLEAR", GEV: "NUCLEAR", NRG: "NUCLEAR",
  // Utilities (rate-sensitive, ex-nuclear)
  NEE: "UTILITY", DUK: "UTILITY", SO: "UTILITY", D: "UTILITY", AEP: "UTILITY",
  XEL: "UTILITY", SRE: "UTILITY",
  // Airlines (move together on fuel + travel demand)
  AAL: "AIRLINE", UAL: "AIRLINE", DAL: "AIRLINE", LUV: "AIRLINE", JBLU: "AIRLINE",
  ALK: "AIRLINE", SAVE: "AIRLINE",
  // China ADRs (move on geopolitical headlines as a bloc)
  BABA: "CHINA", PDD: "CHINA", JD: "CHINA", BIDU: "CHINA", BILI: "CHINA",
  TME: "CHINA", IQ: "CHINA", FXI: "CHINA", KWEB: "CHINA",
  // Consumer discretionary / retail
  NKE: "CONSUMER", LULU: "CONSUMER", COST: "CONSUMER", WMT: "CONSUMER",
  TGT: "CONSUMER", ULTA: "CONSUMER", SBUX: "CONSUMER", MCD: "CONSUMER",
  DPZ: "CONSUMER", CMG: "CONSUMER", HD: "CONSUMER", LOW: "CONSUMER",
  TJX: "CONSUMER", DECK: "CONSUMER", CROX: "CONSUMER", BBY: "CONSUMER",
  EBAY: "CONSUMER", ETSY: "CONSUMER",
  // Travel / hospitality
  ABNB: "TRAVEL", BKNG: "TRAVEL", EXPE: "TRAVEL", MAR: "TRAVEL", HLT: "TRAVEL",
  RCL: "TRAVEL", CCL: "TRAVEL", NCLH: "TRAVEL", UBER: "TRAVEL", LYFT: "TRAVEL",
  // Materials / metals
  CLF: "MATERIALS", X: "MATERIALS", NUE: "MATERIALS", STLD: "MATERIALS",
  FCX: "MATERIALS", AA: "MATERIALS", VALE: "MATERIALS", RIO: "MATERIALS",
  // Robotics / automation
  SYM: "ROBOTICS", ABB: "ROBOTICS",
};

function getSector(ticker) {
  return SECTOR_MAP[ticker] || "OTHER";
}

function countPositionsInSector(state, sector) {
  return state.positions.filter(p => getSector(p.ticker) === sector).length;
}

// Max positions allowed per sector. OTHER is unlimited (no concentration risk for unmapped names).
const MAX_PER_SECTOR = 2;

// ─── Curated Pinned Watchlist ───
// Always-analyzed names spanning the major 2026 themes — SRxTrades originals plus the
// high-volume momentum leaders that dominate options flow right now. The dynamic screener
// (most-actives, trending, day-gainers/losers) pulls in the rest each cycle.
const SR_WATCHLIST = [
  // Data center / crypto-miner AI infrastructure (SR core theme)
  "CIFR", "WULF", "HUT", "NBIS", "WGMI", "IREN", "BTDR", "CRWV", "MARA", "RIOT",
  "APLD", "CORZ", "CLSK", "BITF", "HIVE",
  // Space / aerospace mobility
  "BKSY", "PL", "LUNR", "RKLB", "ASTS", "RDW", "ACHR", "JOBY", "FLY", "SATL", "VOYG",
  // AI semiconductors — flow leaders
  "NVDA", "AVGO", "AMD", "MU", "ARM", "TSM", "SMCI", "MRVL", "INTC", "ALAB", "CRDO",
  // Memory / storage / AI server beneficiaries
  "SNDK", "WDC", "STX", "DELL", "HPE", "PSTG",
  // Networking / optical interconnect
  "ANET", "CIEN", "COHR", "LITE",
  // AI software / agents (PLTR is the perennial flow leader)
  "PLTR", "AI", "MDB", "ESTC", "APP", "SNOW", "DDOG", "ORCL", "RBRK",
  // Cybersecurity (option flow on every breach headline)
  "CRWD", "PANW", "ZS", "NET", "S",
  // Quantum (group moves on any quantum/IBM/Google headline)
  "IONQ", "RGTI", "QBTS", "QUBT",
  // Nuclear / power-for-AI (2026's hottest secondary theme)
  "OKLO", "SMR", "CEG", "VST", "CCJ", "UEC", "BWXT", "GEV",
  "TLN", "NRG", "VRT", "ETN", "PWR", "POWL", "NVT", "EME", "BE",
  // Crypto-adjacent (move with BTC, separate from financials)
  "COIN", "MSTR", "HOOD", "SOFI", "AFRM",
  // Data-center real estate / interconnect
  "DLR", "EQIX",
  // Mega-cap consolidation-to-expansion leaders (May 2026 SR posts)
  "TSLA", "AAPL", "MSFT", "GOOGL", "META", "AMZN",
  // EV / clean
  "RIVN", "ENPH", "SEDG", "FSLR",
  // Defense (sustained spending cycle)
  "LMT", "RTX", "KTOS", "AVAV",
  // Biotech / pharma movers
  "LLY", "NVO", "VKTX", "VRTX",
  // Robotics / automation
  "ISRG", "SYM",
  // Original SR positions
  "OPTX",
];

// Ticker shape validator — rejects obvious non-tickers Claude sometimes emits from news
// scans (surnames like "WARSH", company names like "CEREBRAS"). Real US tickers are 1-5
// uppercase letters, optionally with a class suffix like "BRK.B".
const TICKER_SHAPE = /^[A-Z]{1,5}(\.[A-Z])?$/;
const GLOBAL_TICKER_BLOCKLIST = new Set([
  "UVXY", "VIX", "VXX", "SVXY", "VIXY", "UVIX",
  // Common Claude misfires — names/words that pass shape but aren't tradable tickers.
  "WARSH", "POWELL", "TRUMP", "BIDEN", "FED",
  // English words the hint parser has extracted from chat messages ("add rddt and hims" →
  // "AND"; "add X to the watchlist" → "LIST"). None of these are active US tickers — but note
  // real word-tickers like A, T, IT, ALL, ON, ANY, FOR, NOW must NOT be added here.
  "AND", "THE", "LIST", "ADD", "REMOVE", "WATCH", "PLEASE", "THIS", "THAT",
  "WITH", "FROM", "INTO", "ABOUT", "STOCK", "TICKER", "BUY", "SELL",
]);
const DIRECTIVE_WORD_BLOCKLIST = new Set([
  "ADD", "ADDED", "WATCH", "WATCHING", "WATCHLIST", "TRACK", "TRACKING", "MONITOR", "MONITORING",
  "FOCUS", "REMOVE", "DROP", "DELETE", "STOP", "THE", "TO", "FROM", "ON", "IN", "MY", "A", "AN",
  "TICKER", "TICKERS", "SYMBOL", "SYMBOLS", "STOCK", "STOCKS", "NAME", "NAMES", "BULLISH",
  "BEARISH", "LONG", "SHORT", "CALL", "CALLS", "PUT", "PUTS", "PLEASE", "PLS",
  "NEW", "MORE", "MANY", "BUNCH", "LOT", "LOTS", "SOME", "THIS", "THAT", "THESE", "THOSE",
]);

function isValidTickerSymbol(sym) {
  if (!sym || typeof sym !== "string") return false;
  if (!TICKER_SHAPE.test(sym)) return false;
  if (GLOBAL_TICKER_BLOCKLIST.has(sym)) return false;
  return true;
}

// Centralised add path so all three call sites (hint result, news impact, news newTickers)
// go through the same validation and respect each account's auto-pruned bad-ticker list.
function addTickerToWatchlist(acct, sym, source) {
  sym = (sym || "").trim().toUpperCase();
  if (!isValidTickerSymbol(sym)) {
    log(acct, `WATCHLIST: rejected "${sym}" from ${source} — invalid shape or blocklisted`);
    return { added: false, existing: false, rejected: true, reason: "invalid ticker shape or blocklisted" };
  }
  if (!acct.badTickers) acct.badTickers = {};
  if (acct.badTickers[sym]?.blocked) {
    log(acct, `WATCHLIST: rejected "${sym}" from ${source} — previously failed to load`);
    return { added: false, existing: false, rejected: true, reason: "previously failed to load" };
  }
  if (!Array.isArray(acct.tickers)) acct.tickers = [];
  if (!Array.isArray(acct.dynamicWatchlist)) acct.dynamicWatchlist = [];
  const existing = acct.tickers.includes(sym) || acct.dynamicWatchlist.includes(sym);
  if (!acct.tickers.includes(sym)) acct.tickers.push(sym);
  if (acct.dynamicWatchlist.length > 0 && !acct.dynamicWatchlist.includes(sym)) acct.dynamicWatchlist.push(sym);
  if (!existing) log(acct, `WATCHLIST +${sym} (${source})`);
  return { added: !existing, existing, rejected: false, reason: existing ? "already watched" : "" };
}

function tryAddTicker(acct, sym, source) {
  return addTickerToWatchlist(acct, sym, source).added;
}

function removeTickerFromWatchlist(acct, sym, source) {
  sym = (sym || "").trim().toUpperCase();
  if (!isValidTickerSymbol(sym)) return { removed: false, reason: "invalid ticker" };
  const beforeTickers = Array.isArray(acct.tickers) ? acct.tickers.length : 0;
  const beforeDynamic = Array.isArray(acct.dynamicWatchlist) ? acct.dynamicWatchlist.length : 0;
  acct.tickers = (acct.tickers || []).filter(t => t !== sym);
  acct.dynamicWatchlist = (acct.dynamicWatchlist || []).filter(t => t !== sym);
  acct.activeHints = (acct.activeHints || []).filter(h => h.ticker !== sym);
  const removed = acct.tickers.length !== beforeTickers || acct.dynamicWatchlist.length !== beforeDynamic;
  if (removed) log(acct, `WATCHLIST -${sym} (${source})`);
  return { removed, reason: removed ? "" : "not watched" };
}

function extractDirectiveSymbols(text) {
  const raw = String(text || "").toUpperCase().match(/\$?[A-Z]{1,5}(?:\.[A-Z])?/g) || [];
  return [...new Set(raw.map(s => s.replace(/^\$/, "")).filter(s =>
    isValidTickerSymbol(s) && !DIRECTIVE_WORD_BLOCKLIST.has(s)
  ))];
}

function inferDirectWatchlistDirectives(text) {
  const upper = String(text || "").toUpperCase();
  const addIntent = /\b(ADD|WATCH|TRACK|MONITOR|FOLLOW|FOCUS)\b/.test(upper);
  const removeIntent = /\b(REMOVE|DROP|DELETE|UNWATCH)\b|\bSTOP\s+(WATCHING|TRACKING|MONITORING)\b/.test(upper);
  if (!addIntent && !removeIntent) return { tickers: [], removeTickers: [], direct: false };

  const symbols = extractDirectiveSymbols(upper);
  if (symbols.length === 0) return { tickers: [], removeTickers: [], direct: addIntent || removeIntent };

  const bearish = /\b(BEARISH|SHORT|PUT|PUTS|DOWNSIDE|WEAK)\b/.test(upper);
  const bullish = /\b(BULLISH|LONG|CALL|CALLS|UPSIDE|BOOM|BREAKOUT|STRONG)\b/.test(upper);
  const direction = bearish ? "bearish" : "bullish";
  const bias = bearish ? -20 : bullish ? 20 : 0;
  const reasoning = bias === 0
    ? "Explicit user watchlist add; monitor without score bias."
    : `Explicit user ${direction} watchlist directive.`;

  return {
    tickers: addIntent && !removeIntent ? symbols.map(symbol => ({ symbol, direction, bias, reasoning })) : [],
    removeTickers: removeIntent ? symbols : [],
    direct: true,
  };
}

// Called once per cycle for each ticker that produced "No candle data" / "Insufficient data".
// After 3 consecutive failures, prune from the watchlist and add to per-account blocklist
// so news/hint adds can't re-introduce it.
function markTickerDataFailure(acct, sym) {
  if (!acct.badTickers) acct.badTickers = {};
  const rec = acct.badTickers[sym] || { fails: 0, blocked: false };
  rec.fails += 1;
  if (rec.fails >= 3 && !rec.blocked) {
    rec.blocked = true;
    acct.tickers = acct.tickers.filter(t => t !== sym);
    acct.dynamicWatchlist = (acct.dynamicWatchlist || []).filter(t => t !== sym);
    acct.activeHints = (acct.activeHints || []).filter(h => h.ticker !== sym);
    log(acct, `WATCHLIST: auto-pruned "${sym}" after 3 failed data fetches — added to local blocklist`);
  }
  acct.badTickers[sym] = rec;
}

function markTickerDataSuccess(acct, sym) {
  if (acct.badTickers && acct.badTickers[sym] && !acct.badTickers[sym].blocked) {
    delete acct.badTickers[sym];
  }
}

async function fetchDynamicWatchlist() {
  const symbols = new Set(REGIME_TICKERS);
  const headers = { "User-Agent": "Mozilla/5.0" };

  // 1. Most active US stocks
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=15&lang=en-US&region=US",
      { headers }
    );
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
    }
  } catch { }

  // 2. Trending tickers
  try {
    const r = await fetch(
      "https://query1.finance.yahoo.com/v1/finance/trending/US?count=10&lang=en-US",
      { headers }
    );
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
    }
  } catch { }

  // 3. Top gainers / losers (high momentum)
  for (const scrId of ["day_gainers", "day_losers"]) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=8&lang=en-US&region=US`,
        { headers }
      );
      if (r.ok) {
        const d = await r.json();
        const quotes = d?.finance?.result?.[0]?.quotes || [];
        for (const q of quotes) if (q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)) symbols.add(q.symbol);
      }
    } catch { }
  }

  return [...symbols];
}

async function refreshWatchlist(acct) {
  // Learning variants scan exactly what their parent scans — same tickers, same data, so the
  // only difference between variants is the strategy knob under test. If the parent is idle
  // (paused since restart, watchlist never rebuilt), fall through and build our own list so
  // data collection continues regardless.
  if (acct.learning) {
    const parent = accounts.get(acct.learningParent);
    if (parent && (parent.tickers || []).length > 5) {
      acct.tickers = [...parent.tickers];
      acct.dynamicWatchlist = [...(parent.dynamicWatchlist || [])];
      return;
    }
  }
  const now = Date.now();
  if (now - acct.lastWatchlistRefresh < WATCHLIST_REFRESH_MS && acct.dynamicWatchlist.length > 0) return;
  acct.lastWatchlistRefresh = now;

  log(acct, "WATCHLIST: Refreshing from market data...");
  const raw = await fetchDynamicWatchlist();

  const blocked = new Set(["UVXY", "VIX", "VXX", "SVXY", "VIXY", "UVIX"]);

  const filtered = raw.filter(sym =>
    !blocked.has(sym) || REGIME_TICKERS.includes(sym)
  );

  const hinted = acct.tickers.filter(t => !filtered.includes(t));
  acct.dynamicWatchlist = [...new Set([...REGIME_TICKERS, ...SR_WATCHLIST, ...filtered, ...hinted])];

  log(acct, `WATCHLIST: ${acct.dynamicWatchlist.length} tickers — ${acct.dynamicWatchlist.slice(0, 15).join(", ")}${acct.dynamicWatchlist.length > 15 ? "..." : ""}`);
  acct.tickers = [...acct.dynamicWatchlist];
}

function getActiveTickers(acct) {
  const base = acct.dynamicWatchlist.length > 0 ? acct.dynamicWatchlist : acct.tickers;
  const hinted = acct.tickers.filter(t => !base.includes(t));
  return [...new Set([...base, ...hinted])];
}

const STATE_FILE = process.env.STATE_FILE || "state.json";
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || (process.env.STATE_FILE ? process.env.STATE_FILE.replace(/state\.json$/, "accounts.json") : "accounts.json");
const HINT_FILE = "hint.txt";
const CYCLE_MS = 60_000;       // 60s between cycles when market open
const POSITION_MANAGEMENT_MS = 15_000; // held positions are managed independently of entry discovery
const POSITION_MANAGER_STALE_MS = 45_000;
const RH_OPTION_QUOTE_MAX_AGE_MS = 45_000;
const CYCLE_MS_CLOSED = 90_000; // slower after-hours polling
const API_DELAY_FINNHUB = 150;  // Finnhub free tier
const API_DELAY_TRADIER = 25;   // Tradier batch-friendly
function apiDelay() { return tradier.isConnected ? API_DELAY_TRADIER : API_DELAY_FINNHUB; }
const DEFAULT_IV = 0.30;

// Swing-trade contract quality — we ONLY want real, near-the-money directional trades, never cheap
// far-OTM lottery tickets (the ones that have been sinking the account). Delta is the discriminator:
// a δ0.50 ATM call is a real trade; a δ0.15 far-OTM call is a lottery ticket regardless of price.
// Moneyness window for candidates: from this much ITM to this much OTM. Tight on the OTM side so we
// never reach for cheap out-of-the-money strikes; ITM is fine (higher delta, higher win rate).
// A contract whose live bid/ask spread exceeds this fraction of mid is effectively un-exitable
// without donating the spread (e.g. the XLV $161 call at b$0.25/a$0.82 = 107% wide). Reject such
// contracts on entry — they look "affordable" but you can't get out near fair value.
// On protective exits, if the live spread is wider than this, do NOT dump at the raw bid (which
// donates the whole spread). Instead post a limit a small step below mid and let it re-price each
// cycle. Tight markets below this threshold still exit marketable (at the bid).
const WIDE_SPREAD_EXIT_PCT = 0.20;
// Most we'll concede below mid when working a protective exit through a wide spread.
const MAX_EXIT_CONCESSION_PCT = 0.12;
// Hard cap on overpay: never submit a limit more than this fraction above the mid.
// Reject contracts whose IV exceeds this — premium is inflated by event risk, not directional value.
// In choppy regimes (broken EMA stack), demand stronger confirmation before new risk.
const CHOPPY_MIN_BULL_SCORE = 72;
const CHOPPY_MIN_BEAR_SCORE = 28; // must be <= this for puts (stricter than default bearEntry)
// Earnings calendar cache (one Finnhub call per ticker per day).
const earningsCache = new Map();
// Live market-data provenance counters so the UI can show whether the bot is on Tradier (live,
// fill-accurate) data or has fallen back to Finnhub/Yahoo. Reset is not needed — these are running
// totals since process start; the dashboard shows the current primary + fallback counts.
const marketDataStats = { tradier: 0, finnhub: 0, yahoo: 0, lastSource: "—", lastAt: 0 };
function noteDataSource(src) {
  if (marketDataStats[src] != null) marketDataStats[src]++;
  marketDataStats.lastSource = src;
  marketDataStats.lastAt = Date.now();
}

// ─── Trimming & EOD/EOW Constants ───
// Both EOD windows used to open a full hour (freeze) / 30 min (tighten) before the 4:00 PM ET
// close, which cut off a large chunk of the trading day for no strong reason — a decent setup
// at 3:05 PM isn't meaningfully riskier than one at 2:55 PM. Narrowed to the last 15 minutes,
// where the concern (thin closing liquidity, overnight gap risk) is actually concentrated.
const EOD_FREEZE_HOUR = 15.75;  // No new entries in the last 15 min (after 3:45 PM ET)

// Opening-range freeze: the first few minutes after the 9:30 ET bell have the widest, least
// reliable option spreads and the most noise-driven price action of the day — a "signal" here is
// often just the open's own volatility, not a real setup. No new entries until it settles.
const MARKET_OPEN_HOUR = 9.5;         // Regular session opens 9:30 AM ET
const OPEN_FREEZE_MINUTES = 15;       // No new entries in the first 15 min after open
const OPEN_FREEZE_END_HOUR = MARKET_OPEN_HOUR + OPEN_FREEZE_MINUTES / 60;

// ─── Trust-Scaled Cash Reserve ───
// Keep a minimum cash buffer sized as a fraction of total portfolio value. The buffer starts
// defensive (CASH_RESERVE_MAX) and only shrinks toward CASH_RESERVE_MIN as conviction ("trust")
// in a setup rises. Low-trust setups must respect the full 50% buffer; only the highest-trust
// setups may deploy down to a 25% buffer. This prevents over-deployment (the $148-cash trap).
const CASH_RESERVE_MAX = 0.50; // default minimum cash on hand (low trust)
const CASH_RESERVE_MIN = 0.25; // floor minimum cash on hand (max trust)


// ─── Expiration Cadence / DTE Staggering ───
const TARGET_DTE = 21;     // preferred swing horizon (days to expiration)
const MIN_SWING_DTE = 7;   // never open a swing shorter than one week
const MAX_DTE = 45;        // never look past this horizon for an expiry
const MAX_PER_EXPIRY = 3;  // stagger: cap positions sharing the exact same expiration date

// Tickers with daily (every-trading-day) option expirations.
const DAILY_EXPIRY_TICKERS = new Set(["SPY", "QQQ", "IWM", "DIA", "SPX", "XSP", "NDX", "QQQM"]);
// Tickers with Mon/Wed/Fri weekly expirations (high-volume single names + select ETFs).
const MWF_EXPIRY_TICKERS = new Set([
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "GOOG", "AMD", "NFLX",
  "F", "INTC", "AAL", "PLTR", "BAC", "GLD", "SLV", "USO", "TLT", "HOOD", "COIN", "MARA", "RIOT",
]);

const CLAUDE_API_KEY = (process.env.CLAUDE_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

// LLM_PROVIDER: "gemini" | "claude" — defaults to Claude (Haiku)
// Mutable at runtime via dashboard toggle or POST /api/llm-provider
let LLM_PROVIDER = (process.env.LLM_PROVIDER || "claude").toLowerCase();

// Robinhood execution is per-account (config.broker = "robinhood"), just like Tradier.

// The old in-memory Robinhood "approval queue" was not durable or broker-backed. Keep the env
// flag only as a fail-closed compatibility switch: when enabled, all new live entries are blocked.
let RH_REQUIRE_APPROVAL = process.env.RH_REQUIRE_APPROVAL === "true";

// RH_OPTIONS_ONLY: when true (default), Robinhood trades options only — no equity share fallback.
// Set RH_OPTIONS_ONLY=false to allow equity fallback when options chain is unavailable.
let RH_OPTIONS_ONLY = process.env.RH_OPTIONS_ONLY !== "false";

// RH_AUTO_WATCHLIST: auto-add serious entry candidates to the Robinhood MCP watchlist.
let RH_AUTO_WATCHLIST = process.env.RH_AUTO_WATCHLIST !== "false";
let RH_WATCHLIST_NAME = process.env.RH_WATCHLIST_NAME || "Swing Trader";
const rhWatchlistAdded = new Set();

/** Robinhood broker trade mode: "none" | "equity" | "options" | "both" */
function rhTradeMode(cfg) {
  if (cfg.broker !== "robinhood") return "none";
  if (robinhood.optionsEnabled && RH_OPTIONS_ONLY) return "options";
  if (robinhood.optionsEnabled) return "both";
  return "equity";
}

function rhUsesOptionsForEntry(cfg) {
  const mode = rhTradeMode(cfg);
  return mode === "options" || mode === "both";
}

function rhUsesEquityForEntry(cfg) {
  const mode = rhTradeMode(cfg);
  return mode === "equity" || mode === "both";
}

async function ensureRhWatchlist() {
  if (!robinhood.isConnected || !robinhood.availableTools.includes("create_watchlist")) return;
  try {
    await robinhood.createWatchlist(RH_WATCHLIST_NAME, "Swing trader serious candidates");
    console.log(`  [RH-WL] Created watchlist "${RH_WATCHLIST_NAME}"`);
  } catch {
    // Already exists or tool unavailable — fine
  }
}

async function addRhWatchlistCandidate({ ticker, optionType, candidate, source = "consideration", force = false }) {
  if (!robinhood.isConnected || (!force && !RH_AUTO_WATCHLIST)) return;
  const sym = (ticker || "").toUpperCase();
  if (!sym) return;

  const equityKey = `E:${sym}`;
  if (!rhWatchlistAdded.has(equityKey)) {
    try {
      await robinhood.addToWatchlist(sym, RH_WATCHLIST_NAME);
      rhWatchlistAdded.add(equityKey);
      console.log(`  [RH-WL] Added ${sym} to "${RH_WATCHLIST_NAME}" (${source})`);
    } catch (e) {
      console.log(`  [RH-WL] Equity watchlist add failed ${sym}: ${e.message}`);
    }
  }

  if (candidate && robinhood.optionsEnabled) {
    const exp = candidate.expiryStr || (candidate.expiryDate ? new Date(candidate.expiryDate).toISOString().slice(0, 10) : null);
    if (!exp) return;
    const occKey = `O:${sym}:${exp}:${candidate.strike}:${optionType}`;
    if (rhWatchlistAdded.has(occKey)) return;
    try {
      await robinhood.addOptionToWatchlist({
        symbol: sym,
        expirationDate: exp,
        strikePrice: candidate.strike,
        optionType,
        watchlist: RH_WATCHLIST_NAME,
      });
      rhWatchlistAdded.add(occKey);
      console.log(`  [RH-WL] Added ${sym} $${candidate.strike} ${optionType} ${exp} to "${RH_WATCHLIST_NAME}" (${source})`);
    } catch (e) {
      console.log(`  [RH-WL] Option watchlist add failed ${sym}: ${e.message}`);
    }
  }
}


// RH_MAX_POSITION_DOLLARS: Maximum dollar amount per Robinhood equity position (safety limit)
const RH_MAX_POSITION_DOLLARS = parseInt(process.env.RH_MAX_POSITION_DOLLARS) || 500;

// ─── Default Account Config ───

const DEFAULT_CONFIG = {
  startingCash: 200,
  goal: 200_000,
  baseRiskPct: 0.08,
  profitTarget: 0.50,
  stopLoss: -0.35,
  bullEntry: 68,
  bearEntry: 32,
  trim1Pct: 0.25,
  trim2Pct: 0.50,
  maxPositions: 6,
  minSetupQuality: 60,
  customPromptSuffix: "",
  // Broker binding: "paper" (simulated) | "tradier" (live, broker is source of truth) | "robinhood"
  broker: "paper",
  // When false, the trust-scaled 50%->25% cash reserve gate is bypassed (per-trade sizing,
  // max positions, sector caps, and DTE staggering still apply). Toggleable per account.
  useCashReserve: true,
  // When true, broker orders execute live with no manual approval step.
  autoExecute: false,
  // When true, this account runs the full trading cycle (entries + exits) even while the market
  // is closed — intended for testing live execution against a broker sandbox on weekends/after hours.
  tradeWhenClosed: false,
  // Margin safety rails: when Tradier reports zero option BP on a margin account, allow a small
  // explicit spend limit without ever planning beyond this max negative-cash floor.
  marginZeroCashSpendLimit: 200,
  marginMaxDebt: 250,
  // ─── Loss circuit breakers (enforced in riskBreakerStatus / evaluateRiskHalts) ───
  // After this many consecutive losing closes, stop opening NEW positions for the rest of the
  // ET day (exits keep running). Streak resets on any winning close and at the next day open.
  maxConsecutiveLosses: 3,
  // If portfolio value drops this fraction below the day's starting value, halt: broker (live)
  // accounts are PAUSED (manual resume; exits keep running via the paused cycle), paper accounts
  // just stop opening new positions for the day. null/0 disables.
  dailyLossLimitPct: 0.15,
  // Hard cap on new entries per ET day. null disables.
  maxDayTrades: null,
  // Optional cap on ticker setups fully preflighted before package ranking. null evaluates every
  // actionable name so rank #1 is global; set a positive cap only when an API budget requires it.
  entryPreflightLimit: null,
  // Which named strategy preset (see LEARNING_VARIANTS) was last applied via the dashboard's
  // strategy toggle, if any. Purely a UI label — the actual behavior lives in the fields above,
  // which the toggle sets directly. null = never used the toggle / since manually edited.
  strategyPreset: null,
  // Synthetic option pricing is not admissible performance evidence. Historical simulations may
  // opt in explicitly for UI experiments, but default/shadow/live ledgers never use it.
  allowSyntheticSimulation: false,
};

// ─── Multi-Account Runtime ───

const accounts = new Map();
const simulations = new Map();
let simIdCounter = 0;

function createAccountRuntime(id, name, config, state) {
  const brokerBinding = sanitizeRuntimeBrokerConfig(id, { ...DEFAULT_CONFIG, ...config });
  const runtime = {
    id,
    name: name || id,
    createdAt: Date.now(),
    paused: false,
    config: brokerBinding.config,
    state: state || {
      cash: brokerBinding.config.startingCash || DEFAULT_CONFIG.startingCash,
      positions: [],
      history: [],

    },
    dashboard: {
      quotes: {},
      analyses: {},
      shortTermAnalyses: {},
      candles: {},
      lastCycle: null,
      cycleLog: [],
      decisionJournal: [],
      marketOpen: false,
      decisions: [],
      positionDetails: [],
      positionManagement: [],
      portfolioHistory: [],
      onDemandAnalyses: {},
    },
    candleCache: {},
    lastCandleDate: null,
    activeHints: [],
    chatHistory: [],
    lastHintContent: "",
    currentRegime: { mode: "unknown", riskScale: 1.0, label: "UNKNOWN" },
    riskPct: brokerBinding.config.baseRiskPct || DEFAULT_CONFIG.baseRiskPct,
    dynamicWatchlist: [],
    tickers: ["SPY", "QQQ"],
    lastWatchlistRefresh: 0,
    lastNewsScan: 0,
    latestNewsBrief: "",
  };
  runtime._brokerBindingChanges = brokerBinding.changes;
  runtime._riskPolicyChanges = applyLiveRiskPolicy(runtime);
  runtime.riskPct = runtime.config.baseRiskPct;
  return runtime;
}

// ─── Learning Lab ───
// Shadow paper accounts spawned from a live (Robinhood) account. Each runs the full trading
// cycle against the SAME market data and watchlist as the parent, but with one strategy knob
// turned — so relative performance across variants is a controlled experiment, collected
// continuously while the real account waits on settlement/capital. LLM-free by design:
// variants trade deterministically on the numeric gates (which ARE the experiment variables).
const LEARNING_VARIANTS = [
  { key: "baseline", name: "Baseline", desc: "parent config, unchanged", tweak: {} },
  { key: "selective", name: "High conviction", desc: "quality ≥75, 4% allocation cap", tweak: { minSetupQuality: 75, baseRiskPct: 0.04 } },
  { key: "loose", name: "Looser filter", desc: "quality ≥45 — more shots", tweak: { minSetupQuality: 45 } },
  { key: "quicktp", name: "Quick profits", desc: "TP +20% / SL -20%, no cash reserve", tweak: { profitTarget: 0.20, stopLoss: -0.20, useCashReserve: false, liveEntriesEnabled: true, singleContractBankPct: 0.20 } },
  { key: "runner", name: "Let it run", desc: "TP +80%, later trims", tweak: { profitTarget: 0.80, trim1Pct: 0.30, trim2Pct: 0.60 } },
  { key: "smallsize", name: "Small size", desc: "2% allocation cap, up to 3 positions", tweak: { baseRiskPct: 0.02, maxPositions: 3 } },
];

// The Learning Lab's "baseline" tweak is intentionally empty (it means "mirror whatever the
// parent account currently has"). That's meaningless as a target for the LIVE strategy toggle
// below — there'd be nothing to switch TO — so give it real default values there instead.
const BASELINE_STRATEGY_TWEAK = {
  goal: DEFAULT_CONFIG.goal,
  bullEntry: 65, bearEntry: 35, minSetupQuality: 50, baseRiskPct: 0.15,
  profitTarget: 0.40, stopLoss: -0.35, trim1Pct: 0.25, trim2Pct: 0.50,
  maxPositions: null,
  useCashReserve: DEFAULT_CONFIG.useCashReserve,
  maxDayTrades: DEFAULT_CONFIG.maxDayTrades,
  dailyLossLimitPct: DEFAULT_CONFIG.dailyLossLimitPct,
  maxConsecutiveLosses: DEFAULT_CONFIG.maxConsecutiveLosses,
};

// Historical deadline target retained only to render old telemetry. It is never offered as a live
// preset: a deadline cannot justify changing portfolio risk.
const MARCH_1M_DEADLINE = "2027-03-01";
const CAPITAL_PRESERVATION_TRACK = {
  key: "capital",
  name: "Capital Preservation",
  desc: "≤0.5% planned loss, ≤10% allocation, 1.5R minimum",
  tweak: {
    baseRiskPct: CAPITAL_PRESERVATION_POLICY.maxPositionPct,
    riskPerTradePct: CAPITAL_PRESERVATION_POLICY.riskPerTradePct,
    maxPortfolioRiskPct: CAPITAL_PRESERVATION_POLICY.maxPortfolioRiskPct,
    maxPositionPct: CAPITAL_PRESERVATION_POLICY.maxPositionPct,
    maxPositions: CAPITAL_PRESERVATION_POLICY.maxPositions,
    useCashReserve: true,
    profitTarget: CAPITAL_PRESERVATION_POLICY.profitTarget,
    stopLoss: CAPITAL_PRESERVATION_POLICY.stopLoss,
    trim1Pct: CAPITAL_PRESERVATION_POLICY.trim1Pct,
    trim2Pct: CAPITAL_PRESERVATION_POLICY.trim2Pct,
    singleContractBankPct: CAPITAL_PRESERVATION_POLICY.singleContractBankPct,
    minimumRewardRisk: CAPITAL_PRESERVATION_POLICY.minimumRewardRisk,
    minSetupQuality: 65,
    bullEntry: 68,
    bearEntry: 32,
    maxDayTrades: CAPITAL_PRESERVATION_POLICY.maxDayTrades,
    dailyLossLimitPct: CAPITAL_PRESERVATION_POLICY.dailyLossLimitPct,
    weeklyLossLimitPct: CAPITAL_PRESERVATION_POLICY.weeklyLossLimitPct,
    highWaterDrawdownLimitPct: CAPITAL_PRESERVATION_POLICY.highWaterDrawdownLimitPct,
    maxConsecutiveLosses: CAPITAL_PRESERVATION_POLICY.maxConsecutiveLosses,
  },
};

function liveStrategyPresets() {
  return [
    ...LEARNING_VARIANTS,
    CAPITAL_PRESERVATION_TRACK,
  ];
}

function tradingDaysBetween(isoStart, isoEnd) {
  const a = new Date(isoStart + "T12:00:00");
  const b = new Date(isoEnd + "T12:00:00");
  if (!(a instanceof Date) || !(b instanceof Date) || isNaN(a) || isNaN(b) || b < a) return 0;
  let n = 0;
  const d = new Date(a);
  while (d <= b) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

function march1mPace(acct, pv) {
  const cfg = acct.config;
  if (cfg.strategyPreset !== "march1m") return null;
  const today = getETDateStr();
  const daysLeft = Math.max(1, tradingDaysBetween(today, MARCH_1M_DEADLINE));
  const goal = cfg.goal || 1_000_000;
  const needDaily = pv > 0 ? Math.pow(goal / pv, 1 / daysLeft) - 1 : 0;
  // This-week proof target: compound ~+4.4%/day for remaining sessions this ET week (Fri close).
  const et = getETDate();
  const dow = et.getDay(); // 0=Sun..5=Fri
  const sessionsLeftThisWeek = dow >= 1 && dow <= 5 ? (5 - dow + 1) : (dow === 0 ? 5 : 0);
  const weekTarget = sessionsLeftThisWeek > 0 ? pv * Math.pow(1.044, sessionsLeftThisWeek) : pv;
  return {
    goal,
    deadline: MARCH_1M_DEADLINE,
    daysLeft,
    needDailyPct: needDaily * 100,
    weekTarget,
    sessionsLeftThisWeek,
    onPace: needDaily <= 0.05, // ≤5%/day required = still in "doable if hot" zone
  };
}

// ─── Live Strategy Preset Toggle ───
// Applies a named preset to a real account's config. Learning-lab variants share the same
// knobs as shadows; March $1M is live-only. Broker / autoExecute / watchlist are left alone.
function applyStrategyPreset(acct, key) {
  const variant = liveStrategyPresets().find(v => v.key === key);
  if (!variant) return { ok: false, reason: `Unknown strategy preset "${key}"` };
  // Every preset starts from a complete live baseline. Applying only the target's sparse tweak
  // leaves dangerous settings behind when switching away from March mode (reserve=false,
  // daily loss=22%, etc.), even though the UI says a different strategy is active.
  const tweak = { ...BASELINE_STRATEGY_TWEAK, ...(key === "baseline" ? {} : variant.tweak) };
  const changes = [];
  for (const [k, v] of Object.entries(tweak)) {
    const before = acct.config[k];
    if (before !== v) changes.push(`${k} ${before} → ${v}`);
    acct.config[k] = v;
  }
  acct.config.strategyPreset = key;
  const policyChanges = applyLiveRiskPolicy(acct);
  if (policyChanges.length) changes.push(...policyChanges.map(change => `${change.key} ${change.before} → ${change.after}`));
  log(acct, `STRATEGY: switched to "${variant.name}" (${variant.desc})${changes.length ? " — " + changes.join(", ") : " — already matched, no fields changed"}`);
  saveAccounts();
  return { ok: true, variant, changes };
}

function ensureCapitalPreservationTrack(acct) {
  if (!acct || acct.learning || acct.config.broker !== "robinhood") return false;
  const pendingChanges = Array.isArray(acct._riskPolicyChanges) ? acct._riskPolicyChanges : [];
  // Sanity + retired-preset migration only. Do NOT re-impose capital rails over user settings.
  const changes = [...pendingChanges, ...applyLiveRiskPolicy(acct)];
  acct._riskPolicyChanges = [];
  if (!changes.length && acct.state._capitalPolicyVersion === 2) return false;
  acct.state._capitalPolicyVersion = 2;
  if (changes.length) {
    log(acct, `LIVE CONFIG: normalized (${changes.map(c => `${c.key} ${c.before}→${c.after}`).join(", ")})`);
  }
  return changes.length > 0;
}

function learningVariantsFor(parentId) {
  return [...accounts.values()].filter(a => a.learning && a.learningParent === parentId);
}

// Create any missing variants for a parent. Idempotent; seeds with the parent's current PV
// (mirroring the real balance) unless an explicit theoretical bankroll is given.
function ensureLearningAccounts(parent, baseCash = null) {
  if (!parent || parent.learning) return;
  const seed = Math.max(50, Math.round(baseCash ?? portfolioValue(parent.state, parent.dashboard?.quotes || {})));
  let spawned = 0;
  for (const v of LEARNING_VARIANTS) {
    const id = `${parent.id}-learn-${v.key}`;
    if (accounts.has(id)) continue;
    const cfg = {
      ...parent.config, ...v.tweak,
      broker: "paper",
      startingCash: seed,
      tradeWhenClosed: false,
      autoExecute: false,
    };
    const acct = createAccountRuntime(`${parent.id}-learn-${v.key}`, `🧠 ${v.name}`, cfg, null);
    acct.learning = true;
    acct.learningParent = parent.id;
    acct.learningKey = v.key;
    acct.state.cash = seed;
    acct.tickers = [...parent.tickers];
    accounts.set(id, acct);
    spawned++;
  }
  if (spawned > 0) {
    log(parent, `LEARNING: spawned ${spawned} variant account(s) seeded at $${seed} — running continuously alongside this account`);
    saveAccounts();
  }
}

function learningStats(v) {
  const closed = (v.state.history || []).filter(t => isAdmissiblePerformanceTrade(t) && typeof t.pnlDollar === "number");
  const wins = closed.filter(t => t.pnlDollar > 0).length;
  const pv = portfolioValue(v.state, v.dashboard?.quotes || {});
  const realized = closed.reduce((s, t) => s + t.pnlDollar, 0);
  return {
    key: v.learningKey, name: v.name, id: v.id,
    pv, startingCash: v.config.startingCash,
    pnlPct: v.config.startingCash > 0 ? (pv - v.config.startingCash) / v.config.startingCash * 100 : 0,
    trades: closed.length, wins,
    winRate: closed.length > 0 ? wins / closed.length * 100 : null,
    realized, open: (v.state.positions || []).length,
  };
}

// Archive a snapshot of every variant's results into the parent (the collected data survives
// resets), then re-seed each variant to the given bankroll with a clean slate.
function resetLearningAccounts(parent, baseCash = null) {
  const variants = learningVariantsFor(parent.id);
  const seed = Math.max(50, Math.round(baseCash ?? portfolioValue(parent.state, parent.dashboard?.quotes || {})));
  if (variants.length > 0) {
    parent.state.learningLog = parent.state.learningLog || [];
    parent.state.learningLog.push({
      ts: Date.now(), date: getETDateStr(),
      variants: variants.map(v => {
        const s = learningStats(v);
        return { key: s.key, name: v.name, pv: +s.pv.toFixed(2), pnlPct: +s.pnlPct.toFixed(1), trades: s.trades, winRate: s.winRate != null ? +s.winRate.toFixed(0) : null };
      }),
    });
    if (parent.state.learningLog.length > 200) parent.state.learningLog = parent.state.learningLog.slice(-200);
  }
  for (const v of variants) {
    v.config.startingCash = seed;
    v.state.cash = seed;
    v.state.positions = [];
    v.state.history = [];
    v.state.meta = {};
    v.state.realizedPnl = 0;
    delete v.state.risk;
    v.dashboard.portfolioHistory = [];
  }
  ensureLearningAccounts(parent, seed); // fill in any missing variants at the same seed
  log(parent, `LEARNING: reset ${Math.max(variants.length, LEARNING_VARIANTS.length)} variants to $${seed}${variants.length > 0 ? " (previous run archived)" : ""}`);
  saveAccounts();
}

function removeLearningAccounts(parent) {
  const variants = learningVariantsFor(parent.id);
  if (variants.length === 0) return;
  resetLearningAccounts(parent); // archives the final snapshot first
  for (const v of learningVariantsFor(parent.id)) accounts.delete(v.id);
  saveAccounts();
}

// ─── Portfolio History Helpers ───

// Push a point onto the portfolio-value series, with dedup/decimation so it can span weeks
// without unbounded growth. Robinhood-style: keep the freshest point per ~minute, plus all
// points where the value changed by more than a tiny threshold (so flat overnight gaps don't
// dominate the buffer).
function appendPortfolioPoint(hist, ts, value) {
  const last = hist[hist.length - 1];
  if (last) {
    const dt = ts - last.ts;
    const dv = Math.abs(value - last.value);
    // Coalesce: if the latest sample is within 60s of the previous AND value barely changed,
    // overwrite it instead of appending. Keeps live updates dense without bloating history.
    if (dt < 60_000 && dv < 0.50) {
      last.ts = ts;
      last.value = value;
      return;
    }
  }
  hist.push({ ts, value });
  // Hard ceiling: 20k points (~14 days at 1/min, or weeks if coalesced). Drop the oldest.
  if (hist.length > 20000) hist.splice(0, hist.length - 20000);
}

// ─── Dashboard Auth (server-side password gate) ───

// Password for the whole dashboard. Set DASHBOARD_PASSWORD in the environment for production;
// falls back to the legacy PIN so existing deploys keep working until it's set.
const DASHBOARD_PASSWORD = (process.env.DASHBOARD_PASSWORD || "1738").trim();
const AUTH_COOKIE = "st_auth";
// Session token derived from the password (+ optional secret). Changing the password invalidates
// all existing sessions. Not reversible to the password.
const AUTH_SECRET = process.env.AUTH_SECRET || `swingtrader::${DASHBOARD_PASSWORD}`;
function authToken() {
  return crypto.createHmac("sha256", AUTH_SECRET).update("dashboard-session-v1").digest("hex").slice(0, 40);
}
function spectatorToken() {
  return crypto.createHmac("sha256", AUTH_SECRET).update("dashboard-spectator-v1").digest("hex").slice(0, 40);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authRole(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (token === authToken()) return "admin";
  if (token === spectatorToken()) return "spectator";
  return null;
}
function isAuthed(req) {
  return !!authRole(req);
}
function loginPageHTML(error = "") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign in · Swing Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f7f8fa;color:#1c1d22;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .box{background:#fff;border:1px solid #e7e8ec;border-radius:16px;padding:32px 28px;width:100%;max-width:360px;box-shadow:0 6px 24px rgba(0,0,0,.05)}
  h1{font-size:20px;font-weight:700;margin-bottom:6px}
  p{color:#6b7280;font-size:13px;margin-bottom:20px}
  label{display:block;font-size:12px;color:#6b7280;margin-bottom:6px}
  input{width:100%;padding:13px 14px;border:1px solid #d7d9e0;border-radius:10px;font-size:16px;color:#1c1d22;background:#fff;outline:none}
  input:focus{border-color:#00c805;box-shadow:0 0 0 3px #00c80522}
  button{width:100%;margin-top:16px;padding:13px;border:none;border-radius:10px;background:#00c805;color:#1c1d22;font-size:15px;font-weight:700;cursor:pointer}
  button:hover{background:#00b104}
  .spectator{background:#eef1f4;color:#3a3b42;border:1px solid #d7d9e0}
  .spectator:hover{background:#e3e6ea}
  .divider{display:flex;align-items:center;gap:10px;color:#a0a6b2;font-size:11px;margin:18px 0 0}
  .divider:before,.divider:after{content:"";height:1px;background:#e7e8ec;flex:1}
  .note{font-size:11px;color:#8a909b;margin-top:8px;line-height:1.4}
  .err{color:#e8473f;font-size:12px;margin-top:12px;text-align:center}
</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>🔒 Swing Trader</h1>
    <p>Enter your password to manage the portfolio, or watch read-only as a spectator.</p>
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus inputmode="numeric">
    <button type="submit">Sign in</button>
    <div class="divider">or</div>
    <button class="spectator" type="submit" name="mode" value="spectator">Watch as spectator</button>
    <div class="note">Spectator mode can view dashboards only. Settings, broker tokens, order controls, notifications, and AI prompts are blocked server-side.</div>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</body></html>`;
}

// ─── Account Persistence ───

function loadAccounts() {
  // Try accounts.json first
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
      if (data.meta && data.accounts) {
        let brokerBindingSanitized = false;
        for (const [id, acctData] of Object.entries(data.accounts)) {
          const acct = createAccountRuntime(id, acctData.name, acctData.config, acctData.state);
          if (acct._brokerBindingChanges?.length) {
            brokerBindingSanitized = true;
            console.warn(`  [${id}] BROKER BINDING SANITIZED: ${acct._brokerBindingChanges.map(change => `${change.key} ${change.before} → ${change.after}`).join(", ")}`);
          }
          acct.paused = acctData.paused || false;
          acct.pausedBy = acctData.pausedBy || (acctData.paused ? "user" : null);
          acct.learning = acctData.learning || false;
          acct.learningParent = acctData.learningParent || null;
          acct.learningKey = acctData.learningKey || null;
          acct.createdAt = acctData.createdAt || Date.now();
          if (Array.isArray(acctData.tickers)) acct.tickers = acctData.tickers.filter(isValidTickerSymbol);
          if (Array.isArray(acctData.dynamicWatchlist)) acct.dynamicWatchlist = acctData.dynamicWatchlist.filter(isValidTickerSymbol);
          if (Array.isArray(acctData.activeHints)) acct.activeHints = acctData.activeHints.filter(h => h && isValidTickerSymbol(h.ticker) && h.expiresAt > Date.now());
          if (Array.isArray(acctData.chatHistory)) acct.chatHistory = acctData.chatHistory.slice(-60);
          if (acctData.badTickers && typeof acctData.badTickers === "object") acct.badTickers = acctData.badTickers;
          if (typeof acctData.lastHintContent === "string") acct.lastHintContent = acctData.lastHintContent;
          if (typeof acctData.lastWatchlistRefresh === "number") acct.lastWatchlistRefresh = acctData.lastWatchlistRefresh;
          if (typeof acctData.lastNewsScan === "number") acct.lastNewsScan = acctData.lastNewsScan;
          if (typeof acctData.latestNewsBrief === "string") acct.latestNewsBrief = acctData.latestNewsBrief;
          // Restore the persisted portfolio-value chart series across restarts/redeploys.
          if (Array.isArray(acctData.portfolioHistory)) acct.dashboard.portfolioHistory = acctData.portfolioHistory;
          if (Array.isArray(acctData.decisionJournal)) acct.dashboard.decisionJournal = acctData.decisionJournal.slice(-500);
          accounts.set(id, acct);
        }
        if (brokerBindingSanitized) saveAccounts();
        return true;
      }
    }
  } catch (e) {
    console.error(`WARN: Failed to load accounts.json — ${e.message}`);
  }

  // Migrate from state.json
  try {
    if (fs.existsSync(STATE_FILE)) {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (old && typeof old.cash === "number") {
        const config = { ...DEFAULT_CONFIG, startingCash: DEFAULT_CONFIG.startingCash };
        const state = {
          cash: old.cash,
          positions: old.positions || [],
          history: old.history || [],

        };
        const acct = createAccountRuntime("default", "Original Strategy", config, state);
        accounts.set("default", acct);

        // Backup old state.json
        try {
          fs.copyFileSync(STATE_FILE, STATE_FILE + ".backup");
        } catch { }

        // Save as accounts.json
        saveAccounts();
        console.log("Migrated state.json → accounts.json (backup saved as state.json.backup)");
        return true;
      }
    }
  } catch (e) {
    console.error(`WARN: Failed to migrate state.json — ${e.message}`);
  }

  return false;
}

function saveAccounts({ strict = false } = {}) {
  const data = { meta: { version: 1 }, accounts: {} };
  for (const [id, acct] of accounts) {
    data.accounts[id] = {
      id: acct.id,
      name: acct.name,
      createdAt: acct.createdAt,
      paused: acct.paused,
      pausedBy: acct.pausedBy || null,
      learning: acct.learning || false,
      learningParent: acct.learningParent || null,
      learningKey: acct.learningKey || null,
      config: acct.config,
      state: acct.state,
      tickers: (acct.tickers || []).filter(isValidTickerSymbol),
      dynamicWatchlist: (acct.dynamicWatchlist || []).filter(isValidTickerSymbol),
      activeHints: (acct.activeHints || []).filter(h => h && isValidTickerSymbol(h.ticker) && h.expiresAt > Date.now()).slice(-100),
      chatHistory: (acct.chatHistory || []).slice(-60),
      badTickers: acct.badTickers || {},
      lastHintContent: acct.lastHintContent || "",
      lastWatchlistRefresh: acct.lastWatchlistRefresh || 0,
      lastNewsScan: acct.lastNewsScan || 0,
      latestNewsBrief: acct.latestNewsBrief || "",
      // Persist the portfolio-value series so the chart survives server restarts/redeploys
      // (previously it lived only in memory and reset every deploy). Capped to bound file size.
      portfolioHistory: (acct.dashboard?.portfolioHistory || []).slice(-10000),
      // Keep recent entry-rank outcomes across restarts (Jul 13 postmortem: cycle decisions vanished).
      decisionJournal: (acct.dashboard?.decisionJournal || []).slice(-500),
    };
  }
  const tmpFile = `${ACCOUNTS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    const fd = fs.openSync(tmpFile, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmpFile, ACCOUNTS_FILE);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { }
    console.error(`WARN: Failed to save accounts — ${e.message}`);
    if (strict) throw new Error(`durable account-state write failed: ${e.message}`);
    return false;
  }
}

function saveAccountsStrict() {
  return saveAccounts({ strict: true });
}

// ─── Logging ───

function log(acct, msg) {
  if (typeof acct === "string") {
    // Called as log("msg") — global log without account context
    msg = acct;
    const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    const line = `[${now}] ${msg}`;
    console.log(line);
    return;
  }
  const now = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const prefix = accounts.size > 1 ? `[${acct.id}] ` : "";
  const line = `[${now}] ${prefix}${msg}`;
  console.log(line);
  acct.dashboard.cycleLog.push(line);
  if (acct.dashboard.cycleLog.length > 800) acct.dashboard.cycleLog.shift();
}

// Append-only trade log for Monte Carlo training
function logTrade(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync("trades.log", line);
  } catch { }
}

// ─── Structured diagnostics (agent-readable) ───
// One JSON object per line in diagnostics.jsonl. This is deliberately LOW-VOLUME: only
// decision-level (entry/exit) and anomaly-level (clock flip, risk halt, data-quality, error)
// events are recorded — never per-ticker scan spam — so an agent can diagnose logic/data errors
// days later by reading the file end-to-end without drowning in noise.
//
// Event shape: { ts, iso, et, type, acct, marketOpen, clock, ...payload }
// Types:
//   entry       — a position was opened (intended limit, mid, bid/ask, delta, downgrade info)
//   exit_submit — a sell order was sent (reason, intended limit, mark source, spread)
//   exit_fill   — a sell reconciled to the REAL fill (est vs actual close, slippage, net P&L)
//   clock       — market state transitioned (old→new, source, detection latency)
//   risk_halt   — capital-preservation halt engaged/cleared
//   data        — data-quality anomaly during sync (model marks, stale feed, pending orders)
//   error       — a caught exception with context
const DIAG_LOG_FILE = "diagnostics.jsonl";
const DIAG_MAX_LINES = 3000;
let _diagAppendsSinceTrim = 0;

function diag(type, acct, payload = {}) {
  try {
    const evt = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      et: new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }),
      acct: typeof acct === "string" ? acct : (acct?.id ?? null),
      marketOpen: isMarketOpen(),
      clock: _marketClock.source === "tradier" ? (_marketClock.state || "?") : "local",
      ...payload,
      type, // set last — payloads for option entries/exits carry their own "type" (call/put) that
            // would otherwise silently overwrite the event kind (e.g. "entry" events were being
            // filed as "call"/"put", making /api/diagnostics?type=entry return nothing)
    };
    fs.appendFileSync(DIAG_LOG_FILE, JSON.stringify(evt) + "\n");
    // Trim lazily — every 250 appends rewrite the tail so the file stays bounded.
    if (++_diagAppendsSinceTrim >= 250) {
      _diagAppendsSinceTrim = 0;
      try {
        const lines = fs.readFileSync(DIAG_LOG_FILE, "utf8").split("\n").filter(Boolean);
        if (lines.length > DIAG_MAX_LINES) {
          fs.writeFileSync(DIAG_LOG_FILE, lines.slice(-DIAG_MAX_LINES).join("\n") + "\n");
        }
      } catch { }
    }
  } catch { }
}

// Read recent diagnostics back (newest-first) for the API/agent. Optional type filter.
function readDiagnostics(limit = 200, typeFilter = null) {
  try {
    const lines = fs.readFileSync(DIAG_LOG_FILE, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (!typeFilter || e.type === typeFilter) out.push(e);
      } catch { }
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Claude Call History (persisted 3-day rolling log) ───
const CLAUDE_LOG_FILE = "claude-log.json";
const CLAUDE_LOG_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function loadClaudeLog() {
  try {
    const raw = fs.readFileSync(CLAUDE_LOG_FILE, "utf8");
    const entries = JSON.parse(raw);
    const cutoff = Date.now() - CLAUDE_LOG_TTL_MS;
    return Array.isArray(entries) ? entries.filter(e => e.ts > cutoff) : [];
  } catch {
    return [];
  }
}

function logClaudeCall(entry) {
  try {
    const entries = loadClaudeLog();
    entries.push({ ...entry, ts: Date.now() });
    fs.writeFileSync(CLAUDE_LOG_FILE, JSON.stringify(entries));
  } catch {}
}

// ─── X (Twitter) Integration ───

const ENABLE_TWEETS = process.env.ENABLE_TWEETS === "true";
const X_DAILY_CAP = parseInt(process.env.X_DAILY_CAP) || 30;

// ─── Chrome Web Push Notifications ───
// No external accounts needed — browser-native push via the dashboard.
// VAPID keys are auto-generated on first run and saved to vapid-keys.json.

const VAPID_FILE = "vapid-keys.json";
const PUSH_SUBS_FILE = "push-subscriptions.json";
let _vapidKeys = null;
let pushSubscriptions = [];

function getVapidKeys() {
  if (_vapidKeys) return _vapidKeys;
  if (fs.existsSync(VAPID_FILE)) {
    _vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
  } else {
    _vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(_vapidKeys));
    console.log("  [PUSH] Generated VAPID keys → vapid-keys.json");
  }
  webpush.setVapidDetails(
    "mailto:bot@localhost",
    _vapidKeys.publicKey,
    _vapidKeys.privateKey
  );
  return _vapidKeys;
}

function loadPushSubs() {
  if (fs.existsSync(PUSH_SUBS_FILE)) {
    try { pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8")); } catch { }
  }
}

function savePushSubs() {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2));
}

async function sendPush(title, message, urgent = false) {
  if (pushSubscriptions.length === 0) return;
  getVapidKeys(); // ensure webpush is initialized
  const tag = `bot-${Date.now()}`;
  const payload = JSON.stringify({ title, body: message, urgent, tag });
  const dead = [];
  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        console.log(`  [PUSH] Subscription expired (${sub.endpoint.slice(-20)}), removing`);
        dead.push(sub.endpoint);
      } else {
        console.log(`  [PUSH] Send error (${e.statusCode || e.code}): ${e.message}`);
      }
    }
  }
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter(s => !dead.includes(s.endpoint));
    savePushSubs();
  }
}
let xClient = null;
let xTweetCount = 0;
let xTweetDate = null;
let lastWatchlistTweetDate = null;

function initTwitterClient() {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log("  X/Twitter: Missing API keys — tweeting disabled (dry-run logs only)");
    return null;
  }
  try {
    const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
    console.log("  X/Twitter: Client initialized ✓");
    return client;
  } catch (e) {
    console.log(`  X/Twitter: Init failed — ${e.message}`);
    return null;
  }
}

function canTweet() {
  const today = getETDateStr();
  if (xTweetDate !== today) { xTweetCount = 0; xTweetDate = today; }
  return xTweetCount < X_DAILY_CAP;
}

async function tweetWithChart(text, pngBuffer) {
  if (!canTweet()) { console.log(`  [X] Daily cap reached (${X_DAILY_CAP}), skipping tweet`); return; }
  if (!ENABLE_TWEETS || !xClient) {
    console.log(`  [X DRY-RUN] ${text.slice(0, 120)}...`);
    if (pngBuffer) console.log(`  [X DRY-RUN] (chart image: ${(pngBuffer.length / 1024).toFixed(0)}KB)`);
    return;
  }
  try {
    if (pngBuffer) {
      const mediaId = await xClient.v1.uploadMedia(pngBuffer, { mimeType: "image/png" });
      await xClient.v2.tweet({ text, media: { media_ids: [mediaId] } });
    } else {
      await xClient.v2.tweet({ text });
    }
    xTweetCount++;
    console.log(`  [X] Tweeted (${xTweetCount}/${X_DAILY_CAP} today)`);
  } catch (e) {
    console.log(`  [X] Tweet failed — ${e.message}`);
  }
}

function renderChartPNG(candles, ticker, analysis, shortTermAnalysis, quote, opts = {}) {
  if (!candles || candles.length < 3) return null;
  try {
    const W = 1100, H = 500, PAD = 50;
    // When a projection is supplied we reserve a band on the right for the forecast path/targets,
    // so the candles compress into the left ~78% and the projection reads as "the road ahead".
    const proj = opts.projection || null;
    const FUTURE = proj ? 230 : 0;
    const cls = candles.map(c => c.c), hs = candles.map(c => c.h), ls = candles.map(c => c.l), vs = candles.map(c => c.v);
    const emas = [
      { period: 8, color: "#138f86", label: "EMA 8", data: calcEMA(cls, 8) },
      { period: 21, color: "#d2691e", label: "EMA 21", data: calcEMA(cls, 21) },
      { period: 50, color: "#6a4df4", label: "EMA 50", data: calcEMA(cls, 50) },
    ];
    const projLevels = proj ? [proj.trigger, proj.target].filter(v => v > 0) : [];
    const allP = [...hs, ...ls, ...projLevels];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 40) - 20;
    const x = i => PAD + (i / Math.max(1, cls.length - 1)) * (W - PAD - FUTURE);

    // Candlestick bars
    const bars = candles.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00a843" : "#e8473f";
      const bw = Math.max(4, (W - PAD) / candles.length - 1.5);
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bot - top);
      return `<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1"/>
        <rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${bodyH}" fill="${color}" rx="0.5"/>`;
    }).join("");

    // EMA overlay paths
    const emaPaths = emas.map(e =>
      `<path d="${e.data.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${e.color}" stroke-width="2" opacity="0.85"/>`
    ).join("");

    // Projection layer: trigger/target levels + a forecast path from "now" to the target.
    let projection = "";
    if (proj) {
      const lastClose = cls[cls.length - 1];
      const xNow = x(cls.length - 1);
      const xEnd = W - 12;
      const tgtColor = proj.isCall ? "#00a843" : "#e8473f";
      const level = (val, color, label) =>
        `<line x1="${PAD}" y1="${y(val)}" x2="${xEnd}" y2="${y(val)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="7 5" opacity="0.9"/>
         <text x="${xEnd}" y="${y(val) - 6}" fill="${color}" font-size="14" font-weight="bold" font-family="monospace" text-anchor="end">${label} $${fmtNum(val)}</text>`;
      const midY = (y(lastClose) + y(proj.target)) / 2;
      projection = `
        ${level(proj.trigger, "#b07400", proj.isCall ? "BREAK OVER" : "BREAK UNDER")}
        ${level(proj.target, tgtColor, "TARGET")}
        <line x1="${xNow}" y1="${20}" x2="${xNow}" y2="${H}" stroke="#9aa1ad" stroke-width="1" stroke-dasharray="2 4" opacity="0.5"/>
        <path d="M${xNow},${y(lastClose)} L${xEnd - 14},${y(proj.target)}" fill="none" stroke="${tgtColor}" stroke-width="3" stroke-dasharray="3 5" opacity="0.95"/>
        <circle cx="${xNow}" cy="${y(lastClose)}" r="5" fill="${tgtColor}"/>
        <polygon points="${xEnd - 16},${y(proj.target) - 7} ${xEnd},${y(proj.target)} ${xEnd - 16},${y(proj.target) + 7}" fill="${tgtColor}"/>
        <text x="${(xNow + xEnd) / 2}" y="${midY - 10}" fill="${tgtColor}" font-size="13" font-weight="bold" font-family="monospace" text-anchor="middle">${proj.contract || proj.expLabel || ""}</text>`;
    }

    // Event markers: vertical lines at specific dates (e.g. entry IN / exit OUT on a trade recap).
    let events = "";
    if (opts.events && opts.events.length) {
      const dayKey = ts => new Date((ts || 0) * 1000).toISOString().slice(0, 10);
      events = opts.events.map(ev => {
        if (!ev || !ev.date) return "";
        let idx = -1, best = Infinity;
        candles.forEach((c, i) => { const d = Math.abs(new Date(dayKey(c.t)) - new Date(ev.date)); if (d < best) { best = d; idx = i; } });
        if (idx < 0) return "";
        const xx = x(idx);
        const anchor = idx > candles.length * 0.7 ? "end" : "start";
        const tx = anchor === "end" ? xx - 5 : xx + 5;
        return `<line x1="${xx.toFixed(1)}" y1="18" x2="${xx.toFixed(1)}" y2="${H}" stroke="${ev.color}" stroke-width="2" stroke-dasharray="4 3" opacity="0.9"/>
          <text x="${tx.toFixed(1)}" y="36" fill="${ev.color}" font-size="15" font-weight="bold" font-family="monospace" text-anchor="${anchor}">${ev.label}</text>`;
      }).join("");
    }

    // Price labels on right side
    const pLabels = [mn, mn + rng * 0.25, mn + rng * 0.5, mn + rng * 0.75, mx].map(p =>
      `<text x="${W + 8}" y="${y(p)}" fill="#6b7280" font-size="11" font-family="monospace" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    // Volume bars at bottom
    const maxV = Math.max(...vs);
    const avgV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const VH = 60;
    const volBars = vs.map((v, i) => {
      const bw = Math.max(4, (W - PAD) / vs.length - 1.5);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw / 2}" y="${H + 20 + VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00a8433a' : '#00000016'}" rx="0.5"/>`;
    }).join("");

    // Info overlay
    const score = analysis?.score ?? "?";
    const signal = analysis?.signal ?? "?";
    const rsi = analysis?.rsi?.toFixed(1) ?? "?";
    const stScore = shortTermAnalysis?.score ?? "?";
    const price = quote?.c?.toFixed(2) ?? "?";
    const chg = quote?.dp != null ? `${quote.dp >= 0 ? "+" : ""}${quote.dp.toFixed(1)}%` : "";
    const chgColor = (quote?.dp ?? 0) >= 0 ? "#00a843" : "#e8473f";
    const scoreColor = score >= 65 ? "#00a843" : score <= 35 ? "#e8473f" : "#b07400";

    const signalsList = [
      ...(analysis?.sigs?.slice(0, 3)?.map(s => s.text) || []),
      ...(shortTermAnalysis?.sigs?.slice(0, 2)?.map(s => `[7d] ${s.text}`) || []),
    ];
    const signalsText = signalsList.map((s, i) =>
      `<text x="20" y="${H + VH + 70 + i * 18}" fill="#6b7280" font-size="12" font-family="monospace">• ${s.length > 60 ? s.slice(0, 57) + "..." : s}</text>`
    ).join("");

    // EMA legend
    const legendY = 30;
    const legend = emas.map((e, i) =>
      `<rect x="${20 + i * 130}" y="${legendY - 6}" width="12" height="3" fill="${e.color}" rx="1"/>
       <text x="${36 + i * 130}" y="${legendY}" fill="${e.color}" font-size="11" font-family="monospace">${e.label} (${e.data[e.data.length - 1]?.toFixed(2) ?? "?"})</text>`
    ).join("");

    const totalH = H + VH + 40 + signalsList.length * 18 + 20;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${totalH}" viewBox="0 0 1200 ${totalH}">
      <rect width="1200" height="${totalH}" fill="#f6f7f9" rx="12"/>
      <text x="20" y="22" fill="#1c1d22" font-size="18" font-weight="bold" font-family="monospace">$${ticker}</text>
      <text x="${20 + ticker.length * 12 + 10}" y="22" fill="#6b7280" font-size="14" font-family="monospace">$${price}</text>
      <text x="${20 + ticker.length * 12 + 80}" y="22" fill="${chgColor}" font-size="14" font-family="monospace">${chg}</text>
      <text x="${W - 20}" y="22" fill="${scoreColor}" font-size="16" font-weight="bold" font-family="monospace" text-anchor="end">Score: ${score}/100 ${signal}</text>
      <text x="${W + 60}" y="22" fill="#6b7280" font-size="12" font-family="monospace">RSI: ${rsi} | 7d: ${stScore}</text>
      ${legend}
      <g transform="translate(0, 10)">
        ${bars}
        ${emaPaths}
        ${projection}
        ${events}
        ${pLabels}
        ${volBars}
      </g>
      <line x1="20" y1="${H + VH + 40}" x2="${W + 60}" y2="${H + VH + 40}" stroke="#e3e6ea" stroke-width="1"/>
      <text x="20" y="${H + VH + 58}" fill="#6b7280" font-size="11" font-family="monospace">Key Signals:</text>
      ${signalsText}
    </svg>`;

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
    const rendered = resvg.render();
    return rendered.asPng();
  } catch (e) {
    console.log(`  [X] Chart render failed for ${ticker}: ${e.message}`);
    return null;
  }
}

async function tweetTradeEntry(acct, result, analysis, shortTermAnalysis, quote) {
  const signals = [
    ...(analysis?.sigs?.slice(0, 2)?.map(s => s.text) || []),
    ...(shortTermAnalysis?.sigs?.slice(0, 1)?.map(s => `[7d] ${s.text}`) || []),
  ].join(", ");
  const stScore = shortTermAnalysis?.score ?? "?";
  const ltScore = analysis ? Math.round(50 + (analysis.bullScore - analysis.bearScore) / 2) : "?";
  const text = `🟢 $${result.ticker} — Entered $${result.strike} ${result.type.toUpperCase()} ${result.dte}DTE

Blended: ${analysis?.score ?? "?"}/100 (7d:${stScore} 90d:${ltScore})
RSI: ${analysis?.rsi?.toFixed(1) ?? "?"} | Setup: ${result.setupQuality}/100
Signals: ${signals || "Multiple confirmations"}
Claude: APPROVED (${result.claudeConfidence}%)

#SwingTrader #Options`;

  const chart = renderChartPNG(acct.candleCache[result.ticker], result.ticker, analysis, shortTermAnalysis, quote);
  await tweetWithChart(text, chart);
}

async function tweetTradeExit(acct, pos, trade) {
  const emoji = trade.pnlPct >= 0 ? "💰" : "🔴";
  const pnlStr = `${trade.pnlPct >= 0 ? "+" : ""}${(trade.pnlPct * 100).toFixed(0)}%`;
  const held = ((Date.now() - pos.openTime) / 86400_000).toFixed(1);
  const trimLabel = trade.qty < pos.qty ? `Trimmed ${trade.qty}/${pos.qty}` : "Closed";
  const text = `${emoji} $${pos.ticker} — ${trimLabel} $${pos.strike} ${pos.type.toUpperCase()} ${pnlStr}

Held ${held} days | ${trade.reason}
Setup: ${pos.setupQuality ?? "?"}/100 | Claude: ${pos.claudeConfidence ?? "?"}%

#SwingTrader #Options`;

  await tweetWithChart(text, null);
}

async function tweetWatchlistSummary(acct, decisions, regime) {
  const today = getETDateStr();
  if (lastWatchlistTweetDate === today) return;
  lastWatchlistTweetDate = today;

  const bulls = decisions.filter(d => d.finalScore >= 65).sort((a, b) => b.finalScore - a.finalScore).slice(0, 5);
  const bears = decisions.filter(d => d.finalScore <= 35).sort((a, b) => a.finalScore - b.finalScore).slice(0, 3);
  const neutral = decisions.filter(d => d.finalScore > 35 && d.finalScore < 65 && d.finalScore >= 50).sort((a, b) => b.finalScore - a.finalScore).slice(0, 3);

  if (bulls.length === 0 && bears.length === 0) return;

  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let text = `📊 Watchlist Update — ${date}\n\n`;
  if (bulls.length) text += `🟢 ${bulls.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  if (bears.length) text += `🔴 ${bears.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  if (neutral.length) text += `⏳ ${neutral.map(d => `${d.ticker} ${d.finalScore}`).join(" | ")}\n`;
  text += `\nRegime: ${regime?.mode?.toUpperCase() ?? "?"} | ${acct.state.positions.length} positions open\n\n#SwingTrader #Watchlist`;

  // Render chart for top bull ticker if available
  let chart = null;
  if (bulls.length > 0) {
    const topTicker = bulls[0].ticker;
    const topAnalysis = acct.dashboard.analyses[topTicker];
    const topST = acct.dashboard.shortTermAnalyses[topTicker];
    const topQuote = acct.dashboard.quotes[topTicker];
    chart = renderChartPNG(acct.candleCache[topTicker], topTicker, topAnalysis, topST, topQuote);
  }
  await tweetWithChart(text, chart);
}

// ─── Media / Social composer (manual now, automatable later) ───
// Turns the live technicals into SRxTrades-style trade-plan lines and standalone per-ticker
// captions, plus the projection levels (trigger + target) used to annotate the share chart.

// Strip trailing zeros so levels read like a human wrote them ("400", "28.5", "372.4", "24.17").
function fmtNum(v) {
  if (v == null || !isFinite(v)) return "?";
  const s = (+v).toFixed(2);
  return s.replace(/\.?0+$/, "");
}

function niceStrikeIncrement(price) {
  if (price < 5) return 0.5;
  if (price < 25) return 1;
  if (price < 75) return 2.5;
  if (price < 150) return 5;
  if (price < 400) return 10;
  if (price < 1000) return 25;
  return 50;
}
function roundStrike(price, dir = "near") {
  const inc = niceStrikeIncrement(price);
  const n = price / inc;
  const r = dir === "up" ? Math.ceil(n) : dir === "down" ? Math.floor(n) : Math.round(n);
  return +(r * inc).toFixed(2);
}

// Build the trade idea (plan line + caption + projection) for one ticker. Returns null if thin data.
function buildMediaIdea(ticker, analysis, st, quote, candles) {
  if (!analysis || !quote || !(quote.c > 0)) return null;
  if (!candles || candles.length < 15) return null;
  const price = quote.c;
  const cons = candles ? detectConsolidation(candles) : null;
  const mom = candles ? detectMomentumQuality(candles) : null;

  const bullish = analysis.score >= 55 || (analysis.aligned && (st?.aligned ?? false));
  const bearish = analysis.score <= 35 || analysis.bearish;
  const isCall = bullish && !bearish ? true : bearish && !bullish ? false : analysis.score >= 50;

  const recentHigh = st?.recentHigh ?? Math.max(...candles.slice(-10).map(c => c.h));
  const recentLow = st?.recentLow ?? Math.min(...candles.slice(-10).map(c => c.l));
  const trigger = isCall ? Math.max(recentHigh, price) : Math.min(recentLow, price);

  // Target: ATR-projected move in the trade direction, clamped to a sensible swing.
  const atr = analysis.atr || price * 0.02;
  const target = isCall ? Math.max(price + atr * 3, trigger * 1.05) : Math.min(price - atr * 3, trigger * 0.95);
  const targetRound = roundStrike(target, isCall ? "down" : "up"); // clean round number near the target

  const exp = nextFridayExpiry(30); // ~monthly Friday
  const expLabel = exp.date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const strike = isCall ? roundStrike(Math.max(target, trigger), "up") : roundStrike(Math.min(target, trigger), "down");
  const cType = isCall ? "c" : "p";

  const planLine = isCall
    ? `$${ticker} break over ${fmtNum(trigger)}, ${fmtNum(strike)}c ${expLabel} → to target: $${fmtNum(targetRound)}+`
    : `$${ticker} break under ${fmtNum(trigger)}, ${fmtNum(strike)}p ${expLabel} → to target: $${fmtNum(targetRound)}`;

  const caption = buildCaptionText(ticker, { isCall, analysis, st, cons, mom, price, trigger, target: targetRound, recentHigh });

  return {
    ticker, isCall, dir: isCall ? "bullish" : "bearish", price: +price.toFixed(2),
    trigger: +trigger.toFixed(2), target: +targetRound.toFixed(2),
    strike, expLabel, contract: `${fmtNum(strike)}${cType} ${expLabel}`,
    score: analysis.score, planLine, caption,
  };
}

// Narrative caption in the chart-poster style, derived from the technical read.
function buildCaptionText(ticker, ctx) {
  const { isCall, analysis, st, cons, mom, price, trigger, target, recentHigh } = ctx;
  const emas = [{ n: 8, v: analysis.ema8v }, { n: 21, v: analysis.ema21v }, { n: 50, v: analysis.ema50v }].filter(e => e.v > 0);
  let ride = null;
  if (isCall) ride = emas.filter(e => e.v <= price).sort((a, b) => b.v - a.v)[0] || emas[0];
  else ride = emas.filter(e => e.v >= price).sort((a, b) => a.v - b.v)[0] || emas[0];
  const emaWk = ride ? `${ride.n}-week EMA` : "key moving average";

  const vr = st?.vr ?? analysis.vr ?? 1;
  const volPhrase = vr < 0.85 ? "on decreasing volume" : vr > 1.25 ? "on expanding volume" : "with steady volume";
  const tight = cons && cons.quality >= 55;

  let setup;
  if (isCall) {
    if (tight && vr < 0.95) setup = `Picture-perfect flag off the ${emaWk} ${volPhrase}.`;
    else if (analysis.aligned && (st?.mom7d ?? 0) > 0) setup = `Clean uptrend riding the ${emaWk} — higher highs, higher lows ${volPhrase}.`;
    else if (st?.nearHigh) setup = `Coiling just under the ${fmtNum(recentHigh)} highs, ${emaWk} holding as support.`;
    else setup = `Basing above the ${emaWk}, setting up for the next leg.`;
  } else {
    if (analysis.bearish) setup = `Breaking down through the ${emaWk}, momentum rolling over ${volPhrase}.`;
    else setup = `Losing the ${emaWk} — lower highs building in.`;
  }

  const triggerLine = isCall
    ? `Break over ${fmtNum(trigger)} opens the door to $${fmtNum(target)}+.`
    : `Lose ${fmtNum(trigger)} and $${fmtNum(target)} is in play.`;
  const closer = isCall
    ? ((st?.mom7d ?? 0) > 3 ? "Feels like this name is not done yet." : "Watching for the breakout.")
    : "Watching the breakdown.";

  return `$${ticker}\n\n${setup}\n\n${triggerLine}\n\n${closer}`;
}

// Assemble the dated "Trade plan" post from a set of ideas.
function buildTradePlanText(ideas) {
  const date = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
  return `Trade plan ${date}\n\n${ideas.map(i => i.planLine).join("\n\n")}`;
}

// Gather the tickers worth featuring this week: open positions first, then top watchlist scorers.
function gatherMediaIdeas(acct, { featured = null, max = 12 } = {}) {
  const dash = acct.dashboard;
  const seen = new Set();
  const order = [];
  const add = t => { const u = (t || "").toUpperCase(); if (u && !seen.has(u)) { seen.add(u); order.push(u); } };
  if (featured) add(featured);
  for (const p of acct.state.positions) add(p.ticker);
  // Watchlist names ranked by |score-50| (strongest directional reads), excluding SPY/QQQ.
  const ranked = Object.entries(dash.analyses || {})
    .filter(([t, a]) => a && t !== "SPY" && t !== "QQQ")
    .sort((a, b) => Math.abs((b[1].score ?? 50) - 50) - Math.abs((a[1].score ?? 50) - 50))
    .map(([t]) => t);
  for (const t of ranked) add(t);

  const ideas = [];
  for (const t of order) {
    if (ideas.length >= max) break;
    const idea = buildMediaIdea(t, dash.analyses?.[t], dash.shortTermAnalyses?.[t], dash.quotes?.[t], acct.candleCache?.[t]);
    if (idea) ideas.push(idea);
  }
  return ideas;
}

// ─── Closed-trade recaps (the "here's what I saw, here's what it did" post) ───
function closedTradeKey(t) {
  return [t.ticker, t.strike, t.type, t.openDate || "", t.closeDate || "", Math.round(t.pnlDollar || 0)].join("|");
}
function gatherClosedTrades(acct, max = 12) {
  const hist = (acct.state.history || []).filter(t => isAdmissiblePerformanceTrade(t)
    && !t._pendingFill && t.pnlDollar != null && t.closePremium != null && t.entryPremium != null);
  return hist.slice(-max).reverse(); // newest first
}
function findClosedTrade(acct, key) {
  return (acct.state.history || []).find(t => closedTradeKey(t) === key) || null;
}
function tradeHoldLabel(t) {
  let ms = null;
  if (t.openTime && t.closeTime) ms = t.closeTime - t.openTime;
  else if (t.openDate && t.closeDate) ms = new Date(t.closeDate) - new Date(t.openDate);
  if (ms == null || isNaN(ms)) return "";
  const d = ms / 86400_000;
  if (d < 1) return "the same day";
  const r = Math.round(d);
  return `${r} day${r === 1 ? "" : "s"}`;
}
function buildTradeRecapText(t) {
  const win = (t.pnlDollar || 0) >= 0;
  const pct = Math.round((t.pnlPct || 0) * 100);
  const emoji = win ? (pct >= 100 ? "🚀" : "🟢") : "🔴";
  const hold = tradeHoldLabel(t);
  const thesis = (t.claudeSuggestion || (t.topSignals || []).slice(0, 2).join(", ") || t.claudeReasoning || "").replace(/\s+/g, " ").trim();
  const lines = [];
  lines.push(`$${t.ticker} — ${win ? "+" : ""}${pct}% ${emoji}`);
  lines.push("");
  if (thesis) lines.push(`The read going in: ${thesis.slice(0, 170)}`);
  lines.push(`${t.type.toUpperCase()} $${t.strike}: $${(+t.entryPremium).toFixed(2)} → $${(+t.closePremium).toFixed(2)}${hold ? ` over ${hold}` : ""}.`);
  lines.push(win ? "Plan worked." : "Took the loss and moved on.");
  return lines.join("\n");
}
function tradeRecapFacts(t) {
  const win = (t.pnlDollar || 0) >= 0, pct = Math.round((t.pnlPct || 0) * 100);
  const f = [];
  f.push(`Closed trade: $${t.ticker} ${t.type.toUpperCase()} $${t.strike}`);
  f.push(`Result: ${win ? "WIN" : "LOSS"} ${win ? "+" : ""}${pct}% (${win ? "+" : "-"}$${Math.abs(Math.round(t.pnlDollar))})`);
  f.push(`Entry $${(+t.entryPremium).toFixed(2)} on ${t.openDate || "?"}, exit $${(+t.closePremium).toFixed(2)} on ${t.closeDate || "?"}${tradeHoldLabel(t) ? `, held ${tradeHoldLabel(t)}` : ""}`);
  if (t.reason) f.push(`Why I exited: ${t.reason}`);
  const sigs = (t.topSignals || []).join("; ");
  if (sigs) f.push(`Signals at entry: ${sigs}`);
  if (t.setupQuality != null || t.technicalScore != null) f.push(`Setup quality ${t.setupQuality ?? "?"}/100, technical read ${t.technicalScore ?? "?"}/100${t.regimeAtEntry ? `, regime ${t.regimeAtEntry}` : ""}`);
  const reason = (t.claudeReasoning || t.claudeSuggestion || "").replace(/\s+/g, " ").trim();
  if (reason) f.push(`My thesis going in: ${reason.slice(0, 400)}`);
  const concerns = (t.claudeConcerns || []).join("; ");
  if (concerns) f.push(`Concerns I flagged: ${concerns}`);
  return f.join("\n");
}

// Compute shareable performance stats for an account (growth, win rate, top winners, start date).
function buildAccountStats(acct) {
  const state = acct.state;
  const dash = acct.dashboard;
  const cfg = acct.config;
  const start = cfg.startingCash || 0;
  const pv = portfolioValue(state, dash.quotes);
  const allTimePnl = pv - start;
  const allTimePct = start > 0 ? (allTimePnl / start) * 100 : 0;

  const createdAt = acct.createdAt || Date.now();
  const days = Math.max(1, Math.round((Date.now() - createdAt) / 86400_000));

  // Weekly growth from the portfolio-value history (last point at/just before 7 days ago).
  const hist = (dash.portfolioHistory || []).filter(p => p && typeof p.value === "number");
  const weekAgoTs = Date.now() - 7 * 86400_000;
  let weekStartVal = null;
  for (const p of hist) { if (p.ts <= weekAgoTs) weekStartVal = p.value; else break; }
  if (weekStartVal == null && hist.length) weekStartVal = hist[0].value;
  const weekPnl = weekStartVal != null ? pv - weekStartVal : null;
  const weekPct = weekStartVal ? (weekPnl / weekStartVal) * 100 : null;

  // Closed trades, win rate, averages.
  const closed = (state.history || []).filter(t => isAdmissiblePerformanceTrade(t) && !t._pendingFill && t.pnlDollar != null);
  const wins = closed.filter(t => t.pnlDollar > 0);
  const losses = closed.filter(t => t.pnlDollar <= 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length ? (wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length) * 100 : 0;
  const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) * 100 : 0;

  // Top recent winners — dedupe by ticker (keep the best) so the post reads clean.
  const recent = closed.slice(-50).filter(t => t.pnlPct > 0);
  const byTicker = new Map();
  for (const t of recent) { if (!byTicker.has(t.ticker) || t.pnlPct > byTicker.get(t.ticker).pnlPct) byTicker.set(t.ticker, t); }
  const topWinners = [...byTicker.values()].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5);

  return {
    name: acct.name, start, pv, goal: cfg.goal || 0,
    allTimePnl, allTimePct, createdAt, days,
    weekPnl, weekPct, winRate, wins: wins.length, total: closed.length, avgWin, avgLoss, topWinners,
  };
}

// Format the bragging-rights account-growth post.
function buildAccountPostText(acct, stats) {
  const s = stats || buildAccountStats(acct);
  const startDate = new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const money = v => `$${Math.round(v).toLocaleString("en-US")}`;
  const short = v => { const a = Math.abs(v); if (a >= 1e6) return `$${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`; if (a >= 1e3) return `$${(v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1)}K`; return `$${Math.round(v)}`; };
  const lines = [];
  lines.push(s.goal ? `Day ${s.days} of the ${short(s.start)} → ${short(s.goal)} challenge` : `Day ${s.days}`);
  lines.push("");
  lines.push(`${money(s.start)} → ${money(s.pv)} (${s.allTimePct >= 0 ? "+" : ""}${s.allTimePct.toFixed(1)}%)`);
  if (s.weekPnl != null) lines.push(`This week: ${s.weekPnl >= 0 ? "+" : "-"}${money(Math.abs(s.weekPnl))} (${s.weekPct >= 0 ? "+" : ""}${s.weekPct.toFixed(1)}%)`);
  if (s.total > 0) lines.push(`Win rate: ${s.winRate.toFixed(0)}% (${s.wins}/${s.total}) · avg win +${s.avgWin.toFixed(0)}%`);
  if (s.topWinners.length) {
    lines.push("");
    lines.push("Recent winners:");
    lines.push(s.topWinners.map(t => `$${t.ticker} +${Math.round(t.pnlPct * 100)}%`).join(" · "));
  }
  lines.push("");
  lines.push(`Started ${startDate}. ${s.allTimePct >= 0 ? "Compounding 📈" : "Grinding it back."}`);
  return lines.join("\n");
}

// Compact, human-readable fact sheet for one ticker — fed to the LLM so it can write with real
// insight (the EMA it's holding, volume behavior, momentum, key levels, my entry thesis if held).
function mediaTickerFacts(acct, idea) {
  const d = acct.dashboard;
  const t = idea.ticker;
  const a = d.analyses?.[t], st = d.shortTermAnalyses?.[t], q = d.quotes?.[t];
  const candles = acct.candleCache?.[t] || d.candles?.[t];
  const cons = candles ? detectConsolidation(candles) : null;
  const mom = candles ? detectMomentumQuality(candles) : null;
  const pos = acct.state.positions.find(p => p.ticker === t);
  const f = [];
  f.push(`Ticker: $${t}, price $${idea.price}${q?.dp != null ? ` (today ${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(1)}%)` : ""}`);
  f.push(`Lean: ${idea.isCall ? "bullish / calls" : "bearish / puts"}`);
  if (a) {
    const stack = a.aligned ? "8>21>50 (bullish stack)" : a.bearish ? "50>21>8 (bearish stack)" : "mixed/transitioning";
    f.push(`EMAs: ${stack}; 8=${a.ema8v?.toFixed(2)}, 21=${a.ema21v?.toFixed(2)}, 50=${a.ema50v?.toFixed(2)} (price ${a.aligned ? "riding above" : a.bearish ? "below" : "around"} them)`);
    f.push(`RSI(14) ${a.rsi?.toFixed(0)}, ATR ${a.atrPct?.toFixed(1)}%, volume ${a.vr?.toFixed(2)}x vs average, reward:risk ${a.rr}`);
  }
  if (st) f.push(`Momentum: 1d ${st.mom1d?.toFixed(1)}%, 3d ${st.mom3d?.toFixed(1)}%, 7d ${st.mom7d?.toFixed(1)}%; 7d high ${fmtNum(st.recentHigh)}, low ${fmtNum(st.recentLow)}${st.nearHigh ? " (pressing the highs)" : st.nearLow ? " (near the lows)" : ""}; recent volume ${st.vr?.toFixed(2)}x`);
  if (cons) f.push(`Base/consolidation quality ${cons.quality}/100${mom ? `, momentum quality ${mom.quality}/100` : ""}`);
  const sigs = [...(a?.sigs || []).map(s => s.text), ...(st?.sigs || []).map(s => `7d: ${s.text}`)].slice(0, 6);
  if (sigs.length) f.push(`Confirming signals: ${sigs.join("; ")}`);
  f.push(`Trade idea: break ${idea.isCall ? "over" : "under"} ${fmtNum(idea.trigger)}, target $${fmtNum(idea.target)}, contract ${idea.contract}`);
  if (acct.currentRegime) f.push(`Market regime: ${acct.currentRegime.label || acct.currentRegime.mode}`);
  if (pos) {
    f.push(`I am already holding this (${pos.type?.toUpperCase()} $${pos.strike}, entry ~$${(+pos.entryPremium).toFixed?.(2) ?? pos.entryPremium}).`);
    const reason = (pos.claudeReasoning || pos.claudeSuggestion || "").replace(/\s+/g, " ").trim();
    if (reason) f.push(`My entry thesis was: ${reason.slice(0, 360)}`);
  }
  return f.join("\n");
}

// Build the LLM prompt for the requested post type. Returns null if there's nothing to write.
function buildMediaRewritePrompt(acct, kind, ticker, tradeKey) {
  const noBrand = `Hard rules: NO hashtags; never mention "bot", "AI", "Claude", "model", "algorithm", a numeric "score", or any account name (like "v2"); no financial-advice disclaimers; sound like a real person, not a template.`;
  if (kind === "recap") {
    const t = findClosedTrade(acct, tradeKey);
    if (!t) return null;
    const facts = tradeRecapFacts(t);
    return `You are a swing trader posting a trade recap to X — show what you saw going in, then what actually happened. Using ONLY the facts below, write a SHORT post (2-5 short lines): start with the cashtag and the result, give the original read in a sentence or two, then the outcome (entry → exit, how long you held, why you closed). Be honest and human — own the losses too, don't only flex. Start with "$${t.ticker}" on the first line. At most one emoji. ${noBrand}\nOutput ONLY the post text.\n\nFACTS:\n${facts}`;
  }
  if (kind === "ticker") {
    const idea = buildMediaIdea(ticker, acct.dashboard.analyses?.[ticker], acct.dashboard.shortTermAnalyses?.[ticker], acct.dashboard.quotes?.[ticker], acct.candleCache?.[ticker] || acct.dashboard.candles?.[ticker]);
    if (!idea) return null;
    const facts = mediaTickerFacts(acct, idea);
    return `You are an experienced swing trader posting to X/StockTwits about your own setup. Using ONLY the facts below, write a SHORT post: 2-4 short sentences/lines. Show a real read of the chart — name the actual moving average it's holding or losing, the volume behavior, the momentum, and the level that matters. Be confident with a little personality, and vary your sentence structure so it never sounds formulaic. Start with the cashtag on its own line ("$${idea.ticker}"). At most one emoji. ${noBrand}\nOutput ONLY the post text.\n\nFACTS:\n${facts}`;
  }
  if (kind === "account") {
    const s = buildAccountStats(acct);
    const money = v => `$${Math.round(v).toLocaleString("en-US")}`;
    const startDate = new Date(s.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const facts = [
      `Started ${money(s.start)} on ${startDate}.`,
      `Now ${money(s.pv)} — ${s.allTimePct >= 0 ? "+" : ""}${s.allTimePct.toFixed(1)}% over ${s.days} days.`,
      s.weekPct != null ? `This week ${s.weekPct >= 0 ? "+" : ""}${s.weekPct.toFixed(1)}% (${s.weekPnl >= 0 ? "+" : "-"}${money(Math.abs(s.weekPnl))}).` : "",
      s.total ? `Win rate ${s.winRate.toFixed(0)}% (${s.wins} of ${s.total}), average win +${s.avgWin.toFixed(0)}%.` : "",
      s.goal ? `Goal is ${money(s.goal)}.` : "",
      s.topWinners.length ? `Recent winners: ${s.topWinners.map(t => `$${t.ticker} +${Math.round(t.pnlPct * 100)}%`).join(", ")}.` : "",
    ].filter(Boolean).join("\n");
    return `You are a retail options trader sharing a confident but genuine account-growth update on X — the kind of post that makes people want to follow along. Using the facts, write a SHORT post (3-6 short lines). Lead with the growth, weave in a couple supporting stats and the recent winners naturally, and close with a line of personality. At most two emojis. ${noBrand}\nOutput ONLY the post text.\n\nFACTS:\n${facts}`;
  }
  if (kind === "plan") {
    const ideas = gatherMediaIdeas(acct, { max: 10 });
    if (!ideas.length) return null;
    const date = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
    const rows = ideas.map(i => {
      const a = acct.dashboard.analyses?.[i.ticker];
      const sig = a?.sigs?.[0]?.text || (i.isCall ? "trend setup" : "breakdown setup");
      return `$${i.ticker}: ${i.isCall ? "long" : "short"}, break ${i.isCall ? "over" : "under"} ${fmtNum(i.trigger)}, target $${fmtNum(i.target)}, ${i.contract} — ${sig}`;
    }).join("\n");
    return `You are a swing trader posting your watchlist for the week to X. Write a post that starts with "Trade plan ${date}" then ONE punchy, specific line per name. Each line should name the trigger level and the contract and a few words on why it's on watch — and vary the phrasing line to line so it doesn't read like a generated list. ${noBrand}\nOutput ONLY the post text.\n\nNAMES:\n${rows}`;
  }
  return null;
}

// Render the account equity curve as a shareable PNG (the "watch me get rich" visual).
function renderEquityCurvePNG(acct) {
  const dash = acct.dashboard;
  const hist = (dash.portfolioHistory || []).filter(p => p && typeof p.value === "number");
  if (hist.length < 2) return null;
  try {
    const W = 1100, H = 560, PADL = 70, PADR = 30, TOP = 150, BOT = 60;
    const vals = hist.map(p => p.value);
    const start = acct.config.startingCash || vals[0];
    const pv = vals[vals.length - 1];
    const pct = start > 0 ? ((pv - start) / start) * 100 : 0;
    const up = pct >= 0;
    const col = up ? "#00a843" : "#e8473f";
    const mn = Math.min(...vals, start) * 0.99, mx = Math.max(...vals, start) * 1.01, rng = (mx - mn) || 1;
    const n = hist.length;
    const x = i => PADL + (i / (n - 1)) * (W - PADL - PADR);
    const y = v => TOP + (H - TOP - BOT) * (1 - (v - mn) / rng);
    const linePts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const areaPts = `${x(0).toFixed(1)},${(H - BOT).toFixed(1)} ${linePts} ${x(n - 1).toFixed(1)},${(H - BOT).toFixed(1)}`;
    const money = v => `$${Math.round(v).toLocaleString("en-US")}`;
    const startDate = new Date(acct.createdAt || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const days = Math.max(1, Math.round((Date.now() - (acct.createdAt || Date.now())) / 86400_000));
    const baseY = y(start);
    const yLabels = [mx, mn + rng * 0.5, mn].map(v =>
      `<text x="${PADL - 8}" y="${y(v).toFixed(1)}" fill="#9aa1ad" font-size="13" font-family="monospace" text-anchor="end" dominant-baseline="middle">${money(v)}</text>`
    ).join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${col}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${col}" stop-opacity="0.02"/>
      </linearGradient></defs>
      <text x="${PADL - 8}" y="66" fill="#1c1d22" font-size="44" font-weight="bold" font-family="monospace">${money(start)} → ${money(pv)}</text>
      <text x="${PADL - 8}" y="108" fill="${col}" font-size="28" font-weight="bold" font-family="monospace">${up ? "+" : ""}${pct.toFixed(1)}%  ·  Day ${days}</text>
      <text x="${W - PADR}" y="66" fill="#9aa1ad" font-size="16" font-family="monospace" text-anchor="end">since ${startDate}</text>
      ${yLabels}
      <line x1="${PADL}" y1="${baseY.toFixed(1)}" x2="${W - PADR}" y2="${baseY.toFixed(1)}" stroke="#c7ccd4" stroke-width="1" stroke-dasharray="5 5"/>
      <text x="${W - PADR}" y="${(baseY - 6).toFixed(1)}" fill="#9aa1ad" font-size="12" font-family="monospace" text-anchor="end">start ${money(start)}</text>
      <polygon points="${areaPts}" fill="url(#g)"/>
      <polyline points="${linePts}" fill="none" stroke="${col}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(n - 1).toFixed(1)}" cy="${y(pv).toFixed(1)}" r="6" fill="${col}"/>
    </svg>`;
    return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  } catch (e) {
    console.log(`  [MEDIA] Equity curve render failed: ${e.message}`);
    return null;
  }
}

// Render a closed-trade recap chart: the underlying candles with IN (entry) and OUT (exit) markers.
function renderRecapChartPNG(acct, trade, candles, dashboard) {
  if (!candles || candles.length < 5) return null;
  const win = (trade.pnlDollar || 0) >= 0;
  const pct = Math.round((trade.pnlPct || 0) * 100);
  const outColor = win ? "#00a843" : "#e8473f";
  return renderChartPNG(candles.slice(-70), trade.ticker, dashboard.analyses?.[trade.ticker], dashboard.shortTermAnalyses?.[trade.ticker], dashboard.quotes?.[trade.ticker], {
    events: [
      { date: trade.openDate, color: "#6a4df4", label: "IN" },
      { date: trade.closeDate, color: outColor, label: `OUT ${pct >= 0 ? "+" : ""}${pct}%` },
    ],
  });
}

// ─── Market Regime (SPY/QQQ EMA health) ───

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
    riskScale = 0.4;
    label = "RISK-OFF — below key EMAs, crisis momentum mode";
  }

  return { mode, riskScale, label, spyAbove: spy, qqqAbove: qqq };
}

// At max risk-per-trade (100%), the user has explicitly opted to deploy the full configured
// budget on a trade — treat that as an override and skip the regime-based scale-down (which
// otherwise quietly caps a "100%" setting to e.g. 35% of cash in a CHOPPY regime). Any other
// risk level still scales with the regime as before.
function effectiveRiskPct(baseRiskPct, regime) {
  if (baseRiskPct >= 1.0) return baseRiskPct;
  return baseRiskPct * (regime?.riskScale ?? 0.5);
}

// ─── Earnings Calendar Check (Finnhub) ───

async function checkEarnings(ticker, apiKey) {
  try {
    const now = getETDate();
    const from = now.toISOString().slice(0, 10);
    const futureDate = new Date(now.getTime() + (MAX_DTE + 2) * 86400_000);
    const to = futureDate.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${apiKey}`);
    if (!r.ok) return { available: false, hasEarnings: false, daysUntil: null, error: `calendar HTTP ${r.status}` };
    const data = await r.json();
    const earnings = data.earningsCalendar || [];
    if (earnings.length === 0) return { available: true, hasEarnings: false, daysUntil: null };
    const nextEarning = earnings[0];
    const earningDate = new Date(nextEarning.date);
    const daysUntil = Math.ceil((earningDate - now) / 86400_000);
    return { available: true, hasEarnings: true, daysUntil, date: nextEarning.date };
  } catch (error) {
    return { available: false, hasEarnings: false, daysUntil: null, error: error.message };
  }
}

function removeEarningsCrossingContracts(candidates, earningsInfo) {
  if (!earningsInfo?.hasEarnings || !earningsInfo.date) return candidates;
  return (candidates || []).filter(candidate => candidate.expiryStr < earningsInfo.date);
}

async function checkEarningsCached(ticker, apiKey) {
  const day = getETDateStr();
  const cached = earningsCache.get(ticker);
  if (cached && cached.day === day) return cached.result;
  const result = await checkEarnings(ticker, apiKey);
  earningsCache.set(ticker, { day, result });
  return result;
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

  // 3. Directional EMA structure during the base
  const allCandles = candles;
  const allCloses = allCandles.map(d => d.c);
  const ema8 = calcEMA(allCloses, 8);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;
  const price = allCloses[L];
  let bullishEmaScore = 0;
  let bearishEmaScore = 0;
  if (price > ema8[L] && price > ema21[L] && price > ema50[L]) bullishEmaScore = 25;
  else if (price > ema21[L] && price > ema50[L]) bullishEmaScore = 15;
  else if (price > ema50[L]) bullishEmaScore = 8;
  if (price < ema8[L] && price < ema21[L] && price < ema50[L]) bearishEmaScore = 25;
  else if (price < ema21[L] && price < ema50[L]) bearishEmaScore = 15;
  else if (price < ema50[L]) bearishEmaScore = 8;

  // 4. Breakout detection: latest close near/above range high with volume expansion
  const latestVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  let breakoutScore = 0;
  let breakdownScore = 0;
  if (price >= rangeHigh * 0.995 && latestVol > avgVol * 1.3) {
    breakoutScore = 20; // Breaking out of consolidation on volume!
  } else if (price >= rangeHigh * 0.99) {
    breakoutScore = 10; // Near breakout level
  }
  if (price <= rangeLow * 1.005 && latestVol > avgVol * 1.3) {
    breakdownScore = 20;
  } else if (price <= rangeLow * 1.01) {
    breakdownScore = 10;
  }

  const bullishQuality = Math.min(100, tightnessScore + volDeclineScore + bullishEmaScore + breakoutScore);
  const bearishQuality = Math.min(100, tightnessScore + volDeclineScore + bearishEmaScore + breakdownScore);
  return {
    quality: bullishQuality,
    bullishQuality,
    bearishQuality,
    tight: rangePct < 8,
    rangePct: rangePct.toFixed(1),
    volDeclining: secondHalfVol < firstHalfVol * 0.85,
    aboveEMAs: bullishEmaScore >= 15,
    belowEMAs: bearishEmaScore >= 15,
    breakingOut: breakoutScore >= 15,
    breakingDown: breakdownScore >= 15,
    components: { tightnessScore, volDeclineScore, bullishEmaScore, bearishEmaScore, breakoutScore, breakdownScore },
  };
}

// ─── Crisis / Momentum Mode Helpers ───

// Assets that thrive in crisis — exempt from risk-off call blocking
const CRISIS_LONGS = new Set([
  "USO", "XLE", "XOM", "OXY", "CVX", "COP", "SLB", "HAL", "MPC", "VLO", "PSX", // oil/energy
  "GLD", "GDX", "GOLD", "NEM", "AEM", "SLV",                                     // gold/silver
  "DBC", "DBA", "PDBC", "GSG",                                                     // commodities
  "LMT", "NOC", "RTX", "GD", "BA", "HII",                                         // defense
  "UUP", "WEAT", "CORN",                                                           // dollar, ag
  "WTI", "BZ=F", "CL=F", "IEO", "MEOH",                                           // oil-adjacent
  "VIX", "UVXY", "VIXY",                                                           // vol
]);

function detectMomentumQuality(candles) {
  if (!candles || candles.length < 10) return { quality: 0 };
  const recent = candles.slice(-7);
  const closes = recent.map(d => d.c);
  const volumes = recent.map(d => d.v);
  const allCloses = candles.map(d => d.c);

  // 1. Trend strength: how consistent is the direction over last 7 days?
  let trendDays = 0;
  const direction = closes[closes.length - 1] > closes[0] ? "up" : "down";
  for (let i = 1; i < closes.length; i++) {
    if (direction === "up" && closes[i] >= closes[i - 1]) trendDays++;
    if (direction === "down" && closes[i] <= closes[i - 1]) trendDays++;
  }
  const trendScore = Math.min(35, Math.round((trendDays / (closes.length - 1)) * 35));

  // 2. Magnitude: how big is the move? bigger = stronger signal
  const movePct = Math.abs((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  let magScore = 0;
  if (movePct > 15) magScore = 30;
  else if (movePct > 8) magScore = 25;
  else if (movePct > 4) magScore = 20;
  else if (movePct > 2) magScore = 10;

  // 3. Volume confirmation: is volume expanding with the move?
  const avgVol5 = candles.slice(-5).reduce((s, c) => s + c.v, 0) / 5;
  const avgVol20 = candles.slice(-20).reduce((s, c) => s + c.v, 0) / Math.min(20, candles.length);
  const volRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  let volScore = 0;
  if (volRatio > 1.5) volScore = 25;
  else if (volRatio > 1.2) volScore = 15;
  else if (volRatio > 1.0) volScore = 8;

  // 4. EMA alignment bonus (trending in same direction as the trade)
  const ema8 = calcEMA(allCloses, 8);
  const ema21 = calcEMA(allCloses, 21);
  const L = allCloses.length - 1;
  let emaScore = 0;
  if (direction === "up" && ema8[L] > ema21[L]) emaScore = 10;
  if (direction === "down" && ema8[L] < ema21[L]) emaScore = 10;

  const quality = Math.min(100, trendScore + magScore + volScore + emaScore);
  return { quality, direction, movePct: movePct.toFixed(1), volRatio: volRatio.toFixed(2), trendDays };
}

// (detectGap / measureBaseSize removed — never referenced by any signal or entry path)

// ─── SRxTrades: Undercut & Reclaim / Uppercut Detection ───

function detectUndercutReclaim(candles) {
  // Bullish reversal: price undercuts a key low then reclaims it with strength
  // Best in leading stocks near 21 EMA or 50 MA
  if (!candles || candles.length < 20) return { detected: false };

  const recent = candles.slice(-5);
  const prior = candles.slice(-20, -5);
  const allCloses = candles.map(d => d.c);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;

  // Find the key low from prior candles (well-defined swing low)
  const priorLows = prior.map(d => d.l);
  const keyLow = Math.min(...priorLows);
  // Also check prior day's low and recent swing low (last 10 candles)
  const recentSwingLows = candles.slice(-10, -3).map(d => d.l);
  const swingLow = recentSwingLows.length > 0 ? Math.min(...recentSwingLows) : keyLow;
  const testLevel = Math.min(keyLow, swingLow);

  // Check if any recent candle undercut the key low
  let undercutCandle = -1;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].l < testLevel * 0.998) { // Broke below by at least 0.2%
      undercutCandle = i;
    }
  }
  if (undercutCandle === -1) return { detected: false };

  // Check for reclaim: latest candle(s) must close back above the key low
  const lastCandle = recent[recent.length - 1];
  const reclaimed = lastCandle.c > testLevel * 1.001; // Closed above by 0.1%+
  if (!reclaimed) return { detected: false };

  // Quality scoring
  let quality = 0;
  const reasons = [];

  // 1. Wick characteristic on undercut candle (long lower wick = liquidity grab)
  const uc = recent[undercutCandle];
  const bodySize = Math.abs(uc.c - uc.o);
  const lowerWick = Math.min(uc.o, uc.c) - uc.l;
  if (lowerWick > bodySize * 1.5) { quality += 20; reasons.push("Long lower wick (liquidity grab)"); }
  else if (lowerWick > bodySize) { quality += 10; reasons.push("Lower wick present"); }

  // 2. Volume on undercut and reclaim
  const avgVol = prior.map(d => d.v).reduce((a, b) => a + b, 0) / prior.length;
  if (uc.v > avgVol * 1.3) { quality += 15; reasons.push("High volume on undercut"); }
  if (lastCandle.v > avgVol * 1.2) { quality += 15; reasons.push("Strong volume on reclaim"); }

  // 3. Strong reclaim candle (bullish close, little hesitation)
  if (lastCandle.c > lastCandle.o) { quality += 10; reasons.push("Bullish reclaim candle"); }
  const reclaimStrength = (lastCandle.c - testLevel) / testLevel * 100;
  if (reclaimStrength > 1) { quality += 10; reasons.push(`Strong reclaim +${reclaimStrength.toFixed(1)}%`); }

  // 4. Near key EMAs (highest probability U&Rs per SRxTrades)
  const nearEma21 = Math.abs(testLevel - ema21[L]) / ema21[L] < 0.03;
  const nearEma50 = Math.abs(testLevel - ema50[L]) / ema50[L] < 0.03;
  if (nearEma21 || nearEma50) { quality += 15; reasons.push(`Near ${nearEma21 ? '21' : '50'} EMA support`); }

  // 5. Quick undercut (not a sustained breakdown)
  const daysBelowKey = recent.filter(c => c.l < testLevel).length;
  if (daysBelowKey <= 2) { quality += 10; reasons.push("Quick undercut (1-2 candles)"); }

  quality = Math.min(100, quality);

  return {
    detected: quality >= 30,
    quality,
    keyLevel: testLevel,
    reclaimPrice: lastCandle.c,
    reasons,
    pattern: "Undercut & Reclaim",
    bias: "bullish",
  };
}

function detectUppercut(candles) {
  // Bearish reversal (failed breakout): price breaks above key resistance then fails back below
  // "Breakout buyers and late longs get trapped at the highs, adding selling pressure"
  if (!candles || candles.length < 20) return { detected: false };

  const recent = candles.slice(-5);
  const prior = candles.slice(-20, -5);
  const allCloses = candles.map(d => d.c);
  const ema21 = calcEMA(allCloses, 21);
  const ema50 = calcEMA(allCloses, 50);
  const L = allCloses.length - 1;

  // Find key resistance: prior highs, range highs
  const priorHighs = prior.map(d => d.h);
  const keyHigh = Math.max(...priorHighs);
  const recentSwingHighs = candles.slice(-10, -3).map(d => d.h);
  const swingHigh = recentSwingHighs.length > 0 ? Math.max(...recentSwingHighs) : keyHigh;
  const testLevel = Math.max(keyHigh, swingHigh);

  // Check if any recent candle broke above the key high
  let uppercutCandle = -1;
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].h > testLevel * 1.002) { // Broke above by at least 0.2%
      uppercutCandle = i;
    }
  }
  if (uppercutCandle === -1) return { detected: false };

  // Check for reclaim back below: latest candle must close below the key high
  const lastCandle = recent[recent.length - 1];
  const reclaimed = lastCandle.c < testLevel * 0.999; // Closed below by 0.1%+
  if (!reclaimed) return { detected: false };

  // Quality scoring
  let quality = 0;
  const reasons = [];

  // 1. Upper wick on uppercut candle (trap candle)
  const uc = recent[uppercutCandle];
  const bodySize = Math.abs(uc.c - uc.o);
  const upperWick = uc.h - Math.max(uc.o, uc.c);
  if (upperWick > bodySize * 1.5) { quality += 20; reasons.push("Long upper wick (bull trap)"); }
  else if (upperWick > bodySize) { quality += 10; reasons.push("Upper wick present"); }

  // 2. Volume on the failed breakout
  const avgVol = prior.map(d => d.v).reduce((a, b) => a + b, 0) / prior.length;
  if (uc.v > avgVol * 1.3) { quality += 15; reasons.push("High volume on failed breakout"); }
  if (lastCandle.v > avgVol * 1.2) { quality += 15; reasons.push("Strong selling volume on reclaim"); }

  // 3. Bearish reclaim candle
  if (lastCandle.c < lastCandle.o) { quality += 10; reasons.push("Bearish reversal candle"); }
  const reclaimStrength = (testLevel - lastCandle.c) / testLevel * 100;
  if (reclaimStrength > 1) { quality += 10; reasons.push(`Strong rejection -${reclaimStrength.toFixed(1)}%`); }

  // 4. Near overhead MAs (resistance confirmation)
  const nearEma21 = Math.abs(testLevel - ema21[L]) / ema21[L] < 0.03;
  const nearEma50 = Math.abs(testLevel - ema50[L]) / ema50[L] < 0.03;
  if (nearEma21 || nearEma50) { quality += 15; reasons.push(`Failed at ${nearEma21 ? '21' : '50'} EMA resistance`); }

  // 5. Quick break above (not a sustained breakout)
  const daysAboveKey = recent.filter(c => c.h > testLevel).length;
  if (daysAboveKey <= 2) { quality += 10; reasons.push("Quick trap (1-2 candles above)"); }

  quality = Math.min(100, quality);

  return {
    detected: quality >= 30,
    quality,
    keyLevel: testLevel,
    reclaimPrice: lastCandle.c,
    reasons,
    pattern: "Uppercut (Failed Breakout)",
    bias: "bearish",
  };
}

// ─── Market Hours ───

function getETDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function getETParts() {
  const parts = new Intl.DateTimeFormat("en-US", { 
    timeZone: "America/New_York", 
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false, weekday: "short"
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    day: get("weekday"),
    h: parseInt(get("hour"), 10),
    m: parseInt(get("minute"), 10),
    dateStr: `${get("year")}-${get("month").padStart(2, "0")}-${get("day").padStart(2, "0")}`
  };
}

// US market holidays (NYSE/Nasdaq) — FALLBACK only, used when the Tradier exchange clock isn't
// available. Tradier's /markets/clock is authoritative when connected (it also handles ad-hoc
// closures and is always correct on early-close days).
const MARKET_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
// Half-days — the market closes early at 1:00 PM ET (780 minutes).
const MARKET_HALF_DAYS = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24",
  "2026-11-27", "2026-12-24",
  "2027-11-26",
]);

// Authoritative market state pulled from the Tradier exchange clock and cached briefly. This is the
// source of truth when Tradier is connected — it flips to "open" the instant the exchange does and
// is always right about holidays/early closes. Refreshed by the main loop (and forced near the open).
let _marketClock = { state: null, nextChange: null, fetchedAt: 0, source: "local" };
async function refreshMarketClock(force = false) {
  if (!tradier.isConnected) return;
  if (!force && Date.now() - _marketClock.fetchedAt < 30_000) return;
  try {
    const clk = await tradier.getClock();
    if (clk && clk.state) {
      const prevState = _marketClock.state;
      _marketClock = { state: clk.state, nextChange: clk.next_change || null, fetchedAt: Date.now(), source: "tradier" };
      // Record only the transition, not every poll — a few rows per day.
      if (prevState && prevState !== clk.state) {
        diag("clock", "system", {
          from: prevState, to: clk.state, nextChange: clk.next_change || null,
          desc: clk.description || null,
        });
      }
    }
  } catch { /* keep last good reading; fall back to local calc below */ }
}

// True only when the regular session is open. Prefers the broker clock; falls back to a local ET
// calculation with the US holiday/half-day calendar so we're still correct when Tradier is down.
// Local-time-only market open check — never consults Tradier.
// Used for Robinhood accounts so Tradier's API state never blocks RH trade cycles.
function isMarketOpenLocal() {
  try {
    const { day, h, m, dateStr } = getETParts();
    if (day === "Sat" || day === "Sun") return false;
    if (MARKET_HOLIDAYS.has(dateStr)) return false;
    const mins = h * 60 + m;
    const close = MARKET_HALF_DAYS.has(dateStr) ? 780 : 960;
    return mins >= 570 && mins < close;
  } catch (e) {
    const d = new Date();
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes() - 240;
    return mins >= 570 && mins < 960;
  }
}

function isMarketOpen() {
  if (_marketClock.source === "tradier" && _marketClock.state && Date.now() - _marketClock.fetchedAt < 5 * 60_000) {
    return _marketClock.state === "open"; // "premarket"/"postmarket"/"closed" are all NOT regular-session open
  }
  return isMarketOpenLocal();
}

function getETDateStr() {
  try {
    return getETParts().dateStr;
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Returns the next Friday expiration that is at least minCalendarDays away (in ET).
// Options expire at 4pm ET on the expiry date; we use end-of-day as the timestamp.
function nextFridayExpiry(minCalendarDays = 7, refDate) {
  const base = refDate ? new Date(refDate) : getETDate();
  // Zero out time to midnight
  base.setHours(0, 0, 0, 0);
  for (let d = minCalendarDays; d <= minCalendarDays + 7; d++) {
    const candidate = new Date(base);
    candidate.setDate(base.getDate() + d);
    if (candidate.getDay() === 5) { // 5 = Friday
      // Expiry is at 4pm ET on that Friday
      candidate.setHours(16, 0, 0, 0);
      return { date: candidate, dte: d };
    }
  }
  // Fallback (shouldn't happen): just use minCalendarDays
  const fallback = new Date(base);
  fallback.setDate(base.getDate() + minCalendarDays);
  fallback.setHours(16, 0, 0, 0);
  return { date: fallback, dte: minCalendarDays };
}

// ─── Expiration Cadence Model ───
// Real options don't all expire on the same Friday: index ETFs expire daily, many large caps
// expire Mon/Wed/Fri, and the long tail expires weekly on Fridays. Modeling this (and capping how
// many open positions may share one expiry) prevents the whole book from synchronizing onto a
// single expiration and bleeding theta in lockstep (the "all 13 DTE" trap).
function getExpiryCadence(ticker) {
  const t = (ticker || "").toUpperCase();
  if (DAILY_EXPIRY_TICKERS.has(t)) return "daily";
  if (MWF_EXPIRY_TICKERS.has(t)) return "mwf";
  return "weekly";
}

// Generates upcoming expiration dates (as {date, dte}) for a ticker out to horizonDays,
// honoring its expiration cadence. Dates are timestamped at 4pm ET on the expiry day.
function generateExpiries(ticker, refDate, horizonDays = MAX_DTE) {
  const cadence = getExpiryCadence(ticker);
  const base = refDate ? new Date(refDate) : getETDate();
  base.setHours(0, 0, 0, 0);
  const out = [];
  for (let d = 1; d <= horizonDays; d++) {
    const cand = new Date(base);
    cand.setDate(base.getDate() + d);
    const day = cand.getDay(); // 0 Sun .. 6 Sat
    if (day === 0 || day === 6) continue; // options expire on trading days only
    let ok;
    if (cadence === "daily") ok = true;
    else if (cadence === "mwf") ok = (day === 1 || day === 3 || day === 5);
    else ok = (day === 5); // weekly Fridays
    if (!ok) continue;
    cand.setHours(16, 0, 0, 0);
    out.push({ date: cand, dte: d });
  }
  return out;
}

// Counts open positions whose expiration falls on the same calendar day as expiryTs.
function countPositionsAtExpiry(state, expiryTs) {
  const day = new Date(expiryTs); day.setHours(0, 0, 0, 0);
  const target = day.getTime();
  return state.positions.filter(p => {
    if (!p.expiryDate) return false;
    const d = new Date(p.expiryDate); d.setHours(0, 0, 0, 0);
    return d.getTime() === target;
  }).length;
}

function countCommittedAtExpiry(acct, expiryTs) {
  let count = countPositionsAtExpiry(acct.state, expiryTs);
  const target = new Date(expiryTs); target.setHours(0, 0, 0, 0);
  for (const reservation of acct._inflightExpiryReservations?.values?.() || []) {
    const d = new Date(reservation); d.setHours(0, 0, 0, 0);
    if (d.getTime() === target.getTime()) count++;
  }
  return count;
}

function reserveInflightExpiry(acct, ticker, expiryTs) {
  if (!acct._inflightExpiryReservations) acct._inflightExpiryReservations = new Map();
  acct._inflightExpiryReservations.set(ticker.toUpperCase(), expiryTs);
}

// Picks the expiration closest to targetDTE (>= MIN_SWING_DTE) honoring the ticker's cadence.
// If the best date is already over-concentrated in the book, steps to the next available expiry
// so positions stagger across multiple expirations instead of synchronizing.
function nextExpiry(ticker, { targetDTE = TARGET_DTE, refDate = null, state = null } = {}) {
  const expiries = generateExpiries(ticker, refDate).filter(e => e.dte >= MIN_SWING_DTE);
  if (expiries.length === 0) {
    return nextFridayExpiry(MIN_SWING_DTE, refDate); // safety net
  }
  expiries.sort((a, b) => Math.abs(a.dte - targetDTE) - Math.abs(b.dte - targetDTE));
  if (state) {
    for (const e of expiries) {
      if (countPositionsAtExpiry(state, e.date.getTime()) < MAX_PER_EXPIRY) return e;
    }
  }
  return expiries[0];
}



// ─── API Layer ───

async function fetchQuote(sym, key) {
  // Primary: Tradier (real-time, fill-accurate) when the arm is connected.
  if (tradier.isConnected) {
    try {
      const q = await tradier.getQuote(sym);
      if (q && q.c > 0) { noteDataSource("tradier"); return q; }
    } catch { }
  }
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`);
    if (r.ok) {
      const data = await r.json();
      if (data && data.c > 0) { noteDataSource("finnhub"); return data; }
    }
  } catch { }
  // Fallback: Yahoo Finance realtime quote
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Quote error ${r.status}`);
  const d = await r.json();
  const meta = d.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error(`No Yahoo quote for ${sym}`);
  noteDataSource("yahoo");
  const c = meta.regularMarketPrice;
  const pc = meta.chartPreviousClose || meta.previousClose || 0;
  return { c, h: meta.regularMarketDayHigh || c, l: meta.regularMarketDayLow || c, o: meta.regularMarketOpen || c, pc, d: pc ? +(c - pc).toFixed(2) : 0, dp: pc ? +((c - pc) / pc * 100).toFixed(2) : 0 };
}

async function fetchCandles(sym, key) {
  // Primary: Tradier daily history when connected.
  if (tradier.isConnected) {
    try {
      const candles = await tradier.getHistoricals(sym, 90);
      if (candles && candles.length > 0) return candles;
    } catch { }
  }
  // Try Finnhub next
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

// ─── Options Chain (Tradier primary, Finnhub fallback) ───

async function fetchFullOptionsChain(sym, apiKey) {
  // Primary: Tradier — real-time chain with ORATS Greeks/IV, normalized to the Finnhub shape.
  if (tradier.isConnected) {
    try {
      const chain = await tradier.getOptionsChainNormalized(sym);
      if (chain && chain.length > 0) return chain.map(exp => ({ ...exp, dataSource: "tradier" }));
    } catch { }
  }
  // Fallback: Finnhub option chain.
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/option-chain?symbol=${sym}&token=${apiKey}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
    return data.data.map(exp => ({ ...exp, dataSource: "finnhub" }));
  } catch {
    return null;
  }
}

function chooseAffordableCandidate(candidates, selected, maxContractCost, acct) {
  if (!(maxContractCost > 0)) return selected || null;

  // If AI picked a specific contract and we can afford it (and it doesn't over-concentrate
  // an expiry), use it.
  if (selected && selected.mid > 0 && selected.mid * 100 <= maxContractCost
      && (!acct || countCommittedAtExpiry(acct, selected.expiryDate) < MAX_PER_EXPIRY)) {
    return selected;
  }

  // AI's pick is unaffordable (or over-concentrated) — don't give up. Fall back to the best
  // affordable real contract from the same candidate list. This matters most for small
  // accounts: Claude tends to pick higher-quality (often pricier, near-ATM) contracts that
  // can exceed a small budget even when a cheaper, perfectly tradeable real contract exists.
  const affordable = (candidates || [])
    .filter(c => c && c !== selected && c.mid > 0 && c.mid * 100 <= maxContractCost)
    .filter(c => !acct || countCommittedAtExpiry(acct, c.expiryDate) < MAX_PER_EXPIRY)
    .sort((a, b) => b.quality - a.quality);
  return affordable[0] || null;
}

async function fetchHistoricalCandles(sym, fromUnix, toUnix) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${fromUnix}&period2=${toUnix}&interval=1d`;
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

// A trustworthy option mark requires a real two-sided market: both bid AND ask present and > 0,
// and not crossed. We deliberately do NOT fall back to `last` (which can be a stale trade from
// days ago on illiquid contracts) — an unreliable mark returns null so callers can hold instead
// of acting on a fabricated price with real money.
function reliableOptionMark(oq) {
  if (!oq) return null;
  const { bid, ask } = oq;
  if (typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0 && ask >= bid) {
    return +(((bid + ask) / 2)).toFixed(2);
  }
  return null;
}

// ─── Portfolio Helpers ───

// Historical paper runs were allowed to invent option contracts and prices when no real chain
// was available. Those observations are not executable market evidence, so keep them out of
// performance reporting and learning. Invalid open simulations are carried at cost (zero P&L)
// and invalid realized P&L is backed out of brokerless portfolio values.
function isAdmissiblePerformanceTrade(trade) {
  if (!trade || trade.optionsSource === "synthetic") return false;
  // An order intent is not a trade. Pending, rejected, canceled-with-zero-fill, and unresolved
  // broker submissions must remain outside every performance/learning/social metric permanently.
  if (!isConfirmedTradeOutcome(trade)) return false;
  if (trade.type !== "equity" && !(Number(trade.strike) > 0)) return false;
  return true;
}

function portfolioValue(state, quotes) {
  // Broker accounts: trust Tradier's own total_equity. It already nets settled cash, filled
  // positions, AND capital reserved by working (unfilled) orders — so nothing appears to "vanish"
  // into pending orders the way cash+positions alone would.
  if (typeof state.brokerEquity === "number" && state.brokerEquity > 0) return state.brokerEquity;
  const inadmissibleRealizedPnl = (state.history || [])
    .filter(t => (t?.optionsSource === "synthetic" || (t?.type !== "equity" && !(Number(t?.strike) > 0)))
      && typeof t?.pnlDollar === "number")
    .reduce((sum, t) => sum + t.pnlDollar, 0);
  let val = state.cash - inadmissibleRealizedPnl;
  // Robinhood fallback: state.cash is buying power, which excludes today's sale proceeds until
  // T+1 settlement. Without this credit every exit looks like the proceeds evaporated (a real
  // ~-10% day once read as -77.8% and falsely tripped the daily-loss breaker).
  if (Array.isArray(state.rhUnsettled)) for (const u of state.rhUnsettled) val += u.amount || 0;
  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const isEquity = pos.type === "equity";
    const invalidSimulation = !isEquity && !isAdmissiblePerformanceTrade(pos);
    const currentPremium = invalidSimulation
      ? pos.entryPremium
      : isEquity
      ? (pos.liveMark ?? spot)
      : (pos.liveMark ?? (pos.strike > 0 ? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type) : pos.entryPremium));
    val += currentPremium * pos.qty * (isEquity ? 1 : 100);
  }
  return val;
}

function estimatedOpenRiskDollars(acct) {
  const state = acct.state || {};
  const result = computeLongOptionOpenRisk({
    positions: state.positions || [],
    pendingOrders: state.pendingEntryOrders || [],
    metadata: state.meta || {},
    stopLossPct: acct.config.stopLoss || -0.20,
    entryFeePerContract: FEE_PER_CONTRACT,
    exitFeePerContract: FEE_PER_CONTRACT,
  });
  state.openRiskSnapshot = {
    at: Date.now(),
    totalRiskDollars: result.totalRiskDollars,
    knownRiskDollars: result.knownRiskDollars,
    complete: result.complete,
    quantities: result.quantities,
    unresolved: result.unresolved.map(row => ({
      contractKey: row.contractKey,
      source: row.source,
      quantity: row.quantity,
    })),
  };
  // The governor requires a finite number. Null deliberately fails its input validation, so an
  // unknown open exposure can never be treated as zero heat.
  return result.complete ? result.totalRiskDollars : null;
}

/**
 * Keep startingCash (= capital contributed / zero-point) in sync with external deposits/withdrawals.
 * Without this, funding the Robinhood agentic account looks like +700% "profit".
 *
 * Heuristic: equity jumps of >= $100 (or 8% of capital base) between syncs are treated as external
 * capital flows, not trading P&L. Manual corrections via Settings still win for exact accounting.
 */
function reconcileBrokerCapital(acct, newEquity, { cashDelta = null } = {}) {
  if (!(newEquity > 0) || acct._simMode) return;
  const state = acct.state;
  const prevEquity = state.lastBrokerEquity;
  state.lastBrokerEquity = newEquity;

  if (!(prevEquity > 0)) return; // first observation — just arm the tracker

  const equityDelta = newEquity - prevEquity;
  const threshold = Math.max(100, (acct.config.startingCash || 200) * 0.08);
  // Prefer cash-confirmed deposits: buying power jumped with equity (funding), not just MTM.
  const cashConfirmed = typeof cashDelta === "number" && Math.abs(cashDelta) >= 75
    && Math.sign(cashDelta) === Math.sign(equityDelta);
  if (Math.abs(equityDelta) < threshold && !cashConfirmed) return;
  // Ignore tiny residual mismatches when cash didn't move (pure mark-to-market).
  if (!cashConfirmed && Math.abs(equityDelta) < threshold * 1.5) return;

  const amount = cashConfirmed
    // When cash confirms, use the cash delta (closer to the wire deposit amount) but never larger
    // than the equity move by more than a few bucks of noise.
    ? (Math.abs(cashDelta) <= Math.abs(equityDelta) + 5 ? cashDelta : equityDelta)
    : equityDelta;

  const before = acct.config.startingCash || 0;
  acct.config.startingCash = Math.max(1, +(before + amount).toFixed(2));
  if (!state.capitalEvents) state.capitalEvents = [];
  state.capitalEvents.push({
    ts: Date.now(),
    type: amount > 0 ? "deposit" : "withdrawal",
    amount: +amount.toFixed(2),
    equity: +newEquity.toFixed(2),
    capitalBase: acct.config.startingCash,
    auto: true,
  });
  // Deposits shouldn't look like a green day against the daily-loss breaker baseline.
  if (state.risk && typeof state.risk.dayStartPV === "number" && state.risk.dayStartPV > 0) {
    state.risk.dayStartPV = +(state.risk.dayStartPV + amount).toFixed(2);
  }
  log(acct, `CAPITAL: ${amount > 0 ? "deposit" : "withdrawal"} $${Math.abs(amount).toFixed(0)} ${cashConfirmed ? "(cash-confirmed) " : ""}→ capital base $${before.toFixed(0)} → $${acct.config.startingCash.toFixed(0)} (equity $${newEquity.toFixed(0)})`);
  saveAccounts();
}

function setCapitalBase(acct, newBase, { note = "manual" } = {}) {
  const base = Math.max(1, +parseFloat(newBase) || 0);
  const before = acct.config.startingCash || 0;
  const amount = base - before;
  acct.config.startingCash = +base.toFixed(2);
  if (!acct.state.capitalEvents) acct.state.capitalEvents = [];
  acct.state.capitalEvents.push({
    ts: Date.now(),
    type: amount >= 0 ? "set_base" : "set_base",
    amount: +amount.toFixed(2),
    equity: acct.state.brokerEquity ?? null,
    capitalBase: acct.config.startingCash,
    note,
    auto: false,
  });
  if (acct.state.risk && typeof acct.state.risk.dayStartPV === "number" && acct.state.risk.dayStartPV > 0) {
    acct.state.risk.dayStartPV = +(acct.state.risk.dayStartPV + amount).toFixed(2);
  }
  log(acct, `CAPITAL: set base $${before.toFixed(0)} → $${acct.config.startingCash.toFixed(0)} (${note})`);
  saveAccounts();
  return acct.config.startingCash;
}

function recordCapitalDeposit(acct, amount, { note = "manual deposit" } = {}) {
  const amt = +parseFloat(amount) || 0;
  if (!amt) return acct.config.startingCash;
  const before = acct.config.startingCash || 0;
  acct.config.startingCash = Math.max(1, +(before + amt).toFixed(2));
  if (!acct.state.capitalEvents) acct.state.capitalEvents = [];
  acct.state.capitalEvents.push({
    ts: Date.now(),
    type: amt > 0 ? "deposit" : "withdrawal",
    amount: +amt.toFixed(2),
    equity: acct.state.brokerEquity ?? null,
    capitalBase: acct.config.startingCash,
    note,
    auto: false,
  });
  if (acct.state.risk && typeof acct.state.risk.dayStartPV === "number" && acct.state.risk.dayStartPV > 0) {
    acct.state.risk.dayStartPV = +(acct.state.risk.dayStartPV + amt).toFixed(2);
  }
  log(acct, `CAPITAL: ${amt > 0 ? "deposit" : "withdrawal"} $${Math.abs(amt).toFixed(0)} recorded → capital base $${acct.config.startingCash.toFixed(0)} (${note})`);
  saveAccounts();
  return acct.config.startingCash;
}

// ─── Trust-Scaled Cash Reserve ───
// "Trust" blends the conviction signals available at entry into a 0..1 score. Higher trust lets
// the bot draw the cash buffer down from CASH_RESERVE_MAX toward CASH_RESERVE_MIN.
function computeTradeTrust({ claudeConfidence = null, setupQuality = 50, technicalScore = 50, isBullish = true, cfg = {}, regime = null }) {
  const clamp01 = x => Math.max(0, Math.min(1, x));
  // Claude confidence: 50% → 0, 100% → 1. If unavailable, treat as neutral 0.5.
  const conf = claudeConfidence == null ? 0.5 : clamp01((claudeConfidence - 50) / 50);
  // Setup quality: minSetupQuality → 0, 100 → 1.
  const minQ = cfg.minSetupQuality ?? 50;
  const setup = clamp01((setupQuality - minQ) / Math.max(1, 100 - minQ));
  // Technical extremity past the entry threshold.
  let tech;
  if (isBullish) {
    const lo = cfg.bullEntry ?? 68;
    tech = clamp01((technicalScore - lo) / Math.max(1, 100 - lo));
  } else {
    const hi = cfg.bearEntry ?? 32;
    tech = clamp01((hi - technicalScore) / Math.max(1, hi));
  }
  // Weighted blend — Claude conviction and setup quality carry the most weight.
  let trust = 0.45 * conf + 0.35 * setup + 0.20 * tech;
  // Risk-off regime caps trust so we stay defensive on the cash buffer.
  if (regime && regime.mode === "risk-off") trust = Math.min(trust, 0.4);
  if (regime && regime.mode === "choppy") trust = Math.min(trust, 0.55);
  return clamp01(trust);
}

// Maps trust (0..1) onto the required cash-reserve fraction (CASH_RESERVE_MAX..CASH_RESERVE_MIN).
function cashReservePct(trust) {
  return CASH_RESERVE_MAX - trust * (CASH_RESERVE_MAX - CASH_RESERVE_MIN);
}

// Cash available to deploy after honoring the trust-scaled reserve buffer (sized off portfolio value).
function deployableCash(state, pv, trust) {
  const reservePct = cashReservePct(trust);
  const requiredReserve = pv * reservePct;
  return { deployable: Math.max(0, state.cash - requiredReserve), reservePct, requiredReserve };
}

function signalLabel(score) {
  if (score >= 70) return "STRONG BUY";
  if (score >= 55) return "BUY WATCH";
  if (score >= 45) return "NEUTRAL";
  if (score >= 30) return "SELL WATCH";
  return "STRONG SELL";
}

// ─── Loss Circuit Breakers ───
// Enforces the config knobs that previously existed but were never checked anywhere:
//   maxConsecutiveLosses — N losing closes in a row → no new entries for the rest of the ET day
//   dailyLossLimitPct    — PV down X% from the day's start → live accounts PAUSE, paper blocks entries
//   maxDayTrades         — hard cap on new entries per ET day
// State lives in state.risk (persisted via saveAccounts) and resets at each new ET day.

function ensureRiskState(acct, pv = null) {
  const state = acct.state;
  const today = getETDateStr();
  state.portfolioRisk = rollPortfolioRiskState(state.portfolioRisk || {}, {
    pv,
    dateKey: today,
    now: Date.now(),
  });
  if (!state.risk || state.risk.date !== today) {
    state.risk = {
      date: today,
      // Baseline for the daily loss limit. Falls back to the first PV we see today.
      dayStartPV: (typeof pv === "number" && pv > 0) ? pv : null,
      dayTrades: 0,
      consecLosses: state.portfolioRisk.consecutiveLosses || 0,
      haltNotified: null,
    };
  } else if (state.risk.dayStartPV == null && typeof pv === "number" && pv > 0) {
    state.risk.dayStartPV = pv;
  }
  state.risk.consecLosses = state.portfolioRisk.consecutiveLosses || 0;
  return state.risk;
}

// Feed a realized close into the consecutive-loss streak. Called from every close path:
// paper closes (real fills), Tradier exit submissions (estimates, reconciled later), and
// Robinhood closes detected by sync. Sim accounts never touch live breaker state.
function recordTradeOutcome(acct, pnlDollar) {
  if (acct._simMode) return;
  const r = ensureRiskState(acct);
  acct.state.portfolioRisk = recordPortfolioOutcome(acct.state.portfolioRisk || {}, {
    pnlDollar,
    now: Date.now(),
    lossCooldownMs: 60 * 60_000,
  });
  r.consecLosses = acct.state.portfolioRisk.consecutiveLosses || 0;
  const max = acct.config.maxConsecutiveLosses;
  if (max && r.consecLosses >= max && r.haltNotified !== "consec") {
    r.haltNotified = "consec";
    const msg = `${r.consecLosses} consecutive losing closes — new entries blocked pending manual review (exits keep running).`;
    log(acct, `🛑 CIRCUIT BREAKER: ${msg}`);
    diag("risk_halt", acct, { kind: "consecutive_losses", consecLosses: r.consecLosses, max });
    sendPush(`🛑 Loss streak halt [${acct.name}]`, msg, true).catch(() => {});
  }
}

// Entry-time gate. Returns a human-readable reason when new entries are blocked, else null.
function riskBreakerStatus(acct) {
  const cfg = acct.config;
  const pv = portfolioValue(acct.state, acct.dashboard?.quotes || {});
  const r = ensureRiskState(acct, pv);

  if (cfg.maxDayTrades && r.dayTrades >= cfg.maxDayTrades) {
    return `Circuit breaker: day-trade cap reached (${r.dayTrades}/${cfg.maxDayTrades} entries today)`;
  }
  const portfolioBlock = portfolioEntryBlock({ risk: acct.state.portfolioRisk, pv, config: cfg, now: Date.now() });
  if (portfolioBlock?.kind === "loss_cooldown") {
    return `Circuit breaker: portfolio cooling down ${Math.max(1, Math.ceil((portfolioBlock.until - Date.now()) / 60_000))}m after a loss`;
  }
  if (portfolioBlock?.kind === "consecutive_losses") {
    return `Circuit breaker: ${portfolioBlock.losses} consecutive losses (max ${portfolioBlock.limit}) — manual review required`;
  }
  if (portfolioBlock?.kind === "weekly_loss") {
    return `Circuit breaker: weekly loss ${(portfolioBlock.drawdownPct * 100).toFixed(1)}% breaches -${(cfg.weeklyLossLimitPct * 100).toFixed(1)}% limit`;
  }
  if (portfolioBlock?.kind === "high_water_drawdown") {
    return `Circuit breaker: drawdown ${(portfolioBlock.drawdownPct * 100).toFixed(1)}% from high water breaches -${(cfg.highWaterDrawdownLimitPct * 100).toFixed(1)}% limit`;
  }
  if (cfg.dailyLossLimitPct > 0 && r.dayStartPV > 0 && pv > 0) {
    const dayPnlPct = (pv - r.dayStartPV) / r.dayStartPV;
    if (dayPnlPct <= -cfg.dailyLossLimitPct) {
      return `Circuit breaker: daily loss ${(dayPnlPct * 100).toFixed(1)}% breaches -${(cfg.dailyLossLimitPct * 100).toFixed(0)}% limit`;
    }
  }
  return null;
}

const LIVE_BALANCE_MAX_AGE_MS = 90_000;

function liveEntryCommitBlock(acct, entryEpoch = null) {
  const broker = acct?.config?.broker;
  if (broker !== "tradier" && broker !== "robinhood") return null;
  if (acct.config.liveEntriesEnabled !== true) {
    return "Live entries are observation-only pending forward validation; protective exits remain active";
  }
  if (acct.paused) return `Account is paused (${acct.pausedBy || "manual"})`;
  if (entryEpoch != null && entryEpoch !== (acct._entryEpoch || 0)) {
    return "Entry authorization changed while the setup was being prepared";
  }
  const balanceAt = Number(acct.state?.brokerBalanceAt);
  if (!(balanceAt > 0) || Date.now() - balanceAt > LIVE_BALANCE_MAX_AGE_MS) {
    return "Authoritative broker cash/equity is stale; refusing a live entry";
  }
  if (broker === "robinhood" && acct.state?.brokerHealth?.status === "disconnected") {
    return "Robinhood health probe is failing";
  }
  if (broker === "robinhood" && RH_REQUIRE_APPROVAL) {
    return "Robinhood manual-approval mode has no durable broker queue; use observation mode instead";
  }
  return null;
}

// Cycle-level halt check (runs even when no entry is attempted, so a drawdown on OPEN positions
// still trips it). Live broker accounts are paused outright — the paused cycle keeps managing
// exits but nothing new opens until manually resumed.
function evaluateRiskHalts(acct, pv) {
  const cfg = acct.config;
  const r = ensureRiskState(acct, pv);
  if (!(pv > 0)) return;
  const dayPnlPct = r.dayStartPV > 0 ? (pv - r.dayStartPV) / r.dayStartPV : 0;
  const portfolioBlock = portfolioEntryBlock({ risk: acct.state.portfolioRisk, pv, config: cfg, now: Date.now() });
  let kind = null;
  let msg = null;
  let baseline = r.dayStartPV;
  let drawdownPct = dayPnlPct;
  if (cfg.dailyLossLimitPct > 0 && r.dayStartPV > 0 && dayPnlPct <= -cfg.dailyLossLimitPct) {
    kind = "daily";
    msg = `Portfolio ${(dayPnlPct * 100).toFixed(1)}% on the day (start $${r.dayStartPV.toFixed(0)} → $${pv.toFixed(0)}), limit -${(cfg.dailyLossLimitPct * 100).toFixed(1)}%.`;
  } else if (portfolioBlock?.kind === "weekly_loss") {
    kind = "weekly";
    baseline = portfolioBlock.baseline;
    drawdownPct = portfolioBlock.drawdownPct;
    msg = `Portfolio ${(drawdownPct * 100).toFixed(1)}% this week (start $${baseline.toFixed(0)} → $${pv.toFixed(0)}), limit -${(cfg.weeklyLossLimitPct * 100).toFixed(1)}%.`;
  } else if (portfolioBlock?.kind === "high_water_drawdown") {
    kind = "high_water";
    baseline = portfolioBlock.baseline;
    drawdownPct = portfolioBlock.drawdownPct;
    msg = `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% from high water $${baseline.toFixed(0)} → $${pv.toFixed(0)}, limit -${(cfg.highWaterDrawdownLimitPct * 100).toFixed(1)}%.`;
  }
  if (!kind) return;
  if (r.haltNotified === kind || (kind !== "daily" && acct.state.portfolioRisk?.haltNotified === kind)) return;
  r.haltNotified = kind;
  if (kind !== "daily") acct.state.portfolioRisk.haltNotified = kind;
  const isLive = cfg.broker === "tradier" || cfg.broker === "robinhood";
  msg += isLive ? " Account PAUSED — exits keep running; resume manually from the dashboard." : " New entries blocked.";
  log(acct, `🚨 ${kind.toUpperCase()} RISK HALT: ${msg}`);
  diag("risk_halt", acct, { kind, drawdownPct: +(drawdownPct * 100).toFixed(1), baseline: +baseline.toFixed(2), pv: +pv.toFixed(2), paused: isLive });
  if (!acct.learning) sendPush(`🚨 Portfolio risk halt [${acct.name}]`, msg, true).catch(() => {});
  if (isLive) {
    acct.paused = true;
    acct.pausedBy = "risk"; // breaker pause: exits keep managing open positions
    acct._entryEpoch = (acct._entryEpoch || 0) + 1;
    saveAccounts();
    // Risk halt must not leave yesterday's working buys live on the broker.
    scheduleWorkingEntryCancellation(acct, `${kind} risk halt`);
  }
}

// ─── LLM API Usage Tracking (global/shared) ───
let claudeCallCount = 0;  // kept as "claudeCallCount" for backward compat with dashboard/API
let claudeTotalInputTokens = 0;
let claudeTotalOutputTokens = 0;
const HAIKU_INPUT_COST = 1.00 / 1_000_000;   // $1.00 per 1M input tokens
const HAIKU_OUTPUT_COST = 5.00 / 1_000_000;  // $5.00 per 1M output tokens
const GEMINI_INPUT_COST = 0.30 / 1_000_000;  // $0.30 per 1M input tokens (Gemini 2.5 Flash)
const GEMINI_OUTPUT_COST = 2.50 / 1_000_000; // $2.50 per 1M output tokens (Gemini 2.5 Flash)

function getClaudeCost() {
  if (LLM_PROVIDER === "gemini") {
    return (claudeTotalInputTokens * GEMINI_INPUT_COST + claudeTotalOutputTokens * GEMINI_OUTPUT_COST);
  }
  return (claudeTotalInputTokens * HAIKU_INPUT_COST + claudeTotalOutputTokens * HAIKU_OUTPUT_COST);
}

function getLLMLabel() {
  return LLM_PROVIDER === "gemini" ? "Gemini 2.5 Flash" : "Claude Haiku 4.5";
}

// ─── Claude Entry Validation Cooldown Cache ───
// ─── Validation Cache ───
// Caches Claude's decision AND the selected contract so cache hits skip both
// the Finnhub chain fetch and the Claude call entirely.
// Global cache — keyed by ticker (not per-account) since the validation prompt is based on
// market data, not account state. All accounts share results for the same ticker/direction/score.
const claudeValidationCache = new Map();
const CLAUDE_VALIDATION_COOLDOWN_MS = 30 * 60_000; // 30 minutes — markets don't shift radically every 15 min
const CLAUDE_VALIDATION_SCORE_DELTA = 8;            // re-validate only on a real shift (≥8 pts)

function getCachedValidation(acctId, ticker, currentScore, direction, context = "") {
  const cached = claudeValidationCache.get(`${acctId}:${ticker}:${context}`);
  if (!cached) return null;
  if (Date.now() - cached.ts > CLAUDE_VALIDATION_COOLDOWN_MS) return null;
  if (Math.abs(currentScore - cached.score) >= CLAUDE_VALIDATION_SCORE_DELTA) return null;
  if (cached.direction !== direction) return null;
  return cached;
}

function setCachedValidation(acctId, ticker, score, direction, result, selectedCandidate = null, context = "") {
  claudeValidationCache.set(`${acctId}:${ticker}:${context}`, { ts: Date.now(), score, direction, result, selectedCandidate });
}

// ─── Options Chain Cache ───
// Short-lived per-ticker chain cache so rapid re-attempts don't hammer Finnhub.
const chainCache = new Map();
// A 10-minute option quote is stale enough to turn a tight contract into a bad fill. Keep the
// cache only long enough for preflight + execution in the same cycle; refresh on the next cycle.
const CHAIN_CACHE_TTL_MS = 45_000;

function getCachedChain(ticker) {
  const cached = chainCache.get(ticker);
  if (!cached || Date.now() - cached.ts > CHAIN_CACHE_TTL_MS) return null;
  return cached.chain;
}

function setCachedChain(ticker, chain) {
  chainCache.set(ticker, { ts: Date.now(), chain });
}

async function callClaudeRaw(prompt, retries = 3, maxTokens = 1024) {
  if (!CLAUDE_API_KEY) throw new Error("CLAUDE_API_KEY not set");
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      const retryable = [429, 500, 502, 503, 504, 529].includes(r.status);
      if (retryable && attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise(res => setTimeout(res, backoff));
        continue;
      }
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
}

async function callGemini(prompt, retries = 3, maxTokens = 1024) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      }
    );
    if (!r.ok) {
      const err = await r.text();
      const retryable = [429, 500, 502, 503, 504].includes(r.status);
      if (retryable && attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise(res => setTimeout(res, backoff));
        continue;
      }
      throw new Error(`Gemini API ${r.status}: ${err}`);
    }
    const data = await r.json();
    claudeCallCount++;
    // Gemini reports token usage in usageMetadata
    if (data.usageMetadata) {
      claudeTotalInputTokens += data.usageMetadata.promptTokenCount || 0;
      claudeTotalOutputTokens += data.usageMetadata.candidatesTokenCount || 0;
    }
    // Extract text from Gemini response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  }
}

// Unified LLM dispatcher — routes to active provider
async function callClaude(prompt, retries = 3, maxTokens = 1024) {
  if (LLM_PROVIDER === "gemini") {
    return callGemini(prompt, retries, maxTokens);
  }
  return callClaudeRaw(prompt, retries, maxTokens);
}

// Robust JSON extractor for LLM responses. Strips markdown fences, isolates the
// first balanced {...} object, and repairs the common truncation case (response
// cut off mid-string by max_tokens) by closing dangling strings/braces so we get
// a usable object instead of silently failing the parse.
function extractLLMJSON(raw) {
  let s = String(raw || "").replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
  const start = s.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  s = s.slice(start);

  // Fast path: already valid.
  try { return JSON.parse(s); } catch { }

  // Helper: brace depth of a fragment, ignoring braces inside strings. Returns
  // -1 if the fragment ends mid-string (an unsafe cut point).
  const depthOf = frag => {
    let d = 0, inStr = false, esc = false;
    for (let i = 0; i < frag.length; i++) {
      const ch = frag[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    return inStr ? -1 : d;
  };

  // First-complete-object path: the model often appends prose after valid JSON.
  // Slice out the first balanced top-level {...} and parse just that.
  {
    let d = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") d++;
      else if (ch === "}") { d--; if (d === 0) { try { return JSON.parse(s.slice(0, i + 1)); } catch { } break; } }
    }
  }

  // Repair path: the model truncated mid-object. Try closing the response as-is,
  // then progressively trim back to each earlier comma (dropping the incomplete
  // trailing pair) until a balanced object parses.
  let base = s;
  if (depthOf(s) === -1) base += '"'; // close a dangling string
  const cuts = [base.length];
  for (let i = base.length - 1; i >= 0; i--) if (base[i] === ",") cuts.push(i);
  for (const cut of cuts) {
    const frag = base.slice(0, cut).replace(/[\s,:]+$/, "");
    const d = depthOf(frag);
    if (d <= 0) continue; // unbalanced or mid-string at this cut
    try { return JSON.parse(frag + "}".repeat(d)); } catch { }
  }
  throw new Error("unrepairable JSON");
}

async function processHint(hintText, acct) {
  const state = acct.state;
  const dash = acct.dashboard;
  // Full per-position detail (basis, live mark, P&L, stop/target levels) so the assistant can
  // answer "will it hit my stop?" instead of claiming not to know its own bot's stop level.
  const cfg = acct.config;
  const positionLines = state.positions.map(p => {
    const isEq = p.type === "equity";
    const plan = managementPlanFor(p, cfg);
    const cur = p.liveMark ?? null;
    const pnlStr = cur != null && p.entryPremium > 0 ? `${(((cur - p.entryPremium) / p.entryPremium) * 100).toFixed(1)}%` : "?";
    const stopMult = plan.stopLoss;
    const stopP = p.entryPremium > 0 ? (p.entryPremium * (1 + stopMult)).toFixed(2) : "?";
    const tpP = p.entryPremium > 0 ? (p.entryPremium * (1 + plan.profitTarget)).toFixed(2) : "?";
    return `${p.ticker} ${isEq ? "shares" : `$${p.strike} ${p.type.toUpperCase()}`} x${p.qty}: entry $${p.entryPremium?.toFixed(2)}, now $${cur != null ? cur.toFixed(2) : "?"} (${pnlStr}), confirmed stop $${stopP} (${(stopMult * 100).toFixed(0)}%${isEq ? "" : "; repeated coherent exact bids required"}), frozen target $${tpP} (+${(plan.profitTarget * 100).toFixed(0)}%)${isEq ? "" : `, ${(p.dteRemaining ?? p.dte ?? 0).toFixed(0)} DTE`}`;
  });
  const portfolioContext = `Portfolio: $${state.cash.toFixed(0)} cash, ${state.positions.length} positions open${positionLines.length ? `:\n${positionLines.join("\n")}` : " (none)"}. Watchlist: ${acct.tickers.join(", ")}. Active hints: ${acct.activeHints.map(h => `${h.ticker} ${h.bias > 0 ? '+' : ''}${h.bias}`).join(", ") || "none"}.`;

  // Gather any available analysis for tickers mentioned in the message
  const mentionedTickers = Object.keys(dash.analyses).filter(t =>
    hintText.toUpperCase().includes(t));
  const analysisContext = mentionedTickers.map(t => {
    const a = dash.analyses[t]; const st = dash.shortTermAnalyses[t]; const q = dash.quotes[t];
    return `${t}: price $${q?.c?.toFixed(2) || '?'}, score ${a?.score}/100 (${a?.signal}), 7d score ${st?.score || '?'}, RSI ${a?.rsi?.toFixed(1) || '?'}`;
  }).join("; ");

  const promptText = `You are an AI assistant for a swing options trading bot. The user said:

"${hintText}"

${portfolioContext}
${analysisContext ? `\nCurrent data: ${analysisContext}` : ''}

Determine intent and respond with ONLY valid JSON (no markdown, no backticks):
{
  "type": "action" | "question",
  "response": "Your conversational reply to show the user (1-4 sentences, be specific and useful)",
  "tickers": [{"symbol": "PLTR", "direction": "bullish", "bias": 25, "reasoning": "brief"}],
  "removeTickers": [],
  "urgency": "high" | "medium" | "low",
  "advice": "one sentence action summary"
}

Rules:
- type="question" for questions, analysis requests, portfolio status, or anything conversational. Fill "response" with a helpful answer. Tickers/removeTickers should be empty unless you're also adding a watch.
- type="action" for directives: "watch X", "focus on Y", "remove Z", "go bullish on X". Fill tickers/removeTickers/urgency/advice AND a confirmation in "response".
- For type="question", "advice" can be empty string.
- bias is -30 to +30 score adjustment. direction is "bullish" or "bearish".
- "tickers" symbols MUST be stock symbols the user explicitly named. NEVER turn ordinary English words from the message (like "and", "list", "watch") into symbols. If unsure a word is a ticker, leave it out and ask in "response".
- Keep responses concise and direct — this is shown in a trading terminal.`;

  try {
    const raw = await callClaude(promptText);
    return extractLLMJSON(raw);
  } catch (e) {
    log(acct, `CLAUDE WARN: Failed to parse hint response — ${e.message}`);
    const direct = inferDirectWatchlistDirectives(hintText);
    if (direct.tickers.length > 0 || direct.removeTickers.length > 0) {
      return {
        type: "action",
        response: "",
        tickers: direct.tickers,
        removeTickers: direct.removeTickers,
        urgency: "medium",
        advice: direct.tickers.length > 0
          ? `Adding ${direct.tickers.map(t => t.symbol).join(", ")} to the watchlist.`
          : `Removing ${direct.removeTickers.join(", ")} from the watchlist.`,
      };
    }
    return null;
  }
}

async function checkHints(acct) {
  if (acct.learning) return; // variants take no chat directives — the experiment stays controlled
  // Check file-based hints (for default account or single-account mode)
  try {
    const hintFile = accounts.size <= 1 ? HINT_FILE : `hint-${acct.id}.txt`;
    if (!fs.existsSync(hintFile)) return;
    const content = fs.readFileSync(hintFile, "utf-8").trim();
    if (!content || content === acct.lastHintContent) return;

    acct.lastHintContent = content;
    log(acct, `HINT RECEIVED: "${content}"`);

    const result = await processHint(content, acct);
    if (!result) return;

    await applyHintResult(acct, result, content);

    // Clear the hint file after processing
    fs.writeFileSync(hintFile, "");

  } catch (e) {
    log(acct, `HINT ERROR: ${e.message}`);
  }
}

async function applyHintResult(acct, result, userMessage) {
  const direct = inferDirectWatchlistDirectives(userMessage);
  if (direct.tickers.length > 0) {
    const existing = new Set((result.tickers || []).map(t => String(t.symbol || "").toUpperCase()));
    result.tickers = [...(result.tickers || [])];
    for (const t of direct.tickers) {
      if (!existing.has(t.symbol)) result.tickers.push(t);
    }
  }
  if (direct.removeTickers.length > 0) {
    result.removeTickers = [...new Set([...(result.removeTickers || []).map(s => String(s).toUpperCase()), ...direct.removeTickers])];
  }

  if (result.advice) log(acct, `CLAUDE SAYS: ${result.advice || result.response}`);

  const mutation = { added: [], existing: [], removed: [], notFound: [], rejected: [] };

  for (const t of result.tickers || []) {
    const symbol = String(t.symbol || "").toUpperCase();
    const add = addTickerToWatchlist(acct, symbol, `hint ${t.direction || "watch"} bias ${t.bias > 0 ? "+" : ""}${t.bias || 0}`);
    if (add.rejected) {
      mutation.rejected.push(`${symbol} (${add.reason})`);
      continue;
    }
    if (add.added) {
      mutation.added.push(symbol);
      await addRhWatchlistCandidate({ ticker: symbol, source: "chat directive", force: direct.direct });
    } else {
      mutation.existing.push(symbol);
      log(acct, `BIAS ${symbol}: ${t.bias > 0 ? "+" : ""}${t.bias || 0} (${t.direction || "watch"}) — ${t.reasoning || "user directive"}`);
    }

    const bias = Number(t.bias) || 0;
    if (bias !== 0) {
      const existing = acct.activeHints.findIndex(h => h.ticker === symbol);
      const hint = {
        ticker: symbol,
        bias,
        direction: t.direction || (bias < 0 ? "bearish" : "bullish"),
        reasoning: t.reasoning || "User directive",
        expiresAt: Date.now() + 4 * 60 * 60_000,
      };
      if (existing >= 0) acct.activeHints[existing] = hint;
      else acct.activeHints.push(hint);
    }
  }

  for (const sym of result.removeTickers || []) {
    const out = removeTickerFromWatchlist(acct, sym, "hint directive");
    if (out.removed) mutation.removed.push(String(sym).toUpperCase());
    else mutation.notFound.push(String(sym).toUpperCase());
  }

  if (direct.direct || mutation.added.length || mutation.removed.length || mutation.rejected.length) {
    const parts = [];
    if (mutation.added.length) parts.push(`Added ${mutation.added.join(", ")} to the watchlist`);
    if (mutation.existing.length) parts.push(`${mutation.existing.join(", ")} ${mutation.existing.length === 1 ? "is" : "are"} already on the watchlist`);
    if (mutation.removed.length) parts.push(`Removed ${mutation.removed.join(", ")} from the watchlist`);
    if (mutation.notFound.length) parts.push(`${mutation.notFound.join(", ")} ${mutation.notFound.length === 1 ? "was" : "were"} not on the watchlist`);
    if (mutation.rejected.length) parts.push(`Rejected ${mutation.rejected.join(", ")}`);
    result.response = parts.join(". ") + (parts.length ? "." : "");
  }

  // Store in chat history (keep last 30 exchanges)
  if (!acct.chatHistory) acct.chatHistory = [];
  acct.chatHistory.push({ role: "user", content: userMessage, ts: Date.now() });
  acct.chatHistory.push({ role: "ai", content: result.response || result.advice || "", ts: Date.now() });
  if (acct.chatHistory.length > 60) acct.chatHistory = acct.chatHistory.slice(-60);

  saveAccounts();
  try {
    for (const [, a] of accounts) {
      if (a !== acct && mutation.added.length) {
        for (const sym of mutation.added) addTickerToWatchlist(a, sym, `mirrored from ${acct.name} chat directive`);
      }
    }
    if (mutation.added.length) saveAccounts();
  } catch {
    // Best-effort cross-account mirroring only.
  }
}

function getHintBias(acct, ticker) {
  if (acct.learning) return 0;
  const now = Date.now();
  acct.activeHints = acct.activeHints.filter(h => h.expiresAt > now);
  const hint = acct.activeHints.find(h => h.ticker === ticker);
  return hint ? hint.bias : 0;
}

function getActiveHintsSummary(acct) {
  const now = Date.now();
  acct.activeHints = acct.activeHints.filter(h => h.expiresAt > now);
  if (acct.activeHints.length === 0) return "";
  return " | Hints: " + acct.activeHints.map(h => {
    const mins = Math.round((h.expiresAt - now) / 60_000);
    return `${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${mins}m left on watch)`;
  }).join(", ");
}

// ─── Auto News Scanner (runs every 3 hours) ───

const NEWS_INTERVAL = 60 * 60_000; // 1 hour
let globalLastNewsScan = 0; // shared across all accounts to avoid duplicate Claude calls

async function fetchMarketNews(apiKey, tickers) {
  const headlines = [];

  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${apiKey}`);
    if (r.ok) {
      const articles = await r.json();
      for (const a of articles.slice(0, 15)) {
        headlines.push({ title: a.headline, source: a.source, time: a.datetime, summary: a.summary?.slice(0, 200) || "" });
      }
    }
  } catch { }

  for (const ticker of tickers.slice(0, 5)) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${todayStr()}&to=${todayStr()}&token=${apiKey}`);
      if (r.ok) {
        const articles = await r.json();
        for (const a of articles.slice(0, 3)) {
          headlines.push({ title: a.headline, source: a.source, ticker, summary: a.summary?.slice(0, 200) || "" });
        }
      }
      await delay(apiDelay());
    } catch { }
  }

  return headlines;
}

function todayStr() {
  const d = getETDate();
  return d.toISOString().slice(0, 10);
}

async function runNewsScan(acct, apiKey) {
  if (acct.learning) return; // no LLM spend and no hint injection on learning variants
  const now = Date.now();
  if (now - globalLastNewsScan < NEWS_INTERVAL) return;
  globalLastNewsScan = now;
  acct.lastNewsScan = now; // keep per-account field in sync for display

  const state = acct.state;
  log(acct, "NEWS SCAN: Fetching latest market headlines...");

  const headlines = await fetchMarketNews(apiKey, acct.tickers);
  if (headlines.length === 0) {
    log(acct, "NEWS SCAN: No headlines fetched");
    return;
  }

  const headlineText = headlines.map((h, i) =>
    `${i + 1}. [${h.source}${h.ticker ? ` / ${h.ticker}` : ""}] ${h.title}${h.summary ? ` — ${h.summary}` : ""}`
  ).join("\n");

  const positionContext = state.positions.length > 0
    ? `Current positions: ${state.positions.map(p => `${p.ticker} ${p.type.toUpperCase()} $${p.strike}`).join(", ")}`
    : "No open positions";

  const promptText = `You are a trading bot's market intelligence system. Analyze these headlines for anything that could drastically impact markets in the next few hours.

CURRENT HEADLINES:
${headlineText}

PORTFOLIO CONTEXT:
Cash: $${state.cash.toFixed(0)} | ${positionContext}
Watchlist: ${acct.tickers.join(", ")}

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
    // News briefs carry several ticker impacts — give headroom so the JSON closes.
    const raw = await callClaude(promptText, 3, 1536);
    const result = extractLLMJSON(raw);

    const sevColor = result.severity === "critical" ? "!!!" : result.severity === "elevated" ? "!!" : "";
    log(acct, `NEWS ${sevColor}${result.severity.toUpperCase()}: ${result.summary}`);

    if (result.blackSwan) {
      log(acct, "BLACK SWAN DETECTED — Claude recommends defensive action");
      log(acct, `ACTION ADVICE: ${result.actionAdvice}`);
    }

    // The news scan runs once globally (3h gate), so broadcast the brief + bias hints to EVERY
    // account — otherwise only the first account that runs it would show news / get the hints.
    const brief = `[${result.severity.toUpperCase()}] ${result.summary}`;
    for (const [, a] of accounts) {
      a.latestNewsBrief = brief;

      for (const impact of result.impacts || []) {
        if (!isValidTickerSymbol(impact.ticker)) {
          if (a === acct) log(acct, `NEWS: rejected "${impact.ticker}" — invalid ticker shape`);
          continue;
        }
        if (a.badTickers?.[impact.ticker]?.blocked) continue;
        if (!a.tickers.includes(impact.ticker)) {
          a.tickers.push(impact.ticker);
          if (a === acct) log(acct, `NEWS WATCHLIST +${impact.ticker}`);
        }

        const existing = a.activeHints.findIndex(h => h.ticker === impact.ticker);
        const hint = {
          ticker: impact.ticker,
          bias: impact.bias,
          direction: impact.direction,
          reasoning: `[NEWS] ${impact.reasoning}`,
          expiresAt: Date.now() + 3 * 60 * 60_000,
        };
        if (existing >= 0) a.activeHints[existing] = hint;
        else a.activeHints.push(hint);

        if (a === acct) log(acct, `NEWS BIAS: ${impact.ticker} ${impact.bias > 0 ? "+" : ""}${impact.bias} (${impact.direction}) — ${impact.reasoning}`);
      }

      for (const ticker of result.newTickers || []) {
        tryAddTicker(a, ticker, "news scan");
      }
    }

    if (result.severity === "critical" || result.severity === "elevated") {
      log(acct, `NEWS ADVICE: ${result.actionAdvice}`);
    }

    return result;
  } catch (e) {
    log(acct, `NEWS SCAN ERROR: ${e.message}`);
    return null;
  }
}

// ─── Claude Pre-Entry Validation ───

async function validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime, candidates, effectiveQuality = setupQuality.quality) {
  const cfg = acct.config;
  const isEquity = cfg.broker === "robinhood" && rhTradeMode(cfg) === "equity";
  const direction = analysis.score >= cfg.bullEntry
    ? (isEquity ? 'BULLISH (buying shares)' : 'BULLISH (buying calls)')
    : (isEquity ? 'BEARISH' : 'BEARISH (buying puts)');

  // Build the candidate contract table if we have real chain data
  let contractSection = '';
  let contractInstruction = '';
  if (candidates && candidates.length > 0) {
    const header = `#  | Expiry      | DTE | Strike   | Mid    | IV    | Delta | OI      | Vol    | Spread`;
    const rows = candidates.map((c, i) => {
      const num = String(i + 1).padStart(2);
      const exp = c.expiryStr.slice(5);
      const dte = String(c.dte).padStart(3);
      const strike = `$${c.strike}`.padStart(8);
      const mid = `$${c.mid}`.padStart(6);
      const iv = c.iv != null ? `${(c.iv * 100).toFixed(0)}%`.padStart(5) : '   ?%';
      const delta = c.delta != null ? String(Math.abs(c.delta).toFixed(2)).padStart(5) : '   ?';
      const oi = String(c.oi).padStart(7);
      const vol = String(c.volume).padStart(6);
      const spread = `$${c.spread}`;
      return `${num} | ${exp}      | ${dte} | ${strike} | ${mid} | ${iv} | ${delta} | ${oi} | ${vol} | ${spread}`;
    }).join('\n');
    contractSection = `\nReal options chain (${candidates.length} pre-vetted near-the-money / ITM contracts — all δ≥${MIN_OPTION_DELTA}, no far-OTM lottery tickets):\n${header}\n${rows}`;
    contractInstruction = `\nSelect the best contract index (1-${candidates.length}). These are all real, near-the-money directional contracts — prefer the ATM-to-slightly-ITM strike (δ${PREFERRED_DELTA_MIN}-${PREFERRED_DELTA_MAX}) with the best liquidity and tightest spread. Only approve if this is a genuinely high-conviction setup worth real capital; we trade infrequently and only take trades likely to win — when in doubt, PASS.`;
  } else if (isEquity) {
    contractSection = '\nThis is an EQUITY (shares) trade — no options contracts. Evaluate whether buying shares at the current price is a good swing entry.';
  } else {
    contractSection = '\nNo real listed contract with an executable market is available — you must reject the trade.';
  }

  const tradeType = isEquity ? 'equity (shares) trade' : 'options trade';
  const evalQuestions = isEquity
    ? `Evaluate:
1. Is this a quality setup for buying shares, or chasing an extended move?
2. Key risks for this swing trade given current conditions?
3. What price targets and stop levels would you suggest?`
    : `Evaluate:
1. Is this a quality setup or chasing an extended move?
2. Key risks for this trade given current conditions?
3. Best contract choice and why (DTE, strike depth)?
${contractInstruction}`;

  const promptText = `You are a trading bot's risk management system. Evaluate this potential ${tradeType}.

Ticker: ${ticker}
Price: $${quote.c.toFixed(2)}
Direction: ${direction}
Technical Score: ${analysis.score}/100
RSI: ${analysis.rsi?.toFixed(1) || 'N/A'}
EMA Stack: ${analysis.aligned ? 'Aligned bullish (8>21>50)' : analysis.bearish ? 'Aligned bearish (50>21>8)' : 'Mixed/transitioning'}
Setup Quality: ${effectiveQuality}/100 (${effectiveQuality > setupQuality.quality ? 'momentum-runner quality exceeds base quality' : setupQuality.tight ? 'tight base' : 'wide range'}, ${setupQuality.breakingOut ? 'breaking out' : 'no base breakout'}, vol ${setupQuality.volDeclining ? 'declining in base' : 'normal'})
Market Regime: ${regime.label}
${earningsInfo.hasEarnings ? `⚠ EARNINGS in ${earningsInfo.daysUntil} days (${earningsInfo.date}); eligible contracts expire before it` : 'No reported earnings inside the option horizon'}
${cfg.customPromptSuffix ? `Additional context: ${cfg.customPromptSuffix}` : ''}
${contractSection}

${evalQuestions}

Respond with ONLY valid JSON (no markdown, no backticks). Keep "reasoning" tight — 2-3 sentences
covering the setup read, the main risk, and why you approve/reject the ${isEquity ? 'entry' : 'contract'}.
"suggestion" is a one-line takeaway. Do not pad; brevity is graded:
{"approve": true, "confidence": 75, "concerns": [], "reasoning": "2-3 sentence rationale", "suggestion": "one-line takeaway"${candidates?.length > 0 ? ', "contractIdx": 1' : ''}}`;

  try {
    const raw = await callClaude(promptText, 3, 512);
    return validateEntryDecision(extractLLMJSON(raw), { candidateCount: candidates?.length || 0 });
  } catch (e) {
    // Fail closed for live, paper, and shadow ledgers. A permissive paper fallback fabricated an
    // all-approved training set, which is just as dangerous once those statistics inform policy.
    log(acct, `CLAUDE VALIDATE WARN: Parse/schema failed — ${e.message}. Failing CLOSED (skip trade).`);
    return { approve: false, confidence: 0, concerns: ["validation parse failed"], reasoning: "AI validation unreadable — refusing the trade without a completed risk check.", suggestion: "validation failed, trade skipped", contractIdx: 0 };
  }
}

// ─── On-Demand Ticker Analysis via Claude ───

async function analyzeTickerOnDemand(acct, sym, userQuestion) {
  const dash = acct.dashboard;
  const state = acct.state;
  const a = dash.analyses[sym];
  const st = dash.shortTermAnalyses[sym];
  const q = dash.quotes[sym];
  const pos = state.positions.find(p => p.ticker === sym);
  const regime = acct.currentRegime;
  const claudeLogs = loadClaudeLog().filter(e => e.ticker === sym && e.acctId === acct.id).sort((a, b) => b.ts - a.ts);

  const priceStr = q ? `$${q.c.toFixed(2)} (${q.dp >= 0 ? '+' : ''}${q.dp?.toFixed(2)}% today)` : "unknown";
  const posStr = pos ? `Currently holding ${pos.qty}x $${pos.strike} ${pos.type.toUpperCase()} (entry $${pos.entrySpot?.toFixed(2)}, opened ${pos.openDate}, Claude confidence was ${pos.claudeConfidence}%)` : "Not currently held";
  const prevValidations = claudeLogs.slice(0, 3).map(e =>
    `  ${new Date(e.ts).toLocaleDateString()} — ${e.outcome} (${e.confidence}% confidence, $${e.price?.toFixed(2)}): "${e.suggestion}"`
  ).join("\n") || "  None";

  const promptText = `You are an expert options swing trader analyzing a stock for a 7DTE options trade. Give a thorough, direct assessment.

Stock: ${sym}
Price: ${priceStr}
Market Regime: ${regime?.label || 'unknown'}

90-Day Analysis:
  Score: ${a?.score || '?'}/100 (${a?.signal || '?'})
  RSI(14): ${a?.rsi?.toFixed(1) || '?'}
  EMA Stack (8/21/50): ${a?.aligned ? 'BULLISH ALIGNED' : a?.bearish ? 'BEARISH ALIGNED' : 'MIXED'}
  ATR%: ${a?.atrPct?.toFixed(2) || '?'}%
  Vol Ratio: ${a?.vr?.toFixed(2) || '?'}
  EMA Spread: ${a?.spread?.toFixed(2) || '?'}%

7-Day Short-Term:
  Score: ${st?.score || '?'}/100 (${st?.signal || '?'})
  RSI(5): ${st?.rsi?.toFixed(1) || '?'}
  1d Mom: ${st?.mom1d >= 0 ? '+' : ''}${st?.mom1d?.toFixed(2) || '?'}% | 3d: ${st?.mom3d >= 0 ? '+' : ''}${st?.mom3d?.toFixed(2) || '?'}% | 7d: ${st?.mom7d >= 0 ? '+' : ''}${st?.mom7d?.toFixed(2) || '?'}%

Position Status: ${posStr}

Previous AI Validations:
${prevValidations}

User question: "${userQuestion || 'Should I enter a position on this stock right now? Give me your full analysis.'}"

Respond in plain text (not JSON). Be direct and specific — mention the actual numbers. Structure your response as:
1. Current Setup Assessment (2-3 sentences on what the chart/indicators say)
2. Key Risks (bullets)
3. Recommendation (clear: enter call / enter put / wait / avoid — explain why)
4. If currently held: position management advice`;

  // On-demand analysis is user-facing prose — allow room for the full answer.
  const raw = await callClaude(promptText, 3, 1536);
  return raw.trim();
}

// ─── Entry Logic (enhanced with setup quality, EOD freeze, Claude validation) ───

async function fetchExactOptionQuote(occSymbol) {
  if (robinhood.optionsEnabled) {
    try {
      const parsed = robinhood.parseOCC(occSymbol);
      if (!parsed) return null;
      const exactId = await robinhood.resolveOptionId(
        parsed.ticker,
        parsed.expiration,
        parsed.type,
        parsed.strike,
        robinhood.accountNumber,
      );
      if (!exactId) return null;
      const raw = await robinhood.getOptionMarketData([exactId]);
      const body = raw?.data ?? raw;
      const items = Array.isArray(body) ? body
        : Array.isArray(body?.options) ? body.options
        : Array.isArray(body?.results) ? body.results
        : Array.isArray(body?.contracts) ? body.contracts : [];
      const expected = { instrumentUrl: exactId, occSymbol };
      const match = items.find(item => exactOptionQuoteMatches(expected, {
        ...item,
        ...(item.quote && typeof item.quote === "object" ? item.quote : {}),
        ...(item.market_data && typeof item.market_data === "object" ? item.market_data : {}),
      })) || null;
      const src = match?.quote && typeof match.quote === "object"
        ? { ...match, ...match.quote }
        : match?.market_data && typeof match.market_data === "object"
          ? { ...match, ...match.market_data }
          : match;
      const bid = parseFloat(src?.bid_price ?? src?.bid ?? src?.best_bid_price);
      const ask = parseFloat(src?.ask_price ?? src?.ask ?? src?.best_ask_price);
      if (bid > 0 && ask > 0 && ask >= bid) {
        return { bid, ask, mid: +((bid + ask) / 2).toFixed(2), twoSided: true, tradeable: true, source: "robinhood" };
      }
    } catch { }
  }
  return null;
}

function buildEntryPreflight({
  ticker, type, direction, strike, dte, expiryDate, qty, entryPremium, cost,
  setupQuality, claudeConfidence, trust, selectedCandidate, optionsSource, maxBudget = null,
}) {
  const contract = selectedCandidate ? {
    occSymbol: selectedCandidate.occSymbol || null,
    strike: selectedCandidate.strike,
    expiryDate: selectedCandidate.expiryDate,
    expiryStr: selectedCandidate.expiryStr,
    dte: selectedCandidate.dte,
    mid: selectedCandidate.mid,
    bid: selectedCandidate.bid,
    ask: selectedCandidate.ask,
    iv: selectedCandidate.iv,
    delta: selectedCandidate.delta,
    gamma: selectedCandidate.gamma,
    theta: selectedCandidate.theta,
    vega: selectedCandidate.vega,
    oi: selectedCandidate.oi,
    volume: selectedCandidate.volume,
    spread: selectedCandidate.spread,
    spreadPct: selectedCandidate.spreadPct,
    roundTripFrictionPct: selectedCandidate.roundTripFrictionPct,
    feeDragPct: selectedCandidate.feeDragPct,
    quality: selectedCandidate.quality,
  } : null;
  return {
    preflight: true,
    preparedAt: Date.now(),
    ticker, type, direction, strike, dte, expiryDate, qty,
    entryPremium: +entryPremium.toFixed(2),
    cost: +cost.toFixed(2),
    setupQuality,
    claudeConfidence,
    trust,
    maxBudget,
    contract,
    optionsSource,
  };
}

async function tryEntry(acct, ticker, analysis, quote, regime, apiKey, { preflightOnly = false, expectedPackage = null } = {}) {
  const state = acct.state;
  const cfg = acct.config;
  const entryEpoch = acct._entryEpoch || 0;
  const liveCommitBlock = liveEntryCommitBlock(acct, entryEpoch);
  const observationPreflight = preflightOnly
    && (cfg.broker === "tradier" || cfg.broker === "robinhood")
    && cfg.liveEntriesEnabled !== true
    && !acct.paused;
  if (liveCommitBlock && !observationPreflight) return { skipped: true, reason: liveCommitBlock };
  if (state.positions.some(p => p.ticker === ticker)) return null;
  // Broker accounts: also skip names with a working (unfilled) order this cycle so we don't
  // stack duplicate orders while an earlier one is still resting.
  if ((cfg.broker === "tradier" || cfg.broker === "robinhood") && acct._inflightTickers?.has(ticker.toUpperCase())) {
    return { skipped: true, reason: `Broker: working order already open for ${ticker}` };
  }

  // Loss circuit breakers: consecutive-loss streak, daily loss limit, day-trade cap.
  const breaker = acct._simMode ? null : riskBreakerStatus(acct);
  if (breaker) return { skipped: true, reason: breaker };

  // Recently walked away from a runaway entry on this name — don't chase it through the
  // back door with an immediate fresh order at the worse price.
  const cooldownUntil = acct._chaseCooldownUntil?.[ticker.toUpperCase()];
  if (cooldownUntil && cooldownUntil > Date.now()) {
    return { skipped: true, reason: `Cooling down ${Math.ceil((cooldownUntil - Date.now()) / 60000)}m after walking away from a runaway entry on ${ticker}` };
  }

  // Hard cap on concurrent positions — prevents over-deployment that drained cash to $25.
  // null means unlimited (user explicitly cleared the cap).
  // In choppy regimes, always cap at 3 (correlation + whipsaw risk), even when unlimited.
  const configuredMax = cfg.maxPositions != null ? cfg.maxPositions : null;
  const maxPos = regime?.mode === "choppy"
    ? (configuredMax != null ? Math.min(configuredMax, 3) : 3)
    : configuredMax;
  const openCount = (cfg.broker === "tradier" || cfg.broker === "robinhood") ? effectivePositionCount(acct) : state.positions.length;
  if (maxPos !== null && openCount >= maxPos) {
    return { skipped: true, reason: `Max positions (${maxPos}${regime?.mode === "choppy" ? ", choppy cap" : ""}) already open or pending` };
  }
  // Sector concentration cap — prevent doubling/tripling-down on correlated names.
  // Example: holding CL+XLE+USO means one bad oil headline unwinds three positions together.
  // OTHER sector is unlimited (unmapped tickers have unknown correlation).
  const sector = getSector(ticker);
  if (sector !== "OTHER") {
    const heldTickers = new Set(state.positions.map(p => p.ticker.toUpperCase()));
    const pendingInSector = [...(acct._inflightTickers || [])]
      .filter(t => !heldTickers.has(t) && getSector(t) === sector).length;
    const inSector = countPositionsInSector(state, sector) + pendingInSector;
    if (inSector >= MAX_PER_SECTOR) {
      const held = state.positions.filter(p => getSector(p.ticker) === sector).map(p => p.ticker).join(",");
      return { skipped: true, reason: `Sector cap: already ${inSector} ${sector} positions (${held}) — max ${MAX_PER_SECTOR}` };
    }
  }
  // Note: the trust-scaled cash reserve (computed at sizing time below) is the primary capital
  // guard — it keeps 25%–50% of portfolio value in cash depending on conviction.

  // Early exit: skip tickers that aren't actionable (WAIT zone) before any expensive checks
  if (analysis.score < cfg.bullEntry && analysis.score > cfg.bearEntry) return null;

  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  // Unlike the EOD freeze, this applies regardless of score — the concern is execution quality
  // (spreads/whipsaws in the opening minutes), not signal quality, so a strong score doesn't buy
  // an exemption the way it does near the close.
  if (etHour >= MARKET_OPEN_HOUR && etHour < OPEN_FREEZE_END_HOUR) {
    return { skipped: true, reason: `Opening freeze — waiting ${OPEN_FREEZE_MINUTES}min after the 9:30 ET open for spreads to settle (${etHour.toFixed(2)}h)` };
  }
  if (etHour >= EOD_FREEZE_HOUR && analysis.score < 80 && analysis.score > 20) {
    return { skipped: true, reason: `EOD freeze (${etHour.toFixed(1)} >= ${EOD_FREEZE_HOUR}h, score ${analysis.score} not extreme enough)` };
  }

  // Use the better of consolidation quality (tight base) or momentum quality (trending runner).
  // SRxTrades buys both: tight-base breakouts AND 8 EMA taps on leaders in motion.
  const isBullish = analysis.score >= cfg.bullEntry;
  const isBearish = analysis.score <= cfg.bearEntry;
  const setupQuality = detectConsolidation(acct.candleCache[ticker]);
  const momentumQuality = detectMomentumQuality(acct.candleCache[ticker]);
  const directionalQuality = directionalSetupQuality(setupQuality, momentumQuality, isBullish);
  const effectiveQuality = directionalQuality.quality;
  const minQuality = acct.config.minSetupQuality ?? 50;
  if (effectiveQuality < minQuality) {
    return { skipped: true, reason: `Low direction-matched setup quality ${effectiveQuality}/100 (base:${directionalQuality.baseQuality} mom:${directionalQuality.momentumQuality}, need >=${minQuality}, range ${setupQuality.rangePct}%)` };
  }

  // ─── Local pre-filters (catch what Claude would reject without API call) ───

  // Sean treats U&R and Uppercut as opposite-direction setups, not weights that can be washed out
  // by a composite score. A detected counter-pattern is therefore a deterministic veto.
  const undercutReclaim = detectUndercutReclaim(acct.candleCache[ticker]);
  const uppercut = detectUppercut(acct.candleCache[ticker]);
  if (isBullish && uppercut.detected) {
    return { skipped: true, reason: `Direction veto — bullish call conflicts with ${uppercut.pattern || "Uppercut"} (${uppercut.quality}/100)` };
  }
  if (isBearish && undercutReclaim.detected) {
    return { skipped: true, reason: `Direction veto — bearish put conflicts with ${undercutReclaim.pattern || "Undercut & Reclaim"} (${undercutReclaim.quality}/100)` };
  }

  const shortTerm = acct.dashboard?.shortTermAnalyses?.[ticker] || null;
  const momGate = momentumEntryGate(cfg, analysis, shortTerm, quote, isBullish);
  if (momGate) return { skipped: true, reason: momGate };

  // SRxTrades style: relative strength names often have RSI 70-90 on 8 EMA taps — that IS the setup.
  // Only block truly parabolic RSI that indicates exhaustion, not healthy momentum.
  if (isBullish && analysis.rsi > 85 && !analysis.aligned) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} parabolic with misaligned EMAs — exhaustion risk, not a healthy strength setup` };
  }
  // Robinhood without options: equity longs only — skip all bearish/put setups
  if (cfg.broker === "robinhood" && rhTradeMode(cfg) === "equity" && isBearish) {
    return { skipped: true, reason: `Robinhood: equity longs only — skipping bearish setup` };
  }

  if (isBearish && analysis.rsi > 30 && analysis.rsi < 55 && !analysis.bearish) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} neutral with non-bearish EMA stack — weak put setup` };
  }

  // Risk-off regime contradicts bullish calls
  if (isBullish && regime.mode === "risk-off" && !analysis.aligned) {
    return { skipped: true, reason: `Risk-off regime + misaligned EMAs contradicts bullish call bias` };
  }

  // Choppy regime (broken EMA stack while above 50): highest whipsaw rate — demand alignment + score.
  if (regime.mode === "choppy") {
    if (isBullish && (!analysis.aligned || analysis.score < CHOPPY_MIN_BULL_SCORE)) {
      return { skipped: true, reason: `Choppy regime — need aligned 8>21>50 stack AND score >= ${CHOPPY_MIN_BULL_SCORE} for calls (score ${analysis.score}, aligned ${analysis.aligned ? "yes" : "no"})` };
    }
    if (isBearish && (!analysis.bearish || analysis.score > CHOPPY_MIN_BEAR_SCORE)) {
      return { skipped: true, reason: `Choppy regime — puts need bearish EMA stack AND score <= ${CHOPPY_MIN_BEAR_SCORE} (score ${analysis.score})` };
    }
  }

  // Range cap: tight consolidation setups need <15%; aligned EMA leaders (SRxTrades style) allow up to 60%
  const maxRange = (analysis.aligned && isBullish) || (analysis.bearish && isBearish) ? 60 : 15;
  if (parseFloat(setupQuality.rangePct) > maxRange) {
    return { skipped: true, reason: `Range ${setupQuality.rangePct}% too wide (max ${maxRange}%) — extended move, not consolidation setup` };
  }

  let earningsInfo = { available: false, hasEarnings: false, daysUntil: null };
  try {
    earningsInfo = await checkEarningsCached(ticker, apiKey);
    await delay(apiDelay());
  } catch (error) {
    earningsInfo = { available: false, hasEarnings: false, daysUntil: null, error: error.message };
  }
  if (earningsInfo.available === false && (cfg.broker === "tradier" || cfg.broker === "robinhood")) {
    return { skipped: true, reason: `Earnings calendar unavailable (${earningsInfo.error || "unknown error"}) — live long-premium entry fails closed` };
  }
  if (earningsInfo.hasEarnings && earningsInfo.daysUntil <= 14) {
    return { skipped: true, reason: `Earnings in ${earningsInfo.daysUntil} days (${earningsInfo.date}) — every eligible swing contract would cross the event` };
  }

  const spot = quote.c;
  // Legacy `riskPct` is an allocation fraction, not risk. Keep it only as a regime-scaled
  // affordability ceiling; the risk governor below sizes from loss at the stop.
  const maxAllocationBudget = state.cash * acct.riskPct;
  const direction = isBullish ? "BULLISH" : "BEARISH";
  let type = isBullish ? "call" : "put";

  // ─── Step 1: Check validation cache (skips both chain fetch AND Claude call) ───
  let claudeResult = { approve: true, confidence: 70, concerns: [], reasoning: "", suggestion: "", contractIdx: 0 };
  let selectedCandidate = null;
  let candidates = [];

  const validationContext = `${cfg.broker}:${rhTradeMode(cfg)}:${regime?.mode || "unknown"}:${cfg.customPromptSuffix || ""}`;
  const cached = getCachedValidation(acct.id, ticker, analysis.score, direction, validationContext);
  if (cached) {
    claudeResult = cached.result;
    selectedCandidate = cached.selectedCandidate; // may be null if previously used synthetic
    log(acct, `CLAUDE VALIDATE ${ticker}: CACHED ${claudeResult.approve ? 'APPROVED' : 'REJECTED'} (${claudeResult.confidence}%) — skipping Claude call`);
    if (!claudeResult.approve) {
      return { skipped: true, reason: `Claude rejected (cached): ${claudeResult.suggestion}` };
    }
    // Robinhood without options trades equities only — skip chain fetch
    if (cfg.broker !== "robinhood" || rhUsesOptionsForEntry(cfg)) {
      try {
        let chain = getCachedChain(ticker);
        if (!chain) {
          chain = await fetchFullOptionsChain(ticker, apiKey);
          await delay(apiDelay());
          if (chain) setCachedChain(ticker, chain);
        }
        if (chain) {
          candidates = removeEarningsCrossingContracts(buildCandidateContracts(chain, type, spot, 15), earningsInfo);
          // Validation may stay cached for 30 minutes, but its contract quote must not. Remap the
          // approved strike/expiry onto the freshly built chain so bid/ask/mid are current.
          if (selectedCandidate) {
            const approved = selectedCandidate;
            selectedCandidate = candidates.find(c =>
              c.expiryStr === approved.expiryStr && Math.abs(c.strike - approved.strike) < 0.001
            ) || candidates[cached.result?.contractIdx ?? 0] || candidates[0] || null;
          }
        }
      } catch (e) {
        log(acct, `OPTIONS ${ticker}: cached affordability refresh failed — ${e.message}`);
      }
    }
  } else {
    // Robinhood without options — skip options chain, use equity-focused Claude prompt
    if (cfg.broker !== "robinhood" || rhUsesOptionsForEntry(cfg)) {
      // ─── Step 2: Fetch full options chain (with short-lived cache) ───
      try {
        let chain = getCachedChain(ticker);
        if (!chain) {
          chain = await fetchFullOptionsChain(ticker, apiKey);
          await delay(apiDelay());
          if (chain) setCachedChain(ticker, chain);
        }
        if (chain) {
          candidates = removeEarningsCrossingContracts(buildCandidateContracts(chain, type, spot, 15), earningsInfo);
          log(acct, `OPTIONS ${ticker}: ${candidates.length} viable ${type} contracts (${chain.length} expiries)`);
        }
      } catch (e) {
        log(acct, `OPTIONS ${ticker}: chain error — ${e.message}`);
      }
    }

    // ─── Step 3: Claude validates setup AND selects best contract ───
    // Learning variants trade deterministically — zero LLM spend, and the numeric gates
    // (quality/score/risk knobs) ARE the experiment variables. Pick the candidate nearest
    // the target DTE and approve on the gates that already passed above.
    if (acct.learning) {
      claudeResult = { approve: true, confidence: 60, concerns: [], reasoning: "Learning variant — deterministic entry, no LLM validation", suggestion: "", contractIdx: 0 };
      selectedCandidate = candidates.length > 0
        ? [...candidates].sort((a, b) => Math.abs(a.dte - TARGET_DTE) - Math.abs(b.dte - TARGET_DTE))[0]
        : null;
      if (!selectedCandidate) {
        return { skipped: true, reason: "Learning variant: no real-chain contract available — synthetic entries disabled" };
      }
    } else {
    try {
      claudeResult = await validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime, rhUsesOptionsForEntry(cfg) ? candidates : null, effectiveQuality);
      selectedCandidate = candidates.length > 0 ? candidates[claudeResult.contractIdx ?? 0] : null;
      // Stagger expirations: if Claude's pick lands on an over-concentrated expiry, prefer an
      // equally-valid candidate on a less-crowded expiration date.
      if (selectedCandidate && countPositionsAtExpiry(state, selectedCandidate.expiryDate) >= MAX_PER_EXPIRY) {
        const alt = candidates
          .filter(c => countPositionsAtExpiry(state, c.expiryDate) < MAX_PER_EXPIRY)
          .sort((a, b) => Math.abs(a.dte - TARGET_DTE) - Math.abs(b.dte - TARGET_DTE))[0];
        if (alt) {
          log(acct, `DTE STAGGER ${ticker}: ${selectedCandidate.expiryStr} over-concentrated — switching to ${alt.expiryStr} (${alt.dte}d)`);
          selectedCandidate = alt;
        }
      }
      setCachedValidation(acct.id, ticker, analysis.score, direction, claudeResult, selectedCandidate, validationContext);
      log(acct, `CLAUDE VALIDATE ${ticker}: ${claudeResult.approve ? 'APPROVED' : 'REJECTED'} (${claudeResult.confidence}%)${selectedCandidate ? ` → $${selectedCandidate.strike} ${selectedCandidate.expiryStr} (${selectedCandidate.dte}d)` : ''} — ${claudeResult.suggestion}${claudeResult.concerns?.length ? ' | ' + claudeResult.concerns.join(', ') : ''}`);
      logClaudeCall({
        type: "entry_validation",
        ticker,
        acctId: acct.id,
        outcome: claudeResult.approve ? "APPROVED" : "REJECTED",
        confidence: claudeResult.confidence,
        concerns: claudeResult.concerns || [],
        suggestion: claudeResult.suggestion || "",
        setupQuality: effectiveQuality,
        technicalScore: analysis.score,
        price: quote.c,
        direction,
        regime: regime.label,
      });
    } catch (e) {
      // Same fail-closed rule as the parse path: live capital never trades on a skipped check.
      if (cfg.broker === "tradier" || cfg.broker === "robinhood") {
        log(acct, `CLAUDE VALIDATE ${ticker}: Error — ${e.message}. Live account → skipping trade (fail closed).`);
        return { skipped: true, reason: `AI validation errored (${e.message}) — failing closed on a live account` };
      }
      log(acct, `CLAUDE VALIDATE ${ticker}: Error — ${e.message}, proceeding anyway (paper)`);
    }

    if (!claudeResult.approve) {
      return { skipped: true, reason: `Claude rejected: ${claudeResult.suggestion} (${(claudeResult.concerns || []).join(', ')})` };
    }
    } // end non-learning validation path
  }

  // ─── Step 4: Pick an affordable real contract before sizing ───
  const pv = portfolioValue(state, acct.dashboard?.quotes || {});
  const trust = computeTradeTrust({
    claudeConfidence: claudeResult.confidence,
    setupQuality: effectiveQuality,
    technicalScore: analysis.score,
    isBullish,
    cfg,
    regime,
  });
  let deployable, reservePct;
  if (cfg.useCashReserve === false) {
    deployable = state.cash;
    reservePct = 0;
  } else {
    ({ deployable, reservePct } = deployableCash(state, pv, trust));
  }
  const maxSize = cfg.maxTradeSize || 500;
  const maxContractCost = Math.min(maxAllocationBudget, deployable, maxSize);

  let strike = 0, dte = 0, expiryDate = 0, premium = 0, posIv = 0, optionsSource = "robinhood";
  let costPer = 0;
  let unitName = "contract";
  let contractDowngraded = null; // set when an affordability swap moved us off Claude's described pick

  if (cfg.broker === "robinhood" && rhTradeMode(cfg) === "equity") {
    // Robinhood without options: buy shares of the underlying
    costPer = spot;
    type = "equity";
    unitName = "share";
  } else {
    const originalCandidate = selectedCandidate;
    selectedCandidate = chooseAffordableCandidate(candidates, selectedCandidate, maxContractCost, acct);
    if (expectedPackage?.contract) {
      const expected = expectedPackage.contract;
      const sameContract = selectedCandidate
        && selectedCandidate.expiryStr === expected.expiryStr
        && Math.abs(selectedCandidate.strike - expected.strike) < 0.001;
      if (!sameContract) {
        return { skipped: true, reason: `Ranked contract ${expected.expiryStr} $${expected.strike} is no longer the executable package — refusing an unranked substitution` };
      }
    }
    if (selectedCandidate && originalCandidate && selectedCandidate !== originalCandidate) {
      contractDowngraded = {
        from: { strike: originalCandidate.strike, expiryStr: originalCandidate.expiryStr, mid: originalCandidate.mid, delta: originalCandidate.delta ?? null },
        to:   { strike: selectedCandidate.strike, expiryStr: selectedCandidate.expiryStr, mid: selectedCandidate.mid, delta: selectedCandidate.delta ?? null },
        budget: maxContractCost,
      };
      const why = originalCandidate.mid * 100 > maxContractCost
        ? `cost $${(originalCandidate.mid * 100).toFixed(0)} > budget $${maxContractCost.toFixed(0)}`
        : `expiry ${originalCandidate.expiryStr} over-concentrated`;
      log(acct, `AFFORDABLE CONTRACT ${ticker}: Claude pick $${originalCandidate.strike} ${type.toUpperCase()} (${why}) — switching to $${selectedCandidate.strike} ${selectedCandidate.expiryStr} @ $${selectedCandidate.mid} (δ${selectedCandidate.delta != null ? Math.abs(selectedCandidate.delta).toFixed(2) : "?"})`);
    }

    // selectedCandidate already set above (either from cache or fresh Claude response)
    if (selectedCandidate) {
      // Quality gates apply to the contract we will ACTUALLY order — not the one Claude described.
      // When a tight budget forces a downgrade, the substitute is often a cheap far-OTM lottery with
      // a huge %-spread. Reject those so we never buy a contract we can't exit near fair value.
      const chosenDelta = selectedCandidate.delta != null ? Math.abs(selectedCandidate.delta) : null;
      if (!Number.isFinite(chosenDelta) || chosenDelta < MIN_OPTION_DELTA) {
        return { skipped: true, reason: `Contract delta ${Number.isFinite(chosenDelta) ? chosenDelta.toFixed(2) : "missing"} below min ${MIN_OPTION_DELTA} — unmeasurable/lottery risk, not a swing trade${contractDowngraded ? " (only sub-budget junk was affordable)" : ""}` };
      }
      const chosenSpreadPct = selectedCandidate.spreadPct != null ? selectedCandidate.spreadPct / 100 : null;
      if (chosenSpreadPct != null && chosenSpreadPct > MAX_ENTRY_SPREAD_PCT) {
        return { skipped: true, reason: `Contract spread ${(chosenSpreadPct * 100).toFixed(0)}% of mid exceeds ${(MAX_ENTRY_SPREAD_PCT * 100).toFixed(0)}% cap — un-exitable without donating the spread${contractDowngraded ? " (only wide-spread junk fit the budget)" : ""}` };
      }
      // For a quick-bank strategy, the executable ask→bid tax must be small relative to the
      // intended winner. A 25% round-trip spread cannot support a +12% target even if the mark moves.
      const frictionPct = selectedCandidate.roundTripFrictionPct != null
        ? selectedCandidate.roundTripFrictionPct / 100
        : ((selectedCandidate.ask - selectedCandidate.bid) + (2 * FEE_PER_CONTRACT / 100)) / selectedCandidate.ask;
      const maxFrictionPct = Math.min(0.15, Math.max(0.06, 0.5 * (cfg.profitTarget || 0.12)));
      if (!Number.isFinite(frictionPct) || frictionPct > maxFrictionPct) {
        return { skipped: true, reason: `Contract executable friction ${(frictionPct * 100).toFixed(1)}% exceeds ${(maxFrictionPct * 100).toFixed(1)}% cap for a +${((cfg.profitTarget || 0.12) * 100).toFixed(0)}% target — spread would consume the edge` };
      }
      strike = selectedCandidate.strike;
      dte = selectedCandidate.dte;
      expiryDate = selectedCandidate.expiryDate;
      premium = selectedCandidate.mid;
      posIv = selectedCandidate.iv || DEFAULT_IV;
      optionsSource = selectedCandidate.dataSource || "unknown";
      log(acct, `CONTRACT ${ticker}: $${strike} ${type.toUpperCase()} exp ${selectedCandidate.expiryStr} (${dte}d) @ $${premium} mid | IV ${posIv ? (posIv*100).toFixed(0)+'%' : '?'} | OI ${selectedCandidate.oi} | spread $${selectedCandidate.spread}${selectedCandidate.feeDragPct != null ? ` | fee drag ${selectedCandidate.feeDragPct}% RT` : ''}`);
    } else if ((candidates || []).length > 0) {
      // Real near-the-money contracts exist but none fit the budget. We deliberately do NOT reach for
      // a cheaper far-OTM strike — skip and wait for a trade we can actually afford to do right.
      const cheapest = candidates.reduce((a, b) => (b.mid < a.mid ? b : a));
      return { skipped: true, reason: `No quality contract within budget: cheapest near-the-money ${type} is $${(cheapest.mid * 100).toFixed(0)} (δ${cheapest.delta != null ? Math.abs(cheapest.delta).toFixed(2) : "?"}) but only $${maxContractCost.toFixed(0)} is deployable — skipping rather than buying a cheap OTM lottery ticket` };
    } else {
      // Never invent a contract for a portfolio or learning ledger. Historical synthetic puts
      // included strike $0 and could gain value when the stock moved against them, fabricating
      // wins and NAV. No listed, executable contract means no trade.
      return { skipped: true, reason: `${acct.learning ? "Learning variant" : "Account"}: no real listed option chain — synthetic entries disabled` };
    }
    costPer = premium * 100;
  }

  const isRhEquityOnly = cfg.broker === "robinhood" && rhTradeMode(cfg) === "equity";
  // Size live orders from the price we actually plan to submit, not the optimistic midpoint.
  // Otherwise leaning toward the ask can push the real order over its cash/risk/max-size ceiling.
  let expectedEntryPremium = type === "equity" ? spot : premium;
  if ((cfg.broker === "tradier" || cfg.broker === "robinhood") && selectedCandidate && type !== "equity") {
    const conviction = Math.max(0, Math.min(1, (claudeResult.confidence || 0) / 100));
    const maxOverpayPct = Math.min(MAX_ENTRY_OVERPAY_PCT, Math.max(0.03, (cfg.profitTarget || 0.40) * 0.4));
    expectedEntryPremium = entryLimitPrice(selectedCandidate.bid, selectedCandidate.ask, premium, conviction, { maxOverpayPct });
  } else if (isRhEquityOnly) {
    const eqBid = quote.bid ?? null;
    const eqAsk = quote.ask ?? null;
    const eqMid = (eqBid > 0 && eqAsk > 0) ? (eqBid + eqAsk) / 2 : spot;
    expectedEntryPremium = +(Math.min(eqAsk || spot, eqMid * (1 + MAX_ENTRY_OVERPAY_PCT))).toFixed(2);
  }
  const sizingCostPer = expectedEntryPremium * (type === "equity" ? 1 : 100);

  if (sizingCostPer > state.cash && !isRhEquityOnly) return { skipped: true, reason: `No affordable ${unitName}: planned entry costs $${sizingCostPer.toFixed(0)} but spend limit is $${state.cash.toFixed(0)}` };

  if (deployable < sizingCostPer && !isRhEquityOnly) {
    return { skipped: true, reason: `Cash reserve: ${(reservePct * 100).toFixed(0)}% buffer required (trust ${(trust * 100).toFixed(0)}%) — only $${deployable.toFixed(0)} of $${state.cash.toFixed(0)} cash deployable, need $${sizingCostPer.toFixed(0)}/${unitName}` };
  }

  const budget = Math.min(maxAllocationBudget, deployable, maxSize);
  let qty = Math.max(1, Math.floor(budget / sizingCostPer));
  let totalCost = qty * sizingCostPer;

  const governedOptionSizing = !isRhEquityOnly && type !== "equity"
    && (["tradier", "robinhood"].includes(cfg.broker) || Number.isFinite(cfg.riskPerTradePct));
  const optionRiskDecisionFor = (entryPrice, bid, ask) => {
    const spread = bid > 0 && ask >= bid ? ask - bid : 0;
    const dollarCap = cfg.broker === "robinhood"
      ? Math.min(maxSize, RH_MAX_POSITION_DOLLARS)
      : maxSize;
    return sizeLongOptionEntry({
      accountEquity: pv,
      cash: Math.max(0, Math.min(state.cash, deployable)),
      entryPrice,
      stopLossPct: cfg.stopLoss,
      profitTargetPct: Math.min(cfg.profitTarget, cfg.singleContractBankPct ?? cfg.profitTarget),
      minimumRewardRisk: cfg.minimumRewardRisk ?? 1.5,
      riskPerTradePct: cfg.riskPerTradePct ?? 0.005,
      maxPositionPct: cfg.maxPositionPct ?? cfg.baseRiskPct ?? 0.10,
      maxPositionDollars: dollarCap,
      aggregateRiskBudgetDollars: pv * (cfg.maxPortfolioRiskPct ?? 0.02),
      openRiskDollars: estimatedOpenRiskDollars(acct),
      exitFrictionDollarsPerContract: spread * 50,
      entryFeePerContract: FEE_PER_CONTRACT,
      exitFeePerContract: FEE_PER_CONTRACT,
    });
  };
  let optionRiskDecision = null;
  if (governedOptionSizing) {
    optionRiskDecision = optionRiskDecisionFor(expectedEntryPremium, selectedCandidate?.bid, selectedCandidate?.ask);
    if (!optionRiskDecision.approved) {
      return { skipped: true, reason: `Risk governor ${optionRiskDecision.reasonCode}: ${optionRiskDecision.reason}` };
    }
    qty = Math.min(qty, optionRiskDecision.quantity);
    totalCost = qty * sizingCostPer;
  }
  
  if (isRhEquityOnly) {
    // Robinhood supports fractional shares (equity-only mode)
    qty = parseFloat((budget / sizingCostPer).toFixed(4));
    totalCost = qty * sizingCostPer;
  } else {
    if (totalCost > deployable) { qty = Math.floor(deployable / sizingCostPer); totalCost = qty * sizingCostPer; }
  }
  
  if (qty <= 0) return { skipped: true, reason: `Insufficient deployable cash for ${unitName}` };
  if (qty < 1 && !isRhEquityOnly) return { skipped: true, reason: `Insufficient deployable cash for 1 ${unitName}${cfg.useCashReserve === false ? "" : ` (buffer ${(reservePct * 100).toFixed(0)}%)`}` };

  // Circuit Breaker: Max Trade Size
  if (totalCost > maxSize) {
    if (!preflightOnly && (cfg.broker === "tradier" || cfg.broker === "robinhood")) {
      acct.paused = true; // Hard stop for real money
      acct.pausedBy = "risk"; // breaker pause: exits keep managing open positions
      acct._entryEpoch = (acct._entryEpoch || 0) + 1;
      saveAccounts();
      scheduleWorkingEntryCancellation(acct, "circuit-breaker size halt");
      const msg = `🚨 CIRCUIT BREAKER TRIPPED: Trade for ${ticker} costs $${totalCost.toFixed(2)} (exceeds $${maxSize} max). Account is now PAUSED.`;
      log(acct, msg);
      sendPush(`🚨 Circuit Breaker [${acct.name}]`, msg, true).catch(()=>{});
    }
    return { skipped: true, reason: `Trade size $${totalCost.toFixed(2)} exceeds maxTradeSize of $${maxSize}.` };
  }

  // Full AI/decision thought process captured at entry, attached to the trade for the life of the
  // position and into trade history. If the LLM wasn't called (or returned no prose), synthesize a
  // readable thesis from the technical signals so every trade still documents WHY it was opened.
  const topSignals = (analysis.sigs || []).slice(0, 5).map(s => s.text);
  let claudeReasoning = (claudeResult.reasoning || "").trim()
    || `No LLM prose for this entry. Opened on technicals: ${direction} setup, score ${analysis.score}/100, direction-matched setup quality ${effectiveQuality}/100, regime ${regime.label}. Signals: ${topSignals.join("; ") || "n/a"}.`;
  // As-ordered footer so the displayed thesis can never silently describe a different contract than
  // the one we actually traded. If the budget forced a downgrade off Claude's pick, say so plainly.
  const deltaStr = selectedCandidate?.delta != null ? `δ${Math.abs(selectedCandidate.delta).toFixed(2)}` : "δ?";
  if (!(isRhEquityOnly) && selectedCandidate) {
    if (contractDowngraded) {
      claudeReasoning += `\n\n⚠ As ordered (NOT Claude's described contract): $${strike} ${type.toUpperCase()} ${selectedCandidate.expiryStr} (${dte}d, ${deltaStr}) @ ~$${premium} mid. Claude described the $${contractDowngraded.from.strike} strike @ $${contractDowngraded.from.mid}, but it cost $${(contractDowngraded.from.mid * 100).toFixed(0)} vs a $${contractDowngraded.budget.toFixed(0)} budget, so the bot substituted this cheaper contract. Treat the strike/delta reasoning above as approximate.`;
    } else {
      claudeReasoning += `\n\nAs ordered: $${strike} ${type.toUpperCase()} ${selectedCandidate.expiryStr} (${dte}d, ${deltaStr}) @ ~$${premium} mid.`;
    }
  }
  const aiThesis = {
    claudeConfidence: claudeResult.confidence,
    claudeReasoning,
    claudeSuggestion: claudeResult.suggestion || "",
    claudeConcerns: claudeResult.concerns || [],
    setupQuality: effectiveQuality,
    baseSetupQuality: directionalQuality.baseQuality,
    momentumSetupQuality: directionalQuality.momentumQuality,
    setupDirectionMatched: directionalQuality.directionMatched,
    technicalScore: analysis.score,
    direction,
    regimeAtEntry: regime.label,
    topSignals,
    entryAtrPct: analysis.atrPct ?? null,
    contractDowngraded: contractDowngraded || null,
    orderedContract: selectedCandidate ? { strike, type, expiryStr: selectedCandidate.expiryStr, dte, midAtEntry: premium, delta: selectedCandidate.delta ?? null } : null,
  };

  // Serious consideration: Claude approved — mirror to Robinhood watchlist without blocking orders.
  if (!preflightOnly && cfg.broker === "robinhood" && claudeResult.approve) {
    addRhWatchlistCandidate({ ticker, optionType: type, candidate: selectedCandidate, source: "consideration" }).catch(() => {});
  }

  // ─── Broker accounts: place a REAL buy_to_open and let the next sync reconcile state ───
  // Broker is the source of truth, so we do NOT push a synthetic position or mutate cash here.
  if (cfg.broker === "tradier") {
    // Never place a live order on fabricated pricing. Require a real chosen contract with a real
    // two-sided mid; synthetic Black-Scholes pricing (DEFAULT_IV) is for paper simulation only.
    if (optionsSource === "synthetic" || !selectedCandidate || !(premium > 0)) {
      return { skipped: true, reason: `Tradier: no real option market for ${ticker} (source ${optionsSource}) — refusing to trade on synthetic pricing` };
    }
    if (!acct.config.autoExecute && !preflightOnly) {
      return { skipped: true, reason: `Tradier: autoExecute off — entry for ${ticker} not sent (enable on the account)` };
    }
    if (preflightOnly) {
      const occ = tradier.buildOCC(ticker, selectedCandidate.expiryStr, type, strike);
      const fresh = await fetchExactOptionQuote(occ);
      if (!fresh?.twoSided || fresh.tradeable === false) {
        return { skipped: true, reason: `Tradier: ${occ} has no current tradeable two-sided quote — cannot preflight` };
      }
      const frictionPct = ((fresh.ask - fresh.bid) + (2 * FEE_PER_CONTRACT / 100)) / fresh.ask;
      const maxFrictionPct = Math.min(0.15, Math.max(0.06, 0.5 * (cfg.profitTarget || 0.12)));
      if (!Number.isFinite(frictionPct) || frictionPct > maxFrictionPct) {
        return { skipped: true, reason: `Tradier: ${occ} executable friction ${(frictionPct * 100).toFixed(1)}% exceeds ${(maxFrictionPct * 100).toFixed(1)}% — spread consumes the target` };
      }
      const conviction = Math.max(0, Math.min(1, (claudeResult.confidence || 0) / 100));
      const maxOverpayPct = Math.min(MAX_ENTRY_OVERPAY_PCT, Math.max(0.03, (cfg.profitTarget || 0.40) * 0.4));
      const liveLimit = entryLimitPrice(fresh.bid, fresh.ask, fresh.mid, conviction, { maxOverpayPct });
      const freshRiskDecision = governedOptionSizing ? optionRiskDecisionFor(liveLimit, fresh.bid, fresh.ask) : null;
      if (freshRiskDecision && !freshRiskDecision.approved) {
        return { skipped: true, reason: `Tradier refreshed risk ${freshRiskDecision.reasonCode}: ${freshRiskDecision.reason}` };
      }
      if (freshRiskDecision) optionRiskDecision = freshRiskDecision;
      const liveQty = Math.min(qty, freshRiskDecision?.quantity ?? qty, Math.floor(budget / (liveLimit * 100)));
      if (liveQty < 1) return { skipped: true, reason: `Tradier: ${occ} no longer fits $${budget.toFixed(0)} budget` };
      selectedCandidate = {
        ...selectedCandidate,
        bid: fresh.bid,
        ask: fresh.ask,
        mid: fresh.mid,
        spread: +(fresh.ask - fresh.bid).toFixed(2),
        spreadPct: +(((fresh.ask - fresh.bid) / fresh.mid) * 100).toFixed(1),
        roundTripFrictionPct: +(frictionPct * 100).toFixed(1),
      };
      return buildEntryPreflight({
        ticker, type, direction, strike, dte, expiryDate, qty: liveQty,
        entryPremium: liveLimit, cost: liveQty * liveLimit * 100,
        setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence,
        trust, selectedCandidate, optionsSource, maxBudget: budget,
      });
    }
    return await placeBrokerEntry(acct, {
      ticker, type, strike, expiryDate, dte, qty, premium, direction,
      expiryStr: selectedCandidate.expiryStr,
      bid: selectedCandidate.bid, ask: selectedCandidate.ask,
      setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence,
      aiThesis, maxBudget: budget, entryEpoch,
    });
  } else if (cfg.broker === "robinhood") {
    if (!acct.config.autoExecute && !preflightOnly) {
      return { skipped: true, reason: `Robinhood: autoExecute off — entry for ${ticker} not sent (enable on the account)` };
    }

    if (rhUsesOptionsForEntry(cfg) && selectedCandidate) {
      // ─── Robinhood OPTIONS entry ───
      if (optionsSource === "synthetic" || !(premium > 0)) {
        return { skipped: true, reason: `Robinhood: no real option market for ${ticker} (source ${optionsSource}) — refusing to trade on synthetic pricing` };
      }

      const expStr = selectedCandidate.expiryStr || new Date(expiryDate).toISOString().slice(0, 10);
      const occ = robinhood.buildOCC(ticker, expStr, type, strike);

      try {
        const conviction = Math.max(0, Math.min(1, (claudeResult.confidence || 0) / 100));
        const fresh = await fetchExactOptionQuote(occ);
        if (!fresh?.twoSided || fresh.tradeable === false) {
          return { skipped: true, reason: `Robinhood: ${occ} has no current tradeable two-sided quote — ranked package is stale` };
        }
        const bid = fresh.bid, ask = fresh.ask;
        premium = fresh.mid;

        const frictionPct = ((ask - bid) + (2 * FEE_PER_CONTRACT / 100)) / ask;
        const maxFrictionPct = Math.min(0.15, Math.max(0.06, 0.5 * (cfg.profitTarget || 0.12)));
        if (!Number.isFinite(frictionPct) || frictionPct > maxFrictionPct) {
          return { skipped: true, reason: `Robinhood: ${occ} executable friction ${(frictionPct * 100).toFixed(1)}% now exceeds ${(maxFrictionPct * 100).toFixed(1)}% — ranked edge disappeared` };
        }

        selectedCandidate = {
          ...selectedCandidate,
          bid, ask, mid: premium,
          spread: +(ask - bid).toFixed(2),
          spreadPct: +(((ask - bid) / premium) * 100).toFixed(1),
          roundTripFrictionPct: +(frictionPct * 100).toFixed(1),
        };

        const maxOverpayPct = Math.min(MAX_ENTRY_OVERPAY_PCT, Math.max(0.03, (cfg.profitTarget || 0.40) * 0.4));
        const limit = entryLimitPrice(bid, ask, premium, conviction, { maxOverpayPct });
        const freshRiskDecision = governedOptionSizing ? optionRiskDecisionFor(limit, bid, ask) : null;
        if (freshRiskDecision && !freshRiskDecision.approved) {
          return { skipped: true, reason: `Robinhood refreshed risk ${freshRiskDecision.reasonCode}: ${freshRiskDecision.reason}` };
        }
        if (freshRiskDecision) optionRiskDecision = freshRiskDecision;
        qty = Math.min(qty, freshRiskDecision?.quantity ?? qty, Math.floor(budget / (limit * 100)));
        if (qty < 1) {
          return { skipped: true, reason: `Robinhood: refreshed ${occ} limit $${limit.toFixed(2)} no longer fits $${budget.toFixed(0)} budget` };
        }
        const aggrLabel = limit >= (ask || limit) ? "at ask" : limit > premium ? "toward ask" : "at mid";

        if (preflightOnly) {
          return buildEntryPreflight({
            ticker, type, direction, strike, dte, expiryDate, qty,
            entryPremium: limit, cost: qty * limit * 100,
            setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence,
            trust, selectedCandidate, optionsSource, maxBudget: budget,
          });
        }

        // Write meta AFTER limit is computed so entryPremium matches what we actually sent.
        // intendedEntryPremium keeps the mid for UI reference (shown as "intended $X" when fill differs).
        if (!acct.state.meta) acct.state.meta = {};
        acct.state.meta[occ] = {
          entryPremium: +limit.toFixed(2),
          intendedEntryPremium: +premium.toFixed(2),
          entrySpot: spot,
          dte,
          originalQty: qty,
          openDate: getETDateStr(),
          openTime: Date.now(),
          trimLevel: 0,
          bestPnlPct: 0,
          bestExitPnlPct: 0,
          managementPlan: createManagementPlan(cfg, { type, dte }),
          entryAtrPct: analysis.atrPct ?? null,
          setupQuality: effectiveQuality,
          ai: aiThesis || null,
          plannedRiskDollars: optionRiskDecision?.metrics
            ? +(optionRiskDecision.metrics.maxLossPerContract * qty).toFixed(2)
            : null,
          riskGovernor: optionRiskDecision ? {
            version: 1,
            reasonCode: optionRiskDecision.reasonCode,
            rewardRiskRatio: optionRiskDecision.metrics?.rewardRiskRatio ?? null,
            maxLossPerContract: optionRiskDecision.metrics?.maxLossPerContract ?? null,
            tradeRiskBudgetDollars: optionRiskDecision.metrics?.tradeRiskBudgetDollars ?? null,
            aggregateRiskRemainingDollars: optionRiskDecision.metrics?.aggregateRiskRemainingDollars ?? null,
          } : null,
          entryAuthorizationEpoch: entryEpoch,
        };

        const entryRefId = crypto.randomUUID();
        Object.assign(acct.state.meta[occ], {
          entryOrderId: null,
          entryOrderRefId: entryRefId,
          entryOrderPlacedAt: Date.now(),
          entryFirstPlacedAt: Date.now(),
          entryOrderLimit: +limit.toFixed(2),
          entryMaxBudget: budget,
          entryChaseCount: 0,
          entryOrderCtx: { ticker, expStr, strike, optionType: type, qty },
        });
        if (!acct._inflightTickers) acct._inflightTickers = new Set();
        acct._inflightTickers.add(ticker.toUpperCase());
        reserveInflightExpiry(acct, ticker, expiryDate);

        const commitBlock = liveEntryCommitBlock(acct, entryEpoch);
        if (commitBlock) {
          clearEntryOrderTracking(acct.state.meta[occ]);
          acct._inflightTickers.delete(ticker.toUpperCase());
          return { skipped: true, reason: `Robinhood commit blocked: ${commitBlock}` };
        }
        // The intent/ref must survive a process restart before the network request can reach the
        // broker. A failed durable write aborts placement; an in-memory lock is not sufficient.
        saveAccountsStrict();
        const res = await robinhood.placeOptionOrder({
          symbol: ticker,
          expirationDate: expStr,
          strikePrice: strike,
          optionType: type,
          side: "buy_to_open",
          quantity: qty,
          type: "limit",
          limitPrice: limit.toFixed(2),
          refId: entryRefId,
        });

        // Only executions/processed premium are fills. `res.price` is the submitted limit.
        const immediateFill = optionOrderExecutedQuantity(res) > 0 ? optionOrderAverageFillPrice(res) : null;
        if (immediateFill > 0) acct.state.meta[occ].entryPremium = +immediateFill.toFixed(2);

        // Entry-order working context: lets workRobinhoodEntryOrders() re-quote this resting
        // limit each sync and chase toward the ask (within a conviction-scaled ceiling) or
        // cancel and walk away if the price runs — instead of sitting stale all day.
        acct.state.meta[occ].entryOrderId = brokerOrderId(res);
        if (!acct.state.meta[occ].entryOrderId) acct.state.meta[occ].entrySubmissionUnknownAt = Date.now();
        saveAccountsStrict();
        log(acct, `ROBINHOOD OPTION ENTRY: BUY ${qty}x ${occ} @ $${limit.toFixed(2)} (${aggrLabel}; conviction ${(conviction * 100).toFixed(0)}%; bid ${bid ?? "?"}/ask ${ask ?? "?"}/mid ${premium}) — order ${res?.id || JSON.stringify(res).slice(0, 80)}`);

        acct.state.cash = Math.max(0, acct.state.cash - qty * limit * 100);

        diag("entry", acct, {
          ticker, type, strike, dte, qty, occ,
          intendedLimit: +limit.toFixed(2), mid: +(+premium).toFixed(2), bid, ask,
          conviction: Math.round((conviction || 0) * 100), setupQuality: effectiveQuality,
        });

        return { ticker, type, strike, dte, qty, entryPremium: +limit.toFixed(2), intendedEntryPremium: +premium.toFixed(2), cost: qty * limit * 100, direction, optionsSource: "robinhood", setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence, brokerOrder: true, watchlistCandidate: selectedCandidate };
      } catch (e) {
        const entryMeta = acct.state.meta[occ];
        if (e.brokerRejected) {
          delete acct.state.meta[occ];
          acct._inflightTickers?.delete(ticker.toUpperCase());
          log(acct, `ROBINHOOD OPTION ENTRY REJECTED ${ticker}: ${e.message}`);
          return { skipped: true, reason: `Robinhood option entry rejected: ${e.message}`, watchlistCandidate: selectedCandidate, watchlistType: type };
        }
        if (entryMeta) entryMeta.entrySubmissionUnknownAt = Date.now();
        log(acct, `ROBINHOOD OPTION ENTRY STATUS UNKNOWN ${ticker}: ${e.message} — retaining ref/lock; no duplicate order will be sent`);
        return { skipped: true, reason: `Robinhood entry status unknown; quarantined for reconciliation`, watchlistCandidate: selectedCandidate, watchlistType: type };
      }
    } else if (rhUsesEquityForEntry(cfg)) {
      // Equity order reconciliation is intentionally manual-only. Do not fall back from a failed
      // option package to shares: the automated lifecycle below is exact-contract options only.
      return {
        skipped: true,
        reason: `Robinhood equity automation is disabled — ${ticker} shares are manual-only`,
        watchlistCandidate: selectedCandidate,
        watchlistType: type,
      };
    } else {
      return { skipped: true, reason: `Robinhood options-only: no viable ${type} contract for ${ticker}`, watchlistCandidate: selectedCandidate, watchlistType: type };
    }
  }

  // Paper account: BUY fills at the realistic ask (mid+half-spread), not the optimistic mid. Re-clamp
  // qty to what's affordable at that higher fill so paper cash stays honest. (Live broker accounts
  // returned earlier and use real fills.)
  const entryFill = simFillPrice(premium, posMoneyness(type, spot, strike), "buy");
  const entryCostPer = entryFill * 100;
  qty = Math.max(1, Math.min(qty, Math.floor(state.cash / entryCostPer)));
  totalCost = qty * entryCostPer;

  if (preflightOnly) {
    return buildEntryPreflight({
      ticker, type, direction, strike, dte, expiryDate, qty,
      entryPremium: entryFill, cost: totalCost,
      setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence,
      trust, selectedCandidate, optionsSource, maxBudget: budget,
    });
  }

  const position = {
    ticker, type, strike, dte,
    expiryDate,
    dteRemaining: dte,
    entryPremium: entryFill,
    entrySpot: spot,
    _lastSpot: spot,
    qty,
    originalQty: qty,
    cost: totalCost,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,
    bestPnlPct: 0,
    bestExitPnlPct: 0,
    managementPlan: createManagementPlan(cfg, { type, dte }),
    ...aiThesis,
    // Capture ATR% at entry so the spot stop can scale to the underlying's normal noise.
    // Noisy names (AMKR ~5%, NOK ~6%) need a wider stop than calm names (UNH ~2%).
    iv: posIv,
    optionsSource,
  };

  state.cash -= totalCost;
  state.positions.push(position);

  return position;
}

// ─── Sim Entry Logic (skips earnings, EOD, tweets; optional Claude) ───

async function tryEntryForSim(acct, ticker, analysis, quote, regime, useClaude) {
  const state = acct.state;
  const cfg = acct.config;
  if (cfg.allowSyntheticSimulation !== true) {
    return { skipped: true, reason: "Simulation entry disabled: no historical executable option NBBO; synthetic P&L is not valid strategy evidence" };
  }
  if (state.positions.some(p => p.ticker === ticker)) return null;
  // In sim mode, allow trading as long as we have enough for at least 1 contract
  if (state.cash < 10) return null;
  // Limit concurrent positions to avoid overexposure (null = unlimited)
  const maxPos = cfg.maxPositions != null ? cfg.maxPositions : null;
  if (maxPos !== null && state.positions.length >= maxPos) return null;
  if (analysis.score < cfg.bullEntry && analysis.score > cfg.bearEntry) return null;

  const isBullish = analysis.score >= cfg.bullEntry;
  const isBearish = analysis.score <= cfg.bearEntry;

  const candles = acct.candleCache[ticker];
  const sq = detectConsolidation(candles);
  const mq = detectMomentumQuality(candles);
  const simDirectionalQuality = directionalSetupQuality(sq, mq, isBullish);
  const effectiveQuality = simDirectionalQuality.quality;
  const minQuality = cfg.minSetupQuality ?? 50;
  if (effectiveQuality < minQuality) return { skipped: true, reason: `Low setup quality ${effectiveQuality}/100 (base:${sq.quality} mom:${mq.quality})` };

  if (isBullish && analysis.rsi > 85 && !analysis.aligned) return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} parabolic with misaligned EMAs` };
  if (isBearish && analysis.rsi > 30 && analysis.rsi < 55 && !analysis.bearish) return { skipped: true, reason: `Weak put setup` };
  if (isBullish && regime.mode === "risk-off" && !analysis.aligned) return { skipped: true, reason: `Risk-off + misaligned EMAs` };
  const momGateSim = momentumEntryGate(cfg, analysis, acct.dashboard?.shortTermAnalyses?.[ticker] || analysis.shortTerm || null, quote, isBullish);
  if (momGateSim) return { skipped: true, reason: momGateSim };
  const maxRange = (analysis.aligned && isBullish) || (analysis.bearish && isBearish) ? 60 : 15;
  if (parseFloat(sq.rangePct) > maxRange) return { skipped: true, reason: `Range too wide ${sq.rangePct}%` };

  let claudeResult = { approve: true, confidence: 70, concerns: [], reasoning: "", suggestion: "" };
  if (useClaude && CLAUDE_API_KEY) {
    try {
      claudeResult = await validateEntryWithClaude(acct, ticker, quote, analysis, sq, { hasEarnings: false }, regime);
      if (!claudeResult.approve) return { skipped: true, reason: `Claude rejected: ${claudeResult.suggestion}` };
    } catch (e) { /* proceed */ }
  }

  const spot = quote.c;
  const maxRisk = state.cash * acct.riskPct;
  let type, strike;
  if (analysis.score >= cfg.bullEntry) {
    type = "call"; strike = Math.round(spot / 5) * 5 + 5;
  } else if (analysis.score <= cfg.bearEntry) {
    type = "put"; strike = Math.round(spot / 5) * 5 - 5;
  } else { return null; }

  // Pick an expiry from the ticker's cadence near TARGET_DTE, staggered off crowded expirations.
  const simNow = acct._simNow ? new Date(acct._simNow) : null;
  const expiry = nextExpiry(ticker, { targetDTE: TARGET_DTE, refDate: simNow, state });
  const dte = expiry.dte;
  const expiryDate = expiry.date.getTime();

  const premium = optPrice(spot, strike, dte, DEFAULT_IV, type);
  const costPer = premium * 100;
  if (costPer > state.cash) return null;

  // Trust-scaled cash reserve (mirrors live logic so backtests reflect the same capital discipline).
  const isBull = analysis.score >= cfg.bullEntry;
  const pv = portfolioValue(state, acct.dashboard?.quotes || {});
  const trust = computeTradeTrust({
    claudeConfidence: claudeResult.confidence,
    setupQuality: effectiveQuality,
    technicalScore: analysis.score,
    isBullish: isBull,
    cfg,
    regime,
  });
  const { deployable } = deployableCash(state, pv, trust);
  if (deployable < costPer) return { skipped: true, reason: `Cash reserve buffer — only $${deployable.toFixed(0)} deployable` };
  const budget = Math.min(maxRisk, deployable);
  let qty = Math.max(1, Math.floor(budget / costPer));
  let totalCost = qty * costPer;
  if (totalCost > deployable) { qty = Math.floor(deployable / costPer); totalCost = qty * costPer; }
  if (qty < 1) return { skipped: true, reason: `Cash reserve — insufficient deployable cash for 1 contract` };

  // Realistic BUY fill at the ask (mid+half-spread); re-clamp qty to stay within deployable cash.
  const entryFill = simFillPrice(premium, posMoneyness(type, spot, strike), "buy");
  const entryCostPer = entryFill * 100;
  qty = Math.max(1, Math.min(qty, Math.floor(deployable / entryCostPer)));
  totalCost = qty * entryCostPer;

  const position = {
    ticker, type, strike, dte, expiryDate, dteRemaining: dte,
    entryPremium: entryFill, entrySpot: spot, _lastSpot: spot, qty, originalQty: qty,
    cost: totalCost, openDate: acct._simDateStr || getETDateStr(),
    openTime: acct._simNow || Date.now(),
    trimLevel: 0, bestPnlPct: 0, bestExitPnlPct: 0,
    managementPlan: createManagementPlan(cfg, { type, dte }, acct._simNow || Date.now()),
    claudeConfidence: claudeResult.confidence,
    claudeReasoning: (claudeResult.reasoning || "").trim() || `Backtest entry on technicals: ${isBull ? "BULLISH" : "BEARISH"} setup, score ${analysis.score}/100, setup quality ${sq.quality}/100, regime ${regime.label}.`,
    claudeSuggestion: claudeResult.suggestion || "",
    claudeConcerns: claudeResult.concerns || [],
    setupQuality: sq.quality,
    technicalScore: analysis.score,
    direction: isBull ? "BULLISH" : "BEARISH",
    regimeAtEntry: regime.label,
    topSignals: (analysis.sigs || []).slice(0, 5).map(s => s.text),
  };
  state.cash -= totalCost;
  state.positions.push(position);
  return position;
}

// ─── Exit Logic (with trimming support) ───

function clearExitOrderTracking(meta, { keepAttempts = true } = {}) {
  if (!meta) return;
  delete meta.exitOrderId;
  delete meta.exitOrderPlacedAt;
  delete meta.exitOrderLimit;
  delete meta.exitOrderRefId;
  delete meta.exitOrderTicker;
  delete meta.exitPriceMode;
  delete meta.exitReason;
  delete meta.exitIsTrim;
  delete meta.exitRequestedQty;
  delete meta.exitBaselinePositionQty;
  delete meta.exitBookedQty;
  delete meta.exitBookedGross;
  delete meta.exitTrimTargetLevel;
  delete meta.exitSubmissionUnknownAt;
  delete meta.exitStaleAfterMs;
  delete meta.exitCancelFailedAt;
  delete meta.exitCancelRequestedAt;
  delete meta.exitCancelAttemptedAt;
  delete meta.exitRecoveryAttemptAt;
  delete meta.exitRecoveryNoIdLoggedAt;
  delete meta.exitRecoveryErrorLoggedAt;
  delete meta.exitRecoveryContextLoggedAt;
  delete meta.exitReconcileWaitLoggedAt;
  if (!keepAttempts) delete meta.exitAttempts;
}

function brokerOrderId(result) {
  return result?.id || result?.order_id || result?.data?.id || result?.data?.order_id
    || result?.order?.id || result?.order?.order_id
    || result?.results?.[0]?.id || result?.results?.[0]?.order_id
    || result?.data?.results?.[0]?.id || result?.data?.results?.[0]?.order_id
    || null;
}

async function closePosition(acct, pos, currentPremium, reason, qtyToClose, execution = {}) {
  const state = acct.state;
  let qty = qtyToClose || pos.qty;
  const isEquity = pos.type === "equity";
  const multiplier = isEquity ? 1 : 100;
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
  const pnlDollar = (currentPremium - pos.entryPremium) * qty * multiplier;



  // Broker (live) accounts: place a real sell_to_close and let the next sync reconcile.
  // Returns null so the exit loop keeps the position until the fill is confirmed by the broker.
  if (!acct._simMode) {
    if (acct.config.broker === "tradier") {
      return placeBrokerExit(acct, pos, currentPremium, reason, qty, pnlPct, pnlDollar, execution);
    } else if (acct.config.broker === "robinhood") {
      if (isEquity) {
        if (!state.meta[pos.ticker]) state.meta[pos.ticker] = {};
        const equityMeta = state.meta[pos.ticker];
        pos._stopSuppressed = "Robinhood equity automation is manual-only";
        if (!equityMeta.rhEquityManualOnlyNoticeAt) {
          equityMeta.rhEquityManualOnlyNoticeAt = Date.now();
          log(acct, `ROBINHOOD EQUITY EXIT SUPPRESSED ${pos.ticker}: equity automation is manual-only; no broker order was sent`);
        }
        return null;
      }
      if (!acct._inflightTickers) acct._inflightTickers = new Set();
      if (acct._inflightTickers.has(pos.ticker.toUpperCase())) {
        log(acct, `ROBINHOOD: working order already open for ${pos.ticker} — skipping duplicate exit`);
        return null;
      }
      if (!acct.config.autoExecute) {
        log(acct, `ROBINHOOD: autoExecute off — exit for ${pos.ticker} not sent`);
        return null;
      }
      if (!isVerifiedRobinhoodContract(pos)) {
        log(acct, `ROBINHOOD OPTION EXIT BLOCKED: ${pos.ticker} contract identity/expiry is not verified`);
        return null;
      }
      if (!(pos.liveQuoteAt > 0) || Date.now() - pos.liveQuoteAt > RH_OPTION_QUOTE_MAX_AGE_MS) {
        log(acct, `ROBINHOOD OPTION EXIT BLOCKED: ${pos.ticker} exact-contract quote is stale or missing`);
        return null;
      }

      acct._inflightTickers.add(pos.ticker.toUpperCase());

      const isTrimLocal = qty < pos.qty;
      const refId = crypto.randomUUID();

      if (robinhood.optionsEnabled) {
        // Options exit — sell_to_close
        const bid = typeof pos.liveBid === "number" && pos.liveBid > 0 ? pos.liveBid : null;
        const ask = typeof pos.liveAsk === "number" && pos.liveAsk > 0 ? pos.liveAsk : null;
        const mid = (bid != null && ask != null && ask >= bid) ? (bid + ask) / 2
                  : (typeof pos.liveMark === "number" && pos.liveMark > 0 ? pos.liveMark : currentPremium);
        const spreadPct = (bid != null && ask != null && mid > 0) ? (ask - bid) / mid : 0;
        // Any exit that is cutting a loss (or genuinely time-critical) MUST guarantee a fill —
        // price at the bid, which is what a real buyer is actually willing to pay right now.
        // Negotiating off mid in a wide market (the old behavior) could park the limit ABOVE the
        // achievable bid, so the order sits open forever while the position keeps bleeding.
        const guaranteedFill = pnlPct <= 0 || /critical|expir|low-dte|time-decay/i.test(reason);
        const protective = guaranteedFill || /stop|reversed|breakeven|theta/i.test(reason);
        const priceMode = execution.priceMode || (guaranteedFill ? "marketable" : "patient");

        // How many exit attempts on this contract have already gone stale (canceled by the
        // watchdog). Marketable exits cross after the first stale attempt. A protective exit in
        // a wide book instead concedes in bounded steps toward a guarded floor above the raw bid;
        // it must never turn a quarantined book dislocation into the next executable limit.
        const occKey = pos.occSymbol || (pos.expiryDate ? robinhood.buildOCC(pos.ticker, new Date(pos.expiryDate).toISOString().slice(0, 10), pos.type, pos.strike) : null);
        const exitAttempts = (occKey && acct.state.meta[occKey]?.exitAttempts) || 0;

        const pricing = chooseOptionSellLimit({
          bid,
          ask,
          mark: pos.liveMark,
          referencePrice: currentPremium,
          priceMode,
          protective,
          exitAttempts,
          wideSpreadPct: WIDE_SPREAD_EXIT_PCT,
          maxConcessionPct: MAX_EXIT_CONCESSION_PCT,
        });
        if (!(pricing.limit > 0)) {
          acct._inflightTickers.delete(pos.ticker.toUpperCase());
          log(acct, `ROBINHOOD OPTION EXIT BLOCKED: ${pos.ticker} has no executable bid for ${priceMode} exit`);
          return null;
        }
        const spotNow = acct.dashboard?.quotes?.[pos.ticker]?.c ?? pos._lastSpot ?? pos.entrySpot ?? null;
        const liveDelta = Number(pos.liveGreeks?.delta);
        const modeledDelta = (pos.strike > 0 && spotNow > 0 && (pos.type === "call" || pos.type === "put"))
          ? Number(optGreeks(spotNow, pos.strike, pos.dteRemaining ?? pos.dte ?? 21, pos.iv || DEFAULT_IV, pos.type)?.delta)
          : null;
        const sanity = exitLimitSanityCheck({
          limit: pricing.limit,
          bid,
          ask,
          mark: pos.liveMark,
          referencePrice: currentPremium,
          spot: spotNow,
          entrySpot: pos.entrySpot,
          entryPremium: pos.entryPremium,
          delta: Number.isFinite(liveDelta) ? liveDelta : modeledDelta,
          optionType: pos.type,
          atrPct: pos.entryAtrPct,
          reason,
        });
        if (!sanity.ok) {
          acct._inflightTickers.delete(pos.ticker.toUpperCase());
          log(acct, `ROBINHOOD OPTION EXIT BLOCKED: ${pos.ticker} ${sanity.reason} — ${reason}`);
          return null;
        }
        const limit = pricing.limit;

        if (pricing.operatorEscalation && occKey) {
          if (!acct.state.meta[occKey]) acct.state.meta[occKey] = {};
          const escalationMeta = acct.state.meta[occKey];
          const escalationAt = Date.now();
          if (!escalationMeta.exitOperatorEscalatedAt
              || escalationAt - escalationMeta.exitOperatorEscalatedAt >= 15 * 60_000) {
            escalationMeta.exitOperatorEscalatedAt = escalationAt;
            const escalationMessage = `${pos.ticker} ${occKey} protective exit cannot safely concede below $${limit.toFixed(2)} while the exact book remains wide (bid $${bid ?? "?"}/ask $${ask ?? "?"}); manual broker review required`;
            log(acct, `🚨 ROBINHOOD EXIT ESCALATION: ${escalationMessage}`);
            diag("risk_halt", acct, {
              kind: "wide_book_exit_escalation",
              ticker: pos.ticker,
              occ: occKey,
              bid,
              ask,
              guardedLimit: limit,
              attempts: exitAttempts,
            });
            sendPush(`🚨 Protective exit needs review [${acct.name}]`, escalationMessage, true).catch(() => {});
          }
        }

        const expStr = pos.expiryDate ? new Date(pos.expiryDate).toISOString().slice(0, 10) : null;
        if (expStr) {
          if (!acct.state.meta[occKey]) acct.state.meta[occKey] = {};
          const exitMeta = acct.state.meta[occKey];
          const requestedTrimLevel = execution.reasonCode === "TRIM_1" ? 1
            : execution.reasonCode === "TRIM_2" ? 2
              : execution.reasonCode === "EMA8_TRIM" ? 3 : null;
          if (isTrimLocal && requestedTrimLevel != null) {
            if (exitMeta.trimPendingLevel === requestedTrimLevel && exitMeta.trimPendingTargetQty > 0) {
              const remainingTrimQty = Math.max(0, exitMeta.trimPendingTargetQty - (exitMeta.trimPendingFilledQty || 0));
              qty = Math.min(qty, remainingTrimQty);
              if (!(qty > 0)) {
                acct._inflightTickers.delete(pos.ticker.toUpperCase());
                log(acct, `ROBINHOOD OPTION EXIT BLOCKED: ${pos.ticker} trim tier ${requestedTrimLevel} already fully reconciled`);
                return null;
              }
            } else {
              exitMeta.trimPendingLevel = requestedTrimLevel;
              exitMeta.trimPendingTargetQty = qty;
              exitMeta.trimPendingFilledQty = 0;
            }
          }
          // Persist intent before the asynchronous broker call. The sync loop merges this grace-state
          // with Robinhood's working-order snapshot, closing the duplicate-sell race.
          Object.assign(exitMeta, {
            exitOrderId: null,
            exitOrderRefId: refId,
            exitOrderPlacedAt: Date.now(),
            exitOrderLimit: limit,
            exitOrderTicker: pos.ticker.toUpperCase(),
            exitPriceMode: priceMode,
            exitReason: reason,
            exitIsTrim: isTrimLocal,
            exitRequestedQty: qty,
            exitBaselinePositionQty: pos.qty,
            exitBookedQty: 0,
            exitBookedGross: 0,
            exitTrimTargetLevel: requestedTrimLevel,
            exitStaleAfterMs: execution.urgency === "urgent" ? 15_000
              : execution.urgency === "protective" ? 20_000 : 3 * 60_000,
          });
          // Intent/ref must survive a process restart before the network request can reach the broker.
          saveAccountsStrict();
          // Log synchronously, before the async call, so the cycle log always shows what was
          // attempted (and at what price) even if the network call hangs or the process restarts.
          log(acct, `ROBINHOOD OPTION EXIT: attempting SELL ${qty}x ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} @ $${limit} limit (bid=${bid ?? "?"} ask=${ask ?? "?"} mid=${mid != null ? mid.toFixed(2) : "?"} spread=${(spreadPct * 100).toFixed(0)}% mode=${priceMode} attempt=${exitAttempts + 1}) — ${isTrimLocal ? "TRIM" : "EXIT"}: ${reason}`);
          try {
            const res = await robinhood.placeOptionOrder({
              symbol: pos.ticker,
              expirationDate: expStr,
              strikePrice: pos.strike,
              optionType: pos.type,
              side: "sell_to_close",
              quantity: qty,
              type: "limit",
              limitPrice: limit.toFixed(2),
              refId,
              // We already hold the contract's instrument UUID — pass it so the order layer skips the
              // instrument lookup (and works even if strike wasn't resolved from filled orders).
              optionId: pos.instrumentUrl || undefined,
            });
            const occ = occKey || robinhood.buildOCC(pos.ticker, expStr, pos.type, pos.strike);
            log(acct, `ROBINHOOD OPTION EXIT: SELL ${qty}x ${occ} @ $${limit} (${isTrimLocal ? "TRIM" : "EXIT"} — ${reason}) — order ${res?.id || "?"}`);
            exitMeta.exitOrderId = brokerOrderId(res);
            if (!exitMeta.exitOrderId) exitMeta.exitSubmissionUnknownAt = Date.now();
          } catch (e) {
            if (e.brokerRejected) {
              clearExitOrderTracking(exitMeta);
              acct._inflightTickers.delete(pos.ticker.toUpperCase());
              log(acct, `ROBINHOOD OPTION EXIT REJECTED ${pos.ticker}: ${e.message}`);
            } else {
              exitMeta.exitSubmissionUnknownAt = Date.now();
              log(acct, `ROBINHOOD OPTION EXIT STATUS UNKNOWN ${pos.ticker}: ${e.message} — retaining ref ${refId} and duplicate-order lock`);
            }
          }
        } else {
          acct._inflightTickers.delete(pos.ticker.toUpperCase());
          log(acct, `ROBINHOOD OPTION EXIT SKIPPED ${pos.ticker}: no expiry date on position`);
        }
      }
      return null; // keep position until next sync
    }
  }

  // Paper / sim accounts: peg the fill to a realistic SELL price (the bid), not the theoretical mid.
  // The lifecycle manager also evaluates the modeled bid; currentPremium is the mark here solely so
  // simFillPrice applies the spread exactly once. Equities trade at spot (negligible spread).
  const fillPx = isEquity
    ? currentPremium
    : simFillPrice(currentPremium, posMoneyness(pos.type, pos._lastSpot ?? pos.entrySpot, pos.strike), "sell");
  const realPnlPct = (fillPx - pos.entryPremium) / pos.entryPremium;
  const realPnlDollar = (fillPx - pos.entryPremium) * qty * multiplier;

  const proceeds = fillPx * qty * multiplier;
  state.cash += proceeds;
  state.realizedPnl = (state.realizedPnl || 0) + realPnlDollar;
  const trade = { ...pos, qty: qty, closePremium: fillPx, proceeds, pnlDollar: realPnlDollar, pnlPct: realPnlPct, reason, closeDate: getETDateStr(), closeTime: acct._simNow || Date.now() };
  if (!acct._simMode) logTrade(trade);
  recordTradeOutcome(acct, realPnlDollar); // consecutive-loss circuit breaker

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(acct, `${trimLabel}: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${realPnlDollar >= 0 ? "+" : ""}$${realPnlDollar.toFixed(0)} (${realPnlPct >= 0 ? "+" : ""}${(realPnlPct * 100).toFixed(0)}%) — ${reason}`);

  // Push notification — exit alert
  if (!acct._simMode) {
    const isTrim = qty < pos.qty;
    const emoji = realPnlDollar >= 0 ? "✅" : "🛑";
    const label = isTrim ? "TRIM" : (realPnlDollar >= 0 ? "EXIT TP" : "EXIT SL");
    sendPush(
      `${emoji} ${label}: ${pos.ticker} ${pos.type.toUpperCase()} $${pos.strike} [${acct.name}]`,
      `P&L: ${realPnlDollar >= 0 ? "+" : ""}$${realPnlDollar.toFixed(0)} (${realPnlPct >= 0 ? "+" : ""}${(realPnlPct * 100).toFixed(0)}%)\n${reason}`,
      realPnlDollar < 0 // urgent only for stop losses
    ).catch(() => {});
    tweetTradeExit(acct, pos, trade).catch(e => console.log(`  [X] Exit tweet error: ${e.message}`));
  }

  return trade;
}

// ─── Position-management telemetry helpers ───

function recordMarkTrail(pos, mark, now = Date.now(), bid = null, ask = null) {
  if (!(mark > 0)) return;
  if (!pos.markTrail) pos.markTrail = [];
  const last = pos.markTrail[pos.markTrail.length - 1];
  // Coalesce sub-minute duplicates so the trail spans real time, not sync spam.
  if (last && now - last.ts < 45_000) {
    // Preserve when the executable bid was actually sampled. Position/display endpoints may
    // refresh `mark` without a fresh exact-contract NBBO; that must not make an old bid appear new.
    if (last.bid > 0 && !(last.bidSampledAt > 0)) {
      last.bidSampledAt = last.sampledAt || last.ts;
    }
    last.mark = mark;
    if (bid > 0) {
      last.bid = bid;
      last.bidSampledAt = now;
      if (ask > 0 && ask >= bid) {
        last.ask = ask;
        const mid = (bid + ask) / 2;
        const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
        last.bookCoherent = spreadPct <= WIDE_SPREAD_EXIT_PCT;
        last.bookWide = spreadPct > WIDE_SPREAD_EXIT_PCT;
      } else {
        delete last.ask;
        last.bookCoherent = false;
        last.bookWide = false;
      }
    }
    last.sampledAt = now;
  } else {
    const exactBook = bid > 0 && ask > 0 && ask >= bid;
    const mid = exactBook ? (bid + ask) / 2 : 0;
    const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
    pos.markTrail.push({
      ts: now,
      mark,
      ...(bid > 0 ? {
        bid,
        bidSampledAt: now,
        ...(exactBook ? { ask, bookCoherent: spreadPct <= WIDE_SPREAD_EXIT_PCT, bookWide: spreadPct > WIDE_SPREAD_EXIT_PCT } : { bookCoherent: false, bookWide: false }),
      } : {}),
    });
  }
  if (pos.markTrail.length > 240) pos.markTrail.splice(0, pos.markTrail.length - 240);
}

// Broker syncs rebuild positions each cycle — keep peak/trail on meta so soft EOD can see them.
function persistPosTrailMeta(acct, pos) {
  if (!acct?.state) return;
  if (!acct.state.meta) acct.state.meta = {};
  const key = pos.type === "equity" ? pos.ticker : (pos.occSymbol || pos.optionMetaKey);
  if (!key) return;
  if (!acct.state.meta[key]) acct.state.meta[key] = {};
  const m = acct.state.meta[key];
  // Preserve the lifecycle baseline across broker rebuilds and deploys. Reconstructing these from
  // `updated_at` (or `now`) resets held time and can attach a new plan to an old position.
  const baseline = {
    entryPremium: pos.entryPremium,
    intendedEntryPremium: pos.intendedEntryPremium,
    entrySpot: pos.entrySpot,
    openDate: pos.openDate,
    openTime: pos.openTime,
    originalQty: pos.originalQty,
    dte: pos.dte,
    expiryDate: pos.expiryDate,
    entryAtrPct: pos.entryAtrPct,
    setupQuality: pos.setupQuality,
    technicalScore: pos.technicalScore,
    direction: pos.direction,
    plannedRiskDollars: pos.plannedRiskDollars,
    riskGovernor: pos.riskGovernor,
    contractIdentityVerified: pos.contractIdentityVerified,
    instrumentId: normalizeOptionId(pos.instrumentUrl),
    occSymbol: pos.occSymbol,
  };
  for (const [field, value] of Object.entries(baseline)) {
    if (m[field] == null && value != null) m[field] = value;
  }
  if (typeof pos.bestPnlPct === "number") m.bestPnlPct = Math.max(m.bestPnlPct || 0, pos.bestPnlPct);
  if (typeof pos.bestExitPnlPct === "number") m.bestExitPnlPct = Math.max(m.bestExitPnlPct || 0, pos.bestExitPnlPct);
  if (typeof pos.trimLevel === "number") m.trimLevel = pos.trimLevel;
  if (pos.managementPlan) m.managementPlan = pos.managementPlan;
  if (pos.lastManagementDecision) m.lastManagementDecision = pos.lastManagementDecision;
  if (Array.isArray(pos.markTrail) && pos.markTrail.length) m.markTrail = pos.markTrail.slice(-240);
}

function restorePosTrail(pos, meta, prev) {
  const fromMeta = Array.isArray(meta?.markTrail) ? meta.markTrail : null;
  const fromPrev = Array.isArray(prev?.markTrail) ? prev.markTrail : null;
  pos.markTrail = (fromMeta && fromMeta.length ? fromMeta : fromPrev || []).slice(-240);
  pos.bestPnlPct = Math.max(meta?.bestPnlPct ?? 0, prev?.bestPnlPct ?? 0, pos.bestPnlPct || 0);
  pos.bestExitPnlPct = Math.max(meta?.bestExitPnlPct ?? 0, prev?.bestExitPnlPct ?? 0, pos.bestExitPnlPct || 0);
  pos.managementPlan = meta?.managementPlan || prev?.managementPlan || pos.managementPlan || null;
  pos.lastManagementDecision = meta?.lastManagementDecision || prev?.lastManagementDecision || pos.lastManagementDecision || null;
}

function premiumTrailStalling(pos) {
  const trail = pos.markTrail || [];
  if (trail.length < 4) return false;
  const recent = trail.slice(-5).map(t => t.bid ?? t.mark).filter(m => m > 0);
  if (recent.length < 4) return false;
  const peak = Math.max(...recent);
  const first = recent[0];
  const last = recent[recent.length - 1];
  // Peaked in-window and last print is off that peak, with little net progress from the window start.
  const offPeak = peak > 0 && (peak - last) / peak >= 0.015;
  const flatNet = peak > 0 && Math.abs(last - first) / peak <= 0.025;
  const declining = last <= recent[recent.length - 2] && last <= recent[recent.length - 3];
  return offPeak && (flatNet || declining);
}

function premiumNotMakingHighs(pos) {
  const trail = pos.markTrail || [];
  const recent = trail.slice(-4).map(t => t.bid ?? t.mark).filter(m => m > 0);
  if (recent.length < 3) return false;
  const peak = Math.max(...recent);
  const last = recent[recent.length - 1];
  if (!(peak > 0)) return false;
  // Still printing near the window high → not a stall (let it run).
  return (peak - last) / peak >= 0.008 && Math.abs(last - recent[0]) / peak <= 0.03;
}

function positionMoveStalling(pos, shortTerm, analysis) {
  // Premium leveling is the primary signal (Friday SPY case: option stopped making highs near EOD).
  if (premiumTrailStalling(pos)) return true;

  // Underlying/thesis fade only counts when the premium itself has also stopped advancing —
  // don't soft-exit a grinding winner just because 1d mom is flat.
  if (!premiumNotMakingHighs(pos)) return false;

  const mom = shortTerm?.mom1d;
  if (typeof mom === "number") {
    if (pos.type === "call" && mom <= 0.25) return true;
    if (pos.type === "put" && mom >= -0.25) return true;
    if (pos.type === "equity" && mom <= 0.15) return true;
  }
  const score = analysis?.score;
  if (typeof score === "number") {
    if (pos.type === "call" && score < 55) return true;
    if (pos.type === "put" && score > 45) return true;
  }
  return false;
}

// ─── Position Lifecycle Manager ───
// Entry selection ends once a fill exists. From that point forward this adapter gathers broker
// state/signals, asks the pure position-manager for exactly one intent, and only then translates
// that intent into an order. Broker reconciliation remains the sole authority on whether it filled.

function positionEmaSignals(acct, pos) {
  if ((pos.trimLevel || 0) < 2) return { break8: false, break21: false };
  const candles = acct.candleCache[pos.ticker];
  if (!candles || candles.length < 22) return { break8: false, break21: false };
  const closes = candles.map(candle => candle.c);
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const last = closes.length - 1;
  const bullish = pos.type !== "put";
  return {
    break8: bullish ? closes[last] < ema8[last] : closes[last] > ema8[last],
    break21: bullish ? closes[last] < ema21[last] : closes[last] > ema21[last],
  };
}

function recordPositionManagement(acct, pos, decision, now) {
  const state = acct.state;
  if (!state.meta) state.meta = {};
  if (!state.managementJournal) state.managementJournal = [];
  const key = pos.type === "equity" ? pos.ticker : (pos.occSymbol || pos.optionMetaKey);
  if (!key) return false;
  if (!state.meta[key]) state.meta[key] = {};
  const meta = state.meta[key];
  const signature = `${decision.action}:${decision.reasonCode}`;
  const previous = meta.lastManagementDecision;
  const lastJournaledAt = meta.lastManagementJournaledAt || 0;
  const shouldRecord = !previous || previous.signature !== signature || now - lastJournaledAt >= 15 * 60_000;
  const lastDecision = {
    ts: now,
    signature,
    action: decision.action,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    qty: decision.qty,
    executionPrice: decision.executionPrice,
    metrics: decision.metrics,
  };
  pos.lastManagementDecision = lastDecision;
  meta.lastManagementDecision = lastDecision;

  if (shouldRecord) {
    meta.lastManagementJournaledAt = now;
    state.managementJournal.push({
      ts: now,
      accountId: acct.id,
      ticker: pos.ticker,
      occ: pos.occSymbol || null,
      type: pos.type,
      action: decision.action,
      qty: decision.qty,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      executionPrice: decision.executionPrice,
      markPrice: decision.markPrice,
      ...decision.metrics,
    });
    if (state.managementJournal.length > 500) state.managementJournal.splice(0, state.managementJournal.length - 500);
  }
  return shouldRecord;
}

async function manageOpenPositions(acct, quotes, analyses = null, shortTermAnalyses = null) {
  const state = acct.state;
  const cfg = acct.config;
  const now = acct._simNow || Date.now();
  const anMap = analyses || acct.dashboard?.analyses || {};
  const stMap = shortTermAnalyses || acct.dashboard?.shortTermAnalyses || {};
  // A simulation tick represents the daily close, so evaluate the same EOD/EOW locks that live
  // positions see instead of silently disabling time-aware management in backtests.
  const et = acct._simMode ? null : getETDate();
  const etHour = acct._simMode ? 16 : et.getHours() + et.getMinutes() / 60;
  const isFriday = acct._simMode ? new Date(now).getUTCDay() === 5 : et.getDay() === 5;
  const closed = [];
  const remaining = [];
  const evaluations = [];

  for (const pos of state.positions) {
    // A partial buy is already real exposure. Keep managing the held quantity while the entry
    // worker cancels/reconciles its remainder; `_pendingEntry` must never quarantine its stop.
    if (pos._pending || pos._pendingExit || pos._syncMissing) { remaining.push(pos); continue; }
    const quote = quotes[pos.ticker];
    if (!quote) { remaining.push(pos); continue; }

    const isEquity = pos.type === "equity";
    const liveOption = !isEquity && (cfg.broker === "tradier" || cfg.broker === "robinhood");
    const spot = quote.c;
    pos._lastSpot = spot;
    const verifiedRobinhoodOption = cfg.broker !== "robinhood" || isEquity || isVerifiedRobinhoodContract(pos);
    pos.dteRemaining = isEquity ? 0 : (!verifiedRobinhoodOption ? null : (
      pos.expiryDate
        ? Math.max(0, (pos.expiryDate - now) / 86400_000)
        : Math.max(0, (pos.dte || 0) - (now - (pos.openTime || now)) / 86400_000)
    ));

    const currentMark = isEquity
      ? (pos.liveMark ?? spot)
      : (liveOption ? pos.liveMark : (pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type)));
    const modeledPaperBid = !isEquity && !liveOption && currentMark > 0
      ? simFillPrice(currentMark, posMoneyness(pos.type, spot, pos.strike), "sell")
      : null;
    const executableBid = isEquity ? currentMark : (pos.liveBid ?? (liveOption ? null : modeledPaperBid));
    const trailMark = currentMark > 0 ? currentMark : executableBid;
    if (trailMark > 0) recordMarkTrail(pos, trailMark, now, executableBid, pos.liveAsk);

    // A broker holding with no frozen plan predates this lifecycle manager (or was opened manually).
    // Freeze a modest quick-bank policy once; do not let today's account preset silently turn PATH
    // or another legacy one-lot into a +50% runner on its first management tick.
    const canFreezePlan = cfg.broker !== "robinhood" || isEquity || verifiedRobinhoodOption;
    const plan = canFreezePlan && !pos.managementPlan && cfg.broker === "robinhood" && !isEquity
      ? createManagementPlan({
          ...cfg,
          exitMode: "quick_bank",
          profitTarget: Math.min(Number(cfg.profitTarget) || 0.12, 0.12),
          trim1Pct: Math.min(Number(cfg.trim1Pct) || 0.10, 0.10),
          trim2Pct: Math.max(0.18, Number(cfg.trim2Pct) || 0.18),
        }, pos, now)
      : managementPlanFor(pos, cfg, now);
    if (canFreezePlan) pos.managementPlan = plan;
    const analysis = anMap[pos.ticker] || null;
    const shortTerm = stMap[pos.ticker] || null;
    const emaSignals = positionEmaSignals(acct, pos);
    const decision = evaluatePosition({
      position: pos,
      plan,
      market: {
        spot,
        mark: currentMark,
        bid: executableBid,
        ask: pos.liveAsk,
        dteRemaining: pos.dteRemaining,
        requireExecutableBid: liveOption,
        requireVerifiedContract: cfg.broker === "robinhood" && !isEquity,
        contractIdentityVerified: verifiedRobinhoodOption,
        requireFreshQuote: cfg.broker === "robinhood" && !isEquity,
        quoteAsOf: pos.liveQuoteAt || 0,
        maxQuoteAgeMs: RH_OPTION_QUOTE_MAX_AGE_MS,
        underlyingQuoteFresh: quote._underlyingQuoteFresh !== false,
        etHour,
        isFriday,
      },
      signals: {
        score: analysis?.score,
        mom1d: shortTerm?.mom1d,
        stalling: positionMoveStalling(pos, shortTerm, analysis),
        ...emaSignals,
      },
      now,
    });

    if (canFreezePlan) {
      Object.assign(pos, decision.statePatch);
    } else {
      const { managementPlan: _unverifiedPlan, ...safeStatePatch } = decision.statePatch;
      Object.assign(pos, safeStatePatch);
    }
    const recorded = recordPositionManagement(acct, pos, decision, now);
    persistPosTrailMeta(acct, pos);
    evaluations.push({
      ticker: pos.ticker,
      occ: pos.occSymbol || null,
      action: decision.action,
      qty: decision.qty,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      executionPrice: decision.executionPrice,
      markPrice: decision.markPrice,
      metrics: decision.metrics,
      plan: decision.plan,
    });

    if (decision.action === "hold") {
      pos._stopSuppressed = decision.reason;
      remaining.push(pos);
      continue;
    }

    if (recorded) {
      log(acct, `POSITION MANAGER: ${decision.action.toUpperCase()} ${decision.qty}x ${pos.ticker} — ${decision.reason} [bid/exit $${decision.executionPrice.toFixed(2)}, mark $${decision.markPrice.toFixed(2)}, ${decision.metrics.dteRemaining.toFixed(1)}d]`);
    }

    const qtyToClose = decision.action === "trim" ? decision.qty : undefined;
    // Paper closePosition applies the modeled sell spread itself; feed it the mark once so the
    // evaluator and realized fill use the same modeled bid without charging the spread twice.
    const closeReferencePrice = !isEquity && !liveOption ? currentMark : decision.executionPrice;
    const trade = await closePosition(acct, pos, closeReferencePrice, decision.reason, qtyToClose, {
      priceMode: decision.priceMode,
      urgency: decision.urgency,
      reasonCode: decision.reasonCode,
    });

    if (decision.action === "trim") {
      if (trade) {
        closed.push(trade);
        pos.qty -= decision.qty;
        if (decision.reasonCode === "TRIM_1") pos.trimLevel = 1;
        else if (decision.reasonCode === "TRIM_2") pos.trimLevel = 2;
        else if (decision.reasonCode === "EMA8_TRIM") pos.trimLevel = 3;
        persistPosTrailMeta(acct, pos);
      }
      remaining.push(pos);
      continue;
    }

    if (trade) closed.push(trade);
    else remaining.push(pos); // live broker: keep until the fill is confirmed by sync
  }

  state.positions = remaining;
  state.history.push(...closed);
  acct.dashboard.positionManagement = evaluations;
  return closed;
}

// ─── Dashboard State — now per-account in acct.dashboard ───

// ─── Web Dashboard ───

const DASH_PORT = parseInt(process.env.PORT) || 3000;

// Reusable inline-SVG candlestick chart used across the dashboard and detail pages.
// Draws candles + EMA overlays + optional horizontal "barrier" lines (support /
// resistance / entry / TP-SL-equivalent) and an entry marker. Returns an SVG
// string sized to fill its container width. `lines` entries: {value,color,label,dash}.
function svgCandleChart(candles, {
  width = 320, height = 120, emas = [], lines = [], markers = [], padTop = 0.004, padBot = 0.004, full = null,
} = {}) {
  if (!candles || candles.length < 3) {
    return `<div style="color:#8a909b;font-size:11px;padding:20px 0;text-align:center">No chart data yet</div>`;
  }
  const cls = candles.map(c => c.c);
  // EMAs are seeded from full history (when supplied) then sliced to the visible
  // window so long periods (e.g. 50) are accurate even on a short display slice.
  const fullCls = (full && full.length >= candles.length) ? full.map(c => c.c) : cls;
  const emaTail = period => calcEMA(fullCls, period).slice(-cls.length);
  const hs = candles.map(c => c.h), ls = candles.map(c => c.l);
  const W = width, H = height, AXIS = 44;
  const lineVals = lines.map(l => l.value).filter(v => v != null && isFinite(v));
  const mn = Math.min(...ls, ...lineVals) * (1 - padBot);
  const mx = Math.max(...hs, ...lineVals) * (1 + padTop);
  const rng = (mx - mn) || 1;
  const y = v => H - ((v - mn) / rng) * (H - 14) - 7;
  const x = i => (i / Math.max(1, cls.length - 1)) * W;

  const bars = candles.map((c, i) => {
    const green = c.c >= c.o;
    const color = green ? "#00a843" : "#e8473f";
    const bw = Math.max(1.5, W / candles.length - 1.2);
    const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    const bodyH = Math.max(0.8, bot - top);
    return `<line x1="${x(i).toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${color}" stroke-width="0.8" opacity="0.7"/>`
      + `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`;
  }).join("");

  const emaPaths = emas.map(e => {
    const data = emaTail(e.period);
    return `<path d="${data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="${e.color}" stroke-width="1.2" opacity="0.85"/>`;
  }).join("");

  const barrierLines = lines.filter(l => l.value != null && isFinite(l.value)).map(l => {
    const yy = y(l.value).toFixed(1);
    return `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke="${l.color}" stroke-width="1" stroke-dasharray="${l.dash || "4 3"}" opacity="0.8"/>`
      + `<text x="2" y="${(+yy - 2).toFixed(1)}" fill="${l.color}" font-size="8" font-weight="700">${l.label} ${l.value.toFixed(2)}</text>`;
  }).join("");

  const markerDots = markers.filter(m => m.value != null).map(m => {
    const idx = m.index != null ? m.index : cls.length - 1;
    return `<circle cx="${x(idx).toFixed(1)}" cy="${y(m.value).toFixed(1)}" r="2.6" fill="${m.color}" stroke="#fff" stroke-width="1"/>`;
  }).join("");

  const axis = [mx, mn + rng * 0.5, mn].map(p =>
    `<text x="${W + 3}" y="${y(p).toFixed(1)}" fill="#8a909b" font-size="8" dominant-baseline="middle">${p.toFixed(2)}</text>`
  ).join("");

  return `<svg viewBox="0 0 ${W + AXIS} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">
    ${bars}${emaPaths}${barrierLines}${markerDots}${axis}
  </svg>`;
}

// Build a TradingView Lightweight-Charts data payload from a candle window. EMAs are seeded from
// full history (when supplied) so long periods stay accurate on a short visible slice. `time` is a
// daily business-day string so the axis spaces cleanly and never collides. Barrier `lines` become
// price-lines whose labels live on the price axis (no overlap with the candles). The actual drawing
// is done client-side, where the library measures the real container width and renders crisply at
// any size — this is what fixes the "fine on mobile, distorted on desktop" stretching.
function lwcChartData(windowCandles, fullCandles, emaConfigs = [], lines = []) {
  if (!windowCandles || windowCandles.length < 2) return null;
  const day = t => new Date((t || 0) * 1000).toISOString().slice(0, 10);
  const fullCls = (fullCandles && fullCandles.length >= windowCandles.length) ? fullCandles.map(c => c.c) : windowCandles.map(c => c.c);
  const n = windowCandles.length;
  const emaArrs = emaConfigs.map(e => calcEMA(fullCls, e.period).slice(-n));
  const seen = new Set();
  const candles = [], volume = [], emaData = emaConfigs.map(() => []);
  windowCandles.forEach((c, i) => {
    if (c.t == null || c.c == null) return;
    const time = day(c.t);
    if (seen.has(time)) return; // strictly-ascending, unique daily keys (LWC requirement)
    seen.add(time);
    candles.push({ time, open: +c.o, high: +c.h, low: +c.l, close: +c.c });
    volume.push({ time, value: +(c.v || 0), color: c.c >= c.o ? "#00a84355" : "#e8473f55" });
    emaConfigs.forEach((e, k) => { const v = emaArrs[k][i]; if (v != null && isFinite(v)) emaData[k].push({ time, value: +(+v).toFixed(4) }); });
  });
  if (candles.length < 2) return null;
  const emas = emaConfigs.map((e, k) => ({ color: e.color, label: e.label || `EMA ${e.period}`, data: emaData[k] }));
  const priceLines = (lines || []).filter(l => l.value != null && isFinite(l.value))
    .map(l => ({ price: +(+l.value).toFixed(2), color: l.color, title: l.label || "" }));
  return { candles, volume, emas, lines: priceLines };
}

function dashboardHTML(acct, { spectator = false } = {}) {
  const state = acct.state;
  const dashboard = acct.dashboard;
  const cfg = acct.config;
  const STARTING_CASH = cfg.startingCash;
  const GOAL = cfg.goal;
  const PROFIT_TARGET = cfg.profitTarget;
  const STOP_LOSS = cfg.stopLoss;
  const BULL_ENTRY = cfg.bullEntry;
  const BEAR_ENTRY = cfg.bearEntry;
  const RISK_PCT = acct.riskPct;
  const currentRegime = acct.currentRegime;
  const pv = portfolioValue(state, dashboard.quotes);
  const pnlPct = ((pv - STARTING_CASH) / STARTING_CASH * 100).toFixed(1);
  const progress = ((pv / GOAL) * 100).toFixed(1);
  const pace = march1mPace(acct, pv);
  const marchBanner = pace
    ? `<div style="margin:10px 0 14px;padding:10px 12px;border-radius:8px;border:1px solid #99f6e4;background:#ecfdf5;color:#134e4a;font-size:12px;line-height:1.45">
        <b>March $1M track</b> · ${pace.daysLeft} sessions left · need ~<b>${pace.needDailyPct.toFixed(1)}%/day</b>
        · this week target ~$${pace.weekTarget.toFixed(0)}
        · sleeve ${((cfg.baseRiskPct || 0) * 100).toFixed(0)}% · bank +${((cfg.profitTarget || 0) * 100).toFixed(0)}%
      </div>`
    : (cfg.broker === "robinhood"
      ? (cfg.strategyPreset === "capital"
        ? `<div style="margin:10px 0 14px;padding:10px 12px;border-radius:8px;border:1px solid #99f6e4;background:#ecfdf5;color:#134e4a;font-size:12px"><b>Capital-preservation preset</b> · planned loss ≤${((cfg.riskPerTradePct || 0) * 100).toFixed(2)}%/trade · allocation ≤${((cfg.maxPositionPct || 0) * 100).toFixed(0)}% · daily halt ${((cfg.dailyLossLimitPct || 0) * 100).toFixed(1)}% · entries ${cfg.liveEntriesEnabled ? "ON" : "OFF"}</div>`
        : `<div style="margin:10px 0 14px;padding:10px 12px;border-radius:8px;border:1px solid #d4d8e0;background:#f6f7f9;color:#3a3b42;font-size:12px"><b>Live settings</b> · allocation ${((cfg.baseRiskPct || 0) * 100).toFixed(0)}% · reserve ${cfg.useCashReserve ? "ON" : "OFF"} · entries ${cfg.liveEntriesEnabled ? "ON" : "OFF"} · TP +${((cfg.profitTarget || 0) * 100).toFixed(0)}% / SL ${((cfg.stopLoss || 0) * 100).toFixed(0)}%</div>`)
      : "");

  const llmBadge = spectator
    ? `<span class="llm-toggle" title="Read-only in spectator mode">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>`
    : `<span class="llm-toggle" onclick="fetch('/api/llm-provider',{method:'POST'}).then(()=>location.reload())" title="Click to switch LLM provider">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>`;

  // Build position details on-the-fly if no cycle has run yet
  let posSource = dashboard.positionDetails;
  if (posSource.length === 0 && state.positions.length > 0) {
    posSource = state.positions.map(pos => {
      const q = dashboard.quotes[pos.ticker];
      const spot = (q && q.c != null) ? q.c : (pos.entrySpot ?? null);
      const now = Date.now();
      const dteLeft = pos.expiryDate
        ? Math.max(0, (pos.expiryDate - now) / 86400_000)
        : (pos.dte != null && pos.openTime
          ? Math.max(0, pos.dte - (now - pos.openTime) / 86400_000)
          : (pos.dteRemaining ?? null));
      const isEq = pos.type === "equity";
      const strikeKnown = isEq || pos.strike > 0;
      const canModel = strikeKnown && spot != null && dteLeft != null && (pos.type === "call" || pos.type === "put");
      const curPremium = isEq ? (pos.liveMark ?? spot)
        : (pos.liveMark ?? (canModel ? optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type) : pos.entryPremium));
      const pnlPct = pos.entryPremium > 0 && curPremium != null ? (curPremium - pos.entryPremium) / pos.entryPremium : 0;
      const pnlDollar = (curPremium != null && pos.entryPremium > 0)
        ? (curPremium - pos.entryPremium) * pos.qty * (isEq ? 1 : 100) : 0;
      const plan = managementPlanFor(pos, cfg, now);
      const stopMult = plan.stopLoss;
      const profitPrice = pos.entryPremium * (1 + plan.profitTarget);
      const stopPrice = pos.entryPremium * (1 + stopMult);
      return {
        ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
        profitTarget: { pct: `+${(plan.profitTarget * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
        stopLoss: { pct: `${(stopMult * 100).toFixed(0)}%`, premium: stopPrice.toFixed(2) },
        pctToProfit: curPremium > 0 ? ((profitPrice - curPremium) / curPremium * 100).toFixed(1) : "—",
        pctToStop: curPremium > 0 ? ((stopPrice - curPremium) / curPremium * 100).toFixed(1) : "—",
        greeks: canModel ? optGreeks(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type) : { delta: "?", theta: "?" },
      };
    });
  }

  const posRows = posSource.length > 0 ? posSource.map(p => {
    const color = p.pnlPct >= 0 ? "#00a843" : "#e8473f";
    const q = dashboard.quotes[p.ticker];
    const spotChg = q && q.d != null ? q.d : 0;
    const spotChgPct = q && q.dp != null ? q.dp : 0;
    const spotColor = spotChg >= 0 ? "#00a843" : "#e8473f";
    const spotFromEntry = p.spot && p.entrySpot ? ((p.spot - p.entrySpot) / p.entrySpot * 100) : 0;
    const spotFromEntryColor = spotFromEntry >= 0 ? "#00a843" : "#e8473f";
    const rowId = `pos-ai-${p.ticker}-${p.strike}-${p.type}`;
    const sigs = (p.topSignals || []).join(" · ");
    const concerns = (p.claudeConcerns || []).join(" · ");
    const hasAI = !!(p.claudeReasoning || p.claudeSuggestion || sigs || concerns);
    const aiToggle = hasAI ? `<button type="button" class="ai-toggle" onclick="toggleRow('${rowId}')" title="Show AI thinking" style="background:none;border:1px solid #6a4df455;color:#6a4df4;border-radius:3px;padding:1px 6px;font-size:9px;cursor:pointer;margin-left:6px">🧠 AI</button>` : "";
    const manager = p.lastManagementDecision;
    const managerColor = manager?.action === "hold" ? "#138f86" : manager?.action === "trim" ? "#b07400" : "#e8473f";
    const managerBadge = manager ? `<span title="${manager.reason}" style="display:inline-block;margin-left:5px;padding:1px 5px;border:1px solid ${managerColor}55;border-radius:3px;color:${managerColor};font-size:8px;white-space:nowrap">${manager.action.toUpperCase()} · ${manager.reasonCode}</span>` : "";
    const aiRow = hasAI ? `<tr id="${rowId}" style="display:none;background:#6a4df412">
      <td colspan="12" style="padding:10px 12px;font-size:11px;color:#4a4b52;line-height:1.6">
        <div style="color:#6a4df4;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">AI Thought Process at Entry ${p.claudeConfidence ? `(${p.claudeConfidence}% confidence)` : ''}</div>
        <div style="color:#2f3037;margin-bottom:8px">${p.claudeReasoning || p.claudeSuggestion || '<span style="opacity:.5">(no reasoning captured)</span>'}</div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start">
          <div style="flex:1;min-width:240px">
            ${p.claudeSuggestion ? `<div><b style="color:#6a4df4">Takeaway:</b> ${p.claudeSuggestion}</div>` : ''}
            ${concerns ? `<div style="margin-top:6px;color:#b07400"><b>Concerns:</b> ${concerns}</div>` : ''}
          </div>
          <div style="flex:1;min-width:240px">
            <div style="color:#6b7280">Technical score: <span style="color:#1c1d22">${p.technicalScore ?? '?'}/100</span> · Setup quality: <span style="color:#1c1d22">${p.setupQuality ?? '?'}/100</span> · Direction: <span style="color:#1c1d22">${p.direction || (p.type === 'call' ? 'BULLISH' : 'BEARISH')}</span></div>
            <div style="color:#6b7280">Regime: <span style="color:#1c1d22">${p.regimeAtEntry || '?'}</span></div>
            ${sigs ? `<div style="margin-top:6px"><b style="color:#138f86">Signals:</b> ${sigs}</div>` : ''}
          </div>
        </div>
      </td>
    </tr>` : "";
    return `<tr>
      <td><a href="/ticker/${p.ticker}"><b>${p.ticker}</b></a>${managerBadge}${aiToggle}<a href="/media?a=${acct.id}&ticker=${p.ticker}" title="Compose a shareable post for ${p.ticker}" style="margin-left:6px;text-decoration:none;font-size:11px" onclick="event.stopPropagation()">📣</a></td><td>${(p.type || "?").toUpperCase()}</td><td>${p.strike > 0 ? "$" + p.strike : "—"}</td>
      <td style="white-space:nowrap">${p.spot != null ? "$" + Number(p.spot).toFixed(2) : "—"}<br><span style="color:${spotColor};font-size:10px">${spotChg >= 0 ? "+" : ""}${spotChg.toFixed(2)} (${spotChgPct >= 0 ? "+" : ""}${spotChgPct.toFixed(1)}%)</span><br><span style="color:${spotFromEntryColor};font-size:10px">from entry: ${spotFromEntry >= 0 ? "+" : ""}${spotFromEntry.toFixed(1)}%</span></td>
      <td>${p.dteLeft != null ? Number(p.dteLeft).toFixed(1) + "d" : "—"}</td><td>${p.qty}</td>
      <td>$${(+p.entryPremium || 0).toFixed(2)}${(p.intendedEntryPremium && Math.abs(p.intendedEntryPremium - p.entryPremium) >= 0.01) ? `<br><span style="font-size:9px;color:#9aa0aa" title="Bot's intended limit before the actual fill">intended $${(+p.intendedEntryPremium).toFixed(2)}</span>` : ''}</td><td>$${p.curPremium != null ? Number(p.curPremium).toFixed(2) : "—"}</td>
      <td style="color:${color}">${p.pnlPct >= 0 ? "+" : ""}${((p.pnlPct || 0) * 100).toFixed(1)}% ($${(p.pnlDollar || 0).toFixed(0)})</td>
      <td><span style="color:#00a843">TP $${p.profitTarget.premium}</span> (${p.pctToProfit}% away)</td>
      <td><span style="color:#e8473f">SL $${p.stopLoss.premium}</span> (${p.pctToStop}% away)</td>
      <td style="font-size:10px;color:#6b7280">${p.openDate || '—'}</td>
      <td style="font-size:10px;color:#6b7280">δ${p.greeks.delta} θ${p.greeks.theta}<br><span style="color:${p.optionsSource === 'synthetic' ? '#8a909b' : '#138f86'}" title="Source / IV used for pricing">${(p.optionsSource || 'synthetic').toUpperCase()} IV ${((p.iv || 0.30) * 100).toFixed(0)}% ${p.optionsSource === 'synthetic' ? '○' : '●'}</span>${(p.liveMark != null && p.liveBid > 0 && p.liveAsk > 0)
  ? `<br><span title="Live two-sided market — used for marks & fills">b $${(+p.liveBid).toFixed(2)} / a $${(+p.liveAsk).toFixed(2)} · ${(((p.liveAsk - p.liveBid) / ((p.liveAsk + p.liveBid) / 2)) * 100).toFixed(0)}% wide</span>`
  : (p.optionsSource === 'tradier' && !p._pending
    ? `<br><span style="color:#d2691e" title="No live two-sided market, so the bot won't fire exits on a fabricated price. P&L shown uses a Black-Scholes model mark from the live contract IV. A real market returns when the option is open & liquid.">⚠ ${p.markReason || 'no live mark'} · model $${p.displayMark != null ? (+p.displayMark).toFixed(2) : '?'}</span>`
    : '')}</td>
    </tr>${aiRow}`;
  }).join("") : '<tr><td colspan="13" style="opacity:.5">No open positions</td></tr>';

  // ─── Market overview charts (SPY / QQQ) — front and center for at-a-glance regime read ───
  const marketCard = (() => {
    const tiles = ["SPY", "QQQ"].map(sym => {
      const cd = dashboard.candles[sym];
      const q = dashboard.quotes[sym];
      const a = dashboard.analyses[sym];
      if (!cd || cd.length < 5) return `<div style="flex:1;min-width:220px"><div style="font-weight:700">${sym}</div><div style="color:#8a909b;font-size:11px;padding:20px 0;text-align:center">No data yet</div></div>`;
      const recent = cd.slice(-45);
      const dColor = q && q.d >= 0 ? "#00a843" : "#e8473f";
      const chart = svgCandleChart(recent, {
        height: 120,
        full: cd,
        emas: [
          { period: 8, color: "#138f86" },
          { period: 21, color: "#d2691e" },
          { period: 50, color: "#6a4df4" },
        ],
      });
      return `<div style="flex:1;min-width:220px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
          <a href="/ticker/${sym}?a=${acct.id}" style="font-weight:700;font-size:14px">${sym}</a>
          <span style="font-size:12px">${q ? "$" + q.c.toFixed(2) : ""} <span style="color:${dColor};font-size:10px">${q && q.d >= 0 ? "+" : ""}${q?.dp?.toFixed(2) ?? ""}%</span></span>
        </div>
        ${chart}
        <div style="font-size:9px;color:#6b7280;margin-top:2px">${a ? `Score ${a.score} · ${a.aligned ? "8>21>50 ✓" : "stack broken"}` : ""} <span style="color:#138f86">━8</span> <span style="color:#d2691e">━21</span> <span style="color:#6a4df4">━50</span></div>
      </div>`;
    }).join("");
    const rColor = currentRegime.mode === "risk-on" ? "#00a843" : currentRegime.mode === "cautious" ? "#b07400" : currentRegime.mode === "choppy" ? "#d2691e" : "#e8473f";
    return `<div class="card" style="margin-bottom:16px;border-color:${rColor}30">
      <h2 style="display:flex;justify-content:space-between;align-items:center">
        <span>Market — 45-Day Trend</span>
        <span style="color:${rColor};font-size:11px;font-weight:700">${(currentRegime.label || currentRegime.mode || "").toUpperCase()}</span>
      </h2>
      <div style="display:flex;gap:20px;flex-wrap:wrap">${tiles}</div>
    </div>`;
  })();

  // ─── Per-position underlying charts — where price sits vs entry, trend, and key levels ───
  const positionCharts = posSource.length > 0 ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:14px">` + posSource.map(p => {
    const cd = dashboard.candles[p.ticker];
    if (!cd || cd.length < 5) return "";
    const recent = cd.slice(-45);
    const isCall = p.type === "call" || p.type === "equity";
    const rh = Math.max(...recent.slice(-10).map(c => c.h));
    const rl = Math.min(...recent.slice(-10).map(c => c.l));
    const pnlColor = p.pnlPct >= 0 ? "#00a843" : "#e8473f";
    // Barriers: entry stock price + recent swing high/low (the levels price must clear/hold).
    const lines = [
      { value: p.entrySpot, color: "#6b7280", label: "entry", dash: "5 3" },
      { value: rh, color: "#00a84366", label: "R", dash: "2 3" },
      { value: rl, color: "#e8473f66", label: "S", dash: "2 3" },
    ];
    const chart = svgCandleChart(recent, {
      height: 110,
      full: cd,
      emas: [{ period: 8, color: "#138f86" }, { period: 21, color: "#d2691e" }],
      lines,
      markers: [{ value: p.spot, color: pnlColor }],
    });
    const fromEntry = (p.spot != null && p.entrySpot) ? ((p.spot - p.entrySpot) / p.entrySpot * 100) : 0;
    return `<div style="border:1px solid #e7e8ec;border-radius:10px;padding:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <a href="/ticker/${p.ticker}?a=${acct.id}" style="font-weight:700">${p.ticker}</a>
        <span style="font-size:11px;color:#6b7280">${(p.type || "?").toUpperCase()} ${p.strike > 0 ? "$" + p.strike : "?"} · ${p.dteLeft != null ? Number(p.dteLeft).toFixed(0) + "d" : "—"}</span>
      </div>
      ${chart}
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-top:4px">
        <span style="color:#6b7280">Stock <b style="color:#1c1d22">${p.spot != null ? "$" + Number(p.spot).toFixed(2) : "—"}</b> <span style="color:${fromEntry >= 0 ? '#00a843' : '#e8473f'}">${fromEntry >= 0 ? '+' : ''}${fromEntry.toFixed(1)}%</span></span>
        <span style="color:${pnlColor};font-weight:700">${p.pnlPct >= 0 ? '+' : ''}${((p.pnlPct || 0) * 100).toFixed(1)}%</span>
      </div>
      <div style="font-size:9px;color:#8a909b;margin-top:2px">TP $${p.profitTarget.premium} (${p.pctToProfit}%) · SL $${p.stopLoss.premium} (${p.pctToStop}%) · ${isCall ? 'needs price ↑' : 'needs price ↓'}</div>
    </div>`;
  }).join("") + `</div>` : "";

  // Decision reasoning panel
  const decisionRows = dashboard.decisions.map(d => {
    const actionColor = d.action === "BUY CALL" ? "#00a843" : d.action === "BUY PUT" ? "#e8473f" :
      d.action === "HOLD" ? "#138f86" : d.action === "BLOCKED" ? "#b07400" : "#6b7280";
    const hintStr = d.hintBias ? ` <span style="color:#6a4df4">${d.hintBias > 0 ? "+" : ""}${d.hintBias}</span>` : "";
    const stColor = d.shortTermScore != null ? (d.shortTermScore >= 55 ? "#00a843" : d.shortTermScore >= 45 ? "#6b7280" : "#e8473f") : "#8a909b";
    const ltColor = d.longTermScore != null ? (d.longTermScore >= 55 ? "#00a843" : d.longTermScore >= 45 ? "#6b7280" : "#e8473f") : "#8a909b";
    const mc = v => v > 0 ? "#00a843" : v < 0 ? "#e8473f" : "#6b7280";
    return `<tr>
      <td><a href="/ticker/${d.ticker}"><b>${d.ticker}</b></a></td>
      <td>${d.price ? "$" + d.price.toFixed(2) : "—"}</td>
      <td><span style="color:${stColor}">${d.shortTermScore ?? "—"}</span>/<span style="color:${ltColor}">${d.longTermScore ?? "—"}</span>${hintStr} → <b>${d.finalScore ?? "—"}</b></td>
      <td style="color:${actionColor}"><b>${d.action}</b></td>
      <td style="font-size:11px">${d.reason || "—"}</td>
      <td style="font-size:10px;color:#6b7280">${d.ema8 ? `8:${d.ema8} 21:${d.ema21} 50:${d.ema50}` : "—"}</td>
      <td style="font-size:10px;color:#6b7280">${d.stEma3 ? `3:${d.stEma3} 5:${d.stEma5} 8:${d.stEma8}` : "—"}</td>
      <td style="font-size:10px;color:#6b7280">${d.rsi ? `RSI14:${d.rsi} RSI5:${d.stRsi ?? "—"} ATR:${d.atrPct}% VR:${d.vr}` : "—"}</td>
      <td style="font-size:10px">${d.mom1d != null ? `<span style="color:${mc(+d.mom1d)}">1d:${d.mom1d}%</span> <span style="color:${mc(+d.mom3d)}">3d:${d.mom3d}%</span> <span style="color:${mc(+d.mom7d)}">7d:${d.mom7d}%</span>${d.entryPriority != null ? ` <span style="color:#6b7280">prio:${d.entryPriority}</span>` : ""}` : "—"}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="9" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const analysisRows = Object.entries(dashboard.analyses).map(([ticker, a]) => {
    const q = dashboard.quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "—";
    const ahPrice = q && q.dp !== undefined ? `<span style="color:${q.d >= 0 ? '#00a843' : '#e8473f'};font-size:10px">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2) ?? ''} (${q.dp?.toFixed(1) ?? ''}%)</span>` : "";
    const st = dashboard.shortTermAnalyses[ticker];
    const sigColor = a.signal === "STRONG BUY" ? "#00a843" : a.signal === "BUY WATCH" ? "#b07400" : a.signal === "NEUTRAL" ? "#6b7280" : a.signal === "SELL WATCH" ? "#d2691e" : "#e8473f";
    const stColor = st ? (st.score >= 65 ? "#00a843" : st.score >= 55 ? "#b07400" : st.score >= 45 ? "#6b7280" : st.score >= 35 ? "#d2691e" : "#e8473f") : "#8a909b";
    const hintBias = getHintBias(acct, ticker);
    const hintTag = hintBias !== 0 ? ` <span style="color:#6a4df4">[${hintBias > 0 ? "+" : ""}${hintBias}]</span>` : "";
    const momStr = st ? `<span style="color:${st.mom1d >= 0 ? '#00a843' : '#e8473f'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(1)}%</span>` : "—";
    return `<tr><td><a href="/ticker/${ticker}">${ticker}</a></td><td>${price} ${ahPrice}</td>
      <td><b style="color:${sigColor}">${a.score}</b></td>
      <td style="color:${stColor}">${st ? st.score : '—'}</td>
      <td style="color:${sigColor}">${a.signal}${hintTag}</td>
      <td>${a.rsi.toFixed(0)}</td><td>${st ? st.rsi.toFixed(0) : '—'}</td><td>${momStr}</td><td>${a.atrPct.toFixed(1)}%</td><td>${a.vr.toFixed(2)}</td></tr>`;
  }).join("") || '<tr><td colspan="10" style="opacity:.5">Waiting for first cycle...</td></tr>';

  const historyRows = state.history.slice(-20).reverse().map((h, idx) => {
    const color = h.pnlDollar >= 0 ? "#00a843" : "#e8473f";
    const sigs = (h.topSignals || []).join(" · ");
    const concerns = (h.claudeConcerns || []).join(" · ");
    const hasAI = !!(h.claudeReasoning || h.claudeSuggestion || sigs || concerns);
    const rowId = `hist-ai-${idx}-${h.ticker}-${h.strike}`;
    const aiToggle = hasAI ? `<button type="button" class="ai-toggle" onclick="toggleRow('${rowId}')" title="Show AI thinking for this trade" style="background:none;border:1px solid #6a4df455;color:#6a4df4;border-radius:3px;padding:1px 6px;font-size:9px;cursor:pointer;margin-left:4px">🧠</button>` : "";
    const aiRow = hasAI ? `<tr id="${rowId}" style="display:none;background:#6a4df412">
      <td colspan="7" style="padding:10px 12px;font-size:11px;color:#4a4b52;line-height:1.5">
        <div style="color:#6a4df4;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">AI Thought Process at Entry ${h.claudeConfidence ? `(${h.claudeConfidence}% confidence)` : ''} — outcome ${h.pnlDollar >= 0 ? 'WIN' : 'LOSS'}</div>
        <div style="color:#2f3037">${h.claudeReasoning || h.claudeSuggestion || '<span style="opacity:.5">(no reasoning captured)</span>'}</div>
        ${h.claudeReasoning && h.claudeSuggestion ? `<div style="margin-top:4px"><b style="color:#6a4df4">Takeaway:</b> ${h.claudeSuggestion}</div>` : ''}
        ${concerns ? `<div style="margin-top:4px;color:#b07400"><b>Concerns at entry:</b> ${concerns}</div>` : ''}
        ${sigs ? `<div style="margin-top:4px"><b style="color:#138f86">Signals at entry:</b> ${sigs}</div>` : ''}
        <div style="margin-top:4px;color:#6b7280">Setup quality <span style="color:#1c1d22">${h.setupQuality ?? '?'}/100</span> · Tech score <span style="color:#1c1d22">${h.technicalScore ?? '?'}/100</span> · Regime <span style="color:#1c1d22">${h.regimeAtEntry || '?'}</span></div>
      </td>
    </tr>` : "";
    const exitTag = h._pendingFill ? ' <span style="color:#b07400;font-size:9px" title="awaiting actual broker fill">est</span>'
      : (h._fillUnresolved ? ' <span style="color:#b07400;font-size:9px" title="fill could not be confirmed">?</span>'
      : (h._reconciled ? ' <span style="color:#138f86;font-size:9px" title="reconciled to actual broker fill">✓</span>' : ''));
    const feeNote = h.exitFees ? `<br><span style="font-size:9px;color:#9aa0aa">−$${h.exitFees.toFixed(2)} fee</span>` : '';
    return `<tr><td>${h.ticker}${aiToggle}</td><td>${h.type.toUpperCase()}</td><td>$${h.strike}</td>
      <td style="font-size:10px;color:#6b7280;white-space:nowrap">${h.openDate || '—'}<br>→ ${h.closeDate || '—'}</td>
      <td>$${h.entryPremium.toFixed(2)}</td><td>$${(h.closePremium || 0).toFixed(2)}${exitTag}${feeNote}</td>
      <td style="color:${color}">${h.pnlDollar >= 0 ? "+" : ""}$${h.pnlDollar.toFixed(0)} (${(h.pnlPct * 100).toFixed(0)}%)</td>
      <td>${h.reason || "—"}</td></tr>${aiRow}`;
  }).join("") || '<tr><td colspan="8" style="opacity:.5">No trades yet</td></tr>';

  const hints = acct.activeHints.map(h => {
    const mins = Math.round((h.expiresAt - Date.now()) / 60_000);
    return `<span class="hint">${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${h.direction}, ${mins}m watch) — ${h.reasoning}</span>`;
  }).join("") || '<span style="opacity:.5">None active. Write to hint.txt to add.</span>';

  const logLines = dashboard.cycleLog.slice(-200).reverse().map(l =>
    l.replace(/\[(\d+:\d+:\d+)\]/, '<span style="color:#6b7280">[$1]</span>')
      .replace(/(TRADE:|EXIT:|HINT RECEIVED:|CLAUDE SAYS:|ENTRY RANK:|TRADE PACKAGE RANK:|POSITION MANAGER:|Momentum gate)/g, '<b style="color:#6a4df4">$1</b>')

      .replace(/(STRONG BUY)/g, '<span style="color:#00a843">$1</span>')
      .replace(/(AVOID)/g, '<span style="color:#e8473f">$1</span>')
  ).join("<br>");

  const journal = dashboard.decisionJournal || [];
  const rankStats = dashboard.rankTelemetry || summarizeRankOne(journal, "h1");
  const rankStatsHtml = rankStats.n > 0
    ? `<div style="font-size:10px;color:#6b7280;margin-bottom:6px">1h proof · n=${rankStats.n} · rank #1 hit ${(rankStats.hitRate * 100).toFixed(0)}% · lift ${rankStats.meanLift >= 0 ? "+" : ""}${rankStats.meanLift.toFixed(2)}% · regret ${rankStats.meanRegret.toFixed(2)}% <span title="Direction-adjusted underlying return; not option P&L">(signal)</span></div>`
    : '<div style="font-size:10px;color:#6b7280;margin-bottom:6px">1h proof starts after two or more executable packages compete in the same cohort.</div>';
  const journalHtml = journal.length ? journal.slice(-8).reverse().map(j => {
    const when = j.at ? new Date(j.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "?";
    const rows = (j.ranked || []).map(r => {
      const oc = r.outcome === "entered" || r.outcome === "ordered" ? "#00a843" : /blocked|invalid/.test(r.outcome || "") ? "#b07400" : "#6b7280";
      const fwd = r.forward?.h1?.pct ?? r.forward?.currentPct;
      const fwdHtml = fwd != null ? ` <span style="color:${fwd >= 0 ? '#00a843' : '#e8473f'}">${r.forward?.h1 ? '1h' : 'now'} ${fwd >= 0 ? '+' : ''}${fwd.toFixed(2)}%</span>` : "";
      return `<span style="margin-right:10px"><b>${r.rank ? `#${r.rank} ` : ""}${r.ticker}</b> ${r.score}→${r.priority ?? "—"} <span style="color:${oc}">${r.outcome}</span>${fwdHtml}${r.reason ? ` <span style="color:#8a909b;font-size:10px">(${String(r.reason).slice(0, 60)})</span>` : ""}</span>`;
    }).join("");
    return `<div style="margin-bottom:6px;font-size:11px"><span style="color:#6b7280">${when} ET</span> ${rows || "<span style='opacity:.5'>no BUY candidates</span>"}</div>`;
  }).join("") : '<span style="opacity:.5;font-size:11px">No entry ranking history yet — fills after the next cycle with BUY candidates.</span>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Swing Trader Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SwingTrader">
<meta name="theme-color" content="#f6f7f9">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;padding:20px}
  h1{color:#00a843;font-size:20px;margin-bottom:4px}
  .sub{color:#6b7280;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#ffffff;border:1px solid #e7e8ec;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
  .card h2{color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:24px;margin-bottom:8px}
  .stat .val{font-size:22px;font-weight:800;color:#00a843}
  .stat .lbl{font-size:10px;color:#6b7280;text-transform:uppercase}
  .stat.warn .val{color:#b07400}
  .stat.neg .val{color:#e8473f}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;color:#6b7280;font-size:10px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #e3e6ea}
  td{padding:6px 8px;border-bottom:1px solid #eceef1}
  tr:hover{background:#00000008}
  a{color:#138f86;text-decoration:none}a:hover{text-decoration:underline}
  .log{background:#eef1f4;border-radius:6px;padding:12px;max-height:300px;overflow-y:auto;line-height:1.6;font-size:11px}
  .hint{display:inline-block;background:#6a4df420;border:1px solid #6a4df440;border-radius:4px;padding:2px 8px;margin:2px 4px;font-size:11px;color:#6a4df4}
  .progress{background:#e3e6ea;border-radius:4px;height:20px;margin:8px 0;overflow:hidden}
  .progress-bar{height:100%;background:#00a843;border-radius:4px;transition:width .5s}
  .hint-form{margin-top:8px}
  .hint-form input{background:#f6f7f9;border:1px solid #d4d8e0;color:#23242a;padding:8px 12px;border-radius:4px;width:70%;font-family:inherit;font-size:12px}
  .hint-form button{background:#6a4df4;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px}
  .market-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}
  .open{background:#00a84326;color:#00a843}
  .closed{background:#e8473f26;color:#e8473f}
  .flash{animation:flash .4s}
  @keyframes flash{0%{background:#00000014}100%{background:transparent}}
  .tab-bar{background:#f6f7f9;border-bottom:1px solid #e3e6ea;padding:6px 12px 0}
  .tab-row{display:flex;flex-wrap:wrap;gap:4px;align-items:stretch}
  .acct-tab{display:flex;flex-direction:column;align-items:center;padding:8px 16px 6px;background:#ffffff;border:1px solid #e3e6ea;border-bottom:none;border-radius:8px 8px 0 0;color:#6b7280;text-decoration:none;font-size:11px;min-width:100px;transition:all .2s}
  .acct-tab:hover{background:#eef1f4;color:#1c1d22}
  .acct-tab.active{background:#eef1f4;border-color:#d4d8e0;color:#1c1d22;border-bottom:2px solid #00a843}
  .acct-tab.new-tab{border-style:dashed;color:#8a909b;justify-content:center}
  .acct-tab.new-tab:hover{color:#00a843;border-color:#00a843}
  .tab-name{font-weight:700;font-size:12px}
  .tab-pv{font-size:14px;font-weight:700;color:#1c1d22}
  .tab-pnl{font-size:11px}
  .tab-status{font-size:8px}
  .global-stats{display:flex;gap:16px;padding:6px 0;font-size:11px;color:#6b7280}
  .global-stats b{color:#1c1d22}
  .acct-actions{padding:4px 0;display:flex;gap:8px}
  .acct-btn{padding:4px 12px;border:1px solid #d4d8e0;border-radius:4px;background:#ffffff;color:#6b7280;cursor:pointer;font-size:11px}
  .acct-btn:hover{background:#e3e6ea;color:#1c1d22}
  .acct-btn.pause:hover{border-color:#b07400;color:#b07400}
  .acct-btn.resume:hover{border-color:#00a843;color:#00a843}
  .acct-btn.delete:hover{border-color:#e8473f;color:#e8473f}
  .llm-toggle{color:#6a4df4;font-size:10px;cursor:pointer;padding:2px 8px;border:1px solid #6a4df440;border-radius:4px;transition:all .2s}
  .llm-toggle:hover{background:#6a4df420;border-color:#6a4df4;color:#6a4df4}
  body{padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));padding-top:max(20px,env(safe-area-inset-top))}
  /* Wide data tables scroll horizontally inside their card instead of breaking the layout */
  .card{overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:600px){
    body{font-size:13px;padding:10px;padding-left:max(10px,env(safe-area-inset-left));padding-right:max(10px,env(safe-area-inset-right))}
    h1{font-size:17px}
    .sub{font-size:10px;line-height:1.7}
    .card{padding:12px}
    .stat{margin-right:14px}
    .stat .val{font-size:18px}
    table{min-width:560px}
    .global-stats{flex-wrap:wrap;gap:8px 14px}
    .acct-tab{min-width:84px;padding:6px 10px 5px}
    .acct-actions{flex-wrap:wrap}
    /* 16px inputs stop iOS from auto-zooming when a field is focused */
    .hint-form input{width:100%;margin-bottom:8px;font-size:16px}
    .hint-form button{width:100%}
    input,select,textarea{font-size:16px}
  }
</style></head><body>
${tabBarHTML(acct.id, { spectator })}
${accountActionsHTML(acct.id, { spectator })}
${strategyPresetHTML(acct.id, { spectator })}
<h1>${acct.name || "Swing Trader"}</h1>
${spectator ? '<div style="margin:8px 0 12px;padding:8px 12px;border:1px solid #2f6fed40;background:#2f6fed12;color:#2f6fed;border-radius:8px;font-size:12px;font-weight:700">Spectator mode: read-only dashboard. Settings, broker controls, notifications, and AI prompts are disabled.</div>' : ''}
<div class="sub">Capital $${STARTING_CASH.toLocaleString(undefined, { maximumFractionDigits: 0 })} → $${GOAL.toLocaleString()} Goal &nbsp;|&nbsp; <span class="market-badge ${dashboard.marketOpen ? "open" : "closed"}" id="mkt-badge">${dashboard.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span> &nbsp;|&nbsp; <span id="live-indicator" style="color:#00a843">LIVE</span> updates every 5s &nbsp;|&nbsp; <span id="pv-header">$${pv.toFixed(0)}</span> <span id="pnl-header" style="color:${pnlPct >= 0 ? '#00a843' : '#e8473f'}">(${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</span> &nbsp;|&nbsp; <span style="color:${currentRegime.mode === 'risk-on' ? '#00a843' : currentRegime.mode === 'cautious' ? '#b07400' : '#e8473f'};font-size:10px">${currentRegime.mode.toUpperCase()}</span> &nbsp;|&nbsp; <span class="llm-toggle" onclick="fetch('/api/llm-provider',{method:'POST'}).then(()=>location.reload())" title="Click to switch LLM provider">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>${acct.paused ? ' &nbsp;|&nbsp; <span style="color:#e8473f;font-weight:bold">⏸ PAUSED</span>' : ''}</div>

<div class="grid">
  <div class="card">
    <h2>Portfolio</h2>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}" id="pv-card-wrap"><div class="val" id="pv-card">$${pv.toFixed(0)}</div><div class="lbl">Total Value</div></div>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}" id="pnl-card-wrap"><div class="val" id="pnl-card">${pnlPct >= 0 ? "+" : ""}${pnlPct}%</div><div class="lbl">P&L vs capital</div></div>
    <div class="stat"><div class="val" id="capital-card">$${STARTING_CASH.toFixed(0)}</div><div class="lbl">Capital in</div></div>
    <div class="stat"><div class="val" id="cash-card">$${state.cash.toFixed(0)}</div><div class="lbl">${cfg.broker === "tradier" ? ((state.accountType || "") === "cash" ? "Settled Cash" : "Spend Limit") : "Cash"}</div></div>

    ${cfg.broker === "tradier" ? `
    <div class="stat"><div class="val" style="font-size:14px;color:${(state.accountType || "") === "cash" ? "#00a843" : "#b07400"}">${(state.accountType || "?").toUpperCase()}</div><div class="lbl">Account Type</div></div>
    ${state.unsettledCash > 0 ? `<div class="stat"><div class="val" id="unsettled-card" style="font-size:14px;color:#b07400">${state.unsettledCash.toFixed(0)}</div><div class="lbl">Unsettled (T+1)</div></div>` : ""}
    ${state.reservedBuyingPower > 0 ? `<div class="stat"><div class="val" style="font-size:14px;color:#d2691e">$${state.reservedBuyingPower.toFixed(0)}</div><div class="lbl">Reserved (working orders)</div></div>` : ""}
    ${(state.accountType && state.accountType !== "cash") ? `<div style="font-size:11px;color:#b07400;margin-top:6px">⚠️ This is a ${state.accountType.toUpperCase()} account — margin/leverage apply. You wanted a cash account.</div>` : ""}` : ""}
    <div class="progress"><div class="progress-bar" style="width:${Math.min(100, progress)}%"></div></div>
    <div style="font-size:11px;color:#6b7280">${progress}% to $${GOAL.toLocaleString()} goal</div>
    ${marchBanner}
    <div style="font-size:10px;color:#8a909b;margin-top:6px" title="Where price/option data came from this session">
      📡 Data: <span style="color:${tradier.isConnected ? "#138f86" : "#d2691e"}">${tradier.isConnected ? "Tradier LIVE" : "Finnhub/Yahoo (fallback)"}</span>
      · last quote via <b>${(marketDataStats.lastSource || "—").toUpperCase()}</b>
      · usage T:${marketDataStats.tradier} F:${marketDataStats.finnhub} Y:${marketDataStats.yahoo}
      ${cfg.broker === "tradier" ? `· marks: bid/ask mid (synthetic refused)` : ""}
    </div>
  </div>
  <div class="card">
    <h2>AI Assistant &amp; News Intel</h2>
    <div style="margin-bottom:8px;padding:6px 10px;background:#f6f7f9;border-radius:4px;font-size:11px;border-left:3px solid ${(acct.latestNewsBrief || "").includes("CRITICAL") ? "#e8473f" : (acct.latestNewsBrief || "").includes("ELEVATED") ? "#b07400" : "#d4d8e0"}">${acct.latestNewsBrief || '<span style="opacity:.4">News scan runs hourly...</span>'}</div>
    ${hints ? `<div style="margin-bottom:8px">${hints}</div>` : ''}
    ${(() => {
      const history = (acct.chatHistory || []).slice(-10);
      if (!history.length) return '<div style="color:#aab0bb;font-size:11px;margin-bottom:8px">No conversation yet. Ask a question or give a trading directive below.</div>';
      return `<div style="max-height:220px;overflow-y:auto;margin-bottom:10px;padding:8px;background:#f6f7f9;border-radius:6px">` +
        history.map(m => {
          const isUser = m.role === "user";
          const age = Date.now() - m.ts;
          const ageStr = age < 3600000 ? Math.round(age / 60000) + "m ago" : Math.round(age / 3600000) + "h ago";
          return `<div style="margin-bottom:8px">
            <div style="font-size:9px;color:#aab0bb;margin-bottom:2px">${isUser ? 'YOU' : 'CLAUDE'} · ${ageStr}</div>
            <div style="font-size:11px;color:${isUser ? '#6b7280' : '#3a3b42'};line-height:1.5;padding:4px 8px;background:${isUser ? 'transparent' : '#6a4df418'};border-left:2px solid ${isUser ? '#d4d8e0' : '#6a4df4'};border-radius:0 4px 4px 0">${m.content}</div>
          </div>`;
        }).join('') + '</div>';
    })()}
    ${spectator ? `<div style="color:#8a909b;font-size:11px;margin-top:8px">Spectator mode: AI prompts are disabled.</div>` : `<form class="hint-form" method="POST" action="/hint?a=${acct.id}">
      <input name="hint" placeholder='Ask anything: "should I buy NVDA?" or "watch PLTR bullish"' autocomplete="off">
      <button type="submit">Ask AI</button>
    </form>
    <div style="color:#aab0bb;font-size:10px;margin-top:4px">Ask questions or give directives · Watches expire in 4h</div>`}
  </div>
</div>

${marketCard}

<div class="card" style="margin-bottom:16px">
  <h2>Open Positions (${state.positions.length})</h2>
  <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Stock Price</th><th>DTE</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L</th><th>Profit Target</th><th>Stop Loss</th><th>Opened</th><th>Greeks</th></tr>${posRows}</table>
  ${positionCharts}
</div>

${learningPanelHTML(acct, { spectator })}

<div class="card" style="margin-bottom:16px" id="bot-thinking-card">
  <h2 style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:0" onclick="toggleBotThinking()">
    <span>Bot Thinking — Decision Reasoning <span style="color:#aab0bb;font-weight:400;text-transform:none;font-size:10px;letter-spacing:0">(${dashboard.decisions.length} tickers)</span></span>
    <span id="bot-thinking-caret" style="color:#6b7280;font-size:14px;font-weight:400">▾</span>
  </h2>
  <div id="bot-thinking-body" style="margin-top:12px">
    <div style="font-size:10px;color:#8a909b;margin-bottom:8px">Score 50=neutral · ≥${BULL_ENTRY} buy calls · ≤${BEAR_ENTRY} buy puts · Risk: ${(RISK_PCT * 100)}%/trade · TP: +${(PROFIT_TARGET * 100)}% · SL: ${(STOP_LOSS * 100)}% · Entries ranked by score+momentum; flat-tape names blocked under score 80</div>
    <table><tr><th>Ticker</th><th>Price</th><th>Score (7d/90d→blend→final)</th><th>Decision</th><th>Reasoning</th><th>EMAs (8/21/50)</th><th>7d EMAs (3/5/8)</th><th>Indicators</th><th>Momentum / prio</th></tr>${decisionRows}</table>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e8eaef">
      <div style="font-size:10px;color:#8a909b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Entry rank journal (last cycles)</div>
      ${rankStatsHtml}${journalHtml}
    </div>
  </div>
</div>
<script>
function toggleRow(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
function toggleBotThinking() {
  const body = document.getElementById('bot-thinking-body');
  const caret = document.getElementById('bot-thinking-caret');
  if (!body || !caret) return;
  const collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  caret.textContent = collapsed ? '▾' : '▸';
  try { localStorage.setItem('botThinkingCollapsed', collapsed ? '0' : '1'); } catch {}
}
function toggleAnalysis() {
  const body = document.getElementById('analysis-body');
  const caret = document.getElementById('analysis-caret');
  if (!body || !caret) return;
  const collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  caret.textContent = collapsed ? '▾' : '▸';
  try { localStorage.setItem('analysisCollapsed', collapsed ? '0' : '1'); } catch {}
}
// Restore collapsed state — both default to collapsed
(function restoreCollapsibles() {
  try {
    // Bot Thinking: collapsed by default
    const btState = localStorage.getItem('botThinkingCollapsed');
    if (btState !== '0') {
      const body = document.getElementById('bot-thinking-body');
      const caret = document.getElementById('bot-thinking-caret');
      if (body) body.style.display = 'none';
      if (caret) caret.textContent = '▸';
    }
    // Analysis: collapsed by default
    const anState = localStorage.getItem('analysisCollapsed');
    if (anState !== '0') {
      const body = document.getElementById('analysis-body');
      const caret = document.getElementById('analysis-caret');
      if (body) body.style.display = 'none';
      if (caret) caret.textContent = '▸';
    }
  } catch {}
})();
</script>

<div class="grid">
<div class="card" style="margin-bottom:16px" id="analysis-card">
  <h2 style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:0" onclick="toggleAnalysis()">
    <span>Analysis (${Object.keys(dashboard.analyses).length} tickers)</span>
    <span id="analysis-caret" style="color:#6b7280;font-size:14px;font-weight:400">▸</span>
  </h2>
  <div id="analysis-body" style="display:none;margin-top:12px">
    <table><tr><th>Ticker</th><th>Price</th><th>Score</th><th>7d</th><th>Signal</th><th>RSI(14)</th><th>RSI(5)</th><th>1d Mom</th><th>ATR%</th><th>Vol Ratio</th></tr>${analysisRows}</table>
  </div>
</div>
  <div class="card">
    <h2>Trade History (last 20)</h2>
    <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Dates</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>${historyRows}</table>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
    <h2 style="margin:0">Portfolio Value</h2>
    <div id="pv-range" style="display:flex;gap:4px;font-size:10px">
      <button type="button" class="pv-range-btn" data-range="1D">1D</button>
      <button type="button" class="pv-range-btn" data-range="1W">1W</button>
      <button type="button" class="pv-range-btn" data-range="1M">1M</button>
      <button type="button" class="pv-range-btn active" data-range="ALL">ALL</button>
    </div>
  </div>
  <div id="pv-chart-container" style="position:relative">
    <svg id="pv-chart" viewBox="0 0 900 220" preserveAspectRatio="none" style="width:100%;height:220px;display:block;overflow:visible"></svg>
    <div id="pv-readout" style="font-size:11px;color:#6b7280;margin-top:6px;display:flex;justify-content:space-between;gap:12px">
      <span id="pv-readout-time">—</span>
      <span><span id="pv-readout-value" style="color:#1c1d22;font-weight:700">—</span> <span id="pv-readout-pnl" style="color:#6b7280">—</span></span>
    </div>
  </div>
</div>
<style>
  .pv-range-btn{background:#ffffff;border:1px solid #e3e6ea;color:#6b7280;padding:3px 8px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:10px}
  .pv-range-btn:hover{color:#1c1d22;border-color:#d4d8e0}
  .pv-range-btn.active{background:#6a4df420;color:#6a4df4;border-color:#6a4df455}
</style>
<script>
(function() {
  const STARTING_CASH = ${STARTING_CASH};
  let currentRange = 'ALL';
  let cachedHistory = null;
  let cachedAt = 0;

  async function fetchHistory() {
    // Cache for 4s to avoid hammering when range buttons are pressed quickly
    if (cachedHistory && Date.now() - cachedAt < 4000) return cachedHistory;
    try {
      const r = await fetch('/api/portfolio-history?a=${acct.id}');
      const d = await r.json();
      cachedHistory = d;
      cachedAt = Date.now();
      return d;
    } catch { return null; }
  }

  // Filter to the current range; "1D" = today's session only, etc.
  function pointsInRange(hist, range) {
    if (!hist || !hist.length) return [];
    const now = Date.now();
    let cutoff = 0;
    if (range === '1D') cutoff = now - 24 * 3600_000;
    else if (range === '1W') cutoff = now - 7 * 86400_000;
    else if (range === '1M') cutoff = now - 30 * 86400_000;
    if (cutoff === 0) return hist;
    const pts = hist.filter(p => p.ts >= cutoff);
    return pts.length ? pts : hist.slice(-1);
  }

  // ET market hours check — 9:30am to 4:00pm Mon-Fri.
  function isTradingTime(ts) {
    // Convert to ET via locale string trick
    const et = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = et.getHours() * 60 + et.getMinutes();
    return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
  }

  // Group points into ET-session buckets and stitch them along a continuous X axis,
  // collapsing nights/weekends. Each point gets a sessionIndex so the chart skips dead time.
  function compressSessions(points) {
    if (!points.length) return { pts: [], sessions: [], total: 0 };
    const sessions = []; // { etDate: 'YYYY-MM-DD', start: ts, end: ts }
    const enriched = [];
    let curKey = null, curSession = null;
    for (const p of points) {
      const et = new Date(new Date(p.ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const key = et.getFullYear() + '-' + (et.getMonth() + 1) + '-' + et.getDate();
      if (key !== curKey) {
        curKey = key;
        curSession = { key, label: (et.getMonth() + 1) + '/' + et.getDate(), startTs: p.ts, endTs: p.ts };
        sessions.push(curSession);
      } else {
        curSession.endTs = p.ts;
      }
      enriched.push({ ts: p.ts, value: p.value, sessionIdx: sessions.length - 1 });
    }
    // Within each session, give each point a fractional position [0..1] by raw time.
    for (const s of sessions) {
      const span = Math.max(1, s.endTs - s.startTs);
      for (const p of enriched) {
        if (p.sessionIdx === sessions.indexOf(s)) {
          p.frac = (p.ts - s.startTs) / span;
        }
      }
    }
    // X position = sessionIdx + frac, normalized to [0..1] across total sessions.
    const totalSlots = Math.max(1, sessions.length);
    for (const p of enriched) {
      p.x = (p.sessionIdx + p.frac) / totalSlots;
    }
    return { pts: enriched, sessions, total: totalSlots };
  }

  function renderChart(history) {
    const svg = document.getElementById('pv-chart');
    if (!svg) return;
    const all = (history && history.history) || [];
    if (all.length < 2) {
      svg.innerHTML = '<text x="450" y="110" fill="#6b7280" font-size="12" text-anchor="middle">Collecting data — chart appears after 2+ cycles...</text>';
      return;
    }
    const points = pointsInRange(all, currentRange);
    if (points.length < 2) {
      svg.innerHTML = '<text x="450" y="110" fill="#6b7280" font-size="12" text-anchor="middle">No data in this range yet.</text>';
      return;
    }

    const W = 900, H = 220, PAD_L = 56, PAD_R = 16, PAD_T = 12, PAD_B = 30;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const vals = points.map(p => p.value);
    const minV = Math.min(...vals, STARTING_CASH * 0.98);
    const maxV = Math.max(...vals, STARTING_CASH * 1.02);
    const vRange = Math.max(1, maxV - minV);

    const compressed = compressSessions(points);
    const xOf = p => PAD_L + p.x * innerW;
    const yOf = v => PAD_T + innerH - ((v - minV) / vRange) * innerH;

    const lastVal = vals[vals.length - 1];
    const firstVal = vals[0];
    const rangeColor = lastVal >= firstVal ? '#00a843' : '#e8473f';

    const pts = compressed.pts.map(p => xOf(p) + ',' + yOf(p.value).toFixed(1)).join(' ');
    const startY = yOf(STARTING_CASH).toFixed(1);

    // Session tick labels (max ~6 to avoid clutter)
    const tickStride = Math.max(1, Math.ceil(compressed.sessions.length / 6));
    const tickLabels = compressed.sessions.map((s, i) => {
      if (i % tickStride !== 0 && i !== compressed.sessions.length - 1) return '';
      const x = PAD_L + ((i + 0.5) / Math.max(1, compressed.sessions.length)) * innerW;
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" fill="#00000026" font-size="9" text-anchor="middle">' + s.label + '</text>';
    }).join('');

    // Y-axis labels (5 ticks)
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = minV + f * vRange;
      const y = PAD_T + (1 - f) * innerH;
      return '<text x="' + (PAD_L - 6) + '" y="' + (y + 3) + '" fill="#00000026" font-size="9" text-anchor="end">$' + Math.round(v) + '</text>'
           + '<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" stroke="#0000000a" stroke-width="1"/>';
    }).join('');

    const lastX = xOf(compressed.pts[compressed.pts.length - 1]);
    const lastY = yOf(lastVal);

    svg.innerHTML =
      '<defs><linearGradient id="pvgrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + rangeColor + '" stop-opacity="0.25"/>' +
        '<stop offset="100%" stop-color="' + rangeColor + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      yTicks +
      // Starting cash baseline
      '<line x1="' + PAD_L + '" y1="' + startY + '" x2="' + (W - PAD_R) + '" y2="' + startY + '" stroke="#0000001c" stroke-width="1" stroke-dasharray="4,4"/>' +
      '<text x="' + (W - PAD_R - 2) + '" y="' + (Number(startY) - 4) + '" fill="#00000026" font-size="9" text-anchor="end">start $' + STARTING_CASH + '</text>' +
      // Area fill
      '<polygon points="' + pts + ' ' + lastX.toFixed(1) + ',' + (PAD_T + innerH) + ' ' + xOf(compressed.pts[0]).toFixed(1) + ',' + (PAD_T + innerH) + '" fill="url(#pvgrad)"/>' +
      // Line
      '<polyline points="' + pts + '" fill="none" stroke="' + rangeColor + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      // Pulsing current-value dot
      '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="5" fill="' + rangeColor + '" opacity="0.3"><animate attributeName="r" values="5;10;5" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite"/></circle>' +
      '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3.5" fill="' + rangeColor + '"/>' +
      // Session tick labels
      tickLabels +
      // Hover capture (invisible rect with mousemove handler — set up after innerHTML)
      '<rect id="pv-hover" x="' + PAD_L + '" y="' + PAD_T + '" width="' + innerW + '" height="' + innerH + '" fill="transparent"/>' +
      '<line id="pv-cursor" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + innerH) + '" stroke="#00000026" stroke-width="1" style="display:none"/>' +
      '<circle id="pv-cursor-dot" cx="0" cy="0" r="3" fill="#fff" style="display:none"/>';

    // Set baseline readout
    const pnl = lastVal - STARTING_CASH;
    const pnlPct = (pnl / STARTING_CASH * 100);
    const valEl = document.getElementById('pv-readout-value');
    const pnlEl = document.getElementById('pv-readout-pnl');
    const timeEl = document.getElementById('pv-readout-time');
    if (valEl) valEl.textContent = '$' + lastVal.toFixed(0);
    if (pnlEl) { pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0) + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)'; pnlEl.style.color = pnl >= 0 ? '#00a843' : '#e8473f'; }
    if (timeEl) {
      const firstD = new Date(points[0].ts);
      const lastD = new Date(points[points.length - 1].ts);
      timeEl.textContent = firstD.toLocaleDateString() + ' → ' + lastD.toLocaleString();
    }

    // Hover interaction — show value at cursor X position
    const hover = document.getElementById('pv-hover');
    const cursor = document.getElementById('pv-cursor');
    const cursorDot = document.getElementById('pv-cursor-dot');
    if (hover) {
      hover.addEventListener('mousemove', (e) => {
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * W;
        const fracX = (svgX - PAD_L) / innerW;
        if (fracX < 0 || fracX > 1) return;
        // Find nearest point
        let nearest = compressed.pts[0], bestD = Infinity;
        for (const p of compressed.pts) {
          const d = Math.abs(p.x - fracX);
          if (d < bestD) { bestD = d; nearest = p; }
        }
        const cx = xOf(nearest), cy = yOf(nearest.value);
        if (cursor) { cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.style.display = ''; }
        if (cursorDot) { cursorDot.setAttribute('cx', cx); cursorDot.setAttribute('cy', cy); cursorDot.style.display = ''; }
        const np = nearest.value - STARTING_CASH;
        const npp = (np / STARTING_CASH * 100);
        if (valEl) valEl.textContent = '$' + nearest.value.toFixed(0);
        if (pnlEl) { pnlEl.textContent = (np >= 0 ? '+' : '') + '$' + np.toFixed(0) + ' (' + (npp >= 0 ? '+' : '') + npp.toFixed(1) + '%)'; pnlEl.style.color = np >= 0 ? '#00a843' : '#e8473f'; }
        if (timeEl) timeEl.textContent = new Date(nearest.ts).toLocaleString();
      });
      hover.addEventListener('mouseleave', () => {
        if (cursor) cursor.style.display = 'none';
        if (cursorDot) cursorDot.style.display = 'none';
        if (valEl) valEl.textContent = '$' + lastVal.toFixed(0);
        if (pnlEl) { pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0) + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)'; pnlEl.style.color = pnl >= 0 ? '#00a843' : '#e8473f'; }
        if (timeEl) timeEl.textContent = new Date(points[points.length - 1].ts).toLocaleString();
      });
    }
  }

  async function refresh() {
    const data = await fetchHistory();
    if (data) renderChart(data);
  }

  document.querySelectorAll('.pv-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pv-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      cachedHistory = null; // force re-fetch on next refresh
      refresh();
    });
  });

  // Initial paint + poll every 10s for live updates
  refresh();
  setInterval(refresh, 10_000);
})();
</script>

<div class="card" style="margin-top:16px">
  <h2>Live Log</h2>
  <div class="log" id="live-log">${logLines || '<span style="opacity:.5">Waiting for first cycle...</span>'}</div>
</div>

<script>
let prevPrices = {};
async function pollLive() {
  try {
    const r = await fetch('/api/live?a=${acct.id}');
    const d = await r.json();
    // Update header
    const pvEl = document.getElementById('pv-header');
    const pnlEl = document.getElementById('pnl-header');
    if (pvEl) {
      pvEl.textContent = '$' + d.pv.toFixed(0);
      const capital = (typeof d.startingCash === 'number' && d.startingCash > 0) ? d.startingCash : ${STARTING_CASH};
      const pnl = ((d.pv - capital) / capital * 100).toFixed(1);
      pnlEl.textContent = '(' + (pnl >= 0 ? '+' : '') + pnl + '%)';
      pnlEl.style.color = pnl >= 0 ? '#00a843' : '#e8473f';
      const pvCard = document.getElementById('pv-card');
      const pnlCard = document.getElementById('pnl-card');
      const pvWrap = document.getElementById('pv-card-wrap');
      const pnlWrap = document.getElementById('pnl-card-wrap');
      const cashCard = document.getElementById('cash-card');
      const capitalCard = document.getElementById('capital-card');
      if (pvCard) pvCard.textContent = '$' + d.pv.toFixed(0);
      if (pnlCard) pnlCard.textContent = (pnl >= 0 ? '+' : '') + pnl + '%';
      if (cashCard && typeof d.cash === 'number') cashCard.textContent = '$' + d.cash.toFixed(0);
      if (capitalCard) capitalCard.textContent = '$' + capital.toFixed(0);
      if (pvWrap) pvWrap.className = 'stat ' + (pnl >= 0 ? '' : 'neg');
      if (pnlWrap) pnlWrap.className = 'stat ' + (pnl >= 0 ? '' : 'neg');
    }
    // Pulse indicator
    const ind = document.getElementById('live-indicator');
    if (ind) { ind.style.opacity = '1'; setTimeout(() => ind.style.opacity = '.4', 200); }
  } catch(e) {}
}
setInterval(pollLive, 5000);
pollLive();
</script>
<script>
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
// Per-device push state. The server keeps a list of endpoints but each browser/device
// drives its own subscribe/unsubscribe via this button — independent of other devices.
function setPushBtnState(state) {
  const btn = document.getElementById('push-btn');
  if (!btn) return;
  btn.disabled = false;
  if (state === 'on') {
    btn.textContent = '🔔 On';
    btn.style.borderColor = '#00a843';
    btn.style.color = '#00a843';
    btn.title = 'Click to disable notifications on this device';
  } else if (state === 'busy') {
    btn.textContent = '🔔 …';
    btn.disabled = true;
  } else if (state === 'unsupported') {
    btn.textContent = '🔔 N/A';
    btn.disabled = true;
    btn.style.color = '#8a909b';
  } else {
    btn.textContent = '🔔 Notify';
    btn.style.borderColor = '#d4d8e0';
    btn.style.color = '#6b7280';
    btn.title = 'Click to enable notifications on this device';
  }
}

async function getDeviceSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications are not supported in this browser.');
    return;
  }
  setPushBtnState('busy');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notification permission denied.'); setPushBtnState('off'); return; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const keyRes = await fetch('/api/push/vapid-key');
    const { publicKey } = await keyRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
    setPushBtnState('on');
    console.log('[Push] Enabled on this device');
  } catch(e) {
    console.error('[Push] Enable error:', e);
    setPushBtnState('off');
    alert('Push enable failed: ' + e.message);
  }
}

async function disablePush() {
  setPushBtnState('busy');
  try {
    const sub = await getDeviceSubscription();
    if (sub) {
      // Tell the server first so we never get push events after unsubscribing locally
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => {});
      try { await sub.unsubscribe(); } catch {}
    }
    setPushBtnState('off');
    console.log('[Push] Disabled on this device');
  } catch(e) {
    console.error('[Push] Disable error:', e);
    setPushBtnState('off');
  }
}

async function togglePush() {
  const sub = await getDeviceSubscription();
  if (sub) {
    // Verify with the server: if the server already forgot this endpoint we still want to clear locally
    await disablePush();
  } else {
    await enablePush();
  }
}

// Determine initial state on page load. The button is per-device — only flips to "On"
// when THIS device has a live subscription that the server also recognizes.
(async function initPushButton() {
  if (${spectator ? "true" : "false"}) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushBtnState('unsupported');
    return;
  }
  try {
    const sub = await getDeviceSubscription();
    if (!sub) { setPushBtnState('off'); return; }
    const r = await fetch('/api/push/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint })
    });
    const { subscribed } = await r.json();
    if (subscribed) {
      setPushBtnState('on');
    } else {
      // Server forgot us (e.g. file wiped on redeploy) — drop the orphan local subscription
      try { await sub.unsubscribe(); } catch {}
      setPushBtnState('off');
    }
  } catch {
    setPushBtnState('off');
  }
})();
</script>

</body></html>`;
}

function tickerDetailHTML(sym, acct, { spectator = false } = {}) {
  const state = acct.state;
  const dashboard = acct.dashboard;
  const candles = dashboard.candles[sym];
  const a = dashboard.analyses[sym];
  const q = dashboard.quotes[sym];
  const dec = dashboard.decisions.find(d => d.ticker === sym);
  const pos = dashboard.positionDetails.find(p => p.ticker === sym);
  const hintBias = getHintBias(acct, sym);
  const hint = acct.activeHints.find(h => h.ticker === sym);

  const st = dashboard.shortTermAnalyses[sym];
  const recentClaudeLogs = loadClaudeLog()
    .filter(e => e.ticker === sym && e.acctId === acct.id)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);
  const onDemandAnalysis = dashboard.onDemandAnalyses?.[sym] || null;

  // 90-day chart with EMA 8/21/50 (rendered client-side by TradingView Lightweight Charts).
  const longChartData = lwcChartData(candles, candles, [
    { period: 8, color: "#138f86", label: "EMA 8" },
    { period: 21, color: "#d2691e", label: "EMA 21" },
    { period: 50, color: "#6a4df4", label: "EMA 50" },
  ]);

  // 7-day chart (last 14 candles) with EMA 3/5/8 — EMAs seeded from full history for accuracy.
  const shortCandles = candles ? candles.slice(-14) : null;
  const shortChartData = lwcChartData(shortCandles, candles, [
    { period: 3, color: "#0a8fb8", label: "EMA 3" },
    { period: 5, color: "#b07400", label: "EMA 5" },
    { period: 8, color: "#d6336c", label: "EMA 8" },
  ]);

  // ─── Entry/Exit Barriers card: where price sits, where it's trending, and the
  // levels (score thresholds + price S/R + ATR targets) that gate an entry or exit ───
  let barrierChartData = null; // populated by the IIFE below; consumed by the client chart payload
  const barriersBlock = (() => {
    const cfg = acct.config;
    const bull = cfg.bullEntry ?? 68;
    const bear = cfg.bearEntry ?? 32;
    const minQ = cfg.minSetupQuality ?? 50;
    const score = a ? a.score : null;
    const stScore = st ? st.score : null;

    // Score gauge: current blended score against the bull/bear entry barriers.
    let gauge = "";
    if (score != null) {
      const pct = v => Math.max(0, Math.min(100, v));
      const markerColor = score >= bull ? "#00a843" : score <= bear ? "#e8473f" : "#6b7280";
      const zone = score >= bull ? "CALL ZONE (entry armed)" : score <= bear ? "PUT ZONE (entry armed)" : `WAIT — need ≥${bull} for calls or ≤${bear} for puts`;
      const gap = score >= bull || score <= bear ? 0 : Math.min(bull - score, score - bear);
      gauge = `
        <div style="margin-bottom:6px;font-size:11px;color:#6b7280">Blended score <b style="color:${markerColor};font-size:14px">${score}</b> ${stScore != null ? `<span style="color:#aab0bb">(7d ${stScore})</span>` : ""} — <span style="color:${markerColor}">${zone}</span>${gap ? ` <span style="color:#aab0bb">· ${gap} pts away</span>` : ""}</div>
        <div style="position:relative;height:22px;background:linear-gradient(90deg,#e8473f22 0%,#e8473f22 ${bear}%,#6b728018 ${bear}%,#6b728018 ${bull}%,#00a84322 ${bull}%,#00a84322 100%);border-radius:5px;border:1px solid #e3e6ea">
          <div style="position:absolute;left:${bear}%;top:0;bottom:0;border-left:2px dashed #e8473f"></div>
          <div style="position:absolute;left:${bull}%;top:0;bottom:0;border-left:2px dashed #00a843"></div>
          <div style="position:absolute;left:calc(${pct(score)}% - 6px);top:-3px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:9px solid ${markerColor}"></div>
          <div style="position:absolute;left:calc(${pct(score)}% - 1px);top:0;bottom:0;border-left:2px solid ${markerColor}"></div>
        </div>
        <div style="position:relative;font-size:8px;color:#8a909b;height:12px;margin-top:1px">
          <span style="position:absolute;left:0">0</span>
          <span style="position:absolute;left:calc(${bear}% - 14px);color:#e8473f">put ≤${bear}</span>
          <span style="position:absolute;left:calc(${bull}% - 8px);color:#00a843">call ≥${bull}</span>
          <span style="position:absolute;right:0">100</span>
        </div>`;
    }

    // Setup-quality barrier (the second gate after score).
    const cons = candles ? detectConsolidation(candles) : null;
    const mom = candles ? detectMomentumQuality(candles) : null;
    const effQ = cons && mom ? Math.max(cons.quality, mom.quality) : (a?.setupQuality ?? null);
    const qBar = effQ != null ? `
      <div style="margin-top:12px;font-size:11px;color:#6b7280">Setup quality <b style="color:${effQ >= minQ ? '#00a843' : '#b07400'}">${effQ}/100</b> (need ≥${minQ} to pass) — base ${cons?.quality ?? '?'} / momentum ${mom?.quality ?? '?'}</div>
      <div style="height:8px;background:#eef0f3;border-radius:4px;margin-top:4px;overflow:hidden"><div style="height:100%;width:${Math.min(100, effQ)}%;background:${effQ >= minQ ? '#00a843' : '#b07400'}"></div><div style="position:relative;left:${minQ}%;top:-8px;height:8px;border-left:2px dashed #6b7280"></div></div>` : "";

    // Price-level barriers on a candlestick: 7d high (R), 7d low (S), 50 EMA,
    // ATR stop/targets, and — if held — entry + DTE marker.
    const recent = candles ? candles.slice(-45) : null;
    const lines = [];
    if (a?.t1) lines.push({ value: +a.t1, color: "#00a843", label: "T1", dash: "4 3" });
    if (a?.t2) lines.push({ value: +a.t2, color: "#00a84399", label: "T2", dash: "4 3" });
    if (a?.stop) lines.push({ value: +a.stop, color: "#e8473f", label: "ATR stop", dash: "4 3" });
    if (st?.recentHigh) lines.push({ value: st.recentHigh, color: "#00a84366", label: "7d hi", dash: "2 3" });
    if (st?.recentLow) lines.push({ value: st.recentLow, color: "#e8473f66", label: "7d lo", dash: "2 3" });
    if (pos?.entrySpot) lines.push({ value: pos.entrySpot, color: "#6a4df4", label: "entry", dash: "5 3" });
    // Current price as a barrier line too, so it reads on the price axis alongside the levels.
    if (q?.c != null) lines.push({ value: +q.c, color: score == null ? "#6b7280" : score >= bull ? "#00a843" : score <= bear ? "#e8473f" : "#6b7280", label: "now" });
    barrierChartData = recent ? lwcChartData(recent, candles, [
      { period: 8, color: "#138f86", label: "EMA 8" }, { period: 21, color: "#d2691e", label: "EMA 21" }, { period: 50, color: "#6a4df4", label: "EMA 50" },
    ], lines) : null;
    const barrierChart = barrierChartData
      ? `<div id="chart-barrier" class="lwc" style="height:240px"></div>`
      : '<div style="color:#8a909b">No chart data</div>';

    const trend = st ? `
      <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;font-size:11px">
        <span>Trend: <b style="color:${st.mom1d >= 0 ? '#00a843' : '#e8473f'}">1d ${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(1)}%</b></span>
        <span><b style="color:${st.mom3d >= 0 ? '#00a843' : '#e8473f'}">3d ${st.mom3d >= 0 ? '+' : ''}${st.mom3d.toFixed(1)}%</b></span>
        <span><b style="color:${st.mom7d >= 0 ? '#00a843' : '#e8473f'}">7d ${st.mom7d >= 0 ? '+' : ''}${st.mom7d.toFixed(1)}%</b></span>
        <span style="color:#6b7280">EMA stack: <b style="color:${a?.aligned ? '#00a843' : a?.bearish ? '#e8473f' : '#b07400'}">${a?.aligned ? 'bullish 8>21>50' : a?.bearish ? 'bearish 50>21>8' : 'mixed/transitioning'}</b></span>
      </div>` : "";

    return `${gauge}${qBar}${trend}
      <div style="margin-top:12px">${barrierChart}</div>
      <div style="font-size:9px;color:#8a909b;margin-top:4px">
        <span style="color:#138f86">━8</span> <span style="color:#d2691e">━21</span> <span style="color:#6a4df4">━50 EMA</span> ·
        <span style="color:#00a843">T1/T2 targets</span> · <span style="color:#e8473f">ATR stop</span> · 7d hi/lo S/R${pos ? ' · <span style="color:#6a4df4">entry</span>' : ''}
      </div>`;
  })();

  // Position info block
  let posBlock = '<div style="color:#8a909b">No position in this ticker</div>';
  if (pos) {
    const color = pos.pnlPct >= 0 ? "#00a843" : "#e8473f";
    const posSpotChg = q && q.d != null ? q.d : 0;
    const posSpotChgPct = q && q.dp != null ? q.dp : 0;
    const posSpotColor = posSpotChg >= 0 ? "#00a843" : "#e8473f";
    const posSpotFromEntry = pos.spot && pos.entrySpot ? ((pos.spot - pos.entrySpot) / pos.entrySpot * 100) : 0;
    const posSpotEntryColor = posSpotFromEntry >= 0 ? "#00a843" : "#e8473f";
    posBlock = `
      <div class="stat"><div class="val">${(pos.type || "?").toUpperCase()}</div><div class="lbl">Type</div></div>
      <div class="stat"><div class="val">${pos.strike > 0 ? "$" + pos.strike : "—"}</div><div class="lbl">Strike</div></div>
      <div class="stat"><div class="val">${pos.qty}</div><div class="lbl">Contracts</div></div>
      <div class="stat"><div class="val">${pos.dteLeft != null ? Number(pos.dteLeft).toFixed(1) + "d" : "—"}</div><div class="lbl">DTE Left</div></div>
      <hr style="border-color:#e3e6ea;margin:12px 0">
      <div class="stat"><div class="val">${pos.spot != null ? "$" + Number(pos.spot).toFixed(2) : "—"}</div><div class="lbl">Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotColor}">${posSpotChg >= 0 ? "+" : ""}${posSpotChg.toFixed(2)} (${posSpotChgPct >= 0 ? "+" : ""}${posSpotChgPct.toFixed(1)}%)</div><div class="lbl">Today's Move</div></div>
      <div class="stat"><div class="val">${pos.entrySpot != null ? "$" + Number(pos.entrySpot).toFixed(2) : "—"}</div><div class="lbl">Entry Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotEntryColor}">${posSpotFromEntry >= 0 ? "+" : ""}${posSpotFromEntry.toFixed(1)}%</div><div class="lbl">Stock Since Entry</div></div>
      <hr style="border-color:#e3e6ea;margin:12px 0">
      <div class="stat"><div class="val">$${pos.entryPremium.toFixed(2)}</div><div class="lbl">Entry Premium</div></div>
      <div class="stat"><div class="val">$${pos.curPremium.toFixed(2)}</div><div class="lbl">Current Premium</div></div>
      <div class="stat ${pos.pnlPct >= 0 ? '' : 'neg'}"><div class="val" style="color:${color}">${(pos.pnlPct * 100).toFixed(1)}% ($${pos.pnlDollar.toFixed(0)})</div><div class="lbl">P&L</div></div>
      <hr style="border-color:#e3e6ea;margin:12px 0">
      <div class="stat"><div class="val" style="color:#00a843">$${pos.profitTarget.premium}</div><div class="lbl">TP (${pos.profitTarget.pct})</div></div>
      <div class="stat"><div class="val" style="color:#e8473f">$${pos.stopLoss.premium}</div><div class="lbl">SL (${pos.stopLoss.pct})</div></div>
      <div class="stat"><div class="val">${pos.pctToProfit}%</div><div class="lbl">To Profit</div></div>
      <div class="stat"><div class="val">${pos.pctToStop}%</div><div class="lbl">To Stop</div></div>
      <hr style="border-color:#e3e6ea;margin:12px 0">
      <div class="stat"><div class="val">${pos.greeks.delta}</div><div class="lbl">Delta</div></div>
      <div class="stat"><div class="val">${pos.greeks.theta}</div><div class="lbl">Theta/day</div></div>
      `;
  }

  // Decision block
  let decBlock = '';
  if (dec) {
    const actionColor = dec.action === "BUY CALL" ? "#00a843" : dec.action === "BUY PUT" ? "#e8473f" :
      dec.action === "HOLD" ? "#138f86" : dec.action === "BLOCKED" ? "#b07400" : "#6b7280";
    decBlock = `
      <div class="stat"><div class="val">${dec.rawScore ?? '—'}</div><div class="lbl">Raw Score</div></div>
      <div class="stat"><div class="val">${dec.finalScore ?? '—'}</div><div class="lbl">Final Score</div></div>
      <div class="stat"><div class="val" style="color:${actionColor}">${dec.action}</div><div class="lbl">Decision</div></div>
      <div style="margin:8px 0;color:#6b7280;font-size:12px">${dec.reason}</div>
      <div style="margin-top:8px">${(dec.signals || []).map(s => '<div style="color:#6b7280;font-size:11px;padding:2px 0">• ' + s + '</div>').join('')}</div>`;
  }

  // Analysis stats
  let statsBlock = '<div style="color:#8a909b">No analysis data</div>';
  if (a) {
    const sigColor = a.signal === "STRONG BUY" ? "#00a843" : a.signal === "BUY WATCH" ? "#b07400" : a.signal === "NEUTRAL" ? "#6b7280" : a.signal === "SELL WATCH" ? "#d2691e" : "#e8473f";
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
    : '<span style="color:#8a909b">No active hint for this ticker</span>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${sym} — Swing Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#f6f7f9">
<meta http-equiv="refresh" content="30">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;padding:20px}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:600px){body{padding:12px}input,select,textarea,button{font-size:16px}}
  h1{color:#00a843;font-size:20px;margin-bottom:4px}
  a{color:#138f86;text-decoration:none}a:hover{text-decoration:underline}
  .sub{color:#6b7280;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:#ffffff;border:1px solid #e7e8ec;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(16,24,40,.04)}
  .card h2{color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:20px;margin-bottom:8px}
  .stat .val{font-size:16px;font-weight:800;color:#00a843}
  .stat .lbl{font-size:10px;color:#6b7280;text-transform:uppercase}
  .stat.neg .val{color:#e8473f}
  .hint{display:inline-block;background:#6a4df420;border:1px solid #6a4df440;border-radius:4px;padding:4px 10px;font-size:11px;color:#6a4df4}
  .lwc{width:100%;position:relative}
</style></head><body>
<h1><a href="/">← Back</a> &nbsp; ${sym} ${q ? '$' + q.c.toFixed(2) : ''}
${q ? `<span style="font-size:13px;color:${q.d >= 0 ? '#00a843' : '#e8473f'}">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2)} (${q.dp?.toFixed(2)}%)</span>` : ''}</h1>
<div class="sub">${pos ? pos.type.toUpperCase() + ' $' + pos.strike + ' | ' + pos.qty + ' contracts' : 'Not currently held'} &nbsp;|&nbsp; <a href="/media?a=${acct.id}&ticker=${sym}" style="color:#6a4df4;font-weight:700;text-decoration:none">📣 Share this setup</a> &nbsp;|&nbsp; Auto-refreshes every 30s
${q?.t ? ` &nbsp;|&nbsp; Last: ${new Date(q.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ''}</div>

<div class="card" style="margin-bottom:16px;border-color:#0a8fb840">
  <h2 style="color:#0a8fb8">7-Day Chart (Contract Window) — Fast EMAs 3/5/8</h2>
  ${shortChartData ? '<div id="chart-short" class="lwc" style="height:240px"></div>' : '<div style="color:#8a909b">No chart data</div>'}
  <div style="font-size:9px;color:#8a909b;margin-top:4px"><span style="color:#0a8fb8">━ EMA 3</span> &nbsp; <span style="color:#b07400">━ EMA 5</span> &nbsp; <span style="color:#d6336c">━ EMA 8</span></div>
  ${st ? `<div style="margin-top:12px;display:flex;gap:20px;flex-wrap:wrap">
    <div class="stat"><div class="val" style="color:${st.score >= 55 ? '#00a843' : st.score >= 45 ? '#6b7280' : '#e8473f'}">${st.score}</div><div class="lbl">7d Score</div></div>
    <div class="stat"><div class="val" style="color:${st.signal.includes('BUY') ? '#00a843' : st.signal.includes('SELL') ? '#e8473f' : '#6b7280'}">${st.signal}</div><div class="lbl">7d Signal</div></div>
    <div class="stat"><div class="val" style="color:${st.mom1d >= 0 ? '#00a843' : '#e8473f'}">${st.mom1d >= 0 ? '+' : ''}${st.mom1d.toFixed(2)}%</div><div class="lbl">1d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom3d >= 0 ? '#00a843' : '#e8473f'}">${st.mom3d >= 0 ? '+' : ''}${st.mom3d.toFixed(2)}%</div><div class="lbl">3d Momentum</div></div>
    <div class="stat"><div class="val" style="color:${st.mom7d >= 0 ? '#00a843' : '#e8473f'}">${st.mom7d >= 0 ? '+' : ''}${st.mom7d.toFixed(2)}%</div><div class="lbl">7d Momentum</div></div>
    <div class="stat"><div class="val">${st.rsi.toFixed(0)}</div><div class="lbl">RSI (5)</div></div>
    <div class="stat"><div class="val">${st.range7d.toFixed(1)}%</div><div class="lbl">7d Range</div></div>
    <div class="stat"><div class="val">$${st.recentHigh.toFixed(2)}</div><div class="lbl">7d High${st.nearHigh ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">$${st.recentLow.toFixed(2)}</div><div class="lbl">7d Low${st.nearLow ? ' (NEAR)' : ''}</div></div>
    <div class="stat"><div class="val">${st.vr.toFixed(2)}</div><div class="lbl">Vol Ratio</div></div>
  </div>
  <div style="margin-top:8px">${st.sigs.map(s => '<span style="color:' + (s.t === 'bull' ? '#00a843' : '#e8473f') + ';font-size:11px;margin-right:12px">• ' + s.text + '</span>').join('')}</div>` : ''}
</div>

<div class="card" style="margin-bottom:16px;border-color:#6a4df440">
  <h2 style="color:#6a4df4">Entry / Exit Barriers — where it is, where it's trending, what gates a trade</h2>
  ${barriersBlock}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>90-Day Chart — EMAs 8/21/50</h2>
  ${longChartData ? '<div id="chart-long" class="lwc" style="height:300px"></div>' : '<div style="color:#8a909b">No chart data</div>'}
  <div style="font-size:9px;color:#8a909b;margin-top:4px"><span style="color:#138f86">━ EMA 8</span> &nbsp; <span style="color:#d2691e">━ EMA 21</span> &nbsp; <span style="color:#6a4df4">━ EMA 50</span></div>
</div>

<div class="grid">
  <div class="card">
    <h2>90-Day Analysis & Indicators</h2>
    ${statsBlock}
  </div>
  <div class="card">
    <h2>Bot Decision (Blended 60% 7d / 40% 90d)</h2>
    ${decBlock || '<div style="color:#8a909b">No decision data yet</div>'}
    <hr style="border-color:#e3e6ea;margin:12px 0">
    <h2 style="margin-top:8px">News/Hint Bias</h2>
    ${hintBlock}
    <hr style="border-color:#e3e6ea;margin:12px 0">
    <h2 style="margin-top:8px">AI Validation History (3d)</h2>
    ${recentClaudeLogs.length === 0 ? '<div style="color:#8a909b;font-size:11px">No AI validations in last 3 days</div>' :
      recentClaudeLogs.map(e => {
        const approved = e.outcome === "APPROVED";
        const color = approved ? "#00a843" : "#e8473f";
        const age = Date.now() - e.ts;
        const ageStr = age < 3600000 ? Math.round(age / 60000) + "m ago"
          : age < 86400000 ? Math.round(age / 3600000) + "h ago"
          : Math.round(age / 86400000) + "d ago";
        const ts = new Date(e.ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
        return `<div style="border:1px solid ${color}22;border-radius:6px;padding:8px 10px;margin-bottom:8px;background:${color}08">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="color:${color};font-weight:bold;font-size:12px">${e.outcome}</span>
            <span style="color:#8a909b;font-size:10px" title="${ts}">${ageStr}</span>
          </div>
          <div style="color:#3a3b42;font-size:11px;margin-bottom:3px">${e.suggestion || ''}</div>
          ${e.concerns && e.concerns.length ? `<div style="color:#d2691e;font-size:10px">⚠ ${e.concerns.join(' · ')}</div>` : ''}
          <div style="margin-top:4px;display:flex;gap:12px;flex-wrap:wrap">
            <span style="color:#6b7280;font-size:10px">Confidence: <b style="color:#23242a">${e.confidence}%</b></span>
            <span style="color:#6b7280;font-size:10px">Setup: <b style="color:#23242a">${e.setupQuality}/100</b></span>
            <span style="color:#6b7280;font-size:10px">Score: <b style="color:#23242a">${e.technicalScore}</b></span>
            <span style="color:#6b7280;font-size:10px">@ <b style="color:#23242a">$${e.price?.toFixed(2)}</b></span>
            <span style="color:#6b7280;font-size:10px">${e.direction}</span>
            <span style="color:#6b7280;font-size:10px">${e.regime || ''}</span>
          </div>
        </div>`;
      }).join('')}
  </div>
</div>

${pos ? '<div class="card" style="margin-top:16px"><h2>Position Details</h2>' + posBlock + '</div>' : ''}

<div class="card" style="margin-top:16px;border-color:#6a4df440">
  <h2 style="color:#6a4df4">Ask Claude About ${sym}</h2>
  ${onDemandAnalysis ? `
  <div style="margin-bottom:12px;padding:12px;background:#f6f7f9;border-radius:6px;border-left:3px solid #6a4df4">
    ${onDemandAnalysis.question ? `<div style="color:#6b7280;font-size:10px;margin-bottom:6px">Q: ${onDemandAnalysis.question} &nbsp;<span style="color:#aab0bb">${Math.round((Date.now() - onDemandAnalysis.ts) / 60000)}m ago</span></div>` : `<div style="color:#6b7280;font-size:10px;margin-bottom:6px">General analysis &nbsp;<span style="color:#aab0bb">${Math.round((Date.now() - onDemandAnalysis.ts) / 60000)}m ago</span></div>`}
    <div style="color:#3a3b42;font-size:12px;line-height:1.7;white-space:pre-wrap">${onDemandAnalysis.response}</div>
  </div>` : ''}
  ${spectator ? `<div style="color:#8a909b;font-size:11px;margin-top:6px">Spectator mode: on-demand AI prompts are disabled.</div>` : `<form method="POST" action="/api/ticker/${sym}/analyze?a=${acct.id}" style="display:flex;gap:8px;margin-top:4px">
    <input name="question" placeholder='e.g. "Should I enter now?" or "What are the key risks?"'
      style="flex:1;background:#f6f7f9;border:1px solid #6a4df440;color:#23242a;padding:8px 12px;border-radius:4px;font-family:inherit;font-size:12px">
    <button type="submit" style="background:#6a4df4;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px;white-space:nowrap">Ask Claude</button>
  </form>
  <div style="color:#aab0bb;font-size:10px;margin-top:6px">Leave blank for a full setup analysis · Uses Claude Haiku</div>`}
</div>

<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"></script>
<script>
window.__CHARTS__ = ${JSON.stringify({ short: shortChartData, barrier: barrierChartData, long: longChartData }).replace(/</g, "\\u003c")};
(function () {
  function build(id, cfg, height) {
    var el = document.getElementById(id);
    if (!el) return;
    if (typeof LightweightCharts === "undefined" || !cfg) {
      el.innerHTML = '<div style="color:#8a909b;font-size:11px;padding:20px 0;text-align:center">Chart unavailable</div>';
      return;
    }
    var chart = LightweightCharts.createChart(el, {
      width: el.clientWidth, height: height,
      layout: { background: { color: "#ffffff" }, textColor: "#6b7280", fontSize: 11, fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" },
      grid: { vertLines: { color: "#f0f1f4" }, horzLines: { color: "#f0f1f4" } },
      rightPriceScale: { borderColor: "#e7e8ec", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#e7e8ec", fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScroll: false, handleScale: false,
    });
    var cs = chart.addCandlestickSeries({ upColor: "#00a843", downColor: "#e8473f", borderUpColor: "#00a843", borderDownColor: "#e8473f", wickUpColor: "#00a84399", wickDownColor: "#e8473f99" });
    cs.setData(cfg.candles || []);
    (cfg.emas || []).forEach(function (e) {
      if (!e.data || !e.data.length) return;
      var ls = chart.addLineSeries({ color: e.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ls.setData(e.data);
    });
    if (cfg.volume && cfg.volume.length) {
      var vs = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vs.setData(cfg.volume);
    }
    (cfg.lines || []).forEach(function (l) {
      cs.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: l.title || "" });
    });
    chart.timeScale().fitContent();
    if (window.ResizeObserver) {
      new ResizeObserver(function () { chart.applyOptions({ width: el.clientWidth }); chart.timeScale().fitContent(); }).observe(el);
    }
  }
  var C = window.__CHARTS__ || {};
  build("chart-short", C.short, 240);
  build("chart-barrier", C.barrier, 240);
  build("chart-long", C.long, 300);
})();
</script>
</body></html>`;
}

// ─── Robinhood Page (PIN-protected) ───

function robinhoodPageHTML({ spectator = false } = {}) {
  const connected = robinhood.isConnected;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Robinhood">
<meta name="theme-color" content="#f6f7f9">
<title>Robinhood Agentic Trading</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f6f7f9;color:#3a3b42;font-family:'Inter','SF Pro',system-ui,sans-serif;padding:0}
  #rh-app{overflow-x:auto}
  @media(max-width:600px){#rh-app{padding:12px}input,button,select{font-size:16px}}
  #pin-gate{display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:20px}
  #pin-gate h1{color:#00a843;font-size:28px;letter-spacing:2px}
  #pin-gate .subtitle{color:#6b7280;font-size:13px}
  #pin-input{width:200px;padding:14px;text-align:center;font-size:24px;letter-spacing:12px;background:#ffffff;border:2px solid #d4d8e0;border-radius:12px;color:#1c1d22;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  #pin-input:focus{outline:none;border-color:#00a843}
  #pin-input.error{border-color:#e8473f;animation:shake .3s}
  @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
  #rh-app{display:block;padding:20px;max-width:1200px;margin:0 auto}
  .rh-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #e3e6ea}
  .rh-header h1{color:#00a843;font-size:22px;display:flex;align-items:center;gap:10px}
  .rh-header h1 img{width:28px;height:28px}
  .rh-back{color:#6b7280;text-decoration:none;font-size:13px;padding:6px 14px;border:1px solid #d4d8e0;border-radius:6px}
  .rh-back:hover{color:#1c1d22;border-color:#8a909b}
  .rh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:16px;margin-bottom:16px}
  .rh-card{background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;padding:20px}
  .rh-card h2{color:#1c1d22;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .rh-card h2 .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  .rh-card h2 .dot.green{background:#00a843}
  .rh-card h2 .dot.red{background:#e8473f}
  .rh-card h2 .dot.yellow{background:#b07400}
  .rh-stat{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f6f7f9;font-size:13px}
  .rh-stat .label{color:#6b7280}
  .rh-stat .value{color:#1c1d22;font-weight:600}
  .rh-table{width:100%;border-collapse:collapse;font-size:12px}
  .rh-table th{color:#6b7280;text-align:left;padding:8px 6px;border-bottom:1px solid #e3e6ea;font-weight:500}
  .rh-table td{padding:8px 6px;border-bottom:1px solid #f6f7f9;color:#3a3b42}
  .rh-table tr:hover td{background:#eef1f4}
  .rh-input{width:100%;padding:8px 12px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;font-size:13px}
  .rh-input:focus{outline:none;border-color:#00a843}
  .rh-btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .2s}
  .rh-btn.primary{background:#00a843;color:#000}
  .rh-btn.primary:hover{background:#00a843}
  .rh-btn.danger{background:#e8473f26;color:#e8473f;border:1px solid #e8473f3a}
  .rh-btn.danger:hover{background:#e8473f3a}
  .rh-btn.secondary{background:#e3e6ea;color:#3a3b42;border:1px solid #d4d8e0}
  .rh-btn.secondary:hover{background:#d4d8e0;color:#1c1d22}
  .rh-btn.small{padding:4px 10px;font-size:11px}
  .rh-toggle{display:flex;align-items:center;gap:10px;padding:8px 0}
  .rh-toggle label{color:#6b7280;font-size:12px;flex:1}
  .rh-toggle .switch{width:40px;height:22px;background:#d4d8e0;border-radius:11px;cursor:pointer;position:relative;transition:background .2s}
  .rh-toggle .switch.on{background:#00a843}
  .rh-toggle .switch::after{content:'';width:18px;height:18px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px;transition:left .2s}
  .rh-toggle .switch.on::after{left:20px}
  .rh-pending-item{display:flex;align-items:center;justify-content:space-between;padding:10px;background:#f6f7f9;border:1px solid #e3e6ea;border-radius:8px;margin-bottom:8px}
  .rh-pending-item .sym{color:#1c1d22;font-weight:700;font-size:15px}
  .rh-pending-item .detail{color:#6b7280;font-size:11px;margin-top:2px}
  .rh-empty{color:#8a909b;font-size:12px;text-align:center;padding:20px}
  #options-results{max-height:400px;overflow-y:auto}
  #orders-list{max-height:300px;overflow-y:auto}
  .rh-loading{color:#8a909b;font-size:12px;text-align:center;padding:12px}
  .rh-full-width{grid-column:1/-1}
</style>
</head><body>

<!-- Main App (site-wide server auth gates access; no separate PIN) -->
<div id="rh-app">
  <div class="rh-header">
    <h1>🟢 Robinhood Agentic Trading</h1>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="rh-conn-badge" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid ${connected ? '#00a84366' : '#e8473f66'};color:${connected ? '#00a843' : '#e8473f'}">${connected ? '● CONNECTED' : '● DISCONNECTED'}</span>
      <a href="/" class="rh-back">← Dashboard</a>
    </div>
  </div>

  <div class="rh-grid">
    <!-- Connection & Auth -->
    <div class="rh-card">
      <h2><span class="dot ${connected ? 'green' : 'red'}"></span> Connection</h2>
      <div class="rh-stat"><span class="label">Status</span><span class="value" style="color:${connected ? '#00a843' : '#e8473f'}">${connected ? 'Connected' : 'Disconnected'}</span></div>
      <div class="rh-stat"><span class="label">MCP Endpoint</span><span class="value" style="font-size:10px;color:#6b7280">agent.robinhood.com</span></div>
      <div class="rh-stat"><span class="label">Account</span><span class="value" style="color:${connected ? '#00a843' : '#6b7280'}">${robinhood.accountNumber ? '••••' + String(robinhood.accountNumber).slice(-4) : 'Not discovered'}</span></div>
      ${spectator ? `<div style="margin-top:12px;color:#8a909b;font-size:12px">Spectator mode: token entry and connection controls are hidden.</div>` : `<div style="margin-top:12px">
        <a href="/api/rh-auth" class="rh-btn primary" style="display:inline-block;text-decoration:none;text-align:center;margin-bottom:12px;font-size:14px;padding:10px 24px">Sign in with Robinhood</a>
        <details style="margin-top:4px">
          <summary style="color:#6b7280;font-size:11px;cursor:pointer">Or paste a token manually</summary>
          <div style="margin-top:8px">
            <input type="password" class="rh-input" id="rh-token" placeholder="Paste accessToken (long eyJ... string)" style="margin-bottom:8px">
            <input type="password" class="rh-input" id="rh-refresh" placeholder="Optional: refreshToken" style="margin-bottom:8px">
            <div style="display:flex;gap:8px">
              <button class="rh-btn primary" onclick="connectRH()">Connect</button>
              <button class="rh-btn danger" onclick="disconnectRH()">Disconnect</button>
            </div>
          </div>
        </details>
      </div>`}
    </div>

    <!-- Account Overview -->
    <div class="rh-card" id="account-card">
      <h2>💰 Account</h2>
      <div id="account-data" class="rh-loading">Loading account data...</div>
    </div>

    <!-- Positions -->
    <div class="rh-card rh-full-width" id="positions-card">
      <h2>📊 Positions</h2>
      <div id="positions-data" class="rh-loading">Loading positions...</div>
    </div>

    <!-- Options Chain Lookup -->
    <div class="rh-card rh-full-width">
      <h2>📋 Options Chain</h2>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" class="rh-input" id="options-symbol" placeholder="Enter ticker (e.g. AAPL)" style="width:200px;text-transform:uppercase">
        <button class="rh-btn primary" onclick="lookupOptions()">Lookup</button>
      </div>
      <div id="options-results" class="rh-empty">Enter a ticker above to fetch the options chain from Robinhood</div>
    </div>

    <!-- Robinhood Watchlist -->
    <div class="rh-card">
      <h2>👁 Watchlist <span style="color:#6b7280;font-weight:400;font-size:11px">(${RH_WATCHLIST_NAME})</span></h2>
      ${spectator ? `<div class="rh-empty" style="margin-bottom:8px">Spectator mode: read-only</div>` : `
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input type="text" class="rh-input" id="wl-symbol" placeholder="Ticker (e.g. NVDA)" style="text-transform:uppercase">
        <button class="rh-btn primary" onclick="addWatchlistSymbol()">Add</button>
      </div>
      <details style="margin-bottom:10px">
        <summary style="color:#6b7280;font-size:11px;cursor:pointer">Add specific option contract</summary>
        <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input type="text" class="rh-input" id="wl-opt-symbol" placeholder="Underlying" style="text-transform:uppercase">
          <input type="text" class="rh-input" id="wl-opt-exp" placeholder="YYYY-MM-DD">
          <input type="number" class="rh-input" id="wl-opt-strike" placeholder="Strike" step="0.5">
          <select class="rh-input" id="wl-opt-type"><option value="call">Call</option><option value="put">Put</option></select>
        </div>
        <button class="rh-btn primary" style="margin-top:8px;width:100%" onclick="addWatchlistOption()">Add Option</button>
      </details>`}
      <div id="watchlist-data" class="rh-loading">Loading watchlist...</div>
    </div>

    <!-- Entry posture -->
    <div class="rh-card">
      <h2>🛡️ Entry Posture</h2>
      <div class="rh-empty">Observation-only: no new live entries until forward validation establishes an executable edge. Protective exits remain active.</div>
    </div>

    <!-- Trading Controls -->
    <div class="rh-card">
      <h2>⚙️ Controls</h2>
      ${spectator ? `<div class="rh-empty">Spectator mode: trading controls are read-only and disabled.</div>` : `
      <div class="rh-toggle">
        <label>Live Execution</label>
        <span style="font-size:11px;color:${connected ? '#00a843' : '#6b7280'};min-width:80px">${connected ? 'ACTIVE' : 'DISCONNECTED'}</span>
      </div>
      <div class="rh-toggle">
        <label>New Entries</label>
        <span style="font-size:11px;color:#b07400;min-width:80px">OBSERVE</span>
      </div>
      <div class="rh-toggle">
        <label>Options Only</label>
        <div class="switch ${RH_OPTIONS_ONLY ? 'on' : ''}" onclick="toggleOptionsOnly()" title="${RH_OPTIONS_ONLY ? 'Options only — no equity fallback' : 'Allow equity fallback'}"></div>
        <span style="font-size:11px;color:${RH_OPTIONS_ONLY ? '#00a843' : '#6b7280'};min-width:80px">${RH_OPTIONS_ONLY ? 'OPTIONS' : 'DUAL'}</span>
      </div>
      <div class="rh-toggle">
        <label>Auto Watchlist</label>
        <div class="switch ${RH_AUTO_WATCHLIST ? 'on' : ''}" onclick="toggleAutoWatchlist()" title="${RH_AUTO_WATCHLIST ? 'Serious candidates auto-added' : 'Manual watchlist only'}"></div>
        <span style="font-size:11px;color:${RH_AUTO_WATCHLIST ? '#00a843' : '#6b7280'};min-width:80px">${RH_AUTO_WATCHLIST ? 'AUTO' : 'OFF'}</span>
      </div>
      <div class="rh-stat"><span class="label">Trade Mode</span><span class="value" style="color:${robinhood.optionsEnabled ? '#00a843' : '#6b7280'}">${robinhood.optionsEnabled ? (RH_OPTIONS_ONLY ? 'Options only' : 'Options + equity fallback') : 'Equity only (no MCP options)'}</span></div>
      <div class="rh-stat"><span class="label">Watchlist</span><span class="value" style="font-size:11px">${RH_WATCHLIST_NAME}</span></div>
      <div class="rh-stat"><span class="label">Max Position</span><span class="value">$${RH_MAX_POSITION_DOLLARS}</span></div>
      <div style="margin-top:12px">
        <button class="rh-btn danger" onclick="killSwitch()" style="width:100%">🛑 Cancel Working Buys</button>
      </div>
      `}
    </div>

    <!-- Recent Orders -->
    <div class="rh-card rh-full-width">
      <h2>📜 Recent Orders</h2>
      <div id="orders-list" class="rh-loading">Loading orders...</div>
    </div>
  </div>
</div>

<script>
// Access is gated site-wide by the server-side password (signed cookie), so the app loads directly.
initApp();

function initApp() {
  loadAccount();
  loadPositions();
  loadOrders();
  loadWatchlist();
}

async function loadAccount() {
  const el = document.getElementById('account-data');
  try {
    const r = await fetch('/api/rh-account');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div class="rh-empty">'+d.error+'</div>'; return; }
    if (typeof d === 'string') { el.innerHTML = '<div style="font-size:12px;white-space:pre-wrap;color:#3a3b42">'+d+'</div>'; return; }
    let html = '';
    for (const [k,v] of Object.entries(d)) {
      const label = k.replace(/_/g,' ').replace(/\\b\\w/g,l=>l.toUpperCase());
      html += '<div class="rh-stat"><span class="label">'+label+'</span><span class="value">'+v+'</span></div>';
    }
    el.innerHTML = html || '<div class="rh-empty">No data</div>';
  } catch(e) { el.innerHTML = '<div class="rh-empty">Not connected</div>'; }
}

async function loadPositions() {
  const el = document.getElementById('positions-data');
  try {
    const r = await fetch('/api/rh-portfolio');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div class="rh-empty">'+d.error+'</div>'; return; }
    if (typeof d === 'string') { el.innerHTML = '<div style="font-size:12px;white-space:pre-wrap;color:#3a3b42">'+d+'</div>'; return; }
    if (Array.isArray(d) && d.length === 0) { el.innerHTML = '<div class="rh-empty">No positions</div>'; return; }
    if (Array.isArray(d)) {
      let html = '<table class="rh-table"><tr><th>Symbol</th><th>Qty</th><th>Avg Cost</th><th>Current</th><th>P&L</th></tr>';
      for (const p of d) {
        const pnl = p.pnl || p.unrealized_pnl || '—';
        const color = parseFloat(pnl) >= 0 ? '#00a843' : '#e8473f';
        const avgCost = p.average_buy_price || p.average_cost || p.average_price;
        const curPrice = p.current_price || p.last_trade_price || p.last_extended_hours_trade_price;
        html += '<tr><td style="color:#1c1d22;font-weight:600">'+p.symbol+'</td><td>'+p.quantity+'</td><td>'+(avgCost?'$'+parseFloat(avgCost).toFixed(2):'?')+'</td><td>'+(curPrice?'$'+parseFloat(curPrice).toFixed(2):'?')+'</td><td style="color:'+color+'">'+pnl+'</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    } else {
      let html = '';
      for (const [k,v] of Object.entries(d)) {
        html += '<div class="rh-stat"><span class="label">'+k+'</span><span class="value">'+JSON.stringify(v).slice(0,100)+'</span></div>';
      }
      el.innerHTML = html;
    }
  } catch(e) { el.innerHTML = '<div class="rh-empty">Not connected</div>'; }
}

async function loadOrders() {
  const el = document.getElementById('orders-list');
  try {
    const r = await fetch('/api/rh-orders');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div class="rh-empty">'+d.error+'</div>'; return; }
    if (typeof d === 'string') { el.innerHTML = '<div style="font-size:12px;white-space:pre-wrap;color:#3a3b42">'+d+'</div>'; return; }
    if (Array.isArray(d) && d.length === 0) { el.innerHTML = '<div class="rh-empty">No recent orders</div>'; return; }
    if (Array.isArray(d)) {
      let html = '<table class="rh-table"><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>Status</th><th>Price</th></tr>';
      for (const o of d.slice(0, 20)) {
        const statusColor = o.status === 'filled' ? '#00a843' : o.status === 'cancelled' ? '#e8473f' : '#b07400';
        html += '<tr><td style="color:#1c1d22;font-weight:600">'+(o.symbol||'?')+'</td><td>'+(o.side||'?')+'</td><td>'+(o.quantity||'?')+'</td><td>'+(o.order_type||o.type||'?')+'</td><td style="color:'+statusColor+'">'+(o.status||'?')+'</td><td>$'+(o.price||o.average_price||'—')+'</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    } else {
      let html = '';
      for (const [k,v] of Object.entries(d)) {
        html += '<div class="rh-stat"><span class="label">'+k+'</span><span class="value">'+JSON.stringify(v).slice(0,100)+'</span></div>';
      }
      el.innerHTML = html;
    }
  } catch(e) { el.innerHTML = '<div class="rh-empty">Not connected</div>'; }
}

async function lookupOptions() {
  const sym = document.getElementById('options-symbol').value.trim().toUpperCase();
  if (!sym) return;
  const el = document.getElementById('options-results');
  el.innerHTML = '<div class="rh-loading">Fetching options for '+sym+'...</div>';
  try {
    const r = await fetch('/api/rh-options?symbol='+sym);
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div class="rh-empty">'+d.error+'</div>'; return; }
    if (typeof d === 'string') {
      el.innerHTML = '<div style="font-size:11px;white-space:pre-wrap;color:#3a3b42;max-height:400px;overflow-y:auto">'+d+'</div>';
    } else if (Array.isArray(d)) {
      let html = '<table class="rh-table"><tr><th>Type</th><th>Strike</th><th>Exp</th><th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th></tr>';
      for (const o of d.slice(0, 50)) {
        html += '<tr><td style="color:'+(o.type==='call'?'#00a843':'#e8473f')+'">'+(o.type||'?')+'</td><td>$'+(o.strike||'?')+'</td><td>'+(o.expiry||o.expiration_date||'?')+'</td><td>'+(o.bid||'—')+'</td><td>'+(o.ask||'—')+'</td><td>'+(o.volume||'—')+'</td><td>'+(o.open_interest||'—')+'</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    } else {
      el.innerHTML = '<div style="font-size:11px;white-space:pre-wrap;color:#3a3b42">'+JSON.stringify(d, null, 2)+'</div>';
    }
  } catch(e) { el.innerHTML = '<div class="rh-empty">Error: '+e.message+'</div>'; }
}

async function connectRH() {
  const token = document.getElementById('rh-token').value.trim();
  const refresh = document.getElementById('rh-refresh').value.trim();
  if (!token) { alert('Paste the accessToken value from rh_tokens.json (starts with eyJ)'); return; }
  if (!token.startsWith('eyJ')) { alert('That does not look like an access token. Copy accessToken from rh_tokens.json — not refreshToken.'); return; }
  try {
    let body = 'token='+encodeURIComponent(token);
    if (refresh) body += '&refresh_token='+encodeURIComponent(refresh);
    const r = await fetch('/api/rh-token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body });
    const d = await r.json();
    alert(d.message || d.error || 'Done');
    location.reload();
  } catch(e) { alert('Error: '+e.message); }
}

function disconnectRH() {
  if (!confirm('Disconnect from Robinhood? This will clear your token.')) return;
  fetch('/api/rh-token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'token=' }).then(()=>location.reload());
}

async function toggleOptionsOnly() {
  await fetch('/api/rh-options-only', { method: 'POST' });
  location.reload();
}

async function toggleAutoWatchlist() {
  await fetch('/api/rh-auto-watchlist', { method: 'POST' });
  location.reload();
}

async function loadWatchlist() {
  const el = document.getElementById('watchlist-data');
  if (!el) return;
  try {
    const r = await fetch('/api/rh-watchlist');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div class="rh-empty">'+d.error+'</div>'; return; }
    const items = d.items || [];
    if (!items.length) { el.innerHTML = '<div class="rh-empty">No items in "'+(d.watchlist||'?')+'"</div>'; return; }
    let html = '<table class="rh-table"><tr><th>Symbol</th><th>Type</th><th>Detail</th></tr>';
    for (const it of items.slice(0, 30)) {
      html += '<tr><td style="font-weight:600">'+(it.symbol||it.chain_symbol||'?')+'</td><td>'+(it.type||it.instrument_type||'equity')+'</td><td style="font-size:11px;color:#6b7280">'+(it.detail||it.name||'')+'</td></tr>';
    }
    html += '</table>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="rh-empty">'+e.message+'</div>'; }
}

async function addWatchlistSymbol() {
  const sym = document.getElementById('wl-symbol').value.trim().toUpperCase();
  if (!sym) { alert('Enter a ticker'); return; }
  try {
    const r = await fetch('/api/rh-watchlist-add', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'symbol='+encodeURIComponent(sym) });
    const d = await r.json();
    alert(d.message || d.error || 'Done');
    loadWatchlist();
  } catch(e) { alert('Error: '+e.message); }
}

async function addWatchlistOption() {
  const symbol = document.getElementById('wl-opt-symbol').value.trim().toUpperCase();
  const expiration = document.getElementById('wl-opt-exp').value.trim();
  const strike = document.getElementById('wl-opt-strike').value.trim();
  const optionType = document.getElementById('wl-opt-type').value;
  if (!symbol || !expiration || !strike) { alert('Fill underlying, expiry, and strike'); return; }
  try {
    const body = 'symbol='+encodeURIComponent(symbol)+'&expiration='+encodeURIComponent(expiration)+'&strike='+encodeURIComponent(strike)+'&option_type='+encodeURIComponent(optionType);
    const r = await fetch('/api/rh-watchlist-add', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body });
    const d = await r.json();
    alert(d.message || d.error || 'Done');
    loadWatchlist();
  } catch(e) { alert('Error: '+e.message); }
}

async function killSwitch() {
  if (!confirm('Cancel every tracked working Robinhood BUY order? Protective sell orders will remain active.')) return;
  const response = await fetch('/api/rh-cancel-entry-orders', { method: 'POST' });
  const result = await response.json();
  alert(result.error || ('Cancel requested for '+result.canceled+' buy order(s)'));
  location.reload();
}

// Auto-refresh every 30s
setInterval(() => { loadAccount(); loadPositions(); loadOrders(); loadWatchlist(); }, 30000);
</script>
</body></html>`;
}

// ─── Learning Panel HTML ───

function learningPanelHTML(acct, { spectator = false } = {}) {
  // On a variant's own page: banner linking back to the parent.
  if (acct.learning) {
    const parent = accounts.get(acct.learningParent);
    const variant = LEARNING_VARIANTS.find(v => v.key === acct.learningKey);
    return `<div class="card" style="margin-bottom:16px;border-left:3px solid #6a4df4">
      <div style="font-size:12px;color:#3a3b42">🧠 <b>Learning variant</b>${variant ? ` — ${variant.desc}` : ""} · shadow paper account of
      ${parent ? `<a href="/?a=${parent.id}" style="color:#6a4df4">${parent.name}</a>` : "(parent deleted)"} · real chains only, no LLM, no notifications</div>
    </div>`;
  }
  if (acct.config.broker !== "robinhood") return "";

  const enabled = acct.config.learningEnabled !== false;
  const variants = learningVariantsFor(acct.id);
  const rows = variants
    .map(v => ({ v, s: learningStats(v), meta: LEARNING_VARIANTS.find(x => x.key === v.learningKey) }))
    .sort((a, b) => b.s.pv - a.s.pv);
  const bestPv = rows.length > 0 ? rows[0].s.pv : null;

  const tableRows = rows.map(({ v, s, meta }, i) => {
    const color = s.pnlPct >= 0 ? "#00a843" : "#e8473f";
    const crown = i === 0 && rows.length > 1 && s.trades > 0 ? " 👑" : "";
    return `<tr>
      <td><a href="/?a=${v.id}" style="color:#1c1d22;text-decoration:none"><b>${v.name.replace("🧠 ", "")}</b>${crown}</a></td>
      <td style="color:#6b7280;font-size:11px">${meta?.desc || ""}</td>
      <td>$${s.pv.toFixed(0)}</td>
      <td style="color:${color}">${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(1)}%</td>
      <td>${s.open}</td>
      <td>${s.trades}</td>
      <td>${s.winRate != null ? s.winRate.toFixed(0) + "%" : "—"}</td>
      <td style="color:${s.realized >= 0 ? "#00a843" : "#e8473f"}">${s.realized >= 0 ? "+" : ""}$${s.realized.toFixed(0)}</td>
    </tr>`;
  }).join("");

  const archivedRuns = (acct.state.learningLog || []).length;
  const controls = spectator ? "" : `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
      <form method="POST" action="/api/accounts/${acct.id}/learning/reset" style="display:flex;gap:6px;align-items:center"
        onsubmit="return confirm('Reset all learning variants? Current results are archived first.')">
        <input name="cash" type="number" step="1" min="50" placeholder="mirror balance"
          style="width:110px;padding:6px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;font-size:11px" title="Theoretical bankroll ($). Leave blank to mirror this account's current balance.">
        <button type="submit" class="acct-btn" style="font-size:11px">↺ Reset / Re-seed</button>
      </form>
      <form method="POST" action="/api/accounts/${acct.id}/learning/toggle" style="display:inline"
        ${enabled ? `onsubmit="return confirm('Disable the learning lab? Variants are archived and removed.')"` : ""}>
        <button type="submit" class="acct-btn ${enabled ? "delete" : ""}" style="font-size:11px">${enabled ? "✕ Disable lab" : "▶ Enable lab"}</button>
      </form>
      ${archivedRuns > 0 ? `<span style="font-size:10px;color:#8a909b">${archivedRuns} archived run${archivedRuns !== 1 ? "s" : ""}</span>` : ""}
    </div>`;

  return `<div class="card" style="margin-bottom:16px" id="learning-card">
  <h2>🧠 Learning Lab <span style="color:#6b7280;font-weight:400;font-size:11px">(${enabled ? `${variants.length} shadow strategies trading this account's watchlist` : "disabled"})</span></h2>
  ${enabled && rows.length > 0 ? `
  <div style="font-size:10px;color:#8a909b;margin:6px 0 8px">Paper variants mirror your watchlist + bankroll and run every cycle — real option chains only, deterministic entries (no LLM), so relative performance isolates each strategy knob. Best PV: <b>$${bestPv.toFixed(0)}</b></div>
  <div style="overflow-x:auto"><table>
    <tr><th>Variant</th><th>Tweak</th><th>PV</th><th>P&L</th><th>Open</th><th>Trades</th><th>Win rate</th><th>Realized</th></tr>
    ${tableRows}
  </table></div>` : enabled ? `<div style="font-size:11px;color:#8a909b;margin-top:8px">Variants spawn on the next trading cycle.</div>` : `<div style="font-size:11px;color:#8a909b;margin-top:8px">Enable to run shadow strategy experiments against this account's watchlist while you wait for funds to settle.</div>`}
  ${controls}
</div>`;
}

// ─── Tab Bar HTML ───

function tabBarHTML(activeId, { spectator = false } = {}) {
  let totalPV = 0;
  const tabs = [];
  let mainCount = 0;
  for (const [id, acct] of accounts) {
    if (acct.learning) continue; // shadow variants live in the Learning panel, not the tab bar
    mainCount++;
    const pv = portfolioValue(acct.state, acct.dashboard.quotes);
    totalPV += pv;
    const pnl = ((pv - acct.config.startingCash) / acct.config.startingCash * 100).toFixed(1);
    const color = pnl >= 0 ? "#00a843" : "#e8473f";
    const isActive = id === activeId;
    const statusDot = acct.paused ? "🔴" : "🟢";
    const liveBadge = acct.config.broker === "tradier"
      ? `<span class="tab-live" style="background:#00a8431c;color:#00a843;border:1px solid #00a84340;border-radius:4px;padding:0 4px;font-size:9px;font-weight:bold;margin-left:4px">LIVE</span>`
      : acct.config.broker === "robinhood"
      ? `<span class="tab-live" style="background:#00a8431c;color:#00a843;border:1px solid #00a84340;border-radius:4px;padding:0 4px;font-size:9px;font-weight:bold;margin-left:4px">RH LIVE</span>`
      : "";
    tabs.push(`<a href="/?a=${id}" class="acct-tab ${isActive ? "active" : ""}" title="${acct.name}${acct.config.broker === "tradier" ? " — LIVE Tradier account" : ""}">
      <span class="tab-status">${statusDot}</span>
      <span class="tab-name">${acct.name}</span>${liveBadge}
      <span class="tab-pv">$${pv.toFixed(0)}</span>
      <span class="tab-pnl" style="color:${color}">${pnl >= 0 ? "+" : ""}${pnl}%</span>
    </a>`);
  }
  const llmBadge = spectator
    ? `<span class="llm-toggle" title="Read-only in spectator mode">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>`
    : `<span class="llm-toggle" onclick="fetch('/api/llm-provider',{method:'POST'}).then(()=>location.reload())" title="Click to switch LLM provider">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>`;
  return `<div class="tab-bar">
  <div class="tab-row">${tabs.join("")}
    ${spectator ? "" : `<a href="#" class="acct-tab new-tab" onclick="document.getElementById('acct-modal').style.display='flex';return false">+ New Account</a>
    <a href="/?sim=new" class="acct-tab new-tab" style="border-color:#6a4df440;color:#6a4df4">&#x1F9EA; Simulator</a>`}
    <a href="/robinhood" class="acct-tab new-tab" style="border-color:#00a84330;color:#00a843">🔒 Robinhood MCP</a>
    <a href="/tradier" class="acct-tab new-tab" style="border-color:#2f6fed40;color:#2f6fed">📈 Tradier</a>
    <a href="/media?a=${activeId}" class="acct-tab new-tab" style="border-color:#6a4df440;color:#6a4df4">📣 Media</a>
  </div>
  <div class="global-stats">
    <span>Total PV: <b>$${totalPV.toFixed(0)}</b></span>
    ${llmBadge}
    <span>${mainCount} account${mainCount !== 1 ? "s" : ""}</span>
    ${spectator ? '<span style="color:#2f6fed;font-weight:700">Spectator</span>' : ''}
  </div>
</div>

<!-- Account Management Modal -->
${spectator ? "" : `<div id="acct-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 0;box-sizing:border-box">
  <div style="background:#ffffff;border:1px solid #d4d8e0;border-radius:12px;padding:24px;max-width:420px;width:90%;max-height:calc(100vh - 40px);overflow-y:auto;box-sizing:border-box">
    <h2 style="margin:0 0 16px;color:#1c1d22">New Account</h2>
    <form method="POST" action="/api/accounts">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Account Name</label>
      <input name="name" value="Strategy 2" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Starting Cash ($)</label>
      <input name="startingCash" type="number" value="200" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Max Premium Allocation (%)</label>
      <input name="baseRiskPct" type="number" step="0.01" value="15" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Profit Target (%)</label>
      <input name="profitTarget" type="number" step="1" value="40" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Stop Loss (%)</label>
      <input name="stopLoss" type="number" step="1" value="-35" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Goal ($)</label>
      <input name="goal" type="number" value="200000" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Min Setup Quality (0-100, lower = more aggressive)</label>
      <input name="minSetupQuality" type="number" value="50" min="0" max="100" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Custom Prompt Suffix (optional)</label>
      <input name="customPromptSuffix" value="" placeholder="e.g. Focus on tech sector only" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:16px;box-sizing:border-box">
      <input type="hidden" name="broker" value="paper">
      <div style="font-size:12px;color:#6b7280;margin-bottom:12px">Broker: <strong>PAPER</strong> · live brokers use their protected canonical account tabs.</div>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="useCashReserve" checked> Use cash reserve (50%→25% buffer)</label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="tradeWhenClosed"> Trade when market closed (testing/sandbox)</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">0-cash spend limit ($)</label><input name="marginZeroCashSpendLimit" type="number" value="200" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
        <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">Max margin debt ($)</label><input name="marginMaxDebt" type="number" value="250" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
      </div>
      <div style="display:flex;gap:8px">
        <button type="submit" style="flex:1;padding:10px;background:#00a843;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Create Account</button>
        <button type="button" onclick="document.getElementById('acct-modal').style.display='none'" style="flex:1;padding:10px;background:#d4d8e0;color:#1c1d22;border:none;border-radius:6px;cursor:pointer">Cancel</button>
      </div>
    </form>
  </div>
</div>`}
`;
}

// Quick toggle between named strategy presets (the same knob combinations the Learning Lab
// tests as shadow paper accounts) applied directly to this real account's config.
function strategyPresetHTML(acctId, { spectator = false } = {}) {
  const acct = accounts.get(acctId);
  if (!acct || acct.learning) return ""; // shadow variants already ARE a fixed preset
  const active = acct.config.strategyPreset;
  const pills = liveStrategyPresets().map(v => {
    const isActive = active === v.key;
    const isMarch = v.key === "march1m";
    const style = isActive
      ? (isMarch ? "background:#0f766e;color:#fff;border-color:#0f766e" : "background:#6a4df4;color:#fff;border-color:#6a4df4")
      : (isMarch ? "background:#ecfdf5;color:#0f766e;border-color:#99f6e4" : "background:#f6f7f9;color:#3a3b42;border-color:#d4d8e0");
    return spectator
      ? `<span class="acct-btn" style="${style};cursor:default" title="${v.desc}">${v.name}</span>`
      : `<form method="POST" action="/api/accounts/${acctId}/strategy" style="display:inline">
        <input type="hidden" name="preset" value="${v.key}">
        <button type="submit" class="acct-btn" style="${style}" title="${v.desc}"${isActive ? " disabled" : ""}>${v.name}</button>
      </form>`;
  }).join("");
  return `<div class="acct-actions" style="margin-top:-4px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
    <span style="font-size:11px;color:#8a909b;align-self:center">🎯 Strategy:</span>${pills}
  </div>`;
}

function accountActionsHTML(acctId, { spectator = false } = {}) {
  const acct = accounts.get(acctId);
  if (!acct) return "";
  const cfg = acct.config;
  if (spectator) {
    return `<div class="acct-actions">
      <a href="/logout" class="acct-btn" style="text-decoration:none">Exit spectator mode</a>
      <span style="font-size:11px;color:#8a909b;align-self:center">Read-only: settings, pause/delete, notifications, broker tokens, and AI prompts are unavailable.</span>
    </div>`;
  }
  const activeHalt = riskBreakerStatus(acct);
  return `<div class="acct-actions">
    <button type="button" class="acct-btn edit" onclick="document.getElementById('edit-modal').style.display='flex'">⚙ Settings</button>
    <form method="POST" action="/api/accounts/${acctId}/pause" style="display:inline">
      <button type="submit" class="acct-btn ${acct.paused ? "resume" : "pause"}">${acct.paused ? "▶ Resume" : "⏸ Pause"}</button>
    </form>
    ${activeHalt ? `<form method="POST" action="/api/accounts/${acctId}/risk-reset" style="display:inline"
      onsubmit="return confirm('Clear the risk halt and re-baseline today\\'s daily-loss reference to the current portfolio value?\\n\\nActive halt: ${activeHalt.replace(/'/g, "\\'")}\\n\\nOnly do this if the halt is from a tracking error, not a real loss.')">
      <button type="submit" class="acct-btn resume" title="${activeHalt}">🟢 Clear risk halt</button>
    </form>` : ""}
    <button type="button" class="acct-btn" id="push-btn" onclick="togglePush()" title="Toggle push notifications on this device">🔔 Notify</button>
    ${acctId !== "default" && !isCanonicalLiveAccount(acctId) ? `<form method="POST" action="/api/accounts/${acctId}/delete" style="display:inline" onsubmit="return confirm('Delete account ${acct.name}? This cannot be undone.')">
      <button type="submit" class="acct-btn delete">🗑 Delete</button>
    </form>` : ""}
  </div>
  <div id="edit-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 0;box-sizing:border-box">
    <div style="background:#ffffff;border:1px solid #d4d8e0;border-radius:12px;padding:24px;max-width:420px;width:90%;max-height:calc(100vh - 40px);overflow-y:auto;box-sizing:border-box">
      <h2 style="margin:0 0 16px;color:#1c1d22">Settings: ${acct.name}</h2>
      <form method="POST" action="/api/accounts/${acctId}/config">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Max Premium Allocation (%)</label>
        <input name="baseRiskPct" type="number" step="0.01" value="${(cfg.baseRiskPct * 100).toFixed(1)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Profit Target (%)</label>
        <input name="profitTarget" type="number" step="1" value="${(cfg.profitTarget * 100).toFixed(0)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Stop Loss (%)</label>
        <input name="stopLoss" type="number" step="1" value="${(cfg.stopLoss * 100).toFixed(0)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Goal ($)</label>
        <input name="goal" type="number" value="${cfg.goal}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Capital contributed / zero-point ($)${cfg.broker === "robinhood" || cfg.broker === "tradier" ? " — deposits go here, not into P&L" : ""}</label>
        <input name="startingCash" type="number" step="0.01" value="${cfg.startingCash || 0}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:6px;box-sizing:border-box">
        <p style="font-size:11px;color:#6b7280;margin:0 0 12px">P&amp;L = portfolio value − this number. When you deposit into Robinhood, update this (or use Record deposit below) so funding isn’t counted as profit.</p>
        ${(cfg.broker === "robinhood" || cfg.broker === "tradier") ? `
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Record deposit / withdrawal ($)</label>
        <input name="capitalDeposit" type="number" step="0.01" placeholder="e.g. 100 or -50" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        ` : ""}
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Max Positions (blank = unlimited)</label>
        <input name="maxPositions" type="number" value="${cfg.maxPositions || ""}" placeholder="unlimited" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Max Trade Size ($ Circuit Breaker)</label>
        <input name="maxTradeSize" type="number" value="${cfg.maxTradeSize || 500}" placeholder="500" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Min Setup Quality (0=trade anything, 50=default, 100=perfect setups only)</label>
        <input name="minSetupQuality" type="number" value="${cfg.minSetupQuality ?? 50}" min="0" max="100" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
          <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">Bull Entry Score (≥, buy calls)</label><input name="bullEntry" type="number" value="${cfg.bullEntry ?? 68}" min="50" max="100" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
          <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">Bear Entry Score (≤, buy puts)</label><input name="bearEntry" type="number" value="${cfg.bearEntry ?? 32}" min="0" max="50" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
        </div>
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Custom Prompt Suffix</label>
        <input name="customPromptSuffix" value="${(cfg.customPromptSuffix || "").replace(/"/g, "&quot;")}" placeholder="e.g. Focus on tech sector only" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:16px;box-sizing:border-box">
        <input type="hidden" name="configForm" value="1">
        <div style="border-top:1px solid #e3e6ea;margin:4px 0 14px;padding-top:14px">
          <div style="font-size:12px;color:#6b7280;margin-bottom:10px">Broker: <strong style="color:${cfg.broker === "tradier" ? "#00a843" : "#6b7280"}">${(cfg.broker || "paper").toUpperCase()}${cfg.broker === "tradier" ? " · LIVE" : ""}</strong></div>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="useCashReserve" ${cfg.useCashReserve ? "checked" : ""}> Use cash reserve (50%→25% buffer)</label>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="liveEntriesEnabled" ${cfg.liveEntriesEnabled ? "checked" : ""}> Allow new live entries</label>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="autoExecute" ${cfg.autoExecute ? "checked" : ""}> Auto-execute broker orders (full autonomy)</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#3a3b42"><input type="checkbox" name="tradeWhenClosed" ${cfg.tradeWhenClosed ? "checked" : ""}> Trade when market closed (testing/sandbox)</label>
          ${cfg.broker === "tradier" ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
            <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">0-cash spend limit ($)</label><input name="marginZeroCashSpendLimit" type="number" step="1" value="${cfg.marginZeroCashSpendLimit ?? DEFAULT_CONFIG.marginZeroCashSpendLimit}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
            <div><label style="display:block;margin-bottom:6px;font-size:11px;color:#6b7280">Max margin debt ($)</label><input name="marginMaxDebt" type="number" step="1" value="${cfg.marginMaxDebt ?? DEFAULT_CONFIG.marginMaxDebt}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;box-sizing:border-box"></div>
          </div><p style="font-size:11px;color:#b07400;margin:10px 0 0">⚠ LIVE account — orders execute with real money. Margin spend is capped by these limits. Use <strong>Pause</strong> as the kill switch (blocks new entries; exits still run to protect open positions).</p>` : ""}
        </div>
        <div style="display:flex;gap:8px">
          <button type="submit" style="flex:1;padding:10px;background:#6a4df4;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Save Settings</button>
          <button type="button" onclick="document.getElementById('edit-modal').style.display='none'" style="flex:1;padding:10px;background:#d4d8e0;color:#1c1d22;border:none;border-radius:6px;cursor:pointer">Cancel</button>
        </div>
      </form>
    </div>
  </div>`;
}

// ─── Tradier Page ───

function tradierPageHTML({ spectator = false } = {}) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Tradier">
<meta name="theme-color" content="#f6f7f9">
<title>Tradier Data + Execution</title>
<style>
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:900px;margin:0 auto}
  .card{overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:600px){
    body{padding:14px}
    h1{font-size:18px}
    input,button{font-size:16px}
    .grid{grid-template-columns:1fr 1fr}
  }
  h1{font-size:22px;margin:0 0 4px}
  a.back{color:#2f6fed;text-decoration:none;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
  .stat{background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;padding:14px}
  .stat .label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
  .stat .value{font-size:18px;font-weight:700;margin-top:4px}
  .ok{color:#00a843}.bad{color:#e8473f}.muted{color:#6b7280}
  .card{background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;padding:16px;margin-top:16px}
  input{padding:9px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22}
  button{padding:9px 14px;background:#2f6fed;color:#1c1d22;border:none;border-radius:6px;font-weight:600;cursor:pointer}
  pre{background:#f6f7f9;border:1px solid #e3e6ea;border-radius:8px;padding:12px;overflow:auto;font-size:12px;max-height:360px}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eceef1}
</style></head>
<body>
  <a class="back" href="/">&larr; Back to dashboard</a>
  <h1>📈 Tradier — Market Data + Execution Arm</h1>
  <div class="muted" style="font-size:13px">Real-time quotes, candles & option chains (with Greeks/IV) feed the bot when connected. LLM analysis & news intel stay on the existing pipeline.</div>

  <div class="grid" id="stats"><div class="stat"><div class="label">Status</div><div class="value muted">Loading…</div></div></div>

  <div id="errbox" style="display:none;background:#fdecec;border:1px solid #e8473f44;border-radius:10px;padding:12px;margin-top:8px;font-size:12px;color:#e8473f"></div>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px">Connection</h3>
    ${spectator ? `<div class="muted" style="font-size:12px">Spectator mode: environment, token, reconnect, and cancel-order controls are hidden.</div>` : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select id="env" style="background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;padding:9px">
        <option value="sandbox">sandbox</option>
        <option value="production">production</option>
      </select>
      <input id="token" placeholder="Paste Tradier access token (optional)" style="flex:1;min-width:200px">
      <button onclick="saveToken()">Save &amp; Connect</button>
      <button onclick="reconnect()" style="background:#5457e6">Reconnect</button>
      <button onclick="cancelAllOrders()" style="background:#e8473f">Cancel All Orders</button>
    </div>
    <div class="muted" style="font-size:11px;margin-top:8px">Leave the token blank to reconnect using the <code>TRADIER_ACCESS_TOKEN</code> env var. A token entered here is stored on the server (tradier_tokens.json).</div>`}
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px">Quote / Option-Chain Lookup</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="sym" placeholder="Ticker e.g. SPY" value="SPY">
      <button onclick="lookupQuote()">Quote</button>
      <button onclick="lookupChain()" style="background:#5457e6">Option Chain</button>
    </div>
    <div id="lookup" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px;font-size:15px">Pending Orders</h3>
    <div id="pending" class="muted">None</div>
  </div>

<script>
async function refresh(){
  try{
    const r = await fetch('/api/tradier-status'); const d = await r.json();
    const conn = d.connected ? '<span class="ok">CONNECTED</span>' : '<span class="bad">NOT CONNECTED</span>';
    const bi = d.balanceInfo || {};
    const fmt = v => (v == null ? '—' : '$'+Number(v).toFixed(2));
    const acctType = bi.accountType ? bi.accountType.toUpperCase() : '—';
    const acctTypeHtml = bi.accountType === 'cash' ? '<span class="ok">CASH</span>'
      : (bi.accountType && bi.accountType !== 'unknown') ? '<span class="bad">'+acctType+' ⚠</span>' : '—';
    const ds = d.dataSource || {};
    const dsHtml = d.connected
      ? '<span class="ok">Tradier LIVE</span> <span class="muted">(last: '+((ds.lastSource||'—').toUpperCase())+' · T:'+(ds.tradier||0)+' F:'+(ds.finnhub||0)+' Y:'+(ds.yahoo||0)+')</span>'
      : '<span class="bad">Finnhub/Yahoo fallback</span>';
    document.getElementById('stats').innerHTML =
      stat('Status', conn) +
      stat('Environment', (d.environment||'—').toUpperCase()) +
      stat('Account', d.accountId || 'data-only') +
      stat('Account Type', acctTypeHtml) +
      stat('Market', d.marketState || '—') +
      stat('Usable BP', fmt(bi.buyingPower)) +
      stat('Options BP', fmt(bi.optionBuyingPower)) +
      (bi.rawOptionBuyingPower === 0 && bi.optionBuyingPower > 0 ? stat('Raw Options BP', '<span class="muted">$0.00 normalized</span>') : '') +
      stat('Unsettled (T+1)', fmt(bi.unsettledCash)) +
      (bi.accountType && bi.accountType !== 'cash' ? stat('Broker Cash', fmt(bi.marginCashAvailable ?? bi.totalCash)) + stat('Margin Cap', fmt(bi.marginSpendLimit)) : '') +
      stat('Equity', fmt(bi.totalEquity)) +
      stat('Data Source', dsHtml);
    const eb = document.getElementById('errbox');
    if(!d.connected && d.lastError){ eb.style.display='block'; eb.innerHTML='<b>Connection error:</b> '+d.lastError+'<br><span style="color:#6b7280">Endpoint: '+(d.baseUrl||'')+'</span><br><span style="color:#6b7280">A 401 usually means the token doesn\\'t match the selected environment (sandbox token vs production token).</span>'; }
    else { eb.style.display='none'; }
    if(d.environment){ const sel=document.getElementById('env'); if(sel) sel.value=d.environment; }
    const po = d.pendingOrders||[];
    document.getElementById('pending').innerHTML = po.length ? '<pre>'+JSON.stringify(po,null,2)+'</pre>' : '<span class="muted">None</span>';
  }catch(e){ document.getElementById('stats').innerHTML = stat('Status','<span class="bad">error</span>'); }
}
function stat(l,v){return '<div class="stat"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>';}
async function reconnect(){
  const btn=event.target; btn.textContent='…';
  await fetch('/api/tradier-reconnect',{method:'POST'});
  btn.textContent='Reconnect'; refresh();
}
async function cancelAllOrders(){
  if(!confirm('Cancel ALL working Tradier orders? This will release reserved buying power.'))return;
  const btn=event.target; const t=btn.textContent; btn.textContent='Canceling…';
  const r=await fetch('/api/tradier-cancel-orders',{method:'POST'}); const d=await r.json();
  btn.textContent=t; alert('Canceled '+d.canceled+' order(s)'+(d.errors&&d.errors.length?(' ('+d.errors.length+' error(s))'):''));
  refresh();
}
async function saveToken(){
  const token=document.getElementById('token').value.trim();
  const env=document.getElementById('env').value;
  const body='token='+encodeURIComponent(token)+'&env='+encodeURIComponent(env);
  await fetch('/api/tradier-token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  document.getElementById('token').value='';
  refresh();
}
async function lookupQuote(){
  const sym=document.getElementById('sym').value.trim().toUpperCase();
  document.getElementById('lookup').innerHTML='Loading…';
  const r=await fetch('/api/tradier-quote?sym='+sym); const d=await r.json();
  document.getElementById('lookup').innerHTML='<pre>'+JSON.stringify(d,null,2)+'</pre>';
}
async function lookupChain(){
  const sym=document.getElementById('sym').value.trim().toUpperCase();
  document.getElementById('lookup').innerHTML='Loading chain…';
  const r=await fetch('/api/tradier-chain?sym='+sym); const d=await r.json();
  if(d.error){document.getElementById('lookup').innerHTML='<span class="bad">'+d.error+'</span>';return;}
  let rows='';
  for(const exp of (d.chain||[])){
    rows+='<tr><td colspan="6" style="color:#2f6fed;font-weight:700">'+exp.expirationDate+'</td></tr>';
    for(const c of (exp.options.CALL||[]).slice(0,4)){
      rows+='<tr><td>CALL</td><td>$'+c.strike+'</td><td>'+c.bid+'/'+c.ask+'</td><td>IV '+(c.impliedVolatility!=null?(c.impliedVolatility*100).toFixed(0)+'%':'—')+'</td><td>δ'+(c.delta??'—')+'</td><td>OI '+c.openInterest+'</td></tr>';
    }
  }
  document.getElementById('lookup').innerHTML='<table>'+rows+'</table>';
}
refresh(); setInterval(refresh, 8000);
</script>
</body></html>`;
}

// ─── Media Studio: compose shareable trade-plan posts + per-ticker chart cards ───
function mediaPageHTML(acct, { spectator = false, featured = null } = {}) {
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ideas = gatherMediaIdeas(acct, { featured, max: 14 });
  const planText = ideas.length ? buildTradePlanText(ideas) : "No tracked setups with data yet — let a scan run, then refresh.";
  const xLive = ENABLE_TWEETS && xClient;
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  const acctStats = buildAccountStats(acct);
  const acctPost = buildAccountPostText(acct, acctStats);
  const hasCurve = (acct.dashboard.portfolioHistory || []).filter(p => p && typeof p.value === "number").length >= 2;
  const acctColor = acctStats.allTimePct >= 0 ? "#00a843" : "#e8473f";

  const recaps = gatherClosedTrades(acct, 12);
  const recapCards = recaps.map((t, idx) => {
    const win = (t.pnlDollar || 0) >= 0;
    const pct = Math.round((t.pnlPct || 0) * 100);
    const c = win ? "#00a843" : "#e8473f";
    const key = closedTradeKey(t);
    const keyAttr = encodeURIComponent(key);
    const thesis = (t.claudeReasoning || t.claudeSuggestion || "").replace(/\s+/g, " ").trim();
    const sigs = (t.topSignals || []).join(" · ");
    return `<div class="mcard" id="recap-${idx}">
      <div class="mhead">
        <span><a href="/ticker/${t.ticker}?a=${acct.id}" style="font-weight:800;font-size:16px;color:#1c1d22;text-decoration:none">$${t.ticker}</a>
          <span class="pill" style="background:${c}1a;color:${c};border:1px solid ${c}40">${win ? "+" : ""}${pct}% · ${t.type.toUpperCase()} $${t.strike}</span></span>
        <span class="muted" style="font-size:11px">${t.openDate || "?"} → ${t.closeDate || "?"} · $${(+t.entryPremium).toFixed(2)} → $${(+t.closePremium).toFixed(2)}</span>
      </div>
      <img class="mchart" src="/media/recap-chart?a=${acct.id}&key=${keyAttr}" alt="$${t.ticker} recap" loading="lazy"/>
      ${(thesis || sigs) ? `<details style="margin-bottom:8px"><summary class="muted" style="cursor:pointer;font-size:11px">What I saw at entry</summary>
        <div style="font-size:11px;color:#4a4b52;line-height:1.5;margin-top:6px">
          ${thesis ? `<div>${esc(thesis)}</div>` : ""}
          ${sigs ? `<div style="margin-top:4px;color:#138f86">Signals: ${esc(sigs)}</div>` : ""}
          <div style="margin-top:4px;color:#6b7280">Exit: ${esc(t.reason || "—")}</div>
        </div></details>` : ""}
      <textarea id="cap-recap-${idx}" class="mcap" rows="6">${esc(buildTradeRecapText(t))}</textarea>
      <div class="mbtns">
        ${spectator ? "" : `<button type="button" class="ai" onclick="aiRewrite('recap','${idx}','${keyAttr}')">✨ AI rewrite</button>`}
        <button type="button" onclick="copyEl('cap-recap-${idx}')">📋 Copy text</button>
        <a class="btn" href="/media/recap-chart?a=${acct.id}&key=${keyAttr}&dl=1" download="${t.ticker}-recap.png">⬇ Download chart</a>
        ${spectator ? "" : `<button type="button" class="primary" onclick="postRecap('${idx}','${keyAttr}')">${xLive ? "𝕏 Post recap" : "𝕏 Post (dry-run)"}</button>`}
      </div>
    </div>`;
  }).join("");

  const cards = ideas.map(i => {
    const dirColor = i.isCall ? "#00a843" : "#e8473f";
    const chartUrl = `/media/chart/${i.ticker}?a=${acct.id}`;
    return `<div class="mcard" id="card-${i.ticker}">
      <div class="mhead">
        <span><a href="/ticker/${i.ticker}?a=${acct.id}" style="font-weight:800;font-size:16px;color:#1c1d22;text-decoration:none">$${i.ticker}</a>
          <span class="pill" style="background:${dirColor}1a;color:${dirColor};border:1px solid ${dirColor}40">${i.isCall ? "CALL" : "PUT"} · ${i.contract}</span></span>
        <span class="muted" style="font-size:11px">trigger $${fmtNum(i.trigger)} · target $${fmtNum(i.target)} · score ${i.score}</span>
      </div>
      <img class="mchart" src="${chartUrl}" alt="$${i.ticker} chart" loading="lazy"/>
      <textarea id="cap-${i.ticker}" class="mcap" rows="6">${esc(i.caption)}</textarea>
      <div class="mbtns">
        ${spectator ? "" : `<button type="button" class="ai" onclick="aiRewrite('ticker','${i.ticker}')">✨ AI rewrite</button>`}
        <button type="button" onclick="copyEl('cap-${i.ticker}')">📋 Copy text</button>
        <a class="btn" href="${chartUrl}&dl=1" download="${i.ticker}-chart.png">⬇ Download chart</a>
        ${spectator ? "" : `<button type="button" class="primary" onclick="postMedia('${i.ticker}')">${xLive ? "𝕏 Post to X" : "𝕏 Post (dry-run)"}</button>`}
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6f7f9">
<title>Media Studio — Swing Trader</title>
<style>
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,system-ui,sans-serif;margin:0 auto;padding:24px;max-width:1100px}
  a.back{color:#6a4df4;text-decoration:none;font-size:13px}
  h1{font-size:22px;margin:6px 0 2px}
  .muted{color:#6b7280}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:16px;margin-top:16px}
  textarea{width:100%;box-sizing:border-box;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:8px;color:#1c1d22;padding:10px;font-family:inherit;font-size:13px;line-height:1.5;resize:vertical}
  button,.btn{padding:8px 14px;background:#eef1f4;color:#1c1d22;border:1px solid #d4d8e0;border-radius:8px;font-weight:600;cursor:pointer;font-size:12px;text-decoration:none;display:inline-block}
  button.primary{background:#1c1d22;color:#fff;border-color:#1c1d22}
  button.ai{background:#6a4df4;color:#fff;border-color:#6a4df4}
  button:hover,.btn:hover{filter:brightness(.97)}
  button:disabled{opacity:.6;cursor:wait}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px;margin-top:16px}
  @media(max-width:600px){.grid{grid-template-columns:1fr}body{padding:14px}textarea,button,.btn{font-size:16px}}
  .mcard{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:14px}
  .mhead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .mchart{width:100%;border:1px solid #eceef1;border-radius:8px;display:block;margin-bottom:10px}
  .mcap{margin-bottom:10px}
  .mbtns{display:flex;gap:8px;flex-wrap:wrap}
  .pill{font-size:10px;font-weight:700;border-radius:999px;padding:2px 8px;margin-left:6px}
  #toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c1d22;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
  #toast.show{opacity:1}
</style></head><body>
  <a class="back" href="/?a=${acct.id}">&larr; Back to dashboard</a>
  <h1>📣 Media Studio</h1>
  <div class="muted" style="font-size:13px">${dateStr} · ${acct.name} · ${ideas.length} setup${ideas.length === 1 ? "" : "s"} tracked.
    Posting is <b style="color:${xLive ? "#00a843" : "#b07400"}">${xLive ? "LIVE (X connected)" : "dry-run (set X_API keys + ENABLE_TWEETS=true)"}</b>. Charts include trigger + target projections.</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <h2 style="margin:0;font-size:15px">📈 Account Update — flex the growth</h2>
      <div style="display:flex;gap:8px">
        ${spectator ? "" : `<button type="button" class="ai" onclick="aiRewrite('account')">✨ AI rewrite</button>`}
        <button type="button" onclick="copyEl('acct-post')">📋 Copy</button>
        ${hasCurve ? `<a class="btn" href="/media/account-chart?a=${acct.id}&dl=1" download="${acct.id}-growth.png">⬇ Download chart</a>` : ""}
        ${spectator ? "" : `<button type="button" class="primary" onclick="postAccount()">${xLive ? "𝕏 Post update" : "𝕏 Post (dry-run)"}</button>`}
      </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">
      <div><div style="font-size:24px;font-weight:800;color:${acctColor}">${acctStats.allTimePct >= 0 ? "+" : ""}${acctStats.allTimePct.toFixed(1)}%</div><div class="muted" style="font-size:10px;text-transform:uppercase">All-Time</div></div>
      <div><div style="font-size:24px;font-weight:800">$${Math.round(acctStats.pv).toLocaleString()}</div><div class="muted" style="font-size:10px;text-transform:uppercase">Value (from $${Math.round(acctStats.start).toLocaleString()})</div></div>
      ${acctStats.weekPct != null ? `<div><div style="font-size:24px;font-weight:800;color:${acctStats.weekPct >= 0 ? "#00a843" : "#e8473f"}">${acctStats.weekPct >= 0 ? "+" : ""}${acctStats.weekPct.toFixed(1)}%</div><div class="muted" style="font-size:10px;text-transform:uppercase">This Week</div></div>` : ""}
      ${acctStats.total > 0 ? `<div><div style="font-size:24px;font-weight:800">${acctStats.winRate.toFixed(0)}%</div><div class="muted" style="font-size:10px;text-transform:uppercase">Win Rate (${acctStats.wins}/${acctStats.total})</div></div>` : ""}
      <div><div style="font-size:24px;font-weight:800">${acctStats.days}</div><div class="muted" style="font-size:10px;text-transform:uppercase">Days · since ${new Date(acctStats.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div></div>
    </div>
    ${hasCurve ? `<img class="mchart" src="/media/account-chart?a=${acct.id}" alt="${acct.name} growth"/>` : '<div class="muted" style="font-size:12px;margin-bottom:10px">Equity curve appears once a few portfolio-value points are recorded.</div>'}
    <textarea id="acct-post" rows="9">${esc(acctPost)}</textarea>
    <div class="muted" style="font-size:11px;margin-top:6px">Growth, win rate, top winners & start date — auto-drafted. Edit before posting.</div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <h2 style="margin:0;font-size:15px">Weekly / Daily Trade Plan</h2>
      <div style="display:flex;gap:8px">
        ${spectator ? "" : `<button type="button" class="ai" onclick="aiRewrite('plan')">✨ AI rewrite</button>`}
        <button type="button" onclick="copyEl('plan')">📋 Copy plan</button>
        ${spectator ? "" : `<button type="button" class="primary" onclick="postPlan()">${xLive ? "𝕏 Post plan" : "𝕏 Post plan (dry-run)"}</button>`}
      </div>
    </div>
    <textarea id="plan" rows="${Math.min(20, 4 + ideas.length * 2)}">${esc(planText)}</textarea>
    <div class="muted" style="font-size:11px;margin-top:6px">Auto-drafted from live technicals. Edit freely before posting — this never auto-posts.</div>
  </div>

  <div class="grid">${cards || '<div class="muted">No setups to share yet.</div>'}</div>

  <h2 style="margin:28px 0 0;font-size:15px">🧾 Trade Recaps — what I saw vs. what it did</h2>
  <div class="muted" style="font-size:12px">Closed trades with the entry read and the actual result. Chart marks entry (IN) and exit (OUT).</div>
  <div class="grid">${recapCards || '<div class="muted">No closed trades to recap yet.</div>'}</div>

  <div id="toast"></div>
<script>
  function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200);}
  function copyEl(id){var el=document.getElementById(id);el.select();navigator.clipboard.writeText(el.value).then(function(){toast('Copied to clipboard');},function(){document.execCommand('copy');toast('Copied');});}
  function postMedia(ticker){
    var text=document.getElementById('cap-'+ticker).value;
    fetch('/api/media/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({a:'${acct.id}',ticker:ticker,text:text,chart:true})})
      .then(r=>r.json()).then(d=>toast(d.message||(d.ok?'Posted':'Failed'))).catch(e=>toast('Error: '+e.message));
  }
  function postPlan(){
    var text=document.getElementById('plan').value;
    fetch('/api/media/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({a:'${acct.id}',text:text,chart:false})})
      .then(r=>r.json()).then(d=>toast(d.message||(d.ok?'Posted':'Failed'))).catch(e=>toast('Error: '+e.message));
  }
  function postAccount(){
    var text=document.getElementById('acct-post').value;
    fetch('/api/media/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({a:'${acct.id}',text:text,account:true})})
      .then(r=>r.json()).then(d=>toast(d.message||(d.ok?'Posted':'Failed'))).catch(e=>toast('Error: '+e.message));
  }
  function postRecap(idx,key){
    var text=document.getElementById('cap-recap-'+idx).value;
    fetch('/api/media/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({a:'${acct.id}',text:text,recapKey:decodeURIComponent(key)})})
      .then(r=>r.json()).then(d=>toast(d.message||(d.ok?'Posted':'Failed'))).catch(e=>toast('Error: '+e.message));
  }
  function aiRewrite(kind,ticker,key){
    var id=kind==='account'?'acct-post':kind==='plan'?'plan':kind==='recap'?'cap-recap-'+ticker:'cap-'+ticker;
    var el=document.getElementById(id);if(!el)return;
    var prev=el.value;el.value='✨ writing…';el.disabled=true;
    var payload={a:'${acct.id}',kind:kind,ticker:(kind==='recap'?'':ticker)||''};
    if(kind==='recap')payload.key=decodeURIComponent(key);
    fetch('/api/media/rewrite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(r=>r.json()).then(function(d){el.disabled=false;if(d.ok&&d.text){el.value=d.text;toast('Rewritten ✨');}else{el.value=prev;toast(d.message||'Rewrite failed');}})
      .catch(function(e){el.disabled=false;el.value=prev;toast('Error: '+e.message);});
  }
  ${featured ? `var f=document.getElementById('card-${featured}');if(f)f.scrollIntoView({behavior:'smooth',block:'center'});` : ""}
</script>
</body></html>`;
}

let lastSimConfig = null;

function simulatorPageHTML(simId) {
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  if (simId === "new") {
    // Use last config if available, otherwise defaults
    const c = lastSimConfig || {};
    const v = {
      startDate: c.startDate || sixMonthsAgo,
      endDate: c.endDate || today,
      startingCash: c.startingCash || 200,
      baseRiskPct: c.baseRiskPct != null ? Math.round(c.baseRiskPct * 100) : 15,
      minSetupQuality: c.minSetupQuality ?? 50,
      profitTarget: c.profitTarget != null ? Math.round(c.profitTarget * 100) : 40,
      stopLoss: c.stopLoss != null ? Math.round(c.stopLoss * 100) : -35,
      bullEntry: c.bullEntry || 65,
      bearEntry: c.bearEntry || 35,
      maxPositions: c.maxPositions != null ? c.maxPositions : "",
      tickers: c.tickers ? c.tickers.join(",") : "SPY,QQQ,AAPL,NVDA,TSLA,MSFT,META,AMZN,GOOGL,AMD",
      speedMs: c.speedMs || 3000,
      useClaude: c.useClaude || false,
    };
    const speedLabel = v.speedMs >= 8000 ? "Slow" : v.speedMs >= 2000 ? "Normal" : v.speedMs >= 400 ? "Fast" : "Turbo";
    const speedDisp = v.speedMs >= 1000 ? (v.speedMs / 1000).toFixed(1) + "s" : v.speedMs + "ms";

    // Build previous sim list
    const prevSims = [...simulations.values()].reverse().slice(0, 10);
    const prevSimsHTML = prevSims.length > 0 ? `<div class="card" style="margin-top:16px;max-width:600px;margin-left:auto;margin-right:auto">
  <h2>Previous Simulations</h2>
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <tr><th style="text-align:left;padding:4px 8px;color:#6b7280;font-size:10px">ID</th><th style="text-align:left;padding:4px 8px;color:#6b7280;font-size:10px">Dates</th><th style="text-align:left;padding:4px 8px;color:#6b7280;font-size:10px">Status</th><th style="text-align:right;padding:4px 8px;color:#6b7280;font-size:10px">Return</th><th style="text-align:left;padding:4px 8px;color:#6b7280;font-size:10px"></th></tr>
    ${prevSims.map(s => {
      const hist = s.portfolioHistory;
      const startVal = s.config.startingCash || 200;
      const endVal = hist.length > 0 ? hist[hist.length - 1].value : startVal;
      const ret = ((endVal - startVal) / startVal * 100).toFixed(1);
      const retColor = ret >= 0 ? "#00a843" : "#e8473f";
      const statusColor = s.status === "done" ? "#00a843" : s.status === "running" ? "#6a4df4" : s.status === "paused" ? "#b07400" : "#e8473f";
      return `<tr style="border-bottom:1px solid #e3e6ea">
        <td style="padding:6px 8px">#${s.id}</td>
        <td style="padding:6px 8px;color:#6b7280">${s.startDate} — ${s.endDate}</td>
        <td style="padding:6px 8px;color:${statusColor}">${s.status.toUpperCase()}</td>
        <td style="padding:6px 8px;text-align:right;color:${retColor}">${ret >= 0 ? "+" : ""}${ret}%</td>
        <td style="padding:6px 8px"><a href="/?sim=${s.id}" style="color:#138f86">View</a> &nbsp;<a href="#" onclick="reuse(${s.id});return false" style="color:#6a4df4">Reuse</a></td>
      </tr>`;
    }).join("")}
  </table>
</div>` : "";

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Historical Simulator — Swing Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#f6f7f9">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;padding:20px}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:600px){body{padding:12px}input,select,textarea,button{font-size:16px}}
  h1{color:#6a4df4;font-size:20px;margin-bottom:4px}
  .sub{color:#6b7280;font-size:11px;margin-bottom:20px}
  .card{background:#ffffff;border:1px solid #e3e6ea;border-radius:8px;padding:24px;max-width:600px;margin:0 auto}
  .card h2{color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px}
  label{display:block;margin-bottom:6px;font-size:12px;color:#6b7280}
  input,select{width:100%;padding:8px 12px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;font-family:inherit;font-size:12px;margin-bottom:14px;box-sizing:border-box}
  input[type=range]{padding:4px 0}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btn{width:100%;padding:12px;background:#6a4df4;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;font-size:14px;margin-top:8px}
  .btn:hover{background:#6a4df4}
  a{color:#138f86;text-decoration:none}
  .warn{color:#b07400;font-size:11px;margin-top:-8px;margin-bottom:12px}
  .tab-bar{background:#f6f7f9;border-bottom:1px solid #e3e6ea;padding:6px 12px 0;margin:-20px -20px 20px}
  .tab-row{display:flex;flex-wrap:wrap;gap:4px;align-items:stretch}
  .acct-tab{display:flex;flex-direction:column;align-items:center;padding:8px 16px 6px;background:#ffffff;border:1px solid #e3e6ea;border-bottom:none;border-radius:8px 8px 0 0;color:#6b7280;text-decoration:none;font-size:11px;min-width:100px;transition:all .2s}
  .acct-tab:hover{background:#eef1f4;color:#1c1d22}
  .acct-tab.active{background:#eef1f4;border-color:#6a4df4;color:#1c1d22;border-bottom:2px solid #6a4df4}
  .acct-tab.new-tab{border-style:dashed;color:#8a909b;justify-content:center}
  table th{text-align:left}
</style></head><body>
<div class="tab-bar"><div class="tab-row">
  ${[...accounts].map(([id, a]) => `<a href="/?a=${id}" class="acct-tab"><span style="font-weight:700;font-size:12px">${a.name}</span></a>`).join("")}
  <a href="/?sim=new" class="acct-tab active" style="border-color:#6a4df440;color:#6a4df4">&#x1F9EA; Simulator</a>
</div></div>
<h1>Historical Trading Simulator</h1>
<div class="sub">Backtest the bot's full analysis engine on historical data with live visualization${lastSimConfig ? ' &nbsp;|&nbsp; <span style="color:#6a4df4">Config restored from last run</span>' : ''}</div>
<div class="card">
  <h2>Simulation Config</h2>
  <form method="POST" action="/api/sim/start" id="sim-form">
    <div class="row">
      <div><label>Start Date</label><input type="date" name="startDate" value="${v.startDate}"></div>
      <div><label>End Date</label><input type="date" name="endDate" value="${v.endDate}"></div>
    </div>
    <label>Starting Cash ($)</label>
    <input type="number" name="startingCash" value="${v.startingCash}">
    <div class="row">
      <div><label>Max Premium Allocation (%)</label><input type="number" name="baseRiskPct" value="${v.baseRiskPct}" step="1"></div>
      <div><label>Min Setup Quality (0-100)</label><input type="number" name="minSetupQuality" value="${v.minSetupQuality}" min="0" max="100"></div>
    </div>
    <div class="row">
      <div><label>Profit Target (%)</label><input type="number" name="profitTarget" value="${v.profitTarget}" step="1"></div>
      <div><label>Stop Loss (%)</label><input type="number" name="stopLoss" value="${v.stopLoss}" step="1"></div>
    </div>
    <div class="row">
      <div><label>Bull Entry Threshold</label><input type="number" name="bullEntry" value="${v.bullEntry}" min="50" max="90"></div>
      <div><label>Bear Entry Threshold</label><input type="number" name="bearEntry" value="${v.bearEntry}" min="10" max="50"></div>
    </div>
    <label>Max Concurrent Positions</label>
    <input type="number" name="maxPositions" value="${v.maxPositions}" min="1" max="20">
    <label>Tickers (comma-separated)</label>
    <input type="text" name="tickers" value="${v.tickers}">
    <label>Speed: <span id="speed-label">${speedLabel} (${speedDisp}/day)</span></label>
    <input type="range" name="speedMs" min="100" max="12000" value="${v.speedMs}" step="100" oninput="const v=+this.value;const l=v>=8000?'Slow':v>=2000?'Normal':v>=400?'Fast':'Turbo';document.getElementById('speed-label').textContent=l+' ('+(v>=1000?(v/1000).toFixed(1)+'s':v+'ms')+'/day)'">
    <label style="margin-top:4px"><input type="checkbox" name="useClaude" value="true" style="width:auto;margin-right:8px"${v.useClaude ? " checked" : ""}>Enable Claude validation (uses API credits)</label>
    <div class="warn">Each entry check costs ~$0.001 in Claude API credits</div>
    <button type="submit" class="btn">Start Simulation</button>
  </form>
</div>
${prevSimsHTML}
<script>
const simConfigs = ${JSON.stringify(Object.fromEntries([...simulations].map(([id, s]) => [id, s.config])))};
function reuse(id) {
  const c = simConfigs[id];
  if (!c) return;
  const f = document.getElementById('sim-form');
  if (c.startDate) f.startDate.value = c.startDate;
  if (c.endDate) f.endDate.value = c.endDate;
  if (c.startingCash) f.startingCash.value = c.startingCash;
  if (c.baseRiskPct != null) f.baseRiskPct.value = Math.round(c.baseRiskPct * 100);
  if (c.minSetupQuality != null) f.minSetupQuality.value = c.minSetupQuality;
  if (c.profitTarget != null) f.profitTarget.value = Math.round(c.profitTarget * 100);
  if (c.stopLoss != null) f.stopLoss.value = Math.round(c.stopLoss * 100);
  if (c.bullEntry) f.bullEntry.value = c.bullEntry;
  if (c.bearEntry) f.bearEntry.value = c.bearEntry;
  if (c.maxPositions) f.maxPositions.value = c.maxPositions;
  if (c.tickers) f.tickers.value = Array.isArray(c.tickers) ? c.tickers.join(',') : c.tickers;
  if (c.speedMs) { f.speedMs.value = c.speedMs; f.speedMs.dispatchEvent(new Event('input')); }
  if (c.useClaude) f.useClaude.checked = c.useClaude;
  window.scrollTo({top: 0, behavior: 'smooth'});
}
</script>
</body></html>`;
  }

  // Running / done sim page
  const sim = simulations.get(parseInt(simId));
  if (!sim) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sim Not Found</title>
<style>body{background:#f6f7f9;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:40px;text-align:center}</style>
</head><body><h1 style="color:#e8473f">Simulation not found</h1><a href="/?sim=new" style="color:#138f86">Start a new simulation</a></body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Sim #${sim.id} — Swing Trader</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#f6f7f9">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f6f7f9;color:#23242a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;padding:20px}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:600px){body{padding:12px}input,select,textarea,button{font-size:16px}}
  h1{color:#6a4df4;font-size:20px;margin-bottom:4px}
  .sub{color:#6b7280;font-size:11px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px}
  @media(max-width:900px){.grid{grid-template-columns:1fr 1fr}}
  .card{background:#ffffff;border:1px solid #e3e6ea;border-radius:8px;padding:16px;margin-bottom:16px}
  .card h2{color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .stat{display:inline-block;margin-right:20px;margin-bottom:8px}
  .stat .val{font-size:22px;font-weight:800;color:#00a843}
  .stat .lbl{font-size:10px;color:#6b7280;text-transform:uppercase}
  .stat.neg .val{color:#e8473f}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;color:#6b7280;font-size:10px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #e3e6ea}
  td{padding:6px 8px;border-bottom:1px solid #eceef1}
  a{color:#138f86;text-decoration:none}
  .progress{background:#e3e6ea;border-radius:4px;height:24px;margin:8px 0;overflow:hidden;position:relative}
  .progress-bar{height:100%;background:#6a4df4;border-radius:4px;transition:width .3s}
  .progress-text{position:absolute;top:0;left:0;right:0;height:100%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#1c1d22}
  .controls{display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
  .ctrl-btn{padding:6px 16px;border:1px solid #d4d8e0;border-radius:4px;background:#ffffff;color:#6b7280;cursor:pointer;font-size:12px;font-family:inherit}
  .ctrl-btn:hover{background:#e3e6ea;color:#1c1d22}
  .ctrl-btn.active{border-color:#6a4df4;color:#6a4df4}
  .summary-card{background:#ffffff;border:2px solid #6a4df440;border-radius:8px;padding:20px;margin-bottom:16px;display:none}
  .summary-card h2{color:#6a4df4}
</style></head><body>
<h1><a href="/?sim=new" style="color:#6a4df4">&#x2190; New Sim</a> &nbsp; Sim #${sim.id}</h1>
<div class="sub">${sim.startDate} to ${sim.endDate} &nbsp;|&nbsp; ${sim.tickers.join(", ")} &nbsp;|&nbsp; $${sim.config.startingCash || 200} starting cash</div>

<div class="progress"><div class="progress-bar" id="prog-bar" style="width:0%"></div><div class="progress-text" id="prog-text">Loading...</div></div>

<div class="controls">
  <button class="ctrl-btn" id="btn-pause" onclick="simControl('pause')">Pause</button>
  <button class="ctrl-btn" id="btn-resume" onclick="simControl('resume')" style="display:none">Resume</button>
  <button class="ctrl-btn" onclick="simControl('cancel')" style="border-color:#e8473f30;color:#e8473f">Cancel</button>
  <span style="color:#6b7280;font-size:11px;margin-left:8px">Speed:</span>
  <button class="ctrl-btn speed" onclick="setSpeed(12000)">Slow</button>
  <button class="ctrl-btn speed active" onclick="setSpeed(3000)">Normal</button>
  <button class="ctrl-btn speed" onclick="setSpeed(500)">Fast</button>
  <button class="ctrl-btn speed" onclick="setSpeed(100)">Turbo</button>
</div>

<div class="grid">
  <div class="stat"><div class="val" id="s-pv">$${sim.config.startingCash || 200}</div><div class="lbl">Portfolio Value</div></div>
  <div class="stat"><div class="val" id="s-pnl">0%</div><div class="lbl">P&L</div></div>
  <div class="stat"><div class="val" id="s-cash">$${sim.config.startingCash || 200}</div><div class="lbl">Cash</div></div>
  <div class="stat"><div class="val" id="s-pos">0</div><div class="lbl">Open Positions</div></div>
  <div class="stat"><div class="val" id="s-regime">—</div><div class="lbl">Regime</div></div>
  <div class="stat"><div class="val" id="s-trades">0</div><div class="lbl">Total Trades</div></div>
</div>

<div class="card">
  <h2>Portfolio Value Over Time</h2>
  <svg id="chart" viewBox="0 0 900 200" style="width:100%;height:200px;display:block"></svg>
</div>

<div class="summary-card" id="summary-card">
  <h2>Simulation Complete</h2>
  <div style="margin-top:12px" id="summary-stats"></div>
</div>

<div class="card">
  <h2>Open Positions</h2>
  <table><thead><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Qty</th><th>P&L</th></tr></thead><tbody id="pos-table"><tr><td colspan="5" style="opacity:.5">No open positions</td></tr></tbody></table>
</div>

<div class="card">
  <h2>Trade History</h2>
  <div style="max-height:300px;overflow-y:auto">
  <table><thead><tr><th>Date</th><th>Action</th><th>Ticker</th><th>Type</th><th>Strike</th><th>Qty</th><th>P&L</th><th>Reason</th></tr></thead><tbody id="trade-table"><tr><td colspan="8" style="opacity:.5">No trades yet</td></tr></tbody></table>
  </div>
</div>

<script>
const simId = ${sim.id};
const startVal = ${sim.config.startingCash || 200};
const chartData = [];
let paused = false;

function simControl(action) {
  fetch('/api/sim/control?id='+simId+'&action='+action, {method:'POST'});
  if (action==='pause'){document.getElementById('btn-pause').style.display='none';document.getElementById('btn-resume').style.display='';}
  if (action==='resume'){document.getElementById('btn-resume').style.display='none';document.getElementById('btn-pause').style.display='';}
}
function setSpeed(ms) {
  fetch('/api/sim/control?id='+simId+'&action=speed&value='+ms, {method:'POST'});
  document.querySelectorAll('.speed').forEach(b=>{b.classList.remove('active')});
  event.target.classList.add('active');
}

const es = new EventSource('/api/sim/stream?id='+simId);
es.onmessage = function(e) {
  const d = JSON.parse(e.data);
  if (d.type==='tick') {
    const pnl = ((d.pv - startVal)/startVal*100).toFixed(1);
    document.getElementById('s-pv').textContent = '$'+d.pv.toFixed(0);
    document.getElementById('s-pv').style.color = d.pv>=startVal?'#00a843':'#e8473f';
    document.getElementById('s-pnl').textContent = (pnl>=0?'+':'')+pnl+'%';
    document.getElementById('s-pnl').style.color = pnl>=0?'#00a843':'#e8473f';
    document.getElementById('s-cash').textContent = '$'+d.cash.toFixed(0);
    document.getElementById('s-pos').textContent = d.positions;
    document.getElementById('s-regime').textContent = d.regime.toUpperCase();
    document.getElementById('s-regime').style.color = d.regime==='risk-on'?'#00a843':d.regime==='cautious'?'#b07400':'#e8473f';
    document.getElementById('s-trades').textContent = d.totalTrades;
    const pct = (d.day/d.totalDays*100).toFixed(1);
    document.getElementById('prog-bar').style.width = pct+'%';
    document.getElementById('prog-text').textContent = 'Day '+d.day+'/'+d.totalDays+' ('+d.date+') — '+pct+'%';
    chartData.push({x:d.day,y:d.pv});
    updateChart();
    // positions
    if (d.openPositions && d.openPositions.length>0) {
      document.getElementById('pos-table').innerHTML = d.openPositions.map(p=>'<tr><td>'+p.ticker+'</td><td>'+p.type.toUpperCase()+'</td><td>$'+p.strike+'</td><td>'+p.qty+'</td><td style="color:'+(p.pnlPct>=0?'#00a843':'#e8473f')+'">'+(p.pnlPct*100).toFixed(1)+'%</td></tr>').join('');
    } else {
      document.getElementById('pos-table').innerHTML = '<tr><td colspan="5" style="opacity:.5">No open positions</td></tr>';
    }
  }
  if (d.type==='done') {
    document.getElementById('prog-bar').style.width = '100%';
    document.getElementById('prog-bar').style.background = '#00a843';
    document.getElementById('prog-text').textContent = 'Simulation Complete';
    const sc = document.getElementById('summary-card');
    sc.style.display = 'block';
    const color = d.totalReturn>=0?'#00a843':'#e8473f';
    document.getElementById('summary-stats').innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:24px">'+
      '<div class="stat"><div class="val" style="color:'+color+'">'+( d.totalReturn>=0?'+':'')+d.totalReturn+'%</div><div class="lbl">Total Return</div></div>'+
      '<div class="stat"><div class="val">$'+d.finalValue.toFixed(0)+'</div><div class="lbl">Final Value</div></div>'+
      '<div class="stat"><div class="val">'+d.winRate+'%</div><div class="lbl">Win Rate</div></div>'+
      '<div class="stat"><div class="val" style="color:#e8473f">-'+d.maxDrawdown+'%</div><div class="lbl">Max Drawdown</div></div>'+
      '<div class="stat"><div class="val">'+d.sharpe+'</div><div class="lbl">Sharpe Ratio</div></div>'+
      '<div class="stat"><div class="val" style="color:#00a843">+'+d.avgWin+'%</div><div class="lbl">Avg Win</div></div>'+
      '<div class="stat"><div class="val" style="color:#e8473f">'+d.avgLoss+'%</div><div class="lbl">Avg Loss</div></div>'+
      '<div class="stat"><div class="val">'+d.totalTrades+'</div><div class="lbl">Total Trades</div></div>'+
      '</div>';
    es.close();
  }
  if (d.type==='trade') {
    const tbl = document.getElementById('trade-table');
    if (tbl.querySelector('td[colspan]')) tbl.innerHTML='';
    const color = d.pnlDollar!=null?(d.pnlDollar>=0?'#00a843':'#e8473f'):'#6b7280';
    const pnlStr = d.pnlPct!=null?((d.pnlPct*100).toFixed(1)+'%'):'—';
    tbl.insertAdjacentHTML('afterbegin','<tr><td>'+d.date+'</td><td>'+(d.action||'')+'</td><td>'+d.ticker+'</td><td>'+(d.direction||'').toUpperCase()+'</td><td>$'+d.strike+'</td><td>'+d.qty+'</td><td style="color:'+color+'">'+pnlStr+'</td><td>'+(d.reason||'—')+'</td></tr>');
  }
};
es.onerror = function() { document.getElementById('prog-text').textContent = 'Connection lost — refresh to reconnect'; };

function updateChart() {
  if (chartData.length < 2) return;
  const W=900,H=200,P=40;
  const vals = chartData.map(d=>d.y);
  const mn = Math.min(...vals,startVal)*0.98, mx = Math.max(...vals,startVal*1.1)*1.02;
  const rng = mx-mn||1;
  const xOf = i => P+(i/(chartData.length-1))*(W-P*2);
  const yOf = v => H-P/2-(v-mn)/rng*(H-P);
  const pts = chartData.map((d,i)=>xOf(i).toFixed(1)+','+yOf(d.y).toFixed(1)).join(' ');
  const color = vals[vals.length-1]>=startVal?'#00a843':'#e8473f';
  const baseY = yOf(startVal).toFixed(1);
  document.getElementById('chart').innerHTML =
    '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity="0.25"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'+
    '<line x1="'+P+'" y1="'+baseY+'" x2="'+(W-P)+'" y2="'+baseY+'" stroke="#0000001c" stroke-width="1" stroke-dasharray="4,4"/>'+
    '<text x="'+(P-4)+'" y="'+(+baseY+4)+'" fill="#00000033" font-size="10" text-anchor="end" font-family="monospace">$'+startVal+'</text>'+
    '<polygon points="'+pts+' '+xOf(chartData.length-1).toFixed(1)+','+(H-P/2)+' '+xOf(0).toFixed(1)+','+(H-P/2)+'" fill="url(#sg)"/>'+
    '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round"/>'+
    '<circle cx="'+xOf(chartData.length-1).toFixed(1)+'" cy="'+yOf(vals[vals.length-1]).toFixed(1)+'" r="4" fill="'+color+'"/>'+
    '<text x="'+(W-P)+'" y="'+(H-6)+'" fill="#00000033" font-size="9" text-anchor="end" font-family="monospace">Day '+chartData.length+'</text>';
}
</script>
</body></html>`;
}

// ─── Robinhood OAuth2 PKCE In-App Auth ───

const RH_OAUTH_META_URL = "https://agent.robinhood.com/.well-known/oauth-authorization-server";
const RH_REGISTER_URL = "https://agent.robinhood.com/oauth/trading/register";
let rhOAuthPending = null; // stores { codeVerifier, state, clientId, redirectUri, tokenEndpoint } during auth flow

function startDashboard(defaultAcct, apiKey) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ─── Server-side auth gate ───
    // Everything (dashboards, admin pages, AND all /api endpoints) sits behind one password so the
    // public Render URL can't be used to read the portfolio or place/cancel orders. This replaces
    // the old client-side PIN (which anyone could bypass).
    if (pathname === "/login") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
          const params = new URLSearchParams(body);
          if (params.get("mode") === "spectator") {
            res.writeHead(302, {
              "Set-Cookie": `${AUTH_COOKIE}=${spectatorToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
              Location: "/",
            });
            res.end();
            return;
          }
          const pw = params.get("password") || "";
          if (pw === DASHBOARD_PASSWORD) {
            res.writeHead(302, {
              "Set-Cookie": `${AUTH_COOKIE}=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
              Location: "/",
            });
            res.end();
          } else {
            res.writeHead(401, { "Content-Type": "text/html" });
            res.end(loginPageHTML("Incorrect password — try again."));
          }
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loginPageHTML());
      return;
    }
    if (pathname === "/logout") {
      res.writeHead(302, { "Set-Cookie": `${AUTH_COOKIE}=; Path=/; Max-Age=0`, Location: "/login" });
      res.end();
      return;
    }
    if (!isAuthed(req) && pathname !== "/favicon.ico") {
      const wantsHtml = (req.headers.accept || "").includes("text/html") && req.method === "GET";
      if (wantsHtml) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(loginPageHTML());
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return;
    }
    const role = authRole(req);
    const spectator = role === "spectator";
    if (spectator && req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "spectator_mode_read_only" }));
      return;
    }

    // Resolve active account from ?a= param
    const acctId = url.searchParams.get("a") || accounts.keys().next().value;
    const activeAcct = accounts.get(acctId) || accounts.values().next().value;
    const state = activeAcct.state;
    const dashboard = activeAcct.dashboard;

    // ─── Account CRUD API ───

    if (req.method === "POST" && pathname === "/api/accounts") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const name = params.get("name") || `Account ${accounts.size + 1}`;
        const requestedId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `acct-${Date.now()}`;
        // Reserved ids are authorization principals for the two process-global live clients. A
        // user-created account with the same display name still receives a distinct paper id.
        const id = isCanonicalLiveAccount(requestedId) ? `${requestedId}-paper` : requestedId;
        if (accounts.has(id)) { res.writeHead(302, { Location: `/?a=${id}` }); res.end(); return; }
        const config = {
          startingCash: parseFloat(params.get("startingCash")) || 200,
          goal: parseFloat(params.get("goal")) || 200000,
          baseRiskPct: (parseFloat(params.get("baseRiskPct")) || 15) / 100,
          profitTarget: (parseFloat(params.get("profitTarget")) || 40) / 100,
          stopLoss: (parseFloat(params.get("stopLoss")) || -35) / 100,
          bullEntry: 65, bearEntry: 35, trim1Pct: 0.25, trim2Pct: 0.50,
          minSetupQuality: parseInt(params.get("minSetupQuality")) || 50,
          customPromptSuffix: params.get("customPromptSuffix") || "",
          // User-created runtimes are always simulations. Process-global live credentials are owned
          // exclusively by the protected `robinhood` and `tradier` canonical accounts.
          broker: "paper",
          useCashReserve: params.get("useCashReserve") === "on" || params.get("useCashReserve") === "true",
          autoExecute: false,
          tradeWhenClosed: params.get("tradeWhenClosed") === "on" || params.get("tradeWhenClosed") === "true",
          marginZeroCashSpendLimit: Math.max(0, parseFloat(params.get("marginZeroCashSpendLimit")) || DEFAULT_CONFIG.marginZeroCashSpendLimit),
          marginMaxDebt: Math.max(0, parseFloat(params.get("marginMaxDebt")) || DEFAULT_CONFIG.marginMaxDebt),
        };
        const newAcct = createAccountRuntime(id, name, config);
        newAcct.state.apiKey = apiKey;
        accounts.set(id, newAcct);
        saveAccounts();
        console.log(`  [${id}] Created account: ${name}`);
        res.writeHead(302, { Location: `/?a=${id}` });
        res.end();
      });
      return;
    }

    const pauseMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/pause$/);
    if (req.method === "POST" && pauseMatch) {
      const id = pauseMatch[1];
      const target = accounts.get(id);
      if (target) {
        target.paused = !target.paused;
        target._entryEpoch = (target._entryEpoch || 0) + 1;
        // Pause is an entry kill switch. Protective management remains active; otherwise pressing
        // Pause during a drawdown would silently strand stops and profit-taking orders.
        target.pausedBy = target.paused ? "user" : null;
        if (target.paused) {
          scheduleWorkingEntryCancellation(target, "manual pause");
        }
        saveAccounts();
        console.log(`  [${id}] ${target.paused ? "Paused (new entries/candidates halted; protective exits active)" : "Resumed"}`);
      }
      res.writeHead(302, { Location: `/?a=${id}` });
      res.end();
      return;
    }

    // ─── Risk-halt manual reset ───
    // Explicit manual risk review: re-baseline daily/weekly/high-water references and clear the
    // rolling loss streak/cooldown. This is the only way to override a persistent risk halt.
    const riskResetMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/risk-reset$/);
    if (req.method === "POST" && riskResetMatch) {
      const target = accounts.get(riskResetMatch[1]);
      if (target) {
        const pv = portfolioValue(target.state, target.dashboard?.quotes || {});
        const r = ensureRiskState(target, pv);
        const oldBase = r.dayStartPV;
        if (pv > 0) r.dayStartPV = pv;
        r.haltNotified = null;
        target.state.portfolioRisk = {
          ...(target.state.portfolioRisk || {}),
          weekStartPV: pv > 0 ? pv : target.state.portfolioRisk?.weekStartPV,
          highWaterPV: pv > 0 ? pv : target.state.portfolioRisk?.highWaterPV,
          consecutiveLosses: 0,
          cooldownUntil: 0,
          haltNotified: null,
          manuallyReviewedAt: Date.now(),
        };
        r.consecLosses = 0;
        if (target.paused && target.pausedBy === "risk") {
          target.paused = false;
          target.pausedBy = null;
        }
        log(target, `RISK REVIEW: baselines reset $${(oldBase ?? 0).toFixed(0)} → $${pv.toFixed(0)}, rolling loss streak/cooldown cleared; trading may resume within hard live limits`);
        saveAccounts();
      }
      res.writeHead(302, { Location: `/?a=${riskResetMatch[1]}` });
      res.end();
      return;
    }

    // ─── Live strategy preset toggle ───
    const strategyMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/strategy$/);
    if (req.method === "POST" && strategyMatch) {
      const id = strategyMatch[1];
      const target = accounts.get(id);
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        if (target && !target.learning) {
          const preset = new URLSearchParams(body).get("preset");
          const out = applyStrategyPreset(target, preset);
          if (!out.ok) console.log(`  [${id}] STRATEGY: ${out.reason}`);
        }
        res.writeHead(302, { Location: `/?a=${id}` });
        res.end();
      });
      return;
    }

    // ─── Learning lab controls ───
    const learnResetMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/learning\/reset$/);
    if (req.method === "POST" && learnResetMatch) {
      const parent = accounts.get(learnResetMatch[1]);
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        if (parent && !parent.learning) {
          const cash = parseFloat(new URLSearchParams(body).get("cash"));
          parent.config.learningEnabled = true;
          resetLearningAccounts(parent, cash > 0 ? cash : null);
        }
        res.writeHead(302, { Location: `/?a=${learnResetMatch[1]}` });
        res.end();
      });
      return;
    }

    const learnToggleMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/learning\/toggle$/);
    if (req.method === "POST" && learnToggleMatch) {
      const parent = accounts.get(learnToggleMatch[1]);
      if (parent && !parent.learning) {
        const enabled = parent.config.learningEnabled !== false;
        parent.config.learningEnabled = !enabled;
        if (enabled) {
          removeLearningAccounts(parent); // archives final snapshot, then removes variants
          log(parent, "LEARNING: lab disabled — variants archived and removed");
        } else {
          ensureLearningAccounts(parent);
          log(parent, "LEARNING: lab enabled");
        }
        saveAccounts();
      }
      res.writeHead(302, { Location: `/?a=${learnToggleMatch[1]}` });
      res.end();
      return;
    }

    const delMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/delete$/);
    if (req.method === "POST" && delMatch) {
      const id = delMatch[1];
      if (id !== "default" && !isCanonicalLiveAccount(id) && accounts.has(id)) {
        for (const v of learningVariantsFor(id)) accounts.delete(v.id); // cascade shadow variants
        accounts.delete(id); saveAccounts(); console.log(`  [${id}] Deleted`);
      }
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    const cfgMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/config$/);
    if (req.method === "POST" && cfgMatch) {
      const id = cfgMatch[1];
      const target = accounts.get(id);
      if (!target) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const cfg = target.config;
        if (params.has("baseRiskPct")) {
          cfg.baseRiskPct = parseFloat(params.get("baseRiskPct")) / 100;
          // Settings UI only exposes allocation (%). Keep the governor ceiling aligned so a higher
          // spend is not ignored by a stale maxPositionPct leftover from the old 10% hard rail.
          if (Number.isFinite(cfg.baseRiskPct) && cfg.baseRiskPct > 0) {
            cfg.maxPositionPct = Math.max(Number(cfg.maxPositionPct) || 0, cfg.baseRiskPct);
          }
        }
        if (params.has("profitTarget")) cfg.profitTarget = parseFloat(params.get("profitTarget")) / 100;
        if (params.has("stopLoss")) cfg.stopLoss = parseFloat(params.get("stopLoss")) / 100;
        if (params.has("goal")) cfg.goal = parseFloat(params.get("goal")) || cfg.goal;
        // Capital base (zero-point). Prefer absolute set; optional deposit delta stacks on top.
        if (params.has("startingCash") && params.get("startingCash") !== "") {
          const next = parseFloat(params.get("startingCash"));
          if (!isNaN(next) && next > 0 && Math.abs(next - (cfg.startingCash || 0)) > 0.005) {
            setCapitalBase(target, next, { note: "settings" });
          }
        }
        if (params.has("capitalDeposit") && params.get("capitalDeposit") !== "") {
          const dep = parseFloat(params.get("capitalDeposit"));
          if (!isNaN(dep) && dep !== 0) recordCapitalDeposit(target, dep, { note: "settings deposit field" });
        }
        if (params.get("maxPositions")) cfg.maxPositions = parseInt(params.get("maxPositions")) || null;
        else cfg.maxPositions = null;
        if (params.get("maxTradeSize")) cfg.maxTradeSize = parseFloat(params.get("maxTradeSize")) || null;
        else cfg.maxTradeSize = null;
        if (params.has("marginZeroCashSpendLimit")) cfg.marginZeroCashSpendLimit = Math.max(0, parseFloat(params.get("marginZeroCashSpendLimit")) || 0);
        if (params.has("marginMaxDebt")) cfg.marginMaxDebt = Math.max(0, parseFloat(params.get("marginMaxDebt")) || 0);
        if (params.has("minSetupQuality")) cfg.minSetupQuality = parseInt(params.get("minSetupQuality")) ?? 50;
        // Loss circuit breakers — empty value disables the breaker (null).
        if (params.has("maxConsecutiveLosses")) cfg.maxConsecutiveLosses = params.get("maxConsecutiveLosses") ? Math.max(1, parseInt(params.get("maxConsecutiveLosses")) || 0) || null : null;
        if (params.has("dailyLossLimitPct")) cfg.dailyLossLimitPct = params.get("dailyLossLimitPct") ? Math.max(0, parseFloat(params.get("dailyLossLimitPct")) / 100) || null : null;
        if (params.has("maxDayTrades")) cfg.maxDayTrades = params.get("maxDayTrades") ? Math.max(1, parseInt(params.get("maxDayTrades")) || 0) || null : null;
        if (params.has("bullEntry")) cfg.bullEntry = Math.min(100, Math.max(50, parseInt(params.get("bullEntry")) || 68));
        if (params.has("bearEntry")) cfg.bearEntry = Math.min(50, Math.max(0, parseInt(params.get("bearEntry")) || 32));
        cfg.customPromptSuffix = params.get("customPromptSuffix") || "";
        // Broker binding is immutable. Only canonical runtime ids can own process-global live
        // credentials; an API-crafted config request cannot rebind a paper account or vice versa.
        if (params.has("configForm")) {
          cfg.useCashReserve = params.get("useCashReserve") === "on" || params.get("useCashReserve") === "true";
          cfg.autoExecute = params.get("autoExecute") === "on" || params.get("autoExecute") === "true";
          cfg.tradeWhenClosed = params.get("tradeWhenClosed") === "on" || params.get("tradeWhenClosed") === "true";
          cfg.liveEntriesEnabled = params.get("liveEntriesEnabled") === "on" || params.get("liveEntriesEnabled") === "true";
        }
        Object.assign(cfg, sanitizeRuntimeBrokerConfig(id, cfg).config);
        const policyChanges = applyLiveRiskPolicy(target);
        const liveCfg = target.config;
        target.riskPct = effectiveRiskPct(liveCfg.baseRiskPct, target.currentRegime);
        if (policyChanges.length) {
          log(target, `LIVE CONFIG: settings normalized (${policyChanges.map(change => `${change.key} ${change.before}→${change.after}`).join(", ")})`);
        }
        saveAccounts();
        console.log(`  [${id}] Config updated: allocation=${(liveCfg.baseRiskPct * 100).toFixed(1)}% reserve=${liveCfg.useCashReserve} entries=${liveCfg.liveEntriesEnabled} plannedRisk=${((liveCfg.riskPerTradePct || 0) * 100).toFixed(2)}% target=${(liveCfg.profitTarget * 100)}% stop=${(liveCfg.stopLoss * 100)}% minQuality=${liveCfg.minSetupQuality} bullEntry=${liveCfg.bullEntry} bearEntry=${liveCfg.bearEntry}`);
        res.writeHead(302, { Location: `/?a=${id}` });
        res.end();
      });
      return;
    }

    if (pathname === "/api/accounts" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const list = [];
      for (const [id, a] of accounts) {
        const pv = portfolioValue(a.state, a.dashboard.quotes);
        const sc = a.config.startingCash > 0 ? a.config.startingCash : null;
        list.push({ id, name: a.name, paused: a.paused, learning: a.learning || false, learningParent: a.learningParent || null, cash: a.state.cash, positions: a.state.positions.length, trades: a.state.history.length, pv, pnl: sc ? ((pv - sc) / sc * 100).toFixed(1) : "0.0", config: a.config });
      }
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === "/api/global") {
      let totalPV = 0, totalPositions = 0, totalTrades = 0;
      for (const [, a] of accounts) { totalPV += portfolioValue(a.state, a.dashboard.quotes); totalPositions += a.state.positions.length; totalTrades += a.state.history.length; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ accounts: accounts.size, totalPV, totalPositions, totalTrades, claudeCalls: claudeCallCount, claudeCost: getClaudeCost(), llmProvider: LLM_PROVIDER, llmLabel: getLLMLabel() }));
      return;
    }

    // ─── LLM Provider Toggle ───
    if (req.method === "POST" && pathname === "/api/llm-provider") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const requested = params.get("provider");
        if (requested === "gemini" || requested === "claude") {
          LLM_PROVIDER = requested;
        } else {
          // Toggle: no specific provider requested, just flip
          LLM_PROVIDER = LLM_PROVIDER === "gemini" ? "claude" : "gemini";
        }
        console.log(`  LLM Provider switched to: ${getLLMLabel()} (${LLM_PROVIDER})`);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ provider: LLM_PROVIDER, label: getLLMLabel() }));
      });
      return;
    }

    // (TRADING_MODE toggle removed — broker is per-account via config.broker)

    // The old in-process approval queue was never broker-backed and could not survive a restart.
    // Fail closed instead of advertising controls that do not exist.
    if (req.method === "POST" && pathname === "/api/rh-approval") {
      res.writeHead(410, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Manual approval queue retired; live entries are observation-only" }));
      return;
    }

    // ─── Robinhood: Toggle Options-Only Mode ───
    if (req.method === "POST" && pathname === "/api/rh-options-only") {
      RH_OPTIONS_ONLY = !RH_OPTIONS_ONLY;
      console.log(`  RH Options Only: ${RH_OPTIONS_ONLY ? "ON (no equity fallback)" : "OFF (dual mode)"}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ optionsOnly: RH_OPTIONS_ONLY, tradeMode: rhTradeMode({ broker: "robinhood" }) }));
      return;
    }

    // ─── Robinhood: Toggle Auto-Watchlist ───
    if (req.method === "POST" && pathname === "/api/rh-auto-watchlist") {
      RH_AUTO_WATCHLIST = !RH_AUTO_WATCHLIST;
      console.log(`  RH Auto Watchlist: ${RH_AUTO_WATCHLIST ? "ON" : "OFF"} → "${RH_WATCHLIST_NAME}"`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ autoWatchlist: RH_AUTO_WATCHLIST, watchlistName: RH_WATCHLIST_NAME }));
      return;
    }

    // ─── Robinhood: Get Watchlist ───
    if (pathname === "/api/rh-tools") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        connected: robinhood.isConnected,
        optionsEnabled: robinhood.optionsEnabled,
        tools: robinhood.availableTools,
        schemas: robinhood.toolSchemas,
      }, null, 2));
      return;
    }

    // On-demand raw dump of the exact Robinhood options payloads used for live pricing. This
    // bypasses the flooded cycle log so the true API shapes can be observed directly. Fetches
    // held option positions and their market data by BOTH bare ticker and OCC symbol so we can
    // see which identifier the market-data endpoint actually keys on.
    if (pathname === "/api/rh-debug") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      const out = { optionsEnabled: robinhood.optionsEnabled, optionTools: robinhood.optionToolInfo, orderSchemas: {}, portfolioRaw: null, accountsRaw: null, positionsRaw: null, held: [], byOptionId: {}, byTicker: {}, byOcc: {}, errors: {} };
      // Raw balance payloads — the exact field names for equity/buying-power have repeatedly had
      // to be guessed; this makes them observable on demand instead of relying on one-shot logs.
      try { out.portfolioRaw = await robinhood.getPortfolio(); } catch (e) { out.errors.portfolioRaw = e.message; }
      try { out.accountsRaw = await robinhood.getAccounts(); } catch (e) { out.errors.accountsRaw = e.message; }
      // Full input schemas for the order tools — need the legs sub-schema to build orders in the
      // exact wire format the MCP expects (additionalProperties:false rejects extra leg fields).
      try {
        const allSchemas = robinhood.toolSchemas;
        for (const t of ["place_option_order", "review_option_order", "place_options_order", "review_options_order"]) {
          if (allSchemas[t]) out.orderSchemas[t] = allSchemas[t];
        }
      } catch (e) { out.errors.orderSchemas = e.message; }
      try {
        const optRes = await robinhood.getOptionsPositions();
        out.positionsRaw = optRes && optRes.data ? optRes.data : optRes;
        const optArr = out.positionsRaw && Array.isArray(out.positionsRaw.positions) ? out.positionsRaw.positions
          : Array.isArray(out.positionsRaw) ? out.positionsRaw : [];
        const held = [];
        for (const op of optArr) {
          const qty = parseFloat(op.quantity || op.pending_buy_quantity || op.pending_sell_quantity || 0);
          // include zero-qty rows too so the endpoint still probes market data when flat
          const ticker = (op.chain_symbol || op.symbol || "").toUpperCase();
          const rawSide = (op.type || "").toLowerCase();
          const optType = (rawSide === "long" || rawSide === "short") ? (op.option_type || op.legs?.[0]?.option_type || "call").toLowerCase() : (rawSide || "call").toLowerCase();
          const strike = parseFloat(op.strike_price || op.legs?.[0]?.strike_price || 0);
          const expDate = op.expiration_date || op.legs?.[0]?.expiration_date || null;
          const optionId = op.option_id || op.instrument_id || op.instrument || null;
          if (rawSide === "long") held.push({ ticker, optType, strike, expDate, optionId, qty });
        }
        out.held = held;
        out.tickers = [...new Set(held.map(h => h.ticker).filter(Boolean))];
        // Probe the market-data tool three ways: by option_id (UUID), by bare ticker, by OCC.
        for (const h of held) {
          if (h.optionId) {
            try { out.byOptionId[h.optionId] = await robinhood.getOptionMarketData([h.optionId]); }
            catch (e) { out.errors[`byOptionId:${h.optionId}`] = e.message; }
          }
        }
        for (const t of out.tickers) {
          try { out.byTicker[t] = await robinhood.getOptionMarketData([t]); }
          catch (e) { out.errors[`byTicker:${t}`] = e.message; }
        }
        for (const h of held) {
          if (!h.ticker || !h.strike || !h.expDate) continue;
          const occ = robinhood.buildOCC(h.ticker, h.expDate, h.optType, h.strike);
          try { out.byOcc[occ] = await robinhood.getOptionMarketData([occ]); }
          catch (e) { out.errors[`byOcc:${occ}`] = e.message; }
        }
        // Dry-run probe: review (NOT place) a 1-contract sell_to_close for each held contract using
        // its option_id. review_option_order previews without executing, so this validates the legs
        // wire format end-to-end with zero risk. If it returns a preview, the exit format is correct.
        out.reviewProbe = {};
        for (const h of held) {
          if (!h.optionId || !(h.qty > 0)) continue;
          const q = out.byOptionId[h.optionId]?.data?.results?.[0]?.quote;
          const bid = q ? parseFloat(q.bid_price) : 0;
          const probeLimit = (bid > 0 ? bid : 0.01).toFixed(2);
          try {
            out.reviewProbe[h.optionId] = await robinhood.reviewOptionOrder({
              symbol: h.ticker, expirationDate: h.expDate, strikePrice: h.strike, optionType: h.optType,
              side: "sell_to_close", quantity: 1, type: "limit", limitPrice: probeLimit, optionId: h.optionId,
            });
          } catch (e) { out.errors[`reviewProbe:${h.optionId}`] = e.message; }
        }
      } catch (e) {
        out.errors.top = e.message;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(out, null, 2));
      return;
    }

    if (pathname === "/api/rh-watchlist") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      try {
        let items = [];
        try {
          const wl = await robinhood.getWatchlistItems(RH_WATCHLIST_NAME);
          const raw = wl?.data?.items || wl?.items || wl?.results || wl;
          if (Array.isArray(raw)) items = items.concat(raw.map(i => ({ ...i, type: "equity", detail: i.name || "" })));
        } catch { }
        if (robinhood.optionsEnabled) {
          try {
            const optWl = await robinhood.getOptionWatchlist(RH_WATCHLIST_NAME);
            const rawOpt = optWl?.data?.items || optWl?.items || optWl?.results || optWl;
            if (Array.isArray(rawOpt)) {
              items = items.concat(rawOpt.map(i => ({
                symbol: i.chain_symbol || i.symbol,
                type: "option",
                detail: i.strike_price ? `$${i.strike_price} ${i.option_type || i.type || ""} ${i.expiration_date || ""}`.trim() : (i.instrument_id || ""),
              })));
            }
          } catch { }
        }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ watchlist: RH_WATCHLIST_NAME, items }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Add to Watchlist (manual) ───
    if (req.method === "POST" && pathname === "/api/rh-watchlist-add") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const symbol = (params.get("symbol") || "").trim().toUpperCase();
        const expiration = (params.get("expiration") || "").trim();
        const strike = (params.get("strike") || "").trim();
        const optionType = (params.get("option_type") || "call").trim().toLowerCase();
        try {
          if (expiration && strike) {
            await robinhood.addOptionToWatchlist({
              symbol,
              expirationDate: expiration,
              strikePrice: strike,
              optionType,
              watchlist: RH_WATCHLIST_NAME,
            });
            rhWatchlistAdded.add(`O:${symbol}:${expiration}:${strike}:${optionType}`);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, message: `Added ${symbol} $${strike} ${optionType} ${expiration} to "${RH_WATCHLIST_NAME}"` }));
          } else if (symbol) {
            await robinhood.addToWatchlist(symbol, RH_WATCHLIST_NAME);
            rhWatchlistAdded.add(`E:${symbol}`);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, message: `Added ${symbol} to "${RH_WATCHLIST_NAME}"` }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ error: "symbol required" }));
          }
        } catch (e) {
          const msg = e.message.includes("not available")
            ? `Watchlist tool not available on this Robinhood MCP session. Available tools: ${robinhood.availableTools.filter(t => /watch/i.test(t)).join(", ") || "none"}`
            : e.message;
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: msg }));
        }
      });
      return;
    }

    // ─── Tradier: Data/Execution Arm Status ───
    if (pathname === "/api/tradier-status") {
      let clock = null, balances = null;
      if (tradier.isConnected) {
        try { clock = await tradier.getClock(); } catch { }
        if (tradier.accountId) { try { balances = await tradier.getAccount(); } catch { } }
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        connected: tradier.isConnected,
        authenticated: tradier.isAuthenticated,
        environment: tradier.environment,
        baseUrl: tradier.baseUrl,
        accountId: tradier.accountId,
        marketState: clock?.state || null,
        balances,
        balanceInfo: brokerBalanceInfo(balances, (accounts.get("tradier") || activeAcct)?.config || DEFAULT_CONFIG),
        dataSource: { ...marketDataStats },
        lastError: tradier.lastError,
        pendingOrders: tradier.pendingOrders,
      }));
      return;
    }

    // ─── Tradier: Reconnect / Test ───
    if (req.method === "POST" && pathname === "/api/tradier-reconnect") {
      const ok = await tradier.init();
      console.log(`  Tradier reconnect: ${ok ? "CONNECTED" : "FAILED"}${tradier.lastError ? ` — ${tradier.lastError}` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ connected: tradier.isConnected, error: tradier.lastError, accountId: tradier.accountId, environment: tradier.environment }));
      return;
    }

    // ─── Tradier: Cancel ALL working orders (reset / kill switch) ───
    if (req.method === "POST" && pathname === "/api/tradier-cancel-orders") {
      let canceled = 0; const errors = [];
      try {
        const orders = await tradier.getOrders();
        for (const o of orders) {
          if (ORDER_DONE_STATUSES.includes((o.status || "").toLowerCase())) continue;
          try { await tradier.cancelOrder(o.id); canceled++; }
          catch (e) { errors.push(`${o.id}: ${e.message}`); }
        }
      } catch (e) { errors.push(e.message); }
      console.log(`  Tradier: canceled ${canceled} working order(s)${errors.length ? ` (${errors.length} error(s))` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ canceled, errors }));
      return;
    }

    // ─── Tradier: Set Token / Environment at runtime ───
    if (req.method === "POST" && pathname === "/api/tradier-token") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const token = (params.get("token") || "").trim();
        const env = (params.get("env") || "").trim();
        if (env) tradier.setEnvironment(env);
        if (token) tradier.setToken(token);
        if (token || env) await tradier.init();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ connected: tradier.isConnected, error: tradier.lastError, environment: tradier.environment }));
      });
      return;
    }

    // ─── Tradier: Quote Lookup ───
    if (pathname === "/api/tradier-quote") {
      const sym = (url.searchParams.get("sym") || "SPY").toUpperCase();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (!tradier.isConnected) { res.end(JSON.stringify({ error: "Tradier not connected" })); return; }
      try { res.end(JSON.stringify(await tradier.getQuote(sym))); }
      catch (e) { res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ─── Tradier: Option Chain Lookup ───
    if (pathname === "/api/tradier-chain") {
      const sym = (url.searchParams.get("sym") || "SPY").toUpperCase();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (!tradier.isConnected) { res.end(JSON.stringify({ error: "Tradier not connected" })); return; }
      try { res.end(JSON.stringify({ chain: await tradier.getOptionsChainNormalized(sym) })); }
      catch (e) { res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ─── Robinhood: OAuth2 PKCE — Start Auth Flow ───
    if (pathname === "/api/rh-auth") {
      if (spectator) { res.writeHead(403, { "Content-Type": "text/html" }); res.end("Spectators cannot authenticate."); return; }
      try {
        const host = req.headers.host || `localhost:${DASH_PORT}`;
        const proto = req.headers["x-forwarded-proto"] || (host.includes("onrender.com") ? "https" : "http");
        const redirectUri = `${proto}://${host}/api/rh-callback`;

        const metaRes = await fetch(RH_OAUTH_META_URL);
        if (!metaRes.ok) throw new Error("Failed to fetch OAuth metadata");
        const meta = await metaRes.json();

        const regRes = await fetch(RH_REGISTER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "swingtrader-bot",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        if (!regRes.ok) throw new Error("Client registration failed: " + await regRes.text());
        const client = await regRes.json();

        const codeVerifier = crypto.randomBytes(32).toString("base64url");
        const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
        const state = crypto.randomBytes(16).toString("base64url");

        rhOAuthPending = { codeVerifier, state, clientId: client.client_id, redirectUri, tokenEndpoint: meta.token_endpoint };

        const authUrl = new URL(meta.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", client.client_id);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("scope", "internal");
        authUrl.searchParams.set("resource", "https://agent.robinhood.com/mcp/trading");

        const authUrlStr = authUrl.toString();
        console.log(`  [RH-AUTH] OAuth flow started (client: ${client.client_id})`);
        console.log(`  [RH-AUTH] Callback: ${redirectUri}`);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px;background:#111;color:#e5e7eb">
          <h2 style="color:#00a843;margin-bottom:4px">Robinhood OAuth Sign-In</h2>
          <p style="color:#8a909b;font-size:13px;margin-top:0">Open this link in a <strong>desktop browser</strong> where you're logged into Robinhood.</p>

          <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;margin:16px 0;word-break:break-all">
            <a href="${authUrlStr}" target="_blank" style="color:#4da6ff;font-size:13px;text-decoration:none">${authUrlStr}</a>
          </div>

          <p style="font-size:13px;color:#8a909b">
            <strong>If the page loads correctly:</strong> Sign in and authorize — you'll be redirected back here automatically.<br><br>
            <strong>If Robinhood shows a 404:</strong> The agentic OAuth web page may not work on mobile yet.
            Try a desktop browser, or use the Robinhood app if prompted. After authorizing, if you land on a page
            that won't load, copy the <strong>full URL</strong> from your browser's address bar and paste it below.
          </p>

          <form method="POST" action="/api/rh-code" style="margin-top:20px">
            <label style="color:#9ca3af;font-size:12px;display:block;margin-bottom:6px">Paste the callback URL or just the <code>code</code> parameter:</label>
            <input type="text" name="callback_url" placeholder="https://...?code=abc123&state=... or just the code" style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#1a1a2e;color:#e5e7eb;font-size:14px;margin-bottom:10px">
            <button type="submit" style="background:#00a843;color:white;border:none;padding:10px 24px;border-radius:6px;font-size:14px;cursor:pointer;width:100%">Exchange Code for Token</button>
          </form>

          <p style="margin-top:20px;text-align:center"><a href="/robinhood" style="color:#6b7280;font-size:13px">Cancel</a></p>
        </body></html>`);
      } catch (e) {
        console.error(`  [RH-AUTH] Error starting OAuth flow: ${e.message}`);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">OAuth Error</h2><p>${e.message}</p><a href="/robinhood" style="color:#00a843">Back to Dashboard</a></body></html>`);
      }
      return;
    }

    // ─── Robinhood: OAuth2 PKCE — Manual Code Submission ───
    if (req.method === "POST" && pathname === "/api/rh-code") {
      if (spectator) { res.writeHead(403); res.end("Spectators cannot authenticate."); return; }
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        if (!rhOAuthPending) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">No pending auth flow</h2><p>Start again from the <a href="/robinhood" style="color:#00a843">dashboard</a>.</p></body></html>`);
          return;
        }

        const params = new URLSearchParams(body);
        let callbackInput = (params.get("callback_url") || "").trim();
        let code = null;

        try {
          const parsed = new URL(callbackInput);
          code = parsed.searchParams.get("code");
        } catch {
          code = callbackInput;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">No code found</h2><p>Paste the full callback URL or the code parameter.</p><a href="/api/rh-auth" style="color:#00a843">Try Again</a></body></html>`);
          return;
        }

        try {
          const tokenRes = await fetch(rhOAuthPending.tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: rhOAuthPending.redirectUri,
              client_id: rhOAuthPending.clientId,
              code_verifier: rhOAuthPending.codeVerifier,
            }).toString(),
          });

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${errText}`);
          }

          const tokens = await tokenRes.json();
          if (!tokens.access_token) throw new Error("No access_token in response");

          // Keep the dynamic client_id + token endpoint with the tokens so refresh works later.
          const authMeta = { clientId: rhOAuthPending.clientId, tokenEndpoint: rhOAuthPending.tokenEndpoint };
          rhOAuthPending = null;
          robinhood.setToken(tokens.access_token, tokens.refresh_token || null, authMeta);
          const connected = await robinhood.init({ reload: false });
          const optLabel = robinhood.optionsEnabled ? "Options + Equity" : "Equity only";

          console.log(`  [RH-AUTH] OAuth complete via manual code — ${connected ? "CONNECTED" : "token saved but init failed"} (${optLabel})`);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb">
            <h2 style="color:#00a843">✓ Robinhood Connected!</h2>
            <p style="font-size:18px">${connected ? `MCP initialized — <strong>${optLabel}</strong>` : "Token saved but MCP init failed."}</p>
            <p style="color:#6b7280;font-size:13px">Account: ${robinhood.accountNumber || "discovering..."}</p>
            <p style="color:#6b7280;font-size:13px">Expires in: ${tokens.expires_in ? Math.round(tokens.expires_in / 3600) + " hours" : "unknown"}</p>
            <p style="margin-top:24px"><a href="/robinhood" style="color:#00a843;font-size:16px">← Back to Dashboard</a></p>
          </body></html>`);
        } catch (e) {
          console.error(`  [RH-AUTH] Manual code exchange error: ${e.message}`);
          rhOAuthPending = null;
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">Token Exchange Failed</h2><p>${e.message}</p><a href="/robinhood" style="color:#00a843">Back to Dashboard</a></body></html>`);
        }
      });
      return;
    }

    // ─── Robinhood: OAuth2 PKCE — Automatic Callback ───
    if (pathname === "/api/rh-callback") {
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") || "";
        console.error(`  [RH-AUTH] OAuth error: ${error} — ${desc}`);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">Authorization Failed</h2><p>${error}: ${desc}</p><a href="/robinhood" style="color:#00a843">Back to Dashboard</a></body></html>`);
        return;
      }

      if (!rhOAuthPending) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">No pending auth flow</h2><p>Start the flow again from the <a href="/robinhood" style="color:#00a843">dashboard</a>.</p></body></html>`);
        return;
      }

      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (returnedState !== rhOAuthPending.state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">State Mismatch</h2><p>Try again.</p><a href="/robinhood" style="color:#00a843">Back to Dashboard</a></body></html>`);
        rhOAuthPending = null;
        return;
      }

      try {
        const tokenRes = await fetch(rhOAuthPending.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: rhOAuthPending.redirectUri,
            client_id: rhOAuthPending.clientId,
            code_verifier: rhOAuthPending.codeVerifier,
          }).toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${errText}`);
        }

        const tokens = await tokenRes.json();
        if (!tokens.access_token) throw new Error("No access_token in response");

        // Persist the dynamic-registration client identity WITH the tokens — refresh_token
        // grants are only honored for the client_id that minted them, so without this the
        // bot silently loses the session (and the ability to exit positions) at token expiry.
        const authMeta = { clientId: rhOAuthPending.clientId, tokenEndpoint: rhOAuthPending.tokenEndpoint };
        rhOAuthPending = null;

        robinhood.setToken(tokens.access_token, tokens.refresh_token || null, authMeta);
        const connected = await robinhood.init({ reload: false });
        const optLabel = robinhood.optionsEnabled ? "Options + Equity" : "Equity only";

        console.log(`  [RH-AUTH] OAuth complete — ${connected ? "CONNECTED" : "token saved but init failed"} (${optLabel})`);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb">
          <h2 style="color:#00a843">✓ Robinhood Connected!</h2>
          <p style="font-size:18px">${connected ? `MCP initialized — <strong>${optLabel}</strong>` : "Token saved but MCP init failed. Check logs."}</p>
          <p style="color:#6b7280;font-size:13px">Account: ${robinhood.accountNumber || "discovering..."}</p>
          <p style="color:#6b7280;font-size:13px">Expires in: ${tokens.expires_in ? Math.round(tokens.expires_in / 3600) + " hours" : "unknown"}</p>
          <p style="margin-top:24px"><a href="/robinhood" style="color:#00a843;font-size:16px">← Back to Dashboard</a></p>
        </body></html>`);
      } catch (e) {
        console.error(`  [RH-AUTH] Token exchange error: ${e.message}`);
        rhOAuthPending = null;
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#111;color:#e5e7eb"><h2 style="color:#e8473f">Token Exchange Failed</h2><p>${e.message}</p><a href="/robinhood" style="color:#00a843">Back to Dashboard</a></body></html>`);
      }
      return;
    }

    // ─── Robinhood: Get Status & Pending Orders ───
    if (pathname === "/api/rh-status") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        connected: robinhood.isConnected,
        authenticated: robinhood.isAuthenticated,
        accountNumber: robinhood.accountNumber,
        optionsEnabled: robinhood.optionsEnabled,
        optionsOnly: RH_OPTIONS_ONLY,
        autoWatchlist: RH_AUTO_WATCHLIST,
        watchlistName: RH_WATCHLIST_NAME,
        tradeMode: rhTradeMode({ broker: "robinhood" }),
        availableTools: robinhood.availableTools,
        requireApproval: RH_REQUIRE_APPROVAL,
        approvalSupported: false,
        maxPositionDollars: RH_MAX_POSITION_DOLLARS,
        pendingOrders: [],
      }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/rh-cancel-entry-orders") {
      const acct = accounts.get("robinhood");
      try {
        const canceled = acct
          ? await withBrokerExecutionLane(acct, () => cancelWorkingEntryOrders(acct, "dashboard kill switch"))
          : 0;
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ canceled }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // Retired non-durable approval endpoints remain explicit errors for old clients.
    if (req.method === "POST" && pathname.startsWith("/api/rh-approve/")) {
      res.writeHead(410, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Approval queue retired; no order was submitted" }));
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/rh-reject/")) {
      res.writeHead(410, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Approval queue retired; use cancel-working-buys for broker-backed orders" }));
      return;
    }

    // ─── Robinhood: Get Positions ───
    if (pathname === "/api/rh-portfolio") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      try {
        const positionsRes = await robinhood.getPositions();
        const positions = positionsRes && positionsRes.data && Array.isArray(positionsRes.data.positions) ? positionsRes.data.positions : (Array.isArray(positionsRes) ? positionsRes : []);
        // Enrich with quotes so current_price is available for display
        if (positions.length > 0) {
          const syms = positions.map(p => p.symbol).filter(Boolean);
          try {
            const quotes = await robinhood.getQuotes(syms);
            const qMap = {};
            if (quotes && quotes.data && Array.isArray(quotes.data.results)) {
              for (const q of quotes.data.results) if (q.symbol) qMap[q.symbol] = q;
            } else if (Array.isArray(quotes)) {
              for (const q of quotes) if (q.symbol) qMap[q.symbol] = q;
            }
            for (const p of positions) {
              const q = qMap[p.symbol];
              if (q) {
                p.current_price = q.last_trade_price || q.adjusted_previous_close || p.current_price;
                p.last_trade_price = q.last_trade_price;
              }
            }
          } catch { }
        }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(positions));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Set Access Token (from dashboard) ───
    if (req.method === "POST" && pathname === "/api/rh-token") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const token = (params.get("token") || "").trim();
        const refresh = (params.get("refresh_token") || "").trim() || null;
        if (token) {
          robinhood.setToken(token, refresh);
          const connected = await robinhood.init({ reload: false });
          const optLabel = robinhood.optionsEnabled ? " (options enabled)" : " (equity only)";
          const errDetail = robinhood.lastInitError ? ` — ${robinhood.lastInitError}` : "";
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({
            connected,
            optionsEnabled: robinhood.optionsEnabled,
            error: connected ? null : robinhood.lastInitError,
            message: connected
              ? `Robinhood connected!${optLabel}`
              : `Token saved but MCP init failed${errDetail}. Use the long accessToken (starts with eyJ), not refreshToken. If Render has ROBINHOOD_ACCESS_TOKEN set, update or remove it.`,
          }));
        } else if (params.has("token")) {
          robinhood.setToken("");
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ connected: false, message: "Robinhood disconnected" }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "No token provided" }));
        }
      });
      return;
    }

    // ─── Existing routes (scoped to activeAcct) ───

    if (req.method === "POST" && pathname === "/hint") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const hintText = params.get("hint");
        if (hintText) {
          log(activeAcct, `HINT (via dashboard): "${hintText}"`);
          // Process hint directly via Claude instead of file
          try {
            const result = await processHint(hintText, activeAcct);
            if (result) await applyHintResult(activeAcct, result, hintText);
          } catch (e) {
            log(activeAcct, `HINT ERROR: ${e.message}`);
          }
        }
        res.writeHead(302, { Location: `/?a=${acctId}` });
        res.end();
      });
      return;
    }

    const tickerAnalyzeMatch = pathname.match(/^\/api\/ticker\/([A-Z]+)\/analyze$/);
    if (req.method === "POST" && tickerAnalyzeMatch) {
      const sym = tickerAnalyzeMatch[1];
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const question = params.get("question") || "";
        try {
          // Ensure we have fresh data
          if (!dashboard.candles[sym] && apiKey) dashboard.candles[sym] = await fetchCandles(sym, apiKey);
          if (!dashboard.quotes[sym] && apiKey) dashboard.quotes[sym] = await fetchQuote(sym, apiKey);
          if (dashboard.candles[sym] && !dashboard.analyses[sym]) {
            const a = runAnalysis(dashboard.candles[sym]); if (a) dashboard.analyses[sym] = a;
            const st = runShortTermAnalysis(dashboard.candles[sym]); if (st) dashboard.shortTermAnalyses[sym] = st;
          }
          const analysisText = await analyzeTickerOnDemand(activeAcct, sym, question);
          dashboard.onDemandAnalyses[sym] = { ts: Date.now(), question, response: analysisText };
          log(activeAcct, `ON-DEMAND ANALYSIS: ${sym} — "${question || 'general analysis'}"`);
        } catch (e) {
          log(activeAcct, `ON-DEMAND ANALYSIS ERROR: ${sym} — ${e.message}`);
          dashboard.onDemandAnalyses[sym] = { ts: Date.now(), question, response: `Analysis failed: ${e.message}` };
        }
        res.writeHead(302, { Location: `/ticker/${sym}?a=${acctId}` });
        res.end();
      });
      return;
    }

    const tickerMatch = pathname.match(/^\/ticker\/([A-Z]+)$/);
    if (tickerMatch) {
      const sym = tickerMatch[1];
      try {
        if (!dashboard.candles[sym] && apiKey) dashboard.candles[sym] = await fetchCandles(sym, apiKey);
        if (!dashboard.quotes[sym] && apiKey) dashboard.quotes[sym] = await fetchQuote(sym, apiKey);
        if (dashboard.candles[sym] && !dashboard.analyses[sym]) {
          const a = runAnalysis(dashboard.candles[sym]); if (a) dashboard.analyses[sym] = a;
          const st = runShortTermAnalysis(dashboard.candles[sym]); if (st) dashboard.shortTermAnalyses[sym] = st;
        }
      } catch (e) { log(activeAcct, `WARN: On-demand fetch for ${sym} failed — ${e.message}`); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(tickerDetailHTML(sym, activeAcct, { spectator }));
      return;
    }

    // Agent-readable diagnostics feed. JSON, newest-first, low-volume (decisions + anomalies only).
    // Usage:  /api/diagnostics            → last 200 events + rollup summary
    //         /api/diagnostics?limit=500  → more history
    //         /api/diagnostics?type=exit_fill | entry | clock | data | risk_halt | error
    if (pathname === "/api/diagnostics") {
      const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get("limit")) || 200));
      const typeFilter = url.searchParams.get("type") || null;
      const events = readDiagnostics(limit, typeFilter);
      const all = readDiagnostics(2000, null);
      const byType = {};
      for (const e of all) byType[e.type] = (byType[e.type] || 0) + 1;
      const fills = all.filter(e => e.type === "exit_fill" && typeof e.slipPct === "number");
      const avgSlip = fills.length ? +(fills.reduce((s, e) => s + e.slipPct, 0) / fills.length).toFixed(1) : null;
      const summary = {
        totalEvents: all.length,
        byType,
        avgExitSlipPct: avgSlip,
        worstExitSlip: fills.length ? fills.reduce((a, b) => (Math.abs(b.slipPct) > Math.abs(a.slipPct) ? b : a)) : null,
        marketClock: { state: _marketClock.state, source: _marketClock.source, nextChange: _marketClock.nextChange, ageSec: Math.round((Date.now() - _marketClock.fetchedAt) / 1000) },
        lastError: all.find(e => e.type === "error") || null,
      };
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ schema: "ts,iso,et,type,acct,marketOpen,clock,...payload", summary, events }, null, 2));
      return;
    }

    if (pathname === "/api/state") {
      await refreshBrokerBalances(activeAcct, { logErrors: true });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ cash: state.cash, positions: state.positions, history: state.history.slice(-50), quotes: dashboard.quotes, analyses: Object.fromEntries(Object.entries(dashboard.analyses).map(([k, v]) => [k, { score: v.score, signal: v.signal, price: v.price, rsi: v.rsi }])), activeHints: activeAcct.activeHints, portfolioValue: portfolioValue(state, dashboard.quotes), marketOpen: dashboard.marketOpen, log: dashboard.cycleLog.slice(-200), decisionJournal: (dashboard.decisionJournal || []).slice(-20), positionManagement: dashboard.positionManagement || [], managementJournal: (state.managementJournal || []).slice(-50) }));
      return;
    }

    // Full portfolio-value history for the active account — used by the dashboard chart's
    // range selectors (1D/1W/1M/ALL) and live re-rendering.
    if (pathname === "/api/portfolio-history") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const hist = (dashboard.portfolioHistory || []).map(p => ({ ts: p.ts, value: p.value }));
      res.end(JSON.stringify({
        startingCash: activeAcct.config.startingCash,
        createdAt: activeAcct.createdAt,
        history: hist,
      }));
      return;
    }

    if (pathname === "/api/live") {
      const balanceInfo = await refreshBrokerBalances(activeAcct, { logErrors: true });
      if (activeAcct.config.broker === "tradier") {
        appendPortfolioPoint(dashboard.portfolioHistory, Date.now(), portfolioValue(state, dashboard.quotes));
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const tickers = {};
      for (const [sym, q] of Object.entries(dashboard.quotes)) {
        const a = dashboard.analyses[sym]; const st = dashboard.shortTermAnalyses[sym];
        const pos = state.positions.find(p => p.ticker === sym);
        let posPnl = null;
        if (pos) { const spot = q ? q.c : pos.entrySpot; const _isEq = pos.type === "equity"; const _now = Date.now(); const dteLeft = pos.expiryDate ? Math.max(0, (pos.expiryDate - _now) / 86400_000) : Math.max(0, pos.dte - (_now - pos.openTime) / 86400_000); const curPremium = _isEq ? (pos.liveMark ?? spot) : (pos.liveMark ?? optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type)); const _mult = _isEq ? 1 : 100; posPnl = { pct: ((curPremium - pos.entryPremium) / pos.entryPremium * 100).toFixed(1), dollar: ((curPremium - pos.entryPremium) * pos.qty * _mult).toFixed(0) }; }
        tickers[sym] = { c: q.c, pc: q.pc, d: q.d, dp: q.dp, h: q.h, l: q.l, score: a?.score, signal: a?.signal, stScore: st?.score, mom1d: st?.mom1d, mom3d: st?.mom3d, mom7d: st?.mom7d, held: !!pos, type: pos?.type, posPnl };
      }
      res.end(JSON.stringify({ tickers, pv: portfolioValue(state, dashboard.quotes), cash: state.cash, startingCash: activeAcct.config.startingCash, balanceInfo, open: state.positions.length, marketOpen: dashboard.marketOpen, lastCycle: dashboard.lastCycle }));
      return;
    }

    // ─── Simulator API ───

    if (req.method === "POST" && pathname === "/api/sim/start") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const config = {
          startDate: params.get("startDate"),
          endDate: params.get("endDate"),
          startingCash: parseFloat(params.get("startingCash")) || 200,
          baseRiskPct: (parseFloat(params.get("baseRiskPct")) || 15) / 100,
          profitTarget: (parseFloat(params.get("profitTarget")) || 40) / 100,
          stopLoss: (parseFloat(params.get("stopLoss")) || -35) / 100,
          bullEntry: parseInt(params.get("bullEntry")) || 65,
          bearEntry: parseInt(params.get("bearEntry")) || 35,
          minSetupQuality: parseInt(params.get("minSetupQuality")) || 50,
          maxPositions: parseInt(params.get("maxPositions")) || null,
          useClaude: params.get("useClaude") === "true",
          speedMs: parseInt(params.get("speedMs")) || 3000,
          tickers: (params.get("tickers") || "SPY,QQQ,AAPL,NVDA,TSLA,MSFT,META,AMZN,GOOGL,AMD").split(",").map(s => s.trim()).filter(Boolean),
        };
        lastSimConfig = config;
        const sim = await startSimulation(config);
        res.writeHead(302, { Location: `/?sim=${sim.id}` });
        res.end();
      });
      return;
    }

    if (pathname === "/api/sim/stream") {
      const id = parseInt(url.searchParams.get("id"));
      const sim = simulations.get(id);
      if (!sim) { res.writeHead(404); res.end("Sim not found"); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(`data: ${JSON.stringify({ type: "init", status: sim.status, totalDays: sim.totalDays || 0, history: sim.portfolioHistory })}\n\n`);
      sim.clients.push(res);
      req.on("close", () => { sim.clients = sim.clients.filter(c => c !== res); });
      return;
    }

    if (req.method === "POST" && pathname === "/api/sim/control") {
      const id = parseInt(url.searchParams.get("id"));
      const action = url.searchParams.get("action");
      const sim = simulations.get(id);
      if (!sim) { res.writeHead(404); res.end("Sim not found"); return; }
      if (action === "pause" && sim.status === "running") {
        sim.status = "paused";
        clearInterval(sim.interval);
        emitSSE(sim, { type: "status", status: "paused" });
      } else if (action === "resume" && sim.status === "paused") {
        sim.status = "running";
        sim._tickRunning = false;
        sim.interval = setInterval(() => {
          if (sim._tickRunning) return;
          sim._tickRunning = true;
          simTick(sim).finally(() => { sim._tickRunning = false; });
        }, sim.speedMs);
        emitSSE(sim, { type: "status", status: "running" });
      } else if (action === "cancel") {
        sim.status = "cancelled";
        clearInterval(sim.interval);
        emitSSE(sim, { type: "status", status: "cancelled" });
      } else if (action === "speed") {
        const newSpeed = parseInt(url.searchParams.get("value")) || 3000;
        sim.speedMs = Math.max(50, Math.min(15000, newSpeed));
        if (sim.status === "running") {
          clearInterval(sim.interval);
          sim.interval = setInterval(() => {
            if (sim._tickRunning) return;
            sim._tickRunning = true;
            simTick(sim).finally(() => { sim._tickRunning = false; });
          }, sim.speedMs);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/api/sim/state") {
      const id = parseInt(url.searchParams.get("id"));
      const sim = simulations.get(id);
      if (!sim) { res.writeHead(404); res.end("Sim not found"); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ status: sim.status, day: sim.currentDayIndex, totalDays: sim.totalDays, portfolioHistory: sim.portfolioHistory, tradeHistory: sim.tradeHistory, config: sim.config }));
      return;
    }

    // ─── Web Push endpoints ───

    if (pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
      res.end(`
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : { title: 'Bot alert', body: '' };
  // Use a unique tag per notification so multiple alerts stack instead of replacing each other
  const tag = d.tag || ('bot-' + Date.now());
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    requireInteraction: !!d.urgent,
    tag: tag,
    vibrate: d.urgent ? [200, 100, 200] : [100],
    timestamp: Date.now(),
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url ? e.notification.data.url : '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ('focus' in c) return c.focus();
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe(e.oldSubscription.options)
      .then(sub => fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      }))
  );
});
`);
      return;
    }

    if (pathname === "/api/push/vapid-key") {
      const keys = getVapidKeys();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ publicKey: keys.publicKey }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/push/subscribe") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const sub = JSON.parse(body);
          if (sub && sub.endpoint) {
            const existingIdx = pushSubscriptions.findIndex(s => s.endpoint === sub.endpoint);
            if (existingIdx >= 0) {
              // Upsert: replace with fresh subscription object (keys may have rotated)
              pushSubscriptions[existingIdx] = sub;
              console.log(`  [PUSH] Updated existing subscription (total: ${pushSubscriptions.length})`);
            } else {
              pushSubscriptions.push(sub);
              console.log(`  [PUSH] New subscription registered (total: ${pushSubscriptions.length})`);
            }
            savePushSubs();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, total: pushSubscriptions.length }));
          } else {
            res.writeHead(400); res.end("Bad subscription");
          }
        } catch {
          res.writeHead(400); res.end("Invalid JSON");
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/push/unsubscribe") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const { endpoint } = JSON.parse(body);
          if (!endpoint) { res.writeHead(400); res.end("Missing endpoint"); return; }
          const before = pushSubscriptions.length;
          pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
          if (pushSubscriptions.length !== before) {
            savePushSubs();
            console.log(`  [PUSH] Removed subscription (total: ${pushSubscriptions.length})`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, removed: before - pushSubscriptions.length, total: pushSubscriptions.length }));
        } catch {
          res.writeHead(400); res.end("Invalid JSON");
        }
      });
      return;
    }

    // Per-device subscription status: returns whether the endpoint POSTed is currently registered.
    // Lets each browser/device determine its own button state without relying on server-global flags.
    if (req.method === "POST" && pathname === "/api/push/status") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const { endpoint } = JSON.parse(body);
          const subscribed = !!endpoint && pushSubscriptions.some(s => s.endpoint === endpoint);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ subscribed }));
        } catch {
          res.writeHead(400); res.end("Invalid JSON");
        }
      });
      return;
    }

    // ─── Robinhood: Get Account Info ───
    if (pathname === "/api/rh-account") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      try {
        const acctRes = await robinhood.getPortfolio();
        const payload = acctRes && acctRes.data ? { ...acctRes.data } : (acctRes || {});
        if (payload.buying_power && typeof payload.buying_power === 'object') {
          payload.buying_power = payload.buying_power.buying_power;
        }
        if (robinhood.accountNumber) {
          payload.account_number = robinhood.accountNumber;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Get Options Chain ───
    if (pathname === "/api/rh-options") {
      if (!robinhood.optionsEnabled) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Options not enabled on Robinhood MCP" }));
        return;
      }
      try {
        const sym = url.searchParams.get("symbol");
        if (!sym) { res.writeHead(400); res.end(JSON.stringify({ error: "symbol required" })); return; }
        const result = {};
        try { result.positions = await robinhood.getOptionsPositions(); } catch { result.positions = { data: { positions: [] } }; }
        try { result.instruments = await robinhood.getOptionInstruments(sym); } catch { }
        try { result.marketData = await robinhood.getOptionMarketData([sym]); } catch { }
        result.optionsEnabled = true;
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Get Orders ───
    if (pathname === "/api/rh-orders") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      try {
        const ordersRes = await robinhood.getOrders();
        const orders = ordersRes && ordersRes.data && Array.isArray(ordersRes.data.orders) ? ordersRes.data.orders : (Array.isArray(ordersRes) ? ordersRes : []);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(orders));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Trade audit (local history vs broker PnL / option orders) ───
    if (pathname === "/api/rh-trade-audit") {
      if (!robinhood.isConnected) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Robinhood MCP not connected" }));
        return;
      }
      const rhAcct = accounts.get("robinhood") || activeAcct;
      const span = url.searchParams.get("span") || "all";
      const out = {
        at: new Date().toISOString(),
        accountId: rhAcct?.id || null,
        portfolio: null,
        local: {
          cash: rhAcct?.state?.cash ?? null,
          brokerEquity: rhAcct?.state?.brokerEquity ?? null,
          portfolioValue: rhAcct ? portfolioValue(rhAcct.state, rhAcct.dashboard?.quotes || {}) : null,
          startingCash: rhAcct?.config?.startingCash ?? null,
          openPositions: rhAcct?.state?.positions?.length ?? 0,
          historyCount: rhAcct?.state?.history?.length ?? 0,
          historyPnl: +(rhAcct?.state?.history || [])
            .filter(t => typeof t?.pnlDollar === "number")
            .reduce((s, t) => s + t.pnlDollar, 0)
            .toFixed(2),
          rhUnsettled: rhAcct?.state?.rhUnsettled || [],
          history: (rhAcct?.state?.history || []).map(t => ({
            ticker: t.ticker,
            type: t.type,
            strike: t.strike,
            occSymbol: t.occSymbol,
            qty: t.qty,
            openDate: t.openDate,
            closeDate: t.closeDate,
            entryPremium: t.entryPremium,
            closePremium: t.closePremium,
            pnlDollar: t.pnlDollar,
            reason: t.reason,
            exitOrderId: t._exitOrderId || null,
          })),
        },
        diff: null,
        realizedPnl: null,
        optionOrders: null,
        errors: {},
      };
      try {
        out.portfolio = extractRobinhoodPortfolioFields(await robinhood.getPortfolio());
      } catch (e) {
        out.errors.portfolio = e.message;
      }
      try {
        const brokerHist = await robinhood.getPnlTradeHistory({ span });
        out.diff = diffRobinhoodTradeHistory(rhAcct?.state?.history || [], brokerHist);
        out.brokerPnlRaw = brokerHist;
      } catch (e) {
        out.errors.pnlTradeHistory = e.message;
      }
      try {
        out.realizedPnl = await robinhood.getRealizedPnl({ span: span === "all" ? "year" : span, assetClasses: ["option"] });
      } catch (e) {
        out.errors.realizedPnl = e.message;
      }
      try {
        const ordersRes = await robinhood.getOptionsOrders({});
        const raw = ordersRes?.data ?? ordersRes;
        const orders = Array.isArray(raw) ? raw
          : Array.isArray(raw?.orders) ? raw.orders
            : Array.isArray(raw?.results) ? raw.results : [];
        out.optionOrders = {
          count: orders.length,
          filled: orders.filter(o => String(o.state || "").toLowerCase() === "filled"
            || Number(o.processed_quantity || o.cumulative_quantity || 0) > 0).length,
          orders: orders.slice(0, 100).map(o => ({
            id: o.id || o.order_id || null,
            state: o.state || null,
            chain_symbol: o.chain_symbol || o.symbol || null,
            side: o.legs?.[0]?.side || o.side || null,
            position_effect: o.legs?.[0]?.position_effect || o.position_effect || null,
            quantity: o.quantity || o.processed_quantity || null,
            average_price: o.average_price || o.premium || null,
            created_at: o.created_at || null,
            updated_at: o.updated_at || null,
          })),
        };
      } catch (e) {
        out.errors.optionOrders = e.message;
      }
      const cash = out.local.cash;
      const start = out.local.startingCash;
      const histPnl = out.local.historyPnl;
      if (typeof cash === "number" && typeof start === "number" && typeof histPnl === "number") {
        out.cashGapVsHistory = +((cash - (start + histPnl))).toFixed(2);
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(out));
      return;
    }

    // ─── Robinhood: Get Historicals ───
    if (pathname === "/api/rh-historicals") {
      const sym = url.searchParams.get("symbol");
      if (!sym) { res.writeHead(400); res.end(JSON.stringify({ error: "symbol required" })); return; }
      const span = url.searchParams.get("span") || "year";
      const interval = url.searchParams.get("interval") || "day";
      try {
        const hist = await robinhood.getHistoricals(sym, span, interval);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(hist));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood Page (PIN-protected) ───
    if (pathname === "/robinhood") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(robinhoodPageHTML({ spectator }));
      return;
    }

    // ─── Tradier Page ───
    if (pathname === "/tradier") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(tradierPageHTML({ spectator }));
      return;
    }

    // ─── Media Studio page ───
    if (pathname === "/media") {
      const featured = (url.searchParams.get("ticker") || "").toUpperCase() || null;
      // Make sure the featured ticker has data so its card/chart render even if it wasn't scanned.
      if (featured) {
        try {
          if (!dashboard.candles[featured] && apiKey) dashboard.candles[featured] = await fetchCandles(featured, apiKey);
          if (!dashboard.quotes[featured] && apiKey) dashboard.quotes[featured] = await fetchQuote(featured, apiKey);
          if (dashboard.candles[featured] && !dashboard.analyses[featured]) {
            const a = runAnalysis(dashboard.candles[featured]); if (a) dashboard.analyses[featured] = a;
            const st = runShortTermAnalysis(dashboard.candles[featured]); if (st) dashboard.shortTermAnalyses[featured] = st;
          }
          if (dashboard.candles[featured] && !activeAcct.candleCache[featured]) activeAcct.candleCache[featured] = dashboard.candles[featured];
        } catch (e) { log(activeAcct, `WARN: media featured fetch ${featured} — ${e.message}`); }
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(mediaPageHTML(activeAcct, { spectator, featured }));
      return;
    }

    // ─── Media: account equity-curve PNG (growth flex chart) ───
    if (pathname === "/media/account-chart") {
      try {
        const png = renderEquityCurvePNG(activeAcct);
        if (!png) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not enough history yet"); return; }
        const headers = { "Content-Type": "image/png", "Cache-Control": "no-store" };
        if (url.searchParams.get("dl")) headers["Content-Disposition"] = `attachment; filename="${activeAcct.id}-growth.png"`;
        res.writeHead(200, headers);
        res.end(png);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Chart error: ${e.message}`);
      }
      return;
    }

    // ─── Media: trade-recap chart PNG (candles + IN/OUT markers) ───
    if (pathname === "/media/recap-chart") {
      try {
        const t = findClosedTrade(activeAcct, url.searchParams.get("key") || "");
        if (!t) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Trade not found"); return; }
        const sym = t.ticker;
        if (!dashboard.candles[sym] && apiKey) { try { dashboard.candles[sym] = await fetchCandles(sym, apiKey); } catch { } }
        if (!dashboard.quotes[sym] && apiKey) { try { dashboard.quotes[sym] = await fetchQuote(sym, apiKey); } catch { } }
        if (dashboard.candles[sym] && !dashboard.analyses[sym]) {
          const a = runAnalysis(dashboard.candles[sym]); if (a) dashboard.analyses[sym] = a;
          const stz = runShortTermAnalysis(dashboard.candles[sym]); if (stz) dashboard.shortTermAnalyses[sym] = stz;
        }
        const candles = activeAcct.candleCache[sym] || dashboard.candles[sym];
        const png = renderRecapChartPNG(activeAcct, t, candles, dashboard);
        if (!png) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("No chart"); return; }
        const headers = { "Content-Type": "image/png", "Cache-Control": "no-store" };
        if (url.searchParams.get("dl")) headers["Content-Disposition"] = `attachment; filename="${t.ticker}-recap.png"`;
        res.writeHead(200, headers);
        res.end(png);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Chart error: ${e.message}`);
      }
      return;
    }

    // ─── Media: share-chart PNG (candles + EMAs + trigger/target projection) ───
    const mediaChartMatch = pathname.match(/^\/media\/chart\/([A-Z.]+)$/);
    if (mediaChartMatch) {
      const sym = mediaChartMatch[1];
      try {
        if (!dashboard.candles[sym] && apiKey) dashboard.candles[sym] = await fetchCandles(sym, apiKey);
        if (!dashboard.quotes[sym] && apiKey) dashboard.quotes[sym] = await fetchQuote(sym, apiKey);
        if (dashboard.candles[sym] && !dashboard.analyses[sym]) {
          const a = runAnalysis(dashboard.candles[sym]); if (a) dashboard.analyses[sym] = a;
          const st = runShortTermAnalysis(dashboard.candles[sym]); if (st) dashboard.shortTermAnalyses[sym] = st;
        }
        const candles = activeAcct.candleCache[sym] || dashboard.candles[sym];
        const analysis = dashboard.analyses[sym];
        const st = dashboard.shortTermAnalyses[sym];
        const quote = dashboard.quotes[sym];
        const idea = buildMediaIdea(sym, analysis, st, quote, candles);
        const png = renderChartPNG((candles || []).slice(-60), sym, analysis, st, quote, idea ? {
          projection: { trigger: idea.trigger, target: idea.target, isCall: idea.isCall, expLabel: idea.expLabel, contract: idea.contract },
        } : {});
        if (!png) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("No chart"); return; }
        const headers = { "Content-Type": "image/png", "Cache-Control": "no-store" };
        if (url.searchParams.get("dl")) headers["Content-Disposition"] = `attachment; filename="${sym}-chart.png"`;
        res.writeHead(200, headers);
        res.end(png);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Chart error: ${e.message}`);
      }
      return;
    }

    // ─── Media: post to X (caption + optional projection chart) ───
    if (req.method === "POST" && pathname === "/api/media/post") {
      if (spectator) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "Spectator mode: posting disabled" })); return; }
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const { ticker, text, chart, account, recapKey } = JSON.parse(body || "{}");
          if (!text || !text.trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "No text to post" })); return; }
          let png = null;
          if (account) {
            png = renderEquityCurvePNG(activeAcct);
          } else if (recapKey) {
            const t = findClosedTrade(activeAcct, recapKey);
            if (t) {
              const candles = activeAcct.candleCache[t.ticker] || dashboard.candles[t.ticker];
              png = renderRecapChartPNG(activeAcct, t, candles, dashboard);
            }
          } else if (chart && ticker) {
            const candles = activeAcct.candleCache[ticker] || dashboard.candles[ticker];
            const idea = buildMediaIdea(ticker, dashboard.analyses[ticker], dashboard.shortTermAnalyses[ticker], dashboard.quotes[ticker], candles);
            png = renderChartPNG((candles || []).slice(-60), ticker, dashboard.analyses[ticker], dashboard.shortTermAnalyses[ticker], dashboard.quotes[ticker], idea ? {
              projection: { trigger: idea.trigger, target: idea.target, isCall: idea.isCall, expLabel: idea.expLabel, contract: idea.contract },
            } : {});
          }
          const live = ENABLE_TWEETS && xClient;
          if (live && !canTweet()) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: `Daily X cap reached (${X_DAILY_CAP})` })); return; }
          await tweetWithChart(text.trim(), png);
          log(activeAcct, `MEDIA POST${ticker ? ` ${ticker}` : ""}: ${live ? "posted to X" : "dry-run (X not configured)"}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: live ? `Posted to X${png ? " with chart" : ""}` : "Dry-run: logged (X not configured)" }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: `Error: ${e.message}` }));
        }
      });
      return;
    }

    // ─── Media: LLM rewrite (Haiku) — turns the templated draft into a varied, insightful post ───
    if (req.method === "POST" && pathname === "/api/media/rewrite") {
      if (spectator) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "Spectator mode: rewrite disabled" })); return; }
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const { kind, ticker, key } = JSON.parse(body || "{}");
          const prompt = buildMediaRewritePrompt(activeAcct, kind, (ticker || "").toUpperCase(), key || null);
          if (!prompt) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "Nothing to rewrite (no data for that item)" })); return; }
          const max = kind === "account" ? 500 : kind === "plan" ? 600 : 360;
          let text = await callClaude(prompt, 2, max);
          text = String(text || "").trim().replace(/^["']|["']$/g, "").replace(/#\w+/g, "").replace(/[ \t]+\n/g, "\n").trim();
          if (!text) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: "Empty response — try again" })); return; }
          log(activeAcct, `MEDIA REWRITE ${kind}${ticker ? ` ${ticker}` : ""} via ${getLLMLabel()}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, text }));
        } catch (e) {
          const msg = /API key|not set/i.test(e.message) ? "LLM not configured (set CLAUDE_API_KEY)" : `Error: ${e.message}`;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: msg }));
        }
      });
      return;
    }

    // ─── Simulator page ───
    const simParam = url.searchParams.get("sim");
    if (simParam) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(simulatorPageHTML(simParam));
      return;
    }

    // Dashboard HTML
    await refreshBrokerBalances(activeAcct, { logErrors: true });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHTML(activeAcct, { spectator }));
  });

  server.listen(DASH_PORT, () => { console.log(`  Dashboard running at http://localhost:${DASH_PORT}`); });
  server.on("error", (e) => { if (e.code === "EADDRINUSE") { console.log(`  WARN: Port ${DASH_PORT} in use, trying ${DASH_PORT + 1}`); server.listen(DASH_PORT + 1); } });
}

// ─── Shared Market Data Fetch (rate limit protection) ───

async function fetchSharedMarketData(apiKey, sharedCandleCache) {
  // Collect union of all accounts' tickers
  const allTickers = new Set();
  for (const [, acct] of accounts) {
    if (acct.paused) {
      // Still need quotes for open positions so exits can fire
      for (const p of acct.state.positions) allTickers.add(p.ticker);
      continue;
    }
    // Refresh watchlist for each account first
    await refreshWatchlist(acct);
    for (const t of getActiveTickers(acct)) allTickers.add(t);
    // Also include position tickers
    for (const p of acct.state.positions) allTickers.add(p.ticker);
  }

  const tickerList = [...allTickers];
  const sharedQuotes = {};

  // Batch quotes via Tradier (25 symbols/call) — ~4s for 106 tickers vs ~16s sequential.
  if (tradier.isConnected && tickerList.length > 0) {
    const BATCH = 25;
    for (let i = 0; i < tickerList.length; i += BATCH) {
      try {
        const batch = tickerList.slice(i, i + BATCH);
        const qs = await tradier.getQuotes(batch);
        Object.assign(sharedQuotes, qs);
      } catch { }
      if (i + BATCH < tickerList.length) await delay(apiDelay());
    }
  }
  // Fallback / fill gaps one at a time
  for (const ticker of tickerList) {
    if (sharedQuotes[ticker]?.c > 0) continue;
    try {
      sharedQuotes[ticker] = await fetchQuote(ticker, apiKey);
      await delay(apiDelay());
    } catch { }
  }

  // Fetch candles for tickers not already cached (parallel chunks of 6)
  const needCandles = tickerList.filter(t => !sharedCandleCache[t]);
  const CHUNK = 6;
  for (let i = 0; i < needCandles.length; i += CHUNK) {
    const chunk = needCandles.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async ticker => {
      try {
        sharedCandleCache[ticker] = await fetchCandles(ticker, apiKey);
      } catch { }
    }));
    if (i + CHUNK < needCandles.length) await delay(apiDelay());
  }
  for (const ticker of tickerList) {
    if (sharedCandleCache[ticker] && sharedQuotes[ticker]) {
      // Update latest candle with current quote
      const q = sharedQuotes[ticker];
      const last = sharedCandleCache[ticker][sharedCandleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }

  return { sharedQuotes, tickerList };
}

// ─── Broker (Tradier) Live Account Helpers ───

// Extract usable cash from a Tradier balances object. Account type varies (cash / margin),
// so the buying-power field lives in different places. Prefer option buying power when present.
// Parse a Tradier balances object into the figures the bot trades on. The guiding rule for a CASH
// account is: only ever deploy SETTLED cash (cash_available), never unsettled proceeds — that is
// exactly what prevents Good-Faith Violations. We also surface account type + unsettled funds so
// the dashboard can show them and warn if the account isn't actually a cash account.
function brokerBalanceInfo(bal, cfg = {}) {
  if (!bal) return null;
  const num = v => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const firstNumber = (...vals) => vals.find(v => typeof v === "number") ?? null;
  const firstPositive = (...vals) => vals.find(v => typeof v === "number" && v > 0) ?? firstNumber(...vals);
  const accountType = String(bal.account_type || (bal.cash ? "cash" : bal.margin ? "margin" : "")).toLowerCase() || "unknown";
  const unsettledCash = num(bal.cash?.unsettled_funds) ?? num(bal.unsettled_funds) ?? 0;
  const totalCash = num(bal.total_cash);
  const totalEquity = num(bal.total_equity);
  const rawOptionBuyingPower = num(bal.margin?.option_buying_power) ?? num(bal.option_buying_power);
  const stockBuyingPower = num(bal.margin?.stock_buying_power) ?? num(bal.stock_buying_power);
  const marginCashAvailable = num(bal.margin?.cash_available) ?? num(bal.cash?.cash_available) ?? num(bal.cash_available);

  let settledCash;
  let marginSpendLimit = null;
  if (accountType === "cash") {
    // cash_available is settled buying power; total_cash includes unsettled, so prefer the former.
    settledCash = num(bal.cash?.cash_available) ?? num(bal.cash_available) ?? totalCash;
  } else {
    const zeroCashSpendLimit = Math.max(0, Number(cfg.marginZeroCashSpendLimit ?? DEFAULT_CONFIG.marginZeroCashSpendLimit ?? 200) || 0);
    const maxDebt = Math.max(0, Number(cfg.marginMaxDebt ?? DEFAULT_CONFIG.marginMaxDebt ?? 250) || 0);
    const cashBase = firstNumber(marginCashAvailable, totalCash, 0) ?? 0;
    marginSpendLimit = Math.max(0, Math.min(cashBase + zeroCashSpendLimit, cashBase + maxDebt));
    const brokerBuyingPower = firstPositive(rawOptionBuyingPower, marginCashAvailable, totalCash, stockBuyingPower);
    // Tradier margin accounts can report option_buying_power as literal 0 even while cash is usable.
    // Use positive cash/BP first, then fall back to the explicit capped margin spend limit.
    settledCash = (typeof brokerBuyingPower === "number" && brokerBuyingPower > 0)
      ? Math.min(brokerBuyingPower, marginSpendLimit || brokerBuyingPower)
      : marginSpendLimit;
  }

  const optionBuyingPower = settledCash;

  return {
    accountType,
    buyingPower: settledCash,   // what the bot is allowed to deploy
    settledCash,
    unsettledCash,
    totalCash,
    totalEquity,
    optionBuyingPower,
    rawOptionBuyingPower,
    stockBuyingPower,
    marginCashAvailable,
    marginSpendLimit,
    marginZeroCashSpendLimit: cfg.marginZeroCashSpendLimit ?? DEFAULT_CONFIG.marginZeroCashSpendLimit,
    marginMaxDebt: cfg.marginMaxDebt ?? DEFAULT_CONFIG.marginMaxDebt,
  };
}
function brokerCashFromBalances(bal, cfg = {}) {
  const info = brokerBalanceInfo(bal, cfg);
  return info ? info.buyingPower : null;
}

function applyBrokerBalanceInfo(acct, info, { warn = false } = {}) {
  if (!acct || !info) return;
  const state = acct.state;
  if (typeof info.buyingPower === "number") state.cash = info.buyingPower; // settled funds only
  if (typeof info.totalEquity === "number") state.brokerEquity = info.totalEquity;
  state.accountType = info.accountType;
  state.settledCash = info.settledCash;
  state.unsettledCash = info.unsettledCash;
  state.totalCash = info.totalCash;
  state.optionBuyingPower = info.optionBuyingPower;
  state.rawOptionBuyingPower = info.rawOptionBuyingPower;
  state.marginCashAvailable = info.marginCashAvailable;
  state.marginSpendLimit = info.marginSpendLimit;
  state.marginZeroCashSpendLimit = info.marginZeroCashSpendLimit;
  state.marginMaxDebt = info.marginMaxDebt;
  if (warn && info.accountType !== "cash" && state._lastAcctTypeWarned !== info.accountType) {
    log(acct, "⚠️ TRADIER: account type is \"" + info.accountType.toUpperCase() + "\", not CASH — margin/leverage apply. You wanted a cash account.");
    state._lastAcctTypeWarned = info.accountType;
  }
}

async function refreshBrokerBalances(acct, { maxAgeMs = 4000, logErrors = false } = {}) {
  if (!acct || acct.config.broker !== "tradier" || !tradier.isConnected || !tradier.accountId) return null;
  const now = Date.now();
  if (acct._brokerBalanceRefreshPromise) return acct._brokerBalanceRefreshPromise;
  if (acct._brokerBalanceRefreshedAt && now - acct._brokerBalanceRefreshedAt < maxAgeMs) {
    return acct._brokerBalanceInfo || null;
  }
  acct._brokerBalanceRefreshPromise = (async () => {
    try {
      const bal = await tradier.getAccount();
      const info = brokerBalanceInfo(bal, acct.config);
      applyBrokerBalanceInfo(acct, info);
      acct._brokerBalanceInfo = info;
      acct._brokerBalanceRefreshedAt = Date.now();
      return info;
    } catch (e) {
      if (logErrors) log(acct, "TRADIER LIVE REFRESH: balance error — " + e.message);
      return acct._brokerBalanceInfo || null;
    } finally {
      acct._brokerBalanceRefreshPromise = null;
    }
  })();
  return acct._brokerBalanceRefreshPromise;
}

// Ensure a first-class live account bound to Tradier exists, seeded from the real balance.
// Idempotent: re-running just refreshes the seeded cash; positions are derived each sync.
async function ensureTradierAccount() {
  if (!tradier.isConnected) return;
  let seedCash = null;
  try {
    const bal = await tradier.getAccount();
    seedCash = brokerCashFromBalances(bal);
  } catch (e) { console.log(`  Tradier: balance fetch failed during provision — ${e.message}`); }

  if (accounts.has("tradier")) {
    const acct = accounts.get("tradier");
    acct.config.broker = "tradier";
    if (acct.config.autoExecute === undefined) acct.config.autoExecute = false;
    if (acct.config.tradeWhenClosed === undefined) acct.config.tradeWhenClosed = tradier.environment === "sandbox";
    if (acct.config.marginZeroCashSpendLimit === undefined) acct.config.marginZeroCashSpendLimit = DEFAULT_CONFIG.marginZeroCashSpendLimit;
    if (acct.config.marginMaxDebt === undefined) acct.config.marginMaxDebt = DEFAULT_CONFIG.marginMaxDebt;

    // Detect environment change (sandbox ↔ production) OR a massive equity mismatch (stale sandbox state)
    const expectedName = `Tradier Live (${tradier.environment})`;
    const envChanged = acct.name !== expectedName;
    const staleEquity = acct.state.brokerEquity > 0 && typeof seedCash === "number" && Math.abs(acct.state.brokerEquity - seedCash) > 5000;
    
    if (envChanged || staleEquity) {
      console.log(`  Tradier: state reset triggered (envChanged=${envChanged}, staleEquity=${staleEquity})`);
      acct.name = expectedName;
      if (typeof seedCash === "number") acct.config.startingCash = seedCash;
      acct.config.tradeWhenClosed = tradier.environment === "sandbox";
      // Clear sandbox positions/history/cached broker state — production data comes from the real broker.
      acct.state.positions = [];
      acct.state.history = [];
      acct.state.meta = {};

      delete acct.state.brokerEquity;
      delete acct.state.settledCash;
      delete acct.state.unsettledCash;
      delete acct.state.totalCash;
      delete acct.state.accountType;
      delete acct.state.reservedBuyingPower;
      delete acct.state.workingOrderCount;
      acct.dashboard.portfolioHistory = [];
      acct.dashboard.positionDetails = [];
      acct.dashboard.decisions = [];
      acct.dashboard.cycleLog = [];
      saveAccounts();
    }

    if (typeof seedCash === "number") acct.state.cash = seedCash;
    console.log(`  Tradier: live account present — cash $${acct.state.cash.toFixed(2)} (${tradier.environment})${acct.config.tradeWhenClosed ? " · trades-when-closed ON" : ""}`);
    return;
  }

  const config = {
    ...DEFAULT_CONFIG,
    broker: "tradier",
    useCashReserve: false, // off by default for the live account; toggle on from settings
    autoExecute: false,    // live execution must be explicitly armed after controls are verified
    // Sandbox accounts trade when closed by default so you can test execution outside market hours.
    tradeWhenClosed: tradier.environment === "sandbox",
    startingCash: typeof seedCash === "number" ? seedCash : DEFAULT_CONFIG.startingCash,
    marginZeroCashSpendLimit: DEFAULT_CONFIG.marginZeroCashSpendLimit,
    marginMaxDebt: DEFAULT_CONFIG.marginMaxDebt,
  };
  const state = {
    cash: typeof seedCash === "number" ? seedCash : DEFAULT_CONFIG.startingCash,
    positions: [],
    history: [],

    meta: {},
  };
  const acct = createAccountRuntime("tradier", `Tradier Live (${tradier.environment})`, config, state);
  accounts.set("tradier", acct);
  saveAccounts();
  console.log(`  Tradier: provisioned LIVE account ✓ — seeded cash $${state.cash.toFixed(2)} (${tradier.environment}), autoExecute OFF`);
}

// Ensure a first-class live account bound to Robinhood MCP exists.
async function ensureRobinhoodAccount() {
  let seedCash = null;
  if (robinhood.isConnected) {
    try {
      const portRes = await robinhood.getPortfolio();
      const fields = extractRobinhoodPortfolioFields(portRes);
      // Prefer full account value; never let equity_value="0" (stock sleeve) overwrite buying power.
      if (fields.buyingPower != null && fields.buyingPower >= 0) seedCash = fields.buyingPower;
      if (fields.totalEquity != null && fields.totalEquity > 0) seedCash = fields.totalEquity;
    } catch (e) {
      console.log(`  Robinhood: balance fetch failed during provision — ${e.message}`);
    }
  }

  if (accounts.has("robinhood")) {
    const acct = accounts.get("robinhood");
    acct.config.broker = "robinhood";
    if (acct.config.autoExecute === undefined) acct.config.autoExecute = false;

    if (typeof seedCash === "number") {
      // seedCash here is equity (preferred) or buying power — never overwrite spendable cash with
      // total equity. Cash is refreshed properly in syncRobinhoodAccount from buying_power.
      if (typeof acct.state.brokerEquity !== "number" || acct.state.brokerEquity <= 0) {
        acct.state.brokerEquity = seedCash;
        acct.state.lastBrokerEquity = seedCash;
      }
      // Only seed the capital base on a brand-new account. Later deposits are handled by
      // reconcileBrokerCapital / Settings — overwriting here made deposits look like profit.
      if (acct.state.positions.length === 0 && acct.state.history.length === 0
          && !(acct.config.startingCash > DEFAULT_CONFIG.startingCash) && seedCash > 0) {
        acct.config.startingCash = seedCash;
      }
    }
    // One-time repair: early RH accounts seeded startingCash at ~$100 while the user later
    // funded ~$850. That made deposits read as +700% "profit". Snap the zero-point once.
    if (!acct.state._capitalRepaired850
        && (acct.config.startingCash || 0) > 0 && (acct.config.startingCash || 0) < 300
        && ((acct.state.brokerEquity || 0) > 500 || (acct.state.history || []).length > 0)) {
      setCapitalBase(acct, 850, { note: "one-time repair: ~$850 total deposits" });
      acct.state._capitalRepaired850 = true;
    }

    // Guard: startingCash must be > 0 to avoid +Infinity% P&L
    if (!(acct.config.startingCash > 0)) acct.config.startingCash = DEFAULT_CONFIG.startingCash;
    ensureCapitalPreservationTrack(acct);
    console.log(`  Robinhood: live account present — cash $${(acct.state.cash || 0).toFixed(2)} (capital base $${acct.config.startingCash})`);
    return;
  }

  const safeSeed = (typeof seedCash === "number" && seedCash > 0) ? seedCash : DEFAULT_CONFIG.startingCash;
  const config = {
    ...DEFAULT_CONFIG,
    broker: "robinhood",
    useCashReserve: false,
    autoExecute: false,
    startingCash: safeSeed,
  };
  const state = {
    cash: safeSeed,
    positions: [],
    history: [],
    meta: {},
  };
  const acct = createAccountRuntime("robinhood", `Robinhood Live`, config, state);
  accounts.set("robinhood", acct);
  ensureCapitalPreservationTrack(acct);
  saveAccounts();
  console.log(`  Robinhood: provisioned LIVE account ✓ — seeded cash $${state.cash.toFixed(2)}, autoExecute OFF (arm explicitly after verification)`);
}

const ORDER_DONE_STATUSES = ["filled", "canceled", "cancelled", "rejected", "expired", "error"];

// Returns the list of currently WORKING (unfilled) Tradier orders, normalized.
async function brokerWorkingOrders(acct) {
  if (acct.config.broker !== "tradier" || !tradier.isConnected) return [];
  try {
    const orders = await tradier.getOrders();
    return orders
      .filter(o => !ORDER_DONE_STATUSES.includes((o.status || "").toLowerCase()))
      .map(o => {
        const occ = o.option_symbol || o.symbol || "";
        const parsed = tradier.parseOCC(occ);
        const requestedQty = Math.round(Math.abs(Number(o.quantity) || 0));
        const executedQty = Math.round(Math.abs(Number(o.exec_quantity ?? o.executed_quantity) || 0));
        const explicitRemaining = Number(o.remaining_quantity ?? o.pending_quantity);
        const qty = Number.isFinite(explicitRemaining)
          ? Math.round(Math.max(0, Math.abs(explicitRemaining)))
          : Math.max(0, requestedQty - executedQty);
        const price = o.price ?? o.avg_fill_price ?? null;
        return {
          id: o.id,
          status: (o.status || "").toLowerCase(),
          side: (o.side || "").toLowerCase(),
          occ,
          ticker: parsed ? parsed.ticker : occ.toUpperCase(),
          parsed,
          qty,
          requestedQty,
          executedQty,
          remainingQuantity: qty,
          price,
          createDate: o.create_date ? new Date(o.create_date).getTime() : null,
          reserved: parsed && price ? qty * price * 100 : 0,
        };
      });
  } catch (e) { log(acct, `TRADIER: open-orders check failed — ${e.message}`); return []; }
}

// Set of underlying tickers that currently have an OPEN (unfilled/working) Tradier order.
// Used to de-dupe so we don't fire a second entry/exit while one is still working.
async function brokerOpenOrderTickers(acct) {
  const tickers = new Set();
  for (const o of await brokerWorkingOrders(acct)) tickers.add(o.ticker.toUpperCase());
  return tickers;
}

// How many distinct underlyings the account is effectively committed to: filled positions PLUS
// working (unfilled) orders. Counting working orders prevents the bot from stacking new orders
// every cycle while earlier limit orders are still unfilled (which would drain buying power).
function effectivePositionCount(acct) {
  const tickers = new Set(acct.state.positions.filter(p => !p._pending).map(p => p.ticker.toUpperCase()));
  if (acct._inflightTickers) for (const t of acct._inflightTickers) tickers.add(t);
  return tickers.size;
}

// Place a real buy_to_open on Tradier for a bot entry decision. Broker is the source of truth,
// so we pre-seed side-metadata (entry context) keyed by OCC and let the next sync surface the fill.
async function placeBrokerEntry(acct, { ticker, type, strike, expiryDate, expiryStr = null, dte, qty, premium, direction, bid = null, ask = null, setupQuality = 0, claudeConfidence = 0, aiThesis = null, maxBudget = null, entryEpoch = null }) {
  const expStr = expiryStr || new Date(expiryDate).toISOString().slice(0, 10);
  const occ = tradier.buildOCC(ticker, expStr, type, strike);

  // In-flight de-dupe: skip if a working order already exists for this underlying. The set is
  // refreshed once per cycle in syncBrokerAccount; fall back to a fresh fetch if unavailable.
  const inFlight = acct._inflightTickers || await brokerOpenOrderTickers(acct);
  if (inFlight.has(ticker.toUpperCase())) {
    return { skipped: true, reason: `Tradier: working order already open for ${ticker} — skipping duplicate entry` };
  }

  if (!acct.config.autoExecute) {
    return { skipped: true, reason: `Tradier: autoExecute off — entry for ${ticker} not sent (enable on the account)` };
  }
  const initialCommitBlock = liveEntryCommitBlock(acct, entryEpoch);
  if (initialCommitBlock) return { skipped: true, reason: `Tradier commit blocked: ${initialCommitBlock}` };

  // Commit-time exact-OCC re-quote. Ranking can take seconds across several candidates; never send
  // an order using the earlier chain snapshot or a last/mid fallback without a two-sided market.
  try {
    const fresh = await tradier.getOptionQuote(occ);
    if (!fresh || !fresh.twoSided || fresh.tradeable === false) {
      return { skipped: true, reason: `Tradier: ${occ} has no current tradeable two-sided quote — ranked package is stale` };
    }
    bid = fresh.bid;
    ask = fresh.ask;
    premium = fresh.mid;
  } catch (e) {
    return { skipped: true, reason: `Tradier: exact-contract re-quote failed for ${occ}: ${e.message}` };
  }

  const frictionPct = ((ask - bid) + (2 * FEE_PER_CONTRACT / 100)) / ask;
  const maxFrictionPct = Math.min(0.15, Math.max(0.06, 0.5 * (acct.config.profitTarget || 0.12)));
  if (!Number.isFinite(frictionPct) || frictionPct > maxFrictionPct) {
    return { skipped: true, reason: `Tradier: ${occ} executable friction ${(frictionPct * 100).toFixed(1)}% now exceeds ${(maxFrictionPct * 100).toFixed(1)}% — ranked edge disappeared` };
  }

  const conviction = Math.max(0, Math.min(1, (claudeConfidence || 0) / 100));
  const maxOverpayPct = Math.min(MAX_ENTRY_OVERPAY_PCT, Math.max(0.03, (acct.config.profitTarget || 0.40) * 0.4));
  const limit = entryLimitPrice(bid, ask, premium, conviction, { maxOverpayPct });
  const hardBudget = Math.min(
    maxBudget != null ? maxBudget : Infinity,
    acct.state.cash,
    acct.config.maxTradeSize || 500,
  );
  const livePv = portfolioValue(acct.state, acct.dashboard?.quotes || {});
  const liveRiskDecision = sizeLongOptionEntry({
    accountEquity: livePv,
    cash: Math.min(acct.state.cash, hardBudget),
    entryPrice: limit,
    stopLossPct: acct.config.stopLoss,
    profitTargetPct: Math.min(
      acct.config.profitTarget,
      acct.config.singleContractBankPct ?? acct.config.profitTarget,
    ),
    minimumRewardRisk: acct.config.minimumRewardRisk ?? 1.5,
    riskPerTradePct: acct.config.riskPerTradePct ?? 0.005,
    maxPositionPct: acct.config.maxPositionPct ?? 0.10,
    maxPositionDollars: acct.config.maxTradeSize || 500,
    aggregateRiskBudgetDollars: livePv * (acct.config.maxPortfolioRiskPct ?? 0.02),
    openRiskDollars: estimatedOpenRiskDollars(acct),
    exitFrictionDollarsPerContract: Math.max(0, ask - bid) * 50,
    entryFeePerContract: FEE_PER_CONTRACT,
    exitFeePerContract: FEE_PER_CONTRACT,
  });
  if (!liveRiskDecision.approved) {
    return { skipped: true, reason: `Tradier commit risk ${liveRiskDecision.reasonCode}: ${liveRiskDecision.reason}` };
  }
  qty = Math.min(qty, liveRiskDecision.quantity, Math.floor(hardBudget / (limit * 100)));
  if (qty < 1) {
    return { skipped: true, reason: `Tradier: refreshed ${occ} limit $${limit.toFixed(2)} no longer fits $${hardBudget.toFixed(0)} budget` };
  }

  // Seed metadata so the post-fill sync keeps entry context (stops/trails depend on it).
  if (!acct.state.meta) acct.state.meta = {};
  acct.state.meta[occ] = {
    entryPremium: +limit.toFixed(2),
    entrySpot: acct.dashboard?.quotes?.[ticker]?.c ?? null,
    dte,
    originalQty: qty,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,
    bestPnlPct: 0,
    bestExitPnlPct: 0,
    managementPlan: createManagementPlan(acct.config, { type, dte }),
    entryAtrPct: acct.dashboard?.analyses?.[ticker]?.atrPct ?? null,
    setupQuality,
    plannedRiskDollars: +(liveRiskDecision.metrics.maxLossPerContract * qty).toFixed(2),
    riskGovernor: {
      version: 1,
      reasonCode: liveRiskDecision.reasonCode,
      rewardRiskRatio: liveRiskDecision.metrics.rewardRiskRatio,
      maxLossPerContract: liveRiskDecision.metrics.maxLossPerContract,
      tradeRiskBudgetDollars: liveRiskDecision.metrics.tradeRiskBudgetDollars,
      aggregateRiskRemainingDollars: liveRiskDecision.metrics.aggregateRiskRemainingDollars,
    },
    // Persist the full AI thought process so it survives the broker round-trip and shows up on the
    // live position (and later in trade history) exactly like paper trades.
    ai: aiThesis || null,
  };

  const finalCommitBlock = liveEntryCommitBlock(acct, entryEpoch);
  if (finalCommitBlock) {
    delete acct.state.meta[occ];
    return { skipped: true, reason: `Tradier commit blocked: ${finalCommitBlock}` };
  }
  // Intent must survive a process restart before the broker call can accept the order.
  saveAccountsStrict();
  try {
    // Conviction-aware fill was computed from the fresh quote above.
    const aggrLabel = limit >= (ask || limit) ? "at ask" : limit > premium ? "toward ask" : "at mid";
    const res = await tradier.placeOptionOrder(ticker, expStr, type, strike, "buy_to_open", qty, "limit", limit);
    // Mark this underlying in-flight so the rest of THIS cycle counts it toward maxPositions
    // (via effectivePositionCount) and won't place a duplicate. The next sync reconciles fully.
    if (!acct._inflightTickers) acct._inflightTickers = new Set();
    acct._inflightTickers.add(ticker.toUpperCase());
    reserveInflightExpiry(acct, ticker, expiryDate);
    log(acct, `TRADIER ENTRY: BUY ${qty}x ${occ} @ $${limit} (${aggrLabel}; conviction ${(conviction * 100).toFixed(0)}%; bid ${bid ?? "?"}/ask ${ask ?? "?"}/mid ${premium}) — order ${res?.id || JSON.stringify(res).slice(0, 80)}`);

    // Optimistic in-cycle cash decrement so additional entries this cycle size off remaining
    // buying power. Reconciled (overwritten) by the next syncBrokerAccount. No placeholder
    // position is pushed — working orders are surfaced as pending positions during sync instead.
    const totalCost = qty * limit * 100; // worst-case fill (limit) so further sizing this cycle is conservative
    acct.state.cash = Math.max(0, acct.state.cash - totalCost);

    const dg = aiThesis?.contractDowngraded || null;
    diag("entry", acct, {
      ticker, type, strike, dte, qty, occ,
      intendedLimit: +limit.toFixed(2), mid: +(+premium).toFixed(2), bid, ask,
      spreadPct: (bid > 0 && ask > 0) ? +(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(0) : null,
      delta: aiThesis?.orderedContract?.delta ?? null,
      conviction: Math.round((conviction || 0) * 100), setupQuality,
      downgraded: dg ? { fromStrike: dg.from?.strike, fromMid: dg.from?.mid, toStrike: dg.to?.strike, toMid: dg.to?.mid, budget: dg.budget } : null,
    });

    return { ticker, type, strike, dte, qty, entryPremium: +limit.toFixed(2), cost: totalCost, direction, optionsSource: "tradier", setupQuality, claudeConfidence, brokerOrder: true };
  } catch (e) {
    delete acct.state.meta[occ];
    log(acct, `TRADIER ENTRY FAILED ${ticker}: ${e.message}`);
    return { skipped: true, reason: `Tradier entry rejected: ${e.message}` };
  }
}

// Place a real sell_to_close on Tradier. Broker is the source of truth: we record the trade to
// history and log it, but DO NOT mutate state.cash/state.positions — the next
// sync reconciles. Returns null so exit-loop callers keep the position until the fill is confirmed.
function placeBrokerExit(acct, pos, currentPremium, reason, qty, pnlPct, pnlDollar, execution = {}) {
  const state = acct.state;
  const ticker = pos.ticker;

  // In-flight de-dupe (set refreshed once per cycle in syncBrokerAccount) prevents a second
  // sell order while a working one exists or was placed earlier this cycle.
  if (!acct._inflightTickers) acct._inflightTickers = new Set();
  if (acct._inflightTickers.has(ticker.toUpperCase())) {
    log(acct, `TRADIER: working order already open for ${ticker} — skipping duplicate exit`);
    return null;
  }
  if (!acct.config.autoExecute) {
    log(acct, `TRADIER: autoExecute off — exit for ${ticker} not sent`);
    return null;
  }

  acct._inflightTickers.add(ticker.toUpperCase());

  // Honor the lifecycle manager's explicit price mandate. In particular, a profit-bank decision
  // was evaluated on the executable bid and must submit at that bid; replacing it with a midpoint
  // order turns a reached target into an unfilled wish while the gain can reverse.
  const bid = typeof pos.liveBid === "number" && pos.liveBid > 0 ? pos.liveBid : null;
  const ask = typeof pos.liveAsk === "number" && pos.liveAsk > 0 ? pos.liveAsk : null;
  const mid = (bid != null && ask != null && ask >= bid) ? (bid + ask) / 2
            : (typeof pos.liveMark === "number" && pos.liveMark > 0 ? pos.liveMark : currentPremium);
  const spreadPct = (bid != null && ask != null && mid > 0) ? (ask - bid) / mid : 0;
  const protective = execution.urgency === "protective" || execution.urgency === "urgent"
    || pnlPct <= 0 || /stop|critical|expir|reversed|breakeven|low-dte|theta/i.test(reason);
  const urgent = execution.urgency === "urgent" || /critical|expir|low-dte/i.test(reason);
  const priceMode = execution.priceMode || (urgent ? "marketable" : protective ? "patient" : "patient");
  const pricing = chooseOptionSellLimit({
    bid,
    ask,
    mark: pos.liveMark,
    referencePrice: currentPremium,
    priceMode,
    protective,
    exitAttempts: 0,
    wideSpreadPct: WIDE_SPREAD_EXIT_PCT,
    maxConcessionPct: MAX_EXIT_CONCESSION_PCT,
  });
  if (!(pricing.limit > 0)) {
    acct._inflightTickers.delete(ticker.toUpperCase());
    log(acct, `TRADIER EXIT BLOCKED ${ticker}: no executable bid for ${priceMode} exit — ${reason}`);
    return null;
  }
  const limit = pricing.limit;
  if (protective && pricing.spreadPct > WIDE_SPREAD_EXIT_PCT && priceMode === "patient") {
    log(acct, `TRADIER EXIT ${ticker}: wide market (${(spreadPct * 100).toFixed(0)}% spread) — working guarded protective limit $${limit} vs bid $${bid ?? "?"}`);
  }

  // Record an unresolved intent only. Realized P&L, streak/cooldown state, notifications, and the
  // durable trade log are updated exclusively from an authoritative broker fill below.
  // Use the EXACT held OCC symbol so we can never target the wrong contract via reconstruction.
  const occForExit = pos.occSymbol || tradier.buildOCC(ticker, new Date(pos.expiryDate).toISOString().slice(0, 10), pos.type, pos.strike);
  const occForTrade = occForExit;
  if (!state.meta) state.meta = {};
  if (!state.meta[occForExit]) state.meta[occForExit] = {};
  const exitMeta = state.meta[occForExit];
  const requestedTrimLevel = execution.reasonCode === "TRIM_1" ? 1
    : execution.reasonCode === "TRIM_2" ? 2
      : execution.reasonCode === "EMA8_TRIM" ? 3 : null;
  if (qty < pos.qty && requestedTrimLevel != null) {
    if ((Number(exitMeta.trimLevel) || 0) >= requestedTrimLevel) {
      acct._inflightTickers.delete(ticker.toUpperCase());
      log(acct, `TRADIER EXIT BLOCKED ${ticker}: trim tier ${requestedTrimLevel} is already complete`);
      return null;
    }
    if (exitMeta.trimPendingLevel === requestedTrimLevel && exitMeta.trimPendingTargetQty > 0) {
      const remainingTrimQty = Math.max(
        0,
        Number(exitMeta.trimPendingTargetQty) - (Number(exitMeta.trimPendingFilledQty) || 0),
      );
      qty = Math.min(qty, remainingTrimQty);
      if (!(qty > 0)) {
        acct._inflightTickers.delete(ticker.toUpperCase());
        log(acct, `TRADIER EXIT BLOCKED ${ticker}: trim tier ${requestedTrimLevel} has no unfilled target quantity`);
        return null;
      }
    } else {
      exitMeta.trimPendingLevel = requestedTrimLevel;
      exitMeta.trimPendingTargetQty = qty;
      exitMeta.trimPendingFilledQty = 0;
    }
    pnlDollar = (currentPremium - pos.entryPremium) * qty * 100;
  }
  const trade = {
    ...pos, qty,
    closePremium: +limit.toFixed(2),   // estimate (submitted limit) until the fill is reconciled
    proceeds: +(limit * qty * 100).toFixed(2),
    pnlDollar, pnlPct, reason, closeDate: getETDateStr(), closeTime: Date.now(),
    _occ: occForTrade,
    _exitSubmittedAt: Date.now(),
    _exitOrderId: null,
    _submittedLimit: +limit.toFixed(2),
    _requestedQty: qty,
    _positionQtyAtSubmit: pos.qty,
    _pendingFill: true,
    _estPnlDollar: pnlDollar,
    _campaignKey: occForTrade,
    _campaignComplete: qty >= pos.qty - 1e-9,
    _trimTargetLevel: requestedTrimLevel,
    _trimTargetQty: requestedTrimLevel != null ? Number(exitMeta.trimPendingTargetQty) || qty : null,
    _entryCostPerContract: pos.cost > 0 && pos.qty > 0
      ? pos.cost / pos.qty
      : (pos.entryPremium || 0) * 100,
  };
  state.history.push(trade);

  // Persist the unresolved exact-OCC intent before the broker request. This remains best-effort:
  // a sell_to_close reduces exposure, so a local disk failure must not suppress a protective exit.
  // When the write succeeds, a restart can still reconcile a fast fill even if the process dies
  // before the broker response supplies its order id.
  saveAccounts();

  tradier.placeOptionOrderByOCC(occForExit, "sell_to_close", qty, "limit", limit)
    .then(res => {
      trade._exitOrderId = brokerOrderId(res);
      trade._orderAcceptedAt = Date.now();
      log(acct, `TRADIER EXIT: SELL ${qty}x ${occForExit} @ $${limit} (${priceMode}) — order ${trade._exitOrderId || "ok"} (${reason})`);
      saveAccounts();
    })
    .catch(e => {
      trade._submissionFailedAt = Date.now();
      acct._inflightTickers.delete(ticker.toUpperCase());
      log(acct, `TRADIER EXIT FAILED ${ticker}: ${e.message}`);
      saveAccounts();
    });
  diag("exit_submit", acct, {
    ticker, occ: occForTrade, reason,
    intendedLimit: +limit.toFixed(2), mid: +mid.toFixed(2), bid, ask,
    spreadPct: +(spreadPct * 100).toFixed(0),
    markSource: pos.markSource || (pos.liveMark != null ? "live" : "model"),
    protective, urgent, qty,
    entryPremium: pos.entryPremium ?? null, estPnl: +pnlDollar.toFixed(0), estPnlPct: +(pnlPct).toFixed(1),
  });

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(acct, `${trimLabel} (LIVE): ${ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);

  return null; // keep position locally; sync reconciles after fill
}

// Reconcile recorded exits against ACTUAL broker fills. placeBrokerExit records an estimated
// close price (the submitted limit); once Tradier reports the order as filled we overwrite the
// trade's close price, proceeds, fees, and P&L with the real numbers so trade history and realized
// P&L reflect what truly happened — not what we hoped for. Also nets out the estimate we had added.
async function reconcileBrokerFills(acct) {
  if (acct.config.broker !== "tradier" || !tradier.isConnected) return;
  const state = acct.state;
  const pending = (state.history || []).filter(t => t._pendingFill && t._occ);
  if (!pending.length) return;

  let orders;
  try { orders = await tradier.getOrders(); } catch { return; }
  const claimedOrderIds = new Set(
    (state.history || [])
      .filter(trade => !trade._pendingFill)
      .map(trade => trade._matchedOrderId || trade._exitOrderId)
      .filter(id => id != null)
      .map(String),
  );

  for (const trade of pending) {
    const submittedAt = trade._exitSubmittedAt || 0;
    let match = matchTradierExitOrder(orders, trade, claimedOrderIds);
    // The account-orders collection is current-session only. After a deploy/restart, yesterday's
    // exact-ID fill may no longer appear there, so retrieve that durable order directly before
    // classifying the intent as unresolved/non-fill. Never use this fallback without an exact id.
    if (!match && trade._exitOrderId != null) {
      try {
        const exactOrder = await tradier.getOrder(trade._exitOrderId);
        match = matchTradierExitOrder(exactOrder ? [exactOrder] : [], trade, claimedOrderIds);
      } catch { }
    }
    if (!match) {
      // Give up after 24h, but never promote an estimate into performance. If a prior snapshot
      // proved a partial fill, preserve only that confirmed quantity; otherwise classify non-fill.
      if (Date.now() - submittedAt > 86_400_000) {
        trade._pendingFill = false;
        if (trade._bookedFillQty > 0) {
          // The terminal order record disappeared, but prior snapshots already proved these fills.
          // Keep the confirmed partial outcome and only mark terminal-state provenance unresolved.
          trade._reconciled = true;
          trade._terminalStateUnresolved = true;
          trade._campaignComplete = false;
          logTrade(trade);
        } else {
          trade._fillUnresolved = true;
          trade._nonFill = true;
          trade._nonFillReason = "no authoritative Tradier execution found within 24h";
          trade.qty = 0;
          trade.closePremium = 0;
          trade.proceeds = 0;
          trade.pnlDollar = 0;
          trade.pnlPct = 0;
        }
      }
      continue;
    }

    const matchId = brokerOrderId(match);
    if (matchId != null) {
      trade._matchedOrderId = matchId;
      if (trade._exitOrderId == null) trade._exitOrderId = matchId;
      claimedOrderIds.add(String(matchId));
    }
    const fill = tradierFillDelta(trade, match, FEE_PER_CONTRACT);
    if (!fill.ok) {
      log(acct, `FILL RECONCILE BLOCKED ${trade.ticker} ${trade._occ}: ${fill.reason}`);
      if (Date.now() - submittedAt > 86_400_000 && !(trade._bookedFillQty > 0)) {
        trade._pendingFill = false;
        trade._fillUnresolved = true;
        trade._nonFill = true;
        trade._nonFillReason = `Tradier execution could not be verified: ${fill.reason}`;
        trade.qty = 0;
        trade.closePremium = 0;
        trade.proceeds = 0;
        trade.pnlDollar = 0;
        trade.pnlPct = 0;
      }
      continue;
    }

    if (!(fill.cumulativeQty > 0)) {
      if (fill.terminal) {
        trade._pendingFill = false;
        trade._nonFill = true;
        trade._nonFillReason = `Tradier order ended ${(match.status || match.state || "terminal")} with zero execution`;
        trade.qty = 0;
        trade.closePremium = 0;
        trade.proceeds = 0;
        trade.pnlDollar = 0;
        trade.pnlPct = 0;
      } else if (Date.now() - submittedAt > 86_400_000) {
        trade._pendingFill = false;
        trade._fillUnresolved = true;
        trade._nonFill = true;
        trade._nonFillReason = "Tradier order remained nonterminal with zero verified execution after 24h";
        trade.qty = 0;
        trade.closePremium = 0;
        trade.proceeds = 0;
        trade.pnlDollar = 0;
        trade.pnlPct = 0;
      }
      continue;
    }

    const est = trade._submittedLimit ?? trade.closePremium;
    if (!state.realizedCampaignPnl) state.realizedCampaignPnl = {};
    if (Math.abs(fill.deltaRealPnl) > 1e-9) {
      state.realizedPnl = (state.realizedPnl || 0) + fill.deltaRealPnl;
      const campaignKey = trade._campaignKey || trade._occ;
      state.realizedCampaignPnl[campaignKey] = (state.realizedCampaignPnl[campaignKey] || 0) + fill.deltaRealPnl;
    }

    // A trim tier advances only from newly executed contracts on this exact OCC/order. A submitted
    // limit, a working remainder, or a terminal partial cancel is not enough. Persist the target
    // across retries so a partially-filled 2-contract trim asks only for its remaining contract
    // instead of repeatedly issuing the full tier or resetting to TRIM_1 forever.
    const trimTargetLevel = Number(trade._trimTargetLevel);
    if (trimTargetLevel > 0 && fill.deltaQty > 0) {
      if (!state.meta) state.meta = {};
      const trimResult = applyTradierTrimFill(state.meta[trade._occ] || {}, trade, fill);
      state.meta[trade._occ] = trimResult.meta;
      if (trimResult.completed) {
        log(acct, `TRADIER SYNC: ${trade.ticker} trim tier ${trimTargetLevel} fully filled from authoritative ${trade._occ} execution`);
      }
    }

    trade.closePremium = +fill.averageFillPrice.toFixed(2);
    trade.proceeds = +fill.netProceeds.toFixed(2);
    trade.exitFees = +fill.exitFees.toFixed(2);
    trade.costBasis = +fill.costBasis.toFixed(2);
    trade.pnlDollar = +fill.cumulativeRealPnl.toFixed(2);
    trade.pnlPct = fill.costBasis > 0 ? fill.cumulativeRealPnl / fill.costBasis : 0;
    trade.filledQty = fill.cumulativeQty;
    trade.qty = fill.cumulativeQty;
    trade._bookedFillQty = fill.cumulativeQty;
    trade._bookedRealPnl = fill.cumulativeRealPnl;

    const fullyExecuted = fill.cumulativeQty >= fill.requestedQty - 1e-9;
    if (!fill.terminal && !fullyExecuted) continue;

    trade._pendingFill = false;
    trade._reconciled = true;
    trade._partialTerminal = fill.terminal && !fullyExecuted;
    const positionQtyAtSubmit = Number(trade._positionQtyAtSubmit)
      || (trade._campaignComplete ? fill.requestedQty : Infinity);
    trade._campaignComplete = fill.cumulativeQty >= positionQtyAtSubmit - 1e-9;
    const campaignKey = trade._campaignKey || trade._occ;
    if (trade._campaignComplete) {
      const campaignPnl = state.realizedCampaignPnl?.[campaignKey] || 0;
      delete state.realizedCampaignPnl[campaignKey];
      if (!state.lastClosed) state.lastClosed = {};
      state.lastClosed[trade.ticker] = getETDateStr();
      recordTradeOutcome(acct, campaignPnl);
    }
    logTrade(trade);

    const slip = est ? ((fill.averageFillPrice - est) / est) * 100 : 0;
    log(acct, `FILL RECONCILED ${trade.ticker} ${trade._occ}: ${fill.cumulativeQty}/${fill.requestedQty} executed @ $${fill.averageFillPrice.toFixed(2)} (est $${est}, ${slip >= 0 ? "+" : ""}${slip.toFixed(0)}% slip) · net proceeds $${fill.netProceeds.toFixed(2)} − fees $${fill.exitFees.toFixed(2)} · P&L ${fill.cumulativeRealPnl >= 0 ? "+" : ""}$${fill.cumulativeRealPnl.toFixed(0)} (${(trade.pnlPct * 100).toFixed(0)}%)`);
    diag("exit_fill", acct, {
      ticker: trade.ticker, occ: trade._occ,
      reason: trade.exitReason || trade.reason || null,
      estClose: est ?? null, actualClose: +fill.averageFillPrice.toFixed(2), slipPct: +slip.toFixed(1),
      entryPremium: trade.entryPremium ?? null, intendedEntryPremium: trade.intendedEntryPremium ?? null,
      qty: fill.cumulativeQty, requestedQty: fill.requestedQty,
      costBasis: +fill.costBasis.toFixed(2), proceeds: +fill.netProceeds.toFixed(2), fees: +fill.exitFees.toFixed(2),
      pnl: +fill.cumulativeRealPnl.toFixed(2), pnlPct: +(trade.pnlPct * 100).toFixed(1),
    });
    const emoji = fill.cumulativeRealPnl >= 0 ? "✅" : "🛑";
    const label = trade._campaignComplete ? (fill.cumulativeRealPnl >= 0 ? "EXIT TP" : "EXIT SL") : "TRIM";
    sendPush(
      `${emoji} ${label} FILLED: ${trade.ticker} ${String(trade.type || "option").toUpperCase()} $${trade.strike} [${acct.name}]`,
      `P&L: ${fill.cumulativeRealPnl >= 0 ? "+" : ""}$${fill.cumulativeRealPnl.toFixed(0)} (${trade.pnlPct >= 0 ? "+" : ""}${(trade.pnlPct * 100).toFixed(0)}%)\n${trade.reason || "broker fill"}`,
      fill.cumulativeRealPnl < 0,
    ).catch(() => {});
    tweetTradeExit(acct, trade, trade).catch(e => console.log(`  [X] Exit tweet error: ${e.message}`));
  }
}

function quarantineNonLongBrokerOption(acct, { broker, symbol, quantity, positionSide, reason }) {
  const state = acct.state;
  if (!state.nonLongOptionQuarantine || typeof state.nonLongOptionQuarantine !== "object") {
    state.nonLongOptionQuarantine = {};
  }
  const key = `${broker}:${String(symbol || "unknown").toUpperCase()}`;
  const previous = state.nonLongOptionQuarantine[key] || {};
  const row = {
    broker,
    symbol: String(symbol || "unknown").toUpperCase(),
    quantity: Number(quantity),
    positionSide: positionSide || null,
    reason,
    firstSeenAt: previous.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    status: "quarantined_non_long",
    notifiedAt: previous.notifiedAt || null,
  };
  state.nonLongOptionQuarantine[key] = row;
  if (!row.notifiedAt) {
    row.notifiedAt = Date.now();
    const message = `${broker.toUpperCase()} ${row.symbol} has non-long option exposure (${reason}, qty ${quantity}). It is quarantined: the long-option lifecycle will not submit sell_to_close.`;
    log(acct, `🚨 BROKER POSITION QUARANTINE: ${message}`);
    diag("risk_halt", acct, {
      kind: "non_long_option_holding",
      broker,
      symbol: row.symbol,
      quantity: row.quantity,
      positionSide: row.positionSide,
      reason,
    });
    sendPush(`🚨 Non-long option quarantined [${acct.name}]`, message, true).catch(() => {});
  }
}

// Mirror the real Tradier account into acct.state: cash from balances, positions (option legs only)
// from holdings with live option marks. Bot-only side-metadata is merged back by OCC each cycle.
async function syncBrokerAccount(acct, quotes) {
  if (acct.config.broker !== "tradier" || !tradier.isConnected) return;
  const state = acct.state;
  if (!state.meta) state.meta = {};

  // Fetch working orders once per cycle: drives the in-flight de-dupe set, the position-count cap,
  // and the pending-position rows below.
  const workingOrders = await brokerWorkingOrders(acct);
  acct._inflightTickers = new Set(workingOrders.map(o => o.ticker.toUpperCase()));

  // Correct any recorded exits against their real fills (close price, proceeds, fees, realized P&L).
  await reconcileBrokerFills(acct).catch(e => log(acct, `FILL RECONCILE error — ${e.message}`));

  try {
    const bal = await tradier.getAccount();
    const info = brokerBalanceInfo(bal, acct.config);
    applyBrokerBalanceInfo(acct, info, { warn: true });
    acct._brokerBalanceInfo = info;
    acct._brokerBalanceRefreshedAt = Date.now();
    state.brokerBalanceAt = Date.now();
  } catch (e) { log(acct, `TRADIER SYNC: balance error — ${e.message}`); }

  try {
    const raw = await tradier.getPositions();
    const now = Date.now();
    const positions = [];
    const seen = new Set();

    // Batch ALL option quotes in one (chunked) request rather than one serial call per position.
    // This is faster, far less rate-limit prone, and gives a single point-in-time snapshot — the
    // most reliable way to get consistent live marks while the market is open.
    const longOptionRows = [];
    for (const brokerPosition of raw) {
      const parsed = tradier.parseOCC(brokerPosition.symbol);
      if (!parsed) continue;
      const holding = classifyLongOptionHolding({
        quantity: brokerPosition.quantity,
        positionSide: brokerPosition.position_side ?? brokerPosition.side ?? brokerPosition.type,
      });
      if (holding.quarantine) {
        quarantineNonLongBrokerOption(acct, {
          broker: "tradier",
          symbol: brokerPosition.symbol,
          quantity: brokerPosition.quantity,
          positionSide: brokerPosition.position_side ?? brokerPosition.side ?? brokerPosition.type,
          reason: holding.reason,
        });
        continue;
      }
      if (holding.manageable && Math.round(holding.quantity) >= 1) {
        longOptionRows.push({ brokerPosition, quantity: Math.round(holding.quantity) });
      }
    }
    const optionOccs = longOptionRows.map(row => row.brokerPosition.symbol);
    let optionQuotes = {};
    try {
      optionQuotes = await tradier.getOptionQuotes(optionOccs);
    } catch (e) {
      log(acct, `TRADIER SYNC: batch option-quote fetch failed (${e.message}) — falling back to per-contract`);
    }
    const mktOpenNow = isMarketOpen();

    for (const { brokerPosition: p, quantity: qtyContracts } of longOptionRows) {
      const occ = p.symbol;
      const parsed = tradier.parseOCC(occ);
      if (!parsed) continue;                       // skip equity / non-option holdings
      // Tradier's cost_basis is the REAL all-in fill (premium × qty × 100, incl. commissions). This
      // is authoritative for what we actually paid — the bot's pre-fill limit estimate (meta.entryPremium)
      // is only a guess and must never override the broker's reported fill.
      const actualEntryPremium = p.cost_basis && qtyContracts ? Math.abs(p.cost_basis) / (qtyContracts * 100) : 0;

      let mark = null, bid = null, ask = null, greeks = null, iv = DEFAULT_IV;
      let oq = optionQuotes[occ] || null;
      if (!oq) {
        // Gap-fill: the batch may have missed this symbol (rare) — try a single fetch.
        try { oq = await tradier.getOptionQuote(occ); } catch { }
      }
      if (oq) {
        bid = typeof oq.bid === "number" ? oq.bid : null;
        ask = typeof oq.ask === "number" ? oq.ask : null;
        mark = reliableOptionMark(oq);   // null if no real two-sided market (we never act on `last`)
        iv = oq.iv ?? DEFAULT_IV;
        greeks = { delta: oq.delta ?? 0, theta: oq.theta ?? 0 };
      }

      const expiryDate = new Date(`${parsed.expiration}T16:00:00`).getTime();
      const dteRemaining = Math.max(0, (expiryDate - now) / 86400_000);
      const meta = state.meta[occ] || {};
      const spot = quotes[parsed.ticker]?.c ?? meta.entrySpot ?? null;

      // Display mark + provenance. We keep `liveMark` strictly as the tradeable two-sided mid (so
      // exits never fire on a fabricated price), but compute a continuous DISPLAY mark so the
      // dashboard/P&L don't look frozen when there's no live market. Distinguish WHY:
      //   live  → real two-sided market (tradeable)
      //   model → no two-sided market; repriced via Black-Scholes using the live contract IV
      //           (reason = market closed, or illiquid/one-sided during RTH)
      let markSource = "live", markReason = null, displayMark = mark;
      if (mark == null) {
        markSource = "model";
        markReason = !mktOpenNow ? "market closed"
          : (bid != null || ask != null) ? "one-sided market (illiquid)"
          : "no quote (illiquid)";
        displayMark = (spot != null)
          ? optPrice(spot, parsed.strike, dteRemaining, iv || DEFAULT_IV, parsed.type)
          : (oq && typeof oq.last === "number" ? oq.last : (oq && oq.prevclose) || null);
      }

      const pos = {
        // Full AI thought process captured at entry (reasoning, concerns, signals, scores). Spread
        // first so the live fields below always win; surfaces the thesis on the live position.
        ...(meta.ai || {}),
        occSymbol: occ,
        ticker: parsed.ticker,
        type: parsed.type,
        strike: parsed.strike,
        expiryDate,
        dte: meta.dte ?? Math.round(dteRemaining),
        dteRemaining,
        // Broker fill wins. Once Tradier reports a cost_basis we use it as the true entry premium
        // (this is what fixes "the bot thought $0.80 but it actually filled at $0.67"). Fall back to
        // the bot's intended limit only until the fill is reported.
        entryPremium: actualEntryPremium > 0 ? +actualEntryPremium.toFixed(2) : (meta.entryPremium ?? 0),
        intendedEntryPremium: meta.entryPremium ?? null, // the limit we submitted — kept for slippage transparency
        entrySpot: meta.entrySpot ?? spot,
        qty: qtyContracts,
        originalQty: meta.originalQty ?? qtyContracts,
        cost: Math.abs(p.cost_basis || actualEntryPremium * qtyContracts * 100),
        openDate: meta.openDate ?? (p.date_acquired ? String(p.date_acquired).slice(0, 10) : getETDateStr()),
        openTime: meta.openTime ?? (p.date_acquired ? new Date(p.date_acquired).getTime() : now),
        trimLevel: meta.trimLevel ?? 0,
        bestPnlPct: meta.bestPnlPct ?? 0,
        bestExitPnlPct: meta.bestExitPnlPct ?? 0,
        managementPlan: meta.managementPlan || null,
        lastManagementDecision: meta.lastManagementDecision || null,
        entryAtrPct: meta.entryAtrPct ?? null,
        plannedRiskDollars: meta.plannedRiskDollars ?? null,
        riskGovernor: meta.riskGovernor ?? null,
        iv,
        liveMark: mark != null ? +mark.toFixed(2) : null,   // tradeable two-sided mid only (exits gate on this)
        displayMark: displayMark != null ? +displayMark.toFixed(2) : null, // continuous mark for UI/P&L
        markSource,                                          // "live" | "model"
        markReason,                                          // why we fell back (closed / illiquid)
        liveBid: bid,
        liveAsk: ask,
        liveGreeks: greeks,
        optionsSource: "tradier",
        direction: parsed.type === "call" ? "BULLISH" : "BEARISH",
      };

      restorePosTrail(pos, meta, null);
      if (pos.liveMark != null && pos.entryPremium > 0) {
        const pnl = (pos.liveMark - pos.entryPremium) / pos.entryPremium;
        if (pnl > pos.bestPnlPct) pos.bestPnlPct = pnl;
        recordMarkTrail(pos, pos.liveMark, now, pos.liveBid, pos.liveAsk);
      }
      persistPosTrailMeta(acct, pos);

      // Backfill AI metadata for positions that pre-date the aiThesis feature (or were
      // opened outside the bot). Synthesize a basic thesis from current analysis data so
      // the 🧠 AI toggle always appears on the dashboard, matching paper account behavior.
      let aiData = meta.ai || null;
      if (!aiData) {
        const curAnalysis = acct.dashboard?.analyses?.[parsed.ticker];
        if (curAnalysis) {
          const topSigs = (curAnalysis.sigs || []).slice(0, 5).map(s => s.text);
          aiData = {
            claudeReasoning: `Position synced from Tradier (no bot-entry reasoning captured). Current technicals: ${parsed.type === "call" ? "BULLISH" : "BEARISH"} setup, score ${curAnalysis.score}/100, RSI ${curAnalysis.rsi?.toFixed(0) ?? "?"}, ATR ${curAnalysis.atrPct?.toFixed(1) ?? "?"}%. Signals: ${topSigs.join("; ") || "n/a"}.`,
            claudeSuggestion: "",
            claudeConcerns: [],
            setupQuality: curAnalysis.score ?? null,
            technicalScore: curAnalysis.score ?? null,
            direction: parsed.type === "call" ? "BULLISH" : "BEARISH",
            regimeAtEntry: acct.currentRegime?.label ?? "unknown",
            topSignals: topSigs,
          };
          // Spread the synthesized AI data onto the position
          Object.assign(pos, aiData);
        }
      }

      positions.push(pos);
      state.meta[occ] = {
        // Keep exact-OCC lifecycle state that is not reconstructed from the broker holding itself,
        // especially an incompletely-filled trim target spanning multiple orders.
        ...meta,
        entryPremium: pos.entryPremium, entrySpot: pos.entrySpot, dte: pos.dte,
        originalQty: pos.originalQty, openDate: pos.openDate, openTime: pos.openTime,
        trimLevel: pos.trimLevel, bestPnlPct: pos.bestPnlPct, bestExitPnlPct: pos.bestExitPnlPct,
        managementPlan: pos.managementPlan, lastManagementDecision: pos.lastManagementDecision,
        entryAtrPct: pos.entryAtrPct,
        plannedRiskDollars: pos.plannedRiskDollars,
        riskGovernor: pos.riskGovernor,
        markTrail: Array.isArray(pos.markTrail) ? pos.markTrail.slice(-240) : undefined,
        ai: aiData, // keep the captured (or backfilled) AI thought process across syncs
      };
      seen.add(occ);
    }
    // Surface working (unfilled) BUY orders as pending positions so they show on the dashboard
    // and count toward limits. They are skipped by exit logic (see _pending guards).
    let reserved = 0;
    for (const o of workingOrders) {
      if (o.side !== "buy_to_open" && o.side !== "buy") continue;
      if (!o.parsed || o.qty < 1) continue;
      reserved += o.reserved;
      const expiryDate = new Date(`${o.parsed.expiration}T16:00:00`).getTime();
      positions.push({
        occSymbol: o.occ,
        ticker: o.parsed.ticker,
        type: o.parsed.type,
        strike: o.parsed.strike,
        expiryDate,
        dte: Math.round(Math.max(0, (expiryDate - now) / 86400_000)),
        dteRemaining: Math.max(0, (expiryDate - now) / 86400_000),
        entryPremium: o.price || 0,
        entrySpot: quotes[o.parsed.ticker]?.c ?? null,
        qty: o.qty,
        originalQty: o.requestedQty || o.qty,
        remainingQuantity: o.remainingQuantity,
        requestedQty: o.requestedQty,
        executedQty: o.executedQty,
        orderId: o.id,
        side: o.side,
        cost: o.reserved,
        openDate: getETDateStr(),
        openTime: o.createDate || now,
        trimLevel: 0,
        bestPnlPct: 0,
        iv: DEFAULT_IV,
        liveMark: o.price || 0,
        optionsSource: "tradier",
        direction: o.parsed.type === "call" ? "BULLISH" : "BEARISH",
        _pending: true,
        orderStatus: o.status,
      });
      seen.add(o.occ);
    }

    state.pendingEntryOrders = workingOrders
      .filter(o => (o.side === "buy_to_open" || o.side === "buy") && o.parsed && o.qty > 0)
      .map(o => ({
        occ: o.occ,
        option_symbol: o.occ,
        side: o.side,
        status: o.status,
        orderId: o.id,
        quantity: o.requestedQty || o.qty,
        remaining_quantity: o.remainingQuantity,
        executed_quantity: o.executedQty,
        price: o.price,
      }));

    // Prune metadata for positions that no longer exist at the broker.
    for (const k of Object.keys(state.meta)) if (!seen.has(k)) delete state.meta[k];
    state.positions = positions;
    state.workingOrderCount = workingOrders.length;
    state.reservedBuyingPower = reserved;
    const filled = positions.filter(p => !p._pending).length;
    const pending = positions.length - filled;
    const unsettledStr = state.unsettledCash > 0 ? ` | unsettled $${state.unsettledCash.toFixed(0)}` : "";
    log(acct, `TRADIER SYNC [${(state.accountType || "?").toUpperCase()}]: equity $${(state.brokerEquity ?? portfolioValue(state, quotes)).toFixed(2)} | settled BP $${state.cash.toFixed(2)}${unsettledStr} | ${filled} filled, ${pending} pending order(s)${reserved > 0 ? ` reserving $${reserved.toFixed(0)}` : ""}`);

    // Data-quality snapshot — only emit on an ANOMALY or a meaningful change so this stays low-volume
    // even though sync runs every cycle. Anomalies are exactly what we want to catch over the coming days:
    // option positions priced off a model instead of a live two-sided market (illiquid / feed delayed),
    // or material equity moves while the market is closed (suggests stale/late data).
    const optPositions = positions.filter(p => !p._pending && p.optionsSource === "tradier");
    const modelMarked = optPositions.filter(p => p.markSource === "model");
    const equity = +(state.brokerEquity ?? portfolioValue(state, quotes)).toFixed(2);
    const prev = acct._lastSyncSnapshot || {};
    const equityDelta = prev.equity != null ? +(equity - prev.equity).toFixed(2) : 0;
    const mktNow = isMarketOpen();
    const anomaly =
      modelMarked.length > 0 ||
      pending > 0 ||
      (!mktNow && prev.equity != null && Math.abs(equityDelta) > Math.max(1, equity * 0.02)); // >2% move while closed
    if (anomaly) {
      diag("data", acct, {
        equity, cashBP: +state.cash.toFixed(2),
        filled, pending,
        optionsTotal: optPositions.length, modelMarked: modelMarked.length, liveMarked: optPositions.length - modelMarked.length,
        modelTickers: modelMarked.slice(0, 8).map(p => `${p.ticker}:${p.markReason || "model"}`),
        equityDeltaSinceLast: equityDelta, marketOpen: mktNow,
      });
    }
    acct._lastSyncSnapshot = { equity, ts: Date.now() };
  } catch (e) {
    log(acct, `TRADIER SYNC: positions error — ${e.message}`);
    diag("error", acct, { where: "syncBrokerAccount", message: e.message });
  }
}

// ─── Robinhood Entry-Order Working (active bidding) ───
// A resting entry limit is a DECISION, not a fire-and-forget. Each sync we re-quote the contract
// Initial Robinhood entry limits are never cancel/replaced. A cancel can race a partial fill; placing
// the full quantity again before exact terminal reconciliation can overbuy the position. Let the
// approved limit rest, cancel stale remainder once, and wait for the exact order snapshot.
const ENTRY_GIVEUP_MS = 20 * 60_000;
const ENTRY_WALKAWAY_COOLDOWN_MS = 15 * 60_000;
const ENTRY_HALT_CANCEL_COOLDOWN_MS = 60_000;

/**
 * Fire-and-forget cancel of broker-visible working buys. Safe to call from risk/pause paths that
 * may already hold (or sit outside) the broker execution lane — Robinhood work is queued on the lane.
 */
function scheduleWorkingEntryCancellation(acct, reason) {
  const cancelTask = () => cancelWorkingEntryOrders(acct, reason);
  const cancellation = acct.config?.broker === "robinhood"
    ? withBrokerExecutionLane(acct, cancelTask)
    : cancelTask();
  cancellation.catch(error => {
    log(acct, `ENTRY HALT: working-entry cancellation failed — ${error.message}`);
  });
  return cancellation;
}

async function cancelWorkingEntryOrders(acct, reason = "entry halt") {
  if (acct.config.broker === "tradier") {
    const working = await brokerWorkingOrders(acct);
    let requested = 0;
    for (const order of working) {
      if (order.side !== "buy_to_open" && order.side !== "buy") continue;
      await tradier.cancelOrder(order.id);
      requested++;
    }
    if (requested) log(acct, `ENTRY HALT: cancel requested for ${requested} Tradier buy order(s) — ${reason}`);
    return requested;
  }
  if (acct.config.broker !== "robinhood") return 0;
  let requested = 0;
  for (const [occ, meta] of Object.entries(acct.state.meta || {})) {
    if (!meta?.entryOrderPlacedAt || !meta.entryOrderCtx) continue;
    if (!meta.entryOrderId) {
      log(acct, `ENTRY HALT: ${occ} has ambiguous submission status; retaining quarantine (no buy replay) — ${reason}`);
      continue;
    }
    if (meta.entryCancelRequestedAt) continue;
    await robinhood.cancelOptionOrder(meta.entryOrderId);
    meta.entryCancelRequestedAt = Date.now();
    requested++;
  }
  if (requested) log(acct, `ENTRY HALT: cancel requested for ${requested} Robinhood buy order(s) — ${reason}`);
  return requested;
}

async function workRobinhoodEntryOrders(acct, now) {
  const state = acct.state;
  if (!state.meta) return;
  if (!acct._inflightTickers) acct._inflightTickers = new Set();
  if (!acct._chaseCooldownUntil) acct._chaseCooldownUntil = {};

  const haltReason = entryBuyHaltReason(acct);
  if (haltReason && shouldCancelWorkingBuysOnHalt(acct)) {
    // Observation / pause / risk: cancel broker-visible buys every minute until gone. Never leave
    // an armed buy resting after the lock that forbids new entries.
    if (!acct._entryHaltCancelAt || now - acct._entryHaltCancelAt >= ENTRY_HALT_CANCEL_COOLDOWN_MS) {
      acct._entryHaltCancelAt = now;
      await cancelWorkingEntryOrders(acct, haltReason);
    }
  }

  for (const [occ, m] of Object.entries(state.meta)) {
    if (!m || !m.entryOrderPlacedAt || !m.entryOrderCtx) continue;
    const ctx = m.entryOrderCtx;
    const tickerU = (ctx.ticker || "").toUpperCase();
    if (!m.entryOrderId) {
      acct._inflightTickers.add(tickerU);
      // Submission response was ambiguous. Retry the exact payload under the SAME broker idempotency
      // key — but NEVER while paused/observation-locked. An old in-flight buy must not outlive the halt.
      if (!ambiguousBuyReplayAllowed(acct)) {
        if (!m.entryHaltReplayBlockedLoggedAt || now - m.entryHaltReplayBlockedLoggedAt >= 15 * 60_000) {
          m.entryHaltReplayBlockedLoggedAt = now;
          log(acct, `RH ENTRY RECOVERY BLOCKED ${tickerU || occ}: ${haltReason || "entry halt"} — refusing ambiguous buy replay`);
        }
        continue;
      }
      const refId = m.entryOrderRefId;
      const qty = Number(ctx.qty);
      const limit = Number(m.entryOrderLimit);
      const completeCtx = refId && tickerU && ctx.expStr && Number(ctx.strike) > 0
        && (ctx.optionType === "call" || ctx.optionType === "put") && qty > 0 && limit > 0;
      if (!completeCtx) {
        if (!m.entryRecoveryContextLoggedAt || now - m.entryRecoveryContextLoggedAt >= 15 * 60_000) {
          m.entryRecoveryContextLoggedAt = now;
          log(acct, `RH ENTRY RECOVERY BLOCKED ${tickerU || occ}: incomplete persisted order context; retaining quarantine`);
        }
        continue;
      }
      if (m.entryRecoveryAttemptAt && now - m.entryRecoveryAttemptAt < 30_000) continue;
      m.entryRecoveryAttemptAt = now;
      // Durable intent already exists (same ref). Re-assert it before the broker call.
      saveAccountsStrict();
      try {
        const recovered = await robinhood.placeOptionOrder({
          symbol: tickerU,
          expirationDate: ctx.expStr,
          strikePrice: ctx.strike,
          optionType: ctx.optionType,
          side: "buy_to_open",
          quantity: qty,
          type: "limit",
          limitPrice: limit.toFixed(2),
          refId,
        });
        const recoveredQty = optionOrderExecutedQuantity(recovered);
        const recoveredFill = recoveredQty > 0 ? optionOrderAverageFillPrice(recovered) : null;
        if (recoveredFill > 0) {
          m.entryPremium = +recoveredFill.toFixed(2);
          m.entryFillReconciled = true;
          m.originalQty = recoveredQty;
        }
        const recoveredId = brokerOrderId(recovered);
        if (recoveredId) {
          m.entryOrderId = recoveredId;
          delete m.entrySubmissionUnknownAt;
          delete m.entryRecoveryContextLoggedAt;
          log(acct, `RH ENTRY RECOVERY: recovered order ${recoveredId} for ${tickerU} using persisted ref ${refId}`);
        } else {
          m.entrySubmissionUnknownAt = now;
          if (!m.entryRecoveryNoIdLoggedAt || now - m.entryRecoveryNoIdLoggedAt >= 15 * 60_000) {
            m.entryRecoveryNoIdLoggedAt = now;
            log(acct, `RH ENTRY RECOVERY: ${tickerU} still returned no order id; retaining persisted ref and quarantine`);
          }
        }
      } catch (e) {
        if (e.brokerRejected) {
          delete state.meta[occ];
          acct._inflightTickers.delete(tickerU);
          acct._chaseCooldownUntil[tickerU] = now + ENTRY_WALKAWAY_COOLDOWN_MS;
          log(acct, `RH ENTRY RECOVERY REJECTED ${tickerU}: ${e.message}; cleared rejected intent`);
        } else {
          m.entrySubmissionUnknownAt = now;
          if (!m.entryRecoveryErrorLoggedAt || now - m.entryRecoveryErrorLoggedAt >= 15 * 60_000) {
            m.entryRecoveryErrorLoggedAt = now;
            log(acct, `RH ENTRY RECOVERY UNKNOWN ${tickerU}: ${e.message}; retaining persisted ref and quarantine`);
          }
        }
      }
      continue;
    }

    let response = null;
    try { response = await robinhood.getOptionsOrders({ order_id: m.entryOrderId }); } catch { }
    const raw = response?.data ?? response;
    const records = Array.isArray(raw) ? raw
      : Array.isArray(raw?.orders) ? raw.orders
        : Array.isArray(raw?.results) ? raw.results
          : raw && typeof raw === "object" ? [raw] : [];
    const order = findExactOptionOrder(records, {
      orderId: m.entryOrderId,
      occSymbol: occ,
      side: "buy",
      submittedAt: m.entryOrderPlacedAt,
      now,
    });
    if (!order) {
      acct._inflightTickers.add(tickerU);
      continue;
    }

    const executedQty = optionOrderExecutedQuantity(order);
    const terminal = optionOrderIsTerminal(order);
    if (terminal) {
      if (executedQty > 0) {
        const fill = optionOrderAverageFillPrice(order);
        if (fill > 0) {
          m.entryPremium = +fill.toFixed(2);
          m.entryFillReconciled = true;
          m.originalQty = executedQty;
        }
        // Orders can report a terminal fill one snapshot before the holdings endpoint reflects it.
        // Retain the exact-OCC lock until that holding proves quantity/basis; otherwise the next
        // still-empty positions snapshot can submit a duplicate full buy.
        m.entryAwaitingHolding = true;
        m.entryExecutedQty = executedQty;
        m.entryOrderTerminalAt = now;
        m.entryOrderCtx.qty = executedQty;
        acct._inflightTickers.add(tickerU);
        if (!m.entryAwaitingHoldingLoggedAt) {
          m.entryAwaitingHoldingLoggedAt = now;
          log(acct, `RH ENTRY WORK: terminal ${String(order.state || "order")} for ${tickerU}; ${executedQty}x filled${fill > 0 ? ` @ $${fill.toFixed(2)}` : ""}; retaining lock until holdings confirms`);
        }
      } else {
        delete state.meta[occ];
        acct._chaseCooldownUntil[tickerU] = now + ENTRY_WALKAWAY_COOLDOWN_MS;
        log(acct, `RH ENTRY WORK: ${tickerU} order ended ${String(order.state || "without fill")} — no replacement sent`);
        acct._inflightTickers.delete(tickerU);
      }
      continue;
    }

    acct._inflightTickers.add(tickerU);
    const workedFor = now - (m.entryFirstPlacedAt || m.entryOrderPlacedAt);
    // Cancel any partial remainder immediately; otherwise a held position and a live buy remainder
    // coexist, making position size nondeterministic. Unfilled orders get the approved 20m window.
    const shouldCancel = executedQty > 0 || workedFor >= ENTRY_GIVEUP_MS;
    if (shouldCancel && !m.entryCancelRequestedAt) {
      try {
        await robinhood.cancelOptionOrder(m.entryOrderId);
        m.entryCancelRequestedAt = now;
        log(acct, `RH ENTRY WORK: cancel requested for ${tickerU} ${occ} (${executedQty > 0 ? `${executedQty}x partial fill` : "entry window expired"}); waiting for exact terminal state`);
      } catch (e) {
        log(acct, `RH ENTRY WORK: cancel failed for ${tickerU} — ${e.message}; original order remains locked`);
      }
    }
  }
}

async function syncRobinhoodAccount(acct, quotes, { workEntries = true, refreshBalance = true } = {}) {
  if (acct.config.broker !== "robinhood" || !robinhood.isConnected) return;
  const state = acct.state;
  if (!state.meta) state.meta = {};
  // Snapshot last cycle's positions BEFORE rebuilding — closed/shrunk positions are detected by
  // diffing against this so Robinhood exits produce real trade-history records (and feed the
  // consecutive-loss breaker), which they previously never did.
  const prevPositions = Array.isArray(state.positions) ? state.positions.filter(p => !p._pending) : [];

  if (refreshBalance) try {
    const res = await robinhood.getPortfolio();
    const env = res && res.data ? res.data : res;
    // Prefer total_value over equity_value. equity_value is the stock sleeve and is often "0"
    // on options-only cash accounts; reading it first pinned brokerEquity at 0 and forced the
    // cash+rhUnsettled fallback, which double-counted today's option sale proceeds (~+$650 fake PV).
    const fields = extractRobinhoodPortfolioFields(res);
    if (!acct._rhPortfolioShapeLogged) {
      acct._rhPortfolioShapeLogged = true;
      log(acct, `RH-RAW PORTFOLIO: ${JSON.stringify(env).slice(0, 900)}`);
      log(acct, `RH-PORTFOLIO PARSED: total=$${fields.totalEquity ?? "?"} bp=$${fields.buyingPower ?? "?"} source=${fields.source || "none"}`);
    }
    const eqNum = fields.totalEquity;
    const bpNum = fields.buyingPower;
    const prevCash = typeof state.cash === "number" ? state.cash : null;
    if (bpNum != null && bpNum >= 0) state.cash = bpNum;
    if (eqNum != null && eqNum > 0) {
      state.brokerEquity = eqNum;
      // total_value already includes cash from today's sales — drop the synthetic unsettled credit
      // so a later brokerEquity miss cannot reinflate PV.
      if (Array.isArray(state.rhUnsettled) && state.rhUnsettled.length > 0) state.rhUnsettled = [];
      const cashDelta = (prevCash != null && bpNum != null) ? (bpNum - prevCash) : null;
      reconcileBrokerCapital(acct, eqNum, { cashDelta });
    } else {
      delete state.brokerEquity; // never let a stale equity reading override the live fallback math
    }
    if ((bpNum != null && bpNum >= 0) || (eqNum != null && eqNum > 0)) {
      state.brokerBalanceAt = Date.now();
    }
    // Sale proceeds settle T+1: anything booked on a prior day is assumed absorbed into buying
    // power by now, so drop it from the unsettled credit (portfolioValue adds what remains).
    // Only keep today's credits when we do NOT have an authoritative total_value reading.
    if (!(eqNum != null && eqNum > 0) && Array.isArray(state.rhUnsettled) && state.rhUnsettled.length > 0) {
      const today = getETDateStr();
      state.rhUnsettled = state.rhUnsettled.filter(e => e.date === today);
    }
  } catch (e) { log(acct, `ROBINHOOD SYNC: balance error — ${e.message}`); }

  try {
    const now = Date.now();
    const positions = [];
    const seen = new Set();
    // If Robinhood reports any short/non-long leg for a ticker, quarantine every option leg for
    // that ticker from this long-only runtime. Mixed-leg/spread exposure cannot be safely managed
    // one leg at a time, and a stale prior long must not reach exit-intent recovery.
    const nonLongOptionTickers = new Set();
    let optionOrdersSnapshot = null;

    // Fetch equity positions
    const res = await robinhood.getPositions();
    const raw = res && res.data && Array.isArray(res.data.positions) ? res.data.positions : (Array.isArray(res) ? res : []);

    // Also fetch confirmed orders to count working orders (equity + options). A failed endpoint
    // is not evidence that all working orders vanished, so failures retain the previous local locks.
    const brokerTickers = [];
    let inflightSnapshotComplete = true;
    try {
      const workingRes = await robinhood.getOrders({ state: "confirmed" });
      const workingOrders = workingRes && workingRes.data && Array.isArray(workingRes.data.orders)
        ? workingRes.data.orders : (Array.isArray(workingRes) ? workingRes : []);
      for (const order of workingOrders) {
        const ticker = order.symbol?.toUpperCase();
        if (ticker) brokerTickers.push(ticker);
      }
    } catch (e) {
      inflightSnapshotComplete = false;
      log(acct, `ROBINHOOD SYNC: equity working-orders fetch failed — preserving local order locks (${e.message})`);
    }

    // If options are enabled, fetch every state. Confirmed-only misses queued, partially-filled,
    // and pending-cancel orders and can release a duplicate-sell lock while a remainder is live.
    if (robinhood.optionsEnabled) {
      try {
        const optWorkingRes = await robinhood.getOptionsOrders({});
        const optWorkingRaw = optWorkingRes?.data ?? optWorkingRes;
        optionOrdersSnapshot = Array.isArray(optWorkingRaw) ? optWorkingRaw
          : Array.isArray(optWorkingRaw?.orders) ? optWorkingRaw.orders
            : Array.isArray(optWorkingRaw?.results) ? optWorkingRaw.results : [];
        // Treat every unknown/nonterminal state as active. A new broker state must retain locks,
        // never silently release them and permit a duplicate order.
        const optWorkingOrders = optionOrdersSnapshot.filter(order => !optionOrderIsTerminal(order));
        for (const o of optWorkingOrders) {
          const sym = (o.chain_symbol || o.symbol || "").toUpperCase();
          if (sym) brokerTickers.push(sym);
        }
      } catch (e) {
        inflightSnapshotComplete = false;
        log(acct, `ROBINHOOD SYNC: option working-orders fetch failed — preserving local order locks (${e.message})`);
      }
    }
    // Grace period: an order we just placed may not show up as "confirmed" at the broker for a
    // few seconds (or, previously, could be silently dropped entirely if it was rejected — see
    // the isError fix in robinhood.js). Overwriting _inflightTickers wholesale from this fetch
    // let a not-yet-confirmed (or wrongly-believed-successful) order fall out of the in-flight
    // set on the very next cycle, so tryEntry() would re-target the same contract again — this
    // is how KO got three duplicate buy attempts within three minutes. Keep any ticker we placed
    // an entry order for in the last 2 minutes in the set regardless of what the broker reports.
    const ENTRY_INFLIGHT_GRACE_MS = 2 * 60_000;
    const localIntents = [];
    for (const meta of Object.values(state.meta || {})) {
      if (meta?.entryOrderCtx?.ticker && meta.entryOrderPlacedAt) {
        localIntents.push({
          ticker: meta.entryOrderCtx.ticker,
          placedAt: meta.entryOrderPlacedAt,
          graceMs: ENTRY_INFLIGHT_GRACE_MS,
        });
      }
      if (meta?.exitOrderTicker && exitIntentWithinGrace(meta, now)) {
        localIntents.push({
          ticker: meta.exitOrderTicker,
          placedAt: meta.exitOrderPlacedAt,
          graceMs: EXIT_INFLIGHT_GRACE_MS,
        });
      }
    }
    acct._inflightTickers = mergeInflightTickers({
      brokerTickers,
      previousTickers: acct._inflightTickers || [],
      brokerSnapshotComplete: inflightSnapshotComplete,
      localIntents,
      now,
    });
    // Fetch quotes for equity positions
    const positionSymbols = raw.map(p => p.symbol).filter(Boolean);
    const rhQuotes = positionSymbols.length > 0 ? await robinhood.getQuotes(positionSymbols).catch(() => ({})) : {};

    for (const p of raw) {
      const ticker = p.symbol;
      if (!ticker) continue;
      const qty = parseFloat(p.quantity);
      if (qty <= 0) continue;

      const costBasis = parseFloat(p.average_buy_price) || 0;
      const meta = state.meta[ticker] || {};
      const spot = quotes[ticker]?.c ?? rhQuotes[ticker]?.last_trade_price ?? meta.entrySpot ?? null;

      const pos = {
        ...(meta.ai || {}),
        ticker: ticker,
        type: "equity",
        strike: 0,
        dte: 0,
        dteRemaining: 0,
        entryPremium: meta.entryPremium ?? costBasis,
        entrySpot: meta.entrySpot ?? costBasis,
        qty: qty,
        originalQty: meta.originalQty ?? qty,
        cost: Math.abs(costBasis * qty),
        openDate: meta.openDate ?? (p.created_at ? String(p.created_at).slice(0, 10) : getETDateStr()),
        openTime: meta.openTime ?? (p.created_at ? new Date(p.created_at).getTime() : now),
        trimLevel: meta.trimLevel ?? 0,
        bestPnlPct: meta.bestPnlPct ?? 0,
        bestExitPnlPct: meta.bestExitPnlPct ?? 0,
        managementPlan: meta.managementPlan || null,
        lastManagementDecision: meta.lastManagementDecision || null,
        entryAtrPct: meta.entryAtrPct ?? null,
        iv: 0,
        liveMark: spot,
        liveBid: null,
        liveAsk: null,
        liveGreeks: null,
        optionsSource: "robinhood",
        direction: "BULLISH",
      };

      const prevEq = prevPositions.find(pp => pp.ticker === ticker && pp.type === "equity");
      restorePosTrail(pos, meta, prevEq);
      if (pos.liveMark != null && pos.entryPremium > 0) {
        const pnl = (pos.liveMark - pos.entryPremium) / pos.entryPremium;
        if (pnl > pos.bestPnlPct) pos.bestPnlPct = pnl;
        recordMarkTrail(pos, pos.liveMark, now, pos.liveBid, pos.liveAsk);
      }
      persistPosTrailMeta(acct, pos);

      let aiData = meta.ai || null;
      if (!aiData) {
        const curAnalysis = acct.dashboard?.analyses?.[ticker];
        if (curAnalysis) {
          const topSigs = (curAnalysis.sigs || []).slice(0, 5).map(s => s.text);
          aiData = {
            claudeReasoning: `Position synced from Robinhood. Current technicals: BULLISH setup, score ${curAnalysis.score}/100.`,
            claudeSuggestion: "",
            claudeConcerns: [],
            setupQuality: curAnalysis.score ?? null,
            technicalScore: curAnalysis.score ?? null,
            direction: "BULLISH",
            regimeAtEntry: acct.currentRegime?.label ?? "unknown",
            topSignals: topSigs,
          };
        }
      }
      if (aiData) Object.assign(pos, aiData);

      positions.push(pos);
      seen.add(ticker);
    }

    // Sync options positions when enabled
    let optionsFetchOk = false; // gates the closure diff below — a failed fetch must not read as "everything closed"
    if (robinhood.optionsEnabled) {
      try {
        const optRes = await robinhood.getOptionsPositions();
        const optRaw = optRes && optRes.data && Array.isArray(optRes.data.positions) ? optRes.data.positions
          : optRes && Array.isArray(optRes.positions) ? optRes.positions
          : Array.isArray(optRes) ? optRes : [];
        optionsFetchOk = true;

        // DIAGNOSTIC (once per process): dump the raw shape of the first options position so
        // field mapping can be verified from the logs without spamming every cycle.
        if (optRaw.length > 0 && !acct._rhRawPosLogged) {
          acct._rhRawPosLogged = true;
          log(acct, `RH-RAW POSITION: ${JSON.stringify(optRaw[0]).slice(0, 900)}`);
        }

        for (const op of optRaw) {
          try {
          const ticker = String(op.chain_symbol || op.symbol || "").toUpperCase();
          if (!ticker) continue;

          const rawSide = String(op.position_side || op.side || op.type || "").toLowerCase();
          const rawQuantity = parseFloat(op.quantity || op.pending_buy_quantity || 0);
          const holding = classifyLongOptionHolding({ quantity: rawQuantity, positionSide: rawSide });
          if (holding.quarantine) {
            nonLongOptionTickers.add(ticker);
            quarantineNonLongBrokerOption(acct, {
              broker: "robinhood",
              symbol: op.occ_symbol || op.occSymbol || op.option_symbol || ticker,
              quantity: rawQuantity,
              positionSide: rawSide,
              reason: holding.reason,
            });
            continue;
          }
          if (!holding.manageable) continue;
          const qty = holding.quantity;

          // The instrument UUID is the contract identity. Ticker/type/strike are not unique, and
          // historical same-ticker orders must never be used to guess this holding's expiry.
          const instrumentUrl = op.instrument || op.instrument_id || op.option_id || null;
          const instrumentId = normalizeOptionId(instrumentUrl);
          const rawOcc = op.occ_symbol || op.occSymbol || op.option_symbol || null;
          const parsedOcc = parseOccSymbol(rawOcc);

          // Robinhood returns `type: "long"/"short"` (position side), not call/put. Missing option
          // type stays unknown; defaulting to call can turn a put into the wrong managed contract.
          const rawOptionType = String(
            (rawSide === "long" || rawSide === "short")
              ? (op.option_type || op.legs?.[0]?.option_type || "")
              : (op.option_type || rawSide || ""),
          ).toLowerCase();
          let optType = rawOptionType === "call" || rawOptionType === "put" ? rawOptionType : parsedOcc?.type || null;
          let strike = parseFloat(
            op.strike_price || op.strike ||
            op.legs?.[0]?.strike_price || op.legs?.[0]?.strike ||
            op.instrument_data?.strike_price || op.option_data?.strike_price ||
            op.contract?.strike_price || op.details?.strike_price || 0
          );
          let expDate = op.expiration_date || op.expiration || op.legs?.[0]?.expiration_date || parsedOcc?.expiration || null;
          if (!(strike > 0) && parsedOcc?.strike > 0) strike = parsedOcc.strike;

          // Carry forward exact fields only from the same instrument UUID/OCC. Never match a prior
          // position by ticker/type/strike: two contracts can share all three and differ in expiry.
          const prevExact = prevPositions.find(previous => previous.type !== "equity" && (
            (instrumentId && normalizeOptionId(previous.instrumentUrl) === instrumentId) ||
            (rawOcc && previous.occSymbol === rawOcc)
          ));
          if (prevExact?.contractIdentityVerified) {
            if (!optType && (prevExact.type === "call" || prevExact.type === "put")) optType = prevExact.type;
            if (!(strike > 0) && prevExact.strike > 0) strike = prevExact.strike;
            if (!expDate && prevExact.expiryDate > 0) expDate = new Date(prevExact.expiryDate).toISOString().slice(0, 10);
          }

          const expMs = expDate ? optionExpirationTimestamp(expDate) : 0;
          const fieldsComplete = (optType === "call" || optType === "put") && strike > 0 && expMs > 0;
          const candidateOcc = fieldsComplete ? robinhood.buildOCC(ticker, expDate, optType, strike) : null;
          const rawOccMatches = !!(parsedOcc && candidateOcc && String(rawOcc).toUpperCase() === candidateOcc);
          const previousIdentityMatches = !!(prevExact?.contractIdentityVerified && candidateOcc
            && prevExact.occSymbol === candidateOcc
            && (!instrumentId || normalizeOptionId(prevExact.instrumentUrl) === instrumentId));
          const persistedIdentity = candidateOcc ? state.meta[candidateOcc] : null;
          const persistedIdentityMatches = !!(persistedIdentity?.contractIdentityVerified
            && (!instrumentId || normalizeOptionId(persistedIdentity.instrumentId) === instrumentId));
          // UUID + free-standing fields are not proof they describe each other. First sight of a
          // UUID-only position stays unverified until Step 1 resolves that exact UUID against the
          // instrument/order record. Exact OCC, prior exact identity, or persisted UUID↔OCC proof is safe.
          const identityProofMatches = instrumentId
            ? (previousIdentityMatches || persistedIdentityMatches)
            : rawOccMatches;
          const contractIdentityVerified = !!(fieldsComplete && identityProofMatches);
          const occ = contractIdentityVerified ? candidateOcc : null;
          const optionMetaKey = occ || (instrumentId ? `rhopt:${instrumentId}` : null);
          const meta = optionMetaKey ? (state.meta[optionMetaKey] || {}) : {};

          // Log raw structure once per ticker so we can identify which fields carry strike/type
          if (!contractIdentityVerified) console.log(`  [RH-OPT-DEBUG] ${ticker} unverified contract keys:`, Object.keys(op).join(", "), "legs:", JSON.stringify(op.legs || []).slice(0, 300));
          const avgPrice = parseFloat(op.average_price || op.average_buy_price || 0);
          const entryPremium = avgPrice > 1 ? avgPrice / 100 : avgPrice; // RH may return per-contract cost
          const dteRemaining = contractIdentityVerified
            ? Math.max(0, Math.ceil((expMs - now) / 86400000))
            : null;

          const mark = parseFloat(op.mark_price || op.adjusted_mark_price || 0) || null;
          const bid = parseFloat(op.bid_price || 0) || null;
          const ask = parseFloat(op.ask_price || 0) || null;

          // Quotes attached to an unverified contract cannot drive orders. For an exact contract,
          // trust coherent broker quotes even above +250%; large legitimate winners must stay sellable.
          const coherentSpread = bid == null || ask == null || ask >= bid;
          // Embedded position quote fields can be stale while the positions endpoint is polled.
          // Keep a coherent mark for display, but never stamp its bid/ask as fresh execution data.
          // Step 2 performs a new exact-instrument market-data request every manager tick; only
          // that response may populate executable bids or protective-stop samples.
          const safeMark = contractIdentityVerified && coherentSpread ? mark : null;
          const safeBid = null;
          const safeAsk = null;

          // A fully established exact holding is stronger fill evidence than a stale local flag.
          // Without this reconciliation a missing terminal-order snapshot quarantined KO for four
          // days, so the manager skipped its executable +10% bank and subsequent giveback lock.
          const exactEntryOrder = meta.entryOrderPlacedAt && optionOrdersSnapshot ? findExactOptionOrder(optionOrdersSnapshot, {
            orderId: meta.entryOrderId,
            refId: meta.entryOrderRefId,
            instrumentId,
            occSymbol: occ,
            side: "buy",
            submittedAt: meta.entryOrderPlacedAt,
            now,
          }) : null;
          // Only immutable broker creation time may prove that a holding came from this intent.
          // `updated_at` changes with quotes/position activity and local openTime is circular.
          const brokerPositionCreatedAt = op.created_at ? new Date(op.created_at).getTime() : 0;
          const entryIntentSettled = contractIdentityVerified && entryIntentSatisfiedByHolding(meta, {
            heldQuantity: qty,
            averageFillPrice: entryPremium,
            positionCreatedAt: brokerPositionCreatedAt,
            exactOrder: exactEntryOrder,
          });
          if (entryIntentSettled) {
            clearEntryOrderTracking(meta);
            if (!brokerTickers.includes(ticker)) acct._inflightTickers.delete(ticker);
            log(acct, `RH ENTRY RECONCILED ${ticker}: exact ${occ} holding ${qty}x @ $${entryPremium.toFixed(2)} satisfies the local buy intent; management unlocked`);
          }

          const pos = {
            ...(meta.ai || {}),
            ticker,
            type: optType || "unknown",
            strike,
            dte: contractIdentityVerified ? (meta.dte ?? dteRemaining) : null,
            dteRemaining,
            expiryDate: contractIdentityVerified ? expMs : null,
            occSymbol: occ,
            optionMetaKey,
            instrumentUrl: instrumentId || null,
            verifiedInstrumentId: contractIdentityVerified && instrumentId ? instrumentId : null,
            contractIdentityVerified,
            // Prefer the actual Robinhood fill price over our pre-order limit estimate.
            // Fall back to meta only when RH hasn't reported an average_price yet (pending fill).
            entryPremium: entryPremium > 0 ? entryPremium : (meta.entryPremium ?? 0),
            intendedEntryPremium: meta.intendedEntryPremium ?? null,
            entrySpot: meta.entrySpot ?? prevExact?.entrySpot ?? (quotes[ticker]?.c ?? null),
            qty,
            originalQty: meta.originalQty ?? prevExact?.originalQty ?? qty,
            cost: Math.abs(entryPremium * qty * 100),
            openDate: meta.openDate ?? prevExact?.openDate ?? (op.created_at || op.updated_at ? String(op.created_at || op.updated_at).slice(0, 10) : getETDateStr()),
            // Prefer persisted meta; else RH created_at. Never default to "now" every sync —
            // that would zero held-days and corrupt DTE/lifecycle decisions (PATH Jul 7→13).
            openTime: meta.openTime
              ?? prevExact?.openTime
              ?? (op.created_at ? new Date(op.created_at).getTime() : null)
              ?? (op.updated_at ? new Date(op.updated_at).getTime() : null)
              ?? (meta.openDate ? new Date(meta.openDate + "T16:00:00-04:00").getTime() : now),
            trimLevel: meta.trimLevel ?? 0,
            bestPnlPct: meta.bestPnlPct ?? 0,
            bestExitPnlPct: meta.bestExitPnlPct ?? 0,
            managementPlan: meta.managementPlan || prevExact?.managementPlan || null,
            lastManagementDecision: meta.lastManagementDecision || prevExact?.lastManagementDecision || null,
            entryAtrPct: meta.entryAtrPct ?? prevExact?.entryAtrPct ?? null,
            plannedRiskDollars: meta.plannedRiskDollars ?? prevExact?.plannedRiskDollars ?? null,
            riskGovernor: meta.riskGovernor ?? prevExact?.riskGovernor ?? null,
            iv: parseFloat(op.implied_volatility || 0) || null,
            liveMark: safeMark,
            liveBid: safeBid,
            liveAsk: safeAsk,
            liveQuoteAt: null,
            _pendingEntry: !!(meta.entryOrderPlacedAt && meta.entryOrderCtx),
            liveGreeks: op.greeks || null,
            optionsSource: "robinhood",
            direction: optType === "call" ? "BULLISH" : optType === "put" ? "BEARISH" : "UNKNOWN",
          };

          restorePosTrail(pos, meta, prevExact);

          // Basis bookkeeping: when RH reports an actual average fill, persist it so stop/target
          // math and closure booking use the real basis even if the field is absent next cycle.
          // When it doesn't, mark the basis as an estimate so Step 1.2 reconciles it from the
          // filled-orders feed. A submitted limit is never interchangeable with the broker fill.
          if (entryPremium > 0) {
            if (optionMetaKey) {
              if (!state.meta[optionMetaKey]) state.meta[optionMetaKey] = {};
              state.meta[optionMetaKey].entryPremium = entryPremium;
              state.meta[optionMetaKey].entryFillReconciled = true;
            }
          } else {
            pos._basisEstimated = !meta.entryFillReconciled;
          }

          if (pos.liveMark != null && pos.entryPremium > 0) {
            const pnl = (pos.liveMark - pos.entryPremium) / pos.entryPremium;
            if (pnl > pos.bestPnlPct) pos.bestPnlPct = pnl;
            recordMarkTrail(pos, pos.liveMark, now, pos.liveBid, pos.liveAsk);
          }
          persistPosTrailMeta(acct, pos);

          let aiData = meta.ai || null;
          if (!aiData) {
            const curAnalysis = acct.dashboard?.analyses?.[ticker];
            if (curAnalysis) {
              const typeLabel = (optType === "call" || optType === "put") ? optType.toUpperCase() : "OPTION";
              aiData = {
                claudeReasoning: `Options position synced from Robinhood. ${typeLabel} $${strike || "?"} exp ${expDate || "?"}.`,
                claudeSuggestion: "",
                claudeConcerns: [],
                setupQuality: meta.setupQuality ?? curAnalysis.score ?? null,
                technicalScore: curAnalysis.score ?? null,
                direction: pos.direction,
                regimeAtEntry: acct.currentRegime?.label ?? "unknown",
                topSignals: (curAnalysis.sigs || []).slice(0, 5).map(s => s.text),
              };
            }
          }
          if (aiData) Object.assign(pos, aiData);

          positions.push(pos);
          if (optionMetaKey) seen.add(optionMetaKey);
          } catch (posErr) {
            log(acct, `ROBINHOOD SYNC: skip one options position — ${posErr.message}`);
          }
        }
      } catch (e) {
        optionsFetchOk = false;
        log(acct, `ROBINHOOD SYNC: options positions error — ${e.message}`);
      }
    }

    if (nonLongOptionTickers.size > 0) {
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        if (pos.type === "equity" || !nonLongOptionTickers.has(String(pos.ticker || "").toUpperCase())) continue;
        if (pos.occSymbol) seen.delete(pos.occSymbol);
        if (pos.optionMetaKey) seen.delete(pos.optionMetaKey);
        positions.splice(i, 1);
      }
    }

    // ── Broker-fill reconciliation helpers ──
    // Our own limit prices are working estimates, not fills. Everything below prefers the fill
    // Robinhood actually reports; the broker activity record is authoritative for cost basis.
    let _optionOrders = optionOrdersSnapshot; // reuse the all-state snapshot fetched for locks
    const getOptionOrders = async () => {
      if (_optionOrders) return _optionOrders;
      try {
        // No state filter: partial-then-cancelled orders contain real executions and must reconcile.
        const fRes = await robinhood.getOptionsOrders({}).catch(() => null);
        const fRaw = fRes && fRes.data ? fRes.data : fRes;
        _optionOrders = Array.isArray(fRaw) ? fRaw
          : (fRaw && Array.isArray(fRaw.orders)) ? fRaw.orders
          : (fRaw && Array.isArray(fRaw.results)) ? fRaw.results : [];
      } catch { _optionOrders = []; }
      return _optionOrders;
    };
    const getOptionOrderById = async orderId => {
      if (!orderId) return null;
      const cached = (await getOptionOrders()).find(order => String(order.id || order.order_id || "") === String(orderId));
      if (cached) return cached;
      try {
        const response = await robinhood.getOptionsOrders({ order_id: orderId });
        const rawResponse = response?.data ?? response;
        const records = Array.isArray(rawResponse) ? rawResponse
          : Array.isArray(rawResponse?.orders) ? rawResponse.orders
            : Array.isArray(rawResponse?.results) ? rawResponse.results
              : rawResponse && typeof rawResponse === "object" ? [rawResponse] : [];
        return records.find(order => String(order.id || order.order_id || "") === String(orderId)) || null;
      } catch {
        return null;
      }
    };
    // Executions/processed_premium are fills. Robinhood `price` and `premium` are submitted limits
    // (SPY: 5.23 submitted vs 4.69 actual) and must never be booked as execution prices.
    const orderFillPremium = order => {
      const fill = optionOrderAverageFillPrice(order);
      return fill > 0 ? +fill.toFixed(2) : null;
    };

    // Step 0.5: Detect positions that closed (or shrank) at the broker since last cycle and
    // record them as trades. Robinhood exits fire-and-forget a sell order and keep the position
    // until sync; without this, filled exits simply vanished — no history entry, no realized
    // P&L, no trim-level advancement, and nothing feeding the loss circuit breakers.
    {
      const findCurrent = (prev) => prev.type === "equity"
        ? positions.find(p => p.type === "equity" && p.ticker === prev.ticker)
        : positions.find(p => p.type !== "equity" && (
            (prev.occSymbol && p.occSymbol === prev.occSymbol) ||
            (normalizeOptionId(prev.instrumentUrl) && normalizeOptionId(p.instrumentUrl) === normalizeOptionId(prev.instrumentUrl))
          ));
      for (const prev of prevPositions) {
        if (!(prev.qty > 0) || !(prev.entryPremium > 0)) continue;
        // A broker-reported short/mixed exposure owns this ticker now. Do not resurrect the prior
        // long into the positions list: downstream recovery can otherwise replay sell_to_close.
        if (prev.type !== "equity" && nonLongOptionTickers.has(String(prev.ticker || "").toUpperCase())) continue;
        // If the options fetch failed this cycle, we can't tell "closed" from "API error" for
        // option positions — skip them entirely rather than book phantom exits.
        if (prev.type !== "equity" && !optionsFetchOk) {
          positions.push({ ...prev, _syncMissing: true });
          const priorMetaKey = prev.occSymbol || prev.optionMetaKey;
          if (priorMetaKey) seen.add(priorMetaKey);
          continue;
        }
        const metaKey = prev.type === "equity" ? prev.ticker : (prev.occSymbol || prev.optionMetaKey);
        const posMeta = metaKey ? state.meta[metaKey] : null;
        const cur = findCurrent(prev);
        let closedQty = cur ? Math.max(0, prev.qty - cur.qty) : prev.qty;
        if (closedQty <= 0) continue;

        const weExited = !!(posMeta && (posMeta.exitOrderPlacedAt || posMeta.exitOrderId));
        const expired = !cur && prev.expiryDate && prev.expiryDate < now;
        const mult = prev.type === "equity" ? 1 : 100;
        let closePremium = null;
        let fillConfirmed = false;
        let matchedExitOrder = null;
        let fillGrossForDelta = null;
        let reconciledFromBrokerHistory = false;
        const bookedExitOrderIds = new Set(
          (state.history || [])
            .flatMap(t => [t._exitOrderId, t._matchedOrderId].filter(Boolean))
            .map(String),
        );

        if (expired && !weExited) {
          closePremium = 0;
        } else if (prev.type !== "equity") {
          const orders = await getOptionOrders();
          let o = findExactOptionOrder(orders, {
            instrumentId: prev.instrumentUrl,
            occSymbol: prev.occSymbol,
            side: "sell",
            orderId: posMeta?.exitOrderId || null,
            refId: posMeta?.exitOrderRefId || null,
            submittedAt: posMeta?.exitOrderPlacedAt || prev.openTime || 0,
            now,
          });
          if (!o && posMeta?.exitOrderId) {
            const exactById = await getOptionOrderById(posMeta.exitOrderId);
            o = findExactOptionOrder(exactById ? [exactById] : [], {
              instrumentId: prev.instrumentUrl,
              occSymbol: prev.occSymbol,
              side: "sell",
              orderId: posMeta.exitOrderId,
              submittedAt: posMeta.exitOrderPlacedAt || prev.openTime || 0,
              now,
            });
          }
          matchedExitOrder = o;
          if (o && optionOrderExecutedQuantity(o) > 0) {
            const cumulativeQty = optionOrderExecutedQuantity(o);
            const cumulativeGross = optionOrderExecutedGross(o);
            const bookedQty = Number(posMeta?.exitBookedQty) || 0;
            const bookedGross = Number(posMeta?.exitBookedGross) || 0;
            const deltaQty = cumulativeQty - bookedQty;
            const deltaGross = cumulativeGross - bookedGross;
            if (deltaQty > 0 && Math.abs(deltaQty - closedQty) < 0.0001 && deltaGross > 0) {
              closePremium = deltaGross / deltaQty;
              fillGrossForDelta = deltaGross;
              fillConfirmed = true;
            }
          }

          // Holdings can disappear before local exit metadata is durable, or after an agentic fill
          // whose order id never made it back to disk. Trust the broker's sell history for the
          // exact contract once the positions feed confirms the long is gone.
          if (closePremium == null && !cur) {
            const brokerClose = findBrokerCloseFillForPosition(orders, {
              instrumentId: prev.instrumentUrl,
              occSymbol: prev.occSymbol,
              openTime: prev.openTime || 0,
              expectedQty: closedQty,
              excludeOrderIds: [...bookedExitOrderIds],
              now,
            });
            if (brokerClose) {
              matchedExitOrder = brokerClose.order;
              closePremium = brokerClose.fillPrice;
              fillGrossForDelta = brokerClose.gross;
              fillConfirmed = true;
              reconciledFromBrokerHistory = true;
              log(acct, `ROBINHOOD SYNC: ${prev.ticker} ${prev.occSymbol || ""} closed at broker — reconciled from order ${optionOrderId(brokerClose.order) || "?"}`);
            }
          }
        }

        if (closePremium == null) {
          if (weExited && !expired) {
            if (cur) {
              cur.qty = prev.qty;
              cur._pendingExit = true;
            } else {
              positions.push({ ...prev, _pendingExit: true });
              if (metaKey) seen.add(metaKey);
            }
            if (!posMeta?.exitReconcileWaitLoggedAt || now - posMeta.exitReconcileWaitLoggedAt >= 60_000) {
              if (posMeta) posMeta.exitReconcileWaitLoggedAt = now;
              log(acct, `ROBINHOOD SYNC: ${prev.ticker} changed while exit is pending but no exact matching fill is reported yet — deferring trim/P&L bookkeeping`);
            }
            continue;
          }
          if (!cur) {
            positions.push({ ...prev, _syncMissing: true });
            if (metaKey) seen.add(metaKey);
            if (!prev._syncMissing) {
              log(acct, `ROBINHOOD SYNC: ${prev.ticker} ${prev.type} position gone with no matching broker close fill — retaining until reconciliation`);
            }
          }
          continue;
        }

        if (expired && closePremium == null) closePremium = 0;
        const pnlDollar = (closePremium - prev.entryPremium) * closedQty * mult;
        const pnlPct = (closePremium - prev.entryPremium) / prev.entryPremium;
        const reason = posMeta?.exitReason
          || (reconciledFromBrokerHistory ? "robinhood close reconciled from broker fill" : null)
          || (expired && !weExited ? "expired worthless" : "robinhood exit filled (synced)");
        const proceeds = +(closePremium * closedQty * mult).toFixed(2);
        const trade = {
          ...prev, qty: closedQty,
          closePremium: +(+closePremium).toFixed(2),
          proceeds,
          pnlDollar: +pnlDollar.toFixed(2), pnlPct,
          reason, closeDate: getETDateStr(), closeTime: now,
          _estimated: !fillConfirmed,
          _exitOrderId: matchedExitOrder ? optionOrderId(matchedExitOrder) : null,
        };
        // Sale proceeds are invisible to buying power until T+1 — credit them to PV until then.
        if (proceeds > 0) {
          state.rhUnsettled = state.rhUnsettled || [];
          state.rhUnsettled.push({ amount: proceeds, date: getETDateStr() });
        }
        state.history.push(trade);
        logTrade(trade);
        state.realizedPnl = (state.realizedPnl || 0) + pnlDollar;
        recordTradeOutcome(acct, pnlDollar);
        log(acct, `ROBINHOOD ${cur ? "TRIM" : "EXIT"} FILLED: ${prev.ticker} ${prev.type === "equity" ? "" : `$${prev.strike} ${prev.type.toUpperCase()} `}${closedQty}x @ ~$${(+closePremium).toFixed(2)} → ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${(pnlPct * 100).toFixed(0)}%) — ${reason}`);
        diag("exit_fill", acct, { ticker: prev.ticker, occ: prev.occSymbol || prev.ticker, qty: closedQty, estClose: +(+closePremium).toFixed(2), pnl: +pnlDollar.toFixed(2), pnlPct: +(pnlPct * 100).toFixed(1), reason, source: "rh-sync-diff" });

        if (cur && posMeta) {
          if (matchedExitOrder && fillConfirmed) {
            posMeta.exitBookedQty = (Number(posMeta.exitBookedQty) || 0) + closedQty;
            posMeta.exitBookedGross = (Number(posMeta.exitBookedGross) || 0) + (fillGrossForDelta || closePremium * closedQty);
            if (posMeta.exitIsTrim) {
              const targetLevel = posMeta.exitTrimTargetLevel
                ?? posMeta.trimPendingLevel
                ?? Math.min(4, (posMeta.trimLevel || 0) + 1);
              if (!(posMeta.trimPendingTargetQty > 0)) posMeta.trimPendingTargetQty = posMeta.exitRequestedQty || closedQty;
              posMeta.trimPendingLevel = targetLevel;
              posMeta.trimPendingFilledQty = (Number(posMeta.trimPendingFilledQty) || 0) + closedQty;
              if (posMeta.trimPendingFilledQty >= posMeta.trimPendingTargetQty) {
                posMeta.trimLevel = targetLevel;
                cur.trimLevel = targetLevel;
                delete posMeta.trimPendingLevel;
                delete posMeta.trimPendingTargetQty;
                delete posMeta.trimPendingFilledQty;
                log(acct, `ROBINHOOD SYNC: ${prev.ticker} trim tier ${targetLevel} fully filled`);
              }
            }

            const requestedQty = Number(posMeta.exitRequestedQty) || closedQty;
            const orderComplete = (Number(posMeta.exitBookedQty) || 0) >= requestedQty;
            const terminal = optionOrderIsTerminal(matchedExitOrder);
            const remainingOnOrder = optionOrderRemainingQuantity(matchedExitOrder);
            if (orderComplete || terminal || remainingOnOrder === 0) {
              clearExitOrderTracking(posMeta, { keepAttempts: false });
              acct._inflightTickers.delete(prev.ticker.toUpperCase());
            } else {
              // A live partial remainder owns this contract; manager must not arm another tier.
              cur._pendingExit = true;
            }
          } else {
            clearExitOrderTracking(posMeta, { keepAttempts: false });
          }
        } else if (!cur && metaKey) {
          clearExitOrderTracking(posMeta || {}, { keepAttempts: false });
          delete state.meta[metaKey]; // fully closed — retire the side-metadata
          acct._inflightTickers?.delete(prev.ticker.toUpperCase());
        }
      }
    }

    // Step 1: Resolve incomplete option identity by exact instrument UUID only. Never scrape the
    // first same-ticker/type order: multiple PATH/SPY calls can share ticker/type/strike while their
    // expiries differ, and a borrowed old expiry can trigger a false DTE_CRITICAL liquidation.
    if (robinhood.optionsEnabled) {
      const identityUnknown = positions.filter(
        p => p.optionsSource === "robinhood" && p.type !== "equity" && !isVerifiedRobinhoodContract(p)
      );
      if (identityUnknown.length > 0) {
        const instrumentCache = new Map();
        const extractRecords = response => {
          const rawResponse = response?.data ?? response;
          if (Array.isArray(rawResponse)) return rawResponse;
          if (Array.isArray(rawResponse?.results)) return rawResponse.results;
          if (Array.isArray(rawResponse?.instruments)) return rawResponse.instruments;
          if (Array.isArray(rawResponse?.option_instruments)) return rawResponse.option_instruments;
          return [];
        };
        for (const pos of identityUnknown) {
          const instrumentId = normalizeOptionId(pos.instrumentUrl);
          if (!instrumentId) continue;
          try {
            // Prefer exact UUID lookup — chain scrapes paginate and can miss the held contract.
            let records = extractRecords(await robinhood.getOptionInstruments({ ids: instrumentId }).catch(() => null));
            if (!records.length) {
              let byTicker = instrumentCache.get(pos.ticker);
              if (!byTicker) {
                byTicker = extractRecords(await robinhood.getOptionInstruments(pos.ticker).catch(() => null));
                instrumentCache.set(pos.ticker, byTicker);
              }
              records = byTicker;
            }
            let identity = resolveExactOptionIdentity(instrumentId, records);
            if (!identity) identity = resolveExactOptionIdentity(instrumentId, await getOptionOrders());
            if (!identity || (identity.ticker && identity.ticker !== pos.ticker)) continue;

            const expMs = optionExpirationTimestamp(identity.expiration);
            if (!(expMs > 0)) continue;
            const exactOcc = robinhood.buildOCC(pos.ticker, identity.expiration, identity.type, identity.strike);
            const priorKey = pos.optionMetaKey;
            const exactMeta = {
              ...(priorKey ? state.meta[priorKey] : {}),
              ...(state.meta[exactOcc] || {}),
              resolvedStrike: identity.strike,
              resolvedExpiry: identity.expiration,
              contractIdentityVerified: true,
              instrumentId,
            };
            state.meta[exactOcc] = exactMeta;
            if (priorKey && priorKey !== exactOcc) delete state.meta[priorKey];

            Object.assign(pos, {
              type: identity.type,
              direction: identity.type === "call" ? "BULLISH" : "BEARISH",
              strike: identity.strike,
              expiryDate: expMs,
              dteRemaining: Math.max(0, Math.ceil((expMs - now) / 86400000)),
              dte: exactMeta.dte ?? Math.max(0, Math.ceil((expMs - now) / 86400000)),
              occSymbol: exactOcc,
              optionMetaKey: exactOcc,
              verifiedInstrumentId: instrumentId,
              contractIdentityVerified: true,
            });
            seen.add(exactOcc);
            log(acct, `ROBINHOOD SYNC: verified exact ${pos.ticker} ${identity.type} $${identity.strike} exp=${identity.expiration} from instrument ${instrumentId.slice(0, 8)}`);
          } catch (e) {
            log(acct, `ROBINHOOD SYNC: exact contract resolve error for ${pos.ticker} — ${e.message}`);
          }
        }
      }
    }

    // Step 1.2: Reconcile entry cost basis against actual broker fills. The entry chase records
    // "what we were willing to pay" as a working estimate; when the real fill differs, every
    // stop/target computed off that estimate is wrong. Reconcile before the manager acts.
    if (robinhood.optionsEnabled) {
      const basisUnknown = positions.filter(p => p.optionsSource === "robinhood" && p.type !== "equity"
        && isVerifiedRobinhoodContract(p) && p._basisEstimated);
      for (const pos of basisUnknown) {
        try {
          const metaKey = pos.occSymbol || pos.optionMetaKey;
          const basisMeta = metaKey ? state.meta[metaKey] : null;
          if (!basisMeta) continue;
          const orders = await getOptionOrders();
          const o = findExactOptionOrder(orders, {
            instrumentId: pos.instrumentUrl,
            occSymbol: pos.occSymbol,
            side: "buy",
            orderId: basisMeta.entryOrderId || null,
            refId: basisMeta.entryOrderRefId || null,
            submittedAt: basisMeta.entryOrderPlacedAt || pos.openTime || 0,
            now,
          });
          const fill = o && optionOrderExecutedQuantity(o) > 0 ? orderFillPremium(o) : null;
          if (fill == null) continue;
          basisMeta.entryPremium = fill;
          basisMeta.entryFillReconciled = true;
          if (Math.abs(fill - pos.entryPremium) > 0.005) {
            log(acct, `ROBINHOOD SYNC: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} cost basis reconciled $${pos.entryPremium.toFixed(2)} → $${fill.toFixed(2)} (actual broker fill)`);
            pos.entryPremium = fill;
            pos.cost = Math.abs(fill * pos.qty * 100);
          }
          pos._basisEstimated = false;
        } catch (e) {
          log(acct, `ROBINHOOD SYNC: basis reconcile error for ${pos.ticker} — ${e.message}`);
        }
      }
    }

    // Step 1.5: Exact-order watchdog. Never release a lock merely because an order is absent from
    // the `confirmed` feed: queued, partial, and pending-cancel orders can still sell the contract.
    if (robinhood.optionsEnabled) {
      for (const pos of positions) {
        if (pos.type === "equity" || pos.optionsSource !== "robinhood") continue;
        const metaKey = pos.occSymbol || pos.optionMetaKey;
        const posMeta = metaKey ? state.meta[metaKey] : null;
        if (!posMeta || !posMeta.exitOrderPlacedAt) continue;
        const age = now - posMeta.exitOrderPlacedAt;
        if (!posMeta.exitOrderId && posMeta.exitOrderRefId
            && (!posMeta.exitRecoveryAttemptAt || now - posMeta.exitRecoveryAttemptAt >= 30_000)) {
          // The first submission may have succeeded even though its response was lost. Replaying the
          // exact payload with the SAME ref is the only safe recovery; a fresh ref could duplicate-sell.
          const expStr = pos.expiryDate ? new Date(pos.expiryDate).toISOString().slice(0, 10) : null;
          const requestedQty = Number(posMeta.exitRequestedQty);
          const limit = Number(posMeta.exitOrderLimit);
          const completeCtx = expStr && requestedQty > 0 && limit > 0
            && (pos.type === "call" || pos.type === "put") && Number(pos.strike) > 0
            && pos.instrumentUrl;
          pos._pendingExit = true;
          if (completeCtx) {
            posMeta.exitRecoveryAttemptAt = now;
            try {
              const recovered = await robinhood.placeOptionOrder({
                symbol: pos.ticker,
                expirationDate: expStr,
                strikePrice: pos.strike,
                optionType: pos.type,
                side: "sell_to_close",
                quantity: requestedQty,
                type: "limit",
                limitPrice: limit.toFixed(2),
                refId: posMeta.exitOrderRefId,
                optionId: pos.instrumentUrl,
              });
              const recoveredId = brokerOrderId(recovered);
              if (recoveredId) {
                posMeta.exitOrderId = recoveredId;
                delete posMeta.exitSubmissionUnknownAt;
                log(acct, `ROBINHOOD EXIT RECOVERY: recovered order ${recoveredId} for ${pos.ticker} using persisted ref ${posMeta.exitOrderRefId}`);
              } else {
                posMeta.exitSubmissionUnknownAt = now;
                if (!posMeta.exitRecoveryNoIdLoggedAt || now - posMeta.exitRecoveryNoIdLoggedAt >= 15 * 60_000) {
                  posMeta.exitRecoveryNoIdLoggedAt = now;
                  log(acct, `ROBINHOOD EXIT RECOVERY: ${pos.ticker} still returned no order id; retaining persisted ref and quarantine`);
                }
              }
            } catch (e) {
              if (e.brokerRejected) {
                clearExitOrderTracking(posMeta);
                acct._inflightTickers.delete(pos.ticker.toUpperCase());
                delete pos._pendingExit;
                log(acct, `ROBINHOOD EXIT RECOVERY REJECTED ${pos.ticker}: ${e.message}; cleared rejected intent`);
                continue;
              }
              posMeta.exitSubmissionUnknownAt = now;
              if (!posMeta.exitRecoveryErrorLoggedAt || now - posMeta.exitRecoveryErrorLoggedAt >= 15 * 60_000) {
                posMeta.exitRecoveryErrorLoggedAt = now;
                log(acct, `ROBINHOOD EXIT RECOVERY UNKNOWN ${pos.ticker}: ${e.message}; retaining persisted ref and quarantine`);
              }
            }
          } else if (!posMeta.exitRecoveryContextLoggedAt || now - posMeta.exitRecoveryContextLoggedAt >= 15 * 60_000) {
            posMeta.exitRecoveryContextLoggedAt = now;
            log(acct, `ROBINHOOD EXIT RECOVERY BLOCKED ${pos.ticker}: incomplete persisted exact-contract context; retaining quarantine`);
          }
        }

        let exactOrder = posMeta.exitOrderId ? await getOptionOrderById(posMeta.exitOrderId) : null;
        if (exactOrder) {
          exactOrder = findExactOptionOrder([exactOrder], {
            instrumentId: pos.instrumentUrl,
            occSymbol: pos.occSymbol,
            side: "sell",
            orderId: posMeta.exitOrderId,
            submittedAt: posMeta.exitOrderPlacedAt,
            now,
          });
        }

        if (!exactOrder) {
          // A transport timeout can happen after broker acceptance. With no exact order id/status,
          // quarantine the position; clearing the intent here could submit a duplicate sell.
          pos._pendingExit = true;
          if (!posMeta.exitReconcileWaitLoggedAt || now - posMeta.exitReconcileWaitLoggedAt >= 60_000) {
            posMeta.exitReconcileWaitLoggedAt = now;
            log(acct, `ROBINHOOD SYNC: exit status unresolved for ${pos.ticker} — retaining duplicate-order lock and quarantining automated exits`);
          }
          continue;
        }

        const executedQty = optionOrderExecutedQuantity(exactOrder);
        const bookedQty = Number(posMeta.exitBookedQty) || 0;
        if (optionOrderIsTerminal(exactOrder)) {
          if (executedQty > bookedQty + 0.0001) {
            // Executions are ahead of the positions endpoint. Wait for quantity coherence so the
            // fill is booked once at its exact cumulative delta before releasing anything.
            pos._pendingExit = true;
            continue;
          }
          clearExitOrderTracking(posMeta);
          acct._inflightTickers.delete(pos.ticker.toUpperCase());
          continue;
        }

        pos._pendingExit = true;
        const staleAfterMs = Number(posMeta.exitStaleAfterMs) || 3 * 60_000;
        const orderState = String(exactOrder.state || exactOrder.status || "").toLowerCase();
        const pendingCancel = orderState === "pending_cancelled" || orderState === "pending_canceled";
        const cancelRetryMs = pendingCancel ? 60_000 : 30_000;
        const lastCancelAttemptAt = Math.max(
          Number(posMeta.exitCancelAttemptedAt) || 0,
          Number(posMeta.exitCancelRequestedAt) || 0,
          Number(posMeta.exitCancelFailedAt) || 0,
        );
        const cancelRetryDue = !lastCancelAttemptAt || now - lastCancelAttemptAt >= cancelRetryMs;
        if (age >= staleAfterMs && posMeta.exitOrderId && cancelRetryDue) {
          const retrying = !!lastCancelAttemptAt;
          posMeta.exitCancelAttemptedAt = now;
          try {
            await robinhood.cancelOptionOrder(posMeta.exitOrderId);
            posMeta.exitAttempts = (posMeta.exitAttempts || 0) + 1;
            posMeta.exitCancelRequestedAt = now;
            delete posMeta.exitCancelFailedAt;
            log(acct, `ROBINHOOD SYNC: cancel ${retrying ? "retried" : "requested"} for stale ${posMeta.exitPriceMode || "exit"} order on ${pos.ticker} after ${(age / 1000).toFixed(0)}s @ $${posMeta.exitOrderLimit} (attempt ${posMeta.exitAttempts})`);
          } catch (e) {
            posMeta.exitCancelFailedAt = now;
            log(acct, `ROBINHOOD SYNC: cancel stale exit order failed for ${pos.ticker} — ${e.message}`);
          }
        }
      }
    }

    // Step 2: Fetch live bid prices for options positions that still have no live mark.
    // Bid = what we'd actually receive when selling to close.
    //
    // CRITICAL: never batch-match by bare ticker / loose field equality. On 2026-07-10 the bot
    // assigned SPY's ~$6.66 mark to PATH (entry $0.85) and tried to sell_to_close PATH at SPY's
    // premium (~$666 contract vs ~$85 real). Matching MUST be by instrument UUID or exact OCC.
    if (robinhood.optionsEnabled) {
      const needsMark = positions.filter(
        p => p.optionsSource === "robinhood" && p.type !== "equity"
          && isVerifiedRobinhoodContract(p)
          && (p.liveMark == null || p.liveBid == null || !(p.liveQuoteAt > 0)
            || now - p.liveQuoteAt > RH_OPTION_QUOTE_MAX_AGE_MS)
      );
      if (needsMark.length > 0) {
        const extractMdItems = (mdRes) => {
          const mdRaw = mdRes && mdRes.data ? mdRes.data : mdRes;
          if (Array.isArray(mdRaw)) return mdRaw;
          if (mdRaw && Array.isArray(mdRaw.options)) return mdRaw.options;
          if (mdRaw && Array.isArray(mdRaw.results)) return mdRaw.results;
          if (mdRaw && Array.isArray(mdRaw.contracts)) return mdRaw.contracts;
          return [];
        };
        const applyQuoteToPos = (pos, match, sourceLabel) => {
          if (!isVerifiedRobinhoodContract(pos) || !exactOptionQuoteMatches(pos, {
            ...match,
            ...(match.quote && typeof match.quote === "object" ? match.quote : {}),
            ...(match.market_data && typeof match.market_data === "object" ? match.market_data : {}),
          })) return false;
          const src = (match.quote && typeof match.quote === "object")
            ? { ...match, ...match.quote }
            : (match.market_data && typeof match.market_data === "object")
              ? { ...match, ...match.market_data }
              : match;
          const num = (...keys) => {
            for (const k of keys) {
              const v = parseFloat(src[k]);
              if (!isNaN(v) && v > 0) return v;
            }
            return null;
          };
          const bid = num("bid_price", "bid", "best_bid_price");
          const ask = num("ask_price", "ask", "best_ask_price");
          const markRaw = num("mark_price", "adjusted_mark_price", "mark");
          const lastTrade = num("last_trade_price", "last_trade", "last_price", "previous_close_price");
          if (bid != null && ask != null && ask < bid) {
            log(acct, `ROBINHOOD SYNC: rejected crossed quote for ${pos.ticker} (${sourceLabel}) bid=${bid} ask=${ask}`);
            return false;
          }
          const mid = (bid != null && ask != null) ? +((bid + ask) / 2).toFixed(2) : null;
          const candidate = markRaw ?? mid ?? lastTrade ?? bid;
          pos.liveBid = bid;
          pos.liveAsk = ask;
          pos.liveMark = candidate;
          pos.liveQuoteAt = bid > 0 ? now : null;
          log(acct, `ROBINHOOD SYNC: ${pos.ticker} $${pos.strike} ${pos.type} live bid=${bid} ask=${ask} mark=${markRaw} mid=${mid} → liveMark=${pos.liveMark} (${sourceLabel})`);
          if (pos.liveMark != null && pos.entryPremium > 0) {
            const pnl = (pos.liveMark - pos.entryPremium) / pos.entryPremium;
            if (pnl > pos.bestPnlPct) pos.bestPnlPct = pnl;
            recordMarkTrail(pos, pos.liveMark, now, pos.liveBid, pos.liveAsk);
            persistPosTrailMeta(acct, pos);
          }
          return true;
        };
        const matchByHardId = (mdItems, pos) => {
          return mdItems.find(item => exactOptionQuoteMatches(pos, {
            ...item,
            ...(item.quote && typeof item.quote === "object" ? item.quote : {}),
            ...(item.market_data && typeof item.market_data === "object" ? item.market_data : {}),
          })) || null;
        };

        for (const pos of needsMark) {
          try {
            // Prefer per-position fetch by instrument UUID — never mix SPY+PATH into one response
            // and hope field matching sorts it out.
            let mdItems = [];
            let sourceLabel = "batch";
            if (pos.instrumentUrl) {
              const mdRes = await robinhood.getOptionMarketData([pos.instrumentUrl]);
              mdItems = extractMdItems(mdRes);
              sourceLabel = `id:${normalizeOptionId(pos.instrumentUrl)?.slice(0, 8) || "?"}`;
            } else if (pos.occSymbol && !String(pos.occSymbol).endsWith("_opt")) {
              const mdRes = await robinhood.getOptionMarketData([pos.occSymbol]);
              mdItems = extractMdItems(mdRes);
              sourceLabel = `occ:${pos.occSymbol}`;
            } else {
              log(acct, `ROBINHOOD SYNC: ${pos.ticker} ${pos.type} — skipping mark fetch (no instrument id / OCC; strike=${pos.strike})`);
              continue;
            }

            let match = matchByHardId(mdItems, pos);

            if (match) {
              applyQuoteToPos(pos, match, sourceLabel);
            } else {
              log(acct, `ROBINHOOD SYNC: ${pos.ticker} $${pos.strike} ${pos.type} — no hard id/OCC match in ${mdItems.length} items (${sourceLabel})`);
            }
          } catch (e) {
            log(acct, `ROBINHOOD SYNC: live bid fetch error for ${pos.ticker} — ${e.message}`);
          }
        }
      }

    }

    // Step 3: Work unfilled ENTRY orders — the "chase or walk away" decision.
    if (workEntries) await workRobinhoodEntryOrders(acct, now);

    // Prune stale meta — but never prune fresh metadata for an order that hasn't produced a
    // broker position yet (unfilled entries). Pruning those (the old behavior) destroyed the
    // AI thesis + entry context between order placement and fill.
    // Bare-ticker option metadata is ambiguous across expiries. It is never read above; retire it
    // immediately when the same ticker is not also an equity holding so it cannot leak into a later
    // contract's plan/trim state.
    const optionTickers = new Set(positions.filter(pos => pos.type !== "equity").map(pos => pos.ticker));
    for (const ticker of optionTickers) {
      const hasEquity = positions.some(pos => pos.type === "equity" && pos.ticker === ticker);
      if (!hasEquity && state.meta[ticker] && !seen.has(ticker)) delete state.meta[ticker];
    }

    const META_GRACE_MS = 24 * 60 * 60_000;
    for (const k of Object.keys(state.meta)) {
      if (seen.has(k)) continue;
      const m = state.meta[k] || {};
      const lastActivity = Math.max(m.openTime || 0, m.entryOrderPlacedAt || 0, m.exitOrderPlacedAt || 0);
      if (lastActivity && now - lastActivity < META_GRACE_MS) continue;
      delete state.meta[k];
    }

    state.positions = positions;
  } catch (e) { log(acct, `ROBINHOOD SYNC: positions error — ${e.message}`); }
}

// ─── Robinhood held-position lane ───
// Entry discovery may spend meaningful time on watchlists, news, AI validation, and contract
// ranking. Held positions use a separate lightweight cadence and share this lane only for broker
// sync/order mutations, so a manager tick can never overlap an entry commit.

const brokerExecutionLanes = new Map();
const RH_RECONNECT_BACKOFF_MS = 60_000;
const RH_HEALTH_PROBE_INTERVAL_MS = 30_000;
let rhReconnectAttemptAt = 0;
let rhReconnectPromise = null;
let rhLastHealthProbeAt = 0;
let rhHealthProbePromise = null;

async function ensureRobinhoodConnectionHealth() {
  const liveAccounts = [...accounts.values()].filter(acct => acct.config.broker === "robinhood" && !acct.learning);
  if (!liveAccounts.length) return robinhood.isConnected;

  const now = Date.now();
  let changed = false;

  // `isConnected` only proves that an MCP handshake once succeeded. Exercise a real, read-only
  // broker call on a short cadence so a dead session cannot look healthy indefinitely. Coalesce
  // concurrent manager/main-loop checks into one probe.
  if (rhHealthProbePromise) {
    await rhHealthProbePromise;
  } else if (robinhood.isAuthenticated && now - rhLastHealthProbeAt >= RH_HEALTH_PROBE_INTERVAL_MS) {
    rhLastHealthProbeAt = now;
    const probe = withBrokerExecutionLane(liveAccounts[0], () => robinhood.healthCheck())
      .catch(() => false);
    rhHealthProbePromise = probe;
    try { await probe; }
    finally { if (rhHealthProbePromise === probe) rhHealthProbePromise = null; }
  }

  if (!robinhood.isConnected) {
    for (const acct of liveAccounts) {
      const health = acct.state.brokerHealth || {};
      if (!health.disconnectedAt) health.disconnectedAt = now;
      health.status = "disconnected";
      health.lastCheckedAt = robinhood.lastHealthCheckAt || now;
      health.lastProbeFailureAt = robinhood.lastHealthFailureAt || health.lastProbeFailureAt || null;
      health.lastError = robinhood.lastHealthError || robinhood.lastInitError || "Robinhood transport unavailable";
      acct.state.brokerHealth = health;
      // A broker outage disables new entries immediately. Preserve a deliberate user pause, but
      // otherwise require manual resume after recovery; open-position exits keep their own lane.
      if (!(acct.paused && acct.pausedBy === "user") && !(acct.paused && acct.pausedBy === "broker")) {
        acct.paused = true;
        acct.pausedBy = "broker";
        acct._entryEpoch = (acct._entryEpoch || 0) + 1;
        changed = true;
      }
      if (!health.notifiedAt) {
        health.notifiedAt = now;
        const msg = "Robinhood connection is down. New entries are PAUSED; position management cannot execute until reconnection. Recovery will leave entries paused for manual review.";
        log(acct, `🚨 BROKER HEALTH: ${msg}`);
        diag("risk_halt", acct, { kind: "broker_disconnected", disconnectedAt: health.disconnectedAt });
        sendPush(`🚨 Broker disconnected [${acct.name}]`, msg, true).catch(() => {});
        changed = true;
      }
    }

    if (robinhood.isAuthenticated && !rhReconnectPromise && now - rhReconnectAttemptAt >= RH_RECONNECT_BACKOFF_MS) {
      rhReconnectAttemptAt = now;
      rhReconnectPromise = withBrokerExecutionLane(liveAccounts[0], async () => {
        try {
          const initialized = await robinhood.init();
          if (initialized) {
            rhLastHealthProbeAt = Date.now();
            await robinhood.healthCheck();
          }
        }
        catch (error) { console.log(`  [RH] Reconnect failed: ${error.message}`); }
      });
      rhReconnectPromise.finally(() => { rhReconnectPromise = null; });
      await rhReconnectPromise;
    }
  }

  if (robinhood.isConnected) {
    for (const acct of liveAccounts) {
      const health = acct.state.brokerHealth || {};
      if (health.status === "disconnected") {
        health.status = "reconnected_paused";
        health.lastDisconnectedAt = health.disconnectedAt || now;
        health.lastReconnectedAt = Date.now();
        delete health.disconnectedAt;
        delete health.notifiedAt;
        acct.state.brokerHealth = health;
        log(acct, "BROKER HEALTH: Robinhood reconnected — protective management is active; new entries remain paused until manual review/resume.");
        diag("data", acct, { kind: "broker_reconnected", paused: acct.paused, pausedBy: acct.pausedBy });
        changed = true;
      } else if (!health.status || health.status === "unknown") {
        health.status = "healthy";
        changed = true;
      }
      health.lastCheckedAt = robinhood.lastHealthCheckAt || Date.now();
      health.lastProbeSuccessAt = robinhood.lastHealthSuccessAt || health.lastProbeSuccessAt || null;
      delete health.lastError;
      acct.state.brokerHealth = health;
    }
  }
  if (changed) saveAccounts();
  return robinhood.isConnected;
}

function executionLaneFor(acct) {
  const key = acct.config.broker === "robinhood" ? "robinhood" : `${acct.config.broker}:${acct.id}`;
  if (!brokerExecutionLanes.has(key)) brokerExecutionLanes.set(key, new ExecutionLane());
  return brokerExecutionLanes.get(key);
}

function withBrokerExecutionLane(acct, work, options = {}) {
  return executionLaneFor(acct).run(work, options);
}

function robinhoodQuoteRows(raw) {
  const body = raw?.data ?? raw;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.quotes)) return body.quotes;
  return [];
}

async function fetchHeldRobinhoodQuotes(acct) {
  const tickers = [...new Set(
    (acct.state.positions || []).filter(pos => !pos._pending).map(pos => pos.ticker).filter(Boolean),
  )];
  const quotes = {};
  if (tickers.length > 0) {
    try {
      const rows = robinhoodQuoteRows(await robinhood.getQuotes(tickers));
      const fetchedAt = Date.now();
      for (const row of rows) {
        const ticker = String(row.symbol || row.chain_symbol || "").toUpperCase();
        if (!ticker || !tickers.includes(ticker)) continue;
        const number = (...values) => {
          for (const value of values) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
          }
          return null;
        };
        const c = number(row.last_trade_price, row.last_extended_hours_trade_price, row.mark_price, row.adjusted_previous_close);
        if (!(c > 0)) continue;
        const pc = number(row.previous_close, row.adjusted_previous_close, row.previous_close_price) || c;
        quotes[ticker] = {
          c,
          h: number(row.high_price, row.regular_market_day_high) || c,
          l: number(row.low_price, row.regular_market_day_low) || c,
          o: number(row.open_price, row.regular_market_open) || c,
          pc,
          d: c - pc,
          dp: pc > 0 ? ((c - pc) / pc) * 100 : 0,
          _underlyingQuoteFresh: true,
          _underlyingQuoteAt: fetchedAt,
        };
      }
    } catch (e) {
      log(acct, `POSITION MANAGER: held-underlying quote refresh failed — ${e.message}`);
    }
  }

  for (const ticker of tickers) {
    if (!quotes[ticker] && acct.dashboard?.quotes?.[ticker]?.c > 0) {
      // Clone the dashboard row: tagging a fallback stale must not mutate shared dashboard state.
      quotes[ticker] = {
        ...acct.dashboard.quotes[ticker],
        _underlyingQuoteFresh: false,
        _underlyingQuoteAt: null,
      };
    }
  }
  return quotes;
}

function analyzeHeldPositions(acct, quotes) {
  const analyses = {};
  const shortTermAnalyses = {};
  for (const ticker of [...new Set((acct.state.positions || []).map(pos => pos.ticker).filter(Boolean))]) {
    const candles = acct.candleCache[ticker];
    const quote = quotes[ticker];
    if (candles?.length && quote?.c > 0) {
      const last = candles[candles.length - 1];
      last.c = quote.c;
      last.h = Math.max(last.h, quote.h ?? quote.c);
      last.l = Math.min(last.l, quote.l ?? quote.c);
    }
    if (!candles) continue;
    const analysis = runAnalysis(candles);
    const shortTerm = runShortTermAnalysis(candles);
    if (!analysis) continue;
    if (shortTerm) shortTermAnalyses[ticker] = shortTerm;
    const blended = blendScores(analysis, shortTerm);
    const hintBias = getHintBias(acct, ticker);
    analysis.score = Math.max(0, Math.min(100, blended.score + hintBias));
    analysis.signal = signalLabel(analysis.score);
    analyses[ticker] = analysis;
  }
  return { analyses, shortTermAnalyses };
}

async function runRobinhoodPositionManagement(acct) {
  if (acct.config.broker !== "robinhood" || !robinhood.isConnected) return { skipped: true };
  const hasHolding = (acct.state.positions || []).some(pos => !pos._pending);
  const hasExitIntent = Object.values(acct.state.meta || {}).some(meta => meta?.exitOrderPlacedAt);
  if (!hasHolding && !hasExitIntent) {
    acct._lastPositionManagerAt = Date.now();
    return { skipped: true };
  }

  return withBrokerExecutionLane(acct, async () => {
    const quotes = await fetchHeldRobinhoodQuotes(acct);
    await syncRobinhoodAccount(acct, quotes, { workEntries: true, refreshBalance: false });

    const { analyses, shortTermAnalyses } = analyzeHeldPositions(acct, quotes);
    await manageOpenPositions(acct, quotes, analyses, shortTermAnalyses);
    acct.dashboard.quotes = { ...(acct.dashboard.quotes || {}), ...quotes };
    acct.dashboard.analyses = { ...(acct.dashboard.analyses || {}), ...analyses };
    acct.dashboard.shortTermAnalyses = { ...(acct.dashboard.shortTermAnalyses || {}), ...shortTermAnalyses };
    acct.dashboard.positionDetails = buildPositionDetails(acct, quotes);
    acct.dashboard.lastManagementCycle = Date.now();
    acct._lastPositionManagerAt = Date.now();
    saveAccounts();
    return { skipped: false };
  }, { skipIfBusy: true });
}

function startRobinhoodPositionManager() {
  if (![...accounts.values()].some(acct => acct.config.broker === "robinhood")) return;
  console.log(`  Robinhood position manager: independent ${POSITION_MANAGEMENT_MS / 1000}s held-position cadence`);
  const tick = async () => {
    const startedAt = Date.now();
    const marketOpen = isMarketOpenLocal();
    try { await ensureRobinhoodConnectionHealth(); }
    catch (e) { console.log(`  [RH] Health watchdog error: ${e.message}`); }
    if (marketOpen) {
      for (const acct of accounts.values()) {
        if (acct.config.broker !== "robinhood") continue;
        try {
          await runRobinhoodPositionManagement(acct);
        } catch (e) {
          log(acct, `POSITION MANAGER LOOP ERROR: ${e.message}`);
        }
      }
    }
    const cadence = marketOpen ? POSITION_MANAGEMENT_MS : CYCLE_MS;
    const nextIn = Math.max(5_000, cadence - (Date.now() - startedAt));
    setTimeout(tick, nextIn);
  };
  setTimeout(tick, 0);
}

// ─── Main Trading Cycle ───

async function runCycle(acct, sharedQuotes, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  const mktOpen = acct.config.broker === "robinhood" ? isMarketOpenLocal() : isMarketOpen();
  log(acct, mktOpen ? "MARKET OPEN — Starting auto-trade cycle" : "MARKET CLOSED — Starting trade cycle (trade-when-closed)");
  dash.marketOpen = mktOpen;

  const quotes = {};
  const analyses = {};

  const activeTickers = getActiveTickers(acct);
  const positionTickers = state.positions.map(p => p.ticker).filter(t => !activeTickers.includes(t));
  const allTickers = [...activeTickers, ...positionTickers];

  // Use shared quotes (fetched once for all accounts)
  for (const ticker of allTickers) {
    if (sharedQuotes[ticker]) quotes[ticker] = sharedQuotes[ticker];
  }

  // Update candle cache latest values from quotes
  for (const ticker of allTickers) {
    if (acct.candleCache[ticker] && quotes[ticker]) {
      const q = quotes[ticker];
      const last = acct.candleCache[ticker][acct.candleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }

  await refreshWatchlist(acct);
  await checkHints(acct);
  await runNewsScan(acct, apiKey);

  const shortTermAnalyses = {};
  const decisions = [];
  for (const ticker of allTickers) {
    const candles = acct.candleCache[ticker];
    if (!candles) {
      markTickerDataFailure(acct, ticker);
      decisions.push({ ticker, action: "SKIP", reason: "No candle data" });
      continue;
    }
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) {
      markTickerDataFailure(acct, ticker);
      decisions.push({ ticker, action: "SKIP", reason: "Insufficient data (<55 candles)" });
      continue;
    }
    markTickerDataSuccess(acct, ticker);

    if (st) shortTermAnalyses[ticker] = st;

    const blended = blendScores(a, st);
    const effectiveScore = blended.score;

    const hintBias = getHintBias(acct, ticker);
    const rawScore = effectiveScore;
    let finalScore = effectiveScore;
    if (hintBias !== 0) {
      finalScore = Math.max(0, Math.min(100, effectiveScore + hintBias));
      a.hintBoosted = true;
    }
    a.score = finalScore;
    a.signal = signalLabel(finalScore);
    a.blendedRaw = effectiveScore;
    a.shortTermScore = st ? st.score : null;
    a.longTermScore = a.score !== finalScore ? rawScore : a.score;
    analyses[ticker] = a;

    const q = quotes[ticker];
    const price = q ? `$${q.c.toFixed(2)}` : "N/A";
    const hintTag = hintBias !== 0 ? ` [HINT ${hintBias > 0 ? "+" : ""}${hintBias}]` : "";
    const stTag = st ? ` (7d:${st.score} 90d:${a.blendedRaw !== undefined ? Math.round(a.bullScore * 0.5 + 50 - a.bearScore * 0.5) : '?'})` : "";
    log(acct, `${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag}${stTag} | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    const dec = { ticker, price: q?.c, rawScore, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);

    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = a ? Math.round(50 + (a.bullScore - a.bearScore) / 2) : null;
    dec.blendedScore = effectiveScore;

    if (finalScore >= cfg.bullEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else { dec.action = "BUY CALL"; dec.reason = `Bullish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else if (finalScore <= cfg.bearEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else { dec.action = "BUY PUT"; dec.reason = `Bearish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else {
      dec.action = "WAIT";
      if (finalScore >= 55) dec.reason = `Score ${finalScore} — leaning bullish but need >=${cfg.bullEntry} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else if (finalScore >= 45) dec.reason = `Score ${finalScore} — neutral (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
      else dec.reason = `Score ${finalScore} — leaning bearish but need <=${cfg.bearEntry} (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    }
    dec.ema8 = a.ema8v?.toFixed(2); dec.ema21 = a.ema21v?.toFixed(2); dec.ema50 = a.ema50v?.toFixed(2);
    dec.stEma3 = st?.ema3v?.toFixed(2); dec.stEma5 = st?.ema5v?.toFixed(2); dec.stEma8 = st?.ema8v?.toFixed(2);
    dec.rsi = a.rsi?.toFixed(1); dec.stRsi = st?.rsi?.toFixed(1);
    dec.atrPct = a.atrPct?.toFixed(2); dec.vr = a.vr?.toFixed(2);
    dec.mom1d = st?.mom1d?.toFixed(2); dec.mom3d = st?.mom3d?.toFixed(2); dec.mom7d = st?.mom7d?.toFixed(2);
    dec.signals = [...(a.sigs?.map(s => s.text) || []), ...(st?.sigs?.map(s => `[7d] ${s.text}`) || [])];
    decisions.push(dec);
  }
  dash.decisions = decisions;
  dash.shortTermAnalyses = shortTermAnalyses;



  // Broker accounts: mirror real balance + positions before any exit/entry decisions.
  if (cfg.broker === "tradier") await syncBrokerAccount(acct, quotes);
  if (acct._inflightExpiryReservations) {
    for (const ticker of acct._inflightExpiryReservations.keys()) {
      if (!acct._inflightTickers?.has(ticker)) acct._inflightExpiryReservations.delete(ticker);
    }
  }

  const regime = getMarketRegime(acct.candleCache);
  acct.currentRegime = regime;
  acct.riskPct = effectiveRiskPct(cfg.baseRiskPct, regime);
  log(acct, `REGIME: ${regime.label} | Allocation cap: ${(acct.riskPct * 100).toFixed(1)}% (${regime.riskScale}x base) | Planned loss cap: ${((cfg.riskPerTradePct || 0) * 100).toFixed(2)}% equity`);

  // Daily loss halt fires off open-position drawdown too — check before entries, after sync.
  evaluateRiskHalts(acct, portfolioValue(state, quotes));

  if (cfg.broker !== "robinhood") {
    await manageOpenPositions(acct, quotes, analyses, shortTermAnalyses);
  } else if (Date.now() - (acct._lastPositionManagerAt || 0) >= POSITION_MANAGER_STALE_MS) {
    // Failsafe only: the independent Robinhood loop normally owns held positions.
    log(acct, "POSITION MANAGER: fast loop stale — running entry-cycle fallback");
    await runRobinhoodPositionManagement(acct);
  }

  // Rank BUY candidates by score + aligned momentum so scarce slots/cash hit movers first
  // (Jul 13: KO score 75 / +0.9% day beat out FIG/CRM on watchlist order alone).
  const buyCandidates = rankEntryCandidates(decisions, shortTermAnalyses, quotes);
  for (const candidate of buyCandidates) candidate.dec.entryPriority = +candidate.priority.toFixed(2);

  if (buyCandidates.length > 1) {
    log(acct, `ENTRY RANK: ${buyCandidates.map(c => `${c.ticker} ${c.priority.toFixed(1)}`).join(" > ")}`);
  }

  // Resolve prior ranking cohorts against current underlying prices before recording this cycle.
  // These are explicitly signal returns, not option P&L; exact ask→future-bid tracking is separate.
  dash.decisionJournal = applyUnderlyingSnapshots(dash.decisionJournal || [], quotes, Date.now());

  const journalRow = {
    at: Date.now(),
    rankerVersion: "complete-trade-v1",
    ranked: buyCandidates.map(c => ({
      ticker: c.ticker,
      action: c.dec.action,
      score: c.dec.finalScore,
      initialPriority: +c.priority.toFixed(2),
      priority: null,
      mom1d: shortTermAnalyses[c.ticker]?.mom1d ?? null,
      entrySpot: quotes[c.ticker]?.c ?? null,
      eligibility: "pending",
      outcome: "pending",
      reason: null,
    })),
  };

  // Fully evaluate the strongest ticker-level setups first, then globally re-rank the executable
  // trade packages using setup quality, AI confidence, contract friction/liquidity/delta/DTE, and
  // aligned momentum. Preflight never places an order or changes cash/positions.
  const preflightLimit = cfg.entryPreflightLimit > 0
    ? Math.max(1, Math.floor(cfg.entryPreflightLimit))
    : buyCandidates.length;
  const prepared = [];
  for (let i = 0; i < buyCandidates.length; i++) {
    const candidate = buyCandidates[i];
    const { ticker, dec } = candidate;
    const jItem = journalRow.ranked.find(r => r.ticker === ticker);
    if (i >= preflightLimit) {
      if (jItem) {
        jItem.eligibility = "not-preflighted";
        jItem.outcome = "not-preflighted";
        jItem.reason = `Ticker preflight cap ${preflightLimit}`;
      }
      continue;
    }

    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;
    const result = await tryEntry(acct, ticker, a, q, regime, apiKey, { preflightOnly: true });
    if (result?.preflight) {
      prepared.push({ ticker, dec, preflight: result });
      if (jItem) {
        jItem.eligibility = "executable";
        jItem.outcome = "ready";
        jItem.setupQuality = result.setupQuality;
        jItem.claudeConfidence = result.claudeConfidence;
        jItem.contract = result.contract;
        jItem.plannedEntry = result.entryPremium;
      }
    } else if (result?.skipped) {
      log(acct, `PREFLIGHT BLOCK ${ticker}: ${result.reason}`);
      dec.action = "BLOCKED";
      dec.reason = result.reason;
      if (jItem) {
        jItem.eligibility = "invalid";
        jItem.outcome = "blocked";
        jItem.reason = result.reason;
      }
    } else if (jItem) {
      jItem.eligibility = "invalid";
      jItem.outcome = "no-package";
      jItem.reason = "Preflight produced no executable package";
    }
  }

  const refreshedPrepared = [];
  const rankSnapshotAt = Date.now();
  for (const item of prepared) {
    const pf = item.preflight;
    if (!pf.contract || rankSnapshotAt - pf.preparedAt <= 10_000) {
      refreshedPrepared.push(item);
      continue;
    }
    const occ = pf.contract.occSymbol
      || robinhood.buildOCC(item.ticker, pf.contract.expiryStr, pf.type, pf.contract.strike);
    const fresh = await fetchExactOptionQuote(occ);
    const jItem = journalRow.ranked.find(r => r.ticker === item.ticker);
    if (!fresh?.twoSided || fresh.tradeable === false) {
      if (jItem) { jItem.eligibility = "stale"; jItem.outcome = "blocked"; jItem.reason = "No fresh two-sided quote at global rank snapshot"; }
      continue;
    }
    const frictionPct = ((fresh.ask - fresh.bid) + (2 * FEE_PER_CONTRACT / 100)) / fresh.ask;
    const maxFrictionPct = Math.min(0.15, Math.max(0.06, 0.5 * (cfg.profitTarget || 0.12)));
    if (!Number.isFinite(frictionPct) || frictionPct > maxFrictionPct) {
      if (jItem) { jItem.eligibility = "stale"; jItem.outcome = "blocked"; jItem.reason = `Friction widened to ${(frictionPct * 100).toFixed(1)}%`; }
      continue;
    }
    const conviction = Math.max(0, Math.min(1, (pf.claudeConfidence || 0) / 100));
    const maxOverpayPct = Math.min(MAX_ENTRY_OVERPAY_PCT, Math.max(0.03, (cfg.profitTarget || 0.40) * 0.4));
    const limit = entryLimitPrice(fresh.bid, fresh.ask, fresh.mid, conviction, { maxOverpayPct });
    const qty = Math.min(pf.qty, Math.floor((pf.maxBudget || 0) / (limit * 100)));
    if (qty < 1) {
      if (jItem) { jItem.eligibility = "stale"; jItem.outcome = "blocked"; jItem.reason = "Fresh limit no longer affordable"; }
      continue;
    }
    const contract = {
      ...pf.contract,
      bid: fresh.bid,
      ask: fresh.ask,
      mid: fresh.mid,
      spread: +(fresh.ask - fresh.bid).toFixed(2),
      spreadPct: +(((fresh.ask - fresh.bid) / fresh.mid) * 100).toFixed(1),
      roundTripFrictionPct: +(frictionPct * 100).toFixed(1),
    };
    const nextPreflight = {
      ...pf,
      preparedAt: rankSnapshotAt,
      qty,
      entryPremium: limit,
      cost: +(qty * limit * 100).toFixed(2),
      contract,
    };
    if (jItem) { jItem.contract = contract; jItem.plannedEntry = limit; }
    refreshedPrepared.push({ ...item, preflight: nextPreflight });
  }

  const packageCandidates = rankPreparedEntries(refreshedPrepared, shortTermAnalyses, quotes);
  for (let i = 0; i < packageCandidates.length; i++) {
    const candidate = packageCandidates[i];
    candidate.dec.entryPriority = +candidate.packagePriority.toFixed(2);
    const jItem = journalRow.ranked.find(r => r.ticker === candidate.ticker);
    if (jItem) {
      jItem.rank = i + 1;
      jItem.priority = +candidate.packagePriority.toFixed(2);
      jItem.components = Object.fromEntries(Object.entries(candidate.components).map(([k, v]) => [k, +v.toFixed(1)]));
    }
  }
  if (packageCandidates.length > 1) {
    log(acct, `TRADE PACKAGE RANK: ${packageCandidates.map(c => `${c.ticker} ${c.packagePriority.toFixed(1)} [tech ${c.components.technical.toFixed(0)} setup ${c.components.setup.toFixed(0)} contract ${c.components.contract.toFixed(0)} mom ${c.components.momentum.toFixed(0)}]`).join(" > ")}`);
  }

  for (const { ticker, preflight: rankedPackage } of packageCandidates) {
    const dec = decisions.find(d => d.ticker === ticker);
    if (!dec) continue;

    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;

    const jItem = journalRow.ranked.find(r => r.ticker === ticker);
    const executeEntry = () => tryEntry(acct, ticker, a, q, regime, apiKey, { expectedPackage: rankedPackage });
    const result = cfg.broker === "robinhood"
      ? await withBrokerExecutionLane(acct, executeEntry)
      : await executeEntry();
    if (result && result.skipped) {
      log(acct, `SKIP ${ticker}: ${result.reason}`);
      if (dec && (dec.action === "BUY CALL" || dec.action === "BUY PUT")) {
        dec.action = "BLOCKED";
        dec.reason = result.reason;
      }
      if (jItem) { jItem.outcome = "execution-blocked"; jItem.reason = result.reason; }
    } else if (result && result.ticker) {
      if (jItem) {
        jItem.outcome = result.brokerOrder ? "ordered" : "entered";
        jItem.reason = `${result.type} $${result.strike} @ $${result.entryPremium.toFixed(2)}`;
      }
      // Count every new entry (paper position or broker order) against the day-trade cap.
      ensureRiskState(acct).dayTrades += 1;
      log(acct, `TRADE: BUY ${result.qty}x ${result.ticker} $${result.strike} ${result.type.toUpperCase()} ${result.dte}d @ $${result.entryPremium.toFixed(2)} ($${result.cost.toFixed(0)}) [setup:${result.setupQuality}/100 claude:${result.claudeConfidence}%]`);
      // Learning variants trade silently — no phone pushes, no tweets, just collected data.
      if (!acct.learning) {
        // Push notification — replicate this trade
        const entryA = analyses[ticker];
        const topSignals = entryA?.sigs?.slice(0, 2).map(s => s.text).join(" · ") || "";
        const tpPrice = (result.entryPremium * (1 + (acct.config.profitTarget || 0.40))).toFixed(2);
        const slPrice = (result.entryPremium * (1 + (acct.config.stopLoss || -0.35))).toFixed(2);
        sendPush(
          `🤖 ${result.ticker} ${result.type.toUpperCase()} $${result.strike} [${acct.name}]`,
          `Entry: $${result.entryPremium.toFixed(2)} · ${result.dte}d · ${result.qty}x\nTP: $${tpPrice} (+${((acct.config.profitTarget || 0.40) * 100).toFixed(0)}%) · SL: $${slPrice}\nScore: ${entryA?.score ?? '?'}/100 · Setup: ${result.setupQuality}/100\n${topSignals}`,
          true // urgent
        ).catch(() => {});
        // Tweet trade entry with chart
        const entrySt = shortTermAnalyses[ticker];
        const entryQ = quotes[ticker];
        tweetTradeEntry(acct, result, entryA, entrySt, entryQ).catch(e => console.log(`  [X] Entry tweet error: ${e.message}`));
      }

      // Robinhood broker accounts already executed natively via placeBrokerEntry above.
      // No separate execution block needed — broker is per-account, same as Tradier.
    } else if (jItem) {
      jItem.outcome = "no-fill";
    }
  }

  if (!dash.decisionJournal) dash.decisionJournal = [];
  if (shouldRecordSelectionCohort(dash.decisionJournal, journalRow)) {
    dash.decisionJournal.push(journalRow);
    if (dash.decisionJournal.length > 500) dash.decisionJournal.splice(0, dash.decisionJournal.length - 500);
  }
  dash.rankTelemetry = summarizeRankOne(dash.decisionJournal, "h1");

  dash.positionDetails = buildPositionDetails(acct, quotes);

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  const progress = ((pv / cfg.goal) * 100).toFixed(1);
  const pace = march1mPace(acct, pv);
  if (pace) {
    log(acct, `MARCH $1M: $${pv.toFixed(0)} → $1M by ${pace.deadline} | ${pace.daysLeft} sessions left | need ~${pace.needDailyPct.toFixed(1)}%/day | this week target ~$${pace.weekTarget.toFixed(0)} (${pace.sessionsLeftThisWeek} sessions)`);
  }
  log(acct, `Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Goal: ${progress}% of $${cfg.goal.toLocaleString()} | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | ${regime.mode.toUpperCase()}${getActiveHintsSummary(acct)}`);

  // Tweet daily watchlist summary (once per day) — never from learning variants
  if (!acct.learning) tweetWatchlistSummary(acct, decisions, regime).catch(e => console.log(`  [X] Watchlist tweet error: ${e.message}`));

  dash.quotes = quotes;
  dash.analyses = analyses;
  dash.shortTermAnalyses = shortTermAnalyses;
  dash.candles = acct.candleCache;
  dash.lastCycle = Date.now();

  dash.portfolioHistory = dash.portfolioHistory || [];
  appendPortfolioPoint(dash.portfolioHistory, Date.now(), pv);

  saveAccounts();
}

// ─── Paused Cycle (exits only — no LLM calls, no new entries) ───

async function runPausedCycle(acct, sharedQuotes) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  dash.marketOpen = acct.config.broker === "robinhood" ? isMarketOpenLocal() : isMarketOpen();

  // Keep dashboard quotes alive so PV and UI don't freeze while paused
  for (const ticker of Object.keys(sharedQuotes)) {
    if (sharedQuotes[ticker]) dash.quotes[ticker] = sharedQuotes[ticker];
  }

  if (state.positions.length === 0) return;

  const positionTickers = state.positions.map(p => p.ticker);
  const quotes = {};
  for (const ticker of positionTickers) {
    if (sharedQuotes[ticker]) quotes[ticker] = sharedQuotes[ticker];
  }

  // Update candle cache latest values from quotes
  for (const ticker of positionTickers) {
    if (acct.candleCache[ticker] && quotes[ticker]) {
      const q = quotes[ticker];
      const last = acct.candleCache[ticker][acct.candleCache[ticker].length - 1];
      if (last) {
        last.c = q.c;
        last.h = Math.max(last.h, q.h);
        last.l = Math.min(last.l, q.l);
      }
    }
  }



  // Build minimal analyses for signal-based / soft-EOD exits
  const analyses = {};
  const shortTermAnalyses = {};
  for (const ticker of positionTickers) {
    const candles = acct.candleCache[ticker];
    if (candles) {
      const a = runAnalysis(candles);
      if (a) analyses[ticker] = a;
      const st = runShortTermAnalysis(candles);
      if (st) shortTermAnalyses[ticker] = st;
    }
  }

  // Broker accounts: keep mirroring the real account so exits price off fresh marks/bids even while
  // paused (a hard risk-halt pauses entries but must not abandon open positions).
  if (cfg.broker === "tradier") await syncBrokerAccount(acct, quotes);

  // Every pause is entry-only. Risk controls and the manual kill switch must never abandon an
  // already-open position; protective exits continue on their normal broker lane.
  const manualPause = acct.pausedBy === "user";
  if (cfg.broker !== "robinhood") {
    await manageOpenPositions(acct, quotes, analyses, shortTermAnalyses);
  } else if (Date.now() - (acct._lastPositionManagerAt || 0) >= POSITION_MANAGER_STALE_MS) {
    log(acct, "POSITION MANAGER: fast loop stale during pause — running protective fallback");
    await runRobinhoodPositionManagement(acct);
  }

  dash.positionDetails = buildPositionDetails(acct, quotes);
  dash.lastCycle = Date.now();

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  log(acct, `[PAUSED${manualPause ? " — MANUAL" : " — RISK HALT"}] Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | exits active, no new entries`);

  dash.portfolioHistory = dash.portfolioHistory || [];
  appendPortfolioPoint(dash.portfolioHistory, Date.now(), pv);

  saveAccounts(); // persist PV chart points even while paused (survives redeploys)
}

function buildPositionDetails(acct, quotes) {
  const state = acct.state;
  const cfg = acct.config;
  return state.positions.map(pos => {
    const q = quotes[pos.ticker];
    const spot = (q && q.c != null) ? q.c : (pos.entrySpot ?? null);
    const now = Date.now();
    const dteLeft = pos.expiryDate
      ? Math.max(0, (pos.expiryDate - now) / 86400_000)
      : (pos.dte != null && pos.openTime
        ? Math.max(0, pos.dte - (now - pos.openTime) / 86400_000)
        : (pos.dteRemaining ?? null));

    // Pending (unfilled) broker orders: show flat, tagged as a working order — no P&L/greeks math.
    if (pos._pending) {
      return {
        ...pos, spot, dteLeft, curPremium: pos.entryPremium, pnlPct: 0, pnlDollar: 0,
        profitTarget: { pct: "—", premium: "—" },
        stopLoss: { pct: "—", premium: "—" },
        pctToProfit: "0.0", pctToStop: "0.0",

        greeks: { delta: "—", theta: "—" },
      };
    }

    const isEq = pos.type === "equity";
    // When strike is unknown (0) for an options position, synthetic pricing is wildly wrong
    // (optPrice treats it as a deeply ITM call, returning ~stock price). Fall back to entryPremium
    // so P&L shows 0% rather than an absurd number until the strike is resolved.
    const strikeKnown = isEq || pos.strike > 0;
    const canModel = strikeKnown && spot != null && dteLeft != null && (pos.type === "call" || pos.type === "put");
    const curPremium = isEq ? (pos.liveMark ?? spot)
      : (pos.liveMark ?? (canModel ? optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type) : pos.entryPremium));
    const pnlPct = pos.entryPremium > 0 && curPremium != null ? (curPremium - pos.entryPremium) / pos.entryPremium : 0;
    const pnlDollar = (curPremium != null && pos.entryPremium > 0)
      ? (curPremium - pos.entryPremium) * pos.qty * (isEq ? 1 : 100) : 0;
    const plan = managementPlanFor(pos, cfg, now);
    const profitPrice = pos.entryPremium * (1 + plan.profitTarget);
    // Options use the frozen premium stop plus structural invalidation. Live premium stops need
    // repeated exact-contract bids from a coherent book, so the displayed line is the real risk
    // limit while execution remains protected from one-off bad prints.
    const stopMult = plan.stopLoss;
    const stopLossPrice = pos.entryPremium * (1 + stopMult);

    let effectiveStop;
    if ((pos.trimLevel || 0) >= 2) effectiveStop = pos.entryPremium * 1.15;
    else if ((pos.trimLevel || 0) >= 1) effectiveStop = pos.entryPremium;
    else effectiveStop = stopLossPrice;

    return {
      ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
      profitTarget: { pct: `+${(plan.profitTarget * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
      stopLoss: { pct: `${(stopMult * 100).toFixed(0)}%${isEq ? "" : " (confirmed exact bids)"}`, premium: effectiveStop.toFixed(2) },
      pctToProfit: curPremium > 0 ? ((profitPrice - curPremium) / curPremium * 100).toFixed(1) : "—",
      pctToStop: curPremium > 0 ? ((effectiveStop - curPremium) / curPremium * 100).toFixed(1) : "—",
      greeks: pos.liveGreeks
        ? { delta: (pos.liveGreeks.delta ?? 0).toFixed(3), theta: (pos.liveGreeks.theta ?? 0).toFixed(3) }
        : (canModel ? optGreeks(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type) : { delta: "?", theta: "?" }),
    };
  });
}

// ─── Historical Trading Simulator ───

function emitSSE(sim, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sim.clients) {
    try { res.write(msg); } catch { }
  }
}

async function startSimulation(config) {
  const simId = ++simIdCounter;
  const {
    startDate, endDate, startingCash = 200, baseRiskPct = 0.15,
    profitTarget = 0.40, stopLoss = -0.35, bullEntry = 65, bearEntry = 35,
    minSetupQuality = 50, maxPositions = 5, useClaude = false, speedMs = 3000,
    tickers = ["SPY","QQQ","AAPL","NVDA","TSLA","MSFT","META","AMZN","GOOGL","AMD"],
  } = config;

  const sim = {
    id: simId, status: "loading", config, clients: [],
    portfolioHistory: [], tradeHistory: [], log: [],
    startDate, endDate, tickers, speedMs, useClaude,
  };
  simulations.set(simId, sim);
  emitSSE(sim, { type: "status", status: "loading", message: "Fetching historical data..." });

  // Fetch candles with 90-day warmup
  const startUnix = Math.floor(new Date(startDate).getTime() / 1000);
  const endUnix = Math.floor(new Date(endDate).getTime() / 1000);
  const warmupUnix = startUnix - 90 * 86400;

  const allCandles = {};
  for (const ticker of tickers) {
    try {
      const candles = await fetchHistoricalCandles(ticker, warmupUnix, endUnix);
      if (candles && candles.length > 0) allCandles[ticker] = candles;
      await delay(300);
    } catch (e) {
      sim.log.push(`Failed to fetch ${ticker}: ${e.message}`);
    }
  }

  if (Object.keys(allCandles).length === 0) {
    sim.status = "error";
    emitSSE(sim, { type: "error", message: "No candle data fetched" });
    return sim;
  }

  // Build sorted trading days from startDate to endDate
  const allDatesSet = new Set();
  for (const candles of Object.values(allCandles)) {
    for (const c of candles) {
      if (c.t >= startUnix && c.t <= endUnix) allDatesSet.add(c.t);
    }
  }
  const allDates = [...allDatesSet].sort((a, b) => a - b);

  if (allDates.length === 0) {
    sim.status = "error";
    emitSSE(sim, { type: "error", message: "No trading days in date range" });
    return sim;
  }

  // Create virtual account
  const acctConfig = {
    startingCash, goal: 1_000_000, baseRiskPct, profitTarget, stopLoss,
    bullEntry, bearEntry, trim1Pct: 0.25, trim2Pct: 0.50, minSetupQuality, maxPositions,
  };
  const acct = createAccountRuntime(`sim-${simId}`, `Sim #${simId}`, acctConfig);
  acct._simMode = true;
  acct.riskPct = baseRiskPct * 0.5; // default cautious risk
  sim.acct = acct;
  sim.allCandles = allCandles;
  sim.allDates = allDates;
  sim.currentDayIndex = 0;
  sim.totalDays = allDates.length;
  sim.status = "running";

  emitSSE(sim, { type: "status", status: "running", totalDays: allDates.length, message: "Simulation started" });

  // Start tick loop (sequential to prevent race conditions)
  sim._tickRunning = false;
  sim.interval = setInterval(() => {
    if (sim._tickRunning) return; // skip if previous tick still running
    sim._tickRunning = true;
    simTick(sim).finally(() => { sim._tickRunning = false; });
  }, sim.speedMs);
  return sim;
}

async function simTick(sim) {
  if (sim.status !== "running") return;
  const { acct, allCandles, allDates, currentDayIndex, tickers, useClaude } = sim;

  if (currentDayIndex >= allDates.length) {
    sim.status = "done";
    clearInterval(sim.interval);
    emitSSE(sim, buildSimDoneEvent(sim));
    return;
  }

  const currentTs = allDates[currentDayIndex];
  const dateStr = new Date(currentTs * 1000).toISOString().slice(0, 10);
  acct._simDateStr = dateStr;
  acct._simNow = currentTs * 1000;

  // Build candle cache and quotes for current date
  const quotes = {};
  for (const ticker of tickers) {
    const fullCandles = allCandles[ticker];
    if (!fullCandles) continue;
    const sliced = fullCandles.filter(c => c.t <= currentTs);
    if (sliced.length === 0) continue;
    acct.candleCache[ticker] = sliced;
    const latest = sliced[sliced.length - 1];
    const previousClose = sliced.length > 1 ? sliced[sliced.length - 2].c : latest.o;
    const dayChange = latest.c - previousClose;
    quotes[ticker] = {
      c: latest.c, h: latest.h, l: latest.l, o: latest.o, pc: previousClose,
      d: dayChange,
      dp: previousClose > 0 ? (dayChange / previousClose) * 100 : 0,
    };
  }

  // Run analyses
  const analyses = {};
  const shortTermAnalyses = {};
  for (const ticker of tickers) {
    const candles = acct.candleCache[ticker];
    if (!candles || candles.length < 55) continue;
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) continue;
    if (st) shortTermAnalyses[ticker] = st;
    const blended = blendScores(a, st);
    a.score = blended.score;
    a.signal = signalLabel(blended.score);
    analyses[ticker] = a;
  }
  acct.dashboard.shortTermAnalyses = shortTermAnalyses;
  acct.dashboard.quotes = quotes;

  // Market regime
  const regime = getMarketRegime(acct.candleCache);
  acct.currentRegime = regime;
  acct.riskPct = effectiveRiskPct(acct.config.baseRiskPct, regime);

  // Run exits
  await manageOpenPositions(acct, quotes, analyses, acct.dashboard?.shortTermAnalyses || null);

  // Run entries
  const simDecisions = tickers
    .filter(ticker => analyses[ticker] && quotes[ticker])
    .map(ticker => ({
      ticker,
      finalScore: analyses[ticker].score,
      action: analyses[ticker].score >= acct.config.bullEntry
        ? "BUY CALL"
        : analyses[ticker].score <= acct.config.bearEntry ? "BUY PUT" : "WAIT",
    }));
  const rankedSimEntries = rankEntryCandidates(simDecisions, shortTermAnalyses, quotes);
  for (const { ticker } of rankedSimEntries) {
    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;
    try {
      const result = await tryEntryForSim(acct, ticker, a, q, regime, useClaude);
      if (result && result.ticker) {
        const entry = { type: "entry", date: dateStr, ticker: result.ticker, direction: result.type, strike: result.strike, qty: result.qty, premium: result.entryPremium, cost: result.cost };
        sim.tradeHistory.push(entry);
        emitSSE(sim, { type: "trade", action: "BUY", date: dateStr, ticker: result.ticker, direction: result.type, strike: result.strike, qty: result.qty, reason: `Score ${a.score} — ${a.signal}` });
      } else if (result && result.skipped) {
        sim.log.push(`${dateStr} SKIP ${ticker}: ${result.reason}`);
      }
    } catch { }
  }

  // Record closed trades and emit SSE events
  const prevHistLen = sim._prevHistLen || 0;
  if (acct.state.history.length > prevHistLen) {
    for (let i = prevHistLen; i < acct.state.history.length; i++) {
      const h = acct.state.history[i];
      const exit = { type: "exit", date: dateStr, ticker: h.ticker, direction: h.type, strike: h.strike, qty: h.qty, pnlDollar: h.pnlDollar, pnlPct: h.pnlPct, reason: h.reason };
      sim.tradeHistory.push(exit);
      emitSSE(sim, { type: "trade", action: "CLOSE", date: dateStr, ticker: h.ticker, direction: h.type, strike: h.strike, qty: h.qty, pnlDollar: h.pnlDollar, pnlPct: h.pnlPct, reason: h.reason });
    }
  }
  sim._prevHistLen = acct.state.history.length;

  // Portfolio value
  const pv = portfolioValue(acct.state, quotes);
  sim.portfolioHistory.push({ ts: currentTs * 1000, date: dateStr, value: pv, cash: acct.state.cash, positions: acct.state.positions.length });

  // Emit tick
  emitSSE(sim, {
    type: "tick",
    day: currentDayIndex + 1,
    totalDays: allDates.length,
    date: dateStr,
    pv: +pv.toFixed(2),
    cash: +acct.state.cash.toFixed(2),
    positions: acct.state.positions.length,
    regime: regime.mode,
    totalTrades: sim.tradeHistory.filter(t => t.type === "entry").length,
    openPositions: acct.state.positions.map(p => ({ ticker: p.ticker, type: p.type, strike: p.strike, qty: p.qty, pnlPct: quotes[p.ticker] ? +((optPrice(quotes[p.ticker].c, p.strike, p.dteRemaining, p.iv || DEFAULT_IV, p.type) - p.entryPremium) / p.entryPremium).toFixed(3) : 0 })),
  });

  sim.currentDayIndex++;
}

function buildSimDoneEvent(sim) {
  const hist = sim.portfolioHistory;
  const startVal = sim.config.startingCash || 200;
  const endVal = hist.length > 0 ? hist[hist.length - 1].value : startVal;
  const totalReturn = ((endVal - startVal) / startVal * 100).toFixed(2);

  // Win rate
  const exits = sim.tradeHistory.filter(t => t.type === "exit");
  const wins = exits.filter(t => t.pnlDollar > 0).length;
  const winRate = exits.length > 0 ? (wins / exits.length * 100).toFixed(1) : "0";

  // Max drawdown
  let peak = startVal, maxDD = 0;
  for (const h of hist) {
    if (h.value > peak) peak = h.value;
    const dd = (peak - h.value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Avg win / avg loss
  const winAmts = exits.filter(t => t.pnlDollar > 0).map(t => t.pnlPct * 100);
  const lossAmts = exits.filter(t => t.pnlDollar <= 0).map(t => t.pnlPct * 100);
  const avgWin = winAmts.length > 0 ? (winAmts.reduce((a, b) => a + b, 0) / winAmts.length).toFixed(1) : "0";
  const avgLoss = lossAmts.length > 0 ? (lossAmts.reduce((a, b) => a + b, 0) / lossAmts.length).toFixed(1) : "0";

  // Simple Sharpe (daily returns)
  const dailyReturns = [];
  for (let i = 1; i < hist.length; i++) {
    dailyReturns.push((hist[i].value - hist[i - 1].value) / hist[i - 1].value);
  }
  const avgR = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdR = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgR) ** 2, 0) / (dailyReturns.length - 1)) : 1;
  const sharpe = stdR > 0 ? (avgR / stdR * Math.sqrt(252)).toFixed(2) : "0";

  return {
    type: "done", totalReturn, winRate, maxDrawdown: (maxDD * 100).toFixed(2),
    sharpe, avgWin, avgLoss, totalTrades: sim.tradeHistory.filter(t => t.type === "entry").length,
    finalValue: +endVal.toFixed(2), startValue: startVal,
  };
}

// ─── After-Hours Scan (analysis only, no trades) ───

async function runAfterHoursScan(acct, sharedQuotes, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  dash.marketOpen = false; // By definition, after-hours scan means the market is closed.
  log(acct, "AFTER-HOURS SCAN — Fetching data for analysis (no trades)");

  for (const ticker of Object.keys(sharedQuotes)) {
    if (sharedQuotes[ticker]) dash.quotes[ticker] = sharedQuotes[ticker];
  }

  const quotes = {};
  const analyses = {};
  const shortTermAnalyses = {};

  const activeTickers2 = getActiveTickers(acct);
  const positionTickers2 = state.positions.map(p => p.ticker).filter(t => !activeTickers2.includes(t));
  const allTickers2 = [...activeTickers2, ...positionTickers2];

  // Use shared quotes
  for (const ticker of allTickers2) {
    if (sharedQuotes[ticker]) quotes[ticker] = sharedQuotes[ticker];
  }

  await refreshWatchlist(acct);
  await checkHints(acct);
  await runNewsScan(acct, apiKey);

  const decisions = [];
  for (const ticker of allTickers2) {
    const candles = acct.candleCache[ticker];
    if (!candles) {
      markTickerDataFailure(acct, ticker);
      decisions.push({ ticker, action: "SKIP", reason: "No candle data" });
      continue;
    }
    const a = runAnalysis(candles);
    const st = runShortTermAnalysis(candles);
    if (!a) {
      markTickerDataFailure(acct, ticker);
      decisions.push({ ticker, action: "SKIP", reason: "Insufficient data" });
      continue;
    }
    markTickerDataSuccess(acct, ticker);

    if (st) shortTermAnalyses[ticker] = st;

    const blended = blendScores(a, st);
    const hintBias = getHintBias(acct, ticker);
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
    log(acct, `${ticker} ${price} | Blended: ${finalScore} ${a.signal}${hintTag} (7d:${st?.score ?? '?'}) | ${a.sigs.map(s => s.text).join(", ") || "No signals"}`);

    const dec = { ticker, price: q?.c, rawScore: blended.score, finalScore, signal: a.signal, hintBias };
    const alreadyHeld = state.positions.some(p => p.ticker === ticker);
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = Math.round(50 + (a.bullScore - a.bearScore) / 2);
    dec.blendedScore = blended.score;
    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;

    if (finalScore >= cfg.bullEntry) {
      dec.action = alreadyHeld ? "HOLD" : "PLAN BUY CALL";
      dec.reason = alreadyHeld ? "Already in position" : `Bullish ${finalScore}/100 — will buy at open (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`;
    } else if (finalScore <= cfg.bearEntry) {
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

  dash.positionDetails = buildPositionDetails(acct, quotes);
  dash.quotes = quotes;
  dash.analyses = analyses;
  dash.shortTermAnalyses = shortTermAnalyses;
  dash.candles = acct.candleCache;
  dash.decisions = decisions;
  dash.lastCycle = Date.now();

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  log(acct, `AFTER-HOURS — Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open${getActiveHintsSummary(acct)}`);
}

// ─── Main Loop ───

async function main() {
  console.log("\n  ╔═══════════════════════════════════════════════╗");
  console.log("  ║  Swing Trader — Auto-Trading Bot v1.0         ║");
  console.log("  ║  Multi-Account · Dynamic Watchlist             ║");
  console.log("  ║  Headless · Finnhub · Aggressive Mode          ║");
  console.log("  ╚═══════════════════════════════════════════════╝\n");

  // Force reset: wipe accounts file so loadAccounts creates fresh default
  if (process.env.FORCE_RESET_STATE === "true") {
    try { fs.unlinkSync(ACCOUNTS_FILE); } catch { }
    try { fs.unlinkSync(STATE_FILE); } catch { }
    console.log("  FORCE RESET: Wiped state files. Starting fresh.\n");
  }

  // Load accounts (migrates from legacy state.json if needed)
  loadAccounts();

  // Load saved push subscriptions
  loadPushSubs();

  // Get API key from env or first account's state, or prompt
  let apiKey = process.env.FINNHUB_API_KEY || "";
  if (!apiKey) {
    // Check if any account has a stored key
    for (const [, acct] of accounts) {
      if (acct.state.apiKey) { apiKey = acct.state.apiKey; break; }
    }
  }
  if (!apiKey) {
    console.log("  No API key found. Get a free key at https://finnhub.io/\n");
    const key = await prompt("  Enter Finnhub API key: ");
    if (!key) { console.log("  No key provided. Exiting."); process.exit(1); }
    console.log("  Validating API key...");
    const valid = await validateKey(key);
    if (!valid) { console.log("  Invalid API key. Exiting."); process.exit(1); }
    apiKey = key;
  } else {
    console.log("  Validating API key...");
    const valid = await validateKey(apiKey);
    if (!valid) { console.log("  Stored API key is invalid. Exiting."); process.exit(1); }
    console.log("  API key valid.\n");
  }

  // Log LLM provider status
  console.log(`  LLM Provider: ${getLLMLabel()} (LLM_PROVIDER=${LLM_PROVIDER})`);
  if (LLM_PROVIDER === "gemini") {
    if (GEMINI_API_KEY) {
      console.log(`  Gemini API key: ${GEMINI_API_KEY.slice(0, 12)}...${GEMINI_API_KEY.slice(-4)} (${GEMINI_API_KEY.length} chars)`);
    } else {
      console.log("  WARNING: No GEMINI_API_KEY set — news scans and entry validation will fail");
    }
  } else {
    if (CLAUDE_API_KEY) {
      console.log(`  Claude API key: ${CLAUDE_API_KEY.slice(0, 12)}...${CLAUDE_API_KEY.slice(-4)} (${CLAUDE_API_KEY.length} chars)`);
    } else {
      console.log("  WARNING: No CLAUDE_API_KEY set — news scans and entry validation will fail");
    }
  }

  // Initialize X/Twitter client
  xClient = initTwitterClient();
  if (ENABLE_TWEETS && xClient) {
    console.log(`  X/Twitter: LIVE mode — tweets enabled (cap: ${X_DAILY_CAP}/day)`);
  } else if (!ENABLE_TWEETS) {
    console.log("  X/Twitter: DRY-RUN mode — set ENABLE_TWEETS=true to post live");
  }

  // Initialize Robinhood Agentic Trading (per-account broker, same as Tradier)
  const rhOk = await robinhood.init();
  if (rhOk) {
    const optLabel = robinhood.optionsEnabled ? "equity + options" : "equity only";
    console.log(`  Robinhood: CONNECTED ✓ (agentic account: ${robinhood.accountNumber}, ${optLabel})`);
  } else {
    console.log("  Robinhood: MCP not connected — live account entries will be paused until broker recovery");
  }
  // Always provision the account so it appears in the dashboard
  await ensureRobinhoodAccount();
  await ensureRobinhoodConnectionHealth();
  if (rhOk) {
    await ensureRhWatchlist();
    const modeLabel = rhTradeMode({ broker: "robinhood" });
    console.log(`  Robinhood: LIVE broker account ready (max: $${RH_MAX_POSITION_DOLLARS}/position, mode: ${modeLabel}${RH_AUTO_WATCHLIST ? `, auto-watchlist → "${RH_WATCHLIST_NAME}"` : ""})`);
  }

  // Initialize Tradier data + execution arm (primary market-data feed when connected)
  if (process.env.TRADIER_ACCESS_TOKEN || fs.existsSync("tradier_tokens.json")) {
    const trOk = await tradier.init();
    if (trOk) {
      console.log(`  Tradier: DATA FEED ACTIVE ✓ (${tradier.environment}) — quotes, candles & option chains routed through Tradier`);
      await ensureTradierAccount();
    } else {
      console.log("  Tradier: NOT CONNECTED — falling back to Finnhub/Yahoo for market data");
    }
  } else {
    console.log("  Tradier: not configured — set TRADIER_ACCESS_TOKEN to use real-time data. Using Finnhub/Yahoo.");
  }

  // Store apiKey in each account state for backwards compat
  for (const [, acct] of accounts) acct.state.apiKey = apiKey;

  // Log account info
  for (const [id, acct] of accounts) {
    console.log(`  [${id}] ${acct.name} — Cash: $${acct.state.cash.toFixed(0)} | ${acct.state.positions.length} positions | ${acct.state.history.length} trades`);
  }
  console.log("");

  // Get primary account for dashboard (first account)
  const primaryAcct = accounts.values().next().value;

  // Update initial market status for all accounts so dashboard is accurate on load
  await refreshMarketClock(true);
  const initialMarketOpen = isMarketOpen();
  for (const [, acct] of accounts) {
    if (acct.dashboard) {
      acct.dashboard.marketOpen = acct.config.broker === "robinhood" ? isMarketOpenLocal() : initialMarketOpen;
    }
  }

  // Start web dashboard  
  startDashboard(primaryAcct, apiKey);

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      console.log(`\n  Received ${sig} — saving all accounts and exiting...`);
      saveAccounts();
      process.exit(0);
    });
  }

  let sharedCandleCache = {};
  let lastCandleDate = null;
  let lastCycleTime = Date.now();

  // Run initial scan immediately on startup
  console.log("  Running startup scan...\n");
  try {
    const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
    // Copy shared candles into each account's cache
    for (const [, acct] of accounts) {
      Object.assign(acct.candleCache, sharedCandleCache);
    }
    // Auto-reconnect Robinhood if token exists but session dropped
    if (robinhood.isAuthenticated && !robinhood.isConnected) {
      console.log("  [RH] Token present but MCP disconnected — attempting reconnect...");
      try { await robinhood.init(); } catch (e) { console.log(`  [RH] Reconnect failed: ${e.message}`); }
      if (robinhood.isConnected) {
        console.log(`  [RH] Reconnected ✓${robinhood.optionsEnabled ? " (options enabled)" : ""}`);
        await ensureRobinhoodAccount();
      }
    }
    // Force broker sync immediately so positions are never stale after a deploy
    for (const [, acct] of accounts) {
      if (acct.config.broker === "tradier") await syncBrokerAccount(acct, sharedQuotes);
      if (acct.config.broker === "robinhood") {
        await withBrokerExecutionLane(acct, () => syncRobinhoodAccount(acct, sharedQuotes));
      }
    }
    for (const [, acct] of accounts) {
      if (!acct.paused) await runAfterHoursScan(acct, sharedQuotes, apiKey);
    }
  } catch (e) {
    console.log(`  WARN: Startup scan failed — ${e.message}`);
  }

  // Held-position monitoring has its own cadence; entry discovery remains on the main loop below.
  startRobinhoodPositionManager();

  // Main loop
  while (true) {
    const gap = Date.now() - lastCycleTime;
    if (gap > 5 * 60_000) {
      console.log(`  WAKE DETECTED — ${(gap / 60_000).toFixed(0)}m gap. Re-syncing...`);
      sharedCandleCache = {};
      for (const [, acct] of accounts) acct.candleCache = {};
    }
    lastCycleTime = Date.now();

    // Pull the authoritative exchange state from Tradier (cached 30s) before deciding what to run.
    await refreshMarketClock();
    // marketOpen uses Tradier clock (authoritative for Tradier-brokered accounts).
    // marketOpenLocal uses only ET time — never touches Tradier — and is the sole signal for
    // Robinhood accounts so that a Tradier API outage or stale state never blocks RH exits.
    const marketOpen = isMarketOpen();
    const marketOpenLocal = isMarketOpenLocal();
    // Accounts may opt into trading while closed (e.g. broker sandbox testing). If any non-paused
    // account does, we run the fast cycle so its full runCycle (entries+exits) executes now.
    const forcedAccts = [...accounts.values()].filter(a => !a.paused && a.config.tradeWhenClosed);
    const rhAccts = [...accounts.values()].filter(a => !a.paused && a.config.broker === "robinhood");
    const activeCycle = marketOpen || forcedAccts.length > 0 || (rhAccts.length > 0 && marketOpenLocal);

    if (activeCycle) {
      const today = getETDateStr();
      if ((marketOpen || marketOpenLocal) && lastCandleDate !== today) {
        sharedCandleCache = {};
        for (const [, acct] of accounts) acct.candleCache = {};
        lastCandleDate = today;
      }

      try {
        const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
        // Sync shared candles into each account's cache
        for (const [, acct] of accounts) {
          for (const [ticker, candles] of Object.entries(sharedCandleCache)) {
            if (!acct.candleCache[ticker]) acct.candleCache[ticker] = candles;
          }
        }

        for (const [, acct] of accounts) {
          try {
            if (acct.config.broker === "robinhood") {
              await withBrokerExecutionLane(acct, () => syncRobinhoodAccount(acct, sharedQuotes))
                .catch(e => log(acct, `ROBINHOOD SYNC: ${e.message}`));
            }
            // Learning lab: keep shadow variants alive for live RH accounts (idempotent) so they
            // collect strategy data every cycle — including while the parent is paused/settling.
            if (acct.config.broker === "robinhood" && !acct.learning && acct.config.learningEnabled !== false) ensureLearningAccounts(acct);
            // Robinhood uses local ET time only — Tradier clock is irrelevant for RH.
            const acctMarketOpen = acct.config.broker === "robinhood" ? marketOpenLocal : marketOpen;
            const tradeThis = acctMarketOpen || acct.config.tradeWhenClosed;
            if (acct.paused) {
              await runPausedCycle(acct, sharedQuotes);
            } else if (tradeThis) {
              if (!acctMarketOpen) log(acct, "TRADE-WHEN-CLOSED — running full cycle while market is closed (test mode)");
              await runCycle(acct, sharedQuotes, apiKey);
            } else {
              await runAfterHoursScan(acct, sharedQuotes, apiKey);
            }
          } catch (e) {
            log(acct, `ERROR in cycle: ${e.message}`);
            diag("error", acct, { where: "runCycle", message: e.message, stack: (e.stack || "").split("\n").slice(0, 3).join(" | ") });
          }
        }
      } catch (e) {
        console.log(`  ERROR in shared fetch: ${e.message}`);
      }

      saveAccounts();
      console.log("");
      await delay((marketOpen || marketOpenLocal) ? CYCLE_MS : CYCLE_MS_CLOSED);
    } else {
      // After hours (both Tradier clock and local ET time say market is closed)
      try {
        const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
        for (const [, acct] of accounts) {
          for (const [ticker, candles] of Object.entries(sharedCandleCache)) {
            if (!acct.candleCache[ticker]) acct.candleCache[ticker] = candles;
          }
        }

        for (const [, acct] of accounts) {
          if (acct.config.broker === "robinhood") {
            await withBrokerExecutionLane(acct, () => syncRobinhoodAccount(acct, sharedQuotes))
              .catch(e => log(acct, `ROBINHOOD SYNC: ${e.message}`));
          }
          if (!acct.paused) await runAfterHoursScan(acct, sharedQuotes, apiKey);
          // paused accounts: candles already synced above, no further action needed after hours
        }
      } catch (e) {
        console.log(`  WARN: After-hours scan failed — ${e.message}`);
      }

      saveAccounts();
      // Poll for the open rather than blindly sleeping 15 minutes. Normally check every 30s, but in
      // the final approach to 9:30 ET poll every 5s (and force-refresh the broker clock) so we flip
      // to trading within seconds of the bell — not 5-15 minutes late. Hard cap the wait at 15 min.
      const sleepStart = Date.now();
      while (Date.now() - sleepStart < 15 * 60_000) {
        await refreshMarketClock(true);
        if (isMarketOpen() || isMarketOpenLocal()) {
          console.log("  [WAKE] Market open detected — starting trading cycle now");
          break;
        }
        let nearOpen = false;
        try {
          const { day, h, m } = getETParts();
          const mins = h * 60 + m;
          nearOpen = day !== "Sat" && day !== "Sun" && mins >= 568 && mins < 571; // 9:28–9:31 ET
        } catch { }
        await delay(nearOpen ? 5_000 : 30_000);
      }
    }
  }
}


// ─── Start ───
main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
