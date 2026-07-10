(function() {
'use strict';
if (window.__pjaAutofillLoaded) return;
window.__pjaAutofillLoaded = true;

// ── Field classification rules ─────────────────────────────────────────────
// ORDER MATTERS: more-specific multi-word patterns must come before short
// single-word ones that are substrings of longer labels (e.g. 'title' in
// "job title" vs the salutation dropdown labeled just "Title").
// Salutation is last because its patterns ('mr','ms','dr','title') are common
// substrings that would otherwise shadow email, currentTitle, etc.
const PJA_FIELD_RULES = [
  { key: 'firstName',          patterns: ['first name','first_name','fname','given name','forename','legal first'] },
  { key: 'middleName',         patterns: ['middle name','middle_name','middle initial','legal middle'] },
  { key: 'lastName',           patterns: ['last name','last_name','lname','surname','family name','legal last'] },
  { key: 'fullName',           patterns: ['full name','your name','legal name','full legal name','applicant name','candidate name','name'] },
  { key: 'email',              patterns: ['email','e-mail','email address','work email'] },
  { key: 'phoneType',          patterns: ['phone type','contact phone type','type of phone','phone number type'] },
  { key: 'phone',              patterns: ['phone','mobile','cell','telephone','contact number','phone number'] },
  { key: 'linkedin',           patterns: ['linkedin','linkedin url','linkedin profile'] },
  { key: 'website',            patterns: ['website','portfolio','personal url','github url','personal site'] },
  { key: 'address',            patterns: ['address line 1','street address','address 1','address line','mailing address'] },
  { key: 'address2',           patterns: ['address line 2','address 2','apt','suite','unit','apartment','address2','floor'] },
  // currentLocation MUST come before city: 'location (city)' contains 'city' as a substring,
  // so if city is first it incorrectly maps to the bare 'city' rule instead of currentLocation.
  { key: 'currentLocation',    patterns: ['location (city','currently based','city and state','city, state','current location','where are you located','where are you based','your location','city/state'] },
  { key: 'city',               patterns: ['city','town'] },
  { key: 'state',              patterns: ['state','province'] },
  { key: 'zip',                patterns: ['zip','postal','postcode','zip code','postal code'] },
  { key: 'country',            patterns: ['country'] },
  // 'title' alone → job title in application context (salutation rule has no 'title' pattern now)
  { key: 'currentTitle',       patterns: ['current title','current position','job title','your title','position title','most recent title','title'] },
  { key: 'currentCompany',     patterns: ['current company','current employer','employer','company name','most recent employer','most recent company'] },
  { key: 'yearsExperience',    patterns: ['years of experience','years experience','how many years','years of relevant','années d\'expérience','combien d\'années','depuis combien d\'années','ans d\'expérience','années dans'] },
  { key: 'university',         patterns: ['university','college','school name','institution','school'] },
  { key: 'degree',             patterns: ['degree','highest degree','level of education','highest level of education'] },
  { key: 'major',              patterns: ['major','field of study','concentration','area of study','discipline','subject'] },
  { key: 'graduationYear',     patterns: ['graduation year','grad year','year of graduation'] },
  // Education date picker components (multi-part date fields in education section)
  // These have identical labels to work-history date fields; work-history dates are typically
  // optional so filling them with education defaults is acceptable.
  { key: 'educationEndMonth',  patterns: ['end date month','end month'] },
  { key: 'educationEndYear',   patterns: ['end date year','end year'] },
  { key: 'educationStartMonth',patterns: ['start date month','start month'] },
  { key: 'educationStartYear', patterns: ['start date year','start year'] },
  { key: 'salaryExpectation',  patterns: ['salary','compensation','expected salary','desired salary','salary expectation','pay expectation','hourly pay','hourly rate','pay rate','expected pay','desired pay','expected compensation','w2 rate','bill rate'] },
  { key: 'workAuth',           patterns: ['authorized to work','work authorization','eligible to work','right to work','legally authorized','work in the us','work in us'] },
  { key: 'requireSponsorship', patterns: ['sponsorship','require sponsorship','visa sponsorship','need sponsorship','require visa sponsorship','require work authorization','immigration case','sponsor'] },
  { key: 'visaStatus',         patterns: ['visa status','visa type','work visa','immigration status','citizenship','work authorization status'] },
  { key: 'usPersonExportControl', patterns: ['u.s. person','us person (i.e.','export control','itar','ear compliance','technology control'] },
  { key: 'willingToRelocate',  patterns: ['relocate','willing to relocate','relocation','open to relocation'] },
  { key: 'referralSource',     patterns: ['how did you hear','hear about us','how did you find','referral source','source','referred by','how were you referred'] },
  { key: 'gender',             patterns: ['gender','sex'] },
  { key: 'ethnicity',          patterns: ['ethnicity','race','hispanic'] },
  { key: 'veteran',            patterns: ['veteran','military service','protected veteran'] },
  { key: 'disability',         patterns: ['disability','disabled'] },
  // Salutation last: its patterns ('title','mr','ms','mrs') are short substrings
  // that shadow more specific rules above if checked first.
  // Also removed 'dr' — it matches "address" ("a**dr**ess") causing false positives.
  { key: 'salutation',         patterns: ['salutation','prefix','honorific','mr.','mrs.','ms.','mr ','mrs ','ms '] },
];

// ── Default profile (generic empty template) ───────────────────────────────
// The real profile lives in chrome.storage (pja_profile), set via the Settings page.
// These defaults are only fallbacks for an unconfigured install — kept generic/empty
// so no personal data ships in the repo. (Original values: config.local.js, gitignored.)
const PJA_DEFAULT_PROFILE = {
  currentLocation: '',
  salutation: '',
  firstName: '',
  middleName: '',
  lastName: '',
  fullName: '',
  email: '',
  phone: '',
  phoneType: 'Mobile',
  linkedin: '',
  website: '',
  address: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
  country: 'United States',
  currentTitle: '',
  currentCompany: '',
  yearsExperience: '',
  university: '',
  degree: '',
  major: '',
  graduationYear: '',
  educationEndYear: '',
  educationEndMonth: '',
  educationStartYear: '',
  educationStartMonth: '',
  salaryExpectation: '',
  workAuth: '',
  requireSponsorship: '',
  visaStatus: '',
  willingToRelocate: '',
  referralSource: '',
  gender: '',
  ethnicity: '',
  veteran: '',
  disability: '',
};

// ── Shadow-DOM-aware traversal ─────────────────────────────────────────────
// document.querySelectorAll doesn't pierce shadow roots. These helpers collect
// elements from all open shadow roots in the tree so autofill and learning
// work inside LinkedIn's Easy Apply modal (rendered in #interop-outlet's root).

function pjaGetAllRoots() {
  const roots = [document];
  const visit = root => {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) { roots.push(el.shadowRoot); visit(el.shadowRoot); }
    });
  };
  visit(document);
  return roots;
}

function pjaQueryAll(selector) {
  const out = [];
  for (const root of pjaGetAllRoots()) {
    out.push(...Array.from(root.querySelectorAll(selector)));
  }
  return out;
}

// ShadowRoot.getElementById exists in Chrome but not all roots expose it;
// fall back to a linear scan so complex URN-style IDs (LinkedIn) are found.
function pjaGetById(root, id) {
  if (root.getElementById) return root.getElementById(id);
  for (const el of root.querySelectorAll('[id]')) {
    if (el.id === id) return el;
  }
  return null;
}

// ── Application page detection ─────────────────────────────────────────────
function pjaIsApplicationPage() {
  const url = location.href.toLowerCase();
  return [
    'greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com',
    'jobvite.com', 'icims.com', 'taleo.net', 'bamboohr.com',
    'smartrecruiters.com', 'ashbyhq.com', 'applytojob.com', 'jazz.co',
    'recruitee.com', 'rippling.com', '/apply', '/application', '/job-application'
  ].some(p => url.includes(p));
}

// ── Extract label text for a form element ─────────────────────────────────
function pjaGetLabel(el) {
  // Use the element's own root (shadow root or document) for all lookups so
  // elements inside LinkedIn's Easy Apply shadow DOM find their labels.
  const root = el.getRootNode() || document;

  // Explicit <label for="id">
  if (el.id) {
    try {
      const lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim().toLowerCase();
    } catch (_) {}
  }
  // Wrapping label
  const parentLbl = el.closest('label');
  if (parentLbl) {
    const clone = parentLbl.cloneNode(true);
    clone.querySelectorAll('input,select,textarea').forEach(e => e.remove());
    const t = clone.textContent.trim().toLowerCase();
    if (t) return t;
  }
  // aria-label
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.toLowerCase();
  // aria-labelledby — IDs may be complex URNs (LinkedIn), use pjaGetById
  const lblBy = el.getAttribute('aria-labelledby');
  if (lblBy) {
    const parts = lblBy.split(' ')
      .map(id => pjaGetById(root, id)?.textContent.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' ').toLowerCase();
  }
  // LinkedIn fb-dash-form-element: walk up past __select-dropdown to the outer container
  // where the question text lives as a sibling div with no class.
  let fbEl = el.parentElement;
  while (fbEl) {
    const cls = (fbEl.className || '').toString();
    if (/\bfb-dash-form-element\b/.test(cls) && !/select-dropdown|text-field|number-field|date-field/.test(cls)) {
      const questionSibling = Array.from(fbEl.children).find(c => !c.contains(el) && c.textContent.trim());
      if (questionSibling) return questionSibling.textContent.trim().toLowerCase();
      break;
    }
    fbEl = fbEl.parentElement;
  }
  // Lever: .application-label is a sibling of .application-field (div or li container)
  const leverContainer = el.closest('[class*="application"]');
  if (leverContainer) {
    // Look in parent for a sibling label div
    const parentEl = leverContainer.parentElement;
    if (parentEl) {
      const lbl = parentEl.querySelector('[class*="application-label"]');
      if (lbl && !lbl.contains(el)) return lbl.querySelector('.text, div')?.textContent.trim().toLowerCase() || lbl.textContent.trim().toLowerCase();
    }
    const lbl = leverContainer.querySelector('[class*="application-label"]');
    if (lbl && !lbl.contains(el)) return lbl.textContent.trim().toLowerCase();
  }
  // Nearest label-like ancestor content; also check previous sibling (Lever div.application-label pattern)
  const parent = el.closest('[class*="field"],[class*="Field"],[class*="form-group"],fieldset,li');
  if (parent) {
    const lbl = parent.querySelector('label,legend,[class*="label"],[class*="Label"]');
    if (lbl && !lbl.contains(el)) return lbl.textContent.trim().toLowerCase();
    // Previous sibling label (Lever: div.application-label precedes div.application-field)
    const prevSib = parent.previousElementSibling;
    if (prevSib && /label/i.test(prevSib.className || '')) {
      const t = prevSib.textContent.trim().toLowerCase();
      if (t) return t;
    }
  }
  return (el.placeholder || el.name || el.id || '').toLowerCase().replace(/[_-]/g, ' ');
}

// ── Classify label text to a profile key ──────────────────────────────────
function pjaClassify(label) {
  // Interrogative questions ("Have you signed a non-compete with your current employer?")
  // contain profile key phrases only incidentally — don't map them to profile keys that
  // hold name/company/contact values, as those values are wrong answers for yes/no questions.
  const isInterrogative = /^(have|did|were|do|does|are|is|will|can|would|could|should)\s+you\b.{10,}/i.test(label);
  const CONTENT_KEYS = new Set(['currentCompany','currentTitle','university','firstName','lastName','fullName','email','phone','city','state','country','address','zip']);

  for (const rule of PJA_FIELD_RULES) {
    if (isInterrogative && CONTENT_KEYS.has(rule.key)) continue;
    for (const pat of rule.patterns) {
      if (pat.length <= 5) {
        // Short patterns require word boundary: prevents 'unit' matching 'united', 'apt' matching 'aptitude', etc.
        if (new RegExp('\\b' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(label)) return rule.key;
      } else if (label.includes(pat)) {
        return rule.key;
      }
    }
  }
  return null;
}

// ── React/Vue-compatible value setter ─────────────────────────────────────
function pjaSetNative(el, value, skipBlur = false) {
  try {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  } catch (_) {
    el.value = value;
  }
  // Use InputEvent for 'input' so React/autocomplete components see insertText intent
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
  } catch (_) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // skipBlur: phone/tel fields - blur triggers React onBlur validation that may clear the value
  if (!skipBlur) el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

// Call React's onChange prop directly via fiber tree — bypasses the native event system.
// Uses a CustomEvent bridge to fiber-main.js (MAIN world content script in manifest.json)
// to avoid CSP restrictions that block inline script-tag injection.
function pjaFillViaFiberOnChange(el, value) {
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
  if (!fiberKey) return false;

  const uid = 'pja_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  el.setAttribute('data-pja-fiber-id', uid);
  el.removeAttribute('data-pja-fiber-done');

  // dispatchEvent is synchronous: fiber-main.js handler runs within this call
  try {
    document.dispatchEvent(new CustomEvent('pja:fiberfill', {
      detail: { uid, value: String(value) }
    }));
  } catch(_) {
    el.removeAttribute('data-pja-fiber-id');
    return false;
  }

  // fiber-main.js sets data-pja-fiber-done="ok" on success
  const ok = el.getAttribute('data-pja-fiber-done') === 'ok';
  el.removeAttribute('data-pja-fiber-done');
  if (!ok) el.removeAttribute('data-pja-fiber-id');
  return ok;
}

// Sets value on a text/tel input and notifies React state.
// NOTE: execCommand('insertText') is NOT used here — from an isolated-world content
// script it returns true but doesn't insert text (no real browser focus). Instead:
// Primary: CustomEvent fiber bridge to fiber-main.js (MAIN world) via pja:fiberfill.
// Fallback: native prototype setter + synthetic InputEvent/change/blur events.
function pjaFillTextViaFiber(el, value, skipBlur = false) {
  el.focus();

  // Set value via native prototype setter (bypasses React's input tracking so we
  // must also fire events, but ensures the DOM value is correct regardless of fiber)
  try {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value); else el.value = value;
  } catch(_) { el.value = value; }

  // Try fiber bridge (pja:fiberfill CustomEvent → fiber-main.js in MAIN world)
  // This calls Formik's onChange directly, keeping controlled-input state in sync.
  const fiberOk = pjaFillViaFiberOnChange(el, value);
  if (fiberOk && skipBlur) return true;

  // Synthetic events — ITI phone fields and non-Formik inputs respond to these
  try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' })); } catch(_) {}
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (!skipBlur) el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  return true;
}

