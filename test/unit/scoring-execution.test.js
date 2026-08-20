'use strict';

const Execution = require('../../scoring-execution');

module.exports = async t => {
  const validScore = (id, score = 80, overrides = {}) => ({
    id, score, matchEvidence: ['process control', 'root-cause analysis', 'manufacturing quality'],
    gapDetails: [], conflicts: [], confidence: 'high',
    transferability: { level: 'direct', rationale: 'Directly evidenced process-engineering duties.' },
    ...overrides,
  });
  const requested = [{ id: 'job-a' }, { id: 'job-b' }];
  const selected = Execution.selectRequestedScoreRows(requested, [
    null,
    { id: '' },
    validScore('unexpected', 99),
    validScore('job-a', 81),
    validScore('job-a', 4),
  ]);
  t.eq({ ids: selected.rows.map(row => row.id), missingIds: selected.missingIds,
    requestedCount: selected.requestedCount, complete: selected.complete },
  { ids: ['job-a'], missingIds: ['job-b'], requestedCount: 2, complete: false },
  'score execution: null, empty, unexpected, and duplicate IDs cannot hide a missing requested job');

  const ordered = Execution.selectRequestedScoreRows(requested,
    [validScore('job-b', 77), validScore('job-a', 82)]);
  t.eq({ ids: ordered.rows.map(row => row.id), complete: ordered.complete },
    { ids: ['job-a', 'job-b'], complete: true },
    'score execution: a complete response is normalized to exact request order');

  let attempts = 0;
  const retried = await Execution.scoreJobChunkWithRetry(requested, 0, {
    maxAttempts: 2, wait: async () => {}, random: () => 0, log: () => {},
    scoreChunk: async () => {
      attempts += 1;
      return attempts === 1
        ? [validScore('unexpected', 100), validScore('job-a', 80)]
        : [validScore('job-b', 79), validScore('job-a', 80)];
    },
  });
  t.eq({ attempts, ids: retried.map(row => row.id) },
    { attempts: 2, ids: ['job-a', 'job-b'] },
    'score execution: unexpected rows do not satisfy completeness and trigger a bounded retry');

  let complementaryAttempts = 0;
  const complementary = await Execution.scoreJobChunkWithRetry(requested, 0, {
    maxAttempts: 2, wait: async () => {}, random: () => 0, log: () => {},
    scoreChunk: async () => {
      complementaryAttempts += 1;
      return complementaryAttempts === 1 ? [validScore('job-a', 81)] : [validScore('job-b', 79)];
    },
  });
  t.eq({ attempts: complementaryAttempts, ids: complementary.map(row => row.id) },
    { attempts: 2, ids: ['job-a', 'job-b'] },
    'score execution: complementary valid partials accumulate across retries in request order');

  let partialAttempts = 0;
  const partial = await Execution.scoreJobChunkWithRetry(requested, 0, {
    maxAttempts: 2, wait: async () => {}, random: () => 0, log: () => {},
    scoreChunk: async () => {
      partialAttempts += 1;
      return [validScore('job-a', 80), validScore('job-a', 2), validScore('foreign', 100)];
    },
  });
  t.eq({ attempts: partialAttempts, ids: partial.map(row => row.id) },
    { attempts: 2, ids: ['job-a'] },
    'score execution: final partial results contain matching requested rows only');

  const invalidSchema = Execution.selectRequestedScoreRows(requested, [
    { id: 'job-a' },
    validScore('job-b', 91, { gapDetails: undefined, conflicts: undefined }),
  ]);
  t.eq({ rows: invalidSchema.rows, missingIds: invalidSchema.missingIds,
    invalidIds: invalidSchema.invalidIds, complete: invalidSchema.complete },
  { rows: [], missingIds: ['job-a', 'job-b'], invalidIds: ['job-a', 'job-b'], complete: false },
  'score execution: ID-only and high-score rows missing gap/conflict contracts remain failed and retryable');
  t.eq(Execution.hasValidRawScoreSchema(validScore('job-a', 85, {
    gapDetails: [{ text: 'Tool family', severity: 'trainable', basis: 'required' }],
    gaps: ['Different gap'], trainableGaps: ['Tool family'], materialGaps: [], preferredGaps: [],
  })), false, 'score execution: derived gap arrays must agree with structured gap details');
  t.eq(Execution.hasValidRawScoreSchema(validScore('job-a', 85, {
    gapDetails: [
      { text: 'Specific tool family', severity: 'trainable', basis: 'required' },
      { text: '  SPECIFIC   TOOL FAMILY ', severity: 'material', basis: 'required' },
    ],
  })), false,
  'score execution: duplicate normalized gap text cannot hide a conflicting material severity');
  t.eq(Execution.hasValidRawScoreSchema(validScore('job-a', 85, {
    transferability: { level: 'direct', rationale: { text: 'not a string' } },
  })), false, 'score execution: object-valued transferability rationale is invalid raw evidence');
  t.eq(Execution.hasValidRawScoreSchema(validScore('job-a', 85, {
    gapDetails: [{ text: { value: 'tool family' }, severity: 'trainable', basis: 'required' }],
  })), false, 'score execution: object-valued gap fields are invalid raw evidence');
  let schemaAttempts = 0;
  const recoveredSchema = await Execution.scoreJobChunkWithRetry(requested, 0, {
    maxAttempts: 2, wait: async () => {}, random: () => 0, log: () => {},
    scoreChunk: async () => {
      schemaAttempts += 1;
      return schemaAttempts === 1
        ? [{ id: 'job-a' }, validScore('job-b', 90, { gapDetails: undefined, conflicts: undefined })]
        : [validScore('job-a'), validScore('job-b')];
    },
  });
  t.eq({ attempts: schemaAttempts, ids: recoveredSchema.map(row => row.id) },
    { attempts: 2, ids: ['job-a', 'job-b'] },
    'score execution: schema-invalid expected IDs trigger a retry instead of completing the chunk');

  const permanent = Object.assign(new Error('engine unavailable'), { retryable: false });
  let permanentAttempts = 0;
  let permanentResult = null;
  try {
    await Execution.scoreJobChunkWithRetry(requested, 0, {
      maxAttempts: 3, wait: async () => {}, log: () => {},
      scoreChunk: async () => { permanentAttempts += 1; throw permanent; },
    });
  } catch (error) { permanentResult = error; }
  t.ok(permanentResult === permanent && permanentAttempts === 1,
    'score execution: permanent engine failures still open the retry circuit immediately');

  let partialFatalAttempts = 0;
  let partialFatal = null;
  try {
    await Execution.scoreJobChunkWithRetry(requested, 0, {
      maxAttempts: 3, wait: async () => {}, random: () => 0, log: () => {},
      scoreChunk: async () => {
        partialFatalAttempts += 1;
        if (partialFatalAttempts === 1) return [validScore('job-a', 83)];
        throw permanent;
      },
    });
  } catch (error) { partialFatal = error; }
  t.ok(partialFatal && partialFatal.retryable === false && partialFatalAttempts === 2,
    'score execution: a later permanent failure still opens the circuit');
  t.eq(Execution.partialRowsFromError(requested, partialFatal).map(row => row.id), ['job-a'],
    'score execution: schema-valid accumulated partials survive a later permanent failure');
  t.ok(!Object.keys(partialFatal).includes('partialRows') &&
    !JSON.stringify(partialFatal).includes('process control'),
  'score execution: preserved partial evidence is non-enumerable in generic error logs');
  const tamperedPartial = { partialRows: [
    validScore('foreign', 99), { id: 'job-a' }, validScore('job-b', 78), validScore('job-b', 1),
  ] };
  t.eq(Execution.partialRowsFromError(requested, tamperedPartial).map(row => row.id), ['job-b'],
    'score execution: failure partials are revalidated against exact requested IDs and raw schema');
};
