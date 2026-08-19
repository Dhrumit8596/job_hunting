# AI-efficient development guide

This repository contains about 40k lines of JavaScript and several historical plans. A new session
should not read it all. Select a scope, inspect the nearest tests, and expand only when a runtime
contract crosses that boundary.

## Start a session in under two minutes

```bash
npm run context
npm test
git status --short
```

Then choose one focused map:

```bash
npm run context -- apply
npm run context -- sourcing
npm run context -- ai
npm run context -- storage
npm run context -- logs
npm run context -- ui
```

Read in this order:

1. `PROJECT_GOAL.md` for the product contract.
2. `ARCHITECTURE.md` for the actual runtime and module status.
3. The scope output from `npm run context -- <scope>`.
4. Only the relevant function ranges and nearest tests.
5. `AGENTS.md` for load-bearing repository rules if it was not already supplied to the session.

Use `rg -n "functionName|MESSAGE_TYPE|storage_key"` and bounded `sed -n` ranges. Avoid loading all
of `background.js`, `dev-server.js`, `external-apply.js`, or `autofill.js` into a model context unless
the task genuinely spans the whole file.

## Which code to change

| Change | Start with | Verify with |
| --- | --- | --- |
| One-click options or CLI | `scripts/pja-apply-all.js`, popup one-click functions, `/apply-all` | `one-click-entrypoints`, `channel-coverage-gate`, CLI dry run |
| Discovery/source coverage | `source-run.js`, one adapter, `browser-import.js` | source/adapter/browser-import tests |
| Job eligibility or retry state | `sourcing/apply-select.js` | apply-select, posting-status, ranked-dispatch tests |
| ATS strategy selection | `content/apply-router.js`, `detect-ats.js` | apply-router and mixed-apply-matrix tests |
| Form field behavior | `content/autofill.js` first; ATS engine only if site-specific | autofill, combobox, selfid, required-field diagnostics |
| External apply lifecycle | targeted function in `external-apply.js` | external-apply, application-ledger, confirmation tests |
| LinkedIn / Indeed | channel-specific engine | easyapply / indeed-apply tests |
| Storage/corpus | `idb-store.js`, service-worker wrapper | idb-store, jobstore, sourcing tests |
| AI prompt/cost | `scoring-context.js`, `ai-cli.js`, scoring functions in server | ai-cli, scoring-context, answer-correctness |
| Failure reports | diagnostic capture + report builders | required-field-diagnostics, applied-log, confirmation tests |

## Model and token budget policy

Use deterministic code for filtering, normalization, ATS detection, option coercion, dedupe, queue
state, and confirmation rules. Use the model only where semantic comparison or open-ended grounded
answers are required.

Runtime safeguards now in code:

- Fit scoring uses batches of at most 10 jobs. Broad supply evaluation advances in 100-candidate
  rounds and never newly scores more than 300 jobs in one request.
- Single-category apply runs default to a small 20-candidate evidence-scoring window (or four times
  their requested reserve) rather than the broad planner window. Raise `scoreCandidateLimit` only
  when a supply-limited report justifies the extra model cost.
- The scoring window limits only new model evaluations. Matching cached JD/candidate evidence is
  reused without consuming that budget, so later runs advance into the deferred scoring frontier
  instead of repeatedly spending their cap on the same jobs.
- Within that bounded budget, the immediately preceding source import prioritizes newly hydrated,
  newly sourced, and description-updated rows ahead of unchanged unscored frontier rows.
- The deterministic frontier additionally prioritizes current-candidate fingerprint mismatches,
  exact resume-supported titles, fresh complete descriptions, compatible seniority, and direct or
  native supported routes. Stop after 30 qualified reserves or when a scored round yields none;
  never lower the evidence threshold to improve apparent yield.
- Title expansion is deterministic and bounded in `sourcing/search-policy.js`: saved titles have
  precedence, adjacent titles must be audited against configured resume evidence, and level variants
  come only from configured experience. Do not infer senior-engineer eligibility solely from a
  senior technician title or spend model calls on staff-plus postings that the target band excludes.
