import { safeFetch } from "../collect/fetchGuard.mjs";

// Yahoo returns 429 to UA-less requests, so a browser-like UA is load-bearing, not cosmetic.
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Market hosts are code-pinned (SPEC §9 invariant 6): unlike news feeds these are never
// user-configurable, and every market fetch asserts against this set before safeFetch runs.
export const MARKET_HOSTS = new Set(["query1.finance.yahoo.com", "query2.finance.yahoo.com"]);

const RETRY_HOST = "query2.finance.yahoo.com";
const CHART_TIMEOUT_MS = 20000;
const FULL_FETCH_LASTFULL_DAYS = 30;
const FULL_FETCH_GAP_WEEKDAYS = 25;
const COOLDOWN_MINUTES = 30; // tunable guess, not a derived figure
const DISCREPANCY_TOLERANCE = 0.005;

export function assertMarketHost(urlString) {
  const host = new URL(urlString).hostname;
  if (!MARKET_HOSTS.has(host)) {
    throw new Error(`Market fetch blocked: "${host}" is not an allowed market data host.`);
  }
}

export function benchmarksFor(settings) {
  const eurSymbol = settings && settings.market && typeof settings.market.benchmarkEUR === "string"
    ? settings.market.benchmarkEUR
    : "^GDAXI";
  return [
    { symbol: eurSymbol, currency: "EUR" },
    { symbol: "^GSPC", currency: "USD" }
  ];
}

// Bars are keyed by exchange-local date. Naive UTC would shift US closes to the next day
// (a 22:00 UTC close is already "tomorrow" in UTC during DST edge cases) — verified against
// live gmtoffset values 7200 (XETRA) and -14400 (NYSE).
export function toExchangeDate(ts, gmtoffset) {
  return new Date((Number(ts) + (Number(gmtoffset) || 0)) * 1000).toISOString().slice(0, 10);
}

export function parseChartResponse(json) {
  if (!json || typeof json !== "object" || !json.chart) {
    throw new Error("Malformed chart response");
  }
  if (json.chart.error) {
    throw new Error("Unknown symbol");
  }
  const result = Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!result || typeof result !== "object" || !result.meta) {
    throw new Error("Malformed chart response");
  }

  const meta = result.meta;
  const gmtoffset = Number(meta.gmtoffset) || 0;
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quoteBlock = result.indicators && Array.isArray(result.indicators.quote)
    ? result.indicators.quote[0] || {}
    : {};
  const rawCloses = Array.isArray(quoteBlock.close) ? quoteBlock.close : [];
  const adjBlock = result.indicators && Array.isArray(result.indicators.adjclose)
    ? result.indicators.adjclose[0]
    : null;
  const adjCloses = adjBlock && Array.isArray(adjBlock.adjclose) ? adjBlock.adjclose : null;

  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    // adjclose preferred (splits/dividends), per-bar fallback to the raw close — index
    // symbols and sparse bars can lack either.
    const adj = adjCloses ? adjCloses[i] : null;
    const close = adj !== null && adj !== undefined ? adj : rawCloses[i];
    if (close === null || close === undefined || !Number.isFinite(Number(close))) {
      continue;
    }
    bars.push({ date: toExchangeDate(timestamps[i], gmtoffset), close: Number(close) });
  }

  // The in-progress session bar is never persisted: the stored series is completed sessions
  // only (the delayed quote covers "today" in the UI). With currentTradingPeriod absent we
  // conservatively treat a last bar dated like the market time as in-progress.
  const marketTimeTs = Number(meta.regularMarketTime);
  if (bars.length && Number.isFinite(marketTimeTs)) {
    const lastBar = bars[bars.length - 1];
    if (lastBar.date === toExchangeDate(marketTimeTs, gmtoffset)) {
      const regularEnd = meta.currentTradingPeriod && meta.currentTradingPeriod.regular
        ? Number(meta.currentTradingPeriod.regular.end)
        : NaN;
      if (!Number.isFinite(regularEnd) || marketTimeTs < regularEnd) {
        bars.pop();
      }
    }
  }

  const price = Number(meta.regularMarketPrice);
  const shortName = typeof meta.shortName === "string" ? meta.shortName.trim() : "";
  return {
    symbol: typeof meta.symbol === "string" ? meta.symbol : "",
    currency: typeof meta.currency === "string" ? meta.currency : "",
    exchange: typeof meta.fullExchangeName === "string" && meta.fullExchangeName !== ""
      ? meta.fullExchangeName
      : (typeof meta.exchangeName === "string" ? meta.exchangeName : ""),
    name: typeof meta.longName === "string" && meta.longName !== "" ? meta.longName : shortName,
    quote: Number.isFinite(price)
      ? {
          price,
          marketTime: Number.isFinite(marketTimeTs) ? new Date(marketTimeTs * 1000).toISOString() : null
        }
      : null,
    bars
  };
}

