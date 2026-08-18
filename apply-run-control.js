'use strict';

// Pure pre-queue lifecycle rules. The dev server owns orchestration and the extension owns durable
// storage, but neither should invent merge/ownership semantics independently.
const RunState = require('./apply-run-state');
const ReportHealth = require('./apply-report-health');

function compactPlanningDrops(value, options = {}) {
  if (!value || typeof value !== 'object') return null;
  const countLimit = options.countLimit != null ? Math.max(1, Number(options.countLimit) || 1) : 50;
  const exampleLimit = options.exampleLimit != null ? Math.max(0, Number(options.exampleLimit) || 0) : 12;
  const counts = {};
  for (const [rawReason, rawCount] of Object.entries(value.counts || {}).slice(0, countLimit)) {
    const reason = String(rawReason || '').trim().slice(0, 100);
    const count = Math.max(0, Number(rawCount) || 0);
    if (reason && count) counts[reason] = count;
  }
  const examples = Array.isArray(value.examples) ? value.examples.slice(0, exampleLimit).map(row => ({
    id: String(row && (row.id || row.jobId) || '').slice(0, 160),
    company: String(row && row.company || '').slice(0, 160),
    title: String(row && row.title || '').slice(0, 200),
    channel: String(row && row.channel || '').slice(0, 80),
    ats: String(row && row.ats || '').slice(0, 80),
    strategy: String(row && row.strategy || '').slice(0, 80),
    reason: String(row && row.reason || '').slice(0, 100),
    fitScore: row && row.fitScore != null ? Number(row.fitScore) : null,
    applyUrl: String(row && row.applyUrl || '').slice(0, 500),
  })) : [];
  return { total: Math.max(0, Number(value.total) || Object.values(counts).reduce((sum, n) => sum + n, 0)), counts, examples };
}

function build(current, patch, options = {}) {
  if (!patch || !patch.runId) throw new Error('apply run control requires runId');
  if (!options.create && (!current || current.runId !== patch.runId)) {
    throw new Error(`apply run control ownership mismatch for ${patch.runId}`);
  }
  const now = Number(options.now) || Date.now();
  const sameRun = current && current.runId === patch.runId ? current : {};
  const next = Object.assign({
    schemaVersion: RunState.SCHEMA_VERSION,
    status: 'planning',
    phase: 'preflight',
    jobs: [],
    results: { confirmed: [], failed: [], skipped: [], unverified: [] },
    counts: { confirmed: 0, failed: 0, skipped: 0, unverified: 0 },
    currentIndex: 0,
    total: 0,
    startedAt: now,
    initialPhase: 'preflight',
  }, sameRun, patch, { updatedAt: now, lastTransitionAt: now });
  if (Object.prototype.hasOwnProperty.call(patch, 'planningDrops')) {
    next.planningDrops = compactPlanningDrops(patch.planningDrops);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'preflightHealth')) {
    next.preflightHealth = ReportHealth.compactPreflightHealth(patch.preflightHealth);
  }
  if (RunState.isTerminalStatus(next.status)) {
    next.phase = 'terminal';
    next.finishedAt = next.finishedAt || now;
  }
  return next;
}

function isActive(control, options = {}) {
  if (!control || control.status !== 'planning') return false;
  const now = Number(options.now) || Date.now();
  const maxAgeMs = Math.max(1000, Number(options.maxAgeMs) || 60 * 60 * 1000);
  return now - Number(control.updatedAt || control.startedAt || 0) < maxAgeMs;
}

function ownsPlanning(control, runId) {
  return !!(control && control.runId === runId && control.status === 'planning');
}

module.exports = { build, isActive, ownsPlanning, compactPlanningDrops };
