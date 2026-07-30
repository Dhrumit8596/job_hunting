'use strict';

// Load the IndexedDB corpus + apply-selection modules into the SW global scope. Wrapped so a load
// failure can never brick the whole service worker. Order matters: apply-select needs detect-ats.
try {
  importScripts('idb-store.js', 'sourcing/detect-ats.js', 'sourcing/apply-select.js', 'application-ledger.js');
} catch (e) { console.error('PJA: module load failed', e); }

// ── Dev mode ──────────────────────────────────────────────────────────────────
// Set DEV_MODE = true to route all analysis through the local dev server.
// Run: node dev-server.js   (uses your ANTHROPIC_API_KEY env var)
// Nano (SLM) is disabled when DEV_MODE is true.
const DEV_MODE = true;
const DEV_SERVER = 'http://localhost:6174';

// Expose DEV_MODE to content scripts via storage so they can show the right loading message
chrome.storage.local.set({ pja_dev_mode: DEV_MODE });

// Seed known answers into pja_answers on startup (won't overwrite existing values)
chrome.storage.local.get('pja_answers', r => {
  const answers = r.pja_answers || {};
  const now = Date.now();
  const seeds = {
    'contact phone type':        { rawLabel: 'contact phone type',        answer: 'Mobile',        savedAt: now, usedCount: 0 },
    'country/region of residence': { rawLabel: 'country/region of residence', answer: 'United States', savedAt: now, usedCount: 0 },
    'phone type':                { rawLabel: 'phone type',                answer: 'Mobile',        savedAt: now, usedCount: 0 },
  };
  let changed = false;
  for (const [k, v] of Object.entries(seeds)) {
    if (!answers[k]) { answers[k] = v; changed = true; }
  }
  if (changed) chrome.storage.local.set({ pja_answers: answers });
});

// ── Job corpus (IndexedDB) helpers ────────────────────────────────────────────
// Ingest a normalized {index,state} payload (from dev-server /source-v2) into the IndexedDB
// corpus (source of truth) and publish a small count for the review UI. Does NOT overwrite
// pja_shortlist — the shortlist page pulls from the corpus explicitly (GET_JOB_CORPUS).
async function pjaIngestCorpus(index, state, opts = {}) {
  if (!self.PJAIdb) return 0;
  const imported = await self.PJAIdb.importNormalized({ index: index || {}, state: state || {} },
    { replaceMissing: opts.replaceMissing === true });
  const s = await self.PJAIdb.corpusSummary({ topN: 0 });
  await new Promise(r => chrome.storage.local.set({ pja_job_corpus_count: s.count, pja_schema_version: 1 }, r));
  return Object.assign({ count: s.count }, imported);
}

// Build the apply-set from the IndexedDB corpus (shared by the GET_APPLY_SET message + the WS
// getApplySet command the dev-server /apply-run driver calls).
async function pjaBuildApplySet(opts) {
  if (!self.PJAIdb || !self.PJAApplySelect) return { jobs: [], error: 'modules not loaded' };
  const corpus = await self.PJAIdb.getAll();
  const st = await new Promise(r => chrome.storage.local.get(['pja_applied_log', 'pja_jobs'], d => r(d)));
  const recs = [...(st.pja_applied_log || []).filter(x => !x || !x.status || /^(applied|submitted|submitting|success|confirmed)$/i.test(String(x.status))),
    ...(st.pja_jobs || []).filter(x => x && /^(applied|submitted|success|confirmed)$/i.test(String(x.status || x.result || '')))];
  const selectOpts = {
    threshold: opts && opts.threshold != null ? opts.threshold : 70,
    dailyCap: opts && opts.dailyCap != null ? opts.dailyCap : 30,
    atsAllow: opts && opts.atsAllow,
    retryDeferred: opts && Object.prototype.hasOwnProperty.call(opts, 'retryDeferred') ? opts.retryDeferred : undefined,
    maxAttempts: opts && opts.maxAttempts != null ? opts.maxAttempts : undefined,
    requireEvidence: !!(opts && opts.requireEvidence),
    maxGaps: opts && opts.maxGaps != null ? opts.maxGaps : 2,
    perCompanyCap: opts && opts.perCompanyCap != null ? opts.perCompanyCap : 2,
    maxBrowserAgeMs: opts && opts.maxBrowserAgeMs != null ? opts.maxBrowserAgeMs : 48 * 60 * 60 * 1000,
    appliedRecords: recs,
  };
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'candidateFingerprint')) {
    selectOpts.candidateFingerprint = opts.candidateFingerprint;
  }
  const set = self.PJAApplySelect.buildApplySet(corpus, selectOpts);
  return { jobs: set, total: Object.keys(corpus.index).length };
}

// The service worker is the sole writer for the append-only confirmation ledger. Chaining writes
// prevents three apply channels finishing together from overwriting one another's read-modify-write.
const PJA_APPLICATION_LEDGER_KEY = 'pja_application_ledger';
let pjaLedgerWriteChain = Promise.resolve();
function pjaAppendApplicationEvent(event) {
  const operation = pjaLedgerWriteChain.catch(() => {}).then(async () => {
    if (!self.PJAApplicationLedger) throw new Error('application ledger unavailable');
    const data = await new Promise(r => chrome.storage.local.get(PJA_APPLICATION_LEDGER_KEY, r));
    const current = data[PJA_APPLICATION_LEDGER_KEY] || self.PJAApplicationLedger.emptyLedger();
    let next = self.PJAApplicationLedger.reduceLedger(current, event);
    if (typeof self.PJAApplicationLedger.compactLedger === 'function') {
      next = self.PJAApplicationLedger.compactLedger(next, { runId: event && event.runId, maxRunEvents: 180, maxOtherEvents: 60 });
    }
    await pjaSetLocal({ [PJA_APPLICATION_LEDGER_KEY]: next });
    await pjaAdvanceRankedRun(event, next);
    return next;
  });
  pjaLedgerWriteChain = operation.catch(e => { console.error('PJA: ledger append failed', e); });
  return operation;
}

function pjaSetLocal(values) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(values, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve();
      });
    } catch (e) { reject(e); }
  });
}

function pjaLaunchEasyApplySingle(job, master) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['pja_profile', 'pja_answers'], d => {
      const queue = { status: 'applying', jobs: [job], currentIndex: 0,
        results: { applied: [], skipped: [], errors: [] }, profile: d.pja_profile || {},
        answers: d.pja_answers || {}, runId: master.runId, startedAt: Date.now() };
      const firstUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true&currentJobId=' + encodeURIComponent(job.jobId || job.sourceJobId || '');
      chrome.tabs.create({ url: firstUrl, active: true }, tab => {
        if (chrome.runtime.lastError || !tab) return reject(new Error(chrome.runtime.lastError?.message || 'easy-apply tab create failed'));
        const onUpd = (tid, info) => {
          if (tid !== tab.id || info.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onUpd);
          chrome.scripting.executeScript({ target: { tabId: tab.id },
            func: q => { try { sessionStorage.setItem('pja_apply_queue', JSON.stringify(q)); location.reload(); } catch (_) {} },
            args: [queue] }).catch(() => {});
        };
        chrome.tabs.onUpdated.addListener(onUpd);
        resolve(tab.id);
      });
    });
  });
}

async function pjaLaunchIndeedSingle(job, master) {
  const d = await new Promise(r => chrome.storage.local.get(['pja_profile', 'pja_answers'], r));
  const queue = { status: 'applying', jobs: [job], currentIndex: 0,
    results: { applied: [], skipped: [] }, profile: d.pja_profile || {}, answers: d.pja_answers || {},
    runId: master.runId, startedAt: Date.now() };
  await pjaSetLocal({ pja_indeed_queue: queue, pja_indeed_paused: null });
  return new Promise((resolve, reject) => chrome.tabs.create({
    url: 'https://www.indeed.com/viewjob?jk=' + encodeURIComponent(job.jobId || job.sourceJobId || ''), active: true,
  }, tab => chrome.runtime.lastError || !tab
    ? reject(new Error(chrome.runtime.lastError?.message || 'Indeed tab create failed')) : resolve(tab.id)));
}

async function pjaLaunchExternalSingle(job, master) {
  const launchedAt = Date.now();
  const queue = { status: 'applying', jobs: [job], currentIndex: 0,
    results: { applied: [], skipped: [] }, runId: master.runId, startedAt: launchedAt };
  const current = Object.assign({}, job, { returnUrl: 'https://www.linkedin.com/jobs/', runId: master.runId });
  const seed = { pja_ext_queue: queue, pja_ext_current: current,
    pja_ext_stop_before_submit: !!master.stopBeforeSubmit, pja_navigate_to: job.applyUrl,
    // Every ranked reserve is a one-job subqueue with the same runId/index. Include its canonical
    // identity so the legacy SW watchdog cannot inherit the prior reserve's elapsed timer.
    pja_apply_wd: { runId: master.runId, idx: 0,
      jobKey: self.PJAApplySelect?.queueJobKey(job) || '', startedAt: launchedAt } };
  await pjaSetLocal(seed);
  const verify = await new Promise(r => chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], r));
  const seededQueue = verify.pja_ext_queue || null;
  const seededCurrent = verify.pja_ext_current || null;
  const seededOk = seededQueue && seededCurrent && seededQueue.runId === master.runId &&
    seededCurrent.runId === master.runId && pjaSameRankedJob(job, seededCurrent);
  if (!seededOk) {
    // Retry each key separately. This avoids losing the whole launch if Chrome rejects one
    // composite write and gives us a second chance before opening a dead ATS tab.
    await pjaSetLocal({ pja_ext_queue: queue });
    await pjaSetLocal({ pja_ext_current: current });
    await pjaSetLocal({ pja_ext_stop_before_submit: !!master.stopBeforeSubmit,
      pja_navigate_to: job.applyUrl, pja_apply_wd: seed.pja_apply_wd });
    const retry = await new Promise(r => chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], r));
    if (!(retry.pja_ext_queue && retry.pja_ext_current && retry.pja_ext_queue.runId === master.runId &&
        retry.pja_ext_current.runId === master.runId && pjaSameRankedJob(job, retry.pja_ext_current))) {
      throw new Error('external queue seed verification failed');
    }
  }
  return new Promise((resolve, reject) => chrome.tabs.create({ url: job.applyUrl, active: true }, tab =>
    chrome.runtime.lastError || !tab
      ? reject(new Error(chrome.runtime.lastError?.message || 'external tab create failed')) : resolve(tab.id)));
}

function pjaSameRankedJob(job, event) {
  const jobUrl = self.PJAApplySelect?.applyUrlKey(job && job.applyUrl) || '';
  const eventUrl = self.PJAApplySelect?.applyUrlKey(event && event.applyUrl) || '';
  // When both producers know the route it is authoritative. Never let a tenant-local raw ID
  // override two different employers/URLs.
  if (jobUrl && eventUrl) return jobUrl === eventUrl;
  const ids = [job && job.jobId, job && job.sourceJobId, job && job.id].filter(Boolean).map(String);
  const eventIds = [event && event.jobId, event && event.sourceJobId, event && event.id].filter(Boolean).map(String);
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return ids.some(id => eventIds.includes(id)) && norm(job && job.company) === norm(event && event.company)
    && norm(job && job.title) === norm(event && event.title);
}

async function pjaCloseRankedTab(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

async function pjaCloseDuplicateRankedTabs(job, keepTabId) {
  if (!job || !job.applyUrl || keepTabId == null) return 0;
  const wanted = self.PJAApplySelect?.applyUrlKey(job.applyUrl) || String(job.applyUrl || '');
  if (!wanted) return 0;
  let closed = 0;
  try {
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    for (const tab of tabs) {
      if (tab.id === keepTabId) continue;
      const tabUrl = self.PJAApplySelect?.applyUrlKey(tab.url || '') || String(tab.url || '');
      if (tabUrl && (tabUrl === wanted || tabUrl.startsWith(wanted) || wanted.startsWith(tabUrl))) {
        try { await chrome.tabs.remove(tab.id); closed++; } catch (_) {}
      }
    }
  } catch (_) {}
  if (closed) console.warn('PJA ranked apply: closed duplicate tabs for current job', closed, job.company, job.title);
  return closed;
}

async function pjaReinjectRankedTab(tabId, reason) {
  if (tabId == null) return false;
  const scripts = [
    'content/extractors/generic.js',
    'content/autofill.js',
    'content/workday-engine.js',
    'content/workday-auth.js',
    'content/external-apply.js',
  ];
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { try { delete window.__pjaExtApplyLoaded; } catch (_) { window.__pjaExtApplyLoaded = false; } },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: scripts });
    console.warn('PJA ranked apply: reinjected active tab', tabId, reason || '');
    return true;
  } catch (e) {
    console.warn('PJA ranked apply: reinject failed', tabId, reason || '', e.message);
    return false;
  }
}

function pjaScheduleRankedReinject(runId, index, tabId, delayMs) {
  if (!runId || tabId == null) return;
  setTimeout(async () => {
    try {
      const d = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
      const master = d.pja_ranked_apply;
      if (!master || master.runId !== runId || master.status !== 'applying') return;
      if (master.currentIndex !== index || master.inFlightIndex !== index || master.inFlightTabId !== tabId) return;
      await pjaReinjectRankedTab(tabId, 'watchdog_' + delayMs);
    } catch (e) {
      console.warn('PJA ranked apply: reinject watchdog error', e.message);
    }
  }, delayMs);
}

function pjaRankedTabMatchesJob(tab, job) {
  if (!tab || !tab.url) return false;
  if (!job || !job.applyUrl) return true;
  try {
    const tabUrl = new URL(tab.url);
    const applyUrl = new URL(job.applyUrl);
    if (tabUrl.hostname !== applyUrl.hostname) return false;
    // Workday rewrites `/job/...` to `/apply/.../applyManually` during the same application.
    // Same-host Workday tabs are valid; unrelated same-id tabs on other hosts are stale.
    if (/workday\.com|myworkdayjobs\.com/i.test(tabUrl.hostname)) return true;
    const tabKey = self.PJAApplySelect?.applyUrlKey(tab.url || '') || String(tab.url || '');
    const jobKey = self.PJAApplySelect?.applyUrlKey(job.applyUrl || '') || String(job.applyUrl || '');
    return !!(tabKey && jobKey && (tabKey === jobKey || tabKey.startsWith(jobKey) || jobKey.startsWith(tabKey)));
  } catch (_) {
    return false;
  }
}

async function pjaRankedTabExists(tabId, job) {
  if (tabId == null) return false;
  return new Promise(resolve => {
    try {
      chrome.tabs.get(tabId, tab => resolve(!!tab && !chrome.runtime.lastError && pjaRankedTabMatchesJob(tab, job)));
    } catch (_) {
      resolve(false);
    }
  });
}

async function pjaClearRankedExtQueue(master) {
  if (!master || !master.runId) return;
  try {
    const data = await new Promise(r => chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current', 'pja_apply_wd'], r));
    const q = data.pja_ext_queue || null;
    const cur = data.pja_ext_current || null;
    const qRunId = q && (q.runId || (q.jobs && q.jobs[0] && q.jobs[0].runId));
    const curRunId = cur && cur.runId;
    if (qRunId !== master.runId && curRunId !== master.runId) return;
    const terminalQueue = {
      status: master.status || 'done',
      jobs: [],
      currentIndex: 0,
      results: { applied: [], skipped: [], errors: [] },
      runId: master.runId,
      finishedAt: Date.now()
    };
    await new Promise(r => chrome.storage.local.set({
      pja_ext_queue: terminalQueue,
      pja_ext_current: null,
      pja_apply_wd: null
    }, r));
    await new Promise(r => chrome.storage.local.remove(['pja_navigate_to'], r));
  } catch (e) { console.error('PJA: failed to clear ranked ext queue', e); }
}

async function pjaRestoreRankedFailureState(job, reason, masterHint) {
  if (!self.PJAIdb || !self.PJAApplySelect || !job || !job.id) return;
  try {
    const current = await self.PJAIdb.getJob(job.id);
    const attempts = current?.state?.attempts != null ? current.state.attempts : (job.attempts || 0);
    let ranked = masterHint || null;
    if (!ranked && job.runId) {
      const d = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
      ranked = d.pja_ranked_apply || null;
    }
    const maxAttempts = ranked && ranked.runId === job.runId && ranked.e2eSafe ? 1 : undefined;
    const next = self.PJAApplySelect.resultToState(reason, attempts, maxAttempts);
    await self.PJAIdb.updateState(job.id, { status: next.status, reason: next.reason,
      attempts: next.attempts != null ? next.attempts : attempts, updatedAt: Date.now() });
  } catch (e) { console.error('PJA: failed to restore ranked corpus state', e); }
}

async function pjaReconcileRankedExtCurrent(master) {
  if (!master || master.status !== 'applying' || !master.runId) return master;
  try {
    const data = await new Promise(r => chrome.storage.local.get(['pja_ext_current', 'pja_ext_queue'], r));
    const cur = data.pja_ext_current || null;
    const q = data.pja_ext_queue || null;
    if (!cur || cur.runId !== master.runId) return master;
    const extActive = q && q.runId === master.runId && q.status === 'applying';
    if (!extActive) return master;
    const curIndex = (master.jobs || []).findIndex((candidate, idx) =>
      idx > master.currentIndex && pjaSameRankedJob(candidate, cur));
    if (curIndex <= master.currentIndex) return master;
    console.warn('PJA ranked apply: reconciling ext_current ahead of master', master.currentIndex, '→', curIndex, cur.company, cur.title);
    for (let idx = master.currentIndex; idx < curIndex; idx++) {
      const stale = master.jobs[idx];
      if (!stale) continue;
      const hadSubmitClick = false; // kept explicit: stale external-current advance is not confirmation.
      const reason = hadSubmitClick ? 'submit_unclear_ext_current_advanced' : 'stale_ext_current_reconciled';
      master.results.failed.push({ ...stale, reason });
      await pjaRestoreRankedFailureState(stale, reason, master);
    }
    master.currentIndex = curIndex;
    master.inFlightIndex = curIndex;
    master.updatedAt = Date.now();
    await pjaSetLocal({ pja_ranked_apply: master });
  } catch (e) { console.warn('PJA ranked apply: ext_current reconcile failed', e.message); }
  return master;
}

function pjaRankedResultRecorded(master, job) {
  if (!master || !job) return false;
  const buckets = master.results || {};
  const all = ['confirmed', 'failed', 'skipped', 'unverified']
    .flatMap(k => Array.isArray(buckets[k]) ? buckets[k] : []);
  return all.some(existing => pjaSameRankedJob(existing, job));
}

function pjaRankedApplyTerminal(master, job, event) {
  if (!master.results) master.results = { confirmed: [], failed: [], unverified: [], skipped: [] };
  for (const key of ['confirmed', 'failed', 'unverified', 'skipped']) {
    if (!Array.isArray(master.results[key])) master.results[key] = [];
  }
  const confirmed = self.PJAApplicationLedger.confirmationKinds(event).length > 0;
  if (confirmed) master.results.confirmed.push({ ...job, confirmedAt: event.confirmedAt });
  else if (/^already_applied\b/i.test(event.reason || '')) {
    master.results.skipped.push({ ...job, reason: event.reason || 'already_applied' });
  }
  else if (/captcha/i.test(event.reason || '')) {
    master.results.skipped.push({ ...job, reason: event.reason || 'captcha' });
  }
  else if (/^(failed|failure|error|blocked|aborted|skipped)$/.test(event.status) || event.success === false) {
    master.results.failed.push({ ...job, reason: event.reason || event.status });
  } else master.results.unverified.push({ ...job, reason: event.reason || 'unverified' });
}

async function pjaReconcileRankedLedger(master, ledger) {
  if (!master || master.status !== 'applying' || !master.runId || !ledger || !self.PJAApplicationLedger) return master;
  if (!master.results) master.results = { confirmed: [], failed: [], unverified: [], skipped: [] };
  for (const key of ['confirmed', 'failed', 'unverified', 'skipped']) {
    if (!Array.isArray(master.results[key])) master.results[key] = [];
  }
  const events = Object.values(ledger.events || {})
    .map(e => self.PJAApplicationLedger.normalizeEvent(e))
    .filter(e => e && e.runId === master.runId && !/^(submitting|pending|queued|started|in_progress)$/.test(e.status))
    .sort((a, b) => (a.occurredAt || 0) - (b.occurredAt || 0));
  let changed = false;
  for (const event of events) {
    const idx = (master.jobs || []).findIndex((candidate, i) => i >= master.currentIndex && pjaSameRankedJob(candidate, event));
    if (idx < 0) continue;
    const job = master.jobs[idx];
    if (pjaRankedResultRecorded(master, job)) {
      if (master.currentIndex <= idx) { master.currentIndex = idx + 1; changed = true; }
      continue;
    }
    if (idx > master.currentIndex) {
      for (let i = master.currentIndex; i < idx; i++) {
        const stale = master.jobs[i];
        if (stale && !pjaRankedResultRecorded(master, stale)) {
          master.results.failed.push({ ...stale, reason: 'ledger_reconcile_gap' });
          await pjaRestoreRankedFailureState(stale, 'ledger_reconcile_gap', master);
        }
      }
    }
    pjaRankedApplyTerminal(master, job, event);
    await pjaRestoreRankedFailureState(job, event.reason || event.status || 'ledger_reconciled', master);
    master.currentIndex = idx + 1;
    changed = true;
  }
  if (changed) {
    const dailyTarget = master.dailyTarget || master.targetConfirmed || 50;
    const auditOpts = master.day
      ? { day: master.day, timeZone: master.timeZone || 'America/Los_Angeles', target: dailyTarget }
      : { runId: master.runId, day: null, target: dailyTarget };
    const audit = self.PJAApplicationLedger.auditLedger(ledger, auditOpts);
    master.confirmedCount = audit.counts.confirmed;
    master.remaining = audit.remaining;
    master.inFlightIndex = null;
    master.inFlightTabId = null;
    master.updatedAt = Date.now();
    if (audit.counts.confirmed >= dailyTarget) {
      master.status = 'done';
      master.finishedAt = Date.now();
    }
    await pjaSetLocal({ pja_ranked_apply: master });
  }
  return master;
}

async function pjaApplyUrlAlive(url, timeoutMs = 8000) {
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal,
      cache: 'no-store', credentials: 'include' });
    // Only explicit terminal HTTP states are proof that a posting is dead. 401/403/405 and
    // network/anti-bot failures remain launchable because ATSes commonly reject HEAD requests.
    if (response.status === 404 || response.status === 410) return false;
    // Some ATSes (notably Ashby) serve a branded "posting not found" page with HTTP 200.
    // Do a bounded GET only for those hosts so stale postings do not consume E2E apply attempts.
    if (/ashbyhq\.com/i.test(String(url))) {
      const bodyCtrl = new AbortController();
      const bodyTimer = setTimeout(() => bodyCtrl.abort(), Math.min(timeoutMs, 8000));
      try {
        const bodyResp = await fetch(url, { method: 'GET', redirect: 'follow', signal: bodyCtrl.signal,
          cache: 'no-store', credentials: 'include' });
        if (bodyResp.status === 404 || bodyResp.status === 410) return false;
        const text = (await bodyResp.text()).slice(0, 200000);
        if (/(posting|job|position)\s+(not\s+found|no\s+longer\s+available|closed)|this\s+job\s+is\s+no\s+longer\s+available|application\s+is\s+no\s+longer\s+available/i.test(text)) {
          return false;
        }
      } catch (_) {
        return true;
      } finally {
        clearTimeout(bodyTimer);
      }
    }
    return true;
  } catch (_) { return true; }
  finally { clearTimeout(timer); }
}

