'use strict';

const Policy = require('../../sourcing/search-policy');

module.exports = t => {
  t.eq(Policy.inferCandidateSeniority({ currentTitle: 'Senior Calibration Technician',
    yearsExperience: '4' }, {}), 'early_mid',
  'search policy: a senior technician title does not invent senior-engineer eligibility at four years');
  t.eq(Policy.inferCandidateSeniority({ yearsExperience: '4' }, { searchSeniority: 'mid_senior' }),
    'mid_senior', 'search policy: explicit configured seniority overrides automatic derivation');
  t.eq(Policy.inferCandidateSeniority({ yearsExperience: '2' }, {}), 'entry',
    'search policy: early experience targets entry and Engineer I roles');

  const result = Policy.buildSearchQueries({
    savedTitles: ['Quality Engineer', 'Manufacturing Quality Engineer', 'Inspection Engineer',
      'Metrology Engineer', 'Process Engineer', 'Supplier Quality Engineer', 'Validation Engineer',
      'Test Engineer', 'Equipment Engineer', 'Failure Analysis Engineer'],
    adjacentTitles: ['Wafer Inspection Engineer', 'Semiconductor Metrology Engineer',
      'Semiconductor Process Engineer', 'Yield Engineer', 'Manufacturing Engineer',
      'Product Development Engineer'],
    profile: { currentTitle: 'Senior Calibration Technician', yearsExperience: '4' },
    prefs: {}, limit: 20,
  });
  t.eq(result.seniorityBand, 'early_mid', 'search policy: query plan records its derived seniority band');
  t.eq(result.queries.length, 20, 'search policy: expanded title plan remains bounded to twenty queries');
  t.ok(result.queries.includes('Quality Engineer II') && result.queries.includes('Process Engineer II'),
    'search policy: four-year profile adds Engineer II variants to broad high-signal titles');
  t.ok(result.queries.includes('Wafer Inspection Engineer') && result.queries.includes('Yield Engineer'),
    'search policy: audited resume-supported adjacent titles enter the bounded frontier');
  t.ok(!result.queries.some(query => /\b(staff|principal)\b/i.test(query)),
    'search policy: automatic expansion never creates unsupported staff-plus searches');

  t.eq(Policy.postingSeniority('Process Engineer II'), 'early_career',
    'search policy: Engineer II is classified as the intended early/mid target');
  t.eq(Policy.isCompatiblePostingSeniority('Staff Process Engineer', 'early_mid'), false,
    'search policy: staff roles are deterministically incompatible with the four-year band');
  t.eq(Policy.isCompatiblePostingSeniority('Senior Metrology Engineer', 'early_mid'), true,
    'search policy: senior roles remain available for requirement-level evidence scoring');
  t.eq(Policy.isCompatiblePostingSeniority('Senior Metrology Engineer', 'entry'), false,
    'search policy: entry band does not spend sourcing/scoring budget on senior roles');
  t.eq(Policy.allowsAuthoritativeRetirement({ explicit: true }), false,
    'search policy: targeted explicit query runs cannot retire records from unqueried families');
  t.eq(Policy.allowsAuthoritativeRetirement({ explicit: false }), true,
    'search policy: a complete saved-title policy can authoritatively refresh the corpus');
  t.eq(Policy.allowsAuthoritativeRetirement({ explicit: true }, true), true,
    'search policy: an explicit operator retirement override remains intentional and scoped');
  t.eq(Policy.corpusRetirementDecision({ explicit: true }, undefined, { pass: true }).replaceMissing,
    false, 'search policy: a passing targeted source run remains merge-only at the import boundary');
  t.eq(Policy.corpusRetirementDecision({ explicit: false }, undefined, { pass: true }).replaceMissing,
    true, 'search policy: a passing complete saved-title refresh can retire missing records');
  t.eq(Policy.corpusRetirementDecision({ explicit: true }, true, { pass: false }).replaceMissing,
    false, 'search policy: operator authority cannot override a failed corpus quality gate');
};
