'use strict';
// pjaIsClosedPosting (external-apply.js): detect a dead/closed posting from visible page text so
// a stale queued applyUrl is recorded as `posting_not_found` instead of being misread as a
// description page with a missing Apply button (the Form Energy Ashby 404 case — the /application
// URL and even the base posting rendered "Page not found", whose only controls were footer links).
const path = require('path');
const { loadContentScript } = require('./load.js');
const w = loadContentScript(path.resolve(__dirname, '../../content/external-apply.js'));

module.exports = (t) => {
  const closed = w.pjaIsClosedPosting;
  t.ok(typeof closed === 'function', 'posting-status: pjaIsClosedPosting is exported');

  // Real observed 404 shell (Ashby): body was "Page not found ... Powered by ... Privacy Policy".
  t.ok(closed('Page not found\n\nThe page you requested was not found\n\nPowered by'), 'Ashby 404 shell -> closed');
  t.ok(closed('This position is no longer available'), 'no longer available -> closed');
  t.ok(closed('We are no longer accepting applications for this role'), 'no longer accepting -> closed');
  t.ok(closed('This position has been filled'), 'filled -> closed');
  t.ok(closed('This job is no longer available'), 'job no longer available -> closed');
  t.ok(closed('Posting closed'), 'posting closed -> closed');

  // Must NOT fire on a real application form's text (avoid false skips of live postings).
  t.ok(!closed('Apply for Senior Staff Test Engineer. First name Last name Email Resume Submit application'), 'live form text -> NOT closed');
  t.ok(!closed('Process Engineer, Advanced Bonding. About the role. Responsibilities. Submit application'), 'live description -> NOT closed');
  t.ok(!closed(''), 'empty body -> NOT closed');
  t.ok(!closed('Found the perfect role for you'), 'the word found alone -> NOT closed');
};
