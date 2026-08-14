'use strict';
// Phase C (APPLY_ENGINE_PLAN.md): preflight + fill-verification decision logic. PURE and UMD so it's
// unit-tested in Node and loaded as window.PJAPreflight. It is currently a shadow migration seam:
// production external-apply has equivalent inline decisions but does not call this API yet. No DOM
// here — a future caller reads signals off the page and passes them in; this only decides.
//
// Two jobs:
//  1) preflight: before spending time filling, classify the page → proceed / skip-with-reason.
//  2) true-success: never record "applied" on a click alone — require a real confirmation signal
//     (guards the degraded-CDP false-positive where a react-select silently didn't commit but the
//     submit button was clicked anyway).
(function (root) {
  // signals (booleans) read off the page:
  //  isDeadPosting, hasCaptcha, hasChatbot, hasApplyForm, hasApplyButton, hasLoginWall
  // Account-creation pages are NOT a skip — we automate those (Workday-style), so they "proceed".
  function classifyPreflight(sig) {
    const s = sig || {};
    if (s.isDeadPosting) return { action: 'skip', reason: 'posting_not_found' };
    if (s.hasCaptcha)    return { action: 'skip', reason: 'captcha' };          // never auto-solved → needs_manual
    if (s.hasChatbot)    return { action: 'skip', reason: 'chatbot_apply_manual' };
    if (s.hasApplyForm)  return { action: 'proceed', reason: 'form_present' };
    if (s.hasApplyButton) return { action: 'proceed', reason: 'apply_button' }; // click reveals the form
    if (s.hasLoginWall)  return { action: 'skip', reason: 'needs_login' };      // wall we can't get past
    return { action: 'skip', reason: 'no_apply_form' };
  }

  function norm(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim(); }

  // Did a committed value actually take? Tolerant compare (react-select display vs intended value).
  function verifyCommitted(expected, readBack) {
    const e = norm(expected), r = norm(readBack);
    if (!e) return !!r;                 // any non-empty commit counts when we had no exact target
    if (!r) return false;
    return r === e || r.includes(e) || e.includes(r);
  }

  // Retry policy for a field that didn't commit (degraded-CDP recovery). Stop at maxAttempts.
  function shouldRetryCommit(attempt, committed, maxAttempts = 3) {
    if (committed) return false;
    return (attempt || 0) < maxAttempts;
  }

  // Record "applied" ONLY when a real success signal is present — not on a bare submit click.
  // successSignal = pjaIsSubmitSuccess result (confirmation URL/text/form-gone). This is the guard
  // against degraded-CDP false "applied".
  function isTrueSuccess(submitClicked, successSignal) {
    return !!(submitClicked && successSignal);
  }

  // If we clicked submit but there's no success signal AND required fields are still uncommitted,
  // it's the degraded-CDP signature → caller should trigger self-heal + retry, not record applied.
  function isDegradedSubmit(submitClicked, successSignal, uncommittedRequiredCount) {
    return !!(submitClicked && !successSignal && (uncommittedRequiredCount || 0) > 0);
  }

  const API = { classifyPreflight, verifyCommitted, shouldRetryCommit, isTrueSuccess, isDegradedSubmit };
  if (root) root.PJAPreflight = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
