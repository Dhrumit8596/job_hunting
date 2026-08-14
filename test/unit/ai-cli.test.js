'use strict';

module.exports = t => {
  const { normalizeEnginePreference, parseEngine, commandFor, parseCodexJsonl, parseOutput } = require('../../ai-cli');

  t.eq(parseEngine([], {}), 'claude', 'AI CLI: Claude remains the default');
  t.eq(parseEngine([], { PJA_AI_ENGINE: 'codex' }), 'codex', 'AI CLI: environment selects Codex');
  t.eq(parseEngine(['--engine', 'codex'], { PJA_AI_ENGINE: 'claude' }), 'codex', 'AI CLI: flag overrides environment');
  t.eq(parseEngine(['--engine=CLAUDE'], {}), 'claude', 'AI CLI: equals flag is case-insensitive');
  t.eq(normalizeEnginePreference(' Codex '), 'codex', 'AI CLI: profile/storage engine preference is normalized');
  t.eq(normalizeEnginePreference('bad'), '', 'AI CLI: invalid profile/storage engine preference is ignored');
  let rejected = false;
  try { parseEngine(['--engine=nope'], {}); } catch (_) { rejected = true; }
  t.ok(rejected, 'AI CLI: invalid engine is rejected');

  const codex = commandFor('codex', 'SYSTEM');
  t.eq(codex.command, 'codex', 'AI CLI: Codex executable selected');
  t.ok(codex.args.includes('exec') && codex.args.includes('--json'), 'AI CLI: Codex uses machine-readable non-interactive mode');
  t.ok(codex.args.includes('--ephemeral') && codex.args.includes('read-only'), 'AI CLI: Codex run is ephemeral and read-only');
  t.ok(codex.inputPrefix.includes('SYSTEM'), 'AI CLI: system prompt is preserved for Codex');

  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })
  ].join('\n');
  t.eq(parseCodexJsonl(events), '{"ok":true}', 'AI CLI: final Codex agent message is extracted');
  t.eq(parseOutput('claude', '{"result":"hello"}'), 'hello', 'AI CLI: Claude envelope remains supported');
};