async function pjaRecoverRankedLastFailure(master) {
  if (!master || master.status !== 'applying' || !master.runId) return master;
  const job = master.jobs && master.jobs[master.currentIndex];
  if (!job || pjaRankedResultRecorded(master, job)) return master;
  const d = await new Promise(r => chrome.storage.local.get(['pja_last_apply_failure', 'pja_ext_queue', 'pja_ext_current'], r));
  const failure = d.pja_last_apply_failure || null;
  if (!failure || !pjaSameRankedJob(failure, job)) return master;
  const extQueueOwns = d.pja_ext_queue && d.pja_ext_queue.runId === master.runId &&
    d.pja_ext_queue.status === 'applying' && pjaSameRankedJob((d.pja_ext_queue.jobs || [])[d.pja_ext_queue.currentIndex || 0], job);
  const currentOwns = pjaSameRankedJob(d.pja_ext_current, job);
  if (!extQueueOwns && !currentOwns) return master;
  const reason = String(failure.reason || '');
  const isSuccessFactors = /successfactors|talentcommunity/i.test(String(job.ats || job.channel || '') + ' ' + String(job.applyUrl || ''));
  const recoveredReason = isSuccessFactors && reason === 'no_submit_btn' ? 'no_apply_path' : reason;
  if (!/^(no_apply_path|no_submit_btn|posting_not_found|apply_btn_no_form|no_apply_btn_on_description)$/.test(reason)) return master;
  const event = {
    runId: master.runId,
    jobId: job.jobId || job.id || null,
    applyUrl: job.applyUrl,
    company: job.company,
    title: job.title,
    channel: job.channel || job.ats || 'external',
    status: 'failed',
    success: false,
    reason: recoveredReason,
    applicationAt: job.applicationAt || master.inFlightAt || Date.now(),
    occurredAt: Date.now(),
  };
  if (self.PJAApplicationLedger) {
    await pjaAppendApplicationEvent(event);
    const ledgerData = await new Promise(r => chrome.storage.local.get(PJA_APPLICATION_LEDGER_KEY, r));
    master = await pjaReconcileRankedLedger(master, ledgerData[PJA_APPLICATION_LEDGER_KEY]);
  } else {
    pjaRankedApplyTerminal(master, job, event);
    master.currentIndex++;
    master.inFlightIndex = null;
    master.inFlightTabId = null;
    master.updatedAt = Date.now();
    await pjaSetLocal({ pja_ranked_apply: master });
  }
  return master;
}

async function pjaDispatchRankedCurrent(master) {
  if (self.PJAApplicationLedger) {
    try {
      const data = await new Promise(r => chrome.storage.local.get(PJA_APPLICATION_LEDGER_KEY, r));
      master = await pjaReconcileRankedLedger(master, data[PJA_APPLICATION_LEDGER_KEY]);
    } catch (e) { console.warn('PJA ranked apply: ledger reconcile failed', e.message); }
  }
  master = await pjaRecoverRankedLastFailure(master);
  master = await pjaReconcileRankedExtCurrent(master);
  if (master.day && self.PJAApplicationLedger?.dayKey(Date.now(), master.timeZone || 'America/Los_Angeles') !== master.day) {
    master.status = 'day_changed'; master.finishedAt = Date.now(); master.inFlightIndex = null;
    master.inFlightTabId = null;
    await pjaSetLocal({ pja_ranked_apply: master });
    await pjaClearRankedExtQueue(master);
    return master;
  }
  if (master.remaining != null && master.remaining <= 0) {
    master.status = 'done'; master.finishedAt = Date.now(); master.inFlightIndex = null;
    master.inFlightTabId = null;
    await pjaSetLocal({ pja_ranked_apply: master });
    await pjaClearRankedExtQueue(master);
    return master;
  }
  const blocked = new Set(master.blockedChannels || []);
  while (master.currentIndex < master.jobs.length && blocked.has(master.jobs[master.currentIndex].channel)) {
    master.results.skipped.push({ ...master.jobs[master.currentIndex], reason: 'channel_paused_for_run' });
    master.currentIndex++;
  }
  if (master.currentIndex >= master.jobs.length) {
    master.status = 'exhausted'; master.finishedAt = Date.now(); master.inFlightIndex = null;
    await pjaSetLocal({ pja_ranked_apply: master });
    await pjaClearRankedExtQueue(master);
    return master;
  }
  if (master.inFlightIndex === master.currentIndex) {
    if (await pjaRankedTabExists(master.inFlightTabId, master.jobs[master.currentIndex])) return master;
    console.warn('PJA ranked apply: in-flight tab missing; relaunching current job', master.currentIndex);
    master.inFlightIndex = null;
    master.inFlightTabId = null;
    master.inFlightAt = null;
    await pjaSetLocal({ pja_ranked_apply: master });
  }
  const job = Object.assign({}, master.jobs[master.currentIndex], { runId: master.runId,
    applicationAt: Date.now(), rankedRun: true });
  master.jobs[master.currentIndex] = job;
  master.inFlightIndex = master.currentIndex;
  master.inFlightAt = Date.now();
  await pjaSetLocal({ pja_ranked_apply: master });
  try {
    if (!await pjaApplyUrlAlive(job.applyUrl)) {
      master.results.failed.push({ ...job, reason: 'posting_not_found_preflight' });
      master.currentIndex++; master.inFlightIndex = null;
      if (self.PJAIdb && job.id) await self.PJAIdb.updateState(job.id,
        { status: 'dead', reason: 'posting_not_found_preflight', updatedAt: Date.now() });
      await pjaSetLocal({ pja_ranked_apply: master });
      return pjaDispatchRankedCurrent(master);
    }
    if (self.PJAIdb && job.id) await self.PJAIdb.updateState(job.id,
      { status: 'queued', reason: 'ranked_run', runId: master.runId, lastAttemptAt: Date.now() });
    let tabId;
    if (job.channel === 'linkedin_easy_apply') tabId = await pjaLaunchEasyApplySingle(job, master);
    else if (job.channel === 'indeed_apply') tabId = await pjaLaunchIndeedSingle(job, master);
    else tabId = await pjaLaunchExternalSingle(job, master);
    await pjaCloseDuplicateRankedTabs(job, tabId);
    // Capture the exact tab after launch so timeout/channel-pause handling can close redirected
    // pages before the next reserve starts. Re-read ownership to avoid overwriting a very fast result.
    const latest = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
    const owned = latest.pja_ranked_apply;
    if (owned && owned.runId === master.runId && owned.status === 'applying'
        && owned.currentIndex === master.currentIndex && owned.inFlightIndex === master.currentIndex) {
      owned.inFlightTabId = tabId;
      master = owned;
      await pjaSetLocal({ pja_ranked_apply: master });
      pjaScheduleRankedReinject(master.runId, master.currentIndex, tabId, 75000);
      pjaScheduleRankedReinject(master.runId, master.currentIndex, tabId, 150000);
    } else await pjaCloseRankedTab(tabId);
  } catch (e) {
    master.results.failed.push({ ...job, reason: 'launch_failed: ' + e.message });
    master.currentIndex++; master.inFlightIndex = null;
    master.inFlightTabId = null;
    await pjaRestoreRankedFailureState(job, 'launch_failed', master);
    await pjaSetLocal({ pja_ranked_apply: master });
    return pjaDispatchRankedCurrent(master);
  }
  return master;
}

async function pjaAdvanceRankedRun(rawEvent, ledger) {
  const event = self.PJAApplicationLedger && self.PJAApplicationLedger.normalizeEvent(rawEvent);
  if (!event || /^(submitting|pending|queued|started|in_progress)$/.test(event.status)) return;
  const d = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
  const master = d.pja_ranked_apply;
  if (!master || master.status !== 'applying' || event.runId !== master.runId) return;
  let job = master.jobs[master.currentIndex];
  if (!pjaSameRankedJob(job, event)) {
    const matchIndex = (master.jobs || []).findIndex((candidate, idx) =>
      idx > master.currentIndex && pjaSameRankedJob(candidate, event));
    if (matchIndex < 0) return;
    console.warn('PJA ranked apply: reconciling stale currentIndex', master.currentIndex, '→', matchIndex, event.company, event.title);
    for (let idx = master.currentIndex; idx < matchIndex; idx++) {
      const skipped = master.jobs[idx];
      if (skipped) {
        master.results.failed.push({ ...skipped, reason: 'stale_inflight_reconciled' });
        await pjaRestoreRankedFailureState(skipped, 'stale_inflight_reconciled', master);
      }
    }
    master.currentIndex = matchIndex;
    job = master.jobs[master.currentIndex];
  }
  pjaRankedApplyTerminal(master, job, event);
  if (/daily_limit|checkpoint|challenge/i.test(event.reason || '') && job.channel === 'linkedin_easy_apply') {
    master.blockedChannels = Array.from(new Set([...(master.blockedChannels || []), 'linkedin_easy_apply']));
  }
  if (/captcha/i.test(event.reason || '') && job.channel === 'indeed_apply') {
    master.blockedChannels = Array.from(new Set([...(master.blockedChannels || []), 'indeed_apply']));
  }
  const dailyTarget = master.dailyTarget || master.targetConfirmed || 50;
  const auditOpts = master.day
    ? { day: master.day, timeZone: master.timeZone || 'America/Los_Angeles', target: dailyTarget }
    : { runId: master.runId, day: null, target: dailyTarget };
  const audit = self.PJAApplicationLedger.auditLedger(ledger, auditOpts);
  master.confirmedCount = audit.counts.confirmed;
  master.remaining = audit.remaining;
  const tabToClose = master.inFlightTabId;
  master.currentIndex++;
  master.inFlightIndex = null;
  master.inFlightTabId = null;
  master.updatedAt = Date.now();
  if (audit.counts.confirmed >= dailyTarget) {
    master.status = 'done'; master.finishedAt = Date.now();
    await pjaSetLocal({ pja_ranked_apply: master });
    await pjaClearRankedExtQueue(master);
    await pjaCloseRankedTab(tabToClose);
    return;
  }
  await pjaSetLocal({ pja_ranked_apply: master });
  await pjaCloseRankedTab(tabToClose);
  await pjaDispatchRankedCurrent(master);
}

// Service-worker apply watchdog: the content-script setTimeout watchdog is throttled on backgrounded
// tabs (MV3), so a job stuck in a single-page hang (e.g. a react-select that never commits) can block
// the whole queue. This runs on a chrome.alarm (wakes the SW) and force-advances a job that's been
// the active one past the hard cap — marks it needs_manual, closes its hung tab, opens the next job.
async function pjaApplyWatchdogTick() {
  if (!self.PJAApplySelect) return;
  const rankedData = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
  let ranked = rankedData.pja_ranked_apply;
  if (self.PJAApplicationLedger) {
    const ledgerData = await new Promise(r => chrome.storage.local.get(PJA_APPLICATION_LEDGER_KEY, r));
    ranked = await pjaReconcileRankedLedger(ranked, ledgerData[PJA_APPLICATION_LEDGER_KEY]);
  }
  ranked = await pjaReconcileRankedExtCurrent(ranked);
  if (ranked && ranked.status === 'applying' && ranked.inFlightIndex === ranked.currentIndex &&
      ranked.inFlightTabId && !await pjaRankedTabExists(ranked.inFlightTabId, ranked.jobs && ranked.jobs[ranked.currentIndex])) {
    console.warn('PJA apply-watchdog: in-flight tab missing; redispatching current ranked job', ranked.currentIndex);
    ranked.inFlightIndex = null;
    ranked.inFlightTabId = null;
    ranked.inFlightAt = null;
    await pjaSetLocal({ pja_ranked_apply: ranked });
    await pjaDispatchRankedCurrent(ranked);
    return;
  }
  const rankedJob = ranked && ranked.jobs && ranked.jobs[ranked.currentIndex];
  const rankedIsWorkday = !!(rankedJob && /workday\.com|myworkdayjobs\.com|workday/i.test(
    String(rankedJob.applyUrl || '') + ' ' + String(rankedJob.ats || rankedJob.channel || rankedJob.strategy || '')
  ));
  const rankedCapMs = rankedIsWorkday ? 20 * 60 * 1000 : (ranked && ranked.e2eSafe ? 3 * 60 * 1000 : 10 * 60 * 1000);
  if (ranked && ranked.status === 'applying' && ranked.inFlightIndex != null &&
      Date.now() - (ranked.inFlightAt || Date.now()) > rankedCapMs) {
    const stuck = ranked.jobs[ranked.currentIndex];
    if (stuck) {
      await pjaCloseRankedTab(ranked.inFlightTabId);
      await pjaRestoreRankedFailureState(stuck, 'ranked_watchdog_timeout', ranked);
      await pjaAppendApplicationEvent({ runId: ranked.runId,
        jobId: stuck.jobId || stuck.id, applyUrl: stuck.applyUrl, company: stuck.company, title: stuck.title,
        channel: stuck.channel, status: 'failed', success: false, reason: 'ranked_watchdog_timeout',
        applicationAt: stuck.applicationAt || ranked.inFlightAt, occurredAt: Date.now() });
    }
    return;
  }
  const d = await new Promise(r => chrome.storage.local.get(['pja_ext_queue', 'pja_apply_wd'], r));
  const q = d.pja_ext_queue;
  const now = Date.now();
  const qIdx = q && (q.currentIndex || 0);
  const qJob = q && (q.jobs || [])[qIdx];
  const qIsWorkday = !!(qJob && /workday\.com|myworkdayjobs\.com|workday/i.test(
    String(qJob.applyUrl || '') + ' ' + String(qJob.ats || qJob.channel || qJob.strategy || '')
  ));
  const dec = self.PJAApplySelect.watchdogDecision(q, d.pja_apply_wd, now,
    qIsWorkday ? { capMs: 20 * 60 * 1000 } : {});
  if (dec.action === 'idle' || dec.action === 'wait') return;
  if (dec.action === 'reset') { await new Promise(r => chrome.storage.local.set({ pja_apply_wd: dec.wd }, r)); return; }
  // action === 'advance' → the active job has been stuck past the cap; force the queue forward.
  const idx = dec.idx;
  const job = (q.jobs || [])[idx];
  if (!job) return;
  const rankedOwnsQueueJob = !!(ranked && ranked.status === 'applying' && job.runId && ranked.runId === job.runId);
  if (rankedOwnsQueueJob) {
    try {
      const tabs = await new Promise(r => chrome.tabs.query({}, r));
      for (const t of tabs) if (t.url && job.applyUrl && (t.url === job.applyUrl || t.url.indexOf(job.applyUrl) === 0)) chrome.tabs.remove(t.id).catch(() => {});
    } catch (_) {}
    await pjaRestoreRankedFailureState(job, 'stuck_watchdog');
    await pjaAppendApplicationEvent({ runId: job.runId, jobId: job.jobId || job.id,
      applyUrl: job.applyUrl, company: job.company, title: job.title, channel: job.channel || job.ats,
      status: 'failed', success: false, reason: 'stuck_watchdog',
      applicationAt: q.startedAt || now, occurredAt: now });
    return;
  }
  if (!q.results || Array.isArray(q.results)) q.results = { applied: [], skipped: [] };
  q.results.skipped.push({ ...job, skipReason: 'stuck_watchdog' });
  try {
    if (self.PJAIdb && job.id) {
      const st = self.PJAApplySelect.resultToState('stuck_budget', 0);
      await self.PJAIdb.updateState(job.id, { status: st.status, reason: 'stuck_watchdog', attempts: st.attempts });
    }
  } catch (_) {}
  q.currentIndex = idx + 1;
  const nextJob = (q.jobs || [])[q.currentIndex];
  if (q.currentIndex >= (q.jobs || []).length) q.status = 'done';
  const writeObj = { pja_ext_queue: q, pja_apply_wd: { runId: q.runId, idx: q.currentIndex,
    jobKey: self.PJAApplySelect?.queueJobKey(nextJob) || '', startedAt: now } };
  if (nextJob && nextJob.applyUrl) {
    writeObj.pja_ext_current = Object.assign({}, nextJob, { returnUrl: 'https://www.linkedin.com/jobs/', runId: q.runId });
    writeObj.pja_navigate_to = nextJob.applyUrl;
  }
  await new Promise(r => chrome.storage.local.set(writeObj, r));
  if (job.runId) {
    try {
      await pjaAppendApplicationEvent({ runId: job.runId, jobId: job.jobId || job.id,
        applyUrl: job.applyUrl, company: job.company, title: job.title, channel: job.channel || job.ats,
        status: 'failed', success: false, reason: 'stuck_watchdog',
        applicationAt: q.startedAt || now, occurredAt: now });
    } catch (_) {}
  }
  console.log('PJA apply-watchdog: force-advanced stuck job', job.company, '→ idx', q.currentIndex, q.status);
  // Close the hung tab(s) for the stuck job (match its applyUrl prefix so we don't close siblings).
  try {
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    for (const t of tabs) { if (t.url && job.applyUrl && (t.url === job.applyUrl || t.url.indexOf(job.applyUrl) === 0)) chrome.tabs.remove(t.id).catch(() => {}); }
  } catch (_) {}
  if (nextJob && nextJob.applyUrl) { try { chrome.tabs.create({ url: nextJob.applyUrl }); } catch (_) {} }
  try {
    fetch('http://localhost:6174/queue-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: q.status, currentIndex: q.currentIndex, total: (q.jobs || []).length, watchdog: 'force-advanced ' + job.company, ts: new Date().toISOString() }) }).catch(() => {});
  } catch (_) {}
}

// Poll the apply watchdog on an alarm (wakes the SW even when idle; not throttled like a bg tab).
try {
  chrome.alarms.create('pja_apply_watchdog', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === 'pja_apply_watchdog') pjaApplyWatchdogTick().catch(() => {}); });
} catch (e) { console.error('PJA: apply-watchdog alarm setup failed', e); }

// One-time migration: fold legacy whole-blob arrays (pja_shortlist / pja_jobs) into the corpus so
// nothing is lost when the corpus becomes the source of truth. Idempotent; gated by pja_schema_version.
chrome.storage.local.get(['pja_schema_version', 'pja_shortlist', 'pja_jobs'], r => {
  if ((r.pja_schema_version || 0) >= 1 || !self.PJAIdb) return;
  self.PJAIdb.migrateFromLegacy({ pja_shortlist: r.pja_shortlist, pja_jobs: r.pja_jobs })
    .then(n => { console.log('PJA: migrated', n, 'legacy jobs into IDB corpus'); chrome.storage.local.set({ pja_schema_version: 1 }); })
    .catch(e => console.error('PJA: corpus migration failed', e));
});

