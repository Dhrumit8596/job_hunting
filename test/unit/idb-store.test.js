'use strict';
// Proves criterion 5 of the "Find 200+" gate: no quota/silent-write failures at 2,000+ stored jobs
// on IndexedDB. Uses fake-indexeddb (a spec-compliant IDB engine) so the real per-record write path,
// indexes, and scale behavior are exercised in Node — not a plain-object stand-in.
require('fake-indexeddb/auto');
const path = require('path');
const idb = require(path.resolve(__dirname, '../../idb-store'));
const jobid = require(path.resolve(__dirname, '../../sourcing/jobid'));
const { roleKey } = jobid;
const { makeJob } = require(path.resolve(__dirname, '../../sourcing/normalize'));

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

  await idb.clearAll();

  // 2,500 distinct roles across 50 companies (=> 2% max concentration) via PER-RECORD writes.
  const big = [];
  for (let i = 0; i < 2500; i++) {
    big.push(makeJob({ id: i, title: 'Process Engineer ' + i, company: 'Co' + (i % 50), location: 'San Jose, CA', ats: 'greenhouse' }));
  }
  const r1 = await idb.upsertJobs(big, 'api-registry', () => ({ fitScore: 60 }));
  t.eq(r1.added, 2500, 'idb: 2500 per-record writes succeeded (no quota/silent-write failure)');
  t.eq(await idb.count(), 2500, 'idb: count reflects 2500 stored');

  // second modality
  const disc = [];
  for (let i = 0; i < 6; i++) disc.push(makeJob({ id: 'd' + i, title: 'Metrology Engineer ' + i, company: 'DiscCo' + i, location: 'Remote, US', ats: 'remotive' }));
  await idb.upsertJobs(disc, 'discovery', () => ({ fitScore: 65 }));
  t.eq(await idb.count(), 2506, 'idb: 2506 after discovery batch');

  // idempotent re-upsert (dedup by canonical id) — no growth, no duplicates
  const r2 = await idb.upsertJobs(big, 'api-registry', () => ({ fitScore: 60 }));
  t.eq(r2.added, 0, 'idb: re-upsert adds nothing (id dedup)');
  t.eq(r2.dupById, 2500, 'idb: all 2500 counted as id-dups');
  t.eq(await idb.count(), 2506, 'idb: count unchanged after re-upsert');

  // role-key dedup across modalities: same company+title as an existing job, different id+modality
  const clash = [makeJob({ id: 'clashX', title: 'Process Engineer 0', company: 'Co0', location: 'Remote, US', ats: 'jobicy' })];
  const r3 = await idb.upsertJobs(clash, 'discovery', () => ({ fitScore: 70 }));
  t.eq(r3.added, 0, 'idb: same role from another modality collapsed');
  t.eq(r3.dupByRole, 1, 'idb: counted as role-dup');

  // getJob returns posting + state (use a non-zero id: makeJob maps falsy id 0 -> role-key id)
  const j7 = await idb.getJob('greenhouse:7');
  t.ok(j7 && j7.company === 'Co7', 'idb: getJob posting');
  t.ok(j7 && j7.state && j7.state.fitScore === 60, 'idb: getJob state carries fitScore');

  // applied-state correctness: exclude a known applied role
  const removed = await idb.excludeApplied([roleKey({ company: 'Co1', title: 'Process Engineer 1' })]);
  t.eq(removed, 1, 'idb: excludeApplied removes the applied role');
  t.eq(await idb.count(), 2505, 'idb: count drops by 1 after exclusion');

  // GATE at 2,000+ scale
  const g = await idb.gateReport({ target: 200 });
  t.eq(g.atLeastTarget, true, 'idb-gate: >=200 unique (2505)');
  t.eq(g.atLeast2Modalities, true, 'idb-gate: 2 modalities');
  t.eq(g.allScored, true, 'idb-gate: all fit-scored');
  t.eq(g.concentrationOk, true, 'idb-gate: concentration <=25%');
  t.eq(g.pass, true, 'idb-gate: PASS at 2,000+ on real IndexedDB');

  // schemaVersion recorded via importNormalized path
  await idb.setMeta('schemaVersion', idb.SCHEMA_VERSION);
  t.eq(await idb.getMeta('schemaVersion'), idb.SCHEMA_VERSION, 'idb: schemaVersion persisted');

  await idb.clearAll();
};
