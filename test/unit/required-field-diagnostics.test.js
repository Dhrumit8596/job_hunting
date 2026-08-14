'use strict';
// Required-field answer resolution should be profile/answer-bank driven, not
// user-data hardcoded in code. The UI should preserve enough metadata for the
// next fix/test pass when a field remains unresolved.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function loadAutofill() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  w.chrome = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: p => p },
  };
  w.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  w.eval(fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8'));
  return w;
}

module.exports = (t) => {
  const w = loadAutofill();

  const auth = w.pjaResolveRequiredAnswer(
    { label: 'Are you legally authorized to work in the United States?' },
    { profile: { workAuth: 'Yes' }, answers: {} }
  );
  t.eq(auth.answer, 'Yes', 'required resolver reads work authorization from profile');
  t.eq(auth.canonicalKey, 'workAuth.authorized', 'required resolver records work-auth canonical key');
  t.eq(auth.source, 'profile', 'required resolver reports profile-backed source');

  const citizenship = w.pjaResolveRequiredAnswer(
    { label: 'Country of citizenship' },
    { profile: { countryOfCitizenship: 'Canada' }, answers: {} }
  );
  t.eq(citizenship.answer, 'Canada', 'required resolver reads citizenship from profile');
  t.eq(citizenship.canonicalKey, 'workAuth.citizenship', 'required resolver distinguishes citizenship country from US-person status');
  t.ok(citizenship.sensitive, 'required resolver marks citizenship as sensitive');

  const bank = w.pjaResolveRequiredAnswer(
    { label: 'Custom screening answer' },
    { answers: { 'custom screening answer': { answer: 'Synthetic answer', confidence: 'high', canonicalKey: 'custom.synthetic' } } }
  );
  t.eq(bank.answer, 'Synthetic answer', 'required resolver prefers exact answer-bank matches');
  t.eq(bank.source, 'answer_bank', 'required resolver reports answer-bank source');

  const missing = w.pjaResolveRequiredAnswer(
    { label: 'Describe your experience with a proprietary internal tool' },
    { profile: {}, answers: {} }
  );
  t.eq(missing.answer, null, 'required resolver leaves unknown facts unresolved');
  t.eq(missing.source, 'unresolved', 'required resolver reports unresolved source');

  const eligibility = w.pjaResolveRequiredAnswer(
    { label: "What's your citizenship / employment eligibility?" },
    { profile: { workAuth: 'Yes' }, answers: {} }
  );
  t.eq(eligibility.answer, 'Yes', 'required resolver maps LinkedIn employment-eligibility wording to profile workAuth');
  t.eq(eligibility.canonicalKey, 'workAuth.authorized', 'employment-eligibility wording records canonical work-auth key');

  const start = w.pjaResolveRequiredAnswer(
    { label: 'Earliest start date? Required', el: { type: 'text', getAttribute: () => '', id: '', name: '' } },
    {
      prefs: { startDate: 'Available to start in ~2 weeks (effectively immediately).' },
      answers: { 'earliest start date required': { answer: '2026-07-01', confidence: 'high' } },
    }
  );
  t.ok(/^\d{2}\/\d{2}\/\d{4}$/.test(start.answer), 'required resolver formats explicit start-date questions as a date');
  t.ok(start.answer !== '2026-07-01', 'required resolver does not let stale answer-bank start dates override profile/prefs');
  t.eq(start.canonicalKey, 'preferences.startDate', 'start-date resolver records canonical preference key');

  const doc = w.document;
  doc.body.innerHTML = "<label for=\"elig\">What's your citizenship / employment eligibility?</label><select id=\"elig\" required><option value=\"\">Select</option><option value=\"auth\">I am authorized to work in the United States</option><option value=\"noauth\">I am not authorized</option></select>";
  const sel = doc.getElementById('elig');
  t.ok(w.pjaApplyResolvedRequiredAnswer(
    { label: "What's your citizenship / employment eligibility?", type: 'select', options: Array.from(sel.options).map(o => o.text) },
    sel,
    { profile: { workAuth: 'Yes' }, answers: {} }
  ), 'required resolver can fill a LinkedIn eligibility select without AI');
  t.eq(sel.value, 'auth', 'employment eligibility select chooses authorized option');

  const autofillSource = fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8');
  const resolverBody = autofillSource.slice(
    autofillSource.indexOf('function pjaResolveRequiredAnswer'),
    autofillSource.indexOf('// ── Garbage label detection')
  );
  t.ok(!resolverBody.includes('PJA_BUILTIN_ANSWERS'), 'required resolver does not use legacy built-in user answers');

  const externalSource = fs.readFileSync(path.resolve(ROOT, 'content/external-apply.js'), 'utf8');
  t.ok(externalSource.includes('pjaResolveRequiredAnswer(f, resolverContext)') &&
    externalSource.includes('canonicalKey: unresolved && unresolved.canonicalKey') &&
    externalSource.includes("phase: 'answerer_unresolved'") &&
    externalSource.includes('diagnostics'),
  'external apply records canonical metadata and diagnostics for unresolved required fields');

  const ashbyRepairBody = externalSource.slice(
    externalSource.indexOf('async function repairAshbyRequiredFields'),
    externalSource.indexOf('const groups = new Map();', externalSource.indexOf('async function repairAshbyRequiredFields'))
  );
  t.ok(ashbyRepairBody.includes('pjaResolveRequiredAnswer(field, context)') &&
    !ashbyRepairBody.includes("|| 'Yes'") &&
    !ashbyRepairBody.includes("|| 'No'") &&
    !ashbyRepairBody.includes("return 'Yes'") &&
    !ashbyRepairBody.includes("return 'No'"),
  'Ashby required-field repair uses resolver/profile/answer-bank values instead of local hardcoded factual answers');

  const backgroundSource = fs.readFileSync(path.resolve(ROOT, 'background.js'), 'utf8');
  t.ok(backgroundSource.includes("String(confidence || '').toLowerCase() !== 'high'") &&
    backgroundSource.includes('autoSaved: true') &&
    backgroundSource.includes('persistAnswers(result.answers, msg.payload && msg.payload.questions)'),
  'background answer persistence only auto-saves high-confidence answer/question pairs');

  const devServerSource = fs.readFileSync(path.resolve(ROOT, 'dev-server.js'), 'utf8');
  t.ok(devServerSource.includes('STRUCTURED FACTS (storage-backed; never override these with guesses)') &&
    devServerSource.includes('Canonical key: ${q.canonicalKey}') &&
    devServerSource.includes('Sensitive field: yes'),
  'dev-server answerer prompt receives storage-backed facts and canonical question metadata');
  t.ok(devServerSource.includes('function pickConfiguredAiEngine') &&
    devServerSource.includes("['profile', profile.aiEngine]") &&
    devServerSource.includes("getStorageFromExtension(['pja_profile', 'pja_prefs']") &&
    devServerSource.includes('engineSource: effective.source') &&
    devServerSource.includes('processEngine: `${PROCESS_AI_ENGINE}-cli`') &&
    devServerSource.includes("effectiveAiEngineCache.source !== 'process_default'") &&
    devServerSource.includes('transientStorageRead: true'),
  'dev-server uses profile/prefs AI engine preference ahead of the process default, preserves it across transient reload reads, and exposes engine diagnostics');
  t.ok(devServerSource.includes('OPERATIONAL_PROFILE_KEYS') &&
    devServerSource.includes("'aiEngine'") &&
    devServerSource.includes('!OPERATIONAL_PROFILE_KEYS.has(k)'),
  'dev-server excludes operational profile settings from candidate scoring fingerprints');

  const settingsSource = fs.readFileSync(path.resolve(ROOT, 'settings/settings.js'), 'utf8');
  const settingsHtml = fs.readFileSync(path.resolve(ROOT, 'settings/settings.html'), 'utf8');
  t.ok(settingsSource.includes('function missingQuestionCategory') &&
    settingsSource.includes('function profileKeyForCanonical') &&
    settingsSource.includes("status: 'approved'") &&
    settingsSource.includes("source: 'missing_info_ui'") &&
    settingsSource.includes("auditProfileSave(profile, profilePatch, decision.ok, decision.reason, 'settings:missing-info')") &&
    settingsSource.includes('pja_profile_backup') &&
    settingsSource.includes('pja_profile_last_good_at'),
  'settings missing-info UI groups unresolved fields and saves approved answers while profile writes keep audit/backup metadata');
  t.ok(settingsSource.includes("aiEngine: 'codex'") &&
    settingsSource.includes("'referralSource','aiEngine'") &&
    settingsHtml.includes('id="pf-aiEngine"') &&
    settingsHtml.includes('<option value="codex">Codex</option>') &&
    settingsHtml.includes('<option value="claude">Claude</option>'),
  'settings profile exposes a persisted AI engine tag');
};
