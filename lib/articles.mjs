function articleKey(article) {
  const url = String(article.url || "").toLowerCase();
  return url.startsWith("http") ? url : article.id;
}

export function mergeArticles(existing, incoming, maxArticles = 2000) {
  const map = new Map();
  for (const article of Array.isArray(existing) ? existing : []) {
    map.set(articleKey(article), article);
  }
  let added = 0;
  for (const article of Array.isArray(incoming) ? incoming : []) {
    const key = articleKey(article);
    if (!map.has(key)) {
      map.set(key, article);
      added += 1;
    }
  }
  const cap = Number.isInteger(maxArticles) && maxArticles > 0 ? maxArticles : 2000;
  const articles = [...map.values()]
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .slice(0, cap);
  return { articles, added };
}
