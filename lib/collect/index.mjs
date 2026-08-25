import { safeFetch } from "./fetchGuard.mjs";
import { parseFeed } from "./rss.mjs";
import { parseNewsPage } from "./web.mjs";

export function inferType(url, contentType, raw) {
  if (/rss|atom|xml/i.test(String(contentType || "")) || /<rss|<feed|<rdf/i.test(String(raw || "").slice(0, 500))) {
    return "rss";
  }
  if (/\.(xml|rss|atom)(\?|$)/i.test(String(url || ""))) {
    return "rss";
  }
  return "web";
}

export async function collectSource(source, fetchImpl = safeFetch) {
  const headers = {};
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.lastModified) headers["if-modified-since"] = source.lastModified;

  const response = await fetchImpl(source.url, { headers });

  if (response.status === 304) {
    return {
      notModified: true,
      items: [],
      etag: response.headers.get("etag") || source.etag || null,
      lastModified: response.headers.get("last-modified") || source.lastModified || null
    };
  }
  if (!response.ok) {
    throw new Error(`Fetch failed with ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const raw = response.text;
  const type = source.type && source.type !== "auto"
    ? source.type
    : inferType(source.url, contentType, raw);
  const items = type === "rss" ? parseFeed(raw, source) : parseNewsPage(raw, source);

  return {
    notModified: false,
    items,
    etag: response.headers.get("etag") || null,
    lastModified: response.headers.get("last-modified") || null
  };
}

export async function collectAll(sources, { concurrency = 4, fetchImpl } = {}) {
  const impl = fetchImpl || safeFetch;
  const eligible = (sources || []).filter((source) => source.type !== "manual" && !source.paused);
  const results = new Array(eligible.length);
  let cursor = 0;

  async function worker() {
    while (cursor < eligible.length) {
      const index = cursor;
      cursor += 1;
      const source = eligible[index];
      try {
        const outcome = await collectSource(source, impl);
        results[index] = {
          sourceId: source.id,
          ok: true,
          notModified: Boolean(outcome.notModified),
          items: outcome.items,
          etag: outcome.etag,
          lastModified: outcome.lastModified,
          error: null
        };
      } catch (error) {
        results[index] = {
          sourceId: source.id,
          ok: false,
          notModified: false,
          items: [],
          etag: source.etag || null,
          lastModified: source.lastModified || null,
          error: error && error.message ? error.message : String(error)
        };
      }
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, eligible.length || 1));
  const workers = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, attempted: eligible.length };
}
