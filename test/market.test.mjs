import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_HOSTS,
  YAHOO_USER_AGENT,
  assertMarketHost,
  benchmarksFor,
  fetchChart,
  isSeriesStale,
  mergeSeries,
  parseChartResponse,
  probeSymbol,
  refreshPrices,
  toExchangeDate
} from "../lib/market/prices.mjs";
import {
  defaultAliases,
  matchArticlesToInstruments,
  normalizeTicker,
  validateInstrumentPatch
} from "../lib/market/instruments.mjs";
import { DEFAULT_SETTINGS } from "../lib/config.mjs";

function stubResponse({ status = 200, headers = {}, text = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text,
    finalUrl: "https://stub.example/"
  };
}

// Mirrors the live-verified Yahoo v8 chart shape (probed 2026-07-05 incl. ^GDAXI/^GSPC).
function makeChartBody({
  symbol = "SAP.DE",
  currency = "EUR",
  gmtoffset = 7200,
  longName = "SAP SE",
  shortName = "SAP SE                        I",
  exchange = "XETRA",
  timestamps = [],
  closes = [],
  adjcloses,
  price = 139.64,
  marketTime,
  regularEnd,
  omitCtp = false,
  omitAdj = false,
  omitLongName = false
} = {}) {
  const meta = {
    symbol,
    currency,
    exchangeName: "GER",
    fullExchangeName: exchange,
    instrumentType: "EQUITY",
    regularMarketPrice: price,
    regularMarketTime: marketTime,
    gmtoffset,
    exchangeTimezoneName: "Europe/Berlin",
    shortName
  };
  if (!omitLongName) {
    meta.longName = longName;
  }
  if (!omitCtp && regularEnd !== undefined) {
    meta.currentTradingPeriod = { regular: { start: 0, end: regularEnd } };
  }
  const indicators = { quote: [{ close: closes }] };
  if (!omitAdj) {
    indicators.adjclose = [{ adjclose: adjcloses !== undefined ? adjcloses : closes }];
  }
  return JSON.stringify({ chart: { result: [{ meta, timestamp: timestamps, indicators }], error: null } });
}

const CHART_404_BODY = JSON.stringify({
  chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } }
});

const marketSettings = () => structuredClone(DEFAULT_SETTINGS);

function emptyMarketState() {
  return {
    instruments: [],
    prices: {},
    providerHealth: { provider: "yahoo", ok: true, cooldownUntil: null, lastError: null, lastOkAt: null }
  };
}

function instrument(ticker, extra = {}) {
  return {
    ticker,
    name: ticker,
    aliases: [ticker.toLowerCase()],
    exchange: "XETRA",
    currency: "EUR",
    sizeHint: null,
    paused: false,
    source: "user",
    confidence: 1,
    confirmed: true,
    addedAt: "2026-07-01T00:00:00.000Z",
    validatedAt: null,
    staleSymbol: false,
    ...extra
  };
}

// --- toExchangeDate ---------------------------------------------------------------------

test("toExchangeDate keys bars in exchange-local time, not naive UTC", () => {
  // 2025-01-06T01:00:00Z is still Jan 5 on a US exchange (gmtoffset -18000).
  assert.equal(toExchangeDate(1736125200, -18000), "2025-01-05");
  assert.equal(new Date(1736125200 * 1000).toISOString().slice(0, 10), "2025-01-06",
    "naive UTC would have shifted the close to the next day");
  // XETRA morning bar (verified live value).
  assert.equal(toExchangeDate(1783062000, 7200), "2026-07-03");
});

// --- parseChartResponse -----------------------------------------------------------------

test("parseChartResponse prefers adjclose with per-bar close fallback and skips null bars", () => {
  const body = makeChartBody({
    timestamps: [1783062000, 1783148400, 1783234800, 1783321200],
    closes: [100, 101, null, 103],
    adjcloses: [99.5, null, null, 102.5],
    marketTime: 1790000000 // far in the future -> no bar matches its date, nothing popped
  });
  const parsed = parseChartResponse(JSON.parse(body));
  assert.equal(parsed.name, "SAP SE");
  assert.equal(parsed.currency, "EUR");
  assert.deepEqual(parsed.bars.map((bar) => bar.close), [99.5, 101, 102.5],
    "adj preferred, close fallback where adj is null, fully-null bar skipped");
  assert.deepEqual(parsed.bars.map((bar) => bar.date), ["2026-07-03", "2026-07-04", "2026-07-06"],
    "alignment survives skipped bars");
});

