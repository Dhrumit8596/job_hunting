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
    description: raw.description || '',
  });
}

function detailUrl(source, raw) {
  const path = raw && raw.externalPath || '';
  return source && source.apiUrl && path
    ? String(source.apiUrl).replace(/\/jobs\/?$/, '') + path
    : '';
}

function descriptionFromDetail(data) {
  const p = data && (data.jobPostingInfo || data);
  return String(p && (p.jobDescription || p.description) || '');
}

async function enrichDetails(rows, source, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const concurrency = Math.max(1, opts.detailConcurrency || 6);
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const raw = rows[next++];
      const url = detailUrl(source, raw);
      if (!url) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (resp.ok) raw.description = descriptionFromDetail(await resp.json());
      } catch (_) { /* a missing detail never drops the listing */ }
      finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return rows;
}

async function fetchJobs(source, { timeoutMs = 15000, max = 100, detailConcurrency = 6, detailMax = 100 } = {}) {
  if (!source.apiUrl) return [];
  const rows = [];
  const seen = new Set();
  // Large Workday tenants can have thousands of openings, and the default API ordering can hide
  // a highly relevant role beyond the first `max` rows. Optional source-specific search terms pull
  // those roles to the front while the empty search preserves the existing broad collection.
  const searches = [...new Set([
    ...(Array.isArray(source.queries) ? source.queries : []),
    '',
  ].map(q => String(q || '').trim()))];
  try {
    for (const searchText of searches) {
      const searchMax = searchText
        ? Math.max(20, Number(source.perQueryMax) || 40)
        : max;
      for (let offset = 0; offset < searchMax; offset += 20) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        let data;
        try {
          const resp = await fetch(source.apiUrl, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText }),
          });
          if (!resp.ok) break;
          data = await resp.json();
        } finally { clearTimeout(t); }
        const page = (data && data.jobPostings) || [];
        if (!page.length) break;
        for (const row of page) {
          const key = String(row.externalPath || row.bulletFields && row.bulletFields[0] || `${row.title}|${row.locationsText}`);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
        }
        if (page.length < 20) break;
      }
    }
  } catch (_) { /* isolate: return whatever we got */ }
  // Workday's search response omits requirements. Fetch details for engineering/science
  // postings so evidence scoring sees the actual qualifications instead of title-only data.
  const relevant = rows.filter(j => /\b(engineer|engineering|scientist)\b/i.test(j.title || '')).slice(0, detailMax);
  await enrichDetails(relevant, source, { timeoutMs, detailConcurrency });
  return rows.map(j => normalize(j, source));
}

module.exports = { ATS, fetchJobs, normalize, detailUrl, descriptionFromDetail, enrichDetails };
