'use strict';

// ── App Mode toggle ──────────────────────────────────────────────────────────
const modeToggle = document.getElementById('app-mode-toggle');
const modeStatus = document.getElementById('app-mode-status');

chrome.storage.local.get('appMode', r => {
  const enabled = r.appMode !== false;
  modeToggle.checked = enabled;
  updateModeStatus(enabled);
  if (r.appMode === undefined) chrome.storage.local.set({ appMode: true });
});

modeToggle.addEventListener('change', () => {
  const enabled = modeToggle.checked;
  chrome.storage.local.set({ appMode: enabled }, () => updateModeStatus(enabled));
});

function updateModeStatus(on) {
  modeStatus.textContent = on
    ? '● On — autofill tools shown on all application pages'
    : '● Off — autofill tools hidden';
  modeStatus.className = 'mode-status ' + (on ? 'on' : 'off');
}

// ── Application Profile ───────────────────────────────────────────────────────
const PROFILE_DEFAULTS = {
  salutation: '', firstName: '', middleName: '',
  lastName: '', fullName: '',
  email: '', phone: '', linkedin: '', website: '',
  address: '', address2: '',
  city: '', state: '', zip: '', country: 'United States',
  currentTitle: '', currentCompany: '', yearsExperience: '', university: '', degree: '', major: '', graduationYear: '',
  salaryExpectation: '', workAuth: '', requireSponsorship: '',
  visaStatus: '', willingToRelocate: '', referralSource: '',
  aiEngine: 'codex',
  gender: '', ethnicity: '', veteran: '', disability: ''
};

const PROFILE_FIELDS = [
  'salutation','firstName','middleName','lastName','email','phone','linkedin','website',
  'address','address2','city','state','zip','country',
  'currentTitle','currentCompany','yearsExperience','salaryExpectation',
  'university','degree','major','graduationYear','educationStartMonth','educationStartYear','educationEndMonth','educationEndYear',
  'workAuth','requireSponsorship','visaStatus','willingToRelocate','referralSource','aiEngine'
];

function meaningfulProfileCount(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return 0;
  return Object.entries(profile).filter(([k, v]) => k !== 'savedAt' && v != null && String(v).trim()).length;
}

function mergeProfileForSave(previous, incoming) {
  const prev = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const nextIn = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  if (meaningfulProfileCount(nextIn) === 0 && meaningfulProfileCount(prev) > 0) {
    return { ok: false, profile: prev, reason: 'rejected_empty_profile_overwrite' };
  }
  const merged = Object.assign({}, prev);
  for (const [k, v] of Object.entries(nextIn)) {
    if (v === '' && prev[k] != null && String(prev[k]).trim()) continue;
    merged[k] = v;
  }
  const deletedRequired = ['firstName', 'lastName', 'email', 'phone'].filter(k =>
    prev[k] != null && String(prev[k]).trim() && !(merged[k] != null && String(merged[k]).trim()));
  if (meaningfulProfileCount(prev) >= 3 && deletedRequired.length) {
    return { ok: false, profile: prev, reason: 'rejected_required_profile_field_deletion:' + deletedRequired.join(',') };
  }
  return { ok: true, profile: merged, reason: 'merged_profile_write' };
}

function auditProfileSave(previous, attempted, accepted, reason, source = 'settings:save-profile') {
  chrome.storage.local.get('pja_profile_write_audit', r => {
    const audit = Array.isArray(r.pja_profile_write_audit) ? r.pja_profile_write_audit.slice(-39) : [];
    audit.push({ ts: Date.now(), source,
      previousKeyCount: meaningfulProfileCount(previous), nextKeyCount: meaningfulProfileCount(attempted),
      accepted: !!accepted, reason });
    chrome.storage.local.set({ pja_profile_write_audit: audit });
  });
}

chrome.storage.local.get('pja_profile', r => {
  const saved = r.pja_profile || {};
  const profile = Object.assign({}, PROFILE_DEFAULTS, saved);
  PROFILE_FIELDS.forEach(key => {
    const el = document.getElementById('pf-' + key);
    if (el && profile[key] != null) el.value = profile[key];
  });
  showMissingProfileWarning(profile);
  renderAnalysisProfile(profile);
});

function renderAnalysisProfile(profile) {
  const el = document.getElementById('analysis-profile-summary');
  if (!el) return;
  const esc = value => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const rows = [
    ['Name', profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(' ')],
    ['Current role', [profile.currentTitle, profile.currentCompany].filter(Boolean).join(' at ')],
    ['Location', [profile.city, profile.state, profile.country].filter(Boolean).join(', ')],
    ['Education', [profile.degree, profile.major, profile.university].filter(Boolean).join(' — ')],
    ['Work authorization', profile.workAuth ? `${profile.workAuth}${profile.requireSponsorship ? `; sponsorship: ${profile.requireSponsorship}` : ''}` : 'Not configured']
  ];
  el.innerHTML = rows.map(([label, value]) => `<div class="profile-item"><div class="profile-key">${esc(label)}</div><div class="profile-val">${esc(value || 'Not configured')}</div></div>`).join('');
}

