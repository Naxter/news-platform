import crypto from "node:crypto";

// Keyword lists drive categorization (whole-word, case-insensitive). English + German are
// included by default because the platform is language-agnostic; users can edit these in Settings.
export const DEFAULT_CATEGORIES = [
  { name: "Politics", keywords: ["election", "senate", "congress", "parliament", "minister", "president", "campaign", "policy", "government", "lawmakers", "diplomacy", "wahl", "regierung", "gesetz", "parlament", "politik", "kanzler", "bundestag"] },
  { name: "Business", keywords: ["market", "stocks", "earnings", "company", "startup", "investment", "revenue", "profit", "trade", "business", "bank", "inflation", "unternehmen", "markt", "milliarden", "millionen", "investition", "umsatz", "wirtschaft", "firma", "aktien", "börse"] },
  { name: "Technology", keywords: ["ai", "software", "chip", "semiconductor", "cyber", "app", "platform", "cloud", "robot", "data", "privacy", "quantum", "ki", "künstliche intelligenz", "roboter", "daten", "modell", "technologie", "computer", "chatbot", "algorithmus"] },
  { name: "Science", keywords: ["research", "study", "space", "physics", "nasa", "biology", "scientists", "discovery", "experiment", "climate model", "forschung", "studie", "wissenschaft", "forscher", "entdeckung", "physik", "biologie"] },
  { name: "Health", keywords: ["health", "hospital", "medical", "vaccine", "disease", "doctor", "drug", "medicine", "pandemic", "treatment", "gesundheit", "krankheit", "impfstoff", "medizin", "klinik", "krankenhaus", "patient"] },
  { name: "Climate", keywords: ["climate", "weather", "carbon", "emissions", "energy", "renewable", "wildfire", "flood", "heat", "environment", "klima", "energie", "umwelt", "erneuerbare", "emissionen", "wetter"] },
  { name: "Security", keywords: ["war", "military", "attack", "defense", "security", "missile", "conflict", "terror", "sanctions", "border", "sicherheit", "angriff", "krieg", "militär", "überwachung", "bedrohung", "spionage", "hacker"] },
  { name: "Culture", keywords: ["film", "music", "book", "art", "museum", "festival", "celebrity", "culture", "streaming", "media", "musik", "kunst", "kultur", "medien", "buch"] },
  { name: "Sports", keywords: ["sport", "football", "soccer", "basketball", "tennis", "olympic", "league", "match", "coach", "tournament", "fußball", "spiel", "liga", "mannschaft"] },
  { name: "World", keywords: ["global", "world", "foreign", "international", "europe", "asia", "africa", "middle east", "latin america", "welt", "europa", "asien", "afrika"] }
];

export const DEFAULT_SENTIMENT = {
  positive: ["gain", "growth", "win", "record", "boost", "breakthrough", "improve", "recovery", "agreement", "successful",
    "gewinn", "wachstum", "erfolg", "erfolgreich", "durchbruch", "rekord", "verbesserung", "einigung", "fortschritt", "stärker"],
  negative: ["fall", "loss", "risk", "crisis", "war", "attack", "decline", "lawsuit", "warning", "deadly", "cut", "strike",
    "krise", "angriff", "krieg", "verbietet", "verboten", "bedenken", "warnung", "gefahr", "risiko", "verlust",
    "betrug", "spionage", "überwachung", "streit", "schwächer", "sicherheitsbedenken"]
};

export const STOP_WORDS = new Set([
  // English
  "about", "after", "again", "against", "also", "amid", "because", "been", "before", "being",
  "between", "both", "could", "does", "down", "during", "each", "every", "first", "from",
  "have", "here", "into", "just", "like", "made", "many", "might", "more", "most",
  "much", "must", "never", "only", "other", "over", "said", "says", "should", "since",
  "some", "still", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "were", "what", "when", "where", "which",
  "while", "with", "will", "without", "would", "your",
  // German (common function words + frequent verbs/adverbs) — the platform is language-agnostic
  // and users commonly add non-English feeds; without these, German function words dominate
  // the keyword and rising-keyword lists.
  "aber", "auch", "auf", "aus", "bei", "bereits", "bis", "dabei", "damit", "dann", "dass",
  "das", "dazu", "dein", "dem", "den", "der", "des", "die", "dies", "diese", "diesem", "diesen",
  "dieser", "dieses", "doch", "durch", "eine", "einem", "einen", "einer", "eines", "etwa",
  "für", "ganz", "gegen", "gibt", "haben", "hat", "hatte", "hier", "immer", "kann", "kein", "keine",
  "können", "mehr", "mich", "mit", "nach", "nicht", "noch", "nun", "oder", "ohne", "schon",
  "sein", "sich", "sind", "soll", "sowie", "über", "und", "uns", "unter", "viel", "vom",
  "von", "vor", "wann", "warum", "was", "weil", "welche", "wenn", "werden", "wie", "wird",
  "wie", "wir", "wurde", "wurden", "zum", "zur", "zwei",
  // Recurring feed boilerplate seen in the wild (e.g. all-ai.de prefixes every item with these)
  "kurzfassung", "quellen"
]);

