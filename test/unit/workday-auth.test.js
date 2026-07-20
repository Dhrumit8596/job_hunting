'use strict';
// Synthetic regression coverage for the MAIN-world Workday auth form bridge.
// No network access or real account data is used.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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

module.exports = async (t) => {
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
};
