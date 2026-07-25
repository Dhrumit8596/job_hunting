# Job Application Assistant

A Chrome MV3 extension for job searching, job-fit scoring, profile-based form filling, and application tracking.

The extension is meant to be reusable for any user/profile. The repository should not contain real resume data, personal profile data, passwords, one-time codes, or browser session data. Real user data lives locally in that user's Chrome profile via `chrome.storage.local`.

## Fastest setup: ask your AI CLI to do it

If you are giving this repo to someone who uses Claude Code or Codex, they can paste one of these prompts after cloning the repo. The AI assistant should install npm dependencies, run checks, start the right server, and then tell the user the few Chrome clicks it cannot perform from the terminal.

Claude CLI prompt:

```text
I cloned this repo. Read README.md, CLAUDE.md, package.json, and DEVNOTES.md. Set up everything needed to run it locally with Claude CLI. Install npm dependencies, run tests, start the dev server in Claude mode, verify /health, and tell me the exact Chrome extension loading steps I need to do manually. Do not put any personal profile data, resume, password, API key, Gmail content, or one-time code into git.
```

Codex CLI prompt:

```text
I cloned this repo. Read README.md, AGENTS.md, package.json, and DEVNOTES.md. Set up everything needed to run it locally with Codex CLI. Install npm dependencies, run tests, start the dev server in Codex mode, verify /health, and tell me the exact Chrome extension loading steps I need to do manually. Do not put any personal profile data, resume, password, API key, Gmail content, or one-time code into git.
```

After the AI assistant finishes, the user usually still needs to do the Chrome UI step:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open extension Settings and fill the user's profile/resume locally.

The AI assistant can verify the setup with:

```bash
npm test
curl http://localhost:6174/health
```

## What this does

- Scans/searches LinkedIn and Indeed job pages.
- Scores jobs against the user's profile/resume using a local Claude CLI or Codex CLI companion server.
- Maintains a shortlist and application pipeline.
- Fills external ATS applications, including Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Jobvite, iCIMS, and generic ATS pages.
- Uploads the user's locally saved resume from extension settings.
- Uses an answer bank for recurring form questions.
- Records missing questions so the user can answer them once and reuse those answers later.
- Tracks application outcomes in a durable ledger.
- Attempts bounded recovery when a form is blocked, including LLM-assisted page analysis.

Automation is intentionally conservative. It should not fabricate qualifications, skills, work authorization, citizenship, or employment history. If a question cannot be answered from the user's profile/resume/answer bank, the extension should pause, record the missing question, or mark the job as needing manual review.

## Current important limitations

- CAPTCHA is an acceptable blocker. The extension records it and advances/skips instead of trying to bypass it.
- LinkedIn/Indeed can show anti-bot pages, rate limits, or daily caps.
- Some Workday tenants require account creation, email verification, or manual auth recovery.
- Some Greenhouse/ATS forms ask citizenship/export-control/permanent-residence questions. The user must provide those profile facts explicitly; the extension should not infer them from visa status.
- Real employer confirmation is not always deterministic. A submission should only be counted as confirmed when the page or email provides evidence.

## Requirements

Install these first:

- Google Chrome.
- Git.
- Node.js 18+.
- npm.
- One local AI CLI:
  - Claude CLI, if using `claude`.
  - Codex CLI, if using `codex`.

Only one AI CLI is required. Use whichever subscription/account the user has.

## Clone and install

```bash
git clone https://github.com/Dhrumit8596/job_hunting.git
cd job_hunting
npm install
npm test
```

`npm test` runs syntax checks, privacy scan, and unit tests. It should pass before loading or sharing changes.

## Start the local companion server

Keep this running in a terminal while using AI scoring, answer generation, sourcing, or application automation.

Claude CLI mode:

```bash
npm start
```

Equivalent explicit form:

```bash
node dev-server.js --engine claude
```

Codex CLI mode:

```bash
npm run start:codex
```

Equivalent environment-variable form:

