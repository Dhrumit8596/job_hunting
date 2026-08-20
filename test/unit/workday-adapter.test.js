'use strict';

const workday = require('../../sourcing/adapters/workday');

module.exports = async t => {
  const source = {
    name: 'Synthetic Wafer Co',
    apiUrl: 'https://synthetic.wd1.myworkdayjobs.com/wday/cxs/synthetic/Careers/jobs',
    siteBase: 'https://synthetic.wd1.myworkdayjobs.com/en-US/Careers',
  };
  t.eq(workday.searchTerms({ queries: ['Quality Engineer'] },
    ['quality engineer', 'Process Engineer', 'Equipment Engineer', 'Failure Analysis Engineer'], 3),
  ['Quality Engineer', 'Process Engineer', 'Equipment Engineer', ''],
  'workday: primary-source queries are bounded and deduped case-insensitively');
  const boundedTerms = workday.searchTerms({}, Array.from({ length: 25 }, (_, i) => `Profile ${i}`), 99,
    ['R-086504']);
  t.eq({ first: boundedTerms[0], profileCount: boundedTerms.filter(term => /^Profile /.test(term)).length,
    last: boundedTerms[boundedTerms.length - 1] },
  { first: 'R-086504', profileCount: 20, last: '' },
  'workday: source-scoped route hints run first while the profile-query frontier remains hard-capped at twenty');
  t.eq(workday.hydrationRows([
    { title: 'Process Engineer', locationsText: 'Santa Clara, CA', bulletFields: ['E-1'] },
    { title: 'Senior Process Engineer', locationsText: 'Santa Clara, CA', bulletFields: ['S-1'] },
  ], source, { seniorityBand: 'entry' }).map(row => row.bulletFields[0]), ['E-1'],
  'workday: incompatible seniority is removed before expensive detail hydration');

  const originalFetch = global.fetch;
  const listingSearches = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      listingSearches.push(body.searchText);
      if (body.searchText === 'process engineer') {
        return { ok: true, status: 200, json: async () => ({ jobPostings: [{
          title: 'Fresh Process Engineer', locationsText: 'Santa Clara, CA',
          postedOn: 'Posted Today', bulletFields: ['Q-1'],
          externalPath: '/job/Santa-Clara/Fresh-Process-Engineer_Q-1',
        }] }) };
      }
      if (body.searchText === 'R-086504') {
        return { ok: true, status: 200, json: async () => ({ jobPostings: [{
          title: 'Hinted Supplier Quality Engineer II', locationsText: 'Santa Clara, CA',
          postedOn: 'Posted Today', bulletFields: ['H-1'],
          externalPath: '/job/Santa-Clara/Hinted-Supplier-Quality-Engineer-II_H-1',
        }] }) };
      }
      const start = body.offset;
      const page = start >= 120 ? [] : Array.from({ length: Math.min(20, 120 - start) }, (_, i) => {
        const n = start + i;
        return { title: `Process Engineer ${n}`, locationsText: 'San Jose, CA',
          postedOn: 'Posted 2 Days Ago', bulletFields: [`B-${n}`],
          externalPath: `/job/San-Jose/Process-Engineer-${n}_B-${n}` };
      });
      return { ok: true, status: 200, json: async () => ({ jobPostings: page }) };
    }
    const id = String(url).match(/_(Q-1|H-1|B-\d+)$/)[1];
    return { ok: true, status: 200, json: async () => ({ jobPostingInfo: {
      jobDescription: `<p>Full primary-source requirements for ${id}: wafer metrology, SPC, and yield.</p>`,
    } }) };
  };

  try {
    const jobs = await workday.fetchJobs(source, { queries: ['process engineer'], routeHints: ['R-086504'], max: 120,
      timeoutMs: 1000, detailConcurrency: 50 });
    t.ok(listingSearches.includes('process engineer'),
      'workday: configured candidate query is sent to the primary-source search endpoint');
    t.ok(listingSearches.includes('R-086504'),
      'workday: an employer-matched requisition hint is sent to the primary-source search endpoint');
    t.eq(jobs.length, 122, 'workday: hint, profile-query, and broad-search results dedupe into one bounded set');
    const beyondOldCap = jobs.find(job => job.id === 'B-119');
    t.ok(!!beyondOldCap && beyondOldCap.description.includes('wafer metrology'),
      'workday: candidate-relevant rows beyond the historical first-100 cap receive full details');
    t.eq(jobs.filter(job => job.descriptionStatus === 'complete').length, 122,
      'workday: every eligible returned row is explicitly marked description-complete');
    t.eq(jobs.filter(job => job.hydrationStatus === 'hydration_success').length, 122,
      'workday: successful detail hydration carries an observable status');
    t.eq(jobs.find(job => job.id === 'Q-1').matchedQueries, ['process engineer'],
      'workday: exact primary-source query provenance survives normalization');
  } finally {
    global.fetch = originalFetch;
  }
};
