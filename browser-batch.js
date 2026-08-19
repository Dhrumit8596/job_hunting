'use strict';

// Shared acknowledged browser-persistence contract. UMD keeps the retry/merge behavior identical
// in LinkedIn, Indeed, the MV3 service worker, and Node behavioral tests.
(function (root) {
  const SCORE_FIELDS = ['fitScore', 'scoreKind', 'matchEvidence', 'gaps', 'conflicts', 'confidence',
    'descriptionFingerprint', 'evidenceFingerprint', 'candidateFingerprint', 'lastScoredAt'];

  function text(value) { return String(value == null ? '' : value).trim(); }
  function stableHash(value) {
    const input = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }
  function jobId(job) { return text(job && (job.id || job.jobId || job.sourceJobId)); }
  function recordKey(job, fallbackSource) {
    return [text(job && (job.sourcePlatform || job.platform) || fallbackSource).toLowerCase(), jobId(job)].join(':');
  }
  function batchId(options = {}) {
    const ids = (options.jobs || []).map(jobId).filter(Boolean).sort();
    return [text(options.source).toLowerCase(), stableHash(text(options.query).toLowerCase()),
      Math.max(1, Number(options.page) || 1), Math.max(1, Number(options.sequence) || 1),
      stableHash(ids.join('|'))].join(':');
  }
  function asTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function earliest(...values) {
    const times = values.map(asTime).filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
  }
  function latest(...values) {
    const times = values.map(asTime).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  }
  function mergeUnique(...values) {
    return Array.from(new Set(values.flat().map(text).filter(Boolean)));
  }
  function descriptionReady(job) {
    return !!text(job && job.description) &&
      !/^(missing|stale|needs_description)$/i.test(text(job && job.descriptionStatus));
  }
  function pageRef(job, fallback = {}) {
    return {
      source: text(job && (job.sourcePlatform || job.platform) || fallback.source).toLowerCase(),
      query: text(job && job.query || fallback.query),
      page: Math.max(1, Number(job && job.sourcePage || fallback.page) || 1),
      seenAt: latest(job && (job.lastSeenAt || job.discoveredAt || job.scrapedAt), fallback.observedAt),
    };
  }
  function pageRefKey(ref) { return [ref.source, ref.query.toLowerCase(), ref.page].join('|'); }

  function mergeRecord(prior, incoming, options = {}) {
    const observedAt = Number(options.observedAt) || Date.now();
    if (!prior) {
      const first = earliest(incoming.firstDiscoveredAt, incoming.discoveredAt, incoming.scrapedAt, observedAt) || observedAt;
      return { ...incoming, id: jobId(incoming), firstDiscoveredAt: first, discoveredAt: first,
        lastSeenAt: latest(incoming.lastSeenAt, incoming.discoveredAt, incoming.scrapedAt, observedAt) || observedAt,
        matchedQueries: mergeUnique(incoming.matchedQueries || [], incoming.query),
        sourcePages: [pageRef(incoming, options)] };
    }
    const priorReady = descriptionReady(prior), incomingReady = descriptionReady(incoming);
    const priorDescription = text(prior.description), incomingDescription = text(incoming.description);
    const descriptionChanged = incomingReady && incomingDescription !== priorDescription;
    const routeEnriched = (!!incoming.externalApplyUrl && incoming.externalApplyUrl !== prior.externalApplyUrl) ||
      (prior.needsAtsResolution === true && incoming.needsAtsResolution === false);
    const out = { ...prior, ...incoming, id: jobId(prior) || jobId(incoming) };
    if (priorReady && !incomingReady) {
      for (const key of ['description', 'descriptionStatus', 'hydrationStatus', 'hydrationMethod',
        'hydrationReason', 'hydratedAt', 'pipelineStatus', 'status']) {
        if (prior[key] != null) out[key] = prior[key];
      }
    }
    if (!descriptionChanged) {
      for (const key of SCORE_FIELDS) if (prior[key] != null) out[key] = prior[key];
    } else {
      for (const key of SCORE_FIELDS) delete out[key];
    }
    const first = earliest(prior.firstDiscoveredAt, prior.discoveredAt, incoming.firstDiscoveredAt,
      incoming.discoveredAt, observedAt) || observedAt;
    out.firstDiscoveredAt = first;
    out.discoveredAt = first; // immutable audit date; freshness uses lastSeenAt
    out.lastSeenAt = latest(prior.lastSeenAt, incoming.lastSeenAt, incoming.discoveredAt,
      incoming.scrapedAt, observedAt) || observedAt;
    out.matchedQueries = mergeUnique(prior.matchedQueries || [], prior.query,
      incoming.matchedQueries || [], incoming.query).slice(0, 30);
    const refs = Array.isArray(prior.sourcePages) ? prior.sourcePages.slice() : [];
    const ref = pageRef(incoming, options);
    const idx = refs.findIndex(existing => pageRefKey(existing) === pageRefKey(ref));
    if (idx >= 0) refs[idx] = { ...refs[idx], seenAt: latest(refs[idx].seenAt, ref.seenAt) };
    else refs.push(ref);
    out.sourcePages = refs.slice(-40);
    return { record: out, enriched: !priorReady && incomingReady || descriptionChanged || routeEnriched };
  }

  function mergeBatch(existing, jobs, options = {}) {
    const list = Array.isArray(existing) ? existing.filter(Boolean) : [];
    const byId = new Map(list.map(row => [recordKey(row, options.source), row]).filter(([id]) => !id.endsWith(':')));
    const seenBatch = new Set();
    const counts = { received: Array.isArray(jobs) ? jobs.length : 0, accepted: 0, inserted: 0,
      enriched: 0, refreshed: 0, filtered: 0, rejected: 0, rejectionCounts: {} };
    const acceptedIds = [], rejectedIds = [];
    const reject = (id, reason, filtered) => {
      counts.rejected += 1;
      if (filtered) counts.filtered += 1;
      counts.rejectionCounts[reason] = (counts.rejectionCounts[reason] || 0) + 1;
      if (id) rejectedIds.push(id);
    };
    for (const incoming of jobs || []) {
      const id = jobId(incoming);
      const key = recordKey(incoming, options.source);
      if (!id) { reject('', 'missing_stable_job_id', false); continue; }
      if (seenBatch.has(key)) { reject(id, 'duplicate_in_batch', false); continue; }
      seenBatch.add(key);
      const verdict = typeof options.accept === 'function' ? options.accept(incoming) : true;
      if (verdict !== true) { reject(id, text(verdict) || 'deterministic_filter', true); continue; }
      counts.accepted += 1; acceptedIds.push(id);
      const prior = byId.get(key);
      const merged = mergeRecord(prior, incoming, options);
      const record = merged && merged.record || merged;
      byId.set(key, record);
      if (!prior) counts.inserted += 1;
      else if (merged.enriched) counts.enriched += 1;
      else counts.refreshed += 1;
    }
    return { list: Array.from(byId.values()), counts, acceptedIds, rejectedIds };
  }

  async function sendAcknowledged(send, envelope, options = {}) {
    const attempts = Math.max(1, Math.min(4, Number(options.attempts) || 3));
    let lastReason = 'persistence_unacknowledged';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await send(envelope, attempt);
        if (!response) { lastReason = 'persistence_timeout'; continue; }
        if (response.batchId !== envelope.batchId) { lastReason = 'batch_id_mismatch'; continue; }
        if (response.acknowledged !== true) { lastReason = response.reason || 'persistence_rejected'; continue; }
        return { ok: true, attempts: attempt, response };
      } catch (error) {
        const message = text(error && error.message || error);
        if (/extension context invalidated|receiving end does not exist/i.test(message)) {
          return { ok: false, attempts: attempt, reason: 'extension_context_invalidated' };
        }
        lastReason = 'persistence_send_error';
      }
    }
    return { ok: false, attempts, reason: lastReason };
  }

  function pageContinuationDecision(metric, history = [], options = {}) {
    const page = Math.max(1, Number(metric && metric.page) || 1);
    const maxPages = Math.max(1, Math.min(5, Number(options.maxPages) || 3));
    if (metric && metric.persistenceFailed) return { continue: false, reason: 'persistence_failed' };
    if (metric && metric.challenge) return { continue: false, reason: 'source_challenge' };
    if (options.ownershipOk === false) return { continue: false, reason: 'source_ownership_lost' };
    if (Number(options.remainingMs) < Math.max(5000, Number(options.minimumRemainingMs) || 15000)) {
      return { continue: false, reason: 'deadline_reserve' };
    }
    if (page >= maxPages) return { continue: false, reason: 'page_cap' };
    if (!metric || Number(metric.stableIds || 0) === 0) return { continue: false, reason: 'zero_stable_ids' };
    const newPersisted = Number(metric.inserted || 0) + Number(metric.enriched || 0);
    if (newPersisted === 0) return { continue: false, reason: 'zero_new_persisted' };
    const duplicateRatio = Number(metric.duplicates || 0) / Math.max(1, Number(metric.stableIds || 0));
    const prior = history[history.length - 1];
    const priorRatio = prior ? Number(prior.duplicates || 0) / Math.max(1, Number(prior.stableIds || 0)) : 0;
    if (duplicateRatio >= 0.9 && priorRatio >= 0.9) return { continue: false, reason: 'duplicate_saturation' };
    const relevantRate = Number(metric.deterministicAccepted || 0) / Math.max(1, Number(metric.stableIds || 0));
    const useful = newPersisted >= Math.max(1, Number(options.minimumNewPersisted) || 3) ||
      Number(metric.directRoutes || 0) > 0 || relevantRate >= 0.2;
    if (!useful) return { continue: false, reason: 'low_deterministic_yield' };
    if (page >= 3 && (newPersisted < 5 || Number(metric.directRoutes || 0) < 1)) {
      return { continue: false, reason: 'deep_page_yield_too_low' };
    }
    return { continue: true, reason: page < 3 ? 'useful_yield' : 'strong_deep_page_yield' };
  }

  function resultIdsChanged(before, after) {
    const signature = values => Array.from(new Set(Array.from(values || []).map(text).filter(Boolean))).sort().join('|');
    const previous = signature(before), current = signature(after);
    return !!current && current !== previous;
  }

  const api = { stableHash, batchId, recordKey, descriptionReady, mergeRecord, mergeBatch, sendAcknowledged,
    pageContinuationDecision, resultIdsChanged };
  if (root) root.PJABrowserBatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
