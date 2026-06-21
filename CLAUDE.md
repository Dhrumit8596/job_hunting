# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Naming:** the `pja_` / `PJA` prefix used throughout (storage keys, function names) is an
> opaque internal namespace for this extension — it is **not** a person's name. Do **not**
> rename `pja_*` storage keys or function prefixes: existing installs hold data under those
> keys and renaming would break them without a migration. Personal data is never committed —
> real values live in `chrome.storage` and in gitignored `*.local.*` files.

## Dev workflow

**Start the dev server** (keep running in background):
```bash
node dev-server.js
```

**Reload the extension after any file change:**
```bash
curl -X POST http://localhost:6174/reload
# Then refresh any open job-page tab so the new content script loads
```

**Check extension is connected:**
```bash
curl http://localhost:6174/health
# {"clients":1} = ready   {"clients":0} = go to chrome://extensions and click reload
```

Extension ID: `lpojofmpdljggmdmoamdggapnabfkham`  
Dev server port: **6174** (HTTP + WebSocket on same port)

**Manual test queue** — paste into the Settings page console (`chrome-extension://…/settings/settings.html`):
```javascript
// content of test/launch-ext-queue.js
```
This seeds `pja_ext_queue` + `pja_ext_current` into storage and opens the first apply URL.

**Dev server endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | `{"clients":N}` |
| `/reload` | POST | Broadcasts reload to extension |
| `/inject` | POST | Re-injects content scripts into existing tabs |
| `/analyze` | POST | Single job fit score (`{title, company, description}`) |
| `/batch-score` | POST | Up to 10 jobs in one Claude call |
| `/outreach` | POST | Generates DM + email for a job + person |
| `/set-storage` | POST | `chrome.storage.local.set(body)` — body is passed **flat**, not nested |

**`/set-storage` gotcha:** the body JSON is passed directly to `chrome.storage.local.set()`. Send `{"pja_ext_queue": {...}}`, NOT `{"data": {"pja_ext_queue": {...}}}`.

## Architecture

```
background.js          Service worker. All AI scoring, storage CRUD, CDP/scripting calls.
                       DEV_MODE=true at line 7 — routes analysis to dev server, keeps WS alive.

content/
  autofill.js          PJA_FIELD_RULES table + pjaFillForm / pjaFillSelect / pjaClickRadio.
                       Runs on LinkedIn, Greenhouse, Lever, Workday, and generic job pages.
  auto-apply.js        LinkedIn Easy Apply modal step-through. Uses pjaFillForm internally.
  external-apply.js    ATS form filler for off-LinkedIn applications. Reads pja_ext_current
                       from storage on page load, fills the form, writes result back, then
                       calls navigateBack() to advance the queue.
  job-scraper.js       Floating scan widget. Collects jobs on LinkedIn, sends to background
                       for batch scoring, populates pja_shortlist.
  content.js           Shadow DOM sidebar, message router (FORCE_OPEN, AUTOFILL_TRIGGER).
  extractors/          Site-specific job data parsers (linkedin.js, indeed.js, glassdoor.js,
                       generic.js). Run before autofill.js on the first content_scripts block.

popup/                 Pipeline / Search / Contacts tabs.
shortlist/             Scanner results review page.
settings/              Profile, answer bank, AI templates, API key.
```

### External apply queue flow

1. **Shortlist page** sets `pja_ext_queue` (list of jobs) + `pja_ext_current` (first job) in storage and navigates to `job.applyUrl`.
2. **`external-apply.js`** fires on the ATS page, reads both keys, calls `runExternalApply()`.
3. After success/failure, writes result into `pja_ext_queue.results`, increments `currentIndex`, then calls `navigateBack()`.
4. `navigateBack()` either goes directly to the next `applyUrl` (if one exists) or navigates back to LinkedIn with `?pja_ext_ret=1`, which triggers `resumeExtApplyOnLoad` to open the next job.

`external-apply.js` has a **hostname guard** (early in the storage callback): if `location.hostname` doesn't match `job.applyUrl`'s hostname, it returns immediately. This prevents the script from redirecting non-ATS tabs (e.g. google.com) to LinkedIn.

### React/Formik form filling

