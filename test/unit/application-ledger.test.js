'use strict';

const path = require('path');
const {
  emptyLedger,
  reduceLedger,
  mergeLedgers,
  auditLedger,
  reconcileEmails,
  canonicalApplyUrl,
} = require(path.resolve(__dirname, '../../application-ledger'));

const DAY = '2026-07-19';
const RUN = 'run-50-2026-07-19';
const T0 = Date.parse('2026-07-19T16:00:00.000Z');
const auditOpts = { runId: RUN, day: DAY, timeZone: 'UTC', target: 50 };

function event(id, jobId, status, extra = {}) {
  return {
    eventId: id,
    runId: RUN,
    jobId,
    company: extra.company || 'Acme Semiconductor',
    title: extra.title || `Process Engineer ${jobId}`,
    status,
    applicationAt: extra.applicationAt == null ? T0 : extra.applicationAt,
    occurredAt: extra.occurredAt == null ? T0 : extra.occurredAt,
    ...extra,
  };
}

module.exports = (t) => {
  // Page/email evidence is counted; positive-looking inferred or unsupported records are not.
  let ledger = reduceLedger(emptyLedger(), [
    event('page-ok', 'P1', 'applied', { confirmationSource: 'page', confirmedAt: T0 + 1000 }),
    event('email-ok', 'E1', 'confirmed', { confirmationSource: 'email', confirmationEmailId: 'm-1', confirmedAt: T0 + 2000 }),
    event('pre-nav', 'U1', 'applied', { confirmationSource: 'page', confirmedAt: T0 + 3000, reason: 'pre-nav-handled' }),
    event('assumed', 'U2', 'submitted', { confirmationSource: 'page', confirmedAt: T0 + 4000, reason: 'submitted_assumed' }),
    event('unsupported', 'U3', 'applied', { reason: 'unverified' }),
    event('submitting', 'S1', 'submitting', { reason: 'submit_clicked' }),
    event('pending', 'N1', 'pending'),
    event('failed', 'F1', 'failed', { reason: 'validation_failed' }),
    event('skipped', 'K1', 'skipped', { reason: 'low_fit' }),
  ]);
  let audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.confirmed, 2, 'ledger: only explicit page/email evidence is confirmed');
  t.eq(audit.counts.confirmedPageOnly, 1, 'ledger: page confirmation is reported separately');
  t.eq(audit.counts.confirmedEmailOnly, 1, 'ledger: email confirmation is reported separately');
  t.eq(audit.counts.unverified, 3, 'ledger: inferred/assumed applied records remain unverified');
  t.eq(audit.counts.submitting, 1, 'ledger: submitting is not counted as confirmed');
  t.eq(audit.counts.pending, 1, 'ledger: pending is not counted as confirmed');
  t.eq(audit.counts.failed, 1, 'ledger: failed has its own bucket');
  t.eq(audit.counts.skipped, 1, 'ledger: skipped has its own bucket');
  t.eq(audit.remaining, 48, 'ledger: target remaining is based only on confirmed applications');

  // Exact modern identity joins job-id/apply-URL aliases. Tracking parameters do not fork a job.
  const jobUrl = 'https://jobs.example.com/apply/42?utm_source=linkedin';
  ledger = reduceLedger(emptyLedger(), [
    event('bridge-a', 'REQ-42', 'submitting', { applyUrl: jobUrl, company: 'Bridge Co', title: 'Quality Engineer' }),
    event('bridge-b', '', 'applied', { applyUrl: 'https://jobs.example.com/apply/42', company: 'Bridge Co',
      title: 'Quality Engineer', confirmationSource: 'page', confirmedAt: T0 + 5000 }),
    // A legacy role-only event may enrich this one unambiguous posting without adding a count.
    event('bridge-legacy', '', 'submitting', { company: 'Bridge Co', title: 'Quality Engineer' }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.total, 1, 'ledger identity: job id, URL and unambiguous legacy role form one application');
  t.eq(audit.counts.confirmed, 1, 'ledger identity: joined confirmation counts once');
  t.eq(canonicalApplyUrl(jobUrl), 'https://jobs.example.com/apply/42', 'ledger identity: tracking query is canonicalized away');

  ledger = reduceLedger(emptyLedger(), [
    event('req-a', 'REQ-A', 'submitting', { company: 'MegaFab', title: 'Process Engineer' }),
    event('req-b', 'REQ-B', 'submitting', { company: 'MegaFab', title: 'Process Engineer' }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.total, 2, 'ledger identity: same-title requisitions with different job ids stay distinct');

  ledger = reduceLedger(emptyLedger(), [
    event('tenant-a', 'R1234', 'applied', { company: 'Alpha Fab', title: 'Process Engineer',
      applyUrl: 'https://alpha.wd1.myworkdayjobs.com/jobs/R1234', confirmationSource: 'page', confirmedAt: T0 + 1 }),
    event('tenant-b', 'R1234', 'applied', { company: 'Beta Fab', title: 'Process Engineer',
      applyUrl: 'https://beta.wd1.myworkdayjobs.com/jobs/R1234', confirmationSource: 'page', confirmedAt: T0 + 2 }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.confirmed, 2,
    'ledger identity: tenant-local raw job IDs never merge distinct employers');

  ledger = reduceLedger(emptyLedger(), [
    event('legacy-a', '', 'submitting', { company: 'Legacy Inc', title: 'Manufacturing Engineer' }),
    event('legacy-b', '', 'failed', { company: 'legacy', title: 'manufacturing  engineer', occurredAt: T0 + 1 }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.total, 1, 'ledger identity: role fallback deduplicates records only when modern identity is absent');
  t.eq(audit.counts.failed, 1, 'ledger lifecycle: latest terminal state wins before confirmation');

  // Run/day scope is strict. A Los Angeles day can differ from the UTC calendar date.
  ledger = reduceLedger(emptyLedger(), [
    event('today-r1', 'D1', 'applied', { confirmationSource: 'page', confirmedAt: T0 }),
    event('yesterday-r1', 'D2', 'applied', { applicationAt: Date.parse('2026-07-18T16:00:00Z'),
      occurredAt: Date.parse('2026-07-18T16:00:00Z'), confirmationSource: 'page', confirmedAt: Date.parse('2026-07-18T16:00:01Z') }),
    event('today-r2', 'D3', 'applied', { runId: 'another-run', confirmationSource: 'page', confirmedAt: T0 }),
    event('la-boundary', 'D4', 'applied', { applicationAt: Date.parse('2026-07-20T02:30:00Z'),
      occurredAt: Date.parse('2026-07-20T02:30:00Z'), confirmationSource: 'page', confirmedAt: Date.parse('2026-07-20T02:30:01Z') }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.confirmed, 1, 'ledger scope: exact run id and UTC day exclude other runs/days');
  const laAudit = auditLedger(ledger, { runId: RUN, day: DAY, timeZone: 'America/Los_Angeles' });
  t.eq(laAudit.counts.confirmed, 2, 'ledger scope: timezone-aware current day includes the LA boundary event');
  const allDays = auditLedger(ledger, { runId: RUN, day: null });
  t.eq(allDays.counts.confirmed, 3, 'ledger scope: explicit day:null permits an all-days run audit');

  // Append/merge laws: immutable, idempotent, order-independent and confirmation-monotonic.
  const base = emptyLedger();
  const pendingShard = reduceLedger(base, event('same-event', 'RACE-1', 'submitting', { occurredAt: T0 }));
  const confirmedShard = reduceLedger(base, event('same-event', 'RACE-1', 'applied', {
    occurredAt: T0 + 1, confirmationSource: 'page', confirmedAt: T0 + 1 }));
  t.eq(Object.keys(base.events).length, 0, 'ledger reducer: does not mutate the prior snapshot');
  const leftFirst = mergeLedgers(pendingShard, confirmedShard);
  const rightFirst = mergeLedgers(confirmedShard, pendingShard);
  t.eq(auditLedger(leftFirst, auditOpts).counts, auditLedger(rightFirst, auditOpts).counts,
    'ledger reducer: replica merge order cannot change audit counts');
  t.eq(auditLedger(leftFirst, auditOpts).counts.confirmed, 1,
    'ledger reducer: a racing pending write cannot downgrade confirmation');
  const duplicate = reduceLedger(leftFirst, event('same-event', 'RACE-1', 'submitting', { occurredAt: T0 }));
  t.eq(Object.keys(duplicate.events).length, 1, 'ledger reducer: replaying an event id is idempotent');
  t.eq(auditLedger(duplicate, auditOpts).counts.confirmed, 1, 'ledger reducer: replay cannot inflate or downgrade the count');

  // One confirmation email can confirm only one application, even at the same company/time.
  ledger = reduceLedger(emptyLedger(), [
    event('acme-a', 'ACME-A', 'submitting', { company: 'Acme', title: 'Process Engineer' }),
    event('acme-b', 'ACME-B', 'submitting', { company: 'Acme', title: 'Quality Engineer' }),
  ]);
  const email = { messageId: 'email-one', from: 'Acme Hiring Team <no-reply@acme.example>',
    subject: 'Thanks for applying to Acme!', date: T0 + 3600000 };
  const reconciled = reconcileEmails(ledger, [email], auditOpts);
  audit = auditLedger(reconciled.ledger, auditOpts);
  t.eq(reconciled.matches.length, 1, 'ledger email: one message is assigned to exactly one application');
  t.eq(audit.counts.confirmedEmail, 1, 'ledger email: one generic company email cannot confirm two same-company jobs');
  t.eq(audit.counts.submitting, 1, 'ledger email: the unmatched application stays submitting');
  const reconciledAgain = reconcileEmails(reconciled.ledger, [email], auditOpts);
  t.eq(Object.keys(reconciledAgain.ledger.events).length, Object.keys(reconciled.ledger.events).length,
    'ledger email: reconciling the same message again is idempotent');

  // The audit also defends against a bad producer assigning one message id twice.
  ledger = reduceLedger(emptyLedger(), [
    event('bad-mail-a', 'BAD-A', 'confirmed', { company: 'Bad Co', title: 'Engineer A',
      confirmationSource: 'email', confirmationEmailId: 'duplicated-message', confirmedAt: T0 + 1 }),
    event('bad-mail-b', 'BAD-B', 'confirmed', { company: 'Bad Co', title: 'Engineer B',
      confirmationSource: 'email', confirmationEmailId: 'duplicated-message', confirmedAt: T0 + 1 }),
  ]);
  audit = auditLedger(ledger, auditOpts);
  t.eq(audit.counts.confirmed, 1, 'ledger email: duplicate message evidence is counted for only one job');
  t.eq(audit.counts.unverified, 1, 'ledger email: the duplicate assignment is surfaced as unverified');
};
