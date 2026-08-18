'use strict';

// ── Auto-Apply Engine ────────────────────────────────────────────────────────
// Scans LinkedIn job search results for "Top applicant" or match badges,
// then steps through each Easy Apply modal using the existing pjaFillForm engine.

const PJA_AUTO_STATE = { running: false, aborted: false };

// ISSUE-2 — LinkedIn gates the Easy Apply *open* click against automation, but not
// the modal fill/step-through. When our synthetic click can't open the modal, fall
// back to assisted mode: prompt the user to click "Easy Apply" once, keep retrying
// our own click, and take over the moment the modal appears.
const PJA_EA_ASSISTED = true;            // (legacy) keep assisted fallback available
const PJA_EA_ASSIST_TIMEOUT_MS = 300000; // how long to wait for the user to open the modal (5 min)
const PJA_EA_DRY_RUN = false;            // TEST MODE: stop right after modal opens (no fill)
// AUTO mode + auto-submit: required for backend/autonomous triggering (no human to click Easy
// Apply or Submit). Keep assisted fallback enabled so a user can still click the Easy Apply
// button if LinkedIn rejects the automatic open action on a specific page/account state.
const PJA_EA_AUTO_OPEN = true;
const PJA_EA_STOP_BEFORE_SUBMIT = false; // false = fill, step, AND submit (auto-submit authorized)

// Search URL: Easy Apply · past month · quality roles
const PJA_AUTO_SEARCH_URL =
  'https://www.linkedin.com/jobs/search/?keywords=quality%20technician%20quality%20engineer&f_AL=true&location=San%20Francisco%20Bay%20Area&geoId=90000084&f_TPR=r2592000';

function pjaAutoWait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Modal detection ──────────────────────────────────────────────────────────

function pjaGetCurrentModal() {
  // On search pages, modal is in regular DOM
  const regular = document.querySelector('.jobs-easy-apply-modal');
  if (regular) return { root: regular, isShadow: false };

  // On job view pages, modal appears inside interop-outlet shadow root.
  // artdeco-modal-outlet and hue-web-modal-outlet are the containers.
  const outlet = document.getElementById('interop-outlet');
  if (outlet?.shadowRoot) {
    const sr = outlet.shadowRoot;
    // Check artdeco modal outlet first (most common for Easy Apply)
    const artdeco = sr.querySelector('#artdeco-modal-outlet');
    if (artdeco?.querySelector('[role="dialog"]')) return { root: artdeco, isShadow: true };
    const hue = sr.querySelector('#hue-web-modal-outlet');
    if (hue?.querySelector('[role="dialog"]')) return { root: hue, isShadow: true };
    // Generic fallback
    const d = sr.querySelector('[role="dialog"], .jobs-easy-apply-modal');
    if (d) return { root: sr, isShadow: true };
  }

  return null;
}

function pjaModalHeading() {
  const m = pjaGetCurrentModal();
  if (!m) return null;
  return m.root.querySelector('h3')?.textContent?.trim() || null;
}

const PJA_EA_ACTION_LABEL_RE = /^(next|review|continue to next step|submit application)$/i;