// All market fetches (charts, probes, search) share one module-wide pacing gate so that
// onboarding bursts and review sessions cannot stampede Yahoo. The gate is a promise chain:
// concurrent callers serialize instead of racing past the same lastFetchAt reading.
let lastFetchAt = 0;
let paceQueue = Promise.resolve();

export function paceMarketFetch(throttleMs) {
  if (!throttleMs) {
    return Promise.resolve();
  }
  const turn = paceQueue.then(async () => {
    const wait = lastFetchAt + throttleMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastFetchAt = Date.now();
  });
  paceQueue = turn.catch(() => {});
  return turn;
}

function chartUrl(host, symbol, range) {
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
}

export async function fetchChart(symbol, { range = "1mo", throttleMs = 1000, fetchImpl = safeFetch } = {}) {
  await paceMarketFetch(throttleMs);

  let response;
  try {
    response = await requestChart("query1.finance.yahoo.com", symbol, range, fetchImpl);
  } catch (error) {
    if (error && (error.rateLimited || error.unknownSymbol)) {
      throw error;
    }
    // Network-level failure: one retry against the alternate host, paced like any fetch.
    await paceMarketFetch(throttleMs);
    response = await requestChart(RETRY_HOST, symbol, range, fetchImpl);
  }
  return response;
}

async function requestChart(host, symbol, range, fetchImpl) {
  const url = chartUrl(host, symbol, range);
  assertMarketHost(url);
  const response = await fetchImpl(url, {
    timeoutMs: CHART_TIMEOUT_MS,
    headers: { "user-agent": YAHOO_USER_AGENT, accept: "application/json" }
  });

  if (response.status === 429) {
    const error = new Error(`Rate-limited by Yahoo (429) for ${symbol}.`);
    error.rateLimited = true;
    throw error;
  }
  if (response.status === 404) {
    const error = new Error(`Symbol "${symbol}" is unknown at Yahoo (404).`);
    error.unknownSymbol = true;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Yahoo chart request for ${symbol} failed (HTTP ${response.status}).`);
  }

  let json;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new Error("Malformed chart response");
  }
  try {
    return parseChartResponse(json);
  } catch (error) {
    if (error.message === "Unknown symbol") {
      error.message = `Symbol "${symbol}" is unknown at Yahoo.`;
      error.unknownSymbol = true;
    }
    throw error;
  }
}

export async function probeSymbol(symbol, { throttleMs = 1000, fetchImpl = safeFetch } = {}) {
  try {
    const chart = await fetchChart(symbol, { range: "1d", throttleMs, fetchImpl });
    return {
      ok: true,
      meta: {
        symbol: chart.symbol || symbol,
        currency: chart.currency,
        exchange: chart.exchange,
        name: chart.name,
        price: chart.quote ? chart.quote.price : null
      }
    };
  } catch (error) {
    return { ok: false, reason: error.message, rateLimited: error.rateLimited === true };
  }
}

export function mergeSeries(existing, incoming, historyDays) {
  const map = new Map();
  const oldDates = existing && Array.isArray(existing.dates) ? existing.dates : [];
  const oldCloses = existing && Array.isArray(existing.closes) ? existing.closes : [];
  for (let i = 0; i < oldDates.length; i += 1) {
    map.set(oldDates[i], oldCloses[i]);
  }

  let discrepancy = false;
  const newDates = incoming && Array.isArray(incoming.dates) ? incoming.dates : [];
  const newCloses = incoming && Array.isArray(incoming.closes) ? incoming.closes : [];
  for (let i = 0; i < newDates.length; i += 1) {
    const date = newDates[i];
    const close = newCloses[i];
    if (map.has(date)) {
      const prior = map.get(date);
      if (Number.isFinite(prior) && prior !== 0 && Math.abs(close - prior) / Math.abs(prior) > DISCREPANCY_TOLERANCE) {
        // Overlapping close moved by more than 0.5% — retroactive split/dividend adjustment;
        // the caller heals with a full refetch.
        discrepancy = true;
      }
    }
    map.set(date, close);
  }

  const dates = [...map.keys()].sort();
  const keep = Math.max(0, dates.length - historyDays);
  const trimmed = dates.slice(keep);
  return {
    dates: trimmed,
    closes: trimmed.map((date) => map.get(date)),
    discrepancy
  };
}

// Weekday-aware staleness: a Friday bar seen on Monday morning is fresh (0 intervening
// weekdays); single holidays are absorbed; >2 missing weekdays means the series stopped.
export function isSeriesStale(lastBarDate, nowIso) {
  if (typeof lastBarDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastBarDate)) {
    return true;
  }
  const last = Date.parse(`${lastBarDate}T00:00:00Z`);
  const today = Date.parse(`${String(nowIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(last) || !Number.isFinite(today)) {
    return true;
  }
  let weekdays = 0;
  for (let t = last + 86400000; t < today; t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day >= 1 && day <= 5) {
      weekdays += 1;
    }
  }
  return weekdays > 2;
}

function weekdaysBetween(fromDate, toIso) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return Infinity;
  }
  let weekdays = 0;
  for (let t = from + 86400000; t < to; t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day >= 1 && day <= 5) {
      weekdays += 1;
    }
  }
  return weekdays;
}

