'use strict';
// Pure filters for sourced jobs. Tunable later via the opts argument.

const { isCompatiblePostingSeniority } = require('./search-policy');

// TN-eligible titles: must read as an ENGINEER or SCIENTIST role.
// Exclude non-eligible seniorities/roles (technician/operator/associate/supervisor/
// manager/director/lead/principal-as-mgmt/intern) and clearly off-domain software/sales.
const ELIGIBLE_TITLE = /\b(engineer|engineering|scientist)\b/i;
const TITLE_EXCLUDE = /\b(technician|operator|assistant|supervisor|manager|director|intern|internship|co-?op|sales|account|recruiter|marketing|counsel|attorney|nurse|clinical research associate)\b/i;
// Off-domain engineer/scientist roles that don't fit a quality/manufacturing/equipment/metrology
// background — drop before scoring so we don't waste fit-score calls on them.
const DOMAIN_EXCLUDE = /\b(software|firmware|machine learning|\bml\b|\bai\b|artificial intelligence|data scientist|data engineer|bioinformatics|computational|cloud|devops|\bsre\b|web|frontend|front-end|backend|back-end|full.?stack|security engineer|network engineer|support engineer|service desk|research engineer|cost engineer|developer|field applications?\b|research scientist|principal scientist|staff scientist|scientist iii|computer vision|\bnlp\b|platform engineer|sales engineer|solutions engineer|applications? scientist|compiler|verification engineer|physical design|design verification|asic|\brtl\b|fpga)\b/i;

// California or US-remote.
const CA_LOC = /\b(california|\bca\b|san jose|santa clara|sunnyvale|fremont|alameda|oakland|san francisco|south san francisco|\bssf\b|menlo park|palo alto|mountain view|pleasanton|milpitas|hayward|newark|san diego|irvine|carlsbad|roseville|sacramento|livermore|union city|redwood city|foster city|san carlos|emeryville|berkeley)\b/i;
const NON_US_LOC = /\b(canada|ontario|quebec|british columbia|vancouver|toronto|montreal|mexico|europe|united kingdom|\buk\b|ireland|germany|france|italy|spain|netherlands|sweden|poland|romania|israel|india|china|taiwan|japan|korea|singapore|australia|brazil|argentina|emea|apac|latam)\b/i;
const US_LOC = /\b(united states|u\.s\.|usa|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington,? dc|phoenix|chandler|hillsboro|portland|austin|dallas|boise|albany|malta,? ny|manassas)\b/i;
const US_STATE_CODE = /(?:^|[,\s])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s|,|$)/;
const CITY_COORDS = {
  'santa clara, ca': [37.3541, -121.9552],
  'san jose, ca': [37.3382, -121.8863],
  'sunnyvale, ca': [37.3688, -122.0363],
  'mountain view, ca': [37.3861, -122.0839],
  'palo alto, ca': [37.4419, -122.1430],
  'menlo park, ca': [37.4530, -122.1817],
  'redwood city, ca': [37.4852, -122.2364],
  'san mateo, ca': [37.5630, -122.3255],
  'foster city, ca': [37.5585, -122.2711],
  'san carlos, ca': [37.5072, -122.2605],
  'milpitas, ca': [37.4323, -121.8996],
  'fremont, ca': [37.5485, -121.9886],
  'newark, ca': [37.5297, -122.0402],
  'union city, ca': [37.5934, -122.0438],
  'hayward, ca': [37.6688, -122.0808],
  'pleasanton, ca': [37.6624, -121.8747],
  'livermore, ca': [37.6819, -121.7680],
  'oakland, ca': [37.8044, -122.2712],
  'alameda, ca': [37.7652, -122.2416],
  'berkeley, ca': [37.8715, -122.2730],
  'emeryville, ca': [37.8395, -122.2892],
  'south san francisco, ca': [37.6547, -122.4077],
  'san francisco, ca': [37.7749, -122.4194],
  'cupertino, ca': [37.3230, -122.0322],
  'campbell, ca': [37.2872, -121.9500],
  'los gatos, ca': [37.2358, -121.9624],
  'saratoga, ca': [37.2638, -122.0230],
  'morgan hill, ca': [37.1305, -121.6544],
  'gilroy, ca': [37.0058, -121.5683],
  'santa cruz, ca': [36.9741, -122.0308],
  'sacramento, ca': [38.5816, -121.4944],
  'roseville, ca': [38.7521, -121.2880],
  'irvine, ca': [33.6846, -117.8265],
  'san diego, ca': [32.7157, -117.1611],
  'carlsbad, ca': [33.1581, -117.3506],
};
const ZIP_COORDS = {
  '95051': CITY_COORDS['santa clara, ca'],
};

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

// US-wide variant used when the saved profile explicitly permits relocation.
// Ambiguous or international locations fail closed instead of being assumed US.
function isEligibleUSLocation(location, remote) {
  const loc = String(location || '').trim();
  if (NON_US_LOC.test(loc)) return false;
  if (/\b(remote|work from home|wfh)\b/i.test(loc) || remote) return !NON_US_LOC.test(loc);
  return US_LOC.test(loc) || US_STATE_CODE.test(loc);
}

