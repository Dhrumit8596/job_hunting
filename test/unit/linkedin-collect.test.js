'use strict';
// Verifies the LinkedIn collector survives VIRTUALISATION: cards above/below the viewport
// unmount, so a single snapshot only sees ~7. accumulateRenderedCards must union cards seen
// across scroll steps, keyed by jobId, capturing title/company/location/applyUrl/isEasyApply.
// SYNTHETIC data only.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const BrowserBatch = require('../../browser-batch');
const ROOT = path.resolve(__dirname, '../..');

function load() {
  const dom = new JSDOM('<!DOCTYPE html><body><div class="scaffold-layout__list-container"></div></body>',
    { url: 'https://www.linkedin.com/jobs/search/?keywords=quality%20engineer', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    storage: {
      local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: p => p },
  };
  w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'browser-batch.js'), 'utf8'));
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/job-scraper.js'), 'utf8'));
  return w;
}

// Build a LinkedIn-style card <li data-occludable-job-id> with the selectors the helpers read.
function makeCard(w, { id, title, company, location, easy }) {
  const li = w.document.createElement('li');
  li.setAttribute('data-occludable-job-id', String(id));
  const a = w.document.createElement('a');
  a.setAttribute('href', `/jobs/view/${id}/`);
  a.setAttribute('aria-label', title);
  a.textContent = title;
  li.appendChild(a);
  const sub = w.document.createElement('div'); sub.className = 'artdeco-entity-lockup__subtitle'; sub.textContent = company; li.appendChild(sub);
  const cap = w.document.createElement('div'); cap.className = 'artdeco-entity-lockup__caption'; cap.textContent = location; li.appendChild(cap);
  if (easy) { const e = w.document.createElement('span'); e.textContent = 'Easy Apply'; li.appendChild(e); }
  return li;
}

// LinkedIn's 2026 React search card: generated classes, no posting link/data-job-id, and the
// stable posting identity carried by componentkey.
function makeReactCard(w, { id, title, company, location, easy }) {
  const card = w.document.createElement('div');
  card.setAttribute('role', 'button');
  card.setAttribute('componentkey', `job-card-component-ref-${id}`);
  const titleP = w.document.createElement('p'); titleP.textContent = `${title} ${title}`; card.appendChild(titleP);
  const companyP = w.document.createElement('p'); companyP.textContent = company; card.appendChild(companyP);
  const locationP = w.document.createElement('p'); locationP.textContent = location; card.appendChild(locationP);
  const dismiss = w.document.createElement('button'); dismiss.setAttribute('aria-label', `Dismiss ${title} job`); card.appendChild(dismiss);
  if (easy) { const e = w.document.createElement('p'); e.textContent = 'Easy Apply'; card.appendChild(e); }
  return card;
}
// Replace the rendered card window (simulates virtualisation as the user scrolls).
function render(w, cards) {
  const container = w.document.querySelector('.scaffold-layout__list-container');
  container.innerHTML = '';
  for (const c of cards) container.appendChild(c);
}

