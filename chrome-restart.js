'use strict';
// Helper for the P1c CDP self-heal ladder's last rung: a graceful Chrome restart.
// The dev server (Node, has OS access) drives the actual quit+relaunch; the extension
// owns detection + the notify/countdown. Kept as a separate module so the command
// construction is unit-testable WITHOUT ever launching a real process.
//
// Design choices:
//  - GRACEFUL quit (AppleScript "tell application ... to quit"), NOT kill/pkill, so Chrome
//    saves the session and restores tabs (incl. the in-flight apply tab) on relaunch.
//  - Relaunch reopens the same profile via `open -a` (session restore brings back the
//    extension + logged-in Gmail/Workday). An optional reopenUrl guarantees the MV3
//    service worker wakes and reconnects the dev-server WebSocket.
//  - reopenUrl is validated to http(s) only — never interpolate arbitrary text into a shell.

// Only http/https URLs. The URL is single-quoted in the shell, so `&?=#%` (normal query
// syntax) are safe; we reject only chars that stay dangerous inside single quotes or that
// no legitimate URL contains — whitespace, quotes, backtick, $()<>|;{} and backslash.
function isSafeUrl(u) {
  if (typeof u !== 'string' || !/^https?:\/\//.test(u)) return false;
  return !/[\s'"`$()<>|;{}\\]/.test(u);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Returns { supported, reason?, quitCmd?, relaunchCmd?, waitMs } — plain data, runs nothing.
function buildRestartPlan(opts = {}) {
  const browser = opts.browser || 'Google Chrome';
  const platform = opts.platform || process.platform;
  const waitMs = opts.waitMs != null ? opts.waitMs : 3000;
  const reopenUrl = isSafeUrl(opts.reopenUrl) ? opts.reopenUrl : null;

  if (platform !== 'darwin') {
    return { supported: false, reason: `chrome auto-restart only implemented for macOS (got ${platform})`, waitMs };
  }
  const quitCmd = `osascript -e ${shellQuote(`tell application "${browser}" to quit`)}`;
  const relaunchCmd = reopenUrl
    ? `open -a ${shellQuote(browser)} ${shellQuote(reopenUrl)}`
    : `open -a ${shellQuote(browser)}`;
  return { supported: true, quitCmd, relaunchCmd, waitMs, browser, reopenUrl };
}

module.exports = { buildRestartPlan, isSafeUrl };
