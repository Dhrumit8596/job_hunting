(function() {
'use strict';
if (window.pjaWorkdayAuth) return;

const DEFAULT_JOB_PASSWORD = 'ChangeMe#2025!';

function pjaWdVisible(el) {
  if (!el) return false;
  if (el.offsetParent !== null) return true;
  try {
    const rects = el.getClientRects && el.getClientRects();
    if (rects && rects.length) return true;
  } catch (_) {}
  // Unit-test/jsdom fallback: no layout engine, but text-only synthetic controls are still valid.
  return typeof window !== 'undefined' && /jsdom/i.test(String(window.navigator && window.navigator.userAgent || ''));
}

// ── Storage helpers ────────────────────────────────────────────────────────

const ACCOUNTS_KEY = 'pja_workday_accounts';

async function getAccount(hostname) {
  return new Promise(resolve =>
    chrome.storage.local.get(ACCOUNTS_KEY, d => {
      const accounts = d[ACCOUNTS_KEY] || {};
      resolve(accounts[hostname] || null);
    })
  );
}

async function setAccount(hostname, fields) {
  return new Promise(resolve =>
    chrome.storage.local.get(ACCOUNTS_KEY, d => {
      const accounts = d[ACCOUNTS_KEY] || {};
      accounts[hostname] = { ...(accounts[hostname] || {}), ...fields, updatedAt: Date.now() };
      chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts }, resolve);
    })
  );
}

async function deleteAccount(hostname) {
  return new Promise(resolve =>
    chrome.storage.local.get(ACCOUNTS_KEY, d => {
      const accounts = d[ACCOUNTS_KEY] || {};
      delete accounts[hostname];
      chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts }, resolve);
    })
  );
}

// Migrate existing pja_wd_creds_${hostname} entries into pja_workday_accounts
async function migrateOldCreds(hostname) {
  const oldKey = `pja_wd_creds_${hostname}`;
  const old = await new Promise(r => chrome.storage.local.get(oldKey, d => r(d[oldKey] || null)));
  if (!old) return;
  const existing = await getAccount(hostname);
  if (!existing) {
    await setAccount(hostname, {
      email: old.email,
      password: old.password,
      status: 'needs_signin',  // test creds before trusting them
      createdAt: Date.now(),
      verifiedAt: null,
      lastSignInAt: null,
      failedAttempts: 0,
      notes: 'migrated from pja_wd_creds'
    });
  }
  await new Promise(r => chrome.storage.local.remove(oldKey, r));
}

// ── Sleep / debug helpers ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dbg(msg) {
  console.log('PJA workday-auth:', msg);
  chrome.storage.local.get('pja_dbg', d => {
    const arr = (d.pja_dbg || []).slice(-50);
    arr.push('[WD] ' + msg);
    chrome.storage.local.set({ pja_dbg: arr });
  });
}

function pjaWorkdayTenantEmail(email, hostname) {
  const raw = String(email || '').trim();
  const m = raw.match(/^([^@+]+)(?:\+[^@]*)?@(gmail\.com|googlemail\.com)$/i);
  if (!m) return raw;
  const host = String(hostname || '').toLowerCase().split('.')[0] || 'workday';
  const slug = host.replace(/[^a-z0-9]+/g, '').replace(/wd\d+$/, '').slice(0, 24) || 'workday';
  return `${m[1]}+wd-${slug}@${m[2].toLowerCase()}`;
}

