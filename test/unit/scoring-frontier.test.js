'use strict';

const Frontier = require('../../scoring-frontier');

module.exports = t => {
  const reusable = { id: 'cached', scoreKind: 'llm', fitScore: 82,
    postingDescriptionFingerprint: 'jd-1', descriptionFingerprint: 'jd-1', candidateFingerprint: 'candidate-1' };
  const staleA = { id: 'new-a', fitScore: 60, postingDescriptionFingerprint: 'jd-2' };
  const staleB = { id: 'new-b', scoreKind: 'llm', fitScore: 75,
    postingDescriptionFingerprint: 'jd-new', descriptionFingerprint: 'jd-old', candidateFingerprint: 'candidate-1' };
  const frontier = Frontier.partition([reusable, staleA, staleB], { limit: 1, candidateFingerprint: 'candidate-1' });
  t.eq(frontier.reusable.map(j => j.id), ['cached'], 'scoring frontier: matching cached evidence remains reusable');
  t.eq(frontier.needsScore.map(j => j.id), ['new-a'], 'scoring frontier: budget applies to the first uncached candidate');
  t.eq(frontier.deferred.map(j => j.id), ['new-b'], 'scoring frontier: stale candidates beyond the new-score budget are explicit');
  t.eq(Frontier.partition([reusable, staleA], { limit: 1, candidateFingerprint: 'candidate-1' }).reusable.length, 1,
    'scoring frontier: reusable scores do not consume the model-call limit');
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
