# Bug Report — the candidate Job Extension
Generated: 2026-05-31 | Scope: autofill correctness, test-form accuracy, e2e on real ATS platforms

---

## BUG 1 — CRITICAL — Sponsorship select: `noMatch` branch contains inverted conditions
**File:** `content/autofill.js:172`
**Severity:** Critical — causes the candidate to incorrectly declare she NEEDS sponsorship

### What the code does
```javascript
const noMatch = isNo && (
  ot === 'no' ||
  ot.startsWith('no,') ||
  ot.includes('not authorized') ||      // ← WRONG
  ot.includes('will require sponsorship') || // ← WRONG — belongs in yesMatch
  ot === 'yes, i will require'           // ← WRONG — belongs in yesMatch
);
```

### Why it breaks
`profile.requireSponsorship = 'No'` → `lv = 'no'` → `isNo = true` → `noMatch` fires.

If a dropdown option says **"Yes, I will require sponsorship"** (common on Greenhouse, Lever, Workday),
`ot.includes('will require sponsorship')` is true → the extension **selects it**, claiming the candidate
WILL need sponsorship. This is the exact opposite of reality and the candidate's biggest differentiator.

Likewise `ot === 'yes, i will require'` selects the YES-sponsorship option for a NO-sponsorship profile.
And `ot.includes('not authorized')` selects "Not authorized / needs sponsorship" options for a
No-sponsorship profile.

### How to fix
Move the three wrong conditions into `yesMatch`:
```javascript
const yesMatch = isYes && (
  ot === 'yes' || ot.startsWith('yes,') ||
  ot.includes('authorized') || ot.includes('eligible') ||
  ot.includes('i am authorized') ||
  ot.includes('will require sponsorship') ||  // ← move here
  ot === 'yes, i will require'                // ← move here
);
const noMatch = isNo && (
  ot === 'no' || ot.startsWith('no,') ||
  ot === 'no, i will not require' ||
  ot.includes('not required') || ot.includes('will not require')
);
```

---

## BUG 2 — CRITICAL — `pjaSetNative` called on `<select>` elements in answer-bank path
**File:** `content/autofill.js:480`
**Severity:** Critical — selects silently not updated on React-based ATS forms

### What the code does
```javascript
// Pass 1 fallback — answer bank
if (banked) { pjaSetNative(el, banked); filled++; }  // el can be a <select>
```

`pjaSetNative` uses `window.HTMLInputElement.prototype` for non-textarea elements:
```javascript
const proto = el.tagName === 'TEXTAREA'
  ? window.HTMLTextAreaElement.prototype
  : window.HTMLInputElement.prototype;  // ← wrong for SELECT
```

### Why it breaks
`HTMLInputElement.prototype.value` setter does not exist on `HTMLSelectElement`. For vanilla HTML selects,
`el.value = banked` in the `catch` branch sets the value string directly — this only works if the string
matches an option's `value` attribute exactly, which banked answers (raw text) often don't.
For React-based selects (Greenhouse, Lever, Workday), React's synthetic event system is never triggered,
so the component state stays empty and the SELECT is counted in `filled` even though it wasn't actually filled.

### How to fix
In the answer-bank fallback path, route SELECTs through `pjaFillSelect`:
```javascript
if (banked) {
  const ok = el.tagName === 'SELECT'
    ? pjaFillSelect(el, banked, null)
    : (pjaSetNative(el, banked), true);
  if (ok) filled++;
}
```

---

## BUG 3 — CRITICAL — `pjaClickRadio` missing `input` event; React radio buttons never update
**File:** `content/autofill.js:368–373`
**Severity:** Critical — radio autofill appears to work visually but form submits empty values on React ATS

### What the code does
```javascript
function pjaClickRadio(radio) {
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}
```

