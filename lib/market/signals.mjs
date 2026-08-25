import { isSeriesStale } from "./prices.mjs";
import { matchArticlesToInstruments } from "./instruments.mjs";

// Pure math, no prose: components carry numeric `facts`; German sentences live in format.mjs.
// Everything here is deterministic under an injected nowIso — no Date.now(), no network.

export const SIGNAL_WEIGHTS = { nvs: 0.30, msc: 0.20, npd: 0.35, prc: 0.15 };

const DAY_MS = 86400000;
const HOT_DAYS = 7;
const BASE_WINDOW_DAYS = 90;
const MIN_ARTICLES_30D = 3;
const MIN_ARTICLES_RETAINED = 5;
const MIN_BASE_DAYS = 14;
const MIN_PRICE_BARS = 60;
const BACKFILL_GRACE_MS = 10 * 60 * 1000;
const RISK_MULTIPLIER = 0.4;
const TOP_OPPORTUNITIES = 15;
const TOP_CONTRARIAN = 5;

export function trailingReturn(closes, bars) {
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

export function dailyVolatility(closes, bars) {
  if (!Array.isArray(closes) || closes.length < bars + 1) {
    return null;
  }
  const returns = [];
  for (let i = closes.length - bars; i < closes.length; i += 1) {
    const prior = closes[i - 1];
    if (Number.isFinite(prior) && prior !== 0 && Number.isFinite(closes[i])) {
      returns.push(closes[i] / prior - 1);
    }
  }
  if (returns.length < 2) {
    return null;
  }
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// Component value transforms — exported so the golden fixture can assert the exact chain.
export function nvsValue(clusters7, expected7) {
  const ratio = clusters7 / Math.max(1e-9, expected7);
  return ratio <= 1 ? 0 : Math.min(1, Math.log2(ratio) / 3);
}

export function mscValue(distinctSources, clusteredShare) {
  return Math.min(1, (distinctSources - 1) / 3) * 0.6 + clusteredShare * 0.4;
}

export function npdValue(nvs, posShare, moveT) {
  return nvs * posShare * (1 - Math.min(1, Math.abs(moveT)));
}

// Composite from UNROUNDED component values; weights renormalize over non-null components;
// the RSK gate multiplies afterwards. Display rounding happens at the very end.
export function compositeScore(components, riskMultiplier = 1) {
  let weighted = 0;
  let weightSum = 0;
  for (const component of components) {
    if (component.value === null || component.value === undefined) {
      continue;
    }
    weighted += component.value * component.weight;
    weightSum += component.weight;
  }
  if (weightSum === 0) {
    return 0;
  }
  return Math.round((weighted / weightSum) * 100 * riskMultiplier);
}

function storyCount(articleList) {
  const keys = new Set();
  for (const article of articleList) {
    keys.add(article.clusterId || article.id);
  }
  return keys.size;
}

function round2(value) {
  return value === null || value === undefined ? value : Math.round(value * 100) / 100;
}

export function computeSignals({ articles, instruments, prices, sources, settings, nowIso }) {
  const nowMs = Date.parse(nowIso);
  const marketSettings = (settings && settings.market) || {};
  const matches = matchArticlesToInstruments(articles, instruments);
  const articleById = new Map((articles || []).map((article) => [article.id, article]));
  const sourceCreatedAt = new Map((sources || []).map((source) => [source.id, Date.parse(source.createdAt)]));

  // Retention-aware baseline age: the corpus can't witness a baseline older than its
  // oldest retained article (maxArticles pruning shrinks this honestly).
  let oldestMs = Infinity;
  for (const article of articles || []) {
    const time = Date.parse(article.publishedAt);
    if (Number.isFinite(time) && time < oldestMs) {
      oldestMs = time;
    }
  }
  const baseDays = Number.isFinite(oldestMs)
    ? Math.min(83, Math.max(0, (nowMs - oldestMs) / DAY_MS - HOT_DAYS))
    : 0;

  const benchmarkBySymbol = {
    EUR: typeof marketSettings.benchmarkEUR === "string" ? marketSettings.benchmarkEUR : "^GDAXI",
    USD: "^GSPC"
  };

  function benchmarkReturn(currency) {
    const symbol = benchmarkBySymbol[currency];
    if (!symbol) {
      return { symbol: null, ret20d: null };
    }
    const series = prices[symbol];
    if (!series || series.stale === true ||
        isSeriesStale(series.dates[series.dates.length - 1], nowIso)) {
      return { symbol, ret20d: null };
    }
    return { symbol, ret20d: trailingReturn(series.closes, 20) };
  }

  // An article fetched within minutes of its source being added is first-collect backlog,
  // not news happening now — it would fake a volume spike (excluded from HOT, kept in BASE).
  function isBackfill(article) {
    const created = sourceCreatedAt.get(article.sourceId);
    const collected = Date.parse(article.collectedAt);
    return Number.isFinite(created) && Number.isFinite(collected) &&
      collected - created <= BACKFILL_GRACE_MS;
  }

  const opportunities = [];
  const contrarian = [];
  const unscored = [];

  for (const instrument of instruments || []) {
    const push = (reasonCode, facts = {}) =>
      unscored.push({ ticker: instrument.ticker, reasonCode, facts });

    if (instrument.paused) {
      push("paused");
      continue;
    }
    if (instrument.staleSymbol) {
      push("stale-symbol");
      continue;
    }
    if (instrument.confidence < 0.7 && !instrument.confirmed) {
      push("unconfirmed", { confidence: instrument.confidence });
      continue;
    }

    const match = matches.get(instrument.ticker) || { articleIds: [] };
    const matched = match.articleIds
      .map((id) => articleById.get(id))
      .filter(Boolean);
    const within = (article, fromDays, toDays) => {
      const time = Date.parse(article.publishedAt);
      return Number.isFinite(time) &&
        nowMs - time > fromDays * DAY_MS && nowMs - time <= toDays * DAY_MS;
    };
    const last30 = matched.filter((article) => within(article, 0, 30));
    if (last30.length < MIN_ARTICLES_30D || matched.length < MIN_ARTICLES_RETAINED) {
      push("too-few-articles", { count30d: last30.length, min: MIN_ARTICLES_30D });
      continue;
    }
    if (baseDays < MIN_BASE_DAYS) {
      push("baseline-building", { baseDays: Math.floor(baseDays), daysLeft: Math.ceil(MIN_BASE_DAYS - baseDays) });
      continue;
    }
    const series = prices[instrument.ticker];
    if (!series || series.closes.length < MIN_PRICE_BARS + 1) {
      push("price-data", { bars: series ? series.closes.length : 0, min: MIN_PRICE_BARS });
      continue;
    }

    const hot = matched.filter((article) => within(article, 0, HOT_DAYS) && !isBackfill(article));
    const base = matched.filter((article) => within(article, HOT_DAYS, BASE_WINDOW_DAYS));
    const hotClusters = storyCount(hot);
    const hotSources = new Set(hot.map((article) => article.sourceName)).size;
    const clusteredShare = hot.length
      ? hot.filter((article) => article.clusterId).length / hot.length
      : 0;
    const pos = hot.filter((article) => article.sentiment === "positive").length;
    const watch = hot.filter((article) => article.sentiment === "watch").length;
    const neu = hot.length - pos - watch;
    const coverage = hot.length ? (pos + watch) / hot.length : 0;
    const posShare = hot.length ? pos / hot.length : 0;
    const anyAiEnriched = hot.some((article) => article.aiEnriched === true);

    const flags = [];
    const components = [];

    // NVS — news volume spike vs the instrument's own baseline.
    const baseDailyRate = storyCount(base) / Math.max(1, baseDays);
    const expected7 = Math.max(1, baseDailyRate * HOT_DAYS);
    const nvs = nvsValue(hotClusters, expected7);
    components.push({
      id: "nvs", value: nvs, weight: SIGNAL_WEIGHTS.nvs,
      facts: { hotArticles: hot.length, hotClusters, expected7: round2(expected7), baseDays: Math.floor(baseDays) },
      flags: []
    });

    // MSC — multi-source corroboration.
    const msc = hot.length ? mscValue(hotSources, clusteredShare) : 0;
    const mscFlags = hotSources <= 1 && hot.length > 0 ? ["single-source"] : [];
    if (mscFlags.length) {
      flags.push("single-source");
    }
    components.push({
      id: "msc", value: msc, weight: SIGNAL_WEIGHTS.msc,
      facts: { distinctSources: hotSources, clusteredSharePct: Math.round(clusteredShare * 100) },
      flags: mscFlags
    });

    // NPD — the flagship: heavy news flow the (benchmark-relative) price hasn't reacted to.
    const ret20d = trailingReturn(series.closes, 20);
    const vol60 = dailyVolatility(series.closes, MIN_PRICE_BARS);
    const isEurOrUsd = instrument.currency === "EUR" || instrument.currency === "USD";
    const benchmark = isEurOrUsd ? benchmarkReturn(instrument.currency) : { symbol: null, ret20d: null };
    const absReturn = benchmark.ret20d === null; // other currency OR benchmark missing/stale
    const npdFlags = [];
    let npd = null;
    let quadrant = null;
    const npdFacts = {
      posSharePct: Math.round(posShare * 100),
      benchmarkSymbol: absReturn ? null : benchmark.symbol,
      absReturn
    };
    if (hot.length > 0 && coverage === 0 && !anyAiEnriched) {
      // The sentiment lexicon saw nothing at all — scoring "neutral news flow" would be a
      // silent zero, not information. Renormalize instead.
      npdFacts.reason = "sentiment-none";
    } else if (ret20d === null || vol60 === null || vol60 === 0) {
      npdFacts.reason = "price-window";
    } else {
      const effectiveRet = absReturn ? ret20d : ret20d - benchmark.ret20d;
      const moveT = effectiveRet / (vol60 * Math.sqrt(20));
      npd = npdValue(nvs, posShare, moveT);
      npdFacts.retPct = round2(effectiveRet * 100);
      npdFacts.moveT = round2(moveT);
      if (absReturn) {
        npdFlags.push("abs-return");
        flags.push("abs-return");
      }
      if (coverage > 0 && coverage < 0.25) {
        npdFlags.push("sentiment-thin");
        flags.push("sentiment-thin");
      }
      const toneUp = pos >= watch;
      const bigMove = Math.abs(moveT) >= 0.5;
      if (toneUp) {
        quadrant = bigMove && moveT > 0 ? "priced-in" : "possibly-early";
      } else {
        quadrant = moveT <= -0.5 ? "punished-contrarian" : "complacency-risk";
      }
    }
    components.push({
      id: "npd", value: npd, weight: SIGNAL_WEIGHTS.npd, facts: npdFacts, flags: npdFlags
    });

    // PRC — 52-week setup, conditional: null unless a setup actually fires (a constant
    // mid-range value would be a noise row in every breakdown).
    const closes = series.closes;
    const window52 = closes.slice(-254);
    const high52 = Math.max(...window52);
    const low52 = Math.min(...window52);
    const last = closes[closes.length - 1];
    let prc = null;
    let prcFacts = {};
    const nearLow = last <= low52 * 1.10;
    if (last >= high52 * 0.95 && posShare > 0.5) {
      prc = 1;
      prcFacts = { setup: "near-high", pctFromHigh: round2((1 - last / high52) * 100) };
    } else if (nearLow) {
      const watchShareRecent = shareWatch(matched.filter((article) => within(article, 0, 30)));
      const watchSharePrior = shareWatch(matched.filter((article) => within(article, 30, 60)));
      if (watchShareRecent !== null && watchSharePrior !== null && watchShareRecent < watchSharePrior) {
        prc = 1;
        prcFacts = { setup: "near-low", pctFromLow: round2((last / low52 - 1) * 100) };
      }
    }
    components.push({ id: "prc", value: prc, weight: SIGNAL_WEIGHTS.prc, facts: prcFacts, flags: [] });

    // RSK — risk concentration is a gate, not an additive component.
    const watchShare30 = last30.length >= 5
      ? last30.filter((article) => article.sentiment === "watch").length / last30.length
      : 0;
    const risky = watchShare30 >= 0.5;
    if (risky) {
      flags.push("risk-concentration");
    }
    if (series.stale === true) {
      flags.push("stale-price");
    }

    const score = compositeScore(components, risky ? RISK_MULTIPLIER : 1);
    const hotIds = hot.map((article) => article.id);
    const opportunity = {
      ticker: instrument.ticker,
      name: instrument.name,
      currency: instrument.currency,
      sizeHint: instrument.sizeHint,
      score,
      quadrant,
      flags,
      components: components.map((component) => ({
        ...component,
        value: round2(component.value),
        contribution: component.value === null ? null : round2(component.value * component.weight)
      })),
      counts: {
        hotArticles: hot.length, hotClusters, hotSources,
        pos, neu, watch,
        baseArticles: base.length, baseDays: Math.floor(baseDays)
      },
      price: {
        last: series.quote ? series.quote.price : last,
        asOf: series.quote ? series.quote.marketTime : series.updatedAt,
        ret20d,
        benchmarkRet20d: benchmark.ret20d,
        benchmarkSymbol: benchmark.symbol,
        high52, low52
      },
      articleIds: hotIds.slice(0, 12),
      evidenceArticleIds: evidenceArticleIds(hot)
    };

    if (risky && nearLow) {
      opportunity.flags = [...opportunity.flags, "contrarian"];
      contrarian.push(opportunity);
    } else {
      opportunities.push(opportunity);
    }
  }

  const byScore = (a, b) => b.score - a.score ||
    (componentValue(b, "msc") ?? 0) - (componentValue(a, "msc") ?? 0);
  opportunities.sort(byScore);
  contrarian.sort(byScore);

  return {
    computedAt: nowIso,
    opportunities: opportunities.slice(0, TOP_OPPORTUNITIES),
    contrarian: contrarian.slice(0, TOP_CONTRARIAN),
    unscored
  };
}

function shareWatch(articleList) {
  if (articleList.length < 3) {
    return null;
  }
  return articleList.filter((article) => article.sentiment === "watch").length / articleList.length;
}

function componentValue(opportunity, id) {
  const component = opportunity.components.find((entry) => entry.id === id);
  return component ? component.value : null;
}

// Stable evidence: article ids are content-hashes and survive recluster/prune; clusterIds
// churn (they key on the earliest member), which would make dismissals resurface on noise.
export function evidenceArticleIds(hotArticles) {
  return [...new Set(hotArticles.map((article) => article.id))].slice(0, 20);
}

export function shouldResurface(idea, opportunity) {
  if (!idea || idea.status !== "dismissed" || !opportunity) {
    return false;
  }
  const known = new Set(idea.evidenceArticleIds || []);
  const fresh = (opportunity.evidenceArticleIds || []).filter((id) => !known.has(id)).length;
  return fresh >= 2 && opportunity.score >= (idea.scoreAt || 0) + 10;
}

// Snapshot for the forward-return review. close/barDate are the last COMPLETED bar —
// never the delayed intraday quote — so the +5d/+20d join is bar-against-bar.
export function updateSignalLog(signalLog, opportunities, prices, nowIso) {
  const entries = [];
  for (const opportunity of opportunities) {
    const series = prices[opportunity.ticker];
    if (!series || !series.dates.length) {
      continue;
    }
    entries.push({
      ticker: opportunity.ticker,
      score: opportunity.score,
      quadrant: opportunity.quadrant,
      flags: opportunity.flags,
      barDate: series.dates[series.dates.length - 1],
      close: series.closes[series.closes.length - 1],
      c: Object.fromEntries(opportunity.components.map((component) => [component.id, component.value]))
    });
  }
  const day = String(nowIso).slice(0, 10);
  const kept = (signalLog || []).filter((entry) => String(entry.at).slice(0, 10) !== day);
  const next = entries.length ? [{ at: nowIso, entries }, ...kept] : kept;
  return next.slice(0, 120);
}

export function reviewSignalLog(signalLog, prices, nowIso) {
  void nowIso;
  return (signalLog || []).map((logEntry) => ({
    at: logEntry.at,
    entries: (logEntry.entries || []).map((entry) => {
      const series = prices[entry.ticker];
      const index = series ? series.dates.indexOf(entry.barDate) : -1;
      const forward = (bars) =>
        index >= 0 && index + bars < (series ? series.closes.length : 0) && entry.close
          ? series.closes[index + bars] / entry.close - 1
          : null;
      return {
        ticker: entry.ticker,
        score: entry.score,
        quadrant: entry.quadrant,
        fwdReturn5d: forward(5),
        fwdReturn20d: forward(20)
      };
    })
  }));
}
