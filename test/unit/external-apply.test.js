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

  // --- pjaSelectAiAnswer: label-match + confidence gating (inline AI answerer) ---
  const ai = [
    { label: 'Are you legally authorized to work in the US?', answer: 'Yes', confidence: 'high' },
    { label: 'Highest level of education', answer: 'Bachelor', confidence: 'low' },
    { label: 'Desired salary', answer: '', confidence: 'high' },
    { label: 'Willing to relocate?', answer: '  Yes  ', confidence: 'high' },
  ];
  t.eq(w.pjaSelectAiAnswer('are you legally authorized to work in the us?', ai), 'Yes', 'AI: normalized label match');
  t.eq(w.pjaSelectAiAnswer('Are You Legally Authorized To Work In The US?', ai), 'Yes', 'AI: case-insensitive match');
  t.eq(w.pjaSelectAiAnswer('Highest level of education', ai), 'Bachelor', 'AI: education is policy -> applied even at low confidence');
  // policy/consent/factual questions bypass confidence gating (pref-driven, always applied)
  const aiPolicy = [
    { label: 'I certify that the information provided is correct', answer: 'I agree', confidence: 'low' },
    { label: 'Are you legally authorized to work in the country?', answer: 'Yes', confidence: 'low' },
    { label: 'GDPR data processing consent', answer: 'I agree', confidence: 'low' },
    { label: 'Describe your hardest debugging challenge', answer: 'Once I…', confidence: 'low' },
  ];
  t.eq(w.pjaSelectAiAnswer('I certify that the information provided is correct', aiPolicy), 'I agree', 'AI: low-conf CERTIFICATION still applied (policy)');
  t.eq(w.pjaSelectAiAnswer('Are you legally authorized to work in the country?', aiPolicy), 'Yes', 'AI: low-conf WORK-AUTH still applied (policy)');
  t.eq(w.pjaSelectAiAnswer('GDPR data processing consent', aiPolicy), 'I agree', 'AI: low-conf GDPR consent still applied (policy)');
  t.eq(w.pjaSelectAiAnswer('Describe your hardest debugging challenge', aiPolicy), null, 'AI: low-conf EXPERIENTIAL still gated -> null');
  t.eq(w.pjaSelectAiAnswer('Desired salary', ai), null, 'AI: empty answer -> null');
  t.eq(w.pjaSelectAiAnswer('Not asked', ai), null, 'AI: no matching answer -> null');
  t.eq(w.pjaSelectAiAnswer('Willing to relocate?', ai), 'Yes', 'AI: trims whitespace');
  t.eq(w.pjaSelectAiAnswer('x', []), null, 'AI: empty answer set -> null');
  // education/diploma is policy (factual from her degree) — applied even at low confidence
  t.eq(w.pjaSelectAiAnswer('Do you have at least a high school diploma or GED?',
    [{ label: 'Do you have at least a high school diploma or GED?', answer: 'Yes', confidence: 'low' }]),
    'Yes', 'AI: low-conf DIPLOMA still applied (policy)');

  // --- pjaDeterministicAnswer: reliable common-policy answers (no AI dependency) ---
  t.eq(w.pjaDeterministicAnswer('Were you referred by a Penumbra Employee?'), 'No', 'det: referred -> No');
  t.eq(w.pjaDeterministicAnswer('Do you now or will you ever require sponsorship?'), 'No', 'det: sponsorship -> No');
  t.eq(w.pjaDeterministicAnswer('Are you legally authorized to work in the US?'), 'Yes', 'det: work-auth -> Yes');
  t.eq(w.pjaDeterministicAnswer('Are you now or have you ever been a Penumbra employee?'), 'No', 'det: employed-here -> No');
  t.eq(w.pjaDeterministicAnswer('Do you now or have you ever worked for Pricewaterhouse Cooper (PwC)?'), 'No', 'det: PwC -> No');
  t.eq(w.pjaDeterministicAnswer('Are you at least 18 years of age?'), 'Yes', 'det: 18+ -> Yes');
  t.eq(w.pjaDeterministicAnswer('How did you hear about us?'), 'LinkedIn', 'det: how-did-you-hear -> LinkedIn');
  t.eq(w.pjaDeterministicAnswer('What is the highest level of education you have completed?'), null, 'det: education -> null (AI handles)');
  t.eq(w.pjaDeterministicAnswer('Describe your experience with SPC'), null, 'det: open-ended "describe" -> null');

  // --- acknowledgment / certification statements -> honest Yes (reading/agreeing is part of applying) ---
  t.eq(w.pjaDeterministicAnswer('I have read and understand the Export Control statement included in the job description above.'), 'Yes', 'det: export-control ack -> Yes');
  t.eq(w.pjaDeterministicAnswer('I acknowledge that I have read the privacy notice.'), 'Yes', 'det: acknowledge -> Yes');
  t.eq(w.pjaDeterministicAnswer('I certify that the information provided is accurate.'), 'Yes', 'det: certify -> Yes');
  t.eq(w.pjaDeterministicAnswer('Please describe how many years of experience you have.'), null, 'det: open-ended not mis-caught as ack -> null');

  // --- experience screening: honest Yes for her domains, No for documented gaps, null otherwise ---
  t.eq(w.pjaDeterministicAnswer('Do you have hands-on experience with cleanroom environments?'), 'Yes', 'det: cleanroom experience -> Yes (her domain)');
  t.eq(w.pjaDeterministicAnswer('Do you have experience with wafer inspection and metrology?'), 'Yes', 'det: wafer/metrology -> Yes');
  t.eq(w.pjaDeterministicAnswer('Are you familiar with SPC and root cause analysis?'), 'Yes', 'det: SPC -> Yes');
  t.eq(w.pjaDeterministicAnswer('Do you have experience with FMEA?'), 'No', 'det: FMEA (gap) -> No');
  t.eq(w.pjaDeterministicAnswer('Are you proficient in Python?'), 'No', 'det: Python (gap) -> No');
  t.eq(w.pjaDeterministicAnswer('Do you have experience with ISO 13485?'), 'No', 'det: ISO13485 (gap) -> No');
  t.eq(w.pjaDeterministicAnswer('How many years of experience do you have with quality engineering?'), null, 'det: "how many years" stays numeric -> null (not Yes)');
  t.eq(w.pjaDeterministicAnswer('Do you have experience with injection molding?'), null, 'det: unknown domain -> null (AI decides, no fabrication)');

  // --- pjaIsGarbageLabel: never send junk labels to the AI ---
  t.eq(w.pjaIsGarbageLabel('yes'), true, 'garbage: "yes"');
  t.eq(w.pjaIsGarbageLabel('No'), true, 'garbage: "No"');
  t.eq(w.pjaIsGarbageLabel('Select...'), true, 'garbage: "Select..."');
  t.eq(w.pjaIsGarbageLabel('--'), true, 'garbage: punctuation only');
  t.eq(w.pjaIsGarbageLabel('Are you legally authorized to work?'), false, 'real question kept');
  t.eq(w.pjaIsGarbageLabel('Highest level of education'), false, 'real label kept');

  // --- pjaCoerceToOption: AI prose → fixed option (the Antora single-select skip) ---
  const co = w.pjaCoerceToOption;
  t.ok(typeof co === 'function', 'coerce: exported');
  t.eq(co('No. My background is in quality/metrology, not process ownership.', ['Yes', 'No']), 'No',
    'coerce: verbose "No. ..." → No');
  t.eq(co('Yes', ['Yes', 'No']), 'Yes', 'coerce: exact Yes');
  t.eq(co('yes, absolutely', ['Yes', 'No']), 'Yes', 'coerce: leading yes token');
  t.eq(co('I decline to self-identify', ['Hispanic or Latino', 'Not Hispanic or Latino', 'I decline to self-identify']),
    'I decline to self-identify', 'coerce: exact multiword option');
  t.eq(co("Master's degree", ["Bachelor's degree", "Master's degree", 'Doctorate']), "Master's degree",
    'coerce: option phrase inside answer');
  t.eq(co('option label objects', [{ label: 'Yes' }, { label: 'No' }]), null,
    'coerce: no match → null (caller keeps original)');
  t.eq(co('No', [{ label: 'Yes' }, { label: 'No' }]), 'No', 'coerce: works on {label} option objects');
};