// US state name ↔ abbreviation (module-level so both pjaFillSelect and pjaFillCombobox use it).
const PJA_STATE_ABBR = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
  'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
  'west virginia':'WV','wisconsin':'WI','wyoming':'WY','district of columbia':'DC'
};

// Normalize an <option> value for matching: some ATSes (e.g. Jobvite/AngularJS) prefix
// values like "string:CA" — strip a leading "string:" so abbreviations still match.
function pjaOptVal(opt) {
  return opt.value.toLowerCase().replace(/^string:/, '').trim();
}

function pjaFillSelect(select, value, key) {
  const lv = value.toString().toLowerCase().trim();
  // Exact match on value attr (with string: prefix tolerance) or display text
  for (const opt of select.options) {
    if (pjaOptVal(opt) === lv || opt.value.toLowerCase() === lv || opt.text.toLowerCase().trim() === lv) {
      return pjaCommitSelect(select, opt.value);
    }
  }
  // State: convert between abbreviation and full name (profile holds "CA"; dropdowns
  // often list "California" with value "string:CA"). Try both directions.
  if (key === 'state' || /\bstate\b|province/i.test(key || '')) {
    let targets = [];
    if (lv.length === 2) {
      const full = Object.entries(PJA_STATE_ABBR).find(([, ab]) => ab === lv.toUpperCase())?.[0];
      if (full) targets = [full, lv]; // full name + abbr
    } else if (PJA_STATE_ABBR[lv]) {
      targets = [lv, PJA_STATE_ABBR[lv].toLowerCase()]; // full name + abbr
    }
    for (const opt of select.options) {
      const ot = opt.text.toLowerCase().trim();
      const ov = pjaOptVal(opt);
      if (targets.some(t => ot === t || ov === t)) return pjaCommitSelect(select, opt.value);
    }
  }
  const isYes = ['yes', 'true', '1'].includes(lv);
  const isNo  = ['no', 'false', '0'].includes(lv);
  for (const opt of select.options) {
    const ot = opt.text.toLowerCase().trim();
    if (!ot || ['select','please select','choose','--'].includes(ot)) continue;
    // BUG1 fix: sponsorship is semantically INVERTED vs work-authorization — an option that
    // says it REQUIRES/needs sponsorship means "Yes-requires"; "will not / do not require"
    // means "No". Handle the requireSponsorship key on its own so the sponsorship option text
    // can never leak into the generic work-auth yes-branch (which previously let a work-auth
    // 'Yes' select "I will require sponsorship"). The generic branch below no longer mentions
    // sponsorship at all.
    if (key === 'requireSponsorship') {
      const saysRequire   = /\b(require|requires|need|needs)\b/.test(ot) && !/\bnot\b|\bno\b|won.?t|will not|do(es)? not|don.?t/.test(ot);
      const saysNoSponsor = /\bnot (require|need)|will not|do(es)? not require|don.?t require|no sponsorship|not (require|need) sponsorship\b/.test(ot)
                            || ot === 'no' || ot.startsWith('no,');
      if (isYes && (ot === 'yes' || ot.startsWith('yes,') || saysRequire))   return pjaCommitSelect(select, opt.value);
      if (isNo  && (ot === 'no'  || ot.startsWith('no,')  || saysNoSponsor)) return pjaCommitSelect(select, opt.value);
      continue;
    }
    // BUG7 fix: key-aware 'not authorized' guard.
    // BUG4 fix: lv.length > 3 prevents 'no'/'yes' from substring-matching everything.
    const yesMatch = isYes && (
      ot === 'yes' || ot.startsWith('yes,') ||
      (ot.includes('authorized') && !ot.includes('not authorized')) ||
      ot.includes('eligible') || ot.includes('i am authorized')
    );
    const noMatch = isNo && (
      ot === 'no' || ot.startsWith('no,') ||
      ot.includes('not required') || ot.includes('will not require') ||
      (key === 'workAuth' && ot.includes('not authorized'))
    );
    const partial = lv.length > 3 && (ot.includes(lv) || (lv.length > 4 && lv.includes(ot.slice(0, 5))));
    if (yesMatch || noMatch || partial) return pjaCommitSelect(select, opt.value);
  }
  // Numeric salary/rate: pick the range option whose low end is nearest but ≤ the value
  if (key === 'salaryExpectation') {
    const num = parseFloat(lv);
    if (!isNaN(num)) {
      let best = null, bestLow = -Infinity;
      for (const opt of select.options) {
        const ot = opt.text;
        const nums = ot.match(/[\d,]+(?:\.\d+)?/g)?.map(n => parseFloat(n.replace(/,/g, ''))) || [];
        if (!nums.length) continue;
        const low = Math.min(...nums), high = Math.max(...nums);
        if (num >= low && num <= high) return pjaCommitSelect(select, opt.value);
        if (low <= num && low > bestLow) { bestLow = low; best = opt; }
      }
      if (best) return pjaCommitSelect(select, best.value);
    }
  }
  // EEO semantic fallback for veteran / disability / gender
  if (key && ['veteran','disability','gender','ethnicity'].includes(key)) {
    return pjaFillSelectEEO(select, lv, key);
  }
  return false;
}

function pjaCommitSelect(select, val) {
  try {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (desc?.set) desc.set.call(select, val); else select.value = val;
  } catch (_) { select.value = val; }
  select.dispatchEvent(new Event('input',  { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Semantic matching for EEO dropdowns whose option text varies between ATS platforms
function pjaFillSelectEEO(select, lv, key) {
  const skip = new Set(['select','please select','choose','--','']);

  const score = (opt, positiveTests, negativeTests = []) => {
    const ot = opt.text.toLowerCase().trim();
    if (skip.has(ot)) return -1;
    const pos = positiveTests.reduce((s, t) => s + (t.test(ot) ? 1 : 0), 0);
    const neg = negativeTests.reduce((s, t) => s + (t.test(ot) ? 1 : 0), 0);
    return pos - neg * 2;
  };

  let best = null, bestScore = 0;

  if (key === 'veteran') {
    const isNotVet = /\bnot\b.*veteran|\bi am not\b|not a.*veteran|non.veteran/i.test(lv);
    const isVet    = !isNotVet && /veteran/i.test(lv);
    for (const opt of select.options) {
      const s = isNotVet
        ? score(opt, [/\bnot\b/, /veteran/], [/\bdisabled\b/])
        : isVet
          ? score(opt, [/veteran/], [/\bnot\b/])
          : score(opt, [/decline|identify|prefer|wish/]);
      if (s > bestScore) { bestScore = s; best = opt; }
    }
  }

  if (key === 'disability') {
    const isNo  = /^no[,\s]|don.t have|do not have|no disability|without a disab/i.test(lv);
    const isYes = !isNo && /^yes[,\s]|i have a dis|have a disability/i.test(lv);
    for (const opt of select.options) {
      const s = isNo
        ? score(opt, [/^no[,\s]/, /disab/], [/^yes/])
        : isYes
          ? score(opt, [/^yes[,\s]/, /disab/], [/^no/])
          : score(opt, [/decline|prefer|wish/]);
      if (s > bestScore) { bestScore = s; best = opt; }
    }
  }

  if (key === 'gender') {
    const isFemale  = /\b(female|woman|she\/her)\b/i.test(lv);
    const isMale    = !isFemale && /\b(male|man|he\/him)\b/i.test(lv);
    const isNonBin  = /non.bin|enby|they\/them/i.test(lv);
    for (const opt of select.options) {
      const s = isFemale  ? score(opt, [/\bfemale\b|\bwoman\b/], [/male.*female|non/])
              : isMale    ? score(opt, [/\bmale\b|\bman\b/],     [/female/])
              : isNonBin  ? score(opt, [/non.bin/])
              : score(opt, [/decline|prefer|not|other/]);
      if (s > bestScore) { bestScore = s; best = opt; }
    }
  }

  if (!best) return false;
  return pjaCommitSelect(select, best.value);
}

// ── Label normalization & fuzzy matching ───────────────────────────────────
function pjaNormalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]*]/g, '')   // strip * so "older?*" → "older" not "older*"
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function pjaFuzzyScore(a, b) {
  const words = s => new Set(s.split(/\s+/).filter(w => w.length >= 4));
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  if (!overlap) return 0;
  const precision = overlap / wb.size;
  const recall = overlap / wa.size;
  return 2 * precision * recall / (precision + recall);
}

// Built-in answer bank for common yes/no questions — merged with stored answers at lookup time.
// Keys must be pjaNormalizeLabel()-normalized (lowercase, no punctuation).
const PJA_BUILTIN_ANSWERS = {
  'have you signed a non-compete with your current employer':    { answer: 'No' },
  'have you signed a non-compete agreement':                     { answer: 'No' },
  'have you signed a non-compete':                               { answer: 'No' },
  'do you have a non-compete agreement':                         { answer: 'No' },
  'are you subject to a non-compete':                            { answer: 'No' },
  'have you ever been convicted of a felony':                    { answer: 'No' },
  'have you been convicted of a crime':                          { answer: 'No' },
  'are you able to perform the essential functions of this job': { answer: 'Yes' },
  'do you have reliable transportation':                         { answer: 'Yes' },
  'are you 18 years of age or older':                            { answer: 'Yes' },
  'are you at least 18 years old':                               { answer: 'Yes' },
  'are you over 18':                                             { answer: 'Yes' },
  // Background / drug screening
  'do you consent to a background check':                        { answer: 'Yes' },
  'do you agree to a background check':                          { answer: 'Yes' },
  'do you consent to drug testing':                              { answer: 'Yes' },
  'do you agree to drug testing':                                { answer: 'Yes' },
  'do you consent to a drug test':                               { answer: 'Yes' },
  // Work authorization / sponsorship (backup for profile fields)
  'are you authorized to work in the united states':             { answer: 'Yes' },
  'are you currently authorized to work in the united states':   { answer: 'Yes' },
  'are you eligible to work in the united states':               { answer: 'Yes' },
  'will you now or in the future require sponsorship':           { answer: 'No' },
  'do you require visa sponsorship':                             { answer: 'No' },
  // Company-specific "have you worked here before"
  'have you previously worked at this company':                  { answer: 'No' },
  'have you previously been employed here':                      { answer: 'No' },
  // Safety / compliance comfort / onsite
  'are you comfortable working onsite':                          { answer: 'Yes' },
  'are you comfortable working in an office':                    { answer: 'Yes' },
  'are you comfortable working in a cleanroom':                  { answer: 'Yes' },
  'are you comfortable with shift work':                         { answer: 'Yes' },
  'are you willing to work onsite':                              { answer: 'Yes' },
  'are you willing and able to work onsite':                     { answer: 'Yes' },
  'are you able to work onsite':                                 { answer: 'Yes' },
  'can you work onsite':                                         { answer: 'Yes' },
  'will you be able to work onsite':                             { answer: 'Yes' },
  'are you open to working onsite':                              { answer: 'Yes' },
  'this position requires working onsite are you able to':       { answer: 'Yes' },
  // Travel
  'are you willing to travel':                                   { answer: 'Yes' },
  'are you able to travel':                                      { answer: 'Yes' },
  'will you be able to travel':                                  { answer: 'Yes' },
  'will you be able to travel domestically and internationally': { answer: 'Yes' },
  'are you able to travel domestically and internationally':     { answer: 'Yes' },
  'this position requires travel are you able to':               { answer: 'Yes' },
  // SMS / text consent
  'do you consent to receive sms':                               { answer: 'Yes' },
  'do you agree to receive text messages':                       { answer: 'Yes' },
  'may we contact you via sms':                                  { answer: 'Yes' },
  // Relatives / conflict of interest
  'do you have any relatives employed at this company':          { answer: 'No' },
  'do you have any family members employed here':                { answer: 'No' },
  'do you have any relatives currently employed':                { answer: 'No' },
  // Contract / employment obligations
  'do you have a contract that would prevent you from working':  { answer: 'No' },
  'do you have a term contract or years contract':               { answer: 'No' },
  'do you have any contractual obligation':                      { answer: 'No' },
  'are you bound by any employment contract':                    { answer: 'No' },
  // ITAR / export control
  'itar compliance':                                             { answer: 'Yes, I am compliant with ITAR requirements' },
  'are you itar compliant':                                      { answer: 'Yes' },
  'do you have itar clearance':                                  { answer: 'Yes, I can comply with ITAR requirements' },
  // Referral source
  'how did you hear about this position':                        { answer: 'LinkedIn' },
  'how did you hear about us':                                   { answer: 'LinkedIn' },
  'how did you find this job':                                   { answer: 'LinkedIn' },
  'referral source':                                             { answer: 'LinkedIn' },
  'where did you hear about this job':                           { answer: 'LinkedIn' },
  // Salary / compensation
  'desired salary':                                             { answer: '80000' },
  'expected salary':                                            { answer: '80000' },
  'salary expectation':                                         { answer: '80000' },
  'minimum salary':                                             { answer: '75000' },
  'what are your salary expectations':                          { answer: '$80,000 - $95,000 depending on role and responsibilities' },
  // Employment type
  'are you applying for full time or part time':                { answer: 'Full-time' },
  'preferred employment type':                                  { answer: 'Full-time' },
  'are you available full time':                                { answer: 'Yes' },
  'are you willing to work full time':                          { answer: 'Yes' },
  // Start date
  'when can you start':                                         { answer: '2 weeks notice required' },
  'earliest start date':                                        { answer: 'Available with 2 weeks notice' },
  'available start date':                                       { answer: 'Available with 2 weeks notice' },
};

function pjaFindBestAnswer(normalizedLabel, answers) {
  if (!normalizedLabel) return null;
  const merged = Object.assign({}, PJA_BUILTIN_ANSWERS, answers || {});
  let best = null, bestScore = 0.35;
  for (const [key, entry] of Object.entries(merged)) {
    const score = pjaFuzzyScore(normalizedLabel, key);
    if (score > bestScore) { bestScore = score; best = entry.answer; }
  }
  return best;
}

// ── Garbage label detection ────────────────────────────────────────────────
// Labels that are too generic or are ATS field IDs — not worth storing
function pjaIsGarbageLabel(label) {
  if (!label || label.length < 3) return true;
  // ATS field IDs like "questions-22586-field", "field_12345", "q_abc123"
  if (/^(questions?|field|input|q)[\-_]\w+/i.test(label)) return true;
  // Pure numeric or hash-like IDs
  if (/^\d+$/.test(label) || /^[a-f0-9\-]{10,}$/i.test(label)) return true;
  // Overly generic labels that match everything and poison the bank
  const generic = new Set(['text question','text','field','input','question','answer','value','other','enter','type here','n/a']);
  if (generic.has(label.trim())) return true;
  return false;
}

// ── Learn mode ─────────────────────────────────────────────────────────────
// Listeners are attached to every shadow root (not just document) because
// composed events are retargeted at shadow boundaries — e.target at document
// level would be the shadow host, not the actual input.
const _pjaLearnHandlers = { handle: null, roots: [], observer: null };

function pjaStartLearning(onClassified, onUnclassified) {
  pjaStopLearning();

  const handle = e => {
    const el = e.target;
    if (!el) return;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
    const t = (el.type || '').toLowerCase();
    if (['hidden','submit','button','file','reset','image','checkbox'].includes(t)) return;
    if (t === 'radio' && !el.checked) return;

    const isRadio = t === 'radio';
    const rawLabel = isRadio ? pjaGetGroupLabel(el) : pjaGetLabel(el);
    if (pjaIsGarbageLabel(rawLabel)) return;

    const key = pjaClassify(rawLabel);
    const value = isRadio
      ? (pjaGetLabel(el) || el.value || '').trim()
      : (el.value || '').trim();
    if (!value || value.length < 2) return;

    if (key) {
      onClassified(key, value);
    } else if (rawLabel && rawLabel.length > 3) {
      const norm = pjaNormalizeLabel(rawLabel);
      if (norm && !pjaIsGarbageLabel(norm)) onUnclassified(norm, value, rawLabel);
    }
  };

  _pjaLearnHandlers.handle = handle;
  _pjaLearnHandlers.roots  = [];

  const attachToRoot = root => {
    if (_pjaLearnHandlers.roots.includes(root)) return;
    root.addEventListener('change', handle, true);
    root.addEventListener('blur',   handle, true);
    _pjaLearnHandlers.roots.push(root);
  };

  pjaGetAllRoots().forEach(attachToRoot);

  // Watch for shadow roots that appear later (e.g. LinkedIn's modal on click)
  const observer = new MutationObserver(() => pjaGetAllRoots().forEach(attachToRoot));
  observer.observe(document.documentElement, { subtree: true, childList: true });
  _pjaLearnHandlers.observer = observer;
}

function pjaStopLearning() {
  const { handle, roots, observer } = _pjaLearnHandlers;
  if (!handle) return;
  for (const root of roots) {
    root.removeEventListener('change', handle, true);
    root.removeEventListener('blur',   handle, true);
  }
  if (observer) observer.disconnect();
  _pjaLearnHandlers.handle   = null;
  _pjaLearnHandlers.roots    = [];
  _pjaLearnHandlers.observer = null;
}

// ── Radio button helpers ───────────────────────────────────────────────────

// Get the question/group label for a radio input (not the option label)
function pjaGetGroupLabel(radio) {
  const root = radio.getRootNode() || document;
  const lblBy = radio.getAttribute('aria-labelledby');
  if (lblBy) {
    const t = lblBy.split(' ')
      .map(id => pjaGetById(root, id)?.textContent.trim())
      .filter(Boolean).join(' ');
    if (t) return t.toLowerCase();
  }
  const fieldset = radio.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) return legend.textContent.trim().toLowerCase();
  }
  const parent = radio.closest(
    '[class*="field"],[class*="Field"],[class*="question"],[class*="Question"],[class*="form-group"],[role="group"]'
  );
  if (parent) {
    const lbl = parent.querySelector('legend,label:not([for]),[class*="label"],[class*="Label"],[class*="question-text"],[class*="prompt"],h3,h4,p');
    if (lbl && !lbl.contains(radio)) return lbl.textContent.trim().toLowerCase();
  }
  return (radio.name || '').toLowerCase().replace(/[_\-\.]/g, ' ');
}

