import crypto from "node:crypto";
import { BENCHMARK_EUR_SYMBOLS, DEFAULT_CATEGORIES, DEFAULT_SENTIMENT, DEFAULT_SETTINGS } from "../config.mjs";

export const CURRENT_VERSION = 3;

const SOURCE_TYPES = ["rss", "web", "auto", "manual"];
const SENTIMENT_VALUES = ["positive", "neutral", "watch"];
const HEALTH_STATUSES = ["ok", "error", "not-modified"];
const INSTRUMENT_SOURCES = ["user", "seed", "search", "ai"];
const SIZE_HINTS = ["large", "mid", "small"];
const TICKER_RE = /^[A-Z0-9.-]{1,12}$/;

export function migrate(raw) {
  if (!isPlainObject(raw)) {
    throw new Error("Unrecognized store format");
  }
  if (typeof raw.version === "number" && raw.version > CURRENT_VERSION) {
    return raw;
  }

  const settings = migrateSettings(raw.settings);
  return {
    version: CURRENT_VERSION,
    rev: countOr(raw.rev, 0),
    settings,
    categories: migrateCategories(raw.categories),
    sentiment: migrateSentiment(raw.sentiment),
    sources: asArray(raw.sources).map(migrateSource),
    articles: asArray(raw.articles).map(migrateArticle),
    watchlists: asArray(raw.watchlists).map(migrateWatchlist).filter(Boolean),
    collections: asArray(raw.collections).map(migrateCollection).filter(Boolean).slice(0, 20),
    market: migrateMarket(raw.market, settings.market),
    brief: migrateStoredBrief(raw.brief),
    lastCollectedAt: stringOrNull(raw.lastCollectedAt)
  };
}

function migrateSettings(rawSettings) {
  const settings = isPlainObject(rawSettings) ? rawSettings : {};
  const ai = isPlainObject(settings.ai) ? settings.ai : {};

  return {
    autoCollectMinutes: countOr(settings.autoCollectMinutes, DEFAULT_SETTINGS.autoCollectMinutes),
    maxArticles: countOr(settings.maxArticles, DEFAULT_SETTINGS.maxArticles),
    ai: {
      enabled: typeof ai.enabled === "boolean" ? ai.enabled : DEFAULT_SETTINGS.ai.enabled,
      apiKey: typeof ai.apiKey === "string" ? ai.apiKey : DEFAULT_SETTINGS.ai.apiKey,
      model: typeof ai.model === "string" && ai.model !== "" ? ai.model : DEFAULT_SETTINGS.ai.model,
      maxArticlesPerCollect: countOr(ai.maxArticlesPerCollect, DEFAULT_SETTINGS.ai.maxArticlesPerCollect)
    },
    webhooks: asArray(settings.webhooks).map(migrateWebhook).filter(Boolean),
    apiToken: typeof settings.apiToken === "string" ? settings.apiToken : DEFAULT_SETTINGS.apiToken,
    market: migrateMarketSettings(settings.market),
    brief: migrateBriefSettings(settings.brief)
  };
}

function migrateBriefSettings(rawBrief) {
  const brief = isPlainObject(rawBrief) ? rawBrief : {};
  const defaults = DEFAULT_SETTINGS.brief;
  return {
    enabled: typeof brief.enabled === "boolean" ? brief.enabled : defaults.enabled,
    hour: boundedIntOr(brief.hour, 0, 23, defaults.hour),
    minute: boundedIntOr(brief.minute, 0, 59, defaults.minute),
    lookbackHours: boundedIntOr(brief.lookbackHours, 1, 168, defaults.lookbackHours),
    maxStories: boundedIntOr(brief.maxStories, 3, 30, defaults.maxStories),
    push: typeof brief.push === "boolean" ? brief.push : defaults.push
  };
}

