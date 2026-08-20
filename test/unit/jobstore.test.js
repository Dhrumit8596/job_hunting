'use strict';
// Tests for the storage-integrity foundation: canonical id, ATS detection, pre-score, and the
// normalized job store (dedup by id + exact URL, applied-exclusion, concentration, gate report).
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
  t.eq(detectAts('https://greenhouse.io.attacker.example/acme/jobs/1'), '',
    'detectAts: a suffix-spoofed hostname is not treated as an official ATS');
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

  // --- store: dedup by canonical id AND exact direct URL across modalities ---
  const store = createStore();
  const a = [
    makeJob({ id: 1, title: 'Quality Engineer', company: 'Acme', location: 'Fremont, CA', ats: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }),
    makeJob({ id: 2, title: 'Process Engineer', company: 'Beta', location: 'San Jose, CA', ats: 'greenhouse' }),
  ];
  const r1 = upsert(store, a, 'api-registry', j => ({ fitScore: prescore(j) }));
  t.eq(r1.added, 2, 'upsert: adds 2');
  // Exact direct URL, different modality + ATS -> safely collapsed and enriched.
  const b = [ makeJob({ id: 'xyz', title: 'Quality Engineer', company: 'Acme', location: 'Fremont, CA', ats: 'remotive', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', description: 'A much richer requirements description.' }) ];
  const r2 = upsert(store, b, 'discovery', j => ({ fitScore: prescore(j) }));
  t.eq(r2.added, 0, 'upsert: same exact direct URL from another modality collapsed');
  t.eq(r2.dupByRole, 1, 'upsert: exact-URL duplicate counted');
  t.eq(Object.keys(store.index).length, 2, 'store: still 2 unique');
  t.eq(store.index['greenhouse:1'].description, 'A much richer requirements description.', 'upsert: duplicate enriches description instead of discarding it');

  // Source-registry aliases and career-host attestations are part of route evidence. They must
  // survive both the initial normalized-store write and a later exact-URL merge so browser mirrors
  // can be matched against the official posting without weakening company identity.
  const routeEvidence = createStore();
  upsert(routeEvidence, [makeJob({ id: 'R-086504', title: 'Supplier Quality Engineer II',
    company: 'Johnson & Johnson', location: 'Santa Clara, CA', ats: 'workday',
    applyUrl: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/x_R-086504' })
  ], 'api-registry');
  upsert(routeEvidence, [{ id: 'R-086504', title: 'Supplier Quality Engineer II',
    company: 'Johnson & Johnson', location: 'Santa Clara, CA', ats: 'workday',
    applyUrl: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/x_R-086504',
    sourceAliases: ['Shockwave Medical'], careerHosts: ['careers.jnj.com'] }], 'api-registry');
  t.eq({ aliases: routeEvidence.index['workday:R-086504'].sourceAliases,
    hosts: routeEvidence.index['workday:R-086504'].careerHosts },
  { aliases: ['Shockwave Medical'], hosts: ['careers.jnj.com'] },
  'store: official company aliases and career hosts survive normalized insert and merge');

  // Same ATS + same title/location but distinct requisition ids must both survive.
  const distinct = upsert(store, [makeJob({ id: 3, title: 'Quality Engineer', company: 'Acme', location: 'Fremont, CA', ats: 'greenhouse' })], 'api-registry', j => ({ fitScore: prescore(j) }));
  t.eq(distinct.added, 1, 'upsert: distinct same-ATS requisition survives mirror match');

  // Same company/title/location across DIFFERENT systems is still ambiguous when URLs differ.
  const ambiguous = createStore();
  upsert(ambiguous, [makeJob({ id: 'gh-1', title: 'Process Engineer', company: 'MegaFab', location: 'Boise, ID', ats: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/megafab/jobs/gh-1' })], 'api-registry');
  const amb = upsert(ambiguous, [makeJob({ id: 'li-9', title: 'Process Engineer', company: 'MegaFab', location: 'Boise, ID', ats: 'linkedin', applyUrl: 'https://www.linkedin.com/jobs/view/9/' })], 'browser-linkedin');
  t.eq(amb.added, 1, 'upsert: same-title/location cross-source requisition survives without exact URL identity');
  t.eq(Object.keys(ambiguous.index).length, 2, 'upsert: ambiguous mirror cannot attach a JD or route to the wrong requisition');

  // Specialized-channel route fields stay atomic; they cannot mix with the direct ATS route.
  const direct = ambiguous.index['greenhouse:gh-1'];
  t.eq(direct.applyUrl, 'https://boards.greenhouse.io/megafab/jobs/gh-1', 'route: direct apply URL remains on direct posting');
  t.eq(direct.sourceJobId, 'gh-1', 'route: direct source id is not replaced by browser id');

  // --- exclude applied ---
  const exactRemoved = excludeApplied(store, { exactIds: new Set(['greenhouse:1']), urls: new Set(), legacyRoles: new Set() });
  t.eq(exactRemoved, 1, 'excludeApplied: exact identity removes only one requisition');
  t.ok(!!store.index['greenhouse:3'], 'excludeApplied: same-title sibling remains after exact exclusion');
  const removed = excludeApplied(store, [roleKey({ company: 'Acme', title: 'Quality Engineer' })]);
  t.eq(removed, 1, 'excludeApplied: legacy role-key removes remaining same-title requisition');
  t.eq(Object.keys(store.index).length, 1, 'store: only non-Acme role left after legacy role exclusion');

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
  for (let i = 0; i < 210; i++) many.push(makeJob({ id: i, title: 'Process Engineer ' + i, company: 'Co' + (i % 20), location: 'CA', ats: 'greenhouse', description: 'Requirements include process control, SPC, metrology, and root-cause analysis.' }));
  upsert(gs, many, 'api-registry', () => ({ fitScore: 60 }));
  upsert(gs, [makeJob({ id: 'd1', title: 'Metrology Engineer', company: 'DiscCo', location: 'Remote, US', ats: 'remotive', description: 'Own optical metrology and quality controls.' })], 'discovery', () => ({ fitScore: 65 }));
  const g = gateReport(gs, { target: 200 });
  t.eq(g.atLeastTarget, true, 'gate: >=200 unique');
  t.eq(g.atLeast2Modalities, true, 'gate: 2 modalities');
  t.eq(g.sourceClasses.sort(), ['direct', 'discovery'], 'gate: modalities collapse into distinct top-level source classes');
  t.eq(g.descriptionsReady, true, 'gate: target supply has grounded job descriptions');
  t.eq(g.allScored, true, 'gate: all scored');
  t.eq(g.concentrationOk, true, 'gate: concentration ok');
  t.eq(g.pass, true, 'gate: PASS');
};