function visibleWorkdayAuthErrors() {
  const textOf = el => String(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim().replace(/\s+/g, ' ');
  const nodes = Array.from(document.querySelectorAll(
    '[data-automation-id*="error" i], [role="alert"], [aria-live], .error, [class*="error" i], button'
  ));
  return Array.from(new Set(nodes
    .filter(el => pjaWdVisible(el))
    .map(textOf)
    .filter(txt => txt && !/^errors? found$/i.test(txt))
    .filter(txt => /error|required|invalid|incorrect|password|verify|verification|account|exist|already|email|captcha|robot/i.test(txt))
    .map(txt => txt.slice(0, 220))))
    .slice(0, 8);
}

function workdayAuthScreenSummary(label) {
  const screen = typeof detectScreen === 'function' ? detectScreen() : 'unknown';
  const body = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
  return {
    label: label || '',
    screen,
    url: location.href,
    title: document.title || '',
    passwordFields: document.querySelectorAll('input[type=password]').length,
    emailField: !!findWorkdayEmailInput(),
    createSubmit: !!document.querySelector('[data-automation-id="createAccountSubmitButton"]'),
    signInSubmit: !!document.querySelector('[data-automation-id="signInSubmitButton"], button[type=submit]'),
    verifyRequest: Array.from(document.querySelectorAll('a, button, [role="button"], [data-automation-id]'))
      .some(el => /request a verification email|resend( verification)?( email)?|send( me)? (a |the )?(verification|confirmation) email/i.test((el.innerText || el.getAttribute('aria-label') || '').trim())),
    errors: visibleWorkdayAuthErrors(),
    body
  };
}

async function persistWorkdayAuthSnapshot(label, fields) {
  try {
    await new Promise(r => chrome.storage.local.set({
      pja_wd_auth_diag: { ts: Date.now(), ...workdayAuthScreenSummary(label), ...(fields || {}) }
    }, r));
  } catch (_) {}
}

function findWorkdayEmailInput() {
  const candidates = Array.from(document.querySelectorAll(
    'input[data-automation-id="email"], input[type=email], input[autocomplete="username"], ' +
    'input[name*="email" i], input[id*="email" i], input[aria-label*="email" i], input[placeholder*="email" i], ' +
    'input[name*="user" i], input[id*="user" i]'
  ));
  return candidates.find(el => {
    if (!pjaWdVisible(el)) return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (/password|checkbox|radio|hidden|submit|button|file/.test(type)) return false;
    const text = [
      el.getAttribute('data-automation-id') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('name') || '',
      el.id || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || ''
    ].join(' ');
    return /email|e-mail|username|user name|login/i.test(text);
  }) || null;
}

// ── Screen detection ──────────────────────────────────────────────────────

// Finds the "Sign in with email" / "Continue with email" button that some Workday
// tenants show alongside social-login buttons. The email/password form is hidden
// behind it. Excludes the social providers themselves.
function findEmailSignInButton() {
  return Array.from(document.querySelectorAll('a,button,[role=button],[data-automation-id]')).find(el => {
    const aid = el.getAttribute('data-automation-id') || '';
    if (/signInWithEmail|emailSignIn/i.test(aid)) return true;
    const t = (el.textContent || '').trim();
    if (!t || t.length > 40) return false;
    if (/apple|google|linkedin|facebook|microsoft/i.test(t)) return false;
    // Generic Workday header buttons (`utilityButtonSignIn` / `signInLink`) usually just say
    // "Sign In" and can appear on job posting pages before the Apply flow. Treat only explicit
    // email-path labels as the auth-choice step; otherwise job_apply_start should click Apply.
    return /sign.?in with email|continue with email|use email|sign.?in with your email|email me a link/i.test(t);
  });
}

function detectScreen() {
  try {
    const engineState = window.PJAWorkdayEngine && window.PJAWorkdayEngine.detectState &&
      window.PJAWorkdayEngine.detectState(document);
    if (engineState && engineState !== 'not_workday' && engineState !== 'unknown') return engineState;
  } catch (_) {}

  const pwFields = document.querySelectorAll('input[type=password]');
  const emailField = findWorkdayEmailInput();

  const bodyText = document.body?.innerText || '';
  const authAction = document.querySelector(
    '[data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="createAccountLink"]'
  ) || findEmailSignInButton();
  const socialAuthText = /sign.?in with (apple|google|linkedin|facebook|microsoft)|continue with (apple|google|linkedin|facebook|microsoft)/i.test(bodyText);
  if (document.querySelector('[data-automation-id="legalNameSection_firstName"], [data-automation-id="bottomNavigationSubmit"]') ||
      (pwFields.length === 0 && !document.querySelector('[data-automation-id="createAccountLink"]') &&
       /current step\s+\d+\s+of\s+\d+/i.test(bodyText) && /back to job posting/i.test(bodyText) &&
       !authAction && !socialAuthText &&
       !/apply manually|autofill\s+with\s+resume/i.test(bodyText))) {
    return 'application_form';
  }

  if (
    document.querySelector('[data-automation-id="verifyEmailPage"], [data-automation-id="checkYourEmail"]') ||
    /check your email|verification email sent|verify your email|verify your account|before you (can )?sign in|request a verification email|account is not.*verified|please verify/i.test(bodyText)
  ) {
    return 'verify_pending';
  }

  // Multi-step auth gate (e.g. KLA): social buttons (Apple/Google/LinkedIn) + an
  // "OR → Sign in with email" button. The email/password fields only render AFTER
  // clicking "Sign in with email". Detect that button BEFORE sso_only so we don't
  // wrongly give up on tenants that DO offer an email path (just behind a click).
  if (pwFields.length === 0 && !emailField && findEmailSignInButton()) {
    return 'email_button_step';
  }

  if (
    pwFields.length === 0 &&
    !document.querySelector('[data-automation-id="createAccountLink"]') &&
    !findEmailSignInButton() &&
    bodyText &&
    /sign.?in with google|continue with google/i.test(bodyText)
  ) {
    return 'sso_only';
  }

  if (pwFields.length >= 2) return 'createaccount';
  if (pwFields.length === 1) return 'signin';
  if (emailField && pwFields.length === 0) return 'signin_email_step';

  // "Start Your Application" intermediary — Workday shows this before login when navigating
  // directly to an /apply URL. Must click "Apply Manually" to reach the actual auth form.
  if (document.querySelector('[data-automation-id="applyManually"]') ||
      (document.querySelector('[data-automation-id="autofillWithResume"]')) ||
      (/apply\s+manually/i.test(bodyText) &&
       /autofill\s+with\s+resume/i.test(bodyText))) {
    return 'start_application';
  }

  // Workday JOB POSTING page (pre-apply): a primary "Apply" / signed-in "Continue Application"
  // button is present but the apply/auth
  // flow hasn't started yet. Detect it so we can dismiss cookie banners and click Apply to enter
  // the flow (these new tenants land here, not on a recognized auth screen → was 'unknown').
  if (document.querySelector('[data-automation-id="adventureButton"], [data-automation-id="apply"], a[data-automation-id="apply"]')
      || Array.from(document.querySelectorAll('a[role=button], button, a')).some(el =>
           /^(apply(\s|$)|continue application\b)/i.test((el.textContent || '').trim()) && pjaWdVisible(el))) {
    return 'job_apply_start';
  }

  // User is logged in — Workday auto-signed in after account creation, or already had a session.
  // Candidate Home nav item only appears when authenticated.
  // NOTE: some tenants use utilityButtonSignIn instead of signInLink — treat both as "not logged in".
  // Keep this AFTER job_apply_start: signed-in job postings also show Candidate Home, but they
  // still need the primary Apply button clicked to enter /apply/applyManually.
  const hasSignInBtn = document.querySelector(
    '[data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="createAccountLink"]'
  );
  if (
    document.querySelector('[data-automation-id="navigationItem-Candidate Home"]') ||
    (document.querySelector('[data-automation-id="utilityMenuButton"]') && !hasSignInBtn)
  ) {
    return 'logged_in_home';
  }

  return 'unknown';
}

// Dismiss cookie-consent banners that block clicks on some Workday tenants (OneTrust/TrustArc/
// Workday legal notice + generic Accept buttons).
function wdDismissCookies() {
  const sels = ['[data-automation-id="legalNoticeAcceptButton"]', '#onetrust-accept-btn-handler',
    '#truste-consent-button', '.onetrust-close-btn-handler', '[aria-label*="accept all" i]'];
  for (const s of sels) { const b = document.querySelector(s); if (b) { try { b.click(); } catch (_) {} } }
  const acc = Array.from(document.querySelectorAll('button, a')).find(el =>
    /^(accept all|accept all cookies|accept|i accept|agree|got it|allow all)$/i.test((el.textContent || '').trim()) && el.offsetParent !== null);
  if (acc) { try { acc.click(); } catch (_) {} }
}

// ── React-safe form submission via background MAIN world handler ──────────

async function wdSubmitForm(formType, email, password) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'WORKDAY_SUBMIT_FORM', formType, email, password }, resolve)
  );
}