// The last generated brief (top-level, not settings). Never throws — garbage degrades to null,
// matching the invariant-7 contract so a bad brief can't nuke real news data on load.
function migrateStoredBrief(rawBrief) {
  if (!isPlainObject(rawBrief)) {
    return null;
  }
  const generatedAt = stringOrNull(rawBrief.generatedAt);
  if (!generatedAt) {
    return null;
  }
  return {
    generatedAt,
    trigger: rawBrief.trigger === "schedule" ? "schedule" : "manual",
    source: rawBrief.source === "ai" ? "ai" : "fallback",
    title: stringOr(rawBrief.title, "Morning Brief"),
    markdown: typeof rawBrief.markdown === "string" ? rawBrief.markdown : "",
    html: typeof rawBrief.html === "string" ? rawBrief.html : "",
    text: typeof rawBrief.text === "string" ? rawBrief.text : "",
    storyCount: countOr(rawBrief.storyCount, 0),
    windowHours: countOr(rawBrief.windowHours, 24),
    model: stringOrNull(rawBrief.model),
    error: stringOrNull(rawBrief.error)
  };
}

function migrateMarketSettings(rawMarket) {
  const market = isPlainObject(rawMarket) ? rawMarket : {};
  const defaults = DEFAULT_SETTINGS.market;
  return {
    enabled: typeof market.enabled === "boolean" ? market.enabled : defaults.enabled,
    provider: market.provider === "yahoo" ? market.provider : defaults.provider,
    minRefreshMinutes: boundedIntOr(market.minRefreshMinutes, 30, 1440, defaults.minRefreshMinutes),
    maxInstruments: boundedIntOr(market.maxInstruments, 1, 100, defaults.maxInstruments),
    historyDays: boundedIntOr(market.historyDays, 90, 1000, defaults.historyDays),
    preferXetra: typeof market.preferXetra === "boolean" ? market.preferXetra : defaults.preferXetra,
    benchmarkEUR: BENCHMARK_EUR_SYMBOLS.includes(market.benchmarkEUR) ? market.benchmarkEUR : defaults.benchmarkEUR,
    aiMapping: typeof market.aiMapping === "boolean" ? market.aiMapping : defaults.aiMapping,
    alerts: {
      enabled: isPlainObject(market.alerts) && typeof market.alerts.enabled === "boolean"
        ? market.alerts.enabled
        : defaults.alerts.enabled,
      minScore: isPlainObject(market.alerts)
        ? boundedIntOr(market.alerts.minScore, 1, 100, defaults.alerts.minScore)
        : defaults.alerts.minScore
    }
  };
}

// Invariant 7: migrateMarket and every sub-migrator NEVER throw — arbitrary garbage in any
// sub-key degrades to defaults. Store#load treats a migrate throw as corruption and reseeds,
// so a throwing market migrator could destroy real news data.
function migrateMarket(rawMarket, marketSettings) {
  const market = isPlainObject(rawMarket) ? rawMarket : {};
  const historyDays = marketSettings.historyDays;
  const health = isPlainObject(market.providerHealth) ? market.providerHealth : {};

  const instruments = [];
  const seenTickers = new Set();
  for (const raw of asArray(market.instruments)) {
    const instrument = migrateInstrument(raw);
    if (instrument && !seenTickers.has(instrument.ticker)) {
      seenTickers.add(instrument.ticker);
      instruments.push(instrument);
    }
    if (instruments.length >= 100) {
      break;
    }
  }

  const prices = {};
  if (isPlainObject(market.prices)) {
    for (const [symbol, rawSeries] of Object.entries(market.prices)) {
      if (typeof symbol !== "string" || symbol === "" || symbol.length > 14) {
        continue;
      }
      const series = migratePriceSeries(rawSeries, historyDays);
      if (series) {
        prices[symbol] = series;
      }
    }
  }

  const ideas = [];
  const seenIdeaTickers = new Set();
  for (const raw of asArray(market.ideas)) {
    const idea = migrateIdea(raw);
    if (idea && !seenIdeaTickers.has(idea.ticker)) {
      seenIdeaTickers.add(idea.ticker);
      ideas.push(idea);
    }
  }

  const narratives = {};
  if (isPlainObject(market.narratives)) {
    for (const [ticker, value] of Object.entries(market.narratives).slice(0, 30)) {
      if (isPlainObject(value)) {
        narratives[ticker] = value;
      }
    }
  }

  return {
    instruments,
    prices,
    ideas,
    signalLog: asArray(market.signalLog).filter(isPlainObject).slice(0, 120),
    mappings: isPlainObject(market.mappings)
      ? Object.fromEntries(Object.entries(market.mappings).filter(([, value]) => isPlainObject(value)))
      : {},
    ignoredEntities: stringArray(market.ignoredEntities),
    narratives,
    alertState: isPlainObject(market.alertState)
      ? Object.fromEntries(Object.entries(market.alertState).filter(([, value]) => isPlainObject(value)))
      : {},
    providerHealth: {
      provider: "yahoo",
      ok: health.ok !== false,
      cooldownUntil: stringOrNull(health.cooldownUntil),
      lastError: stringOrNull(health.lastError),
      lastOkAt: stringOrNull(health.lastOkAt)
    },
    lastRefreshAt: stringOrNull(market.lastRefreshAt),
    refreshLog: asArray(market.refreshLog).filter(isPlainObject).slice(0, 10)
  };
}

