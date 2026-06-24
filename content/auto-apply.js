'use strict';

// ── Auto-Apply Engine ────────────────────────────────────────────────────────
// Scans LinkedIn job search results for "Top applicant" or match badges,
// then steps through each Easy Apply modal using the existing pjaFillForm engine.

const PJA_AUTO_STATE = { running: false, aborted: false };

// ISSUE-2 — LinkedIn gates the Easy Apply *open* click against automation, but not
// the modal fill/step-through. When our synthetic click can't open the modal, fall
// back to assisted mode: prompt the user to click "Easy Apply" once, keep retrying
// our own click, and take over the moment the modal appears.
const PJA_EA_ASSISTED = true;            // (legacy) keep assisted fallback available
const PJA_EA_ASSIST_TIMEOUT_MS = 300000; // how long to wait for the user to open the modal (5 min)
const PJA_EA_DRY_RUN = false;            // TEST MODE: stop right after modal opens (no fill)
// AUTO mode + auto-submit: required for backend/autonomous triggering (no human to click Easy
// Apply or Submit). Works now that the extension's own CDP is free (no claude-in-chrome driving
// the tab). For manual SEMI use, set PJA_EA_AUTO_OPEN=false.
const PJA_EA_AUTO_OPEN = true;           // true = extension clicks Easy Apply itself (AUTO)
const PJA_EA_STOP_BEFORE_SUBMIT = false; // false = fill, step, AND submit (auto-submit authorized)

// Search URL: Bay Area · Easy Apply · past month · quality roles
const PJA_AUTO_SEARCH_URL =
  'https://www.linkedin.com/jobs/search/?keywords=quality%20technician%20quality%20engineer&f_AL=true&location=San%20Francisco%20Bay%20Area&geoId=90000084&f_TPR=r2592000';

function pjaAutoWait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Modal detection ──────────────────────────────────────────────────────────

function pjaGetCurrentModal() {
  // On search pages, modal is in regular DOM
  const regular = document.querySelector('.jobs-easy-apply-modal');
  if (regular) return { root: regular, isShadow: false };

  // On job view pages, modal appears inside interop-outlet shadow root.
  // artdeco-modal-outlet and hue-web-modal-outlet are the containers.
  const outlet = document.getElementById('interop-outlet');
  if (outlet?.shadowRoot) {
    const sr = outlet.shadowRoot;
    // Check artdeco modal outlet first (most common for Easy Apply)
    const artdeco = sr.querySelector('#artdeco-modal-outlet');
    if (artdeco?.querySelector('[role="dialog"]')) return { root: artdeco, isShadow: true };
    const hue = sr.querySelector('#hue-web-modal-outlet');
    if (hue?.querySelector('[role="dialog"]')) return { root: hue, isShadow: true };
    // Generic fallback
    const d = sr.querySelector('[role="dialog"], .jobs-easy-apply-modal');
    if (d) return { root: sr, isShadow: true };
  }

  return null;
}

function pjaModalHeading() {
  const m = pjaGetCurrentModal();
  if (!m) return null;
  return m.root.querySelector('h3')?.textContent?.trim() || null;
}

// Robust button-ELEMENT collector. The Easy Apply footer (Next/Review/Submit) can render just
// OUTSIDE the narrow modal root (a separate footer container), which made the old m.root-only
// scan return [] even though the heading read fine → false 'unknown_buttons'. Widen to the full
// [role=dialog] (header+content+footer) and, in shadow modals, the whole shadow root. Deduped.
function pjaModalButtonEls() {
  const m = pjaGetCurrentModal();
  if (!m) return [];
  const r = m.root;
  // PREFER the actual [role=dialog] element — scanning the whole shadow root pulled in page-level
  // controls (LinkedIn's "Messaging" widget, a page "Next"), and clicking the wrong "Next"
  // navigated the page → reload loop (open_loop_skip). The dialog excludes those.
  let dialog = (r.querySelector && r.querySelector('[role="dialog"]'))
    || (r.closest && r.closest('[role="dialog"]'))
    || (r.matches && r.matches('[role="dialog"]') ? r : null);
  if (dialog) {
    const b = Array.from(dialog.querySelectorAll('button'));
    if (b.length) return b;
  }
  // Fallback (footer mounted outside the dialog, or no dialog): widen to root then shadow root.
  const scopes = [r];
  if (m.isShadow) { const o = document.getElementById('interop-outlet'); if (o && o.shadowRoot) scopes.push(o.shadowRoot); }
  const seen = new Set(); const out = [];
  for (const sc of scopes) {
    if (!sc.querySelectorAll) continue;
    for (const b of sc.querySelectorAll('button')) { if (!seen.has(b)) { seen.add(b); out.push(b); } }
  }
  return out;
}
function pjaModalBtns() {
  const seen = new Set(); const out = [];
  for (const b of pjaModalButtonEls()) {
    const t = (b.textContent || '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Classify the current Easy Apply modal state — used for mid-refresh resilience: if LinkedIn
// reloads mid-flow and the modal comes back showing a post-submit confirmation, we must record
// success and NOT click Submit again (double-submit guard). Pure-ish (reads the given modal root).
function pjaEasyApplyState(modal) {
  if (!modal || !modal.root) return { open: false, success: false, submitReady: false, heading: '' };
  const root = modal.root;
  const heading = (root.querySelector('h3, h2')?.textContent || '').trim();
  const text = (root.textContent || '');
  const btns = Array.from(root.querySelectorAll('button')).map(b => (b.textContent || '').trim());
  const success = /application sent|your application was sent|application submitted|done!|premium career/i.test(text)
    || /sent|submitted|success|thank/i.test(heading);
  const submitReady = btns.some(b => /^submit application$/i.test(b));
  return { open: true, success, submitReady, heading, buttons: btns };
}

function pjaClickInModal(label) {
  const m = pjaGetCurrentModal();
  if (!m) return false;
  const btns = pjaModalButtonEls(); // robust scope (incl footer / shadow)
  const btn = btns.find(b => b.textContent.trim() === label)
    || btns.find(b => (b.getAttribute('aria-label') || '').trim() === label)
    || btns.find(b => new RegExp('^' + label, 'i').test(b.textContent.trim()));
  if (!btn) return false;
  btn.click();
  return true;
}

// LinkedIn checks isTrusted on Easy Apply step-advance clicks — a synthetic click
// (.click()/dispatchEvent) makes the page reload. Route step clicks through the
// background CDP trusted-click (real isTrusted=true mouse event). Falls back to a
// synthetic click if the message round-trip fails. Returns true if the label exists.
function pjaTrustedClickInModal(label) {
  const m = pjaGetCurrentModal();
  if (!m) return Promise.resolve(false);
  const btns = pjaModalButtonEls(); // robust scope (incl footer / shadow), not just m.root
  const btn = btns.find(b => b.textContent.trim() === label)
    || btns.find(b => (b.getAttribute('aria-label') || '').trim() === label)
    || btns.find(b => new RegExp('^' + label, 'i').test(b.textContent.trim()));
  if (!btn) return Promise.resolve(false);
  // Compute the button's viewport-center coords HERE (content script sees shadow DOM);
  // the background just performs a trusted CDP mouse click at those coords.
  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; pjaTrace('CDP timeout→synthetic ' + label); pjaClickInModal(label); resolve(true); } }, 4000);
    try {
      chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x, y }, (resp) => {
        if (done) return;
        done = true; clearTimeout(t);
        if (chrome.runtime.lastError || resp?.error) { pjaTrace('CDP fail→synthetic ' + label + ' err=' + (resp?.error || chrome.runtime.lastError?.message || '')); pjaClickInModal(label); }
        else { pjaTrace('CDP click ok ' + label); }
        resolve(true);
      });
    } catch (_) { if (!done) { done = true; clearTimeout(t); pjaClickInModal(label); resolve(true); } }
  });
}

