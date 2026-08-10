'use strict';
// The representative mixed-run matrix is intentionally synthetic. It proves route coverage without
// opening a browser or submitting an application; live probes use this same shape later.
const matrix = require('../fixtures/mixed-apply-matrix.json');
const router = require('../../content/apply-router');

module.exports = (t) => {
  t.ok(matrix.length >= 20, 'mixed matrix: contains at least 20 representative jobs');
  const counts = {};
  const seen = new Set();
  for (const job of matrix) {
    const route = router.resolveStrategy(job, job.applyUrl);
    counts[route.name] = (counts[route.name] || 0) + 1;
    t.eq(route.name, job.expectedStrategy, 'mixed matrix: ' + job.id + ' selects expected handler');
    t.ok(!seen.has(job.id), 'mixed matrix: ' + job.id + ' appears once');
    seen.add(job.id);
  }
  for (const name of ['linkedin_ea', 'indeed', 'workday', 'greenhouse', 'smartrecruiters', 'lever', 'ashby']) {
    t.ok(counts[name] >= 1, 'mixed matrix: covers ' + name);
  }
  t.ok(counts.unsupported >= 1, 'mixed matrix: covers a safe manual/unsupported outcome');
};
