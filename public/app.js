const PAGE_SIZE = 24;
const TREND_PALETTE = ["#f2b84b", "#66d1c6", "#f06f5c", "#7ad17d", "#7ba7ff"];
const VIEW_IDS = {
  dashboard: "viewDashboard",
  trends: "viewTrends",
  report: "viewReport",
  market: "viewMarket",
  settings: "viewSettings"
};

// Curated Finanzquellen-Paket (live-verified 2026-07-05, docs/MARKET-PLAN.md Appendix A).
const FEED_PACK = [
  { name: "Handelsblatt Unternehmen", url: "https://www.handelsblatt.com/contentexport/feed/unternehmen", lang: "DE" },
  { name: "DER AKTIONÄR News", url: "https://www.deraktionaer.de/aktionaer-news.rss", lang: "DE" },
  { name: "tagesschau Wirtschaft", url: "https://www.tagesschau.de/wirtschaft/index~rss2.xml", lang: "DE" },
  { name: "FAZ Wirtschaft", url: "https://www.faz.net/rss/aktuell/wirtschaft/", lang: "DE" },
  { name: "Gründerszene", url: "https://www.businessinsider.de/gruenderszene/feed/", lang: "DE" },
  { name: "Ad-hoc-Mitteilungen (EQS/DGAP)", url: "https://www.finanznachrichten.de/rss-aktien-adhoc", lang: "DE" },
  { name: "CNBC Finance", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", lang: "EN" },
  { name: "Yahoo Finance News", url: "https://finance.yahoo.com/news/rssindex", lang: "EN" },
  { name: "WSJ Markets", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", lang: "EN" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", lang: "EN" },
  { name: "EE Times", url: "https://www.eetimes.com/feed/", lang: "EN" },
  { name: "GlobeNewswire Public Companies", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies", lang: "EN" }
];

const state = {
  data: null,
  view: "dashboard",
  filters: {
    category: "All",
    month: "All",
    source: "All",
    sentiment: "All",
    search: "",
    unreadOnly: false,
    starredOnly: false,
    sort: "newest",
    watchlistId: null
  },
  page: 0,
  expandedClusters: new Set(),
  reportCategories: new Set(),
  reportCategoriesInit: false,
  currentReport: null,
  expandedInstruments: new Set(),
  priceSeries: new Map(),
  marketSearchTimer: null,
  marketSort: "score",
  resolveResults: new Map()
};

// Curated German sentiment terms (business/markets) — one-click merge in Settings.
const GERMAN_SENTIMENT = {
  positive: [
    "rekordgewinn", "gewinnsprung", "umsatzplus", "gewinnplus", "auftragseingang", "großauftrag",
    "prognose angehoben", "prognoseerhöhung", "übertrifft erwartungen", "besser als erwartet",
    "aufwärtstrend", "kursziel angehoben", "dividendenerhöhung", "aktienrückkauf", "expansion",
    "partnerschaft", "zulassung", "patent", "meilenstein", "ausgebaut", "gestärkt", "profitiert",
    "boom", "nachfrageschub", "kapazitätsausbau", "neukunde", "vertragsverlängerung", "marktführer",
    "innovationspreis", "aufgestockt", "überraschend stark", "positiv überrascht", "hochgestuft",
    "gewinnzone", "trendwende geschafft", "schneller als geplant", "ausverkauft", "rekordumsatz"
  ],
  negative: [
    "gewinnwarnung", "umsatzeinbruch", "gewinneinbruch", "prognose gesenkt", "prognosesenkung",
    "verfehlt erwartungen", "schlechter als erwartet", "stellenabbau", "entlassungen", "kurzarbeit",
    "insolvenz", "pleite", "zahlungsunfähig", "restrukturierung", "abschreibung", "wertberichtigung",
    "kursziel gesenkt", "herabgestuft", "abgestuft", "dividendenkürzung", "kartellstrafe", "bußgeld",
    "razzia", "ermittlungen", "sammelklage", "rückruf", "produktionsstopp", "lieferengpass",
    "nachfrageeinbruch", "auftragsflaute", "margendruck", "preisverfall", "schuldenlast",
    "verzögerung", "abgesagt", "gescheitert", "datenleck", "hackerangriff", "cyberangriff",
    "leerverkäufer", "bilanzskandal"
  ]
};

const els = {};
for (const id of [
  "navTabs", "lastCollected", "failuresPill", "collectButton", "resetButton",
  "sourceForm", "sourceName", "sourceUrl", "sourceType", "sourceList",
  "opmlText", "opmlFile", "importOpml",
  "manualForm", "manualTitle", "manualUrl", "manualBody",
  "watchlistForm", "watchlistName", "watchlistKeywords", "watchlistCategory", "watchlistList",
  "metricArticles", "metricSources", "metricStarred", "metricWatch",
  "briefPanel", "briefTitle", "briefMeta", "briefContent", "briefRegenerate",
  "briefForm", "briefEnabled", "briefTime", "briefLookback", "briefMaxStories", "briefPush",
  "briefGenerateNow", "briefAiHint",
  "categoryFilters", "monthFilter", "sourceFilter", "sentimentFilter", "searchInput",
  "filtersToggle", "toolbarAdvanced",
  "unreadToggle", "starredToggle", "sortSelect",
  "statusLine", "articleList", "pager",
  "categoryMix",
  "reportForm", "reportCategoryChips", "reportMonth", "reportFocus", "reportTemplate",
  "reportUseAi", "reportAiHint", "reportOutput", "reportPlaceholder", "copyReport", "downloadReport",
  "trendVolume", "trendSentiment", "trendCategories", "trendKeywords", "trendEntities",
  "trendHealth", "trendCollections",
  "collectionForm", "settingAutoCollect", "settingMaxArticles",
  "categoryRows", "addCategoryRow", "saveCategories", "reapplyCategories",
  "sentimentForm", "sentimentPositive", "sentimentNegative", "germanSentimentSeed",
  "aiForm", "aiEnabled", "aiModel", "aiMaxPer", "aiKey", "clearAiKey",
  "webhookForm", "webhookUrl", "webhookList",
  "apiToken", "generateToken", "saveToken", "tokenExample",
  "importFile", "importData", "settingsReset",
  "marketStatus", "marketSchedulerWarning", "marketRefreshButton",
  "marketSearchInput", "marketSearchResults", "marketTickerInput", "marketTickerAdd",
  "marketStarterChips", "marketInstruments",
  "marketForm", "marketEnabled", "marketMinRefresh", "marketMaxInstruments",
  "marketHistoryDays", "marketPreferXetra", "marketBenchmark",
  "marketAiMapping", "marketAlertsEnabled", "marketAlertMinScore", "webhookFormat",
  "topChancenPanel", "topChancen", "topChancenMore",
  "addAllFeeds", "feedPackList",
  "toast"
]) {
  els[id] = document.querySelector(`#${id}`);
}

init();

function init() {
  bindHeader();
  bindDashboard();
  bindMarket();
  bindSettings();
  loadState();
}

/* ---------- API + state plumbing ---------- */

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (${response.status})`);
  }
  return data;
}

async function mutate(url, options, message) {
  try {
    const data = await api(url, options);
    applyState(data);
    render();
    if (message) toast(message);
    return data;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

function applyState(data) {
  if (!data || !Array.isArray(data.articles)) return;
  state.data = data;
  const names = new Set(data.categories || []);
  if (!state.reportCategoriesInit) {
    state.reportCategories = new Set(names);
    state.reportCategoriesInit = true;
  } else {
    state.reportCategories = new Set([...state.reportCategories].filter((name) => names.has(name)));
    if (!state.reportCategories.size) state.reportCategories = new Set(names);
  }
  if (state.filters.watchlistId && !(data.watchlists || []).some((w) => w.id === state.filters.watchlistId)) {
    state.filters.watchlistId = null;
  }
  if (state.filters.category !== "All" && !names.has(state.filters.category)) {
    state.filters.category = "All";
  }
}

async function loadState() {
  try {
    const data = await api("/api/state");
    applyState(data);
    render();
  } catch (error) {
    toast(`Could not load state: ${error.message}`);
    if (els.statusLine) els.statusLine.textContent = "Server unreachable.";
  }
}

function settings() {
  return state.data.config.settings;
}

function settingsPayload(overrides = {}) {
  const current = settings();
  const payload = {
    autoCollectMinutes: current.autoCollectMinutes,
    maxArticles: current.maxArticles,
    ai: {
      enabled: !!(current.ai && current.ai.enabled),
      apiKey: "",
      model: (current.ai && current.ai.model) || "claude-opus-4-8",
      maxArticlesPerCollect: (current.ai && current.ai.maxArticlesPerCollect) || 30
    },
    market: { ...(current.market || {}) },
    brief: { ...(current.brief || {}) },
    webhooks: (current.webhooks || []).map((hook) => ({ ...hook })),
    apiToken: current.apiToken || ""
  };
  const { ai, market, brief, ...rest } = overrides;
  Object.assign(payload, rest);
  if (ai) Object.assign(payload.ai, ai);
  if (market) Object.assign(payload.market, market);
  if (brief) Object.assign(payload.brief, brief);
  return payload;
}

/* ---------- View switching + render ---------- */

function setView(view) {
  if (!VIEW_IDS[view]) return;
  state.view = view;
  for (const tab of els.navTabs.querySelectorAll(".nav-tab")) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  for (const [name, id] of Object.entries(VIEW_IDS)) {
    document.querySelector(`#${id}`).classList.toggle("active", name === view);
  }
  render();
}

function render() {
  if (!state.data) return;
  renderHeader();
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "trends") renderTrends();
  else if (state.view === "report") renderReport();
  else if (state.view === "market") renderMarket();
  else renderSettings();
}

function renderDashboard() {
  renderBrief();
  renderMetrics();
  renderSources();
  renderWatchlists();
  renderFilters();
  renderTopChancen();
  renderCategoryMix();
  renderArticles();
}

function renderBrief() {
  const brief = state.data.brief;
  if (!brief) {
    els.briefPanel.classList.add("hidden");
    return;
  }
  els.briefPanel.classList.remove("hidden");
  els.briefTitle.textContent = brief.title || "Morning Brief";
  const sourceLabel = brief.source === "ai"
    ? `AI${brief.model ? ` · ${brief.model}` : ""}`
    : "heuristic";
  const meta = [
    `${brief.storyCount} ${brief.storyCount === 1 ? "story" : "stories"}`,
    sourceLabel,
    formatDateTime(brief.generatedAt)
  ];
  if (brief.error) meta.push(`LLM skipped: ${brief.error}`);
  els.briefMeta.textContent = meta.join(" · ");
  // Server escapes all article-derived text before it reaches here (fallback + AI paths).
  els.briefContent.innerHTML = brief.html || "";
}

