import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HttpError, sendJson, readJson, createRouter } from "./lib/http/router.mjs";
import { serveStatic } from "./lib/http/static.mjs";
import { STOP_WORDS, validateConfigPatch } from "./lib/config.mjs";
import { Store } from "./lib/store/store.mjs";
import { migrate } from "./lib/store/migrations.mjs";
import { cleanText, hashId, hostname, parseDateSafe, toMonthKey, stripBoilerplate } from "./lib/text.mjs";
import { categorize, extractKeywords, scoreSentiment, extractEntities, enrichArticle } from "./lib/enrich/heuristics.mjs";
import { aiAvailable, aiEnrich, aiReportNarrative, aiMorningBrief, briefAiAvailable } from "./lib/enrich/ai.mjs";
import { mergeArticles } from "./lib/articles.mjs";
import { seedStore } from "./lib/seed.mjs";
import { assertPublicHttpUrl } from "./lib/collect/fetchGuard.mjs";
import { parseOpml, buildOpml } from "./lib/collect/opml.mjs";
import { fetchFullText } from "./lib/collect/fulltext.mjs";
import { collectAll } from "./lib/collect/index.mjs";
import { assignClusters } from "./lib/analyze/cluster.mjs";
import { applyCollectResult } from "./lib/analyze/health.mjs";
import { MARKET_DISCLAIMER, decorateState } from "./lib/analyze/decorate.mjs";
import { buildReport } from "./lib/report/report.mjs";
import {
  selectBriefArticles,
  briefArticlePayload,
  buildBriefFallback,
  briefMarkdownToHtml,
  briefPushText,
  formatBriefDate
} from "./lib/report/brief.mjs";
import {
  YAHOO_USER_AGENT,
  assertMarketHost,
  benchmarksFor,
  fetchChart,
  paceMarketFetch,
  probeSymbol,
  refreshPrices
} from "./lib/market/prices.mjs";
import { defaultAliases, normalizeTicker, validateInstrumentPatch } from "./lib/market/instruments.mjs";
import { computeSignals, reviewSignalLog, updateSignalLog } from "./lib/market/signals.mjs";
import { normalizeName, resolveEntity, revalidationQueue, suggestCandidates } from "./lib/market/mapping.mjs";
import { SEED_MAP } from "./lib/market/seedMap.mjs";
import {
  aiOpportunityNarrative,
  aiResolveEntities,
  narrativeHash,
  narrativeViolates
} from "./lib/market/ai.mjs";
import { explainComponent, quadrantLabel } from "./lib/market/format.mjs";
import { safeFetch } from "./lib/collect/fetchGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

function nowIso() {
  return new Date().toISOString();
}

function emptyHealth() {
  return {
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatus: null
  };
}

function articleKey(article) {
  return article.url && /^https?:/i.test(article.url) ? article.url.toLowerCase() : article.id;
}

function trimArticle(article) {
  return {
    id: article.id,
    title: article.title,
    url: article.url,
    category: article.category,
    summary: article.summary,
    sentiment: article.sentiment,
    keywords: article.keywords,
    publishedAt: article.publishedAt,
    sourceName: article.sourceName
  };
}

function toStringList(value) {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => cleanText(String(item ?? ""))).filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokensEqual(candidate, expected) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function assertPublicOrHttpError(url) {
  try {
    assertPublicHttpUrl(url);
  } catch (error) {
    throw new HttpError(Number(error && error.status) || 400, error.message);
  }
}

function newSource({ name, url, type }) {
  return {
    id: `src-${hashId(`${url}:${Date.now()}:${Math.random()}`).slice(0, 12)}`,
    name: cleanText(String(name || "")) || hostname(url),
    url,
    type: ["rss", "web", "auto", "manual"].includes(type) ? type : "auto",
    createdAt: nowIso(),
    paused: false,
    etag: null,
    lastModified: null,
    health: emptyHealth()
  };
}