```bash
PJA_AI_ENGINE=codex node dev-server.js
```

Check that the server is alive:

```bash
curl http://localhost:6174/health
```

Expected while Chrome extension is connected:

```json
{"ok":true,"engine":"codex-cli","clients":1}
```

or:

```json
{"ok":true,"engine":"claude-cli","clients":1}
```

If `clients` is `0`, reload the extension from `chrome://extensions` or refresh a supported job page after loading the extension.

## Load the Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the cloned repository folder, the folder that contains `manifest.json`.
6. Keep the extension enabled.
7. Pin the extension if you want quick access from the Chrome toolbar.

The extension ID can be different on another machine. Do not hardcode someone else's extension ID.

After code changes, reload the extension:

```bash
curl -X POST http://localhost:6174/reload
curl -X POST http://localhost:6174/inject
```

Then refresh any open LinkedIn/Indeed/ATS page so the new content script loads.

## First-time setup in the extension

Open the extension Settings page and fill in:

- Name and contact info.
- Current location.
- LinkedIn profile URL.
- Website/GitHub/portfolio URL, if relevant.
- Education.
- Work history/current title/current company.
- Work authorization.
- Sponsorship requirement.
- Visa status, if applicable.
- Citizenship/permanent-residence/export-control facts if the user wants unattended handling of export-control questions.
- Salary expectation, availability/start date, relocation preference, and travel/commute preferences.
- EEO fields only if the user wants the extension to answer those.
- Resume upload.

Resume is stored locally in Chrome storage and is not committed to git.

## Profile-building questions the user should answer

PDF resume extraction will not reliably answer every application question. Add these in Settings/answer bank before serious application runs:

- Are you legally authorized to work in the target country?
- Will you now or in the future require sponsorship?
- What visa/work authorization status should be used when asked?
- What country are you a citizen/national of?
- What country are you a permanent resident of, if any?
- Are you a “U.S. person” for export-control purposes? Only answer if the user knows this fact.
- Are you willing to relocate?
- Are you willing to commute/on-site/hybrid?
- Are you willing to travel?
- Earliest start date or notice period.
- Desired salary or compensation range.
- Referral source, e.g. LinkedIn.
- Current employer and current title.
- Education start/end dates, degree, major/discipline, school.
- LinkedIn profile URL.
- Personal website/portfolio/GitHub.
- Recurring skills questions where the answer is known and factual.

If the extension records a missing question, answer it in Settings so future forms can reuse it.

## How to use

Basic flow:

1. Start the companion server.
2. Confirm `/health` shows one connected client.
3. Open LinkedIn or Indeed in Chrome.
4. Use the extension to scan/search jobs.
5. Review the shortlist and scores.
6. Start an application run only after reviewing the jobs.
7. Watch the run for manual blockers such as CAPTCHA, login, unclear legal/work-authorization questions, or missing profile data.

For safer testing, enable any stop-before-submit/review option available in Settings before running against real jobs.

## Example prompts and workflows

These are example prompts a user can give to Claude Code, Codex, or another local coding assistant while working in this repository. Start the companion server first and keep Chrome open with the unpacked extension loaded.

### Setup and verification prompts

```text
Check that my local job extension is ready to use. Verify npm tests, dev-server health, Chrome extension connection, and tell me what I still need to configure in Settings.
```

```text
Start this repo in Codex CLI mode, reload the Chrome extension, and confirm /health shows one connected client.
```

```text
Start this repo in Claude CLI mode, reload the Chrome extension, and confirm /health shows one connected client.
```

```text
Review my extension Settings completeness. Tell me which profile, resume, work authorization, citizenship/export-control, and answer-bank fields are missing before I run real applications.
```

### LinkedIn / Indeed search prompts

```text
Open LinkedIn Jobs, scan Easy Apply jobs that match my profile, score them against my resume, and show me the shortlist before applying.
```

```text
Find LinkedIn Easy Apply jobs for my target titles and location. Score by resume match, not just title match. Do not submit anything until I approve the shortlist.
```

