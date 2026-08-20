'use strict';
// Phase B core: apply-set selection gating + result→state mapping + pool-cleared summary.
const path = require('path');
require(path.resolve(__dirname, '../../sourcing/detect-ats'));
const Evidence = require(path.resolve(__dirname, '../../scoring-evidence'));
const { buildApplySet, buildApplyPlan, resultToState, poolStatus, roleKey, greenhouseEmbedFallback, exceededBudget,
  externalJobBudgetOptions,
  watchdogDecision, queueJobKey, applyLifecycleOwnership, missingTabRecoveryDecision,
  classifyMissingTabOutcome, diagnosticOwnsRankedJob, workdayGmailOwnership,
  emailCodeSubmitRisk, emailCodeOwnership, submittedUnverifiedReason,
  unsupportedAutonomousApplyReason, isPostingSpecificSupportedRoute, isVoyagerPostingSpecificRoute,
  safeUnresolvedLandingUrl,
  applyCapabilityStatus, destinationStrategy,
  hasUsableDescription, applyUrlKey, linkedinJobId, browserFreshnessAt } = require(path.resolve(__dirname, '../../sourcing/apply-select'));

function corpus(entries) {
  const index = {}, state = {};
  for (const e of entries) {
    index[e.id] = { id: e.id, company: e.company, title: e.title, applyUrl: e.applyUrl,
      ats: e.ats || '', description: e.description || 'Role responsibilities and required qualifications.',
      descriptionStatus: e.descriptionStatus || 'full', channel: e.channel || '' };
    state[e.id] = { fitScore: e.fit, status: e.status || 'sourced', attempts: e.attempts || 0 };
  }
  return { index, state };
}

