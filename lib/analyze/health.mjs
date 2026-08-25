function ensureHealth(source) {
  if (!source.health || typeof source.health !== "object") {
    source.health = {
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastStatus: null
    };
  }
  const health = source.health;
  health.successCount = health.successCount || 0;
  health.failureCount = health.failureCount || 0;
  health.consecutiveFailures = health.consecutiveFailures || 0;
  if (health.lastError === undefined) health.lastError = null;
  if (health.lastSuccessAt === undefined) health.lastSuccessAt = null;
  if (health.lastFailureAt === undefined) health.lastFailureAt = null;
  if (health.lastStatus === undefined) health.lastStatus = null;
  return health;
}

export function summarizeHealth(source) {
  const health = (source && source.health) || {};
  const successCount = health.successCount || 0;
  const failureCount = health.failureCount || 0;
  const consecutiveFailures = health.consecutiveFailures || 0;
  const attempts = successCount + failureCount;

  let status;
  let label;
  if (attempts === 0) {
    status = "new";
    label = "Not collected yet";
  } else if (consecutiveFailures >= 3) {
    status = "failing";
    label = `Failing (${consecutiveFailures} consecutive failures)`;
  } else if (health.lastStatus === "error" || (source && source.paused)) {
    status = "warning";
    label = source && source.paused ? "Paused" : "Recent collection error";
  } else {
    status = "healthy";
    label = "Healthy";
  }

  return {
    status,
    label,
    lastError: health.lastError || null,
    lastSuccessAt: health.lastSuccessAt || null,
    successCount,
    failureCount
  };
}

export function applyCollectResult(source, result) {
  const health = ensureHealth(source);
  const now = new Date().toISOString();
  const entry = result || {};

  if (entry.ok || entry.notModified) {
    health.successCount += 1;
    health.consecutiveFailures = 0;
    health.lastError = null;
    health.lastSuccessAt = now;
    health.lastStatus = entry.notModified ? "not-modified" : "ok";
    if (entry.notModified) {
      // A 304 rarely repeats validators; keep the stored ones unless new values arrived.
      if (entry.etag) source.etag = entry.etag;
      if (entry.lastModified) source.lastModified = entry.lastModified;
    } else {
      source.etag = entry.etag !== undefined ? entry.etag : null;
      source.lastModified = entry.lastModified !== undefined ? entry.lastModified : null;
    }
  } else {
    health.failureCount += 1;
    health.consecutiveFailures += 1;
    health.lastError = entry.error || "Unknown collection error";
    health.lastFailureAt = now;
    health.lastStatus = "error";
  }

  return source;
}
