# Apply Engine Plan — Review all sourced jobs → apply everything that matches

**Created:** 2026-07-10
**Goal:** From the sourced job corpus, review every job, select the ones that genuinely match the
resume, and **apply to all of them through the extension** — with an explicit, robust flow:

```
job link  →  identify portal/ATS type  →  pick the matching apply strategy
          →  prepare (auth/account if needed)  →  fill (profile + resume + AI answers, verified)
          →  submit (trusted, success-detected)  →  record result  →  advance
```

This document is grounded in the current code (file:line references). It states honestly what
already exists, what's missing, and what to build to make batch job-application **solid**.

---

## 1. The flow we want (target)

A single, explicit pipeline — not the implicit host-guard routing we have now:

```
┌─ REVIEW ──────────────────────────────────────────────────────────────────┐
│ corpus (IndexedDB pja_job_index/state)                                      │
│   → LLM fit-score any unscored jobs                                         │
│   → resume-match gate (fit ≥ threshold AND honest, TN-eligible, not applied)│
│   → produce an ordered apply set                                            │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │  per job
┌───────────────▼─────────────────────────────────────────────────────────────┐
│ APPLY (one job)                                                              │
│  1. open applyUrl                                                            │
│  2. IDENTIFY PORTAL  → detectAts(url) + content sniff  → ATS type            │
│  3. SELECT STRATEGY  → registry[atsType]  (greenhouse|lever|ashby|workday|   │
│                         smartrecruiters|indeed|linkedin-ea|generic|unsupported)│
│  4. PREPARE          → login/account/verify if the strategy needs it        │
│  5. FILL             → profile + resume upload + AI answers, VERIFY each field│
│  6. SUBMIT           → trusted click, detect success                        │
│  7. RECORD           → write result to corpus state + pja_applied_log        │
│  8. ADVANCE          → next job                                             │
└───────────────────────────────────────────────────────────────────────────┘
```

The two capabilities that make this real and don't exist yet: **(a) an explicit ATS dispatcher /
strategy registry** (step 2–3), and **(b) a corpus→apply batch driver** (the REVIEW box).

---

## 2. Current state (grounded)

### 2.1 There is NO central ATS dispatcher
Routing today is emergent: a tab lands on a host, and whichever content script's host-guard passes
handles it. `manifest.json:30-107` loads every engine on matching hosts; each self-selects:
- `content/external-apply.js:32,120-126` — `ATS_PATTERNS` + `knownATS`/`looksLikeCareer` guard.
- `content/indeed-apply.js:9-14` — indeed.com/smartapply host gate.
- `content/auto-apply.js` + `content/content.js:736-892` — LinkedIn Easy Apply loop.
- `sourcing/router.js:20-57` splits jobs into `ea`/`indeedApply`/`external` channels *before* tabs
  open, keyed off `platform`/`indeedApply`/`isEasyApply` flags — **not** off a detected ATS.
- **`sourcing/detect-ats.js` is used only in sourcing** (`adapters/remotive.js`, `jobicy.js`, tests);
  **zero references in the apply path.** The "identify the portal" step exists as a function but is
  never called when applying.

### 2.2 Two parallel, unjoined tracks
- **Legacy:** `/source` → `runPipeline` (filter→dedupe→**LLM `scoreAll`**→`routeJobs` threshold 70,
  `dev-server.js:707-765`, `sourcing/pipeline.js:33-40`) → writes `pja_shortlist`, and only if
  `queueLimit>0` builds `pja_ext_queue` for auto-submit.
- **New corpus:** `/source-v2` → `sourceAll` (**heuristic `prescore` only, no LLM**) → IndexedDB
  `pja_job_index`/`pja_job_state` (`dev-server.js:774-796`, `idb-store.js`).
- **The only bridge** is a manual "Load top 200 into review" button (`shortlist/shortlist.js`) that
  copies corpus jobs into `pja_shortlist` as `pending`, then per-job manual Approve → `startApply`.
- **No automated corpus → fit-scored → batch-apply driver exists.** (Confirmed.)

### 2.3 Per-ATS apply coverage (honest map)

