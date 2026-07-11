# External Apply — Blocker Analysis

**Original analysis:** 2026-06-02 (Greenhouse / Workday / Lever).
**Status refresh:** 2026-07-10 — the Tier-1 form-fill blockers that stopped *every* application are
**resolved**. What remains are external-service limits (rate-limits, daily caps, account locks) and
inherently manual steps, not code gaps. This file records how each was addressed so the mechanisms
aren't accidentally removed.

---

## ATS platforms in scope

| ATS | Public API adapter | Auto-apply status |
|-----|--------------------|-------------------|
| Greenhouse | ✅ `sourcing/adapters/greenhouse.js` | Works (comboboxes + CDP commit) |
| Lever | ✅ `lever.js` | Works |
| Ashby | ✅ `ashby.js` | Works (bypasses degraded-CDP) |
| Workday | ✅ `workday.js` (per-tenant CXS) | Works e2e incl. account creation |
| SmartRecruiters | ✅ `smartrecruiters.js` | Guest one-click form |
| LinkedIn | scrape-only (no API) | Easy Apply engine |
| Indeed | scrape-only | Indeed Apply engine (pauses on anti-bot) |

Registry: `sourcing/sources.json`, **195 companies**.

---

## TIER 1 — resolved (were "blocks every application")

### BLOCKER 1 — Greenhouse custom comboboxes — ✅ RESOLVED
ARIA `role="combobox"` widgets (not `<select>`) are handled by **`pjaFillCombobox(input, value, key)`**
(`content/autofill.js` ~L1097). It opens the flyout, matches the option, and commits via the React
fiber bridge (`pja:reactselect` → `fiber-main.js`) or a **trusted CDP click**
(`pjaForceReactSelectCommit` / `pjaForceCountryField` / `pjaForceAllPolicyReactSelects`) for the
Greenhouse "remix" selects that only persist on `isTrusted` events. Covered by `test/unit/combobox.test.js`.

### BLOCKER 2 — Workday account creation before the form — ✅ RESOLVED
`content/workday-auth.js` (`window.pjaWorkdayAuth.run`) is a full `detectScreen()` state machine:
sign-in, **create-account** (`runCreateAccount`), forgot-password, and **Gmail email verification**
(`runGmailVerify` → `WD_OPEN_GMAIL_TAB` scrapes the confirmation link). Per-tenant accounts persist in
`pja_workday_accounts[hostname]`; the tenant password comes from `pja_job_password` (Settings).
Fresh accounts usually auto-sign-in (plus-addressed email); verified tenants resume via `pja_wd_pending_apply`.

### BLOCKER 3 — Resume file upload — ✅ RESOLVED
Resume is stored as base64 in Settings (`pja_resume_b64` / `pja_resume_filename`, ≤9 MB) and injected
via `DataTransfer` in `tryInjectResume(profile, answers)` (`content/external-apply.js` ~L1427).

### BLOCKER 4 — Empty email/phone in default profile — ⚙️ USER ACTION
Still user-supplied via Settings; Settings now shows a warning when email/phone/resume/Workday-password
are missing. No code fix needed — required inputs.

---

## TIER 2 — resolved

### BLOCKER 5 — Open-ended / custom screening questions — ✅ RESOLVED
`pjaFillUnknownTextFields` batches unmatched required text/select/radio questions into one
`ANSWER_QUESTIONS` message → dev-server `/answer-questions`, which generates truthful answers from
profile + resume + `pja_prefs`. Answers are persisted to `pja_answers` so repeats are instant.

### BLOCKER 6 — Shadow DOM not traversed — ✅ RESOLVED
`findMissingRequired()` and `findButton()` now use **`pjaQueryAllExt`** (shadow-root-aware) instead of
`document.querySelectorAll`, so Workday / Rippling inputs inside shadow roots are found.

### BLOCKER 7 — Greenhouse phone country-code picker — ✅ RESOLVED
`retryPhoneFill(profile)` (`content/external-apply.js` ~L2043) re-fills the `tel` input and handles the
adjacent country picker after the initial pass.

---

## TIER 3 — handled

- **BLOCKER 8 — Google SSO:** external-apply detects SSO-only forms and records `google_sso_only`
  instead of blindly filling Google's OAuth page.
- **BLOCKER 9 — Workday "Save and Continue" variants:** the multi-step loop matches
  `bottomNavigationNext` / `pageFooterNextButton` / Workday `click_filter` next buttons.
- **Dead / closed postings:** detected via `pjaIsClosedPosting` → recorded as `posting_not_found`
  (previously misread as `no_apply_btn`).
- **Chatbot-apply pages:** short-circuit to `chatbot_apply_manual` rather than failing opaquely.

---

## What actually limits throughput now

Not form-filling — the remaining constraints are external and per-service:

- **LinkedIn Easy Apply daily submission cap** (engine halts on `daily_limit`).
- **Indeed anti-bot interstitials** (engine pauses the queue with `reason:'captcha'`, does not advance).
- **Workday account lock / captcha** on some tenants (`workday_account_locked` / `workday_captcha`).
- **Degraded CDP** — trusted clicks stop landing; recovered by the self-heal ladder
  (`cdp-selfheal.js` → detach/reattach → `/reload` → `/restart-chrome`). Ashby & Lever bypass it entirely.
- **Genuine-fit supply** — after prior batches, fresh 70+ TN-eligible CA roles are the real ceiling,
  not the tooling.

See `test/test-jobs.json` for the e2e fixture set.
