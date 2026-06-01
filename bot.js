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
  // Semiconductors (AI + general)
  NVDA: "SEMI", AMD: "SEMI", MU: "SEMI", INTC: "SEMI", AMKR: "SEMI", AVGO: "SEMI",
  TSM: "SEMI", QCOM: "SEMI", NXPI: "SEMI", MXL: "SEMI", AXTI: "SEMI", NVTS: "SEMI",
  ARM: "SEMI", MRVL: "SEMI", LSCC: "SEMI", ON: "SEMI", SWKS: "SEMI", QRVO: "SEMI",
  ASML: "SEMI", AMAT: "SEMI", LRCX: "SEMI", KLAC: "SEMI", ADI: "SEMI", TXN: "SEMI",
  MCHP: "SEMI", SMCI: "SEMI", ALAB: "SEMI", CRDO: "SEMI",
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
  O: "REIT", AMT: "REIT", PLD: "REIT", EQIX: "REIT", SPG: "REIT",
  PSA: "REIT", CCI: "REIT", WELL: "REIT",
  // Solar / clean energy
  ENPH: "SOLAR", SEDG: "SOLAR", FSLR: "SOLAR", RUN: "SOLAR", PLUG: "SOLAR",
  FCEL: "SOLAR", BE: "SOLAR", NOVA: "SOLAR", ARRY: "SOLAR", SHLS: "SOLAR",
  // Nuclear / uranium / power-for-AI — hot 2026 theme as AI data centers chase baseload
  OKLO: "NUCLEAR", SMR: "NUCLEAR", CCJ: "NUCLEAR", UEC: "NUCLEAR", LEU: "NUCLEAR",
  BWXT: "NUCLEAR", URA: "NUCLEAR", NLR: "NUCLEAR", CEG: "NUCLEAR", VST: "NUCLEAR",
  TLN: "NUCLEAR", PWR: "NUCLEAR", GEV: "NUCLEAR",
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
  // Space / aerospace mobility
  "BKSY", "PL", "LUNR", "RKLB", "ASTS", "RDW", "ACHR", "JOBY",
  // AI semiconductors — flow leaders
  "NVDA", "AVGO", "AMD", "MU", "ARM", "TSM", "SMCI", "MRVL", "INTC", "ALAB",
  // AI software / agents (PLTR is the perennial flow leader)
  "PLTR", "AI", "MDB", "ESTC", "APP",
  // Cybersecurity (option flow on every breach headline)
  "CRWD", "PANW", "ZS", "NET", "S",
  // Quantum (group moves on any quantum/IBM/Google headline)
  "IONQ", "RGTI", "QBTS", "QUBT",
  // Nuclear / power-for-AI (2026's hottest secondary theme)
  "OKLO", "SMR", "CEG", "VST", "CCJ", "UEC", "BWXT", "GEV",
  // Crypto-adjacent (move with BTC, separate from financials)
  "COIN", "MSTR",
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
]);

function isValidTickerSymbol(sym) {
  if (!sym || typeof sym !== "string") return false;
  if (!TICKER_SHAPE.test(sym)) return false;
  if (GLOBAL_TICKER_BLOCKLIST.has(sym)) return false;
  return true;
}

// Centralised add path so all three call sites (hint result, news impact, news newTickers)
// go through the same validation and respect each account's auto-pruned bad-ticker list.
function tryAddTicker(acct, sym, source) {
  if (!isValidTickerSymbol(sym)) {
    log(acct, `WATCHLIST: rejected "${sym}" from ${source} — invalid shape or blocklisted`);
    return false;
  }
  if (!acct.badTickers) acct.badTickers = {};
  if (acct.badTickers[sym]?.blocked) {
    log(acct, `WATCHLIST: rejected "${sym}" from ${source} — previously failed to load`);
    return false;
  }
  if (acct.tickers.includes(sym)) return false;
  acct.tickers.push(sym);
  return true;
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
const CYCLE_MS = 60_000;       // 60s between cycles
const API_DELAY = 150;         // 150ms between API calls (Finnhub free tier)
const DEFAULT_IV = 0.30;

// Per-contract options commission (Tradier Lite = $0.35/contract). Used as a SMALL bias against
// low-priced/small-cap underlyings in contract scoring — fees are a larger % of a cheap premium.
const FEE_PER_CONTRACT = 0.35;

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
const EOD_FREEZE_HOUR = 15;    // No new entries after 3:00 PM ET
const EOD_TIGHTEN_HOUR = 15.5; // Tighten stops after 3:30 PM ET
const EOW_TRIM_HOUR = 14;      // Friday profit-taking starts at 2:00 PM ET
const LOW_DTE_THRESHOLD = 5;   // Accelerate exits when DTE <= 5
const CRITICAL_DTE = 3;        // Force-close when DTE <= 3 (give exits room before gamma cliff)

// ─── Trust-Scaled Cash Reserve ───
// Keep a minimum cash buffer sized as a fraction of total portfolio value. The buffer starts
// defensive (CASH_RESERVE_MAX) and only shrinks toward CASH_RESERVE_MIN as conviction ("trust")
// in a setup rises. Low-trust setups must respect the full 50% buffer; only the highest-trust
// setups may deploy down to a 25% buffer. This prevents over-deployment (the $148-cash trap).
const CASH_RESERVE_MAX = 0.50; // default minimum cash on hand (low trust)
const CASH_RESERVE_MIN = 0.25; // floor minimum cash on hand (max trust)

// ─── Day-Trade (PDT) Discipline ───
// Day trades are scarce (3 per rolling window). Spend them only on big profits or loss-cuts,
// never on marginal same-day exits or same-day re-entries.
const DAY_TRADE_BIG_PROFIT = 0.30; // a same-day exit must be >= +30% to justify burning a day trade

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
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "AIzaSyB1agSJoX1rImf5gYGm6Jh9uZXSHg2AOIE").trim();

// LLM_PROVIDER: "gemini" | "claude" — defaults to Claude (Haiku)
// Mutable at runtime via dashboard toggle or POST /api/llm-provider
let LLM_PROVIDER = (process.env.LLM_PROVIDER || "claude").toLowerCase();

// TRADING_MODE: "paper" | "robinhood" — defaults to paper
// When "robinhood", the bot converts options signals to equity orders via Robinhood's MCP API.
// Mutable at runtime via dashboard toggle or POST /api/trading-mode
let TRADING_MODE = (process.env.TRADING_MODE || "paper").toLowerCase();

// RH_REQUIRE_APPROVAL: when true, Robinhood orders are queued for manual approval instead of auto-executing.
// Default true for safety — you must approve every real-money trade from the dashboard.
let RH_REQUIRE_APPROVAL = process.env.RH_REQUIRE_APPROVAL !== "false";

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
  // max positions, sector caps, PDT and DTE staggering still apply). Toggleable per account.
  useCashReserve: true,
  // When true, broker orders execute live with no manual approval step.
  autoExecute: false,
  // When true, this account runs the full trading cycle (entries + exits) even while the market
  // is closed — intended for testing live execution against a broker sandbox on weekends/after hours.
  tradeWhenClosed: false,
};

// ─── Multi-Account Runtime ───

const accounts = new Map();
const simulations = new Map();
let simIdCounter = 0;

function createAccountRuntime(id, name, config, state) {
  return {
    id,
    name: name || id,
    createdAt: Date.now(),
    paused: false,
    config: { ...DEFAULT_CONFIG, ...config },
    state: state || {
      cash: (config && config.startingCash) || DEFAULT_CONFIG.startingCash,
      positions: [],
      history: [],
      dayTrades: [],
    },
    dashboard: {
      quotes: {},
      analyses: {},
      shortTermAnalyses: {},
      candles: {},
      lastCycle: null,
      cycleLog: [],
      marketOpen: false,
      decisions: [],
      positionDetails: [],
      portfolioHistory: [],
      onDemandAnalyses: {},
    },
    candleCache: {},
    lastCandleDate: null,
    activeHints: [],
    chatHistory: [],
    lastHintContent: "",
    currentRegime: { mode: "unknown", riskScale: 1.0, label: "UNKNOWN" },
    riskPct: (config && config.baseRiskPct) || DEFAULT_CONFIG.baseRiskPct,
    dynamicWatchlist: [],
    tickers: ["SPY", "QQQ"],
    lastWatchlistRefresh: 0,
    lastNewsScan: 0,
    latestNewsBrief: "",
  };
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
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  return parseCookies(req)[AUTH_COOKIE] === authToken();
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
  .err{color:#e8473f;font-size:12px;margin-top:12px;text-align:center}
</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>🔒 Swing Trader</h1>
    <p>Enter your password to access the portfolio.</p>
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus inputmode="numeric">
    <button type="submit">Sign in</button>
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
        for (const [id, acctData] of Object.entries(data.accounts)) {
          const acct = createAccountRuntime(id, acctData.name, acctData.config, acctData.state);
          acct.paused = acctData.paused || false;
          acct.createdAt = acctData.createdAt || Date.now();
          // Restore the persisted portfolio-value chart series across restarts/redeploys.
          if (Array.isArray(acctData.portfolioHistory)) acct.dashboard.portfolioHistory = acctData.portfolioHistory;
          accounts.set(id, acct);
        }
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
          dayTrades: old.dayTrades || [],
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

function saveAccounts() {
  const data = { meta: { version: 1 }, accounts: {} };
  for (const [id, acct] of accounts) {
    data.accounts[id] = {
      id: acct.id,
      name: acct.name,
      createdAt: acct.createdAt,
      paused: acct.paused,
      config: acct.config,
      state: acct.state,
      // Persist the portfolio-value series so the chart survives server restarts/redeploys
      // (previously it lived only in memory and reset every deploy). Capped to bound file size.
      portfolioHistory: (acct.dashboard?.portfolioHistory || []).slice(-10000),
    };
  }
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`WARN: Failed to save accounts — ${e.message}`);
  }
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
  if (acct.dashboard.cycleLog.length > 200) acct.dashboard.cycleLog.shift();
}

// Append-only trade log for Monte Carlo training
function logTrade(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync("trades.log", line);
  } catch { }
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

function renderChartPNG(candles, ticker, analysis, shortTermAnalysis, quote) {
  if (!candles || candles.length < 3) return null;
  try {
    const W = 1100, H = 500, PAD = 50;
    const cls = candles.map(c => c.c), hs = candles.map(c => c.h), ls = candles.map(c => c.l), vs = candles.map(c => c.v);
    const emas = [
      { period: 8, color: "#138f86", label: "EMA 8", data: calcEMA(cls, 8) },
      { period: 21, color: "#d2691e", label: "EMA 21", data: calcEMA(cls, 21) },
      { period: 50, color: "#6a4df4", label: "EMA 50", data: calcEMA(cls, 50) },
    ];
    const allP = [...hs, ...ls];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 40) - 20;
    const x = i => PAD + (i / Math.max(1, cls.length - 1)) * (W - PAD);

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
      <text x="20" y="22" fill="#fff" font-size="18" font-weight="bold" font-family="monospace">$${ticker}</text>
      <text x="${20 + ticker.length * 12 + 10}" y="22" fill="#6b7280" font-size="14" font-family="monospace">$${price}</text>
      <text x="${20 + ticker.length * 12 + 80}" y="22" fill="${chgColor}" font-size="14" font-family="monospace">${chg}</text>
      <text x="${W - 20}" y="22" fill="${scoreColor}" font-size="16" font-weight="bold" font-family="monospace" text-anchor="end">Score: ${score}/100 ${signal}</text>
      <text x="${W + 60}" y="22" fill="#6b7280" font-size="12" font-family="monospace">RSI: ${rsi} | 7d: ${stScore}</text>
      ${legend}
      <g transform="translate(0, 10)">
        ${bars}
        ${emaPaths}
        ${pLabels}
        ${volBars}
      </g>
      <line x1="20" y1="${H + VH + 40}" x2="${W + 60}" y2="${H + VH + 40}" stroke="#e3e6ea" stroke-width="1"/>
      <text x="20" y="${H + VH + 58}" fill="#6b7280" font-size="11" font-family="monospace">Key Signals:</text>
      ${signalsText}
      <text x="1180" y="${totalH - 10}" fill="#d4d8e0" font-size="10" font-family="monospace" text-anchor="end">SwingTrader Bot</text>
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

// ─── Earnings Calendar Check (Finnhub) ───

async function checkEarnings(ticker, apiKey) {
  try {
    const now = getETDate();
    const from = now.toISOString().slice(0, 10);
    const futureDate = new Date(now.getTime() + 8 * 86400_000); // 8 days out
    const to = futureDate.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${apiKey}`);
    if (!r.ok) return { hasEarnings: false, daysUntil: null };
    const data = await r.json();
    const earnings = data.earningsCalendar || [];
    if (earnings.length === 0) return { hasEarnings: false, daysUntil: null };
    const nextEarning = earnings[0];
    const earningDate = new Date(nextEarning.date);
    const daysUntil = Math.ceil((earningDate - now) / 86400_000);
    return { hasEarnings: daysUntil <= 7, daysUntil, date: nextEarning.date };
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

// ─── Gap Detection & Base Size Scoring ───

function detectGap(candles) {
  // Detect gap down or gap up on the latest candle relative to prior close
  if (!candles || candles.length < 2) return { type: "none", pct: 0 };
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const gapPct = ((curr.o - prev.c) / prev.c) * 100;
  if (gapPct < -0.5) return { type: "gap_down", pct: Math.abs(gapPct).toFixed(2) };
  if (gapPct > 0.5) return { type: "gap_up", pct: gapPct.toFixed(2) };
  return { type: "none", pct: 0 };
}

function measureBaseSize(candles) {
  // Measure how long price has been consolidating (bigger base = bigger breakout potential)
  // Counts consecutive days within a tight range before the current move
  if (!candles || candles.length < 20) return { days: 0, rangePct: 0 };
  const lookback = candles.slice(-60, -3); // exclude last 3 days (the move itself)
  if (lookback.length < 10) return { days: 0, rangePct: 0 };

  // Find the range of the base: how tight was price action?
  const closes = lookback.map(d => d.c);
  let baseDays = 0;
  const recentClose = closes[closes.length - 1];
  const tolerance = 0.08; // 8% range counts as a base

  // Walk backwards from the end of lookback, count days within tolerance of the range
  const rangeHigh = Math.max(...closes.slice(-20));
  const rangeLow = Math.min(...closes.slice(-20));
  const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;

  if (rangePct <= tolerance * 100) {
    // Tight base — count how many consecutive days are within the range
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] >= rangeLow * 0.98 && closes[i] <= rangeHigh * 1.02) baseDays++;
      else break;
    }
  } else {
    // Wider base — count days in the broader range
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] >= rangeLow * 0.95 && closes[i] <= rangeHigh * 1.05) baseDays++;
      else break;
    }
  }

  return { days: baseDays, rangePct: rangePct.toFixed(1) };
}

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
  const cutoff = getBusinessDaysAgo(3);
  state.dayTrades = state.dayTrades.filter(dt => dt.date >= cutoff);
}

function countRecentDayTrades(state) {
  const cutoff = getBusinessDaysAgo(3);
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
  return { c: meta.regularMarketPrice, h: meta.regularMarketDayHigh || meta.regularMarketPrice, l: meta.regularMarketDayLow || meta.regularMarketPrice, o: meta.regularMarketOpen || meta.regularMarketPrice, pc: meta.chartPreviousClose || meta.previousClose || 0 };
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
      if (chain && chain.length > 0) return chain;
    } catch { }
  }
  // Fallback: Finnhub option chain.
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/option-chain?symbol=${sym}&token=${apiKey}`);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
    return data.data;
  } catch {
    return null;
  }
}

