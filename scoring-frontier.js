'use strict';

// Build a token-bounded scoring frontier without charging cached evidence scores against the new
// model-call budget. Jobs must already be ordered by deterministic heuristic preference.
function partition(jobs, options = {}) {
  const rows = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const limit = Math.max(0, Number(options.limit) || 0);
  const candidateFingerprint = String(options.candidateFingerprint || '');
  const reusable = [];
  const stale = [];
  for (const job of rows) {
    const postingFingerprint = String(job.postingDescriptionFingerprint || job.descriptionFingerprint || '');
    const cached = job.scoreKind === 'llm' && job.fitScore != null && postingFingerprint &&
      job.descriptionFingerprint === postingFingerprint &&
      String(job.candidateFingerprint || '') === candidateFingerprint;
    (cached ? reusable : stale).push(job);
  }
  const needsScore = limit > 0 ? stale.slice(0, limit) : stale;
  const deferred = limit > 0 ? stale.slice(limit) : [];
  return { reusable, needsScore, deferred };
}

module.exports = { partition };
