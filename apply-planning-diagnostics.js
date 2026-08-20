'use strict';

// Privacy-safe diagnostics shared by the dev-server and the extension's exact-run observer.
(function (root) {
  const EXACT_CANDIDATE_CODE = 'exact_candidate_ids_not_ready';

  function count(value) {
    return Math.max(0, Math.min(1000000, Number(value) || 0));
  }

  function token(value, limit = 100) {
    return String(value == null ? '' : value).toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, limit);
  }

  function stableIds(values, limit = 50) {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = String(value == null ? '' : value).replace(/[\r\n\t]/g, '').trim().slice(0, 180);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (out.length < limit) out.push(id);
    }
    return out;
  }

  function compactCandidateSelection(value = {}, options = {}) {
    const idLimit = Math.max(1, Math.min(100, Number(options.idLimit) || 50));
    const missingSource = Array.isArray(value.missingCandidateIds) ? value.missingCandidateIds : [];
    const unexpectedSource = Array.isArray(value.unexpectedCandidateIds) ? value.unexpectedCandidateIds : [];
    return {
      required: value.required === true || value.requireExactCandidateIds === true,
      exact: value.exact === true,
      requestedCount: count(value.requestedCount),
      selectedCount: count(value.selectedCount),
      missingCandidateIds: stableIds(missingSource, idLimit),
      unexpectedCandidateIds: stableIds(unexpectedSource, idLimit),
      diagnosticsTruncated: value.diagnosticsTruncated === true ||
        missingSource.length > idLimit || unexpectedSource.length > idLimit,
    };
  }

  function compactScoringAvailability(value) {
    if (!value || typeof value !== 'object') return null;
    const status = token(value.status, 40);
    return {
      status: /^(available|degraded|unavailable)$/.test(status) ? status : 'unknown',
      code: token(value.code, 80),
      reason: token(value.reason, 80),
      retryable: value.retryable == null ? null : value.retryable === true,
      engine: token(value.engine, 40),
      attempted: count(value.attempted),
      scored: count(value.scored),
      failed: count(value.failed),
    };
  }

  function compactPlanningDrops(value, options = {}) {
    if (!value || typeof value !== 'object') return null;
    const reasonLimit = Math.max(1, Math.min(100, Number(options.reasonLimit) || 50));
    const counts = {};
    for (const [rawReason, rawCount] of Object.entries(value.counts || {})) {
      if (Object.keys(counts).length >= reasonLimit) break;
      const reason = token(rawReason, 100);
      const n = count(rawCount);
      if (reason && !/^(?:__proto__|prototype|constructor)$/.test(reason) && n) counts[reason] = n;
    }
    return { total: count(value.total || Object.values(counts).reduce((sum, n) => sum + n, 0)), counts };
  }

  function exactCandidateFailure(value) {
    if (!value || token(value.code, 80) !== EXACT_CANDIDATE_CODE) return null;
    const selectionSource = value.candidateSelection && typeof value.candidateSelection === 'object'
      ? value.candidateSelection : value;
    return {
      code: EXACT_CANDIDATE_CODE,
      error: 'exact candidate ID selection is not ready',
      stage: 'planning',
      candidateSelection: compactCandidateSelection(selectionSource),
      scoringAvailability: compactScoringAvailability(value.scoringAvailability),
      planningDrops: compactPlanningDrops(value.planningDrops),
    };
  }

  function scoringEngineFailure(value) {
    if (!value || token(value.code, 80) !== 'ai_engine_unavailable') return null;
    return {
      code: 'ai_engine_unavailable',
      error: 'AI scoring engine is unavailable',
      stage: 'scoring',
      scoringAvailability: compactScoringAvailability(value.scoringAvailability),
      planningDrops: compactPlanningDrops(value.planningDrops),
    };
  }

  function compactWorkerFailure(value) {
    if (!value || typeof value !== 'object') return null;
    return exactCandidateFailure(value) || scoringEngineFailure(value) ||
      exactCandidateFailure(value.apply) || scoringEngineFailure(value.apply);
  }

  const API = { EXACT_CANDIDATE_CODE, token, stableIds, compactCandidateSelection,
    compactScoringAvailability, compactPlanningDrops, exactCandidateFailure,
    scoringEngineFailure, compactWorkerFailure };
  if (root) root.PJAPlanningDiagnostics = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
