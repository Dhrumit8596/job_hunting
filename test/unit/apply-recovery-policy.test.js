'use strict';

const { decideRecovery } = require('../../apply-recovery-policy');

module.exports = t => {
  t.eq(decideRecovery(null).action, 'stop', 'recovery: missing run stops');
  t.eq(decideRecovery({ health: 'waiting', nextAction: 'waiting_for_handler' }).action, 'wait', 'recovery: healthy work waits');
  t.eq(decideRecovery({ health: 'stalled' }, { recoveryAttempts: 0 }).action, 'inspect', 'recovery: first stall is inspected');
  t.eq(decideRecovery({ health: 'stalled' }, { recoveryAttempts: 1, allowResume: true }).action, 'resume', 'recovery: one bounded resume can be allowed');
  t.eq(decideRecovery({ health: 'stalled' }, { recoveryAttempts: 2, allowResume: true }).action, 'stop_for_fix', 'recovery: repeated stalls stop for a fix');
  t.eq(decideRecovery({ health: 'terminal', status: 'done' }).action, 'export_report', 'recovery: terminal run exports report');
};

