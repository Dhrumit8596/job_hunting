'use strict';
// Apply dispatcher (Phase A of APPLY_ENGINE_PLAN.md).
//
// The explicit "identify portal → pick the matching apply strategy" step. Today routing is emergent
// (whichever content script's host-guard fires handles the page); this makes the decision explicit,
// logged, and unit-testable. detectAts(url) + a DOM sniff → one strategy from the registry.
//
// Phase A is SELECTION ONLY (no behavior change): it does not yet drive the apply — external-apply.js
// still runs as before. Later phases route through registry[strategy].engine. UMD so it is testable
// in Node and available in content scripts as window.pjaIdentifyPortal / window.pjaPickApplyStrategy.
(function (root) {
  // Resolve detectAts from the global (content script; detect-ats.js loads first) or require (Node).
  let PJADetectAts = (root && root.PJADetectAts) || null;
  if (!PJADetectAts && typeof require !== 'undefined') { try { PJADetectAts = require('../sourcing/detect-ats'); } catch (_) {} }
  const detectAts = (PJADetectAts && PJADetectAts.detectAts) || (() => '');

  // Strategy registry. `engine` = which apply mechanism handles it (existing today, or built in later
  // phases). tier reflects current coverage (see APPLY_ENGINE_PLAN.md §2.3). needsAccount/multiStep/
  // iframe drive prepare() and the hardening work in Phase D.
  const STRATEGIES = {
    workday:        { ats: 'workday',        engine: 'workday',   tier: 'deep',        needsAccount: true,  multiStep: true,  iframe: false },
    greenhouse:     { ats: 'greenhouse',     engine: 'greenhouse', tier: 'deep',       needsAccount: false, multiStep: false, iframe: false },
    lever:          { ats: 'lever',          engine: 'generic',   tier: 'partial',     needsAccount: false, multiStep: false, iframe: false },
    ashby:          { ats: 'ashby',          engine: 'generic',   tier: 'partial',     needsAccount: false, multiStep: false, iframe: false },
    smartrecruiters:{ ats: 'smartrecruiters',engine: 'generic',   tier: 'partial',     needsAccount: false, multiStep: false, iframe: false },
    icims:          { ats: 'icims',          engine: 'generic',   tier: 'hard',        needsAccount: true,  multiStep: true,  iframe: true  },
    taleo:          { ats: 'taleo',          engine: 'generic',   tier: 'hard',        needsAccount: true,  multiStep: true,  iframe: true  },
    successfactors: { ats: 'successfactors', engine: 'generic',   tier: 'hard',        needsAccount: true,  multiStep: true,  iframe: false },
    jobvite:        { ats: 'jobvite',        engine: 'generic',   tier: 'mixed',       needsAccount: false, multiStep: false, iframe: true  },
    workable:       { ats: 'workable',       engine: 'generic',   tier: 'single-page', needsAccount: false, multiStep: false, iframe: false },
    breezy:         { ats: 'breezy',         engine: 'generic',   tier: 'single-page', needsAccount: false, multiStep: false, iframe: false },
    bamboohr:       { ats: 'bamboohr',       engine: 'generic',   tier: 'single-page', needsAccount: false, multiStep: false, iframe: false },
    paylocity:      { ats: 'paylocity',      engine: 'generic',   tier: 'single-page', needsAccount: false, multiStep: false, iframe: false },
    rippling:       { ats: 'rippling',       engine: 'generic',   tier: 'single-page', needsAccount: false, multiStep: false, iframe: false },
    indeed:         { ats: 'indeed',         engine: 'indeed',    tier: 'partial',     needsAccount: false, multiStep: true,  iframe: false },
    linkedin_ea:    { ats: 'linkedin',       engine: 'linkedin_ea', tier: 'partial',   needsAccount: false, multiStep: true,  iframe: false },
    generic:        { ats: '',               engine: 'generic',   tier: 'unknown',     needsAccount: false, multiStep: false, iframe: false },
    unsupported:    { ats: '',               engine: 'unsupported', tier: 'none',      needsAccount: false, multiStep: false, iframe: false },
  };

  // Read DOM signals used when the host isn't a recognized ATS (company careers page that embeds or
  // redirects into an ATS). Pure w.r.t. the passed document; safe to stub in tests.
  function readSignals(doc) {
    const q = (sel) => { try { return !!(doc && doc.querySelector(sel)); } catch (_) { return false; } };
    let host = '';
    try { host = (doc && doc.location && doc.location.hostname || '').toLowerCase(); } catch (_) {}
    return {
      host,
      hasWorkday:        q('[data-automation-id]'),
      hasGreenhouseForm: q('#application-form, #application_form, .application--form, [action*="greenhouse"]'),
      hasLever:          q('.application-form, .application-question, [class*="lever"]'),
      hasReactSelect:    q('[class*="select__control"], [class*="react-select"], [class*="_reactSelect"]'),
      hasIframe:         q('iframe[src]'),
      hasFileInput:      q('input[type="file"]'),
      hasForm:           q('form'),
    };
  }

  // Pure decision: host-detected ATS wins; else DOM sniff; else generic (if a form is present) or
  // unsupported. Returns { name, ...strategy, source }.
  function pickStrategy(url, signals) {
    const s = signals || {};
    const byHost = detectAts(url);
    if (byHost && STRATEGIES[byHost]) return Object.assign({ name: byHost, source: 'host' }, STRATEGIES[byHost]);
    // Host not a known ATS → sniff the DOM.
    let name = '';
    if (s.hasWorkday) name = 'workday';
    else if (s.hasGreenhouseForm) name = 'greenhouse';
    else if (s.hasLever) name = 'lever';
    else if (s.hasReactSelect || s.hasFileInput || s.hasForm) name = 'generic';
    if (name) return Object.assign({ name, source: 'dom' }, STRATEGIES[name]);
    return Object.assign({ name: 'unsupported', source: 'none' }, STRATEGIES.unsupported);
  }

  // Live entry: identify the portal for the current page. Logs to pja_dbg for diagnostics.
  function identifyPortal() {
    const url = (root && root.location && root.location.href) || '';
    const doc = (root && root.document) || null;
    const strat = pickStrategy(url, readSignals(doc));
    try {
      if (root.chrome && root.chrome.storage && root.chrome.storage.local) {
        root.chrome.storage.local.get('pja_dbg', d => {
          const a = (d.pja_dbg || []).slice(-40);
          a.push(new Date().toISOString().slice(11, 19) + ' [APPLY-ROUTER] ' + strat.name + ' (via ' + strat.source + ', engine=' + strat.engine + ') ' + (root.location ? root.location.hostname : ''));
          root.chrome.storage.local.set({ pja_dbg: a });
        });
      }
    } catch (_) {}
    return strat;
  }

  const API = { STRATEGIES, readSignals, pickStrategy, identifyPortal };
  if (root) {
    root.PJA_APPLY_STRATEGIES = STRATEGIES;
    root.pjaPickApplyStrategy = pickStrategy;
    root.pjaReadApplySignals = readSignals;
    root.pjaIdentifyPortal = identifyPortal;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
