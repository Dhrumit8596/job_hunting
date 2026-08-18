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
      const start = body.offset;
      const page = start >= 120 ? [] : Array.from({ length: Math.min(20, 120 - start) }, (_, i) => {
        const n = start + i;
        return { title: `Process Engineer ${n}`, locationsText: 'San Jose, CA',
          postedOn: 'Posted 2 Days Ago', bulletFields: [`B-${n}`],
          externalPath: `/job/San-Jose/Process-Engineer-${n}_B-${n}` };
      });
      return { ok: true, status: 200, json: async () => ({ jobPostings: page }) };
    }
    const id = String(url).match(/_(Q-1|B-\d+)$/)[1];
    return { ok: true, status: 200, json: async () => ({ jobPostingInfo: {
      jobDescription: `<p>Full primary-source requirements for ${id}: wafer metrology, SPC, and yield.</p>`,
    } }) };
  };

  try {
    const jobs = await workday.fetchJobs(source, { queries: ['process engineer'], max: 120,
      timeoutMs: 1000, detailConcurrency: 50 });
    t.ok(listingSearches.includes('process engineer'),
      'workday: configured candidate query is sent to the primary-source search endpoint');
    t.eq(jobs.length, 121, 'workday: query and broad-search results dedupe into one bounded set');
    const beyondOldCap = jobs.find(job => job.id === 'B-119');
    t.ok(!!beyondOldCap && beyondOldCap.description.includes('wafer metrology'),
      'workday: candidate-relevant rows beyond the historical first-100 cap receive full details');
    t.eq(jobs.filter(job => job.descriptionStatus === 'complete').length, 121,
      'workday: every eligible returned row is explicitly marked description-complete');
    t.eq(jobs.filter(job => job.hydrationStatus === 'hydration_success').length, 121,
      'workday: successful detail hydration carries an observable status');
  } finally {
    global.fetch = originalFetch;
  }
};