function showMissingProfileWarning(profile) {
  const missing = [];
  if (!profile.email || !profile.email.includes('@')) missing.push('Email');
  if (!profile.phone || profile.phone.length < 7) missing.push('Phone');
  const banner = document.getElementById('profile-missing-warning');
  if (!banner) return;
  if (missing.length) {
    banner.textContent = '⚠ Required for autofill: ' + missing.join(', ') + ' are empty. Applications will fail without these.';
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
  // Also check resume
  chrome.storage.local.get('pja_resume_filename', r => {
    if (resumeMissing) resumeMissing.style.display = r.pja_resume_filename ? 'none' : 'block';
  });
  // Also check Workday password
  chrome.storage.local.get('pja_job_password', r => {
    if (wdPasswordMissingEl) wdPasswordMissingEl.style.display = r.pja_job_password ? 'none' : 'block';
  });
}

document.getElementById('btn-save-profile').addEventListener('click', () => {
  const profile = {};
  PROFILE_FIELDS.forEach(key => {
    const el = document.getElementById('pf-' + key);
    if (el) profile[key] = el.value.trim();
  });
  // Keep fullName in sync
  profile.fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  chrome.storage.local.get('pja_profile', r => {
    const decision = mergeProfileForSave(r.pja_profile || {}, profile);
    auditProfileSave(r.pja_profile || {}, profile, decision.ok, decision.reason);
    if (!decision.ok) {
      chrome.storage.local.set({ pja_profile_write_rejected: { ts: Date.now(), source: 'settings:save-profile', reason: decision.reason } });
      showStatus(document.getElementById('profile-status'), 'Profile save blocked: ' + decision.reason, 'error');
      return;
    }
    chrome.storage.local.set({ pja_profile: decision.profile, pja_profile_backup: decision.profile,
      pja_profile_last_good_at: Date.now() }, () => {
      showStatus(document.getElementById('profile-status'), '✓ Profile saved', 'success');
    });
  });
});

// ── Application Preferences (pja_prefs) ─────────────────────────────────────────
const PREF_FIELDS = [
  'compensation', 'workMode', 'relocation', 'startDate', 'screeningStance',
  'targetLocationLabel', 'targetLocationCity', 'targetLocationState', 'targetLocationZip',
  'targetLocationCountry', 'targetRadiusMiles', 'locationStrictness', 'remotePolicy', 'searchTitles'
];
const DEFAULT_SEARCH_TITLES = [
  'quality engineer',
  'manufacturing quality engineer',
  'inspection engineer',
  'metrology engineer',
  'process engineer',
  'supplier quality engineer',
  'semiconductor quality engineer',
  'semiconductor process engineer',
  'medical device quality engineer',
  'validation engineer',
  'test engineer',
  'equipment engineer',
  'failure analysis engineer',
  'process integration engineer',
  'wafer process engineer',
  'thin film process engineer',
  'yield engineer',
];

function normalizedSearchTitles(value) {
  if (Array.isArray(value)) return value.join('\n');
  return String(value || '');
}

function deriveSearchPrefs(prefs, profile) {
  const next = Object.assign({}, prefs || {});
  if (!next.targetLocationCity && profile.city) next.targetLocationCity = profile.city;
  if (!next.targetLocationState && profile.state) next.targetLocationState = profile.state;
  if (!next.targetLocationZip && profile.zip) next.targetLocationZip = profile.zip;
  if (!next.targetLocationCountry && profile.country) next.targetLocationCountry = profile.country;
  if (!next.targetLocationLabel && (next.targetLocationCity || next.targetLocationState)) {
    next.targetLocationLabel = [next.targetLocationCity, next.targetLocationState].filter(Boolean).join(', ');
  }
  if (!next.targetRadiusMiles) next.targetRadiusMiles = '60';
  if (!next.locationStrictness) next.locationStrictness = 'hard';
  if (!next.remotePolicy) next.remotePolicy = 'us_or_ca_remote_allowed';
  if (!next.searchTitles || !normalizedSearchTitles(next.searchTitles).trim()) {
    next.searchTitles = DEFAULT_SEARCH_TITLES.join('\n');
  }
  return next;
}

chrome.storage.local.get(['pja_prefs', 'pja_profile'], r => {
  const prefs = r.pja_prefs || {};
  const profile = r.pja_profile || {};
  const derived = deriveSearchPrefs(prefs, profile);
  PREF_FIELDS.forEach(k => {
    const el = document.getElementById('pref-' + k);
    if (!el) return;
    if (k === 'searchTitles') el.value = normalizedSearchTitles(derived[k]);
    else if (derived[k] != null) el.value = derived[k];
  });
  const advancedEl = document.getElementById('pref-advancedUi');
  if (advancedEl) advancedEl.checked = !!derived.advancedUi;
});
function savePrefs(statusEl) {
  chrome.storage.local.get('pja_prefs', r => {
    const prefs = r.pja_prefs || {};
    PREF_FIELDS.forEach(k => {
      const el = document.getElementById('pref-' + k);
      if (!el) return;
      if (k === 'searchTitles') {
        prefs[k] = el.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      } else {
        prefs[k] = el.value.trim();
      }
    });
    const advancedEl = document.getElementById('pref-advancedUi');
    if (advancedEl) {
      prefs.advancedUi = !!advancedEl.checked;
      chrome.storage.local.set({ pja_advanced_ui: !!advancedEl.checked });
    }
    prefs.updatedAt = new Date().toISOString().slice(0, 10);
    chrome.storage.local.set({ pja_prefs: prefs }, () =>
      showStatus(statusEl || document.getElementById('prefs-status'), '✓ Preferences saved', 'success'));
  });
}
const btnSavePrefs = document.getElementById('btn-save-prefs');
if (btnSavePrefs) btnSavePrefs.addEventListener('click', () => savePrefs(document.getElementById('prefs-status')));
const btnSaveE2ePrefs = document.getElementById('btn-save-e2e-prefs');
if (btnSaveE2ePrefs) btnSaveE2ePrefs.addEventListener('click', () => savePrefs(document.getElementById('e2e-prefs-status')));

// ── Resume Upload ─────────────────────────────────────────────────────────────
const resumeStatus  = document.getElementById('resume-status');
const resumeCurrent = document.getElementById('resume-current');
const resumeMissing = document.getElementById('resume-missing-warning');
const resumeFileInput = document.getElementById('resume-file-input');

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function renderResumeState(filename, sizeBytes) {
  if (filename) {
    document.getElementById('resume-filename').textContent = filename;
    document.getElementById('resume-filesize').textContent = sizeBytes ? formatBytes(sizeBytes) : '';
    resumeCurrent.style.display = 'flex';
    resumeMissing.style.display = 'none';
  } else {
    resumeCurrent.style.display = 'none';
    resumeMissing.style.display = 'block';
  }
}

chrome.storage.local.get(['pja_resume_filename', 'pja_resume_size'], r => {
  renderResumeState(r.pja_resume_filename || '', r.pja_resume_size || 0);
});

document.getElementById('btn-upload-resume').addEventListener('click', () => resumeFileInput.click());

resumeFileInput.addEventListener('change', () => {
  const file = resumeFileInput.files[0];
  if (!file) return;
  const maxMB = 9;
  if (file.size > maxMB * 1024 * 1024) {
    showStatus(resumeStatus, `File too large (max ${maxMB} MB)`, 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const b64 = e.target.result; // data URL: "data:application/pdf;base64,..."
    chrome.storage.local.set({
      pja_resume_b64:      b64,
      pja_resume_filename: file.name,
      pja_resume_size:     file.size
    }, () => {
      renderResumeState(file.name, file.size);
      showStatus(resumeStatus, '✓ Resume saved', 'success');
    });
  };
  reader.onerror = () => showStatus(resumeStatus, 'Failed to read file', 'error');
  reader.readAsDataURL(file);
  resumeFileInput.value = '';
});

document.getElementById('btn-remove-resume').addEventListener('click', () => {
  chrome.storage.local.remove(['pja_resume_b64', 'pja_resume_filename', 'pja_resume_size'], () => {
    renderResumeState('', 0);
    showStatus(resumeStatus, 'Resume removed', 'success');
  });
});

// ── Workday / ATS Settings ────────────────────────────────────────────────────

// Gmail account index (u/N) — which account receives Workday verification emails
const gmailAcctStatusEl = document.getElementById('gmail-acct-status');

function highlightActiveGmailAcct(idx) {
  document.querySelectorAll('.gmail-acct-btn').forEach(btn => {
    const active = parseInt(btn.dataset.idx) === idx;
    btn.style.fontWeight = active ? 'bold' : '';
    btn.style.outline = active ? '2px solid #2563eb' : '';
  });
  if (gmailAcctStatusEl) {
    gmailAcctStatusEl.textContent = idx !== null
      ? `✓ Using Gmail account u/${idx} (mail.google.com/mail/u/${idx})`
      : '';
  }
}

chrome.storage.local.get('pja_gmail_account_index', r => {
  const idx = r.pja_gmail_account_index ?? 3; // default u/3
  if (r.pja_gmail_account_index === undefined) {
    chrome.storage.local.set({ pja_gmail_account_index: 3 });
  }
  highlightActiveGmailAcct(idx);
});

document.querySelectorAll('.gmail-acct-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const idx = parseInt(btn.dataset.idx);
    chrome.storage.local.set({ pja_gmail_account_index: idx }, () => {
      highlightActiveGmailAcct(idx);
    });
  });
});