export const BENCHMARK_EUR_SYMBOLS = ["^GDAXI", "^TECDAX"];

export const DEFAULT_SETTINGS = {
  autoCollectMinutes: 0,
  maxArticles: 2000,
  ai: {
    enabled: false,
    apiKey: "",
    model: "claude-opus-4-8",
    maxArticlesPerCollect: 30
  },
  webhooks: [],
  apiToken: "",
  market: {
    enabled: true,
    provider: "yahoo",
    minRefreshMinutes: 180,
    maxInstruments: 40,
    historyDays: 400,
    preferXetra: true,
    benchmarkEUR: "^GDAXI",
    aiMapping: false,
    alerts: { enabled: false, minScore: 45 }
  },
  brief: {
    enabled: false,
    hour: 7,
    minute: 0,
    lookbackHours: 24,
    maxStories: 10,
    push: false
  }
};

export function emptyMarket() {
  return {
    instruments: [],
    prices: {},
    ideas: [],
    signalLog: [],
    mappings: {},
    ignoredEntities: [],
    narratives: {},
    alertState: {},
    providerHealth: { provider: "yahoo", ok: true, cooldownUntil: null, lastError: null, lastOkAt: null },
    lastRefreshAt: null,
    refreshLog: []
  };
}

export function emptyStore(nowIso = new Date().toISOString()) {
  // nowIso is accepted for call-site symmetry with seeding helpers; the empty
  // store itself carries no creation timestamp (lastCollectedAt starts null).
  void nowIso;
  return {
    version: 3,
    rev: 0,
    settings: structuredClone(DEFAULT_SETTINGS),
    categories: structuredClone(DEFAULT_CATEGORIES),
    sentiment: structuredClone(DEFAULT_SENTIMENT),
    sources: [],
    articles: [],
    watchlists: [],
    collections: [],
    market: emptyMarket(),
    brief: null,
    lastCollectedAt: null
  };
}

export function validateConfigPatch(patch) {
  if (!isPlainObject(patch)) {
    throw new Error("Config patch must be a JSON object.");
  }

  const normalized = {};
  if (patch.settings !== undefined) {
    normalized.settings = validateSettingsPatch(patch.settings);
  }
  if (patch.categories !== undefined) {
    normalized.categories = validateCategories(patch.categories);
  }
  if (patch.sentiment !== undefined) {
    normalized.sentiment = validateSentiment(patch.sentiment);
  }
  return normalized;
}

function validateSettingsPatch(settings) {
  if (!isPlainObject(settings)) {
    throw new Error("settings must be an object.");
  }

  const normalized = {};

  if (settings.autoCollectMinutes !== undefined) {
    const minutes = toInteger(settings.autoCollectMinutes);
    if (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < 5 || minutes > 1440))) {
      throw new Error("settings.autoCollectMinutes must be 0 (off) or an integer between 5 and 1440.");
    }
    normalized.autoCollectMinutes = minutes;
  }

  if (settings.maxArticles !== undefined) {
    const max = toInteger(settings.maxArticles);
    if (!Number.isInteger(max) || max < 100 || max > 20000) {
      throw new Error("settings.maxArticles must be an integer between 100 and 20000.");
    }
    normalized.maxArticles = max;
  }

  if (settings.ai !== undefined) {
    normalized.ai = validateAiPatch(settings.ai);
  }

  if (settings.market !== undefined) {
    normalized.market = validateMarketPatch(settings.market);
  }

  if (settings.brief !== undefined) {
    normalized.brief = validateBriefPatch(settings.brief);
  }

  if (settings.webhooks !== undefined) {
    if (!Array.isArray(settings.webhooks)) {
      throw new Error("settings.webhooks must be an array.");
    }
    normalized.webhooks = settings.webhooks.map(normalizeWebhook);
  }

  if (settings.apiToken !== undefined) {
    if (typeof settings.apiToken !== "string") {
      throw new Error("settings.apiToken must be a string.");
    }
    normalized.apiToken = settings.apiToken.trim();
  }

  return normalized;
}