function pjaDismissModal() {
  // Try modal dismiss button, then Discard confirmation
  const outlet = document.getElementById('interop-outlet');
  const sr = outlet?.shadowRoot;
  const dismissBtn = sr
    ? sr.querySelector('button[aria-label="Dismiss"]')
    : document.querySelector('button[aria-label="Dismiss"], .artdeco-modal__dismiss');
  dismissBtn?.click();

  setTimeout(() => {
    const discard = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === 'Discard');
    discard?.click();
  }, 600);
}

// ── Required-field check ─────────────────────────────────────────────────────

function pjaEmptyRequiredFields() {
  const m = pjaGetCurrentModal();
  if (!m) return [];
  const root = m.root;
  const empty = [];

  // Text / select / textarea
  for (const el of root.querySelectorAll(
    'input:not([type=hidden]):not([type=radio]):not([type=checkbox]),select,textarea'
  )) {
    const required = el.required || el.getAttribute('aria-required') === 'true';
    if (!required) continue;
    const val = el.value?.trim();
    if (!val || val === 'Select an option' || val === 'None') {
      // Use pjaGetLabel (from autofill.js, same isolated world) for best label extraction
      const label = (typeof pjaGetLabel === 'function' ? pjaGetLabel(el) : '')
        || el.getAttribute('aria-label') || el.placeholder || el.name || '(field)';
      empty.push(label.replace(/\s+/g, ' ').slice(0, 60));
    }
  }

  // Required radio groups — fieldset where no radio is checked
  for (const fs of root.querySelectorAll('fieldset')) {
    const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
    if (!radios.length) continue;
    const anyRequired =
      fs.getAttribute('aria-required') === 'true' ||
      radios.some(r => r.required || r.getAttribute('aria-required') === 'true');
    if (anyRequired && !radios.some(r => r.checked)) {
      const legend = fs.querySelector('legend')
        ?.textContent?.trim()?.replace(/\s+/g, ' ')?.slice(0, 50) || '(radio group)';
      empty.push(legend);
    }
  }

  // Required checkboxes that are unchecked
  for (const cb of root.querySelectorAll('input[type=checkbox]')) {
    const required = cb.required || cb.getAttribute('aria-required') === 'true';
    if (!required || cb.checked) continue;
    const label = (typeof pjaGetLabel === 'function' ? pjaGetLabel(cb) : '')
      || cb.getAttribute('aria-label') || cb.name || '(checkbox)';
    empty.push(label.replace(/\s+/g, ' ').slice(0, 60));
  }

  return empty;
}

// ── Job card scanning ────────────────────────────────────────────────────────

// Returns all job cards on the page (id + title + company)
function pjaGetAllCards() {
  const cards = Array.from(document.querySelectorAll(
    '.job-card-container, [data-job-id]'
  ));
  const seen = new Set();
  const out = [];
  for (const card of cards) {
    const link = card.querySelector('a[href*="/jobs/view/"]');
    const jobId = link?.href?.match(/\/jobs\/view\/(\d+)/)?.[1];
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    const title = card.querySelector('strong, .job-card-list__title')
      ?.textContent?.trim()
      || Array.from(card.querySelectorAll('[class*="title"]'))
           .find(el => !el.children.length)?.textContent?.trim()
      || 'Unknown';
    const company = card.querySelector(
      '[class*="primary-description"],[class*="subtitle"],[class*="company"]'
    )?.textContent?.trim() || '';
    out.push({ jobId, title, company, card });
  }
  return out;
}

// Reads the currently visible job detail panel for match indicators
function pjaReadDetailBadge() {
  const detailText = document.body?.innerText || '';
  if (/top applicant/i.test(detailText)) return 'Top Applicant';
  if (/strong match|great match|good match|high match|your fit/i.test(detailText)) return 'High Match';
  return null;
}

// Async deep scan: clicks each card, waits for detail panel, checks for badge
// onCardChecked(checked, total, title) — progress callback
async function pjaScanQualifyingJobsAsync(onCardChecked) {
  const allCards = pjaGetAllCards();
  const qualifying = [];

  for (let i = 0; i < allCards.length; i++) {
    const { jobId, title, company, card } = allCards[i];
    onCardChecked?.(i + 1, allCards.length, title);

    // Click the card link to load detail panel
    const link = card.querySelector('a[href*="/jobs/view/"]');
    link?.click();
    await pjaAutoWait(1800); // wait for detail panel

    const badge = pjaReadDetailBadge();
    if (badge) {
      qualifying.push({ jobId, title, company, badge });
    }
  }

  return qualifying;
}

// Keep the sync version as a quick check (uses card-level text only, less reliable)
function pjaScanQualifyingJobs() {
  return pjaGetAllCards().filter(({ card }) => {
    const t = card.textContent || '';
    return /top applicant|good match|strong match|great match|high match/i.test(t);
  }).map(({ jobId, title, company, card }) => {
    const t = card.textContent || '';
    const badge = /top applicant/i.test(t) ? 'Top Applicant' : 'High Match';
    return { jobId, title, company, badge };
  });
}

// ── Fallback radio fill ──────────────────────────────────────────────────────
// For required radio groups that pjaFillForm couldn't match to profile/answers,
// apply sensible defaults based on the question text.

