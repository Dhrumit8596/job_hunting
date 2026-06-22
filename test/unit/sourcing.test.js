'use strict';
// Tests for the job-sourcing pipeline. SYNTHETIC data only — no network, no PII.
const path = require('path');
const R = d => require(path.resolve(__dirname, '../../sourcing', d));
const { makeJob, isRemote } = R('normalize');
const { isEligibleTitle, isEligibleLocation, isItarExcluded, filterJobs, tnAdjustScore } = R('filter');
const { jobKey, appliedKeySet, dedupe, pjaMergeAppliedLog, pjaCollectAppliedRecords } = R('dedupe');
const { routeJobs } = R('pipeline');
const gh = R('adapters/greenhouse');
const lever = R('adapters/lever');

module.exports = (t) => {
  // --- normalize ---
  t.eq(isRemote('Remote - US'), true, 'isRemote: remote');
  t.eq(isRemote('San Jose, CA'), false, 'isRemote: onsite');
  const j = makeJob({ id: 7, title: '  Equipment  Engineer ', company: 'Twist', location: 'South San Francisco, CA', applyUrl: 'http://x', ats: 'greenhouse' });
  t.eq(j.title, 'Equipment Engineer', 'makeJob: cleans whitespace');
  t.eq(j.id, '7', 'makeJob: id stringified');
  t.eq(j.remote, false, 'makeJob: remote inferred false');

  // --- filter: titles (TN eligibility + domain) ---
  t.eq(isEligibleTitle('Manufacturing Engineer II'), true, 'title: engineer ok');
  t.eq(isEligibleTitle('Senior Quality Engineer'), true, 'title: quality engineer ok');
  t.eq(isEligibleTitle('Scientist, Product Development'), true, 'title: scientist ok');
  t.eq(isEligibleTitle('Manufacturing Technician'), false, 'title: technician excluded');
  t.eq(isEligibleTitle('Quality Operator'), false, 'title: operator excluded');
  t.eq(isEligibleTitle('Engineering Manager'), false, 'title: manager excluded');
  t.eq(isEligibleTitle('Software Engineer'), false, 'title: software excluded (off-domain)');
  t.eq(isEligibleTitle('Machine Learning Engineer'), false, 'title: ML excluded');
  t.eq(isEligibleTitle('Field Applications Scientist'), false, 'title: field-apps excluded (plural)');
  t.eq(isEligibleTitle('Design Verification Engineer'), false, 'title: chip-design excluded');
  t.eq(isEligibleTitle('Recruiter'), false, 'title: non-eng excluded');

  // --- filter: location (CA or US-remote) ---
  t.eq(isEligibleLocation('Santa Clara, CA'), true, 'loc: CA');
  t.eq(isEligibleLocation('Remote - US', true), true, 'loc: US remote');
  t.eq(isEligibleLocation('Remote - EMEA'), false, 'loc: non-US remote excluded');
  t.eq(isEligibleLocation('Austin, TX'), false, 'loc: non-CA onsite excluded');

  // --- filter: ITAR ---
  t.eq(isItarExcluded('Process Engineer (US Person required, ITAR)'), true, 'itar: blocked');
  t.eq(isItarExcluded('Process Engineer'), false, 'itar: clean');

  // --- filterJobs integration ---
  const raw = [
    makeJob({ id: 1, title: 'Quality Engineer', company: 'A', location: 'Fremont, CA' }),
    makeJob({ id: 2, title: 'Manufacturing Technician', company: 'A', location: 'Fremont, CA' }),
    makeJob({ id: 3, title: 'Process Engineer', company: 'B', location: 'Austin, TX' }),
    makeJob({ id: 4, title: 'Equipment Engineer', company: 'C', location: 'Remote - US', remote: true }),
    makeJob({ id: 5, title: 'Software Engineer', company: 'D', location: 'San Jose, CA' }),
  ];
  t.eq(filterJobs(raw).map(x => x.id), ['1', '4'], 'filterJobs: keeps eligible eng + CA/remote only');

  // --- dedupe ---
  t.eq(jobKey({ company: 'Twist Bioscience', title: 'Equipment Engineer' }),
       'twist bioscience::equipment engineer', 'jobKey: normalized');
  const applied = appliedKeySet([{ company: 'Twist Bioscience', title: 'Equipment Engineer' }]);
  const dd = dedupe([
    makeJob({ id: 10, title: 'Equipment Engineer', company: 'Twist Bioscience', location: 'SSF, CA' }),
    makeJob({ id: 11, title: 'Quality Engineer', company: 'Twist Bioscience', location: 'SSF, CA' }),
    makeJob({ id: 12, title: 'Quality Engineer', company: 'Twist Bioscience', location: 'SSF, CA' }),
  ], applied);
  t.eq(dd.map(x => x.id), ['11'], 'dedupe: drops applied + within-run dup');

  // --- Bug2: durable applied-log dedupe (survives pja_ext_queue being overwritten) ---
  // Reproduce the gap: run1 applies a role -> persisted to pja_applied_log. run2 overwrites
  // pja_ext_queue with a different job. Dedupe must STILL know about run1's role.
  let log = pjaMergeAppliedLog([], [{ company: 'Acme', title: 'Quality Engineer' }]);
  t.eq(log.length, 1, 'mergeAppliedLog: appends');
  log = pjaMergeAppliedLog(log, [{ company: 'Acme', title: 'Quality Engineer' }]); // dup
  t.eq(log.length, 1, 'mergeAppliedLog: dedups same role');
  log = pjaMergeAppliedLog(log, [{ company: 'Beta Bio', title: 'Process Engineer' }]);
  t.eq(log.length, 2, 'mergeAppliedLog: adds new role');
  const storage = {
    pja_jobs: [],
    pja_applied_log: log,
    pja_ext_queue: { results: { applied: [{ company: 'Gamma', title: 'Equipment Engineer' }], skipped: [] } },
  };
  const recs = pjaCollectAppliedRecords(storage);
  const keys = appliedKeySet(recs);
  t.ok(keys.has(jobKey({ company: 'Acme', title: 'Quality Engineer' })), 'collectApplied: durable-log role deduped across overwritten queue');
  t.ok(keys.has(jobKey({ company: 'Beta Bio', title: 'Process Engineer' })), 'collectApplied: 2nd durable-log role deduped');
  t.ok(keys.has(jobKey({ company: 'Gamma', title: 'Equipment Engineer' })), 'collectApplied: current-queue role deduped');

  // --- adapter normalize (synthetic raw) ---
  const ghJob = gh.normalize({ id: 99, title: 'Quality Engineer', location: { name: 'San Diego, CA' }, absolute_url: 'https://boards.greenhouse.io/x/jobs/99', updated_at: '2026-06-01' }, { name: 'Acme', slug: 'acme' });
  t.eq(ghJob.company, 'Acme', 'gh.normalize: company from source');
  t.eq(ghJob.applyUrl, 'https://boards.greenhouse.io/x/jobs/99', 'gh.normalize: applyUrl');
  t.eq(ghJob.ats, 'greenhouse', 'gh.normalize: ats');
  const levJob = lever.normalize({ id: 'abc', text: 'Equipment Engineer', categories: { location: 'Alameda, CA' }, hostedUrl: 'https://jobs.lever.co/acme/abc' }, { name: 'Acme', slug: 'acme' });
  t.eq(levJob.applyUrl, 'https://jobs.lever.co/acme/abc/apply', 'lever.normalize: applyUrl gets /apply');
  t.eq(levJob.location, 'Alameda, CA', 'lever.normalize: location');
  const linkedin = R('adapters/linkedin');
  const liJob = linkedin.normalize({ jobId: '4430362420', title: 'Quality Engineer', company: 'Akkodis', location: 'Torrance, CA', isEasyApply: true }, { name: 'LinkedIn' });
  t.eq(liJob.id, '4430362420', 'linkedin.normalize: jobId');
  t.eq(liJob.applyUrl, 'https://www.linkedin.com/jobs/view/4430362420/', 'linkedin.normalize: view URL');
  t.eq(liJob.ats, 'linkedin', 'linkedin.normalize: ats');
  t.eq(liJob.isEasyApply, true, 'linkedin.normalize: easyApply flag');

  // --- tnAdjustScore: down-weight gray-TN senior titles ---
  t.eq(tnAdjustScore('Senior Quality Engineer', 88), 88, 'tnAdjust: normal title unchanged');
  t.eq(tnAdjustScore('Senior Principal Validation Engineer', 78), 55, 'tnAdjust: Principal capped 55');
  t.eq(tnAdjustScore('Distinguished Engineer', 80), 55, 'tnAdjust: Distinguished capped 55');
  t.eq(tnAdjustScore('Staff Mechanical Engineer', 82), 65, 'tnAdjust: Staff capped 65');
  t.eq(tnAdjustScore('Staff Engineer', 60), 60, 'tnAdjust: below cap unchanged');

  // --- pipeline routing ---
  const scored = [
    { id: 1, fitScore: 90 }, { id: 2, fitScore: 70 }, { id: 3, fitScore: 55 }, { id: 4, fitScore: null },
  ];
  const r = routeJobs(scored, 70);
  t.eq(r.queue.map(x => x.id), [1, 2], 'routeJobs: >=threshold to queue');
  t.eq(r.shortlist.map(x => x.id), [3, 4], 'routeJobs: below/unscored to shortlist');
};
