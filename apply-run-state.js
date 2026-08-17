'use strict';

// Pure public state contract for one ranked application run. This module deliberately has no
// Chrome, HTTP, filesystem, or model dependencies so the service worker, dev server, UI, CLI, and
// tests can agree on status without reconstructing it from prose or raw logs.
(function (root) {
  const SCHEMA_VERSION = 2;
  const TERMINAL_STATUSES = new Set(['done', 'exhausted', 'day_changed', 'aborted', 'cancelled', 'failed']);
  const ACTIVE_STATUSES = new Set(['planning', 'applying', 'paused_for_patch', 'paused_for_fix']);
  const PHASES = new Set(['preflight', 'sourcing', 'planning', 'dispatching', 'handler', 'recovery', 'reporting', 'terminal']);
  const HEALTH = new Set(['healthy', 'waiting', 'stalled', 'manual', 'disconnected', 'terminal']);

  function text(value, max = 160) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES.has(String(status || '').toLowerCase());
  }

  function resultCounts(run) {
    const results = run && run.results || {};
    const stored = run && run.counts || {};
    const count = key => Array.isArray(results[key]) ? results[key].length : Math.max(0, Number(stored[key]) || 0);
    return {
      confirmed: count('confirmed'),
      unverified: count('unverified'),
      failed: count('failed'),
      skipped: count('skipped'),
    };
  }

  function selectedIndex(run) {
    if (!run) return 0;
    if (run.inFlightIndex != null && Number.isFinite(Number(run.inFlightIndex))) return Math.max(0, Number(run.inFlightIndex));
    return Math.max(0, Number(run.currentIndex) || 0);
  }

  function currentJob(run) {
    const jobs = Array.isArray(run && run.jobs) ? run.jobs : [];
    return jobs[selectedIndex(run)] || null;
  }

  function strategyFor(job) {
    const channel = text(job && job.channel, 60).toLowerCase();
    if (channel === 'linkedin_easy_apply') return 'linkedin_easy_apply';
    if (channel === 'indeed_apply') return 'indeed_apply';
    return text(job && (job.strategy || job.ats) || 'generic', 60).toLowerCase() || 'generic';
  }

  function publicJob(job) {
    if (!job) return null;
    let host = '';
    try { host = new URL(String(job.applyUrl || '')).hostname.toLowerCase(); } catch (_) {}
    return {
      id: text(job.id || job.jobId || job.sourceJobId, 180),
      company: text(job.company, 120),
      title: text(job.title, 160),
      channel: text(job.channel || 'external', 60),
      strategy: strategyFor(job),
      host: text(host, 120),
    };
  }

  function handlerBudgetMs(run, job, options = {}) {
    if (options.handlerBudgetMs != null) return Math.max(1000, Number(options.handlerBudgetMs) || 0);
    if (run && run.workdayAttemptTimeoutMs != null && /workday/i.test(strategyFor(job))) {
      return Math.max(30000, Number(run.workdayAttemptTimeoutMs) || 0);
    }
    return Math.max(30000, Number(run && run.handlerTimeoutMs) || 5 * 60 * 1000);
  }

  function derivePhase(run) {
    if (!run) return 'terminal';
    if (isTerminalStatus(run.status)) return 'terminal';
    if (/^paused_/i.test(String(run.status || ''))) return 'recovery';
    if (run.inFlightIndex != null || run.inFlightTabId != null || run.inFlightAt) return 'handler';
    if (PHASES.has(String(run.phase || ''))) return String(run.phase);
    return 'dispatching';
  }

  function deriveHealth(run, options = {}) {
    if (!run || isTerminalStatus(run.status)) return 'terminal';
    if (Number(options.clients) < 1) return 'disconnected';
    if (/^paused_/i.test(String(run.status || ''))) return 'manual';
    const now = Number(options.now) || Date.now();
    const transitionAt = Number(options.lastTransitionAt) || Math.max(0,
      Number(run.lastTransitionAt) || 0, Number(run.inFlightAt) || 0,
      Number(run.startedAt) || 0, Number(run.finishedAt) || 0) || now;
    const ageMs = Math.max(0, now - transitionAt);
    if (derivePhase(run) === 'handler' && ageMs > handlerBudgetMs(run, currentJob(run), options)) return 'stalled';
    return derivePhase(run) === 'handler' ? 'waiting' : 'healthy';
  }

  function nextActionFor(health, phase) {
    if (health === 'terminal') return 'export_report';
    if (health === 'disconnected') return 'restore_extension_connection';
    if (health === 'manual') return 'await_manual_action';
    if (health === 'stalled') return 'inspect_active_apply';
    if (phase === 'handler') return 'waiting_for_handler';
    if (phase === 'dispatching') return 'waiting_for_dispatch';
    return 'wait';
  }

  function createSnapshot(run, options = {}) {
    if (!run || !run.runId) return null;
    const now = Number(options.now) || Date.now();
    const job = currentJob(run);
    const counts = resultCounts(run);
    const phase = derivePhase(run);
    const lastTransitionAt = Math.max(0, Number(run.lastTransitionAt) || 0,
      Number(run.inFlightAt) || 0,
      Number(run.startedAt) || 0, Number(run.finishedAt) || 0) || now;
    const health = deriveHealth(run, { ...options, now, lastTransitionAt });
    const status = text(run.status || '', 60).toLowerCase();
    const total = Array.isArray(run.jobs) ? run.jobs.length : Math.max(0, Number(run.total) || 0);
    const category = text(run.category || strategyFor(job), 60).toLowerCase();
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: text(run.runId, 180),
      status,
      active: isActiveStatus(status),
      phase,
      category,
      currentIndex: Math.max(0, Number(run.currentIndex) || 0),
      inFlightIndex: run.inFlightIndex == null ? null : Math.max(0, Number(run.inFlightIndex) || 0),
      total,
      attempt: total ? Math.min(total, selectedIndex(run) + 1) : 0,
      targetConfirmed: run.targetConfirmed == null ? null : Math.max(0, Number(run.targetConfirmed) || 0),
      remaining: run.remaining == null ? null : Math.max(0, Number(run.remaining) || 0),
      ...counts,
      currentJob: publicJob(job),
      startedAt: Number(run.startedAt) || null,
      updatedAt: Number(run.updatedAt || run.inFlightAt || run.startedAt) || null,
      lastTransitionAt,
      secondsSinceTransition: Math.floor(Math.max(0, now - lastTransitionAt) / 1000),
      health,
      nextAction: nextActionFor(health, phase),
      terminalReason: isTerminalStatus(status) ? text(run.terminalReason || status, 120) : null,
      reportPath: text(options.reportPath || run.reportPath, 500) || null,
    };
  }

  function validateSnapshot(snapshot) {
    const errors = [];
    if (!snapshot || typeof snapshot !== 'object') return ['snapshot_required'];
    if (snapshot.schemaVersion !== SCHEMA_VERSION) errors.push('unsupported_schema_version');
    if (!snapshot.runId) errors.push('run_id_required');
    if (!PHASES.has(snapshot.phase)) errors.push('invalid_phase');
    if (!HEALTH.has(snapshot.health)) errors.push('invalid_health');
    if (!Number.isInteger(snapshot.currentIndex) || snapshot.currentIndex < 0) errors.push('invalid_current_index');
    return errors;
  }

  function reduceRun(run, event, options = {}) {
    if (!run || !run.runId) throw new Error('run_id_required');
    if (!event || event.runId !== run.runId) throw new Error('run_ownership_mismatch');
    const now = Number(options.now || event.occurredAt) || Date.now();
    const next = { ...run, updatedAt: now };
    if (event.phase && PHASES.has(String(event.phase))) next.phase = String(event.phase);
    if (event.status) next.status = text(event.status, 60).toLowerCase();
    if (event.currentIndex != null) next.currentIndex = Math.max(0, Number(event.currentIndex) || 0);
    if (event.inFlightIndex === null) next.inFlightIndex = null;
    else if (event.inFlightIndex != null) next.inFlightIndex = Math.max(0, Number(event.inFlightIndex) || 0);
    if (event.meaningful !== false) next.lastTransitionAt = now;
    if (isTerminalStatus(next.status)) {
      next.phase = 'terminal';
      next.finishedAt = Number(next.finishedAt) || now;
      next.terminalReason = text(event.reason || next.terminalReason || next.status, 120);
    }
    return next;
  }

  const API = { SCHEMA_VERSION, TERMINAL_STATUSES, ACTIVE_STATUSES, PHASES, HEALTH,
    isTerminalStatus, isActiveStatus, resultCounts, currentJob, strategyFor, publicJob,
    handlerBudgetMs, derivePhase, deriveHealth, createSnapshot, validateSnapshot, reduceRun };
  if (root) root.PJAApplyRunState = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
