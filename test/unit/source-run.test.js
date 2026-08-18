'use strict';

const { sourceAll, postingAgeDays, autonomousApplyFilter } = require('../../sourcing/source-run');
const { makeJob } = require('../../sourcing/normalize');

module.exports = async (t) => {
  t.eq(postingAgeDays('Posted 30+ Days Ago'), 31,
    'source-run freshness: Workday 30+ label is not overstated as within 30 days');
  const pendingLead = { title: 'Process Engineer', sourcePlatform: 'indeed', ats: 'indeed',
    applyUrl: 'https://www.indeed.com/viewjob?jk=pending', needsAtsResolution: true };
  t.eq(autonomousApplyFilter([pendingLead], true), [pendingLead],
    'source-run: unresolved browser offsite lead stays in corpus for later routing resolution');
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
};
