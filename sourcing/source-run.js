'use strict';
// Multi-modal source run: Modality A (API registry, per-company slugs) + Modality B (discovery,
// keyword search across employers) -> one normalized, deduped, pre-scored job store. Prints the
// "Find 200+" gate report. Runnable standalone (`node sourcing/source-run.js`) and importable so
// the dev server can call it. LLM scoring is layered on top later; this uses the cheap pre-score
// so every job carries a fitScore immediately.
const path = require('path');
const { fetchAll } = require('./pipeline');
const { DISCOVERY } = require('./adapters');
const { filterJobs } = require('./filter');
const { prescore } = require('./prescore');
const { createStore, upsert, excludeApplied, gateReport, descriptionFingerprint } = require('./jobstore');
const { normalizeBrowserJobs } = require('./browser-import');
const { detectAts } = require('./detect-ats');

const AUTONOMOUS_UNSUPPORTED_ATS = new Set(['eightfold', 'successfactors', 'jobicy', 'remotive']);
const AUTONOMOUS_SUPPORTED_STRATEGIES = new Set([
  'linkedin_ea', 'indeed', 'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters',
  'workable', 'breezy', 'bamboohr', 'paylocity', 'rippling', 'jobvite', 'generic',
]);

const DEFAULT_QUERIES = [
  'quality engineer', 'process engineer', 'manufacturing engineer',
  'metrology', 'wafer', 'test engineer', 'reliability engineer',
  'equipment engineer', 'process development', 'failure analysis',
  'manufacturing quality engineer', 'supplier quality engineer',
  'semiconductor process engineer', 'semiconductor quality engineer',
  'medical device quality engineer', 'validation engineer',
  'process integration engineer', 'wafer process engineer',
  'thin film process engineer', 'yield engineer',
];

function hydrationSummaryByChannel(jobs) {
  const byChannel = {};
  const overallStatuses = {};
  for (const job of jobs || []) {
    const channel = job.channel || 'external';
    const bucket = byChannel[channel] || {
      found: 0,
      hydrated: 0,
      missing: 0,
      deferredFast: 0,
      timeout: 0,
      blockedAuth: 0,
      unknown: 0,
      statuses: {},
      reasons: {},
    };
    bucket.found++;
    const status = String(job.hydrationStatus || (job.description ? 'hydration_success' : 'hydration_missing_dom'));
    bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
    overallStatuses[status] = (overallStatuses[status] || 0) + 1;
    const reason = String(job.hydrationReason || '').trim();
    if (reason) bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1;
    if (job.description && /^(full|partial)$/i.test(String(job.descriptionStatus || ''))) bucket.hydrated++;
    else if (status === 'hydration_deferred_fast_scan') bucket.deferredFast++;
    else if (status === 'hydration_timeout') bucket.timeout++;
    else if (status === 'hydration_blocked_auth') bucket.blockedAuth++;
    else if (/missing/.test(status) || /^(missing|stale)$/i.test(String(job.descriptionStatus || ''))) bucket.missing++;
    else bucket.unknown++;
    byChannel[channel] = bucket;
  }
  return { byChannel, overallStatuses };
}

function postingAgeDays(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/posted\s+today/i.test(text)) return 0;
  if (/posted\s+yesterday/i.test(text)) return 1;
  const relative = text.match(/posted\s+(\d+)(\+)?\s+days?\s+ago/i);
  if (relative) return Number(relative[1]) + (relative[2] ? 1 : 0);
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Number(now) - ts) / (24 * 60 * 60 * 1000)));
}

