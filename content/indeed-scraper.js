'use strict';
/* Indeed scraper — runs on indeed.com/jobs* search pages. Collects job cards (jobkey/title/
   company/location), classifies channel (Indeed Apply "Easily apply" vs External ATS), paginates,
   and writes collect-only placeholders to pja_shortlist (scored later via /score-shortlist).
   Anti-bot safe: pauses + flags on any Cloudflare/CAPTCHA challenge (never solves).
   Reuses the shared pipeline (BATCH_SCORE_JOBS, pja_shortlist, router, scorer) — no forks. */

(function () {
  if (window.__pjaIndeedLoaded) return;
  window.__pjaIndeedLoaded = true;
  if (!/(^|\.)indeed\.com$/.test(location.hostname)) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Cluster keyword pre-filter (same intent as the LinkedIn scraper) to skip token spend on
  // clearly off-domain cards when collecting title-only.
  const KW = ['process engineer', 'wafer', 'metrolog', 'inspection', 'defect', 'thin film',
    'photolith', 'cleanroom', 'clean room', 'semiconductor', 'yield', 'failure analysis', 'spc',
    'quality engineer', 'manufacturing engineer', 'equipment engineer', 'process development',
    'process integration', 'reliability', 'fab', 'etch', 'deposition', 'cmp', 'medical', 'device'];
  const kwHit = t => { t = (t || '').toLowerCase(); return KW.some(k => t.includes(k)); };

  // ── Anti-bot guard ─────────────────────────────────────────────────────────
  // NB: Indeed loads an INVISIBLE background reCAPTCHA on every normal results page, so we must
  // NOT flag on the mere presence of "recaptcha"/captcha iframes. A real challenge either shows
  // explicit challenge TEXT, or replaces the results entirely (no job cards) with a CF challenge /
  // visible captcha.
  function indeedChallenged(cardCount) {
    const body = document.body;
    const txt = body ? String(body.innerText || body.textContent || '').slice(0, 60000) : '';
    if (/verify you are human|additional verification required|are you a robot|unusual traffic from your|please verify you'?re a human|complete the security check|let's confirm you are human/i.test(txt)) return true;
    // A real challenge replaces the results: NO job cards present. (Normal pages always have cards
    // AND an invisible bg reCAPTCHA — the no-cards guard avoids that false positive.)
    const hasCards = Number.isFinite(cardCount) ? cardCount > 0 : document.querySelectorAll('[data-jk]').length > 0;
    if (!hasCards) {
      const html = String(document.documentElement && document.documentElement.innerHTML || '').slice(0, 200000);
      if (/cf-challenge|challenge-platform/i.test(html)) return true;
      if (document.querySelector('#challenge-form, iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="captcha"]')) return true;
    }
    return false;
  }

  // ── Card extraction ────────────────────────────────────────────────────────
  function getCardEls() {
    const seen = new Set(); const els = [];
    document.querySelectorAll('[data-jk]').forEach(el => {
      const jk = el.getAttribute('data-jk');
      if (!jk || seen.has(jk)) return;
      seen.add(jk);
      els.push(el.closest('.job_seen_beacon, li, .cardOutline') || el);
    });
    return els;
  }
  function jkOf(card) {
    const a = card.querySelector('[data-jk]') || (card.getAttribute('data-jk') ? card : null);
    return a ? a.getAttribute('data-jk') : null;
  }
  function extractIndeedCardMeta(card) {
    const jk = jkOf(card);
    if (!jk) return null;
    const titleEl = card.querySelector('h2.jobTitle a, h2.jobTitle span[title], a.jcs-JobTitle, [id^="jobTitle"]');
    const compEl = card.querySelector('[data-testid="company-name"], .companyName, span.companyName');
    const locEl = card.querySelector('[data-testid="text-location"], .companyLocation, [data-testid="job-location"]');
    const indeedApply = /easily apply/i.test(card.textContent || '');
    return {
      jobId: jk,
      sourceJobId: jk,
      title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
      company: (compEl?.textContent || '').trim(),
      location: (locEl?.textContent || '').replace(/^\d+\s*min[··]?/i, '').trim(),
      platform: 'indeed',
      sourcePlatform: 'indeed',
      indeedApply,
      channel: indeedApply ? 'indeed_apply' : 'external',
      isEasyApply: false,                                  // not LinkedIn EA; router keys off platform
      listingUrl: 'https://www.indeed.com/viewjob?jk=' + jk,
      applyUrl: 'https://www.indeed.com/viewjob?jk=' + jk, // Indeed job view (external ATS resolved later)
      needsAtsResolution: !indeedApply,
    };
  }

  const DESC_SELECTORS = ['#jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]',
    '.jobsearch-JobComponent-description', '.jobsearch-jobDescriptionText'];
  function getIndeedDetailDescription() {
    for (const sel of DESC_SELECTORS) {
      const el = document.querySelector(sel);
      if ((el?.textContent || '').trim().length > 100) return el.textContent.trim();
    }
    return '';
  }
  function getIndeedDetailTitle() {
    const el = document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, h2[class*="JobInfoHeader-title"]');
    return (el?.getAttribute('title') || el?.textContent || '').trim();
  }
  function indeedDetailMatches(jobId, title, url, shownTitle) {
    const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wanted = n(title), shown = n(shownTitle);
    let visibleId = '';
    try { const u = new URL(String(url || '')); visibleId = u.searchParams.get('jk') || u.searchParams.get('vjk') || ''; } catch (_) {}
    const idMatch = !!(jobId && visibleId && String(jobId) === String(visibleId));
    const titleMatch = !!(wanted && shown && (wanted === shown || wanted.includes(shown) || shown.includes(wanted)));
    return visibleId ? (idMatch && (!wanted || !shown || titleMatch)) : titleMatch;
  }
  function indeedPanelAdvanced(jobId, previousUrl, previousText, currentText) {
    let previousId = '';
    try { const u = new URL(String(previousUrl || '')); previousId = u.searchParams.get('jk') || u.searchParams.get('vjk') || ''; } catch (_) {}
    if (previousId && String(previousId) === String(jobId || '')) return true;
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    return !clean(previousText) || clean(previousText) !== clean(currentText);
  }
  function waitForIndeedDescription(meta, timeoutMs = 4500) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      function poll() {
        const text = getIndeedDetailDescription();
        if (text && indeedDetailMatches(meta.jobId, meta.title, location.href, getIndeedDetailTitle()) &&
            indeedPanelAdvanced(meta.jobId, meta.previousUrl, meta.previousDescription, text)) return resolve(text);
        if (Date.now() >= deadline) return resolve(''); // fail closed: never reuse the previous card's JD
        setTimeout(poll, 200);
      }
      poll();
    });
  }

  async function fetchIndeedDescription(meta, timeoutMs = 6000) {
    let done = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, Math.max(500, timeoutMs - 250));
    const work = (async () => {
      const res = await fetch(meta.listingUrl || ('https://www.indeed.com/viewjob?jk=' + meta.jobId), {
        credentials: 'include',
        signal: ctrl.signal
      });
      if (!res.ok) return '';
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const sel of DESC_SELECTORS) {
        const el = doc.querySelector(sel);
        if ((el?.textContent || '').trim().length > 100) return el.textContent.trim();
      }
      return '';
    })().catch(() => '');
    const timeout = new Promise(resolve => setTimeout(() => { if (!done) resolve(''); }, timeoutMs));
    try { return await Promise.race([work, timeout]); }
    finally { done = true; clearTimeout(timer); try { ctrl.abort(); } catch (_) {} }
  }

  function nextPageEl() {
    return document.querySelector('a[data-testid="pagination-page-next"], a[aria-label="Next Page"], a[aria-label="Next"]');
  }
  function reportedCount() {
    const el = document.querySelector('.jobsearch-JobCountAndSortPane-jobCount, [data-testid="jobsearch-JobCountAndSortPane"] span, div[class*="jobCount"]');
    const m = (el?.textContent || '').replace(/,/g, '').match(/([\d]+)\+?\s*jobs?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // ── Stateful scan (resumes across page loads) ───────────────────────────────
  // Indeed paginates with a FULL page navigation (not SPA), so an in-page loop dies on the next
  // click. We persist scan state in chrome.storage and resume on each search-page load (like the
  // Easy Apply queue), collecting page-by-page until no next page / page cap / challenge.
  const SCAN_KEY = 'pja_indeed_scan';
  const getScan = () => new Promise(r => chrome.storage.local.get(SCAN_KEY, d => r(d[SCAN_KEY] || null)));
  const setScan = s => new Promise(r => chrome.storage.local.set({ [SCAN_KEY]: s }, r));
  const sendCollectOnly = jobs => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, 8000);
    try {
      chrome.runtime.sendMessage({ type: 'BATCH_SCORE_JOBS', jobs, collectOnly: true }, () => {
        clearTimeout(timer);
        finish();
      });
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
  const patchScan = async (scan, patch) => {
    const next = Object.assign({}, scan || {}, patch || {}, { ts: Date.now() });
    await setScan(next);
    return next;
  };
  const failScan = async (scan, reason, extra) => {
    const failed = Object.assign({}, scan || {}, { status: 'failed', reason, url: location.href, ts: Date.now() }, extra || {});
    await setScan(failed); return failed;
  };
  const isSearchPage = () => /\/jobs(\/|$|\?)/.test(location.pathname + location.search) || location.pathname === '/jobs';

  async function startIndeedScan(opts) {
    const params = new URLSearchParams(location.search);
    const scan = { q: params.get('q') || '', l: params.get('l') || '', page: 0,
      maxPages: (opts && opts.maxPages) || 15, ids: [], total: 0, indeedApply: 0,
      hydrateDescriptions: !opts || opts.hydrateDescriptions !== false,
      status: 'running', ts: Date.now() };
    await new Promise(r => chrome.storage.local.set({ pja_indeed_paused: null }, r)); // never inherit a stale challenge
    await setScan(scan);
    try { return await resumeIndeedScanOnLoad(); }
    catch (e) { return failScan(scan, 'start_error', { error: String(e && e.message || e) }); }
  }

  async function resumeIndeedScanOnLoad() {
    if (!isSearchPage()) return failScan(await getScan(), 'not_search_page');
    let scan = await getScan();
    if (!scan || scan.status !== 'running') return;
    scan = await patchScan(scan, { phase: 'resume_enter', url: location.href });
    const params = new URLSearchParams(location.search);
    if ((params.get('q') || '') !== scan.q) return failScan(scan, 'query_mismatch');
    await sleep(1500); // let cards render

    let cards = getCardEls();
    scan = await patchScan(scan, { phase: 'challenge_check', initialCardCount: cards.length });
    if (indeedChallenged(cards.length)) {
      try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'challenge', url: location.href, ts: Date.now() } }); } catch (_) {}
      scan.status = 'paused'; scan.reason = 'challenge'; scan.url = location.href; scan.ts = Date.now(); await setScan(scan); return scan;
    }

    // Results sometimes hydrate after the load event. Wait briefly for cards; an empty normal
    // page is a diagnosable selector/render failure, never an indefinitely-running scan.
    for (let i = 0; !cards.length && i < 10; i++) {
      await sleep(500);
      cards = getCardEls();
      scan = await patchScan(scan, { phase: 'waiting_for_cards', waitIterations: i + 1, cardCount: cards.length });
    }
    if (!cards.length) return failScan(scan, 'no_job_cards_after_ready_wait');
    scan = await patchScan(scan, { phase: 'collecting_cards', cardCount: cards.length });

    // Collect this page's new cards.
    const seen = new Set(scan.ids);
    const pending = [];
    const flushPending = async () => {
      while (pending.length) {
        const b = pending.splice(0, 10);
        await sendCollectOnly(b);
        scan = await patchScan(scan, { phase: 'flushed_jobs', flushedAtTotal: scan.total });
      }
    };
    let newCount = 0;
    for (const card of cards) {
      const meta = extractIndeedCardMeta(card);
      if (!meta || !meta.jobId || seen.has(meta.jobId)) continue;
      seen.add(meta.jobId); scan.ids.push(meta.jobId); scan.total++; newCount++;
      if (meta.indeedApply) scan.indeedApply++;
      if (newCount === 1 || newCount % 5 === 0) {
        scan = await patchScan(scan, { phase: 'collecting_cards', total: scan.total, indeedApply: scan.indeedApply, lastJobId: meta.jobId });
      }
      if (kwHit(meta.title + ' ' + meta.company)) {
        let description = '';
        if (scan.hydrateDescriptions !== false) {
          scan = await patchScan(scan, { phase: 'hydrating_description', total: scan.total, lastJobId: meta.jobId, lastTitle: meta.title || '' });
          description = await fetchIndeedDescription(meta, 4000);
        }
        pending.push({ id: meta.jobId, ...meta, description: description.slice(0, 20000),
          descriptionStatus: description ? (description.length > 20000 ? 'partial' : 'full') : 'missing',
          hydrationStatus: description ? 'hydration_success' : 'hydration_missing_dom',
          hydrationMethod: 'indeed_detail_panel',
          hydrationReason: description ? '' : 'indeed_detail_description_missing_or_timeout',
          hydratedAt: description ? Date.now() : null,
          query: scan.q, discoveredAt: Date.now(), scrapedAt: Date.now(),
          matchedQueries: [scan.q].filter(Boolean),
          pipelineStatus: description ? 'score_pending' : 'needs_hydration',
          status: description ? 'score_pending' : 'needs_hydration' });
        if (pending.length >= 3) await flushPending();
      }
    }
    await flushPending();

    const next = nextPageEl();
    if (next && newCount > 0 && scan.page + 1 < scan.maxPages) {
      scan.page++; await setScan(scan);
      await sleep(2500 + Math.random() * 1800); // humane pacing between pages
      next.click(); // full navigation → resumeIndeedScanOnLoad fires on the next page load
      return;
    }
    // Finished — write coverage + mark done.
    scan.status = 'done'; scan.reason = ''; scan.ts = Date.now(); await setScan(scan);
    const cov = { source: 'indeed', query: scan.q, location: scan.l, collected: scan.total,
      reported: reportedCount(), indeedApply: scan.indeedApply, external: scan.total - scan.indeedApply, ts: Date.now() };
    chrome.storage.local.get('pja_scan_coverage', r => {
      const arr = Array.isArray(r.pja_scan_coverage) ? r.pja_scan_coverage : [];
      arr.push(cov); chrome.storage.local.set({ pja_scan_coverage: arr.slice(-80) });
    });
  }

  // Exports (unit tests + backend trigger via /start-scan {source:'indeed'}).
  window.pjaExtractIndeedCardMeta = extractIndeedCardMeta;
  window.pjaIndeedChallenged = indeedChallenged;
  window.pjaIndeedDetailMatches = indeedDetailMatches;
  window.pjaIndeedPanelAdvanced = indeedPanelAdvanced;
  window.pjaGetIndeedDetailDescription = getIndeedDetailDescription;
  window.pjaWaitForIndeedDescription = waitForIndeedDescription;
  window.__pjaStartIndeedScan = startIndeedScan;

  // Auto-resume across Indeed pagination navigations.
  if (isSearchPage()) { setTimeout(() => { resumeIndeedScanOnLoad().catch(async e => { await failScan(await getScan(), 'resume_error', { error: String(e && e.message || e) }); }); }, 1200); }
})();
