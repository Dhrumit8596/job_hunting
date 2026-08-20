'use strict';
/* Indeed Apply ("Easily apply") engine. Queue-driven + resumable across the two-stage navigation:
   indeed.com/viewjob?jk=  →  (click "Apply with Indeed")  →  smartapply.indeed.com/beta/indeedapply/form/<module>...
   On the smartapply flow it steps through modules (screening / contact / resume / review) reusing
   the shared fillers + answerer, then submits. Records to pja_applied_log channel:'indeed-apply'.
   Backend-triggered via pja_indeed_queue; monitored via curl. Pauses on captcha; double-submit guard. */

(function () {
  const host = location.hostname;
  const onViewJob = /(^|\.)indeed\.com$/.test(host) && location.pathname.startsWith('/viewjob');
  const onSmartApply = host === 'smartapply.indeed.com';
  const onTailoredResume = host === 'profile.indeed.com' && location.pathname.startsWith('/tailored-resume/');
  if (!onViewJob && !onSmartApply && !onTailoredResume) return;
  if (window.__pjaIndeedApplyLoaded) return;
  window.__pjaIndeedApplyLoaded = true;

  const PJA_INDEED_STOP_BEFORE_SUBMIT = false; // false = actually submit (autonomous). true = stop at submit for review.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const diag = m => { try { chrome.storage.local.get('pja_indeed_diag', d => { const a = (d.pja_indeed_diag || []).slice(-39); a.push((Date.now() % 100000) + ' ' + m); chrome.storage.local.set({ pja_indeed_diag: a }); }); } catch (_) {} };
  diag('loaded host=' + host + ' vj=' + onViewJob + ' sa=' + onSmartApply);
  const QKEY = 'pja_indeed_queue';
  const getQ = () => new Promise(r => chrome.storage.local.get(QKEY, d => r(d[QKEY] || null)));
  const setQ = q => new Promise(r => chrome.storage.local.set({ [QKEY]: q }, r));

  function challenged() {
    const txt = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return /verify you are human|additional verification required|are you a robot|unusual traffic from your|complete the security check/i.test(txt);
  }
  function btnByText(re) {
    return Array.from(document.querySelectorAll('button, a[role=button]')).find(b =>
      re.test((b.textContent || '').trim()) && b.offsetParent !== null && !b.disabled);
  }
  function jkOfUrl(u) { const m = String(u || location.href).match(/[?&]jk=([^&]+)/); return m ? m[1] : null; }

  // Question text by DOM walk-up (Indeed groups by name, no fieldset).
  function qTextFor(el) { for (let i = 0; i < 7 && el; i++) { el = el.parentElement; if (!el) break; const t = (el.textContent || '').replace(/\b(yes|no)\b/gi, '').replace(/\s+/g, ' ').trim(); if (t.length > 12) return t.slice(0, 100); } return ''; }

  // Collect the required questions still UNANSWERED on the current step (radios not checked +
  // required empty text/select), so a stall is recorded into the answer bank instead of vanishing.
  function collectUnansweredQuestions() {
    const out = [];
    const groups = {};
    document.querySelectorAll('input[type=radio]').forEach(r => { if (r.name) (groups[r.name] = groups[r.name] || []).push(r); });
    for (const radios of Object.values(groups)) { if (!radios.some(r => r.checked)) out.push({ label: qTextFor(radios[0]), type: 'radio', options: radios.map(r => r.value).slice(0, 8) }); }
    document.querySelectorAll('input[type=text], input[type=number], input:not([type]), textarea, select').forEach(e => {
      if (e.name === 'g-recaptcha-response' || !e.offsetParent) return;
      const req = e.required || e.getAttribute('aria-required') === 'true';
      if (req && !(e.value && e.value.trim())) out.push({ label: qTextFor(e), type: e.tagName === 'SELECT' ? 'select' : (e.type || 'text'), options: e.tagName === 'SELECT' ? Array.from(e.options).map(o => o.text).slice(0, 8) : [] });
    });
    return out.filter(q => q.label);
  }

  // Record unanswered questions into pja_missing_questions (same shape external-apply uses), so the
  // answer bank captures Indeed screening questions we couldn't fill (for review + future fills).
  function recordIndeedMissing(job) {
    try {
      const fields = collectUnansweredQuestions();
      if (!fields.length) return;
      chrome.storage.local.get('pja_missing_questions', d => {
        const store = d.pja_missing_questions || {};
        for (const f of fields) {
          const key = (f.label || '').toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 100);
          if (!key) continue;
          if (!store[key]) store[key] = { question: f.label, type: f.type, options: f.options, answer: null, seenCount: 0, contexts: [] };
          store[key].seenCount = (store[key].seenCount || 0) + 1;
          const ctx = { jobId: job.jobId, company: job.company, title: job.title, url: location.href, channel: 'indeed-apply' };
          if (!store[key].contexts.find(c => c.jobId === job.jobId)) store[key].contexts.push(ctx);
        }
        chrome.storage.local.set({ pja_missing_questions: store });
      });
    } catch (_) {}
  }

  // Pure-ish step classifier (testable): which kind of smartapply step is on screen.
  // 'success' (applied), 'submit' (review step has a Submit button), 'continue' (advance),
  // 'challenge' (captcha → pause), or 'unknown'. Reads the given doc (defaults to document).
  function pjaIndeedStepKind(doc) {
    const d = doc || document;
    const txt = (d.body && (d.body.innerText || d.body.textContent)) || '';
    const path = (d.location && d.location.pathname) || (typeof location !== 'undefined' ? location.pathname : '');
    if (/verify you are human|additional verification required|are you a robot|unusual traffic from your|complete the security check/i.test(txt)) return 'challenge';
    if (/\/post-apply|\/postapply|application-submitted|\/success/i.test(path)
        || /your application has been submitted|application submitted|you'?ve applied|application sent/i.test(txt)) return 'success';
    const btns = Array.from(d.querySelectorAll('button, a[role=button]')).map(b => (b.textContent || '').trim());
    if (btns.some(t => /submit (your )?application|^submit application$|^submit$/i.test(t))) return 'submit';
    if (btns.some(t => /^continue$/i.test(t) || /review your application/i.test(t))) return 'continue';
    return 'unknown';
  }

  // ── Smart-apply step machine (SPA, in-page loop) ─────────────────────────────
  async function runSmartApply(job, profile, answers) {
    const MAX = 14;
    let prevPath = '', same = 0, disabledWaits = 0;
    for (let step = 0; step < MAX; step++) {
      if (challenged()) { try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'captcha', url: location.href, ts: Date.now() } }); } catch (_) {} return { success: false, reason: 'captcha', halt: true }; }
      await sleep(1400);

      // success page after submit
      if (/\/post-apply|\/postapply|application-submitted|\/success/i.test(location.pathname)
          || /your application has been submitted|application submitted|you'?ve applied|application sent/i.test(document.body.innerText || '')) {
        return { success: true };
      }

      const path = location.pathname;
      const kind0 = pjaIndeedStepKind(document);
      const btnsNow = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(x => x && !/skip to|find jobs|save-icon|report|see more|save and close/i.test(x)).slice(0, 5);
      diag('step' + step + ' path=' + path.replace('/beta/indeedapply/form/', '') + ' kind=' + kind0 + ' btns=' + btnsNow.join('|').slice(0, 60));
      if (path === prevPath) { same++; } else { same = 0; prevPath = path; }
      // Stuck on the same step despite clicking advance → a required question we couldn't answer.
      // Skip the job cleanly instead of looping the whole MAX budget.
      if (same >= 3) { diag('stuck path=' + path.replace('/beta/indeedapply/form/', '')); recordIndeedMissing(job); return { success: false, reason: 'stuck_question', path }; }

      // Fill whatever this module needs (contact/resume are usually prefilled from the Indeed profile).
      try { if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers); } catch (_) {}
      await sleep(400);
      try { if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback(profile); } catch (_) {}
      try { if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback(); } catch (_) {}
      // Shared answerer for screening questions (years / work-auth / experience / education / etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') {
        try { await Promise.race([window.pjaAnswerRequiredViaAI(job, document.body), sleep(30000)]); } catch (_) {}
        await sleep(600);
      }

      if (/questions/i.test(path)) {
        // Indeed screening radios are grouped by NAME (no fieldset), value="Yes"/"No" (or true/false).
        // Read each group's question by walking up the DOM, then answer honestly: default YES, but NO
        // for the gap/disqualifier questions (require sponsorship / felony / clearance / US-citizen).
        const groups = {};
        document.querySelectorAll('input[type=radio]').forEach(r => { if (r.name) (groups[r.name] = groups[r.name] || []).push(r); });
        let answered = 0;
        for (const radios of Object.values(groups)) {
          if (radios.some(r => r.checked)) continue;
          if (/demographic-questions/i.test(path)) {
            const optionText = r => ((r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')?.textContent) || r.closest('label')?.textContent || r.value || '').trim();
            const privateChoice = radios.find(r => /prefer not|decline|do not wish|don.?t want to answer/i.test(optionText(r)))
              || radios[radios.length - 1];
            if (privateChoice) {
              if (typeof pjaClickRadio === 'function') pjaClickRadio(privateChoice);
              else { privateChoice.click(); privateChoice.dispatchEvent(new Event('change', { bubbles: true })); }
              answered++;
              continue;
            }
          }
          let el = radios[0], qtext = '';
          for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (!el) break; const t = (el.textContent || '').replace(/\b(yes|no)\b/gi, '').replace(/\s+/g, ' ').trim(); if (t.length > 12) { qtext = t.toLowerCase(); break; } }
          const wantNo = /(require\b.*sponsor|sponsor\w*\b.*(require|need|now)|now,? or will you.*sponsor|\bfelon|convicted|criminal record|security clearance|government clearance|\bus person\b|are you a (u\.?s\.?|united states) citizen|u\.?s\.? citizenship required|\bcad\b|\bpython\b|\bfmea\b|\b8d\b|iso\s*13485|supplier audit|optical metrology)/i.test(qtext);
          const radioText = r => ((r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')?.textContent) || r.closest('label')?.textContent || r.value || '').trim().toLowerCase();
          const target = radios.find(r => { const v = radioText(r); return wantNo ? /^(no|false)\b/.test(v) : /^(yes|true)\b/.test(v); });
          if (target) {
            if (typeof pjaClickRadio === 'function') pjaClickRadio(target);
            else { target.checked = true; target.click(); target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); }
            answered++;
          }
        }
        // Multi-option radios beyond Yes/No: relocation, commute, work-authorization. Honest for a
        // CA-based candidate applying to CA roles (she is local; commute=yes; authorized via TN).
        for (const radios of Object.values(groups)) {
          if (radios.some(r => r.checked)) continue;
          const q = qTextFor(radios[0]).toLowerCase();
          let pick = null;
          const values = radios.map(r => String(r.value || ''));
          if (values.some(v => /^mobile$/i.test(v))) pick = radios.find(r => /^mobile$/i.test(r.value));
          else if (values.some(v => /^home$/i.test(v)) && values.some(v => /^work$/i.test(v))) pick = radios.find(r => /^home$/i.test(r.value));
          else if (/relocat/.test(q)) pick = radios.find(r => /\blocal\b/i.test(r.value)) || radios.find(r => /will not relocate|no.*relocat/i.test(r.value)) || radios.find(r => /relocate/i.test(r.value));
          else if (/commute|reliably|able to (get|travel)/.test(q)) pick = radios.find(r => /^yes/i.test(r.value));
          else if (/authoriz|eligible to work|legally/.test(q)) pick = radios.find(r => /^yes/i.test(r.value));
          if (pick) { if (typeof pjaClickRadio === 'function') pjaClickRadio(pick); else { pick.checked = true; pick.dispatchEvent(new Event('click', { bubbles: true })); pick.dispatchEvent(new Event('change', { bubbles: true })); } answered++; }
        }
        // Work-auth / relocation as SELECT dropdowns.
        for (const sel of document.querySelectorAll('select')) {
          if (!sel.offsetParent || (sel.value && sel.value.trim() && !/choose|select/i.test(sel.value))) continue;
          const q = qTextFor(sel).toLowerCase();
          let opt = null;
          if (/sponsor/.test(q)) opt = Array.from(sel.options).find(o => /^no$/i.test(o.text));
          else if (/authoriz|eligible|relocat|commute|willing/.test(q)) opt = Array.from(sel.options).find(o => /^yes$/i.test(o.text)) || Array.from(sel.options).find(o => /local/i.test(o.text));
          if (opt && typeof pjaFillSelect === 'function') { pjaFillSelect(sel, opt.text); answered++; }
        }
        // Indeed country/location comboboxes render an open listbox after the shared filler types
        // the value. Commit the exact option; leaving only search text makes Continue a no-op.
        const usOption = Array.from(document.querySelectorAll('[role=option], [data-testid*=option]')).find(o =>
          o.offsetParent !== null && /^United States(?: of America)?$/i.test((o.textContent || '').trim()));
        if (usOption) { usOption.click(); usOption.dispatchEvent(new Event('change', { bubbles: true })); answered++; }
        // Consent / acknowledgment radios (single "I have read and agree / I acknowledge / I certify"
        // option) → check it (these are agreements, not experience claims).
        for (const radios of Object.values(groups)) {
          if (radios.some(r => r.checked)) continue;
          const agree = radios.find(r => /\bi (have read|agree|acknowledge|certify|consent|confirm)\b/i.test(r.value || '') || radios.length === 1);
          if (agree) { if (typeof pjaClickRadio === 'function') pjaClickRadio(agree); else { agree.checked = true; agree.dispatchEvent(new Event('click', { bubbles: true })); agree.dispatchEvent(new Event('change', { bubbles: true })); } answered++; }
        }
        document.querySelectorAll('input[type=checkbox]').forEach(cb => { if (!cb.checked && (cb.required || /agree|acknowledge|certify|consent|confirm/i.test(qTextFor(cb)))) { cb.click(); answered++; } });
        // Required contact text fields Indeed didn't prefill (City / Postal Code / State) → from profile.
        for (const e of document.querySelectorAll('input[type=text], input[type=number], input:not([type])')) {
          if (e.name === 'g-recaptcha-response' || !e.offsetParent || (e.value && e.value.trim())) continue;
          if (!(e.required || e.getAttribute('aria-required') === 'true')) continue;
          const ql = qTextFor(e).toLowerCase();
          let v = /postal code|\bzip\b/.test(ql) ? profile.zip : /\bcity\b/.test(ql) ? profile.city : /\bstate\b/.test(ql) ? profile.state : null;
          if (v && typeof pjaSetNative === 'function') { pjaSetNative(e, v); answered++; }
        }
        diag('Q answered=' + answered + '/' + Object.keys(groups).length);
        await sleep(700);
      }
      // Submit (review step) vs Continue (advance).
      const submitBtn = btnByText(/submit (your )?application|^submit application$|^submit$/i);
      if (submitBtn) {
        if (PJA_INDEED_STOP_BEFORE_SUBMIT) return { success: false, reason: 'ready_to_submit' };
        submitBtn.click();
        // Confirmation can render briefly or after a route transition. Poll for an explicit
        // success signal; a vanished Submit button alone is not enough to claim an application.
        for (let wait = 0; wait < 12; wait++) {
          await sleep(500);
          const after = pjaIndeedStepKind(document);
          if (after === 'success') return { success: true, reason: 'indeed_confirmation' };
          if (after === 'challenge') return { success: false, reason: 'captcha_after_submit', halt: true };
        }
        return { success: false, reason: 'submit_unconfirmed' };
      }
      const cont = btnByText(/^continue$/i) || btnByText(/^continue\b|^next\b|review (?:your application|resume)/i);
      if (cont) { diag('click continue "' + (cont.textContent || '').trim().slice(0, 20) + '"'); cont.click(); await sleep(1600); continue; }
      const disabledAdvance = Array.from(document.querySelectorAll('button, a[role=button]')).find(b =>
        (/submit (your )?application|^submit application$|^submit$|^continue$|review (?:your application|resume)/i.test((b.textContent || '').trim())) &&
        (b.disabled || b.getAttribute('aria-disabled') === 'true'));
      if (disabledAdvance) {
        diag('advance disabled; waiting for page readiness');
        disabledWaits++;
        if (disabledWaits >= 3) return { success: false, reason: 'advance_stayed_disabled', path };
        same = 0;
        await sleep(10000);
        continue;
      }
      disabledWaits = 0;
      diag('no advance btn (kind=' + kind0 + ' same=' + same + ')');

      // No advance control + heading unchanged twice → stuck (unfillable required field).
      if (same >= 2) return { success: false, reason: 'stuck', path };
      await sleep(1200);
    }
    return { success: false, reason: 'too_many_steps' };
  }

  function writeAppliedLog(job, result) {
    try {
      chrome.storage.local.get('pja_applied_log', d => {
        const log = Array.isArray(d.pja_applied_log) ? d.pja_applied_log : [];
        const nz = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const key = nz(job.company) + '::' + nz(job.title);
        const inId = String(job.jobId || job.sourceJobId || '');
        if (!log.some(e => nz(e.company) + '::' + nz(e.title) === key
          && (!inId || e.jobId == null || String(e.jobId) === inId))) {
          log.push({ company: job.company, title: job.title, jobId: job.jobId || null,
            applyUrl: 'https://www.indeed.com/viewjob?jk=' + (job.jobId || ''), location: job.location || null,
            channel: 'indeed-apply', runId: job.runId || null,
            status: 'applied', reason: result.reason || 'indeed_apply',
            fitScore: job.fitScore || null, confirmationSource: 'page', confirmedAt: Date.now(),
            confirmedEmail: false, appliedAt: Date.now() });
          chrome.storage.local.set({ pja_applied_log: log });
        }
      });
    } catch (_) {}
  }

  async function advance(q, result) {
    const job = q.jobs[q.currentIndex];
    const uncertain = /unconfirmed|unclear|assumed|inferred/i.test(String(result.reason || ''));
    const ledgerEvent = {
        runId: job.runId || q.runId || null, jobId: job.jobId || job.id || null,
        applyUrl: 'https://www.indeed.com/viewjob?jk=' + (job.jobId || ''),
        company: job.company, title: job.title, channel: 'indeed_apply',
        status: result.success ? 'applied' : uncertain ? 'submitted' : 'failed',
        success: result.success ? true : (uncertain ? null : false), reason: result.reason || '',
        confirmationSource: result.success ? 'page' : null,
        confirmedAt: result.success ? Date.now() : null,
        applicationAt: job.applicationAt || q.startedAt || Date.now(), occurredAt: Date.now()
      };
    const signalLedger = () => { try { chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', event: ledgerEvent,
      closeTab: !!job.rankedRun }, () => void chrome.runtime.lastError); } catch (_) {} };
    q.results = q.results || { applied: [], skipped: [] };
    if (result.success) { q.results.applied.push({ ...job, reason: result.reason }); writeAppliedLog(job, result); }
    else { q.results.skipped.push({ company: job.company, title: job.title, skipReason: result.reason }); }
    try {
      if (job.id) chrome.runtime.sendMessage({ type: 'UPDATE_CORPUS_STATE', id: job.id,
        runId: job.runId || q.runId || null,
        reason: result.success ? 'applied' : (result.reason || 'unknown') },
      () => void chrome.runtime.lastError);
    } catch (_) {}
    try { chrome.storage.local.set({ pja_indeed_lastresult: { jobId: job.jobId, title: job.title, result, ts: Date.now() } }); } catch (_) {}
    if (result.halt) { q.status = 'paused'; await setQ(q); signalLedger(); return; }
    q.currentIndex++;
    if (q.currentIndex >= q.jobs.length) { q.status = 'done'; await setQ(q); signalLedger(); return; }
    await setQ(q);
    signalLedger();
    await sleep(15000 + Math.random() * 25000); // humane pacing between jobs
    location.href = 'https://www.indeed.com/viewjob?jk=' + q.jobs[q.currentIndex].jobId;
  }

  // ── Resume driver (runs on each page load) ───────────────────────────────────
  async function resumeIndeedApply() {
    const q = await getQ();
    if (!q || q.status !== 'applying') return;
    const job = q.jobs[q.currentIndex];
    if (!job) return;

    if (onViewJob) {
      // Only act on the current job's viewjob page.
      if (jkOfUrl() !== job.jobId) {
        location.replace('https://www.indeed.com/viewjob?jk=' + job.jobId);
        return;
      }
      await sleep(1500);
      const applyBtn = document.querySelector('#indeedApplyButton, [data-testid="indeedApplyButton-test"]')
        || btnByText(/apply with indeed|apply now/i);
      diag('viewjob jk=' + jkOfUrl() + ' applyBtn=' + !!applyBtn);
      if (applyBtn) {
        applyBtn.click();
        await sleep(7000);
        // If we're still on the viewjob page (no navigation to smartapply), the job is already
        // applied or unavailable — skip it so the queue advances instead of sticking here.
        if (location.pathname.startsWith('/viewjob')) { await advance(q, { success: false, reason: 'already_applied_or_unavailable' }); }
        return; /* navigated → resume fires on smartapply */
      }
      // No apply button: a real challenge replaced the page, OR the job isn't Easily-apply. Only a
      // page WITHOUT the apply button + challenge text is a real challenge (avoid false positives).
      if (challenged()) {
        try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'captcha', url: location.href, ts: Date.now() } }); } catch (_) {}
        await advance(q, { success: false, reason: 'captcha', halt: true });
        return;
      }
      await advance(q, { success: false, reason: 'no_indeed_apply_button' });
      return;
    }

    if (onTailoredResume) {
      diag('tailored resume start job=' + job.jobId);
      let continueBtn = null;
      for (let i = 0; i < 10 && !continueBtn; i++) {
        continueBtn = btnByText(/^continue$/i);
        if (!continueBtn) await sleep(1000);
      }
      if (continueBtn) {
        diag('tailored resume click continue');
        continueBtn.click();
        return;
      }
      await advance(q, { success: false, reason: 'tailored_resume_continue_missing' });
      return;
    }

    if (onSmartApply) {
      diag('smartapply start job=' + job.jobId + ' path=' + location.pathname.replace('/beta/indeedapply/', ''));
      const result = await runSmartApply(job, q.profile || {}, q.answers || {});
      await advance(q, result);
    }
  }

  window.__pjaResumeIndeedApply = resumeIndeedApply;
  window.__pjaIndeedStepKind = pjaIndeedStepKind; // testable classifier
  // Auto-run on load (both viewjob + smartapply).
  setTimeout(() => { resumeIndeedApply().catch(() => {}); }, 1500);
})();
