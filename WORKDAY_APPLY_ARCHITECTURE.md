# Workday apply architecture

Goal: Workday jobs should not run as generic external ATS jobs with scattered special cases.
When a job URL is identified as Workday (`workday.com` / `myworkdayjobs.com`), the extension
should route it through a Workday-specific engine made of explicit states, typed field models,
verifiers, and bounded LLM-assisted recovery.

## Current routing

The ranked apply dispatcher still opens Workday jobs through the external queue:

1. `background.js` selects a ranked job and calls `pjaLaunchExternalSingle()`.
2. The ATS tab loads `content/autofill.js`, `content/workday-auth.js`, and
   `content/external-apply.js`.
3. `external-apply.js` detects the Workday hostname and runs Workday-specific branches:
   auth, step filling, step advance, Self Identify, diagnostics, and submit.

This keeps the current extension flow intact while allowing Workday-specific behavior to be
extracted behind cleaner interfaces over time.

## Target Workday engine states

Workday should be treated as a state machine:

```text
JOB_POSTING
APPLY_START
AUTH_EMAIL_BUTTON
AUTH_SIGNIN
AUTH_CREATE_ACCOUNT
AUTH_VERIFY_EMAIL
AUTH_FORGOT_PASSWORD
MY_INFORMATION
MY_EXPERIENCE
APPLICATION_QUESTIONS
VOLUNTARY_DISCLOSURES
SELF_IDENTIFY
REVIEW
SUBMIT
CONFIRMED
BLOCKED_CAPTCHA
BLOCKED_AUTH
BLOCKED_FIELD
```

Each state should own:

- `detect()` — determine whether the active page is this state.
- `fill()` — perform only state-relevant fills.
- `verify()` — prove all state requirements are committed.
- `advance()` — perform the next action and verify page/step transition.
- `recover()` — call the bounded recovery loop when verification or advance fails.

## Field model

Every visible Workday control should be normalized before filling:

```js
{
  id,
  step,
  label,
  kind: 'text' | 'selectinput' | 'buttonPrompt' | 'checkbox' | 'date' | 'radio',
  required,
  invalid,
  value,
  selectedText,
  options,
  answerSource,
}
```

Fillers should operate on this model rather than repeatedly scanning arbitrary DOM selectors.

## Recovery loop

`external-apply.js` now has a bounded recovery loop:

```text
detect blocker
→ capture DOM summary + screenshot through background/dev-server
→ ask /apply-help for structured diagnosis
→ execute only whitelisted recovery actions
→ wait for page mutation
→ capture new state
→ repeat up to the attempt cap
→ persist transcript to pja_recovery_log
```

Allowed Workday-specific actions:

- `retry_workday_prompt_buttons`
- `retry_workday_app_questions`
- `retry_workday_terms_checkbox`
- `retry_workday_sid_transaction`
- `retry_workday_advance`
- `retry_workday_auth_reset`
- `capture_only`

The loop must never execute arbitrary selectors/code from the LLM. The LLM can diagnose and
choose from whitelisted recovery contracts only.

## Reliability priorities

1. Extract Workday state detection and field modeling from `external-apply.js`.
2. Convert auth into a tenant account lifecycle manager:
   create → verify Gmail → sign in → reset password → terminal auth/captcha blocker.
3. Rebuild Self Identify as a dedicated transaction with internal-state verification, not only
   visible DOM verification.
4. Make every Workday step advance require a proven transition.
5. Expand fixture tests for My Information, Application Questions, EEO, terms, SID, and Review.

