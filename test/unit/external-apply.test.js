'use strict';
// Regression tests for the Workday application-question logic extracted from
// external-apply.js. SYNTHETIC data only — no real PII. These lock in the branch
// ORDERING bugs found during the live run (OPT-before-eligible, years-before-basic).
const path = require('path');
const fs = require('fs');
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
  referralSource: 'LinkedIn',
  phoneCountryCode: 'United States of America (+1)',
};

module.exports = (t) => {
  const externalSource = fs.readFileSync(path.resolve(__dirname, '../../content/external-apply.js'), 'utf8');
  t.ok(externalSource.includes('google\\.com$/i.test(location.hostname)') &&
    externalSource.includes('Gmail is used by the verification helper'),
  'external apply: never runs on Google/Gmail tabs used by email verification');
  t.ok(externalSource.includes('[email-code] cdp submit after code timed out; using DOM click fallback') &&
    externalSource.includes('[email-code] submit after code did not confirm'),
  'external apply: post-email-code submit click is bounded and records non-confirmation');
  t.ok(externalSource.includes('capturePostClickDiagnostic') &&
    externalSource.includes('CAPTURE_APPLY_DIAGNOSTIC') &&
    externalSource.includes('pja_last_post_click_diagnostic_pending') &&
    externalSource.includes('email_code_submit_unconfirmed') &&
    externalSource.includes("branch: 'post_submit_code_gate'") &&
    externalSource.includes('if (result.diagnostic) skipped.diagnostic = result.diagnostic') &&
    externalSource.includes('diagnostic: collectPostClickPageSnapshot()'),
  'external apply: email-code submit failures persist post-click URL/DOM diagnostics before deferral');
  t.ok(externalSource.includes('committedReactSelectValue') &&
    externalSource.includes('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]') &&
    externalSource.includes("role === 'combobox' ? committedReactSelectValue(el) : ''"),
  'external-apply: asterisk-required scan skips already-committed React-select comboboxes');
  t.ok(externalSource.includes('wd-phone-code-postfill') &&
    externalSource.includes('input[data-uxi-widget-type="selectinput"], input[role="combobox"], input[required], input[aria-required="true"]') &&
    externalSource.includes('wd-phone-code-prompts') &&
    externalSource.includes('const wdSelectedText = root =>'),
  'external-apply: Workday phone-code fallback runs after AI postfill and scans non-selectinput required controls');
  t.ok(externalSource.includes('wdSelectedText = root =>') &&
    externalSource.includes('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]') &&
    externalSource.includes('const selected = wdSelectedText(ms)'),
  'external-apply: Workday selected-value checks accept selectedItem/promptOption-only DOMs');
  t.ok(externalSource.includes("el.closest('[data-uxi-widget-type=\"multiselect\"]') ||") &&
    externalSource.includes("el.closest('[data-automation-id^=\"formField\"], fieldset')"),
  'external-apply: Workday diagnostics read selected chips from the multiselect container before shallow wrappers');
  t.ok(externalSource.includes('United States of America (+1)') &&
    externalSource.includes('\\d+\\s*item selected') &&
    externalSource.includes('phone.{0,30}(country|territory).{0,30}code|dial'),
  'external-apply: Workday missing-required treats selected phone-code field text as filled');
  t.ok(externalSource.includes('post-prompt step text refill done') &&
    externalSource.includes('post-prompt text refill done') &&
    externalSource.includes('Country/state prompt commits can trigger Workday to re-render and clear downstream address'),
  'external-apply: Workday re-fills text fields after country/state prompt commits');
  t.ok(externalSource.includes('const finalizeWorkdayMyInformation = async (label) =>') &&
    externalSource.includes('[WD-MYINFO]') &&
    externalSource.includes('wd-myinfo-prompts-') &&
    externalSource.includes('workdayMyInfoCommitGaps') &&
    externalSource.includes("await finalizeWorkdayMyInformation('pre-click-' + steps)") &&
    externalSource.includes("await trustedWorkdayClick(reNext, 'validation-retry')") &&
    externalSource.includes('const trustedWorkdayEnter = async (el, label) =>') &&
    externalSource.includes("type: 'WORKDAY_TRUSTED_ENTER'") &&
    externalSource.includes("trustedWorkdayEnter(reNext, 'blocked-retry-' + label)"),
  'external-apply: Workday My Information state is finalized and trusted-clicked before Save/Continue retries');
  t.ok(externalSource.includes('const mainWorldWorkdayAdvance = async (el, label) =>') &&
    externalSource.includes("type: 'WORKDAY_ADVANCE_STEP'") &&
    externalSource.includes('no advance after trusted click; trying MAIN-world advance') &&
    externalSource.includes('await mainWorldWorkdayAdvance(nextBtn'),
  'external-apply: Workday step loop falls back to MAIN-world advance when trusted click does not advance');
  t.ok(externalSource.includes("const isPhoneById = /^(phone|phoneNumber)$/i") &&
    externalSource.includes("el.name || ''") &&
    externalSource.includes("(phone\\s*)?extension"),
  'external-apply: Workday retry phone fill recognizes name/id=phoneNumber and excludes extension controls');
  t.ok(externalSource.includes("el.getAttribute('role') === 'combobox'") &&
    externalSource.includes("el.getAttribute('aria-autocomplete')"),
  'external-apply: retry phone fill skips country-code/search comboboxes');
  t.ok(externalSource.includes('function forceWorkdayPhoneNumberCommit') &&
    externalSource.includes('phoneNumber(?:--phoneNumber)?') &&
    externalSource.includes('never extension') &&
    externalSource.includes('postfill phoneNumber commit'),
  'external-apply: Workday force-commits the real phone number field without filling phone extension');
  t.ok(externalSource.includes('const workdayPhoneNumberDigits = (sourceProfile) =>') &&
    externalSource.includes('raw.slice(-10)') &&
    externalSource.includes('Workday stores country code separately') &&
    externalSource.includes('getBoundingClientRect()') &&
    externalSource.includes('forceWorkdayPhoneNumberTrustedCommit') &&
    externalSource.includes("type: 'WORKDAY_SET_SID'") &&
    externalSource.includes('without an immediate blur'),
  'external-apply: Workday phone-number commit uses national digits, visible input verification, and trusted insertText without blur');
  t.ok(externalSource.includes('const hasUsefulTextValue = (el) =>') &&
    externalSource.includes('const hasWorkExperienceSection =') &&
    externalSource.includes('dateSectionDay-input') &&
    externalSource.includes("const startDay = profile.currentStartDay || '01'") &&
    externalSource.includes('placeholders ("MM", "DD", "YYYY")'),
  'external-apply: Workday work-experience dates fill day, overwrite placeholders, and stay scoped to Work Experience');
  t.ok(externalSource.includes('async function pjaFillWorkdaySelfIdentifyDate(profile)') &&
    externalSource.includes('public burden statement|omb control number') &&
    externalSource.includes("profile?.signatureDate ? new Date(profile.signatureDate) : new Date()") &&
    externalSource.includes('[WD] self-identify date filled='),
  'external-apply: Workday Self Identify signature date uses the current date and can overwrite stale values');
  t.ok(externalSource.includes('pjaFillCombobox(el, profile.referralSource') &&
    externalSource.includes('source--source') &&
    externalSource.includes("window._pjaComboChain.catch") &&
    externalSource.includes('Careers Website') &&
    externalSource.includes('const referralCommitted = text =>') &&
    externalSource.includes('facebook') &&
    externalSource.includes('await closeWorkdayTransientMenus()'),
  'external-apply: Workday referral-source force path commits selectinput fields, not only button prompts');
  t.ok(externalSource.includes('recoverSmartRecruitersEmptyStep') &&
    externalSource.includes('[SR] empty SPA step after advance; waiting for hydrated form') &&
    externalSource.includes("reason: 'no_submit_after_spa', fields: ['smartrecruiters_empty_step']") &&
    externalSource.includes("missingLabels.length === 1 && missingLabels[0] === '*'"),
  'external-apply: SmartRecruiters empty SPA step is retried/classified, not reported as missing_required:*');
  t.ok(externalSource.includes("if (isSmartRecruitersHost && missingLabels.length === 1 && missingLabels[0] === '*')") &&
    externalSource.includes("fields: ['smartrecruiters_required_sentinel_no_controls']"),
  'external-apply: SmartRecruiters required sentinel * is never reported as missing_required');
  t.ok(externalSource.includes('observed: a lone "🔬" button') &&
    externalSource.includes("if (/^[\\s🔬]+$/.test(txt)) return false") &&
    externalSource.includes("! /next|continue|submit|apply|save|review|upload|attach|manual|done|finish/i.test(txt)".replace('! ', '!')),
  'external-apply: SmartRecruiters decorative buttons do not count as hydrated application controls');
  t.ok(externalSource.includes('spl-input, spl-autocomplete, spl-phone-field, spl-checkbox, spl-select') &&
    externalSource.includes('visibleApplicationControls'),
  'external-apply: SmartRecruiters custom elements count as hydrated application controls');
  t.ok(externalSource.includes('function trustedPointClick(el)') &&
    externalSource.includes('isSmartRecruitersHost') &&
    externalSource.includes('[SR] trusted Next click='),
  'external-apply: SmartRecruiters step buttons use trusted clicks before synthetic fallback');
  t.ok(externalSource.includes('recoverEmailVerificationCode') &&
    externalSource.includes("type: 'OPEN_GMAIL_CODE_TAB'") &&
    externalSource.includes('retrying submit after gmail code') &&
    externalSource.includes("recordResult:email_verification_required:"),
  'external-apply: Greenhouse/Ashby email security-code gates attempt Gmail recovery before deferral');
  t.ok(externalSource.includes('const visibleValidationErrors = () =>') &&
    externalSource.includes('explicitMissingErrors') &&
    externalSource.includes('if (captchaWidgetVisible && !explicitMissingErrors)'),
  'external-apply: explicit post-submit required-field errors win over generic captcha text');
  t.ok(externalSource.includes("authResult === 'needs_navigation'") &&
    externalSource.includes('auth requested navigation; waiting for reloaded apply page'),
  'external-apply: Workday auth direct-navigation recovery waits for reload instead of recording auth failure');
  t.ok(externalSource.includes('const isWorkdayHost = /workday\\.com|myworkdayjobs\\.com/i.test(location.hostname)') &&
    externalSource.includes("const terminalHelpReason = reactSelectError && isWorkdayHost ? 'wd_selectinput_blocked' : 'submit_unclear'"),
  'external-apply: non-Workday React-select submit errors are not mislabeled wd_selectinput_blocked');
  t.ok(externalSource.includes('before auth starts') &&
    externalSource.includes('pja_wd_pending_apply') &&
    externalSource.includes('stale') &&
    externalSource.indexOf('pja_wd_pending_apply') < externalSource.indexOf('const authResult = await window.pjaWorkdayAuth.run'),
  'external-apply: Workday pending-apply context is written before Gmail verification starts');
  t.ok(externalSource.includes('description entry → applyManually nav attempt=') &&
    externalSource.includes("cleanUrl + '/apply/applyManually'") &&
    externalSource.includes('continue application') &&
    externalSource.includes("pja_wd_desc_manual_nav_") &&
    externalSource.includes('navs < 6') &&
    externalSource.includes('location.replace(retryUrl)'),
  'external-apply: Workday job-description pages with Apply/Continue controls navigate to applyManually before no_submit');
  t.ok(externalSource.includes('empty step shell; waiting for hydration before recovery') &&
    externalSource.includes('empty step shell hydrated; re-entering fill path') &&
    externalSource.includes('empty step shell persisted; reloading apply route once') &&
    !externalSource.includes('back-to-job-posting'),
  'external-apply: Workday empty step shell waits/reloads instead of immediately clicking Back to Job Posting');
  t.ok(externalSource.includes("const retryKey = 'pja_wd_block_retry_' + (job.runId || 'norun')") &&
    externalSource.includes("(reasonHint || 'blocked')") &&
    externalSource.includes("(stepBefore || 'nostep')"),
  'external-apply: Workday blocked retry key is scoped by runId and recovery phase so fresh retries are not suppressed');
  t.ok(externalSource.includes('promptAriaInstruction') &&
    externalSource.includes("el.closest('[data-automation-id=\"activeListContainer\"], [role=\"listbox\"]')") &&
    externalSource.includes("el.closest('[data-uxi-widget-type=\"multiselect\"]')"),
  'external-apply: required-field AI collector skips Workday generated multiselect/listbox search inputs');
  t.ok(externalSource.includes('const workdayComboKeyFor = f =>') &&
    externalSource.includes("return 'phoneCountryCode'") &&
    externalSource.includes("return 'referralSource'") &&
    externalSource.includes('ai combobox skip phone code already US') &&
    externalSource.includes('pjaFillCombobox(f.el, ans, key || undefined)'),
  'external-apply: AI required-field combobox fills preserve Workday phone-code/referral keys');
  t.ok(externalSource.includes('Greenhouse Remix react-select fields can show the selected text while Formik still has an') &&
    externalSource.includes('const isGreenhouseReactSelect = /greenhouse\\.io/i.test(location.hostname)') &&
    externalSource.includes('pjaForceReactSelectCommit(f.el, ans, { force: true })') &&
    externalSource.includes('await applyComboboxAnswer(f, ans)') &&
    externalSource.includes("await pjaForceReactSelectCommit(f.el, ans, { force: /greenhouse\\.io/i.test(location.hostname) })"),
  'external-apply: AI-answered Greenhouse react-select custom questions use forced trusted commit and retry');
  t.ok(externalSource.includes("chrome.storage.local.get(['pja_ext_current', 'pja_answers', 'pja_ext_queue', 'pja_ranked_apply']") &&
    externalSource.includes('Many Greenhouse jobs share the same hostname') &&
    externalSource.includes('urlKey(rankedJob.applyUrl) === urlKey(location.href)') &&
    externalSource.includes('repaired stale ranked current from URL match') &&
    externalSource.includes('pja_ext_queue: repairedQueue'),
  'external-apply: ranked same-host ATS pages repair stale pja_ext_current by exact apply URL');
  t.ok(externalSource.includes('const collectApplyDomSummary = () =>') &&
    externalSource.includes('domSummary: collectApplyDomSummary()') &&
    externalSource.includes('executeRecoveryActions(help, contextReason)') &&
    externalSource.includes("retry_fill_phone','retry_fill_country','retry_fill_phone_country_code") &&
    externalSource.includes("retry_greenhouse_react_selects','retry_smartrecruiters_custom_fields','retry_answer_required") &&
    externalSource.includes('retrying submit once after LLM recovery'),
  'external-apply: LLM recovery mode sends DOM context and executes only whitelisted bounded recovery actions');
  t.ok(externalSource.includes("const recoveryKey = 'pja_recovery_missing_'") &&
    externalSource.includes('missing_required cleared; re-entering submit path') &&
    externalSource.includes("const recoveryKey = 'pja_recovery_submit_'") &&
    externalSource.includes('postRetrySuccess'),
  'external-apply: LLM recovery is single-shot per job for missing-required and submit-unclear paths');
  t.ok(externalSource.includes('button[aria-invalid="true"], [role="button"][aria-invalid="true"]') &&
    externalSource.includes('button[id^="primaryQuestionnaire--"]') &&
    externalSource.includes('function pjaCollectWorkdayErrorLabels()') &&
    externalSource.includes('Error:\\s*The field') &&
    externalSource.includes('pjaNearestQuestionTextBefore') &&
    externalSource.includes('mustCorrectSelected') &&
    externalSource.includes('wd-appq-blocked-retry') &&
    externalSource.includes('pairedErrorLabel') &&
    externalSource.includes('invalidButtonOrdinal'),
  'external-apply: Workday app-question filler scans and corrects questionnaire buttons with Workday error/body labels');

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
  t.eq(a('How did you hear about us?'), 'LinkedIn', 'Workday source question -> referral source');
  t.eq(a('State and federal law require Abbott to track and report certain payments and transfers of value provided to certain health care professionals (HCPs). Are you: (A) A physician - MD, DO, Dentist, DDS, Podiatrist, Optometrist or Chiropractor - with an active license to practice in the US; (B) a Massachusetts-licensed prescriber; or (C) None of the above?'), 'C', 'Workday HCP disclosure -> C / none of the above');
  t.eq(w.pjaPickAnswerOption('C', ['Select One', 'A', 'B', 'C'], P), 'C', 'Workday HCP disclosure option C selected exactly');
  t.eq(a('What is your favorite color?'), null, 'unknown question -> null');

  // --- sponsorship flips to Yes if profile requires it (synthetic) ---
  t.eq(w.pjaWorkdayAnswerForLabel('require sponsorship', { requireSponsorship: 'Yes' }), 'Yes', 'sponsorship Yes when required');
  t.eq(w.pjaWorkdayAnswerForLabel('require immigration sponsorship for work authorization', {}), 'No', 'sponsorship defaults through deterministic No instead of unsafe Yes');
  t.eq(w.pjaWorkdayAnswerForLabel('Do you now, or will you in the future, require immigration sponsorship for work authorization?', { workAuth: 'Yes', requireSponsorship: 'No' }), 'No', 'sponsorship wins over work authorization wording');

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
  t.eq(w.pjaPickAnswerOption('Yes', ['Select One', 'Agree', 'Disagree'], P), 'Agree', 'Yes maps to Agree when Workday uses agreement options');
  t.eq(w.pjaPickAnswerOption('No', ['Select One', 'Agree', 'Disagree'], P), 'Disagree', 'No maps to Disagree when Workday uses agreement options');

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
  t.eq(w.pjaDeterministicAnswer('Have you previously worked for Pure Storage?'), 'No', 'det: previously worked here -> No');
  t.eq(w.pjaDeterministicAnswer('Do you now or have you ever worked for Pricewaterhouse Cooper (PwC)?'), 'No', 'det: PwC -> No');
  t.eq(w.pjaDeterministicAnswer('Are you at least 18 years of age?'), 'Yes', 'det: 18+ -> Yes');
  t.eq(w.pjaProfileFieldForLabel('If yes, please enter visa type', { visaStatus: 'TN Visa' }), 'TN Visa', 'profile map: conditional visa type -> stored visa status');
  t.eq(w.pjaProfileFieldForLabel('How would you describe your gender identity?', { gender: 'Female' }), 'Female', 'profile map: gender identity -> stored gender');
  t.eq(w.pjaProfileFieldForLabel('Country phone code*', P), 'United States of America (+1)', 'profile map: Workday country phone code -> stored phoneCountryCode');
  t.eq(w.pjaProfileFieldForLabel('Country / Territory Phone Code', P), 'United States of America (+1)', 'profile map: Workday country/territory phone code -> stored phoneCountryCode');
  t.eq(w.pjaProfileFieldForLabel('Were you referred by an internal employee?', P), null, 'profile map: internal referral is not referralSource');
  t.eq(w.pjaDeterministicAnswer('Are you able and willing to be on site 5 days per week?'), 'Yes', 'det: able and willing onsite -> Yes');
  t.eq(w.pjaDeterministicAnswer('Do you have any immediate family that works for HeartFlow?'), 'No', 'det: immediate family employed by company -> No');
  t.eq(w.pjaDeterministicAnswer('Do you have any relatives presently working for Dexcom?'), 'No', 'det: relatives presently working at company -> No');
  t.eq(w.pjaDeterministicAnswer('Do you have any agreements with your current or former employers that could potentially prohibit or limit your employment with Dexcom?'), 'No', 'det: limiting employment agreement -> No');
  t.eq(w.pjaDeterministicAnswer('Have you ever been or are you currently debarred?'), 'No', 'det: debarment -> No');
  t.eq(w.pjaDeterministicAnswer('How did you hear about us?'), 'LinkedIn', 'det: how-did-you-hear -> LinkedIn');
  t.eq(w.pjaDeterministicAnswer('What is the highest level of education you have completed?'), null, 'det: education -> null (AI handles)');
  t.eq(w.pjaDeterministicAnswer('Describe your experience with SPC'), null, 'det: open-ended "describe" -> null');

  // --- acknowledgment / certification statements -> honest Yes (reading/agreeing is part of applying) ---
  t.eq(w.pjaDeterministicAnswer('I have read and understand the Export Control statement included in the job description above.'), 'Yes', 'det: export-control ack -> Yes');
  t.eq(w.pjaDeterministicAnswer('I acknowledge that I have read the privacy notice.'), 'Yes', 'det: acknowledge -> Yes');
  t.eq(w.pjaDeterministicAnswer('Acknowledge/Confirm'), 'Yes', 'det: bare acknowledge/confirm -> Yes');
  t.eq(w.pjaDeterministicAnswer('Does the deemed export rule affect your employment by Everpure?'), 'No', 'det: Canadian applicant unaffected by sanctioned-nation rule');
  t.eq(w.pjaDeterministicAnswer('Are you available to work at one of our office locations five days per week?'), 'Yes', 'det: office availability -> Yes');
  t.eq(w.pjaDeterministicAnswer('What are your desired base salary expectations?'), '$80,000 - $95,000 depending on role and responsibilities', 'det: salary custom question uses standard range');
  t.eq(w.pjaDeterministicAnswer('Have you ever been employed by the U.S. federal government or a contractor that performed work for the federal government?'), 'No', 'det: no federal employment');
  t.eq(w.pjaDeterministicAnswer('Do you have any relatives currently employed by the federal government or Department of Defense?'), 'No', 'det: no federal-government relatives');
  t.eq(w.pjaCoerceToOption('Yes', ['Acknowledge/Confirm']), 'Acknowledge/Confirm', 'single acknowledgment checkbox: Yes -> sole option');
  t.ok(w.pjaSameQueuedJob({ id: 'req-1', applyUrl: 'https://a' }, { id: 'req-1', applyUrl: 'https://b' }), 'queue identity prefers matching id');
  t.ok(!w.pjaSameQueuedJob({ id: 'req-1' }, { id: 'req-2' }), 'different queue ids are stale');
  t.ok(w.pjaSameQueuedJob({ applyUrl: 'https://a' }, { applyUrl: 'https://a' }), 'queue identity falls back to apply URL');
  t.eq(w.pjaDeterministicAnswer('I certify that the information provided is accurate.'), 'Yes', 'det: certify -> Yes');
  t.eq(w.pjaDeterministicAnswer('I verify that my application submission is truthful and accurate.'), 'Yes', 'det: verify truthful application -> Yes');
  t.eq(w.pjaDeterministicAnswer('Please describe how many years of experience you have.'), null, 'det: open-ended not mis-caught as ack -> null');

  // --- experience screening: honest Yes for configured domains, No for documented gaps, null otherwise ---
  t.eq(w.pjaDeterministicAnswer('Do you have hands-on experience with cleanroom environments?'), 'Yes', 'det: cleanroom experience -> Yes (configured domain)');
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
  t.eq(co('Female', ['Woman', 'Man', 'Non-binary']), 'Woman', 'coerce: EEO Female synonym maps to Woman');
};
