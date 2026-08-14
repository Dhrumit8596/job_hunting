'use strict';

// Browser discovery -> normalized corpus boundary. Synthetic records only.
const {
  detectBrowserPlatform,
  normalizeBrowserJob,
  normalizeBrowserJobs,
  browserSourceKey,
} = require('../../sourcing/browser-import');

module.exports = (t) => {
  const linkedInRaw = {
    id: '4430362420',
    url: 'https://www.linkedin.com/jobs/view/4430362420/?trk=jobs_jserp',
    title: '  Wafer   Inspection Engineer ',
    company: 'KLA',
    location: 'Milpitas, CA',
    isEasyApply: true,
    description: '<p>Wafer inspection, defect detection, and SPC.</p>',
    query: 'wafer inspection engineer',
    scrapedAt: 12345,
  };
  const before = JSON.stringify(linkedInRaw);
  const li = normalizeBrowserJob(linkedInRaw);
  t.eq(JSON.stringify(linkedInRaw), before, 'browser-import: input is not mutated');
  t.eq(li.id, '4430362420', 'browser-import: LinkedIn stable source id');
  t.eq(li.sourceJobId, '4430362420', 'browser-import: LinkedIn sourceJobId explicit');
  t.eq(li.sourcePlatform, 'linkedin', 'browser-import: LinkedIn platform inferred from listing URL');
  t.eq(li.ats, 'linkedin', 'browser-import: source namespace is LinkedIn');
  t.eq(li.channel, 'linkedin_easy_apply', 'browser-import: LinkedIn Easy Apply channel');
  t.eq(li.applyUrl, 'https://www.linkedin.com/jobs/view/4430362420/', 'browser-import: Easy Apply opens canonical listing');
  t.eq(li.listingUrl, li.applyUrl, 'browser-import: LinkedIn listing URL canonical');
  t.eq(li.description, 'Wafer inspection, defect detection, and SPC.', 'browser-import: HTML description cleaned');
  t.eq(li.descriptionStatus, 'full', 'browser-import: populated description marked full');
  t.eq(li.hydrationStatus, 'hydration_success', 'browser-import: populated description marks hydration success');
  t.eq(li.hydrationMethod, 'linkedin_detail_panel', 'browser-import: LinkedIn description defaults to detail-panel hydration');
  t.eq(li.pipelineStatus, 'score_pending', 'browser-import: hydrated browser job enters score_pending');
  t.eq(li.query, 'wafer inspection engineer', 'browser-import: query retained');
  t.eq(li.discoveredAt, 12345, 'browser-import: scrape time becomes discoveredAt');
  t.eq(li.sourceRefs.length, 1, 'browser-import: one provenance source ref');
  t.eq(li.sourceRefs[0].sourcePlatform, 'linkedin', 'browser-import: source ref platform');
  t.eq(li.sourceRefs[0].hydrationStatus, 'hydration_success', 'browser-import: source ref carries hydration status');
  t.eq(li.provenance.modality, 'browser-linkedin', 'browser-import: modality retained in provenance');

  const longDescription = 'x'.repeat(20100);
  const liExternal = normalizeBrowserJob({
    sourcePlatform: 'linkedin',
    jobId: '9988',
    listingUrl: 'https://www.linkedin.com/jobs/view/9988/',
    externalApplyUrl: 'https://job-boards.greenhouse.io/acme/jobs/77?utm_source=linkedin',
    title: 'Process Engineer', company: 'Acme', location: 'San Jose, CA',
    description: longDescription,
  });
  t.eq(liExternal.channel, 'external', 'browser-import: LinkedIn offsite job routes external');
  t.eq(liExternal.applyUrl, 'https://job-boards.greenhouse.io/acme/jobs/77', 'browser-import: direct ATS URL preferred and tracking stripped');
  t.eq(liExternal.detectedAts, 'greenhouse', 'browser-import: direct ATS detected');
  t.eq(liExternal.description.length, 20000, 'browser-import: description capped at 20k');
  t.eq(liExternal.descriptionStatus, 'partial', 'browser-import: capped description marked partial');

  const indeed = normalizeBrowserJob({
    platform: 'indeed', jobId: 'abc-123',
    applyUrl: 'https://www.indeed.com/viewjob?jk=abc-123&from=serp',
    title: 'Manufacturing Engineer', company: 'Medical Co', location: 'Irvine, CA',
    indeedApply: true, description: '', searchQuery: 'manufacturing engineer',
    hydrationStatus: 'hydration_deferred_fast_scan', hydrationMethod: 'indeed_fast_card_scan',
    hydrationReason: 'fast_scan_skipped_detail',
  });
  t.eq(indeed.id, 'abc-123', 'browser-import: Indeed stable job key');
  t.eq(indeed.channel, 'indeed_apply', 'browser-import: Indeed Apply channel');
  t.eq(indeed.listingUrl, 'https://www.indeed.com/viewjob?jk=abc-123', 'browser-import: Indeed canonical listing URL');
  t.eq(indeed.applyUrl, indeed.listingUrl, 'browser-import: Indeed Apply opens listing');
  t.eq(indeed.descriptionStatus, 'missing', 'browser-import: empty Indeed description marked missing');
  t.eq(indeed.hydrationStatus, 'hydration_deferred_fast_scan', 'browser-import: explicit missing-description hydration status retained');
  t.eq(indeed.hydrationReason, 'fast_scan_skipped_detail', 'browser-import: hydration reason retained for diagnostics');
  t.eq(indeed.pipelineStatus, 'needs_hydration', 'browser-import: card-only browser lead must hydrate before scoring');
  t.eq(indeed.indeedApply, true, 'browser-import: compatibility Indeed flag retained');

  const indeedExternal = normalizeBrowserJob({
    url: 'https://www.indeed.com/viewjob?jk=outside-9',
    externalApplyUrl: 'https://jobs.lever.co/acme/uuid/apply',
    title: 'Quality Engineer', company: 'Acme', location: 'Remote - US',
  });
  t.eq(indeedExternal.sourcePlatform, 'indeed', 'browser-import: Indeed inferred from URL');
  t.eq(indeedExternal.id, 'outside-9', 'browser-import: Indeed id extracted from URL');
  t.eq(indeedExternal.channel, 'external', 'browser-import: Indeed offsite job routes external');
  t.eq(indeedExternal.detectedAts, 'lever', 'browser-import: Indeed offsite ATS detected');

  const glassdoor = normalizeBrowserJob({
    url: 'https://www.glassdoor.com/job-listing/process-engineer-acme-JV.htm?jobListingId=100234&src=GD_JOB_AD',
    directApplyUrl: 'https://jobs.ashbyhq.com/acme/uuid/application',
    title: 'Process Engineer', companyName: 'Acme', location: 'Fremont, CA',
    description: 'Own process control and root-cause investigations.',
    discoveredAt: '2026-07-19T12:00:00Z',
  });
  t.eq(glassdoor.id, '100234', 'browser-import: Glassdoor id extracted from jobListingId');
  t.eq(glassdoor.sourcePlatform, 'glassdoor', 'browser-import: Glassdoor inferred from URL');
  t.eq(glassdoor.channel, 'external', 'browser-import: Glassdoor always external by default');
  t.eq(glassdoor.detectedAts, 'ashby', 'browser-import: Glassdoor destination ATS detected');
  t.eq(glassdoor.listingUrl, 'https://www.glassdoor.com/job-listing/process-engineer-acme-JV.htm?jobListingId=100234', 'browser-import: Glassdoor listing tracking stripped');
  t.eq(browserSourceKey(glassdoor), 'glassdoor:100234', 'browser-import: stable namespaced source key');

  const urlOnly = normalizeBrowserJob({
    sourcePlatform: 'glassdoor',
    url: 'https://www.glassdoor.com/job-listing/metrology-engineer-acme-JV.htm?utm_source=x',
    title: 'Metrology Engineer', company: 'Acme', location: 'Santa Clara, CA',
  });
  t.ok(urlOnly.id.startsWith('url:https://www.glassdoor.com/job-listing/metrology-engineer-acme-JV.htm'), 'browser-import: URL fallback is deterministic when Glassdoor omits id');
  t.eq(normalizeBrowserJob({ title: 'No source' }), null, 'browser-import: unsupported record rejected');
  t.eq(normalizeBrowserJob({ platform: 'linkedin', title: 'No stable identity' }), null, 'browser-import: source without stable identity rejected');

  t.eq(detectBrowserPlatform({ sourcePlatform: 'browser-linkedin' }), 'linkedin', 'browser-import: browser-prefixed platform accepted');
  const batch = normalizeBrowserJobs([linkedInRaw, null, { title: 'No source' }, {
    platform: 'indeed', id: 'z1', title: 'Equipment Engineer', company: 'Z', location: 'Austin, TX',
  }], { discoveredAt: 999 });
  t.eq(batch.length, 2, 'browser-import: batch filters invalid rows');
  t.eq(batch[1].discoveredAt, 999, 'browser-import: caller-supplied discovery time used deterministically');
};