function migrateInstrument(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
  if (!TICKER_RE.test(ticker)) {
    return null;
  }
  const confidence = Number(raw.confidence);
  return {
    ticker,
    name: stringOr(raw.name, ticker),
    aliases: uniqueLower(stringArray(raw.aliases), stringOr(raw.name, ticker).toLowerCase()),
    exchange: typeof raw.exchange === "string" ? raw.exchange : "",
    currency: typeof raw.currency === "string" ? raw.currency : "",
    sizeHint: SIZE_HINTS.includes(raw.sizeHint) ? raw.sizeHint : null,
    paused: raw.paused === true,
    source: INSTRUMENT_SOURCES.includes(raw.source) ? raw.source : "user",
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 1,
    confirmed: raw.confirmed === true,
    addedAt: stringOr(raw.addedAt, new Date().toISOString()),
    validatedAt: stringOrNull(raw.validatedAt),
    staleSymbol: raw.staleSymbol === true
  };
}

function migratePriceSeries(raw, historyDays) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const rawDates = asArray(raw.dates);
  const rawCloses = asArray(raw.closes);
  if (rawDates.length !== rawCloses.length) {
    return null;
  }
  const dates = [];
  const closes = [];
  for (let i = 0; i < rawDates.length; i += 1) {
    const date = rawDates[i];
    const close = Number(rawCloses[i]);
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close)) {
      dates.push(date);
      closes.push(close);
    }
  }
  const start = Math.max(0, dates.length - historyDays);
  const quote = isPlainObject(raw.quote) ? raw.quote : null;
  const quotePrice = quote ? Number(quote.price) : NaN;
  return {
    currency: typeof raw.currency === "string" ? raw.currency : "",
    quote: quote && Number.isFinite(quotePrice)
      ? {
          price: quotePrice,
          marketTime: stringOrNull(quote.marketTime),
          exchange: typeof quote.exchange === "string" ? quote.exchange : ""
        }
      : null,
    dates: dates.slice(start),
    closes: closes.slice(start),
    updatedAt: stringOrNull(raw.updatedAt),
    lastFullAt: stringOrNull(raw.lastFullAt),
    stale: raw.stale === true
  };
}

function migrateIdea(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
  if (!TICKER_RE.test(ticker) || !["pinned", "dismissed"].includes(raw.status)) {
    return null;
  }
  const scoreAt = Number(raw.scoreAt);
  return {
    ticker,
    status: raw.status,
    note: typeof raw.note === "string" ? raw.note : "",
    at: stringOr(raw.at, new Date().toISOString()),
    evidenceArticleIds: stringArray(raw.evidenceArticleIds).slice(0, 20),
    scoreAt: Number.isFinite(scoreAt) ? Math.round(scoreAt) : 0
  };
}

function uniqueLower(values, fallback) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = value.toLowerCase();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  if (result.length === 0 && fallback) {
    result.push(fallback);
  }
  return result;
}

