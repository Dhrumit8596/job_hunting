#!/usr/bin/env node
'use strict';

const http = require('http');

function usage() {
  return `Usage: npm run apply:all -- [command] [options]

Starts or inspects the unified one-click flow through the local dev server:
source jobs → score/rank → route by channel/ATS → apply → log outcomes.

Commands:
  start                    Start the one-click flow (default)
  status                   Show compact active/last ranked-run progress
  report                   Export the sanitized developer markdown report
  preflight                Check readiness without starting a run

Options:
  --dry-run                 Plan only; do not submit applications
  --target <n>              Confirmed-application target (default: 20)
  --all-above-score         Apply every qualified job above threshold instead of stopping at target
  --threshold <n>           Minimum fit score (default: 70)
  --max-gaps <n>            Maximum scored gaps allowed (default: 20)
  --source-target <n>       Sourcing target before ranking
  --attempt-cap <n>         Maximum attempted jobs; 0 means no attempt cap
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
      maxGaps: 20,
      perCompanyCap: 2,
      includeAssisted: true,
      e2eSafe: true,
      rescore: true,
      requireEvidence: true,
    },
    port: Number(process.env.PJA_DEV_PORT || 6174),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (i === 0 && /^(start|status|report|preflight)$/i.test(arg)) {
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
  if (Array.isArray(out.body.retryBlockedHosts)) {
    out.body.retryBlockedHosts = out.body.retryBlockedHosts.filter(Boolean);
  }
  return out;
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
    runId: apply.runId || null,
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

(async () => {
  try {
    const parsed = readArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }
    if (parsed.command === 'status') {
      const status = await getJson(parsed.port, '/apply-status');
      process.stdout.write(JSON.stringify(summarizeStatus(status), null, 2) + '\n');
      if (!status.ok || status.data && status.data.ok === false) process.exitCode = 1;
      return;
    }
    if (parsed.command === 'report') {
      const report = await postJson(parsed.port, '/export-apply-report', parsed.body);
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
    process.stdout.write(JSON.stringify(summarize(result), null, 2) + '\n');
    if (!result.ok || result.data && result.data.success === false) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`pja-apply-all: ${e.message}\n\n${usage()}`);
    process.exitCode = 1;
  }
})();
