'use strict';
// Lever adapter — public postings API, no auth, no scraping.
// GET https://api.lever.co/v0/postings/{slug}?mode=json
const { makeJob } = require('../normalize');

const ATS = 'lever';

function normalize(raw, source) {
  const cat = raw.categories || {};
  // Land directly on the application form.
  const applyUrl = raw.applyUrl || (raw.hostedUrl ? raw.hostedUrl.replace(/\/+$/, '') + '/apply' : '');
  return makeJob({
    id: raw.id,
    title: raw.text,
    company: source.name || source.slug,
    location: cat.location || cat.allLocations && cat.allLocations.join(', '),
    applyUrl,
    ats: ATS,
    postedAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : '',
  });
}

async function fetchJobs(source, { timeoutMs = 15000 } = {}) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(source.slug)}?mode=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const jobs = Array.isArray(data) ? data : [];
    return jobs.map(j => normalize(j, source));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ATS, fetchJobs, normalize };
