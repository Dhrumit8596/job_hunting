'use strict';
// Cheap, deterministic fit pre-score (0-100) — NO LLM call. Used to (a) give every stored job a
// fitScore immediately, and (b) cut the number of expensive `claude` scoring calls: only jobs in
// a borderline band need the LLM; clear yes/no can skip it.
//
// This intentionally mirrors filter.js's domain signals so the pre-score agrees with the eligible
// filter. It is a HEURISTIC, not the final fit — the LLM refines the borderline band later.

const { MEDICAL_RE, CORE_DOMAIN_RE } = require('./filter');

const QUALITY_MFG_RE = /\b(quality|manufactur|process|equipment|reliability|metrolog|inspection|yield|failure analysis|test engineer|validation|calibration)\b/i;
const SENIOR_STRETCH_RE = /\b(principal|distinguished|fellow|staff)\b/i;

// Returns an integer 0-100. Base 50, adjusted by domain relevance to the candidate's
// wafer/metrology/quality-at-a-medical-device background.
function prescore(job) {
  const title = String(job && job.title || '');
  const text = [job && job.title, job && job.company, job && job.location].filter(Boolean).join(' ');
  let s = 50;

  const isMedical = MEDICAL_RE.test(text);
  const isCore = CORE_DOMAIN_RE.test(title + ' ' + String(job && job.description || ''));
  const isQualMfg = QUALITY_MFG_RE.test(title);

  if (isCore) s += 22;              // wafer/metrology/inspection/process — her core
  else if (isQualMfg) s += 12;      // quality/manufacturing/equipment — adjacent
  if (isMedical && isCore) s += 12; // medical-device + core = most relevant
  else if (isMedical && isQualMfg) s += 7;

  if (SENIOR_STRETCH_RE.test(title)) s -= 15; // gray/stretch for an early-career TN candidate
  if (/\b(engineer|engineering)\b/i.test(title)) s += 3;
  if (/\bscientist\b/i.test(title)) s += 1;

  return Math.max(0, Math.min(100, Math.round(s)));
}

// Band helper: which jobs still need the LLM. Clear-high (>=78) and clear-low (<=42) skip it.
function needsLlm(score) {
  const s = Number(score);
  return Number.isFinite(s) && s > 42 && s < 78;
}

module.exports = { prescore, needsLlm };
