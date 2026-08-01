const listFrom = value => {
  const body = value?.data ?? value;
  if (Array.isArray(body)) return body;
  for (const key of ["results", "instruments", "option_instruments", "options", "contracts"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
};

const idFrom = value => {
  const raw = String(value?.id || value?.option_id || value?.instrument_id
    || value?.instrument || value?.instrument_url || value?.url || "").replace(/\/+$/, "");
  return raw ? raw.split("/").pop() : null;
};

const numberFrom = (value, ...keys) => {
  for (const key of keys) {
    const parsed = Number(value?.[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export function normalizeRobinhoodOptionChain(instrumentResponse, marketDataResponse, {
  symbol,
  spot = null,
  now = Date.now(),
  minDte = 14,
  maxDte = 45,
} = {}) {
  const instruments = listFrom(instrumentResponse);
  const quotes = listFrom(marketDataResponse);
  const quotesById = new Map();
  for (const quoteRow of quotes) {
    const quote = { ...quoteRow, ...(quoteRow?.quote || {}), ...(quoteRow?.market_data || {}) };
    const id = idFrom(quote);
    if (id) quotesById.set(id, quote);
  }

  const expirations = new Map();
  for (const instrument of instruments) {
    const ticker = String(instrument.chain_symbol || instrument.symbol || symbol || "").toUpperCase();
    if (symbol && ticker && ticker !== String(symbol).toUpperCase()) continue;
    const expirationDate = String(instrument.expiration_date || instrument.expiration || "").slice(0, 10);
    const expiryMs = Date.parse(`${expirationDate}T16:00:00-04:00`);
    const dte = Math.round((expiryMs - now) / 86_400_000);
    if (!expirationDate || dte < minDte || dte > maxDte) continue;
    const strike = numberFrom(instrument, "strike_price", "strike");
    if (!(strike > 0)) continue;
    if (spot > 0 && (strike < spot * 0.80 || strike > spot * 1.20)) continue;
    const type = String(instrument.type || instrument.option_type || "").toUpperCase();
    if (type !== "CALL" && type !== "PUT") continue;
    const id = idFrom(instrument);
    const quote = id ? quotesById.get(id) : null;
    if (!quote) continue;
    const bid = numberFrom(quote, "bid_price", "bid", "best_bid_price");
    const ask = numberFrom(quote, "ask_price", "ask", "best_ask_price");
    if (!(bid > 0) || !(ask >= bid)) continue;
    const greeks = quote.greeks || {};
    const row = {
      symbol: instrument.occ_symbol || instrument.symbol || null,
      optionId: id,
      strike,
      bid,
      ask,
      openInterest: numberFrom(quote, "open_interest", "openInterest") || 0,
      volume: numberFrom(quote, "volume") || 0,
      impliedVolatility: numberFrom(quote, "implied_volatility", "iv") || null,
      delta: numberFrom(quote, "delta") ?? numberFrom(greeks, "delta"),
      gamma: numberFrom(quote, "gamma") ?? numberFrom(greeks, "gamma"),
      theta: numberFrom(quote, "theta") ?? numberFrom(greeks, "theta"),
      vega: numberFrom(quote, "vega") ?? numberFrom(greeks, "vega"),
    };
    if (!expirations.has(expirationDate)) {
      expirations.set(expirationDate, {
        expirationDate,
        dataSource: "robinhood",
        options: { CALL: [], PUT: [] },
      });
    }
    expirations.get(expirationDate).options[type].push(row);
  }
  return [...expirations.values()].sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
}

export function robinhoodChainInstrumentIds(instrumentResponse, {
  symbol,
  spot = null,
  now = Date.now(),
  minDte = 14,
  maxDte = 45,
  limit = 400,
} = {}) {
  return listFrom(instrumentResponse)
    .filter(instrument => {
      const ticker = String(instrument.chain_symbol || instrument.symbol || symbol || "").toUpperCase();
      const expirationDate = String(instrument.expiration_date || instrument.expiration || "").slice(0, 10);
      const expiryMs = Date.parse(`${expirationDate}T16:00:00-04:00`);
      const dte = Math.round((expiryMs - now) / 86_400_000);
      const strike = numberFrom(instrument, "strike_price", "strike");
      return (!symbol || !ticker || ticker === String(symbol).toUpperCase())
        && dte >= minDte && dte <= maxDte
        && strike > 0
        && (!(spot > 0) || (strike >= spot * 0.80 && strike <= spot * 1.20));
    })
    .map(idFrom)
    .filter(Boolean)
    .slice(0, limit);
}
