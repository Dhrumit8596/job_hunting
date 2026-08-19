'use strict';
// Proves criterion 5 of the "Find 200+" gate: no quota/silent-write failures at 2,000+ stored jobs
// on IndexedDB. Uses fake-indexeddb (a spec-compliant IDB engine) so the real per-record write path,
// indexes, and scale behavior are exercised in Node — not a plain-object stand-in.
require('fake-indexeddb/auto');
const path = require('path');
const idb = require(path.resolve(__dirname, '../../idb-store'));
const Evidence = require(path.resolve(__dirname, '../../scoring-evidence'));
const jobid = require(path.resolve(__dirname, '../../sourcing/jobid'));
const { roleKey } = jobid;
const { makeJob } = require(path.resolve(__dirname, '../../sourcing/normalize'));

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database deletion blocked'));
  });
}

async function seedV1Database(posting, state) {
  await deleteDatabase(idb.DB_NAME);
  const request = indexedDB.open(idb.DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    const index = db.createObjectStore('index', { keyPath: 'id' });
    index.createIndex('roleKey', 'roleKey', { unique: false });
    index.createIndex('company', 'company', { unique: false });
    index.createIndex('modality', 'modality', { unique: false });
    const mutable = db.createObjectStore('state', { keyPath: 'id' });
    mutable.createIndex('fitScore', 'fitScore', { unique: false });
    mutable.createIndex('status', 'status', { unique: false });
    db.createObjectStore('meta', { keyPath: 'k' });
    index.put(posting);
    mutable.put(state);
  };
  const db = await requestResult(request);
  db.close();
}

