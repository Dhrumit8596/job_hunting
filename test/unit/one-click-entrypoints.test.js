'use strict';

const fs = require('fs');
const path = require('path');

module.exports = (t) => {
  const root = path.resolve(__dirname, '../..');
  const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const popupCss = fs.readFileSync(path.join(root, 'popup/popup.css'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cli = fs.readFileSync(path.join(root, 'scripts/pja-apply-all.js'), 'utf8');
  const dev = fs.readFileSync(path.join(root, 'dev-server.js'), 'utf8');

  t.ok(
    popupHtml.includes('id="btn-one-click-apply"') &&
    popupHtml.includes('id="btn-one-click-refresh"') &&
    popupHtml.includes('id="btn-one-click-report"') &&
    popupHtml.includes('Find &amp; Apply') &&
    popupJs.includes("fetch(`${PJA_DEV_SERVER}/one-click-preflight`") &&
    popupJs.includes("fetch(`${PJA_DEV_SERVER}/apply-all`") &&
    popupJs.includes("fetch(`${PJA_DEV_SERVER}/apply-status`") &&
    popupJs.includes("fetch(`${PJA_DEV_SERVER}/export-apply-report`") &&
    popupJs.includes('data.blocked && data.blocked.records') &&
    popupJs.includes('ONE_CLICK_DEFAULTS') &&
    popupJs.includes('maxGaps: 20') &&
    popupCss.includes('.one-click-bar') &&
    popupCss.includes('.one-click-actions'),
    'popup exposes a single Find & Apply area with live status and report export controls'
  );

  t.ok(
    pkg.scripts['apply:all'] === 'node scripts/pja-apply-all.js' &&
    pkg.scripts['apply:all:dry-run'] === 'node scripts/pja-apply-all.js --dry-run' &&
    pkg.scripts['apply:status'] === 'node scripts/pja-apply-all.js status' &&
    pkg.scripts['apply:report'] === 'node scripts/pja-apply-all.js report' &&
    pkg.scripts['apply:preflight'] === 'node scripts/pja-apply-all.js preflight' &&
    cli.includes("postJson(parsed.port, '/apply-all', parsed.body)") &&
    cli.includes("getJson(parsed.port, '/one-click-preflight')") &&
    cli.includes("getJson(parsed.port, '/apply-status')") &&
    cli.includes("postJson(parsed.port, '/export-apply-report', parsed.body)") &&
    cli.includes('Commands:') &&
    cli.includes('--query <text>') &&
    cli.includes('--retry-blocked') &&
    cli.includes('--retry-blocked-host <h>') &&
    cli.includes('--all-above-score') &&
    cli.includes('--required-channel <c>') &&
    cli.includes('--required-strategy <s>') &&
    cli.includes('--coverage') &&
    cli.includes('--coverage-count <n>') &&
    cli.includes('--coverage-strategy <s>') &&
    cli.includes('--coverage-all-supported') &&
    cli.includes('--coverage-submit') &&
    cli.includes('--browser-scan-timeout <n>') &&
    cli.includes('--attempt-cap <n>') &&
    cli.includes('retryBlockedHosts') &&
    cli.includes('planningDrops') &&
    cli.includes('topReasons') &&
    cli.includes('report: apply.report || null') &&
    cli.includes('--max-gaps <n>') &&
    cli.includes('--dry-run'),
    'CLI exposes first-class start/status/report/preflight commands for the same one-click flow'
  );

  t.ok(
    dev.includes("req.url === '/export-apply-report'") &&
    dev.includes("req.url === '/one-click-preflight'") &&
    dev.includes("req.url === '/apply-status'") &&
    dev.includes('summarizeApplyStatus') &&
    dev.includes('maybeAutoExportApplyReport') &&
    dev.includes('isTerminalApplyStatus') &&
    dev.includes('groupedReportRows') &&
    dev.includes('developerRecommendation') &&
    dev.includes('summarizeBlockedFromLedger') &&
    dev.includes('blocked: summarizeBlockedFromLedger(storage)') &&
    dev.includes('planningDrops: planningDrops || null') &&
    dev.includes('function writeApplyPlanningReport') &&
    dev.includes('function appendPlanningDrop') &&
    dev.includes('rescore_below_threshold') &&
    dev.includes('rescore_missing_description') &&
    dev.includes('dry_run_nothing_eligible') &&
    dev.includes('dry_run_planned') &&
    dev.includes('## Planning drops before launch') &&
    dev.includes('## Failure/drop groups') &&
    dev.includes('## Highest reward fix clusters') &&
    dev.includes('## Per-job failure diagnostics') &&
    dev.includes('buildRetestManifest') &&
    dev.includes('retestFile') &&
    dev.includes('pja_apply_diagnostics') &&
    dev.includes('### By reason') &&
    dev.includes('### Recommended developer focus') &&
    dev.includes('Automation/confirmation gap') &&
    dev.includes('oneClickPreflight') &&
    dev.includes('for (let attempt = 0; attempt < 3; attempt += 1)') &&
    dev.includes("Object.prototype.hasOwnProperty.call(st, 'pja_resume_filename')") &&
    dev.includes('extension_not_connected') &&
    dev.includes('writeApplyRunReport') &&
    dev.includes('pja_ranked_apply') &&
    dev.includes('pja_last_completed_apply_run') &&
    dev.includes('applyAllAboveScore') &&
    dev.includes('requiredStrategies') &&
    dev.includes('strategyCoverage') &&
    dev.includes('DEFAULT_COVERAGE_CHANNELS') &&
    dev.includes('DEFAULT_COVERAGE_STRATEGIES') &&
    dev.includes('coverageMode') &&
    dev.includes('waitForBrowserChannelCoverage') &&
    dev.includes('browserScan') &&
    dev.includes("await launch('linkedin'") &&
    dev.includes("{ fast: false }") &&
    dev.includes('counts.hydrated = hydrated') &&
    dev.includes('lastCounts.hydrated?.linkedin_easy_apply') &&
    dev.includes('## Strategy coverage matrix') &&
    dev.includes('pja_application_ledger') &&
    dev.includes('This report intentionally omits candidate profile values'),
    'dev server can export sanitized apply-run failure/drop reports to reports/*.md'
  );
};
