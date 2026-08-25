import crypto from "node:crypto";

// Clones the lib/enrich/ai.mjs house pattern: raw fetch, output_config json_schema with
// additionalProperties:false, NO sampling params, refusal -> thrown error, failures non-fatal
// at the caller. Both features here return PROPOSALS/TEXT only — tickers are probe-validated
// by the caller (SPEC invariant 3) and output passes the recommendation-vocabulary guard.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-8";
const REQUEST_TIMEOUT_MS = 90000;
const MAX_ENTITIES_PER_BATCH = 20;
export const AI_MAPPING_CONFIDENCE_CAP = 0.75;

const RESOLVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "isPublic", "ticker", "exchange", "parentCompany", "relatedTickers", "note", "confidence"],
        properties: {
          entity: { type: "string" },
          isPublic: { type: "boolean" },
          ticker: { type: ["string", "null"] },
          exchange: { type: ["string", "null"] },
          parentCompany: { type: ["string", "null"] },
          relatedTickers: { type: "array", items: { type: "string" } },
          note: { type: ["string", "null"] },
          confidence: { type: "number" }
        }
      }
    }
  }
};

const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "whyInteresting", "whatToVerify", "risks", "confidence"],
  properties: {
    headline: { type: "string" },
    whyInteresting: { type: "string" },
    whatToVerify: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  }
};

function resolveKey(settings) {
  return String(settings?.ai?.apiKey || process.env.ANTHROPIC_API_KEY || "").trim();
}

function resolveModel(settings) {
  return String(settings?.ai?.model || "").trim() || DEFAULT_MODEL;
}

async function callMessages(body, key, fetchImpl) {
  const response = await fetchImpl(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = await response.json();
      detail = errorBody?.error?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`Claude API error ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const json = await response.json();
  if (json.stop_reason === "refusal") {
    throw new Error("AI refused");
  }
  return json;
}

function parseTextJson(json) {
  const block = (json.content || []).find((entry) => entry.type === "text");
  if (!block || typeof block.text !== "string") {
    throw new Error("AI response contained no text block");
  }
  return JSON.parse(block.text);
}

// ONE batched call per market refresh, only for entities Yahoo search left unresolved.
// Returns raw proposals — the CALLER probe-validates every ticker (incl. relatedTickers)
// before anything is persisted, and caps confidence at 0.75 so AI mappings land in the
// review queue visibly "unconfirmed".
export async function aiResolveEntities(entities, settings, fetchImpl = fetch) {
  const list = (Array.isArray(entities) ? entities : []).slice(0, MAX_ENTITIES_PER_BATCH);
  if (!list.length) {
    return [];
  }
  const key = resolveKey(settings);
  if (!key) {
    throw new Error("No API key configured");
  }

  const prompt = [
    "You map company/organization names from German AI-news coverage to stock listings.",
    "For each entity return whether it is publicly listed, its primary ticker with exchange",
    "(prefer XETRA .DE listings when they exist, else the US listing), the listed parent if it",
    "is a subsidiary or brand, and for private companies up to 3 listed companies with material",
    "economic exposure plus a one-line English note.",
    "If unsure, set ticker null and confidence low. NEVER invent tickers.",
    "",
    "Entities JSON (name + up to 2 sample headlines for disambiguation):",
    JSON.stringify(list.map((entry) => ({
      name: entry.name,
      sampleTitles: (entry.sampleTitles || []).slice(0, 2)
    })))
  ].join("\n");

  const json = await callMessages({
    model: resolveModel(settings),
    max_tokens: 4000,
    output_config: { format: { type: "json_schema", schema: RESOLVE_SCHEMA } },
    messages: [{ role: "user", content: prompt }]
  }, key, fetchImpl);

  const parsed = parseTextJson(json);
  return (Array.isArray(parsed.items) ? parsed.items : []).map((item) => ({
    ...item,
    confidence: Math.min(AI_MAPPING_CONFIDENCE_CAP, Number(item.confidence) || 0),
    relatedTickers: (Array.isArray(item.relatedTickers) ? item.relatedTickers : []).slice(0, 3)
  }));
}

// On-demand only (button click / report generation) — never automatic per refresh.
export async function aiOpportunityNarrative(opportunity, articles, settings, fetchImpl = fetch) {
  const key = resolveKey(settings);
  if (!key) {
    throw new Error("No API key configured");
  }

  const evidence = (articles || []).slice(0, 8).map((article) => ({
    title: article.title,
    summary: article.summary,
    sentiment: article.sentiment,
    publishedAt: article.publishedAt,
    source: article.sourceName
  }));
  const prompt = [
    "You are a sober research assistant for a private news dashboard.",
    "Rely EXCLUSIVELY on the provided articles and signal values. Answer in English.",
    "NO buy, sell, or hold recommendations, no price or return forecasts — violations are errors.",
    "whatToVerify must be concretely checkable (e.g. next earnings date, the actual revenue share",
    "tied to the topic, whether the story merely repeats old news).",
    "",
    `Instrument: ${opportunity.name} (${opportunity.ticker}), score ${opportunity.score}, setup: ${opportunity.quadrant || "unknown"}.`,
    `Signal components: ${JSON.stringify(opportunity.components.map((c) => ({ id: c.id, value: c.value, explain: c.explain })))}`,
    "",
    "Articles JSON:",
    JSON.stringify(evidence)
  ].join("\n");

  const json = await callMessages({
    model: resolveModel(settings),
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: NARRATIVE_SCHEMA } },
    messages: [{ role: "user", content: prompt }]
  }, key, fetchImpl);

  return parseTextJson(json);
}

// Cache key: material change = component values (2dp) or the evidence set changed.
export function narrativeHash(opportunity) {
  const parts = [
    opportunity.ticker,
    ...opportunity.components.map((component) => `${component.id}:${component.value}`),
    ...[...(opportunity.articleIds || [])].sort()
  ];
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

// PATTERN-based, not a bare word list: whole-word "halten" appears in ordinary German prose
// constantly ("Analysten halten das für plausibel") and would discard paid output uselessly.
// English rating vocabulary is safe as whole words — it doesn't collide with German prose.
const RECOMMENDATION_PATTERNS = [
  /\b(kauf|verkaufs?|halte)empfehlung(en)?\b/i,
  /\bzum (kauf|verkauf)\b/i,
  /\b(kaufen|verkaufen) sie\b/i,
  /\bjetzt (kaufen|verkaufen|einsteigen|zuschlagen)\b/i,
  /\b(buy|sell|hold|overweight|underweight|outperform|underperform)\b/i,
  /\b(strong buy|strong sell)\b/i
];

export function containsRecommendationVocabulary(text) {
  const value = String(text || "");
  return RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(value));
}

export function narrativeViolates(narrative) {
  const texts = [
    narrative.headline,
    narrative.whyInteresting,
    ...(narrative.whatToVerify || []),
    ...(narrative.risks || [])
  ];
  return texts.some(containsRecommendationVocabulary);
}