function pjaFillRequiredRadioFallback() {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages

  for (const fs of root.querySelectorAll('fieldset')) {
    const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
    if (!radios.length) continue;
    if (radios.some(r => r.checked)) continue; // already answered

    const anyRequired = fs.getAttribute('aria-required') === 'true' ||
      radios.some(r => r.required || r.getAttribute('aria-required') === 'true');
    if (!anyRequired) continue;

    const legendText = (fs.querySelector('legend')?.textContent || '').toLowerCase();

    let defaultVal = null;
    if (/certif|licens|accreditat|credential|qualification/i.test(legendText)) {
      defaultVal = 'Yes'; // the candidate has ASQ/quality certifications and 6yrs quality experience
    } else if (/background check|drug test|drug screen/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/authorize|authorized|eligible|legally|legal right/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/relocat/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/sponsor/i.test(legendText)) {
      defaultVal = 'No';
    } else if (/commut|onsite|on-site|on site|in.person|report to.*office|work.*office|hybrid/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/willing|able|available|comfortable|open to/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/experience.*suppli|suppli.*audit|audit.*suppli/i.test(legendText)) {
      defaultVal = 'Yes'; // Supplier auditing experience
    } else if (/experience.*quality|quality.*experience|quality.*background/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/bachelor|degree|diploma|education/i.test(legendText)) {
      defaultVal = 'Yes'; // the candidate has equivalent education/experience
    } else if (/currently.*employ|actively.*look|full.time|part.time|intern/i.test(legendText)) {
      defaultVal = 'Yes';
    } else if (/as9100|iso.*900|iatf|gmp|fda|21 cfr|medical device/i.test(legendText)) {
      defaultVal = 'Yes'; // Quality systems knowledge (quality background)
    }

    if (!defaultVal) {
      // Work authorization category radios (U.S. Citizen / Green Card / Temporary / Other)
      // the candidate is on TN Visa = Temporary Employment Authorization
      const labelsAndVals = radios.map(r => {
        const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : r.getAttribute('aria-label') || '').toLowerCase();
        return (r.value || '').toLowerCase() + ' ' + lbl;
      });
      const hasAuthCategory = labelsAndVals.some(t => /citizen|green card|permanent resident|temporary/i.test(t));
      if (hasAuthCategory && /authoriz|work permit|visa/i.test(legendText)) {
        // Find the Temporary Employment Authorization option
        const tempIdx = labelsAndVals.findIndex(t => /temporary|work permit|tn visa|tn\b/i.test(t));
        if (tempIdx !== -1) { pjaClickRadio(radios[tempIdx]); continue; }
      }
    }
    if (!defaultVal) {
      // Last resort: if radios are Yes/No, default Yes for unfilled required groups
      const vals = radios.map(r => r.value?.toLowerCase());
      if (vals.includes('yes') && vals.includes('no')) defaultVal = 'Yes';
    }
    if (!defaultVal) continue;

    // Match by value string, then by boolean (Greenhouse uses true/false), then by label text
    const dv = defaultVal.toLowerCase();
    const target = radios.find(r => r.value?.toLowerCase() === dv)
      || radios.find(r => r.value?.toLowerCase().startsWith(dv[0]))
      || (dv === 'yes' ? radios.find(r => r.value === 'true' || r.value === '1') : null)
      || (dv === 'no'  ? radios.find(r => r.value === 'false' || r.value === '0') : null)
      || radios.find(r => {
        const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(r) : r.getAttribute('aria-label') || '').toLowerCase().trim();
        return lbl === dv || lbl.startsWith(dv[0]);
      });
    if (target) pjaClickRadio(target);
  }
}

// Fill required empty SELECT fields that have Yes/No options but weren't matched by pjaFillForm.
// LinkedIn uses fb-dash-form-element containers where the question text is a sibling div — now
// handled by pjaGetLabel, but this provides a final safety net.
function pjaFillRequiredSelectFallback() {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages

  for (const sel of root.querySelectorAll('select')) {
    const req = sel.required || sel.getAttribute('aria-required') === 'true';
    if (!req) continue;
    if (sel.value && sel.value !== 'Select an option' && sel.value !== '') continue;

    // Get label first (needed for both proficiency and yes/no routing)
    const labelText = (typeof pjaGetLabel === 'function' ? pjaGetLabel(sel) : '') || '';

    // Work authorization category selects (U.S. Citizen / Green Card / Temporary / Other)
    // the candidate is on TN Visa = Temporary Employment Authorization
    const opts = Array.from(sel.options);
    const hasAuthCategory = opts.some(o => /citizen|green card|permanent resident|temporary employment/i.test(o.text));
    if (hasAuthCategory && /authoriz|work permit|visa|basis/i.test(labelText)) {
      const tempOpt = opts.find(o => /temporary/i.test(o.text));
      if (tempOpt) { pjaCommitSelect(sel, tempOpt.value); continue; }
    }

    // Language proficiency selects (options: None/Basic/Intermediate/Advanced/Fluent/Native)
    const hasProficiencyOpts = opts.some(o => /\b(none|basic|intermediate|advanced|fluent|native|bilingual)\b/i.test(o.text));
    if (hasProficiencyOpts) {
      // English → Native; anything else → None
      const isEnglish = /\benglish\b/i.test(labelText);
      const targetText = isEnglish ? /native|bilingual|fluent/i : /^none$/i;
      const profTarget = opts.find(o => targetText.test(o.text.trim()));
      if (profTarget) { pjaCommitSelect(sel, profTarget.value); continue; }
    }

    // Must have Yes and No options for the rest
    const yesOpt = opts.find(o => /^yes$/i.test(o.text.trim()) || /^yes$/i.test(o.value.trim()));
    const noOpt  = opts.find(o => /^no$/i.test(o.text.trim())  || /^no$/i.test(o.value.trim()));
    if (!yesOpt) continue;

    let fillVal = 'Yes'; // safe default for most quality/experience questions
    if (/food.*mfg|regulated.*mfg|aseptic|sterile|diploma.*process|process.*cert|process.*oper/i.test(labelText)) {
      fillVal = 'No'; // specific pharma/food cert the candidate doesn't have
    } else if (/citizen|green card|permanent resident/i.test(labelText)) {
      fillVal = 'No'; // TN visa, not citizen/GC
    } else if (/passport|travel/i.test(labelText)) {
      fillVal = 'Yes'; // the candidate has a passport
    }

    const target = fillVal === 'Yes' ? yesOpt : noOpt;
    if (target) pjaCommitSelect(sel, target.value);
  }
}

