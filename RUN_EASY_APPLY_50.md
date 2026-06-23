# Finishing the fresh-50: CDP-free Easy Apply run

The engineering is done (all sourcing + reliability fixes, 210 tests, both sourcing channels
validated live). The remaining gap to 50 fresh is an **apply-channel** limit: while an AI agent
drives the browser via Chrome DevTools Protocol (claude-in-chrome), the extension's own *trusted*
Easy-Apply step-clicks can't attach CDP (only one CDP client per tab), so EA auto-stepping is
blocked. Run it **without** the agent attached and the extension auto-steps cleanly.

## One-time setup
1. Close any claude-in-chrome / agent session (so the tab's CDP is free).
2. Confirm the dev server is up: `curl http://localhost:6174/health` → `{"clients":1}`.
   If `clients:0`, open `chrome://extensions` and click reload on the extension.

## Run the Easy Apply batch (auto-submits, properly paced)
1. Open a California Easy-Apply engineer search, e.g.:
   `https://www.linkedin.com/jobs/search/?keywords=quality%20engineer&location=California%2C%20United%20States&f_AL=true&f_E=2%2C3`
2. In the extension sidebar (Job Assistant), click **Scan All Searches** — it collects + fit-scores
   the CA Easy-Apply roles into the shortlist (the collector is fixed: ~100 per search across pages).
3. Then trigger auto-apply (sidebar **Auto-Apply** / the SEMI queue). The extension:
   - opens each Easy Apply via the reliable **search-page button** path,
   - fills contact/resume/screening via the shared AI answerer (BUG 1/2/3 fixed),
   - clicks Next/Review/Submit with **trusted** clicks (works because CDP is free),
   - records each to `pja_applied_log` with `channel:'easy-apply'`,
   - skips broken/login-gated/missing-required cleanly and continues.
4. It paces humanely. Let it run; it advances job-to-job and stops at the end of the queue.

## Guardrails already enforced by the code
- TN-title + CA/remote filter + **export-control company blocklist** (Cerebras/Oklo/defense/space)
  run before anything is queued.
- Dedup against `pja_applied_log` (no re-applying; excludes Applied Materials).
- Honest answers only — it skips (does not fabricate) screening questions it can't truthfully fill.
- Mid-refresh resilience + double-submit guard.

## Verify
- `curl -s -XPOST localhost:6174/get-storage -d '{"keys":["pja_applied_log"]}'` → count + channels.
- Spot-check confirmations in the applicant inbox (the address in `pja_profile.email`):
  "Thank you for applying" / "application sent".

## Login-gated ATS roles (Jabil/Abbott/Tesla/STAAR via Taleo/Workday/ADP/LiveHire)
These require creating an account/password, which the assistant will not do. Apply to those
manually if desired — they were sourced + fit-scored, but auto-submit is intentionally not attempted.
