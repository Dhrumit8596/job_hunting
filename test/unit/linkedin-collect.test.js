'use strict';
// Verifies the LinkedIn collector survives VIRTUALISATION: cards above/below the viewport
// unmount, so a single snapshot only sees ~7. accumulateRenderedCards must union cards seen
// across scroll steps, keyed by jobId, capturing title/company/location/applyUrl/isEasyApply.
// SYNTHETIC data only.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
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
// Replace the rendered card window (simulates virtualisation as the user scrolls).
function render(w, cards) {
  const container = w.document.querySelector('.scaffold-layout__list-container');
  container.innerHTML = '';
  for (const c of cards) container.appendChild(c);
}

module.exports = (t) => {
  const w = load();
  t.ok(typeof w.pjaAccumulateRenderedCards === 'function', 'collect: accumulate exported');
  t.ok(typeof w.pjaExtractCardMeta === 'function', 'collect: extractCardMeta exported');

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

  // re-accumulating the same window adds nothing (idempotent / deduped by jobId)
  const before = map.size;
  render(w, all.slice(0, 7).map(j => makeCard(w, j)));
  const added = w.pjaAccumulateRenderedCards(map);
  t.eq(added, 0, 'collect: re-seeing cards adds no duplicates');
  t.eq(map.size, before, 'collect: size stable on duplicate pass');
};
