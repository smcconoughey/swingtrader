import { useState, useEffect, useCallback, useRef } from "react";

// ─── Technical Analysis Engine ───
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
  const xover = ema8[L] > ema21[L] && L >= 3 && ema8[L - 3] <= ema21[L - 3];
  const rV = rsi[rsi.length - 1] || 50;
  const aV = atr[atr.length - 1] || c * 0.02;

  let score = 0; const sigs = [];
  if (aligned) { score += 25; sigs.push({ t: "bull", text: "EMA Stack Aligned (8>21>50)", w: 3 }); }
  else if (bearish) { score -= 15; sigs.push({ t: "bear", text: "Bearish EMA alignment", w: 3 }); }
  if (xover) { score += 20; sigs.push({ t: "bull", text: "Fresh 8/21 EMA Bullish Crossover", w: 3 }); }
  if (aligned && pb8 && vr < 0.85) { score += 20; sigs.push({ t: "bull", text: "Pullback to 8 EMA on low volume", w: 3 }); }
  else if (aligned && pb21 && vr < 0.85) { score += 15; sigs.push({ t: "bull", text: "Pullback to 21 EMA on low volume", w: 2 }); }
  if (vr > 1.15 && aligned) { score += 15; sigs.push({ t: "bull", text: "Volume expanding with trend", w: 2 }); }
  if (rV > 50 && rV < 70) { score += 10; sigs.push({ t: "bull", text: `RSI ${rV.toFixed(0)} — healthy momentum`, w: 1 }); }
  else if (rV >= 70) { score -= 10; sigs.push({ t: "warn", text: `RSI ${rV.toFixed(0)} — overbought`, w: 2 }); }
  else if (rV <= 30) { score += 5; sigs.push({ t: "info", text: `RSI ${rV.toFixed(0)} — oversold bounce?`, w: 1 }); }

  let hh = 0, hl = 0;
  for (let i = Math.max(0, L - 9); i < L; i++) { if (highs[i + 1] > highs[i]) hh++; if (lows[i + 1] > lows[i]) hl++; }
  const trend = ((hh + hl) / 18) * 100;
  if (trend > 60) { score += 10; sigs.push({ t: "bull", text: `Trend structure ${trend.toFixed(0)}%`, w: 2 }); }

  score = Math.max(0, Math.min(100, score));
  const sig = score >= 70 ? "STRONG BUY" : score >= 50 ? "BUY WATCH" : score >= 30 ? "NEUTRAL" : "AVOID";
  return {
    score, signal: sig, sigs, price: c,
    ema8v: ema8[L], ema21v: ema21[L], ema50v: ema50[L],
    aligned, spread, rsi: rV, atr: aV, atrPct: (aV / c) * 100, vr,
    stop: +(c - aV * 1.5).toFixed(2), t1: +(c + aV * 2).toFixed(2), t2: +(c + aV * 3).toFixed(2),
    rr: ((aV * 2) / Math.max(0.01, aV * 1.5)).toFixed(1),
    emaLines: { ema8, ema21, ema50 }, closes, volumes, candles,
  };
}

// ─── Options Helpers ───
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