function pjaButtonLabel(b) {
  return String((b && (b.textContent || b.getAttribute?.('aria-label') || '')) || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pjaIsEaActionButton(b) {
  const label = pjaButtonLabel(b);
  if (!label || !PJA_EA_ACTION_LABEL_RE.test(label)) return false;
  if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
  return true;
}

// Robust action-button collector. The Easy Apply body can contain unrelated buttons (for example
// date-picker day buttons with labels like "26, 27, 28"), while the footer/actionbar contains the
// real flow controls (Next/Review/Submit). Prefer footer/action scopes and always filter to known
// Easy Apply flow actions so body widgets cannot drive the state machine.
function pjaModalButtonEls() {
  const m = pjaGetCurrentModal();
  if (!m) return [];
  const r = m.root;
  // PREFER the actual [role=dialog] element — scanning the whole shadow root pulled in page-level
  // controls (LinkedIn's "Messaging" widget, a page "Next"), and clicking the wrong "Next"
  // navigated the page → reload loop (open_loop_skip). The dialog excludes those.
  let dialog = (r.querySelector && r.querySelector('[role="dialog"]'))
    || (r.closest && r.closest('[role="dialog"]'))
    || (r.matches && r.matches('[role="dialog"]') ? r : null);
  const seen = new Set(); const out = [];
  const addActionButtons = (scope) => {
    if (!scope || !scope.querySelectorAll) return;
    for (const b of scope.querySelectorAll('button')) {
      if (seen.has(b) || !pjaIsEaActionButton(b)) continue;
      seen.add(b); out.push(b);
    }
  };

  const footerSelectors = [
    'footer',
    '.artdeco-modal__actionbar',
    '.artdeco-modal__footer',
    '.jobs-easy-apply-modal__footer',
    '.jobs-easy-apply-modal__actions',
    '[data-test-modal-actionbar]',
    '[data-test-modal-footer]',
    '[class*="actionbar"]',
    '[class*="footer"]'
  ].join(',');

  // First pass: footer/actionbar scopes. This is the normal LinkedIn layout and avoids body
  // controls such as calendars and steppers.
  const primary = [];
  if (dialog) primary.push(dialog);
  primary.push(r);
  if (m.isShadow) { const o = document.getElementById('interop-outlet'); if (o && o.shadowRoot) primary.push(o.shadowRoot); }
  for (const sc of primary) {
    if (!sc?.querySelectorAll) continue;
    for (const footer of sc.querySelectorAll(footerSelectors)) addActionButtons(footer);
  }
  if (out.length) return out;

  // Fallback: scan the actual dialog/root, but still only return known flow-action labels.
  if (dialog) {
    addActionButtons(dialog);
    if (out.length) return out;
  }

  // Last fallback (footer mounted outside the dialog, or no dialog): widen to root then shadow root.
  const scopes = [r];
  if (m.isShadow) { const o = document.getElementById('interop-outlet'); if (o && o.shadowRoot) scopes.push(o.shadowRoot); }
  for (const sc of scopes) addActionButtons(sc);
  return out;
}
function pjaModalBtns() {
  const seen = new Set(); const out = [];
  for (const b of pjaModalButtonEls()) {
    const t = pjaButtonLabel(b);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// LinkedIn reuses broad headings such as "Contact info" and "Additional Questions" across
// distinct pages. A heading alone is therefore not a step identity. Build a bounded, value-free
// fingerprint from progress metadata and visible control labels; user-entered values are excluded.
function pjaEasyApplyStepFingerprint() {
  const modal = pjaGetCurrentModal();
  if (!modal?.root) return '';
  const root = modal.root;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
  const visible = el => {
    try {
      const rect = el.getBoundingClientRect?.();
      return !rect || rect.width > 0 || rect.height > 0 || !!el.offsetParent;
    } catch (_) { return true; }
  };
  const labelFor = el => {
    try {
      const label = (typeof window.pjaGetLabel === 'function' ? window.pjaGetLabel(el) : '') ||
        (el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '') ||
        el.getAttribute?.('aria-label') || el.getAttribute?.('data-test-text-entity-list-form-component') ||
        el.getAttribute?.('name') || el.id || '';
      return clean(label);
    } catch (_) { return ''; }
  };
  const progress = Array.from(root.querySelectorAll(
    '[role="progressbar"], [aria-valuenow], .artdeco-completeness-meter-linear__progress-element, [class*="progress"]'
  )).filter(visible).slice(0, 6).map(el => [
    clean(el.getAttribute?.('aria-valuenow')),
    clean(el.getAttribute?.('aria-valuetext')),
    clean(el.textContent),
  ].filter(Boolean).join(':')).filter(Boolean);
  const legends = Array.from(root.querySelectorAll('legend')).filter(visible)
    .slice(0, 12).map(el => clean(el.textContent)).filter(Boolean);
  const controls = Array.from(root.querySelectorAll(
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [contenteditable="true"]'
  )).filter(visible).slice(0, 40).map(el => [
    clean(el.tagName),
    clean(el.getAttribute?.('type') || el.getAttribute?.('role')),
    el.required || el.getAttribute?.('aria-required') === 'true' ? 'required' : 'optional',
    labelFor(el),
  ].join(':'));
  return [clean(pjaModalHeading()), `progress=${progress.join(',')}`, `legends=${legends.join(',')}`,
    `controls=${controls.join(',')}`, `actions=${pjaModalBtns().map(clean).join(',')}`].join('|').slice(0, 2400);
}

// Classify the current Easy Apply modal state — used for mid-refresh resilience: if LinkedIn
// reloads mid-flow and the modal comes back showing a post-submit confirmation, we must record
// success and NOT click Submit again (double-submit guard). Pure-ish (reads the given modal root).
function pjaEasyApplyState(modal) {
  if (!modal || !modal.root) return { open: false, success: false, submitReady: false, heading: '' };
  const root = modal.root;
  const heading = (root.querySelector('h3, h2')?.textContent || '').trim();
  const text = (root.textContent || '');
  const btns = Array.from(root.querySelectorAll('button')).map(b => (b.textContent || '').trim());
  const success = /application sent|your application was sent|application submitted|application has been submitted|you(?:'|’)ve applied|thank you for applying/i.test(text)
    || /application (?:sent|submitted)|thank you for applying/i.test(heading);
  const submitReady = btns.some(b => /^submit application$/i.test(b));
  return { open: true, success, submitReady, heading, buttons: btns };
}

function pjaLinkedInSubmitErrors() {
  const modal = pjaGetCurrentModal();
  const root = modal && modal.root ? modal.root : document;
  const text = String(root.textContent || '');
  const requiredEmpty = (() => {
    try {
      return typeof window.pjaCollectRequiredEmptyFields === 'function' && modal
        ? window.pjaCollectRequiredEmptyFields(modal.root).map(f => f.label)
        : pjaEmptyRequiredFields();
    } catch (_) { return []; }
  })();
  const visibleError = /required|please enter|please select|must be|invalid|fix|error/i.test(text)
    && (root.querySelector('[role="alert"], .artdeco-inline-feedback--error, .fb-dash-form-element__error-field') || requiredEmpty.length);
  return { requiredEmpty, visibleError: !!visibleError };
}

async function pjaRecordSubmitUnclearDiagnostics(label) {
  try {
    const modal = pjaGetCurrentModal();
    const state = modal ? pjaEasyApplyState(modal) : { open: false };
    const errors = pjaLinkedInSubmitErrors();
    const diag = {
      ts: Date.now(),
      label: label || '',
      url: location.href,
      title: document.title,
      modalState: state,
      errors,
      bodyTail: String(document.body?.innerText || '').slice(-1200),
    };
    chrome.storage.local.set({ pja_ea_submit_diag: diag });
  } catch (_) {}
}

async function pjaRecordEasyApplyStepDiagnostics(label, heading, extra = {}) {
  try {
    const modal = pjaGetCurrentModal();
    const root = modal?.root || document;
    const safeText = (txt) => String(txt || '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[email]')
      .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
      .replace(/\s+/g, ' ')
      .trim();
    const fieldLabel = (el) => {
      try {
        return safeText(
          (typeof window.pjaGetLabel === 'function' ? window.pjaGetLabel(el) : '') ||
          (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '') ||
          el.getAttribute?.('aria-label') ||
          el.closest?.('label, fieldset, [class*="field"], [class*="question"]')?.textContent ||
          ''
        ).slice(0, 180);
      } catch (_) { return ''; }
    };
    const summarizeControl = (el) => ({
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      role: el.getAttribute?.('role') || '',
      required: !!(el.required || el.getAttribute?.('aria-required') === 'true'),
      invalid: el.getAttribute?.('aria-invalid') || '',
      label: fieldLabel(el),
      options: el.tagName === 'SELECT'
        ? Array.from(el.options || []).map(o => safeText(o.textContent).slice(0, 80)).filter(Boolean).slice(0, 12)
        : [],
      textLen: el.tagName === 'TEXTAREA' ? String(el.value || '').length : undefined,
      hasValue: !!String(el.value || '').trim(),
    });
    const visibleErrors = Array.from(root.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .fb-dash-form-element__error-field, [id*="error"], [class*="error"]'))
      .map(el => safeText(el.textContent).slice(0, 220))
      .filter(Boolean)
      .slice(0, 12);
    const collected = (typeof window.pjaCollectRequiredEmptyFields === 'function')
      ? window.pjaCollectRequiredEmptyFields(root).map(f => ({ label: safeText(f.label).slice(0, 180), type: f.type, options: (f.options || []).slice(0, 12) }))
      : [];
    const controls = Array.from(root.querySelectorAll('input:not([type=hidden]), select, textarea, [role="combobox"], [aria-required="true"], [aria-invalid="true"]'))
      .filter(el => {
        const rr = el.getBoundingClientRect?.();
        return !rr || rr.width > 0 || rr.height > 0 || el.offsetParent;
      })
      .map(summarizeControl)
      .slice(0, 40);
    const actionStates = pjaModalButtonEls().slice(0, 12).map(el => ({
      label: safeText(pjaButtonLabel(el)).slice(0, 80),
      disabled: !!el.disabled,
      ariaDisabled: el.getAttribute?.('aria-disabled') || '',
    }));
    const diag = {
      ts: Date.now(),
      label: label || '',
      url: location.href,
      heading: safeText(heading || pjaModalHeading() || ''),
      buttons: pjaModalBtns(),
      actionStates,
      trustedActivations: PJA_TRUSTED_ACTIVATIONS.slice(-6),
      easyApplyState: modal ? pjaEasyApplyState(modal) : { open: false },
      submitErrors: pjaLinkedInSubmitErrors(),
      collectedRequiredEmpty: collected,
      visibleErrors,
      controls,
      textTail: safeText(root.innerText || root.textContent || '').slice(-1800),
      extra,
    };
    await new Promise(resolve => chrome.storage.local.set({ pja_ea_diag: diag }, resolve));
    return diag;
  } catch (_) { return null; }
}

function pjaEasyApplyResultDiagnostic(diag, reason) {
  if (!diag) return null;
  const controls = Array.isArray(diag.controls) ? diag.controls : [];
  const trustedActivations = Array.isArray(diag.trustedActivations) ? diag.trustedActivations : [];
  const transported = trustedActivations.filter(x => x && x.commandOk);
  const landed = transported.filter(x => x.landed);
  return {
    phase: diag.label || 'easy-apply-step',
    reason: reason || '',
    ats: 'linkedin',
    strategy: 'linkedin_ea',
    url: diag.url || location.href,
    missingRequired: (diag.collectedRequiredEmpty || []).map(x => x && x.label).filter(Boolean),
    visibleErrors: diag.visibleErrors || [],
    formSummary: [diag.heading, 'actions=' + (diag.buttons || []).join(','),
      'controls=' + controls.map(x => [x.tag, x.type || x.role, x.required ? 'required' : 'optional', x.label].filter(Boolean).join(':')).join('|')]
      .filter(Boolean).join('; ').slice(0, 600),
    controlCounts: {
      total: controls.length,
      required: controls.filter(x => x.required).length,
      invalid: controls.filter(x => String(x.invalid || '').toLowerCase() === 'true').length,
      populated: controls.filter(x => x.hasValue).length,
    },
    submitButtons: diag.buttons || [],
    actionStates: diag.actionStates || [],
    trustedActivations,
    likelyCause: reason === 'stuck'
      ? (transported.length && landed.length === 0
          ? 'CDP commands completed but no trusted activation event was observed on the intended modal action'
          : 'Enabled action received trusted activation but the step fingerprint did not change')
      : '',
    capturedAt: diag.ts || Date.now(),
  };
}

async function pjaWaitForEasyApplyConfirmation(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const modal = pjaGetCurrentModal();
    if (modal && pjaEasyApplyState(modal).success) return true;
    const text = String(document.body?.innerText || '').slice(-6000);
    if (/application sent|your application was sent|application (?:has been )?submitted|you(?:'|’)ve applied|thank you for applying/i.test(text)) return true;
    if (/\/post-?apply(?:\/|\?|$)/i.test(String(location.href || ''))) return true;
    await pjaAutoWait(400);
  } while (Date.now() < deadline);
  return false;
}
if (typeof window !== 'undefined') window.pjaWaitForEasyApplyConfirmation = pjaWaitForEasyApplyConfirmation;

function pjaClickInModal(label) {
  const m = pjaGetCurrentModal();
  if (!m) return false;
  const btns = pjaModalButtonEls(); // robust scope (incl footer / shadow)
  const btn = btns.find(b => pjaButtonLabel(b) === label)
    || btns.find(b => (b.getAttribute('aria-label') || '').trim() === label)
    || btns.find(b => new RegExp('^' + label, 'i').test(pjaButtonLabel(b)));
  if (!btn) return false;
  btn.click();
  return true;
}

function pjaCloseOpenModalPopups() {
  try {
    const m = pjaGetCurrentModal();
    const root = m?.root || document;
    const active = document.activeElement;
    if (active && root.contains(active)) active.blur?.();
    // Never send Escape to the Easy Apply dialog. LinkedIn treats it as a request to dismiss the
    // application and mounts a "Save this application?" overlay above Next/Review. A real cycle
    // then hit-tested that overlay while the intended action remained enabled behind it
    // (apply-1787026754359). Blurring the active field is sufficient to commit contact values;
    // combobox helpers own their own option-menu lifecycle.
  } catch (_) {}
}

const PJA_TRUSTED_ACTIVATIONS = [];

// LinkedIn checks isTrusted on Easy Apply step-advance clicks — a synthetic click
// (.click()/dispatchEvent) makes the page reload. Route step clicks through the
// background CDP trusted-click (real isTrusted=true mouse event). A transport failure returns
// false; it must never fall back to a synthetic step click because LinkedIn rejects it.
async function pjaTrustedClickInModal(label, activation = 'mouse') {
  let m = pjaGetCurrentModal();
  if (!m) return Promise.resolve(false);
  let btns = pjaModalButtonEls(); // robust scope (incl footer / shadow), not just m.root
  let btn = btns.find(b => pjaButtonLabel(b) === label)
    || btns.find(b => (b.getAttribute('aria-label') || '').trim() === label)
    || btns.find(b => new RegExp('^' + label, 'i').test(pjaButtonLabel(b)));
  if (!btn) return Promise.resolve(false);
  // Compute the button's viewport-center coords HERE (content script sees shadow DOM);
  // the background just performs a trusted CDP mouse click at those coords.
  pjaCloseOpenModalPopups();
  // LinkedIn commits the phone/contact step on blur. Give React one bounded render beat, then
  // resolve the action again because that commit can replace the footer button. Clicking the
  // pre-blur node immediately produced a transport-successful CDP event on a detached/disabled
  // action while every required control was visibly populated (apply-1787024777101).
  await pjaAutoWait(180);
  m = pjaGetCurrentModal();
  if (!m) return false;
  btns = pjaModalButtonEls();
  btn = btns.find(b => pjaButtonLabel(b) === label)
    || btns.find(b => (b.getAttribute('aria-label') || '').trim() === label)
    || btns.find(b => new RegExp('^' + label, 'i').test(pjaButtonLabel(b)));
  if (!btn) return false;
  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (activation === 'keyboard') {
    try { btn.focus({ preventScroll: true }); } catch (_) { try { btn.focus(); } catch (_) {} }
  }
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const messageType = activation === 'keyboard' ? 'LINKEDIN_TRUSTED_KEY_ACTIVATE' : 'LINKEDIN_TRUSTED_CLICK';
  let landed = false;
  const eventType = activation === 'keyboard' ? 'keydown' : 'click';
  const onActivation = event => {
    if (!event?.isTrusted) return;
    if (activation === 'keyboard' && event.key !== 'Enter') return;
    landed = true;
  };
  btn.addEventListener(eventType, onActivation, true);
  let hit = null;
  try { hit = document.elementFromPoint?.(x, y) || null; } catch (_) {}
  const commandOk = await new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; pjaTrace('CDP timeout; trusted ' + activation + ' failed ' + label); resolve(false); } }, 6000);
    try {
      chrome.runtime.sendMessage({ type: messageType, x, y }, (resp) => {
        if (done) return;
        done = true; clearTimeout(t);
        if (chrome.runtime.lastError || resp?.error) {
          pjaTrace('CDP trusted ' + activation + ' failed ' + label + ' err=' + (resp?.error || chrome.runtime.lastError?.message || ''));
          resolve(false);
        } else {
          pjaTrace('CDP ' + activation + ' ok ' + label + (resp?.recovered ? ' (reattached)' : ''));
          resolve(true);
        }
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(t); pjaTrace('CDP trusted ' + activation + ' threw ' + label + ' err=' + (e?.message || e || '')); resolve(false); }
    }
  });
  if (commandOk) await pjaAutoWait(120);
  btn.removeEventListener(eventType, onActivation, true);
  PJA_TRUSTED_ACTIVATIONS.push({
    ts: Date.now(), label: String(label || '').slice(0, 80), activation,
    commandOk, landed, targetId: String(btn.id || '').slice(0, 80),
    hitTag: String(hit?.tagName || '').toLowerCase(),
    hitId: String(hit?.id || '').slice(0, 80),
    hitLabel: String(hit ? pjaButtonLabel(hit) : '').slice(0, 80),
    hitMatchesAction: !!(hit && (hit === btn || btn.contains(hit))),
  });
  if (PJA_TRUSTED_ACTIVATIONS.length > 12) PJA_TRUSTED_ACTIVATIONS.splice(0, PJA_TRUSTED_ACTIVATIONS.length - 12);
  return commandOk;
}

function pjaDismissModal() {
  // Try modal dismiss button, then Discard confirmation
  const outlet = document.getElementById('interop-outlet');
  const sr = outlet?.shadowRoot;
  const dismissBtn = sr
    ? sr.querySelector('button[aria-label="Dismiss"]')
    : document.querySelector('button[aria-label="Dismiss"], .artdeco-modal__dismiss');
  dismissBtn?.click();

  setTimeout(() => {
    const discard = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === 'Discard');
    discard?.click();
  }, 600);
}

// ── Required-field check ─────────────────────────────────────────────────────

function pjaEmptyRequiredFields() {
  const m = pjaGetCurrentModal();
  if (!m) return [];
  const root = m.root;
  const empty = [];

  // Text / select / textarea
  for (const el of root.querySelectorAll(
    'input:not([type=hidden]):not([type=radio]):not([type=checkbox]),select,textarea'
  )) {
    const required = el.required || el.getAttribute('aria-required') === 'true';
    if (!required) continue;
    const val = el.value?.trim();
    if (!val || val === 'Select an option' || val === 'None') {
      // Use pjaGetLabel (from autofill.js, same isolated world) for best label extraction
      const label = (typeof pjaGetLabel === 'function' ? pjaGetLabel(el) : '')
        || el.getAttribute('aria-label') || el.placeholder || el.name || '(field)';
      empty.push(label.replace(/\s+/g, ' ').slice(0, 60));
    }
  }

  // Required radio groups — fieldset where no radio is checked
  for (const fs of root.querySelectorAll('fieldset')) {
    const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
    if (!radios.length) continue;
    const anyRequired =
      fs.getAttribute('aria-required') === 'true' ||
      radios.some(r => r.required || r.getAttribute('aria-required') === 'true');
    if (anyRequired && !radios.some(r => r.checked)) {
      const legend = fs.querySelector('legend')
        ?.textContent?.trim()?.replace(/\s+/g, ' ')?.slice(0, 50) || '(radio group)';
      empty.push(legend);
    }
  }

  // Required checkboxes that are unchecked
  for (const cb of root.querySelectorAll('input[type=checkbox]')) {
    const required = cb.required || cb.getAttribute('aria-required') === 'true';
    if (!required || cb.checked) continue;
    const label = (typeof pjaGetLabel === 'function' ? pjaGetLabel(cb) : '')
      || cb.getAttribute('aria-label') || cb.name || '(checkbox)';
    empty.push(label.replace(/\s+/g, ' ').slice(0, 60));
  }

  return empty;
}

// ── Job card scanning ────────────────────────────────────────────────────────

// Returns all job cards on the page (id + title + company)
function pjaGetAllCards() {
  const cards = Array.from(document.querySelectorAll(
    '.job-card-container, [data-job-id]'
  ));
  const seen = new Set();
  const out = [];
  for (const card of cards) {
    const link = card.querySelector('a[href*="/jobs/view/"]');
    const jobId = link?.href?.match(/\/jobs\/view\/(\d+)/)?.[1];
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    const title = card.querySelector('strong, .job-card-list__title')
      ?.textContent?.trim()
      || Array.from(card.querySelectorAll('[class*="title"]'))
           .find(el => !el.children.length)?.textContent?.trim()
      || 'Unknown';
    const company = card.querySelector(
      '[class*="primary-description"],[class*="subtitle"],[class*="company"]'
    )?.textContent?.trim() || '';
    out.push({ jobId, title, company, card });
  }
  return out;
}

// Reads the currently visible job detail panel for match indicators
function pjaReadDetailBadge() {
  const detailText = document.body?.innerText || '';
  if (/top applicant/i.test(detailText)) return 'Top Applicant';
  if (/strong match|great match|good match|high match|your fit/i.test(detailText)) return 'High Match';
  return null;
}

// Async deep scan: clicks each card, waits for detail panel, checks for badge
// onCardChecked(checked, total, title) — progress callback
async function pjaScanQualifyingJobsAsync(onCardChecked) {
  const allCards = pjaGetAllCards();
  const qualifying = [];

  for (let i = 0; i < allCards.length; i++) {
    const { jobId, title, company, card } = allCards[i];
    onCardChecked?.(i + 1, allCards.length, title);

    // Click the card link to load detail panel
    const link = card.querySelector('a[href*="/jobs/view/"]');
    link?.click();
    await pjaAutoWait(1800); // wait for detail panel

    const badge = pjaReadDetailBadge();
    if (badge) {
      qualifying.push({ jobId, title, company, badge });
    }
  }

  return qualifying;
}

// Keep the sync version as a quick check (uses card-level text only, less reliable)
function pjaScanQualifyingJobs() {
  return pjaGetAllCards().filter(({ card }) => {
    const t = card.textContent || '';
    return /top applicant|good match|strong match|great match|high match/i.test(t);
  }).map(({ jobId, title, company, card }) => {
    const t = card.textContent || '';
    const badge = /top applicant/i.test(t) ? 'Top Applicant' : 'High Match';
    return { jobId, title, company, badge };
  });
}

// ── Voluntary self-identification / EEO answer policy ────────────────────────
// Race, ethnicity, Hispanic/Latino, gender, veteran status, disability. These are
// VOLUNTARY — "decline to self-identify" is always a valid, honest answer. Where the
// user may have a banked factual answer that forms commonly require (gender,
// veteran=No, disability=No, Hispanic/Latino=No), prefer it; otherwise decline.
// Returns the matching item from `opts` (option elements OR {el,value,text} for radios),
// or null when `labelText` is not a self-ID question. Without this, self-ID selects have
// no "Yes" option so the Yes/No fallbacks skip them → the step stays empty → 'stuck'.
function pjaSelfIdPick(labelText, opts) {
  const L = String(labelText || '').toLowerCase();
  const isSelfId = /hispanic|latino|\brace\b|ethnic|\bgender\b|\bsex\b|veteran|disab|self.?identif|sexual orientation|transgender|gender identity/i.test(L);
  if (!isSelfId) return null;
  const hay = o => (String(o.text || '') + ' ' + String(o.value || '')).toLowerCase();
  const find = re => opts.find(o => re.test(hay(o)));
  const decline = () => find(/decline|don'?t wish|do not wish|prefer not|not to answer|wish not to|choose not|not disclose|not to disclose|not specified|rather not/);

  if (/hispanic|latino/.test(L)) {
    return find(/not hispanic|not latino/) || find(/\bno\b|^false$/) || decline();
  }
  if (/(\bgender\b|\bsex\b|gender identity)/.test(L) && !/transgender|orientation/.test(L)) {
    return find(/\bfemale\b|\bwoman\b/) || decline();
  }
  if (/veteran/.test(L)) {
    return find(/not a (protected )?veteran|\bi am not\b|not a veteran/) || find(/\bno\b|^false$/) || decline();
  }
  if (/disab/.test(L)) {
    return find(/no,? i (do not|don'?t)|do not have|don'?t have/) || find(/\bno\b|^false$/) || decline();
  }
  // General race / ethnicity → banked policy is decline; else honest factual (Asian).
  if (/\brace\b|ethnic/.test(L)) {
    return decline() || find(/asian/);
  }
  return decline();
}

// ── Fallback radio fill ──────────────────────────────────────────────────────
// For required radio groups that pjaFillForm couldn't match to profile/answers,
// apply sensible defaults based on the question text.

function pjaFillRequiredRadioFallback(profile) {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages

  for (const fs of root.querySelectorAll('fieldset')) {
    const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
    if (!radios.length) continue;
    if (radios.some(r => r.checked)) continue; // already answered

    const anyRequired = fs.getAttribute('aria-required') === 'true' ||
      radios.some(r => r.required || r.getAttribute('aria-required') === 'true');
    if (!anyRequired) continue;

    const legendText = (fs.querySelector('legend')?.textContent || '').toLowerCase();

    // Voluntary self-ID / EEO (race/ethnicity/Hispanic/gender/veteran/disability): answer
    // honestly from banked policy. MUST run before the Yes/No last-resort below, which would
    // otherwise wrongly pick "Yes" for "Are you Hispanic or Latino?".
    const sidRadioOpts = radios.map(r => ({
      el: r, value: r.value,
      text: (typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : (r.getAttribute('aria-label') || ''))
    }));
    const sidRadio = pjaSelfIdPick(legendText, sidRadioOpts);
    if (sidRadio) { pjaClickRadio(sidRadio.el); continue; }

    // Education-LEVEL pickers ("What is the highest level of education you have completed?") have
    // degree-level OPTIONS (High school/GED, Associate, Bachelor's, Master's, Doctorate) — NOT
    // Yes/No. The old /education/ → 'Yes' rule found no 'Yes' option and the group stayed empty →
    // 'stuck' (the Penumbra blocker). Pick the option matching the candidate's actual degree.
    if (/highest level of education|level of education|education.*(completed|attained|level)|degree.*completed/i.test(legendText)) {
      const deg = String((profile && profile.degree) || '').toLowerCase();
      const want = /phd|doctor/.test(deg) ? 'doctor' : /master/.test(deg) ? 'master'
        : /bachelor/.test(deg) ? 'bachelor' : /associate/.test(deg) ? 'associate' : 'bachelor';
      const opts = radios.map(r => ({ r, t: ((typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : (r.getAttribute('aria-label') || '')) + ' ' + (r.value || '')).toLowerCase() }));
      const pick = opts.find(o => o.t.includes(want))
        || opts.find(o => /bachelor/.test(o.t)) || opts.find(o => /associate/.test(o.t)) || opts.find(o => /\bdegree\b/.test(o.t));
      if (pick) { pjaClickRadio(pick.r); continue; }
    }

    let defaultVal = null;
    if (/certif|licens|accreditat|credential|qualification/i.test(legendText)) {
      defaultVal = 'Yes'; // generic fallback for required certification/qualification prompts
    } else if (/background check|drug test|drug screen/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/authorize|authorized|eligible|legally|legal right/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/relocat/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/sponsor/i.test(legendText)) {
      defaultVal = 'No';
    } else if (/referred by|employee referral|referral from|were you referred/i.test(legendText)) {
      defaultVal = 'No'; // not an employee referral
    } else if (/outside (business|employment|interest)|conflict(s)? of interest|moonlight|secondary employment/i.test(legendText)) {
      defaultVal = 'No'; // no outside business interests / conflicts
    } else if (/\bcitizen(ship)?\b/i.test(legendText)) {
      // "Are you a citizen of the country you'll be employed in?" — Canadian TN working in
      // the US → honest No. Compound "citizen or otherwise authorized" is caught by the
      // authorize branch ABOVE this one (order matters).
      defaultVal = 'No';
    } else if (/federal government|u\.s\.? government|government employee/i.test(legendText)) {
      defaultVal = 'No'; // never employed by the U.S. federal government
    } else if (/commut|onsite|on-site|on site|in.person|report to.*office|work.*office|hybrid/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/willing|able|available|comfortable|open to/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/experience.*suppli|suppli.*audit|audit.*suppli/i.test(legendText)) {
      defaultVal = 'Yes'; // Supplier auditing experience
    } else if (/experience.*quality|quality.*experience|quality.*background/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/bachelor|degree|diploma|education/i.test(legendText)) {
      defaultVal = 'Yes'; // generic fallback for required education/experience prompts
    } else if (/currently.*employ|actively.*look|full.time|part.time|intern/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/as9100|iso.*900|iatf|gmp|fda|21 cfr|medical device/i.test(legendText)) {
      defaultVal = 'Yes'; // Quality systems knowledge (quality background)
    }

    if (!defaultVal) {
      // Work authorization category radios (U.S. Citizen / Green Card / Temporary / Other)
      // If the user's profile maps to temporary employment authorization, choose that category.
      const labelsAndVals = radios.map(r => {
        const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : r.getAttribute('aria-label') || '').toLowerCase();
        return (r.value || '').toLowerCase() + ' ' + lbl;
      });
      const hasAuthCategory = labelsAndVals.some(t => /citizen|green card|permanent resident|temporary/i.test(t));
      if (hasAuthCategory && /authoriz|work permit|visa/i.test(legendText)) {
        // Find the Temporary Employment Authorization option
        const tempIdx = labelsAndVals.findIndex(t => /temporary|work permit|tn visa|tn\b/i.test(t));
        if (tempIdx !== -1) { pjaClickRadio(radios[tempIdx]); continue; }
      }
    }
    if (!defaultVal) {
      // Last resort: if radios are Yes/No, default Yes for unfilled required groups
      const vals = radios.map(r => r.value?.toLowerCase());
      if (vals.includes('yes') && vals.includes('no')) defaultVal = 'Yes';
    }
    if (!defaultVal) continue;

    // Match by value string, then by boolean (Greenhouse uses true/false), then by label text
    const dv = defaultVal.toLowerCase();
    const target = radios.find(r => r.value?.toLowerCase() === dv)
      || radios.find(r => r.value?.toLowerCase().startsWith(dv[0]))
      || (dv === 'yes' ? radios.find(r => r.value === 'true' || r.value === '1') : null)
      || (dv === 'no'  ? radios.find(r => r.value === 'false' || r.value === '0') : null)
      || radios.find(r => {
        const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : r.getAttribute('aria-label') || '').toLowerCase().trim();
        return lbl === dv || lbl.startsWith(dv[0]);
      });
    if (target) pjaClickRadio(target);
  }
}

// Fill required empty SELECT fields that have Yes/No options but weren't matched by pjaFillForm.
// LinkedIn uses fb-dash-form-element containers where the question text is a sibling div — now
// handled by pjaGetLabel, but this provides a final safety net.
function pjaFillRequiredSelectFallback() {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages

  for (const sel of root.querySelectorAll('select')) {
    const req = sel.required || sel.getAttribute('aria-required') === 'true';
    if (!req) continue;
    if (sel.value && sel.value !== 'Select an option' && sel.value !== '') continue;

    // Get label first (needed for both proficiency and yes/no routing)
    const labelText = (typeof pjaGetLabel === 'function' ? pjaGetLabel(sel) : '') || '';

    const opts = Array.from(sel.options);

    // Voluntary self-ID / EEO selects (race/ethnicity/Hispanic/gender/veteran/disability) have NO
    // Yes option, so the generic Yes/No path below skips them → the step stays empty → 'stuck'
    // (the Metrology Equipment Engineer blocker). Answer honestly from banked policy.
    const sidOpt = pjaSelfIdPick(labelText, opts);
    if (sidOpt) { pjaCommitSelect(sel, sidOpt.value); continue; }

    // Work authorization category selects (U.S. Citizen / Green Card / Temporary / Other)
    // If the user's profile maps to temporary employment authorization, choose that category.
    const hasAuthCategory = opts.some(o => /citizen|green card|permanent resident|temporary employment/i.test(o.text));
    if (hasAuthCategory && /authoriz|work permit|visa|basis/i.test(labelText)) {
      const tempOpt = opts.find(o => /temporary/i.test(o.text));
      if (tempOpt) { pjaCommitSelect(sel, tempOpt.value); continue; }
    }

    // Language proficiency selects (options: None/Basic/Intermediate/Advanced/Fluent/Native)
    const hasProficiencyOpts = opts.some(o => /\b(none|basic|intermediate|advanced|fluent|native|bilingual)\b/i.test(o.text));
    if (hasProficiencyOpts) {
      // English → Native; anything else → None
      const isEnglish = /\benglish\b/i.test(labelText);
      const targetText = isEnglish ? /native|bilingual|fluent/i : /^none$/i;
      const profTarget = opts.find(o => targetText.test(o.text.trim()));
      if (profTarget) { pjaCommitSelect(sel, profTarget.value); continue; }
    }

    // Must have Yes and No options for the rest
    const yesOpt = opts.find(o => /^yes$/i.test(o.text.trim()) || /^yes$/i.test(o.value.trim()));
    const noOpt  = opts.find(o => /^no$/i.test(o.text.trim())  || /^no$/i.test(o.value.trim()));
    if (!yesOpt) continue;

    let fillVal = 'Yes'; // safe default for most quality/experience questions
    if (/food.*mfg|regulated.*mfg|aseptic|sterile|diploma.*process|process.*cert|process.*oper/i.test(labelText)) {
      fillVal = 'No'; // specific pharma/food cert the candidate doesn't have
    } else if (/outside (business|employment|interest)|conflict(s)? of interest|moonlight|secondary employment/i.test(labelText)) {
      fillVal = 'No'; // no outside business interests / conflicts
    } else if (/citizen|green card|permanent resident/i.test(labelText)) {
      continue; // legal status must come from the user's profile/answer bank, not a default
    } else if (/passport|travel/i.test(labelText)) {
      fillVal = 'Yes'; // generic fallback for travel/passport availability prompts
    }

    const target = fillVal === 'Yes' ? yesOpt : noOpt;
    if (target) pjaCommitSelect(sel, target.value);
  }
}

// Auto-check consent/acknowledgment checkboxes (e.g. "I understand that AI tools may be used")
function pjaAutoCheckConsent() {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages
  for (const cb of root.querySelectorAll('input[type=checkbox]')) {
    if (cb.checked) continue;
    const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(cb) : '')
      || cb.getAttribute('aria-label')
      || cb.closest('label')?.textContent?.toLowerCase()
      || '';
    const cbIdent = [cb.id, cb.name, cb.getAttribute('data-testid'), cb.getAttribute('aria-describedby')]
      .filter(Boolean).join(' ');
    if (/gdpr_demographic_data_consent_given|demographic.*consent|gdpr.*consent/i.test(cbIdent) ||
        /^\s*(acknowledge(?:\/confirm)?|confirm|agree|consent|certify)\b|\bi (understand|acknowledge|agree|accept|confirm|consent|certify|attest|authorize)\b|i have read|certify that|to the best of my knowledge|terms and conditions|privacy policy|eeo|equal opportunity|background check consent|data.*(processing|privacy)|gdpr|ai tool|automated/i.test(lbl)) {
      // Setting checked=true and then dispatching/calling click toggles the box BACK off. Let the
      // real click activation perform the state transition first; only use the native setter if a
      // controlled widget rejected it.
      cb.click();
      if (!cb.checked) {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
        if (desc?.set) desc.set.call(cb, true); else cb.checked = true;
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
}

// Fill required comboboxes (role=combobox) that are still empty after all other passes.
// Handles Yes/No questions and number-of-years questions that fall through pjaFillForm
// because they are type=number or unlabeled comboboxes.
function pjaFillRequiredComboboxFallback(profile, answers) {
  const visible = el => !!el.offsetParent;
  // SCOPE to the Easy Apply modal — scanning document-wide previously filled LinkedIn's own
  // search bar (jobs-search-box-keyword/location), which triggers a search and CLOSES the modal
  // mid-flow (root cause of false unknown_buttons/modal_closed). On non-EA (Greenhouse) callers
  // there's no modal, so fall back to document.
  const _m = (typeof pjaGetCurrentModal === 'function') ? pjaGetCurrentModal() : null;
  const scope = _m ? ((_m.root.querySelector && _m.root.querySelector('[role="dialog"]')) || _m.root) : document;
  // Include ALL visible empty role=combobox inputs (not just [required] ones) — Greenhouse/Lever
  // often mark required on a wrapper, not the input. Filling is still gated below by label
  // patterns / answer-bank, so unmatched comboboxes (country, "how did you hear") are left alone.
  const combos = Array.from(scope.querySelectorAll(
    'input[role=combobox], input[required][list], input[aria-required="true"][list]'
  )).filter(el => visible(el) && !(el.value && el.value.trim())
    && !/^jobs-search-box/.test(el.id || '')); // never touch the page search bar

  for (const el of combos) {
    // Education dropdowns (School/Degree/Discipline) are handled by pjaFillGreenhouseEducation
    // with the actual profile values. Skip them here so the Yes/No pattern below doesn't
    // wrongly stuff "Yes" into the Degree field (the /degree/ pattern matched "Degree*").
    if (/^(school|degree|discipline)(--\d+)?$/.test(el.id || '')) continue;
    const rawLabel = (typeof pjaGetLabel === 'function' ? pjaGetLabel(el) : '') || el.getAttribute('aria-label') || '';
    if (!rawLabel) continue;
    if (/^(school|degree|discipline)\s*\*?$/i.test(rawLabel.trim())) continue;
    const isWorkdayPhoneCode = /workday\.com|myworkdayjobs\.com/i.test(location.hostname) &&
      /(?:country|territory).{0,60}phone.{0,30}code|phone.{0,30}(?:country|territory).{0,30}code|dial(?:ing|ling) code/i.test(rawLabel);
    if (isWorkdayPhoneCode &&
        /(?:country\s*(?:\/\s*territory)?\s*)?phone\s*code\*?.{0,120}united states(?: of america)?\s*\(\+?1\)/i
          .test((document.body?.innerText || '').replace(/\s+/g, ' '))) {
      try { if (typeof pjaRDbg === 'function') pjaRDbg('[WD] required-combobox skip phone code visible US'); } catch (_) {}
      continue;
    }
    const norm = (typeof pjaNormalizeLabel === 'function') ? pjaNormalizeLabel(rawLabel) : rawLabel.toLowerCase();

    // Try answer bank first (short answers only — long sentences won't match combobox options)
    if (typeof pjaFindBestAnswer === 'function') {
      const banked = pjaFindBestAnswer(norm, answers);
      if (banked && banked.length <= 20) {
        if (typeof pjaFillCombobox === 'function') pjaFillCombobox(el, banked,
          isWorkdayPhoneCode ? 'phoneCountryCode' : undefined);
        continue;
      }
    }

    // Pattern-based Yes/No for common questions
    let val = null;
    if (/sponsor/i.test(rawLabel)) val = 'No';
    else if (/authoriz|eligible|legally|legal right|work.*permit/i.test(rawLabel)) val = 'Yes';
    else if (/onsite|on-site|in.person|commut|report.*office|hybrid/i.test(rawLabel)) val = 'Yes';
    else if (/willing|able|available|comfortable|open to|travel/i.test(rawLabel)) val = 'Yes';
    else if (/background check|drug test/i.test(rawLabel)) val = 'Yes';
    else if (/reloca/i.test(rawLabel)) val = 'Yes';
    else if (/certif|licens|degree|bachelor|diploma/i.test(rawLabel)) val = 'Yes';
    else if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application|\bsource\b/i.test(rawLabel)) val = 'LinkedIn';
    else if (isWorkdayPhoneCode) val = (profile && profile.phoneCountryCode) || 'United States of America (+1)';
    else if (/years.*experience|experience.*years/i.test(rawLabel)) {
      val = (profile && profile.yearsExperience) ? String(profile.yearsExperience) : '6';
    }

    if (val && typeof pjaFillCombobox === 'function') pjaFillCombobox(el, val,
      isWorkdayPhoneCode ? 'phoneCountryCode'
        : /how did you hear|where did you (hear|find)|referral source|source of (this )?application|\bsource\b/i.test(rawLabel) ? 'referralSource'
        : undefined);
  }
}

// ── Single-job apply ─────────────────────────────────────────────────────────

async function pjaAutoApplyOne(job, profile, answers, onStatus) {
  const { jobId, title } = job;

  // Select the card
  onStatus(`Selecting: ${title}…`);
  const link = document.querySelector(`a[href*="/jobs/view/${jobId}"]`);
  if (!link) return { success: false, reason: 'card_not_found' };
  link.click();
  await pjaAutoWait(2000);

  // Find & click Easy Apply
  const applyBtn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.trim().endsWith('Easy Apply') &&
               b.className?.includes('jobs-apply-button'));
  if (!applyBtn) return { success: false, reason: 'no_easy_apply' };
  applyBtn.click();
  await pjaAutoWait(1500);

  // Step through the modal
  const MAX_STEPS = 15;
  let prevStepFingerprint = null;
  let sameStepCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };

    const modal = pjaGetCurrentModal();
    if (!modal) return { success: false, reason: 'modal_closed' };

    // Mid-refresh double-submit guard (same as pjaApplyOnCurrentPage).
    const eaSt = pjaEasyApplyState(modal);
    if (eaSt.success) { pjaDismissModal(); return { success: true, reason: 'applied_resumed' }; }

    const heading = pjaModalHeading() || `Step ${step + 1}`;
    onStatus(`${title}: ${heading}…`);

    // Detect stuck only when the same value-free step identity remains after advance attempts.
    const stepFingerprint = pjaEasyApplyStepFingerprint();
    if (stepFingerprint && stepFingerprint === prevStepFingerprint) {
      sameStepCount++;
      if (sameStepCount >= 2) {
        const emptyFields = pjaEmptyRequiredFields();
        const diag = await pjaRecordEasyApplyStepDiagnostics('same-step-stuck', heading,
          { sameStepCount, stepFingerprint: stepFingerprint.slice(0, 1200) });
        pjaDismissModal();
        return {
          success: false,
          reason: 'stuck',
          heading,
          fields: emptyFields,
          diagnostic: pjaEasyApplyResultDiagnostic(diag, 'stuck')
        };
      }
    } else {
      sameStepCount = 0;
    }
    prevStepFingerprint = stepFingerprint;

    // Skip resume step — just click Next
    const isResumeStep = /resume/i.test(heading);

    if (!isResumeStep) {
      // Run autofill
      pjaFillForm(profile, answers);
      await pjaAutoWait(600);
      // Fallback pass: fill any required radio groups / comboboxes autofill missed
      pjaFillRequiredRadioFallback(profile);
      if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
      // Auto-check consent/acknowledgment checkboxes
      pjaAutoCheckConsent();
      // Reuse the SAME AI answerer used by external-apply, scoped to this modal, for screening
      // questions (years, work-auth, US-person, education, checkbox-groups, etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') {
        const m2 = pjaGetCurrentModal();
        if (m2) { try { await window.pjaAnswerRequiredViaAI(job, m2.root); } catch (_) {} await pjaAutoWait(700); }
      }
    }

    const btns = pjaModalBtns();

    if (btns.includes('Submit application')) {
      const clicked = await pjaTrustedClickInModal('Submit application');
      if (!clicked) { pjaDismissModal(); return { success: false, reason: 'trusted_click_failed', heading, action: 'Submit application' }; }
      const confirmed = await pjaWaitForEasyApplyConfirmation();
      // Dismiss LinkedIn's post-apply dialog only after explicit confirmation.
      const notNow = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Not now');
      if (confirmed && notNow) {
        notNow.click();
        await pjaAutoWait(500);
      } else if (!confirmed) {
        const stillOpen = pjaGetCurrentModal();
        if (stillOpen) {
          const submitErr = pjaLinkedInSubmitErrors();
          const emptyFields = submitErr.requiredEmpty;
          if (emptyFields.length) { pjaDismissModal(); return { success: false, reason: 'submit_blocked', fields: emptyFields }; }
          if (submitErr.visibleError) { await pjaRecordSubmitUnclearDiagnostics('legacy-submit-visible-error'); pjaDismissModal(); return { success: false, reason: 'submit_blocked' }; }
        } else {
          await pjaRecordSubmitUnclearDiagnostics('legacy-submit-modal-closed');
          return { success: true, reason: 'linkedin_submit_modal_closed' };
        }
        await pjaRecordSubmitUnclearDiagnostics('legacy-submit_unconfirmed');
        return { success: false, reason: 'submit_unconfirmed' };
      }
      pjaDismissModal();
      return { success: true, reason: 'linkedin_confirmation' };
    }

    // Check for unfillable required fields before advancing
    if (!isResumeStep) {
      const emptyFields = pjaEmptyRequiredFields();
      if (emptyFields.length) {
        pjaDismissModal();
        return { success: false, reason: 'missing_required', fields: emptyFields };
      }
    }

    const advanceLabel = btns.includes('Review') ? 'Review'
      : btns.includes('Next') ? 'Next'
      : btns.includes('Continue to next step') ? 'Continue to next step'
      : null;
    if (!advanceLabel) {
      pjaDismissModal();
      return { success: false, reason: 'unknown_buttons', btns };
    }
    if (!await pjaTrustedClickInModal(advanceLabel, sameStepCount === 1 ? 'keyboard' : 'mouse')) {
      const diag = await pjaRecordEasyApplyStepDiagnostics('trusted-activation-failed', heading,
        { action: advanceLabel, activation: sameStepCount === 1 ? 'keyboard' : 'mouse' });
      pjaDismissModal();
      return { success: false, reason: 'trusted_click_failed', heading, action: advanceLabel,
        diagnostic: pjaEasyApplyResultDiagnostic(diag, 'trusted_click_failed') };
    }

    await pjaAutoWait(1200);
  }

  pjaDismissModal();
  return { success: false, reason: 'too_many_steps' };
}

