(function () {
'use strict';
if (window.PJAWorkdayEngine) return;

const HOST_RE = /workday\.com|myworkdayjobs\.com/i;

function isWorkdayHost(hostname) {
  return HOST_RE.test(hostname || location.hostname || '');
}

function duplicateRecordRecoveryAction(input = {}) {
  if (!input.hasError || !/\/apply\/applyManually(?:\/|$)/i.test(String(input.pathname || ''))) return 'none';
  let markedDraftRetry = false;
  try { markedDraftRetry = new URLSearchParams(String(input.search || '')).get('pja_wd_draft_retry') === '1'; } catch (_) {}
  return input.retryUsed || markedDraftRetry ? 'terminal' : 'reroute';
}

function visible(el) {
  if (!el) return false;
  if (el.offsetParent !== null) return true;
  try {
    const rects = el.getClientRects && el.getClientRects();
    if (rects && rects.length) return true;
  } catch (_) {}
  // jsdom/unit-test fallback.
  return typeof navigator !== 'undefined' && /jsdom/i.test(String(navigator.userAgent || ''));
}

function clean(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function textOf(el) {
  return clean(el?.textContent || el?.value || el?.getAttribute?.('aria-label') || el?.placeholder || '');
}

function findEmailInput(root = document) {
  const candidates = Array.from(root.querySelectorAll(
    'input[data-automation-id="email"], input[type=email], input[autocomplete="username"], ' +
    'input[name*="email" i], input[id*="email" i], input[aria-label*="email" i], input[placeholder*="email" i], ' +
    'input[name*="user" i], input[id*="user" i]'
  ));
  return candidates.find(el => {
    if (!visible(el)) return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (/password|checkbox|radio|hidden|submit|button|file/.test(type)) return false;
    const hay = [
      el.getAttribute('data-automation-id') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('name') || '',
      el.id || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || ''
    ].join(' ');
    return /email|e-mail|username|user name|login/i.test(hay);
  }) || null;
}

function findEmailSignInButton(root = document) {
  return Array.from(root.querySelectorAll('a,button,[role=button],[data-automation-id]')).find(el => {
    const aid = el.getAttribute('data-automation-id') || '';
    if (/signInWithEmail|emailSignIn/i.test(aid)) return true;
    const t = clean(el.textContent || '');
    if (!t || t.length > 40) return false;
    if (/apple|google|linkedin|facebook|microsoft/i.test(t)) return false;
    return /sign.?in with email|continue with email|use email|sign.?in with your email|email me a link/i.test(t);
  }) || null;
}

function detectState(root = document) {
  if (!isWorkdayHost()) return 'not_workday';
  const pwFields = root.querySelectorAll('input[type=password]');
  const emailField = findEmailInput(root);
  const bodyText = root.body?.innerText || '';
  const authAction = root.querySelector(
    '[data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="createAccountLink"]'
  ) || findEmailSignInButton(root);
  const socialAuthText = /sign.?in with (apple|google|linkedin|facebook|microsoft)|continue with (apple|google|linkedin|facebook|microsoft)/i.test(bodyText);

  if (root.querySelector('[data-automation-id="legalNameSection_firstName"], [data-automation-id="bottomNavigationSubmit"]') ||
      (pwFields.length === 0 && !root.querySelector('[data-automation-id="createAccountLink"]') &&
       /current step\s+\d+\s+of\s+\d+/i.test(bodyText) && /back to job posting/i.test(bodyText) &&
       !authAction && !socialAuthText &&
       !/apply manually|autofill\s+with\s+resume/i.test(bodyText))) {
    return 'application_form';
  }

  if (root.querySelector('[data-automation-id="verifyEmailPage"], [data-automation-id="checkYourEmail"]') ||
      /check your email|verification email sent|verify your email|verify your account|before you (can )?sign in|request a verification email|account is not.*verified|please verify/i.test(bodyText)) {
    return 'verify_pending';
  }

  if (pwFields.length === 0 && !emailField && findEmailSignInButton(root)) return 'email_button_step';

  if (pwFields.length === 0 &&
      !root.querySelector('[data-automation-id="createAccountLink"]') &&
      !findEmailSignInButton(root) &&
      bodyText &&
      /sign.?in with google|continue with google/i.test(bodyText)) {
    return 'sso_only';
  }

  if (pwFields.length >= 2) return 'createaccount';
  if (pwFields.length === 1) return 'signin';
  if (emailField && pwFields.length === 0) return 'signin_email_step';

  if (root.querySelector('[data-automation-id="applyManually"], [data-automation-id="autofillWithResume"]') ||
      (/apply\s+manually/i.test(bodyText) && /autofill\s+with\s+resume/i.test(bodyText))) {
    return 'start_application';
  }

  if (root.querySelector('[data-automation-id="adventureButton"], [data-automation-id="apply"], a[data-automation-id="apply"]') ||
      Array.from(root.querySelectorAll('a[role=button], button, a')).some(el =>
        /^(apply(\s|$)|continue application\b)/i.test(clean(el.textContent || '')) && visible(el))) {
    return 'job_apply_start';
  }

  const hasSignInBtn = root.querySelector(
    '[data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="createAccountLink"]'
  );
  if (root.querySelector('[data-automation-id="navigationItem-Candidate Home"]') ||
      (root.querySelector('[data-automation-id="utilityMenuButton"]') && !hasSignInBtn)) {
    return 'logged_in_home';
  }

  return 'unknown';
}

function stepInfo(root = document) {
  const text = clean(root.body?.innerText || '');
  const m = text.match(/current step\s+(\d+)\s+of\s+(\d+)/i);
  const active = Array.from(root.querySelectorAll('[aria-current="step"], [data-automation-id*="Step"], [data-automation-id*="step"]'))
    .map(textOf).find(Boolean) || '';
  return {
    index: m ? parseInt(m[1], 10) : null,
    total: m ? parseInt(m[2], 10) : null,
    label: active.slice(0, 120),
  };
}

function selectedTextFor(el) {
  const roots = [
    el?.closest?.('[data-uxi-widget-type="multiselect"]'),
    el?.closest?.('[data-automation-id^="formField"], [data-automation-id^="question"], fieldset'),
    el?.parentElement,
  ].filter(Boolean);
  for (const root of roots) {
    const selected = Array.from(root.querySelectorAll(
      '[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"], [class*="singleValue"], [class*="single-value"]'
    )).map(textOf).find(txt => txt && !/^select one|select\.\.\.|required|choose$/i.test(txt));
    if (selected) return selected;
    const t = clean(root.textContent || '');
    if (/\d+\s*item selected/i.test(t)) return t.slice(0, 160);
  }
  return '';
}

function labelFor(el) {
  const aria = el.getAttribute?.('aria-label') || '';
  if (aria) return clean(aria);
  const labelledBy = (el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent || '').join(' ');
  if (labelledBy) return clean(labelledBy);
  const id = el.id || '';
  if (id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (explicit) return clean(explicit.textContent || '');
  }
  const field = el.closest?.('[data-automation-id^="formField"], [data-automation-id^="question"], fieldset');
  const rich = field?.querySelector?.('[data-automation-id="richText"], label, legend')?.textContent || '';
  if (rich) return clean(rich);
  return textOf(el).slice(0, 160);
}

function kindFor(el) {
  const tag = (el.tagName || '').toLowerCase();
  const type = String(el.getAttribute('type') || '').toLowerCase();
  const role = String(el.getAttribute('role') || '').toLowerCase();
  const widget = String(el.getAttribute('data-uxi-widget-type') || '').toLowerCase();
  if (widget === 'selectinput') return 'selectinput';
  if (role === 'combobox') return 'combobox';
  if (tag === 'button' || role === 'button') return 'buttonPrompt';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (role === 'spinbutton' || /dateSection(Month|Day|Year)-input/i.test(el.getAttribute('data-automation-id') || '')) return 'date';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  return 'text';
}

function collectFields(root = document) {
  if (!isWorkdayHost()) return [];
  return Array.from(root.querySelectorAll(
    'input:not([type=hidden]), textarea, select, button, [role="button"], [role="combobox"], [data-uxi-widget-type="selectinput"]'
  )).filter(visible).slice(0, 120).map(el => {
    const kind = kindFor(el);
    const selectedText = selectedTextFor(el);
    return {
      id: String(el.id || '').slice(0, 100),
      automationId: String(el.getAttribute('data-automation-id') || '').slice(0, 100),
      kind,
      tag: String(el.tagName || '').toLowerCase(),
      type: String(el.getAttribute('type') || '').slice(0, 40),
      role: String(el.getAttribute('role') || '').slice(0, 40),
      label: labelFor(el).slice(0, 220),
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      invalid: el.getAttribute('aria-invalid') === 'true',
      valuePresent: 'value' in el ? !!String(el.value || '').trim() : undefined,
      selectedText: selectedText.slice(0, 180),
      text: textOf(el).slice(0, 180),
    };
  }).filter((field, index, all) =>
    field.label || field.id || field.automationId || index === all.findIndex(other =>
      other.id === field.id && other.automationId === field.automationId && other.label === field.label));
}

function snapshot(root = document) {
  return {
    isWorkday: isWorkdayHost(),
    state: detectState(root),
    step: stepInfo(root),
    url: location.href,
    title: document.title,
    fields: collectFields(root).slice(0, 40),
  };
}

window.PJAWorkdayEngine = {
  version: 1,
  isWorkdayHost,
  duplicateRecordRecoveryAction,
  visible,
  findEmailInput,
  findEmailSignInButton,
  detectState,
  stepInfo,
  selectedTextFor,
  collectFields,
  snapshot,
};

console.log('PJA: workday-engine.js loaded on', location.hostname);
})();
