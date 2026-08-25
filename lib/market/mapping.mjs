import { safeFetch } from "../collect/fetchGuard.mjs";
import { SEED_MAP } from "./seedMap.mjs";
import { YAHOO_USER_AGENT, assertMarketHost, paceMarketFetch, probeSymbol } from "./prices.mjs";

const DAY_MS = 86400000;
const PROBE_CANDIDATE_CAP = 3; // probe-budget: validate the top candidates, never all eight
const REVALIDATE_AFTER_DAYS = 90;

// THE cache/override key everywhere: lowercase, umlauts folded, legal suffixes stripped,
// punctuation removed, whitespace collapsed. "Deutsche Bank AG" == "DEUTSCHE BANK
// AKTIENGESELLSCHAFT" == "deutsche bank".
const LEGAL_TOKENS = new Set([
  "ag", "se", "gmbh", "kgaa", "aktiengesellschaft", "holding", "holdings", "group", "gruppe",
  "inc", "corp", "corporation", "co", "company", "plc", "ltd", "limited", "nv", "sa", "spa",
  "oyj", "ab", "as", "kk"
]);

export function normalizeName(name) {
  let text = String(name || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/&\s*co\b\.?/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_TOKENS.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

function seedLookup(name) {
  const key = normalizeName(name);
  if (SEED_MAP[key]) {
    return { key, entry: SEED_MAP[key] };
  }
  // Umlaut-folded seed keys are already normalized; also try the raw lowercase key for
  // seed entries whose display key kept diacritics.
  const rawKey = String(name || "").toLowerCase().trim();
  return SEED_MAP[rawKey] ? { key: rawKey, entry: SEED_MAP[rawKey] } : null;
}

// Frequency-ranked entity names not yet covered by instruments/mappings/ignores — the
// "Unresolved" review queue. aiEnriched articles weigh double (their entities are clean).
export function suggestCandidates(articles, market, { minMentions = 3, windowDays = 30, nowIso } = {}) {
  const nowMs = Date.parse(nowIso);
  const covered = new Set([
    ...market.instruments.flatMap((instrument) => instrument.aliases.map(normalizeName)),
    ...Object.keys(market.mappings || {}),
    ...(market.ignoredEntities || []).map(normalizeName)
  ]);

  const tally = new Map();
  for (const article of articles || []) {
    const time = Date.parse(article.publishedAt);
    if (!Number.isFinite(time) || nowMs - time > windowDays * DAY_MS) {
      continue;
    }
    const weight = article.aiEnriched === true ? 2 : 1;
    const names = [
      ...(article.entities && Array.isArray(article.entities.orgs) ? article.entities.orgs : []),
      ...(article.entities && Array.isArray(article.entities.people) ? article.entities.people : [])
    ];
    for (const raw of names) {
      const key = normalizeName(raw);
      if (!key || key.length < 3 || covered.has(key)) {
        continue;
      }
      const entry = tally.get(key) || { name: key, displayName: raw, mentions: 0, sampleTitles: [] };
      entry.mentions += weight;
      if (entry.sampleTitles.length < 2 && !entry.sampleTitles.includes(article.title)) {
        entry.sampleTitles.push(article.title);
      }
      tally.set(key, entry);
    }
  }
  return [...tally.values()]
    .filter((entry) => entry.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 12);
}

// The discovery lane: entities whose FIRST mention in the whole corpus is recent. The spike
// math structurally suppresses first-ever mentions — this surfaces them independent of score.
export function detectNewNames(articles, market, { windowDays = 14, minMentions = 2, nowIso } = {}) {
  const nowMs = Date.parse(nowIso);
  const covered = new Set([
    ...market.instruments.flatMap((instrument) => instrument.aliases.map(normalizeName)),
    ...(market.ignoredEntities || []).map(normalizeName)
  ]);
  const mappings = market.mappings || {};

  const firstSeen = new Map();
  for (const article of articles || []) {
    const time = Date.parse(article.publishedAt);
    if (!Number.isFinite(time)) {
      continue;
    }
    const names = [
      ...(article.entities && Array.isArray(article.entities.orgs) ? article.entities.orgs : []),
      ...(article.entities && Array.isArray(article.entities.people) ? article.entities.people : [])
    ];
    for (const raw of names) {
      const key = normalizeName(raw);
      if (!key || key.length < 3 || covered.has(key)) {
        continue;
      }
      const entry = firstSeen.get(key) ||
        { name: key, displayName: raw, mentions: 0, firstSeenAt: time };
      entry.mentions += 1;
      if (time < entry.firstSeenAt) {
        entry.firstSeenAt = time;
      }
      firstSeen.set(key, entry);
    }
  }

  return [...firstSeen.values()]
    .filter((entry) => entry.mentions >= minMentions && nowMs - entry.firstSeenAt <= windowDays * DAY_MS)
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
    .slice(0, 8)
    .map((entry) => ({
      name: entry.name,
      displayName: entry.displayName,
      mentions: entry.mentions,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
      mappingStatus: mappings[entry.name] ? mappings[entry.name].status : "unresolved"
    }));
}

// Layered resolution: seed hit first (curated, conf 0.95), then Yahoo search with the top
// candidates probe-validated (SPEC invariant 3). Ambiguity (Merck trap) is returned as
// multiple candidates — the USER decides, never automation.
export async function resolveEntity(name, settings, { fetchImpl = safeFetch, throttleMs = 1000 } = {}) {
  const seed = seedLookup(name);
  const result = { candidates: [], seed: seed ? { key: seed.key, ...seed.entry } : null };

  const searchUrl = "https://query1.finance.yahoo.com/v1/finance/search" +
    `?q=${encodeURIComponent(String(name || "").trim())}&quotesCount=8&newsCount=0`;
  assertMarketHost(searchUrl);
  await paceMarketFetch(throttleMs);

  let quotes = [];
  try {
    const response = await fetchImpl(searchUrl, {
      timeoutMs: 15000,
      headers: { "user-agent": YAHOO_USER_AGENT, accept: "application/json" }
    });
    if (response.ok) {
      const payload = JSON.parse(response.text);
      quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
    }
  } catch {
    // Search unreachable: the seed hit (if any) still stands; candidates stay empty.
    return result;
  }

  const equities = quotes.filter((quote) =>
    quote && quote.quoteType === "EQUITY" && typeof quote.symbol === "string");
  if (settings.market.preferXetra) {
    equities.sort((a, b) =>
      Number(b.exchange === "GER" || b.exchDisp === "XETRA") -
      Number(a.exchange === "GER" || a.exchDisp === "XETRA"));
  }

  const target = normalizeName(name);
  for (const quote of equities.slice(0, PROBE_CANDIDATE_CAP)) {
    const probe = await probeSymbol(quote.symbol, { throttleMs, fetchImpl });
    if (!probe.ok) {
      continue; // probe-failed candidates are dropped, never offered as validated
    }
    const probedName = normalizeName(probe.meta.name);
    result.candidates.push({
      ticker: probe.meta.symbol,
      exchange: probe.meta.exchange,
      currency: probe.meta.currency,
      name: probe.meta.name,
      probed: true,
      // Name overlap is a sanity signal, not a gate: dual listings of the same company all
      // match; a genuinely different company (Merck & Co vs Merck KGaA) shows as ambiguity
      // the user resolves in the picker.
      nameMatches: probedName.includes(target) || target.includes(probedName)
    });
  }
  for (const quote of equities.slice(PROBE_CANDIDATE_CAP)) {
    result.candidates.push({
      ticker: quote.symbol,
      exchange: String(quote.exchDisp || quote.exchange || ""),
      currency: null,
      name: String(quote.longname || quote.shortname || quote.symbol),
      probed: false,
      nameMatches: null
    });
  }
  return result;
}

// Amortized trust maintenance: records not re-validated for 90 days, oldest first. The
// refresh cycle consumes <=2 per run; a probe-404 flags the record for the review queue.
export function revalidationQueue(market, nowIso) {
  const nowMs = Date.parse(nowIso);
  const dueBefore = nowMs - REVALIDATE_AFTER_DAYS * DAY_MS;
  const age = (validatedAt) => {
    const time = validatedAt ? Date.parse(validatedAt) : NaN;
    return Number.isFinite(time) ? time : -Infinity; // never validated sorts first
  };

  const due = [];
  for (const instrument of market.instruments) {
    if (!instrument.paused && !instrument.staleSymbol && age(instrument.validatedAt) < dueBefore) {
      due.push({ kind: "instrument", key: instrument.ticker, symbol: instrument.ticker, validatedAt: instrument.validatedAt });
    }
  }
  for (const [key, mapping] of Object.entries(market.mappings || {})) {
    if (mapping.ticker && mapping.status !== "unresolved" && age(mapping.validatedAt) < dueBefore) {
      due.push({ kind: "mapping", key, symbol: mapping.ticker, validatedAt: mapping.validatedAt });
    }
  }
  return due.sort((a, b) => age(a.validatedAt) - age(b.validatedAt));
}
