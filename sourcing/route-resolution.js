'use strict';

// Browser captures sometimes carry a posting-specific employer careers URL instead of the final
// ATS URL. This module follows a small, bounded set of those LinkedIn off-site URLs and extracts
// only strong routing evidence: an explicit supported ATS posting URL or a requisition token. A
// token is a search hint, never proof of an apply route; source-run still requires the existing
// unique company/title/location match against an official posting before it replaces the route.

const { detectAts } = require('./detect-ats');
const { detectBrowserPlatform } = require('./browser-import');

const ROUTE_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters']);
const AGGREGATOR_HOST = /(^|\.)(linkedin|indeed|glassdoor)\.com$/i;

function employerKey(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostKey(value) {
  let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  try { host = new URL(host.includes('://') ? host : `https://${host}`).hostname.toLowerCase(); }
  catch (_) { return ''; }
  return host.replace(/^www\./, '');
}

function urlHost(value) {
  try { return hostKey(new URL(String(value || '')).hostname); } catch (_) { return ''; }
}

function routeUrl(job) {
  const platform = detectBrowserPlatform(job || {});
  for (const value of [job && job.externalApplyUrl, job && job.companyApplyUrl,
    job && job.directApplyUrl, job && job.applyUrl]) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      if (/^https?:$/.test(url.protocol) && !AGGREGATOR_HOST.test(url.hostname) &&
          (!platform || !new RegExp(`(^|\\.)${platform}\\.com$`, 'i').test(url.hostname))) return url.toString();
    } catch (_) {}
  }
  return String(job && job.applyUrl || '');
}

function browserId(job) {
  return String(job && (job.sourceJobId || job.jobId || job.linkedinJobId || job.id) || '');
}

function sourceEmployerKeys(source) {
  return Array.from(new Set([source && source.name, ...(Array.isArray(source && source.aliases)
    ? source.aliases : [])].map(employerKey).filter(Boolean)));
}

function sourceCareerHosts(source) {
  return Array.from(new Set((Array.isArray(source && source.careerHosts) ? source.careerHosts : [])
    .map(hostKey).filter(Boolean)));
}

function sourceRouteHosts(source) {
  return Array.from(new Set([...sourceCareerHosts(source),
    ...(Array.isArray(source && source.routeHosts) ? source.routeHosts : []).map(hostKey)]
    .filter(Boolean)));
}

function hintMatchesSource(hint, source) {
  const company = employerKey(hint && (hint.originalCompany || hint.company));
  const host = hostKey(hint && hint.careerHost);
  // Both employer identity and the initial careers/redirect host must be registered. Company-only
  // matching would let a poisoned discovery URL expand the network boundary to an arbitrary site.
  return !!company && !!host && sourceEmployerKeys(source).includes(company) &&
    sourceRouteHosts(source).includes(host);
}

function hintsForSource(source, hints) {
  const terms = [], seen = new Set();
  for (const hint of hints || []) {
    if (!hintMatchesSource(hint, source)) continue;
    for (const value of hint.terms || hint.requisitionTokens || []) {
      const term = String(value || '').trim();
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key); terms.push(term);
      if (terms.length >= 10) return terms;
    }
  }
  return terms;
}

function isSafePublicUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === '::1' || host === '0.0.0.0') return false;
  // No configured employer route uses an IP literal. Reject all IPv6 literals rather than trying
  // to maintain an incomplete private/link-local/IPv4-mapped range parser.
  if (host.includes(':')) return false;
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(Number.isInteger)) {
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)) return false;
  }
  return true;
}

function unknownLinkedInOffsite(job) {
  const platform = detectBrowserPlatform(job || {});
  const url = routeUrl(job);
  const unresolved = job && job.needsAtsResolution === true || (!!url && !detectAts(url));
  if (!job || platform !== 'linkedin' || !unresolved || detectAts(url)) return false;
  const host = urlHost(url);
  return !!host && !AGGREGATOR_HOST.test(host) && isSafePublicUrl(url);
}

function explicitlyAttempted(job) {
  const attempts = job && (job.attemptCount != null ? job.attemptCount :
    Array.isArray(job.attempts) ? job.attempts.length : job.attempts);
  const status = String(job && (job.applicationStatus || job.applyStatus || job.status) || '');
  return !!(job && (job.attempted === true || Number(attempts) > 0 ||
    /^(?:applied|applying|attempted|submitted|submitted_unverified|confirmed|failed|manual|skipped)$/i.test(status)));
}