module.exports = (t) => {
  t.eq(linkedinJobId('https://www.linkedin.com/jobs/search-results/?currentJobId=4429434522&keywords=jobs&f_AL=true'),
    '4429434522', 'LinkedIn identity: current search-result selection exposes the posting id');
  t.eq(linkedinJobId('https://www.linkedin.com/jobs/view/integrated-circuit-packaging-architect-4429434522/'),
    '4429434522', 'LinkedIn identity: slugged canonical view URL exposes the posting id');
  t.eq(linkedinJobId('linkedin:4429434522'), '4429434522', 'LinkedIn identity: corpus id is supported');
  t.eq(linkedinJobId('https://example.com/jobs/view/4429434522/'), '', 'LinkedIn identity: foreign hosts are rejected');
  t.eq(applyUrlKey('https://www.linkedin.com/jobs/search-results/?currentJobId=4429434522&keywords=jobs&f_AL=true'),
    applyUrlKey('https://www.linkedin.com/jobs/view/4429434522/'),
    'LinkedIn identity: search-result and canonical view URLs de-duplicate to one key');
  t.eq(applyUrlKey('https://bloomenergy.wd1.myworkdayjobs.com/en-US/BloomEnergyCareers/job/Fremont-California/Senior-Process-Engineer_JR-22717'),
    applyUrlKey('https://bloomenergy.wd1.myworkdayjobs.com/BloomEnergyCareers/job/Fremont-California/Senior-Process-Engineer_JR-22717'),
    'Workday identity: a leading locale is presentation-only and cannot create a retry alias');
  t.eq(destinationStrategy({ ats: 'linkedin', sourcePlatform: 'linkedin', channel: 'external',
    needsAtsResolution: true, applyUrl: 'https://careers.example.com/jobs/R1' }), '',
  'destination strategy: LinkedIn provenance never becomes an off-site application strategy');
  t.eq(destinationStrategy({ ats: 'linkedin', sourcePlatform: 'linkedin', channel: 'external',
    applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application' }), 'ashby',
  'destination strategy: a supported direct URL overrides its LinkedIn discovery provenance');
  t.eq(destinationStrategy({ channel: 'external', needsAtsResolution: true,
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' }), '',
  'destination strategy: an explicit unresolved marker blocks a recognized ATS hostname until attestation');
  t.eq(destinationStrategy({ channel: 'external', needsAtsResolution: false,
    applyUrl: 'https://careers.example.com/jobs/R1', detectedAts: 'indeed' }), '',
  'destination strategy: external metadata cannot impersonate the Indeed native channel');
  t.eq(destinationStrategy({ channel: 'external', needsAtsResolution: false,
    applyUrl: 'https://careers.example.com/jobs/R2', detectedAts: 'linkedin_ea' }), '',
  'destination strategy: external metadata cannot impersonate the LinkedIn Easy Apply channel');
  const unresolvedLandingCorpus = corpus([{ id: 'linkedin:lookup-only', company: 'Shockwave Medical',
    title: 'Supplier Quality Engineer II', applyUrl: 'https://careers.jnj.com/en/jobs/r-086504',
    fit: 95, channel: 'external' }]);
  unresolvedLandingCorpus.index['linkedin:lookup-only'].sourcePlatform = 'linkedin';
  unresolvedLandingCorpus.index['linkedin:lookup-only'].needsAtsResolution = true;
  t.eq(buildApplySet(unresolvedLandingCorpus, { threshold: 75 }), [],
    'route resolution: a retained corporate landing cannot enter the live queue before official resolution');

  const c = corpus([
    { id: 'greenhouse:1', company: 'Carbon', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/carbon/jobs/1', fit: 82 },
    { id: 'greenhouse:2', company: 'Beta', title: 'Quality Engineer', applyUrl: 'https://boards.greenhouse.io/beta/jobs/2', fit: 71 },
    { id: 'lever:3', company: 'Gamma', title: 'Metrology Engineer', applyUrl: 'https://jobs.lever.co/gamma/3', fit: 68 }, // below 70
    { id: 'wd:4', company: 'Delta', title: 'Process Engineer', applyUrl: 'https://d.wd5.myworkdayjobs.com/x', fit: 90, status: 'applied' }, // done
    { id: 'gh:5', company: 'Eps', title: 'Equipment Engineer', applyUrl: 'https://boards.greenhouse.io/eps/jobs/5', fit: 75, status: 'needs_manual', attempts: 1 }, // deferred, retryable
    { id: 'gh:6', company: 'Zed', title: 'Reliability Engineer', applyUrl: 'https://boards.greenhouse.io/zed/jobs/6', fit: 88, status: 'dead' }, // dead
    { id: 'gh:7', company: 'Noh', title: 'Process Engineer', applyUrl: '', fit: 80 }, // no applyUrl
  ]);

  // --- buildApplySet gating ---
  let set = buildApplySet(c, { threshold: 70, dailyCap: 30 });
  const names = set.map(j => j.id);
  t.ok(names.includes('greenhouse:1') && names.includes('greenhouse:2'), 'includes fresh fit>=70');
  t.ok(!names.includes('lever:3'), 'excludes below-threshold');
  t.ok(!names.includes('wd:4'), 'excludes already-applied status');
  t.ok(names.includes('gh:5'), 'includes retryable deferred (needs_manual, attempts<max)');
  t.ok(!names.includes('gh:6'), 'excludes dead posting');
  t.ok(!names.includes('gh:7'), 'excludes job with no applyUrl');
  // eligible = greenhouse:1(82), gh:5(75, retryable), greenhouse:2(71) → sorted desc
  t.eq(set.map(j => j.id), ['greenhouse:1', 'gh:5', 'greenhouse:2'], 'sorted by fit desc');
  t.eq(set[0].fitScore, 82, 'highest fit first (dead gh:6=88 excluded)');
  t.eq(set.map(j => j.strategy).every(Boolean), true, 'every job stamped with a strategy');
  const linkedInOriginExternal = corpus([{ id: 'linkedin:external', company: 'Acme',
    title: 'Test Engineer', applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application', fit: 81,
    ats: 'linkedin', channel: 'external' }]);
  linkedInOriginExternal.index['linkedin:external'].sourcePlatform = 'linkedin';
  t.eq(buildApplySet(linkedInOriginExternal, { threshold: 75 }).map(job => ({
    ats: job.ats, strategy: job.strategy, sourcePlatform: job.sourcePlatform })),
  [{ ats: 'ashby', strategy: 'ashby', sourcePlatform: 'linkedin' }],
  'destination strategy: queued off-site jobs report the owning ATS while preserving discovery provenance');
  const plan = buildApplyPlan(c, { threshold: 70, dailyCap: 30 });
  t.eq(plan.jobs.map(j => j.id), set.map(j => j.id), 'buildApplyPlan preserves buildApplySet selected jobs');
  t.eq(plan.dropCounts.below_threshold, 1, 'buildApplyPlan explains below-threshold planning drops');
  t.eq(plan.dropCounts.state_applied, 1, 'buildApplyPlan explains already-applied state drops');
  t.eq(plan.dropCounts.state_dead, 1, 'buildApplyPlan explains dead posting drops');
  t.eq(plan.dropCounts.missing_apply_url, 1, 'buildApplyPlan explains missing apply URL drops');
  t.ok(plan.dropped.every(j => j.reason && j.company != null && j.title != null), 'buildApplyPlan emits compact developer-readable drop examples');

  const freshnessNow = Date.parse('2026-08-19T12:00:00Z');
  const rediscovered = corpus([{ id: 'linkedin:fresh', company: 'Fresh Co', title: 'Process Engineer',
    applyUrl: 'https://job-boards.greenhouse.io/fresh/jobs/1', fit: 80, ats: 'linkedin' }]);
  Object.assign(rediscovered.index['linkedin:fresh'], { sourcePlatform: 'linkedin',
    discoveredAt: freshnessNow - 10 * 86400000, lastSeenAt: String(freshnessNow - 3600000) });
  t.eq(browserFreshnessAt(rediscovered.index['linkedin:fresh']), freshnessNow - 3600000,
    'browser freshness: numeric-string lastSeenAt is parsed as the rediscovery time');
  t.eq(buildApplySet(rediscovered, { threshold: 75, maxBrowserAgeMs: 48 * 3600000,
    now: freshnessNow }).map(j => j.id), ['linkedin:fresh'],
  'browser freshness: a listing rediscovered within the window remains eligible despite old immutable discovery provenance');
  rediscovered.index['linkedin:fresh'].lastSeenAt = String(freshnessNow - 3 * 86400000);
  t.eq(buildApplyPlan(rediscovered, { threshold: 75, maxBrowserAgeMs: 48 * 3600000,
    now: freshnessNow }).dropCounts.stale_browser_listing, 1,
  'browser freshness: a genuinely old lastSeenAt remains a stale planning drop');

  // dedup vs applied log (role-key)
  const set2 = buildApplySet(c, { threshold: 70, appliedRoleKeys: [roleKey({ company: 'Carbon', title: 'Process Engineer' })] });
  t.ok(!set2.map(j => j.id).includes('greenhouse:1'), 'excludes role in applied log');

  const exactCorpus = corpus([
    { id: 'greenhouse:10', company: 'Acme', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/acme/jobs/10', fit: 85 },
    { id: 'greenhouse:11', company: 'Acme', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/acme/jobs/11', fit: 84 },
  ]);
  exactCorpus.index['greenhouse:10'].sourceJobId = '10';
  exactCorpus.index['greenhouse:11'].sourceJobId = '11';
  const exactSet = buildApplySet(exactCorpus, { threshold: 70, appliedRecords: [{ company: 'Acme', title: 'Process Engineer', jobId: '10' }] });
  t.eq(exactSet.map(j => j.id), ['greenhouse:11'], 'exact applied id excludes only that requisition, not same-title sibling');
  t.eq(buildApplySet(exactCorpus, { threshold: 70, appliedRecords: [{ company: 'Acme', title: 'Process Engineer' }] }).length, 0,
    'legacy id-less applied record retains conservative role-key fallback');
  t.eq(buildApplySet(exactCorpus, { threshold: 70, blockedRecords: [{
    company: 'Acme', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/acme/jobs/10',
    reason: 'captcha'
  }] }).map(j => j.id), ['greenhouse:11'], 'blockedRecords suppress only the known manual-blocked requisition');
  t.eq(buildApplySet(exactCorpus, { threshold: 70, blockedHosts: ['boards.greenhouse.io'] }).length, 0,
    'blockedHosts suppress every posting on a known blocked tenant/host');
  const priorRetryableAttempt = { company: 'Acme', title: 'Process Quality Engineer', jobId: '10',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/10', status: 'failed', reason: 'missing_required' };
  t.eq(buildApplySet(exactCorpus, { threshold: 70 }).map(j => j.id), ['greenhouse:10', 'greenhouse:11'],
    'generic selection retains ordinary retryable failures when no first-attempt-only records are supplied');
  t.eq(buildApplySet(exactCorpus, { threshold: 70,
    attemptedRecords: [priorRetryableAttempt], unattemptedOnly: false }).map(j => j.id),
    ['greenhouse:10', 'greenhouse:11'],
    'attempted records do not change generic selection unless the explicit first-attempt-only gate is enabled');
  const unattemptedPlan = buildApplyPlan(exactCorpus, { threshold: 70,
    attemptedRecords: [priorRetryableAttempt], unattemptedOnly: true, retryBlocked: true });
  t.eq({ selected: unattemptedPlan.jobs.map(j => j.id), priorAttempted: unattemptedPlan.dropCounts.prior_attempted_record },
    { selected: ['greenhouse:11'], priorAttempted: 1 },
    'first-attempt-only selection uses stable identity across title drift without poisoning a sibling requisition or obeying retryBlocked');
  const aliasCorpus = corpus([{ id: 'workday:R77', company: 'Alias Co', title: 'Process Engineer',
    applyUrl: 'https://alias.wd5.myworkdayjobs.com/jobs/Process-Engineer_R77', fit: 83 }]);
  aliasCorpus.index['workday:R77'].sourceRefs = [{ id: 'linkedin:4447770000',
    listingUrl: 'https://www.linkedin.com/jobs/view/4447770000/' }];
  t.eq(buildApplyPlan(aliasCorpus, { threshold: 70, unattemptedOnly: true,
    attemptedRecords: [{ id: 'linkedin:4447770000', company: 'Alias Co', title: 'Process Quality Engineer',
      applyUrl: 'https://www.linkedin.com/jobs/view/4447770000/', status: 'failed' }] }).dropCounts.prior_attempted_record,
    1, 'first-attempt-only selection recognizes an attempted LinkedIn source alias after direct ATS resolution');
  const workdayLocaleAlias = corpus([{ id: 'linkedin:4419995122', company: 'Bloom Energy',
    title: 'Senior Process Engineer',
    applyUrl: 'https://bloomenergy.wd1.myworkdayjobs.com/BloomEnergyCareers/job/Fremont-California/Senior-Process-Engineer_JR-22717',
    fit: 86, ats: 'linkedin', channel: 'external' }]);
  workdayLocaleAlias.index['linkedin:4419995122'].sourcePlatform = 'linkedin';
  const localeAliasPlan = buildApplyPlan(workdayLocaleAlias, { threshold: 70,
    unattemptedOnly: true, blockedRecords: [{ id: 'workday:JR-22717', company: 'Bloom Energy',
      title: 'Senior Process Engineer', status: 'submitted', reason: 'submit_observation_timeout',
      applyUrl: 'https://bloomenergy.wd1.myworkdayjobs.com/en-US/BloomEnergyCareers/job/Fremont-California/Senior-Process-Engineer_JR-22717' }],
    attemptedRecords: [{ id: 'workday:JR-22717', company: 'Bloom Energy',
      title: 'Senior Process Engineer', status: 'submitted', reason: 'submit_observation_timeout',
      applyUrl: 'https://bloomenergy.wd1.myworkdayjobs.com/en-US/BloomEnergyCareers/job/Fremont-California/Senior-Process-Engineer_JR-22717' }] });
  t.eq({ selected: localeAliasPlan.jobs.length,
    blocked: localeAliasPlan.dropCounts.prior_blocked_record },
  { selected: 0, blocked: 1 },
  'first-attempt-only selection blocks a LinkedIn-origin Workday alias after locale normalization');
  const attemptedStateCorpus = corpus([
    { id: 'greenhouse:state-1', company: 'State Co', title: 'Process Engineer',
      applyUrl: 'https://boards.greenhouse.io/state/jobs/1', fit: 82, status: 'sourced', attempts: 1 },
    { id: 'greenhouse:state-2', company: 'State Co', title: 'Process Engineer',
      applyUrl: 'https://boards.greenhouse.io/state/jobs/2', fit: 81, status: 'sourced', attempts: 0 },
  ]);
  t.eq(buildApplySet(attemptedStateCorpus, { threshold: 70 }).map(j => j.id),
    ['greenhouse:state-1', 'greenhouse:state-2'],
    'generic selection preserves sourced retry attempts when first-attempt-only is not requested');
  const attemptedStatePlan = buildApplyPlan(attemptedStateCorpus,
    { threshold: 70, unattemptedOnly: true });
  t.eq({ selected: attemptedStatePlan.jobs.map(j => j.id), priorState: attemptedStatePlan.dropCounts.prior_attempted_state },
    { selected: ['greenhouse:state-2'], priorState: 1 },
    'first-attempt-only selection drops sourced attempts without excluding an unattempted sibling requisition');
  const collisionCorpus = corpus([
    { id: 'workday:alpha:R1234', company: 'Alpha Fab', title: 'Process Engineer',
      applyUrl: 'https://alpha.wd5.myworkdayjobs.com/en-US/Careers/job/Process-Engineer_R1234', fit: 90 },
    { id: 'workday:beta:R1234', company: 'Beta Fab', title: 'Process Engineer',
      applyUrl: 'https://beta.wd5.myworkdayjobs.com/en-US/Careers/job/Process-Engineer_R1234', fit: 89 },
  ]);
  collisionCorpus.index['workday:alpha:R1234'].sourceJobId = 'R1234';
  collisionCorpus.index['workday:beta:R1234'].sourceJobId = 'R1234';
  t.eq(buildApplySet(collisionCorpus, { threshold: 70, appliedRecords: [
    { company: 'Alpha Fab', title: 'Process Engineer', jobId: 'R1234' },
  ] }).map(j => j.id), ['workday:beta:R1234'],
  'tenant-local applied job IDs do not suppress a different employer');

  // maxAttempts: a deferred job at the cap is not retried
  const c2 = corpus([{ id: 'x:1', company: 'A', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/a/jobs/1', fit: 80, status: 'needs_manual', attempts: 3 }]);
  t.eq(buildApplySet(c2, { threshold: 70, maxAttempts: 3 }).length, 0, 'deferred at maxAttempts not retried');
  t.eq(buildApplySet(c2, { threshold: 70, retryDeferred: false }).length, 0, 'retryDeferred=false skips deferred');

  // daily cap
  t.eq(buildApplySet(c, { threshold: 70, dailyCap: 1 }).length, 1, 'daily cap limits set size');

  const unscoredCorpus = corpus([
    { id: 'indeed:u1', company: 'Pioneer', title: 'PCB Process Engineer', applyUrl: 'https://www.indeed.com/viewjob?jk=u1', fit: null, channel: 'indeed_apply' },
  ]);
  unscoredCorpus.index['indeed:u1'].description = 'Long process engineering job description with manufacturing, SPC, validation, yield, and equipment requirements.';
  unscoredCorpus.index['indeed:u1'].descriptionStatus = 'full';
  unscoredCorpus.state['indeed:u1'].status = 'score_pending';
  t.eq(buildApplySet(unscoredCorpus, { threshold: 0, includeUnscored: false }).length, 0,
    'unscored hydrated jobs are excluded outside rescore planning');
  const unscoredSet = buildApplySet(unscoredCorpus, { threshold: 0, includeUnscored: true });
  t.eq(unscoredSet.length, 1, 'rescore planning can include hydrated unscored jobs');
  t.eq(unscoredSet[0].fitScore, null, 'unscored jobs stay fitScore=null until LLM rescore');
  const linkedInEaCorpus = corpus([
    { id: 'linkedin:ea1', company: 'Mainspring', title: 'Test Engineer', applyUrl: 'https://www.linkedin.com/jobs/view/4387724983/', fit: 75, channel: 'linkedin_easy_apply', ats: 'linkedin' },
  ]);
  linkedInEaCorpus.state['linkedin:ea1'].matchEvidence = ['test engineering', 'manufacturing', 'quality'];
  linkedInEaCorpus.state['linkedin:ea1'].confidence = 'high';
  linkedInEaCorpus.state['linkedin:ea1'].scoringPolicyVersion = Evidence.SCORING_POLICY_VERSION;
  linkedInEaCorpus.state['linkedin:ea1'].materialGaps = [];
  const linkedInEaPlan = buildApplyPlan(linkedInEaCorpus, { threshold: 70, requireEvidence: true });
  t.eq(linkedInEaPlan.jobs.length, 1, 'LinkedIn Easy Apply is eligible when channel marks it native-supported');
  t.eq(linkedInEaPlan.jobs[0].strategy, 'linkedin_ea', 'LinkedIn Easy Apply is stamped with linkedin_ea strategy');
  t.eq(linkedInEaPlan.dropCounts.unknown_apply_strategy || 0, 0, 'LinkedIn Easy Apply is not dropped as unknown strategy');
  const unresolvedBrowserCorpus = corpus([
    { id: 'indeed:offsite1', company: 'Pending ATS', title: 'Process Engineer',
      applyUrl: 'https://www.indeed.com/viewjob?jk=offsite1', fit: 85, channel: 'external', ats: 'indeed' },
  ]);
  unresolvedBrowserCorpus.index['indeed:offsite1'].needsAtsResolution = true;
  const unresolvedPlan = buildApplyPlan(unresolvedBrowserCorpus, { threshold: 70 });
  t.eq(unresolvedPlan.jobs.length, 0,
    'unresolved LinkedIn/Indeed offsite leads cannot enter an application queue');
  t.eq(unresolvedPlan.dropCounts.aggregator_without_apply_destination, 1,
    'unresolved browser lead reports the explicit missing ATS destination gate');

  // per-company cap → batch spans multiple employers (no stacking one company)
  const conc = corpus([
    { id: 'g:1', company: 'PsiQ', title: 'Process Engineer A', applyUrl: 'https://boards.greenhouse.io/psiq/jobs/1', fit: 80 },
    { id: 'g:2', company: 'PsiQ', title: 'Process Engineer B', applyUrl: 'https://boards.greenhouse.io/psiq/jobs/2', fit: 79 },
    { id: 'g:3', company: 'PsiQ', title: 'Process Engineer C', applyUrl: 'https://boards.greenhouse.io/psiq/jobs/3', fit: 78 },
    { id: 'g:4', company: 'PsiQ', title: 'Process Engineer D', applyUrl: 'https://boards.greenhouse.io/psiq/jobs/4', fit: 77 },
    { id: 'g:5', company: 'Beta', title: 'Quality Engineer', applyUrl: 'https://boards.greenhouse.io/beta/jobs/5', fit: 76 },
    { id: 'g:6', company: 'Gamma', title: 'Metrology Engineer', applyUrl: 'https://boards.greenhouse.io/gamma/jobs/6', fit: 75 },
  ]);
  const capped = buildApplySet(conc, { threshold: 70, dailyCap: 4, perCompanyCap: 2 });
  const psiqCount = capped.filter(j => j.company === 'PsiQ').length;
  t.eq(psiqCount, 2, 'per-company cap: at most 2 from PsiQ');
  t.ok(new Set(capped.map(j => j.company)).size >= 3, 'per-company cap: batch spans multiple companies');
  t.eq(buildApplySet(conc, { threshold: 70, dailyCap: 10, perCompanyCap: 0 }).filter(j => j.company === 'PsiQ').length, 4, 'perCompanyCap=0 disables the cap');

  // Evidence gate: a score alone is insufficient for high-confidence auto-apply.
  const evidenceCorpus = corpus([
    { id: 'e:1', company: 'Strong', title: 'Metrology Engineer', applyUrl: 'https://jobs.lever.co/strong/1', fit: 90 },
    { id: 'e:2', company: 'Conflict', title: 'Quality Engineer', applyUrl: 'https://jobs.lever.co/conflict/2', fit: 90 },
  ]);
  evidenceCorpus.state['e:1'] = { ...evidenceCorpus.state['e:1'],
    scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
    matchEvidence: ['wafer inspection', 'thin film metrology', 'SPC'], gaps: [], materialGaps: [],
    trainableGaps: [], preferredGaps: [], conflicts: [], confidence: 'high' };
  evidenceCorpus.state['e:2'] = { ...evidenceCorpus.state['e:2'],
    scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
    matchEvidence: ['GMP', 'quality control', 'RCA'], gaps: [], materialGaps: [],
    conflicts: ['US citizenship required'], confidence: 'high' };
  const evidenceSet = buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true });
  t.eq(evidenceSet.map(j => j.id), ['e:1'], 'evidence gate requires 3 matches and rejects hard conflicts');
  t.eq(evidenceSet[0].matchEvidence.length, 3, 'selection carries audit evidence into queue');
  t.eq(hasUsableDescription(evidenceCorpus.index['e:1']), true, 'full posting JD is usable evidence');

  // A compact planning corpus carries JD readiness/fingerprint but never description text. Its
  // selected IDs and planning-drop diagnostics must be identical to the full corpus representation.
  evidenceCorpus.index['e:1'].descriptionFingerprint = 'fp-strong';
  evidenceCorpus.index['e:2'].descriptionFingerprint = 'fp-conflict';
  const projectedEvidenceCorpus = {
    index: Object.fromEntries(Object.entries(evidenceCorpus.index).map(([id, p]) => [id, {
      ...p, description: undefined, descriptionReady: true,
    }])),
    state: evidenceCorpus.state,
  };
  const fullEvidencePlan = buildApplyPlan(evidenceCorpus, { threshold: 75, requireEvidence: true });
  const projectedEvidencePlan = buildApplyPlan(projectedEvidenceCorpus, { threshold: 75, requireEvidence: true });
  t.eq(projectedEvidencePlan.jobs.map(j => j.id), fullEvidencePlan.jobs.map(j => j.id),
    'compact planning corpus preserves evidence-gated selected IDs');
  t.eq(projectedEvidencePlan.dropCounts, fullEvidencePlan.dropCounts,
    'compact planning corpus preserves every planning-drop count');
  t.eq(projectedEvidencePlan.jobs[0].description, '', 'compact selected job does not materialize JD text');
  t.eq(projectedEvidencePlan.jobs[0].descriptionReady, true, 'compact selected job carries JD readiness');
  t.eq(projectedEvidencePlan.jobs[0].postingDescriptionFingerprint, 'fp-strong',
    'compact selected job carries posting JD fingerprint separately from score fingerprint');
  projectedEvidenceCorpus.index['e:1'].descriptionReady = false;
  const unavailablePlan = buildApplyPlan(projectedEvidenceCorpus, { threshold: 75, requireEvidence: true });
  t.eq(unavailablePlan.dropCounts.missing_description_evidence, 1,
    'compact readiness=false produces the existing missing-description diagnostic');
  t.eq(hasUsableDescription(projectedEvidenceCorpus.index['e:1']), false,
    'compact readiness=false is not usable evidence');

  evidenceCorpus.state['e:1'].gaps = ['Python', 'CAD', 'optical metrology'];
  evidenceCorpus.state['e:1'].materialGaps = ['Python', 'CAD', 'optical metrology'];
  t.eq(buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true }).length, 0, 'evidence gate rejects more than two material gaps');
  evidenceCorpus.state['e:1'].gaps = [];
  evidenceCorpus.state['e:1'].materialGaps = [];
  evidenceCorpus.state['e:1'].gaps = ['deposition platform', 'vacuum system', 'Six Sigma certification'];
  evidenceCorpus.state['e:1'].trainableGaps = ['deposition platform', 'vacuum system'];
  evidenceCorpus.state['e:1'].preferredGaps = ['Six Sigma certification'];
  t.eq(buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true }).map(j => j.id), ['e:1'],
    'evidence gate keeps adjacent roles when only trainable and preferred gaps exceed the old flat limit');
  evidenceCorpus.state['e:1'].scoringPolicyVersion = '';
  t.eq(buildApplyPlan(evidenceCorpus, { threshold: 75, requireEvidence: true }).dropCounts.scoring_policy_mismatch, 1,
    'evidence gate fails closed on a legacy flat-gap score until it is rescored');
  evidenceCorpus.state['e:1'].scoringPolicyVersion = Evidence.SCORING_POLICY_VERSION;
  evidenceCorpus.state['e:1'].gaps = [];
  evidenceCorpus.state['e:1'].trainableGaps = [];
  evidenceCorpus.state['e:1'].preferredGaps = [];
  evidenceCorpus.state['e:1'].candidateFingerprint = 'resume-v1';
  t.eq(buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true,
    candidateFingerprint: 'resume-v2' }).length, 0,
  'evidence gate rejects scores produced from a different resume fingerprint');

  // atsAllow: hard restrict to no-account ATSes (supervised-trial safety guarantee)
  const allow = buildApplySet(c, { threshold: 70, atsAllow: ['greenhouse'] });
  t.eq(allow.every(j => j.strategy === 'greenhouse'), true, 'atsAllow=[greenhouse] keeps only greenhouse');
  t.ok(allow.length >= 1, 'atsAllow still returns greenhouse jobs');
  t.eq(buildApplySet(c, { threshold: 70, atsAllow: ['workday'] }).some(j => j.strategy !== 'workday'), false, 'atsAllow=[workday] excludes all non-workday');

  // Known non-application routes observed in live E2E are filtered before autonomous launch.
  t.eq(unsupportedAutonomousApplyReason('https://ro.careers.tsmc.com/talentcommunity/apply/1213393266/?locale=en_US', 'successfactors'),
    'unsupported_successfactors_talentcommunity', 'unsupported: SuccessFactors Talent Community lead-capture route');
  t.eq(unsupportedAutonomousApplyReason('https://jobicy.com/jobs/146657-associate-application-engineer', 'jobicy'),
    'unsupported_jobicy_no_inline_form', 'unsupported: Jobicy hash-popup/no-inline-form route');
  t.eq(unsupportedAutonomousApplyReason('https://careers.gf.com/careers/apply?pid=563980769981826', 'eightfold'),
    'unsupported_eightfold_portal_auth', 'unsupported: Eightfold/GF auth portal route');
  t.eq(applyCapabilityStatus('https://careers.gf.com/careers/apply?pid=563980769981826', 'eightfold').status,
    'unsupported', 'capability registry marks Eightfold as unsupported before apply');
  t.eq(applyCapabilityStatus('https://careers.example.com/jobs/123', 'generic').status,
    'unknown_needs_resolution',
  'capability registry never admits an unattested corporate generic form into an autonomous queue');
  t.eq(isPostingSpecificSupportedRoute('https://boards.greenhouse.io/acme', 'greenhouse'), false,
    'capability registry: an ATS board home is not a posting-specific apply destination');
  t.eq(isVoyagerPostingSpecificRoute('https://boards.greenhouse.io/acme/jobs/search', 'greenhouse'), false,
    'Voyager route gate: a Greenhouse search path is not a posting');
  t.eq(isVoyagerPostingSpecificRoute('https://jobs.lever.co/acme/team', 'lever'), false,
    'Voyager route gate: a Lever team path is not a posting');
  t.eq(isVoyagerPostingSpecificRoute('https://jobs.ashbyhq.com/acme/about', 'ashby'), false,
    'Voyager route gate: an Ashby about path is not a posting');
  t.eq(isVoyagerPostingSpecificRoute('https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/foo', 'workday'), false,
    'Voyager route gate: a Workday job-shaped path without a requisition token stays lookup-only');
  t.eq(isVoyagerPostingSpecificRoute('https://jobs.ashbyhq.com/acme/' +
    'd4fdb4b0-9fc4-4a1e-bfea-e7c2ff9b587a/application', 'ashby'), true,
  'Voyager route gate: a strong Ashby posting identity remains supported');
  t.eq(isPostingSpecificSupportedRoute('https://greenhouse.io.attacker.example/acme/jobs/123', 'greenhouse'), false,
    'capability registry: a suffix-spoofed ATS hostname fails closed');
  t.eq(safeUnresolvedLandingUrl('https://careers.jnj.com/en/jobs/r-086504'),
    'https://careers.jnj.com/en/jobs/r-086504',
  'route resolution: a public non-aggregator landing may be retained only as lookup evidence');
  t.eq(safeUnresolvedLandingUrl('http://127.0.0.1/private'), '',
    'route resolution: private landing URLs are never retained for follow-up inspection');
  t.eq(applyCapabilityStatus('https://boards.greenhouse.io/acme', 'greenhouse'),
    { status: 'unknown_needs_resolution', reason: 'apply_destination_not_posting_specific' },
  'capability registry: a recognized ATS hostname still requires a posting-specific path');
  t.eq(applyCapabilityStatus('https://careers.example.com/jobs/R1', 'workable'),
    { status: 'unknown_needs_resolution', reason: 'apply_destination_not_posting_specific' },
  'capability registry: metadata cannot attest a supported secondary ATS on an unrelated host');
  t.eq(applyCapabilityStatus('https://apply.workable.com/acme/j/ABC123/', 'workable').status, 'supported',
    'capability registry: a posting-specific secondary ATS URL remains supported');
  const unsupportedCorpus = corpus([
    { id: 'sf:bad', company: 'TSMC', title: 'Engineer', applyUrl: 'https://ro.careers.tsmc.com/talentcommunity/apply/1213393266/?locale=en_US', fit: 90, ats: 'successfactors' },
    { id: 'jobicy:bad', company: 'Spirax', title: 'Engineer', applyUrl: 'https://jobicy.com/jobs/146657-associate-application-engineer', fit: 90, ats: 'jobicy' },
    { id: 'gf:bad', company: 'GlobalFoundries', title: 'Engineer', applyUrl: 'https://careers.gf.com/careers/apply?pid=563980769981826', fit: 90, ats: 'eightfold' },
    { id: 'lever:ok', company: 'Cellares', title: 'Engineer', applyUrl: 'https://jobs.lever.co/cellares/abc/apply', fit: 90, ats: 'lever' },
  ]);
  t.eq(buildApplySet(unsupportedCorpus, { threshold: 70, dailyCap: 10, perCompanyCap: 0 }).map(j => j.id), ['lever:ok'],
    'buildApplySet excludes unsupported autonomous apply routes but keeps valid ATS jobs');

  // --- resultToState ---
  t.eq(resultToState('applied', 0).status, 'applied', 'applied → applied');
  t.eq(resultToState('already_applied', 0).status, 'applied', 'already_applied → applied');
  t.eq(resultToState('posting_not_found', 0).status, 'dead', 'posting_not_found → dead');
  t.eq(resultToState('needs_login', 0).status, 'needs_login', 'needs_login → needs_login');
  t.eq(resultToState('workday_captcha', 0).status, 'needs_manual', 'captcha → needs_manual (never solved)');
  t.eq(resultToState('stuck_budget', 0).status, 'needs_manual', 'stuck_budget → needs_manual (unbounded stall deferred)');
  t.eq(resultToState('no_submit_btn', 0).status, 'needs_manual', 'no submit button → immediate manual deferral');
  t.eq(resultToState('no_apply_btn_on_description', 0).status, 'needs_manual', 'no apply path → immediate manual deferral');
  t.eq(resultToState('no_apply_path', 0).status, 'needs_manual', 'invalid/stale apply path → immediate manual deferral');
  t.eq(resultToState('no_easy_apply', 0).status, 'needs_manual',
    'LinkedIn modal-open exhaustion → immediate manual deferral instead of automatic retry');
  t.eq(resultToState('wd_selectinput_blocked', 0).status, 'needs_manual', 'Workday selectinput blocker → manual deferral');
  t.eq(resultToState('workday_auth_sign_in_error', 0).status, 'needs_manual', 'Workday auth error → manual deferral');
  t.eq(resultToState('workday_create_rejected_no_visible_error', 0).status, 'needs_manual', 'Workday create rejected/no visible error → manual deferral');
  t.eq(resultToState('workday_account_exists_wrong_password', 0).status, 'needs_manual', 'Workday account exists/wrong password → manual deferral');
  t.eq(resultToState('workday_duplicate_record', 0).status, 'needs_manual', 'Workday duplicate draft record → manual deferral');
  t.eq(resultToState('ownership_lost_ext_current_advanced', 0).status, 'needs_manual',
    'ranked ownership loss is manual/non-retryable instead of an inferred failure');
  t.eq(resultToState('no_active_tab_pre_submit', 0).status, 'needs_manual',
    'exhausted missing-tab recovery is visible and never automatically retried');
  t.eq(resultToState('tab_lost_outcome_unknown', 0).status, 'needs_manual',
    'ambiguous missing-tab acceptance is never automatically retried');
  t.eq(resultToState('email_code_submit_unconfirmed', 0).status, 'needs_manual',
    'possibly-final email-code action without confirmation is never automatically retried');
  t.eq(resultToState('missing_required', 0).status, 'sourced', 'transient first fail → stays sourced (retry)');
  t.eq(resultToState('missing_required', 0).retry, true, 'transient marks retry');
  t.eq(resultToState('missing_required', 0, 1).status, 'needs_manual', 'E2E-safe maxAttempts=1 defers transient first fail');
  t.eq(resultToState('missing_required', 2, 3).status, 'needs_manual', 'transient at maxAttempts → needs_manual');
  t.eq(resultToState('submit_unclear', 1, 3).status, 'needs_manual',
    'ambiguous submit is never retried because an application may already exist');
  t.eq(resultToState('submit_observation_timeout', 0, 3).status, 'needs_manual',
    'post-submit watchdog uncertainty is terminal/manual');
  t.eq(resultToState('workday_transport_failure', 0, 3).status, 'needs_manual',
    'explicit Workday submit transport failure is terminal/manual');

  // --- exceededBudget (cross-reload stall guard) ---
  t.eq(exceededBudget(null, 1000), false, 'no entry → not exceeded');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 1 }, 1000 + 60000), false, 'within budget (1 min, 1 load)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 1 }, 1000 + 300000), true, 'over wall-clock budget (5 min > 4)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 5 }, 1000 + 1000), true, 'over load budget (5 loads > 4)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 2 }, 1000 + 10000, { budgetMs: 5000 }), true, 'custom budgetMs honored');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 10 }, 1000 + 1000, { maxLoads: 20 }), false, 'custom maxLoads honored');
  const srBudget = externalJobBudgetOptions('jobs.smartrecruiters.com');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 5 }, 1000 + 60000, srBudget), false,
    'SmartRecruiters: five fast landing handoffs do not exhaust the application budget');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 9 }, 1000 + 60000, srBudget), true,
    'SmartRecruiters: the expanded landing budget remains bounded');
  t.eq(externalJobBudgetOptions('tenant.wd1.myworkdayjobs.com').maxLoads, 12,
    'Workday retains its longer auth/form reload budget');

  // --- watchdogDecision (SW-side force-advance) ---
  const Q = { status: 'applying', currentIndex: 2, runId: 'r1', jobs: [1, 2, 3, 4] };
  t.eq(watchdogDecision({ status: 'done' }, {}, 1000).action, 'idle', 'wd: not applying → idle');
  t.eq(watchdogDecision(Q, {}, 1000).action, 'reset', 'wd: no tracker → reset');
  t.eq(watchdogDecision(Q, { runId: 'r1', idx: 1, startedAt: 1000 }, 2000).action, 'reset', 'wd: idx changed → reset');
  t.eq(watchdogDecision(Q, { runId: 'r0', idx: 2, startedAt: 1000 }, 2000).action, 'reset', 'wd: runId changed → reset');
  t.eq(watchdogDecision(Q, { runId: 'r1', idx: 2, startedAt: 1000 }, 1000 + 60000).action, 'wait', 'wd: within cap → wait');
  t.eq(watchdogDecision(Q, { runId: 'r1', idx: 2, startedAt: 1000 }, 1000 + 179000).action, 'wait', 'wd: just inside 3-min cap → wait');
  t.eq(watchdogDecision(Q, { runId: 'r1', idx: 2, startedAt: 1000 }, 1000 + 181000).action, 'advance', 'wd: past 3-min cap → advance');
  t.eq(watchdogDecision(Q, { runId: 'r1', idx: 2, startedAt: 1000 }, 1000 + 20000, { capMs: 10000 }).action, 'advance', 'wd: custom cap honored');
  const rankedA = { status: 'applying', currentIndex: 0, runId: 'same-run',
    jobs: [{ company: 'A', title: 'Engineer', jobId: '123', applyUrl: 'https://a.example/apply/123' }] };
  const rankedB = { ...rankedA,
    jobs: [{ company: 'B', title: 'Engineer', jobId: '123', applyUrl: 'https://b.example/apply/123' }] };
  const firstTracker = watchdogDecision(rankedA, {}, 1000).wd;
  t.eq(watchdogDecision(rankedB, firstTracker, 1000 + 181000).action, 'reset',
    'wd: one-job reserve with same run/index resets by canonical job identity');
  t.ok(queueJobKey(rankedA.jobs[0]) !== queueJobKey(rankedB.jobs[0]),
    'wd: tenant-local raw IDs do not collide when routes differ');

  const missingFirst = missingTabRecoveryDecision(rankedA, rankedA.jobs[0]);
  t.eq(missingFirst.action, 'relaunch', 'ranked missing tab: first loss gets one bounded relaunch');
  const missingSecond = missingTabRecoveryDecision({ ...rankedA, missingTabRecovery: missingFirst.tracker }, rankedA.jobs[0]);
  t.eq(missingSecond.action, 'fail', 'ranked missing tab: a second loss terminalizes instead of resetting forever');
  t.eq(missingTabRecoveryDecision({ ...rankedA, currentIndex: 1, missingTabRecovery: missingFirst.tracker },
    { id: 'other', company: 'A', title: 'Other', applyUrl: 'https://a.example/apply/other' }).action, 'relaunch',
  'ranked missing tab: recovery count is scoped to exact queue identity');
  t.eq(classifyMissingTabOutcome({ channel: 'linkedin_easy_apply' },
    { currentMatches: true, submitPending: false }).kind, 'submitted_unverified',
  'ranked missing tab: LinkedIn without a durable phase marker is ambiguous and never relaunched');
  t.eq(classifyMissingTabOutcome({ channel: 'external', ats: 'greenhouse' },
    { currentMatches: true, submitPending: false, phase: 'pre_submit' }).kind, 'pre_submit',
  'ranked missing tab: exact external current with a durable pre-submit phase can use bounded recovery');
  t.eq(classifyMissingTabOutcome({ channel: 'external', ats: 'greenhouse' },
    { currentMatches: true, submitPending: false }).reason, 'tab_lost_outcome_unknown',
  'ranked missing tab: exact external ownership without phase evidence remains ambiguous');
  t.eq(classifyMissingTabOutcome({ channel: 'external', ats: 'greenhouse' },
    { currentMatches: true, submitPending: false, phase: 'pre_submit', handled: true }).reason,
  'tab_lost_outcome_unknown',
  'ranked missing tab: handled-result window is never relaunched even if an old pre-submit marker remains');
  t.eq(classifyMissingTabOutcome({ channel: 'external', ats: 'workday' },
    { currentMatches: false, submitPending: false }).reason, 'tab_lost_outcome_unknown',
  'ranked missing tab: lost exact external ownership is preserved as ambiguous');
  t.eq(classifyMissingTabOutcome({ channel: 'external', ats: 'workday' },
    { currentMatches: true, submitPending: true }).reason, 'submit_observation_timeout',
  'ranked missing tab: durable submit evidence remains submitted/unverified');

  const lifecycleJob = { id: 'workday:R1', runId: 'run-1', rankedRun: true,
    applyUrl: 'https://acme.wd1.myworkdayjobs.com/job/R1' };
  const lifecycleStorage = {
    pja_ext_queue: { runId: 'run-1', status: 'applying', currentIndex: 0, jobs: [{ ...lifecycleJob }] },
    pja_ext_current: { ...lifecycleJob },
    pja_ranked_apply: { runId: 'run-1', status: 'applying', currentIndex: 0, jobs: [{ ...lifecycleJob }] },
  };
  t.eq(applyLifecycleOwnership(lifecycleJob, lifecycleStorage).owns, true,
    'apply lifecycle: exact queue/current/ranked run and job own the coroutine');
  const submitLifecycle = applyLifecycleOwnership(lifecycleJob, {
    ...lifecycleStorage,
    pja_ext_current: { ...lifecycleJob, _applyPhase: 'submit_pending',
      _submitPending: true, _submitStartedAt: 7001 },
  });
  t.eq({ phase: submitLifecycle.phase, pending: submitLifecycle.submitPending,
    startedAt: submitLifecycle.submitStartedAt },
  { phase: 'submit_pending', pending: true, startedAt: 7001 },
  'apply lifecycle: durable submit marker fields are returned for exact post-write verification');
  const laterRunStorage = {
    pja_ext_queue: { ...lifecycleStorage.pja_ext_queue, runId: 'run-2', jobs: [{ ...lifecycleJob, runId: 'run-2' }] },
    pja_ext_current: { ...lifecycleJob, runId: 'run-2' },
    pja_ranked_apply: { ...lifecycleStorage.pja_ranked_apply, runId: 'run-2', jobs: [{ ...lifecycleJob, runId: 'run-2' }] },
  };
  t.eq(applyLifecycleOwnership(lifecycleJob, laterRunStorage).owns, false,
    'apply lifecycle: same posting in a later run cannot revive an older coroutine');
  t.eq(applyLifecycleOwnership(lifecycleJob, {
    ...lifecycleStorage,
    pja_ranked_apply: { ...lifecycleStorage.pja_ranked_apply,
      currentIndex: 0, jobs: [{ id: 'workday:R2', runId: 'run-1' }] },
  }).owns, false,
  'apply lifecycle: ranked master advancing to another job stops the stale handler');

  const gmailOwner = { sessionId: 'wd-session-1', runId: 'run-1', jobId: 'workday:R1',
    applyUrl: lifecycleJob.applyUrl, applyTabId: 77 };
  const gmailStorage = {
    ...lifecycleStorage,
    pja_ranked_apply: { ...lifecycleStorage.pja_ranked_apply, inFlightTabId: 77 },
    pja_wd_gmail_session: { ...gmailOwner },
  };
  t.eq(workdayGmailOwnership(gmailOwner, gmailStorage), true,
    'Workday Gmail: exact run/job/URL/dispatcher tab owns the cross-tab verification flow');
  t.eq(workdayGmailOwnership({ ...gmailOwner, runId: 'run-2' }, gmailStorage), false,
    'Workday Gmail: stale run cannot resume a newer application');
  t.eq(workdayGmailOwnership({ ...gmailOwner, applyTabId: 78 }, gmailStorage), false,
    'Workday Gmail: stale apply tab cannot create a duplicate handler for the same job');
  t.eq(workdayGmailOwnership({ ...gmailOwner, applyTabId: undefined }, gmailStorage), false,
    'Workday Gmail: ranked resume requires an explicit dispatcher tab, not only job identity');
  t.eq(workdayGmailOwnership({ ...gmailOwner,
    applyUrl: 'https://other.wd1.myworkdayjobs.com/job/R1' }, gmailStorage), false,
  'Workday Gmail: same raw requisition on a different route is not the same owner');
  const gmailAfterSessionRemoval = { ...gmailStorage };
  delete gmailAfterSessionRemoval.pja_wd_gmail_session;
  t.eq(workdayGmailOwnership(gmailOwner, gmailAfterSessionRemoval), true,
    'Workday Gmail: durable pending/result ownership remains valid after the completed Gmail session is removed');

  const emailOwner = { sessionId: 'email-session-1', runId: 'run-1', jobId: 'workday:R1',
    applyUrl: lifecycleJob.applyUrl, applyTabId: 77 };
  const emailStorage = { ...gmailStorage, pja_email_code_session: { ...emailOwner } };
  t.eq(emailCodeOwnership(emailOwner, emailStorage), true,
    'email code: exact run/job/route/tab/session owns the Gmail result');
  t.eq(emailCodeOwnership({ ...emailOwner, sessionId: 'email-session-2' }, emailStorage), false,
    'email code: a replaced session cannot consume the prior session result');
  t.eq(emailCodeOwnership({ ...emailOwner, applyTabId: 78 }, emailStorage), false,
    'email code: a duplicate ranked apply tab cannot own the code flow');
  t.eq(emailCodeSubmitRisk({ verificationOnly: true, initialActionAttempted: true }), false,
    'email code accounting: a delivered verification-only action is still pre-submit');
  t.eq(emailCodeSubmitRisk({ verificationOnly: false, initialActionAttempted: true }), true,
    'email code accounting: a delivered possibly-final action is submitted/unverified without confirmation');
  t.eq(emailCodeSubmitRisk({ verificationOnly: true, initialActionAttempted: true,
    finalSubmitAttempted: true }), true,
  'email code accounting: final Submit after verification creates submission ambiguity');
  t.eq(emailCodeSubmitRisk({ priorSubmit: true }), true,
    'email code accounting: a post-submit verification failure preserves the earlier ambiguous submit');
  t.eq(emailCodeSubmitRisk({ priorSubmit: true, explicitConfirmation: true }), false,
    'email code accounting: explicit confirmation is not categorized as unverified');
  for (const reason of ['submit_observation_timeout', 'workday_transport_failure',
    'success_unverified', 'tab_lost_outcome_unknown', 'email_code_submit_unconfirmed']) {
    t.eq(submittedUnverifiedReason(reason), true,
      `outcome accounting: ${reason} maps to submitted/unverified`);
  }

  const diagMaster = { runId: 'run-exact', currentIndex: 0, inFlightAt: 5000 };
  const diagJob = { id: 'workday:R1', jobId: 'R1', applyUrl: 'https://acme.wd1.myworkdayjobs.com/job/R1' };
  const exactFact = { runId: 'run-exact', jobId: 'workday:R1',
    url: 'https://acme.wd1.myworkdayjobs.com/apply', ts: 5001 };
  t.eq(diagnosticOwnsRankedJob(exactFact, diagMaster, diagJob), true,
    'ranked diagnostics: exact run/job/current-attempt fact is owned');
  t.eq(diagnosticOwnsRankedJob({ ...exactFact, runId: 'old-run' }, diagMaster, diagJob), false,
    'ranked diagnostics: another run is ignored');
  t.eq(diagnosticOwnsRankedJob({ ...exactFact, jobId: 'workday:R2' }, diagMaster, diagJob), false,
    'ranked diagnostics: another job is ignored');
  t.eq(diagnosticOwnsRankedJob({ ...exactFact, ts: 4999 }, diagMaster, diagJob), false,
    'ranked diagnostics: stale pre-attempt fact is ignored');
  t.eq(diagnosticOwnsRankedJob({ ...exactFact, url: 'https://other.wd1.myworkdayjobs.com/apply' }, diagMaster, diagJob), false,
    'ranked diagnostics: another Workday tenant is ignored');

  t.eq(greenhouseEmbedFallback('https://job-boards.greenhouse.io/peakenergy/jobs/4913996007', 'https://peakenergy.com/careers?gh_jid=4913996007'), 'https://boards.greenhouse.io/embed/job_app?for=peakenergy&token=4913996007', 'GH corporate redirect -> embedded application');
  t.eq(greenhouseEmbedFallback('https://job-boards.greenhouse.io/peakenergy/jobs/4913996007', 'https://peakenergy.com/careers?gh_jid=999'), '', 'GH fallback requires matching job id');

  // --- poolStatus ---
  const ps = poolStatus(c, { threshold: 70 });
  t.eq(ps.applied, 1, 'poolStatus counts applied (wd:4)');
  t.eq(ps.dead, 1, 'poolStatus counts dead (gh:6)');
  t.eq(ps.below_threshold, 1, 'poolStatus counts below-threshold (lever:3)');
  t.eq(ps.cleared, false, 'not cleared while fresh fit>=70 remain sourced');

  const clearedCorpus = corpus([
    { id: 'a:1', company: 'A', title: 'Process Engineer', applyUrl: 'u', fit: 80, status: 'applied' },
    { id: 'a:2', company: 'B', title: 'Quality Engineer', applyUrl: 'u', fit: 75, status: 'needs_manual', attempts: 3 },
  ]);
  t.eq(poolStatus(clearedCorpus, { threshold: 70 }).cleared, true, 'cleared when no fit>=70 job is still sourced');
};
