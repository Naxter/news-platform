import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_SENTIMENT,
  DEFAULT_SETTINGS,
  STOP_WORDS,
  emptyStore,
  validateConfigPatch
} from "../lib/config.mjs";
import { CURRENT_VERSION, migrate } from "../lib/store/migrations.mjs";
import { Store } from "../lib/store/store.mjs";

const LEGACY_V1_FIXTURE = {
  version: 1,
  sources: [
    {
      id: "src-demo-world",
      name: "Demo World Desk",
      url: "manual://world",
      type: "manual",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "src-feed",
      name: "Example Feed",
      url: "https://example.com/feed.xml",
      type: "auto",
      createdAt: "2026-02-01T00:00:00.000Z"
    }
  ],
  articles: [
    {
      id: "a1b2c3",
      title: "AI chip suppliers expand capacity as demand moves beyond cloud giants",
      url: "manual://demo/1",
      sourceId: "src-demo-world",
      sourceName: "Demo World Desk",
      sourceType: "manual",
      publishedAt: "2026-06-30T00:00:00.000Z",
      collectedAt: "2026-06-30T01:00:00.000Z",
      monthKey: "2026-06",
      category: "Technology",
      summary: "Semiconductor manufacturers are adding advanced packaging capacity.",
      keywords: ["chips", "capacity"],
      sentiment: "neutral",
      readingMinutes: 1
    },
    {
      id: "d4e5f6",
      title: "Sparse legacy story",
      url: "https://example.com/story",
      sourceId: "src-feed",
      sourceName: "Example Feed",
      sourceType: "web",
      publishedAt: "2026-05-15T12:00:00.000Z",
      collectedAt: "2026-05-15T12:30:00.000Z"
    }
  ],
  lastCollectedAt: "2026-06-30T01:00:00.000Z"
};

test("config defaults have the expected shape", () => {
  assert.equal(DEFAULT_CATEGORIES.length, 10);
  assert.equal(DEFAULT_CATEGORIES[0].name, "Politics");
  assert.ok(DEFAULT_CATEGORIES.every((category) => Array.isArray(category.keywords)));
  assert.ok(DEFAULT_CATEGORIES.every((category) => category.keywords.every((word) => word === word.toLowerCase())));
  assert.ok(Array.isArray(DEFAULT_SENTIMENT.positive) && DEFAULT_SENTIMENT.positive.includes("growth"));
  assert.ok(Array.isArray(DEFAULT_SENTIMENT.negative) && DEFAULT_SENTIMENT.negative.includes("crisis"));
  assert.ok(STOP_WORDS instanceof Set);
  assert.ok(STOP_WORDS.size >= 55);
  assert.ok(STOP_WORDS.has("said") && STOP_WORDS.has("about") && STOP_WORDS.has("would"));
  assert.ok(STOP_WORDS.has("dass") && STOP_WORDS.has("und"), "includes German function words");
  assert.equal(DEFAULT_SETTINGS.ai.model, "claude-opus-4-8");
  assert.equal(DEFAULT_SETTINGS.autoCollectMinutes, 0);
  assert.equal(DEFAULT_SETTINGS.maxArticles, 2000);
});

test("emptyStore returns a full v3 shell without demo content", () => {
  const store = emptyStore();
  assert.equal(store.version, 3);
  assert.equal(store.rev, 0);
  assert.deepEqual(store.market.instruments, []);
  assert.deepEqual(store.market.prices, {});
  assert.equal(store.market.lastRefreshAt, null);
  assert.deepEqual(store.settings.market, {
    enabled: true,
    provider: "yahoo",
    minRefreshMinutes: 180,
    maxInstruments: 40,
    historyDays: 400,
    preferXetra: true,
    benchmarkEUR: "^GDAXI",
    aiMapping: false,
    alerts: { enabled: false, minScore: 45 }
  });
  assert.deepEqual(store.sources, []);
  assert.deepEqual(store.articles, []);
  assert.deepEqual(store.watchlists, []);
  assert.deepEqual(store.collections, []);
  assert.equal(store.lastCollectedAt, null);
  assert.deepEqual(store.settings, DEFAULT_SETTINGS);
  assert.deepEqual(store.categories, DEFAULT_CATEGORIES);
  assert.deepEqual(store.sentiment, DEFAULT_SENTIMENT);

  store.categories[0].keywords.push("mutated");
  store.settings.ai.model = "changed";
  assert.ok(!DEFAULT_CATEGORIES[0].keywords.includes("mutated"), "emptyStore must clone defaults");
  assert.equal(DEFAULT_SETTINGS.ai.model, "claude-opus-4-8");
});

