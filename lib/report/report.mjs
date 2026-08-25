import { summarizeHealth } from "../analyze/health.mjs";

const FOCUS_LABELS = {
  executive: "Executive briefing",
  source: "Source coverage review",
  watchlist: "Watchlist risk monitor",
  opportunities: "Market opportunities"
};

const TEMPLATE_COUNTS = {
  brief: 4,
  standard: 8,
  detailed: 15
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trim()}...`;
}

function shortDate(iso) {
  const text = String(iso || "").slice(0, 10);
  return text || "undated";
}

function previousMonthKey(monthKey) {
  const parts = String(monthKey || "").split("-").map(Number);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return "";
  }
  const date = new Date(Date.UTC(parts[0], parts[1] - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function latestMonthKey(articles) {
  let latest = "";
  for (const article of articles) {
    if (article.monthKey && article.monthKey > latest) {
      latest = article.monthKey;
    }
  }
  return latest;
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

function aggregateEntities(articles) {
  const result = {};
  for (const bucket of ["people", "orgs", "places"]) {
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
    result[bucket] = [...counts.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5);
  }
  return result;
}

function risingKeywords(currentArticles, previousArticles, limit) {
  const current = countKeywords(currentArticles);
  const previous = countKeywords(previousArticles);
  return [...current.entries()]
    .filter(([, count]) => count >= 2)
    .map(([keyword, count]) => {
      const prior = previous.get(keyword) || 0;
      return { keyword, current: count, previous: prior, growth: count / Math.max(prior, 1) };
    })
    .sort((a, b) => b.growth - a.growth || b.current - a.current || a.keyword.localeCompare(b.keyword))
    .slice(0, limit);
}

function storyLine(article, template, { withSource = true } = {}) {
  const date = shortDate(article.publishedAt);
  const origin = withSource ? `${article.sourceName || "Unknown source"}, ` : "";
  const base = `${article.title || "Untitled"} (${origin}${date})`;
  if (template === "detailed") {
    const keywords = (article.keywords || []).slice(0, 6).join(", ");
    const summary = article.summary || "No summary available.";
    return `${base} — ${summary}${keywords ? ` Keywords: ${keywords}.` : ""}`;
  }
  const summary = truncateText(article.summary || "", template === "brief" ? 140 : 220);
  return summary ? `${base} — ${summary}` : base;
}

function entityItems(entities) {
  const items = [];
  const labels = [["People", "people"], ["Organizations", "orgs"], ["Places", "places"]];
  for (const [label, bucket] of labels) {
    const top = entities[bucket];
    if (top.length) {
      items.push(`${label}: ${top.map((entry) => `${entry.name} (${entry.count})`).join(", ")}`);
    }
  }
  return items;
}

function executiveSections(data) {
  const { sorted, count, template, categories, reportMonth, priorMonth, allArticles, monthLabel } = data;
  const sections = [];

  const leads = sorted.slice(0, 3).map((article) => article.summary).filter(Boolean);
  const overview = [
    `This executive briefing covers ${sorted.length} ${sorted.length === 1 ? "story" : "stories"} across ${categories.join(", ")} for ${monthLabel}.`,
    ...leads.map((lead) => truncateText(lead, 240))
  ].join(" ");
  sections.push({ heading: "Overview", blocks: [{ type: "p", text: overview }] });

  const developments = sorted.slice(0, count).map((article) => storyLine(article, template));
  sections.push({
    heading: "Key developments",
    blocks: [{ type: "ul", items: developments.length ? developments : ["No stories matched this selection."] }]
  });

  const momentum = categories.map((name) => {
    const current = allArticles.filter((a) => a.category === name && a.monthKey === reportMonth).length;
    const prior = priorMonth
      ? allArticles.filter((a) => a.category === name && a.monthKey === priorMonth).length
      : 0;
    const symbol = current > prior ? "▲" : current < prior ? "▼" : "=";
    return `${name}: ${current} this month vs ${prior} prior ${symbol}`;
  });
  sections.push({ heading: "Momentum", blocks: [{ type: "ul", items: momentum }] });

  const entities = aggregateEntities(sorted);
  const notable = entityItems(entities);
  sections.push({
    heading: "Notable entities",
    blocks: [{ type: "ul", items: notable.length ? notable : ["No entities extracted for this selection."] }]
  });

  const currentSet = allArticles.filter((a) => categories.includes(a.category) && a.monthKey === reportMonth);
  const priorSet = priorMonth
    ? allArticles.filter((a) => categories.includes(a.category) && a.monthKey === priorMonth)
    : [];
  const rising = risingKeywords(currentSet, priorSet, 5);
  const outlook = rising.length
    ? rising.map((entry) => `Watch "${entry.keyword}" — ${entry.current} mentions this month vs ${entry.previous} prior (${entry.growth.toFixed(1)}x).`)
    : ["No strong rising signals this period; coverage volume looks stable."];
  sections.push({ heading: "Outlook", blocks: [{ type: "ul", items: outlook }] });

  return sections;
}

function sourceSections(data) {
  const { sorted, count, template, sources } = data;
  const sections = [];

  const totals = new Map();
  for (const article of sorted) {
    const name = article.sourceName || "Unknown source";
    totals.set(name, (totals.get(name) || 0) + 1);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.length || 1;
  const rows = ranked.map(([name, n]) => [name, String(n), `${Math.round((n / total) * 100)}%`]);
  sections.push({
    heading: "Coverage share",
    blocks: [
      rows.length
        ? { type: "table", headers: ["Source", "Stories", "Share"], rows }
        : { type: "p", text: "No stories matched this selection." }
    ]
  });

  const activity = [];
  if (ranked.length) {
    const most = ranked[0];
    const least = ranked[ranked.length - 1];
    activity.push(`Most active: ${most[0]} with ${most[1]} ${most[1] === 1 ? "story" : "stories"}.`);
    activity.push(`Least active: ${least[0]} with ${least[1]} ${least[1] === 1 ? "story" : "stories"}.`);
  } else {
    activity.push("No source activity in this selection.");
  }
  sections.push({ heading: "Most and least active", blocks: [{ type: "ul", items: activity }] });

  const perSource = [];
  outer: for (const [name] of ranked) {
    const top = sorted.filter((article) => (article.sourceName || "Unknown source") === name).slice(0, 3);
    for (const article of top) {
      if (perSource.length >= count) {
        break outer;
      }
      perSource.push(`${name}: ${storyLine(article, template, { withSource: false })}`);
    }
  }
  sections.push({
    heading: "Top stories by source",
    blocks: [{ type: "ul", items: perSource.length ? perSource : ["No stories matched this selection."] }]
  });

  const exclusives = sorted
    .filter((article) => !article.clusterId)
    .slice(0, count)
    .map((article) => `${article.title || "Untitled"} — covered only by ${article.sourceName || "Unknown source"} (${shortDate(article.publishedAt)}).`);
  sections.push({
    heading: "Exclusives",
    blocks: [{ type: "ul", items: exclusives.length ? exclusives : ["No single-source exclusives in this selection."] }]
  });

  const healthNotes = (Array.isArray(sources) ? sources : []).map((source) => {
    const summary = summarizeHealth(source);
    const error = summary.lastError ? ` Last error: ${summary.lastError}.` : "";
    return `${source.name || source.id || "Unnamed source"}: ${summary.label} (${summary.successCount} ok / ${summary.failureCount} failed).${error}`;
  });
  sections.push({
    heading: "Source health notes",
    blocks: [{ type: "ul", items: healthNotes.length ? healthNotes : ["No sources configured."] }]
  });

  return sections;
}

function watchlistSections(data) {
  const { sorted, count, template } = data;
  const sections = [];
  const risk = sorted.filter((article) => article.sentiment === "watch");

  const byCategory = new Map();
  for (const article of risk) {
    const category = article.category || "Uncategorized";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
    }
    byCategory.get(category).push(article);
  }
  const riskItems = [];
  outer: for (const [category, list] of byCategory) {
    for (const article of list) {
      if (riskItems.length >= count) {
        break outer;
      }
      riskItems.push(`[${category}] ${storyLine(article, template)}`);
    }
  }
  sections.push({
    heading: "Risk items",
    blocks: [{ type: "ul", items: riskItems.length ? riskItems : ["No watch-sentiment stories in this selection."] }]
  });

  const escalation = risk
    .filter((article) => article.clusterId)
    .slice(0, count)
    .map((article) => `${article.title || "Untitled"} — multi-source coverage detected (cluster ${String(article.clusterId).slice(0, 12)}), published ${shortDate(article.publishedAt)}.`);
  sections.push({
    heading: "Escalation candidates",
    blocks: [{ type: "ul", items: escalation.length ? escalation : ["No multi-source risk stories detected."] }]
  });

  const entities = aggregateEntities(risk);
  const acrossRisk = entityItems(entities);
  sections.push({
    heading: "Entities across risk stories",
    blocks: [{ type: "ul", items: acrossRisk.length ? acrossRisk : ["No entities extracted from risk stories."] }]
  });

  const riskKeywordCounts = [...countKeywords(risk).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  const recommendations = riskKeywordCounts.length
    ? riskKeywordCounts.map(([keyword, n]) => `Track "${keyword}" — appeared in ${n} risk ${n === 1 ? "story" : "stories"}; consider a watchlist keyword.`)
    : ["No recurring risk keywords; maintain baseline monitoring."];
  sections.push({ heading: "Monitoring recommendations", blocks: [{ type: "ul", items: recommendations }] });

  return sections;
}

function renderMarkdown(title, metaLine, sections) {
  const lines = [`# ${title}`, "", `*${metaLine}*`, ""];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, "");
    for (const block of section.blocks) {
      if (block.type === "p") {
        lines.push(block.text, "");
      } else if (block.type === "ul") {
        for (const item of block.items) {
          lines.push(`- ${item}`);
        }
        lines.push("");
      } else if (block.type === "table") {
        lines.push(`| ${block.headers.join(" | ")} |`);
        lines.push(`| ${block.headers.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) {
          lines.push(`| ${row.join(" | ")} |`);
        }
        lines.push("");
      }
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderHtml(title, metaLine, sections) {
  const parts = [`<h1>${escapeHtml(title)}</h1>`, `<p class="report-meta">${escapeHtml(metaLine)}</p>`];
  for (const section of sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    for (const block of section.blocks) {
      if (block.type === "p") {
        parts.push(`<p>${escapeHtml(block.text)}</p>`);
      } else if (block.type === "ul") {
        const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        parts.push(`<ul>${items}</ul>`);
      } else if (block.type === "table") {
        const head = block.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
        const body = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
          .join("");
        parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      }
    }
  }
  return parts.join("\n");
}

function opportunitiesSections(data) {
  const { market, sorted, count } = data;
  const sections = [];
  const opportunities = (market && Array.isArray(market.opportunities)) ? market.opportunities : [];
  const contrarian = (market && Array.isArray(market.contrarian)) ? market.contrarian : [];
  const unscored = (market && Array.isArray(market.unscored)) ? market.unscored : [];

  const rows = opportunities.slice(0, count).map((opportunity) => [
    opportunity.ticker,
    String(opportunity.score),
    opportunity.quadrantLabel || "—",
    (opportunity.components || []).map((component) => component.explain).filter(Boolean).join(" · ") || "—"
  ]);
  sections.push({
    heading: "Scored opportunities",
    blocks: [
      rows.length
        ? { type: "table", headers: ["Ticker", "Score", "Setup", "Signals"], rows }
        : { type: "p", text: "No scored opportunities yet — signals need enough stories, a baseline, and price history per instrument." }
    ]
  });

  const articleById = new Map(sorted.map((article) => [article.id, article]));
  const evidence = [];
  for (const opportunity of opportunities.slice(0, Math.min(count, 5))) {
    for (const id of (opportunity.articleIds || []).slice(0, 3)) {
      const article = articleById.get(id);
      if (article) {
        evidence.push(`${opportunity.ticker}: ${article.title} (${article.sourceName})`);
      }
    }
  }
  sections.push({
    heading: "Evidence from the feeds",
    blocks: [{ type: "ul", items: evidence.length ? evidence : ["No linked stories in the report window."] }]
  });

  const risky = [
    ...opportunities.filter((opportunity) => (opportunity.flags || []).includes("risk-concentration")),
    ...contrarian
  ].map((opportunity) => `${opportunity.ticker} (${opportunity.score}) — ${opportunity.quadrantLabel || "risk stories dominate"}`);
  sections.push({
    heading: "Risk-flagged",
    blocks: [{ type: "ul", items: risky.length ? risky : ["No risk flags."] }]
  });

  const freshness = market && market.lastRefreshAt
    ? `Price data: Yahoo Finance (EOD/delayed), as of ${market.lastRefreshAt}. ${unscored.length} instruments under watch.`
    : "No price data fetched yet.";
  sections.push({
    heading: "Data status & note",
    blocks: [
      { type: "p", text: freshness },
      { type: "p", text: (market && market.disclaimer) || "Not investment advice, no recommendation." }
    ]
  });

  return sections;
}

export function buildReport({ categories, month, focus, template, articles, allArticles, sources, market }) {
  const categoryList = Array.isArray(categories) && categories.length ? categories.map(String) : ["All categories"];
  const focusKey = FOCUS_LABELS[focus] ? focus : "executive";
  const templateKey = TEMPLATE_COUNTS[template] ? template : "standard";
  const count = TEMPLATE_COUNTS[templateKey];
  const set = Array.isArray(articles) ? articles : [];
  const corpus = Array.isArray(allArticles) && allArticles.length ? allArticles : set;

  const sorted = [...set].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  const monthLabel = !month || month === "All" ? "All months" : month;
  const reportMonth = month && month !== "All" ? month : latestMonthKey(set.length ? set : corpus);
  const priorMonth = previousMonthKey(reportMonth);

  const sourceNames = new Set(set.map((article) => article.sourceName || "Unknown source"));
  const title = `${FOCUS_LABELS[focusKey]} — ${categoryList.join(", ")} — ${monthLabel}`;
  const metaLine = `${set.length} ${set.length === 1 ? "story" : "stories"} from ${sourceNames.size} ${sourceNames.size === 1 ? "source" : "sources"} · Focus: ${focusKey} · Template: ${templateKey} · Generated ${new Date().toISOString()}`;

  const data = {
    sorted,
    count,
    template: templateKey,
    categories: categoryList,
    reportMonth,
    priorMonth,
    allArticles: corpus,
    sources,
    monthLabel
  };

  let sections;
  if (focusKey === "source") {
    sections = sourceSections(data);
  } else if (focusKey === "watchlist") {
    sections = watchlistSections(data);
  } else if (focusKey === "opportunities") {
    sections = opportunitiesSections({ ...data, market });
  } else {
    sections = executiveSections(data);
  }

  return {
    title,
    markdown: renderMarkdown(title, metaLine, sections),
    html: renderHtml(title, metaLine, sections),
    meta: { storyCount: set.length, sources: sourceNames.size }
  };
}
