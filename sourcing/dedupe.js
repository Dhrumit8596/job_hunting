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

module.exports = { jobKey, appliedKeySet, dedupe };