async function generateBriefNow(button) {
  const original = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Generating…";
  }
  try {
    const result = await api("/api/brief/generate", { method: "POST" });
    await loadState();
    const brief = result && result.brief;
    if (brief && brief.source !== "ai") {
      toast(brief.error
        ? `Brief ready (heuristic — LLM failed: ${brief.error}).`
        : "Brief ready (heuristic — no API key detected).");
    } else {
      toast("Morning brief generated.");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function renderReport() {
  renderReportControls();
}

function renderTopChancen() {
  const market = marketData();
  const top = (market.opportunities || []).slice(0, 3);
  els.topChancenPanel.classList.toggle("hidden", !market.enabled || !top.length);
  if (!top.length) return;
  els.topChancen.innerHTML = top.map((opp) => `
    <div class="top-chance-row">
      <span class="score-badge small${opp.score >= 45 ? " hot" : ""}">${opp.score}</span>
      <div class="top-chance-text">
        <strong>${escapeHtml(opp.name)}</strong>
        <span class="muted small">${escapeHtml((opp.components || []).map((c) => c.explain).filter(Boolean)[0] || opp.quadrantLabel || "")}</span>
      </div>
    </div>`).join("");
}

/* ---------- Header ---------- */

function bindHeader() {
  els.navTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-view]");
    if (tab) setView(tab.dataset.view);
  });

  els.collectButton.addEventListener("click", collectNews);
  els.resetButton.addEventListener("click", resetAll);

  els.failuresPill.addEventListener("click", () => {
    const failures = latestFailures();
    if (!failures.length) return;
    toast(failures.map((f) => `${f.name}: ${f.message}`).join("\n"), 9000);
  });
}

function latestFailures() {
  const collections = (state.data && state.data.collections) || [];
  return (collections[0] && collections[0].failures) || [];
}

function renderHeader() {
  els.lastCollected.textContent = state.data.lastCollectedAt
    ? `Collected ${formatDateTime(state.data.lastCollectedAt)}`
    : "Never collected";
  const failures = latestFailures();
  els.failuresPill.classList.toggle("hidden", !failures.length);
  if (failures.length) {
    els.failuresPill.textContent = `${failures.length} source ${failures.length === 1 ? "failure" : "failures"}`;
  }
}

async function collectNews() {
  els.collectButton.disabled = true;
  els.collectButton.textContent = "Collecting...";
  try {
    const data = await api("/api/collect", { method: "POST" });
    applyState(data);
    render();
    const added = (data.collection && data.collection.added) || 0;
    const failures = (data.collection && data.collection.failures && data.collection.failures.length) || 0;
    toast(failures
      ? `Collected ${added} new stories. ${failures} source${failures === 1 ? "" : "s"} failed - click the failures pill for details.`
      : `Collected ${added} new stories.`);
    // The market refresh runs fire-and-forget after the collect; pick up fresh quotes once.
    const market = data.market || {};
    if (market.enabled && (market.instruments || []).length) {
      clearTimeout(collectNews.marketTimer);
      collectNews.marketTimer = setTimeout(loadState, 60_000);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    els.collectButton.disabled = false;
    els.collectButton.textContent = "Collect";
  }
}

async function resetAll() {
  const confirmed = typeof confirm !== "function" ||
    confirm("Clear all sources, articles, and watchlists? This cannot be undone.");
  if (!confirmed) return;
  const data = await mutate("/api/reset", { method: "POST" });
  if (!data) return;
  state.filters = {
    category: "All", month: "All", source: "All", sentiment: "All",
    search: "", unreadOnly: false, starredOnly: false, sort: "newest", watchlistId: null
  };
  state.page = 0;
  state.expandedClusters.clear();
  els.searchInput.value = "";
  els.unreadToggle.classList.remove("active");
  els.starredToggle.classList.remove("active");
  els.sortSelect.value = "newest";
  render();
  toast("All data cleared.");
}

/* ---------- Dashboard bindings ---------- */

function bindDashboard() {
  els.sourceForm.addEventListener("submit", addSource);
  els.manualForm.addEventListener("submit", addManualBrief);
  els.watchlistForm.addEventListener("submit", addWatchlist);

  els.sourceList.addEventListener("click", onSourceListClick);
  els.watchlistList.addEventListener("click", onWatchlistListClick);
  els.articleList.addEventListener("click", onArticleListClick);

  els.opmlFile.addEventListener("change", async () => {
    const file = els.opmlFile.files[0];
    if (!file) return;
    els.opmlText.value = await file.text();
    toast(`Loaded ${file.name}. Click "Import OPML" to add sources.`);
  });
  els.importOpml.addEventListener("click", importOpml);

  els.monthFilter.addEventListener("change", () => {
    state.filters.month = els.monthFilter.value;
    resetPagination();
    renderArticles();
  });
  els.sourceFilter.addEventListener("change", () => {
    state.filters.source = els.sourceFilter.value;
    resetPagination();
    renderArticles();
  });
  els.sentimentFilter.addEventListener("change", () => {
    state.filters.sentiment = els.sentimentFilter.value;
    resetPagination();
    renderArticles();
  });
  els.searchInput.addEventListener("input", () => {
    state.filters.search = els.searchInput.value.trim().toLowerCase();
    resetPagination();
    renderArticles();
  });
  els.unreadToggle.addEventListener("click", () => {
    state.filters.unreadOnly = !state.filters.unreadOnly;
    els.unreadToggle.classList.toggle("active", state.filters.unreadOnly);
    resetPagination();
    renderArticles();
  });
  els.starredToggle.addEventListener("click", () => {
    state.filters.starredOnly = !state.filters.starredOnly;
    els.starredToggle.classList.toggle("active", state.filters.starredOnly);
    resetPagination();
    renderArticles();
  });
  els.sortSelect.addEventListener("change", () => {
    state.filters.sort = els.sortSelect.value;
    resetPagination();
    renderArticles();
  });
  els.pager.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (!Number.isInteger(page)) return;
    state.page = page;
    renderArticles();
    scrollFeedToTop();
  });

  els.filtersToggle.addEventListener("click", () => {
    const collapsed = els.toolbarAdvanced.classList.toggle("hidden");
    els.filtersToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  els.briefRegenerate.addEventListener("click", () => generateBriefNow(els.briefRegenerate));

  els.topChancenMore.addEventListener("click", () => setView("market"));

  els.reportForm.addEventListener("submit", generateReport);
  els.reportCategoryChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-category]");
    if (!chip) return;
    const name = chip.dataset.category;
    if (state.reportCategories.has(name)) state.reportCategories.delete(name);
    else state.reportCategories.add(name);
    renderReportControls();
  });
  els.copyReport.addEventListener("click", copyReport);
  els.downloadReport.addEventListener("click", downloadReport);
}

function resetPagination() {
  state.page = 0;
}

/* ---------- Sources ---------- */

async function addSource(event) {
  event.preventDefault();
  const payload = {
    name: els.sourceName.value.trim(),
    url: els.sourceUrl.value.trim(),
    type: els.sourceType.value
  };
  if (!payload.url) return toast("Add a source URL first.");
  const data = await mutate("/api/sources", { method: "POST", body: payload }, "Source added.");
  if (data) els.sourceForm.reset();
}

function renderSources() {
  const sources = state.data.sources || [];
  if (!sources.length) {
    els.sourceList.innerHTML = `<p class="muted">No sources yet. Add an RSS feed or news page above.</p>`;
    return;
  }
  els.sourceList.innerHTML = sources.map((source) => {
    const health = source.healthSummary || { status: "new", label: "New" };
    const tooltip = health.lastError || health.label || health.status;
    const pauseButton = source.type === "manual" ? "" : `
      <button type="button" data-action="pause" data-id="${escapeAttribute(source.id)}" title="${source.paused ? "Resume collection" : "Pause collection"}">${source.paused ? "Resume" : "Pause"}</button>`;
    return `
      <div class="source-item${source.paused ? " paused" : ""}">
        <div class="source-info">
          <strong>
            <span class="health-dot health-${escapeAttribute(health.status)}" title="${escapeAttribute(tooltip)}"></span>
            <span class="source-name">${escapeHtml(source.name)}</span>
          </strong>
          <span title="${escapeAttribute(source.url)}">${escapeHtml(source.type)}${source.paused ? " - paused" : ""} - ${escapeHtml(source.url)}</span>
        </div>
        <div class="source-actions">
          ${pauseButton}
          <button type="button" class="remove" data-action="delete" data-id="${escapeAttribute(source.id)}" title="Remove source" aria-label="Remove ${escapeAttribute(source.name)}">X</button>
        </div>
      </div>`;
  }).join("");
}

