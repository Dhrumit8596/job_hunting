'use strict';

const { boundedQueries, buildBrowserDiscoveryPlan, scanTerminal } = require('../../sourcing/browser-discovery');

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
  const linkedin = plan[0], indeed = plan[1];
  t.eq(linkedin.source, 'linkedin', 'browser discovery: LinkedIn plan emitted');
  t.ok(!linkedin.url.includes('f_AL='), 'browser discovery: LinkedIn is not restricted to Easy Apply');
  t.ok(linkedin.url.includes('f_TPR=r2592000'), 'browser discovery: LinkedIn prefers jobs from the last 30 days');
  t.eq(indeed.source, 'indeed', 'browser discovery: Indeed plan emitted');
  t.ok(indeed.url.includes('fromage=30'), 'browser discovery: Indeed prefers jobs from the last 30 days');
  t.eq(indeed.scanOptions, { maxPages: 2, hydrateDescriptions: false },
    'browser discovery: Indeed card discovery is bounded and defers expensive hydration');

  const done = scanTerminal({ pja_scan_coverage: [{ source: 'linkedin', query: 'Process Engineer',
    collected: 25, easyApply: 7, external: 18, ts: 200 }] }, linkedin, 100);
  t.eq({ terminal: done.terminal, status: done.status, collected: done.coverage.collected },
    { terminal: true, status: 'done', collected: 25 },
  'browser discovery: completion is correlated to source, query, and launch time');
  const paused = scanTerminal({ pja_indeed_scan: { q: 'Process Engineer', status: 'paused',
    reason: 'challenge', ts: 220 } }, indeed, 100);
  t.eq({ terminal: paused.terminal, status: paused.status, reason: paused.reason },
    { terminal: true, status: 'paused', reason: 'challenge' },
  'browser discovery: Indeed challenge is terminal and never bypassed');
};
