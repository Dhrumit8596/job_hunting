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
      if (same >= 3) { diag('stuck path=' + path.replace('/beta/indeedapply/form/', '')); return { success: false, reason: 'stuck_question', path }; }

      // Fill whatever this module needs (contact/resume are usually prefilled from the Indeed profile).
      try { if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers); } catch (_) {}
      await sleep(400);
      try { if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback(profile); } catch (_) {}
      try { if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback(); } catch (_) {}
      // Shared answerer for screening questions (years / work-auth / experience / education / etc.).
      if (typeof window.pjaAnswerRequiredViaAI === 'function') { try { await window.pjaAnswerRequiredViaAI(job, document.body); } catch (_) {} await sleep(600); }

      if (/questions/i.test(path)) {
        const qlabel = (document.querySelector('fieldset legend, [data-testid*="question" i], h2, [role=group] [role=heading]')?.textContent
          || document.querySelector('label')?.textContent || '').trim().slice(0, 55);
        const types = Array.from(document.querySelectorAll('input, select, textarea')).filter(e => e.name !== 'g-recaptcha-response')
          .map(e => (e.type || e.tagName).toLowerCase()).join(',');
        const checked = document.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked').length;
        const filledText = Array.from(document.querySelectorAll('input[type=text], textarea, select')).filter(e => e.value && e.value.trim()).length;
        diag('Q "' + qlabel + '" types=[' + types + '] checked=' + checked + ' txt=' + filledText);
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
      if (challenged()) { try { chrome.storage.local.set({ pja_indeed_paused: { reason: 'captcha', url: location.href, ts: Date.now() } }); } catch (_) {} return; }
      const applyBtn = document.querySelector('#indeedApplyButton, [data-testid="indeedApplyButton-test"]')
        || btnByText(/apply with indeed|apply now/i);
      diag('viewjob jk=' + jkOfUrl() + ' applyBtn=' + !!applyBtn);
      if (applyBtn) { applyBtn.click(); /* → navigates to smartapply; resume fires there */ }
      else { await advance(q, { success: false, reason: 'no_indeed_apply_button' }); }
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