async function onSourceListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const source = (state.data.sources || []).find((s) => s.id === id);
  if (!source) return;
  if (button.dataset.action === "pause") {
    await mutate(`/api/sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { paused: !source.paused }
    }, source.paused ? "Source resumed." : "Source paused.");
  } else if (button.dataset.action === "delete") {
    await mutate(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }, "Source and its stories removed.");
  }
}

async function importOpml() {
  const opml = els.opmlText.value.trim();
  if (!opml) return toast("Paste OPML or choose a file first.");
  try {
    const data = await api("/api/sources/opml", { method: "POST", body: { opml } });
    applyState(data);
    render();
    toast(`Imported ${data.imported ?? 0} sources (${data.skipped ?? 0} skipped).`);
    els.opmlText.value = "";
    els.opmlFile.value = "";
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- Brief drop ---------- */

async function addManualBrief(event) {
  event.preventDefault();
  const payload = {
    title: els.manualTitle.value.trim(),
    body: els.manualBody.value.trim()
  };
  const url = els.manualUrl.value.trim();
  if (url) payload.url = url;
  if (!payload.title || !payload.body) return toast("Add a title and brief body.");
  const data = await mutate("/api/articles", { method: "POST", body: payload }, "Brief added.");
  if (data) els.manualForm.reset();
}

/* ---------- Watchlists ---------- */

async function addWatchlist(event) {
  event.preventDefault();
  const name = els.watchlistName.value.trim();
  if (!name) return toast("Give the watchlist a name.");
  const category = els.watchlistCategory.value;
  const payload = {
    name,
    keywords: splitList(els.watchlistKeywords.value),
    categories: category && category !== "Any category" ? [category] : [],
    sources: []
  };
  const data = await mutate("/api/watchlists", { method: "POST", body: payload }, "Watchlist created.");
  if (data) els.watchlistForm.reset();
}

function renderWatchlists() {
  renderSelect(els.watchlistCategory, ["Any category", ...(state.data.categories || [])], els.watchlistCategory.value);
  const watchlists = state.data.watchlists || [];
  if (!watchlists.length) {
    els.watchlistList.innerHTML = `<p class="muted">No watchlists yet. Track keywords, categories, or sources.</p>`;
    return;
  }
  const matches = state.data.watchlistMatches || {};
  els.watchlistList.innerHTML = watchlists.map((list) => {
    const count = (matches[list.id] || []).length;
    const active = state.filters.watchlistId === list.id;
    const detailParts = [];
    if ((list.keywords || []).length) detailParts.push(list.keywords.join(", "));
    if ((list.categories || []).length) detailParts.push(list.categories.join(", "));
    return `
      <div class="watchlist-item${active ? " active" : ""}">
        <button type="button" class="watchlist-main" data-action="filter" data-id="${escapeAttribute(list.id)}" title="${active ? "Clear watchlist filter" : "Filter stories to this watchlist"}">
          <strong>${escapeHtml(list.name)}</strong>
          <span>${escapeHtml(detailParts.join(" - ") || "All stories")}</span>
        </button>
        <span class="chip watchlist-count">${count}</span>
        <button type="button" class="remove" data-action="delete" data-id="${escapeAttribute(list.id)}" title="Delete watchlist" aria-label="Delete ${escapeAttribute(list.name)}">X</button>
      </div>`;
  }).join("");
}

async function onWatchlistListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === "filter") {
    state.filters.watchlistId = state.filters.watchlistId === id ? null : id;
    resetPagination();
    renderWatchlists();
    renderArticles();
  } else if (button.dataset.action === "delete") {
    await mutate(`/api/watchlists/${encodeURIComponent(id)}`, { method: "DELETE" }, "Watchlist deleted.");
  }
}

/* ---------- Metrics + filters ---------- */

function renderMetrics() {
  const analytics = state.data.analytics || {};
  const starred = (state.data.articles || []).filter((a) => a.starred).length;
  els.metricArticles.textContent = analytics.totalArticles || 0;
  els.metricSources.textContent = analytics.totalSources || 0;
  els.metricStarred.textContent = starred;
  els.metricWatch.textContent = (analytics.sentimentTotals && analytics.sentimentTotals.watch) || 0;
}

function renderFilters() {
  const categories = ["All", ...(state.data.categories || [])];
  els.categoryFilters.innerHTML = categories.map((category) => `
    <button type="button" class="segment${state.filters.category === category ? " active" : ""}" data-category="${escapeAttribute(category)}">${escapeHtml(category)}</button>
  `).join("");
  for (const button of els.categoryFilters.querySelectorAll("[data-category]")) {
    button.addEventListener("click", () => {
      state.filters.category = button.dataset.category;
      resetPagination();
      renderFilters();
      renderArticles();
    });
  }

  renderSelect(els.monthFilter, ["All", ...(state.data.months || [])], state.filters.month);
  state.filters.month = els.monthFilter.value;
  renderSelect(els.sourceFilter, ["All", ...(state.data.sources || []).map((s) => s.name)], state.filters.source);
  state.filters.source = els.sourceFilter.value;
  els.sentimentFilter.value = state.filters.sentiment;
  els.sortSelect.value = state.filters.sort;
}

function renderCategoryMix() {
  const totals = (state.data.analytics && state.data.analytics.totalsByCategory) || {};
  const max = Math.max(1, ...Object.values(totals));
  const rows = Object.entries(totals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);

  els.categoryMix.innerHTML = rows.length
    ? rows.map(([category, value]) => `
      <div class="bar-row">
        <div class="bar-label"><span>${escapeHtml(category)}</span><span>${value}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width: ${Math.round((value / max) * 100)}%"></div></div>
      </div>
    `).join("")
    : `<p class="muted">No categorized stories.</p>`;
}

/* ---------- Articles ---------- */

function filteredArticles() {
  const f = state.filters;
  const matchSet = f.watchlistId
    ? new Set((state.data.watchlistMatches || {})[f.watchlistId] || [])
    : null;
  const list = (state.data.articles || []).filter((article) => {
    if (matchSet && !matchSet.has(article.id)) return false;
    if (f.category !== "All" && article.category !== f.category) return false;
    if (f.month !== "All" && article.monthKey !== f.month) return false;
    if (f.source !== "All" && article.sourceName !== f.source) return false;
    if (f.sentiment !== "All" && article.sentiment !== f.sentiment) return false;
    if (f.unreadOnly && article.read) return false;
    if (f.starredOnly && !article.starred) return false;
    if (f.search) {
      const haystack = `${article.title} ${article.summary} ${(article.keywords || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(f.search)) return false;
    }
    return true;
  });
  list.sort((a, b) => {
    const delta = new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime();
    return f.sort === "oldest" ? delta : -delta;
  });
  return list;
}

function groupArticles(list) {
  const groups = [];
  const byCluster = new Map();
  for (const article of list) {
    if (article.clusterId) {
      const existing = byCluster.get(article.clusterId);
      if (existing) {
        existing.related.push(article);
        continue;
      }
      const group = { primary: article, related: [] };
      byCluster.set(article.clusterId, group);
      groups.push(group);
    } else {
      groups.push({ primary: article, related: [] });
    }
  }
  return groups;
}

function renderArticles() {
  updateFiltersButton();
  const list = filteredArticles();
  const total = (state.data.articles || []).length;
  const watchlist = state.filters.watchlistId
    ? (state.data.watchlists || []).find((w) => w.id === state.filters.watchlistId)
    : null;

  if (!list.length) {
    els.statusLine.textContent = watchlist
      ? `No stories in watchlist "${watchlist.name}".`
      : "No stories match these filters.";
    els.articleList.innerHTML = `<article class="article-card empty"><h3>No stories match these filters.</h3><p>Try another category, month, source, sentiment, or search term.</p></article>`;
    renderPager(0, 1);
    return;
  }

  const groups = groupArticles(list);
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  // Clamp: a filter change can shrink the result below the current page.
  state.page = Math.min(Math.max(state.page, 0), totalPages - 1);
  const start = state.page * PAGE_SIZE;
  const pageGroups = groups.slice(start, start + PAGE_SIZE);

  const filtered = list.length !== total;
  const scope = filtered
    ? `${list.length} matching · ${total} total${watchlist ? ` · watchlist: ${watchlist.name}` : ""}`
    : `${total} ${total === 1 ? "story" : "stories"}`;
  els.statusLine.textContent = `Page ${state.page + 1} of ${totalPages} · ${scope}`;

  els.articleList.innerHTML = pageGroups.map(articleGroupHtml).join("");
  renderPager(state.page, totalPages);
}

// Windowed page list: first, last, and a ±1 window around the current page, with "…" gaps.
function pageWindow(current, total) {
  const wanted = new Set([0, total - 1, current, current - 1, current + 1]);
  const pages = [...wanted].filter((p) => p >= 0 && p < total).sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const p of pages) {
    if (prev !== -1 && p - prev > 1) out.push("gap");
    out.push(p);
    prev = p;
  }
  return out;
}

function renderPager(current, totalPages) {
  if (totalPages <= 1) {
    els.pager.classList.add("hidden");
    els.pager.innerHTML = "";
    return;
  }
  els.pager.classList.remove("hidden");
  const parts = [
    `<button type="button" class="pager-btn pager-step" data-page="${current - 1}" ${current === 0 ? "disabled" : ""} aria-label="Previous page">‹ Prev</button>`
  ];
  for (const entry of pageWindow(current, totalPages)) {
    if (entry === "gap") {
      parts.push(`<span class="pager-gap" aria-hidden="true">…</span>`);
      continue;
    }
    const isActive = entry === current;
    parts.push(`<button type="button" class="pager-btn${isActive ? " active" : ""}" data-page="${entry}"${isActive ? ' aria-current="page"' : ""}>${entry + 1}</button>`);
  }
  parts.push(`<button type="button" class="pager-btn pager-step" data-page="${current + 1}" ${current >= totalPages - 1 ? "disabled" : ""} aria-label="Next page">Next ›</button>`);
  els.pager.innerHTML = parts.join("");
}

function scrollFeedToTop() {
  const anchor = document.querySelector(".content-column") || els.articleList;
  if (anchor && typeof anchor.scrollIntoView === "function") {
    anchor.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function updateFiltersButton() {
  if (!els.filtersToggle) return;
  const f = state.filters;
  const activeCount =
    (f.month !== "All" ? 1 : 0) +
    (f.source !== "All" ? 1 : 0) +
    (f.sentiment !== "All" ? 1 : 0) +
    (f.unreadOnly ? 1 : 0) +
    (f.starredOnly ? 1 : 0) +
    (f.sort !== "newest" ? 1 : 0);
  els.filtersToggle.textContent = activeCount ? `Filters (${activeCount})` : "Filters";
  els.filtersToggle.classList.toggle("has-active", activeCount > 0);
}

function articleGroupHtml(group) {
  const article = group.primary;
  const related = group.related;
  const isHttp = /^https?:\/\//i.test(article.url || "");
  const sentimentClass = article.sentiment === "watch" ? "watch" : article.sentiment === "positive" ? "positive" : "";
  // Only surface sentiment when it carries a signal — "neutral" is the silent majority and just adds noise.
  const sentimentChip = sentimentClass
    ? `<span class="chip ${sentimentClass}">${escapeHtml(article.sentiment)}</span>`
    : "";
  const titleHtml = isHttp
    ? `<a href="${escapeAttribute(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`
    : escapeHtml(article.title);
  const expanded = article.clusterId ? state.expandedClusters.has(article.clusterId) : false;

  let clusterHtml = "";
  if (related.length) {
    const label = expanded ? "Hide related coverage" : `+${related.length} related coverage`;
    clusterHtml = `
      <button type="button" class="cluster-toggle" data-action="toggle-cluster" data-cluster="${escapeAttribute(article.clusterId)}">${label}</button>
      ${expanded ? `<div class="cluster-related">${related.map(relatedItemHtml).join("")}</div>` : ""}`;
  }

  const fullTextButton = isHttp
    ? `<button type="button" class="ghost-button small" data-action="fulltext" data-id="${escapeAttribute(article.id)}" ${article.fullTextFetched ? "disabled" : ""}>${article.fullTextFetched ? "Full text fetched" : "Full text"}</button>`
    : "";

  return `
    <article class="article-card${article.read ? " read" : ""}">
      <div class="article-topline">
        <span class="topline-meta">${escapeHtml(article.sourceName)} · ${formatDate(article.publishedAt)} · ${Number(article.readingMinutes) || 1} min</span>
        <span class="card-flags">
          ${sentimentChip}
          ${article.aiEnriched ? `<span class="badge-ai" title="Enriched by AI">AI</span>` : ""}
        </span>
      </div>
      <h3>${titleHtml}</h3>
      <p class="article-summary">${escapeHtml(article.summary)}</p>
      <div class="card-footer">
        <span class="chip category">${escapeHtml(article.category)}</span>
        <div class="card-actions">
          <button type="button" class="ghost-button small${article.read ? " active" : ""}" data-action="toggle-read" data-id="${escapeAttribute(article.id)}">${article.read ? "Read" : "Mark read"}</button>
          <button type="button" class="ghost-button small${article.starred ? " active" : ""}" data-action="toggle-star" data-id="${escapeAttribute(article.id)}">${article.starred ? "Starred" : "Star"}</button>
          ${fullTextButton}
        </div>
      </div>
      ${clusterHtml}
    </article>`;
}

function relatedItemHtml(article) {
  const isHttp = /^https?:\/\//i.test(article.url || "");
  const titleHtml = isHttp
    ? `<a href="${escapeAttribute(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`
    : escapeHtml(article.title);
  return `
    <div class="related-item${article.read ? " read" : ""}">
      <span class="related-source">${escapeHtml(article.sourceName)} - ${formatDate(article.publishedAt)}</span>
      <span>${titleHtml}</span>
    </div>`;
}

async function onArticleListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "toggle-cluster") {
    const clusterId = button.dataset.cluster;
    if (state.expandedClusters.has(clusterId)) state.expandedClusters.delete(clusterId);
    else state.expandedClusters.add(clusterId);
    renderArticles();
    return;
  }

  const id = button.dataset.id;
  const article = (state.data.articles || []).find((a) => a.id === id);
  if (!article) return;

  if (action === "toggle-read") {
    await mutate(`/api/articles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { read: !article.read }
    });
  } else if (action === "toggle-star") {
    await mutate(`/api/articles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { starred: !article.starred }
    });
  } else if (action === "fulltext") {
    button.disabled = true;
    button.textContent = "Fetching...";
    const data = await mutate(`/api/articles/${encodeURIComponent(id)}/fulltext`, { method: "POST" }, "Full text fetched and re-enriched.");
    if (!data) {
      button.disabled = false;
      button.textContent = "Full text";
    }
  }
}