// ── Dev hot-reload: WebSocket connection to dev-server ────────────────────
// In DEV_MODE, background.js connects to ws://localhost:6174.
// When dev-server receives POST /reload, it sends 'reload' over the socket
// and background.js calls chrome.runtime.reload() — reloading the whole extension.
// Pings every 20s keep the MV3 service worker alive while the socket is open.
if (DEV_MODE) {
  let _wsReloadSocket = null;
  let _wsReloadPingTimer = null;

  function connectReloadSocket() {
    try {
      _wsReloadSocket = new WebSocket('ws://localhost:6174');

      _wsReloadSocket.onopen = () => {
        console.log('PJA: hot-reload socket connected');
        // Ping every 20s to keep the MV3 service worker alive
        _wsReloadPingTimer = setInterval(() => {
          if (_wsReloadSocket && _wsReloadSocket.readyState === WebSocket.OPEN) {
            _wsReloadSocket.send('ping');
          }
        }, 20000);
      };

      _wsReloadSocket.onmessage = event => {
        if (event.data === 'reload') {
          console.log('PJA: reload signal received — reloading extension…');
          chrome.runtime.reload();
        } else if (event.data === 'inject') {
          injectContentScriptsIntoExistingTabs();
        } else if (event.data.startsWith('{')) {
          try {
            const msg = JSON.parse(event.data);
            if (msg.cmd === 'setStorage') {
              chrome.storage.local.set(msg.data, () => console.log('PJA: storage set via WS:', Object.keys(msg.data)));
              // A /source-v2 payload carries the normalized corpus — ingest it into IndexedDB.
              if (msg.data && msg.data.pja_job_index) {
                pjaIngestCorpus(msg.data.pja_job_index, msg.data.pja_job_state || {})
                  .then(n => console.log('PJA: corpus ingested', n, 'jobs'))
                  .catch(e => console.error('PJA: corpus ingest failed', e));
              }
            } else if (msg.cmd === 'importCorpus') {
              // Description-rich corpora go directly to IndexedDB over this acknowledged WS path.
              // Avoid mirroring multi-megabyte posting text into chrome.storage's small quota.
              (async () => {
                let data;
                try { data = Object.assign({ ok: true }, await pjaIngestCorpus(msg.index || {}, msg.state || {},
                  { replaceMissing: msg.replaceMissing === true })); }
                catch (e) { data = { ok: false, error: e.message }; }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'importCorpusReply', reqId: msg.reqId, data }));
              })();
            } else if (msg.cmd === 'getStorage') {
              chrome.storage.local.get(msg.keys, data => {
                _wsReloadSocket.send(JSON.stringify({ cmd: 'storageReply', reqId: msg.reqId, data }));
              });
            } else if (msg.cmd === 'getCorpus') {
              // Read the IndexedDB corpus gate report back to the dev-server (/corpus-status).
              (async () => {
                let data = { count: 0 };
                try { if (self.PJAIdb) data = await self.PJAIdb.gateReport({ target: msg.target || 200 }); }
                catch (e) { data = { error: e.message }; }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'corpusReply', reqId: msg.reqId, data }));
              })();
            } else if (msg.cmd === 'getCorpusJob') {
              // Narrow read-only diagnostic for a caller-supplied canonical job id. Keeping this
              // scoped to one record avoids round-tripping the full description-rich corpus.
              (async () => {
                let data = null;
                try { if (self.PJAIdb && msg.id) data = await self.PJAIdb.getJob(String(msg.id)); }
                catch (e) { data = { error: e.message }; }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'corpusJobReply', reqId: msg.reqId, data }));
              })();
            } else if (msg.cmd === 'searchCorpus') {
              // Read-only, description-free search used to review application candidates without
              // exporting the full IndexedDB corpus. Terms are matched against company/title.
              (async () => {
                let data = { jobs: [] };
                try {
                  if (self.PJAIdb) {
                    const corpus = await self.PJAIdb.getAll();
                    const terms = (Array.isArray(msg.terms) ? msg.terms : []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
                    const statuses = new Set((Array.isArray(msg.statuses) ? msg.statuses : ['sourced']).map(x => String(x).toLowerCase()));
                    const minFit = msg.minFit == null ? 0 : Number(msg.minFit) || 0;
                    const limit = Math.max(1, Math.min(1000, Number(msg.limit) || 200));
                    const jobs = [];
                    for (const [id, p] of Object.entries(corpus.index || {})) {
                      const st = (corpus.state || {})[id] || {};
                      const hay = String((p.company || '') + ' ' + (p.title || '')).toLowerCase();
                      if (terms.length && !terms.some(term => hay.includes(term))) continue;
                      if (statuses.size && !statuses.has(String(st.status || 'sourced').toLowerCase())) continue;
                      if (Number(st.fitScore || 0) < minFit) continue;
                      jobs.push({ id, company: p.company || '', title: p.title || '', location: p.location || '',
                        ats: p.ats || p.detectedAts || '', applyUrl: p.applyUrl || '', descriptionStatus: p.descriptionStatus || '',
                        fitScore: st.fitScore, scoreKind: st.scoreKind || '', confidence: st.confidence || '',
                        matchEvidence: st.matchEvidence || [], gaps: st.gaps || [], conflicts: st.conflicts || [],
                        status: st.status || 'sourced', attempts: st.attempts || 0, reason: st.reason || '' });
                    }
                    jobs.sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0));
                    data = { jobs: jobs.slice(0, limit), matched: jobs.length };
                  }
                } catch (e) { data = { jobs: [], error: e.message }; }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'corpusSearchReply', reqId: msg.reqId, data }));
              })();
            } else if (msg.cmd === 'getApplySet') {
              // Build the apply-set from the corpus for the dev-server /apply-run driver.
              (async () => {
                let data = { jobs: [] };
                try { data = await pjaBuildApplySet(msg); } catch (e) { data = { jobs: [], error: e.message }; }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'applySetReply', reqId: msg.reqId, data }));
              })();
            } else if (msg.cmd === 'updateScores') {
              // Write LLM fit scores back into the corpus (from /apply-run rescore pass).
              (async () => {
                let n = 0;
                try { if (self.PJAIdb) for (const s of (msg.scores || [])) { if (s && s.id) { await self.PJAIdb.updateState(s.id, { fitScore: s.fitScore, scoreKind: 'llm', descriptionFingerprint: s.descriptionFingerprint || '', evidenceFingerprint: s.evidenceFingerprint || '', candidateFingerprint: s.candidateFingerprint || '', matchEvidence: s.matchEvidence || [], gaps: s.gaps || [], conflicts: s.conflicts || [], confidence: s.confidence || '' }); n++; } } }
                catch (e) { console.error('PJA: updateScores failed', e); }
                _wsReloadSocket.send(JSON.stringify({ cmd: 'updateScoresReply', reqId: msg.reqId, data: { updated: n } }));
              })();
            } else if (msg.cmd === 'resetCorpusJobs') {
              // Explicit, narrowly-scoped retry reset used after a verified automation fix. Never
              // alters applied/dead postings and only touches caller-supplied canonical IDs.
              (async () => {
                let reset = 0;
                const errors = [];
                const bounded = (p, ms, label) => Promise.race([
                  p,
                  new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))
                ]);
                try {
                  if (self.PJAIdb) for (const id of (msg.ids || [])) {
                    try {
                      const cur = id && await bounded(self.PJAIdb.getJob(id), 5000, 'getJob ' + id);
                      if (!cur || /^(applied|dead)$/i.test(String(cur.state && cur.state.status || ''))) continue;
                      await bounded(self.PJAIdb.updateState(id, { status: 'sourced', reason: '', attempts: 0, updatedAt: Date.now() }), 5000, 'updateState ' + id);
                      reset++;
                    } catch (e) {
                      errors.push({ id, error: e.message || String(e) });
                    }
                  }
                } catch (e) { console.error('PJA: resetCorpusJobs failed', e); }
                if (errors.length) chrome.storage.local.set({ pja_reset_corpus_jobs_error: { errors, ts: Date.now() } });
                _wsReloadSocket.send(JSON.stringify({ cmd: 'resetCorpusJobsReply', reqId: msg.reqId, data: { reset, errors } }));
              })();
            } else if (msg.cmd === 'openTab') {
              chrome.tabs.create({ url: msg.url });
            } else if (msg.cmd === 'resumeRankedApply') {
              (async () => {
                let data;
                try {
                  const current = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
                  let master = current.pja_ranked_apply || null;
                  if (!master || master.status !== 'applying') {
                    data = { ok: false, error: 'no active ranked apply run' };
                  } else {
                    master = await pjaDispatchRankedCurrent(master);
                    data = { ok: true, runId: master.runId, status: master.status,
                      currentIndex: master.currentIndex, inFlightIndex: master.inFlightIndex,
                      tabId: master.inFlightTabId };
                  }
                } catch (e) { data = { ok: false, error: e.message }; }
                try { _wsReloadSocket.send(JSON.stringify({ cmd: 'resumeRankedApplyReply', reqId: msg.reqId, data })); } catch (_) {}
              })();
            } else if (msg.cmd === 'startRankedApply') {
              // Installation is acknowledged and the service worker is the final atomic owner of
              // the active-run lock. The HTTP caller must not report "queued" until this succeeds.
              (async () => {
                let data;
                try {
                  const existing = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
                  const active = existing.pja_ranked_apply;
                  if (!msg.master || msg.master.status !== 'applying') throw new Error('invalid ranked master');
                  if (!msg.force && active && active.status === 'applying' && active.runId !== msg.master.runId) {
                    data = { ok: false, conflict: true, runId: active.runId };
                  } else {
                    await pjaSetLocal({ pja_ranked_apply: msg.master });
                    const started = await pjaDispatchRankedCurrent(msg.master);
                    data = { ok: true, runId: started.runId, status: started.status,
                      currentIndex: started.currentIndex, tabId: started.inFlightTabId };
                  }
                } catch (e) { data = { ok: false, error: e.message }; }
                try { _wsReloadSocket.send(JSON.stringify({ cmd: 'startRankedApplyReply', reqId: msg.reqId, data })); } catch (_) {}
              })();
            } else if (msg.cmd === 'inspectActiveApply') {
              const reply = data => { try { _wsReloadSocket.send(JSON.stringify({ cmd: 'inspectActiveApplyReply', reqId: msg.reqId, data })); } catch (_) {} };
              chrome.tabs.query({}, async tabs => {
                const st = await new Promise(r => chrome.storage.local.get(['pja_ranked_apply', 'pja_last_apply_failure'], r));
                const ranked = st.pja_ranked_apply || null;
                const ats = tabs.filter(t => /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs|workday\.com|icims\.com|jobvite\.com|smartrecruiters\.com|indeed\.com/i.test(t.url || ''));
                const inFlightTab = ranked?.inFlightTabId != null ? tabs.find(t => t.id === ranked.inFlightTabId) : null;
                const inspectTabs = ats.slice(-3);
                if (inFlightTab && !inspectTabs.some(t => t.id === inFlightTab.id)) inspectTabs.push(inFlightTab);
                const out = [];
                for (const tab of inspectTabs) {
                  try {
                    const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => {
                      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
                      const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 100);
                      const controls = [...document.querySelectorAll('button,[role=button],input[type=submit],a')].filter(visible).map(el => ({ tag: el.tagName, type: el.getAttribute('type') || '', role: el.getAttribute('role') || '', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', text: label(el) })).filter(x => x.text).slice(0, 80);
                      const required = [...document.querySelectorAll('[required],[aria-required=true]')].filter(visible).map(el => ({ tag: el.tagName, type: el.getAttribute('type') || '', name: (el.getAttribute('name') || '').slice(0, 80), invalid: el.getAttribute('aria-invalid') || '', checked: 'checked' in el ? !!el.checked : undefined, empty: 'value' in el ? !String(el.value || '').trim() : undefined })).slice(0, 80);
                      const dateParts = [...document.querySelectorAll('[role="spinbutton"], input[data-automation-id^="dateSection"]')]
                        .filter(visible)
                        .map(el => ({
                          tag: el.tagName,
                          id: (el.id || '').slice(0, 120),
                          aid: (el.getAttribute('data-automation-id') || '').slice(0, 80),
                          label: (el.getAttribute('aria-label') || '').slice(0, 80),
                          value: String(el.value || el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext') || '').slice(0, 40),
                          invalid: el.getAttribute('aria-invalid') || '',
                        })).slice(0, 40);
                      const radios = [...document.querySelectorAll('input[type=radio]')].map(el => ({ id: (el.id || '').slice(0, 80), name: (el.name || '').slice(0, 80), value: String(el.value || '').slice(0, 80), checked: !!el.checked, ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 100), labelledBy: (el.getAttribute('aria-labelledby') || '').slice(0, 100), parentText: (el.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) })).slice(0, 80);
                      const errors = [...document.querySelectorAll('[role=alert],[aria-invalid=true],[class*=error],[class*=invalid]')].filter(visible).map(label).filter(Boolean).slice(0, 30);
                      return { url: location.href, title: document.title, controls, required, dateParts, radios, errors, textTail: (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(-1200) };
                    }});
                    out.push({ tabId: tab.id, url: tab.url, frames: frames.map(x => x.result).filter(Boolean) });
                  } catch (e) { out.push({ tabId: tab.id, url: tab.url, error: e.message }); }
                }
                const slimResults = rows => (rows || []).map(row => ({
                  company: row.company || '', title: row.title || '', ats: row.ats || row.strategy || '',
                  reason: row.reason || '', status: row.status || '', applyUrl: row.applyUrl || '',
                })).slice(0, 100);
                reply({ tabs: out, ranked: ranked ? {
                  runId: ranked.runId, status: ranked.status, currentIndex: ranked.currentIndex,
                  inFlightIndex: ranked.inFlightIndex, inFlightTabId: ranked.inFlightTabId,
                  totalJobs: ranked.jobs && ranked.jobs.length,
                  confirmed: ranked.results && ranked.results.confirmed && ranked.results.confirmed.length || 0,
                  failed: ranked.results && ranked.results.failed && ranked.results.failed.length || 0,
                  skipped: ranked.results && ranked.results.skipped && ranked.results.skipped.length || 0,
                  unverified: ranked.results && ranked.results.unverified && ranked.results.unverified.length || 0,
                  results: ranked.results ? {
                    confirmed: slimResults(ranked.results.confirmed),
                    failed: slimResults(ranked.results.failed),
                    skipped: slimResults(ranked.results.skipped),
                    unverified: slimResults(ranked.results.unverified),
                  } : null,
                } : null, lastFailure: st.pja_last_apply_failure ? {
                  reason: st.pja_last_apply_failure.reason || '', company: st.pja_last_apply_failure.company || '',
                  title: st.pja_last_apply_failure.title || '', ats: st.pja_last_apply_failure.ats || '',
                } : null });
              });
            } else if (msg.cmd === 'injectResume') {
              // Dev-server-triggered résumé upload: reads pja_resume_b64 (a data URL) and injects
              // it into the file input of the tab matching msg.urlMatch, via a DataTransfer in the
              // page's MAIN world. Works around the MCP file_upload tool being unable to attach the
              // stored résumé. Reusable across any ATS with a standard <input type=file>.
              (() => {
                const reqId = msg.reqId;
                const reply = data => { try { _wsReloadSocket.send(JSON.stringify({ cmd: 'injectResumeReply', reqId, data })); } catch (_) {} };
                chrome.storage.local.get(['pja_resume_b64', 'pja_resume_filename'], d => {
                  const b64 = d.pja_resume_b64; const filename = d.pja_resume_filename || 'resume.pdf';
                  if (!b64) { reply({ ok: false, err: 'no pja_resume_b64' }); return; }
                  const urlMatch = msg.urlMatch || 'myworkdayjobs.com';
                  chrome.tabs.query({}, async tabs => {
                    const matches = tabs.filter(t => (t.url || '').includes(urlMatch));
                    if (!matches.length) { reply({ ok: false, err: 'no tab matching ' + urlMatch }); return; }
                    const results = [];
                    for (const tab of matches) {
                    await new Promise(done => {
                    chrome.scripting.executeScript({
                      target: { tabId: tab.id, allFrames: true }, world: 'MAIN', args: [b64, filename],
                      func: (b64, fname) => {
                        const dbg = { b64len: (b64 || '').length };
                        try {
                          const parts = b64.split(',');
                          const mime = (parts[0] || '').match(/:(.*?);/)?.[1] || 'application/pdf';
                          const bin = atob(parts[1] || parts[0]);
                          const bytes = new Uint8Array(bin.length);
                          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                          const file = new File([bytes], fname, { type: mime });
                          dbg.mime = mime; dbg.binLen = bin.length; dbg.fileSize = file.size;
                          const inputs = [...document.querySelectorAll('input[type=file]')];
                          dbg.inputCount = inputs.length;
                          const input = inputs.find(el => el.offsetParent !== null) || inputs[0];
                          if (!input) return { ok: false, err: 'no file input', dbg };
                          const dt = new DataTransfer(); dt.items.add(file);
                          dbg.dtLen = dt.files.length;
                          try { input.files = dt.files; } catch (e) { dbg.assignErr = String(e); }
                          dbg.afterAssign = input.files?.length;
                          if (!(input.files && input.files.length > 0)) {
                            try { Object.defineProperty(input, 'files', { value: dt.files, configurable: true }); } catch (_) {}
                          }
                          input.dispatchEvent(new Event('change', { bubbles: true }));
                          input.dispatchEvent(new Event('input', { bubbles: true }));
                          // Also fire a drop event on the dropzone (Workday listens for DnD)
                          try {
                            const zone = input.closest('[data-automation-id]') || input.parentElement;
                            if (zone) { const de = new DragEvent('drop', { bubbles: true }); Object.defineProperty(de, 'dataTransfer', { value: dt }); zone.dispatchEvent(de); }
                          } catch (_) {}
                          dbg.finalFiles = input.files?.length;
                          return { ok: input.files && input.files.length > 0, files: input.files?.length || 0, name: input.files?.[0]?.name || '', dbg };
                        } catch (e) { return { ok: false, err: String(e), dbg }; }
                      }
                    }, r => { results.push({ tabId: tab.id, url: (tab.url || '').slice(-50), result: r?.[0]?.result || { ok: false, err: 'no result' } }); done(); });
                    });
                    }
                    const anyOk = results.some(x => x.result && x.result.ok);
                    reply({ ok: anyOk, injected: results.filter(x => x.result?.ok).length, tabs: results });
                  });
                });
              })();
            } else if (msg.cmd === 'successFactorsStart') {
              // Start an already-open SAP SuccessFactors RMK apply flow through the page's
              // own MAIN-world handler. This does not fill or submit the application.
              (async () => {
                const reqId = msg.reqId;
                const reply = data => { try { _wsReloadSocket.send(JSON.stringify({ cmd: 'successFactorsStartReply', reqId, data })); } catch (_) {} };
                try {
                  const requested = String(msg.urlMatch || '').trim();
                  const tabs = await chrome.tabs.query({});
                  const webTabs = tabs.filter(tab => /^https?:/i.test(tab.url || ''));
                  const exact = requested && webTabs.find(tab => (tab.url || '') === requested);
                  const substring = requested && webTabs.find(tab => (tab.url || '').includes(requested));
                  const domainMatches = webTabs.filter(tab => {
                    try {
                      const host = new URL(tab.url).hostname.toLowerCase();
                      return host.startsWith('careers.') || host.includes('successfactors');
                    } catch (_) { return false; }
                  });
                  const tab = exact || substring || domainMatches.find(tab => tab.active) || domainMatches[domainMatches.length - 1];
                  if (!tab) {
                    reply({ ok: false, error: requested
                      ? `no tab matching ${requested} or a careers/SuccessFactors domain`
                      : 'no careers/SuccessFactors tab found' });
                    return;
                  }

                  const injected = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    world: 'MAIN',
                    func: () => {
                      const apply = globalThis.j2w && globalThis.j2w.Apply;
                      const handler = apply && apply.handleApplyNowButton;
                      const diagnostics = {
                        url: location.href,
                        title: document.title,
                        j2wPresent: !!globalThis.j2w,
                        applyPresent: !!apply,
                        handlerType: typeof handler,
                      };
                      if (typeof handler !== 'function') {
                        return { ok: false, error: 'j2w.Apply.handleApplyNowButton is unavailable', diagnostics };
                      }
                      try {
                        const eventLike = {
                          target: {}, currentTarget: {},
                          preventDefault() {}, stopPropagation() {},
                        };
                        const result = handler.call(apply, eventLike);
                        diagnostics.invoked = true;
                        diagnostics.returnType = typeof result;
                        return { ok: true, diagnostics };
                      } catch (e) {
                        diagnostics.invoked = false;
                        return { ok: false, error: String(e && (e.message || e)), diagnostics };
                      }
                    },
                  });
                  const result = injected && injected[0] && injected[0].result;
                  reply(Object.assign({ tabId: tab.id, tabUrl: tab.url }, result || {
                    ok: false, error: 'MAIN-world invocation returned no diagnostics',
                  }));
                } catch (e) {
                  reply({ ok: false, error: e.message || String(e) });
                }
              })();
            } else if (msg.cmd === 'startEasyApply') {
              // Backend-triggered Easy Apply: seed the EA queue into a fresh LinkedIn tab's
              // sessionStorage, then reload so content.js resumeApplyOnLoad runs the auto-apply
              // loop using the extension's OWN chrome.debugger trusted clicks. As long as no
              // external CDP client (claude-in-chrome) is attached to this tab, the trusted
              // clicks work. Monitor progress via /get-storage (pja_ea_lastresult / pja_applied_log).
              const eaJobs = Array.isArray(msg.jobs) ? msg.jobs : [];
              if (eaJobs.length) {
                chrome.storage.local.get(['pja_profile', 'pja_answers'], d => {
                  const queue = { status: 'applying', jobs: eaJobs, currentIndex: 0,
                    results: { applied: [], skipped: [], errors: [] },
                    profile: d.pja_profile || {}, answers: d.pja_answers || {},
                    runId: eaJobs[0].runId || null, startedAt: eaJobs[0].applicationAt || Date.now() };
                  // Open the SEARCH page (currentJobId): its detail panel has a reliable Easy Apply
                  // <button> (the job-view control is a flaky <a> whose click navigates to a cold
                  // /apply/ page → Next reloads → loop). pjaFillForm is now scoped to the modal so
                  // it no longer pollutes the page search bar (which used to close the modal).
                  const firstUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true&currentJobId=' + eaJobs[0].jobId;
                  chrome.tabs.query({ url: ['*://www.linkedin.com/jobs/*'] }, tabs => {
                    for (const oldTab of (tabs || [])) {
                      chrome.scripting.executeScript({
                        target: { tabId: oldTab.id },
                        func: () => { try { sessionStorage.removeItem('pja_apply_queue'); } catch (_) {} },
                      }).catch(() => {});
                    }
                    chrome.tabs.create({ url: firstUrl, active: true }, tab => {
                      const onUpd = (tid, info) => {
                        if (tid === tab.id && info.status === 'complete') {
                          chrome.tabs.onUpdated.removeListener(onUpd);
                          chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: q => { try { sessionStorage.setItem('pja_apply_queue', JSON.stringify(q)); location.reload(); } catch (e) {} },
                            args: [queue],
                          }).catch(() => {});
                        }
                      };
                      chrome.tabs.onUpdated.addListener(onUpd);
                    });
                  });
                });
              }
            } else if (msg.cmd === 'startIndeedApply') {
              // Seed pja_indeed_queue + open the first job's viewjob page. indeed-apply.js drives
              // the rest (click Apply → smartapply step-machine → submit → advance), resuming across
              // the viewjob↔smartapply navigations. Monitor via pja_indeed_queue / pja_applied_log.
              const ijobs = Array.isArray(msg.jobs) ? msg.jobs : [];
              if (ijobs.length) {
                chrome.storage.local.get(['pja_profile', 'pja_answers'], d => {
                  const queue = { status: 'applying', jobs: ijobs, currentIndex: 0,
                    results: { applied: [], skipped: [] }, profile: d.pja_profile || {}, answers: d.pja_answers || {},
                    runId: ijobs[0].runId || null, startedAt: ijobs[0].applicationAt || Date.now() };
                  chrome.storage.local.set({ pja_indeed_queue: queue, pja_indeed_paused: null }, () => {
                    chrome.tabs.create({ url: 'https://www.indeed.com/viewjob?jk=' + ijobs[0].jobId, active: true });
                  });
                });
              }
            } else if (msg.cmd === 'startScan') {
              // Backend-trigger a job scanner (sources candidates → pja_shortlist). Supports
              // LinkedIn, Indeed, and conservative one-page Glassdoor collection.
              // runs the platform's start-scan in the tab.
              const isIndeed = msg.source === 'indeed';
              const isGlassdoor = msg.source === 'glassdoor';
              const scanUrl = msg.url || (isIndeed
                ? 'https://www.indeed.com/jobs?q=process+engineer&l=California'
                : isGlassdoor
                  ? 'https://www.glassdoor.com/Jobs/process-engineer-jobs-SRCH_KO0,16.htm?location=California'
                  : 'https://www.linkedin.com/jobs/search/?f_AL=true&keywords=quality%20engineer&location=California');
              chrome.tabs.create({ url: scanUrl, active: true }, tab => {
                const onUpd = (tid, info) => {
                  if (tid === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpd);
                    setTimeout(() => {
                      chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (fast, source) => {
                          if (source === 'indeed') { if (typeof window.__pjaStartIndeedScan === 'function') window.__pjaStartIndeedScan({}); }
                          else if (source === 'glassdoor') { if (typeof window.__pjaStartGlassdoorScan === 'function') window.__pjaStartGlassdoorScan({}); }
                          else { if (typeof window.__pjaStartScan === 'function') window.__pjaStartScan({ fast }); }
                        },
                        args: [!!msg.fast, msg.source || ''],
                      }).catch(() => {});
                    }, 4500);
                  }
                };
                chrome.tabs.onUpdated.addListener(onUpd);
              });
            } else if (msg.cmd === 'closeJobTabs') {
              // Close stray LinkedIn/ATS tabs left by prior runs so a fresh EA tab has the tab's
              // single CDP slot to itself (stray tabs cause 'CDP timeout→synthetic' contention).
              chrome.tabs.query({}, tabs => {
                for (const t of tabs) {
                  if (/linkedin\.com\/jobs|greenhouse\.io|lever\.co|ashbyhq\.com|paylocity\.com|jobvite\.com|smartrecruiters\.com|myworkdayjobs|icims\.com|indeed\.com\/viewjob|indeed\.com\/jobs|smartapply\.indeed\.com/i.test(t.url || '')) {
                    try { chrome.tabs.remove(t.id); } catch (_) {}
                  }
                }
              });
            } else if (msg.cmd === 'closeDuplicateActiveApplyTabs') {
              (async () => {
                let data;
                try {
                  const d = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
                  const master = d.pja_ranked_apply || null;
                  const job = master && master.jobs && master.jobs[master.currentIndex];
                  if (!master || !job) data = { ok: false, error: 'no active ranked job' };
                  else {
                    const closed = await pjaCloseDuplicateRankedTabs(job, master.inFlightTabId);
                    data = { ok: true, closed, runId: master.runId, keepTabId: master.inFlightTabId };
                  }
                } catch (e) { data = { ok: false, error: e.message }; }
                try { _wsReloadSocket.send(JSON.stringify({ cmd: 'closeDuplicateActiveApplyTabsReply', reqId: msg.reqId, data })); } catch (_) {}
              })();
            } else if (msg.cmd === 'resolveAts') {
              // Resolve external ATS URLs for a batch of jobIds via the voyager API on a LinkedIn
              // tab (paced, account-safe). Writes externalApplyUrl back onto pja_shortlist entries.
              const jobIds = Array.isArray(msg.jobIds) ? msg.jobIds : [];
              if (jobIds.length) {
                chrome.tabs.create({ url: 'https://www.linkedin.com/jobs/search/?keywords=engineer', active: false }, tab => {
                  const onUpd = (tid, info) => {
                    if (tid === tab.id && info.status === 'complete') {
                      chrome.tabs.onUpdated.removeListener(onUpd);
                      setTimeout(() => {
                        chrome.scripting.executeScript({
                          target: { tabId: tab.id },
                          func: ids => { if (typeof window.__pjaResolveVoyager === 'function') window.__pjaResolveVoyager(ids); },
                          args: [jobIds],
                        }).catch(() => {});
                      }, 4000);
                    }
                  };
                  chrome.tabs.onUpdated.addListener(onUpd);
                });
              }
            } else if (msg.cmd === 'cdpDateTest') {
              const dbgLog = [];
              const origLog = console.log.bind(console);
              cdpTypeDateSpinner(msg.tabId, msg)
                .then(() => {
                  chrome.storage.local.set({ pja_dbg_cdp: { ok: true, ts: Date.now() } });
                  origLog('PJA: cdpDateTest done');
                })
                .catch(e => {
                  chrome.storage.local.set({ pja_dbg_cdp: { ok: false, err: e.message, ts: Date.now() } });
                  origLog('PJA: cdpDateTest error:', e.message);
                });
            }
          } catch(e) {}
        }
      };

      _wsReloadSocket.onclose = () => {
        clearInterval(_wsReloadPingTimer);
        _wsReloadSocket = null;
        // Retry after 3s in case the dev server restarts
        setTimeout(connectReloadSocket, 3000);
      };

      _wsReloadSocket.onerror = () => {
        // onclose fires after onerror, so retry is handled there
      };
    } catch (e) {
      // WebSocket not available or server not running — retry quietly
      setTimeout(connectReloadSocket, 3000);
    }
  }

  connectReloadSocket();
}

