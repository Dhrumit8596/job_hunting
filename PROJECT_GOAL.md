# Current Product Goal (Single-Holder Job Application Flow)

## Primary objective

From one action (extension button or CLI), discover jobs that match the candidate profile, rank them,
and run applications through one explicit routing path where each job is dispatched to the correct
handler by portal/channel:

- LinkedIn Easy Apply
- Indeed Easy Apply
- External ATS handlers (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, etc.)
- Generic/fallback handlers for nonstandard pages

The intent is a **single, consistent flow**:

1. Build one candidate-relevant job corpus.
2. Score all jobs and apply ranking filters.
3. Create and execute one ranked queue.
4. Route each job to the correct path (Easy Apply vs. ATS strategy).
5. Apply, persist results, and continue.

## Required behavior

- **One-click trigger exists in both surfaces**
  - Extension: one-click apply button in popup.
  - CLI: `npm run apply:all` wrapper (or equivalent `/apply-all` request).
- **Single-entry orchestration**
  - `/apply-all` should remain the entrypoint that coordinates sourcing + apply run.
- **Single-source planning**
  - Job sourcing, scoring, and apply routing should be centralized and explicit in one apply flow.
- **Drop logging for observability**
  - Jobs that are not launched or fail in preflight/validation should be logged with reason, host,
    and route in developer-readable artifacts (`reports/`).
- **Safe operation**
  - Respect stop-before-submit where enabled.
  - Keep resume/retry support and avoid silent drops.

## Working definition of done

- A single click in popup or CLI command results in the same planning logic.
- Every sourced job is deterministically either:
  - launched via a strategy handler, or
  - recorded as dropped with a reason (no-route, score gate, missing destination, etc.).
- Results are persisted in the job state so later runs are resumable and idempotent.
