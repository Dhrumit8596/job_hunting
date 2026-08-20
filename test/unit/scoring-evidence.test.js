'use strict';

const Evidence = require('../../scoring-evidence');

module.exports = t => {
  const normalized = Evidence.normalizeScoreResult({
    score: 82,
    matchEvidence: ['manufacturing process control', 'wafer inspection', 'root-cause analysis'],
    gapDetails: [
      { text: 'Own one core qualification process', severity: 'material', basis: 'required' },
      { text: 'Specific deposition platform', severity: 'trainable', basis: 'required' },
      { text: 'Vacuum pump model familiarity', severity: 'trainable', basis: 'unclear' },
      { text: 'Six Sigma certification', severity: 'preferred', basis: 'preferred' },
    ],
    conflicts: [], confidence: 'high',
    transferability: { level: 'adjacent', rationale: 'Core process-control duties are evidenced.' },
  });
  t.eq(normalized.materialGaps, ['Own one core qualification process'],
    'scoring evidence: only an unmet core requirement counts as a material gap');
  t.eq(normalized.trainableGaps, ['Specific deposition platform', 'Vacuum pump model familiarity'],
    'scoring evidence: adjacent tools remain visible as trainable gaps');
  t.eq(normalized.preferredGaps, ['Six Sigma certification'],
    'scoring evidence: preferred qualifications remain visible without becoming material');
  t.eq(Evidence.gapCounts(normalized), { material: 1, trainable: 2, preferred: 1 },
    'scoring evidence: the gate can audit each gap class independently');
  t.eq(Evidence.shouldCapBelowQualification(normalized), false,
    'scoring evidence: an adjacent role may qualify when its core duties are evidenced');
  t.ok(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 68 }),
    'scoring evidence: a complete below-threshold result remains reusable');
  const unrelated = Evidence.normalizeScoreResult({ score: 32, matchEvidence: [],
    gapDetails: [{ text: 'Core electrical-design experience', severity: 'material', basis: 'required' }],
    conflicts: [], confidence: 'low',
    transferability: { level: 'stretch', rationale: 'The resume does not evidence the core electrical-design work.' },
  });
  t.ok(Evidence.hasCompleteScoreEvidence({ ...unrelated, fitScore: 32 }),
    'scoring evidence: complete below-threshold unrelated evidence may validly have zero direct matches');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 75,
    matchEvidence: normalized.matchEvidence.slice(0, 2) }), false,
  'scoring evidence: a score at the qualification boundary requires at least three direct matches');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 75, confidence: 'low' }), false,
    'scoring evidence: a qualifying cached score requires medium or high confidence');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 75,
    conflicts: ['A required credential is absent.'] }), false,
  'scoring evidence: a qualifying cached score cannot contain a hard conflict');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 75,
    transferability: { level: 'stretch', rationale: 'The core function is not evidenced.' } }), false,
  'scoring evidence: a qualifying cached score must classify transferability as direct or adjacent');
  t.ok(Evidence.isQualifyingTransferability(normalized) &&
    Evidence.isQualifyingTransferability({ transferability: { level: 'direct' } }) &&
    !Evidence.isQualifyingTransferability({ transferability: { level: 'stretch' } }),
  'scoring evidence: the shared qualification helper accepts only direct and adjacent transferability');
  t.eq(Evidence.summarize([normalized]), { jobs: 1,
    transferability: { direct: 0, adjacent: 1, stretch: 0 },
    gapTotals: { material: 1, trainable: 2, preferred: 1 },
    jobsWithMaterialGaps: 1, jobsWithOnlyTransferableGaps: 0 },
  'scoring evidence: reporting exposes bounded gap-class and transferability counts');

  const legacy = { gaps: ['CAD', 'vacuum systems', 'supplier audits'] };
  t.eq(Evidence.materialGaps(legacy), legacy.gaps,
    'scoring evidence: legacy flat gaps remain conservatively material until rescore');
  t.eq(Evidence.isCurrentPolicy(legacy), false,
    'scoring evidence: legacy evidence is not reusable under the new scoring contract');
  t.eq(Evidence.normalizeGap({ text: 'Unknown classification', severity: 'maybe' }).severity, 'material',
    'scoring evidence: malformed severity fails closed as material');
  t.eq(Evidence.shouldCapBelowQualification(Evidence.normalizeScoreResult({
    score: 90, confidence: 'high', transferability: { level: 'stretch' },
  })), true, 'scoring evidence: stretch roles cannot become qualified solely from a high raw score');
  t.eq(Evidence.normalizeScoreResult({ score: 'not-a-number' }).score, 0,
    'scoring evidence: malformed model scores fail closed');
  const fallback = Evidence.normalizeScoreResult({ score: 75,
    transferability: { level: 'stretch' } });
  t.eq(Evidence.hasCompleteScoreEvidence({ ...fallback, fitScore: 75 }), false,
    'scoring evidence: the low-confidence empty-evidence stretch fallback is incomplete');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82, transferability: null }), false,
    'scoring evidence: missing transferability cannot make a cached score reusable');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
    transferability: { level: 'unknown', rationale: 'Unrecognized classification.' } }), false,
  'scoring evidence: invalid transferability cannot make a cached score reusable');
  const incompleteGaps = { ...normalized, fitScore: 82 };
  delete incompleteGaps.gapDetails;
  t.eq(Evidence.hasCompleteScoreEvidence(incompleteGaps), false,
    'scoring evidence: current-policy cache entries still require the structured gap contract');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82, materialGaps: [] }), false,
    'scoring evidence: a cached score cannot hide structured material gaps in an empty derived array');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
    trainableGaps: ['Different trainable gap'] }), false,
  'scoring evidence: severity-specific cached arrays must match structured gap details');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
    gaps: normalized.gaps.slice(1) }), false,
  'scoring evidence: the flat cached gap projection must match all structured gap details');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 1000 }), false,
    'scoring evidence: out-of-range cached scores are never reusable');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
    transferability: { level: 'adjacent', rationale: { text: 'not a string' } } }), false,
  'scoring evidence: object-valued cached transferability rationale is never reusable');
  t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
    gapDetails: [{ ...normalized.gapDetails[0], text: { value: 'not a string' } },
      ...normalized.gapDetails.slice(1)] }), false,
  'scoring evidence: object-valued cached structured-gap fields are never reusable');
  for (const key of ['matchEvidence', 'gaps', 'materialGaps', 'trainableGaps', 'preferredGaps', 'conflicts']) {
    t.eq(Evidence.hasCompleteScoreEvidence({ ...normalized, fitScore: 82,
      [key]: [...normalized[key], { value: 'not a string' }] }), false,
    `scoring evidence: cached ${key} items must be actual nonempty strings`);
  }
  t.ok(Evidence.SCORE_POLICY_PROMPT.includes('Chemical, wastewater, battery, biotech') &&
    Evidence.SCORE_POLICY_PROMPT.includes('Never claim experience that is absent'),
  'scoring evidence: the shared prompt explicitly permits adjacent domains while preserving truthfulness');
};
