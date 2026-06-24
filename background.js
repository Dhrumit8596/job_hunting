'use strict';

// ── Dev mode ──────────────────────────────────────────────────────────────────
// Set DEV_MODE = true to route all analysis through the local dev server.
// Run: node dev-server.js   (uses your ANTHROPIC_API_KEY env var)
// Nano (SLM) is disabled when DEV_MODE is true.
const DEV_MODE = true;
const DEV_SERVER = 'http://localhost:6174';

// Expose DEV_MODE to content scripts via storage so they can show the right loading message
chrome.storage.local.set({ pja_dev_mode: DEV_MODE });

// Seed known answers into pja_answers on startup (won't overwrite existing values)
chrome.storage.local.get('pja_answers', r => {
  const answers = r.pja_answers || {};
  const now = Date.now();
  const seeds = {
    'contact phone type':        { rawLabel: 'contact phone type',        answer: 'Mobile',        savedAt: now, usedCount: 0 },
    'country/region of residence': { rawLabel: 'country/region of residence', answer: 'United States', savedAt: now, usedCount: 0 },
    'phone type':                { rawLabel: 'phone type',                answer: 'Mobile',        savedAt: now, usedCount: 0 },
  };
  let changed = false;
  for (const [k, v] of Object.entries(seeds)) {
    if (!answers[k]) { answers[k] = v; changed = true; }
  }
  if (changed) chrome.storage.local.set({ pja_answers: answers });
});

// ── Dev hot-reload: WebSocket connection to dev-server ────────────────────
// In DEV_MODE, background.js connects to ws://localhost:6174.
// When dev-server receives POST /reload, it sends 'reload' over the socket
// and background.js calls chrome.runtime.reload() — reloading the whole extension.
// Pings every 20s keep the MV3 service worker alive while the socket is open.
if (DEV_MODE) {
  let _wsReloadSocket = null;
  let _wsReloadPingTimer = null;

  function connectReloadSocket() {
    try {
      _wsReloadSocket = new WebSocket('ws://localhost:6174');

      _wsReloadSocket.onopen = () => {
        console.log('PJA: hot-reload socket connected');
        // Ping every 20s to keep the MV3 service worker alive
        _wsReloadPingTimer = setInterval(() => {
          if (_wsReloadSocket && _wsReloadSocket.readyState === WebSocket.OPEN) {
            _wsReloadSocket.send('ping');
          }
        }, 20000);
      };

      _wsReloadSocket.onmessage = event => {
        if (event.data === 'reload') {
          console.log('PJA: reload signal received — reloading extension…');
          chrome.runtime.reload();
        } else if (event.data === 'inject') {
          injectContentScriptsIntoExistingTabs();
        } else if (event.data.startsWith('{')) {
          try {
            const msg = JSON.parse(event.data);
            if (msg.cmd === 'setStorage') {
              chrome.storage.local.set(msg.data, () => console.log('PJA: storage set via WS:', Object.keys(msg.data)));
            } else if (msg.cmd === 'getStorage') {
              chrome.storage.local.get(msg.keys, data => {
                _wsReloadSocket.send(JSON.stringify({ cmd: 'storageReply', reqId: msg.reqId, data }));
              });
            } else if (msg.cmd === 'openTab') {
              chrome.tabs.create({ url: msg.url });
            } else if (msg.cmd === 'startEasyApply') {
              // Backend-triggered Easy Apply: seed the EA queue into a fresh LinkedIn tab's
              // sessionStorage, then reload so content.js resumeApplyOnLoad runs the auto-apply
              // loop using the extension's OWN chrome.debugger trusted clicks. As long as no
              // external CDP client (claude-in-chrome) is attached to this tab, the trusted
              // clicks work. Monitor progress via /get-storage (pja_ea_lastresult / pja_applied_log).
              const eaJobs = Array.isArray(msg.jobs) ? msg.jobs : [];
              if (eaJobs.length) {
                chrome.storage.local.get(['pja_profile', 'pja_answers'], d => {
                  const queue = { status: 'applying', jobs: eaJobs, currentIndex: 0,
                    results: { applied: [], skipped: [], errors: [] },
                    profile: d.pja_profile || {}, answers: d.pja_answers || {} };
                  // Open the SEARCH page (currentJobId): its detail panel has a reliable Easy Apply
                  // <button> (the job-view control is a flaky <a> whose click navigates to a cold
                  // /apply/ page → Next reloads → loop). pjaFillForm is now scoped to the modal so
                  // it no longer pollutes the page search bar (which used to close the modal).
                  const firstUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true&currentJobId=' + eaJobs[0].jobId;
                  chrome.tabs.create({ url: firstUrl, active: true }, tab => {
                    const onUpd = (tid, info) => {
                      if (tid === tab.id && info.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(onUpd);
                        chrome.scripting.executeScript({
                          target: { tabId: tab.id },
                          func: q => { try { sessionStorage.setItem('pja_apply_queue', JSON.stringify(q)); location.reload(); } catch (e) {} },
                          args: [queue],
                        }).catch(() => {});
                      }
                    };
                    chrome.tabs.onUpdated.addListener(onUpd);
                  });
                });
              }
            } else if (msg.cmd === 'startScan') {
              // Backend-trigger the LinkedIn scanner on a search URL (sources EA candidates →
              // pja_shortlist). Opens the search, then runs window.__pjaStartScan() in the tab.
              const scanUrl = msg.url || 'https://www.linkedin.com/jobs/search/?f_AL=true&keywords=quality%20engineer&location=California';
              chrome.tabs.create({ url: scanUrl, active: true }, tab => {
                const onUpd = (tid, info) => {
                  if (tid === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onUpd);
                    setTimeout(() => {
                      chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (fast) => { if (typeof window.__pjaStartScan === 'function') window.__pjaStartScan({ fast }); },
                        args: [!!msg.fast],
                      }).catch(() => {});
                    }, 4000);
                  }
                };
                chrome.tabs.onUpdated.addListener(onUpd);
              });
            } else if (msg.cmd === 'cdpDateTest') {
              const dbgLog = [];
              const origLog = console.log.bind(console);
              cdpTypeDateSpinner(msg.tabId, msg)
                .then(() => {
                  chrome.storage.local.set({ pja_dbg_cdp: { ok: true, ts: Date.now() } });
                  origLog('PJA: cdpDateTest done');
                })
                .catch(e => {
                  chrome.storage.local.set({ pja_dbg_cdp: { ok: false, err: e.message, ts: Date.now() } });
                  origLog('PJA: cdpDateTest error:', e.message);
                });
            }
          } catch(e) {}
        }
      };

      _wsReloadSocket.onclose = () => {
        clearInterval(_wsReloadPingTimer);
        _wsReloadSocket = null;
        // Retry after 3s in case the dev server restarts
        setTimeout(connectReloadSocket, 3000);
      };

      _wsReloadSocket.onerror = () => {
        // onclose fires after onerror, so retry is handled there
      };
    } catch (e) {
      // WebSocket not available or server not running — retry quietly
      setTimeout(connectReloadSocket, 3000);
    }
  }

  connectReloadSocket();
}

// ── Dev: re-inject content scripts into existing matching tabs on startup ─────
function injectContentScriptsIntoExistingTabs() {
  const allScripts = [
    'content/extractors/linkedin.js',
    'content/extractors/indeed.js',
    'content/extractors/glassdoor.js',
    'content/extractors/generic.js',
    'content/autofill.js',
    'content/auto-apply.js',
    'content/external-apply.js',
    'content/job-scraper.js',
    'content/content.js'
  ];
  const targetUrls = [
    '*://*.linkedin.com/*', '*://*.indeed.com/*', '*://*.glassdoor.com/*',
    '*://*.greenhouse.io/*', '*://*.lever.co/*',
    '*://*.workday.com/*', '*://*.myworkdayjobs.com/*',
    '*://*.jobvite.com/*', '*://*.icims.com/*', '*://*.taleo.net/*',
    '*://*.bamboohr.com/*', '*://*.smartrecruiters.com/*', '*://*.ashbyhq.com/*'
  ];
  chrome.tabs.query({ url: targetUrls }, tabs => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: allScripts })
        .then(() => console.log('PJA: injected into tab', tab.id, tab.url))
        .catch(err => console.log('PJA: inject failed for tab', tab.id, err.message));
    }
  });
}

if (DEV_MODE) {
  // Auto-inject into existing tabs after extension reload
  injectContentScriptsIntoExistingTabs();
}

// ── Inject fiber-main.js in MAIN world on every ATS page load ─────────────────
// manifest "world":"MAIN" doesn't re-inject into already-open tabs after reload,
// and some Chrome versions may not support it. Use tabs.onUpdated as the reliable path.
const ATS_URL_PATTERNS = ['greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com',
  'jobvite.com', 'icims.com', 'ashbyhq.com', 'smartrecruiters.com', 'bamboohr.com',
  'rippling.com', 'localhost', '127.0.0.1'];

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !ATS_URL_PATTERNS.some(p => tab.url.includes(p))) return;
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content/fiber-main.js']
  }).then(() => {
    chrome.storage.local.set({ pja_fiber_inject_ok: { tabId, url: tab.url, ts: Date.now() } });
  }).catch(err => {
    chrome.storage.local.set({ pja_fiber_inject_err: { tabId, url: tab.url, err: String(err), ts: Date.now() } });
  });
});

// Note: autofill.js + external-apply.js are injected by manifest content_scripts (<all_urls>)
// on every page load — no need for programmatic injection via onUpdated.

// TOP-LEVEL: inject gmail-verify.js when Gmail tab opens during WD auth flow
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.includes('mail.google.com')) return;
  const { pja_wd_gmail_session: session } = await new Promise(r =>
    chrome.storage.local.get('pja_wd_gmail_session', r)
  );
  if (!session || session.gmailTabId !== tabId) return;
  if (Date.now() - session.startedAt > 180000) return;
  console.log('PJA bg: injecting gmail-verify.js into Gmail tab', tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/gmail-verify.js']
  }).catch(err => {
    console.error('PJA bg: gmail-verify injection failed', err);
    chrome.storage.local.set({
      pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'inject_failed', ts: Date.now() }
    });
    if (session.applyTabId) {
      chrome.tabs.sendMessage(session.applyTabId, { type: 'WD_VERIFY_COMPLETE', success: false }).catch(() => {});
    }
    chrome.storage.local.remove('pja_wd_gmail_session');
  });
});

