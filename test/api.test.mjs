import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";

// Mock price fixtures must stay "fresh": isSeriesStale() (lib/market/prices.mjs) flags a
// series once more than 2 weekdays pass without a new bar. A hard-coded last-bar date made
// these fixtures rot — the suite went red a few days after it was written. Anchor the last
// bar to the most recent weekday session (exchange-local, UTC+2) computed at run time so the
// bars are always current. Noon-local keeps regularMarketTime (+30000s) on the same calendar
// day and past the session end, so parseChartResponse() keeps the bar as a completed session.
const MOCK_GMT_OFFSET = 7200;
function recentSessionTs() {
  const nowSec = Math.floor(Date.now() / 1000);
  let dayIndex = Math.floor((nowSec + MOCK_GMT_OFFSET) / 86400); // exchange-local days since epoch
  // Epoch day 0 (1970-01-01) was a Thursday → dow = (dayIndex + 4) % 7 (0=Sun, 6=Sat).
  while ((dayIndex + 4) % 7 === 0 || (dayIndex + 4) % 7 === 6) {
    dayIndex -= 1;
  }
  return dayIndex * 86400 + 12 * 3600 - MOCK_GMT_OFFSET; // noon of that weekday, as a Unix ts
}

test("HTTP API", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "news-api-test-"));
  const app = createApp({ dataDir, quiet: true });
  const port = await app.start(0);
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function api(method, pathname, body, headers = {}) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response; callers use .text
    }
    return { status: response.status, headers: response.headers, json, text };
  }

  let manualArticleId = null;

  await t.test("GET /api/state returns a clean empty install", async () => {
    const { status, json } = await api("GET", "/api/state");
    assert.equal(status, 200);
    assert.equal(json.version, 3);
    assert.equal(json.articles.length, 0, "no demo articles on a fresh install");
    assert.equal(json.sources.length, 0, "no demo sources on a fresh install");
    assert.ok(Array.isArray(json.categories) && json.categories.length > 0);
    assert.ok(json.analytics && typeof json.analytics.totalArticles === "number");
    assert.ok(json.trends && Array.isArray(json.trends.byMonth));
    assert.ok(json.watchlistMatches && typeof json.watchlistMatches === "object");
    assert.equal(json.config.settings.ai.apiKey, "", "AI key is masked in state");
    assert.equal(typeof json.config.settings.ai.apiKeyConfigured, "boolean");
  });

  await t.test("POST /api/collect with only manual sources is a safe no-op", async () => {
    const { status, json } = await api("POST", "/api/collect");
    assert.equal(status, 200);
    assert.ok(json.collection, "response includes the collection entry");
    assert.equal(json.collection.attempted, 0);
    assert.equal(json.collection.added, 0);
    assert.ok(Array.isArray(json.collection.failures));
    assert.ok(Array.isArray(json.collections) && json.collections.length >= 1);
  });

  await t.test("POST /api/sources rejects unsafe URLs and detects duplicates", async () => {
    const bad1 = await api("POST", "/api/sources", { url: "javascript:alert(1)" });
    assert.ok(bad1.status >= 400 && bad1.status < 500, `javascript: rejected (${bad1.status})`);
    assert.ok(bad1.json && bad1.json.error);

    const bad2 = await api("POST", "/api/sources", { url: "http://127.0.0.1/feed.xml" });
    assert.ok(bad2.status >= 400 && bad2.status < 500, `loopback rejected (${bad2.status})`);
    assert.ok(bad2.json && bad2.json.error);

    const ok = await api("POST", "/api/sources", {
      name: "Example Feed",
      url: "https://example.com/feed.xml",
      type: "rss"
    });
    assert.equal(ok.status, 201);
    assert.ok(ok.json.sources.some((source) => source.url === "https://example.com/feed.xml"));

    const dup = await api("POST", "/api/sources", { url: "https://example.com/feed.xml" });
    assert.equal(dup.status, 409);
  });

  await t.test("manual article create + PATCH read/star", async () => {
    const created = await api("POST", "/api/articles", {
      title: "Quantum networking pilot links three research labs",
      body: "A regional quantum networking pilot connected three research laboratories using entangled photon links. Engineers said the pilot will expand to more sites next quarter."
    });
    assert.equal(created.status, 201);
    const article = created.json.articles.find((item) =>
      item.title === "Quantum networking pilot links three research labs");
    assert.ok(article, "manual article appears in decorated state");
    assert.equal(article.sourceType, "manual");
    assert.equal(article.read, false);
    assert.equal(article.starred, false);
    manualArticleId = article.id;

    const patched = await api("PATCH", `/api/articles/${manualArticleId}`, { read: true, starred: true });
    assert.equal(patched.status, 200);
    const updated = patched.json.articles.find((item) => item.id === manualArticleId);
    assert.equal(updated.read, true);
    assert.equal(updated.starred, true);

    const missing = await api("PATCH", "/api/articles/does-not-exist", { read: true });
    assert.equal(missing.status, 404);
  });

  await t.test("watchlist create + matches surface in state", async () => {
    const noName = await api("POST", "/api/watchlists", { keywords: ["quantum"] });
    assert.equal(noName.status, 400);

    const created = await api("POST", "/api/watchlists", {
      name: "Quantum watch",
      keywords: ["quantum"]
    });
    assert.equal(created.status, 201);
    const watchlist = created.json.watchlists.find((item) => item.name === "Quantum watch");
    assert.ok(watchlist, "watchlist appears in decorated state");

    const matches = created.json.watchlistMatches[watchlist.id];
    assert.ok(Array.isArray(matches), "matches array exists for the watchlist");
    assert.ok(matches.includes(manualArticleId), "manual quantum article matches the watchlist");
  });

  await t.test("reports: executive and source focus genuinely differ", async () => {
    const state = await api("GET", "/api/state");
    const categories = state.json.categories;

    const executive = await api("POST", "/api/reports", {
      categories,
      month: "All",
      focus: "executive",
      template: "standard"
    });
    assert.equal(executive.status, 200);
    assert.equal(typeof executive.json.title, "string");
    assert.equal(typeof executive.json.markdown, "string");
    assert.equal(typeof executive.json.html, "string");
    assert.ok(executive.json.meta && typeof executive.json.meta.storyCount === "number");

    const source = await api("POST", "/api/reports", {
      categories,
      month: "All",
      focus: "source",
      template: "standard"
    });
    assert.equal(source.status, 200);
    assert.notEqual(executive.json.markdown, source.json.markdown,
      "executive and source focus produce different markdown");

    const empty = await api("POST", "/api/reports", { categories: [], month: "All" });
    assert.equal(empty.status, 400);
  });

  await t.test("external API: 403 disabled -> configure token -> 401 -> 200", async () => {
    const disabled = await api("GET", "/api/external/articles");
    assert.equal(disabled.status, 403);

    const token = "test-token-8c1f2a";
    const state = await api("GET", "/api/state");
    const settings = structuredClone(state.json.config.settings);
    delete settings.ai.apiKeyConfigured;
    settings.apiToken = token;
    const configured = await api("PUT", "/api/config", { settings });
    assert.equal(configured.status, 200);
    assert.equal(configured.json.config.settings.apiToken, token);
    assert.equal(configured.json.config.settings.ai.apiKey, "", "AI key stays masked after config PUT");

    const noAuth = await api("GET", "/api/external/articles");
    assert.equal(noAuth.status, 401);

    const wrongAuth = await api("GET", "/api/external/articles", undefined,
      { authorization: "Bearer wrong-token" });
    assert.equal(wrongAuth.status, 401);

    const ok = await api("GET", "/api/external/articles?limit=3", undefined,
      { authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json.articles));
    assert.ok(ok.json.articles.length <= 3);
    assert.equal(typeof ok.json.total, "number");
    const first = ok.json.articles[0];
    assert.ok(first && first.id && first.title, "trimmed article has id and title");
    assert.ok(!("read" in first), "trimmed article omits internal fields");

    const search = await api("GET", "/api/external/articles?search=quantum", undefined,
      { authorization: `Bearer ${token}` });
    assert.equal(search.status, 200);
    assert.ok(search.json.articles.some((item) => item.id === manualArticleId));
  });

  await t.test("export/import round-trip", async () => {
    const exported = await api("GET", "/api/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") || "", /attachment/);
    assert.equal(exported.json.version, 3);
    assert.ok(Array.isArray(exported.json.articles));
    const articleCount = exported.json.articles.length;
    const watchlistCount = exported.json.watchlists.length;

    const badImport = await api("POST", "/api/import", { store: "not-an-object" });
    assert.equal(badImport.status, 400);

    const imported = await api("POST", "/api/import", { store: exported.json });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.articles.length, articleCount);
    assert.equal(imported.json.watchlists.length, watchlistCount);
    assert.ok(imported.json.articles.some((item) => item.id === manualArticleId),
      "manual article survives the round-trip");
  });
});

