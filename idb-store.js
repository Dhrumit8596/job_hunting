'use strict';
// IndexedDB-backed job corpus (Phase 3 of SOURCING_AND_STORAGE_PLAN.md).
//
// Replaces the whole-blob chrome.storage arrays for the JOB CORPUS. Why IndexedDB:
//   - per-record writes: updating one job's status no longer rewrites the whole array (O(1), no
//     storage.onChanged races -> the `_savingLocally` hack in shortlist.js becomes unnecessary)
//   - real indexes: dedup/lookup by id, roleKey, company, fitScore, status without scanning
//   - quota: browser IndexedDB with the `storage` permission is far larger than chrome.storage.local's
//     ~10MB blob ceiling, so 2,000+ postings-with-descriptions no longer risk a silent over-quota write
//
// Same normalized shape as sourcing/jobstore.js: immutable posting in `index`, mutable app-state
// in `state`, keyed by canonical `<ats>:<atsJobId>`. Runs in the extension (browser `indexedDB`)
// and is unit-tested in Node against fake-indexeddb.

const { canonicalId, roleKey } = require('./sourcing/jobid');

const DB_NAME = 'pja_jobs_db';
const SCHEMA_VERSION = 1;

function idb() {
  if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
  throw new Error('indexedDB unavailable in this environment');
}

function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txDone(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = idb().open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('index')) {
        const idx = db.createObjectStore('index', { keyPath: 'id' });
        idx.createIndex('roleKey', 'roleKey', { unique: false });
        idx.createIndex('company', 'company', { unique: false });
        idx.createIndex('modality', 'modality', { unique: false });
      }
      if (!db.objectStoreNames.contains('state')) {
        const st = db.createObjectStore('state', { keyPath: 'id' });
        st.createIndex('fitScore', 'fitScore', { unique: false });
        st.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One cursor pass over `index` collecting existing ids + roleKeys for dedup (no whole-blob read).
async function existingKeys(db) {
  const ids = new Set(), rks = new Set();
  await new Promise((res, rej) => {
    const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return res(); ids.add(c.value.id); rks.add(c.value.roleKey); c.continue(); };
    cur.onerror = () => rej(cur.error);
  });
  return { ids, rks };
}

// Per-record upsert. Dedups by canonical id (primary) and roleKey (collapses same role across
// modalities). stateFor(job) -> initial state (e.g. { fitScore }). Returns counts.
async function upsertJobs(jobs, modality, stateFor) {
  const db = await openDb();
  try {
    const { ids, rks } = await existingKeys(db);
    const seenIds = new Set(ids), seenRk = new Set(rks);
    let added = 0, dupById = 0, dupByRole = 0;
    const t = db.transaction(['index', 'state'], 'readwrite');
    const idxS = t.objectStore('index'), stS = t.objectStore('state');
    for (const job of jobs || []) {
      if (!job) continue;
      const id = canonicalId(job), rk = roleKey(job);
      if (seenIds.has(id)) { dupById++; continue; }
      if (seenRk.has(rk)) { dupByRole++; continue; }
      idxS.put({
        id, title: job.title, company: job.company, location: job.location,
        remote: !!job.remote, applyUrl: job.applyUrl || '', ats: job.ats || '',
        detectedAts: job.detectedAts || '', postedAt: job.postedAt || '',
        modality: modality || 'unknown', roleKey: rk,
      });
      const st = typeof stateFor === 'function' ? (stateFor(job) || {}) : {};
      stS.put(Object.assign({ id, status: 'sourced', fitScore: null }, st));
      seenIds.add(id); seenRk.add(rk); added++;
    }
    await txDone(t);
    return { added, dupById, dupByRole };
  } finally { db.close(); }
}

// Import an in-memory sourcing/jobstore store (index+state maps) into IDB — the bridge from a
// source-run to the persistent corpus.
async function importNormalized(store) {
  const db = await openDb();
  try {
    const t = db.transaction(['index', 'state'], 'readwrite');
    const idxS = t.objectStore('index'), stS = t.objectStore('state');
    let n = 0;
    for (const id of Object.keys(store.index || {})) {
      idxS.put(store.index[id]);
      stS.put(Object.assign({ id }, store.state[id] || { status: 'sourced', fitScore: null }));
      n++;
    }
    await txDone(t);
    await setMeta('schemaVersion', SCHEMA_VERSION);
    return n;
  } finally { db.close(); }
}

