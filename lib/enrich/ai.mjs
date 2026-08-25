const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-8";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 90000;
const VALID_SENTIMENTS = new Set(["positive", "neutral", "watch"]);

const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "summary", "sentiment", "keywords", "entities"],
        properties: {
          id: { type: "string" },
          category: { type: "string" },
          summary: { type: "string" },
          sentiment: { type: "string", enum: ["positive", "neutral", "watch"] },
          keywords: { type: "array", items: { type: "string" } },
          entities: {
            type: "object",
            additionalProperties: false,
            required: ["people", "orgs", "places"],
            properties: {
              people: { type: "array", items: { type: "string" } },
              orgs: { type: "array", items: { type: "string" } },
              places: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  }
};

export function aiAvailable(settings) {
  return Boolean(
    settings && settings.ai && settings.ai.enabled &&
    (settings.ai.apiKey || process.env.ANTHROPIC_API_KEY)
  );
}

function resolveKey(settings) {
  return String(settings?.ai?.apiKey || process.env.ANTHROPIC_API_KEY || "").trim();
}

function resolveModel(settings) {
  return String(settings?.ai?.model || "").trim() || DEFAULT_MODEL;
}

async function callMessages(body, key) {
  const response = await fetch(API_URL, {
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

function textBlocks(json) {
  return (json.content || []).filter((block) => block.type === "text");
}

function normalizeStringArray(value, max) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, max);
}

function buildBatchPrompt(categoryNames, items) {
  return [
    "You are a news enrichment engine for a local intelligence dashboard.",
    "For each article in the JSON below, produce exactly one result item that echoes the article's id unchanged.",
    `Classify each article into EXACTLY one of these category names: ${categoryNames.join(", ")}.`,
    "Write a neutral, factual 2-sentence summary for each article.",
    "Set sentiment to \"positive\", \"neutral\", or \"watch\" — use \"watch\" for risk-laden or negative developments.",
    "Provide at most 6 short lowercase keywords per article.",
    "Extract entities mentioned in the article: people, orgs, places (empty arrays when none).",
    "",
    "Articles JSON:",
    JSON.stringify(items)
  ].join("\n");
}

export async function aiEnrich(articles, settings, config) {
  const results = new Map();
  const list = Array.isArray(articles) ? articles.filter(Boolean) : [];
  if (!list.length) {
    return results;
  }
  const key = resolveKey(settings);
  if (!key) {
    throw new Error("AI is not configured: missing API key");
  }
  const categoryNames = (config?.categories || []).map((category) => category.name);
  const model = resolveModel(settings);

  let firstError = null;
  for (let offset = 0; offset < list.length; offset += BATCH_SIZE) {
    const batch = list.slice(offset, offset + BATCH_SIZE);
    // Only ids we actually sent may receive enrichment. Without this, a hostile feed
    // title could smuggle an extra result item carrying another article's (predictable)
    // id and overwrite its category/summary/sentiment.
    const allowedIds = new Set(batch.map((article) => article.id));
    const items = batch.map((article) => ({
      id: article.id,
      title: article.title,
      body: String(article.body || article.summary || "").slice(0, 4000)
    }));
    try {
      const json = await callMessages({
        model,
        max_tokens: 8000,
        output_config: { format: { type: "json_schema", schema: BATCH_SCHEMA } },
        messages: [{ role: "user", content: buildBatchPrompt(categoryNames, items) }]
      }, key);
      const block = textBlocks(json)[0];
      if (!block) {
        throw new Error("AI response contained no text block");
      }
      let parsed;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        throw new Error("AI returned invalid JSON");
      }
      for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        if (!item || typeof item.id !== "string" || !allowedIds.has(item.id)) {
          continue;
        }
        const entry = {
          summary: typeof item.summary === "string" ? item.summary.trim() : "",
          sentiment: VALID_SENTIMENTS.has(item.sentiment) ? item.sentiment : "neutral",
          keywords: normalizeStringArray(item.keywords, 6),
          entities: {
            people: normalizeStringArray(item.entities?.people, 5),
            orgs: normalizeStringArray(item.entities?.orgs, 5),
            places: normalizeStringArray(item.entities?.places, 5)
          }
        };
        if (categoryNames.includes(item.category)) {
          entry.category = item.category;
        }
        results.set(item.id, entry);
      }
    } catch (error) {
      // Preserve enrichments from batches that already succeeded (they were paid for).
      // Surface the failure only if nothing at all came back.
      firstError = firstError || error;
      break;
    }
  }
  if (!results.size && firstError) {
    throw firstError;
  }
  return results;
}

// Whether the morning brief can use the LLM. Unlike aiAvailable(), this does NOT require the
// per-collect enrichment flag — a user can want the daily brief without enriching every article.
export function briefAiAvailable(settings) {
  return Boolean(resolveKey(settings));
}

export async function aiMorningBrief({ dateLabel, windowHours, stories }, settings) {
  const key = resolveKey(settings);
  if (!key) {
    throw new Error("AI is not configured: missing API key");
  }
  const lines = (Array.isArray(stories) ? stories : []).map((story) =>
    `${story.n}. [${story.category}/${story.sentiment}${story.coverage > 1 ? `, ${story.coverage}x coverage` : ""}] ${story.title} (${story.source})` +
    (story.summary ? `\n   ${story.summary}` : ""));
  const prompt = [
    "You are the editor of a personal morning news briefing. Write a brief a busy reader can skim in under a minute.",
    `Date: ${dateLabel}. These are the stories from roughly the last ${windowHours} hours.`,
    "",
    "Write it as Markdown in exactly this shape:",
    "- A 2-3 sentence opening paragraph naming the day's biggest theme(s).",
    "- Then group the stories under 2-4 '## Theme' headers of your choosing (e.g. by topic, not by source).",
    "- Under each header, 1-4 bullets. Each bullet: **A tight headline** — one clause on why it matters.",
    "- Lead with anything risk-laden or market-moving.",
    "",
    "Rules: Ground EVERY statement only in the stories below — never invent facts, numbers, or events.",
    "Be concise and concrete. No preamble, no sign-off, no 'here is your brief'. Start directly with the opening paragraph.",
    "",
    "Stories:",
    ...lines
  ].join("\n");
  const json = await callMessages({
    model: resolveModel(settings),
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }]
  }, key);
  const text = textBlocks(json).map((block) => block.text).join("\n").trim();
  if (!text) {
    throw new Error("AI returned an empty brief");
  }
  return text;
}

export async function aiReportNarrative({ title, focus, month, articles }, settings) {
  const key = resolveKey(settings);
  if (!key) {
    throw new Error("AI is not configured: missing API key");
  }
  const lines = (Array.isArray(articles) ? articles : [])
    .slice(0, 40)
    .map((article) => `- ${article.title}: ${article.summary || ""}`);
  const period = month === "All" ? "all collected months" : month;
  const prompt = [
    "You are a senior news analyst writing for an internal intelligence briefing.",
    `Write an analytical narrative of roughly 200 words for the report "${title}" with a ${focus} focus, covering ${period}.`,
    "Ground every statement ONLY in the article titles and summaries listed below. Do not invent facts, figures, or events.",
    "Write flowing prose without headings or bullet lists.",
    "",
    "Articles:",
    ...lines
  ].join("\n");
  const json = await callMessages({
    model: resolveModel(settings),
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }]
  }, key);
  const text = textBlocks(json).map((block) => block.text).join("\n").trim();
  if (!text) {
    throw new Error("AI returned an empty narrative");
  }
  return text;
}