// ── Dev: re-inject content scripts into existing matching tabs on startup ─────
function injectContentScriptsIntoExistingTabs() {
  const allScripts = [
    'content/extractors/linkedin.js',
    'content/extractors/indeed.js',
    'content/extractors/glassdoor.js',
    'content/extractors/generic.js',
    'content/autofill.js',
    'content/workday-engine.js',
    'content/workday-auth.js',
    'content/auto-apply.js',
    'content/external-apply.js',
    'content/job-scraper.js',
    'content/indeed-scraper.js',
    'content/glassdoor-scraper.js',
    'content/indeed-apply.js',
    'content/content.js'
  ];
  const targetUrls = [
    '*://*.linkedin.com/*', '*://*.indeed.com/*', '*://*.glassdoor.com/*',
    '*://*.greenhouse.io/*', '*://*.lever.co/*',
    '*://*.workday.com/*', '*://*.myworkdayjobs.com/*',
    '*://*.jobvite.com/*', '*://*.icims.com/*', '*://*.taleo.net/*',
    '*://*.bamboohr.com/*', '*://*.smartrecruiters.com/*', '*://*.ashbyhq.com/*'
  ];
  chrome.tabs.query({ url: targetUrls }, tabs => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { try { delete window.__pjaExtApplyLoaded; } catch (_) { window.__pjaExtApplyLoaded = false; } },
      }).catch(() => {}).then(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: allScripts }))
        .then(() => console.log('PJA: injected into tab', tab.id, tab.url))
        .catch(err => console.log('PJA: inject failed for tab', tab.id, err.message));
    }
  });
}

if (DEV_MODE) {
  // Auto-inject into existing tabs after extension reload
  injectContentScriptsIntoExistingTabs();
}

// ── Inject fiber-main.js in MAIN world on every ATS page load ─────────────────
// manifest "world":"MAIN" doesn't re-inject into already-open tabs after reload,
// and some Chrome versions may not support it. Use tabs.onUpdated as the reliable path.
const ATS_URL_PATTERNS = ['greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com',
  'jobvite.com', 'icims.com', 'ashbyhq.com', 'smartrecruiters.com', 'bamboohr.com',
  'rippling.com', 'localhost', '127.0.0.1'];

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !ATS_URL_PATTERNS.some(p => tab.url.includes(p))) return;
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content/fiber-main.js']
  }).then(() => {
    chrome.storage.local.set({ pja_fiber_inject_ok: { tabId, url: tab.url, ts: Date.now() } });
  }).catch(err => {
    chrome.storage.local.set({ pja_fiber_inject_err: { tabId, url: tab.url, err: String(err), ts: Date.now() } });
  });
});

// Recover Greenhouse jobs that redirect to an unpermitted corporate careers host. The matching
// gh_jid proves this is the same posting; keep a per-tab guard to avoid redirect loops.
const pjaGreenhouseFallbackTabs = new Map();
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || /greenhouse\.io/i.test(tab.url)) return;
  chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], d => {
    const q = d.pja_ext_queue, cur = d.pja_ext_current;
    if (!q || q.status !== 'applying' || !cur || cur._handled) return;
    const fallback = self.PJAApplySelect && self.PJAApplySelect.greenhouseEmbedFallback
      ? self.PJAApplySelect.greenhouseEmbedFallback(cur.applyUrl, tab.url) : '';
    if (!fallback) return;
    const guard = cur.id || cur.applyUrl;
    if (pjaGreenhouseFallbackTabs.get(tabId) === guard) return;
    pjaGreenhouseFallbackTabs.set(tabId, guard);
    chrome.tabs.update(tabId, { url: fallback }, () => {
      chrome.storage.local.set({ pja_greenhouse_fallback: {
        tabId, from: tab.url, to: fallback, ok: !chrome.runtime.lastError,
        error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, ts: Date.now()
      } });
    });
  });
});
chrome.tabs.onRemoved.addListener(tabId => pjaGreenhouseFallbackTabs.delete(tabId));

// Note: autofill.js + external-apply.js are injected by manifest content_scripts (<all_urls>)
// on every page load — no need for programmatic injection via onUpdated.

// TOP-LEVEL: inject gmail-verify.js when Gmail tab opens during Workday auth or generic
// ATS email-code recovery.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.includes('mail.google.com')) return;
  const data = await new Promise(r =>
    chrome.storage.local.get(['pja_wd_gmail_session', 'pja_email_code_session'], r)
  );
  const session = data.pja_wd_gmail_session || data.pja_email_code_session;
  if (!session || session.gmailTabId !== tabId) return;
  if (Date.now() - session.startedAt > 180000) {
    if (data.pja_email_code_session) chrome.storage.local.remove('pja_email_code_session');
    return;
  }
  console.log('PJA bg: injecting gmail-verify.js into Gmail tab', tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { try { delete window.__pjaGmailVerifyRunning; } catch (_) { window.__pjaGmailVerifyRunning = false; } }
  }).catch(() => {});
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/gmail-verify.js']
  }).catch(err => {
    console.error('PJA bg: gmail-verify injection failed', err);
    if (data.pja_email_code_session) {
      chrome.storage.local.set({
        pja_email_code_result: { hostname: session.hostname, company: session.company, success: false, reason: 'inject_failed', ts: Date.now() }
      });
      chrome.storage.local.remove('pja_email_code_session');
    } else {
      chrome.storage.local.set({
        pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'inject_failed', ts: Date.now() }
      });
      if (session.applyTabId) {
        chrome.tabs.sendMessage(session.applyTabId, { type: 'WD_VERIFY_COMPLETE', success: false }).catch(() => {});
      }
      chrome.storage.local.remove('pja_wd_gmail_session');
    }
  });
});

// ── Generic analyzer prompt (Nano fallback). The candidate-specific scoring prompt is
// configured in dev-server.js via candidate.local.txt; this dormant fallback ships no PII.
const SYSTEM_PROMPT = `You are a job-fit analyzer. Using the candidate profile in the user
message, analyze the job posting and return ONLY valid JSON (no markdown) with this structure:
{
  "fitScore": <integer 0-100>,
  "matchedSkills": [<skills the candidate has that match the job>],
  "gaps": [<skills the job requires that the candidate lacks>],
  "recruiterTitle": "<suggested LinkedIn title to search for>",
  "dmMessage": "<LinkedIn DM under 280 chars>",
  "emailMessage": "<cold email, Subject: line first, under 500 chars>",
  "linkedinSearchQuery": "<exact LinkedIn search query string>"
}`;

// Nano prompt — ask only for a fit score integer (tiny output = fast + reliable)
const NANO_SYSTEM_PROMPT = `You score how well a candidate fits a job posting based on the candidate profile provided. Reply with a single integer 0-100. No other text.`;

// ── Skill groups ── [display label, ...synonyms] ── used for keyword gap detection ──
const CANDIDATE_SKILLS = [
  // Confirmed on resume
  ['Wafer Inspection', 'wafer inspection', 'wafer defect inspection', 'defect review', 'wafer metrology', 'in-line inspection', 'inline inspection', 'visual inspection'],
  ['Thin Film Metrology', 'thin film', 'thin film metrology', 'film thickness', 'film thickness measurement', 'thickness measurement'],
  ['Photolithography', 'photolithography', 'lithography', 'photo process', 'patterning', 'photomask', 'litho'],
  ['GMP', 'gmp', 'good manufacturing practice', 'cgmp', 'current good manufacturing practice', 'good manufacturing procedures'],
  ['SPC', 'spc', 'statistical process control', 'control charts', 'process capability', 'cp', 'cpk', 'spc chart'],
  ['Quality Management', 'quality management', 'quality assurance', 'quality control', 'qc', 'qa', 'qms', 'quality systems', 'quality standards'],
  ['Lean Six Sigma', 'lean six sigma', 'six sigma', 'lss', 'dmaic', 'lean manufacturing', 'lean principles'],
  ['5S Principles', '5s', 'five s', '5s principles', 'workplace organization', 'sort set shine standardize sustain'],
  ['Root Cause Analysis', 'root cause analysis', 'rca', 'root cause', 'corrective action', 'capa', 'problem solving'],
  ['Clean Room', 'clean room', 'cleanroom', 'iso 5', 'iso 6', 'iso 7', 'class 100', 'class 10000', 'controlled environment', 'clean room operations'],
  ['Defect Detection', 'defect detection', 'defect classification', 'defect analysis', 'defect management', 'defect review', 'yield loss', 'misprocessing'],
  ['EH&S', 'ehs', 'eh&s', 'environmental health safety', 'health and safety', 'safety compliance', 'sds', 'hazardous chemical', 'safety data sheet'],
  ['Data Management', 'data management', 'data analysis', 'data reporting', 'data entry', 'documentation', 'reporting'],
  ['Yield Improvement', 'yield improvement', 'yield enhancement', 'yield', 'bottleneck reduction', 'throughput improvement'],

  // Industry-context matches (not explicit skills but relevant to her work)
  ['Semiconductor Manufacturing', 'semiconductor', 'wafer fab', 'fab', 'wafer fabrication', 'semiconductor manufacturing', 'chip manufacturing'],
  ['Medical Device Manufacturing', 'medical device', 'medtech', 'in vitro diagnostics', 'ivd', 'point of care'],
  ['Metrology', 'metrology', 'measurement systems', 'msa', 'gauge r&r', 'gage r&r', 'measurement systems analysis'],
  ['KLA Tools', 'kla', 'kla-tencor', 'surfscan', 'brightfield inspection', 'darkfield inspection'],
  ['Process Control', 'process control', 'process stability', 'process integrity', 'in-process control', 'ipc']
];

// Broader tech keywords to detect gaps (skills mentioned in JDs that the candidate lacks)
const TECH_KEYWORDS = [
  'python', 'r scripting', 'data science', 'machine learning', 'ml', 'deep learning',
  'euv', 'extreme ultraviolet', 'euv lithography',
  'pecvd', 'lpcvd', 'cvd', 'ald', 'atomic layer deposition', 'chemical vapor deposition',
  'cmp', 'chemical mechanical planarization', 'chemical mechanical polishing',
  'etch', 'dry etch', 'wet etch', 'plasma etch', 'reactive ion etch', 'rie',
  'deposition', 'pvd', 'physical vapor deposition', 'sputter',
  'electrochemistry', 'electroplating', 'electrodeposition',
  'implant', 'ion implantation',
  'diffusion', 'oxidation', 'annealing',
  'scatterometry', 'afm', 'atomic force microscope', 'tem', 'transmission electron',
  'defect ml', 'defect classification ml', 'automated defect classification', 'adc',
  'semiconductor equipment', 'tool maintenance', 'tool qualification',
  'design of experiments', 'doe',
  'jmp', 'minitab', 'statistical software',
  'sql', 'tableau', 'power bi',
  'cad', 'solidworks', 'autocad',
  'plc', 'scada', 'automation',
  'supply chain', 'vendor management',
  'iso 9001', 'as9100', 'iatf 16949',
  'gd&t', 'geometric dimensioning',
  'reliability engineering', 'mtbf', 'mttf',
  'yield improvement', 'yield enhancement',
  'fab', 'foundry', 'wafer fab',
  'opc', 'optical proximity correction',
  'reticle', 'mask inspection',
  'ebeam', 'electron beam', 'e-beam',
  'xrd', 'x-ray diffraction',
  'sims', 'secondary ion mass spectrometry',
  'edx', 'eds', 'energy dispersive',
  'raman', 'raman spectroscopy',
  'profilometry', 'surface roughness',
  'stress measurement', 'film stress',
  'mos', 'cmos', 'transistor',
  'dielectric', 'gate oxide',
  'interconnect', 'metallization',
  'packaging', 'die attach', 'wire bond',
  'failure analysis', 'root cause analysis',
  'corrective action', 'capa',
  'auditing', 'supplier audit',
  'validation', 'qualification', 'ivq', 'iq oq pq'
];

// ── Storage helpers ─────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('apiKey', r => resolve(r.apiKey || null));
  });
}

async function getJobs() {
  return new Promise(resolve => {
    chrome.storage.local.get('pja_jobs', r => resolve(r.pja_jobs || []));
  });
}

async function setJobs(jobs) {
  return new Promise(resolve => {
    chrome.storage.local.set({ pja_jobs: jobs }, resolve);
  });
}

// ── Tier 1: Check Gemini Nano availability ──────────────────────────────────
// Returns: 'available'|'readily' (ready) | 'downloading' | 'after-download' | 'no' | 'unavailable'
async function getNanoStatus() {
  try {
    // Chrome 131+: LanguageModel global (replaces ai.languageModel)
    if (typeof LanguageModel !== 'undefined') {
      return await LanguageModel.availability();
    }
    // Chrome 127-130: ai.languageModel (old API)
    const aiObj = typeof ai !== 'undefined' ? ai : (typeof self !== 'undefined' ? self.ai : null);
    if (!aiObj?.languageModel) return 'unavailable';
    const cap = await aiObj.languageModel.capabilities();
    return cap.available || 'unavailable';
  } catch (e) {
    console.warn('PJA: Nano status check:', e?.message);
    return 'unavailable';
  }
}

// Chrome 148+ uses 'available'; older Chrome used 'readily'
function nanoIsReady(status) {
  return status === 'available' || status === 'readily';
}

function isNanoAvailable() {
  return getNanoStatus().then(nanoIsReady);
}

// ── Tier 1: Gemini Nano analysis ────────────────────────────────────────────
// Nano produces only a fit score integer; template fills skills/gaps/outreach.
async function analyzeWithNano({ title, company, description }) {
  const userContent = `Job: ${title || 'Unknown'} at ${company || 'Unknown'}.\n${(description || '').slice(0, 2000)}\nFit score 0-100:`;

  let session;
  if (typeof LanguageModel !== 'undefined') {
    session = await LanguageModel.create({ systemPrompt: NANO_SYSTEM_PROMPT, temperature: 0.1, topK: 3 });
  } else {
    const aiObj = typeof ai !== 'undefined' ? ai : self.ai;
    session = await aiObj.languageModel.create({ systemPrompt: NANO_SYSTEM_PROMPT });
  }

  try {
    const result = await session.prompt(userContent);
    session.destroy();

    const fitScore = parseNanoScore(result);
    if (fitScore === null) throw new Error('Could not parse score from: ' + result.slice(0, 60));

    // Merge AI score with template's skills/gaps/outreach
    const template = getTemplateAnalysis(title, company, description);
    const data = { ...template, fitScore, engine: 'nano' };
    return { success: true, data, engine: 'nano' };
  } catch (e) {
    try { session.destroy(); } catch {}
    throw e;
  }
}

function parseNanoScore(raw) {
  const text = (raw || '').trim();
  // Extract first number found
  const match = text.match(/\d+(\.\d+)?/);
  if (!match) return null;
  let n = parseFloat(match[0]);
  // Normalize: if decimal fraction (e.g. 0.87), convert to 0-100
  if (n > 0 && n <= 1) n = Math.round(n * 100);
  // Clamp to 0-100
  n = Math.max(0, Math.min(100, Math.round(n)));
  return n;
}


// ── Tier 3: Smart template + keyword matching ───────────────────────────────
function matchSkills(description) {
  const descLower = (description || '').toLowerCase();
  const matched = [];

  for (const group of CANDIDATE_SKILLS) {
    const displayLabel = group[0]; // human-readable display name
    const synonyms = group.slice(1); // everything after index 0 is a synonym to match
    const isMatch = synonyms.some(synonym => {
      const escaped = synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[\\s,/\\-\\(])${escaped}(?:[\\s,/\\-\\)\\.]|$)`, 'i');
      return pattern.test(descLower) || descLower.includes(synonym.toLowerCase());
    });
    if (isMatch) matched.push(displayLabel);
  }

  return matched;
}

function inferGaps(description, matchedSkillGroups) {
  const descLower = (description || '').toLowerCase();
  const gaps = [];

  // Build a set of all synonyms for matched skills to exclude from gaps
  const matchedSynonyms = new Set();
  for (const group of CANDIDATE_SKILLS) {
    const displayLabel = group[0];
    if (matchedSkillGroups.includes(displayLabel)) {
      group.slice(1).forEach(s => matchedSynonyms.add(s.toLowerCase()));
    }
  }

  for (const keyword of TECH_KEYWORDS) {
    const kwLower = keyword.toLowerCase();
    // Skip if already covered by matched skills
    if (matchedSynonyms.has(kwLower)) continue;

    // Check if keyword appears in description
    const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[\\s,/\\-\\(])${escaped}(?:[\\s,/\\-\\)\\.]|$)`, 'i');
    if (pattern.test(descLower) || descLower.includes(kwLower)) {
      // Use a clean display name (capitalize first letter)
      const display = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      gaps.push(display);
    }
  }

  return gaps.slice(0, 8); // cap at 8 gaps to keep UI clean
}

function computeFitScore(matchedCount, gapCount) {
  return Math.min(95, Math.max(35, Math.round(
    (matchedCount / Math.max(1, matchedCount + gapCount)) * 100 * 1.1 + 15
  )));
}

function dedupeById(arr) {
  const seen = new Map();
  // Iterate in reverse so the first occurrence (oldest) wins when ids collide
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item?.id && !seen.has(item.id)) seen.set(item.id, item);
  }
  return Array.from(seen.values()).reverse();
}

