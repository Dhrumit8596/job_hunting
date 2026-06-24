'use strict';
// Channel-router tests: dedupe across both channels (jobId + company::title), threshold + company
// exclusions + export-control, and the EA/external split, highest-fit first. SYNTHETIC data only.
const { routeJobs } = require('../../sourcing/router');

module.exports = (t) => {
  const storage = {
    pja_applied_log: [
      { company: 'Cordis', title: 'Quality Engineer I', applyUrl: 'https://www.linkedin.com/jobs/view/4412180768/' },
      { company: 'Sila', title: 'Battery Engineer' },
    ],
  };

  const jobs = [
    { id: '111', title: 'Wafer Inspection Engineer', company: 'KLA', location: 'Milpitas, CA', isEasyApply: true,  fitScore: 92 },
    { id: '222', title: 'Process Engineer',          company: 'Lam Research', location: 'Fremont, CA', isEasyApply: false, applyUrl: 'https://boards.greenhouse.io/lam/jobs/1', fitScore: 88 },
    { id: '333', title: 'Metrology Engineer',        company: 'Onto Innovation', location: 'Milpitas, CA', isEasyApply: true, fitScore: 55 }, // below threshold
    { id: '444', title: 'Process Engineer',          company: 'Applied Materials', location: 'Santa Clara, CA', isEasyApply: true, fitScore: 90 }, // excluded company
    { id: '4412180768', title: 'Quality Engineer I', company: 'Cordis', isEasyApply: true, fitScore: 80 }, // already applied (jobId + key)
    { id: '555', title: 'Yield Engineer',            company: 'Cerebras Systems', isEasyApply: true, fitScore: 85 }, // export-controlled
    { id: '666', title: 'Equipment Engineer',        company: 'ASML', location: 'San Jose, CA', isEasyApply: false, applyUrl: 'https://boards.greenhouse.io/asml/jobs/2', fitScore: 78 },
    { id: '777', title: 'Process Engineer',          company: 'Lam Research', isEasyApply: false, applyUrl: 'x', fitScore: 70 }, // dup company::title of 222
  ];

  const r = routeJobs(jobs, storage, { threshold: 60 });

  // split
  t.eq(r.ea.length, 1, 'router: 1 Easy Apply survivor (KLA)');
  t.eq(r.ea[0].company, 'KLA', 'router: EA queue has the wafer-inspection role');
  t.eq(r.external.length, 2, 'router: 2 external survivors (Lam, ASML)');

  // highest-fit first within external (Lam 88 before ASML 78)
  t.eq(r.external[0].company, 'Lam Research', 'router: external sorted by fit desc');

  // exclusions / dedupe
  const skipReasons = r.skipped.reduce((m, s) => (m[s.skipReason] = (m[s.skipReason] || 0) + 1, m), {});
  t.ok(skipReasons.below_threshold >= 1, 'router: drops below-threshold (Onto 55)');
  t.ok(skipReasons.excluded_company >= 1, 'router: drops Applied Materials');
  t.ok(skipReasons.already_applied >= 1, 'router: drops already-applied Cordis (jobId + key)');
  t.ok(skipReasons.export_controlled >= 1, 'router: drops export-controlled Cerebras');
  t.ok(skipReasons.dup_in_run >= 1, 'router: drops in-run duplicate (2nd Lam Process Engineer)');

  // no Applied Materials / Cerebras leaked into either queue
  const all = [...r.ea, ...r.external].map(j => j.company);
  t.ok(!all.includes('Applied Materials'), 'router: Applied Materials never queued');
  t.ok(!all.includes('Cerebras Systems'), 'router: export-controlled never queued');

  // empty input → empty queues, no throw
  const e = routeJobs([], {}, {});
  t.eq(e.ea.length + e.external.length, 0, 'router: empty input → empty queues');
};
