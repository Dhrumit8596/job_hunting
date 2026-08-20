'use strict';

const Diagnostics = require('../../apply-planning-diagnostics');
const RunControl = require('../../apply-run-control');

module.exports = t => {
  const input = {
    code: 'exact_candidate_ids_not_ready',
    error: 'unsafe caller-controlled error candidate@example.com',
    stage: 'anything',
    candidateSelection: {
      required: true, exact: false, requestedCount: 10, selectedCount: 8,
      missingCandidateIds: ['workday:tenant:R1', 'greenhouse:2', 'greenhouse:2'],
      unexpectedCandidateIds: ['unexpected:3'],
      company: 'Private Candidate Company',
    },
    scoringAvailability: {
      status: 'unavailable', code: 'ai_engine_unavailable', reason: 'usage_limit',
      retryable: false, engine: 'codex', attempted: 10, scored: 0, failed: 10,
      rawDiagnostic: 'candidate resume text',
    },
    planningDrops: {
      total: 12, counts: { rescore_ai_engine_unavailable: 10, candidate_allow_filter: 2 },
      examples: [{ company: 'Private Co', title: 'Private Role', applyUrl: 'https://private.example/job' }],
    },
    profile: { email: 'candidate@example.com' },
    source: { fullCorpus: true },
  };
  const compact = Diagnostics.exactCandidateFailure(input);
  t.eq(compact, {
    code: 'exact_candidate_ids_not_ready',
    error: 'exact candidate ID selection is not ready',
    stage: 'planning',
    candidateSelection: {
      required: true, exact: false, requestedCount: 10, selectedCount: 8,
      missingCandidateIds: ['workday:tenant:R1', 'greenhouse:2'],
      unexpectedCandidateIds: ['unexpected:3'], diagnosticsTruncated: false,
    },
    scoringAvailability: {
      status: 'unavailable', code: 'ai_engine_unavailable', reason: 'usage_limit', retryable: false,
      engine: 'codex', attempted: 10, scored: 0, failed: 10,
    },
    planningDrops: { total: 12,
      counts: { rescore_ai_engine_unavailable: 10, candidate_allow_filter: 2 } },
  }, 'planning diagnostics: exact-ID failure retains only bounded operational fields');
  const serialized = JSON.stringify(compact);
  t.ok(!serialized.includes('candidate@example.com') && !serialized.includes('Private Co') &&
    !serialized.includes('private.example') && !serialized.includes('rawDiagnostic') &&
    !serialized.includes('examples'),
  'planning diagnostics: candidate, posting, URL, and raw engine details are omitted');
  t.eq(Diagnostics.exactCandidateFailure({ code: 'some_other_failure', candidateSelection: input.candidateSelection }), null,
    'planning diagnostics: unrelated worker failures cannot impersonate the exact-ID diagnostic contract');
  const nestedScoringFailure = { success: false, apply: {
    code: 'ai_engine_unavailable', error: 'raw engine stderr with candidate@example.com', stage: 'anything',
    scoringAvailability: input.scoringAvailability, planningDrops: input.planningDrops,
  } };
  const compactScoringFailure = Diagnostics.compactWorkerFailure(nestedScoringFailure);
  t.eq(compactScoringFailure, {
    code: 'ai_engine_unavailable', error: 'AI scoring engine is unavailable', stage: 'scoring',
    scoringAvailability: compact.scoringAvailability, planningDrops: compact.planningDrops,
  }, 'planning diagnostics: nested apply scoring outages are allowlisted for durable exact-run monitoring');
  const durable = RunControl.build(null, { runId: 'apply-observed-scoring-outage', status: 'failed',
    phase: 'terminal', terminalReason: compactScoringFailure.code, ...compactScoringFailure },
  { create: true, now: 12345 });
  t.eq(Diagnostics.compactWorkerFailure(durable), compactScoringFailure,
    'planning diagnostics: an owned terminal control retains the same public scoring-outage projection');
};
