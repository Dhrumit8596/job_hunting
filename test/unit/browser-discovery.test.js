'use strict';

const { boundedQueries, prioritizeQueries, buildBrowserDiscoveryPlan, scanTerminal, boundDiscoveryPlan,
  runBoundedDiscoveryPlan } = require('../../sourcing/browser-discovery');

module.exports = async t => {
  t.eq(boundedQueries(['Process Engineer', ' process  engineer ', 'Quality Engineer'], 12),
    ['Process Engineer', 'Quality Engineer'],
  'browser discovery: title queries are normalized and deduplicated');
  t.eq(boundedQueries(Array.from({ length: 25 }, (_, i) => `Title ${i + 1}`)).length, 20,
    'browser discovery: the default title frontier covers the configured set and remains bounded');
  const plan = buildBrowserDiscoveryPlan({
    queries: ['Process Engineer', 'Quality Engineer'],
    targetLocation: { city: 'Santa Clara', state: 'CA' },
    targetRadiusMiles: 60,
    maxQueries: 12,
    maxPages: 2,
  });
  t.eq(plan.length, 4, 'browser discovery: every title is searched on LinkedIn and Indeed');
  const linkedin = plan.find(item => item.source === 'linkedin' && item.query === 'Process Engineer');
  const indeed = plan.find(item => item.source === 'indeed' && item.query === 'Process Engineer');
  t.eq(linkedin.source, 'linkedin', 'browser discovery: LinkedIn plan emitted');
  t.ok(!linkedin.url.includes('f_AL='), 'browser discovery: LinkedIn is not restricted to Easy Apply');
  t.ok(linkedin.url.includes('f_TPR=r2592000'), 'browser discovery: LinkedIn prefers jobs from the last 30 days');
  t.eq(indeed.source, 'indeed', 'browser discovery: Indeed plan emitted');
  t.ok(indeed.url.includes('fromage=30'), 'browser discovery: Indeed prefers jobs from the last 30 days');
  t.eq(indeed.scanOptions, { maxPages: 2, hydrateDescriptions: false },
  'browser discovery: Indeed card discovery is bounded and defers expensive hydration');
  const defaults = buildBrowserDiscoveryPlan({ queries: ['Process Engineer'] });
  t.eq({ linkedin: defaults[0].scanOptions.maxPages, indeed: defaults[1].scanOptions.maxPages },
    { linkedin: 3, indeed: 1 },
  'browser discovery: adaptive LinkedIn defaults to three pages while unknown Indeed state starts at one');
  t.eq(prioritizeQueries(['Experimental Engineer', 'Quality Engineer', 'Process Engineer']),
    ['Quality Engineer', 'Process Engineer', 'Experimental Engineer'],
  'browser discovery: exact resume-supported title families run before exploratory queries');
  t.eq(prioritizeQueries(['Experimental Engineer', 'Process Engineer'], Array.from({ length: 2 }, () => ({
    query: 'Experimental Engineer', discovered: 10, persisted: 10, directRoute: 5,
  })))[0], 'Process Engineer',
  'browser discovery: two good observations improve priority without displacing exact target families');
  const measured = prioritizeQueries(['Quality Engineer', 'Process Engineer', 'Metrology Engineer'], [
    { query: 'Quality Engineer', discovered: 25, persisted: 7, unique: 0, directRoute: 4 },
    { query: 'Quality Engineer', discovered: 25, persisted: 7, unique: 0, directRoute: 4 },
    { query: 'Process Engineer', discovered: 25, persisted: 7, unique: 6, directRoute: 3 },
    { query: 'Process Engineer', discovered: 25, persisted: 7, unique: 5, directRoute: 3 },
    { query: 'Metrology Engineer', discovered: 25, persisted: 5, unique: 4, directRoute: 1 },
    { query: 'Metrology Engineer', discovered: 25, persisted: 5, unique: 4, directRoute: 1 },
  ]);
  t.eq(measured.slice(0, 2), ['Process Engineer', 'Metrology Engineer'],
    'browser discovery: measured unique yield moves productive title families ahead of duplicate-only queries');
  const withLevelVariant = prioritizeQueries(['Quality Engineer', 'Process Engineer II', 'Process Engineer'], [
    { query: 'Process Engineer', discovered: 25, persisted: 7, unique: 6, directRoute: 3 },
    { query: 'Process Engineer', discovered: 25, persisted: 7, unique: 5, directRoute: 3 },
  ]);
  t.eq(withLevelVariant.slice(0, 2), ['Process Engineer', 'Process Engineer II'],
    'browser discovery: Engineer II variants inherit productive family yield without displacing the measured base');

  const done = scanTerminal({ pja_scan_coverage: [{ source: 'linkedin', query: 'Process Engineer',
    collected: 25, easyApply: 7, external: 18, ts: 200 }] }, linkedin, 100);
  t.eq({ terminal: done.terminal, status: done.status, collected: done.coverage.collected },
    { terminal: true, status: 'done', collected: 25 },
  'browser discovery: completion is correlated to source, query, and launch time');
  const linkedinFailed = scanTerminal({ pja_linkedin_scan: { q: 'Process Engineer', status: 'failed',
    reason: 'no_job_cards', ts: 210 } }, linkedin, 100);
  t.eq({ terminal: linkedinFailed.terminal, status: linkedinFailed.status, reason: linkedinFailed.reason },
    { terminal: true, status: 'failed', reason: 'no_job_cards' },
  'browser discovery: LinkedIn scanner failures terminalize explicitly instead of timing out');
  const paused = scanTerminal({ pja_indeed_scan: { q: 'Process Engineer', status: 'paused',
    reason: 'challenge', ts: 220 } }, indeed, 100);
  t.eq({ terminal: paused.terminal, status: paused.status, reason: paused.reason },
    { terminal: true, status: 'paused', reason: 'challenge' },
  'browser discovery: Indeed challenge is terminal and never bypassed');

  const full = buildBrowserDiscoveryPlan({
    queries: Array.from({ length: 20 }, (_, index) => `Engineer ${index + 1}`),
    targetLocation: { city: 'Santa Clara', state: 'CA' }, maxQueries: 20,
  });
  const budgeted = boundDiscoveryPlan(full, { totalBudgetMs: 20 * 60 * 1000,
    perQueryTimeoutMs: 120000, minimumPerItemMs: 5000 });
  t.ok(budgeted.plan.length <= 40 &&
    budgeted.perQueryTimeoutMs * budgeted.plan.length <= budgeted.totalBudgetMs,
  'browser discovery: 20 queries across two sources cannot exceed the total sourcing budget');
  t.eq(budgeted.clamped, true,
    'browser discovery: impossible requested per-query time is safely clamped to the total budget');

  let launches = 0, guardCalls = 0;
  const deadlineStopped = await runBoundedDiscoveryPlan(full.slice(0, 4), {
    totalBudgetMs: 40000, perQueryTimeoutMs: 10000, minimumPerItemMs: 1000,
    guard: async () => ({ ok: ++guardCalls <= 2, code: 'sourcing_deadline_exceeded' }),
    runItem: async item => { launches += 1; return { source: item.source, query: item.query, status: 'done' }; },
  });
  t.eq({ launches, error: deadlineStopped.terminalError },
    { launches: 2, error: 'sourcing_deadline_exceeded' },
  'browser discovery: deadline expiration stops scheduling additional scans');

  launches = 0; guardCalls = 0;
  const ownershipStopped = await runBoundedDiscoveryPlan(full.slice(0, 4), {
    totalBudgetMs: 40000, perQueryTimeoutMs: 10000, minimumPerItemMs: 1000,
    guard: async () => ({ ok: ++guardCalls <= 1, code: 'source_ownership_lost' }),
    runItem: async item => { launches += 1; return { source: item.source, query: item.query, status: 'done' }; },
  });
  t.eq({ launches, error: ownershipStopped.terminalError },
    { launches: 1, error: 'source_ownership_lost' },
  'browser discovery: ownership loss stops scheduling additional scans');

  const challengePlan = buildBrowserDiscoveryPlan({ queries: ['Process Engineer', 'Quality Engineer'],
    sources: ['indeed'], maxPages: 1 });
  const challenged = await runBoundedDiscoveryPlan(challengePlan, {
    totalBudgetMs: 20000, perQueryTimeoutMs: 10000, minimumPerItemMs: 1000,
    runItem: async item => ({ source: item.source, query: item.query, status: 'paused', reason: 'challenge' }),
  });
  t.eq(challenged.scans.map(row => row.status), ['paused', 'skipped_source_blocked'],
    'browser discovery: Indeed challenge marks later unexecuted queries source_blocked instead of empty');
};
