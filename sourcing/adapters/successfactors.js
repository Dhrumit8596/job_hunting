'use strict';
// SAP SuccessFactors Recruiting Marketing (RMK) adapter. RMK career sites expose
// public, server-rendered search and job-detail pages, so discovery only needs GETs:
//   https://{career-host}/search/?q=&locationsearch=United+States&startrow=0
//   https://{career-host}/job/{slug}/{posting-id}/
// The detail page carries schema.org JobPosting microdata and a direct apply link.
const { makeJob, cleanDescription } = require('../normalize');

const ATS = 'successfactors';

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    ndash: '–', mdash: '—', bull: '•', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', hellip: '…',
  };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, token) => {
    if (token[0] === '#') {
      const hex = token[1].toLowerCase() === 'x';
      const n = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : all;
    }
    return Object.prototype.hasOwnProperty.call(named, token.toLowerCase())
      ? named[token.toLowerCase()] : all;
  });
}

function attr(tag, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  if (quoted) return decodeEntities(quoted[2]);
  const bare = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
  return bare ? decodeEntities(bare[1]) : '';
}

function hasClass(tag, className) {
  return attr(tag, 'class').split(/\s+/).includes(className);
}

function absoluteUrl(value, source) {
  if (!value) return '';
  try { return new URL(decodeEntities(value), sourceBase(source)).toString(); }
  catch (_) { return ''; }
}

function sourceBase(source) {
  return String(source && (source.baseUrl || source.origin || source.siteBase) || '').replace(/\/+$/, '');
}

// Extract one element while respecting nested elements of the same tag. A non-greedy
// regex alone truncates RMK descriptions because they contain many nested <span>s.
function findElement(html, tagName, predicate) {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let open;
  while ((open = openRe.exec(String(html || '')))) {
    if (!predicate(open[0])) continue;
    const start = open.index;
    const contentStart = openRe.lastIndex;
    if (/\/\s*>$/.test(open[0])) return { tag: open[0], inner: '', outer: open[0], index: start };
    const tokenRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tokenRe.lastIndex = contentStart;
    let depth = 1, token;
    while ((token = tokenRe.exec(html))) {
      if (/^<\//.test(token[0])) depth--;
      else if (!/\/\s*>$/.test(token[0])) depth++;
      if (depth === 0) {
        return {
          tag: open[0],
          inner: html.slice(contentStart, token.index),
          outer: html.slice(start, tokenRe.lastIndex),
          index: start,
        };
      }
    }
    return null;
  }
  return null;
}

function findTag(html, tagName, predicate) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(String(html || '')))) if (predicate(m[0])) return m[0];
  return '';
}

function textFromElement(el) {
  return cleanDescription(decodeEntities(el && el.inner || ''));
}

function postingId(url) {
  try {
    const m = new URL(url).pathname.match(/\/(\d+)\/?$/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function normalizeDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).trim() : parsed.toISOString();
}

function searchUrl(source, start = 0, query) {
  const base = sourceBase(source);
  if (!base) return '';
  const url = new URL(source.searchPath || '/search/', base + '/');
  url.searchParams.set('createNewAlert', 'false');
  url.searchParams.set('q', query != null ? String(query) : String(source.query || ''));
  const location = source.locationSearch || source.location || '';
  if (location) url.searchParams.set('locationsearch', String(location));
  url.searchParams.set('startrow', String(Math.max(0, Number(start) || 0)));
  return url.toString();
}

function parseSearchRow(rowHtml, source) {
  const link = findTag(rowHtml, 'a', tag => hasClass(tag, 'jobTitle-link'));
  const detailUrl = absoluteUrl(attr(link, 'href'), source);
  if (!detailUrl) return null;
  const linkEl = findElement(rowHtml, 'a', tag => hasClass(tag, 'jobTitle-link'));
  const locationEl = findElement(rowHtml, 'span', tag => hasClass(tag, 'jobLocation'));
  const dateEl = findElement(rowHtml, 'span', tag => hasClass(tag, 'jobDate'));
  return {
    id: postingId(detailUrl),
    title: textFromElement(linkEl),
    company: source && source.name || '',
    location: textFromElement(locationEl),
    postedAt: normalizeDate(textFromElement(dateEl)),
    detailUrl,
    applyUrl: detailUrl,
  };
}

function parseSearchPage(html, source) {
  const out = [], seen = new Set();
  const rowRe = /<tr\b[^>]*class\s*=\s*(["'])[^"']*\bdata-row\b[^"']*\1[^>]*>[\s\S]*?<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(String(html || '')))) {
    const parsed = parseSearchRow(row[0], source);
    const key = parsed && (parsed.id || parsed.detailUrl);
    if (key && parsed.title && !seen.has(key)) { seen.add(key); out.push(parsed); }
  }
  // Some RMK themes omit data-row while retaining the stable jobTitle-link class.
  if (!out.length) {
    const linkRe = /<a\b[^>]*class\s*=\s*(["'])[^"']*\bjobTitle-link\b[^"']*\1[^>]*>[\s\S]*?<\/a>/gi;
    let link;
    while ((link = linkRe.exec(String(html || '')))) {
      const tag = link[0].match(/^<a\b[^>]*>/i);
      const detailUrl = absoluteUrl(attr(tag && tag[0], 'href'), source);
      const key = postingId(detailUrl) || detailUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: postingId(detailUrl), title: cleanDescription(decodeEntities(link[0])),
        company: source && source.name || '', location: '', postedAt: '', detailUrl, applyUrl: detailUrl });
    }
  }
  return out;
}

