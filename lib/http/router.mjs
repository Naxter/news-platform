import { Buffer } from "node:buffer";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export async function readJson(req, maxBytes = 10_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON payload");
  }
}

function compilePattern(pattern) {
  const names = [];
  const parts = pattern.split("/").map((segment) => {
    if (segment.startsWith(":") && segment.length > 1) {
      names.push(segment.slice(1));
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp(`^${parts.join("/")}$`), names };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createRouter() {
  const routes = [];

  return {
    add(method, pattern, handler) {
      const { regex, names } = compilePattern(pattern);
      routes.push({ method: method.toUpperCase(), regex, names, handler });
    },

    async dispatch(req, res, url) {
      for (const route of routes) {
        if (route.method !== req.method) {
          continue;
        }
        const match = url.pathname.match(route.regex);
        if (!match) {
          continue;
        }
        const params = {};
        route.names.forEach((name, index) => {
          params[name] = safeDecode(match[index + 1]);
        });
        await route.handler(req, res, { params, url });
        return true;
      }
      return false;
    }
  };
}