// ── Batch apply ──────────────────────────────────────────────────────────────

async function pjaAutoApplyBatch(jobs, profile, answers, onProgress, onDone) {
  PJA_AUTO_STATE.running = true;
  PJA_AUTO_STATE.aborted = false;

  const results = { applied: [], skipped: [], errors: [] };

  for (let i = 0; i < jobs.length; i++) {
    if (PJA_AUTO_STATE.aborted) break;

    const job = jobs[i];
    onProgress({ current: i + 1, total: jobs.length, jobTitle: job.title, results });

    try {
      const result = await pjaAutoApplyOne(
        job, profile, answers,
        msg => onProgress({
          current: i + 1, total: jobs.length,
          jobTitle: job.title, status: msg, results
        })
      );

      if (result.success) {
        results.applied.push(job);
        // Save to pipeline as Applied
        chrome.runtime.sendMessage({
          type: 'SAVE_JOB',
          payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title,
            company: job.company,
            description: '',
            status: 'Applied',
            savedAt: Date.now(),
            statusUpdatedAt: Date.now(),
            reminderDismissed: false
          }
        });
      } else if (result.reason === 'aborted') {
        break;
      } else {
        const skipReason = result.fields?.length
          ? `Missing: ${result.fields.slice(0, 2).join(', ')}`
          : result.reason;
        const skippedJob = { ...job, skipReason, missingFields: result.fields || [] };
        results.skipped.push(skippedJob);
        // Save to pipeline as Needs Info so the user can review and retry
        chrome.runtime.sendMessage({
          type: 'SAVE_JOB',
          payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title,
            company: job.company,
            description: result.fields?.length
              ? 'Missing required fields: ' + result.fields.join('; ')
              : 'Skip reason: ' + result.reason,
            missingFields: result.fields || [],
            skipReason,
            status: 'Needs Info',
            savedAt: Date.now(),
            statusUpdatedAt: Date.now(),
            reminderDismissed: false
          }
        });
      }
    } catch (err) {
      results.errors.push({ ...job, error: err.message });
    }

    // Rate-limit between jobs (3–5s)
    if (i < jobs.length - 1 && !PJA_AUTO_STATE.aborted) {
      await pjaAutoWait(3000 + Math.random() * 2000);
    }
  }

  PJA_AUTO_STATE.running = false;
  onDone(results);
}