test("migrate upgrades a legacy v1 store to the full v2 shape", () => {
  const migrated = migrate(structuredClone(LEGACY_V1_FIXTURE));

  assert.equal(migrated.version, CURRENT_VERSION);
  assert.deepEqual(migrated.settings, DEFAULT_SETTINGS);
  assert.deepEqual(migrated.categories, DEFAULT_CATEGORIES);
  assert.deepEqual(migrated.sentiment, DEFAULT_SENTIMENT);
  assert.deepEqual(migrated.watchlists, []);
  assert.deepEqual(migrated.collections, []);
  assert.equal(migrated.lastCollectedAt, "2026-06-30T01:00:00.000Z");

  assert.equal(migrated.sources.length, 2);
  for (const source of migrated.sources) {
    assert.equal(source.paused, false);
    assert.equal(source.etag, null);
    assert.equal(source.lastModified, null);
    assert.deepEqual(source.health, {
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastStatus: null
    });
  }

  assert.equal(migrated.articles.length, 2);
  for (const article of migrated.articles) {
    assert.deepEqual(article.entities, { people: [], orgs: [], places: [] });
    assert.equal(article.clusterId, null);
    assert.equal(article.read, false);
    assert.equal(article.starred, false);
    assert.equal(article.aiEnriched, false);
    assert.equal(article.fullTextFetched, false);
    assert.ok(Array.isArray(article.keywords));
    assert.ok(["positive", "neutral", "watch"].includes(article.sentiment));
    assert.ok(article.readingMinutes >= 1);
  }

  const rich = migrated.articles[0];
  assert.equal(rich.category, "Technology");
  assert.deepEqual(rich.keywords, ["chips", "capacity"]);
  assert.equal(rich.monthKey, "2026-06");

  const sparse = migrated.articles[1];
  assert.equal(sparse.monthKey, "2026-05", "missing monthKey is derived from publishedAt");
  assert.equal(sparse.category, "World");
  assert.equal(sparse.summary, "");
  assert.equal(sparse.sentiment, "neutral");
});

test("migrate merges missing settings/categories/sentiment and preserves overrides", () => {
  const migrated = migrate({
    version: 2,
    settings: { maxArticles: 500, ai: { enabled: true } },
    categories: [{ name: "Custom", keywords: ["Alpha", "BETA"] }],
    sentiment: { positive: ["up"] }
  });

  assert.equal(migrated.settings.maxArticles, 500);
  assert.equal(migrated.settings.autoCollectMinutes, DEFAULT_SETTINGS.autoCollectMinutes);
  assert.equal(migrated.settings.ai.enabled, true);
  assert.equal(migrated.settings.ai.model, DEFAULT_SETTINGS.ai.model);
  assert.deepEqual(migrated.settings.webhooks, []);
  assert.equal(migrated.settings.apiToken, "");
  assert.deepEqual(migrated.categories, [{ name: "Custom", keywords: ["alpha", "beta"] }]);
  assert.deepEqual(migrated.sentiment.positive, ["up"]);
  assert.deepEqual(migrated.sentiment.negative, DEFAULT_SENTIMENT.negative);
});

test("migrate rejects non-objects and passes future versions through", () => {
  for (const bad of [null, undefined, 42, "store", [1, 2, 3]]) {
    assert.throws(() => migrate(bad), /Unrecognized store format/);
  }
  const future = { version: 4, anything: true };
  assert.equal(migrate(future), future, "future versions are returned as-is");
});

