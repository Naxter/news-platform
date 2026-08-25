import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_HEADERS = {
  "user-agent": "NewsPlatform/2.0 (local news intelligence)",
  "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.7"
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isPrivateIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  const [a, b, c, d] = octets;
  if (a === 0) return true;                      // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return true;                     // 10.0.0.0/8 private
  if (a === 127) return true;                    // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;       // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;       // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  return false;
}

function expandIPv6(value) {
  let v = value;
  const dottedTail = v.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedTail) {
    const parts = dottedTail[2].split(".").map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    v = `${dottedTail[1]}${(((parts[0] << 8) | parts[1]) >>> 0).toString(16)}:${(((parts[2] << 8) | parts[3]) >>> 0).toString(16)}`;
  }
  if (v.includes("::")) {
    const sides = v.split("::");
    if (sides.length > 2) return null;
    const head = sides[0] ? sides[0].split(":") : [];
    const tail = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    v = [...head, ...new Array(missing).fill("0"), ...tail].join(":");
  }
  const groups = v.split(":");
  if (groups.length !== 8) return null;
  const numbers = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    numbers.push(parseInt(group, 16));
  }
  return numbers;
}

function isPrivateIPv6(value) {
  const groups = expandIPv6(value);
  if (!groups) return false;
  const leadingZero = groups.slice(0, 5).every((n) => n === 0);
  if (leadingZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
    return true;                                   // :: unspecified, ::1 loopback
  }
  if (leadingZero && (groups[5] === 0xffff || groups[5] === 0)) {
    // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (v4-compatible) -> check as IPv4
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    if (groups[5] === 0xffff) return isPrivateIPv4(v4);
    if (groups[6] !== 0 || groups[7] > 1) return isPrivateIPv4(v4);
    return false;
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true;    // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;    // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true;    // fec0::/10 deprecated site-local
  return false;
}

export function isPrivateAddress(ip) {
  let value = String(ip || "").trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  if (value.includes(":")) return isPrivateIPv6(value);
  return isPrivateIPv4(value);
}

export function assertPublicHttpUrl(urlString) {
  const raw = String(urlString || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, "Please provide a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Only http and https URLs are allowed.");
  }
  const host = normalizeHost(url.hostname);
  if (!host) {
    throw httpError(400, "URL is missing a hostname.");
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw httpError(400, "Refusing to fetch localhost.");
  }
  if (net.isIP(host) !== 0 && isPrivateAddress(host)) {
    throw httpError(400, `Refusing to fetch private address ${host}.`);
  }
  return url;
}

function assertHttpProtocol(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Only http and https URLs are allowed.");
  }
}

// A custom DNS resolver used for the actual socket connection. It resolves the host,
// rejects if ANY address is private (unless allowPrivate), and hands the connector the
// SAME address it validated. Because validation and connection share one resolution,
// there is no window for a rebinding attacker to swap a public answer for a private one.
function makePinnedLookup(allowPrivate) {
  return function pinnedLookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof options === "function") {
      cb = options;
      opts = {};
    }
    dnsLookup(hostname, { all: true, verbatim: true })
      .then((records) => {
        if (!records || !records.length) {
          cb(new Error(`DNS lookup returned no addresses for ${hostname}.`));
          return;
        }
        if (!allowPrivate) {
          for (const record of records) {
            if (isPrivateAddress(record.address)) {
              cb(httpError(400, `Refusing to fetch ${hostname}: resolves to private address ${record.address}.`));
              return;
            }
          }
        }
        const family = opts && opts.family ? Number(opts.family) : 0;
        let chosen = records;
        if (family === 4) {
          chosen = records.filter((record) => record.family === 4);
        } else if (family === 6) {
          chosen = records.filter((record) => record.family === 6);
        }
        if (!chosen.length) {
          chosen = records;
        }
        if (opts && opts.all) {
          cb(null, chosen.map((record) => ({ address: record.address, family: record.family })));
        } else {
          cb(null, chosen[0].address, chosen[0].family);
        }
      })
      .catch((error) => cb(error));
  };
}

function normalizeRequestError(error, url, timeoutMs) {
  if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error(`Request to ${url.hostname} timed out after ${timeoutMs}ms.`);
  }
  if (error && error.message === "Response too large") {
    return error;
  }
  if (error && Number.isInteger(error.status)) {
    return error;
  }
  const detail = error && error.message ? error.message : String(error);
  return new Error(`Request to ${url.hostname} failed: ${detail}`);
}

function requestOnce(url, { method, headers, signal, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = mod.request(url, { method, headers, signal, lookup }, (res) => {
      const status = res.statusCode || 0;
      if (REDIRECT_STATUSES.has(status)) {
        res.resume();
        finish(resolve, { status, headers: res.headers, location: res.headers.location || "", text: "" });
        return;
      }
      if (status === 304) {
        res.resume();
        finish(resolve, { status, headers: res.headers, text: "" });
        return;
      }
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        finish(resolve, { status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (error) => finish(reject, error));
    });
    req.on("error", (error) => finish(reject, error));
    req.end();
  });
}

function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, String(item));
      }
    } else if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

export async function safeFetch(urlString, { timeoutMs = 15000, maxBytes = 5_000_000,
  headers = {}, method = "GET", allowPrivate = false } = {}) {
  let url;
  if (allowPrivate) {
    try {
      url = new URL(String(urlString || "").trim());
    } catch {
      throw httpError(400, "Please provide a valid URL.");
    }
    assertHttpProtocol(url);
  } else {
    url = assertPublicHttpUrl(urlString);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const requestHeaders = {};
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
    requestHeaders[key] = value;
  }
  for (const [key, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) {
      requestHeaders[key.toLowerCase()] = String(value);
    }
  }
  const lookup = makePinnedLookup(allowPrivate);

  let currentMethod = method;
  for (let redirects = 0; ; redirects++) {
    let result;
    try {
      result = await requestOnce(url, { method: currentMethod, headers: requestHeaders, signal, maxBytes, lookup });
    } catch (error) {
      throw normalizeRequestError(error, url, timeoutMs);
    }

    if (REDIRECT_STATUSES.has(result.status)) {
      if (!result.location) {
        throw new Error(`Redirect from ${url.hostname} had no Location header.`);
      }
      if (redirects >= 5) {
        throw new Error("Too many redirects (limit is 5).");
      }
      let next;
      try {
        next = new URL(result.location, url);
      } catch {
        throw new Error(`Redirect pointed to an invalid URL: ${result.location}`);
      }
      if (allowPrivate) {
        assertHttpProtocol(next);
      } else {
        assertPublicHttpUrl(next.toString());
      }
      if (result.status === 303) {
        currentMethod = "GET";
      }
      url = next;
      continue;
    }

    const responseHeaders = toHeaders(result.headers);
    const ok = result.status >= 200 && result.status < 300;
    return { ok, status: result.status, headers: responseHeaders, text: result.text || "", finalUrl: url.toString() };
  }
}
