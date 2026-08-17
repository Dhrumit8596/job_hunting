'use strict';

// Pure pre-queue lifecycle rules. The dev server owns orchestration and the extension owns durable
// storage, but neither should invent merge/ownership semantics independently.
const RunState = require('./apply-run-state');

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

module.exports = { build, isActive, ownsPlanning };
