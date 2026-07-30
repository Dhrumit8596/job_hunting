'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../..');

function loadEngine(html, url = 'https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Foo') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const win = dom.window;
  win.CSS = win.CSS || { escape: s => String(s).replace(/"/g, '\\"') };
  win.console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  win.eval(fs.readFileSync(path.join(ROOT, 'content/workday-engine.js'), 'utf8'));
  return win;
}

module.exports = (t) => {
  const authChoice = loadEngine(`
    <body>
      <button>Sign in with Google</button>
      <button data-automation-id="signInWithEmail">Sign in with email</button>
    </body>
  `);
  t.eq(authChoice.PJAWorkdayEngine.detectState(authChoice.document), 'email_button_step',
    'workday engine: detects explicit email auth choice before SSO-only');

  const application = loadEngine(`
    <body>
      Current Step 1 of 5 Back to Job Posting
      <div data-automation-id="legalNameSection_firstName"></div>
      <div data-automation-id="formField-phoneNumber">
        <label for="phoneNumber--phoneNumber">Phone Number*</label>
        <input id="phoneNumber--phoneNumber" required value="5551234567">
      </div>
      <div data-automation-id="formField-source">
        <button id="source--source" aria-invalid="true">Select One Required</button>
      </div>
    </body>
  `);
  t.eq(application.PJAWorkdayEngine.detectState(application.document), 'application_form',
    'workday engine: detects active application form');
  const snap = application.PJAWorkdayEngine.snapshot(application.document);
  t.eq(snap.isWorkday, true, 'workday engine: snapshot marks Workday host');
  t.eq(snap.state, 'application_form', 'workday engine: snapshot includes state');
  t.ok(snap.fields.some(f => f.id === 'phoneNumber--phoneNumber' && f.kind === 'text' && f.required),
    'workday engine: field model includes required phone text input');
  t.ok(snap.fields.some(f => f.id === 'source--source' && f.kind === 'buttonPrompt' && f.invalid),
    'workday engine: field model includes invalid button prompt');

  const nonWd = loadEngine('<body><button>Apply</button></body>', 'https://example.com/jobs/1');
  t.eq(nonWd.PJAWorkdayEngine.detectState(nonWd.document), 'not_workday',
    'workday engine: non-Workday host is explicitly not_workday');
};
