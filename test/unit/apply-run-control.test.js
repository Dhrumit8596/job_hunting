'use strict';

const Control = require('../../apply-run-control');

module.exports = t => {
  const created = Control.build(null, { runId: 'apply-1', phase: 'sourcing', targetConfirmed: 20 },
    { create: true, now: 1000 });
  t.eq(created.status, 'planning', 'run control: admission creates active planning state');
  t.eq(created.phase, 'sourcing', 'run control: admission phase is observable');
  t.ok(Control.ownsPlanning(created, 'apply-1'), 'run control: matching planner owns queue installation');

  const failed = Control.build(created, { runId: 'apply-1', status: 'failed', error: 'source fetch failed' },
    { now: 2000 });
  t.eq(failed.phase, 'terminal', 'run control: terminal transition closes the planning phase');
  t.ok(!Control.ownsPlanning(failed, 'apply-1'), 'run control: failed worker loses queue-install ownership');

  let rejected = false;
  try { Control.build(created, { runId: 'apply-2', phase: 'planning' }, { now: 2000 }); }
  catch (e) { rejected = /ownership mismatch/.test(e.message); }
  t.ok(rejected, 'run control: an old worker cannot overwrite another run identity');
  t.ok(Control.isActive(created, { now: 1500, maxAgeMs: 1000 }), 'run control: recent planning blocks concurrent admission');
  t.ok(!Control.isActive(created, { now: 2500, maxAgeMs: 1000 }), 'run control: abandoned planning cannot deadlock admission forever');

  const drops = Control.compactPlanningDrops({
    total: 99,
    counts: { rescore_below_threshold: 80, prior_blocked_host: 19 },
    examples: Array.from({ length: 20 }, (_, i) => ({
      id: `job-${i}`, company: 'Example', title: `Role ${i}`, reason: 'rescore_below_threshold',
      applyUrl: `https://example.com/jobs/${i}`, description: 'must never enter compact run control',
    })),
  });
  t.eq(drops.total, 99, 'run control: zero-queue planning retains exact drop total');
  t.eq(drops.counts.prior_blocked_host, 19, 'run control: zero-queue planning retains grouped reasons');
  t.eq(drops.examples.length, 12, 'run control: planning examples are bounded');
  t.ok(!Object.prototype.hasOwnProperty.call(drops.examples[0], 'description'),
    'run control: planning examples omit descriptions and unapproved fields');
  const exhausted = Control.build(created, {
    runId: 'apply-1', status: 'exhausted', terminalReason: 'nothing eligible', planningDrops: drops,
  }, { now: 3000 });
  t.eq(exhausted.planningDrops.total, 99, 'run control: nothing-eligible terminal state preserves compact planning evidence');
};