// ── Poll for auth result ──────────────────────────────────────────────────

// Generic: waits for password fields to disappear (used for sign-in)
async function wdPollAuthResult(maxMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(400);
    if (!document.querySelector('input[type=password]')) return { success: true };
    const errEl = document.querySelector(
      '[data-automation-id="errorMessage"], ' +
      '[data-automation-id*="ValidationError"], ' +
      '[role=alert][aria-live]'
    );
    const errText = errEl?.innerText?.trim();
    if (errText) return { success: false, error: errText };
  }
  return { success: false, error: 'timeout' };
}

// Create-account specific: waits for screen to leave 'createaccount' state
// (Workday navigates to signin or verify_pending after successful submission)
async function wdPollCreateAccount(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(400);
    const s = detectScreen();
    if (s !== 'createaccount') return { success: true };
    const errEl = document.querySelector(
      '[data-automation-id="errorMessage"], ' +
      '[data-automation-id*="ValidationError"], ' +
      '[role=alert][aria-live]'
    );
    const errText = errEl?.innerText?.trim();
    if (errText) return { success: false, error: errText };
  }
  return { success: false, error: 'timeout' };
}

// ── Gmail verification flow ───────────────────────────────────────────────

async function runGmailVerify(email, purpose, hostname) {
  // Some tenants (Bloom Energy) DON'T auto-send the verification email — the verify page has a
  // "request a verification email" / "resend" control that must be clicked first, else the
  // Gmail search below finds nothing. Click it (once) on the current page before opening Gmail.
  if (purpose !== 'reset') {
    try {
      const reqBtn = Array.from(document.querySelectorAll('a, button, [role="button"], [data-automation-id]'))
        .find(el => /request a verification email|resend( verification)?( email)?|send( me)? (a |the )?(verification|confirmation) email/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
      if (reqBtn) {
        dbg('runGmailVerify: clicking request-verification-email "' + (reqBtn.innerText || '').trim().slice(0, 30) + '"');
        reqBtn.click();
        await sleep(3000); // let the send fire + email arrive
      } else {
        dbg('runGmailVerify: no request-email button found (auto-send assumed) screen=' + (typeof detectScreen === 'function' ? detectScreen() : '?'));
      }
    } catch (e) { dbg('runGmailVerify: reqBtn check error ' + e.message); }
  }

  // Broad query: Workday verification emails come from tenant-branded senders too (e.g.
  // Bloom Energy sends from a non-myworkday address), so the old narrow sender-only filter
  // matched nothing (reason=email_not_found even though the email arrived). Match ANY Workday
  // sender OR a verify/confirm subject; findLinkInEmailBody() still validates that the clicked
  // email actually contains a myworkdayjobs.com link, so a broad search can't misfire.
  const targetEmail = String(email || '').trim();
  const emailClause = targetEmail && /@gmail\.com|@googlemail\.com/i.test(targetEmail)
    ? `(to:${targetEmail} OR deliveredto:${targetEmail})`
    : '';
  const searchQuery = purpose === 'reset'
    ? [emailClause, '(from:(workday.com OR myworkday.com OR myworkdayjobs.com) OR subject:(reset password))'].filter(Boolean).join(' OR ') + ' newer_than:20m'
    : [emailClause, '(from:(workday.com OR myworkday.com OR myworkdayjobs.com) OR subject:(verify OR verification OR "confirm your email" OR activate OR "email address"))'].filter(Boolean).join(' OR ') + ' newer_than:20m';

  const { pja_wd_gmail_session: existingSession } = await new Promise(r =>
    chrome.storage.local.get('pja_wd_gmail_session', r)
  );
  if (existingSession && existingSession.hostname === hostname &&
      Date.now() - existingSession.startedAt < 120000) {
    dbg('runGmailVerify: gmail flow already in progress, waiting');
    return await waitForVerifyComplete(hostname, 90000);
  }

  await new Promise(r => chrome.storage.local.remove('pja_wd_verify_result', r));

  dbg('runGmailVerify: sending WD_OPEN_GMAIL_TAB q=' + searchQuery.slice(0, 40));
  const resp = await new Promise(resolve =>
    chrome.runtime.sendMessage({
      type: 'WD_OPEN_GMAIL_TAB',
      searchQuery,
      hostname,
      purpose,
      targetEmail,
    }, resolve)
  );

  dbg('runGmailVerify: WD_OPEN_GMAIL_TAB resp=' + JSON.stringify(resp || null));
  if (!resp?.ok) {
    dbg('runGmailVerify: WD_OPEN_GMAIL_TAB not ok → false');
    return false;
  }

  const result = await waitForVerifyResult(hostname, 90000);
  const verified = result?.success === true;
  dbg('runGmailVerify: waitForVerifyComplete → ' + verified +
    (result?.reason ? ' reason=' + result.reason : '') +
    (result?.evidence?.subject ? ' subject=' + String(result.evidence.subject).slice(0, 80) : ''));
  if (!verified && purpose !== 'reset' && /email_not_found|link_not_found|code_not_found/i.test(String(result?.reason || ''))) {
    const clicked = await clickWorkdayVerificationRequest('gmail-retry');
    if (clicked) {
      dbg('runGmailVerify: retrying Gmail after request/resend click');
      return await runGmailVerify(email, purpose + '_retry', hostname);
    }
  }
  return verified;
}

async function waitForVerifyResult(hostname, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const { pja_wd_verify_result: result } = await new Promise(r =>
      chrome.storage.local.get('pja_wd_verify_result', r)
    );
    if (result && result.hostname === hostname && result.ts > t0) {
      await new Promise(r => chrome.storage.local.remove('pja_wd_verify_result', r));
      return result;
    }
  }
  return { hostname, success: false, reason: 'verify_wait_timeout', ts: Date.now() };
}

