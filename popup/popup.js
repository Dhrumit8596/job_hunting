'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Needs Info':    { bg: '#fef9c3', text: '#854d0e' },
  'Bookmarked':    { bg: '#ede9fe', text: '#5b21b6' },
  'Shortlisted':   { bg: '#ffedd5', text: '#c2410c' },
  'Applied':       { bg: '#dbeafe', text: '#1e40af' },
  'Outreach Sent': { bg: '#cffafe', text: '#0e7490' },
  'Interview':     { bg: '#fef3c7', text: '#b45309' },
  'Offer':         { bg: '#d1fae5', text: '#065f46' },
  'Rejected':      { bg: '#fee2e2', text: '#991b1b' }
};
const CONTACT_STATUS_COLORS = {
  'To Contact':  { bg: '#ede9fe', text: '#5b21b6' },
  'Contacted':   { bg: '#cffafe', text: '#0e7490' },
  'Responded':   { bg: '#d1fae5', text: '#065f46' },
  'In Progress': { bg: '#fef3c7', text: '#b45309' },
  'Closed':      { bg: '#f3f4f6', text: '#6b7280' }
};
const JOB_STATUSES     = ['Needs Info','Bookmarked','Shortlisted','Applied','Outreach Sent','Interview','Offer','Rejected'];
const CONTACT_STATUSES = ['To Contact','Contacted','Responded','In Progress','Closed'];
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const PJA_DEV_SERVER = 'http://localhost:6174';
const ONE_CLICK_DEFAULTS = {
  targetConfirmed: 20,
  threshold: 70,
  maxGaps: 20,
  perCompanyCap: 2,
  includeAssisted: true,
  e2eSafe: true,
  rescore: true,
  requireEvidence: true,
};
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

// ── State ─────────────────────────────────────────────────────────────────────
let allJobs = [];
let allContacts = [];
let activeFilter = 'All';
let activeContactFilter = 'All';
let activeTab = 'pipeline';

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('btn-shortlist').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('shortlist/shortlist.html') });
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    document.getElementById('panel-pipeline').style.display = activeTab === 'pipeline' ? 'flex' : 'none';
    document.getElementById('panel-search').style.display   = activeTab === 'search'   ? 'flex' : 'none';
    document.getElementById('panel-contacts').style.display = activeTab === 'contacts'  ? 'flex' : 'none';
    if (activeTab === 'search') renderSearchPanel();
    updateFooter();
  });
});

// Pipeline filters
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.status;
    renderJobs();
  });
});

// Contact filters
document.querySelectorAll('.cfilt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cfilt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeContactFilter = btn.dataset.cstatus;
    renderContacts();
  });
});

