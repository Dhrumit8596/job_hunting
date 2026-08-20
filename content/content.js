'use strict';

// FORCE_OPEN listener lives outside the loaded-guard so it fires even on pages
// where the IIFE already ran but found no job
if (!window.__pjaMsgListenerAdded) {
  window.__pjaMsgListenerAdded = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FORCE_OPEN') {
      if (typeof window.__pjaForceOpen === 'function') window.__pjaForceOpen();
      sendResponse({ ok: true });
    }
    if (msg.type === 'AUTOFILL_TRIGGER') {
      if (typeof window.__pjaHandleAutofill === 'function') window.__pjaHandleAutofill();
      sendResponse({ ok: true });
    }
  });

  // Tightly-scoped page→storage bridge: lets a page-world script (which has no chrome.storage)
  // hand the content script LinkedIn voyager-resolved apply data to stash for the sourcing
  // pipeline. ONLY accepts the single pja_voyager_ext key, and only an array payload.
  window.addEventListener('pja_bridge_store', (e) => {
    try {
      const d = e && e.detail;
      if (d && d.key === 'pja_voyager_ext' && Array.isArray(d.value)) {
        chrome.storage.local.set({ pja_voyager_ext: d.value.slice(0, 200) });
      }
    } catch (_) {}
  });
}

