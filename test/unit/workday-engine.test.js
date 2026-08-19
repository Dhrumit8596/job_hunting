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
  t.eq(application.PJAWorkdayEngine.duplicateRecordRecoveryAction({
    hasError: true, pathname: '/en-US/Careers/job/Foo/apply/applyManually', search: '', retryUsed: false,
  }), 'reroute', 'workday engine: first duplicate-record validation gets one draft-route recovery');
  t.eq(application.PJAWorkdayEngine.duplicateRecordRecoveryAction({
    hasError: true, pathname: '/en-US/Careers/job/Foo/apply/applyManually', search: '?pja_wd_draft_retry=1', retryUsed: false,
  }), 'terminal', 'workday engine: marked duplicate draft retry terminalizes even if session state was lost');
  t.eq(application.PJAWorkdayEngine.duplicateRecordRecoveryAction({
    hasError: true, pathname: '/en-US/Careers/job/Foo/apply/applyManually', search: '', retryUsed: true,
  }), 'terminal', 'workday engine: used duplicate retry terminalizes before another fill pass');
  t.eq(application.PJAWorkdayEngine.duplicateRecordRecoveryAction({
    hasError: false, pathname: '/en-US/Careers/job/Foo/apply/applyManually', search: '?pja_wd_draft_retry=1', retryUsed: true,
  }), 'terminal', 'workday engine: durable retry evidence terminalizes before delayed error text re-renders');
  t.eq(application.PJAWorkdayEngine.duplicateRecordRecoveryAction({
    hasError: false, pathname: '/en-US/Careers/job/Foo/apply', search: '?pja_wd_draft_retry=1', retryUsed: true,
  }), 'none', 'workday engine: marked draft landing may proceed until control returns to applyManually');

  const classify = application.PJAWorkdayEngine.classifySubmissionObservation;
  t.eq(classify({ duplicateRecord: true, submitAttempted: true }).kind, 'duplicate_record',
    'workday observation: duplicate-record evidence wins and is terminal');
  t.eq(classify({ explicitSuccess: true, submitAttempted: true }).kind, 'confirmed',
    'workday observation: explicit confirmation is an actual submission');
  t.eq(classify({ validationError: true, submitAttempted: true }).retrySafe, true,
    'workday observation: explicit validation failure is the only retry-safe post-submit state');
  t.eq(classify({ accountBlocker: true, submitAttempted: true }).kind, 'account_blocker',
    'workday observation: account blockers are distinguished from validation failures');
  t.eq(classify({ captcha: true, submitAttempted: true }).kind, 'captcha',
    'workday observation: CAPTCHA is a terminal manual state');
  t.eq(classify({ transportError: true, submitAttempted: false }).reason, 'workday_transport_failure',
    'workday observation: failed submit delivery is a transport failure');
  t.eq(classify({ watchdog: true, submitAttempted: false }).kind, 'watchdog_failure',
    'workday observation: pre-submit watchdog remains a failure');
  const postSubmitWatchdog = classify({ watchdog: true, submitAttempted: true });
  t.eq(postSubmitWatchdog.reason, 'submit_observation_timeout',
    'workday observation: post-submit watchdog is unverified');
  t.eq(postSubmitWatchdog.kind === 'submitted_unverified' && postSubmitWatchdog.retrySafe === false, true,
    'workday observation: post-submit watchdog is never confirmed or retryable');
  t.eq(classify({ submitAttempted: true }).kind, 'submitted_unverified',
    'workday observation: ambiguous post-submit state remains submitted/unverified');

  const nonWd = loadEngine('<body><button>Apply</button></body>', 'https://example.com/jobs/1');
  t.eq(nonWd.PJAWorkdayEngine.detectState(nonWd.document), 'not_workday',
    'workday engine: non-Workday host is explicitly not_workday');
};