function validateAiPatch(ai) {
  if (!isPlainObject(ai)) {
    throw new Error("settings.ai must be an object.");
  }

  const normalized = {};

  if (ai.enabled !== undefined) {
    if (typeof ai.enabled !== "boolean") {
      throw new Error("settings.ai.enabled must be a boolean.");
    }
    normalized.enabled = ai.enabled;
  }

  if (ai.apiKey !== undefined) {
    if (ai.apiKey !== null && typeof ai.apiKey !== "string") {
      throw new Error("settings.ai.apiKey must be a string or null.");
    }
    normalized.apiKey = ai.apiKey;
  }

  if (ai.model !== undefined) {
    if (typeof ai.model !== "string" || ai.model.trim() === "") {
      throw new Error("settings.ai.model must be a non-empty string.");
    }
    normalized.model = ai.model.trim();
  }

  if (ai.maxArticlesPerCollect !== undefined) {
    const max = toInteger(ai.maxArticlesPerCollect);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      throw new Error("settings.ai.maxArticlesPerCollect must be an integer between 1 and 100.");
    }
    normalized.maxArticlesPerCollect = max;
  }

  return normalized;
}

export function validateMarketPatch(market) {
  if (!isPlainObject(market)) {
    throw new Error("settings.market must be an object.");
  }

  const normalized = {};

  if (market.enabled !== undefined) {
    if (typeof market.enabled !== "boolean") {
      throw new Error("settings.market.enabled must be a boolean.");
    }
    normalized.enabled = market.enabled;
  }

  if (market.provider !== undefined) {
    if (market.provider !== "yahoo") {
      throw new Error('settings.market.provider must be "yahoo".');
    }
    normalized.provider = market.provider;
  }

  if (market.minRefreshMinutes !== undefined) {
    const minutes = toInteger(market.minRefreshMinutes);
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 1440) {
      throw new Error("settings.market.minRefreshMinutes must be an integer between 30 and 1440.");
    }
    normalized.minRefreshMinutes = minutes;
  }

  if (market.maxInstruments !== undefined) {
    const max = toInteger(market.maxInstruments);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      throw new Error("settings.market.maxInstruments must be an integer between 1 and 100.");
    }
    normalized.maxInstruments = max;
  }

  if (market.historyDays !== undefined) {
    const days = toInteger(market.historyDays);
    if (!Number.isInteger(days) || days < 90 || days > 1000) {
      throw new Error("settings.market.historyDays must be an integer between 90 and 1000.");
    }
    normalized.historyDays = days;
  }

  if (market.preferXetra !== undefined) {
    if (typeof market.preferXetra !== "boolean") {
      throw new Error("settings.market.preferXetra must be a boolean.");
    }
    normalized.preferXetra = market.preferXetra;
  }

  if (market.benchmarkEUR !== undefined) {
    if (!BENCHMARK_EUR_SYMBOLS.includes(market.benchmarkEUR)) {
      throw new Error(`settings.market.benchmarkEUR must be one of: ${BENCHMARK_EUR_SYMBOLS.join(", ")}.`);
    }
    normalized.benchmarkEUR = market.benchmarkEUR;
  }

  if (market.aiMapping !== undefined) {
    if (typeof market.aiMapping !== "boolean") {
      throw new Error("settings.market.aiMapping must be a boolean.");
    }
    normalized.aiMapping = market.aiMapping;
  }

  if (market.alerts !== undefined) {
    if (!isPlainObject(market.alerts)) {
      throw new Error("settings.market.alerts must be an object.");
    }
    const alerts = {};
    if (market.alerts.enabled !== undefined) {
      if (typeof market.alerts.enabled !== "boolean") {
        throw new Error("settings.market.alerts.enabled must be a boolean.");
      }
      alerts.enabled = market.alerts.enabled;
    }
    if (market.alerts.minScore !== undefined) {
      const minScore = toInteger(market.alerts.minScore);
      if (!Number.isInteger(minScore) || minScore < 1 || minScore > 100) {
        throw new Error("settings.market.alerts.minScore must be an integer between 1 and 100.");
      }
      alerts.minScore = minScore;
    }
    normalized.alerts = alerts;
  }

  return normalized;
}