function pjaClickRadio(radio) {
  // BUG3 fix: use native setter so React fiber state is updated, then dispatch
  // input (React's primary event) before change + click.
  const nativeCheckedDesc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
  if (nativeCheckedDesc?.set) nativeCheckedDesc.set.call(radio, true);
  else radio.checked = true;
  radio.dispatchEvent(new Event('input',  { bubbles: true }));
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}

// Option text for a checkbox/radio: wrapping <label>, then label[for=id], then a sibling label,
// then the value attr. (Greenhouse uses label[for]; the value attr is often a numeric id.)
function pjaCheckboxOptionText(cb) {
  let t = (cb.closest && cb.closest('label') ? cb.closest('label').textContent : '') || '';
  if (!t.trim() && cb.id) { const root = (cb.getRootNode && cb.getRootNode()) || document; const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(cb.id) : cb.id.replace(/["\\]/g, '\\$&'); const fl = root.querySelector(`label[for="${esc}"]`); if (fl) t = fl.textContent; }
  if (!t.trim()) { const s = cb.nextElementSibling; if (s && s.tagName === 'LABEL') t = s.textContent; }
  if (!t.trim()) t = cb.value || '';
  return t.replace(/\s+/g, ' ').trim();
}

// Find required checkbox-GROUP questions (Greenhouse renders some single/multi-select questions
// as a group of checkboxes sharing a name base, e.g. question_999[]_a..d). These have no
// [required] on a single control the missing-field scan recognizes as a group, and are excluded
// by [type=checkbox] filters, so they silently block submit. Returns unanswered required groups.
function pjaFindRequiredCheckboxGroups(root) {
  root = root || document;
  const groups = {}; const order = [];
  for (const cb of root.querySelectorAll('input[type=checkbox]')) {
    if (root === document && !cb.offsetParent && cb.getBoundingClientRect().width === 0) continue;
    const name = cb.name || cb.id || '';
    const base = name.replace(/\[\]_.*$/, '').replace(/_\d+$/, '').replace(/\[\]$/, '');
    if (!base) continue;
    if (!groups[base]) { groups[base] = { base, members: [], required: false, anyChecked: false }; order.push(base); }
    const g = groups[base];
    g.members.push(cb);
    if (cb.required || cb.getAttribute('aria-required') === 'true') g.required = true;
    if (cb.checked) g.anyChecked = true;
  }
  const out = [];
  for (const base of order) {
    const g = groups[base];
    if (!g.required || g.anyChecked || g.members.length < 2) continue; // single required cb = a consent box
    const block = g.members[0].closest('.application--questions, .field, [class*="field"], [class*="question"], fieldset');
    let question = '';
    if (block) {
      const al = block.querySelector('.application-label, legend');
      if (al && !al.querySelector('input')) question = al.textContent.replace(/\s+/g, ' ').trim();
      if (!question) for (const lb of block.querySelectorAll('label')) { if (!lb.querySelector('input')) { question = lb.textContent.replace(/\s+/g, ' ').trim(); break; } }
    }
    out.push({ base, question, required: true, anyChecked: false, members: g.members, options: g.members.map(pjaCheckboxOptionText) });
  }
  return out;
}

// Check the checkbox in a group whose label/value matches `answer` (single-select semantics:
// unchecks siblings). Dispatches input+change+click so React/Greenhouse state updates.
function pjaCheckMatchingBox(members, answer) {
  const lv = String(answer || '').toLowerCase().trim();
  if (!lv || !members || !members.length) return false;
  const optText = cb => pjaCheckboxOptionText(cb).toLowerCase();
  let target = members.find(cb => (cb.value || '').toLowerCase().trim() === lv)
            || members.find(cb => optText(cb) === lv)
            || members.find(cb => { const o = optText(cb); return o && (o.includes(lv) || lv.includes(o)); });
  if (!target) return false;
  // React updates checkbox state from the CLICK event, not from a native checked-setter
  // (a programmatic .checked = true leaves React's internal state stale, so Greenhouse still
  // sees it unchecked on submit). Click to toggle into the desired state instead.
  for (const cb of members) { if (cb !== target && cb.checked) cb.click(); } // single-select: clear others
  if (!target.checked) target.click();
  return true;
}

// Pick the radio in the group whose label/value best matches the stored profile value
function pjaSelectRadio(radios, value, key) {
  const lv = value.toLowerCase().trim();

  // Build labeled list: prefer the per-option label, fall back to value attr
  const labeled = radios.map(r => ({
    radio: r,
    label: (pjaGetLabel(r) || r.value || '').toLowerCase().trim()
  }));

  // 1. Exact match
  for (const { radio, label } of labeled) {
    if (radio.value.toLowerCase() === lv || label === lv) return pjaClickRadio(radio);
  }

  // 2. EEO semantic matching
  if (key === 'veteran') {
    const isNotVet = /\bnot\b.*veteran|\bi am not\b|not a.*veteran/i.test(lv);
    const target = labeled.find(({ label: l }) =>
      isNotVet
        ? /\bnot\b/.test(l) && /veteran/.test(l)
        : /veteran/.test(l) && !/\bnot\b/.test(l)
    ) || labeled.find(({ label: l }) => /decline|prefer|identify/.test(l));
    if (target) return pjaClickRadio(target.radio);
  }

  if (key === 'disability') {
    const isNo  = /^no[,\s]|don.t have|do not have|no disab/i.test(lv);
    const isYes = !isNo && /^yes[,\s]|have a disab/i.test(lv);
    const target = labeled.find(({ label: l }) =>
      isNo  ? (/^no/.test(l) || /without|don.t have/.test(l)) :
      isYes ? /^yes/.test(l) :
              /decline|prefer|wish/.test(l)
    );
    if (target) return pjaClickRadio(target.radio);
  }

  if (key === 'gender') {
    const isFemale = /\b(female|woman)\b/i.test(lv);
    const isMale   = !isFemale && /\b(male|man)\b/i.test(lv);
    const target = labeled.find(({ label: l }) =>
      isFemale ? /\b(female|woman)\b/.test(l) :
      isMale   ? (/\b(male|man)\b/.test(l) && !/female/.test(l)) :
                 /decline|prefer|not/i.test(l)
    );
    if (target) return pjaClickRadio(target.radio);
  }

  // 3. Partial substring fallback
  for (const { radio, label } of labeled) {
    if (label && (lv.includes(label) || label.includes(lv.slice(0, 10)))) {
      return pjaClickRadio(radio);
    }
  }

  return false;
}

// ── Format validators for fields where a corrupt profile value is worse than blank ──
const PJA_FIELD_VALIDATORS = {
  email:    v => v.includes('@'),
  linkedin: v => /linkedin\.com|^https?:\/\//i.test(v),
  website:  v => /^https?:\/\//i.test(v),
};

// ── React fiber-based select fill (Greenhouse react-select dropdowns) ────────
// react-select doesn't open reliably via DOM events; walk the fiber tree to find
// the outer Select's onChange handler and call it with the chosen option.
//
// ISOLATION NOTE: content scripts run in the ISOLATED world; React fiber closures
// (mp.onChange) live in the MAIN world.  A direct call from isolated world to a
// main-world function silently fails.  We therefore use the pja:reactselect
// CustomEvent bridge (handled by fiber-main.js in MAIN world) and only fall back
// to a direct call when the bridge is unavailable (e.g. fiber-main.js not yet injected).
function pjaFillViaReactFiber(input, value, key) {
  // The React fiber + onChange closure live in the MAIN world; a content script (ISOLATED
  // world) CANNOT see input's __reactFiber expando, so we must NOT walk the fiber here — doing
  // so silently returned false and this whole path was dead. Instead hand the raw value to the
  // MAIN-world bridge (fiber-main.js `pja:reactselect`), which walks the fiber, matches the
  // option (see pickOpt there), and calls onChange. dispatchEvent is synchronous, so
  // data-pja-fiber-done is set within this call when fiber-main.js is loaded.
  const uid = 'pja_rs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  input.setAttribute('data-pja-fiber-id', uid);
  input.removeAttribute('data-pja-fiber-done');
  document.dispatchEvent(new CustomEvent('pja:reactselect', {
    detail: { uid, optionLabel: String(value || ''), optionValue: String(value || ''), key: String(key || '') }
  }));
  const ok = input.getAttribute('data-pja-fiber-done') === 'ok';
  {
    const diag = input.getAttribute('data-pja-fiber-diag');
    // Log the walk for the country field, any question_* custom react-select, and any failure.
    if (diag && (!ok || /country|question/i.test(input.id || input.name || ''))) {
      try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[rsdiag] '+String(input.id||input.name||'?').slice(0,20)+' ok='+ok+' val="'+String(value).slice(0,10)+'" '+diag); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
    }
  }
  input.removeAttribute('data-pja-fiber-done');
  input.removeAttribute('data-pja-fiber-diag');
  input.removeAttribute('data-pja-fiber-id');
  return ok;
}

// ── Greenhouse Education section filler ────────────────────────────────────
// Greenhouse renders School/Degree/Discipline as react-select comboboxes that
// (a) often render AFTER the main pjaFillForm pass (so they're missed), and
// (b) ignore programmatic value-setting. This dedicated pass runs late, scrolls
// each into view, opens the control (mouse sequence), and clicks the matching
// option from react-select-{id}-listbox. Degree/Discipline have static option
// lists (open+select works). School fetches options from typed input — react-
// select won't fetch from a programmatic set, so school is best-effort here and
// only fills if its options are already present.
async function pjaFillGreenhouseEducation(profile) {
  if (!/greenhouse\.io/i.test(location.hostname)) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dbg = m => { try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[gh-edu] '+m); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){} };

  // Click a react-select option via a TRUSTED CDP mouse click (commits the selection —
  // synthetic MouseEvents don't reliably commit react-select). Falls back to synthetic.
  const cdpClickEl = (el) => new Promise(resolve => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let done = false;
    const fallback = () => { ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0}))); };
    const t = setTimeout(() => { if (!done) { done = true; fallback(); resolve('synthetic-timeout'); } }, 3000);
    try {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x, y }, (resp) => {
        if (done) return; done = true; clearTimeout(t);
        if (chrome.runtime.lastError || resp?.error) { fallback(); resolve('synthetic-fail'); }
        else resolve('cdp');
      });
    } catch (_) { if (!done) { done = true; clearTimeout(t); fallback(); resolve('synthetic-catch'); } }
  });

  const fillRS = async (idPrefix, value, otherFallback) => {
    if (!value) return;
    // handle numbered variants school--0, degree--0, etc.
    // WAIT for late-rendering education fields (Greenhouse renders the education section
    // progressively — "discipline" often appears a beat after the pass first runs, and was
    // being skipped as not-in-dom → required discipline* left empty → whole form skipped).
    let inp = document.getElementById(idPrefix + '--0') || document.getElementById(idPrefix);
    // Only wait when the education SECTION is present (a sibling school/degree/education control
    // exists) but this specific field is late — otherwise skip immediately (no education section).
    const eduSectionPresent = () => !!(document.getElementById('school--0') || document.getElementById('degree--0') ||
      document.querySelector('[id^="school"],[id^="degree"],[id^="discipline"],[class*="education"]'));
    if (!inp && eduSectionPresent()) {
      for (let _w = 0; !inp && _w < 8; _w++) { await sleep(400); inp = document.getElementById(idPrefix + '--0') || document.getElementById(idPrefix); }
    }
    if (!inp) { dbg(idPrefix + ' not-in-dom'); return; }
    const ctrl = inp.closest('[class*="select__control"]');
    // Skip only if a value is actually COMMITTED (react-select single-value present) —
    // NOT if there's merely typed text (pjaFillForm's combo attempt leaves uncommitted text).
    if (ctrl?.querySelector('[class*="single-value"],[class*="singleValue"]')) return;
    inp.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(150);
    const openCtrl = () => { if (ctrl) ['mousedown','mouseup','click'].forEach(t => ctrl.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0,buttons:1}))); };
    const getOpts = () => { const lb = document.getElementById('react-select-' + inp.id + '-listbox'); return lb ? Array.from(lb.querySelectorAll('[role=option]')) : []; };
    const lv = value.toLowerCase();
    const firstWord = lv.split(' ')[0];
    const pick = (opts) => opts.find(o => o.textContent.trim().toLowerCase() === lv)
      || opts.find(o => o.textContent.trim().toLowerCase().includes(lv))
      || opts.find(o => o.textContent.trim().toLowerCase().includes(firstWord));

    // Step 1: open WITHOUT typing — static lists (Degree/Discipline) show all options;
    // typing would filter out close-but-inexact matches (e.g. "Environmental Studies").
    openCtrl();
    await sleep(600);
    let opts = getOpts();
    let m = opts.length ? pick(opts) : null;

    // Step 2: if no usable option (async lists like School/Discipline), TYPE via CDP
    // (real keystrokes) so react-select fires its async option fetch. Synthetic typing
    // is ignored by react-select, so use a trusted CDP type at the input's coords.
    if (!m) {
      const ir = inp.getBoundingClientRect();
      const ix = ir.left + ir.width / 2, iy = ir.top + ir.height / 2;
      // Type the first ~2 words: enough to disambiguate a city ("Santa Clara") and to
      // filter discipline ("Environmental Engineering"), while a too-specific school name
      // ("a foreign university") simply yields nothing → Other fallback handles it.
      const q = value.split(/[\s,]+/).slice(0, 2).join(' ').slice(0, 18);
      await new Promise(res => {
        let done = false; const to = setTimeout(() => { if (!done) { done = true; res(); } }, 5000);
        try { chrome.runtime.sendMessage({ type: 'CDP_TYPE_AT', x: ix, y: iy, text: q }, () => { if (!done) { done = true; clearTimeout(to); res(); } }); }
        catch (_) { if (!done) { done = true; clearTimeout(to); res(); } }
      });
      await sleep(1200);
      opts = getOpts();
      m = opts.length ? (pick(opts) || opts[0]) : null;
    }
    // Step 3: school not in the (US-centric) DB → select "Other" (honest for intl schools).
    if (!m && otherFallback) {
      openCtrl(); // CDP-type in step 2 may have closed the menu — reopen it
      await sleep(300);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
      inp.focus();
      if (setter) { setter.call(inp, ''); inp.dispatchEvent(new InputEvent('input',{bubbles:true})); setter.call(inp, 'Other'); inp.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Other',inputType:'insertText'})); }
      await sleep(1200);
      opts = getOpts();
      m = opts.find(o => /^other$/i.test(o.textContent.trim())) || null;
      if (m) dbg(inp.id + ' falling back to Other');
    }
    if (!m) { dbg(inp.id + ' no-opts'); inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return; }
    const how = await cdpClickEl(m);
    dbg(inp.id + ' picked "' + m.textContent.trim().slice(0,25) + '" via ' + how);
    await sleep(400);
  };

  // Location (City) — react-select with async options (verified: NOT Google Places).
  // Reuse fillRS: CDP-type the city → options render in react-select-candidate-location-listbox
  // → CDP-click the match. pick() matches on the city via the "includes" branch.
  await fillRS('candidate-location', profile.city ? (profile.city + (profile.state ? ', ' + profile.state : '')) : '');

  // Degree & Discipline first (reliable static lists), then School (best-effort).
  await fillRS('degree', profile.degree);
  await fillRS('discipline', profile.major, true);   // Other-fallback if exact discipline absent
  await fillRS('school', profile.university, true);   // Other-fallback for unlisted (intl) schools

  // ── Sweep remaining empty react-select questions (sponsorship, work-auth, EEO) ──
  // Greenhouse renders custom screening questions as react-selects with generic ids
  // (question_NNN). Classify by label and pick the matching option via open+select.
  const rsInputs = Array.from(document.querySelectorAll('input[role="combobox"]'))
    .filter(el => {
      const ctrl = el.closest('[class*="select__control"]');
      if (!ctrl || el.offsetParent === null) return false;
      // not yet committed (no single-value span)
      return !ctrl.querySelector('[class*="single-value"],[class*="singleValue"]');
    });
  for (const inp of rsInputs) {
    if (/^(school|degree|discipline)/.test(inp.id || '')) continue; // handled above
    // resolve label
    const lblBy = inp.getAttribute('aria-labelledby');
    let label = '';
    if (lblBy) label = (document.getElementById(lblBy.split(' ')[0])?.textContent || '').toLowerCase();
    if (!label) label = (inp.getAttribute('aria-label') || '').toLowerCase();
    if (!label) {
      const fld = inp.closest('div'); const l = fld?.querySelector('label'); label = (l?.textContent || '').toLowerCase();
    }
    // Walk up several ancestors — some fields (e.g. Greenhouse Country) nest the <label> higher
    // than the immediate div, so the check above returned '' and the field was skipped entirely.
    if (!label) {
      let node = inp;
      for (let d = 0; d < 5 && !label; d++) { node = node.parentElement; if (!node) break; const l = node.querySelector('label'); if (l) label = (l.textContent || '').toLowerCase(); }
    }
    // Last resort: use the input id (e.g. "country") so a known field is not skipped.
    if (!label && inp.id) label = inp.id.toLowerCase();
    if (!label) continue;
    // decide answer
    let want = null;
    // Country is a SEARCHABLE 244-option react-select. The fiber onChange returns "true" but the
    // value does NOT actually commit for this widget (verified 4x → country-error persisted). So
    // do NOT short-circuit on fiber here; fall through to the type-to-filter + TRUSTED-CDP-click
    // path below (cdpClickEl is what genuinely commits a react-select, as it does for school/degree).
    if (/country/i.test(label) || inp.id === 'country') {
      want = /united states|usa|u\.s\./i;
    }
    else if (/sponsor/i.test(label)) want = /no|not/i;             // require sponsorship → No
    else if (/authoriz|legally|eligible to work|right to work/i.test(label)) want = /yes|authorized/i;
    else if (/gender|are you (male|female)/i.test(label)) want = profile.gender ? new RegExp(profile.gender, 'i') : /decline|prefer not/i;
    else if (/hispanic|latino/i.test(label)) want = /no|not hispanic|decline/i;
    else if (/veteran/i.test(label)) want = /not a protected veteran|not a veteran|no|decline/i;
    else if (/disab/i.test(label)) want = /no.*disability|don.t have|decline|no$/i;
    else if (/onsite|on-site|in person|in-person|commute|relocat|able to work (at|in|on)|willing to work/i.test(label)) want = /yes/i;
    else if (/shift|schedule|weekend|night|overtime|swing|flexible hours|work.*hours/i.test(label)) want = /yes/i;
    else if (/18 years|over 18|at least 18|legal age/i.test(label)) want = /yes/i;
    else if (/current or former|currently employed|former employee|previously (work|employ)|ever (work|been employed)/i.test(label)) want = /^no|^never/i;
    else if (/(have you|do you|are you).*(read|agree|acknowledge|consent|certify)/i.test(label)) want = /yes|agree|i (agree|certify|acknowledge)/i;
    else continue; // unknown question — leave for AI/answer-bank
    // open + select
    inp.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(120);
    const ctrl = inp.closest('[class*="select__control"]');
    ['mousedown','mouseup','click'].forEach(t => ctrl.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0,buttons:1})));
    await sleep(500);
    // Large SEARCHABLE selects (Country: 244 options) don't render "United States" until the
    // input filters. Type into the input to filter, THEN scan + trusted-CDP-click the option
    // (cdpClickEl is what actually commits react-select — synthetic option clicks don't stick).
    const isBigSearch = (inp.id === 'country') || /\bcountry\b/i.test(label);
    if (isBigSearch) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const q = 'United';
      inp.focus();
      if (setter) setter.call(inp, q); else inp.value = q;
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: q, inputType: 'insertText' }));
      await sleep(650);
    }
    const lb = document.getElementById('react-select-' + inp.id + '-listbox');
    const opts = lb ? Array.from(lb.querySelectorAll('[role=option]')) : [];
    if (!opts.length) { inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); continue; }
    const m = (isBigSearch ? (opts.find(o => /^united states$/i.test(o.textContent.trim())) || opts.find(o => want.test(o.textContent.trim()))) : opts.find(o => want.test(o.textContent.trim()))) || null;
    if (m) { const how = await cdpClickEl(m); dbg('q "'+label.slice(0,20)+'" → "'+m.textContent.trim().slice(0,18)+'" via '+how); }
    else { inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); }
    await sleep(300);
  }
}

