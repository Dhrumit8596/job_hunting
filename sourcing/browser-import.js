'use strict';

// Pure boundary between browser collectors (LinkedIn / Indeed / Glassdoor) and the
// normalized sourcing corpus. Browser collectors intentionally have slightly different
// shapes; this module makes their identity, channel and provenance explicit before the
// records enter cross-source dedupe.

const { makeJob, clean, cleanDescription } = require('./normalize');
const { detectAts } = require('./detect-ats');

const PLATFORMS = new Set(['linkedin', 'indeed', 'glassdoor']);
const CHANNELS = new Set(['linkedin_easy_apply', 'indeed_apply', 'external']);
const DESCRIPTION_STATUSES = new Set(['full', 'partial', 'missing', 'stale']);

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function supportedPlatform(value) {
  const p = lower(value).replace(/^browser[-_:]/, '');
  return PLATFORMS.has(p) ? p : '';
}

function platformFromUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
    if (/(^|\.)indeed\.com$/.test(host)) return 'indeed';
    if (/(^|\.)glassdoor\.com$/.test(host)) return 'glassdoor';
  } catch (_) {}
  return '';
}

function detectBrowserPlatform(raw) {
  raw = raw || {};
  const explicit = [
    raw.sourcePlatform,
    raw.platform,
    raw.provenance && raw.provenance.sourcePlatform,
    raw.provenance && raw.provenance.platform,
    raw.ats,
  ];
  for (const value of explicit) {
    const p = supportedPlatform(value);
    if (p) return p;
  }
  const urls = [raw.listingUrl, raw.url, raw.sourceUrl, raw.applyUrl, raw.externalApplyUrl];
  for (const value of urls) {
    const p = platformFromUrl(value);
    if (p) return p;
  }
  return '';
}

function validHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch (_) { return null; }
}

function canonicalizeUrl(value) {
  const u = validHttpUrl(value);
  if (!u) return '';
  u.hash = '';
  // Strip only known tracking parameters. Job identifiers such as jk, jl and
  // jobListingId remain intact and therefore keep the URL posting-specific.
  for (const key of Array.from(u.searchParams.keys())) {
    if (/^(utm_.+|trk|trackingId|ref|refId|source|src|campaign|from|advn|vjs)$/i.test(key)) {
      u.searchParams.delete(key);
    }
  }
  u.searchParams.sort();
  return u.toString();
}

function stripPlatformPrefix(value, platform) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  return s.replace(new RegExp('^' + platform + '[:_-]', 'i'), '');
}

function idFromUrl(value, platform) {
  const u = validHttpUrl(value);
  if (!u) return '';
  let match;
  if (platform === 'linkedin') {
    match = u.pathname.match(/\/jobs\/view\/(\d+)/i);
    if (match) return match[1];
    const current = u.searchParams.get('currentJobId');
    if (current && /^\d+$/.test(current)) return current;
  }
  if (platform === 'indeed') {
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    if (jk) return jk.trim();
  }
  if (platform === 'glassdoor') {
    const queryId = u.searchParams.get('jobListingId') || u.searchParams.get('jl');
    if (queryId) return queryId.trim();
    match = u.pathname.match(/(?:jobListingId|job-listing)[_/-](\d+)/i);
    if (match) return match[1];
  }
  return '';
}

function sourceId(raw, platform) {
  raw = raw || {};
  const platformSpecific = platform === 'linkedin'
    ? [raw.sourceJobId, raw.linkedinJobId, raw.jobId]
    : platform === 'indeed'
      ? [raw.sourceJobId, raw.indeedJobId, raw.jobKey, raw.jobId]
      : [raw.sourceJobId, raw.jobListingId, raw.listingId, raw.glassdoorJobId, raw.jobId];
  for (const value of platformSpecific) {
    const id = stripPlatformPrefix(value, platform);
    if (id) return id;
  }
  for (const value of [raw.listingUrl, raw.url, raw.sourceUrl, raw.applyUrl]) {
    const id = idFromUrl(value, platform);
    if (id) return id;
  }
  const generic = stripPlatformPrefix(raw.id, platform);
  if (generic && !/^job_\d+_/i.test(generic)) return generic;

  // Some Glassdoor layouts omit the listing id but still expose a stable detail URL.
  // Retaining the canonical URL is collision-free and deterministic; callers may safely
  // namespace it with sourcePlatform when building the corpus canonical id.
  const fallbackUrl = canonicalizeUrl(raw.listingUrl || raw.url || raw.sourceUrl);
  return fallbackUrl ? 'url:' + fallbackUrl : '';
}

