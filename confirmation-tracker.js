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

function titleTokens(value) {
  const noise = new Set(['senior','sr','junior','jr','lead','staff','principal','associate','engineer','engineering','manager','the','and','for']);
  return normCo(value).split(' ').filter(x => x.length > 2 && !noise.has(x));
}

function roleSignal(application, confirmation) {
  const hay = normCo((confirmation.subject || '') + ' ' + (confirmation.snippet || ''));
  const jobId = String(application.jobId || application.sourceJobId || '').toLowerCase().trim();
  if (jobId && hay.includes(jobId.replace(/[^a-z0-9]+/g, ' '))) return 100;
  const tokens = titleTokens(application.title);
  if (!tokens.length) return 0;
  const hits = tokens.filter(x => hay.includes(x)).length;
  return hits >= Math.min(2, tokens.length) ? 20 + hits : 0;
}

// appliedLog: [{ company, title, appliedAt|ts, status }]; emails: [{ from, subject, date?, company? }]
// opts.windowDays: confirmation must arrive within this many days AFTER the apply (default 7).
function reconcile(appliedLog, emails, opts = {}) {
  const winMs = (opts.windowDays != null ? opts.windowDays : 7) * 86400000;
  const confs = (emails || []).filter(isConfirmationEmail).map((e, index) => ({
    index, raw: e,
    from: e.from, subject: e.subject,
    co: normCo(e.company || e.from),
    subjCo: normCo(e.subject),
    t: toMs(e.date),
  }));
  const applied = (appliedLog || []).filter(e => e && e.status === 'applied');
  const confirmed = [], usedApplications = new Set();
  // Assign each concrete confirmation message to at most one concrete application. Specific
  // title/requisition evidence wins; otherwise a generic company confirmation goes to the nearest
  // unmatched application in its time window. One email can never prove several same-company jobs.
  for (const c of confs) {
    let best = null;
    for (let i = 0; i < applied.length; i++) {
      if (usedApplications.has(i)) continue;
      const a = applied[i];
      const aco = normCo(a.company);
      if (!aco) continue;
      const coHit = (c.co && (c.co.includes(aco) || aco.includes(c.co))) || (c.subjCo && c.subjCo.includes(aco));
      if (!coHit) continue;
      const at = toMs(a.appliedAt != null ? a.appliedAt : a.ts);
      if (at != null && c.t != null && !(c.t >= at - 3600000 && c.t <= at + winMs)) continue;
      const signal = roleSignal(a, c.raw);
      const distance = at != null && c.t != null ? Math.abs(c.t - at) : Number.MAX_SAFE_INTEGER;
      if (!best || signal > best.signal || (signal === best.signal && distance < best.distance)) {
        best = { index: i, application: a, signal, distance };
      }
    }
    if (best) {
      usedApplications.add(best.index);
      confirmed.push({ company: best.application.company, title: best.application.title,
        jobId: best.application.jobId || null,
        confirmedBy: { from: c.from, subject: c.subject } });
    }
  }
  const unverifiable = [];
  for (let i = 0; i < applied.length; i++) {
    if (usedApplications.has(i)) continue;
    const a = applied[i];
    unverifiable.push({ company: a.company, title: a.title, jobId: a.jobId || null });
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

module.exports = { reconcile, isConfirmationEmail, normCo, titleTokens, roleSignal };
