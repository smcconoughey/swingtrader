import fs from "fs";
import fetch from "node-fetch";

// ─── Technical Analysis Engine (shared with bot.js) ───

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
  const avgV20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgV5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vr = avgV20 > 0 ? avgV5 / avgV20 : 1;
  const pb8 = c <= ema8[L] * 1.005 && c >= ema8[L] * 0.99;
  const pb21 = c <= ema21[L] * 1.005 && c >= ema21[L] * 0.99;
  const xover = ema8[L] > ema21[L] && L >= 3 && ema8[L - 3] <= ema21[L - 3];
  const rV = rsi[rsi.length - 1] || 50;
  const aV = atr[atr.length - 1] || c * 0.02;

  let score = 0;
  if (aligned) score += 25; else if (bearish) score -= 15;
  if (xover) score += 20;
  if (aligned && pb8 && vr < 0.85) score += 20;
  else if (aligned && pb21 && vr < 0.85) score += 15;
  if (vr > 1.15 && aligned) score += 15;
  if (rV > 50 && rV < 70) score += 10;
  else if (rV >= 70) score -= 10;
  else if (rV <= 30) score += 5;
  let hh = 0, hl = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] > highs[i]) hh++; if (lows[i + 1] > lows[i]) hl++; }
  const trend = ((hh + hl) / 18) * 100;
  if (trend > 60) score += 10;
  score = Math.max(0, Math.min(100, score));

  return { score, price: c, aligned, bearish, rsi: rV, atr: aV, atrPct: (aV / c) * 100, vr };
}

function optPrice(spot, strike, dte, iv, type = "call") {
  const t = dte / 365;
  const intr = type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  return Math.max(0.05, +(intr + spot * iv * Math.sqrt(t) * 0.4).toFixed(2));
}

// ─── Strategy Parameters (genome) ───

function defaultGenome() {
  return {
    entryThreshold: 60,       // min score to enter bullish
    bearThreshold: 25,        // max score to enter bearish
    riskPct: 0.30,            // % of cash per trade
    maxPositions: 3,
    profitTarget: 0.40,       // take profit at +X%
    stopLoss: -0.35,          // stop at -X%
    dte: 7,                   // days to expiration
    otmStrikes: 1,            // how many strikes OTM
    iv: 0.30,
  };
}

function mutateGenome(g, rate = 0.3) {
  const m = { ...g };
  const jitter = (v, min, max, scale = 0.15) => {
    if (Math.random() < rate) return Math.max(min, Math.min(max, v + (Math.random() - 0.5) * 2 * v * scale));
    return v;
  };
  m.entryThreshold = Math.round(jitter(m.entryThreshold, 40, 80));
  m.bearThreshold = Math.round(jitter(m.bearThreshold, 10, 40));
  m.riskPct = +jitter(m.riskPct, 0.05, 0.50).toFixed(2);
  m.maxPositions = Math.round(jitter(m.maxPositions, 1, 6));
  m.profitTarget = +jitter(m.profitTarget, 0.15, 1.0).toFixed(2);
  m.stopLoss = +jitter(m.stopLoss, -0.60, -0.10).toFixed(2);
  m.dte = Math.round(jitter(m.dte, 3, 21));
  m.otmStrikes = Math.round(jitter(m.otmStrikes, 0, 3));
  return m;
}

function crossover(a, b) {
  const child = {};
  for (const key of Object.keys(a)) {
    child[key] = Math.random() < 0.5 ? a[key] : b[key];
  }
  return child;
}

// ─── Simulate One Run ───