function platformListingUrl(raw, platform, id) {
  raw = raw || {};
  if (platform === 'linkedin' && id && /^\d+$/.test(id)) {
    return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  if (platform === 'indeed' && id && !id.startsWith('url:')) {
    return `https://www.indeed.com/viewjob?jk=${encodeURIComponent(id)}`;
  }
  const candidates = [raw.listingUrl, raw.url, raw.sourceUrl, raw.applyUrl];
  for (const value of candidates) {
    if (platformFromUrl(value) === platform) return canonicalizeUrl(value);
  }
  return '';
}

function normalizeChannel(raw, platform) {
  const requested = lower(raw && raw.channel).replace(/[ -]+/g, '_');
  const aliases = {
    easy_apply: 'linkedin_easy_apply',
    linkedin_easy: 'linkedin_easy_apply',
    linkedin_easy_apply: 'linkedin_easy_apply',
    indeed_easy_apply: 'indeed_apply',
    indeed_apply: 'indeed_apply',
    external: 'external',
  };
  const explicit = aliases[requested] || '';
  if (explicit && CHANNELS.has(explicit)) {
    if (platform === 'linkedin' && explicit === 'linkedin_easy_apply') return explicit;
    if (platform === 'indeed' && explicit === 'indeed_apply') return explicit;
    if (explicit === 'external') return explicit;
  }
  if (platform === 'linkedin' && (raw.isEasyApply === true || raw.easyApply === true)) {
    return 'linkedin_easy_apply';
  }
  if (platform === 'indeed' && (raw.indeedApply === true || raw.isIndeedApply === true)) {
    return 'indeed_apply';
  }
  return 'external';
}

function externalCandidate(raw, platform) {
  for (const value of [raw.externalApplyUrl, raw.companyApplyUrl, raw.directApplyUrl]) {
    if (validHttpUrl(value)) return canonicalizeUrl(value);
  }
  if (validHttpUrl(raw.applyUrl) && platformFromUrl(raw.applyUrl) !== platform) {
    return canonicalizeUrl(raw.applyUrl);
  }
  return '';
}

function normalizeDescription(raw) {
  const cleaned = cleanDescription(raw && raw.description || '');
  const description = cleaned.slice(0, 20000);
  const stated = lower(raw && raw.descriptionStatus);
  let status = DESCRIPTION_STATUSES.has(stated) ? stated : '';
  if (!status) {
    if (!description) status = 'missing';
    else if (cleaned.length > 20000 || raw.descriptionTruncated === true) status = 'partial';
    else status = 'full';
  }
  return { description, descriptionStatus: status };
}

function discoveryTime(raw, opts) {
  const value = raw.discoveredAt != null ? raw.discoveredAt
    : raw.scrapedAt != null ? raw.scrapedAt
      : raw.savedAt != null ? raw.savedAt
        : opts && opts.discoveredAt != null ? opts.discoveredAt : null;
  return value == null || value === '' ? null : value;
}

function normalizeBrowserJob(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sourcePlatform = detectBrowserPlatform(raw);
  if (!sourcePlatform) return null;
  const sourceJobId = sourceId(raw, sourcePlatform);
  if (!sourceJobId) return null; // fail closed: corpus identity must be stable

  const listingUrl = platformListingUrl(raw, sourcePlatform, sourceJobId);
  const channel = normalizeChannel(raw, sourcePlatform);
  const externalUrl = externalCandidate(raw, sourcePlatform);
  const applyUrl = channel === 'external' ? (externalUrl || listingUrl) : listingUrl;
  const desc = normalizeDescription(raw);
  const base = makeJob({
    id: sourceJobId,
    title: raw.title,
    company: raw.company || raw.companyName,
    location: raw.location,
    remote: raw.remote,
    applyUrl,
    ats: sourcePlatform,
    postedAt: raw.postedAt || raw.datePosted || '',
    description: desc.description,
  });
  const detected = lower(raw.detectedAts) || detectAts(applyUrl);
  const query = clean(raw.query || raw.searchQuery || (raw.search && raw.search.query) || opts.query || '');
  const discoveredAt = discoveryTime(raw, opts);
  const modality = 'browser-' + sourcePlatform;
  const sourceRef = {
    kind: 'browser',
    modality,
    sourcePlatform,
    sourceJobId,
    listingUrl,
    applyUrl,
    channel,
    detectedAts: detected,
    query,
    discoveredAt,
    descriptionStatus: desc.descriptionStatus,
  };

  return Object.assign(base, {
    source: 'browser',
    modality,
    sourcePlatform,
    platform: sourcePlatform, // compatibility with the existing channel router
    sourceJobId,
    listingUrl,
    detectedAts: detected,
    channel,
    isEasyApply: channel === 'linkedin_easy_apply',
    indeedApply: channel === 'indeed_apply',
    descriptionStatus: desc.descriptionStatus,
    query,
    discoveredAt,
    provenance: {
      kind: 'browser', modality, sourcePlatform, query, discoveredAt,
    },
    sourceRefs: [sourceRef],
  });
}

function normalizeBrowserJobs(records, opts = {}) {
  const out = [];
  for (const raw of records || []) {
    const job = normalizeBrowserJob(raw, opts);
    if (job) out.push(job);
  }
  return out;
}

function browserSourceKey(job) {
  const platform = supportedPlatform(job && (job.sourcePlatform || job.platform || job.ats));
  const id = job && (job.sourceJobId || job.id);
  return platform && id != null && String(id).trim() ? platform + ':' + String(id).trim() : '';
}

module.exports = {
  PLATFORMS,
  CHANNELS,
  detectBrowserPlatform,
  sourceId,
  normalizeChannel,
  normalizeBrowserJob,
  normalizeBrowserJobs,
  browserSourceKey,
};
