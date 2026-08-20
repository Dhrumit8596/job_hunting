'use strict';

// Shared Node/MV3 evidence contract. A new version intentionally invalidates cached scores whose
// gap semantics differ, while legacy flat-gap evidence remains fail-closed until it is rescored.
(function (root) {
  const SCORING_POLICY_VERSION = 'transferable-gaps-v1';
  const GAP_SEVERITIES = new Set(['material', 'trainable', 'preferred']);
  const TRANSFER_LEVELS = new Set(['direct', 'adjacent', 'stretch']);

  function clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function uniqueStrings(values, limit = 12) {
    const seen = new Set(), out = [];
    for (const value of values || []) {
      const text = clean(value), key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key); out.push(text);
      if (out.length >= limit) break;
    }
    return out;
  }

  function validStringArray(values) {
    return Array.isArray(values) && values.every(value => typeof value === 'string' && clean(value));
  }

  function normalizeGap(item) {
    // A string is the legacy/malformed shape. Count it as material rather than silently relaxing
    // an old score that was not produced under the structured transferability contract.
    if (typeof item === 'string') return { text: clean(item), severity: 'material', basis: 'unclear' };
    if (!item || typeof item !== 'object') return null;
    const text = clean(item.text || item.gap || item.qualification);
    if (!text) return null;
    const rawSeverity = clean(item.severity).toLowerCase();
    const severity = GAP_SEVERITIES.has(rawSeverity) ? rawSeverity : 'material';
    const rawBasis = clean(item.basis || item.requirement).toLowerCase();
    const basis = /^(required|preferred|unclear)$/.test(rawBasis) ? rawBasis : 'unclear';
    return { text, severity, basis };
  }

  function normalizeGapDetails(values, limit = 12) {
    const seen = new Set(), out = [];
    for (const value of values || []) {
      const gap = normalizeGap(value);
      if (!gap) continue;
      const key = gap.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(gap);
      if (out.length >= limit) break;
    }
    return out;
  }

  function normalizeTransferability(value) {
    const src = value && typeof value === 'object' ? value : {};
    const rawLevel = clean(src.level).toLowerCase();
    // Missing/invalid transferability is a stretch, so malformed model output cannot qualify.
    return { level: TRANSFER_LEVELS.has(rawLevel) ? rawLevel : 'stretch',
      rationale: clean(src.rationale || src.evidence).slice(0, 500) };
  }

  function normalizeScoreResult(result = {}) {
    const rawScore = Number(result.score);
    const sourceGaps = Array.isArray(result.gapDetails) ? result.gapDetails
      : Array.isArray(result.gaps) ? result.gaps : [];
    const gapDetails = normalizeGapDetails(sourceGaps);
    const bySeverity = severity => gapDetails.filter(gap => gap.severity === severity).map(gap => gap.text);
    return {
      score: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, rawScore)) : 0,
      matchEvidence: uniqueStrings(result.matchEvidence, 8),
      gaps: gapDetails.map(gap => gap.text),
      gapDetails,
      materialGaps: bySeverity('material'),
      trainableGaps: bySeverity('trainable'),
      preferredGaps: bySeverity('preferred'),
      conflicts: uniqueStrings(result.conflicts, 8),
      confidence: /^(high|medium|low)$/i.test(clean(result.confidence))
        ? clean(result.confidence).toLowerCase() : 'low',
      transferability: normalizeTransferability(result.transferability),
      scoringPolicyVersion: SCORING_POLICY_VERSION,
    };
  }

  function isCurrentPolicy(state) {
    return !!state && state.scoringPolicyVersion === SCORING_POLICY_VERSION;
  }

  function isQualifyingTransferability(state) {
    const level = clean(state && state.transferability && state.transferability.level).toLowerCase();
    return level === 'direct' || level === 'adjacent';
  }

  // A matching fingerprint alone does not make a cached model result reusable. Failed/partial
  // responses have historically been persisted with the current policy marker and a heuristic
  // fit score, but without the evidence needed to audit that score. Keep those rows in the bounded
  // scoring frontier while allowing complete below-threshold results to remain cached.
  function hasCompleteScoreEvidence(state) {
    if (!isCurrentPolicy(state) || typeof state.fitScore !== 'number' ||
        !Number.isFinite(state.fitScore) || state.fitScore < 0 || state.fitScore > 100) return false;
    if (!validStringArray(state.matchEvidence)) return false;
    const evidenceCount = uniqueStrings(state.matchEvidence, 8).length;
    // Zero direct matches is a valid, reusable explanation for an unrelated below-threshold job.
    // At the autonomous-qualification boundary the scoring contract requires at least three.
    if (Number(state.fitScore) >= 75 && evidenceCount < 3) return false;
    if (typeof state.confidence !== 'string' || !/^(high|medium|low)$/i.test(clean(state.confidence))) return false;

    const transferability = state.transferability;
    if (!transferability || typeof transferability !== 'object' ||
        typeof transferability.level !== 'string' ||
        typeof transferability.rationale !== 'string') return false;
    const transferLevel = clean(transferability.level).toLowerCase();
    if (!TRANSFER_LEVELS.has(transferLevel) || !clean(transferability.rationale)) return false;

    if (!Array.isArray(state.gapDetails)) return false;
    for (const key of ['gaps', 'materialGaps', 'trainableGaps', 'preferredGaps', 'conflicts']) {
      if (!validStringArray(state[key])) return false;
    }
    if (Number(state.fitScore) >= 75 &&
        (!/^(high|medium)$/i.test(clean(state.confidence)) || state.conflicts.length > 0 ||
          !isQualifyingTransferability(state))) return false;
    if (!state.gapDetails.every(gap => gap && typeof gap === 'object' &&
        typeof gap.text === 'string' && clean(gap.text) &&
        typeof gap.severity === 'string' && GAP_SEVERITIES.has(clean(gap.severity).toLowerCase()) &&
        typeof gap.basis === 'string' &&
        /^(required|preferred|unclear)$/.test(clean(gap.basis).toLowerCase()))) return false;

    // The derived arrays are load-bearing gates (especially materialGaps/maxGaps), so merely
    // having all fields is insufficient. Require them to be the canonical projections of the
    // structured details; otherwise a stale or partially persisted score could hide a material
    // gap by leaving the derived array empty.
    const details = normalizeGapDetails(state.gapDetails);
    if (details.length !== state.gapDetails.length) return false;
    const canonical = values => uniqueStrings(values, 12).map(value => value.toLowerCase()).sort();
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const bySeverity = severity => details.filter(gap => gap.severity === severity).map(gap => gap.text);
    return same(state.gaps, details.map(gap => gap.text)) &&
      same(state.materialGaps, bySeverity('material')) &&
      same(state.trainableGaps, bySeverity('trainable')) &&
      same(state.preferredGaps, bySeverity('preferred'));
  }

  function materialGaps(state) {
    if (isCurrentPolicy(state) && Array.isArray(state.materialGaps)) {
      return uniqueStrings(state.materialGaps);
    }
    // Legacy evidence did not distinguish severity. Preserve the old conservative gate.
    return uniqueStrings(state && state.gaps);
  }

  function gapCounts(state) {
    return {
      material: materialGaps(state).length,
      trainable: isCurrentPolicy(state) ? uniqueStrings(state.trainableGaps).length : 0,
      preferred: isCurrentPolicy(state) ? uniqueStrings(state.preferredGaps).length : 0,
    };
  }

  function shouldCapBelowQualification(result) {
    return !result || normalizeTransferability(result.transferability).level === 'stretch';
  }

  function summarize(rows) {
    const summary = { jobs: 0, transferability: { direct: 0, adjacent: 0, stretch: 0 },
      gapTotals: { material: 0, trainable: 0, preferred: 0 },
      jobsWithMaterialGaps: 0, jobsWithOnlyTransferableGaps: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      summary.jobs++;
      const level = normalizeTransferability(row.transferability).level;
      summary.transferability[level]++;
      const counts = gapCounts(row);
      summary.gapTotals.material += counts.material;
      summary.gapTotals.trainable += counts.trainable;
      summary.gapTotals.preferred += counts.preferred;
      if (counts.material) summary.jobsWithMaterialGaps++;
      else if (counts.trainable || counts.preferred) summary.jobsWithOnlyTransferableGaps++;
    }
    return summary;
  }

  const SCORE_POLICY_PROMPT = `Classify missing qualifications instead of flattening every absent
JD phrase into the same kind of gap. Use material only for an explicitly required core
responsibility, minimum qualification, or credential that is not evidenced. Group related missing
requirements into one material gap. Use trainable for a specific tool, equipment set, process,
method, or adjacent industry that is not shown when the resume directly supports the role's core
function. Use preferred for preferred, desired, plus, or nice-to-have qualifications. Preferred and
trainable gaps stay visible but do not count toward the automatic material-gap limit.

Chemical, wastewater, battery, biotech, thin-film/deposition, vacuum, semiconductor device,
CAD/electrical, and supplier-quality work may be adjacent rather than unsuitable when the resume
directly supports the core manufacturing, inspection, metrology, yield, process-control,
troubleshooting, SPC, or root-cause duties. Never claim experience that is absent. A small experience
stretch or a preferred degree is not a hard conflict. A clearly unmet mandatory license, degree,
clearance, authorization, location rule, or non-negotiable experience minimum is a hard conflict.

Set transferability.level to direct when the core work and domain are directly evidenced, adjacent
when the core work is evidenced but tools/domain are reasonably transferable, and stretch when the
core function or several explicit minimums are not evidenced. A score of 75+ is allowed for direct
or adjacent work only when at least three direct resume-to-requirement matches cover most core
duties, there are no hard conflicts, and confidence is medium or high.`;

  const API = { SCORING_POLICY_VERSION, SCORE_POLICY_PROMPT, clean, uniqueStrings, validStringArray, normalizeGap,
    normalizeGapDetails, normalizeTransferability, normalizeScoreResult, isCurrentPolicy,
    isQualifyingTransferability, hasCompleteScoreEvidence,
    materialGaps, gapCounts, shouldCapBelowQualification, summarize };
  if (root) root.PJAScoringEvidence = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
