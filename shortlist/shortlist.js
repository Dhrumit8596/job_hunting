'use strict';

let allJobs = [];
let activeFilter = 'pending';
let _savingLocally = false;  // guard: prevents onChanged from stomping our own writes

// ── Load & render ─────────────────────────────────────────────────────────────
function dedupeById(arr) {
  const seen = new Map();
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item?.id && !seen.has(item.id)) seen.set(item.id, item);
  }
  return Array.from(seen.values()).reverse();
}

function load() {
  chrome.storage.local.get('pja_shortlist', r => {
    const raw = r.pja_shortlist || [];
    const deduped = dedupeById(raw);
    // Auto-persist if we cleaned any duplicates (guard prevents onChanged re-render)
    if (deduped.length !== raw.length) {
      _savingLocally = true;
      chrome.storage.local.set({ pja_shortlist: deduped }, () => { _savingLocally = false; });
    }
    allJobs = deduped;
    render();
  });
}

function render() {
  updateStats();
  const filtered = activeFilter === 'all' ? allJobs : allJobs.filter(j => j.status === activeFilter);
  const list = document.getElementById('job-list');
  const empty = document.getElementById('empty-state');

  if (filtered.length === 0) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Sort: highest score first within each group
  filtered.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  list.innerHTML = filtered.map(job => jobCardHTML(job)).join('');
  attachCardListeners();
}

function updateStats() {
  const counts = { pending: 0, approved: 0, applying: 0, done: 0, skipped: 0 };
  allJobs.forEach(j => { if (counts[j.status] !== undefined) counts[j.status]++; });
  Object.entries(counts).forEach(([k, v]) => {
    const el = document.getElementById('stat-' + k);
    if (el) el.textContent = v;
  });
}

// ── Job card HTML ─────────────────────────────────────────────────────────────
function jobCardHTML(job) {
  const score = job.fitScore ?? null;
  const scoreClass = score >= 75 ? 'score-hi' : score >= 55 ? 'score-mid' : 'score-lo';
  const scoreHTML = score !== null
    ? `<div class="score-circle ${scoreClass}">${score}</div>`
    : `<div class="score-circle score-lo"><span class="spinner"></span></div>`;

  const skills = (job.matchedSkills || []).slice(0, 5).map(s =>
    `<span class="chip">${esc(s)}</span>`).join('');
  const gaps = (job.gaps || []).slice(0, 3).map(g =>
    `<span class="chip chip-gap">${esc(g)}</span>`).join('');

  const badge = `<span class="status-badge badge-${job.status}">${job.status}</span>`;

  const desc = job.description
    ? `<div class="job-desc-toggle" data-id="${job.id}">▾ Show description</div>
       <div class="job-desc" id="desc-${job.id}">${esc(job.description.slice(0, 800))}…</div>`
    : '';

  const actions = actionsHTML(job);

  return `
    <div class="job-card status-${job.status}" data-id="${job.id}">
      <div class="job-card-top">
        <div>
          <div class="job-title">${esc(job.title)}</div>
          <div class="job-company">${esc(job.company)}${job.location ? ' · ' + esc(job.location) : ''}</div>
          <div style="margin-top:6px">${badge}</div>
        </div>
        ${scoreHTML}
      </div>
      ${skills || gaps ? `<div class="skill-chips">${skills}${gaps}</div>` : ''}
      ${desc}
      <div class="job-card-actions">${actions}</div>
    </div>`;
}

