'use strict';
// Normalized job store (pure logic; the browser side backs this with IndexedDB in Phase 3).
//
// The store separates the IMMUTABLE posting from MUTABLE application-state so "applied" has ONE
// source of truth (killing the reconcile-from-3-keys bug), and it dedupes on the canonical id
// PLUS the normalized company::title role-key so the same role from two modalities collapses.
//
//   store = {
//     index: { [canonicalId]: { id, title, company, location, remote, applyUrl, ats, postedAt,
//                               detectedAts, modality, roleKey } },   // immutable posting + provenance
//     state: { [canonicalId]: { fitScore, status, ... } },           // mutable app-state
//     roleKeys: Set,          // seen company::title (secondary dedup)
//     modalities: Set,        // which sourcing modalities contributed
//   }

const { canonicalId, roleKey } = require('./jobid');

function createStore() {
  return { index: {}, state: {}, roleKeys: new Set(), modalities: new Set() };
}

// Merge a batch of jobs from one modality. Dedupes by canonical id (primary) and company::title
// (secondary — collapses the same role surfaced by a different source). `stateFor(job)` optionally
// supplies initial state (e.g. { fitScore }). Returns { added, dupById, dupByRole }.
function upsert(store, jobs, modality, stateFor) {
  let added = 0, dupById = 0, dupByRole = 0;
  for (const job of jobs || []) {
    if (!job) continue;
    const id = canonicalId(job);
    const rk = roleKey(job);
    if (store.index[id]) { dupById++; continue; }
    if (store.roleKeys.has(rk)) { dupByRole++; continue; }
    store.index[id] = {
      id, title: job.title, company: job.company, location: job.location,
      remote: !!job.remote, applyUrl: job.applyUrl || '', ats: job.ats || '',
      detectedAts: job.detectedAts || '', postedAt: job.postedAt || '',
      modality: modality || 'unknown', roleKey: rk,
    };
    const st = typeof stateFor === 'function' ? (stateFor(job) || {}) : {};
    store.state[id] = Object.assign({ status: 'sourced', fitScore: null }, st);
    store.roleKeys.add(rk);
    store.modalities.add(modality || 'unknown');
    added++;
  }
  return { added, dupById, dupByRole };
}

// Drop everything already applied (matched on the normalized role-key against pja_applied_log etc.).
// Returns the number removed. Keeps applied-state correct: nothing already applied re-enters.
function excludeApplied(store, appliedRoleKeys) {
  const applied = appliedRoleKeys instanceof Set ? appliedRoleKeys : new Set(appliedRoleKeys || []);
  let removed = 0;
  for (const id of Object.keys(store.index)) {
    if (applied.has(store.index[id].roleKey)) {
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
  const checks = {
    uniqueIds: ids.length,
    atLeastTarget: ids.length >= target,
    modalities,
    atLeast2Modalities: modalities.length >= 2,
    allScored,
    maxCompanyShare: Number(conc.share.toFixed(3)),
    concentrationOk: conc.share <= 0.25,
    biggestCompany: conc.maxCompany + ' (' + conc.maxCount + ')',
  };
  checks.pass = checks.atLeastTarget && checks.atLeast2Modalities && checks.allScored && checks.concentrationOk;
  return checks;
}

module.exports = { createStore, upsert, excludeApplied, concentration, gateReport };
