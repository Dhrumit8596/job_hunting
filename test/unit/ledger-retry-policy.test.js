'use strict';

const Policy = require('../../ledger-retry-policy');
const { buildApplyPlan } = require('../../sourcing/apply-select');
const Ledger = require('../../application-ledger');

function corpus(id, applyUrl, state = 'sourced', sourceJobId = 'R100') {
  return {
    index: { [id]: { id, sourceJobId, company: 'Acme Fab', title: 'Process Engineer',
      applyUrl, description: 'Own process validation, SPC, yield improvement, and root-cause analysis.' } },
    state: { [id]: { status: state, fitScore: 85 } },
  };
}

function ambiguous(status, reason, applyUrl = 'https://acme.wd1.myworkdayjobs.com/jobs/R100?utm_source=test') {
  return { eventId: `${status}-${reason}`, runId: 'old-run', jobId: 'R100', company: 'Acme Fab',
    title: 'Process Engineer', applyUrl, status, reason, applicationAt: 100, occurredAt: 200 };
}

module.exports = t => {
  const url = 'https://acme.wd1.myworkdayjobs.com/jobs/R100';
  const submitted = ambiguous('submitted', 'submit_observation_timeout');
  let blockers = Policy.blockedLedgerRecords([submitted]);
  t.eq(blockers.length, 1,
    'retry policy: submitted submit-observation timeout is blocked regardless of ledger status');
  t.eq(Policy.classifyLedgerEvent(ambiguous('submitted', 'success_unverified')).blocksAutomaticRetry, true,
    'retry policy: any submitted/unverified outcome stays non-confirmed and non-auto-retryable');
  t.eq(Policy.classifyLedgerEvent(ambiguous('submitted', 'tab_lost_outcome_unknown')).blocksAutomaticRetry, true,
    'retry policy: a vanished native tab with unknown submit phase is blocked from automatic retry');
  t.eq(Policy.classifyLedgerEvent(ambiguous('submitted', 'email_code_submit_unconfirmed')).blocksAutomaticRetry, true,
    'retry policy: a possibly-final email-code action remains unconfirmed and non-auto-retryable');
  t.eq(Policy.classifyLedgerEvent({ ...submitted, status: 'applied', reason: 'submitted_assumed',
    confirmationSource: 'page', confirmedAt: 300 }).confirmed, false,
  'retry policy: inferred page evidence is not mislabeled as confirmed by planner or report policy');
  let plan = buildApplyPlan(corpus('workday:acme:R100', url), { threshold: 70, blockedRecords: blockers });
  t.eq({ selected: plan.jobs.length, blocked: plan.dropCounts.prior_blocked_record },
    { selected: 0, blocked: 1 },
  'retry policy: stable tenant-scoped job identity blocks the same sourced requisition');

  const byUrl = ambiguous('unverified', 'submit_unclear', url + '?trackingId=abc');
  blockers = Policy.blockedLedgerRecords([byUrl]);
  plan = buildApplyPlan(corpus('workday:acme:different-id', url, 'sourced', 'R999'),
    { threshold: 70, blockedRecords: blockers });
  t.eq(plan.dropCounts.prior_blocked_record, 1,
    'retry policy: canonical apply URL blocks after corpus state refreshes back to sourced');

  for (const reason of ['submit_unclear', 'workday_transport_failure', 'ranked_watchdog_timeout']) {
    t.eq(Policy.classifyLedgerEvent(ambiguous('failed', reason)).blocksAutomaticRetry, true,
      `retry policy: ${reason} is non-retryable pending manual reconciliation`);
  }
  t.eq(Policy.classifyLedgerEvent({ ...ambiguous('failed', 'ranked_watchdog_timeout'),
    submitAttempted: false, phase: 'pre_submit' }).category, 'failed_retryable',
  'retry policy: watchdog with explicit pre-submit/no-submit evidence retains bounded retry eligibility');
  t.eq(Policy.classifyLedgerEvent(ambiguous('failed', 'missing_required')).category, 'failed_retryable',
    'retry policy: ordinary failed missing_required is not permanently blocked');
  t.eq(Policy.classifyLedgerEvent(ambiguous('failed', 'page_load_failed_before_submit')).blocksAutomaticRetry, false,
    'retry policy: explicit pre-submit page/transport failure remains eligible for bounded retry');

  const noEasyApply = ambiguous('failed', 'no_easy_apply',
    'https://www.linkedin.com/jobs/view/4440486124/?trackingId=test');
  t.eq(Policy.classifyLedgerEvent(noEasyApply).category, 'failed_manual',
    'retry policy: exhausted LinkedIn Easy Apply modal opening is manual, not an automatic retry');
  t.eq(Policy.blockedLedgerRecords([noEasyApply]).length, 1,
    'retry policy: no_easy_apply is blocked by default even when stale corpus state says sourced');
  t.eq(Policy.blockedLedgerRecords([noEasyApply], { retryBlocked: true }).length, 0,
    'retry policy: the existing explicit operator override still supports a verified targeted retry');

  t.eq(Policy.blockedLedgerRecords([submitted], { retryBlocked: true }).length, 0,
    'retry policy: existing explicit operator retry override remains supported');
  t.eq(Policy.blockedLedgerRecords([submitted], { retryBlockedHosts: ['acme.wd1.myworkdayjobs.com'] }).length, 0,
    'retry policy: existing host-scoped operator retry override remains scoped to that host');
  t.eq(Policy.blockedLedgerRecords([submitted], { retryBlockedHosts: ['other.example.com'] }).length, 1,
    'retry policy: a host-scoped override does not unblock a different host');

  const ledger = Ledger.reduceLedger(Ledger.emptyLedger(), submitted);
  const audit = Ledger.auditLedger(ledger, { runId: 'old-run', day: null, target: 1 });
  t.eq({ confirmed: audit.counts.confirmed, unverified: audit.counts.unverified },
    { confirmed: 0, unverified: 1 },
  'retry policy: submitted/unverified timeout remains unconfirmed in the application audit');

  const summary = Policy.summarizeLedgerEvents([
    submitted,
    ambiguous('failed', 'missing_required'),
    ambiguous('failed', 'workday_captcha'),
  ]);
  t.eq({ ambiguous: summary.categories.submitted_unverified_blocked,
    retryable: summary.categories.failed_retryable,
    external: summary.categories.external_blocker },
  { ambiguous: 1, retryable: 1, external: 1 },
  'retry policy: report categories agree with planning classification for identical events');
  t.eq(summary.blocked.some(row => row.event.reason === 'submit_observation_timeout'), true,
    'retry policy: submitted/unverified timeout appears in the developer manual-reconciliation summary');
  t.eq(summary.blocked.some(row => row.event.reason === 'missing_required'), false,
    'retry policy: retryable missing_required does not appear in the permanent blocked summary');
};