// ── Generic analyzer prompt (Nano fallback). The candidate-specific scoring prompt is
// configured in dev-server.js via candidate.local.txt; this dormant fallback ships no PII.
const SYSTEM_PROMPT = `You are a job-fit analyzer. Using the candidate profile in the user
message, analyze the job posting and return ONLY valid JSON (no markdown) with this structure:
{
  "fitScore": <integer 0-100>,
  "matchedSkills": [<skills the candidate has that match the job>],
  "gaps": [<skills the job requires that the candidate lacks>],
  "recruiterTitle": "<suggested LinkedIn title to search for>",
  "dmMessage": "<LinkedIn DM under 280 chars>",
  "emailMessage": "<cold email, Subject: line first, under 500 chars>",
  "linkedinSearchQuery": "<exact LinkedIn search query string>"
}`;

// Nano prompt — ask only for a fit score integer (tiny output = fast + reliable)
const NANO_SYSTEM_PROMPT = `You score how well a candidate fits a job posting based on the candidate profile provided. Reply with a single integer 0-100. No other text.`;

// ── Skill groups ── [display label, ...synonyms] ── used for keyword gap detection ──
const CANDIDATE_SKILLS = [
  // Confirmed on resume
  ['Wafer Inspection', 'wafer inspection', 'wafer defect inspection', 'defect review', 'wafer metrology', 'in-line inspection', 'inline inspection', 'visual inspection'],
  ['Thin Film Metrology', 'thin film', 'thin film metrology', 'film thickness', 'film thickness measurement', 'thickness measurement'],
  ['Photolithography', 'photolithography', 'lithography', 'photo process', 'patterning', 'photomask', 'litho'],
  ['GMP', 'gmp', 'good manufacturing practice', 'cgmp', 'current good manufacturing practice', 'good manufacturing procedures'],
  ['SPC', 'spc', 'statistical process control', 'control charts', 'process capability', 'cp', 'cpk', 'spc chart'],
  ['Quality Management', 'quality management', 'quality assurance', 'quality control', 'qc', 'qa', 'qms', 'quality systems', 'quality standards'],
  ['Lean Six Sigma', 'lean six sigma', 'six sigma', 'lss', 'dmaic', 'lean manufacturing', 'lean principles'],
  ['5S Principles', '5s', 'five s', '5s principles', 'workplace organization', 'sort set shine standardize sustain'],
  ['Root Cause Analysis', 'root cause analysis', 'rca', 'root cause', 'corrective action', 'capa', 'problem solving'],
  ['Clean Room', 'clean room', 'cleanroom', 'iso 5', 'iso 6', 'iso 7', 'class 100', 'class 10000', 'controlled environment', 'clean room operations'],
  ['Defect Detection', 'defect detection', 'defect classification', 'defect analysis', 'defect management', 'defect review', 'yield loss', 'misprocessing'],
  ['EH&S', 'ehs', 'eh&s', 'environmental health safety', 'health and safety', 'safety compliance', 'sds', 'hazardous chemical', 'safety data sheet'],
  ['Data Management', 'data management', 'data analysis', 'data reporting', 'data entry', 'documentation', 'reporting'],
  ['Yield Improvement', 'yield improvement', 'yield enhancement', 'yield', 'bottleneck reduction', 'throughput improvement'],

  // Industry-context matches (not explicit skills but relevant to her work)
  ['Semiconductor Manufacturing', 'semiconductor', 'wafer fab', 'fab', 'wafer fabrication', 'semiconductor manufacturing', 'chip manufacturing'],
  ['Medical Device Manufacturing', 'medical device', 'medtech', 'in vitro diagnostics', 'ivd', 'point of care'],
  ['Metrology', 'metrology', 'measurement systems', 'msa', 'gauge r&r', 'gage r&r', 'measurement systems analysis'],
  ['KLA Tools', 'kla', 'kla-tencor', 'surfscan', 'brightfield inspection', 'darkfield inspection'],
  ['Process Control', 'process control', 'process stability', 'process integrity', 'in-process control', 'ipc']
];

// Broader tech keywords to detect gaps (skills mentioned in JDs that the candidate lacks)
const TECH_KEYWORDS = [
  'python', 'r scripting', 'data science', 'machine learning', 'ml', 'deep learning',
  'euv', 'extreme ultraviolet', 'euv lithography',
  'pecvd', 'lpcvd', 'cvd', 'ald', 'atomic layer deposition', 'chemical vapor deposition',
  'cmp', 'chemical mechanical planarization', 'chemical mechanical polishing',
  'etch', 'dry etch', 'wet etch', 'plasma etch', 'reactive ion etch', 'rie',
  'deposition', 'pvd', 'physical vapor deposition', 'sputter',
  'electrochemistry', 'electroplating', 'electrodeposition',
  'implant', 'ion implantation',
  'diffusion', 'oxidation', 'annealing',
  'scatterometry', 'afm', 'atomic force microscope', 'tem', 'transmission electron',
  'defect ml', 'defect classification ml', 'automated defect classification', 'adc',
  'semiconductor equipment', 'tool maintenance', 'tool qualification',
  'design of experiments', 'doe',
  'jmp', 'minitab', 'statistical software',
  'sql', 'tableau', 'power bi',
  'cad', 'solidworks', 'autocad',
  'plc', 'scada', 'automation',
  'supply chain', 'vendor management',
  'iso 9001', 'as9100', 'iatf 16949',
  'gd&t', 'geometric dimensioning',
  'reliability engineering', 'mtbf', 'mttf',
  'yield improvement', 'yield enhancement',
  'fab', 'foundry', 'wafer fab',
  'opc', 'optical proximity correction',
  'reticle', 'mask inspection',
  'ebeam', 'electron beam', 'e-beam',
  'xrd', 'x-ray diffraction',
  'sims', 'secondary ion mass spectrometry',
  'edx', 'eds', 'energy dispersive',
  'raman', 'raman spectroscopy',
  'profilometry', 'surface roughness',
  'stress measurement', 'film stress',
  'mos', 'cmos', 'transistor',
  'dielectric', 'gate oxide',
  'interconnect', 'metallization',
  'packaging', 'die attach', 'wire bond',
  'failure analysis', 'root cause analysis',
  'corrective action', 'capa',
  'auditing', 'supplier audit',
  'validation', 'qualification', 'ivq', 'iq oq pq'
];

// ── Storage helpers ─────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('apiKey', r => resolve(r.apiKey || null));
  });
}

async function getJobs() {
  return new Promise(resolve => {
    chrome.storage.local.get('pja_jobs', r => resolve(r.pja_jobs || []));
  });
}

async function setJobs(jobs) {
  return new Promise(resolve => {
    chrome.storage.local.set({ pja_jobs: jobs }, resolve);
  });
}

// ── Tier 1: Check Gemini Nano availability ──────────────────────────────────
// Returns: 'available'|'readily' (ready) | 'downloading' | 'after-download' | 'no' | 'unavailable'
async function getNanoStatus() {
  try {
    // Chrome 131+: LanguageModel global (replaces ai.languageModel)
    if (typeof LanguageModel !== 'undefined') {
      return await LanguageModel.availability();
    }
    // Chrome 127-130: ai.languageModel (old API)
    const aiObj = typeof ai !== 'undefined' ? ai : (typeof self !== 'undefined' ? self.ai : null);
    if (!aiObj?.languageModel) return 'unavailable';
    const cap = await aiObj.languageModel.capabilities();
    return cap.available || 'unavailable';
  } catch (e) {
    console.warn('PJA: Nano status check:', e?.message);
    return 'unavailable';
  }
}

// Chrome 148+ uses 'available'; older Chrome used 'readily'
function nanoIsReady(status) {
  return status === 'available' || status === 'readily';
}

function isNanoAvailable() {
  return getNanoStatus().then(nanoIsReady);
}

// ── Tier 1: Gemini Nano analysis ────────────────────────────────────────────
// Nano produces only a fit score integer; template fills skills/gaps/outreach.
async function analyzeWithNano({ title, company, description }) {
  const userContent = `Job: ${title || 'Unknown'} at ${company || 'Unknown'}.\n${(description || '').slice(0, 2000)}\nFit score 0-100:`;

  let session;
  if (typeof LanguageModel !== 'undefined') {
    session = await LanguageModel.create({ systemPrompt: NANO_SYSTEM_PROMPT, temperature: 0.1, topK: 3 });
  } else {
    const aiObj = typeof ai !== 'undefined' ? ai : self.ai;
    session = await aiObj.languageModel.create({ systemPrompt: NANO_SYSTEM_PROMPT });
  }

  try {
    const result = await session.prompt(userContent);
    session.destroy();

    const fitScore = parseNanoScore(result);
    if (fitScore === null) throw new Error('Could not parse score from: ' + result.slice(0, 60));

    // Merge AI score with template's skills/gaps/outreach
    const template = getTemplateAnalysis(title, company, description);
    const data = { ...template, fitScore, engine: 'nano' };
    return { success: true, data, engine: 'nano' };
  } catch (e) {
    try { session.destroy(); } catch {}
    throw e;
  }
}

function parseNanoScore(raw) {
  const text = (raw || '').trim();
  // Extract first number found
  const match = text.match(/\d+(\.\d+)?/);
  if (!match) return null;
  let n = parseFloat(match[0]);
  // Normalize: if decimal fraction (e.g. 0.87), convert to 0-100
  if (n > 0 && n <= 1) n = Math.round(n * 100);
  // Clamp to 0-100
  n = Math.max(0, Math.min(100, Math.round(n)));
  return n;
}