// Auto-check consent/acknowledgment checkboxes (e.g. "I understand that AI tools may be used")
function pjaAutoCheckConsent() {
  const m = pjaGetCurrentModal();
  const root = m ? m.root : document; // fall back to document on Greenhouse pages
  for (const cb of root.querySelectorAll('input[type=checkbox]')) {
    if (cb.checked) continue;
    const lbl = (typeof pjaGetLabel === 'function' ? pjaGetLabel(cb) : '')
      || cb.getAttribute('aria-label')
      || cb.closest('label')?.textContent?.toLowerCase()
      || '';
    if (/\bi (understand|acknowledge|agree|accept|confirm|consent|certify|attest|authorize)\b|i have read|certify that|to the best of my knowledge|terms and conditions|privacy policy|eeo|equal opportunity|background check consent|data.*(processing|privacy)|gdpr|ai tool|automated/i.test(lbl)) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  }
}

// Fill required comboboxes (role=combobox) that are still empty after all other passes.
// Handles Yes/No questions and number-of-years questions that fall through pjaFillForm
// because they are type=number or unlabeled comboboxes.
function pjaFillRequiredComboboxFallback(profile, answers) {
  const visible = el => !!el.offsetParent;
  // SCOPE to the Easy Apply modal — scanning document-wide previously filled LinkedIn's own
  // search bar (jobs-search-box-keyword/location), which triggers a search and CLOSES the modal
  // mid-flow (root cause of false unknown_buttons/modal_closed). On non-EA (Greenhouse) callers
  // there's no modal, so fall back to document.
  const _m = (typeof pjaGetCurrentModal === 'function') ? pjaGetCurrentModal() : null;
  const scope = _m ? ((_m.root.querySelector && _m.root.querySelector('[role="dialog"]')) || _m.root) : document;
  // Include ALL visible empty role=combobox inputs (not just [required] ones) — Greenhouse/Lever
  // often mark required on a wrapper, not the input. Filling is still gated below by label
  // patterns / answer-bank, so unmatched comboboxes (country, "how did you hear") are left alone.
  const combos = Array.from(scope.querySelectorAll(
    'input[role=combobox], input[required][list], input[aria-required="true"][list]'
  )).filter(el => visible(el) && !(el.value && el.value.trim())
    && !/^jobs-search-box/.test(el.id || '')); // never touch the page search bar

  for (const el of combos) {
    // Education dropdowns (School/Degree/Discipline) are handled by pjaFillGreenhouseEducation
    // with the actual profile values. Skip them here so the Yes/No pattern below doesn't
    // wrongly stuff "Yes" into the Degree field (the /degree/ pattern matched "Degree*").
    if (/^(school|degree|discipline)(--\d+)?$/.test(el.id || '')) continue;
    const rawLabel = (typeof pjaGetLabel === 'function' ? pjaGetLabel(el) : '') || el.getAttribute('aria-label') || '';
    if (!rawLabel) continue;
    if (/^(school|degree|discipline)\s*\*?$/i.test(rawLabel.trim())) continue;
    const norm = (typeof pjaNormalizeLabel === 'function') ? pjaNormalizeLabel(rawLabel) : rawLabel.toLowerCase();

    // Try answer bank first (short answers only — long sentences won't match combobox options)
    if (typeof pjaFindBestAnswer === 'function') {
      const banked = pjaFindBestAnswer(norm, answers);
      if (banked && banked.length <= 20) {
        if (typeof pjaFillCombobox === 'function') pjaFillCombobox(el, banked);
        continue;
      }
    }

    // Pattern-based Yes/No for common questions
    let val = null;
    if (/sponsor/i.test(rawLabel)) val = 'No';
    else if (/authoriz|eligible|legally|legal right|work.*permit/i.test(rawLabel)) val = 'Yes';
    else if (/onsite|on-site|in.person|commut|report.*office|hybrid/i.test(rawLabel)) val = 'Yes';
    else if (/willing|able|available|comfortable|open to|travel/i.test(rawLabel)) val = 'Yes';
    else if (/background check|drug test/i.test(rawLabel)) val = 'Yes';
    else if (/reloca/i.test(rawLabel)) val = 'Yes';
    else if (/certif|licens|degree|bachelor|diploma/i.test(rawLabel)) val = 'Yes';
    else if (/years.*experience|experience.*years/i.test(rawLabel)) {
      val = (profile && profile.yearsExperience) ? String(profile.yearsExperience) : '6';
    }

    if (val && typeof pjaFillCombobox === 'function') pjaFillCombobox(el, val);
  }
}

// ── Single-job apply ─────────────────────────────────────────────────────────

