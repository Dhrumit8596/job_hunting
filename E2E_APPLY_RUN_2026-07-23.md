# E2E apply run report — 2026-07-23

Run ID: `apply-1784823760189`

Command:

```bash
curl -sS -X POST http://127.0.0.1:6174/apply-run \
  -H 'Content-Type: application/json' \
  --data '{"e2eSafe":true,"threshold":40,"targetConfirmed":10,"attemptCap":25,"rescore":true,"requireEvidence":false,"includeAssisted":true,"companyDeny":["Micron"],"force":true,"previewLimit":5}'
```

## Result

The run did not reach the 10-confirmed target.

| Metric | Count |
| --- | ---: |
| Jobs queued/attempted | 25 |
| Confirmed submitted | 0 |
| Failed | 17 |
| Skipped | 8 |
| CAPTCHA skips | 8 |

Run terminal status: `exhausted`

## Failure buckets

| ATS | Status | Reason | Count | Notes |
| --- | --- | --- | ---: | --- |
| Greenhouse | skipped | `captcha` | 7 | Acceptable blocker; queue advanced. |
| Ashby | skipped | `captcha` | 1 | Acceptable blocker; queue advanced. |
| SmartRecruiters | failed | `missing_required` | 4 | Not acceptable as-is. Latest logs showed at least one false `missing_required:*` after SPA step advance with zero visible inputs. Patched after this run to wait/retry and classify as `no_submit_after_spa` instead of missing profile data. |
| SuccessFactors | failed | `no_submit_btn` | 3 | Not acceptable. Some pages are landing/search/talent-community shells and need better start/apply-path detection. |
| SuccessFactors | failed | `no_apply_path` | 1 | Correct classification for a landing page without an application form. |
| Workday | failed | `missing_required` | 3 | Not acceptable. Existing fixes added stronger country phone code and referral-source handling; rerun needed for confirmation. |
| Workday | failed | `stuck_watchdog` | 3 | Not acceptable. Needs clearer per-step stall cause and recovery path. |
| Workday | failed | `stuck_budget` | 1 | Not acceptable. Indicates repeated reload/queue budget exhaustion. |
| Workday | failed | `workday_auth_unknown_screen` | 1 | Not acceptable. Workday auth/create/verify path still needs unknown-screen classification/recovery. |
| Ashby | failed | `posting_not_found` | 1 | Acceptable dead-posting classification if page really returns a missing posting. |

## Jobs in the run

| # | Status | Company | Title | ATS | Reason |
| ---: | --- | --- | --- | --- | --- |
| 1 | failed | Intuitive | Field Service Engineer 2 - Weekend Shift | SmartRecruiters | `missing_required` |
| 2 | failed | Western Digital | Photolithography Process Engineer | SmartRecruiters | `missing_required` |
| 3 | failed | Bosch Group | Environmental Engineer | SmartRecruiters | `missing_required` |
| 4 | failed | TSMC | Mechanical Construction Engineer - Fab Construction Department | SuccessFactors | `no_apply_path` |
| 5 | failed | TSMC | Nano Materials Engineer | SuccessFactors | `no_submit_btn` |
| 6 | failed | TSMC | CSA Cost and Control Engineer | SuccessFactors | `no_submit_btn` |
| 7 | failed | KLA | System Design Engineer | Workday | `workday_auth_unknown_screen` |
| 8 | failed | Abbott | Manufacturing Process Engineer | Workday | `missing_required` |
| 9 | failed | Abbott | Sr. Quality Systems/CAPA Engineer | Workday | `missing_required` |
| 10 | failed | Abbott | Manufacturing Process Engineer | Workday | `missing_required` |
| 11 | failed | Abbott | Quality Engineer | Workday | `stuck_budget` |
| 12 | failed | FormFactor | Sr Principal Integration and Yield Engineer | Workday | `stuck_watchdog` |
| 13 | failed | Dexcom | Test Engineer 1 | Workday | `stuck_watchdog` |
| 14 | failed | Dexcom | Staff Manufacturing Engineer | Workday | `stuck_watchdog` |
| 15 | failed | Form Energy | Senior Manufacturing Engineer | Ashby | `posting_not_found` |
| 16 | failed | Western Digital | Manufacturing Integration Engineer | SmartRecruiters | `missing_required` |
| 17 | failed | TSMC | Equipment Engineer - Photo | SuccessFactors | `no_submit_btn` |
| 18 | skipped | Agility Robotics | Sr. Supplier Quality Engineer | Greenhouse | `captcha` |
| 19 | skipped | PsiQuantum | System Integration & Deployment Engineer | Greenhouse | `captcha` |
| 20 | skipped | PsiQuantum | R&D Engineer – Thin Film Materials | Greenhouse | `captcha` |
| 21 | skipped | Gotion | Environmental Equipment Engineer (Industrial Systems) | Greenhouse | `captcha` |
| 22 | skipped | Outset Medical | Field Service Engineer II (Austin, TX) | Greenhouse | `captcha` |
| 23 | skipped | 1X Technologies | Supplier Development Engineer- Motors and Magnets | Ashby | `captcha` |
| 24 | skipped | ASM International | Engineer, Field Service- "I & II" | Greenhouse | `captcha` |
| 25 | skipped | Vaxcyte | Associate Scientist II, Analytical Development, Raw Materials (Contract) | Greenhouse | `captcha` |

## Code changes made from this run

- Added active-run ledger compaction so result logging does not silently fail from oversized `chrome.storage.local` writes.
- Added ranked-dispatch recovery for stale/last-failure state, including SuccessFactors landing-page `no_submit_btn` recovery to `no_apply_path`.
- Improved Workday country phone code and referral-source combobox handling.
- Improved Workday selected-value detection for `selectedItem` and `promptOption` DOM shapes.
- Improved SmartRecruiters custom-field handling for `spl-select`.
- Added SmartRecruiters empty-SPA-step recovery: after a next-step advance with no hydrated controls, the extension now waits/retries and records `no_submit_after_spa` if the page remains empty instead of false `missing_required:*`.

## Verification

Latest focused gate:

```text
node --check: 96/96 files OK
Privacy scan passed (125 tracked files checked)
958 passed, 0 failed  (36 test files)
```

The test runner has a known hang after printing the all-green summary; it was interrupted after the pass summary.

## Next E2E acceptance target

A passing E2E batch should meet all of these:

- At least 10 confirmed submissions, or all non-confirmations are CAPTCHA/dead-posting/explicit manual-review blockers.
- CAPTCHA jobs are skipped and the queue advances.
- Workday auth failures create or sign in to the Workday account and verify through Gmail when possible.
- Missing required fields list actual labels, not sentinel labels such as `*`.
- `no_submit_btn` includes visible buttons, URL, ATS, and page-state classification.
- `pja_ext_queue`, `pja_ext_current`, and ranked-apply state are clean or self-healed before each run.
