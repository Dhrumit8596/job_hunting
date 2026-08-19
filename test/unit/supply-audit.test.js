'use strict';

const { summarizeSupply, roleFamily, seniority } = require('../../sourcing/supply-audit');
const Evidence = require('../../scoring-evidence');

module.exports = async t => {
  t.eq(roleFamily('Senior Wafer Process Integration Engineer'), 'semiconductor_process',
    'supply audit: supported semiconductor title family is recognized');
  t.eq(roleFamily('Software Engineer'), 'other',
    'supply audit: unrelated title remains outside supported role families');
  t.eq(seniority('Principal Quality Engineer'), 'staff_plus',
    'supply audit: staff-plus mismatch is explicit');

  const corpus = {
    index: {
      a: { id: 'a', title: 'Process Engineer II', ats: 'greenhouse', location: 'Santa Clara, CA',
        applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1', descriptionReady: true,
        descriptionStatus: 'complete', descriptionFingerprint: 'jd-a', postedAt: '2026-08-16' },
      b: { id: 'b', title: 'Senior Quality Engineer', ats: 'workday', location: 'Austin, TX',
        descriptionReady: true, descriptionStatus: 'complete', postedAt: '2026-07-01' },
      c: { id: 'c', title: 'Software Engineer', ats: 'lever', location: 'Remote',
        descriptionReady: false, descriptionStatus: 'missing', discoveredAt: '' },
      d: { id: 'd', title: 'Process Engineer', ats: 'greenhouse', location: 'Santa Clara, CA',
        applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/2', descriptionReady: true,
        descriptionStatus: 'complete', descriptionFingerprint: 'jd-d', postedAt: '2026-08-17' },
      e: { id: 'e', title: 'Process Engineer', ats: 'greenhouse', location: 'Santa Clara, CA',
        applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/3', descriptionReady: true,
        descriptionStatus: 'complete', descriptionFingerprint: 'jd-e-new', postedAt: '2026-08-17' },
      f: { id: 'f', title: 'Process Engineer', ats: 'linkedin', sourcePlatform: 'linkedin',
        location: 'Santa Clara, CA', applyUrl: 'https://www.linkedin.com/jobs/view/1234567/',
        channel: 'external', needsAtsResolution: true, descriptionReady: true,
        descriptionStatus: 'full', descriptionFingerprint: 'jd-f', postedAt: '2026-08-17' },
    },
    state: {
      a: { fitScore: 81, scoreKind: 'llm', status: 'sourced', candidateFingerprint: 'candidate-1',
        descriptionFingerprint: 'jd-a', transferability: { level: 'direct' },
        scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
        matchEvidence: ['SPC', 'wafer', 'metrology'], gaps: [], materialGaps: [], conflicts: [], confidence: 'high' },
      b: { fitScore: 61, scoreKind: 'llm', status: 'sourced', matchEvidence: ['quality'], gaps: ['8 years'], conflicts: [], confidence: 'medium' },
      c: { fitScore: 20, scoreKind: 'heuristic', status: 'score_pending' },
      d: { fitScore: 81, scoreKind: 'llm', status: 'needs_manual', attempts: 1,
        candidateFingerprint: 'candidate-1', descriptionFingerprint: 'jd-d',
        transferability: { level: 'adjacent' }, scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
        matchEvidence: ['SPC', 'inspection', 'root cause'], materialGaps: [], conflicts: [], confidence: 'medium' },
      e: { fitScore: 81, scoreKind: 'llm', status: 'sourced', candidateFingerprint: 'candidate-1',
        descriptionFingerprint: 'jd-e-old', transferability: { level: 'direct' },
        scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
        matchEvidence: ['SPC', 'inspection', 'root cause'], materialGaps: [], conflicts: [], confidence: 'high' },
      f: { fitScore: 81, scoreKind: 'llm', status: 'sourced', candidateFingerprint: 'candidate-1',
        descriptionFingerprint: 'jd-f', transferability: { level: 'adjacent' },
        scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
        matchEvidence: ['SPC', 'inspection', 'root cause'], materialGaps: [], conflicts: [], confidence: 'high' },
    },
  };
  const audit = summarizeSupply(corpus, { threshold: 75, candidateFingerprint: 'candidate-1',
    seniorityBand: 'entry',
    now: Date.parse('2026-08-18T00:00:00Z'),
    isLocationEligible: posting => /Santa Clara|Remote/.test(posting.location) });
  t.eq(audit.total, 6, 'supply audit: reports whole corpus size');
  t.eq(audit.atOrAboveThreshold, 4, 'supply audit: keeps numeric score candidates separate from genuine evidence qualification');
  t.eq(audit.evidenceQualified, 3, 'supply audit: overall evidence requires current resume/JD fingerprints and direct or adjacent transferability');
  t.eq({ evidenceScored: audit.evidenceScored, heuristicPrescored: audit.heuristicPrescored },
    { evidenceScored: 5, heuristicPrescored: 1 },
  'supply audit: heuristic prescores are never reported as evidence-scored jobs');
  t.eq(audit.qualificationFunnel, {
    evidenceQualifiedOverall: 3,
    freshUnattemptedState: 2,
    locationEligible: 2,
    supportedRouteReady: 1,
    autonomousRouteReady: 1,
    qualifiedUnattemptedPreLedger: 1,
  }, 'supply audit: truthful funnel separates attempted/manual and unresolved-route rows from the pre-ledger reserve');
  t.eq(audit.qualifiedUnattemptedPreLedger, 1,
    'supply audit: only a fresh zero-attempt current-evidence autonomous route reaches the pre-ledger reserve');
  t.eq(audit.preLedgerDropCounts, { prior_or_nonfresh_state: 1, aggregator_without_apply_destination: 1 },
    'supply audit: evidence-qualified exclusions remain grouped without exposing JD or candidate text');
  t.eq(audit.fresh7d, 4, 'supply audit: prioritizes fresh seven-day rows');
  t.eq(audit.locationMismatch, 1, 'supply audit: measures hard-location mismatch separately');
  t.eq(audit.belowThresholdCauseInference.seniority_mismatch, 1,
    'supply audit: seniority mismatch is separated from evidence gaps');
  t.eq(audit.belowThresholdCauseInference.wrong_role_family, 1,
    'supply audit: wrong role family is separated from relevant families');
  t.ok(!JSON.stringify(audit).includes('8 years'),
    'supply audit: output never copies detailed gap or description text');
};