async function waitForVerifyComplete(hostname, timeoutMs) {
  const result = await waitForVerifyResult(hostname, timeoutMs);
  return result.success === true;
}

async function clickWorkdayVerificationRequest(label) {
  try {
    const reqBtn = Array.from(document.querySelectorAll('a, button, [role="button"], [data-automation-id]'))
      .find(el => /request a verification email|resend( verification)?( email)?|send( me)? (a |the )?(verification|confirmation) email/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
    if (!reqBtn) return false;
    dbg('clicking request-verification-email ' + (label || '') + ' "' + (reqBtn.innerText || reqBtn.getAttribute('aria-label') || '').trim().slice(0, 30) + '"');
    if (!await trustedWorkdayClick(reqBtn, 'request-verification-email-' + (label || ''))) reqBtn.click();
    await sleep(3500);
    return true;
  } catch (e) {
    dbg('request-verification-email click error ' + String(e && e.message || e).slice(0, 80));
    return false;
  }
}

// ── Account creation ──────────────────────────────────────────────────────

async function runCreateAccount(profile, password) {
  const hostname = location.hostname;
  dbg('runCreateAccount start, screen=' + detectScreen());

  // Wait until we actually see the create-account form (2 password fields)
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    if (document.querySelectorAll('input[type=password]').length >= 2) break;
    await sleep(400);
  }
  const screenNow = detectScreen();
  dbg('runCreateAccount pre-submit screen=' + screenNow +
    ' pwFields=' + document.querySelectorAll('input[type=password]').length +
    ' submitBtn=' + !!document.querySelector('[data-automation-id="createAccountSubmitButton"]'));

  if (screenNow !== 'createaccount') {
    dbg('runCreateAccount: not on create-account form, aborting');
    await setAccount(hostname, { status: 'creation_failed', notes: 'wrong_screen:' + screenNow });
    return 'error';
  }

  await setAccount(hostname, {
    email: profile.email,
    password,
    status: 'pending_creation',
    createdAt: Date.now(),
    verifiedAt: null,
    lastSignInAt: null,
    failedAttempts: 0,
    notes: ''
  });

  const resp = await wdSubmitForm('createaccount', profile.email, password);
  dbg('runCreateAccount WORKDAY_SUBMIT_FORM resp=' + JSON.stringify(resp));
  await persistWorkdayAuthSnapshot('createaccount-submit', { submitResp: resp || null });

  // Wait for page to leave create-account screen (navigates to signin or verify)
  const poll = await wdPollCreateAccount(15000);
  dbg('runCreateAccount poll=' + JSON.stringify(poll) + ' screen=' + detectScreen());

  if (!poll.success) {
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-automation-id*="captcha"]')) {
      await setAccount(hostname, { status: 'captcha_blocked' });
      dbg('captcha_blocked');
      return 'captcha_blocked';
    }
    if (/already.*register|already.*exist|email.*use|email.*taken|account.*exist/i.test((poll.error || '').toLowerCase())) {
      dbg('email already exists, trying signin');
      await setAccount(hostname, { status: 'exists_try_signin' });
      return await runSignIn(profile, password);
    }
    dbg('creation_failed: ' + poll.error);
    await setAccount(hostname, { status: 'creation_failed', notes: poll.error });
    return 'error';
  }

  await sleep(500);
  const screen = detectScreen();
  dbg('post-create screen=' + screen);
  await persistWorkdayAuthSnapshot('post-create', { poll });

  if (screen === 'application_form') {
    await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), lastSignInAt: Date.now() });
    dbg('account_created_verified (went straight to app form)');
    return 'account_created_verified';
  }

  if (screen === 'verify_pending') {
    dbg('verify_pending — opening Gmail for verification');
    await setAccount(hostname, { status: 'pending_verification' });
    // (request-verification-email click is handled centrally inside runGmailVerify)
    const verified = await runGmailVerify(profile.email, 'verify', hostname);
    if (verified) {
      await setAccount(hostname, { status: 'verified', verifiedAt: Date.now() });
      dbg('email verified, returning needs_gmail_verify');
      return 'needs_gmail_verify';
    }
    dbg('verification_failed');
    await setAccount(hostname, { status: 'verification_failed' });
    return 'error';
  }

  if (screen === 'signin' || screen === 'signin_email_step' || screen === 'email_button_step') {
    dbg('account created, now on signin screen — signing in');
    const signInResult = await runSignIn(profile, password);
    if (signInResult === 'unverified') {
      dbg('post-create signin says unverified — opening Gmail');
      await setAccount(hostname, { status: 'pending_verification' });
      const verified = await runGmailVerify(profile.email, 'verify', hostname);
      if (verified) {
        await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), failedAttempts: 0 });
        return 'needs_gmail_verify';
      }
      await setAccount(hostname, { status: 'verification_failed' });
      return 'error';
    }
    if (signInResult === 'sign_in_error') {
      await persistWorkdayAuthSnapshot('post-create-signin-failed');
      await setAccount(hostname, { status: 'creation_failed', notes: 'signin_after_create_failed' });
    }
    return signInResult;
  }

  if (screen === 'logged_in_home') {
    // Workday auto-signed in after account creation — no email verification needed
    await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), lastSignInAt: Date.now() });
    dbg('account_created_verified (auto-signed-in)');
    return 'account_created_verified';
  }

  if (screen === 'unknown') {
    // Wait a bit more and recheck — might be a transitional loading state
    await sleep(2000);
    const s2 = detectScreen();
    dbg('post-create retry screen=' + s2);
    if (s2 === 'application_form' || s2 === 'logged_in_home') {
      await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), lastSignInAt: Date.now() });
      return 'account_created_verified';
    }
    if (s2 === 'verify_pending') {
      await setAccount(hostname, { status: 'pending_verification' });
      const verified = await runGmailVerify(profile.email, 'verify', hostname);
      if (verified) { await setAccount(hostname, { status: 'verified', verifiedAt: Date.now() }); return 'needs_gmail_verify'; }
      await setAccount(hostname, { status: 'verification_failed' });
      return 'error';
    }
    if (s2 === 'signin' || s2 === 'signin_email_step' || s2 === 'email_button_step') {
      dbg('delayed signin screen — signing in');
      const signInResult = await runSignIn(profile, password);
      if (signInResult === 'unverified') {
        await setAccount(hostname, { status: 'pending_verification' });
        const verified = await runGmailVerify(profile.email, 'verify', hostname);
        if (verified) { await setAccount(hostname, { status: 'verified', verifiedAt: Date.now() }); return 'needs_gmail_verify'; }
        await setAccount(hostname, { status: 'verification_failed' });
        return 'error';
      }
      return signInResult;
    }
  }

  dbg('post-create unknown screen=' + screen + ' — error');
  await setAccount(hostname, { status: 'creation_failed', notes: 'unknown_screen' });
  return 'error';
}

