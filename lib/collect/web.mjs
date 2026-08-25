import { cleanText, decodeEntities, parseDateSafe, absolutizeUrl } from "../text.mjs";

function getTag(text, tag) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = String(text || "").match(expression);
  return match ? match[1] : "";
}

function getMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) return match[1];
  }
  return "";
}

function looksLikeNewsLink(url, text) {
  if (/privacy|terms|signin|login|subscribe|account|newsletter|contact/i.test(url)) return false;
  if (text.split(/\s+/).length < 4) return false;
  return /\/(20\d{2}|news|article|story|world|business|tech|science|health|sports|culture)\b/i.test(url) || text.length > 45;
}

export function extractPublishedDate(html) {
  const source = String(html || "");

  const ldBlocks = source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of ldBlocks) {
    const match = block[1].match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (match) {
      const iso = parseDateSafe(decodeEntities(match[1]));
      if (iso) return iso;
    }
  }

  const meta = getMeta(source, "article:published_time");
  if (meta) {
    const iso = parseDateSafe(decodeEntities(meta));
    if (iso) return iso;
  }

  const time = source.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (time) {
    const iso = parseDateSafe(decodeEntities(time[1]));
    if (iso) return iso;
  }

  return null;
}

export function parseNewsPage(html, source) {
  const raw = String(html || "");
  const pageTitle = cleanText(getTag(raw, "title")) || source.name;
  const metaDescription = cleanText(getMeta(raw, "description") || getMeta(raw, "og:description"));
  const publishedAt = extractPublishedDate(raw);

  const anchors = [...raw.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      href: absolutizeUrl(decodeEntities(match[1]), source.url),
      text: cleanText(match[2])
    }))
    .filter((link) => link.href &&
      /^https?:\/\//i.test(link.href) &&
      link.text.length >= 24 &&
      looksLikeNewsLink(link.href, link.text))
    .slice(0, 40);

  if (!anchors.length) {
    return [{
      title: pageTitle,
      url: source.url,
      publishedAt,
      body: metaDescription || pageTitle
    }];
  }

  return anchors.map((link) => ({
    title: link.text,
    url: link.href,
    publishedAt,
    body: metaDescription || `${link.text}. Found on ${pageTitle}.`
  }));
}
