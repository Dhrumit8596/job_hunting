#!/usr/bin/env node
'use strict';

/**
 * PJA Dev Server — routes extension analysis through a local Claude or Codex CLI.
 *
 * Usage:
 *   node dev-server.js
 *
 * Engine default: `node dev-server.js --engine codex` or PJA_AI_ENGINE=codex.
 * Connected extension storage may override this via pja_profile.aiEngine / pja_prefs.aiEngine.
 *
 * Hot-reload:
 *   curl -X POST http://localhost:6174/reload
 *   (background.js connects via WebSocket and calls chrome.runtime.reload())
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { exec, spawnSync } = require('child_process');
const { buildRestartPlan } = require('./chrome-restart');
const { normalizeEnginePreference, parseEngine, codexModel, codexReasoningEffort, runAiCli } = require('./ai-cli');
const { scoringExcerpt } = require('./scoring-context');
const ApplyProgress = require('./apply-progress');
const ApplyRunControl = require('./apply-run-control');
const ApplyReportHealth = require('./apply-report-health');
const LocalJsonClient = require('./local-json-client');
const ScoringFrontier = require('./scoring-frontier');
const { decideRecovery } = require('./apply-recovery-policy');

const PORT = Number(process.env.PJA_DEV_PORT || 6174);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PJA_DEV_PORT must be a valid TCP port');
const PROCESS_AI_ENGINE = parseEngine();
let effectiveAiEngineCache = { engine: PROCESS_AI_ENGINE, source: 'process_default', checkedAt: 0 };

// Connected extension background workers (WebSocket clients)
const wsClients = new Set();
let _lastQueueStatus = null;
// Process-local planning mutex. The extension service worker independently enforces the final
// active-run lock, but this closes the minutes-long scoreAll race between concurrent HTTP calls.
let applyRunPlanning = false;
// Admission is much shorter than planning: it only serializes preflight + durable control write so
// two simultaneous one-click requests cannot both pass before either run identity is visible.
let applyRunAdmission = false;

const DEFAULT_COVERAGE_CHANNELS = ['linkedin_easy_apply', 'indeed_apply'];
const DEFAULT_COVERAGE_STRATEGIES = ['greenhouse', 'workday', 'ashby', 'lever', 'smartrecruiters'];
const REPORT_ONLY_COVERAGE_STRATEGIES = ['eightfold', 'successfactors', 'jobicy', 'remotive'];
// Adjacent titles already supported by the configured candidate's evidence-backed sourcing policy.
// These supplement (never replace) saved titles; qualification still requires resume/JD evidence.
const SUPPORTED_ADJACENT_SEARCH_TITLES = [
  'manufacturing engineer', 'reliability engineer', 'product development engineer',
];

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
const OPERATIONAL_PROFILE_KEYS = new Set([
  'aiEngine', 'ai_engine', 'preferredAiEngine',
  'savedAt', 'updatedAt', 'lastUpdated',
]);

function extractResumeTextFromDataUrl(dataUrl, filename = '') {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i);
  if (!match) return '';
  const mime = String(match[1] || '').toLowerCase();
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!/pdf/.test(mime) && ext !== '.pdf') return '';
  let buf;
  try { buf = Buffer.from(match[2], 'base64'); } catch (_) { return ''; }
  if (!buf.length || buf.length > 12 * 1024 * 1024) return '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pja-resume-'));
  const pdfPath = path.join(dir, 'resume.pdf');
  try {
    fs.writeFileSync(pdfPath, buf);
    const py = [
      'import sys, re',
      'from pypdf import PdfReader',
      'path=sys.argv[1]',
      'parts=[]',
      'reader=PdfReader(path)',
      'for page in reader.pages[:6]:',
      '    try:',
      '        parts.append(page.extract_text() or "")',
      '    except Exception:',
      '        pass',
      'text=re.sub(r"\\s+", " ", "\\n".join(parts)).strip()',
      'sys.stdout.write(text[:20000])',
    ].join('\n');
    const out = spawnSync('python3', ['-c', py, pdfPath], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    return out.status === 0 ? String(out.stdout || '').trim() : '';
  } catch (_) {
    return '';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Build a private, per-user scoring profile from extension storage. This keeps new users from
// needing a gitignored candidate.local.txt while ensuring an empty/new profile still fails closed.
async function refreshRuntimeCandidateProfile() {
  let st = {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    st = await getStorageFromExtension(['pja_profile', 'pja_profile_backup', 'pja_resume_filename', 'pja_resume_b64'], attempt === 0 ? 5000 : 10000);
    if (st && (Object.prototype.hasOwnProperty.call(st, 'pja_profile') ||
        Object.prototype.hasOwnProperty.call(st, 'pja_resume_filename'))) break;
    if (wsClients.size && attempt < 2) await new Promise(r => setTimeout(r, 500));
  }
  // A reconnecting MV3 worker can briefly time out storage reads even though the profile and
  // resume remain intact. Do not downgrade a previously verified in-process candidate profile on
  // an empty transport response; callers retry/preflight again once the extension is stable.
  const storageReadObserved = st && (Object.prototype.hasOwnProperty.call(st, 'pja_profile') ||
    Object.prototype.hasOwnProperty.call(st, 'pja_profile_backup') ||
    Object.prototype.hasOwnProperty.call(st, 'pja_resume_filename') ||
    Object.prototype.hasOwnProperty.call(st, 'pja_resume_b64'));
  if (!storageReadObserved && runtimeHasCandidateProfile) {
    return { configured: true, resume: true, fields: null, transientStorageRead: true };
  }
  const profile = st && st.pja_profile && typeof st.pja_profile === 'object' ? st.pja_profile : {};
  const backup = st && st.pja_profile_backup && typeof st.pja_profile_backup === 'object' ? st.pja_profile_backup : {};
  const resume = String(st && st.pja_resume_filename || '').trim();
  const factAllowed = ([k, v]) => v != null && String(v).trim() &&
    !OPERATIONAL_PROFILE_KEYS.has(k) &&
    !/^(resumeDataUrl|resume|resumeText|pja_resume_b64)$/i.test(k) &&
    !/^data:.*;base64,/i.test(String(v).slice(0, 80));
  const meaningful = Object.entries(profile).filter(factAllowed);
  const backupMeaningful = Object.entries(backup).filter(factAllowed);
  if (meaningful.length < 3 && backupMeaningful.length >= 3 && wsClients.size) {
    setStorageToExtension({ pja_profile: backup, pja_profile_restored_from_backup: {
      ts: Date.now(), reason: 'preflight_empty_profile', restoredFieldCount: backupMeaningful.length,
    } });
    st.pja_profile = backup;
    return refreshRuntimeCandidateProfile();
  }
  if (meaningful.length < 3 || !resume) {
    runtimeCandidatePrompt = SYSTEM_PROMPT;
    runtimeCandidateFingerprint = CANDIDATE_FINGERPRINT;
    runtimeHasCandidateProfile = HAS_CANDIDATE_PROFILE;
    return { configured: runtimeHasCandidateProfile, resume: !!resume, fields: meaningful.length };
  }
  const facts = meaningful.map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`).join('\n');
  const resumeText = extractResumeTextFromDataUrl(st && st.pja_resume_b64, resume);
  runtimeCandidatePrompt = `${GENERIC_SYSTEM_PROMPT}\n\nVERIFIED USER PROFILE (from local extension storage):\n${facts}\nResume uploaded locally: ${resume}.${resumeText ? `\n\nVERIFIED RESUME TEXT (extracted locally; do not quote in reports):\n${resumeText.slice(0, 12000)}` : ''}\nTreat the profile/resume facts as authoritative; do not invent resume facts not represented here.`;
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

function pickConfiguredAiEngine(storage = {}) {
  const profile = storage.pja_profile && typeof storage.pja_profile === 'object' ? storage.pja_profile : {};
  const prefs = storage.pja_prefs && typeof storage.pja_prefs === 'object' ? storage.pja_prefs : {};
  const pairs = [
    ['profile', profile.aiEngine],
    ['profile', profile.ai_engine],
    ['profile', profile.preferredAiEngine],
    ['prefs', prefs.aiEngine],
    ['prefs', prefs.ai_engine],
    ['prefs', prefs.preferredAiEngine],
  ];
  for (const [source, value] of pairs) {
    const engine = normalizeEnginePreference(value);
    if (engine) return { engine, source };
  }
  return { engine: PROCESS_AI_ENGINE, source: 'process_default' };
}

async function resolveEffectiveAiEngine(options = {}) {
  const now = Date.now();
  if (!options.force && now - effectiveAiEngineCache.checkedAt < 10000) return effectiveAiEngineCache;
  let next = { engine: PROCESS_AI_ENGINE, source: 'process_default' };
  try {
    if (wsClients.size) {
      const st = await getStorageFromExtension(['pja_profile', 'pja_prefs'], 2500);
      const observed = st && (Object.prototype.hasOwnProperty.call(st, 'pja_profile') ||
        Object.prototype.hasOwnProperty.call(st, 'pja_prefs'));
      // During extension reload/MV3 reconnect, the WS can be alive while storage temporarily
      // returns an empty/timeout-shaped object. Do not downgrade a profile-selected engine to the
      // process default in that reconnect window; keep the last confirmed engine until storage is
      // readable again.
      if (!observed && effectiveAiEngineCache.source !== 'process_default') {
        effectiveAiEngineCache = { ...effectiveAiEngineCache, checkedAt: now, transientStorageRead: true };
        return effectiveAiEngineCache;
      }
      if (observed) next = pickConfiguredAiEngine(st);
    }
  } catch (_) {}
  effectiveAiEngineCache = { ...next, checkedAt: now };
  return effectiveAiEngineCache;
}

async function runClaudeWithSystemPrompt(systemPrompt, userPrompt, timeoutMs = 90000) {
  const selected = await resolveEffectiveAiEngine();
  return runAiCli({ engine: selected.engine, systemPrompt, userPrompt, timeoutMs });
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
  return LocalJsonClient.postJson({ port: PORT, pathname, body, timeoutMs });
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
const { isEligibleTargetLocation } = require('./sourcing/filter');

function deriveTargetLocationOptions(input = {}, storage = {}) {
  const prefs = storage.pja_prefs && typeof storage.pja_prefs === 'object' ? storage.pja_prefs : {};
  const profile = storage.pja_profile && typeof storage.pja_profile === 'object' ? storage.pja_profile : {};
  const targetLocation = input.targetLocation && typeof input.targetLocation === 'object' ? input.targetLocation : {
    label: prefs.targetLocationLabel || [prefs.targetLocationCity || profile.city, prefs.targetLocationState || profile.state].filter(Boolean).join(', '),
    city: prefs.targetLocationCity || profile.city || '',
    state: prefs.targetLocationState || profile.state || '',
    zip: prefs.targetLocationZip || profile.zip || '',
    country: prefs.targetLocationCountry || profile.country || 'United States',
  };
  const targetRadiusMiles = input.targetRadiusMiles != null ? Number(input.targetRadiusMiles)
    : prefs.targetRadiusMiles != null ? Number(prefs.targetRadiusMiles) : undefined;
  const locationStrictness = input.locationStrictness || prefs.locationStrictness || '';
  const remotePolicy = input.remotePolicy || prefs.remotePolicy || '';
  return { targetLocation, targetRadiusMiles, locationStrictness, remotePolicy, prefs, profile };
}

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

function browserChannelCounts(jobs, options = {}) {
  const { normalizeBrowserJobs } = require('./sourcing/browser-import');
  const now = options.now != null ? Number(options.now) : Date.now();
  const maxAgeMs = options.maxAgeMs != null ? Number(options.maxAgeMs) : null;
  const counts = { linkedin_easy_apply: 0, indeed_apply: 0, external: 0, total: 0 };
  const hydrated = { linkedin_easy_apply: 0, indeed_apply: 0, external: 0, total: 0 };
  for (const job of normalizeBrowserJobs(jobs || [])) {
    if (maxAgeMs != null) {
      const seen = typeof job.discoveredAt === 'number' ? job.discoveredAt : Date.parse(job.discoveredAt || '');
      if (!Number.isFinite(seen) || now - seen > maxAgeMs) continue;
    }
    counts.total += 1;
    const channel = String(job.channel || 'external');
    counts[channel] = (counts[channel] || 0) + 1;
    if (job.description && !/^(missing|stale|needs_description)$/i.test(String(job.descriptionStatus || ''))) {
      hydrated.total += 1;
      hydrated[channel] = (hydrated[channel] || 0) + 1;
    }
  }
  counts.hydrated = hydrated;
  return counts;
}

async function waitForBrowserChannelCoverage(channels, options = {}) {
  const wanted = new Set((channels || []).map(x => String(x || '').trim()).filter(Boolean));
  if (!wanted.size) return { requested: [], skipped: true };
  const startedAt = Date.now();
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 180000);
  const minPerChannel = Math.max(1, Number(options.minPerChannel) || 1);
  const maxAgeMs = options.maxAgeMs != null ? Number(options.maxAgeMs) : 48 * 60 * 60 * 1000;
  let lastJobs = await getBrowserShortlistFromExtension(30000);
  let lastCounts = browserChannelCounts(lastJobs, { maxAgeMs });
  const launches = [];
  const launch = async (source, url, launchOptions = {}) => {
    const resp = await postLocalJson('/start-scan', { source, url, fast: launchOptions.fast !== false }, 15000);
    launches.push({ source, ok: resp.ok && resp.data && resp.data.ok !== false, status: resp.status,
      error: resp.data && resp.data.error || null, url, fast: launchOptions.fast !== false });
  };
  const query = encodeURIComponent(String((options.queries && options.queries[0]) || 'quality engineer'));
  const target = options.targetLocation && typeof options.targetLocation === 'object' ? options.targetLocation : {};
  const locText = [target.city, target.state].filter(Boolean).join(', ') || target.label || target.zip || 'United States';
  const location = encodeURIComponent(locText);
  const radius = Math.max(1, Math.min(500, Number(options.targetRadiusMiles) || 50));
  if (wanted.has('linkedin_easy_apply') && (lastCounts.hydrated?.linkedin_easy_apply || 0) < minPerChannel) {
    await launch('linkedin', `https://www.linkedin.com/jobs/search/?f_AL=true&keywords=${query}&location=${location}&distance=${radius}`, { fast: false });
  }
  if (wanted.has('indeed_apply') && (lastCounts.hydrated?.indeed_apply || 0) < minPerChannel) {
    await launch('indeed', `https://www.indeed.com/jobs?q=${query}&l=${location}&radius=${radius}`);
  }
  let terminal = {};
  while (Date.now() - startedAt < timeoutMs) {
    lastJobs = await getBrowserShortlistFromExtension(30000);
    lastCounts = browserChannelCounts(lastJobs, { maxAgeMs });
    const storage = await getStorageFromExtension(['pja_scan_coverage', 'pja_indeed_scan'], 5000);
    const scanCoverage = Array.isArray(storage.pja_scan_coverage) ? storage.pja_scan_coverage : [];
    const recentLinkedIn = scanCoverage.slice().reverse().find(x => x && x.source === 'linkedin' && Number(x.ts) >= startedAt);
    const indeedScan = storage.pja_indeed_scan || null;
    terminal = {
      linkedin: recentLinkedIn ? { status: 'done', collected: recentLinkedIn.collected || 0,
        easyApply: recentLinkedIn.easyApply || 0, external: recentLinkedIn.external || 0 } : null,
      indeed: indeedScan && Number(indeedScan.ts || 0) >= startedAt ? {
        status: indeedScan.status || '',
        reason: indeedScan.reason || '',
        total: indeedScan.total || 0,
        indeedApply: indeedScan.indeedApply || 0,
      } : null,
    };
    const ready = Array.from(wanted).every(channel => (lastCounts.hydrated?.[channel] || 0) >= minPerChannel);
    const linkedInDone = !wanted.has('linkedin_easy_apply') || ready || terminal.linkedin;
    const indeedDone = !wanted.has('indeed_apply') || ready || terminal.indeed && /^(done|failed|paused)$/i.test(terminal.indeed.status || '');
    if (ready || (linkedInDone && indeedDone)) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  return { requested: Array.from(wanted), launches, counts: lastCounts, terminal,
    elapsedMs: Date.now() - startedAt };
}

async function runBrowserDiscoveryQueries(options = {}) {
  const BrowserDiscovery = require('./sourcing/browser-discovery');
  const plan = BrowserDiscovery.buildBrowserDiscoveryPlan(options);
  // One page per source/title is intentionally cheap. LinkedIn and Indeed run as a pair for each
  // title, so the full configured title set still fits inside the normal sourcing admission window.
  const timeoutMs = Math.max(15000, Math.min(60000, Number(options.perQueryTimeoutMs) || 40000));
  const byQuery = [], blockedSources = new Set();
  const runItem = async item => {
    const startedAt = Date.now();
    const launchBody = { source: item.source, url: item.url, fast: item.fast, discovery: true,
      scanOptions: item.scanOptions };
    let launch = await postLocalJson('/start-scan', launchBody, 15000);
    // MV3 may reconnect while a long browser sweep is in progress. A zero-client launch is not a
    // scan attempt: wait briefly for the existing extension to reconnect and retry exactly once.
    if (!launch.ok || !launch.data || launch.data.ok === false || !(launch.data.pushed > 0)) {
      const reconnectDeadline = Date.now() + 15000;
      while (Date.now() < reconnectDeadline && !Array.from(wsClients).some(c => c.readyState === 1)) {
        await new Promise(r => setTimeout(r, 1000));
      }
      if (Array.from(wsClients).some(c => c.readyState === 1)) {
        launch = await postLocalJson('/start-scan', launchBody, 15000);
      }
    }
    let terminal = { terminal: false, status: 'launch_failed', reason: 'extension_disconnected_or_launch_rejected' };
    if (launch.ok && launch.data && launch.data.ok !== false && launch.data.pushed > 0) {
      while (Date.now() - startedAt < timeoutMs) {
        const storage = await getStorageFromExtension(['pja_scan_coverage', 'pja_indeed_scan'], 5000);
        terminal = BrowserDiscovery.scanTerminal(storage, item, startedAt);
        if (terminal.terminal) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!terminal.terminal) terminal = { terminal: true, status: 'timeout', reason: 'per_query_timeout' };
    }
    const coverage = terminal.coverage || {};
    return { source: item.source, query: item.query, status: terminal.status,
      reason: terminal.reason || '', collected: Number(coverage.collected || terminal.scan && terminal.scan.total || 0),
      easyApply: Number(coverage.easyApply || coverage.indeedApply || terminal.scan && terminal.scan.indeedApply || 0),
      external: Number(coverage.external || 0), elapsedMs: Date.now() - startedAt };
  };
  const queries = Array.from(new Set(plan.map(item => item.query)));
  for (const query of queries) {
    const active = plan.filter(item => item.query === query && !blockedSources.has(item.source));
    const skipped = plan.filter(item => item.query === query && blockedSources.has(item.source))
      .map(item => ({ source: item.source, query: item.query, status: 'skipped_source_blocked' }));
    const rows = await Promise.all(active.map(runItem));
    byQuery.push(...rows, ...skipped);
    for (const row of rows) {
      if (row.source === 'indeed' && /^(paused|failed)$/i.test(String(row.status || '')) &&
          /challenge|captcha|verification/i.test(String(row.reason || ''))) blockedSources.add(row.source);
    }
  }
  return { requestedQueries: queries, scans: byQuery,
    blockedSources: Array.from(blockedSources), totals: byQuery.reduce((acc, row) => {
      acc.collected += Number(row.collected || 0);
      acc.easyApply += Number(row.easyApply || 0);
      acc.external += Number(row.external || 0);
      if (row.status === 'done') acc.completed++;
      else acc.incomplete++;
      return acc;
    }, { collected: 0, easyApply: 0, external: 0, completed: 0, incomplete: 0 }) };
}

// Push storage to the extension (returns count of clients written).
function setStorageToExtension(obj) {
  let pushed = 0;
  for (const c of wsClients) {
    if (c.readyState === 1) { c.send(JSON.stringify({ cmd: 'setStorage', data: obj })); pushed++; }
  }
  return pushed;
}

async function persistApplyRunControl(value, options = {}) {
  if (!value || !value.runId) throw new Error('apply run control requires runId');
  const currentStorage = await getStorageFromExtension(['pja_apply_run_control'], 5000);
  const current = currentStorage && currentStorage.pja_apply_run_control;
  const next = ApplyRunControl.build(current, value, options);
  const result = await wsAsk('setStorage', { data: { pja_apply_run_control: next } }, 'setStorageReply', 10000);
  if (!result || result.ok !== true) throw new Error(result && (result.error || result.reason) || 'apply run control was not persisted');
  return next;
}

function activeApplyRunControl(control, now = Date.now()) {
  // A crashed dev server cannot finalize its control record. Do not permanently deadlock future
  // work, but keep the record observable so its exact-run status reports stalled/abandoned work.
  return ApplyRunControl.isActive(control, { now, maxAgeMs: 60 * 60 * 1000 });
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
    runId: safeReportText(row.runId || ''),
    jobId: safeReportText(row.jobId || row.id || row.sourceJobId || ''),
    company: safeReportText(row.company || ''),
    title: safeReportText(row.title || ''),
    channel: safeReportText(row.channel || 'external'),
    ats: safeReportText(row.ats || row.strategy || row.handler || ''),
    strategy: safeReportText(row.strategy || row.ats || row.handler || ''),
    location: safeReportText(row.location || ''),
    reason: safeReportText(row.reason || row.skipReason || row.error || ''),
    fitScore: row.fitScore == null || row.fitScore === '' ? '' : safeReportText(row.fitScore),
    url: safeReportText(row.applyUrl || row.url || row.listingUrl || ''),
    descriptionStatus: safeReportText(row.descriptionStatus || ''),
    hydrationStatus: safeReportText(row.hydrationStatus || ''),
    hydrationMethod: safeReportText(row.hydrationMethod || ''),
    hydrationReason: safeReportText(row.hydrationReason || ''),
    diagnostic: row.diagnostic && typeof row.diagnostic === 'object' ? compactReportDiagnostic(row.diagnostic) : null,
  };
}

function compactReportDiagnostic(diag = {}) {
  const list = (arr, max = 12, textMax = 160) => Array.isArray(arr)
    ? arr.map(x => safeReportText(typeof x === 'string' ? x : x && (x.label || x.name || x.text || x.reason || '')))
      .filter(Boolean).slice(0, max).map(x => x.slice(0, textMax))
    : [];
  return {
    phase: safeReportText(diag.phase || '').slice(0, 80),
    runId: safeReportText(diag.runId || ''),
    jobId: safeReportText(diag.jobId || diag.id || ''),
    company: safeReportText(diag.company || ''),
    title: safeReportText(diag.title || ''),
    applyUrl: safeReportText(diag.applyUrl || diag.url || '').slice(0, 240),
    reason: safeReportText(diag.reason || '').slice(0, 80),
    ats: safeReportText(diag.ats || diag.strategy || '').slice(0, 80),
    strategy: safeReportText(diag.strategy || diag.ats || '').slice(0, 80),
    hostname: safeReportText(diag.hostname || '').slice(0, 120),
    url: safeReportText(diag.url || diag.applyUrl || '').slice(0, 240),
    missingRequired: list(diag.missingRequired, 24, 140),
    visibleErrors: list(diag.visibleErrors, 24, 180),
    formSummary: safeReportText(diag.formSummary || '').slice(0, 320),
    submitButtons: list(diag.submitButtons, 12, 120),
    radioGroups: Array.isArray(diag.radioGroups) ? diag.radioGroups.slice(0, 12).map(g => ({
      name: safeReportText(g && g.name || '').slice(0, 100),
      checked: Number(g && g.checked) || 0,
      options: list(g && g.options, 8, 100),
    })) : [],
    recovery: Array.isArray(diag.recovery) ? diag.recovery.slice(-6).map(r => ({
      attempt: Number(r && r.attempt) || 0,
      reason: safeReportText(r && r.reason || '').slice(0, 80),
      classification: safeReportText(r && r.classification || '').slice(0, 80),
      likelyCause: safeReportText(r && r.likelyCause || '').slice(0, 220),
      actionsProposed: list(r && r.actionsProposed, 6, 80),
      actionsExecuted: Number(r && r.actionsExecuted) || 0,
      retrySubmit: !!(r && r.retrySubmit),
      advanceReason: safeReportText(r && r.advanceReason || '').slice(0, 80),
      recovered: !!(r && r.recovered),
      beforeErrors: list(r && r.beforeErrors, 6, 120),
      afterErrors: list(r && r.afterErrors, 6, 120),
    })) : [],
    likelyCause: safeReportText(diag.likelyCause || '').slice(0, 280),
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

function reportJobKey(row = {}) {
  return [
    String(row.runId || '').toLowerCase(),
    String(row.id || '').toLowerCase(),
    String(row.jobId || '').toLowerCase(),
    String(row.url || row.applyUrl || '').toLowerCase(),
    String(row.company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    String(row.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  ].join('::');
}

function reportHost(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch (_) { return ''; }
}

function diagnosticMatchesReportRow(row = {}, diagnostic = {}, runId = '') {
  if (runId && diagnostic.runId && diagnostic.runId !== runId) return false;
  const rowHost = reportHost(row.url || row.applyUrl);
  const diagHost = reportHost(diagnostic.applyUrl || diagnostic.url);
  if (rowHost && diagHost && rowHost !== diagHost) return false;
  const rowJobId = String(row.jobId || row.id || '').trim().toLowerCase();
  const diagJobId = String(diagnostic.jobId || diagnostic.id || '').trim().toLowerCase();
  if (rowJobId && diagJobId && rowJobId !== diagJobId) return false;
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const rowCompany = norm(row.company), diagCompany = norm(diagnostic.company);
  const rowTitle = norm(row.title), diagTitle = norm(diagnostic.title);
  if (rowCompany && diagCompany && rowCompany !== diagCompany) return false;
  if (rowTitle && diagTitle && rowTitle !== diagTitle) return false;
  return true;
}

function diagnosticHasRunJobIdentity(diagnostic = {}, rows = []) {
  const diagJobId = String(diagnostic.jobId || diagnostic.id || '').trim().toLowerCase();
  const diagUrl = String(diagnostic.applyUrl || diagnostic.url || '').trim().toLowerCase();
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const diagCompany = norm(diagnostic.company), diagTitle = norm(diagnostic.title);
  return (rows || []).some(row => {
    const rowJobId = String(row.jobId || row.id || '').trim().toLowerCase();
    const rowUrl = String(row.url || row.applyUrl || '').trim().toLowerCase();
    if (diagJobId && rowJobId && diagJobId === rowJobId) return true;
    if (diagUrl && rowUrl && diagUrl === rowUrl) return true;
    return !!(diagCompany && diagTitle && diagCompany === norm(row.company) && diagTitle === norm(row.title));
  });
}

function collectReportDiagnostics(storage = {}, ranked = null, allRows = [], runId = '') {
  const raw = [];
  for (const row of allRows || []) {
    if (row.diagnostic && diagnosticMatchesReportRow(row, row.diagnostic, runId)) raw.push({ row, diagnostic: row.diagnostic });
  }
  const stored = Array.isArray(storage.pja_apply_diagnostics) ? storage.pja_apply_diagnostics : [];
  for (const d of stored) {
    if (runId && d.runId && d.runId !== runId) continue;
    if (runId && !d.runId && !diagnosticHasRunJobIdentity(d, allRows)) continue;
    const row = {
      runId: d.runId || '',
      jobId: d.jobId || '',
      company: d.company || '',
      title: d.title || '',
      ats: d.ats || d.strategy || '',
      strategy: d.strategy || d.ats || '',
      channel: d.channel || 'external',
      reason: d.reason || '',
      url: d.applyUrl || d.url || '',
    };
    if (diagnosticMatchesReportRow(row, d, runId)) raw.push({ row, diagnostic: compactReportDiagnostic(d) });
  }
  const byKey = new Map();
  for (const item of raw) {
    const key = reportJobKey(item.row);
    if (!key.replace(/:/g, '')) continue;
    byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

function lookupDiagnostic(row, diagnostics) {
  if (row && row.diagnostic && !diagnosticMatchesReportRow(row, row.diagnostic, row.runId || '')) return null;
  const key = reportJobKey(row);
  const found = diagnostics.find(item => reportJobKey(item.row) === key && diagnosticMatchesReportRow(row, item.diagnostic || {}, row.runId || ''));
  return found && found.diagnostic || row.diagnostic || null;
}

function classifyFixCluster(row, diagnostic) {
  const reason = String(row.reason || row.status || diagnostic?.reason || '').toLowerCase();
  const ats = String(row.ats || diagnostic?.ats || '').toLowerCase();
  const text = [
    reason,
    diagnostic && diagnostic.formSummary,
    ...(diagnostic && diagnostic.visibleErrors || []),
    ...(diagnostic && diagnostic.missingRequired || []),
  ].join(' ').toLowerCase();
  if (ats === 'ashby' && /submit_unclear|needs_manual|missing_required|required|missing entry|react|radio|not committed/.test(text)) {
    return {
      id: 'ashby_required_field_commit_failure',
      title: 'Ashby required-field / React commit failure',
      recommendation: 'Fix Ashby field commit: use native setters plus input/change/blur for required text fields, improve visible-label radio selection, then make failed recovery terminal without waiting for watchdog.',
    };
  }
  if (/posting_not_found|no longer available|closed/.test(text)) {
    return {
      id: 'stale_apply_url_or_closed_posting',
      title: 'Stale apply URL / closed posting',
      recommendation: 'Improve sourcing freshness and apply-URL preflight; exclude closed postings before they consume an E2E attempt.',
    };
  }
  if (/captcha|checkpoint|challenge/.test(text)) {
    return {
      id: 'external_antibot_or_captcha',
      title: 'External CAPTCHA / anti-bot blocker',
      recommendation: 'Pause that channel or tenant and retry only after manual browser/account reset.',
    };
  }
  if (/email_verification/.test(text)) {
    return {
      id: 'email_verification_flow_gap',
      title: 'Email verification flow gap',
      recommendation: 'Improve Gmail code detection, code-entry commit, and post-code confirmation handling for this ATS.',
    };
  }
  if (/unsupported_/.test(text)) {
    return {
      id: 'unsupported_apply_handler',
      title: 'Unsupported apply handler',
      recommendation: 'Add or repair the specific ATS handler, then retest with the listed real job IDs.',
    };
  }
  return {
    id: `${safeReportText(row.ats || 'unknown').toLowerCase() || 'unknown'}_${safeReportText(row.reason || row.status || 'failure').toLowerCase() || 'failure'}`.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
    title: `${safeReportText(row.ats || 'Unknown ATS')} ${safeReportText(row.reason || row.status || 'failure')}`,
    recommendation: developerRecommendation(row),
  };
}

function buildFixClusters(problemRows, diagnostics) {
  const map = new Map();
  for (const row of problemRows || []) {
    const diagnostic = lookupDiagnostic(row, diagnostics);
    const cls = classifyFixCluster(row, diagnostic);
    const cluster = map.get(cls.id) || { ...cls, count: 0, rows: [], evidence: new Set() };
    cluster.count++;
    cluster.rows.push({ ...row, diagnostic });
    if (diagnostic) {
      for (const e of (diagnostic.visibleErrors || []).slice(0, 4)) cluster.evidence.add(e);
      for (const m of (diagnostic.missingRequired || []).slice(0, 4)) cluster.evidence.add('missing: ' + m);
      if (diagnostic.formSummary) cluster.evidence.add(diagnostic.formSummary);
    }
    map.set(cls.id, cluster);
  }
  return Array.from(map.values())
    .map(c => ({ ...c, evidence: Array.from(c.evidence).slice(0, 8) }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function buildRetestManifest(runId, clusters) {
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    recommendedRetests: clusters.slice(0, 8).flatMap((cluster, clusterIndex) =>
      cluster.rows.slice(0, 5).map((row, rowIndex) => ({
        priority: clusterIndex + 1,
        cluster: cluster.id,
        clusterTitle: cluster.title,
        job: {
          jobId: row.jobId || '',
          company: row.company || '',
          title: row.title || '',
          channel: row.channel || 'external',
          ats: row.ats || row.strategy || '',
          strategy: row.strategy || row.ats || '',
          applyUrl: row.url || '',
        },
        reason: row.reason || row.status || '',
        why: cluster.evidence[rowIndex] || cluster.recommendation,
      }))
    ),
  };
}

function fixOpportunityCategory(item = {}) {
  const text = [item.id, item.reason, item.title, item.category].map(x => String(x || '').toLowerCase()).join(' ');
  if (/hydration|description|rescore_missing_description|missing_description/.test(text)) return 'hydration';
  if (/ashby|required|commit|radio|missing_required|selectinput|form-fill|form fill/.test(text)) return 'form_commit';
  if (/unsupported|unknown_apply_strategy|missing_apply_url|routing|handler/.test(text)) return 'unsupported_handler';
  if (/auth|login|password|account|verification/.test(text)) return 'auth_blocker';
  if (/captcha|checkpoint|anti.?bot|daily_limit/.test(text)) return 'anti_bot';
  if (/score|threshold|weak_match|confidence|evidence|unscored/.test(text)) return 'scoring';
  return 'routing';
}

function fixOpportunityScore(item = {}) {
  const affected = Number(item.affectedJobCount || item.count || 0) || 0;
  const repeated = Array.isArray(item.runs) ? item.runs.length : Number(item.repeatedRuns || 1) || 1;
  const maxFit = Number(item.maxFitScore || 0) || 0;
  const category = fixOpportunityCategory(item);
  const boost = category === 'hydration' ? 18
    : category === 'form_commit' ? 16
      : category === 'unsupported_handler' ? 12
        : category === 'scoring' ? 8 : 0;
  const penalty = /auth_blocker|anti_bot/.test(category) ? 18 : 0;
  return Math.round(affected * 10 + repeated * 6 + maxFit / 5 + boost - penalty);
}

function buildFixOpportunities(runId, fixClusters, planningDropRows) {
  const out = [];
  for (const cluster of fixClusters || []) {
    const rows = Array.isArray(cluster.rows) ? cluster.rows : [];
    out.push({
      id: cluster.id,
      title: cluster.title,
      category: fixOpportunityCategory(cluster),
      reason: cluster.id,
      affectedJobCount: cluster.count || rows.length,
      maxFitScore: Math.max(0, ...rows.map(r => Number(r.fitScore) || 0)),
      recommendation: cluster.recommendation,
      examples: rows.slice(0, 6).map(r => ({
        jobId: r.jobId || '',
        company: r.company || '',
        title: r.title || '',
        channel: r.channel || '',
        ats: r.ats || r.strategy || '',
        applyUrl: r.url || '',
        reason: r.reason || r.status || '',
      })),
      evidence: cluster.evidence || [],
      runs: [runId],
    });
  }
  const planningGroups = new Map();
  for (const row of planningDropRows || []) {
    const reason = safeReportText(row.reason || row.status || 'planning_drop') || 'planning_drop';
    const rows = planningGroups.get(reason) || [];
    rows.push(row);
    planningGroups.set(reason, rows);
  }
  for (const [reason, rows] of planningGroups.entries()) {
    if (!/rescore_missing_description|missing_description_evidence|unknown_apply_strategy|unsupported_|missing_apply_url|aggregator_without_apply_destination|rescore_weak_match_evidence|unscored/i.test(reason)) continue;
    out.push({
      id: 'planning_' + reason.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase(),
      title: `Planning drop: ${reason}`,
      category: fixOpportunityCategory({ reason }),
      reason,
      affectedJobCount: rows.length,
      maxFitScore: Math.max(0, ...rows.map(r => Number(r.fitScore) || 0)),
      recommendation: developerRecommendation({ reason }),
      examples: rows.slice(0, 8).map(r => ({
        jobId: r.jobId || '',
        company: r.company || '',
        title: r.title || '',
        channel: r.channel || '',
        ats: r.ats || r.strategy || '',
        applyUrl: r.url || '',
        reason: r.reason || '',
        descriptionStatus: r.descriptionStatus || '',
        hydrationStatus: r.hydrationStatus || '',
        hydrationReason: r.hydrationReason || '',
      })),
      evidence: rows.slice(0, 4).map(r => [r.channel, r.descriptionStatus, r.hydrationStatus, r.hydrationReason].filter(Boolean).join(' / ')).filter(Boolean),
      runs: [runId],
    });
  }
  return out.map(item => ({ ...item, valueScore: fixOpportunityScore(item) }))
    .sort((a, b) => b.valueScore - a.valueScore || b.affectedJobCount - a.affectedJobCount || a.id.localeCompare(b.id));
}

function updateFixOpportunities(runId, opportunities) {
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, 'fix-opportunities.json');
  const now = new Date().toISOString();
  let existing = { schemaVersion: 1, opportunities: [] };
  try {
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    existing = { schemaVersion: 1, opportunities: [] };
  }
  const map = new Map((Array.isArray(existing.opportunities) ? existing.opportunities : [])
    .map(item => [item.id, item]));
  for (const next of opportunities || []) {
    if (!next || !next.id) continue;
    const prev = map.get(next.id) || {};
    const runs = Array.from(new Set([...(Array.isArray(prev.runs) ? prev.runs : []), runId, ...(Array.isArray(next.runs) ? next.runs : [])].filter(Boolean))).slice(-20);
    const examples = [...(Array.isArray(next.examples) ? next.examples : []), ...(Array.isArray(prev.examples) ? prev.examples : [])];
    const seenExamples = new Set();
    const uniqueExamples = [];
    for (const ex of examples) {
      const key = [ex.applyUrl || '', ex.jobId || '', ex.company || '', ex.title || ''].join('|');
      if (seenExamples.has(key)) continue;
      seenExamples.add(key);
      uniqueExamples.push(ex);
      if (uniqueExamples.length >= 12) break;
    }
    const merged = {
      ...prev,
      ...next,
      firstSeen: prev.firstSeen || now,
      lastSeen: now,
      runs,
      repeatedRuns: runs.length,
      affectedJobCount: Math.max(Number(prev.affectedJobCount || 0), Number(next.affectedJobCount || 0)),
      totalObservedJobCount: (Number(prev.totalObservedJobCount || 0) + Number(next.affectedJobCount || 0)) || Number(next.affectedJobCount || 0),
      examples: uniqueExamples,
      category: fixOpportunityCategory(next),
    };
    merged.valueScore = fixOpportunityScore(merged);
    map.set(next.id, merged);
  }
  const body = {
    schemaVersion: 1,
    updatedAt: now,
    opportunities: Array.from(map.values())
      .sort((a, b) => b.valueScore - a.valueScore || b.totalObservedJobCount - a.totalObservedJobCount || a.id.localeCompare(b.id))
      .slice(0, 80),
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return file;
}

function normalizeCoverageMap(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [key, raw] of Object.entries(map)) {
    if (!key) continue;
    const row = raw && typeof raw === 'object' ? raw : {};
    out[safeReportText(key).toLowerCase()] = {
      discovered: Number(row.discovered) || 0,
      hydrated: Number(row.hydrated) || 0,
      scored: Number(row.scored) || 0,
      eligible: Number(row.eligible != null ? row.eligible : row.qualified) || 0,
      reserved: Number(row.reserved) || 0,
      attempted: Number(row.attempted) || 0,
      confirmed: Number(row.confirmed) || 0,
      failed: Number(row.failed) || 0,
      skipped: Number(row.skipped) || 0,
      unverified: Number(row.unverified) || 0,
      blocker: safeReportText(row.blocker || row.reason || ''),
      example: row.example && typeof row.example === 'object'
        ? compactReportJob(row.example, row.example.status || 'coverage') : null,
    };
  }
  return out;
}

function updateCoverageResults(coverage, rows, matcher, status) {
  for (const [key, row] of Object.entries(coverage)) {
    const matches = (rows || []).filter(r => matcher(r, key));
    if (!matches.length) continue;
    row.attempted += matches.length;
    if (status && row[status] != null) row[status] += matches.length;
    if (!row.example) row.example = compactReportJob(matches[0], status || matches[0].status || 'coverage');
  }
}

function coverageRecommendation(row) {
  if (!row) return '';
  if (row.confirmed) return 'Covered by a confirmed real submission.';
  if (row.attempted) return row.failed || row.unverified
    ? 'Attempted with real job; inspect per-job diagnostics and retest manifest.'
    : 'Attempted; inspect ledger/report outcome.';
  if (!row.discovered) return 'Sourcing gap: add/refresh real sources for this strategy before apply.';
  if (!row.hydrated) return 'Hydration gap: resolve real apply URL and full description before scoring.';
  if (!row.scored) return 'Scoring gap: run evidence-grounded scoring for hydrated jobs.';
  if (!row.eligible) return 'Eligibility gate: inspect threshold, match evidence, prior blockers, stale/already-applied state, or unsupported portal drops.';
  if (!row.reserved) return 'Planner gap: eligible job existed but was not reserved; inspect attempt cap/per-company cap.';
  if (!row.attempted) return 'Reserved by planning; run full-submit coverage to exercise this real job.';
  return row.blocker || 'Coverage not attempted; inspect planning drops.';
}

function buildStrategyCoverageMatrix(ranked) {
  if (!ranked) return [];
  const channelCoverage = normalizeCoverageMap(ranked.channelCoverage);
  const strategyCoverage = normalizeCoverageMap(ranked.strategyCoverage);
  const jobs = Array.isArray(ranked.jobs) ? ranked.jobs : [];
  for (const [key, row] of Object.entries(channelCoverage)) {
    row.kind = 'channel';
    row.name = key;
    row.reserved = Math.max(row.reserved, jobs.filter(j => String(j && (j.channel || 'external')).toLowerCase() === key).length);
  }
  for (const [key, row] of Object.entries(strategyCoverage)) {
    row.kind = 'strategy';
    row.name = key;
    row.reserved = Math.max(row.reserved, jobs.filter(j => String(j && (j.strategy || j.ats) || 'generic').toLowerCase() === key).length);
  }
  const results = ranked.results || {};
  const channelMatch = (r, key) => String(r && (r.channel || 'external')).toLowerCase() === key;
  const strategyMatch = (r, key) => String(r && (r.strategy || r.ats) || 'generic').toLowerCase() === key;
  for (const [status, rows] of Object.entries({
    confirmed: results.confirmed || [],
    failed: results.failed || [],
    skipped: results.skipped || [],
    unverified: results.unverified || [],
  })) {
    updateCoverageResults(channelCoverage, rows, channelMatch, status);
    updateCoverageResults(strategyCoverage, rows, strategyMatch, status);
  }
  return Object.values(channelCoverage).concat(Object.values(strategyCoverage)).map(row => ({
    ...row,
    recommendation: coverageRecommendation(row),
  }));
}

function developerRecommendation(row = {}) {
  const reason = String(row.reason || row.status || '').toLowerCase();
  const ats = String(row.ats || '').toLowerCase();
  const channel = String(row.channel || '').toLowerCase();
  if (/workday_duplicate_record/.test(reason)) {
    return 'Manual Workday draft-data blocker: do not refill or resubmit; inspect the existing Previous Worker/Address records before any targeted retry.';
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
  if (/ranked_watchdog_timeout|stuck_watchdog|watchdog_timeout|submit_unclear|submit_unconfirmed|submit_observation_timeout|workday_transport_failure/.test(reason)) {
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
  if (/outside_target_location/.test(reason)) {
    return 'Location safety gate: verify profile target-location preferences and keep stale/out-of-radius corpus rows out of apply planning.';
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
  const runControl = storage && storage.pja_apply_run_control || null;
  const ranked = ApplyProgress.runFromStorage(storage || {}, options.runId) || null;
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
  const rawLastFailure = storage && storage.pja_last_apply_failure || null;
  const rankedJobIds = new Set((Array.isArray(ranked && ranked.jobs) ? ranked.jobs : [])
    .map(job => String(job && (job.jobId || job.id) || '')).filter(Boolean));
  const rawFailureOwned = !!(rawLastFailure && ranked && (
    rawLastFailure.runId && rawLastFailure.runId === ranked.runId ||
    !rawLastFailure.runId && rankedJobIds.has(String(rawLastFailure.jobId || rawLastFailure.id || ''))
  ));
  const lastFailure = compactReportJob(rawFailureOwned ? rawLastFailure
    : ranked && ranked.error ? { runId, reason: ranked.error } : null, 'last_failure');
  const reportHealth = ApplyReportHealth.resolveReportHealth(storage || {}, runControl);
  const profileFieldCount = reportHealth.profileFieldCount;
  const resumeConfigured = reportHealth.resumeConfigured;
  const count = name => Array.isArray(results[name]) ? results[name].length
    : ranked && ranked.counts && ranked.counts[name] != null ? Number(ranked.counts[name]) || 0
    : ranked && ranked[name] != null ? Number(ranked[name]) || 0
    : 0;
  const planningDropsRaw = ranked && ranked.planningDrops && Array.isArray(ranked.planningDrops.examples)
    ? ranked.planningDrops.examples : [];
  const planningDropRows = planningDropsRaw.map(row => compactReportJob(row, 'planning_drop'));
  const problemRows = allRows.filter(row => /^(failed|skipped|unverified)$/i.test(row.status));
  const diagnostics = collectReportDiagnostics(storage, ranked, allRows, runId);
  const fixClusters = buildFixClusters(problemRows, diagnostics);
  const fixOpportunities = buildFixOpportunities(runId, fixClusters, planningDropRows);
  const coverageMatrix = buildStrategyCoverageMatrix(ranked);
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
  const stateSource = activeRanked && activeRanked.runId === runId ? 'active ranked run'
    : completedRanked && completedRanked.runId === runId ? 'last completed ranked run'
      : runControl && runControl.runId === runId ? 'durable run control' : 'none';
  lines.push(`- State source: ${stateSource}`);
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
  lines.push('## Run health');
  lines.push('');
  lines.push(`- Extension clients: ${wsClients.size}`);
  lines.push(`- Profile configured: ${reportHealth.profileConfigured == null ? 'unknown' : reportHealth.profileConfigured ? 'yes' : 'no'}${profileFieldCount == null ? '' : ` (${profileFieldCount} non-empty fields)`}`);
  lines.push(`- Resume configured: ${resumeConfigured == null ? 'unknown' : resumeConfigured ? 'yes' : 'no'}`);
  if (reportHealth.source === 'preflight') lines.push('- Profile/resume health source: successful admission preflight');
  lines.push(`- Active/in-flight: ${ranked && ranked.status === 'applying' ? 'yes' : 'no'} / ${ranked && ranked.inFlightIndex != null ? 'yes' : 'no'}`);
  lines.push(`- Job tab cleanup: ${ranked && (ranked.tabCleanup || ranked.lastTabCleanup) ? safeReportText(JSON.stringify(ranked.tabCleanup || ranked.lastTabCleanup)) : 'not recorded'}`);
  if (storage && storage.pja_profile_restored_from_backup) lines.push('- Profile backup recovery: yes');
  if (storage && storage.pja_profile_write_rejected) lines.push(`- Last rejected profile write: ${safeReportText(storage.pja_profile_write_rejected.reason || '')}`);
  lines.push('');
  const plannedRows = ranked && Array.isArray(ranked.jobs)
    ? ranked.jobs.slice(0, 80).map(row => compactReportJob(row, 'planned')) : [];
  if (plannedRows.length && /planned|applying|paused|aborted|blocked/i.test(String(ranked && ranked.status || ''))) {
    lines.push('## Planned apply queue');
    lines.push('');
    lines.push('| # | Company | Title | Location | Channel | ATS | Fit | Job ID | URL |');
    lines.push('| ---: | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [idx, row] of plannedRows.entries()) {
      lines.push(`| ${idx + 1} | ${row.company} | ${row.title} | ${row.location} | ${row.channel} | ${row.ats} | ${row.fitScore} | ${row.jobId} | ${row.url} |`);
    }
    lines.push('');
  }
  if (coverageMatrix.length) {
    lines.push('## Strategy coverage matrix');
    lines.push('');
    lines.push('This shows whether the run actually found, scored, reserved, and attempted real jobs for each requested channel/ATS strategy.');
    lines.push('');
    lines.push('| Kind | Name | Found | Hydrated | Scored | Eligible | Reserved | Attempted | Result | Recommendation |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
    for (const row of coverageMatrix) {
      const result = row.confirmed ? `${row.confirmed} confirmed`
        : row.failed ? `${row.failed} failed`
        : row.unverified ? `${row.unverified} unverified`
        : row.skipped ? `${row.skipped} skipped`
        : row.reserved ? 'reserved_not_attempted'
        : 'not_covered';
      lines.push(`| ${safeReportText(row.kind)} | ${safeReportText(row.name)} | ${row.discovered} | ${row.hydrated} | ${row.scored} | ${row.eligible} | ${row.reserved} | ${row.attempted} | ${safeReportText(result)} | ${safeReportText(row.recommendation)} |`);
    }
    lines.push('');
  }
  if (problemRows.length) {
    if (fixClusters.length) {
      lines.push('## Highest reward fix clusters');
      lines.push('');
      lines.push('These clusters are ranked by affected real jobs in this run. Use the listed retest jobs after implementing the recommended fix.');
      lines.push('');
      for (const [idx, cluster] of fixClusters.entries()) {
        lines.push(`### ${idx + 1}. ${safeReportText(cluster.title)} (${cluster.count} job${cluster.count === 1 ? '' : 's'})`);
        lines.push('');
        lines.push(`- Cluster id: ${safeReportText(cluster.id)}`);
        lines.push(`- Recommended fix: ${safeReportText(cluster.recommendation)}`);
        if (cluster.evidence.length) {
          lines.push('- Evidence:');
          for (const item of cluster.evidence.slice(0, 6)) lines.push(`  - ${safeReportText(item)}`);
        }
        lines.push('- Retest jobs:');
        for (const row of cluster.rows.slice(0, 5)) {
          lines.push(`  - ${safeReportText(row.company)} — ${safeReportText(row.title)} | ${safeReportText(row.ats || row.strategy)} | ${safeReportText(row.jobId || '')} | ${safeReportText(row.url)}`);
        }
        lines.push('');
      }
    }
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
  if (fixOpportunities.length) {
    lines.push('## Fix opportunity candidates from this run');
    lines.push('');
    lines.push('These are persisted into `reports/fix-opportunities.json` across runs so repeated high-value patterns stay visible.');
    lines.push('');
    lines.push('| Value | Category | Affected | Opportunity | Retest example |');
    lines.push('| ---: | --- | ---: | --- | --- |');
    for (const item of fixOpportunities.slice(0, 12)) {
      const ex = item.examples && item.examples[0] || {};
      lines.push(`| ${item.valueScore} | ${safeReportText(item.category)} | ${item.affectedJobCount} | ${safeReportText(item.title)} | ${safeReportText([ex.company, ex.title, ex.jobId].filter(Boolean).join(' — '))} |`);
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
      const unsupportedRows = planningDropRows.filter(row => /^unsupported_|unknown_apply_strategy|aggregator_without_apply_destination|missing_apply_url/i.test(String(row.reason || '')));
      if (unsupportedRows.length) {
        lines.push('### Good jobs found but not autonomously applyable yet');
        lines.push('');
        lines.push('| Reason | Company | Title | Channel | ATS | Fit | URL |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- |');
        for (const row of unsupportedRows.slice(0, 80).sort((a, b) => (Number(b.fitScore) || 0) - (Number(a.fitScore) || 0))) {
          lines.push(`| ${row.reason} | ${row.company} | ${row.title} | ${row.channel} | ${row.ats} | ${row.fitScore} | ${row.url} |`);
        }
        lines.push('');
      }
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
    lines.push('## Per-job lifecycle');
    lines.push('');
    lines.push('| Company | Title | Sourced | Scored | Planned | Routed | Attempted | Terminal result | Reason |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of allRows) {
      lines.push(`| ${row.company} | ${row.title} | yes | ${row.fitScore === '' ? 'unknown' : 'yes'} | yes | ${safeReportText(row.ats || row.strategy || row.channel)} | yes | ${safeReportText(row.status)} | ${safeReportText(row.reason)} |`);
    }
    lines.push('');
    lines.push('## Ranked-run outcomes');
    lines.push('');
    lines.push('| Status | Company | Title | Channel | ATS | Fit | Reason | URL |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of allRows) {
      lines.push(`| ${row.status} | ${row.company} | ${row.title} | ${row.channel} | ${row.ats} | ${row.fitScore} | ${row.reason} | ${row.url} |`);
    }
    lines.push('');
  }
  if (diagnostics.length) {
    lines.push('## Per-job failure diagnostics');
    lines.push('');
    lines.push('| Company | Title | ATS | Reason | Phase | Missing required | Visible errors | Recovery |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const item of diagnostics.slice(0, 80)) {
      const row = compactReportJob(item.row, item.row.status || 'diagnostic');
      const d = item.diagnostic || {};
      const recovery = Array.isArray(d.recovery) && d.recovery.length
        ? d.recovery.map(r => `${r.attempt}:${(r.actionsProposed || []).join('+') || r.classification || r.reason}${r.advanceReason ? '→' + r.advanceReason : ''}`).join('; ')
        : '';
      lines.push(`| ${safeReportText(row.company)} | ${safeReportText(row.title)} | ${safeReportText(row.ats || d.ats)} | ${safeReportText(row.reason || d.reason)} | ${safeReportText(d.phase)} | ${safeReportText((d.missingRequired || []).slice(0, 6).join('; '))} | ${safeReportText((d.visibleErrors || []).slice(0, 6).join('; '))} | ${safeReportText(recovery)} |`);
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
  return { runId, markdown: lines.join('\n'), retestManifest: buildRetestManifest(runId, fixClusters), fixOpportunities };
}

function writeApplyRunReport(storage, options = {}) {
  const report = renderApplyRunReport(storage || {}, options);
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `apply-run-${report.runId}.md`;
  const filePath = path.join(reportsDir, filename);
  fs.writeFileSync(filePath, report.markdown, 'utf8');
  const retestFilename = `retest-${report.runId}.json`;
  const retestFile = path.join(reportsDir, retestFilename);
  fs.writeFileSync(retestFile, JSON.stringify(report.retestManifest || buildRetestManifest(report.runId, []), null, 2) + '\n', 'utf8');
  const fixOpportunitiesFile = updateFixOpportunities(report.runId, report.fixOpportunities || []);
  return { runId: report.runId, file: filePath, bytes: Buffer.byteLength(report.markdown),
    retestFile, retestBytes: fs.statSync(retestFile).size,
    fixOpportunitiesFile };
}

function writeApplyPlanningReport(planningDrops, options = {}) {
  if (!planningDrops && !options.channelCoverage && !options.strategyCoverage) return null;
  const runId = safeReportId(options.runId || `plan-${Date.now()}`);
  const storage = options.storage && typeof options.storage === 'object' ? options.storage : {};
  return writeApplyRunReport(Object.assign({}, storage, {
    pja_ranked_apply: {
      runId,
      status: options.status || 'planning',
      currentIndex: 0,
      jobs: Array.isArray(options.jobs) ? options.jobs : [],
      results: { confirmed: [], failed: [], skipped: [], unverified: [] },
      planningDrops,
      coverage: options.coverage === true,
      coverageCount: options.coverageCount != null ? Number(options.coverageCount) || 1 : undefined,
      channelCoverage: options.channelCoverage || null,
      strategyCoverage: options.strategyCoverage || null,
    },
  }), { runId });
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
      hydrationStatus: safeReportText(job && job.hydrationStatus || ''),
      hydrationMethod: safeReportText(job && job.hydrationMethod || ''),
      hydrationReason: safeReportText(job && job.hydrationReason || ''),
    });
  }
  return planningDrops;
}

async function oneClickPreflight(options = {}) {
  const status = await refreshRuntimeCandidateProfile();
  const storage = wsClients.size ? await getStorageFromExtension(['pja_ranked_apply', 'pja_apply_run_control'], 5000) : {};
  const activeRanked = storage && storage.pja_ranked_apply && /^(applying|paused_for_patch|paused_for_fix)$/i
    .test(String(storage.pja_ranked_apply.status || ''));
  const activeControl = activeApplyRunControl(storage && storage.pja_apply_run_control);
  const active = activeRanked || activeControl;
  const problems = [];
  if (wsClients.size < 1) problems.push('extension_not_connected');
  if (options.requireCandidateProfile !== false && !status.configured) problems.push('candidate_profile_not_configured');
  if (options.requireResume !== false && !status.resume) problems.push('resume_not_configured');
  if (active && options.force !== true) problems.push('active_ranked_apply_run');
  return {
    ok: problems.length === 0,
    problems,
    clients: wsClients.size,
    candidate: status,
    activeRun: active ? {
      runId: (activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).runId || null,
      status: (activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).status || '',
      phase: (activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).phase || '',
      currentIndex: (activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).currentIndex,
      total: Array.isArray((activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).jobs)
        ? (activeRanked ? storage.pja_ranked_apply : storage.pja_apply_run_control).jobs.length : null,
    } : null,
  };
}

function summarizeApplyStatus(storage = {}, options = {}) {
  const activeRanked = storage.pja_ranked_apply || null;
  const completedRanked = storage.pja_last_completed_apply_run || null;
  const ranked = ApplyProgress.runFromStorage(storage, options.runId) || null;
  const results = ranked && ranked.results || {};
  const count = key => Array.isArray(results[key]) ? results[key].length
    : ranked && ranked.counts && ranked.counts[key] != null ? Number(ranked.counts[key]) || 0
    : 0;
  const currentJob = ranked && Array.isArray(ranked.jobs)
    ? ranked.jobs[ranked.inFlightIndex != null ? ranked.inFlightIndex : ranked.currentIndex]
    : null;
  const rawLastFailure = storage.pja_last_apply_failure || null;
  const rankedJobs = ranked && Array.isArray(ranked.jobs) ? ranked.jobs : [];
  const failureJobId = String(rawLastFailure && (rawLastFailure.jobId || rawLastFailure.id) || '');
  const failureOwned = !!(rawLastFailure && ranked && (
    rawLastFailure.runId && rawLastFailure.runId === ranked.runId ||
    !rawLastFailure.runId && failureJobId && rankedJobs.some(job =>
      String(job.jobId || job.id || '') === failureJobId)
  ));
  const failedRows = results && Array.isArray(results.failed) ? results.failed : [];
  const lastFailure = failureOwned ? rawLastFailure : failedRows[failedRows.length - 1] || null;
  const active = !!(ranked && /^(planning|applying|paused_for_patch|paused_for_fix)$/i.test(String(ranked.status || '')));
  const publicRun = ApplyProgress.publicProgress(storage, {
    runId: options.runId,
    clients: wsClients.size,
    now: options.now,
    handlerBudgetMs: options.handlerBudgetMs,
    reportPath: options.reportPath,
  });
  return {
    ok: true,
    clients: wsClients.size,
    active,
    run: ranked ? Object.assign({
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
    }, publicRun || {}) : null,
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

function minEvidenceForFitScore(score) {
  const n = Number(score);
  return Number.isFinite(n) && n >= 75 ? 3 : 2;
}

function hasEnoughMatchEvidence(job) {
  const evidence = Array.isArray(job && job.matchEvidence) ? job.matchEvidence.filter(Boolean) : [];
  return evidence.length >= minEvidenceForFitScore(job && job.fitScore);
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

async function scoreJobChunk(batch) {
  const jobList = batch.map((j, i) => `Job ${i + 1}: id=${JSON.stringify(j.id)}\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\nPosting: ${scoringExcerpt(j.description)}`).join('\n---\n');
  const prompt = `Score each job using only the resume facts and posting text. A score of 75+ requires at least three direct requirement matches, no hard conflict, realistic seniority, and medium/high confidence.\n\nJobs:\n${jobList}`;
  const raw = await runClaudeWithSystemPrompt(`${runtimeCandidatePrompt}${SCORE_PROMPT_SUFFIX}`, prompt);
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1 || e === -1) return [];
  try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { return []; }
}

async function scoreJobChunkWithRetry(batch, chunkIndex, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const scores = await scoreJobChunk(batch);
      const got = new Set((scores || []).map(s => String(s && s.id)));
      if (got.size === batch.length) return scores;
      if (got.size > 0 && attempt === maxAttempts) return scores;
      lastError = new Error(`partial score result ${got.size}/${batch.length}`);
    } catch (e) {
      lastError = e;
    }
    const waitMs = 750 * attempt + Math.floor(Math.random() * 250);
    console.log(`[PJA] chunk ${chunkIndex + 1} score attempt ${attempt}/${maxAttempts} failed: ${lastError && lastError.message}; retrying in ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw lastError || new Error('score chunk failed');
}

// Score all jobs in chunks of 10, with bounded concurrency. Resilient: a chunk that errors
// or times out leaves its jobs unscored (→ shortlist) instead of stalling the whole run.
// Codex calls are independent; bounded parallelism keeps full-corpus scoring practical while
// avoiding an unbounded process/connection fan-out.
async function scoreAll(jobs, concurrency = 3) {
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
      try { scores = await scoreJobChunkWithRetry(chunks[idx], idx); }
      catch (e) { console.log(`[PJA] chunk ${idx + 1} failed: ${e.message}`); }
      for (const s of scores) if (s && s.id != null) byId[String(s.id)] = s;
      console.log(`[PJA] scored chunk ${++done}/${chunks.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length || 1) }, worker));
  const { tnAdjustScore, medicalWaferBoost } = require('./sourcing/filter');
  return jobs.map(j => {
    const result = byId[String(j.id)] || null;
    if (!result) return { ...j, fitScore: null, scoreError: 'llm_score_failed', matchEvidence: [], gaps: [], conflicts: [], confidence: 'low' };
    const matchEvidence = Array.isArray(result.matchEvidence) ? result.matchEvidence.filter(Boolean).slice(0, 8) : [];
    const gaps = Array.isArray(result.gaps) ? result.gaps.filter(Boolean).slice(0, 8) : [];
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts.filter(Boolean).slice(0, 8) : [];
    const confidence = ['high', 'medium', 'low'].includes(String(result.confidence || '').toLowerCase()) ? String(result.confidence).toLowerCase() : 'low';
    let fitScore = medicalWaferBoost(j.title, j.company, j.description, tnAdjustScore(j.title, Number(result.score)));
    if (matchEvidence.length < minEvidenceForFitScore(fitScore) || conflicts.length || confidence === 'low') fitScore = Math.min(fitScore, 74);
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

  const parsedRequestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const runStatusMatch = parsedRequestUrl.pathname.match(/^\/apply-runs\/([^/]+)$/);
  const runEventsMatch = parsedRequestUrl.pathname.match(/^\/apply-runs\/([^/]+)\/events$/);
  const runResumeMatch = parsedRequestUrl.pathname.match(/^\/apply-runs\/([^/]+)\/resume$/);

  if (req.method === 'GET' && runStatusMatch) {
    try {
      const runId = safeReportId(decodeURIComponent(runStatusMatch[1] || ''));
      const st = await getStorageFromExtension([
        'pja_ranked_apply', 'pja_last_completed_apply_run', 'pja_apply_run_control', 'pja_application_ledger',
        'pja_applied_log', 'pja_apply_diagnostics', 'pja_last_apply_failure', 'pja_dbg',
        // Terminal exact-run reads auto-export the report. Include the same sanitized health
        // inputs as /export-apply-report so a status poll cannot overwrite known-good preflight
        // health with "unknown".
        'pja_profile', 'pja_profile_restored_from_backup', 'pja_profile_write_rejected',
        'pja_resume_filename',
      ], 8000);
      const selected = ApplyProgress.runFromStorage(st || {}, runId);
      if (!selected) {
        res.writeHead(404, CORS);
        res.end(JSON.stringify({ ok: false, error: 'apply run not found', runId, clients: wsClients.size }));
        return;
      }
      const autoReport = isTerminalApplyStatus(selected.status) ? writeApplyRunReport(st || {}, { runId }) : null;
      const status = summarizeApplyStatus(st || {}, { runId, reportPath: autoReport && autoReport.file });
      status.report = autoReport;
      status.recovery = decideRecovery(status.run);
      res.writeHead(200, CORS);
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ ok: false, error: e.message, clients: wsClients.size }));
    }
    return;
  }

  if (req.method === 'GET' && runEventsMatch) {
    try {
      const runId = safeReportId(decodeURIComponent(runEventsMatch[1] || ''));
      const st = await getStorageFromExtension([
        'pja_ranked_apply', 'pja_last_completed_apply_run', 'pja_apply_run_control', 'pja_application_ledger',
      ], 8000);
      if (!ApplyProgress.runFromStorage(st || {}, runId)) {
        res.writeHead(404, CORS);
        res.end(JSON.stringify({ ok: false, error: 'apply run not found', runId, clients: wsClients.size }));
        return;
      }
      const after = Number(parsedRequestUrl.searchParams.get('after')) || 0;
      const events = ApplyProgress.runEvents(st || {}, { runId, after, limit: parsedRequestUrl.searchParams.get('limit') });
      const nextCursor = events.length ? events[events.length - 1].cursor : after;
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, runId, events, nextCursor }));
    } catch (e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ ok: false, error: e.message, clients: wsClients.size }));
    }
    return;
  }

  if (req.method === 'POST' && runResumeMatch) {
    try {
      req.resume();
      const runId = safeReportId(decodeURIComponent(runResumeMatch[1] || ''));
      const st = await getStorageFromExtension(['pja_ranked_apply'], 8000);
      const active = st && st.pja_ranked_apply;
      if (!active || active.runId !== runId || !/^(applying|paused_for_patch|paused_for_fix)$/i.test(String(active.status || ''))) {
        res.writeHead(409, CORS);
        res.end(JSON.stringify({ ok: false, error: 'run is not the active resumable run', runId,
          activeRunId: active && active.runId || null }));
        return;
      }
      const data = await wsAsk('resumeRankedApply', {}, 'resumeRankedApplyReply', 30000);
      res.writeHead(data && data.ok && data.runId === runId ? 200 : 409, CORS);
      res.end(JSON.stringify(data && data.runId === runId ? data : {
        ok: false, error: 'resume ownership mismatch', runId, observedRunId: data && data.runId || null,
      }));
    } catch (e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ ok: false, error: e.message, clients: wsClients.size }));
    }
    return;
  }

  if (req.method === 'GET' && parsedRequestUrl.pathname === '/apply-status') {
    try {
      const st = await getStorageFromExtension([
        'pja_ranked_apply',
        'pja_last_completed_apply_run',
        'pja_apply_run_control',
        'pja_application_ledger',
        'pja_applied_log',
        'pja_apply_diagnostics',
        'pja_last_apply_failure',
        'pja_dbg',
        'pja_profile',
        'pja_profile_restored_from_backup',
        'pja_profile_write_rejected',
        'pja_resume_filename',
      ], 8000);
      const requestedRunId = parsedRequestUrl.searchParams.get('runId');
      if (requestedRunId && !ApplyProgress.runFromStorage(st || {}, safeReportId(requestedRunId))) {
        res.writeHead(404, CORS);
        res.end(JSON.stringify({ ok: false, error: 'apply run not found', runId: safeReportId(requestedRunId), clients: wsClients.size }));
        return;
      }
      const status = summarizeApplyStatus(st || {}, { runId: requestedRunId ? safeReportId(requestedRunId) : undefined });
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
    const effective = await resolveEffectiveAiEngine({ force: true });
    const aiConfig = effective.engine === 'codex'
      ? { model: codexModel(), reasoningEffort: codexReasoningEffort() }
      : { model: 'haiku', reasoningEffort: null };
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      ok: true,
      engine: `${effective.engine}-cli`,
      engineSource: effective.source,
      processEngine: `${PROCESS_AI_ENGINE}-cli`,
      aiConfig,
      clients: wsClients.size
    }));
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
      let url = null, fast = false, source = null, discovery = false, scanOptions = {};
      try { const b = JSON.parse(body || '{}'); url = b.url || null; fast = !!b.fast; source = b.source || null;
        discovery = b.discovery === true; scanOptions = b.scanOptions && typeof b.scanOptions === 'object' ? b.scanOptions : {}; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startScan', url, fast, source, discovery, scanOptions })); pushed++; }
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

  // Mark the current ranked job failed and continue via the normal dispatcher. This is a scoped
  // operator recovery for stuck jobs; it logs a ledger event instead of mutating counters by hand.
  if (req.method === 'POST' && req.url === '/fail-current-apply-job') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const data = await wsAsk('failCurrentRankedApply',
          { reason: o.reason || 'operator_failed_current_job' }, 'failCurrentRankedApplyReply', 30000);
        res.writeHead(data && data.ok ? 200 : 409, CORS);
        res.end(JSON.stringify(data || { ok: false, error: 'empty response' }));
      } catch (e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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
          'pja_apply_run_control',
          'pja_application_ledger',
          'pja_applied_log',
          'pja_apply_diagnostics',
          'pja_last_apply_failure',
          'pja_dbg',
          'pja_profile',
          'pja_profile_restored_from_backup',
          'pja_profile_write_rejected',
          'pja_resume_filename',
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

        const effective = await resolveEffectiveAiEngine();
        const raw = await runClaude(userPrompt);
        // Extract the JSON object robustly — Haiku sometimes adds text after the closing }
        const start = raw.indexOf('{');
        const end   = raw.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object in response: ' + raw.slice(0, 120));
        const data = JSON.parse(raw.slice(start, end + 1));
        data.engine = `${effective.engine}-dev`;

        console.log(`done (${Date.now() - t0}ms) score=${data.fitScore}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, data, engine: `${effective.engine}-dev`, engineSource: effective.source }));
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
        const st = await getStorageFromExtension(['pja_profile', 'pja_prefs', 'pja_jobs', 'pja_ext_queue', 'pja_applied_log']);
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

  // ── /apply-all: durable asynchronous entrypoint for normal use ─────────────
  // Persist the run identity before acknowledging the request, then let the internal worker own
  // sourcing and planning. Callers can immediately follow the exact run without holding a fragile
  // HTTP request open for several model/browser operations.
  if (req.method === 'POST' && req.url === '/apply-all') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let requestedRunId = '';
      if (applyRunAdmission) {
        res.writeHead(409, CORS);
        res.end(JSON.stringify({ success: false, stage: 'admission', error: 'another apply run is being admitted' }));
        return;
      }
      applyRunAdmission = true;
      try {
        const o = body ? JSON.parse(body) : {};
        requestedRunId = safeReportId(o.runId || `apply-${Date.now()}`);
        let admissionPreflight = null;
        if (o.preflight !== false) {
          admissionPreflight = await oneClickPreflight(o);
          if (!admissionPreflight.ok) {
            res.writeHead(409, CORS);
            res.end(JSON.stringify({ success: false, stage: 'preflight', preflight: admissionPreflight,
              error: 'one-click preflight failed: ' + admissionPreflight.problems.join(', ') }));
            return;
          }
        }
        const targetConfirmed = o.targetConfirmed != null ? Math.max(1, Number(o.targetConfirmed) || 1) : 20;
        await persistApplyRunControl({ runId: requestedRunId, status: 'planning', phase: 'sourcing',
          initialPhase: 'preflight', targetConfirmed, category: String(o.category || '').trim().toLowerCase(),
          terminalReason: null, error: null,
          preflightHealth: admissionPreflight ? {
            profileConfigured: admissionPreflight.candidate && admissionPreflight.candidate.configured === true,
            resumeConfigured: admissionPreflight.candidate && admissionPreflight.candidate.resume === true,
            profileFieldCount: admissionPreflight.candidate && admissionPreflight.candidate.fields,
            verifiedAt: Date.now(),
          } : null }, { create: true });
        const accepted = { success: true, accepted: true, status: 'planning', phase: 'sourcing',
          runId: requestedRunId,
          statusUrl: `/apply-runs/${encodeURIComponent(requestedRunId)}`,
          eventsUrl: `/apply-runs/${encodeURIComponent(requestedRunId)}/events`,
          reportUrl: '/export-apply-report' };
        res.writeHead(202, CORS);
        res.end(JSON.stringify(accepted));

        setTimeout(async () => {
          try {
            const worker = await postLocalJson('/apply-all-internal', Object.assign({}, o, {
              runId: requestedRunId, preflight: false, _ownedRunControl: true,
            }), Number(o.workflowTimeoutMs) || 45 * 60 * 1000);
            const failed = !worker.ok || worker.data && worker.data.success === false;
            if (failed) {
              await persistApplyRunControl({ runId: requestedRunId, status: 'failed', phase: 'terminal',
                terminalReason: String(worker.data && (worker.data.error || worker.data.stage) || `worker_http_${worker.status}`).slice(0, 120),
                error: String(worker.data && worker.data.error || `HTTP ${worker.status}`).slice(0, 500) });
            } else {
              const applyResult = worker.data && worker.data.apply || {};
              const noQueue = !applyResult.dryRun && Number(applyResult.planned) === 0;
              const terminalPatch = { runId: requestedRunId, status: noQueue ? 'exhausted' : 'done', phase: 'terminal',
                terminalReason: applyResult.dryRun ? 'dry_run_complete'
                  : noQueue ? String(applyResult.note || 'nothing_eligible').slice(0, 120)
                    : 'handed_off_to_ranked_run' };
              if (noQueue) terminalPatch.planningDrops = applyResult.planningDrops || null;
              await persistApplyRunControl(terminalPatch);
            }
          } catch (e) {
            try {
              await persistApplyRunControl({ runId: requestedRunId, status: 'failed', phase: 'terminal',
                terminalReason: /abort/i.test(e.name || '') ? 'workflow_timeout' : 'workflow_error',
                error: String(e.message || e).slice(0, 500) });
            } catch (persistError) {
              console.error(`[PJA] could not finalize run control ${requestedRunId}:`, persistError.message);
            }
          }
        }, 0);
      } catch (e) {
        console.error('[PJA] /apply-all admission error:', e.message);
        res.writeHead(503, CORS);
        res.end(JSON.stringify({ success: false, runId: requestedRunId || null, stage: 'admission', error: e.message }));
      } finally { applyRunAdmission = false; }
    });
    return;
  }

  // ── /apply-all-internal: source + plan worker owned by the durable control ─
  // Runs broad sourcing first, then the unified ranked driver. Prefer this over
  // /start-ea for "apply N jobs" because /start-ea is LinkedIn Easy Apply only.
  // body supports:
  //   {
  //     targetConfirmed:20, threshold:70, sourceTarget:160, perCompanyCap:2,
  //     includeAssisted:true, e2eSafe:true, source:false, dryRun:false, ...
  //   }
  // Unrecognized top-level fields are forwarded to /apply-run, so callers can still use
  // atsAllow, companyDeny, titleDeny, candidateIds, stopBeforeSubmit, force, etc.
  if (req.method === 'POST' && req.url === '/apply-all-internal') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const requestedRunId = safeReportId(o.runId || `apply-${Date.now()}`);
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
        const coverageMode = o.coverage === true || o.strategyCoverage === true ||
          /^(coverage|strategy_coverage|portal_coverage)$/i.test(String(o.mode || ''));
        const coverageChannels = Array.isArray(o.coverageChannels) ? o.coverageChannels
          : Array.isArray(o.requiredChannels) ? o.requiredChannels
          : coverageMode ? DEFAULT_COVERAGE_CHANNELS : [];
        const coverageStrategies = Array.isArray(o.coverageStrategies) ? o.coverageStrategies
          : Array.isArray(o.requiredStrategies) ? o.requiredStrategies
          : coverageMode ? DEFAULT_COVERAGE_STRATEGIES : [];
        const coverageCount = o.coverageCount != null ? Math.max(1, Number(o.coverageCount) || 1) : 1;
        const coverageBucketCount = Array.from(new Set([...(coverageChannels || []), ...(coverageStrategies || [])]
          .map(x => String(x || '').trim().toLowerCase()).filter(Boolean))).length;
        const coverageAttemptCount = coverageBucketCount * coverageCount;
        const targetConfirmed = o.targetConfirmed != null ? Math.max(1, Number(o.targetConfirmed) || 1)
          : (o.dailyCap != null && !applyAllAboveScore ? Math.max(1, Number(o.dailyCap) || 1)
            : coverageMode ? Math.max(1, coverageAttemptCount) : 20);
        const sourceTarget = o.sourceTarget != null ? Math.max(1, Number(o.sourceTarget) || 1)
          : coverageMode ? Math.max(300, coverageBucketCount * 80)
          : (applyAllAboveScore ? 500 : Math.max(400, targetConfirmed * 20));
        const sourceBody = {
          target: sourceTarget,
          write: o.sourceWrite !== false,
          autonomousApplyOnly: o.autonomousApplyOnly !== false,
          browserDiscovery: o.browserDiscovery !== false,
          browserDiscoveryMaxQueries: o.browserDiscoveryMaxQueries,
          browserDiscoveryMaxPages: o.browserDiscoveryMaxPages,
          browserDiscoveryPerQueryTimeoutMs: o.browserDiscoveryPerQueryTimeoutMs,
        };
        if (o.targetLocation && typeof o.targetLocation === 'object') sourceBody.targetLocation = o.targetLocation;
        if (o.targetRadiusMiles != null) sourceBody.targetRadiusMiles = Number(o.targetRadiusMiles);
        if (o.remotePolicy != null) sourceBody.remotePolicy = o.remotePolicy;
        if (o.locationStrictness != null) sourceBody.locationStrictness = o.locationStrictness;
        if (Array.isArray(o.queries) && o.queries.length) {
          sourceBody.queries = o.queries.map(q => String(q || '').trim()).filter(Boolean);
        }
        if (Array.isArray(o.queryFamilies) && o.queryFamilies.length) sourceBody.queryFamilies = o.queryFamilies;
        if (coverageMode) {
          sourceBody.coverage = true;
          sourceBody.requiredChannels = Array.from(new Set(coverageChannels.map(x => String(x || '').trim()).filter(Boolean)));
          sourceBody.coverageCount = coverageCount;
          sourceBody.browserScanTimeoutMs = o.browserScanTimeoutMs != null ? Number(o.browserScanTimeoutMs) : 240000;
        }
        if (o.maxBrowserAgeMs != null) sourceBody.maxBrowserAgeMs = Number(o.maxBrowserAgeMs);
        const applyBody = Object.assign({}, o, {
          runId: requestedRunId,
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
          workdayAttemptTimeoutMs: o.workdayAttemptTimeoutMs != null ? Number(o.workdayAttemptTimeoutMs)
            : o.e2eSafe !== false ? 180000 : undefined,
          coverage: coverageMode,
          coverageCount,
          requiredChannels: coverageMode ? Array.from(new Set(coverageChannels.map(x => String(x || '').trim()).filter(Boolean))) : o.requiredChannels,
          requiredStrategies: coverageMode ? Array.from(new Set(coverageStrategies.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))) : o.requiredStrategies,
        });
        // A single-category run does not need the broad planner's 150–300 candidate scoring
        // window. Bound evidence scoring to a small reserve around the requested attempts; callers
        // can explicitly raise scoreCandidateLimit after a supply-limited report.
        if (o.category && o.scoreCandidateLimit == null) {
          applyBody.scoreCandidateLimit = Math.max(20, coverageAttemptCount * 4,
            Number(applyBody.attemptCap || 0) * 4);
        }
        if (coverageMode && applyBody.attemptCap == null) applyBody.attemptCap = coverageAttemptCount;
        delete applyBody.source;
        delete applyBody.sourceTarget;
        delete applyBody.sourceWrite;
        delete applyBody.autonomousApplyOnly;
        delete applyBody.maxBrowserAgeMs;
        delete applyBody.queries;
        delete applyBody.browserDiscovery;
        delete applyBody.browserDiscoveryMaxQueries;
        delete applyBody.browserDiscoveryMaxPages;
        delete applyBody.browserDiscoveryPerQueryTimeoutMs;
        delete applyBody.queryFamilies;

        let sourceResp = { ok: true, skipped: true, status: 200, data: { note: 'source:false' } };
        if (o.source !== false) {
          sourceResp = await postLocalJson('/source-v2', sourceBody, Number(o.sourceTimeoutMs) || 15 * 60 * 1000);
          if (!sourceResp.ok || sourceResp.data && sourceResp.data.success === false) {
            res.writeHead(sourceResp.status || 502, CORS);
            res.end(JSON.stringify({ success: false, stage: 'source-v2', sourceOptions: sourceBody,
              source: sourceResp.data }));
            return;
          }
          if (!applyBody.dryRun && o.preflight !== false) {
            const postSourcePreflight = await oneClickPreflight({ ...o, force: true });
            if (!postSourcePreflight.ok) {
              res.writeHead(409, CORS);
              res.end(JSON.stringify({ success: false, stage: 'pre_apply_storage_guard', sourceOptions: sourceBody,
                source: sourceResp.data, preflight: postSourcePreflight,
                error: 'required profile/resume storage was not readable after sourcing; refusing to start apply-run' }));
              return;
            }
          }
        }

        if (o._ownedRunControl) await persistApplyRunControl({ runId: requestedRunId, status: 'planning', phase: 'planning' });
        const applyResp = await postLocalJson('/apply-run', applyBody, Number(o.applyTimeoutMs) || 20 * 60 * 1000);
        res.writeHead(applyResp.status || (applyResp.ok ? 200 : 502), CORS);
        const startedRunId = applyResp.data && applyResp.data.runId || requestedRunId;
        res.end(JSON.stringify({ success: !!(applyResp.ok && (!applyResp.data || applyResp.data.success !== false)),
          runId: startedRunId,
          statusUrl: `/apply-runs/${encodeURIComponent(startedRunId)}`,
          eventsUrl: `/apply-runs/${encodeURIComponent(startedRunId)}/events`,
          reportUrl: '/export-apply-report',
          sourceOptions: sourceBody, applyOptions: applyBody,
          sourceHydration: sourceResp.data && sourceResp.data.report && sourceResp.data.report.modalityC
            ? sourceResp.data.report.modalityC.channelHydration || null : null,
          source: sourceResp.data, apply: applyResp.data }));
        console.log(`[PJA] /apply-all-internal: source=${o.source === false ? 'skipped' : 'done'} applyStatus=${applyResp.status}`);
      } catch (e) {
        console.error('[PJA] /apply-all-internal error:', e.message);
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
        const st = await getStorageFromExtension(['pja_profile', 'pja_prefs', 'pja_jobs', 'pja_ext_queue', 'pja_applied_log']);
        const { pjaCollectAppliedRecords, appliedIdentity } = require('./sourcing/dedupe');
        const applied = appliedIdentity(pjaCollectAppliedRecords(st));

        const { sourceAll } = require('./sourcing/source-run');
        const sourceList = o.autonomousApplyOnly === true
          ? (require('./sourcing/sources.json').sources || []).filter(src =>
            !REPORT_ONLY_COVERAGE_STRATEGIES.includes(String(src && src.ats || '').toLowerCase()))
          : undefined;
        let discoveryAdapters = null;
        if (o.autonomousApplyOnly === true) {
          const allDiscovery = require('./sourcing/adapters').DISCOVERY;
          discoveryAdapters = Object.fromEntries(Object.entries(allDiscovery)
            .filter(([name]) => !REPORT_ONLY_COVERAGE_STRATEGIES.includes(String(name).toLowerCase())));
        }
        const willing = /^(yes|true|1)$/i.test(String((st.pja_profile || {}).willingToRelocate || ''));
        const { prefs, targetLocation, targetRadiusMiles, locationStrictness, remotePolicy } = deriveTargetLocationOptions(o, st);
        const prefQueries = Array.isArray(prefs.searchTitles) ? prefs.searchTitles
          : String(prefs.searchTitles || '').split(/[\n,]+/);
        const familyQueries = Array.isArray(o.queryFamilies) ? o.queryFamilies
          .flatMap(family => Array.isArray(family && family.queries) ? family.queries : []) : [];
        const explicitQueries = Array.isArray(o.queries) && o.queries.length ? o.queries : familyQueries;
        const queryInputs = explicitQueries.length ? explicitQueries
          : [...prefQueries, ...SUPPORTED_ADJACENT_SEARCH_TITLES];
        const queries = queryInputs.length
          ? queryInputs
            .map(q => String(q || '').trim()).filter(Boolean)
          : [];
        const requiredChannels = Array.isArray(o.requiredChannels) ? o.requiredChannels
          .map(x => String(x || '').trim()).filter(Boolean) : [];
        const browserDiscovery = o.browserDiscovery === true
          ? await runBrowserDiscoveryQueries({ queries,
            targetLocation, targetRadiusMiles,
            maxQueries: o.browserDiscoveryMaxQueries != null ? Number(o.browserDiscoveryMaxQueries) : 20,
            maxPages: o.browserDiscoveryMaxPages != null ? Number(o.browserDiscoveryMaxPages) : 1,
            perQueryTimeoutMs: o.browserDiscoveryPerQueryTimeoutMs != null
              ? Number(o.browserDiscoveryPerQueryTimeoutMs) : 40000 }) : null;
        const browserScan = o.coverage === true && requiredChannels.some(c => /^(linkedin_easy_apply|indeed_apply)$/.test(c))
          ? await waitForBrowserChannelCoverage(requiredChannels.filter(c => /^(linkedin_easy_apply|indeed_apply)$/.test(c)), {
            queries,
            targetLocation,
            targetRadiusMiles,
            minPerChannel: o.coverageCount != null ? Number(o.coverageCount) || 1 : 1,
            timeoutMs: o.browserScanTimeoutMs != null ? Number(o.browserScanTimeoutMs) : 180000,
            maxAgeMs: o.maxBrowserAgeMs != null ? Number(o.maxBrowserAgeMs) : 48 * 60 * 60 * 1000,
          }) : null;
        const browserJobs = await getBrowserShortlistFromExtension(30000);
        const { store, report } = await sourceAll({ sources: sourceList, appliedIdentity: applied, target: o.target || 200,
          autonomousApplyOnly: o.autonomousApplyOnly === true,
          nationwideUS: willing && !/^hard$/i.test(String(locationStrictness || '')),
          queries: queries && queries.length ? queries : undefined,
          targetLocation,
          targetRadiusMiles,
          locationStrictness,
          remotePolicy,
          browserJobs,
          discoveryAdapters,
          maxBrowserAgeMs: o.maxBrowserAgeMs != null ? Number(o.maxBrowserAgeMs) : 48 * 60 * 60 * 1000 });
        if (browserScan) report.browserScan = browserScan;
        if (browserDiscovery) report.browserDiscovery = browserDiscovery;

        let wrote = 0;
        if (write) {
          const imported = await wsAsk('importCorpus', { index: store.index, state: store.state,
            // Only retire records absent from this run when the fresh corpus itself passed its
            // supply/quality gate; a transient partial run must not wipe healthy prior coverage.
            replaceMissing: report.gate.pass || (o.autonomousApplyOnly === true &&
              report.gate.atLeastTarget && report.gate.atLeast2Modalities && report.gate.hasDirectSource) }, 'importCorpusReply', 120000);
          if (!imported || imported.error || imported.ok === false) throw new Error('corpus import failed: ' + ((imported && imported.error) || 'no acknowledgement'));
          wrote = imported.imported != null ? imported.imported : Object.keys(store.index).length;
          report.import = {
            imported: wrote,
            added: Number(imported.added || 0),
            newlyHydrated: Number(imported.newlyHydrated || 0),
            descriptionUpdated: Number(imported.descriptionUpdated || 0),
            unchanged: Number(imported.unchanged || 0),
            preservedEvidence: Number(imported.preservedEvidence || 0),
            retired: Number(imported.retired || 0),
          };
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

  // Description-free evidence supply audit. The extension returns only its compact planning
  // projection; no profile values or job descriptions are serialized into the report.
  if (req.method === 'POST' && req.url === '/supply-audit') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const control = await getStorageFromExtension(['pja_profile', 'pja_prefs']);
        const targetFilter = deriveTargetLocationOptions(o, control);
        const corpus = await wsAsk('getSupplyAuditCorpus', {}, 'supplyAuditCorpusReply', 60000);
        if (corpus.error) throw new Error('getSupplyAuditCorpus: ' + corpus.error);
        const { summarizeSupply } = require('./sourcing/supply-audit');
        const hardLocation = /^hard$/i.test(String(targetFilter.locationStrictness || '')) &&
          (targetFilter.targetLocation.city || targetFilter.targetLocation.state || targetFilter.targetLocation.zip);
        const audit = summarizeSupply(corpus, {
          threshold: o.threshold != null ? Number(o.threshold) : 75,
          candidateFingerprint: runtimeCandidateFingerprint,
          queryFamilies: Array.isArray(o.queryFamilies) ? o.queryFamilies : [],
          isLocationEligible: hardLocation
            ? posting => isEligibleTargetLocation(posting.location, posting.remote, targetFilter)
            : () => true,
        });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, audit }));
      } catch (e) {
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
        const scoreCandidateLimit = o.scoreCandidateLimit != null ? Math.max(0, Number(o.scoreCandidateLimit) || 0)
          : applyAllAboveScore ? 0
            : Math.max(150, Math.min(300, Math.max(dailyTarget || 0, attemptCap || 0) * 3));
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
        const coverageMode = o.coverage === true || o.strategyCoverage === true ||
          /^(coverage|strategy_coverage|portal_coverage)$/i.test(String(o.mode || ''));
        const coverageCount = o.coverageCount != null ? Math.max(1, Number(o.coverageCount) || 1) : 1;
        const coverageBucketCount = Array.from(new Set([...requiredChannels, ...requiredStrategies]
          .map(x => String(x || '').trim().toLowerCase()).filter(Boolean))).length;
        const coverageAttemptCount = coverageBucketCount * coverageCount;
        if (coverageMode && attemptCap > 0 && attemptCap < coverageAttemptCount) {
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'coverage_config',
            error: 'coverage attemptCap is lower than requested coverage bucket count',
            attemptCap, coverageBucketCount, coverageCount, coverageAttemptCount, requiredChannels, requiredStrategies,
            next: 'raise attemptCap to at least the number of requested channels/strategies, or reduce coverage buckets' })); return;
        }
        if (coverageMode && !applyAllAboveScore && dailyTarget != null && dailyTarget < coverageAttemptCount) {
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'coverage_config',
            error: 'coverage targetConfirmed is lower than requested coverage bucket count',
            targetConfirmed: dailyTarget, coverageBucketCount, coverageCount, coverageAttemptCount, requiredChannels, requiredStrategies,
            next: 'raise targetConfirmed to at least the number of requested channels/strategies, or use all-above-score mode' })); return;
        }
        const timeZone = o.timeZone || 'America/Los_Angeles';
        const candidateStatus = await refreshRuntimeCandidateProfile();
        const Ledger = require('./application-ledger');
        const day = o.day || Ledger.dayKey(Date.now(), timeZone);
        const plannedRunId = safeReportId(o.runId || ('apply-' + Date.now()));
        const category = String(o.category || '').trim().toLowerCase();
        // Broad one-click runs keep the historical day-wide target. Category validation runs
        // deliberately own an independent target so completing one five-job batch cannot make
        // the next category appear already complete.
        const targetScope = category ? 'run' : 'day';
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
        const control = await getStorageFromExtension(['pja_ranked_apply', 'pja_application_ledger', 'pja_applied_log', 'pja_profile', 'pja_prefs', 'pja_resume_filename']);
        const targetFilter = deriveTargetLocationOptions(o, control);
        if (!dryRun && !o.force) {
          const run = control.pja_ranked_apply;
          if (run && run.status === 'applying') {
            res.writeHead(409, CORS); res.end(JSON.stringify({ error: 'an application run is already active',
              runId: run.runId, currentIndex: run.currentIndex, confirmed: run.confirmedCount || 0,
              remaining: run.remaining != null ? run.remaining : run.targetConfirmed })); return;
          }
        }
        const targetAudit = applicationAuditFromStorage(control, targetScope === 'run'
          ? { runId: plannedRunId, day: null, target: dailyTarget || 1 }
          : { day, timeZone, target: dailyTarget || 1 }).audit;
        const alreadyConfirmedToday = targetScope === 'day' ? targetAudit.counts.confirmed : 0;
        const remainingTarget = applyAllAboveScore ? null : targetAudit.remaining;
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
          atsAllow, channelAllow: Array.isArray(o.channelAllow) ? o.channelAllow : null,
          requireEvidence: !rescore && requireEvidence, maxGaps,
          retryDeferred: e2eSafe ? false : undefined,
          maxAttempts: e2eSafe ? 1 : undefined,
          candidateFingerprint: !rescore ? runtimeCandidateFingerprint : undefined,
          explainDrops: true, dropLimit: o.dropLimit != null ? o.dropLimit : 200 }, 'applySetReply', 60000);
        let jobs = (setResp && setResp.jobs) || [];
        let planningDrops = setResp.planningDrops ? JSON.parse(JSON.stringify(setResp.planningDrops)) : null;
        const planningDropLimit = o.dropLimit != null ? Math.max(0, Number(o.dropLimit) || 0) : 200;
        if (setResp.error) { res.writeHead(502, CORS); res.end(JSON.stringify({ error: 'getApplySet: ' + setResp.error })); return; }
        if (/^hard$/i.test(String(targetFilter.locationStrictness || '')) &&
            (targetFilter.targetLocation.city || targetFilter.targetLocation.state || targetFilter.targetLocation.zip)) {
          jobs = jobs.filter(j => {
            const ok = isEligibleTargetLocation(j.location, j.remote, targetFilter);
            if (!ok) planningDrops = appendPlanningDrop(planningDrops, j, 'outside_target_location', planningDropLimit);
            return ok;
          });
        }
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
          channelCoverage[channel] = { discovered: candidates.length, hydrated: 0, scored: 0, eligible: 0, qualified: 0, reserved: 0 };
        }
        const strategyKey = j => String(j && (j.strategy || j.ats) || 'generic').trim().toLowerCase() || 'generic';
        const strategyCoverage = {};
        for (const strategy of requiredStrategies) {
          const candidates = jobs.filter(j => strategyKey(j) === strategy);
          strategyCoverage[strategy] = { discovered: candidates.length, hydrated: 0, scored: 0, eligible: 0, qualified: 0, reserved: 0 };
        }

        // 2. Score every candidate whose evidence is not already valid for this exact JD. Apply-set
        // rows are compact: hydrate descriptions only for the jobs that actually need scoring, in
        // batches of ten, so a large real-job corpus never crosses the WS/storage boundary at once.
        if (rescore && jobs.length) {
          const { descriptionFingerprint } = require('./sourcing/jobstore');
          for (const channel of requiredChannels) channelCoverage[channel].hydrated = jobs.filter(j =>
            (j.channel || 'external') === channel && (j.descriptionReady || j.description) &&
            !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
          for (const strategy of requiredStrategies) strategyCoverage[strategy].hydrated = jobs.filter(j =>
            strategyKey(j) === strategy && (j.descriptionReady || j.description) &&
            !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
          jobs = jobs.filter(j => {
            const hydrated = (j.descriptionReady || j.description) &&
              !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''));
            if (!hydrated) planningDrops = appendPlanningDrop(planningDrops, j, 'rescore_missing_description', planningDropLimit);
            return hydrated;
          });
          jobs = ScoringFrontier.sortForScoring(jobs);
          const frontier = ScoringFrontier.partition(jobs,
            { limit: scoreCandidateLimit, candidateFingerprint: runtimeCandidateFingerprint });
          const { reusable, needsScore } = frontier;
          for (const j of frontier.deferred) {
            planningDrops = appendPlanningDrop(planningDrops, j, 'rescore_candidate_limit', planningDropLimit);
          }
          const scored = [];
          for (let offset = 0; offset < needsScore.length; offset += 10) {
            const stubs = needsScore.slice(offset, offset + 10);
            const detailResp = await wsAsk('getApplyDescriptions', { ids: stubs.map(j => j.id) },
              'applyDescriptionsReply', 30000);
            if (detailResp.error) {
              for (const j of stubs) planningDrops = appendPlanningDrop(planningDrops, j,
                'rescore_description_unavailable', planningDropLimit);
              continue;
            }
            const details = new Map((detailResp.jobs || []).map(row => [String(row && row.id || ''), row]));
            const hydrated = [];
            for (const stub of stubs) {
              const detail = details.get(String(stub.id));
              if (!detail || !detail.description || !detail.descriptionReady ||
                  /^(missing|stale|needs_description)$/i.test(String(detail.descriptionStatus || ''))) {
                planningDrops = appendPlanningDrop(planningDrops, stub, 'rescore_description_unavailable', planningDropLimit);
                continue;
              }
              hydrated.push({ ...stub, description: detail.description,
                descriptionStatus: detail.descriptionStatus || stub.descriptionStatus,
                postingDescriptionFingerprint: detail.descriptionFingerprint || stub.postingDescriptionFingerprint });
            }
            const batchScored = hydrated.length ? await scoreAll(hydrated, 1) : [];
            if (batchScored.length) {
              await wsAsk('updateScores', { scores: batchScored.map(j => {
                const fp = j.postingDescriptionFingerprint || descriptionFingerprint(j.description);
                return { id: j.id, fitScore: j.fitScore, descriptionFingerprint: fp,
                  candidateFingerprint: runtimeCandidateFingerprint,
                  evidenceFingerprint: `${fp}:${runtimeCandidateFingerprint}`,
                  matchEvidence: j.matchEvidence, gaps: j.gaps, conflicts: j.conflicts, confidence: j.confidence };
              }) }, 'updateScoresReply', 120000);
              // Do not retain description text beyond this scoring batch.
              scored.push(...batchScored.map(j => { const out = { ...j }; delete out.description; return out; }));
            }
          }
          const scoredPool = reusable.concat(scored);
          for (const channel of requiredChannels) channelCoverage[channel].scored = scoredPool.filter(j =>
            (j.channel || 'external') === channel && j.fitScore != null).length;
          for (const strategy of requiredStrategies) strategyCoverage[strategy].scored = scoredPool.filter(j =>
            strategyKey(j) === strategy && j.fitScore != null).length;
          const ranked = scoredPool
            .filter(j => {
              let reason = '';
              if (j.fitScore == null) reason = 'rescore_missing_fit_score';
              else if (j.fitScore < threshold) reason = 'rescore_below_threshold';
              else if (requireEvidence && !hasEnoughMatchEvidence(j)) reason = 'rescore_weak_match_evidence';
              else if (requireEvidence && (j.gaps || []).length > maxGaps) reason = 'rescore_too_many_match_gaps';
              else if (requireEvidence && (j.conflicts || []).length) reason = 'rescore_hard_match_conflict';
              else if (requireEvidence && !['high', 'medium'].includes(String(j.confidence || '').toLowerCase())) reason = 'rescore_low_score_confidence';
              if (reason) planningDrops = appendPlanningDrop(planningDrops, j, reason, planningDropLimit);
              return !reason;
            })
            .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
          for (const channel of requiredChannels) {
            const n = ranked.filter(j => (j.channel || 'external') === channel).length;
            channelCoverage[channel].eligible = n;
          }
          for (const strategy of requiredStrategies) {
            const n = ranked.filter(j => strategyKey(j) === strategy).length;
            strategyCoverage[strategy].eligible = n;
          }
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
            for (const j of ranked.filter(j => (j.channel || 'external') === channel).slice(0, coverageCount)) {
              pushSelected(j);
            }
          }
          for (const strategy of requiredStrategies) {
            for (const j of ranked.filter(j => strategyKey(j) === strategy).slice(0, coverageCount)) {
              pushSelected(j);
            }
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
          for (const channel of requiredChannels) {
            const n = jobs.filter(j => (j.channel || 'external') === channel).length;
            channelCoverage[channel].reserved = n;
            channelCoverage[channel].qualified = n;
          }
          for (const strategy of requiredStrategies) {
            const n = jobs.filter(j => strategyKey(j) === strategy).length;
            strategyCoverage[strategy].reserved = n;
            strategyCoverage[strategy].qualified = n;
          }
        } else {
          const ranked = jobs.slice().sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
          const perCo = {}, selected = [];
          const pushSelected = j => {
            if (!j || selected.some(x => x.id === j.id)) return false;
            const co = String(j.company || '').trim().toLowerCase();
            if (perCompanyCap > 0 && (perCo[co] || 0) >= perCompanyCap) return false;
            perCo[co] = (perCo[co] || 0) + 1;
            selected.push(j);
            return true;
          };
          for (const channel of requiredChannels) {
            for (const j of ranked.filter(j => (j.channel || 'external') === channel).slice(0, coverageCount)) {
              pushSelected(j);
            }
          }
          for (const strategy of requiredStrategies) {
            for (const j of ranked.filter(j => strategyKey(j) === strategy).slice(0, coverageCount)) {
              pushSelected(j);
            }
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
          for (const channel of requiredChannels) {
            channelCoverage[channel].hydrated = ranked.filter(j => (j.channel || 'external') === channel &&
              (j.descriptionReady || j.description) && !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
            channelCoverage[channel].scored = ranked.filter(j => (j.channel || 'external') === channel && j.fitScore != null).length;
            channelCoverage[channel].eligible = ranked.filter(j => (j.channel || 'external') === channel).length;
            channelCoverage[channel].reserved = jobs.filter(j => (j.channel || 'external') === channel).length;
            channelCoverage[channel].qualified = channelCoverage[channel].reserved;
          }
          for (const strategy of requiredStrategies) {
            strategyCoverage[strategy].hydrated = ranked.filter(j => strategyKey(j) === strategy &&
              (j.descriptionReady || j.description) && !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length;
            strategyCoverage[strategy].scored = ranked.filter(j => strategyKey(j) === strategy && j.fitScore != null).length;
            strategyCoverage[strategy].eligible = ranked.filter(j => strategyKey(j) === strategy).length;
            strategyCoverage[strategy].reserved = jobs.filter(j => strategyKey(j) === strategy).length;
            strategyCoverage[strategy].qualified = strategyCoverage[strategy].reserved;
          }
        }

        const uncoveredChannels = requiredChannels.filter(channel => (channelCoverage[channel].qualified || 0) < coverageCount);
        if (uncoveredChannels.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: 'channel_coverage_blocked', coverage: coverageMode, coverageCount, channelCoverage, strategyCoverage, storage: control });
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'channel_coverage',
            error: 'required channel coverage is not ready', uncoveredChannels, coverageCount, channelCoverage,
            planningDrops: planningDrops || null, report,
            next: 'hydrate missing browser leads, then rescore before starting an apply run' })); return;
        }
        const uncoveredStrategies = requiredStrategies.filter(strategy => (strategyCoverage[strategy].qualified || 0) < coverageCount);
        if (uncoveredStrategies.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: 'strategy_coverage_blocked', coverage: coverageMode, coverageCount, channelCoverage, strategyCoverage, storage: control });
          res.writeHead(409, CORS); res.end(JSON.stringify({ success: false, stage: 'strategy_coverage',
            error: 'required apply strategy coverage is not ready', uncoveredStrategies, coverageCount, strategyCoverage,
            planningDrops: planningDrops || null, report,
            next: 'source/hydrate at least one qualified real posting per required ATS strategy, then rescore before starting an apply run' })); return;
        }

        if (!jobs.length) {
          const report = writeApplyPlanningReport(planningDrops || null,
            { status: dryRun ? 'dry_run_nothing_eligible' : 'nothing_eligible',
              coverage: coverageMode, coverageCount, channelCoverage, strategyCoverage, storage: control });
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
        const runId = plannedRunId;
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
          if (o._ownedRunControl) {
            const ownershipStorage = await getStorageFromExtension(['pja_apply_run_control'], 8000);
            const ownership = ownershipStorage && ownershipStorage.pja_apply_run_control;
            if (!ApplyRunControl.ownsPlanning(ownership, runId)) {
              res.writeHead(409, CORS);
              res.end(JSON.stringify({ success: false, stage: 'run_ownership',
                error: 'planner no longer owns this run; refusing late queue installation', runId,
                observedRunId: ownership && ownership.runId || null,
                observedStatus: ownership && ownership.status || null }));
              return;
            }
          }
          const master = { schemaVersion: 2, status: 'applying', phase: 'dispatching', jobs: queueJobs, currentIndex: 0, inFlightIndex: null,
            results: { confirmed: [], failed: [], unverified: [], skipped: [] }, blockedChannels: [],
            runId, category, runMode, applyAllAboveScore, targetConfirmed: dailyTarget, dailyTarget, attemptCap, threshold,
            targetScope, day: targetScope === 'day' ? day : '', calendarDay: day, timeZone,
            confirmedCount: alreadyConfirmedToday, remaining: remainingTarget,
            stopBeforeSubmit, e2eSafe,
            workdayAttemptTimeoutMs: o.workdayAttemptTimeoutMs != null ? Math.max(30000, Number(o.workdayAttemptTimeoutMs) || 0) : undefined,
            planningDrops: planningDrops || null,
            coverage: coverageMode, coverageCount, channelCoverage, strategyCoverage,
            startedAt: plannedAt, updatedAt: plannedAt, lastTransitionAt: plannedAt };
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
          { status: 'dry_run_planned', jobs: queueJobs, coverage: coverageMode, coverageCount, channelCoverage, strategyCoverage, storage: control }) : null;
        res.end(JSON.stringify({ success: true, dryRun, planned: queueJobs.length,
          runMode, applyAllAboveScore, targetConfirmed: remainingTarget, dailyTarget,
          alreadyConfirmedToday, remainingTarget,
          day, timeZone, targetScope, category, assistedExcluded, includeAssisted, e2eSafe,
          reserveCount: applyAllAboveScore ? 0 : Math.max(0, queueJobs.length - remainingTarget), runId, byChannel,
          byStrategy, channelCoverage, strategyCoverage, coverage: coverageMode, coverageCount, corpusTotal: setResp.total,
          planningDrops: planningDrops || null, report,
          top: jobs.slice(0, previewLimit).map(j => ({ fit: j.fitScore, company: j.company, title: j.title,
            id: j.id, location: j.location || '', applyUrl: j.applyUrl || '', ats: j.ats || j.strategy, channel: j.channel || 'external', matchEvidence: j.matchEvidence || [],
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
        const canonicalFacts = [
          ['Address', [p.address, p.address2, p.city, p.state, p.zip, p.country].filter(Boolean).join(', ')],
          ['Preferred location', p.preferredLocation || p.locationPreference || p.currentLocation],
          ['US person/export-control', p.usPersonForExportControl],
          ['Citizenship', p.countryOfCitizenship || p.citizenship],
          ['GPA', p.gpa || p.undergraduateGpa],
          ['Gender', p.gender],
          ['Race', p.race],
          ['Ethnicity', p.ethnicity],
          ['EEO fallback', p.eeoFallback],
          ['Veteran', p.veteran],
          ['Disability', p.disability],
          ['Restrictive agreement', p.restrictiveAgreement],
          ['Federal work/relatives', p.hasFederalWorkOrRelatives],
          ['Knows employees at target company', p.knowsEmployeesAtTargetCompany],
          ['Can contact current employer', p.mayContactCurrentEmployer],
          ['Consent privacy/background/SMS/email', [p.consentPrivacy, p.consentBackgroundCheck, p.consentSms, p.consentEmail].filter(Boolean).join(' / ')],
          ['Silicon/PCBA test years', p.siliconTestExperienceYears],
          ['High-speed interface years', p.highSpeedInterfaceExperienceYears],
          ['Manufacturing tools years', p.manufacturingToolsExperienceYears],
          ['SolidWorks', p.solidworksExperience],
          ['CATIA', p.catiaExperience],
          ['GxP validation', p.gxpValidationExperience],
        ].filter(([, v]) => v != null && String(v).trim())
          .map(([k, v]) => `- ${k}: ${String(v).slice(0, 240)}`).join('\n') || '- No additional structured facts supplied';

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

STRUCTURED FACTS (storage-backed; never override these with guesses):
${canonicalFacts}

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
          if (q.canonicalKey) parts.push(`  Canonical key: ${q.canonicalKey}`);
          if (q.sensitive) parts.push('  Sensitive field: yes — use only supplied structured facts or configured fallback');
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
  console.log(`   Engine default    : ${PROCESS_AI_ENGINE} CLI (profile/prefs may override)`);
  if (PROCESS_AI_ENGINE === 'codex') {
    console.log(`   Codex scoring     : ${codexModel() || 'configured default'} / ${codexReasoningEffort()} reasoning`);
  }
  console.log(`   Hot-reload        : curl -X POST http://localhost:${PORT}/reload`);
  console.log(`   Stop              : Ctrl+C\n`);
});
