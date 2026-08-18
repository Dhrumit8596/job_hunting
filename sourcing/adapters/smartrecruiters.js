'use strict';
// SmartRecruiters adapter — public postings API, no auth, no scraping.
// GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=N
// slug = the company's SmartRecruiters identifier (e.g. "WesternDigital").
// Response: { totalFound, content: [ { id, name, company:{identifier,name},
//   location:{city,region,country,remote,fullLocation}, releasedDate, ... } ] }
// Apply form lands at https://jobs.smartrecruiters.com/{slug}/{id}
const { makeJob } = require('../normalize');
const { filterJobs } = require('../filter');

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
  const job = makeJob({
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
  job.descriptionStatus = job.description ? 'complete' : 'needs_description';
  job.hydrationStatus = raw._hydrationStatus || (job.description ? 'hydration_success' : 'hydration_missing_detail');
  job.hydrationReason = raw._hydrationReason || '';
  job.matchedQueries = Array.isArray(raw._matchedQueries) ? raw._matchedQueries.slice() : [];
  job.query = job.matchedQueries[0] || '';
  return job;
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
      if (!url) {
        raw._hydrationStatus = 'hydration_missing_detail_url';
        raw._hydrationReason = 'missing_posting_id';
        continue;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (resp.ok) {
          Object.assign(raw, await resp.json());
          const description = descriptionFromDetail(raw);
          raw._hydrationStatus = description ? 'hydration_success' : 'hydration_missing_detail';
          raw._hydrationReason = description ? '' : 'detail_payload_missing_description';
        } else {
          raw._hydrationStatus = 'hydration_http_error';
          raw._hydrationReason = 'detail_http_' + resp.status;
        }
      } catch (err) {
        raw._hydrationStatus = err && err.name === 'AbortError' ? 'hydration_timeout' : 'hydration_fetch_error';
        raw._hydrationReason = err && err.name === 'AbortError' ? 'detail_timeout' : 'detail_fetch_failed';
      }
      finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return rows;
}

function searchTerms(source, queries, profileQueryLimit = 10) {
  const sourceTerms = Array.isArray(source && source.queries) && source.queries.length
    ? source.queries : [source && source.query || ''];
  const profileTerms = (Array.isArray(queries) ? queries : []).slice(0, Math.max(0, Number(profileQueryLimit) || 0));
  const out = [], seen = new Set();
  for (const value of [...sourceTerms, ...profileTerms, '']) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(text);
  }
  return out;
}

function hydrationRows(rows, source, opts = {}) {
  const filterOpts = {
    nationwideUS: opts.nationwideUS === true,
    targetLocation: opts.targetLocation,
    targetRadiusMiles: opts.targetRadiusMiles,
    locationStrictness: opts.locationStrictness,
    remotePolicy: opts.remotePolicy,
  };
  const eligible = (rows || []).filter(raw => filterJobs([normalize(raw, source)], filterOpts).length > 0);
  const cap = Number(opts.detailMax);
  return Number.isFinite(cap) && cap > 0 ? eligible.slice(0, cap) : eligible;
}

async function fetchJobs(source, { timeoutMs = 15000, max = 200, detailConcurrency = 6, detailMax = 0,
  queries = [], profileQueryLimit = 10, profileQueryMax = 100,
  nationwideUS = false, targetLocation, targetRadiusMiles, locationStrictness, remotePolicy } = {}) {
  if (!source.slug) return [];
  const byId = new Map();
  const searches = searchTerms(source, queries, profileQueryLimit);
  const sourceSearches = new Set((Array.isArray(source.queries) && source.queries.length
    ? source.queries : [source.query || '']).map(q => String(q || '').trim().toLowerCase()).filter(Boolean));
  for (const query of searches) {
    const requestSource = Object.assign({}, source, { query });
    const queryMax = query && !sourceSearches.has(query.toLowerCase())
      ? Math.max(100, Number(profileQueryMax) || 100) : max;
    try {
      for (let offset = 0; offset < queryMax; offset += 100) {
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
        for (const row of page) if (row && (row.id || row.uuid)) {
          const id = String(row.id || row.uuid);
          const existing = byId.get(id);
          if (existing) {
            existing._matchedQueries = Array.isArray(existing._matchedQueries) ? existing._matchedQueries : [];
            if (query && !existing._matchedQueries.includes(query)) existing._matchedQueries.push(query);
          } else {
            row._matchedQueries = query ? [query] : [];
            byId.set(id, row);
          }
        }
        const total = data.totalFound || 0;
        if (offset + 100 >= total) break;
      }
    } catch (_) { /* isolate each query: retain other query results */ }
  }
  const out = Array.from(byId.values());
  const relevant = hydrationRows(out, source, { detailMax, nationwideUS, targetLocation,
    targetRadiusMiles, locationStrictness, remotePolicy });
  await enrichDetails(relevant, source, { timeoutMs, detailConcurrency });
  return out.map(j => normalize(j, source));
}

module.exports = { ATS, fetchJobs, normalize, detailUrl, descriptionFromDetail, listingUrl, enrichDetails,
  searchTerms, hydrationRows };
