'use strict';

module.exports = async t => {
  const { DEFAULT_CODEX_MODEL, normalizeEnginePreference, parseEngine, commandFor,
    codexModel, codexReasoningEffort, classifyAiCliFailure, codexStreamState, codexFailureDetail,
    parseCodexJsonl, parseOutput, runAiCli } = require('../../ai-cli');

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
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} })
  ].join('\n');
  t.eq(parseCodexJsonl(events), '{"ok":true}', 'AI CLI: final Codex agent message is extracted');
  t.eq(parseOutput('claude', '{"result":"hello"}'), 'hello', 'AI CLI: Claude envelope remains supported');

  const usageMessage = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:25 PM.";
  t.eq(classifyAiCliFailure(usageMessage),
    { code: 'ai_engine_unavailable', reason: 'usage_limit', retryable: false },
    'AI CLI: explicit account usage limits are permanent for the current scoring run');
  const cacheMessage = 'codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 95 column 5';
  t.eq(classifyAiCliFailure(cacheMessage),
    { code: 'ai_engine_unavailable', reason: 'models_cache_invalid', retryable: false },
    'AI CLI: an incompatible Codex models cache is permanent for the current scoring run');
  t.eq(classifyAiCliFailure('failed to load models cache: resource temporarily unavailable').retryable, true,
    'AI CLI: models-cache lock or I/O contention remains transient');
  t.eq(classifyAiCliFailure('spawn codex ENOENT'),
    { code: 'ai_engine_unavailable', reason: 'executable_unavailable', retryable: false },
    'AI CLI: a missing executable opens the permanent circuit');
  t.eq(classifyAiCliFailure('codex: EACCES permission denied'),
    { code: 'ai_engine_unavailable', reason: 'executable_unavailable', retryable: false },
    'AI CLI: an inaccessible executable opens the permanent circuit');
  t.eq(classifyAiCliFailure('Error: not authenticated; please log in'),
    { code: 'ai_engine_unavailable', reason: 'authentication_unavailable', retryable: false },
    'AI CLI: explicit authentication failures are permanent for the current run');
  t.eq(classifyAiCliFailure('unknown model custom-model'),
    { code: 'ai_engine_unavailable', reason: 'invalid_configuration', retryable: false },
    'AI CLI: deterministic unknown-model failures are permanent for the current run');
  t.eq(classifyAiCliFailure('failed to parse configuration: invalid model setting'),
    { code: 'ai_engine_unavailable', reason: 'invalid_configuration', retryable: false },
    'AI CLI: deterministic configuration parse failures are permanent for the current run');
  t.eq(classifyAiCliFailure('model gpt-example is not supported'),
    { code: 'ai_engine_unavailable', reason: 'invalid_configuration', retryable: false },
    'AI CLI: unsupported configured models are permanent for the current run');
  t.eq(classifyAiCliFailure("unexpected argument '--ignore-user-config' found"),
    { code: 'ai_engine_unavailable', reason: 'invalid_configuration', retryable: false },
    'AI CLI: incompatible fixed command flags are permanent for the current run');
  t.eq(classifyAiCliFailure('HTTP 429 rate limit exceeded'),
    { code: 'ai_cli_failed', reason: 'rate_limited', retryable: true },
    'AI CLI: rate limiting retains bounded transient retries');
  t.eq(classifyAiCliFailure('socket closed while waiting for response'),
    { code: 'ai_cli_failed', reason: 'network_failure', retryable: true },
    'AI CLI: network failures retain bounded retry behavior');
  t.eq(classifyAiCliFailure('Codex CLI timed out'),
    { code: 'ai_cli_failed', reason: 'timeout', retryable: true },
    'AI CLI: timeouts retain bounded retry behavior');
  t.eq(classifyAiCliFailure('service temporarily unavailable; try again later').retryable, true,
    'AI CLI: transient service unavailability does not open the permanent circuit');

  const failedTurn = JSON.stringify({ type: 'turn.failed', error: { message: usageMessage } });
  t.eq(codexFailureDetail(failedTurn), usageMessage,
    'AI CLI: machine-readable Codex turn failures preserve their diagnostic for classification');
  let turnFailure = null;
  try { parseCodexJsonl(failedTurn); } catch (error) { turnFailure = error; }
  t.ok(turnFailure && turnFailure.code === 'ai_engine_unavailable' &&
    turnFailure.reason === 'usage_limit' && turnFailure.retryable === false,
  'AI CLI: a turn.failed usage-limit event is surfaced as typed engine unavailability');
  let terminalFailure = null;
  try { parseCodexJsonl(`${events}\n${failedTurn}`); } catch (error) { terminalFailure = error; }
  t.eq(terminalFailure && terminalFailure.reason, 'usage_limit',
    'AI CLI: terminal turn.failed state wins over any partial agent message');

  const partialEvents = [
    JSON.stringify({ type: 'thread.started', thread_id: 'partial' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"partial":true}' } }),
  ].join('\n');
  let partialFailure = null;
  try { parseCodexJsonl(partialEvents); } catch (error) { partialFailure = error; }
  t.ok(partialFailure && partialFailure.reason === 'incomplete_stream' && partialFailure.retryable === true,
    'AI CLI: a code-zero-compatible truncated stream cannot be accepted without turn.completed');

  const structuredError = JSON.stringify({ type: 'error', message: usageMessage });
  t.eq(codexFailureDetail(structuredError), usageMessage,
    'AI CLI: structured type:error events provide a bounded failure diagnostic');
  let structuredFailure = null;
  try { parseCodexJsonl(structuredError); } catch (error) { structuredFailure = error; }
  t.ok(structuredFailure && structuredFailure.code === 'ai_engine_unavailable' &&
    structuredFailure.reason === 'usage_limit' && structuredFailure.retryable === false,
  'AI CLI: a structured error event opens the permanent usage-limit circuit');
  let structuredThenTerminalFailure = null;
  try { parseCodexJsonl(`${structuredError}\n${JSON.stringify({ type: 'turn.failed' })}`); }
  catch (error) { structuredThenTerminalFailure = error; }
  t.eq(structuredThenTerminalFailure && structuredThenTerminalFailure.reason, 'usage_limit',
    'AI CLI: a bare terminal failure does not erase an earlier structured diagnostic');

  const rawUsageAgentEvents = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: usageMessage } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n');
  t.eq(parseCodexJsonl(rawUsageAgentEvents), usageMessage,
    'AI CLI: error-like text inside a successful agent message is output, not a failure diagnostic');

  const { EventEmitter } = require('events');
  const spawnWith = ({ stdout = '', stderr = '', code = 0, syncError = null } = {}) => () => {
    if (syncError) throw syncError;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', code);
      });
    } };
    child.kill = () => {};
    return child;
  };
  let processFailure = null;
  try {
    await runAiCli({ engine: 'codex', systemPrompt: 'system', userPrompt: 'user',
      timeoutMs: 1000, env: {}, spawnImpl: spawnWith({ stdout: failedTurn, code: 1 }) });
  } catch (error) { processFailure = error; }
  t.ok(processFailure && processFailure.code === 'ai_engine_unavailable' &&
    processFailure.reason === 'usage_limit' && processFailure.retryable === false,
  'AI CLI: nonzero Codex JSONL turn failures retain typed permanent metadata');

  let truncatedProcessFailure = null;
  try {
    await runAiCli({ engine: 'codex', systemPrompt: 'system', userPrompt: 'user',
      timeoutMs: 1000, env: {}, spawnImpl: spawnWith({ stdout: partialEvents, code: 0 }) });
  } catch (error) { truncatedProcessFailure = error; }
  t.ok(truncatedProcessFailure && truncatedProcessFailure.reason === 'incomplete_stream' &&
    truncatedProcessFailure.retryable === true,
  'AI CLI: a code-zero truncated Codex process is rejected for bounded retry');

  let rawAgentExitFailure = null;
  try {
    await runAiCli({ engine: 'codex', systemPrompt: 'system', userPrompt: 'candidate-private-prompt',
      timeoutMs: 1000, env: {}, spawnImpl: spawnWith({ stdout: rawUsageAgentEvents, code: 1 }) });
  } catch (error) { rawAgentExitFailure = error; }
  t.ok(rawAgentExitFailure && rawAgentExitFailure.reason === 'transient_cli_failure' &&
    rawAgentExitFailure.retryable === true && !rawAgentExitFailure.message.includes('usage limit') &&
    !rawAgentExitFailure.message.includes('candidate-private-prompt'),
  'AI CLI: nonzero exits never classify or echo raw agent-message or prompt text');

  let invalidEffortSpawnCalls = 0;
  let invalidEffortFailure = null;
  try {
    await runAiCli({ engine: 'codex', systemPrompt: 'system', userPrompt: 'user', timeoutMs: 1000,
      env: { PJA_CODEX_REASONING_EFFORT: 'ultra' },
      spawnImpl: () => { invalidEffortSpawnCalls += 1; return spawnWith()(); } });
  } catch (error) { invalidEffortFailure = error; }
  t.ok(invalidEffortFailure && invalidEffortFailure.reason === 'invalid_configuration' &&
    invalidEffortFailure.retryable === false && invalidEffortSpawnCalls === 0,
  'AI CLI: synchronous invalid reasoning configuration is typed before spawning');

  const missingExecutable = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  let syncSpawnFailure = null;
  try {
    await runAiCli({ engine: 'codex', systemPrompt: 'system', userPrompt: 'user', timeoutMs: 1000,
      env: {}, spawnImpl: spawnWith({ syncError: missingExecutable }) });
  } catch (error) { syncSpawnFailure = error; }
  t.ok(syncSpawnFailure && syncSpawnFailure.reason === 'executable_unavailable' &&
    syncSpawnFailure.retryable === false,
  'AI CLI: synchronous executable spawn failures are typed as nonretryable engine unavailability');

  const serverSource = require('fs').readFileSync(require('path').resolve(__dirname, '../../dev-server.js'), 'utf8');
  const executionSource = require('fs').readFileSync(require('path').resolve(__dirname, '../../scoring-execution.js'), 'utf8');
  t.ok(serverSource.includes('aiConfig') && serverSource.includes('reasoningEffort: codexReasoningEffort()'),
    'AI CLI: health endpoint exposes the effective lightweight configuration');
  t.ok(executionSource.includes('if (lastError && lastError.retryable === false) {') &&
    executionSource.includes('throw attachPartialRows(lastError, batch, [...accepted.values()]);') &&
    serverSource.includes('if (circuitFailure) {') &&
    serverSource.includes('if (failure.retryable === false) circuitFailure = failure;'),
  'AI CLI scoring: permanent engine failures stop retries and prevent later chunk launches');
  t.ok(serverSource.includes('scores: batchSummary.successful.map') &&
    serverSource.includes('scored.push(...batchSummary.successful.map') &&
    serverSource.includes('ScoringExecution.partialRowsFromError(chunks[idx], e)') &&
    serverSource.includes("if (!scoredIds.has(String(job.id))) failuresById[String(job.id)] = failure") &&
    serverSource.includes("'rescore_ai_engine_unavailable'") &&
    serverSource.includes("'progressive_scoring_engine_unavailable'"),
  'AI CLI scoring: failed rows are neither persisted nor counted and receive explicit planning drops');
  t.ok(serverSource.includes("scoringUnavailable ? 'scoring_engine_unavailable'") &&
    serverSource.includes('PlanningDiagnostics.scoringEngineFailure({') &&
    serverSource.includes("code: 'ai_engine_unavailable', scoringAvailability, planningDrops") &&
    serverSource.includes('scoringModelBatchesSucceeded, scoringAvailability'),
  'AI CLI scoring: planning reports engine unavailability and truthful batch metrics');
};