test("parseChartResponse excludes the in-progress session bar but keeps completed ones", () => {
  const lastTs = 1783062000; // 2026-07-03 XETRA
  const inProgress = makeChartBody({
    timestamps: [1782975600, lastTs],
    closes: [100, 101],
    marketTime: lastTs + 3600,        // same exchange-date as last bar
    regularEnd: lastTs + 3600 + 1800  // session still open
  });
  assert.equal(parseChartResponse(JSON.parse(inProgress)).bars.length, 1, "in-progress bar dropped");

  const completed = makeChartBody({
    timestamps: [1782975600, lastTs],
    closes: [100, 101],
    marketTime: lastTs + 3600,
    regularEnd: lastTs + 3600 - 600   // market time is past the close -> bar is final
  });
  assert.equal(parseChartResponse(JSON.parse(completed)).bars.length, 2, "completed bar kept");
});

test("parseChartResponse handles an index-shaped body (no adjclose/longName/ctp)", () => {
  const lastTs = 1783062000;
  const body = makeChartBody({
    symbol: "^GDAXI",
    omitAdj: true,
    omitLongName: true,
    omitCtp: true,
    shortName: "  DAX P  ",
    timestamps: [1782975600, lastTs],
    closes: [25000, 25779.31],
    marketTime: lastTs + 3600,
    price: 25779.31
  });
  const parsed = parseChartResponse(JSON.parse(body));
  assert.equal(parsed.name, "DAX P", "shortName fallback, trimmed");
  assert.equal(parsed.bars.length, 1,
    "with ctp absent, a last bar sharing the market-time date is conservatively dropped");
  assert.equal(parsed.quote.price, 25779.31);
});

test("parseChartResponse throws typed errors on error and garbage bodies", () => {
  assert.throws(() => parseChartResponse(JSON.parse(CHART_404_BODY)), /Unknown symbol/);
  assert.throws(() => parseChartResponse({}), /Malformed chart response/);
  assert.throws(() => parseChartResponse({ chart: { result: [] } }), /Malformed chart response/);
});

// --- fetchChart / probeSymbol -----------------------------------------------------------

test("fetchChart sends the mandatory UA and retries query2 on network failure", async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    if (url.includes("query1")) {
      throw new Error("socket hang up");
    }
    assert.equal(options.headers["user-agent"], YAHOO_USER_AGENT);
    return stubResponse({
      text: makeChartBody({ timestamps: [1783062000], closes: [100], marketTime: 1790000000 })
    });
  };
  const chart = await fetchChart("SAP.DE", { throttleMs: 0, fetchImpl });
  assert.equal(chart.symbol, "SAP.DE");
  assert.ok(urls[0].includes("query1.finance.yahoo.com"));
  assert.ok(urls[1].includes("query2.finance.yahoo.com"), "one retry against the alternate host");
});

test("fetchChart maps 404 and 429 to typed errors without retrying the alternate host", async () => {
  let calls = 0;
  const notFound = async () => { calls += 1; return stubResponse({ status: 404, text: CHART_404_BODY }); };
  await assert.rejects(() => fetchChart("ZZQX", { throttleMs: 0, fetchImpl: notFound }), /unknown at Yahoo/);
  assert.equal(calls, 1, "unknown symbols are not retried");

  calls = 0;
  const limited = async () => { calls += 1; return stubResponse({ status: 429, text: "" }); };
  await assert.rejects(
    () => fetchChart("SAP.DE", { throttleMs: 0, fetchImpl: limited }),
    (error) => error.rateLimited === true
  );
  assert.equal(calls, 1, "rate limiting is not retried");
});

test("assertMarketHost pins the outbound host allowlist", () => {
  assert.ok(MARKET_HOSTS.has("query1.finance.yahoo.com"));
  assert.doesNotThrow(() => assertMarketHost("https://query2.finance.yahoo.com/v8/finance/chart/X"));
  assert.throws(() => assertMarketHost("https://evil.example.com/v8/finance/chart/X"), /not an allowed market/);
});

