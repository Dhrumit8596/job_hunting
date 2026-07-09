'use strict';
// Tests for the P1c self-heal escalation policy (pure decision logic).
const path = require('path');
const { initState, isDegradedOutcome, nextSelfHeal } = require(path.resolve(__dirname, '../../cdp-selfheal'));

module.exports = (t) => {
  const DEGRADED = { filled: true, submitted: false, reactSelectError: true };
  const SUBMITTED = { filled: true, submitted: true, reactSelectError: false };
  const HONEST_SKIP = { filled: true, submitted: false, reactSelectError: false }; // e.g. subjective Q, not CDP

  // --- classification ---
  t.eq(isDegradedOutcome(DEGRADED), true, 'degraded: fill-but-no-commit');
  t.eq(isDegradedOutcome(SUBMITTED), false, 'degraded: a real submit is not degraded');
  t.eq(isDegradedOutcome(HONEST_SKIP), false, 'degraded: honest skip (no react-select error) is not degraded');

  // --- one degraded outcome does NOT heal (could be a hard form); threshold=2 ---
  let s = initState();
  let r = nextSelfHeal(s, DEGRADED, { threshold: 2 });
  t.eq(r.action, 'none', 'ladder: 1st degraded → no action yet');
  t.eq(r.state.consecutiveDegraded, 1, 'ladder: streak counts');

  // --- 2nd consecutive degraded → first rung (reattach) ---
  r = nextSelfHeal(r.state, DEGRADED, { threshold: 2 });
  t.eq(r.action, 'reattach', 'ladder: threshold hit → reattach debugger');

  // --- still degraded → escalate reload → restart, capping at restart ---
  r = nextSelfHeal(r.state, DEGRADED, { threshold: 2 });
  t.eq(r.action, 'reload', 'ladder: escalates to /reload');
  r = nextSelfHeal(r.state, DEGRADED, { threshold: 2 });
  t.eq(r.action, 'restart', 'ladder: escalates to /restart-chrome');
  r = nextSelfHeal(r.state, DEGRADED, { threshold: 2 });
  t.eq(r.action, 'restart', 'ladder: caps at restart (no rung beyond)');

  // --- a real submit RESETS the whole ladder (CDP recovered) ---
  r = nextSelfHeal(r.state, SUBMITTED, { threshold: 2 });
  t.eq(r.action, 'none', 'reset: submit → no action');
  t.eq(r.state.consecutiveDegraded, 0, 'reset: streak cleared');
  t.eq(r.state.rungIndex, 0, 'reset: escalation cleared');

  // --- honest skips between degraded do not falsely inflate the streak, but also do not reset it ---
  s = initState();
  s = nextSelfHeal(s, DEGRADED, { threshold: 2 }).state;   // streak 1
  s = nextSelfHeal(s, HONEST_SKIP, { threshold: 2 }).state; // no change
  t.eq(s.consecutiveDegraded, 1, 'skip: does not increment degraded streak');
  r = nextSelfHeal(s, DEGRADED, { threshold: 2 });          // streak 2 → heal
  t.eq(r.action, 'reattach', 'skip: streak resumes → reattach on next degraded');
};
