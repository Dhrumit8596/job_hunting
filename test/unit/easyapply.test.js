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
  const autoApplySource = fs.readFileSync(path.resolve(ROOT, 'content/auto-apply.js'), 'utf8');
  const trustedClickSource = autoApplySource.slice(
    autoApplySource.indexOf('function pjaTrustedClickInModal'),
    autoApplySource.indexOf('function pjaDismissModal'));
  t.ok(autoApplySource.includes('required-combobox skip phone code visible US') &&
    autoApplySource.includes("isWorkdayPhoneCode ? 'phoneCountryCode'") &&
    autoApplySource.includes("val = 'LinkedIn'"),
  'EA/shared fallback: Workday phone-code and referral-source comboboxes use site-specific safe keys');
  const closePopupSource = autoApplySource.slice(
    autoApplySource.indexOf('function pjaCloseOpenModalPopups'),
    autoApplySource.indexOf('const PJA_TRUSTED_ACTIVATIONS'));
  t.ok(closePopupSource.includes('active.blur') &&
    !closePopupSource.includes('new KeyboardEvent') &&
    autoApplySource.includes('pjaCloseOpenModalPopups();'),
  'EA step clicks commit the active control without sending dialog-dismiss Escape events');
  t.ok(autoApplySource.includes("activation === 'keyboard' ? 'LINKEDIN_TRUSTED_KEY_ACTIVATE'") &&
    autoApplySource.includes("sameStepCount === 1 ? 'keyboard' : 'mouse'") &&
    autoApplySource.includes('same-step recovery: trusted keyboard') &&
    autoApplySource.includes("reason: 'trusted_click_failed'") &&
    !trustedClickSource.includes('pjaClickInModal(label)'),
  'EA step actions use one trusted-keyboard recovery and never use LinkedIn-rejected synthetic fallback');
  const contentSource = fs.readFileSync(path.resolve(ROOT, 'content/content.js'), 'utf8');
  t.ok(autoApplySource.includes('pjaEasyApplyResultDiagnostic(diag') &&
    contentSource.includes('diagnostic: result && result.diagnostic || null'),
  'EA terminal results carry sanitized step diagnostics into the application ledger');

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
  const wUpsell = load('<!DOCTYPE html><html><body><div class="jobs-easy-apply-modal" role="dialog"><h3>Premium career insights</h3><p>Explore Premium career tools</p></div></body></html>');
  t.eq(wUpsell.__pjaEasyApplyState(wUpsell.__pjaGetCurrentModal()).success, false,
    'EA-state: generic Premium upsell is not submission confirmation');
  t.eq(w2.__pjaEasyApplyState(null).open, false, 'EA-state: no modal → not open');

  // Current LinkedIn search results include “Easy Apply” inside cards before the selected-job
  // detail action. The finder must ignore the badge/card control and return the detail action.
  const wCurrent = load(`<!DOCTYPE html><html><body>
    <div role="button" componentkey="job-card-component-ref-111"><span>Easy Apply</span></div>
    <a id="detail-ea" aria-label="Easy Apply to this job"
      href="https://www.linkedin.com/jobs/view/4429434522/apply/?openSDUIApplyFlow=true">Easy Apply</a>
  </body></html>`);
  t.eq(wCurrent.__pjaFindEasyApplyBtn()?.id, 'detail-ea',
    'EA opener: card badge cannot shadow the selected-job Easy Apply action');
  const wRole = load(`<!DOCTYPE html><html><body>
    <div id="role-ea" role="button" aria-label="Easy Apply to this job"></div>
  </body></html>`);
  t.eq(wRole.__pjaFindEasyApplyBtn()?.id, 'role-ea',
    'EA opener: aria-label-only role=button controls are supported');

  // --- button collector excludes PAGE-level buttons (dialog scoping) ---
  // Regression: scanning the whole shadow root pulled in LinkedIn's "Messaging" widget + a page
  // "Next", and clicking the wrong "Next" navigated the page → reload loop (open_loop_skip).
  const wPage = load(`<!DOCTYPE html><html><body>
    <button id="page-msg">Messaging</button>
    <button id="page-next">Next</button>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Contact info</h3>
      <button>Continue to next step</button>
    </div>
  </body></html>`);
  const pbtns = wPage.__pjaModalBtns();
  t.ok(pbtns.includes('Continue to next step'), 'EA: finds the in-dialog button');
  t.ok(!pbtns.includes('Messaging'), 'EA: excludes page-level Messaging button');
  t.ok(!pbtns.includes('Next'), 'EA: excludes page-level Next button (outside the dialog)');

  // LinkedIn can reuse the same heading for distinct pages. Stuck detection must follow a
  // value-free step fingerprint, not the heading, while ignoring changes to entered values.
  const wRepeat = load(`<!DOCTYPE html><html><body>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Contact info</h3>
      <div role="progressbar" aria-valuenow="25"></div>
      <label for="email-step">Email address</label><select id="email-step" required><option>One</option></select>
      <footer><button>Next</button></footer>
    </div>
  </body></html>`);
  const firstContactFingerprint = wRepeat.__pjaEasyApplyStepFingerprint();
  wRepeat.document.querySelector('select').value = 'One';
  t.eq(wRepeat.__pjaEasyApplyStepFingerprint(), firstContactFingerprint,
    'EA: step fingerprint excludes entered values');
  const repeatedDialog = wRepeat.document.querySelector('.jobs-easy-apply-modal');
  repeatedDialog.innerHTML = `<h3>Contact info</h3>
    <div role="progressbar" aria-valuenow="50"></div>
    <label for="phone-step">Mobile phone number</label><input id="phone-step" type="tel" required>
    <footer><button>Next</button></footer>`;
  t.ok(wRepeat.__pjaEasyApplyStepFingerprint() !== firstContactFingerprint,
    'EA: repeated Contact info heading with different progress/fields is a new step');
  repeatedDialog.innerHTML = `<h3>Additional Questions</h3>
    <label for="years-step">Years of experience</label><input id="years-step" type="text" required>
    <footer><button>Next</button></footer>`;
  const firstQuestionsFingerprint = wRepeat.__pjaEasyApplyStepFingerprint();
  repeatedDialog.innerHTML = `<h3>Additional Questions</h3>
    <fieldset><legend>Are you authorized to work?</legend>
      <label><input type="radio" name="auth" required>Yes</label>
    </fieldset><footer><button>Next</button></footer>`;
  t.ok(wRepeat.__pjaEasyApplyStepFingerprint() !== firstQuestionsFingerprint,
    'EA: repeated Additional Questions heading with different controls is a new step');

  // --- button collector excludes modal BODY widget buttons ---
  // Regression from a real LinkedIn run: a date-picker/calendar rendered numeric day buttons
  // before the footer Review button. Treating those as flow buttons caused repeated Review clicks
  // on the same step and a final "stuck" failure.
  const wCalendar = load(`<!DOCTYPE html><html><body>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Additional Questions</h3>
      <section>
        <button>26</button><button>27</button><button>28</button><button>29</button>
        <button>30</button><button>31</button><button>1</button><button>2</button>
      </section>
      <footer class="artdeco-modal__actionbar">
        <button>Back</button>
        <button>Review</button>
      </footer>
    </div>
  </body></html>`);
  const cbtns = wCalendar.__pjaModalBtns();
  t.ok(cbtns.includes('Review'), 'EA: finds footer Review when body has numeric date buttons');
  t.ok(!cbtns.some(b => /^\d+$/.test(b)), 'EA: excludes numeric body widget buttons from flow controls');

  // --- pjaFillForm scoped to the open EA modal (never fills LinkedIn's page search bar) ---
  // Regression: document-wide fill populated jobs-search-box-*, triggering a search that closed
  // the modal mid-flow (modal_closed/unknown_buttons root cause).
  const wFill = load(`<!DOCTYPE html><html><body>
    <input id="jobs-search-box-keyword-id-ember1" role="combobox">
    <input id="global-nav-search-input">
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Contact info</h3>
      <label for="em">Email address*</label><input id="em" type="email" required>
    </div>
  </body></html>`);
  wFill.pjaFillForm({ email: 'q@e.com', firstName: 'Q' }, {});
  t.eq(wFill.document.getElementById('jobs-search-box-keyword-id-ember1').value, '', 'EA: pjaFillForm leaves the page search bar empty');
  t.eq(wFill.document.getElementById('global-nav-search-input').value, '', 'EA: pjaFillForm leaves the global nav search empty');

  // --- Greenhouse required consent checkbox with machine-readable id/name ---
  // Regression: Greenhouse labels can be sparse/visually separated, while the required checkbox
  // is identifiable only by name/id (gdpr_demographic_data_consent_given).
  const wConsent = load(`<!DOCTYPE html><html><body>
    <form>
      <input id="gdpr_demographic_data_consent_given"
        name="gdpr_demographic_data_consent_given"
        type="checkbox"
        required
        aria-required="true">
      <label for="gdpr_demographic_data_consent_given">I consent to demographic data processing</label>
    </form>
  </body></html>`);
  wConsent.__pjaAutoCheckConsent();
  t.eq(wConsent.document.getElementById('gdpr_demographic_data_consent_given').checked, true,
    'EA/Greenhouse: auto-checks required GDPR demographic consent checkbox by id/name');

  // --- education-LEVEL radio picker (the Penumbra 'stuck' blocker) ---
  // The question has degree-level options, not Yes/No → pick the one matching profile.degree.
  const wEdu = load(`<!DOCTYPE html><html><body>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Additional Questions</h3>
      <fieldset aria-required="true">
        <legend>What is the highest level of education you have completed?</legend>
        <label><input type="radio" name="edu" value="High school diploma or GED" required> High school diploma or GED</label>
        <label><input type="radio" name="edu" value="Associate's degree"> Associate's degree</label>
        <label><input type="radio" name="edu" value="Bachelor's degree"> Bachelor's degree</label>
        <label><input type="radio" name="edu" value="Master's degree"> Master's degree</label>
      </fieldset>
    </div>
  </body></html>`);
  wEdu.__pjaFillRequiredRadioFallback({ degree: "Bachelor's Degree" });
  const checkedEdu = Array.from(wEdu.document.querySelectorAll('input[name=edu]')).find(r => r.checked);
  t.ok(checkedEdu && /bachelor/i.test(checkedEdu.value), 'EA: education-level radio selects the matching degree (Bachelor\'s), not Yes/No');

  // --- referral radio → No (not an employee referral) ---
  const wRef = load(`<!DOCTYPE html><html><body>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Additional Questions</h3>
      <fieldset aria-required="true"><legend>Were you referred by a Penumbra Employee?</legend>
        <label><input type="radio" name="ref" value="Yes" required> Yes</label>
        <label><input type="radio" name="ref" value="No"> No</label>
      </fieldset>
    </div>
  </body></html>`);
  wRef.__pjaFillRequiredRadioFallback({});
  const checkedRef = Array.from(wRef.document.querySelectorAll('input[name=ref]')).find(r => r.checked);
  t.ok(checkedRef && /no/i.test(checkedRef.value), 'EA: referral radio answers No');

  // Real-run regression (apply-1787024777101): LinkedIn's Contact Info phone field commits on
  // blur and React replaces the footer action. The trusted helper must wait one render beat and
  // target the replacement button, not the stale pre-blur coordinates.
  const wBlur = load(`<!DOCTYPE html><html><body>
    <div class="jobs-easy-apply-modal" role="dialog"><h3>Contact info</h3>
      <label for="phone">Mobile phone number</label><input id="phone" required value="5555555555">
      <footer><button id="old-next">Next</button></footer>
    </div>
  </body></html>`);
  let trustedMessage = null;
  wBlur.chrome.runtime.sendMessage = (msg, cb) => { trustedMessage = msg; cb?.({ ok: true }); };
  let dismissEscapes = 0;
  wBlur.document.addEventListener('keydown', event => { if (event.key === 'Escape') dismissEscapes++; });
  const phone = wBlur.document.getElementById('phone');
  phone.addEventListener('blur', () => {
    const old = wBlur.document.getElementById('old-next');
    const replacement = wBlur.document.createElement('button');
    replacement.id = 'new-next';
    replacement.textContent = 'Next';
    replacement.scrollIntoView = () => {};
    replacement.getBoundingClientRect = () => ({ left: 200, top: 80, width: 100, height: 40 });
    old.replaceWith(replacement);
  });
  phone.focus();
  return wBlur.__pjaTrustedClickInModal('Next').then(ok => {
    t.eq(ok, true, 'EA trusted action succeeds after the contact-field blur commit');
    t.eq(trustedMessage?.x, 250, 'EA trusted action re-resolves replacement button coordinates after blur');
    t.eq(trustedMessage?.y, 100, 'EA trusted action uses replacement button vertical coordinate');
    const activation = wBlur.__pjaTrustedActivations.at(-1);
    t.eq(activation?.commandOk, true, 'EA trusted-action diagnostics distinguish successful CDP transport');
    t.eq(activation?.landed, false, 'EA trusted-action diagnostics separately record missing DOM landing acknowledgement');
    t.eq(activation?.targetId, 'new-next', 'EA trusted-action diagnostics identify the sanitized replacement target');
    t.eq(dismissEscapes, 0, 'EA trusted action never opens LinkedIn save/discard overlay with Escape');
  });
};
