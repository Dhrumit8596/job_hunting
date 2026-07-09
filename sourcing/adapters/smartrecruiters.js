'use strict';
// SmartRecruiters adapter — public postings API, no auth, no scraping.
// GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=N
// slug = the company's SmartRecruiters identifier (e.g. "WesternDigital").
// Response: { totalFound, content: [ { id, name, company:{identifier,name},
//   location:{city,region,country,remote,fullLocation}, releasedDate, ... } ] }
// Apply form lands at https://jobs.smartrecruiters.com/{slug}/{id}
const { makeJob } = require('../normalize');

const ATS = 'smartrecruiters';

function normalize(raw, source) {
  const loc = raw.location || {};
  const locStr = loc.fullLocation ||
    [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
  const slug = source.slug || (raw.company && raw.company.identifier) || '';
  return makeJob({
    id: raw.id,
    title: raw.name,
    company: source.name || (raw.company && raw.company.name) || slug,
    location: locStr,
    remote: loc.remote != null ? !!loc.remote : undefined,
    applyUrl: slug && raw.id ? `https://jobs.smartrecruiters.com/${slug}/${raw.id}` : '',
    ats: ATS,
    postedAt: raw.releasedDate || '',
  });
}

async function fetchJobs(source, { timeoutMs = 15000, max = 200 } = {}) {
  if (!source.slug) return [];
  const out = [];
  try {
    for (let offset = 0; offset < max; offset += 100) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.slug)}/postings?limit=100&offset=${offset}`;
        const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
        if (!resp.ok) break;
        data = await resp.json();
      } finally { clearTimeout(t); }
      const page = (data && data.content) || [];
      if (!page.length) break;
      out.push(...page.map(j => normalize(j, source)));
      const total = data.totalFound || 0;
      if (offset + 100 >= total) break;
    }
  } catch (_) { /* isolate: return whatever we got */ }
  return out;
}

module.exports = { ATS, fetchJobs, normalize };