// ─── Charts ───
const PriceChart = ({ closes, emaLines, height = 120 }) => {
  if (!closes || closes.length < 3) return <div style={{ height, background: "#ffffff04", borderRadius: 6 }} />;
  const w = 340, mn = Math.min(...closes) * 0.998, mx = Math.max(...closes) * 1.002, rng = mx - mn;
  const y = v => height - ((v - mn) / rng) * (height - 10) - 5;
  const p = arr => arr.map((c, i) => `${i ? "L" : "M"}${(i / (arr.length - 1)) * w},${y(c)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }}>
      <defs><linearGradient id="pfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#00ff8840" /><stop offset="100%" stopColor="#00ff8804" /></linearGradient></defs>
      <path d={p(closes) + ` L${w},${height} L0,${height} Z`} fill="url(#pfill)" />
      {emaLines?.ema21 && <path d={p(emaLines.ema21)} fill="none" stroke="#ff6b35" strokeWidth="1" opacity=".55" />}
      {emaLines?.ema8 && <path d={p(emaLines.ema8)} fill="none" stroke="#4ecdc4" strokeWidth="1" opacity=".55" />}
      <path d={p(closes)} fill="none" stroke="#00ff88" strokeWidth="1.6" />
    </svg>
  );
};
const VolChart = ({ vols, height = 30 }) => {
  if (!vols || vols.length < 3) return null;
  const w = 340, mx = Math.max(...vols), avg = vols.reduce((a, b) => a + b, 0) / vols.length, bw = w / vols.length;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }}>
      <line x1="0" y1={height - (avg / mx) * height} x2={w} y2={height - (avg / mx) * height} stroke="#ffffff15" strokeDasharray="3 2" />
      {vols.map((v, i) => <rect key={i} x={i * bw + .5} y={height - (v / mx) * height} width={Math.max(bw - 1, 1)} height={(v / mx) * height} fill={v > avg * 1.15 ? "#00ff8850" : "#ffffff18"} rx=".5" />)}
    </svg>
  );
};
const Ring = ({ val, sz = 100 }) => {
  const r = (sz - 12) / 2, circ = 2 * Math.PI * r, off = circ - (val / 100) * circ;
  const col = val >= 70 ? "#00ff88" : val >= 50 ? "#ffd93d" : val >= 30 ? "#ff8c42" : "#ff4444";
  return (
    <svg width={sz} height={sz}>
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none" stroke="#ffffff08" strokeWidth="6" />
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none" stroke={col} strokeWidth="6" strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round" transform={`rotate(-90 ${sz / 2} ${sz / 2})`} style={{ transition: "all .7s ease" }} />
      <text x={sz / 2} y={sz / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill={col} fontSize="22" fontWeight="800" fontFamily="'JetBrains Mono',monospace">{val}</text>
    </svg>
  );
};

// ─── Storage ───
const SK = "srx-live-v2";
async function load() { try { const r = await window.storage.get(SK); return r ? JSON.parse(r.value) : null; } catch { return null; } }
async function save(s) { try { await window.storage.set(SK, JSON.stringify(s)); } catch {} }
const INIT = { cash: 25000, positions: [], history: [], deposited: 25000, apiKey: "" };

const TICKERS = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "META", "AMZN", "GOOGL", "AMD"];
const sigCol = s => s === "STRONG BUY" ? "#00ff88" : s === "BUY WATCH" ? "#ffd93d" : s === "NEUTRAL" ? "#ff8c42" : "#ff4444";
const plCol = v => v > 0 ? "#00ff88" : v < 0 ? "#ff4444" : "#ffffff50";

// ─── API Layer ───
async function fetchQuote(sym, key) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`);
  if (!r.ok) throw new Error(`Quote error ${r.status}`);
  return r.json();
}
async function fetchCandles(sym, key) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 90 * 86400;
  const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}&token=${key}`);
  if (!r.ok) throw new Error(`Candle error ${r.status}`);
  const d = await r.json();
  if (d.s !== "ok" || !d.c) return null;
  return d.c.map((c, i) => ({ c, h: d.h[i], l: d.l[i], o: d.o[i], v: d.v[i], t: d.t[i] }));
}

// ─── Main ───
export default function LiveSwingSimulator() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("market");
  const [sel, setSel] = useState("SPY");
  const [quotes, setQuotes] = useState({});
  const [candles, setCandles] = useState({});
  const [analyses, setAnalyses] = useState({});
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [keyInput, setKeyInput] = useState("");
  const [setupMode, setSetupMode] = useState(true);
  const refreshRef = useRef(null);
  const candleRef = useRef({});

  const showToast = (msg, type = "info") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  useEffect(() => {
    (async () => {
      const s = await load();
      const st = s || { ...INIT };
      setState(st);
      if (st.apiKey) { setKeyInput(st.apiKey); setSetupMode(false); }
      setLoading(false);
    })();
  }, []);

  const connectApi = async (key) => {
    if (!key.trim()) return;
    setLoading(true);
    setFetchErr(null);
    try {
      await fetchQuote("AAPL", key.trim());
      setState(prev => { const s = { ...prev, apiKey: key.trim() }; save(s); return s; });
      setSetupMode(false);
      showToast("Connected to Finnhub", "success");
    } catch (e) {
      setFetchErr("Invalid API key or connection error. Check your key and try again.");
    }
    setLoading(false);
  };

  const fetchAll = useCallback(async () => {
    if (!state?.apiKey) return;
    setFetchErr(null);
    try {
      const qPromises = TICKERS.map(t => fetchQuote(t, state.apiKey).then(q => [t, q]).catch(() => [t, null]));
      const qResults = await Promise.all(qPromises);
      const newQ = {};
      qResults.forEach(([t, q]) => { if (q && q.c) newQ[t] = q; });
      setQuotes(newQ);

      if (Object.keys(candleRef.current).length === 0) {
        const delay = (ms) => new Promise(r => setTimeout(r, ms));
        const newC = {};
        for (let i = 0; i < TICKERS.length; i++) {
          try {
            const c = await fetchCandles(TICKERS[i], state.apiKey);
            if (c) newC[TICKERS[i]] = c;
          } catch {}
          if (i < TICKERS.length - 1) await delay(150);
        }
        candleRef.current = newC;
        setCandles(newC);

        const newA = {};
        Object.entries(newC).forEach(([t, cData]) => { newA[t] = runAnalysis(cData); });
        setAnalyses(newA);
      } else {
        Object.entries(candleRef.current).forEach(([t, cData]) => {
          if (newQ[t]) {
            const last = cData[cData.length - 1];
            const today = new Date();
            const lastDate = new Date(last.t * 1000);
            if (today.toDateString() === lastDate.toDateString()) {
              cData[cData.length - 1] = { ...last, c: newQ[t].c, h: Math.max(last.h, newQ[t].h), l: Math.min(last.l, newQ[t].l) };
            }
          }
        });
        setCandles({ ...candleRef.current });
        const newA = {};
        Object.entries(candleRef.current).forEach(([t, cData]) => { newA[t] = runAnalysis(cData); });
        setAnalyses(newA);
      }

      setState(prev => {
        if (!prev) return prev;
        const updPos = prev.positions.map(p => {
          const q = newQ[p.ticker];
          if (!q) return p;
          const spot = q.c;
          const op = optPrice(spot, p.strike, Math.max(0, p.dte - ((Date.now() - p.entryTime) / 864e5)), p.iv, p.type);
          const gr = optGreeks(spot, p.strike, Math.max(0, p.dte - ((Date.now() - p.entryTime) / 864e5)), p.iv, p.type);
          return { ...p, curOptPrice: op, curSpot: spot, curDelta: gr.delta, curTheta: gr.theta, dteLeft: Math.max(0, p.dte - Math.floor((Date.now() - p.entryTime) / 864e5)) };
        });
        const s = { ...prev, positions: updPos };
        save(s);
        return s;
      });

      setLastUpdate(new Date());
    } catch (e) {
      setFetchErr("Data fetch error — will retry. Check API key or rate limits.");
    }
  }, [state?.apiKey]);

  useEffect(() => {
    if (setupMode || !state?.apiKey) return;
    fetchAll();
    refreshRef.current = setInterval(fetchAll, 30000);
    return () => clearInterval(refreshRef.current);
  }, [setupMode, state?.apiKey, fetchAll]);

  const executeTrade = (ticker, type, strike, dte, qty) => {
    const q = quotes[ticker];
    if (!q) return;
    const spot = q.c;
    const iv = 0.3;
    const premium = optPrice(spot, strike, dte, iv, type);
    const cost = premium * qty * 100;
    if (cost > state.cash) { showToast("Insufficient funds", "error"); return; }
    const pos = {
      id: Date.now(), ticker, type, strike, dte, qty, iv,
      entryPremium: premium, curOptPrice: premium,
      entrySpot: spot, curSpot: spot,
      entryTime: Date.now(), dteLeft: dte,
      curDelta: optGreeks(spot, strike, dte, iv, type).delta,
      curTheta: optGreeks(spot, strike, dte, iv, type).theta,
    };
    setState(prev => { const s = { ...prev, cash: prev.cash - cost, positions: [...prev.positions, pos] }; save(s); return s; });
    showToast(`Bought ${qty}x ${ticker} $${strike} ${type.toUpperCase()} @ $${premium}`, "success");
    setModal(null);
  };

  const closePos = (id) => {
    setState(prev => {
      const pos = prev.positions.find(p => p.id === id);
      if (!pos) return prev;
      const proceeds = pos.curOptPrice * pos.qty * 100;
      const pnl = +((pos.curOptPrice - pos.entryPremium) * pos.qty * 100).toFixed(2);
      const entry = {
        id: Date.now(), ticker: pos.ticker, type: pos.type, strike: pos.strike,
        entryP: pos.entryPremium, exitP: pos.curOptPrice, qty: pos.qty, pnl,
        entryTime: pos.entryTime, exitTime: Date.now(),
      };
      const s = { ...prev, cash: prev.cash + proceeds, positions: prev.positions.filter(p => p.id !== id), history: [...prev.history, entry] };
      save(s);
      showToast(`Closed ${pos.ticker} for ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`, pnl >= 0 ? "success" : "error");
      return s;
    });
  };

  const resetSim = async () => {
    const s = { ...INIT, apiKey: state.apiKey };
    setState(s);
    await save(s);
    showToast("Portfolio reset to $25k", "info");
  };

  const disconnectApi = async () => {
    clearInterval(refreshRef.current);
    setQuotes({}); setCandles({}); setAnalyses({});
    candleRef.current = {};
    setState(prev => { const s = { ...prev, apiKey: "" }; save(s); return s; });
    setSetupMode(true);
    setKeyInput("");
  };

  if (loading && !state) return <Shell><div style={{ textAlign: "center", padding: 60, color: "#ffffff30" }}>Loading...</div></Shell>;

  if (setupMode) return (
    <Shell>
      <div style={{ maxWidth: 480, margin: "60px auto", textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "#00ff8880", letterSpacing: 3, marginBottom: 12 }}>LIVE DATA SETUP</div>
        <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 28, fontWeight: 700, color: "#fff", marginBottom: 8 }}>SRx Swing Simulator</h1>
        <p style={{ fontSize: 12, color: "#ffffff45", lineHeight: 1.7, marginBottom: 28 }}>
          Connect to live market data via Finnhub's free API. Get your free key in 30 seconds — no credit card needed.
        </p>
        <a href="https://finnhub.io/register" target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", padding: "10px 24px", background: "#ffffff0a", border: "1px solid #ffffff15", borderRadius: 8, color: "#00ff88", fontSize: 12, textDecoration: "none", marginBottom: 20, transition: "all .15s" }}>
          Get Free API Key →  finnhub.io/register
        </a>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input value={keyInput} onChange={e => setKeyInput(e.target.value)} onKeyDown={e => e.key === "Enter" && connectApi(keyInput)}
            placeholder="Paste your Finnhub API key" style={{ flex: 1, padding: "12px 16px", background: "#ffffff08", border: "1px solid #ffffff15", borderRadius: 8, color: "#fff", fontFamily: "inherit", fontSize: 13, outline: "none" }} />
          <button onClick={() => connectApi(keyInput)} disabled={loading}
            style={{ padding: "12px 24px", background: "#00ff8818", border: "1px solid #00ff8840", borderRadius: 8, color: "#00ff88", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {loading ? "Connecting..." : "Connect"}
          </button>
        </div>
        {fetchErr && <div style={{ fontSize: 11, color: "#ff4444", marginTop: 8, padding: "8px 12px", background: "#ff444412", borderRadius: 6 }}>{fetchErr}</div>}
        <div style={{ marginTop: 32, textAlign: "left" }}>
          <div style={{ fontSize: 10, color: "#ffffff30", letterSpacing: 2, marginBottom: 10 }}>HOW IT WORKS</div>
          {["Sign up at finnhub.io (free, 30 seconds)", "Copy your API key from the dashboard", "Paste it above — that's it", "Real quotes refresh every 30 seconds", "Paper trade with $25k virtual capital"].map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, fontSize: 12, color: "#ffffff50" }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#ffffff08", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#00ff88", flexShrink: 0 }}>{i + 1}</span>
              {s}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );

  const posVal = state.positions.reduce((s, p) => s + p.curOptPrice * p.qty * 100, 0);
  const equity = state.cash + posVal;
  const totalPnl = equity - state.deposited;
  const wins = state.history.filter(h => h.pnl > 0).length;
  const losses = state.history.filter(h => h.pnl <= 0).length;
  const winRate = state.history.length > 0 ? ((wins / state.history.length) * 100).toFixed(0) : "—";
  const realized = state.history.reduce((s, h) => s + h.pnl, 0);
  const selA = analyses[sel];

  const mktOpen = (() => {
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay(), h = et.getHours(), m = et.getMinutes();
    return day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 30)) && h < 16;
  })();

  return (
    <Shell>
      {toast && <div style={{ position: "fixed", top: 16, right: 16, padding: "10px 18px", borderRadius: 8, fontSize: 12, zIndex: 1000, animation: "slideIn .3s ease", fontFamily: "inherit", background: toast.type === "success" ? "#00ff8820" : toast.type === "error" ? "#ff444420" : "#ffffff15", border: `1px solid ${toast.type === "success" ? "#00ff8840" : toast.type === "error" ? "#ff444440" : "#ffffff20"}`, color: toast.type === "success" ? "#00ff88" : toast.type === "error" ? "#ff4444" : "#ffffffcc" }}>{toast.msg}</div>}

      {modal && <TradeModal ticker={modal} quote={quotes[modal]} analysis={analyses[modal]} cash={state.cash} onExec={executeTrade} onClose={() => setModal(null)} />}

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "18px 16px", position: "relative" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: mktOpen ? "#00ff88" : "#ff8c42", animation: mktOpen ? "pulse 2s infinite" : "none" }} />
              <span style={{ fontSize: 9, color: "#ffffff45", letterSpacing: 3 }}>
                {mktOpen ? "MARKET OPEN" : "MARKET CLOSED"} · LIVE DATA
                {lastUpdate && <span style={{ color: "#ffffff25" }}> · {lastUpdate.toLocaleTimeString()}</span>}
              </span>
            </div>
            <h1 style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>SRx Swing Simulator</h1>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="btn" onClick={fetchAll}>↻ Refresh</button>
            <button className="btn" onClick={resetSim}>Reset $</button>
            <button className="btn" onClick={disconnectApi} style={{ color: "#ff8c42", borderColor: "#ff8c4230" }}>Disconnect</button>
          </div>
        </div>

        {fetchErr && <div style={{ fontSize: 11, color: "#ff8c42", padding: "8px 14px", background: "#ff8c4210", borderRadius: 7, marginBottom: 14, border: "1px solid #ff8c4220" }}>{fetchErr}</div>}

        {/* Equity Strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
          {[
            { l: "EQUITY", v: `$${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, c: "#fff" },
            { l: "P&L", v: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)} (${((totalPnl / state.deposited) * 100).toFixed(1)}%)`, c: plCol(totalPnl) },
            { l: "CASH", v: `$${state.cash.toFixed(0)}`, c: "#ffffff80" },
            { l: "WIN RATE", v: `${winRate}%`, c: wins >= losses ? "#00ff88" : "#ff8c42" },
            { l: "TRADES", v: state.history.length, c: "#ffffff60" },
          ].map((m, i) => (
            <div className="card" key={i} style={{ padding: "8px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 8, color: "#ffffff25", letterSpacing: 2, marginBottom: 3 }}>{m.l}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: m.c }}>{m.v}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #ffffff08", marginBottom: 16 }}>
          {[["market", "◈ Market"], ["positions", `◉ Positions (${state.positions.length})`], ["analyzer", "◎ Analyzer"], ["journal", `▤ Journal (${state.history.length})`]].map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        {/* ─── MARKET ─── */}
        {tab === "market" && (
          <div style={{ animation: "fadeUp .35s ease" }}>
            {Object.keys(quotes).length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 50, color: "#ffffff30" }}>
                <div style={{ marginBottom: 8, fontSize: 24 }}>⟳</div>Fetching live quotes...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "grid", gridTemplateColumns: "50px 72px 58px 48px 1fr 80px 55px 62px", gap: 8, padding: "4px 14px", fontSize: 8, color: "#ffffff20", letterSpacing: 1 }}>
                  <span>SYM</span><span>PRICE</span><span>CHG %</span><span>VOL R</span><span>CHART</span><span>SIGNAL</span><span>SCORE</span><span></span>
                </div>
                {TICKERS.map(t => {
                  const q = quotes[t]; const a = analyses[t];
                  if (!q) return null;
                  const chg = q.dp?.toFixed(2) || "0.00";
                  return (
                    <div key={t} className="card" style={{ padding: "8px 14px", display: "grid", gridTemplateColumns: "50px 72px 58px 48px 1fr 80px 55px 62px", alignItems: "center", gap: 8, cursor: "pointer", transition: "background .12s" }}
                      onClick={() => { setSel(t); setTab("analyzer"); }}
                      onMouseEnter={e => e.currentTarget.style.background = "#ffffff05"}
                      onMouseLeave={e => e.currentTarget.style.background = "#0f0f17"}>
                      <span style={{ fontWeight: 700, fontSize: 12, color: "#fff" }}>{t}</span>
                      <span style={{ fontSize: 12, color: "#ffffffcc" }}>${q.c?.toFixed(2)}</span>
                      <span style={{ fontSize: 11, color: chg >= 0 ? "#00ff88" : "#ff4444" }}>{chg >= 0 ? "+" : ""}{chg}%</span>
                      <span style={{ fontSize: 10, color: a?.vr > 1.15 ? "#00ff88" : "#ffffff45" }}>{a?.vr?.toFixed(1) || "—"}x</span>
                      <div style={{ overflow: "hidden", height: 28 }}><PriceChart closes={a?.closes?.slice(-40)} height={28} /></div>
                      <span style={{ fontSize: 9, color: sigCol(a?.signal || ""), background: `${sigCol(a?.signal || "")}10`, padding: "3px 7px", borderRadius: 5, textAlign: "center", border: `1px solid ${sigCol(a?.signal || "")}20`, fontWeight: 600 }}>{a?.signal || "..."}</span>
                      <span style={{ fontSize: 12, textAlign: "center", fontWeight: 600, color: sigCol(a?.signal || "") }}>{a?.score || "—"}</span>
                      <button className="btn btn-green" style={{ fontSize: 9, padding: "4px 8px" }} onClick={e => { e.stopPropagation(); setSel(t); setModal(t); }}>Trade</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── POSITIONS ─── */}
        {tab === "positions" && (
          <div style={{ animation: "fadeUp .35s ease" }}>
            {state.positions.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 44, color: "#ffffff25" }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>◌</div>No open positions
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {state.positions.map(p => {
                  const pnl = +((p.curOptPrice - p.entryPremium) * p.qty * 100).toFixed(2);
                  const pnlPct = ((p.curOptPrice / p.entryPremium - 1) * 100).toFixed(1);
                  return (
                    <div key={p.id} className="card" style={{ padding: "12px 16px" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", alignItems: "center", gap: 10 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>{p.ticker}</div>
                          <div style={{ fontSize: 10, color: "#ffffff40" }}>${p.strike} {p.type.toUpperCase()} · {p.dteLeft}d left</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "#ffffff25" }}>QTY × PREMIUM</div>
                          <div style={{ fontSize: 12 }}>{p.qty} × ${p.curOptPrice?.toFixed(2)}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "#ffffff25" }}>SPOT</div>
                          <div style={{ fontSize: 12 }}>${p.entrySpot?.toFixed(2)} → ${p.curSpot?.toFixed(2)}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "#ffffff25" }}>P&L</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: plCol(pnl) }}>{pnl >= 0 ? "+" : ""}${pnl} ({pnlPct}%)</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <div style={{ textAlign: "center", fontSize: 9, color: "#ffffff35" }}>Δ{p.curDelta}<br />θ{p.curTheta}</div>
                          <button className="btn btn-red" style={{ fontSize: 10, padding: "5px 10px" }} onClick={() => closePos(p.id)}>Close</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ─── ANALYZER ─── */}
        {tab === "analyzer" && (
          <div style={{ animation: "fadeUp .35s ease" }}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 14 }}>
              {TICKERS.map(t => <button key={t} className={`btn ${sel === t ? "btn-green" : ""}`} onClick={() => setSel(t)}>{t}</button>)}
            </div>
            {!selA ? (
              <div className="card" style={{ textAlign: "center", padding: 40, color: "#ffffff30" }}>Loading analysis for {sel}...</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, marginBottom: 12 }}>
                  <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <div style={{ fontSize: 10, color: "#ffffff30", letterSpacing: 2 }}>{sel}</div>
                    <Ring val={selA.score} />
                    <div style={{ fontSize: 11, fontWeight: 700, color: sigCol(selA.signal), padding: "3px 12px", background: `${sigCol(selA.signal)}12`, borderRadius: 6, border: `1px solid ${sigCol(selA.signal)}25` }}>{selA.signal}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginTop: 2 }}>${selA.price.toFixed(2)}</div>
                    <div style={{ fontSize: 10, color: quotes[sel]?.dp >= 0 ? "#00ff88" : "#ff4444" }}>{quotes[sel]?.dp >= 0 ? "+" : ""}{quotes[sel]?.dp?.toFixed(2)}% today</div>
                    <button className="btn btn-green" style={{ marginTop: 4 }} onClick={() => setModal(sel)}>Open Trade</button>
                  </div>
                  <div className="card">
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 9, color: "#ffffff30", letterSpacing: 1 }}>90-DAY PRICE · VOLUME · EMAs</span>
                      <div style={{ display: "flex", gap: 8, fontSize: 8, color: "#ffffff35" }}>
                        <span><span style={{ color: "#00ff88" }}>━</span> Price</span><span><span style={{ color: "#4ecdc4" }}>━</span> 8</span><span><span style={{ color: "#ff6b35" }}>━</span> 21</span>
                      </div>
                    </div>
                    <PriceChart closes={selA.closes} emaLines={selA.emaLines} height={115} />
                    <VolChart vols={selA.volumes?.slice(-50)} height={28} />
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 12 }}>
                  {[
                    { l: "EMA SPREAD", v: `${selA.spread.toFixed(2)}%`, c: selA.spread > 0 ? "#00ff88" : "#ff4444" },
                    { l: "VOL RATIO", v: `${selA.vr.toFixed(2)}x`, c: selA.vr > 1.15 ? "#00ff88" : "#ffffff60" },
                    { l: "RSI(14)", v: selA.rsi.toFixed(1), c: selA.rsi > 70 ? "#ff4444" : selA.rsi < 30 ? "#ffd93d" : "#00ff88" },
                    { l: "ATR %", v: `${selA.atrPct.toFixed(2)}%`, c: "#ffffff70" },
                    { l: "R:R", v: `${selA.rr}:1`, c: "#ffd93d" },
                  ].map((m, i) => (
                    <div className="card" key={i} style={{ padding: "7px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 7, color: "#ffffff22", letterSpacing: 2, marginBottom: 2 }}>{m.l}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: m.c }}>{m.v}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div className="card">
                    <div style={{ fontSize: 9, color: "#ffffff30", letterSpacing: 2, marginBottom: 10 }}>SIGNALS</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {selA.sigs.map((s, i) => (
                        <div key={i} style={{ fontSize: 10, padding: "4px 9px", borderRadius: 5, background: s.t === "bull" ? "#00ff880c" : s.t === "bear" ? "#ff44440c" : s.t === "warn" ? "#ffd93d0c" : "#ffffff06", color: s.t === "bull" ? "#00ff88" : s.t === "bear" ? "#ff4444" : s.t === "warn" ? "#ffd93d" : "#ffffff55", border: `1px solid ${s.t === "bull" ? "#00ff8815" : s.t === "bear" ? "#ff444415" : "#ffffff08"}` }}>
                          <span style={{ fontSize: 7, opacity: .45, marginRight: 5 }}>{"●".repeat(s.w)}{"○".repeat(3 - s.w)}</span>{s.text}
                        </div>
                      ))}
                      {selA.sigs.length === 0 && <div style={{ color: "#ffffff20", fontSize: 11 }}>No signals</div>}
                    </div>
                  </div>
                  <div className="card">
                    <div style={{ fontSize: 9, color: "#ffffff30", letterSpacing: 2, marginBottom: 10 }}>TRADE PLAN</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 11 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#ffffff35" }}>EMAs</span><span><span style={{ color: "#4ecdc4" }}>8:</span>${selA.ema8v.toFixed(1)} <span style={{ color: "#ff6b35" }}>21:</span>${selA.ema21v.toFixed(1)} <span style={{ color: "#9b59b6" }}>50:</span>${selA.ema50v.toFixed(1)}</span></div>
                      <div style={{ height: 1, background: "#ffffff06" }} />
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#ff444480" }}>Stop (1.5 ATR)</span><span style={{ color: "#ff4444" }}>${selA.stop}</span></div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#00ff8880" }}>Target 1 (2R)</span><span style={{ color: "#00ff88" }}>${selA.t1}</span></div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#00ff8880" }}>Target 2 (3R)</span><span style={{ color: "#00ff88" }}>${selA.t2}</span></div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ─── JOURNAL ─── */}
        {tab === "journal" && (
          <div style={{ animation: "fadeUp .35s ease" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
              {[
                { l: "REALIZED", v: `${realized >= 0 ? "+" : ""}$${realized.toFixed(0)}`, c: plCol(realized) },
                { l: "WIN / LOSS", v: `${wins}W — ${losses}L`, c: "#ffffff70" },
                { l: "AVG WIN", v: wins > 0 ? `+$${(state.history.filter(h => h.pnl > 0).reduce((s, h) => s + h.pnl, 0) / wins).toFixed(0)}` : "—", c: "#00ff88" },
                { l: "AVG LOSS", v: losses > 0 ? `$${(state.history.filter(h => h.pnl <= 0).reduce((s, h) => s + h.pnl, 0) / losses).toFixed(0)}` : "—", c: "#ff4444" },
              ].map((m, i) => (
                <div className="card" key={i} style={{ padding: "8px 12px", textAlign: "center" }}>
                  <div style={{ fontSize: 7, color: "#ffffff22", letterSpacing: 2, marginBottom: 3 }}>{m.l}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: m.c }}>{m.v}</div>
                </div>
              ))}
            </div>
            {state.history.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 44, color: "#ffffff20" }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>▤</div>Trade history appears here once you close positions
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[...state.history].reverse().map(h => (
                  <div key={h.id} className="card" style={{ padding: "9px 14px", display: "grid", gridTemplateColumns: "50px 70px 70px 70px 70px 80px 1fr", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 12, color: "#fff" }}>{h.ticker}</span>
                    <span style={{ fontSize: 10, color: h.type === "call" ? "#00ff88" : "#ff6b35", background: h.type === "call" ? "#00ff880e" : "#ff6b350e", padding: "2px 7px", borderRadius: 4, textAlign: "center" }}>{h.type.toUpperCase()}</span>
                    <span style={{ fontSize: 11, color: "#ffffff70" }}>${h.strike}</span>
                    <span style={{ fontSize: 11, color: "#ffffff50" }}>${h.entryP.toFixed(2)}</span>
                    <span style={{ fontSize: 11, color: "#ffffff50" }}>${h.exitP.toFixed(2)}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: plCol(h.pnl) }}>{h.pnl >= 0 ? "+" : ""}${h.pnl.toFixed(0)}</span>
                    <span style={{ fontSize: 10, color: "#ffffff30", textAlign: "right" }}>{new Date(h.exitTime).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 28, padding: "12px 0", borderTop: "1px solid #ffffff06", textAlign: "center", fontSize: 8, color: "#ffffff12", letterSpacing: 1 }}>
          PAPER TRADING ONLY · NOT FINANCIAL ADVICE · LIVE DATA VIA FINNHUB
        </div>
      </div>
    </Shell>
  );
}

// ─── Shell wrapper ───
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#08080d", color: "#e0e0e0", fontFamily: "'JetBrains Mono','SF Mono',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#08080d}::-webkit-scrollbar-thumb{background:#ffffff10;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
        @keyframes slideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
        .card{background:#0f0f17;border:1px solid #ffffff08;border-radius:9px;padding:14px;position:relative}
        .card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#ffffff0c,transparent)}
        .btn{padding:6px 12px;background:#ffffff08;border:1px solid #ffffff10;border-radius:6px;color:#ffffff70;font-family:inherit;font-size:11px;cursor:pointer;transition:all .12s;font-weight:500}
        .btn:hover{background:#ffffff14;color:#fff}
        .btn-green{background:#00ff8812;border-color:#00ff8830;color:#00ff88}.btn-green:hover{background:#00ff8822}
        .btn-red{background:#ff444412;border-color:#ff444430;color:#ff4444}.btn-red:hover{background:#ff444422}
        .tab{padding:8px 14px;background:none;border:none;color:#ffffff35;font-family:inherit;font-size:11px;cursor:pointer;border-bottom:2px solid transparent;transition:all .12s}
        .tab:hover{color:#ffffff80}.tab.on{color:#00ff88;border-bottom-color:#00ff88}
      `}</style>
      <div style={{ position: "fixed", inset: 0, background: "radial-gradient(ellipse at 15% 0%,#00ff8806 0%,transparent 50%),radial-gradient(ellipse at 85% 100%,#4ecdc406 0%,transparent 50%)", pointerEvents: "none" }} />
      {children}
    </div>
  );
}