function boundedIntOr(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function migrateWebhook(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  return {
    id: stringOr(raw.id, `wh-${randomHex(6)}`),
    url,
    format: raw.format === "ntfy" ? "ntfy" : "json",
    createdAt: stringOr(raw.createdAt, new Date().toISOString())
  };
}

function migrateCategories(rawCategories) {
  const entries = asArray(rawCategories)
    .map((entry) => (Array.isArray(entry) ? { name: entry[0], keywords: entry[1] } : entry))
    .filter((entry) => isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim() !== "")
    .map((entry) => ({
      name: entry.name.trim(),
      keywords: stringArray(entry.keywords).map((word) => word.toLowerCase())
    }));
  return entries.length ? entries : structuredClone(DEFAULT_CATEGORIES);
}

function migrateSentiment(rawSentiment) {
  const sentiment = isPlainObject(rawSentiment) ? rawSentiment : {};
  return {
    positive: Array.isArray(sentiment.positive)
      ? stringArray(sentiment.positive).map((word) => word.toLowerCase())
      : [...DEFAULT_SENTIMENT.positive],
    negative: Array.isArray(sentiment.negative)
      ? stringArray(sentiment.negative).map((word) => word.toLowerCase())
      : [...DEFAULT_SENTIMENT.negative]
  };
}

function migrateSource(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const health = isPlainObject(source.health) ? source.health : {};
  const url = typeof source.url === "string" ? source.url : "";

  return {
    id: stringOr(source.id, `src-${randomHex(6)}`),
    name: stringOr(source.name, url || "Untitled source"),
    url,
    type: SOURCE_TYPES.includes(source.type) ? source.type : "auto",
    createdAt: stringOr(source.createdAt, new Date().toISOString()),
    paused: source.paused === true,
    etag: stringOrNull(source.etag),
    lastModified: stringOrNull(source.lastModified),
    health: {
      successCount: countOr(health.successCount, 0),
      failureCount: countOr(health.failureCount, 0),
      consecutiveFailures: countOr(health.consecutiveFailures, 0),
      lastError: stringOrNull(health.lastError),
      lastSuccessAt: stringOrNull(health.lastSuccessAt),
      lastFailureAt: stringOrNull(health.lastFailureAt),
      lastStatus: HEALTH_STATUSES.includes(health.lastStatus) ? health.lastStatus : null
    }
  };
}

function migrateArticle(raw) {
  const article = isPlainObject(raw) ? raw : {};
  const collectedAt = stringOr(article.collectedAt, new Date().toISOString());
  const publishedAt = stringOr(article.publishedAt, collectedAt);
  const entities = isPlainObject(article.entities) ? article.entities : {};
  const readingMinutes = Number(article.readingMinutes);

  return {
    id: stringOr(article.id, `art-${randomHex(10)}`),
    title: stringOr(article.title, "Untitled story"),
    url: typeof article.url === "string" ? article.url : "",
    sourceId: typeof article.sourceId === "string" ? article.sourceId : "",
    sourceName: stringOr(article.sourceName, "Unknown source"),
    sourceType: stringOr(article.sourceType, "manual"),
    publishedAt,
    collectedAt,
    monthKey: typeof article.monthKey === "string" && /^\d{4}-\d{2}$/.test(article.monthKey)
      ? article.monthKey
      : toMonthKey(publishedAt),
    category: stringOr(article.category, "World"),
    summary: typeof article.summary === "string" ? article.summary : "",
    keywords: stringArray(article.keywords),
    sentiment: SENTIMENT_VALUES.includes(article.sentiment) ? article.sentiment : "neutral",
    entities: {
      people: stringArray(entities.people),
      orgs: stringArray(entities.orgs),
      places: stringArray(entities.places)
    },
    readingMinutes: Number.isFinite(readingMinutes) && readingMinutes >= 1 ? Math.round(readingMinutes) : 1,
    clusterId: stringOrNull(article.clusterId),
    read: article.read === true,
    starred: article.starred === true,
    aiEnriched: article.aiEnriched === true,
    fullTextFetched: article.fullTextFetched === true
  };
}

function migrateWatchlist(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  return {
    id: stringOr(raw.id, `wl-${randomHex(6)}`),
    name: stringOr(raw.name, "Watchlist"),
    keywords: stringArray(raw.keywords),
    categories: stringArray(raw.categories),
    sources: stringArray(raw.sources),
    createdAt: stringOr(raw.createdAt, new Date().toISOString())
  };
}

function migrateCollection(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  return {
    at: stringOr(raw.at, new Date().toISOString()),
    added: countOr(raw.added, 0),
    attempted: countOr(raw.attempted, 0),
    durationMs: countOr(raw.durationMs, 0),
    failures: asArray(raw.failures)
      .filter(isPlainObject)
      .map((failure) => ({
        sourceId: typeof failure.sourceId === "string" ? failure.sourceId : "",
        name: typeof failure.name === "string" ? failure.name : "",
        message: typeof failure.message === "string" ? failure.message : ""
      })),
    aiEnriched: countOr(raw.aiEnriched, 0)
  };
}

function toMonthKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringArray(value) {
  return asArray(value)
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function countOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