// Click the Easy Apply control. For an <a href=".../apply"> we block the default link
// navigation so ONLY LinkedIn's SPA click-handler runs (opens the modal in-place). If
// the handler isn't attached yet, the click is a harmless no-op (we retry) rather than
// navigating to a cold /apply/ page that bounces back into a reload loop. A <button>
// has no navigation, so we just click it.
function pjaClickEasyApply(el) {
  if (el.tagName === 'A') {
    const blockNav = (e) => { e.preventDefault(); };
    el.addEventListener('click', blockNav, { capture: true });
    try { el.click(); } finally {
      setTimeout(() => el.removeEventListener('click', blockNav, { capture: true }), 0);
    }
  } else {
    el.click();
  }
}

// TRUSTED open click. Current LinkedIn's anti-automation gate ignores a synthetic .click() on the
// Easy Apply <button>, so the AUTO-open path must use the SAME trusted CDP click that Next/Review/
// Submit already use (LINKEDIN_TRUSTED_CLICK → background cdpLinkedInClick at viewport coords).
// Anchors keep the nav-blocking synthetic path (a trusted click would follow the href). Falls back
// to synthetic on CDP timeout/error so a free-CDP tab still degrades gracefully.
function pjaTrustedClickEl(el) {
  if (!el) return Promise.resolve(false);
  if (el.tagName === 'A') { try { pjaClickEasyApply(el); } catch (_) {} return Promise.resolve(true); }
  try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
  try { el.focus({ preventScroll: true }); } catch (_) {}
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) { try { pjaClickEasyApply(el); } catch (_) {} return Promise.resolve(true); }
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return new Promise(resolve => {
    let done = false;
    // Keyboard activation: current LinkedIn no-ops a synthetic/trusted MOUSE click on the Easy Apply
    // button, but a trusted Enter dispatched to the FOCUSED button often still fires its handler
    // (buttons activate on Enter). Fire it alongside the click for the best chance to open the modal.
    const kbd = () => { try { el.focus({ preventScroll: true }); } catch (_) {} try { chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_ENTER' }, () => { void chrome.runtime.lastError; }); } catch (_) {} };
    const finish = () => { if (done) return; done = true; kbd(); resolve(true); };
    const t = setTimeout(() => {
      if (done) return;
      // If the modal already opened, do not fire a late fallback click. Late fallback clicks
      // can hit the underlying job page while the current modal is being filled, creating
      // overlapping open loops and detached-debugger noise.
      if (pjaGetCurrentModal()) { pjaTrace('EA-open CDP timeout ignored; modal already open'); finish(); return; }
      pjaTrace('EA-open CDP timeout→synthetic');
      try { pjaClickEasyApply(el); } catch (_) {}
      finish();
    }, 4000);
    try {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x, y }, (resp) => {
        if (done) return;
        clearTimeout(t);
        if (chrome.runtime.lastError || resp?.error) { pjaTrace('EA-open CDP fail→synthetic err=' + (resp?.error || chrome.runtime.lastError?.message || '')); try { pjaClickEasyApply(el); } catch (_) {} }
        else { pjaTrace('EA-open CDP click ok'); }
        finish();
      });
    } catch (_) { clearTimeout(t); finish(); }
  });
}