// ── Sign-in ───────────────────────────────────────────────────────────────

async function runSignIn(profile, password) {
  const hostname = location.hostname;
  console.log('PJA workday-auth: signing in on', hostname);

  let screen = detectScreen();
  if (screen === 'signin_email_step') {
    await wdSubmitForm('signin_email_step', profile.email, password);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await sleep(400);
      if (document.querySelectorAll('input[type=password]').length >= 1) break;
    }
  }

  screen = detectScreen();
  if (screen === 'createaccount') {
    const signinLink = document.querySelector('[data-automation-id="signInLink"]') ||
      Array.from(document.querySelectorAll('a,button')).find(el =>
        /^sign.?in$/i.test(el.innerText?.trim())
      );
    if (signinLink) { signinLink.click(); await sleep(1500); }
  }

  const resp = await wdSubmitForm('signin', profile.email, password);
  console.log('PJA workday-auth: signin resp', resp);

  const poll = await wdPollAuthResult(12000);
  console.log('PJA workday-auth: signin poll', poll);

  if (poll.success) {
    await setAccount(hostname, { status: 'verified', lastSignInAt: Date.now(), failedAttempts: 0 });
    return 'signed_in';
  }

  const errLower = (poll.error || '').toLowerCase();

  if (/verify|verification|confirm.*email|email.*confirm|account.*not.*verified|not.*verified|activate.*account/i.test(errLower)) {
    await setAccount(hostname, { status: 'pending_verification', notes: poll.error });
    return 'unverified';
  }

  if (/locked|too many.*attempt|too many.*login/i.test(errLower)) {
    await setAccount(hostname, { status: 'locked', notes: poll.error });
    return 'locked';
  }

  if (/no account|not.*registered|not.*found|email.*not.*exist/i.test(errLower)) {
    await deleteAccount(hostname);
    return await runCreateAccount(profile, password);
  }

  if (/invalid.*password|incorrect.*password|password.*incorrect|password.*does.*not.*match|wrong.*password/i.test(errLower)) {
    const acct = await getAccount(hostname);
    const failedAttempts = (acct?.failedAttempts || 0) + 1;
    await setAccount(hostname, { failedAttempts });
    if (failedAttempts <= 2) {
      return await runForgotPassword(profile, password);
    }
    await setAccount(hostname, { status: 'reset_limit', notes: 'Too many failed resets' });
    return 'locked';
  }

  await setAccount(hostname, { status: 'sign_in_error', notes: poll.error });
  return 'sign_in_error';
}

