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

// Normalized company::title key — the SECONDARY dedup key used to collapse the SAME role
// surfaced by two different modalities (e.g. registry + discovery) that carry different ids.
function roleKey(job) {
  return norm(job && job.company) + '::' + norm(job && job.title);
}

// Canonical primary id. Stable across re-runs; namespaced by ATS/source.
function canonicalId(job) {
  const ats = norm(job && job.ats).replace(/\s+/g, '') || 'x';
  const rawId = job && job.id != null ? String(job.id).trim() : '';
  if (rawId) return ats + ':' + rawId;
  return 'norm:' + roleKey(job);
}

module.exports = { norm, roleKey, canonicalId };
