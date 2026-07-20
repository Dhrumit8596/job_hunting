'use strict';
// Discovery adapter — Jobicy public API (keyless). Keyword/industry search across employers,
// with a geo filter (US). GET https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&tag=<q>
const { makeJob } = require('../normalize');
const { detectAts } = require('../detect-ats');

const ATS = 'jobicy';
const MODALITY = 'discovery';

function normalize(raw) {
  const applyUrl = raw.url || '';
  const job = makeJob({
    id: raw.id,
    title: raw.jobTitle,
    company: raw.companyName,
    location: raw.jobGeo || 'Remote',
    remote: true,
    applyUrl,
    ats: ATS,
    postedAt: raw.pubDate || '',
    description: raw.jobDescription || raw.jobExcerpt || '',
  });
  job.detectedAts = detectAts(applyUrl);
  return job;
}

async function fetchJobs(_source, opts = {}) {
  const queries = opts.queries || ['engineer', 'quality', 'manufacturing'];
  const timeoutMs = opts.timeoutMs || 15000;
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const url = `https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&tag=${encodeURIComponent(q)}`;
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const raw of (Array.isArray(data.jobs) ? data.jobs : [])) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        out.push(normalize(raw));
      }
    } catch (_) { /* ignore */ }
  }
  return out;
}

module.exports = { ATS, MODALITY, fetchJobs, normalize };
