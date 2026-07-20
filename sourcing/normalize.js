'use strict';
// Shared helpers to normalize raw ATS postings into one uniform Job shape.
// Uniform Job: { id, title, company, location, remote, applyUrl, ats, postedAt, description }

// Detect US-remote from a location string.
function isRemote(loc) {
  return /\bremote\b|work from home|wfh|anywhere/i.test(loc || '');
}

// Collapse whitespace, strip trailing markers.
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function cleanDescription(s) {
  return clean(String(s || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

// Build a uniform Job record. Missing fields default to ''/false.
function makeJob(f) {
  const location = clean(f.location);
  return {
    id: String(f.id || ''),
    title: clean(f.title),
    company: clean(f.company),
    location,
    remote: f.remote != null ? !!f.remote : isRemote(location),
    applyUrl: f.applyUrl || '',
    ats: f.ats || '',
    postedAt: f.postedAt || '',
    // The corpus lives in IndexedDB, so retain the qualifications/legal tail as well as the role
    // summary. Scoring still uses a bounded head+tail excerpt per request.
    description: cleanDescription(f.description || '').slice(0, 20000),
  };
}

module.exports = { makeJob, isRemote, clean, cleanDescription };