- `scoring-context.js` bounds each long posting to 7,000 characters while retaining its opening,
  requirement-bearing lines, nearby context, and closing.
- Scoring evidence is cached by both job-description and candidate fingerprints.
- Descriptions remain in IndexedDB and are read only for the batch that needs rescoring.
- Codex scoring defaults to `gpt-5.6-luna` with low reasoning because the task is structured,
  repeatable classification. Override explicitly when an environment needs something else:
- The scoring subprocess sets `project_doc_max_bytes=0`; repository `AGENTS.md` is development
  guidance and is not re-sent with every isolated scoring/question request. The dedicated scoring
  system prompt remains in force.

```bash
PJA_CODEX_MODEL=gpt-5.6-terra PJA_CODEX_REASONING_EFFORT=medium npm run start:codex
```

Use `PJA_CODEX_MODEL=default` to omit the explicit model flag and let Codex choose its configured
default. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`.

When changing a prompt, preserve a machine-checkable schema and keep model output small. Do not add
resume text, full page HTML, screenshots, or full job descriptions to persistent logs.

## Working with the large files

The largest files are integration layers, not permission to mix more concerns into them.

- `external-apply.js`: locate one ATS branch or lifecycle function and patch within that seam. New
  ATS engines should register through `PJAApplyRouter` rather than add another unrelated top-level
  runner.
- `background.js`: keep global ranked-run ownership here. Pure selection/state logic belongs in a
  UMD module that can be tested in Node.
- `dev-server.js`: keep endpoint behavior backward compatible. New pure prompt/context/report logic
  should be extracted into a small require-able module.
- `autofill.js`: preserve rule ordering and shared native/React event semantics.

Do not “clean up” apparent duplicates before checking `ARCHITECTURE.md`'s module-status table.
Manifest scripts, service-worker `importScripts`, MAIN-world bridges, and dynamically injected Gmail
scripts have different loading mechanisms.

## Validation ladder

For any change:

```bash
npm run test:unit
npm test
git diff --check
```

For content-script changes, also reload and reinject:

```bash
curl -X POST http://localhost:6174/reload
curl -X POST http://localhost:6174/inject
curl http://localhost:6174/health
```

Live job submission is not a routine test. Prefer pure unit tests, local HTML fixtures, dry-run
planning, then stop-before-submit validation. A real submission needs an intentional live run.

For an intentional run, let the CLI own progress rather than asking a model to poll logs:

```bash
npm run apply:all -- --target 5 --category greenhouse --wait --json-lines
npm run apply:watch -- --run-id apply-...
```

The watcher prints bounded state changes/heartbeats, follows only the exact `runId`, exports the
terminal report, and returns a stable exit code. Do not proceed to stop-before-submit or live tests
when the category coverage gate reports fewer qualified jobs than the requested target.
The initial command should return quickly with HTTP 202 and a durable run ID; sourcing and planning
are normal watcher phases, not a reason to keep an HTTP request or model session open. Tests that
exercise the watcher must pass a temporary handoff path so they cannot overwrite
`.pja-run.local.json`.

## Documentation discipline

- `PROJECT_GOAL.md`: product north star.
- `ARCHITECTURE.md`: current runtime, ownership, and module connectivity.
- `AI_DEVELOPMENT.md`: session workflow and token discipline.
- `OBSERVABILITY.md`: failure evidence and triage contract.
- `PROMPT_PLAYBOOK.md`: model/reasoning choices and bounded copy-paste prompts.
- `DEVNOTES.md`: operational command/reference sheet.
- `BUGS.md` and blocker docs: regression history.
- dated E2E/session reports and `*_PLAN.md`: historical context, not current truth.

Update `ARCHITECTURE.md` in the same change when adding an entry point, queue, handler, storage owner,
or communication edge. Update its module-status table when connecting or retiring shadow code.
