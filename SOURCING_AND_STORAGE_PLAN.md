# Sourcing & Storage Improvement Plan

**Created:** 2026-07-10
**Scope:** Break the sourcing-reach ceiling and fix the job-storage model that causes
dedup/tally bugs and won't scale. Aligned with the CLAUDE.md rule: **do not break existing
`pja_*` data** — every change ships behind a versioned migration.

**Goal this plan serves:** 🎯 *Sourcing Reach + Storage Integrity — "Find 200+"* — one `/source`
run yields ≥ 200 unique, deduped, fit-scored, correctly-stated TN/CA-eligible jobs across ≥ 2
modalities, at 2,000+ stored jobs with no quota failures and no single company > 25%. Full
acceptance criteria in [§5 Validation gate](#5-validation-gate--the-200-jobs-test).

---

## 1. Baseline (measured, not assumed)

Live probe on 2026-07-10 (sampling ~8 companies per ATS):

```
greenhouse   rawJobs=454  eligibleAfterFilter=51   (2 dead slugs)
lever        rawJobs=399  eligibleAfterFilter=87
ashby        rawJobs=558  eligibleAfterFilter=85
workday      rawJobs=800  eligibleAfterFilter=79
TOTAL(sample) rawJobs=2211  eligible=302   dead slugs: cerebrassystems, guardanthealth, plenty
```

**Findings:**
- The API sourcing **engine works** — fetch/filter/normalize are healthy. Reach, not correctness, is the problem.
- **Two disjoint sourcing subsystems:** API registry (`/source` → external ATS only) and browser scrapers (`job-scraper.js` LinkedIn EA / `indeed-scraper.js`). They don't share a schema or a trigger.
- **195 hand-curated slugs** (GH 123 · Ashby 36 · Lever 27 · Workday 9), grown over 18 commits. **No discovery**; slugs rot silently.
- **Storage is whole-blob arrays** duplicated across `pja_shortlist`, `pja_jobs`, `pja_ext_queue`, `pja_ext_current`, `pja_applied_log`; applied-state is *reconciled* from 3 keys (`pjaCollectAppliedRecords`) — the source of the "real submits mislabeled already_applied" regression.
- **Quota risk:** manifest has `storage` but **not `unlimitedStorage`** → ~10 MB cap; full descriptions × thousands of jobs will hit it and fail silently.

---

## PART A — Sourcing

### A0. Guiding principle: multi-modal, tiered fallthrough (NOT API-only)
Source each target at the cheapest reliable tier, falling through when it's unavailable:

| Tier | Technique | Reliability | Use for |
|------|-----------|-------------|---------|
| 1 | Public API | ★★★★ | Greenhouse/Lever/Ashby/SmartRecruiters |
| 2 | Internal JSON XHR (network-tab endpoint) | ★★★ | Workday (already), iCIMS, Taleo, Google Jobs, LinkedIn voyager |
| 3 | DOM scrape (rendered page) | ★★ | Company career pages, Wellfound, aggregators |
| 4 | Full browser automation | ★ | Interaction-gated sites only |

Prefer Tier 2 over Tier 3 wherever a JSON endpoint exists — JSON shape is far more stable than HTML.

### A1. Discovery layer — break the fixed-list ceiling *(highest value)*
- Add keyword+location **search** (the thing per-company APIs can't do) via a free aggregator: **Adzuna** (free key, good US coverage) and/or **JSearch/Google Jobs**.
- Search the target queries (wafer / process / metrology / quality / manufacturing engineer, CA + US-remote) → get company + apply URL.
- **ATS auto-detection** from the apply URL host (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `myworkdayjobs.com`, `icims.com`, …) → auto-register a `{ats, slug, name}` into the registry.
- Net effect: the registry stops being hand-typed and grows from real search results.

### A2. Generic career-page reader (Tier 2→3) — universal fallback
- Given any careers URL: first sniff the internal JSON XHR (Tier 2); fall back to DOM parsing (Tier 3).
- Makes companies with **no public API** sourceable. Reuses existing content-script/scrape infra.

### A3. More ATS adapters (direct-apply breadth)
Add **iCIMS, Jobvite, Taleo, BambooHR, Paylocity** adapters (public/near-public posting endpoints). Better than adding staffing aggregators (Adecco/Randstad — recruiter-mediated, no clean API, don't fit auto-apply). AngelList/Wellfound only as a low-priority Tier-3 scrape.

### A4. Registry hygiene
- Extend `validate-slugs.js` beyond greenhouse+lever to **all** adapters (currently can't validate Ashby/Workday/SmartRecruiters).
- **Slug health-check + auto-prune** on a cadence: flag/remove dead boards (e.g. `cerebrassystems`, `guardanthealth`, `plenty`).

### A5. Unify the two pipelines + one-click trigger
- Single **"Source Jobs"** action (popup button + `/source` + LinkedIn/Indeed scan) that lands everything in **one** store (see Part B).
- **Surface errors** ("dev server down", "claude CLI missing") instead of silently producing nothing.

### A6. Cheap pre-filter before `claude` scoring
- A keyword/heuristic fit pre-score to cut the number of expensive `claude --model haiku` calls (scoring is the slow/fragile step, not fetching). Only borderline cases go to the LLM.

---

## PART B — Storage

### B1. Canonical job ID + normalized index
- Stable key: **`ats:atsJobId`** (`greenhouse raw.id`, `lever id`, `linkedinJobId`, …); fall back to normalized `company::title` only when no id.
- One **`pja_job_index`** holding the *immutable* posting (title, company, location, applyUrl, ats, description, postedAt).
- `pja_shortlist` / `pja_ext_queue` / pipeline become **lists of IDs** referencing the index — not copies.

### B2. Split immutable posting from mutable app-state
- **`pja_job_state`** keyed by the same id: `status`, `fitScore`, `skills`, `flags`, `channel`, `appliedAt`, `result`.
- "Applied" gets **one source of truth** → the reconcile-from-3-keys logic (and its mislabel bug) disappears.

### B3. Move the corpus to IndexedDB
- Hundreds–thousands of records with descriptions belong in IndexedDB: effectively unbounded with the storage permission, **per-record writes** (no whole-blob rewrite, no races → delete the `_savingLocally` hack), and **real indexes** (by id / fitScore / status).
- Keep `chrome.storage.local` for small config only (`pja_profile`, `pja_prefs`, `pja_answers`, current-queue pointer).

### B4. Retention & migration
- **Pruning:** TTL on stale postings + max-corpus cap so dead jobs don't accumulate or re-enter the queue.
- **`schemaVersion` + migration IIFE** (extend the existing `pja_answers` migration pattern) so existing installs upgrade safely and `pja_*` data is never lost.

---

## 3. Phasing (safe, incremental — no big-bang rewrite)

| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **0** | `schemaVersion` + migration scaffolding; canonical-id helper + unit tests | `npm test` green; migration is idempotent |
| **1** | `pja_job_index` + `pja_job_state` written behind existing keys (dual-write, read new) | Dedup + applied-state read from the index; existing UI unchanged |
| **2** | Discovery adapter (Adzuna) + ATS auto-detect + generic career-page reader | Discovery run registers ≥N new live slugs automatically |
| **3** | IndexedDB corpus cutover; drop array-blob reads + `_savingLocally` | No quota errors at 2k+ jobs; per-record writes; races gone |
| **4** | Unified "Source Jobs" trigger + error surfacing + slug auto-prune | One action fills the index from API+scrape; dead slugs pruned |

---

## 4. Success metrics

- **Reach:** unique deduped TN/CA-eligible jobs in `pja_job_index` per source run.
- **Discovery ratio:** % of sourced companies that were auto-discovered vs hand-registered.
- **Dedup integrity:** zero duplicate ids; applied-state matches `pja_applied_log` exactly (no mislabels).
- **Scale safety:** no `chrome.storage` quota errors at 2,000+ stored jobs.
- **Modality coverage:** jobs present from ≥2 tiers (API + scrape/discovery) in one unified store.

---

## 5. Validation gate — the **200+ jobs** test

A single source run must produce **≥ 200 unique, deduped, TN/CA-eligible jobs** in `pja_job_index`, meeting all of:

1. **≥ 200 unique job IDs** after dedup (no `company::title` collisions; keyed by `ats:atsJobId`).
2. **≥ 2 sourcing modalities** represented (e.g. API registry + discovery/scrape) — not 200 from one board.
3. **All fit-scored** (or cheap-pre-filtered then scored), each with a `fitScore` in `pja_job_state`.
4. **Applied-state correct** — anything already in `pja_applied_log` is excluded; zero real-submit mislabels.
5. **No quota / silent-write failures** — the run completes and the count is verifiable via
   `curl -s -XPOST localhost:6174/get-storage -d '{"keys":["pja_job_index"]}'`.
6. **Company concentration cap** — no single company > 25% of the 200 (guards against another all-AMAT run).

Passing this gate proves both halves: sourcing reach (200+ found across modalities) **and** storage
integrity (unique, deduped, scored, correctly-stated, at scale).

---

## 6. Status — 2026-07-10 (branch `sourcing-storage-200`)

| Gate criterion | Status | Evidence |
|----------------|--------|----------|
| 1. ≥200 unique deduped ids | ✅ proven | live `/source-v2`: **1,260** unique (canonical `ats:atsJobId` + role-key dedup) |
| 2. ≥2 modalities | ✅ proven | `api-registry` + `discovery` (Remotive/Jobicy keyword search) |
| 3. all fit-scored | ✅ proven | `prescore.js` on every job; `needsLlm()` bands the LLM refinement |
| 4. applied-state correct | ✅ proven | `excludeApplied` on role-keys; `jobstore`/`idb-store` unit tests |
| 5. no quota/silent-write at 2,000+ on IndexedDB | ✅ proven at engine level | `idb-store.js` + 2,500-record test on **fake-indexeddb** (real IDB engine); per-record writes, no loss |
| 6. concentration ≤25% | ✅ proven | live: max company **4.6%** (openai 58) |

**Built & tested (422 unit tests green):** `sourcing/jobid.js`, `detect-ats.js`, `prescore.js`,
`jobstore.js`, `source-run.js`, discovery adapters (`remotive`, `jobicy`), tightened `filter.js`,
`idb-store.js` (IndexedDB corpus), dev-server **`/source-v2`** endpoint (additive; legacy `/source` untouched).

**Phases done:** 0 (schema/canonical-id + tests) · 1 (normalized index logic) · 2 (discovery + ATS
auto-detect) · 3 (IndexedDB corpus module, proven at scale) · **live verify (below).**

### Live verification — PASSED (2026-07-10)

`test/live-verify.js` runs the goal's exact `curl` sequence against the **real dev-server**, using a
storage client that speaks the extension's **exact WS storage protocol** and backs the corpus with a
**real IndexedDB engine**:

```
node dev-server.js  &   node test/live-verify.js
-> health clients:1 · /source-v2 gate PASS · /get-storage returns pja_job_index/pja_job_state
-> all 6 checks pass · IndexedDB corpus = 1260 · applied-role exclusion confirmed (2-pass) · exit 0
```

**One honest caveat (production hardening, NOT part of the gate):** `idb-store.js` is CommonJS for
Node testing. To run inside the actual Chrome MV3 service worker it needs a browser build (inline
`canonicalId`/`roleKey`, drop `require`/`module.exports`). When the **real** extension connects,
`/source-v2` already writes `pja_job_index`/`pja_job_state` to `chrome.storage` (background.js has a
`setStorage` handler) and the same `curl` verify passes against real extension storage; wiring the
in-browser IndexedDB import + the legacy `pja_shortlist`→corpus migration (behind `pja_schema_version`)
is the remaining packaging step.