function needsFullFetch(series, nowIso) {
  if (!series || !Array.isArray(series.dates) || series.dates.length === 0) {
    return true;
  }
  if (!series.lastFullAt) {
    return true;
  }
  const age = Date.parse(nowIso) - Date.parse(series.lastFullAt);
  if (!Number.isFinite(age) || age > FULL_FETCH_LASTFULL_DAYS * 86400000) {
    return true;
  }
  return weekdaysBetween(series.dates[series.dates.length - 1], nowIso) > FULL_FETCH_GAP_WEEKDAYS;
}

function fullRange(historyDays) {
  return historyDays > 260 ? "2y" : "1y";
}

// Runs OUTSIDE the store lock and never mutates its inputs. The caller applies the returned
// prices inside ONE store.update() and must drop symbols whose instrument was deleted
// mid-refresh (SPEC §9.1 caller contract).
export async function refreshPrices(market, settings, {
  fetchImpl = safeFetch,
  nowIso = new Date().toISOString(),
  throttleMs = 1000,
  signal
} = {}) {
  const startedAt = Date.now();
  const marketSettings = settings.market;
  const activeInstruments = market.instruments.filter((instrument) => !instrument.paused);
  const skipped = market.instruments.length - activeInstruments.length;

  const targets = activeInstruments.length === 0
    ? []
    : [
        ...benchmarksFor(settings).map((benchmark) => ({ symbol: benchmark.symbol, currency: benchmark.currency })),
        ...activeInstruments.map((instrument) => ({ symbol: instrument.ticker, currency: instrument.currency }))
      ];

  const prices = {};
  const failures = [];
  let updated = 0;
  let rateLimited = false;
  let aborted = false;
  let attempted = 0;

  for (const target of targets) {
    if (signal && signal.aborted) {
      aborted = true;
      break;
    }
    const existing = market.prices[target.symbol];
    attempted += 1;
    try {
      const full = needsFullFetch(existing, nowIso);
      let chart = await fetchChart(target.symbol, {
        range: full ? fullRange(marketSettings.historyDays) : "1mo",
        throttleMs,
        fetchImpl
      });
      let merged = mergeSeries(existing, barsToSeries(chart.bars), marketSettings.historyDays);
      let lastFullAt = full ? nowIso : (existing && existing.lastFullAt) || nowIso;

      if (merged.discrepancy && !full) {
        // Discrepancy heal: an overlapping close changed retroactively (split/dividend);
        // refetch the whole window now instead of waiting for the monthly full cycle.
        chart = await fetchChart(target.symbol, {
          range: fullRange(marketSettings.historyDays),
          throttleMs,
          fetchImpl
        });
        merged = mergeSeries(null, barsToSeries(chart.bars), marketSettings.historyDays);
        lastFullAt = nowIso;
      }

      prices[target.symbol] = {
        currency: chart.currency || target.currency || "",
        quote: chart.quote
          ? { price: chart.quote.price, marketTime: chart.quote.marketTime, exchange: chart.exchange }
          : (existing && existing.quote) || null,
        dates: merged.dates,
        closes: merged.closes,
        updatedAt: nowIso,
        lastFullAt,
        stale: false
      };
      updated += 1;
    } catch (error) {
      if (error && error.rateLimited) {
        rateLimited = true;
        failures.push({ ticker: target.symbol, message: error.message });
        break; // only rate limiting aborts the cycle; everything else continues
      }
      failures.push({ ticker: target.symbol, message: error.message });
    }
  }

  // A UA regression manifests as every single request 429ing from the first symbol on —
  // without this hint it reads as an eternal rate-limit loop.
  const everySymbol429 = rateLimited && updated === 0 && attempted === failures.length;
  const providerHealth = rateLimited
    ? {
        provider: "yahoo",
        ok: false,
        cooldownUntil: new Date(Date.parse(nowIso) + COOLDOWN_MINUTES * 60000).toISOString(),
        lastError: everySymbol429
          ? "429 from the first request — possibly a User-Agent block, not a rate limit."
          : failures[failures.length - 1].message,
        lastOkAt: market.providerHealth.lastOkAt
      }
    : {
        provider: "yahoo",
        ok: failures.length === 0,
        cooldownUntil: null,
        lastError: failures.length ? failures[failures.length - 1].message : null,
        lastOkAt: updated > 0 ? nowIso : market.providerHealth.lastOkAt
      };

  return {
    prices,
    logEntry: {
      at: nowIso,
      updated,
      skipped,
      failures,
      aborted,
      durationMs: Date.now() - startedAt
    },
    providerHealth
  };
}

function barsToSeries(bars) {
  return {
    dates: bars.map((bar) => bar.date),
    closes: bars.map((bar) => bar.close)
  };
}