// ── Tier 3: Smart template + keyword matching ───────────────────────────────
function matchSkills(description) {
  const descLower = (description || '').toLowerCase();
  const matched = [];

  for (const group of CANDIDATE_SKILLS) {
    const displayLabel = group[0]; // human-readable display name
    const synonyms = group.slice(1); // everything after index 0 is a synonym to match
    const isMatch = synonyms.some(synonym => {
      const escaped = synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[\\s,/\\-\\(])${escaped}(?:[\\s,/\\-\\)\\.]|$)`, 'i');
      return pattern.test(descLower) || descLower.includes(synonym.toLowerCase());
    });
    if (isMatch) matched.push(displayLabel);
  }

  return matched;
}

function inferGaps(description, matchedSkillGroups) {
  const descLower = (description || '').toLowerCase();
  const gaps = [];

  // Build a set of all synonyms for matched skills to exclude from gaps
  const matchedSynonyms = new Set();
  for (const group of CANDIDATE_SKILLS) {
    const displayLabel = group[0];
    if (matchedSkillGroups.includes(displayLabel)) {
      group.slice(1).forEach(s => matchedSynonyms.add(s.toLowerCase()));
    }
  }

  for (const keyword of TECH_KEYWORDS) {
    const kwLower = keyword.toLowerCase();
    // Skip if already covered by matched skills
    if (matchedSynonyms.has(kwLower)) continue;

    // Check if keyword appears in description
    const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[\\s,/\\-\\(])${escaped}(?:[\\s,/\\-\\)\\.]|$)`, 'i');
    if (pattern.test(descLower) || descLower.includes(kwLower)) {
      // Use a clean display name (capitalize first letter)
      const display = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      gaps.push(display);
    }
  }

  return gaps.slice(0, 8); // cap at 8 gaps to keep UI clean
}

function computeFitScore(matchedCount, gapCount) {
  return Math.min(95, Math.max(35, Math.round(
    (matchedCount / Math.max(1, matchedCount + gapCount)) * 100 * 1.1 + 15
  )));
}

function dedupeById(arr) {
  const seen = new Map();
  // Iterate in reverse so the first occurrence (oldest) wins when ids collide
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item?.id && !seen.has(item.id)) seen.set(item.id, item);
  }
  return Array.from(seen.values()).reverse();
}

function getTemplateAnalysis(title, company, description) {
  const matchedSkillGroups = matchSkills(description);
  const gaps = inferGaps(description, matchedSkillGroups);

  // matchedSkillGroups already contains display labels from CANDIDATE_SKILLS[n][0]
  const matchedSkills = matchedSkillGroups.length > 0
    ? matchedSkillGroups
    : [
        'Lean Six Sigma Green Belt',
        'SPC / Statistical Process Control',
        'GMP Compliance',
        'Clean Room Operations',
        'Thin Film Metrology',
        'Wafer Inspection',
        'FMEA & 8D Problem Solving'
      ];

  const fitScore = description
    ? computeFitScore(matchedSkillGroups.length, gaps.length)
    : Math.floor(Math.random() * 20) + 72; // 72–91 when no description

  const safeTitle = title || 'role';
  const safeCompany = company || 'your company';

  const dmMessage =
    `Hi [Name], I'm the candidate — Canadian citizen, TN Visa eligible (zero sponsorship). experienced engineer. Your ${safeTitle} at ${safeCompany} looks like a strong fit. Happy to connect!`;

  const emailMessage =
    `Subject: ${safeTitle} – TN Visa Eligible, No Sponsorship Needed\n\nHi [Name],\n\nI came across the ${safeTitle} at ${safeCompany} and wanted to reach out directly.\n\nKey highlight: I'm a Canadian citizen and TN Visa eligible — no H-1B sponsorship required, zero USCIS overhead for your team.\n\nI'm currently a Senior Inspection Metrology Tech at a medical-device employer, where I:\n• Led GMP-compliant quality programs across clean room and photolithography lines\n• Implemented SPC controls that reduced defect escapes by 18%\n• Maintained thin film metrology tools and wafer inspection systems\n• Hold a Lean Six Sigma Green Belt\n\nI believe my background aligns well with what ${safeCompany} is building. Happy to share my resume or jump on a 15-minute intro call.\n\nBest,\nthe candidate\n[LinkedIn URL] | [Phone]`;

  return {
    fitScore,
    matchedSkills,
    gaps: gaps.length > 0
      ? gaps
      : ['Python / data scripting', 'EUV lithography experience', 'Defect classification ML'],
    recruiterTitle: `Senior Technical Recruiter – Semiconductor at ${safeCompany}`,
    dmMessage,
    emailMessage,
    linkedinSearchQuery: `"${safeCompany}" recruiter semiconductor quality engineer site:linkedin.com`,
    engine: 'template'
  };
}

// Keep legacy name as alias for backward compatibility
function getMockAnalysis(title, company) {
  return getTemplateAnalysis(title, company, '');
}