test("probeSymbol never throws", async () => {
  const ok = await probeSymbol("SAP.DE", {
    throttleMs: 0,
    fetchImpl: async () => stubResponse({
      text: makeChartBody({ timestamps: [1783062000], closes: [100], marketTime: 1790000000 })
    })
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.meta.name, "SAP SE");
  assert.equal(ok.meta.currency, "EUR");

  const missing = await probeSymbol("NOPE", {
    throttleMs: 0,
    fetchImpl: async () => stubResponse({ status: 404, text: CHART_404_BODY })
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /unknown/i);
});

// --- mergeSeries / isSeriesStale --------------------------------------------------------

test("mergeSeries unions by date, incoming wins, trims, and flags >0.5% discrepancies", () => {
  const existing = { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [100, 101, 102] };

  const quiet = mergeSeries(existing, { dates: ["2026-07-03", "2026-07-04"], closes: [102.1, 103] }, 400);
  assert.deepEqual(quiet.dates, ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]);
  assert.deepEqual(quiet.closes, [100, 101, 102.1, 103], "incoming wins on overlap");
  assert.equal(quiet.discrepancy, false, "0.1% drift is within tolerance");

  const loud = mergeSeries(existing, { dates: ["2026-07-02"], closes: [95] }, 400);
  assert.equal(loud.discrepancy, true, "a ~6% retroactive change flags the heal");

  const trimmed = mergeSeries(existing, { dates: ["2026-07-04"], closes: [103] }, 2);
  assert.deepEqual(trimmed.dates, ["2026-07-03", "2026-07-04"], "trimmed to historyDays");
});

test("isSeriesStale is weekday-aware", () => {
  assert.equal(isSeriesStale("2026-07-03", "2026-07-06T08:00:00.000Z"), false, "Friday bar on Monday is fresh");
  assert.equal(isSeriesStale("2026-07-03", "2026-07-07T08:00:00.000Z"), false, "one weekday gap tolerated");
  assert.equal(isSeriesStale("2026-07-01", "2026-07-03T08:00:00.000Z"), false, "single holiday absorbed");
  assert.equal(isSeriesStale("2026-07-03", "2026-07-09T08:00:00.000Z"), true, "3 missing weekdays is stale");
  assert.equal(isSeriesStale(null, "2026-07-09T08:00:00.000Z"), true);
  assert.equal(isSeriesStale("garbage", "2026-07-09T08:00:00.000Z"), true);
});

// --- refreshPrices ----------------------------------------------------------------------

function chartStub(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    for (const [needle, responder] of routes) {
      if (url.includes(encodeURIComponent(needle)) || url.includes(needle)) {
        return typeof responder === "function" ? responder(url) : responder;
      }
    }
    throw new Error(`no stub for ${url}`);
  };
  return { fetchImpl, seen };
}

const NOW = "2026-07-05T10:00:00.000Z";

test("refreshPrices fetches benchmarks first, then instruments; zero instruments is a no-op", async () => {
  const okBody = (symbol) => stubResponse({
    text: makeChartBody({ symbol, timestamps: [1783062000], closes: [100], marketTime: 1790000000 })
  });
  const { fetchImpl, seen } = chartStub([
    ["^GDAXI", okBody("^GDAXI")],
    ["^GSPC", okBody("^GSPC")],
    ["IFX.DE", okBody("IFX.DE")]
  ]);

  const market = emptyMarketState();
  market.instruments.push(instrument("IFX.DE"));
  const result = await refreshPrices(market, marketSettings(), { fetchImpl, nowIso: NOW, throttleMs: 0 });

  assert.equal(seen.length, 3);
  assert.ok(seen[0].includes(encodeURIComponent("^GDAXI")), "EUR benchmark first");
  assert.ok(seen[1].includes(encodeURIComponent("^GSPC")));
  assert.ok(seen[2].includes("IFX.DE"));
  assert.equal(result.logEntry.updated, 3);
  assert.equal(result.providerHealth.ok, true);
  assert.equal(result.providerHealth.lastOkAt, NOW);
  assert.ok(result.prices["IFX.DE"].dates.length > 0);

  const empty = await refreshPrices(emptyMarketState(), marketSettings(), {
    fetchImpl: async () => { throw new Error("must not fetch"); },
    nowIso: NOW,
    throttleMs: 0
  });
  assert.equal(empty.logEntry.updated, 0, "no instruments -> no benchmark fetches either");
});