function schemaLocation(jobLocation) {
  const entries = Array.isArray(jobLocation) ? jobLocation : (jobLocation ? [jobLocation] : []);
  return entries.map(place => {
    const a = place && (place.address || place) || {};
    return [a.addressLocality, a.addressRegion, a.addressCountry, a.postalCode].filter(Boolean).join(', ');
  }).filter(Boolean).join(' | ');
}

function findJobPosting(value) {
  if (!value || typeof value !== 'object') return null;
  if (String(value['@type'] || '').toLowerCase() === 'jobposting') return value;
  if (Array.isArray(value)) {
    for (const child of value) { const found = findJobPosting(child); if (found) return found; }
    return null;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') { const found = findJobPosting(child); if (found) return found; }
  }
  return null;
}

function jsonLdJob(html) {
  const re = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    try { const found = findJobPosting(JSON.parse(m[2])); if (found) return found; }
    catch (_) { /* malformed optional metadata; microdata remains authoritative */ }
  }
  return null;
}

function microdataValue(html, property) {
  const tag = findTag(html, 'meta', candidate => attr(candidate, 'itemprop') === property);
  return attr(tag, 'content');
}

function parseDetailPage(html, source, pageUrl) {
  const json = jsonLdJob(html);
  const titleEl = findElement(html, 'span', tag => attr(tag, 'itemprop') === 'title');
  const descriptionEl = findElement(html, 'span', tag => attr(tag, 'itemprop') === 'description');
  const applyTag = findTag(html, 'a', tag => /\/talentcommunity\/apply\//i.test(attr(tag, 'href')) || hasClass(tag, 'dialogApplyBtn'));
  const canonicalTag = findTag(html, 'link', tag => /\bcanonical\b/i.test(attr(tag, 'rel')));
  const canonical = absoluteUrl(attr(canonicalTag, 'href'), source) || pageUrl;

  const locality = microdataValue(html, 'addressLocality');
  const region = microdataValue(html, 'addressRegion');
  const country = microdataValue(html, 'addressCountry');
  const postal = microdataValue(html, 'postalCode');
  const location = [locality, region, country, postal].filter(Boolean).join(', ');
  const org = json && json.hiringOrganization;
  const identifier = json && json.identifier;
  return {
    id: (identifier && typeof identifier === 'object' ? identifier.value : identifier) || postingId(canonical),
    title: textFromElement(titleEl) || json && (json.title || json.name) || '',
    company: source && source.name || (typeof org === 'object' ? org.name : org) || microdataValue(html, 'hiringOrganization'),
    location: location || schemaLocation(json && json.jobLocation),
    postedAt: normalizeDate(microdataValue(html, 'datePosted') || json && json.datePosted),
    description: textFromElement(descriptionEl) || json && json.description || '',
    detailUrl: canonical,
    applyUrl: absoluteUrl(attr(applyTag, 'href'), source) || json && json.url || canonical,
  };
}

function normalize(raw, source) {
  return makeJob({
    id: raw && (raw.id || postingId(raw.detailUrl || raw.applyUrl)),
    title: raw && raw.title,
    company: source && source.name || raw && raw.company,
    location: raw && raw.location,
    remote: raw && raw.remote,
    applyUrl: raw && (raw.applyUrl || raw.detailUrl),
    ats: ATS,
    postedAt: raw && raw.postedAt,
    description: raw && raw.description,
  });
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok) throw new Error(`SuccessFactors HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

async function enrichDetails(rows, source, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const concurrency = Math.max(1, opts.detailConcurrency || 6);
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const raw = rows[next++];
      if (!raw || !raw.detailUrl) continue;
      try {
        const detail = parseDetailPage(await fetchText(raw.detailUrl, timeoutMs), source, raw.detailUrl);
        // A theme/challenge page without JobPosting fields must not erase valid search data.
        if (detail.title || detail.description) Object.assign(raw, detail);
      } catch (_) { /* retain the listing when one public detail GET fails */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return rows;
}

async function fetchJobs(source, {
  timeoutMs = 15000, max = 200, detailConcurrency = 6, detailMax = 120,
} = {}) {
  if (!sourceBase(source)) return [];
  const pageSize = Math.max(1, Number(source.pageSize) || 25);
  const queries = Array.isArray(source.queries) && source.queries.length
    ? source.queries : [source.query || ''];
  const byId = new Map();

  for (const query of queries) {
    for (let start = 0; start < max && byId.size < max; start += pageSize) {
      let page;
      try { page = parseSearchPage(await fetchText(searchUrl(source, start, query), timeoutMs), source); }
      catch (_) { break; }
      if (!page.length) break;
      const before = byId.size;
      for (const row of page) {
        const key = row.id || row.detailUrl;
        if (key && !byId.has(key) && byId.size < max) byId.set(key, row);
      }
      if (page.length < pageSize || byId.size === before) break;
    }
  }

  const rows = Array.from(byId.values());
  const relevant = rows.filter(row => /\b(engineer|engineering|scientist)\b/i.test(row.title || ''))
    .slice(0, Math.max(0, detailMax));
  await enrichDetails(relevant, source, { timeoutMs, detailConcurrency });
  return rows.map(row => normalize(row, source));
}

module.exports = {
  ATS, decodeEntities, sourceBase, searchUrl, postingId, parseSearchPage,
  parseDetailPage, normalize, enrichDetails, fetchJobs,
};
