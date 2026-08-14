# Prompt playbook: strong outcomes without full-context token use

Use a fresh session for each major phase. Replace angle-bracket placeholders before running a
prompt. The configured local profile/resume is the candidate source of truth; do not put personal
data in the prompt or repository.

## Model and reasoning defaults

| Work | Recommended model | Reasoning | Escalate only when |
| --- | --- | --- | --- |
| Run the known end-to-end application flow | `gpt-5.6-terra` | Low for a healthy flow; Medium when monitoring/recovery is expected | The unified endpoint or browser state behaves unexpectedly. |
| Read-only log clustering | `gpt-5.6-luna` | Low | Luna is unavailable, or evidence spans several runtimes. Use Terra Low. |
| Implement one evidence-backed fix | `gpt-5.6-terra` | Medium | Two focused fix attempts fail or the cause crosses orchestration, storage, and multiple handlers. |
| Cross-cutting architecture improvement | `gpt-5.6-sol` | High | Only when the change is genuinely ambiguous and cross-runtime. |

Do not start with Extra High, Max, or Ultra. They are unnecessary for routine apply runs and most
single-cluster fixes. Increase reasoning only after concrete evidence shows the lower setting is
insufficient.

## 1. Apply a target number of jobs end to end

Recommended: **Terra, Low** for a known healthy flow; **Terra, Medium** if the run needs active
recovery/monitoring.

```text
Run the unified end-to-end job application flow with a target of <N> confirmed applications, using
only the configured local profile, resume, preferences, and answer bank.

Operational scope only:
- Do not review or modify source code unless health, preflight, or /apply-all itself fails.
- Start or reuse the Codex dev server and verify /health reports clients: 1.
- Run the one-click preflight. If it fails, report the exact readiness problem and stop.
- Use /apply-all (or npm run apply:all) with threshold <THRESHOLD, normally 70> and these optional
  queries: <QUERIES OR "use configured search titles">.
- Do not use /start-ea unless I explicitly request LinkedIn-only applications.
- Monitor npm run apply:status until the run is terminal, the genuine-fit corpus is exhausted, or an
  external/manual blocker prevents further progress. Do not stop merely because the run launched.
- Never fabricate qualifications, work authorization, sponsorship, citizenship, legal facts, or
  screening answers. Skip/record CAPTCHA, account lock, rate limit, missing factual answers, and
  unsupported flows.
- Do not count a click or redirect as an application; count only ledger-confirmed evidence.
- At the end run npm run apply:report and give me a compact summary: confirmed, unverified, failed,
  skipped/manual, top failure reasons, report path, and whether the target was reached.
- Do not run the full test suite unless code changed.
```

Why this stays efficient: it uses the existing orchestration and status endpoints and explicitly
forbids a repository review during an operational run.

## 2A. Triage failed application logs without changing code

Recommended: **Luna, Low**. Use **Terra, Low** if Luna is unavailable.

```text
Perform read-only triage of the newest application run.

- Run npm run context -- logs.
- Read OBSERVABILITY.md, then inspect npm run apply:status and export/read the newest apply report.
- Do not read all of background.js, dev-server.js, external-apply.js, or autofill.js.
- Group failures by normalized reason, ATS/strategy, phase, and repeated diagnostic signature.
- Separate external/manual blockers from code-fixable failures.
- Rank at most three code-fix opportunities by affected jobs, recurrence, and confidence.
- For the highest-value cluster, identify the exact evidence, likely owning function/module, nearest
  tests, and a minimal reproduction. Do not edit files or launch applications.
- End with a small handoff block containing: runId, cluster reason, example job IDs/hosts, diagnostic
  evidence, files to inspect, tests to run, and acceptance criteria for the fix.
```

Start a fresh implementation session with the handoff block; do not carry the entire triage chat.

## 2B. Fix one diagnosed failure cluster and test it

Recommended: **Terra, Medium**. Escalate to **Sol, High** only after two focused attempts fail or the
evidence proves the problem is cross-runtime.

```text
Fix exactly this diagnosed application failure cluster:

<PASTE THE SMALL HANDOFF BLOCK FROM TRIAGE>

- Read PROJECT_GOAL.md, ARCHITECTURE.md, and run npm run context -- <apply|logs|storage> for the
  owning scope. Inspect only the named functions and nearest tests first.
- Verify the diagnostic evidence before editing; do not guess from the reason string alone.
- Add or update a regression test that reproduces the observed evidence shape.
- Implement the smallest fix in the connected production path. Preserve pja_* keys, runId/job
  ownership, truthful-answer rules, confirmation evidence, and terminal diagnostics.
- Do not refactor unrelated ATS handlers or historical code.
- Run the targeted test, then npm test and git diff --check.
- Reload the extension after file changes and confirm /health reports clients: 1.
- Do not submit live applications. Use unit tests, local fixtures, dry-run planning, or an explicitly
  stop-before-submit retest.
- Report changed files, the root cause, test evidence, and the exact bounded live retest that would
  verify the fix later.
```

## 3. Improve a part of the end-to-end flow

Recommended: **Terra, Medium** for one or two connected improvements. Use **Sol, High** only for a
genuinely cross-cutting redesign. If `<X>`, `<Y>`, and `<Z>` are unrelated, run three fresh Terra
sessions instead of one large Sol session.

```text
Improve <X> in the unified /apply-all end-to-end flow.

Desired outcome:
<MEASURABLE ACCEPTANCE CRITERIA>

- Read PROJECT_GOAL.md and ARCHITECTURE.md, then run npm run context -- <RELEVANT SCOPE>.
- Trace the current connected path from entrypoint to outcome before proposing changes. Explicitly
  distinguish active, shadow, legacy, and dynamically loaded modules.
- Keep /apply-all as the unified entry and preserve IndexedDB corpus ownership, pja_ranked_apply,
  application-ledger evidence, pja_* compatibility, safety gates, and sanitized diagnostics.
- Prefer pure/testable modules over adding more logic to the large integration files.
- Keep model input bounded and use deterministic code for routing, filtering, state, and validation.
- Define the smallest implementation plan, implement it, add focused regression tests, then run
  npm test and git diff --check.
- Reload the extension and verify /health after changes.
- Do not launch or submit live applications unless the acceptance criteria explicitly require a
  separately authorized stop-before-submit/live test.
- Update ARCHITECTURE.md only if a runtime edge, owner, storage contract, or module status changed.
- Finish with: outcome, changed files, verification, remaining risk, and one recommended next step.
```

## Token-saving habits

- Use one objective and one failure cluster per implementation session.
- Supply report paths, run IDs, and compact handoff evidence instead of pasting whole logs.
- Use `npm run context -- <scope>` before reading code.
- Ask for a compact final report; avoid requesting a narrated play-by-play.
- Do not combine live operations, whole-repository review, refactoring, and log fixing in one prompt.
- Stay at Low or Medium reasoning by default. Escalate because of observed ambiguity, not because the
  task sounds important.