// Add contact form
document.getElementById('btn-add-contact').addEventListener('click', () => {
  const form = document.getElementById('add-contact-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  if (form.style.display === 'block') document.getElementById('acf-name').focus();
});
document.getElementById('btn-acf-cancel').addEventListener('click', () => {
  document.getElementById('add-contact-form').style.display = 'none';
  clearAddForm();
});
document.getElementById('btn-acf-save').addEventListener('click', saveNewContact);

// Manual force-open
document.getElementById('btn-force-open').addEventListener('click', forceOpenSidebar);
document.getElementById('btn-one-click-apply')?.addEventListener('click', startOneClickApply);
document.getElementById('btn-one-click-refresh')?.addEventListener('click', refreshOneClickStatus);
document.getElementById('btn-one-click-report')?.addEventListener('click', exportOneClickReport);

function getLocalStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function splitSearchTitles(value) {
  if (Array.isArray(value)) return value.map(s => String(s || '').trim()).filter(Boolean);
  return String(value || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function buildOneClickPrefsPayload(prefs = {}, profile = {}) {
  const targetLocation = {
    label: prefs.targetLocationLabel || [prefs.targetLocationCity || profile.city, prefs.targetLocationState || profile.state].filter(Boolean).join(', '),
    city: prefs.targetLocationCity || profile.city || '',
    state: prefs.targetLocationState || profile.state || '',
    zip: prefs.targetLocationZip || profile.zip || '',
    country: prefs.targetLocationCountry || profile.country || 'United States',
  };
  const targetRadiusMiles = Number(prefs.targetRadiusMiles) || 60;
  const queries = splitSearchTitles(prefs.searchTitles);
  return {
    targetLocation,
    targetRadiusMiles,
    locationStrictness: prefs.locationStrictness || 'hard',
    remotePolicy: prefs.remotePolicy || 'us_or_ca_remote_allowed',
    queries: queries.length ? queries : DEFAULT_SEARCH_TITLES,
  };
}

async function getOneClickPayload() {
  const st = await getLocalStorage(['pja_prefs', 'pja_profile']);
  return Object.assign({}, ONE_CLICK_DEFAULTS, buildOneClickPrefsPayload(st.pja_prefs || {}, st.pja_profile || {}));
}

async function renderOneClickConfig() {
  const el = document.getElementById('one-click-config');
  if (!el) return;
  try {
    const payload = await getOneClickPayload();
    const loc = payload.targetLocation || {};
    const label = loc.label || [loc.city, loc.state].filter(Boolean).join(', ') || 'profile location';
    el.textContent = `Target: ${label}${payload.targetRadiusMiles ? ` · ${payload.targetRadiusMiles} mi` : ''} · ${payload.queries.length} search titles`;
  } catch (_) {
    el.textContent = 'Target: profile-driven search settings';
  }
}

function forceOpenSidebar() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab?.id) return;
    // Try sending to an already-running content script first
    chrome.tabs.sendMessage(tab.id, { type: 'FORCE_OPEN' }, resp => {
      if (!chrome.runtime.lastError && resp?.ok) {
        window.close();
        return;
      }
      // Content script not present — inject all scripts then force-open
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'content/extractors/linkedin.js',
          'content/extractors/indeed.js',
          'content/extractors/glassdoor.js',
          'content/extractors/generic.js',
          'content/autofill.js',
          'content/content.js'
        ]
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('PJA force-open inject error:', chrome.runtime.lastError.message);
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'FORCE_OPEN' });
        window.close();
      });
    });
  });
}

async function startOneClickApply() {
  const btn = document.getElementById('btn-one-click-apply');
  const status = document.getElementById('one-click-status');
  if (!btn || !status) return;
  btn.disabled = true;
  status.textContent = 'Checking extension/profile readiness…';
  status.className = 'one-click-status running';
  try {
    const payload = await getOneClickPayload();
    const preflightResp = await fetch(`${PJA_DEV_SERVER}/one-click-preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const preflight = await preflightResp.json().catch(() => ({}));
    if (!preflightResp.ok || preflight.ok === false) {
      throw new Error((preflight.problems || ['preflight_failed']).join(', '));
    }
    status.textContent = 'Starting source → score → route → apply…';
    const resp = await fetch(`${PJA_DEV_SERVER}/apply-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
      const stage = data.stage ? `${data.stage}: ` : '';
      throw new Error(stage + (data.error || data.apply?.error || data.source?.error || `HTTP ${resp.status}`));
    }
    const apply = data.apply || {};
    const planned = apply.planned != null ? apply.planned : 'ranked';
    const runId = apply.runId ? ` · ${apply.runId}` : '';
    status.textContent = `Started ${planned} job run${runId}.`;
    status.className = 'one-click-status ok';
    setTimeout(refreshOneClickStatus, 1200);
  } catch (e) {
    status.textContent = `Could not start: ${e.message || e}`;
    status.className = 'one-click-status error';
  } finally {
    btn.disabled = false;
  }
}

function formatRunStatus(data) {
  if (!data || data.ok === false) return 'Status unavailable.';
  if (!data.run) {
    return data.clients ? 'No active ranked run. Ready to source fresh jobs.' : 'Extension disconnected. Reload it from chrome://extensions.';
  }
  const r = data.run;
  const total = r.total || 0;
  const idx = r.currentIndex != null ? Math.min(r.currentIndex + 1, total || r.currentIndex + 1) : '?';
  const job = r.currentJob ? ` · ${r.currentJob.company} — ${r.currentJob.title}` : '';
  const blocked = data.blocked && data.blocked.records ? ` · blocked ${data.blocked.records}` : '';
  return `${r.status}: ${idx}/${total} · confirmed ${r.confirmed}, failed ${r.failed}, skipped ${r.skipped}${blocked}${job}`;
}

