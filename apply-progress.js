'use strict';

const RunState = require('./apply-run-state');

function runFromStorage(storage, runId) {
  const active = storage && storage.pja_ranked_apply || null;
  const completed = storage && storage.pja_last_completed_apply_run || null;
  if (runId) {
    if (active && active.runId === runId) return active;
    if (completed && completed.runId === runId) return completed;
    return null;
  }
  return active || completed || null;
}

function publicProgress(storage = {}, options = {}) {
  const run = runFromStorage(storage, options.runId);
  if (!run) return null;
  const snapshot = RunState.createSnapshot(run, {
    clients: options.clients,
    now: options.now,
    handlerBudgetMs: options.handlerBudgetMs,
    reportPath: options.reportPath,
  });
  const rawLastFailure = storage.pja_last_apply_failure || null;
  const failureJobId = String(rawLastFailure && (rawLastFailure.jobId || rawLastFailure.id) || '');
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const failureOwned = !!(rawLastFailure && (
    rawLastFailure.runId && rawLastFailure.runId === snapshot.runId ||
    !rawLastFailure.runId && failureJobId && jobs.some(job =>
      String(job.jobId || job.id || '') === failureJobId)
  ));
  const failed = run.results && Array.isArray(run.results.failed) ? run.results.failed : [];
  const lastFailure = failureOwned ? rawLastFailure : failed[failed.length - 1] || null;
  return {
    ...snapshot,
    lastFailure: lastFailure ? {
      reason: String(lastFailure.reason || '').slice(0, 120),
      company: String(lastFailure.company || '').slice(0, 120),
      title: String(lastFailure.title || '').slice(0, 160),
      ats: String(lastFailure.ats || '').slice(0, 60),
    } : null,
  };
}

function runEvents(storage = {}, options = {}) {
  const runId = String(options.runId || '');
  if (!runId) return [];
  const after = Math.max(0, Number(options.after) || 0);
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 80));
  const run = runFromStorage(storage, runId);
  if (!run) return [];
  const ledger = storage.pja_application_ledger || {};
  const rows = Object.values(ledger.events || {})
    .filter(event => event && event.runId === runId)
    .map(event => ({
      cursor: Number(event.occurredAt || event.applicationAt) || 0,
      runId,
      jobId: String(event.jobId || event.id || '').slice(0, 180),
      phase: String(event.phase || 'handler').slice(0, 60),
      status: String(event.status || '').slice(0, 60),
      reason: String(event.reason || '').slice(0, 120),
      company: String(event.company || '').slice(0, 120),
      title: String(event.title || '').slice(0, 160),
      channel: String(event.channel || '').slice(0, 60),
      occurredAt: Number(event.occurredAt || event.applicationAt) || null,
    }));
  const synthetic = [];
  if (run.startedAt) synthetic.push({ cursor: Number(run.startedAt), runId, phase: 'dispatching', status: 'started', reason: 'run_installed', occurredAt: Number(run.startedAt) });
  if (run.finishedAt) synthetic.push({ cursor: Number(run.finishedAt), runId, phase: 'terminal', status: String(run.status || ''), reason: String(run.terminalReason || run.status || ''), occurredAt: Number(run.finishedAt) });
  return synthetic.concat(rows)
    .filter(event => event.cursor > after)
    .sort((a, b) => a.cursor - b.cursor || String(a.jobId || '').localeCompare(String(b.jobId || '')))
    .slice(0, limit);
}

module.exports = { runFromStorage, publicProgress, runEvents };