/* ---------- Report Studio ---------- */

function aiReportAvailable() {
  const ai = settings().ai || {};
  return !!(ai.apiKeyConfigured && ai.enabled);
}

function renderReportControls() {
  const categories = state.data.categories || [];
  els.reportCategoryChips.innerHTML = categories.map((category) => `
    <button type="button" class="segment${state.reportCategories.has(category) ? " active" : ""}" data-category="${escapeAttribute(category)}">${escapeHtml(category)}</button>
  `).join("");

  renderSelect(els.reportMonth, ["All", ...(state.data.months || [])], els.reportMonth.value);

  const available = aiReportAvailable();
  els.reportUseAi.disabled = !available;
  if (!available) els.reportUseAi.checked = false;
  els.reportAiHint.textContent = available ? "" : "Enable AI and configure an API key in Settings to add a narrative.";
}

async function generateReport(event) {
  event.preventDefault();
  const categories = [...state.reportCategories];
  if (!categories.length) return toast("Select at least one report category.");
  const payload = {
    categories,
    month: els.reportMonth.value || "All",
    focus: els.reportFocus.value,
    template: els.reportTemplate.value,
    useAi: !!(els.reportUseAi.checked && !els.reportUseAi.disabled)
  };
  const submit = els.reportForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const report = await api("/api/reports", { method: "POST", body: payload });
    state.currentReport = report;
    els.reportOutput.innerHTML = report.html || "";
    els.reportOutput.classList.add("visible");
    if (els.reportPlaceholder) els.reportPlaceholder.classList.add("hidden");
    els.copyReport.disabled = false;
    els.downloadReport.disabled = false;
    if (report.meta && report.meta.aiError) {
      toast(`Report ready. AI narrative skipped: ${report.meta.aiError}`, 7000);
    } else {
      toast(`Report ready (${(report.meta && report.meta.storyCount) ?? "?"} stories).`);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function copyReport() {
  if (!state.currentReport) return;
  try {
    await navigator.clipboard.writeText(state.currentReport.markdown);
    toast("Report markdown copied.");
  } catch {
    toast("Clipboard unavailable in this browser.");
  }
}

function downloadReport() {
  if (!state.currentReport) return;
  const blob = new Blob([state.currentReport.markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const slug = String(state.currentReport.title || "news-report")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "news-report";
  link.download = `${slug}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------- Trends view ---------- */

function renderTrends() {
  const trends = state.data.trends || {};
  const byMonth = trends.byMonth || [];
  renderTrendVolume(byMonth);
  renderTrendCategories(byMonth);
  renderTrendSentiment(byMonth);
  renderTrendKeywords(trends.risingKeywords || []);
  renderTrendEntities(trends.topEntities || {});
  renderTrendHealth();
  renderTrendCollections();
}

function renderTrendVolume(byMonth) {
  if (!byMonth.length) {
    els.trendVolume.innerHTML = `<p class="muted">No monthly data yet. Collect some stories first.</p>`;
    return;
  }
  const max = Math.max(1, ...byMonth.map((m) => m.total));
  els.trendVolume.innerHTML = byMonth.map((m) => `
    <div class="bar-row">
      <div class="bar-label"><span>${escapeHtml(formatMonth(m.month))}</span><span>${m.total}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width: ${Math.round((m.total / max) * 100)}%"></div></div>
    </div>
  `).join("");
}

function renderTrendCategories(byMonth) {
  if (!byMonth.length) {
    els.trendCategories.innerHTML = `<p class="muted">No category trends yet.</p>`;
    return;
  }
  const totals = {};
  for (const m of byMonth) {
    for (const [name, count] of Object.entries(m.byCategory || {})) {
      totals[name] = (totals[name] || 0) + count;
    }
  }
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  if (!top.length) {
    els.trendCategories.innerHTML = `<p class="muted">No category trends yet.</p>`;
    return;
  }
  const legend = top.map((name, i) => `
    <span class="legend-item"><span class="legend-swatch" style="background: ${TREND_PALETTE[i % TREND_PALETTE.length]}"></span>${escapeHtml(name)}</span>
  `).join("");
  els.trendCategories.innerHTML = buildTrendSvg(byMonth, top) + `<div class="trend-legend">${legend}</div>`;
}

function buildTrendSvg(byMonth, categories) {
  const width = 680;
  const height = 240;
  const pad = { top: 14, right: 16, bottom: 30, left: 36 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...byMonth.flatMap((m) => categories.map((c) => (m.byCategory || {})[c] || 0)));
  const xAt = (i) => byMonth.length > 1
    ? pad.left + (i / (byMonth.length - 1)) * innerWidth
    : pad.left + innerWidth / 2;
  const yAt = (v) => pad.top + innerHeight - (v / max) * innerHeight;

  const parts = [];
  for (const frac of [0, 0.5, 1]) {
    const y = pad.top + innerHeight - frac * innerHeight;
    parts.push(`<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`);
    parts.push(`<text x="${pad.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#aaa79f">${Math.round(max * frac)}</text>`);
  }
  const labelStep = byMonth.length > 8 ? 2 : 1;
  byMonth.forEach((m, i) => {
    if (i % labelStep !== 0 && i !== byMonth.length - 1) return;
    parts.push(`<text x="${xAt(i).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="#aaa79f">${escapeHtml(formatMonth(m.month))}</text>`);
  });
  categories.forEach((name, idx) => {
    const color = TREND_PALETTE[idx % TREND_PALETTE.length];
    const points = byMonth
      .map((m, i) => `${xAt(i).toFixed(1)},${yAt((m.byCategory || {})[name] || 0).toFixed(1)}`)
      .join(" ");
    parts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    byMonth.forEach((m, i) => {
      const value = (m.byCategory || {})[name] || 0;
      parts.push(`<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(value).toFixed(1)}" r="2.6" fill="${color}"><title>${escapeHtml(`${name} - ${formatMonth(m.month)}: ${value}`)}</title></circle>`);
    });
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Category trends by month" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`;
}

function renderTrendSentiment(byMonth) {
  if (!byMonth.length) {
    els.trendSentiment.innerHTML = `<p class="muted">No sentiment data yet.</p>`;
    return;
  }
  els.trendSentiment.innerHTML = byMonth.map((m) => {
    const s = m.sentiment || { positive: 0, neutral: 0, watch: 0 };
    const total = Math.max(1, (s.positive || 0) + (s.neutral || 0) + (s.watch || 0));
    const pct = (n) => ((n || 0) / total * 100).toFixed(1);
    const tooltip = `positive ${s.positive || 0} - neutral ${s.neutral || 0} - watch ${s.watch || 0}`;
    return `
      <div class="sentiment-row">
        <span class="sentiment-month">${escapeHtml(formatMonth(m.month))}</span>
        <div class="sentiment-bar" title="${escapeAttribute(tooltip)}">
          <div class="seg positive" style="width: ${pct(s.positive)}%"></div>
          <div class="seg neutral" style="width: ${pct(s.neutral)}%"></div>
          <div class="seg watch" style="width: ${pct(s.watch)}%"></div>
        </div>
      </div>`;
  }).join("");
}

function renderTrendKeywords(risingKeywords) {
  if (!risingKeywords.length) {
    els.trendKeywords.innerHTML = `<p class="muted">No rising keywords for the latest month yet.</p>`;
    return;
  }
  els.trendKeywords.innerHTML = risingKeywords.map((k) => `
    <div class="keyword-row">
      <span>${escapeHtml(k.keyword)} <span class="keyword-count">${k.current} now / ${k.previous} prior</span></span>
      <span class="keyword-growth">x${Number(k.growth || 0).toFixed(1)}</span>
    </div>
  `).join("");
}

function renderTrendEntities(topEntities) {
  const columns = [
    ["People", topEntities.people || []],
    ["Organizations", topEntities.orgs || []],
    ["Places", topEntities.places || []]
  ];
  const hasAny = columns.some(([, items]) => items.length);
  if (!hasAny) {
    els.trendEntities.innerHTML = `<p class="muted">No entities extracted for the latest month yet.</p>`;
    return;
  }
  els.trendEntities.innerHTML = columns.map(([label, items]) => `
    <div class="entity-col">
      <h3>${escapeHtml(label)}</h3>
      ${items.length
        ? `<ul>${items.map((e) => `<li>${escapeHtml(e.name)} <span>${e.count}</span></li>`).join("")}</ul>`
        : `<p class="muted small">None yet.</p>`}
    </div>
  `).join("");
}

function renderTrendHealth() {
  const sources = state.data.sources || [];
  if (!sources.length) {
    els.trendHealth.innerHTML = `<p class="muted">No sources configured.</p>`;
    return;
  }
  const rows = sources.map((source) => {
    const health = source.healthSummary || {};
    const status = health.status || "new";
    const label = health.label || status;
    const lastError = health.lastError || "";
    return `
      <tr>
        <td>${escapeHtml(source.name)}</td>
        <td><span class="status-cell"><span class="health-dot health-${escapeAttribute(status)}"></span>${escapeHtml(label)}</span></td>
        <td>${health.successCount ?? 0}</td>
        <td>${health.failureCount ?? 0}</td>
        <td>${health.lastSuccessAt ? formatDateTime(health.lastSuccessAt) : "-"}</td>
        <td class="wrap" title="${escapeAttribute(lastError)}">${escapeHtml(truncateText(lastError, 90)) || "-"}</td>
      </tr>`;
  }).join("");
  els.trendHealth.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Source</th><th>Status</th><th>OK</th><th>Fail</th><th>Last success</th><th>Last error</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTrendCollections() {
  const collections = (state.data.collections || []).slice(0, 10);
  if (!collections.length) {
    els.trendCollections.innerHTML = `<p class="muted">No collection runs yet. Hit Collect to start.</p>`;
    return;
  }
  els.trendCollections.innerHTML = collections.map((c) => {
    const failures = (c.failures || []).length;
    return `
      <div class="log-row">
        <span>${formatDateTime(c.at)}</span>
        <span class="log-added">+${c.added ?? 0} added</span>
        <span>${c.attempted ?? 0} attempted</span>
        <span class="${failures ? "log-failures" : ""}" title="${escapeAttribute((c.failures || []).map((f) => `${f.name}: ${f.message}`).join("\n"))}">${failures} failure${failures === 1 ? "" : "s"}</span>
        <span>${((c.durationMs ?? 0) / 1000).toFixed(1)}s${c.aiEnriched ? ` - ${c.aiEnriched} AI` : ""}</span>
      </div>`;
  }).join("");
}

/* ---------- Market view ---------- */

function marketData() {
  return (state.data && state.data.market) || { enabled: false, instruments: [] };
}

function bindMarket() {
  els.marketRefreshButton.addEventListener("click", refreshMarket);

  els.marketSearchInput.addEventListener("input", () => {
    clearTimeout(state.marketSearchTimer);
    const query = els.marketSearchInput.value.trim();
    if (query.length < 2) {
      els.marketSearchResults.classList.add("hidden");
      return;
    }
    state.marketSearchTimer = setTimeout(() => runMarketSearch(query), 350);
  });

  els.marketSearchResults.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-ticker]");
    if (!button) return;
    els.marketSearchResults.classList.add("hidden");
    els.marketSearchInput.value = "";
    await addInstrument(button.dataset.ticker);
  });

  els.marketTickerAdd.addEventListener("click", async () => {
    const ticker = els.marketTickerInput.value.trim();
    if (!ticker) return toast("Ticker eingeben, z.B. IFX.DE");
    const data = await addInstrument(ticker);
    if (data) els.marketTickerInput.value = "";
  });

  els.marketStarterChips.addEventListener("click", (event) => {
    const chip = event.target.closest("button[data-query]");
    if (!chip) return;
    els.marketSearchInput.value = chip.dataset.query;
    els.marketSearchInput.focus();
    runMarketSearch(chip.dataset.query);
  });

  els.marketInstruments.addEventListener("click", onMarketCardClick);
}

async function runMarketSearch(query) {
  els.marketSearchResults.innerHTML = `<p class="muted small">Suche …</p>`;
  els.marketSearchResults.classList.remove("hidden");
  try {
    const data = await api(`/api/market/lookup?q=${encodeURIComponent(query)}`);
    const tracked = new Set(marketData().instruments.map((i) => i.ticker));
    const results = (data.results || []).slice(0, 8);
    els.marketSearchResults.innerHTML = results.length
      ? results.map((result) => `
        <button type="button" data-ticker="${escapeAttribute(result.ticker)}" ${tracked.has(result.ticker) ? "disabled" : ""}>
          <strong>${escapeHtml(result.ticker)}</strong>
          <span>${escapeHtml(result.name)}</span>
          <span class="muted small">${escapeHtml(result.exchange)}${tracked.has(result.ticker) ? " — watched" : ""}</span>
        </button>`).join("")
      : `<p class="muted small">No listed matches.</p>`;
  } catch (error) {
    els.marketSearchResults.innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
  }
}

async function addInstrument(ticker) {
  const data = await mutate("/api/market/instruments", {
    method: "POST",
    body: { ticker }
  });
  if (data) toast(data.message || `${ticker} added.`);
  return data;
}

async function refreshMarket() {
  els.marketRefreshButton.disabled = true;
  els.marketRefreshButton.textContent = "Aktualisiere …";
  try {
    const data = await api("/api/market/refresh", { method: "POST" });
    applyState(data);
    render();
    toast(data.message || "Prices refreshed.");
  } catch (error) {
    toast(error.message);
  } finally {
    els.marketRefreshButton.disabled = false;
    els.marketRefreshButton.textContent = "Refresh prices";
  }
}

async function onMarketCardClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const ticker = button.dataset.ticker;
  const action = button.dataset.action;

  if (action === "sort") {
    state.marketSort = button.dataset.sort;
    renderMarketBody();
    return;
  }

  const entityName = button.dataset.name;
  if (action === "resolve") {
    state.resolveResults.set(entityName, "loading");
    renderMarketBody();
    try {
      const result = await api("/api/market/resolve", { method: "POST", body: { name: entityName } });
      state.resolveResults.set(entityName, result);
    } catch (error) {
      state.resolveResults.delete(entityName);
      toast(error.message);
    }
    renderMarketBody();
    return;
  }
  if (action === "track") {
    state.resolveResults.delete(entityName);
    await mutate("/api/market/mappings", {
      method: "POST",
      body: { name: entityName, action: "track", ticker: button.dataset.ticker }
    });
    return;
  }
  if (action === "map-seed") {
    const resolved = state.resolveResults.get(entityName);
    const seed = resolved && resolved.seed;
    state.resolveResults.delete(entityName);
    if (seed && seed.status === "subsidiary" && seed.ticker) {
      await mutate("/api/market/mappings", {
        method: "POST",
        body: { name: entityName, action: "map", status: "subsidiary", ticker: seed.ticker, parent: seed.parent || "", note: seed.note || "" }
      });
    } else {
      await mutate("/api/market/mappings", {
        method: "POST",
        body: { name: entityName, action: "map", status: "private",
          relatedTickers: (seed && seed.relatedTickers) || [], note: (seed && seed.note) || "" }
      });
    }
    return;
  }
  if (action === "map-private") {
    state.resolveResults.delete(entityName);
    await mutate("/api/market/mappings", {
      method: "POST",
      body: { name: entityName, action: "map", status: "private" }
    }, "Marked as not listed.");
    return;
  }
  if (action === "ignore-entity") {
    state.resolveResults.delete(entityName);
    await mutate("/api/market/mappings", {
      method: "POST",
      body: { name: entityName, action: "ignore" }
    });
    return;
  }
  if (action === "confirm-mapping") {
    await mutate("/api/market/mappings", {
      method: "POST",
      body: { name: entityName, action: "confirm" }
    });
    return;
  }
  if (action === "remove-mapping") {
    await mutate(`/api/market/mappings/${encodeURIComponent(entityName)}`, { method: "DELETE" },
      "Mapping removed.");
    return;
  }
  if (action === "narrative") {
    button.disabled = true;
    button.textContent = "Denkt nach …";
    try {
      const result = await api(`/api/market/narratives/${encodeURIComponent(ticker)}`, { method: "POST" });
      toast(result.cached ? "AI assessment (cached)." : "AI assessment created.");
      await loadState();
    } catch (error) {
      toast(error.message);
      renderMarketBody();
    }
    return;
  }

  const noteField = document.querySelector(`textarea[data-note-for="${CSS.escape(ticker || "")}"]`);
  const note = noteField ? noteField.value.trim() : undefined;

  if (action === "pin" || action === "dismiss") {
    const body = { status: action === "pin" ? "pinned" : "dismissed" };
    if (note !== undefined) body.note = note;
    state.expandedInstruments.delete(ticker);
    await mutate(`/api/market/ideas/${encodeURIComponent(ticker)}`, { method: "POST", body },
      action === "pin" ? `${ticker} pinned.` : `${ticker} dismissed — reappears when the facts change.`);
    return;
  }
  if (action === "unpin") {
    await mutate(`/api/market/ideas/${encodeURIComponent(ticker)}`, {
      method: "POST",
      body: { status: "none" }
    }, `${ticker} back in the normal feed.`);
    return;
  }

  if (action === "toggle-detail") {
    if (state.expandedInstruments.has(ticker)) {
      state.expandedInstruments.delete(ticker);
      renderMarket();
      return;
    }
    state.expandedInstruments.add(ticker);
    renderMarket();
    if (!state.priceSeries.has(ticker)) {
      try {
        const series = await api(`/api/market/prices/${encodeURIComponent(ticker)}`);
        state.priceSeries.set(ticker, series);
      } catch {
        state.priceSeries.set(ticker, null);
      }
      renderMarket();
    }
  } else if (action === "pause") {
    const instrument = marketData().instruments.find((i) => i.ticker === ticker);
    if (!instrument) return;
    await mutate(`/api/market/instruments/${encodeURIComponent(ticker)}`, {
      method: "PATCH",
      body: { paused: !instrument.paused }
    }, instrument.paused ? `${ticker} wieder aktiv.` : `${ticker} pausiert.`);
  } else if (action === "delete") {
    const confirmed = typeof confirm !== "function" ||
      confirm(`Remove ${ticker} and its price data?`);
    if (!confirmed) return;
    state.priceSeries.delete(ticker);
    state.expandedInstruments.delete(ticker);
    await mutate(`/api/market/instruments/${encodeURIComponent(ticker)}`, { method: "DELETE" },
      `${ticker} entfernt.`);
  }
}

function renderMarket() {
  const market = marketData();
  const s = settings();

  els.marketSchedulerWarning.classList.toggle("hidden",
    !(market.enabled && (s.autoCollectMinutes ?? 0) === 0));

  const health = market.providerHealth || {};
  if (market.marketRefreshing) {
    els.marketStatus.textContent = "Refreshing prices …";
  } else if (health.cooldownUntil && Date.parse(health.cooldownUntil) > Date.now()) {
    els.marketStatus.textContent = `Rate-limited — erneut ab ${formatDateTime(health.cooldownUntil)}`;
    els.marketStatus.title = health.lastError || "";
  } else if (market.lastRefreshAt) {
    const anyStale = (market.instruments || []).some((i) => i.stale && !i.paused);
    els.marketStatus.textContent =
      `Prices: Yahoo (EOD/delayed) · as of ${formatDateTime(market.lastRefreshAt)}${anyStale ? " · partly stale" : ""}`;
    els.marketStatus.title = health.lastError || "";
  } else {
    els.marketStatus.textContent = "No price data yet — add an instrument and refresh";
  }
  els.marketRefreshButton.disabled = market.marketRefreshing === true;

  renderMarketStarterChips();
  renderMarketBody();
}

function renderMarketStarterChips() {
  const market = marketData();
  if ((market.instruments || []).length) {
    els.marketStarterChips.innerHTML = "";
    return;
  }
  const orgs = ((state.data.trends || {}).topEntities || {}).orgs || [];
  els.marketStarterChips.innerHTML = orgs.length
    ? `<span class="muted small">In deinen News gefunden:</span>` + orgs.slice(0, 5).map((org) => `
      <button type="button" class="segment" data-query="${escapeAttribute(org.name)}">${escapeHtml(org.name)}</button>
    `).join("")
    : "";
}

function renderMarketBody() {
  const market = marketData();
  const instruments = market.instruments || [];

  if (!market.enabled) {
    els.marketInstruments.innerHTML =
      `<article class="article-card"><h3>Market data is disabled.</h3><p>Enable it in Settings under "Market".</p></article>`;
    return;
  }
  if (!instruments.length) {
    els.marketInstruments.innerHTML = `
      <article class="article-card">
        <h3>No watched instruments yet.</h3>
        <p>Search for a company above — its prices are pulled in automatically. Tip: for mega-caps like
        NVIDIA or SAP, "the market hasn't reacted yet" is least likely; the real value is in smaller
        names surfacing from your own feeds.</p>
      </article>`;
    return;
  }

  const instrumentByTicker = new Map(instruments.map((i) => [i.ticker, i]));
  const parts = [];

  // Merkliste — pinned ideas float regardless of score.
  const pinned = (market.ideas || []).filter((idea) => idea.status === "pinned");
  if (pinned.length) {
    parts.push(`<section class="market-section"><h3 class="market-section-title">Merkliste</h3>
      <div class="merkliste">${pinned.map((idea) => {
        const instrument = instrumentByTicker.get(idea.ticker);
        const opp = (market.opportunities || []).find((o) => o.ticker === idea.ticker);
        return `
          <div class="merkliste-item">
            <strong>${escapeHtml(instrument ? instrument.name : idea.ticker)}</strong>
            <span class="market-ticker">${escapeHtml(idea.ticker)}</span>
            ${opp ? `<span class="score-badge small${opp.score >= 45 ? " hot" : ""}">${opp.score}</span>` : ""}
            ${idea.note ? `<span class="muted small merkliste-note" title="${escapeAttribute(idea.note)}">${escapeHtml(idea.note)}</span>` : ""}
            <button type="button" class="ghost-button small" data-action="unpin" data-ticker="${escapeAttribute(idea.ticker)}">Unpin</button>
          </div>`;
      }).join("")}</div></section>`);
  }

  // Opportunities — the scored feed.
  let opportunities = [...(market.opportunities || [])];
  if (state.marketSort === "size") {
    const order = { small: 0, mid: 1, large: 2 };
    opportunities.sort((a, b) =>
      (order[a.sizeHint] ?? 3) - (order[b.sizeHint] ?? 3) || b.score - a.score);
  }
  const sortToggle = `
    <div class="segmented small-seg">
      <button type="button" class="segment${state.marketSort === "score" ? " active" : ""}" data-action="sort" data-sort="score">Score</button>
      <button type="button" class="segment${state.marketSort === "size" ? " active" : ""}" data-action="sort" data-sort="size">Nebenwerte zuerst</button>
    </div>`;
  parts.push(`<section class="market-section">
    <div class="market-section-head"><h3 class="market-section-title">Opportunities</h3>${opportunities.length > 1 ? sortToggle : ""}</div>
    ${opportunities.length
      ? `<div class="market-grid">${opportunities.map((opp) => opportunityCardHtml(opp, instrumentByTicker.get(opp.ticker), market)).join("")}</div>`
      : `<p class="muted">No scored opportunities yet — signals need enough stories, a baseline, and price history per instrument (see Watching below).</p>`}
  </section>`);

  // Watching — unscored instruments with their reason, still fully useful cards.
  const unscored = market.unscored || [];
  if (unscored.length) {
    parts.push(`<section class="market-section"><h3 class="market-section-title">Watching</h3>
      <div class="market-grid">${unscored.map((entry) => {
        const instrument = instrumentByTicker.get(entry.ticker);
        return instrument ? watchCardHtml(instrument, market, entry) : "";
      }).join("")}</div></section>`);
  }

  // Contrarian — collapsed, deliberately out of the main feed.
  const contrarian = market.contrarian || [];
  if (contrarian.length) {
    parts.push(`<details class="market-section contrarian-details">
      <summary>Contrarian / abgestraft (${contrarian.length})</summary>
      <div class="market-grid">${contrarian.map((opp) => opportunityCardHtml(opp, instrumentByTicker.get(opp.ticker), market)).join("")}</div>
    </details>`);
  }

  // New in your news — the discovery lane, independent of any score.
  const newNames = market.newNames || [];
  if (newNames.length) {
    parts.push(`<section class="market-section"><h3 class="market-section-title">New in your news</h3>
      <div class="mapping-list">${newNames.map((entry) => mappingRowHtml(entry, market, { isNew: true })).join("")}</div>
    </section>`);
  }

  // Look-back — calibration, not performance claims: past scores vs realized returns.
  const review = (market.signalReview || []).filter((entry) => entry.entries.length);
  if (review.length) {
    const rows = review.flatMap((logEntry) => logEntry.entries.map((entry) => `
      <tr>
        <td>${formatDate(logEntry.at)}</td>
        <td>${escapeHtml(entry.ticker)}</td>
        <td>${entry.score}</td>
        <td class="${entry.fwdReturn5d > 0 ? "positive" : entry.fwdReturn5d < 0 ? "negative" : ""}">${entry.fwdReturn5d !== null ? `${(entry.fwdReturn5d * 100).toFixed(1)} %` : "—"}</td>
        <td class="${entry.fwdReturn20d > 0 ? "positive" : entry.fwdReturn20d < 0 ? "negative" : ""}">${entry.fwdReturn20d !== null ? `${(entry.fwdReturn20d * 100).toFixed(1)} %` : "—"}</td>
      </tr>`)).join("");
    parts.push(`<details class="market-section contrarian-details">
      <summary>Look-back — score vs. price move (${review.length} days)</summary>
      <p class="muted small">The look-back is for calibration, not performance measurement.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Datum</th><th>Ticker</th><th>Score damals</th><th>+5 T</th><th>+20 T</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`);
  }

  // Review mappings — the trust-maintenance surface (suggestions + unconfirmed mappings).
  const suggestions = (market.suggestions || [])
    .filter((entry) => !newNames.some((fresh) => fresh.name === entry.name));
  const mappingEntries = Object.entries(market.mappings || {});
  const unconfirmed = mappingEntries.filter(([, mapping]) =>
    mapping.status !== "private" && mapping.status !== "subsidiary" &&
    (!mapping.confirmed || mapping.confidence < 0.9 || mapping.status === "unresolved"));
  const privates = mappingEntries.filter(([, mapping]) =>
    mapping.status === "private" || mapping.status === "subsidiary");
  if (suggestions.length || unconfirmed.length || privates.length) {
    const rows = [];
    if (suggestions.length) {
      rows.push(...suggestions.map((entry) => mappingRowHtml(entry, market, {})));
    }
    for (const [key, mapping] of unconfirmed) {
      rows.push(`
        <div class="mapping-row">
          <span class="mapping-name">${escapeHtml(mapping.displayName || key)}</span>
          <span class="chip">${mapping.status === "unresolved" ? "Check symbol" : "unconfirmed"}</span>
          ${mapping.ticker ? `<span class="market-ticker">${escapeHtml(mapping.ticker)}</span>` : ""}
          <span class="mapping-actions">
            <button type="button" class="ghost-button small" data-action="confirm-mapping" data-name="${escapeAttribute(key)}">Confirm</button>
            <button type="button" class="ghost-button small" data-action="ignore-entity" data-name="${escapeAttribute(key)}">Ignore</button>
          </span>
        </div>`);
    }
    for (const [key, mapping] of privates) {
      const related = (mapping.relatedTickers || []).join(", ");
      rows.push(`
        <div class="mapping-row info">
          <span class="mapping-name">${escapeHtml(mapping.displayName || key)}</span>
          <span class="muted small">${mapping.status === "subsidiary"
            ? `Subsidiary of ${escapeHtml(mapping.parent || "")} (${escapeHtml(mapping.ticker || "")})`
            : `not listed${related ? ` · related tickers: ${escapeHtml(related)}` : ""}`}${mapping.note ? ` — ${escapeHtml(mapping.note)}` : ""}</span>
          <span class="mapping-actions">
            <button type="button" class="ghost-button small" data-action="remove-mapping" data-name="${escapeAttribute(key)}" title="Remove mapping">X</button>
          </span>
        </div>`);
    }
    parts.push(`<section class="market-section"><h3 class="market-section-title">Review mappings</h3>
      <div class="mapping-list">${rows.join("")}</div></section>`);
  }

  els.marketInstruments.innerHTML = parts.join("");
}

function mappingRowHtml(entry, market, { isNew = false } = {}) {
  const resolved = state.resolveResults.get(entry.name);
  let pickerHtml = "";
  if (resolved === "loading") {
    pickerHtml = `<div class="mapping-picker"><p class="muted small">Searching candidates …</p></div>`;
  } else if (resolved) {
    const candidates = resolved.candidates || [];
    const seed = resolved.seed;
    const rows = [];
    if (seed && seed.status !== "public") {
      rows.push(`<div class="mapping-candidate">
        <span>${escapeHtml(seed.displayName)} — ${seed.status === "subsidiary"
          ? `Subsidiary of ${escapeHtml(seed.parent || "")}`
          : "not listed"}${seed.note ? ` (${escapeHtml(seed.note)})` : ""}</span>
        <button type="button" class="ghost-button small" data-action="map-seed" data-name="${escapeAttribute(entry.name)}">Apply</button>
      </div>`);
    }
    for (const candidate of candidates) {
      rows.push(`<div class="mapping-candidate">
        <span><strong>${escapeHtml(candidate.ticker)}</strong> ${escapeHtml(candidate.name)}
          <span class="muted small">${escapeHtml(candidate.exchange || "")}${candidate.probed ? "" : " · unchecked"}</span></span>
        <button type="button" class="ghost-button small" data-action="track" data-name="${escapeAttribute(entry.name)}" data-ticker="${escapeAttribute(candidate.ticker)}">Watch</button>
      </div>`);
    }
    rows.push(`<div class="mapping-candidate">
      <span class="muted small">No matching hit?</span>
      <button type="button" class="ghost-button small" data-action="map-private" data-name="${escapeAttribute(entry.name)}">Not listed</button>
    </div>`);
    pickerHtml = `<div class="mapping-picker">${rows.join("")}</div>`;
  }

  return `
    <div class="mapping-row">
      <span class="mapping-name" title="${escapeAttribute((entry.sampleTitles || []).join(" | "))}">${escapeHtml(entry.displayName || entry.name)}</span>
      ${isNew ? `<span class="chip">first seen ${formatDate(entry.firstSeenAt)}</span>` : ""}
      <span class="muted small">${entry.mentions} mentions</span>
      <span class="mapping-actions">
        <button type="button" class="ghost-button small" data-action="resolve" data-name="${escapeAttribute(entry.name)}">${resolved ? "Refresh" : "Map"}</button>
        <button type="button" class="ghost-button small" data-action="ignore-entity" data-name="${escapeAttribute(entry.name)}">Ignore</button>
      </span>
    </div>
    ${pickerHtml}`;
}

function opportunityCardHtml(opp, instrument, market) {
  const expanded = state.expandedInstruments.has(opp.ticker);
  const price = opp.price && opp.price.last !== null && opp.price.last !== undefined
    ? `${formatPrice(opp.price.last)} ${escapeHtml(opp.currency || "")}`
    : "—";
  const explainLine = (opp.components || [])
    .map((component) => component.explain)
    .filter(Boolean)
    .join(" · ");
  const flagChips = (opp.flagLabels || [])
    .map((label) => `<span class="chip">${escapeHtml(label)}</span>`)
    .join("");
  const scoreClass = opp.score >= 45 ? " hot" : (opp.score < 25 ? " low" : "");
  const idea = opp.idea;
  const spark = instrument ? instrument.spark || [] : [];

  let detailHtml = "";
  if (expanded) {
    const series = state.priceSeries.get(opp.ticker);
    const chart = series === undefined
      ? `<p class="muted small">Loading chart …</p>`
      : (series && series.dates.length
        ? buildPriceChartSvg(series)
        : `<p class="muted small">Chart unavailable — data may be stale.</p>`);
    const componentRows = (opp.components || []).map((component) => `
      <tr>
        <td>${escapeHtml(component.id.toUpperCase())}</td>
        <td>${component.value !== null ? component.value.toFixed(2) : "—"}</td>
        <td>${Math.round(component.weight * 100)} %</td>
        <td class="wrap">${escapeHtml(component.explain || "")}</td>
      </tr>`).join("");
    const counts = opp.counts || {};
    const linked = (opp.articleIds || [])
      .map((id) => (state.data.articles || []).find((a) => a.id === id))
      .filter(Boolean);
    detailHtml = `
      <div class="market-detail">
        ${chart}
        <table class="data-table component-table">
          <thead><tr><th>Signal</th><th>Value</th><th>Weight</th><th>Explanation</th></tr></thead>
          <tbody>${componentRows}</tbody>
        </table>
        <p class="muted small">Raw data: ${counts.hotArticles ?? 0} stories / ${counts.hotClusters ?? 0} events
          / ${counts.hotSources ?? 0} sources in 7d · ${counts.pos ?? 0} positive, ${counts.neu ?? 0} neutral,
          ${counts.watch ?? 0} watch · baseline ${counts.baseArticles ?? 0} stories / ${counts.baseDays ?? 0} d</p>
        <h4>Evidence from your feeds</h4>
        ${linked.length
          ? `<div class="cluster-related">${linked.map(relatedItemHtml).join("")}</div>`
          : `<p class="muted small">No linked stories.</p>`}
        <textarea class="idea-note" data-note-for="${escapeAttribute(opp.ticker)}" rows="2"
          placeholder="Note (e.g. what still needs checking)">${escapeHtml(idea ? idea.note : "")}</textarea>
        ${narrativeHtml(opp.ticker, market)}
        <div class="card-actions">
          ${aiReportAvailable() ? `<button type="button" class="ghost-button small" data-action="narrative" data-ticker="${escapeAttribute(opp.ticker)}">AI assessment</button>` : ""}
          <button type="button" class="ghost-button small" data-action="pause" data-ticker="${escapeAttribute(opp.ticker)}">${instrument && instrument.paused ? "Resume" : "Pause"}</button>
          <button type="button" class="ghost-button small" data-action="delete" data-ticker="${escapeAttribute(opp.ticker)}">Remove</button>
        </div>
      </div>`;
  }

  return `
    <article class="market-card opportunity">
      <div class="market-topline">
        <div class="opportunity-title">
          <span class="score-badge${scoreClass}" title="Score 0-100, transparent aus den Signal-Komponenten">${opp.score}</span>
          <div>
            <h3>${escapeHtml(opp.name)} <span class="market-ticker">${escapeHtml(opp.ticker)}</span></h3>
            ${opp.quadrantLabel ? `<span class="muted small">${escapeHtml(opp.quadrantLabel)}</span>` : ""}
          </div>
        </div>
        <div class="market-price">
          <strong>${price}</strong>
        </div>
      </div>
      ${explainLine ? `<p class="muted small explain-line">${escapeHtml(explainLine)}</p>` : ""}
      <div class="market-spark">${buildSparklineSvg(spark)}</div>
      ${flagChips ? `<div class="chip-row">${flagChips}</div>` : ""}
      <div class="card-actions">
        <button type="button" class="ghost-button small" data-action="toggle-detail" data-ticker="${escapeAttribute(opp.ticker)}">${expanded ? "Details ausblenden" : "Details"}</button>
        <button type="button" class="ghost-button small${idea && idea.status === "pinned" ? " active" : ""}" data-action="${idea && idea.status === "pinned" ? "unpin" : "pin"}" data-ticker="${escapeAttribute(opp.ticker)}">${idea && idea.status === "pinned" ? "Gemerkt" : "Merken"}</button>
        <button type="button" class="ghost-button small" data-action="dismiss" data-ticker="${escapeAttribute(opp.ticker)}">Verwerfen</button>
      </div>
      ${detailHtml}
    </article>`;
}

function narrativeHtml(ticker, market) {
  const narrative = (market.narratives || {})[ticker];
  if (!narrative) return "";
  const list = (items) => items && items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="narrative-block">
      <p class="muted small">AI-generated · no recommendation · ${formatDateTime(narrative.at)} · confidence: ${escapeHtml(narrative.confidence || "?")}</p>
      <strong>${escapeHtml(narrative.headline || "")}</strong>
      <p>${escapeHtml(narrative.whyInteresting || "")}</p>
      ${narrative.whatToVerify && narrative.whatToVerify.length ? `<h4>What to verify</h4>${list(narrative.whatToVerify)}` : ""}
      ${narrative.risks && narrative.risks.length ? `<h4>Risks</h4>${list(narrative.risks)}` : ""}
    </div>`;
}

function watchCardHtml(instrument, market, unscoredEntry) {
  const benchmark = (market.benchmarks || {})[instrument.currency] || null;
  const price = instrument.lastPrice !== null && instrument.lastPrice !== undefined
    ? `${formatPrice(instrument.lastPrice)} ${escapeHtml(instrument.currency || "")}`
    : "—";
  let retHtml = "";
  if (instrument.ret20d !== null && instrument.ret20d !== undefined) {
    const pct = (instrument.ret20d * 100).toFixed(1);
    const cls = instrument.ret20d >= 0 ? "positive" : "negative";
    if (benchmark && benchmark.ret20d !== null && benchmark.ret20d !== undefined) {
      const excess = ((instrument.ret20d - benchmark.ret20d) * 100).toFixed(1);
      retHtml = `<span class="market-ret ${cls}" title="Absolut: ${pct} % / 20 Handelstage">` +
        `${excess >= 0 ? "+" : ""}${excess} % vs. ${escapeHtml(benchmark.symbol.replace("^", ""))} / 20 T</span>`;
    } else {
      retHtml = `<span class="market-ret ${cls}">${pct >= 0 ? "+" : ""}${pct} % / 20 T</span>`;
    }
  }

  const chips = [];
  if (unscoredEntry && unscoredEntry.reason && unscoredEntry.reasonCode !== "paused") {
    chips.push(`<span class="chip">${escapeHtml(unscoredEntry.reason)}</span>`);
  }
  if (instrument.paused) chips.push(`<span class="chip">paused</span>`);
  if (instrument.stale && !instrument.paused) chips.push(`<span class="chip watch" title="Price data not current">stale</span>`);
  if (instrument.mentions30d) chips.push(`<span class="chip category">${instrument.mentions30d} stories / 30d</span>`);

  const expanded = state.expandedInstruments.has(instrument.ticker);
  let detailHtml = "";
  if (expanded) {
    const series = state.priceSeries.get(instrument.ticker);
    const chart = series === undefined
      ? `<p class="muted small">Loading chart …</p>`
      : (series && series.dates.length
        ? buildPriceChartSvg(series)
        : `<p class="muted small">Chart unavailable — data may be stale.</p>`);
    const linked = (instrument.articleIds || [])
      .map((id) => (state.data.articles || []).find((a) => a.id === id))
      .filter(Boolean)
      .slice(0, 8);
    const articlesHtml = linked.length
      ? `<div class="cluster-related">${linked.map(relatedItemHtml).join("")}</div>`
      : `<p class="muted small">No linked stories in the feeds.</p>`;
    detailHtml = `
      <div class="market-detail">
        ${chart}
        <h4>Linked stories</h4>
        ${articlesHtml}
      </div>`;
  }

  return `
    <article class="market-card${instrument.paused ? " paused" : ""}">
      <div class="market-topline">
        <div>
          <h3>${escapeHtml(instrument.name)} <span class="market-ticker">${escapeHtml(instrument.ticker)}</span></h3>
          <span class="muted small">${escapeHtml(instrument.exchange || "")}</span>
        </div>
        <div class="market-price">
          <strong>${price}</strong>
          ${retHtml}
        </div>
      </div>
      <div class="market-spark">${buildSparklineSvg(instrument.spark || [])}</div>
      <div class="chip-row">${chips.join("")}</div>
      <div class="card-actions">
        <button type="button" class="ghost-button small" data-action="toggle-detail" data-ticker="${escapeAttribute(instrument.ticker)}">${expanded ? "Hide details" : "Details"}</button>
        ${unscoredEntry && unscoredEntry.reasonCode === "dismissed"
          ? `<button type="button" class="ghost-button small" data-action="unpin" data-ticker="${escapeAttribute(instrument.ticker)}">Restore</button>`
          : ""}
        <button type="button" class="ghost-button small" data-action="pause" data-ticker="${escapeAttribute(instrument.ticker)}">${instrument.paused ? "Resume" : "Pause"}</button>
        <button type="button" class="ghost-button small" data-action="delete" data-ticker="${escapeAttribute(instrument.ticker)}">Remove</button>
      </div>
      ${detailHtml}
    </article>`;
}

function buildSparklineSvg(closes) {
  if (!closes || closes.length < 2) {
    return `<span class="muted small">No price history yet.</span>`;
  }
  const width = 260;
  const height = 44;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const points = closes.map((close, i) =>
    `${((i / (closes.length - 1)) * width).toFixed(1)},${(height - 4 - ((close - min) / span) * (height - 8)).toFixed(1)}`
  ).join(" ");
  const rising = closes[closes.length - 1] >= closes[0];
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Price history">
    <polyline points="${points}" fill="none" stroke="${rising ? "#7ad17d" : "#f06f5c"}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}

function buildPriceChartSvg(series) {
  const closes = series.closes;
  const dates = series.dates;
  const width = 640;
  const height = 200;
  const pad = { top: 10, right: 12, bottom: 24, left: 46 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const xAt = (i) => pad.left + (closes.length > 1 ? (i / (closes.length - 1)) * innerWidth : innerWidth / 2);
  const yAt = (v) => pad.top + innerHeight - ((v - min) / span) * innerHeight;

  const parts = [];
  for (const frac of [0, 0.5, 1]) {
    const value = min + span * frac;
    const y = yAt(value);
    parts.push(`<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`);
    parts.push(`<text x="${pad.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#aaa79f">${formatPrice(value)}</text>`);
  }
  const labelStep = Math.max(1, Math.floor(dates.length / 6));
  dates.forEach((date, i) => {
    if (i % labelStep !== 0 && i !== dates.length - 1) return;
    parts.push(`<text x="${xAt(i).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="#aaa79f">${escapeHtml(date.slice(5))}</text>`);
  });
  const points = closes.map((close, i) => `${xAt(i).toFixed(1)},${yAt(close).toFixed(1)}`).join(" ");
  parts.push(`<polyline points="${points}" fill="none" stroke="#f2b84b" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Price history" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`;
}

