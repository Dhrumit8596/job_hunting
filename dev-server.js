#!/usr/bin/env node
'use strict';

/**
 * PJA Dev Server — routes extension analysis through a local Claude or Codex CLI.
 *
 * Usage:
 *   node dev-server.js
 *
 * Engine: `node dev-server.js --engine codex` or PJA_AI_ENGINE=codex (default: claude).
 *
 * Hot-reload:
 *   curl -X POST http://localhost:6174/reload
 *   (background.js connects via WebSocket and calls chrome.runtime.reload())
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const { buildRestartPlan } = require('./chrome-restart');
const { parseEngine, runAiCli } = require('./ai-cli');

const PORT = Number(process.env.PJA_DEV_PORT || 6174);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PJA_DEV_PORT must be a valid TCP port');
const AI_ENGINE = parseEngine();

// Connected extension background workers (WebSocket clients)
const wsClients = new Set();
let _lastQueueStatus = null;
// Process-local planning mutex. The extension service worker independently enforces the final
// active-run lock, but this closes the minutes-long scoreAll race between concurrent HTTP calls.
let applyRunPlanning = false;

// Candidate-specific analyzer prompt is loaded from candidate.local.txt (gitignored) so no
// personal profile data ships in the repo. Falls back to a generic prompt if absent.
const GENERIC_SYSTEM_PROMPT =
`You are a job-fit analyzer. Using the candidate profile supplied in the user message,
score how well the candidate matches the job posting. Return ONLY valid JSON, no markdown:
{"fitScore":<integer 0-100>,"tnEligible":<true|false>,"matchedSkills":[<skills the candidate has that match>],"gaps":[<skills the job requires that the candidate lacks>],"recruiterTitle":"<LinkedIn recruiter title>","dmMessage":"<DM under 280 chars>","emailMessage":"<Subject: line first, under 500 chars>","linkedinSearchQuery":"<search query>"}`;

const CANDIDATE_PROFILE_PATH = path.join(__dirname, 'candidate.local.txt');
const HAS_CANDIDATE_PROFILE = (() => {
  try { return fs.existsSync(CANDIDATE_PROFILE_PATH) && fs.statSync(CANDIDATE_PROFILE_PATH).size > 0; }
  catch (_) { return false; }
})();
const SYSTEM_PROMPT = (() => {
  try {
    if (HAS_CANDIDATE_PROFILE) return fs.readFileSync(CANDIDATE_PROFILE_PATH, 'utf8');
  } catch (_) {}
  return GENERIC_SYSTEM_PROMPT;
})();
const CANDIDATE_FINGERPRINT = HAS_CANDIDATE_PROFILE
  ? crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 24)
  : '';
let runtimeCandidatePrompt = SYSTEM_PROMPT;
let runtimeCandidateFingerprint = CANDIDATE_FINGERPRINT;
let runtimeHasCandidateProfile = HAS_CANDIDATE_PROFILE;

// Build a private, per-user scoring profile from extension storage. This keeps new users from
// needing a gitignored candidate.local.txt while ensuring an empty/new profile still fails closed.
async function refreshRuntimeCandidateProfile() {
  const st = await getStorageFromExtension(['pja_profile', 'pja_resume_filename']);
  const profile = st && st.pja_profile && typeof st.pja_profile === 'object' ? st.pja_profile : {};
  const resume = String(st && st.pja_resume_filename || '').trim();
  const meaningful = Object.entries(profile).filter(([k, v]) => v != null && String(v).trim() && !/^savedAt$/i.test(k));
  if (meaningful.length < 3 || !resume) {
    runtimeCandidatePrompt = SYSTEM_PROMPT;
    runtimeCandidateFingerprint = CANDIDATE_FINGERPRINT;
    runtimeHasCandidateProfile = HAS_CANDIDATE_PROFILE;
    return { configured: runtimeHasCandidateProfile, resume: !!resume, fields: meaningful.length };
  }
  const facts = meaningful.map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`).join('\n');
  runtimeCandidatePrompt = `${GENERIC_SYSTEM_PROMPT}\n\nVERIFIED USER PROFILE (from local extension storage):\n${facts}\nResume uploaded locally: ${resume}. Treat the profile as authoritative; do not invent resume facts not represented here.`;
  runtimeCandidateFingerprint = crypto.createHash('sha256').update(runtimeCandidatePrompt).digest('hex').slice(0, 24);
  runtimeHasCandidateProfile = true;
  return { configured: true, resume: true, fields: meaningful.length };
}

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['fitScore','matchedSkills','gaps','recruiterTitle','dmMessage','emailMessage','linkedinSearchQuery'],
  properties: {
    fitScore:            { type: 'integer', minimum: 0, maximum: 100 },
    tnEligible:          { type: 'boolean' },
    matchedSkills:       { type: 'array',   items: { type: 'string' } },
    gaps:                { type: 'array',   items: { type: 'string' } },
    recruiterTitle:      { type: 'string' },
    dmMessage:           { type: 'string' },
    emailMessage:        { type: 'string' },
    linkedinSearchQuery: { type: 'string' }
  }
});

function runClaudeWithSystemPrompt(systemPrompt, userPrompt, timeoutMs = 90000) {
  return runAiCli({ engine: AI_ENGINE, systemPrompt, userPrompt, timeoutMs });
}

function runClaude(userPrompt) {
  return runClaudeWithSystemPrompt(SYSTEM_PROMPT, userPrompt);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function postLocalJson(pathname, body, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function gateScoredApplyJobs(inputJobs, opts = {}) {
  const jobs = Array.isArray(inputJobs) ? inputJobs.filter(Boolean) : [];
  const rawThreshold = opts.threshold == null ? 55 : Number(opts.threshold);
  const threshold = Number.isFinite(rawThreshold) ? Math.max(0, Math.min(100, rawThreshold)) : 55;
  const requireScored = opts.requireScored !== false;
  const requireEvidence = opts.requireEvidence === true;
  const skipped = [];
  const kept = [];
  for (const job of jobs) {
    const rawScore = job.fitScore != null ? job.fitScore : job.score;
    const score = Number(rawScore);
    const hasScore = Number.isFinite(score);
    const evidence = Array.isArray(job.matchEvidence) ? job.matchEvidence
      : Array.isArray(job.matchedSkills) ? job.matchedSkills : [];
    const conflicts = Array.isArray(job.conflicts) ? job.conflicts : [];
    let reason = '';
    if (requireScored && !hasScore) reason = 'missing_fit_score';
    else if (hasScore && score < threshold) reason = `fit_score_below_${threshold}`;
    else if (requireEvidence && evidence.length < 3) reason = 'insufficient_match_evidence';
    else if (requireEvidence && conflicts.length) reason = 'match_conflicts';
    if (reason) {
      skipped.push({ jobId: job.jobId || job.id || job.sourceJobId || null,
        company: job.company || '', title: job.title || '', fitScore: hasScore ? score : null, reason });
      continue;
    }
    kept.push(hasScore ? { ...job, fitScore: score } : job);
  }
  return { jobs: kept, skipped, threshold, requireScored, requireEvidence };
}

// ── Sourcing pipeline wiring ────────────────────────────────────────────────
const { runPipeline } = require('./sourcing/pipeline');

// Read chrome.storage from the connected extension (best-effort; [] if none).
function getStorageFromExtension(keys, timeoutMs = 4000) {
  return new Promise(resolve => {
    const reqId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let done = false;
    const client = [...wsClients].find(c => c.readyState === 1);
    if (!client) return resolve({});
    const onMsg = raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.cmd === 'storageReply' && msg.reqId === reqId && !done) {
          done = true; client.removeListener('message', onMsg); resolve(msg.data || {});
        }
      } catch (_) {}
    };
    client.on('message', onMsg);
    client.send(JSON.stringify({ cmd: 'getStorage', keys, reqId }));
    setTimeout(() => { if (!done) { done = true; client.removeListener('message', onMsg); resolve({}); } }, timeoutMs);
  });
}

async function getBrowserShortlistFromExtension(timeoutMs = 20000) {
  const data = await wsAsk('getBrowserShortlist', {}, 'browserShortlistReply', timeoutMs);
  if (data && Array.isArray(data.jobs)) return data.jobs;
  const fallback = await getStorageFromExtension(['pja_shortlist'], timeoutMs);
  return Array.isArray(fallback.pja_shortlist) ? fallback.pja_shortlist : [];
}

// Push storage to the extension (returns count of clients written).
function setStorageToExtension(obj) {
  let pushed = 0;
  for (const c of wsClients) {
    if (c.readyState === 1) { c.send(JSON.stringify({ cmd: 'setStorage', data: obj })); pushed++; }
  }
  return pushed;
}

// Fire-and-forget WS command to the extension (e.g. openTab).
function wsSend(cmd, extra = {}) {
  const client = [...wsClients].find(c => c.readyState === 1);
  if (!client) return false;
  client.send(JSON.stringify(Object.assign({ cmd }, extra)));
  return true;
}

// Generic WS round-trip: send {cmd, ...payload, reqId}, resolve with the matching {replyCmd, reqId}.data.
function wsAsk(cmd, payload, replyCmd, timeoutMs = 8000) {
  return new Promise(resolve => {
    const client = [...wsClients].find(c => c.readyState === 1);
    if (!client) return resolve({ error: 'no extension connected' });
    const reqId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let done = false;
    const onMsg = raw => {
      try {
        const m = JSON.parse(raw);
        if (m.cmd === replyCmd && m.reqId === reqId && !done) { done = true; client.removeListener('message', onMsg); resolve(m.data || {}); }
      } catch (_) {}
    };
    client.on('message', onMsg);
    client.send(JSON.stringify(Object.assign({ cmd, reqId }, payload || {})));
    setTimeout(() => { if (!done) { done = true; client.removeListener('message', onMsg); resolve({ error: 'timeout' }); } }, timeoutMs);
  });
}

function applicationAuditFromStorage(storage, options = {}) {
  const Ledger = require('./application-ledger');
  let ledger = storage && storage.pja_application_ledger || Ledger.emptyLedger();
  ledger = Ledger.reduceLedger(ledger, ((storage && storage.pja_applied_log) || []).map((row, i) => ({
    ...row, eventId: row.eventId || `legacy_${i}_${row.runId || ''}_${row.jobId || ''}`,
    applicationAt: row.appliedAt || row.ts,
    occurredAt: row.updatedAt || row.confirmedAt || row.appliedAt || row.ts,
  })));
  return { ledger, audit: Ledger.auditLedger(ledger, options) };
}

function safeReportText(value) {
  return String(value == null ? '' : value)
    .replace(/\r?\n+/g, ' ')
    .replace(/[|`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeReportId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `run-${Date.now()}`;
}

function compactReportJob(job, fallbackStatus) {
  const row = job && typeof job === 'object' ? job : {};
  return {
    status: safeReportText(row.status || fallbackStatus || ''),
    company: safeReportText(row.company || ''),
    title: safeReportText(row.title || ''),
    channel: safeReportText(row.channel || 'external'),
    ats: safeReportText(row.ats || row.strategy || row.handler || ''),
    reason: safeReportText(row.reason || row.skipReason || row.error || ''),
    fitScore: row.fitScore == null || row.fitScore === '' ? '' : safeReportText(row.fitScore),
    url: safeReportText(row.applyUrl || row.url || row.listingUrl || ''),
  };
}

function groupedReportRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = safeReportText(keyFn(row) || 'unknown') || 'unknown';
    const g = groups.get(key) || { key, count: 0, example: row };
    g.count++;
    if (!g.example || !g.example.company && row.company) g.example = row;
    groups.set(key, g);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function developerRecommendation(row = {}) {
  const reason = String(row.reason || row.status || '').toLowerCase();
  const ats = String(row.ats || '').toLowerCase();
  const channel = String(row.channel || '').toLowerCase();
  if (/workday_duplicate_record/.test(reason)) {
    return 'Manual/profile-state blocker: inspect Workday existing-draft subrecords; suppress same tenant until duplicate-record recovery is implemented.';
  }
  if (/workday_captcha|captcha/.test(reason) && ats === 'workday') {
    return 'External auth/anti-bot blocker: keep tenant suppressed; retry only after manual captcha/account reset.';
  }
  if (/captcha/.test(reason) && (channel === 'indeed_apply' || ats === 'indeed')) {
    return 'External anti-bot blocker: pause Indeed apply path; do not blind retry without human/browser-state reset.';
  }
  if (/captcha|checkpoint|daily_limit/.test(reason)) {
    return 'External anti-bot/account-limit blocker: record and pause that channel; retry only after account state clears.';
  }
  if (/ranked_watchdog_timeout|stuck_watchdog|watchdog_timeout|submit_unclear|submit_unconfirmed/.test(reason)) {
    return 'Automation/confirmation gap: inspect page/debug tail; improve submit success detection or form-specific recovery.';
  }
  if (/missing_required|wd_selectinput_blocked|no_submit_after_spa/.test(reason)) {
    return 'Form-fill gap: inspect missing fields/options; add answer-bank mapping or ATS-specific control handling.';
  }
  if (/email_verification_required/.test(reason)) {
    return 'Verification flow gap: inspect email-code recovery and post-code submit/confirmation handling.';
  }
  if (/no_apply_path|no_apply_btn|apply_btn_no_form|posting_not_found/.test(reason)) {
    return 'Discovery/apply-path gap or stale posting: improve apply URL resolution and preflight classification.';
  }
  if (/missing_description_evidence|rescore_missing_description|stale_browser_listing|aggregator_without_apply_destination/.test(reason)) {
    return 'Sourcing/hydration gap: refresh browser discovery, resolve the real apply URL, and hydrate full descriptions before apply planning.';
  }
  if (/weak_match_evidence|too_many_match_gaps|hard_match_conflict|low_score_confidence|below_threshold|candidate_fingerprint_mismatch|unscored/.test(reason)) {
    return 'Scoring/ranking gate: rescore against the current resume/JD evidence or leave out as unsuitable for autonomous apply.';
  }
  if (/prior_blocked_host|prior_blocked_record|deferred_retry_disabled|deferred_max_attempts/.test(reason)) {
    return 'Suppression/retry gate: expected safety drop; use targeted retry only after the prior blocker is manually repaired.';
  }
  if (/unsupported_|missing_apply_url|ats_not_allowed|eligible_not_selected/.test(reason)) {
    return 'Planner routing gate: add/repair an apply handler or adjust run caps/allow-lists if this job should be attempted.';
  }
  if (/needs_login|google_sso_only|account_locked|wrong_password/.test(reason)) {
    return 'Authentication blocker: require manual account/session repair before retry.';
  }
  return 'Inspect grouped rows, ledger tail, and debug tail; classify as code fix vs external/manual blocker.';
}

function summarizeBlockedFromLedger(storage = {}) {
  const events = storage.pja_application_ledger && storage.pja_application_ledger.events
    ? Object.values(storage.pja_application_ledger.events) : [];
  const manualBlockerRe = /captcha|daily_limit|checkpoint|email_verification_required|workday_duplicate_record|workday_account_locked|workday_account_exists_wrong_password|workday_captcha|google_sso_only|ready_to_submit_review|chatbot_apply_manual|unsupported_|no_apply_path/i;
  const workdayTenantRe = /workday_duplicate_record|workday_captcha|workday_account_locked/i;
  const blockedRows = events
    .filter(e => e && /^(failed|skipped|needs_manual|blocked)$/i.test(String(e.status || '')) &&
      manualBlockerRe.test(String(e.reason || e.status || '')))
    .map(e => compactReportJob(e, e.status || 'blocked'));
  const hostOf = url => { try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (_) { return ''; } };
  const hostRows = events
    .filter(e => e && workdayTenantRe.test(String(e.reason || e.status || '')))
    .map(e => ({ host: hostOf(e.applyUrl || e.url), reason: safeReportText(e.reason || e.status || ''), row: compactReportJob(e, e.status || 'blocked') }))
    .filter(e => e.host);
  const hosts = groupedReportRows(hostRows, e => e.host).map(g => ({
    host: g.key,
    count: g.count,
    reason: g.example && g.example.reason || '',
    example: g.example && g.example.row ? {
      company: g.example.row.company,
      title: g.example.row.title,
    } : null,
  }));
  const reasons = groupedReportRows(blockedRows, row => row.reason || row.status).map(g => ({
    reason: g.key,
    count: g.count,
    recommendation: developerRecommendation(g.example || {}),
  }));
  return { records: blockedRows.length, hosts, reasons };
}

function renderApplyRunReport(storage, options = {}) {
  const activeRanked = storage && storage.pja_ranked_apply || null;
  const completedRanked = storage && storage.pja_last_completed_apply_run || null;
  const ranked = activeRanked || completedRanked || null;
  const ledger = storage && storage.pja_application_ledger && storage.pja_application_ledger.events
    ? Object.values(storage.pja_application_ledger.events) : [];
  const appliedLog = Array.isArray(storage && storage.pja_applied_log) ? storage.pja_applied_log : [];
  const hasAnyState = !!(ranked || ledger.length || appliedLog.length ||
    storage && (storage.pja_last_apply_failure || Array.isArray(storage.pja_dbg) && storage.pja_dbg.length));
  const runId = safeReportId(options.runId || ranked && ranked.runId || (ledger.find(e => e && e.runId) || {}).runId || '');
  const generatedAt = new Date().toISOString();
  const results = ranked && ranked.results || {};
  const buckets = [
    ['confirmed', results.confirmed || []],
    ['failed', results.failed || []],
    ['skipped', results.skipped || []],
    ['unverified', results.unverified || []],
  ];
  const allRows = [];
  for (const [status, rows] of buckets) {
    for (const row of Array.isArray(rows) ? rows : []) allRows.push(compactReportJob(row, status));
  }
  const ledgerRows = ledger
    .filter(e => !ranked || !ranked.runId || e.runId === ranked.runId || e.runId === options.runId)
    .slice(-80)
    .map(e => compactReportJob(e, e.status || 'ledger'));
  const appliedRows = appliedLog
    .filter(e => !ranked || !ranked.runId || e.runId === ranked.runId || e.runId === options.runId)
    .slice(-40)
    .map(e => compactReportJob(e, e.status || (e.success ? 'confirmed' : 'applied_log')));
  const debugTail = Array.isArray(storage && storage.pja_dbg) ? storage.pja_dbg.slice(-30).map(safeReportText) : [];
  const lastFailure = compactReportJob(storage && storage.pja_last_apply_failure, 'last_failure');
  const count = name => Array.isArray(results[name]) ? results[name].length
    : ranked && ranked.counts && ranked.counts[name] != null ? Number(ranked.counts[name]) || 0
    : ranked && ranked[name] != null ? Number(ranked[name]) || 0
    : 0;
  const planningDropsRaw = ranked && ranked.planningDrops && Array.isArray(ranked.planningDrops.examples)
    ? ranked.planningDrops.examples : [];
  const planningDropRows = planningDropsRaw.map(row => compactReportJob(row, 'planning_drop'));
  const problemRows = allRows.filter(row => /^(failed|skipped|unverified)$/i.test(row.status));
  const lines = [];
  lines.push(`# Apply run report — ${runId}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push('This report intentionally omits candidate profile values, resume contents, answers, passwords, email codes, and screenshots. It is for developer debugging of routing, application, and failure/drop behavior.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Run status: ${safeReportText(ranked && ranked.status || 'unknown')}`);
  lines.push(`- State source: ${activeRanked ? 'active ranked run' : completedRanked ? 'last completed ranked run' : 'none'}`);
  if (ranked && ranked.runMode) lines.push(`- Run mode: ${safeReportText(ranked.runMode)}`);
  lines.push(`- Current index: ${ranked && ranked.currentIndex != null ? ranked.currentIndex : 'unknown'} / ${ranked && Array.isArray(ranked.jobs) ? ranked.jobs.length : 'unknown'}`);
  lines.push(`- Confirmed: ${count('confirmed')}`);
  lines.push(`- Failed: ${count('failed')}`);
  lines.push(`- Skipped/dropped: ${count('skipped')}`);
  lines.push(`- Unverified: ${count('unverified')}`);
  if (ranked && ranked.tabCleanup) {
    lines.push(`- Last tab cleanup: ${ranked.tabCleanup.closed ? 'closed' : 'not closed'}${ranked.tabCleanup.error ? ' (' + safeReportText(ranked.tabCleanup.error) + ')' : ''}`);
  }
  if (ranked && ranked.planningDrops) {
    lines.push(`- Planning drops before launch: ${ranked.planningDrops.total != null ? ranked.planningDrops.total : planningDropRows.length}`);
  }
  if (!hasAnyState) {
    lines.push('- State warning: no active ranked run, ledger, applied log, last failure, or debug tail was available from extension storage.');
  }
  if (lastFailure.company || lastFailure.title || lastFailure.reason) {
    lines.push(`- Last failure: ${lastFailure.company} — ${lastFailure.title} (${lastFailure.reason || 'no reason'})`);
  }
  lines.push('');
  if (problemRows.length) {
    lines.push('## Failure/drop groups');
    lines.push('');
    lines.push('### By reason');
    lines.push('');
    lines.push('| Reason | Count | Example | Channel | ATS |');
    lines.push('| --- | ---: | --- | --- | --- |');
    for (const g of groupedReportRows(problemRows, row => row.reason || row.status)) {
      const ex = g.example || {};
      lines.push(`| ${g.key} | ${g.count} | ${safeReportText([ex.company, ex.title].filter(Boolean).join(' — '))} | ${safeReportText(ex.channel)} | ${safeReportText(ex.ats)} |`);
    }
    lines.push('');
    lines.push('### Recommended developer focus');
    lines.push('');
    lines.push('| Reason | Recommendation |');
    lines.push('| --- | --- |');
    for (const g of groupedReportRows(problemRows, row => row.reason || row.status)) {
      lines.push(`| ${g.key} | ${safeReportText(developerRecommendation(g.example || {}))} |`);
    }
    lines.push('');
    lines.push('### By ATS');
    lines.push('');
    lines.push('| ATS | Count | Example reason | Example |');
    lines.push('| --- | ---: | --- | --- |');
    for (const g of groupedReportRows(problemRows, row => row.ats || row.channel || row.status)) {
      const ex = g.example || {};
      lines.push(`| ${g.key} | ${g.count} | ${safeReportText(ex.reason || ex.status)} | ${safeReportText([ex.company, ex.title].filter(Boolean).join(' — '))} |`);
    }
    lines.push('');
    lines.push('### By channel');
    lines.push('');
    lines.push('| Channel | Count | Example reason | Example |');
    lines.push('| --- | ---: | --- | --- |');
    for (const g of groupedReportRows(problemRows, row => row.channel || row.status)) {
      const ex = g.example || {};
      lines.push(`| ${g.key} | ${g.count} | ${safeReportText(ex.reason || ex.status)} | ${safeReportText([ex.company, ex.title].filter(Boolean).join(' — '))} |`);
    }
    lines.push('');
  }
  if (ranked && ranked.planningDrops) {
    lines.push('## Planning drops before launch');
    lines.push('');
    lines.push('These jobs were present in the corpus but were not placed into the apply queue. They are planning/safety drops, not browser execution failures.');
    lines.push('');
    const dropCounts = ranked.planningDrops.counts && typeof ranked.planningDrops.counts === 'object' ? ranked.planningDrops.counts : {};
    lines.push('### By reason');
    lines.push('');
    lines.push('| Reason | Count | Recommendation |');
    lines.push('| --- | ---: | --- |');
    for (const [reason, value] of Object.entries(dropCounts).sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))) {
      lines.push(`| ${safeReportText(reason)} | ${Number(value) || 0} | ${safeReportText(developerRecommendation({ reason }))} |`);
    }
    lines.push('');
    if (planningDropRows.length) {
      lines.push('### Examples');
      lines.push('');
      lines.push('| Reason | Company | Title | Channel | ATS | Fit | URL |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const row of planningDropRows) {
        lines.push(`| ${row.reason} | ${row.company} | ${row.title} | ${row.channel} | ${row.ats} | ${row.fitScore} | ${row.url} |`);
      }
      lines.push('');
    }
  }
  if (allRows.length) {
    lines.push('## Ranked-run outcomes');
    lines.push('');
    lines.push('| Status | Company | Title | Channel | ATS | Fit | Reason | URL |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of allRows) {
      lines.push(`| ${row.status} | ${row.company} | ${row.title} | ${row.channel} | ${row.ats} | ${row.fitScore} | ${row.reason} | ${row.url} |`);
    }
    lines.push('');
  }
  if (ledgerRows.length) {
    lines.push('## Ledger tail');
    lines.push('');
    lines.push('| Status | Company | Title | Channel | Reason | URL |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of ledgerRows) {
      lines.push(`| ${row.status} | ${row.company} | ${row.title} | ${row.channel} | ${row.reason} | ${row.url} |`);
    }
    lines.push('');
  }
  if (appliedRows.length) {
    lines.push('## Applied-log tail');
    lines.push('');
    lines.push('| Status | Company | Title | Channel | Reason | URL |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of appliedRows) {
      lines.push(`| ${row.status} | ${row.company} | ${row.title} | ${row.channel} | ${row.reason} | ${row.url} |`);
    }
    lines.push('');
  }
  if (debugTail.length) {
    lines.push('## Debug tail');
    lines.push('');
    for (const row of debugTail) lines.push(`- ${row}`);
    lines.push('');
  }
  return { runId, markdown: lines.join('\n') };
}

function writeApplyRunReport(storage, options = {}) {
  const report = renderApplyRunReport(storage || {}, options);
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `apply-run-${report.runId}.md`;
  const filePath = path.join(reportsDir, filename);
  fs.writeFileSync(filePath, report.markdown, 'utf8');
  return { runId: report.runId, file: filePath, bytes: Buffer.byteLength(report.markdown) };
}

function writeApplyPlanningReport(planningDrops, options = {}) {
  if (!planningDrops) return null;
  const runId = safeReportId(options.runId || `plan-${Date.now()}`);
  return writeApplyRunReport({
    pja_ranked_apply: {
      runId,
      status: options.status || 'planning',
      currentIndex: 0,
      jobs: Array.isArray(options.jobs) ? options.jobs : [],
      results: { confirmed: [], failed: [], skipped: [], unverified: [] },
      planningDrops,
    },
  }, { runId });
}

function appendPlanningDrop(planningDrops, job, reason, dropLimit = 200) {
  if (!planningDrops) planningDrops = { total: 0, counts: {}, examples: [] };
  if (!planningDrops.counts || typeof planningDrops.counts !== 'object') planningDrops.counts = {};
  if (!Array.isArray(planningDrops.examples)) planningDrops.examples = [];
  planningDrops.total = (Number(planningDrops.total) || 0) + 1;
  planningDrops.counts[reason] = (planningDrops.counts[reason] || 0) + 1;
  if (planningDrops.examples.length < dropLimit) {
    planningDrops.examples.push({
      id: safeReportText(job && job.id || ''),
      company: safeReportText(job && job.company || ''),
      title: safeReportText(job && job.title || ''),
      channel: safeReportText(job && job.channel || 'external'),
      ats: safeReportText(job && (job.ats || job.strategy) || ''),
      strategy: safeReportText(job && job.strategy || ''),
      fitScore: job && job.fitScore != null && Number.isFinite(Number(job.fitScore)) ? Number(job.fitScore) : null,
      status: safeReportText(job && job.status || 'sourced'),
      reason: safeReportText(reason),
      applyUrl: safeReportText(job && job.applyUrl || ''),
      descriptionStatus: safeReportText(job && job.descriptionStatus || ''),
    });
  }
  return planningDrops;
}

async function oneClickPreflight(options = {}) {
  const status = await refreshRuntimeCandidateProfile();
  const storage = wsClients.size ? await getStorageFromExtension(['pja_ranked_apply'], 5000) : {};
  const active = storage && storage.pja_ranked_apply && /^(applying|paused_for_patch|paused_for_fix)$/i
    .test(String(storage.pja_ranked_apply.status || ''));
  const problems = [];
  if (wsClients.size < 1) problems.push('extension_not_connected');
  if (options.requireCandidateProfile !== false && !status.configured) problems.push('candidate_profile_not_configured');
  if (active && options.force !== true) problems.push('active_ranked_apply_run');
  return {
    ok: problems.length === 0,
    problems,
    clients: wsClients.size,
    candidate: status,
    activeRun: active ? {
      runId: storage.pja_ranked_apply.runId || null,
      status: storage.pja_ranked_apply.status || '',
      currentIndex: storage.pja_ranked_apply.currentIndex,
      total: Array.isArray(storage.pja_ranked_apply.jobs) ? storage.pja_ranked_apply.jobs.length : null,
    } : null,
  };
}

function summarizeApplyStatus(storage = {}) {
  const activeRanked = storage.pja_ranked_apply || null;
  const completedRanked = storage.pja_last_completed_apply_run || null;
  const ranked = activeRanked || completedRanked || null;
  const results = ranked && ranked.results || {};
  const count = key => Array.isArray(results[key]) ? results[key].length
    : ranked && ranked.counts && ranked.counts[key] != null ? Number(ranked.counts[key]) || 0
    : 0;
  const currentJob = ranked && Array.isArray(ranked.jobs)
    ? ranked.jobs[ranked.inFlightIndex != null ? ranked.inFlightIndex : ranked.currentIndex]
    : null;
  const lastFailure = storage.pja_last_apply_failure || null;
  const active = !!(activeRanked && /^(applying|paused_for_patch|paused_for_fix)$/i.test(String(activeRanked.status || '')));
  return {
    ok: true,
    clients: wsClients.size,
    active,
    run: ranked ? {
      runId: ranked.runId || null,
      status: ranked.status || '',
      active,
      runMode: ranked.runMode || (ranked.applyAllAboveScore ? 'all_above_score' : 'target_confirmed'),
      currentIndex: ranked.currentIndex,
      inFlightIndex: ranked.inFlightIndex,
      total: Array.isArray(ranked.jobs) ? ranked.jobs.length : 0,
      targetConfirmed: ranked.targetConfirmed != null ? ranked.targetConfirmed : null,
      remaining: ranked.remaining != null ? ranked.remaining : null,
      confirmed: count('confirmed'),
      failed: count('failed'),
      skipped: count('skipped'),
      unverified: count('unverified'),
      currentJob: currentJob ? {
        company: safeReportText(currentJob.company || ''),
        title: safeReportText(currentJob.title || ''),
        channel: safeReportText(currentJob.channel || 'external'),
        ats: safeReportText(currentJob.ats || currentJob.strategy || ''),
      } : null,
    } : null,
    lastCompletedRun: completedRanked ? {
      runId: completedRanked.runId || null,
      status: completedRanked.status || '',
      finishedAt: completedRanked.finishedAt || null,
    } : null,
    blocked: summarizeBlockedFromLedger(storage),
    lastFailure: lastFailure ? {
      company: safeReportText(lastFailure.company || ''),
      title: safeReportText(lastFailure.title || ''),
      reason: safeReportText(lastFailure.reason || ''),
      ats: safeReportText(lastFailure.ats || ''),
    } : null,
  };
}

function isTerminalApplyStatus(status) {
  return /^(done|exhausted|day_changed|aborted|cancelled|failed)$/i.test(String(status || ''));
}

function maybeAutoExportApplyReport(storage = {}) {
  const ranked = storage.pja_ranked_apply || storage.pja_last_completed_apply_run || null;
  if (!ranked || !ranked.runId || !isTerminalApplyStatus(ranked.status)) return null;
  return writeApplyRunReport(storage, { runId: ranked.runId });
}

// Score one chunk (<=10) of jobs via the same prompt /batch-score uses.
const SCORE_PROMPT_SUFFIX = `

FOR BATCH FIT SCORING, the verified candidate/resume profile above is authoritative. Ignore any
earlier output-format instruction and return the JSON ARRAY schema below. A title containing
"Associate Engineer" or "Lead Engineer" is still an engineering profession; evaluate duties and
seniority instead of rejecting it solely for that modifier. Hard citizenship, clearance,
export-control, work-authorization, degree, location, or seniority conflicts must be explicit.
If the prompt above does not actually contain candidate/resume facts, never infer them: score at
most 25 with low confidence until a local candidate profile is configured.

Return ONLY a JSON array. Each item must be {"id":"...","score":0-100,"matchEvidence":[at least 0 concise resume-to-requirement matches],"gaps":[required qualifications not evidenced],"conflicts":[hard conflicts],"confidence":"high|medium|low"}. Evidence must be supported by both the posting text and resume facts. Do not count hedged or potential matches as evidence. If posting requirements are missing, confidence must be low. No markdown.`;

function scoringExcerpt(description) {
  const text = String(description || '');
  if (text.length <= 12000) return text;
  return text.slice(0, 7000) + '\n[... middle omitted ...]\n' + text.slice(-5000);
}

async function scoreJobChunk(batch) {
  const jobList = batch.map((j, i) => `Job ${i + 1}: id=${JSON.stringify(j.id)}\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\nPosting: ${scoringExcerpt(j.description)}`).join('\n---\n');
  const prompt = `Score each job using only the resume facts and posting text. A score of 75+ requires at least three direct requirement matches, no hard conflict, realistic seniority, and medium/high confidence.\n\nJobs:\n${jobList}`;
  const raw = await runClaudeWithSystemPrompt(`${runtimeCandidatePrompt}${SCORE_PROMPT_SUFFIX}`, prompt);
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1 || e === -1) return [];
  try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { return []; }
}

// Score all jobs in chunks of 10, with bounded concurrency. Resilient: a chunk that errors
// or times out leaves its jobs unscored (→ shortlist) instead of stalling the whole run.
// Codex calls are independent; bounded parallelism keeps full-corpus scoring practical while
// avoiding an unbounded process/connection fan-out.
async function scoreAll(jobs, concurrency = 12) {
  // Deterministic safety boundary: prompt instructions are not the enforcement layer. Without a
  // verified local resume, no job can obtain an autonomous-apply score.
  await refreshRuntimeCandidateProfile();
  if (!runtimeHasCandidateProfile) return (jobs || []).map(j => ({ ...j, fitScore: 25,
    matchEvidence: [], gaps: ['verified local candidate profile is not configured'],
    conflicts: [], confidence: 'low' }));
  const chunks = [];
  for (let i = 0; i < jobs.length; i += 10) chunks.push(jobs.slice(i, i + 10));
  const byId = {};
  let next = 0, done = 0;
  async function worker() {
    while (next < chunks.length) {
      const idx = next++;
      let scores = [];
      try { scores = await scoreJobChunk(chunks[idx]); }
      catch (e) { console.log(`[PJA] chunk ${idx + 1} failed: ${e.message}`); }
      for (const s of scores) if (s && s.id != null) byId[String(s.id)] = s;
      console.log(`[PJA] scored chunk ${++done}/${chunks.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length || 1) }, worker));
  const { tnAdjustScore, medicalWaferBoost } = require('./sourcing/filter');
  return jobs.map(j => {
    const result = byId[String(j.id)] || null;
    if (!result) return { ...j, fitScore: null, matchEvidence: [], gaps: [], conflicts: [], confidence: 'low' };
    const matchEvidence = Array.isArray(result.matchEvidence) ? result.matchEvidence.filter(Boolean).slice(0, 8) : [];
    const gaps = Array.isArray(result.gaps) ? result.gaps.filter(Boolean).slice(0, 8) : [];
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts.filter(Boolean).slice(0, 8) : [];
    const confidence = ['high', 'medium', 'low'].includes(String(result.confidence || '').toLowerCase()) ? String(result.confidence).toLowerCase() : 'low';
    let fitScore = medicalWaferBoost(j.title, j.company, j.description, tnAdjustScore(j.title, Number(result.score)));
    if (matchEvidence.length < 3 || conflicts.length || confidence === 'low') fitScore = Math.min(fitScore, 74);
    return { ...j, fitScore, matchEvidence, gaps, conflicts, confidence };
  });
}

function summarizeFailureSnapshot(snapshot = {}) {
  return {
    company: snapshot.company || '',
    title: snapshot.title || '',
    ats: snapshot.ats || '',
    applyUrl: snapshot.applyUrl || '',
    hostname: snapshot.hostname || '',
    phase: snapshot.phase || '',
    reason: snapshot.reason || '',
    stuckForMs: snapshot.stuckForMs || 0,
    recoveryAttempt: snapshot.recoveryAttempt || 0,
    previousRecovery: Array.isArray(snapshot.previousRecovery) ? snapshot.previousRecovery.slice(-5) : [],
    afterState: snapshot.afterState && typeof snapshot.afterState === 'object' ? snapshot.afterState : null,
    missingRequired: Array.isArray(snapshot.missingRequired) ? snapshot.missingRequired.slice(0, 20) : [],
    visibleErrors: Array.isArray(snapshot.visibleErrors) ? snapshot.visibleErrors.slice(0, 20) : [],
    formSummary: snapshot.formSummary || '',
    stepLog: Array.isArray(snapshot.stepLog) ? snapshot.stepLog.slice(-20) : [],
    domSummary: snapshot.domSummary && typeof snapshot.domSummary === 'object' ? snapshot.domSummary : null,
    screenshot: snapshot.screenshot && snapshot.screenshot.dataUrl ? {
      present: true,
      mime: snapshot.screenshot.mime || 'image/jpeg',
      chars: String(snapshot.screenshot.dataUrl || '').length,
      truncated: !!snapshot.screenshot.truncated,
    } : { present: false },
  };
}

// ── HTTP request handler ────────────────────────────────────────────────────
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  // Non-sensitive onboarding diagnostic: reports whether local profile/resume prerequisites
  // exist without returning any personal values.
  if (req.method === 'GET' && req.url === '/candidate-status') {
    const status = await refreshRuntimeCandidateProfile();
    res.writeHead(200, CORS); res.end(JSON.stringify(status)); return;
  }

  if (req.method === 'GET' && req.url === '/one-click-preflight') {
    const preflight = await oneClickPreflight({});
    res.writeHead(preflight.ok ? 200 : 409, CORS);
    res.end(JSON.stringify(preflight));
    return;
  }

  if (req.method === 'POST' && req.url === '/one-click-preflight') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const preflight = await oneClickPreflight(o);
        res.writeHead(preflight.ok ? 200 : 409, CORS);
        res.end(JSON.stringify(preflight));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ ok: false, problems: ['preflight_error'], error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/apply-status') {
    try {
      const st = await getStorageFromExtension([
        'pja_ranked_apply',
        'pja_last_completed_apply_run',
        'pja_application_ledger',
        'pja_applied_log',
        'pja_last_apply_failure',
        'pja_dbg',
      ], 8000);
      const status = summarizeApplyStatus(st || {});
      const autoReport = maybeAutoExportApplyReport(st || {});
      if (autoReport) status.report = autoReport;
      res.writeHead(200, CORS);
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ ok: false, error: e.message, clients: wsClients.size }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, engine: `${AI_ENGINE}-cli`, clients: wsClients.size }));
    return;
  }

  // ── /reload: push reload signal to all connected extension clients ──────────
  if (req.method === 'POST' && req.url === '/reload') {
    let pushed = 0;
    for (const client of wsClients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send('reload');
        pushed++;
      }
    }
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, pushed }));
    console.log(`[PJA] /reload → pushed to ${pushed} client(s)`);
    return;
  }

  // ── /start-ea: backend-trigger the extension's Easy-Apply auto-loop ──────────
  // body: { jobs: [{jobId, title, company, fitScore}], threshold=55 }.
  // Sends a WS command so background opens the first job, seeds the EA queue, and the extension
  // auto-applies via its OWN CDP (no claude-in-chrome). Apply jobs must be resume-scored by
  // default; pass requireScored:false only for diagnostic dry testing.
  if (req.method === 'POST' && req.url === '/start-ea') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}') || {}; } catch (_) {}
      const gate = gateScoredApplyJobs(parsed.jobs || [], parsed);
      const jobs = gate.jobs;
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startEasyApply', jobs })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed, queued: jobs.length,
        skipped: gate.skipped, threshold: gate.threshold, requireScored: gate.requireScored }));
      console.log(`[PJA] /start-ea → ${jobs.length} queued, ${gate.skipped.length} skipped, threshold=${gate.threshold} to ${pushed} client(s)`);
    });
    return;
  }

  // ── /start-indeed-apply: backend-trigger the Indeed Apply queue
  // body: { jobs: [{jobId, title, company, fitScore}], threshold=55 }.
  if (req.method === 'POST' && req.url === '/start-indeed-apply') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}') || {}; } catch (_) {}
      const gate = gateScoredApplyJobs(parsed.jobs || [], parsed);
      const jobs = gate.jobs;
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startIndeedApply', jobs })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed, queued: jobs.length,
        skipped: gate.skipped, threshold: gate.threshold, requireScored: gate.requireScored }));
      console.log(`[PJA] /start-indeed-apply → ${jobs.length} queued, ${gate.skipped.length} skipped, threshold=${gate.threshold} to ${pushed} client(s)`);
    });
    return;
  }

  // ── /start-scan: backend-trigger LinkedIn / Indeed / Glassdoor browser collection ──
  if (req.method === 'POST' && req.url === '/start-scan') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let url = null, fast = false, source = null;
      try { const b = JSON.parse(body || '{}'); url = b.url || null; fast = !!b.fast; source = b.source || null; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startScan', url, fast, source })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed }));
      console.log(`[PJA] /start-scan → ${pushed} client(s) url=${url || '(default)'}`);
    });
    return;
  }

  // Sanitized DOM diagnostics for the currently open ATS form. This intentionally omits field
  // values and profile data; it exposes only controls, labels, validation state, and page text.
  if (req.method === 'GET' && req.url === '/inspect-apply') {
    (async () => {
      try {
        const data = await wsAsk('inspectActiveApply', {}, 'inspectActiveApplyReply', 10000);
        res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── /recover-active-apply: inspect the current ranked apply tab and ask the AI engine for a
  // bounded, structured recovery plan. This does not execute actions directly; the extension's
  // content script remains the executor and allowlist gate.
  if (req.method === 'POST' && req.url === '/recover-active-apply') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const inspect = await wsAsk('inspectActiveApply', {}, 'inspectActiveApplyReply', 12000);
        const activeTab = (inspect.tabs || [])[0] || null;
        const activeFrame = activeTab && Array.isArray(activeTab.frames)
          ? activeTab.frames.find(f => f && f.url && /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs|workday\.com|smartrecruiters\.com|indeed\.com/i.test(f.url)) || activeTab.frames[0]
          : null;
        const job = inspect.ranked && inspect.ranked.currentJob || {};
        const snapshot = {
          reason: o.reason || (inspect.lastFailure && inspect.lastFailure.reason) || 'stuck_wait',
          company: o.company || job.company || (inspect.lastFailure && inspect.lastFailure.company) || '',
          title: o.title || job.title || (inspect.lastFailure && inspect.lastFailure.title) || '',
          ats: o.ats || job.ats || '',
          applyUrl: o.applyUrl || job.applyUrl || (activeFrame && activeFrame.url) || '',
          hostname: (() => { try { return new URL(o.applyUrl || job.applyUrl || activeFrame?.url || '').hostname; } catch (_) { return ''; } })(),
          phase: o.phase || '',
          stuckForMs: Number(o.stuckForMs || 0),
          recoveryAttempt: Number(o.recoveryAttempt || 0),
          previousRecovery: Array.isArray(o.previousRecovery) ? o.previousRecovery : [],
          missingRequired: Array.isArray(o.missingRequired) ? o.missingRequired : (activeFrame && activeFrame.required || []).map(x => x.name || x.label || x.type || '').filter(Boolean),
          visibleErrors: Array.isArray(o.visibleErrors) ? o.visibleErrors : (activeFrame && activeFrame.errors || []),
          formSummary: o.formSummary || 'active apply page inspection requested by recovery endpoint',
          stepLog: Array.isArray(o.stepLog) ? o.stepLog : (inspect.recentDebug || []),
          domSummary: {
            tabId: activeTab && activeTab.tabId,
            url: activeFrame && activeFrame.url,
            title: activeFrame && activeFrame.title,
            controls: activeFrame && activeFrame.controls || [],
            required: activeFrame && activeFrame.required || [],
            radios: activeFrame && activeFrame.radios || [],
            errors: activeFrame && activeFrame.errors || [],
            textTail: activeFrame && activeFrame.textTail || '',
            ranked: inspect.ranked || null,
          },
          screenshot: inspect.screenshot && inspect.screenshot.dataUrl ? inspect.screenshot : null,
        };
        const helpResp = await postLocalJson('/apply-help', snapshot, Number(o.timeoutMs) || 150000);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, inspect, recovery: helpResp, snapshot: summarizeFailureSnapshot(snapshot) }));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Resume a paused/stale ranked application run through the service worker dispatcher. This is
  // safer than manually opening the URL because it restores in-flight metadata consistently.
  if (req.method === 'POST' && req.url === '/resume-apply-run') {
    (async () => {
      try {
        const data = await wsAsk('resumeRankedApply', {}, 'resumeRankedApplyReply', 30000);
        res.writeHead(data && data.ok ? 200 : 409, CORS);
        res.end(JSON.stringify(data || { ok: false, error: 'empty response' }));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── /export-apply-report: write a sanitized developer-readable markdown artifact ──
  // This is the durable file counterpart to the extension's volatile pja_ranked_apply /
  // pja_application_ledger state. It deliberately excludes profile/resume/answer values.
  if (req.method === 'POST' && req.url === '/export-apply-report') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const st = await getStorageFromExtension([
          'pja_ranked_apply',
          'pja_last_completed_apply_run',
          'pja_application_ledger',
          'pja_applied_log',
          'pja_last_apply_failure',
          'pja_dbg',
        ], Number(o.timeoutMs) || 10000);
        const written = writeApplyRunReport(st || {}, { runId: o.runId });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, ...written }));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /close-job-tabs: close stray LinkedIn/ATS tabs (clears CDP contention before a clean run) ──
  if (req.method === 'POST' && req.url === '/close-job-tabs') {
    let pushed = 0;
    for (const client of wsClients) { if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'closeJobTabs' })); pushed++; } }
    res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, pushed }));
    console.log(`[PJA] /close-job-tabs → ${pushed} client(s)`);
    return;
  }

  // Close only duplicate tabs for the active ranked job, keeping the current in-flight tab.
  if (req.method === 'POST' && req.url === '/close-duplicate-apply-tabs') {
    (async () => {
      try {
        const data = await wsAsk('closeDuplicateActiveApplyTabs', {}, 'closeDuplicateActiveApplyTabsReply', 10000);
        res.writeHead(200, CORS); res.end(JSON.stringify(data));
        console.log(`[PJA] /close-duplicate-apply-tabs → closed=${data && data.closed}`);
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── /open-tab: open a URL in a new tab (kicks off external-apply on the first ATS page) ──
  if (req.method === 'POST' && req.url === '/open-tab') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let url = null;
      try { url = JSON.parse(body || '{}').url || null; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1 && url) { client.send(JSON.stringify({ cmd: 'openTab', url })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed, url }));
      console.log(`[PJA] /open-tab → ${url} to ${pushed} client(s)`);
    });
    return;
  }

  // ── /inject-resume: tell the extension to inject the stored résumé (pja_resume_b64) into the
  // file input of the tab matching `urlMatch`. Works around the MCP file_upload tool. ──
  if (req.method === 'POST' && req.url === '/inject-resume') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      const o = body ? JSON.parse(body) : {};
      const r = await wsAsk('injectResume', { urlMatch: o.urlMatch || 'myworkdayjobs.com' }, 'injectResumeReply', 15000);
      console.log('[PJA] /inject-resume →', JSON.stringify(r));
      res.writeHead(200, CORS);
      res.end(JSON.stringify(r));
    });
    return;
  }

  // Start SAP SuccessFactors RMK's client-side apply flow on an already-open job tab.
  // This only invokes RMK's own Apply Now handler; the normal ATS automation remains
  // responsible for filling the resulting form and deciding whether it can be submitted.
  if (req.method === 'POST' && req.url === '/successfactors-start') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const r = await wsAsk('successFactorsStart', { urlMatch: String(o.urlMatch || '') },
          'successFactorsStartReply', 15000);
        console.log('[PJA] /successfactors-start →', JSON.stringify(r));
        res.writeHead(200, CORS);
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /restart-chrome: P1c self-heal last rung — graceful Chrome quit + relaunch so a
  // degraded CDP session is replaced by a fresh one. The EXTENSION owns detection + the
  // notify/countdown; it calls this only after the lighter rungs (debugger re-attach,
  // /reload) fail. Graceful quit lets Chrome restore tabs (incl. the in-flight apply tab);
  // the queue resumes from pja_ext_queue.currentIndex on reconnect. macOS only. ──
  if (req.method === 'POST' && req.url === '/restart-chrome') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let reopenUrl = null;
      try { reopenUrl = JSON.parse(body || '{}').reopenUrl || null; } catch (_) {}
      const plan = buildRestartPlan({ reopenUrl });
      if (!plan.supported) {
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: false, reason: plan.reason }));
        console.log(`[PJA] /restart-chrome unsupported: ${plan.reason}`);
        return;
      }
      // Respond BEFORE quitting — the WS drops the instant Chrome exits.
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, waitMs: plan.waitMs, reopenUrl: plan.reopenUrl }));
      console.log(`[PJA] /restart-chrome → graceful quit, relaunch in ${plan.waitMs}ms${plan.reopenUrl ? ' → ' + plan.reopenUrl : ''}`);
      exec(plan.quitCmd, (err) => {
        if (err) console.error(`[PJA] restart quit error: ${err.message}`);
        setTimeout(() => {
          exec(plan.relaunchCmd, (e2) => {
            if (e2) console.error(`[PJA] restart relaunch error: ${e2.message}`);
            else console.log('[PJA] Chrome relaunched — awaiting extension reconnect');
          });
        }, plan.waitMs);
      });
    });
    return;
  }

  // ── /resolve-ats: resolve external ATS URLs for jobIds via voyager (body {jobIds:[...]}) ──
  if (req.method === 'POST' && req.url === '/resolve-ats') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let jobIds = [];
      try { jobIds = JSON.parse(body || '{}').jobIds || []; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'resolveAts', jobIds })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed, count: jobIds.length }));
      console.log(`[PJA] /resolve-ats → ${jobIds.length} jobIds to ${pushed} client(s)`);
    });
    return;
  }

  // ── /inject: push inject signal to re-inject content scripts into open tabs ──
  if (req.method === 'POST' && req.url === '/inject') {
    let pushed = 0;
    for (const client of wsClients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send('inject');
        pushed++;
      }
    }
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, pushed }));
    console.log(`[PJA] /inject → pushed to ${pushed} client(s)`);
    return;
  }

  // ── /get-storage: request storage values from extension via WS round-trip ───
  if (req.method === 'POST' && req.url === '/get-storage') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { keys } = JSON.parse(body);
        const reqId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        let responded = false;
        // Wait for the extension to reply with a storageReply message
        const handler = (ws) => {
          const onMsg = (raw) => {
            try {
              const msg = JSON.parse(raw);
              if (msg.cmd === 'storageReply' && msg.reqId === reqId && !responded) {
                responded = true;
                ws.removeListener('message', onMsg);
                res.writeHead(200, CORS);
                res.end(JSON.stringify({ ok: true, data: msg.data }));
              }
            } catch(e) {}
          };
          ws.on('message', onMsg);
        };
        let sent = 0;
        for (const client of wsClients) {
          if (client.readyState === 1) {
            handler(client);
            client.send(JSON.stringify({ cmd: 'getStorage', keys, reqId }));
            sent++;
            break; // only need one client
          }
        }
        if (!sent) { res.writeHead(503, CORS); res.end(JSON.stringify({ error: 'no extension connected' })); return; }
        setTimeout(() => { if (!responded) { responded = true; res.writeHead(504, CORS); res.end(JSON.stringify({ error: 'timeout' })); } }, 3000);
      } catch(e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Merge one or more verified answers into the existing answer bank without callers having to
  // round-trip the full (potentially sensitive) storage object through a shell command.
  if (req.method === 'POST' && req.url === '/save-answers') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const updates = Array.isArray(o.answers) ? o.answers : [o];
        const valid = updates.filter(a => a && String(a.normalizedLabel || '').trim() &&
          Object.prototype.hasOwnProperty.call(a, 'value'));
        if (!valid.length) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ ok: false, error: 'normalizedLabel and value are required' }));
          return;
        }
        const st = await getStorageFromExtension(['pja_answers']);
        const answers = st.pja_answers || {};
        const savedAt = Date.now();
        for (const update of valid) {
          const key = String(update.normalizedLabel).trim();
          const existing = answers[key] || {};
          answers[key] = {
            ...existing,
            rawLabel: update.rawLabel || existing.rawLabel || key,
            answer: update.value,
            savedAt,
            usedCount: Number(existing.usedCount || 0)
          };
        }
        const pushed = setStorageToExtension({ pja_answers: answers });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, pushed, saved: valid.map(a => String(a.normalizedLabel).trim()) }));
      } catch (e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /set-storage: push arbitrary storage data to the extension ─────────────
  if (req.method === 'POST' && req.url === '/set-storage') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let pushed = 0;
        for (const client of wsClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ cmd: 'setStorage', data }));
            pushed++;
          }
        }
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, pushed }));
        console.log(`[PJA] /set-storage → pushed ${Object.keys(data).join(', ')} to ${pushed} client(s)`);
      } catch(e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /launch-queue: seed pja_ext_queue + pja_ext_current from test-jobs.json ──
  // Optional body: { startIndex: 0, jobIds: ["id1","id2",...] } to filter/start at offset
  // Also needs the extension to have pja_profile+pja_answers in storage already.
  // After setting storage, sends an 'openTab' command to open the first job URL.
  if (req.method === 'POST' && req.url.startsWith('/launch-queue')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const opts = body ? JSON.parse(body) : {};
        const jobsFile = path.join(__dirname, 'test', 'test-jobs.json');
        let jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
        if (opts.jobIds && opts.jobIds.length) {
          jobs = jobs.filter(j => opts.jobIds.includes(j.id));
        }
        const startIndex = opts.startIndex || 0;
        const runId = 'devrun_' + Date.now();
        const returnUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true';

        // Get profile+answers from extension, then set the queue
        const reqId = 'lq_' + Date.now();
        let responded = false;

        const finalize = (profile, answers) => {
          const queue = {
            status: 'applying',
            jobs,
            currentIndex: startIndex,
            results: { applied: [], skipped: [] },
            profile: profile || {},
            answers: answers || {},
            startedAt: Date.now(),
            runId,
            source: 'dev-server-launch'
          };
          const first = jobs[startIndex];
          if (!first) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'no jobs at startIndex' })); return; }
          const firstCurrent = { ...first, profile: profile || {}, answers: answers || {}, returnUrl, applyUrl: first.applyUrl, runId };

          let pushed = 0;
          for (const client of wsClients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ cmd: 'setStorage', data: { pja_ext_queue: queue, pja_ext_current: firstCurrent } }));
              client.send(JSON.stringify({ cmd: 'openTab', url: first.applyUrl }));
              pushed++;
            }
          }
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ ok: true, pushed, jobs: jobs.length, first: first.title + ' @ ' + first.company, runId }));
          console.log(`[PJA] /launch-queue → ${jobs.length} jobs, starting ${first.title} @ ${first.company}`);
        };

        // Fetch current profile+answers from extension
        const handler = (ws) => {
          const onMsg = (raw) => {
            try {
              const msg = JSON.parse(raw);
              if (msg.cmd === 'storageReply' && msg.reqId === reqId && !responded) {
                responded = true;
                ws.removeListener('message', onMsg);
                finalize(msg.data.pja_profile, msg.data.pja_answers);
              }
            } catch(e) {}
          };
          ws.on('message', onMsg);
        };

        let sent = 0;
        for (const client of wsClients) {
          if (client.readyState === 1) {
            handler(client);
            client.send(JSON.stringify({ cmd: 'getStorage', keys: ['pja_profile', 'pja_answers'], reqId }));
            sent++;
            break;
          }
        }
        if (!sent) { res.writeHead(503, CORS); res.end(JSON.stringify({ error: 'no extension connected' })); return; }
        setTimeout(() => { if (!responded) { responded = true; finalize({}, {}); } }, 3000);
      } catch(e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /cdp-date-test: trigger CDP date typing into a Workday spinner ──────────
  if (req.method === 'POST' && req.url === '/cdp-date-test') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body); // { tabId, baseId, month, day, year }
        let pushed = 0;
        for (const client of wsClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ cmd: 'cdpDateTest', ...data }));
            pushed++;
          }
        }
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, pushed }));
        console.log(`[PJA] /cdp-date-test → tabId=${data.tabId} baseId=${data.baseId}`);
      } catch(e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /queue-status: background pushes queue state here; curl /queue-status to read ──
  if (req.method === 'POST' && req.url === '/queue-status') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { _lastQueueStatus = JSON.parse(body); } catch(e) {}
      res.writeHead(200, CORS); res.end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/queue-status') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_lastQueueStatus || { error: 'no data yet' }));
    return;
  }

  // ── /resume-apply: ask extension SW to reconcile ledger/current state and dispatch next job ──
  if (req.method === 'POST' && req.url === '/resume-apply') {
    req.resume();
    req.on('end', async () => {
      try {
        if (![...wsClients].some(c => c.readyState === 1)) {
          res.writeHead(503, CORS); res.end(JSON.stringify({ ok: false, error: 'no extension connected' })); return;
        }
        const data = await wsAsk('resumeRankedApply', {}, 'resumeRankedApplyReply', 30000);
        res.writeHead(data && data.ok ? 200 : 502, CORS);
        res.end(JSON.stringify(data || { ok: false, error: 'resume did not reply' }));
      } catch (e) {
        res.writeHead(502, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/analyze') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { title, company, description } = JSON.parse(body);
        const label = `${title || 'Unknown'} @ ${company || 'Unknown'}`;
        process.stdout.write(`[PJA] ${label} … `);
        const t0 = Date.now();

        const userPrompt =
`Analyze this job posting for the candidate:

Job Title: ${title || 'Unknown'}
Company: ${company || 'Unknown'}

Job Description:
${(description || '').slice(0, 6000)}`;

        const raw = await runClaude(userPrompt);
        // Extract the JSON object robustly — Haiku sometimes adds text after the closing }
        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object in response: ' + raw.slice(0, 120));
        const data = JSON.parse(raw.slice(start, end + 1));
        data.engine = `${AI_ENGINE}-dev`;

        console.log(`done (${Date.now() - t0}ms) score=${data.fitScore}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, data, engine: `${AI_ENGINE}-dev` }));
      } catch (e) {
        console.error(`\n[PJA] Error: ${e.message}`);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /batch-score: score up to 10 jobs in one Claude call ──────────────────
  if (req.method === 'POST' && req.url === '/batch-score') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { jobs } = JSON.parse(body);  // jobs: [{id, title, company, description}]
        if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('jobs array required');
        const batch = jobs.slice(0, 10);
        process.stdout.write(`[PJA] Batch scoring ${batch.length} jobs… `);
        const t0 = Date.now();

        const scored = await scoreAll(batch, 1);
        const scores = scored.map(j => ({ id: j.id, score: j.fitScore,
          matchEvidence: j.matchEvidence || [], gaps: j.gaps || [], conflicts: j.conflicts || [],
          confidence: j.confidence || 'low' }));

        console.log(`done (${Date.now() - t0}ms) scores=[${scores.map(s=>s.score).join(',')}]`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, scores }));
      } catch (e) {
        console.error(`\n[PJA] Batch error: ${e.message}`);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /score-shortlist: concurrently score every unscored (fitScore==null) shortlist entry ──
  // Used after FAST coverage scans (which collect placeholders only). Much faster than the scan's
  // sequential per-batch scoring (scoreAll runs 4 chunks in parallel). Writes fitScore back.
  if (req.method === 'POST' && req.url === '/score-shortlist') {
    (async () => {
      try {
        const st = await getStorageFromExtension(['pja_shortlist']);
        const list = (st && st.pja_shortlist) || [];
        const unscored = list.filter(j => j && (j.fitScore == null) && (j.id || j.jobId));
        if (unscored.length === 0) {
          res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, scored: 0, total: list.length })); return;
        }
        const scored = await scoreAll(unscored.map(j => ({ id: j.id || j.jobId, title: j.title, company: j.company, location: j.location, description: j.description || '' })));
        const byId = {};
        for (const s of scored) byId[String(s.id)] = s;
        const merged = list.map(j => {
          const id = String(j.id || j.jobId || '');
          const s = byId[id];
          return (s && s.fitScore != null) ? { ...j, fitScore: s.fitScore,
            matchEvidence: s.matchEvidence || [], gaps: s.gaps || [], conflicts: s.conflicts || [],
            confidence: s.confidence || 'low', status: 'scored' } : j;
        });
        setStorageToExtension({ pja_shortlist: merged });
        const got = Object.values(byId).filter(v => v && v.fitScore != null).length;
        res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, scored: got, requested: unscored.length, total: merged.length }));
        console.log(`[PJA] /score-shortlist → scored ${got}/${unscored.length}`);
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── /source: find roles across ATSes, fit-score, route to queue/shortlist ──
  // body: { threshold=70, write=true }. This is a legacy sourcing/review endpoint only;
  // autonomous submission is intentionally exclusive to /apply-run's evidence gate.
  if (req.method === 'POST' && req.url === '/source') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const threshold = o.threshold != null ? o.threshold : 70;
        const requestedQueueLimit = o.queueLimit || 0;
        const queueLimit = 0; // fail closed: never bypass /apply-run's strict evidence gate
        const write = o.write !== false;
        const sources = (o.sources) || JSON.parse(fs.readFileSync(__dirname + '/sourcing/sources.json', 'utf8')).sources;

        // Dedupe against already-applied: durable applied log (survives queue overwrites) +
        // pja_jobs + current queue results.
        const st = await getStorageFromExtension(['pja_profile', 'pja_jobs', 'pja_ext_queue', 'pja_applied_log']);
        const browserJobs = await getBrowserShortlistFromExtension(30000);
        const { pjaCollectAppliedRecords } = require('./sourcing/dedupe');
        const applied = pjaCollectAppliedRecords(st);

        console.log(`[PJA] /source: ${sources.length} sources, threshold=${threshold}, queueLimit=${queueLimit}, applied-known=${applied.length}`);
        const result = await runPipeline({
          sources, opts: { threshold, concurrency: 8 }, appliedRecords: applied, scoreFn: scoreAll,
        });

        let wrote = { shortlist: 0, queued: 0 };
        if (write) {
          // Append new scored roles to pja_shortlist (existing review UI renders them).
          const existing = Array.isArray(st.pja_shortlist) ? st.pja_shortlist : [];
          const merged = existing.concat(result.scored.map(j => ({
            id: j.id, title: j.title, company: j.company, location: j.location,
            applyUrl: j.applyUrl, ats: j.ats, fitScore: j.fitScore,
            description: j.description || '', matchEvidence: j.matchEvidence || [],
            gaps: j.gaps || [], conflicts: j.conflicts || [], confidence: j.confidence || 'low',
            source: 'sourcing',
          })));
          const payload = { pja_shortlist: merged };
          wrote.shortlist = result.scored.length;

          if (queueLimit > 0 && result.queue.length) {
            const pick = result.queue.slice(0, queueLimit).map(j => ({
              id: j.id, title: j.title, company: j.company, ats: j.ats,
              applyUrl: j.applyUrl, location: j.location, profile: {}, answers: {},
            }));
            const runId = 'source-' + Date.now();
            const queue = { status: 'applying', jobs: pick, currentIndex: 0, results: { applied: [], skipped: [] }, runId, startedAt: Date.now() };
            const first = { ...pick[0], returnUrl: 'https://www.linkedin.com/jobs/search/?f_AL=true', runId };
            Object.assign(payload, { pja_ext_queue: queue, pja_ext_current: first, pja_ext_stop_before_submit: false, pja_navigate_to: pick[0].applyUrl });
            wrote.queued = pick.length;
          }
          setStorageToExtension(payload);
        }

        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, totals: result.totals, wrote,
          warning: requestedQueueLimit > 0 ? 'queueLimit ignored; use /apply-run for evidence-gated submission' : undefined,
          liveSources: result.stats.filter(s => s.count > 0).length,
          top: result.scored.slice().sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0)).slice(0, 25)
            .map(j => ({ score: j.fitScore, company: j.company, title: j.title, location: j.location })) }));
      } catch (e) {
        console.error('[PJA] /source error:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /apply-all: safe full-flow wrapper for normal use ──────────────────────
  // Runs broad sourcing first, then the unified ranked driver. Prefer this over
  // /start-ea for "apply N jobs" because /start-ea is LinkedIn Easy Apply only.
  // body supports:
  //   {
  //     targetConfirmed:20, threshold:70, sourceTarget:160, perCompanyCap:2,
  //     includeAssisted:true, e2eSafe:true, source:false, dryRun:false, ...
  //   }
  // Unrecognized top-level fields are forwarded to /apply-run, so callers can still use
  // atsAllow, companyDeny, titleDeny, candidateIds, stopBeforeSubmit, force, etc.
  if (req.method === 'POST' && req.url === '/apply-all') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        if (o.preflight !== false) {
          const preflight = await oneClickPreflight(o);
          if (!preflight.ok) {
            res.writeHead(409, CORS);
            res.end(JSON.stringify({ success: false, stage: 'preflight', preflight,
              error: 'one-click preflight failed: ' + preflight.problems.join(', ') }));
            return;
          }
        }
        const applyAllAboveScore = o.applyAllAboveScore === true ||
          /^(all_above_score|allAboveScore|above_score)$/i.test(String(o.stopMode || ''));
        const targetConfirmed = o.targetConfirmed != null ? Math.max(1, Number(o.targetConfirmed) || 1)
          : (o.dailyCap != null && !applyAllAboveScore ? Math.max(1, Number(o.dailyCap) || 1) : 20);
        const sourceTarget = o.sourceTarget != null ? Math.max(1, Number(o.sourceTarget) || 1)
          : (applyAllAboveScore ? 300 : Math.max(120, targetConfirmed * 8));
        const sourceBody = {
          target: sourceTarget,
          write: o.sourceWrite !== false,
        };
        if (Array.isArray(o.queries) && o.queries.length) {
          sourceBody.queries = o.queries.map(q => String(q || '').trim()).filter(Boolean);
        }
        if (o.maxBrowserAgeMs != null) sourceBody.maxBrowserAgeMs = Number(o.maxBrowserAgeMs);
        const applyBody = Object.assign({}, o, {
          applyAllAboveScore,
          stopMode: applyAllAboveScore ? 'all_above_score' : (o.stopMode || 'target_confirmed'),
          targetConfirmed,
          dailyCap: o.dailyCap != null ? o.dailyCap : (applyAllAboveScore ? 0 : targetConfirmed),
          threshold: o.threshold != null ? o.threshold : 70,
          rescore: o.rescore !== false,
          requireEvidence: o.requireEvidence !== false,
          maxGaps: o.maxGaps != null ? Number(o.maxGaps) : 20,
          includeAssisted: o.includeAssisted !== false,
          perCompanyCap: o.perCompanyCap != null ? o.perCompanyCap : 2,
          e2eSafe: o.e2eSafe !== false,
        });
        delete applyBody.source;
        delete applyBody.sourceTarget;
        delete applyBody.sourceWrite;
        delete applyBody.maxBrowserAgeMs;
        delete applyBody.queries;

        let sourceResp = { ok: true, skipped: true, status: 200, data: { note: 'source:false' } };
        if (o.source !== false) {
          sourceResp = await postLocalJson('/source-v2', sourceBody, Number(o.sourceTimeoutMs) || 300000);
          if (!sourceResp.ok || sourceResp.data && sourceResp.data.success === false) {
            res.writeHead(sourceResp.status || 502, CORS);
            res.end(JSON.stringify({ success: false, stage: 'source-v2', sourceOptions: sourceBody,
              source: sourceResp.data }));
            return;
          }
        }

        const applyResp = await postLocalJson('/apply-run', applyBody, Number(o.applyTimeoutMs) || 600000);
        res.writeHead(applyResp.status || (applyResp.ok ? 200 : 502), CORS);
        res.end(JSON.stringify({ success: !!(applyResp.ok && (!applyResp.data || applyResp.data.success !== false)),
          sourceOptions: sourceBody, applyOptions: applyBody,
          source: sourceResp.data, apply: applyResp.data }));
        console.log(`[PJA] /apply-all: source=${o.source === false ? 'skipped' : 'done'} applyStatus=${applyResp.status}`);
      } catch (e) {
        console.error('[PJA] /apply-all error:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /source-v2: multi-modal sourcing into the NORMALIZED store (Find-200 goal) ────────────
  // Runs Modality A (API registry) + Modality B (discovery) via sourcing/source-run, dedupes on
  // the canonical id + mirror-key, excludes already-applied, and imports the description-rich
  // records directly into extension IndexedDB over an acknowledged WebSocket message. Additive: the
  // legacy /source (pja_shortlist) path is untouched.
  if (req.method === 'POST' && req.url === '/source-v2') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const write = o.write !== false;
        const st = await getStorageFromExtension(['pja_profile', 'pja_jobs', 'pja_ext_queue', 'pja_applied_log']);
        const browserJobs = await getBrowserShortlistFromExtension(30000);
        const { pjaCollectAppliedRecords, appliedIdentity } = require('./sourcing/dedupe');
        const applied = appliedIdentity(pjaCollectAppliedRecords(st));

        const { sourceAll } = require('./sourcing/source-run');
        const willing = /^(yes|true|1)$/i.test(String((st.pja_profile || {}).willingToRelocate || ''));
        const queries = Array.isArray(o.queries) ? o.queries.map(q => String(q || '').trim()).filter(Boolean) : undefined;
        const { store, report } = await sourceAll({ appliedIdentity: applied, target: o.target || 200, nationwideUS: willing,
          queries: queries && queries.length ? queries : undefined,
          browserJobs,
          maxBrowserAgeMs: o.maxBrowserAgeMs != null ? Number(o.maxBrowserAgeMs) : 48 * 60 * 60 * 1000 });

        let wrote = 0;
        if (write) {
          const imported = await wsAsk('importCorpus', { index: store.index, state: store.state,
            // Only retire records absent from this run when the fresh corpus itself passed its
            // supply/quality gate; a transient partial run must not wipe healthy prior coverage.
            replaceMissing: report.gate.pass }, 'importCorpusReply', 120000);
          if (!imported || imported.error || imported.ok === false) throw new Error('corpus import failed: ' + ((imported && imported.error) || 'no acknowledgement'));
          wrote = imported.imported != null ? imported.imported : Object.keys(store.index).length;
        }
        console.log(`[PJA] /source-v2: unique=${report.gate.uniqueIds} modalities=${report.gate.modalities.join('+')} gate=${report.gate.pass ? 'PASS' : 'FAIL'}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, wrote, report }));
      } catch (e) {
        console.error('[PJA] /source-v2 error:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /apply-run: the corpus→apply driver (Phase B). Build the apply-set from the corpus, optionally
  // LLM-rescore, seed pja_ext_queue, and kick off the autonomous apply loop. The extension's
  // external-apply.js auto-advances and writes each result back to the corpus (UPDATE_CORPUS_STATE).
  if (req.method === 'POST' && req.url === '/apply-run') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let ownsPlanningLock = false;
      try {
        const o = body ? JSON.parse(body) : {};
        const threshold = o.threshold != null ? o.threshold : 75;
        const applyAllAboveScore = o.applyAllAboveScore === true ||
          /^(all_above_score|allAboveScore|above_score)$/i.test(String(o.stopMode || ''));
        const runMode = applyAllAboveScore ? 'all_above_score' : 'target_confirmed';
        const dailyCap = o.dailyCap != null ? Math.max(0, Number(o.dailyCap) || 0) : (applyAllAboveScore ? 0 : 50);
        const dailyTarget = applyAllAboveScore ? null : (o.targetConfirmed != null ? Math.max(1, Number(o.targetConfirmed) || 1)
          : Math.max(1, Number(dailyCap) || 1));
        const e2eSafe = o.e2eSafe === true;
        // Zero means keep every qualified reserve. The global dispatcher stops as soon as the
        // confirmed target is reached, so reserves replace failures without causing over-submit.
        const attemptCap = o.attemptCap != null ? Math.max(0, Number(o.attemptCap) || 0)
          : (applyAllAboveScore ? 0 : (e2eSafe ? Math.max(25, dailyTarget * 2) : 0));
        // Evidence-grounded resume/JD rescoring is the safe default. Callers may explicitly set
        // rescore:false for diagnostics, but autonomous apply planning should never trust title-only
        // heuristic scores.
        const rescore = o.rescore !== false;
        const stopBeforeSubmit = !!o.stopBeforeSubmit;
        // A heuristic-only request is diagnostic by definition and can never submit.
        const dryRun = !!o.dryRun || !rescore; // build + return the plan, but DON'T seed/open tabs
        const atsAllow = Array.isArray(o.atsAllow) ? o.atsAllow : null; // restrict to these ATS strategies (e.g. no-account trial)
        const requireEvidence = o.requireEvidence !== false;
        const maxGaps = o.maxGaps != null ? Number(o.maxGaps) : 2;
        const perCompanyCap = o.perCompanyCap != null ? Math.max(0, Number(o.perCompanyCap) || 0) : 0;
        const includeAssisted = o.includeAssisted === true;
        // A caller can require real E2E coverage across channels. Never silently turn such a
        // request into an external-only run when a browser channel lacks hydrated/scored jobs.
        const requiredChannels = Array.isArray(o.requiredChannels) ? Array.from(new Set(o.requiredChannels
          .map(x => String(x || '').trim()).filter(Boolean))) : [];
        const requiredStrategies = Array.isArray(o.requiredStrategies) ? Array.from(new Set(o.requiredStrategies
          .map(x => String(x || '').trim().toLowerCase()).filter(Boolean))) : [];
        const timeZone = o.timeZone || 'America/Los_Angeles';
        const candidateStatus = await refreshRuntimeCandidateProfile();
        const Ledger = require('./application-ledger');
        const day = o.day || Ledger.dayKey(Date.now(), timeZone);
        const companyDeny = new Set((Array.isArray(o.companyDeny) ? o.companyDeny : [])
          .map(x => String(x).trim().toLowerCase()).filter(Boolean));
        const titleDeny = (Array.isArray(o.titleDeny) ? o.titleDeny : [])
          .map(x => String(x).trim().toLowerCase()).filter(Boolean);
        // Optional exact company+title allow-list. This lets callers run evidence-heavy LLM
        // scoring on a reviewed shortlist instead of rescoring the entire corpus. Distinct
        // requisitions that share a company/title are intentionally retained and are still
        // deduped later by their canonical posting identity.
        const normCandidatePart = value => String(value || '').toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ').trim();
        const candidateKey = value => `${normCandidatePart(value && value.company)}::${normCandidatePart(value && value.title)}`;
        const candidateAllow = new Set((Array.isArray(o.candidateAllow) ? o.candidateAllow : [])
          .map(value => {
            if (value && typeof value === 'object') return candidateKey(value);
            const parts = String(value || '').split('::');
            return parts.length >= 2 ? candidateKey({ company: parts.shift(), title: parts.join('::') }) : '';
          }).filter(Boolean));
        const candidateIds = new Set((Array.isArray(o.candidateIds) ? o.candidateIds : [])
          .map(value => String(value || '').trim()).filter(Boolean));
        const denied = j => companyDeny.has(String(j.company || '').trim().toLowerCase()) ||
          titleDeny.some(term => String(j.title || '').toLowerCase().includes(term));
        const allowed = j => (!candidateAllow.size || candidateAllow.has(candidateKey(j))) &&
          (!candidateIds.size || candidateIds.has(String(j && j.id || '').trim()));
        if (![...wsClients].some(c => c.readyState === 1)) { res.writeHead(503, CORS); res.end(JSON.stringify({ error: 'no extension connected' })); return; }
        if (!dryRun) {
          if (applyRunPlanning) {
            res.writeHead(409, CORS); res.end(JSON.stringify({ error: 'an application run is already being planned' })); return;
          }
          applyRunPlanning = true;
          ownsPlanningLock = true;
        }
        const control = await getStorageFromExtension(['pja_ranked_apply', 'pja_application_ledger', 'pja_applied_log']);
        if (!dryRun && !o.force) {
          const run = control.pja_ranked_apply;
          if (run && run.status === 'applying') {
            res.writeHead(409, CORS); res.end(JSON.stringify({ error: 'an application run is already active',
              runId: run.runId, currentIndex: run.currentIndex, confirmed: run.confirmedCount || 0,
              remaining: run.remaining != null ? run.remaining : run.targetConfirmed })); return;
          }
        }
        const todayAudit = applicationAuditFromStorage(control, { day, timeZone, target: dailyTarget || 1 }).audit;
        const alreadyConfirmedToday = todayAudit.counts.confirmed;
        const remainingTarget = applyAllAboveScore ? null : todayAudit.remaining;
        if (!applyAllAboveScore && remainingTarget <= 0) {
          res.writeHead(200, CORS); res.end(JSON.stringify({ success: true, dryRun, planned: 0,
            note: 'daily confirmed target already reached', day, timeZone, dailyTarget,
            alreadyConfirmedToday, remainingTarget: 0 })); return;
        }

        // 1. Pull every application-ready candidate before LLM ranking. A heuristic top-N bound
        // cannot guarantee the true best match, so the autonomous path never pre-truncates it.
        const setResp = await wsAsk('getApplySet', { threshold: rescore ? 0 : threshold,
          dailyCap: rescore ? 0 : dailyCap, perCompanyCap: rescore ? 0 : perCompanyCap,
          includeUnscored: !!rescore,
          atsAllow, requireEvidence: !rescore && requireEvidence, maxGaps,
          retryDeferred: e2eSafe ? false : undefined,
          maxAttempts: e2eSafe ? 1 : undefined,
          candidateFingerprint: !rescore ? runtimeCandidateFingerprint : undefined,
          explainDrops: true, dropLimit: o.dropLimit != null ? o.dropLimit : 200 }, 'applySetReply', 20000);
        let jobs = (setResp && setResp.jobs) || [];
        let planningDrops = setResp.planningDrops ? JSON.parse(JSON.stringify(setResp.planningDrops)) : null;
        const planningDropLimit = o.dropLimit != null ? Math.max(0, Number(o.dropLimit) || 0) : 200;
        if (setResp.error) { res.writeHead(502, CORS); res.end(JSON.stringify({ error: 'getApplySet: ' + setResp.error })); return; }
        if (candidateAllow.size || candidateIds.size) {
          jobs = jobs.filter(j => {
            const ok = allowed(j);
            if (!ok) planningDrops = appendPlanningDrop(planningDrops, j, 'candidate_allow_filter', planningDropLimit);
            return ok;
          });
        }
        if (companyDeny.size || titleDeny.length) jobs = jobs.filter(j => {
          const no = denied(j);
          if (no) planningDrops = appendPlanningDrop(planningDrops, j, 'caller_deny_filter', planningDropLimit);
          return !no;
        });
        // LinkedIn Easy Apply is intentionally assisted because its modal-open action is rejected by
        // automation in the current UI. Exclude it from unattended runs instead of silently waiting
        // five minutes per role; callers can opt in with includeAssisted:true.
        let assistedExcluded = 0;
        if (!includeAssisted) {
          const before = jobs.length;
          jobs = jobs.filter(j => {
            const assisted = j.channel === 'linkedin_easy_apply';
            if (assisted) planningDrops = appendPlanningDrop(planningDrops, j, 'assisted_channel_excluded', planningDropLimit);
            return !assisted;
          });
          assistedExcluded = before - jobs.length;
        }
        const channelCoverage = {};
        for (const channel of requiredChannels) {
          const candidates = jobs.filter(j => (j.channel || 'external') === channel);
          channelCoverage[channel] = { discovered: candidates.length, hydrated: 0, qualified: 0 };
        }
        const strategyKey = j => String(j && (j.strategy || j.ats) || 'generic').trim().toLowerCase() || 'generic';
        const strategyCoverage = {};
        for (const strategy of requiredStrategies) {
          const candidates = jobs.filter(j => strategyKey(j) === strategy);
          strategyCoverage[strategy] = { discovered: candidates.length, hydrated: 0, qualified: 0 };
        }

        // 2. Score every candidate whose evidence is not already valid for this exact JD. Reuse
        // prior LLM evidence only when the description fingerprint still matches.
        if (rescore && jobs.length) {
          const { descriptionFingerprint } = require('./sourcing/jobstore');
          for (const channel of requiredChannels) channelCoverage[channel].hydrated = jobs.filter(j =>
            (j.channel || 'external') === channel && j.description &&
            !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
          for (const strategy of requiredStrategies) strategyCoverage[strategy].hydrated = jobs.filter(j =>
            strategyKey(j) === strategy && j.description &&
            !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
          jobs = jobs.filter(j => {
            const hydrated = j.description && !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''));
            if (!hydrated) planningDrops = appendPlanningDrop(planningDrops, j, 'rescore_missing_description', planningDropLimit);
            return hydrated;
          });
          const reusable = [], needsScore = [];
          for (const j of jobs) {
            const fp = descriptionFingerprint(j.description);
            if (j.scoreKind === 'llm' && j.fitScore != null && j.descriptionFingerprint === fp &&
                j.candidateFingerprint === runtimeCandidateFingerprint) reusable.push(j);
            else needsScore.push(j);
          }
          const scored = needsScore.length ? await scoreAll(needsScore) : [];
          if (scored.length) await wsAsk('updateScores', { scores: scored.map(j => ({ id: j.id, fitScore: j.fitScore,
            descriptionFingerprint: descriptionFingerprint(j.description),
            candidateFingerprint: runtimeCandidateFingerprint,
            evidenceFingerprint: `${descriptionFingerprint(j.description)}:${runtimeCandidateFingerprint}`,
            matchEvidence: j.matchEvidence,
            gaps: j.gaps, conflicts: j.conflicts, confidence: j.confidence })) }, 'updateScoresReply', 120000);
          const ranked = reusable.concat(scored)
            .filter(j => {
              let reason = '';
              if (j.fitScore == null) reason = 'rescore_missing_fit_score';
              else if (j.fitScore < threshold) reason = 'rescore_below_threshold';
              else if (requireEvidence && (j.matchEvidence || []).length < 3) reason = 'rescore_weak_match_evidence';
              else if (requireEvidence && (j.gaps || []).length > maxGaps) reason = 'rescore_too_many_match_gaps';
              else if (requireEvidence && (j.conflicts || []).length) reason = 'rescore_hard_match_conflict';
              else if (requireEvidence && !['high', 'medium'].includes(String(j.confidence || '').toLowerCase())) reason = 'rescore_low_score_confidence';
              if (reason) planningDrops = appendPlanningDrop(planningDrops, j, reason, planningDropLimit);
              return !reason;
            })
            .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
          const perCo = {}, selected = [];
          const pushSelected = j => {
            if (!j || selected.some(x => x.id === j.id)) return false;
            const co = String(j.company || '').trim().toLowerCase();
            if (perCompanyCap > 0 && (perCo[co] || 0) >= perCompanyCap) return false;
            perCo[co] = (perCo[co] || 0) + 1;
            selected.push(j);
            return true;
          };
          // Required-channel E2E coverage is a hard contract: reserve the best available job from
          // each requested channel before filling the remaining queue by global rank.
          for (const channel of requiredChannels) {
            pushSelected(ranked.find(j => (j.channel || 'external') === channel));
          }
          for (const strategy of requiredStrategies) {
            pushSelected(ranked.find(j => strategyKey(j) === strategy));
          }
          for (const j of ranked) {
            if (attemptCap > 0 && selected.length >= attemptCap) break;
            pushSelected(j);
          }
          const selectedIds = new Set(selected.map(j => j.id));
          for (const j of ranked) {
            if (!selectedIds.has(j.id)) planningDrops = appendPlanningDrop(planningDrops, j,
              attemptCap > 0 && selected.length >= attemptCap ? 'run_attempt_cap' : 'per_company_cap', planningDropLimit);
          }
          jobs = selected;
          if (companyDeny.size || titleDeny.length) jobs = jobs.filter(j => {
            const no = denied(j);
            if (no) planningDrops = appendPlanningDrop(planningDrops, j, 'caller_deny_filter_after_rescore', planningDropLimit);
            return !no;
          });
          for (const channel of requiredChannels) channelCoverage[channel].qualified = jobs.filter(j =>
            (j.channel || 'external') === channel).length;
          for (const strategy of requiredStrategies) strategyCoverage[strategy].qualified = jobs.filter(j =>
            strategyKey(j) === strategy).length;
        } else {
          for (const channel of requiredChannels) {
            channelCoverage[channel].hydrated = jobs.filter(j => (j.channel || 'external') === channel &&
              j.description && !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
            channelCoverage[channel].qualified = jobs.filter(j => (j.channel || 'external') === channel).length;
          }
          for (const strategy of requiredStrategies) {
            strategyCoverage[strategy].hydrated = jobs.filter(j => strategyKey(j) === strategy &&
              j.description && !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
            strategyCoverage[strategy].qualified = jobs.filter(j => strategyKey(j) === strategy).length;
          }
        }

        const uncoveredChannels = requiredChannels.filter(channel => !channelCoverage[channel].qualified);
        if (uncoveredChannels.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: 'channel_coverage_blocked' });
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'channel_coverage',
            error: 'required channel coverage is not ready', uncoveredChannels, channelCoverage,
            planningDrops: planningDrops || null, report,
            next: 'hydrate missing browser leads, then rescore before starting an apply run' })); return;
        }
        const uncoveredStrategies = requiredStrategies.filter(strategy => !strategyCoverage[strategy].qualified);
        if (uncoveredStrategies.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: 'strategy_coverage_blocked' });
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'strategy_coverage',
            error: 'required apply strategy coverage is not ready', uncoveredStrategies, strategyCoverage,
            planningDrops: planningDrops || null, report,
            next: 'source/hydrate at least one qualified real posting per required ATS strategy, then rescore before starting an apply run' })); return;
        }

        if (!jobs.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: dryRun ? 'dry_run_nothing_eligible' : 'nothing_eligible' });
          res.writeHead(200, CORS); res.end(JSON.stringify({ success: true, planned: 0,
          note: 'nothing eligible', corpusTotal: setResp.total, assistedExcluded, day, timeZone,
          dailyTarget, alreadyConfirmedToday, remainingTarget, planningDrops: planningDrops || null,
          report })); return;
        }

        // 3. build the queue + seed current, then open the first job's tab to start the loop.
        // Keep the active ranked-run object compact. Chrome storage can reject large single-item
        // writes; scoring evidence remains persisted in the corpus via updateScores above and does
        // not need to be duplicated into pja_ranked_apply/pja_ext_current.
        const queueJobs = jobs.map(j => ({ id: j.id, jobId: j.sourceJobId || j.jobId || '',
          sourceJobId: j.sourceJobId || j.jobId || '', title: j.title, company: j.company,
          ats: j.ats || j.strategy, strategy: j.strategy || '', channel: j.channel || 'external',
          applyUrl: j.applyUrl, listingUrl: j.listingUrl || '', location: j.location, fitScore: j.fitScore,
          confidence: j.confidence || '', profile: {}, answers: {} }));
        const runId = 'apply-' + Date.now();
        const plannedAt = Date.now();
        for (const j of queueJobs) { j.runId = runId; j.applicationAt = plannedAt; }
        const byStrategy = {};
        for (const j of queueJobs) { const k = j.ats || 'generic'; byStrategy[k] = (byStrategy[k] || 0) + 1; }
        const easyApplyJobs = queueJobs.filter(j => j.channel === 'linkedin_easy_apply');
        const indeedApplyJobs = queueJobs.filter(j => j.channel === 'indeed_apply');
        const externalJobs = queueJobs.filter(j => j.channel !== 'linkedin_easy_apply' && j.channel !== 'indeed_apply');
        const byChannel = { external: externalJobs.length, linkedin_easy_apply: easyApplyJobs.length,
          indeed_apply: indeedApplyJobs.length };

        if (!dryRun) {
          const master = { status: 'applying', jobs: queueJobs, currentIndex: 0, inFlightIndex: null,
            results: { confirmed: [], failed: [], unverified: [], skipped: [] }, blockedChannels: [],
            runId, runMode, applyAllAboveScore, targetConfirmed: dailyTarget, dailyTarget, attemptCap, threshold,
            day, timeZone,
            confirmedCount: alreadyConfirmedToday, remaining: remainingTarget,
            stopBeforeSubmit, e2eSafe, planningDrops: planningDrops || null,
            startedAt: plannedAt, updatedAt: plannedAt };
          const started = await wsAsk('startRankedApply', { master, force: !!o.force },
            'startRankedApplyReply', 30000);
          if (!started || started.ok !== true) {
            res.writeHead(started && started.conflict ? 409 : 502, CORS);
            res.end(JSON.stringify({ success: false, error: started && (started.error ||
              (started.conflict ? 'an application run became active while planning' : 'ranked start was not acknowledged')) || 'ranked start was not acknowledged',
              activeRunId: started && started.runId })); return;
          }
          const verifyStart = await getStorageFromExtension(['pja_ranked_apply'], 10000);
          const activeRun = verifyStart && verifyStart.pja_ranked_apply;
          if (!activeRun || activeRun.runId !== runId) {
            res.writeHead(502, CORS);
            res.end(JSON.stringify({ success: false, error: 'ranked start was acknowledged but active run was not persisted',
              runId, started })); return;
          }
        }
        console.log(`[PJA] /apply-run${dryRun ? ' (dry-run)' : ''}: ${dryRun ? 'planned' : 'queued'} ${queueJobs.length} (threshold=${threshold}, rescore=${rescore}) byChannel=${JSON.stringify(byChannel)} byStrategy=${JSON.stringify(byStrategy)}`);
        res.writeHead(200, CORS);
        const previewLimit = Math.max(1, Math.min(500, Number(o.previewLimit) || 12));
        const report = dryRun ? writeApplyPlanningReport(planningDrops || null,
          { status: 'dry_run_planned', jobs: queueJobs }) : null;
        res.end(JSON.stringify({ success: true, dryRun, planned: queueJobs.length,
          runMode, applyAllAboveScore, targetConfirmed: remainingTarget, dailyTarget,
          alreadyConfirmedToday, remainingTarget,
          day, timeZone, assistedExcluded, includeAssisted, e2eSafe,
          reserveCount: applyAllAboveScore ? 0 : Math.max(0, queueJobs.length - remainingTarget), runId, byChannel,
          byStrategy, channelCoverage, strategyCoverage, corpusTotal: setResp.total,
          planningDrops: planningDrops || null, report,
          top: jobs.slice(0, previewLimit).map(j => ({ fit: j.fitScore, company: j.company, title: j.title,
            ats: j.ats || j.strategy, channel: j.channel || 'external', matchEvidence: j.matchEvidence || [],
            gaps: j.gaps || [], conflicts: j.conflicts || [], confidence: j.confidence || '' })) }));
      } catch (e) {
        console.error('[PJA] /apply-run error:', e.message);
        res.writeHead(500, CORS); res.end(JSON.stringify({ success: false, error: e.message }));
      } finally { if (ownsPlanningLock) applyRunPlanning = false; }
    });
    return;
  }

  // ── /applied-audit: exact run/day count from the serialized confirmation ledger. Legacy log
  // rows are folded in conservatively; only rows carrying explicit page/email evidence count.
  if (req.method === 'POST' && req.url === '/applied-audit') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const st = await getStorageFromExtension(['pja_application_ledger', 'pja_applied_log']);
        const Ledger = require('./application-ledger');
        let ledger = applicationAuditFromStorage(st, { day: null }).ledger;
        const auditOpts = { target: o.target != null ? Number(o.target) : 50,
          timeZone: o.timeZone || 'America/Los_Angeles' };
        if (Object.prototype.hasOwnProperty.call(o, 'runId')) auditOpts.runId = o.runId;
        if (Object.prototype.hasOwnProperty.call(o, 'day')) auditOpts.day = o.day;
        if (o.now != null) auditOpts.now = o.now;
        let reconciliation = null;
        if (Array.isArray(o.emails) && o.emails.length) {
          reconciliation = Ledger.reconcileEmails(ledger, o.emails, auditOpts);
          ledger = reconciliation.ledger;
        }
        const audit = Ledger.auditLedger(ledger, auditOpts);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, ...audit,
          emailMatches: reconciliation ? reconciliation.matches : [] }));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /reconcile: ground-truth applied jobs against Gmail confirmation emails (Phase C). Reads
  // pja_applied_log from the extension and reconciles it against confirmation emails (supplied in the
  // body, or fetched via the extension's Gmail capability) using the tested confirmation-tracker.
  if (req.method === 'POST' && req.url === '/reconcile') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const st = await getStorageFromExtension(['pja_applied_log']);
        const { reconcile } = require('./confirmation-tracker');
        const r = reconcile(st.pja_applied_log || [], o.emails || [], { windowDays: o.windowDays != null ? o.windowDays : 7 });
        console.log(`[PJA] /reconcile: applied=${r.stats.applied} confirmed=${r.stats.confirmed} unverifiable=${r.stats.unverifiable}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify(Object.assign({ success: true }, r)));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /corpus-status: read the extension's live IndexedDB corpus gate report via WS ──
  if (req.method === 'POST' && req.url === '/corpus-status') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const reqId = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        let responded = false;
        const client = [...wsClients].find(c => c.readyState === 1);
        if (!client) { res.writeHead(503, CORS); res.end(JSON.stringify({ error: 'no extension connected' })); return; }
        const onMsg = raw => {
          try {
            const msg = JSON.parse(raw);
            if (msg.cmd === 'corpusReply' && msg.reqId === reqId && !responded) {
              responded = true; client.removeListener('message', onMsg);
              res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, corpus: msg.data }));
            }
          } catch (_) {}
        };
        client.on('message', onMsg);
        client.send(JSON.stringify({ cmd: 'getCorpus', target: o.target || 200, reqId }));
        setTimeout(() => { if (!responded) { responded = true; client.removeListener('message', onMsg); res.writeHead(504, CORS); res.end(JSON.stringify({ error: 'timeout' })); } }, 5000);
      } catch (e) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Read one corpus record by canonical id for targeted eligibility diagnostics.
  if (req.method === 'POST' && req.url === '/corpus-job') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        if (!o.id) {
          res.writeHead(400, CORS); res.end(JSON.stringify({ ok: false, error: 'id is required' })); return;
        }
        const data = await wsAsk('getCorpusJob', { id: String(o.id) }, 'corpusJobReply', 10000);
        res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Search description-free job metadata in the live IndexedDB corpus.
  if (req.method === 'POST' && req.url === '/corpus-search') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const data = await wsAsk('searchCorpus', {
          terms: Array.isArray(o.terms) ? o.terms : [], statuses: Array.isArray(o.statuses) ? o.statuses : ['sourced'],
          minFit: o.minFit, limit: o.limit
        }, 'corpusSearchReply', 15000);
        res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, ...data }));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Reset only named, non-terminal corpus records after a verified automation bug has been fixed.
  // Normal retry caps remain intact for every other posting.
  if (req.method === 'POST' && req.url === '/reset-corpus-jobs') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const ids = (Array.isArray(o.ids) ? o.ids : []).map(String).filter(Boolean).slice(0, 20);
        if (!ids.length) {
          res.writeHead(400, CORS); res.end(JSON.stringify({ ok: false, error: 'ids are required' })); return;
        }
        const data = await wsAsk('resetCorpusJobs', { ids }, 'resetCorpusJobsReply', 15000);
        res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true, ...data }));
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /outreach: generate DM + email for an approved job ────────────────────
  if (req.method === 'POST' && req.url === '/outreach') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { title, company, description, matchedSkills } = JSON.parse(body);
        process.stdout.write(`[PJA] Outreach for ${title} @ ${company}… `);
        const t0 = Date.now();

        const prompt =
`Generate outreach messages for the candidate applying to: ${title} at ${company}.
Matched skills: ${(matchedSkills || []).join(', ')}.
Job snippet: ${(description || '').slice(0, 400)}

Return ONLY valid JSON, no markdown:
{"dmMessage":"<LinkedIn DM under 280 chars, grounded only in supplied profile/job facts>","emailMessage":"<cold email, Subject: line first, under 500 chars, grounded only in supplied profile/job facts>","recruiterSearchUrl":"recruiter ${encodeURIComponent(company)}","hmSearchUrl":"hiring manager engineer ${encodeURIComponent(company)}"}`;

        const raw = await runClaude(prompt);
        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON in response');
        const data = JSON.parse(raw.slice(start, end + 1));

        console.log(`done (${Date.now() - t0}ms)`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, ...data }));
      } catch (e) {
        console.error(`\n[PJA] Outreach error: ${e.message}`);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /apply-help: analyze a blocked apply attempt and suggest a recovery path ─────────────
  if (req.method === 'POST' && req.url === '/apply-help') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const snapshot = JSON.parse(body || '{}');
        const compact = summarizeFailureSnapshot(snapshot);
        const screenshotNote = snapshot.screenshot && snapshot.screenshot.dataUrl
          ? `\nA screenshot was captured and attached as a ${snapshot.screenshot.mime || 'image/jpeg'} data URL (${String(snapshot.screenshot.dataUrl).length} chars${snapshot.screenshot.truncated ? ', truncated' : ''}). If your CLI/runtime can inspect images, use it. If not, rely on the DOM summary and logs.\n`
          : '\nNo screenshot was available; rely on DOM summary and logs.\n';
        const prompt =
`A job application automation attempt got stuck. Diagnose the current page status and propose bounded recovery actions.

Return ONLY valid JSON:
{"classification":"applied|captcha|missing_required|email_verification_required|login_required|no_apply_path|submit_unclear|manual_required|stuck_wait","confidence":"low|medium|high","likelyCause":"...","evidence":["..."],"blockedFields":["..."],"recommendedActions":[{"type":"retry_fill_phone|retry_fill_country|retry_fill_phone_country_code|retry_greenhouse_react_selects|retry_smartrecruiters_custom_fields|retry_answer_required|retry_workday_prompt_buttons|retry_workday_app_questions|retry_workday_terms_checkbox|retry_workday_sid_transaction|retry_workday_advance|retry_workday_auth_reset|capture_only|wait_for_hydration|retry_submit_once|check_gmail_confirmation|record_captcha_and_advance|record_needs_manual","fieldHint":"...","valueKey":"profile.phone|profile.country|profile.phoneCountryCode|answers","reason":"..."}],"shouldRetry":true|false,"shouldRetrySubmit":true|false,"shouldAdvance":true|false,"needsCodeChange":true|false,"nextSelectors":["..."],"notes":["..."]}

Snapshot:
${JSON.stringify(compact, null, 2)}
${screenshotNote}

Rules:
- Be concrete about the most likely blocker.
- If the blocker is captcha, auth, missing required data, or a closed/stale posting, do not recommend blind retry.
- If the blocker looks like a selector or DOM handling problem, propose one or more whitelisted recovery actions and suggest the next selector change.
- For Workday pages, prefer Workday-specific actions when applicable: prompt buttons, app questions, terms checkbox, SID transaction, step advance, or auth reset.
- If current evidence is inconclusive but another screenshot/DOM round would help, recommend capture_only with shouldRetry=true.
- Do not propose arbitrary code, arbitrary clicks, CAPTCHA bypass, or fabricated profile answers.
- Mark applied only with strong visual/URL/DOM confirmation evidence; otherwise use submit_unclear or check_gmail_confirmation.`;
        const raw = await runClaudeWithSystemPrompt(`${runtimeCandidatePrompt}\n\nYou are helping debug a live job application automation system.`, prompt, 120000);
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON in response');
        const data = JSON.parse(raw.slice(start, end + 1));
        const allowed = new Set([
          'retry_fill_phone','retry_fill_country','retry_fill_phone_country_code',
          'retry_greenhouse_react_selects','retry_smartrecruiters_custom_fields','retry_answer_required',
          'retry_workday_prompt_buttons','retry_workday_app_questions','retry_workday_terms_checkbox',
          'retry_workday_sid_transaction','retry_workday_advance','retry_workday_auth_reset',
          'capture_only','wait_for_hydration','retry_submit_once','check_gmail_confirmation',
          'record_captcha_and_advance','record_needs_manual'
        ]);
        data.recommendedActions = Array.isArray(data.recommendedActions)
          ? data.recommendedActions.filter(a => a && allowed.has(String(a.type))).slice(0, 5)
          : [];
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, ...data, snapshot: compact }));
      } catch (e) {
        console.error(`\n[PJA] apply-help error: ${e.message}`);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── /answer-questions: generate AI answers for open-ended form questions ──
  if (req.method === 'POST' && req.url === '/answer-questions') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { questions, jobContext, profile, prefs } = JSON.parse(body);
        // questions: [{label, type, maxLength, options}]
        // jobContext: {title, company}
        // profile: stored pja_profile object (may be absent — use hardcoded fallback)
        // prefs: high-level preference profile (pja_prefs) — comp/workMode/startDate/screening + factual answers
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new Error('questions array required');
        }
        const title   = jobContext?.title   || 'Unknown Role';
        const company = jobContext?.company || 'Unknown Company';

        process.stdout.write(`[PJA] Answering ${questions.length} question(s) for ${title} @ ${company}… `);
        const t0 = Date.now();

        // Build dynamic profile fields from local extension storage. Missing facts stay unknown;
        // do not inherit another user's work-authorization or background assumptions.
        const p = profile || {};
        const pf = prefs || {};
        const fa = (prefs && prefs.factual) || {};
        const fullName      = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'the candidate';
        const currentRole   = [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ') || 'not provided';
        const prevRole      = p.prevTitle && p.prevCompany
          ? `${p.prevTitle} at ${p.prevCompany}`
          : 'not provided';
        const yearsExp      = p.yearsExperience || 'not provided';
        const locationLine  = [p.city, p.state, p.country].filter(Boolean).join(', ') || 'not provided';
        const visaLine      = p.visaStatus || p.visa || p.workAuth || 'not provided';
        const skillsLine    = p.skills || p.summary || 'not provided';

        const ANSWER_SYSTEM_PROMPT =
`You are filling out a job application for ${fullName}.

PROFILE:
- Current: ${currentRole}
- Previous: ${prevRole}
- Total work experience: ${yearsExp}
- Skills: ${skillsLine}
- Known gaps: ${fa.honestGaps || 'not provided'}
- Visa: ${visaLine}
- Location: ${locationLine}

PREFERENCES (use these for preference/logistics questions):
- Compensation: ${pf.compensation || "answer 'competitive'/'negotiable'; do not give a low rate"}
- Work mode: ${pf.workMode || 'open to onsite or hybrid'}
- Relocation: ${pf.relocation || 'open to relocating'}
- Availability/start: ${pf.startDate || 'available with standard notice'}
- Consent stance: ${pf.screeningStance || 'consent to standard background/drug/data checks'}

FACTUAL ANSWERS (use these EXACTLY for the matching question — do not contradict them):
- Authorized to work in the US: ${fa.authorizedToWorkUS || p.workAuth || 'not provided'}
- Requires visa sponsorship (H-1B/etc.): ${fa.requiresSponsorship || p.requireSponsorship || 'not provided'}
- Visa status: ${fa.visaStatus || p.visaStatus || 'not provided'}
- Is a US citizen or permanent resident: ${fa.usCitizenOrPermanentResident || 'not provided'}
- Is a "US person" for export-control/ITAR/EAR: ${fa.usPersonForExportControl || 'not provided'}
- 18 or older: ${fa.over18 || 'Yes'}
- Has security clearance: ${fa.securityClearance || 'No'}
- Veteran status: ${fa.veteranStatus || 'Not a protected veteran'}
- Disability: ${fa.disability || 'No'}
- Gender: ${fa.gender || p.gender || 'not provided'}
- Race/ethnicity: ${fa.ethnicity || 'Decline to self-identify'}
- Years of experience: ${fa.yearsExperience || yearsExp}
- HONEST GAPS: ${fa.honestGaps || 'Do not claim any skill, credential, citizenship, clearance, or work-authorization fact that is not supplied by the profile/resume.'}

ANSWERING RULES:
1. First person ("I have…"). Be truthful — never claim a skill/credential ${fullName} lacks (see HONEST GAPS).
2. "Years of experience" → numeric only (e.g. "6") for short fields; one sentence for text fields.
3. Yes/No questions → exactly "Yes" or "No" (add one brief reason only in a textarea).
4. Work-authorization / sponsorship / citizenship / US-person / export-control / clearance / age / veteran / disability / gender / ethnicity → use the FACTUAL ANSWERS above verbatim in meaning.
5. Consent/agreement/certification questions (background check, drug test, data/GDPR, "I certify/agree/acknowledge") → answer affirmatively per the consent stance ("Yes"/"I agree"/"I certify").
6. Salary/compensation → follow the Compensation preference (range/"competitive"/"negotiable"); never output a low hourly rate.
7. Open-ended prompts — "describe your experience"/knowledge, "most impressive accomplishment", "your impact", "top priorities in the first month", "why this role/mission", "which statement describes you" → 2–4 sentences grounded in the supplied profile/resume. First-person, concrete, honest. Do NOT invent.
8. When options are provided, the answer MUST be copied exactly from one of the options.
9. Keep proportional to maxLength. No filler. Output ONLY the JSON array — one object per question, in order. NEVER ask for clarification or write prose: if a question is unclear/malformed, still include it with your best reasonable answer and confidence "low".
10. Confidence: ALWAYS "high" for consent/agreement/certification/acknowledgment questions, and for anything covered by the FACTUAL ANSWERS or PREFERENCES above (work-auth, sponsorship, citizenship, US-person/export-control, clearance, age, veteran, disability, gender, ethnicity, years, salary, relocation, availability) — these are policy/fact, NOT guesses, even when the question text is long legalese. Use "low" ONLY for open-ended experiential/knowledge questions you are genuinely unsure about.`;

        const questionList = questions.map((q, i) => {
          const parts = [`Q${i + 1}: "${q.label}"`];
          if ((q.type === 'select' || q.type === 'radio') && q.options?.length) {
            parts.push(`  Type: ${q.type === 'radio' ? 'radio choice' : 'dropdown'}; options: ${q.options.slice(0, 12).join(' | ')}`);
            parts.push(`  IMPORTANT: your answer must be copied exactly from one of the options above`);
          } else if (q.type === 'textarea') {
            parts.push(`  Type: long text${q.maxLength ? `; maxLength: ${q.maxLength} chars` : ''}`);
          } else {
            parts.push(`  Type: short text${q.maxLength ? `; maxLength: ${q.maxLength} chars` : ''}`);
          }
          return parts.join('\n');
        }).join('\n\n');

        const userPrompt =
`Job: ${title} at ${company}

Answer each question below for the candidate's application. Return a JSON array with one object per question:
[{"label":"<exact question label>","answer":"<your answer>","confidence":"high|low"},...]

Questions:
${questionList}`;

        const raw = await runClaudeWithSystemPrompt(ANSWER_SYSTEM_PROMPT, userPrompt, 180000);
        const start = raw.indexOf('[');
        const end   = raw.lastIndexOf(']');
        let answers = [];
        if (start !== -1 && end !== -1) {
          try { answers = JSON.parse(raw.slice(start, end + 1)); } catch (_) { answers = []; }
        }
        // Resilient: if the model returned prose instead of JSON, respond success with no
        // answers (the caller leaves those fields unfilled) rather than erroring — a 500 makes
        // background.js fall back to the (often unconfigured) direct API path.
        if (!Array.isArray(answers)) answers = [];
        if (!answers.length) console.log(`(no parseable answers; raw="${raw.slice(0, 80).replace(/\n/g, ' ')}")`);

        console.log(`done (${Date.now() - t0}ms) answered=${answers.length}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, answers }));
      } catch (e) {
        console.error(`\n[PJA] answer-questions error: ${e.message}`);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── HTTP + WebSocket server (shared port) ──────────────────────────────────
const server = http.createServer(handleRequest);

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  wsClients.add(ws);
  console.log(`[PJA] Extension connected (${wsClients.size} client(s))`);
  // Keep the MV3 service worker alive: respond to pings from the extension
  ws.on('message', msg => {
    if (msg.toString() === 'ping') ws.send('pong');
  });
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[PJA] Extension disconnected (${wsClients.size} client(s))`);
  });
  ws.on('error', () => wsClients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🔬 PJA dev server  →  http://localhost:${PORT}`);
  console.log(`   Engine            : ${AI_ENGINE} CLI`);
  console.log(`   Hot-reload        : curl -X POST http://localhost:${PORT}/reload`);
  console.log(`   Stop              : Ctrl+C\n`);
});