### Why it breaks
React tracks form input state via the **`input`** event, not `change`. Without dispatching
`new Event('input', { bubbles: true })` before setting `.checked`, React's internal fiber state is
never updated. The radio visually appears selected but the controlled component value remains
whatever it was before (usually empty/null). On form submission, the ATS receives the old value.

Compare with `pjaSetNative` which correctly dispatches `input`, `change`, and `blur`.

Affects all Greenhouse, Lever, and most Workday radio groups (work-auth, sponsorship, relocation,
EEO fields are all commonly radios on these platforms).

### How to fix
```javascript
function pjaClickRadio(radio) {
  const nativeInputDesc = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'checked'
  );
  if (nativeInputDesc?.set) nativeInputDesc.set.call(radio, true);
  else radio.checked = true;
  radio.dispatchEvent(new Event('input',  { bubbles: true }));
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}
```

---

## BUG 4 — HIGH — Substring match `ot.includes(lv)` causes wrong select options with short values
**File:** `content/autofill.js:173`
**Severity:** High — selects wrong options on ATS forms with verbose option text

### What the code does
```javascript
const partial = ot.includes(lv) || (lv.length > 4 && lv.includes(ot.slice(0, 5)));
```

### Why it breaks
When `lv = 'no'` (e.g. `requireSponsorship = 'No'`, `willingToRelocate = 'No'`), **any** option whose
display text contains the substring `"no"` matches — including:
- `"I am not authorized"` → "n**o**t" contains "no"
- `"Unknown"` → "unkn**o**wn" contains "no"  
- `"No preference"` → correct ✓
- `"No, I am not a protected veteran"` → correct ✓ (but already caught by earlier checks)

Similarly `lv = 'yes'` matches anything containing `"yes"`:
- `"Yes, I will require sponsorship"` would be selected for a `workAuth = 'Yes'` field if the
  earlier exact/boolean match failed — that's a different field's option appearing in the same dropdown.

On many verbose ATS dropdowns, the "No" option is listed LAST (e.g. Workday puts the negative option
at the bottom). The `partial` match picks the FIRST matching option it finds, which could be the wrong one.

### How to fix
Add a length guard so partial match only fires for longer target values:
```javascript
const partial = lv.length > 3 && (ot.includes(lv) || (lv.length > 4 && lv.includes(ot.slice(0, 5))));
```
This prevents single-word values like `'no'` and `'yes'` from substring-matching everywhere.

---

## BUG 5 — CRITICAL — `BATCH_SCORE_JOBS` and `FIND_OUTREACH_PEOPLE` always call dev server
**File:** `background.js:801`, `background.js:893`
**Severity:** Critical — shortlist scoring and outreach generation never work without dev server

### What the code does
Both handlers call `fetch(`${DEV_SERVER}/batch-score`, ...)` and `fetch(`${DEV_SERVER}/outreach`, ...)`
with **no `DEV_MODE` check**.

```javascript
// background.js:801 — inside BATCH_SCORE_JOBS, no DEV_MODE guard
const resp = await fetch(`${DEV_SERVER}/batch-score`, { ... });

// background.js:893 — inside FIND_OUTREACH_PEOPLE, no DEV_MODE guard
const resp = await fetch(`${DEV_SERVER}/outreach`, { ... });
```

### Why it breaks
`analyzeJob()` (single-job analysis) correctly checks `if (DEV_MODE)` before calling the dev server.
But `BATCH_SCORE_JOBS` and `FIND_OUTREACH_PEOPLE` skip this check entirely and **always** hit
`http://localhost:6174`. 

Consequences:
- When `DEV_MODE = false` (production): bulk scanner never scores jobs — every batch silently
  fails and jobs are stuck as `'pending'` with `fitScore: null`.
- When `DEV_MODE = true` but server is not running: same failure, no scores shown.
- The `FIND_OUTREACH_PEOPLE` error handler falls back to template messages, so outreach partially
  works, but recruiter/HM lookups are just generic LinkedIn searches rather than generated content.

