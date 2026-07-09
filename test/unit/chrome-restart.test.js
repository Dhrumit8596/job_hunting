'use strict';
// Tests for the P1c Chrome-restart command builder. Pure string construction —
// NEVER launches a process. Guards the shell-injection surface (reopenUrl).
const path = require('path');
const { buildRestartPlan, isSafeUrl } = require(path.resolve(__dirname, '../../chrome-restart'));

module.exports = (t) => {
  // --- isSafeUrl ---
  t.eq(isSafeUrl('https://job-boards.greenhouse.io/embed/job_app?token=1&for=x'), true, 'safeUrl: https ok');
  t.eq(isSafeUrl('http://localhost:6174/x'), true, 'safeUrl: http ok');
  t.eq(isSafeUrl('javascript:alert(1)'), false, 'safeUrl: javascript rejected');
  t.eq(isSafeUrl('https://x.com/a;rm -rf /'), false, 'safeUrl: shell metachars rejected');
  t.eq(isSafeUrl('https://x.com/$(whoami)'), false, 'safeUrl: command-substitution rejected');
  t.eq(isSafeUrl(''), false, 'safeUrl: empty rejected');
  t.eq(isSafeUrl(null), false, 'safeUrl: null rejected');

  // --- buildRestartPlan on macOS ---
  const mac = buildRestartPlan({ platform: 'darwin' });
  t.eq(mac.supported, true, 'plan: darwin supported');
  t.ok(/osascript/.test(mac.quitCmd), 'plan: quit uses osascript');
  t.ok(/tell application "Google Chrome" to quit/.test(mac.quitCmd), 'plan: quit is graceful (not kill)');
  t.ok(/^open -a /.test(mac.relaunchCmd), 'plan: relaunch uses open -a');
  t.eq(mac.waitMs, 3000, 'plan: default waitMs');

  // --- reopenUrl handling ---
  const withUrl = buildRestartPlan({ platform: 'darwin', reopenUrl: 'https://jobs.ashbyhq.com/x/y/application' });
  t.ok(withUrl.relaunchCmd.includes('jobs.ashbyhq.com/x/y/application'), 'plan: safe reopenUrl included');
  const badUrl = buildRestartPlan({ platform: 'darwin', reopenUrl: 'https://x.com/a;rm -rf ~' });
  t.eq(badUrl.reopenUrl, null, 'plan: unsafe reopenUrl dropped');
  t.ok(!/rm -rf/.test(badUrl.relaunchCmd), 'plan: unsafe reopenUrl never reaches command');

  // --- custom browser name is quoted, not injectable ---
  const custom = buildRestartPlan({ platform: 'darwin', browser: 'Google Chrome Canary' });
  t.ok(/Google Chrome Canary/.test(custom.quitCmd), 'plan: custom browser name honored');

  // --- non-macOS is unsupported (no command emitted) ---
  const lin = buildRestartPlan({ platform: 'linux' });
  t.eq(lin.supported, false, 'plan: linux unsupported');
  t.ok(!lin.quitCmd, 'plan: no quitCmd on unsupported platform');
};
