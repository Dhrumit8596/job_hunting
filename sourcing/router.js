'use strict';
// Channel-router for the unified auto-apply run. From a fit-scored job pool it:
//   1. dedupes against everything already applied (both channels) via pja_applied_log + jobId,
//   2. filters to genuine-fit roles (>= threshold), drops excluded + export-controlled companies,
//   3. splits the survivors into Easy Apply vs External (ATS) queues, highest-fit first.
// Pure + synchronous so it can be unit-tested without a browser. The orchestrator feeds `ea`
// to the backend EA mode (/start-ea) and `external` to external-apply (pja_ext_queue).
const { jobKey, appliedKeySet, pjaCollectAppliedRecords } = require('./dedupe');
const { isExportControlledCompany } = require('./filter');

// Pull a LinkedIn jobId out of a record (applyUrl/url shaped .../jobs/view/<id>/ or an explicit id).
function recordJobId(r) {
  const u = String((r && (r.applyUrl || r.url)) || '');
  const m = u.match(/\/jobs\/view\/(\d+)/);
  if (m) return m[1];
  if (r && (r.jobId || r.id)) return String(r.jobId || r.id);
  return null;
}

function routeJobs(jobs, storage, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 60;
  const excludeCompanies = (opts.excludeCompanies || ['applied materials']).map(s => String(s).toLowerCase());

  // Everything already applied — keyed both by company::title and by LinkedIn jobId.
  const applied = appliedKeySet(pjaCollectAppliedRecords(storage));
  const appliedJids = new Set();
  for (const r of (storage && storage.pja_applied_log) || []) {
    const jid = recordJobId(r);
    if (jid) appliedJids.add(jid);
  }

  const out = { ea: [], external: [], skipped: [] };
  const seenKey = new Set(), seenJid = new Set();
  const skip = (j, reason) => out.skipped.push({ id: j.id || j.jobId, company: j.company, title: j.title, skipReason: reason });

  const sorted = (jobs || []).filter(Boolean).slice()
    .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  for (const j of sorted) {
    const jid = String(j.id || j.jobId || '');
    const key = jobKey(j);
    if (typeof j.fitScore !== 'number' || j.fitScore < threshold) { skip(j, 'below_threshold'); continue; }
    if (excludeCompanies.some(c => String(j.company || '').toLowerCase().includes(c))) { skip(j, 'excluded_company'); continue; }
    if (isExportControlledCompany(j.company)) { skip(j, 'export_controlled'); continue; }
    if (applied.has(key) || (jid && appliedJids.has(jid))) { skip(j, 'already_applied'); continue; }
    if (seenKey.has(key) || (jid && seenJid.has(jid))) { skip(j, 'dup_in_run'); continue; }
    seenKey.add(key); if (jid) seenJid.add(jid);
    if (j.isEasyApply) out.ea.push(j); else out.external.push(j);
  }

  out.counts = { ea: out.ea.length, external: out.external.length, skipped: out.skipped.length };
  return out;
}

module.exports = { routeJobs, recordJobId };
