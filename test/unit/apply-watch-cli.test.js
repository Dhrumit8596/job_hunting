'use strict';

const CLI = require('../../scripts/pja-apply-all');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

module.exports = async t => {
  const parsed = CLI.readArgs(['--target', '5', '--category', 'greenhouse', '--wait', '--poll-seconds', '5']);
  t.eq(parsed.body.category, 'greenhouse', 'watch CLI: category is normalized');
  t.eq(parsed.body.atsAllow, ['greenhouse'], 'watch CLI: external category hard-limits ATS strategy');
  t.eq(parsed.body.channelAllow, ['external'], 'watch CLI: external category hard-limits channel');
  t.eq(parsed.body.requiredStrategies, ['greenhouse'], 'watch CLI: category also enables coverage gate');
  t.eq(parsed.body.coverageChannels, [], 'watch CLI: external category clears default channel coverage buckets');
  t.eq(parsed.body.coverageStrategies, ['greenhouse'], 'watch CLI: external category covers only its strategy');
  t.eq(parsed.body.coverageCount, 5, 'watch CLI: coverage requires the full target');
  t.ok(parsed.wait, 'watch CLI: --wait is retained');

  const linkedIn = CLI.readArgs(['--target', '5', '--category', 'linkedin']);
  t.eq(linkedIn.body.category, 'linkedin_easy_apply', 'watch CLI: LinkedIn alias maps to channel');
  t.eq(linkedIn.body.channelAllow, ['linkedin_easy_apply'], 'watch CLI: native category cannot spill into other channels');
  t.eq(linkedIn.body.coverageChannels, ['linkedin_easy_apply'], 'watch CLI: native category covers only its channel');
  t.eq(linkedIn.body.coverageStrategies, [], 'watch CLI: native category clears default ATS coverage buckets');
  t.ok(linkedIn.body.includeAssisted, 'watch CLI: LinkedIn category opts into its assisted channel');

  const progress = CLI.compactProgress({ run: { runId: 'apply-1', status: 'applying', phase: 'handler',
    currentIndex: 1, total: 5, confirmed: 1, failed: 0, skipped: 0, unverified: 0,
    targetConfirmed: 5, health: 'waiting', currentJob: { company: 'A', title: 'Role' } } });
  t.eq(progress.progress, '1/5', 'watch CLI: compact progress is bounded');
  t.eq(progress.currentJob, 'A — Role', 'watch CLI: current job uses compact identity only');
  t.eq(CLI.watchExitCode({ status: 'done', health: 'terminal', targetConfirmed: 5, confirmed: 5 }), 0,
    'watch CLI: target success exits zero');
  t.eq(CLI.watchExitCode({ status: 'exhausted', health: 'terminal', targetConfirmed: 5, confirmed: 3 }), 2,
    'watch CLI: supply exhaustion has a stable nonzero code');

  const handoffFile = path.join(os.tmpdir(), `pja-run-handoff-${process.pid}.json`);
  try {
    CLI.writeRunHandoff({ runId: 'apply-handoff', port: 6174, status: 'applying', category: 'greenhouse' }, handoffFile);
    const handoff = CLI.readRunHandoff(handoffFile);
    t.eq(handoff.runId, 'apply-handoff', 'watch CLI: exact run id is persisted for session handoff');
    t.eq(handoff.category, 'greenhouse', 'watch CLI: handoff remains compact and category-aware');
  } finally {
    try { fs.unlinkSync(handoffFile); } catch (_) {}
  }

  let statusHits = 0;
  let reportHits = 0;
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/apply-runs/apply-fixture') {
      statusHits++;
      if (statusHits === 1) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'apply run not found' }));
        return;
      }
      const terminal = statusHits > 2;
      res.end(JSON.stringify({ ok: true, clients: 1, run: {
        schemaVersion: 2, runId: 'apply-fixture', status: terminal ? 'done' : 'applying',
        phase: terminal ? 'terminal' : 'handler', category: 'greenhouse', currentIndex: terminal ? 1 : 0,
        total: 1, attempt: 1, targetConfirmed: 1, confirmed: terminal ? 1 : 0,
        unverified: 0, failed: 0, skipped: 0, health: terminal ? 'terminal' : 'waiting',
        nextAction: terminal ? 'export_report' : 'waiting_for_handler', secondsSinceTransition: 0,
        currentJob: terminal ? null : { company: 'Fixture Co', title: 'Fixture Role' },
      } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/export-apply-report') {
      reportHits++;
      req.resume();
      res.end(JSON.stringify({ success: true, runId: 'apply-fixture', file: 'reports/apply-fixture.md', bytes: 10 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const code = await CLI.watchRun({ port: fixture.address().port, timeoutMinutes: 1,
      pollSeconds: 1, jsonLines: true, allowResume: false }, 'apply-fixture');
    t.eq(code, 0, 'watch CLI: fixture run is followed from active state to confirmed terminal success');
    t.ok(statusHits >= 3, 'watch CLI: fixture watcher survives one transient exact-run 404 and polls until terminal');
    t.eq(reportHits, 1, 'watch CLI: fixture terminal handling exports exactly one report');
  } finally {
    await new Promise(resolve => fixture.close(resolve));
  }
};
