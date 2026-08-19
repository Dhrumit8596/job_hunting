'use strict';
// Dedupe sourced jobs against already-applied roles and within the run itself.
// Idempotent: re-running the pipeline never re-surfaces a role we've already applied to.

// Stable key for a role: company + normalized title (ATS ids differ across reposts).
function jobKey(job) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(job.company) + '::' + norm(job.title);
}

function appliedUrlKey(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    for (const k of Array.from(u.searchParams.keys())) {
      if (/^(utm_.+|trk|trackingId|ref|refId|source|src|campaign|from)$/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '') + (u.search ? u.search : '');
  } catch (_) { return ''; }
}

function stableRecordId(r) {
  if (!r) return '';
  if (r.jobId != null && String(r.jobId).trim()) return String(r.jobId).trim();
  if (r.sourceJobId != null && String(r.sourceJobId).trim()) return String(r.sourceJobId).trim();
  const id = r.id != null ? String(r.id).trim() : '';
  return /^(greenhouse|lever|ashby|workday|smartrecruiters|linkedin|indeed|glassdoor|remotive|jobicy|eightfold|successfactors):/i.test(id) ? id : '';
}

// Exact identities for modern records; role keys only for legacy entries that lack a posting id
// and apply URL. This lets distinct requisitions with the same employer/title remain applyable.
function appliedIdentity(records) {
  const exactIds = new Set(), urls = new Set(), legacyRoles = new Set();
  for (const r of records || []) {
    if (!r) continue;
    const id = stableRecordId(r);
    const url = appliedUrlKey(r.applyUrl || r.url);
    if (id) exactIds.add(id);
    if (url) urls.add(url);
    if (!id && !url) legacyRoles.add(jobKey({ company: r.company || r.companyName, title: r.title || r.role || r.jobTitle }));
  }
  return { exactIds, urls, legacyRoles };
}

// Build a Set of applied keys from prior records (pja_jobs entries + queue results).
// Accepts loosely-shaped records ({company,title} or {company, role}).
function appliedKeySet(records) {
  const set = new Set();
  for (const r of records || []) {
    if (!r) continue;
    const company = r.company || r.companyName || '';
    const title = r.title || r.role || r.jobTitle || '';
    if (company || title) set.add(jobKey({ company, title }));
  }
  return set;
}

// Remove jobs whose key is in appliedKeys or already seen this run.
function dedupe(jobs, appliedKeys) {
  const applied = appliedKeys instanceof Set ? appliedKeys : new Set(appliedKeys || []);
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const k = jobKey(j);
    if (applied.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(j);
  }
  return out;
}

// Append applied roles to a durable log, deduped by jobKey. This survives pja_ext_queue being
// overwritten each run (Bug2): without it, /source only saw the LAST queue's applied roles and
// re-surfaced roles applied in earlier (overwritten) queues.
function pjaMergeAppliedLog(log, entries) {
  const out = Array.isArray(log) ? log.slice() : [];
  const identityKey = r => {
    const id = stableRecordId(r); if (id) return 'id:' + id;
    const url = appliedUrlKey(r && (r.applyUrl || r.url)); if (url) return 'url:' + url;
    return 'role:' + jobKey(r || {});
  };
  const have = new Set(out.map(identityKey));
  for (const e of entries || []) {
    if (!e) continue;
    const rec = { company: e.company || e.companyName || '', title: e.title || e.role || e.jobTitle || '',
      jobId: e.jobId || e.sourceJobId || e.id || null, applyUrl: e.applyUrl || e.url || null,
      status: e.status || 'applied', appliedAt: e.appliedAt || Date.now() };
    if (!rec.company && !rec.title) continue;
    const k = identityKey(rec);
    if (have.has(k)) continue;
    have.add(k);
    out.push(rec);
  }
  return out;
}

// Aggregate every source of "already applied" from storage for dedupe: the durable applied log
// (primary), plus pja_jobs and the current queue's results (belt-and-suspenders).
function pjaCollectAppliedRecords(storage, options = {}) {
  const s = storage || {};
  const recs = [];
  for (const j of (s.pja_applied_log || [])) {
    if (!j || !j.status || /^(applied|submitted|submitting|success|confirmed)$/i.test(String(j.status))) recs.push(j);
  }
  for (const j of (s.pja_jobs || [])) {
    if (j && /^(applied|submitted|success|confirmed)$/i.test(String(j.status || j.result || ''))) recs.push(j);
  }
  const r = s.pja_ext_queue && s.pja_ext_queue.results;
  if (r) for (const x of (r.applied || [])) recs.push(x);
  const ledgerEvents = s.pja_application_ledger && s.pja_application_ledger.events
    ? Object.values(s.pja_application_ledger.events) : [];
  let retryPolicy = null;
  try { retryPolicy = require('../ledger-retry-policy'); } catch (_) {}
  const blocked = retryPolicy ? new Set(retryPolicy.blockedLedgerRecords(ledgerEvents, options)) : new Set();
  for (const event of ledgerEvents) {
    if (!event) continue;
    if (retryPolicy) {
      const classification = retryPolicy.classifyLedgerEvent(event);
      if (classification.confirmed || blocked.has(event)) recs.push(event);
    } else if (/^(applied|submitted|submitting|success|confirmed)$/i.test(String(event.status || event.result || ''))) {
      recs.push(event);
    }
  }
  return recs;
}

module.exports = { jobKey, appliedKeySet, appliedUrlKey, stableRecordId, appliedIdentity, dedupe,
  pjaMergeAppliedLog, pjaCollectAppliedRecords };
