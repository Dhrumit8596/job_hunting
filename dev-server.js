#!/usr/bin/env node
'use strict';

/**
 * PJA Dev Server — routes extension analysis through local `claude` CLI
 * Uses your existing Claude Code subscription — zero extra API cost.
 *
 * Usage:
 *   node dev-server.js
 *
 * Requires: `claude` CLI to be installed and authenticated (claude login)
 *
 * Hot-reload:
 *   curl -X POST http://localhost:6174/reload
 *   (background.js connects via WebSocket and calls chrome.runtime.reload())
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = 6174;

// Connected extension background workers (WebSocket clients)
const wsClients = new Set();
let _lastQueueStatus = null;

// Candidate-specific analyzer prompt is loaded from candidate.local.txt (gitignored) so no
// personal profile data ships in the repo. Falls back to a generic prompt if absent.
const GENERIC_SYSTEM_PROMPT =
`You are a job-fit analyzer. Using the candidate profile supplied in the user message,
score how well the candidate matches the job posting. Return ONLY valid JSON, no markdown:
{"fitScore":<integer 0-100>,"tnEligible":<true|false>,"matchedSkills":[<skills the candidate has that match>],"gaps":[<skills the job requires that the candidate lacks>],"recruiterTitle":"<LinkedIn recruiter title>","dmMessage":"<DM under 280 chars>","emailMessage":"<Subject: line first, under 500 chars>","linkedinSearchQuery":"<search query>"}`;

const SYSTEM_PROMPT = (() => {
  try {
    const p = path.join(__dirname, 'candidate.local.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (_) {}
  return GENERIC_SYSTEM_PROMPT;
})();

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
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--print',
      '--system-prompt',       systemPrompt,
      '--output-format',       'json',
      '--no-session-persistence',
      '--model',               'haiku'
    ], { env: process.env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = fn => (...a) => { if (!settled) { settled = true; clearTimeout(timer); fn(...a); } };
    const ok = done(resolve), bad = done(reject);
    // Kill a hung CLI call so one stuck request can't stall a whole batch run.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} bad(new Error('claude CLI timeout')); }, timeoutMs);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', e => bad(new Error(`Cannot run claude CLI: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) bad(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      else {
        try { const env = JSON.parse(stdout.trim()); ok(env.result || stdout.trim()); }
        catch { ok(stdout.trim()); }
      }
    });
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

function runClaude(userPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--print',
      '--system-prompt',       SYSTEM_PROMPT,
      '--output-format',       'json',
      '--no-session-persistence',
      '--model',               'haiku'
    ], { env: process.env });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', e => reject(new Error(`Cannot run claude CLI: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      else {
        try {
          const envelope = JSON.parse(stdout.trim());
          resolve(envelope.result || stdout.trim());
        } catch {
          resolve(stdout.trim());
        }
      }
    });

    // Send prompt via stdin (handles long job descriptions safely)
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

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

// Push storage to the extension (returns count of clients written).
function setStorageToExtension(obj) {
  let pushed = 0;
  for (const c of wsClients) {
    if (c.readyState === 1) { c.send(JSON.stringify({ cmd: 'setStorage', data: obj })); pushed++; }
  }
  return pushed;
}

// Score one chunk (<=10) of jobs via the same prompt /batch-score uses.
const SCORE_SYSTEM_PROMPT = `You score job fit for the candidate, a Canadian moving to California on a TN visa. Her ACTUAL skills (from resume): wafer inspection (~2,500/day), thin film metrology, photolithography, defect detection, thickness measurement, cleanroom, yield improvement, GMP, SPC, quality management/control, 5S, root cause analysis, EH&S, SDS handling, data management. She has a B.E. (Environmental Engineering). She does NOT have: FMEA, 8D, ISO 13485, optical metrology, supplier audits, Python, CAD.
TN VISA RULE (critical): TN status is only for PROFESSIONAL roles (Engineer/Scientist + degree). Any Technician/Tech/Operator/Associate/Assembler/Supervisor/Manager/Coordinator/Lead title is NOT TN-eligible → score it 0-25 no matter how well skills match. Engineer/Scientist titles are eligible. No H-1B available; roles needing US citizenship/clearance → ≤30.
BEST FITS (TN-eligible, score 85-95): Wafer Inspection/Metrology/Yield/Defect/Process(-Integration) Engineer in semiconductor; Thin Film/Photolithography/CMP/Etch Process Engineer. Quality/Reliability/Equipment/Manufacturing Engineer (semi/medtech) 70-88. Deduct 10-15 per required gap (FMEA/8D/ISO13485/Python/CAD). Score 0-100. Return ONLY a JSON array [{id, score}]. No markdown, no explanation.`;

async function scoreJobChunk(batch) {
  const jobList = batch.map((j, i) => `Job ${i + 1}: "${j.title}" at "${j.company}" (${j.location})`).join('\n---\n');
  const prompt = `Score each job 0-100 for the candidate's fit. Return ONLY a JSON array, no other text:\n[{"id":"<job id>","score":<0-100>},...]\n\nJobs:\n${jobList}\n\nJob IDs (in order): ${batch.map(j => JSON.stringify(j.id)).join(', ')}`;
  const raw = await runClaudeWithSystemPrompt(SCORE_SYSTEM_PROMPT, prompt);
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1 || e === -1) return [];
  try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { return []; }
}

// Score all jobs in chunks of 10, with bounded concurrency. Resilient: a chunk that errors
// or times out leaves its jobs unscored (→ shortlist) instead of stalling the whole run.
async function scoreAll(jobs, concurrency = 4) {
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
      for (const s of scores) if (s && s.id != null) byId[String(s.id)] = Number(s.score);
      console.log(`[PJA] scored chunk ${++done}/${chunks.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length || 1) }, worker));
  const { tnAdjustScore } = require('./sourcing/filter');
  return jobs.map(j => {
    const raw = byId[String(j.id)] != null ? byId[String(j.id)] : null;
    return { ...j, fitScore: raw == null ? null : tnAdjustScore(j.title, raw) };
  });
}

// ── HTTP request handler ────────────────────────────────────────────────────
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, engine: 'claude-cli', clients: wsClients.size }));
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
  // body: { jobs: [{jobId, title, company}] }. Sends a WS command so background opens the first
  // job, seeds the EA queue, and the extension auto-applies via its OWN CDP (no claude-in-chrome).
  if (req.method === 'POST' && req.url === '/start-ea') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let jobs = [];
      try { jobs = (JSON.parse(body || '{}').jobs) || []; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startEasyApply', jobs })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed, queued: jobs.length }));
      console.log(`[PJA] /start-ea → ${jobs.length} jobs to ${pushed} client(s)`);
    });
    return;
  }

  // ── /start-scan: backend-trigger the LinkedIn scanner to source EA candidates → pja_shortlist ──
  if (req.method === 'POST' && req.url === '/start-scan') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let url = null;
      try { url = JSON.parse(body || '{}').url || null; } catch (_) {}
      let pushed = 0;
      for (const client of wsClients) {
        if (client.readyState === 1) { client.send(JSON.stringify({ cmd: 'startScan', url })); pushed++; }
      }
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, pushed }));
      console.log(`[PJA] /start-scan → ${pushed} client(s) url=${url || '(default)'}`);
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
        data.engine = 'claude-dev';

        console.log(`done (${Date.now() - t0}ms) score=${data.fitScore}`);
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ success: true, data, engine: 'claude-dev' }));
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

        const jobList = batch.map((j, i) =>
          `Job ${i + 1}: "${j.title}" at "${j.company}"\n${(j.description || '').slice(0, 800)}`
        ).join('\n---\n');

        const prompt =
`Score each job 0-100 for the candidate's fit. Return ONLY a JSON array, no other text:
[{"id":"<job id>","score":<0-100>},...]

Jobs:
${jobList}

Job IDs (in order): ${batch.map(j => JSON.stringify(j.id)).join(', ')}`;

        const batchPrompt = `You score job fit for the candidate, a Canadian moving to California on a TN visa. Her ACTUAL skills (from resume): wafer inspection (~2,500/day), thin film metrology, photolithography, defect detection, thickness measurement, cleanroom, yield improvement, GMP, SPC, quality management/control, 5S, root cause analysis, EH&S, SDS handling, data management. She has a B.E. (Environmental Engineering). She does NOT have: FMEA, 8D, ISO 13485, optical metrology, supplier audits, Python, CAD.
TN VISA RULE (critical): TN status is only for PROFESSIONAL roles (Engineer/Scientist + degree). Any Technician/Tech/Operator/Associate/Assembler/Supervisor/Manager/Coordinator/Lead title is NOT TN-eligible → score it 0-25 no matter how well skills match. Engineer/Scientist titles are eligible. No H-1B available; roles needing US citizenship/clearance → ≤30.
BEST FITS (TN-eligible, score 85-95): Wafer Inspection/Metrology/Yield/Defect/Process(-Integration) Engineer in semiconductor; Thin Film/Photolithography/CMP/Etch Process Engineer. Quality/Reliability Engineer (semi/medtech) 70-88. Deduct 10-15 per required gap (FMEA/8D/ISO13485/Python/CAD). Score 0-100. Return ONLY a JSON array [{id, score}]. No markdown, no explanation.`;

        const raw = await runClaudeWithSystemPrompt(batchPrompt, prompt);
        const start = raw.indexOf('[');
        const end   = raw.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('No JSON array in response: ' + raw.slice(0, 120));
        const scores = JSON.parse(raw.slice(start, end + 1));

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

  // ── /source: find roles across ATSes, fit-score, route to queue/shortlist ──
  // body: { threshold=70, queueLimit=0, write=true }
  //   queueLimit>0 → auto-queue that many top roles into pja_ext_queue (auto-submit).
  //   queueLimit=0 → only write the scored shortlist (review-first), no submission.
  if (req.method === 'POST' && req.url === '/source') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const o = body ? JSON.parse(body) : {};
        const threshold = o.threshold != null ? o.threshold : 70;
        const queueLimit = o.queueLimit || 0;
        const write = o.write !== false;
        const sources = (o.sources) || JSON.parse(fs.readFileSync(__dirname + '/sourcing/sources.json', 'utf8')).sources;

        // Dedupe against already-applied: durable applied log (survives queue overwrites) +
        // pja_jobs + current queue results.
        const st = await getStorageFromExtension(['pja_jobs', 'pja_ext_queue', 'pja_shortlist', 'pja_applied_log']);
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
            applyUrl: j.applyUrl, ats: j.ats, fitScore: j.fitScore, source: 'sourcing',
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
{"dmMessage":"<LinkedIn DM under 280 chars, open with Canadian TN Visa no sponsorship>","emailMessage":"<cold email, Subject: line first, TN Visa in first sentence, under 500 chars>","recruiterSearchUrl":"recruiter ${encodeURIComponent(company)}","hmSearchUrl":"hiring manager engineer ${encodeURIComponent(company)}"}`;

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

        // Build dynamic profile fields, falling back to hardcoded the candidate defaults
        const p = profile || {};
        const pf = prefs || {};
        const fa = (prefs && prefs.factual) || {};
        const fullName      = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'the candidate';
        const currentRole   = [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ') || 'Senior Inspection Metrology Tech at a medical-device employer';
        const prevRole      = p.prevTitle && p.prevCompany
          ? `${p.prevTitle} at ${p.prevCompany}`
          : 'Operation Associate II at a medical-device employer (May 2022–Aug 2024)';
        const yearsExp      = p.yearsExperience || '6';
        const locationLine  = [p.city, p.state].filter(Boolean).join(', ') || 'Santa Clara, CA';
        const visaLine      = p.visa || 'Canadian citizen, TN Visa (USMCA) — no sponsorship needed';
        const skillsLine    = p.skills || 'wafer inspection (~2,500/day), thin film metrology, photolithography, GMP, SPC, quality management, 5S, root cause analysis, EH&S, defect detection, yield improvement, clean room operations, data management, Lean Six Sigma White Belt';

        const ANSWER_SYSTEM_PROMPT =
`You are filling out a job application for ${fullName}.

PROFILE:
- Current: ${currentRole}
- Previous: ${prevRole}
- Total work experience: ${yearsExp} years; semiconductor/medtech quality/metrology experience: ~4 years
- Skills: ${skillsLine}
- Does NOT have (flag as aspirational or "actively learning" if asked): FMEA, 8D, ISO 13485, optical metrology, supplier audits, Python, CAD
- Visa: ${visaLine}
- Location: ${locationLine}

PREFERENCES (use these for preference/logistics questions):
- Compensation: ${pf.compensation || "answer 'competitive'/'negotiable'; do not give a low rate"}
- Work mode: ${pf.workMode || 'open to onsite or hybrid'}
- Relocation: ${pf.relocation || 'open to relocating'}
- Availability/start: ${pf.startDate || 'available with standard notice'}
- Consent stance: ${pf.screeningStance || 'consent to standard background/drug/data checks'}

FACTUAL ANSWERS (use these EXACTLY for the matching question — do not contradict them):
- Authorized to work in the US: ${fa.authorizedToWorkUS || 'Yes'}
- Requires visa sponsorship (H-1B/etc.): ${fa.requiresSponsorship || 'No'}
- Visa status: ${fa.visaStatus || 'TN visa (Canadian citizen)'}
- Is a US citizen or permanent resident: ${fa.usCitizenOrPermanentResident || 'No'}
- Is a "US person" for export-control/ITAR/EAR: ${fa.usPersonForExportControl || 'No'}
- 18 or older: ${fa.over18 || 'Yes'}
- Has security clearance: ${fa.securityClearance || 'No'}
- Veteran status: ${fa.veteranStatus || 'Not a protected veteran'}
- Disability: ${fa.disability || 'No'}
- Gender: ${fa.gender || 'Female'}
- Race/ethnicity: ${fa.ethnicity || 'Decline to self-identify'}
- Years of experience: ${fa.yearsExperience || yearsExp}
- HONEST GAPS: ${fa.honestGaps || 'Do NOT claim FMEA, 8D, ISO 13485, optical metrology, supplier audits, Python, or CAD — answer such requirements honestly (no / limited / willing to learn).'}

ANSWERING RULES:
1. First person ("I have…"). Be truthful — never claim a skill/credential ${fullName} lacks (see HONEST GAPS).
2. "Years of experience" → numeric only (e.g. "6") for short fields; one sentence for text fields.
3. Yes/No questions → exactly "Yes" or "No" (add one brief reason only in a textarea).
4. Work-authorization / sponsorship / citizenship / US-person / export-control / clearance / age / veteran / disability / gender / ethnicity → use the FACTUAL ANSWERS above verbatim in meaning.
5. Consent/agreement/certification questions (background check, drug test, data/GDPR, "I certify/agree/acknowledge") → answer affirmatively per the consent stance ("Yes"/"I agree"/"I certify").
6. Salary/compensation → follow the Compensation preference (range/"competitive"/"negotiable"); never output a low hourly rate.
7. "describe your experience"/knowledge → 2–4 sentences from her real resume (SPC, GMP, wafer inspection, metrology, photolithography, clean room). Do NOT invent.
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

        const raw = await runClaudeWithSystemPrompt(ANSWER_SYSTEM_PROMPT, userPrompt);
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
  console.log(`   Engine            : claude CLI (your subscription, no extra cost)`);
  console.log(`   Hot-reload        : curl -X POST http://localhost:${PORT}/reload`);
  console.log(`   Stop              : Ctrl+C\n`);
});
