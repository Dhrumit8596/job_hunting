'use strict';

const { sourceAll, postingAgeDays, autonomousApplyStrategy, autonomousApplyFilter } = require('../../sourcing/source-run');
const { makeJob } = require('../../sourcing/normalize');

module.exports = async (t) => {
  t.eq(postingAgeDays('Posted 30+ Days Ago'), 31,
    'source-run freshness: Workday 30+ label is not overstated as within 30 days');
  const pendingLead = { title: 'Process Engineer', sourcePlatform: 'indeed', ats: 'indeed',
    applyUrl: 'https://www.indeed.com/viewjob?jk=pending', needsAtsResolution: true };
  t.eq(autonomousApplyFilter([pendingLead], true), [pendingLead],
    'source-run: unresolved browser offsite lead stays in corpus for later routing resolution');
  t.eq(autonomousApplyFilter([{ title: 'Process Engineer', company: 'Spoof Co',
    location: 'Fremont, CA', channel: 'external', needsAtsResolution: false,
    applyUrl: 'https://careers.example.com/jobs/R1', detectedAts: 'workable' }], true), [],
  'source-run: metadata cannot turn an unrelated corporate host into an autonomous ATS route');
  const provenanceOnly = { title: 'Process Engineer', sourcePlatform: 'linkedin', ats: 'linkedin',
    channel: 'external', applyUrl: 'https://careers.example.com/jobs/process-engineer',
    needsAtsResolution: false };
  t.eq(autonomousApplyFilter([provenanceOnly], true), [],
    'source-run: LinkedIn provenance never turns an unknown corporate destination into a generic autonomous route');
  t.eq(autonomousApplyStrategy({ ...provenanceOnly, applyUrl:
    'https://job-boards.greenhouse.io/acme/jobs/1234567', detectedAts: 'greenhouse',
    needsAtsResolution: true }), '',
  'source-run: an explicit unresolved marker blocks even a recognizable URL until owned resolution clears it');
  const discoveryAdapters = {
    mock: {
      async fetchJobs(_source, opts = {}) {
        t.eq((opts.queries || []).join('|'), 'wafer process engineer|quality validation engineer',
          'source-run: forwards caller-provided discovery queries');
        t.eq(opts.locationQuery, 'Santa Clara, CA', 'source-run: forwards profile-derived discovery location');
        t.eq(opts.targetRadiusMiles, 60, 'source-run: forwards profile-derived discovery radius');
        return [makeJob({ id: 'ats-1', title: 'Process Engineer', company: 'Acme',
          location: 'Fremont, CA', ats: 'greenhouse',
          applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/ats-1',
          postedAt: '2026-08-15T00:00:00.000Z', description: 'Short requirements.' })];
      },
    },
  };
  const browserJobs = [{
    platform: 'linkedin', jobId: '991', title: 'Process Engineer', company: 'Acme',
    location: 'Fremont, CA', listingUrl: 'https://www.linkedin.com/jobs/view/991/',
    externalApplyUrl: 'https://job-boards.greenhouse.io/acme/jobs/ats-1',
    description: 'Own wafer inspection, thin-film metrology, SPC, defect reduction, and root-cause analysis.',
    descriptionStatus: 'full', query: 'wafer process engineer', scrapedAt: 123,
  }, {
    platform: 'indeed', jobId: 'missing-2', title: 'Quality Engineer', company: 'Beta Medical',
    location: 'Irvine, CA', applyUrl: 'https://www.indeed.com/viewjob?jk=missing-2',
    indeedApply: true, description: '',
  }];

  const { store, report } = await sourceAll({ sources: [], discoveryAdapters, browserJobs, target: 1,
    queries: ['wafer process engineer', 'quality validation engineer'],
    targetLocation: { city: 'Santa Clara', state: 'CA' }, targetRadiusMiles: 60,
    now: Date.parse('2026-08-17T00:00:00.000Z') });
  const records = Object.values(store.index);
  t.eq(records.length, 2, 'source-run: browser captures enter the normalized corpus');
  const acme = records.find(j => j.company === 'Acme');
  t.ok(acme.description.includes('thin-film metrology'), 'source-run: cross-source duplicate keeps richer browser JD');
  t.eq(acme.applyUrl, 'https://job-boards.greenhouse.io/acme/jobs/ats-1', 'source-run: direct ATS URL retained');
  t.eq(acme.sourceJobId, 'ats-1', 'source-run: direct route keeps its own source job id atomically');
  t.eq(acme.sourceRefs.length, 2, 'source-run: duplicate provenance is unioned');
  t.ok(acme.modalities.includes('discovery-mock') && acme.modalities.includes('browser-linkedin'),
    'source-run: both source modalities retained on enriched posting');
  t.eq(report.modalityC.fetched, 2, 'source-run: browser modality reports fetched count');
  t.eq(report.modalityC.added, 1, 'source-run: one non-duplicate browser job added');
  t.eq(report.modalityC.enriched, 1, 'source-run: browser mirror enrichment reported');
  t.eq(report.modalityC.needsDescription, 1, 'source-run: descriptionless browser lead explicitly reported');
  t.eq(report.modalityC.channelHydration.external.hydrated, 1,
    'source-run: channel hydration counts hydrated external browser leads');
  t.eq(report.modalityC.channelHydration.indeed_apply.missing, 1,
    'source-run: channel hydration counts missing Indeed Apply descriptions');
  t.eq(report.modalityC.hydrationStatuses.hydration_success, 1,
    'source-run: browser hydration status totals include successes');
  t.eq(report.modalityC.hydrationStatuses.hydration_missing_dom, 1,
  'source-run: browser hydration status totals include DOM misses');
  t.eq(report.modalityC.resolution.resolved, 0,
    'source-run: a lead already carrying its direct route does not claim a new resolution');
  t.eq({ ready: report.quality.descriptions.ready, missing: report.quality.descriptions.missing,
    coverage: report.quality.descriptions.coverage }, { ready: 1, missing: 1, coverage: 0.5 },
    'source-run quality: full-description coverage is measured after cross-source dedupe');
  t.eq(report.quality.descriptions.examples.map(row => row.id), ['indeed:missing-2'],
    'source-run quality: missing-description examples are bounded and description-free');
  t.eq(report.quality.deduplication.duplicateMerges, 1,
    'source-run quality: cross-source duplicate merges are measured');
  t.eq(report.quality.supportedAts.coverage, 1,
    'source-run quality: every retained route is covered by an autonomous ATS strategy');
  t.eq(report.quality.freshness.fresh7d, 1,
    'source-run quality: primary-source posting freshness is measured when published time is known');
  t.eq(report.quality.fitYield.kind, 'heuristic_priority_only',
    'source-run quality: heuristic priority is not mislabeled as genuine evidence-grounded fit');
  const states = Object.values(store.state);
  t.eq(states.every(s => s.scoreKind === 'heuristic' && !!s.descriptionFingerprint), true,
    'source-run: source scores are marked heuristic with JD fingerprint');

  let adapterCalls = 0, guardCalls = 0, stopped = '';
  try {
    await sourceAll({ sources: [], discoveryAdapters: {
      first: { async fetchJobs() { adapterCalls += 1; return []; } },
      second: { async fetchJobs() { adapterCalls += 1; return []; } },
    }, guard: async stage => {
      guardCalls += 1;
      if (stage === 'before_discovery_adapter_second') {
        const error = new Error('source_ownership_lost'); error.code = 'source_ownership_lost'; throw error;
      }
    } });
  } catch (error) { stopped = error.code; }
  t.eq({ adapterCalls, stopped, guarded: guardCalls > 2 },
    { adapterCalls: 1, stopped: 'source_ownership_lost', guarded: true },
  'source-run: ownership is rechecked between expensive discovery adapters and stops later work');

  const freshRediscovery = await sourceAll({ sources: [], discoveryAdapters: {}, maxBrowserAgeMs: 2 * 86400000,
    now: 10 * 86400000, browserJobs: [{ sourcePlatform: 'linkedin', jobId: 'fresh-1',
      title: 'Quality Engineer', company: 'Acme', location: 'Fremont, CA',
      listingUrl: 'https://www.linkedin.com/jobs/view/fresh-1/', isEasyApply: true,
      description: 'Quality validation and root cause requirements.', descriptionStatus: 'full',
      firstDiscoveredAt: 1 * 86400000, discoveredAt: 1 * 86400000, lastSeenAt: 10 * 86400000 }],
  });
  t.eq(freshRediscovery.report.modalityC.fetched, 1,
    'source-run freshness: an older hydrated job rediscovered now remains fresh through lastSeenAt');
  const staleOld = await sourceAll({ sources: [], discoveryAdapters: {}, maxBrowserAgeMs: 2 * 86400000,
    now: 10 * 86400000, browserJobs: [{ sourcePlatform: 'indeed', jobId: 'stale-1',
      title: 'Quality Engineer', company: 'Beta', location: 'Irvine, CA',
      listingUrl: 'https://www.indeed.com/viewjob?jk=stale-1', indeedApply: true,
      description: 'Quality requirements.', descriptionStatus: 'full', lastSeenAt: 1 * 86400000 }],
  });
  t.eq(staleOld.report.modalityC.fetched, 0,
    'source-run freshness: a genuinely old LinkedIn/Indeed job not rediscovered remains stale');

  const discoveryCannotAttest = await sourceAll({ sources: [], discoveryAdapters: {
    mirror: { async fetchJobs() { return [makeJob({ id: 'discovery-route', title: 'Process Engineer',
      company: 'Discovery Co', location: 'Fremont, CA', ats: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/discovery/jobs/123456',
      description: 'Current-looking but non-registry discovery description.' })]; } },
  }, browserJobs: [{ sourcePlatform: 'linkedin', jobId: 'unresolved-discovery',
    title: 'Process Engineer', company: 'Discovery Co', location: 'Fremont, CA',
    listingUrl: 'https://www.linkedin.com/jobs/view/998877/',
    externalApplyUrl: 'https://careers.discovery.example/jobs/123456',
    description: 'Browser description.', descriptionStatus: 'full', needsAtsResolution: true }],
  autonomousApplyOnly: true });
  const unresolvedDiscovery = Object.values(discoveryCannotAttest.store.index)
    .find(row => row.sourceJobId === 'unresolved-discovery');
  t.eq({ resolved: discoveryCannotAttest.report.modalityC.resolution.resolved,
    unresolved: unresolvedDiscovery && unresolvedDiscovery.needsAtsResolution },
  { resolved: 0, unresolved: true },
  'source-run: a direct discovery record cannot impersonate a current official registry attestation');

  // A posting token from a registered employer landing may expand only that employer's official
  // query. The current official row must still uniquely match, and an attempted exact requisition
  // remains excluded after that enrichment rather than being unlocked by the new hint.
  const originalFetch = global.fetch;
  const searches = [];
  global.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      searches.push(body.searchText);
      return { ok: true, status: 200, json: async () => ({ jobPostings:
        body.searchText === 'R2626397' ? [{ title: 'Process Engineer R2626397',
          locationsText: 'Santa Clara, CA', postedOn: 'Posted Today', bulletFields: ['R2626397'],
          externalPath: '/job/Santa-Clara/Process-Engineer-R2626397_R2626397' }] : [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ jobPostingInfo: {
      jobDescription: 'Own wafer process control, SPC, metrology, and yield improvement.',
    } }) };
  };
  try {
    const attemptedHint = await sourceAll({ sources: [{ ats: 'workday', name: 'Applied Materials',
      aliases: ['Applied Materials, Inc.'], careerHosts: ['careers.appliedmaterials.com', 'jobs.appliedmaterials.com'],
      routeHosts: ['dsp.prng.co'],
      apiUrl: 'https://amat.wd1.myworkdayjobs.com/wday/cxs/amat/External/jobs',
      siteBase: 'https://amat.wd1.myworkdayjobs.com/en-US/External' }], discoveryAdapters: {},
      queries: [], autonomousApplyOnly: true,
      browserJobs: [{ sourcePlatform: 'linkedin', jobId: 'applied-hint',
        title: 'Process Engineer R2626397', company: 'Applied Materials', location: 'Santa Clara, CA',
        listingUrl: 'https://www.linkedin.com/jobs/view/991234/',
        externalApplyUrl: 'https://dsp.prng.co/landing/process-engineer',
        description: 'Own wafer process control, SPC, metrology, and yield improvement.',
        descriptionStatus: 'full', fitScore: 78, lastSeenAt: 100 }],
      routeResolutionFetch: async url => ({ ok: true, status: 200, url:
        'https://jobs.appliedmaterials.com/careers/job/process-engineer-R2626397',
        headers: { get: () => '' }, text: async () => '<p>Job requisition ID: R2626397</p>' }),
      appliedIdentity: { exactIds: new Set(['R2626397']), urls: new Set(), legacyRoles: new Set() } });
    t.ok(searches.includes('R2626397'),
      'source-run: Applied prng landing token drives only the matched official Workday query');
    t.eq({ resolved: attemptedHint.report.modalityC.resolution.resolved,
      excluded: attemptedHint.report.excludedApplied, remaining: Object.keys(attemptedHint.store.index).length },
    { resolved: 1, excluded: 1, remaining: 0 },
    'source-run: current official unique match resolves atomically but attempted R2626397 remains excluded');
  } finally { global.fetch = originalFetch; }
};