async function pjaAutoApplyOne(job, profile, answers, onStatus) {
  const { jobId, title } = job;

  // Select the card
  onStatus(`Selecting: ${title}…`);
  const link = document.querySelector(`a[href*="/jobs/view/${jobId}"]`);
  if (!link) return { success: false, reason: 'card_not_found' };
  link.click();
  await pjaAutoWait(2000);

  // Find & click Easy Apply
  const applyBtn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.trim().endsWith('Easy Apply') &&
               b.className?.includes('jobs-apply-button'));
  if (!applyBtn) return { success: false, reason: 'no_easy_apply' };
  applyBtn.click();
  await pjaAutoWait(1500);

  // Step through the modal
  const MAX_STEPS = 15;
  let prevHeading = null;
  let sameHeadingCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };

    const modal = pjaGetCurrentModal();
    if (!modal) return { success: false, reason: 'modal_closed' };

    // Mid-refresh double-submit guard (same as pjaApplyOnCurrentPage).
    const eaSt = pjaEasyApplyState(modal);
    if (eaSt.success) { pjaDismissModal(); return { success: true, reason: 'applied_resumed' }; }

    const heading = pjaModalHeading() || `Step ${step + 1}`;
    onStatus(`${title}: ${heading}…`);

    // Detect stuck (same heading after trying to advance)
    if (heading === prevHeading) {
      sameHeadingCount++;
      if (sameHeadingCount >= 2) {
        const emptyFields = pjaEmptyRequiredFields();
        pjaDismissModal();
        return {
          success: false,
          reason: 'stuck',
          heading,
          fields: emptyFields
        };
      }
    } else {
      sameHeadingCount = 0;
    }
    prevHeading = heading;

    // Skip resume step — just click Next
    const isResumeStep = /resume/i.test(heading);

    if (!isResumeStep) {
      // Run autofill
      pjaFillForm(profile, answers);
      await pjaAutoWait(600);
      // Fallback pass: fill any required radio groups / comboboxes autofill missed
      pjaFillRequiredRadioFallback();
      if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
      // Auto-check consent/acknowledgment checkboxes
      pjaAutoCheckConsent();
      // Reuse the SAME AI answerer used by external-apply, scoped to this modal, for screening
      // questions (years, work-auth, US-person, education, checkbox-groups, etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') {
        const m2 = pjaGetCurrentModal();
        if (m2) { try { await window.pjaAnswerRequiredViaAI(job, m2.root); } catch (_) {} await pjaAutoWait(700); }
      }
    }

    const btns = pjaModalBtns();

    if (btns.includes('Submit application')) {
      pjaClickInModal('Submit application');
      await pjaAutoWait(2500);
      // Dismiss LinkedIn's post-apply "Update profile" / "Not now" dialog
      const notNow = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Not now');
      if (notNow) {
        notNow.click();
        await pjaAutoWait(500);
      } else {
        const stillOpen = pjaGetCurrentModal();
        if (stillOpen) {
          const h = pjaModalHeading() || '';
          if (!/sent|submitted|success|thank|confirmed/i.test(h)) {
            const emptyFields = pjaEmptyRequiredFields();
            if (emptyFields.length) {
              pjaDismissModal();
              return { success: false, reason: 'submit_blocked', fields: emptyFields };
            }
          }
          pjaDismissModal();
        }
      }
      return { success: true };
    }

    // Check for unfillable required fields before advancing
    if (!isResumeStep) {
      const emptyFields = pjaEmptyRequiredFields();
      if (emptyFields.length) {
        pjaDismissModal();
        return { success: false, reason: 'missing_required', fields: emptyFields };
      }
    }

    if (btns.includes('Review')) {
      pjaClickInModal('Review');
    } else if (btns.includes('Next')) {
      pjaClickInModal('Next');
    } else if (btns.includes('Continue to next step')) {
      pjaClickInModal('Continue to next step');
    } else {
      pjaDismissModal();
      return { success: false, reason: 'unknown_buttons', btns };
    }

    await pjaAutoWait(1200);
  }

  pjaDismissModal();
  return { success: false, reason: 'too_many_steps' };
}

// ── Batch apply ──────────────────────────────────────────────────────────────

async function pjaAutoApplyBatch(jobs, profile, answers, onProgress, onDone) {
  PJA_AUTO_STATE.running = true;
  PJA_AUTO_STATE.aborted = false;

  const results = { applied: [], skipped: [], errors: [] };

  for (let i = 0; i < jobs.length; i++) {
    if (PJA_AUTO_STATE.aborted) break;

    const job = jobs[i];
    onProgress({ current: i + 1, total: jobs.length, jobTitle: job.title, results });

    try {
      const result = await pjaAutoApplyOne(
        job, profile, answers,
        msg => onProgress({
          current: i + 1, total: jobs.length,
          jobTitle: job.title, status: msg, results
        })
      );

      if (result.success) {
        results.applied.push(job);
        // Save to pipeline as Applied
        chrome.runtime.sendMessage({
          type: 'SAVE_JOB',
          payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title,
            company: job.company,
            description: '',
            status: 'Applied',
            savedAt: Date.now(),
            statusUpdatedAt: Date.now(),
            reminderDismissed: false
          }
        });
      } else if (result.reason === 'aborted') {
        break;
      } else {
        const skipReason = result.fields?.length
          ? `Missing: ${result.fields.slice(0, 2).join(', ')}`
          : result.reason;
        const skippedJob = { ...job, skipReason, missingFields: result.fields || [] };
        results.skipped.push(skippedJob);
        // Save to pipeline as Needs Info so the user can review and retry
        chrome.runtime.sendMessage({
          type: 'SAVE_JOB',
          payload: {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            url: `https://www.linkedin.com/jobs/view/${job.jobId}/`,
            title: job.title,
            company: job.company,
            description: result.fields?.length
              ? 'Missing required fields: ' + result.fields.join('; ')
              : 'Skip reason: ' + result.reason,
            missingFields: result.fields || [],
            skipReason,
            status: 'Needs Info',
            savedAt: Date.now(),
            statusUpdatedAt: Date.now(),
            reminderDismissed: false
          }
        });
      }
    } catch (err) {
      results.errors.push({ ...job, error: err.message });
    }

    // Rate-limit between jobs (3–5s)
    if (i < jobs.length - 1 && !PJA_AUTO_STATE.aborted) {
      await pjaAutoWait(3000 + Math.random() * 2000);
    }
  }

  PJA_AUTO_STATE.running = false;
  onDone(results);
}

// Click the Easy Apply control. For an <a href=".../apply"> we block the default link
// navigation so ONLY LinkedIn's SPA click-handler runs (opens the modal in-place). If
// the handler isn't attached yet, the click is a harmless no-op (we retry) rather than
// navigating to a cold /apply/ page that bounces back into a reload loop. A <button>
// has no navigation, so we just click it.
function pjaClickEasyApply(el) {
  if (el.tagName === 'A') {
    const blockNav = (e) => { e.preventDefault(); };
    el.addEventListener('click', blockNav, { capture: true });
    try { el.click(); } finally {
      setTimeout(() => el.removeEventListener('click', blockNav, { capture: true }), 0);
    }
  } else {
    el.click();
  }
}

// ── Apply on current job-view page ───────────────────────────────────────────
// Used by the navigate-per-job batch flow. Assumes we are already on
// linkedin.com/jobs/view/{id}/ — no card click needed.

function pjaTrace(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' [EA] ' + msg;
  // 1) sessionStorage (fast, survives same-origin reloads)
  try {
    const arr = JSON.parse(sessionStorage.getItem('pja_ea_trace') || '[]');
    arr.push(line);
    sessionStorage.setItem('pja_ea_trace', JSON.stringify(arr.slice(-40)));
  } catch (_) {}
  // 2) chrome.storage pja_dbg (durable; readable via dev server /get-storage curl even
  //    after console clears or DOM-read is blocked). This is the channel I review on failure.
  try {
    chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-40);
      arr.push(line);
      chrome.storage.local.set({ pja_dbg: arr });
    });
  } catch (_) {}
}

