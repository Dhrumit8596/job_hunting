'use strict';

// Conservative Glassdoor collector tests. Synthetic DOM only; no network or account state.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function load(html, url) {
  const dom = new JSDOM(html, {
    url: url || 'https://www.glassdoor.com/Jobs/process-engineer-jobs-SRCH_KO0,16.htm?sc.keyword=process%20engineer',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const sent = [], writes = [];
  w.setTimeout = () => 0; // suppress the production one-shot; tests call the trigger explicitly
  w.PJADetectAts = require('../../sourcing/detect-ats');
  w.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { sent.push(message); if (callback) callback({ success: true }); },
    },
    storage: {
      local: {
        set(value, callback) { writes.push(value); if (callback) callback(); },
      },
    },
  };
  w.console = { log() {}, warn() {}, error() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/glassdoor-scraper.js'), 'utf8'));
  return { w, sent, writes };
}

module.exports = async (t) => {
  const html = `<!DOCTYPE html><body>
    <ul>
      <li data-test="jobListing" data-jobid="100234">
        <a data-test="job-link" href="/job-listing/process-engineer-acme-JV.htm?jobListingId=100234&src=GD_JOB_AD">Process Engineer</a>
        <div data-test="employer-name">Acme Medical</div>
        <div data-test="emp-location">Fremont, CA</div>
        <a data-test="apply-button" href="https://jobs.lever.co/acme/uuid/apply?utm_source=glassdoor">Apply now</a>
      </li>
      <li data-test="jobListing" data-job-id="100235">
        <a data-test="job-title" href="https://www.glassdoor.com/job-listing/quality-engineer-beta-JV.htm?jl=100235">Quality Engineer</a>
        <span class="employerName">Beta Diagnostics</span>
        <span class="JobCard_location">San Diego, CA</span>
      </li>
    </ul>
    <iframe src="https://www.google.com/recaptcha/api2/anchor" style="display:none"></iframe>
  </body>`;
  const { w, sent, writes } = load(html);
  t.ok(typeof w.pjaExtractGlassdoorCardMeta === 'function', 'glassdoor: card helper exported');
  t.ok(typeof w.pjaExtractGlassdoorDetail === 'function', 'glassdoor: detail helper exported');
  t.ok(typeof w.__pjaStartGlassdoorScan === 'function', 'glassdoor: conservative trigger exported');
  t.eq(w.pjaGlassdoorChallenged(w.document), false, 'glassdoor: normal cards + invisible recaptcha are not a challenge');

  const cards = w.document.querySelectorAll('[data-test="jobListing"]');
  const first = w.pjaExtractGlassdoorCardMeta(cards[0], w.location.href, 111);
  t.eq(first.id, '100234', 'glassdoor: stable listing id from card');
  t.eq(first.title, 'Process Engineer', 'glassdoor: title extracted');
  t.eq(first.company, 'Acme Medical', 'glassdoor: company extracted');
  t.eq(first.location, 'Fremont, CA', 'glassdoor: location extracted');
  t.eq(first.sourcePlatform, 'glassdoor', 'glassdoor: platform tagged');
  t.eq(first.channel, 'external', 'glassdoor: channel tagged external');
  t.eq(first.descriptionStatus, 'missing', 'glassdoor: card without JD marked missing');
  t.eq(first.query, 'process engineer', 'glassdoor: search query retained');
  t.eq(first.discoveredAt, 111, 'glassdoor: discovery timestamp retained');
  t.eq(first.detectedAts, 'lever', 'glassdoor: direct apply ATS detected');
  t.eq(first.applyUrl, 'https://jobs.lever.co/acme/uuid/apply', 'glassdoor: direct apply URL preferred and cleaned');
  t.eq(first.sourceRefs[0].sourceJobId, '100234', 'glassdoor: provenance source ref retained');

  const run = await w.__pjaStartGlassdoorScan({ discoveredAt: 222 });
  t.eq(run.collected, 2, 'glassdoor: one rendered search page collected');
  t.eq(run.sent, 2, 'glassdoor: collected jobs sent');
  t.eq(sent.length, 1, 'glassdoor: one batch message sent');
  t.eq(sent[0].type, 'BATCH_SCORE_JOBS', 'glassdoor: uses shared batch pipeline');
  t.eq(sent[0].collectOnly, true, 'glassdoor: collection is collect-only');
  t.eq(sent[0].jobs.length, 2, 'glassdoor: batch contains rendered cards only');
  t.ok(writes.some(x => x.pja_glassdoor_last_scan && x.pja_glassdoor_last_scan.collected === 2), 'glassdoor: scan summary persisted');

  const longDescription = 'metrology '.repeat(2500); // >20k after whitespace normalization
  const detailHtml = `<!DOCTYPE html><body data-job-listing-id="900001">
    <h1 data-test="job-title">Metrology Engineer</h1>
    <div data-test="employer-name">Photon Medical</div>
    <div data-test="location">Santa Clara, CA</div>
    <section data-test="jobDescriptionContent">${longDescription}</section>
    <a aria-label="Apply now" href="https://www.glassdoor.com/redirect?url=${encodeURIComponent('https://jobs.ashbyhq.com/photon/abc/application')}">Apply</a>
  </body>`;
  const detailUrl = 'https://www.glassdoor.com/job-listing/metrology-engineer-photon-JV.htm?jobListingId=900001&utm_source=test';
  const detailLoaded = load(detailHtml, detailUrl);
  const detail = detailLoaded.w.pjaExtractGlassdoorDetail(detailLoaded.w.document, detailUrl, 333);
  t.eq(detail.id, '900001', 'glassdoor detail: stable id extracted');
  t.eq(detail.description.length, 20000, 'glassdoor detail: full JD capped at 20k');
  t.eq(detail.descriptionStatus, 'partial', 'glassdoor detail: truncation marked partial');
  t.eq(detail.applyUrl, 'https://jobs.ashbyhq.com/photon/abc/application', 'glassdoor detail: wrapped direct apply URL decoded');
  t.eq(detail.detectedAts, 'ashby', 'glassdoor detail: destination ATS detected');

  const challengeLoaded = load(`<!DOCTYPE html><body>
    <main>Additional verification required. Verify you are human.</main>
    <iframe src="https://hcaptcha.com/challenge"></iframe>
  </body>`);
  t.eq(challengeLoaded.w.pjaGlassdoorChallenged(challengeLoaded.w.document), true, 'glassdoor: visible human-verification challenge detected');
  const paused = await challengeLoaded.w.__pjaStartGlassdoorScan({ discoveredAt: 444 });
  t.eq(paused.paused, true, 'glassdoor: collector pauses on challenge');
  t.eq(challengeLoaded.sent.length, 0, 'glassdoor: challenge never sends/scans jobs');
  t.ok(challengeLoaded.writes.some(x => x.pja_glassdoor_paused && x.pja_glassdoor_paused.reason === 'challenge'), 'glassdoor: pause reason persisted');

  const hiddenChallenge = load(`<!DOCTYPE html><body>
    <li data-test="jobListing" data-jobid="1"><a data-test="job-link" href="/job-listing/x?jobListingId=1">Process Engineer</a></li>
    <div style="display:none">Verify you are human</div>
  </body>`);
  t.eq(hiddenChallenge.w.pjaGlassdoorChallenged(hiddenChallenge.w.document), false, 'glassdoor: hidden challenge text ignored');
};
