#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const RUN_HANDOFF_FILE = process.env.PJA_RUN_HANDOFF_FILE ||
  path.resolve(__dirname, '..', '.pja-run.local.json');

function readRunHandoff(file = RUN_HANDOFF_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && value.runId ? value : null;
  } catch (_) { return null; }
}

function writeRunHandoff(value, file = RUN_HANDOFF_FILE) {
  if (!value || !value.runId) return null;
  const prior = readRunHandoff(file) || {};
  const next = {
    schemaVersion: 1,
    runId: String(value.runId),
    port: Number(value.port || prior.port || 6174),
    status: String(value.status || prior.status || 'started'),
    category: String(value.category || prior.category || ''),
    reportPath: String(value.reportPath || prior.reportPath || ''),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

function usage() {
  return `Usage: npm run apply:all -- [command] [options]

Starts or inspects the unified one-click flow through the local dev server:
source jobs → score/rank → route by channel/ATS → apply → log outcomes.

Commands:
  start                    Start the one-click flow (default)
  status                   Show compact active/last ranked-run progress
  watch                    Follow one run until it reaches a terminal state
  report                   Export the sanitized developer markdown report
  preflight                Check readiness without starting a run

Options:
  --dry-run                 Plan only; do not submit applications
  --target <n>              Confirmed-application target (default: 20)
  --all-above-score         Apply every qualified job above threshold instead of stopping at target
  --threshold <n>           Minimum fit score (default: 70)
  --max-gaps <n>            Maximum material gaps allowed (default: 2)
  --source-target <n>       Sourcing target before ranking
  --attempt-cap <n>         Maximum attempted jobs; 0 means no attempt cap
  --category <name>         Restrict the run to one channel/ATS category
  --run-id <id>             Inspect, watch, or report one exact run
  --wait                    Follow the started run until terminal and export its report
  --poll-seconds <n>        Watch polling interval (default: 20)
  --timeout-minutes <n>     Maximum watch duration (default: 240)
  --json-lines              Emit compact NDJSON progress records while watching
  --allow-resume            Permit one bounded resume after inspect on a stalled run
  --query <text>            Add a targeted sourcing query; can repeat
  --coverage                Require real-job coverage across the default supported strategies
  --coverage-count <n>      Require/reserve this many jobs per coverage bucket
  --coverage-strategy <s>   Add one coverage ATS strategy; can repeat
  --coverage-all-supported  Cover all currently supported default strategies/channels
  --coverage-submit         Explicitly run coverage as full submit (default unless --dry-run)
  --browser-scan-timeout <n> Browser scan wait in ms for LinkedIn/Indeed coverage
  --no-evidence             Allow lower-evidence jobs into the plan
  --port <n>                Dev server port (default: 6174)
  --json '<object>'         Merge arbitrary /apply-all JSON options
  --skip-preflight          Call /apply-all without the one-click readiness check
  --retry-blocked           Intentionally include jobs/tenants blocked by prior manual blockers
  --retry-blocked-host <h>  Retry only one prior blocked ATS host; can repeat
  --required-channel <c>    Require at least one qualified job for a channel; can repeat
  --required-strategy <s>   Require at least one qualified ATS strategy; can repeat
  --help                    Show this help

Examples:
  npm run apply:all -- --dry-run --target 20 --query "metrology engineer"
  npm run apply:all -- --target 5 --threshold 75
  npm run apply:all -- --target 5 --category greenhouse --wait
  npm run apply:watch -- --run-id apply-123
  npm run apply:status
  npm run apply:report
`;
}

function readArgs(argv) {
  const out = {
    command: 'start',
    body: {
      targetConfirmed: 20,
      threshold: 70,
      maxGaps: 2,
      perCompanyCap: 2,
      includeAssisted: true,
      e2eSafe: true,
      rescore: true,
      requireEvidence: true,
    },
    port: Number(process.env.PJA_DEV_PORT || 6174),
    wait: false,
    pollSeconds: 20,
    timeoutMinutes: 240,
    jsonLines: false,
    allowResume: false,
    runId: '',
    handoffFile: RUN_HANDOFF_FILE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (i === 0 && /^(start|status|watch|report|preflight)$/i.test(arg)) {
      out.command = arg.toLowerCase();
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.body.dryRun = true;
    else if (arg === '--coverage' || arg === '--coverage-all-supported') {
      out.body.coverage = true;
    }
    else if (arg === '--coverage-submit') {
      out.body.coverage = true;
      out.body.dryRun = false;
    }
    else if (arg === '--coverage-count') {
      out.body.coverage = true;
      out.body.coverageCount = Number(next());
    }
    else if (arg === '--browser-scan-timeout') {
      out.body.browserScanTimeoutMs = Number(next());
    }
    else if (arg === '--all-above-score') {
      out.body.applyAllAboveScore = true;
      out.body.stopMode = 'all_above_score';
    }
    else if (arg === '--skip-preflight') out.body.preflight = false;
    else if (arg === '--retry-blocked') out.body.retryBlocked = true;
    else if (arg === '--retry-blocked-host') {
      if (!Array.isArray(out.body.retryBlockedHosts)) out.body.retryBlockedHosts = [];
      out.body.retryBlockedHosts.push(String(next()).trim().toLowerCase());
    }
    else if (arg === '--no-evidence') out.body.requireEvidence = false;
    else if (arg === '--target') out.body.targetConfirmed = Number(next());
    else if (arg === '--threshold') out.body.threshold = Number(next());
    else if (arg === '--max-gaps') out.body.maxGaps = Number(next());
    else if (arg === '--source-target') out.body.sourceTarget = Number(next());
    else if (arg === '--attempt-cap') out.body.attemptCap = Number(next());
    else if (arg === '--category') out.body.category = String(next()).trim().toLowerCase();
    else if (arg === '--run-id') out.runId = String(next()).trim();
    else if (arg === '--wait') out.wait = true;
    else if (arg === '--poll-seconds') out.pollSeconds = Number(next());
    else if (arg === '--timeout-minutes') out.timeoutMinutes = Number(next());
    else if (arg === '--json-lines') out.jsonLines = true;
    else if (arg === '--allow-resume') out.allowResume = true;
    else if (arg === '--port') out.port = Number(next());
    else if (arg === '--required-channel') {
      if (!Array.isArray(out.body.requiredChannels)) out.body.requiredChannels = [];
      out.body.requiredChannels.push(next());
    }
    else if (arg === '--required-strategy') {
      if (!Array.isArray(out.body.requiredStrategies)) out.body.requiredStrategies = [];
      out.body.requiredStrategies.push(next());
    }
    else if (arg === '--coverage-strategy') {
      out.body.coverage = true;
      if (!Array.isArray(out.body.coverageStrategies)) out.body.coverageStrategies = [];
      out.body.coverageStrategies.push(next());
    }
    else if (arg === '--query') {
      if (!Array.isArray(out.body.queries)) out.body.queries = [];
      out.body.queries.push(next());
    } else if (arg === '--json') {
      Object.assign(out.body, JSON.parse(next()));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Invalid --port');
  if (!Number.isFinite(out.pollSeconds) || out.pollSeconds < 1 || out.pollSeconds > 300) throw new Error('Invalid --poll-seconds');
  if (!Number.isFinite(out.timeoutMinutes) || out.timeoutMinutes < 1) throw new Error('Invalid --timeout-minutes');
  if (Array.isArray(out.body.retryBlockedHosts)) {
    out.body.retryBlockedHosts = out.body.retryBlockedHosts.filter(Boolean);
  }
  applyCategoryOptions(out.body);
  return out;
}

function applyCategoryOptions(body) {
  const category = String(body && body.category || '').trim().toLowerCase();
  if (!category) return body;
  const aliases = {
    linkedin: 'linkedin_easy_apply', linkedin_easy_apply: 'linkedin_easy_apply',
    indeed: 'indeed_apply', indeed_apply: 'indeed_apply',
    greenhouse: 'greenhouse', workday: 'workday', ashby: 'ashby', lever: 'lever',
    smartrecruiters: 'smartrecruiters', generic: 'generic', fallback: 'generic',
  };
  const resolved = aliases[category];
  if (!resolved) throw new Error(`Unknown --category: ${category}`);
  body.category = resolved;
  body.coverage = true;
  body.coverageCount = body.coverageCount != null ? body.coverageCount : Math.max(1, Number(body.targetConfirmed) || 1);
  if (resolved === 'linkedin_easy_apply' || resolved === 'indeed_apply') {
    body.requiredChannels = [resolved];
    body.coverageChannels = [resolved];
    body.coverageStrategies = [];
    body.channelAllow = [resolved];
    if (resolved === 'linkedin_easy_apply') body.includeAssisted = true;
  } else {
    body.requiredStrategies = [resolved];
    body.coverageChannels = [];
    body.coverageStrategies = [resolved];
    body.channelAllow = ['external'];
    body.atsAllow = [resolved];
  }
  return body;
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (_) { data = { raw: text }; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (_) { data = { raw: text }; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function summarize(result) {
  const data = result.data || {};
  const apply = data.apply || {};
  const source = data.source || {};
  const planningDrops = apply.planningDrops || null;
  const dropCounts = planningDrops && planningDrops.counts && typeof planningDrops.counts === 'object'
    ? Object.entries(planningDrops.counts)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }))
    : null;
  return {
    success: data.success === true,
    status: result.status,
    runId: data.runId || apply.runId || null,
    statusUrl: data.statusUrl || null,
    eventsUrl: data.eventsUrl || null,
    planned: apply.planned ?? null,
    byChannel: apply.byChannel || null,
    byStrategy: apply.byStrategy || null,
    coverage: apply.coverage || null,
    coverageCount: apply.coverageCount || null,
    channelCoverage: apply.channelCoverage || null,
    strategyCoverage: apply.strategyCoverage || null,
    sourceWrote: source.wrote ?? null,
    sourceGate: source.report && source.report.gate ? {
      pass: source.report.gate.pass,
      uniqueIds: source.report.gate.uniqueIds,
      modalities: source.report.gate.modalities,
    } : null,
    browserScan: source.report && source.report.browserScan ? source.report.browserScan : null,
    planningDrops: planningDrops ? { total: planningDrops.total, topReasons: dropCounts } : null,
    report: apply.report || null,
    error: data.error || apply.error || source.error || null,
  };
}

function summarizeStatus(result) {
  const data = result.data || {};
  const run = data.run || null;
  return {
    success: result.ok && data.ok !== false,
    status: result.status,
    clients: data.clients,
    active: data.active,
    run,
    report: data.report || null,
    blocked: data.blocked || null,
    lastFailure: data.lastFailure || null,
    error: data.error || null,
  };
}

function summarizeReport(result) {
  const data = result.data || {};
  return {
    success: result.ok && data.success !== false,
    status: result.status,
    runId: data.runId || null,
    file: data.file || null,
    bytes: data.bytes ?? null,
    retestFile: data.retestFile || null,
    retestBytes: data.retestBytes ?? null,
    error: data.error || null,
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function terminalStatus(status) {
  return /^(done|exhausted|day_changed|aborted|cancelled|failed)$/i.test(String(status || ''));
}

function compactProgress(data) {
  const run = data && data.run || {};
  return {
    runId: run.runId || null,
    status: run.status || '',
    phase: run.phase || '',
    category: run.category || '',
    progress: `${Math.min(Number(run.currentIndex) || 0, Number(run.total) || 0)}/${Number(run.total) || 0}`,
    attempt: run.attempt || 0,
    targetConfirmed: run.targetConfirmed,
    confirmed: run.confirmed || 0,
    unverified: run.unverified || 0,
    failed: run.failed || 0,
    skipped: run.skipped || 0,
    currentJob: run.currentJob ? `${run.currentJob.company || ''} — ${run.currentJob.title || ''}`.trim() : null,
    health: run.health || '',
    secondsSinceTransition: run.secondsSinceTransition || 0,
    nextAction: run.nextAction || '',
    terminalReason: run.terminalReason || null,
    reportPath: run.reportPath || data && data.report && data.report.file || null,
  };
}

function watchExitCode(progress) {
  if (!progress) return 6;
  if (progress.health === 'disconnected') return 5;
  if (progress.health === 'manual') return 3;
  if (progress.status === 'done' && progress.targetConfirmed != null && progress.confirmed >= progress.targetConfirmed) return 0;
  if (progress.status === 'done' && progress.targetConfirmed != null && progress.confirmed < progress.targetConfirmed) return 2;
  if (progress.status === 'exhausted') return 2;
  if (/^(aborted|cancelled|failed|day_changed)$/i.test(progress.status || '')) return 4;
  return 0;
}

async function watchRun(parsed, runId) {
  if (!runId) throw new Error('watch requires --run-id, a runId returned by start, or a saved local handoff');
  const encoded = encodeURIComponent(runId);
  const started = Date.now();
  const timeoutMs = parsed.timeoutMinutes * 60 * 1000;
  let lastSignature = '';
  let lastPrintedAt = 0;
  let recoveryAttempts = 0;
  let missingRunRetries = 0;
  while (Date.now() - started <= timeoutMs) {
    const status = await getJson(parsed.port, `/apply-runs/${encoded}`);
    if (!status.ok || !status.data || status.data.ok === false) {
      // The service worker may be briefly unavailable while an application tab is opening. The
      // exact-run endpoint must never fall back to a different run, but a bounded retry prevents a
      // transient storage/WS gap from detaching the watcher from the run it just started.
      if (status.status === 404 && missingRunRetries < 2) {
        missingRunRetries++;
        process.stdout.write(JSON.stringify({ runId, status: 'status_retry', httpStatus: 404,
          attempt: missingRunRetries, reason: 'exact run temporarily unavailable' }) + '\n');
        await sleep(Math.min(parsed.pollSeconds * 1000, 2000));
        continue;
      }
      process.stdout.write(JSON.stringify({ runId, status: 'status_error', httpStatus: status.status,
        error: status.data && status.data.error || 'status request failed' }) + '\n');
      return status.status === 404 ? 6 : 5;
    }
    missingRunRetries = 0;
    const progress = compactProgress(status.data);
    if (progress.runId !== runId) {
      process.stdout.write(JSON.stringify({ runId, status: 'ownership_mismatch', observedRunId: progress.runId }) + '\n');
      return 6;
    }
    const signature = JSON.stringify({ status: progress.status, phase: progress.phase, progress: progress.progress,
      confirmed: progress.confirmed, failed: progress.failed, skipped: progress.skipped,
      unverified: progress.unverified, currentJob: progress.currentJob, health: progress.health,
      nextAction: progress.nextAction });
    if (signature !== lastSignature || Date.now() - lastPrintedAt >= 60000) {
      process.stdout.write(parsed.jsonLines ? JSON.stringify(progress) + '\n' :
        `[${new Date().toISOString()}] ${progress.runId} ${progress.status}/${progress.phase} ` +
        `${progress.progress} confirmed=${progress.confirmed}/${progress.targetConfirmed ?? '?'} ` +
        `failed=${progress.failed} skipped=${progress.skipped} health=${progress.health}` +
        `${progress.currentJob ? ` current="${progress.currentJob}"` : ''}\n`);
      lastSignature = signature;
      lastPrintedAt = Date.now();
      writeRunHandoff({ runId, port: parsed.port, status: progress.status,
        category: progress.category, reportPath: progress.reportPath }, parsed.handoffFile);
    }
    if (terminalStatus(progress.status)) {
      const report = await postJson(parsed.port, '/export-apply-report', { runId });
      const reportSummary = summarizeReport(report);
      writeRunHandoff({ runId, port: parsed.port, status: progress.status,
        category: progress.category, reportPath: reportSummary.file || progress.reportPath }, parsed.handoffFile);
      process.stdout.write(JSON.stringify({ terminal: progress, report: reportSummary }, null, parsed.jsonLines ? 0 : 2) + '\n');
      return watchExitCode(progress);
    }
    if (progress.health === 'disconnected') return 5;
    if (progress.health === 'manual') return 3;
    if (progress.health === 'stalled') {
      if (recoveryAttempts === 0) {
        await getJson(parsed.port, '/inspect-apply');
        recoveryAttempts = 1;
      } else if (recoveryAttempts === 1 && parsed.allowResume) {
        const resumed = await postJson(parsed.port, `/apply-runs/${encoded}/resume`, {});
        if (!resumed.ok || resumed.data && resumed.data.ok === false) return 4;
        recoveryAttempts = 2;
      } else {
        process.stdout.write(JSON.stringify({ runId, status: 'stalled', action: 'stop_for_fix',
          reason: 'handler remained stalled after bounded inspection/recovery' }) + '\n');
        return 4;
      }
    } else if (progress.health === 'healthy' || progress.health === 'waiting') recoveryAttempts = 0;
    await sleep(parsed.pollSeconds * 1000);
  }
  process.stdout.write(JSON.stringify({ runId, status: 'watch_timeout', timeoutMinutes: parsed.timeoutMinutes }) + '\n');
  return 4;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = readArgs(argv);
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }
    if (parsed.command === 'status') {
      const status = await getJson(parsed.port, parsed.runId
        ? `/apply-runs/${encodeURIComponent(parsed.runId)}` : '/apply-status');
      process.stdout.write(JSON.stringify(summarizeStatus(status), null, 2) + '\n');
      if (!status.ok || status.data && status.data.ok === false) process.exitCode = 1;
      return;
    }
    if (parsed.command === 'watch') {
      const handoff = parsed.runId ? null : readRunHandoff(parsed.handoffFile);
      const code = await watchRun(parsed, parsed.runId || handoff && handoff.runId);
      process.exitCode = code;
      return;
    }
    if (parsed.command === 'report') {
      const report = await postJson(parsed.port, '/export-apply-report', Object.assign({}, parsed.body,
        parsed.runId ? { runId: parsed.runId } : {}));
      process.stdout.write(JSON.stringify(summarizeReport(report), null, 2) + '\n');
      if (!report.ok || report.data && report.data.success === false) process.exitCode = 1;
      return;
    }
    if (parsed.command === 'preflight') {
      const preflight = await getJson(parsed.port, '/one-click-preflight');
      process.stdout.write(JSON.stringify({ success: preflight.ok && preflight.data && preflight.data.ok !== false,
        status: preflight.status, preflight: preflight.data }, null, 2) + '\n');
      if (!preflight.ok || preflight.data && preflight.data.ok === false) process.exitCode = 1;
      return;
    }
    if (parsed.body.preflight !== false) {
      const preflight = await getJson(parsed.port, '/one-click-preflight');
      if (!preflight.ok || preflight.data && preflight.data.ok === false) {
        process.stdout.write(JSON.stringify({ success: false, stage: 'preflight', preflight: preflight.data }, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }
    }
    const result = await postJson(parsed.port, '/apply-all', parsed.body);
    const summary = summarize(result);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    if (!result.ok || result.data && result.data.success === false) process.exitCode = 1;
    else {
      writeRunHandoff({ runId: summary.runId, port: parsed.port, status: 'started',
        category: parsed.body.category }, parsed.handoffFile);
      if (parsed.wait) process.exitCode = await watchRun(parsed, summary.runId);
    }
  } catch (e) {
    process.stderr.write(`pja-apply-all: ${e.message}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { readArgs, applyCategoryOptions, summarize, summarizeStatus, summarizeReport,
  compactProgress, terminalStatus, watchExitCode, readRunHandoff, writeRunHandoff, watchRun, main };