async function pjaApplyOnCurrentPage(job, profile, answers, onStatus) {
  // Per-job runs (queue path) never reset this; a stale true from a prior aborted run
  // would make every subsequent job return 'aborted'. Reset defensively.
  PJA_AUTO_STATE.aborted = false;
  const { title } = job;
  pjaTrace('run-start v2 path=' + location.pathname.slice(-30));
  onStatus(`${title}: looking for Easy Apply…`);
  await pjaAutoWait(2000);

  // Skip if already applied
  if (/applied \d+ (second|minute|hour|day|week|month)/i.test(document.body?.innerText || '')) {
    return { success: false, reason: 'already_applied' };
  }

  // FAST PATH: if the Easy Apply modal is already rendered (we navigated to the
  // /jobs/view/{id}/apply/ URL), skip the click step entirely and drive the form.
  // LinkedIn 2026: the Easy Apply control is an <a href=".../apply">, so clicking
  // it (even a trusted CDP click) NAVIGATES rather than opening an in-page modal.
  // Navigating straight to that URL renders the modal in regular DOM.
  // Wait for the Easy Apply control. LinkedIn dropped .jobs-apply-button in 2026; the
  // label "Easy Apply" lives in a <span>. Walk up to the clickable ancestor — PREFER a
  // <button> over an <a>: the <button> opens the modal in regular DOM via a plain
  // synthetic click (no navigation). The <a href=".../apply"> ancestor, if clicked,
  // follows the link to a cold /apply/ page that LinkedIn redirects back to base.
  // IMPORTANT: return ONLY a <button>. At ~2s after load the Easy Apply control is
  // still an <a href=".../apply"> (the interactive <button> hydrates a few seconds
  // later). Clicking the anchor follows the link → cold /apply/ → LinkedIn redirects
  // to base → resumeApplyOnLoad re-fires → infinite reload loop. The <button>, once
  // hydrated, opens the modal in regular DOM on a plain synthetic click.
  // Returns the clickable Easy Apply control. Prefer a <button>, but also accept the
  // <a href=".../apply"> ancestor WHEN it carries LinkedIn's SPA onclick handler — in a
  // logged-in session that handler opens the modal in-place (verified). We only return
  // such an anchor if hydrated (onclick present); a bare/unhydrated anchor would just
  // follow the link to a cold /apply/ page and bounce (the old ISSUE-1 loop).
  function findEasyApplyBtn() {
    const byClass = document.querySelector('.jobs-apply-button');
    if (byClass && byClass.tagName === 'BUTTON' && !byClass.disabled) return byClass;
    const byTag = Array.from(document.querySelectorAll('button'))
      .find(el => !el.disabled
        && /^easy apply$/i.test((el.textContent || '').trim())
        && el.offsetParent !== null);
    if (byTag) return byTag;
    // Walk up from the "Easy Apply" span to the nearest clickable ancestor.
    // NOTE: we can't detect anchor "hydration" via el.onclick — the content script runs
    // in an isolated world where the page's JS-assigned onclick is invisible. Instead we
    // return the anchor and let the caller click it AFTER the page has settled; in a
    // logged-in session the SPA handler opens the modal in-place (verified). The caller
    // guards against the cold-/apply/-navigation loop with a per-job sessionStorage flag.
    const eaSpan = Array.from(document.querySelectorAll('span'))
      .find(el => /^easy apply$/i.test((el.textContent || '').trim()) && el.offsetParent !== null);
    if (eaSpan) {
      let el = eaSpan.parentElement, anchor = null;
      while (el && el !== document.body) {
        if (el.tagName === 'BUTTON' && !el.disabled) return el;
        if (el.tagName === 'A' && !anchor) anchor = el;
        el = el.parentElement;
      }
      if (anchor) return anchor;
    }
    return null;
  }
  // Returns true if an Easy Apply control exists at all (anchor or button) — used to
  // distinguish "still hydrating" from "no Easy Apply on this job".
  function easyApplyPresentAnyForm() {
    return Array.from(document.querySelectorAll('span, button, a'))
      .some(el => /^easy apply$/i.test((el.textContent || '').trim()) && el.offsetParent !== null);
  }
  // Detect "already applied" up front (regardless of open mode).
  if (!pjaGetCurrentModal()) {
    const presentBtn = findEasyApplyBtn();
    if (!presentBtn) {
      const anyApplyEl = document.querySelector('.jobs-apply-button')
        || Array.from(document.querySelectorAll('button, a, span')).find(el => /^easy apply$/i.test((el.textContent||'').trim()));
      if (anyApplyEl?.disabled) return { success: false, reason: 'already_applied' };
      if (/\bapplied\b/i.test(document.body?.innerText || '') && !Array.from(document.querySelectorAll('span')).some(el => /^easy apply$/i.test((el.textContent||'').trim()))) {
        return { success: false, reason: 'already_applied' };
      }
    }
  }

  // OPEN the modal. Two modes:
  //  - AUTO  (PJA_EA_AUTO_OPEN=true):  extension clicks Easy Apply itself, then assists.
  //  - SEMI  (PJA_EA_AUTO_OPEN=false): extension NEVER clicks — it waits for the user to
  //    click "Easy Apply" (reliable, no anti-automation gate, no nav/reload risk), then
  //    takes over to fill + step through. This is the dependable path on current LinkedIn.
  let initModal = pjaGetCurrentModal();
  if (!initModal && PJA_EA_AUTO_OPEN) {
    let applyBtn = null;
    for (let attempt = 0; attempt < 30 && !applyBtn; attempt++) {
      applyBtn = findEasyApplyBtn();
      if (!applyBtn) await pjaAutoWait(600);
    }
    if (applyBtn) pjaClickEasyApply(applyBtn);
    for (let w = 0; w < 12 && !initModal; w++) { await pjaAutoWait(800); initModal = pjaGetCurrentModal(); }
  }
  const autoOpened = !!initModal;

  // Wait for the user (SEMI) — or as a fallback when AUTO open was ignored.
  if (!initModal) {
    onStatus(`👆 Click "Easy Apply" for "${title}" — I'll auto-fill the rest`);
    const deadline = Date.now() + PJA_EA_ASSIST_TIMEOUT_MS;
    while (Date.now() < deadline && !initModal) {
      if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };
      // In AUTO mode keep retrying our own click; in SEMI mode just watch for the user.
      if (PJA_EA_AUTO_OPEN) {
        const btn = findEasyApplyBtn();
        if (btn) { try { pjaClickEasyApply(btn); } catch (_) {} }
      }
      await pjaAutoWait(1000);
      initModal = pjaGetCurrentModal();
    }
  }

  pjaTrace('open mode=' + (PJA_EA_AUTO_OPEN ? 'AUTO' : 'SEMI') + ' modalOpen=' + !!initModal + ' autoOpened=' + autoOpened);
  if (!initModal) { pjaTrace('result=no_easy_apply (modal never opened)'); return { success: false, reason: 'no_easy_apply' }; }

  // TEST MODE — stop here so nothing is filled or submitted. Reports HOW the modal opened.
  if (PJA_EA_DRY_RUN) {
    onStatus(`✓ Modal opened (${autoOpened ? 'AUTOMATICALLY' : 'after assist'}) — dry run, not submitting`);
    return { success: false, reason: 'dry_run_modal_opened', autoOpened };
  }

  const MAX_STEPS = 15;
  let prevHeading = null;
  let sameHeadingCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (PJA_AUTO_STATE.aborted) return { success: false, reason: 'aborted' };

    const modal = pjaGetCurrentModal();
    if (!modal) return { success: false, reason: 'modal_closed' };

    // Mid-refresh double-submit guard: if the modal reloaded into a post-submit confirmation,
    // record success WITHOUT clicking Submit again.
    const eaState = pjaEasyApplyState(modal);
    if (eaState.success) { pjaTrace('resume: success state detected, not re-submitting'); pjaDismissModal(); return { success: true, reason: 'applied_resumed' }; }

    const heading = pjaModalHeading() || `Step ${step + 1}`;
    pjaTrace('step' + step + ' heading=' + heading.slice(0, 25));
    onStatus(`${title}: ${heading}…`);

    if (heading === prevHeading) {
      sameHeadingCount++;
      if (sameHeadingCount >= 2) {
        const emptyFields = pjaEmptyRequiredFields();
        pjaDismissModal();
        return { success: false, reason: 'stuck', heading, fields: emptyFields };
      }
    } else {
      sameHeadingCount = 0;
    }
    prevHeading = heading;

    const isResumeStep = /resume/i.test(heading);
    if (!isResumeStep) {
      pjaFillForm(profile, answers);
      await pjaAutoWait(600);
      pjaFillRequiredRadioFallback();
      pjaFillRequiredSelectFallback();
      if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
      pjaAutoCheckConsent();
      // Reuse the SAME AI answerer used by external-apply, scoped to this modal, for screening
      // questions (years, work-auth, US-person, education, checkbox-groups, etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') {
        const m2 = pjaGetCurrentModal();
        if (m2) { try { await window.pjaAnswerRequiredViaAI(job, m2.root); } catch (_) {} await pjaAutoWait(700); }
      }
    }

    // The modal footer (Next/Review/Submit) can mount a beat after the step body renders, so a
    // single read sometimes sees zero buttons → false 'unknown_buttons'. Retry until they appear.
    let btns = pjaModalBtns();
    for (let r = 0; r < 6 && btns.length === 0; r++) { await pjaAutoWait(800); btns = pjaModalBtns(); }
    pjaTrace('step' + step + ' resume=' + isResumeStep + ' btns=' + btns.join(',').slice(0, 40));
    if (btns.length === 0) {
      // DIAGNOSTIC → dedicated race-free key (pja_dbg writes race under rapid tracing). Capture
      // what the page actually contains so we can fix the collector precisely.
      try {
        const dm = pjaGetCurrentModal();
        const sc = dm ? (dm.root.querySelector && dm.root.querySelector('[role="dialog"]')) || dm.root : null;
        const txt = el => (el.textContent || '').trim().slice(0, 30);
        const cnt = (root, sel) => { try { return root && root.querySelectorAll ? root.querySelectorAll(sel).length : -1; } catch (_) { return -2; } };
        const sample = (root, sel) => { try { return root && root.querySelectorAll ? Array.from(root.querySelectorAll(sel)).map(txt).filter(Boolean).slice(0, 8) : []; } catch (_) { return []; } };
        const diag = {
          ts: Date.now(), heading,
          modal: dm ? { isShadow: dm.isShadow, rootTag: dm.root.tagName || dm.root.nodeName || '?', rootClass: (dm.root.className || '').slice(0, 60) } : null,
          scopeBtn: cnt(sc, 'button'), scopeRoleBtn: cnt(sc, '[role="button"]'), scopeA: cnt(sc, 'a'),
          scopeBtnTexts: sample(sc, 'button'), scopeRoleBtnTexts: sample(sc, '[role="button"],a'),
          docModal: cnt(document, '.jobs-easy-apply-modal'), docDialog: cnt(document, '[role="dialog"]'),
          docDialogBtns: sample(document, '[role="dialog"] button'),
          docFooterBtns: sample(document, 'footer button, .artdeco-modal__actionbar button, [data-test-modal-actionbar] button'),
        };
        chrome.storage.local.set({ pja_ea_diag: diag });
      } catch (_) {}
    }

    if (btns.includes('Submit application')) {
      // Verification gate: stop with the completed form on screen so the user can
      // review before anything is sent. Flip PJA_EA_STOP_BEFORE_SUBMIT=false to submit.
      if (PJA_EA_STOP_BEFORE_SUBMIT) {
        pjaTrace('result=ready_to_submit (stop-before-submit gate)');
        onStatus(`✓ "${title}" ready to submit — review on screen, then submit manually`);
        return { success: false, reason: 'ready_to_submit' };
      }
      pjaTrace('clicking Submit application');
      await pjaTrustedClickInModal('Submit application');
      await pjaAutoWait(2500);
      // Dismiss post-apply "Update profile" / "Not now" dialog
      const notNow = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Not now');
      if (notNow) {
        notNow.click();
        await pjaAutoWait(500);
      } else {
        const stillOpen = pjaGetCurrentModal();
        if (stillOpen) {
          const h = pjaModalHeading() || '';
          if (!/sent|submitted|success|thank|confirmed/i.test(h)) {
            const emptyFields = pjaEmptyRequiredFields();
            if (emptyFields.length) {
              pjaDismissModal();
              return { success: false, reason: 'submit_blocked', fields: emptyFields };
            }
          }
          pjaDismissModal();
        }
      }
      return { success: true };
    }

    if (!isResumeStep) {
      // Use the shared collector (proper react-select/checkbox value detection) so we don't
      // false-bail on fields the AI just filled.
      const mNow = pjaGetCurrentModal();
      const emptyFields = (typeof window.pjaCollectRequiredEmptyFields === 'function' && mNow)
        ? window.pjaCollectRequiredEmptyFields(mNow.root).map(f => f.label)
        : pjaEmptyRequiredFields();
      if (emptyFields.length) {
        pjaTrace('result=missing_required step' + step + ' fields=' + emptyFields.join('|').slice(0, 80));
        pjaDismissModal();
        return { success: false, reason: 'missing_required', fields: emptyFields };
      }
    }

    // Step-advance clicks MUST be trusted (CDP) — LinkedIn rejects synthetic clicks on
    // Next/Review and reloads the page, killing the flow mid-step (the "mid-refresh" issue).
    if (btns.includes('Review')) await pjaTrustedClickInModal('Review');
    else if (btns.includes('Next')) await pjaTrustedClickInModal('Next');
    else if (btns.includes('Continue to next step')) await pjaTrustedClickInModal('Continue to next step');
    else { pjaTrace('result=unknown_buttons btns=' + btns.join(',').slice(0,40)); pjaDismissModal(); return { success: false, reason: 'unknown_buttons', btns }; }

    await pjaAutoWait(1200);
  }

  pjaTrace('result=too_many_steps');
  pjaDismissModal();
  return { success: false, reason: 'too_many_steps' };
}

