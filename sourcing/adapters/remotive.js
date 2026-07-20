'use strict';
// Discovery adapter — Remotive public API (keyless). Searches by KEYWORD across many employers
// (US-remote roles), the opposite of the per-company slug registry. GET
// https://remotive.com/api/remote-jobs?search=<q>  -> { jobs: [...] }
const { makeJob } = require('../normalize');
const { detectAts } = require('../detect-ats');

const ATS = 'remotive'; // provenance/id namespace; real apply ATS is detectAts(url).
const MODALITY = 'discovery';

function normalize(raw) {
  const applyUrl = raw.url || '';
  const job = makeJob({
    id: raw.id,
    title: raw.title,
    company: raw.company_name,
    location: raw.candidate_required_location || 'Remote',
    remote: true,
    applyUrl,
    ats: ATS,
    postedAt: raw.publication_date || '',
    description: raw.description || '',
  });
  job.detectedAts = detectAts(applyUrl); // where the actual application lives, if recognizable
  return job;
}

// opts.queries: string[] of keywords to search. Aggregates + de-dupes by remotive id.
async function fetchJobs(_source, opts = {}) {
  const queries = opts.queries || ['engineer', 'quality engineer', 'process engineer', 'manufacturing engineer'];
  const timeoutMs = opts.timeoutMs || 15000;
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`;
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const raw of (Array.isArray(data.jobs) ? data.jobs : [])) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        out.push(normalize(raw));
      }
    } catch (_) { /* one query failing never breaks discovery */ }
  }
  return out;
}

module.exports = { ATS, MODALITY, fetchJobs, normalize };
