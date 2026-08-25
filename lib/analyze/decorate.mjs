import { summarizeHealth } from "./health.mjs";
import { computeTrends } from "./trends.mjs";
import { matchWatchlists } from "./alerts.mjs";
import { benchmarksFor, isSeriesStale } from "../market/prices.mjs";
import { matchArticlesToInstruments } from "../market/instruments.mjs";
import { computeSignals, reviewSignalLog, shouldResurface } from "../market/signals.mjs";
import { explainComponent, flagLabel, quadrantLabel, unscoredReason } from "../market/format.mjs";
import { detectNewNames, suggestCandidates } from "../market/mapping.mjs";

export const MARKET_DISCLAIMER =
  "Not investment advice, no recommendation. A personal digest of public news and " +
  "delayed/EOD price data. Signals measure your own feeds, not the market. " +
  "NOT financial advice.";

function maskSettings(settings) {
  const masked = structuredClone(settings || {});
  if (!masked.ai || typeof masked.ai !== "object") {
    masked.ai = {};
  }
  const storedKey = (settings && settings.ai && settings.ai.apiKey) || "";
  masked.ai.apiKey = "";
  masked.ai.apiKeyConfigured = Boolean(storedKey || process.env.ANTHROPIC_API_KEY);
  return masked;
}

function trailingReturn(closes, bars) {
  if (!Array.isArray(closes) || closes.length < bars + 1) {
    return null;
  }
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - bars];
  if (!Number.isFinite(last) || !Number.isFinite(prior) || prior === 0) {
    return null;
  }
  return last / prior - 1;
}

const THIRTY_DAYS_MS = 30 * 86400000;

// Heavy part of the market payload (article matching over articles × instruments). Cached by
// the caller via meta.marketCache keyed on store.rev — every mutation bumps rev, so the cache
// can never serve stale matches (recategorize, fulltext, deletes all invalidate).
function computeMarketPayload(store, nowIso) {
  const settings = store.settings && typeof store.settings.market === "object"
    ? store.settings.market
    : { enabled: false };
  const market = store.market && typeof store.market === "object"
    ? store.market
    : { instruments: [], prices: {}, providerHealth: null, lastRefreshAt: null, refreshLog: [] };
  const instruments = Array.isArray(market.instruments) ? market.instruments : [];
  const prices = market.prices && typeof market.prices === "object" ? market.prices : {};
  const articles = Array.isArray(store.articles) ? store.articles : [];

  const matches = matchArticlesToInstruments(articles, instruments);
  const articleById = new Map(articles.map((article) => [article.id, article]));
  const nowMs = Date.parse(nowIso);

  const benchmarkDefs = benchmarksFor(store.settings || {});
  const benchmarks = {};
  for (const benchmark of benchmarkDefs) {
    const series = prices[benchmark.symbol];
    benchmarks[benchmark.currency] = {
      symbol: benchmark.symbol,
      ret20d: series ? trailingReturn(series.closes, 20) : null
    };
  }

  const decoratedInstruments = instruments.map((instrument) => {
    const series = prices[instrument.ticker];
    const match = matches.get(instrument.ticker) || { articleIds: [], aiEnrichedCount: 0 };
    const mentions30d = match.articleIds.reduce((count, id) => {
      const article = articleById.get(id);
      const time = article ? Date.parse(article.publishedAt) : NaN;
      return count + (Number.isFinite(time) && nowMs - time <= THIRTY_DAYS_MS ? 1 : 0);
    }, 0);
    const lastBarDate = series && series.dates.length ? series.dates[series.dates.length - 1] : null;
    const closes = series ? series.closes : [];
    return {
      ...instrument,
      lastPrice: series && series.quote ? series.quote.price
        : (closes.length ? closes[closes.length - 1] : null),
      priceAsOf: series ? ((series.quote && series.quote.marketTime) || series.updatedAt) : null,
      stale: series ? (series.stale === true || isSeriesStale(lastBarDate, nowIso)) : true,
      ret20d: series ? trailingReturn(closes, 20) : null,
      mentions30d,
      articleIds: match.articleIds.slice(0, 12),
      spark: closes.slice(-30)
    };
  });

  // Signals (Phase 2): score, filter through the user's pin/dismiss memory, and render
  // the numeric facts into German strings here — the frontend stays dumb.
  const ideas = Array.isArray(market.ideas) ? market.ideas : [];
  const ideaByTicker = new Map(ideas.map((idea) => [idea.ticker, idea]));
  const signalInput = {
    articles,
    instruments,
    prices,
    sources: Array.isArray(store.sources) ? store.sources : [],
    settings: store.settings || {},
    nowIso
  };
  const signals = instruments.length
    ? computeSignals(signalInput)
    : { opportunities: [], contrarian: [], unscored: [] };

  const decorateOpportunity = (opportunity) => {
    const idea = ideaByTicker.get(opportunity.ticker) || null;
    const flags = idea && idea.status === "dismissed" && shouldResurface(idea, opportunity)
      ? [...opportunity.flags, "resurfaced"]
      : opportunity.flags;
    return {
      ...opportunity,
      flags,
      flagLabels: flags.map(flagLabel),
      quadrantLabel: quadrantLabel(opportunity.quadrant),
      components: opportunity.components
        .filter((component) => component.value !== null)
        .map((component) => ({ ...component, explain: explainComponent(component) })),
      idea: idea ? { status: idea.status, note: idea.note, at: idea.at } : null
    };
  };

  const opportunities = [];
  const unscored = signals.unscored.map((entry) => ({
    ticker: entry.ticker,
    reasonCode: entry.reasonCode,
    reason: unscoredReason(entry.reasonCode, entry.facts)
  }));
  for (const opportunity of signals.opportunities) {
    const idea = ideaByTicker.get(opportunity.ticker);
    if (idea && idea.status === "dismissed" && !shouldResurface(idea, opportunity)) {
      unscored.push({ ticker: opportunity.ticker, reasonCode: "dismissed", reason: unscoredReason("dismissed") });
      continue;
    }
    opportunities.push(decorateOpportunity(opportunity));
  }

  return {
    enabled: settings.enabled === true,
    settings,
    providerHealth: market.providerHealth ||
      { provider: "yahoo", ok: true, cooldownUntil: null, lastError: null, lastOkAt: null },
    lastRefreshAt: market.lastRefreshAt ?? null,
    lastRefresh: Array.isArray(market.refreshLog) && market.refreshLog.length ? market.refreshLog[0] : null,
    benchmarks,
    instruments: decoratedInstruments,
    opportunities,
    contrarian: signals.contrarian.map(decorateOpportunity),
    unscored,
    ideas,
    suggestions: suggestCandidates(articles, market, { nowIso }),
    newNames: detectNewNames(articles, market, { nowIso }),
    mappings: market.mappings && typeof market.mappings === "object" ? market.mappings : {},
    signalReview: reviewSignalLog(Array.isArray(market.signalLog) ? market.signalLog : [], prices, nowIso).slice(0, 20),
    narratives: market.narratives && typeof market.narratives === "object" ? market.narratives : {},
    disclaimer: MARKET_DISCLAIMER
  };
}