test("refreshPrices picks full vs incremental range and heals discrepancies", async () => {
  const settings = marketSettings(); // historyDays 400 -> full range is 2y
  const market = emptyMarketState();
  market.instruments.push(instrument("SAP.DE"));
  market.prices["SAP.DE"] = {
    currency: "EUR", quote: null,
    dates: ["2026-07-02", "2026-07-03"], closes: [100, 102],
    updatedAt: NOW, lastFullAt: "2026-06-20T00:00:00.000Z", stale: false
  };
  // Benchmarks have no series -> full (2y). SAP has a fresh series -> 1mo, but the incremental
  // body retroactively changes 2026-07-03 by ~2% -> a follow-up 2y heal fetch is expected.
  const ranges = [];
  const { fetchImpl } = chartStub([
    ["v8/finance/chart", (url) => {
      ranges.push(new URL(url).searchParams.get("range") + ":" + decodeURIComponent(url.split("/chart/")[1].split("?")[0]));
      const isSap = url.includes("SAP.DE");
      return stubResponse({
        text: makeChartBody({
          symbol: isSap ? "SAP.DE" : "^X",
          timestamps: [1783062000],
          closes: [isSap ? 104 : 100],
          marketTime: 1790000000
        })
      });
    }]
  ]);

  const result = await refreshPrices(market, settings, { fetchImpl, nowIso: NOW, throttleMs: 0 });
  assert.deepEqual(ranges, ["2y:^GDAXI", "2y:^GSPC", "1mo:SAP.DE", "2y:SAP.DE"],
    "benchmarks full-fetch, instrument incremental, then the discrepancy heal");
  assert.equal(result.prices["SAP.DE"].lastFullAt, NOW, "heal counts as a full fetch");
  assert.deepEqual(result.prices["SAP.DE"].closes, [104], "healed series comes from the full body alone");
});

test("refreshPrices error taxonomy: failures continue, only 429 aborts with cooldown", async () => {
  const okBody = (symbol) => stubResponse({
    text: makeChartBody({ symbol, timestamps: [1783062000], closes: [100], marketTime: 1790000000 })
  });
  const market = emptyMarketState();
  market.instruments.push(instrument("AAA.DE"), instrument("BBB.DE"), instrument("CCC.DE"));

  // AAA network-fails on both hosts; BBB returns a 200 chart.error; CCC succeeds.
  const { fetchImpl } = chartStub([
    ["^GDAXI", okBody("^GDAXI")],
    ["^GSPC", okBody("^GSPC")],
    ["AAA.DE", () => { throw new Error("socket hang up"); }],
    ["BBB.DE", stubResponse({ text: CHART_404_BODY })],
    ["CCC.DE", okBody("CCC.DE")]
  ]);
  const result = await refreshPrices(market, marketSettings(), { fetchImpl, nowIso: NOW, throttleMs: 0 });
  assert.equal(result.logEntry.updated, 3, "benchmarks + CCC");
  assert.equal(result.logEntry.failures.length, 2, "AAA and BBB fail without aborting the cycle");
  assert.ok(result.prices["CCC.DE"], "the symbol after the failures was still fetched");
  assert.equal(result.providerHealth.cooldownUntil, null);
  assert.equal(result.providerHealth.ok, false, "failures mark health not-ok without cooldown");

  // 429 aborts: only the first benchmark gets through.
  const { fetchImpl: limitedImpl, seen } = chartStub([
    ["^GDAXI", okBody("^GDAXI")],
    ["v8/finance/chart", stubResponse({ status: 429 })]
  ]);
  const limited = await refreshPrices(market, marketSettings(), { fetchImpl: limitedImpl, nowIso: NOW, throttleMs: 0 });
  assert.equal(limited.logEntry.updated, 1);
  assert.equal(seen.length, 2, "cycle stops at the first 429");
  assert.ok(limited.providerHealth.cooldownUntil > NOW, "cooldown persisted");
  assert.ok(limited.prices["^GDAXI"], "already-fetched series survive the abort");
});

test("refreshPrices flags an all-429 cycle as a possible UA regression", async () => {
  const market = emptyMarketState();
  market.instruments.push(instrument("IFX.DE"));
  const { fetchImpl } = chartStub([["v8/finance/chart", stubResponse({ status: 429 })]]);
  const result = await refreshPrices(market, marketSettings(), { fetchImpl, nowIso: NOW, throttleMs: 0 });
  assert.equal(result.logEntry.updated, 0);
  assert.match(result.providerHealth.lastError, /User-Agent/);
});

test("refreshPrices honors the abort signal and never mutates its inputs", async () => {
  const market = emptyMarketState();
  market.instruments.push(instrument("IFX.DE"));
  const before = JSON.stringify(market);
  const controller = new AbortController();
  controller.abort();
  const result = await refreshPrices(market, marketSettings(), {
    fetchImpl: async () => { throw new Error("must not fetch after abort"); },
    nowIso: NOW,
    throttleMs: 0,
    signal: controller.signal
  });
  assert.equal(result.logEntry.aborted, true);
  assert.equal(result.logEntry.updated, 0);
  assert.equal(JSON.stringify(market), before, "inputs are never mutated");
});

