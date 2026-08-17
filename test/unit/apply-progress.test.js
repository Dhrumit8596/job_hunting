'use strict';

const Progress = require('../../apply-progress');

module.exports = t => {
  const active = { runId: 'active', status: 'applying', currentIndex: 0, jobs: [{ id: '1', company: 'A', title: 'Role', channel: 'external', strategy: 'lever' }], results: {}, startedAt: 100, updatedAt: 200 };
  const completed = { runId: 'done', status: 'done', currentIndex: 1, jobs: [{ id: '2', company: 'B', title: 'Role', channel: 'external', strategy: 'ashby' }], counts: { confirmed: 1 }, startedAt: 10, finishedAt: 50, updatedAt: 50 };
  const planning = { schemaVersion: 2, runId: 'planning', status: 'planning', phase: 'sourcing',
    currentIndex: 0, total: 0, jobs: [], counts: {}, targetConfirmed: 20, startedAt: 500, updatedAt: 600 };
  const storage = { pja_ranked_apply: active, pja_last_completed_apply_run: completed,
    pja_apply_run_control: planning,
    pja_application_ledger: { events: {
      a: { runId: 'active', jobId: '1', company: 'A', title: 'Role', channel: 'external', status: 'failed', reason: 'missing_required', occurredAt: 300 },
      b: { runId: 'other', status: 'failed', occurredAt: 400 },
    } } };
  t.eq(Progress.runFromStorage(storage, 'done').runId, 'done', 'progress: completed run can be selected by id');
  t.eq(Progress.runFromStorage(storage, 'planning').runId, 'planning', 'progress: durable planning run can be selected by id');
  t.eq(Progress.runFromStorage(storage, 'missing'), null, 'progress: unknown id never falls back to latest');
  t.eq(Progress.publicProgress(storage, { runId: 'active', clients: 1, now: 250 }).runId, 'active', 'progress: public snapshot selects exact run');
  const planningProgress = Progress.publicProgress({ pja_apply_run_control: planning }, { runId: 'planning', clients: 1, now: 700 });
  t.eq(planningProgress.phase, 'sourcing', 'progress: sourcing is visible before queue installation');
  t.ok(planningProgress.active, 'progress: planning is an active lifecycle status');
  const scoped = Progress.publicProgress({ ...storage,
    pja_ranked_apply: { ...active, results: { failed: [{ id: '1', company: 'A', title: 'Role', reason: 'stuck', ats: 'lever' }] } },
    pja_last_apply_failure: { id: 'old', company: 'Old', title: 'Old role', reason: 'old_failure', ats: 'workday' },
  }, { runId: 'active', clients: 1, now: 250 });
  t.eq(scoped.lastFailure.reason, 'stuck', 'progress: unrelated global failure cannot leak into an exact run');
  const events = Progress.runEvents(storage, { runId: 'active', after: 150 });
  t.eq(events.length, 1, 'progress: events are filtered by run and cursor');
  t.eq(events[0].reason, 'missing_required', 'progress: bounded ledger evidence is retained');
};