export function createApp({
  dataDir = path.join(__dirname, "data"),
  quiet = false,
  marketFetchImpl = safeFetch,
  marketThrottleMs = 1000
} = {}) {
  const storePath = path.join(dataDir, "news-platform.json");
  const store = new Store(storePath, { seedFn: seedStore });
  const router = createRouter();
  let schedulerTimer = null;
  let briefTimer = null;
  let collecting = false;

  // Market refresh state (per app instance): the in-flight flag, the abort handle used by
  // stop(), the fire-and-forget promise stop() awaits, and the decorate cache keyed on
  // store.rev (SPEC §9.3) — closure-scoped so parallel test apps can never cross-serve.
  let marketRefreshing = false;
  let marketAbort = null;
  let marketRefreshPromise = null;
  const marketMemo = { rev: -1, value: null };

  function decorate(state) {
    return decorateState(state, { marketRefreshing, marketCache: marketMemo });
  }

  function warn(message) {
    if (!quiet) {
      console.warn(message);
    }
  }

  // ntfy-format hooks receive a plain-text body + X-Title header (exactly what an ntfy topic
  // renders as a phone push); json hooks get the structured payload. Events without ntfy
  // rendering (collect/refresh ticks — pushes for those would be spam) go to json hooks only.
  function dispatchWebhooks(webhooks, payload, { ntfy } = {}) {
    for (const hook of Array.isArray(webhooks) ? webhooks : []) {
      const url = hook && typeof hook.url === "string" ? hook.url : "";
      if (!/^https?:\/\//i.test(url)) {
        continue;
      }
      const isNtfy = hook.format === "ntfy";
      if (isNtfy && !ntfy) {
        continue;
      }
      const request = isNtfy
        ? {
            method: "POST",
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-title": ntfy.title,
              ...(ntfy.tags ? { "x-tags": ntfy.tags } : {})
            },
            body: ntfy.text
          }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          };
      fetch(url, { ...request, signal: AbortSignal.timeout(10_000) }).then((response) => {
        if (!response.ok) {
          warn(`Webhook ${url} responded with ${response.status}`);
        }
        return response.arrayBuffer().catch(() => null);
      }).catch((error) => {
        warn(`Webhook ${url} failed: ${error.message}`);
      });
    }
  }

  async function runCollect() {
    collecting = true;
    const startedAt = Date.now();
    try {
      const snapshot = await store.read();
      const sources = structuredClone(snapshot.sources);
      const config = { categories: snapshot.categories, sentiment: snapshot.sentiment, stopWords: STOP_WORDS };
      const settings = snapshot.settings;

      const { results, attempted } = await collectAll(sources);

      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const incoming = [];
      // Keep the raw article body keyed by id so AI enrichment sees the full text,
      // not the 230-char heuristic summary. Bodies are NOT persisted to the store.
      const bodyById = new Map();
      for (const result of results) {
        if (!result.ok || result.notModified || !Array.isArray(result.items)) {
          continue;
        }
        const source = sourceById.get(result.sourceId);
        if (!source) {
          continue;
        }
        for (const raw of result.items) {
          try {
            const article = enrichArticle(raw, source, config);
            incoming.push(article);
            const rawBody = cleanText(String(raw.body || ""));
            if (rawBody) {
              bodyById.set(article.id, rawBody);
            }
          } catch (error) {
            warn(`Skipped an item from ${source.name}: ${error.message}`);
          }
        }
      }

      const existingKeys = new Set(snapshot.articles.map(articleKey));
      const seen = new Set();
      const fresh = [];
      for (const article of incoming) {
        const key = articleKey(article);
        if (existingKeys.has(key) || seen.has(key)) {
          continue;
        }
        seen.add(key);
        fresh.push(article);
      }
      fresh.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      let aiEnrichedCount = 0;
      if (fresh.length && aiAvailable(settings)) {
        const batchSize = Math.max(1, Number(settings.ai.maxArticlesPerCollect) || 30);
        const batch = fresh.slice(0, batchSize);
        const aiInput = batch.map((article) => ({
          id: article.id,
          title: article.title,
          body: bodyById.get(article.id) || article.summary || ""
        }));
        try {
          const enrichments = await aiEnrich(aiInput, settings, config);
          for (const article of batch) {
            const hit = enrichments && typeof enrichments.get === "function" ? enrichments.get(article.id) : null;
            if (!hit) {
              continue;
            }
            if (typeof hit.category === "string" && hit.category) {
              article.category = hit.category;
            }
            if (typeof hit.summary === "string" && hit.summary) {
              article.summary = hit.summary;
            }
            if (["positive", "neutral", "watch"].includes(hit.sentiment)) {
              article.sentiment = hit.sentiment;
            }
            if (Array.isArray(hit.keywords) && hit.keywords.length) {
              article.keywords = hit.keywords;
            }
            if (hit.entities && typeof hit.entities === "object") {
              article.entities = hit.entities;
            }
            article.aiEnriched = true;
            aiEnrichedCount += 1;
          }
        } catch (error) {
          warn(`AI enrichment failed: ${error.message}`);
        }
      }

      const failures = results
        .filter((result) => !result.ok)
        .map((result) => ({
          sourceId: result.sourceId,
          name: (sourceById.get(result.sourceId) || {}).name || result.sourceId,
          message: String(result.error || "Unknown error")
        }));

      let collection = null;
      const state = await store.update((current) => {
        const merged = mergeArticles(current.articles, incoming, current.settings.maxArticles);
        current.articles = merged.articles;
        assignClusters(current.articles, STOP_WORDS);
        for (const result of results) {
          const target = current.sources.find((source) => source.id === result.sourceId);
          if (target) {
            applyCollectResult(target, result);
          }
        }
        collection = {
          at: nowIso(),
          added: merged.added,
          attempted,
          durationMs: Date.now() - startedAt,
          failures,
          aiEnriched: aiEnrichedCount
        };
        current.collections.unshift(collection);
        if (current.collections.length > 20) {
          current.collections.length = 20;
        }
        current.lastCollectedAt = collection.at;
      });

      dispatchWebhooks(state.settings.webhooks, {
        event: "collection.completed",
        at: collection.at,
        added: collection.added,
        failures,
        articles: fresh.slice(0, 20).map(trimArticle)
      });

      return { state, collection };
    } finally {
      collecting = false;
      // Price refresh piggybacks on collect ticks — from the finally so a failed collect
      // still refreshes prices. Fire-and-forget: the collect response never waits on it.
      maybeRefreshMarket();
    }
  }

  // Applies a refreshPrices result inside ONE store.update, honoring the caller contract:
  // series for instruments deleted mid-refresh are dropped, failures mark existing series
  // stale (stale-not-empty), the log is capped, and orphaned series are pruned.
  async function applyMarketRefresh(result, revalidations = [], aiMappings = []) {
    // Edge-triggered alerts with hysteresis: fire only on an upward crossing of minScore,
    // stay silent while above, re-arm below minScore - 5 (no flapping). Collected inside the
    // mutator (where alertState lives), dispatched by the caller after the write.
    const firedAlerts = [];
    const state = await store.update((current) => {
      for (const revalidation of revalidations) {
        if (revalidation.kind === "instrument") {
          const instrument = current.market.instruments.find((entry) => entry.ticker === revalidation.key);
          if (instrument) {
            instrument.validatedAt = revalidation.at;
            instrument.staleSymbol = !revalidation.ok;
          }
        } else {
          const mapping = current.market.mappings[revalidation.key];
          if (mapping) {
            mapping.validatedAt = revalidation.at;
            if (!revalidation.ok) {
              mapping.status = "unresolved";
            }
          }
        }
      }
      const validSymbols = new Set([
        ...current.market.instruments.map((instrument) => instrument.ticker),
        ...benchmarksFor(current.settings).map((benchmark) => benchmark.symbol)
      ]);
      for (const [symbol, series] of Object.entries(result.prices)) {
        if (validSymbols.has(symbol)) {
          current.market.prices[symbol] = series;
        }
      }
      for (const symbol of Object.keys(current.market.prices)) {
        if (!validSymbols.has(symbol)) {
          delete current.market.prices[symbol];
        }
      }
      for (const failure of result.logEntry.failures) {
        const series = current.market.prices[failure.ticker];
        if (series) {
          series.stale = true;
        }
      }
      current.market.providerHealth = result.providerHealth;
      current.market.lastRefreshAt = result.logEntry.at;
      current.market.refreshLog.unshift(result.logEntry);
      if (current.market.refreshLog.length > 10) {
        current.market.refreshLog.length = 10;
      }
      // Signal log (Phase 2): snapshot the scored opportunities against the just-applied
      // prices — this is the data the look-back calibration view joins forward returns onto.
      // It cannot be backfilled, so logging starts with the first refresh after this ships.
      const signalResult = computeSignals({
        articles: current.articles,
        instruments: current.market.instruments,
        prices: current.market.prices,
        sources: current.sources,
        settings: current.settings,
        nowIso: result.logEntry.at
      });
      current.market.signalLog = updateSignalLog(
        current.market.signalLog,
        [...signalResult.opportunities, ...signalResult.contrarian],
        current.market.prices,
        result.logEntry.at
      );

      for (const { key, mapping } of aiMappings) {
        if (!current.market.mappings[key] && !current.market.ignoredEntities.includes(key)) {
          current.market.mappings[key] = mapping;
        }
      }

      const alerts = current.settings.market.alerts;
      for (const opportunity of [...signalResult.opportunities, ...signalResult.contrarian]) {
        const entry = current.market.alertState[opportunity.ticker] || { above: false, lastAlertedAt: null };
        if (alerts.enabled && opportunity.score >= alerts.minScore && !entry.above) {
          entry.above = true;
          entry.lastAlertedAt = result.logEntry.at;
          firedAlerts.push({
            ticker: opportunity.ticker,
            name: opportunity.name,
            score: opportunity.score,
            quadrantLabel: quadrantLabel(opportunity.quadrant),
            explain: opportunity.components
              .filter((component) => component.value !== null)
              .map((component) => explainComponent(component))
              .filter(Boolean)
          });
        } else if (opportunity.score < alerts.minScore - 5) {
          entry.above = false;
        }
        current.market.alertState[opportunity.ticker] = entry;
      }
    });
    return { state, firedAlerts };
  }

  // Synchronous core: resolves with the fresh state, or { skipped } when a guard fired.
  // The marketRefreshing flag is set before the first await so concurrent callers cannot
  // both enter (the HTTP route 409s on the flag; maybeRefreshMarket just returns).
  async function runMarketRefresh({ bypassThrottle = false } = {}) {
    if (marketRefreshing) {
      return { skipped: "running" };
    }
    marketRefreshing = true;
    marketAbort = new AbortController();
    try {
      const snapshot = await store.read();
      const settings = snapshot.settings;
      if (!settings.market.enabled) {
        return { skipped: "disabled" };
      }
      if (snapshot.market.instruments.length === 0) {
        return { skipped: "empty" };
      }
      const cooldownUntil = snapshot.market.providerHealth.cooldownUntil;
      if (cooldownUntil && Date.parse(cooldownUntil) > Date.now()) {
        return { skipped: "cooldown", cooldownUntil };
      }
      if (!bypassThrottle) {
        const last = snapshot.market.lastRefreshAt ? Date.parse(snapshot.market.lastRefreshAt) : 0;
        if (Number.isFinite(last) && Date.now() - last < settings.market.minRefreshMinutes * 60_000) {
          return { skipped: "throttled" };
        }
      }

      const result = await refreshPrices(snapshot.market, settings, {
        fetchImpl: marketFetchImpl,
        throttleMs: marketThrottleMs,
        signal: marketAbort.signal
      });

      // Amortized 90-day revalidation (<=2 probes per cycle, oldest first): catches
      // post-M&A stale symbols before they feed signals forever. Skipped when the cycle
      // was rate-limited or aborted — no point burning probes into a cooldown.
      const revalidations = [];
      if (!result.providerHealth.cooldownUntil && !result.logEntry.aborted) {
        for (const due of revalidationQueue(snapshot.market, result.logEntry.at).slice(0, 2)) {
          if (marketAbort.signal.aborted) {
            break;
          }
          const probe = await probeSymbol(due.symbol, {
            throttleMs: marketThrottleMs, fetchImpl: marketFetchImpl
          });
          if (probe.ok || !probe.rateLimited) {
            revalidations.push({ ...due, ok: probe.ok, at: result.logEntry.at });
          }
        }
      }

      // AI mapping fallback (opt-in, Phase 4): one batched call for the still-unresolved
      // suggestion queue; every proposed ticker (incl. relatedTickers) is probe-validated
      // before persisting, confidence capped 0.75 -> lands visibly "unconfirmed". AI output
      // can never create an instrument (invariant 1).
      const aiMappings = [];
      if (settings.market.aiMapping && aiAvailable(settings) &&
          !result.providerHealth.cooldownUntil && !result.logEntry.aborted) {
        try {
          const queue = suggestCandidates(snapshot.articles, snapshot.market, { nowIso: result.logEntry.at });
          if (queue.length) {
            const proposals = await aiResolveEntities(queue, settings);
            for (const proposal of proposals) {
              const key = normalizeName(proposal.entity);
              if (!key || snapshot.market.mappings[key]) {
                continue;
              }
              let ticker = null;
              if (proposal.isPublic && proposal.ticker) {
                const probe = await probeSymbol(proposal.ticker, {
                  throttleMs: marketThrottleMs, fetchImpl: marketFetchImpl
                });
                if (!probe.ok) {
                  continue; // hallucinated ticker: stays unresolved in the queue
                }
                ticker = probe.meta.symbol;
              }
              const relatedTickers = [];
              for (const raw of proposal.relatedTickers) {
                const probe = await probeSymbol(raw, { throttleMs: marketThrottleMs, fetchImpl: marketFetchImpl });
                if (probe.ok) {
                  relatedTickers.push(probe.meta.symbol);
                }
              }
              aiMappings.push({
                key,
                mapping: {
                  displayName: proposal.entity,
                  status: proposal.isPublic ? (proposal.parentCompany ? "subsidiary" : "public") : "private",
                  ticker,
                  parent: proposal.parentCompany || null,
                  relatedTickers,
                  note: proposal.note || null,
                  source: "ai",
                  confidence: proposal.confidence,
                  confirmed: false,
                  checkedAt: result.logEntry.at,
                  validatedAt: ticker ? result.logEntry.at : null
                }
              });
            }
          }
        } catch (error) {
          warn(`AI mapping failed: ${error.message}`);
        }
      }

      const { state, firedAlerts } = await applyMarketRefresh(result, revalidations, aiMappings);

      dispatchWebhooks(state.settings.webhooks, {
        event: "market.refresh.completed",
        at: result.logEntry.at,
        updated: result.logEntry.updated,
        failures: result.logEntry.failures
      });
      for (const alert of firedAlerts) {
        dispatchWebhooks(state.settings.webhooks, {
          event: "opportunity.flagged",
          ...alert,
          disclaimer: MARKET_DISCLAIMER
        }, {
          ntfy: {
            // Header values must stay ASCII (undici rejects non-Latin1 header bytes);
            // the body below is free-form UTF-8.
            title: `NewsPlatform: Opportunity ${alert.score}`,
            tags: "chart_with_upwards_trend",
            text: `${alert.name} (${alert.ticker}) — score ${alert.score}\n${alert.quadrantLabel}\n` +
              `${alert.explain.join("\n")}\n\n${MARKET_DISCLAIMER}`
          }
        });
      }

      return { state, logEntry: result.logEntry };
    } finally {
      marketRefreshing = false;
      marketAbort = null;
    }
  }

  function maybeRefreshMarket() {
    if (marketRefreshing) {
      return;
    }
    marketRefreshPromise = runMarketRefresh().catch((error) => {
      warn(`Market refresh failed: ${error.message}`);
    });
  }

  function armScheduler(minutes) {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    const value = Number(minutes) || 0;
    if (value <= 0) {
      return;
    }
    schedulerTimer = setInterval(() => {
      if (collecting) {
        return;
      }
      runCollect().catch((error) => {
        warn(`Scheduled collect failed: ${error.message}`);
      });
    }, value * 60_000);
    schedulerTimer.unref();
  }

  // Builds the Morning Brief from the last `lookbackHours` of stories, persists it as
  // store.brief, and (if brief.push is on) pushes a short text form to ntfy hooks. Uses the LLM
  // when a key is present, otherwise a readable deterministic fallback — so it always produces
  // something. Never throws to callers that don't await it.
  async function generateBrief({ trigger = "manual" } = {}) {
    const snapshot = await store.read();
    const settings = snapshot.settings;
    const briefCfg = settings.brief || {};
    const generatedAt = nowIso();
    const windowHours = briefCfg.lookbackHours || 24;
    const dateLabel = formatBriefDate(generatedAt);

    const selected = selectBriefArticles(snapshot.articles, {
      lookbackHours: windowHours,
      maxStories: briefCfg.maxStories || 10,
      nowMs: Date.now()
    });

    let built = buildBriefFallback(selected, { generatedAt, windowHours });
    let source = "fallback";
    let model = null;
    let error = null;

    if (selected.length && briefAiAvailable(settings)) {
      try {
        const markdown = await aiMorningBrief(
          { dateLabel, windowHours, stories: briefArticlePayload(selected) },
          settings
        );
        const title = `Morning Brief — ${dateLabel}`;
        const lede = `${selected.length} ${selected.length === 1 ? "story" : "stories"} from the last ${windowHours}h.`;
        built = {
          title,
          markdown: `# ${title}\n\n${markdown}\n`,
          html: `<h1>${escapeHtml(title)}</h1>\n${briefMarkdownToHtml(markdown)}`,
          text: briefPushText(title, lede, selected),
          storyCount: selected.length
        };
        source = "ai";
        model = (settings.ai && settings.ai.model) || "claude-opus-4-8";
      } catch (err) {
        // Paid-for nothing here, so just note it and keep the deterministic brief.
        error = err.message;
      }
    }

    const record = {
      generatedAt,
      trigger,
      source,
      title: built.title,
      markdown: built.markdown,
      html: built.html,
      text: built.text,
      storyCount: built.storyCount,
      windowHours,
      model,
      error
    };

    const state = await store.update((current) => {
      current.brief = record;
    });

    dispatchWebhooks(state.settings.webhooks, {
      event: "brief.generated",
      at: generatedAt,
      trigger,
      source,
      storyCount: record.storyCount,
      title: record.title
    }, briefCfg.push ? {
      ntfy: {
        // x-title header must be ASCII (undici rejects non-Latin1); the full title lives in the body.
        title: "NewsPlatform Morning Brief",
        tags: "newspaper",
        text: record.text
      }
    } : undefined);

    return record;
  }

  // Fires generateBrief once a day at brief.hour:brief.minute (local time), then re-arms for the
  // next day. Only runs while the server is up (same caveat as the collect scheduler).
  function armBriefScheduler(briefCfg) {
    if (briefTimer) {
      clearTimeout(briefTimer);
      briefTimer = null;
    }
    const cfg = briefCfg && typeof briefCfg === "object" ? briefCfg : {};
    if (!cfg.enabled) {
      return;
    }
    const now = new Date();
    const next = new Date(now);
    next.setHours(Number(cfg.hour) || 0, Number(cfg.minute) || 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    briefTimer = setTimeout(() => {
      generateBrief({ trigger: "schedule" })
        .catch((error) => warn(`Scheduled brief failed: ${error.message}`))
        .finally(() => {
          store.read()
            .then((fresh) => armBriefScheduler(fresh.settings.brief))
            .catch(() => {});
        });
    }, next.getTime() - now.getTime());
    briefTimer.unref();
  }

  router.add("GET", "/api/state", async (req, res) => {
    const state = await store.read();
    sendJson(res, 200, decorate(state));
  });

  router.add("PUT", "/api/config", async (req, res) => {
    const body = await readJson(req);

    let apiKeyIntent;
    if (body && body.settings && body.settings.ai &&
        Object.prototype.hasOwnProperty.call(body.settings.ai, "apiKey")) {
      apiKeyIntent = body.settings.ai.apiKey;
      delete body.settings.ai.apiKey;
    }
    let apiTokenIntent;
    if (body && body.settings &&
        Object.prototype.hasOwnProperty.call(body.settings, "apiToken")) {
      apiTokenIntent = body.settings.apiToken;
      delete body.settings.apiToken;
    }
    if (body && body.settings && body.settings.ai) {
      delete body.settings.ai.apiKeyConfigured;
    }

    let patch;
    try {
      patch = validateConfigPatch(body);
    } catch (error) {
      throw new HttpError(400, error.message);
    }

    const state = await store.update((current) => {
      if (patch.settings) {
        const currentAi = current.settings.ai;
        const mergedAi = { ...currentAi, ...(patch.settings.ai || {}) };
        mergedAi.apiKey = currentAi.apiKey;
        // Nested settings objects merge like ai does — a partial market/brief patch must never
        // wipe unspecified subfields (the ...patch.settings spread would replace wholesale).
        const mergedMarket = { ...current.settings.market, ...(patch.settings.market || {}) };
        const mergedBrief = { ...(current.settings.brief || {}), ...(patch.settings.brief || {}) };
        current.settings = {
          ...current.settings,
          ...patch.settings,
          ai: mergedAi,
          market: mergedMarket,
          brief: mergedBrief,
          apiToken: current.settings.apiToken
        };
      }
      if (apiKeyIntent !== undefined) {
        if (apiKeyIntent === null) {
          current.settings.ai = { ...current.settings.ai, apiKey: "" };
        } else if (typeof apiKeyIntent === "string" && apiKeyIntent.trim() !== "") {
          current.settings.ai = { ...current.settings.ai, apiKey: apiKeyIntent.trim() };
        }
      }
      if (apiTokenIntent !== undefined) {
        current.settings.apiToken = typeof apiTokenIntent === "string" ? apiTokenIntent.trim() : "";
      }
      if (Array.isArray(current.settings.webhooks)) {
        current.settings.webhooks = current.settings.webhooks.map((hook) => ({
          id: hook.id || `wh-${hashId(`${hook.url}:${Math.random()}`).slice(0, 12)}`,
          url: hook.url,
          // Preserve delivery format — dropping it silently reverts ntfy hooks to json and
          // breaks phone push (and the Morning Brief push) after any settings save.
          format: hook.format === "ntfy" ? "ntfy" : "json",
          createdAt: hook.createdAt || nowIso()
        }));
      }
      if (patch.categories) {
        current.categories = patch.categories;
      }
      if (patch.sentiment) {
        current.sentiment = patch.sentiment;
      }
    });

    armScheduler(state.settings.autoCollectMinutes);
    armBriefScheduler(state.settings.brief);
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/recategorize", async (req, res) => {
    const state = await store.update((current) => {
      for (const article of current.articles) {
        article.monthKey = toMonthKey(article.publishedAt);
        // Clean older summaries: drop the legacy "Category signal: ..." suffix and any
        // leading feed breadcrumb — both read as boilerplate and polluted re-extraction.
        if (!article.aiEnriched && typeof article.summary === "string") {
          article.summary = stripBoilerplate(
            article.summary.replace(/\s*Category signal:[\s\S]*$/i, "").trim()
          );
        }
        const text = `${article.title}. ${article.summary || ""}`;
        article.sentiment = scoreSentiment(text, current.sentiment);
        article.keywords = extractKeywords(text, STOP_WORDS);
        if (!article.aiEnriched) {
          article.category = categorize(text, current.categories);
          article.entities = extractEntities(text, STOP_WORDS);
        }
      }
      assignClusters(current.articles, STOP_WORDS);
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/sources", async (req, res) => {
    const body = await readJson(req);
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new HttpError(400, "Please provide an http or https URL.");
    }
    assertPublicOrHttpError(url);
    const source = newSource({ name: body.name, url, type: body.type });

    let duplicate = false;
    const state = await store.update((current) => {
      if (current.sources.some((existing) => String(existing.url).toLowerCase() === url.toLowerCase())) {
        duplicate = true;
        return;
      }
      current.sources.unshift(source);
    });
    if (duplicate) {
      throw new HttpError(409, "Source already exists");
    }
    sendJson(res, 201, decorate(state));
  });

  router.add("POST", "/api/sources/opml", async (req, res) => {
    const body = await readJson(req);
    const opml = String(body.opml || "");
    if (!opml.trim()) {
      throw new HttpError(400, "Provide OPML content in the \"opml\" field.");
    }
    let entries;
    try {
      entries = parseOpml(opml);
    } catch (error) {
      throw new HttpError(400, `Could not parse OPML: ${error.message}`);
    }

    let imported = 0;
    let skipped = 0;
    const state = await store.update((current) => {
      const known = new Set(current.sources.map((source) => String(source.url).toLowerCase()));
      for (const entry of entries) {
        const url = String(entry.url || "").trim();
        if (!/^https?:\/\//i.test(url) || known.has(url.toLowerCase())) {
          skipped += 1;
          continue;
        }
        try {
          assertPublicHttpUrl(url);
        } catch {
          skipped += 1;
          continue;
        }
        known.add(url.toLowerCase());
        current.sources.unshift(newSource({ name: entry.name, url, type: entry.type || "auto" }));
        imported += 1;
      }
    });
    sendJson(res, 200, { ...decorate(state), imported, skipped });
  });

  router.add("GET", "/api/sources/opml", async (req, res) => {
    const state = await store.read();
    const xml = buildOpml(state.sources);
    res.writeHead(200, {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"news-platform-sources.opml\""
    });
    res.end(xml);
  });

  router.add("PATCH", "/api/sources/:id", async (req, res, { params }) => {
    const body = await readJson(req);
    let found = false;
    const state = await store.update((current) => {
      const source = current.sources.find((existing) => existing.id === params.id);
      if (!source) {
        return;
      }
      found = true;
      if (typeof body.name === "string" && cleanText(body.name)) {
        source.name = cleanText(body.name);
      }
      if (typeof body.paused === "boolean") {
        source.paused = body.paused;
      }
    });
    if (!found) {
      throw new HttpError(404, "Source not found");
    }
    sendJson(res, 200, decorate(state));
  });

  router.add("DELETE", "/api/sources/:id", async (req, res, { params }) => {
    const state = await store.update((current) => {
      current.sources = current.sources.filter((source) => source.id !== params.id);
      current.articles = current.articles.filter((article) => article.sourceId !== params.id);
      assignClusters(current.articles, STOP_WORDS);
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/articles", async (req, res) => {
    const body = await readJson(req);
    const title = cleanText(String(body.title || ""));
    const text = cleanText(String(body.body || ""));
    if (!title || !text) {
      throw new HttpError(400, "Manual articles need a title and body.");
    }
    const sourceName = cleanText(String(body.sourceName || "")) || "Manual Notes";
    const url = String(body.url || "").trim();
    const publishedAt = parseDateSafe(body.publishedAt);

    const state = await store.update((current) => {
      if (!current.sources.some((source) => source.id === "manual-notes")) {
        current.sources.unshift({
          id: "manual-notes",
          name: sourceName,
          url: "manual://notes",
          type: "manual",
          createdAt: nowIso(),
          paused: false,
          etag: null,
          lastModified: null,
          health: emptyHealth()
        });
      }
      const article = enrichArticle(
        { title, url, publishedAt, body: text },
        { id: "manual-notes", name: sourceName, type: "manual" },
        { categories: current.categories, sentiment: current.sentiment, stopWords: STOP_WORDS }
      );
      const merged = mergeArticles(current.articles, [article], current.settings.maxArticles);
      current.articles = merged.articles;
      assignClusters(current.articles, STOP_WORDS);
    });
    sendJson(res, 201, decorate(state));
  });

  router.add("POST", "/api/articles/:id/fulltext", async (req, res, { params }) => {
    const snapshot = await store.read();
    const article = snapshot.articles.find((existing) => existing.id === params.id);
    if (!article) {
      throw new HttpError(404, "Article not found");
    }
    if (!/^https?:\/\//i.test(article.url || "")) {
      throw new HttpError(400, "Article has no fetchable http(s) URL.");
    }

    let fullText;
    try {
      fullText = await fetchFullText(article.url);
    } catch (error) {
      throw new HttpError(502, `Full text fetch failed: ${error.message}`);
    }

    let updatedArticle = null;
    const state = await store.update((current) => {
      const index = current.articles.findIndex((existing) => existing.id === params.id);
      if (index === -1) {
        return;
      }
      const currentArticle = current.articles[index];
      const source = current.sources.find((existing) => existing.id === currentArticle.sourceId) ||
        { id: currentArticle.sourceId, name: currentArticle.sourceName, type: currentArticle.sourceType };
      const enriched = enrichArticle(
        {
          title: currentArticle.title,
          url: currentArticle.url,
          publishedAt: currentArticle.publishedAt,
          body: fullText.text
        },
        source,
        { categories: current.categories, sentiment: current.sentiment, stopWords: STOP_WORDS }
      );
      updatedArticle = {
        ...enriched,
        id: currentArticle.id,
        publishedAt: currentArticle.publishedAt,
        monthKey: toMonthKey(currentArticle.publishedAt),
        collectedAt: currentArticle.collectedAt,
        read: currentArticle.read,
        starred: currentArticle.starred,
        clusterId: currentArticle.clusterId,
        fullTextFetched: true
      };
      current.articles[index] = updatedArticle;
    });
    if (!updatedArticle) {
      throw new HttpError(404, "Article not found");
    }
    sendJson(res, 200, { ...decorate(state), article: updatedArticle });
  });

  router.add("PATCH", "/api/articles/:id", async (req, res, { params }) => {
    const body = await readJson(req);
    let found = false;
    const state = await store.update((current) => {
      const article = current.articles.find((existing) => existing.id === params.id);
      if (!article) {
        return;
      }
      found = true;
      if (typeof body.read === "boolean") {
        article.read = body.read;
      }
      if (typeof body.starred === "boolean") {
        article.starred = body.starred;
      }
    });
    if (!found) {
      throw new HttpError(404, "Article not found");
    }
    sendJson(res, 200, decorate(state));
  });

  router.add("DELETE", "/api/articles/:id", async (req, res, { params }) => {
    const state = await store.update((current) => {
      current.articles = current.articles.filter((article) => article.id !== params.id);
      assignClusters(current.articles, STOP_WORDS);
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/collect", async (req, res) => {
    const { state, collection } = await runCollect();
    sendJson(res, 200, { ...decorate(state), collection });
  });

  router.add("POST", "/api/watchlists", async (req, res) => {
    const body = await readJson(req);
    const name = cleanText(String(body.name || ""));
    if (!name) {
      throw new HttpError(400, "Watchlists need a name.");
    }
    const watchlist = {
      id: `wl-${hashId(`${name}:${Date.now()}:${Math.random()}`).slice(0, 12)}`,
      name,
      keywords: toStringList(body.keywords),
      categories: toStringList(body.categories),
      sources: toStringList(body.sources),
      createdAt: nowIso()
    };
    const state = await store.update((current) => {
      current.watchlists.unshift(watchlist);
    });
    sendJson(res, 201, decorate(state));
  });

  router.add("DELETE", "/api/watchlists/:id", async (req, res, { params }) => {
    const state = await store.update((current) => {
      current.watchlists = current.watchlists.filter((watchlist) => watchlist.id !== params.id);
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/reports", async (req, res) => {
    const body = await readJson(req);
    const categories = toStringList(body.categories);
    if (!categories.length) {
      throw new HttpError(400, "Pick at least one category for the report.");
    }
    const month = typeof body.month === "string" && body.month ? body.month : "All";
    const focus = ["executive", "source", "watchlist", "opportunities"].includes(body.focus) ? body.focus : "executive";
    const template = ["brief", "standard", "detailed"].includes(body.template) ? body.template : "standard";

    const state = await store.read();
    const wanted = new Set(categories);
    const articles = state.articles.filter((article) =>
      wanted.has(article.category) && (month === "All" || article.monthKey === month));

    const report = buildReport({
      categories,
      month,
      focus,
      template,
      articles,
      allArticles: state.articles,
      sources: state.sources,
      market: focus === "opportunities" ? decorate(state).market : undefined
    });

    if (body.useAi && aiAvailable(state.settings)) {
      try {
        const narrative = await aiReportNarrative(
          { title: report.title, focus, month, articles: articles.slice(0, 60) },
          state.settings
        );
        report.markdown = `## Analyst narrative\n\n${narrative}\n\n${report.markdown}`;
        report.html = `<section class="ai-narrative"><h2>Analyst narrative</h2><p>${escapeHtml(narrative)}</p></section>\n${report.html}`;
      } catch (error) {
        report.meta = { ...report.meta, aiError: error.message };
      }
    }

    sendJson(res, 200, {
      title: report.title,
      markdown: report.markdown,
      html: report.html,
      meta: report.meta
    });
  });

  // Generate the Morning Brief on demand (the "Generate now" button). Works regardless of the
  // schedule toggle so users can preview it immediately.
  router.add("POST", "/api/brief/generate", async (req, res) => {
    const record = await generateBrief({ trigger: "manual" });
    sendJson(res, 200, { brief: record });
  });

  router.add("GET", "/api/export", async (req, res) => {
    const state = await store.read();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"news-platform-export.json\""
    });
    res.end(JSON.stringify(state, null, 2));
  });

  router.add("POST", "/api/import", async (req, res) => {
    const body = await readJson(req);
    const raw = body ? body.store : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, "Import payload must include a \"store\" object.");
    }
    let migrated;
    try {
      migrated = migrate(raw);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    // Security: an import is a data restore, not a settings handoff. Never let an
    // imported file silently plant an outbound webhook, arm the scheduler, or carry
    // secrets — strip side-effecting settings and let the user reconfigure them.
    migrated.settings.webhooks = [];
    migrated.settings.apiToken = "";
    migrated.settings.autoCollectMinutes = 0;
    if (migrated.settings.ai && typeof migrated.settings.ai === "object") {
      migrated.settings.ai.apiKey = "";
    }
    // Alerts are outbound side effects — same strip rationale as webhooks.
    migrated.settings.market.alerts.enabled = false;
    // A scheduled brief spends on the LLM and can push outbound — don't let an import arm it.
    if (migrated.settings.brief && typeof migrated.settings.brief === "object") {
      migrated.settings.brief.enabled = false;
    }
    migrated.brief = null;
    // Market-preserving merge (SPEC §9 invariant 8): restoring a pre-v3 news backup — the
    // exact scenario import exists for — must not wipe instruments, ideas, or the
    // unbackfillable signalLog. Payloads that carry their own market data round-trip.
    const payloadHasMarket = raw.market && typeof raw.market === "object" && !Array.isArray(raw.market);
    const payloadPreV3 = !(typeof raw.version === "number" && raw.version >= 3);
    if (!payloadHasMarket || payloadPreV3) {
      const current = await store.read();
      migrated.market = current.market;
      migrated.settings.market = current.settings.market;
    }
    // Either way: imported price history may be old — force the next refresh to heal it.
    migrated.market.lastRefreshAt = null;
    for (const series of Object.values(migrated.market.prices)) {
      series.stale = true;
    }
    const state = await store.replace(migrated);
    armScheduler(state.settings.autoCollectMinutes);
    armBriefScheduler(state.settings.brief);
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/reset", async (req, res) => {
    const state = await store.replace(seedStore());
    armScheduler(state.settings.autoCollectMinutes);
    armBriefScheduler(state.settings.brief);
    sendJson(res, 200, decorate(state));
  });

  router.add("GET", "/api/external/articles", async (req, res, { url }) => {
    const state = await store.read();
    const token = String(state.settings.apiToken || "");
    if (!token) {
      throw new HttpError(403, "External API is disabled. Configure an API token in Settings to enable it.");
    }
    const header = String(req.headers.authorization || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !tokensEqual(match[1].trim(), token)) {
      throw new HttpError(401, "Invalid or missing bearer token.");
    }

    const query = url.searchParams;
    const category = query.get("category") || "";
    const month = query.get("month") || "";
    const sourceName = query.get("source") || "";
    const search = (query.get("search") || "").toLowerCase();
    let limit = Number.parseInt(query.get("limit") || "50", 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 50;
    }
    limit = Math.min(limit, 200);

    const filtered = state.articles.filter((article) =>
      (!category || article.category === category) &&
      (!month || article.monthKey === month) &&
      (!sourceName || article.sourceName === sourceName) &&
      (!search || `${article.title} ${article.summary}`.toLowerCase().includes(search)));

    sendJson(res, 200, {
      articles: filtered.slice(0, limit).map(trimArticle),
      total: filtered.length
    });
  });

  router.add("GET", "/api/market/lookup", async (req, res, { url }) => {
    const query = String(url.searchParams.get("q") || "").trim();
    if (!query) {
      throw new HttpError(400, "Suchbegriff fehlt (Parameter q).");
    }
    const state = await store.read();
    const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    assertMarketHost(searchUrl);
    await paceMarketFetch(marketThrottleMs);

    let payload;
    try {
      const response = await marketFetchImpl(searchUrl, {
        timeoutMs: 15000,
        headers: { "user-agent": YAHOO_USER_AGENT, accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`Yahoo search returned HTTP ${response.status}`);
      }
      payload = JSON.parse(response.text);
    } catch (error) {
      throw new HttpError(502, `Symbolsuche nicht erreichbar: ${error.message}`);
    }

    const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
    const results = quotes
      .filter((quote) => quote && quote.quoteType === "EQUITY" && typeof quote.symbol === "string")
      .map((quote) => ({
        ticker: quote.symbol,
        name: (typeof quote.longname === "string" && quote.longname !== ""
          ? quote.longname
          : String(quote.shortname || quote.symbol)).trim(),
        exchange: String(quote.exchDisp || quote.exchange || ""),
        isXetra: quote.exchange === "GER" || quote.exchDisp === "XETRA"
      }));
    if (state.settings.market.preferXetra) {
      results.sort((a, b) => Number(b.isXetra) - Number(a.isXetra));
    }
    const cleaned = results.map(({ isXetra, ...rest }) => ({ ...rest, source: "search" }));

    // Seed hits rank first: curated knowledge (incl. privates and subsidiaries the search
    // can't know) beats raw symbol search.
    const seed = SEED_MAP[normalizeName(query)];
    if (seed) {
      const merged = cleaned.filter((entry) => entry.ticker !== seed.ticker);
      merged.unshift({
        ticker: seed.ticker,
        name: seed.displayName + (seed.parent ? ` (${seed.parent})` : ""),
        exchange: seed.exchange || "",
        status: seed.status,
        note: seed.note || null,
        relatedTickers: seed.relatedTickers || [],
        source: "seed"
      });
      sendJson(res, 200, { results: merged });
      return;
    }
    sendJson(res, 200, { results: cleaned });
  });

  // Shared by POST /api/market/instruments and the mapping "track" action. Both are explicit
  // user clicks (SPEC invariant 1) and both probe-validate before anything persists
  // (invariant 3). Throws HttpError; returns { state, message }.
  async function performInstrumentAdd(body, { source = "user", mutateExtra } = {}) {
    let ticker;
    try {
      ticker = normalizeTicker(body.ticker);
    } catch (error) {
      throw new HttpError(400, error.message);
    }

    const snapshot = await store.read();
    if (snapshot.market.instruments.some((instrument) => instrument.ticker === ticker)) {
      throw new HttpError(409, `${ticker} is already being watched.`);
    }
    if (snapshot.market.instruments.length >= snapshot.settings.market.maxInstruments) {
      throw new HttpError(400,
        `Limit of ${snapshot.settings.market.maxInstruments} instruments reached (Settings → Market).`);
    }

    // A raw ticker typo must fail here with Yahoo's verdict, not produce a dead watchlist row.
    const probe = await probeSymbol(ticker, { throttleMs: marketThrottleMs, fetchImpl: marketFetchImpl });
    if (!probe.ok) {
      throw new HttpError(probe.rateLimited ? 503 : 400,
        probe.rateLimited ? "Yahoo rate-limited — please try again later." : probe.reason);
    }

    const name = cleanText(String(body.name || "")) || probe.meta.name || ticker;
    let aliases;
    if (body.aliases !== undefined) {
      try {
        aliases = validateInstrumentPatch({ aliases: body.aliases }).aliases;
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    } else {
      aliases = defaultAliases(name, ticker);
    }
    const sizeHint = ["large", "mid", "small"].includes(body.sizeHint) ? body.sizeHint : null;

    // Immediate full history fetch so the first card isn't an empty chart. Partial failure
    // still adds the instrument: an empty stale series heals on the next refresh.
    let series = null;
    let historyError = null;
    try {
      const range = snapshot.settings.market.historyDays > 260 ? "2y" : "1y";
      const chart = await fetchChart(ticker, { range, throttleMs: marketThrottleMs, fetchImpl: marketFetchImpl });
      series = {
        currency: chart.currency || "",
        quote: chart.quote
          ? { price: chart.quote.price, marketTime: chart.quote.marketTime, exchange: chart.exchange }
          : null,
        dates: chart.bars.map((bar) => bar.date),
        closes: chart.bars.map((bar) => bar.close),
        updatedAt: nowIso(),
        lastFullAt: nowIso(),
        stale: false
      };
    } catch (error) {
      historyError = error.message;
    }

    let duplicate = false;
    const state = await store.update((current) => {
      if (current.market.instruments.some((instrument) => instrument.ticker === ticker)) {
        duplicate = true;
        return;
      }
      current.market.instruments.push({
        ticker,
        name,
        aliases,
        exchange: probe.meta.exchange || "",
        currency: probe.meta.currency || "",
        sizeHint,
        paused: false,
        source,
        confidence: 1,
        confirmed: true,
        addedAt: nowIso(),
        validatedAt: nowIso(),
        staleSymbol: false
      });
      current.market.prices[ticker] = series || {
        currency: probe.meta.currency || "",
        quote: probe.meta.price !== null
          ? { price: probe.meta.price, marketTime: nowIso(), exchange: probe.meta.exchange || "" }
          : null,
        dates: [],
        closes: [],
        updatedAt: nowIso(),
        lastFullAt: null,
        stale: true
      };
      if (typeof mutateExtra === "function") {
        mutateExtra(current, { ticker, name });
      }
    });
    if (duplicate) {
      throw new HttpError(409, `${ticker} wird bereits beobachtet.`);
    }

    // First instrument: benchmarks have no series yet — kick a refresh in the background.
    maybeRefreshMarket();
    return {
      state,
      message: historyError
        ? `${ticker} added — price history will follow on the next refresh (${historyError}).`
        : `${ticker} added.`
    };
  }

  router.add("POST", "/api/market/instruments", async (req, res) => {
    const body = await readJson(req);
    const { state, message } = await performInstrumentAdd(body);
    sendJson(res, 201, { ...decorate(state), message });
  });

  router.add("POST", "/api/market/resolve", async (req, res) => {
    const body = await readJson(req);
    const name = cleanText(String(body.name || ""));
    if (!name) {
      throw new HttpError(400, "Name fehlt.");
    }
    const state = await store.read();
    const result = await resolveEntity(name, state.settings, {
      fetchImpl: marketFetchImpl,
      throttleMs: marketThrottleMs
    });
    sendJson(res, 200, result);
  });

  router.add("POST", "/api/market/mappings", async (req, res) => {
    const body = await readJson(req);
    const rawName = cleanText(String(body.name || ""));
    const key = normalizeName(rawName);
    if (!key) {
      throw new HttpError(400, "Name fehlt.");
    }
    const action = body.action;

    if (action === "track") {
      // The ONLY automation-adjacent path to an instrument — and it is a user click.
      const { state, message } = await performInstrumentAdd(
        { ticker: body.ticker, name: body.instrumentName || rawName },
        {
          source: "search",
          mutateExtra: (current, { ticker, name }) => {
            current.market.ignoredEntities = current.market.ignoredEntities.filter((entry) => entry !== key);
            current.market.mappings[key] = {
              displayName: rawName, status: "public", ticker, parent: null,
              relatedTickers: [], note: null, source: "search",
              confidence: 1, confirmed: true, checkedAt: nowIso(), validatedAt: nowIso()
            };
            void name;
          }
        }
      );
      sendJson(res, 201, { ...decorate(state), message });
      return;
    }

    if (action === "map") {
      const status = ["public", "private", "subsidiary"].includes(body.status)
        ? body.status
        : (body.ticker ? "public" : "private");
      const ticker = body.ticker ? normalizeTicker(body.ticker) : null;
      const state = await store.update((current) => {
        current.market.ignoredEntities = current.market.ignoredEntities.filter((entry) => entry !== key);
        current.market.mappings[key] = {
          displayName: rawName,
          status,
          ticker,
          parent: cleanText(String(body.parent || "")) || null,
          relatedTickers: (Array.isArray(body.relatedTickers) ? body.relatedTickers : [])
            .map((entry) => { try { return normalizeTicker(entry); } catch { return null; } })
            .filter(Boolean).slice(0, 3),
          note: cleanText(String(body.note || "")) || null,
          source: "user",
          confidence: 1,
          confirmed: true,
          checkedAt: nowIso(),
          validatedAt: null
        };
      });
      sendJson(res, 200, { ...decorate(state), message: `${rawName} zugeordnet (${status}).` });
      return;
    }

    if (action === "ignore") {
      const state = await store.update((current) => {
        delete current.market.mappings[key];
        if (!current.market.ignoredEntities.includes(key)) {
          current.market.ignoredEntities.push(key);
        }
      });
      sendJson(res, 200, { ...decorate(state), message: `${rawName} wird nicht mehr vorgeschlagen.` });
      return;
    }

    if (action === "confirm") {
      let found = false;
      const state = await store.update((current) => {
        const mapping = current.market.mappings[key];
        if (mapping) {
          found = true;
          mapping.confirmed = true;
          mapping.confidence = 1;
        }
      });
      if (!found) {
        throw new HttpError(404, "Mapping not found.");
      }
      sendJson(res, 200, { ...decorate(state), message: `${rawName} confirmed.` });
      return;
    }

    throw new HttpError(400, 'action muss "track", "map", "ignore" oder "confirm" sein.');
  });

  router.add("DELETE", "/api/market/mappings/:name", async (req, res, { params }) => {
    const key = normalizeName(decodeURIComponent(params.name || ""));
    const state = await store.update((current) => {
      delete current.market.mappings[key];
      current.market.ignoredEntities = current.market.ignoredEntities.filter((entry) => entry !== key);
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("PATCH", "/api/market/instruments/:ticker", async (req, res, { params }) => {
    const body = await readJson(req);
    let patch;
    try {
      patch = validateInstrumentPatch(body);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const ticker = String(params.ticker || "").toUpperCase();
    let found = false;
    const state = await store.update((current) => {
      const instrument = current.market.instruments.find((existing) => existing.ticker === ticker);
      if (!instrument) {
        return;
      }
      found = true;
      Object.assign(instrument, patch);
      if (patch.confirmed === true) {
        instrument.confidence = 1;
        instrument.source = "user";
      }
    });
    if (!found) {
      throw new HttpError(404, "Instrument nicht gefunden.");
    }
    sendJson(res, 200, decorate(state));
  });

  router.add("DELETE", "/api/market/instruments/:ticker", async (req, res, { params }) => {
    const ticker = String(params.ticker || "").toUpperCase();
    const state = await store.update((current) => {
      current.market.instruments = current.market.instruments.filter((instrument) => instrument.ticker !== ticker);
      delete current.market.prices[ticker];
      current.market.ideas = current.market.ideas.filter((idea) => idea.ticker !== ticker);
      delete current.market.narratives[ticker];
      delete current.market.alertState[ticker];
    });
    sendJson(res, 200, decorate(state));
  });

  router.add("POST", "/api/market/refresh", async (req, res) => {
    if (marketRefreshing) {
      throw new HttpError(409, "A refresh is already running.");
    }
    const snapshot = await store.read();
    if (!snapshot.settings.market.enabled) {
      throw new HttpError(400, "Market data is disabled (Settings → Market).");
    }
    const cooldownUntil = snapshot.market.providerHealth.cooldownUntil;
    if (cooldownUntil && Date.parse(cooldownUntil) > Date.now()) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        error: `Rate-limited — retry possible after ${cooldownUntil}.`,
        cooldownUntil
      }));
      return;
    }
    if (snapshot.market.instruments.length === 0) {
      sendJson(res, 200, { ...decorate(snapshot), message: "No instruments to refresh." });
      return;
    }

    // Synchronous by design (SPEC §9.3): local single-user app, worst case ~45 s at the
    // instrument cap — the frontend button shows a spinner until this response lands.
    const result = await runMarketRefresh({ bypassThrottle: true });
    if (result.skipped) {
      throw new HttpError(409, "A refresh is already running.");
    }
    sendJson(res, 200, {
      ...decorate(result.state),
      message: `${result.logEntry.updated} price series refreshed` +
        (result.logEntry.failures.length ? `, ${result.logEntry.failures.length} errors.` : ".")
    });
  });

  router.add("POST", "/api/market/ideas/:ticker", async (req, res, { params }) => {
    const body = await readJson(req);
    const status = body.status;
    if (!["pinned", "dismissed", "none"].includes(status)) {
      throw new HttpError(400, 'status muss "pinned", "dismissed" oder "none" sein.');
    }
    const ticker = String(params.ticker || "").toUpperCase();
    let found = false;
    const state = await store.update((current) => {
      if (!current.market.instruments.some((instrument) => instrument.ticker === ticker)) {
        return;
      }
      found = true;
      const existing = current.market.ideas.find((idea) => idea.ticker === ticker);
      current.market.ideas = current.market.ideas.filter((idea) => idea.ticker !== ticker);
      if (status === "none") {
        return;
      }
      // Freeze the current evidence set + score: the resurface rule compares future HOT
      // article ids and scores against exactly this moment's state.
      const result = computeSignals({
        articles: current.articles,
        instruments: current.market.instruments,
        prices: current.market.prices,
        sources: current.sources,
        settings: current.settings,
        nowIso: nowIso()
      });
      const opportunity = [...result.opportunities, ...result.contrarian]
        .find((entry) => entry.ticker === ticker);
      current.market.ideas.push({
        ticker,
        status,
        note: typeof body.note === "string"
          ? cleanText(body.note).slice(0, 500)
          : (existing ? existing.note : ""),
        at: nowIso(),
        evidenceArticleIds: opportunity ? opportunity.evidenceArticleIds : [],
        scoreAt: opportunity ? opportunity.score : 0
      });
    });
    if (!found) {
      throw new HttpError(404, "Instrument nicht gefunden.");
    }
    sendJson(res, 200, decorate(state));
  });

  router.add("GET", "/api/market/prices/:ticker", async (req, res, { params }) => {
    const symbol = String(params.ticker || "").toUpperCase();
    const state = await store.read();
    const series = state.market.prices[symbol];
    if (!series) {
      throw new HttpError(404, "No price data for this symbol.");
    }
    sendJson(res, 200, {
      ticker: symbol,
      currency: series.currency,
      dates: series.dates,
      closes: series.closes,
      updatedAt: series.updatedAt
    });
  });

  router.add("POST", "/api/market/narratives/:ticker", async (req, res, { params }) => {
    const ticker = String(params.ticker || "").toUpperCase();
    const snapshot = await store.read();
    if (!aiAvailable(snapshot.settings)) {
      throw new HttpError(403, "AI is not configured (Settings → AI enrichment).");
    }
    const decorated = decorate(snapshot);
    const opportunity = [...decorated.market.opportunities, ...decorated.market.contrarian]
      .find((entry) => entry.ticker === ticker);
    if (!opportunity) {
      throw new HttpError(404, "No scored opportunity for this symbol.");
    }

    const hash = narrativeHash(opportunity);
    const cached = snapshot.market.narratives[ticker];
    if (cached && cached.hash === hash) {
      sendJson(res, 200, { narrative: cached, cached: true });
      return;
    }

    const evidence = opportunity.articleIds
      .map((id) => snapshot.articles.find((article) => article.id === id))
      .filter(Boolean);
    let narrative;
    try {
      narrative = await aiOpportunityNarrative(opportunity, evidence, snapshot.settings);
    } catch (error) {
      throw new HttpError(502, `AI assessment failed: ${error.message}`);
    }
    // Mechanical output guard on top of the prompt: recommendation vocabulary is a hard
    // discard, not a warning — the product must never emit buy/sell/hold language.
    if (narrativeViolates(narrative)) {
      warn(`Narrative for ${ticker} discarded: recommendation vocabulary`);
      throw new HttpError(502, "AI assessment discarded (contained recommendation vocabulary). Please try again.");
    }

    const record = { hash, at: nowIso(), ...narrative };
    await store.update((current) => {
      current.market.narratives[ticker] = record;
      const keys = Object.keys(current.market.narratives);
      if (keys.length > 30) {
        const oldest = keys.sort((a, b) =>
          Date.parse(current.market.narratives[a].at) - Date.parse(current.market.narratives[b].at))[0];
        delete current.market.narratives[oldest];
      }
    });
    sendJson(res, 200, { narrative: record, cached: false });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const matched = await router.dispatch(req, res, url);
      if (matched) {
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        throw new HttpError(404, "Not found");
      }
      await serveStatic(url.pathname, res, publicDir);
    } catch (error) {
      if (error instanceof HttpError) {
        if (!res.headersSent) {
          sendJson(res, error.status, { error: error.message });
        }
        return;
      }
      if (!quiet) {
        console.error(error);
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Unexpected server error", detail: error.message });
      }
    }
  });

  async function start(port) {
    const state = await store.read();
    armScheduler(state.settings.autoCollectMinutes);
    armBriefScheduler(state.settings.brief);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        const actualPort = server.address().port;
        if (!quiet) {
          console.log(`News platform running at http://localhost:${actualPort}`);
        }
        resolve(actualPort);
      });
    });
  }

  async function stop() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    if (briefTimer) {
      clearTimeout(briefTimer);
      briefTimer = null;
    }
    // A fire-and-forget market refresh may still be running post-response; abort it and
    // await settlement so tests (and process exit) never see dangling async work.
    if (marketAbort) {
      marketAbort.abort();
    }
    if (marketRefreshPromise) {
      await marketRefreshPromise.catch(() => {});
      marketRefreshPromise = null;
    }
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { server, store, start, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 4173);
  app.start(port).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