async function count() {
  const db = await openDb();
  try { return await reqP(db.transaction('index', 'readonly').objectStore('index').count()); }
  finally { db.close(); }
}

async function getJob(id) {
  const db = await openDb();
  try {
    const t = db.transaction(['index', 'state'], 'readonly');
    const posting = await reqP(t.objectStore('index').get(id));
    const state = await reqP(t.objectStore('state').get(id));
    return posting ? Object.assign({}, posting, { state: state || null }) : null;
  } finally { db.close(); }
}

async function setMeta(k, v) {
  const db = await openDb();
  try { const t = db.transaction('meta', 'readwrite'); t.objectStore('meta').put({ k, v }); await txDone(t); }
  finally { db.close(); }
}
async function getMeta(k) {
  const db = await openDb();
  try { const r = await reqP(db.transaction('meta', 'readonly').objectStore('meta').get(k)); return r ? r.v : null; }
  finally { db.close(); }
}

// Remove everything whose roleKey is in appliedRoleKeys (applied-state correctness). Per-record deletes.
async function excludeApplied(appliedRoleKeys) {
  const applied = appliedRoleKeys instanceof Set ? appliedRoleKeys : new Set(appliedRoleKeys || []);
  const db = await openDb();
  try {
    const toDelete = [];
    await new Promise((res, rej) => {
      const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(); if (applied.has(c.value.roleKey)) toDelete.push(c.value.id); c.continue(); };
      cur.onerror = () => rej(cur.error);
    });
    const t = db.transaction(['index', 'state'], 'readwrite');
    for (const id of toDelete) { t.objectStore('index').delete(id); t.objectStore('state').delete(id); }
    await txDone(t);
    return toDelete.length;
  } finally { db.close(); }
}

// Gate report computed by scanning indexes (not whole-blob reads).
async function gateReport(opts = {}) {
  const target = opts.target || 200;
  const db = await openDb();
  try {
    const total = await reqP(db.transaction('index', 'readonly').objectStore('index').count());
    const modalities = new Set(); const companyCounts = {}; let unscored = 0;
    await new Promise((res, rej) => {
      const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(); modalities.add(c.value.modality); const co = String(c.value.company || '').toLowerCase().trim() || '?'; companyCounts[co] = (companyCounts[co] || 0) + 1; c.continue(); };
      cur.onerror = () => rej(cur.error);
    });
    await new Promise((res, rej) => {
      const cur = db.transaction('state', 'readonly').objectStore('state').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(); if (c.value.fitScore == null) unscored++; c.continue(); };
      cur.onerror = () => rej(cur.error);
    });
    let max = 0, maxCo = '';
    for (const co of Object.keys(companyCounts)) if (companyCounts[co] > max) { max = companyCounts[co]; maxCo = co; }
    const share = total ? max / total : 0;
    const mods = Array.from(modalities);
    const checks = {
      uniqueIds: total, atLeastTarget: total >= target,
      modalities: mods, atLeast2Modalities: mods.length >= 2,
      allScored: unscored === 0,
      maxCompanyShare: Number(share.toFixed(3)), concentrationOk: share <= 0.25,
      biggestCompany: maxCo + ' (' + max + ')',
    };
    checks.pass = checks.atLeastTarget && checks.atLeast2Modalities && checks.allScored && checks.concentrationOk;
    return checks;
  } finally { db.close(); }
}

async function clearAll() {
  const db = await openDb();
  try { const t = db.transaction(['index', 'state', 'meta'], 'readwrite'); ['index', 'state', 'meta'].forEach(s => t.objectStore(s).clear()); await txDone(t); }
  finally { db.close(); }
}

module.exports = { DB_NAME, SCHEMA_VERSION, openDb, upsertJobs, importNormalized, count, getJob, setMeta, getMeta, excludeApplied, gateReport, clearAll };
