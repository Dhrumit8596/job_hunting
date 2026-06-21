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
    'process control','quality assurance','quality management','iso 9001','process improvement'
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
           null;
  }

  function getJobTitleFromCard(card) {
    // Try aria-label on the primary link first (most stable), then class-based
    const link = card.querySelector('a[href*="/jobs/view/"]');
    if (link?.getAttribute('aria-label')) return link.getAttribute('aria-label').trim();
    return (card.querySelector([
      '.job-card-list__title--link',   // current LinkedIn class
      '.job-card-list__title',          // older variant
      '.base-search-card__title',       // public job search pages
      'a.job-card-container__link'
    ].join(','))?.textContent || '').trim();
  }

  function getJobCompanyFromCard(card) {
    return (card.querySelector([
      '.artdeco-entity-lockup__subtitle',   // current LinkedIn card subtitle
      '.job-card-container__primary-description',
      '.base-search-card__subtitle'
    ].join(','))?.textContent || '').trim();
  }

  function getJobLocationFromCard(card) {
    return (card.querySelector([
      '.artdeco-entity-lockup__caption',    // current LinkedIn card caption
      '.job-card-container__metadata-item',
      '.base-search-card__metadata'
    ].join(','))?.textContent || '').trim();
  }

  // ── Extract full description from the right-side detail panel ─────────────
  // LinkedIn's detail panel is loaded asynchronously after a card click.
  // Poll for content rather than using a fixed sleep so we react as soon as
  // text appears (faster on fast connections) and still wait up to 5 s on
  // slow ones instead of giving up after 1.2 s.
  const DETAIL_POLL_INTERVAL = 200;   // ms between polls
  const DETAIL_POLL_TIMEOUT  = 5000;  // ms before giving up

  const DESCRIPTION_SELECTORS = [
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

  // Returns a Promise that resolves with description text (may be '')
  function waitForDetailPanelDescription() {
    return new Promise(resolve => {
      const deadline = Date.now() + DETAIL_POLL_TIMEOUT;
      function poll() {
        const text = getDetailPanelDescription();
        if (text.length > 100) { resolve(text); return; }
        if (Date.now() >= deadline) { resolve(text); return; }
        setTimeout(poll, DETAIL_POLL_INTERVAL);
      }
      poll();
    });
  }

  function getDetailPanelTitle() {
    return (document.querySelector([
      'h1.job-details-jobs-unified-top-card__job-title',  // current (2024–2025)
      '.jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title'
    ].join(','))?.textContent || '').trim();
  }

  function getDetailPanelCompany() {
    return (document.querySelector([
      '.job-details-jobs-unified-top-card__company-name',  // current (2024–2025)
      '.jobs-unified-top-card__company-name'
    ].join(','))?.textContent || '').trim();
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

  async function scrollToLoadAllCards() {
    // Find the scrollable job-list container. LinkedIn uses a dedicated
    // overflow:auto pane, NOT window scroll, for the left-hand list.
    const listContainer = document.querySelector(
      '[class*="jobs-search-results-list"], [class*="scaffold-layout__list-container"]'
    ) || document.querySelector('.jobs-search-results__list');

    if (!listContainer) return; // fall back silently — window may be scrollable

    let prevCount = 0;
    for (let pass = 0; pass < SCROLL_MAX_PASSES; pass++) {
      listContainer.scrollBy({ top: SCROLL_STEP_PX, behavior: 'smooth' });
      await delay(SCROLL_SETTLE_MS);
      const currentCount = getJobCards().length;
      if (currentCount === prevCount) break; // no new cards loaded — we're at the end
      prevCount = currentCount;
    }
    // Scroll back to top so the first card is visible when we start clicking
    listContainer.scrollTo({ top: 0, behavior: 'instant' });
    await delay(SCROLL_SETTLE_MS);
  }

  // ── Main scan flow ─────────────────────────────────────────────────────────
  let scanning = false;
  const scannedThisSession = new Set(); // prevents re-sending same job in one page session

  async function startScan() {
    if (scanning) return;
    scanning = true;

    const btn = document.getElementById('pja-scan-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

    // Scroll through the list to force lazy-rendered cards into the DOM
    // before we collect them. Without this we only see ~5–10 visible cards.
    setStatus('Loading all job cards…');
    await scrollToLoadAllCards();

    const cards = getJobCards();
    const total = cards.length;

    if (total === 0) {
      setStatus('No job cards found. Try scrolling down first.');
      scanning = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Scan Jobs'; }
      return;
    }

    setStatus(`Found ${total} jobs — scanning…`);
    setProgress(0, total);

    const jobsToScore = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const jobId = getJobIdFromCard(card);
      if (!jobId) continue;

      // Skip jobs already seen this session or already in storage
      if (scannedThisSession.has(jobId)) { setProgress(i + 1, total); continue; }
      const cached = await checkCache(jobId);
      if (cached) { scannedThisSession.add(jobId); setProgress(i + 1, total); continue; }
      scannedThisSession.add(jobId);

      // Get title + company from card
      const title = getJobTitleFromCard(card) || document.title;
      const company = getJobCompanyFromCard(card) || '';
      const location = getJobLocationFromCard(card) || '';

      // Quick title-level keyword check (free filter)
      const titleScore = keywordScore(title + ' ' + company);

      // Click the card to load full description in detail panel, then poll
      // until content appears (up to DETAIL_POLL_TIMEOUT ms) instead of
      // relying on a fixed 1200 ms sleep that frequently times out on slow
      // connections and wastes time on fast ones.
      const link = card.querySelector('a[href*="/jobs/view/"]') || card.querySelector('a');
      if (link) {
        link.click();
      }

      const description = await waitForDetailPanelDescription();
      const descScore = keywordScore(description);

      setProgress(i + 1, total);
      setStatus(`Scanning ${i + 1}/${total}…`);

      // Pre-filter: needs at least 1 keyword match
      if (titleScore + descScore === 0 && description.length < 50) continue;

      const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

      jobsToScore.push({
        id: jobId,
        url: jobUrl,
        title: getDetailPanelTitle() || title,
        company: getDetailPanelCompany() || company,
        location,
        description: description.slice(0, 3000),
        scrapedAt: Date.now(),
        status: 'scoring'
      });

      // Send batch of 10 to background for scoring
      if (jobsToScore.length >= 10) {
        const batch = jobsToScore.splice(0, 10);
        setStatus(`Scoring batch… (${batch.length} jobs)`);
        await sendBatchToBackground(batch);
      }
    }

    // Send remaining
    if (jobsToScore.length > 0) {
      setStatus(`Scoring final batch… (${jobsToScore.length} jobs)`);
      await sendBatchToBackground(jobsToScore);
    }

    setStatus('Scan complete!');
    setProgress(total, total);
    if (btn) { btn.disabled = false; btn.textContent = 'Scan Again'; }

    updateWidgetFromStorage();
    scanning = false;
  }

  function checkCache(jobId) {
    return new Promise(resolve => {
      chrome.storage.local.get('pja_shortlist', r => {
        const list = r.pja_shortlist || [];
        resolve(list.some(j => j.id === jobId));
      });
    });
  }

  function sendBatchToBackground(jobs) {
    return new Promise(resolve => {
      // chrome.runtime.sendMessage throws synchronously (not via callback) when
      // the extension context is invalidated (e.g. after an extension update).
      // Without a try/catch the Promise never settles and the scan hangs forever.
      try {
        chrome.runtime.sendMessage({ type: 'BATCH_SCORE_JOBS', jobs }, resp => {
          if (chrome.runtime.lastError) {
            console.warn('PJA batch error:', chrome.runtime.lastError.message);
          }
          resolve(resp);
        });
      } catch (err) {
        console.warn('PJA sendMessage failed (extension context invalidated?):', err.message);
        resolve(undefined);
      }
    });
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