function priorityTimestamp(job) {
  const value = job && (job.lastSeenAt || job.scrapedAt || job.discoveredAt || job.savedAt || job.postedAt);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function routePriority(job) {
  const fit = Number(job && job.fitScore);
  const relevant = /\b(process|quality|metrology|inspection|validation|test|equipment|reliability|failure analysis|manufacturing)\b/i
    .test(String(job && job.title || '')) ? 1 : 0;
  return { fit: Number.isFinite(fit) ? fit : -1, relevant, fresh: priorityTimestamp(job) };
}

function rankRouteCandidates(jobs) {
  return (jobs || []).filter(job => !explicitlyAttempted(job)).slice().sort((a, b) => {
    const ap = routePriority(a), bp = routePriority(b);
    return bp.fit - ap.fit || bp.relevant - ap.relevant || bp.fresh - ap.fresh ||
      browserId(a).localeCompare(browserId(b));
  });
}

function routeLandingInCooldown(job, options = {}) {
  const attemptedAt = priorityTimestamp({ lastSeenAt: job && job.routeLandingAttemptedAt });
  if (!attemptedAt) return false;
  const configured = options.landingRetryCooldownMs != null ? Number(options.landingRetryCooldownMs) : 6 * 60 * 60 * 1000;
  const cooldownMs = Math.max(0, Number.isFinite(configured) ? configured : 6 * 60 * 60 * 1000);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return cooldownMs > 0 && now - attemptedAt < cooldownMs;
}

function decodeMarkup(value) {
  return String(value || '').replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function canonicalUrl(value, base) {
  let text = decodeMarkup(value).trim().replace(/[),.;]+$/, '');
  try {
    const url = new URL(text, base);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch (_) { return ''; }
}

function postingTokenFromDirectUrl(value, ats = detectAts(value)) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { return ''; }
  const parts = url.pathname.split('/').filter(Boolean);
  let match;
  if (ats === 'greenhouse') {
    match = url.pathname.match(/\/jobs\/(\d{5,})(?:\/|$)/i);
    return match && match[1] || '';
  }
  if (ats === 'lever') return parts.length >= 2 && /^[a-z0-9-]{6,}$/i.test(parts[1]) ? parts[1] : '';
  if (ats === 'ashby') return parts.length >= 2 &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(parts[1]) ? parts[1] : '';
  if (ats === 'workday') {
    match = url.pathname.match(/\/job\/[\s\S]*_((?:[a-z]-?)?\d[\w-]{3,})\/?$/i);
    return match && match[1] || '';
  }
  if (ats === 'smartrecruiters') return parts.length >= 2 && /^[a-z0-9-]{5,}$/i.test(parts[1])
    ? parts[1] : '';
  return '';
}

function isPostingSpecificDirectUrl(value) {
  const ats = detectAts(value);
  return ROUTE_ATS.has(ats) && !!postingTokenFromDirectUrl(value, ats);
}

function directIdentity(value) {
  const ats = detectAts(value);
  const token = postingTokenFromDirectUrl(value, ats);
  return ats && token ? `${ats}:${token.toLowerCase()}` : '';
}

function explicitDirectUrls(landingUrl, html) {
  const decoded = decodeMarkup(html);
  const raw = [landingUrl];
  const absolute = /https?:\/\/[^\s"'<>\\]+/gi;
  let match;
  while ((match = absolute.exec(decoded)) && raw.length < 200) raw.push(match[0]);
  const byIdentity = new Map();
  for (const value of raw) {
    const url = canonicalUrl(value, landingUrl);
    if (!url || !isPostingSpecificDirectUrl(url)) continue;
    const identity = directIdentity(url);
    if (!byIdentity.has(identity) || /\/application\/?(?:\?|$)/i.test(url)) byIdentity.set(identity, url);
  }
  return Array.from(byIdentity.values());
}

function addToken(out, value) {
  const token = String(value || '').trim().replace(/[),.;]+$/, '');
  if (!/^(?:R-?\d{5,}|[A-Z]{1,5}-?\d{4,}|\d{5,}(?:-\d+)?|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(token)) return;
  const key = token.toLowerCase();
  if (!out.some(item => item.toLowerCase() === key) && out.length < 8) out.push(token);
}

function tokensFromUrl(out, value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { return; }
  for (const key of ['gh_jid', 'jobId', 'job_id', 'requisitionId', 'requisition_id', 'reqId', 'req_id']) {
    addToken(out, url.searchParams.get(key));
  }
  const pathPatterns = [
    /\/jobs?\/(R-?\d{5,})(?:\/|$)/ig,
    /[_/-](R-?\d{5,})(?:[/?#]|$)/ig,
  ];
  for (const pattern of pathPatterns) {
    let match;
    while ((match = pattern.exec(url.pathname))) addToken(out, match[1]);
  }
  addToken(out, postingTokenFromDirectUrl(value));
}

function extractRequisitionTokens(job, landingUrl, html, directUrls) {
  const out = [];
  tokensFromUrl(out, routeUrl(job));
  tokensFromUrl(out, landingUrl);
  for (const directUrl of directUrls || []) tokensFromUrl(out, directUrl);
  const decoded = decodeMarkup(html).slice(0, 262144);
  const labeled = /(?:job\s+)?(?:requisition|req(?:uisition)?|job)[\s\S]{0,48}?(?:id|number|no\.?|#|token)\s*["'=:\s-]{0,12}((?:R-?\d{5,}|[A-Z]{1,5}-?\d{4,}|\d{5,}(?:-\d+)?|[0-9a-f]{8}-[0-9a-f-]{27,}))/gi;
  let match;
  while ((match = labeled.exec(decoded))) addToken(out, match[1]);
  // Several employer career sites place an unlabelled, posting-specific R-token in canonical/meta
  // URLs. Unlike a naked number, this prefix is strong enough to use as a lookup hint.
  const rTokens = /\bR-?\d{5,}\b/gi;
  while ((match = rTokens.exec(decoded))) addToken(out, match[0]);
  return out;
}

async function readBoundedText(response, maxBytes) {
  const limit = Math.max(1024, Math.min(524288, Number(maxBytes) || 262144));
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < limit) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value || new Uint8Array();
      chunks.push(chunk.slice(0, limit - size));
      size += chunk.length;
    }
    if (size >= limit && typeof reader.cancel === 'function') await reader.cancel().catch(() => {});
    const joined = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(joined);
  }
  if (!response || typeof response.text !== 'function') return '';
  return String(await response.text()).slice(0, limit);
}

async function fetchLanding(startUrl, options = {}) {
  const fetchFn = options.fetchFn || global.fetch;
  if (typeof fetchFn !== 'function') throw new Error('route_fetch_unavailable');
  const maxRedirects = Math.max(0, Math.min(4, Number(options.maxRedirects) || 3));
  const timeoutMs = Math.max(250, Math.min(10000, Number(options.timeoutMs) || 5000));
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(Object.assign(new Error('route_fetch_timeout'), { name: 'AbortError' }));
    }, timeoutMs);
  });
  const bounded = promise => Promise.race([promise, deadline]);
  let current = canonicalUrl(startUrl);
  const allowedHosts = Array.from(new Set((options.allowedHosts || []).map(hostKey).filter(Boolean)));
  const routeAllowed = value => {
    if (!isSafePublicUrl(value)) return false;
    if (!allowedHosts.length) return true;
    const host = urlHost(value);
    return allowedHosts.includes(host) || ROUTE_ATS.has(detectAts(value));
  };
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      if (!routeAllowed(current)) throw new Error('route_redirect_host_not_attested');
      const response = await bounded(fetchFn(current, { method: 'GET', redirect: 'manual', signal: ctrl.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' } }));
      const status = Number(response && response.status || 0);
      const location = response && response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location') : '';
      if (status >= 300 && status < 400 && location) {
        if (redirects >= maxRedirects) throw new Error('route_redirect_limit');
        current = canonicalUrl(location, current);
        if (!routeAllowed(current)) throw new Error('route_redirect_host_not_attested');
        continue;
      }
      const effective = canonicalUrl(response && response.url || current, current) || current;
      if (!routeAllowed(effective)) throw new Error('route_redirect_host_not_attested');
      const html = await bounded(readBoundedText(response, options.maxBytes));
      return { response, landingUrl: effective, html };
    }
    throw new Error('route_redirect_limit');
  } finally { clearTimeout(timer); }
}

