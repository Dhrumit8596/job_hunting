'use strict';
// Phase B core: apply-set selection gating + result→state mapping + pool-cleared summary.
const path = require('path');
require(path.resolve(__dirname, '../../sourcing/detect-ats'));
const { buildApplySet, resultToState, poolStatus, roleKey } = require(path.resolve(__dirname, '../../sourcing/apply-select'));

function corpus(entries) {
  const index = {}, state = {};
  for (const e of entries) {
    index[e.id] = { id: e.id, company: e.company, title: e.title, applyUrl: e.applyUrl, ats: e.ats || '' };
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

  // maxAttempts: a deferred job at the cap is not retried
  const c2 = corpus([{ id: 'x:1', company: 'A', title: 'Process Engineer', applyUrl: 'https://boards.greenhouse.io/a/jobs/1', fit: 80, status: 'needs_manual', attempts: 3 }]);
  t.eq(buildApplySet(c2, { threshold: 70, maxAttempts: 3 }).length, 0, 'deferred at maxAttempts not retried');
  t.eq(buildApplySet(c2, { threshold: 70, retryDeferred: false }).length, 0, 'retryDeferred=false skips deferred');

  // daily cap
  t.eq(buildApplySet(c, { threshold: 70, dailyCap: 1 }).length, 1, 'daily cap limits set size');

  // --- resultToState ---
  t.eq(resultToState('applied', 0).status, 'applied', 'applied → applied');
  t.eq(resultToState('posting_not_found', 0).status, 'dead', 'posting_not_found → dead');
  t.eq(resultToState('needs_login', 0).status, 'needs_login', 'needs_login → needs_login');
  t.eq(resultToState('workday_captcha', 0).status, 'needs_manual', 'captcha → needs_manual (never solved)');
  t.eq(resultToState('missing_required', 0).status, 'sourced', 'transient first fail → stays sourced (retry)');
  t.eq(resultToState('missing_required', 0).retry, true, 'transient marks retry');
  t.eq(resultToState('missing_required', 2, 3).status, 'needs_manual', 'transient at maxAttempts → needs_manual');
  t.eq(resultToState('submit_unclear', 1, 3).attempts, 2, 'attempts increments');

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
