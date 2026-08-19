'use strict';

// Pure, profile-driven search expansion. This module never invents candidate skills: callers pass
// saved target titles plus an audited adjacent-title allow-list. It only adds a seniority modifier
// that is compatible with configured years of experience.

const SENIORITY_BANDS = new Set(['entry', 'early_mid', 'mid_senior', 'senior']);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function unique(values) {
  const seen = new Set(), out = [];
  for (const value of values || []) {
    const query = clean(value), key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key); out.push(query);
  }
  return out;
}

function inferCandidateSeniority(profile = {}, prefs = {}) {
  const explicit = clean(prefs.searchSeniority).toLowerCase();
  if (SENIORITY_BANDS.has(explicit)) return explicit;
  const years = Number.parseFloat(String(profile.yearsExperience || '').replace(/[^0-9.]+/g, ''));
  if (!Number.isFinite(years)) return 'early_mid';
  if (years < 3) return 'entry';
  if (years <= 5) return 'early_mid';
  if (years <= 8) return 'mid_senior';
  return 'senior';
}

function postingSeniority(title) {
  const value = clean(title).toLowerCase();
  if (/\b(director|vice president|vp|head of|chief)\b/.test(value)) return 'leadership';
  if (/\b(principal|staff|distinguished|fellow|lead|architect)\b/.test(value)) return 'staff_plus';
  if (/\b(senior|sr\.?|engineer iii|engineer 3|engineer iv|engineer 4)\b/.test(value)) return 'senior';
  if (/\b(junior|jr\.?|associate|entry|engineer i|engineer 1|engineer ii|engineer 2)\b/.test(value)) return 'early_career';
  return 'unspecified_mid';
}

function isCompatiblePostingSeniority(title, band) {
  const level = postingSeniority(title);
  const target = SENIORITY_BANDS.has(band) ? band : 'early_mid';
  if (level === 'leadership') return false;
  if (target === 'entry') return level !== 'staff_plus' && level !== 'senior';
  if (target === 'early_mid') return level !== 'staff_plus';
  if (target === 'mid_senior') return level !== 'staff_plus';
  return true;
}

function queryLevelSuffix(band) {
  if (band === 'entry') return 'I';
  if (band === 'early_mid') return 'II';
  return 'Senior';
}

function levelVariant(title, band) {
  const value = clean(title);
  if (!/\bengineer$/i.test(value) || /\b(junior|jr\.?|associate|entry|senior|sr\.?|staff|principal|lead|engineer\s+(?:i|ii|iii|iv|[1-4]))\b/i.test(value)) return '';
  return `${value} ${queryLevelSuffix(band)}`;
}

function buildSearchQueries(options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 20));
  const saved = unique(options.savedTitles);
  const adjacent = unique(options.adjacentTitles);
  const band = inferCandidateSeniority(options.profile, options.prefs);
  // Reserve a bounded portion of the frontier for level-specific searches; LinkedIn's first-page
  // cap otherwise over-represents senior/staff postings for broad base titles. Explicit saved
  // titles always win; expansion consumes only unused slots in the twenty-query frontier.
  const variantBases = saved.filter(title => /\b(quality|manufacturing|process|metrology|inspection)\b/i.test(title));
  const remainingAfterSaved = Math.max(0, limit - saved.length);
  const variants = unique(variantBases.map(title => levelVariant(title, band)).filter(Boolean))
    .slice(0, Math.min(5, remainingAfterSaved));
  const adjacentLimit = Math.max(0, limit - saved.length - variants.length);
  const planned = unique([
    ...saved,
    ...variants,
    ...adjacent.slice(0, adjacentLimit),
  ]).slice(0, limit);
  return { queries: planned, seniorityBand: band, savedCount: saved.length,
    variantCount: planned.filter(query => variants.some(v => v.toLowerCase() === query.toLowerCase())).length,
    adjacentCount: planned.filter(query => adjacent.some(v => v.toLowerCase() === query.toLowerCase())).length };
}

function allowsAuthoritativeRetirement(searchPolicy = {}, requested) {
  if (requested === true) return true;
  if (requested === false) return false;
  // A targeted explicit query set proves only that subset. It cannot prove that records from
  // other saved families disappeared from their sources, so absence is not retirement evidence.
  return searchPolicy.explicit !== true;
}

function corpusRetirementDecision(searchPolicy, requested, gate = {}, autonomousApplyOnly = false) {
  const authoritative = allowsAuthoritativeRetirement(searchPolicy, requested);
  const gateAllows = gate.pass === true || (autonomousApplyOnly === true &&
    gate.atLeastTarget === true && gate.atLeast2Modalities === true && gate.hasDirectSource === true);
  return { authoritative, replaceMissing: authoritative && gateAllows };
}

module.exports = { SENIORITY_BANDS, inferCandidateSeniority, postingSeniority,
  isCompatiblePostingSeniority, levelVariant, buildSearchQueries, allowsAuthoritativeRetirement,
  corpusRetirementDecision };