// ── Apply on current job-view page ───────────────────────────────────────────
// Used by the navigate-per-job batch flow. Assumes we are already on
// linkedin.com/jobs/view/{id}/ — no card click needed.

function pjaTrace(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' [EA] ' + msg;
  // 1) sessionStorage (fast, survives same-origin reloads)
  try {
    const arr = JSON.parse(sessionStorage.getItem('pja_ea_trace') || '[]');
    arr.push(line);
    sessionStorage.setItem('pja_ea_trace', JSON.stringify(arr.slice(-40)));
  } catch (_) {}
  // 2) chrome.storage pja_dbg (durable; readable via dev server /get-storage curl even
  //    after console clears or DOM-read is blocked). This is the channel I review on failure.
  try {
    chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-40);
      arr.push(line);
      chrome.storage.local.set({ pja_dbg: arr });
    });
  } catch (_) {}
}

function pjaFindEasyApplyBtn() {
  const visibleEnabled = el => !!(el && el.offsetParent !== null && !el.disabled &&
    String(el.getAttribute && el.getAttribute('aria-disabled') || '').toLowerCase() !== 'true');
  const inSearchCard = el => !!(el && el.closest && el.closest(
    '[componentkey^="job-card-component-ref-"], [data-occludable-job-id], li.jobs-search-results__list-item'));
  const clickable = el => el && el.closest ? el.closest('button, a, [role="button"]') : null;
  const candidates = [];
  const seen = new Set();
  const add = (raw, rank) => {
    const el = raw && raw.matches && raw.matches('button, a, [role="button"]') ? raw : clickable(raw);
    if (!visibleEnabled(el) || inSearchCard(el) || seen.has(el)) return;
    seen.add(el);
    const label = String(el.getAttribute('aria-label') || el.textContent || '').trim();
    if (!/^easy apply(?:\b| to)/i.test(label) &&
        !/\/jobs\/view\/[^/?]+\/apply\//i.test(el.getAttribute('href') || '')) return;
    candidates.push({ el, rank });
  };

  // Prefer contracts on the selected-job detail panel before generic text. The results list also
  // contains “Easy Apply” badges, so generic candidates inside a job card are always excluded.
  document.querySelectorAll('.jobs-apply-button').forEach(el => add(el, 100));
  document.querySelectorAll('[data-view-name="job-apply-button"]').forEach(el => add(el, 95));
  document.querySelectorAll('[aria-label^="Easy Apply to this job" i]').forEach(el => add(el, 90));
  document.querySelectorAll('a[href*="/jobs/view/"][href*="/apply/"]').forEach(el => add(el, 85));
  document.querySelectorAll('button, a, [role="button"]').forEach(el => add(el, 50));
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates[0] ? candidates[0].el : null;
}

async function pjaApplyOnCurrentPage(job, profile, answers, onStatus) {
  // Per-job runs (queue path) never reset this; a stale true from a prior aborted run
  // would make every subsequent job return 'aborted'. Reset defensively.
  PJA_AUTO_STATE.aborted = false;
  const { title } = job;
  pjaTrace('run-start v2 path=' + location.pathname.slice(-30));
  onStatus(`${title}: looking for Easy Apply…`);
  await pjaAutoWait(2000);

  // Skip if already applied
  if (/applied \d+ (second|minute|hour|day|week|month)/i.test(document.body?.innerText || '')) {
    return { success: false, reason: 'already_applied' };
  }

  // If the modal is already rendered (for example after a LinkedIn SPA apply route), the open
  // step below is skipped. Otherwise the detail-panel finder handles both anchor and button UIs.
  // Detect "already applied" up front (regardless of open mode).
  if (!pjaGetCurrentModal()) {
    const presentBtn = pjaFindEasyApplyBtn();
    if (!presentBtn) {
      const anyApplyEl = document.querySelector('.jobs-apply-button')
        || Array.from(document.querySelectorAll('button, a, span')).find(el => /^easy apply$/i.test((el.textContent||'').trim()));
      if (anyApplyEl?.disabled) return { success: false, reason: 'already_applied' };
      if (/\bapplied\b/i.test(document.body?.innerText || '') && !Array.from(document.querySelectorAll('span')).some(el => /^easy apply$/i.test((el.textContent||'').trim()))) {
        return { success: false, reason: 'already_applied' };
      }
    }
  }

  // OPEN the modal. Two modes:
  //  - AUTO  (PJA_EA_AUTO_OPEN=true):  extension clicks Easy Apply itself, then assists.
  //  - SEMI  (PJA_EA_AUTO_OPEN=false): extension NEVER clicks — it waits for the user to
  //    click "Easy Apply" (reliable, no anti-automation gate, no nav/reload risk), then
  //    takes over to fill + step through. This is the dependable path on current LinkedIn.
  let initModal = pjaGetCurrentModal();
  if (!initModal && PJA_EA_AUTO_OPEN) {
    let applyBtn = null;
    for (let attempt = 0; attempt < 30 && !applyBtn; attempt++) {
      applyBtn = pjaFindEasyApplyBtn();
      if (!applyBtn) await pjaAutoWait(600);
    }
    if (applyBtn) await pjaTrustedClickEl(applyBtn);
    for (let w = 0; w < 12 && !initModal; w++) { await pjaAutoWait(800); initModal = pjaGetCurrentModal(); }
  }
  const autoOpened = !!initModal;

  // Wait for the user (SEMI) — or as a fallback when AUTO open was ignored.
  if (!initModal) {
    onStatus(`👆 Click "Easy Apply" for "${title}" — I'll auto-fill the rest`);
    // AUTO mode is unattended (backend-triggered): nobody will click for us, so 5 min of
    // silent retrying is 5 dead minutes per job (the "idle run" failure). Cap it at 90s
    // and trace periodically so a stuck open is visible in pja_dbg. SEMI keeps the full
    // window — a human really may take minutes.
    const assistMs = PJA_EA_AUTO_OPEN ? Math.min(PJA_EA_ASSIST_TIMEOUT_MS, 90000) : PJA_EA_ASSIST_TIMEOUT_MS;
    const deadline = Date.now() + assistMs;
    let lastTrace = 0;
    while (Date.now() < deadline && !initModal) {
      if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };
      // In AUTO mode keep retrying our own click; in SEMI mode just watch for the user.
      let btnSeen = false;
      if (PJA_EA_AUTO_OPEN) {
        initModal = pjaGetCurrentModal();
        if (initModal) break;
        const btn = pjaFindEasyApplyBtn();
        btnSeen = !!btn;
        if (btn) { try { await pjaTrustedClickEl(btn); } catch (_) {} }
      }
      if (Date.now() - lastTrace > 30000) {
        lastTrace = Date.now();
        pjaTrace('open-retry: modal not open, btn=' + btnSeen + ', ' + Math.round((deadline - Date.now()) / 1000) + 's left');
      }
      await pjaAutoWait(1000);
      initModal = pjaGetCurrentModal();
    }
  }

  pjaTrace('open mode=' + (PJA_EA_AUTO_OPEN ? 'AUTO' : 'SEMI') + ' modalOpen=' + !!initModal + ' autoOpened=' + autoOpened);
  if (!initModal) { pjaTrace('result=no_easy_apply (modal never opened)'); return { success: false, reason: 'no_easy_apply' }; }

  // LinkedIn DAILY Easy Apply submission cap — once hit, every job shows the limit notice (no
  // Submit). Stop the whole queue (halt) and surface it; hammering won't help and risks the account.
  if (/limit(ed)?\s+daily submission|daily submission limit|apply tomorrow|reached your (daily )?limit|save this job and apply tomorrow/i.test(document.body?.innerText || '')) {
    pjaTrace('result=daily_limit (LinkedIn Easy Apply daily cap reached)');
    pjaDismissModal();
    return { success: false, reason: 'daily_limit', halt: true };
  }

  // TEST MODE — stop here so nothing is filled or submitted. Reports HOW the modal opened.
  if (PJA_EA_DRY_RUN) {
    onStatus(`✓ Modal opened (${autoOpened ? 'AUTOMATICALLY' : 'after assist'}) — dry run, not submitting`);
    return { success: false, reason: 'dry_run_modal_opened', autoOpened };
  }

  const MAX_STEPS = 15;
  let prevStepFingerprint = null;
  let sameStepCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };

    const modal = pjaGetCurrentModal();
    if (!modal) return { success: false, reason: 'modal_closed' };

    // Mid-refresh double-submit guard: if the modal reloaded into a post-submit confirmation,
    // record success WITHOUT clicking Submit again.
    const eaState = pjaEasyApplyState(modal);
    if (eaState.success) { pjaTrace('resume: success state detected, not re-submitting'); pjaDismissModal(); return { success: true, reason: 'applied_resumed' }; }

    const heading = pjaModalHeading() || `Step ${step + 1}`;
    pjaTrace('step' + step + ' heading=' + heading.slice(0, 25));
    onStatus(`${title}: ${heading}…`);

    const stepFingerprint = pjaEasyApplyStepFingerprint();
    if (stepFingerprint && stepFingerprint === prevStepFingerprint) {
      sameStepCount++;
      if (sameStepCount >= 2) {
        const emptyFields = pjaEmptyRequiredFields();
        const diag = await pjaRecordEasyApplyStepDiagnostics('same-step-stuck', heading,
          { sameStepCount, stepFingerprint: stepFingerprint.slice(0, 1200) });
        pjaDismissModal();
        return { success: false, reason: 'stuck', heading, fields: emptyFields,
          diagnostic: pjaEasyApplyResultDiagnostic(diag, 'stuck') };
      }
    } else {
      sameStepCount = 0;
    }
    prevStepFingerprint = stepFingerprint;

    const isResumeStep = /resume/i.test(heading);
    if (!isResumeStep) {
      pjaFillForm(profile, answers);
      await pjaAutoWait(600);
      pjaFillRequiredRadioFallback(profile);
      pjaFillRequiredSelectFallback();
      if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
      pjaAutoCheckConsent();
      // Reuse the SAME AI answerer used by external-apply, scoped to this modal, for screening
      // questions (years, work-auth, US-person, education, checkbox-groups, etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') {
        const m2 = pjaGetCurrentModal();
        if (m2) { try { await window.pjaAnswerRequiredViaAI(job, m2.root); } catch (_) {} await pjaAutoWait(700); }
      }
    }

    // The modal footer (Next/Review/Submit) can mount a beat after the step body renders, so a
    // single read sometimes sees zero buttons → false 'unknown_buttons'. Retry until they appear.
    let btns = pjaModalBtns();
    for (let r = 0; r < 6 && btns.length === 0; r++) { await pjaAutoWait(800); btns = pjaModalBtns(); }
    pjaTrace('step' + step + ' resume=' + isResumeStep + ' btns=' + btns.join(',').slice(0, 40));
    if (btns.length === 0) {
      // DIAGNOSTIC → dedicated race-free key (pja_dbg writes race under rapid tracing). Capture
      // what the page actually contains so we can fix the collector precisely.
      try {
        const dm = pjaGetCurrentModal();
        const sc = dm ? (dm.root.querySelector && dm.root.querySelector('[role="dialog"]')) || dm.root : null;
        const txt = el => (el.textContent || '').trim().slice(0, 30);
        const cnt = (root, sel) => { try { return root && root.querySelectorAll ? root.querySelectorAll(sel).length : -1; } catch (_) { return -2; } };
        const sample = (root, sel) => { try { return root && root.querySelectorAll ? Array.from(root.querySelectorAll(sel)).map(txt).filter(Boolean).slice(0, 8) : []; } catch (_) { return []; } };
        const diag = {
          ts: Date.now(), heading,
          modal: dm ? { isShadow: dm.isShadow, rootTag: dm.root.tagName || dm.root.nodeName || '?', rootClass: (dm.root.className || '').slice(0, 60) } : null,
          scopeBtn: cnt(sc, 'button'), scopeRoleBtn: cnt(sc, '[role="button"]'), scopeA: cnt(sc, 'a'),
          scopeBtnTexts: sample(sc, 'button'), scopeRoleBtnTexts: sample(sc, '[role="button"],a'),
          docModal: cnt(document, '.jobs-easy-apply-modal'), docDialog: cnt(document, '[role="dialog"]'),
          docDialogBtns: sample(document, '[role="dialog"] button'),
          docFooterBtns: sample(document, 'footer button, .artdeco-modal__actionbar button, [data-test-modal-actionbar] button'),
        };
        chrome.storage.local.set({ pja_ea_diag: diag });
      } catch (_) {}
    }

    if (btns.includes('Submit application')) {
      // Verification gate: stop with the completed form on screen so the user can
      // review before anything is sent. Flip PJA_EA_STOP_BEFORE_SUBMIT=false to submit.
      if (PJA_EA_STOP_BEFORE_SUBMIT) {
        pjaTrace('result=ready_to_submit (stop-before-submit gate)');
        onStatus(`✓ "${title}" ready to submit — review on screen, then submit manually`);
        return { success: false, reason: 'ready_to_submit' };
      }
      pjaTrace('clicking Submit application');
      if (!await pjaTrustedClickInModal('Submit application')) {
        const diag = await pjaRecordEasyApplyStepDiagnostics('trusted-click-failed', heading, { action: 'Submit application' });
        pjaDismissModal();
        return { success: false, reason: 'trusted_click_failed', heading, action: 'Submit application',
          diagnostic: pjaEasyApplyResultDiagnostic(diag, 'trusted_click_failed') };
      }
      const confirmed = await pjaWaitForEasyApplyConfirmation();
      // Dismiss post-apply dialog only after explicit confirmation.
      const notNow = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Not now');
      if (confirmed && notNow) {
        notNow.click();
        await pjaAutoWait(500);
      } else if (!confirmed) {
        const stillOpen = pjaGetCurrentModal();
        if (stillOpen) {
          const submitErr = pjaLinkedInSubmitErrors();
          const emptyFields = submitErr.requiredEmpty;
          if (emptyFields.length) { pjaDismissModal(); return { success: false, reason: 'submit_blocked', fields: emptyFields }; }
          if (submitErr.visibleError) { await pjaRecordSubmitUnclearDiagnostics('submit-visible-error'); pjaDismissModal(); return { success: false, reason: 'submit_blocked' }; }
        } else {
          await pjaRecordSubmitUnclearDiagnostics('submit-modal-closed');
          return { success: true, reason: 'linkedin_submit_modal_closed' };
        }
        await pjaRecordSubmitUnclearDiagnostics('submit_unconfirmed');
        return { success: false, reason: 'submit_unconfirmed' };
      }
      pjaDismissModal();
      return { success: true, reason: 'linkedin_confirmation' };
    }

    if (!isResumeStep) {
      // Use the shared collector (proper react-select/checkbox value detection) so we don't
      // false-bail on fields the AI just filled.
      const mNow = pjaGetCurrentModal();
      const emptyFields = (typeof window.pjaCollectRequiredEmptyFields === 'function' && mNow)
        ? window.pjaCollectRequiredEmptyFields(mNow.root).map(f => f.label)
        : pjaEmptyRequiredFields();
      if (emptyFields.length) {
        pjaTrace('result=missing_required step' + step + ' fields=' + emptyFields.join('|').slice(0, 80));
        pjaDismissModal();
        return { success: false, reason: 'missing_required', fields: emptyFields };
      }
    }

    // Step-advance clicks MUST be trusted (CDP) — LinkedIn rejects synthetic clicks on
    // Next/Review and reloads the page, killing the flow mid-step (the "mid-refresh" issue).
    const advanceLabel = btns.includes('Review') ? 'Review'
      : btns.includes('Next') ? 'Next'
      : btns.includes('Continue to next step') ? 'Continue to next step'
      : null;
    if (!advanceLabel) { pjaTrace('result=unknown_buttons btns=' + btns.join(',').slice(0,40)); pjaDismissModal(); return { success: false, reason: 'unknown_buttons', btns }; }
    const activation = sameStepCount === 1 ? 'keyboard' : 'mouse';
    if (activation === 'keyboard') pjaTrace('same-step recovery: trusted keyboard ' + advanceLabel);
    if (!await pjaTrustedClickInModal(advanceLabel, activation)) {
      pjaTrace('result=trusted_click_failed action=' + advanceLabel + ' activation=' + activation);
      const diag = await pjaRecordEasyApplyStepDiagnostics('trusted-activation-failed', heading, { action: advanceLabel, activation });
      pjaDismissModal();
      return { success: false, reason: 'trusted_click_failed', heading, action: advanceLabel,
        diagnostic: pjaEasyApplyResultDiagnostic(diag, 'trusted_click_failed') };
    }

    await pjaAutoWait(1200);
  }

  pjaTrace('result=too_many_steps');
  pjaDismissModal();
  return { success: false, reason: 'too_many_steps' };
}

