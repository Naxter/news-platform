import { readFile } from "node:fs/promises";
import path from "node:path";
import { sendText } from "./router.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

export async function serveStatic(pathname, res, publicDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, "Bad request");
  }
  if (decoded.includes("\0")) {
    return sendText(res, 400, "Bad request");
  }

  const safePath = decoded === "/" ? "/index.html" : decoded;
  const root = path.resolve(publicDir);
  const requested = path.resolve(root, `.${safePath}`);
  const relative = path.relative(root, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendText(res, 403, "Forbidden");
  }

  const extension = path.extname(requested).toLowerCase();
  const mime = MIME_TYPES[extension];
  if (!mime) {
    return sendText(res, 404, "Not found");
  }

  try {
    const data = await readFile(requested);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}
