import test from "node:test";
import assert from "node:assert/strict";
import {
  detectNewNames,
  normalizeName,
  resolveEntity,
  revalidationQueue,
  suggestCandidates
} from "../lib/market/mapping.mjs";
import { SEED_MAP } from "../lib/market/seedMap.mjs";
import { DEFAULT_SETTINGS } from "../lib/config.mjs";

const NOW = "2026-07-05T10:00:00.000Z";
const DAY_MS = 86400000;
const isoDaysAgo = (days) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

test("normalizeName folds umlauts, strips legal suffixes, is THE cache key", () => {
  assert.equal(normalizeName("Deutsche Bank AG"), "deutsche bank");
  assert.equal(normalizeName("DEUTSCHE BANK AKTIENGESELLSCHAFT"), "deutsche bank");
  assert.equal(normalizeName("  deutsche   bank  "), "deutsche bank");
  assert.equal(normalizeName("Süss MicroTec SE"), "suess microtec");
  assert.equal(normalizeName("Müller & Co. KGaA"), "mueller");
  assert.equal(normalizeName("Infineon Technologies AG"), "infineon technologies");
  assert.equal(normalizeName("Siemens"), "siemens", "single legal-looking word is kept");
  assert.equal(normalizeName(""), "");
});

test("seed map is well-formed: privates carry notes, subsidiaries carry parents", () => {
  assert.ok(Object.keys(SEED_MAP).length >= 80, "substantial seed coverage");
  for (const [key, entry] of Object.entries(SEED_MAP)) {
    assert.ok(entry.displayName, `${key} has displayName`);
    assert.ok(["public", "private", "subsidiary"].includes(entry.status), `${key} status valid`);
    if (entry.status === "private") {
      assert.equal(entry.ticker, null, `${key} private => no ticker`);
      assert.ok(entry.note, `${key} private => German note`);
      assert.ok(Array.isArray(entry.relatedTickers), `${key} private => relatedTickers array`);
    }
    if (entry.status === "subsidiary") {
      assert.ok(entry.parent && entry.ticker, `${key} subsidiary => parent + parent ticker`);
    }
  }
  assert.ok(SEED_MAP["openai"].relatedTickers.includes("MSFT"));
  assert.match(SEED_MAP["merck kgaa"].note, /Merck & Co/, "the Merck trap is documented in data");
});

function marketState(overrides = {}) {
  return {
    instruments: [{ ticker: "IFX.DE", aliases: ["infineon"], paused: false, staleSymbol: false, validatedAt: NOW }],
    mappings: {},
    ignoredEntities: [],
    ...overrides
  };
}

function orgArticle(id, daysAgo, orgs, { aiEnriched = false, title = `Story ${id}` } = {}) {
  return {
    id, title, publishedAt: isoDaysAgo(daysAgo), aiEnriched,
    entities: { orgs, people: [], places: [] }
  };
}

test("suggestCandidates ranks uncovered entities, weighting AI-enriched double", () => {
  const articles = [
    orgArticle("a1", 2, ["Aleph Alpha"], { aiEnriched: true }),
    orgArticle("a2", 5, ["Aleph Alpha"]),
    orgArticle("a3", 10, ["Aleph Alpha GmbH"]),
    orgArticle("a4", 3, ["Infineon Technologies"]),          // covered by instrument alias
    orgArticle("a5", 4, ["Boring GmbH"]),                    // only 1 mention -> below threshold
    orgArticle("a6", 40, ["Aleph Alpha"])                    // outside 30d window
  ];
  const suggestions = suggestCandidates(articles, marketState(), { nowIso: NOW });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].name, "aleph alpha");
  assert.equal(suggestions[0].mentions, 4, "2 (ai) + 1 + 1, umlaut/suffix variants merged");
  assert.ok(suggestions[0].sampleTitles.length >= 1);

  const ignored = suggestCandidates(articles, marketState({ ignoredEntities: ["aleph alpha"] }), { nowIso: NOW });
  assert.equal(ignored.length, 0, "ignored entities never resurface");

  const mapped = suggestCandidates(articles, marketState({ mappings: { "aleph alpha": { status: "private" } } }), { nowIso: NOW });
  assert.equal(mapped.length, 0, "mapped entities leave the queue");
});