module.exports = (t) => {
  const scraperSource = fs.readFileSync(path.resolve(ROOT, 'content/job-scraper.js'), 'utf8');
  t.eq(BrowserBatch.pageContinuationDecision({ page: 3, stableIds: 20,
    deterministicAccepted: 10, inserted: 8, directRoutes: 2 }, [],
  { maxPages: 3, remainingMs: 60000 }).reason, 'page_cap',
    'LinkedIn bounded discovery persists final-page coverage without navigating away');
  t.ok(!scraperSource.includes('if (hydratedCacheIds.has(meta.jobId)) continue;'),
    'LinkedIn discovery does not skip known hydrated IDs before freshness acknowledgement');
  const w = load();
  t.ok(typeof w.pjaAccumulateRenderedCards === 'function', 'collect: accumulate exported');
  t.ok(typeof w.pjaExtractCardMeta === 'function', 'collect: extractCardMeta exported');
  t.eq(w.pjaCleanLinkedInTitle('Process Engineer with verification'), 'Process Engineer',
    'collect: verified-company badge text is not retained in the job title');
  t.eq(w.pjaCleanLinkedInTitle('Verification Engineer'), 'Verification Engineer',
    'collect: a legitimate verification title remains intact');

  // 20 jobs exist, but only a 7-card window is ever in the DOM at once.
  const all = [];
  for (let i = 1; i <= 20; i++) all.push({ id: 1000 + i, title: `Quality Engineer ${i}`, company: `Co ${i}`, location: 'Fremont, CA', easy: i % 2 === 0 });

  const map = new Map();
  // walk the list in overlapping windows of 7, accumulating as we "scroll"
  for (let start = 0; start < all.length; start += 5) {
    render(w, all.slice(start, start + 7).map(j => makeCard(w, j)));
    w.pjaAccumulateRenderedCards(map);
  }

  t.eq(map.size, 20, 'collect: accumulates ALL 20 jobs across scroll windows (not just the ~7 visible)');

  const sample = map.get('1002');
  t.eq(sample.title, 'Quality Engineer 2', 'collect: captures title');
  t.eq(sample.company, 'Co 2', 'collect: captures company');
  t.eq(sample.location, 'Fremont, CA', 'collect: captures location');
  t.eq(sample.applyUrl, 'https://www.linkedin.com/jobs/view/1002/', 'collect: builds apply URL from jobId');
  t.eq(sample.isEasyApply, true, 'collect: flags Easy Apply card');
  t.eq(map.get('1001').isEasyApply, false, 'collect: non-Easy-Apply card flagged false');

  // Current LinkedIn React cards must not silently collapse sourcing to zero when class names
  // rotate and legacy data-occludable-job-id hooks disappear.
  render(w, [makeReactCard(w, { id: 4451913133, title: 'Metrology Engineer',
    company: 'Headway Technologies', location: 'Milpitas, CA (On-site)', easy: true })]);
  const reactMap = new Map();
  w.pjaAccumulateRenderedCards(reactMap);
  const reactCard = reactMap.get('4451913133');
  t.ok(!!reactCard, 'collect: 2026 componentkey React card is discovered');
  t.eq(reactCard.title, 'Metrology Engineer', 'collect: React card title comes from stable dismiss label');
  t.eq(reactCard.company, 'Headway Technologies', 'collect: React card company captured');
  t.eq(reactCard.location, 'Milpitas, CA (On-site)', 'collect: React card location captured');
  t.eq(reactCard.isEasyApply, true, 'collect: React card Easy Apply channel captured');

  render(w, [makeReactCard(w, { id: 4451913134, title: 'Process Engineer with verification',
    company: 'Example Semiconductor', location: 'San Jose, CA', easy: false })]);
  const verifiedBadgeMap = new Map();
  w.pjaAccumulateRenderedCards(verifiedBadgeMap);
  t.eq(verifiedBadgeMap.get('4451913134').title, 'Process Engineer',
    'collect: React card extraction behaviorally strips the trailing verification badge');

  // re-accumulating the same window adds nothing (idempotent / deduped by jobId)
  const before = map.size;
  render(w, all.slice(0, 7).map(j => makeCard(w, j)));
  const added = w.pjaAccumulateRenderedCards(map);
  t.eq(added, 0, 'collect: re-seeing cards adds no duplicates');
  t.eq(map.size, before, 'collect: size stable on duplicate pass');

  // --- apply-URL decode (LinkedIn safety-go wrapper -> real ATS URL) ---
  t.ok(typeof w.pjaDecodeApplyUrl === 'function', 'decode: pjaDecodeApplyUrl exported');
  t.eq(w.pjaDecodeApplyUrl('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fgrnh.se%2F9tamd08z8us&trk=x'),
    'https://grnh.se/9tamd08z8us', 'decode: extracts + decodes the offsite ATS url from safety-go');
  t.eq(w.pjaDecodeApplyUrl('https://boards.greenhouse.io/acme/jobs/123'),
    'https://boards.greenhouse.io/acme/jobs/123', 'decode: passes through a direct offsite URL');
  t.eq(w.pjaDecodeApplyUrl('https://www.linkedin.com/jobs/view/123/'), null, 'decode: LinkedIn (Easy Apply / internal) -> null');
  t.eq(w.pjaDecodeApplyUrl(''), null, 'decode: empty -> null');

  // Detail hydration must bind the description to the requested card, otherwise the previous
  // panel's JD can be scored against the wrong role.
  t.ok(typeof w.pjaLinkedInDetailMatches === 'function', 'detail: identity guard exported');
  t.eq(w.pjaLinkedInDetailMatches('1002', 'Quality Engineer 2',
    'https://www.linkedin.com/jobs/search/?currentJobId=1002', 'Different title'), false,
  'detail: new URL id cannot reuse the previous panel title/JD');
  t.eq(w.pjaLinkedInDetailMatches('1002', 'Quality Engineer 2',
    'https://www.linkedin.com/jobs/search/?currentJobId=1002', 'Quality Engineer 2'), true,
  'detail: requested job id and panel title must agree');
  t.eq(w.pjaLinkedInDetailMatches('1002', 'Quality Engineer 2',
    'https://www.linkedin.com/jobs/search/?currentJobId=9999', 'Old Process Engineer'), false,
  'detail: stale prior panel rejected');
  t.eq(w.pjaLinkedInDetailMatches('1002', 'Quality Engineer',
    'https://www.linkedin.com/jobs/search/?currentJobId=9999', 'Quality Engineer'), false,
  'detail: matching title cannot override an explicit different requisition id');
  t.eq(w.pjaLinkedInPanelAdvanced('1002', 'https://www.linkedin.com/jobs/search/?currentJobId=9999',
    'old requirements', 'old requirements'), false, 'detail: URL movement waits for JD content mutation');
  t.eq(w.pjaLinkedInPanelAdvanced('1002', 'https://www.linkedin.com/jobs/search/?currentJobId=9999',
    'old requirements', 'new requirements'), true, 'detail: mutated JD content is accepted');
};
