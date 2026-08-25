import crypto from "node:crypto";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  plusmn: "±",
  times: "×",
  divide: "÷"
};

function fromCodePointSafe(code, fallback) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => fromCodePointSafe(parseInt(code, 16), match))
    .replace(/&#(\d+);/g, (match, code) => fromCodePointSafe(Number(code), match))
    .replace(/&([a-z][a-z0-9]{1,30});/gi, (match, name) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded === undefined ? match : decoded;
    });
}

export function cleanText(value) {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value, max) {
  const text = cleanText(value);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

// Navigation/breadcrumb separators that commonly prefix feed descriptions
// (e.g. "Home ▸ Tech ▸ …" or all-ai.de's "GPT-Images-2.0 Kurzfassung ▾ Quellen ▾ …").
// Deliberately excludes "|" and slashes, which appear in normal prose.
const NAV_SEPARATOR = /[▾▸▶►◂◄‣•»]/g;

export function stripBoilerplate(value) {
  const text = String(value || "").trim();
  const window = text.slice(0, 90);
  const separators = [...window.matchAll(NAV_SEPARATOR)];
  if (!separators.length) {
    return text;
  }
  const last = separators[separators.length - 1];
  const remainder = text.slice(last.index + last[0].length).trim();
  // Only strip when a meaningful remainder survives — never swallow the whole summary.
  return remainder.length >= 18 ? remainder : text;
}

export function hashId(value) {
  return crypto.createHash("sha1").update(String(value ?? "")).digest("hex");
}

export function parseDateSafe(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value);
  } else {
    const text = cleanText(String(value));
    if (!text) {
      return null;
    }
    date = new Date(text);
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toMonthKey(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function absolutizeUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "News Source";
  }
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const wordRegexCache = new Map();

function wordPattern(word) {
  let pattern = wordRegexCache.get(word);
  if (!pattern) {
    const escaped = word
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .split(/\s+/)
      .join("\\s+");
    pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    wordRegexCache.set(word, pattern);
  }
  return pattern;
}

export function containsWord(text, word) {
  const needle = String(word || "").trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const haystack = String(text || "").toLowerCase();
  if (!haystack) {
    return false;
  }
  return wordPattern(needle).test(haystack);
}

export function countWordHits(text, words) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack || !words || typeof words[Symbol.iterator] !== "function") {
    return 0;
  }
  let hits = 0;
  for (const word of words) {
    const needle = String(word || "").trim().toLowerCase();
    if (needle && wordPattern(needle).test(haystack)) {
      hits += 1;
    }
  }
  return hits;
}