// ── Workday Password ──────────────────────────────────────────────────────────
const DEFAULT_JOB_PASSWORD = 'ChangeMe#2025!';
const wdPasswordInput = document.getElementById('wd-password-input');
const wdPasswordStatusEl = document.getElementById('wd-password-status');

function saveWdPassword(pw) {
  chrome.storage.local.set({ pja_job_password: pw }, () => {
    if (wdPasswordInput) wdPasswordInput.value = pw;
    highlightActivePreset(pw);
    showStatus(wdPasswordStatusEl, '✓ Password saved', 'success');
  });
}

function highlightActivePreset(pw) {
  document.querySelectorAll('.wd-preset-btn').forEach(btn => {
    btn.style.fontWeight = btn.dataset.pw === pw ? 'bold' : '';
    btn.style.outline = btn.dataset.pw === pw ? '2px solid #2563eb' : '';
  });
}

// Seed default on first load if nothing saved
chrome.storage.local.get('pja_job_password', r => {
  const saved = r.pja_job_password || DEFAULT_JOB_PASSWORD;
  if (!r.pja_job_password) {
    chrome.storage.local.set({ pja_job_password: DEFAULT_JOB_PASSWORD });
  }
  if (wdPasswordInput) wdPasswordInput.value = saved;
  highlightActivePreset(saved);
});