(function () {
  if (window.__pjaLoaded) return;
  window.__pjaLoaded = true;

  // ── Constants ────────────────────────────────────────────────────────────
  const STATUSES = ['Bookmarked', 'Shortlisted', 'Applied', 'Outreach Sent', 'Interview', 'Offer', 'Rejected'];

  let currentAnalysis = null;
  let currentJobData = null;
  let activeTab = 'dm';
  let sidebarOpen = false;
  let shadow = null;
  let learningActive = false;
  let learnCallbacks = null; // persisted so navigation can re-attach
  let activeEasyApplyResumeKey = '';

  function isLinkedInApplyRoute(value) {
    try {
      const u = new URL(String(value || location.href));
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
      if (/^\/jobs\/view\//i.test(u.pathname)) return true;
      return /^\/jobs\/(?:search|search-results)\/?$/i.test(u.pathname) &&
        !!u.searchParams.get('currentJobId');
    } catch (_) { return false; }
  }

  // ── LinkedIn profile page: contact-save widget ───────────────────────────
  function isLinkedInProfile() {
    return /linkedin\.com\/in\/[^\/]+/.test(location.href);
  }

  function isExternalAtsPage() {
    return /(?:^|\.)(workday\.com|myworkdayjobs\.com)$/i.test(location.hostname) ||
      /(?:^|\.)(greenhouse\.io|lever\.co|jobvite\.com|icims\.com|ashbyhq\.com|smartrecruiters\.com|bamboohr\.com|rippling\.com)$/i.test(location.hostname);
  }

  function maybeAutoOpenSidebar() {
    if (!isExternalAtsPage()) openSidebar();
    else closeSidebar();
  }

  function extractLinkedInProfile() {
    const name =
      document.querySelector('h1.text-heading-xlarge')?.textContent.trim() ||
      document.querySelector('h1[class*="inline"]')?.textContent.trim() || '';

    const headline =
      document.querySelector('.text-body-medium.break-words')?.textContent.trim() ||
      document.querySelector('[class*="text-body-medium"][class*="break-words"]')?.textContent.trim() || '';

    let title = '', company = '';
    const atMatch  = headline.match(/^(.+?)\s+at\s+(.+)$/i);
    const dotMatch = headline.match(/^(.+?)\s+[·•|]\s+(.+)$/);
    if      (atMatch)  { title = atMatch[1].trim();  company = atMatch[2].split(/\s+at\s+/i)[0].trim(); }
    else if (dotMatch) { title = dotMatch[1].trim(); company = dotMatch[2].trim(); }
    else               { title = headline; }

    return { name, title, company, linkedin: location.href.split('?')[0].replace(/\/$/, '') };
  }

  function injectProfileWidget() {
    const profile = extractLinkedInProfile();
    if (!profile.name) return;

    chrome.runtime.sendMessage({ type: 'GET_CONTACTS' }, resp => {
      const contacts = resp?.contacts || [];
      const existing = contacts.find(c =>
        c.linkedin && c.linkedin.replace(/\/$/, '') === profile.linkedin.replace(/\/$/, '')
      );

      const host = document.createElement('div');
      host.id = 'pja-contact-host';
      host.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:2147483647;width:264px;';
      document.documentElement.appendChild(host);

      const sh = host.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = getWidgetCSS();
      sh.appendChild(styleEl);

      const root = document.createElement('div');
      root.style.position = 'relative';
      root.innerHTML = getWidgetHTML(profile, existing);
      sh.appendChild(root);

      const fab     = sh.getElementById('pcw-fab');
      const panel   = sh.getElementById('pcw-panel');
      const saveBtn = sh.getElementById('pcw-save-btn');

      fab.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
      sh.querySelector('.pcw-close')?.addEventListener('click', () => {
        panel.style.display = 'none';
      });

      saveBtn?.addEventListener('click', () => {
        const a = s => sh.getElementById(s)?.value.trim() || '';
        const contact = {
          id:         existing?.id || ('contact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
          name:       a('pcw-name'),
          title:      a('pcw-job-title'),
          company:    a('pcw-company'),
          linkedin:   profile.linkedin,
          email:      '',
          howKnown:   'LinkedIn profile',
          status:     sh.getElementById('pcw-status')?.value || 'To Contact',
          notes:      '',
          createdAt:  existing?.createdAt || Date.now(),
          updatedAt:  Date.now()
        };
        if (!contact.name) return;
        const type = existing ? 'UPDATE_CONTACT' : 'SAVE_CONTACT';
        chrome.runtime.sendMessage({ type, contact }, () => {
          panel.style.display = 'none';
          fab.textContent = '✓ Saved!';
          fab.className = 'pcw-fab saved';
          setTimeout(() => { fab.textContent = '✓ In Contacts'; }, 2000);
        });
      });
    });
  }

  function getWidgetHTML(profile, existing) {
    const e = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const statusOpts = ['To Contact','Contacted','Responded','In Progress','Closed']
      .map(s => `<option value="${s}"${s === (existing?.status || 'To Contact') ? ' selected' : ''}>${s}</option>`).join('');
    const isSaved = !!existing;
    return `
<div id="pcw-panel" style="display:none">
  <div class="pcw-header">
    <span class="pcw-header-title">💾 Save to Contacts</span>
    <button class="pcw-close">✕</button>
  </div>
  <div class="pcw-body">
    <input class="pcw-input" id="pcw-name"      placeholder="Name"       value="${e(existing?.name    || profile.name)}">
    <input class="pcw-input" id="pcw-job-title" placeholder="Job title"  value="${e(existing?.title   || profile.title)}">
    <input class="pcw-input" id="pcw-company"   placeholder="Company"    value="${e(existing?.company || profile.company)}">
    <input class="pcw-input url" id="pcw-url" value="${e(profile.linkedin)}" readonly title="LinkedIn URL">
    <select class="pcw-input" id="pcw-status">${statusOpts}</select>
  </div>
  <div class="pcw-footer">
    <button class="pcw-save-btn" id="pcw-save-btn">${isSaved ? 'Update Contact' : 'Add to Contacts'}</button>
  </div>
</div>
<button class="pcw-fab${isSaved ? ' saved' : ''}" id="pcw-fab">${isSaved ? '✓ In Contacts' : '👤 Save Contact'}</button>`;
  }

  function getWidgetCSS() {
    return `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.pcw-fab{
  display:flex;align-items:center;gap:6px;margin-left:auto;
  background:#1e40af;color:#fff;border:none;border-radius:20px;
  padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  box-shadow:0 2px 10px rgba(0,0,0,.2);transition:background .15s;
}
.pcw-fab:hover{background:#1d3a9a}
.pcw-fab.saved{background:#16a34a}
.pcw-panel{
  position:absolute;bottom:46px;right:0;width:264px;
  background:#fff;border-radius:10px;
  box-shadow:0 4px 24px rgba(0,0,0,.18);border:1px solid #e5e7eb;overflow:hidden;
}
.pcw-header{
  background:#1e40af;color:#fff;padding:10px 14px;
  display:flex;align-items:center;justify-content:space-between;
}
.pcw-header-title{font-size:13px;font-weight:600;font-family:-apple-system,sans-serif}
.pcw-close{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:16px;padding:0;line-height:1}
.pcw-close:hover{color:#fff}
.pcw-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.pcw-input{
  width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 10px;
  font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  color:#111827;background:#fff;transition:border-color .12s;
}
.pcw-input:focus{outline:none;border-color:#1e40af}
.pcw-input.url{background:#f9fafb;color:#6b7280;font-size:10.5px;cursor:default}
.pcw-input.url:focus{border-color:#d1d5db}
select.pcw-input{cursor:pointer}
.pcw-footer{padding:8px 12px;border-top:1px solid #f3f4f6}
.pcw-save-btn{
  width:100%;background:#1e40af;color:#fff;border:none;border-radius:6px;
  padding:8px;font-size:13px;font-weight:600;cursor:pointer;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;transition:background .15s;
}
.pcw-save-btn:hover{background:#1d3a9a}`;
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    // LinkedIn profile page → show contact-save widget, skip job sidebar
    if (isLinkedInProfile()) {
      injectProfileWidget();
      return;
    }

    // The ranked queue must not depend on a sidebar extractor recognizing LinkedIn's latest DOM.
    // Start it directly from the durable session queue; injectUI/SPA navigation may call the same
    // function again, but the per-run/job key makes those calls idempotent.
    if (isLinkedInApplyRoute(location.href)) resumeApplyOnLoad();

    waitForJob().then(jobData => {
      if (!jobData) {
        // Check if this domain was previously manually triggered → auto-open
        chrome.storage.local.get('pja_custom_domains', r => {
          const host = location.hostname;
          const customs = r.pja_custom_domains || [];
          if (customs.some(d => host === d || host.endsWith('.' + d))) {
            const fallback = {
              title: document.title.slice(0, 120) || host,
              company: host.replace(/^www\./, ''),
              description: ''
            };
            currentJobData = fallback;
            injectUI();
            openSidebar();
            showPreAnalyze(fallback);
            initAppTools();
          }
        });
        return;
      }
      currentJobData = jobData;
      injectUI();
      maybeAutoOpenSidebar();
      showPreAnalyze(jobData);
      initAppTools();
    });

    // Handle SPA navigation (LinkedIn, Indeed use pushState)
    // Also watch currentJobId param — LinkedIn search-results page swaps jobs without changing the path
    let lastUrl = location.href;
    let lastJobId = new URLSearchParams(location.search).get('currentJobId');
    const observer = new MutationObserver(() => {
      const newUrl = location.href;
      const newJobId = new URLSearchParams(location.search).get('currentJobId');
      if (newUrl !== lastUrl || newJobId !== lastJobId) {
        lastUrl = newUrl;
        lastJobId = newJobId;
        handleNavigation();
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  }

  async function handleNavigation() {
    await delay(1500);
    const jobData = tryExtract();
    currentAnalysis = null;
    activeTab = 'dm';

    if (!jobData) {
      // No job on new page — but keep sidebar open and learning active if running
      if (learningActive && document.getElementById('pja-host')) {
        const fallback = {
          title: document.title.slice(0, 120) || location.hostname,
          company: location.hostname.replace(/^www\./, ''),
          description: ''
        };
        currentJobData = fallback;
        showPreAnalyze(fallback);
        updateLearnUI();
      }
      return;
    }

    currentJobData = jobData;
    if (!document.getElementById('pja-host')) injectUI();
    maybeAutoOpenSidebar();
    resetSidebar(jobData);
    initAppTools();
    // LinkedIn can canonicalize `/jobs/search/` to `/jobs/search-results/` through an SPA
    // transition after the content script first initializes. Re-check the durable page queue on
    // every route change; resumeApplyOnLoad owns an idempotency key for the active run/job.
    resumeApplyOnLoad();

    // Restore learning after sidebar reset — the document listener survived, just update UI
    if (learningActive && learnCallbacks) updateLearnUI();
  }

  // ── Wait for job content to settle ──────────────────────────────────────
  async function waitForJob() {
    // Immediate attempt
    let data = tryExtract();
    if (data?.title) return data;

    // Poll up to 5 seconds for SPA content
    for (let i = 0; i < 10; i++) {
      await delay(500);
      data = tryExtract();
      if (data?.title) return data;
    }
    return null;
  }

  function tryExtract() {
    const url = location.href;
    let data = null;

    if (url.includes('linkedin.com')) data = extractLinkedIn();
    else if (url.includes('indeed.com')) data = extractIndeed();
    else if (url.includes('glassdoor.com')) data = extractGlassdoor();

    if (!data?.title) data = extractGeneric();
    return data?.title ? data : null;
  }

  // ── Sidebar injection ────────────────────────────────────────────────────
  function injectUI() {
    if (document.getElementById('pja-host')) return;

    // Shadow host
    const host = document.createElement('div');
    host.id = 'pja-host';
    host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:0;z-index:auto;pointer-events:none;';
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getSidebarCSS();
    shadow.appendChild(style);

    const container = document.createElement('div');
    container.id = 'pja-root';
    container.innerHTML = getSidebarHTML();
    shadow.appendChild(container);

    wireEvents();
    resumeScanOnLoad();
    resumeApplyOnLoad();
    resumeExtApplyOnLoad();

    // Floating toggle button (shown when sidebar is closed)
    const fab = document.createElement('button');
    fab.id = 'pja-fab';
    fab.title = 'Open Job Assistant';
    fab.innerHTML = '🔬';
    fab.style.cssText = `
      position:fixed;bottom:80px;right:0;z-index:2147483646;
      width:44px;height:44px;border-radius:8px 0 0 8px;
      background:#1e40af;color:#fff;border:none;cursor:pointer;
      font-size:20px;display:none;box-shadow:-2px 0 8px rgba(0,0,0,.25);
    `;
    fab.addEventListener('click', () => {
      fab.style.display = 'none';
      openSidebar();
    });
    document.documentElement.appendChild(fab);
  }

  function openSidebar() {
    const sidebar = shadow?.getElementById('pja-sidebar');
    const host = document.getElementById('pja-host');
    const fab = document.getElementById('pja-fab');
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (host) host.style.zIndex = '2147483647';
    if (fab) fab.style.display = 'none';
    sidebarOpen = true;
  }

  function closeSidebar() {
    const sidebar = shadow?.getElementById('pja-sidebar');
    const fab = document.getElementById('pja-fab');
    if (!sidebar) return;
    sidebar.classList.remove('open');
    const host = document.getElementById('pja-host');
    if (host) host.style.zIndex = 'auto';
    if (fab) fab.style.display = 'flex';
    sidebarOpen = false;
  }

  function showPreAnalyze(jobData) {
    const s = shadow;
    if (!s) return;
    setText(s, '#pja-job-title', jobData.title || '—');
    setText(s, '#pja-job-company', jobData.company || '');
    show(s, '#pja-pre-analyze');
    hide(s, '#pja-loading');
    hide(s, '#pja-content');
    hide(s, '#pja-error');
    chrome.storage.local.get('pja_dev_mode', r => {
      const hint = s.getElementById('pja-cost-hint');
      if (hint && r.pja_dev_mode) hint.textContent = '🖥 Dev Server · Smart Template fallback';
    });
  }

  function resetSidebar(jobData) {
    showPreAnalyze(jobData);
  }

  function initAppTools() {
    chrome.storage.local.get('appMode', r => {
      const s = shadow;
      if (!s) return;
      const isAppPage = typeof pjaIsApplicationPage === 'function' && pjaIsApplicationPage();
      if (r.appMode || isAppPage) {
        show(s, '#pja-app-tools');
      } else {
        hide(s, '#pja-app-tools');
      }
    });
    initAdvancedApplyTools();
  }

  function initAdvancedApplyTools() {
    chrome.storage.local.get(['pja_dev_mode', 'pja_advanced_ui', 'pja_prefs'], r => {
      const s = shadow;
      if (!s) return;
      const advanced = !!(r.pja_dev_mode || r.pja_advanced_ui || r.pja_prefs && r.pja_prefs.advancedUi);
      s.querySelectorAll('.pja-advanced-apply-tools').forEach(el => {
        el.style.display = advanced ? '' : 'none';
      });
    });
  }

  function handleLearnToggle() {
    if (!learningActive) {
      learningActive = true;
      learnCallbacks = {
        onClassified:   (key, value) => chrome.runtime.sendMessage({ type: 'SAVE_PROFILE_FIELD', key, value }),
        onUnclassified: (norm, value, raw) => chrome.runtime.sendMessage({ type: 'SAVE_ANSWER', normalizedLabel: norm, value, rawLabel: raw })
      };
      pjaStartLearning(learnCallbacks.onClassified, learnCallbacks.onUnclassified);
    } else {
      learningActive = false;
      learnCallbacks = null;
      pjaStopLearning();
    }
    updateLearnUI();
  }

  function updateLearnUI() {
    const s = shadow;
    if (!s) return;
    const btn    = s.getElementById('pja-learn-btn');
    const status = s.getElementById('pja-learn-status');
    const banner = s.getElementById('pja-learn-banner');
    if (learningActive) {
      if (btn)    btn.textContent = '⏹ Stop Learning';
      if (status) status.style.display = 'flex';
      if (banner) banner.style.display = 'flex';
    } else {
      if (btn)    btn.textContent = '📖 Start Learning';
      if (status) status.style.display = 'none';
      if (banner) banner.style.display = 'none';
    }
  }

  function handleAutofill() {
    chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, resp => {
      if (chrome.runtime.lastError || !resp?.profile) return;
      chrome.runtime.sendMessage({ type: 'GET_ANSWERS' }, answersResp => {
        const answers = answersResp?.answers || {};
        const count = pjaFillForm(resp.profile, answers);

        // If an Easy Apply modal is open, run the FULL shared answerer on it (radio/select/
        // combobox/checkbox-group fallbacks + the AI answerer) so screening questions get
        // answered — same path external-apply uses. Lets a hybrid flow (extension fills +
        // OS-level trusted Next/Submit clicks) complete Easy Apply without the extension's CDP.
        const eaModal = (typeof window.__pjaGetCurrentModal === 'function') ? window.__pjaGetCurrentModal() : null;
        if (eaModal && eaModal.root) {
          try { if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback(); } catch (_) {}
          try { if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback(); } catch (_) {}
          try { if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(resp.profile, answers); } catch (_) {}
          try { if (typeof pjaAutoCheckConsent === 'function') pjaAutoCheckConsent(); } catch (_) {}
          try {
            if (typeof window.pjaAnswerRequiredViaAI === 'function') {
              const jc = currentJobData ? { title: currentJobData.title, company: currentJobData.company } : { title: '', company: '' };
              window.pjaAnswerRequiredViaAI(jc, eaModal.root);
            }
          } catch (_) {}
        }

        const s = shadow;
        const resultEl = s?.getElementById('pja-fill-result');

        // Phase 1 feedback — show immediately while AI questions are in-flight
        if (resultEl) {
          resultEl.textContent = count > 0
            ? `✓ Filled ${count} field${count !== 1 ? 's' : ''}…`
            : 'Checking for open-ended questions…';
          resultEl.className = 'pja-fill-result ' + (count > 0 ? 'success' : 'warn');
          resultEl.style.display = 'block';
        }

        // Phase 2 — AI-fill remaining required text fields not in profile/answer bank
        if (typeof pjaFillUnknownTextFields === 'function') {
          const jobCtx = currentJobData
            ? { title: currentJobData.title, company: currentJobData.company }
            : {};
          pjaFillUnknownTextFields(resp.profile, answers, jobCtx, aiCount => {
            const total = count + aiCount;
            if (resultEl) {
              resultEl.textContent = total > 0
                ? `✓ Filled ${total} field${total !== 1 ? 's' : ''}` +
                  (aiCount > 0 ? ` (${aiCount} via AI)` : '')
                : 'No matching fields found on this page';
              resultEl.className = 'pja-fill-result ' + (total > 0 ? 'success' : 'warn');
              resultEl.style.display = 'block';
              setTimeout(() => { resultEl.style.display = 'none'; }, 4500);
            }
          });
        } else {
          // No AI fill available — finalize Phase 1 message
          if (resultEl) {
            resultEl.textContent = count > 0
              ? `✓ Filled ${count} field${count !== 1 ? 's' : ''}`
              : 'No matching fields found on this page';
            resultEl.className = 'pja-fill-result ' + (count > 0 ? 'success' : 'warn');
            setTimeout(() => { resultEl.style.display = 'none'; }, 3500);
          }
        }
      });
    });
  }
  window.__pjaHandleAutofill = handleAutofill;

  // ── Auto-Apply flow ──────────────────────────────────────────────────────
  let _autoJobs = [];
  let _extJobs  = [];

  // Generic starter searches. Users should tune these from Settings/shortlist sourcing for their
  // own profile; these are intentionally not tied to any one person's work authorization/location.
  const PJA_SEARCH_QUERIES = [
    'quality engineer',
    'manufacturing engineer',
    'process engineer',
    'test engineer',
    'reliability engineer',
    'supplier quality engineer',
    'field service engineer',
  ];

  function buildSearchURL(query) {
    return 'https://www.linkedin.com/jobs/search/?keywords=' +
      encodeURIComponent(query) +
      '&f_AL=true&f_TPR=r2592000';
  }

  function collectEasyApplyJobsFromPage(seenIds, appliedIds) {
    const cards = Array.from(document.querySelectorAll('.job-card-container, [data-job-id]'));
    const jobs = [];
    for (const card of cards) {
      const link = card.querySelector('a[href*="/jobs/view/"]');
      const jobId = link?.href?.match(/\/jobs\/view\/(\d+)/)?.[1];
      if (!jobId || seenIds.has(jobId)) continue;
      if (appliedIds?.has(jobId)) continue;
      if (!/easy apply/i.test(card.textContent)) continue;
      // Skip cards showing "Applied" (already applied indicator from LinkedIn)
      if (/\bapplied\b/i.test(card.querySelector('[class*="applied"],[class*="footer"]')?.textContent || '')) continue;
      seenIds.add(jobId);
      const title = card.querySelector('strong')?.textContent?.trim()
        || Array.from(card.querySelectorAll('span,div'))
             .find(el => !el.children.length && el.textContent.trim().length > 3 && el.textContent.trim().length < 80)
             ?.textContent?.trim() || 'Unknown';
      const company = card.querySelector('[class*="primary-description"],[class*="subtitle"]')
        ?.textContent?.trim() || '';
      jobs.push({ jobId, title, company, badge: 'Easy Apply' });
    }
    return jobs;
  }

  function collectExternalJobsFromPage(seenIds, appliedIds) {
    // LinkedIn only shows "Easy Apply" on cards that support it.
    // Cards without "Easy Apply" are external (company-site) apply jobs.
    // The "Apply" button itself only appears in the detail panel, not the card list.
    const cards = Array.from(document.querySelectorAll('.job-card-container, [data-job-id]'));
    const jobs = [];
    for (const card of cards) {
      const link = card.querySelector('a[href*="/jobs/view/"]');
      const jobId = link?.href?.match(/\/jobs\/view\/(\d+)/)?.[1]
        || card.dataset?.jobId;
      if (!jobId || seenIds.has(jobId)) continue;
      if (appliedIds?.has(jobId)) continue;
      // Skip Easy Apply jobs — those are handled by the Easy Apply flow
      if (/easy apply/i.test(card.textContent)) continue;
      // Skip jobs already marked as applied in the card footer
      if (/\bapplied\b/i.test(card.querySelector('[class*="applied"],[class*="footer"]')?.textContent || '')) continue;
      // Must have a title to be a valid job
      const titleEl = card.querySelector('[class*="title"] a, strong, .job-card-list__title--link, .job-card-container__link');
      const title = titleEl?.textContent?.trim() || link?.textContent?.trim() || '';
      if (!title || title.length < 3) continue;
      const company = card.querySelector('[class*="primary-description"],[class*="subtitle"],[class*="company"]')
        ?.textContent?.trim() || '';
      seenIds.add(jobId);
      jobs.push({ jobId, title: title.slice(0, 80), company: company.slice(0, 80), badge: 'Apply' });
    }
    return jobs;
  }

  function handleAutoScan() {
    // Fetch already-applied job IDs from pipeline, then start scan
    chrome.runtime.sendMessage({ type: 'GET_JOBS' }, resp => {
      const pipeline = resp?.jobs || [];
      const appliedIds = pipeline
        .map(j => { const m = (j.url || '').match(/\/jobs\/view\/(\d+)/); return m?.[1]; })
        .filter(Boolean);
      const state = {
        status: 'scanning',
        queries: PJA_SEARCH_QUERIES,
        queryIndex: 0,
        jobs: [],
        seenIds: [],
        appliedIds,
      };
      sessionStorage.setItem('pja_scan', JSON.stringify(state));
      window.location.href = buildSearchURL(PJA_SEARCH_QUERIES[0]);
    });
  }

  function resumeScanOnLoad() {
    const raw = sessionStorage.getItem('pja_scan');
    if (!raw) return;
    let state;
    try { state = JSON.parse(raw); } catch { sessionStorage.removeItem('pja_scan'); return; }
    if (state.status !== 'scanning') return;

    const s = shadow;
    const scanResult = s?.getElementById('pja-auto-scan-result');
    const startBtn   = s?.getElementById('pja-auto-start-btn');
    const scanBtn    = s?.getElementById('pja-auto-scan-btn');

    // Show scanning state immediately
    if (scanBtn) { scanBtn.disabled = true; scanBtn.textContent = '⏳ Scanning…'; }
    if (scanResult) {
      scanResult.style.display = 'block';
      scanResult.className = 'pja-auto-scan-result';
      scanResult.textContent = `Scanning ${state.queryIndex + 1}/${state.queries.length}: "${state.queries[state.queryIndex]}"… (${state.jobs.length} found so far)`;
    }
    if (startBtn) startBtn.style.display = 'none';

    // Wait for job cards to appear, then collect
    const seenIds = new Set(state.seenIds || []);
    const appliedIds = new Set(state.appliedIds || []);
    let retries = 12;

    const tryCollect = () => {
      const cards = document.querySelectorAll('.job-card-container, [data-job-id]');
      if (cards.length === 0 && retries-- > 0) {
        setTimeout(tryCollect, 800);
        return;
      }
      const newJobs = collectEasyApplyJobsFromPage(seenIds, appliedIds);
      state.jobs = [...state.jobs, ...newJobs];
      state.seenIds = Array.from(seenIds);
      state.queryIndex++;

      if (state.queryIndex < state.queries.length) {
        // More queries to go — update progress and navigate
        if (scanResult) {
          scanResult.textContent = `Scanning ${state.queryIndex + 1}/${state.queries.length}: "${state.queries[state.queryIndex]}"… (${state.jobs.length} found so far)`;
        }
        sessionStorage.setItem('pja_scan', JSON.stringify(state));
        setTimeout(() => { window.location.href = buildSearchURL(state.queries[state.queryIndex]); }, 400);
      } else {
        // All done
        state.status = 'done';
        sessionStorage.setItem('pja_scan', JSON.stringify(state));
        _autoJobs = state.jobs;
        if (scanBtn) { scanBtn.disabled = false; scanBtn.textContent = '🔍 Scan All Searches'; }
        if (state.jobs.length === 0) {
          if (scanResult) {
            scanResult.className = 'pja-auto-scan-result none';
            scanResult.textContent = 'No Easy Apply jobs found across all searches.';
          }
          if (startBtn) startBtn.style.display = 'none';
        } else {
          if (scanResult) {
            scanResult.className = 'pja-auto-scan-result';
            const preview = state.jobs.slice(0, 4).map(j => `• ${j.title} @ ${j.company}`).join('\n');
            const more = state.jobs.length > 4 ? `\n+ ${state.jobs.length - 4} more…` : '';
            scanResult.textContent = `Found ${state.jobs.length} Easy Apply job${state.jobs.length !== 1 ? 's' : ''} across ${state.queries.length} searches:\n${preview}${more}`;
          }
          if (startBtn) {
            startBtn.textContent = `🚀 Start Auto-Apply (${state.jobs.length} jobs)`;
            startBtn.style.display = '';
          }
        }
      }
    };

    setTimeout(tryCollect, 1800);
  }

  function handleAutoApplyStart() {
    const s = shadow;
    if (!_autoJobs.length) return;

    const showError = (msg) => {
      hide(s, '#pja-auto-running');
      show(s, '#pja-auto-idle');
      const scanResult = s.getElementById('pja-auto-scan-result');
      if (scanResult) {
        scanResult.style.display = 'block';
        scanResult.className = 'pja-auto-scan-result none';
        scanResult.textContent = msg;
      }
    };

    hide(s, '#pja-auto-idle');
    hide(s, '#pja-auto-done');
    show(s, '#pja-auto-running');

    try {
      chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, profileResp => {
        if (chrome.runtime.lastError) { showError('Extension was reloaded — please refresh this page and scan again.'); return; }
        chrome.runtime.sendMessage({ type: 'GET_ANSWERS' }, answersResp => {
          if (chrome.runtime.lastError) { showError('Extension was reloaded — please refresh this page and scan again.'); return; }

          // Store queue in sessionStorage — survives per-job navigation
          const queue = {
            status: 'applying',
            jobs: _autoJobs,
            currentIndex: 0,
            results: { applied: [], skipped: [], errors: [] },
            profile: profileResp?.profile || {},
            answers: answersResp?.answers || {}
          };
          sessionStorage.setItem('pja_apply_queue', JSON.stringify(queue));
          window.location.href = `https://www.linkedin.com/jobs/search/?f_AL=true&currentJobId=${_autoJobs[0].jobId}`;
        });
      });
    } catch (err) {
      showError('Extension was reloaded — please refresh this page and scan again.');
    }
  }

  // ── Resume per-job apply across page navigations ─────────────────────────
  function resumeApplyOnLoad() {
    // ACCOUNT SAFETY: if LinkedIn shows a security checkpoint/captcha, PAUSE the queue and
    // surface it — never auto-interact with a challenge (no CAPTCHA solving; protect the account).
    if (/\/checkpoint\/|\/challenge\//.test(location.pathname)
        || /security verification|quick security check|are you a human|unusual activity/i.test(document.body?.innerText || '')) {
      const rawCp = sessionStorage.getItem('pja_apply_queue');
      if (rawCp) {
        try {
          const q = JSON.parse(rawCp);
          const job = q.jobs && q.jobs[q.currentIndex || 0];
          q.status = 'paused_checkpoint';
          sessionStorage.setItem('pja_apply_queue', JSON.stringify(q));
          if (job) {
            if (job.id) chrome.runtime.sendMessage({ type: 'UPDATE_CORPUS_STATE', id: job.id,
              runId: job.runId || q.runId || null,
              reason: 'linkedin_checkpoint' }, () => void chrome.runtime.lastError);
            chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', closeTab: !!job.rankedRun,
              event: { runId: job.runId || q.runId || null, jobId: job.jobId || job.id || null,
                applyUrl: job.applyUrl || location.href, company: job.company, title: job.title,
                channel: 'linkedin_easy_apply', status: 'blocked', success: false,
                reason: 'linkedin_checkpoint', applicationAt: job.applicationAt || q.startedAt || Date.now(),
                occurredAt: Date.now() } }, () => void chrome.runtime.lastError);
          }
        } catch (_) {}
      }
      try { chrome.storage.local.set({ pja_ea_paused: { reason: 'checkpoint', url: location.href, ts: Date.now() } }); } catch (_) {}
      return;
    }
    // Queue navigates to a canonical job view or a search route with currentJobId. LinkedIn's
    // current UI rewrites `/jobs/search/` to `/jobs/search-results/`; both are the same target.
    if (!isLinkedInApplyRoute(location.href)) return;
    const raw = sessionStorage.getItem('pja_apply_queue');
    if (!raw) return;
    let queue;
    try { queue = JSON.parse(raw); } catch { sessionStorage.removeItem('pja_apply_queue'); return; }
    if (queue.status !== 'applying') return;

    const job = queue.jobs[queue.currentIndex];
    if (!job) { sessionStorage.removeItem('pja_apply_queue'); return; }
    const resumeKey = [queue.runId || '', queue.currentIndex || 0, job.jobId || job.id || ''].join(':');
    if (activeEasyApplyResumeKey === resumeKey) return;
    activeEasyApplyResumeKey = resumeKey;
    const s = shadow;
    hide(s, '#pja-auto-idle');
    hide(s, '#pja-auto-done');
    show(s, '#pja-auto-running');

    const total   = queue.jobs.length;
    const current = queue.currentIndex + 1;
    const barEl    = s?.getElementById('pja-auto-bar');
    const statusEl = s?.getElementById('pja-auto-status');
    const tallyEl  = s?.getElementById('pja-auto-tally');

    const updateUI = () => {
      const r = queue.results;
      if (barEl) barEl.style.width = Math.round((current / total) * 100) + '%';
      if (tallyEl) tallyEl.textContent = `✓ Applied: ${r.applied.length} · ⏩ Skipped: ${r.skipped.length}`;
    };
    updateUI();
    if (statusEl) statusEl.textContent = `Applying (${current}/${total}): ${job.title}…`;

    const finishAndAdvance = (result) => {
      try { chrome.storage.local.set({ pja_ea_lastresult: { at: Date.now(), jobId: job.jobId, title: job.title, result } }); } catch(e) {}
      const uncertain = /unconfirmed|unclear|assumed|inferred/i.test(String(result && result.reason || ''));
      const ledgerEvent = {
          runId: job.runId || queue.runId || null, jobId: job.jobId || job.id || null,
          applyUrl: job.applyUrl || `https://www.linkedin.com/jobs/view/${job.jobId}/`,
          company: job.company, title: job.title, channel: 'linkedin_easy_apply',
          status: result && result.success ? 'applied' : uncertain ? 'submitted' : 'failed',
          success: result && result.success ? true : (uncertain ? null : false),
          reason: result && result.reason || '', confirmationSource: result && result.success ? 'page' : null,
          diagnostic: result && result.diagnostic || null,
          confirmedAt: result && result.success ? Date.now() : null,
          applicationAt: job.applicationAt || queue.startedAt || Date.now(), occurredAt: Date.now()
        };
      const signalLedger = () => { try { chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT',
        event: ledgerEvent, closeTab: !!job.rankedRun }, () => void chrome.runtime.lastError); } catch (_) {} };
      // LinkedIn daily Easy Apply cap: HALT the whole queue (don't burn the rest of the jobs on the
      // limit notice) and surface it so the run pivots to other sources / resumes tomorrow.
      if (result && (result.halt || result.reason === 'daily_limit')) {
        try {
          queue.status = 'paused_daily_limit';
          sessionStorage.setItem('pja_apply_queue', JSON.stringify(queue));
          chrome.storage.local.set({ pja_ea_paused: { reason: 'daily_limit', ts: Date.now() } });
        } catch (e) {}
        signalLedger();
        return;
      }
      // Keep the normalized corpus in sync for the LinkedIn channel too (external-apply already
      // does this itself). `id` is the corpus canonical id; jobId remains LinkedIn's source id.
      try {
        if (job.id) chrome.runtime.sendMessage({ type: 'UPDATE_CORPUS_STATE', id: job.id,
          runId: job.runId || queue.runId || null,
          reason: result && result.success ? 'applied' : ((result && result.reason) || 'unknown') },
        () => void chrome.runtime.lastError);
      } catch (_) {}
      const r = queue.results;
      if (result.success) {
        r.applied.push(job);
        // Durable applied-log: EA applies were previously absent from pja_applied_log (only
        // external/api wrote it), so they escaped dedupe + the confirmed-count verification.
        // Idempotent by company::title, channel-tagged 'easy-apply', enriched for verification.
        try {
          chrome.storage.local.get('pja_applied_log', d => {
            const log = Array.isArray(d.pja_applied_log) ? d.pja_applied_log : [];
            const nz = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            const key = nz(job.company) + '::' + nz(job.title);
            // Distinct postings can share company::title — treat as duplicate only when the
            // jobId also matches (or the existing entry has none). Mirrors pjaWriteAppliedLog.
            const inId = String(job.jobId || '');
            if (!log.some(e => nz(e.company) + '::' + nz(e.title) === key
                && (!inId || e.jobId == null || String(e.jobId) === inId))) {
              log.push({
                company: job.company, title: job.title, jobId: job.jobId || null,
                applyUrl: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
                location: job.location || null, channel: 'easy-apply',
                runId: job.runId || queue.runId || null,
                status: 'applied', reason: 'easy_apply', confirmationSource: 'page',
                confirmedAt: Date.now(), confirmedEmail: false, appliedAt: Date.now()
              });
              chrome.storage.local.set({ pja_applied_log: log });
            }
          });
        } catch(e) {}
        try {
          chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title, company: job.company, description: '',
            status: 'Applied', savedAt: Date.now(), statusUpdatedAt: Date.now(), reminderDismissed: false
          }});
        } catch(e) {}
      } else if (result.reason !== 'aborted') {
        const skipReason = result.fields?.length
          ? `Missing: ${result.fields.slice(0, 2).join(', ')}` : result.reason;
        r.skipped.push({ ...job, skipReason });
        try {
          chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title, company: job.company,
            description: result.fields?.length ? 'Missing required fields: ' + result.fields.join('; ') : 'Skip reason: ' + result.reason,
            missingFields: result.fields || [], skipReason, status: 'Needs Info',
            savedAt: Date.now(), statusUpdatedAt: Date.now(), reminderDismissed: false
          }});
        } catch(e) {}
      }

      updateUI();
      queue.currentIndex++;
      const aborted = queue.status === 'aborted';

      if (queue.currentIndex >= queue.jobs.length || aborted || result.reason === 'aborted') {
        queue.status = 'done';
        sessionStorage.setItem('pja_apply_queue', JSON.stringify(queue));
        hide(s, '#pja-auto-running');
        show(s, '#pja-auto-done');
        const doneMsg = s?.getElementById('pja-auto-done-msg');
        if (doneMsg) doneMsg.textContent =
          `✓ Applied: ${r.applied.length} · Skipped: ${r.skipped.length}` +
          (r.errors.length ? ` · Errors: ${r.errors.length}` : '');
        const skippedList = s?.getElementById('pja-auto-skipped-list');
        if (skippedList && r.skipped.length) {
          skippedList.style.display = '';
          skippedList.innerHTML = '<strong>Skipped (saved to pipeline ⚠ Needs Info):</strong><br>' +
            r.skipped.map(j => {
              const url = `https://www.linkedin.com/jobs/view/${j.jobId}/`;
              return `• <a href="${url}" target="_blank" style="color:#1d4ed8;text-decoration:underline">${escHtml(j.title)}</a>: ${escHtml(j.skipReason || j.reason)}`;
            }).join('<br>');
        }
        signalLedger();
      } else {
        sessionStorage.setItem('pja_apply_queue', JSON.stringify(queue));
        signalLedger();
        setTimeout(() => {
          // Humane pacing: randomized 15–40s gap between jobs to protect the LinkedIn account
          // from anti-automation throttling. Advance via the search page (reliable Easy Apply button).
          window.location.href = `https://www.linkedin.com/jobs/search/?f_AL=true&currentJobId=${queue.jobs[queue.currentIndex].jobId}`;
        }, 15000 + Math.random() * 25000);
      }
    };

    // Profile/answers may be absent if the queue was seeded without them
    // (e.g. a manually-seeded job list). Fall back to chrome.storage so the
    // queue is the source of jobs while storage stays the source of identity.
    const ensureProfileAnswers = () => new Promise(resolve => {
      if (queue.profile && Object.keys(queue.profile).length) return resolve();
      chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, profResp => {
        queue.profile = profResp?.profile || {};
        chrome.runtime.sendMessage({ type: 'GET_ANSWERS' }, ansResp => {
          queue.answers = ansResp?.answers || {};
          try {
            chrome.storage.local.get('pja_prefs', prefResp => {
              queue.prefs = prefResp?.pja_prefs || queue.prefs || {};
              if (queue.prefs && queue.jobs && queue.jobs[queue.currentIndex]) {
                queue.jobs[queue.currentIndex].prefs = queue.jobs[queue.currentIndex].prefs || queue.prefs;
              }
              resolve();
            });
            return;
          } catch (_) {}
          resolve();
        });
      });
    });

    // LOOP GUARD — count how many times we've STARTED this job across page loads.
    // If a job's apply step ever causes a page reload before finishAndAdvance runs
    // (e.g. an anchor click that navigates), resumeApplyOnLoad would otherwise restart
    // the same job forever. After 2 starts, skip it and advance. Hard stop on any loop.
    job._starts = (job._starts || 0) + 1;
    queue.jobs[queue.currentIndex] = job;
    sessionStorage.setItem('pja_apply_queue', JSON.stringify(queue));
    if (job._starts > 2) {
      finishAndAdvance({ success: false, reason: 'open_loop_skip' });
      return;
    }

    setTimeout(() => {
      (async () => {
        try {
          await ensureProfileAnswers();
          const result = await window.__pjaApplyOnCurrentPage(
            job, queue.profile, queue.answers,
            msg => { if (statusEl) statusEl.textContent = msg; }
          );
          finishAndAdvance(result);
        } catch (err) {
          finishAndAdvance({ success: false, reason: 'error: ' + (err.message || '').slice(0, 60) });
        }
      })();
    }, 2000);
  }

  // ── External (non-Easy-Apply) apply flow ────────────────────────────────────

  function handleExtScan() {
    const s = shadow;
    const scanBtn    = s?.getElementById('pja-ext-scan-btn');
    const scanResult = s?.getElementById('pja-ext-scan-result');
    const startBtn   = s?.getElementById('pja-ext-start-btn');
    if (scanBtn) scanBtn.textContent = '⏳ Scanning…';

    chrome.runtime.sendMessage({ type: 'GET_JOBS' }, resp => {
      const pipeline = resp?.jobs || [];
      const doneIds = new Set(pipeline.map(j => {
        const m = (j.url || '').match(/\/jobs\/view\/(\d+)/); return m?.[1];
      }).filter(Boolean));

      const seenIds = new Set();
      _extJobs = collectExternalJobsFromPage(seenIds, doneIds);

      if (scanResult) {
        scanResult.style.display = 'block';
        scanResult.textContent = _extJobs.length
          ? `Found ${_extJobs.length} external job${_extJobs.length > 1 ? 's' : ''}`
          : 'No new external jobs found. Try a different search.';
      }
      if (scanBtn) scanBtn.textContent = '🔍 Collect External Jobs';
      if (startBtn) startBtn.style.display = _extJobs.length ? 'block' : 'none';
    });
  }

  function handleExtApplyStart() {
    const s = shadow;
    const jobs = _extJobs.length ? _extJobs : collectExternalJobsFromPage(new Set(), new Set());

    if (!jobs.length) {
      const scanResult = s?.getElementById('pja-ext-scan-result');
      if (scanResult) { scanResult.style.display = 'block'; scanResult.textContent = 'No external jobs found. Run Collect first.'; }
      return;
    }

    show(s, '#pja-ext-running');
    hide(s, '#pja-ext-idle');
    hide(s, '#pja-ext-done');

    chrome.runtime.sendMessage({ type: 'GET_PROFILE' }, profResp => {
      chrome.runtime.sendMessage({ type: 'GET_ANSWERS' }, answResp => {
        const queue = {
          status: 'applying',
          jobs,
          currentIndex: 0,
          results: { applied: [], skipped: [] },
          profile: profResp?.profile || {},
          answers: answResp?.answers || {}
        };
        chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue }, () => {
          // Pre-set pja_ext_current for first job BEFORE navigating.
          // If LinkedIn auto-redirects to external site (wrapper postings), external-apply.js needs this.
          const first = jobs[0];
          const returnUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${first.jobId}&pja_ext_ret=1`;
          chrome.runtime.sendMessage({
            type: 'SET_EXT_CURRENT',
            payload: { ...first, profile: profResp?.profile || {}, answers: answResp?.answers || {}, returnUrl, applyUrl: null }
          }, () => {
            window.location.href = `https://www.linkedin.com/jobs/view/${first.jobId}/?pja_ext=1`;
          });
        });
      });
    });
  }

  function resumeExtApplyOnLoad() {
    // Run on LinkedIn /jobs/view/ pages (external apply) and /jobs/search/ (return from ATS).
    // We check storage for active queue instead of URL params because LinkedIn strips query params.
    const isViewPage   = location.href.includes('linkedin.com/jobs/view/');
    const isSearchPage = location.href.includes('linkedin.com/jobs/search/');
    if (!isViewPage && !isSearchPage) return;

    // Also accept URL params as backup signal (search-page returns from ATS)
    const params = new URLSearchParams(location.search);
    const hasRetParam = params.get('pja_ext_ret') === '1';

    chrome.runtime.sendMessage({ type: 'GET_EXT_QUEUE' }, data => {
      const queue = data?.queue;
      if (!queue) return;
      if (queue.status !== 'applying') {
        if (queue?.status === 'done') showExtDone(queue);
        return;
      }

      const job = queue.jobs[queue.currentIndex];
      if (!job) {
        queue.status = 'done';
        chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue });
        showExtDone(queue);
        return;
      }

      const s = shadow;
      show(s, '#pja-ext-running');
      hide(s, '#pja-ext-idle');
      hide(s, '#pja-ext-done');

      const barEl    = s?.getElementById('pja-ext-bar');
      const statusEl = s?.getElementById('pja-ext-status');
      const tallyEl  = s?.getElementById('pja-ext-tally');

      if (barEl) barEl.style.width = Math.round(((queue.currentIndex) / queue.jobs.length) * 100) + '%';
      if (tallyEl) tallyEl.textContent = `✓ Applied: ${queue.results.applied.length} · ⏩ Skipped: ${queue.results.skipped.length}`;
      if (statusEl) statusEl.textContent = `Applying (${queue.currentIndex + 1}/${queue.jobs.length}): ${job.title}…`;

      // If returning from ATS: detect via URL param OR via pja_ext_current._handled flag
      // Only trust _handled=true when runId matches the current queue run (prevents stale state)
      const sameRunHandled = data?.current?._handled === true &&
                             data?.current?.runId && data?.current?.runId === queue.runId;
      const isReturn = hasRetParam || sameRunHandled;
      if (isReturn) {
        // If the content script was killed mid-submit (page nav), recordResult never ran
        // and currentIndex wasn't advanced. Advance it now using the handled job's id.
        if (sameRunHandled) {
          const curId = data.current.id || data.current.jobId;
          const curIdx = queue.jobs.findIndex(j => (j.id || j.jobId) === curId);
          if (curIdx >= 0 && queue.currentIndex <= curIdx) {
            queue.currentIndex = curIdx + 1;
            // Record as applied (best-effort — we clicked submit before page nav)
            if (!queue.results.applied.find(j => (j.id || j.jobId) === curId)) {
              queue.results.applied.push(queue.jobs[curIdx]);
            }
            if (queue.currentIndex >= queue.jobs.length) queue.status = 'done';
            chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue });
            if (queue.status === 'done') { showExtDone(queue); return; }
          }
        }
        const nextJob = queue.jobs[queue.currentIndex];
        if (!nextJob) { queue.status = 'done'; chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue }); showExtDone(queue); return; }
        if (nextJob.applyUrl) {
          // Direct-ATS queue: go straight to the ATS URL, no LinkedIn job-view intermediate
          const retUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true';
          chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
            ...nextJob, profile: queue.profile, answers: queue.answers, runId: queue.runId, returnUrl: retUrl
          }}, () => {
            setTimeout(() => { window.location.href = nextJob.applyUrl; }, 1500 + Math.random() * 500);
          });
        } else {
          // LinkedIn job-view flow: navigate to the job page to pick up the Apply button
          const retUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${nextJob.jobId}&pja_ext_ret=1`;
          chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
            ...nextJob, profile: queue.profile, answers: queue.answers, returnUrl: retUrl, applyUrl: null
          }}, () => {
            setTimeout(() => {
              window.location.href = `https://www.linkedin.com/jobs/view/${nextJob.jobId}/?pja_ext=1`;
            }, 2000 + Math.random() * 1000);
          });
        }
        return;
      }

      // Normal mode: apply to current job
      setTimeout(() => {
        (async () => {
          try {
            const result = await window.__pjaExternalApplyOnCurrentPage(
              job, queue.profile, queue.answers,
              msg => { if (statusEl) statusEl.textContent = msg; }
            );

            if (result?.pending) return; // External-apply.js will handle from ATS page

            // Record result (non-pending case: URL not found, already applied, etc.)
            const r = queue.results;
            if (result.success) r.applied.push(job);
            else r.skipped.push({ ...job, skipReason: result.reason });

            // Save job to pipeline
            try {
              chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload: {
                id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
                title: job.title, company: job.company, description: '',
                status: result.success ? 'Applied' : 'Needs Info',
                savedAt: Date.now(), statusUpdatedAt: Date.now(), reminderDismissed: false
              }});
            } catch(e) {}

            queue.currentIndex++;
            if (queue.currentIndex >= queue.jobs.length) {
              queue.status = 'done';
              chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue });
              showExtDone(queue);
            } else {
              chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue });
              if (tallyEl) tallyEl.textContent = `✓ Applied: ${r.applied.length} · ⏩ Skipped: ${r.skipped.length}`;
              const nj = queue.jobs[queue.currentIndex];
              if (nj.applyUrl) {
                const nRetUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true';
                chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
                  ...nj, profile: queue.profile, answers: queue.answers, runId: queue.runId, returnUrl: nRetUrl
                }}, () => {
                  setTimeout(() => { window.location.href = nj.applyUrl; }, 1500 + Math.random() * 500);
                });
              } else {
                const nRetUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${nj.jobId}&pja_ext_ret=1`;
                chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
                  ...nj, profile: queue.profile, answers: queue.answers, returnUrl: nRetUrl, applyUrl: null
                }}, () => {
                  setTimeout(() => {
                    window.location.href = `https://www.linkedin.com/jobs/view/${nj.jobId}/?pja_ext=1`;
                  }, 3000 + Math.random() * 2000);
                });
              }
            }
          } catch(err) {
            const r = queue.results;
            r.skipped.push({ ...job, skipReason: 'error: ' + (err.message || '').slice(0, 40) });
            queue.currentIndex++;
            chrome.runtime.sendMessage({ type: 'SET_EXT_QUEUE', payload: queue });
            const ej = queue.jobs[queue.currentIndex];
            if (!ej) { setTimeout(() => { queue.status = 'done'; showExtDone(queue); }, 3000); return; }
            if (ej.applyUrl) {
              const eRetUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true';
              chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
                ...ej, profile: queue.profile, answers: queue.answers, runId: queue.runId, returnUrl: eRetUrl
              }}, () => {
                setTimeout(() => { window.location.href = ej.applyUrl; }, 1500);
              });
            } else {
              const eRetUrl = `https://www.linkedin.com/jobs/search/?currentJobId=${ej.jobId}&pja_ext_ret=1`;
              chrome.runtime.sendMessage({ type: 'SET_EXT_CURRENT', payload: {
                ...ej, profile: queue.profile, answers: queue.answers, returnUrl: eRetUrl, applyUrl: null
              }}, () => {
                setTimeout(() => {
                  window.location.href = `https://www.linkedin.com/jobs/view/${ej.jobId}/?pja_ext=1`;
                }, 3000);
              });
            }
          }
        })();
      }, 2500);
    });
  }

  function showExtDone(queue) {
    const s = shadow;
    hide(s, '#pja-ext-running');
    hide(s, '#pja-ext-idle');
    show(s, '#pja-ext-done');
    const r = queue?.results;
    const msg = s?.getElementById('pja-ext-done-msg');
    if (msg && r) msg.textContent = `✓ Applied: ${r.applied.length} · Skipped: ${r.skipped.length}`;

    // Show missing questions warning if any were collected
    chrome.storage.local.get('pja_missing_questions', data => {
      const mq = data.pja_missing_questions || {};
      const unanswered = Object.values(mq).filter(q => !q.answer).length;
      const wrap = s?.getElementById('pja-ext-missing-wrap');
      const btn  = s?.getElementById('pja-ext-missing-btn');
      if (wrap) wrap.style.display = unanswered ? 'block' : 'none';
      if (btn && unanswered) btn.textContent = `📝 Answer ${unanswered} Missing Question${unanswered > 1 ? 's' : ''}`;
    });
  }

  // ── Analysis flow ────────────────────────────────────────────────────────
  async function analyzeWithClaude(jobData) {
    const s = shadow;
    if (!s) return;
    hide(s, '#pja-content');
    show(s, '#pja-loading');
    chrome.runtime.sendMessage(
      { type: 'ANALYZE_JOB', payload: { ...jobData, url: location.href }, useClaude: true },
      resp => {
        if (chrome.runtime.lastError || !resp?.success) {
          showError(s, resp?.error || chrome.runtime.lastError?.message || 'Claude API failed.');
          return;
        }
        currentAnalysis = resp.data;
        renderAnalysis(s, resp.data, false, 'claude');
        const upgradeEl = s.getElementById('pja-claude-upgrade');
        if (upgradeEl) upgradeEl.style.display = 'none';
        updateNanoHint(s, null);
      }
    );
  }

  async function analyze(jobData) {
    const s = shadow;
    if (!s) return;

    // Set job info immediately (before the async API call returns)
    setText(s, '#pja-job-title', jobData.title || '—');
    setText(s, '#pja-job-company', jobData.company || '');

    hide(s, '#pja-pre-analyze');
    show(s, '#pja-loading');
    hide(s, '#pja-content');
    hide(s, '#pja-error');

    // Show engine-specific loading message
    chrome.storage.local.get('pja_dev_mode', r => {
      if (r.pja_dev_mode) {
        setText(s, '#pja-loading-msg', '🖥 Analyzing via Dev Server…');
        hide(s, '#pja-loading-sub');
      } else if (typeof LanguageModel !== 'undefined') {
        LanguageModel.availability().then(status => {
          if (status === 'available' || status === 'readily') {
            setText(s, '#pja-loading-msg', '✨ Analyzing with Gemini Nano…');
            show(s, '#pja-loading-sub');
          }
        }).catch(() => {});
      }
    });

    chrome.runtime.sendMessage(
      { type: 'ANALYZE_JOB', payload: { ...jobData, url: location.href } },
      resp => {
        if (chrome.runtime.lastError) {
          showError(s, 'Extension error: ' + chrome.runtime.lastError.message);
          return;
        }
        if (!resp?.success) {
          showError(s, resp?.error || 'Analysis failed.');
          return;
        }
        setText(s, '#pja-loading-msg', 'Analyzing job fit…');
        hide(s, '#pja-loading-sub');
        currentAnalysis = resp.data;
        renderAnalysis(s, resp.data, resp.mock, resp.engine);
        const upgradeEl = s.getElementById('pja-claude-upgrade');
        if (upgradeEl) upgradeEl.style.display = resp.offerClaude ? 'block' : 'none';
        if (resp.devServerDown) {
          updateNanoHint(s, 'dev-down');
        } else if (resp.nanoFailed) {
          updateNanoHint(s, 'failed', resp.nanoError);
        } else {
          updateNanoHint(s, resp.nanoStatus);
        }
      }
    );
  }

  function renderAnalysis(s, data, isMock, engine) {
    // Score gauge
    const score = Math.max(0, Math.min(100, data.fitScore || 0));
    const arc = s.getElementById('pja-score-arc');
    const scoreNum = s.getElementById('pja-score-num');
    const circumference = 339.3;
    const offset = circumference * (1 - score / 100);
    if (arc) {
      arc.style.strokeDashoffset = offset;
      arc.style.stroke = score >= 75 ? '#22c55e' : score >= 55 ? '#f59e0b' : '#ef4444';
    }
    if (scoreNum) scoreNum.textContent = score;

    // Skills
    renderChips(s, '#pja-matched-skills', data.matchedSkills || [], 'chip-match');
    renderChips(s, '#pja-gaps', data.gaps || [], 'chip-gap');

    // Recruiter
    setText(s, '#pja-recruiter-title', data.recruiterTitle || '—');

    // Search query
    const qEl = s.getElementById('pja-query-box');
    if (qEl) qEl.textContent = data.linkedinSearchQuery || '';

    // Messages
    updateMessage(s, data);

    // Engine badge — show which tier produced the analysis
    const mockBadge = s.getElementById('pja-mock-badge');
    if (mockBadge) {
      const resolvedEngine = engine || (data && data.engine) || (isMock ? 'template' : null);
      if (resolvedEngine === 'claude-dev') {
        mockBadge.textContent = '🖥 Dev Server';
        mockBadge.className = 'pja-claude-badge';
        mockBadge.style.display = 'inline-block';
      } else if (resolvedEngine === 'nano') {
        mockBadge.textContent = '✨ Gemini Nano';
        mockBadge.className = 'pja-nano-badge';
        mockBadge.style.display = 'inline-block';
      } else if (resolvedEngine === 'claude') {
        mockBadge.textContent = '🤖 Claude AI';
        mockBadge.className = 'pja-claude-badge';
        mockBadge.style.display = 'inline-block';
      } else if (resolvedEngine === 'template' || isMock) {
        mockBadge.textContent = '📄 Smart Template';
        mockBadge.className = 'pja-mock-badge';
        mockBadge.style.display = 'inline-block';
      } else {
        mockBadge.style.display = 'none';
      }
    }

    hide(s, '#pja-loading');
    show(s, '#pja-content');
  }

  function updateNanoHint(s, nanoStatus, nanoError) {
    const el = s.getElementById('pja-nano-setup');
    if (!el) return;
    if (!nanoStatus || nanoStatus === 'available' || nanoStatus === 'readily') {
      el.style.display = 'none';
    } else if (nanoStatus === 'dev-down') {
      el.innerHTML = '⚠️ <strong>Dev server not running.</strong> Start it: <code>node dev-server.js</code>';
      el.style.background = '#fef3c7'; el.style.borderColor = '#fcd34d'; el.style.color = '#92400e';
      el.style.display = 'block';
    } else if (nanoStatus === 'failed') {
      el.innerHTML = '⚠️ <strong>Gemini Nano failed</strong> — using Smart Template instead.' +
        (nanoError ? ' <span style="opacity:.7;font-size:10px">(' + nanoError.slice(0, 80) + ')</span>' : '');
      el.style.background = '#fef3c7';
      el.style.borderColor = '#fcd34d';
      el.style.color = '#92400e';
      el.style.display = 'block';
    } else if (nanoStatus === 'downloading') {
      el.innerHTML = '✨ <strong>Gemini Nano downloading…</strong> Will upgrade automatically once ready.';
      el.style.background = '#f0fdf4'; el.style.borderColor = '#bbf7d0'; el.style.color = '#166534';
      el.style.display = 'block';
    } else if (nanoStatus === 'after-download' || nanoStatus === 'downloadable') {
      el.innerHTML = '✨ Enable free Gemini Nano: <code>chrome://flags/#prompt-api-for-gemini-nano</code> → Enabled, relaunch.';
      el.style.background = '#f0fdf4'; el.style.borderColor = '#bbf7d0'; el.style.color = '#166534';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  function updateMessage(s, data) {
    const ta = s.getElementById('pja-message-text');
    if (!ta) return;
    ta.value = activeTab === 'dm'
      ? (data?.dmMessage || '')
      : (data?.emailMessage || '');
  }

  function renderChips(s, selector, items, cls) {
    const container = s.querySelector(selector);
    if (!container) return;
    container.innerHTML = items.map(item =>
      `<span class="chip ${cls}">${escHtml(item)}</span>`
    ).join('');
  }

  function showError(s, msg) {
    hide(s, '#pja-loading');
    hide(s, '#pja-content');
    const errEl = s.getElementById('pja-error-msg');
    if (errEl) errEl.textContent = msg;
    show(s, '#pja-error');
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  function wireEvents() {
    const s = shadow;

    // Close button
    s.getElementById('pja-close')?.addEventListener('click', closeSidebar);

    // Analyze button (manual trigger)
    s.getElementById('pja-analyze-btn')?.addEventListener('click', () => {
      if (currentJobData) analyze(currentJobData);
    });

    // App tools
    s.getElementById('pja-learn-btn')?.addEventListener('click', handleLearnToggle);
    s.getElementById('pja-learn-stop-btn')?.addEventListener('click', handleLearnToggle);
    s.getElementById('pja-fill-btn')?.addEventListener('click', handleAutofill);

    // Tab switching
    s.querySelectorAll('.pja-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        s.querySelectorAll('.pja-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateMessage(s, currentAnalysis);
      });
    });

    // Copy message
    s.getElementById('pja-copy-msg')?.addEventListener('click', () => {
      const ta = s.getElementById('pja-message-text');
      if (ta?.value) copyText(ta.value, s, 'pja-copy-msg', 'Copied!');
    });

    // Copy query
    s.getElementById('pja-copy-query')?.addEventListener('click', () => {
      const el = s.getElementById('pja-query-box');
      if (el?.textContent) copyText(el.textContent, s, 'pja-copy-query', 'Copied!');
    });

    // Save to pipeline
    s.getElementById('pja-save-btn')?.addEventListener('click', saveJob);

    // Auto-apply
    s.getElementById('pja-auto-scan-btn')?.addEventListener('click', handleAutoScan);
    s.getElementById('pja-auto-start-btn')?.addEventListener('click', handleAutoApplyStart);
    s.getElementById('pja-auto-stop-btn')?.addEventListener('click', () => {
      if (window.__pjaAutoState) window.__pjaAutoState.aborted = true;
      // Also abort the navigate-per-job queue
      try {
        const raw = sessionStorage.getItem('pja_apply_queue');
        if (raw) {
          const q = JSON.parse(raw);
          q.status = 'aborted';
          sessionStorage.setItem('pja_apply_queue', JSON.stringify(q));
        }
      } catch(e) {}
    });
    s.getElementById('pja-auto-again-btn')?.addEventListener('click', () => {
      hide(s, '#pja-auto-done');
      show(s, '#pja-auto-idle');
      sessionStorage.removeItem('pja_scan');
      sessionStorage.removeItem('pja_apply_queue');
      _autoJobs = [];
      const scanResult = s.getElementById('pja-auto-scan-result');
      const startBtn   = s.getElementById('pja-auto-start-btn');
      const scanBtn    = s.getElementById('pja-auto-scan-btn');
      if (scanResult) scanResult.style.display = 'none';
      if (startBtn)   startBtn.style.display   = 'none';
      if (scanBtn)    scanBtn.textContent = '🔍 Scan All Searches';
    });

    // External Apply buttons
    s.getElementById('pja-ext-scan-btn')?.addEventListener('click', handleExtScan);
    s.getElementById('pja-ext-start-btn')?.addEventListener('click', handleExtApplyStart);
    s.getElementById('pja-ext-stop-btn')?.addEventListener('click', () => {
      chrome.storage.local.get('pja_ext_queue', data => {
        const q = data.pja_ext_queue;
        if (q) { q.status = 'aborted'; chrome.storage.local.set({ pja_ext_queue: q }); }
      });
    });
    s.getElementById('pja-ext-again-btn')?.addEventListener('click', () => {
      hide(s, '#pja-ext-done');
      show(s, '#pja-ext-idle');
      chrome.storage.local.remove(['pja_ext_queue', 'pja_ext_current']);
      _extJobs = [];
      const scanResult = s.getElementById('pja-ext-scan-result');
      const startBtn   = s.getElementById('pja-ext-start-btn');
      const scanBtn    = s.getElementById('pja-ext-scan-btn');
      if (scanResult) scanResult.style.display = 'none';
      if (startBtn)   startBtn.style.display   = 'none';
      if (scanBtn)    scanBtn.textContent = '🔍 Collect External Jobs';
    });
    s.getElementById('pja-ext-missing-btn')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') + '#missing' });
    });

    // Settings link — openOptionsPage() isn't available in content scripts
    s.getElementById('pja-open-settings')?.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    });

    // Retry
    s.getElementById('pja-retry')?.addEventListener('click', () => {
      if (currentJobData) analyze(currentJobData);
    });

    // Claude upgrade — user explicitly opted in
    s.getElementById('pja-use-claude-btn')?.addEventListener('click', () => {
      const upgradeEl = s.getElementById('pja-claude-upgrade');
      if (upgradeEl) upgradeEl.style.display = 'none';
      if (currentJobData) analyzeWithClaude(currentJobData);
    });

    // Save current message as template
    s.getElementById('pja-save-as-tmpl')?.addEventListener('click', () => {
      const ta = s.getElementById('pja-message-text');
      if (!ta?.value) return;
      openTemplateForm(ta.value);
    });

    // Templates section — toggle collapse
    s.getElementById('pja-tmpl-toggle')?.addEventListener('click', e => {
      if (e.target.closest('button')) return; // let buttons handle themselves
      const body = s.getElementById('pja-tmpl-body');
      const chevron = s.getElementById('pja-tmpl-chevron');
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      if (chevron) chevron.textContent = collapsed ? '▾' : '▸';
    });

    // Templates — open blank form
    s.getElementById('pja-tmpl-add-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openTemplateForm('');
    });

    // Templates — paste selected page text
    s.getElementById('pja-tmpl-capture')?.addEventListener('click', () => {
      const sel = window.getSelection()?.toString().trim();
      const ta = s.getElementById('pja-tmpl-text');
      if (ta && sel) ta.value = sel;
      else if (ta) ta.focus();
    });

    // Templates — save form
    s.getElementById('pja-tmpl-save')?.addEventListener('click', () => saveTemplateForm());

    // Templates — cancel form
    s.getElementById('pja-tmpl-cancel')?.addEventListener('click', () => closeTemplateForm());

    // Load templates on open
    loadTemplates();
  }

  // ── Templates ───────────────────────────────────────────────────────────────
  let editingTemplateId = null;

  function loadTemplates() {
    chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' }, resp => {
      renderTemplates(resp?.templates || []);
    });
  }

  function renderTemplates(templates) {
    const s = shadow;
    const list = s?.getElementById('pja-tmpl-list');
    if (!list) return;
    if (!templates.length) {
      list.innerHTML = '<div class="pja-tmpl-empty">No templates yet. Save a message above or add one.</div>';
      return;
    }
    const e = t => String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    list.innerHTML = templates.map(t => `
      <div class="pja-tmpl-card" data-id="${e(t.id)}">
        <div class="pja-tmpl-card-name">${e(t.name)}</div>
        <div class="pja-tmpl-card-preview">${e(t.text)}</div>
        <div class="pja-tmpl-card-actions">
          <button class="btn btn-primary btn-sm pja-tmpl-copy" style="flex:1">Copy</button>
          <button class="btn btn-outline btn-sm pja-tmpl-edit">Edit</button>
          <button class="btn btn-outline btn-sm pja-tmpl-delete" style="color:#ef4444;border-color:#fca5a5">Del</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pja-tmpl-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.pja-tmpl-card').dataset.id;
        const tmpl = templates.find(t => t.id === id);
        if (tmpl) copyText(tmpl.text, s, null, null, btn);
      });
    });
    list.querySelectorAll('.pja-tmpl-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.pja-tmpl-card').dataset.id;
        const tmpl = templates.find(t => t.id === id);
        if (tmpl) openTemplateForm(tmpl.text, tmpl.name, tmpl.id);
      });
    });
    list.querySelectorAll('.pja-tmpl-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.pja-tmpl-card').dataset.id;
        chrome.runtime.sendMessage({ type: 'DELETE_TEMPLATE', templateId: id }, () => loadTemplates());
      });
    });
  }

  function openTemplateForm(text, name = '', id = null) {
    const s = shadow;
    editingTemplateId = id;
    const nameEl = s.getElementById('pja-tmpl-name');
    const textEl = s.getElementById('pja-tmpl-text');
    const form   = s.getElementById('pja-tmpl-form');
    const body   = s.getElementById('pja-tmpl-body');
    if (nameEl) nameEl.value = name;
    if (textEl) textEl.value = text;
    if (form)   form.style.display = '';
    if (body)   body.style.display = '';
    // Expand section
    const chevron = s.getElementById('pja-tmpl-chevron');
    if (chevron) chevron.textContent = '▾';
    if (nameEl) nameEl.focus();
  }

  function closeTemplateForm() {
    const s = shadow;
    const form = s?.getElementById('pja-tmpl-form');
    if (form) form.style.display = 'none';
    editingTemplateId = null;
  }

  function saveTemplateForm() {
    const s = shadow;
    const name = s.getElementById('pja-tmpl-name')?.value.trim();
    const text = s.getElementById('pja-tmpl-text')?.value.trim();
    if (!text) return;
    const template = {
      id: editingTemplateId || ('tmpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
      name: name || 'Template ' + new Date().toLocaleDateString(),
      text,
      savedAt: Date.now()
    };
    chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', template }, () => {
      closeTemplateForm();
      loadTemplates();
    });
  }

  function saveJob() {
    const s = shadow;
    if (!currentJobData) return;

    const status = s.getElementById('pja-status-select')?.value || 'Bookmarked';
    const now = Date.now();
    const job = {
      id: 'job_' + now + '_' + Math.random().toString(36).slice(2, 8),
      url: location.href,
      title: currentJobData.title || 'Unknown',
      company: currentJobData.company || 'Unknown',
      description: (currentJobData.description || '').slice(0, 3000),
      status,
      savedAt: now,
      statusUpdatedAt: now,
      reminderDismissed: false,
      ...(currentAnalysis || {})
    };

    chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload: job }, resp => {
      if (chrome.runtime.lastError) {
        console.warn('PJA: save message error:', chrome.runtime.lastError.message);
      }
      // Show toast regardless — job is saved even if ack is delayed
      const toast = s.getElementById('pja-saved-toast');
      if (toast) {
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 2500);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function show(s, id) {
    if (!s) return;
    const el = s.querySelector(id);
    if (el) el.style.display = '';
  }
  function hide(s, id) {
    if (!s) return;
    const el = s.querySelector(id);
    if (el) el.style.display = 'none';
  }
  function setText(s, id, text) {
    const el = s.querySelector(id);
    if (el) el.textContent = text;
  }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function copyText(text, s, btnId, label, btnEl) {
    navigator.clipboard.writeText(text).then(() => {
      const btn = btnEl || (btnId && s.getElementById(btnId));
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = label || '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }
    }).catch(() => {});
  }

  // ── HTML template ─────────────────────────────────────────────────────────
  function getSidebarHTML() {
    const opts = ['Bookmarked','Shortlisted','Applied','Outreach Sent','Interview','Offer','Rejected']
      .map(s => `<option value="${s}">${s}</option>`).join('');

    return `
<div id="pja-sidebar">
  <div class="pja-header">
    <div class="pja-header-left">
      <span class="pja-logo">🔬</span>
      <span class="pja-title">Job Assistant</span>
    </div>
    <button id="pja-close" class="pja-close-btn" title="Close">✕</button>
  </div>

  <div class="pja-scroll">
    <!-- Always visible -->
    <div class="pja-tn-banner">Profile-based answers · Verify legal/work-authorization facts in Settings</div>
    <!-- Learning active indicator — persists across page navigation -->
    <div id="pja-learn-banner" class="pja-learn-banner" style="display:none">
      <span class="pja-learn-dot"></span> Learning active — keep filling forms normally
      <button class="pja-learn-stop-btn" id="pja-learn-stop-btn">Stop</button>
    </div>
    <div class="pja-job-info">
      <div id="pja-job-title" class="pja-job-title">—</div>
      <div id="pja-job-company" class="pja-job-company"></div>
    </div>

    <!-- State: Pre-analyze -->
    <div id="pja-pre-analyze" class="pja-pre-analyze">
      <button id="pja-analyze-btn" class="btn btn-primary btn-full">🔬 Analyze Job Fit</button>
      <div class="pja-cost-hint" id="pja-cost-hint">Free via Gemini Nano · Claude fallback · Smart Template</div>
    </div>

    <!-- State: Loading -->
    <div id="pja-loading" class="pja-loading" style="display:none">
      <div class="pja-spinner"></div>
      <p id="pja-loading-msg">Analyzing job fit…</p>
      <p id="pja-loading-sub" style="font-size:11px;color:#9ca3af;margin-top:4px;display:none">First run may take 15–40s while model loads</p>
    </div>

    <!-- State: Error -->
    <div id="pja-error" class="pja-error-box" style="display:none">
      <p id="pja-error-msg">Something went wrong.</p>
      <button id="pja-retry" class="btn btn-primary">Retry</button>
    </div>

    <!-- State: Results -->
    <div id="pja-content" style="display:none">
      <div class="pja-score-wrap">
        <svg class="pja-score-svg" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="54" fill="none" stroke="#e5e7eb" stroke-width="10"/>
          <circle id="pja-score-arc" cx="60" cy="60" r="54" fill="none"
            stroke="#22c55e" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="339.3" stroke-dashoffset="339.3"
            transform="rotate(-90 60 60)"
            style="transition:stroke-dashoffset .6s ease,stroke .4s ease"/>
          <text id="pja-score-num" x="60" y="56"
            text-anchor="middle" dominant-baseline="central"
            fill="#111827" font-size="30" font-weight="700" font-family="system-ui">—</text>
          <text x="60" y="79" text-anchor="middle"
            fill="#6b7280" font-size="11" font-family="system-ui">Fit Score</text>
        </svg>
      </div>

      <div class="pja-section">
        <div class="pja-section-label">✓ Matched Skills</div>
        <div id="pja-matched-skills" class="pja-chips"></div>
      </div>

      <div class="pja-section">
        <div class="pja-section-label">△ Skill Gaps</div>
        <div id="pja-gaps" class="pja-chips"></div>
      </div>

      <div class="pja-section">
        <div class="pja-section-label">📨 Outreach Message</div>
        <div class="pja-tabs">
          <button class="pja-tab active" data-tab="dm">LinkedIn DM</button>
          <button class="pja-tab" data-tab="email">Cold Email</button>
        </div>
        <textarea id="pja-message-text" class="pja-textarea" readonly></textarea>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button id="pja-copy-msg" class="btn btn-outline btn-sm" style="flex:1">Copy</button>
          <button id="pja-save-as-tmpl" class="btn btn-outline btn-sm" title="Save as template">💾 Template</button>
        </div>
      </div>

      <div class="pja-section">
        <div class="pja-section-label">🔍 Find the Recruiter</div>
        <div id="pja-recruiter-title" class="pja-recruiter-title"></div>
        <div id="pja-query-box" class="pja-query-box"></div>
        <button id="pja-copy-query" class="btn btn-outline btn-sm">Copy Search Query</button>
      </div>

      <div class="pja-save-section">
        <select id="pja-status-select" class="pja-select">${opts}</select>
        <button id="pja-save-btn" class="btn btn-primary">Save to Pipeline</button>
      </div>

      <div id="pja-saved-toast" class="pja-toast" style="display:none">✓ Saved to pipeline!</div>

      <!-- Claude upgrade — only shown when template was used and API key exists -->
      <div id="pja-claude-upgrade" class="pja-claude-upgrade" style="display:none">
        <div class="pja-upgrade-label">Want AI-powered analysis?</div>
        <button id="pja-use-claude-btn" class="btn btn-outline btn-sm pja-upgrade-btn">
          🤖 Use Claude AI <span class="pja-upgrade-cost">~$0.02</span>
        </button>
      </div>
      <!-- Nano setup hint — shown when Nano isn't ready but could be enabled -->
      <div id="pja-nano-setup" class="pja-nano-setup" style="display:none">
        <span>✨ Enable free Gemini Nano:</span>
        <code>chrome://flags/#prompt-api-for-gemini-nano</code> → Enabled, then relaunch Chrome
      </div>
    </div>

    <!-- Application Tools (shown when App Mode is ON or on an application page) -->
    <div id="pja-app-tools" style="display:none">
      <div class="pja-section pja-app-section">
        <div class="pja-section-label">📋 Application Tools</div>
        <div id="pja-learn-status" class="pja-learn-status" style="display:none">
          <span class="pja-learn-dot"></span> Learning from your form inputs…
        </div>
        <div class="pja-app-btns">
          <button id="pja-learn-btn" class="btn btn-outline btn-sm">📖 Start Learning</button>
          <button id="pja-fill-btn" class="btn btn-primary btn-sm">⚡ Autofill Form</button>
        </div>
        <div id="pja-fill-result" class="pja-fill-result" style="display:none"></div>
      </div>

      <!-- Auto-Apply section -->
      <div class="pja-section pja-auto-section pja-advanced-apply-tools" style="display:none">
        <div class="pja-section-label">🚀 Auto-Apply</div>
        <div class="pja-auto-hint">Scans saved searches · collects jobs · review before applying</div>

        <div id="pja-auto-idle">
          <button id="pja-auto-scan-btn" class="btn btn-outline btn-sm pja-auto-scan-btn">🔍 Scan All Searches</button>
          <div id="pja-auto-scan-result" class="pja-auto-scan-result" style="display:none"></div>
          <button id="pja-auto-start-btn" class="btn btn-primary pja-auto-start-btn" style="display:none">🚀 Start Auto-Apply</button>
        </div>

        <div id="pja-auto-running" style="display:none">
          <div class="pja-auto-bar-track"><div id="pja-auto-bar" class="pja-auto-bar"></div></div>
          <div id="pja-auto-status" class="pja-auto-status">Starting…</div>
          <div id="pja-auto-tally" class="pja-auto-tally">✓ Applied: 0 · ⏩ Skipped: 0</div>
          <button id="pja-auto-stop-btn" class="btn btn-outline btn-sm pja-auto-stop-btn">■ Stop</button>
        </div>

        <div id="pja-auto-done" style="display:none">
          <div id="pja-auto-done-msg" class="pja-auto-done-msg"></div>
          <div id="pja-auto-skipped-list" class="pja-auto-skipped-list" style="display:none"></div>
          <button id="pja-auto-again-btn" class="btn btn-outline btn-sm" style="margin-top:8px;width:100%">↩ Run Again</button>
        </div>
      </div>

      <!-- External Apply section -->
      <div class="pja-section pja-ext-section pja-advanced-apply-tools" style="display:none">
        <div class="pja-section-label">🌐 External Apply</div>
        <div class="pja-auto-hint">Scans for non-Easy-Apply jobs · Opens ATS pages · Auto-fills & submits</div>

        <div id="pja-ext-idle">
          <button id="pja-ext-scan-btn" class="btn btn-outline btn-sm pja-auto-scan-btn">🔍 Collect External Jobs</button>
          <div id="pja-ext-scan-result" class="pja-auto-scan-result" style="display:none"></div>
          <button id="pja-ext-start-btn" class="btn btn-primary pja-auto-start-btn" style="display:none">🌐 Start External Apply</button>
        </div>

        <div id="pja-ext-running" style="display:none">
          <div class="pja-auto-bar-track"><div id="pja-ext-bar" class="pja-auto-bar"></div></div>
          <div id="pja-ext-status" class="pja-auto-status">Starting…</div>
          <div id="pja-ext-tally" class="pja-auto-tally">✓ Applied: 0 · ⏩ Skipped: 0</div>
          <button id="pja-ext-stop-btn" class="btn btn-outline btn-sm pja-auto-stop-btn">■ Stop</button>
        </div>

        <div id="pja-ext-done" style="display:none">
          <div id="pja-ext-done-msg" class="pja-auto-done-msg"></div>
          <div id="pja-ext-missing-wrap" style="display:none;margin-top:6px">
            <div style="font-size:11px;color:#f59e0b;font-weight:600">⚠ Missing answers needed</div>
            <button id="pja-ext-missing-btn" class="btn btn-outline btn-sm" style="margin-top:4px;width:100%">📝 View Missing Questions</button>
          </div>
          <button id="pja-ext-again-btn" class="btn btn-outline btn-sm" style="margin-top:8px;width:100%">↩ Run Again</button>
        </div>
      </div>
    </div>

    <!-- Message Templates -->
    <div class="pja-section pja-tmpl-section">
      <div class="pja-tmpl-header" id="pja-tmpl-toggle">
        <span class="pja-section-label" style="margin:0">📋 Templates</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="pja-tmpl-add-btn" class="btn btn-sm btn-outline">+ New</button>
          <span id="pja-tmpl-chevron" style="font-size:10px;color:#9ca3af">▾</span>
        </div>
      </div>
      <div id="pja-tmpl-body">
        <div id="pja-tmpl-list"><div class="pja-tmpl-empty">No templates yet. Save a message above or add one.</div></div>
        <div id="pja-tmpl-form" class="pja-tmpl-form" style="display:none">
          <input id="pja-tmpl-name" class="pja-tmpl-input" placeholder="Template name (e.g. recruiter intro)">
          <textarea id="pja-tmpl-text" class="pja-tmpl-textarea" rows="5" placeholder="Paste or type your message…"></textarea>
          <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
            <button id="pja-tmpl-capture" class="btn btn-outline btn-sm">📋 Paste selection</button>
            <button id="pja-tmpl-save" class="btn btn-primary btn-sm" style="flex:1">Save</button>
            <button id="pja-tmpl-cancel" class="btn btn-outline btn-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <div class="pja-footer">
      <a href="#" id="pja-open-settings">⚙ Settings</a>
      <span id="pja-mock-badge" class="pja-mock-badge" style="display:none">Demo Mode</span>
    </div>
  </div>
</div>`;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function getSidebarCSS() {
    return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

#pja-sidebar {
  position: fixed;
  top: 0;
  right: -384px;
  width: 380px;
  height: 100vh;
  background: #fff;
  box-shadow: -4px 0 24px rgba(0,0,0,.15);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: #111827;
  z-index: 2147483647;
  transition: right .3s cubic-bezier(.4,0,.2,1);
  border-left: 1px solid #e5e7eb;
  pointer-events: auto;
}

#pja-sidebar.open { right: 0; }

.pja-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1e40af;
  color: #fff;
  padding: 12px 14px;
  flex-shrink: 0;
}
.pja-header-left { display: flex; align-items: center; gap: 8px; }
.pja-logo { font-size: 20px; }
.pja-title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.pja-close-btn {
  background: none; border: none; color: rgba(255,255,255,.75);
  font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 4px;
  border-radius: 4px; transition: color .15s;
}
.pja-close-btn:hover { color: #fff; background: rgba(255,255,255,.15); }

.pja-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}
.pja-scroll::-webkit-scrollbar { width: 5px; }
.pja-scroll::-webkit-scrollbar-track { background: #f9fafb; }
.pja-scroll::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }

/* Loading */
.pja-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 14px;
  color: #6b7280;
}
.pja-spinner {
  width: 36px; height: 36px;
  border: 3px solid #e5e7eb;
  border-top-color: #1e40af;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Error */
.pja-error-box {
  padding: 24px 20px;
  text-align: center;
  color: #dc2626;
}
.pja-error-box p { margin-bottom: 12px; }

/* TN Banner */
.pja-tn-banner {
  background: #d1fae5;
  color: #065f46;
  font-size: 11.5px;
  font-weight: 600;
  padding: 8px 14px;
  text-align: center;
  border-bottom: 1px solid #a7f3d0;
}

/* Learning banner — always visible while learn mode is on */
.pja-learn-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 14px;
  background: #ecfeff;
  border-bottom: 1px solid #a5f3fc;
  font-size: 11.5px;
  font-weight: 600;
  color: #0e7490;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.pja-learn-stop-btn {
  margin-left: auto;
  background: none;
  border: 1px solid #0e7490;
  color: #0e7490;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}
.pja-learn-stop-btn:hover { background: #cffafe; }

/* Job info */
.pja-job-info {
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f3f4f6;
}
.pja-job-title {
  font-size: 15px; font-weight: 700; color: #111827;
  line-height: 1.3; margin-bottom: 4px;
}
.pja-job-company { color: #6b7280; font-size: 13px; }

/* Score */
.pja-score-wrap {
  display: flex;
  justify-content: center;
  padding: 16px 0 8px;
  border-bottom: 1px solid #f3f4f6;
}
.pja-score-svg { width: 110px; height: 110px; }

/* Sections */
.pja-section {
  padding: 12px 16px;
  border-bottom: 1px solid #f3f4f6;
}
.pja-section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: #6b7280;
  margin-bottom: 8px;
}

/* Chips */
.pja-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-block; padding: 3px 9px;
  border-radius: 100px; font-size: 11.5px; font-weight: 500; line-height: 1.5;
}
.chip-match { background: #dbeafe; color: #1d4ed8; }
.chip-gap { background: #fff7ed; color: #c2410c; }

/* Tabs */
.pja-tabs { display: flex; gap: 6px; margin-bottom: 8px; }
.pja-tab {
  padding: 5px 12px;
  border: 1.5px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
}
.pja-tab.active {
  border-color: #1e40af;
  background: #1e40af;
  color: #fff;
}
.pja-tab:hover:not(.active) { border-color: #6b7280; }

/* Textarea */
.pja-textarea {
  width: 100%;
  height: 120px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  color: #374151;
  background: #f9fafb;
  font-family: inherit;
  margin-bottom: 6px;
}

/* Recruiter */
.pja-recruiter-title {
  color: #374151;
  font-size: 12.5px;
  margin-bottom: 6px;
  font-style: italic;
}
.pja-query-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11.5px;
  color: #1e40af;
  font-family: 'Menlo', 'Consolas', monospace;
  word-break: break-all;
  margin-bottom: 6px;
  min-height: 32px;
}

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; font-weight: 600; cursor: pointer;
  transition: all .15s; border: none; font-family: inherit;
}
.btn-primary {
  background: #1e40af; color: #fff; padding: 9px 16px;
  font-size: 13px; width: 100%;
}
.btn-primary:hover { background: #1d3a9a; }
.btn-outline {
  background: #fff; color: #374151; border: 1.5px solid #d1d5db;
  font-size: 12px;
}
.btn-outline:hover { border-color: #6b7280; background: #f9fafb; }
.btn-sm { padding: 5px 12px; }

/* Save section */
.pja-save-section {
  padding: 12px 16px;
  border-bottom: 1px solid #f3f4f6;
  display: flex;
  gap: 8px;
}
.pja-select {
  flex: 0 0 140px;
  border: 1.5px solid #d1d5db;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  color: #374151;
  background: #fff;
  font-family: inherit;
  cursor: pointer;
}

/* Toast */
.pja-toast {
  margin: 8px 16px 4px;
  background: #d1fae5;
  color: #065f46;
  border-radius: 6px;
  padding: 8px 12px;
  text-align: center;
  font-weight: 600;
  font-size: 13px;
}

/* Footer */
.pja-footer {
  padding: 10px 16px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.pja-footer a {
  font-size: 12px;
  color: #6b7280;
  text-decoration: none;
}
.pja-footer a:hover { color: #1e40af; }
.pja-mock-badge {
  font-size: 11px;
  background: #fef3c7;
  color: #92400e;
  border-radius: 100px;
  padding: 2px 8px;
  font-weight: 600;
}
.pja-nano-badge {
  font-size: 11px;
  background: #dcfce7;
  color: #166534;
  border-radius: 100px;
  padding: 2px 8px;
  font-weight: 600;
}
.pja-claude-badge {
  font-size: 11px;
  background: #dbeafe;
  color: #1e40af;
  border-radius: 100px;
  padding: 2px 8px;
  font-weight: 600;
}

/* Pre-analyze CTA */
.pja-pre-analyze {
  padding: 20px 16px 16px;
  border-bottom: 1px solid #f3f4f6;
  text-align: center;
}
.btn-full { width: 100%; padding: 11px 16px; font-size: 14px; }
.pja-cost-hint {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 7px;
}

/* Application Tools */
.pja-app-section {
  background: #f8faff;
  border-top: 2px solid #e0e7ff;
}
.pja-app-btns {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
.pja-app-btns .btn-sm { flex: 1; justify-content: center; }
.pja-learn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: #0891b2;
  background: #ecfeff;
  border: 1px solid #a5f3fc;
  border-radius: 6px;
  padding: 5px 9px;
  margin-bottom: 8px;
}
.pja-learn-dot {
  width: 8px; height: 8px;
  background: #0891b2;
  border-radius: 50%;
  animation: pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .4; transform: scale(.75); }
}
.pja-fill-result {
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 6px;
  text-align: center;
}
.pja-fill-result.success { background: #d1fae5; color: #065f46; }
.pja-fill-result.warn { background: #fef3c7; color: #92400e; }
.pja-nano-setup {
  font-size: 11px;
  color: #166534;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  padding: 7px 10px;
  margin-top: 8px;
  line-height: 1.5;
}
.pja-nano-setup code {
  font-size: 10px;
  background: #dcfce7;
  border-radius: 3px;
  padding: 1px 4px;
  word-break: break-all;
}

/* Auto-Apply */
.pja-auto-section { background: #f0fdf4; border-top: 2px solid #bbf7d0; }
.pja-auto-hint { font-size: 11px; color: #6b7280; margin-top: 2px; line-height: 1.5; }
.pja-auto-scan-btn { margin-top: 8px; width: 100%; }
.pja-auto-start-btn { margin-top: 6px; width: 100%; }
.pja-auto-scan-result {
  margin-top: 7px; font-size: 12px; font-weight: 600;
  padding: 7px 10px; border-radius: 6px;
  background: #dbeafe; color: #1e40af; line-height: 1.4;
}
.pja-auto-scan-result.none { background: #fef3c7; color: #92400e; }
.pja-auto-bar-track {
  height: 6px; background: #d1fae5; border-radius: 3px;
  margin: 8px 0 6px; overflow: hidden;
}
.pja-auto-bar {
  height: 100%; width: 0%; background: #16a34a;
  border-radius: 3px; transition: width .4s ease;
}
.pja-auto-status { font-size: 11.5px; color: #374151; font-weight: 500; }
.pja-auto-tally { font-size: 11px; color: #6b7280; margin-top: 3px; margin-bottom: 6px; }
.pja-auto-stop-btn { width: 100%; color: #dc2626; border-color: #fca5a5; }
.pja-auto-stop-btn:hover { background: #fff1f2; }
.pja-auto-done-msg {
  margin-top: 8px; font-size: 12px; font-weight: 600;
  padding: 8px 10px; border-radius: 6px;
  background: #d1fae5; color: #065f46;
}
.pja-auto-skipped-list {
  margin-top: 6px; font-size: 11px; color: #92400e;
  background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 6px; padding: 6px 10px; line-height: 1.6;
}

/* Templates */
.pja-tmpl-section { border-top: 1px solid #e5e7eb; }
.pja-tmpl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 10px 16px 8px;
  user-select: none;
}
.pja-tmpl-header:hover { background: #f9fafb; }
#pja-tmpl-body { padding: 0 14px 10px; }
.pja-tmpl-empty { font-size: 12px; color: #9ca3af; padding: 6px 0 4px; }
.pja-tmpl-card {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  padding: 9px 11px;
  margin-bottom: 7px;
}
.pja-tmpl-card-name {
  font-size: 12px;
  font-weight: 700;
  color: #374151;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pja-tmpl-card-preview {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 7px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pja-tmpl-card-actions { display: flex; gap: 6px; }
.pja-tmpl-form { margin-top: 6px; }
.pja-tmpl-input {
  width: 100%; box-sizing: border-box;
  padding: 7px 10px; border: 1px solid #d1d5db;
  border-radius: 6px; font-size: 12px; margin-bottom: 6px;
  font-family: inherit;
}
.pja-tmpl-textarea {
  width: 100%; box-sizing: border-box;
  padding: 7px 10px; border: 1px solid #d1d5db;
  border-radius: 6px; font-size: 12px;
  font-family: inherit; resize: vertical;
}
.pja-tmpl-input:focus, .pja-tmpl-textarea:focus {
  outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.15);
}
`;
  }

  // Exposed so the FORCE_OPEN message listener (outside the guard) can call it
  window.__pjaForceOpen = function () {
    let jobData = tryExtract();
    if (!jobData) {
      jobData = {
        title: document.title.slice(0, 120) || location.hostname,
        company: location.hostname.replace(/^www\./, ''),
        description: ''
      };
    }
    currentJobData = jobData;
    if (!document.getElementById('pja-host')) injectUI();
    openSidebar();
    showPreAnalyze(jobData);
    initAppTools();
    chrome.runtime.sendMessage({
      type: 'LOG_MANUAL_OPEN',
      url: location.href,
      title: jobData.title,
      domain: location.hostname
    });
  };

  init();
})();