// Filters the full chain down to viable candidate contracts for Claude to choose from.
// Returns up to maxCandidates sorted by a quality score (DTE preference, liquidity, spread).
function buildCandidateContracts(chain, type, spotPrice, maxCandidates = 12) {
  const now = Date.now();
  const typeKey = type.toUpperCase();
  const candidates = [];

  for (const exp of chain) {
    const expiryDt = new Date(exp.expirationDate);
    expiryDt.setHours(16, 0, 0, 0);
    const dte = Math.round((expiryDt.getTime() - now) / 86400_000);
    if (dte < 10 || dte > 45) continue; // 10-45 DTE — 7DTE bled to theta on flat thesis

    const contracts = exp.options?.[typeKey] || [];
    for (const c of contracts) {
      if (!c.strike || c.strike <= 0) continue;
      if (!c.bid || c.bid <= 0) continue;       // no bid = can't fill
      if ((c.openInterest || 0) < 5) continue;  // completely illiquid

      const mid = +((c.bid + c.ask) / 2).toFixed(2);
      if (mid < 0.25) continue; // penny options: bid-ask spread alone is 5-10%, kills edge

      // Moneyness: positive = OTM (we want to be able to buy OTM or slight ITM)
      const moneyness = typeKey === "CALL"
        ? (c.strike - spotPrice) / spotPrice   // +ve = OTM call
        : (spotPrice - c.strike) / spotPrice;  // +ve = OTM put

      // Allow from 10% ITM to 25% OTM — lets Claude decide depth
      if (moneyness < -0.10 || moneyness > 0.25) continue;

      const spread = +(c.ask - c.bid).toFixed(2);
      const spreadPct = mid > 0 ? (spread / mid) : 1;
      if (spreadPct > 0.40 && mid > 0.10) continue; // too wide a spread

      const iv = c.impliedVolatility > 0 ? c.impliedVolatility : null;
      const delta = c.delta != null ? c.delta : null;

      // Commission drag: a round-trip (buy + sell) costs ~2 contracts of commission. As a fraction
      // of premium this is far larger on cheap options (small caps), so it doubles as a SMALL bias
      // against small-cap/low-priced names — exactly what the user asked for.
      const feeDragPct = mid > 0 ? (2 * FEE_PER_CONTRACT) / (mid * 100) : 0;
      // Extra gentle bias against low-priced underlyings (small caps tend to be wider/thinner).
      const smallCapPenalty = spotPrice < 10 ? 0.6 : spotPrice < 20 ? 0.3 : 0;

      // Quality score: penalise wide spreads, illiquidity, very short or very long DTE, plus the
      // small fee/small-cap bias (kept small so it only breaks otherwise-close ties).
      const dtePenalty = Math.abs(dte - 21); // prefer ~21 DTE — leaves room for thesis to play out
      const liqScore = Math.log1p((c.openInterest || 0) + (c.volume || 0));
      const quality = liqScore - spreadPct * 3 - dtePenalty * 0.1 - feeDragPct * 4 - smallCapPenalty;

      candidates.push({
        strike: c.strike,
        expiryDate: expiryDt.getTime(),
        expiryStr: exp.expirationDate,
        dte,
        mid,
        bid: c.bid,
        ask: +(c.ask || 0).toFixed(2),
        iv,
        delta,
        oi: c.openInterest || 0,
        volume: c.volume || 0,
        spread,
        spreadPct: +(spreadPct * 100).toFixed(1),
        feeDragPct: +(feeDragPct * 100).toFixed(1),
        quality,
      });
    }
  }

  candidates.sort((a, b) => b.quality - a.quality);
  return candidates.slice(0, maxCandidates);
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

// Entry limit price for a live options buy, trading like a disciplined human: when conviction is
// high AND we aren't day-trade constrained, lean toward the ask (even crossing to it) to actually
// get filled; when conviction is low or PDT risk is high, sit patiently at the mid. Never pays
// through the offer. conviction is 0..1; falls back to mid if we lack a real two-sided market.
function entryLimitPrice(bid, ask, mid, conviction, pdtRiskLow) {
  const m = +(+mid).toFixed(2);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return m;
  let aggr = Math.max(0, Math.min(1, conviction));
  if (!pdtRiskLow) aggr = Math.min(aggr, 0.25); // stay near mid when day-trade headroom is tight
  const px = mid + aggr * (ask - mid);
  return +Math.min(ask, Math.max(bid, px)).toFixed(2);
}

// PDT (pattern-day-trader) risk is only a real constraint on MARGIN accounts under $25k. Cash
// accounts aren't subject to PDT at all (their constraint is T+1 settlement, handled by only
// deploying settled cash). So PDT risk is "low" for cash accounts, or when we still have day-trade
// headroom on a margin account.
function pdtRiskLow(state) {
  if (state.accountType === "cash") return true;
  return countRecentDayTrades(state) < 2; // leave a buffer below the 3-in-5 limit
}

// ─── Portfolio Helpers ───

function portfolioValue(state, quotes) {
  // Broker accounts: trust Tradier's own total_equity. It already nets settled cash, filled
  // positions, AND capital reserved by working (unfilled) orders — so nothing appears to "vanish"
  // into pending orders the way cash+positions alone would.
  if (typeof state.brokerEquity === "number" && state.brokerEquity > 0) return state.brokerEquity;
  let val = state.cash;
  for (const pos of state.positions) {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type);
    val += currentPremium * pos.qty * 100;
  }
  return val;
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
// Key: "<acctId>:<ticker>" → { ts, score, direction, result, selectedCandidate }
const claudeValidationCache = new Map();
const CLAUDE_VALIDATION_COOLDOWN_MS = 10 * 60_000; // 10 minutes
const CLAUDE_VALIDATION_SCORE_DELTA = 5;            // re-validate if score shifts ≥5 pts

function getCachedValidation(acctId, ticker, currentScore, direction) {
  const key = `${acctId}:${ticker}`;
  const cached = claudeValidationCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > CLAUDE_VALIDATION_COOLDOWN_MS) return null;
  if (Math.abs(currentScore - cached.score) >= CLAUDE_VALIDATION_SCORE_DELTA) return null;
  if (cached.direction !== direction) return null;
  return cached; // returns { result, selectedCandidate }
}

function setCachedValidation(acctId, ticker, score, direction, result, selectedCandidate = null) {
  const key = `${acctId}:${ticker}`;
  claudeValidationCache.set(key, { ts: Date.now(), score, direction, result, selectedCandidate });
}

// ─── Options Chain Cache ───
// Short-lived per-ticker chain cache so rapid re-attempts don't hammer Finnhub.
const chainCache = new Map();
const CHAIN_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function getCachedChain(ticker) {
  const cached = chainCache.get(ticker);
  if (!cached || Date.now() - cached.ts > CHAIN_CACHE_TTL_MS) return null;
  return cached.chain;
}

function setCachedChain(ticker, chain) {
  chainCache.set(ticker, { ts: Date.now(), chain });
}

async function callClaudeRaw(prompt, retries = 3) {
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
        max_tokens: 1024,
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

async function callGemini(prompt, retries = 3) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1024 },
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
async function callClaude(prompt, retries = 3) {
  if (LLM_PROVIDER === "gemini") {
    return callGemini(prompt, retries);
  }
  return callClaudeRaw(prompt, retries);
}

