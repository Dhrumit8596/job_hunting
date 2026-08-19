'use strict';

// Description-free diagnostics for explaining why a large sourced corpus produces a small
// evidence-qualified reserve. This module never consumes profile values or JD bodies.

const DAY_MS = 24 * 60 * 60 * 1000;
const { postingSeniority, isCompatiblePostingSeniority } = require('./search-policy');
const { detectAts } = require('./detect-ats');
const ApplySelect = require('./apply-select');
const ScoringEvidence = require('../scoring-evidence');

function norm(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

function roleFamily(title) {
  const s = norm(title);
  if (/\b(product release|product development|new product|npi|industrialization)\b/.test(s)) return 'product_release_development';
  if (/\b(process integration|yield|wafer|thin film|etch|deposition|lithography)\b/.test(s)) return 'semiconductor_process';
  if (/\b(metrology|inspection|defect)\b/.test(s)) return 'metrology_inspection';
  if (/\b(quality|supplier quality|quality assurance|quality control)\b/.test(s)) return 'quality';
  if (/\b(manufacturing|production engineer)\b/.test(s)) return 'manufacturing';
  if (/\b(process engineer|process development)\b/.test(s)) return 'process';
  if (/\b(equipment engineer|equipment reliability|maintenance engineer)\b/.test(s)) return 'equipment';
  if (/\b(failure analysis|reliability engineer)\b/.test(s)) return 'reliability_failure_analysis';
  if (/\b(validation|verification|test engineer)\b/.test(s)) return 'validation_test';
  return 'other';
}

function seniority(title) {
  return postingSeniority(title);
}

function postingAgeDays(posting, now) {
  const value = posting && (posting.postedAt || posting.lastSeenAt || posting.discoveredAt);
  const text = String(value || '').trim();
  if (!text) return null;
  if (/posted\s+today/i.test(text)) return 0;
  if (/posted\s+yesterday/i.test(text)) return 1;
  const relative = text.match(/posted\s+(\d+)(\+)?\s+days?\s+ago/i);
  if (relative) return Number(relative[1]) + (relative[2] ? 1 : 0);
  const ts = typeof value === 'number' ? value : Date.parse(text);
  return Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / DAY_MS)) : null;
}

function inc(target, key) {
  key = String(key || 'unknown');
  target[key] = (target[key] || 0) + 1;
}

function evidenceReady(state, threshold, candidateFingerprint) {
  const score = Number(state && state.fitScore);
  const evidence = Array.isArray(state && state.matchEvidence) ? state.matchEvidence.filter(Boolean) : [];
  const gaps = ScoringEvidence.materialGaps(state);
  const conflicts = Array.isArray(state && state.conflicts) ? state.conflicts.filter(Boolean) : [];
  const minEvidence = score >= threshold ? 3 : 2;
  if (!Number.isFinite(score) || score < threshold) return false;
  if (!/^(llm|ai)$/i.test(String(state && state.scoreKind || ''))) return false;
  if (candidateFingerprint && state.candidateFingerprint !== candidateFingerprint) return false;
  const transferability = ScoringEvidence.normalizeTransferability(state && state.transferability).level;
  return ScoringEvidence.isCurrentPolicy(state) && evidence.length >= minEvidence &&
    gaps.length <= 2 && !conflicts.length &&
    /^(direct|adjacent)$/.test(transferability) &&
    /^(high|medium)$/i.test(String(state && state.confidence || ''));
}

function hasCurrentJdFingerprint(posting, state) {
  const postingFingerprint = String(posting && posting.descriptionFingerprint || '');
  const scoreFingerprint = String(state && state.descriptionFingerprint || '');
  return !!postingFingerprint && postingFingerprint === scoreFingerprint;
}

function evidenceReadyForPosting(posting, state, threshold, candidateFingerprint) {
  return ApplySelect.hasUsableDescription(posting) &&
    hasCurrentJdFingerprint(posting, state) &&
    evidenceReady(state, threshold, candidateFingerprint);
}

function postingChannel(posting) {
  if (posting && (posting.channel === 'linkedin_easy_apply' || posting.isEasyApply === true)) return 'linkedin_easy_apply';
  if (posting && (posting.channel === 'indeed_apply' || posting.indeedApply === true)) return 'indeed_apply';
  return String(posting && posting.channel || 'external').toLowerCase() || 'external';
}

