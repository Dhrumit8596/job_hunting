'use strict';
// Phase B core (APPLY_ENGINE_PLAN.md): pure selection + result-mapping for the corpus→apply driver.
// No I/O — the extension/dev-server supply the corpus + applied set and persist the outputs. Kept
// pure so the "what do we apply, and what does each outcome mean" logic is unit-tested without a browser.
//
// UMD: require in Node (dev-server, tests) + globalThis.PJAApplySelect in the service worker.
(function (root) {
  let DA = (root && root.PJADetectAts) || null;
  if (!DA && typeof require !== 'undefined') { try { DA = require('./detect-ats'); } catch (_) {} }
  const detectAts = (DA && DA.detectAts) || (() => '');

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function roleKey(j) { return norm(j && j.company) + '::' + norm(j && j.title); }

  // Build the ordered apply set from the corpus.
  //   corpus: { index:{id:posting}, state:{id:{fitScore,status,attempts}} }
  //   opts: { threshold=70, appliedRoleKeys=[], dailyCap=30, maxAttempts=3, retryDeferred=true }
  // A job is eligible when fit>=threshold, not already applied, not dead, and either fresh ('sourced')
  // or a deferred (needs_manual/needs_login) job we're retrying and still under maxAttempts.
  // Returns jobs sorted by fitScore desc, capped to dailyCap, each stamped with its strategy (ATS).
  function buildApplySet(corpus, opts = {}) {
    const threshold = opts.threshold != null ? opts.threshold : 70;
    const dailyCap = opts.dailyCap != null ? opts.dailyCap : 30;
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 3;
    const retryDeferred = opts.retryDeferred !== false;
    // Optional allow-list of ATS strategies (e.g. no-account ATSes for a supervised trial). When set,
    // only jobs whose detected strategy is in the list are eligible — a hard guarantee the run can't
    // touch an account-creation ATS.
    const atsAllow = opts.atsAllow && opts.atsAllow.length ? new Set(opts.atsAllow.map(x => String(x).toLowerCase())) : null;
    const applied = opts.appliedRoleKeys instanceof Set ? opts.appliedRoleKeys : new Set(opts.appliedRoleKeys || []);
    const index = (corpus && corpus.index) || {};
    const state = (corpus && corpus.state) || {};

    const out = [];
    for (const id of Object.keys(index)) {
      const p = index[id];
      const st = state[id] || { status: 'sourced', fitScore: null, attempts: 0 };
      const fit = st.fitScore;
      if (fit == null || Number(fit) < threshold) continue;         // below the match bar
      if (applied.has(roleKey(p))) continue;                         // already applied (durable log)
      const status = st.status || 'sourced';
      if (status === 'applied' || status === 'dead') continue;       // done / dead posting
      const deferred = status === 'needs_manual' || status === 'needs_login';
      if (deferred && (!retryDeferred || (st.attempts || 0) >= maxAttempts)) continue;
      if (!deferred && status !== 'sourced') continue;               // in-flight/unknown → skip
      if (!p.applyUrl) continue;                                     // nothing to open
      const strategy = detectAts(p.applyUrl) || p.detectedAts || p.ats || '';
      if (atsAllow && !atsAllow.has(String(strategy).toLowerCase())) continue; // outside the allow-list
      out.push({
        id, applyUrl: p.applyUrl, company: p.company, title: p.title, location: p.location,
        ats: p.ats || '', fitScore: Number(fit), attempts: st.attempts || 0, strategy,
      });
    }
    out.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    return dailyCap > 0 ? out.slice(0, dailyCap) : out;
  }

  // Persistent per-job budget: the setTimeout watchdog is reset by page reloads, so a job that
  // reload-loops (e.g. a required react-select that never commits) never hits it and blocks the whole
  // batch. external-apply tracks {firstSeen, loads} per job in storage (survives reloads) and calls
  // this each time the apply page loads; when the wall-clock budget or reload count is exceeded, the
  // job is deferred to needs_manual and the queue advances. Pure so it's unit-tested.
  function exceededBudget(entry, now, opts = {}) {
    if (!entry) return false;
    const budgetMs = opts.budgetMs != null ? opts.budgetMs : 240000; // 4 min wall-clock across reloads
    const maxLoads = opts.maxLoads != null ? opts.maxLoads : 4;
    return (now - (entry.firstSeen || now)) > budgetMs || (entry.loads || 0) > maxLoads;
  }

  // Result reason (from external-apply.js recordResult) → next corpus state.
  const APPLIED = new Set(['applied']);
  const DEAD = new Set(['posting_not_found']);
  const NEEDS_LOGIN = new Set(['needs_login', 'google_sso_only', 'workday_account_locked']);
  // Blocked by something a human must clear (never auto-solved) — defer immediately, don't retry-spin.
  // stuck_budget = exceeded the cross-reload wall-clock/load budget (unbounded stall) → defer.
  const NEEDS_MANUAL = new Set(['workday_captcha', 'captcha', 'chatbot_apply_manual', 'ready_to_submit_review', 'stuck_budget']);

  // Everything else (missing_required, submit_unclear, no_submit_btn, apply_btn_no_form,
  // watchdog_timeout, no_apply_btn_on_description, no_submit_after_spa, workday_auth_*) is TRANSIENT:
  // retry until maxAttempts, then defer to needs_manual.
  function resultToState(reason, attempts, maxAttempts = 3) {
    const r = String(reason || '');
    if (APPLIED.has(r)) return { status: 'applied', reason: r };
    if (DEAD.has(r)) return { status: 'dead', reason: r };
    if (NEEDS_LOGIN.has(r)) return { status: 'needs_login', reason: r, attempts: (attempts || 0) + 1 };
    if (NEEDS_MANUAL.has(r)) return { status: 'needs_manual', reason: r, attempts: (attempts || 0) + 1 };
    const n = (attempts || 0) + 1;
    if (n >= maxAttempts) return { status: 'needs_manual', reason: r, attempts: n };
    return { status: 'sourced', reason: r, attempts: n, retry: true }; // stays eligible next run
  }

  // Post-run summary over the corpus state: is the pool "cleared" (no fit>=threshold job still sourced)?
  function poolStatus(corpus, opts = {}) {
    const threshold = opts.threshold != null ? opts.threshold : 70;
    const index = (corpus && corpus.index) || {};
    const state = (corpus && corpus.state) || {};
    const counts = { applied: 0, needs_manual: 0, needs_login: 0, dead: 0, sourced_unresolved: 0, below_threshold: 0 };
    for (const id of Object.keys(index)) {
      const st = state[id] || { status: 'sourced', fitScore: null };
      if (st.fitScore == null || Number(st.fitScore) < threshold) { counts.below_threshold++; continue; }
      const s = st.status || 'sourced';
      if (s === 'applied') counts.applied++;
      else if (s === 'needs_manual') counts.needs_manual++;
      else if (s === 'needs_login') counts.needs_login++;
      else if (s === 'dead') counts.dead++;
      else counts.sourced_unresolved++;
    }
    counts.cleared = counts.sourced_unresolved === 0;   // every match resolved to a terminal/deferred state
    return counts;
  }

  const API = { buildApplySet, resultToState, poolStatus, roleKey, exceededBudget };
  if (root) root.PJAApplySelect = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
