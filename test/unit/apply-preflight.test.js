'use strict';
// Phase C: preflight classification + verify/true-success guards.
const path = require('path');
const { classifyPreflight, verifyCommitted, shouldRetryCommit, isTrueSuccess, isDegradedSubmit } =
  require(path.resolve(__dirname, '../../content/apply-preflight'));

module.exports = (t) => {
  // --- preflight ---
  t.eq(classifyPreflight({ isDeadPosting: true }).reason, 'posting_not_found', 'dead posting → skip');
  t.eq(classifyPreflight({ hasCaptcha: true }).reason, 'captcha', 'captcha → skip (never solved)');
  t.eq(classifyPreflight({ hasCaptcha: true }).action, 'skip', 'captcha action skip');
  t.eq(classifyPreflight({ hasChatbot: true }).reason, 'chatbot_apply_manual', 'chatbot → skip');
  t.eq(classifyPreflight({ hasApplyForm: true }).action, 'proceed', 'form present → proceed');
  t.eq(classifyPreflight({ hasApplyButton: true }).action, 'proceed', 'apply button → proceed');
  t.eq(classifyPreflight({ hasLoginWall: true }).reason, 'needs_login', 'login wall → needs_login');
  t.eq(classifyPreflight({}).reason, 'no_apply_form', 'nothing → no_apply_form');
  // account-creation pages are NOT skipped (we automate them): if a create-account page also exposes
  // the apply button/form, it proceeds; a bare login wall is the only auth skip.
  t.eq(classifyPreflight({ hasApplyButton: true, hasLoginWall: true }).action, 'proceed', 'apply button wins over login wall (create-account flow)');
  // precedence: dead posting beats everything
  t.eq(classifyPreflight({ isDeadPosting: true, hasApplyForm: true }).reason, 'posting_not_found', 'dead beats form');

  // --- verifyCommitted ---
  t.eq(verifyCommitted('United States', 'United States'), true, 'exact match');
  t.eq(verifyCommitted('United States', 'united states'), true, 'case-insensitive');
  t.eq(verifyCommitted('No', ''), false, 'empty readback → not committed');
  t.eq(verifyCommitted('Bachelor', "Bachelor's Degree"), true, 'expected substring of readback');
  t.eq(verifyCommitted('', 'anything'), true, 'no target → any non-empty commits');
  t.eq(verifyCommitted('Yes', 'No'), false, 'mismatch → not committed');

  // --- shouldRetryCommit ---
  t.eq(shouldRetryCommit(0, false, 3), true, 'retry when uncommitted + under max');
  t.eq(shouldRetryCommit(3, false, 3), false, 'stop at max attempts');
  t.eq(shouldRetryCommit(0, true, 3), false, 'no retry when committed');

  // --- true success guard (no false "applied") ---
  t.eq(isTrueSuccess(true, true), true, 'clicked + confirmation → applied');
  t.eq(isTrueSuccess(true, false), false, 'clicked but NO confirmation → NOT applied (degraded-CDP guard)');
  t.eq(isTrueSuccess(false, true), false, 'confirmation without our click → not our applied');

  // --- degraded submit detection ---
  t.eq(isDegradedSubmit(true, false, 2), true, 'clicked, no success, uncommitted required → degraded');
  t.eq(isDegradedSubmit(true, true, 0), false, 'success → not degraded');
  t.eq(isDegradedSubmit(true, false, 0), false, 'no uncommitted required → not the degraded signature');
};
