'use strict';

const eightfold = require('../../sourcing/adapters/eightfold');

function response(data, ok = true) {
  return { ok, async json() { return data; } };
}

module.exports = async (t) => {
  const source = {
    ats: 'eightfold',
    name: 'Example Semiconductor',
    origin: 'https://careers.example.com/path-is-ignored',
    domain: 'example.com',
    location: 'United States',
    queries: ['process engineer', 'quality engineer'],
  };

  const search = new URL(eightfold.searchUrl(source, { query: 'process engineer', start: 20 }));
  t.eq(search.origin + search.pathname, 'https://careers.example.com/api/pcsx/search',
    'eightfold: search uses branded PCS endpoint');
  t.eq(search.searchParams.get('domain'), 'example.com', 'eightfold: search includes employer domain');
  t.eq(search.searchParams.get('query'), 'process engineer', 'eightfold: search includes query');
  t.eq(search.searchParams.get('location'), 'United States', 'eightfold: search includes location scope');
  t.eq(search.searchParams.get('start'), '20', 'eightfold: search supports offset pagination');
  t.eq(search.searchParams.get('sort_by'), 'relevance', 'eightfold: search defaults to relevance');

  const raw = {
    id: 42609241,
    displayJobId: 'JR104922',
    name: 'Process Quality Engineer',
    locations: ['Boise, Idaho, United States of America'],
    standardizedLocations: ['Boise, ID, US'],
    postedTs: 1782345600,
    workLocationOption: 'onsite',
    jobDescription: '<p>Own SPC &amp; wafer metrology.</p>',
  };
  const detail = new URL(eightfold.detailUrl(source, raw));
  t.eq(detail.searchParams.get('position_id'), '42609241', 'eightfold: detail uses PCS position id');
  t.eq(detail.searchParams.get('domain'), 'example.com', 'eightfold: detail includes employer domain');
  t.eq(detail.searchParams.get('hl'), 'en', 'eightfold: detail defaults to English');
  const normalized = eightfold.normalize(raw, source);
  t.eq(normalized.id, '42609241', 'eightfold: numeric position id is normalized to string');
  t.eq(normalized.location, 'Boise, ID, US', 'eightfold: search row uses standardized location');
  t.eq(normalized.applyUrl, 'https://careers.example.com/careers/apply?pid=42609241',
    'eightfold: application URL lands on branded apply route');
  t.eq(normalized.description, 'Own SPC & wafer metrology.',
    'eightfold: detail HTML becomes grounded resume-match text');
  t.eq(normalized.remote, false, 'eightfold: onsite work mode is explicit');
  t.eq(normalized.postedAt, new Date(1782345600 * 1000).toISOString(),
    'eightfold: Unix posted timestamp becomes ISO');
  t.eq(normalized.ats, 'eightfold', 'eightfold: normalized ATS is retained');

  const calls = [];
  const fetchImpl = async urlString => {
    const url = new URL(urlString);
    calls.push(url);
    if (url.pathname === '/api/pcsx/search') {
      const query = url.searchParams.get('query');
      const start = Number(url.searchParams.get('start'));
      if (query === 'process engineer' && start === 0) return response({ data: {
        count: 3,
        positions: [
          { id: 1, name: 'Process Engineer', standardizedLocations: ['Fremont, CA, US'] },
          { id: 2, name: 'Office Manager', standardizedLocations: ['Boise, ID, US'] },
        ],
      } });
      if (query === 'process engineer' && start === 2) return response({ data: {
        count: 3,
        positions: [{ id: 3, name: 'Equipment Engineer', standardizedLocations: ['Boise, ID, US'] }],
      } });
      if (query === 'quality engineer' && start === 0) return response({ data: {
        count: 2,
        positions: [
          { id: 1, name: 'Process Engineer', standardizedLocations: ['Fremont, CA, US'] },
          { id: 4, name: 'Quality Engineer', standardizedLocations: ['Remote, US'], workLocationOption: 'remote' },
        ],
      } });
      return response({ data: { count: 0, positions: [] } });
    }
    if (url.pathname === '/api/pcsx/position_details') {
      const id = url.searchParams.get('position_id');
      if (id === '3') return response({}, false); // A failed detail must not drop its listing.
      return response({ data: {
        id: Number(id),
        jobDescription: `<p>Evidence for position ${id}: SPC, DOE, and root-cause analysis.</p>`,
      } });
    }
    throw new Error('Unexpected URL ' + urlString);
  };

  const jobs = await eightfold.fetchJobs(source, {
    fetchImpl,
    timeoutMs: 1000,
    max: 4,
    pageSize: 2,
    perQueryMax: 3,
    detailMax: 4,
    detailConcurrency: 2,
  });
  t.eq(jobs.map(j => j.id), ['1', '2', '3', '4'],
    'eightfold: paginated query results are deduped by stable position id');
  t.eq(calls.filter(url => url.pathname === '/api/pcsx/search').length, 3,
    'eightfold: pagination advances by returned page length across balanced queries');
  t.eq(calls.filter(url => url.pathname === '/api/pcsx/position_details').length, 3,
    'eightfold: details are fetched only for engineering/science titles');
  t.ok(jobs.find(j => j.id === '1').description.includes('SPC, DOE'),
    'eightfold: detail description enriches the listing');
  t.eq(jobs.find(j => j.id === '3').description, '',
    'eightfold: failed detail request retains the original listing');
  t.eq(jobs.find(j => j.id === '4').remote, true,
    'eightfold: remote work mode is preserved after enrichment');
  t.eq(jobs.find(j => j.id === '2').description, '',
    'eightfold: irrelevant title does not consume a detail request');

  t.eq(eightfold.searchUrl({ origin: 'not a URL', domain: 'x' }), '',
    'eightfold: malformed source origin fails closed');
  t.eq(await eightfold.fetchJobs({ origin: 'https://careers.example.com' }, { fetchImpl }), [],
    'eightfold: incomplete source configuration makes no requests');
};
