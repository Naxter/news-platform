import { cleanText, decodeEntities, parseDateSafe, absolutizeUrl } from "../text.mjs";

function extractBlocks(text, tag) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...String(text || "").matchAll(expression)].map((match) => match[1]);
}

function getTag(text, tag) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = String(text || "").match(expression);
  return match ? match[1] : "";
}

function getAtomLink(text) {
  const match = String(text || "").match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? decodeEntities(match[1]) : "";
}

// Many minimal/podcast feeds omit <link> and carry the permalink in <guid>
// (canonically when isPermaLink="true", but also commonly regardless). Use it as a
// fallback so link-less items don't all collapse onto the feed URL and dedupe to one.
function getGuidLink(block) {
  const match = String(block || "").match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  if (!match) {
    return "";
  }
  const value = decodeEntities(cleanText(match[1]));
  return /^https?:\/\//i.test(value) ? value : "";
}

export function parseFeed(xml, source) {
  const itemBlocks = extractBlocks(xml, "item");
  const blocks = itemBlocks.length ? itemBlocks : extractBlocks(xml, "entry");

  return blocks.slice(0, 50).map((block) => {
    const title = cleanText(getTag(block, "title")) || "Untitled story";
    const link = cleanText(getTag(block, "link")) || getAtomLink(block) || getGuidLink(block) || source.url;
    const body = cleanText(
      getTag(block, "description") ||
      getTag(block, "summary") ||
      getTag(block, "content") ||
      getTag(block, "content:encoded")
    );
    const rawDate = getTag(block, "pubDate") ||
      getTag(block, "published") ||
      getTag(block, "updated") ||
      getTag(block, "dc:date");
    const publishedAt = parseDateSafe(cleanText(rawDate));
    return {
      title,
      url: absolutizeUrl(link, source.url),
      publishedAt,
      body
    };
  });
}