function sourceMatchesForJob(job, sources) {
  const hint = { originalCompany: job && (job.company || job.companyName), careerHost: urlHost(routeUrl(job)) };
  return (sources || []).filter(source => hintMatchesSource(hint, source));
}

async function inspectUnknownDirectRoutes(browserJobs, sources, options = {}) {
  const requestedLimit = options.limit == null ? 20 : Number(options.limit);
  const limit = Math.max(0, Math.min(20, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  // Employer attestation happens before any network request. This prevents arbitrary LinkedIn
  // off-site URLs from expanding the fetch boundary and also makes each extracted hint source-
  // scoped. Explicitly attempted captures never enter this improvement frontier.
  const candidates = rankRouteCandidates((browserJobs || []).filter(job => unknownLinkedInOffsite(job) &&
    sourceMatchesForJob(job, sources).length === 1 && !routeLandingInCooldown(job, options))).slice(0, limit);
  const updates = new Map(), hints = [], outcomes = [];
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 3));
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const job = candidates[next++];
      try {
        const originalUrl = routeUrl(job);
        const sourceMatch = sourceMatchesForJob(job, sources)[0];
        const { landingUrl, html } = await fetchLanding(originalUrl,
          { ...options, allowedHosts: sourceRouteHosts(sourceMatch) });
        const directUrls = explicitDirectUrls(landingUrl, html);
        const tokens = extractRequisitionTokens(job, landingUrl, html, directUrls);
        const matches = sourceMatchesForJob(job, sources);
        const canonicalNames = Array.from(new Set(matches.map(source => String(source.name || '').trim()).filter(Boolean)));
        let updated = job;
        const originalCompany = updated.company || updated.companyName || '';
        if (canonicalNames.length === 1 && employerKey(originalCompany) !== employerKey(canonicalNames[0])) {
          updated = { ...updated, routeCompanyAlias: originalCompany, company: canonicalNames[0] };
        }
        const directUrl = directUrls.length === 1 ? directUrls[0] : '';
        const directToken = postingTokenFromDirectUrl(directUrl);
        const tokenAttested = !!directToken && tokens.some(token => token.toLowerCase() === directToken.toLowerCase());
        const directEvidence = !!directUrl && matches.length === 1 &&
          detectAts(directUrl) === String(matches[0].ats || '').toLowerCase() && tokenAttested;
        const status = directEvidence ? 'direct_lookup_evidence' : tokens.length && matches.length ? 'hint_extracted'
          : directUrls.length > 1 ? 'ambiguous_direct_urls'
            : directUrls.length === 1 ? 'unattested_direct_url' : 'no_explicit_route_evidence';
        const attemptedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
        updated = { ...updated, routeLandingStatus: status, routeLandingAttemptedAt: attemptedAt,
          routeLandingAttempts: (Number(job.routeLandingAttempts) || 0) + 1,
          routeLandingReason: status === 'no_explicit_route_evidence' ? status : '' };
        updates.set(job, updated);
        if (tokens.length && matches.length) hints.push({ browserJobId: browserId(job),
          company: updated.company || updated.companyName, originalCompany,
          careerHost: urlHost(originalUrl),
          terms: tokens, requisitionTokens: tokens, matchedSources: matches.map(source => source.name) });
        outcomes.push({ id: browserId(job), status, attemptedAt,
          requisitionTokens: tokens, directAts: directEvidence ? detectAts(directUrl) : '',
          matchedSourceCount: matches.length });
      } catch (error) {
        const reason = error && error.name === 'AbortError' ? 'timeout' : String(error && error.message || 'fetch_failed');
        const attemptedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
        updates.set(job, { ...job, routeLandingStatus: 'inspection_failed', routeLandingAttemptedAt: attemptedAt,
          routeLandingAttempts: (Number(job.routeLandingAttempts) || 0) + 1, routeLandingReason: reason });
        outcomes.push({ id: browserId(job), status: 'inspection_failed', attemptedAt, reason });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, worker));
  return { jobs: (browserJobs || []).map(job => updates.get(job) || job), hints, outcomes,
    inspected: candidates.length, directHints: outcomes.filter(row => row.status === 'direct_lookup_evidence').length,
    hintsExtracted: outcomes.filter(row => row.status === 'hint_extracted' || row.status === 'direct_lookup_evidence')
      .filter(row => row.requisitionTokens && row.requisitionTokens.length).length };
}

module.exports = { ROUTE_ATS, employerKey, hostKey, sourceEmployerKeys, sourceCareerHosts, sourceRouteHosts,
  hintMatchesSource, hintsForSource, isSafePublicUrl, unknownLinkedInOffsite,
  routeUrl, explicitlyAttempted, routePriority, rankRouteCandidates, routeLandingInCooldown,
  postingTokenFromDirectUrl, isPostingSpecificDirectUrl, explicitDirectUrls,
  extractRequisitionTokens, readBoundedText, fetchLanding, inspectUnknownDirectRoutes };