function getTemplateAnalysis(title, company, description) {
  const matchedSkillGroups = matchSkills(description);
  const gaps = inferGaps(description, matchedSkillGroups);

  // matchedSkillGroups already contains display labels from CANDIDATE_SKILLS[n][0]
  const matchedSkills = matchedSkillGroups.length > 0
    ? matchedSkillGroups
    : [
        'Lean Six Sigma Green Belt',
        'SPC / Statistical Process Control',
        'GMP Compliance',
        'Clean Room Operations',
        'Thin Film Metrology',
        'Wafer Inspection',
        'FMEA & 8D Problem Solving'
      ];

  const fitScore = description
    ? computeFitScore(matchedSkillGroups.length, gaps.length)
    : Math.floor(Math.random() * 20) + 72; // 72–91 when no description

  const safeTitle = title || 'role';
  const safeCompany = company || 'your company';

  const dmMessage =
    `Hi [Name], I came across the ${safeTitle} role at ${safeCompany}. My background appears relevant, and I would be glad to connect if this role is still active.`;

  const emailMessage =
    `Subject: ${safeTitle} at ${safeCompany}\n\nHi [Name],\n\nI came across the ${safeTitle} role at ${safeCompany} and wanted to reach out directly. My background appears relevant to the posting, and I would be glad to share more context or connect for a brief conversation.\n\nBest,\n[Your Name]\n[LinkedIn URL] | [Phone]`;

  return {
    fitScore,
    matchedSkills,
    gaps: gaps.length > 0
      ? gaps
      : ['Python / data scripting', 'EUV lithography experience', 'Defect classification ML'],
    recruiterTitle: `Senior Technical Recruiter – Semiconductor at ${safeCompany}`,
    dmMessage,
    emailMessage,
    linkedinSearchQuery: `"${safeCompany}" recruiter semiconductor quality engineer site:linkedin.com`,
    engine: 'template'
  };
}

// Keep legacy name as alias for backward compatibility
function getMockAnalysis(title, company) {
  return getTemplateAnalysis(title, company, '');
}