test("migrate upgrades a v2 store to v3 with full market defaults", () => {
  const migrated = migrate({
    version: 2,
    settings: { maxArticles: 500 },
    sources: LEGACY_V1_FIXTURE.sources,
    articles: LEGACY_V1_FIXTURE.articles
  });

  assert.equal(migrated.version, 3);
  assert.equal(migrated.rev, 0);
  assert.equal(migrated.settings.maxArticles, 500, "existing settings survive");
  assert.deepEqual(migrated.settings.market, DEFAULT_SETTINGS.market);
  assert.deepEqual(migrated.market.instruments, []);
  assert.deepEqual(migrated.market.prices, {});
  assert.deepEqual(migrated.market.ideas, []);
  assert.deepEqual(migrated.market.signalLog, []);
  assert.deepEqual(migrated.market.providerHealth,
    { provider: "yahoo", ok: true, cooldownUntil: null, lastError: null, lastOkAt: null });
  assert.equal(migrated.articles.length, 2, "articles are untouched by the market migration");
});

test("migrateMarket never throws and degrades garbage to defaults (invariant 7)", () => {
  const hostile = {
    version: 3,
    rev: "not-a-number",
    settings: { market: { minRefreshMinutes: -5, maxInstruments: 9999, benchmarkEUR: "^EVIL", enabled: "yes" } },
    market: {
      instruments: [
        null, 42, "IFX.DE",
        { ticker: "^GDAXI" },                        // leading ^ rejected
        { ticker: "way-too-long-ticker-name-here" },
        { ticker: "ifx.de", confidence: 7, sizeHint: "gigantic", source: "hacker", aliases: [1, 2, null] },
        { ticker: "SAP.DE", name: "SAP SE" },
        { ticker: "SAP.DE", name: "duplicate dropped" }
      ],
      prices: {
        "IFX.DE": { dates: ["2026-07-01", "2026-07-02"], closes: [34.1] },   // length mismatch -> dropped
        "SAP.DE": { dates: ["2026-07-01", "bad-date", "2026-07-03"], closes: [139, 140, "x"], quote: { price: "nan" } },
        "": { dates: [], closes: [] }
      },
      ideas: [
        { ticker: "IFX.DE", status: "maybe" },
        { ticker: "SAP.DE", status: "pinned", scoreAt: "not-a-score", evidenceArticleIds: "nope" }
      ],
      signalLog: Array.from({ length: 500 }, () => ({})),
      mappings: { good: { status: "private" }, bad: "string" },
      ignoredEntities: ["one", 2, null],
      narratives: "garbage",
      alertState: [],
      providerHealth: { ok: "broken", cooldownUntil: 42 },
      refreshLog: Array.from({ length: 50 }, () => ({}))
    }
  };

  let migrated;
  assert.doesNotThrow(() => { migrated = migrate(hostile); });
  assert.equal(migrated.rev, 0);
  assert.equal(migrated.settings.market.minRefreshMinutes, 180);
  assert.equal(migrated.settings.market.maxInstruments, 40);
  assert.equal(migrated.settings.market.benchmarkEUR, "^GDAXI");
  assert.equal(migrated.settings.market.enabled, true);

  const tickers = migrated.market.instruments.map((i) => i.ticker);
  assert.deepEqual(tickers, ["IFX.DE", "SAP.DE"], "garbage/dupe/index instruments dropped");
  const ifx = migrated.market.instruments[0];
  assert.equal(ifx.confidence, 1);
  assert.equal(ifx.sizeHint, null);
  assert.equal(ifx.source, "user");
  assert.ok(ifx.aliases.length >= 1, "aliases fall back to the name");

  assert.equal(migrated.market.prices["IFX.DE"], undefined, "length-mismatched series dropped");
  assert.deepEqual(migrated.market.prices["SAP.DE"].dates, ["2026-07-01"], "bad bars filtered pairwise");
  assert.deepEqual(migrated.market.prices["SAP.DE"].closes, [139]);
  assert.equal(migrated.market.prices["SAP.DE"].quote, null);

  assert.equal(migrated.market.ideas.length, 1, "invalid idea status dropped");
  assert.equal(migrated.market.ideas[0].scoreAt, 0, "non-numeric scoreAt defaults");
  assert.deepEqual(migrated.market.ideas[0].evidenceArticleIds, [], "non-array evidence defaults");
  assert.equal(migrated.market.signalLog.length, 120, "signalLog capped");
  assert.equal(migrated.market.refreshLog.length, 10, "refreshLog capped");
  assert.deepEqual(Object.keys(migrated.market.mappings), ["good"]);
  assert.deepEqual(migrated.market.ignoredEntities, ["one"]);
  assert.deepEqual(migrated.market.narratives, {});
  assert.deepEqual(migrated.market.alertState, {});
  assert.equal(migrated.market.providerHealth.ok, true);
  assert.equal(migrated.market.providerHealth.cooldownUntil, null);
});