function actionsHTML(job) {
  if (job.status === 'scoring') {
    return `<div class="scoring-row"><span class="spinner"></span> Scoring with Claude…</div>`;
  }
  if (job.status === 'pending') {
    return `
      <button class="btn btn-primary btn-sm" data-action="approve" data-id="${job.id}">✓ Approve</button>
      <button class="btn btn-outline btn-sm" data-action="skip" data-id="${job.id}">Skip</button>
      <a class="btn btn-outline btn-sm" href="${job.url}" target="_blank">View Job ↗</a>`;
  }
  if (job.status === 'approved') {
    return `
      <button class="btn btn-success btn-sm" data-action="apply" data-id="${job.id}">⚡ Apply</button>
      <button class="btn btn-outline btn-sm" data-action="outreach" data-id="${job.id}">✉ Outreach</button>
      <button class="btn btn-outline btn-sm" data-action="skip" data-id="${job.id}">Skip</button>
      <a class="btn btn-outline btn-sm" href="${job.url}" target="_blank">View ↗</a>`;
  }
  if (job.status === 'applying') {
    return `
      <span style="font-size:13px;color:#92400e">⚡ Application opened — submit when ready</span>
      <button class="btn btn-outline btn-sm" data-action="mark-done" data-id="${job.id}">Mark Applied</button>`;
  }
  if (job.status === 'done') {
    return `<span style="font-size:12px;color:#059669">✓ Applied</span>
      <a class="btn btn-outline btn-sm" href="${job.url}" target="_blank">View ↗</a>`;
  }
  if (job.status === 'skipped') {
    return `<button class="btn btn-outline btn-sm" data-action="approve" data-id="${job.id}">Restore</button>`;
  }
  return `<a class="btn btn-outline btn-sm" href="${job.url}" target="_blank">View ↗</a>`;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Card event listeners ──────────────────────────────────────────────────────
function attachCardListeners() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      handleAction(action, id, btn);
    });
  });

  document.querySelectorAll('.job-desc-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const id = toggle.dataset.id;
      const desc = document.getElementById('desc-' + id);
      if (desc) {
        const open = desc.style.display === 'block';
        desc.style.display = open ? 'none' : 'block';
        toggle.textContent = (open ? '▾' : '▴') + ' ' + (open ? 'Show' : 'Hide') + ' description';
      }
    });
  });
}

function handleAction(action, id, btn) {
  const job = allJobs.find(j => j.id === id);
  if (!job) return;

  if (action === 'approve') {
    updateJobStatus(id, 'approved');
  } else if (action === 'skip') {
    updateJobStatus(id, 'skipped');
  } else if (action === 'mark-done') {
    updateJobStatus(id, 'done');
  } else if (action === 'apply') {
    startApply(job, btn);
  } else if (action === 'outreach') {
    openOutreachPanel(job);
  }
}

function updateJobStatus(id, status) {
  allJobs = allJobs.map(j => j.id === id ? { ...j, status } : j);
  _savingLocally = true;
  chrome.storage.local.set({ pja_shortlist: allJobs }, () => {
    _savingLocally = false;
    render();
  });
}

// ── Apply flow ────────────────────────────────────────────────────────────────
function startApply(job, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  updateJobStatus(job.id, 'applying');
  // chrome.tabs.create is not available in extension pages opened via
  // chrome.runtime.getURL — send a message to the background service worker
  // to open the tab and trigger autofill from there.
  chrome.runtime.sendMessage({ type: 'OPEN_APPLY_TAB', url: job.url, triggerAutofill: true });
}

// ── Outreach panel ────────────────────────────────────────────────────────────
function openOutreachPanel(job) {
  const panel = document.getElementById('outreach-panel');
  const overlay = document.getElementById('overlay');
  const body = document.getElementById('op-body');
  const title = document.getElementById('op-title');

  title.textContent = `Outreach — ${job.title} @ ${job.company}`;
  body.innerHTML = '<div class="loading-state"><span class="spinner"></span> Finding recruiters & HMs…</div>';
  panel.style.display = 'flex';
  overlay.style.display = 'block';

  // Use cached outreach data if available
  if (job.outreachPeople && job.outreachPeople.length > 0) {
    renderOutreachPanel(job, job.outreachPeople);
    return;
  }

  // Ask background to find people + generate messages
  chrome.runtime.sendMessage(
    { type: 'FIND_OUTREACH_PEOPLE', job },
    resp => {
      if (chrome.runtime.lastError || !resp?.success) {
        body.innerHTML = `<div class="loading-state" style="color:#dc2626">Error: ${resp?.error || 'Failed to find people'}</div>`;
        return;
      }
      // Cache on the job
      allJobs = allJobs.map(j => j.id === job.id ? { ...j, outreachPeople: resp.people, dmMessage: resp.dmMessage, emailMessage: resp.emailMessage } : j);
      chrome.storage.local.set({ pja_shortlist: allJobs });
      renderOutreachPanel(job, resp.people, resp.dmMessage, resp.emailMessage);
    }
  );
}

