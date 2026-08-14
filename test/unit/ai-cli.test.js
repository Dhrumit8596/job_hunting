'use strict';

module.exports = t => {
  const { DEFAULT_CODEX_MODEL, normalizeEnginePreference, parseEngine, commandFor,
    codexModel, codexReasoningEffort, parseCodexJsonl, parseOutput } = require('../../ai-cli');

  t.eq(parseEngine([], {}), 'claude', 'AI CLI: Claude remains the default');
  t.eq(parseEngine([], { PJA_AI_ENGINE: 'codex' }), 'codex', 'AI CLI: environment selects Codex');
  t.eq(parseEngine(['--engine', 'codex'], { PJA_AI_ENGINE: 'claude' }), 'codex', 'AI CLI: flag overrides environment');
  t.eq(parseEngine(['--engine=CLAUDE'], {}), 'claude', 'AI CLI: equals flag is case-insensitive');
  t.eq(normalizeEnginePreference(' Codex '), 'codex', 'AI CLI: profile/storage engine preference is normalized');
  t.eq(normalizeEnginePreference('bad'), '', 'AI CLI: invalid profile/storage engine preference is ignored');
  let rejected = false;
  try { parseEngine(['--engine=nope'], {}); } catch (_) { rejected = true; }
  t.ok(rejected, 'AI CLI: invalid engine is rejected');

  const codex = commandFor('codex', 'SYSTEM', {});
  t.eq(codex.command, 'codex', 'AI CLI: Codex executable selected');
  t.ok(codex.args.includes('exec') && codex.args.includes('--json'), 'AI CLI: Codex uses machine-readable non-interactive mode');
  t.ok(codex.args.includes('--ephemeral') && codex.args.includes('read-only'), 'AI CLI: Codex run is ephemeral and read-only');
  t.ok(codex.args.includes(DEFAULT_CODEX_MODEL), 'AI CLI: Codex defaults to lightweight structured-task model');
  t.ok(codex.args.includes('model_reasoning_effort="low"'), 'AI CLI: Codex defaults to low reasoning effort');
  t.ok(codex.args.includes('project_doc_max_bytes=0'),
    'AI CLI: structured scoring does not reload repository AGENTS context on every call');
  t.ok(codex.inputPrefix.includes('SYSTEM'), 'AI CLI: system prompt is preserved for Codex');
  const customCodex = commandFor('codex', 'SYSTEM', { PJA_CODEX_MODEL: 'custom-model', PJA_CODEX_REASONING_EFFORT: 'medium' });
  t.ok(customCodex.args.includes('custom-model') && customCodex.args.includes('model_reasoning_effort="medium"'),
    'AI CLI: Codex model and effort can be overridden');
  t.eq(codexModel({ PJA_CODEX_MODEL: 'default' }), '', 'AI CLI: default sentinel omits explicit model override');
  t.eq(codexReasoningEffort({ PJA_CODEX_REASONING_EFFORT: 'HIGH' }), 'high', 'AI CLI: effort is normalized');
  let badEffort = false;
  try { codexReasoningEffort({ PJA_CODEX_REASONING_EFFORT: 'ultra' }); } catch (_) { badEffort = true; }
  t.ok(badEffort, 'AI CLI: unsupported effort is rejected');

  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })
  ].join('\n');
  t.eq(parseCodexJsonl(events), '{"ok":true}', 'AI CLI: final Codex agent message is extracted');
  t.eq(parseOutput('claude', '{"result":"hello"}'), 'hello', 'AI CLI: Claude envelope remains supported');

  const serverSource = require('fs').readFileSync(require('path').resolve(__dirname, '../../dev-server.js'), 'utf8');
  t.ok(serverSource.includes('aiConfig') && serverSource.includes('reasoningEffort: codexReasoningEffort()'),
    'AI CLI: health endpoint exposes the effective lightweight configuration');
};
