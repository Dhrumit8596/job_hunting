'use strict';
/* Glassdoor collector — conservatively reads only the currently rendered /Jobs page or the
   currently viewed /job-listing detail. It never paginates, clicks through results, or interacts
   with a bot challenge. Collected records use the existing BATCH_SCORE_JOBS collect-only path. */

(function () {
  if (window.__pjaGlassdoorScraperLoaded) return;
  window.__pjaGlassdoorScraperLoaded = true;
  if (!/(^|\.)glassdoor\.com$/i.test(location.hostname)) return;

  const CARD_SELECTOR = [
    'li[data-test="jobListing"]',
    '[data-test="job-card"]',
    '[data-job-id]',
    '[data-jobid]',
    'article[class*="JobCard"]',
    'li[class*="JobsList_jobListItem"]',
  ].join(',');

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function absoluteUrl(value, baseUrl) {
    try {
      const u = new URL(String(value || ''), baseUrl || location.href);
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (_) { return null; }
  }

  function canonicalUrl(value, baseUrl) {
    const u = absoluteUrl(value, baseUrl);
    if (!u) return '';
    u.hash = '';
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(utm_.+|src|source|ref|refId|trackingId|ao|pos|guid|cb|cs|vt|t)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
    return u.toString();
  }

  function listingIdFromUrl(value, baseUrl) {
    const u = absoluteUrl(value, baseUrl);
    if (!u) return '';
    const queryId = u.searchParams.get('jobListingId') || u.searchParams.get('jl');
    if (queryId) return queryId.trim();
    const pathMatch = u.pathname.match(/(?:jobListingId|job-listing)[_/-](\d{5,})/i);
    return pathMatch ? pathMatch[1] : '';
  }

  function listingLink(root) {
    return root && root.querySelector([
      'a[data-test="job-link"][href]',
      'a[data-test="job-title"][href]',
      'a[href*="jobListingId="]',
      'a[href*="/job-listing/"]',
      'a[class*="JobCard_jobTitle"][href]',
    ].join(','));
  }

  function extractGlassdoorListingId(root, pageUrl) {
    root = root || document;
    const attrs = ['data-job-id', 'data-jobid', 'data-job-listing-id', 'data-listing-id'];
    const nodes = [root];
    if (root.querySelector) {
      const nested = root.querySelector('[data-job-id],[data-jobid],[data-job-listing-id],[data-listing-id]');
      if (nested) nodes.push(nested);
    }
    for (const node of nodes) {
      if (!node || !node.getAttribute) continue;
      for (const attr of attrs) {
        const value = cleanText(node.getAttribute(attr));
        if (value) return value;
      }
    }
    const link = listingLink(root);
    return listingIdFromUrl(link && link.getAttribute('href'), pageUrl)
      || listingIdFromUrl(pageUrl, pageUrl);
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      try {
        const el = root.querySelector(selector);
        const text = cleanText(el && (el.innerText || el.textContent));
        if (text) return text;
      } catch (_) {}
    }
    return '';
  }

  function externalFromGlassdoorWrapper(url) {
    const u = absoluteUrl(url);
    if (!u) return '';
    if (!/(^|\.)glassdoor\.com$/i.test(u.hostname)) return canonicalUrl(u.toString());
    for (const key of ['url', 'redirectUrl', 'target', 'dest', 'destination', 'u']) {
      const value = u.searchParams.get(key);
      if (!value) continue;
      let decoded = value;
      try { decoded = decodeURIComponent(decoded); } catch (_) {}
      const target = absoluteUrl(decoded, u.toString());
      if (target && !/(^|\.)glassdoor\.com$/i.test(target.hostname)) return canonicalUrl(target.toString());
    }
    return '';
  }

  function findDirectApplyUrl(root, pageUrl) {
    if (!root || !root.querySelectorAll) return '';
    const anchors = Array.from(root.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const marker = [
        anchor.getAttribute('data-test'), anchor.getAttribute('aria-label'),
        anchor.getAttribute('title'), anchor.className, anchor.textContent,
      ].map(cleanText).join(' ');
      if (!/\bapply\b/i.test(marker)) continue;
      const href = absoluteUrl(anchor.getAttribute('href'), pageUrl);
      if (!href) continue;
      const direct = externalFromGlassdoorWrapper(href.toString());
      if (direct) return direct;
    }
    return '';
  }

  function queryFromUrl(value) {
    const u = absoluteUrl(value);
    if (!u) return '';
    return cleanText(u.searchParams.get('sc.keyword') || u.searchParams.get('keyword')
      || u.searchParams.get('q') || u.searchParams.get('search') || '');
  }

  function descriptionFrom(root) {
    const text = firstText(root, [
      '[data-test="jobDescriptionContent"]',
      '[class*="JobDetails_jobDescription"]',
      '.jobDescriptionContent',
      '#JobDescriptionContainer',
      '[class*="jobDescription"]',
      '.desc',
    ]);
    return {
      description: text.slice(0, 20000),
      descriptionStatus: !text ? 'missing' : text.length > 20000 ? 'partial' : 'full',
    };
  }

  function detectedAts(url) {
    try {
      if (window.PJADetectAts && typeof window.PJADetectAts.detectAts === 'function') {
        return window.PJADetectAts.detectAts(url) || '';
      }
    } catch (_) {}
    return '';
  }

  function commonRecord(fields, discoveredAt) {
    const sourceRef = {
      kind: 'browser', modality: 'browser-glassdoor', sourcePlatform: 'glassdoor',
      sourceJobId: fields.sourceJobId, listingUrl: fields.listingUrl,
      applyUrl: fields.applyUrl, channel: 'external', detectedAts: fields.detectedAts,
      query: fields.query, discoveredAt, descriptionStatus: fields.descriptionStatus,
    };
    return Object.assign(fields, {
      id: fields.sourceJobId,
      jobId: fields.sourceJobId,
      source: 'browser',
      modality: 'browser-glassdoor',
      sourcePlatform: 'glassdoor',
      platform: 'glassdoor',
      channel: 'external',
      isEasyApply: false,
      indeedApply: false,
      discoveredAt,
      status: 'scoring',
      provenance: { kind: 'browser', modality: 'browser-glassdoor', sourcePlatform: 'glassdoor', query: fields.query, discoveredAt },
      sourceRefs: [sourceRef],
    });
  }

  function extractGlassdoorCardMeta(card, pageUrl, discoveredAt) {
    if (!card) return null;
    const link = listingLink(card);
    const href = canonicalUrl(link && link.getAttribute('href'), pageUrl);
    const listingId = extractGlassdoorListingId(card, pageUrl);
    const listingUrl = href || canonicalUrl(pageUrl);
    const sourceJobId = listingId || (listingUrl ? 'url:' + listingUrl : '');
    if (!sourceJobId) return null;
    const title = firstText(card, [
      '[data-test="job-title"]', '[data-test="job-link"]',
      'a[class*="JobCard_jobTitle"]', '[class*="jobTitle"]', 'a[href*="/job-listing/"]',
    ]);
    if (!title) return null;
    const direct = findDirectApplyUrl(card, pageUrl);
    const fields = {
      sourceJobId,
      title,
      company: firstText(card, [
        '[data-test="employer-name"]', '[class*="EmployerProfile_employerName"]',
        '[class*="employerName"]', '[class*="EmployerName"]', '[class*="companyName"]',
      ]),
      location: firstText(card, [
        '[data-test="emp-location"]', '[data-test="location"]',
        '[class*="JobCard_location"]', '[class*="location"]',
      ]),
      listingUrl,
      url: listingUrl,
      externalApplyUrl: direct || null,
      applyUrl: direct || listingUrl,
      detectedAts: detectedAts(direct),
      description: '',
      descriptionStatus: 'missing',
      query: queryFromUrl(pageUrl),
    };
    return commonRecord(fields, discoveredAt == null ? Date.now() : discoveredAt);
  }

  function extractGlassdoorDetail(root, pageUrl, discoveredAt) {
    root = root || document;
    const listingUrl = canonicalUrl(pageUrl || location.href);
    const listingId = extractGlassdoorListingId(root, listingUrl);
    const sourceJobId = listingId || (listingUrl ? 'url:' + listingUrl : '');
    const title = firstText(root, [
      '[data-test="job-title"]', 'h1[class*="jobTitle"]', '[class*="JobDetails_jobTitle"]',
      'h1.e1tk4kwz5', 'h1[class*="title"]', 'h1',
    ]);
    if (!sourceJobId || !title) return null;
    const direct = findDirectApplyUrl(root, listingUrl);
    const desc = descriptionFrom(root);
    const fields = {
      sourceJobId,
      title,
      company: firstText(root, [
        '[data-test="employer-name"]', '[class*="JobDetails_companyName"]',
        '[class*="employerName"]', '[class*="CompanyName"]', '[class*="companyName"]',
      ]),
      location: firstText(root, [
        '[data-test="location"]', '[data-test="emp-location"]',
        '[class*="JobDetails_location"]', '[class*="location"]',
      ]),
      listingUrl,
      url: listingUrl,
      externalApplyUrl: direct || null,
      applyUrl: direct || listingUrl,
      detectedAts: detectedAts(direct),
      description: desc.description,
      descriptionStatus: desc.descriptionStatus,
      query: queryFromUrl(listingUrl),
    };
    return commonRecord(fields, discoveredAt == null ? Date.now() : discoveredAt);
  }

  function elementVisible(el) {
    for (let cur = el && el.nodeType === 1 ? el : el && el.parentElement; cur; cur = cur.parentElement) {
      if (cur.hidden || cur.getAttribute('aria-hidden') === 'true') return false;
      const style = cur.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
      try {
        const computed = getComputedStyle(cur);
        if (computed.display === 'none' || computed.visibility === 'hidden') return false;
      } catch (_) {}
    }
    return true;
  }

  function visibleText(root) {
    const doc = root && root.ownerDocument || root;
    const base = root && root.nodeType === 1 ? root : doc && doc.body;
    if (!doc || !base || !doc.createTreeWalker) return cleanText(base && base.textContent);
    const walker = doc.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let node;
    while ((node = walker.nextNode())) {
      if (elementVisible(node) && cleanText(node.nodeValue)) chunks.push(node.nodeValue);
    }
    return cleanText(chunks.join(' '));
  }

  function glassdoorChallenged(root) {
    root = root || document;
    const text = visibleText(root);
    if (/verify (that )?you are human|verify you'?re human|are you a robot|unusual traffic|additional verification|required security check|complete the security check|access denied|automated access/i.test(text)) {
      return true;
    }
    const hasCards = !!(root.querySelector && root.querySelector(CARD_SELECTOR));
    if (hasCards) return false; // ignore Glassdoor's normal invisible/background captcha assets
    const challenge = root.querySelector && root.querySelector([
      '#challenge-form', '[data-sitekey]', 'iframe[src*="hcaptcha"]',
      'iframe[src*="recaptcha"]', 'iframe[src*="captcha"]',
    ].join(','));
    return !!challenge && elementVisible(challenge);
  }

  function getCards(root) {
    root = root || document;
    const out = [];
    const seen = new Set();
    for (const card of Array.from(root.querySelectorAll(CARD_SELECTOR))) {
      const id = extractGlassdoorListingId(card, location.href);
      const link = listingLink(card);
      const key = id || canonicalUrl(link && link.getAttribute('href'), location.href);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(card);
    }
    return out;
  }

  function sendCollectOnly(jobs) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'BATCH_SCORE_JOBS', jobs, collectOnly: true }, response => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  function setLocal(values) {
    return new Promise(resolve => {
      try { chrome.storage.local.set(values, resolve); } catch (_) { resolve(); }
    });
  }

  async function collectGlassdoorCurrentPage(opts = {}) {
    const pageUrl = opts.pageUrl || location.href;
    const discoveredAt = opts.discoveredAt == null ? Date.now() : opts.discoveredAt;
    if (glassdoorChallenged(document)) {
      await setLocal({ pja_glassdoor_paused: { reason: 'challenge', url: pageUrl, ts: discoveredAt } });
      return { paused: true, reason: 'challenge', collected: 0, sent: 0 };
    }

    const detailPage = /\/job-listing\//i.test(new URL(pageUrl).pathname);
    let jobs;
    if (detailPage) {
      const job = extractGlassdoorDetail(document, pageUrl, discoveredAt);
      jobs = job ? [job] : [];
    } else {
      jobs = getCards(document).map(card => extractGlassdoorCardMeta(card, pageUrl, discoveredAt)).filter(Boolean);
    }

    let sent = 0;
    for (let i = 0; i < jobs.length; i += 10) {
      const batch = jobs.slice(i, i + 10);
      await sendCollectOnly(batch);
      sent += batch.length;
    }
    await setLocal({ pja_glassdoor_last_scan: {
      url: pageUrl, collected: jobs.length, detail: detailPage, ts: discoveredAt,
    } });
    return { paused: false, collected: jobs.length, sent, jobs };
  }

  // Pure/testable DOM helpers plus a deliberately one-page backend/manual trigger.
  window.pjaGlassdoorChallenged = glassdoorChallenged;
  window.pjaExtractGlassdoorListingId = extractGlassdoorListingId;
  window.pjaExtractGlassdoorCardMeta = extractGlassdoorCardMeta;
  window.pjaExtractGlassdoorDetail = extractGlassdoorDetail;
  window.pjaDecodeGlassdoorApplyUrl = externalFromGlassdoorWrapper;
  window.__pjaStartGlassdoorScan = collectGlassdoorCurrentPage;

  // Passive one-shot collection only. No clicking, scrolling, or pagination.
  const supportedPage = /\/Jobs(?:\/|$)/i.test(location.pathname) || /\/job-listing\//i.test(location.pathname);
  if (supportedPage) setTimeout(() => { collectGlassdoorCurrentPage().catch(() => {}); }, 1600);
})();