| ATS | Coverage | Notes |
|-----|----------|-------|
| **Workday** | ✅ Deep, e2e | full auth state machine (`workday-auth.js`), multi-step wizard, work-exp, app-questions, resume server-parse re-fill |
| **Greenhouse** | ✅ Deep | react-select fiber+CDP commit, country/education/Google-Places location, checkbox groups, phone (US default) |
| **Lever** | 🟡 Partial | single-page generic path + label/upload/policy-radio helpers; no multi-step |
| **SmartRecruiters** | 🟡 Partial | one-click resume-first branch; else generic |
| **Ashby** | 🟡 Thin | a couple hooks; mostly generic (works because Ashby bypasses the CDP problem) |
| **iCIMS** | ❌ Generic→likely fail | iframe portal + multi-step; frame traversal + step-advance unhandled |
| **Taleo** | ❌ Generic→likely fail | legacy multi-page + frames + login gate |
| **SuccessFactors** | ❌ Generic→likely fail | heavy wizard + auth wall |
| **Jobvite** | 🟡 Generic mixed | standard tenants OK; iframe tenants break |
| **Workable / Breezy / BambooHR / Paylocity / Rippling** | 🟡 Generic likely-OK | standard single-page forms; weak on custom widgets + success detection |

Generic path = `findApply`→`pjaFillForm`→`findMissingRequired`→`pjaFillUnknownTextFields`/
`pjaAnswerRequiredViaAI`→`tryInjectResume`→submit→`pjaIsSubmitSuccess` (`external-apply.js`).
Result taxonomy at `recordResult` (`external-apply.js:2652`): `applied`, `needs_login`,
`missing_required`, `submit_unclear`, `posting_not_found`, `google_sso_only`,
`workday_account_locked`, `workday_captcha`, `chatbot_apply_manual`, etc.

### 2.4 "Matches the resume" today
- The resume is an **opaque base64 blob** (`pja_resume_b64`, `settings/settings.js:150-154`), used
  **only for file upload** (`tryInjectResume`, `external-apply.js:1427`). **No scorer reads it.**
- "Match" is really the **LLM fit score** whose skill list is **hard-coded in the prompt**
  (`dev-server.js:168` SCORE_SYSTEM_PROMPT) — decoupled from the actual resume file. Gate = fit ≥ 70
  (`pipeline.js:33`).
- The corpus currently carries only the **heuristic `prescore`**, not the LLM score.

### 2.5 Guardrails that already exist (must be preserved)
- **Honest-fit** (never fabricate skills): enforced in prompts (`dev-server.js:169-170`,
  `background.js:939-948` HONEST GAPS). TN-ineligible titles forced ≤25.
- **Dedup vs `pja_applied_log`** (`dedupe.js:58-66`, jobId-aware).
- **Daily cap:** LinkedIn EA reactively halts on the cap notice (`auto-apply.js:960-967`); no numeric counter.
- **TN/export gates** (`filter.js`).
- **stop-before-submit** flag exists for review-before-submit.

---

## 3. What to build (new)

### NEW-1. ATS dispatcher + apply-strategy registry  *(the "identify portal → pick flow" step)*
Create `content/apply-router.js` (runs in the apply tab, replaces the implicit host-guard scramble):
- `identifyPortal()` = `detectAts(location.href)` (promote `sourcing/detect-ats.js` to a shared
  module usable in content scripts) **+** a DOM/content sniff fallback (react-select markers, Workday
  `data-automation-id`, Greenhouse `#application-form`, iframe detection) for when the host is a
  company career domain that redirected into an ATS.
- A **strategy registry**: `{ greenhouse, lever, ashby, workday, smartrecruiters, icims, taleo,
  successfactors, jobvite, workable, breezy, bamboohr, paylocity, rippling, generic, indeed,
  linkedin_ea }`. Each strategy implements a common interface:
  `{ detect(), prepare(profile), fill(profile, answers), findMissing(), submit(opts), classifyResult() }`.
- Refactor the existing deep logic (Workday, Greenhouse) and the generic path into strategies behind
  this interface — no behavior change, just make selection **explicit and testable** instead of
  emergent. Unknown/unsupported ATS → `unsupported` strategy → mark job `needs_manual`, don't thrash.
- **Acceptance:** given a URL, the router logs the chosen strategy; unit tests map representative
  URLs+DOM to the right strategy; `detect-ats` drives a real runtime decision.

### NEW-2. Corpus → apply batch driver  *(the "review all, apply all matching" step)*
Add a driver (dev-server endpoint `/apply-run` + extension-side consumer) that:
1. Reads the **IndexedDB corpus** (`GET_JOB_CORPUS` / a new `getCorpusFull`).
2. **Fills in fit:** LLM-scores (`scoreAll`) any corpus job whose `state.fitScore` is only the
   heuristic prescore (or in the `needsLlm` band), writing the real score back to `pja_job_state`.
3. **Resume-match gate:** select jobs with fit ≥ threshold (default 70), TN-eligible, not in
   `pja_applied_log`, not `needs_manual`, respecting the daily cap.
