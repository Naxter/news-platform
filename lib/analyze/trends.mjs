const SENTIMENTS = ["positive", "neutral", "watch"];
const ENTITY_BUCKETS = ["people", "orgs", "places"];

function previousMonthKey(monthKey) {
  const parts = String(monthKey || "").split("-").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return "";
  }
  const date = new Date(Date.UTC(parts[0], parts[1] - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function countKeywords(articles) {
  const counts = new Map();
  for (const article of articles) {
    for (const keyword of article.keywords || []) {
      const key = String(keyword).toLowerCase().trim();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function topEntitiesFor(articles, bucket, limit) {
  const counts = new Map();
  for (const article of articles) {
    const names = (article.entities && article.entities[bucket]) || [];
    for (const rawName of names) {
      const name = String(rawName).trim();
      if (!name) {
        continue;
      }
      const key = name.toLowerCase();
      const entry = counts.get(key) || { name, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function computeTrends(articles, categoryNames) {
  const list = Array.isArray(articles) ? articles : [];
  const names = Array.isArray(categoryNames) ? categoryNames : [];

  const byMonthMap = new Map();
  for (const article of list) {
    const month = article.monthKey || "";
    if (!month) {
      continue;
    }
    if (!byMonthMap.has(month)) {
      byMonthMap.set(month, {
        month,
        total: 0,
        byCategory: Object.fromEntries(names.map((name) => [name, 0])),
        sentiment: { positive: 0, neutral: 0, watch: 0 }
      });
    }
    const bucket = byMonthMap.get(month);
    bucket.total += 1;
    const category = article.category || "Uncategorized";
    bucket.byCategory[category] = (bucket.byCategory[category] || 0) + 1;
    const sentiment = SENTIMENTS.includes(article.sentiment) ? article.sentiment : "neutral";
    bucket.sentiment[sentiment] += 1;
  }

  const months = [...byMonthMap.keys()].sort();
  const byMonth = months.slice(-12).map((month) => byMonthMap.get(month));

  const latestMonth = months[months.length - 1] || "";
  const priorMonth = previousMonthKey(latestMonth);
  const latestArticles = latestMonth ? list.filter((article) => article.monthKey === latestMonth) : [];
  const priorArticles = priorMonth ? list.filter((article) => article.monthKey === priorMonth) : [];

  const currentCounts = countKeywords(latestArticles);
  const previousCounts = countKeywords(priorArticles);
  const risingKeywords = [...currentCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([keyword, current]) => {
      const previous = previousCounts.get(keyword) || 0;
      return { keyword, current, previous, growth: current / Math.max(previous, 1) };
    })
    .sort((a, b) => b.growth - a.growth || b.current - a.current || a.keyword.localeCompare(b.keyword))
    .slice(0, 10);

  const topEntities = {};
  for (const bucket of ENTITY_BUCKETS) {
    topEntities[bucket] = topEntitiesFor(latestArticles, bucket, 5);
  }

  return { byMonth, risingKeywords, topEntities };
}
