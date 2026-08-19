'use strict';
// Normalized job store (pure logic; the browser side backs this with IndexedDB in Phase 3).
//
// The store separates the IMMUTABLE posting from MUTABLE application-state so "applied" has ONE
// source of truth (killing the reconcile-from-3-keys bug), and it dedupes on the canonical id
// plus an exact direct application URL. Company/title/location is never treated as identity because
// employers often publish several distinct requisitions with identical visible metadata.
//
//   store = {
//     index: { [canonicalId]: { id, title, company, location, remote, applyUrl, ats, postedAt,
//                               detectedAts, modality, roleKey } },   // immutable posting + provenance
//     state: { [canonicalId]: { fitScore, status, ... } },           // mutable app-state
//     roleKeys: Set,          // seen company::title (reporting only)
//     modalities: Set,        // which sourcing modalities contributed
//   }

const { canonicalId, roleKey, mirrorKey } = require('./jobid');
const { appliedUrlKey } = require('./dedupe');

function createStore() {
  return { index: {}, state: {}, roleKeys: new Set(), mirrorIds: new Map(),
    directUrlIds: new Map(), modalities: new Set() };
}

function descriptionFingerprint(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return s.length + ':' + (h >>> 0).toString(36);
}

function sourceRef(job, modality) {
  return {
    modality: modality || 'unknown',
    sourceBoard: job.sourceBoard || '',
    platform: job.sourcePlatform || job.ats || '',
    sourceJobId: String(job.sourceJobId || job.id || ''),
    listingUrl: job.listingUrl || job.applyUrl || '',
    applyUrl: job.applyUrl || '',
    channel: job.channel || '',
    detectedAts: job.detectedAts || '',
    isEasyApply: !!job.isEasyApply,
    indeedApply: !!job.indeedApply,
    needsAtsResolution: !!job.needsAtsResolution,
    query: job.query || '',
    matchedQueries: Array.isArray(job.matchedQueries) ? job.matchedQueries.slice(0, 20) : [],
    discoveredAt: job.discoveredAt || job.scrapedAt || '',
    firstDiscoveredAt: job.firstDiscoveredAt || job.discoveredAt || job.scrapedAt || '',
    lastSeenAt: job.lastSeenAt || job.discoveredAt || job.scrapedAt || '',
    sourcePage: job.sourcePage || null,
    sourcePages: Array.isArray(job.sourcePages) ? job.sourcePages.slice(0, 40) : [],
  };
}

function refKey(ref) {
  return [ref.modality, ref.platform, ref.sourceJobId, ref.listingUrl].join('|');
}

