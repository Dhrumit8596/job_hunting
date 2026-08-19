'use strict';

const Safety = require('../../sourcing/source-safety');

module.exports = async t => {
  t.ok(Safety.SOURCE_STORAGE_KEYS.includes('pja_application_ledger') &&
    Safety.SOURCE_STORAGE_KEYS.includes('pja_profile') && Safety.SOURCE_STORAGE_KEYS.includes('pja_prefs'),
  'source safety: unified storage preflight includes profile/preferences and the ledger dedupe key');
  const budgets = Safety.calculateWorkflowBudgets({ workflowTimeoutMs: 45 * 60 * 1000,
    sourceTimeoutMs: 35 * 60 * 1000, applyTimeoutMs: 15 * 60 * 1000 });
  t.ok(budgets.sourceClientTimeoutMs + budgets.applyTimeoutMs + budgets.handoffReserveMs <= budgets.workflowTimeoutMs,
    'source safety: source client timeout and apply/handoff reserve fit the overall workflow');
  t.ok(budgets.sourcingBudgetMs < budgets.sourceClientTimeoutMs && budgets.browserBudgetMs < budgets.sourcingBudgetMs,
    'source safety: sourcing and browser work finish before their enclosing client deadlines');
  let impossible = '';
  try { Safety.calculateWorkflowBudgets({ workflowTimeoutMs: 60000, applyTimeoutMs: 50000,
    handoffReserveMs: 15000, minimumSourceClientMs: 10000 }); } catch (error) { impossible = error.code; }
  t.eq(impossible, 'invalid_sourcing_timeout_budget',
    'source safety: impossible timeout relationships are rejected before sourcing');

  let reads = 0;
  const observed = await Safety.readObservedSourcingStorage(async () => {
    reads += 1;
    return reads === 1 ? {} : { pja_profile: {}, pja_prefs: {} };
  }, { attempts: 3, retryDelayMs: 0 });
  t.eq({ reads, attempts: observed.attempts }, { reads: 2, attempts: 2 },
    'source safety: transient empty transport read is retried until profile/preferences keys are observed');
  let unavailable = '';
  try {
    await Safety.readObservedSourcingStorage(async () => ({}), { attempts: 3, retryDelayMs: 0 });
  } catch (error) { unavailable = error.code; }
  t.eq(unavailable, 'source_storage_unavailable',
    'source safety: exhausted storage reads fail closed with an explicit service error');
  let browserDiscoveryCalls = 0, importCalls = 0;
  try {
    await Safety.withObservedSourcingStorage(async () => ({}), async () => {
      browserDiscoveryCalls += 1;
      importCalls += 1;
    }, { attempts: 2, retryDelayMs: 0 });
  } catch (_) {}
  t.eq({ browserDiscoveryCalls, importCalls }, { browserDiscoveryCalls: 0, importCalls: 0 },
    'source safety: fail-closed storage error prevents browser discovery and corpus import stages');
  t.eq(browserDiscoveryCalls, 0,
    'source safety: missing storage cannot reach location/title derivation and trigger a United States fallback search');

  const deadline = 10000;
  t.eq(Safety.sourceDecision({ runId: 'run-a', deadlineMs: deadline, now: 100,
    connected: true, controlObserved: true,
    control: { runId: 'run-a', status: 'planning', phase: 'sourcing' } }).ok, true,
  'source safety: normal owned sourcing run remains authorized');
  t.eq(Safety.sourceDecision({ runId: 'run-a', deadlineMs: deadline, now: deadline,
    connected: true, controlObserved: true,
    control: { runId: 'run-a', status: 'planning', phase: 'sourcing' } }).code,
  'sourcing_deadline_exceeded', 'source safety: deadline error is distinct');
  t.eq(Safety.sourceDecision({ runId: 'run-a', deadlineMs: deadline, now: 100,
    connected: false }).code, 'extension_disconnected',
  'source safety: extension disconnect error is distinct');
  t.eq(Safety.sourceDecision({ runId: 'run-a', deadlineMs: deadline, now: 100,
    connected: true, controlObserved: true,
    control: { runId: 'run-b', status: 'planning', phase: 'sourcing' } }).code,
  'source_ownership_lost', 'source safety: newer run ownership is distinct');
  t.eq(Safety.sourceDecision({ deadlineMs: deadline, now: 100 }).standalone, true,
    'source safety: standalone source-v2 is permitted but deadline-bounded');
  const standalone = Safety.standaloneDeadline({ now: 100, deadlineMs: 999999,
    sourcingBudgetMs: 5000, maximumBudgetMs: 5000 });
  t.eq(standalone, { deadlineMs: 5100, budgetMs: 5000 },
    'source safety: standalone source-v2 deadline is clamped to its maximum bounded budget');

  let imported = 0;
  const lost = Safety.sourceDecision({ runId: 'old-run', deadlineMs: deadline, now: 100,
    connected: true, controlObserved: true,
    control: { runId: 'new-run', status: 'planning', phase: 'sourcing' } });
  try { await Safety.guardedMutation(lost, async () => { imported += 1; }); } catch (_) {}
  t.eq(imported, 0,
    'source safety: old run cannot import after newer run owns durable control');
  const terminal = Safety.sourceDecision({ runId: 'old-run', deadlineMs: deadline, now: 100,
    connected: true, controlObserved: true,
    control: { runId: 'old-run', status: 'failed', phase: 'terminal' } });
  try { await Safety.guardedMutation(terminal, async () => { imported += 1; }); } catch (_) {}
  t.eq(imported, 0, 'source safety: terminal old run cannot import after its workflow ended');
  const owned = Safety.sourceDecision({ runId: 'run-a', deadlineMs: deadline, now: 100,
    connected: true, controlObserved: true,
    control: { runId: 'run-a', status: 'planning', phase: 'sourcing' } });
  await Safety.guardedMutation(owned, async () => { imported += 1; });
  t.eq(imported, 1, 'source safety: owned run can still complete its corpus import');
};