test("detectNewNames surfaces first-ever mentions within the window", () => {
  const articles = [
    orgArticle("n1", 3, ["Black Forest Labs"]),
    orgArticle("n2", 5, ["Black Forest Labs"]),
    orgArticle("o1", 2, ["OpenAI"]),
    orgArticle("o2", 60, ["OpenAI"]),               // first seen 60d ago -> not new
    orgArticle("s1", 1, ["Solo Corp"])              // 1 mention -> below threshold
  ];
  const fresh = detectNewNames(articles, marketState(), { nowIso: NOW });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].name, "black forest labs");
  assert.equal(fresh[0].mentions, 2);
  assert.equal(fresh[0].mappingStatus, "unresolved");
});

test("resolveEntity: seed hit + top-3 probe cap + probe-failed candidates dropped", async () => {
  const searchBody = JSON.stringify({
    quotes: [
      { symbol: "MRK", exchange: "NYQ", exchDisp: "NYSE", longname: "Merck & Co., Inc.", quoteType: "EQUITY" },
      { symbol: "MRK.DE", exchange: "GER", exchDisp: "XETRA", longname: "MERCK Kommanditgesellschaft auf Aktien", quoteType: "EQUITY" },
      { symbol: "DEAD.X", exchange: "XXX", exchDisp: "Nowhere", longname: "Merck Ghost", quoteType: "EQUITY" },
      { symbol: "MRK4.F", exchange: "FRA", exchDisp: "Frankfurt", longname: "Merck KGaA", quoteType: "EQUITY" },
      { symbol: "MRKOPT", exchange: "FRA", quoteType: "OPTION" }
    ]
  });
  const probes = [];
  const fetchImpl = async (url) => {
    if (url.includes("/v1/finance/search")) {
      return { ok: true, status: 200, headers: new Headers(), text: searchBody, finalUrl: url };
    }
    const symbol = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
    probes.push(symbol);
    if (symbol === "DEAD.X") {
      return { ok: false, status: 404, headers: new Headers(),
        text: JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }), finalUrl: url };
    }
    return { ok: true, status: 200, headers: new Headers(), finalUrl: url,
      text: JSON.stringify({ chart: { result: [{ meta: { symbol, currency: "EUR", fullExchangeName: "X", longName: `${symbol} AG`, regularMarketPrice: 10, regularMarketTime: 1, gmtoffset: 0 }, timestamp: [], indicators: { quote: [{}] } }], error: null } }) };
  };

  const result = await resolveEntity("Merck KGaA", structuredClone(DEFAULT_SETTINGS), { fetchImpl, throttleMs: 0 });
  assert.equal(result.seed.ticker, "MRK.DE", "seed knows the Darmstadt Merck");
  assert.deepEqual(probes, ["MRK.DE", "MRK", "DEAD.X"],
    "XETRA lifted to the front (stable sort), exactly top-3 probed");
  const probed = result.candidates.filter((candidate) => candidate.probed);
  assert.deepEqual(probed.map((candidate) => candidate.ticker), ["MRK.DE", "MRK"],
    "probe-404 candidate dropped; ambiguity (two Mercks) preserved for the user");
  const unprobed = result.candidates.filter((candidate) => !candidate.probed);
  assert.deepEqual(unprobed.map((candidate) => candidate.ticker), ["MRK4.F"], "tail offered unvalidated");
});

test("resolveEntity survives an unreachable search (seed still answers)", async () => {
  const result = await resolveEntity("OpenAI", structuredClone(DEFAULT_SETTINGS), {
    fetchImpl: async () => { throw new Error("offline"); },
    throttleMs: 0
  });
  assert.equal(result.seed.status, "private");
  assert.deepEqual(result.candidates, []);
});

test("revalidationQueue: 90-day-old and never-validated records, oldest first", () => {
  const market = {
    instruments: [
      { ticker: "OLD.DE", paused: false, staleSymbol: false, validatedAt: isoDaysAgo(120) },
      { ticker: "NEW.DE", paused: false, staleSymbol: false, validatedAt: isoDaysAgo(5) },
      { ticker: "NEVER.DE", paused: false, staleSymbol: false, validatedAt: null },
      { ticker: "PAUSED.DE", paused: true, staleSymbol: false, validatedAt: isoDaysAgo(400) }
    ],
    mappings: {
      "alte firma": { ticker: "ALT.DE", status: "public", validatedAt: isoDaysAgo(200) },
      "privat": { ticker: null, status: "private", validatedAt: null },
      "kaputt": { ticker: "KAP.DE", status: "unresolved", validatedAt: isoDaysAgo(300) }
    }
  };
  const queue = revalidationQueue(market, NOW);
  assert.deepEqual(queue.map((entry) => entry.key), ["NEVER.DE", "alte firma", "OLD.DE"],
    "never-validated first, then oldest; paused/private/unresolved excluded");
});
