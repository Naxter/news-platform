import {
  cleanText,
  truncate,
  hashId,
  parseDateSafe,
  toMonthKey,
  countWordHits,
  stripBoilerplate
} from "../text.mjs";

const FALLBACK_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "amid", "because", "before",
  "being", "between", "could", "first", "from", "have", "into", "more", "over",
  "said", "says", "than", "that", "their", "there", "this", "through", "under",
  "were", "with", "will", "would", "your"
]);

const KNOWN_PLACES = new Set([
  "united states", "america", "washington", "new york", "california", "texas",
  "canada", "mexico", "brazil", "argentina", "britain", "united kingdom",
  "england", "london", "scotland", "ireland", "france", "paris", "germany",
  "berlin", "brussels", "europe", "spain", "italy", "rome", "ukraine", "russia",
  "moscow", "china", "beijing", "hong kong", "taiwan", "japan", "tokyo",
  "india", "pakistan", "south korea", "north korea", "korea", "singapore",
  "australia", "africa", "nigeria", "egypt", "israel", "gaza", "iran", "iraq",
  "syria", "turkey", "saudi arabia", "middle east", "asia", "latin america"
]);

const ORG_SUFFIXES = new Set([
  "inc", "corp", "corporation", "ltd", "llc", "plc", "bank", "group",
  "university", "agency", "ministry", "department", "institute", "commission",
  "committee", "council", "association", "authority", "foundation", "fund",
  "organization"
]);

const LEADING_STRIP = new Set([
  // English
  "the", "a", "an", "this", "that", "these", "those", "its", "his", "her",
  "their", "our", "some", "many", "several", "most",
  // German articles/determiners — German capitalizes every noun, so phrases like
  // "Das Unternehmen" / "Diese Erkenntnis" otherwise surface as bogus entities.
  "der", "die", "das", "dem", "den", "des", "ein", "eine", "einen", "einem",
  "einer", "eines", "diese", "dieser", "dieses", "diesem", "diesen", "seine",
  "seinen", "ihre", "ihren", "strikte", "neue", "neuer", "neues"
]);

const COMMON_SINGLE_SKIP = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "he", "she",
  "they", "we", "i", "you", "but", "and", "or", "if", "when", "while", "after",
  "before", "during", "however", "meanwhile", "today", "yesterday", "tomorrow",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "officials", "analysts",
  "investors", "governments", "hospitals", "policymakers", "regulators",
  "researchers", "scientists", "lawmakers", "leaders", "experts"
]);

const ENTITY_PATTERN = /(?:[A-Z][a-zA-Z'’-]+|[A-Z]{2,5})(?:\s+(?:[A-Z][a-zA-Z'’-]+|[A-Z]{2,5}))*/g;

function normalizeStopWords(stopWords) {
  if (stopWords instanceof Set) {
    return stopWords;
  }
  if (Array.isArray(stopWords)) {
    return new Set(stopWords.map((word) => String(word).toLowerCase()));
  }
  return FALLBACK_STOP_WORDS;
}

export function categorize(text, categories) {
  const list = Array.isArray(categories) ? categories : [];
  if (!list.length) {
    return "World";
  }
  let winnerName = null;
  let winnerScore = 0;
  for (const category of list) {
    const score = countWordHits(text, category.keywords || []);
    if (score > winnerScore) {
      winnerScore = score;
      winnerName = category.name;
    }
  }
  if (winnerScore > 0) {
    return winnerName;
  }
  const world = list.find((category) => category.name === "World");
  return world ? world.name : list[0].name;
}

