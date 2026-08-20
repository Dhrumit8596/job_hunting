'use strict';

const Route = require('../../sourcing/route-resolution');
const { fetchAll } = require('../../sourcing/pipeline');
const workday = require('../../sourcing/adapters/workday');
const BrowserBatch = require('../../browser-batch');

function response(url, html, status = 200, location = '') {
  return { ok: status >= 200 && status < 300, status, url,
    headers: { get: key => String(key).toLowerCase() === 'location' ? location : '' },
    text: async () => html };
}

module.exports = async t => {
  const jj = { ats: 'workday', name: 'Johnson & Johnson',
    aliases: ['Shockwave Medical'], careerHosts: ['careers.jnj.com'] };
  const applied = { ats: 'workday', name: 'Applied Materials',
    aliases: ['Applied Materials, Inc.'], careerHosts: ['careers.appliedmaterials.com'] };
  t.eq(Route.hintsForSource(jj, [{ originalCompany: 'Shockwave Medical', careerHost: 'unrelated.example',
    terms: ['R-086504'] }, { originalCompany: 'Shockwave', careerHost: '', terms: ['R-000001'] }]),
  [], 'route hints: a registered employer alias cannot authorize an unrelated route host');
  t.eq(Route.hintsForSource(jj, [{ originalCompany: 'Unrelated', careerHost: 'www.careers.jnj.com',
    terms: ['R-086505'] }]), [],
  'route hints: a registered career host cannot authorize an unrelated employer identity');
  t.eq(Route.hintsForSource(jj, [{ originalCompany: 'Shockwave Medical', careerHost: 'www.careers.jnj.com',
    terms: ['R-086505'] }]), ['R-086505'],
  'route hints: exact registered employer and host jointly attest a source');
  t.eq(Route.hintsForSource(jj, [{ originalCompany: 'Unrelated', careerHost: 'jobs.careers.jnj.com',
    terms: ['R-086506'] }]), [],
  'route hints: an unregistered subdomain does not suffix-match into an employer');

  t.eq(Route.extractRequisitionTokens({ applyUrl:
    'https://www.careers.jnj.com/en/jobs/r-086504/supplier-quality-engineer-ii/' }, '', '', []),
  ['r-086504'], 'route hints: a posting-specific J&J careers path yields its requisition token');
  t.eq(Route.extractRequisitionTokens({ applyUrl: 'https://dsp.prng.co/abc' },
    'https://careers.appliedmaterials.com/careers/job/790301234567',
    '<link rel="canonical" href="https://careers.appliedmaterials.com/job/R2626397">', []),
  ['R2626397'], 'route hints: an Applied Materials prng landing extracts its explicit R-token');
  t.eq(Route.isPostingSpecificDirectUrl('https://jobs.ashbyhq.com/skydio/' +
    '02c135cc-69dd-486e-b56f-defeb3b467f5/application'), true,
  'route resolution: a posting-specific supported ATS application URL is attested');
  t.eq(Route.isPostingSpecificDirectUrl('https://jobs.ashbyhq.com/skydio'), false,
    'route resolution: an ATS job-board landing without a posting id is not attested');
  t.eq(Route.postingTokenFromDirectUrl(
    'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/Santa-Clara/Supplier-Quality-Engineer-II_R-086504'),
  'R-086504', 'route hints: Workday R-hyphen requisition ids survive direct URL parsing');
  t.eq(Route.isSafePublicUrl('http://127.0.0.1/private'), false,
    'route resolution: loopback landing inspection is rejected');
  t.eq(Route.isSafePublicUrl('http://[fd00::1]/private'), false,
    'route resolution: private IPv6 literals are rejected');
  let redirectFailure = '';
  try {
    await Route.fetchLanding('https://careers.jnj.com/jobs/r-086504', {
      allowedHosts: ['careers.jnj.com'], fetchFn: async url => response(url, '', 302,
        'https://unrelated.example/jobs/r-086504'),
    });
  } catch (error) { redirectFailure = error.message; }
  t.eq(redirectFailure, 'route_redirect_host_not_attested',
    'route resolution: a registered careers page cannot redirect inspection to an unregistered host');
  t.eq(Route.rankRouteCandidates([{ id: 'low', fitScore: 75, title: 'Process Engineer', lastSeenAt: 1 },
    { id: 'high', fitScore: 91, title: 'Quality Engineer', lastSeenAt: 1 },
    { id: 'attempted', fitScore: 99, title: 'Process Engineer', attempted: true }]).map(job => job.id),
  ['high', 'low'],
  'route resolution: raw fit only prioritizes bounded landing work and explicitly attempted rows are not unlocked');
  const boundedFetches = [];
  const boundedInspection = await Route.inspectUnknownDirectRoutes(Array.from({ length: 21 }, (_, i) => ({
    sourcePlatform: 'linkedin', jobId: `rank-${i}`, company: 'Shockwave Medical',
    title: 'Quality Engineer', fitScore: i, lastSeenAt: i,
    externalApplyUrl: `https://careers.jnj.com/jobs/rank-${i}` })), [jj], {
      concurrency: 4, fetchFn: async url => { boundedFetches.push(url); return response(url, '<p>Careers</p>'); },
    });
  t.eq({ inspected: boundedInspection.inspected, fetched: boundedFetches.length,
    droppedLowest: !boundedFetches.some(url => /rank-0\/?$/.test(url)) },
  { inspected: 20, fetched: 20, droppedLowest: true },
  'route resolution: raw-fit prioritization remains a hard twenty-request frontier and is not a qualification score');
  let cooldownFetches = 0;
  const cooldownRow = { sourcePlatform: 'linkedin', jobId: 'cooldown-1', company: 'Shockwave Medical',
    title: 'Quality Engineer', externalApplyUrl: 'https://careers.jnj.com/jobs/r-086504' };
  const firstLanding = await Route.inspectUnknownDirectRoutes([cooldownRow], [jj], { now: 100000,
    fetchFn: async url => { cooldownFetches++; return response(url, '<p>No route token</p>'); } });
  const persistedLanding = BrowserBatch.mergeRouteInspection([cooldownRow], firstLanding.outcomes).list;
  const secondLanding = await Route.inspectUnknownDirectRoutes(persistedLanding, [jj], { now: 101000,
    landingRetryCooldownMs: 3600000,
    fetchFn: async url => { cooldownFetches++; return response(url, '<p>No route token</p>'); } });
  t.eq({ first: firstLanding.inspected, second: secondLanding.inspected, fetches: cooldownFetches,
    attempts: persistedLanding[0].routeLandingAttempts },
  { first: 1, second: 0, fetches: 1, attempts: 1 },
  'route resolution: a durably marked landing rotates out during the method-specific cooldown');
  let zeroFetches = 0;
  const disabledInspection = await Route.inspectUnknownDirectRoutes([{ sourcePlatform: 'linkedin',
    jobId: 'disabled', company: 'Shockwave Medical', title: 'Quality Engineer',
    externalApplyUrl: 'https://careers.jnj.com/jobs/disabled' }], [jj], {
      limit: 0, fetchFn: async url => { zeroFetches++; return response(url, ''); },
    });
  t.eq({ inspected: disabledInspection.inspected, fetched: zeroFetches }, { inspected: 0, fetched: 0 },
    'route resolution: an explicit zero limit disables landing requests');

  const shockwave = { id: 'li-jj', sourcePlatform: 'linkedin', platform: 'linkedin',
    company: 'Shockwave Medical', title: 'Supplier Quality Engineer II', location: 'Santa Clara, CA',
    applyUrl: 'https://www.careers.jnj.com/en/jobs/r-086504/supplier-quality-engineer-ii/',
    channel: 'external', needsAtsResolution: true, sourceRefs: [{ sourceJobId: 'li-jj' }] };
  const skydio = { id: 'li-skydio', sourcePlatform: 'linkedin', platform: 'linkedin', company: 'Skydio',
    title: 'Product Quality Engineer', location: 'San Mateo, CA',
    applyUrl: 'https://www.skydio.com/jobs/product-quality-engineer', channel: 'external',
    needsAtsResolution: true, sourceRefs: [{ sourceJobId: 'li-skydio' }] };
  const generic = { id: 'li-generic', sourcePlatform: 'linkedin', platform: 'linkedin', company: 'Acme',
    title: 'Process Engineer', location: 'Fremont, CA', applyUrl: 'https://careers.acme.test/jobs/123456',
    channel: 'external', needsAtsResolution: true };
  const ambiguous = { ...skydio, id: 'li-ambiguous',
    applyUrl: 'https://www.skydio.com/jobs/ambiguous' };
  const footer = { ...skydio, id: 'li-footer',
    applyUrl: 'https://www.skydio.com/jobs/general-careers' };
  const poisoned = { ...shockwave, id: 'li-poisoned',
    applyUrl: 'https://unrelated.example/jobs/r-086504' };
  const ashbyUrl = 'https://jobs.ashbyhq.com/skydio/d4fdb4b0-9fc4-4a1e-bfea-e7c2ff9b587a/application';
  const fetched = [];
  const inspected = await Route.inspectUnknownDirectRoutes([shockwave, skydio, generic, ambiguous, footer, poisoned],
    [jj, { ats: 'ashby', slug: 'skydio', name: 'Skydio', careerHosts: ['skydio.com'] }], {
      limit: 10, concurrency: 2, fetchFn: async url => {
        fetched.push(url);
        if (/careers\.jnj\.com/.test(url)) return response(url,
          '<html><meta name="requisition" content="R-086504"><body>Job requisition id R-086504</body></html>');
        if (/product-quality/.test(url)) return response(url,
          `<p>Job ID: d4fdb4b0-9fc4-4a1e-bfea-e7c2ff9b587a</p><a href="${ashbyUrl}">Apply now</a>`);
        if (/ambiguous/.test(url)) return response(url, `<a href="${ashbyUrl}">Apply</a>` +
          '<a href="https://job-boards.greenhouse.io/skydio/jobs/1234567">Alternate</a>');
        if (/general-careers/.test(url)) return response(url,
          `<footer><a href="${ashbyUrl}">Featured opening</a></footer>`);
        return response(url, '<form action="/apply"><p>Office 123456. Join our talent network.</p></form>');
      },
    });
  const jjJob = inspected.jobs.find(job => job.id === 'li-jj');
  t.eq({ company: jjJob.company, alias: jjJob.routeCompanyAlias,
    unresolved: jjJob.needsAtsResolution, url: jjJob.applyUrl },
  { company: 'Johnson & Johnson', alias: 'Shockwave Medical', unresolved: true,
    url: shockwave.applyUrl },
  'route resolution: exact alias canonicalizes employer for official matching but a token alone does not attest a route');
  t.eq(inspected.hints.find(hint => hint.browserJobId === 'li-jj').terms, ['r-086504'],
    'route resolution: token evidence becomes a source-scoped official lookup hint');
  const skydioJob = inspected.jobs.find(job => job.id === 'li-skydio');
  t.eq({ url: skydioJob.applyUrl, ats: skydioJob.detectedAts,
    unresolved: skydioJob.needsAtsResolution },
  { url: skydio.applyUrl, ats: undefined, unresolved: true },
  'route resolution: even strong embedded ATS evidence stays a lookup hint until an official current row uniquely matches');
  t.eq(inspected.hints.find(hint => hint.browserJobId === 'li-skydio').terms,
    ['d4fdb4b0-9fc4-4a1e-bfea-e7c2ff9b587a'],
  'route resolution: matching labeled ATS evidence is retained as source-scoped lookup evidence');
  t.eq(inspected.jobs.find(job => job.id === 'li-generic').needsAtsResolution, true,
    'route resolution: an arbitrary corporate form and naked number never become a generic route');
  t.eq(inspected.jobs.find(job => job.id === 'li-ambiguous').needsAtsResolution, true,
    'route resolution: multiple distinct ATS posting links remain unresolved');
  t.eq(inspected.jobs.find(job => job.id === 'li-footer').needsAtsResolution, true,
    'route resolution: an embedded ATS link remains lookup-only until an official unique match');
  t.eq(fetched.some(url => /unrelated\.example/.test(url)), false,
    'route resolution: a known company cannot expand inspection to an unregistered route host');
  t.eq({ inspected: inspected.inspected, directHints: inspected.directHints, fetched: fetched.length },
    { inspected: 4, directHints: 2, fetched: 4 },
  'route resolution: only uniquely registered employers enter the bounded fetch frontier');

  const originalWorkdayFetch = workday.fetchJobs;
  let receivedHints = null;
  workday.fetchJobs = async (_source, options) => {
    receivedHints = options.routeHints;
    return [{ id: 'R-086504', title: 'Supplier Quality Engineer II', company: 'Johnson & Johnson',
      location: 'Santa Clara, CA', applyUrl:
        'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/Santa-Clara/Supplier-Quality-Engineer-II_R-086504',
      ats: 'workday', description: 'Current official requirements.' }];
  };
  try {
    const fetchedOfficial = await fetchAll([jj], { routeHints: [{ originalCompany: 'Shockwave Medical',
      careerHost: 'careers.jnj.com', terms: ['R-086504'] }] });
    t.eq({ hints: receivedHints, aliases: fetchedOfficial.jobs[0].sourceAliases,
      hosts: fetchedOfficial.jobs[0].careerHosts },
    { hints: ['R-086504'], aliases: ['Shockwave Medical'], hosts: ['careers.jnj.com'] },
    'route resolution: pipeline scopes hint terms to the exact employer and annotates official rows with registry metadata');
  } finally { workday.fetchJobs = originalWorkdayFetch; }
};
