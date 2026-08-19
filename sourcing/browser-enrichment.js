'use strict';

const { detectAts } = require('./detect-ats');

function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function exactIdentity(job) {
  return [norm(job && job.company), norm(job && job.title), norm(job && job.location)].join('::');
}
function hasStrongIdentity(job) {
  return !!(norm(job && job.company) && norm(job && job.title) && norm(job && job.location));
}
function isDirect(job) {
  try { return !/(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(new URL(job && job.applyUrl || '').hostname); }
  catch (_) { return false; }
}
function resolveAgainstOfficial(browserJobs, officialPostings) {
  const official = (officialPostings || []).filter(row => row && isDirect(row));
  const groups = new Map();
  for (const row of official) {
    if (!hasStrongIdentity(row)) continue;
    const key = exactIdentity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const outcomes = [];
  const jobs = (browserJobs || []).map(job => {
    if (!job || job.needsAtsResolution !== true) return job;
    if (!hasStrongIdentity(job)) {
      outcomes.push({ id: job.id, status: 'identity_mismatch', reason: 'incomplete_browser_identity' });
      return { ...job, resolutionReason: 'incomplete_browser_identity' };
    }
    const matches = groups.get(exactIdentity(job)) || [];
    if (!matches.length) { outcomes.push({ id: job.id, status: 'no_match', reason: 'no_exact_official_identity' }); return job; }
    if (matches.length !== 1) { outcomes.push({ id: job.id, status: 'ambiguous', reason: 'multiple_exact_official_identities' }); return job; }
    const match = matches[0];
    if (!isDirect(match) || !match.applyUrl || !detectAts(match.applyUrl)) {
      outcomes.push({ id: job.id, status: 'identity_mismatch', reason: 'official_route_not_supported' }); return job;
    }
    outcomes.push({ id: job.id, status: 'resolved', method: 'official_exact_company_title_location',
      confidence: 'high', officialId: match.id });
    return { ...job, applyUrl: match.applyUrl, externalApplyUrl: match.applyUrl,
      detectedAts: match.detectedAts || detectAts(match.applyUrl), channel: 'external',
      needsAtsResolution: false, resolutionMethod: 'official_exact_company_title_location',
      resolutionConfidence: 'high', resolutionOfficialId: match.id,
      description: job.description || match.description || '',
      descriptionStatus: job.descriptionStatus !== 'missing' ? job.descriptionStatus
        : match.description ? match.descriptionStatus || 'full' : job.descriptionStatus,
      hydrationStatus: job.description || match.description ? 'hydration_success' : job.hydrationStatus,
      hydrationMethod: job.description ? job.hydrationMethod : match.description ? 'official_record_merge' : job.hydrationMethod,
      hydratedAt: job.hydratedAt || match.hydratedAt || null };
  });
  return { jobs, outcomes, resolved: outcomes.filter(row => row.status === 'resolved').length,
    ambiguous: outcomes.filter(row => row.status === 'ambiguous').length,
    noMatch: outcomes.filter(row => row.status === 'no_match').length,
    identityMismatch: outcomes.filter(row => row.status === 'identity_mismatch').length };
}

function hydrationPriority(job, options = {}) {
  let score = 0;
  if (job && job.lastSeenAt && Number(job.lastSeenAt) >= Number(options.freshAfter || 0)) score += 30;
  if (job && (job.channel === 'linkedin_easy_apply' || job.channel === 'indeed_apply')) score += 25;
  if (job && isDirect(job)) score += 20;
  if (/\b(process|quality|metrology|inspection|validation|test|equipment|reliability|failure analysis|manufacturing) engineer\b/i.test(String(job && job.title || ''))) score += 25;
  if (/\b(senior|sr\.?|staff|principal|lead|manager|director)\b/i.test(String(job && job.title || ''))) score -= 25;
  return score;
}
function selectHydrationFrontier(jobs, options = {}) {
  const limit = Math.max(0, Math.min(50, Number(options.limit) || 20));
  return (jobs || []).filter(job => job && /^(linkedin|indeed)$/i.test(String(job.sourcePlatform || '')) &&
    (!job.description || /^(missing|stale|needs_description)$/i.test(String(job.descriptionStatus || ''))))
    .sort((a, b) => hydrationPriority(b, options) - hydrationPriority(a, options) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
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

module.exports = { exactIdentity, hasStrongIdentity, isDirect, resolveAgainstOfficial,
  hydrationPriority, selectHydrationFrontier, runOwnedEnrichment };
