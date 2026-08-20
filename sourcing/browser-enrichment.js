'use strict';

const { detectAts } = require('./detect-ats');

function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function companyIdentity(value) {
  return norm(value).replace(/\b(?:incorporated|inc|limited|ltd|llc|corporation|corp|company|co)\b$/g, '').trim();
}
function presentationLocation(value) {
  return norm(value)
    .replace(/\b(?:on site|onsite|hybrid|remote)\b/g, ' ')
    .replace(/\b(?:united states of america|united states|usa)\b/g, ' ')
    .replace(/\bcalifornia\b/g, 'ca')
    .replace(/\s+/g, ' ').trim();
}
function exactIdentity(job) {
  return [norm(job && job.company), norm(job && job.title), presentationLocation(job && job.location)].join('::');
}
function aliasIdentity(job) {
  return [companyIdentity(job && job.company), norm(job && job.title), presentationLocation(job && job.location)].join('::');
}
function hasStrongIdentity(job) {
  return !!(norm(job && job.company) && norm(job && job.title) && presentationLocation(job && job.location));
}
function isDirect(job) {
  try { return !/(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(new URL(job && job.applyUrl || '').hostname); }
  catch (_) { return false; }
}
function resolveAgainstOfficial(browserJobs, officialPostings) {
  const official = (officialPostings || []).filter(row => row && isDirect(row));
  const groups = new Map();
  const aliasGroups = new Map();
  for (const row of official) {
    if (!hasStrongIdentity(row)) continue;
    const key = exactIdentity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    const aliases = [row.company, ...(Array.isArray(row.sourceAliases) ? row.sourceAliases : [])];
    for (const alias of aliases) {
      const aliasKey = [companyIdentity(alias), norm(row.title), presentationLocation(row.location)].join('::');
      if (!aliasGroups.has(aliasKey)) aliasGroups.set(aliasKey, []);
      if (!aliasGroups.get(aliasKey).includes(row)) aliasGroups.get(aliasKey).push(row);
    }
  }
  const outcomes = [];
  const jobs = (browserJobs || []).map(job => {
    if (!job || job.needsAtsResolution !== true) return job;
    if (!hasStrongIdentity(job)) {
      outcomes.push({ id: job.id, status: 'identity_mismatch', reason: 'incomplete_browser_identity' });
      return { ...job, resolutionReason: 'incomplete_browser_identity' };
    }
    const exactMatches = groups.get(exactIdentity(job)) || [];
    const matches = exactMatches.length ? exactMatches : aliasGroups.get(aliasIdentity(job)) || [];
    if (!matches.length) { outcomes.push({ id: job.id, status: 'no_match', reason: 'no_exact_official_identity' }); return job; }
    if (matches.length !== 1) { outcomes.push({ id: job.id, status: 'ambiguous', reason: 'multiple_exact_official_identities' }); return job; }
    const match = matches[0];
    if (!isDirect(match) || !match.applyUrl || !detectAts(match.applyUrl)) {
      outcomes.push({ id: job.id, status: 'identity_mismatch', reason: 'official_route_not_supported' }); return job;
    }
    const method = exactMatches.length ? 'official_exact_company_title_location'
      : 'official_unique_company_alias_title_location';
    const officialDescription = String(match.description || '').trim();
    const browserDescription = String(job.description || '').trim();
    const browserDescriptionUsable = !!browserDescription &&
      !/^(missing|stale|needs_description)$/i.test(String(job.descriptionStatus || ''));
    const resolvedDescription = officialDescription || (browserDescriptionUsable ? browserDescription : '');
    const resolvedDescriptionStatus = officialDescription
      ? match.descriptionStatus || 'complete'
      : browserDescriptionUsable ? job.descriptionStatus || 'full' : match.descriptionStatus || job.descriptionStatus;
    outcomes.push({ id: job.id, status: 'resolved', method,
      confidence: 'high', officialId: match.id });
    return { ...job, applyUrl: match.applyUrl, externalApplyUrl: match.applyUrl,
      detectedAts: match.detectedAts || detectAts(match.applyUrl), channel: 'external',
      needsAtsResolution: false, resolutionMethod: method,
      resolutionConfidence: 'high', resolutionOfficialId: match.id,
      description: resolvedDescription,
      descriptionStatus: resolvedDescriptionStatus,
      hydrationStatus: resolvedDescription ? 'hydration_success' : job.hydrationStatus,
      hydrationMethod: officialDescription ? 'official_record_merge'
        : browserDescriptionUsable ? job.hydrationMethod : job.hydrationMethod,
      hydratedAt: officialDescription ? match.hydratedAt || null : job.hydratedAt || null };
  });
  return { jobs, outcomes, resolved: outcomes.filter(row => row.status === 'resolved').length,
    ambiguous: outcomes.filter(row => row.status === 'ambiguous').length,
    noMatch: outcomes.filter(row => row.status === 'no_match').length,
    identityMismatch: outcomes.filter(row => row.status === 'identity_mismatch').length };
}

function hydrationPriority(job, options = {}) {
  let score = 0;
  if (job && job.lastSeenAt && timestampMs(job.lastSeenAt) >= Number(options.freshAfter || 0)) score += 30;
  // An unresolved off-site lead can gain both its trusted direct route and its JD in one bounded
  // Voyager read, so it has more autonomous-supply value than an already routed assisted lead.
  if (job && job.needsAtsResolution === true) score += 35;
  if (job && (job.channel === 'linkedin_easy_apply' || job.channel === 'indeed_apply')) score += 25;
  if (job && isDirect(job)) score += 20;
  if (/\b(process|quality|metrology|inspection|validation|test|equipment|reliability|failure analysis|manufacturing) engineer\b/i.test(String(job && job.title || ''))) score += 25;
  if (/\b(senior|sr\.?|staff|principal|lead|manager|director)\b/i.test(String(job && job.title || ''))) score -= 25;
  // Prescores are only a hydration-order hint, never qualification. They let a bounded browser
  // read spend capacity on likely-relevant roles before generic/low-fit leads.
  const fit = Number(job && job.fitScore);
  if (Number.isFinite(fit)) score += Math.max(0, Math.min(30, Math.floor((fit - 45) / 2)));
  const attemptedAt = timestampMs(job && job.routeResolutionAttemptedAt);
  const cooldownMs = Math.max(0, options.routeRetryCooldownMs != null
    ? Number(options.routeRetryCooldownMs) || 0 : 6 * 60 * 60 * 1000);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  if (job && /^(unresolved|no_progress)$/i.test(String(job.routeResolutionStatus || '')) &&
      Number.isFinite(attemptedAt) && now - attemptedAt < cooldownMs) score -= 200;
  return score;
}
function missingDescription(job) {
  return !job || !job.description || /^(missing|stale|needs_description)$/i.test(String(job.descriptionStatus || ''));
}
function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(String(value == null ? '' : value).trim());
  if (Number.isFinite(numeric) && String(value == null ? '' : value).trim()) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}
