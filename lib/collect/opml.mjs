import { cleanText, decodeEntities, escapeXml, hostname } from "../text.mjs";

function getAttribute(tag, name) {
  const expression = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = tag.match(expression);
  return match ? match[1] : "";
}

export function parseOpml(xml) {
  const outlines = String(xml || "").matchAll(/<outline\b[^>]*>/gi);
  const sources = [];
  for (const match of outlines) {
    const tag = match[0];
    const rawUrl = getAttribute(tag, "xmlUrl");
    if (!rawUrl) continue;
    const url = decodeEntities(rawUrl).trim();
    if (!url) continue;
    const name = cleanText(decodeEntities(getAttribute(tag, "title") || getAttribute(tag, "text"))) || hostname(url);
    sources.push({ name, url, type: "auto" });
  }
  return sources;
}

export function buildOpml(sources) {
  const outlines = (sources || [])
    .filter((source) => /^https?:\/\//i.test(String(source.url || "")))
    .map((source) => {
      const name = escapeXml(source.name || hostname(source.url));
      const url = escapeXml(source.url);
      return `    <outline type="rss" text="${name}" title="${name}" xmlUrl="${url}" htmlUrl="${url}"/>`;
    });

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<opml version=\"2.0\">",
    "  <head>",
    "    <title>News Platform sources</title>",
    `    <dateCreated>${escapeXml(new Date().toUTCString())}</dateCreated>`,
    "  </head>",
    "  <body>",
    ...outlines,
    "  </body>",
    "</opml>",
    ""
  ].join("\n");
}
