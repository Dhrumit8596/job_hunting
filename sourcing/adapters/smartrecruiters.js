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
  // Detail responses publish the canonical guest application URL. Prefer it: synthesizing the
  // `/oneclick-ui/` route from `uuid` can land on an Apply-with-Indeed handoff instead of the
  // employer's actual form. Listing-only rows retain the stable public posting fallback.
  const applyUrl = raw.applyUrl || (slug && raw.id
    ? `https://jobs.smartrecruiters.com/${slug}/${raw.id}`
    : '');
  return makeJob({
    id: raw.id,
    title: raw.name,
    company: source.name || (raw.company && raw.company.name) || slug,
    location: locStr,
    remote: loc.remote != null ? !!loc.remote : undefined,
    applyUrl,
    ats: ATS,
    postedAt: raw.releasedDate || '',
    description: raw.description || descriptionFromDetail(raw),
  });
}

function detailUrl(source, raw) {
  const slug = source && source.slug || raw && raw.company && raw.company.identifier || '';
  const id = raw && (raw.id || raw.uuid) || '';
  return slug && id
    ? `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`
    : '';
}

function descriptionFromDetail(raw) {
  const sections = raw && raw.jobAd && raw.jobAd.sections || {};
  return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map(k => sections[k] && sections[k].text || '').filter(Boolean).join(' ');
}

function listingUrl(source, offset = 0) {
  const url = new URL(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.slug)}/postings`);
  url.searchParams.set('limit', '100');
  url.searchParams.set('offset', String(offset));
  if (source.country) url.searchParams.set('country', String(source.country));
  if (source.query) url.searchParams.set('q', String(source.query));
  return url.toString();
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
        if (resp.ok) Object.assign(raw, await resp.json());
      } catch (_) { /* retain listing metadata if one detail fails */ }
      finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return rows;
}

async function fetchJobs(source, { timeoutMs = 15000, max = 200, detailConcurrency = 6, detailMax = 100 } = {}) {
  if (!source.slug) return [];
  const byId = new Map();
  const queries = Array.isArray(source.queries) && source.queries.length ? source.queries : [source.query || ''];
  for (const query of queries) {
    const requestSource = Object.assign({}, source, { query });
    try {
      for (let offset = 0; offset < max; offset += 100) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        let data;
        try {
          const resp = await fetch(listingUrl(requestSource, offset), { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
          if (!resp.ok) break;
          data = await resp.json();
        } finally { clearTimeout(t); }
        const page = (data && data.content) || [];
        if (!page.length) break;
        for (const row of page) if (row && (row.id || row.uuid)) byId.set(String(row.id || row.uuid), row);
        const total = data.totalFound || 0;
        if (offset + 100 >= total) break;
      }
    } catch (_) { /* isolate each query: retain other query results */ }
  }
  const out = Array.from(byId.values());
  const relevant = out.filter(j => /\b(engineer|engineering|scientist)\b/i.test(j.name || '')).slice(0, detailMax);
  await enrichDetails(relevant, source, { timeoutMs, detailConcurrency });
  return out.map(j => normalize(j, source));
}

module.exports = { ATS, fetchJobs, normalize, detailUrl, descriptionFromDetail, listingUrl, enrichDetails };