function recentNoProgress(job, kind, options = {}) {
  const route = kind === 'route';
  const status = String(job && job[route ? 'routeResolutionStatus' : 'hydrationStatus'] || '');
  if (route ? !/^(unresolved|no_progress)$/i.test(status) : !/^hydration_no_progress$/i.test(status)) return false;
  const attemptedAt = timestampMs(job && job[route ? 'routeResolutionAttemptedAt' : 'hydrationAttemptedAt']);
  if (!Number.isFinite(attemptedAt)) return false;
  const key = route ? 'routeRetryCooldownMs' : 'hydrationRetryCooldownMs';
  const fallback = 6 * 60 * 60 * 1000;
  const cooldownMs = Math.max(0, options[key] != null ? Number(options[key]) || 0 : fallback);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return cooldownMs > 0 && now - attemptedAt < cooldownMs;
}
function selectHydrationFrontier(jobs, options = {}) {
  const requestedLimit = options.limit != null ? Number(options.limit) : 20;
  const limit = Math.max(0, Math.min(50, Number.isFinite(requestedLimit) ? requestedLimit : 20));
  if (!limit) return [];
  const eligible = (jobs || []).filter(job => job && /^(linkedin|indeed)$/i.test(String(job.sourcePlatform || '')))
    .map(job => ({ job,
      route: job.needsAtsResolution === true && !recentNoProgress(job, 'route', options),
      hydration: missingDescription(job) && !recentNoProgress(job, 'hydration', options) }))
    .filter(row => row.route || row.hydration)
    .sort((a, b) => hydrationPriority(b.job, options) - hydrationPriority(a.job, options) ||
      String(a.job.id).localeCompare(String(b.job.id)));
  // Reserve capacity for both independent supply defects. Without lanes, full-JD unresolved rows
  // can consume every run and missing-JD native jobs never reach evidence scoring (or vice versa).
  const laneLimit = Math.ceil(limit / 2);
  const out = [], seen = new Set();
  const take = (rows, cap) => {
    let added = 0;
    for (const entry of rows) {
      const row = entry.job;
      const key = String(row.id || row.jobId || row.sourceJobId || '');
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(row); added++;
      if (added >= cap || out.length >= limit) break;
    }
  };
  take(eligible.filter(row => row.hydration), laneLimit);
  take(eligible.filter(row => row.route), laneLimit);
  take(eligible, limit);
  return out.slice(0, limit);
}

async function runOwnedEnrichment(work, options = {}) {
  const guard = typeof options.guard === 'function' ? options.guard : async () => ({ ok: true });
  const deadlineMs = Number(options.deadlineMs) || Date.now() + 30000;
  const decide = async stage => {
    if (Date.now() >= deadlineMs) return { ok: false, code: 'sourcing_deadline_exceeded' };
    return guard(stage);
  };
  let decision = await decide('before_browser_enrichment');
  if (!decision || decision.ok !== true) return { ok: false, error: decision && decision.code || 'source_ownership_lost' };
  const remaining = Math.max(1, deadlineMs - Date.now());
  let result;
  try {
    result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('sourcing_deadline_exceeded'),
        { code: 'sourcing_deadline_exceeded' })), remaining);
      if (timer.unref) timer.unref();
    })]);
  } catch (error) {
    return { ok: false, error: error && error.code || 'hydration_timeout' };
  }
  decision = await decide('before_browser_enrichment_persist');
  if (!decision || decision.ok !== true) return { ok: false, error: decision && decision.code || 'source_ownership_lost' };
  return { ok: true, result };
}

module.exports = { norm, companyIdentity, presentationLocation, exactIdentity, aliasIdentity, hasStrongIdentity,
  isDirect, resolveAgainstOfficial, hydrationPriority, missingDescription, timestampMs, recentNoProgress,
  selectHydrationFrontier, runOwnedEnrichment };
