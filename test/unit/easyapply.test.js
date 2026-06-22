'use strict';
// Easy Apply modal-helper tests. Loads autofill.js + auto-apply.js into jsdom against a
// SYNTHETIC LinkedIn Easy-Apply modal fixture. Guards modal-state detection, button finding,
// and required-field extraction — the pieces that drive the step-through.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

const MODAL_HTML = `<!DOCTYPE html><html><body>
  <div class="jobs-easy-apply-modal" role="dialog">
    <h3>Additional Questions</h3>
    <label for="yrs">How many years of experience do you have?*</label>
    <input id="yrs" type="text" required aria-required="true">
    <label for="auth">Are you legally authorized to work in the US?*</label>
    <select id="auth" required aria-required="true"><option value="">Select</option><option>Yes</option><option>No</option></select>
    <label for="opt">Cover note</label>
    <textarea id="opt"></textarea>
    <button aria-label="Dismiss">Dismiss</button>
    <button>Review</button>
    <button>Next</button>
  </div>
</body></html>`;

function load(html) {
  const dom = new JSDOM(html, { url: 'https://www.linkedin.com/jobs/view/123/', runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: p => p } };
  w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 }; };
  // jsdom: offsetParent is null without layout; stub truthy so visibility checks pass.
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentNode; } });
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8'));
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/auto-apply.js'), 'utf8'));
  return w;
}

module.exports = (t) => {
  const w = load(MODAL_HTML);

  // modal-state detection
  const modal = w.__pjaGetCurrentModal();
  t.ok(modal && modal.root, 'EA: detects the Easy Apply modal');
  t.eq(w.__pjaModalHeading(), 'Additional Questions', 'EA: reads the step heading');

  // button finding
  const btns = w.__pjaModalBtns();
  t.ok(btns.includes('Next'), 'EA: finds Next button');
  t.ok(btns.includes('Review'), 'EA: finds Review button');

  // required-field extraction (empty required text + select; optional textarea ignored)
  const empty = w.__pjaEmptyRequiredFields();
  t.ok(empty.length >= 2, 'EA: flags the empty required fields (years + work-auth)');

  // the shared modal-scoped collector finds the same required fields
  if (typeof w.pjaCollectRequiredEmptyFields === 'function') {
    const collected = w.pjaCollectRequiredEmptyFields(modal.root).map(f => f.label.toLowerCase());
    t.ok(collected.some(l => /years of experience/.test(l)), 'EA: shared collector finds the years question in-modal');
    t.ok(collected.some(l => /authorized to work/.test(l)), 'EA: shared collector finds the work-auth question in-modal');
  }

  // empty modal (no dialog) → no false positives
  const w2 = load('<!DOCTYPE html><html><body><div>no modal here</div></body></html>');
  t.eq(w2.__pjaGetCurrentModal(), null, 'EA: no modal → null');
  t.eq(w2.__pjaModalBtns().length, 0, 'EA: no modal → no buttons');

  // --- mid-refresh resilience: modal-state classification (double-submit guard) ---
  const st1 = w.__pjaEasyApplyState(modal);
  t.eq(st1.success, false, 'EA-state: questions step is not success');
  // submit-ready step
  const wSub = load('<!DOCTYPE html><html><body><div class="jobs-easy-apply-modal" role="dialog"><h3>Review your application</h3><button>Submit application</button></div></body></html>');
  const stSub = wSub.__pjaEasyApplyState(wSub.__pjaGetCurrentModal());
  t.eq(stSub.submitReady, true, 'EA-state: detects submit-ready');
  t.eq(stSub.success, false, 'EA-state: submit-ready is not success');
  // post-submit confirmation (mid-refresh case) → success, so we DON'T re-submit
  const wOk = load('<!DOCTYPE html><html><body><div class="jobs-easy-apply-modal" role="dialog"><h3>Application sent</h3><p>Your application was sent to Acme</p><button>Done</button></div></body></html>');
  const stOk = wOk.__pjaEasyApplyState(wOk.__pjaGetCurrentModal());
  t.eq(stOk.success, true, 'EA-state: post-submit confirmation → success (double-submit guard)');
  t.eq(w2.__pjaEasyApplyState(null).open, false, 'EA-state: no modal → not open');
};
