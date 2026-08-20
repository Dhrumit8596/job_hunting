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

function classifyAiCliFailure(value) {
  const text = String(value && value.message || value || '');
  if (/you(?:'|\u2019)?ve hit your usage limit|purchase more credits|insufficient[_ -]?quota|credit balance (?:is )?(?:exhausted|empty)/i.test(text)) {
    return { code: 'ai_engine_unavailable', reason: 'usage_limit', retryable: false };
  }
  if (/failed to load models cache/i.test(text) &&
      /missing field|base_instructions|invalid (?:schema|type|value|data)|did not match/i.test(text)) {
    return { code: 'ai_engine_unavailable', reason: 'models_cache_invalid', retryable: false };
  }
  if (/\b(?:enoent|eacces)\b|executable (?:not found|permission denied)|permission denied[^\n]*(?:codex|claude)/i.test(text)) {
    return { code: 'ai_engine_unavailable', reason: 'executable_unavailable', retryable: false };
  }
  if (/not authenticated|not logged in|\bunauthorized\b|authentication required|please (?:log|sign) in|login required|invalid api key|\bhttp 401\b/i.test(text)) {
    return { code: 'ai_engine_unavailable', reason: 'authentication_unavailable', retryable: false };
  }
  if (/(?:unknown|invalid|unsupported|unrecognized) (?:model|config(?:uration)?(?: key)?)|model[^\n]*(?:not found|does not exist|is not supported)|failed to parse config(?:uration)?|unsupported pja_codex_reasoning_effort|unsupported reasoning effort|(?:unexpected|unknown|unrecognized|invalid) (?:argument|option|flag)[^\n]*(?:--ignore-user-config|--ephemeral|--json|--sandbox|--skip-git-repo-check|--config|--model)/i.test(text)) {
    return { code: 'ai_engine_unavailable', reason: 'invalid_configuration', retryable: false };
  }
  if (/stream ended before turn\.completed/i.test(text)) {
    return { code: 'ai_cli_failed', reason: 'incomplete_stream', retryable: true };
  }
  if (/no final agent message|output parse failed/i.test(text)) {
    return { code: 'ai_cli_failed', reason: 'invalid_output', retryable: true };
  }
  if (/\b(?:rate limit|too many requests|http 429)\b/i.test(text)) {
    return { code: 'ai_cli_failed', reason: 'rate_limited', retryable: true };
  }
  if (/\btimeout\b|timed out/i.test(text)) {
    return { code: 'ai_cli_failed', reason: 'timeout', retryable: true };
  }
  if (/\b(?:econnreset|econnrefused|enetwork|network|socket|connection reset|temporary failure)\b/i.test(text)) {
    return { code: 'ai_cli_failed', reason: 'network_failure', retryable: true };
  }
  return { code: 'ai_cli_failed', reason: 'transient_cli_failure', retryable: true };
}

function aiCliError(engine, diagnostic) {
  const classified = classifyAiCliFailure(diagnostic);
  const state = classified.code === 'ai_engine_unavailable' ? 'unavailable' : 'failed';
  const error = new Error(`${engine} CLI ${state} (${classified.reason})`);
  error.code = classified.code;
  error.reason = classified.reason;
  error.retryable = classified.retryable;
  error.engine = engine;
  return error;
}

function codexStreamState(stdout) {
  let result = '';
  let completed = false;
  let failure = '';
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    const item = event.item || {};
    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      result = item.text;
    }
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') {
      const error = event.error;
      const detail = String(error && (error.message || error.detail) || event.message ||
        (typeof error === 'string' ? error : '') || '').trim();
      // Preserve an earlier structured diagnostic when a later terminal marker has no detail.
      // This is how Codex may report a useful type:error immediately before a bare turn.failed.
      if (detail) failure = detail;
      else if (!failure) failure = event.type === 'turn.failed' ? 'codex turn failed' : 'codex structured error';
    }
  }
  return { result, completed, failure };
}

function codexFailureDetail(stdout) {
  return codexStreamState(stdout).failure;
}

function parseCodexJsonl(stdout) {
  const state = codexStreamState(stdout);
  if (state.failure) throw aiCliError('codex', state.failure);
  if (!state.completed) throw aiCliError('codex', 'codex stream ended before turn.completed');
  if (!state.result) throw aiCliError('codex', 'codex returned no final agent message');
  return state.result;
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
  let spec;
  try { spec = commandFor(engine, systemPrompt, env); }
  catch (error) { return Promise.reject(aiCliError(engine, error && error.message || 'invalid CLI configuration')); }
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(spec.command, spec.args, { env }); }
    catch (error) {
      reject(aiCliError(engine, `${error && error.code || ''} ${error && error.message || 'process spawn failed'}`));
      return;
    }
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
      finish(reject, aiCliError(engine, `${engine} CLI timeout`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => finish(reject, aiCliError(engine,
      `${e && e.code || ''} ${e && e.message || 'process spawn failed'}`)));
    child.on('close', code => {
      if (code !== 0) {
        // Agent messages can contain candidate/JD text or phrases that resemble errors. On a
        // nonzero Codex exit, trust only structured failure events; never echo or classify stdout.
        const diagnostic = engine === 'codex'
          ? codexFailureDetail(stdout) || stderr.trim() || `codex process exited ${code}`
          : stderr.trim() || `${engine} process exited ${code}`;
        finish(reject, aiCliError(engine, diagnostic));
      }
      else {
        try { finish(resolve, parseOutput(engine, stdout)); }
        catch (e) {
          if (e && e.code) finish(reject, e);
          else finish(reject, aiCliError(engine, e && e.message || `${engine} output parse failed`));
        }
      }
    });
    child.stdin.write(spec.inputPrefix + userPrompt);
    child.stdin.end();
  });
}

module.exports = { SUPPORTED_ENGINES, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT,
  normalizeEnginePreference, parseEngine, codexModel, codexReasoningEffort,
  commandFor, classifyAiCliFailure, codexStreamState, codexFailureDetail,
  parseCodexJsonl, parseOutput, runAiCli };
