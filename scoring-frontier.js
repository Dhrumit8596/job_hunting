'use strict';

const { postingSeniority } = require('./sourcing/search-policy');
const ScoringEvidence = require('./scoring-evidence');

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
      String(job.candidateFingerprint || '') === candidateFingerprint &&
      ScoringEvidence.isCurrentPolicy(job);
    (cached ? reusable : stale).push(job);
  }
  const needsScore = limit > 0 ? stale.slice(0, limit) : stale;
  const deferred = limit > 0 ? stale.slice(limit) : [];
  return { reusable, needsScore, deferred };
}

function sourcePriority(job) {
  const value = String(job && job.sourcePriority || '').toLowerCase();
  if (value === 'newly_hydrated' || value === 'newly_sourced') return 2;
  if (value === 'description_updated') return 1;
  return 0;
}

function deterministicPriority(job, options = {}) {
  let score = sourcePriority(job) * 40;
  const title = String(job && job.title || '');
  if (/\b(process|quality|metrology|inspection|validation|test|equipment|reliability|manufacturing) engineer\b/i.test(title) ||
      /failure analysis engineer/i.test(title)) score += 45;
  const level = postingSeniority(title);
  if (level === 'staff_plus' || level === 'leadership') score -= 60;
  else if (level === 'senior' && /^(entry|early_mid)$/.test(String(options.seniorityBand || ''))) score -= 20;
  else if (level === 'early_career' && /^(entry|early_mid)$/.test(String(options.seniorityBand || ''))) score += 20;
  if (job && job.descriptionReady) score += 25;
  if (job && (job.channel === 'linkedin_easy_apply' || job.channel === 'indeed_apply')) score += 15;
  if (job && job.applyUrl && !/(linkedin|indeed|glassdoor)\.com/i.test(String(job.applyUrl))) score += 15;
  const seen = Date.parse(String(job && (job.lastSeenAt || job.discoveredAt) || ''));
  if (Number.isFinite(seen) && Date.now() - seen <= 7 * 86400000) score += 20;
  else if (Number.isFinite(seen) && Date.now() - seen <= 30 * 86400000) score += 10;
  if (options.candidateFingerprint && job && job.candidateFingerprint !== options.candidateFingerprint) score += 30;
  score += Math.min(20, Number(job && job.fitScore) || 0) / 5;
  return score;
}

function sortForScoring(jobs, options = {}) {
  return (Array.isArray(jobs) ? jobs.slice() : []).sort((a, b) =>
    deterministicPriority(b, options) - deterministicPriority(a, options) ||
    (Number(b && b.fitScore) || 0) - (Number(a && a.fitScore) || 0) ||
    String(a && a.id || '').localeCompare(String(b && b.id || '')));
}

function roundPlan(total, options = {}) {
  const hardMaximum = Math.max(0, Math.min(300, Number(options.maximum) || 300));
  const roundSize = Math.max(10, Math.min(100, Number(options.roundSize) || 100));
  const bounded = Math.min(Math.max(0, Number(total) || 0), hardMaximum);
  const rounds = [];
  for (let offset = 0; offset < bounded; offset += roundSize) rounds.push({ offset,
    size: Math.min(roundSize, bounded - offset) });
  return rounds;
}

function continueAfterRound(result = {}, options = {}) {
  if (Number(result.qualifiedTotal || 0) >= Math.max(1, Number(options.reserveTarget) || 30)) {
    return { continue: false, reason: 'qualified_reserve_target_reached' };
  }
  if (Number(result.scored || 0) > 0 && Number(result.qualified || 0) === 0) {
    return { continue: false, reason: 'zero_marginal_qualified_yield' };
  }
  if (Number(result.remaining || 0) <= 0) return { continue: false, reason: 'frontier_exhausted' };
  return { continue: true, reason: 'credible_remaining_potential' };
}

module.exports = { partition, sourcePriority, deterministicPriority, sortForScoring,
  roundPlan, continueAfterRound };
