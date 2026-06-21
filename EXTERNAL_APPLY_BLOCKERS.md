# External Apply — Blocker Analysis
Generated: 2026-06-02 | Based on: Greenhouse (Harbinger), Workday (Applied Materials), Lever (SQA Services)

---

## ATS Platforms Tested

| ATS | Example Company | Form Type | Account Required | Standard `<select>`? |
|-----|----------------|-----------|-----------------|---------------------|
| Greenhouse (job-boards) | Harbinger Motors, CHAOS, Astranis | Single-page | No | ❌ Custom comboboxes |
| Workday | Applied Materials, KLA, Intel | 7-step wizard | ✅ Yes | Mix |
| Lever | SQA Services, HRL Labs | Single-page | No | ✅ EEO fields |
| Tesla (custom) | Tesla | Single-page | No | Unknown |

---

## TIER 1 — Blocks Every Application

### BLOCKER 1: Greenhouse custom comboboxes (all dropdowns)
**Files:** `content/autofill.js`
**Scope:** Affects ~50% of ATS forms (Greenhouse is the most popular ATS for tech companies)

All Greenhouse dropdowns are ARIA combobox widgets — `<input type="text" role="combobox">` + toggle button + flyout `<listbox>`. Not `<select>` elements.

- `pjaFillSelect` only handles `<select>` — skips these entirely
- `pjaSetNative` sets the text input value but doesn't trigger the flyout or select an option
- Result: sponsorship, gender, veteran, disability, relocate all left at "Select..." → form blocks submission

**Fields affected:** requireSponsorship, willingToRelocate, gender, veteran, disability, school, degree

**Fix:** Add `pjaFillCombobox(input, value)` that:
1. Focuses the input, sets its value via pjaSetNative
2. Dispatches `input` event to trigger the flyout
3. Waits up to 500ms for a listbox to appear (MutationObserver or polling)
4. Clicks the option whose text best matches the value
5. Update `pjaFillForm` Pass 1 to detect `el.getAttribute('role') === 'combobox'` and route to `pjaFillCombobox`

**Status:** ⬜ Not fixed

---

### BLOCKER 2: Workday requires account creation before showing form
**Files:** `content/external-apply.js`
**Scope:** Blocks all Workday companies (Applied Materials, KLA, Intel, TSMC, Lam Research, GlobalFoundries)

Workday apply flow: Step 1 = "Create Account" with Email + Password fields. Our `handleSignIn` detects a password field and bails with `needs_login`. User is never shown the application form.

Can't fully automate (password creation requires user), but we can:
- Fill the email field automatically
- Prompt user to type a password and click "Create Account"
- Resume filling after account creation (via a "Resume external apply" button in sidebar)

**Fix:** Change `handleSignIn` to NOT bail on Workday account-creation pages — instead fill email, leave password for user, show sidebar prompt "Please enter a password to create your Workday account, then click Resume."

**Status:** ⬜ Not fixed

---

### BLOCKER 3: Resume file upload required on every ATS
**Files:** `content/external-apply.js`, `settings/settings.js`
**Scope:** Blocks 100% of applications

All ATS forms require a resume file upload as their first required field. File inputs can't be set programmatically (browser security blocks `input[type=file].value = ...`).

Options:
- (a) **Manual**: Show a persistent "Please attach your resume" notification; mark the field so user knows which file input to use
- (b) **Settings**: Add a "Resume file" setting where user can store a base64 data-URL of their resume; then use `DataTransfer` to set the file input value (works in Chrome extensions with `scripting` permission)

`DataTransfer` approach:
```javascript
const dt = new DataTransfer();
dt.items.add(new File([base64Blob], 'resume.pdf', { type: 'application/pdf' }));
fileInput.files = dt.files;
fileInput.dispatchEvent(new Event('change', { bubbles: true }));
```

**Fix:** (a) Add resume data-URL field to settings page. (b) In `pjaFillForm`, detect `input[type=file]` and attempt DataTransfer fill if `profile.resumeDataUrl` is set. 

**Status:** ⬜ Not fixed

---

### BLOCKER 4: Email and phone are empty in default profile
**Files:** `content/autofill.js` (`PJA_DEFAULT_PROFILE`)
**Scope:** Every application — email and phone are required fields everywhere

`PJA_DEFAULT_PROFILE.email = ''` and `PJA_DEFAULT_PROFILE.phone = ''`. The `if (key && key in profile) return` guard prevents answer bank from filling them, but they stay blank. Every form has these as required.

