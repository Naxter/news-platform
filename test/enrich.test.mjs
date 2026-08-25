import test from "node:test";
import assert from "node:assert/strict";

import { containsWord, countWordHits, stripBoilerplate } from "../lib/text.mjs";
import {
  categorize,
  scoreSentiment,
  extractEntities,
  extractKeywords,
  enrichArticle
} from "../lib/enrich/heuristics.mjs";
import { mergeArticles } from "../lib/articles.mjs";

const CATEGORIES = [
  { name: "Technology", keywords: ["ai", "chip", "software"] },
  { name: "Business", keywords: ["market", "earnings"] },
  { name: "World", keywords: ["global", "international"] }
];

const SENTIMENT = {
  positive: ["gain", "boost", "win"],
  negative: ["risk", "crisis", "attack"]
};

function makeArticle(overrides = {}) {
  return {
    id: "art-default",
    title: "Default title",
    url: "",
    publishedAt: "2026-06-01T00:00:00.000Z",
    read: false,
    starred: false,
    ...overrides
  };
}

test("containsWord matches whole words only", () => {
  assert.equal(containsWord("officials said today", "ai"), false);
  assert.equal(containsWord("AI chips", "ai"), true);
  assert.equal(containsWord("this winter", "win"), false);
  assert.equal(containsWord("a clear win for the team", "win"), true);
  assert.equal(containsWord("rain is expected", "ai"), false);
  assert.equal(containsWord("tensions in the Middle East rose", "middle east"), true);
  assert.equal(containsWord("ai-powered tools", "ai"), true);
  assert.equal(containsWord("", "ai"), false);
  assert.equal(containsWord("anything", ""), false);
});

test("countWordHits counts each listed word at most once", () => {
  assert.equal(countWordHits("ai ai ai and chips everywhere", ["ai", "chips", "cloud"]), 2);
  assert.equal(countWordHits("officials said it will rain", ["ai", "win"]), 0);
  assert.equal(countWordHits("", ["ai"]), 0);
});

test("categorize scores with word boundaries and picks the best category", () => {
  assert.equal(categorize("New AI chip line announced by software vendors", CATEGORIES), "Technology");
  assert.equal(categorize("Earnings beat as the market rallies", CATEGORIES), "Business");
});

test("categorize does not substring-match: legacy bug stays fixed", () => {
  // "said" contains "ai" and would have matched with the legacy substring logic.
  assert.equal(categorize("Officials said today it will rain", CATEGORIES), "World");
});

test("categorize falls back to World when present, else first category", () => {
  assert.equal(categorize("nothing relevant here at all", CATEGORIES), "World");
  const noWorld = CATEGORIES.slice(0, 2);
  assert.equal(categorize("nothing relevant here at all", noWorld), "Technology");
});

test("categorize resolves ties to the first category in the list", () => {
  // Technology ("chip") and Business ("market") both score 1.
  assert.equal(categorize("market conditions for chip makers", CATEGORIES), "Technology");
});

test("scoreSentiment uses word boundaries", () => {
  assert.equal(scoreSentiment("a major boost for the sector", SENTIMENT), "positive");
  assert.equal(scoreSentiment("crisis deepens amid new risk", SENTIMENT), "watch");
  assert.equal(scoreSentiment("a quiet, uneventful day", SENTIMENT), "neutral");
  // "brisk" contains "risk"; "winter" contains "win" — neither should count.
  assert.equal(scoreSentiment("brisk trading this winter", SENTIMENT), "neutral");
});