module.exports = async (t) => {
  // parity: idb-store inlines canonicalId/roleKey — they MUST match sourcing/jobid exactly,
  // else the corpus and the source-run would dedup on different keys.
  const samples = [
    { ats: 'greenhouse', id: 42, company: 'Acme Co', title: 'Process Engineer' },
    { ats: 'Remotive', id: 'r-9', company: 'Beta, Inc.', title: 'Quality  Engineer' },
    { company: 'NoId Corp', title: 'Metrology Engineer' },
  ];
  for (const s of samples) {
    t.eq(idb.canonicalId(s), jobid.canonicalId(s), 'parity: canonicalId matches jobid (' + (s.ats || 'noats') + ')');
    t.eq(idb.roleKey(s), jobid.roleKey(s), 'parity: roleKey matches jobid');
  }

  // Schema v2 upgrades an existing v1 corpus atomically and backfills the compact planning store.
  // The canonical posting keeps its JD while the new planning row never contains that body.
  const migratedDescription = 'Legacy full process-control requirements that must stay canonical only.';
  await seedV1Database({
    id: 'greenhouse:migrate-1', title: 'Legacy Process Engineer', company: 'Legacy Co',
    location: 'San Jose, CA', roleKey: 'legacy co::legacy process engineer', mirrorKey: 'legacy co::legacy process engineer::san jose ca',
    modality: 'api-registry', description: migratedDescription, descriptionStatus: 'complete',
    descriptionFingerprint: idb.descriptionFingerprint(migratedDescription),
  }, { id: 'greenhouse:migrate-1', status: 'sourced', fitScore: 77 });
  const migratedDb = await idb.openDb();
  t.eq(migratedDb.version, idb.SCHEMA_VERSION, 'idb v2 migration: database upgrades to current schema');
  t.eq(migratedDb.objectStoreNames.contains(idb.PLANNING_STORE), true,
    'idb v2 migration: compact planning store exists');
  migratedDb.close();
  const migratedPlanning = await idb.getApplyPlanningCorpus();
  t.eq(migratedPlanning.total, 1, 'idb v2 migration: existing posting is backfilled into planning');
  t.eq(migratedPlanning.index['greenhouse:migrate-1'].descriptionLength, migratedDescription.length,
    'idb v2 migration: backfill carries description length metadata');
  t.eq(Object.prototype.hasOwnProperty.call(migratedPlanning.index['greenhouse:migrate-1'], 'description'), false,
    'idb v2 migration: backfilled projection is description-free');
  t.eq((await idb.getJob('greenhouse:migrate-1')).description, migratedDescription,
    'idb v2 migration: canonical JD remains intact');

  await idb.clearAll();

  // 2,500 distinct roles across 50 companies (=> 2% max concentration) via PER-RECORD writes.
  const big = [];
  for (let i = 0; i < 2500; i++) {
    big.push(makeJob({ id: i, title: 'Process Engineer ' + i, company: 'Co' + (i % 50), location: 'San Jose, CA', ats: 'greenhouse', description: 'Process control, SPC, metrology, and root-cause requirements.' }));
  }
  const r1 = await idb.upsertJobs(big, 'api-registry', () => ({ fitScore: 60 }));
  t.eq(r1.added, 2500, 'idb: 2500 per-record writes succeeded (no quota/silent-write failure)');
  t.eq(await idb.count(), 2500, 'idb: count reflects 2500 stored');

  // second modality
  const disc = [];
  for (let i = 0; i < 6; i++) disc.push(makeJob({ id: 'd' + i, title: 'Metrology Engineer ' + i, company: 'DiscCo' + i, location: 'Remote, US', ats: 'remotive', description: 'Optical metrology and quality requirements.' }));
  await idb.upsertJobs(disc, 'discovery', () => ({ fitScore: 65 }));
  t.eq(await idb.count(), 2506, 'idb: 2506 after discovery batch');

  // idempotent re-upsert (dedup by canonical id) — no growth, no duplicates
  const r2 = await idb.upsertJobs(big, 'api-registry', () => ({ fitScore: 60 }));
  t.eq(r2.added, 0, 'idb: re-upsert adds nothing (id dedup)');
  t.eq(r2.dupById, 2500, 'idb: all 2500 counted as id-dups');
  t.eq(await idb.count(), 2506, 'idb: count unchanged after re-upsert');

  // Same visible role across modalities is ambiguous without an exact direct URL, so it survives.
  const clash = [makeJob({ id: 'clashX', title: 'Process Engineer 0', company: 'Co0', location: 'San Jose, CA', ats: 'jobicy', description: 'Detailed process requirements.' })];
  const r3 = await idb.upsertJobs(clash, 'discovery', () => ({ fitScore: 70 }));
  t.eq(r3.added, 1, 'idb: same-title/location cross-source requisition survives without exact URL identity');
  t.eq(r3.dupByRole, 0, 'idb: ambiguous role similarity is not counted as identity');

  // Exact direct URLs are safe cross-source identity and can enrich one posting.
  const exactA = makeJob({ id: 'exact-a', title: 'Yield Engineer', company: 'ExactCo', location: 'Fremont, CA', ats: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/exact/jobs/44' });
  const exactB = makeJob({ id: 'exact-b', title: 'Yield Engineer', company: 'ExactCo', location: 'Fremont, CA', ats: 'linkedin', applyUrl: 'https://boards.greenhouse.io/exact/jobs/44', description: 'Full SPC and metrology requirements.' });
  await idb.upsertJobs([exactA], 'api-registry', () => ({ fitScore: 60 }));
  const exactR = await idb.upsertJobs([exactB], 'browser-linkedin', () => ({ fitScore: 70 }));
  t.eq(exactR.added, 0, 'idb: exact direct URL duplicate collapses safely');
  t.eq(exactR.dupByRole, 1, 'idb: exact direct URL duplicate counted');
  const exactStored = await idb.getJob('greenhouse:exact-a');
  t.eq(exactStored.applyUrl, exactA.applyUrl, 'idb route: direct URL remains coherent');
  t.eq(exactStored.sourceJobId, 'exact-a', 'idb route: source id remains paired with direct route');

  // getJob returns posting + state (use a non-zero id: makeJob maps falsy id 0 -> role-key id)
  const j7 = await idb.getJob('greenhouse:7');
  t.ok(j7 && j7.company === 'Co7', 'idb: getJob posting');
  t.ok(j7 && j7.state && j7.state.fitScore === 60, 'idb: getJob state carries fitScore');

  // The initial apply-planning read must stay compact even when the corpus contains thousands of
  // description-rich postings. JD text is retrieved later in strict scoring-sized batches.
  const planning = await idb.getApplyPlanningCorpus();
  t.eq(planning.total, 2508, 'idb apply planning: reports full corpus total');
  const projected7 = planning.index['greenhouse:7'];
  t.ok(projected7 && !Object.prototype.hasOwnProperty.call(projected7, 'description'),
    'idb apply planning: posting projection never carries JD text');
  t.eq(projected7.descriptionReady, true, 'idb apply planning: projection carries JD readiness');
  t.eq(projected7.descriptionLength > 0, true, 'idb apply planning: projection carries JD length metadata');
  t.eq(projected7.descriptionFingerprint, (await idb.getJob('greenhouse:7')).descriptionFingerprint,
    'idb apply planning: projection carries posting JD fingerprint');
  t.ok(Object.prototype.hasOwnProperty.call(projected7, 'postedAt') &&
    Object.prototype.hasOwnProperty.call(projected7, 'query'),
  'idb apply planning: projection carries description-free freshness and query provenance');
  t.eq(planning.state['greenhouse:7'].fitScore, 60, 'idb apply planning: projection carries mutable score state');
  t.eq(JSON.stringify(planning).includes('Process control, SPC, metrology, and root-cause requirements.'), false,
    'idb apply planning: serialized projection does not leak repeated JD bodies');

  const descriptions = await idb.getApplyDescriptions(['greenhouse:7', 'greenhouse:8', 'greenhouse:7', 'missing:id']);
  t.eq(descriptions.map(row => row.id), ['greenhouse:7', 'greenhouse:8'],
    'idb apply descriptions: dedupes IDs, preserves request order, and omits missing postings');
  t.eq(descriptions.every(row => row.description && row.descriptionReady && row.descriptionFingerprint), true,
    'idb apply descriptions: returns complete targeted JD hydration metadata');
  let batchError = '';
  try { await idb.getApplyDescriptions(Array.from({ length: 11 }, (_, i) => 'greenhouse:' + i)); }
  catch (e) { batchError = e.message; }
  t.eq(batchError, 'getApplyDescriptions supports at most 10 ids',
    'idb apply descriptions: rejects batches above the hard ten-record ceiling');

  // applied-state correctness: exclude a known applied role
  const removed = await idb.excludeApplied([roleKey({ company: 'Co1', title: 'Process Engineer 1' })]);
  t.eq(removed, 1, 'idb: excludeApplied removes the applied role');
  t.eq(await idb.count(), 2507, 'idb: count drops by 1 after exclusion');
  t.eq((await idb.getApplyPlanningCorpus()).index['greenhouse:1'], undefined,
    'idb: excludeApplied removes the compact planning projection too');

  // GATE at 2,000+ scale
  const g = await idb.gateReport({ target: 200 });
  t.eq(g.atLeastTarget, true, 'idb-gate: >=200 unique at scale');
  t.eq(g.atLeast2Modalities, true, 'idb-gate: 2 modalities');
  t.eq(g.descriptionsReady, true, 'idb-gate: target supply has grounded descriptions');
  t.eq(g.allScored, true, 'idb-gate: all fit-scored');
  t.eq(g.concentrationOk, true, 'idb-gate: concentration <=25%');
  t.eq(g.pass, true, 'idb-gate: PASS at 2,000+ on real IndexedDB');

  // Duplicate source records enrich the existing posting instead of discarding a later, fuller JD.
  const rich = makeJob({ id: 8, title: 'Process Engineer 8', company: 'Co8', location: 'San Jose, CA',
    ats: 'greenhouse', description: 'Own high-volume wafer inspection, thin-film metrology, SPC, defect reduction, and root-cause analysis.' });
  const richResult = await idb.upsertJobs([rich], 'browser-linkedin', () => ({ fitScore: 70 }));
  t.eq(richResult.dupById, 1, 'idb: duplicate id recognized during enrichment');
  t.eq((await idb.getJob('greenhouse:8')).description, rich.description, 'idb: richer duplicate description retained');
  const richProjection = (await idb.getApplyPlanningCorpus()).index['greenhouse:8'];
  t.eq(richProjection.descriptionLength, rich.description.length,
    'idb: enrichment synchronizes compact planning metadata');
  t.eq(richProjection.descriptionFingerprint, idb.descriptionFingerprint(rich.description),
    'idb: enrichment synchronizes the planning fingerprint without storing JD text');

  // Distinct ids from the same ATS survive even if employer/title/location are identical.
  const req2 = makeJob({ id: 'req-2', title: 'Process Engineer 8', company: 'Co8', location: 'San Jose, CA', ats: 'greenhouse' });
  t.eq((await idb.upsertJobs([req2], 'api-registry', () => ({ fitScore: 60 }))).added, 1,
    'idb: distinct same-ATS requisition is not collapsed by mirror key');

  // importNormalized preserves apply-progress across a re-source (idempotency)
  await idb.updateState('greenhouse:7', { status: 'applied', appliedAt: 111 });
  const imp = await idb.importNormalized({
    index: { 'greenhouse:7': { id: 'greenhouse:7', company: 'Co7', title: 'Process Engineer 7', roleKey: 'co7::process engineer 7', modality: 'api-registry' } },
    state: { 'greenhouse:7': { fitScore: 80, status: 'sourced' } },
  });
  t.ok(imp.preserved >= 1, 'importNormalized reports preserved count');
  const j7b = await idb.getJob('greenhouse:7');
  t.eq(j7b.state.status, 'applied', 'importNormalized preserves applied status across re-source (not reset to sourced)');
  t.eq(j7b.state.fitScore, 80, 'importNormalized still refreshes fitScore while preserving status');

  // Re-sourcing the same description must not overwrite a prior evidence-grounded LLM score.
  const fp = idb.descriptionFingerprint('stable requirements');
  await idb.updateState('greenhouse:7', { status: 'sourced', fitScore: 92, scoreKind: 'llm',
    descriptionFingerprint: fp, scoringPolicyVersion: Evidence.SCORING_POLICY_VERSION,
    matchEvidence: ['wafer', 'metrology', 'SPC'], gaps: ['vacuum platform'], materialGaps: [],
    trainableGaps: ['vacuum platform'], preferredGaps: [],
    transferability: { level: 'adjacent', rationale: 'Core process work is evidenced.' }, confidence: 'high' });
  const same = await idb.importNormalized({
    index: { 'greenhouse:7': { id: 'greenhouse:7', company: 'Co7', title: 'Process Engineer 7',
      location: 'San Jose, CA', roleKey: 'co7::process engineer 7', modality: 'api-registry', description: 'stable requirements' } },
    state: { 'greenhouse:7': { fitScore: 60, scoreKind: 'heuristic', status: 'sourced', descriptionFingerprint: fp } },
  });
  t.eq(same.preservedEvidence, 1, 'idb: same-description refresh reports preserved LLM evidence');
  t.eq((await idb.getJob('greenhouse:7')).state.fitScore, 92, 'idb: heuristic refresh cannot downgrade current LLM score');
  const preservedStructured = (await idb.getJob('greenhouse:7')).state;
  t.eq({ version: preservedStructured.scoringPolicyVersion, material: preservedStructured.materialGaps,
    trainable: preservedStructured.trainableGaps, transfer: preservedStructured.transferability.level },
  { version: Evidence.SCORING_POLICY_VERSION, material: [], trainable: ['vacuum platform'], transfer: 'adjacent' },
  'idb: same-description refresh preserves structured transferability evidence');

  // A changed description invalidates the old evidence and returns the job to heuristic scoring.
  const changedFp = idb.descriptionFingerprint('changed requirements');
  await idb.importNormalized({
    index: { 'greenhouse:7': { id: 'greenhouse:7', company: 'Co7', title: 'Process Engineer 7',
      location: 'San Jose, CA', roleKey: 'co7::process engineer 7', modality: 'api-registry', description: 'changed requirements' } },
    state: { 'greenhouse:7': { fitScore: 61, scoreKind: 'heuristic', status: 'sourced', descriptionFingerprint: changedFp } },
  });
  const changed = await idb.getJob('greenhouse:7');
  t.eq(changed.state.scoreKind, 'heuristic', 'idb: changed JD invalidates old LLM evidence');
  t.eq(changed.state.fitScore, 61, 'idb: changed JD receives fresh heuristic score pending rescore');

  // Newly available descriptions are labeled for frontier priority, and a current shorter JD is
  // authoritative instead of retaining longer stale evidence from an earlier source run.
  await idb.importNormalized({
    index: { 'workday:hydrate-1': { id: 'workday:hydrate-1', company: 'Hydrate Co', title: 'Process Engineer',
      location: 'Santa Clara, CA', roleKey: 'hydrate co::process engineer', modality: 'api-registry',
      description: '', descriptionStatus: 'needs_description' } },
    state: { 'workday:hydrate-1': { fitScore: 75, scoreKind: 'heuristic', status: 'sourced' } },
  });
  const hydratedImport = await idb.importNormalized({
    index: { 'workday:hydrate-1': { id: 'workday:hydrate-1', company: 'Hydrate Co', title: 'Process Engineer',
      location: 'Santa Clara, CA', roleKey: 'hydrate co::process engineer', modality: 'api-registry',
      description: 'Current full wafer process requirements.', descriptionStatus: 'complete' } },
    state: { 'workday:hydrate-1': { fitScore: 75, scoreKind: 'heuristic', status: 'sourced' } },
  });
  t.eq(hydratedImport.newlyHydrated, 1, 'idb: import reports a newly hydrated posting');
  const hydratedPlan = await idb.getApplyPlanningCorpus();
  t.eq(hydratedPlan.state['workday:hydrate-1'].sourcePriority, 'newly_hydrated',
    'idb: newly hydrated source priority reaches the compact scoring frontier');
  const shorterImport = await idb.importNormalized({
    index: { 'workday:hydrate-1': { id: 'workday:hydrate-1', company: 'Hydrate Co', title: 'Process Engineer',
      location: 'Santa Clara, CA', roleKey: 'hydrate co::process engineer', modality: 'api-registry',
      description: 'Short current requirements.', descriptionStatus: 'complete' } },
    state: { 'workday:hydrate-1': { fitScore: 62, scoreKind: 'heuristic', status: 'sourced' } },
  });
  t.eq(shorterImport.descriptionUpdated, 1, 'idb: a shorter current primary-source JD is reported as updated');
  t.eq((await idb.getJob('workday:hydrate-1')).description, 'Short current requirements.',
    'idb: stale longer description does not override a populated current primary-source JD');

  // Exact import receipts are committed in the same transaction as canonical, planning, and state
  // rows, and can be reconciled later without re-sending an ambiguous import.
  const receiptResult = await idb.importNormalized({
    index: { 'greenhouse:receipt-1': { id: 'greenhouse:receipt-1', company: 'Receipt Co', title: 'Yield Engineer',
      location: 'Fremont, CA', roleKey: 'receipt co::yield engineer', modality: 'api-registry',
      description: 'Yield, SPC, and metrology requirements.', descriptionStatus: 'complete' } },
    state: { 'greenhouse:receipt-1': { fitScore: 79, scoreKind: 'llm', status: 'sourced' } },
  }, { importId: 'source-import-123', runId: 'apply-run-456' });
  const receipt = await idb.getImportReceipt('source-import-123');
  t.eq({ importId: receipt.importId, runId: receipt.runId, committed: receipt.committed,
    imported: receipt.imported, incoming: receipt.incoming, retired: receipt.retired },
  { importId: 'source-import-123', runId: 'apply-run-456', committed: true,
    imported: 1, incoming: 1, retired: 0 },
  'idb import receipt: exact run/import identity and committed counts are durable');
  t.eq(receipt.total, await idb.count(), 'idb import receipt: committed total matches corpus count');
  t.eq(receiptResult.receipt, receipt, 'idb import receipt: import returns the atomically stored receipt');
  t.eq(typeof receipt.committedAt, 'number', 'idb import receipt: committed timestamp is recorded');
  t.eq(await idb.getImportReceipt('source-import-unknown'), null,
    'idb import receipt: an unknown exact import id is not inferred from another receipt');
  t.ok((await idb.getApplyPlanningCorpus()).index['greenhouse:receipt-1'],
    'idb import receipt: compact projection committed with the receipt');

  // Ownership is rechecked after all read/preparation work and before opening the write transaction.
  // Rejection must preserve both the prior corpus and the absence of a receipt.
  const countBeforeRejectedImport = await idb.count();
  let beforeCommitContext = null;
  let rejectedMessage = '';
  try {
    await idb.importNormalized({
      index: { 'greenhouse:must-not-write': { id: 'greenhouse:must-not-write', company: 'No Write Co',
        title: 'Process Engineer', roleKey: 'no write co::process engineer', modality: 'api-registry',
        description: 'This row must never commit.' } },
      state: { 'greenhouse:must-not-write': { fitScore: 99, status: 'sourced' } },
    }, { importId: 'source-import-rejected', runId: 'apply-run-stale', replaceMissing: true,
      beforeCommit: async context => { beforeCommitContext = context; throw new Error('run ownership changed'); } });
  } catch (err) { rejectedMessage = err.message; }
  t.eq(rejectedMessage, 'run ownership changed', 'idb beforeCommit: authority rejection propagates');
  t.eq(beforeCommitContext, { importId: 'source-import-rejected', runId: 'apply-run-stale',
    incoming: 1, replaceMissing: true }, 'idb beforeCommit: callback receives exact bounded identity');
  t.eq(await idb.count(), countBeforeRejectedImport,
    'idb beforeCommit: rejected authoritative replacement performs no canonical writes or retirements');
  const afterRejectedPlan = await idb.getApplyPlanningCorpus();
  t.eq(afterRejectedPlan.index['greenhouse:must-not-write'], undefined,
    'idb beforeCommit: rejected import creates no planning projection');
  t.ok(afterRejectedPlan.index['greenhouse:receipt-1'],
    'idb beforeCommit: rejected replaceMissing does not retire an existing projection');
  t.eq(await idb.getImportReceipt('source-import-rejected'), null,
    'idb beforeCommit: rejected import writes no receipt');

  // Phase E: corpusSummary status breakdown + matching count
  const sum = await idb.corpusSummary({ topN: 3, matchThreshold: 60 });
  t.ok(sum.statusCounts && sum.statusCounts.sourced > 0, 'corpusSummary: statusCounts.sourced present');
  t.ok(sum.matching >= 2000, 'corpusSummary: matching count at threshold 60 (all fit>=60)');

  // schemaVersion recorded via importNormalized path
  await idb.setMeta('schemaVersion', idb.SCHEMA_VERSION);
  t.eq(await idb.getMeta('schemaVersion'), idb.SCHEMA_VERSION, 'idb: schemaVersion persisted');

  // A gate-passing authoritative refresh retires postings absent from the new run.
  await idb.upsertJobs([makeJob({ id: 'stale-1', title: 'Closed Role', company: 'OldCo', location: 'CA', ats: 'greenhouse' })], 'api-registry');
  const replaced = await idb.importNormalized({
    index: { 'greenhouse:fresh-1': { id: 'greenhouse:fresh-1', title: 'Fresh Role', company: 'NewCo', location: 'CA', ats: 'greenhouse', roleKey: 'newco::fresh role', modality: 'api-registry' } },
    state: { 'greenhouse:fresh-1': { fitScore: 60, status: 'sourced' } },
  }, { replaceMissing: true, importId: 'source-import-replace', runId: 'source-run-replace' });
  t.ok(replaced.retired > 0, 'idb: authoritative refresh reports retired absent records');
  t.eq(await idb.getJob('greenhouse:stale-1'), null, 'idb: absent/closed posting cannot remain sourced forever');
  t.eq(await idb.count(), 1, 'idb: replacement leaves only the current run corpus');
  const replacementReceipt = await idb.getImportReceipt('source-import-replace');
  t.eq({ total: replacementReceipt.total, retired: replacementReceipt.retired },
    { total: 1, retired: replaced.retired },
    'idb: authoritative replacement receipt records the same atomic retirement and total');
  const replacementPlanning = await idb.getApplyPlanningCorpus();
  t.eq(replacementPlanning.total, 1, 'idb: authoritative replacement retires compact projections');
  t.ok(replacementPlanning.index['greenhouse:fresh-1'], 'idb: replacement synchronizes the incoming projection');
  t.eq(replacementPlanning.index['greenhouse:stale-1'], undefined,
    'idb: retired canonical row cannot remain in compact planning');

  await idb.clearAll();
  t.eq((await idb.getApplyPlanningCorpus()).total, 0, 'idb: clearAll clears compact planning rows');
  t.eq(await idb.getImportReceipt('source-import-123'), null, 'idb: clearAll clears import receipts');
};
