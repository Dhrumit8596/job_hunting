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

  // the filler queues on window._pjaComboChain with ~700ms timers; wait it out
  await sleep(2600);

  t.eq(c1.clicked(), 'No, I will not require sponsorship', 'combobox: sponsorship=No clicks will-not-require');
  t.eq(c2.clicked(), 'I am authorized to work', 'combobox: workAuth=Yes clicks authorized (not sponsorship)');
  t.eq(c3.clicked(), 'Job board or social media', 'combobox: referralSource=LinkedIn maps to job-board/social');
};
