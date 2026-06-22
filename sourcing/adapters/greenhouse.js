'use strict';
// Greenhouse adapter — public boards API, no auth, no scraping.
// GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
const { makeJob } = require('../normalize');

const ATS = 'greenhouse';

function normalize(raw, source) {
  return makeJob({
    id: raw.id,
    title: raw.title,
    company: source.name || source.slug,
    location: raw.location && raw.location.name,
    applyUrl: raw.absolute_url,
    ats: ATS,
    postedAt: raw.updated_at || raw.first_published || '',
  });
}

async function fetchJobs(source, { timeoutMs = 15000 } = {}) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.slug)}/jobs`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs.map(j => normalize(j, source));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ATS, fetchJobs, normalize };
