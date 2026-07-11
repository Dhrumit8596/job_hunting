'use strict';
// ATS adapter registry. Adding a new ATS = add an adapter file + register it here.
// Each adapter exports: ATS (string), fetchJobs(source, opts) -> Job[], normalize(raw, source).
const greenhouse = require('./greenhouse');
const lever = require('./lever');
const workday = require('./workday');
const linkedin = require('./linkedin');
const ashby = require('./ashby');
const smartrecruiters = require('./smartrecruiters');
// Discovery adapters (keyword search across employers, keyless) — the second modality.
const remotive = require('./remotive');
const jobicy = require('./jobicy');
// Phase 2 (registry ATS): icims, jobvite, etc.

const ADAPTERS = { greenhouse, lever, workday, linkedin, ashby, smartrecruiters, remotive, jobicy };
// Discovery adapters are driven by keyword, not by a slug registry entry.
const DISCOVERY = { remotive, jobicy };

function getAdapter(ats) {
  return ADAPTERS[String(ats || '').toLowerCase()] || null;
}

module.exports = { ADAPTERS, DISCOVERY, getAdapter };
