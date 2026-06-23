'use strict';
// Locks in the work-authorization / sponsorship answer correctness in autofill.js.
// BUG 1: sponsorship is semantically inverted vs work-auth — a 'No requires sponsorship'
// profile must never select an "I will require sponsorship" option, and a work-auth 'Yes'
// must never leak into a sponsorship option. BUG 2: SELECTs are filled React-aware (value set
// + change fired). BUG 3: radios dispatch input BEFORE change. SYNTHETIC data only.
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

function makeSelect(w, opts) {
  const s = w.document.createElement('select');
  for (const o of opts) {
    const e = w.document.createElement('option');
    e.textContent = o.t; e.value = o.v != null ? o.v : o.t;
    s.appendChild(e);
  }
  w.document.body.appendChild(s);
  return s;
}
const chosen = s => s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : '(none)';

module.exports = (t) => {
  const w = load();

  // ---- BUG 1: sponsorship = No (TN profile) ----
  let s = makeSelect(w, [{ t: 'Select', v: '' }, { t: 'Yes, I will require sponsorship' }, { t: 'No, I will not require sponsorship' }]);
  w.pjaFillSelect(s, 'No', 'requireSponsorship');
  t.eq(chosen(s), 'No, I will not require sponsorship', 'BUG1: sponsorship=No picks the will-NOT-require option');

  s = makeSelect(w, [{ t: 'Select', v: '' }, { t: 'I require sponsorship' }, { t: 'I do not require sponsorship' }]);
  w.pjaFillSelect(s, 'No', 'requireSponsorship');
  t.eq(chosen(s), 'I do not require sponsorship', 'BUG1: sponsorship=No picks do-not-require (no yes/no prefix)');

  // ---- BUG 1 regression: work-auth Yes must NOT pick a sponsorship option ----
  s = makeSelect(w, [{ t: 'Select', v: '' }, { t: 'I am authorized to work' }, { t: 'I will require sponsorship' }]);
  w.pjaFillSelect(s, 'Yes', 'workAuth');
  t.eq(chosen(s), 'I am authorized to work', 'BUG1: workAuth=Yes selects authorized, never the sponsorship option');

  // work-auth No -> not authorized
  s = makeSelect(w, [{ t: 'Select', v: '' }, { t: 'I am authorized to work' }, { t: 'I am not authorized to work' }]);
  w.pjaFillSelect(s, 'No', 'workAuth');
  t.eq(chosen(s), 'I am not authorized to work', 'workAuth=No picks not-authorized');

  // ---- BUG 2: SELECT filled React-aware (value set + change fired) ----
  let changed = false;
  s = makeSelect(w, [{ t: 'Select', v: '' }, { t: 'Yes' }, { t: 'No' }]);
  s.addEventListener('change', () => { changed = true; });
  const ret = w.pjaFillSelect(s, 'Yes', 'workAuth');
  t.eq(ret, true, 'BUG2: pjaFillSelect returns true on match');
  t.eq(s.value, 'Yes', 'BUG2: select value actually set');
  t.ok(changed, 'BUG2: change event dispatched (React-aware)');

  // ---- BUG 3: radio dispatches input BEFORE change ----
  const radio = w.document.createElement('input');
  radio.type = 'radio'; w.document.body.appendChild(radio);
  const order = [];
  radio.addEventListener('input', () => order.push('input'));
  radio.addEventListener('change', () => order.push('change'));
  w.pjaClickRadio(radio);
  t.eq(radio.checked, true, 'BUG3: radio ends up checked');
  t.eq(order[0], 'input', 'BUG3: input event fires first');
  t.ok(order.indexOf('input') < order.indexOf('change'), 'BUG3: input precedes change (React state updates)');
};