### How to fix
Wrap both handlers in a `DEV_MODE` check or add Nano/Claude paths as fallback:
```javascript
// BATCH_SCORE_JOBS
if (!DEV_MODE) {
  // score individually via analyzeJob template engine
  const scored = await Promise.all(toScore.map(j => analyzeJob(j)));
  // ... apply scores
} else {
  const resp = await fetch(`${DEV_SERVER}/batch-score`, ...);
  // ...
}
```

---

## BUG 6 — HIGH — `DEV_MODE` hardcoded `true` in background.js blocks Gemini Nano in all environments
**File:** `background.js:7`
**Severity:** High — Gemini Nano (free, on-device AI) is permanently disabled

### What the code does
```javascript
const DEV_MODE = true;  // ← hardcoded
```

### Why it breaks
`analyzeJob()` has `if (DEV_MODE) { ... return; }` at the top — when `DEV_MODE = true`, it **never**
reaches the Nano or Claude tiers. Every analysis goes to localhost:6174. If the dev server is not
running, it falls back to the template engine. This means:
- Gemini Nano is completely bypassed for all users who haven't set up the dev server.
- The Nano availability check and download flow shown in the UI is never triggered.
- New users see "Smart Template" mode (weakest) and wonder why Nano isn't being used.

This should be `false` for production / normal use and only `true` during active development.

---

## BUG 7 — HIGH — `pjaFillSelect` `noMatch` also catches "not authorized" for sponsorship fields
**File:** `content/autofill.js:172`
**Severity:** High — related to BUG 1 but a separate wrong condition

### What the code does
```javascript
const noMatch = isNo && (
  ...
  ot.includes('not authorized')   // ← ambiguous context
  ...
);
```

### Why it breaks
This condition was intended for `workAuth = 'No'` (person is not authorized to work → option says
"not authorized"). But `pjaFillSelect` is also called for `requireSponsorship = 'No'`.

If a combined "authorization / sponsorship" dropdown contains an option like
**"Not authorized to work — will require sponsorship"**, `ot.includes('not authorized')` fires
in `noMatch`, selecting an option that means "I am not authorized AND need sponsorship" for
the candidate's profile of `requireSponsorship = 'No'`.

These two fields (workAuth, requireSponsorship) have opposite semantics for the "No" value
and should not share the same matching logic.

### How to fix
Make `noMatch` context-aware using the `key` parameter that is already passed into `pjaFillSelect`:
```javascript
const noMatch = isNo && (
  ot === 'no' || ot.startsWith('no,') ||
  (key === 'workAuth' && ot.includes('not authorized')) ||
  (key === 'requireSponsorship' && (ot.includes('not required') || ot.includes('will not require')))
);
```

---

## BUG 8 — MEDIUM — Test form `zip` field: `name="postalCode"` but autofill matches via label
**File:** `test/test-apply-form.html:65`
**Severity:** Medium — works in browser but would silently fail in headless/unit tests that match by `name` attribute

### What the code does
```html
<input id="zip" name="postalCode" type="text" placeholder="Zip" autocomplete="postal-code">
```
The `name` attribute says `postalCode` but the profile key is `zip`. `pjaFillForm` classifies by label
text ("Zip Code" via `label[for="zip"]`), which correctly maps to key `zip`.

### Why it fails in tests
Any test that:
1. Does NOT render the label DOM (e.g., unit tests that create standalone input elements)
2. Falls through to the `name` attribute fallback in `pjaGetLabel`

...will get label text `"postalCode"` which does NOT match the `'zip'`, `'postal'`, or `'zip code'`
patterns. The field would be skipped and `zip` would not be filled.

The `autocomplete="postal-code"` is also unused by `pjaGetLabel` (it only uses placeholder, name, id).

### How to fix
Rename the `name` attribute to match expected classification:
```html
<input id="zip" name="zip" type="text" ...>
```
Or add `"postal-code"` to the `zip` key's patterns in `PJA_FIELD_RULES`.

