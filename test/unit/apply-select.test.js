'use strict';
// Phase B core: apply-set selection gating + result→state mapping + pool-cleared summary.
const path = require('path');
require(path.resolve(__dirname, '../../sourcing/detect-ats'));
const { buildApplySet, resultToState, poolStatus, roleKey, greenhouseEmbedFallback, exceededBudget,
  watchdogDecision, queueJobKey, unsupportedAutonomousApplyReason } = require(path.resolve(__dirname, '../../sourcing/apply-select'));

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
  const collisionCorpus = corpus([
    { id: 'workday:alpha:R1234', company: 'Alpha Fab', title: 'Process Engineer', applyUrl: 'https://alpha.example/jobs/R1234', fit: 90 },
    { id: 'workday:beta:R1234', company: 'Beta Fab', title: 'Process Engineer', applyUrl: 'https://beta.example/jobs/R1234', fit: 89 },
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
  evidenceCorpus.state['e:1'] = { ...evidenceCorpus.state['e:1'], matchEvidence: ['wafer inspection', 'thin film metrology', 'SPC'], gaps: [], conflicts: [], confidence: 'high' };
  evidenceCorpus.state['e:2'] = { ...evidenceCorpus.state['e:2'], matchEvidence: ['GMP', 'quality control', 'RCA'], gaps: [], conflicts: ['US citizenship required'], confidence: 'high' };
  const evidenceSet = buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true });
  t.eq(evidenceSet.map(j => j.id), ['e:1'], 'evidence gate requires 3 matches and rejects hard conflicts');
  t.eq(evidenceSet[0].matchEvidence.length, 3, 'selection carries audit evidence into queue');
  evidenceCorpus.state['e:1'].gaps = ['Python', 'CAD', 'optical metrology'];
  t.eq(buildApplySet(evidenceCorpus, { threshold: 75, requireEvidence: true }).length, 0, 'evidence gate rejects more than two material gaps');
  evidenceCorpus.state['e:1'].gaps = [];
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
  t.eq(resultToState('wd_selectinput_blocked', 0).status, 'needs_manual', 'Workday selectinput blocker → manual deferral');
  t.eq(resultToState('workday_auth_sign_in_error', 0).status, 'needs_manual', 'Workday auth error → manual deferral');
  t.eq(resultToState('workday_create_rejected_no_visible_error', 0).status, 'needs_manual', 'Workday create rejected/no visible error → manual deferral');
  t.eq(resultToState('workday_account_exists_wrong_password', 0).status, 'needs_manual', 'Workday account exists/wrong password → manual deferral');
  t.eq(resultToState('missing_required', 0).status, 'sourced', 'transient first fail → stays sourced (retry)');
  t.eq(resultToState('missing_required', 0).retry, true, 'transient marks retry');
  t.eq(resultToState('missing_required', 0, 1).status, 'needs_manual', 'E2E-safe maxAttempts=1 defers transient first fail');
  t.eq(resultToState('missing_required', 2, 3).status, 'needs_manual', 'transient at maxAttempts → needs_manual');
  t.eq(resultToState('submit_unclear', 1, 3).attempts, 2, 'attempts increments');

  // --- exceededBudget (cross-reload stall guard) ---
  t.eq(exceededBudget(null, 1000), false, 'no entry → not exceeded');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 1 }, 1000 + 60000), false, 'within budget (1 min, 1 load)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 1 }, 1000 + 300000), true, 'over wall-clock budget (5 min > 4)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 5 }, 1000 + 1000), true, 'over load budget (5 loads > 4)');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 2 }, 1000 + 10000, { budgetMs: 5000 }), true, 'custom budgetMs honored');
  t.eq(exceededBudget({ firstSeen: 1000, loads: 10 }, 1000 + 1000, { maxLoads: 20 }), false, 'custom maxLoads honored');

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