// ── Forgot password / reset ────────────────────────────────────────────────

async function runForgotPassword(profile, password) {
  const hostname = location.hostname;
  console.log('PJA workday-auth: forgot password on', hostname);

  const forgotLink =
    document.querySelector('[data-automation-id="forgotPasswordLink"]') ||
    Array.from(document.querySelectorAll('a, button')).find(el =>
      /forgot.{0,15}password/i.test(el.innerText?.trim())
    );

  if (!forgotLink) {
    console.log('PJA workday-auth: forgot password link not found');
    return 'error';
  }

  await setAccount(hostname, { status: 'forgot_password_pending' });
  forgotLink.click();
  await sleep(1500);

  const emailField = findWorkdayEmailInput();
  if (emailField) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(emailField, profile.email);
      emailField.dispatchEvent(new InputEvent('input', { bubbles: true }));
      emailField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  await new Promise(r =>
    chrome.runtime.sendMessage({
      type: 'WORKDAY_TRUSTED_CLICK',
      selector: '[data-automation-id="resetPasswordSubmitButton"], button[type=submit]'
    }, r)
  );

  const t0 = Date.now();
  let gotVerifyScreen = false;
  while (Date.now() - t0 < 8000) {
    await sleep(500);
    if (detectScreen() === 'verify_pending') { gotVerifyScreen = true; break; }
  }

  if (!gotVerifyScreen) return 'error';

  const verified = await runGmailVerify(profile.email, 'reset', hostname);
  if (!verified) {
    await setAccount(hostname, { status: 'reset_failed' });
    return 'error';
  }

  await setAccount(hostname, { password, status: 'verified', verifiedAt: Date.now(), failedAttempts: 0 });
  return 'needs_gmail_verify';
}

// ── Main entry point ──────────────────────────────────────────────────────

async function trustedWorkdayClick(el, label) {
  if (!el) return false;
  const priorId = el.id;
  const tempId = priorId || ('__pja_wd_auth_click_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  if (!priorId) el.id = tempId;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const selector = '#' + ((window.CSS && CSS.escape) ? CSS.escape(tempId) : tempId);
    const resp = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_CLICK', selector, single: true }, r =>
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {})));
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
    dbg('trusted click ' + (label || '') + ' ok=' + !!resp.ok + (resp.error ? ' err=' + String(resp.error).slice(0, 60) : ''));
    return !!resp.ok;
  } finally {
    if (!priorId && el.id === tempId) el.removeAttribute('id');
  }
}

function manualApplyUrlFromCurrent() {
  const cleanUrl = String(location.href || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/\/apply(?:\/|$)/i.test(cleanUrl)) return cleanUrl;
  return cleanUrl + '/apply/applyManually';
}