test("mergeArticles: existing wins on url conflict", () => {
  const existing = [
    makeArticle({
      id: "a1",
      url: "https://example.com/one",
      publishedAt: "2026-06-01T00:00:00.000Z",
      title: "Old title",
      read: true,
      starred: true
    }),
    makeArticle({ id: "a2", url: "", publishedAt: "2026-06-02T00:00:00.000Z" })
  ];
  const incoming = [
    makeArticle({
      id: "dup-by-url",
      url: "HTTPS://EXAMPLE.COM/ONE",
      publishedAt: "2026-06-30T00:00:00.000Z",
      title: "Re-dated duplicate"
    }),
    makeArticle({ id: "a3", url: "https://example.com/three", publishedAt: "2026-06-15T00:00:00.000Z" })
  ];
  const { articles, added } = mergeArticles(existing, incoming, 100);
  assert.equal(added, 1);
  assert.equal(articles.length, 3);
  const kept = articles.find((article) => article.id === "a1");
  assert.ok(kept, "existing article kept");
  assert.equal(kept.title, "Old title");
  assert.equal(kept.publishedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(kept.read, true);
  assert.equal(kept.starred, true);
  assert.ok(!articles.some((article) => article.id === "dup-by-url"));
  assert.deepEqual(articles.map((article) => article.id), ["a3", "a2", "a1"]);
});

test("mergeArticles: dedupes urlless articles by id and counts added", () => {
  const existing = [makeArticle({ id: "same-id", url: "" })];
  const incoming = [
    makeArticle({ id: "same-id", url: "", title: "Duplicate by id" }),
    makeArticle({ id: "fresh-id", url: "", publishedAt: "2026-06-20T00:00:00.000Z" })
  ];
  const { articles, added } = mergeArticles(existing, incoming, 100);
  assert.equal(added, 1);
  assert.equal(articles.length, 2);
  assert.equal(articles.find((article) => article.id === "same-id").title, "Default title");
});

test("mergeArticles enforces the cap, newest first", () => {
  const existing = [
    makeArticle({ id: "e1", publishedAt: "2026-06-01T00:00:00.000Z" }),
    makeArticle({ id: "e2", publishedAt: "2026-06-05T00:00:00.000Z" })
  ];
  const incoming = [
    makeArticle({ id: "n1", publishedAt: "2026-06-10T00:00:00.000Z" }),
    makeArticle({ id: "n2", publishedAt: "2026-05-01T00:00:00.000Z" })
  ];
  const { articles, added } = mergeArticles(existing, incoming, 2);
  assert.equal(added, 2);
  assert.equal(articles.length, 2);
  assert.deepEqual(articles.map((article) => article.id), ["n1", "e2"]);
});

test("enrichArticle strips javascript: urls to empty string", () => {
  const source = { id: "src-1", name: "Test Source", type: "manual" };
  const article = enrichArticle({
    title: "Test story about software",
    url: "javascript:alert(1)",
    publishedAt: null,
    body: "A body long enough to summarize something meaningful about software markets today."
  }, source, { categories: CATEGORIES, sentiment: SENTIMENT });
  assert.equal(article.url, "");
  assert.equal(article.sourceId, "src-1");
  assert.equal(article.sourceName, "Test Source");
  assert.equal(article.read, false);
  assert.equal(article.starred, false);
  assert.equal(article.clusterId, null);
  assert.equal(article.aiEnriched, false);
  assert.equal(article.fullTextFetched, false);
  assert.ok(article.readingMinutes >= 1);
  assert.match(article.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(article.monthKey, article.publishedAt.slice(0, 7));
  assert.deepEqual(Object.keys(article.entities).sort(), ["orgs", "people", "places"]);
});

test("enrichArticle keeps http and manual urls", () => {
  const source = { id: "src-1", name: "Test Source", type: "manual" };
  const config = { categories: CATEGORIES, sentiment: SENTIMENT };
  const httpArticle = enrichArticle({
    title: "Http story",
    url: "https://example.com/story",
    publishedAt: "2026-06-15T12:00:00.000Z",
    body: "Body text for the http story."
  }, source, config);
  assert.equal(httpArticle.url, "https://example.com/story");
  assert.equal(httpArticle.publishedAt, "2026-06-15T12:00:00.000Z");
  assert.equal(httpArticle.monthKey, "2026-06");
  const manualArticle = enrichArticle({
    title: "Manual story",
    url: "manual://demo/1",
    publishedAt: null,
    body: "Body text for the manual story."
  }, source, config);
  assert.equal(manualArticle.url, "manual://demo/1");
});

test("stripBoilerplate removes a leading feed breadcrumb but keeps normal prose", () => {
  assert.equal(
    stripBoilerplate("GPT-Images-2.0 Kurzfassung ▾ Quellen ▾ Das britische AI Safety Institute beweist etwas Neues."),
    "Das britische AI Safety Institute beweist etwas Neues."
  );
  const plain = "Apple and Google announced a partnership on device security today.";
  assert.equal(stripBoilerplate(plain), plain, "prose without nav separators is untouched");
});

test("extractKeywords keeps accented words whole and drops stop words", () => {
  const keywords = extractKeywords(
    "Die Fähigkeiten der KI-Agenten überraschen Millionen Nutzer weil sie besser sind.",
    new Set(["die", "der", "weil", "sind"])
  );
  assert.ok(keywords.includes("fähigkeiten"), `expected whole word, got ${JSON.stringify(keywords)}`);
  assert.ok(!keywords.includes("higkeiten"), "must not split accented words into fragments");
  assert.ok(!keywords.includes("die") && !keywords.includes("weil"), "stop words dropped");
});

test("enrichArticle clamps far-future publish dates to now", () => {
  const source = { id: "src-1", name: "Test Source", type: "rss" };
  const config = { categories: CATEGORIES, sentiment: SENTIMENT };
  const article = enrichArticle({
    title: "Future dated story",
    url: "https://example.com/future",
    publishedAt: "2099-01-01T00:00:00.000Z",
    body: "A feed emitted the wrong year."
  }, source, config);
  assert.ok(new Date(article.publishedAt).getTime() <= Date.now() + 60_000,
    `publishedAt should be clamped, got ${article.publishedAt}`);
});

test("extractEntities finds suffix orgs and known places", () => {
  const entities = extractEntities("Regulators said Acme Corp will expand operations in Germany next year.");
  assert.ok(entities.orgs.includes("Acme Corp"), `orgs: ${JSON.stringify(entities.orgs)}`);
  assert.ok(entities.places.includes("Germany"), `places: ${JSON.stringify(entities.places)}`);
});

test("extractEntities finds acronyms, people, and skips sentence-initial common words", () => {
  const entities = extractEntities("Analysts said Maria Lopez will brief the WHO about hospital capacity. Hospitals in several cities are stretched.");
  assert.ok(entities.people.includes("Maria Lopez"), `people: ${JSON.stringify(entities.people)}`);
  assert.ok(entities.orgs.includes("WHO"), `orgs: ${JSON.stringify(entities.orgs)}`);
  assert.ok(!entities.orgs.includes("Analysts"));
  assert.ok(!entities.orgs.includes("Hospitals"));
  assert.ok(!entities.people.includes("Analysts"));
});
