# Shareable Release Checklist

Use this checklist before giving the repository to another user or pushing a public/shared branch.

## Shareability requirements

- The repository contains no real profile data, resume files, passwords, API keys, Gmail content, one-time codes, or Chrome profile data.
- Runtime profile data is collected from the user's local Chrome extension Settings.
- Resume upload is user-provided and stored locally in Chrome storage.
- LinkedIn URL is user-provided.
- `pja_*` storage keys remain unchanged for compatibility with existing installs.
- Application Mode defaults ON for new installs, but can be turned off in Settings.
- Codex and Claude CLI modes are both documented.
- Chrome Developer Mode / Load unpacked flow is documented.
- Testing instructions include offline tests and real-site E2E caveats.

## Required local checks

```bash
npm install
npm test
git diff --check
```

Manual privacy scan:

```bash
git grep -n -i -E 'gmail.com|linkedin.com/in/[A-Za-z0-9-]+|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}|password|secret|api[_-]?key|one[- ]?time|security code'
```

Review every match. Generic source code references to email verification/security-code handling are allowed; real user data is not.

## Browser smoke test

1. Start the companion server.
2. Load the unpacked extension in Chrome.
3. Confirm:

   ```bash
   curl http://localhost:6174/health
   ```

   returns one connected extension client.

4. Fill Settings with a synthetic profile or the receiving user's real local profile.
5. Upload a test resume.
6. Scan or seed a small queue.
7. Confirm every attempted job reaches a terminal bucket:
   - confirmed/applied
   - skipped/captcha
   - needs_manual
   - missing_required
   - no_apply_path
   - login_required
   - email_verification_required
   - failed with diagnostic reason

Do not count a job as successfully applied unless confirmation evidence exists.

## Current external-service gates

These cannot be made deterministic by repository code alone:

- CAPTCHA / bot checks.
- LinkedIn or Indeed rate limits and daily caps.
- Employer-side account locks.
- Workday tenant-specific auth and password rules.
- Gmail account access/sign-in state.
- Some Greenhouse export-control/citizenship/permanent-residence questions, unless the user has explicitly supplied the required facts.
- Employer confirmation emails that arrive late or are filtered to Spam/Trash.

The extension should pause, skip, or record these conditions instead of bypassing or guessing.

## Recommended profile-builder additions for new users

Ask the new user to fill these before real application runs:

- Work authorization.
- Sponsorship requirement.
- Visa status, if any.
- Citizenship/nationality.
- Permanent-residence country, if any.
- Export-control / U.S.-person status, if known.
- LinkedIn profile URL.
- Resume.
- Current city/state/country.
- Willingness to relocate, commute, work onsite, and travel.
- Start date or notice period.
- Salary expectation.
- Referral source.
- Education dates, degree, major, and school.

If the user does not know a legal/export-control answer, leave it blank and treat those applications as manual review.

## Release procedure

1. Run all required local checks.
2. Inspect `git status --short`.
3. Confirm no generated local-only or personal files are staged.
4. Load the extension in a clean Chrome profile.
5. Run a small smoke test.
6. Commit with a clear message.
7. Push the branch.