// ── ARIA combobox filler (Greenhouse, Ashby, Lever custom dropdowns) ───────
// These widgets use <input type="text" role="combobox"> + toggle button +
// [role="listbox"] flyout — not standard <select> elements.
// Strategy: click the toggle to open the flyout, then click the matching option.
// Falls back to React fiber injection, then typing the value if no listbox appears.
function pjaFillCombobox(input, value, key) {
  const lv = value.toLowerCase().trim();

  // ── Greenhouse Google Places location combobox (id="candidate-location") ──
  // This widget only fires its autocomplete on real keystroke events, not on
  // programmatic value-sets.  Strategy:
  //   1. Clear any existing text, focus, type the value via execCommand so the
  //      Places API gets triggered and renders a listbox.
  //   2. After a 600 ms delay (Places API is async), click the first option whose
  //      text starts with the city name.  If none appears, fall through to the
  //      normal combobox path so the text value is at least present.
  if (input.id === 'candidate-location') {
    const cityOnly = value.split(',')[0].trim();
    const _setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const _sleep = ms => new Promise(r => setTimeout(r, ms));
    // Greenhouse CLEARS the typed text on blur unless a Places suggestion is actually selected, so
    // plain text never satisfies the required check — only a clicked suggestion commits. Places also
    // returns a comma'd "City, State, Country", whereas the typed cityOnly has no comma; so a comma
    // in the field value is a reliable "a suggestion committed" signal. Retry (Places can be slow
    // under load), poll up to ~2s for the listbox, and use a full mouse sequence on the item.
    // candidate-location is a react-select (aria-autocomplete=list, remix build) — NOT Google Places
    // on newer forms. Committed = a single-value in ITS OWN control (or a comma'd input.value for the
    // legacy Places variant). Checking only `,` missed react-select selections → never committed.
    const _lctrl = input.closest('[class*="select__control"]');
    const committed = () => {
      const sv = _lctrl && _lctrl.querySelector('[class*="single-value"],[class*="singleValue"]');
      if (sv && sv.textContent && sv.textContent.trim() && !/^\s*select/i.test(sv.textContent)) return true;
      return /,/.test(input.value || '');
    };
    window._pjaComboChain = (window._pjaComboChain || Promise.resolve()).then(async () => {
      for (let attempt = 0; attempt < 3 && !committed(); attempt++) {
        input.focus();
        if (_setter) _setter.call(input, ''); else input.value = '';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await _sleep(80);
        // Async option fetch (Places OR react-select) only fires on GENUINE keystrokes — CDP-type the
        // city at the input's coords so the option list actually appears, then CDP-click the match.
        const lr = input.getBoundingClientRect();
        const lx = lr.left + lr.width / 2, ly = lr.top + lr.height / 2;
        await new Promise(res => { let dn = false; const to = setTimeout(() => { if (!dn) { dn = true; res(); } }, 5000);
          try { chrome.runtime.sendMessage({ type: 'CDP_TYPE_AT', x: lx, y: ly, text: cityOnly }, () => { if (!dn) { dn = true; clearTimeout(to); res(); } }); }
          catch (_) { if (!dn) { dn = true; clearTimeout(to); res(); } } });
        // Find THIS field's option list (react-select-candidate-location-listbox, or the menu inside
        // its own select wrapper, or a Places .pac-container) — NOT a stale country listbox.
        let match = null;
        for (let w = 0; w < 14 && !match; w++) {
          await _sleep(200);
          const roots = typeof pjaGetAllRoots === 'function' ? pjaGetAllRoots() : [document];
          let opts = [];
          for (const root of roots) {
            const own = root.getElementById && root.getElementById('react-select-' + input.id + '-listbox');
            const menu = _lctrl && _lctrl.closest('[class*="select"]') && _lctrl.closest('[class*="select"]').querySelector('[role="listbox"] ,[class*="select__menu"]');
            const pac = root.querySelector('.pac-container:not([style*="display: none"])');
            [own, menu, pac].forEach(lb => { if (lb) opts = opts.concat(Array.from(lb.querySelectorAll('[role="option"], .pac-item'))); });
          }
          // Only accept an option that actually contains the city — never a fallback opts[0]
          // (that was clicking "Afghanistan" from a stale country listbox).
          match = opts.find(o => (o.textContent || '').toLowerCase().includes(cityOnly.toLowerCase())) || null;
        }
        if (match) { await cdpClickEl(match); await _sleep(350); }
      }
      try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[loc] candidate-location committed='+committed()+' val="'+String(input.value||'').slice(0,24)+'"'); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
    });
    return true;
  }

  // Workday multiselect widget (data-uxi-widget-type="selectinput")
  // Container click doesn't open the dropdown — must type into the input via nativeInputValueSetter.
  // Options must be selected via the inner promptLeafNode child, not the outer role="option" div.
  if (input.getAttribute('data-uxi-widget-type') === 'selectinput') {
    const _nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    const doSelectWorkday = () => {
      const listbox = document.querySelector('[data-automation-id="activeListContainer"]') ||
        document.querySelector('[role="listbox"]:not([hidden]):not([id*="iti"]):not([aria-label*="countr"])');
      if (!listbox) return false;
      const opts = Array.from(listbox.querySelectorAll('[role="option"]'));
      if (!opts.length) return false;

      // Use only the option's OWN label text — clone and strip nested child options
      // so parent options like "Job Board or Social Media" don't absorb their children's text.
      const getOptText = opt => {
        const clone = opt.cloneNode(true);
        clone.querySelectorAll('[role="option"]').forEach(c => c.remove());
        return clone.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
      };

      const isYes = ['yes','true','1'].includes(lv);
      const isNo  = ['no','false','0'].includes(lv);
      let match = opts.find(o => getOptText(o) === lv);
      if (!match && lv.length > 3) match = opts.find(o => getOptText(o).includes(lv));
      if (!match && isYes) match = opts.find(o => /^yes\b/i.test(getOptText(o)));
      if (!match && isNo)  match = opts.find(o => /^no\b/i.test(getOptText(o)));
      if (!match && key === 'requireSponsorship' && isNo)
        match = opts.find(o => /not required|will not require|no.*will not/i.test(getOptText(o)));
      if (!match && key === 'workAuth' && isYes)
        match = opts.find(o => /authorized/i.test(getOptText(o)) && !/not authorized/i.test(getOptText(o)));
      if (!match && key === 'referralSource') {
        const RF = ['linkedin','job board or social media','social media','job board','online job board','internet','online','job posting','indeed','glassdoor','external job board'];
        for (const fb of RF) { match = opts.find(o => getOptText(o).includes(fb)); if (match) break; }
      }
      if (!match) return false;

      // Only use promptLeafNode as click target for leaf options (no nested child options).
      // Parent options (e.g. "Job Board or Social Media") have nested [role="option"] children;
      // their first promptLeafNode descends into a child ("Indeed"), causing the wrong click.
      const isLeafOption = !match.querySelector('[role="option"]');
      const leafNode = isLeafOption ? match.querySelector('[data-automation-id="promptLeafNode"]') : null;
      const target = leafNode || match;
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, button: 0 }));
      const selText = target.textContent?.trim();
      console.log('PJA WD multiselect select:', selText, 'via:', leafNode ? 'leafNode' : 'option');
      chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19);
        arr.push('[WD] multiselect selected: "' + selText?.slice(0,40) + '" key=' + key);
        chrome.storage.local.set({ pja_dbg: arr });
      });
      return true;
    };

    // Open via CDP trusted click (bypasses Workday's isTrusted check).
    // Assign a temporary unique ID to the inputContainer so background.js can find it.
    const openWdMultiselect = () => {
      const msContainer = input.closest('[data-uxi-widget-type="multiselect"]');
      const inputContainer = msContainer?.querySelector('[data-automation-id="multiselectInputContainer"]');
      const clickTarget = inputContainer || input;
      const tempId = '__pja_wd_ms_' + Date.now();
      clickTarget.setAttribute('id', tempId);
      return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_CLICK', selector: '#' + CSS.escape(tempId) }, resp => {
          clickTarget.removeAttribute('id');
          const ok = resp?.ok || false;
          console.log('PJA WD CDP click result:', ok, 'selector:', tempId);
          chrome.storage.local.get('pja_dbg', d => {
            const arr = (d.pja_dbg || []).slice(-19);
            arr.push('[WD] CDP click ok=' + ok + ' key=' + key + ' val=' + String(value).slice(0,30));
            chrome.storage.local.set({ pja_dbg: arr });
          });
          resolve(ok);
        });
      });
    };

    window._pjaComboChain = (window._pjaComboChain || Promise.resolve()).then(() => new Promise(resolve => {
      openWdMultiselect().then(() => {
        // Wait for the dropdown to populate, then select the target option.
        setTimeout(() => {
          if (!doSelectWorkday()) {
            // Retry after extra delay (options may load via network)
            setTimeout(() => {
              if (!doSelectWorkday()) console.log('PJA WD multiselect: no match for', value, 'key:', key);
              resolve();
            }, 800);
            return;
          }
          // If we clicked a parent category to expand it, the item isn't selected yet.
          // Re-run after expansion to pick the correct leaf option.
          setTimeout(() => {
            const msContainer = input.closest('[data-uxi-widget-type="multiselect"]');
            const containerText = msContainer?.textContent || '';
            if (!/\d+ item/.test(containerText)) doSelectWorkday();
            resolve();
          }, 500);
        }, 700);
      });
    }));
    return true;
  }

  // Find the outer clickable container (react-select's control div that handles mousedown/click).
  // Targeting the inner <input> element does NOT open the menu; react-select's handler is on this div.
  const selectCtrl = input.closest('[class*="select__control"]');

  // IDEMPOTENCY: react-select keeps its input.value EMPTY even when a value is selected (the
  // value renders in `.select__single-value`), so the callers' `!input.value` empty-check thinks
  // the field is unfilled and re-fills it on every pass. Re-opening an already-selected react-
  // select toggles its menu CLOSED and corrupts the value (the Greenhouse multi-pass race that
  // left Country/experience empty at submit). Skip if a non-placeholder single-value is present.
  if (selectCtrl) {
    const sv = selectCtrl.querySelector('[class*="single-value"]');
    if (sv && sv.textContent && sv.textContent.trim()) return true;
  }

  // REACT-SELECT PRIMARY PATH: call the component's onChange directly via the React fiber
  // (through the MAIN-world fiber-main.js bridge) — reads options from props, NO menu open
  // needed. This is the RELIABLE fill for Greenhouse job-boards react-selects, whose menus
  // won't open from isolated-world synthetic OR CDP clicks (the Antora/PsiQuantum
  // question_19018428004 + self-ID selects). Verified live: sets "No" where clicks all failed.
  // Falls through to the click path (below) only if the fiber has no options/onChange (e.g. the
  // Country phone-combined select, which the CDP-open path handles).
  // NOTE: try the fiber bridge UNCONDITIONALLY (not gated on selectCtrl). Some Greenhouse builds
  // (e.g. the "remix" job-boards embed) give the required combobox input a structure where
  // input.closest('.select__control') is null even though the react-select onChange is reachable
  // by walking up the fiber from the input — gating on selectCtrl skipped those entirely (the
  // Export Control / custom question_* selects never reached the bridge → never committed → the
  // form failed submit on them). The bridge walks the fiber and returns false harmlessly when no
  // react-select onChange exists, so this is safe for genuine non-react-select comboboxes.
  if (typeof pjaFillViaReactFiber === 'function') {
    try { if (pjaFillViaReactFiber(input, value, key)) return true; } catch (_) {}
  }

  // Find the toggle/expand button for non-react-select combobox widgets.
  const widgetContainer = input.closest(
    '[class*="select__container"],[class*="selectContainer"],[class*="select-container"],' +
    '[class*="combobox"],[class*="Combobox"],[aria-haspopup="listbox"]'
  ) || input.parentElement?.parentElement || input.parentElement;

  const toggleBtn = !selectCtrl && widgetContainer && (
    Array.from(widgetContainer.querySelectorAll('button')).find(b =>
      /toggle|expand|chevron|dropdown|icon/i.test(
        b.getAttribute('aria-label') || b.className || b.getAttribute('aria-haspopup') || b.textContent || ''
      )
    ) ||
    widgetContainer.querySelector('[aria-haspopup="listbox"]:not(input)') ||
    widgetContainer.querySelector('[role="button"]')
  );

  // react-select uses id="react-select-{inputId}-listbox" for the options menu.
  const expectedListboxId = input.id ? `react-select-${input.id}-listbox` : null;
  const ariaControlsId = input.getAttribute('aria-controls');

  const doSelect = () => {
    let listbox = null;
    if (expectedListboxId) listbox = document.getElementById(expectedListboxId);
    if (!listbox && ariaControlsId) listbox = document.getElementById(ariaControlsId);
    if (!listbox && widgetContainer) listbox = widgetContainer.querySelector('[role="listbox"]');
    if (!listbox) {
      const roots = typeof pjaGetAllRoots === 'function' ? pjaGetAllRoots() : [document];
      for (const root of roots) {
        const lb = root.querySelector('[role="listbox"]:not([hidden]):not([id*="iti"]):not([aria-label*="countr"]):not([aria-label*="Country"])');
        if (lb) { listbox = lb; break; }
      }
    }
    if (!listbox) return false;

    const opts = Array.from(listbox.querySelectorAll('[role="option"]'));
    if (!opts.length) return false;

    // Verbose-answer coercion: the answer bank / AI may hold prose like "No. My background is…"
    // for a Yes/No select. Reduce to a leading yes/no token so the option match below can fire
    // (else the field never selects → 'exp=true FAIL', the Antora question_19018428004 case).
    const lvLead = lv.match(/^(yes|no)\b/);
    const isYes = ['yes','true','1'].includes(lv) || (lvLead && lvLead[1] === 'yes');
    const isNo  = ['no','false','0'].includes(lv)  || (lvLead && lvLead[1] === 'no');

    let match = opts.find(o => o.textContent.trim().toLowerCase() === lv);
    if (!match && isYes) match = opts.find(o => /^yes\b/i.test(o.textContent.trim()));
    if (!match && isNo)  match = opts.find(o => /^no\b/i.test(o.textContent.trim()));
    if (!match && key === 'requireSponsorship' && isNo)
      match = opts.find(o => /not required|will not require|no.*will not/i.test(o.textContent));
    if (!match && key === 'workAuth' && isYes)
      match = opts.find(o => /authorized/i.test(o.textContent) && !/not authorized/i.test(o.textContent));
    // Affirmative-consent fallback: "I agree"/"Yes"/"I certify"/"acknowledge"/"accept" should
    // match whatever affirmative wording a consent/certification dropdown actually uses.
    if (!match && /^(yes|i agree|agree|i certify|certify|i acknowledge|acknowledge|i accept|accept|i consent|consent|confirm)\b/i.test(lv)) {
      match = opts.find(o => /\b(yes|agree|accept|acknowledge|certif|consent|confirm|i have read|i understand)\b/i.test(o.textContent) && !/\b(no|do not|don'?t|decline|disagree)\b/i.test(o.textContent));
      if (!match && opts.length <= 2) match = opts.find(o => !/^\s*no\b|decline|do not|disagree/i.test(o.textContent.trim()));
    }
    // Affirmative/negative PROSE → binary yes/no option (mirrors fiber-main pickOpt step 5).
    // The AI may answer a Yes/No question with a full sentence ("I have supported manufacturing
    // operations…" = yes). Only map on a BINARY yes/no option set with UNAMBIGUOUS leading
    // sentiment; otherwise leave unmatched (skip rather than commit a guess). Normalizes format.
    if (!match) {
      const yesO = opts.find(o => /^yes\b/i.test(o.textContent.trim()));
      const noO  = opts.find(o => /^no\b/i.test(o.textContent.trim()));
      if ((yesO || noO) && opts.length <= 3) {
        if (/^(no\b|not\b|never\b|none\b|i (do not|don'?t|have not|haven'?t|am not|'?m not|was not|wasn'?t|cannot|can'?t|did not|didn'?t))/i.test(lv)) { if (noO) match = noO; }
        else if (/^(yes\b|absolutely\b|correct\b|affirmative\b|i've\b|i (have|am|'?m|do|can|could|would|will|was|did|'?ve)\b)/i.test(lv)) { if (yesO) match = yesO; }
      }
    }
    if (!match && lv.length > 3)
      match = opts.find(o => o.textContent.trim().toLowerCase().includes(lv));
    // Numeric-range options (e.g. years-of-experience dropdowns "0-3 years", "5-8 years",
    // "12+ years"): a bare number like "6" never substring-matches a range, so pick the range
    // that CONTAINS the value (6 → "5-8 years"). Uses profile.yearsExperience routed as the value.
    if (!match && /^\d+$/.test(lv)) {
      const n = parseInt(lv, 10);
      match = opts.find(o => {
        const txt = o.textContent.trim();
        const plus = txt.match(/(\d+)\s*\+/);                       // "12+ years"
        if (plus) return n >= parseInt(plus[1], 10);
        const range = txt.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/i);   // "5-8 years"
        if (range) return n >= parseInt(range[1], 10) && n <= parseInt(range[2], 10);
        return false;
      });
      // boundary fallback: if the value sits exactly on a shared edge (e.g. 5 with "3-5"+"5-8"),
      // the first containing range above already wins; if nothing matched, take the highest
      // range whose lower bound is ≤ n (so 20 → "12+ years").
      if (!match) {
        let best = null, bestLow = -1;
        for (const o of opts) {
          const m = o.textContent.match(/(\d+)/);
          if (m) { const low = parseInt(m[1], 10); if (low <= n && low > bestLow) { bestLow = low; best = o; } }
        }
        match = best;
      }
    }
    // State name → abbreviation (e.g. "California" → "CA")
    if (!match) {
      const STATE_ABBR = {
        'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
        'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
        'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
        'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
        'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
        'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
        'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
        'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
        'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
        'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
        'west virginia':'WV','wisconsin':'WI','wyoming':'WY'
      };
      const abbr = STATE_ABBR[lv];
      if (abbr) match = opts.find(o => o.textContent.trim().toUpperCase() === abbr);
      if (!match && lv.length === 2) {
        const fullName = Object.entries(STATE_ABBR).find(([k,v]) => v === lv.toUpperCase())?.[0];
        if (fullName) match = opts.find(o => o.textContent.trim().toLowerCase() === fullName);
      }
    }
    // Country code → full name (e.g. "usa"/"us" → "United States")
    if (!match) {
      const COUNTRY_MAP = {
        'usa':'united states','us':'united states','u.s.':'united states','u.s.a.':'united states',
        'uk':'united kingdom','u.k.':'united kingdom','gb':'united kingdom',
        'ca':'canada','au':'australia','de':'germany','fr':'france','in':'india',
        'mx':'mexico','br':'brazil','jp':'japan','cn':'china','sg':'singapore',
        'nz':'new zealand','ie':'ireland','nl':'netherlands','se':'sweden','no':'norway'
      };
      const countryName = COUNTRY_MAP[lv];
      if (countryName) {
        match = opts.find(o => o.textContent.trim().toLowerCase() === countryName) ||
                opts.find(o => o.textContent.trim().toLowerCase().startsWith(countryName));
      }
    }

    // referralSource: "LinkedIn" won't match directly on most job sites.
    // Map to common job-board/social-media options.
    if (!match && key === 'referralSource') {
      const REFERRAL_FALLBACKS = ['linkedin','job board or social media','social media','job board','online job board','internet','online','job posting','indeed','glassdoor','external job board'];
      for (const fallback of REFERRAL_FALLBACKS) {
        match = opts.find(o => o.textContent.trim().toLowerCase().includes(fallback));
        if (match) break;
      }
    }

    if (match) {
      // Full mouse sequence — react-select needs mousedown before click to register the selection
      match.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      match.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, button: 0 }));
      match.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, button: 0 }));
      // Log singleValue state after selection to verify react-select processed the click
      setTimeout(() => {
        const ctrl = input.closest('[class*="select__container"],[class*="select "]') || input.parentElement?.parentElement?.parentElement;
        const sv = ctrl?.querySelector('[class*="single-value"],[class*="singleValue"]');
        console.log('PJA combo post-select sv:', sv?.textContent?.trim() || 'NONE', 'input.value:', input.value, 'id:', input.id);
      }, 150);
      return true;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  };

  // For autocomplete comboboxes (aria-autocomplete=list, e.g. Greenhouse School/Degree),
  // the option list is EMPTY until the user types a query. Typing via the native value
  // setter + InputEvent (NOT execCommand, which no-ops in an isolated content script)
  // populates the filtered options so doSelect() can find a match.
  const isAutocomplete = (input.getAttribute('aria-autocomplete') || '').includes('list')
    || input.getAttribute('role') === 'combobox';
  const typeToFilter = (q) => {
    try {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, ''); else input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      if (setter) setter.call(input, q); else input.value = q;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(q), inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: q.slice(-1), bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: q.slice(-1), bubbles: true }));
    } catch (_) {}
  };

  // Open the flyout — fire full mouse sequence on select__control (the outer clickable div).
  // Background: react-select's onMouseDown is on the container, not the inner input.
  const openFlyout = () => {
    if (selectCtrl) {
      // ALREADY OPEN → don't re-fire the mouse sequence: on react-select a second mousedown
      // TOGGLES the menu CLOSED, which is the Greenhouse multi-pass race (a field opened by one
      // fill attempt got closed by the next → exp=true then FAIL). Leave it open for doSelect().
      if (input.getAttribute('aria-expanded') === 'true') { try { input.focus(); } catch (_) {} return; }
      // FOCUS the inner input BEFORE the mouse sequence — react-select v5 (Greenhouse
      // job-boards, emotion `remix-css-*` classes) only opens its menu on mousedown when the
      // input is already focused. Without this, large selects like Country (244 options) never
      // opened (aria-expanded stayed false → lbFound=false → field left empty → submit blocked).
      // Verified live on the Antora Country react-select.
      try { input.focus(); } catch (_) {}
      // Open the react-select control (its onMouseDown is on this div, not the inner input).
      ['mouseover','mouseenter','mousemove','mousedown','mouseup','click'].forEach(type =>
        selectCtrl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 }))
      );
      // ASYNC react-selects (e.g. Greenhouse School/Degree/Discipline) show NO options until the
      // query is typed — so type even though react-select owns the input. Native value-setter +
      // InputEvent IS picked up by react-select and loads the filtered/async options. (Verified
      // live: typing surfaces the matching option, which doSelect then clicks.) For non-async
      // react-selects this merely filters to the value, which is harmless.
      if (isAutocomplete) typeToFilter(value);
    } else if (isAutocomplete) {
      typeToFilter(value);
    } else if (toggleBtn) {
      toggleBtn.click();
    } else {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    }
  };

  // Sequential queue: comboboxes must be filled one at a time — opening a new dropdown closes
  // any currently open one, causing parallel fills to cancel each other.
  const _inputId = input.id || input.name || '?';
  if (typeof window._pjaComboChain === 'undefined') window._pjaComboChain = Promise.resolve();
  // Autocomplete options arrive async (often via network) — wait longer between attempts.
  const w = isAutocomplete ? 700 : 200;
  const _dbg = (m) => { try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[combo] '+m); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){} };

  // CDP trusted-open for react-select v5 controls: some (e.g. Greenhouse job-boards Country,
  // 244 opts) refuse to open from an isolated-world synthetic mousedown — the menu only renders
  // on a TRUSTED mousedown. Reuse the WORKDAY_TRUSTED_CLICK CDP path to click the control in the
  // real page context; the isolated-world option click in doSelect() then works normally.
  const cdpTrustedOpen = () => {
    const target = selectCtrl || input;
    if (!target || typeof chrome === 'undefined' || !chrome.runtime) return Promise.resolve(false);
    const hadId = target.id;
    const tempId = '__pja_rs_' + Date.now();
    target.setAttribute('id', tempId);
    try { input.focus(); } catch (_) {}
    const restore = () => { if (hadId) target.setAttribute('id', hadId); else target.removeAttribute('id'); };
    return new Promise(resolve => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; restore(); resolve(false); } }, 3000);
      try {
        const sel = '#' + ((window.CSS && CSS.escape) ? CSS.escape(tempId) : tempId);
        chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_CLICK', selector: sel }, resp => {
          if (done) return; done = true; clearTimeout(to); restore();
          resolve(!!(resp && resp.ok));
        });
      } catch (_) { if (!done) { done = true; clearTimeout(to); restore(); resolve(false); } }
    });
  };

  window._pjaComboChain = window._pjaComboChain.then(() => (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // Attempt 1 — synthetic open (works for most react-selects + Workday multiselects).
    openFlyout();
    await sleep(isAutocomplete ? 700 : 150);
    const lbId = expectedListboxId ? document.getElementById(expectedListboxId) : null;
    _dbg(_inputId+' val="'+String(value).slice(0,20)+'" selectCtrl='+!!selectCtrl+' expLbId='+expectedListboxId+' lbFound='+!!lbId+' exp='+input.getAttribute('aria-expanded'));
    if (doSelect()) { _dbg(_inputId+' OK-a1'); return; }
    // How many options are currently rendered for THIS react-select's menu.
    const optionCount = () => {
      let lb = expectedListboxId ? document.getElementById(expectedListboxId) : null;
      if (!lb && ariaControlsId) lb = document.getElementById(ariaControlsId);
      return lb ? lb.querySelectorAll('[role="option"]').length : 0;
    };
    // Attempt 2 — CDP TRUSTED open for react-select controls whose menu didn't populate via
    // synthetic events (react-select v5 renders options only on a TRUSTED mousedown). Trigger on
    // the real signal — NO options rendered — NOT on aria-expanded (some fields report
    // expanded=true with an EMPTY menu: the Antora experience + Hispanic/Latino selects). A CDP
    // click toggles, so if it closed an already-open-but-empty menu, tap once more.
    if (selectCtrl && optionCount() === 0) {
      let opened = await cdpTrustedOpen();
      await sleep(450);
      if (optionCount() === 0) { opened = await cdpTrustedOpen(); await sleep(450); }
      if (isAutocomplete && optionCount() > 20) { typeToFilter(value); await sleep(500); }
      if (doSelect()) { _dbg(_inputId+' OK-cdp opened='+opened+' opts='+optionCount()); return; }
    }
    // Attempt 3 — synthetic retry.
    openFlyout();
    await sleep(w);
    if (doSelect()) { _dbg(_inputId+' OK-a3'); return; }
    _dbg(_inputId+' FAIL→native exp='+input.getAttribute('aria-expanded'));
    pjaSetNative(input, value);
  })());

  return true;
}

