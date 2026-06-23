'use strict';
// Pure filters for sourced jobs. Tunable later via the opts argument.

// TN-eligible titles: must read as an ENGINEER or SCIENTIST role.
// Exclude non-eligible seniorities/roles (technician/operator/associate/supervisor/
// manager/director/lead/principal-as-mgmt/intern) and clearly off-domain software/sales.
const ELIGIBLE_TITLE = /\b(engineer|engineering|scientist)\b/i;
const TITLE_EXCLUDE = /\b(technician|operator|associate|assistant|supervisor|manager|director|\blead\b|intern|internship|co-?op|sales|account|recruiter|marketing|counsel|attorney|nurse|clinical research associate)\b/i;
// Off-domain engineer/scientist roles that don't fit a quality/manufacturing/equipment/metrology
// background — drop before scoring so we don't waste fit-score calls on them.
const DOMAIN_EXCLUDE = /\b(software|firmware|machine learning|\bml\b|data scientist|data engineer|bioinformatics|computational|cloud|devops|\bsre\b|web|frontend|front-end|backend|back-end|full.?stack|security engineer|network engineer|field applications?\b|research scientist|principal scientist|staff scientist|scientist iii|computer vision|\bnlp\b|platform engineer|sales engineer|solutions engineer|applications? scientist|compiler|verification engineer|physical design|design verification|asic|\brtl\b|fpga)\b/i;

// California or US-remote.
const CA_LOC = /\b(california|\bca\b|san jose|santa clara|sunnyvale|fremont|alameda|oakland|san francisco|south san francisco|\bssf\b|menlo park|palo alto|mountain view|pleasanton|milpitas|hayward|newark|san diego|irvine|carlsbad|roseville|sacramento|livermore|union city|redwood city|foster city|san carlos|emeryville|berkeley)\b/i;

// Export-control / defense roles that block a TN (non-US-person) candidate.
const ITAR_EXCLUDE = /\b(itar|ear|export control|export-control|us person|u\.s\. person|us citizen(ship)? required|security clearance|secret clearance|defense|aerospace & defense|dod\b|missile|munition|weapon)\b/i;

// Company-level export-control / US-person-only blocklist. Some employers are export-controlled
// at the COMPANY level (defense/aerospace/space/nuclear primes + specific EAR-restricted firms),
// so a TN / non-US-person candidate is ineligible regardless of what the individual posting says
// — the ITAR_EXCLUDE text regex misses these when the JD doesn't spell it out (e.g. Cerebras,
// Oklo). Matched as a substring of the company name. Tunable — add names as we find them.
const COMPANY_EXPORT_BLOCK = [
  // named EAR / export-control firms ("Cerebras/Oklo type" — AI accelerators + nuclear + space)
  'cerebras', 'oklo', 'sambanova', 'lightmatter', 'groq', 'astranis', 'rivos', 'skyryse',
  // defense / defense-tech primes (US-person required)
  'anduril', 'palantir', 'raytheon', 'rtx', 'lockheed', 'northrop', 'boeing',
  'general dynamics', 'l3harris', 'l3 harris', 'bae systems', 'sierra nevada',
  'leidos', 'saic', 'draper', 'mitre', 'aerospace corporation', 'shield ai',
  'epirus', 'hawkeye 360', 'saronic', 'true anomaly',
  // space / launch (ITAR)
  'spacex', 'blue origin', 'relativity space', 'rocket lab', 'firefly aerospace',
  'ursa major', 'stoke space', 'varda', 'astra space', 'k2 space', 'apex space',
  // nuclear / fusion (export-controlled, commonly US-person)
  'kairos power', 'commonwealth fusion', 'helion energy', 'x-energy', 'terrapower', 'radiant nuclear',
];

function isEligibleTitle(title) {
  const t = String(title || '');
  return ELIGIBLE_TITLE.test(t) && !TITLE_EXCLUDE.test(t) && !DOMAIN_EXCLUDE.test(t);
}

// location string + remote flag. CA OR US-remote passes.
function isEligibleLocation(location, remote) {
  const loc = String(location || '');
  if (/\b(remote)\b/i.test(loc) || remote) {
    // US-remote only — drop explicitly non-US remote.
    if (/\b(emea|apac|apj|europe|united kingdom|\buk\b|india|canada|germany|france|italy|spain|china|japan|singapore|australia|brazil|mexico|latam)\b/i.test(loc)) return false;
    return true;
  }
  return CA_LOC.test(loc);
}

function isItarExcluded(text) {
  return ITAR_EXCLUDE.test(String(text || ''));
}

function isExportControlledCompany(company) {
  const c = String(company || '').toLowerCase();
  return COMPANY_EXPORT_BLOCK.some(name => c.includes(name));
}

// Apply all filters. opts: { caOrRemoteOnly=true }
function filterJobs(jobs, opts = {}) {
  const caOrRemoteOnly = opts.caOrRemoteOnly !== false;
  return jobs.filter(j => {
    if (!isEligibleTitle(j.title)) return false;
    // export-control: drop on company-level blocklist OR any ITAR/EAR text in title+company+desc
    if (isExportControlledCompany(j.company)) return false;
    if (isItarExcluded([j.title, j.company, j.description].filter(Boolean).join(' '))) return false;
    if (caOrRemoteOnly && !isEligibleLocation(j.location, j.remote)) return false;
    return true;
  });
}

// TN-title grading: cap the fit score for senior/gray-TN titles that are a stretch for an
// early-career candidate. "Principal/Distinguished/Fellow" are gray for TN and unlikely fits;
// "Staff" is a stretch. Returns the adjusted score.
function tnAdjustScore(title, score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return score;
  const t = String(title || '');
  if (/\b(distinguished|fellow|principal)\b/i.test(t)) return Math.min(s, 55);
  if (/\bstaff\b/i.test(t)) return Math.min(s, 65);
  return s;
}

module.exports = { isEligibleTitle, isEligibleLocation, isItarExcluded, isExportControlledCompany, filterJobs, tnAdjustScore, ELIGIBLE_TITLE, TITLE_EXCLUDE, COMPANY_EXPORT_BLOCK };