async function refreshOneClickStatus() {
  const status = document.getElementById('one-click-status');
  if (!status) return;
  try {
    const resp = await fetch(`${PJA_DEV_SERVER}/apply-status`);
    const data = await resp.json().catch(() => ({}));
    status.textContent = formatRunStatus(data);
    status.className = data && data.run && data.run.status === 'exhausted'
      ? 'one-click-status ok'
      : data && data.ok !== false ? 'one-click-status' : 'one-click-status error';
  } catch (e) {
    status.textContent = `Status unavailable: ${e.message || e}`;
    status.className = 'one-click-status error';
  }
}

async function exportOneClickReport() {
  const btn = document.getElementById('btn-one-click-report');
  const status = document.getElementById('one-click-status');
  if (btn) btn.disabled = true;
  if (status) {
    status.textContent = 'Exporting sanitized apply report…';
    status.className = 'one-click-status running';
  }
  try {
    const resp = await fetch(`${PJA_DEV_SERVER}/export-apply-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) throw new Error(data.error || `HTTP ${resp.status}`);
    if (status) {
      status.textContent = `Report exported: ${data.file}`;
      status.className = 'one-click-status ok';
    }
  } catch (e) {
    if (status) {
      status.textContent = `Report export failed: ${e.message || e}`;
      status.className = 'one-click-status error';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

loadJobs();
loadContacts();
renderOneClickConfig();
refreshOneClickStatus();
chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });

// ── Pipeline ──────────────────────────────────────────────────────────────────
function loadJobs() {
  chrome.runtime.sendMessage({ type: 'GET_JOBS' }, resp => {
    allJobs = (resp?.jobs || []).sort((a, b) => b.savedAt - a.savedAt);
    renderJobs();
    renderReminders();
    updateFooter();
  });
}

function renderJobs() {
  const list = document.getElementById('job-list');
  const now = Date.now();
  const filtered = activeFilter === 'All' ? allJobs : allJobs.filter(j => j.status === activeFilter);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="emoji">${activeFilter === 'Shortlisted' ? '⭐' : activeFilter === 'All' ? '📋' : '🔍'}</div>
      <h3>${activeFilter === 'All' ? 'No jobs saved yet' : 'No ' + activeFilter + ' jobs'}</h3>
      <p>${activeFilter === 'All'
        ? 'Visit a job posting on LinkedIn, Indeed, or Glassdoor.'
        : activeFilter === 'Shortlisted'
        ? 'Save a job and set its status to Shortlisted to track who to reach out to.'
        : 'Change the filter to see other jobs.'}</p>
    </div>`;
    return;
  }
  list.innerHTML = filtered.map(job => jobCardHTML(job, now)).join('');
  wireJobEvents(list);
}

function jobCardHTML(job, now) {
  const isReminder = job.status === 'Outreach Sent' && !job.reminderDismissed &&
    job.statusUpdatedAt && (now - job.statusUpdatedAt) >= SEVEN_DAYS;
  const score = job.fitScore || null;
  const scoreClass = score >= 75 ? 'score-high' : score >= 55 ? 'score-mid' : 'score-low';
  const sc = STATUS_COLORS[job.status] || { bg: '#f3f4f6', text: '#374151' };
  const daysAgo = Math.floor((now - job.savedAt) / 86400000);
  const dateStr = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo}d ago`;
  const statusOpts = JOB_STATUSES.map(s =>
    `<option value="${s}" ${s === job.status ? 'selected' : ''}>${s}</option>`).join('');
  const contact = job.contact || {};
  const hasContact = !!(contact.name || contact.linkedin || contact.email);
  const outreachMsg = job.dmMessage || '';

  return `
<div class="job-card ${isReminder ? 'reminder' : ''} ${job.status === 'Shortlisted' ? 'shortlisted' : ''}" data-id="${esc(job.id)}">
  <div class="job-card-top">
    <div class="job-card-info">
      <div class="job-title" title="${esc(job.title)}">${esc(job.title)}</div>
      <div class="job-company">${esc(job.company)}</div>
    </div>
    ${score !== null ? `<div class="job-score ${scoreClass}">${score}</div>` : ''}
  </div>
  <div class="job-card-bottom">
    <div class="job-meta">
      <span class="status-badge" style="background:${sc.bg};color:${sc.text}">${esc(job.status)}</span>
      <span class="job-date">${dateStr}</span>
      ${hasContact ? `<span class="contact-chip">👤 ${esc(contact.name || 'Contact saved')}</span>` : ''}
      ${isReminder ? `<span class="reminder-flag">⏰ Follow up!</span>` : ''}
    </div>
    <div class="job-actions">
      <select class="status-select" data-id="${esc(job.id)}">${statusOpts}</select>
      <button class="btn-contact ${hasContact ? 'has-contact' : ''}" data-id="${esc(job.id)}" title="${hasContact ? 'Edit contact' : 'Add contact'}">👤</button>
      <a href="${esc(job.url)}" target="_blank" class="btn-open" title="Open job posting">↗</a>
      <button class="btn-delete" data-id="${esc(job.id)}" title="Delete">🗑</button>
    </div>
  </div>
  ${job.status === 'Needs Info' ? (() => {
    const fields = job.missingFields?.length ? job.missingFields
      : (job.description || '').startsWith('Missing required fields:')
        ? job.description.replace('Missing required fields: ', '').split('; ').filter(Boolean)
        : [];
    const reason = job.skipReason || job.description || '';
    const label = fields.length ? '⚠ Fill these to apply:' : '⚠ Blocked — could not complete:';
    const body = fields.length
      ? fields.map(f => `<div class="needs-info-field">• ${esc(f)}</div>`).join('')
      : `<div class="needs-info-field">${esc(reason)}</div>`;
    return `<div class="needs-info-box">
      <div class="needs-info-label">${label}</div>
      ${body}
      <a href="${esc(job.url)}" target="_blank" class="btn-retry-apply">↩ Open &amp; Retry Apply</a>
    </div>`;
  })() : ''}
  ${isReminder ? `<div style="padding-top:4px">
    <button class="filter-btn" style="font-size:11px;padding:3px 10px" data-dismiss="${esc(job.id)}">Dismiss reminder</button>
  </div>` : ''}
  <div class="contact-panel" id="cp-${esc(job.id)}" style="display:none">
    <div class="contact-grid">
      <input class="contact-input" data-field="name"     placeholder="Recruiter / HM name"  value="${esc(contact.name || '')}">
      <input class="contact-input" data-field="linkedin" placeholder="LinkedIn URL"           value="${esc(contact.linkedin || '')}">
      <input class="contact-input" data-field="email"    placeholder="Email address"          value="${esc(contact.email || '')}">
      <textarea class="contact-notes" data-field="notes" placeholder="Notes…" rows="2">${esc(contact.notes || '')}</textarea>
    </div>
    ${outreachMsg ? `<div class="contact-outreach">
      <div class="contact-outreach-label">Outreach message ready:</div>
      <div class="contact-outreach-text">${esc(outreachMsg)}</div>
      <button class="btn-copy-outreach" data-msg="${esc(outreachMsg)}">Copy DM</button>
    </div>` : ''}
    <div class="contact-panel-actions">
      <button class="btn-save-contact" data-id="${esc(job.id)}">Save contact</button>
      <button class="btn-cancel-contact" data-id="${esc(job.id)}">Cancel</button>
    </div>
  </div>
</div>`;
}

function wireJobEvents(list) {
  list.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.id;
      chrome.runtime.sendMessage({ type: 'UPDATE_JOB_STATUS', jobId: id, status: sel.value }, () => {
        const job = allJobs.find(j => j.id === id);
        if (job) { job.status = sel.value; job.statusUpdatedAt = Date.now(); job.reminderDismissed = false; }
        renderJobs(); renderReminders();
        chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
      });
    });
  });
  list.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this job from your pipeline?')) return;
      chrome.runtime.sendMessage({ type: 'DELETE_JOB', jobId: btn.dataset.id }, () => {
        allJobs = allJobs.filter(j => j.id !== btn.dataset.id);
        renderJobs(); renderReminders(); updateFooter();
        chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
      });
    });
  });
  list.querySelectorAll('[data-dismiss]').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'DISMISS_REMINDER', jobId: btn.dataset.dismiss }, () => {
        const job = allJobs.find(j => j.id === btn.dataset.dismiss);
        if (job) job.reminderDismissed = true;
        renderJobs(); renderReminders();
        chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
      });
    });
  });
  list.querySelectorAll('.btn-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('cp-' + btn.dataset.id);
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
  });
  list.querySelectorAll('.btn-save-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const panel = document.getElementById('cp-' + id);
      const contact = {};
      panel.querySelectorAll('[data-field]').forEach(el => { contact[el.dataset.field] = el.value.trim(); });
      chrome.runtime.sendMessage({ type: 'UPDATE_JOB_CONTACT', jobId: id, contact }, () => {
        const job = allJobs.find(j => j.id === id);
        if (job) job.contact = contact;
        renderJobs();
      });
    });
  });
  list.querySelectorAll('.btn-cancel-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('cp-' + btn.dataset.id);
      if (panel) panel.style.display = 'none';
    });
  });
  list.querySelectorAll('.btn-copy-outreach').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.msg).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      });
    });
  });
}

function renderReminders() {
  const now = Date.now();
  const reminders = allJobs.filter(j =>
    j.status === 'Outreach Sent' && !j.reminderDismissed &&
    j.statusUpdatedAt && (now - j.statusUpdatedAt) >= SEVEN_DAYS
  );
  const banner = document.getElementById('reminder-banner');
  document.getElementById('reminder-text').textContent =
    `${reminders.length} job${reminders.length > 1 ? 's' : ''} need${reminders.length === 1 ? 's' : ''} a follow-up (7+ days since outreach)`;
  banner.style.display = reminders.length > 0 ? 'flex' : 'none';
}

// ── Contacts ──────────────────────────────────────────────────────────────────
function loadContacts() {
  chrome.runtime.sendMessage({ type: 'GET_CONTACTS' }, resp => {
    allContacts = (resp?.contacts || []).sort((a, b) => {
      // Sort: To Contact first, then by createdAt desc
      const order = { 'To Contact': 0, 'Contacted': 1, 'Responded': 2, 'In Progress': 3, 'Closed': 4 };
      const od = (order[a.status] ?? 5) - (order[b.status] ?? 5);
      return od !== 0 ? od : b.createdAt - a.createdAt;
    });
    renderContacts();
    updateFooter();
  });
}

function renderContacts() {
  const list = document.getElementById('contact-list');
  const filtered = activeContactFilter === 'All'
    ? allContacts
    : allContacts.filter(c => c.status === activeContactFilter);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="emoji">👥</div>
      <h3>${activeContactFilter === 'All' ? 'No contacts yet' : 'No ' + activeContactFilter + ' contacts'}</h3>
      <p>${activeContactFilter === 'All'
        ? 'Track recruiters, hiring managers, and referrals — independently of job postings.'
        : 'Change the filter to see other contacts.'}</p>
    </div>`;
    return;
  }
  list.innerHTML = filtered.map(c => contactCardHTML(c)).join('');
  wireContactEvents(list);
}

