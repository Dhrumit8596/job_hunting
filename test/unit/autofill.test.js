'use strict';
// Regression tests for autofill.js pure logic. SYNTHETIC data only — no real PII.
// Contract: pjaClassify receives a LOWERCASED label (as pjaGetLabel produces).
const path = require('path');
const { loadContentScript } = require('./load.js');
const w = loadContentScript(path.resolve(__dirname, '../../content/autofill.js'));

module.exports = (t) => {
  const c = (s) => w.pjaClassify(s);

  // --- PJA_FIELD_RULES ordering invariants (CLAUDE.md "do not re-introduce") ---
  t.eq(c('title'), 'currentTitle', 'bare "title" -> currentTitle (salutation rule is LAST)');
  t.eq(c('job title'), 'currentTitle', '"job title" -> currentTitle');
  t.eq(c('salutation'), 'salutation', '"salutation" -> salutation');
  t.eq(c('location (city)'), 'currentLocation', 'currentLocation BEFORE city ("location (city)")');
  t.eq(c('city'), 'city', 'bare "city" -> city');
  t.eq(c('current location'), 'currentLocation', '"current location" -> currentLocation');

  // --- core field classification ---
  t.eq(c('email address'), 'email', 'email');
  t.eq(c('first name'), 'firstName', 'firstName');
  t.eq(c('last name'), 'lastName', 'lastName');
  t.eq(c('state'), 'state', 'state');
  t.eq(c('zip code'), 'zip', 'zip');
  t.eq(c('phone type'), 'phoneType', 'phoneType before phone');
  t.eq(c('mobile phone'), 'phone', 'phone');
  t.ok(w.pjaIsPhoneFieldDescriptor('text', '', '', 'Phone*'), 'plain text input is phone by label');
  t.ok(w.pjaIsPhoneFieldDescriptor('tel', '', '', ''), 'tel input is phone without id/name');
  t.ok(!w.pjaIsPhoneFieldDescriptor('search', 'iti-1__search-input', '', 'Search'), 'ITI search is not a phone value field');

  // --- work auth vs sponsorship (must not collide) ---
  t.eq(c('are you legally authorized to work in the united states'), 'workAuth', 'workAuth');
  t.eq(c('will you now or in the future require sponsorship'), 'requireSponsorship', 'requireSponsorship');

  // --- short-pattern word-boundary guard (no false substring hits) ---
  t.ok(c('aptitude test score') !== 'address2', '"aptitude" must NOT match the short "apt" pattern');

  // --- pjaNormalizeLabel ---
  t.eq(w.pjaNormalizeLabel('  First   Name * '), 'first name', 'normalize trims/collapses/strips *');

  // --- pjaFuzzyScore ---
  t.eq(w.pjaFuzzyScore('phone type', 'phone type'), 1, 'fuzzy identical = 1');
  t.eq(w.pjaFuzzyScore('phone type', 'favorite color'), 0, 'fuzzy unrelated = 0');

  // --- pjaFindBestAnswer (answer-bank fuzzy lookup) ---
  const answers = {
    'phone type': { answer: 'Mobile', savedAt: 1, usedCount: 0 },
    'are you 18 years of age or older': { answer: 'Yes', savedAt: 1, usedCount: 0 },
  };
  t.eq(w.pjaFindBestAnswer(w.pjaNormalizeLabel('Phone Type'), answers), 'Mobile', 'bank exact match');
  t.eq(w.pjaFindBestAnswer(w.pjaNormalizeLabel('Contact Phone Type'), answers), 'Mobile', 'bank fuzzy match');
  t.eq(w.pjaFindBestAnswer('favorite color', answers), null, 'bank no match -> null');
};
