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
};
