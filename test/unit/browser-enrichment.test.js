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
