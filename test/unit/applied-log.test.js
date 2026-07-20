'use strict';
// Tests pjaWriteAppliedLog — the durable applied-log writer (external-apply.js).
// Guards the tracking/verification fixes: idempotent by company::title, status MERGE
// (submitting -> applied upgrade, never downgrade), and record enrichment
// (jobId/applyUrl/location/channel/confirmedEmail). SYNTHETIC data only.
// The chrome.storage stub here is STATEFUL + synchronous, so the writer's side effect
// completes before it returns (no await needed in this runner).
const fs = require('fs');
const path = require('path');
const { makeStubs } = require('./load.js');

function loadWithStatefulStorage() {
  const stubs = makeStubs();
  const store = {};
  stubs.chrome.storage.local.get = (k, cb) => {
    const keys = Array.isArray(k) ? k : [k];
    const out = {};
    for (const key of keys) if (store[key] !== undefined) out[key] = store[key];
    cb(out);
  };
  stubs.chrome.storage.local.set = (o, cb) => { Object.assign(store, o); cb && cb(); };
  const names = Object.keys(stubs);
  const vals = names.map(n => stubs[n]);
  const src = fs.readFileSync(path.resolve(__dirname, '../../content/external-apply.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const w = new Function(...names, src + '\n;return window;')(...vals);
  return { w, store };
}

module.exports = (t) => {
  const { w, store } = loadWithStatefulStorage();
  t.ok(typeof w.pjaWriteAppliedLog === 'function', 'applied-log: writer is exported on window');

  const job = { company: 'Acme Robotics', title: 'Quality Engineer', jobId: 'J123',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', location: 'Fremont, CA', channel: 'external' };

  // optimistic pre-write at submit-click
  w.pjaWriteAppliedLog(job, { status: 'submitting', reason: 'submit_clicked' });
  let log = store.pja_applied_log || [];
  t.eq(log.length, 1, 'applied-log: pre-write creates one record');
  t.eq(log[0].status, 'submitting', 'applied-log: pre-write status = submitting');
  t.eq(log[0].confirmedEmail, false, 'applied-log: enriched with confirmedEmail flag');
  t.eq(log[0].jobId, 'J123', 'applied-log: enriched with jobId');
  t.eq(log[0].applyUrl, 'https://boards.greenhouse.io/acme/jobs/1', 'applied-log: enriched with applyUrl');
  t.eq(log[0].location, 'Fremont, CA', 'applied-log: enriched with location');
  t.eq(log[0].channel, 'external', 'applied-log: enriched with channel');

  // confirmation upgrades the SAME record (no duplicate) submitting -> applied
  w.pjaWriteAppliedLog(job, { status: 'applied', reason: 'applied', confirmationSource: 'page', confirmedAt: 1234 });
  log = store.pja_applied_log;
  t.eq(log.length, 1, 'applied-log: idempotent by company::title (no duplicate on re-write)');
  t.eq(log[0].status, 'applied', 'applied-log: submitting upgraded to applied');
  t.eq(log[0].confirmationSource, 'page', 'applied-log: explicit confirmation source retained');
  t.eq(log[0].confirmedAt, 1234, 'applied-log: confirmation timestamp retained');

  // a later 'submitting'/'skipped' must NOT downgrade a confirmed apply
  w.pjaWriteAppliedLog({ company: 'Acme Robotics', title: 'Quality Engineer' }, { status: 'submitting' });
  t.eq(store.pja_applied_log[0].status, 'applied', 'applied-log: never downgrades applied -> submitting');

  // matching is normalized (case / punctuation / suffix differences collapse)
  w.pjaWriteAppliedLog({ company: 'acme robotics', title: 'quality  engineer' }, { status: 'applied' });
  t.eq(store.pja_applied_log.length, 1, 'applied-log: normalized key matches across case/spacing');

  // a genuinely different role is a new record
  w.pjaWriteAppliedLog({ company: 'Acme Robotics', title: 'Manufacturing Engineer', channel: 'api' }, { status: 'applied' });
  t.eq(store.pja_applied_log.length, 2, 'applied-log: distinct title -> new record');
  t.eq(store.pja_applied_log[1].channel, 'api', 'applied-log: per-record channel preserved');

  // ── Distinct postings sharing company::title (the AMAT case: many reqs all titled
  // "Process Engineer") must be SEPARATE records — keyed by jobId when both sides have one.
  const req1 = { company: 'MegaFab', title: 'Process Engineer', jobId: 'R2616270', applyUrl: 'https://wd/j/R2616270' };
  const req2 = { company: 'MegaFab', title: 'Process Engineer', jobId: 'R2616317', applyUrl: 'https://wd/j/R2616317' };
  w.pjaWriteAppliedLog(req1, { status: 'applied' });
  w.pjaWriteAppliedLog(req2, { status: 'applied' });
  let mf = store.pja_applied_log.filter(e => e.company === 'MegaFab');
  t.eq(mf.length, 2, 'applied-log: same title, different jobId -> two records (distinct reqs)');

  // re-write of the SAME req (submitting->applied lifecycle) still merges, not duplicates
  w.pjaWriteAppliedLog(req2, { status: 'applied', reason: 're-confirm' });
  mf = store.pja_applied_log.filter(e => e.company === 'MegaFab');
  t.eq(mf.length, 2, 'applied-log: same jobId re-write merges (no duplicate)');

  // legacy entry WITHOUT jobId matches an incoming write WITH jobId (enrich, not duplicate)
  w.pjaWriteAppliedLog({ company: 'OldCo', title: 'Process Engineer' }, { status: 'applied' });
  w.pjaWriteAppliedLog({ company: 'OldCo', title: 'Process Engineer', jobId: 'R99' }, { status: 'applied' });
  const oc = store.pja_applied_log.filter(e => e.company === 'OldCo');
  t.eq(oc.length, 1, 'applied-log: legacy no-jobId entry absorbs the jobId write (no duplicate)');
  t.eq(oc[0].jobId, 'R99', 'applied-log: legacy entry enriched with the jobId');
};