function formatPrice(value) {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Settings view ---------- */

function bindSettings() {
  els.collectionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveConfig({
      settings: settingsPayload({
        autoCollectMinutes: Number(els.settingAutoCollect.value),
        maxArticles: Number(els.settingMaxArticles.value)
      })
    }, "Collection settings saved.");
  });

  els.addCategoryRow.addEventListener("click", () => {
    els.categoryRows.insertAdjacentHTML("beforeend", categoryRowHtml({ name: "", keywords: [] }));
  });

  els.categoryRows.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='remove']");
    if (!button) return;
    const row = button.closest(".category-row");
    if (row) row.remove();
  });

  els.saveCategories.addEventListener("click", async () => {
    const rows = [...els.categoryRows.querySelectorAll(".category-row")]
      .map((row) => ({
        name: row.querySelector(".cat-name").value.trim(),
        keywords: splitList(row.querySelector(".cat-keywords").value).map((word) => word.toLowerCase())
      }))
      .filter((row) => row.name);
    if (!rows.length) return toast("Keep at least one category.");
    await saveConfig({ categories: rows }, "Categories saved.");
  });

  els.reapplyCategories.addEventListener("click", async () => {
    els.reapplyCategories.disabled = true;
    await mutate("/api/recategorize", { method: "POST" }, "Categories re-applied to all stories.");
    els.reapplyCategories.disabled = false;
  });

  els.sentimentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveConfig({
      sentiment: {
        positive: splitList(els.sentimentPositive.value).map((word) => word.toLowerCase()),
        negative: splitList(els.sentimentNegative.value).map((word) => word.toLowerCase())
      }
    }, "Sentiment words saved.");
  });

  els.germanSentimentSeed.addEventListener("click", async () => {
    const sentiment = (state.data.config && state.data.config.sentiment) || { positive: [], negative: [] };
    const merged = {
      positive: [...new Set([...(sentiment.positive || []), ...GERMAN_SENTIMENT.positive])],
      negative: [...new Set([...(sentiment.negative || []), ...GERMAN_SENTIMENT.negative])]
    };
    const addedCount = (merged.positive.length - (sentiment.positive || []).length) +
      (merged.negative.length - (sentiment.negative || []).length);
    const data = await saveConfig({ sentiment: merged },
      addedCount
        ? `${addedCount} German terms added. Now run "Re-apply categories" to re-score existing stories.`
        : "All terms were already present.");
    if (data) renderSettings();
  });

  els.aiForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const typed = els.aiKey.value;
    const data = await saveConfig({
      settings: settingsPayload({
        ai: {
          enabled: els.aiEnabled.checked,
          model: els.aiModel.value.trim() || "claude-opus-4-8",
          maxArticlesPerCollect: Number(els.aiMaxPer.value) || 30,
          apiKey: typed ? typed : ""
        }
      })
    }, typed ? "AI settings and API key saved." : "AI settings saved.");
    if (data) els.aiKey.value = "";
  });

  els.clearAiKey.addEventListener("click", async () => {
    await saveConfig({ settings: settingsPayload({ ai: { apiKey: null } }) }, "API key cleared.");
  });

  els.webhookForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = els.webhookUrl.value.trim();
    if (!/^https?:\/\//i.test(url)) return toast("Webhook URL must start with http(s)://");
    const webhooks = [
      ...(settings().webhooks || []).map((hook) => ({ ...hook })),
      { url, format: els.webhookFormat.value === "ntfy" ? "ntfy" : "json" }
    ];
    const data = await saveConfig({ settings: settingsPayload({ webhooks }) }, "Webhook added.");
    if (data) els.webhookUrl.value = "";
  });

  els.webhookList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='delete-webhook']");
    if (!button) return;
    const webhooks = (settings().webhooks || [])
      .filter((hook) => hook.id !== button.dataset.id)
      .map((hook) => ({ ...hook }));
    await saveConfig({ settings: settingsPayload({ webhooks }) }, "Webhook removed.");
  });

  els.generateToken.addEventListener("click", () => {
    els.apiToken.value = randomHex(24);
    toast("Token generated. Click Save token to activate it.");
  });

  els.saveToken.addEventListener("click", async () => {
    const token = els.apiToken.value.trim();
    await saveConfig(
      { settings: settingsPayload({ apiToken: token }) },
      token ? "External API token saved." : "External API disabled."
    );
  });

  els.marketForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveConfig({
      settings: settingsPayload({
        market: {
          enabled: els.marketEnabled.checked,
          minRefreshMinutes: Number(els.marketMinRefresh.value) || 180,
          maxInstruments: Number(els.marketMaxInstruments.value) || 40,
          historyDays: Number(els.marketHistoryDays.value) || 400,
          preferXetra: els.marketPreferXetra.checked,
          benchmarkEUR: els.marketBenchmark.value,
          aiMapping: els.marketAiMapping.checked,
          alerts: {
            enabled: els.marketAlertsEnabled.checked,
            minScore: Number(els.marketAlertMinScore.value) || 45
          }
        }
      })
    }, "Market settings saved.");
  });

  els.feedPackList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-feed]");
    if (!button) return;
    const feed = FEED_PACK[Number(button.dataset.feed)];
    if (!feed) return;
    button.disabled = true;
    await mutate("/api/sources", {
      method: "POST",
      body: { name: feed.name, url: feed.url, type: "rss" }
    }, `${feed.name} added. Baselines adjust over ~90 days.`);
  });

  els.addAllFeeds.addEventListener("click", async () => {
    const known = new Set((state.data.sources || []).map((source) => String(source.url).toLowerCase()));
    const missing = FEED_PACK.filter((feed) => !known.has(feed.url.toLowerCase()));
    if (!missing.length) return toast("All pack feeds are already present.");
    const confirmed = typeof confirm !== "function" ||
      confirm(`Add ${missing.length} finance feeds? New sources shift all news baselines (~90 days to adjust).`);
    if (!confirmed) return;
    els.addAllFeeds.disabled = true;
    let added = 0;
    for (const feed of missing) {
      try {
        const data = await api("/api/sources", { method: "POST", body: { name: feed.name, url: feed.url, type: "rss" } });
        applyState(data);
        added += 1;
      } catch (error) {
        toast(`${feed.name}: ${error.message}`);
      }
    }
    els.addAllFeeds.disabled = false;
    render();
    toast(`${added} finance feeds added. They'll be gathered on the next collect.`);
  });

  els.briefForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const [hour, minute] = String(els.briefTime.value || "07:00").split(":").map(Number);
    await saveConfig({
      settings: settingsPayload({
        brief: {
          enabled: els.briefEnabled.checked,
          hour: Number.isFinite(hour) ? hour : 7,
          minute: Number.isFinite(minute) ? minute : 0,
          lookbackHours: Number(els.briefLookback.value) || 24,
          maxStories: Number(els.briefMaxStories.value) || 10,
          push: els.briefPush.checked
        }
      })
    }, "Morning Brief settings saved.");
  });

  els.briefGenerateNow.addEventListener("click", () => generateBriefNow(els.briefGenerateNow));

  els.importData.addEventListener("click", async () => {
    const file = els.importFile.files[0];
    if (!file) return toast("Choose a JSON export file first.");
    try {
      const parsed = JSON.parse(await file.text());
      const data = await api("/api/import", { method: "POST", body: { store: parsed } });
      applyState(data);
      render();
      toast("Data imported.");
      els.importFile.value = "";
    } catch (error) {
      toast(error.message || "Import failed.");
    }
  });

  els.settingsReset.addEventListener("click", resetAll);
}

