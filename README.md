# News Intelligence Platform

[![CI](https://github.com/Naxter/news-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/Naxter/news-platform/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen.svg)](package.json)

A local-first dashboard that turns a set of RSS/Atom feeds and news pages into a searchable,
categorized, trend-aware view of what you follow — and, optionally, maps the companies in that
coverage to stock tickers and scores which ones your own news is moving on before the market.

It collects feeds and news pages, enriches each article with a category, summary, keywords,
sentiment, and entities, clusters duplicate coverage, tracks watchlists and trends, generates
analyst-style reports, and can write a daily morning brief. It runs as a single Node process
with **zero npm dependencies** — Node built-ins only — and stores everything in one JSON file,
so it is comfortable on hardware as small as a Raspberry Pi.

## Run

```bash
npm start
```

Then open `http://localhost:4173`. Set the `PORT` environment variable to use a different port.

A fresh install starts empty — there is no demo data. Add a source or two (or drop in a manual
brief) and click **Collect** to begin. All data lives in a single JSON file at
`data/news-platform.json`; delete it, or use **Reset all**, to start over. Older store files are
migrated automatically on first read.

## Features

- **Sources** — add RSS, Atom, or plain news-page URLs (type auto-detected). Pause/resume and
  delete sources; per-source health badges (new/healthy/warning/failing) with last-error detail.
  Conditional GET (ETag / Last-Modified) avoids refetching unchanged feeds. A DNS-aware guard
  blocks fetches to private, loopback, and link-local addresses.
- **Collection** — collect on demand or on a schedule (Settings → Collection, 5–1440 minutes,
  0 = off). Reentrancy-guarded; keeps a log of the last 20 runs.
- **Enrichment** — word-boundary categorization against configurable keyword lists (German and
  English out of the box), lead-sentence summaries, keyword extraction, sentiment scoring, entity
  extraction (people/orgs/places), reading time, and clustering of near-duplicate coverage.
- **AI enrichment (optional)** — LLM-written categories, summaries, and report narratives via the
  Anthropic API. Enable it in Settings → AI and paste a key, or set `ANTHROPIC_API_KEY`. AI
  failures never break collection — the heuristics remain the baseline.
- **Market signals (optional)** — map the companies mentioned in your feeds to stock tickers
  (curated seed map, Yahoo Finance symbol search, and optional AI resolution), pull delayed/EOD
  price history, and score each instrument on how far its news is running ahead of its price.
  Pin or dismiss ideas, review the entity→ticker mapping, and get a calibration look-back of past
  scores against realized returns. Signals measure your own feeds, not the market — this is not
  investment advice.
- **Morning brief** — a daily digest of the most notable stories, LLM-written when a key is
  present and a readable heuristic version otherwise. Runs on a schedule while the server is up,
  and can push to your phone via an ntfy webhook.
- **Watchlists** — keyword/category/source watchlists with whole-word matching and live counts.
- **Trends** — monthly volume by category, sentiment share, rising keywords, and top entities.
- **Reports** — executive, source, watchlist, or market-opportunity focus; brief/standard/detailed
  templates; Markdown + HTML output; optional AI analyst narrative.
- **OPML** — import feed lists (`POST /api/sources/opml`) and export your sources
  (`GET /api/sources/opml`).
- **Webhooks** — JSON webhooks receive every event (collection, price refresh, alerts); ntfy
  webhooks receive market alerts as a readable phone push.
- **External API** — read-only article access for other tools, protected by a bearer token.
- **Data portability** — export the full store as JSON, import it back, or clear everything.
  Imports are treated as data restores: webhooks, the API token, and the AI key are stripped and
  auto-collection is turned off, so a shared or backup file can't silently enable outbound
  side-effects. Re-enter those in Settings after importing.

## External API

Set an API token in Settings → External API (empty token = disabled), then:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:4173/api/external/articles?category=Technology&month=2026-07&search=chips&limit=50"
```

Query parameters: `category`, `month` (`YYYY-MM`), `source`, `search`, `limit` (max 200).
Returns `{ articles: [...], total }` with trimmed article objects.

## Configuration

Everything is configured in the UI (Settings) and stored in `data/news-platform.json`. Two
environment variables are read at startup:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `4173`). |
| `ANTHROPIC_API_KEY` | Fallback API key for AI enrichment and the LLM brief, used when no key is stored in Settings. Optional — the app runs fully without it on its heuristics. |

## Architecture

Feeds and pages are collected, each article is enriched and merged into the store, and every read
of `/api/state` recomputes the decorated view (trends, health, watchlist matches, and — when
enabled — market signals) on the fly. The store is a single JSON file guarded by serialized
read-modify-write updates; there is no database.

| Module | Responsibility |
|---|---|
| `lib/config.mjs` | Default categories/sentiment/settings, stop words, config-patch validation |
| `lib/store/store.mjs` | Atomic JSON store with serialized read-modify-write updates |
| `lib/store/migrations.mjs` | Forward migration of older store versions |
| `lib/text.mjs` | Text utilities: entity decoding, cleaning, hashing, dates, whole-word matching |
| `lib/enrich/heuristics.mjs` | Categorize, keywords, summary, sentiment, entities, article enrichment |
| `lib/enrich/ai.mjs` | Anthropic API batch enrichment and report narratives |
| `lib/articles.mjs` | Article merge/dedupe (existing wins) with cap |
| `lib/seed.mjs` | Empty starter store |
| `lib/collect/fetchGuard.mjs` | SSRF-safe fetch: private-address checks, redirect handling, size caps |
| `lib/collect/rss.mjs` | RSS/Atom feed parsing |
| `lib/collect/web.mjs` | News-page scraping and published-date extraction |
| `lib/collect/opml.mjs` | OPML parse/build |
| `lib/collect/fulltext.mjs` | Full article text extraction |
| `lib/collect/index.mjs` | Per-source collection with conditional GET and a concurrency pool |
| `lib/analyze/cluster.mjs` | Near-duplicate story clustering |
| `lib/analyze/trends.mjs` | Monthly trends, rising keywords, top entities |
| `lib/analyze/health.mjs` | Source health summaries and collect-result bookkeeping |
| `lib/analyze/alerts.mjs` | Watchlist matching |
| `lib/analyze/decorate.mjs` | Decorated `/api/state` payload (masks the AI key) |
| `lib/market/prices.mjs` | Yahoo Finance chart fetch, series merge, staleness, benchmarks |
| `lib/market/instruments.mjs` | Instrument normalization and article↔instrument matching |
| `lib/market/mapping.mjs` | Entity→ticker resolution, suggestion and discovery queues |
| `lib/market/seedMap.mjs` | Curated entity→listing seed data |
| `lib/market/signals.mjs` | Opportunity scoring and the calibration look-back (pure math) |
| `lib/market/format.mjs` | Human-readable signal explanations |
| `lib/market/ai.mjs` | Optional AI entity resolution and opportunity narratives |
| `lib/report/report.mjs` | Report generation (four focuses, three templates) |
| `lib/report/brief.mjs` | Morning-brief assembly (LLM or heuristic) |
| `lib/http/router.mjs` | HttpError, JSON helpers, body reader, `:param` router |
| `lib/http/static.mjs` | Static file serving with path containment |
| `server.mjs` | Composition root: endpoints, collect flow, scheduler, webhooks |
| `public/` | Vanilla-JS dashboard (Dashboard / Trends / Report / Market / Settings) |

## Security and scope

This is a **single-user local application** with **no authentication** on the dashboard or the
main API. Bind it to localhost or a trusted LAN; do not expose it directly to the internet. The
only credentialed surface is the read-only External API, which requires a bearer token.

Outbound fetches (feeds, pages, full text, price and symbol lookups) go through an SSRF guard that
resolves DNS and refuses private, loopback, and link-local addresses, follows a bounded number of
redirects, and caps response size. The market layer only ever reaches a fixed allowlist of Yahoo
Finance hosts.

The market signals are a personal information tool built on delayed/EOD data and your own feeds.
They are **not investment advice** and make no buy/sell/hold recommendation; the AI narrative is
mechanically filtered to drop recommendation language.

## Development

```bash
npm test
```

The suite uses the built-in `node:test` runner and touches no network. There are no build or lint
steps — the project is plain ESM with no dependencies.

## License

MIT — see [LICENSE](LICENSE).