test("populated v3 market data round-trips through migrate unstripped", () => {
  const store = emptyStore();
  store.market.instruments.push({
    ticker: "IFX.DE", name: "Infineon Technologies", aliases: ["infineon"],
    exchange: "XETRA", currency: "EUR", sizeHint: "large", paused: false,
    source: "user", confidence: 1, confirmed: true,
    addedAt: "2026-07-05T10:00:00.000Z", validatedAt: "2026-07-05T10:00:00.000Z", staleSymbol: false
  });
  store.market.prices["IFX.DE"] = {
    currency: "EUR",
    quote: { price: 34.12, marketTime: "2026-07-03T15:35:00.000Z", exchange: "XETRA" },
    dates: ["2026-07-02", "2026-07-03"], closes: [33.9, 34.12],
    updatedAt: "2026-07-03T20:00:00.000Z", lastFullAt: "2026-07-01T20:00:00.000Z", stale: false
  };
  store.market.prices["^GDAXI"] = {
    currency: "EUR", quote: { price: 25779.31, marketTime: "2026-07-03T15:40:00.000Z", exchange: "XETRA" },
    dates: ["2026-07-03"], closes: [25779.31],
    updatedAt: "2026-07-03T20:00:00.000Z", lastFullAt: "2026-07-03T20:00:00.000Z", stale: false
  };
  store.market.ideas.push({
    ticker: "IFX.DE", status: "pinned", note: "Q3 prüfen", at: "2026-07-05T07:30:00.000Z",
    evidenceArticleIds: ["a1", "a2"], scoreAt: 41
  });
  store.market.lastRefreshAt = "2026-07-03T20:00:00.000Z";

  const migrated = migrate(structuredClone(store));
  assert.deepEqual(migrated.market, store.market, "migrate must not strip valid market data");
});

test("validateConfigPatch handles settings.market and rejects bad values", () => {
  const patch = validateConfigPatch({
    settings: { market: { enabled: false, minRefreshMinutes: 60, benchmarkEUR: "^TECDAX" } }
  });
  assert.deepEqual(patch.settings.market, { enabled: false, minRefreshMinutes: 60, benchmarkEUR: "^TECDAX" });

  assert.throws(() => validateConfigPatch({ settings: { market: { minRefreshMinutes: 10 } } }), /minRefreshMinutes/);
  assert.throws(() => validateConfigPatch({ settings: { market: { maxInstruments: 0 } } }), /maxInstruments/);
  assert.throws(() => validateConfigPatch({ settings: { market: { historyDays: 5000 } } }), /historyDays/);
  assert.throws(() => validateConfigPatch({ settings: { market: { benchmarkEUR: "^SPX" } } }), /benchmarkEUR/);
  assert.throws(() => validateConfigPatch({ settings: { market: { provider: "bloomberg" } } }), /provider/);
  assert.throws(() => validateConfigPatch({ settings: { market: { enabled: "yes" } } }), /enabled/);
});

