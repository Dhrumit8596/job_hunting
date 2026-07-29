'use strict';
// Verifies pjaFillCombobox (autofill.js) actually SELECTS the right option in an ARIA
// combobox + listbox widget (Greenhouse/react-select style) instead of skipping it.
// Async: the filler is timer-driven (window._pjaComboChain), so this test awaits.
// SYNTHETIC data only.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function load() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>',
    { url: 'https://boards.greenhouse.io/acme/jobs/1', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: p => p } };
  w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8'));
  return w;
}

// Build an OPEN react-select-style combobox: input[role=combobox][id] + a listbox with id
// react-select-{id}-listbox containing [role=option]s. doSelect() finds it via that id and
// clicks the match. Returns { input, clicked: () => textOfClickedOption }.
function makeCombobox(w, id, optionTexts) {
  const input = w.document.createElement('input');
  input.type = 'text'; input.id = id; input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  w.document.body.appendChild(input);
  const listbox = w.document.createElement('div');
  listbox.id = `react-select-${id}-listbox`;
  listbox.setAttribute('role', 'listbox');
  let clicked = null;
  for (const txt of optionTexts) {
    const o = w.document.createElement('div');
    o.setAttribute('role', 'option');
    o.textContent = txt;
    o.addEventListener('click', () => { clicked = txt; });
    listbox.appendChild(o);
  }
  w.document.body.appendChild(listbox);
  return { input, clicked: () => clicked };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (t) => {
  const w = load();
  t.ok(typeof w.pjaFillCombobox === 'function', 'combobox: pjaFillCombobox exported');
  const autofillSource = fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8');
  const fiberSource = fs.readFileSync(path.resolve(ROOT, 'content/fiber-main.js'), 'utf8');
  t.ok(autofillSource.includes("eduKind === 'school'") &&
    autofillSource.includes("pjaForceReactSelectCommit(inp, 'Other'") &&
    autofillSource.includes('school fallback committed Other'),
  'combobox: Greenhouse required school fields fall back to Other when profile university is absent from options');
  t.ok(fiberSource.includes('Single-option acknowledgements') &&
    fiberSource.includes('if (opts.length === 1) return opts[0]'),
  'combobox: fiber react-select bridge maps I-agree answers to one-option acknowledgements');
  t.ok(autofillSource.includes("pjaQueryAll('spl-select[required], spl-select.ng-invalid, spl-select')") &&
    autofillSource.includes("country/region'") &&
    autofillSource.includes("root.querySelectorAll('spl-select-option, [role=\"option\""),
  'combobox: SmartRecruiters fills country/region spl-selects and scans shadow spl-select-option city choices');
  t.ok(autofillSource.includes("host.setAttribute('value', selectedText)") &&
    autofillSource.includes("new CustomEvent('selectionChange'") &&
    autofillSource.includes("detail: { value: selectedText, label: selectedText }"),
  'combobox: SmartRecruiters spl-select falls back to host value/selectionChange after trusted click');
  t.ok(autofillSource.includes('spl-checkbox[required], spl-checkbox[aria-required="true"], spl-checkbox.ng-invalid') &&
    autofillSource.includes('privacy spl-checkbox checked') &&
    autofillSource.includes('detail: { checked: true, value: true }'),
  'combobox: SmartRecruiters required privacy spl-checkbox consent is checked');
  t.ok(autofillSource.includes('spl-input[required], spl-input[aria-required="true"], spl-input.ng-invalid, spl-phone-field[required]') &&
    autofillSource.includes('setSplTextHost') &&
    autofillSource.includes('country/region-autocomplete'),
  'combobox: SmartRecruiters custom spl-input, spl-phone-field, and country autocomplete fields are filled');
  t.ok(autofillSource.includes('if yes[\\s\\S]{0,30}(visa|status)') &&
    autofillSource.includes('ans = profile.visaStatus || null'),
  'combobox: Greenhouse policy react-select sweep commits conditional visa type/status fields');
  t.ok(autofillSource.includes('const visaLead = lv.match') &&
    autofillSource.includes("visaLead[1].replace(/-/g, '-?')"),
  'combobox: Greenhouse visa react-select matches short options like TN for TN Visa');
  t.ok(autofillSource.includes('phoneCountryCode already committed US; skip reopen') &&
    autofillSource.includes("const shouldPressEnter = key === 'referralSource' && !clicked") &&
    autofillSource.includes('observed: referral "Social Media"'),
  'combobox: Workday phone-code does not press Enter after scheduling the exact US option click');
  t.ok(autofillSource.includes("const filterValue = key === 'phoneCountryCode' ? 'United States'") &&
    autofillSource.includes("if (key === 'phoneCountryCode' || key === 'referralSource') return workdaySelectionCommitted()"),
  'combobox: Workday phone-code requires verified United States +1 commit, not just a scheduled click');
  t.ok(autofillSource.includes('phoneCountryCode selected chip US; skip reopen') &&
    autofillSource.includes('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]'),
  'combobox: Workday phone-code is not reopened once the selected chip shows United States +1');
  t.ok(autofillSource.includes("closest('[data-automation-id^=\"formField-\"]')") &&
    autofillSource.includes('country\\s*\\/\\s*territory phone code') &&
    autofillSource.includes('pjaFillForm skip phone code selected chip already US') &&
    autofillSource.includes("if (isPhoneCodeField) wdForcedKey = 'phoneCountryCode'") &&
    autofillSource.includes('const key = wdForcedKey || pjaClassify(rawLabel)'),
  'combobox: Workday formField labels preserve phone-code identity and pjaFillForm force-routes phone-code fields');
  t.ok(autofillSource.includes('Do not also handle it through prompt buttons') &&
    autofillSource.includes('can commit the first row (Albania)'),
  'combobox: Workday prompt-button fallback does not reopen phone-code and commit first-row Albania');
  t.ok(autofillSource.includes('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]'),
  'combobox: Workday phone-code committed detection accepts selectedItem/promptOption-only DOMs');
  t.ok(autofillSource.includes("selectedList?.matches?.('[data-automation-id=\"selectedItem\"") &&
    autofillSource.includes("key: 'Backspace', code: 'Backspace'"),
  'combobox: Workday phone-code clears selectedItem-only wrong country-code chips before retrying');
  t.ok(autofillSource.includes('[role="option"], [data-automation-id="promptOption"], [data-automation-id="selectedItem"]'),
  'combobox: Workday prompt option discovery includes promptOption/selectedItem nodes without ARIA roles');
  t.ok(autofillSource.includes("list.querySelectorAll('[role=\"option\"], [data-automation-id=\"promptOption\"]')"),
  'combobox: Workday prompt-button filler scans promptOption rows without ARIA role');
  t.ok(autofillSource.includes('country: 1, state: 2') &&
    autofillSource.includes('country must precede state') &&
    autofillSource.includes('[WD] prompt no commit key='),
  'combobox: Workday prompt-button filler commits country before state and verifies selected button text');
  t.ok(autofillSource.includes('hcpCompliance') &&
    autofillSource.includes('payments and transfers of value') &&
    autofillSource.includes("t === 'c'") &&
    autofillSource.indexOf('hcpCompliance') < autofillSource.indexOf('} else if (/^degree'),
  'combobox: Workday HCP legal disclosure is answered as C before generic state prompts');
  t.ok(autofillSource.includes('selectedWithoutLabel') &&
    autofillSource.includes('State California Required') &&
    autofillSource.includes('reopen already-committed prompt buttons'),
  'combobox: Workday prompt-button filler does not treat Required alone as an unresolved value');
  t.ok(autofillSource.includes('selectedCountryOk') &&
    autofillSource.includes('selectedStateOk') &&
    autofillSource.includes('selectedFullLower') &&
    autofillSource.includes('prompt stale phone-code list cleared key=') &&
    autofillSource.includes('dial-code rows'),
  'combobox: Workday prompt-button filler corrects wrong country/state values and ignores stale phone-code flyouts');
  t.ok(autofillSource.includes("key === 'phoneCountryCode' || key === 'referralSource'") &&
    autofillSource.includes('selected chip before resolving'),
  'combobox: Workday referral-source requires a committed selected chip, not just a scheduled click');
  t.ok(autofillSource.includes("key === 'referralSource' && !clicked") &&
    autofillSource.includes('highlighted parent row'),
  'combobox: Workday referral-source does not press Enter after scheduling an option click');
  t.ok(autofillSource.includes('Job Board: 104 Job Bank') &&
    autofillSource.includes('company-specific source taxonomies') &&
    autofillSource.includes('! /select one|select\\.\\.\\.|choose|expanded|required only/i.test(selectedText)'.replace('! ', '!')),
  'combobox: Workday referral-source accepts tenant-specific selected chips as committed');
  t.ok(autofillSource.includes("const fieldContainer = input.closest('[data-automation-id^=\"formField\"") &&
    autofillSource.includes('fieldContainer?.querySelector') &&
    autofillSource.includes('fieldContainer?.textContent'),
  'combobox: Workday committed detection falls back to enclosing formField text');
  t.ok(autofillSource.includes("key === 'referralSource' && /workday-fail|synthetic|fail/i") &&
    autofillSource.includes("'+cdp-' + fallback"),
  'combobox: Workday referral-source falls back to CDP option click after trusted click failure');
  t.ok(autofillSource.includes('careers? website') &&
    autofillSource.includes('company website') &&
    autofillSource.includes('career site') &&
    autofillSource.includes('indeed'),
  'combobox: Workday referral-source can select careers/company-site options when LinkedIn is absent');
  t.ok(autofillSource.includes("key === 'country'") &&
    autofillSource.includes("t === 'united states of america' || t === 'united states'") &&
    autofillSource.includes("key !== 'country' && lv.length > 3"),
  'combobox: country selection uses exact United States matching, not substring matching');
  t.ok(autofillSource.includes('phone device type|phone type|phone extension') &&
    autofillSource.includes("(phone\\s*)?extension") &&
    autofillSource.includes('^phoneNumber$') &&
    autofillSource.includes("inp.getAttribute('data-uxi-widget-type') === 'selectinput'") &&
    autofillSource.includes("inp.getAttribute('role') === 'combobox'"),
  'combobox: forced phone-number typing excludes Workday phone-code/type/extension controls');
  t.ok(autofillSource.includes('Even when DOM digits are visible, React/Greenhouse can keep the validated field state empty') &&
    autofillSource.includes("pjaFillTextViaFiber(inp, digits, true)") &&
    autofillSource.includes("new InputEvent('beforeinput'"),
  'combobox: Greenhouse phone force-fill updates React/native state even when digits are visible');

  // sponsorship = No -> selects the will-NOT-require option (not the require one)
  const c1 = makeCombobox(w, 'spons', ['Yes, I will require sponsorship', 'No, I will not require sponsorship']);
  const r1 = w.pjaFillCombobox(c1.input, 'No', 'requireSponsorship');
  t.eq(r1, true, 'combobox: returns true (handled, not skipped)');

  // work-auth = Yes -> selects authorized, never a sponsorship option
  const c2 = makeCombobox(w, 'auth', ['I am authorized to work', 'I will require sponsorship']);
  w.pjaFillCombobox(c2.input, 'Yes', 'workAuth');

  // referralSource LinkedIn -> maps to a job-board/social option
  const c3 = makeCombobox(w, 'ref', ['Indeed', 'Job board or social media', 'Company website']);
  w.pjaFillCombobox(c3.input, 'LinkedIn', 'referralSource');

  // react-select education combobox (Greenhouse School/Degree/Discipline): input wrapped in a
  // .select__control. The fix types into it even though selectCtrl is present (async options).
  // Verify the open+type+select path picks the matching option.
  const rsInput = w.document.createElement('input');
  rsInput.type = 'text'; rsInput.id = 'school--0'; rsInput.setAttribute('role', 'combobox'); rsInput.setAttribute('aria-autocomplete', 'list');
  const ctrl = w.document.createElement('div'); ctrl.className = 'select__control';
  ctrl.appendChild(rsInput); w.document.body.appendChild(ctrl);
  const rsLb = w.document.createElement('div'); rsLb.id = 'react-select-school--0-listbox'; rsLb.setAttribute('role', 'listbox');
  let rsClicked = null;
  ['Stanford University', 'San Jose State University'].forEach(txt => {
    const o = w.document.createElement('div'); o.setAttribute('role', 'option'); o.textContent = txt;
    o.addEventListener('click', () => { rsClicked = txt; }); rsLb.appendChild(o);
  });
  w.document.body.appendChild(rsLb);
  w.pjaFillCombobox(rsInput, 'San Jose State University', 'university');

  // years-of-experience RANGE combobox: value "6" must pick the range containing it ("5-8 years"),
  // not fail (a bare "6" substring-matches none of the ranges).
  const c4 = makeCombobox(w, 'yrs', ['0-3 years', '3-5 years', '5-8 years', '8-12 years', '12+ years']);
  w.pjaFillCombobox(c4.input, '6', 'yearsExperience');

  // PROSE affirmative answer to a binary Yes/No question -> maps to "Yes". The AI answerer replies
  // to "have you directly supported manufacturing operations…?" with a sentence starting "I have
  // supported…"; the bare-token matchers miss it, so it must fall to the sentiment-prose mapping.
  const c5 = makeCombobox(w, 'exp', ['Yes', 'No']);
  w.pjaFillCombobox(c5.input, 'I have supported manufacturing operations and resolved non-conformances', null);

  // PROSE negative answer -> maps to "No" (e.g. referral question answered "I was not referred…").
  const c6 = makeCombobox(w, 'refq', ['Yes', 'No']);
  w.pjaFillCombobox(c6.input, 'No, I was not referred by anyone', null);

  // the filler queues on window._pjaComboChain with ~700ms timers; wait it out
  // (6 comboboxes queued sequentially → allow ~700ms each plus buffer)
  await sleep(6000);

  t.eq(c1.clicked(), 'No, I will not require sponsorship', 'combobox: sponsorship=No clicks will-not-require');
  t.eq(c2.clicked(), 'I am authorized to work', 'combobox: workAuth=Yes clicks authorized (not sponsorship)');
  t.eq(c3.clicked(), 'Job board or social media', 'combobox: referralSource=LinkedIn maps to job-board/social');
  t.eq(rsClicked, 'San Jose State University', 'combobox: react-select education (select__control) selects the matching school');
  t.eq(c4.clicked(), '5-8 years', 'combobox: years=6 picks the containing range (5-8 years)');
  t.eq(c5.clicked(), 'Yes', 'combobox: affirmative PROSE ("I have supported…") maps to Yes on a binary set');
  t.eq(c6.clicked(), 'No', 'combobox: negative PROSE ("No, I was not…") maps to No on a binary set');
};
