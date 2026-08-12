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

const DEFAULT_QUERIES = [
  'quality engineer', 'process engineer', 'manufacturing engineer',
  'metrology', 'wafer', 'test engineer', 'reliability engineer',
  'equipment engineer', 'process development', 'failure analysis',
];

async function sourceAll(opts = {}) {
  const sources = opts.sources || require('./sources.json').sources;
  const queries = opts.queries || DEFAULT_QUERIES;
  const applied = opts.appliedIdentity || opts.appliedRoleKeys || [];
  const store = createStore();
  const stateFor = j => ({ fitScore: prescore(j), scoreKind: 'heuristic',
    descriptionFingerprint: descriptionFingerprint(j.description) });
  const report = { modalityA: {}, modalityB: {} };

  // --- Modality A: API registry ---
  const a = await fetchAll(sources, { concurrency: opts.concurrency || 8, timeoutMs: 12000 });
  const filterOpts = { nationwideUS: opts.nationwideUS === true,
    targetLocation: opts.targetLocation, targetRadiusMiles: opts.targetRadiusMiles,
    locationStrictness: opts.locationStrictness, remotePolicy: opts.remotePolicy };
  const aEligible = filterJobs(a.jobs, filterOpts);
  const aRes = upsert(store, aEligible, 'api-registry', stateFor);
  report.modalityA = { fetched: a.jobs.length, eligible: aEligible.length, added: aRes.added,
    dupById: aRes.dupById, dupByRole: aRes.dupByRole, enriched: aRes.enriched,
    deadSources: a.stats.filter(s => s.count === 0).length };

  // --- Modality B: discovery (keyword search) ---
  let bFetched = 0, bEligible = 0;
  const discoveryAdapters = opts.discoveryAdapters || DISCOVERY;
  let bAdded = 0, bEnriched = 0;
  const target = opts.targetLocation && typeof opts.targetLocation === 'object' ? opts.targetLocation : {};
  const locationQuery = [target.city, target.state].filter(Boolean).join(', ') || target.label || target.zip || undefined;
  for (const name of Object.keys(discoveryAdapters)) {
    const jobs = await discoveryAdapters[name].fetchJobs(null, { queries, timeoutMs: 15000,
      locationQuery, targetRadiusMiles: opts.targetRadiusMiles });
    bFetched += jobs.length;
    const elig = filterJobs(jobs, filterOpts);
    bEligible += elig.length;
    const r = upsert(store, elig, 'discovery-' + name, stateFor);
    bAdded += r.added; bEnriched += r.enriched;
  }
  report.modalityB = { fetched: bFetched, eligible: bEligible, added: bAdded, enriched: bEnriched };

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
  const cEligible = filterJobs(captured, filterOpts);
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
    added: cRes.added, enriched: cRes.enriched, dupById: cRes.dupById, dupByRole: cRes.dupByRole };

  // --- exclude already-applied, then gate ---
  const removed = excludeApplied(store, applied);
  report.excludedApplied = removed;
  report.gate = gateReport(store, { target: opts.target || 200 });
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

module.exports = { sourceAll, printReport, normalizeBrowserJob: require('./browser-import').normalizeBrowserJob, DEFAULT_QUERIES };
