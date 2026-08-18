'use strict';

const smartrecruiters = require('../../sourcing/adapters/smartrecruiters');

module.exports = async t => {
  const source = { name: 'Synthetic Semiconductor', slug: 'SyntheticSemi', country: 'us' };
  t.eq(smartrecruiters.searchTerms({ query: 'Quality Engineer' },
    ['quality engineer', 'Process Engineer', 'Equipment Engineer'], 3),
  ['Quality Engineer', 'Process Engineer', 'Equipment Engineer', ''],
  'smartrecruiters: primary-source queries are bounded and deduped case-insensitively');

  const originalFetch = global.fetch;
  const listingQueries = [];
  global.fetch = async url => {
    const parsed = new URL(String(url));
    const detail = parsed.pathname.match(/\/postings\/(S-\d+|Q-1)$/);
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
    const page = offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `S-${i}`,
      name: `Process Engineer ${i}`, company: { identifier: 'SyntheticSemi' },
      location: { fullLocation: 'San Jose, CA, United States' } }))
      : offset === 100 ? [{ id: 'S-100', name: 'Process Engineer 100',
        company: { identifier: 'SyntheticSemi' }, location: { fullLocation: 'San Jose, CA, United States' } }] : [];
    return { ok: true, status: 200, json: async () => ({ totalFound: 101, content: page }) };
  };

  try {
    const jobs = await smartrecruiters.fetchJobs(source, { queries: ['process engineer'], max: 200,
      timeoutMs: 1000, detailConcurrency: 50 });
    t.ok(listingQueries.includes('process engineer'),
      'smartrecruiters: configured candidate query is sent to the primary-source postings API');
    t.eq(jobs.length, 102, 'smartrecruiters: query and broad-search results dedupe by posting id');
    const beyondOldCap = jobs.find(job => job.id === 'S-100');
    t.ok(!!beyondOldCap && beyondOldCap.description.includes('yield-analysis'),
      'smartrecruiters: eligible rows beyond the historical first-100 cap receive full details');
    t.eq(jobs.filter(job => job.hydrationStatus === 'hydration_success').length, 102,
      'smartrecruiters: successful detail hydration carries an observable status');
  } finally {
    global.fetch = originalFetch;
  }
};
