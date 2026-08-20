'use strict';
// Detect which ATS an apply/careers URL belongs to, from its host. This is what lets the apply
// dispatcher (content/apply-router.js) pick the right apply strategy, and the discovery layer route
// a keyword-search result into the right adapter.
//
// UMD: require-able in Node (sourcing adapters, tests) AND usable in content scripts via
// globalThis.PJADetectAts (manifest loads this file before apply-router.js).
(function (root) {
  // host substring -> ats name. First substring match wins.
  const HOST_MAP = [
    ['greenhouse.io', 'greenhouse'],
    ['lever.co', 'lever'],
    ['ashbyhq.com', 'ashby'],
    ['myworkdayjobs.com', 'workday'],
    ['workday.com', 'workday'],
    ['smartrecruiters.com', 'smartrecruiters'],
    ['icims.com', 'icims'],
    ['taleo.net', 'taleo'],
    ['jobvite.com', 'jobvite'],
    ['bamboohr.com', 'bamboohr'],
    ['paylocity.com', 'paylocity'],
    ['rippling.com', 'rippling'],
    ['workable.com', 'workable'],
    ['breezy.hr', 'breezy'],
    ['successfactors.com', 'successfactors'],
    ['jobs.jobvite.com', 'jobvite'],
  ];

  // Returns the ats name, or '' if the host isn't a recognized ATS (company careers page / aggregator
  // landing page → the caller falls back to a DOM sniff, then the generic strategy).
  function detectAts(url) {
    let host = '';
    try { host = new URL(String(url || '')).hostname.toLowerCase(); }
    catch (_) { return ''; }
    if (!host) return '';
    for (const [needle, ats] of HOST_MAP) {
      // Host ownership is a DNS-label boundary, not a substring. Without this boundary check,
      // `greenhouse.io.attacker.example` would be misclassified as an official Greenhouse route.
      if (host === needle || host.endsWith('.' + needle)) return ats;
    }
    return '';
  }

  // Best-effort board slug from a known ATS URL (used by discovery to auto-register a source).
  function detectSlug(url, ats) {
    let u;
    try { u = new URL(String(url || '')); } catch (_) { return ''; }
    const parts = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.toLowerCase();
    if (ats === 'greenhouse' || ats === 'lever' || ats === 'ashby') return parts[0] || '';
    if (ats === 'workday') return host.split('.')[0] || '';
    return '';
  }

  const API = { detectAts, detectSlug, HOST_MAP };
  if (root) root.PJADetectAts = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