```text
Search Indeed for jobs matching my profile, collect candidates, score them, and stop at review. Do not apply yet.
```

```text
Refresh the job corpus from LinkedIn/Indeed/ATS sources, dedupe against already-applied jobs, and show the top 25 matches with evidence and gaps.
```

### Application prompts

```text
Apply to reviewed LinkedIn Easy Apply jobs only. Stop on CAPTCHA, login, missing legal/work-authorization facts, or unclear questions. Do not fabricate answers.
```

```text
Apply to the top 10 reviewed external ATS jobs. Use my profile, resume, and answer bank. Skip CAPTCHA jobs. Record each result as confirmed, skipped, needs_manual, or failed with reason.
```

```text
Run an E2E test for 5 jobs from the current shortlist. Use stop-before-submit if available, and report which forms filled successfully, which hit CAPTCHA, and which need more profile answers.
```

```text
Continue the active application run. If a job is stuck, inspect /inspect-apply, capture the page status, ask the local AI helper for recovery, and either recover or record a terminal reason.
```

### Greenhouse / Workday recovery prompts

```text
Test one Greenhouse job end to end. If Greenhouse asks for an email security code, open the configured Gmail account, find the fresh matching Greenhouse email, fill the code, and resubmit. Reject stale or wrong-company codes.
```

```text
Test one Workday job end to end. If Workday requires an account, create or recover it using the configured job email/password, verify through Gmail if needed, then resume the application. Stop on CAPTCHA or account lock.
```

```text
Inspect the last failed Greenhouse application. Tell me whether it failed because of CAPTCHA, missing required profile data, email verification, no submit button, or unclear confirmation. Then propose the smallest code or profile fix.
```

### Debugging prompts

```text
What is currently pending in the application queue? Use /inspect-apply and storage diagnostics. Do not start a new run.
```

```text
Why did the last 10 applications fail? Group failures by reason and identify which are code fixes versus expected external blockers.
```

```text
Check whether any profile-specific personal data is committed. Run the privacy scan and grep for names, emails, phone numbers, LinkedIn profile URLs, passwords, and one-time codes.
```

```text
Make the repo ready to share with a non-technical friend. Update docs, remove personal defaults, run tests, commit, and push.
```

### Direct command examples

Start Codex mode:

```bash
npm run start:codex
```

Start Claude mode:

```bash
npm start
```

Check extension connection:

```bash
curl http://localhost:6174/health
```

Reload after code changes:

```bash
curl -X POST http://localhost:6174/reload
curl -X POST http://localhost:6174/inject
```

Inspect an active application run:

```bash
curl http://localhost:6174/inspect-apply
```

Plan a Greenhouse-only dry run without submitting:

```bash
curl -s -X POST http://localhost:6174/apply-run \
  -H 'Content-Type: application/json' \
  --data '{"dryRun":true,"atsAllow":["greenhouse"],"threshold":70,"targetConfirmed":1,"previewLimit":10}' | jq .
```

Start a bounded reviewed application run:

```bash
curl -s -X POST http://localhost:6174/apply-run \
  -H 'Content-Type: application/json' \
  --data '{"rescore":true,"threshold":75,"targetConfirmed":3,"attemptCap":10,"requireEvidence":true,"includeAssisted":false}' | jq .
```

Abort a stuck manual test queue:

```bash
curl -s -X POST http://localhost:6174/set-storage \
  -H 'Content-Type: application/json' \
  --data '{"pja_ext_queue":{"status":"aborted","jobs":[],"currentIndex":0,"results":{"applied":[],"skipped":[],"errors":[]}},"pja_ext_current":null,"pja_navigate_to":null}'
```

## Codex vs Claude mode

The dev server supports both engines:

- `claude`: default mode, uses the local `claude` CLI.
- `codex`: uses the local `codex` CLI.

Use Codex mode when the user wants all AI decisions to go through Codex:

```bash
npm run start:codex
```

