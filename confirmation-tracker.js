'use strict';
// Confirmation tracker — reconcile pja_applied_log against Gmail application-confirmation
// emails so "applied" is backed by ground truth instead of on-page detection alone.
//
// This module is PURE logic (no network): the caller fetches the candidate's recent emails
// (from/subject/date) separately and passes them in. Each applied entry is labeled:
//   - 'confirmed'    : a matching confirmation email exists (company + time window)
//   - 'unverifiable' : no matching email — NOTE many ATSes/companies send no confirmation,
//                      so absence is NOT proof of failure (documented honestly, never "failed").
// Verified manually 2026-07-09: Lumilens 3 applies → 3-thread confirmation, AeroVect 1→1;
// most Ashby/Lever companies send nothing (only 2 ashbyhq.com emails for ~40 applies).

// Subject/body phrases used by ATS confirmation emails (Greenhouse/Lever/Ashby/SmartRecruiters).
const CONFIRM_RE = /thank(s| you) for (applying|your (application|interest|submission))|application (received|submitted|confirmed|complete)|we(?:'| ha)?ve received your application|received your application|thanks for applying|you have applied|your application (to|for|has been (received|submitted))|appreciate your (application|interest)/i;

// Company noise words to strip so "Lumilens Hiring Team" ≈ "Lumilens", "Acme, Inc." ≈ "acme".
const CO_NOISE = /\b(inc|llc|corp|corporation|co|ltd|limited|technologies|technology|labs|laboratories|systems|holdings|group|the|hiring|team|recruiting|careers|talent|no[- ]?reply)\b/g;

function normCo(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[<>@].*$/, '')          // drop email-address remainder if a full "From" is passed
    .replace(/[,.&\-—_/]+/g, ' ')
    .replace(CO_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMs(d) {
  if (d == null) return null;
  if (typeof d === 'number') return d;
  const t = Date.parse(d);
  return isNaN(t) ? null : t;
}

// email: { from, subject, date?, company? }
function isConfirmationEmail(email) {
  if (!email) return false;
  return CONFIRM_RE.test(String(email.subject || '') + ' ' + String(email.snippet || ''));
}

// appliedLog: [{ company, title, ts?, status }]; emails: [{ from, subject, date?, company? }]
// opts.windowDays: confirmation must arrive within this many days AFTER the apply (default 7).
function reconcile(appliedLog, emails, opts = {}) {
  const winMs = (opts.windowDays != null ? opts.windowDays : 7) * 86400000;
  const confs = (emails || []).filter(isConfirmationEmail).map(e => ({
    from: e.from, subject: e.subject,
    co: normCo(e.company || e.from),
    subjCo: normCo(e.subject),
    t: toMs(e.date),
  }));
  const applied = (appliedLog || []).filter(e => e && e.status === 'applied');
  const confirmed = [], unverifiable = [];
  for (const a of applied) {
    const aco = normCo(a.company);
    const at = toMs(a.ts);
    const match = aco && confs.find(c => {
      const coHit = (c.co && (c.co.includes(aco) || aco.includes(c.co))) || (c.subjCo && c.subjCo.includes(aco));
      if (!coHit) return false;
      if (at == null || c.t == null) return true;            // no timestamp on one side → company match suffices
      return c.t >= at - 3600000 && c.t <= at + winMs;       // within [apply-1h, apply+window]
    });
    if (match) confirmed.push({ company: a.company, title: a.title, confirmedBy: { from: match.from, subject: match.subject } });
    else unverifiable.push({ company: a.company, title: a.title });
  }
  return {
    confirmed, unverifiable,
    stats: {
      applied: applied.length,
      confirmed: confirmed.length,
      unverifiable: unverifiable.length,
      confirmationEmails: confs.length,
    },
  };
}

module.exports = { reconcile, isConfirmationEmail, normCo };