---

## BUG 9 — MEDIUM — `content.js` listener returns `false` unconditionally, masking async intent
**File:** `content/content.js:16`
**Severity:** Medium — not currently broken but fragile

### What the code does
```javascript
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FORCE_OPEN') {
    ...
    sendResponse({ ok: true });
  }
  if (msg.type === 'AUTOFILL_TRIGGER') {
    if (typeof window.__pjaHandleAutofill === 'function') window.__pjaHandleAutofill();
    sendResponse({ ok: true });
  }
  return false;   // ← always returns false
});
```

### Why it matters
`handleAutofill()` in `content.js:434–452` triggers two sequential async `chrome.runtime.sendMessage`
calls (GET_PROFILE, then GET_ANSWERS). If `window.__pjaHandleAutofill` is ever refactored to be async
and call `sendResponse` asynchronously, the `return false` here would close the message channel before
the response arrives, causing `sendResponse` to silently fail.

Currently it works because `sendResponse({ ok: true })` is called synchronously before `return false`.

### How to fix
Return `false` only when not handling a known async path; return `true` if the message type
needs to keep the channel open:
```javascript
  if (msg.type === 'AUTOFILL_TRIGGER') {
    if (typeof window.__pjaHandleAutofill === 'function') window.__pjaHandleAutofill();
    sendResponse({ ok: true });
    return false;
  }
  return false;
```
(No functional change now, but guards against future async refactors.)

---

## BUG 10 — LOW — `STATUS_COLORS` in `content.js` is dead code; mismatches popup.js version
**File:** `content/content.js:28–34`
**Severity:** Low — no runtime failure, but misleading

### What the code does
```javascript
const STATUS_COLORS = {
  'Bookmarked': '#6366f1',
  'Applied': '#2563eb',
  'Outreach Sent': '#0891b2',
  'Interview': '#d97706',
  'Offer': '#16a34a',
  'Rejected': '#dc2626'
  // ← 'Shortlisted' is missing
};
```

### Why it matters
This constant is never referenced anywhere in `content.js`. Popup.js defines its own
`STATUS_COLORS` (with full `{bg, text}` objects) that is actually used for rendering. The
version in `content.js` is dead code and also omits `'Shortlisted'`. Any future refactor
that accidentally starts using this constant would produce `undefined` for Shortlisted jobs.

### How to fix
Delete the unused `STATUS_COLORS` constant from `content.js` entirely.

---

## Summary Table

| # | File | Line(s) | Severity | Description |
|---|------|---------|----------|-------------|
| 1 | autofill.js | 172 | **Critical** | `noMatch` has inverted sponsorship conditions; selects wrong option |
| 2 | autofill.js | 480 | **Critical** | `pjaSetNative` called on `<select>` in answer-bank path; React forms silently fail |
| 3 | autofill.js | 368–373 | **Critical** | `pjaClickRadio` missing `input` event; React radio state never updates |
| 4 | autofill.js | 173 | **High** | `ot.includes(lv)` substring match fires on short values like 'no'/'yes' |
| 5 | background.js | 801, 893 | **Critical** | BATCH_SCORE_JOBS + FIND_OUTREACH_PEOPLE always call dev server, no DEV_MODE guard |
| 6 | background.js | 7 | **High** | `DEV_MODE = true` hardcoded; blocks Gemini Nano in all environments |
| 7 | autofill.js | 172 | **High** | `ot.includes('not authorized')` in noMatch catches sponsorship fields wrongly |
| 8 | test-apply-form.html | 65 | **Medium** | `name="postalCode"` mismatches profile key `zip`; headless tests fail |
| 9 | content.js | 16 | **Medium** | `return false` unconditional; fragile if AUTOFILL_TRIGGER becomes async |
| 10 | content.js | 28–34 | **Low** | `STATUS_COLORS` is dead code and missing 'Shortlisted' |
