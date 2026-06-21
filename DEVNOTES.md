# Dev Workflow — the candidate Job Extension

## Dev server + hot-reload

The dev server (`dev-server.js`) runs an HTTP + WebSocket server on **port 6174**.

When `DEV_MODE = true` (background.js line 7), the extension:
- Connects a WebSocket to `ws://localhost:6174` on startup
- Pings every 20s to keep the MV3 service worker alive
- Listens for a `reload` message → calls `chrome.runtime.reload()` (full extension restart)

### One-time setup

```bash
# In a terminal, keep this running:
node dev-server.js
```

### After changing any file

```bash
curl -X POST http://localhost:6174/reload
# Then refresh any open job page tab — new content script loads automatically
```

### Verify the extension is connected before reloading

```bash
curl http://localhost:6174/health
# {"clients":1}   ← good to go
# {"clients":0}   ← extension not connected — check chrome://extensions/
#                   click the reload icon on "the candidate Job Assistant"
```

If `clients` is 0, go to `chrome://extensions/`, find "the candidate Job Assistant" (ID: `lpojofmpdljggmdmoamdggapnabfkham`), and click the circular reload arrow. The extension will reconnect and `clients` will become 1.

---

## Test pages

```
# Local test form (requires `node dev-server.js` running on port 8765 or use any static server):
http://localhost:8765/test/test-apply-form.html

# Or open directly in Chrome from the filesystem via chrome://extensions/ → service worker → console
```

---

## Dev server endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{"clients": N}` — N=1 means extension connected |
| `/reload` | POST | Broadcasts 'reload' to all WebSocket clients → triggers extension restart |
| `/inject` | POST | Tells background to re-inject content scripts into existing tabs |
| `/analyze` | POST | Scores a single job `{title, company, description}` → returns fitScore, skills, etc. |
| `/batch-score` | POST | Scores up to 10 jobs in one batch |
| `/outreach` | POST | Generates DM + email for a job + target person |
| `/launch-queue` | POST | Seeds `pja_ext_queue` from `test/test-jobs.json` and opens the first job tab. Body: `{"startIndex":0,"jobIds":["id1",...]}` (optional filters). |

---

## Extension architecture

```
background.js          ← service worker, all AI scoring, storage CRUD
content/
  extractors/          ← site-specific job data extractors (LinkedIn, Indeed, Glassdoor, generic)
  autofill.js          ← PJA_FIELD_RULES, pjaFillForm, pjaFillSelect, pjaClickRadio
  auto-apply.js        ← LinkedIn Easy Apply modal step-through
  external-apply.js    ← ATS form filler (Greenhouse, Lever, Workday, etc.)
  job-scraper.js       ← floating widget, LinkedIn scan + batch scoring
  content.js           ← sidebar shadow DOM, message router, profile widget
popup/                 ← Pipeline / Search / Contacts tabs
shortlist/             ← scanner results review page
settings/              ← profile, answer bank, templates, API key
```

## Storage keys (chrome.storage.local)

| Key | Purpose |
|-----|---------|
| `pja_profile` | User profile overrides |
| `pja_answers` | Answer bank (learned form answers) |
| `pja_jobs` | Job pipeline (Needs Info → … → Offer/Rejected) |
| `pja_shortlist` | Scanner results with fit scores |
| `pja_contacts` | Recruiter/HM tracker |
| `pja_templates` | DM + email templates |
| `pja_missing_questions` | Fields autofill couldn't fill |
| `pja_site_log` | Per-domain apply log |
| `pja_custom_domains` | User-added ATS domains |
| `ext_queue` | In-flight external apply context |

---

## Known bugs

See `BUGS.md` for 10 documented bugs. Critical ones:
- **BUG 1** (autofill.js:172): sponsorship noMatch conditions INVERTED — selects YES-sponsorship for No-sponsorship profile
- **BUG 3** (autofill.js:368): pjaClickRadio missing `input` event — React radios appear checked but submit empty
- **BUG 5** (background.js:801,893): BATCH_SCORE_JOBS always hits dev server, no DEV_MODE guard
- **BUG 6** (background.js:7): DEV_MODE hardcoded true — Gemini Nano permanently disabled