// ── External Apply (non-Easy-Apply) ──────────────────────────────────────────
// Extracts the external ATS URL from the LinkedIn Apply button, stores job info
// in chrome.storage.local, then navigates the current tab to the ATS page.
// external-apply.js picks it up there and handles form filling + submission.
async function pjaExternalApplyOnCurrentPage(job, profile, answers, onStatus) {
  const { title } = job;

  // Direct ATS queue: applyUrl is pre-set, skip LinkedIn Apply-button discovery
  if (job.applyUrl) {
    onStatus(`${title}: navigating to application…`);
    const returnUrl = location.href;
    await new Promise(resolve => chrome.runtime.sendMessage({
      type: 'SET_EXT_CURRENT',
      payload: { ...job, profile, answers, returnUrl }
    }, resolve));
    setTimeout(() => { window.location.href = job.applyUrl; }, 500);
    return { success: false, reason: 'navigating_to_ats', pending: true };
  }

  onStatus(`${title}: looking for Apply button…`);
  await pjaAutoWait(3000);

  // Skip if already applied (disabled button present with no external link)
  const anyBtn = document.querySelector('.jobs-apply-button');
  if (anyBtn?.disabled) return { success: false, reason: 'already_applied' };

  // --- Check for <a> Apply link first (used on /jobs/view/ pages) ---
  // LinkedIn wraps external URLs in a safety redirect: /safety/go/?url=<encoded>
  let capturedUrl = null;

  function extractLinkedInSafetyUrl(href) {
    try {
      const u = new URL(href);
      const target = u.searchParams.get('url');
      if (target) return decodeURIComponent(target);
    } catch(e) {}
    return href;
  }

  for (let i = 0; i < 8; i++) {
    // Look for <a> tags with "Apply" text (not Easy Apply)
    const applyLinks = Array.from(document.querySelectorAll('a'))
      .filter(a => /^apply$/i.test(a.textContent.trim()) && a.href && a.href.length > 4);
    for (const a of applyLinks) {
      const url = extractLinkedInSafetyUrl(a.href);
      if (url && !url.includes('linkedin.com')) { capturedUrl = url; break; }
    }
    if (capturedUrl) break;

    // Also look for button Apply (not Easy Apply) — intercept window.open when clicked
    const btns = Array.from(document.querySelectorAll('.jobs-apply-button, button[data-job-id], button'))
      .filter(b => !b.disabled && /^apply$/i.test(b.textContent.trim()));
    if (btns.length) {
      const origOpen = window.open;
      const openCapture = new Promise(res => {
        window.open = (url) => { if (url) res(url); return null; };
        setTimeout(() => res(null), 3000);
      });
      const linkHandler = (e) => {
        const a = e.target.closest('a[href]');
        if (a && a.href) {
          const url = extractLinkedInSafetyUrl(a.href);
          if (url && !url.includes('linkedin.com')) { e.preventDefault(); capturedUrl = url; }
        }
      };
      document.addEventListener('click', linkHandler, true);
      btns[0].click();
      const openUrl = await openCapture;
      window.open = origOpen;
      document.removeEventListener('click', linkHandler, true);
      if (openUrl) capturedUrl = openUrl;
      if (capturedUrl) break;
    }

    await pjaAutoWait(800);
  }

  // Fallback: scan DOM for known ATS link hrefs
  if (!capturedUrl) {
    const atsSelectors = 'a[href*="greenhouse.io"],a[href*="lever.co"],a[href*="workday.com"],a[href*="myworkdayjobs.com"],a[href*="jobvite.com"],a[href*="icims.com"],a[href*="smartrecruiters.com"],a[href*="ashbyhq.com"],a[href*="bamboohr.com"],a[href*="linkedin.com/safety/go"]';
    const atsLink = document.querySelector(atsSelectors);
    if (atsLink) capturedUrl = extractLinkedInSafetyUrl(atsLink.href);
  }

  if (!capturedUrl) return { success: false, reason: 'no_apply_btn' };

  onStatus(`${title}: navigating to application…`);

  // Store job context + queue info for external-apply.js to pick up
  const returnUrl = location.href;
  await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'SET_EXT_CURRENT',
    payload: { ...job, profile, answers, applyUrl: capturedUrl, returnUrl }
  }, resolve));

  // Navigate current tab to the external ATS
  setTimeout(() => { window.location.href = capturedUrl; }, 500);

  // Return a "pending" result — actual result comes when we return from ATS
  return { success: false, reason: 'navigating_to_ats', pending: true };
}

// ── Public API ───────────────────────────────────────────────────────────────
window.__pjaAutoState                  = PJA_AUTO_STATE;
window.__pjaGetCurrentModal            = pjaGetCurrentModal;
window.__pjaScanQualifying             = pjaScanQualifyingJobs;
window.__pjaScanQualifyingAsync        = pjaScanQualifyingJobsAsync;
window.__pjaAutoApplyBatch             = pjaAutoApplyBatch;
window.__pjaAutoSearchURL              = PJA_AUTO_SEARCH_URL;
window.__pjaApplyOnCurrentPage         = pjaApplyOnCurrentPage;
window.__pjaExternalApplyOnCurrentPage = pjaExternalApplyOnCurrentPage;
// Testable Easy Apply modal helpers (used by unit tests + internally).
window.__pjaModalHeading               = pjaModalHeading;
window.__pjaModalBtns                  = pjaModalBtns;
window.__pjaEmptyRequiredFields        = pjaEmptyRequiredFields;
window.__pjaEasyApplyState             = pjaEasyApplyState;
