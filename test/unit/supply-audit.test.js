'use strict';

const { summarizeSupply, roleFamily, seniority } = require('../../sourcing/supply-audit');

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
        descriptionReady: true, descriptionStatus: 'complete', postedAt: '2026-08-16' },
      b: { id: 'b', title: 'Senior Quality Engineer', ats: 'workday', location: 'Austin, TX',
        descriptionReady: true, descriptionStatus: 'complete', postedAt: '2026-07-01' },
      c: { id: 'c', title: 'Software Engineer', ats: 'lever', location: 'Remote',
        descriptionReady: false, descriptionStatus: 'missing', discoveredAt: '' },
    },
    state: {
      a: { fitScore: 81, scoreKind: 'llm', status: 'sourced', candidateFingerprint: 'candidate-1',
        matchEvidence: ['SPC', 'wafer', 'metrology'], gaps: [], conflicts: [], confidence: 'high' },
      b: { fitScore: 61, scoreKind: 'llm', status: 'sourced', matchEvidence: ['quality'], gaps: ['8 years'], conflicts: [], confidence: 'medium' },
      c: { fitScore: 20, scoreKind: 'heuristic', status: 'score_pending' },
    },
  };
  const audit = summarizeSupply(corpus, { threshold: 75, candidateFingerprint: 'candidate-1',
    now: Date.parse('2026-08-18T00:00:00Z'),
    isLocationEligible: posting => /Santa Clara|Remote/.test(posting.location) });
  t.eq(audit.total, 3, 'supply audit: reports whole corpus size');
  t.eq(audit.atOrAboveThreshold, 1, 'supply audit: counts score-qualified rows');
  t.eq(audit.evidenceQualified, 1, 'supply audit: requires fingerprinted direct evidence');
  t.eq(audit.fresh7d, 1, 'supply audit: prioritizes fresh seven-day rows');
  t.eq(audit.locationMismatch, 1, 'supply audit: measures hard-location mismatch separately');
  t.eq(audit.belowThresholdCauseInference.seniority_mismatch, 1,
    'supply audit: seniority mismatch is separated from evidence gaps');
  t.eq(audit.belowThresholdCauseInference.wrong_role_family, 1,
    'supply audit: wrong role family is separated from relevant families');
  t.ok(!JSON.stringify(audit).includes('8 years'),
    'supply audit: output never copies detailed gap or description text');
};
