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
  t.ok(Evidence.SCORE_POLICY_PROMPT.includes('Chemical, wastewater, battery, biotech') &&
    Evidence.SCORE_POLICY_PROMPT.includes('Never claim experience that is absent'),
  'scoring evidence: the shared prompt explicitly permits adjacent domains while preserving truthfulness');
};