Use Claude mode when the user wants all AI decisions to go through Claude:

```bash
npm start
```

Do not run both servers on port `6174` at the same time.

## Useful developer commands

```bash
npm test
curl http://localhost:6174/health
curl -X POST http://localhost:6174/reload
curl -X POST http://localhost:6174/inject
curl http://localhost:6174/inspect-apply
```

Common endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Shows server health, selected AI engine, and connected extension clients. |
| `/reload` | POST | Reloads the extension through the WebSocket bridge. |
| `/inject` | POST | Re-injects content scripts into existing supported tabs. |
| `/analyze` | POST | Scores one job. |
| `/batch-score` | POST | Scores a batch of jobs. |
| `/answer-questions` | POST | Generates factual answers for application questions. |
| `/source-v2` | POST | Builds/imports a sourced job corpus. |
| `/apply-run` | POST | Starts a ranked application run from the corpus. |
| `/inspect-apply` | GET | Returns sanitized active-run diagnostics. |
| `/get-storage` | POST | Reads selected extension storage keys for debugging. |
| `/set-storage` | POST | Writes selected extension storage keys for debugging. Body is flat. |

For `/set-storage`, send:

```json
{"pja_ext_queue":{"status":"aborted"}}
```

Do not send:

```json
{"data":{"pja_ext_queue":{"status":"aborted"}}}
```

## Testing before sharing

Always run:

```bash
npm test
git diff --check
```

Recommended browser smoke test:

1. Load the unpacked extension in a clean Chrome profile.
2. Start the dev server.
3. Confirm `/health` shows `clients:1`.
4. Fill Settings with synthetic or the new user's real local profile.
5. Upload a test resume.
6. Open LinkedIn or a local fixture page.
7. Scan jobs or seed a small test queue.
8. Verify every attempted job reaches a terminal bucket:
   - confirmed/applied
   - skipped/captcha
   - needs_manual
   - missing_required
   - no_apply_path
   - login_required
   - email_verification_required
   - failed with diagnostic reason
9. Do not count a job as successfully applied unless confirmation evidence exists.

Manual queue testing:

```bash
curl -s -X POST http://localhost:6174/launch-queue \
  -H 'Content-Type: application/json' \
  --data '{"startIndex":0}'
```

Real-site E2E testing should use a separate test Chrome profile and a resume/profile that the user is comfortable using for live applications.

## Privacy and sharing checklist

Before pushing or sharing:

```bash
npm test
git diff --check
git grep -n -i -E 'gmail.com|linkedin.com/in/[A-Za-z0-9-]+|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}|password|secret|api[_-]?key|one[- ]?time|security code'
```

Inspect matches manually. Some generic code strings are expected, but no real user data should be committed.

Do not commit:

- Real resumes.
- Profile exports.
- Passwords.
- API keys.
- Gmail contents.
- One-time/security codes.
- `*.local.*` files.
- Chrome profile data.

## Troubleshooting

`clients:0` from `/health`:

- Go to `chrome://extensions`.
- Confirm Developer mode is on.
- Click the reload icon for the extension.
- Refresh a supported job page.

AI calls fail:

- Confirm the selected CLI works in a normal terminal:
  - `claude --version`
  - `codex --version`
- Restart the dev server in the intended mode.

Extension does not fill a page:

- Confirm the page is a supported ATS or job page.
- Refresh the page after extension reload.
- Run:

  ```bash
  curl http://localhost:6174/inspect-apply
  ```

CAPTCHA appears:

- This is expected on some sites. The extension should record it instead of bypassing it.

Unknown form question appears:

- Add a factual answer in Settings/answer bank.
- If it is citizenship/export-control/work authorization, answer only if the user knows the exact legal fact.

## Repository notes

- `pja_` / `PJA` is an internal namespace and is not a person's name.
- Do not rename existing `pja_*` storage keys without a migration; installed users may already have data under those keys.
- `manifest_version: 3` means this is a Chrome Manifest V3 extension.
