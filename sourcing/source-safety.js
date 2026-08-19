'use strict';

// Pure sourcing ownership, deadline, workflow-budget, and storage-observation policy. UMD keeps
// the same decision code available to the Node dev server and the MV3 import boundary.
(function (root) {
  const SOURCE_STORAGE_KEYS = [
    'pja_profile', 'pja_prefs', 'pja_jobs', 'pja_ext_queue', 'pja_applied_log',
    'pja_application_ledger',
    'pja_source_yield', 'pja_scan_coverage',
  ];
  const DEFAULT_WORKFLOW_MS = 45 * 60 * 1000;
  const DEFAULT_APPLY_MS = 15 * 60 * 1000;
  const DEFAULT_STANDALONE_SOURCE_MS = 25 * 60 * 1000;

  function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }
  function sourceError(code, message, statusCode) {
    const error = new Error(message || code);
    error.code = code;
    error.statusCode = statusCode || 500;
    return error;
  }
  function remainingDeadlineMs(deadlineMs, now = Date.now()) {
    const deadline = Number(deadlineMs);
    if (!Number.isFinite(deadline)) return 0;
    return Math.max(0, deadline - Number(now));
  }
  function optionalRunId(value, sanitize) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return typeof sanitize === 'function' ? String(sanitize(raw) || '') : raw;
  }
  function sourceDecision(options = {}) {
    const now = options.now == null ? Date.now() : Number(options.now);
    if (remainingDeadlineMs(options.deadlineMs, now) <= 0) {
      return { ok: false, code: 'sourcing_deadline_exceeded', statusCode: 408 };
    }
    const runId = String(options.runId || '').trim();
    if (!runId) return { ok: true, standalone: true, remainingMs: remainingDeadlineMs(options.deadlineMs, now) };
    if (options.connected === false) {
      return { ok: false, code: 'extension_disconnected', statusCode: 503 };
    }
    const control = options.control;
    const observed = options.controlObserved === true;
    if (!observed || !control || control.runId !== runId || control.status !== 'planning' || control.phase !== 'sourcing') {
      return { ok: false, code: 'source_ownership_lost', statusCode: 409 };
    }
    return { ok: true, standalone: false, remainingMs: remainingDeadlineMs(options.deadlineMs, now) };
  }
  function assertSourceDecision(decision) {
    if (decision && decision.ok) return decision;
    const code = decision && decision.code || 'source_ownership_lost';
    throw sourceError(code, code, decision && decision.statusCode || 409);
  }
  async function guardedMutation(decision, mutate) {
    assertSourceDecision(decision);
    return mutate();
  }
  function storageObserved(storage) {
    return !!(storage && (Object.prototype.hasOwnProperty.call(storage, 'pja_profile') ||
      Object.prototype.hasOwnProperty.call(storage, 'pja_prefs')));
  }
  function pick(source, keys) {
    const value = source && typeof source === 'object' ? source : {};
    const out = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
    }
    return out;
  }
  function compactAppliedRecord(record) {
    const row = record && typeof record === 'object' ? record : {};
    const compact = pick(row, [
      'eventId', 'id', 'jobId', 'sourceJobId', 'runId', 'applyUrl', 'url',
      'company', 'companyName', 'title', 'role', 'jobTitle', 'status', 'result',
      'reason', 'skipReason', 'success', 'submitAttempted', 'phase',
      'confirmationSource', 'confirmedBy', 'confirmedAt', 'confirmedEmail',
      'confirmationEmailId', 'emailMessageId', 'messageId', 'applicationAt',
      'occurredAt', 'appliedAt',
    ]);
    if (row.diagnostic && typeof row.diagnostic === 'object') {
      compact.diagnostic = pick(row.diagnostic, ['phase', 'submitAttempted']);
    }
    return compact;
  }
  // Sourcing needs only search/location preferences and stable application identities. Sending
  // full profile history plus description-rich diagnostics and logs over the observer socket can
  // time out before discovery begins. Preserve every field used by dedupe/retry policy while
  // excluding unrelated personal and diagnostic payloads.
  function compactSourcingStorage(storage) {
    const source = storage && typeof storage === 'object' ? storage : {};
    const ledger = source.pja_application_ledger && typeof source.pja_application_ledger === 'object'
      ? source.pja_application_ledger : {};
    const events = ledger.events && typeof ledger.events === 'object' ? ledger.events : {};
    const queue = source.pja_ext_queue && typeof source.pja_ext_queue === 'object' ? source.pja_ext_queue : {};
    const results = queue.results && typeof queue.results === 'object' ? queue.results : {};
    const compact = {
      pja_jobs: Array.isArray(source.pja_jobs) ? source.pja_jobs.map(compactAppliedRecord) : [],
      pja_ext_queue: { results: {
        applied: Array.isArray(results.applied) ? results.applied.map(compactAppliedRecord) : [],
      } },
      pja_applied_log: Array.isArray(source.pja_applied_log)
        ? source.pja_applied_log.map(compactAppliedRecord) : [],
      pja_application_ledger: {
        schemaVersion: ledger.schemaVersion || 1,
        events: Object.fromEntries(Object.entries(events)
          .map(([key, event]) => [key, compactAppliedRecord(event)])),
      },
      pja_source_yield: source.pja_source_yield || null,
      pja_scan_coverage: source.pja_scan_coverage || null,
    };
    if (Object.prototype.hasOwnProperty.call(source, 'pja_profile')) {
      compact.pja_profile = pick(source.pja_profile, [
        'city', 'state', 'zip', 'country', 'willingToRelocate', 'yearsExperience',
      ]);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'pja_prefs')) {
      compact.pja_prefs = pick(source.pja_prefs, [
        'searchTitles', 'searchSeniority', 'targetLocationLabel', 'targetLocationCity',
        'targetLocationState', 'targetLocationZip', 'targetLocationCountry',
        'targetRadiusMiles', 'locationStrictness', 'remotePolicy',
      ]);
    }
    return compact;
  }
  async function readObservedSourcingStorage(read, options = {}) {
    const attempts = Math.max(1, Math.min(5, Number(options.attempts) || 3));
    const timeoutMs = Math.max(250, Math.min(15000, Number(options.timeoutMs) || 5000));
    const retryDelayMs = Math.max(0, Math.min(2000,
      options.retryDelayMs != null ? Number(options.retryDelayMs) || 0 : 500));
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let last = {};
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await read(SOURCE_STORAGE_KEYS.slice(), timeoutMs) || {};
      if (storageObserved(last)) return { storage: last, attempts: attempt };
      if (attempt < attempts && retryDelayMs) await sleep(retryDelayMs);
    }
    throw sourceError('source_storage_unavailable',
      'source profile/preferences storage unavailable; refusing discovery and corpus mutation', 503);
  }
  async function withObservedSourcingStorage(read, operation, options = {}) {
    const observed = await readObservedSourcingStorage(read, options);
    return operation(observed.storage, observed);
  }
  function calculateWorkflowBudgets(options = {}) {
    const workflowTimeoutMs = finitePositive(options.workflowTimeoutMs, DEFAULT_WORKFLOW_MS);
    const handoffReserveMs = finitePositive(options.handoffReserveMs, 30 * 1000);
    const minimumSourceClientMs = finitePositive(options.minimumSourceClientMs, 60 * 1000);
    const applyTimeoutMs = finitePositive(options.applyTimeoutMs, DEFAULT_APPLY_MS);
    const maximumSourceClientMs = workflowTimeoutMs - applyTimeoutMs - handoffReserveMs;
    if (maximumSourceClientMs < minimumSourceClientMs) {
      throw sourceError('invalid_sourcing_timeout_budget',
        'workflow timeout leaves no bounded sourcing window before planning', 400);
    }
    const requestedSourceClientMs = finitePositive(options.sourceTimeoutMs, maximumSourceClientMs);
    const sourceClientTimeoutMs = Math.min(requestedSourceClientMs, maximumSourceClientMs);
    const transportReserveMs = Math.min(30 * 1000, Math.max(5000, Math.floor(sourceClientTimeoutMs * 0.05)));
    const maximumSourcingMs = sourceClientTimeoutMs - transportReserveMs;
    const requestedSourcingMs = finitePositive(options.sourcingBudgetMs, maximumSourcingMs);
    const sourcingBudgetMs = Math.min(requestedSourcingMs, maximumSourcingMs);
    if (sourcingBudgetMs <= 0) {
      throw sourceError('invalid_sourcing_timeout_budget', 'source client timeout is too small for sourcing', 400);
    }
    const followupReserveMs = Math.min(5 * 60 * 1000,
      Math.max(15 * 1000, Math.floor(sourcingBudgetMs * 0.2)));
    const browserBudgetMs = Math.max(0, sourcingBudgetMs - followupReserveMs);
    return { workflowTimeoutMs, applyTimeoutMs, handoffReserveMs, sourceClientTimeoutMs,
      sourcingBudgetMs, browserBudgetMs, followupReserveMs,
      clampedSourceTimeout: requestedSourceClientMs !== sourceClientTimeoutMs,
      clampedSourcingBudget: requestedSourcingMs !== sourcingBudgetMs };
  }
  function standaloneDeadline(options = {}) {
    const now = options.now == null ? Date.now() : Number(options.now);
    const maximumBudgetMs = finitePositive(options.maximumBudgetMs, DEFAULT_STANDALONE_SOURCE_MS);
    const requestedBudgetMs = finitePositive(options.sourcingBudgetMs, maximumBudgetMs);
    const budgetMs = Math.min(requestedBudgetMs, maximumBudgetMs);
    const requestedDeadline = Number(options.deadlineMs);
    const deadlineMs = Number.isFinite(requestedDeadline)
      ? Math.min(requestedDeadline, now + budgetMs) : now + budgetMs;
    if (deadlineMs <= now) throw sourceError('sourcing_deadline_exceeded', 'sourcing_deadline_exceeded', 408);
    return { deadlineMs, budgetMs: deadlineMs - now };
  }

  const api = { SOURCE_STORAGE_KEYS, sourceError, remainingDeadlineMs, optionalRunId, sourceDecision,
    assertSourceDecision, guardedMutation, storageObserved, compactSourcingStorage, readObservedSourcingStorage,
    withObservedSourcingStorage, calculateWorkflowBudgets, standaloneDeadline };
  if (root) root.PJASourceSafety = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
