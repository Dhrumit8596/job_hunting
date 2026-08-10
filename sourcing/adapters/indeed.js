'use strict';
// Indeed discovery adapter.
//
// Known limitation: Indeed search pages are increasingly protected by anti-bot layers when fetched
// from Node/untrusted origins. This adapter attempts best-effort parsing from public HTML/embedded JSON,
// but gracefully returns an empty list on challenge pages so sourcing stays deterministic and safe.
const { makeJob } = require('../normalize');

const ATS = 'indeed';
const MODALITY = 'discovery';
const LOCATION_DEFAULT = 'United States';

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // Some captured payloads include a leading backslash from line-continuation style fixtures.
    const trimmed = String(text).trim();
    if (trimmed && trimmed[0] === '\\') {
      try {
        return JSON.parse(trimmed.replace(/^\\\\+/, '').trim());
      } catch (_) { }
    }
    return null;
  }
}

function extractJsonFromHtml(html) {
  const candidates = [
    /window\.mosaic\.providerData\s*=\s*({[\s\S]*?})\s*;/i,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;/i,
    /window\.__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*;/i,
    /<script\s+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const re of candidates) {
    const m = String(html || '').match(re);
    if (!m) continue;
    const parsed = safeJsonParse(m[1]);
    if (parsed) return parsed;
  }
  return null;
}

function collectJobNodes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectJobNodes(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.jobkey === 'string' && node.jobkey) out.push(node);
  const entries = Array.isArray(node.jobs) ? node.jobs :
    Array.isArray(node.results) ? node.results :
    Array.isArray(node.jobMap) ? node.jobMap :
    Array.isArray(node.jobCards) ? node.jobCards :
    Array.isArray(node.data) ? node.data : null;
  if (entries) {
    for (const item of entries) collectJobNodes(item, out);
  }
  for (const value of Object.values(node)) {
    if (value && (Array.isArray(value) || typeof value === 'object')) collectJobNodes(value, out);
  }
  return out;
}

function extractJobsFromState(state) {
  if (!state) return [];
  const jobs = [];
  const candidates = collectJobNodes(state);
  const seen = new Set();
  for (const raw of candidates) {
    const id = String(raw.jobkey || raw.jobKey || raw.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = cleanText(raw.title || raw.jobTitle || raw.job_title || raw.position || raw.name || '');
    const company = cleanText(raw.companyName || raw.company || (raw.employer && raw.employer.name) || '');
    const location = cleanText(raw.formattedLocation || raw.location || (raw.jobLocation && raw.jobLocation.location) || '');
    const description = cleanText(raw.snippet || raw.summary || raw.description || raw.jobDescription || '');
    const applyUrl = cleanText(
      (raw.jobLocationUrl && `https://www.indeed.com${raw.jobLocationUrl}`) ||
      raw.viewJobLink ||
      raw.url ||
      raw.link ||
      (id ? `https://www.indeed.com/viewjob?jk=${encodeURIComponent(id)}` : ''));
    const postedAt = cleanText(raw.formattedRelativeTime || raw.postedDate || raw.postedAt || '');
    if (!title || !company || !applyUrl) continue;
    const indeedApply = !!(raw.indeedApply || raw.isEasyApply || /easy\s*apply/i.test(String(raw.applyType || raw.type || '')));

    jobs.push({
      id,
      title,
      company,
      location: location || LOCATION_DEFAULT,
      applyUrl,
      postedAt,
      description,
      indeedApply,
      sourceJobId: id,
      platform: 'indeed',
      sourcePlatform: 'indeed',
    });
  }
  return jobs;
}

function extractJobsFromAnchorHints(html) {
  const out = [];
  const seen = new Set();
  const m = String(html || '').matchAll(/\bhref=\"([^\"']*viewjob\?jk=([a-z0-9_-]+)[^\"]*)\"[^>]*>\s*([^<]*?)\s*<\/a>/gi);
  for (const match of m) {
    const applyUrl = cleanText(match[1]);
    const id = String(match[2] || '').trim();
    const title = cleanText(match[3]);
    if (!id || seen.has(id) || !title) continue;
    seen.add(id);
    out.push({ id, title, company: '', location: LOCATION_DEFAULT, applyUrl, indeedApply: false, sourceJobId: id, platform: 'indeed', sourcePlatform: 'indeed' });
  }
  return out;
}

function normalize(raw) {
  const job = makeJob({
    id: raw.id,
    title: raw.title,
    company: raw.company,
    location: raw.location,
    remote: false,
    applyUrl: raw.applyUrl,
    ats: ATS,
    postedAt: raw.postedAt || '',
    description: raw.description || '',
  });
  return Object.assign({}, job, {
    detectedAts: ATS,
    sourceJobId: raw.sourceJobId || raw.id,
    platform: 'indeed',
    sourcePlatform: 'indeed',
    indeedApply: !!raw.indeedApply,
    channel: raw.indeedApply ? 'indeed_apply' : 'external',
  });
}

function isBlockedPage(html) {
  return /verify(?:\s+you\s+are\s+human|\s+are\s+you\s+human)|captcha|challenge/gi.test(String(html || '')) ||
    /cf-challenge|challenge-platform|recaptcha/i.test(String(html || ''));
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; PJA-Discovery/1.0)',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Indeed discovery HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJobs(_source, opts = {}) {
  const queries = opts.queries || ['quality engineer', 'process engineer', 'manufacturing engineer'];
  const timeoutMs = opts.timeoutMs || 15000;
  const seen = new Set();
  const out = [];
  const pushUnique = job => {
    const key = String(job.id || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(job);
  };

  for (const q of queries) {
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(String(q))}&l=${encodeURIComponent(LOCATION_DEFAULT)}&sort=date`;
    try {
      const html = await fetchText(url, timeoutMs);
      if (isBlockedPage(html)) return out;
      const state = extractJsonFromHtml(html);
      const rows = state ? extractJobsFromState(state) : extractJobsFromAnchorHints(html);
      for (const raw of rows) pushUnique(normalize(raw));
    } catch (_) {
      // keep discovery resilient: ignore blocked/failed query pages and continue to the next term
      continue;
    }
  }
  return out;
}

module.exports = { ATS, MODALITY, fetchJobs, normalize, extractJobsFromState, extractJobsFromAnchorHints, cleanText };