export function decorateState(store, meta = {}) {
  // meta.marketCache is a caller-owned { rev, value } object (one per createApp instance).
  // store.rev bumps on every mutation, so a matching rev is proof the cached market payload
  // is current; marketRefreshing is attached fresh below because it changes without a rev bump.
  const storeRev = Number.isInteger(store.rev) ? store.rev : -1;
  const cache = meta.marketCache && typeof meta.marketCache === "object" ? meta.marketCache : null;
  let marketPayload;
  if (cache && cache.value && cache.rev === storeRev) {
    marketPayload = cache.value;
  } else {
    marketPayload = computeMarketPayload(store, new Date().toISOString());
    if (cache) {
      cache.rev = storeRev;
      cache.value = marketPayload;
    }
  }

  const articles = Array.isArray(store.articles) ? store.articles : [];
  const sources = Array.isArray(store.sources) ? store.sources : [];
  const watchlists = Array.isArray(store.watchlists) ? store.watchlists : [];
  const collections = Array.isArray(store.collections) ? store.collections : [];
  const categoryConfig = Array.isArray(store.categories) ? store.categories : [];
  const categoryNames = categoryConfig.map((category) => category.name);

  const months = [...new Set(articles.map((article) => article.monthKey))]
    .filter(Boolean)
    .sort()
    .reverse();

  const totalsByCategory = Object.fromEntries(categoryNames.map((name) => [name, 0]));
  const sourceTotals = {};
  const sentimentTotals = { positive: 0, neutral: 0, watch: 0 };
  const clusterIds = new Set();
  let latestArticleAt = null;
  let latestArticleTime = -Infinity;
  let unreadCount = 0;
  let starredCount = 0;

  for (const article of articles) {
    totalsByCategory[article.category] = (totalsByCategory[article.category] || 0) + 1;
    sourceTotals[article.sourceName] = (sourceTotals[article.sourceName] || 0) + 1;
    if (sentimentTotals[article.sentiment] !== undefined) {
      sentimentTotals[article.sentiment] += 1;
    } else {
      sentimentTotals.neutral += 1;
    }
    if (article.clusterId) {
      clusterIds.add(article.clusterId);
    }
    if (!article.read) {
      unreadCount += 1;
    }
    if (article.starred) {
      starredCount += 1;
    }
    const time = Date.parse(article.publishedAt);
    if (Number.isFinite(time) && time > latestArticleTime) {
      latestArticleTime = time;
      latestArticleAt = article.publishedAt;
    }
  }

  return {
    version: store.version,
    lastCollectedAt: store.lastCollectedAt ?? null,
    brief: store.brief ?? null,
    sources: sources.map((source) => ({ ...source, healthSummary: summarizeHealth(source) })),
    articles,
    watchlists,
    collections,
    config: {
      settings: maskSettings(store.settings),
      categories: categoryConfig,
      sentiment: store.sentiment || { positive: [], negative: [] }
    },
    categories: categoryNames,
    months,
    analytics: {
      totalArticles: articles.length,
      totalSources: sources.length,
      totalsByCategory,
      sourceTotals,
      sentimentTotals,
      latestArticleAt,
      unreadCount,
      starredCount,
      clusterCount: clusterIds.size
    },
    trends: computeTrends(articles, categoryNames),
    watchlistMatches: matchWatchlists(watchlists, articles),
    market: { ...marketPayload, marketRefreshing: meta.marketRefreshing === true }
  };
}
