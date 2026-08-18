'use strict';
// Workday adapter — public CXS jobs search (no auth for discovery; applying still needs an
// account). Workday datacenters/sites vary per tenant, so the source provides the exact
// CXS endpoint + site base rather than us guessing. Tune by adding entries to sources.json:
//   { "ats":"workday", "name":"Bloom Energy",
//     "apiUrl":"https://bloomenergy.wd5.myworkdayjobs.com/wday/cxs/bloomenergy/Bloom_Energy/jobs",
//     "siteBase":"https://bloomenergy.wd5.myworkdayjobs.com/en-US/Bloom_Energy" }
const { makeJob } = require('../normalize');
const { filterJobs } = require('../filter');

const ATS = 'workday';

function normalize(raw, source) {
  const path = raw.externalPath || '';
  const job = makeJob({
    id: raw.bulletFields && raw.bulletFields[0] || path,
    title: raw.title,
    company: source.name,
    location: raw.locationsText,
    applyUrl: path ? (String(source.siteBase || '').replace(/\/+$/, '') + path) : '',
    ats: ATS,
    postedAt: raw.postedOn || '',
    description: raw.description || '',
  });
  job.descriptionStatus = job.description ? 'complete' : 'needs_description';
  job.hydrationStatus = raw._hydrationStatus || (job.description ? 'hydration_success' : 'hydration_missing_detail');
  job.hydrationReason = raw._hydrationReason || '';
  job.matchedQueries = Array.isArray(raw._matchedQueries) ? raw._matchedQueries.slice() : [];
  job.query = job.matchedQueries[0] || '';
  return job;
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
      if (!url) {
        raw._hydrationStatus = 'hydration_missing_detail_url';
        raw._hydrationReason = 'missing_external_path';
        continue;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (resp.ok) {
          raw.description = descriptionFromDetail(await resp.json());
          raw._hydrationStatus = raw.description ? 'hydration_success' : 'hydration_missing_detail';
          raw._hydrationReason = raw.description ? '' : 'detail_payload_missing_description';
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
  const sourceTerms = Array.isArray(source && source.queries) ? source.queries : [];
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

async function fetchJobs(source, { timeoutMs = 15000, max = 100, detailConcurrency = 6, detailMax = 0,
  queries = [], profileQueryLimit = 10, profileQueryMax = 20,
  nationwideUS = false, targetLocation, targetRadiusMiles, locationStrictness, remotePolicy } = {}) {
  if (!source.apiUrl) return [];
  const rows = [];
  const seen = new Map();
  // Large Workday tenants can have thousands of openings, and the default API ordering can hide
  // a highly relevant role beyond the first `max` rows. Optional source-specific search terms pull
  // those roles to the front while the empty search preserves the existing broad collection.
  const searches = searchTerms(source, queries, profileQueryLimit);
  const sourceSearches = new Set((Array.isArray(source.queries) ? source.queries : [])
    .map(q => String(q || '').trim().toLowerCase()).filter(Boolean));
  try {
    for (const searchText of searches) {
      const searchMax = searchText
        ? (sourceSearches.has(searchText.toLowerCase())
          ? Math.max(20, Number(source.perQueryMax) || 40)
          : Math.max(20, Number(profileQueryMax) || 20))
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
          if (seen.has(key)) {
            const existing = seen.get(key);
            if (searchText && !existing._matchedQueries.includes(searchText)) existing._matchedQueries.push(searchText);
            continue;
          }
          row._matchedQueries = searchText ? [searchText] : [];
          seen.set(key, row);
          rows.push(row);
        }
        if (page.length < 20) break;
      }
    }
  } catch (_) { /* isolate: return whatever we got */ }
  // Workday's search response omits requirements. Hydrate every posting that survives the same
  // deterministic title/company/location policy used by the source run. The old first-100 cap
  // left later, candidate-relevant rows permanently title-only. A caller may still set an
  // explicit positive detailMax for a bounded diagnostic run.
  const relevant = hydrationRows(rows, source, { detailMax, nationwideUS, targetLocation,
    targetRadiusMiles, locationStrictness, remotePolicy });
  await enrichDetails(relevant, source, { timeoutMs, detailConcurrency });
  return rows.map(j => normalize(j, source));
}

module.exports = { ATS, fetchJobs, normalize, detailUrl, descriptionFromDetail, enrichDetails,
  searchTerms, hydrationRows };
