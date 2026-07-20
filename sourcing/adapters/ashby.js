'use strict';
// Ashby adapter — public job-board API, no auth, no scraping.
// GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Response: { jobs: [ { id, title, location, isRemote, jobUrl, applyUrl?, publishedAt, ... } ] }
// Apply form lands at https://jobs.ashbyhq.com/{slug}/{id}/application
const { makeJob } = require('../normalize');

const ATS = 'ashby';

function normalize(raw, source) {
  // Prefer an explicit applyUrl; otherwise derive the application form URL from jobUrl.
  let applyUrl = raw.applyUrl || '';
  if (!applyUrl && raw.jobUrl) {
    applyUrl = raw.jobUrl.replace(/\/+$/, '') + '/application';
  }
  if (!applyUrl && source.slug && raw.id) {
    applyUrl = `https://jobs.ashbyhq.com/${source.slug}/${raw.id}/application`;
  }
  return makeJob({
    id: raw.id,
    title: raw.title,
    company: source.name || source.slug,
    location: raw.location || (raw.address && raw.address.postalAddress && raw.address.postalAddress.addressLocality) || '',
    remote: raw.isRemote != null ? !!raw.isRemote : undefined,
    applyUrl,
    ats: ATS,
    postedAt: raw.publishedAt || raw.updatedAt || '',
    description: raw.descriptionPlain || raw.descriptionHtml || raw.description || '',
  });
}

async function fetchJobs(source, { timeoutMs = 15000 } = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.slug)}?includeCompensation=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    // Only listed jobs are publicly applyable.
    return jobs.filter(j => j.isListed !== false).map(j => normalize(j, source));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ATS, fetchJobs, normalize };
