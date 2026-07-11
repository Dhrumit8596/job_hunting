'use strict';
// Detect which ATS an apply/careers URL belongs to, from its host. This is what lets the
// discovery layer (keyword search across employers) route an arbitrary result into the right
// adapter/apply-channel instead of being stuck to the hand-curated slug registry.

// host substring -> ats name. Order doesn't matter; first match wins on a substring test.
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

// Returns the ats name, or '' if the host isn't a recognized ATS (e.g. a company's own careers
// page or an aggregator landing page — those fall through to the generic career-page reader).
function detectAts(url) {
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); }
  catch (_) { return ''; }
  if (!host) return '';
  for (const [needle, ats] of HOST_MAP) {
    if (host.includes(needle)) return ats;
  }
  return '';
}

// Try to extract the ATS board slug from a known ATS URL (best-effort; used by discovery to
// auto-register a source). Returns '' when it can't confidently parse one.
function detectSlug(url, ats) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return ''; }
  const parts = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (ats === 'greenhouse') {
    // job-boards.greenhouse.io/<slug>/jobs/123  OR  boards.greenhouse.io/<slug>/...
    return parts[0] || '';
  }
  if (ats === 'lever') {
    // jobs.lever.co/<slug>/<uuid>
    return parts[0] || '';
  }
  if (ats === 'ashby') {
    // jobs.ashbyhq.com/<slug>/<uuid>
    return parts[0] || '';
  }
  if (ats === 'workday') {
    // <tenant>.wdN.myworkdayjobs.com/<site> — tenant is the subdomain
    return host.split('.')[0] || '';
  }
  return '';
}

module.exports = { detectAts, detectSlug, HOST_MAP };