test("Market API", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "news-market-api-"));

  const NAMES = {
    "IFX.DE": "Infineon Technologies AG",
    "SAP.DE": "SAP SE",
    "FAIL.DE": "Fail Historie AG",
    "^GDAXI": "DAX P",
    "^GSPC": "S&P 500"
  };
  const CHART_404 = JSON.stringify({
    chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } }
  });
  const SEARCH_BODY = JSON.stringify({
    quotes: [
      { symbol: "DB", exchange: "NYQ", exchDisp: "NYSE", longname: "Deutsche Bank AG", quoteType: "EQUITY" },
      { symbol: "DBK.DE", exchange: "GER", exchDisp: "XETRA", longname: "Deutsche Bank AG", quoteType: "EQUITY" },
      { symbol: "DBK260119", exchange: "FRA", exchDisp: "Frankfurt", quoteType: "OPTION" }
    ]
  });

  function stubResponse({ status = 200, text = "" } = {}) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers(), text, finalUrl: "https://stub/" };
  }

  // 25 completed daily bars ending on the most recent weekday (XETRA), market time far past
  // the session end so the last bar is kept.
  function chartBody(symbol) {
    const lastTs = recentSessionTs();
    const timestamps = Array.from({ length: 25 }, (_, i) => lastTs - (24 - i) * 86400);
    const closes = timestamps.map((_, i) => 100 + i);
    return JSON.stringify({
      chart: {
        result: [{
          meta: {
            symbol,
            currency: symbol === "^GSPC" ? "USD" : "EUR",
            exchangeName: "GER",
            fullExchangeName: "XETRA",
            regularMarketPrice: closes[closes.length - 1] + 0.5,
            regularMarketTime: lastTs + 30000,
            gmtoffset: 7200,
            longName: NAMES[symbol] || symbol,
            shortName: symbol,
            currentTradingPeriod: { regular: { start: lastTs - 30600, end: lastTs + 1800 } }
          },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] }
        }],
        error: null
      }
    });
  }

  let chartMode = "ok"; // "ok" | "limited" | "slow"
  const marketFetchImpl = async (url) => {
    if (url.includes("/v1/finance/search")) {
      return stubResponse({ text: SEARCH_BODY });
    }
    if (chartMode === "limited") {
      return stubResponse({ status: 429 });
    }
    if (chartMode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const symbol = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
    const range = new URL(url).searchParams.get("range");
    if (symbol === "ZZQX") {
      return stubResponse({ status: 404, text: CHART_404 });
    }
    if (symbol === "FAIL.DE" && range !== "1d") {
      throw new Error("history unavailable");
    }
    return stubResponse({ text: chartBody(symbol) });
  };

  const app = createApp({ dataDir, quiet: true, marketFetchImpl, marketThrottleMs: 0 });
  const port = await app.start(0);
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function api(method, pathname, body) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* callers use .text */ }
    return { status: response.status, json, text };
  }

  await t.test("state carries the market payload on a fresh install", async () => {
    const { status, json } = await api("GET", "/api/state");
    assert.equal(status, 200);
    assert.equal(json.market.enabled, true);
    assert.deepEqual(json.market.instruments, []);
    assert.equal(json.market.marketRefreshing, false);
    assert.match(json.market.disclaimer, /Not investment advice/);
    assert.equal(json.market.settings.benchmarkEUR, "^GDAXI");
  });

  await t.test("lookup: seed hit first, then Yahoo equities XETRA-first, options filtered", async () => {
    const { status, json } = await api("GET", "/api/market/lookup?q=deutsche+bank");
    assert.equal(status, 200);
    assert.deepEqual(json.results.map((r) => r.ticker), ["DBK.DE", "DB"],
      "seed replaces the duplicate search row; XETRA preferred; option filtered");
    assert.equal(json.results[0].source, "seed", "curated seed knowledge ranks first");
    assert.equal(json.results[0].name, "Deutsche Bank");
    assert.equal(json.results[1].source, "search");
    const missing = await api("GET", "/api/market/lookup");
    assert.equal(missing.status, 400);
  });

  await t.test("instrument add: probe-gated, history fetched, aliases derived", async () => {
    const { status, json } = await api("POST", "/api/market/instruments", { ticker: "ifx.de" });
    assert.equal(status, 201);
    const instrument = json.market.instruments.find((i) => i.ticker === "IFX.DE");
    assert.equal(instrument.name, "Infineon Technologies AG", "name from probe longName");
    assert.ok(instrument.aliases.includes("infineon"), "legal suffix stripped into aliases");
    assert.equal(instrument.confirmed, true);
    assert.ok(instrument.lastPrice > 0, "quote present");
    assert.ok(instrument.spark.length > 0, "history fetched on add");

    const dup = await api("POST", "/api/market/instruments", { ticker: "IFX.DE" });
    assert.equal(dup.status, 409);
    const unknown = await api("POST", "/api/market/instruments", { ticker: "ZZQX" });
    assert.equal(unknown.status, 400, "probe 404 rejects the add");
    const index = await api("POST", "/api/market/instruments", { ticker: "^GSPC" });
    assert.equal(index.status, 400, "index symbols rejected");
    const bad = await api("POST", "/api/market/instruments", { ticker: "NOT A TICKER" });
    assert.equal(bad.status, 400);
  });

  await t.test("instrument add survives a failing history fetch (partial failure)", async () => {
    const { status, json } = await api("POST", "/api/market/instruments", { ticker: "FAIL.DE" });
    assert.equal(status, 201, "probe ok + history failure still adds the instrument");
    assert.match(json.message, /price history will follow/);
    const instrument = json.market.instruments.find((i) => i.ticker === "FAIL.DE");
    assert.equal(instrument.stale, true);
    assert.deepEqual(instrument.spark, []);
    await api("DELETE", "/api/market/instruments/FAIL.DE");
  });

  await t.test("PATCH updates aliases/paused/confirmed; unknown 404s", async () => {
    const ok = await api("PATCH", "/api/market/instruments/IFX.DE",
      { aliases: ["infineon", "ifx"], paused: true });
    assert.equal(ok.status, 200);
    const instrument = ok.json.market.instruments.find((i) => i.ticker === "IFX.DE");
    assert.deepEqual(instrument.aliases, ["infineon", "ifx"]);
    assert.equal(instrument.paused, true);
    await api("PATCH", "/api/market/instruments/IFX.DE", { paused: false });

    const missing = await api("PATCH", "/api/market/instruments/NOPE.DE", { paused: true });
    assert.equal(missing.status, 404);
    const invalid = await api("PATCH", "/api/market/instruments/IFX.DE", { sizeHint: "gigantic" });
    assert.equal(invalid.status, 400);
  });

  await t.test("manual refresh updates quotes, benchmarks and the refresh log", async () => {
    const { status, json } = await api("POST", "/api/market/refresh");
    assert.equal(status, 200);
    assert.ok(json.market.lastRefreshAt, "lastRefreshAt set");
    assert.ok(json.market.lastRefresh && json.market.lastRefresh.updated >= 3,
      "benchmarks + instrument refreshed");
    assert.ok(json.market.benchmarks.EUR.ret20d !== null, "EUR benchmark return computed");
    const instrument = json.market.instruments.find((i) => i.ticker === "IFX.DE");
    assert.equal(instrument.stale, false);
  });

  await t.test("a new article invalidates the market cache via rev (mentions update)", async () => {
    const before = await api("GET", "/api/state");
    const beforeIds = before.json.market.instruments.find((i) => i.ticker === "IFX.DE").articleIds;

    const posted = await api("POST", "/api/articles", {
      title: "Infineon kündigt neue KI-Chips an",
      body: "Der Halbleiterhersteller Infineon hat eine neue Generation von Beschleunigern vorgestellt."
    });
    assert.equal(posted.status, 201);
    const after = posted.json.market.instruments.find((i) => i.ticker === "IFX.DE");
    assert.equal(after.articleIds.length, beforeIds.length + 1,
      "the mutation bumped rev and the market payload recomputed");
    assert.ok(after.mentions30d >= 1);
  });

  await t.test("full price series endpoint", async () => {
    const { status, json } = await api("GET", "/api/market/prices/IFX.DE");
    assert.equal(status, 200);
    assert.equal(json.ticker, "IFX.DE");
    assert.ok(json.dates.length >= 20);
    assert.equal(json.dates.length, json.closes.length);
    const missing = await api("GET", "/api/market/prices/NOPE.DE");
    assert.equal(missing.status, 404);
  });

  await t.test("concurrent refresh 409s; deleted instrument is not resurrected (race)", async () => {
    async function waitForRefreshing(expected) {
      for (let i = 0; i < 100; i += 1) {
        const { json } = await api("GET", "/api/state");
        if (json.market.marketRefreshing === expected) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`marketRefreshing never became ${expected}`);
    }

    await api("POST", "/api/market/instruments", { ticker: "SAP.DE" });
    // The add fires a background refresh; let it settle before staging the race.
    await waitForRefreshing(false);

    chartMode = "slow";
    const first = api("POST", "/api/market/refresh");
    await waitForRefreshing(true);
    const second = await api("POST", "/api/market/refresh");
    assert.equal(second.status, 409, "refresh already running");
    const del = await api("DELETE", "/api/market/instruments/SAP.DE");
    assert.equal(del.status, 200);
    const result = await first;
    chartMode = "ok";
    assert.equal(result.status, 200);
    assert.equal(result.json.market.instruments.some((i) => i.ticker === "SAP.DE"), false);
    const prices = await api("GET", "/api/market/prices/SAP.DE");
    assert.equal(prices.status, 404, "mid-refresh deletion wins over the fetched series");
  });

  await t.test("429 sets a cooldown; the next manual refresh gets 503", async () => {
    chartMode = "limited";
    const limited = await api("POST", "/api/market/refresh");
    assert.equal(limited.status, 200, "the limited cycle itself completes with failures");
    assert.ok(limited.json.market.providerHealth.cooldownUntil, "cooldown persisted");
    const blocked = await api("POST", "/api/market/refresh");
    assert.equal(blocked.status, 503);
    assert.ok(blocked.json.cooldownUntil);
    chartMode = "ok";
    // Clear the cooldown for later subtests by re-importing the store with health reset.
    const exported = await api("GET", "/api/export");
    exported.json.market.providerHealth.cooldownUntil = null;
    const restored = await api("POST", "/api/import", { store: exported.json });
    assert.equal(restored.status, 200);
  });

  await t.test("PUT /api/config deep-merges a partial settings.market patch", async () => {
    const before = await api("GET", "/api/state");
    assert.equal(before.json.market.settings.preferXetra, true);
    const { status, json } = await api("PUT", "/api/config",
      { settings: { market: { minRefreshMinutes: 60 } } });
    assert.equal(status, 200);
    assert.equal(json.market.settings.minRefreshMinutes, 60);
    assert.equal(json.market.settings.preferXetra, true, "unspecified subfields survive");
    assert.equal(json.market.settings.maxInstruments, 40);
    const invalid = await api("PUT", "/api/config", { settings: { market: { historyDays: 1 } } });
    assert.equal(invalid.status, 400);
  });

  await t.test("importing a pre-v3 export preserves market data (invariant 8)", async () => {
    const exported = await api("GET", "/api/export");
    assert.ok(exported.json.market.instruments.length >= 1, "market data exists before import");

    const preV3 = structuredClone(exported.json);
    delete preV3.market;
    delete preV3.rev;
    preV3.version = 2;
    const { status, json } = await api("POST", "/api/import", { store: preV3 });
    assert.equal(status, 200);
    assert.ok(json.market.instruments.some((i) => i.ticker === "IFX.DE"),
      "instruments survive a pre-v3 restore");
    assert.equal(json.market.lastRefreshAt, null, "next refresh heals imported history");
    assert.ok(json.market.instruments.every((i) => i.stale === true), "series flagged stale");
  });

  await t.test("ideas: pin/dismiss/none round-trip; unscored carries reasons", async () => {
    const before = await api("GET", "/api/state");
    const ifx = before.json.market.unscored.find((entry) => entry.ticker === "IFX.DE");
    assert.ok(ifx, "IFX.DE is unscored (too few mapped articles)");
    assert.ok(ifx.reason, "human-readable reason present");
    assert.ok(Array.isArray(before.json.market.opportunities), "opportunities key present");

    const pinned = await api("POST", "/api/market/ideas/IFX.DE", { status: "pinned", note: "Q3 prüfen" });
    assert.equal(pinned.status, 200);
    const idea = pinned.json.market.ideas.find((entry) => entry.ticker === "IFX.DE");
    assert.equal(idea.status, "pinned");
    assert.equal(idea.note, "Q3 prüfen");

    const dismissed = await api("POST", "/api/market/ideas/IFX.DE", { status: "dismissed" });
    const after = dismissed.json.market.ideas.find((entry) => entry.ticker === "IFX.DE");
    assert.equal(after.status, "dismissed");
    assert.equal(after.note, "Q3 prüfen", "note survives a status change without a new note");

    const cleared = await api("POST", "/api/market/ideas/IFX.DE", { status: "none" });
    assert.equal(cleared.json.market.ideas.length, 0);

    const invalid = await api("POST", "/api/market/ideas/IFX.DE", { status: "maybe" });
    assert.equal(invalid.status, 400);
    const missing = await api("POST", "/api/market/ideas/NOPE.DE", { status: "pinned" });
    assert.equal(missing.status, 404);
  });

  await t.test("two apps in one process never cross-serve market state", async () => {
    const dirB = await mkdtemp(path.join(os.tmpdir(), "news-market-api-b-"));
    const appB = createApp({ dataDir: dirB, quiet: true, marketFetchImpl, marketThrottleMs: 0 });
    const portB = await appB.start(0);
    try {
      const stateB = await fetch(`http://127.0.0.1:${portB}/api/state`).then((r) => r.json());
      assert.deepEqual(stateB.market.instruments, [], "app B must not see app A instruments");
      const stateA = await api("GET", "/api/state");
      assert.ok(stateA.json.market.instruments.length >= 1, "app A keeps its own instruments");
    } finally {
      await appB.stop();
      await rm(dirB, { recursive: true, force: true });
    }
  });
});

