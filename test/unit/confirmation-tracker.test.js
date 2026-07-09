'use strict';
// Tests for the confirmation tracker — reconciling applied entries against Gmail confirmations.
// Mirrors the real 2026-07-09 Gmail findings (Lumilens 3/3, AeroVect 1/1, others unverifiable).
const path = require('path');
const { reconcile, isConfirmationEmail, normCo } = require(path.resolve(__dirname, '../../confirmation-tracker'));

module.exports = (t) => {
  // --- normCo: strip suffixes / "Hiring Team" so sender ≈ company ---
  t.eq(normCo('Lumilens Hiring Team'), 'lumilens', 'normCo: strips Hiring Team');
  t.eq(normCo('Western Digital, Inc.'), 'western digital', 'normCo: strips Inc');
  t.eq(normCo('Lumilens <no-reply@lumilens.com>'), 'lumilens', 'normCo: keeps display name, drops address');

  // --- isConfirmationEmail: match real ATS phrases, reject job alerts ---
  t.eq(isConfirmationEmail({ subject: 'Thanks for applying to Lumilens!' }), true, 'conf: thanks for applying');
  t.eq(isConfirmationEmail({ subject: 'Thank you for applying for the IC Package FEA Engineer role' }), true, 'conf: thank you for applying');
  t.eq(isConfirmationEmail({ subject: 'AeroVect — Thanks for Applying!' }), true, 'conf: thanks for applying (em dash)');
  t.eq(isConfirmationEmail({ subject: 'We have received your application' }), true, 'conf: received your application');
  t.eq(isConfirmationEmail({ subject: 'SPI / AOI Process Engineer at Foxconn and 5 more jobs for you' }), false, 'conf: job alert rejected');
  t.eq(isConfirmationEmail({ subject: 'Your weekly job digest' }), false, 'conf: digest rejected');

  // --- reconcile: Lumilens 3 applies → all confirmed by the one thread; Velo3D unverifiable ---
  const applied = [
    { company: 'Lumilens', title: 'IC Package FEA Engineer', status: 'applied', ts: 1000 },
    { company: 'Lumilens', title: 'Optical Test Engineer', status: 'applied', ts: 1000 },
    { company: 'Lumilens', title: 'Advanced Package Technology Principal Engineer', status: 'applied', ts: 1000 },
    { company: 'AeroVect', title: 'Senior Reliability Engineer', status: 'applied', ts: 1000 },
    { company: 'Velo3D', title: 'Senior Electrical Manufacturing Engineer', status: 'applied', ts: 1000 },
    { company: 'Willow', title: 'Senior Quality Engineer', status: 'submitting', ts: 1000 }, // not "applied" → excluded
  ];
  const emails = [
    { from: 'Lumilens Hiring Team', subject: 'Thanks for applying to Lumilens!', date: 1000 + 3600000 },
    { from: 'AeroVect Hiring Team', subject: 'AeroVect — Thanks for Applying!', date: 1000 + 7200000 },
    { from: 'Glassdoor Jobs', subject: 'Senior Process Engineer and 5 more jobs', date: 1000 }, // alert, ignored
  ];
  const r = reconcile(applied, emails, { windowDays: 7 });
  t.eq(r.stats.applied, 5, 'reconcile: counts only status=applied');
  t.eq(r.stats.confirmed, 4, 'reconcile: 3 Lumilens + 1 AeroVect confirmed');
  t.eq(r.stats.unverifiable, 1, 'reconcile: Velo3D unverifiable (no email)');
  t.eq(r.confirmed.filter(c => c.company === 'Lumilens').length, 3, 'reconcile: all 3 Lumilens roles confirmed by one email');
  t.eq(r.unverifiable[0].company, 'Velo3D', 'reconcile: Velo3D is the unverifiable one');

  // --- time window: a confirmation arriving BEFORE the apply (or long after) does not match ---
  const late = reconcile(
    [{ company: 'Acme', title: 'Process Engineer', status: 'applied', ts: 100000000 }],
    [{ from: 'Acme', subject: 'Thanks for applying to Acme', date: 100000000 + 30 * 86400000 }],
    { windowDays: 7 });
  t.eq(late.stats.confirmed, 0, 'reconcile: confirmation 30d later is outside window → unverifiable');
};
