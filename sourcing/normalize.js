'use strict';
// Shared helpers to normalize raw ATS postings into one uniform Job shape.
// Uniform Job: { id, title, company, location, remote, applyUrl, ats, postedAt }

// Detect US-remote from a location string.
function isRemote(loc) {
  return /\bremote\b|work from home|wfh|anywhere/i.test(loc || '');
}

// Collapse whitespace, strip trailing markers.
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
  };
}

module.exports = { makeJob, isRemote, clean };
