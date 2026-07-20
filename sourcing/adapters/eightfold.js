'use strict';
// Eightfold PCS adapter — public candidate-site API, no authentication or HTML scraping.
//
// Search:
//   GET {origin}/api/pcsx/search?domain={domain}&query={query}&location={location}
//       &start={offset}&sort_by=relevance
// Detail:
//   GET {origin}/api/pcsx/position_details?position_id={id}&domain={domain}&hl=en
//
// Eightfold serves the same API from each employer's branded careers origin, so both
// `origin` (for example https://careers.micron.com) and `domain` (micron.com) are explicit
// source configuration. Search rows omit the job description; eligible-looking rows are
// enriched from the detail endpoint before resume matching.
const { makeJob } = require('../normalize');

const ATS = 'eightfold';
const DEFAULT_QUERIES = [
  'process engineer',
  'quality engineer',
  'manufacturing engineer',
  'equipment engineer',
  'metrology engineer',
  'reliability engineer',
];
const DETAIL_TITLE = /\b(engineer|engineering|scientist)\b/i;

function sourceOrigin(source) {
  try {
    const url = new URL(String(source && source.origin || ''));
    return /^https?:$/.test(url.protocol) ? url.origin : '';
  } catch (_) {
    return '';
  }
}

function rowId(raw) {
  const value = raw && (raw.id != null ? raw.id
    : raw.atsJobId != null ? raw.atsJobId
      : raw.displayJobId != null ? raw.displayJobId
        : raw.positionUrl);
  return value == null ? '' : String(value);
}

function searchUrl(source, { query = '', start = 0 } = {}) {
  const origin = sourceOrigin(source);
  if (!origin || !source || !source.domain) return '';
  const url = new URL('/api/pcsx/search', origin);
  url.searchParams.set('domain', String(source.domain));
  url.searchParams.set('query', String(query || ''));
  url.searchParams.set('location', String(source.location || ''));
  url.searchParams.set('start', String(Math.max(0, Number(start) || 0)));
  url.searchParams.set('sort_by', String(source.sortBy || 'relevance'));
  return url.toString();
}

function detailUrl(source, raw) {
  const origin = sourceOrigin(source);
  const id = rowId(raw);
  if (!origin || !source || !source.domain || !id) return '';
  const url = new URL('/api/pcsx/position_details', origin);
  url.searchParams.set('position_id', id);
  url.searchParams.set('domain', String(source.domain));
  url.searchParams.set('hl', String(source.language || 'en'));
  return url.toString();
}

function applicationUrl(source, raw) {
  const origin = sourceOrigin(source);
  const id = rowId(raw);
  if (origin && id) {
    const url = new URL(String(source.applyPath || '/careers/apply'), origin);
    url.searchParams.set('pid', id);
    return url.toString();
  }
  return String(raw && (raw.publicUrl || raw.positionUrl) || '');
}

function joined(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' | ');
  return value == null ? '' : String(value);
}

function locationText(raw) {
  return joined(raw && raw.location) ||
    joined(raw && raw.standardizedLocations) ||
    joined(raw && raw.locations);
}

function postedAt(raw) {
  const value = raw && (raw.postedTs != null ? raw.postedTs : raw.creationTs);
  if (value == null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const millis = Math.abs(number) < 1e12 ? number * 1000 : number;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function normalize(raw, source) {
  const workMode = [joined(raw && raw.workLocationOption), joined(raw && raw.locationFlexibility)]
    .filter(Boolean).join(' ');
  return makeJob({
    id: rowId(raw),
    title: raw && (raw.name || raw.title),
    company: source && (source.name || source.domain),
    location: locationText(raw),
    remote: workMode ? /\b(remote|home)\b/i.test(workMode) : undefined,
    applyUrl: applicationUrl(source, raw),
    ats: ATS,
    postedAt: postedAt(raw),
    description: raw && (raw.jobDescription || raw.description) || '',
  });
}

async function fetchJson(url, { timeoutMs, fetchImpl }) {
  if (!url || typeof fetchImpl !== 'function') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response || !response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichDetails(rows, source, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const concurrency = Math.max(1, Number(opts.detailConcurrency) || 6);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const raw = rows[next++];
      const payload = await fetchJson(detailUrl(source, raw), { timeoutMs, fetchImpl });
      const detail = payload && (payload.data || payload);
      if (detail && typeof detail === 'object') Object.assign(raw, detail);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return rows;
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function queryList(source, opts) {
  const configured = Array.isArray(opts.queries) && opts.queries.length ? opts.queries
    : Array.isArray(source.queries) && source.queries.length ? source.queries
      : source.query ? [source.query] : DEFAULT_QUERIES;
  return Array.from(new Set(configured.map(q => String(q || '').trim()).filter(Boolean)));
}

async function fetchJobs(source, opts = {}) {
  if (!sourceOrigin(source) || !source || !source.domain) return [];
  const timeoutMs = opts.timeoutMs || 15000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const max = positiveInt(opts.max, 200);
  const pageSize = positiveInt(source.pageSize || opts.pageSize, 10);
  const queries = queryList(source, opts);
  // Keep broad employers from letting the first keyword consume the entire source budget.
  const perQueryMax = positiveInt(opts.perQueryMax || source.perQueryMax,
    Math.max(pageSize, Math.ceil(max / Math.max(1, queries.length))));
  const byId = new Map();

  for (const query of queries) {
    let start = 0;
    let read = 0;
    let previousPage = '';
    while (byId.size < max && read < perQueryMax) {
      const payload = await fetchJson(searchUrl(source, { query, start }), { timeoutMs, fetchImpl });
      const data = payload && (payload.data || payload);
      const page = data && Array.isArray(data.positions) ? data.positions : [];
      if (!page.length) break;

      // A few branded sites ignore `start` during transient backend failures. Detect that
      // response rather than requesting the same page until the source timeout expires.
      const signature = page.map(rowId).join('|');
      if (signature && signature === previousPage) break;
      previousPage = signature;

      for (const row of page) {
        const id = rowId(row);
        if (!id) continue;
        const prior = byId.get(id);
        byId.set(id, prior ? Object.assign(prior, row) : row);
        if (byId.size >= max) break;
      }
      read += page.length;
      start += page.length;
      const total = Number(data && data.count);
      if (Number.isFinite(total) && start >= total) break;
      if (!Number.isFinite(total) && page.length < pageSize) break;
    }
    if (byId.size >= max) break;
  }

  const rows = Array.from(byId.values());
  const detailMax = nonNegativeInt(opts.detailMax, 100);
  const relevant = rows.filter(row => DETAIL_TITLE.test(String(row && (row.name || row.title) || '')))
    .slice(0, detailMax);
  await enrichDetails(relevant, source, {
    timeoutMs,
    detailConcurrency: opts.detailConcurrency,
    fetchImpl,
  });
  return rows.map(row => normalize(row, source));
}

module.exports = {
  ATS,
  DEFAULT_QUERIES,
  fetchJobs,
  normalize,
  sourceOrigin,
  rowId,
  searchUrl,
  detailUrl,
  applicationUrl,
  locationText,
  postedAt,
  enrichDetails,
};