async function processHint(hintText, acct) {
  const state = acct.state;
  const dash = acct.dashboard;
  const portfolioContext = `Portfolio: $${state.cash.toFixed(0)} cash, ${state.positions.length} positions open (${state.positions.map(p => `${p.ticker} ${p.type} @ $${p.entrySpot?.toFixed(0)}`).join(", ") || "none"}). Watchlist: ${acct.tickers.join(", ")}. Active hints: ${acct.activeHints.map(h => `${h.ticker} ${h.bias > 0 ? '+' : ''}${h.bias}`).join(", ") || "none"}.`;

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
- Keep responses concise and direct — this is shown in a trading terminal.`;

  try {
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    log(acct, `CLAUDE WARN: Failed to parse hint response — ${e.message}`);
    return null;
  }
}

async function checkHints(acct) {
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

    applyHintResult(acct, result, content);

    // Clear the hint file after processing
    fs.writeFileSync(hintFile, "");

  } catch (e) {
    log(acct, `HINT ERROR: ${e.message}`);
  }
}

function applyHintResult(acct, result, userMessage) {
  if (result.advice) log(acct, `CLAUDE SAYS: ${result.advice || result.response}`);

  // Store in chat history (keep last 30 exchanges)
  if (!acct.chatHistory) acct.chatHistory = [];
  acct.chatHistory.push({ role: "user", content: userMessage, ts: Date.now() });
  acct.chatHistory.push({ role: "ai", content: result.response || result.advice || "", ts: Date.now() });
  if (acct.chatHistory.length > 60) acct.chatHistory = acct.chatHistory.slice(-60);

  for (const t of result.tickers || []) {
    if (!isValidTickerSymbol(t.symbol)) {
      log(acct, `HINT: rejected "${t.symbol}" — invalid ticker shape`);
      continue;
    }
    if (acct.badTickers?.[t.symbol]?.blocked) {
      log(acct, `HINT: rejected "${t.symbol}" — on local blocklist (failed to load before)`);
      continue;
    }
    if (!acct.tickers.includes(t.symbol)) {
      acct.tickers.push(t.symbol);
      log(acct, `WATCHLIST +${t.symbol} (${t.direction}, bias ${t.bias > 0 ? "+" : ""}${t.bias})`);
    } else {
      log(acct, `BIAS ${t.symbol}: ${t.bias > 0 ? "+" : ""}${t.bias} (${t.direction}) — ${t.reasoning}`);
    }

    const existing = acct.activeHints.findIndex(h => h.ticker === t.symbol);
    const hint = {
      ticker: t.symbol,
      bias: t.bias,
      direction: t.direction,
      reasoning: t.reasoning,
      expiresAt: Date.now() + 4 * 60 * 60_000,
    };
    if (existing >= 0) acct.activeHints[existing] = hint;
    else acct.activeHints.push(hint);
  }

  for (const sym of result.removeTickers || []) {
    acct.tickers = acct.tickers.filter(t => t !== sym);
    acct.activeHints = acct.activeHints.filter(h => h.ticker !== sym);
    log(acct, `WATCHLIST -${sym}`);
  }
}

function getHintBias(acct, ticker) {
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
      await delay(API_DELAY);
    } catch { }
  }

  return headlines;
}

function todayStr() {
  const d = getETDate();
  return d.toISOString().slice(0, 10);
}

async function runNewsScan(acct, apiKey) {
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
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(cleaned);

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

async function validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime, candidates) {
  const cfg = acct.config;
  const direction = analysis.score >= cfg.bullEntry ? 'BULLISH (buying calls)' : 'BEARISH (buying puts)';

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
    contractSection = `\nReal options chain (${candidates.length} viable contracts):\n${header}\n${rows}`;
    contractInstruction = `\nSelect the best contract index (1-${candidates.length}) for this trade. Consider: DTE vs setup timeframe, delta (higher confidence → closer to ATM), liquidity (OI + volume), and spread cost.`;
  } else {
    contractSection = '\nNo real chain data available — synthetic pricing will be used.';
  }

  const promptText = `You are a trading bot's risk management system. Evaluate this potential options trade and select the best available contract.

Ticker: ${ticker}
Price: $${quote.c.toFixed(2)}
Direction: ${direction}
Technical Score: ${analysis.score}/100
RSI: ${analysis.rsi?.toFixed(1) || 'N/A'}
EMA Stack: ${analysis.aligned ? 'Aligned bullish (8>21>50)' : analysis.bearish ? 'Aligned bearish (50>21>8)' : 'Mixed/transitioning'}
Setup Quality: ${setupQuality.quality}/100 (${setupQuality.tight ? 'tight base' : 'wide range'}, ${setupQuality.breakingOut ? 'breaking out' : 'no breakout'}, vol ${setupQuality.volDeclining ? 'declining in base' : 'normal'})
Market Regime: ${regime.label}
${earningsInfo.hasEarnings ? `⚠ EARNINGS in ${earningsInfo.daysUntil} days (${earningsInfo.date})` : 'No earnings risk in next 3 days'}
${cfg.customPromptSuffix ? `Additional context: ${cfg.customPromptSuffix}` : ''}
${contractSection}

Evaluate:
1. Is this a quality setup or chasing an extended move?
2. Key risks for this trade given current conditions?
3. Best contract choice and why (DTE, strike depth)?
${contractInstruction}

Respond with ONLY valid JSON (no markdown, no backticks). "reasoning" must be your FULL thought
process: walk through the setup assessment, the technical/regime read, the specific risks, and why
you chose (or rejected) the contract — several sentences. "suggestion" stays a one-line takeaway:
{"approve": true, "confidence": 75, "concerns": [], "reasoning": "full step-by-step thought process", "suggestion": "one-line takeaway"${candidates?.length > 0 ? ', "contractIdx": 1' : ''}}`;

  try {
    const raw = await callClaude(promptText);
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(cleaned);
    // Validate contractIdx is in range
    if (candidates?.length > 0) {
      const idx = parseInt(result.contractIdx);
      result.contractIdx = (idx >= 1 && idx <= candidates.length) ? idx - 1 : 0; // convert to 0-based
    }
    return result;
  } catch (e) {
    log(acct, `CLAUDE VALIDATE WARN: Parse failed — ${e.message}. Defaulting to approve.`);
    return { approve: true, confidence: 50, concerns: ["validation parse failed"], reasoning: "AI response could not be parsed; proceeding with caution on technicals alone.", suggestion: "proceeding with caution", contractIdx: 0 };
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

  const raw = await callClaude(promptText);
  return raw.trim();
}

// ─── Entry Logic (enhanced with setup quality, EOD freeze, Claude validation) ───

async function tryEntry(acct, ticker, analysis, quote, regime, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  if (state.positions.some(p => p.ticker === ticker)) return null;
  if (state.cash < 100) return null;
  // Broker accounts: also skip names with a working (unfilled) order this cycle so we don't
  // stack duplicate orders while an earlier one is still resting.
  if (cfg.broker === "tradier" && acct._inflightTickers?.has(ticker.toUpperCase())) {
    return { skipped: true, reason: `Tradier: working order already open for ${ticker}` };
  }
  // PDT discipline: don't re-enter a name we already closed today. Same-day round-trips burn
  // scarce day trades — wait for a fresh session before re-engaging.
  if (state.lastClosed && state.lastClosed[ticker] === getETDateStr()) {
    return { skipped: true, reason: `PDT preserve: closed ${ticker} earlier today — avoiding same-day re-entry` };
  }
  // Hard cap on concurrent positions — prevents over-deployment that drained cash to $25.
  // For broker accounts this counts filled positions PLUS working orders (effectivePositionCount).
  const openCount = cfg.broker === "tradier" ? effectivePositionCount(acct) : state.positions.length;
  if (cfg.maxPositions && openCount >= cfg.maxPositions) {
    return { skipped: true, reason: `Max positions (${cfg.maxPositions}) already open or pending` };
  }
  // Sector concentration cap — prevent doubling/tripling-down on correlated names.
  // Example: holding CL+XLE+USO means one bad oil headline unwinds three positions together.
  // OTHER sector is unlimited (unmapped tickers have unknown correlation).
  const sector = getSector(ticker);
  if (sector !== "OTHER") {
    const inSector = countPositionsInSector(state, sector);
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
  if (etHour >= EOD_FREEZE_HOUR && analysis.score < 80 && analysis.score > 20) {
    return { skipped: true, reason: `EOD freeze (${etHour.toFixed(1)} >= ${EOD_FREEZE_HOUR}h, score ${analysis.score} not extreme enough)` };
  }

  // Use the better of consolidation quality (tight base) or momentum quality (trending runner).
  // SRxTrades buys both: tight-base breakouts AND 8 EMA taps on leaders in motion.
  const setupQuality = detectConsolidation(acct.candleCache[ticker]);
  const momentumQuality = detectMomentumQuality(acct.candleCache[ticker]);
  const effectiveQuality = Math.max(setupQuality.quality, momentumQuality.quality);
  const minQuality = acct.config.minSetupQuality ?? 50;
  if (effectiveQuality < minQuality) {
    return { skipped: true, reason: `Low setup quality ${effectiveQuality}/100 (base:${setupQuality.quality} mom:${momentumQuality.quality}, need >=${minQuality}, range ${setupQuality.rangePct}%)` };
  }

  // ─── Local pre-filters (catch what Claude would reject without API call) ───
  const isBullish = analysis.score >= cfg.bullEntry;
  const isBearish = analysis.score <= cfg.bearEntry;

  // SRxTrades style: relative strength names often have RSI 70-90 on 8 EMA taps — that IS the setup.
  // Only block truly parabolic RSI that indicates exhaustion, not healthy momentum.
  if (isBullish && analysis.rsi > 85 && !analysis.aligned) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} parabolic with misaligned EMAs — exhaustion risk, not a healthy strength setup` };
  }
  if (isBearish && analysis.rsi > 30 && analysis.rsi < 55 && !analysis.bearish) {
    return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} neutral with non-bearish EMA stack — weak put setup` };
  }

  // Risk-off regime contradicts bullish calls
  if (isBullish && regime.mode === "risk-off" && !analysis.aligned) {
    return { skipped: true, reason: `Risk-off regime + misaligned EMAs contradicts bullish call bias` };
  }

  // Range cap: tight consolidation setups need <15%; aligned EMA leaders (SRxTrades style) allow up to 60%
  const maxRange = (analysis.aligned && isBullish) || (analysis.bearish && isBearish) ? 60 : 15;
  if (parseFloat(setupQuality.rangePct) > maxRange) {
    return { skipped: true, reason: `Range ${setupQuality.rangePct}% too wide (max ${maxRange}%) — extended move, not consolidation setup` };
  }

  let earningsInfo = { hasEarnings: false, daysUntil: null };
  try {
    earningsInfo = await checkEarnings(ticker, apiKey);
    await delay(API_DELAY);
  } catch { }
  if (earningsInfo.hasEarnings) {
    return { skipped: true, reason: `Earnings in ${earningsInfo.daysUntil} days (${earningsInfo.date}) — too risky for 7DTE options` };
  }

  const spot = quote.c;
  const maxRisk = state.cash * acct.riskPct;
  const direction = isBullish ? "BULLISH" : "BEARISH";
  const type = isBullish ? "call" : "put";

  // ─── Step 1: Check validation cache (skips both chain fetch AND Claude call) ───
  let claudeResult = { approve: true, confidence: 70, concerns: [], reasoning: "", suggestion: "", contractIdx: 0 };
  let selectedCandidate = null;

  const cached = getCachedValidation(acct.id, ticker, analysis.score, direction);
  if (cached) {
    claudeResult = cached.result;
    selectedCandidate = cached.selectedCandidate; // may be null if previously used synthetic
    log(acct, `CLAUDE VALIDATE ${ticker}: CACHED ${claudeResult.approve ? 'APPROVED' : 'REJECTED'} (${claudeResult.confidence}%) — skipping chain fetch + Claude call`);
    if (!claudeResult.approve) {
      return { skipped: true, reason: `Claude rejected (cached): ${claudeResult.suggestion}` };
    }
  } else {
    // ─── Step 2: Fetch full options chain (with short-lived cache) ───
    let candidates = [];
    try {
      let chain = getCachedChain(ticker);
      if (!chain) {
        chain = await fetchFullOptionsChain(ticker, apiKey);
        await delay(API_DELAY);
        if (chain) setCachedChain(ticker, chain);
      }
      if (chain) {
        candidates = buildCandidateContracts(chain, type, spot);
        log(acct, `OPTIONS ${ticker}: ${candidates.length} viable ${type} contracts (${chain.length} expiries)`);
      }
    } catch (e) {
      log(acct, `OPTIONS ${ticker}: chain error — ${e.message}`);
    }

    // ─── Step 3: Claude validates setup AND selects best contract ───
    try {
      claudeResult = await validateEntryWithClaude(acct, ticker, quote, analysis, setupQuality, earningsInfo, regime, candidates);
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
      setCachedValidation(acct.id, ticker, analysis.score, direction, claudeResult, selectedCandidate);
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
      log(acct, `CLAUDE VALIDATE ${ticker}: Error — ${e.message}, proceeding anyway`);
    }

    if (!claudeResult.approve) {
      return { skipped: true, reason: `Claude rejected: ${claudeResult.suggestion} (${(claudeResult.concerns || []).join(', ')})` };
    }
  }

  // ─── Step 4: Use selected contract (from cache or fresh) ───
  let strike, dte, expiryDate, premium, posIv, optionsSource;
  // selectedCandidate already set above (either from cache or fresh Claude response)

  if (selectedCandidate) {
    strike = selectedCandidate.strike;
    dte = selectedCandidate.dte;
    expiryDate = selectedCandidate.expiryDate;
    premium = selectedCandidate.mid;
    posIv = selectedCandidate.iv || DEFAULT_IV;
    optionsSource = tradier.isConnected ? "tradier" : "finnhub";
    log(acct, `CONTRACT ${ticker}: $${strike} ${type.toUpperCase()} exp ${selectedCandidate.expiryStr} (${dte}d) @ $${premium} mid | IV ${posIv ? (posIv*100).toFixed(0)+'%' : '?'} | OI ${selectedCandidate.oi} | spread $${selectedCandidate.spread}${selectedCandidate.feeDragPct != null ? ` | fee drag ${selectedCandidate.feeDragPct}% RT` : ''}`);
  } else {
    // Synthetic fallback: 1 strike OTM, expiry chosen from the ticker's cadence near TARGET_DTE
    // and staggered away from over-concentrated expirations.
    const atm = Math.round(spot / 5) * 5;
    strike = isBullish ? atm + 5 : atm - 5;
    const expiry = nextExpiry(ticker, { targetDTE: TARGET_DTE, state });
    dte = expiry.dte;
    expiryDate = expiry.date.getTime();
    posIv = DEFAULT_IV;
    premium = optPrice(spot, strike, dte, DEFAULT_IV, type);
    optionsSource = "synthetic";
    log(acct, `OPTIONS ${ticker}: using synthetic pricing — $${strike} ${type} ${dte}d @ $${premium.toFixed(2)}`);
  }

  const costPer = premium * 100;
  if (costPer > state.cash) return null;

  // ─── Trust-scaled cash reserve ───
  // Only high-conviction setups may draw the buffer toward 25%; low-trust setups respect 50%.
  const pv = portfolioValue(state, acct.dashboard?.quotes || {});
  const trust = computeTradeTrust({
    claudeConfidence: claudeResult.confidence,
    setupQuality: effectiveQuality,
    technicalScore: analysis.score,
    isBullish,
    cfg,
    regime,
  });
  // Cash reserve is toggleable per account. When disabled, deploy full cash (other limits still apply).
  let deployable, reservePct;
  if (cfg.useCashReserve === false) {
    deployable = state.cash;
    reservePct = 0;
  } else {
    ({ deployable, reservePct } = deployableCash(state, pv, trust));
  }
  if (deployable < costPer) {
    return { skipped: true, reason: `Cash reserve: ${(reservePct * 100).toFixed(0)}% buffer required (trust ${(trust * 100).toFixed(0)}%) — only $${deployable.toFixed(0)} of $${state.cash.toFixed(0)} cash deployable, need $${costPer.toFixed(0)}/contract` };
  }

  const budget = Math.min(maxRisk, deployable);
  let qty = Math.max(1, Math.floor(budget / costPer));
  let totalCost = qty * costPer;
  if (totalCost > deployable) { qty = Math.floor(deployable / costPer); totalCost = qty * costPer; }
  if (qty < 1) return { skipped: true, reason: `Insufficient deployable cash for 1 contract${cfg.useCashReserve === false ? "" : ` (buffer ${(reservePct * 100).toFixed(0)}%)`}` };

  // Full AI/decision thought process captured at entry, attached to the trade for the life of the
  // position and into trade history. If the LLM wasn't called (or returned no prose), synthesize a
  // readable thesis from the technical signals so every trade still documents WHY it was opened.
  const topSignals = (analysis.sigs || []).slice(0, 5).map(s => s.text);
  const claudeReasoning = (claudeResult.reasoning || "").trim()
    || `No LLM prose for this entry. Opened on technicals: ${direction} setup, score ${analysis.score}/100, setup quality ${setupQuality.quality}/100, regime ${regime.label}. Signals: ${topSignals.join("; ") || "n/a"}.`;
  const aiThesis = {
    claudeConfidence: claudeResult.confidence,
    claudeReasoning,
    claudeSuggestion: claudeResult.suggestion || "",
    claudeConcerns: claudeResult.concerns || [],
    setupQuality: setupQuality.quality,
    technicalScore: analysis.score,
    direction,
    regimeAtEntry: regime.label,
    topSignals,
    entryAtrPct: analysis.atrPct ?? null,
  };

  // ─── Broker accounts: place a REAL buy_to_open and let the next sync reconcile state ───
  // Broker is the source of truth, so we do NOT push a synthetic position or mutate cash here.
  if (cfg.broker === "tradier") {
    // Never place a live order on fabricated pricing. Require a real chosen contract with a real
    // two-sided mid; synthetic Black-Scholes pricing (DEFAULT_IV) is for paper simulation only.
    if (optionsSource === "synthetic" || !selectedCandidate || !(premium > 0)) {
      return { skipped: true, reason: `Tradier: no real option market for ${ticker} (source ${optionsSource}) — refusing to trade on synthetic pricing` };
    }
    return await placeBrokerEntry(acct, {
      ticker, type, strike, expiryDate, dte, qty, premium, direction,
      bid: selectedCandidate.bid, ask: selectedCandidate.ask,
      setupQuality: effectiveQuality, claudeConfidence: claudeResult.confidence,
      aiThesis,
    });
  }

  const position = {
    ticker, type, strike, dte,
    expiryDate,
    dteRemaining: dte,
    entryPremium: +premium.toFixed(2),
    entrySpot: spot,
    qty,
    originalQty: qty,
    cost: totalCost,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,
    bestPnlPct: 0,
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
  if (state.positions.some(p => p.ticker === ticker)) return null;
  // In sim mode, allow trading as long as we have enough for at least 1 contract
  if (state.cash < 10) return null;
  // Limit concurrent positions to avoid overexposure
  const maxPos = cfg.maxPositions || 5;
  if (state.positions.length >= maxPos) return null;
  if (analysis.score < cfg.bullEntry && analysis.score > cfg.bearEntry) return null;

  const isBullish = analysis.score >= cfg.bullEntry;
  const isBearish = analysis.score <= cfg.bearEntry;

  const candles = acct.candleCache[ticker];
  const sq = detectConsolidation(candles);
  const mq = detectMomentumQuality(candles);
  const effectiveQuality = Math.max(sq.quality, mq.quality);
  const minQuality = cfg.minSetupQuality ?? 50;
  if (effectiveQuality < minQuality) return { skipped: true, reason: `Low setup quality ${effectiveQuality}/100 (base:${sq.quality} mom:${mq.quality})` };

  if (isBullish && analysis.rsi > 85 && !analysis.aligned) return { skipped: true, reason: `RSI ${analysis.rsi.toFixed(1)} parabolic with misaligned EMAs` };
  if (isBearish && analysis.rsi > 30 && analysis.rsi < 55 && !analysis.bearish) return { skipped: true, reason: `Weak put setup` };
  if (isBullish && regime.mode === "risk-off" && !analysis.aligned) return { skipped: true, reason: `Risk-off + misaligned EMAs` };
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

  const position = {
    ticker, type, strike, dte, expiryDate, dteRemaining: dte,
    entryPremium: premium, entrySpot: spot, qty, originalQty: qty,
    cost: totalCost, openDate: acct._simDateStr || getETDateStr(),
    openTime: acct._simNow || Date.now(),
    trimLevel: 0, bestPnlPct: 0,
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

function closePosition(acct, pos, currentPremium, reason, qtyToClose) {
  const state = acct.state;
  const qty = qtyToClose || pos.qty;
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
  const pnlDollar = (currentPremium - pos.entryPremium) * qty * 100;

  if (!acct._simMode && wouldBeDayTrade(pos)) {
    // This close is a same-day round-trip = a day trade. Day trades are scarce, so spend them
    // only on big profits or loss-cuts. Marginal same-day gains are held into the next session.
    const bigProfit = pnlPct >= DAY_TRADE_BIG_PROFIT;
    const lossExit = pnlPct <= 0;
    if (!bigProfit && !lossExit) {
      log(acct, `PDT PRESERVE: Holding ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} — same-day exit at +${(pnlPct * 100).toFixed(0)}% not worth a day trade (need +${(DAY_TRADE_BIG_PROFIT * 100).toFixed(0)}% or a loss)`);
      return null;
    }
    if (countRecentDayTrades(state) >= 3) {
      const used = countRecentDayTrades(state);
      log(acct, `PDT BLOCKED: Cannot close ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} — ${used}/3 day trades used`);
      return null;
    }
  }

  // Broker (live) accounts: place a real sell_to_close and let the next sync reconcile.
  // Returns null so the exit loop keeps the position until the fill is confirmed by Tradier.
  if (!acct._simMode && acct.config.broker === "tradier") {
    return placeBrokerExit(acct, pos, currentPremium, reason, qty, pnlPct, pnlDollar);
  }

  const proceeds = currentPremium * qty * 100;
  state.cash += proceeds;
  state.realizedPnl = (state.realizedPnl || 0) + pnlDollar;
  if (!acct._simMode) {
    recordDayTrade(state, pos);
    // Track the close date per ticker so tryEntry can block same-day re-entry (PDT preservation).
    if (!state.lastClosed) state.lastClosed = {};
    state.lastClosed[pos.ticker] = getETDateStr();
  }

  const dtUsed = countRecentDayTrades(state);
  const trade = { ...pos, qty: qty, closePremium: currentPremium, pnlDollar, pnlPct, reason, closeDate: getETDateStr() };
  if (!acct._simMode) logTrade(trade);

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(acct, `${trimLabel}: ${pos.ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);
  if (!acct._simMode && wouldBeDayTrade(pos)) {
    log(acct, `PDT CHECK: ${dtUsed}/3 day trades used (rolling 5 days)`);
  }

  // Push notification — exit alert
  if (!acct._simMode) {
    const isTrim = qty < pos.qty;
    const emoji = pnlDollar >= 0 ? "✅" : "🛑";
    const label = isTrim ? "TRIM" : (pnlDollar >= 0 ? "EXIT TP" : "EXIT SL");
    sendPush(
      `${emoji} ${label}: ${pos.ticker} ${pos.type.toUpperCase()} $${pos.strike} [${acct.name}]`,
      `P&L: ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%)\n${reason}`,
      pnlDollar < 0 // urgent only for stop losses
    ).catch(() => {});
    tweetTradeExit(acct, pos, trade).catch(e => console.log(`  [X] Exit tweet error: ${e.message}`));

    // ─── Robinhood Agentic Execution (exit) ───
    // Skip for Tradier broker accounts — they execute natively via placeBrokerExit (and return early).
    if (acct.config.broker !== "tradier" && TRADING_MODE === "robinhood" && robinhood.isConnected) {
      try {
        // For exits, sell the corresponding equity shares
        const isTrimLocal = qty < pos.qty;
        const equityOrder = {
          symbol: pos.ticker,
          side: "sell",
          quantity: isTrimLocal ? Math.max(1, Math.round(qty)) : Math.max(1, Math.round(pos.qty)),
          orderType: "market",
          conversionNote: `${isTrimLocal ? "TRIM" : "EXIT"} ${pos.ticker}: sell ${isTrimLocal ? qty : pos.qty} shares — ${reason}`,
        };
        if (RH_REQUIRE_APPROVAL) {
          const pending = robinhood.queueOrder(equityOrder);
          log(acct, `RH QUEUED EXIT: ${equityOrder.conversionNote} — awaiting approval (${pending.id.slice(0, 8)})`);
        } else {
          robinhood.placeStockOrder(equityOrder.symbol, equityOrder.side, equityOrder.quantity, equityOrder.orderType)
            .then(() => log(acct, `RH EXECUTED EXIT: ${equityOrder.conversionNote}`))
            .catch(e => log(acct, `RH EXIT FAILED: ${e.message}`));
        }
      } catch (rhErr) {
        log(acct, `RH ERROR (exit): ${rhErr.message}`);
      }
    }
  }

  return trade;
}