// ── Autofill ───────────────────────────────────────────────────────────────
function pjaFillForm(profile, answers) {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // ── Pass 1: text inputs, selects, textareas ────────────────────────────
  // Workday selectinput inner inputs have zero BoundingClientRect when closed —
  // include them regardless of visibility since CDP click works without visual open state.
  const wdSelectinputVisible = el =>
    el.getAttribute('data-uxi-widget-type') === 'selectinput' &&
    /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
  const fields = pjaQueryAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]):not([type=reset]):not([type=radio]):not([type=checkbox]),select,textarea'
  ).filter(el => visible(el) || wdSelectinputVisible(el));

  // Debug: log field summary on Workday forms
  if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
    const summary = fields.map(el => {
      const lbl = pjaGetLabel(el);
      const uxi = el.getAttribute('data-uxi-widget-type') || '';
      const role = el.getAttribute('role') || '';
      return (lbl || el.name || el.id || '?').slice(0,30) + (uxi ? '['+uxi+']' : '') + (role ? '('+role+')' : '');
    }).join(' | ');
    chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19);
      arr.push('[WD] pjaFillForm fields(' + fields.length + '): ' + summary.slice(0, 200));
      chrome.storage.local.set({ pja_dbg: arr });
    });
  }

  let filled = 0;
  // Easy Apply scope guard: when an EA modal is open, only fill fields INSIDE it. Filling
  // LinkedIn's own page inputs (the jobs search bar) triggers a search that closes the modal
  // mid-flow (root cause of EA modal_closed/unknown_buttons). On ATS pages there's no EA modal,
  // so _eaRoot is null and filling stays document-wide as before.
  const _eaModal = (typeof pjaGetCurrentModal === 'function') ? pjaGetCurrentModal() : null;
  const _eaRoot = _eaModal && _eaModal.root;
  fields.forEach(el => {
    if (_eaRoot && _eaRoot.contains && !_eaRoot.contains(el)) return;
    if (/^(jobs-search-box|global-nav)/.test(el.id || '')) return;
    const rawLabel = pjaGetLabel(el);
    const key = pjaClassify(rawLabel);

    // Skip OPTIONAL social-profile / personal-URL fields (LinkedIn/Facebook/Twitter/etc).
    // They're rarely required, and a stale answer-bank value here fails the ATS's URL-format
    // validation (Workday flags them aria-invalid and blocks the step). Only fill if the
    // field is genuinely required AND we have a real value for it.
    const isOptional = !el.required && el.getAttribute('aria-required') !== 'true';
    if (isOptional && /please provide your (linkedin|facebook|twitter|instagram|github)|(facebook|twitter|instagram) (profile|handle|url|account)|social network|your (linkedin|facebook|twitter) (profile|handle)/i.test(rawLabel || '')) {
      const directVal = key && profile[key];
      if (!directVal) return; // leave empty — better than an invalid banked value
    }
    // DIAGNOSTIC: education combobox routing
    if (/^(school|degree|discipline)/.test(el.id || '')) {
      try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[ff] '+el.id+' label="'+String(rawLabel).slice(0,18)+'" key='+key+' role='+el.getAttribute('role')+' val="'+(el.value||'').slice(0,12)+'"'); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
    }
    // Skip already-filled fields only when we have no profile key for them.
    // If we have a profile value, always overwrite — prevents stale bfcache
    // or browser autofill from silently blocking our data.
    if (el.value && el.value.trim() && el.tagName !== 'SELECT' && !key) return;

    const isCombobox = (el.getAttribute('role') === 'combobox' && el.tagName === 'INPUT') ||
      // Workday multiselect search input (data-uxi-widget-type="selectinput")
      (el.getAttribute('data-uxi-widget-type') === 'selectinput' && el.tagName === 'INPUT');

    if (key) {
      // For currentLocation, fall back to constructing from city+state if the field is empty
      let profileVal = profile[key];
      if (key === 'currentLocation' && !profileVal && (profile.city || profile.state)) {
        profileVal = [profile.city, profile.state].filter(Boolean).join(', ');
      }
      // usPersonExportControl: derive from visaStatus if not explicitly set
      if (key === 'usPersonExportControl' && !profileVal) {
        const isUSPerson = /citizen|green card|permanent resident/i.test(profile.visaStatus || '');
        profileVal = isUSPerson ? 'Yes' : 'No';
      }
      // React tel/phone validation rejects formatted "(873) 688-2634"; use digits-only
      if ((el.type === 'tel' || key === 'phone') && profileVal) profileVal = profileVal.replace(/\D/g, '');
      if (profileVal) {
        // Don't fill textareas with bare numeric profile values (e.g. yearsExperience="6")
        // — those fields expect a sentence. Use banked sentence answer if available, else let AI handle.
        if (el.tagName === 'TEXTAREA' && /^\d+$/.test(String(profileVal).trim())) {
          const norm2 = pjaNormalizeLabel(rawLabel);
          const banked2 = answers && pjaFindBestAnswer(norm2, answers);
          if (banked2) { pjaSetNative(el, banked2); filled++; }
          return;
        }
        const validator = PJA_FIELD_VALIDATORS[key];
        const valid = !validator || validator(profileVal);
        if (valid) {
          let ok;
          const isPhoneField = el.type === 'tel' || key === 'phone';
          if (el.tagName === 'SELECT')       ok = pjaFillSelect(el, profileVal, key);
          else if (isCombobox)               ok = pjaFillCombobox(el, profileVal, key);
          else if (isPhoneField)            {
            console.log('PJA pjaFillForm: filling phone via fiber, id=', el.id, 'type=', el.type, 'val=', profileVal);
            pjaFillTextViaFiber(el, profileVal, true);
            console.log('PJA pjaFillForm: phone after fiber fill, el.value=', el.value);
            ok = true;
          }
          else { pjaFillTextViaFiber(el, profileVal); ok = true; }
          if (ok) { filled++; return; }
        }
      }
    }

    // If the label maps to a known profile key with a value, block answer bank fallback.
    // Exception: for non-sensitive fields with empty profile values (e.g. salaryExpectation=''),
    // allow the answer bank so pre-banked answers can still fill the field.
    const PII_KEYS = new Set(['email','phone','firstName','lastName','fullName','middleName','address','address2','zip','city','state','country']);
    if (key && key in profile && (profile[key] || PII_KEYS.has(key))) {
      return;
    }

    if (rawLabel.length > 3) {
      const norm = pjaNormalizeLabel(rawLabel);
      const banked = pjaFindBestAnswer(norm, answers);
      // BUG2 fix: route SELECTs through pjaFillSelect (React-aware) not pjaSetNative.
      // Also route comboboxes through pjaFillCombobox.
      if (banked) {
        const isPhoneField2 = el.type === 'tel' || pjaClassify(rawLabel) === 'phone';
        const ok = el.tagName === 'SELECT'
          ? pjaFillSelect(el, banked, null)
          : isCombobox
            ? pjaFillCombobox(el, banked, null)
          : isPhoneField2
            ? (pjaFillTextViaFiber(el, banked, true), true)
            : (pjaSetNative(el, banked), true);
        if (ok) filled++;
      }
    }
  });

  // ── Pass 2: radio button groups ────────────────────────────────────────
  // Group key = shadow-root id + name + fieldset legend.
  // LinkedIn reuses the SAME name attribute for every radio group on the page,
  // so name alone is insufficient — fieldset is the only reliable boundary.
  const radioGroups = {};
  pjaQueryAll('input[type=radio]').forEach(r => {
    if (!r.name || !visible(r)) return;
    const rootId = r.getRootNode() === document ? '__doc__' : (r.getRootNode().host?.id || '__shadow__');
    const fieldset = r.closest('fieldset');
    const fsKey = fieldset
      ? (fieldset.id || fieldset.querySelector('legend')?.textContent?.trim().slice(0, 30) || '__fs__')
      : '__nofield__';
    const key = rootId + '::' + r.name + '::' + fsKey;
    (radioGroups[key] = radioGroups[key] || []).push(r);
  });

  for (const radios of Object.values(radioGroups)) {
    // Skip groups where one radio is already selected
    if (radios.some(r => r.checked)) continue;

    const groupLabel = pjaGetGroupLabel(radios[0]);
    const key = pjaClassify(groupLabel);

    if (key && profile[key]) {
      if (pjaSelectRadio(radios, profile[key], key)) { filled++; continue; }
    }

    // Answer bank fallback for unclassified radio groups
    if (groupLabel.length > 3) {
      const norm = pjaNormalizeLabel(groupLabel);
      const banked = pjaFindBestAnswer(norm, answers);
      if (banked && pjaSelectRadio(radios, banked, key)) filled++;
    }
  }

  // Post-fill: re-set location/currentLocation fields without blur.
  // Lever clears autocomplete inputs on blur if no dropdown selection was made.
  // We set the value a second time after all other events have settled.
  if (profile.currentLocation || (profile.city && profile.state)) {
    const locVal = profile.currentLocation || [profile.city, profile.state].filter(Boolean).join(', ');
    pjaQueryAll('input[name="location"], input[id="location-input"], input[autocomplete="address-level2 address-level1"]')
      .filter(el => visible(el))
      .forEach(el => {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc?.set) desc.set.call(el, locVal); else el.value = locVal;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: locVal, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
  }

  return filled;
}

