# Bug Report — Job Application Assistant

**Original audit:** 2026-05-31 (autofill correctness, test-form accuracy, e2e on real ATS).
**Status refresh:** 2026-08-18 — **all 13 items below are RESOLVED in code.** This file is kept
as a regression guard: the fixes are load-bearing and easy to re-break, so each entry records
what the bug was, where the fix now lives, and (where present) the test that pins it.

> Do **not** re-introduce these. If you touch `pjaFillSelect` / `pjaClickRadio` / the answer-bank
> fallback / the `DEV_MODE` routing, run `npm test` — `test/unit/autofill.test.js`,
> `combobox.test.js`, and `selfid.test.js` cover the classification and fill paths.

---

## Resolved summary

| # | File | Fix location | Severity (was) | Status |
|---|------|-------------|----------------|--------|
| 1 | autofill.js | `pjaFillSelect` `requireSponsorship` branch (~L376–390) | Critical | ✅ Fixed |
| 2 | autofill.js | answer-bank fallback routing (~L1706–1718) | Critical | ✅ Fixed |
| 3 | autofill.js | `pjaClickRadio` (~L724–734) | Critical | ✅ Fixed |
| 4 | autofill.js | `partial` length guard (L401) | High | ✅ Fixed |
| 5 | background.js | `BATCH_SCORE_JOBS` L1838, `FIND_OUTREACH_PEOPLE` L2118 | Critical | ✅ Fixed |
| 6 | background.js | `DEV_MODE = true` (L7) | High | ⚙️ By design |
| 7 | autofill.js | key-aware `not authorized` guard (L399) | High | ✅ Fixed |
| 8 | test-apply-form.html | `name="zip"` (L64) | Medium | ✅ Fixed |
| 9 | content.js | listener guard `__pjaMsgListenerAdded` (L5) | Medium | ✅ Fixed |
| 10 | content.js | `STATUS_COLORS` removed | Low | ✅ Fixed |
| 11 | background.js | `pjaBuildApplySet` ambiguous-ledger blocker | Critical | ✅ Fixed |
| 12 | dev-server.js / background.js | owned, deadline-bounded `/source-v2` import | Critical | ✅ Fixed |
| 13 | browser scanners / corpus merge | acknowledged page persistence and rediscovery freshness | Critical | ✅ Fixed |

---

## BUG 1 — Sponsorship select selected the inverted option — ✅ FIXED
**Was:** `pjaFillSelect`'s `noMatch` branch contained `will require sponsorship` / `yes, i will require`
conditions, so a `requireSponsorship = 'No'` profile selected **"Yes, I will require sponsorship."**
**Fix:** `requireSponsorship` is now handled on its own branch before the generic work-auth logic
(`content/autofill.js`, `if (key === 'requireSponsorship')`). Sponsorship is treated as semantically
inverted vs. work-auth (`saysRequire` → Yes, `saysNoSponsor` → No); sponsorship option text can no
longer leak into the generic yes-branch. Mirrored in `pjaFillCombobox` and the Workday path.

## BUG 2 — Answer-bank values silently dropped on React selects — ✅ FIXED
**Was:** `pjaSetNative` was called on `<select>` in the answer-bank fallback; the `HTMLInputElement`
value setter doesn't apply to selects, so React state never updated and the field was counted as
filled while actually empty.
**Fix:** answer-bank fallback routes by element type — `SELECT → pjaFillSelect`,
combobox → `pjaFillCombobox`, `tel` → `pjaFillTextViaFiber`, else `pjaSetNative`.

