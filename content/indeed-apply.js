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
  if (!onViewJob && !onSmartApply) return;
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
    let prevPath = '', same = 0;
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
      if (typeof window.pjaAnswerRequiredViaAI === 'function') { try { await window.pjaAnswerRequiredViaAI(job, document.body); } catch (_) {} await sleep(600); }

      if (/questions/i.test(path)) {
        // Indeed screening radios are grouped by NAME (no fieldset), value="Yes"/"No" (or true/false).
        // Read each group's question by walking up the DOM, then answer honestly: default YES, but NO
        // for the gap/disqualifier questions (require sponsorship / felony / clearance / US-citizen).
        const groups = {};
        document.querySelectorAll('input[type=radio]').forEach(r => { if (r.name) (groups[r.name] = groups[r.name] || []).push(r); });
        let answered = 0;
        for (const radios of Object.values(groups)) {
          if (radios.some(r => r.checked)) continue;
          let el = radios[0], qtext = '';
          for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (!el) break; const t = (el.textContent || '').replace(/\b(yes|no)\b/gi, '').replace(/\s+/g, ' ').trim(); if (t.length > 12) { qtext = t.toLowerCase(); break; } }
          const wantNo = /(require\b.*sponsor|sponsor\w*\b.*(require|need|now)|now,? or will you.*sponsor|\bfelon|convicted|criminal record|security clearance|government clearance|are you a (u\.?s\.?|united states) citizen|u\.?s\.? citizenship required)/i.test(qtext);
          const target = radios.find(r => { const v = (r.value || '').toLowerCase(); return wantNo ? (v === 'no' || v === 'false') : (v === 'yes' || v === 'true'); });
          if (target) {
            if (typeof pjaClickRadio === 'function') pjaClickRadio(target);
            else { target.checked = true; target.click(); target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); }
            answered++;
          }
        }
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
        await sleep(2800);
        if (/\/post-apply|\/postapply|application-submitted|\/success/i.test(location.pathname)
            || /your application has been submitted|application submitted|you'?ve applied/i.test(document.body.innerText || '')) return { success: true };
        // some flows submit then show a brief confirm; treat the form leaving as success
        if (!btnByText(/submit (your )?application/i)) return { success: true, reason: 'submitted_assumed' };
        continue;
      }
      const cont = btnByText(/^continue$/i) || btnByText(/^continue\b|^next\b|review your application/i);
      if (cont) { diag('click continue "' + (cont.textContent || '').trim().slice(0, 20) + '"'); cont.click(); await sleep(1600); continue; }
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
        if (!log.some(e => nz(e.company) + '::' + nz(e.title) === key)) {
          log.push({ company: job.company, title: job.title, jobId: job.jobId || null,
            applyUrl: 'https://www.indeed.com/viewjob?jk=' + (job.jobId || ''), location: job.location || null,
            channel: 'indeed-apply', status: 'applied', reason: result.reason || 'indeed_apply',
            fitScore: job.fitScore || null, confirmedEmail: false, appliedAt: Date.now() });
          chrome.storage.local.set({ pja_applied_log: log });
        }
      });
    } catch (_) {}
  }

  async function advance(q, result) {
    const job = q.jobs[q.currentIndex];
    q.results = q.results || { applied: [], skipped: [] };
    if (result.success) { q.results.applied.push({ ...job, reason: result.reason }); writeAppliedLog(job, result); }
    else { q.results.skipped.push({ company: job.company, title: job.title, skipReason: result.reason }); }
    try { chrome.storage.local.set({ pja_indeed_lastresult: { jobId: job.jobId, title: job.title, result, ts: Date.now() } }); } catch (_) {}
    if (result.halt) { q.status = 'paused'; await setQ(q); return; }
    q.currentIndex++;
    if (q.currentIndex >= q.jobs.length) { q.status = 'done'; await setQ(q); return; }
    await setQ(q);
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
      if (jkOfUrl() !== job.jobId) return;
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
      if (challenged()) { try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'captcha', url: location.href, ts: Date.now() } }); } catch (_) {} return; }
      await advance(q, { success: false, reason: 'no_indeed_apply_button' });
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
