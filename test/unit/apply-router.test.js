'use strict';
// Phase A: the apply dispatcher picks exactly one strategy from (URL host) or (DOM signals).
const path = require('path');
require(path.resolve(__dirname, '../../sourcing/detect-ats')); // sets globalThis.PJADetectAts
const { STRATEGIES, readSignals, pickStrategy } = require(path.resolve(__dirname, '../../content/apply-router'));

module.exports = (t) => {
  // --- host-based detection (the common case) ---
  const hostCases = [
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://jobs.lever.co/acme/uuid', 'lever'],
    ['https://jobs.ashbyhq.com/acme/uuid', 'ashby'],
    ['https://acme.wd5.myworkdayjobs.com/careers', 'workday'],
    ['https://jobs.smartrecruiters.com/acme/123', 'smartrecruiters'],
    ['https://careers-acme.icims.com/jobs/1/x/job', 'icims'],
    ['https://acme.taleo.net/careersection/x', 'taleo'],
    ['https://acme.jobvite.com/careers', 'jobvite'],
    ['https://acme.bamboohr.com/careers/1', 'bamboohr'],
    ['https://apply.workable.com/acme/j/ABC', 'workable'],
    ['https://acme.breezy.hr/p/uuid', 'breezy'],
    ['https://performancemanager.successfactors.com/x', 'successfactors'],
    ['https://recruiting.paylocity.com/recruiting/jobs/1', 'paylocity'],
    ['https://ats.rippling.com/acme/jobs/1', 'rippling'],
  ];
  for (const [url, expected] of hostCases) {
    const s = pickStrategy(url, {});
    t.eq(s.name, expected, 'host → ' + expected + ' (' + url.replace(/^https:\/\//, '').slice(0, 28) + ')');
    t.eq(s.source, 'host', 'source=host for ' + expected);
    t.ok(!!s.engine, 'strategy has an engine: ' + expected);
  }

  // --- unknown host → DOM sniff fallback ---
  const dom = (sig) => pickStrategy('https://careers.acme-corp.com/apply/123', sig);
  t.eq(dom({ hasWorkday: true }).name, 'workday', 'dom sniff: workday automation-id');
  t.eq(dom({ hasWorkday: true }).source, 'dom', 'dom sniff: source=dom');
  t.eq(dom({ hasGreenhouseForm: true }).name, 'greenhouse', 'dom sniff: greenhouse form');
  t.eq(dom({ hasLever: true }).name, 'lever', 'dom sniff: lever form');
  t.eq(dom({ hasReactSelect: true }).name, 'generic', 'dom sniff: react-select → generic');
  t.eq(dom({ hasFileInput: true }).name, 'generic', 'dom sniff: file input → generic');
  t.eq(dom({ hasForm: true }).name, 'generic', 'dom sniff: bare form → generic');

  // --- nothing recognizable → unsupported (defer to needs_manual, don't thrash) ---
  t.eq(dom({}).name, 'unsupported', 'no signals → unsupported');
  t.eq(dom({}).source, 'none', 'unsupported source=none');

  // --- host beats DOM (a greenhouse host with a stray workday attr still routes greenhouse) ---
  t.eq(pickStrategy('https://boards.greenhouse.io/x/jobs/1', { hasWorkday: true }).name, 'greenhouse', 'host precedence over dom');

  // --- garbage URL doesn't throw ---
  t.eq(pickStrategy('not a url', {}).name, 'unsupported', 'garbage url → unsupported (no throw)');

  // --- registry integrity: every strategy has engine + tier ---
  for (const k of Object.keys(STRATEGIES)) {
    t.ok(STRATEGIES[k].engine && STRATEGIES[k].tier, 'registry entry complete: ' + k);
  }

  // --- readSignals tolerates a null/garbage doc ---
  const sig = readSignals(null);
  t.eq(sig.hasForm, false, 'readSignals(null) safe');
};
