'use strict';
// Phase D (APPLY_ENGINE_PLAN.md): generalize the Workday account-creation pattern to ALL strategies,
// plus same-origin iframe traversal for the hard ATSes (iCIMS/Taleo/SuccessFactors/Jobvite embed
// their form in an iframe). PURE + UMD (window.PJAAccount); the execution reuses workday-auth.js's
// proven runCreateAccount/runGmailVerify machinery, this module just plans + supports.
(function (root) {
  let DA = (root && root.PJADetectAts) || null;
  if (!DA && typeof require !== 'undefined') { try { DA = require('../sourcing/detect-ats'); } catch (_) {} }
  const detectAts = (DA && DA.detectAts) || (() => '');
  const detectSlug = (DA && DA.detectSlug) || (() => '');

  // Per-tenant identifier — used for the plus-address alias AND the per-tenant account key so each
  // ATS tenant gets its own fresh account (mirrors pja_workday_accounts[hostname]).
  function tenantFromUrl(url) {
    const ats = detectAts(url);
    const slug = detectSlug(url, ats);
    if (slug) return slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
    try {
      const host = new URL(String(url || '')).hostname.toLowerCase();
      const label = host.split('.')[0];
      const pick = (label && label !== 'www' && label !== 'jobs' && label !== 'careers') ? label : host;
      return pick.replace(/[^a-z0-9]+/g, '').slice(0, 24);
    } catch (_) { return ''; }
  }

  // Plus-addressed email: applicant@gmail.com + acme  → applicant+acme@gmail.com.
  // This is the trick that gets a FRESH per-tenant account (often auto-signin, no verification).
  function accountEmail(baseEmail, url) {
    const base = String(baseEmail || '').trim();
    const at = base.indexOf('@');
    if (at < 1) return base;
    const tenant = tenantFromUrl(url);
    if (!tenant) return base;
    let local = base.slice(0, at);
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus); // strip any existing +alias
    return local + '+' + tenant + base.slice(at);
  }

  // Decide the account approach for a job. ctx = { baseEmail, hasPassword }.
  //  - strategy that doesn't need an account → just proceed.
  //  - needs an account + we have a stored password → create/sign-in with plus-addressed email.
  //  - needs an account but NO stored password → cannot proceed autonomously → defer needs_login
  //    (never generate/guess a password — safety boundary).
  function accountPlan(strategy, ctx, url) {
    const s = strategy || {};
    const c = ctx || {};
    if (!s.needsAccount) return { needsAccount: false, canProceed: true };
    if (!c.hasPassword) return { needsAccount: true, canProceed: false, blockedReason: 'needs_login' };
    return {
      needsAccount: true, canProceed: true,
      email: accountEmail(c.baseEmail, url),
      tenant: tenantFromUrl(url),
      usePassword: true, verifyVia: 'gmail',
    };
  }

  // Collect this document + all SAME-ORIGIN iframe documents (best-effort; cross-origin frames throw
  // on contentDocument access and are skipped → those become needs_manual). Used to widen field
  // discovery + resume upload into iframe-embedded ATS forms. Depth-limited to avoid cycles.
  function collectFrameDocs(rootDoc, maxDepth) {
    const depthCap = maxDepth != null ? maxDepth : 3;
    const out = [];
    const seen = new Set();
    function walk(doc, depth) {
      if (!doc || depth > depthCap || seen.has(doc)) return;
      seen.add(doc); out.push(doc);
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (_) { return; }
      for (const f of frames) {
        let sub = null;
        try { sub = f.contentDocument; } catch (_) { sub = null; } // cross-origin → null, skipped
        if (sub) walk(sub, depth + 1);
      }
    }
    walk(rootDoc, 0);
    return out;
  }

  // Per-ATS submit-confirmation phrases (augment the generic PJA_SUBMIT_SUCCESS_RE so single-page
  // ATSes aren't misread as submit_unclear). Generic phrases first, then ATS-specific.
  const GENERIC_SUCCESS = /(thank you for (your )?appl|application (submitted|received|complete|sent)|successfully applied|we('| ha)?ve received your application|your application has been)/i;
  const ATS_SUCCESS = {
    workable:  /(application (received|submitted)|thanks for applying)/i,
    breezy:    /(application (received|submitted)|thank you for your interest)/i,
    bamboohr:  /(application (received|submitted)|thank you for applying)/i,
    lever:     /(thank you|application submitted)/i,
    ashby:     /(application submitted|thanks for applying)/i,
    icims:     /(thank you for (your interest|applying)|application (submitted|received)|congratulations)/i,
    taleo:     /(submission (complete|successful)|thank you for)/i,
  };
  function matchesSuccess(text, ats) {
    const s = String(text || '');
    if (GENERIC_SUCCESS.test(s)) return true;
    const re = ATS_SUCCESS[String(ats || '').toLowerCase()];
    return re ? re.test(s) : false;
  }

  const API = { tenantFromUrl, accountEmail, accountPlan, collectFrameDocs, matchesSuccess, GENERIC_SUCCESS };
  if (root) root.PJAAccount = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
