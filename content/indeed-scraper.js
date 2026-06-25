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
  function indeedChallenged() {
    const html = document.documentElement.innerHTML;
    return /cf-challenge|hcaptcha|recaptcha|verify you are human|additional verification required|are you a robot|unusual traffic from your/i.test(html)
      || !!document.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], #challenge-form');
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
      title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
      company: (compEl?.textContent || '').trim(),
      location: (locEl?.textContent || '').replace(/^\d+\s*min[··]?/i, '').trim(),
      platform: 'indeed',
      indeedApply,
      isEasyApply: false,                                  // not LinkedIn EA; router keys off platform
      applyUrl: 'https://www.indeed.com/viewjob?jk=' + jk, // Indeed job view (external ATS resolved later)
    };
  }

  function nextPageEl() {
    return document.querySelector('a[data-testid="pagination-page-next"], a[aria-label="Next Page"], a[aria-label="Next"]');
  }
  function reportedCount() {
    const el = document.querySelector('.jobsearch-JobCountAndSortPane-jobCount, [data-testid="jobsearch-JobCountAndSortPane"] span, div[class*="jobCount"]');
    const m = (el?.textContent || '').replace(/,/g, '').match(/([\d]+)\+?\s*jobs?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // ── Scan flow ──────────────────────────────────────────────────────────────
  async function startIndeedScan(opts) {
    if (window.__pjaIndeedScanning) return;
    window.__pjaIndeedScanning = true;
    const MAX_PAGES = (opts && opts.maxPages) || 20;
    const cardMeta = new Map();
    const pending = [];
    const flush = async (force) => {
      while (pending.length >= 10 || (force && pending.length)) {
        const batch = pending.splice(0, 10);
        await new Promise(res => { try { chrome.runtime.sendMessage({ type: 'BATCH_SCORE_JOBS', jobs: batch, collectOnly: true }, () => res()); } catch (_) { res(); } });
      }
    };

    for (let page = 0; page < MAX_PAGES; page++) {
      if (indeedChallenged()) {
        try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'challenge', url: location.href, ts: Date.now() } }); } catch (_) {}
        window.__pjaIndeedScanning = false;
        return { paused: 'challenge', collected: cardMeta.size };
      }
      // collect cards on this page
      for (const card of getCardEls()) {
        const meta = extractIndeedCardMeta(card);
        if (!meta || !meta.jobId) continue;
        if (!cardMeta.has(meta.jobId)) {
          cardMeta.set(meta.jobId, meta);
          if (kwHit(meta.title + ' ' + meta.company)) pending.push({ id: meta.jobId, ...meta, description: '', status: 'scoring' });
        }
      }
      await flush(false);
      const next = nextPageEl();
      if (!next) break;
      next.click();
      await sleep(2500 + Math.random() * 1500); // humane pacing between pages
    }
    await flush(true);

    // Coverage record (collected-vs-reported, channel split).
    const metas = Array.from(cardMeta.values());
    const ia = metas.filter(m => m.indeedApply).length;
    const reported = reportedCount();
    const params = new URLSearchParams(location.search);
    const coverage = { source: 'indeed', query: params.get('q') || '', location: params.get('l') || '',
      collected: metas.length, reported, indeedApply: ia, external: metas.length - ia, ts: Date.now() };
    try {
      chrome.storage.local.get('pja_scan_coverage', r => {
        const arr = Array.isArray(r.pja_scan_coverage) ? r.pja_scan_coverage : [];
        arr.push(coverage); chrome.storage.local.set({ pja_scan_coverage: arr.slice(-80) });
      });
    } catch (_) {}
    window.__pjaIndeedScanning = false;
    return { collected: metas.length, indeedApply: ia, external: metas.length - ia, reported };
  }

  // Exports (unit tests + backend trigger via /start-scan {source:'indeed'}).
  window.pjaExtractIndeedCardMeta = extractIndeedCardMeta;
  window.pjaIndeedChallenged = indeedChallenged;
  window.__pjaStartIndeedScan = startIndeedScan;
})();