4. **Groups by strategy** (via NEW-1's `detectAts` on `applyUrl`) so same-ATS jobs batch efficiently
   and login-gated ATSes (Workday) reuse a session.
5. Builds `pja_ext_queue` from that set and drives the existing auto-advance apply loop.
6. **Writes each result back to `pja_job_state`** (`status: applied|failed|needs_login|needs_manual`,
   `result`, `appliedAt`) so the corpus reflects progress and re-runs are idempotent.
- **Acceptance:** one command reviews the whole corpus and applies every matching job, resumable,
  with a per-job result visible in the corpus; re-running skips already-applied.

### NEW-3. Resume-driven matching (make "matches the resume" literal)
Today match ≠ resume (skills are prompt-hardcoded). Add:
- A **structured `pja_resume`** parsed once from the uploaded file (skills, titles, years, domains) —
  parse via the `claude` CLI on upload in `settings.js`.
- Feed the structured resume into the scoring prompt so fit is computed against *the actual resume*,
  not a static prompt. Keep the honest-gaps rule.
- **Acceptance:** editing the resume changes which jobs match; skills come from the resume, not code.

### NEW-4. Harden / extend per-ATS strategies
- **iframe-embedded ATSes (iCIMS, some Jobvite):** add same-origin iframe traversal in field
  discovery + resume upload (`findMissingRequired`, `tryInjectResume` currently only cross shadow
  roots, not frames — `external-apply.js`). Cross-origin iframes → `needs_manual`.
- **Multi-step / auth-gated legacy (Taleo, SuccessFactors):** either a Workday-style step+auth
  strategy or an explicit `unsupported → needs_manual` classification (don't silently fail as
  `missing_required`).
- **Modern single-page (Workable/Breezy/BambooHR/Paylocity/Rippling):** validate the generic path
  live; add per-ATS success-phrase patterns so submits aren't misread as `submit_unclear`.
- **Non-US phone country picker** (currently skipped → US default): fine for this candidate; note it.

### NEW-5. Solidity (make it reliable, not just working)
- **Verify-after-fill:** after each field/commit, read the value back; retry N times; only proceed
  when it actually stuck (closes the degraded-CDP failure mode where react-selects silently don't
  commit). Escalate via the existing self-heal ladder (`cdp-selfheal.js`).
- **Preflight per job:** dead-posting check (`pjaIsClosedPosting`), login/account/CAPTCHA detection
  → classify `needs_login`/`needs_manual` and skip cleanly (no wasted time, no thrash).
- **Honest-skip:** if a required question can't be answered truthfully → skip the job (record
  `needs_manual`), never fabricate (existing rule, enforce in the driver).
- **Ground-truth reconciliation:** run `confirmation-tracker.js` against Gmail after a batch so
  `applied` is backed by real confirmation emails, not just on-page detection.
- **Pacing + caps:** humane 15–40s spacing (exists), plus a **numeric daily-cap counter** per channel
  (LinkedIn especially) instead of only reactive halt.
- **Idempotency + resume:** driver resumes from `currentIndex`; corpus write-back makes re-runs safe.
- **CDP contention:** Easy Apply must run agent-free (single CDP client); the driver should refuse to
  start EA if another debugger is attached.

### NEW-6. Review UI
Extend the shortlist page (or a new "Apply Run" view) to: show all sourced jobs with fit score +
apply status from the corpus, a "**Review & Apply All Matching**" button (fit ≥ threshold), live
progress (applied / skipped / needs-manual), and a **needs-manual queue** the user finishes by hand.

---

## 4. Autonomy model — automate everything, incl. account creation (decided)

The run is **fully autonomous / no human-in-the-loop** and automates as much as possible, including
**account creation and sign-in**, generalizing the pattern that already works for Workday.

**Automated (built into the strategy registry):**
- **Account creation** on any ATS that requires it: generate a **plus-addressed email**
  (`<base>+<tenant>@gmail.com`), fill it + the user's **stored `pja_job_password`**
  (`settings.js`), submit, then run the **Gmail email-verification loop** (`workday-auth.js`
  `runGmailVerify` → open Gmail tab → scrape the confirm link → resume). This is exactly the Workday
  flow (`workday-auth.js` `runCreateAccount`/`detectScreen`) promoted into the shared registry so
  iCIMS/Taleo/SuccessFactors/Jobvite/etc. create accounts the same way.
- **Sign-in / password fill / email verification** — autonomous, from stored config.
- **Fill + submit** on standard ATS forms — autonomous auto-submit.

