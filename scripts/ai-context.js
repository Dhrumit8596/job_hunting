#!/usr/bin/env node
'use strict';

// Compact orientation for coding agents. This intentionally prints a map, not source contents:
// use it to choose the smallest relevant file/test set before opening large browser scripts.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scopes = {
  overview: {
    purpose: 'Unified one-click product and cross-process boundaries',
    files: [
      ['PROJECT_GOAL.md', 'north-star behavior'],
      ['ARCHITECTURE.md', 'authoritative runtime diagrams and module status'],
      ['AI_DEVELOPMENT.md', 'small-context workflow and change recipes'],
      ['AGENTS.md', 'load-bearing repository rules'],
      ['package.json', 'commands and dependencies'],
      ['manifest.json', 'browser entry points and load order'],
    ],
    tests: ['test/unit/one-click-entrypoints.test.js', 'test/unit/channel-coverage-gate.test.js'],
  },
  apply: {
    purpose: 'Ranked dispatch, ATS routing, form fill, outcome recording, and recovery',
    files: [
      ['background.js', 'master ranked queue, dispatch, watchdog, WS bridge'],
      ['sourcing/apply-select.js', 'pure apply eligibility and result-state policy'],
      ['content/apply-router.js', 'pure strategy registry and executable dispatch contract'],
      ['content/external-apply.js', 'external ATS executor and terminal diagnostics'],
      ['content/auto-apply.js', 'LinkedIn Easy Apply engine'],
      ['content/indeed-apply.js', 'Indeed Apply engine'],
      ['content/autofill.js', 'shared field rules and React-aware fillers'],
      ['application-ledger.js', 'confirmed/submitted/failed event reduction'],
    ],
    tests: ['test/unit/ranked-dispatch.test.js', 'test/unit/external-apply.test.js', 'test/unit/easyapply.test.js', 'test/unit/indeed-apply.test.js', 'test/unit/application-ledger.test.js'],
  },
  sourcing: {
    purpose: 'Discovery, normalization, hydration, dedupe, filtering, and corpus storage',
    files: [
      ['sourcing/source-run.js', 'current /source-v2 orchestrator'],
      ['sourcing/adapters/index.js', 'adapter registry'],
      ['sourcing/sources.json', 'configured company boards'],
      ['sourcing/browser-import.js', 'LinkedIn/Indeed/Glassdoor normalization'],
      ['sourcing/filter.js', 'eligibility and location policy'],
      ['sourcing/dedupe.js', 'applied identity and dedupe'],
      ['sourcing/jobstore.js', 'normalized in-memory corpus assembly'],
      ['idb-store.js', 'extension IndexedDB corpus source of truth'],
    ],
    tests: ['test/unit/source-run.test.js', 'test/unit/sourcing.test.js', 'test/unit/browser-import.test.js', 'test/unit/jobstore.test.js'],
  },
  ai: {
    purpose: 'Local Claude/Codex invocation and bounded scoring/question prompts',
    files: [
      ['ai-cli.js', 'engine/model/effort selection and process invocation'],
      ['scoring-context.js', 'bounded requirement-focused job-description context'],
      ['dev-server.js', 'scoreAll, /batch-score, /answer-questions, /apply-help'],
    ],
    tests: ['test/unit/ai-cli.test.js', 'test/unit/scoring-context.test.js', 'test/unit/answer-correctness.test.js'],
  },
  storage: {
    purpose: 'Chrome storage contracts, IndexedDB corpus, queue ownership, and ledger state',
    files: [
      ['idb-store.js', 'normalized job corpus and state'],
      ['application-ledger.js', 'append-only evidence ledger'],
      ['background.js', 'storage guards and WS storage commands'],
      ['DEVNOTES.md', 'storage key reference'],
    ],
    tests: ['test/unit/idb-store.test.js', 'test/unit/application-ledger.test.js', 'test/unit/jobstore.test.js'],
  },
  logs: {
    purpose: 'Failure evidence, run reports, recovery clusters, and retest workflow',
    files: [
      ['OBSERVABILITY.md', 'failure contract and diagnostic workflow'],
      ['dev-server.js', 'report builders and export endpoints'],
      ['content/external-apply.js', 'terminal diagnostic capture'],
      ['application-ledger.js', 'outcome evidence semantics'],
    ],
    tests: ['test/unit/required-field-diagnostics.test.js', 'test/unit/applied-log.test.js', 'test/unit/confirmation.test.js'],
  },
  ui: {
    purpose: 'Popup one-click entry, shortlist review, settings, and page sidebar',
    files: [
      ['popup/popup.js', 'primary one-click entry and status'],
      ['shortlist/shortlist.js', 'corpus review and alternate ranked launcher'],
      ['settings/settings.js', 'profile, preferences, answers, resume'],
      ['content/content.js', 'page sidebar and legacy/manual queue UI'],
    ],
    tests: ['test/unit/content-ui.test.js', 'test/unit/one-click-entrypoints.test.js'],
  },
};

function lineCount(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/).length; }
  catch (_) { return 0; }
}

function printScope(name) {
  const scope = scopes[name];
  if (!scope) {
    process.stderr.write(`Unknown context scope "${name}". Choose: ${Object.keys(scopes).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`# AI context: ${name}\n${scope.purpose}\n\nRead only these first:\n`);
  for (const [file, purpose] of scope.files) {
    const lines = lineCount(file);
    process.stdout.write(`- ${file}${lines ? ` (${lines} lines)` : ''}: ${purpose}\n`);
  }
  process.stdout.write(`\nNearest tests:\n${scope.tests.map(x => `- ${x}`).join('\n')}\n`);
}

const requested = String(process.argv[2] || 'overview').trim().toLowerCase();
if (requested === '--help' || requested === '-h' || requested === 'help') {
  process.stdout.write(`Usage: npm run context -- [scope]\nScopes: ${Object.keys(scopes).join(', ')}\n`);
} else {
  printScope(requested);
}
