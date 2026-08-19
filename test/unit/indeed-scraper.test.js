'use strict';
// Indeed scraper tests: card extraction (jobkey/title/company/location), channel classification
// (Indeed "Easily apply" vs External), and the anti-bot challenge detector. SYNTHETIC DOM only.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function load(html) {
  const dom = new JSDOM(html, { url: 'https://www.indeed.com/jobs?q=process+engineer&l=California', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} } } };
  w.console = { log() {}, warn() {}, error() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'browser-batch.js'), 'utf8'));
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/indeed-scraper.js'), 'utf8'));
  return w;
}

function card(jk, title, company, location, easily) {
  return `<div class="job_seen_beacon">
    <a data-jk="${jk}" class="jcs-JobTitle"><span title="${title}">${title}</span></a>
    <span data-testid="company-name">${company}</span>
    <div data-testid="text-location">${location}</div>
    ${easily ? '<span>Easily apply</span>' : ''}
  </div>`;
}

module.exports = (t) => {
  const w = load(`<!DOCTYPE html><body>
    ${card('abc123', 'Manufacturing Engineer', 'ECA Medical Instruments', 'Newbury Park, CA', true)}
    ${card('def456', 'Senior Principal Process Engineer', 'Coherent Corp.', '5 min·Sunnyvale, CA', false)}
  </body>`);

  t.ok(typeof w.pjaExtractIndeedCardMeta === 'function', 'indeed: extractor exposed on window');

  const c1 = w.document.querySelectorAll('.job_seen_beacon')[0];
  const m1 = w.pjaExtractIndeedCardMeta(c1);
  t.eq(m1.jobId, 'abc123', 'indeed: jobkey from data-jk');
  t.eq(m1.title, 'Manufacturing Engineer', 'indeed: title parsed');
  t.eq(m1.company, 'ECA Medical Instruments', 'indeed: company parsed');
  t.eq(m1.platform, 'indeed', 'indeed: platform tagged');
  t.eq(m1.sourcePlatform, 'indeed', 'indeed: canonical sourcePlatform tagged');
  t.eq(m1.channel, 'indeed_apply', 'indeed: application channel tagged');
  t.eq(m1.indeedApply, true, 'indeed: "Easily apply" → indeedApply=true');
  t.eq(m1.isEasyApply, false, 'indeed: not LinkedIn EA');
  t.ok(/viewjob\?jk=abc123$/.test(m1.applyUrl), 'indeed: applyUrl is the viewjob URL');

  const c2 = w.document.querySelectorAll('.job_seen_beacon')[1];
  const m2 = w.pjaExtractIndeedCardMeta(c2);
  t.eq(m2.indeedApply, false, 'indeed: no "Easily apply" → external (indeedApply=false)');
  t.eq(m2.needsAtsResolution, true, 'indeed: offsite card is retained for later ATS resolution');
  t.ok(/sunnyvale/i.test(m2.location) && !/min/i.test(m2.location), 'indeed: location strips the "N min" commute prefix');

  // anti-bot challenge detector
  t.eq(w.pjaIndeedChallenged(), false, 'indeed: normal results page → not challenged');
  const wc = load('<!DOCTYPE html><body><div>Additional Verification Required</div><iframe src="https://hcaptcha.com/x"></iframe></body>');
  t.eq(wc.pjaIndeedChallenged(), true, 'indeed: captcha/hcaptcha page → challenged (pause)');
  t.eq(w.pjaIndeedDetailMatches('abc123', 'Manufacturing Engineer',
    'https://www.indeed.com/jobs?q=x&vjk=abc123', 'Old title'), false,
  'indeed: new job key cannot reuse the previous panel title/JD');
  t.eq(w.pjaIndeedDetailMatches('abc123', 'Manufacturing Engineer',
    'https://www.indeed.com/jobs?q=x&vjk=abc123', 'Manufacturing Engineer'), true,
  'indeed: detail identity requires job key and title agreement');
  t.eq(w.pjaIndeedDetailMatches('abc123', 'Manufacturing Engineer',
    'https://www.indeed.com/jobs?q=x&vjk=old', 'Senior Software Engineer'), false,
  'indeed: stale prior detail panel rejected');
  t.eq(w.pjaIndeedDetailMatches('abc123', 'Manufacturing Engineer',
    'https://www.indeed.com/jobs?q=x&vjk=old', 'Manufacturing Engineer'), false,
  'indeed: matching title cannot override a different visible job key');
  t.eq(w.pjaIndeedPanelAdvanced('abc123', 'https://www.indeed.com/jobs?vjk=old',
    'old requirements', 'old requirements'), false, 'indeed: waits for JD mutation after job-key movement');
  t.eq(w.pjaIndeedPanelAdvanced('abc123', 'https://www.indeed.com/jobs?vjk=old',
    'old requirements', 'new requirements'), true, 'indeed: accepts mutated JD content');
  t.eq(w.pjaIndeedPageNumberFromUrl('https://www.indeed.com/jobs?q=x&start=20'), 2,
    'indeed: full-navigation checkpoint derives the expected page from the URL');
};