test("Store.update bumps rev on every mutation; read does not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const store = new Store(path.join(dir, "store.json"));
    const first = await store.read();
    assert.equal(first.rev, 0);

    const afterOne = await store.update(() => {});
    assert.equal(afterOne.rev, 1, "even a no-op mutator bumps rev");
    const afterTwo = await store.update((data) => { data.settings.maxArticles = 3000; });
    assert.equal(afterTwo.rev, 2);

    const readBack = await store.read();
    assert.equal(readBack.rev, 2, "read must not bump rev");

    const replaced = await store.replace(structuredClone(LEGACY_V1_FIXTURE));
    assert.equal(replaced.rev, 1, "replace migrates (rev 0) then bumps");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loading an older-versioned file writes a one-time backup of the original bytes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const filePath = path.join(dir, "store.json");
    const v2Bytes = JSON.stringify({ ...structuredClone(LEGACY_V1_FIXTURE), version: 2 }, null, 2);
    await writeFile(filePath, v2Bytes, "utf8");

    const store = new Store(filePath);
    const data = await store.read();
    assert.equal(data.version, CURRENT_VERSION);

    const backupPath = `${filePath}.v2.backup.json`;
    assert.equal(await readFile(backupPath, "utf8"), v2Bytes, "backup carries the original bytes");

    // Tamper with the backup, reload a (still old) file: the backup must not be rewritten.
    await writeFile(backupPath, "tampered", "utf8");
    await writeFile(filePath, v2Bytes, "utf8");
    await store.read();
    assert.equal(await readFile(backupPath, "utf8"), "tampered", "once-written backups are never overwritten");

    // Version-less v1 files back up as .v1.
    const v1Path = path.join(dir, "v1.json");
    const v1Bytes = JSON.stringify({ sources: [], articles: [] });
    await writeFile(v1Path, v1Bytes, "utf8");
    await new Store(v1Path).read();
    assert.equal(await readFile(`${v1Path}.v1.backup.json`, "utf8"), v1Bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt file is preserved as a .corrupt-*.json copy before reseeding", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const filePath = path.join(dir, "store.json");
    await writeFile(filePath, "{ definitely broken", "utf8");

    const store = new Store(filePath);
    const data = await store.read();
    assert.equal(data.version, CURRENT_VERSION, "reseeded after corruption");

    const { readdir } = await import("node:fs/promises");
    const backups = (await readdir(dir)).filter((name) => name.includes(".corrupt-"));
    assert.equal(backups.length, 1, "original bytes preserved before reseed");
    assert.equal(await readFile(path.join(dir, backups[0]), "utf8"), "{ definitely broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Store.update serializes 10 concurrent updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const store = new Store(path.join(dir, "store.json"));
    await store.read();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update((data) => {
          data.articles.push({
            id: `concurrent-${index}`,
            title: `Concurrent story ${index}`,
            publishedAt: "2026-07-01T00:00:00.000Z",
            collectedAt: "2026-07-01T00:00:00.000Z"
          });
          data.settings.maxArticles += 1;
        })
      )
    );

    const final = await store.read();
    assert.equal(final.articles.length, 10, "no update may be lost to a read-modify-write race");
    assert.equal(final.settings.maxArticles, DEFAULT_SETTINGS.maxArticles + 10);
    const ids = new Set(final.articles.map((article) => article.id));
    assert.equal(ids.size, 10);

    const onDisk = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(onDisk.articles.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Store.read recovers from a corrupt file by seeding and rewriting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const filePath = path.join(dir, "store.json");
    await writeFile(filePath, "{ this is not valid json !!!", "utf8");

    const seedFn = () => {
      const seeded = emptyStore();
      seeded.watchlists.push({ id: "wl-seed", name: "Seed Marker" });
      return seeded;
    };
    const store = new Store(filePath, { seedFn });

    const data = await store.read();
    assert.equal(data.version, CURRENT_VERSION);
    assert.equal(data.watchlists.length, 1);
    assert.equal(data.watchlists[0].id, "wl-seed");
    assert.equal(data.watchlists[0].name, "Seed Marker");

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(onDisk.version, CURRENT_VERSION);
    assert.equal(onDisk.watchlists[0].id, "wl-seed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Store.read seeds a missing file and Store.replace migrates input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "news-store-"));
  try {
    const filePath = path.join(dir, "store.json");
    const store = new Store(filePath);

    const seeded = await store.read();
    assert.equal(seeded.version, CURRENT_VERSION);
    assert.deepEqual(seeded.articles, []);

    const replaced = await store.replace(structuredClone(LEGACY_V1_FIXTURE));
    assert.equal(replaced.version, CURRENT_VERSION);
    assert.equal(replaced.articles.length, 2);
    assert.equal(replaced.articles[0].read, false);

    await assert.rejects(() => store.replace("garbage"), /Unrecognized store format/);

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(onDisk.sources.length, 2, "failed replace must not clobber the previous write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateConfigPatch normalizes valid patches", () => {
  const patch = validateConfigPatch({
    settings: {
      autoCollectMinutes: 15,
      maxArticles: 1500,
      ai: { enabled: true, model: "  claude-opus-4-8  ", maxArticlesPerCollect: 10, apiKey: null },
      webhooks: [{ url: " https://example.com/hook " }],
      apiToken: " secret-token "
    },
    categories: [
      { name: " Tech ", keywords: ["AI", "Chips", "ai", ""] },
      { name: "World" }
    ],
    sentiment: { positive: ["UP", "gain "], negative: ["down"] }
  });

  assert.equal(patch.settings.autoCollectMinutes, 15);
  assert.equal(patch.settings.maxArticles, 1500);
  assert.equal(patch.settings.ai.model, "claude-opus-4-8");
  assert.equal(patch.settings.ai.apiKey, null);
  assert.equal(patch.settings.apiToken, "secret-token");
  assert.equal(patch.settings.webhooks.length, 1);
  assert.equal(patch.settings.webhooks[0].url, "https://example.com/hook");
  assert.match(patch.settings.webhooks[0].id, /^wh-/);
  assert.ok(patch.settings.webhooks[0].createdAt);
  assert.deepEqual(patch.categories, [
    { name: "Tech", keywords: ["ai", "chips"] },
    { name: "World", keywords: [] }
  ]);
  assert.deepEqual(patch.sentiment, { positive: ["up", "gain"], negative: ["down"] });
});

test("validateConfigPatch rejects invalid values with human messages", () => {
  assert.throws(() => validateConfigPatch(null), /Config patch/);
  assert.throws(() => validateConfigPatch({ settings: { autoCollectMinutes: 3 } }), /autoCollectMinutes/);
  assert.throws(() => validateConfigPatch({ settings: { autoCollectMinutes: 1441 } }), /autoCollectMinutes/);
  assert.throws(() => validateConfigPatch({ settings: { maxArticles: 50 } }), /maxArticles/);
  assert.throws(() => validateConfigPatch({ settings: { ai: { model: "" } } }), /ai\.model/);
  assert.throws(() => validateConfigPatch({ settings: { ai: { maxArticlesPerCollect: 0 } } }), /maxArticlesPerCollect/);
  assert.throws(() => validateConfigPatch({ settings: { webhooks: [{ url: "ftp://x" }] } }), /webhook/);
  assert.throws(() => validateConfigPatch({ categories: [] }), /non-empty/);
  assert.throws(() => validateConfigPatch({ categories: [{ name: "" }] }), /name/);
  assert.throws(
    () => validateConfigPatch({ categories: [{ name: "Tech" }, { name: "tech" }] }),
    /Duplicate category/
  );
  assert.throws(() => validateConfigPatch({ sentiment: { positive: "up" } }), /sentiment\.positive/);
  assert.doesNotThrow(() => validateConfigPatch({ settings: { autoCollectMinutes: 0 } }));
  assert.doesNotThrow(() => validateConfigPatch({}));
});