// ── Claude API call ──────────────────────────────────────────────────────────
async function analyzeWithClaude({ title, company, description, url }, apiKey) {
  const userContent = `Please analyze this job posting for the candidate:

Job Title: ${title || 'Unknown'}
Company: ${company || 'Unknown'}
Job URL: ${url || ''}

Job Description:
${(description || '').slice(0, 6000)}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const json = await resp.json();
  const text = json.content?.[0]?.text || '';

  // Strip possible markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const data = JSON.parse(cleaned);
  data.engine = 'claude';
  return { success: true, data, engine: 'claude' };
}

// ── Dev server call ───────────────────────────────────────────────────────────
async function analyzeViaDevServer({ title, company, description }) {
  const resp = await fetch(`${DEV_SERVER}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, company, description })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Dev server error ${resp.status}`);
  }
  return resp.json(); // { success, data, engine }
}

// ── analyzeJob() ─────────────────────────────────────────────────────────────
async function analyzeJob({ title, company, description, url, useClaude = false }) {
  // ── Dev mode: call local server, skip Nano entirely ─────────────────────
  if (DEV_MODE) {
    try {
      const result = await analyzeViaDevServer({ title, company, description });
      if (result.success) return result;
      throw new Error(result.error || 'Dev server returned failure');
    } catch (e) {
      console.warn('PJA dev server unreachable:', e?.message);
      // Fall through to template so the extension still works if server is down
      const data = getTemplateAnalysis(title, company, description);
      return { success: true, data, engine: 'template', devServerDown: true };
    }
  }

  // ── Tier 1: Gemini Nano ─────────────────────────────────────────────────
  if (!useClaude) {
    const nanoStatus = await getNanoStatus().catch(() => 'unavailable');
    console.log('PJA Nano status:', nanoStatus);

    if (nanoIsReady(nanoStatus)) {
      try {
        const result = await analyzeWithNano({ title, company, description });
        if (result.success) {
          console.log('PJA: Nano succeeded, fitScore:', result.data?.fitScore);
          return result;
        }
      } catch (e) {
        console.warn('PJA: Nano failed:', e?.message);
        const apiKey = await getApiKey();
        const data = getTemplateAnalysis(title, company, description);
        return { success: true, data, engine: 'template', nanoFailed: true, nanoError: e?.message, offerClaude: !!apiKey };
      }
    } else {
      console.log('PJA: Nano not ready, status:', nanoStatus);
    }
  }

  // ── Tier 2: Claude — only when user opts in ─────────────────────────────
  const apiKey = await getApiKey();
  if (apiKey && useClaude) {
    try {
      return await analyzeWithClaude({ title, company, description, url }, apiKey);
    } catch (e) {
      console.warn('PJA: Claude failed:', e?.message);
      return { success: false, error: e?.message || 'Claude API failed' };
    }
  }

  // ── Tier 3: Smart Template ──────────────────────────────────────────────
  const data = getTemplateAnalysis(title, company, description);
  return { success: true, data, engine: 'template', offerClaude: !!apiKey };
}

// ── Reminder check ────────────────────────────────────────────────────────────
async function checkAndBadgeReminders() {
  const jobs = await getJobs();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const pending = jobs.filter(j =>
    j.status === 'Outreach Sent' &&
    !j.reminderDismissed &&
    j.statusUpdatedAt &&
    (now - j.statusUpdatedAt) >= sevenDays
  );

  const count = pending.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  return count;
}

// ── Alarm setup ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('reminderCheck', { periodInMinutes: 1440 });
  checkAndBadgeReminders();
});

chrome.runtime.onStartup.addListener(() => {
  checkAndBadgeReminders();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reminderCheck') checkAndBadgeReminders();
});

// ── Activate tab + window so CDP input events are delivered ────────────────
// ── CDP type-and-submit: re-type credentials via CDP insertText + click ─────
// Uses CDP Input.insertText to update React controlled inputs properly, then fires
// the button via Space key + mouse click. pjaSetNative may not update React state
// when Workday's form validation prevents the button from firing.
async function cdpTypeAndSubmit(tabId, { email, password, selector }) {
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  // Focus email field, select all, then insertText email
  const [r1] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector(
        'input[data-automation-id="email"], input[type=email], ' +
        'input[name*=email]:not([name=website]), input[id*=email]'
      );
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    }
  });
  if (r1?.result) {
    // Select all → delete → type email
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: email });
    await new Promise(r => setTimeout(r, 400));
  }

  // Focus password field, select all, then insertText password
  const [r2] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.querySelector('input[type=password]');
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    }
  });
  if (r2?.result) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: password });
    await new Promise(r => setTimeout(r, 400));
  }

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}

  // Now click the submit button (with click_filter suppression + Space + mouse)
  await cdpTrustedClick(tabId, selector || '[data-automation-id="signInSubmitButton"]');
}

async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 150));
  } catch (_) {}
}

// ── CDP trusted click (bypasses Workday's isTrusted check) ─────────────────
// Strategy: suppress click_filter via rapid interval + focus button + Space key (bypasses
// pointer hit-testing) + mouse click at coords. Dual approach maximises success rate.
async function cdpTrustedClick(tabId, selector) {
  await activateTab(tabId);

  // Start a 20ms interval that keeps click_filter hidden, focus button, get coords.
  // Also wire up event listeners to capture whether trusted events reach the button.
  const [scriptResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const suppress = () => document.querySelectorAll('[data-automation-id="click_filter"]').forEach(el => {
        el.style.pointerEvents = 'none';
        el.style.display = 'none';
      });
      suppress();
      if (window.__pjaCFInterval) clearInterval(window.__pjaCFInterval);
      window.__pjaCFInterval = setInterval(suppress, 20);
      const btn = document.querySelector(sel);
      if (!btn) return null;
      // Capture events arriving at the button for debugging
      window.__pjaBtnEvents = [];
      ['click','mousedown','mouseup','keydown','keyup','keypress'].forEach(evt => {
        btn.addEventListener(evt, e => {
          window.__pjaBtnEvents.push({ type: evt, isTrusted: e.isTrusted, key: e.key || null });
        }, { capture: true });
      });
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      btn.focus();
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      // What element is actually at these coordinates after suppression?
      const elAtPoint = document.elementFromPoint(cx, cy);
      const cfAtPoint = document.querySelectorAll('[data-automation-id="click_filter"]');
      const debug = {
        elAtPointTag: elAtPoint?.tagName,
        elAtPointId: elAtPoint?.getAttribute('data-automation-id') || elAtPoint?.id || null,
        elIsSame: elAtPoint === btn,
        cfCount: cfAtPoint.length,
        cfVisible: Array.from(cfAtPoint).map(el => ({
          display: getComputedStyle(el).display,
          pe: getComputedStyle(el).pointerEvents,
          z: getComputedStyle(el).zIndex
        })),
        activeElId: document.activeElement?.getAttribute('data-automation-id') || document.activeElement?.tagName,
        btnRect: { top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width), h: Math.round(rect.height) },
        viewportW: window.innerWidth, viewportH: window.innerHeight
      };
      chrome.storage.local.set({ pja_dbg_click_prep: debug });
      return { x: cx, y: cy };
    },
    args: [selector || '[data-automation-id="signInSubmitButton"]']
  });

  const coords = scriptResult?.result;
  if (!coords) throw new Error('Button not found for selector: ' + selector);
  const xr = Math.round(coords.x), yr = Math.round(coords.y);

  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  // Strategy A: CDP Space key on focused button — keyboard events bypass click_filter entirely
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 120));

  // Strategy B: mouse click at button coords (click_filter suppressed by interval)
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: xr, y: yr, button: 'none', buttons: 0, clickCount: 0, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 40));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 80));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1, modifiers: 0
  });

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}

  // Give DOM time to process events before reading back captured data
  await new Promise(r => setTimeout(r, 300));

  // Read captured button events + clean up
  const [evtResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__pjaCFInterval) { clearInterval(window.__pjaCFInterval); window.__pjaCFInterval = null; }
      const evts = window.__pjaBtnEvents || [];
      window.__pjaBtnEvents = [];
      return evts;
    }
  });
  const captured = evtResult?.result || [];
  // Save to storage so content script (and dev) can inspect
  await chrome.storage.local.set({ pja_dbg_btnevents: captured });
}

// ── CDP trusted click for LinkedIn Easy Apply step buttons ──────────────────
// LinkedIn checks event.isTrusted on Easy Apply step-advance clicks (Next/Review/
// Submit) and reloads the page on any synthetic click. A real CDP mouse click
// (isTrusted=true) advances the step. Unlike cdpTrustedClick (Workday), this sends
// ONLY a mouse click (no Space key) to avoid double-advancing, and has no click_filter
// logic. The Easy Apply modal is in regular DOM, so coordinates are directly hittable.
async function cdpLinkedInClick(tabId, x, y) {
  await activateTab(tabId);
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('no coords for LinkedIn click');
  const xr = Math.round(x), yr = Math.round(y);

  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: xr, y: yr, button: 'none', buttons: 0, clickCount: 0, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 40));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 70));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1, modifiers: 0
  });
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── CDP trusted type: click at coords to focus, then type text via real key events ──
// react-select async option lists (Greenhouse School/Discipline) only fetch options
// from genuine keystrokes; programmatic value-setting is ignored. This focuses the
// input with a trusted click, then inserts text char-by-char so the fetch fires.
async function cdpTypeAt(tabId, x, y, text) {
  await activateTab(tabId);
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('no coords for CDP type');
  const xr = Math.round(x), yr = Math.round(y);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
  // focus via trusted click
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: xr, y: yr, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: xr, y: yr, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise(r => setTimeout(r, 120));
  // type each char as keyDown(char)+keyUp via insertText (fires real input events)
  for (const ch of String(text)) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
    await new Promise(r => setTimeout(r, 70));
  }
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── CDP date spinner fill: types digits into Workday date spinbuttons ───────
// Workday spinbuttons require isTrusted keydown events — nativeSetter/InputEvent won't
// propagate to the form context. This uses CDP dispatchKeyEvent for each digit.
async function cdpTypeDateSpinner(tabId, { baseId, month, day, year }) {
  console.log('PJA cdpTypeDateSpinner start tabId=', tabId, 'baseId=', baseId);

  // Strategy 1: call date-picker prop directly via React fiber traversal in MAIN world.
  // Searches from multiple DOM anchors in both up (return chain) and down (child chain) directions
  // to handle different Workday tenant build structures.
  const [s1] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (month, day, year) => {
      const propNames = ['onDatePicked', 'onDateSelected', 'onDateChange', 'handleDatePicked', 'handleDateChange'];
      const startSelectors = [
        '[data-automation-id="dateInputWrapper"]',
        '[data-automation-id="formField-dateSignedOn"]',
        '[role="spinbutton"][aria-label="Month"]',
        '[role="spinbutton"][aria-label="Year"]',
      ];
      for (const sel of startSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (!fiberKey) continue;
        for (const dir of ['up', 'down']) {
          let f = el[fiberKey];
          for (let i = 0; i < 30; i++) {
            if (!f) break;
            const props = f.memoizedProps || {};
            for (const propName of propNames) {
              if (typeof props[propName] === 'function') {
                try {
                  props[propName]({ year: parseInt(year), month: parseInt(month), day: parseInt(day) });
                  return { ok: true, depth: i, dir, propName, sel };
                } catch (e) {
                  return { ok: false, reason: 'threw: ' + e.message, propName, sel };
                }
              }
            }
            f = dir === 'up' ? f.return : f.child;
          }
        }
      }
      return { ok: false, reason: 'no date prop found' };
    },
    args: [month, day, year]
  });
  console.log('PJA cdpTypeDateSpinner strategy1:', JSON.stringify(s1?.result));

  // Always log strategy 1 result so it appears in pja_dbg (not just background console)
  await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
    const arr = (d.pja_dbg || []).slice(-19);
    arr.push('[cdp] date s1=' + JSON.stringify(s1?.result || null));
    chrome.storage.local.set({ pja_dbg: arr }, r);
  }));

  // After Strategy 1 (fiber call), always run Strategy 2 to type digits directly into the
  // spinbutton inputs. onDatePicked updates React state but doesn't update the spinbutton DOM
  // values — Workday's form validator reads the spinbutton DOM and will show "Errors Found"
  // even if React state is correct. Strategy 2 types digits to make the spinbutton values visible.

  // Strategy 2: focus spinbutton via MAIN world (so React onFocus fires) + CDP key events.
  // Tries display element ID first, falls back to input element ID, then aria-label.
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}

  const s2Results = [];
  async function typeIntoSpinner(displayId, inputId, ariaLabel, value, isYear) {
    const [focused] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (dId, iId, aria) => {
        const el = document.getElementById(dId) || document.getElementById(iId)
          || document.querySelector('[role="spinbutton"][aria-label="' + aria + '"]');
        if (!el) return { ok: false, tried: [dId, iId, 'aria:' + aria] };
        el.focus();
        el.click();
        return { ok: true, usedId: el.id || ('aria:' + aria) };
      },
      args: [displayId, inputId, ariaLabel]
    });
    if (!focused?.result?.ok) {
      console.log('PJA no element for', displayId, '/', inputId, '/', ariaLabel);
      s2Results.push(ariaLabel + ':notFound');
      return;
    }
    s2Results.push(ariaLabel + ':ok:' + focused.result.usedId.slice(-20));
    await new Promise(r => setTimeout(r, 150));

    const padded = String(value).padStart(isYear ? 4 : 2, '0');
    console.log('PJA typing padded=', padded, 'for', focused.result.usedId);
    for (const d of padded) {
      const kc = d.charCodeAt(0);
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: d, code: 'Digit' + d,
        windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 30));
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'char', key: d, text: d, unmodifiedText: d, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 30));
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: d, code: 'Digit' + d,
        windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: 0
      });
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 200));
  }

  await typeIntoSpinner(
    baseId + '-dateSectionMonth-display', baseId + '-dateSectionMonth-input', 'Month', month, false
  );
  await typeIntoSpinner(
    baseId + '-dateSectionDay-display', baseId + '-dateSectionDay-input', 'Day', day, false
  );
  await typeIntoSpinner(
    baseId + '-dateSectionYear-display', baseId + '-dateSectionYear-input', 'Year', year, true
  );

  // Tab out of the year field to trigger Workday's blur/commit handler
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 300));

  // Log strategy 2 results to pja_dbg
  await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
    const arr = (d.pja_dbg || []).slice(-19);
    arr.push('[cdp] date s2=' + s2Results.join(' '));
    chrome.storage.local.set({ pja_dbg: arr }, r);
  }));

  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── CDP trusted Enter key (alternative to click for form submission) ────────
async function cdpEnterKey(tabId) {
  await activateTab(tabId);
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0
  });
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WORKDAY_TRUSTED_CLICK') {
    cdpTrustedClick(_sender.tab.id, msg.selector)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CDP_TYPE_AT') {
    cdpTypeAt(_sender.tab.id, msg.x, msg.y, msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'LINKEDIN_TRUSTED_CLICK') {
    cdpLinkedInClick(_sender.tab.id, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push(new Date().toISOString().slice(11,19)+' [EA] CDP_ERROR: '+(e.message||e)); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (msg.type === 'WORKDAY_OPEN_COMBOBOX') {
    // Focus the element then send ArrowDown — standard ARIA way to open a combobox dropdown.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (sel) => {
            const el = document.querySelector(sel);
            if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
            return !!el;
          }, args: [msg.selector]
        });
        await new Promise(r => setTimeout(r, 150));
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        // ArrowDown opens the dropdown per ARIA combobox spec
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0
        });
        await new Promise(r => setTimeout(r, 60));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0
        });
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: true });
      } catch(e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_TYPEAHEAD_SELECT') {
    // Focus element, use CDP insertText to type text, wait for listbox, select first matching option.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);
        // Focus the input in MAIN world
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            return true;
          }, args: [msg.selector]
        });
        await new Promise(r => setTimeout(r, 200));
        // Clear existing value first
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 }); // Ctrl+A
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 });
        await new Promise(r => setTimeout(r, 50));
        // Insert the search text (first few chars to trigger autocomplete)
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: msg.text || 'No' });
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        sendResponse({ ok: true });
      } catch(e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_SET_SID') {
    // Approach: CDP Input.insertText (fires isTrusted=true beforeinput+input events).
    // Workday React ignores synthetic untrusted events. Input.insertText is the simplest
    // trusted path — no char-by-char loop, no nativeSetter side-effects.
    const tabId = _sender.tab.id;
    (async () => {
      try {
        await activateTab(tabId);

        // Step 1: Focus in MAIN world + clear DOM value via nativeSetter (no event dispatch).
        // pjaFillForm may have set a DOM value via nativeInputValueSetter (without updating React state).
        // Clearing via nativeSetter WITHOUT dispatching events means React doesn't see the clear and
        // won't re-render. CDP insertText then fires trusted events → React updates state cleanly.
        const [diagRes] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false, reason: 'no-el' };
            el.focus();
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            // Clear any pre-existing DOM value without dispatching events (avoids React re-render)
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, '');
            return { ok: true, valueBeforeType: el.value };
          },
          args: [msg.selector]
        });

        const diagInfo = diagRes?.result || {};
        if (!diagInfo.ok) { sendResponse({ ok: false, reason: diagInfo.reason || 'focus-failed', ...diagInfo }); return; }

        await new Promise(r => setTimeout(r, 100));

        // Step 2: insertText via CDP (isTrusted=true) — replaces the el.select() selection.
        // Fires trusted beforeinput + input events which React processes to update state.
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (_) {}
        const text = msg.text || 'No';
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
        await new Promise(r => setTimeout(r, 200));
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}

        // Step 3: Check value + click listbox option if one appeared (disability combobox path)
        await new Promise(r => setTimeout(r, 500));
        const [clickRes] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: (selector, sidLv) => {
            const el = document.querySelector(selector);
            const valAfter = el ? el.value : '?';
            const lb = document.querySelector('[data-automation-id="activeListContainer"]') ||
              document.querySelector('[role="listbox"]:not([hidden])') ||
              document.querySelector('[role="listbox"]');
            if (!lb) return { listbox: false, valAfter };
            const opts = Array.from(lb.querySelectorAll('[role="option"]'));
            const isNo = sidLv === 'no';
            let optMatch = opts.find(o => isNo ? /^no\b/i.test(o.textContent.trim()) : /^yes\b/i.test(o.textContent.trim()));
            if (!optMatch && isNo) optMatch = opts.find(o => /not have|do not|no.*disab/i.test(o.textContent));
            if (!optMatch && !isNo) optMatch = opts.find(o => /yes.*disab/i.test(o.textContent));
            if (!optMatch) optMatch = opts.find(o => /choose not|don.t wish|decline|prefer not/i.test(o.textContent));
            if (!optMatch) optMatch = opts[0];
            const clickTgt = optMatch ? (optMatch.querySelector('[data-automation-id="promptLeafNode"]') || optMatch) : null;
            if (clickTgt) { clickTgt.click(); return { listbox: true, lbOpts: opts.length, clicked: clickTgt.textContent.trim().slice(0,30), valAfter }; }
            return { listbox: true, lbOpts: opts.length, clicked: null, valAfter };
          },
          args: [msg.selector, text === 'Yes' ? 'yes' : 'no']
        });

        sendResponse({ ok: true, method: 'insertText', ...diagInfo, ...clickRes?.result });
      } catch(e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'WORKDAY_TRUSTED_ENTER') {
    cdpEnterKey(_sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_TYPE_AND_SUBMIT') {
    cdpTypeAndSubmit(_sender.tab.id, msg)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_TYPE_DATE') {
    const tabId = msg.tabId || _sender.tab?.id;
    cdpTypeDateSpinner(tabId, msg)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'WORKDAY_SUBMIT_FORM') {
    // Main-world form submit: uses nativeInputValueSetter so React/Formik state is properly updated.
    // formType: 'signin' | 'createaccount'
    (async () => {
      try {
        const tabId = _sender.tab.id;
        await activateTab(tabId);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (email, password, formType) => {
            return new Promise(resolve => {
              const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              // Suppress click_filter overlay
              const suppress = () => document.querySelectorAll('[data-automation-id="click_filter"]').forEach(el => {
                el.style.display = 'none'; el.style.pointerEvents = 'none';
              });
              suppress();
              if (window.__pjaCFInterval3) clearInterval(window.__pjaCFInterval3);
              window.__pjaCFInterval3 = setInterval(suppress, 20);

              const emailEl = document.querySelector('input[data-automation-id="email"], input[type=email]');
              const pwEls = Array.from(document.querySelectorAll('input[type=password]'));

              const setVal = (el, val) => {
                nativeSet.call(el, val);
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };

              if (formType === 'resetpassword') {
                // Only fill both password fields — no email
                if (!pwEls[0]) { resolve({ ok: false, reason: 'no_password_field' }); return; }
                setVal(pwEls[0], password);
                if (pwEls[1]) setVal(pwEls[1], password);
              } else if (formType === 'signin_email_step') {
                // Only fill email — no password
                if (!emailEl) { resolve({ ok: false, reason: 'no_email_field' }); return; }
                setVal(emailEl, email);
              } else {
                // signin and createaccount: fill email + password
                if (!emailEl) { resolve({ ok: false, reason: 'no_email_field' }); return; }
                setVal(emailEl, email);
                if (pwEls[0]) setVal(pwEls[0], password);
                if (formType === 'createaccount' && pwEls[1]) setVal(pwEls[1], password);

                if (formType === 'createaccount') {
                  const cb = document.querySelector(
                    'input[type=checkbox][data-automation-id="createAccountCheckbox"], ' +
                    'input[type=checkbox][required], input[type=checkbox][id*=terms], input[type=checkbox][name*=terms]'
                  );
                  if (cb && !cb.checked) cb.click();
                }
              }

              setTimeout(() => {
                if (window.__pjaCFInterval3) { clearInterval(window.__pjaCFInterval3); window.__pjaCFInterval3 = null; }

                // Workday wraps real buttons in click_filter divs (role=button, aria-label matches action).
                // The underlying <button> has aria-hidden=true and is non-interactive.
                // We must click the click_filter, not the hidden button.
                const cfLabelPattern = formType === 'createaccount' ? /create.{0,10}account/i
                  : formType === 'resetpassword' ? /change.*password|reset.*password/i
                  : formType === 'signin_email_step' ? /continue|next/i
                  : /sign.?in/i;
                const clickFilters = document.querySelectorAll('[data-automation-id="click_filter"]');
                const cfBtn = Array.from(clickFilters).find(el =>
                  cfLabelPattern.test(el.getAttribute('aria-label') || el.innerText || '')
                );
                if (cfBtn) {
                  cfBtn.style.display = '';
                  cfBtn.style.pointerEvents = '';
                  cfBtn.click();
                  resolve({ ok: true, emailVal: emailEl?.value, pwLen: pwEls[0]?.value?.length, via: 'click_filter' });
                  return;
                }

                // Fallback: click the underlying button directly
                const btnSel = formType === 'createaccount'
                  ? '[data-automation-id="createAccountSubmitButton"], button[type=submit]'
                  : formType === 'resetpassword'
                  ? '[data-automation-id="changePasswordSubmitButton"], button[type=submit]'
                  : formType === 'signin_email_step'
                  ? '[data-automation-id="continueButton"], [data-automation-id="next"], button[type=submit]'
                  : '[data-automation-id="signInSubmitButton"], button[type=submit]';
                const btn = document.querySelector(btnSel)
                  || Array.from(document.querySelectorAll('button[type=submit], button'))
                     .find(b => formType === 'createaccount'
                       ? /create.{0,10}account|register/i.test(b.textContent)
                       : formType === 'signin_email_step'
                       ? /continue|next/i.test(b.textContent.trim())
                       : /^sign.?in$/i.test(b.textContent.trim()));
                if (!btn) { resolve({ ok: false, reason: 'no_button' }); return; }
                btn.click();
                resolve({ ok: true, emailVal: emailEl?.value, pwLen: pwEls[0]?.value?.length, via: 'btn' });
              }, 400);
            });
          },
          args: [msg.email, msg.password, msg.formType || 'signin']
        });
        sendResponse({ ok: true, result: res?.result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'ANALYZE_JOB') {
    analyzeJob({ ...msg.payload, useClaude: !!msg.useClaude }).then(sendResponse);
    return true;
  }

  if (msg.type === 'REFRESH_BADGE') {
    checkAndBadgeReminders().then(count => sendResponse({ count }));
    return true;
  }

  if (msg.type === 'SAVE_JOB') {
    getJobs().then(jobs => {
      const existing = jobs.findIndex(j => j.id === msg.payload.id);
      if (existing >= 0) {
        jobs[existing] = msg.payload;
      } else {
        jobs.unshift(msg.payload);
      }
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'UPDATE_JOB_CONTACT') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) job.contact = msg.contact;
      return setJobs(jobs);
    }).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'UPDATE_JOB_STATUS') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) {
        job.status = msg.status;
        job.statusUpdatedAt = Date.now();
        job.reminderDismissed = false;
      }
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'DELETE_JOB') {
    getJobs().then(jobs => {
      return setJobs(jobs.filter(j => j.id !== msg.jobId));
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'DISMISS_REMINDER') {
    getJobs().then(jobs => {
      const job = jobs.find(j => j.id === msg.jobId);
      if (job) job.reminderDismissed = true;
      return setJobs(jobs);
    }).then(() => {
      checkAndBadgeReminders();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'GET_JOBS') {
    getJobs().then(jobs => sendResponse({ jobs }));
    return true;
  }

  if (msg.type === 'GET_PROFILE') {
    chrome.storage.local.get(['pja_profile', 'appMode'], r => {
      const defaults = {
        salutation: 'Mrs', firstName: 'the candidate', middleName: '',
        lastName: '', fullName: 'the candidate',
        email: '', phone: '', linkedin: '', website: '',
        address: '', address2: '',
        city: 'Santa Clara', state: 'CA', zip: '', country: 'United States',
        currentTitle: 'Senior Inspection Metrology Technician',
        currentCompany: 'a medical-device employer',
        yearsExperience: '6', university: '', degree: '', major: '',
        graduationYear: '', salaryExpectation: '',
        workAuth: 'Yes', requireSponsorship: 'No', visaStatus: 'TN Visa',
        willingToRelocate: 'Yes', referralSource: 'LinkedIn',
        gender: '', ethnicity: '',
        veteran: 'I Am Not A Protected Veteran',
        disability: 'No, I Do Not Have A Disability'
      };
      // Merge: stored non-empty values win; stored empty/null strings fall back
      // to the non-empty default. Also validate known enum fields — if a stored
      // value doesn't match the expected set (e.g. a UUID got saved accidentally)
      // fall back to the default rather than passing garbage to autofill.
      const YES_NO_FIELDS = new Set(['workAuth','requireSponsorship','willingToRelocate']);
      const YES_NO_VALUES = new Set(['yes','no','true','false','1','0']);
      const stored = r.pja_profile || {};
      const profile = Object.assign({}, defaults);
      for (const [k, v] of Object.entries(stored)) {
        if (v === '' || v == null) continue; // keep default
        if (YES_NO_FIELDS.has(k) && !YES_NO_VALUES.has(String(v).toLowerCase().trim())) continue; // corrupt enum value, keep default
        profile[k] = v;
      }
      sendResponse({ profile, appMode: !!r.appMode });
    });
    return true;
  }

  if (msg.type === 'SAVE_PROFILE') {
    chrome.storage.local.set({ pja_profile: msg.profile }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'SAVE_PROFILE_FIELD') {
    chrome.storage.local.get('pja_profile', r => {
      const profile = r.pja_profile || {};
      profile[msg.key] = msg.value;
      chrome.storage.local.set({ pja_profile: profile }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'SET_APP_MODE') {
    chrome.storage.local.set({ appMode: msg.enabled }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'GET_CONTACTS') {
    chrome.storage.local.get('pja_contacts', r => sendResponse({ contacts: r.pja_contacts || [] }));
    return true;
  }

  if (msg.type === 'SAVE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = r.pja_contacts || [];
      contacts.unshift(msg.contact);
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'UPDATE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = r.pja_contacts || [];
      const idx = contacts.findIndex(c => c.id === msg.contact.id);
      if (idx >= 0) contacts[idx] = msg.contact;
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_CONTACT') {
    chrome.storage.local.get('pja_contacts', r => {
      const contacts = (r.pja_contacts || []).filter(c => c.id !== msg.contactId);
      chrome.storage.local.set({ pja_contacts: contacts }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'GET_ANSWERS') {
    chrome.storage.local.get('pja_answers', r => sendResponse({ answers: r.pja_answers || {} }));
    return true;
  }

  if (msg.type === 'SAVE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      const existing = answers[msg.normalizedLabel];
      answers[msg.normalizedLabel] = {
        rawLabel: msg.rawLabel || msg.normalizedLabel,
        answer: msg.value,
        savedAt: Date.now(),
        usedCount: (existing?.usedCount || 0) + 1
      };
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      delete answers[msg.key];
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'UPDATE_ANSWER') {
    chrome.storage.local.get('pja_answers', r => {
      const answers = r.pja_answers || {};
      if (answers[msg.key]) answers[msg.key].answer = msg.value;
      chrome.storage.local.set({ pja_answers: answers }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'CLEAR_ANSWERS') {
    chrome.storage.local.remove('pja_answers', () => sendResponse({ success: true }));
    return true;
  }

  // ── External Apply ──────────────────────────────────────────────────────────
  if (msg.type === 'SET_EXT_CURRENT') {
    chrome.storage.local.set({ pja_ext_current: msg.payload }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'SET_EXT_QUEUE') {
    chrome.storage.local.set({ pja_ext_queue: msg.payload }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_EXT_QUEUE') {
    chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], r =>
      sendResponse({ queue: r.pja_ext_queue || null, current: r.pja_ext_current || null }));
    return true;
  }

  if (msg.type === 'GET_MISSING_QUESTIONS') {
    chrome.storage.local.get('pja_missing_questions', r => sendResponse({ questions: r.pja_missing_questions || {} }));
    return true;
  }

  if (msg.type === 'SAVE_MISSING_ANSWER') {
    chrome.storage.local.get(['pja_missing_questions', 'pja_answers'], r => {
      const store = r.pja_missing_questions || {};
      if (store[msg.key]) store[msg.key].answer = msg.answer;
      // Also sync into pja_answers so autofill answer bank can use it immediately
      const answers = r.pja_answers || {};
      answers[msg.key] = { rawLabel: msg.key, answer: msg.answer, savedAt: Date.now(), usedCount: 0 };
      chrome.storage.local.set({ pja_missing_questions: store, pja_answers: answers }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'CLEAR_MISSING_QUESTIONS') {
    chrome.storage.local.remove('pja_missing_questions', () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'LOG_MANUAL_OPEN') {
    chrome.storage.local.get(['pja_site_log', 'pja_custom_domains'], r => {
      const log = r.pja_site_log || [];
      const domain = msg.domain || '';
      const now = Date.now();
      const ONE_HOUR = 3600000;

      // Update site log
      const idx = log.findIndex(e => e.domain === domain);
      if (idx >= 0) {
        const entry = log[idx];
        if (now - (entry.lastSeen || 0) < ONE_HOUR) { sendResponse({ ok: true }); return; }
        entry.count = (entry.count || 1) + 1;
        entry.lastSeen = now;
        if (msg.title) entry.title = msg.title;
        entry.urls = [msg.url, ...(entry.urls || [])].slice(0, 5);
      } else {
        log.unshift({ domain, title: msg.title || domain, count: 1, firstSeen: now, lastSeen: now, urls: [msg.url] });
      }

      // Add to auto-trigger list (skip generic search/social domains)
      const SKIP = new Set(['google.com','www.google.com','bing.com','yahoo.com',
        'linkedin.com','www.linkedin.com','indeed.com','www.indeed.com',
        'glassdoor.com','www.glassdoor.com','facebook.com','twitter.com',
        'reddit.com','youtube.com','amazon.com']);
      const customs = r.pja_custom_domains || [];
      if (!SKIP.has(domain) && !customs.includes(domain)) customs.push(domain);

      chrome.storage.local.set({ pja_site_log: log.slice(0, 50), pja_custom_domains: customs },
        () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'GET_SITE_LOG') {
    chrome.storage.local.get('pja_site_log', r => sendResponse({ log: r.pja_site_log || [] }));
    return true;
  }

  if (msg.type === 'GET_CUSTOM_DOMAINS') {
    chrome.storage.local.get('pja_custom_domains', r => sendResponse({ domains: r.pja_custom_domains || [] }));
    return true;
  }

  if (msg.type === 'REMOVE_CUSTOM_DOMAIN') {
    chrome.storage.local.get('pja_custom_domains', r => {
      const domains = (r.pja_custom_domains || []).filter(d => d !== msg.domain);
      chrome.storage.local.set({ pja_custom_domains: domains }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'GET_TEMPLATES') {
    chrome.storage.local.get('pja_templates', r => sendResponse({ templates: r.pja_templates || [] }));
    return true;
  }

  if (msg.type === 'SAVE_TEMPLATE') {
    chrome.storage.local.get('pja_templates', r => {
      const templates = r.pja_templates || [];
      const idx = templates.findIndex(t => t.id === msg.template.id);
      if (idx >= 0) templates[idx] = msg.template;
      else templates.unshift(msg.template);
      chrome.storage.local.set({ pja_templates: templates }, () => sendResponse({ success: true }));
    });
    return true;
  }

  if (msg.type === 'DELETE_TEMPLATE') {
    chrome.storage.local.get('pja_templates', r => {
      const templates = (r.pja_templates || []).filter(t => t.id !== msg.templateId);
      chrome.storage.local.set({ pja_templates: templates }, () => sendResponse({ success: true }));
    });
    return true;
  }

  // ── Job shortlist / batch scoring ─────────────────────────────────────────
  if (msg.type === 'BATCH_SCORE_JOBS') {
    const jobs = msg.jobs || [];
    chrome.storage.local.get('pja_shortlist', async r => {
      const shortlist = r.pja_shortlist || [];

      // Keyword pre-filter (free — no Claude tokens)
      const SKILL_KW = ['spc','metrology','wafer','thin film','clean room','cleanroom','gmp',
        'iso 13485','fmea','lean six sigma','six sigma','photolithography','optical metrology',
        '8d','semiconductor','inspection','quality engineer','process engineer','metrology engineer',
        'manufacturing engineer','defect','fab','cvd','ald','etch','deposition','process control'];

      const candidates = jobs.filter(j => {
        if (shortlist.some(s => s.id === j.id)) return false; // already scored
        const txt = (j.title + ' ' + j.company + ' ' + j.description).toLowerCase();
        return SKILL_KW.some(k => txt.includes(k));
      });

      if (candidates.length === 0) { sendResponse({ success: true, added: 0 }); return; }

      // Add as 'scoring' placeholders — re-read storage right before writing to catch concurrent batches.
      // Capture the actually-added jobs (fresh) so the fetch only scores those.
      let toScore = [];
      await new Promise(res => {
        chrome.storage.local.get('pja_shortlist', latest => {
          const existing = latest.pja_shortlist || [];
          const existingIds = new Set(existing.map(j => j.id));
          const fresh = candidates.filter(j => !existingIds.has(j.id))
            .map(j => ({ ...j, status: 'scoring', fitScore: null }));
          toScore = fresh; // expose to outer scope
          if (fresh.length === 0) { res(); return; }
          // Deduplicate the full list by id (last write wins) before saving
          const merged = dedupeById([...existing, ...fresh]);
          chrome.storage.local.set({ pja_shortlist: merged }, res);
        });
      });

      // If concurrent batch already added everything, nothing left to score
      if (toScore.length === 0) { sendResponse({ success: true, added: 0 }); return; }

      // BUG5 fix: DEV_MODE guard — non-dev path uses analyzeJob (Nano/Claude/template).
      if (!DEV_MODE) {
        const results = await Promise.allSettled(toScore.map(j => analyzeJob(j)));
        chrome.storage.local.get('pja_shortlist', r2 => {
          const list = dedupeById(r2.pja_shortlist || []);
          const dataById = {};
          toScore.forEach((j, i) => {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value.success) dataById[j.id] = r.value.data;
          });
          const patched = list.map(j => {
            if (!dataById[j.id]) return j;
            const score = dataById[j.id].fitScore;
            return { ...j, fitScore: score, matchedSkills: dataById[j.id].matchedSkills || [], gaps: dataById[j.id].gaps || [], status: score >= 40 ? 'pending' : 'skipped' };
          });
          chrome.storage.local.set({ pja_shortlist: patched });
        });
        sendResponse({ success: true, added: toScore.length });
      } else {
        // DEV_MODE: batch score via dev server (10 jobs = 1 Claude call)
        try {
          const resp = await fetch(`${DEV_SERVER}/batch-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobs: toScore.map(j => ({ id: j.id, title: j.title, company: j.company, description: j.description })) })
          });
          const result = await resp.json();
          if (!result.success) throw new Error(result.error);

          // Apply scores back — only jobs scoring ≥ 40 become 'pending', rest get 'skipped'.
          // Threshold is 40 (not 50) so stretch roles like Quality Engineer (45–65 range) are kept.
          const scoreMap = {};
          (result.scores || []).forEach(s => { scoreMap[s.id] = s.score; });

          chrome.storage.local.get('pja_shortlist', r2 => {
            const list = dedupeById(r2.pja_shortlist || []);
            const patched = list.map(j => {
              if (!scoreMap.hasOwnProperty(j.id)) return j;
              const score = scoreMap[j.id];
              return { ...j, fitScore: score, status: score >= 40 ? 'pending' : 'skipped' };
            });
            chrome.storage.local.set({ pja_shortlist: patched });
          });

          sendResponse({ success: true, added: candidates.length });
        } catch (e) {
          // Dev server down — mark only the jobs we actually added (toScore) as pending.
          chrome.storage.local.get('pja_shortlist', r2 => {
            const list = r2.pja_shortlist || [];
            const toScoreIds = new Set(toScore.map(j => j.id));
            const patched = list.map(j =>
              toScoreIds.has(j.id) ? { ...j, status: 'pending', fitScore: null } : j
            );
            chrome.storage.local.set({ pja_shortlist: patched });
          });
          sendResponse({ success: true, added: toScore.length, warn: 'Dev server unreachable — scores pending' });
        }
      }
    });
    return true;
  }

  if (msg.type === 'GET_SHORTLIST') {
    chrome.storage.local.get('pja_shortlist', r => sendResponse({ jobs: r.pja_shortlist || [] }));
    return true;
  }

  if (msg.type === 'UPDATE_SHORTLIST_JOB') {
    chrome.storage.local.get('pja_shortlist', r => {
      const list = r.pja_shortlist || [];
      const idx = list.findIndex(j => j.id === msg.job.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...msg.job };
      else list.unshift(msg.job);
      chrome.storage.local.set({ pja_shortlist: list }, () => sendResponse({ success: true }));
    });
    return true;
  }

  // OPEN_TAB — extension pages (shortlist, popup) cannot call chrome.tabs.create directly;
  // they must message the background service worker which has the tabs permission.
  // ── ANSWER_QUESTIONS: route open-ended form questions to dev server ─────────
  // Called by autofill.js when it finds required text/textarea fields with
  // labels not in the profile or answer bank.
  // msg.payload = { questions: [{label, type, maxLength, options}], jobContext: {title,company} }
  if (msg.type === 'ANSWER_QUESTIONS') {
    (async () => {
      // Read profile + high-level prefs from storage once — used by both dev-server path and API fallback
      const profile = await new Promise(resolve =>
        chrome.storage.local.get('pja_profile', r => resolve(r.pja_profile || {}))
      );
      const prefs = await new Promise(resolve =>
        chrome.storage.local.get('pja_prefs', r => resolve(r.pja_prefs || {}))
      );

      // Helper: persist AI-generated answers into pja_answers bank
      function persistAnswers(answers) {
        if (!Array.isArray(answers) || answers.length === 0) return;
        chrome.storage.local.get('pja_answers', r => {
          const bank = r.pja_answers || {};
          const now = Date.now();
          for (const { label, answer } of answers) {
            if (!label || !answer) continue;
            const norm = label
              .toLowerCase()
              .replace(/[?!.,;:'"()\[\]]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 100);
            if (!bank[norm]) {
              bank[norm] = { rawLabel: label, answer, savedAt: now, usedCount: 0, source: 'ai' };
            }
          }
          chrome.storage.local.set({ pja_answers: bank });
        });
      }

      // ── Path 1: dev server ────────────────────────────────────────────────────
      if (DEV_MODE) {
        try {
          const resp = await fetch(`${DEV_SERVER}/answer-questions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...msg.payload, profile, prefs })
          });
          if (!resp.ok) throw new Error(`Dev server ${resp.status}`);
          const result = await resp.json();
          if (!result.success) throw new Error(result.error || 'answer-questions failed');
          persistAnswers(result.answers);
          sendResponse({ success: true, answers: result.answers });
          return;
        } catch (devErr) {
          console.warn('PJA: Dev server unavailable, falling back to API:', devErr.message);
          // Fall through to API fallback below
        }
      }

      // ── Path 2: direct Anthropic API fallback ────────────────────────────────
      try {
        const apiKey = await getApiKey();
        if (!apiKey) {
          sendResponse({ success: false, error: 'no ai available' });
          return;
        }

        const { questions, jobContext } = msg.payload;
        const jobTitle   = jobContext?.title   || 'Unknown Role';
        const jobCompany = jobContext?.company || 'Unknown Company';

        const p = profile || {};
        const fullName    = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'the candidate';
        const currentRole = [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ') || 'Senior Inspection Metrology Tech at a medical-device employer';
        const prevRole    = p.prevTitle && p.prevCompany
          ? `${p.prevTitle} at ${p.prevCompany}`
          : 'Operation Associate II at a medical-device employer (May 2022–Aug 2024)';
        const yearsExp    = p.yearsExperience || '6';
        const locationLine = [p.city, p.state].filter(Boolean).join(', ') || 'Santa Clara, CA';
        const visaLine    = p.visa || 'Canadian citizen, TN Visa (USMCA) — no sponsorship needed';
        const skillsLine  = p.skills || 'wafer inspection (~2,500/day), thin film metrology, photolithography, GMP, SPC, quality management, 5S, root cause analysis, EH&S, defect detection, yield improvement, clean room operations, data management, Lean Six Sigma White Belt';

        const ANSWER_SYSTEM_PROMPT =
`You are filling out a job application for ${fullName}.

PROFILE:
- Current: ${currentRole}
- Previous: ${prevRole}
- Total work experience: ${yearsExp} years; semiconductor/medtech quality/metrology experience: ~4 years
- Skills: ${skillsLine}
- Does NOT have (flag as aspirational or "actively learning" if asked): FMEA, 8D, ISO 13485, optical metrology, supplier audits, Python, CAD
- Visa: ${visaLine}
- Location: ${locationLine} (willing to relocate in Bay Area)

ANSWERING RULES:
1. Always write in first person ("I have…", "My experience includes…")
2. For "years of experience" questions: answer with the numeric value only (e.g. "6") unless it is a text field, in which case write one short sentence
3. For yes/no questions: answer with just "Yes" or "No" (with one brief reason if it is a textarea)
4. For "describe your experience" or knowledge questions: write 2–4 sentences, specific to ${fullName}'s actual resume, mentioning named tools/standards she actually used (SPC, GMP, KLA tools, photolithography, clean room). Do NOT claim skills she lacks.
5. For "are you open to / willing to" questions: answer "Yes" with a brief enthusiastic line
6. For contract/temp work questions: answer "Yes, I am open to contract and contract-to-hire opportunities"
7. Keep answers proportional to maxLength — if maxLength ≤ 100, use 1–2 sentences max; if ≤ 300, use 2–3 sentences; if > 300, up to 4 sentences
8. Do NOT include filler phrases like "Great question" or "I would like to say"
9. Return ONLY valid JSON — no markdown, no extra text`;

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
`Job: ${jobTitle} at ${jobCompany}

Answer each question below for the application. Return a JSON array with one object per question:
[{"label":"<exact question label>","answer":"<your answer>"},...]

Questions:
${questionList}`;

        const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1500,
            system: ANSWER_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });

        if (!apiResp.ok) {
          const err = await apiResp.json().catch(() => ({}));
          throw new Error(err.error?.message || `API error ${apiResp.status}`);
        }

        const json = await apiResp.json();
        const raw  = json.content?.[0]?.text || '';
        const start = raw.indexOf('[');
        const end   = raw.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('No JSON array in API response');
        const answers = JSON.parse(raw.slice(start, end + 1));

        persistAnswers(answers);
        sendResponse({ success: true, answers });
      } catch (e) {
        console.warn('PJA: ANSWER_QUESTIONS API fallback failed:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'OPEN_TAB') {
    chrome.tabs.create({ url: msg.url }, tab => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  // OPEN_APPLY_TAB — opens a job URL and optionally triggers autofill after load.
  // Used by the shortlist page which cannot call chrome.tabs.create directly.
  if (msg.type === 'OPEN_APPLY_TAB') {
    chrome.tabs.create({ url: msg.url }, tab => {
      if (msg.triggerAutofill) {
        // Use tabs.onUpdated instead of a fixed setTimeout so the autofill message
        // is sent only after the page has fully loaded, regardless of load time.
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.sendMessage(tab.id, { type: 'AUTOFILL_TRIGGER' }, () => {});
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      }
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  if (msg.type === 'FIND_OUTREACH_PEOPLE') {
    const job = msg.job;
    (async () => {
      try {
        if (!DEV_MODE) throw new Error('dev server disabled');
        // Generate DM + email via dev server (one Claude call)
        const resp = await fetch(`${DEV_SERVER}/outreach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: job.title, company: job.company, description: job.description, matchedSkills: job.matchedSkills })
        });
        const result = await resp.json();
        if (!result.success) throw new Error(result.error);

        // LinkedIn search URLs for recruiter + HM (no Claude needed — just construct URLs)
        const people = [
          { name: `Recruiter at ${job.company}`, title: 'Talent Acquisition / Recruiter', role: 'recruiter', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('recruiter ' + job.company)}&origin=GLOBAL_SEARCH_HEADER` },
          { name: `Hiring Manager at ${job.company}`, title: `${job.title} team lead`, role: 'hm', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('hiring manager ' + job.title + ' ' + job.company)}&origin=GLOBAL_SEARCH_HEADER` }
        ];

        sendResponse({ success: true, people, dmMessage: result.dmMessage, emailMessage: result.emailMessage });
      } catch (e) {
        // Fallback: use template analysis for messages
        const tmpl = getTemplateAnalysis(job.title, job.company, job.description);
        const people = [
          { name: `Recruiter at ${job.company}`, title: 'Talent Acquisition', role: 'recruiter', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('recruiter ' + job.company)}` },
          { name: `Hiring Manager at ${job.company}`, title: job.title + ' team', role: 'hm', url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('hiring manager ' + job.company)}` }
        ];
        sendResponse({ success: true, people, dmMessage: tmpl.dmMessage, emailMessage: tmpl.emailMessage });
      }
    })();
    return true;
  }

  // ── Inject fiber-main.js on demand ────────────────────────────────────────
  // Content script calls this if data-pja-fiber-main isn't set yet (race with onUpdated).
  if (msg.type === 'INJECT_FIBER_MAIN') {
    const tabId = _sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/fiber-main.js']
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'WD_OPEN_GMAIL_TAB') {
    (async () => {
      const { pja_wd_gmail_session: existing } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (existing && Date.now() - existing.startedAt < 120000) {
        sendResponse({ ok: false, reason: 'gmail_flow_in_progress' });
        return;
      }
      const applyTabId = _sender.tab?.id;
      // Use the configured Gmail account index (u/N) so we open the right inbox
      const { pja_gmail_account_index: gmailIdx } = await new Promise(r =>
        chrome.storage.local.get('pja_gmail_account_index', r)
      );
      const acctPath = `u/${gmailIdx ?? 3}`;
      const gmailUrl = `https://mail.google.com/mail/${acctPath}/#search/${encodeURIComponent(msg.searchQuery)}`;
      console.log('PJA bg: opening Gmail', gmailUrl);
      const tab = await new Promise(r => chrome.tabs.create({ url: gmailUrl }, r));
      // Store BEFORE tab loads — top-level onUpdated listener reads this
      await new Promise(r => chrome.storage.local.set({
        pja_wd_gmail_session: {
          gmailTabId: tab.id,
          applyTabId,
          hostname: msg.hostname,
          purpose: msg.purpose,
          acctPath,
          startedAt: Date.now()
        }
      }, r));
      sendResponse({ ok: true, gmailTabId: tab.id });
    })();
    return true;
  }

  if (msg.type === 'WD_GMAIL_FOUND_LINK') {
    (async () => {
      const gmailTabId = _sender.tab?.id;
      const verifyUrl = msg.verifyUrl;
      const { pja_wd_gmail_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (!session) { sendResponse({ ok: false, reason: 'no_session' }); return; }

      const verifyTab = await new Promise(r => chrome.tabs.create({ url: verifyUrl }, r));

      let verifyDone = false;
      const verifyTimeout = setTimeout(async () => {
        if (verifyDone) return;
        verifyDone = true;
        chrome.tabs.remove(verifyTab.id).catch(() => {});
        chrome.tabs.remove(gmailTabId).catch(() => {});
        await chrome.storage.local.set({
          pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'verify_tab_timeout', ts: Date.now() }
        });
        const { pja_wd_pending_apply: pending } = await new Promise(r =>
          chrome.storage.local.get('pja_wd_pending_apply', r)
        );
        if (pending?.applyUrl && session.applyTabId) {
          chrome.tabs.update(session.applyTabId, { url: pending.applyUrl }).catch(() => {});
        }
        chrome.storage.local.remove('pja_wd_gmail_session');
      }, 30000);

      const verifyListener = async (tid, changeInfo, tab) => {
        if (tid !== verifyTab.id || changeInfo.status !== 'complete') return;
        if (!tab.url) return;
        const isWorkdayDomain = /myworkdayjobs\.com|workday\.com/i.test(tab.url);
        if (!isWorkdayDomain) return;

        let pageText = '';
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: verifyTab.id },
            func: () => (document.body?.innerText || '').slice(0, 500)
          });
          pageText = res?.[0]?.result || '';
        } catch(e) {}

        // Check for expired link
        if (/link.*expired|token.*invalid|link.*no longer valid/i.test(pageText)) {
          if (verifyDone) return;
          verifyDone = true;
          clearTimeout(verifyTimeout);
          chrome.tabs.onUpdated.removeListener(verifyListener);
          chrome.tabs.remove(verifyTab.id).catch(() => {});
          chrome.tabs.remove(gmailTabId).catch(() => {});
          const { pja_workday_accounts: accounts } = await new Promise(r =>
            chrome.storage.local.get('pja_workday_accounts', r)
          );
          if (accounts?.[session.hostname]) {
            delete accounts[session.hostname];
            await chrome.storage.local.set({ pja_workday_accounts: accounts });
          }
          await chrome.storage.local.set({
            pja_wd_verify_result: { hostname: session.hostname, success: false, reason: 'link_expired', ts: Date.now() }
          });
          chrome.storage.local.remove('pja_wd_gmail_session');
          return;
        }

        // If this is a password reset form, fill it
        if (session.purpose === 'reset' &&
            /set.*new.*password|choose.*password|create.*password|new.*password/i.test(pageText)) {
          const { pja_job_password: pw } = await new Promise(r =>
            chrome.storage.local.get('pja_job_password', r)
          );
          if (pw) {
            chrome.scripting.executeScript({
              target: { tabId: verifyTab.id },
              world: 'MAIN',
              func: (password) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                const pwFields = document.querySelectorAll('input[type=password]');
                if (setter && pwFields[0]) {
                  setter.call(pwFields[0], password);
                  pwFields[0].dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
                if (setter && pwFields[1]) {
                  setter.call(pwFields[1], password);
                  pwFields[1].dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
                const btn = document.querySelector('[data-automation-id="changePasswordSubmitButton"]') ||
                  document.querySelector('button[type=submit]');
                if (btn) setTimeout(() => btn.click(), 500);
              },
              args: [pw]
            }).catch(() => {});
            return; // wait for next navigation after form submission
          }
        }

        // Success
        if (verifyDone) return;
        verifyDone = true;
        clearTimeout(verifyTimeout);
        chrome.tabs.onUpdated.removeListener(verifyListener);
        setTimeout(() => chrome.tabs.remove(verifyTab.id).catch(() => {}), 2000);
        chrome.tabs.remove(gmailTabId).catch(() => {});
        await chrome.storage.local.set({
          pja_wd_verify_result: { hostname: session.hostname, success: true, ts: Date.now() }
        });
        // Navigate apply tab back to applyUrl for a clean resume
        const { pja_wd_pending_apply: pending } = await new Promise(r =>
          chrome.storage.local.get('pja_wd_pending_apply', r)
        );
        if (pending?.applyUrl && session.applyTabId) {
          chrome.tabs.update(session.applyTabId, { url: pending.applyUrl }).catch(() => {});
        }
        chrome.storage.local.remove('pja_wd_gmail_session');
      };

      chrome.tabs.onUpdated.addListener(verifyListener);
      sendResponse({ ok: true, verifyTabId: verifyTab.id });
    })();
    return true;
  }

  if (msg.type === 'WD_GMAIL_NO_EMAIL_FOUND') {
    (async () => {
      const { pja_wd_gmail_session: session } = await new Promise(r =>
        chrome.storage.local.get('pja_wd_gmail_session', r)
      );
      if (!session) { sendResponse({ ok: false }); return; }
      const gmailTabId = _sender.tab?.id;
      if (gmailTabId) chrome.tabs.remove(gmailTabId).catch(() => {});
      await chrome.storage.local.set({
        pja_wd_verify_result: {
          hostname: session.hostname, success: false,
          reason: msg.reason || 'email_not_found', ts: Date.now()
        }
      });
      chrome.storage.local.remove('pja_wd_gmail_session');
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Main-world fill bridge ─────────────────────────────────────────────────
  // Content scripts run in the isolated world and cannot call execCommand or
  // access React fiber props directly on Formik/react-select inputs.
  // This handler runs a tiny inline function in the MAIN world via scripting API
  // so it can use execCommand (has real browser focus) and access __reactFiber$.
  if (msg.type === 'pja_main_world_fill') {
    const tabId = _sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return true; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (uid, value) => {
        const el = document.querySelector('[data-pja-fiber-id="' + uid + '"]');
        if (!el) return { ok: false, reason: 'no-el' };
        el.removeAttribute('data-pja-fiber-id');

        // Try execCommand first — works in MAIN world because browser focus is real here
        try {
          el.focus();
          if (el.value) el.setSelectionRange(0, el.value.length);
          const cmdOk = document.execCommand('insertText', false, String(value));
          if (cmdOk && el.value === String(value)) {
            el.setAttribute('data-pja-fiber-done', 'ok');
            return { ok: true, method: 'execCommand' };
          }
        } catch (_) {}

        // Fiber fallback — find Formik onChange in the React tree
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (!fk) {
          // No fiber: use native setter + synthetic events
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (desc && desc.set) desc.set.call(el, value); else el.value = value;
          } catch (_) { el.value = value; }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          el.setAttribute('data-pja-fiber-done', 'ok');
          return { ok: true, method: 'native-events' };
        }

        let f = el[fk], depth = 0, named = null, first = null;
        while (f && depth < 14) {
          const mp = f.memoizedProps;
          if (mp && typeof mp.onChange === 'function') {
            if (!first) first = mp;
            if (mp.name && !named) { named = mp; break; }
          }
          f = f.return; depth++;
        }
        const target = named || first;
        if (!target) return { ok: false, reason: 'no-fiber-handler' };

        const fieldName = target.name || el.name || el.id || '';
        try {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        } catch (_) { el.value = value; }
        try {
          target.onChange({
            target: { name: fieldName, value: String(value), type: el.type || 'text', id: el.id || '' },
            currentTarget: el,
            preventDefault: () => {},
            stopPropagation: () => {}
          });
        } catch (e) { return { ok: false, reason: 'onChange-threw: ' + e.message }; }
        el.setAttribute('data-pja-fiber-done', 'ok');
        return { ok: true, method: 'fiber' };
      },
      args: [msg.uid, String(msg.value !== undefined ? msg.value : '')]
    }).then(results => {
      const r = results && results[0] && results[0].result;
      sendResponse(r || { ok: false, reason: 'no-result' });
    }).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