// ── External Apply (non-Easy-Apply) ──────────────────────────────────────────
// Extracts the external ATS URL from the LinkedIn Apply button, stores job info
// in chrome.storage.local, then navigates the current tab to the ATS page.
// external-apply.js picks it up there and handles form filling + submission.
async function pjaExternalApplyOnCurrentPage(job, profile, answers, onStatus) {
  const { title } = job;

  // Direct ATS queue: applyUrl is pre-set, skip LinkedIn Apply-button discovery
  if (job.applyUrl) {
    onStatus(`${title}: navigating to application…`);
    const returnUrl = location.href;
    await new Promise(resolve => chrome.runtime.sendMessage({
      type: 'SET_EXT_CURRENT',
      payload: { ...job, profile, answers, returnUrl }
    }, resolve));
    setTimeout(() => { window.location.href = job.applyUrl; }, 500);
    return { success: false, reason: 'navigating_to_ats', pending: true };
  }

  onStatus(`${title}: looking for Apply button…`);
  await pjaAutoWait(3000);

  // Skip if already applied (disabled button present with no external link)
  const anyBtn = document.querySelector('.jobs-apply-button');
  if (anyBtn?.disabled) return { success: false, reason: 'already_applied' };

  // --- Check for <a> Apply link first (used on /jobs/view/ pages) ---
  // LinkedIn wraps external URLs in a safety redirect: /safety/go/?url=<encoded>
  let capturedUrl = null;

  function extractLinkedInSafetyUrl(href) {
    try {
      const u = new URL(href);
      const target = u.searchParams.get('url');
      if (target) return decodeURIComponent(target);
    } catch(e) {}
    return href;
  }

  for (let i = 0; i < 8; i++) {
    // Look for <a> tags with "Apply" text (not Easy Apply)
    const applyLinks = Array.from(document.querySelectorAll('a'))
      .filter(a => /^apply$/i.test(a.textContent.trim()) && a.href && a.href.length > 4);
    for (const a of applyLinks) {
      const url = extractLinkedInSafetyUrl(a.href);
      if (url && !url.includes('linkedin.com')) { capturedUrl = url; break; }
    }
    if (capturedUrl) break;

    // Also look for button Apply (not Easy Apply) — intercept window.open when clicked
    const btns = Array.from(document.querySelectorAll('.jobs-apply-button, button[data-job-id], button'))
      .filter(b => !b.disabled && /^apply$/i.test(b.textContent.trim()));
    if (btns.length) {
      const origOpen = window.open;
      const openCapture = new Promise(res => {
        window.open = (url) => { if (url) res(url); return null; };
        setTimeout(() => res(null), 3000);
      });
      const linkHandler = (e) => {
        const a = e.target.closest('a[href]');
        if (a && a.href) {
          const url = extractLinkedInSafetyUrl(a.href);
          if (url && !url.includes('linkedin.com')) { e.preventDefault(); capturedUrl = url; }
        }
      };
      document.addEventListener('click', linkHandler, true);
      btns[0].click();
      const openUrl = await openCapture;
      window.open = origOpen;
      document.removeEventListener('click', linkHandler, true);
      if (openUrl) capturedUrl = openUrl;
      if (capturedUrl) break;
    }

    await pjaAutoWait(800);
  }

  // Fallback: scan DOM for known ATS link hrefs
  if (!capturedUrl) {
    const atsSelectors = 'a[href*="greenhouse.io"],a[href*="lever.co"],a[href*="workday.com"],a[href*="myworkdayjobs.com"],a[href*="jobvite.com"],a[href*="icims.com"],a[href*="smartrecruiters.com"],a[href*="ashbyhq.com"],a[href*="bamboohr.com"],a[href*="linkedin.com/safety/go"]';
    const atsLink = document.querySelector(atsSelectors);
    if (atsLink) capturedUrl = extractLinkedInSafetyUrl(atsLink.href);
  }

  if (!capturedUrl) return { success: false, reason: 'no_apply_btn' };

  onStatus(`${title}: navigating to application…`);

  // Store job context + queue info for external-apply.js to pick up
  const returnUrl = location.href;
  await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'SET_EXT_CURRENT',
    payload: { ...job, profile, answers, applyUrl: capturedUrl, returnUrl }
  }, resolve));

  // Navigate current tab to the external ATS
  setTimeout(() => { window.location.href = capturedUrl; }, 500);

  // Return a "pending" result — actual result comes when we return from ATS
  return { success: false, reason: 'navigating_to_ats', pending: true };
}

