'use strict';
// ATS adapter registry. Adding a new ATS = add an adapter file + register it here.
// Each adapter exports: ATS (string), fetchJobs(source, opts) -> Job[], normalize(raw, source).
const greenhouse = require('./greenhouse');
const lever = require('./lever');
const workday = require('./workday');
const linkedin = require('./linkedin');
// Phase 2: icims, etc.

const ADAPTERS = { greenhouse, lever, workday, linkedin };

function getAdapter(ats) {
  return ADAPTERS[String(ats || '').toLowerCase()] || null;
}

module.exports = { ADAPTERS, getAdapter };
