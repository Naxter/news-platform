import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_WEIGHTS,
  compositeScore,
  computeSignals,
  dailyVolatility,
  evidenceArticleIds,
  mscValue,
  npdValue,
  nvsValue,
  reviewSignalLog,
  shouldResurface,
  trailingReturn,
  updateSignalLog
} from "../lib/market/signals.mjs";
import { explainComponent, flagLabel, quadrantLabel, unscoredReason } from "../lib/market/format.mjs";
import { DEFAULT_SETTINGS } from "../lib/config.mjs";

const NOW = "2026-07-05T10:00:00.000Z";
const DAY_MS = 86400000;

function isoDaysAgo(days) {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

// --- component transforms + the golden fixture (docs/MARKET-PLAN.md §5.2) ----------------

test("golden fixture: the composite chain lands on 41 (absolute) and 42 (vs. DAX)", () => {
  // IFX.DE — HOT: 9 articles / 6 clusters / 4 sources / 6 pos·2 neu·1 watch; BASE 33/83d;
  // ret20d +1.2%, dailyVol 2.1%, no 52w setup (PRC null).
  const expected7 = Math.max(1, (33 / 83) * 7);
  const nvs = nvsValue(6, expected7);
  const msc = mscValue(4, 5 / 9);
  const posShare = 6 / 9;
  const vol = 0.021 * Math.sqrt(20);

  // Absolute fallback (no benchmark): moveT from the raw +1.2%.
  const npdAbs = npdValue(nvs, posShare, 0.012 / vol);
  const score41 = compositeScore([
    { value: nvs, weight: SIGNAL_WEIGHTS.nvs },
    { value: msc, weight: SIGNAL_WEIGHTS.msc },
    { value: npdAbs, weight: SIGNAL_WEIGHTS.npd },
    { value: null, weight: SIGNAL_WEIGHTS.prc }
  ]);
  assert.equal(score41, 41);

  // Benchmark-relative (DAX +0.9% ⇒ excess +0.3%).
  const npdBench = npdValue(nvs, posShare, 0.003 / vol);
  const score42 = compositeScore([
    { value: nvs, weight: SIGNAL_WEIGHTS.nvs },
    { value: msc, weight: SIGNAL_WEIGHTS.msc },
    { value: npdBench, weight: SIGNAL_WEIGHTS.npd },
    { value: null, weight: SIGNAL_WEIGHTS.prc }
  ]);
  assert.equal(score42, 42);

  // Sanity on the intermediate values the plan documents (rounded for display only).
  assert.equal(Math.round(nvs * 100) / 100, 0.37);
  assert.equal(Math.round(msc * 100) / 100, 0.82);
});

test("component transforms behave at the edges", () => {
  assert.equal(nvsValue(2, 3), 0, "below-baseline volume scores 0, never negative");
  assert.equal(nvsValue(8, 1), 1, "8x ratio saturates at 1");
  assert.equal(mscValue(1, 0), 0, "single source, no clustering");
  assert.equal(mscValue(5, 1), 1, "4+ sources fully corroborated");
  assert.equal(npdValue(0.5, 0.8, 2), 0, "a huge move zeroes the divergence");
  assert.equal(compositeScore([{ value: null, weight: 1 }]), 0, "all-null components score 0");
  assert.equal(compositeScore([{ value: 0.5, weight: 0.3 }, { value: null, weight: 0.7 }]), 50,
    "weights renormalize over non-null components");
  assert.equal(compositeScore([{ value: 1, weight: 1 }], 0.4), 40, "risk gate multiplies");
});

test("trailingReturn and dailyVolatility guard their windows", () => {
  const closes = Array.from({ length: 61 }, (_, i) => 100 + i * 0.1);
  assert.ok(trailingReturn(closes, 20) > 0);
  assert.equal(trailingReturn(closes.slice(0, 10), 20), null);
  assert.ok(dailyVolatility(closes, 60) >= 0);
  assert.equal(dailyVolatility([100, 101], 60), null);
});

// --- computeSignals end-to-end ------------------------------------------------------------

function makeSeries({ bars = 80, lastClose = 100, drift = 0 } = {}) {
  const closes = [];
  let value = lastClose - bars * drift;
  const dates = [];
  for (let i = 0; i < bars; i += 1) {
    value += drift + (i % 2 === 0 ? 0.3 : -0.3);
    closes.push(Math.round(value * 100) / 100);
    dates.push(new Date(Date.parse("2026-07-03T00:00:00Z") - (bars - 1 - i) * DAY_MS).toISOString().slice(0, 10));
  }
  return {
    currency: "EUR",
    quote: { price: closes[closes.length - 1], marketTime: isoDaysAgo(0.1), exchange: "XETRA" },
    dates,
    closes,
    updatedAt: NOW,
    lastFullAt: NOW,
    stale: false
  };
}

function makeArticle({ id, daysAgo, sentiment = "neutral", clusterId = null, sourceName = "Quelle A",
  sourceId = "src-old", title = "Infineon Meldung", aiEnriched = false }) {
  return {
    id,
    title,
    keywords: [],
    entities: { orgs: [], people: [], places: [] },
    publishedAt: isoDaysAgo(daysAgo),
    collectedAt: isoDaysAgo(daysAgo),
    sentiment,
    clusterId,
    sourceId,
    sourceName,
    aiEnriched
  };
}

function baseInput(overrides = {}) {
  const instrument = {
    ticker: "IFX.DE", name: "Infineon", aliases: ["infineon"], exchange: "XETRA", currency: "EUR",
    sizeHint: null, paused: false, source: "user", confidence: 1, confirmed: true,
    addedAt: isoDaysAgo(100), validatedAt: NOW, staleSymbol: false
  };
  // 5 HOT articles across 3 sources with clustering, plus baseline articles spread over 90d,
  // plus an old article anchoring baseDays at ~93 (baseline fully built).
  const articles = [
    makeArticle({ id: "h1", daysAgo: 1, sentiment: "positive", clusterId: "c1", sourceName: "A" }),
    makeArticle({ id: "h2", daysAgo: 2, sentiment: "positive", clusterId: "c1", sourceName: "B" }),
    makeArticle({ id: "h3", daysAgo: 3, sentiment: "positive", sourceName: "C" }),
    makeArticle({ id: "h4", daysAgo: 4, sentiment: "neutral", sourceName: "A" }),
    makeArticle({ id: "h5", daysAgo: 5, sentiment: "watch", sourceName: "B" }),
    makeArticle({ id: "b1", daysAgo: 20 }),
    makeArticle({ id: "b2", daysAgo: 40 }),
    makeArticle({ id: "b3", daysAgo: 60 }),
    makeArticle({ id: "old", daysAgo: 100, title: "Alte Meldung ohne Bezug" })
  ];
  const settings = structuredClone(DEFAULT_SETTINGS);
  const benchmark = makeSeries({ bars: 80, lastClose: 25000, drift: 2 });
  // A mid-series peak keeps the last close well below the 52w high (a flat series would
  // legitimately fire the near-high setup — that is PRC working, not a test target here).
  const instrumentSeries = makeSeries();
  instrumentSeries.closes[40] += 25;
  return {
    articles,
    instruments: [instrument],
    prices: { "IFX.DE": instrumentSeries, "^GDAXI": benchmark, "^GSPC": makeSeries({ bars: 80, lastClose: 7000 }) },
    sources: [{ id: "src-old", createdAt: isoDaysAgo(200) }],
    settings,
    nowIso: NOW,
    ...overrides
  };
}

test("computeSignals scores a healthy instrument with full component breakdown", () => {
  const result = computeSignals(baseInput());
  assert.equal(result.opportunities.length, 1);
  const opp = result.opportunities[0];
  assert.equal(opp.ticker, "IFX.DE");
  assert.ok(opp.score > 0 && opp.score <= 100);
  assert.ok(opp.quadrant, "quadrant emitted");
  const ids = opp.components.map((c) => c.id);
  assert.deepEqual(ids, ["nvs", "msc", "npd", "prc"]);
  const npd = opp.components.find((c) => c.id === "npd");
  assert.notEqual(npd.value, null, "NPD computes with benchmark present");
  assert.equal(npd.facts.benchmarkSymbol, "^GDAXI");
  assert.equal(npd.facts.absReturn, false);
  const prc = opp.components.find((c) => c.id === "prc");
  assert.equal(prc.value, null, "no 52w setup fires in the flat series");
  assert.ok(opp.counts.hotArticles === 5 && opp.counts.hotSources === 3);
  assert.ok(opp.evidenceArticleIds.includes("h1"));
  // Determinism: same input, identical output.
  assert.deepEqual(computeSignals(baseInput()), result);
});

test("guards route instruments into unscored with the right reason codes", () => {
  const paused = baseInput();
  paused.instruments[0].paused = true;
  assert.equal(computeSignals(paused).unscored[0].reasonCode, "paused");

  const unconfirmed = baseInput();
  unconfirmed.instruments[0].confidence = 0.5;
  unconfirmed.instruments[0].confirmed = false;
  assert.equal(computeSignals(unconfirmed).unscored[0].reasonCode, "unconfirmed");

  const staleSym = baseInput();
  staleSym.instruments[0].staleSymbol = true;
  assert.equal(computeSignals(staleSym).unscored[0].reasonCode, "stale-symbol");

  const fewArticles = baseInput();
  fewArticles.articles = fewArticles.articles.slice(0, 2);
  assert.equal(computeSignals(fewArticles).unscored[0].reasonCode, "too-few-articles");

  const youngCorpus = baseInput();
  youngCorpus.articles = youngCorpus.articles
    .filter((a) => Date.parse(NOW) - Date.parse(a.publishedAt) < 10 * DAY_MS)
    .concat([
      makeArticle({ id: "y1", daysAgo: 6 }), makeArticle({ id: "y2", daysAgo: 6.5 }),
      makeArticle({ id: "y3", daysAgo: 8 }), makeArticle({ id: "y4", daysAgo: 9 })
    ]);
  const young = computeSignals(youngCorpus);
  assert.equal(young.unscored[0].reasonCode, "baseline-building");
  assert.ok(young.unscored[0].facts.daysLeft >= 1);

  const noPrices = baseInput();
  noPrices.prices["IFX.DE"].closes = noPrices.prices["IFX.DE"].closes.slice(0, 30);
  noPrices.prices["IFX.DE"].dates = noPrices.prices["IFX.DE"].dates.slice(0, 30);
  assert.equal(computeSignals(noPrices).unscored[0].reasonCode, "price-data");

  const empty = computeSignals({ articles: [], instruments: [], prices: {}, sources: [], settings: DEFAULT_SETTINGS, nowIso: NOW });
  assert.deepEqual(empty.opportunities, []);
});

test("backfill guard: first-collect backlog is excluded from HOT but kept in BASE", () => {
  const input = baseInput();
  // A brand-new source dumps 10 "hot" articles collected within 10 min of source creation.
  input.sources.push({ id: "src-new", createdAt: isoDaysAgo(1) });
  for (let i = 0; i < 10; i += 1) {
    const article = makeArticle({ id: `bf${i}`, daysAgo: 0.5, sourceId: "src-new", sourceName: "Neu" });
    article.collectedAt = isoDaysAgo(1); // == source createdAt -> backfill
    input.articles.push(article);
  }
  const result = computeSignals(input);
  const opp = result.opportunities[0];
  assert.equal(opp.counts.hotArticles, 5, "backlog does not fake a spike");
});

test("sentiment gates: all-neutral HOT nulls NPD; thin coverage flags it", () => {
  const neutral = baseInput();
  for (const article of neutral.articles) {
    article.sentiment = "neutral";
  }
  const result = computeSignals(neutral);
  const npd = result.opportunities[0].components.find((c) => c.id === "npd");
  assert.equal(npd.value, null);
  assert.equal(npd.facts.reason, "sentiment-none");

  // aiEnriched neutral coverage is trusted (the AI actually judged it neutral).
  const aiNeutral = baseInput();
  for (const article of aiNeutral.articles) {
    article.sentiment = "neutral";
    article.aiEnriched = true;
  }
  const aiNpd = computeSignals(aiNeutral).opportunities[0].components.find((c) => c.id === "npd");
  assert.notEqual(aiNpd.value, null);
});

test("currency rule: CHF instruments never compare against ^GSPC (absolute + flag)", () => {
  const chf = baseInput();
  chf.instruments[0].currency = "CHF";
  const opp = computeSignals(chf).opportunities[0];
  const npd = opp.components.find((c) => c.id === "npd");
  assert.equal(npd.facts.absReturn, true);
  assert.equal(npd.facts.benchmarkSymbol, null);
  assert.ok(opp.flags.includes("abs-return"));

  // Stale benchmark series also falls back to absolute.
  const staleBench = baseInput();
  staleBench.prices["^GDAXI"].stale = true;
  const npd2 = computeSignals(staleBench).opportunities[0].components.find((c) => c.id === "npd");
  assert.equal(npd2.facts.absReturn, true);
});

test("risk concentration gates the score and near-low risk goes contrarian", () => {
  const risky = baseInput();
  for (const article of risky.articles.slice(0, 5)) {
    article.sentiment = "watch";
  }
  const result = computeSignals(risky);
  const opp = result.opportunities[0] || result.contrarian[0];
  assert.ok(opp.flags.includes("risk-concentration"));

  // Push the price near its 52w low -> contrarian sub-list.
  const contrarianInput = baseInput();
  for (const article of contrarianInput.articles.slice(0, 5)) {
    article.sentiment = "watch";
  }
  const series = contrarianInput.prices["IFX.DE"];
  series.closes = series.closes.map((close, i) => (i < series.closes.length - 1 ? close + 50 : close));
  const contrarianResult = computeSignals(contrarianInput);
  assert.equal(contrarianResult.opportunities.length, 0);
  assert.equal(contrarianResult.contrarian.length, 1);
  assert.ok(contrarianResult.contrarian[0].flags.includes("contrarian"));
});

test("single-source HOT coverage is labeled, never hidden", () => {
  const single = baseInput();
  for (const article of single.articles) {
    article.sourceName = "A";
  }
  const opp = computeSignals(single).opportunities[0];
  assert.ok(opp.flags.includes("single-source"));
});

// --- ideas: pin/dismiss/resurface ---------------------------------------------------------

test("shouldResurface needs 2 new evidence articles AND +10 score", () => {
  const idea = { status: "dismissed", evidenceArticleIds: ["h1", "h2"], scoreAt: 30 };
  assert.equal(shouldResurface(idea, { evidenceArticleIds: ["h1", "h2", "h3"], score: 45 }), false,
    "one new article is churn, not news");
  assert.equal(shouldResurface(idea, { evidenceArticleIds: ["h3", "h4"], score: 35 }), false,
    "score barely moved");
  assert.equal(shouldResurface(idea, { evidenceArticleIds: ["h1", "h3", "h4"], score: 41 }), true);
  assert.equal(shouldResurface({ ...idea, status: "pinned" }, { evidenceArticleIds: ["h3", "h4"], score: 99 }), false);
  assert.equal(evidenceArticleIds([{ id: "a" }, { id: "a" }, { id: "b" }]).length, 2);
});

// --- signal log + forward returns ----------------------------------------------------------

test("updateSignalLog dedupes same-day (last wins) and stores the completed bar", () => {
  const prices = { "IFX.DE": makeSeries() };
  const lastBar = prices["IFX.DE"].dates[prices["IFX.DE"].dates.length - 1];
  const opp = { ticker: "IFX.DE", score: 41, quadrant: "possibly-early", flags: [], components: [{ id: "nvs", value: 0.37 }] };

  const first = updateSignalLog([], [opp], prices, NOW);
  assert.equal(first.length, 1);
  assert.equal(first[0].entries[0].barDate, lastBar, "completed bar date, not the quote time");
  assert.equal(first[0].entries[0].c.nvs, 0.37);

  const later = updateSignalLog(first, [{ ...opp, score: 44 }], prices, "2026-07-05T18:00:00.000Z");
  assert.equal(later.length, 1, "same calendar day replaced");
  assert.equal(later[0].entries[0].score, 44, "last refresh of the day wins");

  const nextDay = updateSignalLog(later, [opp], prices, "2026-07-06T10:00:00.000Z");
  assert.equal(nextDay.length, 2);

  const capped = updateSignalLog(
    Array.from({ length: 130 }, (_, i) => ({ at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T0${i % 9}:00:00.000Z`, entries: [] })),
    [opp], prices, NOW);
  assert.ok(capped.length <= 120);
});

test("reviewSignalLog joins +5d/+20d bar-against-bar, null while future bars missing", () => {
  const series = makeSeries({ bars: 80 });
  const prices = { "IFX.DE": series };
  const entryBarIndex = 50;
  const log = [{
    at: NOW,
    entries: [{ ticker: "IFX.DE", score: 41, quadrant: "possibly-early", flags: [],
      barDate: series.dates[entryBarIndex], close: series.closes[entryBarIndex], c: {} }]
  }, {
    at: isoDaysAgo(0.5),
    entries: [{ ticker: "IFX.DE", score: 38, quadrant: "possibly-early", flags: [],
      barDate: series.dates[series.dates.length - 1], close: series.closes[series.closes.length - 1], c: {} }]
  }];
  const review = reviewSignalLog(log, prices, NOW);
  const joined = review[0].entries[0];
  assert.equal(joined.fwdReturn5d, series.closes[entryBarIndex + 5] / series.closes[entryBarIndex] - 1);
  assert.equal(joined.fwdReturn20d, series.closes[entryBarIndex + 20] / series.closes[entryBarIndex] - 1);
  assert.equal(review[1].entries[0].fwdReturn5d, null, "no future bars yet");
});

// --- format.mjs (thin snapshot) -------------------------------------------------------------

test("format renders English sentences from facts", () => {
  assert.match(explainComponent({ id: "nvs", value: 0.37, facts: { hotArticles: 9, hotClusters: 6, expected7: 2.78 } }),
    /9 stories \(6 events\)/);
  assert.match(explainComponent({ id: "msc", value: 0.82, facts: { distinctSources: 4, clusteredSharePct: 56 } }),
    /4 independent sources/);
  assert.match(explainComponent({ id: "npd", value: 0.24, facts: { posSharePct: 67, retPct: 0.3, benchmarkSymbol: "^GDAXI", absReturn: false } }),
    /vs\. DAX \/ 20d/);
  assert.match(explainComponent({ id: "npd", value: 0.24, facts: { posSharePct: 67, retPct: 1.2, absReturn: true } }),
    /absolute/);
  assert.match(explainComponent({ id: "prc", value: 1, facts: { setup: "near-high", pctFromHigh: 3.2 } }),
    /52-week high/);
  assert.match(quadrantLabel("possibly-early"), /possibly early/);
  assert.match(unscoredReason("too-few-articles", { count30d: 1, min: 3 }), /only 1 stories/);
  assert.match(unscoredReason("baseline-building", { daysLeft: 9 }), /9 days left/);
  assert.equal(flagLabel("single-source"), "single source");
});