export function extractKeywords(text, stopWords) {
  const stop = normalizeStopWords(stopWords);
  const counts = {};
  // Unicode-aware: match whole words including accented/non-ASCII letters. The old
  // /[a-z].../ pattern split "Fähigkeiten" into "f" + "higkeiten", producing junk tokens.
  const words = String(text || "").toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || [];
  for (const word of words) {
    if (!stop.has(word)) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

export function summarize(title, body) {
  // A clean lead-sentence summary. (Category and keywords are surfaced as their own
  // chips in the UI; appending them here read as boilerplate and polluted re-extraction.)
  const sentences = stripBoilerplate(cleanText(body))
    // Split on sentence punctuation, but not after a digit-period (ordinals like the German
    // "15." or version numbers like "2.0") which would sever a sentence mid-way.
    .split(/(?<![0-9]\.)(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter((sentence) => sentence.length > 30);
  const lead = sentences[0] || body || title;
  const trimmed = truncate(lead, 260);
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")
    ? trimmed
    : `${trimmed}.`;
}

export function scoreSentiment(text, sentiment) {
  const positive = countWordHits(text, sentiment?.positive || []);
  const negative = countWordHits(text, sentiment?.negative || []);
  if (positive > negative) {
    return "positive";
  }
  if (negative > positive) {
    return "watch";
  }
  return "neutral";
}

function classifyEntity(value, words) {
  const lower = value.toLowerCase();
  if (KNOWN_PLACES.has(lower)) {
    return "places";
  }
  const last = words[words.length - 1].toLowerCase().replace(/[.,]+$/, "");
  if (ORG_SUFFIXES.has(last)) {
    return "orgs";
  }
  if (words.length === 1 && /^[A-Z]{2,5}$/.test(words[0])) {
    return "orgs";
  }
  if (words.length === 2) {
    return "people";
  }
  return "orgs";
}

export function extractEntities(text, stopWords) {
  const stop = normalizeStopWords(stopWords);
  const buckets = { people: [], orgs: [], places: [] };
  const clean = cleanText(text);
  if (!clean) {
    return buckets;
  }
  const seen = { people: new Set(), orgs: new Set(), places: new Set() };
  const sentences = clean.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(ENTITY_PATTERN)) {
      let words = match[0].trim().split(/\s+/);
      const sentenceInitial = match.index === 0;
      let value = words.join(" ");
      if (!KNOWN_PLACES.has(value.toLowerCase())) {
        while (words.length > 1 && LEADING_STRIP.has(words[0].toLowerCase())) {
          words = words.slice(1);
        }
        value = words.join(" ");
      }
      if (!words.length || (words.length === 1 && words[0].length < 2)) {
        continue;
      }
      // Drop phrases that are entirely stop words (common after stripping determiners
      // from capitalized-noun languages like German), and single stop-word tokens.
      if (words.every((word) => stop.has(word.toLowerCase()))) {
        continue;
      }
      if (words.length === 1) {
        const word = words[0];
        const lower = word.toLowerCase();
        const isAcronym = /^[A-Z]{2,5}$/.test(word);
        if ((COMMON_SINGLE_SKIP.has(lower) || stop.has(lower)) && !isAcronym) {
          continue;
        }
        if (sentenceInitial && !isAcronym && !KNOWN_PLACES.has(lower)) {
          continue;
        }
      }
      const bucket = classifyEntity(value, words);
      const key = value.toLowerCase();
      if (seen[bucket].has(key) || buckets[bucket].length >= 5) {
        continue;
      }
      seen[bucket].add(key);
      buckets[bucket].push(value);
    }
  }
  return buckets;
}

export function enrichArticle(raw, source, config) {
  const title = cleanText(raw.title || "") || "Untitled story";
  const body = cleanText(raw.body || "");
  const text = `${title}. ${body}`;
  const now = new Date().toISOString();
  let publishedAt = parseDateSafe(raw.publishedAt) || parseDateSafe(raw.collectedAtHint) || now;
  // Guard against clock-skewed / mis-typed feed dates (e.g. wrong year) that would
  // otherwise pin the story at the top of every list and poison latest-month analytics.
  if (new Date(publishedAt).getTime() > Date.now() + 60_000) {
    publishedAt = now;
  }
  let url = String(raw.url || "").trim();
  if (!/^https?:\/\//i.test(url) && !/^manual:\/\//i.test(url)) {
    url = "";
  }
  const categories = config?.categories || [];
  const sentimentConfig = config?.sentiment || { positive: [], negative: [] };
  const category = categorize(text, categories);
  const keywords = extractKeywords(text, config?.stopWords);
  const summary = summarize(title, body);
  return {
    id: hashId(`${url || title}:${title}`),
    title,
    url,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    publishedAt,
    collectedAt: now,
    monthKey: toMonthKey(publishedAt),
    category,
    summary,
    keywords,
    sentiment: scoreSentiment(text, sentimentConfig),
    entities: extractEntities(text, config?.stopWords),
    readingMinutes: Math.max(1, Math.round(text.split(/\s+/).length / 220)),
    clusterId: null,
    read: false,
    starred: false,
    aiEnriched: false,
    fullTextFetched: false
  };
}
