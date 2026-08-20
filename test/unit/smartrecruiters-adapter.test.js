'use strict';

const smartrecruiters = require('../../sourcing/adapters/smartrecruiters');

module.exports = async t => {
  const source = { name: 'Synthetic Semiconductor', slug: 'SyntheticSemi', country: 'us' };
  t.eq(smartrecruiters.searchTerms({ query: 'Quality Engineer' },
    ['quality engineer', 'Process Engineer', 'Equipment Engineer'], 3),
  ['Quality Engineer', 'Process Engineer', 'Equipment Engineer', ''],
  'smartrecruiters: primary-source queries are bounded and deduped case-insensitively');
  const boundedTerms = smartrecruiters.searchTerms({}, Array.from({ length: 25 }, (_, i) => `Profile ${i}`),
    99, ['SR-086504']);
  t.eq({ first: boundedTerms[0], profileCount: boundedTerms.filter(term => /^Profile /.test(term)).length,
    last: boundedTerms[boundedTerms.length - 1] },
  { first: 'SR-086504', profileCount: 20, last: '' },
  'smartrecruiters: source-scoped route hints run first while profile discovery is hard-capped at twenty queries');
  t.eq(smartrecruiters.hydrationRows([
    { id: 'E-1', name: 'Process Engineer', location: { fullLocation: 'Santa Clara, CA' } },
    { id: 'S-1', name: 'Senior Process Engineer', location: { fullLocation: 'Santa Clara, CA' } },
  ], source, { seniorityBand: 'entry' }).map(row => row.id), ['E-1'],
  'smartrecruiters: incompatible seniority is removed before expensive detail hydration');

  const originalFetch = global.fetch;
  const listingQueries = [];
  global.fetch = async url => {
    const parsed = new URL(String(url));
    const detail = parsed.pathname.match(/\/postings\/(S-\d+|Q-1|H-1)$/);
    if (detail) {
      return { ok: true, status: 200, json: async () => ({ id: detail[1],
        applyUrl: `https://jobs.smartrecruiters.com/SyntheticSemi/${detail[1]}`,
        jobAd: { sections: { jobDescription: { text: 'Own wafer process control and metrology.' },
          qualifications: { text: 'SPC and yield-analysis experience.' } } } }) };
    }
    const query = parsed.searchParams.get('q') || '';
    const offset = Number(parsed.searchParams.get('offset') || 0);
    listingQueries.push(query);
    if (query === 'process engineer') {
      return { ok: true, status: 200, json: async () => ({ totalFound: 1, content: [{ id: 'Q-1',
        name: 'Fresh Process Engineer', company: { identifier: 'SyntheticSemi' },
        location: { fullLocation: 'Santa Clara, CA, United States' } }] }) };
    }
    if (query === 'SR-086504') {
      return { ok: true, status: 200, json: async () => ({ totalFound: 1, content: [{ id: 'H-1',
        name: 'Hinted Quality Engineer', company: { identifier: 'SyntheticSemi' },
        location: { fullLocation: 'Santa Clara, CA, United States' } }] }) };
    }
    const page = offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `S-${i}`,
      name: `Process Engineer ${i}`, company: { identifier: 'SyntheticSemi' },
      location: { fullLocation: 'San Jose, CA, United States' } }))
      : offset === 100 ? [{ id: 'S-100', name: 'Process Engineer 100',
        company: { identifier: 'SyntheticSemi' }, location: { fullLocation: 'San Jose, CA, United States' } }] : [];
    return { ok: true, status: 200, json: async () => ({ totalFound: 101, content: page }) };
  };

  try {
    const jobs = await smartrecruiters.fetchJobs(source, { queries: ['process engineer'],
      routeHints: ['SR-086504'], max: 200,
      timeoutMs: 1000, detailConcurrency: 50 });
    t.ok(listingQueries.includes('process engineer'),
      'smartrecruiters: configured candidate query is sent to the primary-source postings API');
    t.ok(listingQueries.includes('SR-086504'),
      'smartrecruiters: an employer-matched requisition hint is sent to the primary-source postings API');
    t.eq(jobs.length, 103, 'smartrecruiters: hint, profile-query, and broad-search results dedupe by posting id');
    const beyondOldCap = jobs.find(job => job.id === 'S-100');
    t.ok(!!beyondOldCap && beyondOldCap.description.includes('yield-analysis'),
      'smartrecruiters: eligible rows beyond the historical first-100 cap receive full details');
    t.eq(jobs.filter(job => job.hydrationStatus === 'hydration_success').length, 103,
      'smartrecruiters: successful detail hydration carries an observable status');
    t.eq(jobs.find(job => job.id === 'Q-1').matchedQueries, ['process engineer'],
      'smartrecruiters: exact primary-source query provenance survives normalization');
  } finally {
    global.fetch = originalFetch;
  }
};
