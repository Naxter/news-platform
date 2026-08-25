import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_MAPPING_CONFIDENCE_CAP,
  aiOpportunityNarrative,
  aiResolveEntities,
  containsRecommendationVocabulary,
  narrativeHash,
  narrativeViolates
} from "../lib/market/ai.mjs";

const SETTINGS = { ai: { enabled: true, apiKey: "sk-test", model: "claude-opus-4-8" } };

function aiResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(payload) }]
    })
  };
}

test("recommendation guard is pattern-based: ordinary German 'halten' passes", () => {
  // False positives that a bare word list would discard (wasting paid Opus output):
  assert.equal(containsRecommendationVocabulary("Analysten halten das für plausibel"), false);
  assert.equal(containsRecommendationVocabulary("Investoren halten sich zurück"), false);
  assert.equal(containsRecommendationVocabulary("Der Konzern will den Marktanteil halten"), false);
  assert.equal(containsRecommendationVocabulary("Die Kaufkraft sinkt"), false);

  // True positives — recommendation language is a hard discard:
  assert.equal(containsRecommendationVocabulary("Klare Kaufempfehlung für die Aktie"), true);
  assert.equal(containsRecommendationVocabulary("Analysten raten zum Kauf"), true);
  assert.equal(containsRecommendationVocabulary("Kaufen Sie jetzt, bevor es zu spät ist"), true);
  assert.equal(containsRecommendationVocabulary("Jetzt einsteigen!"), true);
  assert.equal(containsRecommendationVocabulary("Rating: strong buy"), true);
  assert.equal(containsRecommendationVocabulary("We rate this stock a hold"), true);

  assert.equal(narrativeViolates({
    headline: "Solide Faktenlage", whyInteresting: "Neutraler Text",
    whatToVerify: ["Nächster Berichtstermin"], risks: ["Klare Verkaufsempfehlung der Bank XY"]
  }), true, "guard scans every returned field");
});

test("aiResolveEntities sends the house request shape and caps confidence", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return aiResponse({
      items: [{
        entity: "Aleph Alpha", isPublic: false, ticker: null, exchange: null,
        parentCompany: null, relatedTickers: ["SAP.DE", "NVDA", "MSFT", "GOOGL"],
        note: "Heidelberger KI-Firma", confidence: 0.99
      }]
    });
  };

  const proposals = await aiResolveEntities(
    [{ name: "aleph alpha", sampleTitles: ["Aleph Alpha stellt neues Modell vor"] }],
    SETTINGS, fetchImpl);

  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.options.headers["x-api-key"], "sk-test");
  assert.equal(captured.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(captured.body.model, "claude-opus-4-8");
  assert.equal(captured.body.temperature, undefined, "no sampling params (Opus 4.8 rejects them)");
  assert.equal(captured.body.top_p, undefined);
  assert.equal(captured.body.output_config.format.type, "json_schema");
  assert.match(captured.body.messages[0].content, /NEVER invent tickers/);

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].confidence, AI_MAPPING_CONFIDENCE_CAP,
    "0.99 self-confidence is capped — AI mappings must land in the review queue");
  assert.equal(proposals[0].relatedTickers.length, 3, "relatedTickers capped at 3");
});

test("aiResolveEntities: refusal and missing key throw; empty input short-circuits", async () => {
  assert.deepEqual(await aiResolveEntities([], SETTINGS, async () => { throw new Error("must not fetch"); }), []);
  await assert.rejects(
    () => aiResolveEntities([{ name: "x" }], { ai: {} }, async () => aiResponse({ items: [] })),
    /No API key/);
  await assert.rejects(
    () => aiResolveEntities([{ name: "x" }], SETTINGS,
      async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) })),
    /AI refused/);
});

test("aiOpportunityNarrative grounds on evidence and bans recommendations in the prompt", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return aiResponse({
      headline: "News coverage is intensifying",
      whyInteresting: "Multiple independent sources are reporting.",
      whatToVerify: ["Check the Q3 earnings date"],
      risks: ["Single source dominates"],
      confidence: "medium"
    });
  };
  const opportunity = {
    ticker: "IFX.DE", name: "Infineon", score: 41, quadrant: "possibly-early",
    components: [{ id: "nvs", value: 0.37, explain: "9 stories" }], articleIds: []
  };
  const narrative = await aiOpportunityNarrative(opportunity, [
    { title: "Infineon reports", summary: "…", sentiment: "positive", publishedAt: "2026-07-01", sourceName: "A" }
  ], SETTINGS, fetchImpl);

  assert.equal(narrative.confidence, "medium");
  assert.match(captured.messages[0].content, /NO buy, sell, or hold recommendations/);
  assert.match(captured.messages[0].content, /EXCLUSIVELY/);
  assert.equal(captured.max_tokens, 2000);
});

test("narrativeHash is stable and changes on material change only", () => {
  const opportunity = {
    ticker: "IFX.DE",
    components: [{ id: "nvs", value: 0.37 }, { id: "msc", value: 0.82 }],
    articleIds: ["b", "a"]
  };
  const hash = narrativeHash(opportunity);
  assert.equal(narrativeHash({ ...opportunity, articleIds: ["a", "b"] }), hash,
    "article order does not matter");
  assert.notEqual(narrativeHash({ ...opportunity, components: [{ id: "nvs", value: 0.38 }] }), hash,
    "component drift regenerates");
  assert.notEqual(narrativeHash({ ...opportunity, articleIds: ["a", "c"] }), hash,
    "new evidence regenerates");
});