async function saveConfig(patch, message) {
  return mutate("/api/config", { method: "PUT", body: patch }, message);
}

function categoryRowHtml(category) {
  return `
    <div class="category-row">
      <input class="cat-name" placeholder="Category name" value="${escapeAttribute(category.name)}">
      <input class="cat-keywords" placeholder="keywords, comma, separated" value="${escapeAttribute((category.keywords || []).join(", "))}">
      <button type="button" class="row-remove" data-action="remove" title="Remove category" aria-label="Remove category">X</button>
    </div>`;
}

function renderSettings() {
  const config = state.data.config || {};
  const s = config.settings || {};
  const ai = s.ai || {};

  els.settingAutoCollect.value = s.autoCollectMinutes ?? 0;
  els.settingMaxArticles.value = s.maxArticles ?? 2000;

  els.categoryRows.innerHTML = (config.categories || []).map(categoryRowHtml).join("");

  const sentiment = config.sentiment || {};
  els.sentimentPositive.value = (sentiment.positive || []).join(", ");
  els.sentimentNegative.value = (sentiment.negative || []).join(", ");

  els.aiEnabled.checked = !!ai.enabled;
  els.aiModel.value = ai.model || "";
  els.aiMaxPer.value = ai.maxArticlesPerCollect ?? 30;
  els.aiKey.value = "";
  els.aiKey.placeholder = ai.apiKeyConfigured ? "configured - type to replace" : "sk-ant-...";
  els.clearAiKey.disabled = !ai.apiKeyConfigured;

  const brief = s.brief || {};
  els.briefEnabled.checked = !!brief.enabled;
  els.briefTime.value = `${String(brief.hour ?? 7).padStart(2, "0")}:${String(brief.minute ?? 0).padStart(2, "0")}`;
  els.briefLookback.value = brief.lookbackHours ?? 24;
  els.briefMaxStories.value = brief.maxStories ?? 10;
  els.briefPush.checked = !!brief.push;
  els.briefAiHint.textContent = ai.apiKeyConfigured
    ? "API key detected — briefs will be LLM-written."
    : "No API key detected — briefs use the readable heuristic until ANTHROPIC_API_KEY (or an AI key) is set.";

  const webhooks = s.webhooks || [];
  els.webhookList.innerHTML = webhooks.length
    ? webhooks.map((hook) => `
      <div class="webhook-row">
        <span class="chip">${hook.format === "ntfy" ? "ntfy" : "JSON"}</span>
        <span class="webhook-url" title="${escapeAttribute(hook.url)}">${escapeHtml(hook.url)}</span>
        <button type="button" class="row-remove" data-action="delete-webhook" data-id="${escapeAttribute(hook.id || "")}" title="Remove webhook" aria-label="Remove webhook">X</button>
      </div>`).join("")
    : `<p class="muted">No webhooks configured.</p>`;

  els.apiToken.value = s.apiToken || "";
  const exampleToken = s.apiToken || "<token>";
  els.tokenExample.textContent = `curl -H "Authorization: Bearer ${exampleToken}" "${location.origin}/api/external/articles?limit=20"`;

  const market = s.market || {};
  els.marketEnabled.checked = market.enabled !== false;
  els.marketMinRefresh.value = market.minRefreshMinutes ?? 180;
  els.marketMaxInstruments.value = market.maxInstruments ?? 40;
  els.marketHistoryDays.value = market.historyDays ?? 400;
  els.marketPreferXetra.checked = market.preferXetra !== false;
  els.marketBenchmark.value = market.benchmarkEUR || "^GDAXI";
  els.marketAiMapping.checked = market.aiMapping === true;
  els.marketAlertsEnabled.checked = !!(market.alerts && market.alerts.enabled);
  els.marketAlertMinScore.value = (market.alerts && market.alerts.minScore) ?? 45;

  const knownUrls = new Set((state.data.sources || []).map((source) => String(source.url).toLowerCase()));
  els.feedPackList.innerHTML = FEED_PACK.map((feed, index) => {
    const present = knownUrls.has(feed.url.toLowerCase());
    return `
      <div class="feed-pack-row">
        <span class="feed-pack-lang">${escapeHtml(feed.lang)}</span>
        <span class="feed-pack-name" title="${escapeAttribute(feed.url)}">${escapeHtml(feed.name)}</span>
        ${present
          ? `<span class="chip positive">present</span>`
          : `<button type="button" class="ghost-button small" data-feed="${index}">Add</button>`}
      </div>`;
  }).join("");
}

/* ---------- Helpers ---------- */

function renderSelect(select, values, selected) {
  const current = values.includes(selected) ? selected : values[0];
  select.innerHTML = values
    .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(formatOption(value))}</option>`)
    .join("");
  select.value = current ?? "";
}

function formatOption(value) {
  return /^\d{4}-\d{2}$/.test(value) ? formatMonth(value) : value;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function truncateText(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}...`;
}

function toast(message, duration = 3200) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("visible"), duration);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatMonth(key) {
  if (!/^\d{4}-\d{2}$/.test(key || "")) return key || "";
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