function qualitySummary(store, sourcingReport, opts = {}) {
  const ids = Object.keys(store && store.index || {});
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const byAts = {};
  let descriptionReady = 0, supported = 0, knownFreshness = 0, fresh7d = 0, fresh30d = 0, older30d = 0;
  const missingDescriptionExamples = [];
  for (const id of ids) {
    const job = store.index[id] || {};
    const ats = String(job.detectedAts || job.ats || autonomousApplyStrategy(job) || 'unknown').toLowerCase();
    byAts[ats] = (byAts[ats] || 0) + 1;
    if (job.description && !/^(missing|stale|needs_description)$/i.test(String(job.descriptionStatus || ''))) descriptionReady++;
    else if (missingDescriptionExamples.length < 12) missingDescriptionExamples.push({
      id, company: job.company || '', title: job.title || '', ats,
      descriptionStatus: job.descriptionStatus || 'needs_description',
    });
    if (AUTONOMOUS_SUPPORTED_STRATEGIES.has(autonomousApplyStrategy(job))) supported++;
    const age = postingAgeDays(job.postedAt || job.discoveredAt, now);
    if (age == null) continue;
    knownFreshness++;
    if (age <= 7) fresh7d++;
    if (age <= 30) fresh30d++;
    else older30d++;
  }
  const duplicateMerges = ['modalityA', 'modalityB', 'modalityC'].reduce((sum, key) => {
    const row = sourcingReport && sourcingReport[key] || {};
    return sum + Number(row.dupById || 0) + Number(row.dupByRole || 0);
  }, 0);
  const inputEligible = Number(sourcingReport && sourcingReport.modalityA && sourcingReport.modalityA.eligible || 0) +
    Number(sourcingReport && sourcingReport.modalityB && sourcingReport.modalityB.eligible || 0) +
    Number(sourcingReport && sourcingReport.modalityC && sourcingReport.modalityC.eligible || 0);
  const ratio = n => ids.length ? Number((n / ids.length).toFixed(4)) : 0;
  return {
    total: ids.length,
    freshness: { known: knownFreshness, unknown: ids.length - knownFreshness, fresh7d, fresh30d, older30d,
      fresh30dRate: knownFreshness ? Number((fresh30d / knownFreshness).toFixed(4)) : 0 },
    descriptions: { ready: descriptionReady, missing: ids.length - descriptionReady,
      coverage: ratio(descriptionReady), examples: missingDescriptionExamples },
    supportedAts: { ready: supported, unsupported: ids.length - supported, coverage: ratio(supported), byAts },
    deduplication: { inputEligible, duplicateMerges, excludedApplied: Number(sourcingReport && sourcingReport.excludedApplied || 0),
      uniqueAfterApplied: ids.length, mergeRate: inputEligible ? Number((duplicateMerges / inputEligible).toFixed(4)) : 0 },
    fitYield: { kind: 'heuristic_priority_only', candidatesAt70: ids.filter(id => Number(store.state[id] && store.state[id].fitScore || 0) >= 70).length,
      note: 'Genuine fit is measured only after evidence-grounded scoring; sourcing does not label title heuristics as qualified.' },
  };
}

