'use strict';
// Dedupe sourced jobs against already-applied roles and within the run itself.
// Idempotent: re-running the pipeline never re-surfaces a role we've already applied to.

// Stable key for a role: company + normalized title (ATS ids differ across reposts).
function jobKey(job) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(job.company) + '::' + norm(job.title);
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
  const have = new Set(out.map(jobKey));
  for (const e of entries || []) {
    if (!e) continue;
    const rec = { company: e.company || e.companyName || '', title: e.title || e.role || e.jobTitle || '', appliedAt: e.appliedAt || Date.now() };
    if (!rec.company && !rec.title) continue;
    const k = jobKey(rec);
    if (have.has(k)) continue;
    have.add(k);
    out.push(rec);
  }
  return out;
}

// Aggregate every source of "already applied" from storage for dedupe: the durable applied log
// (primary), plus pja_jobs and the current queue's results (belt-and-suspenders).
function pjaCollectAppliedRecords(storage) {
  const s = storage || {};
  const recs = [];
  for (const j of (s.pja_applied_log || [])) recs.push(j);
  for (const j of (s.pja_jobs || [])) recs.push(j);
  const r = s.pja_ext_queue && s.pja_ext_queue.results;
  if (r) for (const x of [...(r.applied || []), ...(r.skipped || [])]) recs.push(x);
  return recs;
}

module.exports = { jobKey, appliedKeySet, dedupe, pjaMergeAppliedLog, pjaCollectAppliedRecords };