## BUG 3 — React radio state never updated — ✅ FIXED
**Was:** `pjaClickRadio` set `.checked` and dispatched only `change`/`click`; React tracks radios via
the `input` event, so the controlled value stayed empty on submit.
**Fix:** uses the native `checked` prototype setter (updates React's value tracker), then dispatches
`input` → `change` → `click`.

## BUG 4 — Short values (`no`/`yes`) substring-matched everything — ✅ FIXED
**Was:** `ot.includes(lv)` fired for any option containing `"no"` (e.g. "unkn**o**wn", "**no**t authorized").
**Fix:** `const partial = lv.length > 3 && (...)` — single-word yes/no values no longer partial-match.

## BUG 5 — Batch scoring / outreach always hit the dev server — ✅ FIXED
**Was:** `BATCH_SCORE_JOBS` and `FIND_OUTREACH_PEOPLE` fetched `localhost:6174` with no `DEV_MODE`
guard, so both silently failed whenever the dev server was down.
**Fix:** `BATCH_SCORE_JOBS` has `if (!DEV_MODE)` → scores per-job via `analyzeJob` (Nano/Claude/template);
`FIND_OUTREACH_PEOPLE` throws `'dev server disabled'` when `!DEV_MODE` and falls back to template messages.

## BUG 6 — `DEV_MODE = true` hardcoded — ⚙️ INTENTIONAL (not a bug in this deployment)
`DEV_MODE = true` is the **operating mode** for this install: all AI routes through the local
`claude` CLI via the dev server (see `dev-server.js`), which is the reliable engine here. Gemini Nano
is deliberately bypassed. Flip to `false` only to exercise the Nano/Claude-API tiers. Left as-is on purpose.

## BUG 7 — "not authorized" matched sponsorship fields — ✅ FIXED
**Was:** `noMatch` matched `ot.includes('not authorized')` regardless of field, wrongly firing on
combined authorization/sponsorship dropdowns.
**Fix:** guard is now key-scoped — `(key === 'workAuth' && ot.includes('not authorized'))` — and the
`yesMatch` "authorized" check excludes "not authorized".

## BUG 8 — Test form zip `name` mismatch — ✅ FIXED
`test/test-apply-form.html` now uses `name="zip"` (was `name="postalCode"`), so name-attribute
classification works in headless tests.

## BUG 9 — Unconditional `return false` in content.js listener — ✅ FIXED
The listener is now registered once behind `__pjaMsgListenerAdded`; `FORCE_OPEN` / `AUTOFILL_TRIGGER`
call `sendResponse` synchronously and the handler falls through (no dangling async channel).

## BUG 10 — Dead `STATUS_COLORS` in content.js — ✅ FIXED
Removed from `content/content.js`. The canonical `STATUS_COLORS` lives in `popup/popup.js`.

## BUG 11 — Ambiguous historical submissions could re-enter the apply plan — ✅ FIXED
**Was:** a sourcing refresh could restore a corpus row to `sourced` while its application-ledger
event retained `submitted` + `submit_observation_timeout` or another ambiguous post-submit outcome.
The planner filtered by failure status before its blocker regex, so submitted/unverified records
never reached that regex and could be selected again.
**Fix:** `ledger-retry-policy.js` behaviorally classifies outcomes independent of status. Planning,
sourcing deduplication, and developer reporting share it. Submitted/unverified, `submit_unclear`,
`submit_observation_timeout`, `workday_transport_failure`, duplicate-record, and ambiguous historical
`ranked_watchdog_timeout` records require reconciliation and cannot be retried implicitly. Ordinary
pre-submit `missing_required` failures retain the existing bounded retry policy.

## BUG 12 — Timed-out sourcing could mutate a later run's corpus — ✅ FIXED
**Was:** `/apply-all-internal` did not pass run ownership to `/source-v2`; browser scans could exceed
their enclosing timeouts, and aborting the loopback client did not cancel the active handler. A late
handler could still import or retire IndexedDB records. Unified `/source-v2` also accepted a sparse
storage transport response and silently fell back to default titles/location.
**Fix:** workflow, source-client, source-operation, and browser budgets are now nested and bounded.
Exact sourcing carries `runId` plus an absolute deadline and rechecks both between work units, at
each acknowledged browser-batch write, and at the service-worker import boundary. Lost/terminal
ownership or expiration prevents shortlist refresh, corpus import, and retirement. `/source-v2` uses bounded observed-storage retries and returns
`source_storage_unavailable` before discovery when profile/preferences keys cannot be observed.
Standalone sourcing must keep an omitted `runId` empty; sanitizing a blank value into a generated
identifier falsely claims exact-run ownership and causes `source_ownership_lost` before discovery.

## BUG 13 — Browser pages could report success before persistence — ✅ FIXED
**Was:** LinkedIn and Indeed treated an eight-second missing callback as success, marked IDs seen
before storage acknowledgement, and normally scanned only page one. Rediscovered hydrated records
could retain an old `discoveredAt` and later be dropped as stale.
**Fix:** `browser-batch.js` provides stable page batch IDs, matching acknowledgements, bounded retry,
source-namespaced idempotent merge, and explicit `persistence_failed` terminalization. Adaptive
pagination persists each page before navigation and requires changed result IDs plus useful yield.
Rediscovery now updates `lastSeenAt` and query/page provenance while preserving unchanged JD/evidence;
new or changed descriptions invalidate scoring fields. Never restore the old timeout-as-success or
pre-acknowledgement seen-set behavior. LinkedIn's trailing accessibility badge text (`with
verification`) is removed at both collection and corpus-normalization boundaries so official-ATS
identity matching uses the employer's actual title.
