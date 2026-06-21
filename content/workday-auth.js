(function() {
'use strict';
if (window.pjaWorkdayAuth) return;

const DEFAULT_JOB_PASSWORD = 'ChangeMe#2025!';

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
    return /sign.?in with email|continue with email|use email|sign.?in with your email/i.test(t);
  });
}

function detectScreen() {
  const pwFields = document.querySelectorAll('input[type=password]');
  const emailField = document.querySelector('input[data-automation-id="email"], input[type=email]');

  if (document.querySelector('[data-automation-id="legalNameSection_firstName"], [data-automation-id="bottomNavigationSubmit"]')) {
    return 'application_form';
  }

  if (
    document.querySelector('[data-automation-id="verifyEmailPage"], [data-automation-id="checkYourEmail"]') ||
    /check your email|verification email sent|verify your email/i.test(document.body?.innerText || '')
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
    document.body?.innerText &&
    /sign.?in with google|continue with google/i.test(document.body.innerText)
  ) {
    return 'sso_only';
  }

  if (pwFields.length >= 2) return 'createaccount';
  if (pwFields.length === 1) return 'signin';
  if (emailField && pwFields.length === 0) return 'signin_email_step';

  // User is logged in — Workday auto-signed in after account creation, or already had a session.
  // Candidate Home nav item only appears when authenticated.
  // NOTE: some tenants use utilityButtonSignIn instead of signInLink — treat both as "not logged in".
  const hasSignInBtn = document.querySelector(
    '[data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], [data-automation-id="createAccountLink"]'
  );
  if (
    document.querySelector('[data-automation-id="navigationItem-Candidate Home"]') ||
    (document.querySelector('[data-automation-id="utilityMenuButton"]') && !hasSignInBtn)
  ) {
    return 'logged_in_home';
  }

  // "Start Your Application" intermediary — Workday shows this before login when navigating
  // directly to an /apply URL. Must click "Apply Manually" to reach the actual auth form.
  if (document.querySelector('[data-automation-id="applyManually"]') ||
      (document.querySelector('[data-automation-id="autofillWithResume"]')) ||
      (/apply\s+manually/i.test(document.body?.innerText || '') &&
       /autofill\s+with\s+resume/i.test(document.body?.innerText || ''))) {
    return 'start_application';
  }

  return 'unknown';
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
  const searchQuery = purpose === 'reset'
    ? 'from:(no-reply@myworkday.com OR noreply@workday.com) subject:(reset) in:inbox newer_than:10m'
    : 'from:(no-reply@myworkday.com OR noreply@workday.com) in:inbox newer_than:10m';

  const { pja_wd_gmail_session: existingSession } = await new Promise(r =>
    chrome.storage.local.get('pja_wd_gmail_session', r)
  );
  if (existingSession && existingSession.hostname === hostname &&
      Date.now() - existingSession.startedAt < 120000) {
    console.log('PJA workday-auth: Gmail flow already in progress, waiting...');
    return await waitForVerifyComplete(hostname, 90000);
  }

  await new Promise(r => chrome.storage.local.remove('pja_wd_verify_result', r));

  const resp = await new Promise(resolve =>
    chrome.runtime.sendMessage({
      type: 'WD_OPEN_GMAIL_TAB',
      searchQuery,
      hostname,
      purpose,
    }, resolve)
  );

  if (!resp?.ok) {
    console.log('PJA workday-auth: WD_OPEN_GMAIL_TAB failed', resp);
    return false;
  }

  return await waitForVerifyComplete(hostname, 90000);
}

async function waitForVerifyComplete(hostname, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const { pja_wd_verify_result: result } = await new Promise(r =>
      chrome.storage.local.get('pja_wd_verify_result', r)
    );
    if (result && result.hostname === hostname && result.ts > t0) {
      await new Promise(r => chrome.storage.local.remove('pja_wd_verify_result', r));
      return result.success === true;
    }
  }
  return false;
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

  if (screen === 'application_form') {
    await setAccount(hostname, { status: 'verified', verifiedAt: Date.now(), lastSignInAt: Date.now() });
    dbg('account_created_verified (went straight to app form)');
    return 'account_created_verified';
  }

  if (screen === 'verify_pending') {
    dbg('verify_pending — opening Gmail for verification');
    await setAccount(hostname, { status: 'pending_verification' });
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

  if (screen === 'signin' || screen === 'signin_email_step') {
    dbg('account created, now on signin screen — signing in');
    return await runSignIn(profile, password);
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
    if (s2 === 'signin' || s2 === 'signin_email_step') {
      dbg('delayed signin screen — signing in');
      return await runSignIn(profile, password);
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

  await setAccount(hostname, { notes: poll.error });
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

  const emailField = document.querySelector('input[data-automation-id="email"], input[type=email]');
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
      sel: '[data-automation-id="resetPasswordSubmitButton"], button[type=submit]'
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

async function run(profile, password) {
  const hostname = location.hostname;

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
        sel: '[data-automation-id="signInWithEmail"], [data-automation-id*="emailSignIn"]'
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
      applyManuallyBtn.click();
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
  if (existing && (['creation_failed', 'reset_failed', 'verification_failed'].includes(existing.status) || pendingCreationStale)) {
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
    // Unknown/transitional — let it proceed to create or sign in
    await deleteAccount(hostname);
  } else if (existing && ['verified', 'exists_try_signin', 'needs_signin'].includes(existing.status)) {
    // Use stored account email when profile.email is missing
    const effectiveProfile = (!profile.email && existing.email)
      ? { ...profile, email: existing.email } : profile;
    return await runSignIn(effectiveProfile, password);
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

window.pjaWorkdayAuth = { run };
console.log('PJA: workday-auth.js loaded on', location.hostname);
})();
