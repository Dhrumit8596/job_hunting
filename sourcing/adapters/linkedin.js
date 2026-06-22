'use strict';
// LinkedIn adapter — LinkedIn has no public jobs API, so cards are SCRAPED in the browser
// (content script / agent DOM read) and POSTed to the dev-server as raw cards. This adapter
// only NORMALIZES those raw cards into the uniform Job shape; it does not fetch.
// Raw card: { jobId, title, company, location, isEasyApply }
const { makeJob } = require('../normalize');

const ATS = 'linkedin';

function normalize(raw, source) {
  const jobId = String(raw.jobId || '').replace(/\D/g, '');
  const job = makeJob({
    id: jobId,
    title: raw.title,
    company: raw.company,
    location: raw.location,
    // Apply happens through LinkedIn: external jobs → the extension extracts the ATS URL on the
    // job-view page; Easy Apply → the in-page modal. applyUrl is the LinkedIn job-view URL.
    applyUrl: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '',
    ats: ATS,
  });
  job.isEasyApply = !!raw.isEasyApply;
  job.linkedinJobId = jobId;
  return job;
}

// No network fetch — cards come pre-scraped. Returns [] if called without cards.
async function fetchJobs(source) {
  const cards = (source && source.cards) || [];
  return cards.map(c => normalize(c, source));
}

module.exports = { ATS, fetchJobs, normalize };