// ── Claude API call ──────────────────────────────────────────────────────────
async function analyzeWithClaude({ title, company, description, url }, apiKey) {
  const userContent = `Please analyze this job posting for the candidate:

Job Title: ${title || 'Unknown'}
Company: ${company || 'Unknown'}
Job URL: ${url || ''}

Job Description:
${(description || '').slice(0, 6000)}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const json = await resp.json();
  const text = json.content?.[0]?.text || '';

  // Strip possible markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const data = JSON.parse(cleaned);
  data.engine = 'claude';
  return { success: true, data, engine: 'claude' };
}

// ── Dev server call ───────────────────────────────────────────────────────────
async function analyzeViaDevServer({ title, company, description }) {
  const resp = await fetch(`${DEV_SERVER}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, company, description })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Dev server error ${resp.status}`);
  }
  return resp.json(); // { success, data, engine }
}

// ── analyzeJob() ─────────────────────────────────────────────────────────────
async function analyzeJob({ title, company, description, url, useClaude = false }) {
  // ── Dev mode: call local server, skip Nano entirely ─────────────────────
  if (DEV_MODE) {
    try {
      const result = await analyzeViaDevServer({ title, company, description });
      if (result.success) return result;
      throw new Error(result.error || 'Dev server returned failure');
    } catch (e) {
      console.warn('PJA dev server unreachable:', e?.message);
      // Fall through to template so the extension still works if server is down
      const data = getTemplateAnalysis(title, company, description);
      return { success: true, data, engine: 'template', devServerDown: true };
    }
  }

  // ── Tier 1: Gemini Nano ─────────────────────────────────────────────────
  if (!useClaude) {
    const nanoStatus = await getNanoStatus().catch(() => 'unavailable');
    console.log('PJA Nano status:', nanoStatus);

    if (nanoIsReady(nanoStatus)) {
      try {
        const result = await analyzeWithNano({ title, company, description });
        if (result.success) {
          console.log('PJA: Nano succeeded, fitScore:', result.data?.fitScore);
          return result;
        }
      } catch (e) {
        console.warn('PJA: Nano failed:', e?.message);
        const apiKey = await getApiKey();
        const data = getTemplateAnalysis(title, company, description);
        return { success: true, data, engine: 'template', nanoFailed: true, nanoError: e?.message, offerClaude: !!apiKey };
      }
    } else {
      console.log('PJA: Nano not ready, status:', nanoStatus);
    }
  }

  // ── Tier 2: Claude — only when user opts in ─────────────────────────────
  const apiKey = await getApiKey();
  if (apiKey && useClaude) {
    try {
      return await analyzeWithClaude({ title, company, description, url }, apiKey);
    } catch (e) {
      console.warn('PJA: Claude failed:', e?.message);
      return { success: false, error: e?.message || 'Claude API failed' };
    }
  }

  // ── Tier 3: Smart Template ──────────────────────────────────────────────
  const data = getTemplateAnalysis(title, company, description);
  return { success: true, data, engine: 'template', offerClaude: !!apiKey };
}

// ── Reminder check ────────────────────────────────────────────────────────────
async function checkAndBadgeReminders() {
  const jobs = await getJobs();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const pending = jobs.filter(j =>
    j.status === 'Outreach Sent' &&
    !j.reminderDismissed &&
    j.statusUpdatedAt &&
    (now - j.statusUpdatedAt) >= sevenDays
  );

  const count = pending.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  return count;
}

// ── Alarm setup ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('reminderCheck', { periodInMinutes: 1440 });
  checkAndBadgeReminders();
});

chrome.runtime.onStartup.addListener(() => {
  checkAndBadgeReminders();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reminderCheck') checkAndBadgeReminders();
});

// ── Activate tab + window so CDP input events are delivered ────────────────
// ── CDP type-and-submit: re-type credentials via CDP insertText + click ─────
// Uses CDP Input.insertText to update React controlled inputs properly, then fires
// the button via Space key + mouse click. pjaSetNative may not update React state
// when Workday's form validation prevents the button from firing.
async function cdpTypeAndSubmit(tabId, { email, password, selector }) {
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  // Focus email field, select all, then insertText email
  const [r1] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector(
        'input[data-automation-id="email"], input[type=email], ' +
        'input[name*=email]:not([name=website]), input[id*=email]'
      );
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    }
  });
  if (r1?.result) {
    // Select all → delete → type email
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: email });
    await new Promise(r => setTimeout(r, 400));
  }

  // Focus password field, select all, then insertText password
  const [r2] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector('input[type=password]');
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    }
  });
  if (r2?.result) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: password });
    await new Promise(r => setTimeout(r, 400));
  }

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}

  // Now click the submit button (with click_filter suppression + Space + mouse)
  await cdpTrustedClick(tabId, selector || '[data-automation-id="signInSubmitButton"]');
}

async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 150));
  } catch (_) {}
}

// ── CDP trusted click (bypasses Workday's isTrusted check) ─────────────────
// Strategy: suppress click_filter via rapid interval + focus button + Space key (bypasses
// pointer hit-testing) + mouse click at coords. Dual approach maximises success rate.
async function cdpTrustedClick(tabId, selector, options = {}) {
  await activateTab(tabId);

  // Start a 20ms interval that keeps click_filter hidden, focus button, get coords.
  // Also wire up event listeners to capture whether trusted events reach the button.
  const [scriptResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const suppress = () => document.querySelectorAll('[data-automation-id="click_filter"]').forEach(el => {
        el.style.pointerEvents = 'none';
        el.style.display = 'none';
      });
      suppress();
      if (window.__pjaCFInterval) clearInterval(window.__pjaCFInterval);
      window.__pjaCFInterval = setInterval(suppress, 20);
      const btn = document.querySelector(sel);
      if (!btn) return null;
      // Capture events arriving at the button for debugging
      window.__pjaBtnEvents = [];
      ['click','mousedown','mouseup','keydown','keyup','keypress'].forEach(evt => {
        btn.addEventListener(evt, e => {
          window.__pjaBtnEvents.push({ type: evt, isTrusted: e.isTrusted, key: e.key || null });
        }, { capture: true });
      });
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      btn.focus();
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      // What element is actually at these coordinates after suppression?
      const elAtPoint = document.elementFromPoint(cx, cy);
      const cfAtPoint = document.querySelectorAll('[data-automation-id="click_filter"]');
      const debug = {
        elAtPointTag: elAtPoint?.tagName,
        elAtPointId: elAtPoint?.getAttribute('data-automation-id') || elAtPoint?.id || null,
        elIsSame: elAtPoint === btn,
        cfCount: cfAtPoint.length,
        cfVisible: Array.from(cfAtPoint).map(el => ({
          display: getComputedStyle(el).display,
          pe: getComputedStyle(el).pointerEvents,
          z: getComputedStyle(el).zIndex
        })),
        activeElId: document.activeElement?.getAttribute('data-automation-id') || document.activeElement?.tagName,
        btnRect: { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) },
        viewportW: window.innerWidth, viewportH: window.innerHeight
      };
      chrome.storage.local.set({ pja_dbg_click_prep: debug });
      return { x: cx, y: cy };
    },
    args: [selector || '[data-automation-id="signInSubmitButton"]']
  });

  const coords = scriptResult?.result;
  if (!coords) throw new Error('Button not found for selector: ' + selector);
  const xr = Math.round(coords.x), yr = Math.round(coords.y);

  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  // Strategy A: CDP Space key on focused button — keyboard events bypass click_filter entirely.
  // Prompt toggles request single=true because Space followed by a mouse click opens and then
  // immediately closes the dropdown. Submit/Next callers keep the dual strategy.
  if (!options.single) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0
    });
    await new Promise(r => setTimeout(r, 60));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0
    });
    await new Promise(r => setTimeout(r, 120));
  }

  // Strategy B: mouse click at button coords (click_filter suppressed by interval)
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: xr, y: yr, button: 'none', buttons: 0, clickCount: 0, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 40));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 80));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1, modifiers: 0
  });

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}

  // Give DOM time to process events before reading back captured data
  await new Promise(r => setTimeout(r, 300));

  // Read captured button events + clean up
  const [evtResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__pjaCFInterval) { clearInterval(window.__pjaCFInterval); window.__pjaCFInterval = null; }
      const evts = window.__pjaBtnEvents || [];
      window.__pjaBtnEvents = [];
      return evts;
    }
  });
  const captured = evtResult?.result || [];
  // Save to storage so content script (and dev) can inspect
  await chrome.storage.local.set({ pja_dbg_btnevents: captured });
}

// Surface CDP/debugger failures to pja_dbg (rolling) — attach errors were silently
// swallowed, hiding the real reason Greenhouse remix react-selects never commit
// (e.g. "Another debugger is already attached to the tab", i.e. claude-in-chrome
// contention). Distinguishes benign self-reattach from a fatal foreign attach.
async function cdpDbg(msg) {
  try {
    const d = await chrome.storage.local.get('pja_dbg');
    const a = (d.pja_dbg || []).slice(-40);
    a.push('[cdp] ' + msg);
    await chrome.storage.local.set({ pja_dbg: a });
  } catch (_) {}
}
// Attach that reports WHY it failed. "already attached" by us is benign (returns ok);
// a foreign-debugger error is fatal for trusted events → caller falls back to synthetic.
async function cdpAttachDiag(tabId, where) {
  try { await chrome.debugger.attach({ tabId }, '1.3'); return true; }
  catch (e) {
    const m = String(e && e.message || e);
    if (/already attached to (this|the) (extension|debuggee)|Another debugger.*this extension/i.test(m)) return true; // us — fine
    // An extension reload can terminate the old service-worker while its debugger session remains
    // attached briefly. The new worker sees the generic "Another debugger is already attached"
    // error. Detach succeeds only when this extension owns that orphan; if DevTools/another
    // extension owns it, detach/reattach fails and we preserve the safe synthetic fallback.
    if (/another debugger is already attached/i.test(m)) {
      try {
        await chrome.debugger.detach({ tabId });
        await new Promise(r => setTimeout(r, 80));
        await chrome.debugger.attach({ tabId }, '1.3');
        await cdpDbg(where + ' recovered orphaned debugger attachment');
        return true;
      } catch (retryErr) {
        await cdpDbg(where + ' attach-recovery-FAIL: ' + String(retryErr && retryErr.message || retryErr).slice(0, 70));
      }
    }
    await cdpDbg(where + ' attach-FAIL: ' + m.slice(0, 90));
    return false;
  }
}

// Only one debugger command sequence may own a tab at a time. Greenhouse can start several
// react-select fills close together (location, education, policy questions); without serialization
// their attach/detach cycles race and Chrome reports "Another debugger is already attached" even
// though every request came from this extension. Keep a short per-tab promise chain and recover the
// chain after failures so one rejected operation never poisons later work.
const pjaCdpTabQueues = new Map();
function pjaWithCdpTabLock(tabId, work) {
  const prior = pjaCdpTabQueues.get(tabId) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => {
    let timer;
    const bounded = new Promise((resolve, reject) => {
      // Greenhouse/SmartRecruiters option menus can take several seconds to hydrate while the
      // content script is also uploading a resume and running late required-field sweeps. If this
      // lock times out too aggressively the queued promise advances while the old debugger work is
      // still alive, and the next operation can detach it mid-send ("Debugger is not attached").
      timer = setTimeout(() => reject(new Error('cdp-tab-lock-timeout')), 30000);
      Promise.resolve().then(work).then(resolve, reject);
    });
    return bounded.finally(() => clearTimeout(timer));
  });
  pjaCdpTabQueues.set(tabId, next);
  return next.finally(() => { if (pjaCdpTabQueues.get(tabId) === next) pjaCdpTabQueues.delete(tabId); });
}

// ── CDP trusted click for LinkedIn Easy Apply step buttons ──────────────────
// LinkedIn checks event.isTrusted on Easy Apply step-advance clicks (Next/Review/
// Submit) and reloads the page on any synthetic click. A real CDP mouse click
// (isTrusted=true) advances the step. Unlike cdpTrustedClick (Workday), this sends
// ONLY a mouse click (no Space key) to avoid double-advancing, and has no click_filter
// logic. The Easy Apply modal is in regular DOM, so coordinates are directly hittable.
async function cdpLinkedInClick(tabId, x, y) {
  await activateTab(tabId);
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('no coords for LinkedIn click');
  const xr = Math.round(x), yr = Math.round(y);

  const attachedC = await cdpAttachDiag(tabId, 'click');
  if (!attachedC) throw new Error('cdp-attach-failed');
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: xr, y: yr, button: 'none', buttons: 0, clickCount: 0, modifiers: 0
    });
    await new Promise(r => setTimeout(r, 40));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1, modifiers: 0
    });
    await new Promise(r => setTimeout(r, 70));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1, modifiers: 0
    });
  } finally { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }
}

// ── CDP trusted type: click at coords to focus, then type text via real key events ──
// react-select async option lists (Greenhouse School/Discipline) only fetch options
// from genuine keystrokes; programmatic value-setting is ignored. This focuses the
// input with a trusted click, then inserts text char-by-char so the fetch fires.
async function cdpTypeAt(tabId, x, y, text) {
  await activateTab(tabId);
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('no coords for CDP type');
  const xr = Math.round(x), yr = Math.round(y);
  const attached = await cdpAttachDiag(tabId, 'typeAt');
  if (!attached) throw new Error('cdp-attach-failed'); // surfaces to caller → synthetic fallback + visible dbg
  try {
    // focus via trusted click
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(r => setTimeout(r, 120));
    // type each char as keyDown(char)+keyUp via insertText (fires real input events)
    for (const ch of String(text)) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
      await new Promise(r => setTimeout(r, 70));
    }
  } catch (e) { await cdpDbg('typeAt send-FAIL: ' + String(e && e.message || e).slice(0, 90)); throw e; }
  finally { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }
}

// ── CDP date spinner fill: types digits into Workday date spinbuttons ───────
// Workday spinbuttons require isTrusted keydown events — nativeSetter/InputEvent won't
// propagate to the form context. This uses CDP dispatchKeyEvent for each digit.
async function cdpTypeDateSpinner(tabId, { baseId, month, day, year }) {
  console.log('PJA cdpTypeDateSpinner start tabId=', tabId, 'baseId=', baseId);

  // Strategy 1: call date-picker prop directly via React fiber traversal in MAIN world.
  // Searches from multiple DOM anchors in both up (return chain) and down (child chain) directions
  // to handle different Workday tenant build structures.
  const [s1] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (month, day, year) => {
      const propNames = ['onDatePicked', 'onDateSelected', 'onDateChange', 'handleDatePicked', 'handleDateChange'];
      const startSelectors = [
        '[data-automation-id="dateInputWrapper"]',
        '[data-automation-id="formField-dateSignedOn"]',
        '[role="spinbutton"][aria-label="Month"]',
        '[role="spinbutton"][aria-label="Year"]',
      ];
      for (const sel of startSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (!fiberKey) continue;
        for (const dir of ['up', 'down']) {
          let f = el[fiberKey];
          for (let i = 0; i < 30; i++) {
            if (!f) break;
            const props = f.memoizedProps || {};
            for (const propName of propNames) {
              if (typeof props[propName] === 'function') {
                try {
                  props[propName]({ year: parseInt(year), month: parseInt(month), day: parseInt(day) });
                  return { ok: true, depth: i, dir, propName, sel };
                } catch (e) {
                  return { ok: false, reason: 'threw: ' + e.message, propName, sel };
                }
              }
            }
            f = dir === 'up' ? f.return : f.child;
          }
        }
      }
      return { ok: false, reason: 'no date prop found' };
    },
    args: [month, day, year]
  });
  console.log('PJA cdpTypeDateSpinner strategy1:', JSON.stringify(s1?.result));

  // Always log strategy 1 result so it appears in pja_dbg (not just background console)
  await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
    const arr = (d.pja_dbg || []).slice(-19);
    arr.push('[cdp] date s1=' + JSON.stringify(s1?.result || null));
    chrome.storage.local.set({ pja_dbg: arr }, r);
  }));

  // After Strategy 1 (fiber call), always run Strategy 2 to type digits directly into the
  // spinbutton inputs. onDatePicked updates React state but doesn't update the spinbutton DOM
  // values — Workday's form validator reads the spinbutton DOM and will show "Errors Found"
  // even if React state is correct. Strategy 2 types digits to make the spinbutton values visible.

  // Strategy 2: focus spinbutton via MAIN world (so React onFocus fires) + CDP key events.
  // Tries display element ID first, falls back to input element ID, then aria-label.
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  const s2Results = [];
  async function typeIntoSpinner(displayId, inputId, ariaLabel, value, isYear) {
    const [focused] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (dId, iId, aria) => {
        const el = document.getElementById(dId) || document.getElementById(iId)
          || document.querySelector('[role="spinbutton"][aria-label="' + aria + '"]');
        if (!el) return { ok: false, tried: [dId, iId, 'aria:' + aria] };
        el.focus();
        el.click();
        return { ok: true, usedId: el.id || ('aria:' + aria) };
      },
      args: [displayId, inputId, ariaLabel]
    });
    if (!focused?.result?.ok) {
      console.log('PJA no element for', displayId, '/', inputId, '/', ariaLabel);
      s2Results.push(ariaLabel + ':notFound');
      return;
    }
    s2Results.push(ariaLabel + ':ok:' + focused.result.usedId.slice(-20));
    await new Promise(r => setTimeout(r, 150));

    // Clear any placeholder/stale visible value before typing. Some Workday tenants keep
    // "MM/DD/YYYY" or a prior DOM value in the spinbutton; appending digits leaves the validator
    // on "Error-Date" even though the field looks touched.
    for (const modifiers of [2, 4]) { // Ctrl+A, then Meta+A for macOS Chrome.
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers
      });
      await new Promise(r => setTimeout(r, 40));
    }
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0
    });
    await new Promise(r => setTimeout(r, 100));

    // Workday's month/day spinbuttons can treat a leading zero as a standalone value
    // and drop the second digit (observed live: "07" became month "0"). Type natural
    // month/day digits; only the year needs four digits.
    const padded = isYear ? String(value).padStart(4, '0') : String(value);
    console.log('PJA typing padded=', padded, 'for', focused.result.usedId);
    for (const d of padded) {
      const kc = d.charCodeAt(0);
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: d, code: 'Digit' + d,
        windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 30));
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'char', key: d, text: d, unmodifiedText: d, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 30));
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: d, code: 'Digit' + d,
        windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 200));
  }

  await typeIntoSpinner(
    baseId + '-dateSectionMonth-display', baseId + '-dateSectionMonth-input', 'Month', month, false
  );
  await typeIntoSpinner(
    baseId + '-dateSectionDay-display', baseId + '-dateSectionDay-input', 'Day', day, false
  );
  await typeIntoSpinner(
    baseId + '-dateSectionYear-display', baseId + '-dateSectionYear-input', 'Year', year, true
  );

  // Tab out of the year field to trigger Workday's blur/commit handler
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 300));

  // Log strategy 2 results to pja_dbg
  await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
    const arr = (d.pja_dbg || []).slice(-19);
    arr.push('[cdp] date s2=' + s2Results.join(' '));
    chrome.storage.local.set({ pja_dbg: arr }, r);
  }));

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── CDP trusted Enter key (alternative to click for form submission) ────────
async function cdpEnterKey(tabId) {
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0
  });
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── Message handler ────────────────────────────────────────────────────────
// ── P1c CDP self-heal ladder (extension side) ──────────────────────────────
// Mirrors the unit-tested cdp-selfheal.js policy. external-apply reports each apply
// outcome; on K consecutive fill-but-no-submit-with-react-select-error (degraded CDP),
// escalate: reattach debugger → reload extension → dev-server /restart-chrome (with a
// notify + ~15s cancelable countdown). A real submit resets the ladder.
let _selfHeal = { consecutiveDegraded: 0, rungIndex: 0 };
const SELFHEAL_RUNGS = ['none', 'reattach', 'reload', 'restart'];
function _isDegraded(o) { return !!(o && o.filled && !o.submitted && o.reactSelectError); }
function _nextSelfHeal(o, threshold) {
  threshold = threshold || 2;
  if (!_isDegraded(o)) { if (o && o.submitted) _selfHeal = { consecutiveDegraded: 0, rungIndex: 0 }; return 'none'; }
  _selfHeal.consecutiveDegraded += 1;
  if (_selfHeal.consecutiveDegraded < threshold) return 'none';
  _selfHeal.rungIndex = Math.min(_selfHeal.rungIndex + 1, SELFHEAL_RUNGS.length - 1);
  return SELFHEAL_RUNGS[_selfHeal.rungIndex];
}
async function _selfHealRestart(applyUrl) {
  await chrome.storage.local.set({ pja_restart_pending: true, pja_cancel_restart: false });
  try { if (chrome.notifications) chrome.notifications.create('pja-restart', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Job Assistant: self-healing', message: 'CDP degraded — restarting Chrome in 15s to recover. Set pja_cancel_restart=true to cancel.' }); } catch (_) {}
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const d = await chrome.storage.local.get('pja_cancel_restart');
    if (d.pja_cancel_restart) { await chrome.storage.local.set({ pja_cancel_restart: false, pja_restart_pending: false }); await cdpDbg('selfheal restart CANCELED by user'); return; }
  }
  try { await fetch('http://localhost:6174/restart-chrome', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reopenUrl: applyUrl }) }); await cdpDbg('selfheal /restart-chrome sent reopen=' + (applyUrl ? 'y' : 'n')); }
  catch (e) { await cdpDbg('selfheal restart fetch-fail: ' + (e && e.message || e)); }
}
async function _selfHealAct(action, tabId, applyUrl) {
  await cdpDbg('selfheal action=' + action + ' streak=' + _selfHeal.consecutiveDegraded);
  if (action === 'reattach' && tabId != null) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} await cdpAttachDiag(tabId, 'selfheal-reattach'); }
  else if (action === 'reload') { setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 800); }  // queue resumes from currentIndex on reconnect
  else if (action === 'restart') { await _selfHealRestart(applyUrl); }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'APPLICATION_LEDGER_EVENT') {
    pjaAppendApplicationEvent(msg.event || {})
      .then(ledger => {
        sendResponse({ ok: true, events: Object.keys(ledger.events || {}).length });
        if (msg.closeTab && _sender.tab && _sender.tab.id != null) chrome.tabs.remove(_sender.tab.id).catch(() => {});
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'PJA_APPLY_OUTCOME') {
    const action = _nextSelfHeal(msg.outcome, 2);
    if (action !== 'none') _selfHealAct(action, _sender.tab && _sender.tab.id, msg.applyUrl).catch(() => {});
    sendResponse({ ok: true, action });
    return true;
  }

  if (msg.type === 'WORKDAY_TRUSTED_CLICK') {
    // Autofill can open referral, phone-code, and address prompts close together. Serialize all
    // trusted-click debugger sessions per tab so one attach/detach cycle cannot invalidate the
    // next field's click (the symptom is a valid State button reporting an open failure).
    pjaWithCdpTabLock(_sender.tab.id, () => cdpTrustedClick(_sender.tab.id, msg.selector, { single: msg.single === true }))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_ADVANCE_STEP') {
    // MAIN-world Workday step advance fallback. CDP clicks can report success while Workday's
    // React/click_filter layer still leaves the application on the same step. Running the final
    // click inside the page context gives Workday's own handlers a direct event target.
    (async () => {
      try {
        const tabId = _sender.tab.id;
        await activateTab(tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          args: [msg.selector || '', msg.label || ''],
          func: (selector, label) => {
            const visible = el => {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' &&
                getComputedStyle(el).display !== 'none';
            };
            const textOf = el => String(el?.getAttribute?.('aria-label') || el?.textContent || '').trim().replace(/\s+/g, ' ');
            const wanted = /submit/i.test(label)
              ? /submit.*application|submit.*app|apply now|^submit$/i
              : /save\s*(?:and|&)\s*continue|^continue$|^next$|next step/i;
            let el = null;
            try { if (selector) el = document.querySelector(selector); } catch (_) {}
            if (!visible(el)) {
              el = Array.from(document.querySelectorAll('[data-automation-id="click_filter"], [data-automation-id="pageFooterNextButton"], [data-automation-id="bottomNavigationNext"], [data-automation-id="bottomNavigationSubmit"], button, [role="button"]'))
                .find(node => visible(node) && wanted.test(textOf(node)));
            }
            if (!el) return { ok: false, reason: 'no_advance_control' };
            try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
            try { el.focus(); } catch (_) {}
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              try {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
              } catch (_) {}
            }
            try { el.click(); } catch (_) {}
            return { ok: true, via: el.getAttribute('data-automation-id') || el.tagName || 'element', text: textOf(el).slice(0, 80) };
          }
        });
        sendResponse(res && res.result || { ok: false, error: 'no result' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'SUCCESSFACTORS_START') {
    (async () => {
      try {
        const tabId = _sender.tab && _sender.tab.id;
        if (!tabId) throw new Error('no sender tab');
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const apply = globalThis.j2w && globalThis.j2w.Apply;
            const handler = apply && apply.handleApplyNowButton;
            const diagnostics = {
              url: location.href,
              title: document.title,
              j2wPresent: !!globalThis.j2w,
              applyPresent: !!apply,
              handlerType: typeof handler,
            };
            if (typeof handler !== 'function') return { ok: false, error: 'j2w.Apply.handleApplyNowButton is unavailable', diagnostics };
            try {
              const eventLike = { target: {}, currentTarget: {}, preventDefault() {}, stopPropagation() {} };
              const result = handler.call(apply, eventLike);
              diagnostics.invoked = true;
              diagnostics.returnType = typeof result;
              return { ok: true, diagnostics };
            } catch (e) {
              diagnostics.invoked = false;
              return { ok: false, error: String(e && (e.message || e)), diagnostics };
            }
          },
        });
        sendResponse(injected && injected[0] && injected[0].result || { ok: false, error: 'no result' });
      } catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
    })();
    return true;
  }

  if (msg.type === 'CDP_TYPE_AT') {
    pjaWithCdpTabLock(_sender.tab.id, () => cdpTypeAt(_sender.tab.id, msg.x, msg.y, msg.text))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'LINKEDIN_TRUSTED_CLICK') {
    pjaWithCdpTabLock(_sender.tab.id, () => cdpLinkedInClick(_sender.tab.id, msg.x, msg.y))
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push(new Date().toISOString().slice(11,19)+' [EA] CDP_ERROR: '+(e.message||e)); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (msg.type === 'WORKDAY_OPEN_COMBOBOX') {
    // Focus the element then send ArrowDown — standard ARIA way to open a combobox dropdown.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (sel) => {
            const el = document.querySelector(sel);
            if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
            return !!el;
          }, args: [msg.selector]
        });
        await new Promise(r => setTimeout(r, 150));
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        // ArrowDown opens the dropdown per ARIA combobox spec
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0
        });
        await new Promise(r => setTimeout(r, 60));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0
        });
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: true });
      } catch(e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_TYPEAHEAD_SELECT') {
    // Focus element, use CDP insertText to type text, wait for listbox, select first matching option.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);
        // Focus the input in MAIN world
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            return true;
          }, args: [msg.selector]
        });
        await new Promise(r => setTimeout(r, 200));
        // Clear existing value first
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 }); // Ctrl+A
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 });
        await new Promise(r => setTimeout(r, 50));
        // Insert the search text (first few chars to trigger autocomplete)
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: msg.text || 'No' });
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: true });
      } catch(e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_SET_SID') {
    // Approach: CDP Input.insertText (fires isTrusted=true beforeinput+input events).
    // Workday React ignores synthetic untrusted events. Input.insertText is the simplest
    // trusted path — no char-by-char loop, no nativeSetter side-effects.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);

        // Step 1: Focus in MAIN world + clear DOM value via nativeSetter (no event dispatch).
        // pjaFillForm may have set a DOM value via nativeInputValueSetter (without updating React state).
        // Clearing via nativeSetter WITHOUT dispatching events means React doesn't see the clear and
        // won't re-render. CDP insertText then fires trusted events → React updates state cleanly.
        const [diagRes] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false, reason: 'no-el' };
            el.focus();
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            // Clear any pre-existing DOM value without dispatching events (avoids React re-render)
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, '');
            return { ok: true, valueBeforeType: el.value };
          },
          args: [msg.selector]
        });

        const diagInfo = diagRes?.result || {};
        if (!diagInfo.ok) { sendResponse({ ok: false, reason: diagInfo.reason || 'focus-failed', ...diagInfo }); return; }

        await new Promise(r => setTimeout(r, 100));

        // Step 2: insertText via CDP (isTrusted=true) — replaces the el.select() selection.
        // Fires trusted beforeinput + input events which React processes to update state.
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        const text = msg.text || 'No';
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
        await new Promise(r => setTimeout(r, 200));
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}

        // Step 3: Check value + click listbox option if one appeared (disability combobox path)
        await new Promise(r => setTimeout(r, 500));
        const [clickRes] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (selector, sidLv) => {
            const el = document.querySelector(selector);
            const valAfter = el ? el.value : '?';
            const lb = document.querySelector('[data-automation-id="activeListContainer"]') ||
              document.querySelector('[role="listbox"]:not([hidden])') ||
              document.querySelector('[role="listbox"]');
            if (!lb) return { listbox: false, valAfter };
            const opts = Array.from(lb.querySelectorAll('[role="option"]'));
            const isNo = sidLv === 'no';
            let optMatch = opts.find(o => isNo ? /^no\b/i.test(o.textContent.trim()) : /^yes\b/i.test(o.textContent.trim()));
            if (!optMatch && isNo) optMatch = opts.find(o => /not have|do not|no.*disab/i.test(o.textContent));
            if (!optMatch && !isNo) optMatch = opts.find(o => /yes.*disab/i.test(o.textContent));
            if (!optMatch) optMatch = opts.find(o => /choose not|don.t wish|decline|prefer not/i.test(o.textContent));
            if (!optMatch) optMatch = opts[0];
            const clickTgt = optMatch ? (optMatch.querySelector('[data-automation-id="promptLeafNode"]') || optMatch) : null;
            if (clickTgt) { clickTgt.click(); return { listbox: true, lbOpts: opts.length, clicked: clickTgt.textContent.trim().slice(0,30), valAfter }; }
            return { listbox: true, lbOpts: opts.length, clicked: null, valAfter };
          },
          args: [msg.selector, text === 'Yes' ? 'yes' : 'no']
        });

        sendResponse({ ok: true, method: 'insertText', ...diagInfo, ...clickRes?.result });
      } catch(e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_TRUSTED_ENTER') {
    cdpEnterKey(_sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_TYPE_AND_SUBMIT') {
    cdpTypeAndSubmit(_sender.tab.id, msg)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_TYPE_DATE') {
    const tabId = msg.tabId || _sender.tab?.id;
    cdpTypeDateSpinner(tabId, msg)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_SUBMIT_FORM') {
    // Main-world form submit: uses nativeInputValueSetter so React/Formik state is properly updated.
    // formType: 'signin' | 'createaccount'
    (async () => {
      try {
        const tabId = _sender.tab.id;
        await activateTab(tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (email, password, formType) => {
            return new Promise(resolve => {
              const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              // Suppress click_filter overlay
              const suppress = () => document.querySelectorAll('[data-automation-id="click_filter"]').forEach(el => {
                el.style.display = 'none'; el.style.pointerEvents = 'none';
              });
              suppress();
              if (window.__pjaCFInterval3) clearInterval(window.__pjaCFInterval3);
              window.__pjaCFInterval3 = setInterval(suppress, 20);

              const findEmailEl = () => {
                const candidates = Array.from(document.querySelectorAll(
                  'input[data-automation-id="email"], input[type=email], input[autocomplete="username"], ' +
                  'input[name*="email" i], input[id*="email" i], input[aria-label*="email" i], input[placeholder*="email" i], ' +
                  'input[name*="user" i], input[id*="user" i]'
                ));
                return candidates.find(el => {
                  const type = String(el.getAttribute('type') || 'text').toLowerCase();
                  if (/password|checkbox|radio|hidden|submit|button|file/.test(type)) return false;
                  const r = el.getBoundingClientRect();
                  const isJsdom = /jsdom/i.test(String(window.navigator && window.navigator.userAgent || ''));
                  if (!isJsdom && !((el.offsetParent !== null) || r.width > 0 || r.height > 0)) return false;
                  const text = [
                    el.getAttribute('data-automation-id') || '',
                    el.getAttribute('autocomplete') || '',
                    el.getAttribute('name') || '',
                    el.id || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('placeholder') || ''
                  ].join(' ');
                  return /email|e-mail|username|user name|login/i.test(text);
                }) || null;
              };
              const emailEl = findEmailEl();
              const pwEls = Array.from(document.querySelectorAll('input[type=password]'));

              const setVal = (el, val) => {
                nativeSet.call(el, val);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };

              if (formType === 'resetpassword') {
                // Only fill both password fields — no email
                if (!pwEls[0]) { resolve({ ok: false, reason: 'no_password_field' }); return; }
                setVal(pwEls[0], password);
                if (pwEls[1]) setVal(pwEls[1], password);
              } else if (formType === 'signin_email_step') {
                // Only fill email — no password
                if (!emailEl) { resolve({ ok: false, reason: 'no_email_field' }); return; }
                setVal(emailEl, email);
              } else {
                // signin and createaccount: fill email + password
                // Two-step Workday tenants (including KLA) remove the email input after the
                // Continue step and render a password-only sign-in screen.  Email remains
                // mandatory for account creation, but an existing sign-in may legitimately
                // have only the password field.
                if (formType === 'createaccount' && !emailEl) {
                  resolve({ ok: false, reason: 'no_email_field' }); return;
                }
                if (!pwEls[0]) { resolve({ ok: false, reason: 'no_password_field' }); return; }
                if (emailEl) setVal(emailEl, email);
                setVal(pwEls[0], password);
                if (formType === 'createaccount' && pwEls[1]) setVal(pwEls[1], password);

                if (formType === 'createaccount') {
                  const cb = document.querySelector(
                    'input[type=checkbox][data-automation-id="createAccountCheckbox"], ' +
                    'input[type=checkbox][required], input[type=checkbox][id*=terms], input[type=checkbox][name*=terms]'
                  );
                  if (cb && !cb.checked) cb.click();
                }
              }

              setTimeout(() => {
                if (window.__pjaCFInterval3) { clearInterval(window.__pjaCFInterval3); window.__pjaCFInterval3 = null; }

                // Workday wraps real buttons in click_filter divs (role=button, aria-label matches action).
                // The underlying <button> has aria-hidden=true and is non-interactive.
                // We must click the click_filter, not the hidden button.
                const cfLabelPattern = formType === 'createaccount' ? /create.{0,10}account/i
                  : formType === 'resetpassword' ? /change.*password|reset.*password/i
                  : formType === 'signin_email_step' ? /continue|next/i
                  : /sign.?in/i;
                const clickFilters = document.querySelectorAll('[data-automation-id="click_filter"]');
                const cfBtn = Array.from(clickFilters).find(el =>
                  cfLabelPattern.test(el.getAttribute('aria-label') || el.innerText || '')
                );
                if (cfBtn) {
                  cfBtn.style.display = '';
                  cfBtn.style.pointerEvents = '';
                  cfBtn.click();
                  resolve({ ok: true, emailVal: emailEl?.value, pwLen: pwEls[0]?.value?.length, via: 'click_filter' });
                  return;
                }

                // Fallback: click the underlying button directly
                const btnSel = formType === 'createaccount'
                  ? '[data-automation-id="createAccountSubmitButton"], button[type=submit]'
                  : formType === 'resetpassword'
                  ? '[data-automation-id="changePasswordSubmitButton"], button[type=submit]'
                  : formType === 'signin_email_step'
                  ? '[data-automation-id="continueButton"], [data-automation-id="next"], button[type=submit]'
                  : '[data-automation-id="signInSubmitButton"], button[type=submit]';
                const btn = document.querySelector(btnSel)
                  || Array.from(document.querySelectorAll('button[type=submit], button'))
                     .find(b => formType === 'createaccount'
                       ? /create.{0,10}account|register/i.test(b.textContent)
                       : formType === 'signin_email_step'
                       ? /continue|next/i.test(b.textContent.trim())
                       : /^sign.?in$/i.test(b.textContent.trim()));
                if (!btn) { resolve({ ok: false, reason: 'no_button' }); return; }
                btn.click();
                resolve({ ok: true, emailVal: emailEl?.value, pwLen: pwEls[0]?.value?.length, via: 'btn' });
              }, 400);
            });
          },
          args: [msg.email, msg.password, msg.formType || 'signin']
        });
        sendResponse({ ok: true, result: res?.result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'ANALYZE_JOB') {
    analyzeJob({ ...msg.payload, useClaude: !!msg.useClaude }).then(sendResponse);
    return true;
  }

  if (msg.type === 'REFRESH_BADGE') {
    checkAndBadgeReminders().then(count => sendResponse({ count }));
    return true;
  }

  if (msg.type === 'SAVE_JOB') {
    getJobs().then(jobs => {
      const existing = jobs.findIndex(j => j.id === msg.payload.id);
      if (existing >= 0) {
        jobs[existing] = msg.payload;
      } else {
        jobs.unshift(msg.payload);
      }
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'UPDATE_JOB_CONTACT') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) job.contact = msg.contact;
      return setJobs(jobs);
    }).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'UPDATE_JOB_STATUS') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) {
        job.status = msg.status;
        job.statusUpdatedAt = Date.now();
        job.reminderDismissed = false;
      }
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'DELETE_JOB') {
    getJobs().then(jobs => {
      return setJobs(jobs.filter(j => j.id !== msg.jobId));
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'DISMISS_REMINDER') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) job.reminderDismissed = true;
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'GET_JOBS') {
    getJobs().then(jobs => sendResponse({ jobs }));
    return true;
  }

  if (msg.type === 'GET_PROFILE') {
    chrome.storage.local.get(['pja_profile', 'appMode'], r => {
      const defaults = {
        salutation: '', firstName: '', middleName: '',
        lastName: '', fullName: '',
        email: '', phone: '', linkedin: '', website: '',
        address: '', address2: '',
        city: '', state: '', zip: '', country: 'United States',
        currentTitle: '', currentCompany: '', yearsExperience: '', university: '', degree: '', major: '',
        graduationYear: '', salaryExpectation: '',
        workAuth: '', requireSponsorship: '', visaStatus: '',
        willingToRelocate: '', referralSource: '',
        gender: '', ethnicity: '',
        veteran: '',
        disability: ''
      };
      // Merge: stored non-empty values win; stored empty/null strings fall back
      // to the non-empty default. Also validate known enum fields — if a stored
      // value doesn't match the expected set (e.g. a UUID got saved accidentally)
      // fall back to the default rather than passing garbage to autofill.
      const YES_NO_FIELDS = new Set(['workAuth','requireSponsorship','willingToRelocate']);
      const YES_NO_VALUES = new Set(['yes','no','true','false','1','0']);
      const stored = r.pja_profile || {};
      const profile = Object.assign({}, defaults);
      for (const [k, v] of Object.entries(stored)) {
        if (v === '' || v == null) continue; // keep default
        if (YES_NO_FIELDS.has(k) && !YES_NO_VALUES.has(String(v).toLowerCase().trim())) continue; // corrupt enum value, keep default
        profile[k] = v;
      }
      sendResponse({ profile, appMode: r.appMode !== false });
    });
    return true;
  }

  if (msg.type === 'SAVE_PROFILE') {
    chrome.storage.local.set({ pja_profile: msg.profile }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'SAVE_PROFILE_FIELD') {
    chrome.storage.local.get('pja_profile', r => {
      const profile = r.pja_profile || {};
      profile[msg.key] = msg.value;
      chrome.storage.local.set({ pja_profile: profile }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'SET_APP_MODE') {
    chrome.storage.local.set({ appMode: msg.enabled }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'GET_CONTACTS') {
    chrome.storage.local.get('pja_contacts', r => sendResponse({ contacts: r.pja_contacts || [] }));
    return true;
  }

  if (msg.type === 'SAVE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = r.pja_contacts || [];
      contacts.unshift(msg.contact);
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'UPDATE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = r.pja_contacts || [];
      const idx = contacts.findIndex(c => c.id === msg.contact.id);
      if (idx >= 0) contacts[idx] = msg.contact;
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = (r.pja_contacts || []).filter(c => c.id !== msg.contactId);
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'GET_ANSWERS') {
    chrome.storage.local.get('pja_answers', r => sendResponse({ answers: r.pja_answers || {} }));
    return true;
  }

  if (msg.type === 'SAVE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      const existing = answers[msg.normalizedLabel];
      answers[msg.normalizedLabel] = {
        rawLabel: msg.rawLabel || msg.normalizedLabel,
        answer: msg.value,
        savedAt: Date.now(),
        usedCount: (existing?.usedCount || 0) + 1
      };
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      delete answers[msg.key];
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'UPDATE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      if (answers[msg.key]) answers[msg.key].answer = msg.value;
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'CLEAR_ANSWERS') {
    chrome.storage.local.remove('pja_answers', () => sendResponse({ success: true }));
    return true;
  }

  // ── External Apply ──────────────────────────────────────────────────────────
  if (msg.type === 'SET_EXT_CURRENT') {
    chrome.storage.local.set({ pja_ext_current: msg.payload }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'SET_EXT_QUEUE') {
    chrome.storage.local.set({ pja_ext_queue: msg.payload }, () => sendResponse({ ok: true }));
    return true;
  }

  // Navigate the owning tab from the service worker. Embedded ATS content scripts can be blocked
  // or silently ignored when assigning cross-origin `window.top.location`, leaving
  // pja_navigate_to unconsumed and the queue stalled between jobs.
  if (msg.type === 'OPEN_EXT_NEXT' && msg.url) {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    if (tabId != null) {
      chrome.tabs.update(tabId, { url: msg.url }, () => sendResponse({ ok: !chrome.runtime.lastError }));
    } else {
      chrome.tabs.create({ url: msg.url }, () => sendResponse({ ok: !chrome.runtime.lastError }));
    }
    return true;
  }

  if (msg.type === 'GET_EXT_QUEUE') {
    chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], r =>
      sendResponse({ queue: r.pja_ext_queue || null, current: r.pja_ext_current || null }));
    return true;
  }

  if (msg.type === 'GET_MISSING_QUESTIONS') {
    chrome.storage.local.get('pja_missing_questions', r => sendResponse({ questions: r.pja_missing_questions || {} }));
    return true;
  }

  if (msg.type === 'SAVE_MISSING_ANSWER') {
    chrome.storage.local.get(['pja_missing_questions', 'pja_answers'], r => {
      const store = r.pja_missing_questions || {};
      if (store[msg.key]) store[msg.key].answer = msg.answer;
      // Also sync into pja_answers so autofill answer bank can use it immediately
      const answers = r.pja_answers || {};
      answers[msg.key] = { rawLabel: msg.key, answer: msg.answer, savedAt: Date.now(), usedCount: 0 };
      chrome.storage.local.set({ pja_missing_questions: store, pja_answers: answers }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'CLEAR_MISSING_QUESTIONS') {
    chrome.storage.local.remove('pja_missing_questions', () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'LOG_MANUAL_OPEN') {
    chrome.storage.local.get(['pja_site_log', 'pja_custom_domains'], r => {
      const log = r.pja_site_log || [];
      const domain = msg.domain || '';
      const now = Date.now();
      const ONE_HOUR = 3600000;

      // Update site log
      const idx = log.findIndex(e => e.domain === domain);
      if (idx >= 0) {
        const entry = log[idx];
        if (now - (entry.lastSeen || 0) < ONE_HOUR) { sendResponse({ ok: true }); return; }
        entry.count = (entry.count || 1) + 1;
        entry.lastSeen = now;
        if (msg.title) entry.title = msg.title;
        entry.urls = [msg.url, ...(entry.urls || [])].slice(0, 5);
      } else {
        log.unshift({ domain, title: msg.title || domain, count: 1, firstSeen: now, lastSeen: now, urls: [msg.url] });
      }

      // Add to auto-trigger list (skip generic search/social domains)
      const SKIP = new Set(['google.com','www.google.com','bing.com','yahoo.com',
        'linkedin.com','www.linkedin.com','indeed.com','www.indeed.com',
        'glassdoor.com','www.glassdoor.com','facebook.com','twitter.com',
        'reddit.com','youtube.com','amazon.com']);
      const customs = r.pja_custom_domains || [];
      if (!SKIP.has(domain) && !customs.includes(domain)) customs.push(domain);

      chrome.storage.local.set({ pja_site_log: log.slice(0, 50), pja_custom_domains: customs },
        () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'GET_SITE_LOG') {
    chrome.storage.local.get('pja_site_log', r => sendResponse({ log: r.pja_site_log || [] }));
    return true;
  }

  if (msg.type === 'GET_CUSTOM_DOMAINS') {
    chrome.storage.local.get('pja_custom_domains', r => sendResponse({ domains: r.pja_custom_domains || [] }));
    return true;
  }

  if (msg.type === 'REMOVE_CUSTOM_DOMAIN') {
    chrome.storage.local.get('pja_custom_domains', r => {
      const domains = (r.pja_custom_domains || []).filter(d => d !== msg.domain);
      chrome.storage.local.set({ pja_custom_domains: domains }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'GET_TEMPLATES') {
    chrome.storage.local.get('pja_templates', r => sendResponse({ templates: r.pja_templates || [] }));
    return true;
  }

  if (msg.type === 'SAVE_TEMPLATE') {
    chrome.storage.local.get('pja_templates', r => {
      const templates = r.pja_templates || [];
      const idx = templates.findIndex(t => t.id === msg.template.id);
      if (idx >= 0) templates[idx] = msg.template;
      else templates.unshift(msg.template);
      chrome.storage.local.set({ pja_templates: templates }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_TEMPLATE') {
    chrome.storage.local.get('pja_templates', r => {
      const templates = (r.pja_templates || []).filter(t => t.id !== msg.templateId);
      chrome.storage.local.set({ pja_templates: templates }, () => sendResponse({ success: true }));
    });
    return true;
  }

  // ── Job shortlist / batch scoring ─────────────────────────────────────────
  if (msg.type === 'BATCH_SCORE_JOBS') {
    const jobs = msg.jobs || [];
    chrome.storage.local.get('pja_shortlist', async r => {
      const shortlist = r.pja_shortlist || [];

      // Keyword pre-filter (free — no Claude tokens)
      const SKILL_KW = ['spc','metrology','wafer','thin film','clean room','cleanroom','gmp',
        'iso 13485','fmea','lean six sigma','six sigma','photolithography','optical metrology',
        '8d','semiconductor','inspection','quality engineer','process engineer','metrology engineer',
        'manufacturing engineer','defect','fab','cvd','ald','etch','deposition','process control',
        'equipment engineer','yield','failure analysis','reliability engineer','integration engineer',
        'process integration','cmp','lithography','test engineer','quality','process'];

      const candidates = jobs.filter(j => {
        if (shortlist.some(s => s.id === j.id)) return false; // already scored
        const txt = (j.title + ' ' + j.company + ' ' + j.description).toLowerCase();
        return SKILL_KW.some(k => txt.includes(k));
      });

      if (candidates.length === 0) { sendResponse({ success: true, added: 0 }); return; }

      // Add as 'scoring' placeholders — re-read storage right before writing to catch concurrent batches.
      // Capture the actually-added jobs (fresh) so the fetch only scores those.
      let toScore = [];
      await new Promise(res => {
        chrome.storage.local.get('pja_shortlist', latest => {
          const existing = latest.pja_shortlist || [];
          const existingIds = new Set(existing.map(j => j.id));
          const fresh = candidates.filter(j => !existingIds.has(j.id))
            .map(j => ({ ...j, status: 'scoring', fitScore: null }));
          toScore = fresh; // expose to outer scope
          if (fresh.length === 0) { res(); return; }
          // Deduplicate the full list by id (last write wins) before saving
          const merged = dedupeById([...existing, ...fresh]);
          chrome.storage.local.set({ pja_shortlist: merged }, res);
        });
      });

      // If concurrent batch already added everything, nothing left to score
      if (toScore.length === 0) { sendResponse({ success: true, added: 0 }); return; }

      // COLLECT-ONLY (FAST coverage scan): placeholders are written above; skip the slow per-batch
      // scoring here. The unscored entries (fitScore:null) are scored later in one concurrent pass
      // via dev-server /score-shortlist. Returns immediately so the scan can keep paginating.
      if (msg.collectOnly) { sendResponse({ success: true, added: toScore.length, collected: true }); return; }

      // BUG5 fix: DEV_MODE guard — non-dev path uses analyzeJob (Nano/Claude/template).
      if (!DEV_MODE) {
        const results = await Promise.allSettled(toScore.map(j => analyzeJob(j)));
        chrome.storage.local.get('pja_shortlist', r2 => {
          const list = dedupeById(r2.pja_shortlist || []);
          const dataById = {};
          toScore.forEach((j, i) => {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value.success) dataById[j.id] = r.value.data;
          });
          const patched = list.map(j => {
            if (!dataById[j.id]) return j;
            const score = dataById[j.id].fitScore;
            return { ...j, fitScore: score, matchedSkills: dataById[j.id].matchedSkills || [], gaps: dataById[j.id].gaps || [], status: score >= 40 ? 'pending' : 'skipped' };
          });
          chrome.storage.local.set({ pja_shortlist: patched });
        });
        sendResponse({ success: true, added: toScore.length });
      } else {
        // DEV_MODE: batch score via dev server (10 jobs = 1 Claude call)
        try {
          const resp = await fetch(`${DEV_SERVER}/batch-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobs: toScore.map(j => ({ id: j.id, title: j.title, company: j.company, description: j.description })) })
          });
          const result = await resp.json();
          if (!result.success) throw new Error(result.error);

          // Apply scores back — only jobs scoring ≥ 40 become 'pending', rest get 'skipped'.
          // Threshold is 40 (not 50) so stretch roles like Quality Engineer (45–65 range) are kept.
          const scoreMap = {};
          (result.scores || []).forEach(s => { scoreMap[s.id] = s.score; });

          chrome.storage.local.get('pja_shortlist', r2 => {
            const list = dedupeById(r2.pja_shortlist || []);
            const patched = list.map(j => {
              if (!scoreMap.hasOwnProperty(j.id)) return j;
              const score = scoreMap[j.id];
              return { ...j, fitScore: score, status: score >= 40 ? 'pending' : 'skipped' };
            });
            chrome.storage.local.set({ pja_shortlist: patched });
          });

          sendResponse({ success: true, added: candidates.length });
        } catch (e) {
          // Dev server down — mark only the jobs we actually added (toScore) as pending.
          chrome.storage.local.get('pja_shortlist', r2 => {
            const list = r2.pja_shortlist || [];
            const toScoreIds = new Set(toScore.map(j => j.id));
            const patched = list.map(j =>
              toScoreIds.has(j.id) ? { ...j, status: 'pending', fitScore: null } : j
            );
            chrome.storage.local.set({ pja_shortlist: patched });
          });
          sendResponse({ success: true, added: toScore.length, warn: 'Dev server unreachable — scores pending' });
        }
      }
    });
    return true;
  }

  if (msg.type === 'GET_SHORTLIST') {
    chrome.storage.local.get('pja_shortlist', r => sendResponse({ jobs: r.pja_shortlist || [] }));
    return true;
  }

  // Build the apply-set from the IndexedDB corpus: fit>=threshold, not already applied, retryable.
  // Used by the dev-server /apply-run driver to know what to apply to.
  if (msg.type === 'GET_APPLY_SET') {
    pjaBuildApplySet(msg).then(sendResponse).catch(e => sendResponse({ jobs: [], error: e.message }));
    return true;
  }

  // Write an apply result back into the corpus (pja_job_state) so the pool reflects progress and
  // re-runs are idempotent. reason comes from external-apply.js recordResult.
  if (msg.type === 'UPDATE_CORPUS_STATE') {
    (async () => {
      try {
        if (!self.PJAIdb || !self.PJAApplySelect) return sendResponse({ ok: false, error: 'modules not loaded' });
        const cur = await self.PJAIdb.getJob(msg.id);
        if (!cur) return sendResponse({ ok: false, skipped: 'not in corpus' }); // non-corpus queue → no-op
        const attempts = (cur && cur.state && cur.state.attempts) || 0;
        let maxAttempts;
        if (msg.runId) {
          const d = await new Promise(r => chrome.storage.local.get('pja_ranked_apply', r));
          const ranked = d.pja_ranked_apply || null;
          if (ranked && ranked.runId === msg.runId && ranked.e2eSafe) maxAttempts = 1;
        }
        const next = self.PJAApplySelect.resultToState(msg.reason, attempts, maxAttempts);
        const patch = { status: next.status, reason: next.reason, attempts: next.attempts != null ? next.attempts : attempts };
        if (next.status === 'applied') patch.appliedAt = Date.now();
        await self.PJAIdb.updateState(msg.id, patch);
        sendResponse({ ok: true, state: patch });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  // Read the IndexedDB job corpus (source of truth) for the shortlist review page.
  if (msg.type === 'GET_JOB_CORPUS') {
    (async () => {
      try {
        if (!self.PJAIdb) return sendResponse({ count: 0, jobs: [] });
        const s = await self.PJAIdb.corpusSummary({ topN: msg.topN || 25, statusFilter: msg.statusFilter, matchThreshold: msg.matchThreshold });
        sendResponse({ count: s.count, distinctCompanies: s.distinctCompanies, modalities: s.modalities,
          statusCounts: s.statusCounts, matching: s.matching, jobs: s.top });
      } catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'REQUEST_APPLY_HELP') {
    (async () => {
      try {
        if (!DEV_MODE) return sendResponse({ success: false, error: 'dev mode disabled' });
        const payload = Object.assign({}, msg.snapshot || {});
        try {
          const tab = _sender.tab;
          if (tab && tab.windowId != null) {
            const dataUrl = await new Promise(resolve => {
              try {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 }, url => {
                  if (chrome.runtime.lastError || !url) resolve('');
                  else resolve(url);
                });
              } catch (_) { resolve(''); }
            });
            if (dataUrl) {
              payload.screenshot = {
                mime: 'image/jpeg',
                // Keep the request bounded. The dev server stores only a tiny preview marker in
                // pja_last_apply_failure; the full image is used only for the live LLM call.
                dataUrl: dataUrl.length > 600000 ? dataUrl.slice(0, 600000) : dataUrl,
                truncated: dataUrl.length > 600000,
              };
            }
          }
        } catch (_) {}
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
            const resp = await fetch(`${DEV_SERVER}/apply-help`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `Dev server ${resp.status}`);
            sendResponse(data && typeof data === 'object' ? data : { success: true, raw: data });
            return;
          } catch (e) {
            lastErr = e;
            console.warn(`PJA: apply-help attempt ${attempt + 1}/3 failed:`, e.message);
          }
        }
        sendResponse({ success: false, error: lastErr ? lastErr.message : 'apply-help failed' });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'UPDATE_SHORTLIST_JOB') {
    chrome.storage.local.get('pja_shortlist', r => {
      const list = r.pja_shortlist || [];
      const idx = list.findIndex(j => j.id === msg.job.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...msg.job };
      else list.unshift(msg.job);
      chrome.storage.local.set({ pja_shortlist: list }, () => sendResponse({ success: true }));
    });
    return true;
  }

  // OPEN_TAB — extension pages (shortlist, popup) cannot call chrome.tabs.create directly;
  // they must message the background service worker which has the tabs permission.
  // ── ANSWER_QUESTIONS: route open-ended form questions to dev server ─────────
  // Called by autofill.js when it finds required text/textarea fields with
  // labels not in the profile or answer bank.
  // msg.payload = { questions: [{label, type, maxLength, options}], jobContext: {title,company} }
  if (msg.type === 'ANSWER_QUESTIONS') {
    (async () => {
      // Read profile + high-level prefs from storage once — used by both dev-server path and API fallback
      const profile = await new Promise(resolve =>
        chrome.storage.local.get('pja_profile', r => resolve(r.pja_profile || {}))
      );
      const prefs = await new Promise(resolve =>
        chrome.storage.local.get('pja_prefs', r => resolve(r.pja_prefs || {}))
      );

      // Helper: persist AI-generated answers into pja_answers bank
      function persistAnswers(answers) {
        if (!Array.isArray(answers) || answers.length === 0) return;
        chrome.storage.local.get('pja_answers', r => {
          const bank = r.pja_answers || {};
          const now = Date.now();
          for (const { label, answer } of answers) {
            if (!label || !answer) continue;
            const norm = label
              .toLowerCase()
              .replace(/[?!.,;:'"()\[\]]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 100);
            if (!bank[norm]) {
              bank[norm] = { rawLabel: label, answer, savedAt: now, usedCount: 0, source: 'ai' };
            }
          }
          chrome.storage.local.set({ pja_answers: bank });
        });
      }

      // ── Path 1: dev server ────────────────────────────────────────────────────
      // The dev server routes to the selected local AI CLI, which can take 15-40s and
      // occasionally drops a request under load — a SINGLE failure used to fall straight
      // through to the direct-API path (whose key is often invalid → "invalid x-api-key",
      // leaving screening questions unanswered → form skipped). Retry a few times before
      // giving up, since the dev server is the reliable engine when DEV_MODE is on.
      if (DEV_MODE) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
            const resp = await fetch(`${DEV_SERVER}/answer-questions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...msg.payload, profile, prefs })
            });
            if (!resp.ok) throw new Error(`Dev server ${resp.status}`);
            const result = await resp.json();
            if (!result.success) throw new Error(result.error || 'answer-questions failed');
            persistAnswers(result.answers);
            sendResponse({ success: true, answers: result.answers });
            return;
          } catch (devErr) {
            console.warn(`PJA: Dev server answer-questions attempt ${attempt + 1}/3 failed:`, devErr.message);
            // retry; after the last attempt, preserve the selected engine boundary below
          }
        }
        // DEV_MODE is an explicit local-engine contract. Never silently switch from Codex
        // (or the selected local Claude CLI) to a direct Anthropic API call.
        sendResponse({ success: false, error: 'local AI engine unavailable after retries' });
        return;
      }

      // ── Path 2: direct Anthropic API (only when DEV_MODE is explicitly disabled) ──
      try {
        const apiKey = await getApiKey();
        if (!apiKey) {
          sendResponse({ success: false, error: 'no ai available' });
          return;
        }

        const { questions, jobContext } = msg.payload;
        const jobTitle   = jobContext?.title   || 'Unknown Role';
        const jobCompany = jobContext?.company || 'Unknown Company';

        const p = profile || {};
        const fullName    = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'the candidate';
        const currentRole = [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ') || 'not provided';
        const prevRole    = p.prevTitle && p.prevCompany
          ? `${p.prevTitle} at ${p.prevCompany}`
          : 'not provided';
        const yearsExp    = p.yearsExperience || 'not provided';
        const locationLine = [p.city, p.state, p.country].filter(Boolean).join(', ') || 'not provided';
        const visaLine    = p.visaStatus || p.visa || p.workAuth || 'not provided';
        const skillsLine  = p.skills || p.summary || 'not provided';

        const ANSWER_SYSTEM_PROMPT =
`You are filling out a job application for ${fullName}.

PROFILE:
- Current: ${currentRole}
- Previous: ${prevRole}
- Total work experience: ${yearsExp}
- Skills: ${skillsLine}
- Known gaps: ${p.honestGaps || 'not provided'}
- Visa: ${visaLine}
- Location: ${locationLine}

ANSWERING RULES:
1. Always write in first person ("I have…", "My experience includes…")
2. For "years of experience" questions: answer with the numeric value only (e.g. "6") unless it is a text field, in which case write one short sentence
3. For yes/no questions: answer with just "Yes" or "No" (with one brief reason if it is a textarea)
4. For "describe your experience" or knowledge questions: write 2–4 sentences grounded only in supplied profile/resume facts. Do NOT claim skills that are not supplied.
5. For "are you open to / willing to" questions: answer "Yes" with a brief enthusiastic line
6. For contract/temp work questions: answer "Yes, I am open to contract and contract-to-hire opportunities"
7. Keep answers proportional to maxLength — if maxLength ≤ 100, use 1–2 sentences max; if ≤ 300, use 2–3 sentences; if > 300, up to 4 sentences
8. Do NOT include filler phrases like "Great question" or "I would like to say"
9. Return ONLY valid JSON — no markdown, no extra text`;

        const questionList = questions.map((q, i) => {
          const parts = [`Q${i + 1}: "${q.label}"`];
          if ((q.type === 'select' || q.type === 'radio') && q.options?.length) {
            parts.push(`  Type: ${q.type === 'radio' ? 'radio choice' : 'dropdown'}; options: ${q.options.slice(0, 12).join(' | ')}`);
            parts.push(`  IMPORTANT: your answer must be copied exactly from one of the options above`);
          } else if (q.type === 'textarea') {
            parts.push(`  Type: long text${q.maxLength ? `; maxLength: ${q.maxLength} chars` : ''}`);
          } else {
            parts.push(`  Type: short text${q.maxLength ? `; maxLength: ${q.maxLength} chars` : ''}`);
          }
          return parts.join('\n');
        }).join('\n\n');

        const userPrompt =
`Job: ${jobTitle} at ${jobCompany}

Answer each question below for the application. Return a JSON array with one object per question:
[{"label":"<exact question label>","answer":"<your answer>"},...]

Questions:
${questionList}`;

        const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1500,
            system: ANSWER_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });

        if (!apiResp.ok) {
          const err = await apiResp.json().catch(() => ({}));
          throw new Error(err.error?.message || `API error ${apiResp.status}`);
        }

        const json = await apiResp.json();
        const raw  = json.content?.[0]?.text || '';
        const start = raw.indexOf('[');
        const end   = raw.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('No JSON array in API response');
        const answers = JSON.parse(raw.slice(start, end + 1));

        persistAnswers(answers);
        sendResponse({ success: true, answers });
      } catch (e) {
        console.warn('PJA: ANSWER_QUESTIONS API fallback failed:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: msg.url }, tab => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  // OPEN_APPLY_TAB — opens a job URL and optionally triggers autofill after load.
  // Used by the shortlist page which cannot call chrome.tabs.create directly.
  if (msg.type === 'OPEN_APPLY_TAB') {
    chrome.tabs.create({ url: msg.url }, tab => {
      if (msg.triggerAutofill) {
        // Use tabs.onUpdated instead of a fixed setTimeout so the autofill message
        // is sent only after the page has fully loaded, regardless of load time.
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.sendMessage(tab.id, { type: 'AUTOFILL_TRIGGER' }, () => {});
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      }
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  if (msg.type === 'FIND_OUTREACH_PEOPLE') {
    const job = msg.job;
    (async () => {
      try {
        if (!DEV_MODE) throw new Error('dev server disabled');
        // Generate DM + email via dev server (one Claude call)
        const resp = await fetch(`${DEV_SERVER}/outreach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: job.title, company: job.company, description: job.description, matchedSkills: job.matchedSkills })
        });
        const result = await resp.json();
        if (!result.success) throw new Error(result.error);

        // LinkedIn search URLs for recruiter + HM (no Claude needed — just construct URLs)
        const people = [
          { name: `Recruiter at ${job.company}`, title: 'Talent Acquisition / Recruiter', role: 'recruiter', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('recruiter ' + job.company)}&origin=GLOBAL_SEARCH_HEADER` },
          { name: `Hiring Manager at ${job.company}`, title: `${job.title} team lead`, role: 'hm', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('hiring manager ' + job.title + ' ' + job.company)}&origin=GLOBAL_SEARCH_HEADER` }
        ];

        sendResponse({ success: true, people, dmMessage: result.dmMessage, emailMessage: result.emailMessage });
      } catch (e) {
        // Fallback: use template analysis for messages
        const tmpl = getTemplateAnalysis(job.title, job.company, job.description);
        const people = [
          { name: `Recruiter at ${job.company}`, title: 'Talent Acquisition', role: 'recruiter', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('recruiter ' + job.company)}` },
          { name: `Hiring Manager at ${job.company}`, title: job.title + ' team', role: 'hm', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('hiring manager ' + job.company)}` }
        ];
        sendResponse({ success: true, people, dmMessage: tmpl.dmMessage, emailMessage: tmpl.emailMessage });
      }
    })();
    return true;
  }

  // ── Inject fiber-main.js on demand ────────────────────────────────────────
  // Content script calls this if data-pja-fiber-main isn't set yet (race with onUpdated).
  if (msg.type === 'INJECT_FIBER_MAIN') {
    const tabId = _sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/fiber-main.js']
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'WD_OPEN_GMAIL_TAB') {
    (async () => {
      const { pja_wd_gmail_session: existing } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (existing && Date.now() - existing.startedAt < 120000) {
        sendResponse({ ok: false, reason: 'gmail_flow_in_progress' });
        return;
      }
      const applyTabId = _sender.tab?.id;
      // Use the configured Gmail account index (u/N) so we open the right inbox
      const { pja_gmail_account_index: gmailIdx } = await new Promise(r =>
        chrome.storage.local.get('pja_gmail_account_index', r)
      );
      const acctPath = `u/${gmailIdx ?? 3}`;
      const gmailUrl = `https://mail.google.com/mail/${acctPath}/#search/${encodeURIComponent(msg.searchQuery)}`;
      console.log('PJA bg: opening Gmail', gmailUrl);
      const tab = await new Promise(r => chrome.tabs.create({ url: gmailUrl }, r));
      // Store BEFORE tab loads — top-level onUpdated listener reads this
      await new Promise(r => chrome.storage.local.set({
        pja_wd_gmail_session: {
          gmailTabId: tab.id,
          applyTabId,
          hostname: msg.hostname,
          purpose: msg.purpose,
          acctPath,
          startedAt: Date.now()
        }
      }, r));
      sendResponse({ ok: true, gmailTabId: tab.id });
    })();
    return true;
  }

  if (msg.type === 'CAPTURE_APPLY_DIAGNOSTIC') {
    (async () => {
      try {
        const snapshot = Object.assign({}, msg.snapshot || {});
        const tab = _sender.tab || null;
        let screenshot = null;
        if (tab && tab.windowId != null) {
          const dataUrl = await new Promise(resolve => {
            try {
              chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 }, url => {
                if (chrome.runtime.lastError || !url) resolve('');
                else resolve(url);
              });
            } catch (_) { resolve(''); }
          });
          if (dataUrl) {
            screenshot = {
              mime: 'image/jpeg',
              dataUrl: dataUrl.length > 650000 ? dataUrl.slice(0, 650000) : dataUrl,
              truncated: dataUrl.length > 650000,
            };
          }
        }
        const diagnostic = {
          ...snapshot,
          senderTab: tab ? { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId } : null,
          screenshot,
          capturedAt: Date.now(),
        };
        const compact = {
          reason: diagnostic.reason,
          company: diagnostic.company,
          title: diagnostic.title,
          applyUrl: diagnostic.applyUrl,
          runId: diagnostic.runId,
          phase: diagnostic.phase,
          page: diagnostic.page ? {
            url: diagnostic.page.url,
            title: diagnostic.page.title,
            successDetected: diagnostic.page.successDetected,
            errors: diagnostic.page.errors,
            controls: Array.isArray(diagnostic.page.controls) ? diagnostic.page.controls.slice(0, 20) : [],
            textTail: diagnostic.page.textTail,
          } : null,
          extra: diagnostic.extra,
          senderTab: diagnostic.senderTab,
          screenshot: screenshot ? { mime: screenshot.mime, truncated: screenshot.truncated, bytes: screenshot.dataUrl.length } : null,
          capturedAt: diagnostic.capturedAt,
        };
        const existing = await chrome.storage.local.get(['pja_post_click_diagnostics', 'pja_dbg']);
        const diagnostics = (existing.pja_post_click_diagnostics || []).slice(-4);
        diagnostics.push(compact);
        const dbg = (existing.pja_dbg || []).slice(-39);
        dbg.push('[diag] captured post-click ' + String(snapshot.reason || 'unknown') + ' screenshot=' + (screenshot ? 'yes' : 'no'));
        await chrome.storage.local.set({
          pja_last_post_click_diagnostic: diagnostic,
          pja_post_click_diagnostics: diagnostics,
          pja_dbg: dbg,
        });
        sendResponse({ ok: true, screenshot: !!screenshot, controls: compact.page?.controls?.length || 0, errors: compact.page?.errors?.length || 0 });
      } catch (e) {
        try {
          const d = await chrome.storage.local.get('pja_dbg');
          const dbg = (d.pja_dbg || []).slice(-39);
          dbg.push('[diag] post-click capture failed: ' + e.message);
          await chrome.storage.local.set({ pja_dbg: dbg });
        } catch (_) {}
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'OPEN_GMAIL_CODE_TAB') {
    (async () => {
      const { pja_email_code_session: existing } = await new Promise(r =>
        chrome.storage.local.get('pja_email_code_session', r)
      );
      const applyTabId = _sender.tab?.id;
      if (existing && Date.now() - existing.startedAt < 120000) {
        const sameApplyTab = existing.applyTabId === applyTabId;
        const sameJob = String(existing.company || '') === String(msg.company || '') &&
          String(existing.title || '') === String(msg.title || '');
        const applyTabAlive = existing.applyTabId ? await pjaRankedTabExists(existing.applyTabId) : false;
        if (sameApplyTab && sameJob && applyTabAlive) {
          sendResponse({ ok: false, reason: 'gmail_code_flow_in_progress' });
          return;
        }
        if (existing.gmailTabId) chrome.tabs.remove(existing.gmailTabId).catch(() => {});
        await chrome.storage.local.remove('pja_email_code_session');
      }
      const { pja_gmail_account_index: gmailIdx } = await new Promise(r =>
        chrome.storage.local.get('pja_gmail_account_index', r)
      );
      const acctPath = `u/${gmailIdx ?? 3}`;
      const query = String(msg.searchQuery || '(security code OR verification code OR "confirm you are human" OR "confirm your email") newer_than:30m');
      const gmailUrl = `https://mail.google.com/mail/${acctPath}/#search/${encodeURIComponent(query)}`;
      console.log('PJA bg: opening Gmail for code', gmailUrl);
      await new Promise(r => chrome.storage.local.remove(['pja_email_code_result', 'pja_navigate_to'], r));
      const existingTabs = await new Promise(r => chrome.tabs.query({ url: `https://mail.google.com/mail/${acctPath}/*` }, r));
      let tab = existingTabs && existingTabs[0];
      const reusedGmailTab = !!tab;
      if (!tab) {
        // Create a blank tab first, store the session, then navigate. If Gmail loads before the
        // session exists, the top-level onUpdated injector misses the tab and the code flow hangs.
        tab = await new Promise(r => chrome.tabs.create({ url: 'about:blank', active: true }, r));
      } else {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      }
      const session = {
        mode: 'code',
        gmailTabId: tab.id,
        applyTabId,
        hostname: msg.hostname || '',
        company: msg.company || '',
        title: msg.title || '',
        searchQuery: query,
        expectedLength: Number(msg.expectedLength || 8),
        acctPath,
        reusedGmailTab,
        startedAt: Date.now()
      };
      await new Promise(r => chrome.storage.local.set({
        pja_email_code_session: {
          ...session
        },
        pja_last_email_code_launch: {
          ...session,
          gmailUrl,
          ts: Date.now()
        }
      }, r));
      chrome.tabs.update(tab.id, { url: gmailUrl }).catch(async e => {
        await chrome.storage.local.set({
          pja_email_code_result: { success: false, reason: 'gmail_navigation_failed', ts: Date.now(),
            hostname: session.hostname, company: session.company, title: session.title }
        });
        chrome.storage.local.remove('pja_email_code_session');
        console.error('PJA bg: Gmail code navigation failed', e.message);
      });
      setTimeout(async () => {
        const d = await new Promise(r => chrome.storage.local.get('pja_email_code_session', r));
        const live = d.pja_email_code_session;
        if (!live || live.gmailTabId !== tab.id || Date.now() - live.startedAt > 90000) return;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { try { delete window.__pjaGmailVerifyRunning; } catch (_) { window.__pjaGmailVerifyRunning = false; } }
        }).catch(() => {});
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/gmail-verify.js'] })
          .catch(() => {});
      }, 8000);
      sendResponse({ ok: true, gmailTabId: tab.id });
    })();
    return true;
  }

  if (msg.type === 'CANCEL_EMAIL_CODE_SESSION') {
    (async () => {
      const { pja_email_code_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_email_code_session', r)
      );
      if (session?.gmailTabId && !session.reusedGmailTab) chrome.tabs.remove(session.gmailTabId).catch(() => {});
      await chrome.storage.local.set({
        pja_email_code_result: { success: false, reason: msg.reason || 'cancelled', ts: Date.now(),
          hostname: session?.hostname || '', company: session?.company || '', title: session?.title || '' }
      });
      chrome.storage.local.remove('pja_email_code_session');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'EMAIL_CODE_FOUND') {
    (async () => {
      const gmailTabId = _sender.tab?.id;
      const { pja_email_code_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_email_code_session', r)
      );
      if (!session) { sendResponse({ ok: false, reason: 'no_session' }); return; }
      if (session.gmailTabId !== gmailTabId) { sendResponse({ ok: false, reason: 'stale_gmail_tab' }); return; }
      const senderTab = gmailTabId ? await new Promise(r => chrome.tabs.get(gmailTabId, t => r(chrome.runtime.lastError ? null : t))) : null;
      if (!/mail\.google\.com/i.test(String(senderTab?.url || msg.pageUrl || ''))) {
        sendResponse({ ok: false, reason: 'sender_not_gmail' });
        return;
      }
      const code = String(msg.code || '').trim().toUpperCase();
      const expectedLength = Number(session.expectedLength || 8);
      const evidence = msg.evidence && typeof msg.evidence === 'object' ? msg.evidence : null;
      const verifiedEvidence = !!evidence && evidence.verified === true &&
        evidence.sourceMatched === true && evidence.securityMatched === true && evidence.dateFresh !== false;
      const compactEvidence = evidence ? {
        verified: !!evidence.verified,
        sourceMatched: !!evidence.sourceMatched,
        companyMatched: !!evidence.companyMatched,
        vendorMatched: !!evidence.vendorMatched,
        securityMatched: !!evidence.securityMatched,
        dateFresh: evidence.dateFresh,
        dateMs: evidence.dateMs || null,
        subject: String(evidence.subject || '').slice(0, 200),
        sender: String(evidence.sender || '').slice(0, 180),
        pageUrl: String(evidence.pageUrl || '').slice(0, 300),
        pageTitle: String(evidence.pageTitle || '').slice(0, 200),
        snippet: String(evidence.snippet || '').slice(0, 600),
      } : null;
      if (!/^[A-Z0-9]{6,10}$/.test(code) || (expectedLength && code.length !== expectedLength)) {
        await chrome.storage.local.set({
          pja_email_code_result: { success: false, reason: 'invalid_code_shape', ts: Date.now(),
            hostname: session.hostname, company: session.company, evidence: compactEvidence },
          pja_last_email_code_result: { success: false, reason: 'invalid_code_shape', ts: Date.now(),
            hostname: session.hostname, company: session.company, title: session.title, evidence: compactEvidence }
        });
      } else if (!verifiedEvidence) {
        const rejectResult = { success: false, reason: 'unverified_email_source', codeLength: code.length,
          ts: Date.now(), hostname: session.hostname, company: session.company, title: session.title,
          evidence: compactEvidence };
        await chrome.storage.local.set({
          pja_email_code_result: rejectResult,
          pja_last_email_code_result: rejectResult
        });
      } else {
        const successPublic = { success: true, codeLength: code.length, ts: Date.now(),
          hostname: session.hostname, company: session.company, title: session.title,
          evidence: compactEvidence };
        await chrome.storage.local.set({
          pja_email_code_result: { success: true, code, codeLength: code.length, ts: Date.now(),
            hostname: session.hostname, company: session.company, title: session.title, evidence: compactEvidence },
          pja_last_email_code_result: successPublic
        });
      }
      if (gmailTabId && !session.reusedGmailTab) chrome.tabs.remove(gmailTabId).catch(() => {});
      if (session.applyTabId) chrome.tabs.update(session.applyTabId, { active: true }).catch(() => {});
      chrome.storage.local.remove('pja_email_code_session');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'EMAIL_CODE_NOT_FOUND') {
    (async () => {
      const gmailTabId = _sender.tab?.id;
      const { pja_email_code_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_email_code_session', r)
      );
      if (!session) { sendResponse({ ok: false, reason: 'no_session' }); return; }
      if (session.gmailTabId !== gmailTabId) { sendResponse({ ok: false, reason: 'stale_gmail_tab' }); return; }
      const senderTab = gmailTabId ? await new Promise(r => chrome.tabs.get(gmailTabId, t => r(chrome.runtime.lastError ? null : t))) : null;
      if (!/mail\.google\.com/i.test(String(senderTab?.url || msg.pageUrl || ''))) {
        await chrome.storage.local.set({
          pja_last_email_code_result: { success: false, reason: 'sender_not_gmail', ts: Date.now(),
            hostname: session.hostname, company: session.company, title: session.title,
            pageUrl: msg.pageUrl || senderTab?.url || '', pageTitle: msg.pageTitle || senderTab?.title || '',
            hasSearchInput: !!msg.hasSearchInput, hash: msg.hash || '' }
        });
        sendResponse({ ok: false, reason: 'sender_not_gmail' });
        return;
      }
      const failureResult = { success: false, reason: msg.reason || 'code_not_found', ts: Date.now(),
          hostname: session.hostname, company: session.company, title: session.title,
          pageUrl: msg.pageUrl || '', pageTitle: msg.pageTitle || '', hasSearchInput: !!msg.hasSearchInput,
          hash: msg.hash || '',
          evidence: msg.evidence && typeof msg.evidence === 'object' ? {
            verified: !!msg.evidence.verified,
            sourceMatched: !!msg.evidence.sourceMatched,
            companyMatched: !!msg.evidence.companyMatched,
            vendorMatched: !!msg.evidence.vendorMatched,
            securityMatched: !!msg.evidence.securityMatched,
            dateFresh: msg.evidence.dateFresh,
            dateMs: msg.evidence.dateMs || null,
            subject: String(msg.evidence.subject || '').slice(0, 200),
            sender: String(msg.evidence.sender || '').slice(0, 180),
            pageUrl: String(msg.evidence.pageUrl || '').slice(0, 300),
            pageTitle: String(msg.evidence.pageTitle || '').slice(0, 200),
            snippet: String(msg.evidence.snippet || '').slice(0, 600),
          } : null };
      await chrome.storage.local.set({
        pja_email_code_result: failureResult,
        pja_last_email_code_result: failureResult
      });
      if (gmailTabId && !session.reusedGmailTab) chrome.tabs.remove(gmailTabId).catch(() => {});
      if (session.applyTabId) chrome.tabs.update(session.applyTabId, { active: true }).catch(() => {});
      chrome.storage.local.remove('pja_email_code_session');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'WD_GMAIL_FOUND_LINK') {
    (async () => {
      const gmailTabId = _sender.tab?.id;
      const verifyUrl = msg.verifyUrl;
      const { pja_wd_gmail_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (!session) { sendResponse({ ok: false, reason: 'no_session' }); return; }

      const verifyTab = await new Promise(r => chrome.tabs.create({ url: verifyUrl }, r));

      let verifyDone = false;
      const verifyTimeout = setTimeout(async () => {
        if (verifyDone) return;
        verifyDone = true;
        chrome.tabs.remove(verifyTab.id).catch(() => {});
        chrome.tabs.remove(gmailTabId).catch(() => {});
        await chrome.storage.local.set({
          pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'verify_tab_timeout', ts: Date.now() }
        });
        const { pja_wd_pending_apply: pending } = await new Promise(r =>
          chrome.storage.local.get('pja_wd_pending_apply', r)
        );
        if (pending?.applyUrl && session.applyTabId) {
          chrome.tabs.update(session.applyTabId, { url: pending.applyUrl }).catch(() => {});
        }
        chrome.storage.local.remove('pja_wd_gmail_session');
      }, 30000);

      const verifyListener = async (tid, changeInfo, tab) => {
        if (tid !== verifyTab.id || changeInfo.status !== 'complete') return;
        if (!tab.url) return;
        const isWorkdayDomain = /myworkdayjobs\.com|workday\.com/i.test(tab.url);
        if (!isWorkdayDomain) return;

        let pageText = '';
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: verifyTab.id },
            func: () => (document.body?.innerText || '').slice(0, 500)
          });
          pageText = res?.[0]?.result || '';
        } catch(e) {}

        // Check for expired link
        if (/link.*expired|token.*invalid|link.*no longer valid/i.test(pageText)) {
          if (verifyDone) return;
          verifyDone = true;
          clearTimeout(verifyTimeout);
          chrome.tabs.onUpdated.removeListener(verifyListener);
          chrome.tabs.remove(verifyTab.id).catch(() => {});
          chrome.tabs.remove(gmailTabId).catch(() => {});
          const { pja_workday_accounts: accounts } = await new Promise(r =>
            chrome.storage.local.get('pja_workday_accounts', r)
          );
          if (accounts?.[session.hostname]) {
            delete accounts[session.hostname];
            await chrome.storage.local.set({ pja_workday_accounts: accounts });
          }
          await chrome.storage.local.set({
            pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'link_expired', ts: Date.now() }
          });
          chrome.storage.local.remove('pja_wd_gmail_session');
          return;
        }

        // If this is a password reset form, fill it
        if (session.purpose === 'reset' &&
            /set.*new.*password|choose.*password|create.*password|new.*password/i.test(pageText)) {
          const { pja_job_password: pw } = await new Promise(r =>
            chrome.storage.local.get('pja_job_password', r)
          );
          if (pw) {
            chrome.scripting.executeScript({
              target: { tabId: verifyTab.id },
              world: 'MAIN',
              func: (password) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                const pwFields = document.querySelectorAll('input[type=password]');
                if (setter && pwFields[0]) {
                  setter.call(pwFields[0], password);
                  pwFields[0].dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
                if (setter && pwFields[1]) {
                  setter.call(pwFields[1], password);
                  pwFields[1].dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
                const btn = document.querySelector('[data-automation-id="changePasswordSubmitButton"]') ||
                  document.querySelector('button[type=submit]');
                if (btn) setTimeout(() => btn.click(), 500);
              },
              args: [pw]
            }).catch(() => {});
            return; // wait for next navigation after form submission
          }
        }

        // Success
        if (verifyDone) return;
        verifyDone = true;
        clearTimeout(verifyTimeout);
        chrome.tabs.onUpdated.removeListener(verifyListener);
        setTimeout(() => chrome.tabs.remove(verifyTab.id).catch(() => {}), 2000);
        chrome.tabs.remove(gmailTabId).catch(() => {});
        await chrome.storage.local.set({
          pja_wd_verify_result: { hostname: session.hostname, success: true, ts: Date.now() }
        });
        // Navigate apply tab back to applyUrl for a clean resume
        const { pja_wd_pending_apply: pending } = await new Promise(r =>
          chrome.storage.local.get('pja_wd_pending_apply', r)
        );
        if (pending?.applyUrl && session.applyTabId) {
          chrome.tabs.update(session.applyTabId, { url: pending.applyUrl }).catch(() => {});
        }
        chrome.storage.local.remove('pja_wd_gmail_session');
      };

      chrome.tabs.onUpdated.addListener(verifyListener);
      sendResponse({ ok: true, verifyTabId: verifyTab.id });
    })();
    return true;
  }

  if (msg.type === 'WD_GMAIL_NO_EMAIL_FOUND') {
    (async () => {
      const { pja_wd_gmail_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (!session) { sendResponse({ ok: false }); return; }
      const gmailTabId = _sender.tab?.id;
      if (gmailTabId) chrome.tabs.remove(gmailTabId).catch(() => {});
      // Persist the failure reason to pja_dbg (pja_wd_verify_result is cleared right after read).
      try {
        const { pja_dbg: dd } = await new Promise(r => chrome.storage.local.get('pja_dbg', r));
        const arr = (dd || []).slice(-40);
        arr.push('[WD] gmail-verify NO_EMAIL reason=' + (msg.reason || 'email_not_found'));
        await new Promise(r => chrome.storage.local.set({ pja_dbg: arr }, r));
      } catch (_) {}
      await chrome.storage.local.set({
        pja_wd_verify_result: {
          hostname: session.hostname, success: false,
          reason: msg.reason || 'email_not_found', ts: Date.now()
        }
      });
      chrome.storage.local.remove('pja_wd_gmail_session');
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Main-world fill bridge ─────────────────────────────────────────────────
  // Content scripts run in the isolated world and cannot call execCommand or
  // access React fiber props directly on Formik/react-select inputs.
  // This handler runs a tiny inline function in the MAIN world via scripting API
  // so it can use execCommand (has real browser focus) and access __reactFiber$.
  if (msg.type === 'pja_main_world_fill') {
    const tabId = _sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (uid, value) => {
        const el = document.querySelector('[data-pja-fiber-id="' + uid + '"]');
        if (!el) return { ok: false, reason: 'no-el' };
        el.removeAttribute('data-pja-fiber-id');

        // Try execCommand first — works in MAIN world because browser focus is real here
        try {
          el.focus();
          if (el.value) el.setSelectionRange(0, el.value.length);
          const cmdOk = document.execCommand('insertText', false, String(value));
          if (cmdOk && el.value === String(value)) {
            el.setAttribute('data-pja-fiber-done', 'ok');
            return { ok: true, method: 'execCommand' };
          }
        } catch (_) {}

        // Fiber fallback — find Formik onChange in the React tree
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (!fk) {
          // No fiber: use native setter + synthetic events
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (desc && desc.set) desc.set.call(el, value); else el.value = value;
          } catch (_) { el.value = value; }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          el.setAttribute('data-pja-fiber-done', 'ok');
          return { ok: true, method: 'native-events' };
        }

        let f = el[fk], depth = 0, named = null, first = null;
        while (f && depth < 14) {
          const mp = f.memoizedProps;
          if (mp && typeof mp.onChange === 'function') {
            if (!first) first = mp;
            if (mp.name && !named) { named = mp; break; }
          }
          f = f.return; depth++;
        }
        const target = named || first;
        if (!target) return { ok: false, reason: 'no-fiber-handler' };

        const fieldName = target.name || el.name || el.id || '';
        try {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        } catch (_) { el.value = value; }
        try {
          target.onChange({
            target: { name: fieldName, value: String(value), type: el.type || 'text', id: el.id || '' },
            currentTarget: el,
            preventDefault: () => {},
            stopPropagation: () => {}
          });
        } catch (e) { return { ok: false, reason: 'onChange-threw: ' + e.message }; }
        el.setAttribute('data-pja-fiber-done', 'ok');
        return { ok: true, method: 'fiber' };
      },
      args: [msg.uid, String(msg.value !== undefined ? msg.value : '')]
    }).then(results => {
      const r = results && results[0] && results[0].result;
      sendResponse(r || { ok: false, reason: 'no-result' });
    }).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
