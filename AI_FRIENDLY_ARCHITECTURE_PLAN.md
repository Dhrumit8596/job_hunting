# AI-friendly apply architecture plan

## Implementation record (2026-08-17)

The control-plane work in this plan is implemented. The shared schema/reducer, exact-run progress
adapter, deterministic recovery policy, run-specific HTTP APIs, CLI watcher, popup status adapter,
category isolation, bounded category scoring, shared external preflight policy, and local run
handoff are active. The duplicate test-only `sourcing/router.js` seam was removed. The implemented
diagram is in [One-click Apply Architecture v2](https://www.figma.com/board/1g3FrLoyCT5z5KB4vTgiFW).

Verification completed:

- Full syntax, privacy, unit, and whitespace suites pass.
- A local fixture proved exact-run watch from active handler through confirmed terminal state and
  automatic report export.
- The extension/dev-server preflight passed with one connected client and a configured candidate
  profile/resume.
- All eight category dry gates ran with unchanged fit, evidence, location, duplicate, and safety
  rules. Category scoring is capped at a 20-candidate reserve by default instead of the broad
  150–300 candidate window.

Measured category gate result:

| Category | Qualified reserve | Gate result |
| --- | ---: | --- |
| LinkedIn Easy Apply | 2 | `supply_limited` |
| Indeed Apply | 0 | `supply_limited` (3 scored; browser scan found additional leads) |
| Greenhouse | 0 | `supply_limited` |
| Workday | 0 | `supply_limited` |
| Ashby | 0 | `supply_limited` |
| Lever | 0 | `supply_limited` |
| SmartRecruiters | 1 | `supply_limited` |
| Generic/fallback | 0 | `supply_limited` |

The full live 5-per-category gates were therefore not run: the protocol below requires five
genuinely qualified candidates first and explicitly forbids weakening eligibility to manufacture
test volume. A later explicitly authorized single-run E2E used the two-job LinkedIn reserve
(`apply-1786979950381`): one job reached a real submit click but lacked explicit confirmation and
was recorded `submitted/unverified`; the second ended `failed/stuck`; zero were ledger-confirmed.
That test also exposed and fixed a transient exact-run 404 in the watcher by adding two bounded
retries without ever falling back to another run. Generated planning/run reports in `reports/`
contain the local evidence. A future execution should source new matching supply, rerun the dry
category gate, and proceed only for a category whose qualified reserve reaches five.

## Objective

Make the one-click application flow easy for a new AI session to start, observe, recover, and finish
without holding the repository or long logs in context.

The desired operator contract is one command:

```bash
npm run apply:all -- --target 5 --wait --category <category>
```

That command must not exit after queue creation. It must retain the returned `runId`, follow only
that run, emit compact progress, perform bounded deterministic recovery, export the terminal report,
and exit with a meaningful status code.

## Non-goals and invariants

- Keep `/apply-all` as the unified product entrypoint.
- Keep the MV3 service worker as the sole owner of the active ranked queue and serialized ledger.
- Keep IndexedDB as the canonical job corpus.
- Preserve existing `pja_*` keys and compatibility during migration.
- Never count a click, redirect, or vanished form as a confirmed application.
- Never fabricate candidate facts or bypass CAPTCHA, account locks, rate limits, or safety gates.
- Do not move browser orchestration into the model. Models may score or interpret bounded evidence;
  deterministic code owns state, timeouts, routing, retries, and terminal decisions.
- Do not require a model to read `background.js`, `dev-server.js`, or raw browser logs to monitor a
  healthy run.

## Current control-plane gap

The current start command performs preflight, sourcing, planning, and queue installation, then exits.
The browser service worker continues asynchronously. `npm run apply:status` provides only a one-time
latest-run snapshot, so an AI session must remember the `runId`, poll manually, infer whether an
unchanged job is healthy or stuck, decide when recovery is safe, and remember to export a report.

This is a missing run-observation contract, not a prompting problem.

## Target architecture

```mermaid
flowchart LR
    A[Popup or CLI] --> B[/apply-all]
    B --> C[Run controller]
    C --> D[Source and plan]
    C <--> E[MV3 queue owner]
    E --> F[Channel or ATS handler]
    F --> G[Ledger event]
    G --> E
    E --> H[Durable run snapshot]
    H --> I[Run-specific status API]
    I --> J[CLI watch or popup progress]
    J --> K{Terminal?}
    K -- no --> I
    K -- yes --> L[Report and exit code]
```

The model sees the compact output of `CLI watch`; it does not reconstruct state from multiple stores
or infer progress from browser behavior.

## Run contract

Create one versioned, compact run-status schema shared by the service worker, HTTP API, CLI, popup,
tests, and report builder.

Minimum fields:

```json
{
  "schemaVersion": 2,
  "runId": "apply-...",
  "status": "applying",
  "phase": "handler",
  "category": "greenhouse",
  "currentIndex": 2,
  "total": 5,
  "attempt": 3,
  "targetConfirmed": 5,
  "confirmed": 2,
  "unverified": 0,
  "failed": 0,
  "skipped": 0,
  "currentJob": {
    "id": "stable-id",
    "company": "bounded text",
    "title": "bounded text",
    "channel": "external",
    "strategy": "greenhouse",
    "host": "boards.greenhouse.io"
  },
  "startedAt": 0,
  "updatedAt": 0,
  "lastTransitionAt": 0,
  "secondsSinceTransition": 0,
  "health": "healthy",
  "nextAction": "waiting_for_handler",
  "terminalReason": null,
  "reportPath": null
}
```

Rules:

- `runId` is mandatory for every status, event, diagnostic, and report request.
- `phase` is a closed enum such as `preflight`, `sourcing`, `planning`, `dispatching`, `handler`,
  `recovery`, `reporting`, or `terminal`.
- `status`, `health`, `nextAction`, and `terminalReason` are deterministic enums, not model prose.
- `updatedAt` records any safe snapshot write; `lastTransitionAt` changes only when meaningful state
  advances.
- A stalled run is derived from the handler-specific time budget and the last transition, not from a
  fixed number of AI polling attempts.
- Snapshots remain compact. Full descriptions, page HTML, screenshots, answers, and resume data are
  excluded.

## Proposed module boundaries

Extract pure modules before adding more logic to the two large integration files:

| Proposed module | Responsibility |
| --- | --- |
| `apply-run-state.js` | Versioned status schema, state transition reducer, enums, terminal rules. |
| `apply-progress.js` | Convert ranked queue + ledger + diagnostic timestamps into the compact public snapshot. |
| `apply-recovery-policy.js` | Pure mapping from health/reason/attempt budget to wait, reinject, retry, advance, pause, or terminate. |
| `apply-run-api.js` | Run-specific HTTP handlers and backward-compatible response adapters. |
| `scripts/pja-apply-watch.js` | Follow one `runId`, stream NDJSON/human output, export report, and return stable exit codes. |

`background.js` should call the pure transition and recovery functions but remain the browser-side
owner. `dev-server.js` should delegate status/API formatting to the extracted module rather than
growing another endpoint implementation inline.

## API and CLI contract

### Start

`POST /apply-all` should return as soon as the durable run is installed:

```json
{
  "success": true,
  "runId": "apply-...",
  "statusUrl": "/apply-runs/apply-...",
  "eventsUrl": "/apply-runs/apply-.../events",
  "reportUrl": "/apply-runs/apply-.../report"
}
```

### Observe

- `GET /apply-runs/:runId` returns only that run.
- `GET /apply-runs/:runId/events?after=<cursor>` returns bounded transition events, not raw logs.
- Unknown or expired `runId` returns a clear `404`, never another run's state.
- Keep `/apply-status` temporarily as a compatibility alias for the latest run.

### Operate

Add:

```bash
npm run apply:all -- --target 5 --category greenhouse --wait
npm run apply:watch -- --run-id apply-...
npm run apply:status -- --run-id apply-...
npm run apply:report -- --run-id apply-...
```

`--wait` should:

1. Capture the exact `runId` from start.
2. Poll or consume bounded transition events every 15–30 seconds.
3. Print one compact progress record only when state changes, plus a low-frequency heartbeat.
4. Refuse to follow a different active/latest run.
5. Request only recovery actions permitted by `apply-recovery-policy.js`.
6. Export the report on terminal state.
7. Exit `0` only when the requested success condition is met.

Suggested exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Target reached with ledger-confirmed evidence. |
| `2` | Eligible supply exhausted before target. |
| `3` | Manual/external blocker requires user action. |
| `4` | Deterministic code failure or unhealthy stalled run. |
| `5` | Extension/dev-server disconnected. |
| `6` | Run conflict, missing run, or ownership mismatch. |

## Event journal and observability

Use one bounded transition journal derived from existing ledger and diagnostic writes. Each event
must include `runId`, stable job identity, phase, previous state, next state, normalized reason, and
timestamp. Events should be appended at these boundaries:

- preflight accepted or rejected;
- sourcing started/completed/failed;
- planning started/completed/failed;
- run installed;
- job dispatched;
- handler started or made a meaningful step transition;
- recovery action selected and completed;
- terminal job outcome recorded;
- queue advanced;
- run completed/exhausted/blocked/failed;
- report exported.

Do not duplicate verbose handler logs into the journal. Diagnostics remain available by reference
for a failed job, while the journal supplies enough information to track progress.

## Implementation phases

### Phase 0 — Characterize the existing behavior

- Add contract tests for the current `/apply-all`, `/apply-status`, completed-run snapshot, ledger
  ownership, and watchdog behavior.
- Add fixtures for healthy progress, unchanged-but-within-budget, stalled, disconnected, stale
  event, manual blocker, supply exhaustion, and terminal success.
- Record current response schemas so compatibility regressions are explicit.

Exit gate: tests reproduce the current monitoring gap without changing production behavior.

### Phase 1 — Introduce the pure run state model

- Add `apply-run-state.js` with schema validation and a pure reducer.
- Define phase/status/health/action/terminal enums.
- Derive `lastTransitionAt` and health from meaningful transitions.
- Adapt existing `pja_ranked_apply` state into schema version 2 without renaming its storage key.

Exit gate: unit tests cover every allowed transition and reject stale or wrong-run events.

### Phase 2 — Add compact progress and run-specific APIs

- Add `apply-progress.js` and run-specific status/report endpoints.
- Include handler budget, seconds since transition, current category, current job, and next action.
- Preserve the existing latest-run endpoint as an adapter.
- Ensure completed snapshots are queryable after the active run changes.

Exit gate: a restarted process can query a known `runId` and never receive another run's state.

### Phase 3 — Add deterministic watch and recovery

- Add `apply-recovery-policy.js` with bounded, testable actions.
- Add `apply:watch` and `--wait`.
- Make report export part of terminal handling.
- Emit human-readable progress by default and NDJSON with `--json-lines` for AI sessions.
- Persist the last followed `runId` in a small gitignored local control file for session handoff;
  browser storage and the ledger remain authoritative.

Exit gate: one CLI process follows a fixture run from start to terminal without model reasoning.

### Phase 4 — Unify popup and CLI status behavior

- Make popup progress consume the same public snapshot and enum labels.
- Show current category/job, confirmed target, last transition, health, and manual action.
- Remove UI-specific status inference.

Exit gate: popup and CLI render equivalent state for the same fixture.

### Phase 5 — Remove architectural ambiguity

- Resolve `content/apply-preflight.js`: integrate one tested shared policy at a time or delete it.
- Mark `sourcing/router.js` deprecated and remove it after confirming no production loader imports it.
- Keep `/source` and targeted start endpoints behind explicit legacy/advanced labels until their
  compatibility window closes.
- Extract one ATS at a time from `external-apply.js` behind the existing router contract.
- Update `ARCHITECTURE.md`, `AI_DEVELOPMENT.md`, `OBSERVABILITY.md`, and the FigJam diagram as runtime
  edges change.

Exit gate: every manifest/imported module is classified as active, alternate, dynamic, developer,
or intentionally deprecated; no unexplained shadow module remains.

## Verification ladder before live applications

Every phase must pass the cheapest relevant layer before proceeding:

1. Pure reducer/schema/recovery unit tests.
2. Existing unit suite: `npm run test:unit`.
3. Full suite: `npm test`.
4. `git diff --check`.
5. Local fixture run through `--wait` from start to terminal.
6. Dry-run sourcing and planning for each category.
7. Five stop-before-submit jobs per category, proving routing, fill, validation, progress, and
   diagnostics without submission.
8. Live application batches described below.

No live batch begins while a lower verification layer is failing.

## Category definition and live test matrix

For this plan, “each category” means the two native channels, the five default external strategies,
and the generic/fallback route:

| Category | Required live confirmations | Route requirement |
| --- | ---: | --- |
| LinkedIn Easy Apply | 5 | `channel=linkedin_easy_apply` |
| Indeed Apply | 5 | `channel=indeed_apply` |
| Greenhouse | 5 | `strategy=greenhouse` |
| Workday | 5 | `strategy=workday` |
| Ashby | 5 | `strategy=ashby` |
| Lever | 5 | `strategy=lever` |
| SmartRecruiters | 5 | `strategy=smartrecruiters` |
| Generic/fallback | 5 | Explicit generic strategy with a supported executable route |

Total target: **40 ledger-confirmed applications**.

The current default coverage constants include the first seven categories but not generic/fallback.
Generic must pass the same route, fixture, and stop-before-submit gates before it is added to live
coverage; it must not be treated as “any unknown page.”

## Live execution protocol

Run categories sequentially, never as one 40-job mixed batch:

1. Source enough jobs for one category to obtain at least five genuinely qualified, evidence-backed
   candidates after filtering.
2. Run a dry plan and verify all five are classified into the requested category.
3. Run five stop-before-submit attempts and review diagnostics.
4. Fix and regression-test any repeated code failure before permitting submission.
5. Start one live `--wait` run targeting five confirmed applications for that category.
6. The watcher must remain attached to the exact `runId` through terminal state.
7. Export and review the report before moving to the next category.
8. Record category result, confirmed count, attempted count, failure clusters, manual blockers,
   duration, and token/model usage.

Do not lower fit, evidence, legal-answer, duplicate, or safety gates merely to reach five. If the
genuine-fit supply is insufficient, record the category as `supply_limited`, source again later, and
resume with the same acceptance criteria. CAPTCHA, daily limits, account locks, and unsupported
flows are not failures to bypass.

## Live acceptance criteria

The architecture is accepted only when all of the following are true:

- Eight category reports account for every planned job with a terminal outcome or planning-drop
  reason.
- Each category reaches five ledger-confirmed applications, for 40 total, unless a documented
  genuine-fit or external-service limit prevents it.
- The watcher follows the original `runId` and never observes or mutates another run.
- The operator does not manually poll or infer progress during a healthy run.
- Every progress record is compact, bounded, and contains no sensitive form values.
- No duplicate submission occurs during restart, reconnect, reinjection, watchdog, or late-event
  recovery.
- A fresh AI session can resume monitoring from only the `runId` and status command.
- Terminal report generation is automatic and the watcher exits with the documented code.
- The popup and CLI agree on status, counts, current category, health, and terminal reason.
- Routine operation uses Low reasoning; code-fix sessions stay bounded to one failure cluster.

## Rollout and rollback

- Introduce schema version 2 as an adapter over existing storage before changing writers.
- Keep old endpoints and snapshot fields through the live category test cycle.
- Feature-flag `--wait` recovery actions separately from read-only watching.
- Start live validation with read-only watch plus existing watchdog behavior.
- Enable new recovery actions one at a time after fixture and stop-before-submit evidence.
- On regression, disable the new watcher recovery flag; do not reset or delete active run storage.
- Preserve all ledgers and terminal reports for audit and deduplication.

## AI operating prompt after completion

The final healthy-run prompt should be this small:

```text
Apply 5 qualified jobs in <category> using the configured candidate profile. Run the unified
apply-all command with --wait, follow the returned runId until terminal, and return the generated
report summary. Do not change code or weaken safety gates during the run.
```

If the command exits with a code-fixable failure, start a fresh session using only the `runId`, report
path, normalized failure cluster, owning module, and nearest tests.