function simulateRun(candles, genome, startCash, tradingDays) {
  // candles is { TICKER: [candle, candle, ...] }
  const tickers = Object.keys(candles);
  let cash = startCash;
  let positions = [];
  let trades = [];

  let maxDrawdown = 0;
  let peak = startCash;

  // Walk through trading days
  const allDates = new Set();
  for (const t of tickers) {
    for (const c of candles[t]) allDates.add(c.t);
  }
  const dates = [...allDates].sort().slice(-tradingDays);

  for (let di = 55; di < dates.length; di++) {
    const date = dates[di];

    // Get candle slices up to this date for analysis
    const analyses = {};
    const dayQuotes = {};
    for (const ticker of tickers) {
      const tickerCandles = candles[ticker].filter(c => c.t <= date);
      if (tickerCandles.length < 55) continue;
      const slice = tickerCandles.slice(-60);
      const a = runAnalysis(slice);
      if (a) {
        analyses[ticker] = a;
        dayQuotes[ticker] = tickerCandles[tickerCandles.length - 1].c;
      }
    }

    // Exit logic
    const remaining = [];
    for (const pos of positions) {
      const spot = dayQuotes[pos.ticker] || pos.entrySpot;
      pos.daysHeld++;
      const dteLeft = Math.max(0, pos.dte - pos.daysHeld);
      const curPremium = optPrice(spot, pos.strike, dteLeft, genome.iv, pos.type);
      const pnlPct = (curPremium - pos.entryPremium) / pos.entryPremium;
      const pnlDollar = (curPremium - pos.entryPremium) * pos.qty * 100;

      let closeReason = null;
      if (pnlPct >= genome.profitTarget) closeReason = "profit";
      else if (pnlPct <= genome.stopLoss) closeReason = "stop";
      else if (dteLeft <= 1) closeReason = "expiry";
      else {
        const a = analyses[pos.ticker];
        if (a && pos.type === "call" && a.score < 20) closeReason = "signal_rev";
        if (a && pos.type === "put" && a.score > 70) closeReason = "signal_rev";
      }

      if (closeReason) {
        cash += curPremium * pos.qty * 100;

        trades.push({ ticker: pos.ticker, pnlPct, pnlDollar, reason: closeReason, type: pos.type });
      } else {
        remaining.push(pos);
      }
    }
    positions = remaining;

    // Entry logic
    for (const ticker of tickers) {
      if (positions.length >= genome.maxPositions) break;
      if (positions.some(p => p.ticker === ticker)) continue;
      const a = analyses[ticker];
      if (!a) continue;
      const spot = dayQuotes[ticker];
      if (!spot) continue;

      let type = null, strike;
      if (a.score >= genome.entryThreshold) {
        type = "call";
        const atm = Math.round(spot / 5) * 5;
        strike = atm + genome.otmStrikes * 5;
      } else if (a.score < genome.bearThreshold && a.bearish) {
        type = "put";
        const atm = Math.round(spot / 5) * 5;
        strike = atm - genome.otmStrikes * 5;
      }
      if (!type) continue;

      const premium = optPrice(spot, strike, genome.dte, genome.iv, type);
      const costPer = premium * 100;
      if (costPer > cash) continue;
      const maxRisk = cash * genome.riskPct;
      let qty = Math.max(1, Math.floor(maxRisk / costPer));
      if (qty * costPer > cash) qty = Math.floor(cash / costPer);
      if (qty <= 0) continue;

      cash -= qty * costPer;
      positions.push({ ticker, type, strike, dte: genome.dte, entryPremium: premium, entrySpot: spot, qty, daysHeld: 0 });
    }

    // Track drawdown
    let posVal = 0;
    for (const pos of positions) {
      const spot = dayQuotes[pos.ticker] || pos.entrySpot;
      const dteLeft = Math.max(0, pos.dte - pos.daysHeld);
      posVal += optPrice(spot, pos.strike, dteLeft, genome.iv, pos.type) * pos.qty * 100;
    }
    const total = cash + posVal;
    if (total > peak) peak = total;
    const dd = (peak - total) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Close remaining positions at last price
  for (const pos of positions) {
    const dteLeft = Math.max(0, pos.dte - pos.daysHeld);
    const curPremium = optPrice(pos.entrySpot, pos.strike, dteLeft, genome.iv, pos.type);
    cash += curPremium * pos.qty * 100;
  }

  const finalValue = cash;
  const totalReturn = (finalValue - startCash) / startCash;
  const winTrades = trades.filter(t => t.pnlPct > 0);
  const lossTrades = trades.filter(t => t.pnlPct <= 0);

  return {
    finalValue,
    totalReturn,
    maxDrawdown,
    tradeCount: trades.length,
    winRate: trades.length > 0 ? winTrades.length / trades.length : 0,
    avgWin: winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length : 0,
    avgLoss: lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length : 0,

    sharpe: trades.length > 1 ? calcSharpe(trades.map(t => t.pnlPct)) : 0,
  };
}

function calcSharpe(returns) {
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
  return std > 0 ? (avg / std) * Math.sqrt(252) : 0;
}

// ─── Monte Carlo ───

function monteCarloSim(candles, genome, startCash, runs = 500, tradingDays = 22) {
  const results = [];
  const tickers = Object.keys(candles);

  for (let r = 0; r < runs; r++) {
    // Add noise to candle data — simulate price uncertainty
    const noisyCandles = {};
    for (const ticker of tickers) {
      noisyCandles[ticker] = candles[ticker].map(c => {
        const noise = 1 + (Math.random() - 0.5) * 0.02; // ±1% noise
        return { c: c.c * noise, h: c.h * noise, l: c.l * noise, o: c.o * noise, v: c.v * (0.8 + Math.random() * 0.4), t: c.t };
      });
    }
    results.push(simulateRun(noisyCandles, genome, startCash, tradingDays));
  }

  results.sort((a, b) => a.finalValue - b.finalValue);
  const returns = results.map(r => r.totalReturn);

  return {
    median: results[Math.floor(runs / 2)].finalValue,
    p10: results[Math.floor(runs * 0.1)].finalValue,
    p90: results[Math.floor(runs * 0.9)].finalValue,
    mean: results.reduce((s, r) => s + r.finalValue, 0) / runs,
    maxDD: Math.max(...results.map(r => r.maxDrawdown)),
    avgDD: results.reduce((s, r) => s + r.maxDrawdown, 0) / runs,
    bustRate: results.filter(r => r.finalValue < startCash * 0.2).length / runs,
    goalRate: results.filter(r => r.finalValue >= 10000).length / runs,
    avgWinRate: results.reduce((s, r) => s + r.winRate, 0) / runs,
    avgTrades: results.reduce((s, r) => s + r.tradeCount, 0) / runs,
    avgSharpe: results.reduce((s, r) => s + r.sharpe, 0) / runs,
  };
}

// ─── Genetic Evolution ───

function evolve(candles, generations = 20, popSize = 30, startCash = 100, tradingDays = 22) {
  console.log(`\nEvolving ${popSize} strategies over ${generations} generations...\n`);

  // Initial population
  let pop = [defaultGenome()];
  for (let i = 1; i < popSize; i++) pop.push(mutateGenome(defaultGenome(), 0.8));

  let bestEver = null;
  let bestFitness = -Infinity;

  for (let gen = 0; gen < generations; gen++) {
    // Evaluate fitness for each genome
    const scored = pop.map(genome => {
      const result = simulateRun(candles, genome, startCash, tradingDays);
      // Fitness = return adjusted for risk
      // Reward high returns but penalize high drawdown and bust risk
      const fitness = result.totalReturn * 100
        - result.maxDrawdown * 50
        + result.winRate * 20
        + (result.tradeCount > 0 ? 10 : -20);
      return { genome, result, fitness };
    });

    scored.sort((a, b) => b.fitness - a.fitness);

    if (scored[0].fitness > bestFitness) {
      bestFitness = scored[0].fitness;
      bestEver = scored[0];
    }

    const best = scored[0];
    const avg = scored.reduce((s, x) => s + x.fitness, 0) / scored.length;
    console.log(`Gen ${(gen + 1).toString().padStart(2)}: Best=$${best.result.finalValue.toFixed(0)} (${(best.result.totalReturn * 100).toFixed(0)}%) DD=${(best.result.maxDrawdown * 100).toFixed(0)}% WR=${(best.result.winRate * 100).toFixed(0)}% | Avg fitness: ${avg.toFixed(1)}`);

    // Selection — top 30% survive
    const survivors = scored.slice(0, Math.ceil(popSize * 0.3));

    // Next generation
    const nextPop = survivors.map(s => s.genome); // elites pass through
    while (nextPop.length < popSize) {
      const parentA = survivors[Math.floor(Math.random() * survivors.length)].genome;
      const parentB = survivors[Math.floor(Math.random() * survivors.length)].genome;
      const child = mutateGenome(crossover(parentA, parentB), 0.3);
      nextPop.push(child);
    }
    pop = nextPop;
  }

  return bestEver;
}

// ─── Deposit Optimizer ───

function findOptimalDeposit(candles, genome, tradingDays = 22) {
  console.log("\nFinding optimal deposit amount...\n");
  const deposits = [25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
  const results = [];

  for (const deposit of deposits) {
    const mc = monteCarloSim(candles, genome, deposit, 300, tradingDays);
    const rewardRisk = mc.mean / deposit / Math.max(0.01, mc.avgDD);
    const roi = ((mc.median - deposit) / deposit * 100).toFixed(0);
    results.push({ deposit, ...mc, rewardRisk, roi });
    console.log(`  $${deposit.toString().padStart(5)} → Median: $${mc.median.toFixed(0)} (${roi}%) | P10: $${mc.p10.toFixed(0)} | Goal: ${(mc.goalRate * 100).toFixed(0)}% | Bust: ${(mc.bustRate * 100).toFixed(0)}% | R/R: ${rewardRisk.toFixed(2)}`);
  }

  results.sort((a, b) => b.rewardRisk - a.rewardRisk);
  return results;
}

// ─── Fetch Historical Data ───

async function fetchAllCandles(apiKey) {
  const TICKERS = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "META", "AMZN", "GOOGL", "AMD"];
  const candles = {};

  for (const ticker of TICKERS) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 180 * 86400; // 6 months for more data
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${apiKey}`);
    const d = await r.json();
    if (d.s === "ok" && d.c) {
      candles[ticker] = d.c.map((c, i) => ({ c, h: d.h[i], l: d.l[i], o: d.o[i], v: d.v[i], t: d.t[i] }));
      console.log(`  Fetched ${ticker}: ${candles[ticker].length} candles`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return candles;
}

// ─── Main ───

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  SWINGERS — Monte Carlo Strategy Optimizer    ║");
  console.log("║  Genetic Evolution + Deposit Optimization     ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // Load API key from state.json
  let apiKey;
  try {
    const state = JSON.parse(fs.readFileSync("state.json", "utf-8"));
    apiKey = state.apiKey;
  } catch {
    console.log("No state.json found. Run the bot first to set up your API key.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const days = parseInt(args.find(a => a.startsWith("--days="))?.split("=")[1]) || 22;
  const gens = parseInt(args.find(a => a.startsWith("--gens="))?.split("=")[1]) || 20;
  const pop = parseInt(args.find(a => a.startsWith("--pop="))?.split("=")[1]) || 30;
  const runs = parseInt(args.find(a => a.startsWith("--runs="))?.split("=")[1]) || 500;

  console.log(`Config: ${days} trading days, ${gens} generations, pop ${pop}, ${runs} MC runs\n`);
  console.log("Fetching historical data...");
  const candles = await fetchAllCandles(apiKey);

  // Save candle cache for future runs
  fs.writeFileSync("candle-cache.json", JSON.stringify(candles));
  console.log(`\nCached candle data to candle-cache.json\n`);

  // Phase 1: Evolve the best strategy
  console.log("═══ PHASE 1: Genetic Strategy Evolution ═══");
  const best = evolve(candles, gens, pop, 100, days);

  console.log("\n─── Best Strategy Found ───");
  console.log(JSON.stringify(best.genome, null, 2));
  console.log(`Result: $${best.result.finalValue.toFixed(0)} (${(best.result.totalReturn * 100).toFixed(0)}%) | ${best.result.tradeCount} trades | WR: ${(best.result.winRate * 100).toFixed(0)}% | MaxDD: ${(best.result.maxDrawdown * 100).toFixed(0)}%`);

  // Phase 2: Monte Carlo on the best strategy
  console.log("\n═══ PHASE 2: Monte Carlo Simulation ═══");
  console.log(`Running ${runs} simulations with best strategy...\n`);
  const mc = monteCarloSim(candles, best.genome, 100, runs, days);
  console.log(`  Median outcome:  $${mc.median.toFixed(0)}`);
  console.log(`  10th percentile: $${mc.p10.toFixed(0)} (worst case)`);
  console.log(`  90th percentile: $${mc.p90.toFixed(0)} (best case)`);
  console.log(`  Goal rate ($10k): ${(mc.goalRate * 100).toFixed(1)}%`);
  console.log(`  Bust rate (<$20): ${(mc.bustRate * 100).toFixed(1)}%`);
  console.log(`  Avg drawdown:    ${(mc.avgDD * 100).toFixed(1)}%`);
  console.log(`  Avg win rate:    ${(mc.avgWinRate * 100).toFixed(1)}%`);

  // Phase 3: Find optimal deposit
  console.log("\n═══ PHASE 3: Optimal Deposit Analysis ═══");
  const deposits = findOptimalDeposit(candles, best.genome, days);

  console.log("\n─── Recommendation ───");
  const topDep = deposits[0];
  console.log(`Best reward-to-risk: $${topDep.deposit} deposit`);
  console.log(`  → Median: $${topDep.median.toFixed(0)} (${topDep.roi}% ROI)`);
  console.log(`  → Goal rate: ${(topDep.goalRate * 100).toFixed(0)}%`);
  console.log(`  → Bust rate: ${(topDep.bustRate * 100).toFixed(0)}%`);
  console.log(`  → Reward/Risk: ${topDep.rewardRisk.toFixed(2)}`);

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    bestGenome: best.genome,
    bestResult: best.result,
    monteCarlo: mc,
    deposits: deposits.slice(0, 5),
    config: { days, gens, pop, runs },
  };
  fs.writeFileSync("sim-results.json", JSON.stringify(output, null, 2));
  console.log("\nResults saved to sim-results.json");
  console.log("To apply best strategy to bot, copy genome values to bot.js constants.\n");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