async function run(profile, password) {
  const hostname = location.hostname;
  profile = profile || {};
  const tenantEmail = pjaWorkdayTenantEmail(profile.email, hostname);
  if (tenantEmail && tenantEmail !== profile.email) {
    dbg('using tenant-specific email alias ' + tenantEmail + ' for ' + hostname);
    profile = { ...profile, email: tenantEmail };
  }

  await migrateOldCreds(hostname);

  const screen = detectScreen();
  dbg('run start: screen=' + screen + ' url=' + location.pathname.slice(-50));

  if (screen === 'application_form') { dbg('already on application form'); return 'signed_in'; }
  if (screen === 'logged_in_home') {
    // Already authenticated — mark account verified if not already
    const ex = await getAccount(hostname);
    if (!ex || ex.status !== 'verified') {
      await setAccount(hostname, { email: profile.email, password, status: 'verified',
        verifiedAt: Date.now(), lastSignInAt: Date.now(), failedAttempts: 0 });
    }
    dbg('logged_in_home — returning signed_in');
    return 'signed_in';
  }
  if (screen === 'email_button_step') {
    // Auth gate offers social logins + a "Sign in with email" button. Click it to
    // reveal the email/password form, then re-run so the proper screen is handled.
    const btn = findEmailSignInButton();
    if (btn) {
      dbg('email_button_step: clicking "Sign in with email"');
      btn.click();
      let waited = 0;
      while (waited < 8000) {
        await sleep(400); waited += 400;
        const s2 = detectScreen();
        if (s2 !== 'email_button_step') { dbg('email_button_step → ' + s2 + ' after ' + waited + 'ms'); return run(profile, password); }
      }
      // Fallback: try a CDP trusted click in case .click() was filtered
      dbg('email_button_step: .click() no change, trying trusted click');
      await new Promise(r => chrome.runtime.sendMessage({
        type: 'WORKDAY_TRUSTED_CLICK',
        selector: '[data-automation-id="signInWithEmail"], [data-automation-id*="emailSignIn"]'
      }, r));
      waited = 0;
      while (waited < 6000) {
        await sleep(400); waited += 400;
        const s2 = detectScreen();
        if (s2 !== 'email_button_step') { dbg('email_button_step (cdp) → ' + s2); return run(profile, password); }
      }
      dbg('email_button_step: no change after click attempts');
    }
    return 'unknown_screen';
  }
  if (screen === 'sso_only') { dbg('SSO-only tenant'); return 'sso_only'; }
  if (screen === 'start_application') {
    // Click "Apply Manually" to bypass the resume-autofill intermediary and reach auth/form
    const applyManuallyBtn = document.querySelector('[data-automation-id="applyManually"]')
      || Array.from(document.querySelectorAll('a,button')).find(el => /apply\s+manually/i.test(el.textContent.trim()));
    if (applyManuallyBtn) {
      dbg('start_application: clicking applyManually');
      if (!await trustedWorkdayClick(applyManuallyBtn, 'applyManually')) applyManuallyBtn.click();
      // Poll for screen to change (up to 10s)
      let waited = 0;
      while (waited < 10000) {
        await new Promise(r => setTimeout(r, 400));
        waited += 400;
        const s2 = detectScreen();
        if (s2 !== 'start_application') {
          dbg('start_application: screen changed to ' + s2 + ' after ' + waited + 'ms');
          // Fall through: re-run auth with updated screen
          return run(profile, password);
        }
      }
      dbg('start_application: screen did not change after 10s');
    }
    const nextUrl = manualApplyUrlFromCurrent();
    if (location.href !== nextUrl) {
      dbg('start_application: direct nav fallback to applyManually');
      location.assign(nextUrl);
      return 'needs_navigation';
    }
    return 'unknown_screen';
  }

  if (screen === 'job_apply_start') {
    // On the Workday job posting: dismiss cookie banners (block clicks), then click the primary
    // Apply / Continue Application button to enter the application/auth flow, then re-run with the new screen.
    wdDismissCookies();
    await sleep(600);
    const applyBtn = document.querySelector('[data-automation-id="adventureButton"], [data-automation-id="apply"], a[data-automation-id="apply"]')
      || Array.from(document.querySelectorAll('a[role=button], button, a')).find(el => /^(apply(\s|$)|continue application\b)/i.test((el.textContent || '').trim()) && pjaWdVisible(el));
    if (applyBtn) {
      dbg('job_apply_start: clicking ' + ((applyBtn.textContent || 'Apply').trim().slice(0, 40) || 'Apply'));
      if (!await trustedWorkdayClick(applyBtn, 'jobApplyStart')) applyBtn.click();
      let waited = 0;
      while (waited < 1600) {
        await sleep(400); waited += 400;
        const s2 = detectScreen();
        if (s2 !== 'job_apply_start') { dbg('job_apply_start → ' + s2 + ' after ' + waited + 'ms'); return run(profile, password); }
      }
      dbg('job_apply_start: no change after Apply click');
    }
    const directKey = 'pja_wd_auth_direct_apply_' + hostname + '_' + location.pathname.replace(/[^\w-]+/g, '_').slice(-80);
    const directCount = parseInt(sessionStorage.getItem(directKey) || '0', 10);
    if (directCount < 3) {
      sessionStorage.setItem(directKey, String(directCount + 1));
      const nextUrl = manualApplyUrlFromCurrent();
      dbg('job_apply_start: direct nav fallback attempt ' + (directCount + 1) + ' to ' + nextUrl.slice(-80));
      location.assign(nextUrl);
      return 'needs_navigation';
    }
    return 'unknown_screen';
  }

  if (screen === 'unknown') {
    // Log DOM clues to help diagnose
    const pwCount = document.querySelectorAll('input[type=password]').length;
    const bodySnip = (document.body?.innerText || '').slice(0, 200).replace(/\n/g,' ');
    dbg('unknown screen: pwFields=' + pwCount + ' body="' + bodySnip + '"');
    return 'unknown_screen';
  }

  if (screen === 'verify_pending') {
    const existing = await getAccount(hostname);
    dbg('verify_pending screen, existing=' + existing?.status);
    if (existing) {
      const verified = await runGmailVerify(profile.email,
        existing.status === 'forgot_password_pending' ? 'reset' : 'verify',
        hostname
      );
      if (verified) {
        await setAccount(hostname, { status: 'verified', verifiedAt: Date.now() });
        return 'needs_gmail_verify';
      }
      return 'error';
    }
  }

  const existing = await getAccount(hostname);
  dbg('existing account: ' + (existing ? existing.status : 'none'));

  // Stale/failed account — clear it and start fresh
  // pending_creation older than 3 min = something went wrong mid-create
  const pendingCreationStale = existing?.status === 'pending_creation' && Date.now() - existing.createdAt > 180000;
  if (existing && (['creation_failed', 'reset_failed', 'verification_failed', 'sign_in_error', 'reset_limit'].includes(existing.status) || pendingCreationStale)) {
    dbg('clearing stale account status=' + existing.status);
    await deleteAccount(hostname);
    // fall through to create-account path below
  } else if (existing && existing.status === 'pending_creation') {
    // Fresh pending_creation — check current screen, might be logged in already
    const s = detectScreen();
    dbg('pending_creation, current screen=' + s);
    if (s === 'logged_in_home' || s === 'application_form') {
      await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), lastSignInAt: Date.now() });
      return 'account_created_verified';
    }
    if (s === 'email_button_step' || s === 'signin' || s === 'signin_email_step') {
      const signInResult = await runSignIn(profile, password);
      if (signInResult === 'unverified') {
        dbg('pending_creation sign-in says unverified — attempting Gmail verification');
        await setAccount(hostname, { email: profile.email, password, status: 'pending_verification',
          createdAt: existing.createdAt || Date.now() });
        const verified = await runGmailVerify(profile.email, 'verify', hostname);
        if (verified) {
          await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), failedAttempts: 0 });
          return 'needs_gmail_verify';
        }
      }
      if (signInResult === 'sign_in_error') {
        dbg('pending_creation sign-in failed without unverified signal — not opening Gmail');
        await persistWorkdayAuthSnapshot('pending-creation-signin-failed');
        await setAccount(hostname, { status: 'creation_failed', notes: 'pending_creation_signin_failed' });
      }
      return signInResult;
    }
    // Unknown/transitional — let it proceed to create or sign in
    await deleteAccount(hostname);
  } else if (existing && ['verified', 'exists_try_signin', 'needs_signin'].includes(existing.status)) {
    // E2E mode requires a tenant-specific Workday account. Older runs may have stored the base
    // Gmail address for this tenant; do not let that stale record override the current alias.
    if (existing.email && existing.email !== profile.email) {
      dbg('stored account email ' + existing.email + ' does not match tenant alias ' + (profile.email || 'none') + ' — clearing and retrying create path');
      await deleteAccount(hostname);
      if (sessionStorage.getItem('pja_wd_auth_alias_retry_' + hostname) !== '1') {
        sessionStorage.setItem('pja_wd_auth_alias_retry_' + hostname, '1');
        return await run(profile, password);
      }
    }
    const effectiveProfile = profile;
    if (existing.email && existing.email !== profile.email) {
      dbg('continuing with tenant alias after stale stored-account cleanup');
    }
    const signInResult = await runSignIn(effectiveProfile, existing.password || password);
    if (signInResult === 'sign_in_error') {
      dbg('stored account sign-in failed — trying forgot-password recovery before create path');
      const resetResult = await runForgotPassword(profile, password);
      if (resetResult === 'needs_gmail_verify' || resetResult === 'signed_in' || resetResult === 'account_created_verified') {
        return resetResult;
      }
      dbg('forgot-password recovery failed after stored account sign-in error — clearing account and retrying create path once');
      await deleteAccount(hostname);
      if (sessionStorage.getItem('pja_wd_auth_create_retry_' + hostname) !== '1') {
        sessionStorage.setItem('pja_wd_auth_create_retry_' + hostname, '1');
        return await run(profile, password);
      }
      return 'error';
    }
    return signInResult;
  } else if (existing && existing.status === 'pending_verification') {
    dbg('pending verification — resuming Gmail flow');
    const verified = await runGmailVerify(profile.email, 'verify', hostname);
    if (verified) {
      await setAccount(hostname, { status: 'verified', verifiedAt: Date.now() });
      return 'needs_gmail_verify';
    }
    if (Date.now() - existing.createdAt > 86400000) {
      await deleteAccount(hostname);
      // fall through to create
    } else {
      return 'error';
    }
  }

  // No account (or just cleared) — navigate to create-account form
  const createLink = document.querySelector('[data-automation-id="createAccountLink"]') ||
    Array.from(document.querySelectorAll('a, button')).find(el =>
      /create.{0,10}account|register/i.test(el.innerText?.trim())
    );

  dbg('createLink found=' + !!createLink + ' currentScreen=' + screen);

  if (createLink) {
    createLink.click();
    dbg('clicked createLink, waiting for create-account form...');
    // Wait up to 5s for 2 password fields to appear
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await sleep(400);
      if (document.querySelectorAll('input[type=password]').length >= 2) break;
    }
    dbg('after click: screen=' + detectScreen() + ' pwFields=' + document.querySelectorAll('input[type=password]').length);
  } else {
    dbg('no createLink found — proceeding to runCreateAccount anyway');
  }

  return await runCreateAccount(profile, password);
}

async function lifecycle(profile) {
  const hostname = location.hostname;
  const tenantEmail = pjaWorkdayTenantEmail(profile && profile.email, hostname);
  const account = await getAccount(hostname);
  return {
    hostname,
    screen: detectScreen(),
    tenantEmail,
    accountStatus: account && account.status || 'none',
    failedAttempts: account && account.failedAttempts || 0,
    updatedAt: account && account.updatedAt || null,
    engine: window.PJAWorkdayEngine && typeof window.PJAWorkdayEngine.snapshot === 'function'
      ? window.PJAWorkdayEngine.snapshot(document)
      : null,
  };
}

window.pjaWorkdayAuth = { run, lifecycle, pjaWorkdayTenantEmail, _detectScreen: detectScreen };
console.log('PJA: workday-auth.js loaded on', location.hostname);
})();
