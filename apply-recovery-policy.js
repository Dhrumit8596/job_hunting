'use strict';

// Deterministic watcher policy. Browser mutation remains in the existing service-worker watchdog;
// this module tells operators/agents when to wait, inspect, resume, or stop without model inference.
function decideRecovery(snapshot, options = {}) {
  if (!snapshot) return { action: 'stop', reason: 'run_not_found', terminal: true };
  if (snapshot.health === 'terminal') return { action: 'export_report', reason: snapshot.terminalReason || snapshot.status, terminal: true };
  if (snapshot.health === 'disconnected') return { action: 'restore_connection', reason: 'extension_disconnected', terminal: false };
  if (snapshot.health === 'manual') return { action: 'stop_for_manual', reason: snapshot.status || 'manual_action_required', terminal: false };
  if (snapshot.health === 'stalled') {
    const attempts = Math.max(0, Number(options.recoveryAttempts) || 0);
    if (attempts === 0) return { action: 'inspect', reason: 'handler_budget_exceeded', terminal: false };
    if (attempts === 1 && options.allowResume === true) return { action: 'resume', reason: 'stalled_after_inspection', terminal: false };
    return { action: 'stop_for_fix', reason: 'stalled_after_bounded_recovery', terminal: false };
  }
  return { action: 'wait', reason: snapshot.nextAction || 'progressing', terminal: false };
}

module.exports = { decideRecovery };

