'use strict';
// Phase D: account planning (plus-address, per-tenant), iframe doc collection, ATS success phrases.
const path = require('path');
require(path.resolve(__dirname, '../../sourcing/detect-ats'));
const { tenantFromUrl, accountEmail, accountPlan, collectFrameDocs, matchesSuccess } =
  require(path.resolve(__dirname, '../../content/apply-account'));

module.exports = (t) => {
  // --- tenant + plus-address ---
  t.eq(tenantFromUrl('https://acme.wd5.myworkdayjobs.com/careers'), 'acme', 'workday tenant = subdomain');
  t.eq(tenantFromUrl('https://boards.greenhouse.io/stripe/jobs/1'), 'stripe', 'greenhouse tenant = slug');
  t.eq(tenantFromUrl('https://careers-acme.icims.com/jobs/1'), 'careers-acme'.replace(/[^a-z0-9]+/g, ''), 'icims tenant from subdomain');
  t.eq(accountEmail('applicant@gmail.com', 'https://acme.wd5.myworkdayjobs.com/x'), 'applicant+acme@gmail.com', 'plus-address per tenant');
  t.eq(accountEmail('foo+old@gmail.com', 'https://boards.greenhouse.io/stripe/jobs/1'), 'foo+stripe@gmail.com', 'strips existing +alias');
  t.eq(accountEmail('', 'https://x.com'), '', 'no base email → empty');

  // --- accountPlan ---
  const noAcct = accountPlan({ needsAccount: false }, { baseEmail: 'a@b.com', hasPassword: true }, 'https://boards.greenhouse.io/x/jobs/1');
  t.eq(noAcct.needsAccount, false, 'greenhouse: no account needed');
  t.eq(noAcct.canProceed, true, 'no-account → proceed');

  const wdOk = accountPlan({ needsAccount: true }, { baseEmail: 'applicant@gmail.com', hasPassword: true }, 'https://acme.wd5.myworkdayjobs.com/x');
  t.eq(wdOk.canProceed, true, 'needs account + has password → proceed');
  t.eq(wdOk.email, 'applicant+acme@gmail.com', 'account uses plus-address');
  t.eq(wdOk.verifyVia, 'gmail', 'verify via gmail');

  const wdNoPw = accountPlan({ needsAccount: true }, { baseEmail: 'a@b.com', hasPassword: false }, 'https://acme.wd5.myworkdayjobs.com/x');
  t.eq(wdNoPw.canProceed, false, 'needs account, no password → cannot proceed');
  t.eq(wdNoPw.blockedReason, 'needs_login', 'no password → defer needs_login (never guess a password)');

  // --- collectFrameDocs (stub document tree; cross-origin frame throws → skipped) ---
  function stubDoc(id, frames) {
    return { _id: id, querySelectorAll: () => frames || [] };
  }
  const innerDoc = stubDoc('inner', []);
  const crossFrame = { get contentDocument() { throw new Error('cross-origin'); } };
  const sameFrame = { contentDocument: innerDoc };
  const rootDoc = stubDoc('root', [sameFrame, crossFrame]);
  const docs = collectFrameDocs(rootDoc, 3);
  t.eq(docs.length, 2, 'collects root + same-origin iframe doc');
  t.eq(docs.map(d => d._id).join(','), 'root,inner', 'root then same-origin child; cross-origin skipped (no throw)');
  t.eq(collectFrameDocs(null).length, 0, 'null root → empty');

  // --- matchesSuccess ---
  t.eq(matchesSuccess('Thank you for applying to Acme!', 'greenhouse'), true, 'generic success phrase');
  t.eq(matchesSuccess('Your application has been received.', ''), true, 'generic received phrase');
  t.eq(matchesSuccess('Submission complete', 'taleo'), true, 'taleo-specific phrase');
  t.eq(matchesSuccess('Please complete all required fields', 'greenhouse'), false, 'error text is not success');
  t.eq(matchesSuccess('congratulations, application submitted', 'icims'), true, 'icims phrase');
};
