const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000;
const COMPARE_WINDOW = 200;
const JACCARD_THRESHOLD = 0.5;

function titleTokens(title, stopWords) {
  const words = String(title || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || [];
  const tokens = new Set();
  for (const word of words) {
    if (!stopWords.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

function jaccard(a, b) {
  if (!a.size || !b.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export function assignClusters(articles, stopWords) {
  if (!Array.isArray(articles) || !articles.length) {
    return articles || [];
  }
  const stop = stopWords instanceof Set ? stopWords : new Set(stopWords || []);

  const entries = articles
    .map((article) => ({
      article,
      time: Date.parse(article.publishedAt) || 0,
      tokens: titleTokens(article.title, stop)
    }))
    .sort((a, b) => a.time - b.time);

  const parent = entries.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  for (let i = 1; i < entries.length; i += 1) {
    const start = Math.max(0, i - COMPARE_WINDOW);
    for (let j = start; j < i; j += 1) {
      if (entries[i].time - entries[j].time > CLUSTER_WINDOW_MS) {
        continue;
      }
      if (jaccard(entries[i].tokens, entries[j].tokens) >= JACCARD_THRESHOLD) {
        union(j, i);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(i);
  }

  for (const members of groups.values()) {
    if (members.length > 1) {
      const clusterId = entries[members[0]].article.id;
      for (const member of members) {
        entries[member].article.clusterId = clusterId;
      }
    } else {
      entries[members[0]].article.clusterId = null;
    }
  }

  return articles;
}