export function validateBriefPatch(brief) {
  if (!isPlainObject(brief)) {
    throw new Error("settings.brief must be an object.");
  }

  const normalized = {};

  if (brief.enabled !== undefined) {
    if (typeof brief.enabled !== "boolean") {
      throw new Error("settings.brief.enabled must be a boolean.");
    }
    normalized.enabled = brief.enabled;
  }

  if (brief.hour !== undefined) {
    const hour = toInteger(brief.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error("settings.brief.hour must be an integer between 0 and 23.");
    }
    normalized.hour = hour;
  }

  if (brief.minute !== undefined) {
    const minute = toInteger(brief.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error("settings.brief.minute must be an integer between 0 and 59.");
    }
    normalized.minute = minute;
  }

  if (brief.lookbackHours !== undefined) {
    const hours = toInteger(brief.lookbackHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      throw new Error("settings.brief.lookbackHours must be an integer between 1 and 168.");
    }
    normalized.lookbackHours = hours;
  }

  if (brief.maxStories !== undefined) {
    const max = toInteger(brief.maxStories);
    if (!Number.isInteger(max) || max < 3 || max > 30) {
      throw new Error("settings.brief.maxStories must be an integer between 3 and 30.");
    }
    normalized.maxStories = max;
  }

  if (brief.push !== undefined) {
    if (typeof brief.push !== "boolean") {
      throw new Error("settings.brief.push must be a boolean.");
    }
    normalized.push = brief.push;
  }

  return normalized;
}

function normalizeWebhook(entry) {
  if (!isPlainObject(entry)) {
    throw new Error("Each webhook must be an object with a url.");
  }
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Each webhook url must start with http:// or https://.");
  }
  if (entry.format !== undefined && !["json", "ntfy"].includes(entry.format)) {
    throw new Error('Webhook format must be "json" or "ntfy".');
  }
  return {
    id: typeof entry.id === "string" && entry.id !== "" ? entry.id : `wh-${crypto.randomBytes(6).toString("hex")}`,
    url,
    format: entry.format === "ntfy" ? "ntfy" : "json",
    createdAt: typeof entry.createdAt === "string" && entry.createdAt !== "" ? entry.createdAt : new Date().toISOString()
  };
}

function validateCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("categories must be a non-empty array.");
  }

  const seen = new Set();
  return categories.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new Error("Every category must be an object with a name and keywords.");
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) {
      throw new Error("Every category needs a non-empty name.");
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate category name: "${name}".`);
    }
    seen.add(key);

    const rawKeywords = entry.keywords === undefined ? [] : entry.keywords;
    if (!Array.isArray(rawKeywords)) {
      throw new Error(`Category "${name}" keywords must be an array of strings.`);
    }
    const keywords = [];
    for (const keyword of rawKeywords) {
      if (typeof keyword !== "string") {
        throw new Error(`Category "${name}" keywords must be an array of strings.`);
      }
      const cleaned = keyword.trim().toLowerCase();
      if (cleaned && !keywords.includes(cleaned)) {
        keywords.push(cleaned);
      }
    }
    return { name, keywords };
  });
}

function validateSentiment(sentiment) {
  if (!isPlainObject(sentiment)) {
    throw new Error("sentiment must be an object with positive and negative word arrays.");
  }
  return {
    positive: normalizeWordList(sentiment.positive, "sentiment.positive"),
    negative: normalizeWordList(sentiment.negative, "sentiment.negative")
  };
}

function normalizeWordList(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const words = [];
  for (const word of value) {
    if (typeof word !== "string") {
      throw new Error(`${label} must be an array of strings.`);
    }
    const cleaned = word.trim().toLowerCase();
    if (cleaned && !words.includes(cleaned)) {
      words.push(cleaned);
    }
  }
  return words;
}

function toInteger(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return NaN;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