// ── AI-powered answer generation for unknown required text fields ──────────────
//
// Usage (called from content.js after pjaFillForm):
//   pjaFillUnknownTextFields(profile, answers, jobContext, onFilled)
//
// jobContext = { title, company }  — sourced from the current job sidebar data
// onFilled(count)                  — optional callback with number of newly filled fields
//
// The function:
//  1. Finds required text inputs and textareas that are still empty after pjaFillForm()
//  2. Skips fields whose labels classify to a known profile key (already handled above)
//  3. Skips fields that already have a banked answer (pjaFindBestAnswer)
//  4. Reads maxlength to calibrate answer length
//  5. Batches all remaining questions into ONE /answer-questions call
//  6. Fills the fields with the returned answers
//  7. The background handler persists answers into pja_answers automatically

function pjaFillUnknownTextFields(profile, answers, jobContext, onFilled) {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // Collect required, visible, unfilled text inputs and textareas
  // Includes both native [required] and [aria-required="true"] (Greenhouse uses aria-required)
  const candidates = pjaQueryAll(
    'input[required]:not([type=hidden]):not([type=submit]):not([type=button])' +
    ':not([type=file]):not([type=radio]):not([type=checkbox]):not([type=email])' +
    ':not([type=tel]):not([type=url]),' +
    'input[aria-required="true"]:not([type=hidden]):not([type=submit]):not([type=button])' +
    ':not([type=file]):not([type=radio]):not([type=checkbox]):not([type=email])' +
    ':not([type=tel]):not([type=url]),' +
    'textarea[required],textarea[aria-required="true"]'
  ).filter(el => visible(el) && !(el.value && el.value.trim()));

  const questions = [];
  const elMap = []; // parallel array to candidates — keeps reference to each element

  // Regex to detect multi-part date picker component fields (start/end month and year pickers).
  // These are form-structure components, not free-text questions; stale banked answers
  // (e.g., "July" or "2026") cause Greenhouse date validation errors.
  const DATE_COMPONENT_RE = /\b(start|end|begin|finish)\s+(date\s+)?(month|year)\b/i;

  for (const el of candidates) {
    const rawLabel = pjaGetLabel(el);
    if (!rawLabel || rawLabel.length < 4) { console.log('PJA autofill skip: short/empty label', rawLabel?.slice(0,40), el.name?.slice(0,30)); continue; }
    if (pjaIsGarbageLabel(rawLabel)) { console.log('PJA autofill skip: garbage label', rawLabel.slice(0,40)); continue; }

    // Skip start/end date month and year component fields — these are multi-part date
    // pickers, not free-text questions. Banked answers are stale and cause validation errors.
    if (DATE_COMPONENT_RE.test(rawLabel)) { continue; }

    // Skip if it maps to a profile key (profile data handles this, not AI)
    // EXCEPTION: textareas whose profile value is a bare number (e.g. yearsExperience="6")
    // need a sentence answer — let AI generate one.
    if (pjaClassify(rawLabel)) {
      if (el.tagName !== 'TEXTAREA') { console.log('PJA autofill skip: classified non-textarea', rawLabel.slice(0,40)); continue; }
      const classKey = pjaClassify(rawLabel);
      const pVal = profile[classKey];
      if (!pVal || !/^\d+$/.test(String(pVal).trim())) { console.log('PJA autofill skip: classified non-numeric', rawLabel.slice(0,40), classKey, pVal); continue; }
      // else: numeric profile val in a textarea → fall through to AI
      console.log('PJA autofill: numeric-textarea fallthrough to AI', rawLabel.slice(0,40), classKey, pVal);
    }

    // Skip if we already have a banked answer (pjaFillForm already tried but may have
    // missed due to score threshold — re-check here with a more lenient approach)
    const norm = pjaNormalizeLabel(rawLabel);
    const bankedAns = pjaFindBestAnswer(norm, answers);
    if (bankedAns) {
      // Field is empty but bank has an answer — fill it directly (pjaFillForm may have missed this)
      console.log('PJA autofill: filling from bank (AI skip)', rawLabel.slice(0,40), bankedAns.slice(0,30));
      pjaSetNative(el, bankedAns);
      continue;
    }

    // Read char limit from the DOM
    const maxLength = parseInt(el.getAttribute('maxlength') || el.getAttribute('maxLength') || '0', 10) || 0;

    // Determine field type
    const type = el.tagName === 'TEXTAREA' ? 'textarea' : 'text';

    questions.push({ label: rawLabel, type, maxLength: maxLength || null });
    elMap.push(el);
  }

  console.log('PJA autofill pjaFillUnknownTextFields: candidates', candidates.length, 'questions', questions.length, questions.map(q => q.label.slice(0,40)).join(' | '));
  if (questions.length === 0) {
    if (typeof onFilled === 'function') onFilled(0);
    return;
  }

  // Also include visible, unfilled <select> elements whose label is not classified —
  // the AI can pick the best option from the provided options list.
  const selectCandidates = pjaQueryAll('select[required], select[aria-required="true"]').filter(
    el => visible(el) && (!el.value || el.value === '' || el.selectedIndex <= 0)
  );
  for (const sel of selectCandidates) {
    const rawLabel = pjaGetLabel(sel);
    if (!rawLabel || rawLabel.length < 4) continue;
    if (pjaIsGarbageLabel(rawLabel)) continue;
    if (pjaClassify(rawLabel)) continue;
    const norm = pjaNormalizeLabel(rawLabel);
    if (pjaFindBestAnswer(norm, answers)) continue;
    const opts = Array.from(sel.options)
      .map(o => o.text.trim())
      .filter(t => t && !['select', 'please select', 'choose', '--'].includes(t.toLowerCase()));
    questions.push({ label: rawLabel, type: 'select', maxLength: null, options: opts });
    elMap.push(sel);
  }

  // Also include required radio groups not yet answered and not matched by pattern fallback.
  // Collect by fieldset (or by name attr) to avoid duplicate entries per group.
  const radioGroupsSeen = new Set();
  for (const r of pjaQueryAll(
    'input[type=radio][required], input[type=radio][aria-required="true"]'
  )) {
    if (!visible(r)) continue;
    const fs = r.closest('fieldset');
    const groupKey = fs || r.name || r.getAttribute('aria-labelledby') || '';
    if (!groupKey || radioGroupsSeen.has(groupKey)) continue;
    radioGroupsSeen.add(groupKey);

    // Skip if any radio in the group is already checked
    const name = r.name;
    const root = r.getRootNode() || document;
    if (name && root.querySelector(`input[type=radio][name="${CSS.escape(name)}"]:checked`)) continue;

    const legendText = (fs?.querySelector('legend')?.textContent || '').trim();
    if (!legendText || legendText.length < 4) continue;
    if (pjaIsGarbageLabel(legendText)) continue;

    const norm = pjaNormalizeLabel(legendText);
    if (pjaFindBestAnswer(norm, answers)) continue; // answer bank covers it

    const groupRadios = name
      ? Array.from(root.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`))
      : Array.from(fs?.querySelectorAll('input[type=radio]') || [r]);
    const opts = groupRadios.map(rb => {
      const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(rb) : rb.getAttribute('aria-label') || '').trim();
      return lbl || rb.value;
    }).filter(Boolean);
    if (!opts.length) continue;

    questions.push({ label: legendText, type: 'radio', maxLength: null, options: opts });
    elMap.push({ _radioGroup: groupRadios }); // sentinel object, not a DOM element
  }

  if (questions.length === 0) {
    if (typeof onFilled === 'function') onFilled(0);
    return;
  }

  // Send all questions in one batch to the background → dev server
  chrome.runtime.sendMessage(
    { type: 'ANSWER_QUESTIONS', payload: { questions, jobContext: jobContext || {} } },
    resp => {
      if (chrome.runtime.lastError || !resp?.success || !Array.isArray(resp.answers)) {
        if (typeof onFilled === 'function') onFilled(0);
        return;
      }

      let filled = 0;
      for (const { label, answer } of resp.answers) {
        if (!label || !answer) continue;

        // Match the returned label back to the DOM element
        const idx = questions.findIndex(q => q.label === label);
        if (idx === -1) continue;
        const el = elMap[idx];
        if (!el) continue;

        // Radio group sentinel: { _radioGroup: [...radios] }
        if (el._radioGroup) {
          const radios = el._radioGroup;
          if (radios.some(rb => rb.checked)) continue; // already answered
          const ansLower = answer.toLowerCase().trim();
          const target = radios.find(rb => {
            const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(rb) : rb.getAttribute('aria-label') || '').toLowerCase().trim();
            const val = (rb.value || '').toLowerCase();
            return lbl === ansLower || val === ansLower || lbl.startsWith(ansLower[0]) && ansLower.startsWith(lbl.slice(0,4));
          }) || radios.find(rb => {
            const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(rb) : rb.getAttribute('aria-label') || '').toLowerCase();
            return lbl.includes(ansLower) || ansLower.includes(lbl.replace(/\s+/g,'').slice(0,6));
          });
          if (target) { pjaClickRadio(target); filled++; }
          continue;
        }

        if (el.value && el.value.trim()) continue; // already filled by race (text/select)

        if (el.tagName === 'SELECT') {
          const ok = pjaFillSelect(el, answer, null);
          if (ok) filled++;
        } else {
          // Truncate to maxlength to avoid ATS validation errors
          const max = parseInt(el.getAttribute('maxlength') || '0', 10);
          const truncated = (max > 0 && answer.length > max) ? answer.slice(0, max) : answer;
          pjaFillTextViaFiber(el, truncated);
          filled++;
        }
      }

      if (typeof onFilled === 'function') onFilled(filled);
    }
  );
}

// Expose to other content scripts sharing the same page scope
window.pjaQueryAll = pjaQueryAll;
window.pjaGetById = pjaGetById;
window.pjaGetLabel = pjaGetLabel;
window.pjaClassify = pjaClassify;
window.pjaSetNative = pjaSetNative;
window.pjaFillSelect = pjaFillSelect;
window.pjaCommitSelect = pjaCommitSelect;
window.pjaNormalizeLabel = pjaNormalizeLabel;
window.pjaFuzzyScore = pjaFuzzyScore;
window.pjaFindBestAnswer = pjaFindBestAnswer;
window.pjaIsGarbageLabel = pjaIsGarbageLabel;
window.pjaIsApplicationPage = pjaIsApplicationPage;
window.pjaStartLearning = pjaStartLearning;
window.pjaStopLearning = pjaStopLearning;
window.pjaFillForm = pjaFillForm;
window.pjaFillUnknownTextFields = pjaFillUnknownTextFields;
window.pjaFillCombobox = pjaFillCombobox;
window.pjaFillGreenhouseEducation = pjaFillGreenhouseEducation;
window.pjaFillViaReactFiber = pjaFillViaReactFiber;

// Dedicated fixer for the Greenhouse "Country" react-select (a searchable 244-option select
// that the normal fill paths miss → country-error → submit blocked). Find the country combobox
// input by id/label and commit "United States" straight through the fiber bridge (reads all
// options from props, no typing/rendering needed). Also handles react-select structures where the
// input id differs from "country" by scanning for a country-labelled select__control.
async function pjaForceCountryField(value) {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  const val = value || 'United States';
  const cands = [];
  const byId = document.getElementById('country');
  if (byId) cands.push(byId);
  const roots = typeof pjaGetAllRoots === 'function' ? pjaGetAllRoots() : [document];
  for (const root of roots) {
    root.querySelectorAll('input[role="combobox"], .select__control input').forEach(inp => {
      if (cands.includes(inp)) return;
      const lblBy = inp.getAttribute('aria-labelledby');
      let label = lblBy ? (document.getElementById(lblBy.split(' ')[0])?.textContent || '') : '';
      if (!label) label = inp.getAttribute('aria-label') || '';
      if (!label) label = inp.closest('div')?.querySelector('label')?.textContent || '';
      if (/\bcountry\b/i.test(label) || /country/i.test(inp.id || '') || /country/i.test(inp.name || '')) cands.push(inp);
    });
  }
  let done = 0;
  for (const inp of cands) {
    // Skip intl-tel-input phone country pickers — those are handled by the phone filler.
    if (inp.closest('[class*="iti"], [class*="PhoneInput"]')) continue;
    const ctrl = inp.closest('[class*="select__control"]');
    const committed = () => { const sv = ctrl && ctrl.querySelector('[class*="single-value"],[class*="singleValue"]'); return !!(sv && sv.textContent && sv.textContent.trim() && !/^\s*select/i.test(sv.textContent)); };
    if (committed()) { done++; continue; }
    // NOTE: do NOT try the fiber onChange for country. On Greenhouse's "remix" build the fiber
    // onChange THROWS (or sets only the display single-value while the form value stays empty),
    // which fools committed() into skipping the real commit → country-error at submit. Go straight
    // to the trusted CDP click, which is the only thing that actually commits this react-select.
    if (ctrl) {
      // Greenhouse's newer "remix" react-select IGNORES synthetic option clicks — it commits
      // ONLY on a trusted (CDP) click, exactly like the school/degree/discipline fields. Open
      // the menu, find the "United States" option (labels here are dial-code style e.g.
      // "United States +1"), and CDP-click it at its coords. Verified live: synthetic clicks
      // leave single-value EMPTY; a CDP click commits.
      const cdpClick = (el) => new Promise(resolve => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        let fin = false;
        const to = setTimeout(() => { if (!fin) { fin = true; resolve('timeout'); } }, 3000);
        try { chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x, y }, (resp) => {
          if (fin) return; fin = true; clearTimeout(to);
          resolve(chrome.runtime.lastError || resp?.error ? 'fail' : 'cdp');
        }); } catch (_) { if (!fin) { fin = true; clearTimeout(to); resolve('catch'); } }
      });
      for (let attempt = 0; attempt < 2 && !committed(); attempt++) {
        inp.focus();
        ['mousedown','mouseup'].forEach(t => ctrl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: 1 })));
        await _sleep(450);
        let lb = document.getElementById('react-select-' + inp.id + '-listbox')
          || ctrl.parentElement?.querySelector('[role="listbox"]')
          || document.querySelector('[id^="react-select-"][id$="-listbox"]:not([hidden])');
        let opts = lb ? Array.from(lb.querySelectorAll('[role="option"]')) : [];
        // prefix match: value "United States" → option "United States +1"
        let m = opts.find(o => /^united states\b/i.test((o.textContent || '').trim()))
          || opts.find(o => /^united states$/i.test((o.textContent || '').trim()));
        if (m) { const how = await cdpClick(m); await _sleep(300);
          try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[country] cdp-click "'+(m.textContent||'').trim().slice(0,18)+'" via '+how+' committed='+committed()); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
        }
      }
      if (committed()) done++;
    }
  }
  return done;
}
window.pjaForceCountryField = pjaForceCountryField;

// Sweep ALL required Greenhouse policy react-selects (sponsorship, work-authorization, onsite,
// acknowledgments, etc.) and force-commit each with its honest deterministic answer via the fiber
// bridge (pjaFillViaReactFiber → fiber-main.js pja:reactselect). Verified live that the bridge
// commits these reliably; the normal collect→answer flow was intermittently NOT invoking it for
// question_* selects, so the form failed submit on question_*-error. This dedicated pass runs the
// bridge directly on every empty required select__control combobox that has a deterministic answer,
// so sponsorship/auth/onsite are ALWAYS committed. Returns the count committed.
async function pjaForceAllPolicyReactSelects(profile) {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  const det = (typeof window !== 'undefined' && window.pjaDeterministicAnswer) || null;
  const roots = typeof pjaGetAllRoots === 'function' ? pjaGetAllRoots() : [document];
  let committed = 0;
  const inputs = [];
  for (const root of roots) root.querySelectorAll('input[role="combobox"], .select__control input').forEach(i => { if (!inputs.includes(i)) inputs.push(i); });
  for (const inp of inputs) {
    const ctrl = inp.closest('[class*="select__control"]');
    if (!ctrl) continue;
    if (inp.closest('[class*="iti"], [class*="PhoneInput"]')) continue;       // phone country-code
    if (/^country$/i.test(inp.id || '')) continue;                            // country handled separately
    // NOTE: do NOT skip on a display single-value. The multi-pass fill can leave a STALE display
    // ("No" shown) while Formik's committed value was reset — so the form fails submit even though
    // it looks filled. Re-firing the bridge is idempotent and re-sets Formik's value fresh right
    // before submit, which is what actually matters for validation.
    // label: Greenhouse gives question_<id> a <label id="question_<id>-label">
    const sv = ctrl.querySelector('[class*="single-value"],[class*="singleValue"]');
    let label = '';
    if (inp.id) { const l = document.getElementById(inp.id + '-label') || document.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); if (l) label = l.textContent || ''; }
    if (!label) { const al = inp.getAttribute('aria-labelledby'); if (al) label = (document.getElementById(al.split(/\s+/)[0])?.textContent) || ''; }
    if (!label) { diag.cand.push({ id: (inp.id||'').slice(0,20), skip: 'nolabel' }); continue; }
    let ans = det ? det(label) : null;
    let isEdu = false;
    // Education react-selects (degree/discipline/school) — the discipline field is a recurring
    // Greenhouse blocker (renders late, gh-edu misses it). Commit from profile truth via the bridge.
    if (!ans && profile) {
      const L = ((label || '') + ' ' + (inp.id || '')).toLowerCase();
      if (/\bdegree\b/.test(L)) { ans = profile.degree; isEdu = true; }
      else if (/discipline|field of study|\bmajor\b/.test(L)) { ans = profile.major; isEdu = true; }
      else if (/\bschool\b|university|college|institution/.test(L)) { ans = profile.university; isEdu = true; }
    }
    try { const _cc = (ctrl.className||'').slice(0,40); chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[psweep] id='+String(inp.id||'').slice(0,18)+' ans="'+String(ans==null?'null':ans).slice(0,5)+'" remix='+/remix-css/.test(ctrl.className||'')+' cc='+_cc); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
    if (!ans) continue;                                                       // fixed-truth policy + education
    // Education fields: don't re-fire if already committed (re-opening could toggle the selection).
    if (isEdu) { const svc = ctrl.querySelector('[class*="single-value"],[class*="singleValue"]'); if (svc && svc.textContent && svc.textContent.trim() && !/^\s*select/i.test(svc.textContent)) continue; }
    // REMIX BUILD (Greenhouse "remix-css-*"): the fiber onChange sets ONLY the display single-value
    // — it does NOT persist Formik's validated value — so a fiber pre-fill produces a stale "Yes"
    // display that makes the ok-check pass while the form still fails submit on question_*-error.
    // The trusted CDP click (pjaForceReactSelectCommit) is the ONLY path that commits Formik on
    // remix. Detect remix by the control class and go straight to the forced CDP click, skipping
    // the fiber pre-fill entirely and ignoring any stale display.
    const isRemix = /remix-css/.test(ctrl.className || '');
    let ok;
    if (isRemix && typeof pjaForceReactSelectCommit === 'function') {
      try { ok = await pjaForceReactSelectCommit(inp, ans, { force: true }); } catch (_) { ok = false; }
    } else {
      // Non-remix react-selects commit via the fiber bridge (proven). Fall back to the UI forcer.
      try { if (typeof pjaFillViaReactFiber === 'function') pjaFillViaReactFiber(inp, ans, ''); } catch (_) {}
      await _sleep(200);
      ok = !!(ctrl.querySelector('[class*="single-value"],[class*="singleValue"]')?.textContent?.trim());
      if (!ok && typeof pjaForceReactSelectCommit === 'function') { try { ok = await pjaForceReactSelectCommit(inp, ans); } catch (_) {} }
    }
    if (ok) committed++;
  }
  return committed;
}
window.pjaForceAllPolicyReactSelects = pjaForceAllPolicyReactSelects;

// Generalized reliable react-select commit for ANY value (not just country). Mirrors
// pjaForceCountryField's proven path: try the fiber onChange, VERIFY the display committed
// (single-value present), and if not, drive the UI — open the menu, type the value to filter,
// then CLICK the matching option element. react-select searchable/custom question selects
// (Greenhouse "remix" build) commit reliably ONLY via a clicked option, not the fiber onChange
// alone (which fires but Formik doesn't persist). Returns true iff the value is committed.
async function pjaForceReactSelectCommit(input, value, opts) {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  if (!input) return false;
  const ctrl = input.closest('[class*="select__control"]');
  if (!ctrl) return false;
  const lv = String(value == null ? '' : value).toLowerCase().trim();
  if (!lv) return false;
  // force: on remix builds a stale fiber display makes committed() a false positive, so the caller
  // asks us to drive the trusted CDP click regardless of the current display state.
  const force = !!(opts && opts.force);
  const committed = () => { const sv = ctrl.querySelector('[class*="single-value"],[class*="singleValue"]'); return !!(sv && sv.textContent && sv.textContent.trim() && !/^\s*select/i.test(sv.textContent)); };
  if (!force && committed()) return true;
  // NOTE: skip the fiber onChange — on Greenhouse's remix build it throws or only sets the
  // display (fooling committed()); the option must be committed with a trusted CDP click below.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  // Greenhouse remix react-selects commit ONLY on a trusted (CDP) click — synthetic option
  // clicks are ignored (verified live). Click the matched option element at its coords via CDP.
  const cdpClickOpt = (el) => new Promise(resolve => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let fin = false;
    const to = setTimeout(() => { if (!fin) { fin = true; resolve('timeout'); } }, 3000);
    try { chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x, y }, (resp) => {
      if (fin) return; fin = true; clearTimeout(to);
      resolve(chrome.runtime.lastError || resp?.error ? 'fail' : 'cdp');
    }); } catch (_) { if (!fin) { fin = true; clearTimeout(to); resolve('catch'); } }
  });
  const findOpt = () => {
    // The react-select input id (e.g. "react-select-N-input") does NOT map cleanly to its listbox
    // id, and the Export Control select's listbox id differs from the input id — so search ALL
    // currently-open listboxes (across shadow roots) and match the option there. Exclude the
    // intl-tel-input country-code and the Places location listboxes.
    const roots = typeof pjaGetAllRoots === 'function' ? pjaGetAllRoots() : [document];
    let opts = [];
    for (const root of roots) {
      root.querySelectorAll('[role="listbox"]:not([hidden]):not([id*="iti"]), [id^="react-select-"][id$="-listbox"]:not([hidden])').forEach(lb => {
        if (/pac-|places/i.test(lb.className || '')) return;
        opts = opts.concat(Array.from(lb.querySelectorAll('[role="option"]')));
      });
    }
    const lead = lv.match(/^(yes|no)\b/);
    return opts.find(o => (o.textContent || '').trim().toLowerCase() === lv)
      || (lead && opts.find(o => new RegExp('^' + lead[1] + '\\b', 'i').test((o.textContent || '').trim())))
      || (lv.length > 2 && opts.find(o => (o.textContent || '').toLowerCase().includes(lv)))
      || null;
  };
  // When forced, committed() is an unreliable stop signal (stale display), so gate on a real CDP
  // click landing (clicked=true) instead; otherwise stop as soon as the display commits.
  let clicked = false;
  for (let attempt = 0; attempt < 2 && (force ? !clicked : !committed()); attempt++) {
    input.focus();
    ['mousedown', 'mouseup'].forEach(t => ctrl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 })));
    await _sleep(150);
    // Type the value to filter (searchable lists); harmless when isSearchable is false.
    if (setter) { setter.call(input, String(value)); input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' })); }
    await _sleep(550);
    let m = findOpt();
    if (!m) { // typed filter may have hidden a short option (e.g. "Yes" vs a typed sentence) — clear + reopen
      if (setter) { setter.call(input, ''); input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
      await _sleep(300); m = findOpt();
    }
    let how = 'noopt';
    if (m) { how = await cdpClickOpt(m); if (how === 'cdp') clicked = true; }
    else { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); }
    await _sleep(300);
    try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[frs] id='+String(input.id||'').slice(0,18)+' val="'+String(value).slice(0,6)+'" opt='+(m?'Y':'N')+' via='+how+' committed='+committed()); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
  }
  return force ? clicked : committed();
}
window.pjaForceReactSelectCommit = pjaForceReactSelectCommit;
window.pjaFillTextViaFiber = pjaFillTextViaFiber;
window.pjaFillViaFiberOnChange = pjaFillViaFiberOnChange;
window.pjaClickRadio = pjaClickRadio;
window.pjaSelectRadio = pjaSelectRadio;
window.pjaFindRequiredCheckboxGroups = pjaFindRequiredCheckboxGroups;
window.pjaCheckMatchingBox = pjaCheckMatchingBox;
window.pjaGetGroupLabel = pjaGetGroupLabel;
window.pjaFillRequiredRadioFallback = typeof pjaFillRequiredRadioFallback !== 'undefined' ? pjaFillRequiredRadioFallback : undefined;
window.PJA_FIELD_RULES = PJA_FIELD_RULES;
window.PJA_DEFAULT_PROFILE = PJA_DEFAULT_PROFILE;
window.PJA_FIELD_VALIDATORS = PJA_FIELD_VALIDATORS;
})();
