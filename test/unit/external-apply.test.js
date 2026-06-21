'use strict';
// Regression tests for the Workday application-question logic extracted from
// external-apply.js. SYNTHETIC data only — no real PII. These lock in the branch
// ORDERING bugs found during the live run (OPT-before-eligible, years-before-basic).
const path = require('path');
const { loadContentScript } = require('./load.js');
const w = loadContentScript(path.resolve(__dirname, '../../content/external-apply.js'));

// Synthetic profile resembling a TN-visa engineer applicant (no real person's data).
const P = {
  workAuth: 'Yes',
  requireSponsorship: 'No',
  willingToRelocate: 'Yes',
  visaStatus: 'TN Visa',
  yearsExperience: '6',
  gender: 'Female',
  ethnicity: '',
  veteran: 'I am not a protected veteran',
  disability: 'No, I do not have a disability',
};

module.exports = (t) => {
  const a = (label) => w.pjaWorkdayAnswerForLabel(label.toLowerCase(), P);

  // --- ORDERING BUG #1: OPT/CPT must be checked before workAuth /eligible/ ---
  t.eq(a('Are you eligible for a 24-month OPT extension?'), 'No', 'OPT extension -> No (NOT workAuth Yes)');
  t.eq(a('Are you currently in a period of Optional Practical Training (OPT)?'), 'No', 'OPT current -> No');
  t.eq(a('Are you legally authorized to work in the United States?'), 'Yes', 'work auth -> Yes');

  // --- ORDERING BUG #2: years-of-experience before basic-requirements (/do you have/) ---
  t.eq(a('How many years of relevant professional experience do you have?'), '__YEARS__', 'years -> __YEARS__ (NOT basic-req Yes)');
  t.eq(a('Do you have at least the basic job requirements listed for this position?'), 'Yes', 'basic requirements -> Yes');

  // --- sponsorship (TN: requireSponsorship=No -> No) ---
  t.eq(a('Will you now, or in the future, require sponsorship (i.e. H-1B)?'), 'No', 'sponsorship -> No');

  // --- EEO ---
  t.eq(a('Please select your sex'), 'Female', 'gender -> profile.gender');
  t.eq(a('Please select your race/ethnicity'), '__DECLINE__', 'race (empty) -> __DECLINE__');
  t.eq(a('Please select your veteran status'), 'I AM NOT A VETERAN', 'veteran -> not a veteran');
  t.eq(a('Voluntary Self-Identification of Disability'), 'NO', 'disability=No -> NO');

  // --- misc ---
  t.eq(a('Are you 18 years of age or older?'), 'Yes', '18+ -> Yes');
  t.eq(a('Are you currently or have you within the last 12 months worked at the company?'), 'No', 'worked-here -> No');
  t.eq(a('What is your favorite color?'), null, 'unknown question -> null');

  // --- sponsorship flips to Yes if profile requires it (synthetic) ---
  t.eq(w.pjaWorkdayAnswerForLabel('require sponsorship', { requireSponsorship: 'Yes' }), 'Yes', 'sponsorship Yes when required');

  // --- pjaPickAnswerOption: __YEARS__ range matching ---
  const yrsOpts = ['Select One', 'No prior experience', '0-2 years of experience', '3-6 years of experience', '7-10 years of experience', '10+ years of Experience'];
  t.eq(w.pjaPickAnswerOption('__YEARS__', yrsOpts, { yearsExperience: '6' }), '3-6 years of experience', 'years 6 -> 3-6 range');
  t.eq(w.pjaPickAnswerOption('__YEARS__', yrsOpts, { yearsExperience: '12' }), '10+ years of Experience', 'years 12 -> 10+');
  t.eq(w.pjaPickAnswerOption('__YEARS__', yrsOpts, { yearsExperience: '1' }), '0-2 years of experience', 'years 1 -> 0-2');

  // --- pjaPickAnswerOption: __DECLINE__ matching variants ---
  t.eq(w.pjaPickAnswerOption('__DECLINE__', ['Male', 'Female', 'I do not wish to self-identify'], P), 'I do not wish to self-identify', 'decline: wish-not');
  t.eq(w.pjaPickAnswerOption('__DECLINE__', ['White', 'Asian', 'Prefer Not To Disclose'], P), 'Prefer Not To Disclose', 'decline: prefer-not');
  t.eq(w.pjaPickAnswerOption('__DECLINE__', ['White', 'Asian'], P), null, 'decline: none available -> null');

  // --- pjaPickAnswerOption: plain includes match (case-insensitive) ---
  t.eq(w.pjaPickAnswerOption('No', ['Yes', 'No'], P), 'No', 'plain Yes/No');
  t.eq(w.pjaPickAnswerOption('I AM NOT A VETERAN', ['I am a protected veteran', 'I AM NOT A VETERAN'], P), 'I AM NOT A VETERAN', 'plain caps match');
};