// Preset chip clicks
document.querySelectorAll('.wd-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => saveWdPassword(btn.dataset.pw));
});

const btnSaveWdPw = document.getElementById('btn-save-wd-password');
if (btnSaveWdPw) {
  btnSaveWdPw.addEventListener('click', () => {
    const pw = wdPasswordInput ? wdPasswordInput.value.trim() : '';
    if (!pw) { showStatus(wdPasswordStatusEl, 'Please enter a password.', 'error'); return; }
    if (pw.length < 8) { showStatus(wdPasswordStatusEl, 'Must be at least 8 characters.', 'error'); return; }
    if (!/[0-9]/.test(pw)) { showStatus(wdPasswordStatusEl, 'Must include at least one number.', 'error'); return; }
    if (!/[!@#$%^&*()\-_=+\[\]{}|;:'",.<>?]/.test(pw)) { showStatus(wdPasswordStatusEl, 'Must include at least one symbol.', 'error'); return; }
    saveWdPassword(pw);
  });
}

// ── API Key ───────────────────────────────────────────────────────────────────
const keyInput = document.getElementById('api-key-input');
const keyStatus = document.getElementById('key-status');

chrome.storage.local.get('apiKey', r => {
  if (r.apiKey) {
    keyInput.value = r.apiKey;
    keyInput.placeholder = 'Key saved';
  }
});

document.getElementById('btn-save-key').addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) { showStatus(keyStatus, 'Please enter a key.', 'error'); return; }
  if (!key.startsWith('sk-ant-')) { showStatus(keyStatus, 'Key should start with sk-ant-', 'error'); return; }
  chrome.storage.local.set({ apiKey: key }, () => showStatus(keyStatus, '✓ Key saved', 'success'));
});

document.getElementById('btn-clear-key').addEventListener('click', () => {
  if (!confirm('Remove the saved API key?')) return;
  chrome.storage.local.remove('apiKey', () => {
    keyInput.value = '';
    keyInput.placeholder = 'sk-ant-api03-…';
    showStatus(keyStatus, 'Key removed. Extension runs in Demo Mode.', 'success');
  });
});

