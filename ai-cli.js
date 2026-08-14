'use strict';

const { spawn } = require('child_process');

const SUPPORTED_ENGINES = new Set(['claude', 'codex']);
const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
const DEFAULT_CODEX_REASONING_EFFORT = 'low';
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeEnginePreference(value) {
  const engine = String(value || '').trim().toLowerCase();
  return SUPPORTED_ENGINES.has(engine) ? engine : '';
}

function parseEngine(argv = process.argv.slice(2), env = process.env) {
  let requested = env.PJA_AI_ENGINE || 'claude';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--engine' && argv[i + 1]) requested = argv[++i];
    else if (argv[i].startsWith('--engine=')) requested = argv[i].slice('--engine='.length);
  }
  const engine = normalizeEnginePreference(requested);
  if (!engine) {
    throw new Error(`Unsupported AI engine "${requested}" (expected claude or codex)`);
  }
  return engine;
}

function codexModel(env = process.env) {
  const value = String(env.PJA_CODEX_MODEL || DEFAULT_CODEX_MODEL).trim();
  return /^(default|auto)$/i.test(value) ? '' : value;
}

function codexReasoningEffort(env = process.env) {
  const value = String(env.PJA_CODEX_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT).trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.has(value)) {
    throw new Error(`Unsupported PJA_CODEX_REASONING_EFFORT "${value}"`);
  }
  return value;
}

function commandFor(engine, systemPrompt, env = process.env) {
  if (engine === 'codex') {
    const model = codexModel(env);
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config'];
    if (model) args.push('--model', model);
    args.push('--config', `model_reasoning_effort="${codexReasoningEffort(env)}"`,
      '--config', 'project_doc_max_bytes=0',
      '--sandbox', 'read-only', '--skip-git-repo-check', '-');
    return {
      command: 'codex',
      args,
      inputPrefix: `Follow these instructions as the system-level task for this request:\n\n${systemPrompt}\n\nUser request:\n`
    };
  }
  return {
    command: 'claude',
    args: ['--print', '--system-prompt', systemPrompt, '--output-format', 'json', '--no-session-persistence', '--model', 'haiku'],
    inputPrefix: ''
  };
}

function parseCodexJsonl(stdout) {
  let result = '';
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    const item = event.item || {};
    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      result = item.text;
    }
  }
  if (!result) throw new Error('codex returned no final agent message');
  return result;
}

function parseOutput(engine, stdout) {
  if (engine === 'codex') return parseCodexJsonl(stdout);
  try {
    const envelope = JSON.parse(String(stdout).trim());
    return envelope.result || String(stdout).trim();
  } catch (_) {
    return String(stdout).trim();
  }
}

function runAiCli({ engine, systemPrompt, userPrompt, timeoutMs = 90000, env = process.env, spawnImpl = spawn }) {
  const spec = commandFor(engine, systemPrompt, env);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, { env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(reject, new Error(`${engine} CLI timeout`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => finish(reject, new Error(`Cannot run ${engine} CLI: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim() || 'no diagnostic output').slice(0, 300);
        finish(reject, new Error(`${engine} exited ${code}: ${detail}`));
      }
      else {
        try { finish(resolve, parseOutput(engine, stdout)); }
        catch (e) { finish(reject, e); }
      }
    });
    child.stdin.write(spec.inputPrefix + userPrompt);
    child.stdin.end();
  });
}

module.exports = { SUPPORTED_ENGINES, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT,
  normalizeEnginePreference, parseEngine, codexModel, codexReasoningEffort,
  commandFor, parseCodexJsonl, parseOutput, runAiCli };
