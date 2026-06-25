'use strict';
// Indeed Apply step-state classifier (pjaIndeedStepKind): distinguishes success / submit /
// continue / challenge / unknown so the engine submits at review, advances mid-flow, and PAUSES
// on a captcha. SYNTHETIC DOM only.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function load(html, url) {
  const dom = new JSDOM(html, { url: url || 'https://smartapply.indeed.com/beta/indeedapply/form/qualification-questions-module', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } }, runtime: { sendMessage() {}, onMessage: { addListener() {} } } };
  w.console = { log() {}, warn() {}, error() {} };
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentNode; } });
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/indeed-apply.js'), 'utf8'));
  return w;
}

module.exports = (t) => {
  const wSubmit = load('<!DOCTYPE html><body><h1>Manufacturing Engineer</h1><button>Submit your application</button></body>');
  t.ok(typeof wSubmit.__pjaIndeedStepKind === 'function', 'indeed-apply: classifier exposed on smartapply');
  t.eq(wSubmit.__pjaIndeedStepKind(wSubmit.document), 'submit', 'indeed-apply: review step (Submit button) → submit');

  const wCont = load('<!DOCTYPE html><body><fieldset><legend>Do you have experience with a manufacturing facility?</legend><input type=radio><input type=radio></fieldset><button>Continue</button></body>');
  t.eq(wCont.__pjaIndeedStepKind(wCont.document), 'continue', 'indeed-apply: screening step (Continue) → continue');

  const wChal = load('<!DOCTYPE html><body><div>Additional Verification Required</div></body>');
  t.eq(wChal.__pjaIndeedStepKind(wChal.document), 'challenge', 'indeed-apply: captcha text → challenge (pause)');

  const wOkText = load('<!DOCTYPE html><body><h1>Your application has been submitted</h1></body>');
  t.eq(wOkText.__pjaIndeedStepKind(wOkText.document), 'success', 'indeed-apply: confirmation text → success');

  const wOkPath = load('<!DOCTYPE html><body><div>done</div></body>', 'https://smartapply.indeed.com/beta/indeedapply/post-apply');
  t.eq(wOkPath.__pjaIndeedStepKind(wOkPath.document), 'success', 'indeed-apply: /post-apply path → success');

  const wUnknown = load('<!DOCTYPE html><body><button>Save and close</button></body>');
  t.eq(wUnknown.__pjaIndeedStepKind(wUnknown.document), 'unknown', 'indeed-apply: no advance/submit control → unknown');
};