function routeReadiness(posting, options = {}) {
  const channel = postingChannel(posting);
  const applyUrl = String(posting && posting.applyUrl || '');
  if (!applyUrl) return { supported: false, autonomous: false, reason: 'missing_apply_url', channel };
  if (channel === 'linkedin_easy_apply') return { supported: true,
    autonomous: options.includeAssisted === true, reason: options.includeAssisted === true ? '' : 'assisted_channel', channel };
  if (channel === 'indeed_apply') return { supported: true, autonomous: true, reason: '', channel };
  let host = '';
  try { host = new URL(applyUrl).hostname.toLowerCase(); } catch (_) {
    return { supported: false, autonomous: false, reason: 'invalid_apply_url', channel };
  }
  const strategy = detectAts(applyUrl) || String(posting && (posting.detectedAts || posting.ats) || '').toLowerCase();
  if (/(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(host) && !detectAts(applyUrl)) {
    return { supported: false, autonomous: false, reason: 'aggregator_without_apply_destination', channel };
  }
  const capability = ApplySelect.applyCapabilityStatus(applyUrl, strategy || 'generic');
  if (capability.status === 'unsupported' || capability.status === 'unknown_needs_resolution') {
    return { supported: false, autonomous: false, reason: capability.reason || 'unsupported_route', channel };
  }
  return { supported: true, autonomous: true, reason: '', channel };
}

function inferredBelowThresholdCause(posting, state, seniorityBand) {
  const family = roleFamily(posting && posting.title);
  if (family === 'other') return 'wrong_role_family';
  if (!isCompatiblePostingSeniority(posting && posting.title, seniorityBand || 'early_mid')) return 'seniority_mismatch';
  const evidence = Array.isArray(state && state.matchEvidence) ? state.matchEvidence.filter(Boolean) : [];
  const gaps = ScoringEvidence.materialGaps(state);
  const conflicts = Array.isArray(state && state.conflicts) ? state.conflicts.filter(Boolean) : [];
  if (!String(posting && posting.descriptionStatus || '') || posting.descriptionReady === false) return 'extraction_or_hydration_defect';
  if (!Number.isFinite(Number(state && state.fitScore))) return 'unscored';
  if (!/^(llm|ai)$/i.test(String(state && state.scoreKind || ''))) return 'needs_evidence_scoring';
  if (!ScoringEvidence.isCurrentPolicy(state)) return 'needs_current_scoring_policy';
  if (!evidence.length || gaps.length > 2 || conflicts.length) return 'insufficient_resume_evidence_or_requirement_gap';
  return 'evidence_score_below_threshold';
}

function queryMatchesPosting(posting, query) {
  const q = norm(query);
  if (!q) return false;
  const attributed = [posting && posting.query, ...(posting && posting.matchedQueries || [])].map(norm);
  if (attributed.includes(q)) return true;
  const title = norm(posting && posting.title);
  const tokens = q.split(' ').filter(token => token.length > 2 && !/^(and|with|the)$/.test(token));
  return tokens.length > 0 && tokens.every(token => title.includes(token));
}

function queryFamilySummary(index, state, families, opts) {
  const rows = [];
  for (const family of families || []) {
    const queries = (Array.isArray(family && family.queries) ? family.queries : []).map(String).filter(Boolean);
    const matched = Object.keys(index).filter(id => queries.some(query => queryMatchesPosting(index[id], query)));
    let fresh7d = 0, fresh30d = 0, hydrated = 0, deterministic = 0, scored = 0, qualified = 0;
    for (const id of matched) {
      const p = index[id] || {}, st = state[id] || {};
      const age = postingAgeDays(p, opts.now);
      if (age != null && age <= 7) fresh7d++;
      if (age != null && age <= 30) fresh30d++;
      if (p.descriptionReady === true) hydrated++;
      if (!opts.isLocationEligible || opts.isLocationEligible(p)) deterministic++;
      if (/^(llm|ai)$/i.test(String(st.scoreKind || ''))) scored++;
      if (evidenceReadyForPosting(p, st, opts.threshold, opts.candidateFingerprint)) qualified++;
    }
    rows.push({
      family: String(family && family.name || 'unnamed'),
      queries,
      jobsDiscovered: matched.length,
      newlyImported: null,
      fresh7d,
      fresh30d,
      successfullyHydrated: hydrated,
      deterministicallyEligible: deterministic,
      sentForAiScoring: scored,
      evidenceScored: scored,
      qualified,
      planned: 0,
      attempted: 0,
      confirmed: 0,
      submittedUnverified: 0,
      failed: 0,
      modelCalls: null,
      tokensConsumed: null,
    });
  }
  return rows;
}

function summarizeSupply(corpus, opts = {}) {
  const index = corpus && corpus.index || {};
  const state = corpus && corpus.state || {};
  const threshold = opts.threshold != null ? Number(opts.threshold) : 75;
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const candidateFingerprint = String(opts.candidateFingerprint || '');
  const result = {
    total: Object.keys(index).length,
    threshold,
    seniorityBand: opts.seniorityBand || 'early_mid',
    scored: 0,
    unscored: 0,
    evidenceScored: 0,
    heuristicPrescored: 0,
    currentCandidateFingerprintScores: 0,
    currentJdFingerprintScores: 0,
    atOrAboveThreshold: 0,
    evidenceQualified: 0,
    evidenceQualifiedOverall: 0,
    evidenceQualifiedFreshState: 0,
    qualifiedUnattemptedPreLedger: 0,
    descriptionReady: 0,
    locationEligible: 0,
    locationMismatch: 0,
    fresh7d: 0,
    fresh30d: 0,
    freshnessUnknown: 0,
    byScoreBucket: {}, byRoleFamily: {}, belowThresholdByRoleFamily: {},
    bySeniority: {}, belowThresholdBySeniority: {}, byAts: {}, byState: {},
    belowThresholdCauseInference: {},
    qualificationFunnel: {
      evidenceQualifiedOverall: 0,
      freshUnattemptedState: 0,
      locationEligible: 0,
      supportedRouteReady: 0,
      autonomousRouteReady: 0,
      qualifiedUnattemptedPreLedger: 0,
    },
    preLedgerDropCounts: {},
  };
  for (const id of Object.keys(index)) {
    const p = index[id] || {};
    const st = state[id] || {};
    const score = Number(st.fitScore);
    const hasScore = st.fitScore != null && Number.isFinite(score);
    const family = roleFamily(p.title);
    const level = seniority(p.title);
    const ats = String(p.detectedAts || p.ats || 'unknown').toLowerCase();
    inc(result.byRoleFamily, family);
    inc(result.bySeniority, level);
    inc(result.byAts, ats);
    inc(result.byState, st.status || 'sourced');
    if (typeof opts.isLocationEligible === 'function') {
      if (opts.isLocationEligible(p)) result.locationEligible++;
      else result.locationMismatch++;
    }
    if (p.descriptionReady === true) result.descriptionReady++;
    const age = postingAgeDays(p, now);
    if (age == null) result.freshnessUnknown++;
    else {
      if (age <= 7) result.fresh7d++;
      if (age <= 30) result.fresh30d++;
    }
    if (!hasScore) {
      result.unscored++;
      inc(result.byScoreBucket, 'unscored');
      continue;
    }
    result.scored++;
    if (/^(llm|ai)$/i.test(String(st.scoreKind || ''))) result.evidenceScored++;
    else result.heuristicPrescored++;
    if (!candidateFingerprint || st.candidateFingerprint === candidateFingerprint) result.currentCandidateFingerprintScores++;
    if (hasCurrentJdFingerprint(p, st)) result.currentJdFingerprintScores++;
    const bucket = score < 40 ? '0-39' : score < 55 ? '40-54' : score < 70 ? '55-69' : score < threshold ? `70-${threshold - 1}` : `${threshold}+`;
    inc(result.byScoreBucket, bucket);
    if (score >= threshold) {
      result.atOrAboveThreshold++;
      const qualifiedEvidence = evidenceReadyForPosting(p, st, threshold, candidateFingerprint);
      if (qualifiedEvidence) {
        result.evidenceQualified++;
        result.evidenceQualifiedOverall++;
        result.qualificationFunnel.evidenceQualifiedOverall++;
        const freshState = String(st.status || 'sourced') === 'sourced' && Number(st.attempts || 0) === 0;
        if (!freshState) {
          inc(result.preLedgerDropCounts, 'prior_or_nonfresh_state');
        } else {
          result.evidenceQualifiedFreshState++;
          result.qualificationFunnel.freshUnattemptedState++;
          const locationOk = typeof opts.isLocationEligible !== 'function' || opts.isLocationEligible(p);
          if (!locationOk) {
            inc(result.preLedgerDropCounts, 'outside_target_location');
          } else {
            result.qualificationFunnel.locationEligible++;
            const route = routeReadiness(p, opts);
            if (!route.supported) {
              inc(result.preLedgerDropCounts, route.reason || 'unsupported_route');
            } else {
              result.qualificationFunnel.supportedRouteReady++;
              if (!route.autonomous) {
                inc(result.preLedgerDropCounts, route.reason || 'assisted_channel');
              } else {
                result.qualificationFunnel.autonomousRouteReady++;
                result.qualifiedUnattemptedPreLedger++;
                result.qualificationFunnel.qualifiedUnattemptedPreLedger++;
              }
            }
          }
        }
      }
    } else {
      inc(result.belowThresholdByRoleFamily, family);
      inc(result.belowThresholdBySeniority, level);
      inc(result.belowThresholdCauseInference, inferredBelowThresholdCause(p, st, result.seniorityBand));
    }
  }
  const inferred = Object.entries(result.belowThresholdCauseInference).sort((a, b) => b[1] - a[1]);
  result.dominantBelowThresholdCause = inferred.length ? { cause: inferred[0][0], count: inferred[0][1] } : null;
  result.queryFamilies = queryFamilySummary(index, state, opts.queryFamilies, {
    threshold, now, candidateFingerprint, isLocationEligible: opts.isLocationEligible,
  });
  result.note = 'Below-threshold causes are deterministic title/evidence diagnostics, not a substitute for resume/JD scoring. qualifiedUnattemptedPreLedger still requires the apply planner ledger/blocked-host check before admission.';
  return result;
}

module.exports = { summarizeSupply, roleFamily, seniority, postingAgeDays, evidenceReady,
  evidenceReadyForPosting, hasCurrentJdFingerprint, routeReadiness, queryMatchesPosting };
