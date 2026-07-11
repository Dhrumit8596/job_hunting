'use strict';
// Greenhouse adapter — public boards API, no auth, no scraping.
// GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
const { makeJob } = require('../normalize');

const ATS = 'greenhouse';

function normalize(raw, source) {
  // Prefer the canonical Greenhouse-hosted application form over raw.absolute_url. When a company
  // embeds Greenhouse on its own domain, absolute_url is the CAREERS/landing page (e.g.
  // corcept.com/careers?gh_jid=<id> or psiquantum.com/apply?gh_jid=<id>) which doesn't expose the
  // form — the apply engine then finds no form / no apply button. The job-boards.greenhouse.io URL
  // (built from the board slug + job id) always renders the application form. Fall back to
  // absolute_url only if we somehow lack a slug or id.
  const slug = source && source.slug;
  const applyUrl = (slug && raw.id != null)
    ? `https://job-boards.greenhouse.io/${slug}/jobs/${raw.id}`
    : raw.absolute_url;
  return makeJob({
    id: raw.id,
    title: raw.title,
    company: source.name || source.slug,
    location: raw.location && raw.location.name,
    applyUrl,
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
