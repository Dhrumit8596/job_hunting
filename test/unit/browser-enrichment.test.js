'use strict';

const Enrichment = require('../../sourcing/browser-enrichment');

module.exports = async t => {
  const lead = { id: 'li-1', company: 'Acme', title: 'Process Engineer', location: 'Fremont, CA',
    applyUrl: 'https://www.linkedin.com/jobs/view/1/', needsAtsResolution: true,
    matchedQueries: ['process engineer'] };
  const official = { id: 'gh-1', company: 'Acme', title: 'Process Engineer', location: 'Fremont, CA',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1', description: 'Official requirements.',
    descriptionStatus: 'full' };
  const exact = Enrichment.resolveAgainstOfficial([lead], [official]);
  t.eq({ resolved: exact.resolved, url: exact.jobs[0].applyUrl, method: exact.jobs[0].resolutionMethod,
    query: exact.jobs[0].matchedQueries[0] }, { resolved: 1, url: official.applyUrl,
    method: 'official_exact_company_title_location', query: 'process engineer' },
  'browser resolution: unique exact official identity resolves route while preserving query provenance');
  const ambiguous = Enrichment.resolveAgainstOfficial([lead], [official, { ...official, id: 'gh-2',
    applyUrl: 'https://jobs.lever.co/acme/2' }]);
  t.eq({ ambiguous: ambiguous.ambiguous, url: ambiguous.jobs[0].applyUrl },
    { ambiguous: 1, url: lead.applyUrl },
  'browser resolution: ambiguous same-identity official records remain unresolved');
  t.eq(Enrichment.resolveAgainstOfficial([lead], []).noMatch, 1,
    'browser resolution: no match remains explicit');
  t.eq(Enrichment.resolveAgainstOfficial([{ ...lead, location: '' }], [official]).identityMismatch, 1,
    'browser resolution: incomplete identity cannot attach a same-title job');
  const decorated = Enrichment.resolveAgainstOfficial([
    { ...lead, location: 'Fremont, CA (On-site)' },
  ], [{ ...official, location: 'Fremont, California, United States' }]);
  t.eq({ resolved: decorated.resolved, url: decorated.jobs[0].applyUrl },
    { resolved: 1, url: official.applyUrl },
  'browser resolution: presentation-only work-mode, state, and country suffixes normalize to the unique official identity');
  t.eq(Enrichment.resolveAgainstOfficial([{ ...lead, location: 'San Jose, CA (On-site)' }],
    [{ ...official, location: 'Fremont, CA, United States' }]).noMatch, 1,
  'browser resolution: normalization never merges distinct cities');
  const decoratedAmbiguous = Enrichment.resolveAgainstOfficial([
    { ...lead, location: 'Fremont, CA (Hybrid)' },
  ], [{ ...official, location: 'Fremont, California, United States' },
    { ...official, id: 'gh-2', location: 'Fremont, CA', applyUrl: 'https://jobs.lever.co/acme/2' }]);
  t.eq(decoratedAmbiguous.ambiguous, 1,
    'browser resolution: multiple presentation-compatible official requisitions remain unresolved');
  const suffixAlias = Enrichment.resolveAgainstOfficial([
    { ...lead, company: 'Penumbra, Inc.' },
  ], [{ ...official, company: 'Penumbra' }]);
  t.eq({ resolved: suffixAlias.resolved, method: suffixAlias.jobs[0].resolutionMethod },
    { resolved: 1, method: 'official_unique_company_alias_title_location' },
  'browser resolution: a unique legal-suffix company alias resolves only with exact title and location');
  const attestedAlias = Enrichment.resolveAgainstOfficial([
    { ...lead, company: 'Shockwave Medical', title: 'Supplier Quality Engineer II', location: 'Santa Clara, CA' },
  ], [{ ...official, company: 'Johnson & Johnson', title: 'Supplier Quality Engineer II',
    location: 'Santa Clara, California, United States', sourceAliases: ['Shockwave Medical'],
    applyUrl: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/x_R-086504' }]);
  t.eq({ resolved: attestedAlias.resolved, method: attestedAlias.jobs[0].resolutionMethod },
    { resolved: 1, method: 'official_unique_company_alias_title_location' },
  'browser resolution: an explicit source alias resolves a unique exact-title exact-location official posting');
  const aliasWrongCity = Enrichment.resolveAgainstOfficial([
    { ...lead, company: 'Shockwave Medical', title: 'Supplier Quality Engineer II', location: 'San Jose, CA' },
  ], [{ ...official, company: 'Johnson & Johnson', title: 'Supplier Quality Engineer II',
    location: 'Santa Clara, CA', sourceAliases: ['Shockwave Medical'] }]);
  t.eq(aliasWrongCity.noMatch, 1,
    'browser resolution: an employer alias never relaxes exact location compatibility');
  const staleBrowserJd = Enrichment.resolveAgainstOfficial([
    { ...lead, description: 'Old browser description.', descriptionStatus: 'stale' },
  ], [{ ...official, description: 'Current official requirements.', descriptionStatus: 'complete',
    hydratedAt: '2026-08-19T12:00:00Z' }]);
  t.eq({ description: staleBrowserJd.jobs[0].description,
    status: staleBrowserJd.jobs[0].descriptionStatus,
    method: staleBrowserJd.jobs[0].hydrationMethod },
  { description: 'Current official requirements.', status: 'complete', method: 'official_record_merge' },
  'browser resolution: a stale browser JD cannot override the current official posting evidence');

  const now = Date.parse('2026-08-19T12:00:00Z');
  const routeOnly = { ...lead, id: 'route-only', sourcePlatform: 'linkedin', channel: 'external',
    description: 'Complete process requirements.', descriptionStatus: 'full', lastSeenAt: now - 1000 };
  const assistedMissing = { ...lead, id: 'assisted', sourcePlatform: 'linkedin', channel: 'linkedin_easy_apply',
    isEasyApply: true, needsAtsResolution: false, description: '', descriptionStatus: 'missing', lastSeenAt: now - 1000 };
  const readyFull = { ...official, id: 'ready-full', sourcePlatform: 'linkedin', channel: 'external',
    needsAtsResolution: false, description: 'Complete requirements.', descriptionStatus: 'full', lastSeenAt: now - 1000 };
  const frontier = Enrichment.selectHydrationFrontier([assistedMissing, readyFull, routeOnly], {
    limit: 20, freshAfter: now - 86400000 });
  t.eq(frontier.map(row => row.id), ['assisted', 'route-only'],
    'browser enrichment: independent missing-JD and unresolved-route lanes both retain capacity');
  const lanes = Enrichment.selectHydrationFrontier([
    ...Array.from({ length: 4 }, (_, i) => ({ ...routeOnly, id: 'full-route-' + i })),
    ...Array.from({ length: 4 }, (_, i) => ({ ...assistedMissing, id: 'missing-jd-' + i })),
  ], { limit: 4, freshAfter: now - 86400000, now });
  t.eq({ total: lanes.length,
    missing: lanes.filter(row => !row.description).length,
    routes: lanes.filter(row => row.needsAtsResolution).length },
  { total: 4, missing: 2, routes: 2 },
  'browser enrichment: a bounded frontier reserves half its capacity for each independent supply lane');
  const cooled = { ...routeOnly, id: 'cooled', fitScore: 99, routeResolutionStatus: 'unresolved',
    routeResolutionAttemptedAt: now - 1000 };
  const untouched = { ...routeOnly, id: 'untouched', fitScore: 75 };
  t.eq(Enrichment.selectHydrationFrontier([cooled, untouched], {
    limit: 1, freshAfter: now - 86400000, now, routeRetryCooldownMs: 3600000 })[0].id, 'untouched',
  'browser enrichment: recent null route results back off so untouched leads can enter the next bounded pass');
  t.eq(Enrichment.selectHydrationFrontier([cooled], {
    limit: 10, freshAfter: now - 86400000, now, routeRetryCooldownMs: 3600000 }), [],
  'browser enrichment: a recently unresolved route is excluded, not merely deprioritized into an undersized frontier');
  const hydrationCooled = { ...assistedMissing, id: 'hydration-cooled',
    hydrationStatus: 'hydration_no_progress', hydrationAttemptedAt: now - 1000 };
  t.eq(Enrichment.selectHydrationFrontier([hydrationCooled], {
    limit: 10, freshAfter: now - 86400000, now, hydrationRetryCooldownMs: 3600000 }), [],
  'browser enrichment: a recent missing-JD null result also receives a bounded retry cooldown');
  t.eq(Enrichment.selectHydrationFrontier([untouched], { limit: 0, now }), [],
    'browser enrichment: an explicit zero limit performs no enrichment work');
  const bounded = Enrichment.selectHydrationFrontier(Array.from({ length: 60 }, (_, i) => ({
    ...routeOnly, id: 'route-' + i })), { limit: 100, freshAfter: now - 86400000 });
  t.eq(bounded.length, 50, 'browser enrichment: route-resolution frontier retains its hard fifty-row cap');

  let guarded = 0;
  const owned = await Enrichment.runOwnedEnrichment(async () => ({ hydrated: 1 }), {
    deadlineMs: Date.now() + 1000, guard: async () => ({ ok: ++guarded <= 2, code: 'source_ownership_lost' }) });
  t.eq({ ok: owned.ok, hydrated: owned.result.hydrated, guards: guarded }, { ok: true, hydrated: 1, guards: 2 },
    'browser enrichment: normally owned work completes only after pre-persist guard');
  const lost = await Enrichment.runOwnedEnrichment(async () => ({ hydrated: 1 }), {
    deadlineMs: Date.now() + 1000, guard: async stage => ({ ok: stage !== 'before_browser_enrichment_persist',
      code: 'source_ownership_lost' }) });
  t.eq({ ok: lost.ok, error: lost.error }, { ok: false, error: 'source_ownership_lost' },
    'browser enrichment: ownership loss immediately before persistence prevents mutation');
  const timed = await Enrichment.runOwnedEnrichment(() => new Promise(resolve => setTimeout(resolve, 20)), {
    deadlineMs: Date.now() + 2, guard: async () => ({ ok: true }) });
  t.eq({ ok: timed.ok, error: timed.error }, { ok: false, error: 'sourcing_deadline_exceeded' },
    'browser enrichment: timeout is explicit and bounded');
};