**Auto-skip → deferred (not paused, not forced):**
- **CAPTCHA / bot-detection** → **skip → `needs_manual`.** Never auto-solved — see §8.
- **Repeated fill/submit failure on a job** → after N attempts, **skip → `needs_manual`** and continue
  (the user's rule: "if it keeps failing we can skip and keep it for later"). A per-job attempt
  counter in `pja_job_state` drives this; deferred jobs are retried in a later run.
- **Genuinely stuck auth** (a portal whose account flow the strategy can't complete) → `needs_login`.

A `needs_manual` / `needs_login` bucket collects everything deferred, so nothing is lost — a small
review queue the user finishes by hand, and re-runs retry it automatically.

---

## 5. Phased rollout

| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **A** | `apply-router.js`: `identifyPortal` (detect-ats + DOM sniff) + strategy registry; refactor existing Workday/Greenhouse/generic behind the interface (no behavior change) | unit tests: URL/DOM → correct strategy; live: existing applies still work |
| **B** | Corpus→apply batch driver (`/apply-run`): LLM-score corpus, resume-match gate (**fit ≥ 70**), build queue, drive apply **fully autonomous / auto-submit**, per-job attempt counter, **write results back to corpus** | one run applies all matching corpus jobs unattended; resumable; corpus shows per-job status; repeated-fail → `needs_manual` |
| **C** | Verify-after-fill + preflight + auto-skip-to-needs_manual (CAPTCHA/login/repeated-fail) + confirmation reconciliation | degraded-CDP no longer produces false "applied"; blockers classified + skipped, not silent-failed |
| **D** | ATS strategies for the hard set (**build now, per decision**): iCIMS + Jobvite iframe traversal, Taleo + SuccessFactors multi-step/auth strategies; single-page success-phrase patterns (Workable/Breezy/BambooHR/Paylocity/Rippling) | live applies succeed or classify cleanly on each target ATS |
| **E** | Review UI: fit + status, "Apply All Matching", `needs_manual` queue | user runs the whole thing from one screen |
| **~~F~~ (deferred)** | Resume parsing → structured `pja_resume` (NEW-3) | *Deferred per decision — keep curated prompt skill-list; "match" = LLM fit score.* |

---

## 6. Success criteria (the whole feature)

1. From a fresh corpus, one action reviews every job and applies to **every genuine-fit, TN-eligible,
   not-already-applied** job through the extension.
2. Each applied job is recorded in `pja_job_state` + `pja_applied_log`, reconciled against Gmail
   confirmations; re-runs are idempotent.
3. Every job is routed by an **explicit** portal-detection → strategy step (no emergent host-guard
   routing); unsupported portals land in a **needs-manual** queue, never silently fail.
4. Zero fabricated answers; honest-gaps skips recorded as `needs_manual`.
5. Reliability: degraded-CDP self-heals; login/CAPTCHA/account steps pause for the human.

---

## 7. Decisions (locked 2026-07-11)

1. **Run mode:** ✅ **Fully autonomous / auto-submit, no human-in-the-loop.** No interactive pauses;
   anything needing a human auto-skips to `needs_manual`/`needs_login` (see §4). Repeated failure on a
   job → skip and defer for later.
2. **Fit threshold:** ✅ **70** (matches sourcing).
3. **Unsupported ATSes (Taleo / SuccessFactors / iCIMS):** ✅ **Build strategies now** (Phase D) —
   iframe traversal + multi-step/auth handling, not just route-to-manual.
4. **Resume matching:** ✅ **Keep the curated prompt skill-list for now** — "match" = LLM fit score.
   Resume parsing (NEW-3) is **deferred**.
5. **Daily volume cap:** not specified — default to a soft numeric counter (~30/day, tunable) to look
   human and respect LinkedIn; easy to change.
6. **Account creation:** ✅ **Automated** (decided 2026-07-11) — plus-addressed Gmail + stored
   `pja_job_password` + Gmail verification loop, generalized from the working Workday flow to all ATS
   strategies. Sign-in, password fill, and email verification are all autonomous.

## 8. Safety boundary (only one, and why)

The single thing the driver never does — even fully autonomous — is **auto-solve CAPTCHAs / bypass
bot-detection**. That is deliberate bot-detection evasion: it violates ATS terms of service and, in
practice, is the fastest way to get an **account flagged and banned** — which would destroy the
accounts the driver just created and void the applications. So a CAPTCHA defers the job to
`needs_manual` (the user clears it by hand in seconds) and the run continues.

Notes on credentials: passwords come **only** from the user's own stored `pja_job_password`
(chrome.storage, gitignored) — the driver fills that value, it never generates or exfiltrates
credentials. During live verification the **extension** performs account creation/sign-in autonomously
(the code under test); the assistant drives only the dev-server and observes.