// ── Clear all data ────────────────────────────────────────────────────────────
document.getElementById('btn-clear-all').addEventListener('click', () => {
  const count = parseInt(document.getElementById('stat-total').textContent) || 0;
  if (!confirm(`Delete all ${count} saved jobs? This cannot be undone.`)) return;
  chrome.storage.local.remove('pja_jobs', () => {
    loadStats();
    showStatus(document.getElementById('clear-status'), '✓ Pipeline cleared', 'success');
    chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function loadStats() {
  chrome.storage.local.get('pja_jobs', r => {
    const jobs = r.pja_jobs || [];
    document.getElementById('stat-total').textContent = jobs.length;
    document.getElementById('stat-outreach').textContent = jobs.filter(j => j.status === 'Outreach Sent').length;
    document.getElementById('stat-interview').textContent = jobs.filter(j => j.status === 'Interview').length;
  });
}
loadStats();

// ── Answer Bank ───────────────────────────────────────────────────────────────
function loadAnswerBank() {
  chrome.storage.local.get('pja_answers', r => {
    const answers = r.pja_answers || {};
    const entries = Object.entries(answers)
      .sort((a, b) => (b[1].usedCount || 0) - (a[1].usedCount || 0));

    const listEl = document.getElementById('answer-bank-list');
    const emptyEl = document.getElementById('answer-bank-empty');

    if (!entries.length) {
      emptyEl.style.display = 'block';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = entries.map(([key, entry]) => `
      <div class="answer-card" data-key="${escAttr(key)}">
        <div class="answer-card-label">${esc(entry.rawLabel || key)}</div>
        <div class="answer-meta">Used ${entry.usedCount || 1}× · Learned ${timeAgo(entry.savedAt)}</div>
        <textarea class="answer-textarea" rows="3">${esc(entry.answer || '')}</textarea>
        <div class="answer-card-actions">
          <button class="btn btn-sm btn-outline btn-save-answer">Save edit</button>
          <button class="btn btn-sm btn-answer-delete">Delete</button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('.btn-save-answer').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.answer-card');
        const key = card.dataset.key;
        const value = card.querySelector('.answer-textarea').value.trim();
        chrome.runtime.sendMessage({ type: 'UPDATE_ANSWER', key, value }, () => {
          showStatus(document.getElementById('answers-status'), '✓ Saved', 'success');
        });
      });
    });

    listEl.querySelectorAll('.btn-answer-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.answer-card');
        const key = card.dataset.key;
        chrome.runtime.sendMessage({ type: 'DELETE_ANSWER', key }, () => {
          card.remove();
          if (!listEl.querySelectorAll('.answer-card').length) {
            emptyEl.style.display = 'block';
          }
        });
      });
    });
  });
}
loadAnswerBank();

document.getElementById('btn-clear-answers').addEventListener('click', () => {
  if (!confirm('Delete all learned answers? This cannot be undone.')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_ANSWERS' }, () => {
    loadAnswerBank();
    showStatus(document.getElementById('answers-status'), '✓ Cleared', 'success');
  });
});

// ── Export ────────────────────────────────────────────────────────────────────
function collectExportData(cb) {
  chrome.storage.local.get(
    ['pja_answers', 'pja_profile', 'pja_contacts', 'pja_jobs', 'pja_site_log', 'pja_templates'],
    r => {
      const jobs = (r.pja_jobs || []).map(j => ({
        title: j.title,
        company: j.company,
        status: j.status,
        savedAt: j.savedAt,
        fitScore: j.fitScore,
        matchedSkills: j.matchedSkills,
        gaps: j.gaps,
        url: j.url
      }));
      const data = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        profile: r.pja_profile || {},
        answerBank: r.pja_answers || {},
        templates: r.pja_templates || [],
        contacts: (r.pja_contacts || []).map(c => ({
          name: c.name, title: c.title, company: c.company,
          status: c.status, howKnown: c.howKnown, notes: c.notes
        })),
        pipeline: jobs,
        siteLog: r.pja_site_log || []
      };
      cb(data);
    }
  );
}

document.getElementById('btn-export').addEventListener('click', () => {
  collectExportData(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pja-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(document.getElementById('export-status'), '✓ Downloaded', 'success');
  });
});

document.getElementById('btn-preview-export').addEventListener('click', () => {
  collectExportData(data => {
    const preview = document.getElementById('export-preview');
    const answers = Object.entries(data.answerBank);
    const lines = [
      `Profile fields: ${Object.values(data.profile).filter(Boolean).length} filled`,
      `Answer bank: ${answers.length} learned Q&A pairs`,
      `Pipeline jobs: ${data.pipeline.length}`,
      `Contacts: ${data.contacts.length}`,
      `Site log: ${data.siteLog.length} domains`,
      '',
      '── Answer Bank ─────────────────────',
      ...answers.map(([k, v]) => `${v.rawLabel || k}: "${String(v.answer || '').slice(0, 60)}${(v.answer||'').length > 60 ? '…' : ''}"  (used ${v.usedCount || 1}×)`)
    ];
    preview.textContent = lines.join('\n');
    preview.style.display = preview.style.display === 'none' ? 'block' : 'none';
  });
});

// ── Auto-trigger Domains ──────────────────────────────────────────────────────
function loadCustomDomains() {
  chrome.runtime.sendMessage({ type: 'GET_CUSTOM_DOMAINS' }, r => {
    const domains = r?.domains || [];
    const listEl  = document.getElementById('custom-domains-list');
    const emptyEl = document.getElementById('custom-domains-empty');
    if (!domains.length) {
      emptyEl.style.display = 'block';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = domains.map(d => `
      <div class="answer-card" style="display:flex;align-items:center;gap:10px;padding:10px 14px;">
        <span style="flex:1;font-weight:600;font-size:13px;">${esc(d)}</span>
        <button class="btn btn-sm btn-answer-delete" data-domain="${escAttr(d)}">Remove</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.btn-answer-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const domain = btn.dataset.domain;
        chrome.runtime.sendMessage({ type: 'REMOVE_CUSTOM_DOMAIN', domain }, () => loadCustomDomains());
      });
    });
  });
}
loadCustomDomains();

// ── Site Log ──────────────────────────────────────────────────────────────────
function loadSiteLog() {
  chrome.runtime.sendMessage({ type: 'GET_SITE_LOG' }, r => {
    const log = r?.log || [];
    const listEl = document.getElementById('site-log-list');
    const emptyEl = document.getElementById('site-log-empty');
    if (!log.length) {
      emptyEl.style.display = 'block';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = log.map(entry => `
      <div class="answer-card">
        <div class="answer-card-label">${esc(entry.domain)}</div>
        <div class="answer-meta">
          Opened manually ${entry.count}× · Last: ${timeAgo(entry.lastSeen)}
          ${entry.title ? ' · ' + esc(entry.title.slice(0, 60)) : ''}
        </div>
        ${(entry.urls || []).slice(0, 3).map(u =>
          `<div style="font-size:11px;color:#6b7280;margin-top:3px;word-break:break-all;">${esc(u.slice(0, 80))}${u.length > 80 ? '…' : ''}</div>`
        ).join('')}
      </div>
    `).join('');
  });
}
loadSiteLog();

document.getElementById('btn-clear-site-log').addEventListener('click', () => {
  if (!confirm('Clear the site log?')) return;
  chrome.storage.local.remove('pja_site_log', () => {
    loadSiteLog();
    showStatus(document.getElementById('site-log-status'), '✓ Cleared', 'success');
  });
});

// ── Message Templates ─────────────────────────────────────────────────────────
function loadTemplates() {
  chrome.storage.local.get('pja_templates', r => {
    const templates = r.pja_templates || [];
    const listEl  = document.getElementById('templates-list');
    const emptyEl = document.getElementById('templates-empty');
    if (!templates.length) {
      emptyEl.style.display = 'block';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = templates.map(t => `
      <div class="answer-card" data-id="${escAttr(t.id)}">
        <div class="answer-card-label">${esc(t.name)}</div>
        <div class="answer-meta">Saved ${timeAgo(t.savedAt)}</div>
        <textarea class="answer-textarea" rows="4">${esc(t.text || '')}</textarea>
        <div class="answer-card-actions">
          <button class="btn btn-sm btn-primary btn-copy-tmpl">Copy</button>
          <button class="btn btn-sm btn-outline btn-save-tmpl">Save edit</button>
          <button class="btn btn-sm btn-answer-delete btn-del-tmpl">Delete</button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('.btn-copy-tmpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.closest('.answer-card').querySelector('.answer-textarea').value;
        navigator.clipboard.writeText(text).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => { btn.textContent = orig; }, 1800);
        });
      });
    });

    listEl.querySelectorAll('.btn-save-tmpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.answer-card');
        const id   = card.dataset.id;
        const text = card.querySelector('.answer-textarea').value.trim();
        const tmpl = templates.find(t => t.id === id);
        if (!tmpl) return;
        chrome.storage.local.get('pja_templates', r2 => {
          const all = r2.pja_templates || [];
          const idx = all.findIndex(t => t.id === id);
          if (idx >= 0) { all[idx].text = text; }
          chrome.storage.local.set({ pja_templates: all }, () => {
            showStatus(document.getElementById('templates-status'), '✓ Saved', 'success');
          });
        });
      });
    });

    listEl.querySelectorAll('.btn-del-tmpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.answer-card');
        const id   = card.dataset.id;
        chrome.storage.local.get('pja_templates', r2 => {
          const all = (r2.pja_templates || []).filter(t => t.id !== id);
          chrome.storage.local.set({ pja_templates: all }, () => {
            card.remove();
            if (!listEl.querySelectorAll('.answer-card').length) emptyEl.style.display = 'block';
          });
        });
      });
    });
  });
}
loadTemplates();

function timeAgo(ts) {
  if (!ts) return 'recently';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// ── Missing Questions (from External Apply) ───────────────────────────────────
function missingQuestionCategory(q) {
  const key = String(q.canonicalKey || '').toLowerCase();
  const label = String(q.rawLabel || q.question || '').toLowerCase();
  if (key.startsWith('profile.address') || /address|city|state|zip|postal|country/.test(label)) return 'Profile / Contact';
  if (key.startsWith('profile.phone') || /phone|mobile|telephone/.test(label)) return 'Profile / Contact';
  if (key.startsWith('profile.education') || /education|school|university|college|degree|gpa/.test(label)) return 'Education';
  if (key.startsWith('workauth') || /work auth|authorized|sponsor|visa|citizen|u\.?s\.? person|export control|itar|ear/.test(label)) return 'Work Authorization';
  if (key.startsWith('eeo') || /gender|race|ethnic|veteran|disab/.test(label)) return 'EEO / Self-ID';
  if (key.startsWith('compliance') || /non-compete|restrictive|federal|relative|employee/.test(label)) return 'Compliance';
  if (key.startsWith('experience') || /experience|solidworks|catia|gxp|pcba|silicon|pcie|cxl|ddr|ethernet/.test(label)) return 'Experience Details';
  if (key.startsWith('preferences') || /salary|compensation|location|relocat|start|availability|referral/.test(label)) return 'Preferences';
  if (key.startsWith('policy') || /consent|agree|acknowledge|certify|privacy|sms|email/.test(label)) return 'Consent / Policy';
  return 'Other Required Fields';
}

function profileKeyForCanonical(canonicalKey) {
  const map = {
    'profile.address.line1': 'address',
    'profile.address.line2': 'address2',
    'profile.address.city': 'city',
    'profile.address.state': 'state',
    'profile.address.zip': 'zip',
    'profile.address.country': 'country',
    'profile.phone': 'phone',
    'profile.phoneType': 'phoneType',
    'profile.linkedin': 'linkedin',
    'profile.website': 'website',
    'profile.education.highest': 'highestEducation',
    'profile.education.degree': 'degree',
    'profile.education.school': 'university',
    'profile.education.graduationMonth': 'graduationMonth',
    'profile.education.graduationYear': 'graduationYear',
    'profile.education.gpa': 'gpa',
    'workAuth.authorized': 'workAuth',
    'workAuth.sponsorship': 'requireSponsorship',
    'workAuth.visaStatus': 'visaStatus',
    'workAuth.usPerson': 'usPersonForExportControl',
    'workAuth.citizenship': 'countryOfCitizenship',
    'eeo.gender': 'gender',
    'eeo.race': 'race',
    'eeo.ethnicity': 'ethnicity',
    'eeo.veteran': 'veteran',
    'eeo.disability': 'disability',
    'preferences.location': 'locationPreference',
    'preferences.compensation': 'salaryExpectation',
    'preferences.startDate': 'startDate',
    'preferences.referralSource': 'referralSource',
    'policy.consent': 'acknowledgePolicies',
    'policy.sms': 'consentSms',
    'policy.email': 'consentEmail',
    'compliance.restrictiveAgreement': 'restrictiveAgreement',
    'compliance.currentEmployee': 'currentEmployeeAtTarget',
    'compliance.relationships': 'knowsEmployeesAtTargetCompany',
    'compliance.federal': 'hasFederalWorkOrRelatives',
    'experience.totalYears': 'yearsExperience',
    'experience.siliconPcbaTestYears': 'siliconTestExperienceYears',
    'experience.highSpeedInterfaceYears': 'highSpeedInterfaceExperienceYears',
    'experience.solidworks': 'solidworksExperience',
    'experience.catia': 'catiaExperience',
    'experience.gxpValidation': 'gxpValidationExperience',
  };
  return map[canonicalKey] || '';
}

function missingQuestionBadges(q) {
  const badges = [];
  if (q.canonicalKey) badges.push(`<span class="mq-badge-pill">${esc(q.canonicalKey)}</span>`);
  if (q.source) badges.push(`<span class="mq-badge-pill">${esc(q.source)}</span>`);
  if (q.confidence) badges.push(`<span class="mq-badge-pill">confidence: ${esc(q.confidence)}</span>`);
  if (q.sensitive) badges.push('<span class="mq-badge-pill mq-badge-sensitive">sensitive</span>');
  if (q.status) badges.push(`<span class="mq-badge-pill">status: ${esc(q.status)}</span>`);
  return badges.join(' ');
}

function loadMissingQuestions() {
  const listEl  = document.getElementById('mq-list');
  const emptyEl = document.getElementById('mq-empty');
  const badge   = document.getElementById('mq-badge');
  const saveBtn = document.getElementById('btn-save-mq');
  const clearBtn= document.getElementById('btn-clear-mq');
  if (!listEl) return;

  chrome.storage.local.get('pja_missing_questions', r => {
    const mq = r.pja_missing_questions || {};
    const entries = Object.entries(mq);
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      badge.style.display = 'none';
      saveBtn.style.display = 'none';
      clearBtn.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    // Show questions still needing approval/answers. Approved historical entries remain in storage
    // for diagnostics, but do not clutter the working queue.
    const unresolvedStatuses = new Set(['needs_user', 'proposed', 'needs_review']);
    const unansweredEntries = entries.filter(([,v]) =>
      !v.answer || unresolvedStatuses.has(String(v.status || '').toLowerCase())
    );
    const unanswered = unansweredEntries.length;
    badge.textContent = unanswered ? `${unanswered} pending` : 'all answered';
    badge.style.background = unanswered ? '#f59e0b' : '#10b981';
    badge.style.display = 'inline';
    saveBtn.style.display = unanswered ? 'inline-block' : 'none';
    clearBtn.style.display = 'inline-block';

    if (!unanswered) {
      emptyEl.style.display = 'block';
      emptyEl.textContent = 'All questions answered — great!';
      return;
    }

    const groups = new Map();
    unansweredEntries.forEach(entry => {
      const category = missingQuestionCategory(entry[1] || {});
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(entry);
    });

    for (const [category, groupEntries] of groups.entries()) {
      const groupEl = document.createElement('div');
      groupEl.className = 'mq-group';
      groupEl.innerHTML = `<h3>${esc(category)} <span>${groupEntries.length}</span></h3>`;
      listEl.appendChild(groupEl);

      groupEntries.forEach(([key, q]) => {
        const card = document.createElement('div');
        card.className = 'answer-card';
        card.dataset.key = key;
        const profileKey = profileKeyForCanonical(q.canonicalKey || '');
        if (profileKey) card.dataset.profileKey = profileKey;

        const contexts = (q.contexts || q.examples || []).slice(0, 2).map(c => `${c.company || 'Unknown company'} — ${c.title || 'Unknown role'}`).join('; ');
        const diagnostics = (q.diagnostics || []).slice(-1)[0];
        const diagnosticText = diagnostics
          ? `Last failure: ${diagnostics.phase || 'unknown phase'}${diagnostics.attemptedAnswer ? ` · tried "${diagnostics.attemptedAnswer}"` : ''}`
          : '';
        const value = q.answer || q.proposedAnswer || '';
      let inputHtml = '';
      if (q.type === 'select' && q.options?.length) {
        inputHtml = `<select class="mq-input" data-key="${escAttr(key)}">
          <option value="">— select —</option>
          ${q.options.map(o => `<option value="${escAttr(o)}"${value === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`;
      } else if (q.type === 'radio' && q.options?.length) {
        inputHtml = `<select class="mq-input" data-key="${escAttr(key)}">
          <option value="">— select —</option>
          ${q.options.map(o => `<option value="${escAttr(o)}"${value === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`;
      } else if (q.type === 'textarea') {
        inputHtml = `<textarea class="mq-input" data-key="${escAttr(key)}" rows="2" placeholder="Your answer…">${esc(value)}</textarea>`;
      } else {
        inputHtml = `<input class="mq-input" data-key="${escAttr(key)}" type="text" placeholder="Your answer…" value="${escAttr(value)}">`;
      }

      card.innerHTML = `
        <div class="answer-label">${esc(q.rawLabel || q.question || key)}</div>
        <div class="answer-meta">Seen ${q.seenCount || 1}×${contexts ? ` · ${esc(contexts)}` : ''}${profileKey ? ` · saves to profile.${esc(profileKey)} if empty` : ''}</div>
        <div class="mq-badges">${missingQuestionBadges(q)}</div>
        ${diagnosticText ? `<div class="answer-meta">${esc(diagnosticText)}</div>` : ''}
        ${inputHtml}
      `;
        groupEl.appendChild(card);
      });
    }

    // Scroll to #missing anchor if present
    if (location.hash === '#missing') {
      document.getElementById('missing-questions-card')?.scrollIntoView({ behavior: 'smooth' });
    }
  });
}
loadMissingQuestions();

document.getElementById('btn-save-mq')?.addEventListener('click', () => {
  chrome.storage.local.get(['pja_missing_questions', 'pja_answers', 'pja_profile'], r => {
    const mq = r.pja_missing_questions || {};
    const bank = r.pja_answers || {};
    const profile = r.pja_profile || {};
    const profilePatch = {};
    const now = Date.now();
    let savedCount = 0;

    document.querySelectorAll('.mq-input').forEach(el => {
      const key = el.dataset.key;
      const val = el.value.trim();
      if (!key || !val) return;
      const q = mq[key] || {};
      // Write into mq (for diagnostics/review) and into pja_answers (so auto-apply uses it).
      mq[key] = {
        ...q,
        answer: val,
        status: 'approved',
        approvedAt: now,
        updatedAt: now,
      };
      bank[key] = {
        rawLabel: q.rawLabel || q.question || key,
        answer: val,
        savedAt: now,
        usedCount: 0,
        source: 'missing_info_ui',
        confidence: 'high',
        canonicalKey: q.canonicalKey || null,
        sensitive: !!q.sensitive,
      };
      const profileKey = profileKeyForCanonical(q.canonicalKey || '');
      if (profileKey && (profile[profileKey] == null || String(profile[profileKey]).trim() === '')) {
        profilePatch[profileKey] = val;
        mq[key].savedToProfileKey = profileKey;
      }
      savedCount++;
    });

    const storageUpdate = { pja_missing_questions: mq, pja_answers: bank };
    let blockedReason = '';
    if (meaningfulProfileCount(profilePatch)) {
      const decision = mergeProfileForSave(profile, profilePatch);
      auditProfileSave(profile, profilePatch, decision.ok, decision.reason, 'settings:missing-info');
      if (decision.ok) {
        storageUpdate.pja_profile = decision.profile;
        storageUpdate.pja_profile_backup = decision.profile;
        storageUpdate.pja_profile_last_good_at = now;
      } else {
        blockedReason = decision.reason;
        storageUpdate.pja_profile_write_rejected = { ts: now, source: 'settings:missing-info', reason: decision.reason };
      }
    }

    chrome.storage.local.set(storageUpdate, () => {
      if (blockedReason) {
        showStatus(document.getElementById('mq-status'), `Saved ${savedCount} answer${savedCount === 1 ? '' : 's'}; profile update blocked: ${blockedReason}`, 'error');
        loadMissingQuestions();
        return;
      }
      showStatus(document.getElementById('mq-status'), `✓ Saved ${savedCount} answer${savedCount === 1 ? '' : 's'}`, 'success');
      loadMissingQuestions();
    });
  });
});

document.getElementById('btn-clear-mq')?.addEventListener('click', () => {
  if (!confirm('Clear all missing questions? This cannot be undone.')) return;
  chrome.storage.local.remove('pja_missing_questions', () => {
    showStatus(document.getElementById('mq-status'), '✓ Cleared', 'success');
    loadMissingQuestions();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = 'status-msg ' + type;
  setTimeout(() => { el.className = 'status-msg'; el.textContent = ''; }, 3500);
}
