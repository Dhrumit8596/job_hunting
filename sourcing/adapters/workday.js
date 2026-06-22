'use strict';
// Workday adapter — public CXS jobs search (no auth for discovery; applying still needs an
// account). Workday datacenters/sites vary per tenant, so the source provides the exact
// CXS endpoint + site base rather than us guessing. Tune by adding entries to sources.json:
//   { "ats":"workday", "name":"Bloom Energy",
//     "apiUrl":"https://bloomenergy.wd5.myworkdayjobs.com/wday/cxs/bloomenergy/Bloom_Energy/jobs",
//     "siteBase":"https://bloomenergy.wd5.myworkdayjobs.com/en-US/Bloom_Energy" }
const { makeJob } = require('../normalize');

const ATS = 'workday';

function normalize(raw, source) {
  const path = raw.externalPath || '';
  return makeJob({
    id: raw.bulletFields && raw.bulletFields[0] || path,
    title: raw.title,
    company: source.name,
    location: raw.locationsText,
    applyUrl: path ? (String(source.siteBase || '').replace(/\/+$/, '') + path) : '',
    ats: ATS,
    postedAt: raw.postedOn || '',
  });
}

async function fetchJobs(source, { timeoutMs = 15000, max = 100 } = {}) {
  if (!source.apiUrl) return [];
  const out = [];
  try {
    for (let offset = 0; offset < max; offset += 20) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const resp = await fetch(source.apiUrl, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
        });
        if (!resp.ok) break;
        data = await resp.json();
      } finally { clearTimeout(t); }
      const page = (data && data.jobPostings) || [];
      if (!page.length) break;
      out.push(...page.map(j => normalize(j, source)));
      if (page.length < 20) break;
    }
  } catch (_) { /* isolate: return whatever we got */ }
  return out;
}

module.exports = { ATS, fetchJobs, normalize };
