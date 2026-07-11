'use strict';
// Tests for the storage-integrity foundation: canonical id, ATS detection, pre-score, and the
// normalized job store (dedup by id + role-key, applied-exclusion, concentration, gate report).
const path = require('path');
const R = d => require(path.resolve(__dirname, '../../sourcing', d));
const { norm, roleKey, canonicalId } = R('jobid');
const { detectAts, detectSlug } = R('detect-ats');
const { prescore, needsLlm } = R('prescore');
const { createStore, upsert, excludeApplied, concentration, gateReport } = R('jobstore');
const { makeJob } = R('normalize');

module.exports = (t) => {
  // --- canonical id ---
  t.eq(canonicalId({ ats: 'greenhouse', id: 123 }), 'greenhouse:123', 'canonicalId: ats:id');
  t.eq(canonicalId({ ats: 'Ashby', id: 'uuid-1' }), 'ashby:uuid-1', 'canonicalId: ats lowercased');
  t.eq(canonicalId({ company: 'Acme Co', title: 'Quality Engineer' }), 'norm:acme co::quality engineer', 'canonicalId: falls back to role-key when no id');
  t.eq(roleKey({ company: 'Twist Bioscience', title: 'Equipment  Engineer' }), 'twist bioscience::equipment engineer', 'roleKey: normalized');
  t.eq(norm('  Foo-BAR__baz '), 'foo bar baz', 'norm: lower + collapse');

  // --- ATS detection from URL ---
  t.eq(detectAts('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse', 'detectAts: greenhouse');
  t.eq(detectAts('https://jobs.lever.co/acme/uuid'), 'lever', 'detectAts: lever');
  t.eq(detectAts('https://jobs.ashbyhq.com/acme/uuid'), 'ashby', 'detectAts: ashby');
  t.eq(detectAts('https://acme.wd1.myworkdayjobs.com/careers'), 'workday', 'detectAts: workday');
  t.eq(detectAts('https://careers.acme.com/job/1'), '', 'detectAts: unknown host -> empty');
  t.eq(detectAts('not a url'), '', 'detectAts: garbage -> empty');
  t.eq(detectSlug('https://boards.greenhouse.io/stripe/jobs/1', 'greenhouse'), 'stripe', 'detectSlug: greenhouse slug');
  t.eq(detectSlug('https://acme.wd5.myworkdayjobs.com/x', 'workday'), 'acme', 'detectSlug: workday tenant');

  // --- prescore ---
  t.ok(prescore({ title: 'Wafer Process Engineer', company: 'X' }) >= 70, 'prescore: core wafer/process high');
  t.ok(prescore({ title: 'Quality Engineer', company: 'Capstan Medical' }) >= prescore({ title: 'Mechanical Engineer', company: 'X' }), 'prescore: quality >= generic');
  t.ok(prescore({ title: 'Staff Metrology Engineer', company: 'X' }) < prescore({ title: 'Metrology Engineer', company: 'X' }), 'prescore: staff penalty');
  t.eq(needsLlm(85), false, 'needsLlm: clear-high skips');
  t.eq(needsLlm(30), false, 'needsLlm: clear-low skips');
  t.eq(needsLlm(60), true, 'needsLlm: borderline needs LLM');

  // --- store: dedup by canonical id AND role-key across modalities ---
  const store = createStore();
  const a = [
    makeJob({ id: 1, title: 'Quality Engineer', company: 'Acme', location: 'Fremont, CA', ats: 'greenhouse' }),
    makeJob({ id: 2, title: 'Process Engineer', company: 'Beta', location: 'San Jose, CA', ats: 'greenhouse' }),
  ];
  const r1 = upsert(store, a, 'api-registry', j => ({ fitScore: prescore(j) }));
  t.eq(r1.added, 2, 'upsert: adds 2');
  // same role, different modality + different id -> collapsed by role-key
  const b = [ makeJob({ id: 'xyz', title: 'Quality Engineer', company: 'Acme', location: 'Remote, US', ats: 'remotive' }) ];
  const r2 = upsert(store, b, 'discovery', j => ({ fitScore: prescore(j) }));
  t.eq(r2.added, 0, 'upsert: same role from another modality collapsed');
  t.eq(r2.dupByRole, 1, 'upsert: counted as role dup');
  t.eq(Object.keys(store.index).length, 2, 'store: still 2 unique');

  // --- exclude applied ---
  const removed = excludeApplied(store, [roleKey({ company: 'Acme', title: 'Quality Engineer' })]);
  t.eq(removed, 1, 'excludeApplied: removes applied role');
  t.eq(Object.keys(store.index).length, 1, 'store: 1 left after exclusion');

  // --- concentration ---
  const cs = createStore();
  upsert(cs, [
    makeJob({ id: 1, title: 'Process Engineer', company: 'AMAT', location: 'Santa Clara, CA', ats: 'workday' }),
    makeJob({ id: 2, title: 'Quality Engineer', company: 'AMAT', location: 'Santa Clara, CA', ats: 'workday' }),
    makeJob({ id: 3, title: 'Metrology Engineer', company: 'Bloom', location: 'San Jose, CA', ats: 'workday' }),
  ], 'api-registry', () => ({ fitScore: 60 }));
  const conc = concentration(cs);
  t.eq(conc.maxCount, 2, 'concentration: biggest company count');
  t.ok(Math.abs(conc.share - 2 / 3) < 1e-9, 'concentration: share = 2/3');

  // --- gate report ---
  const gs = createStore();
  const many = [];
  // distinct roles (unique title per job) spread across 20 companies -> passes concentration
  for (let i = 0; i < 210; i++) many.push(makeJob({ id: i, title: 'Process Engineer ' + i, company: 'Co' + (i % 20), location: 'CA', ats: 'greenhouse' }));
  upsert(gs, many, 'api-registry', () => ({ fitScore: 60 }));
  upsert(gs, [makeJob({ id: 'd1', title: 'Metrology Engineer', company: 'DiscCo', location: 'Remote, US', ats: 'remotive' })], 'discovery', () => ({ fitScore: 65 }));
  const g = gateReport(gs, { target: 200 });
  t.eq(g.atLeastTarget, true, 'gate: >=200 unique');
  t.eq(g.atLeast2Modalities, true, 'gate: 2 modalities');
  t.eq(g.allScored, true, 'gate: all scored');
  t.eq(g.concentrationOk, true, 'gate: concentration ok');
  t.eq(g.pass, true, 'gate: PASS');
};
