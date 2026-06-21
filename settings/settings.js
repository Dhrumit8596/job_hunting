'use strict';

// ── App Mode toggle ──────────────────────────────────────────────────────────
const modeToggle = document.getElementById('app-mode-toggle');
const modeStatus = document.getElementById('app-mode-status');

chrome.storage.local.get('appMode', r => {
  modeToggle.checked = !!r.appMode;
  updateModeStatus(!!r.appMode);
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
  salutation: 'Mrs', firstName: 'the candidate', middleName: '',
  lastName: '', fullName: 'the candidate',
  email: '', phone: '', linkedin: '', website: '',
  address: '', address2: '',
  city: 'Santa Clara', state: 'CA', zip: '', country: 'United States',
  currentTitle: 'Senior Inspection Metrology Technician',
  currentCompany: 'a medical-device employer',
  yearsExperience: '6', university: '', degree: '', major: '', graduationYear: '',
  salaryExpectation: '', workAuth: 'Yes', requireSponsorship: 'No',
  visaStatus: 'TN Visa', willingToRelocate: 'Yes', referralSource: 'LinkedIn',
  gender: '', ethnicity: '', veteran: '', disability: ''
};

const PROFILE_FIELDS = [
  'salutation','firstName','middleName','lastName','email','phone','linkedin','website',
  'address','address2','city','state','zip','country',
  'currentTitle','currentCompany','yearsExperience','salaryExpectation',
  'university','degree','major','graduationYear',
  'workAuth','requireSponsorship','visaStatus','willingToRelocate','referralSource'
];

chrome.storage.local.get('pja_profile', r => {
  const saved = r.pja_profile || {};
  const profile = Object.assign({}, PROFILE_DEFAULTS, saved);
  PROFILE_FIELDS.forEach(key => {
    const el = document.getElementById('pf-' + key);
    if (el && profile[key] != null) el.value = profile[key];
  });
  showMissingProfileWarning(profile);
});

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
  chrome.storage.local.set({ pja_profile: profile }, () => {
    showStatus(document.getElementById('profile-status'), '✓ Profile saved', 'success');
  });
});

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
    // Only show questions that still need an answer — hide already-answered ones
    const unansweredEntries = entries.filter(([,v]) => !v.answer);
    const unanswered = unansweredEntries.length;
    badge.textContent = unanswered ? `${unanswered} unanswered` : 'all answered';
    badge.style.background = unanswered ? '#f59e0b' : '#10b981';
    badge.style.display = 'inline';
    saveBtn.style.display = unanswered ? 'inline-block' : 'none';
    clearBtn.style.display = 'inline-block';

    if (!unanswered) {
      emptyEl.style.display = 'block';
      emptyEl.textContent = 'All questions answered — great!';
      return;
    }

    unansweredEntries.forEach(([key, q]) => {
      const card = document.createElement('div');
      card.className = 'answer-card';
      card.dataset.key = key;

      const contexts = (q.contexts || []).slice(0, 2).map(c => `${c.company} — ${c.title}`).join('; ');
      let inputHtml = '';
      if (q.type === 'select' && q.options?.length) {
        inputHtml = `<select class="mq-input" data-key="${escAttr(key)}">
          <option value="">— select —</option>
          ${q.options.map(o => `<option value="${escAttr(o)}"${q.answer === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`;
      } else if (q.type === 'radio' && q.options?.length) {
        inputHtml = `<select class="mq-input" data-key="${escAttr(key)}">
          <option value="">— select —</option>
          ${q.options.map(o => `<option value="${escAttr(o)}"${q.answer === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`;
      } else if (q.type === 'textarea') {
        inputHtml = `<textarea class="mq-input" data-key="${escAttr(key)}" rows="2" placeholder="Your answer…">${esc(q.answer || '')}</textarea>`;
      } else {
        inputHtml = `<input class="mq-input" data-key="${escAttr(key)}" type="text" placeholder="Your answer…" value="${escAttr(q.answer || '')}">`;
      }

      card.innerHTML = `
        <div class="answer-label">${esc(q.question)}</div>
        <div class="answer-meta">Seen ${q.seenCount || 1}× · ${esc(contexts)}</div>
        ${inputHtml}
      `;
      listEl.appendChild(card);
    });

    // Scroll to #missing anchor if present
    if (location.hash === '#missing') {
      document.getElementById('missing-questions-card')?.scrollIntoView({ behavior: 'smooth' });
    }
  });
}
loadMissingQuestions();

document.getElementById('btn-save-mq')?.addEventListener('click', () => {
  chrome.storage.local.get(['pja_missing_questions', 'pja_answers'], r => {
    const mq = r.pja_missing_questions || {};
    const bank = r.pja_answers || {};
    const now = Date.now();

    document.querySelectorAll('.mq-input').forEach(el => {
      const key = el.dataset.key;
      const val = el.value.trim();
      if (!key || !val) return;
      // Write into mq (for record) and into pja_answers (so auto-apply uses it)
      if (mq[key]) mq[key].answer = val;
      bank[key] = { answer: val, savedAt: now, usedCount: 0 };
    });

    chrome.storage.local.set({ pja_missing_questions: mq, pja_answers: bank }, () => {
      showStatus(document.getElementById('mq-status'), '✓ Saved to answer bank', 'success');
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
