# Dev Workflow — Job Application Assistant

This file is for developers working on the unpacked Chrome extension.

## Dev server

The dev server (`dev-server.js`) runs HTTP + WebSocket on port **6174**.

Start in Claude mode:

```bash
npm start
```

Start in Codex mode:

```bash
npm run start:codex
```

Equivalent explicit commands:

```bash
node dev-server.js --engine claude
node dev-server.js --engine codex
PJA_AI_ENGINE=codex node dev-server.js
```

Only run one server on port `6174`.

## Extension reload

After file changes:

```bash
curl -X POST http://localhost:6174/reload
curl -X POST http://localhost:6174/inject
```

Then refresh any open job/ATS tab.

Check connection:

```bash
curl http://localhost:6174/health
```

Expected:

```json
{"ok":true,"engine":"codex-cli","clients":1}
```

or:

```json
{"ok":true,"engine":"claude-cli","clients":1}
```

If `clients` is `0`, open `chrome://extensions`, enable Developer mode, reload the unpacked extension, and refresh a supported page.

## Loading in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository folder containing `manifest.json`.

The extension ID is installation-specific. Do not assume another developer has the same ID.

## Dev server endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | Server health, AI engine, and connected extension client count. |
| `/reload` | POST | Broadcasts reload to extension clients. |
| `/inject` | POST | Re-injects content scripts into existing supported tabs. |
| `/analyze` | POST | Scores one job `{title, company, description}`. |
| `/batch-score` | POST | Scores up to 10 jobs in one request. |
| `/answer-questions` | POST | Generates truthful answers for required form questions. |
| `/outreach` | POST | Generates outreach copy for a job/person. |
| `/apply-all` | POST | Sources jobs and starts a ranked application run across all supported channels. |
| `/source-v2` | POST | Builds/imports the normalized sourced job corpus. |
| `/apply-run` | POST | Starts a ranked application run from the corpus. |
| `/inspect-apply` | GET | Returns sanitized active application diagnostics. |
| `/get-storage` | POST | Reads selected extension storage keys through the WebSocket bridge. |
| `/set-storage` | POST | Writes selected extension storage keys. Body is passed flat. |
| `/launch-queue` | POST | Seeds `pja_ext_queue` from `test/test-jobs.json` and opens the first job. |

`/set-storage` example:

```json
{"pja_ext_queue":{"status":"aborted"}}
```

Do not wrap the payload in a `data` property.

## Architecture

```text
background.js          Service worker: AI routing, storage, queue dispatch, CDP/scripting.
content/
  extractors/          LinkedIn, Indeed, Glassdoor, generic job-data extraction.
  autofill.js          Field rules, text/select/radio/combobox fill helpers.
  auto-apply.js        LinkedIn Easy Apply modal automation.
  external-apply.js    External ATS automation and recovery.
  gmail-verify.js      Gmail verification-code/link helper.
  workday-auth.js      Workday auth/account/email-verification flow.
  job-scraper.js       LinkedIn scanner widget.
  content.js           Sidebar and message router.
popup/                 Pipeline, Search, Contacts tabs.
shortlist/             Scanner review page.
settings/              Profile, answer bank, templates, resume, preferences.
sourcing/              Job sourcing, dedupe, ATS adapters, scoring pipeline.
test/                  Offline syntax/privacy/unit/browser fixtures.
```

## Storage keys

| Key | Purpose |
| --- | --- |
| `pja_profile` | User profile fields from Settings. |
| `pja_answers` | Answer bank keyed by raw question label. |
| `pja_jobs` | Pipeline jobs. |
| `pja_shortlist` | Scanner/review results. |
| `pja_contacts` | Recruiter/contact tracking. |
| `pja_templates` | Outreach templates. |
| `pja_ext_queue` | Active external apply queue. |
| `pja_ext_current` | Current external apply job. |
| `pja_ranked_apply` | Serialized ranked application run. |
| `pja_application_ledger` | Durable application event ledger. |
| `pja_missing_questions` | Missing/manual questions to answer in Settings. |
| `pja_dbg` | Rolling debug log. |
| `pja_last_apply_failure` | Last failure diagnostic snapshot. |
| `pja_last_email_code_result` | Sanitized Gmail code recovery result. |

## Tests

Run all offline checks:

```bash
npm test
```

Run profile merge check:

```bash
npm run check:profile
```

Before pushing:

```bash
npm test
git diff --check
```

## Known external blockers

- CAPTCHA and anti-bot pages.
- LinkedIn/Indeed rate limits.
- Workday tenant auth/account restrictions.
- Gmail account sign-in state.
- Legal/export-control/citizenship questions without explicit profile data.

The extension should record these as terminal/manual states rather than guessing or bypassing them.