function isAggregatorHost(url) {
  try { return /(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(new URL(String(url || '')).hostname); }
  catch (_) { return false; }
}

function autonomousApplyStrategy(job) {
  const channel = String(job && job.channel || '').toLowerCase();
  if (channel === 'linkedin_easy_apply' || job && job.isEasyApply === true) return 'linkedin_ea';
  if (channel === 'indeed_apply' || job && job.indeedApply === true) return 'indeed';
  const strategy = String(detectAts(job && job.applyUrl) || job && job.detectedAts || job && job.ats || '').toLowerCase();
  if (isAggregatorHost(job && job.applyUrl) && !detectAts(job && job.applyUrl)) return '';
  return strategy || 'generic';
}

function autonomousApplyFilter(jobs, enabled) {
  if (!enabled) return jobs;
  return (jobs || []).filter(job => {
    const ats = String(job && job.ats || '').toLowerCase();
    const strategy = autonomousApplyStrategy(job);
    if (!strategy || AUTONOMOUS_UNSUPPORTED_ATS.has(ats) || AUTONOMOUS_UNSUPPORTED_ATS.has(strategy)) return false;
    return AUTONOMOUS_SUPPORTED_STRATEGIES.has(strategy);
  });
}

async function sourceAll(opts = {}) {
  const sources = opts.sources || require('./sources.json').sources;
  const queries = opts.queries || DEFAULT_QUERIES;
  const applied = opts.appliedIdentity || opts.appliedRoleKeys || [];
  const store = createStore();
  const stateFor = j => ({ fitScore: prescore(j), scoreKind: 'heuristic',
    descriptionFingerprint: descriptionFingerprint(j.description) });
  const report = { modalityA: {}, modalityB: {} };

  // --- Modality A: API registry ---
  const a = await fetchAll(sources, { concurrency: opts.concurrency || 8, timeoutMs: 12000,
    queries, nationwideUS: opts.nationwideUS === true,
    targetLocation: opts.targetLocation, targetRadiusMiles: opts.targetRadiusMiles,
    locationStrictness: opts.locationStrictness, remotePolicy: opts.remotePolicy });
  const filterOpts = { nationwideUS: opts.nationwideUS === true,
    targetLocation: opts.targetLocation, targetRadiusMiles: opts.targetRadiusMiles,
    locationStrictness: opts.locationStrictness, remotePolicy: opts.remotePolicy };
  const aEligible = autonomousApplyFilter(filterJobs(a.jobs, filterOpts), opts.autonomousApplyOnly === true);
  const aRes = upsert(store, aEligible, 'api-registry', stateFor);
  report.modalityA = { fetched: a.jobs.length, eligible: aEligible.length, added: aRes.added,
    dupById: aRes.dupById, dupByRole: aRes.dupByRole, enriched: aRes.enriched,
    deadSources: a.stats.filter(s => s.count === 0).length };

  // --- Modality B: discovery (keyword search) ---
  let bFetched = 0, bEligible = 0;
  const discoveryAdapters = opts.discoveryAdapters || DISCOVERY;
  let bAdded = 0, bEnriched = 0, bDupById = 0, bDupByRole = 0;
  const target = opts.targetLocation && typeof opts.targetLocation === 'object' ? opts.targetLocation : {};
  const locationQuery = [target.city, target.state].filter(Boolean).join(', ') || target.label || target.zip || undefined;
  for (const name of Object.keys(discoveryAdapters)) {
    const jobs = await discoveryAdapters[name].fetchJobs(null, { queries, timeoutMs: 15000,
      locationQuery, targetRadiusMiles: opts.targetRadiusMiles });
    bFetched += jobs.length;
    const elig = autonomousApplyFilter(filterJobs(jobs, filterOpts), opts.autonomousApplyOnly === true);
    bEligible += elig.length;
    const r = upsert(store, elig, 'discovery-' + name, stateFor);
    bAdded += r.added; bEnriched += r.enriched;
    bDupById += r.dupById; bDupByRole += r.dupByRole;
  }
  report.modalityB = { fetched: bFetched, eligible: bEligible, added: bAdded, enriched: bEnriched,
    dupById: bDupById, dupByRole: bDupByRole };

  // --- Modality C: browser captures (LinkedIn / Indeed / Glassdoor) ---
  // Their content scripts write normalized-enough records into pja_shortlist. Folding them into
  // the same corpus makes source-v2—not a separate legacy list—the ranking source of truth.
  const allCaptured = normalizeBrowserJobs(opts.browserJobs || []);
  const browserNow = opts.now != null ? Number(opts.now) : Date.now();
  const browserMaxAge = opts.maxBrowserAgeMs != null ? Number(opts.maxBrowserAgeMs) : null;
  const captured = allCaptured.filter(j => {
    if (browserMaxAge == null) return true;
    const seen = typeof j.discoveredAt === 'number' ? j.discoveredAt : Date.parse(j.discoveredAt || '');
    return Number.isFinite(seen) && browserNow - seen <= browserMaxAge;
  })
    .filter(j => j.id && j.title && j.company && j.applyUrl);
  const cEligible = autonomousApplyFilter(filterJobs(captured, filterOpts), opts.autonomousApplyOnly === true);
  const hydrationSummary = hydrationSummaryByChannel(cEligible);
  const groups = {};
  for (const job of cEligible) (groups[job.modality] = groups[job.modality] || []).push(job);
  const cRes = { added: 0, dupById: 0, dupByRole: 0, enriched: 0 };
  for (const modality of Object.keys(groups)) {
    const r = upsert(store, groups[modality], modality, stateFor);
    for (const k of Object.keys(cRes)) cRes[k] += r[k] || 0;
  }
  report.modalityC = { fetched: captured.length, staleExcluded: allCaptured.length - captured.length,
    eligible: cEligible.length,
    withDescription: cEligible.filter(j => j.description).length,
    needsDescription: cEligible.filter(j => !j.description || j.descriptionStatus === 'missing' || j.descriptionStatus === 'stale').length,
    channelHydration: hydrationSummary.byChannel,
    hydrationStatuses: hydrationSummary.overallStatuses,
    added: cRes.added, enriched: cRes.enriched, dupById: cRes.dupById, dupByRole: cRes.dupByRole };

  // --- exclude already-applied, then gate ---
  const removed = excludeApplied(store, applied);
  report.excludedApplied = removed;
  report.gate = gateReport(store, { target: opts.target || 200 });
  report.quality = qualitySummary(store, report, { now: opts.now });
  return { store, report };
}

// Pretty-print for CLI runs.
function printReport(report) {
  const g = report.gate;
  console.log('\n=== SOURCE RUN ===');
  console.log('Modality A (api-registry):', JSON.stringify(report.modalityA));
  console.log('Modality B (discovery)   :', JSON.stringify(report.modalityB));
  console.log('Modality C (browser)     :', JSON.stringify(report.modalityC));
  console.log('excluded already-applied :', report.excludedApplied);
  console.log('quality metrics          :', JSON.stringify(report.quality));
  console.log('\n--- GATE: Find 200+ ---');
  console.log('  unique job ids      :', g.uniqueIds, g.atLeastTarget ? '✅ (>=200)' : '❌ (<200)');
  console.log('  source classes      :', g.sourceClasses.join(', '), g.atLeast2Modalities ? '✅ (>=2)' : '❌');
  console.log('  descriptions ready  :', g.descriptionReady + '/' + g.uniqueIds, g.descriptionsReady ? '✅' : '❌');
  console.log('  heuristic prescored :', g.allScored ? '✅' : '❌', '(LLM evidence-ready:', g.evidenceReady + ')');
  console.log('  max company share   :', (g.maxCompanyShare * 100).toFixed(1) + '%', g.concentrationOk ? '✅ (<=25%)' : '❌ (>25%)', '— ' + g.biggestCompany);
  console.log('\n  GATE ' + (g.pass ? '✅ PASS' : '❌ FAIL'));
}

if (require.main === module) {
  sourceAll({}).then(({ report }) => { printReport(report); })
    .catch(e => { console.error('source-run failed:', e); process.exit(1); });
}

module.exports = { sourceAll, printReport, normalizeBrowserJob: require('./browser-import').normalizeBrowserJob,
  DEFAULT_QUERIES, postingAgeDays, qualitySummary };