// ── Public API ───────────────────────────────────────────────────────────────
window.__pjaAutoState                  = PJA_AUTO_STATE;
window.__pjaGetCurrentModal            = pjaGetCurrentModal;
window.__pjaScanQualifying             = pjaScanQualifyingJobs;
window.__pjaScanQualifyingAsync        = pjaScanQualifyingJobsAsync;
window.__pjaAutoApplyBatch             = pjaAutoApplyBatch;
window.__pjaAutoSearchURL              = PJA_AUTO_SEARCH_URL;
window.__pjaApplyOnCurrentPage         = pjaApplyOnCurrentPage;
window.__pjaExternalApplyOnCurrentPage = pjaExternalApplyOnCurrentPage;
// Testable Easy Apply modal helpers (used by unit tests + internally).
window.__pjaModalHeading               = pjaModalHeading;
window.__pjaModalBtns                  = pjaModalBtns;
window.__pjaEasyApplyStepFingerprint   = pjaEasyApplyStepFingerprint;
window.__pjaFillRequiredRadioFallback  = pjaFillRequiredRadioFallback;
window.__pjaAutoCheckConsent           = pjaAutoCheckConsent;
window.__pjaSelfIdPick                 = pjaSelfIdPick;
window.__pjaEmptyRequiredFields        = pjaEmptyRequiredFields;
window.__pjaEasyApplyState             = pjaEasyApplyState;
window.__pjaFindEasyApplyBtn           = pjaFindEasyApplyBtn;
window.__pjaTrustedClickInModal        = pjaTrustedClickInModal;
window.__pjaTrustedActivations         = PJA_TRUSTED_ACTIVATIONS;