function contactCardHTML(c) {
  const sc = CONTACT_STATUS_COLORS[c.status] || { bg: '#f3f4f6', text: '#6b7280' };
  const statusOpts = CONTACT_STATUSES.map(s =>
    `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s}</option>`).join('');
  const daysAgo = Math.floor((Date.now() - c.createdAt) / 86400000);
  const addedStr = daysAgo === 0 ? 'Added today' : daysAgo === 1 ? 'Added yesterday' : `Added ${daysAgo}d ago`;
  const targetStr = c.targetDate ? `📅 ${formatDate(c.targetDate)}` : '';
  const overdue = c.targetDate && c.status === 'To Contact' && new Date(c.targetDate) < new Date() && c.status !== 'Closed';

  return `
<div class="contact-card ${overdue ? 'overdue' : ''}" data-cid="${esc(c.id)}">
  <div class="contact-card-header">
    <div class="contact-card-info">
      <div class="contact-name">${esc(c.name)}</div>
      <div class="contact-role">${[c.title, c.company].filter(Boolean).map(esc).join(' · ') || ''}</div>
    </div>
    <span class="status-badge" style="background:${sc.bg};color:${sc.text}">${esc(c.status)}</span>
  </div>

  <div class="contact-card-meta">
    ${targetStr ? `<span class="${overdue ? 'target-overdue' : 'target-date'}">${targetStr}${overdue ? ' · overdue' : ''}</span>` : ''}
    <span class="contact-added">${addedStr}</span>
    ${c.howKnown ? `<span class="contact-howknown">via ${esc(c.howKnown)}</span>` : ''}
  </div>

  ${c.notes ? `<div class="contact-notes-preview">${esc(c.notes)}</div>` : ''}

  <div class="contact-card-links">
    ${c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank" class="contact-link">LinkedIn ↗</a>` : ''}
    ${c.email ? `<a href="mailto:${esc(c.email)}" class="contact-link">Email ↗</a>` : ''}
  </div>

  <div class="contact-card-actions">
    <select class="contact-status-select" data-cid="${esc(c.id)}">${statusOpts}</select>
    <button class="btn-edit-contact" data-cid="${esc(c.id)}">Edit</button>
    <button class="btn-delete-contact" data-cid="${esc(c.id)}">🗑</button>
  </div>

  <!-- Edit form -->
  <div class="contact-edit-form" id="cef-${esc(c.id)}" style="display:none">
    <div class="acf-grid">
      <input class="acf-input cef-name"     placeholder="Name *"         value="${esc(c.name || '')}">
      <input class="acf-input cef-company"  placeholder="Company"        value="${esc(c.company || '')}">
      <input class="acf-input cef-title"    placeholder="Title / Role"   value="${esc(c.title || '')}">
      <input class="acf-input cef-linkedin" placeholder="LinkedIn URL"   value="${esc(c.linkedin || '')}">
      <input class="acf-input cef-email"    placeholder="Email address"  value="${esc(c.email || '')}">
      <input class="acf-input cef-howknown" placeholder="How you know them" value="${esc(c.howKnown || '')}">
      <div class="acf-row">
        <select class="acf-input acf-select cef-status">
          ${CONTACT_STATUSES.map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input class="acf-input cef-target" type="date" value="${esc(c.targetDate || '')}">
      </div>
      <textarea class="acf-textarea cef-notes" placeholder="Notes…" rows="2">${esc(c.notes || '')}</textarea>
    </div>
    <div class="acf-actions">
      <button class="btn-acf-save btn-cef-save" data-cid="${esc(c.id)}">Save</button>
      <button class="btn-acf-cancel btn-cef-cancel" data-cid="${esc(c.id)}">Cancel</button>
    </div>
  </div>
</div>`;
}

function wireContactEvents(list) {
  list.querySelectorAll('.contact-status-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.cid;
      const contact = allContacts.find(c => c.id === id);
      if (contact) { contact.status = sel.value; contact.updatedAt = Date.now(); }
      chrome.runtime.sendMessage({ type: 'UPDATE_CONTACT', contact: allContacts.find(c => c.id === id) }, () => {
        renderContacts(); updateFooter();
      });
    });
  });

  list.querySelectorAll('.btn-edit-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById('cef-' + btn.dataset.cid);
      if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
  });

  list.querySelectorAll('.btn-cef-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cid;
      const form = document.getElementById('cef-' + id);
      const contact = allContacts.find(c => c.id === id);
      if (!contact) return;
      contact.name      = form.querySelector('.cef-name').value.trim();
      contact.company   = form.querySelector('.cef-company').value.trim();
      contact.title     = form.querySelector('.cef-title').value.trim();
      contact.linkedin  = form.querySelector('.cef-linkedin').value.trim();
      contact.email     = form.querySelector('.cef-email').value.trim();
      contact.howKnown  = form.querySelector('.cef-howknown').value.trim();
      contact.status    = form.querySelector('.cef-status').value;
      contact.targetDate = form.querySelector('.cef-target').value;
      contact.notes     = form.querySelector('.cef-notes').value.trim();
      contact.updatedAt = Date.now();
      if (!contact.name) return;
      chrome.runtime.sendMessage({ type: 'UPDATE_CONTACT', contact }, () => renderContacts());
    });
  });

  list.querySelectorAll('.btn-cef-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = document.getElementById('cef-' + btn.dataset.cid);
      if (form) form.style.display = 'none';
    });
  });

  list.querySelectorAll('.btn-delete-contact').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this contact?')) return;
      chrome.runtime.sendMessage({ type: 'DELETE_CONTACT', contactId: btn.dataset.cid }, () => {
        allContacts = allContacts.filter(c => c.id !== btn.dataset.cid);
        renderContacts(); updateFooter();
      });
    });
  });
}

function saveNewContact() {
  const name = document.getElementById('acf-name').value.trim();
  if (!name) { document.getElementById('acf-name').focus(); return; }
  const contact = {
    id: 'contact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name,
    company:    document.getElementById('acf-company').value.trim(),
    title:      document.getElementById('acf-title').value.trim(),
    linkedin:   document.getElementById('acf-linkedin').value.trim(),
    email:      document.getElementById('acf-email').value.trim(),
    howKnown:   document.getElementById('acf-howknown').value.trim(),
    status:     document.getElementById('acf-status').value,
    targetDate: document.getElementById('acf-target').value,
    notes:      document.getElementById('acf-notes').value.trim(),
    createdAt:  Date.now(),
    updatedAt:  Date.now()
  };
  chrome.runtime.sendMessage({ type: 'SAVE_CONTACT', contact }, () => {
    allContacts.unshift(contact);
    clearAddForm();
    document.getElementById('add-contact-form').style.display = 'none';
    renderContacts(); updateFooter();
  });
}

function clearAddForm() {
  ['acf-name','acf-company','acf-title','acf-linkedin','acf-email','acf-howknown','acf-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('acf-status').value = 'To Contact';
  document.getElementById('acf-target').value = '';
}

// ── Footer ────────────────────────────────────────────────────────────────────
function updateFooter() {
  const footer = document.getElementById('popup-footer');
  if (activeTab === 'pipeline') {
    const shortlisted = allJobs.filter(j => j.status === 'Shortlisted').length;
    const base = `${allJobs.length} job${allJobs.length !== 1 ? 's' : ''} tracked`;
    footer.textContent = shortlisted > 0 ? `${base} · ${shortlisted} shortlisted` : base;
  } else {
    const toContact = allContacts.filter(c => c.status === 'To Contact').length;
    const base = `${allContacts.length} contact${allContacts.length !== 1 ? 's' : ''}`;
    footer.textContent = toContact > 0 ? `${base} · ${toContact} to reach out` : base;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Search panel ──────────────────────────────────────────────────────────────
const LI_BASE = 'https://www.linkedin.com/jobs/search/?keywords=';
const LI_LOC  = '&location=California%2C+United+States&distance=50&f_WT=2%2C1'; // remote+onsite, CA

const SEARCH_LINKS = {
  tech: [
    { label: 'Senior Metrology Technician',        kw: 'metrology technician semiconductor',         score: 90, icon: '🎯' },
    { label: 'Wafer Inspection Technician',         kw: 'wafer inspection technician',                score: 90, icon: '🎯' },
    { label: 'Quality Technician — Semiconductor',  kw: 'quality technician semiconductor clean room', score: 85, icon: '✅' },
    { label: 'Quality Technician — Medical Device', kw: 'quality technician medical device GMP',      score: 82, icon: '✅' },
    { label: 'Process Technician — Wafer Fab',      kw: 'process technician wafer fab photolithography', score: 80, icon: '✅' },
    { label: 'Inspection / QC Technician',          kw: 'inspection quality control technician semiconductor', score: 78, icon: '✅' },
  ],
  eng: [
    { label: 'Quality Engineer — Semiconductor',    kw: 'quality engineer semiconductor SPC',         score: 55, icon: '📈' },
    { label: 'Quality Engineer — Medical Device',   kw: 'quality engineer medical device GMP',        score: 50, icon: '📈' },
    { label: 'Metrology Engineer',                  kw: 'metrology engineer thin film wafer',         score: 60, icon: '📈' },
    { label: 'Manufacturing Engineer — Wafer Fab',  kw: 'manufacturing engineer wafer fab clean room', score: 45, icon: '📈' },
  ]
};

function renderSearchPanel() {
  chrome.storage.local.get('pja_shortlist', r => {
    const shortlist = r.pja_shortlist || [];
    const pending = shortlist.filter(j => j.status === 'pending').length;
    const bar = document.getElementById('search-shortlist-bar');
    const count = document.getElementById('search-shortlist-count');
    if (pending > 0) {
      bar.style.display = 'flex';
      count.textContent = `${pending} job${pending !== 1 ? 's' : ''} ready to review`;
    } else {
      bar.style.display = 'none';
    }
  });

  renderSearchGroup('search-links-tech', SEARCH_LINKS.tech);
  renderSearchGroup('search-links-eng',  SEARCH_LINKS.eng);
}

function renderSearchGroup(containerId, links) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = links.map(link => {
    const url = LI_BASE + encodeURIComponent(link.kw) + LI_LOC;
    const scoreClass = link.score >= 75 ? 'score-tag-hi' : 'score-tag-mid';
    return `
      <div class="search-link-row">
        <a class="search-link-btn" href="${url}" target="_blank">
          <span>${link.icon}</span>
          <span>${link.label}</span>
        </a>
        <span class="search-link-score ${scoreClass}">${link.score}</span>
      </div>`;
  }).join('');
}

document.getElementById('btn-view-shortlist-search')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('shortlist/shortlist.html') });
});
