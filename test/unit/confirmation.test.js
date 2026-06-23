'use strict';
// Tests pjaIsSubmitSuccess (external-apply.js) — the tightened post-submit detector that
// decides applied vs submit_unclear. Goal: cut false 'unclear' while not false-marking a
// still-on-form page as success. SYNTHETIC data only.
const fs = require('fs');
const path = require('path');
const { makeStubs } = require('./load.js');

function load() {
  const stubs = makeStubs();
  const names = Object.keys(stubs);
  const vals = names.map(n => stubs[n]);
  const src = fs.readFileSync(path.resolve(__dirname, '../../content/external-apply.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(...names, src + '\n;return window;')(...vals);
}

module.exports = (t) => {
  const w = load();
  const ok = w.pjaIsSubmitSuccess;
  t.ok(typeof ok === 'function', 'confirm: pjaIsSubmitSuccess exported');

  // confirmation text variants -> success
  t.eq(ok({ text: 'Thank you for applying! We have received your application.' }), true, 'confirm: thank-you text');
  t.eq(ok({ text: 'Your application has been submitted successfully.' }), true, 'confirm: submitted successfully');
  t.eq(ok({ text: 'We appreciate your interest and will be in touch.' }), true, 'confirm: appreciate your interest');
  t.eq(ok({ title: 'Application Confirmation', text: 'blah' }), true, 'confirm: title token');

  // URL/route tokens -> success (LinkedIn post-apply, Greenhouse confirmation)
  t.eq(ok({ text: 'loading', url: 'https://www.linkedin.com/jobs/search/post-apply/next-best-action/?x=1' }), true, 'confirm: post-apply route');
  t.eq(ok({ text: 'x', url: 'https://boards.greenhouse.io/acme/confirmation' }), true, 'confirm: confirmation route');

  // redirect to a different path with the form GONE -> success
  t.eq(ok({ text: 'home', url: 'https://acme.com/careers/done', preSubmitUrl: 'https://acme.com/careers/apply', hasFormFields: false }), true, 'confirm: redirect away + form gone');

  // SPA replaced the form in place (button + fields gone)
  t.eq(ok({ text: 'x', hasSubmitButton: false, hasFormFields: false, iterations: 5 }), true, 'confirm: form fully replaced');

  // --- must NOT false-positive ---
  // still on the apply form (everything present, no confirmation text)
  t.eq(ok({ text: 'Apply for this job. Resume. Submit application.', url: 'https://acme.com/apply', preSubmitUrl: 'https://acme.com/apply', hasSubmitButton: true, hasFormFields: true, iterations: 5 }), false, 'confirm: still-on-form is NOT success');
  // a same-path re-render where the form is still present
  t.eq(ok({ text: 'Please complete required fields', url: 'https://acme.com/apply#err', preSubmitUrl: 'https://acme.com/apply', hasFormFields: true, iterations: 4 }), false, 'confirm: validation re-render is NOT success');
  // empty/initial state
  t.eq(ok({ text: '', url: 'https://acme.com/apply', preSubmitUrl: 'https://acme.com/apply', iterations: 0 }), false, 'confirm: empty is NOT success');
};