// ─── Trade Execution Modal ───
function TradeModal({ ticker, quote, analysis, cash, onExec, onClose }) {
  const [type, setType] = useState("call");
  const [dte, setDte] = useState(14);
  const [qty, setQty] = useState(1);
  const [strikeOff, setStrikeOff] = useState(0);

  const spot = quote?.c || 100;
  const step = spot > 200 ? 5 : spot > 50 ? 2 : 1;
  const strikes = [];
  for (let i = -5; i <= 5; i++) strikes.push(Math.round(spot / step) * step + i * step);
  const strike = Math.round(spot / step) * step + strikeOff;
  const iv = 0.3;
  const prem = optPrice(spot, strike, dte, iv, type);
  const cost = prem * qty * 100;
  const gr = optGreeks(spot, strike, dte, iv, type);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div className="card" style={{ width: 430, padding: 22, animation: "fadeUp .25s ease", background: "#11111b", border: "1px solid #ffffff15" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 17, fontWeight: 700, color: "#fff" }}>Trade {ticker}</div>
            <div style={{ fontSize: 10, color: "#ffffff40" }}>
              Live: ${spot.toFixed(2)} · Signal: <span style={{ color: sigCol(analysis?.signal || "") }}>{analysis?.signal || "—"}</span>
            </div>
          </div>
          <button style={{ background: "none", border: "none", color: "#ffffff40", fontSize: 18, cursor: "pointer" }} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 8, color: "#ffffff25", marginBottom: 3, letterSpacing: 1 }}>TYPE</div>
            <div style={{ display: "flex", gap: 5 }}>
              <button className={`btn ${type === "call" ? "btn-green" : ""}`} onClick={() => setType("call")} style={{ flex: 1 }}>CALL ↑</button>
              <button className={`btn ${type === "put" ? "btn-red" : ""}`} onClick={() => setType("put")} style={{ flex: 1 }}>PUT ↓</button>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 8, color: "#ffffff25", marginBottom: 3, letterSpacing: 1 }}>CONTRACTS</div>
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <button className="btn" onClick={() => setQty(Math.max(1, qty - 1))} style={{ padding: "5px 9px" }}>−</button>
              <div style={{ flex: 1, textAlign: "center", fontSize: 17, fontWeight: 700 }}>{qty}</div>
              <button className="btn" onClick={() => setQty(qty + 1)} style={{ padding: "5px 9px" }}>+</button>
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 8, color: "#ffffff25", marginBottom: 4, letterSpacing: 1 }}>STRIKE</div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {strikes.map(s => (
              <button key={s} className={`btn ${s === strike ? "btn-green" : ""}`} onClick={() => setStrikeOff(s - Math.round(spot / step) * step)} style={{ fontSize: 9, padding: "4px 7px", minWidth: 44 }}>
                ${s}{Math.abs(s - spot) < step ? " ≈" : ""}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 8, color: "#ffffff25", marginBottom: 4, letterSpacing: 1 }}>EXPIRY (DTE)</div>
          <div style={{ display: "flex", gap: 5 }}>
            {[7, 14, 21, 30, 45].map(d => <button key={d} className={`btn ${dte === d ? "btn-green" : ""}`} onClick={() => setDte(d)} style={{ flex: 1, fontSize: 10 }}>{d}d</button>)}
          </div>
        </div>

        <div className="card" style={{ background: "#0a0a10", marginBottom: 14, padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center", fontSize: 10 }}>
            <div><div style={{ fontSize: 7, color: "#ffffff20", letterSpacing: 1 }}>PREMIUM</div><div style={{ fontWeight: 700, fontSize: 15 }}>${prem.toFixed(2)}</div></div>
            <div><div style={{ fontSize: 7, color: "#ffffff20", letterSpacing: 1 }}>TOTAL COST</div><div style={{ fontWeight: 700, fontSize: 15, color: cost > cash ? "#ff4444" : "#fff" }}>${cost.toFixed(0)}</div></div>
            <div><div style={{ fontSize: 7, color: "#ffffff20", letterSpacing: 1 }}>Δ / θ</div><div style={{ fontWeight: 600, fontSize: 12 }}>{gr.delta} / {gr.theta}</div></div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button className={`btn ${type === "call" ? "btn-green" : "btn-red"}`} disabled={cost > cash}
            onClick={() => onExec(ticker, type, strike, dte, qty)}
            style={{ flex: 2, fontSize: 12, padding: 9, fontWeight: 700 }}>
            {cost > cash ? "Insufficient Funds" : `Buy ${qty}× $${strike} ${type.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