function tryExits(acct, quotes) {
  const state = acct.state;
  const cfg = acct.config;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if (pos._pending) { remaining.push(pos); continue; } // unfilled broker order, not a holding
    if (acct.config.broker === "tradier" && pos.liveMark == null) { remaining.push(pos); continue; } // no reliable mark — hold, don't act on synthetic price
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const now = acct._simNow || Date.now();
    // Use stored Friday expiry date if available, otherwise fall back to elapsed-day calculation
    pos.dteRemaining = pos.expiryDate
      ? Math.max(0, (pos.expiryDate - now) / 86400_000)
      : Math.max(0, pos.dte - (now - pos.openTime) / 86400_000);

    const currentPremium = pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;

    if (!pos.bestPnlPct) pos.bestPnlPct = 0;
    if (pnlPct > pos.bestPnlPct) pos.bestPnlPct = pnlPct;
    if (!pos.trimLevel) pos.trimLevel = 0;
    if (!pos.originalQty) pos.originalQty = pos.qty;

    let reason = null;
    let fullClose = false;

    // Spot-based directional stop — exit if the underlying moved against us beyond a threshold,
    // independent of premium/theta. Threshold is ATR-adaptive: noisy names (AMKR/NOK ~6% ATR)
    // get a wider stop so normal intraday noise doesn't whipsaw us; calm names (UNH ~2% ATR)
    // keep the 4% floor. Formula: max(4%, 1.5 × entry-day ATR%).
    const spotMove = pos.entrySpot ? (spot - pos.entrySpot) / pos.entrySpot : 0;
    const adverseSpotMove = pos.type === "call" ? -spotMove : spotMove; // +ve = moved against us
    const atrPct = (pos.entryAtrPct || 0) / 100;
    const spotStopThreshold = Math.max(0.04, 1.5 * atrPct);
    if (adverseSpotMove >= spotStopThreshold) {
      reason = `spot stop: underlying ${pos.type === "call" ? "down" : "up"} ${(adverseSpotMove * 100).toFixed(1)}% from entry (threshold ${(spotStopThreshold * 100).toFixed(1)}%, ATR ${(atrPct * 100).toFixed(1)}%)`;
      fullClose = true;
    }
    else if (pos.dteRemaining <= CRITICAL_DTE) {
      reason = `DTE critical (${pos.dteRemaining.toFixed(1)}d remaining)`;
      fullClose = true;
    }
    // DTE-aware stop tightening: as expiration approaches, accept smaller losses to avoid
    // the "force-close at -60%" trap. At <=5 DTE, use a -20% stop instead of -35%.
    else if (pos.dteRemaining <= LOW_DTE_THRESHOLD && pnlPct <= -0.20) {
      reason = `low-DTE tight stop ${(pnlPct * 100).toFixed(0)}% (${pos.dteRemaining.toFixed(1)}d left, theta accelerating)`;
      fullClose = true;
    }
    else if (pnlPct <= cfg.stopLoss) {
      reason = `stop loss ${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    else if (pos.dteRemaining <= 1) {
      reason = "DTE expiring";
      fullClose = true;
    }
    else if (pnlPct >= cfg.profitTarget) {
      reason = `profit target +${(pnlPct * 100).toFixed(0)}%`;
      fullClose = true;
    }
    else if (pos.trimLevel === 0 && pnlPct >= cfg.trim1Pct) {
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `trim 1 (+${(pnlPct * 100).toFixed(0)}%, locking gains)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 1;
          log(acct, `TRIM STRATEGY: ${pos.ticker} — sold ${trimQty}/${pos.originalQty}, stop moved to breakeven`);
        }
      }
      remaining.push(pos);
      continue;
    }
    else if (pos.trimLevel === 1 && pnlPct >= cfg.trim2Pct) {
      const trimQty = Math.max(1, Math.floor(pos.originalQty * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `trim 2 (+${(pnlPct * 100).toFixed(0)}%, trailing EMAs)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 2;
          log(acct, `TRIM STRATEGY: ${pos.ticker} — sold ${trimQty} more, trailing with 8 EMA`);
        }
      }
      remaining.push(pos);
      continue;
    }
    else if (pos.trimLevel >= 1 && pnlPct <= 0) {
      reason = `breakeven stop (post-trim, was +${(pos.bestPnlPct * 100).toFixed(0)}%)`;
      fullClose = true;
    }
    else if (pos.trimLevel >= 2 && pnlPct <= 0.15) {
      reason = `trailing stop (post-trim2, locked +15%)`;
      fullClose = true;
    }

    if (!reason) { remaining.push(pos); continue; }

    if (fullClose) {
      const trade = closePosition(acct, pos, currentPremium, reason);
      if (trade) {
        closed.push(trade);
      } else {
        remaining.push(pos);
      }
    }
  }

  state.positions = remaining;
  state.history.push(...closed);
  return closed;
}

// ─── Signal-Based Exit ───

function trySignalExits(acct, quotes, analyses) {
  const state = acct.state;
  const cfg = acct.config;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if (pos._pending) { remaining.push(pos); continue; } // unfilled broker order, not a holding
    if (acct.config.broker === "tradier" && pos.liveMark == null) { remaining.push(pos); continue; } // no reliable mark — hold
    const a = analyses[pos.ticker];
    if (!a) { remaining.push(pos); continue; }

    let reversed = false;
    if (pos.type === "call" && a.score <= cfg.bearEntry) reversed = true;
    if (pos.type === "put" && a.score >= cfg.bullEntry) reversed = true;

    if (!reversed) { remaining.push(pos); continue; }

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type);

    const trade = closePosition(acct, pos, currentPremium, "signal reversed");
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

// ─── EOD / EOW Theta-Aware Exits ───

function tryTimeBasedExits(acct, quotes) {
  const state = acct.state;
  const et = getETDate();
  const etHour = et.getHours() + et.getMinutes() / 60;
  const isFriday = et.getDay() === 5;

  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if (pos._pending) { remaining.push(pos); continue; } // unfilled broker order, not a holding
    if (acct.config.broker === "tradier" && pos.liveMark == null) { remaining.push(pos); continue; } // no reliable mark — hold
    const q = quotes[pos.ticker];
    if (!q) { remaining.push(pos); continue; }

    const spot = q.c;
    const currentPremium = pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type);
    const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;
    let reason = null;

    if (isFriday && etHour >= EOW_TRIM_HOUR) {
      if (pnlPct >= 0.20) {
        reason = `EOW profit lock +${(pnlPct * 100).toFixed(0)}% (Fri ${etHour.toFixed(1)}h, avoid weekend theta)`;
      } else if (pos.dteRemaining <= CRITICAL_DTE) {
        reason = `EOW + low DTE (${pos.dteRemaining.toFixed(1)}d, Fri close)`;
      }
    }

    if (!reason && etHour >= EOD_TIGHTEN_HOUR) {
      if (pnlPct >= 0.10 && pos.trimLevel === 0) {
        reason = `EOD lock +${(pnlPct * 100).toFixed(0)}% (3:30 PM tighten, protecting overnight)`;
      }
    }

    if (!reason && pos.dteRemaining <= LOW_DTE_THRESHOLD && pnlPct >= 0.20) {
      reason = `low DTE accelerated exit +${(pnlPct * 100).toFixed(0)}% (${pos.dteRemaining.toFixed(1)}d left, theta accelerating)`;
    }

    if (!reason) { remaining.push(pos); continue; }

    const trade = closePosition(acct, pos, currentPremium, reason);
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

function tryEMATrailingExits(acct, quotes) {
  const state = acct.state;
  const closed = [];
  const remaining = [];

  for (const pos of state.positions) {
    if (pos._pending) { remaining.push(pos); continue; } // unfilled broker order, not a holding
    if (acct.config.broker === "tradier" && pos.liveMark == null) { remaining.push(pos); continue; } // no reliable mark — hold
    if ((pos.trimLevel || 0) < 2) { remaining.push(pos); continue; }

    const candles = acct.candleCache[pos.ticker];
    if (!candles || candles.length < 22) { remaining.push(pos); continue; }

    const closes = candles.map(d => d.c);
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const L = closes.length - 1;
    const price = closes[L];

    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const currentPremium = pos.liveMark ?? optPrice(spot, pos.strike, pos.dteRemaining, pos.iv || DEFAULT_IV, pos.type);
    let reason = null;

    const below8 = pos.type === "call" ? price < ema8[L] : price > ema8[L];
    const below21 = pos.type === "call" ? price < ema21[L] : price > ema21[L];

    if (pos.trimLevel === 2 && below8) {
      const trimQty = Math.max(1, Math.floor((pos.originalQty || pos.qty) * 0.25));
      if (trimQty > 0 && pos.qty > trimQty) {
        const trade = closePosition(acct, pos, currentPremium, `8 EMA break (trim 3, trailing 21 EMA with remainder)`, trimQty);
        if (trade) {
          closed.push(trade);
          pos.qty -= trimQty;
          pos.trimLevel = 3;
          log(acct, `EMA TRAIL: ${pos.ticker} broke 8 EMA — sold ${trimQty}, trailing 21 EMA with ${pos.qty} left`);
        }
      }
      remaining.push(pos);
      continue;
    }

    if (pos.trimLevel === 3 && below21) {
      reason = "21 EMA break (final exit per SRxTrades trail)";
    }

    if (reason) {
      const trade = closePosition(acct, pos, currentPremium, reason);
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

// ─── Dashboard State — now per-account in acct.dashboard ───

// ─── Web Dashboard ───

const DASH_PORT = parseInt(process.env.PORT) || 3000;

function dashboardHTML(acct) {
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
  const dtCount = countRecentDayTrades(state);

  // Build position details on-the-fly if no cycle has run yet
  let posSource = dashboard.positionDetails;
  if (posSource.length === 0 && state.positions.length > 0) {
    posSource = state.positions.map(pos => {
      const q = dashboard.quotes[pos.ticker];
      const spot = q ? q.c : pos.entrySpot;
      const now = Date.now();
      const dteLeft = pos.expiryDate
        ? Math.max(0, (pos.expiryDate - now) / 86400_000)
        : Math.max(0, pos.dte - (now - pos.openTime) / 86400_000);
      const curPremium = optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type);
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
        greeks: optGreeks(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type),
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
      <td><a href="/ticker/${p.ticker}"><b>${p.ticker}</b></a>${aiToggle}</td><td>${p.type.toUpperCase()}</td><td>$${p.strike}</td>
      <td style="white-space:nowrap">$${p.spot.toFixed(2)}<br><span style="color:${spotColor};font-size:10px">${spotChg >= 0 ? "+" : ""}${spotChg.toFixed(2)} (${spotChgPct >= 0 ? "+" : ""}${spotChgPct.toFixed(1)}%)</span><br><span style="color:${spotFromEntryColor};font-size:10px">from entry: ${spotFromEntry >= 0 ? "+" : ""}${spotFromEntry.toFixed(1)}%</span></td>
      <td>${p.dteLeft.toFixed(1)}d</td><td>${p.qty}</td>
      <td>$${p.entryPremium.toFixed(2)}</td><td>$${p.curPremium.toFixed(2)}</td>
      <td style="color:${color}">${p.pnlPct >= 0 ? "+" : ""}${(p.pnlPct * 100).toFixed(1)}% ($${p.pnlDollar.toFixed(0)})</td>
      <td><span style="color:#00a843">TP $${p.profitTarget.premium}</span> (${p.pctToProfit}% away)</td>
      <td><span style="color:#e8473f">SL $${p.stopLoss.premium}</span> (${p.pctToStop}% away)</td>
      <td style="font-size:10px;color:#6b7280">${p.openDate || '—'}</td>
      <td style="font-size:10px;color:#6b7280">δ${p.greeks.delta} θ${p.greeks.theta}<br>${p.pdtStatus}<br><span style="color:${p.optionsSource === 'synthetic' ? '#8a909b' : '#138f86'}" title="Source / IV used for pricing">${(p.optionsSource || 'synthetic').toUpperCase()} IV ${((p.iv || 0.30) * 100).toFixed(0)}% ${p.optionsSource === 'synthetic' ? '○' : '●'}</span>${(p.liveBid != null && p.liveAsk != null) ? `<br><span title="Live option bid/ask used for marks & fills">b $${(+p.liveBid).toFixed(2)} / a $${(+p.liveAsk).toFixed(2)}${(p.liveBid > 0 && p.liveAsk > 0) ? ` · ${(((p.liveAsk - p.liveBid) / ((p.liveAsk + p.liveBid) / 2)) * 100).toFixed(0)}% wide` : ''}</span>` : (p.optionsSource === 'tradier' && !p._pending ? `<br><span style="color:#d2691e" title="No reliable two-sided market — position is HELD, not acted on">⚠ no live mark</span>` : '')}</td>
    </tr>${aiRow}`;
  }).join("") : '<tr><td colspan="13" style="opacity:.5">No open positions</td></tr>';

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
      <td style="font-size:10px">${d.mom1d != null ? `<span style="color:${mc(+d.mom1d)}">1d:${d.mom1d}%</span> <span style="color:${mc(+d.mom3d)}">3d:${d.mom3d}%</span> <span style="color:${mc(+d.mom7d)}">7d:${d.mom7d}%</span>` : "—"}</td>
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
    return `<tr><td>${h.ticker}${aiToggle}</td><td>${h.type.toUpperCase()}</td><td>$${h.strike}</td>
      <td style="font-size:10px;color:#6b7280;white-space:nowrap">${h.openDate || '—'}<br>→ ${h.closeDate || '—'}</td>
      <td>$${h.entryPremium.toFixed(2)}</td><td>$${(h.closePremium || 0).toFixed(2)}</td>
      <td style="color:${color}">${h.pnlDollar >= 0 ? "+" : ""}$${h.pnlDollar.toFixed(0)} (${(h.pnlPct * 100).toFixed(0)}%)</td>
      <td>${h.reason || "—"}</td></tr>${aiRow}`;
  }).join("") || '<tr><td colspan="8" style="opacity:.5">No trades yet</td></tr>';

  const hints = acct.activeHints.map(h => {
    const mins = Math.round((h.expiresAt - Date.now()) / 60_000);
    return `<span class="hint">${h.ticker} ${h.bias > 0 ? "+" : ""}${h.bias} (${h.direction}, ${mins}m watch) — ${h.reasoning}</span>`;
  }).join("") || '<span style="opacity:.5">None active. Write to hint.txt to add.</span>';

  const logLines = dashboard.cycleLog.slice(-50).reverse().map(l =>
    l.replace(/\[(\d+:\d+:\d+)\]/, '<span style="color:#6b7280">[$1]</span>')
      .replace(/(TRADE:|EXIT:|HINT RECEIVED:|CLAUDE SAYS:)/g, '<b style="color:#6a4df4">$1</b>')
      .replace(/(PDT BLOCKED:)/g, '<b style="color:#e8473f">$1</b>')
      .replace(/(STRONG BUY)/g, '<span style="color:#00a843">$1</span>')
      .replace(/(AVOID)/g, '<span style="color:#e8473f">$1</span>')
  ).join("<br>");

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
${tabBarHTML(acct.id)}
${accountActionsHTML(acct.id)}
<h1>${acct.name || "Swing Trader"}</h1>
<div class="sub">$${STARTING_CASH} → $${GOAL.toLocaleString()} Challenge &nbsp;|&nbsp; <span class="market-badge ${dashboard.marketOpen ? "open" : "closed"}" id="mkt-badge">${dashboard.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</span> &nbsp;|&nbsp; <span id="live-indicator" style="color:#00a843">LIVE</span> updates every 5s &nbsp;|&nbsp; <span id="pv-header">$${pv.toFixed(0)}</span> <span id="pnl-header" style="color:${pnlPct >= 0 ? '#00a843' : '#e8473f'}">(${pnlPct >= 0 ? '+' : ''}${pnlPct}%)</span> &nbsp;|&nbsp; <span style="color:${currentRegime.mode === 'risk-on' ? '#00a843' : currentRegime.mode === 'cautious' ? '#b07400' : '#e8473f'};font-size:10px">${currentRegime.mode.toUpperCase()}</span> &nbsp;|&nbsp; <span class="llm-toggle" onclick="fetch('/api/llm-provider',{method:'POST'}).then(()=>location.reload())" title="Click to switch LLM provider">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>${acct.paused ? ' &nbsp;|&nbsp; <span style="color:#e8473f;font-weight:bold">⏸ PAUSED</span>' : ''}</div>

<div class="grid">
  <div class="card">
    <h2>Portfolio</h2>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">$${pv.toFixed(0)}</div><div class="lbl">Total Value</div></div>
    <div class="stat ${pnlPct >= 0 ? "" : "neg"}"><div class="val">${pnlPct >= 0 ? "+" : ""}${pnlPct}%</div><div class="lbl">P&L</div></div>
    <div class="stat"><div class="val">$${state.cash.toFixed(0)}</div><div class="lbl">${cfg.broker === "tradier" ? "Settled Cash" : "Cash"}</div></div>
    <div class="stat warn"><div class="val">${dtCount}/3</div><div class="lbl">PDT Used</div></div>
    ${cfg.broker === "tradier" ? `
    <div class="stat"><div class="val" style="font-size:14px;color:${(state.accountType || "") === "cash" ? "#00a843" : "#b07400"}">${(state.accountType || "?").toUpperCase()}</div><div class="lbl">Account Type</div></div>
    ${state.unsettledCash > 0 ? `<div class="stat"><div class="val" style="font-size:14px;color:#b07400">$${state.unsettledCash.toFixed(0)}</div><div class="lbl">Unsettled (T+1)</div></div>` : ""}
    ${state.reservedBuyingPower > 0 ? `<div class="stat"><div class="val" style="font-size:14px;color:#d2691e">$${state.reservedBuyingPower.toFixed(0)}</div><div class="lbl">Reserved (working orders)</div></div>` : ""}
    ${(state.accountType && state.accountType !== "cash") ? `<div style="font-size:11px;color:#b07400;margin-top:6px">⚠️ This is a ${state.accountType.toUpperCase()} account — PDT &amp; margin/leverage apply. You wanted a cash account.</div>` : ""}` : ""}
    <div class="progress"><div class="progress-bar" style="width:${Math.min(100, progress)}%"></div></div>
    <div style="font-size:11px;color:#6b7280">${progress}% to $${GOAL.toLocaleString()} goal</div>
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
    <form class="hint-form" method="POST" action="/hint?a=${acct.id}">
      <input name="hint" placeholder='Ask anything: "should I buy NVDA?" or "watch PLTR bullish"' autocomplete="off">
      <button type="submit">Ask AI</button>
    </form>
    <div style="color:#aab0bb;font-size:10px;margin-top:4px">Ask questions or give directives · Watches expire in 4h</div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Open Positions (${state.positions.length})</h2>
  <table><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Stock Price</th><th>DTE</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L</th><th>Profit Target</th><th>Stop Loss</th><th>Opened</th><th>Greeks / PDT</th></tr>${posRows}</table>
</div>

<div class="card" style="margin-bottom:16px" id="bot-thinking-card">
  <h2 style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:0" onclick="toggleBotThinking()">
    <span>Bot Thinking — Decision Reasoning <span style="color:#aab0bb;font-weight:400;text-transform:none;font-size:10px;letter-spacing:0">(${dashboard.decisions.length} tickers)</span></span>
    <span id="bot-thinking-caret" style="color:#6b7280;font-size:14px;font-weight:400">▾</span>
  </h2>
  <div id="bot-thinking-body" style="margin-top:12px">
    <div style="font-size:10px;color:#8a909b;margin-bottom:8px">Score 50=neutral · ≥${BULL_ENTRY} buy calls · ≤${BEAR_ENTRY} buy puts · Risk: ${(RISK_PCT * 100)}%/trade · TP: +${(PROFIT_TARGET * 100)}% · SL: ${(STOP_LOSS * 100)}%</div>
    <table><tr><th>Ticker</th><th>Price</th><th>Score (7d/90d→blend→final)</th><th>Decision</th><th>Reasoning</th><th>EMAs (8/21/50)</th><th>7d EMAs (3/5/8)</th><th>Indicators</th><th>Momentum</th></tr>${decisionRows}</table>
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
      const pnl = ((d.pv - ${STARTING_CASH}) / ${STARTING_CASH} * 100).toFixed(1);
      pnlEl.textContent = '(' + (pnl >= 0 ? '+' : '') + pnl + '%)';
      pnlEl.style.color = pnl >= 0 ? '#00a843' : '#e8473f';
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

function tickerDetailHTML(sym, acct) {
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

  // Helper: build SVG candlestick chart from a set of candles with EMA overlays
  function buildChart(cdata, emas, W, H) {
    if (!cdata || cdata.length < 3) return { chart: '<div style="color:#8a909b">No data</div>', volume: '' };
    const cls = cdata.map(c => c.c), hs = cdata.map(c => c.h), ls = cdata.map(c => c.l), vs = cdata.map(c => c.v);
    const emaLines = emas.map(e => ({ data: calcEMA(cls, e.period), color: e.color, label: e.label }));
    const allP = [...hs, ...ls];
    const mn = Math.min(...allP) * 0.998, mx = Math.max(...allP) * 1.002, rng = mx - mn;
    const y = v => H - ((v - mn) / rng) * (H - 20) - 10;
    const x = i => (i / Math.max(1, cls.length - 1)) * W;

    const bars = cdata.map((c, i) => {
      const green = c.c >= c.o;
      const color = green ? "#00a843" : "#e8473f";
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
      `<text x="${W + 5}" y="${y(p)}" fill="#8a909b" font-size="9" dominant-baseline="middle">$${p.toFixed(2)}</text>`
    ).join("");

    const legend = emaLines.map(e =>
      `<span style="color:${e.color}">\u2501 ${e.label} (${e.data[e.data.length - 1].toFixed(2)})</span>`
    ).join(" &nbsp; ");

    const chart = `<svg viewBox="0 0 ${W + 60} ${H}" style="width:100%;height:${H}px">
      ${bars}${emaPaths}${pLabels}
    </svg>
    <div style="font-size:10px;margin-top:4px;color:#6b7280">${legend}</div>`;

    const maxV = Math.max(...vs);
    const avgV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const VH = 60;
    const volBars = vs.map((v, i) => {
      const bw = Math.max(3, W / vs.length - 1);
      const h = (v / maxV) * VH;
      return `<rect x="${x(i) - bw / 2}" y="${VH - h}" width="${bw}" height="${h}" fill="${v > avgV * 1.15 ? '#00a8433a' : '#00000016'}" rx="0.5"/>`;
    }).join("");
    const volume = `<svg viewBox="0 0 ${W + 60} ${VH}" style="width:100%;height:${VH}px">
      <line x1="0" y1="${VH - (avgV / maxV) * VH}" x2="${W}" y2="${VH - (avgV / maxV) * VH}" stroke="#00000014" stroke-dasharray="3 2"/>
      ${volBars}
    </svg>`;

    return { chart, volume };
  }

  // 90-day chart with EMA 8/21/50
  const longChart = buildChart(candles, [
    { period: 8, color: "#138f86", label: "EMA 8" },
    { period: 21, color: "#d2691e", label: "EMA 21" },
    { period: 50, color: "#6a4df4", label: "EMA 50" },
  ], 700, 250);

  // 7-day chart (last 14 candles) with EMA 3/5/8
  const shortCandles = candles ? candles.slice(-14) : null;
  const shortChart = buildChart(shortCandles, [
    { period: 3, color: "#0a8fb8", label: "EMA 3" },
    { period: 5, color: "#b07400", label: "EMA 5" },
    { period: 8, color: "#d6336c", label: "EMA 8" },
  ], 700, 250);

  const chartSVG = longChart.chart;
  const volumeSVG = longChart.volume;

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
      <div class="stat"><div class="val">${pos.type.toUpperCase()}</div><div class="lbl">Type</div></div>
      <div class="stat"><div class="val">$${pos.strike}</div><div class="lbl">Strike</div></div>
      <div class="stat"><div class="val">${pos.qty}</div><div class="lbl">Contracts</div></div>
      <div class="stat"><div class="val">${pos.dteLeft.toFixed(1)}d</div><div class="lbl">DTE Left</div></div>
      <hr style="border-color:#e3e6ea;margin:12px 0">
      <div class="stat"><div class="val">$${pos.spot.toFixed(2)}</div><div class="lbl">Stock Price</div></div>
      <div class="stat"><div class="val" style="color:${posSpotColor}">${posSpotChg >= 0 ? "+" : ""}${posSpotChg.toFixed(2)} (${posSpotChgPct >= 0 ? "+" : ""}${posSpotChgPct.toFixed(1)}%)</div><div class="lbl">Today's Move</div></div>
      <div class="stat"><div class="val">$${pos.entrySpot.toFixed(2)}</div><div class="lbl">Entry Stock Price</div></div>
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
      <div class="stat"><div class="val">${pos.pdtStatus}</div><div class="lbl">PDT Status</div></div>`;
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
</style></head><body>
<h1><a href="/">← Back</a> &nbsp; ${sym} ${q ? '$' + q.c.toFixed(2) : ''}
${q ? `<span style="font-size:13px;color:${q.d >= 0 ? '#00a843' : '#e8473f'}">${q.d >= 0 ? '+' : ''}${q.d?.toFixed(2)} (${q.dp?.toFixed(2)}%)</span>` : ''}</h1>
<div class="sub">${pos ? pos.type.toUpperCase() + ' $' + pos.strike + ' | ' + pos.qty + ' contracts' : 'Not currently held'} &nbsp;|&nbsp; Auto-refreshes every 30s
${q?.t ? ` &nbsp;|&nbsp; Last: ${new Date(q.t * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ''}</div>

<div class="card" style="margin-bottom:16px;border-color:#0a8fb840">
  <h2 style="color:#0a8fb8">7-Day Chart (Contract Window) — Fast EMAs 3/5/8</h2>
  ${shortChart.chart}
  <div style="margin-top:8px">${shortChart.volume}</div>
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

<div class="card" style="margin-bottom:16px">
  <h2>90-Day Chart — EMAs 8/21/50</h2>
  ${chartSVG}
  <div style="margin-top:8px">${volumeSVG || '<div style="color:#8a909b">No volume data</div>'}</div>
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
  <form method="POST" action="/api/ticker/${sym}/analyze?a=${acct.id}" style="display:flex;gap:8px;margin-top:4px">
    <input name="question" placeholder='e.g. "Should I enter now?" or "What are the key risks?"'
      style="flex:1;background:#f6f7f9;border:1px solid #6a4df440;color:#23242a;padding:8px 12px;border-radius:4px;font-family:inherit;font-size:12px">
    <button type="submit" style="background:#6a4df4;color:#000;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:700;font-size:12px;white-space:nowrap">Ask Claude</button>
  </form>
  <div style="color:#aab0bb;font-size:10px;margin-top:6px">Leave blank for a full setup analysis · Uses Claude Haiku</div>
</div>

</body></html>`;
}

// ─── Robinhood Page (PIN-protected) ───

function robinhoodPageHTML() {
  const connected = robinhood.isConnected;
  const pending = robinhood.pendingOrders;

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
      <div class="rh-stat"><span class="label">Trading Mode</span><span class="value" style="color:${TRADING_MODE === 'robinhood' ? '#00a843' : '#6b7280'}">${TRADING_MODE.toUpperCase()}</span></div>
      <div style="margin-top:12px">
        <input type="password" class="rh-input" id="rh-token" placeholder="Paste access token..." style="margin-bottom:8px">
        <div style="display:flex;gap:8px">
          <button class="rh-btn primary" onclick="connectRH()">Connect</button>
          <button class="rh-btn danger" onclick="disconnectRH()">Disconnect</button>
        </div>
      </div>
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

    <!-- Pending Orders -->
    <div class="rh-card">
      <h2>⏳ Pending Orders <span style="color:#6b7280;font-weight:400;font-size:11px">(${pending.length})</span></h2>
      <div id="pending-list">
        ${pending.length === 0 ? '<div class="rh-empty">No pending orders</div>' : pending.map(o => `
          <div class="rh-pending-item">
            <div>
              <div class="sym">${o.side?.toUpperCase()} ${o.quantity} ${o.symbol}</div>
              <div class="detail">${o.conversionNote || ''} · ${new Date(o.createdAt).toLocaleTimeString()}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="rh-btn primary small" onclick="approveOrder('${o.id}')">✓</button>
              <button class="rh-btn danger small" onclick="rejectOrder('${o.id}')">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Trading Controls -->
    <div class="rh-card">
      <h2>⚙️ Controls</h2>
      <div class="rh-toggle">
        <label>Trading Mode</label>
        <div class="switch ${TRADING_MODE === 'robinhood' ? 'on' : ''}" onclick="toggleMode()" title="${TRADING_MODE === 'robinhood' ? 'Click to switch to PAPER' : 'Click to switch to ROBINHOOD'}"></div>
        <span style="font-size:11px;color:${TRADING_MODE === 'robinhood' ? '#00a843' : '#6b7280'};min-width:80px">${TRADING_MODE.toUpperCase()}</span>
      </div>
      <div class="rh-toggle">
        <label>Require Approval</label>
        <div class="switch ${RH_REQUIRE_APPROVAL ? 'on' : ''}" onclick="toggleApproval()" title="${RH_REQUIRE_APPROVAL ? 'Manual approval ON' : 'Auto-execution ON'}"></div>
        <span style="font-size:11px;color:${RH_REQUIRE_APPROVAL ? '#00a843' : '#b07400'};min-width:80px">${RH_REQUIRE_APPROVAL ? 'MANUAL' : 'AUTO'}</span>
      </div>
      <div class="rh-stat"><span class="label">Max Position</span><span class="value">$${RH_MAX_POSITION_DOLLARS}</span></div>
      <div style="margin-top:12px">
        <button class="rh-btn danger" onclick="killSwitch()" style="width:100%">🛑 Cancel All Pending</button>
      </div>
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
        html += '<tr><td style="color:#1c1d22;font-weight:600">'+p.symbol+'</td><td>'+p.quantity+'</td><td>$'+(p.average_cost||'?')+'</td><td>$'+(p.current_price||'?')+'</td><td style="color:'+color+'">'+pnl+'</td></tr>';
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
  if (!token) { alert('Enter a token first'); return; }
  try {
    const r = await fetch('/api/rh-token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'token='+encodeURIComponent(token) });
    const d = await r.json();
    alert(d.message || d.error || 'Done');
    location.reload();
  } catch(e) { alert('Error: '+e.message); }
}

function disconnectRH() {
  if (!confirm('Disconnect from Robinhood? This will clear your token.')) return;
  fetch('/api/rh-token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'token=' }).then(()=>location.reload());
}

async function toggleMode() {
  await fetch('/api/trading-mode', { method: 'POST' });
  location.reload();
}

async function toggleApproval() {
  await fetch('/api/rh-approval', { method: 'POST' });
  location.reload();
}

async function approveOrder(id) {
  await fetch('/api/rh-approve/'+id, { method: 'POST' });
  location.reload();
}

async function rejectOrder(id) {
  await fetch('/api/rh-reject/'+id, { method: 'POST' });
  location.reload();
}

async function killSwitch() {
  if (!confirm('Cancel ALL pending orders?')) return;
  const status = await fetch('/api/rh-status').then(r=>r.json());
  for (const o of (status.pendingOrders || [])) {
    await fetch('/api/rh-reject/'+o.id, { method: 'POST' });
  }
  location.reload();
}

// Auto-refresh every 30s
setInterval(() => { loadAccount(); loadPositions(); loadOrders(); }, 30000);
</script>
</body></html>`;
}

// ─── Tab Bar HTML ───

function tabBarHTML(activeId) {
  let totalPV = 0;
  const tabs = [];
  for (const [id, acct] of accounts) {
    const pv = portfolioValue(acct.state, acct.dashboard.quotes);
    totalPV += pv;
    const pnl = ((pv - acct.config.startingCash) / acct.config.startingCash * 100).toFixed(1);
    const color = pnl >= 0 ? "#00a843" : "#e8473f";
    const isActive = id === activeId;
    const statusDot = acct.paused ? "🔴" : "🟢";
    const liveBadge = acct.config.broker === "tradier"
      ? `<span class="tab-live" style="background:#00a8431c;color:#00a843;border:1px solid #00a84340;border-radius:4px;padding:0 4px;font-size:9px;font-weight:bold;margin-left:4px">LIVE</span>`
      : "";
    tabs.push(`<a href="/?a=${id}" class="acct-tab ${isActive ? "active" : ""}" title="${acct.name}${acct.config.broker === "tradier" ? " — LIVE Tradier account" : ""}">
      <span class="tab-status">${statusDot}</span>
      <span class="tab-name">${acct.name}</span>${liveBadge}
      <span class="tab-pv">$${pv.toFixed(0)}</span>
      <span class="tab-pnl" style="color:${color}">${pnl >= 0 ? "+" : ""}${pnl}%</span>
    </a>`);
  }
  return `<div class="tab-bar">
  <div class="tab-row">${tabs.join("")}
    <a href="#" class="acct-tab new-tab" onclick="document.getElementById('acct-modal').style.display='flex';return false">+ New Account</a>
    <a href="/?sim=new" class="acct-tab new-tab" style="border-color:#6a4df440;color:#6a4df4">&#x1F9EA; Simulator</a>
    <a href="/robinhood" class="acct-tab new-tab" style="border-color:#00a84330;color:#00a843">🔒 Robinhood</a>
    <a href="/tradier" class="acct-tab new-tab" style="border-color:#2f6fed40;color:#2f6fed">📈 Tradier</a>
  </div>
  <div class="global-stats">
    <span>Total PV: <b>$${totalPV.toFixed(0)}</b></span>
    <span class="llm-toggle" onclick="fetch('/api/llm-provider',{method:'POST'}).then(()=>location.reload())" title="Click to switch LLM provider">🤖 ${getLLMLabel()}: ${claudeCallCount} calls · $${getClaudeCost().toFixed(3)}</span>
    <span>${accounts.size} account${accounts.size !== 1 ? "s" : ""}</span>
  </div>
</div>

<!-- Account Management Modal -->
<div id="acct-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center">
  <div style="background:#ffffff;border:1px solid #d4d8e0;border-radius:12px;padding:24px;max-width:420px;width:90%">
    <h2 style="margin:0 0 16px;color:#1c1d22">New Account</h2>
    <form method="POST" action="/api/accounts">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Account Name</label>
      <input name="name" value="Strategy 2" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Starting Cash ($)</label>
      <input name="startingCash" type="number" value="200" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Risk per Trade (%)</label>
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
      <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Broker (execution)</label>
      <select name="broker" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <option value="paper">Paper (simulated)</option>
        <option value="tradier">Tradier (LIVE — real money)</option>
      </select>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="useCashReserve" checked> Use cash reserve (50%→25% buffer)</label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="autoExecute"> Auto-execute broker orders (full autonomy)</label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;color:#3a3b42"><input type="checkbox" name="tradeWhenClosed"> Trade when market closed (testing/sandbox)</label>
      <div style="display:flex;gap:8px">
        <button type="submit" style="flex:1;padding:10px;background:#00a843;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Create Account</button>
        <button type="button" onclick="document.getElementById('acct-modal').style.display='none'" style="flex:1;padding:10px;background:#d4d8e0;color:#1c1d22;border:none;border-radius:6px;cursor:pointer">Cancel</button>
      </div>
    </form>
  </div>
</div>`;
}

function accountActionsHTML(acctId) {
  const acct = accounts.get(acctId);
  if (!acct) return "";
  const cfg = acct.config;
  return `<div class="acct-actions">
    <button type="button" class="acct-btn edit" onclick="document.getElementById('edit-modal').style.display='flex'">⚙ Settings</button>
    <form method="POST" action="/api/accounts/${acctId}/pause" style="display:inline">
      <button type="submit" class="acct-btn ${acct.paused ? "resume" : "pause"}">${acct.paused ? "▶ Resume" : "⏸ Pause"}</button>
    </form>
    <button type="button" class="acct-btn" id="push-btn" onclick="togglePush()" title="Toggle push notifications on this device">🔔 Notify</button>
    ${acctId !== "default" ? `<form method="POST" action="/api/accounts/${acctId}/delete" style="display:inline" onsubmit="return confirm('Delete account ${acct.name}? This cannot be undone.')">
      <button type="submit" class="acct-btn delete">🗑 Delete</button>
    </form>` : ""}
  </div>
  <div id="edit-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center">
    <div style="background:#ffffff;border:1px solid #d4d8e0;border-radius:12px;padding:24px;max-width:420px;width:90%">
      <h2 style="margin:0 0 16px;color:#1c1d22">Settings: ${acct.name}</h2>
      <form method="POST" action="/api/accounts/${acctId}/config">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Risk per Trade (%)</label>
        <input name="baseRiskPct" type="number" step="0.01" value="${(cfg.baseRiskPct * 100).toFixed(1)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Profit Target (%)</label>
        <input name="profitTarget" type="number" step="1" value="${(cfg.profitTarget * 100).toFixed(0)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Stop Loss (%)</label>
        <input name="stopLoss" type="number" step="1" value="${(cfg.stopLoss * 100).toFixed(0)}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Goal ($)</label>
        <input name="goal" type="number" value="${cfg.goal}" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Max Positions (blank = unlimited)</label>
        <input name="maxPositions" type="number" value="${cfg.maxPositions || ""}" placeholder="unlimited" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Min Setup Quality (0=trade anything, 50=default, 100=perfect setups only)</label>
        <input name="minSetupQuality" type="number" value="${cfg.minSetupQuality ?? 50}" min="0" max="100" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:12px;box-sizing:border-box">
        <label style="display:block;margin-bottom:8px;font-size:12px;color:#6b7280">Custom Prompt Suffix</label>
        <input name="customPromptSuffix" value="${(cfg.customPromptSuffix || "").replace(/"/g, "&quot;")}" placeholder="e.g. Focus on tech sector only" style="width:100%;padding:8px;background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;margin-bottom:16px;box-sizing:border-box">
        <input type="hidden" name="configForm" value="1">
        <div style="border-top:1px solid #e3e6ea;margin:4px 0 14px;padding-top:14px">
          <div style="font-size:12px;color:#6b7280;margin-bottom:10px">Broker: <strong style="color:${cfg.broker === "tradier" ? "#00a843" : "#6b7280"}">${(cfg.broker || "paper").toUpperCase()}${cfg.broker === "tradier" ? " · LIVE" : ""}</strong></div>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="useCashReserve" ${cfg.useCashReserve ? "checked" : ""}> Use cash reserve (50%→25% buffer)</label>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:#3a3b42"><input type="checkbox" name="autoExecute" ${cfg.autoExecute ? "checked" : ""}> Auto-execute broker orders (full autonomy)</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#3a3b42"><input type="checkbox" name="tradeWhenClosed" ${cfg.tradeWhenClosed ? "checked" : ""}> Trade when market closed (testing/sandbox)</label>
          ${cfg.broker === "tradier" ? `<p style="font-size:11px;color:#b07400;margin:10px 0 0">⚠ LIVE account — orders execute with real money. Use <strong>Pause</strong> as the kill switch (blocks new entries; exits still run to protect open positions).</p>` : ""}
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

function tradierPageHTML() {
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
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select id="env" style="background:#f6f7f9;border:1px solid #d4d8e0;border-radius:6px;color:#1c1d22;padding:9px">
        <option value="sandbox">sandbox</option>
        <option value="production">production</option>
      </select>
      <input id="token" placeholder="Paste Tradier access token (optional)" style="flex:1;min-width:200px">
      <button onclick="saveToken()">Save &amp; Connect</button>
      <button onclick="reconnect()" style="background:#5457e6">Reconnect</button>
      <button onclick="cancelAllOrders()" style="background:#e8473f">Cancel All Orders</button>
    </div>
    <div class="muted" style="font-size:11px;margin-top:8px">Leave the token blank to reconnect using the <code>TRADIER_ACCESS_TOKEN</code> env var. A token entered here is stored on the server (tradier_tokens.json).</div>
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
      stat('Settled Cash (BP)', fmt(bi.settledCash)) +
      stat('Unsettled (T+1)', fmt(bi.unsettledCash)) +
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
      maxPositions: c.maxPositions || 5,
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
      <div><label>Risk per Trade (%)</label><input type="number" name="baseRiskPct" value="${v.baseRiskPct}" step="1"></div>
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
          const pw = new URLSearchParams(body).get("password") || "";
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
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `acct-${Date.now()}`;
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
          broker: ["paper", "tradier", "robinhood"].includes(params.get("broker")) ? params.get("broker") : "paper",
          useCashReserve: params.get("useCashReserve") === "on" || params.get("useCashReserve") === "true",
          autoExecute: params.get("autoExecute") === "on" || params.get("autoExecute") === "true",
          tradeWhenClosed: params.get("tradeWhenClosed") === "on" || params.get("tradeWhenClosed") === "true",
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
      if (target) { target.paused = !target.paused; saveAccounts(); console.log(`  [${id}] ${target.paused ? "Paused" : "Resumed"}`); }
      res.writeHead(302, { Location: `/?a=${id}` });
      res.end();
      return;
    }

    const delMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/delete$/);
    if (req.method === "POST" && delMatch) {
      const id = delMatch[1];
      if (id !== "default" && accounts.has(id)) { accounts.delete(id); saveAccounts(); console.log(`  [${id}] Deleted`); }
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
        if (params.has("baseRiskPct")) cfg.baseRiskPct = parseFloat(params.get("baseRiskPct")) / 100;
        if (params.has("profitTarget")) cfg.profitTarget = parseFloat(params.get("profitTarget")) / 100;
        if (params.has("stopLoss")) cfg.stopLoss = parseFloat(params.get("stopLoss")) / 100;
        if (params.has("goal")) cfg.goal = parseFloat(params.get("goal")) || cfg.goal;
        if (params.get("maxPositions")) cfg.maxPositions = parseInt(params.get("maxPositions")) || null;
        else cfg.maxPositions = null;
        if (params.has("minSetupQuality")) cfg.minSetupQuality = parseInt(params.get("minSetupQuality")) ?? 50;
        cfg.customPromptSuffix = params.get("customPromptSuffix") || "";
        // Broker binding + live-trading toggles. Checkboxes only POST when checked.
        if (params.has("broker") && ["paper", "tradier", "robinhood"].includes(params.get("broker"))) cfg.broker = params.get("broker");
        if (params.has("configForm")) {
          cfg.useCashReserve = params.get("useCashReserve") === "on" || params.get("useCashReserve") === "true";
          cfg.autoExecute = params.get("autoExecute") === "on" || params.get("autoExecute") === "true";
          cfg.tradeWhenClosed = params.get("tradeWhenClosed") === "on" || params.get("tradeWhenClosed") === "true";
        }
        target.riskPct = cfg.baseRiskPct * (target.currentRegime?.riskScale || 0.5);
        saveAccounts();
        console.log(`  [${id}] Config updated: risk=${(cfg.baseRiskPct * 100).toFixed(1)}% target=${(cfg.profitTarget * 100)}% stop=${(cfg.stopLoss * 100)}% minQuality=${cfg.minSetupQuality}`);
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
        list.push({ id, name: a.name, paused: a.paused, cash: a.state.cash, positions: a.state.positions.length, trades: a.state.history.length, pv, pnl: ((pv - a.config.startingCash) / a.config.startingCash * 100).toFixed(1), config: a.config });
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

    // ─── Trading Mode Toggle ───
    if (req.method === "POST" && pathname === "/api/trading-mode") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const requested = params.get("mode");
        if (requested === "paper" || requested === "robinhood") {
          TRADING_MODE = requested;
        } else {
          TRADING_MODE = TRADING_MODE === "paper" ? "robinhood" : "paper";
        }
        console.log(`  Trading Mode switched to: ${TRADING_MODE.toUpperCase()}`);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ mode: TRADING_MODE, connected: robinhood.isConnected }));
      });
      return;
    }

    // ─── Robinhood: Toggle Approval Mode ───
    if (req.method === "POST" && pathname === "/api/rh-approval") {
      RH_REQUIRE_APPROVAL = !RH_REQUIRE_APPROVAL;
      console.log(`  RH Approval Mode: ${RH_REQUIRE_APPROVAL ? "ON (manual)" : "OFF (auto)"}`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ requireApproval: RH_REQUIRE_APPROVAL }));
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
        balanceInfo: brokerBalanceInfo(balances),
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

    // ─── Robinhood: Get Status & Pending Orders ───
    if (pathname === "/api/rh-status") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        mode: TRADING_MODE,
        connected: robinhood.isConnected,
        authenticated: robinhood.isAuthenticated,
        requireApproval: RH_REQUIRE_APPROVAL,
        maxPositionDollars: RH_MAX_POSITION_DOLLARS,
        pendingOrders: robinhood.pendingOrders,
      }));
      return;
    }

    // ─── Robinhood: Approve Pending Order ───
    if (req.method === "POST" && pathname.startsWith("/api/rh-approve/")) {
      const orderId = pathname.split("/api/rh-approve/")[1];
      try {
        const result = await robinhood.approveOrder(orderId);
        console.log(`  RH Order ${orderId.slice(0, 8)} APPROVED → ${result.status}`);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Reject Pending Order ───
    if (req.method === "POST" && pathname.startsWith("/api/rh-reject/")) {
      const orderId = pathname.split("/api/rh-reject/")[1];
      try {
        const result = robinhood.rejectOrder(orderId);
        console.log(`  RH Order ${orderId.slice(0, 8)} REJECTED`);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Get Portfolio (real positions) ───
    if (pathname === "/api/rh-portfolio") {
      try {
        const portfolio = await robinhood.getPortfolio();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(portfolio));
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
        const token = params.get("token");
        if (token) {
          robinhood.setToken(token);
          const connected = await robinhood.init();
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ connected, message: connected ? "Robinhood connected!" : "Token saved but MCP init failed" }));
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
            if (result) applyHintResult(activeAcct, result, hintText);
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
      res.end(tickerDetailHTML(sym, activeAcct));
      return;
    }

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ cash: state.cash, positions: state.positions, history: state.history.slice(-50), dayTrades: state.dayTrades, quotes: dashboard.quotes, analyses: Object.fromEntries(Object.entries(dashboard.analyses).map(([k, v]) => [k, { score: v.score, signal: v.signal, price: v.price, rsi: v.rsi }])), activeHints: activeAcct.activeHints, portfolioValue: portfolioValue(state, dashboard.quotes), marketOpen: dashboard.marketOpen, log: dashboard.cycleLog.slice(-50) }));
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
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const tickers = {};
      for (const [sym, q] of Object.entries(dashboard.quotes)) {
        const a = dashboard.analyses[sym]; const st = dashboard.shortTermAnalyses[sym];
        const pos = state.positions.find(p => p.ticker === sym);
        let posPnl = null;
        if (pos) { const spot = q ? q.c : pos.entrySpot; const _now = Date.now(); const dteLeft = pos.expiryDate ? Math.max(0, (pos.expiryDate - _now) / 86400_000) : Math.max(0, pos.dte - (_now - pos.openTime) / 86400_000); const curPremium = optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type); posPnl = { pct: ((curPremium - pos.entryPremium) / pos.entryPremium * 100).toFixed(1), dollar: ((curPremium - pos.entryPremium) * pos.qty * 100).toFixed(0) }; }
        tickers[sym] = { c: q.c, pc: q.pc, d: q.d, dp: q.dp, h: q.h, l: q.l, score: a?.score, signal: a?.signal, stScore: st?.score, mom1d: st?.mom1d, mom3d: st?.mom3d, mom7d: st?.mom7d, held: !!pos, type: pos?.type, posPnl };
      }
      res.end(JSON.stringify({ tickers, pv: portfolioValue(state, dashboard.quotes), cash: state.cash, open: state.positions.length, marketOpen: dashboard.marketOpen, lastCycle: dashboard.lastCycle }));
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
          maxPositions: parseInt(params.get("maxPositions")) || 5,
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
      try {
        const acctInfo = await robinhood.getAccount();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(acctInfo));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Get Options Chain ───
    if (pathname === "/api/rh-options") {
      const sym = url.searchParams.get("symbol");
      if (!sym) { res.writeHead(400); res.end(JSON.stringify({ error: "symbol required" })); return; }
      try {
        const options = await robinhood.getOptions(sym);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(options));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ─── Robinhood: Get Orders ───
    if (pathname === "/api/rh-orders") {
      try {
        const orders = await robinhood.getOrders();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(orders));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: e.message }));
      }
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
      res.end(robinhoodPageHTML());
      return;
    }

    // ─── Tradier Page ───
    if (pathname === "/tradier") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(tradierPageHTML());
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
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHTML(activeAcct));
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

  // Fetch quotes once for all tickers
  for (const ticker of tickerList) {
    try {
      sharedQuotes[ticker] = await fetchQuote(ticker, apiKey);
      await delay(API_DELAY);
    } catch (e) { }
  }

  // Fetch candles for tickers not already cached
  for (const ticker of tickerList) {
    if (!sharedCandleCache[ticker]) {
      try {
        sharedCandleCache[ticker] = await fetchCandles(ticker, apiKey);
        await delay(API_DELAY);
      } catch (e) { }
    } else if (sharedQuotes[ticker]) {
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

// Extract usable cash from a Tradier balances object. Account type varies (cash / margin / pdt),
// so the buying-power field lives in different places. Prefer option buying power when present.
// Parse a Tradier balances object into the figures the bot trades on. The guiding rule for a CASH
// account is: only ever deploy SETTLED cash (cash_available), never unsettled proceeds — that is
// exactly what prevents Good-Faith Violations. We also surface account type + unsettled funds so
// the dashboard can show them and warn if the account isn't actually a cash account.
function brokerBalanceInfo(bal) {
  if (!bal) return null;
  const num = v => (typeof v === "number" && !Number.isNaN(v)) ? v : null;
  const accountType = String(bal.account_type || (bal.cash ? "cash" : bal.margin ? "margin" : "")).toLowerCase() || "unknown";
  const unsettledCash = num(bal.cash?.unsettled_funds) ?? 0;

  let settledCash;
  if (accountType === "cash") {
    // cash_available is settled buying power; total_cash includes unsettled, so prefer the former.
    settledCash = num(bal.cash?.cash_available) ?? num(bal.cash_available) ?? num(bal.total_cash);
  } else {
    // Margin/unknown: long options can't be bought on margin, so option_buying_power ≈ usable cash.
    settledCash = num(bal.margin?.option_buying_power) ?? num(bal.option_buying_power) ?? num(bal.cash?.cash_available) ?? num(bal.total_cash);
  }

  return {
    accountType,
    buyingPower: settledCash,   // what the bot is allowed to deploy (settled only)
    settledCash,
    unsettledCash,
    totalCash: num(bal.total_cash),
    totalEquity: num(bal.total_equity),
  };
}

function brokerCashFromBalances(bal) {
  const info = brokerBalanceInfo(bal);
  return info ? info.buyingPower : null;
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
    if (acct.config.autoExecute === undefined) acct.config.autoExecute = true;
    if (acct.config.tradeWhenClosed === undefined) acct.config.tradeWhenClosed = tradier.environment === "sandbox";

    // Detect environment change (sandbox ↔ production) and update the account accordingly.
    const expectedName = `Tradier Live (${tradier.environment})`;
    const envChanged = acct.name !== expectedName;
    if (envChanged) {
      console.log(`  Tradier: environment changed → ${tradier.environment} — resetting account`);
      acct.name = expectedName;
      // Reset starting cash to real balance so P&L tracks from the correct base.
      if (typeof seedCash === "number") acct.config.startingCash = seedCash;
      // Production: disable trade-when-closed (live money). Sandbox: enable for testing.
      acct.config.tradeWhenClosed = tradier.environment === "sandbox";
      // Clear sandbox positions/history — production positions come from the real broker.
      acct.state.positions = [];
      acct.state.history = [];
      acct.state.meta = {};
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
    autoExecute: true,     // full autonomy (Pause remains the kill switch)
    // Sandbox accounts trade when closed by default so you can test execution outside market hours.
    tradeWhenClosed: tradier.environment === "sandbox",
    startingCash: typeof seedCash === "number" ? seedCash : DEFAULT_CONFIG.startingCash,
  };
  const state = {
    cash: typeof seedCash === "number" ? seedCash : DEFAULT_CONFIG.startingCash,
    positions: [],
    history: [],
    dayTrades: [],
    meta: {},
  };
  const acct = createAccountRuntime("tradier", `Tradier Live (${tradier.environment})`, config, state);
  accounts.set("tradier", acct);
  saveAccounts();
  console.log(`  Tradier: provisioned LIVE account ✓ — seeded cash $${state.cash.toFixed(2)} (${tradier.environment}), autoExecute ON`);
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
        const qty = Math.round(Math.abs(o.quantity || o.remaining_quantity || 0));
        const price = o.price ?? o.avg_fill_price ?? null;
        return {
          id: o.id,
          status: (o.status || "").toLowerCase(),
          side: (o.side || "").toLowerCase(),
          occ,
          ticker: parsed ? parsed.ticker : occ.toUpperCase(),
          parsed,
          qty,
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
async function placeBrokerEntry(acct, { ticker, type, strike, expiryDate, dte, qty, premium, direction, bid = null, ask = null, setupQuality = 0, claudeConfidence = 0, aiThesis = null }) {
  const expStr = new Date(expiryDate).toISOString().slice(0, 10);
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

  // Seed metadata so the post-fill sync keeps entry context (stops/trails depend on it).
  if (!acct.state.meta) acct.state.meta = {};
  acct.state.meta[occ] = {
    entryPremium: +premium.toFixed(2),
    entrySpot: acct.dashboard?.quotes?.[ticker]?.c ?? null,
    dte,
    originalQty: qty,
    openDate: getETDateStr(),
    openTime: Date.now(),
    trimLevel: 0,
    bestPnlPct: 0,
    entryAtrPct: acct.dashboard?.analyses?.[ticker]?.atrPct ?? null,
    setupQuality,
    // Persist the full AI thought process so it survives the broker round-trip and shows up on the
    // live position (and later in trade history) exactly like paper trades.
    ai: aiThesis || null,
  };

  try {
    // Conviction-/PDT-aware fill: high conviction + low PDT risk → price toward the ask to fill;
    // otherwise sit at the mid. Falls back to mid when we don't have a real bid/ask.
    const conviction = Math.max(0, Math.min(1, (claudeConfidence || 0) / 100));
    const lowPdt = pdtRiskLow(acct.state);
    const limit = entryLimitPrice(bid, ask, premium, conviction, lowPdt);
    const aggrLabel = limit >= (ask || limit) ? "at ask" : limit > premium ? "toward ask" : "at mid";
    const res = await tradier.placeOptionOrder(ticker, expStr, type, strike, "buy_to_open", qty, "limit", limit);
    // Mark this underlying in-flight so the rest of THIS cycle counts it toward maxPositions
    // (via effectivePositionCount) and won't place a duplicate. The next sync reconciles fully.
    if (!acct._inflightTickers) acct._inflightTickers = new Set();
    acct._inflightTickers.add(ticker.toUpperCase());
    log(acct, `TRADIER ENTRY: BUY ${qty}x ${occ} @ $${limit} (${aggrLabel}; conviction ${(conviction * 100).toFixed(0)}%, PDT ${lowPdt ? "ok" : "tight"}; bid ${bid ?? "?"}/ask ${ask ?? "?"}/mid ${premium}) — order ${res?.id || JSON.stringify(res).slice(0, 80)}`);

    // Optimistic in-cycle cash decrement so additional entries this cycle size off remaining
    // buying power. Reconciled (overwritten) by the next syncBrokerAccount. No placeholder
    // position is pushed — working orders are surfaced as pending positions during sync instead.
    const totalCost = qty * limit * 100; // worst-case fill (limit) so further sizing this cycle is conservative
    acct.state.cash = Math.max(0, acct.state.cash - totalCost);

    return { ticker, type, strike, dte, qty, entryPremium: +limit.toFixed(2), cost: totalCost, direction, optionsSource: "tradier", setupQuality, claudeConfidence, brokerOrder: true };
  } catch (e) {
    delete acct.state.meta[occ];
    log(acct, `TRADIER ENTRY FAILED ${ticker}: ${e.message}`);
    return { skipped: true, reason: `Tradier entry rejected: ${e.message}` };
  }
}

// Place a real sell_to_close on Tradier. Broker is the source of truth: we record the trade to
// history + day-trade ledger and log it, but DO NOT mutate state.cash/state.positions — the next
// sync reconciles. Returns null so exit-loop callers keep the position until the fill is confirmed.
function placeBrokerExit(acct, pos, currentPremium, reason, qty, pnlPct, pnlDollar) {
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

  // Protective exits (losses, stops, DTE/critical, signal reversals) must actually FILL, so price
  // them at the live bid (marketable) rather than mid where they could rest unfilled while the
  // position keeps bleeding. Profit-taking exits can be patient and use the mid.
  const protective = pnlPct <= 0 || /stop|critical|expir|reversed|breakeven|low-dte|theta/i.test(reason);
  let limit = +currentPremium.toFixed(2);
  if (protective && typeof pos.liveBid === "number" && pos.liveBid > 0) {
    limit = +pos.liveBid.toFixed(2);
  } else if (protective) {
    log(acct, `TRADIER EXIT WARN ${ticker}: no live bid for protective exit — using mid $${limit} (fill not guaranteed)`);
  }

  // Use the EXACT held OCC symbol so we can never target the wrong contract via reconstruction.
  const occForExit = pos.occSymbol || tradier.buildOCC(ticker, new Date(pos.expiryDate).toISOString().slice(0, 10), pos.type, pos.strike);
  tradier.placeOptionOrderByOCC(occForExit, "sell_to_close", qty, "limit", limit)
    .then(res => log(acct, `TRADIER EXIT: SELL ${qty}x ${occForExit} @ $${limit}${protective ? " (marketable)" : ""} — order ${res?.id || "ok"} (${reason})`))
    .catch(e => {
      acct._inflightTickers.delete(ticker.toUpperCase());
      log(acct, `TRADIER EXIT FAILED ${ticker}: ${e.message}`);
    });

  // Bookkeeping (no balance/position mutation — sync is authoritative).
  recordDayTrade(state, pos);
  if (!state.lastClosed) state.lastClosed = {};
  state.lastClosed[ticker] = getETDateStr();
  state.realizedPnl = (state.realizedPnl || 0) + pnlDollar;

  const trade = { ...pos, qty, closePremium: currentPremium, pnlDollar, pnlPct, reason, closeDate: getETDateStr() };
  logTrade(trade);
  state.history.push(trade);

  const trimLabel = qty < pos.qty ? `TRIM ${qty}/${pos.qty}` : "EXIT";
  log(acct, `${trimLabel} (LIVE): ${ticker} $${pos.strike} ${pos.type.toUpperCase()} ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%) — ${reason}`);

  const emoji = pnlDollar >= 0 ? "✅" : "🛑";
  const label = qty < pos.qty ? "TRIM" : (pnlDollar >= 0 ? "EXIT TP" : "EXIT SL");
  sendPush(
    `${emoji} ${label} (LIVE): ${ticker} ${pos.type.toUpperCase()} $${pos.strike} [${acct.name}]`,
    `P&L: ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(0)}%)\n${reason}`,
    pnlDollar < 0
  ).catch(() => {});
  tweetTradeExit(acct, pos, trade).catch(e => console.log(`  [X] Exit tweet error: ${e.message}`));

  return null; // keep position locally; sync reconciles after fill
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

  try {
    const bal = await tradier.getAccount();
    const info = brokerBalanceInfo(bal);
    if (info) {
      if (typeof info.buyingPower === "number") state.cash = info.buyingPower; // settled funds only
      if (typeof info.totalEquity === "number") state.brokerEquity = info.totalEquity;
      state.accountType = info.accountType;
      state.settledCash = info.settledCash;
      state.unsettledCash = info.unsettledCash;
      state.totalCash = info.totalCash;
      // Warn once per change if the live account isn't a cash account (margin → PDT + leverage risk).
      if (info.accountType !== "cash" && state._lastAcctTypeWarned !== info.accountType) {
        log(acct, `⚠️ TRADIER: account type is "${info.accountType.toUpperCase()}", not CASH — PDT rule and margin/leverage apply. You wanted a cash account.`);
        state._lastAcctTypeWarned = info.accountType;
      }
    }
  } catch (e) { log(acct, `TRADIER SYNC: balance error — ${e.message}`); }

  try {
    const raw = await tradier.getPositions();
    const now = Date.now();
    const positions = [];
    const seen = new Set();
    for (const p of raw) {
      const occ = p.symbol;
      const parsed = tradier.parseOCC(occ);
      if (!parsed) continue;                       // skip equity / non-option holdings
      const qtyContracts = Math.round(Math.abs(p.quantity));
      if (qtyContracts < 1) continue;
      const entryPremium = p.cost_basis && qtyContracts ? Math.abs(p.cost_basis) / (qtyContracts * 100) : 0;

      let mark = null, bid = null, ask = null, greeks = null, iv = DEFAULT_IV;
      try {
        const oq = await tradier.getOptionQuote(occ);
        if (oq) {
          bid = typeof oq.bid === "number" ? oq.bid : null;
          ask = typeof oq.ask === "number" ? oq.ask : null;
          mark = reliableOptionMark(oq);   // null if no real two-sided market
          iv = oq.iv ?? DEFAULT_IV;
          greeks = { delta: oq.delta ?? 0, theta: oq.theta ?? 0 };
        }
      } catch { }

      const expiryDate = new Date(`${parsed.expiration}T16:00:00`).getTime();
      const dteRemaining = Math.max(0, (expiryDate - now) / 86400_000);
      const meta = state.meta[occ] || {};
      const spot = quotes[parsed.ticker]?.c ?? meta.entrySpot ?? null;

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
        entryPremium: meta.entryPremium ?? +entryPremium.toFixed(2),
        entrySpot: meta.entrySpot ?? spot,
        qty: qtyContracts,
        originalQty: meta.originalQty ?? qtyContracts,
        cost: Math.abs(p.cost_basis || entryPremium * qtyContracts * 100),
        openDate: meta.openDate ?? (p.date_acquired ? String(p.date_acquired).slice(0, 10) : getETDateStr()),
        openTime: meta.openTime ?? (p.date_acquired ? new Date(p.date_acquired).getTime() : now),
        trimLevel: meta.trimLevel ?? 0,
        bestPnlPct: meta.bestPnlPct ?? 0,
        entryAtrPct: meta.entryAtrPct ?? null,
        iv,
        liveMark: mark != null ? +mark.toFixed(2) : null,
        liveBid: bid,
        liveAsk: ask,
        liveGreeks: greeks,
        optionsSource: "tradier",
        direction: parsed.type === "call" ? "BULLISH" : "BEARISH",
      };

      if (pos.liveMark != null && pos.entryPremium > 0) {
        const pnl = (pos.liveMark - pos.entryPremium) / pos.entryPremium;
        if (pnl > pos.bestPnlPct) pos.bestPnlPct = pnl;
      }

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
        entryPremium: pos.entryPremium, entrySpot: pos.entrySpot, dte: pos.dte,
        originalQty: pos.originalQty, openDate: pos.openDate, openTime: pos.openTime,
        trimLevel: pos.trimLevel, bestPnlPct: pos.bestPnlPct, entryAtrPct: pos.entryAtrPct,
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
      if (seen.has(o.occ)) continue; // already a filled position
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
        originalQty: o.qty,
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
    }

    // Prune metadata for positions that no longer exist at the broker.
    for (const k of Object.keys(state.meta)) if (!seen.has(k)) delete state.meta[k];
    state.positions = positions;
    state.workingOrderCount = workingOrders.length;
    state.reservedBuyingPower = reserved;
    const filled = positions.filter(p => !p._pending).length;
    const pending = positions.length - filled;
    const unsettledStr = state.unsettledCash > 0 ? ` | unsettled $${state.unsettledCash.toFixed(0)}` : "";
    log(acct, `TRADIER SYNC [${(state.accountType || "?").toUpperCase()}]: equity $${(state.brokerEquity ?? portfolioValue(state, quotes)).toFixed(2)} | settled BP $${state.cash.toFixed(2)}${unsettledStr} | ${filled} filled, ${pending} pending order(s)${reserved > 0 ? ` reserving $${reserved.toFixed(0)}` : ""}`);
  } catch (e) { log(acct, `TRADIER SYNC: positions error — ${e.message}`); }
}

// ─── Main Trading Cycle ───

async function runCycle(acct, sharedQuotes, apiKey) {
  const state = acct.state;
  const cfg = acct.config;
  const dash = acct.dashboard;
  const mktOpen = isMarketOpen();
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
    const lowCash = state.cash < 100;

    dec.bullScore = a.bullScore; dec.bearScore = a.bearScore;
    dec.shortTermScore = st ? st.score : null;
    dec.longTermScore = a ? Math.round(50 + (a.bullScore - a.bearScore) / 2) : null;
    dec.blendedScore = effectiveScore;

    if (finalScore >= cfg.bullEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
      else { dec.action = "BUY CALL"; dec.reason = `Bullish ${finalScore}/100 (7d:${st?.score ?? '?'} 90d:${dec.longTermScore})`; }
    } else if (finalScore <= cfg.bearEntry) {
      if (alreadyHeld) { dec.action = "HOLD"; dec.reason = "Already in position"; }
      else if (lowCash) { dec.action = "BLOCKED"; dec.reason = `Insufficient cash ($${state.cash.toFixed(0)})`; }
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

  cleanDayTrades(state);

  // Broker accounts: mirror real balance + positions before any exit/entry decisions.
  if (cfg.broker === "tradier") await syncBrokerAccount(acct, quotes);

  const regime = getMarketRegime(acct.candleCache);
  acct.currentRegime = regime;
  acct.riskPct = cfg.baseRiskPct * regime.riskScale;
  log(acct, `REGIME: ${regime.label} | Risk: ${(acct.riskPct * 100).toFixed(1)}% per trade (${regime.riskScale}x base)`);

  tryTimeBasedExits(acct, quotes);
  tryExits(acct, quotes);
  trySignalExits(acct, quotes, analyses);
  tryEMATrailingExits(acct, quotes);

  for (const ticker of activeTickers) {
    const a = analyses[ticker];
    const q = quotes[ticker];
    if (!a || !q) continue;

    const result = await tryEntry(acct, ticker, a, q, regime, apiKey);
    if (result && result.skipped) {
      log(acct, `SKIP ${ticker}: ${result.reason}`);
      const dec = decisions.find(d => d.ticker === ticker);
      if (dec && (dec.action === "BUY CALL" || dec.action === "BUY PUT")) {
        dec.action = "BLOCKED";
        dec.reason = result.reason;
      }
    } else if (result && result.ticker) {
      log(acct, `TRADE: BUY ${result.qty}x ${result.ticker} $${result.strike} ${result.type.toUpperCase()} ${result.dte}d @ $${result.entryPremium.toFixed(2)} ($${result.cost.toFixed(0)}) [setup:${result.setupQuality}/100 claude:${result.claudeConfidence}%]`);
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
      const st = shortTermAnalyses[ticker];
      const q = quotes[ticker];
      tweetTradeEntry(acct, result, entryA, st, q).catch(e => console.log(`  [X] Entry tweet error: ${e.message}`));

      // ─── Robinhood Agentic Execution (entry) ───
      // Skip for Tradier broker accounts — they already executed natively via placeBrokerEntry.
      if (acct.config.broker !== "tradier" && TRADING_MODE === "robinhood" && robinhood.isConnected) {
        try {
          const equityOrder = robinhood.convertOptionsToEquity(
            result.ticker,
            result.direction || (result.type === "call" ? "BULLISH" : "BEARISH"),
            result.entrySpot,
            Math.min(result.cost, RH_MAX_POSITION_DOLLARS)
          );
          if (RH_REQUIRE_APPROVAL) {
            const pending = robinhood.queueOrder(equityOrder);
            log(acct, `RH QUEUED: ${equityOrder.conversionNote} — awaiting approval (${pending.id.slice(0, 8)})`);
            sendPush(
              `📋 RH PENDING: ${equityOrder.side.toUpperCase()} ${equityOrder.quantity} ${equityOrder.symbol}`,
              `${equityOrder.conversionNote}\nApprove from dashboard`,
              true
            ).catch(() => {});
          } else {
            const orderResult = await robinhood.placeStockOrder(
              equityOrder.symbol, equityOrder.side, equityOrder.quantity, equityOrder.orderType
            );
            log(acct, `RH EXECUTED: ${equityOrder.conversionNote}`);
            sendPush(
              `✅ RH BUY: ${equityOrder.quantity} ${equityOrder.symbol} FILLED`,
              equityOrder.conversionNote,
              true
            ).catch(() => {});
          }
        } catch (rhErr) {
          log(acct, `RH ERROR (entry): ${rhErr.message}`);
        }
      }
    }
  }

  dash.positionDetails = buildPositionDetails(acct, quotes);

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  const progress = ((pv / cfg.goal) * 100).toFixed(1);
  log(acct, `Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Goal: ${progress}% of $${cfg.goal.toLocaleString()} | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | ${countRecentDayTrades(state)}/3 PDT | ${regime.mode.toUpperCase()}${getActiveHintsSummary(acct)}`);

  // Tweet daily watchlist summary (once per day)
  tweetWatchlistSummary(acct, decisions, regime).catch(e => console.log(`  [X] Watchlist tweet error: ${e.message}`));

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

  cleanDayTrades(state);

  // Build minimal analyses for signal-based exits
  const analyses = {};
  for (const ticker of positionTickers) {
    const candles = acct.candleCache[ticker];
    if (candles) {
      const a = runAnalysis(candles);
      if (a) analyses[ticker] = a;
    }
  }

  tryTimeBasedExits(acct, quotes);
  tryExits(acct, quotes);
  trySignalExits(acct, quotes, analyses);
  tryEMATrailingExits(acct, quotes);

  dash.positionDetails = buildPositionDetails(acct, quotes);
  dash.lastCycle = Date.now();

  const pv = portfolioValue(state, quotes);
  const pnlPct = ((pv - cfg.startingCash) / cfg.startingCash * 100).toFixed(1);
  log(acct, `[PAUSED] Portfolio: $${pv.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct}%) | Cash: $${state.cash.toFixed(0)} | ${state.positions.length} open | exits active, no new entries`);

  dash.portfolioHistory = dash.portfolioHistory || [];
  appendPortfolioPoint(dash.portfolioHistory, Date.now(), pv);

  saveAccounts(); // persist PV chart points even while paused (survives redeploys)
}

function buildPositionDetails(acct, quotes) {
  const state = acct.state;
  const cfg = acct.config;
  return state.positions.map(pos => {
    const q = quotes[pos.ticker];
    const spot = q ? q.c : pos.entrySpot;
    const now = Date.now();
    const dteLeft = pos.expiryDate
      ? Math.max(0, (pos.expiryDate - now) / 86400_000)
      : Math.max(0, pos.dte - (now - pos.openTime) / 86400_000);

    // Pending (unfilled) broker orders: show flat, tagged as a working order — no P&L/greeks math.
    if (pos._pending) {
      return {
        ...pos, spot, dteLeft, curPremium: pos.entryPremium, pnlPct: 0, pnlDollar: 0,
        profitTarget: { pct: "—", premium: "—" },
        stopLoss: { pct: "—", premium: "—" },
        pctToProfit: "0.0", pctToStop: "0.0",
        pdtStatus: `⏳ WORKING ORDER${pos.orderStatus ? ` (${pos.orderStatus})` : ""}`,
        greeks: { delta: "—", theta: "—" },
      };
    }

    const curPremium = pos.liveMark ?? optPrice(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type);
    const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
    const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;
    const profitPrice = pos.entryPremium * (1 + cfg.profitTarget);
    const stopLossPrice = pos.entryPremium * (1 + cfg.stopLoss);
    const isDayTrade = pos.openDate === getETDateStr();
    const pdtStatus = isDayTrade ? `Day trade (${countRecentDayTrades(state)}/3 used)` : "Swing (not a day trade)";

    let effectiveStop;
    if ((pos.trimLevel || 0) >= 2) effectiveStop = pos.entryPremium * 1.15;
    else if ((pos.trimLevel || 0) >= 1) effectiveStop = pos.entryPremium;
    else effectiveStop = stopLossPrice;

    return {
      ...pos, spot, dteLeft, curPremium, pnlPct, pnlDollar,
      profitTarget: { pct: `+${(cfg.profitTarget * 100).toFixed(0)}%`, premium: profitPrice.toFixed(2) },
      stopLoss: { pct: `${(cfg.stopLoss * 100).toFixed(0)}%`, premium: effectiveStop.toFixed(2) },
      pctToProfit: ((profitPrice - curPremium) / curPremium * 100).toFixed(1),
      pctToStop: ((effectiveStop - curPremium) / curPremium * 100).toFixed(1),
      pdtStatus,
      greeks: pos.liveGreeks
        ? { delta: (pos.liveGreeks.delta ?? 0).toFixed(3), theta: (pos.liveGreeks.theta ?? 0).toFixed(3) }
        : optGreeks(spot, pos.strike, dteLeft, pos.iv || DEFAULT_IV, pos.type),
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
    quotes[ticker] = { c: latest.c, h: latest.h, l: latest.l, o: latest.o, pc: sliced.length > 1 ? sliced[sliced.length - 2].c : latest.o };
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

  // Market regime
  const regime = getMarketRegime(acct.candleCache);
  acct.currentRegime = regime;
  acct.riskPct = acct.config.baseRiskPct * regime.riskScale;

  // Run exits
  tryExits(acct, quotes);
  trySignalExits(acct, quotes, analyses);
  tryEMATrailingExits(acct, quotes);

  // Run entries
  for (const ticker of tickers) {
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
  log(acct, "AFTER-HOURS SCAN — Fetching data for analysis (no trades)");

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
  console.log("  ║  Multi-Account · Dynamic Watchlist · PDT      ║");
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

  // Initialize Robinhood Agentic Trading
  console.log(`  Trading Mode: ${TRADING_MODE.toUpperCase()}`);
  if (TRADING_MODE === "robinhood" || process.env.ROBINHOOD_ACCESS_TOKEN) {
    const rhOk = await robinhood.init();
    if (rhOk) {
      console.log(`  Robinhood: CONNECTED ✓ (approval: ${RH_REQUIRE_APPROVAL ? "MANUAL" : "AUTO"}, max: $${RH_MAX_POSITION_DOLLARS}/position)`);
    } else {
      console.log("  Robinhood: NOT CONNECTED — set ROBINHOOD_ACCESS_TOKEN or authenticate from dashboard");
      if (TRADING_MODE === "robinhood") {
        console.log("  WARNING: Trading mode is ROBINHOOD but no connection — orders will fail. Falling back to PAPER.");
        TRADING_MODE = "paper";
      }
    }
  } else {
    console.log("  Robinhood: PAPER mode — no live trading. Toggle from dashboard to enable.");
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
    for (const [, acct] of accounts) {
      if (!acct.paused) await runAfterHoursScan(acct, sharedQuotes, apiKey);
    }
  } catch (e) {
    console.log(`  WARN: Startup scan failed — ${e.message}`);
  }

  // Main loop
  while (true) {
    const gap = Date.now() - lastCycleTime;
    if (gap > 5 * 60_000) {
      console.log(`  WAKE DETECTED — ${(gap / 60_000).toFixed(0)}m gap. Re-syncing...`);
      sharedCandleCache = {};
      for (const [, acct] of accounts) acct.candleCache = {};
    }
    lastCycleTime = Date.now();

    const marketOpen = isMarketOpen();
    // Accounts may opt into trading while closed (e.g. broker sandbox testing). If any non-paused
    // account does, we run the fast cycle so its full runCycle (entries+exits) executes now.
    const forcedAccts = [...accounts.values()].filter(a => !a.paused && a.config.tradeWhenClosed);
    const activeCycle = marketOpen || forcedAccts.length > 0;

    if (activeCycle) {
      const today = getETDateStr();
      if (marketOpen && lastCandleDate !== today) {
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
            const tradeThis = marketOpen || acct.config.tradeWhenClosed;
            if (acct.paused) {
              await runPausedCycle(acct, sharedQuotes);
            } else if (tradeThis) {
              if (!marketOpen) log(acct, "TRADE-WHEN-CLOSED — running full cycle while market is closed (test mode)");
              await runCycle(acct, sharedQuotes, apiKey);
            } else {
              await runAfterHoursScan(acct, sharedQuotes, apiKey);
            }
          } catch (e) {
            log(acct, `ERROR in cycle: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`  ERROR in shared fetch: ${e.message}`);
      }

      saveAccounts();
      console.log("");
      await delay(CYCLE_MS);
    } else {
      // After hours
      try {
        const { sharedQuotes } = await fetchSharedMarketData(apiKey, sharedCandleCache);
        for (const [, acct] of accounts) {
          for (const [ticker, candles] of Object.entries(sharedCandleCache)) {
            if (!acct.candleCache[ticker]) acct.candleCache[ticker] = candles;
          }
        }

        for (const [, acct] of accounts) {
          if (!acct.paused) await runAfterHoursScan(acct, sharedQuotes, apiKey);
          // paused accounts: candles already synced above, no further action needed after hours
        }
      } catch (e) {
        console.log(`  WARN: After-hours scan failed — ${e.message}`);
      }

      saveAccounts();
      await delay(900_000); // 15 min after hours
    }
  }
}


// ─── Start ───
main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
