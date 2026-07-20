'use strict';
// Canonical job identity + normalized keys. This is the storage-integrity foundation:
// every job gets ONE stable id so the index can dedupe without the lossy company::title key.
//
// Primary id = `<ats>:<atsJobId>` (the ATS's own stable posting id, namespaced by ATS so ids
// from different sources never collide). Fallback = `norm:<company>::<title>` only when a job
// has no id at all (rare — most adapters carry the ATS id).

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Normalized company::title key — used for reporting and legacy id-less records only. It is not a
// safe modern dedup key because several distinct requisitions can share the same title.
function roleKey(job) {
  return norm(job && job.company) + '::' + norm(job && job.title);
}

// Cross-source similarity key for diagnostics. Even company+title+location is not proof of posting
// identity, so stores no longer collapse on this value without an exact direct URL.
function mirrorKey(job) {
  return roleKey(job) + '::' + norm(job && job.location);
}

// Canonical primary id. Stable across re-runs; namespaced by ATS/source.
function canonicalId(job) {
  const ats = norm(job && job.ats).replace(/\s+/g, '') || 'x';
  const rawId = job && job.id != null ? String(job.id).trim() : '';
  if (rawId) return ats + ':' + rawId;
  return 'norm:' + roleKey(job);
}

module.exports = { norm, roleKey, mirrorKey, canonicalId };
