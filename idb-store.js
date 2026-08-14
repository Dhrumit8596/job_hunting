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
  const MAX_APPLY_DESCRIPTION_BATCH = 10;

  // ── canonical identity (inlined mirror of sourcing/jobid.js) ──
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function roleKey(job) { return norm(job && job.company) + '::' + norm(job && job.title); }
  function mirrorKey(job) { return roleKey(job) + '::' + norm(job && job.location); }
  function canonicalId(job) {
    const ats = norm(job && job.ats).replace(/\s+/g, '') || 'x';
    const rawId = job && job.id != null ? String(job.id).trim() : '';
    return rawId ? ats + ':' + rawId : 'norm:' + roleKey(job);
  }

  function descriptionFingerprint(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return s.length + ':' + (h >>> 0).toString(36);
  }

  function descriptionReady(posting) {
    return !!String(posting && posting.description || '').trim() &&
      !/^(missing|stale|needs_description)$/i.test(String(posting && posting.descriptionStatus || ''));
  }

  function isAggregatorUrl(url) {
    try { return /(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(new URL(url).hostname); }
    catch (_) { return false; }
  }

  function applyUrlKey(value) {
    try {
      const u = new URL(String(value || '')); u.hash = '';
      for (const k of Array.from(u.searchParams.keys())) if (/^(utm_.+|trk|trackingId|ref|refId|source|src|campaign|from)$/i.test(k)) u.searchParams.delete(k);
      u.searchParams.sort();
      return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
    } catch (_) { return ''; }
  }

  function mergeUnique(a, b) { return Array.from(new Set([...(a || []), ...(b || [])].filter(Boolean))); }
  function sourceRef(job, modality) {
    return { modality: modality || 'unknown', platform: job.sourcePlatform || job.ats || '',
      sourceJobId: String(job.sourceJobId || job.id || ''), listingUrl: job.listingUrl || job.applyUrl || '',
      applyUrl: job.applyUrl || '', channel: job.channel || '', detectedAts: job.detectedAts || '',
      isEasyApply: !!job.isEasyApply, indeedApply: !!job.indeedApply,
      query: job.query || '', discoveredAt: job.discoveredAt || job.scrapedAt || '' };
  }
  function refKey(r) { return [r.modality, r.platform, r.sourceJobId, r.listingUrl].join('|'); }

  function routeFrom(job) {
    return { applyUrl: job.applyUrl || '', listingUrl: job.listingUrl || '',
      sourcePlatform: job.sourcePlatform || '', sourceJobId: String(job.sourceJobId || job.id || ''),
      channel: job.channel || '', detectedAts: job.detectedAts || '',
      isEasyApply: !!job.isEasyApply, indeedApply: !!job.indeedApply };
  }

  function shouldReplaceRoute(existing, incoming) {
    if (!existing.applyUrl) return !!incoming.applyUrl;
    const oldDirect = !isAggregatorUrl(existing.applyUrl), nextDirect = !isAggregatorUrl(incoming.applyUrl);
    if (!oldDirect && nextDirect && (incoming.channel || 'external') === 'external') return true;
    return !!incoming.sourcePlatform && incoming.sourcePlatform === existing.sourcePlatform &&
      String(incoming.sourceJobId || '') === String(existing.sourceJobId || '');
  }

  function mergePosting(existing, incoming, modality) {
    if (!existing) return incoming;
    const out = Object.assign({}, existing);
    const desc = String(incoming.description || '').slice(0, 20000);
    if (desc.length > String(out.description || '').length) {
      out.description = desc;
      out.descriptionStatus = incoming.descriptionStatus || 'complete';
    }
    const incomingRoute = routeFrom(incoming);
    if (shouldReplaceRoute(out, incomingRoute)) Object.assign(out, incomingRoute);
    for (const k of ['query', 'discoveredAt', 'postedAt']) if (!out[k] && incoming[k]) out[k] = incoming[k];
    out.modalities = mergeUnique(out.modalities || [out.modality], incoming.modalities || [modality || incoming.modality]);
    out.channels = mergeUnique(out.channels || [out.channel], incoming.channels || [incoming.channel]);
    const refs = Array.isArray(out.sourceRefs) ? out.sourceRefs.slice() : [];
    const incomingRefs = Array.isArray(incoming.sourceRefs) && incoming.sourceRefs.length
      ? incoming.sourceRefs : [sourceRef(incoming, modality || incoming.modality)];
    for (const ref of incomingRefs) if (!refs.some(r => refKey(r) === refKey(ref))) refs.push(ref);
    out.sourceRefs = refs;
    out.descriptionFingerprint = descriptionFingerprint(out.description);
    return out;
  }

  // A full source-run import is authoritative for route identity. Preserve only safe historical
  // enrichment (longer JD + provenance); never reintroduce a previously mixed channel/job id.
  function refreshPosting(fresh, previous) {
    const out = Object.assign({}, fresh);
    if (!previous) { out.descriptionFingerprint = descriptionFingerprint(out.description); return out; }
    if (String(previous.description || '').length > String(out.description || '').length) {
      out.description = String(previous.description).slice(0, 20000);
      out.descriptionStatus = previous.descriptionStatus || 'complete';
    }
    out.modalities = mergeUnique(out.modalities || [out.modality], previous.modalities || [previous.modality]);
    out.channels = mergeUnique(out.channels || [out.channel], previous.channels || [previous.channel]);
    const refs = Array.isArray(out.sourceRefs) ? out.sourceRefs.slice() : [];
    for (const ref of (previous.sourceRefs || [])) if (!refs.some(r => refKey(r) === refKey(ref))) refs.push(ref);
    out.sourceRefs = refs;
    out.descriptionFingerprint = descriptionFingerprint(out.description);
    return out;
  }

  function postingRecord(id, rk, mk, job, modality) {
    const out = {
      id, title: job.title, company: job.company, location: job.location,
      remote: !!job.remote, applyUrl: job.applyUrl || '', ats: job.ats || '',
      detectedAts: job.detectedAts || '', postedAt: job.postedAt || '',
      modality: modality || 'unknown', modalities: [modality || 'unknown'], roleKey: rk, mirrorKey: mk,
      description: String(job.description || '').slice(0, 20000),
      descriptionStatus: job.descriptionStatus || (job.description ? 'complete' : 'needs_description'),
      sourcePlatform: job.sourcePlatform || '', sourceJobId: String(job.sourceJobId || job.id || ''),
      listingUrl: job.listingUrl || '', channel: job.channel || '', channels: job.channel ? [job.channel] : [],
      query: job.query || '', discoveredAt: job.discoveredAt || job.scrapedAt || '',
      isEasyApply: !!job.isEasyApply, indeedApply: !!job.indeedApply,
      sourceRefs: Array.isArray(job.sourceRefs) && job.sourceRefs.length ? job.sourceRefs : [sourceRef(job, modality)],
    };
    out.descriptionFingerprint = descriptionFingerprint(out.description);
    return out;
  }

  // Apply planning needs route, identity, score, and evidence metadata for every corpus row, but it
  // does not need every 20KB job description at once. Keep this projection explicit so adding a
  // description-rich field to the canonical posting cannot silently bloat the apply-set WS reply.
  function applySourceRefProjection(ref) {
    ref = ref || {};
    return {
      id: ref.id || '', jobId: ref.jobId || '', sourceJobId: ref.sourceJobId || '',
      applyUrl: ref.applyUrl || '', listingUrl: ref.listingUrl || '',
      channel: ref.channel || '', detectedAts: ref.detectedAts || '',
      isEasyApply: !!ref.isEasyApply, indeedApply: !!ref.indeedApply,
    };
  }

  function applyPostingProjection(posting) {
    posting = posting || {};
    return {
      id: posting.id, title: posting.title, company: posting.company, location: posting.location,
      remote: !!posting.remote, applyUrl: posting.applyUrl || '', listingUrl: posting.listingUrl || '',
      ats: posting.ats || '', detectedAts: posting.detectedAts || '',
      sourcePlatform: posting.sourcePlatform || '', sourceJobId: posting.sourceJobId || '',
      channel: posting.channel || '', isEasyApply: !!posting.isEasyApply, indeedApply: !!posting.indeedApply,
      discoveredAt: posting.discoveredAt || '',
      descriptionStatus: posting.descriptionStatus || '',
      descriptionReady: descriptionReady(posting),
      descriptionLength: String(posting.description || '').length,
      descriptionFingerprint: posting.descriptionFingerprint || descriptionFingerprint(posting.description),
      sourceRefs: Array.isArray(posting.sourceRefs) ? posting.sourceRefs.map(applySourceRefProjection) : [],
    };
  }

  function applyStateProjection(state) {
    state = state || {};
    return {
      id: state.id, status: state.status || 'sourced', fitScore: state.fitScore == null ? null : state.fitScore,
      attempts: state.attempts || 0, scoreKind: state.scoreKind || '',
      descriptionFingerprint: state.descriptionFingerprint || '',
      evidenceFingerprint: state.evidenceFingerprint || '',
      candidateFingerprint: state.candidateFingerprint || '',
      matchEvidence: Array.isArray(state.matchEvidence) ? state.matchEvidence : [],
      gaps: Array.isArray(state.gaps) ? state.gaps : [],
      conflicts: Array.isArray(state.conflicts) ? state.conflicts : [],
      confidence: state.confidence || '',
    };
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
    const ids = new Set(), records = {}, mirrors = new Map(), directUrls = new Map();
    await new Promise((res, rej) => {
      const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return res(); const v = c.value; ids.add(v.id); records[v.id] = v; const mk = v.mirrorKey || mirrorKey(v); if (!mirrors.has(mk)) mirrors.set(mk, v.id); const dk = v.applyUrl && !isAggregatorUrl(v.applyUrl) ? applyUrlKey(v.applyUrl) : ''; if (dk && !directUrls.has(dk)) directUrls.set(dk, v.id); c.continue(); };
      cur.onerror = () => rej(cur.error);
    });
    return { ids, records, mirrors, directUrls };
  }

  async function upsertJobs(jobs, modality, stateFor) {
    const db = await openDb();
    try {
      const { ids, records, mirrors, directUrls } = await existingKeys(db);
      const seenIds = new Set(ids);
      let added = 0, dupById = 0, dupByRole = 0, enriched = 0;
      const t = db.transaction(['index', 'state'], 'readwrite');
      const idxS = t.objectStore('index'), stS = t.objectStore('state');
      for (const job of jobs || []) {
        if (!job) continue;
        const id = canonicalId(job), rk = roleKey(job), mk = mirrorKey(job);
        if (seenIds.has(id)) {
          dupById++; const merged = mergePosting(records[id], job, modality); records[id] = merged; idxS.put(merged);
          const mergedKey = merged.applyUrl && !isAggregatorUrl(merged.applyUrl) ? applyUrlKey(merged.applyUrl) : '';
          if (mergedKey) directUrls.set(mergedKey, id);
          enriched++; continue;
        }
        const directKey = job.applyUrl && !isAggregatorUrl(job.applyUrl) ? applyUrlKey(job.applyUrl) : '';
        const directId = directKey && directUrls.get(directKey), direct = directId && records[directId];
        if (direct) {
          dupByRole++; const merged = mergePosting(direct, job, modality); records[directId] = merged; idxS.put(merged); enriched++; continue;
        }
        const posting = postingRecord(id, rk, mk, job, modality);
        idxS.put(posting); records[id] = posting;
        const st = typeof stateFor === 'function' ? (stateFor(job) || {}) : {};
        stS.put(Object.assign({ id, status: 'sourced', fitScore: null }, st));
        seenIds.add(id); if (!mirrors.has(mk)) mirrors.set(mk, id);
        if (directKey && !directUrls.has(directKey)) directUrls.set(directKey, id); added++;
      }
      await txDone(t);
      return { added, dupById, dupByRole, enriched };
    } finally { db.close(); }
  }

  // Import an in-memory {index, state} map (from a source-run) into IDB, per-record. Re-sourcing
  // refreshes the posting + fitScore but PRESERVES apply-progress: a job already applied /
  // needs_manual / needs_login / dead keeps that status (and attempts/reason/appliedAt) so re-runs
  // are idempotent and a re-source can't silently reset a completed job back to 'sourced'.
  async function importNormalized(store, opts = {}) {
    const db = await openDb();
    try {
      // Read existing posting/state first so a refresh can retain a richer browser description,
      // application progress, and still-valid LLM evidence.
      const existing = {}, existingIndex = {};
      await new Promise((res, rej) => {
        const cur = db.transaction('index', 'readonly').objectStore('index').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); existingIndex[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      await new Promise((res, rej) => {
        const cur = db.transaction('state', 'readonly').objectStore('state').openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return res(); existing[c.value.id] = c.value; c.continue(); };
        cur.onerror = () => rej(cur.error);
      });
      const t = db.transaction(['index', 'state'], 'readwrite');
      const idxS = t.objectStore('index'), stS = t.objectStore('state');
      let n = 0, preserved = 0, preservedEvidence = 0, retired = 0;
      if (opts.replaceMissing === true) {
        const incomingIds = new Set(Object.keys(store.index || {}));
        for (const id of Object.keys(existingIndex)) {
          if (incomingIds.has(id)) continue;
          idxS.delete(id); stS.delete(id); retired++;
        }
      }
      for (const id of Object.keys(store.index || {})) {
        const posting = refreshPosting(store.index[id], existingIndex[id]);
        idxS.put(posting);
        const incoming = (store.state && store.state[id]) || { status: 'sourced', fitScore: null };
        const prev = existing[id];
        let merged = Object.assign({ id }, incoming);
        const incomingFp = incoming.descriptionFingerprint || posting.descriptionFingerprint || descriptionFingerprint(posting.description);
        merged.descriptionFingerprint = incomingFp;
        const keepLlm = prev && prev.scoreKind === 'llm' && prev.descriptionFingerprint && prev.descriptionFingerprint === incomingFp;
        if (keepLlm) {
          for (const k of ['fitScore', 'scoreKind', 'matchEvidence', 'gaps', 'conflicts', 'confidence',
            'evidenceFingerprint', 'candidateFingerprint']) {
            if (prev[k] != null) merged[k] = prev[k];
          }
          preservedEvidence++;
        }
        if (prev && prev.status && prev.status !== 'sourced') {
          for (const k of ['status', 'attempts', 'reason', 'appliedAt', 'updatedAt', 'lastAttemptAt']) {
            if (prev[k] != null) merged[k] = prev[k];
          }
          preserved++;
        }
        stS.put(merged);
        n++;
      }
      await txDone(t);
      await setMeta('schemaVersion', SCHEMA_VERSION);
      return { imported: n, preserved, preservedEvidence, retired };
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
          location: j.location, applyUrl: j.applyUrl, ats: j.ats || (key === 'pja_jobs' ? 'pipeline' : 'legacy'),
          description: j.description, sourcePlatform: j.platform || j.sourcePlatform, sourceJobId: j.jobId,
          listingUrl: j.listingUrl || j.url, channel: j.channel, isEasyApply: j.isEasyApply,
          indeedApply: j.indeedApply, descriptionStatus: j.descriptionStatus });
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

  // Description-free corpus snapshot for apply selection and planning-drop diagnostics. Both
  // stores are read in one transaction so posting/state metadata comes from the same IDB snapshot.
  // Cursor values still arrive one record at a time under schema v1, but JD text is never retained
  // in the returned corpus or serialized into the initial apply-set response.
  async function getApplyPlanningCorpus() {
    const db = await openDb();
    try {
      const index = {}, state = {};
      const t = db.transaction(['index', 'state'], 'readonly');
      // Native getAll avoids one extension event round-trip per record. We still immediately
      // project away JD bodies, so the compact result and WS payload remain description-free.
      const [postingRows, stateRows] = await Promise.all([
        reqP(t.objectStore('index').getAll()),
        reqP(t.objectStore('state').getAll()),
      ]);
      for (const row of postingRows) {
        const projected = applyPostingProjection(row);
        index[projected.id] = projected;
      }
      for (const row of stateRows) {
        const projected = applyStateProjection(row);
        state[projected.id] = projected;
      }
      return { index, state, total: Object.keys(index).length };
    } finally { db.close(); }
  }

  // Targeted JD hydration for the scoring phase. A strict batch ceiling keeps a single extension
  // reply below roughly 200KB because canonical descriptions are capped at 20KB on write.
  async function getApplyDescriptions(ids) {
    const unique = Array.from(new Set((Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim()).filter(Boolean)));
    if (unique.length > MAX_APPLY_DESCRIPTION_BATCH) {
      throw new Error('getApplyDescriptions supports at most ' + MAX_APPLY_DESCRIPTION_BATCH + ' ids');
    }
    if (!unique.length) return [];
    const db = await openDb();
    try {
      const store = db.transaction('index', 'readonly').objectStore('index');
      const postings = await Promise.all(unique.map(id => reqP(store.get(id))));
      return postings.filter(Boolean).map(posting => ({
        id: posting.id,
        description: String(posting.description || '').slice(0, 20000),
        descriptionStatus: posting.descriptionStatus || '',
        descriptionReady: descriptionReady(posting),
        descriptionFingerprint: posting.descriptionFingerprint || descriptionFingerprint(posting.description),
      }));
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
      const modalities = {}, companies = {}, statusCounts = {};
      const matchThreshold = opts.matchThreshold != null ? opts.matchThreshold : 70;
      let unscored = 0, matching = 0, descriptionReady = 0, evidenceReady = 0;
      for (const id of ids) {
        for (const modality of postings[id].modalities || [postings[id].modality || 'unknown']) {
          modalities[modality] = (modalities[modality] || 0) + 1;
        }
        const co = (postings[id].company || '?').toLowerCase().trim();
        companies[co] = (companies[co] || 0) + 1;
        const stt = states[id] || {};
        if (String(postings[id].description || '').trim() && !/^(missing|stale|needs_description)$/i.test(String(postings[id].descriptionStatus || ''))) descriptionReady++;
        if (stt.scoreKind === 'llm' && Array.isArray(stt.matchEvidence) && stt.matchEvidence.length >= 3 &&
            (!stt.gaps || stt.gaps.length <= 2) && (!stt.conflicts || !stt.conflicts.length) &&
            /^(high|medium)$/i.test(String(stt.confidence || ''))) evidenceReady++;
        if (stt.fitScore == null) unscored++;
        const status = stt.status || 'sourced';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        if (stt.fitScore != null && Number(stt.fitScore) >= matchThreshold) matching++;
      }
      let max = 0, maxCo = '';
      for (const c in companies) if (companies[c] > max) { max = companies[c]; maxCo = c; }
      let ranked = ids
        .map(id => ({ id, company: postings[id].company, title: postings[id].title, location: postings[id].location,
          applyUrl: postings[id].applyUrl, ats: postings[id].ats, modality: postings[id].modality,
          fitScore: states[id] ? states[id].fitScore : null, status: (states[id] && states[id].status) || 'sourced',
          reason: states[id] ? states[id].reason : undefined }))
        .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
      if (opts.statusFilter) ranked = ranked.filter(j => j.status === opts.statusFilter);
      const top = ranked.slice(0, topN);
      return {
        count: ids.length, distinctCompanies: Object.keys(companies).length,
        modalities: Object.keys(modalities), modalityCounts: modalities,
        allScored: unscored === 0, maxCompanyShare: ids.length ? +(max / ids.length).toFixed(3) : 0,
        biggestCompany: maxCo + ' (' + max + ')', statusCounts, matching,
        descriptionReady, evidenceReady, top,
      };
    } finally { db.close(); }
  }

  async function gateReport(opts = {}) {
    const target = opts.target || 200;
    const s = await corpusSummary({ topN: 0 });
    const checks = {
      uniqueIds: s.count, atLeastTarget: s.count >= target,
      modalities: s.modalities,
      sourceClasses: Array.from(new Set(s.modalities.map(m => /^browser(?:-|$)/.test(m) ? 'browser' : /^discovery(?:-|$)/.test(m) ? 'discovery' : 'direct'))),
      allScored: s.allScored, maxCompanyShare: s.maxCompanyShare, concentrationOk: s.maxCompanyShare <= 0.25,
      biggestCompany: s.biggestCompany, descriptionReady: s.descriptionReady, evidenceReady: s.evidenceReady,
    };
    checks.atLeast2Modalities = checks.sourceClasses.length >= 2;
    checks.hasDirectSource = checks.sourceClasses.includes('direct');
    checks.descriptionsReady = checks.descriptionReady >= Math.min(target, s.count);
    checks.pass = checks.atLeastTarget && checks.atLeast2Modalities && checks.hasDirectSource &&
      checks.allScored && checks.descriptionsReady && checks.concentrationOk;
    return checks;
  }

  async function clearAll() {
    const db = await openDb();
    try { const t = db.transaction(['index', 'state', 'meta'], 'readwrite'); ['index', 'state', 'meta'].forEach(s => t.objectStore(s).clear()); await txDone(t); }
    finally { db.close(); }
  }

  const API = { DB_NAME, SCHEMA_VERSION, MAX_APPLY_DESCRIPTION_BATCH,
    canonicalId, roleKey, mirrorKey, descriptionFingerprint,
    applyPostingProjection, applyStateProjection,
    openDb, upsertJobs, importNormalized,
    migrateFromLegacy, count, getAll, getApplyPlanningCorpus, getApplyDescriptions,
    updateState, getJob, setMeta, getMeta, excludeApplied, corpusSummary, gateReport, clearAll };

  if (root) root.PJAIdb = API;                                   // service worker: self.PJAIdb
  if (typeof module !== 'undefined' && module.exports) module.exports = API; // node: require
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
