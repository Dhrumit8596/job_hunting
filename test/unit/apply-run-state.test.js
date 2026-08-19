'use strict';

const RunState = require('../../apply-run-state');

module.exports = t => {
  const now = 1_000_000;
  const run = {
    runId: 'apply-1', status: 'applying', currentIndex: 1, inFlightIndex: 1,
    jobs: [
      { id: 'a', company: 'A', title: 'One', channel: 'external', strategy: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/a' },
      { id: 'b', company: 'B', title: 'Two', channel: 'indeed_apply', applyUrl: 'https://indeed.com/viewjob?jk=1' },
    ],
    results: { confirmed: [{ id: 'a' }], failed: [], skipped: [], unverified: [] },
    targetConfirmed: 5, remaining: 4, startedAt: now - 100000, inFlightAt: now - 10000,
  };
  const snapshot = RunState.createSnapshot(run, { now, clients: 1, handlerBudgetMs: 30000 });
  t.eq(snapshot.schemaVersion, 2, 'run state: public schema is versioned');
  t.eq(snapshot.runId, 'apply-1', 'run state: run id is preserved');
  t.eq(snapshot.phase, 'handler', 'run state: in-flight work is a handler phase');
  t.eq(snapshot.category, 'indeed_apply', 'run state: native channel is the public category');
  t.eq(snapshot.attempt, 2, 'run state: attempt is one-based');
  t.eq(snapshot.confirmed, 1, 'run state: results are counted');
  t.eq(snapshot.health, 'waiting', 'run state: work within budget is waiting');
  t.eq(snapshot.nextAction, 'waiting_for_handler', 'run state: next action is deterministic');
  t.eq(RunState.validateSnapshot(snapshot), [], 'run state: generated snapshot validates');

  const explicitlyDispatching = RunState.createSnapshot({ ...run, phase: 'dispatching' },
    { now, clients: 1, handlerBudgetMs: 30000 });
  t.eq(explicitlyDispatching.phase, 'handler',
    'run state: active handler ownership takes precedence over a stale dispatch phase');

  const stalled = RunState.createSnapshot(run, { now, clients: 1, handlerBudgetMs: 5000 });
  t.eq(stalled.health, 'stalled', 'run state: handler budget detects a stall');
  t.eq(stalled.nextAction, 'inspect_active_apply', 'run state: stalled work requests inspection');
  const noisyWrite = RunState.createSnapshot({ ...run, updatedAt: now },
    { now, clients: 1, handlerBudgetMs: 5000 });
  t.eq(noisyWrite.health, 'stalled',
    'run state: non-transition snapshot writes cannot hide a stalled handler');

  const workdayStartedAt = 2_000_000;
  const workday = {
    ...run,
    currentIndex: 0,
    inFlightIndex: 0,
    inFlightAt: workdayStartedAt,
    lastTransitionAt: workdayStartedAt,
    workdayAttemptTimeoutMs: 12 * 60 * 1000,
    jobs: [{ id: 'wd', company: 'A', title: 'Process Engineer', channel: 'external',
      strategy: 'workday', applyUrl: 'https://acme.wd1.myworkdayjobs.com/job/1' }],
  };
  t.eq(RunState.createSnapshot(workday,
    { now: workdayStartedAt + 180001, clients: 1 }).health, 'waiting',
  'run state: Workday remains active after the former three-minute cutoff');
  t.eq(RunState.createSnapshot(workday,
    { now: workdayStartedAt + 719999, clients: 1 }).health, 'waiting',
  'run state: Workday remains bounded but waiting immediately inside twelve minutes');
  t.eq(RunState.createSnapshot(workday,
    { now: workdayStartedAt + 720001, clients: 1 }).health, 'stalled',
  'run state: Workday becomes stalled immediately after the twelve-minute bound');

  const disconnected = RunState.createSnapshot(run, { now, clients: 0 });
  t.eq(disconnected.health, 'disconnected', 'run state: missing extension is explicit');

  const planning = RunState.createSnapshot({ runId: 'plan-1', status: 'planning', phase: 'sourcing',
    jobs: [], counts: {}, startedAt: now - 1000, updatedAt: now - 500 }, { now, clients: 1 });
  t.ok(planning.active, 'run state: planning is active before a browser queue exists');
  t.eq(planning.phase, 'sourcing', 'run state: planning preserves its observable phase');

  const terminal = RunState.createSnapshot({ ...run, status: 'done', finishedAt: now }, { now, clients: 1 });
  t.eq(terminal.phase, 'terminal', 'run state: terminal status maps to terminal phase');
  t.eq(terminal.terminalReason, 'done', 'run state: terminal reason defaults to status');

  const advanced = RunState.reduceRun(run, { runId: 'apply-1', phase: 'recovery', status: 'paused_for_fix', occurredAt: now }, { now });
  t.eq(advanced.phase, 'recovery', 'run state: reducer applies a valid phase');
  t.eq(advanced.lastTransitionAt, now, 'run state: meaningful transition stamps time');
  let rejected = false;
  try { RunState.reduceRun(run, { runId: 'other', status: 'done' }); } catch (e) { rejected = e.message === 'run_ownership_mismatch'; }
  t.ok(rejected, 'run state: reducer rejects wrong-run events');
};