Plain DOM value assignment doesn't update React state. For any React-based ATS (Workday, Greenhouse, Lever):

- **Text inputs:** use `nativeInputValueSetter` (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`) + `dispatchEvent(new InputEvent('input', {bubbles:true}))`. This is `pjaSetNative()`.
- **Selects:** `pjaFillSelect()` handles both native `<select>` and the React-controlled variant.
- **Radios:** `pjaClickRadio()` must dispatch `input` before `change` (BUG 3 below — currently missing).
- **Workday form submission from background:** use `WORKDAY_SUBMIT_FORM` message with `world:'MAIN'` in `chrome.scripting.executeScript` so the page's own React context is used.

### `DEV_MODE` flag (background.js line 7)

`const DEV_MODE = true` is hardcoded. When true:
- WebSocket to `ws://localhost:6174` is opened and kept alive with 20s pings (keeps MV3 service worker alive)
- `analyzeJob()` routes to dev server instead of Gemini Nano
- `BATCH_SCORE_JOBS` and `FIND_OUTREACH_PEOPLE` **always** call the dev server regardless of this flag (BUG 5)

## Storage schema (chrome.storage.local)

| Key | Content |
|-----|---------|
| `pja_profile` | User profile overrides (`firstName`, `email`, `phone`, `workAuth`, `requireSponsorship`, etc.) |
| `pja_answers` | Answer bank: `{ [rawLabel]: { answer, savedAt, usedCount } }` |
| `pja_jobs` | Job pipeline array (Needs Info → Applied → Offer/Rejected) |
| `pja_shortlist` | Scanner results with `fitScore`, `skills`, `flags` |
| `pja_contacts` | Recruiter/HM tracker |
| `pja_templates` | DM + email templates |
| `pja_ext_queue` | Active queue: `{ status, jobs[], currentIndex, results, runId }` |
| `pja_ext_current` | Single job being applied: `{ ...job, profile, answers, returnUrl, applyUrl, runId }` |
| `pja_missing_questions` | Fields autofill couldn't fill (for answer-bank prompting) |
| `pja_dbg` | Rolling debug log array (last 20 entries) |
| `pja_dbg_signin` / `pja_dbg_createacct` | Workday auth debug snapshots |

## Known bugs (do not re-introduce)

See `BUGS.md` for full details. Critical ones that affect every application:

- **BUG 1** (`autofill.js:172`): `noMatch` for sponsorship contains inverted conditions — selects "Yes, I will require sponsorship" for a No-sponsorship profile.
- **BUG 2** (`autofill.js:480`): `pjaSetNative` called on `<select>` in answer-bank path — silently fails on React selects.
- **BUG 3** (`autofill.js:368`): `pjaClickRadio` missing `input` event — React radio state never updates.
- **BUG 5** (`background.js:801,893`): `BATCH_SCORE_JOBS` and `FIND_OUTREACH_PEOPLE` always call dev server, no `DEV_MODE` guard.
- **BUG 6** (`background.js:7`): `DEV_MODE = true` hardcoded — Gemini Nano permanently disabled.

## Known ATS blockers

See `EXTERNAL_APPLY_BLOCKERS.md` for full details. Top unresolved:

- **Greenhouse comboboxes**: All dropdowns are `<input role="combobox">` + listbox, not `<select>`. `pjaFillSelect` skips them entirely. Need `pjaFillCombobox()`.
- **Shadow DOM**: `findMissingRequired()` and `findButton()` in `external-apply.js` use `document.querySelectorAll` — misses inputs inside shadow roots (Workday, Rippling). Should use `pjaQueryAll()`.
- **Resume upload**: `input[type=file]` can't be set programmatically without a stored `profile.resumeDataUrl` + `DataTransfer` approach.
- **Workday account creation**: Requires user-created password. Flow currently bails with `needs_login` unless `WORKDAY_SUBMIT_FORM` can complete the create-account step.

## `PJA_FIELD_RULES` ordering rule

In `autofill.js`, rule order matters — more specific multi-word patterns must come before short single-word ones that are substrings of longer labels. Salutation is last because `'title'`, `'mr'`, `'ms'` are substrings of other labels. `currentLocation` is before `city` because `"location (city)"` contains `"city"`.
