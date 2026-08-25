import { containsWord } from "../text.mjs";

const TICKER_RE = /^[A-Z0-9.-]{1,12}$/;
const SIZE_HINTS = ["large", "mid", "small"];

// Trailing legal-form tokens stripped when deriving aliases. German forms matter because the
// entity extractor emits names like "Infineon Technologies AG" while headlines say "Infineon".
const LEGAL_SUFFIXES = new Set([
  "ag", "se", "gmbh", "kgaa", "aktiengesellschaft", "holding", "holdings", "group",
  "inc", "inc.", "corp", "corp.", "corporation", "co", "co.", "company",
  "plc", "ltd", "ltd.", "nv", "n.v.", "sa", "s.a.", "spa", "s.p.a.", "oyj", "ab"
]);

export function normalizeTicker(raw) {
  const ticker = String(raw ?? "").trim().toUpperCase();
  if (ticker.startsWith("^")) {
    throw new Error("Index symbols (^...) cannot be added as an instrument.");
  }
  if (!TICKER_RE.test(ticker)) {
    throw new Error("Ticker must be 1-12 characters (letters, digits, dot, hyphen).");
  }
  return ticker;
}

export function validateInstrumentPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Instrument patch must be a JSON object.");
  }

  const normalized = {};

  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.trim() === "") {
      throw new Error("name must be a non-empty string.");
    }
    normalized.name = patch.name.trim();
  }

  if (patch.aliases !== undefined) {
    if (!Array.isArray(patch.aliases)) {
      throw new Error("aliases must be an array of strings.");
    }
    const aliases = [];
    for (const alias of patch.aliases) {
      if (typeof alias !== "string") {
        throw new Error("aliases must be an array of strings.");
      }
      const cleaned = alias.trim().toLowerCase();
      if (cleaned && !aliases.includes(cleaned)) {
        aliases.push(cleaned);
      }
    }
    if (aliases.length === 0) {
      throw new Error("aliases must contain at least one non-empty entry.");
    }
    normalized.aliases = aliases;
  }

  if (patch.paused !== undefined) {
    if (typeof patch.paused !== "boolean") {
      throw new Error("paused must be a boolean.");
    }
    normalized.paused = patch.paused;
  }

  if (patch.sizeHint !== undefined) {
    if (patch.sizeHint !== null && !SIZE_HINTS.includes(patch.sizeHint)) {
      throw new Error('sizeHint must be "large", "mid", "small" or null.');
    }
    normalized.sizeHint = patch.sizeHint;
  }

  if (patch.confirmed !== undefined) {
    if (typeof patch.confirmed !== "boolean") {
      throw new Error("confirmed must be a boolean.");
    }
    normalized.confirmed = patch.confirmed;
  }

  return normalized;
}

export function defaultAliases(name, ticker) {
  const aliases = [];
  const push = (value) => {
    const cleaned = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (cleaned && !aliases.includes(cleaned)) {
      aliases.push(cleaned);
    }
  };

  const fullName = String(name || "").trim();
  push(fullName);

  // Strip trailing legal-form tokens: "Infineon Technologies AG" -> "Infineon Technologies".
  const words = fullName.toLowerCase().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1].replace(/[,.]+$/, ""))) {
    words.pop();
  }
  push(words.join(" "));

  // A distinctive multi-word name usually gets shortened to its first word in headlines
  // ("Infineon", "Siemens") — but only when that word is substantial enough to be unambiguous.
  if (words.length > 1 && words[0].length >= 5) {
    push(words[0]);
  }

  if (aliases.length === 0 && ticker) {
    push(ticker);
  }
  return aliases;
}

// Pure. Whole-word alias matching (containsWord fixes the legacy "ai"-matches-"said" bug and
// caches compiled regexes) over the fields where company names actually appear. entities.people
// is included because the heuristic extractor routinely misfiles companies as people.
export function matchArticlesToInstruments(articles, instruments) {
  const matches = new Map();
  if (!Array.isArray(instruments) || instruments.length === 0) {
    return matches;
  }
  for (const instrument of instruments) {
    matches.set(instrument.ticker, { articleIds: [], aiEnrichedCount: 0 });
  }

  for (const article of Array.isArray(articles) ? articles : []) {
    const haystack = [
      article.title || "",
      Array.isArray(article.keywords) ? article.keywords.join(" ") : "",
      article.entities && Array.isArray(article.entities.orgs) ? article.entities.orgs.join(" ") : "",
      article.entities && Array.isArray(article.entities.people) ? article.entities.people.join(" ") : ""
    ].join(" ");

    for (const instrument of instruments) {
      if (instrument.aliases.some((alias) => containsWord(haystack, alias))) {
        const entry = matches.get(instrument.ticker);
        entry.articleIds.push(article.id);
        if (article.aiEnriched === true) {
          entry.aiEnrichedCount += 1;
        }
      }
    }
  }
  return matches;
}
