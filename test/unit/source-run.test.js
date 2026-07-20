'use strict';

const { sourceAll } = require('../../sourcing/source-run');
const { makeJob } = require('../../sourcing/normalize');

module.exports = async (t) => {
  const discoveryAdapters = {
    mock: {
      async fetchJobs() {
        return [makeJob({ id: 'ats-1', title: 'Process Engineer', company: 'Acme',
          location: 'Fremont, CA', ats: 'greenhouse',
          applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/ats-1',
          description: 'Short requirements.' })];
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

  const { store, report } = await sourceAll({ sources: [], discoveryAdapters, browserJobs, target: 1 });
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
  const states = Object.values(store.state);
  t.eq(states.every(s => s.scoreKind === 'heuristic' && !!s.descriptionFingerprint), true,
    'source-run: source scores are marked heuristic with JD fingerprint');
};
