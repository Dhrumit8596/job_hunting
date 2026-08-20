'use strict';

const Frontier = require('../../scoring-frontier');
const Evidence = require('../../scoring-evidence');

module.exports = t => {
  const evidence = overrides => ({ ...Evidence.normalizeScoreResult({
    score: 82,
    matchEvidence: ['process control', 'root-cause analysis', 'manufacturing quality'],
    gapDetails: [{ text: 'One adjacent tool', severity: 'trainable', basis: 'required' }],
    conflicts: [], confidence: 'high',
    transferability: { level: 'adjacent', rationale: 'The core process duties are evidenced.' },
  }), ...overrides });
  const reusable = { id: 'cached', scoreKind: 'llm', fitScore: 82, ...evidence(),
    postingDescriptionFingerprint: 'jd-1', descriptionFingerprint: 'jd-1', candidateFingerprint: 'candidate-1',
    scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION };
  const staleA = { id: 'new-a', fitScore: 60, postingDescriptionFingerprint: 'jd-2' };
  const staleB = { id: 'new-b', scoreKind: 'llm', fitScore: 75,
    postingDescriptionFingerprint: 'jd-new', descriptionFingerprint: 'jd-old', candidateFingerprint: 'candidate-1' };
  const frontier = Frontier.partition([reusable, staleA, staleB], { limit: 1, candidateFingerprint: 'candidate-1' });
  t.eq(frontier.reusable.map(j => j.id), ['cached'], 'scoring frontier: matching cached evidence remains reusable');
  t.eq(frontier.needsScore.map(j => j.id), ['new-a'], 'scoring frontier: budget applies to the first uncached candidate');
  t.eq(frontier.deferred.map(j => j.id), ['new-b'], 'scoring frontier: stale candidates beyond the new-score budget are explicit');
  t.eq(Frontier.partition([reusable, staleA], { limit: 1, candidateFingerprint: 'candidate-1' }).reusable.length, 1,
    'scoring frontier: reusable scores do not consume the model-call limit');
  const legacyPolicy = { ...reusable, id: 'legacy', scoringPolicyVersion: '' };
  t.eq(Frontier.partition([legacyPolicy], { limit: 1, candidateFingerprint: 'candidate-1' }).needsScore.map(j => j.id),
    ['legacy'], 'scoring frontier: a policy-version change makes otherwise matching cached evidence stale');
  const cacheShape = { ...reusable, fitScore: 68 };
  const validLowStretch = { ...cacheShape, id: 'valid-low-stretch', ...evidence({
    score: 53, matchEvidence: [], confidence: 'low',
    transferability: { level: 'stretch', rationale: 'Core electrical design experience is absent.' },
  }), fitScore: 53 };
  t.eq(Frontier.partition([cacheShape, validLowStretch], {
    candidateFingerprint: 'candidate-1',
  }).reusable.map(j => j.id), ['cached', 'valid-low-stretch'],
  'scoring frontier: complete below-threshold and low-confidence evidence remains reusable');
  const fallbackEvidence = evidence({ matchEvidence: [], confidence: 'low',
    transferability: { level: 'stretch', rationale: '' } });
  const invalidCached = [
    { ...cacheShape, id: 'null-fit', fitScore: null },
    { ...cacheShape, id: 'insufficient-qualifying-evidence', fitScore: 75,
      matchEvidence: cacheShape.matchEvidence.slice(0, 2) },
    { ...cacheShape, id: 'zero-qualifying-evidence', fitScore: 75, matchEvidence: [] },
    { ...cacheShape, id: 'fallback-shape', ...fallbackEvidence, fitScore: 75 },
    { ...cacheShape, id: 'low-qualifying-confidence', fitScore: 75, confidence: 'low' },
    { ...cacheShape, id: 'qualifying-hard-conflict', fitScore: 75,
      conflicts: ['A required credential is absent.'] },
    { ...cacheShape, id: 'stretch-at-qualification', fitScore: 75,
      transferability: { level: 'stretch', rationale: 'The core function is not evidenced.' } },
    { ...cacheShape, id: 'missing-transferability', transferability: null },
    { ...cacheShape, id: 'invalid-transferability',
      transferability: { level: 'unknown', rationale: 'Unknown classification.' } },
    (() => { const row = { ...cacheShape, id: 'incomplete-gap-contract' }; delete row.gapDetails; return row; })(),
  ];
  t.eq(Frontier.partition(invalidCached, { candidateFingerprint: 'candidate-1' }).needsScore.map(j => j.id),
    invalidCached.map(j => j.id),
  'scoring frontier: structurally invalid current-fingerprint LLM cache rows stay in needsScore');
  const ordered = Frontier.sortForScoring([
    { id: 'old-high', fitScore: 75, sourcePriority: 'unchanged' },
    { id: 'new-mid', fitScore: 65, sourcePriority: 'newly_sourced' },
    { id: 'hydrated-low', fitScore: 53, sourcePriority: 'newly_hydrated' },
    { id: 'updated', fitScore: 70, sourcePriority: 'description_updated' },
  ]);
  t.eq(ordered.map(job => job.id), ['new-mid', 'hydrated-low', 'updated', 'old-high'],
    'scoring frontier: new/hydrated evidence is fit-ordered before consuming the old frontier');
  t.eq(Frontier.roundPlan(450), [{ offset: 0, size: 100 }, { offset: 100, size: 100 },
    { offset: 200, size: 100 }], 'scoring frontier: progressive rounds have a hard 300-job maximum');
  t.eq(Frontier.continueAfterRound({ scored: 100, qualified: 0, qualifiedTotal: 3, remaining: 200 }).reason,
    'zero_marginal_qualified_yield', 'scoring frontier: zero marginal qualified yield stops later calls');
  const failedBatch = Frontier.summarizeBatch([
    { id: 'failed-a', fitScore: null, scoreError: 'ai_engine_unavailable',
      scoreErrorReason: 'usage_limit', scoreErrorRetryable: false, scoreErrorEngine: 'codex' },
    { id: 'failed-b', fitScore: null, scoreError: 'ai_engine_unavailable',
      scoreErrorReason: 'usage_limit', scoreErrorRetryable: false, scoreErrorEngine: 'codex' },
  ], 2);
  t.eq({ attempted: failedBatch.attempted, scored: failedBatch.scored, failed: failedBatch.failed,
    engineUnavailable: failedBatch.engineUnavailable, failureReason: failedBatch.failureReason,
    retryable: failedBatch.retryable },
  { attempted: 2, scored: 0, failed: 2, engineUnavailable: true, failureReason: 'usage_limit', retryable: false },
  'scoring frontier: failed engine calls are failures, never successful scores');
  t.eq(Frontier.continueAfterRound({ attempted: 10, scored: 0, failed: 10,
    engineUnavailable: true, qualified: 0, remaining: 90 }).reason,
  'ai_engine_unavailable', 'scoring frontier: engine unavailability is distinct from zero marginal fit yield');
  t.eq(Frontier.exactCandidateIdMembership(['job-a', 'job-b', 'job-b'],
    [{ id: 'job-b' }, { id: 'job-a' }]),
  { exact: true, requestedCount: 2, selectedCount: 2,
    missingCandidateIds: [], unexpectedCandidateIds: [] },
  'candidate admission: exact membership compares unique stable IDs independent of ordering');
  t.eq(Frontier.exactCandidateIdMembership(['job-a', 'job-b'],
    [{ id: 'job-a' }, { id: 'job-extra' }]),
  { exact: false, requestedCount: 2, selectedCount: 2,
    missingCandidateIds: ['job-b'], unexpectedCandidateIds: ['job-extra'] },
  'candidate admission: missing and unexpected queue IDs remain explicit');
  t.eq(Frontier.continueAfterRound({ scored: 80, qualified: 7, qualifiedTotal: 30, remaining: 120 }).reason,
    'qualified_reserve_target_reached', 'scoring frontier: reserve target stops later calls');
  const mismatchFirst = Frontier.sortForScoring([
    { id: 'cached', title: 'Process Engineer', descriptionReady: true, candidateFingerprint: 'current' },
    { id: 'stale', title: 'Process Engineer', descriptionReady: true, candidateFingerprint: 'old' },
  ], { candidateFingerprint: 'current' });
  t.eq(mismatchFirst.map(job => job.id), ['stale', 'cached'],
    'scoring frontier: candidate-fingerprint mismatches are prioritized ahead of unchanged scores');
  const levelOrdered = Frontier.sortForScoring([
    { id: 'staff', title: 'Staff Process Engineer', descriptionReady: true },
    { id: 'senior', title: 'Senior Process Engineer', descriptionReady: true },
    { id: 'level-two', title: 'Process Engineer II', descriptionReady: true },
  ], { seniorityBand: 'early_mid' });
  t.eq(levelOrdered.map(job => job.id), ['level-two', 'senior', 'staff'],
    'scoring frontier: resume-aligned Engineer II roles precede senior and staff stretches');
};
