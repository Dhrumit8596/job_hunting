'use strict';
// Synthetic regression coverage for the MAIN-world Workday auth form bridge.
// No network access or real account data is used.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadContentScript } = require('./load.js');

const ROOT = path.resolve(__dirname, '../..');

function extractSubmitFunction() {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const handlerAt = source.indexOf("if (msg.type === 'WORKDAY_SUBMIT_FORM')");
  if (handlerAt < 0) throw new Error('WORKDAY_SUBMIT_FORM handler not found');
  const marker = 'func: (email, password, formType) => {';
  const markerAt = source.indexOf(marker, handlerAt);
  if (markerAt < 0) throw new Error('Workday submit function not found');
  const arrowAt = markerAt + 'func: '.length;
  const openAt = source.indexOf('{', arrowAt);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openAt; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(arrowAt, i + 1);
  }
  throw new Error('unterminated Workday submit function');
}

async function runSynthetic(html, formType) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const fn = dom.window.eval('(' + extractSubmitFunction() + ')');
  const button = dom.window.document.querySelector('button');
  let clicks = 0;
  if (button) button.addEventListener('click', () => clicks++);
  const result = await fn('candidate@example.test', 'Synthetic#Password1', formType);
  return { dom, result, clicks };
}

function loadWorkdayAuthDom(html, url = 'https://example.wd1.myworkdayjobs.com/en-US/Example/job/Foo') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const win = dom.window;
  win.chrome = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, getURL: p => p, id: 'test' },
  };
  win.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  win.eval(fs.readFileSync(path.join(ROOT, 'content/workday-auth.js'), 'utf8'));
  return win;
}

module.exports = async (t) => {
  const workdayAuthSource = fs.readFileSync(path.join(ROOT, 'content/workday-auth.js'), 'utf8');
  t.ok(workdayAuthSource.includes('async function trustedWorkdayClick(el, label)') &&
    workdayAuthSource.includes("return 'needs_navigation'") &&
    workdayAuthSource.includes('job_apply_start: direct nav fallback attempt') &&
    workdayAuthSource.includes('directCount < 3') &&
    workdayAuthSource.includes('/apply/applyManually'),
  'workday auth: job Apply/start-application uses trusted click plus direct applyManually navigation fallback');

  const authWindow = loadContentScript(path.join(ROOT, 'content/workday-auth.js'));
  t.eq(authWindow.pjaWorkdayAuth.pjaWorkdayTenantEmail('candidate@gmail.com', 'kla.wd1.myworkdayjobs.com'),
    'candidate+wd-kla@gmail.com',
    'workday auth: Gmail address gets tenant-specific plus alias');
  t.eq(authWindow.pjaWorkdayAuth.pjaWorkdayTenantEmail('candidate+old@gmail.com', 'formfactor.wd1.myworkdayjobs.com'),
    'candidate+wd-formfactor@gmail.com',
    'workday auth: existing Gmail plus alias is normalized to the current tenant');
  t.eq(authWindow.pjaWorkdayAuth.pjaWorkdayTenantEmail('candidate@example.test', 'kla.wd1.myworkdayjobs.com'),
    'candidate@example.test',
    'workday auth: non-Gmail address is preserved');

  const passwordOnly = await runSynthetic(`
    <input type="password" data-automation-id="password">
    <button type="submit" data-automation-id="signInSubmitButton">Sign In</button>
  `, 'signin');
  t.eq(passwordOnly.result.ok, true,
    'workday auth: password-only second step is a valid sign-in form');
  t.eq(passwordOnly.result.via, 'btn',
    'workday auth: password-only second step clicks the sign-in button');
  t.ok(passwordOnly.result.pwLen > 0,
    'workday auth: password-only second step fills the password');
  t.eq(passwordOnly.clicks, 1,
    'workday auth: password-only second step submits exactly once');

  const createWithoutEmail = await runSynthetic(`
    <input type="password"><input type="password">
    <button type="submit" data-automation-id="createAccountSubmitButton">Create Account</button>
  `, 'createaccount');
  t.eq(createWithoutEmail.result,
    { ok: false, reason: 'no_email_field' },
    'workday auth: account creation still requires an email field');
  t.eq(createWithoutEmail.clicks, 0,
    'workday auth: invalid account-creation form is not submitted');

  const signedInPosting = loadWorkdayAuthDom(`
    <body>
      <button data-automation-id="utilityMenuButton">candidate@example.test</button>
      <button data-automation-id="navigationItem-Candidate Home">Candidate Home</button>
      <a data-automation-id="adventureButton">Apply</a>
      <main>Senior Quality Engineer page is loaded</main>
    </body>
  `);
  t.eq(signedInPosting.pjaWorkdayAuth._detectScreen(), 'job_apply_start',
    'workday auth: signed-in job posting with Apply button is classified as job_apply_start, not logged_in_home');
};