test("Market alerts: edge-triggered webhooks, ntfy format, import strip", async (t) => {
  const { createServer } = await import("node:http");
  const { writeFile } = await import("node:fs/promises");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "news-alerts-"));

  // Local webhook receiver capturing every delivery.
  const received = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverPort = receiver.address().port;

  const DAY = 86400000;
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
  const article = (id, daysAgo, sentiment, sourceName) => ({
    id, title: `Infineon Meldung ${id}`, url: "", sourceId: "src-a", sourceName,
    sourceType: "rss", publishedAt: ago(daysAgo), collectedAt: ago(daysAgo),
    monthKey: ago(daysAgo).slice(0, 7), category: "Business", summary: "Infineon Update.",
    keywords: [], sentiment, entities: { people: [], orgs: ["Infineon"], places: [] },
    readingMinutes: 1, clusterId: null, read: false, starred: false,
    aiEnriched: false, fullTextFetched: false
  });

  // Pre-seeded store: tracked instrument with enough mentions/baseline to score,
  // alerts armed at minScore 1, one JSON + one ntfy webhook.
  const seed = {
    version: 3,
    settings: {
      market: { alerts: { enabled: true, minScore: 1 } },
      webhooks: [
        { id: "wh-json", url: `http://127.0.0.1:${receiverPort}/json`, format: "json", createdAt: ago(1) },
        { id: "wh-ntfy", url: `http://127.0.0.1:${receiverPort}/ntfy`, format: "ntfy", createdAt: ago(1) }
      ]
    },
    sources: [{ id: "src-a", name: "Quelle A", url: "https://a.example/feed", type: "rss", createdAt: ago(200) }],
    articles: [
      article("h1", 1, "positive", "Quelle A"),
      article("h2", 2, "positive", "Quelle B"),
      article("h3", 3, "positive", "Quelle A"),
      article("h4", 4, "positive", "Quelle B"),
      article("h5", 5, "neutral", "Quelle A"),
      article("base1", 40, "neutral", "Quelle A")
    ],
    market: {
      instruments: [{
        ticker: "IFX.DE", name: "Infineon Technologies", aliases: ["infineon"],
        exchange: "XETRA", currency: "EUR", sizeHint: null, paused: false,
        source: "user", confidence: 1, confirmed: true, addedAt: ago(30), validatedAt: ago(1), staleSymbol: false
      }]
    }
  };
  await writeFile(path.join(dataDir, "news-platform.json"), JSON.stringify(seed), "utf8");

  // 80 completed bars ending on the most recent weekday so price components compute.
  function chartBody(symbol) {
    const lastTs = recentSessionTs();
    const timestamps = Array.from({ length: 80 }, (_, i) => lastTs - (79 - i) * 86400);
    const closes = timestamps.map((_, i) => 100 + i);
    return JSON.stringify({ chart: { result: [{
      meta: { symbol, currency: "EUR", fullExchangeName: "XETRA", regularMarketPrice: 180,
        regularMarketTime: lastTs + 30000, gmtoffset: 7200, longName: symbol,
        currentTradingPeriod: { regular: { start: 0, end: lastTs + 1800 } } },
      timestamp: timestamps,
      indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] }
    }], error: null } });
  }
  const marketFetchImpl = async (url) => {
    const symbol = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
    return { ok: true, status: 200, headers: new Headers(), text: chartBody(symbol), finalUrl: url };
  };

  const app = createApp({ dataDir, quiet: true, marketFetchImpl, marketThrottleMs: 0 });
  const port = await app.start(0);
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.stop();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  async function api(method, pathname, body) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: response.status, json };
  }

  async function waitForDeliveries(count) {
    for (let i = 0; i < 100 && received.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return received.length;
  }

  await t.test("first refresh scores the instrument and fires the alert once", async () => {
    const refresh = await api("POST", "/api/market/refresh");
    assert.equal(refresh.status, 200);
    const opp = refresh.json.market.opportunities.find((o) => o.ticker === "IFX.DE");
    assert.ok(opp && opp.score >= 1, "instrument scored");

    // Expected deliveries: refresh.completed (json only) + opportunity.flagged (json + ntfy).
    await waitForDeliveries(3);
    const jsonEvents = received
      .filter((r) => r.headers["content-type"]?.includes("json"))
      .map((r) => JSON.parse(r.body));
    assert.ok(jsonEvents.some((e) => e.event === "market.refresh.completed"));
    const flagged = jsonEvents.find((e) => e.event === "opportunity.flagged");
    assert.ok(flagged, "flagged event delivered as JSON");
    assert.equal(flagged.ticker, "IFX.DE");
    assert.match(flagged.disclaimer, /Not investment advice/);

    const ntfy = received.find((r) => r.headers["content-type"]?.includes("text/plain"));
    assert.ok(ntfy, "ntfy hook got a plain-text push");
    assert.match(ntfy.headers["x-title"], /Opportunity \d+/);
    assert.match(ntfy.body, /Infineon Technologies \(IFX\.DE\)/);
    assert.match(ntfy.body, /Not investment advice/);
    assert.ok(!ntfy.body.trim().startsWith("{"), "ntfy body is prose, not JSON");

    assert.ok(!received.some((r) =>
      r.headers["content-type"]?.includes("text/plain") && r.body.includes("refresh")),
      "refresh ticks never go to ntfy hooks (push spam)");
  });

  await t.test("second refresh stays silent while above the threshold (edge trigger)", async () => {
    const before = received.length;
    const refresh = await api("POST", "/api/market/refresh");
    assert.equal(refresh.status, 200);
    await waitForDeliveries(before + 1); // refresh.completed only
    await new Promise((resolve) => setTimeout(resolve, 150));
    const newEvents = received.slice(before)
      .filter((r) => r.headers["content-type"]?.includes("json"))
      .map((r) => JSON.parse(r.body));
    assert.ok(newEvents.every((e) => e.event !== "opportunity.flagged"),
      "no re-alert while the score stays above minScore");
    const state = await api("GET", "/api/state");
    assert.equal(state.json.market.settings.alerts.enabled, true);
  });

  await t.test("import strips alerts.enabled (outbound side effect)", async () => {
    const exported = await api("GET", "/api/export");
    assert.equal(exported.json.settings.market.alerts.enabled, true);
    const imported = await api("POST", "/api/import", { store: exported.json });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.market.settings.alerts.enabled, false,
      "an imported file must not silently arm outbound alerts");
    assert.equal(imported.json.market.settings.alerts.minScore, 1, "threshold itself survives");
  });
});