function normCity(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').replace(/\./g, '').trim();
}

function targetCoords(target = {}) {
  const zip = String(target.zip || '').trim();
  if (ZIP_COORDS[zip]) return ZIP_COORDS[zip];
  const city = normCity(target.city || target.label);
  const state = normCity(target.state || 'CA').toUpperCase();
  return CITY_COORDS[`${city}, ${state.toLowerCase()}`] || null;
}

function locationCoords(location) {
  const text = normCity(location);
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    const city = key.split(',')[0];
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) return coords;
  }
  return null;
}

function milesBetween(a, b) {
  if (!a || !b) return null;
  const toRad = n => n * Math.PI / 180;
  const [lat1, lon1] = a, [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isAllowedRemote(location, remote, policy) {
  if (!(/\b(remote|work from home|wfh)\b/i.test(String(location || '')) || remote)) return false;
  if (NON_US_LOC.test(String(location || ''))) return false;
  if (policy === 'no_remote') return false;
  if (policy === 'ca_remote_only') return /\b(california|\bca\b)\b/i.test(String(location || ''));
  return true;
}

function isWithinTargetRadius(location, target, radiusMiles) {
  const center = targetCoords(target);
  const point = locationCoords(location);
  const radius = Number(radiusMiles);
  if (!center || !point || !Number.isFinite(radius) || radius <= 0) return null;
  return milesBetween(center, point) <= radius;
}

function isEligibleTargetLocation(location, remote, opts = {}) {
  if (isAllowedRemote(location, remote, opts.remotePolicy)) return true;
  const within = isWithinTargetRadius(location, opts.targetLocation || {}, opts.targetRadiusMiles);
  if (within != null) return within;
  if (/^hard$/i.test(String(opts.locationStrictness || ''))) return false;
  return isEligibleLocation(location, remote);
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
  const nationwideUS = opts.nationwideUS === true;
  return jobs.filter(j => {
    if (!isEligibleTitle(j.title)) return false;
    if (opts.seniorityBand && !isCompatiblePostingSeniority(j.title, opts.seniorityBand)) return false;
    // export-control: drop on company-level blocklist OR any ITAR/EAR text in title+company+desc
    if (isExportControlledCompany(j.company)) return false;
    if (isItarExcluded([j.title, j.company, j.description].filter(Boolean).join(' '))) return false;
    if (/^hard$/i.test(String(opts.locationStrictness || '')) &&
        !isEligibleTargetLocation(j.location, j.remote, opts)) return false;
    if (nationwideUS && !isEligibleUSLocation(j.location, j.remote)) return false;
    if (!nationwideUS && caOrRemoteOnly && !isEligibleLocation(j.location, j.remote)) return false;
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

// MEDICAL-WAFER priority boost. This is a domain-specific scoring preference for profiles whose
// target background is wafer/metrology/inspection/quality/process work. Boost when the role
// is medical/medtech AND in that target domain. Smaller boost
// for medical-device quality/manufacturing generally. Caps at 100. Applied after tnAdjustScore.
const MEDICAL_RE = /\b(medical|medtech|med.?device|medical device|diagnostic|in.?vitro|ivd|biomedical|implant|surgical|orthoped|cardio|catheter|point.?of.?care|patient|fda|iso ?13485|gmp|cgmp|clinical|pharmaceutical|biotech|life science|drug delivery|combination product)\b/i;
const CORE_DOMAIN_RE = /\b(wafer|metrolog|inspection|defect|thin film|photolith|cleanroom|clean room|microfab|mems|semiconductor|yield|failure analysis|spc|process engineer|process development|process integration)\b/i;
function medicalWaferBoost(title, company, description, score) {
  if (score == null || score === '') return score;
  const s = Number(score);
  if (!Number.isFinite(s)) return score;
  const text = [title, company, description].filter(Boolean).join(' ');
  const isMedical = MEDICAL_RE.test(text);
  const isCore = CORE_DOMAIN_RE.test(String(title || '') + ' ' + String(description || ''));
  let boost = 0;
  if (isMedical && isCore) boost = 12;          // medical-device + target wafer/metrology domain
  else if (isMedical && /\b(quality|manufactur|process|equipment|reliability)\b/i.test(text)) boost = 7; // medical-device adjacent
  return Math.min(100, s + boost);
}

module.exports = { isEligibleTitle, isEligibleLocation, isEligibleUSLocation, isEligibleTargetLocation, isWithinTargetRadius, isItarExcluded, isExportControlledCompany, filterJobs, tnAdjustScore, medicalWaferBoost, MEDICAL_RE, CORE_DOMAIN_RE, ELIGIBLE_TITLE, TITLE_EXCLUDE, COMPANY_EXPORT_BLOCK };
