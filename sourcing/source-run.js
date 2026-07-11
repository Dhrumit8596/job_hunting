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
const { createStore, upsert, excludeApplied, gateReport } = require('./jobstore');

const DEFAULT_QUERIES = [
  'quality engineer', 'process engineer', 'manufacturing engineer',
  'metrology', 'wafer', 'test engineer', 'reliability engineer',
  'equipment engineer', 'process development', 'failure analysis',
];

async function sourceAll(opts = {}) {
  const sources = opts.sources || require('./sources.json').sources;
  const queries = opts.queries || DEFAULT_QUERIES;
  const appliedRoleKeys = opts.appliedRoleKeys || [];
  const store = createStore();
  const stateFor = j => ({ fitScore: prescore(j) });
  const report = { modalityA: {}, modalityB: {} };

  // --- Modality A: API registry ---
  const a = await fetchAll(sources, { concurrency: opts.concurrency || 8, timeoutMs: 12000 });
  const aEligible = filterJobs(a.jobs, {});
  const aRes = upsert(store, aEligible, 'api-registry', stateFor);
  report.modalityA = { fetched: a.jobs.length, eligible: aEligible.length, added: aRes.added,
    dupById: aRes.dupById, dupByRole: aRes.dupByRole,
    deadSources: a.stats.filter(s => s.count === 0).length };

  // --- Modality B: discovery (keyword search) ---
  let bFetched = 0, bEligible = 0;
  for (const name of Object.keys(DISCOVERY)) {
    const jobs = await DISCOVERY[name].fetchJobs(null, { queries, timeoutMs: 15000 });
    bFetched += jobs.length;
    const elig = filterJobs(jobs, {});
    bEligible += elig.length;
    upsert(store, elig, 'discovery', stateFor);
  }
  report.modalityB = { fetched: bFetched, eligible: bEligible };

  // --- exclude already-applied, then gate ---
  const removed = excludeApplied(store, appliedRoleKeys);
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
  console.log('excluded already-applied :', report.excludedApplied);
  console.log('\n--- GATE: Find 200+ ---');
  console.log('  unique job ids      :', g.uniqueIds, g.atLeastTarget ? '✅ (>=200)' : '❌ (<200)');
  console.log('  modalities          :', g.modalities.join(', '), g.atLeast2Modalities ? '✅ (>=2)' : '❌');
  console.log('  all fit-scored      :', g.allScored ? '✅' : '❌');
  console.log('  max company share   :', (g.maxCompanyShare * 100).toFixed(1) + '%', g.concentrationOk ? '✅ (<=25%)' : '❌ (>25%)', '— ' + g.biggestCompany);
  console.log('\n  GATE ' + (g.pass ? '✅ PASS' : '❌ FAIL'));
}

if (require.main === module) {
  sourceAll({}).then(({ report }) => { printReport(report); })
    .catch(e => { console.error('source-run failed:', e); process.exit(1); });
}

module.exports = { sourceAll, printReport, DEFAULT_QUERIES };
