'use strict';
// IndexedDB-backed job corpus (Phase 3 of SOURCING_AND_STORAGE_PLAN.md).
//
// UMD: works BOTH in Node (require, for tests/live-verify against fake-indexeddb) AND in the MV3
// service worker (background.js does `importScripts('idb-store.js')` -> attaches to self.PJAIdb).
// So the SAME code path is tested headless and runs in the extension — no drift. canonicalId /
// roleKey are INLINED (must match sourcing/jobid.js exactly; parity is unit-tested).
//
// Replaces the whole-blob chrome.storage arrays for the JOB CORPUS: per-record writes (no O(n)
// rewrite, no storage.onChanged races), real indexes, and a far larger quota than the ~10MB
// chrome.storage.local blob ceiling. Immutable posting in `index`, mutable state in `state`.
(function (root) {
  const DB_NAME = 'pja_jobs_db';
  const SCHEMA_VERSION = 1;

  // ── canonical identity (inlined mirror of sourcing/jobid.js) ──
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function roleKey(job) { return norm(job && job.company) + '::' + norm(job && job.title); }
  function canonicalId(job) {
    const ats = norm(job && job.ats).replace(/\s+/g, '') || 'x';
    const rawId = job && job.id != null ? String(job.id).trim() : '';
    return rawId ? ats + ':' + rawId : 'norm:' + roleKey(job);
  }

  function idb() {
    if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB;
    if (root && root.indexedDB) return root.indexedDB;
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

  async function existingKeys(db) {
    const ids = new Set(), rks = new Set();
    await new Promise((res, rej) => {
      const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(); ids.add(c.value.id); rks.add(c.value.roleKey); c.continue(); };
      cur.onerror = () => rej(cur.error);
    });
    return { ids, rks };
  }

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

  // Import an in-memory {index, state} map (from a source-run) into IDB, per-record.
  async function importNormalized(store) {
    const db = await openDb();
    try {
      const t = db.transaction(['index', 'state'], 'readwrite');
      const idxS = t.objectStore('index'), stS = t.objectStore('state');
      let n = 0;
      for (const id of Object.keys(store.index || {})) {
        idxS.put(store.index[id]);
        stS.put(Object.assign({ id }, store.state && store.state[id] ? store.state[id] : { status: 'sourced', fitScore: null }));
        n++;
      }
      await txDone(t);
      await setMeta('schemaVersion', SCHEMA_VERSION);
      return n;
    } finally { db.close(); }
  }

  // One-time migration: fold legacy whole-blob arrays (pja_shortlist / pja_jobs) into the corpus so
  // nothing is lost. Idempotent (dedup by id/roleKey). Returns count added.
  async function migrateFromLegacy(legacy) {
    const jobs = [];
    for (const key of ['pja_shortlist', 'pja_jobs']) {
      for (const j of (legacy && legacy[key]) || []) {
        if (!j) continue;
        jobs.push({ id: j.id, title: j.title || j.role, company: j.company || j.companyName,
          location: j.location, applyUrl: j.applyUrl, ats: j.ats || (key === 'pja_jobs' ? 'pipeline' : 'legacy') });
      }
    }
    if (!jobs.length) return 0;
    const r = await upsertJobs(jobs, 'legacy', j => ({ fitScore: (legacy._fit && legacy._fit[j.id]) != null ? legacy._fit[j.id] : null }));
    return r.added;
  }

  async function count() {
    const db = await openDb();
    try { return await reqP(db.transaction('index', 'readonly').objectStore('index').count()); }
    finally { db.close(); }
  }

  // Full corpus as { index, state } maps — for the apply driver's selection pass.
  async function getAll() {
    const db = await openDb();
    try {
      const index = {}, state = {};
      await new Promise((res, rej) => {
        const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); index[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      await new Promise((res, rej) => {
        const cur = db.transaction('state', 'readonly').objectStore('state').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); state[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      return { index, state };
    } finally { db.close(); }
  }

  // Merge a patch into one job's mutable state (per-record write; used for apply results + rescoring).
  async function updateState(id, patch) {
    const db = await openDb();
    try {
      const t = db.transaction('state', 'readwrite');
      const st = t.objectStore('state');
      const cur = await reqP(st.get(id));
      const next = Object.assign({ id, status: 'sourced', fitScore: null }, cur || {}, patch || {}, { id });
      st.put(next);
      await txDone(t);
      return next;
    } finally { db.close(); }
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

  // Corpus summary for the read-path (shortlist badge / dev-server /corpus-status).
  async function corpusSummary(opts = {}) {
    const topN = opts.topN || 25;
    const db = await openDb();
    try {
      const postings = {}, states = {};
      await new Promise((res, rej) => {
        const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); postings[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      await new Promise((res, rej) => {
        const cur = db.transaction('state', 'readonly').objectStore('state').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); states[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      const ids = Object.keys(postings);
      const modalities = {}, companies = {};
      let unscored = 0;
      for (const id of ids) {
        modalities[postings[id].modality] = (modalities[postings[id].modality] || 0) + 1;
        const co = (postings[id].company || '?').toLowerCase().trim();
        companies[co] = (companies[co] || 0) + 1;
        if (!states[id] || states[id].fitScore == null) unscored++;
      }
      let max = 0, maxCo = '';
      for (const c in companies) if (companies[c] > max) { max = companies[c]; maxCo = c; }
      const top = ids
        .map(id => ({ id, company: postings[id].company, title: postings[id].title, location: postings[id].location,
          applyUrl: postings[id].applyUrl, ats: postings[id].ats, modality: postings[id].modality,
          fitScore: states[id] ? states[id].fitScore : null, status: states[id] ? states[id].status : 'sourced' }))
        .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0))
        .slice(0, topN);
      return {
        count: ids.length, distinctCompanies: Object.keys(companies).length,
        modalities: Object.keys(modalities), modalityCounts: modalities,
        allScored: unscored === 0, maxCompanyShare: ids.length ? +(max / ids.length).toFixed(3) : 0,
        biggestCompany: maxCo + ' (' + max + ')', top,
      };
    } finally { db.close(); }
  }

  async function gateReport(opts = {}) {
    const target = opts.target || 200;
    const s = await corpusSummary({ topN: 0 });
    const checks = {
      uniqueIds: s.count, atLeastTarget: s.count >= target,
      modalities: s.modalities, atLeast2Modalities: s.modalities.length >= 2,
      allScored: s.allScored, maxCompanyShare: s.maxCompanyShare, concentrationOk: s.maxCompanyShare <= 0.25,
      biggestCompany: s.biggestCompany,
    };
    checks.pass = checks.atLeastTarget && checks.atLeast2Modalities && checks.allScored && checks.concentrationOk;
    return checks;
  }

  async function clearAll() {
    const db = await openDb();
    try { const t = db.transaction(['index', 'state', 'meta'], 'readwrite'); ['index', 'state', 'meta'].forEach(s => t.objectStore(s).clear()); await txDone(t); }
    finally { db.close(); }
  }

  const API = { DB_NAME, SCHEMA_VERSION, canonicalId, roleKey, openDb, upsertJobs, importNormalized,
    migrateFromLegacy, count, getAll, updateState, getJob, setMeta, getMeta, excludeApplied, corpusSummary, gateReport, clearAll };

  if (root) root.PJAIdb = API;                                   // service worker: self.PJAIdb
  if (typeof module !== 'undefined' && module.exports) module.exports = API; // node: require
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