function isAggregatorUrl(url) {
  try { return /(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(new URL(url).hostname); }
  catch (_) { return false; }
}

function routeFrom(job) {
  return {
    applyUrl: job.applyUrl || '', listingUrl: job.listingUrl || '',
    sourcePlatform: job.sourcePlatform || '', sourceJobId: String(job.sourceJobId || job.id || ''),
    channel: job.channel || '', detectedAts: job.detectedAts || '',
    isEasyApply: !!job.isEasyApply, indeedApply: !!job.indeedApply,
    needsAtsResolution: !!job.needsAtsResolution,
  };
}

function shouldReplaceRoute(existing, incoming) {
  if (!existing.applyUrl) return !!incoming.applyUrl;
  const oldDirect = !isAggregatorUrl(existing.applyUrl), nextDirect = !isAggregatorUrl(incoming.applyUrl);
  if (!oldDirect && nextDirect && (incoming.channel || 'external') === 'external') return true;
  return !!incoming.sourcePlatform && incoming.sourcePlatform === existing.sourcePlatform &&
    String(incoming.sourceJobId || incoming.id || '') === String(existing.sourceJobId || '');
}

function mergePosting(existing, job, modality) {
  const incomingDescription = String(job.description || '').slice(0, 20000);
  if (incomingDescription.length > String(existing.description || '').length) {
    existing.description = incomingDescription;
    existing.descriptionStatus = job.descriptionStatus || 'complete';
  }
  const incomingRoute = routeFrom(job);
  if (shouldReplaceRoute(existing, incomingRoute)) Object.assign(existing, incomingRoute);
  for (const k of ['query', 'discoveredAt', 'firstDiscoveredAt', 'postedAt']) {
    if (!existing[k] && job[k]) existing[k] = job[k];
  }
  if (job.lastSeenAt) existing.lastSeenAt = !existing.lastSeenAt ||
    Number(new Date(job.lastSeenAt)) >= Number(new Date(existing.lastSeenAt)) ? job.lastSeenAt : existing.lastSeenAt;
  existing.matchedQueries = Array.from(new Set([...(existing.matchedQueries || []),
    ...(job.matchedQueries || [])])).slice(0, 20);
  const pageRefs = [...(existing.sourcePages || []), ...(job.sourcePages || [])];
  existing.sourcePages = Array.from(new Map(pageRefs.map(ref => [
    [ref && ref.source, ref && ref.query, ref && ref.page].join('|'), ref])).values()).slice(-40);
  const modalities = new Set([...(existing.modalities || [existing.modality].filter(Boolean)), modality || 'unknown']);
  existing.modalities = Array.from(modalities);
  const channels = new Set([...(existing.channels || [existing.channel].filter(Boolean)), job.channel].filter(Boolean));
  existing.channels = Array.from(channels);
  const refs = Array.isArray(existing.sourceRefs) ? existing.sourceRefs.slice() : [];
  const incomingRef = sourceRef(job, modality);
  const existingRef = refs.findIndex(r => refKey(r) === refKey(incomingRef));
  if (existingRef < 0) refs.push(incomingRef);
  else refs[existingRef] = { ...refs[existingRef], ...incomingRef,
    firstDiscoveredAt: refs[existingRef].firstDiscoveredAt || incomingRef.firstDiscoveredAt,
    discoveredAt: refs[existingRef].discoveredAt || incomingRef.discoveredAt };
  existing.sourceRefs = refs;
  existing.descriptionFingerprint = descriptionFingerprint(existing.description);
  return existing;
}

function buildPosting(id, rk, mk, job, modality) {
  const posting = {
    id, title: job.title, company: job.company, location: job.location,
    remote: !!job.remote, applyUrl: job.applyUrl || '', ats: job.ats || '',
    detectedAts: job.detectedAts || '', postedAt: job.postedAt || '',
    modality: modality || 'unknown', modalities: [modality || 'unknown'], roleKey: rk,
    mirrorKey: mk, description: String(job.description || '').slice(0, 20000),
    descriptionStatus: job.descriptionStatus || (job.description ? 'complete' : 'needs_description'),
    sourcePlatform: job.sourcePlatform || '', sourceJobId: String(job.sourceJobId || job.id || ''),
    sourceBoard: job.sourceBoard || '',
    listingUrl: job.listingUrl || '', channel: job.channel || '', channels: job.channel ? [job.channel] : [],
    query: job.query || '', discoveredAt: job.discoveredAt || job.scrapedAt || '',
    firstDiscoveredAt: job.firstDiscoveredAt || job.discoveredAt || job.scrapedAt || '',
    lastSeenAt: job.lastSeenAt || job.discoveredAt || job.scrapedAt || '',
    sourcePage: job.sourcePage || null,
    sourcePages: Array.isArray(job.sourcePages) ? job.sourcePages.slice(0, 40) : [],
    matchedQueries: Array.isArray(job.matchedQueries) ? job.matchedQueries.slice(0, 20) : [],
    isEasyApply: !!job.isEasyApply, indeedApply: !!job.indeedApply,
    needsAtsResolution: !!job.needsAtsResolution,
    sourceRefs: [sourceRef(job, modality)],
  };
  posting.descriptionFingerprint = descriptionFingerprint(posting.description);
  return posting;
}

// Merge a batch of jobs from one modality. Dedupes by canonical id (primary) and exact direct
// apply URL (secondary). `stateFor(job)` optionally
// supplies initial state (e.g. { fitScore }). Returns { added, dupById, dupByRole }.
function upsert(store, jobs, modality, stateFor) {
  let added = 0, dupById = 0, dupByRole = 0, enriched = 0;
  if ((jobs || []).length) store.modalities.add(modality || 'unknown');
  for (const job of jobs || []) {
    if (!job) continue;
    const id = canonicalId(job);
    const rk = roleKey(job);
    const mk = mirrorKey(job);
    if (store.index[id]) {
      dupById++; mergePosting(store.index[id], job, modality); enriched++;
      const mergedKey = store.index[id].applyUrl && !isAggregatorUrl(store.index[id].applyUrl)
        ? appliedUrlKey(store.index[id].applyUrl) : '';
      if (mergedKey && store.directUrlIds) store.directUrlIds.set(mergedKey, id);
      continue;
    }
    const directKey = job.applyUrl && !isAggregatorUrl(job.applyUrl) ? appliedUrlKey(job.applyUrl) : '';
    const directId = directKey && store.directUrlIds && store.directUrlIds.get(directKey);
    const direct = directId && store.index[directId];
    if (direct) {
      dupByRole++; mergePosting(direct, job, modality); enriched++; continue;
    }
    store.index[id] = buildPosting(id, rk, mk, job, modality);
    const st = typeof stateFor === 'function' ? (stateFor(job) || {}) : {};
    store.state[id] = Object.assign({ status: 'sourced', lifecycle: job.pipelineStatus ||
      (job.description ? 'score_pending' : 'needs_hydration'), fitScore: null }, st);
    store.roleKeys.add(rk);
    if (store.mirrorIds) store.mirrorIds.set(mk, id);
    if (directKey && store.directUrlIds) store.directUrlIds.set(directKey, id);
    added++;
  }
  return { added, dupById, dupByRole, enriched };
}

// Drop everything already applied (matched on the normalized role-key against pja_applied_log etc.).
// Returns the number removed. Keeps applied-state correct: nothing already applied re-enters.
function excludeApplied(store, appliedRoleKeys) {
  const identity = appliedRoleKeys && !Array.isArray(appliedRoleKeys) && !(appliedRoleKeys instanceof Set)
    ? appliedRoleKeys : null;
  const applied = identity ? null : (appliedRoleKeys instanceof Set ? appliedRoleKeys : new Set(appliedRoleKeys || []));
  let removed = 0;
  for (const id of Object.keys(store.index)) {
    const p = store.index[id];
    let hit = applied ? applied.has(p.roleKey) : false;
    if (identity) {
      const ids = identity.exactIds instanceof Set ? identity.exactIds : new Set(identity.exactIds || []);
      const urls = identity.urls instanceof Set ? identity.urls : new Set(identity.urls || []);
      const roles = identity.legacyRoles instanceof Set ? identity.legacyRoles : new Set(identity.legacyRoles || []);
      const postingIds = [id, p.sourceJobId, ...(p.sourceRefs || []).map(r => r && r.sourceJobId)].filter(Boolean).map(String);
      const postingUrls = [p.applyUrl, p.listingUrl, ...(p.sourceRefs || []).flatMap(r => r ? [r.applyUrl, r.listingUrl] : [])]
        .map(appliedUrlKey).filter(Boolean);
      hit = postingIds.some(x => ids.has(x)) || postingUrls.some(x => urls.has(x)) || roles.has(p.roleKey);
    }
    if (hit) {
      delete store.index[id]; delete store.state[id]; removed++;
    }
  }
  return removed;
}

// Largest single-company share of the corpus (0-1). Guards against an all-one-company run.
function concentration(store) {
  const counts = {};
  const ids = Object.keys(store.index);
  for (const id of ids) {
    const c = String(store.index[id].company || '').toLowerCase().trim() || '?';
    counts[c] = (counts[c] || 0) + 1;
  }
  let max = 0, maxCompany = '';
  for (const c of Object.keys(counts)) if (counts[c] > max) { max = counts[c]; maxCompany = c; }
  return { maxCompany, maxCount: max, share: ids.length ? max / ids.length : 0, total: ids.length };
}

// Full acceptance report for the "Find 200+" gate.
function gateReport(store, opts = {}) {
  const target = opts.target || 200;
  const ids = Object.keys(store.index);
  const conc = concentration(store);
  const allScored = ids.every(id => store.state[id] && store.state[id].fitScore != null);
  const modalities = Array.from(store.modalities);
  const sourceClass = m => /^browser(?:-|$)/.test(m) ? 'browser' : /^discovery(?:-|$)/.test(m) ? 'discovery' : 'direct';
  const sourceClasses = Array.from(new Set(modalities.map(sourceClass)));
  const descriptionReady = ids.filter(id => {
    const p = store.index[id];
    return !!String(p.description || '').trim() && !/^(missing|stale|needs_description)$/i.test(String(p.descriptionStatus || ''));
  }).length;
  const evidenceReady = ids.filter(id => {
    const s = store.state[id] || {};
    return s.scoreKind === 'llm' && Array.isArray(s.matchEvidence) && s.matchEvidence.length >= 3 &&
      (!s.gaps || s.gaps.length <= 2) && (!s.conflicts || !s.conflicts.length) &&
      /^(high|medium)$/i.test(String(s.confidence || ''));
  }).length;
  const checks = {
    uniqueIds: ids.length,
    atLeastTarget: ids.length >= target,
    modalities,
    sourceClasses,
    atLeast2Modalities: sourceClasses.length >= 2,
    hasDirectSource: sourceClasses.includes('direct'),
    allScored,
    scoreKind: 'heuristic-prescore',
    descriptionReady,
    descriptionReadyTarget: Math.min(target, ids.length),
    descriptionsReady: descriptionReady >= Math.min(target, ids.length),
    evidenceReady,
    maxCompanyShare: Number(conc.share.toFixed(3)),
    concentrationOk: conc.share <= 0.25,
    biggestCompany: conc.maxCompany + ' (' + conc.maxCount + ')',
  };
  checks.pass = checks.atLeastTarget && checks.atLeast2Modalities && checks.hasDirectSource &&
    checks.allScored && checks.descriptionsReady && checks.concentrationOk;
  return checks;
}

module.exports = { createStore, upsert, excludeApplied, concentration, gateReport,
  mergePosting, descriptionFingerprint };
