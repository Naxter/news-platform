import { containsWord } from "../text.mjs";

const MAX_MATCHES_PER_LIST = 50;

export function matchWatchlists(watchlists, articles) {
  const matches = {};
  const lists = Array.isArray(watchlists) ? watchlists : [];
  const sorted = [...(Array.isArray(articles) ? articles : [])]
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));

  for (const list of lists) {
    if (!list || !list.id) {
      continue;
    }
    const keywords = (list.keywords || []).map((word) => String(word).trim()).filter(Boolean);
    const categories = (list.categories || []).filter(Boolean);
    const sources = (list.sources || []).filter(Boolean);
    const ids = [];

    for (const article of sorted) {
      if (ids.length >= MAX_MATCHES_PER_LIST) {
        break;
      }
      if (categories.length && !categories.includes(article.category)) {
        continue;
      }
      if (sources.length && !sources.includes(article.sourceName)) {
        continue;
      }
      if (keywords.length) {
        const haystack = `${article.title || ""} ${article.summary || ""} ${(article.keywords || []).join(" ")}`;
        if (!keywords.some((word) => containsWord(haystack, word))) {
          continue;
        }
      }
      ids.push(article.id);
    }

    matches[list.id] = ids;
  }

  return matches;
}
