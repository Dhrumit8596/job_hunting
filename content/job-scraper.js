'use strict';
/* Job Scraper — runs on linkedin.com/jobs/search* pages only.
   Shows a floating "Scan Jobs" button. On click, walks visible job cards,
   loads each description via the right-panel, keyword-pre-filters, then
   sends batches to background for Claude scoring. */

(function () {
  if (window.__pjaScraperLoaded) return;
  window.__pjaScraperLoaded = true;

  if (!location.hostname.includes('linkedin.com')) return;
  if (!location.pathname.startsWith('/jobs/search') && !location.pathname.startsWith('/jobs/collections')) return;

  // ── Keyword pre-filter (same skill list as background.js) ─────────────────
  const SKILL_KEYWORDS = [
    'spc','statistical process control','metrology','wafer','thin film','clean room','cleanroom',
    'gmp','iso 13485','fmea','lean six sigma','six sigma','photolithography','lithography',
    'optical metrology','8d','semiconductor','inspection','quality engineer','process engineer',
    'metrology engineer','manufacturing engineer','defect','fab','cvd','ald','etch','deposition',
    'process control','quality assurance','quality management','iso 9001','process improvement',
    'equipment','yield','failure analysis','reliability','test engineer','integration','process','quality'
  ];

  function keywordScore(text) {
    const t = text.toLowerCase();
    return SKILL_KEYWORDS.filter(k => t.includes(k)).length;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Extract job cards from search results ──────────────────────────────────
  // Prefer data-attribute and ARIA selectors over class names — LinkedIn
  // renames CSS classes frequently but data attributes are more stable.
  function getJobCards() {
    // data-occludable-job-id is the most stable hook; fall back to role-based
    // and legacy class selectors so older page versions still work.
    const byDataAttr = Array.from(document.querySelectorAll('li[data-occludable-job-id], div[data-occludable-job-id]'));
    if (byDataAttr.length > 0) return byDataAttr;

    // LinkedIn's 2026 React search UI replaced the legacy list-item attributes with a
    // role=button card whose componentkey carries the posting id. Generated CSS classes are not
    // stable enough to use as a contract.
    const byComponentKey = Array.from(document.querySelectorAll(
      '[role="button"][componentkey^="job-card-component-ref-"]'
    ));
    if (byComponentKey.length > 0) return byComponentKey;

    // Fallback: role="listitem" inside the search results scaffold
    const scaffold = document.querySelector(
      '[class*="jobs-search-results-list"], [class*="scaffold-layout__list-container"]'
    );
    if (scaffold) {
      const items = Array.from(scaffold.querySelectorAll('li[role="listitem"], li'));
      if (items.length > 0) return items;
    }

    // Last resort: legacy class-based selectors
    return Array.from(document.querySelectorAll([
      'li.jobs-search-results__list-item',
      'li.job-card-container',
      'div.job-card-container'
    ].join(',')));
  }

  function getJobIdFromCard(card) {
    // data-occludable-job-id is the canonical attribute LinkedIn uses
    return card.dataset.occludableJobId ||
           card.dataset.jobId ||
           card.querySelector('[data-occludable-job-id]')?.dataset.occludableJobId ||
           card.querySelector('[data-job-id]')?.dataset.jobId ||
           String(card.getAttribute('componentkey') || '').match(/^job-card-component-ref-(\d+)$/)?.[1] ||
           null;
  }

  function getJobTitleFromCard(card) {
    // Try aria-label on the primary link first (most stable), then class-based
    const link = card.querySelector('a[href*="/jobs/view/"]');
    if (link?.getAttribute('aria-label')) return link.getAttribute('aria-label').trim();
    const legacy = (card.querySelector([
      '.job-card-list__title--link',   // current LinkedIn class
      '.job-card-list__title',          // older variant
      '.base-search-card__title',       // public job search pages
      'a.job-card-container__link'
    ].join(','))?.textContent || '').trim();
    if (legacy) return legacy;
    const dismiss = card.querySelector('button[aria-label^="Dismiss "][aria-label$=" job"]')
      ?.getAttribute('aria-label') || '';
    return dismiss.replace(/^Dismiss\s+/i, '').replace(/\s+job$/i, '').trim();
  }

  function getJobCompanyFromCard(card) {
    const legacy = (card.querySelector([
      '.artdeco-entity-lockup__subtitle',   // current LinkedIn card subtitle
      '.job-card-container__primary-description',
      '.base-search-card__subtitle'
    ].join(','))?.textContent || '').trim();
    if (legacy) return legacy;
    if (/^job-card-component-ref-\d+$/.test(card.getAttribute('componentkey') || '')) {
      const paragraphs = Array.from(card.querySelectorAll('p'))
        .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return paragraphs[1] || '';
    }
    return '';
  }

  function getJobLocationFromCard(card) {
    const legacy = (card.querySelector([
      '.artdeco-entity-lockup__caption',    // current LinkedIn card caption
      '.job-card-container__metadata-item',
      '.base-search-card__metadata'
    ].join(','))?.textContent || '').trim();
    if (legacy) return legacy;
    if (/^job-card-component-ref-\d+$/.test(card.getAttribute('componentkey') || '')) {
      const paragraphs = Array.from(card.querySelectorAll('p'))
        .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return paragraphs[2] || '';
    }
    return '';
  }

  // LinkedIn marks Easy Apply in the card footer ("Easy Apply" + the LinkedIn glyph).
  function isEasyApplyCard(card) {
    return /easy apply/i.test(card.textContent || '');
  }

  // Card-level metadata (no detail-panel click needed) — what the sourcing pipeline needs.
  function extractCardMeta(card) {
    const jobId = getJobIdFromCard(card);
    if (!jobId) return null;
    return {
      jobId,
      title: getJobTitleFromCard(card) || '',
      company: getJobCompanyFromCard(card) || '',
      location: getJobLocationFromCard(card) || '',
      applyUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
      isEasyApply: isEasyApplyCard(card),
    };
  }

  // Merge currently-rendered cards into an accumulator Map keyed by jobId. LinkedIn VIRTUALISES
  // the list — cards above/below the viewport unmount — so a single snapshot only ever sees the
  // ~7-card rendered window (the root cause of the old undercount). We must collect WHILE
  // scrolling and accumulate. Returns the number of NEW cards added this call.
  function accumulateRenderedCards(map) {
    let added = 0;
    for (const card of getJobCards()) {
      const meta = extractCardMeta(card);
      if (!meta) continue;
      const existing = map.get(meta.jobId);
      if (!existing) { map.set(meta.jobId, meta); added++; }
      else {
        for (const k of ['title', 'company', 'location']) if (!existing[k] && meta[k]) existing[k] = meta[k];
        if (meta.isEasyApply) existing.isEasyApply = true;
      }
    }
    return added;
  }

  // ── Extract full description from the right-side detail panel ─────────────
  // LinkedIn's detail panel is loaded asynchronously after a card click.
  // Poll for content rather than using a fixed sleep so we react as soon as
  // text appears (faster on fast connections) and still wait up to 5 s on
  // slow ones instead of giving up after 1.2 s.
  const DETAIL_POLL_INTERVAL = 200;   // ms between polls
  const DETAIL_POLL_TIMEOUT  = 5000;  // ms before giving up

  const DESCRIPTION_SELECTORS = [
    '[id^="JobDetails_AboutTheJob_"]',       // 2026 React search UI
    '#job-details',                             // most stable — id attribute
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-description',
    '.job-view-layout .jobs-box--fadein',
    '.jobs-unified-top-card ~ div'
  ];

  function getDetailPanelDescription() {
    for (const sel of DESCRIPTION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim().length > 100) return el.textContent.trim();
    }
    return '';
  }

  function linkedInDetailMatches(jobId, title, url, shownTitle) {
    const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wanted = n(title), shown = n(shownTitle);
    const cleanId = String(jobId || '').replace(/\D/g, '');
    const visibleId = String(url || '').match(/(?:currentJobId=|\/jobs\/view\/)(\d+)(?:[/?&#]|$)/i)?.[1] || '';
    const urlMatches = !!(cleanId && visibleId && visibleId === cleanId);
    const titleMatches = !!(wanted && shown && (shown === wanted || shown.includes(wanted) || wanted.includes(shown)));
    // When the page exposes a posting id it is authoritative. Same-title requisitions are common,
    // so a title must never override an explicit id mismatch and attach the previous panel's JD.
    return visibleId ? (urlMatches && (!wanted || !shown || titleMatches)) : titleMatches;
  }

  function linkedInPanelAdvanced(jobId, previousUrl, previousText, currentText) {
    const previousId = String(previousUrl || '').match(/(?:currentJobId=|\/jobs\/view\/)(\d+)(?:[/?&#]|$)/i)?.[1] || '';
    if (previousId && previousId === String(jobId || '').replace(/\D/g, '')) return true;
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    return !clean(previousText) || clean(previousText) !== clean(currentText);
  }

  // Returns a Promise that resolves with description text (may be '')
  function waitForDetailPanelDescription(expected) {
    return new Promise(resolve => {
      const deadline = Date.now() + DETAIL_POLL_TIMEOUT;
      function poll() {
        const text = getDetailPanelDescription();
        const hasExpectation = expected && (expected.jobId || expected.title);
        const identityMatches = linkedInDetailMatches(expected && expected.jobId, expected && expected.title, location.href, getDetailPanelTitle());
        // Never return the previously-open card's text merely because it was already present.
        // Identity (URL/title) must move to the requested card; on timeout fail closed with ''.
        const advanced = !hasExpectation || linkedInPanelAdvanced(expected && expected.jobId,
          expected && expected.previousUrl, expected && expected.previousDescription, text);
        if (text.length > 100 && (!hasExpectation || (identityMatches && advanced))) { resolve(text); return; }
        if (Date.now() >= deadline) { resolve(hasExpectation ? '' : text); return; }
        setTimeout(poll, DETAIL_POLL_INTERVAL);
      }
      poll();
    });
  }

  function getDetailPanelTitle() {
    const legacy = (document.querySelector([
      'h1.job-details-jobs-unified-top-card__job-title',  // current (2024–2025)
      '.jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title'
    ].join(','))?.textContent || '').trim();
    if (legacy) return legacy;
    const visibleId = String(location.href).match(/(?:currentJobId=|\/jobs\/view\/)(\d+)(?:[/?&#]|$)/i)?.[1] || '';
    const link = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]')).find(a =>
      !visibleId || String(a.getAttribute('href') || '').includes(`/jobs/view/${visibleId}/`));
    return (link?.textContent || '').trim();
  }

  function getDetailPanelCompany() {
    const legacy = (document.querySelector([
      '.job-details-jobs-unified-top-card__company-name',  // current (2024–2025)
      '.jobs-unified-top-card__company-name'
    ].join(','))?.textContent || '').trim();
    if (legacy) return legacy;
    return (document.querySelector('[aria-label^="Company,"]')?.textContent || '').trim();
  }

  // Decode LinkedIn's offsite "Apply" wrapper (linkedin.com/safety/go/?url=<encoded ATS url>)
  // into the real ATS application URL, so a LinkedIn-sourced EXTERNAL job can be applied via the
  // same external-apply pipeline. Returns the decoded URL, or null if not resolvable/offsite.
  function pjaDecodeApplyUrl(href) {
    if (!href) return null;
    const m = String(href).match(/[?&]url=([^&]+)/);
    if (/\/safety\/go/i.test(href) && m) { try { return decodeURIComponent(m[1]); } catch (_) { return null; } }
    if (/^https?:\/\//i.test(href) && !/linkedin\.com/i.test(href)) return href; // already direct offsite
    return null;
  }

  // Read the detail-panel "Apply" control's resolved offsite ATS URL (external jobs only; Easy
  // Apply has no offsite link). Used to capture a real applyUrl during the scan.
  function getDetailPanelApplyUrl() {
    const a = Array.from(document.querySelectorAll('a')).find(e =>
      /^apply$/i.test((e.textContent || '').trim()) &&
      /safety\/go|^https?:\/\/(?!www\.linkedin)/i.test(e.getAttribute('href') || ''));
    return a ? pjaDecodeApplyUrl(a.getAttribute('href')) : null;
  }

  // Resolve external ATS apply URLs for a batch of jobIds via LinkedIn's voyager API (no per-job
  // page navigation → fast + account-safe; paced). Writes externalApplyUrl/applyUrl back onto the
  // matching pja_shortlist entries. Must run on a logged-in linkedin.com tab (credentials:include).
  async function pjaResolveVoyagerBatch(jobIds) {
    const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || '';
    const results = {};
    const descriptions = {};
    const findDescriptionText = value => {
      const seen = new Set();
      const walk = node => {
        if (!node || seen.has(node)) return '';
        if (typeof node === 'string') {
          const text = node.replace(/\s+/g, ' ').trim();
          return text.length > 120 && /responsibilities|requirements|qualifications|about|experience|engineer|quality|process/i.test(text) ? text : '';
        }
        if (typeof node !== 'object') return '';
        seen.add(node);
        for (const key of ['descriptionText', 'description', 'jobDescription', 'formattedDescription', 'text']) {
          const got = walk(node[key]);
          if (got) return got;
        }
        for (const value of Object.values(node)) {
          const got = walk(value);
          if (got) return got;
        }
        return '';
      };
      return walk(value);
    };
    let resolved = 0;
    let hydrated = 0;
    for (const jid of jobIds || []) {
      try {
        const url = `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jid}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`;
        const r = await fetch(url, { headers: { 'csrf-token': csrf, accept: 'application/json' }, credentials: 'include' });
        if (r.ok) {
          const j = await r.json();
          const am = j.applyMethod || (j.data && j.data.applyMethod) || {};
          const off = am.companyApplyUrl ? am
            : (am['com.linkedin.voyager.jobs.OffsiteApply'] || am['com.linkedin.voyager.jobs.web.shared.OffsiteApply'] || {});
          const companyUrl = off.companyApplyUrl || null;
          const dec = companyUrl ? (pjaDecodeApplyUrl(companyUrl) || companyUrl) : null;
          results[String(jid)] = dec;
          if (dec) resolved++;
          const desc = findDescriptionText(j);
          if (desc) { descriptions[String(jid)] = desc; hydrated++; }
        } else { results[String(jid)] = null; }
      } catch (_) { results[String(jid)] = null; }
      chrome.storage.local.set({ pja_voyager_resolved: { ts: Date.now(), resolved, hydrated, done: Object.keys(results).length, total: (jobIds || []).length } });
      await delay(250 + Math.random() * 250);
    }
    await new Promise(res => chrome.storage.local.get('pja_shortlist', r => {
      const list = (r.pja_shortlist || []).map(jb => {
        const u = results[String(jb.id || jb.jobId)];
        const desc = descriptions[String(jb.id || jb.jobId)];
        if (!u && !desc) return jb;
        const next = u ? { ...jb, externalApplyUrl: u, applyUrl: u, needsAtsResolution: false } : { ...jb };
        if (desc) Object.assign(next, {
          description: desc.slice(0, 20000),
          descriptionStatus: desc.length > 20000 ? 'partial' : 'full',
          hydrationStatus: 'hydration_success',
          hydrationMethod: 'linkedin_voyager_job_posting',
          hydrationReason: '',
          hydratedAt: Date.now(),
          pipelineStatus: 'score_pending',
          status: 'score_pending',
          fitScore: null,
        });
        return next;
      });
      chrome.storage.local.set({ pja_shortlist: list }, res);
    }));
    return { applyUrls: results, descriptions };
  }

  // ── Inject floating scanner widget ────────────────────────────────────────
  // LinkedIn is a React SPA that can fully replace document.body children on
  // navigation. A simple getElementById guard only prevents double-injection
  // at startup — it does nothing when React unmounts the widget later.
  // We attach a MutationObserver to document.body so we can re-inject
  // whenever our element has been removed.
  let _widgetObserver = null;

  function watchForWidgetRemoval() {
    if (_widgetObserver) return; // already watching
    _widgetObserver = new MutationObserver(() => {
      if (!document.getElementById('pja-scanner')) {
        injectWidget();
      }
    });
    _widgetObserver.observe(document.body, { childList: true, subtree: false });
  }

  function injectWidget() {
    if (document.getElementById('pja-scanner')) return;
    const el = document.createElement('div');
    el.id = 'pja-scanner';
    el.innerHTML = `
      <style>
        #pja-scanner {
          position: fixed; bottom: 80px; right: 20px; z-index: 99999;
          background: #1a1a2e; color: #fff; border-radius: 12px;
          padding: 12px 16px; font-family: system-ui, sans-serif;
          font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          min-width: 200px; max-width: 260px;
        }
        #pja-scanner .pja-scan-title { font-weight: 600; margin-bottom: 6px; font-size: 14px; }
        #pja-scanner .pja-scan-status { color: #9ca3af; font-size: 12px; margin-bottom: 10px; min-height: 18px; }
        #pja-scanner .pja-scan-progress {
          height: 4px; background: #374151; border-radius: 2px; margin-bottom: 10px; display: none;
        }
        #pja-scanner .pja-scan-progress-bar {
          height: 100%; background: #6366f1; border-radius: 2px; transition: width 0.3s; width: 0%;
        }
        #pja-scanner .pja-scan-btn {
          width: 100%; padding: 8px; background: #6366f1; color: #fff;
          border: none; border-radius: 8px; font-size: 13px; font-weight: 600;
          cursor: pointer;
        }
        #pja-scanner .pja-scan-btn:hover { background: #4f46e5; }
        #pja-scanner .pja-scan-btn:disabled { background: #374151; cursor: default; }
        #pja-scanner .pja-scan-link {
          display: none; width: 100%; padding: 8px; background: #059669; color: #fff;
          border: none; border-radius: 8px; font-size: 13px; font-weight: 600;
          cursor: pointer; margin-top: 6px; text-align: center; text-decoration: none;
        }
      </style>
      <div class="pja-scan-title">🔬 Job Scanner</div>
      <div class="pja-scan-status" id="pja-scan-status">Ready to scan this page</div>
      <div class="pja-scan-progress" id="pja-scan-progress">
        <div class="pja-scan-progress-bar" id="pja-scan-bar"></div>
      </div>
      <button class="pja-scan-btn" id="pja-scan-btn">Scan Jobs</button>
      <a class="pja-scan-link" id="pja-shortlist-link" target="_blank">View Shortlist →</a>
    `;
    document.body.appendChild(el);

    document.getElementById('pja-scan-btn').addEventListener('click', startScan);
    updateWidgetFromStorage();

    // Start watching so we can re-inject if LinkedIn's React removes the widget
    watchForWidgetRemoval();
  }

  function setStatus(msg) {
    const el = document.getElementById('pja-scan-status');
    if (el) el.textContent = msg;
  }

  function setProgress(current, total) {
    const bar = document.getElementById('pja-scan-bar');
    const wrap = document.getElementById('pja-scan-progress');
    if (!bar || !wrap) return;
    wrap.style.display = 'block';
    bar.style.width = total > 0 ? Math.round(current / total * 100) + '%' : '0%';
  }

  function updateWidgetFromStorage() {
    chrome.storage.local.get(['pja_shortlist', 'pja_scrape_running'], r => {
      const list = r.pja_shortlist || [];
      const pending = list.filter(j => j.status === 'pending').length;
      const shortlistLink = document.getElementById('pja-shortlist-link');
      if (pending > 0 && shortlistLink) {
        shortlistLink.style.display = 'block';
        shortlistLink.textContent = `View Shortlist (${pending} jobs) →`;
        shortlistLink.href = chrome.runtime.getURL('shortlist/shortlist.html');
      }
    });
  }

  // ── Scroll-to-load: reveal lazy-rendered cards before scanning ───────────
  // LinkedIn virtualises its job list — cards below the viewport are removed
  // from the DOM. Scrolling through the list forces React to render them all
  // so getJobCards() returns the full set, not just what is currently visible.
  const SCROLL_STEP_PX    = 400;  // px per scroll step
  const SCROLL_SETTLE_MS  = 300;  // wait after each step for new cards to mount
  const SCROLL_MAX_PASSES = 30;   // safety cap (~12 000 px / 400 px ≈ 30 pages)

  // Walk ALL results pages for near-complete coverage (LinkedIn caps a query at ~40 pages /
  // ~1000 results; a CA process-engineer variant is typically <500 = <20 pages). Stops early
  // when goToNextPage() finds no next button.
  const SCROLL_MAX_PAGES = 40;

  function findListContainer() {
    return document.querySelector(
      '[componentkey="SearchResultsMainContent"], [class*="jobs-search-results-list"], [class*="scaffold-layout__list-container"]'
    ) || document.querySelector('.jobs-search-results__list') || null;
  }

  // Read LinkedIn's REPORTED result count ("About 123 results" / "123 results") so a scan can
  // report collected-vs-reported coverage. Returns a number or null.
  function pjaReadResultCount() {
    const sel = '.jobs-search-results-list__subtitle, .results-context-header__job-count, [class*="results-context-header"]';
    let txt = '';
    const el = document.querySelector(sel);
    if (el) txt = el.textContent || '';
    if (!/\d/.test(txt)) {
      // Fallback: scan small header spans near the top for "N results".
      const cand = Array.from(document.querySelectorAll('h1, h2, span, div'))
        .map(e => (e.textContent || '').trim())
        .find(t => t.length < 40 && /\b[\d,]+\+?\s+results?\b/i.test(t));
      if (cand) txt = cand;
    }
    const m = txt.replace(/,/g, '').match(/([\d]+)\+?\s*results?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Advance to the next results page (LinkedIn paginates ~25/page via an SPA control).
  // Returns true if it advanced. Prefer the explicit next button, else a numbered page button.
  async function goToNextPage() {
    let next = document.querySelector(
      '.jobs-search-pagination__button--next, button[aria-label="View next page"], button[data-testid="pagination-controls-next-button-visible"]'
    );
    if (!next) {
      next = Array.from(document.querySelectorAll('button[aria-label]'))
        .find(b => /next/i.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null && !b.disabled);
    }
    if (next && !next.disabled && next.offsetParent !== null) { next.click(); await delay(1400); return true; }
    return false;
  }

  // ── Main scan flow ─────────────────────────────────────────────────────────
  let scanning = false;
  const scannedThisSession = new Set(); // prevents re-sending same job in one page session

  async function startScan(opts) {
    if (scanning) return;
    scanning = true;
    // FAST coverage mode: collect card metadata + channel + score by TITLE only — skip the
    // per-card detail-panel click. Lets one run walk all pages across many query variants without
    // hammering the account. External ATS URLs are resolved later, only for the top candidates.
    const FAST = !!(opts && opts.fast);
    const maxPages = Math.max(1, Math.min(SCROLL_MAX_PAGES, Number(opts && opts.maxPages) || SCROLL_MAX_PAGES));
    const scanParams = new URLSearchParams(location.search);
    const scanQuery = scanParams.get('keywords') || '';
    try { chrome.storage.local.set({ pja_linkedin_scan: {
      status: 'running', reason: '', q: scanQuery, url: location.href, maxPages, ts: Date.now()
    } }); } catch (_) {}

    const btn = document.getElementById('pja-scan-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

    // LinkedIn VIRTUALISES the list (cards unmount when scrolled past) and paginates ~25/page.
    // So we walk each page top→bottom and, as cards render, BOTH accumulate their metadata (so
    // the full set survives virtualisation — the old count-based scroll only ever saw ~7) AND
    // click+score the ones not yet seen. cardMeta is the canonical full collected set.
    setStatus('Loading + scanning jobs…');
    const cardMeta = new Map();          // jobId → { jobId,title,company,location,applyUrl,isEasyApply }
    const jobsToScore = [];
    const hydratedCacheIds = await loadHydratedCacheIds();
    let scoredCount = 0;

    for (let page = 0; page < maxPages; page++) {
      const listContainer = findListContainer();
      const scroller = listContainer || document.scrollingElement || document.documentElement;
      if (listContainer) { listContainer.scrollTo({ top: 0, behavior: 'instant' }); await delay(SCROLL_SETTLE_MS); }
      let stable = 0, lastTop = -1;

      for (let pass = 0; pass < SCROLL_MAX_PASSES; pass++) {
        for (const card of getJobCards()) {
          const meta = extractCardMeta(card);
          if (!meta) continue;
          if (!cardMeta.has(meta.jobId)) cardMeta.set(meta.jobId, meta);
          if (scannedThisSession.has(meta.jobId)) continue;   // score each job once
          scannedThisSession.add(meta.jobId);
          setStatus(`Scanning… ${cardMeta.size} found · ${scoredCount} scored`);
          if (hydratedCacheIds.has(String(meta.jobId))) continue;

          let description = '';
          let externalApplyUrl = null;
          let title = meta.title, company = meta.company;
          if (!FAST) {
            // Click the card to load its description into the detail panel (better fit scoring).
            const previousUrl = location.href;
            const previousDescription = getDetailPanelDescription();
            const link = card.querySelector('a[href*="/jobs/view/"]') || card.querySelector('a');
            if (link) link.click();
            else card.click();
            description = await waitForDetailPanelDescription({ jobId: meta.jobId, title: meta.title,
              previousUrl, previousDescription });
            // Free pre-filter: need at least one keyword in title/company/desc.
            if (keywordScore(meta.title + ' ' + meta.company) + keywordScore(description) === 0 && description.length < 50) continue;
            // Capture the real offsite ATS apply URL for external jobs (decoded from LinkedIn's
            // safety-go wrapper), so LinkedIn-sourced external roles are applyable via external-apply.
            externalApplyUrl = meta.isEasyApply ? null : getDetailPanelApplyUrl();
            title = getDetailPanelTitle() || meta.title;
            company = getDetailPanelCompany() || meta.company;
          } else {
            // FAST: pre-filter on title+company only (no description available).
            if (keywordScore(meta.title + ' ' + meta.company) === 0) continue;
          }
          jobsToScore.push({
            id: meta.jobId, jobId: meta.jobId, sourceJobId: meta.jobId,
            sourcePlatform: 'linkedin', platform: 'linkedin', url: meta.applyUrl,
            listingUrl: meta.applyUrl,
            title, company,
            location: meta.location, isEasyApply: meta.isEasyApply,
            channel: meta.isEasyApply ? 'linkedin_easy_apply' : 'external',
            applyUrl: externalApplyUrl || meta.applyUrl, externalApplyUrl: externalApplyUrl || null,
            needsAtsResolution: FAST && !meta.isEasyApply, // external job whose ATS URL isn't decoded yet
            description: description.slice(0, 20000),
            descriptionStatus: description ? (description.length > 20000 ? 'partial' : 'full') : 'missing',
            hydrationStatus: description ? 'hydration_success' : (FAST ? 'hydration_deferred_fast_scan' : 'hydration_missing_dom'),
            hydrationMethod: description ? 'linkedin_detail_panel' : (FAST ? 'linkedin_fast_card_scan' : 'linkedin_detail_panel'),
            hydrationReason: description ? '' : (FAST ? 'fast_scan_skipped_detail' : 'detail_panel_description_missing'),
            hydratedAt: description ? Date.now() : null,
            query: new URLSearchParams(location.search).get('keywords') || '',
            matchedQueries: [new URLSearchParams(location.search).get('keywords') || ''].filter(Boolean),
            discoveredAt: Date.now(), scrapedAt: Date.now(),
            // FAST collection intentionally has no detail panel. Preserve that truth so the
            // unified pipeline schedules hydration before evidence scoring.
            pipelineStatus: description ? 'score_pending' : 'needs_hydration',
            status: description ? 'score_pending' : 'needs_hydration'
          });
          scoredCount++;
          if (jobsToScore.length >= 10) { await sendBatchToBackground(jobsToScore.splice(0, 10), FAST); }
        }

        // Scroll one step and stop when we reach the bottom and the position holds (virtualised
        // lists keep mounting as we go, so stop on bottom+stable rather than on count plateau).
        if (listContainer) listContainer.scrollBy({ top: SCROLL_STEP_PX, behavior: 'instant' });
        else window.scrollBy(0, SCROLL_STEP_PX);
        await delay(SCROLL_SETTLE_MS);
        const top = scroller.scrollTop;
        const atBottom = top + scroller.clientHeight >= scroller.scrollHeight - 4;
        if (Math.abs(top - lastTop) < 2) stable++; else stable = 0;
        lastTop = top;
        if (atBottom && stable >= 2) break;
      }

      // Do not navigate after the final bounded page: navigation can destroy this execution
      // context before coverage and collected jobs are persisted, making a successful scan look
      // like a timeout. Multi-page scans advance only when another iteration is actually allowed.
      if (page + 1 >= maxPages || !(await goToNextPage())) break;
    }

    const total = cardMeta.size;
    if (total === 0) {
      setStatus('No job cards found. Try scrolling down first.');
      try { chrome.storage.local.set({ pja_linkedin_scan: {
        status: 'failed', reason: 'no_job_cards', q: scanQuery, url: location.href, maxPages, ts: Date.now()
      } }); } catch (_) {}
      scanning = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Scan Jobs'; }
      return;
    }

    // Send remaining
    if (jobsToScore.length > 0) {
      setStatus(`Scoring final batch… (${jobsToScore.length} jobs)`);
      await sendBatchToBackground(jobsToScore, FAST);
    }

    // Coverage report: collected-vs-LinkedIn-reported, channel split. Appended (by query) to
    // pja_scan_coverage so the unified run can verify near-complete coverage (not a sample).
    const metas = Array.from(cardMeta.values());
    const easyCount = metas.filter(m => m.isEasyApply).length;
    const reported = pjaReadResultCount();
    const params = new URLSearchParams(location.search);
    const coverage = {
      source: 'linkedin', query: params.get('keywords') || '', location: params.get('location') || '',
      collected: total, reported,
      coverage: (reported && reported > 0) ? Math.round((total / reported) * 100) : null,
      easyApply: easyCount, external: total - easyCount, ts: Date.now(),
    };
    try {
      chrome.storage.local.get('pja_scan_coverage', r => {
        const arr = Array.isArray(r.pja_scan_coverage) ? r.pja_scan_coverage : [];
        arr.push(coverage);
        chrome.storage.local.set({ pja_scan_coverage: arr.slice(-50), pja_linkedin_scan: {
          status: 'done', reason: '', q: coverage.query, url: location.href, maxPages,
          total, easyApply: easyCount, external: total - easyCount, ts: coverage.ts
        } });
      });
    } catch (_) {}

    setStatus(`Scan complete — collected ${total}${reported ? '/' + reported : ''} jobs (EA ${easyCount}, ext ${total - easyCount}).`);
    setProgress(total, total);
    if (btn) { btn.disabled = false; btn.textContent = 'Scan Again'; }

    updateWidgetFromStorage();
    scanning = false;
  }

  function loadHydratedCacheIds() {
    return new Promise(resolve => {
      let done = false;
      const finish = list => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(new Set((list || []).filter(j => j && j.pipelineStatus !== 'needs_hydration' &&
          !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || '')))
          .map(j => String(j.id || ''))));
      };
      const timer = setTimeout(() => finish([]), 5000);
      chrome.storage.local.get('pja_shortlist', r => {
        // Snapshot once per query. Reading the full shortlist once per card made a 25-card scan
        // perform 25 large storage reads and routinely overrun the source observation window.
        finish(r.pja_shortlist || []);
      });
    });
  }

  function sendBatchToBackground(jobs, collectOnly) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(undefined), 8000);
      // chrome.runtime.sendMessage throws synchronously (not via callback) when
      // the extension context is invalidated (e.g. after an extension update).
      // Without a try/catch the Promise never settles and the scan hangs forever.
      try {
        chrome.runtime.sendMessage({ type: 'BATCH_SCORE_JOBS', jobs, collectOnly: !!collectOnly }, resp => {
          if (chrome.runtime.lastError) {
            console.warn('PJA batch error:', chrome.runtime.lastError.message);
          }
          finish(resp);
        });
      } catch (err) {
        console.warn('PJA sendMessage failed (extension context invalidated?):', err.message);
        finish(undefined);
      }
    });
  }

  // Expose collection helpers for unit tests (virtualisation accumulation is the core fix).
  if (typeof window !== 'undefined') {
    window.pjaExtractCardMeta = extractCardMeta;
    window.pjaAccumulateRenderedCards = accumulateRenderedCards;
    window.pjaDecodeApplyUrl = pjaDecodeApplyUrl;
    window.pjaWaitForLinkedInDescription = waitForDetailPanelDescription;
    window.pjaLinkedInDetailMatches = linkedInDetailMatches;
    window.pjaLinkedInPanelAdvanced = linkedInPanelAdvanced;
    window.__pjaStartScan = startScan; // backend-triggerable (dev-server /start-scan → WS)
    window.__pjaResolveVoyager = pjaResolveVoyagerBatch; // backend-triggerable (/resolve-ats)
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectWidget);
  } else {
    injectWidget();
  }

  // Re-check widget state on storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pja_shortlist) updateWidgetFromStorage();
  });

})();
