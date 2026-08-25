// Morning Brief builder. Two paths share one article selection:
//   - aiMorningBrief() (lib/enrich/ai.mjs) writes curated prose when a key is present;
//   - buildBriefFallback() here produces a readable deterministic brief otherwise.
// The server persists whichever ran as store.brief and can push a short text form to ntfy.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max) {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

export function formatBriefDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// Pick the stories a morning brief should cover: recent, cluster-deduped, ranked by how much
// coverage and signal each carries. Falls back to the most-recent stories when the lookback
// window is too thin (quiet night, or the data itself is older than the window).
export function selectBriefArticles(articles, { lookbackHours = 24, maxStories = 10, nowMs = 0 } = {}) {
  const list = Array.isArray(articles) ? articles.filter((a) => a && a.title) : [];
  if (!list.length) {
    return [];
  }
  const now = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const cutoff = now - lookbackHours * 3_600_000;

  const timeOf = (article) => {
    const t = Date.parse(article.publishedAt);
    return Number.isFinite(t) ? t : 0;
  };

  let pool = list.filter((article) => timeOf(article) >= cutoff);
  let windowed = true;
  if (pool.length < 3) {
    // Not enough in the window — brief the freshest we have so the reader still gets something.
    pool = [...list].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, Math.max(maxStories * 2, 12));
    windowed = false;
  }

  // Collapse clusters to their most recent member, remembering coverage breadth.
  const byCluster = new Map();
  const singles = [];
  for (const article of pool) {
    if (article.clusterId) {
      const existing = byCluster.get(article.clusterId);
      if (!existing) {
        byCluster.set(article.clusterId, { primary: article, size: 1 });
      } else {
        existing.size += 1;
        if (timeOf(article) > timeOf(existing.primary)) {
          existing.primary = article;
        }
      }
    } else {
      singles.push({ primary: article, size: 1 });
    }
  }

  const groups = [...byCluster.values(), ...singles];
  const maxTime = Math.max(...groups.map((g) => timeOf(g.primary)), now);
  const minTime = Math.min(...groups.map((g) => timeOf(g.primary)), maxTime - 1);
  const span = Math.max(1, maxTime - minTime);

  const scoreOf = (group) => {
    const { primary, size } = group;
    let score = size; // coverage breadth = importance
    if (primary.sentiment === "watch") score += 1.5;
    else if (primary.sentiment === "positive") score += 0.5;
    if (primary.aiEnriched) score += 0.25;
    score += (timeOf(primary) - minTime) / span; // 0..1 recency nudge
    return score;
  };

  return groups
    .map((group) => ({ ...group, score: scoreOf(group), windowed }))
    .sort((a, b) => b.score - a.score || timeOf(b.primary) - timeOf(a.primary))
    .slice(0, maxStories);
}

// Compact per-article payload handed to the LLM — titles + summaries only (grounding), no ids.
export function briefArticlePayload(selected) {
  return selected.map((group, index) => ({
    n: index + 1,
    title: cleanText(group.primary.title),
    summary: truncate(group.primary.summary || "", 320),
    source: cleanText(group.primary.sourceName || "Unknown"),
    category: cleanText(group.primary.category || "—"),
    sentiment: group.primary.sentiment || "neutral",
    coverage: group.size
  }));
}

function isHttp(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function shortDate(iso) {
  return String(iso || "").slice(0, 10);
}

// Deterministic, readable brief used when no LLM key is set (or the call fails). Groups the
// selected stories by category and leads with any risk ("watch") items.
export function buildBriefFallback(selected, { generatedAt, windowHours = 24 } = {}) {
  const title = `Morning Brief — ${formatBriefDate(generatedAt) || shortDate(generatedAt)}`;

  if (!selected.length) {
    const empty = "No new stories in the selected window.";
    return {
      title,
      markdown: `# ${title}\n\n${empty}\n`,
      html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(empty)}</p>`,
      text: `${title}\n\n${empty}`,
      storyCount: 0
    };
  }

  const watch = selected.filter((g) => g.primary.sentiment === "watch");
  const rest = selected.filter((g) => g.primary.sentiment !== "watch");

  const byCategory = new Map();
  for (const group of rest) {
    const key = group.primary.category || "Other";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(group);
  }
  const orderedCategories = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);

  const windowed = selected[0] && selected[0].windowed;
  const lede = windowed
    ? `${selected.length} ${selected.length === 1 ? "story leads" : "stories lead"} the last ${windowHours} hours.`
    : `A quiet window — here are the ${selected.length} most recent stories.`;

  const md = [`# ${title}`, "", `*${lede}*`, ""];
  const html = [`<h1>${escapeHtml(title)}</h1>`, `<p class="brief-lede">${escapeHtml(lede)}</p>`];
  const textLines = [title, "", lede, ""];

  const renderGroup = (group) => {
    const a = group.primary;
    const meta = `${cleanText(a.sourceName || "Unknown")} · ${shortDate(a.publishedAt)}${group.size > 1 ? ` · +${group.size - 1} more` : ""}`;
    const summary = truncate(a.summary || "", 180);
    md.push(`- **${cleanText(a.title)}** — ${meta}${summary ? `. ${summary}` : ""}`);
    const titleHtml = isHttp(a.url)
      ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanText(a.title))}</a>`
      : escapeHtml(cleanText(a.title));
    html.push(`<li><strong>${titleHtml}</strong> <span class="brief-meta">${escapeHtml(meta)}</span>${summary ? `<br><span class="brief-summary">${escapeHtml(summary)}</span>` : ""}</li>`);
    textLines.push(`• ${truncate(a.title, 90)} (${cleanText(a.sourceName || "Unknown")})`);
  };

  if (watch.length) {
    md.push("## ⚠ Watch", "");
    html.push(`<h2>Watch</h2><ul class="brief-list">`);
    textLines.push("WATCH");
    watch.forEach(renderGroup);
    html.push("</ul>");
    md.push("");
  }

  for (const [category, groups] of orderedCategories) {
    md.push(`## ${category}`, "");
    html.push(`<h2>${escapeHtml(category)}</h2><ul class="brief-list">`);
    textLines.push("", category.toUpperCase());
    groups.forEach(renderGroup);
    html.push("</ul>");
    md.push("");
  }

  return {
    title,
    markdown: `${md.join("\n").trim()}\n`,
    html: html.join("\n"),
    text: textLines.join("\n").trim(),
    storyCount: selected.length
  };
}

// Minimal, safe Markdown -> HTML for LLM brief output. Escapes first, then applies a small
// whitelist (h1/h2/h3, -/* bullets, **bold**, paragraphs). No raw HTML from the model survives.
export function briefMarkdownToHtml(markdown) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const out = [];
  let listOpen = false;
  let paragraph = [];

  const inline = (text) =>
    escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        out.push(`<ul class="brief-list">`);
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return out.join("\n");
}

// Compact plain-text form (for ntfy phone push) derived from selected stories.
export function briefPushText(title, lede, selected, limit = 6) {
  const lines = [title, "", lede, ""];
  for (const group of selected.slice(0, limit)) {
    lines.push(`• ${truncate(group.primary.title, 90)} (${cleanText(group.primary.sourceName || "Unknown")})`);
  }
  if (selected.length > limit) {
    lines.push(`… +${selected.length - limit} more`);
  }
  return lines.join("\n").trim();
}
