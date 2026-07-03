'use strict';
// Voluntary self-identification / EEO answer policy (pjaSelfIdPick in auto-apply.js).
// Regression: the "Are you Hispanic or Latino? Required" self-ID select had no Yes option,
// so the Yes/No fallbacks skipped it → the Easy Apply step stayed empty → 'stuck' (the
// Metrology Equipment Engineer blocker that capped a 50-apply run at 1). These guard that
// each self-ID question gets an honest, valid answer instead.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function load() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://www.linkedin.com/jobs/view/1/', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: p => p } };
  w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8'));
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/auto-apply.js'), 'utf8'));
  return w;
}

const opt = (...texts) => texts.map(tx => ({ text: tx, value: tx }));

module.exports = (t) => {
  const w = load();
  const pick = w.__pjaSelfIdPick;
  t.ok(typeof pick === 'function', 'self-id: pjaSelfIdPick is exported');
  const txt = r => (r ? String(r.text) : null);

  // Hispanic/Latino select with explicit "Not Hispanic" → honest No, never "Yes"/Hispanic
  t.eq(txt(pick('Are you Hispanic or Latino?', opt('Hispanic or Latino', 'Not Hispanic or Latino', 'Decline to self-identify'))),
    'Not Hispanic or Latino', 'self-id: Hispanic select → Not Hispanic');

  // Hispanic/Latino Yes/No radios → No (NOT the old Yes last-resort)
  t.eq(txt(pick('Are you Hispanic or Latino?', opt('Yes', 'No'))), 'No', 'self-id: Hispanic Yes/No → No');

  // Race → decline (banked policy)
  t.eq(txt(pick('Please identify your race', opt('American Indian', 'Asian', 'Black or African American', 'White', 'Decline to self-identify'))),
    'Decline to self-identify', 'self-id: race → decline');

  // Race with no decline option → honest factual (Asian)
  t.eq(txt(pick('Race/Ethnicity', opt('American Indian', 'Asian', 'Black', 'White'))), 'Asian', 'self-id: race w/o decline → Asian');

  // Gender → Female (banked)
  t.eq(txt(pick('Gender', opt('Male', 'Female', 'Decline to self-identify'))), 'Female', 'self-id: gender → Female');

  // Veteran → not a protected veteran
  t.eq(txt(pick('Veteran status', opt('I am a protected veteran', 'I am not a protected veteran', 'I decline to self-identify'))),
    'I am not a protected veteran', 'self-id: veteran → not a protected veteran');

  // Disability → No
  t.eq(txt(pick('Disability status', opt('Yes, I have a disability', "No, I do not have a disability", "I don't wish to answer"))),
    'No, I do not have a disability', 'self-id: disability → No');

  // "Prefer not to say" recognised as decline when that's the only safe option
  t.eq(txt(pick('Gender identity', opt('Man', 'Woman', 'Prefer not to say'))), 'Woman', 'self-id: gender identity → Woman');
  t.eq(txt(pick('What is your sexual orientation?', opt('Heterosexual', 'LGBTQ+', 'Prefer not to answer'))),
    'Prefer not to answer', 'self-id: orientation → decline');

  // NON self-ID questions must return null (so normal handling runs)
  t.eq(pick('How many years of experience do you have?', opt('Yes', 'No')), null, 'self-id: years question → null');
  t.eq(pick('Are you legally authorized to work in the US?', opt('Yes', 'No')), null, 'self-id: work-auth → null');
  t.eq(pick('Will you require sponsorship?', opt('Yes', 'No')), null, 'self-id: sponsorship → null');
};
