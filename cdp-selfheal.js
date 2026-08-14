'use strict';
// P1c self-heal decision logic — the "brain" of the CDP recovery ladder. PURE and testable:
// given the running state + the latest apply outcome, it decides WHICH recovery rung to run.
// The extension wires the actions (debugger detach/reattach → /reload → /restart-chrome); this
// module only decides, so the escalation policy is unit-tested without a browser.
//
// Degraded-CDP signature (observed 2026-07-09): the form FILLS but SUBMIT fails because a
// react-select (country/education/policy) never commits — i.e. trusted CDP events aren't landing.
// One such failure can be a hard form; K CONSECUTIVE ones mean CDP itself is degraded.

(function (root) {
const RUNGS = ['none', 'reattach', 'reload', 'restart'];

function initState() {
  return { consecutiveDegraded: 0, rungIndex: 0, lastAction: 'none' };
}

// outcome: { filled: bool, submitted: bool, reactSelectError: bool }
// A "degraded" datapoint = filled && !submitted && reactSelectError (fill-but-no-commit).
// opts.threshold: consecutive degraded needed before the FIRST heal (default 2).
function isDegradedOutcome(o) {
  return !!(o && o.filled && !o.submitted && o.reactSelectError);
}

// Returns { state, action } — action is the rung to run now ('none' | 'reattach' | 'reload' | 'restart').
// Escalation: once threshold consecutive degraded is hit, run the NEXT rung each further degraded
// outcome (reattach → reload → restart), capping at 'restart'. Any healthy submit resets everything.
function nextSelfHeal(prev, outcome, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 2;
  const state = prev ? { ...prev } : initState();

  if (!isDegradedOutcome(outcome)) {
    // A real submit (or a non-CDP failure) clears the degraded streak and the escalation.
    if (outcome && outcome.submitted) return { state: initState(), action: 'none' };
    // Non-degraded, non-submit (e.g. skipped for honest reasons) — don't count toward CDP degradation.
    return { state, action: 'none' };
  }

  state.consecutiveDegraded += 1;
  if (state.consecutiveDegraded < threshold) return { state, action: 'none' };

  // Threshold reached (or already healing) → escalate to the next rung.
  state.rungIndex = Math.min(state.rungIndex + 1, RUNGS.length - 1);
  state.lastAction = RUNGS[state.rungIndex];
  return { state, action: state.lastAction };
}

const API = { initState, isDegradedOutcome, nextSelfHeal, RUNGS };
if (root) root.PJACdpSelfHeal = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