function renderOutreachPanel(job, people, dmMessage, emailMessage) {
  const body = document.getElementById('op-body');
  const dm = dmMessage || job.dmMessage || '';
  const email = emailMessage || job.emailMessage || '';

  const peopleHTML = (people || []).map(p => `
    <div class="person-card">
      <div class="person-name">${esc(p.name)}</div>
      <div class="person-title">${esc(p.title)}</div>
      <span class="person-role-badge">${p.role === 'recruiter' ? '🎯 Recruiter' : '👤 Hiring Manager'}</span>
      ${p.url ? `<div style="margin-top:6px"><a href="${p.url}" target="_blank" style="font-size:12px;color:#6366f1">LinkedIn Profile ↗</a></div>` : ''}
    </div>
  `).join('') || '<p style="color:#6b7280;font-size:13px">No specific people found — use the DM below for a cold reach.</p>';

  body.innerHTML = `
    <h3 style="font-size:14px;font-weight:700;margin-bottom:10px">People to Contact</h3>
    ${peopleHTML}

    <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">LinkedIn DM</h3>
    <div class="msg-box" id="dm-box">${esc(dm)}</div>
    <div class="msg-actions">
      <button class="btn btn-outline btn-sm" id="copy-dm-btn">Copy DM</button>
      <span style="font-size:11px;color:#9ca3af">${dm.length} chars</span>
    </div>

    <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">Cold Email</h3>
    <div class="msg-box" id="email-box">${esc(email)}</div>
    <div class="msg-actions">
      <button class="btn btn-outline btn-sm" id="copy-email-btn">Copy Email</button>
    </div>

    ${people?.length > 0 ? `
    <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">LinkedIn Search</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn btn-outline btn-sm" href="https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('recruiter ' + job.company)}&origin=GLOBAL_SEARCH_HEADER" target="_blank">Search Recruiters ↗</a>
      <a class="btn btn-outline btn-sm" href="https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('hiring manager ' + job.company)}&origin=GLOBAL_SEARCH_HEADER" target="_blank">Search HMs ↗</a>
    </div>` : ''}
  `;

  document.getElementById('copy-dm-btn')?.addEventListener('click', () => copyText(dm, 'copy-dm-btn'));
  document.getElementById('copy-email-btn')?.addEventListener('click', () => copyText(email, 'copy-email-btn'));
}

function copyText(text, btnId) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(btnId);
    if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = orig, 1800); }
  });
}

// ── Filter tabs ───────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    render();
  });
});

// ── Clear buttons ─────────────────────────────────────────────────────────────
document.getElementById('btn-clear-done')?.addEventListener('click', () => {
  allJobs = allJobs.filter(j => j.status !== 'done' && j.status !== 'skipped');
  _savingLocally = true;
  chrome.storage.local.set({ pja_shortlist: allJobs }, () => { _savingLocally = false; render(); });
});
document.getElementById('btn-clear-all')?.addEventListener('click', () => {
  if (!confirm('Clear all shortlisted jobs?')) return;
  allJobs = [];
  _savingLocally = true;
  chrome.storage.local.set({ pja_shortlist: [] }, () => { _savingLocally = false; render(); });
});

// ── Outreach panel close ──────────────────────────────────────────────────────
document.getElementById('op-close')?.addEventListener('click', () => {
  document.getElementById('outreach-panel').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
});
document.getElementById('overlay')?.addEventListener('click', () => {
  document.getElementById('outreach-panel').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
});

// ── Live updates from background scoring ─────────────────────────────────────
// Skip updates triggered by our own writes (_savingLocally guard) so that
// in-flight status changes are not overwritten by the round-trip echo.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.pja_shortlist && !_savingLocally) {
    allJobs = dedupeById(changes.pja_shortlist.newValue || []);
    render();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
load();
