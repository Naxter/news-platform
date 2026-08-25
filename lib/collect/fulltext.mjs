import { cleanText } from "../text.mjs";
import { safeFetch } from "./fetchGuard.mjs";

const MAX_TEXT_CHARS = 20_000;
const MIN_TEXT_CHARS = 200;
const MIN_PARAGRAPH_CHARS = 120;

function getTag(text, tag) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = String(text || "").match(expression);
  return match ? match[1] : "";
}

function extractBlocks(text, tag) {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...String(text || "").matchAll(expression)].map((match) => match[1]);
}

function stripChrome(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ");
}

function longParagraphs(html) {
  return extractBlocks(html, "p")
    .map((block) => cleanText(block))
    .filter((text) => text.length >= MIN_PARAGRAPH_CHARS)
    .join(" ");
}

export async function fetchFullText(url, fetchImpl = safeFetch) {
  const response = await fetchImpl(url, {
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
  });
  if (!response.ok) {
    throw new Error(`Fetch failed with ${response.status}`);
  }

  const html = response.text || "";
  const title = cleanText(getTag(html, "title"));
  const stripped = stripChrome(html);

  const candidates = [
    extractBlocks(stripped, "article").map((block) => cleanText(block)).join(" ").trim(),
    cleanText(getTag(stripped, "main")),
    longParagraphs(stripped)
  ];

  let text = "";
  for (const candidate of candidates) {
    if (candidate && candidate.length >= MIN_TEXT_CHARS) {
      text = candidate;
      break;
    }
    if (candidate && candidate.length > text.length) {
      text = candidate;
    }
  }

  text = text.slice(0, MAX_TEXT_CHARS).trim();
  if (text.length < MIN_TEXT_CHARS) {
    throw new Error("Could not extract substantial article text from the page.");
  }

  return { title, text };
}