test("benchmarksFor follows the settings field", () => {
  const settings = marketSettings();
  assert.deepEqual(benchmarksFor(settings).map((b) => b.symbol), ["^GDAXI", "^GSPC"]);
  settings.market.benchmarkEUR = "^TECDAX";
  assert.deepEqual(benchmarksFor(settings).map((b) => b.symbol), ["^TECDAX", "^GSPC"]);
});

// --- instruments.mjs --------------------------------------------------------------------

test("normalizeTicker uppercases, validates, and rejects index symbols", () => {
  assert.equal(normalizeTicker(" ifx.de "), "IFX.DE");
  assert.equal(normalizeTicker("BRK-B"), "BRK-B");
  assert.throws(() => normalizeTicker("^GSPC"), /Index symbols/);
  assert.throws(() => normalizeTicker(""), /Ticker/);
  assert.throws(() => normalizeTicker("WAY.TOO.LONG.TICKER"), /Ticker/);
  assert.throws(() => normalizeTicker("BAD SYMBOL"), /Ticker/);
});

test("validateInstrumentPatch normalizes and rejects with human messages", () => {
  const patch = validateInstrumentPatch({
    name: " Infineon ",
    aliases: [" Infineon ", "INFINEON", "ifx"],
    paused: true,
    sizeHint: "large",
    confirmed: true
  });
  assert.deepEqual(patch, {
    name: "Infineon",
    aliases: ["infineon", "ifx"],
    paused: true,
    sizeHint: "large",
    confirmed: true
  });

  assert.throws(() => validateInstrumentPatch(null), /patch/);
  assert.throws(() => validateInstrumentPatch({ name: " " }), /name/);
  assert.throws(() => validateInstrumentPatch({ aliases: [] }), /aliases/);
  assert.throws(() => validateInstrumentPatch({ aliases: ["", "  "] }), /aliases/);
  assert.throws(() => validateInstrumentPatch({ sizeHint: "gigantic" }), /sizeHint/);
  assert.throws(() => validateInstrumentPatch({ paused: "yes" }), /paused/);
  assert.doesNotThrow(() => validateInstrumentPatch({ sizeHint: null }));
});

test("defaultAliases strips legal suffixes and adds a distinctive first word", () => {
  assert.deepEqual(defaultAliases("Infineon Technologies AG", "IFX.DE"),
    ["infineon technologies ag", "infineon technologies", "infineon"]);
  assert.deepEqual(defaultAliases("SAP SE", "SAP.DE"), ["sap se", "sap"]);
  assert.deepEqual(defaultAliases("Apple Inc.", "AAPL"), ["apple inc.", "apple"]);
  assert.deepEqual(defaultAliases("", "NVDA"), ["nvda"], "ticker fallback when no name");
});

test("matchArticlesToInstruments matches whole words across title/keywords/entities", () => {
  const instruments = [
    instrument("IFX.DE", { aliases: ["infineon"] }),
    instrument("AI.PA", { aliases: ["ai"] }), // the legacy substring trap
    instrument("SAP.DE", { aliases: ["sap"] })
  ];
  const articles = [
    { id: "a1", title: "Infineon meldet Rekordquartal", keywords: [], entities: { orgs: [], people: [] }, aiEnriched: true },
    { id: "a2", title: "Officials said today the deal closed", keywords: [], entities: { orgs: [], people: [] } },
    { id: "a3", title: "Cloud-Migration", keywords: ["sap"], entities: { orgs: [], people: [] } },
    { id: "a4", title: "Neue Partnerschaft", keywords: [], entities: { orgs: ["SAP SE"], people: ["Infineon Technologies"] } },
    { id: "a5", title: "KI-Chips: AI startup raises billions", keywords: [], entities: { orgs: [], people: [] } }
  ];

  const matches = matchArticlesToInstruments(articles, instruments);
  assert.deepEqual(matches.get("IFX.DE").articleIds, ["a1", "a4"], "title and people-entity matches");
  assert.equal(matches.get("IFX.DE").aiEnrichedCount, 1);
  assert.deepEqual(matches.get("SAP.DE").articleIds, ["a3", "a4"], "keyword and org-entity matches");
  assert.deepEqual(matches.get("AI.PA").articleIds, ["a5"],
    '"ai" must match the standalone word but never "said" (legacy substring bug)');
  assert.equal(matchArticlesToInstruments(articles, []).size, 0);
});
