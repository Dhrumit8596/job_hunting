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
};
