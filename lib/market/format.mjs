// Presentation layer for the signal engine: numeric facts in, English sentences out.
// The frontend stays dumb — it renders these strings verbatim.

function num(value, digits = 1) {
  return Number(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function signedPct(value, digits = 1) {
  const n = Number(value ?? 0);
  return `${n > 0 ? "+" : ""}${num(n, digits)} %`;
}

export function explainComponent(component) {
  const facts = component.facts || {};
  switch (component.id) {
    case "nvs":
      return `${facts.hotArticles} stories (${facts.hotClusters} events) in 7 days vs. ~${num(facts.expected7)} expected`;
    case "msc":
      return facts.distinctSources === 1
        ? "only 1 source reporting"
        : `${facts.distinctSources} independent sources, ${facts.clusteredSharePct} % multiply reported`;
    case "npd": {
      if (component.value === null) {
        return facts.reason === "sentiment-none"
          ? "sentiment coverage missing — divergence not assessable"
          : "price window incomplete";
      }
      const move = facts.absReturn
        ? `price ${signedPct(facts.retPct)} / 20d (absolute)`
        : `price ${signedPct(facts.retPct)} vs. ${benchmarkName(facts.benchmarkSymbol)} / 20d`;
      return `${facts.posSharePct} % positive, ${move}`;
    }
    case "prc":
      if (component.value === null) {
        return "";
      }
      return facts.setup === "near-high"
        ? `only ${num(facts.pctFromHigh)} % below the 52-week high amid positive news`
        : `near 52-week low (${signedPct(facts.pctFromLow)}), risk tone easing`;
    default:
      return "";
  }
}

export function benchmarkName(symbol) {
  if (symbol === "^GDAXI") return "DAX";
  if (symbol === "^TECDAX") return "TecDAX";
  if (symbol === "^GSPC") return "S&P 500";
  return String(symbol || "").replace(/^\^/, "");
}

const QUADRANT_LABELS = {
  "possibly-early": "Positive stories piling up, price barely moving — possibly early",
  "priced-in": "Stories and price rise moving together — likely already priced in",
  "complacency-risk": "Risk stories piling up, price not reacting — look closer",
  "punished-contrarian": "Price already heavily punished — contrarian check"
};

export function quadrantLabel(quadrant) {
  return QUADRANT_LABELS[quadrant] || "";
}

const FLAG_LABELS = {
  "single-source": "single source",
  "sentiment-thin": "thin sentiment coverage",
  "abs-return": "no benchmark comparison",
  "risk-concentration": "risk stories dominate",
  "stale-price": "price data stale",
  "contrarian": "contrarian",
  "resurfaced": "new facts"
};

export function flagLabel(flag) {
  return FLAG_LABELS[flag] || flag;
}

export function unscoredReason(reasonCode, facts = {}) {
  switch (reasonCode) {
    case "paused":
      return "paused";
    case "stale-symbol":
      return "symbol stale — check mapping";
    case "unconfirmed":
      return "mapping unconfirmed";
    case "too-few-articles":
      return `only ${facts.count30d ?? 0} stories in 30 days (min. ${facts.min ?? 3})`;
    case "baseline-building":
      return `baseline building — ${facts.daysLeft ?? "?"} days left`;
    case "price-data":
      return `insufficient price history (${facts.bars ?? 0} of ${facts.min ?? 60} trading days)`;
    case "dismissed":
      return "dismissed";
    default:
      return reasonCode;
  }
}
