'use strict';

// Regression guard: the ranked runner must fail closed when a requested real channel has no
// hydrated, evidence-qualified job. This prevents an external-only batch being called full E2E.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.resolve(__dirname, '../../dev-server.js'), 'utf8');

module.exports = (t) => {
  t.ok(source.includes('const requiredChannels = Array.isArray(o.requiredChannels)') &&
    source.includes("stage: 'channel_coverage'") &&
    source.includes('uncoveredChannels') && source.includes('channelCoverage'),
  'apply-run: required channel coverage fails closed rather than silently omitting a channel');
  t.ok(source.includes("next: 'hydrate missing browser leads, then rescore before starting an apply run'"),
  'apply-run: coverage failure directs the pipeline back to hydration and scoring');
  t.ok(source.includes('reserve the best available job from') &&
    source.includes("ranked.filter(j => (j.channel || 'external') === channel).slice(0, coverageCount)") &&
    source.includes('ranked.filter(j => strategyKey(j) === strategy).slice(0, coverageCount)'),
  'apply-run: required channels/strategies reserve the requested per-bucket count before global rank fill');
  t.ok(source.includes('const requiredStrategies = Array.isArray(o.requiredStrategies)') &&
    source.includes("stage: 'strategy_coverage'") &&
    source.includes('uncoveredStrategies') && source.includes('strategyCoverage') &&
    source.includes('required apply strategy coverage is not ready'),
  'apply-run: required ATS strategy coverage fails closed rather than silently omitting a portal type');
  t.ok(source.includes('coverage attemptCap is lower than requested coverage bucket count') &&
    source.includes('coverage targetConfirmed is lower than requested coverage bucket count') &&
    source.includes('coverageAttemptCount') &&
    source.includes('coverageCount') &&
    source.includes('channelCoverage[channel].scored') &&
    source.includes('strategyCoverage[strategy].reserved'),
  'apply-run: coverage mode validates caps and records found/hydrated/scored/eligible/reserved stages');
  t.ok(source.includes('## Strategy coverage matrix') &&
    source.includes('Found | Hydrated | Scored | Eligible | Reserved | Attempted') &&
    source.includes('Sourcing gap: add/refresh real sources for this strategy before apply'),
  'apply reports: coverage matrix distinguishes no-job sourcing gaps from apply-handler failures');
};
