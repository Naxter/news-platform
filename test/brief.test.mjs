import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectBriefArticles,
  buildBriefFallback,
  briefMarkdownToHtml,
  briefArticlePayload
} from "../lib/report/brief.mjs";

const NOW = Date.parse("2026-07-05T08:00:00.000Z");

function article(id, overrides = {}) {
  return {
    id,
    title: `Story ${id}`,
    summary: `Summary for ${id}.`,
    sourceName: "Test Source",
    category: "Business",
    sentiment: "neutral",
    publishedAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides
  };
}

test("selectBriefArticles keeps only stories inside the lookback window", () => {
  const fresh = article("fresh", { publishedAt: new Date(NOW - 2 * 3_600_000).toISOString() });
  const stale = article("stale", { publishedAt: new Date(NOW - 50 * 3_600_000).toISOString() });
  const alsoFresh = article("fresh2", { publishedAt: new Date(NOW - 5 * 3_600_000).toISOString() });
  const third = article("fresh3", { publishedAt: new Date(NOW - 1 * 3_600_000).toISOString() });

  const selected = selectBriefArticles([fresh, stale, alsoFresh, third], {
    lookbackHours: 24,
    maxStories: 10,
    nowMs: NOW
  });
  const ids = selected.map((group) => group.primary.id);
  assert.ok(!ids.includes("stale"), "stories older than the window are excluded");
  assert.equal(ids.length, 3);
});

test("selectBriefArticles falls back to most-recent when the window is too thin", () => {
  const old = [1, 2, 3, 4].map((n) =>
    article(`o${n}`, { publishedAt: new Date(NOW - (100 + n) * 3_600_000).toISOString() }));
  const selected = selectBriefArticles(old, { lookbackHours: 24, maxStories: 10, nowMs: NOW });
  assert.equal(selected.length, 4, "produces a brief even when nothing is in the window");
  assert.equal(selected[0].windowed, false);
});

test("selectBriefArticles dedupes clusters and ranks coverage + watch higher", () => {
  const items = [
    article("a", { clusterId: "c1" }),
    article("b", { clusterId: "c1" }),
    article("c", { clusterId: "c1" }),
    article("risk", { sentiment: "watch" }),
    article("solo")
  ];
  const selected = selectBriefArticles(items, { lookbackHours: 24, maxStories: 10, nowMs: NOW });
  const ids = selected.map((g) => g.primary.id);
  // cluster c1 collapses to one entry
  assert.equal(ids.filter((id) => ["a", "b", "c"].includes(id)).length, 1);
  const cluster = selected.find((g) => g.primary.clusterId === "c1");
  assert.equal(cluster.size, 3, "coverage breadth is counted");
  // The 3x-covered cluster outranks the solo neutral story.
  assert.ok(selected.indexOf(cluster) < ids.indexOf("solo"));
});

test("buildBriefFallback separates watch items and renders all formats", () => {
  const selected = selectBriefArticles([
    article("risk", { sentiment: "watch", title: "Risky thing" }),
    article("norm", { title: "Normal thing" })
  ], { lookbackHours: 24, maxStories: 10, nowMs: NOW });

  const brief = buildBriefFallback(selected, { generatedAt: new Date(NOW).toISOString(), windowHours: 24 });
  assert.match(brief.title, /Morning Brief/);
  assert.match(brief.html, /Watch/);
  assert.match(brief.markdown, /Risky thing/);
  assert.ok(brief.text.includes("Risky thing"));
  assert.equal(brief.storyCount, 2);
});

test("buildBriefFallback handles an empty selection", () => {
  const brief = buildBriefFallback([], { generatedAt: new Date(NOW).toISOString(), windowHours: 24 });
  assert.equal(brief.storyCount, 0);
  assert.match(brief.html, /No new stories/);
});

test("briefMarkdownToHtml escapes HTML and applies the whitelist", () => {
  const html = briefMarkdownToHtml("## Theme <script>\n- **Bold** item & stuff\n\nA paragraph.");
  assert.match(html, /<h2>Theme &lt;script&gt;<\/h2>/);
  assert.match(html, /<li><strong>Bold<\/strong> item &amp; stuff<\/li>/);
  assert.match(html, /<p>A paragraph\.<\/p>/);
  assert.ok(!html.includes("<script>"), "raw HTML from the model never survives");
});

test("briefArticlePayload strips ids and carries grounding fields", () => {
  const selected = selectBriefArticles([article("x", { coverage: 2 })], {
    lookbackHours: 24, maxStories: 5, nowMs: NOW
  });
  const payload = briefArticlePayload(selected);
  assert.equal(payload[0].n, 1);
  assert.equal(payload[0].title, "Story x");
  assert.ok(!("id" in payload[0]), "article ids are not sent to the LLM");
});