**Fix:** User action required — must fill email and phone in Settings page. Add a warning banner in the extension popup/settings if email or phone is empty.

**Status:** ⬜ User must act

---

## TIER 2 — Blocks Specific Platforms or Forms

### BLOCKER 5: Custom/open-ended questions on Lever forms
**Files:** `content/external-apply.js`
**Scope:** Any ATS with job-specific free-text questions

Lever (and many ATS) add job-specific required text questions: "How many years experience with PCBA?", "Describe your IPC-610 knowledge", etc. These:
- Don't match any PJA_FIELD_RULES key
- Often have no entry in pja_answers
- Are required → findMissingRequired detects them → apply fails

**Fix:** When findMissingRequired finds open-ended text questions and the dev server is available, send them to `/analyze` with the candidate's profile for AI-generated answers. Cache responses in pja_answers. This turns one-time failures into learned answers.

**Status:** ⬜ Not fixed

---

### BLOCKER 6: Shadow DOM not traversed in external-apply.js
**Files:** `content/external-apply.js`
**Scope:** Workday (heavy shadow DOM), Rippling, some Greenhouse modals

`findMissingRequired()` and `findButton()` use `document.querySelectorAll` directly, not `pjaQueryAll` (which traverses all shadow roots). On Workday and Rippling, form inputs live in shadow DOM and won't be found.

**Fix:** Replace `root.querySelectorAll(...)` in `findMissingRequired` with `pjaQueryAll(...)` calls. Replace `document.querySelectorAll('button...')` in `findButton` similarly.

**Status:** ⬜ Not fixed

---

### BLOCKER 7: Greenhouse phone field uses country-code picker widget
**Files:** `content/autofill.js`
**Scope:** Greenhouse job boards

The Greenhouse phone field is two parts: a country-code combobox (opens a 244-country dialog) and a `type="tel"` input. Our code fills the tel input correctly but leaves the country code as whatever default the browser or form set.

For a US number, the country code must be US (+1). The dialog is triggered by a separate "Select country" button.

**Fix:** After filling a `type="tel"` input, check if there's an adjacent country-picker button. If the profile phone doesn't start with `+`, prepend +1 (US) and look for a "United States" option in the adjacent listbox.

**Status:** ⬜ Not fixed

---

## TIER 3 — Edge Cases / Minor

### BLOCKER 8: Google Sign-In click proceeds to OAuth page
After clicking "Apply with Google" or "Continue with Google", `handleSignIn` returns `'google_clicked'` and `runExternalApply` proceeds to fill the form — but the page is now Google's OAuth page, not the ATS form. Fills nothing, then tries to submit Google's page.

**Fix:** After clicking Google SSO, wait up to 10s for a redirect back to the ATS. If no ATS form appears, bail with reason: 'google_sso_redirect'.

---

### BLOCKER 9: Workday "Save and Continue" button text not matched
`findButton(/^next$|^continue$|^next step$/i)` won't match "Save and Continue", "Next Step", or Workday's "Next" buttons which have icon-only labels or ARIA labels.

**Fix:** Add "save" and "save and continue" to the Next button regex.

---

### BLOCKER 10: Apply button found on description page may open new tab
Some ATS "Apply" buttons open a new tab instead of navigating. The SPA-detection loop (`location.href !== urlBefore`) correctly handles navigation, but a new-tab open would leave the original tab stuck.

**Fix:** Already partially handled by the max 3 descClick guard. Low priority.

---

## Priority Fix Order

| # | Blocker | Impact | Effort | Status |
|---|---------|--------|--------|--------|
| 1 | Greenhouse comboboxes | High — 50% of forms | Medium | ⬜ |
| 2 | Shadow DOM in external-apply | High — Workday/Rippling | Low | ⬜ |
| 3 | Resume file upload | High — all forms | High | ⬜ |
| 4 | Empty email/phone warning | High — all forms | Low | ⬜ |
| 5 | Open-ended question AI answers | Medium — Lever/custom | Medium | ⬜ |
| 6 | Workday account creation flow | High — top employers | High | ⬜ |
| 7 | Phone country-code picker | Low — Greenhouse | Low | ⬜ |
| 8 | Google SSO handling | Low — rare | Low | ⬜ |
| 9 | Workday Next button variants | Low — post-account | Low | ⬜ |

## Test Dataset
See `test/test-jobs.json` for 8 real job URLs covering Greenhouse, Workday, Lever, Tesla ATS platforms.
