'use strict';
// Runs on ATS pages (Greenhouse, Lever, Workday, etc.) during external apply automation.
// Reads pja_ext_current from chrome.storage.local, fills form, records result.

(function () {
  if (window.__pjaExtApplyLoaded) return;
  window.__pjaExtApplyLoaded = true;

  // Never run on Google auth pages — they appear during OAuth redirect flows
  if (/accounts\.google\.com|google\.com\/o\/oauth2/i.test(location.hostname)) return;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // When true, the flow fills the form and stops WITHOUT clicking the final submit,
  // leaving the completed application on screen for the user to review + submit.
  // Set false to auto-submit. (Read live from storage so it can be toggled per run.)
  const PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT = true;

  // Catch any unhandled promise rejections so they appear in console
  window.addEventListener('unhandledrejection', e => {
    console.log('PJA ext-apply UNHANDLED REJECTION:', e.reason?.message || String(e.reason), e.reason?.stack?.slice(0, 300) || '');
  });

  // Log right before page unloads — helps diagnose cascade (console clears on nav by default)
  window.addEventListener('beforeunload', () => {
    try {
      const msg = sessionStorage.getItem('pja_last_action') || 'unknown';
      console.log('PJA ext-apply PAGE UNLOADING, last_action:', msg);
    } catch(_) {}
  });

  const ATS_PATTERNS = /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs\.com|jobvite\.com|icims\.com|smartrecruiters\.com|ashbyhq\.com|bamboohr\.com|taleo\.net|applytojob\.com|jazz\.co|recruitee\.com|rippling\.com|successfactors\.com|smashfly\.com|phenom|randstadusa\.com|adecco\.com|manpowergroup\.com|manpower\.com|kellyjobs\.com|adeccousa\.com|heidrick\.com|experis\.com|roberthalf\.com|careers\.|careers\b|myworkday|apply\./i;

  // Recovery: if navigateBack stored a destination that survived a page redirect, navigate there now.
  // This handles cases where an ATS page redirected before our setTimeout could fire.
  try {
    chrome.storage.local.get('pja_navigate_to', d => {
      const dest = d.pja_navigate_to;
      if (!dest) return;
      // Only follow if we're NOT already on the destination host (avoid redirect loops)
      try {
        const destHost = new URL(dest).hostname;
        if (location.hostname === destHost) { chrome.storage.local.remove('pja_navigate_to'); return; }
      } catch(_) {}
      // Don't redirect LinkedIn/Google tabs
      if (/linkedin\.com|google\.com|glassdoor\.com|indeed\.com/i.test(location.hostname)) return;
      console.log('PJA ext-apply: recovery navigate to', dest);
      chrome.storage.local.remove('pja_navigate_to', () => { window.location.href = dest; });
    });
  } catch(_) {}

  try {
    chrome.storage.local.get(['pja_ext_current', 'pja_answers', 'pja_ext_queue'], data => {
      // Never run on LinkedIn/Indeed/Glassdoor (those are handled by content.js)
      if (/linkedin\.com|indeed\.com|glassdoor\.com/i.test(location.hostname)) return;

      const job = data.pja_ext_current;
      if (!job) { console.log('PJA ext-apply: no pja_ext_current, skipping'); return; }
      console.log('PJA ext-apply: job read v2, _handled=', job._handled, 'company=', job.company);

      // Guard: never redirect a non-ATS tab (e.g. google.com) — check expected host first.
      // Allow the mismatch when we've landed on a known ATS: company career domains
      // routinely redirect to their underlying ATS (e.g. jobs.jbsfoodsgroup.com → jobvite.com).
      if (job.applyUrl) {
        try {
          const expectedHost = new URL(job.applyUrl).hostname;
          if (location.hostname !== expectedHost && !ATS_PATTERNS.test(location.hostname)) {
            console.log('PJA ext-apply: hostname mismatch early:', location.hostname, '≠', expectedHost, '— skipping');
            return;
          }
        } catch(e) {}
      }

      const queue = data.pja_ext_queue;
      // Only treat _handled=true as valid for THIS queue run (runId must match)
      const sameRun = queue && job.runId && job.runId === queue.runId;
      if (job._handled && sameRun) {
        // recordResult may not have run if page navigation killed the script during submit.
        // Advance the queue now if currentIndex still points to this job, then navigate.
        const myIdx = queue.jobs.findIndex(j => (j.id || j.jobId) === (job.id || job.jobId));
        if (queue.status === 'applying' && myIdx >= 0 && queue.currentIndex === myIdx) {
          console.log('PJA ext-apply: pre-nav handled, advancing queue for', job.company);
          queue.results.applied.push({ ...queue.jobs[myIdx], appliedAt: Date.now(), note: 'pre-nav-handled' });
          queue.currentIndex = myIdx + 1;
          if (queue.currentIndex >= queue.jobs.length) queue.status = 'done';
          // Durable-log fix: this submit-navigated success never ran recordResult's log write.
          // Upgrade the optimistic 'submitting' pre-write (or create it) to 'applied' via the
          // shared idempotent writer, then persist the advanced queue and navigate on.
          pjaWriteAppliedLog(job, { status: 'applied', reason: 'pre-nav-handled' }).then(() => {
            chrome.storage.local.set({ pja_ext_queue: queue }, () => navigateBack(job));
          });
        } else if (queue.status === 'applying') {
          console.log('PJA ext-apply: same-run handled, queue already advanced, calling navigateBack');
          navigateBack(job);
        } else {
          console.log('PJA ext-apply: same-run handled but queue is', queue.status, '— not navigating');
        }
        return;
      }
      if (job._handled) {
        console.log('PJA ext-apply: stale _handled (runId mismatch or no queue), ignoring');
        // fall through — treat as fresh
      }
      if (!queue || queue.status !== 'applying') { console.log('PJA ext-apply: queue not applying:', queue?.status); return; }

      // Verify we're on the expected domain (prevents processing wrong pages after queue reset)
      if (job.applyUrl) {
        try {
          const expectedHost = new URL(job.applyUrl).hostname;
          if (location.hostname !== expectedHost && !ATS_PATTERNS.test(location.hostname)) {
            console.log('PJA ext-apply: hostname mismatch:', location.hostname, '≠', expectedHost, '— skipping');
            return;
          }
        } catch(e) {}
      }

      // Run if: known ATS domain, OR any external career page when queue is active.
      // Test the HOSTNAME too (catches career subdomains like jobs.acme.com,
      // careers.acme.com) and allow singular "/job/" — not just plural "jobs".
      const knownATS = ATS_PATTERNS.test(location.hostname);
      const careerHay = (location.hostname + location.pathname + location.search).toLowerCase();
      const looksLikeCareer = /jobs?|careers?|apply|job-application|recruit|talent|workday|greenhouse|lever|icims|taleo|smartrecruiters|jobvite|ashby|bamboo/i.test(careerHay);
      if (!knownATS && !looksLikeCareer) {
        console.log('PJA ext-apply: not ATS/career page, skipping:', location.hostname);
        return;
      }

      // Stamp runId onto job so pre-save and recovery checks can validate same run
      if (queue.runId) job.runId = queue.runId;

      console.log('PJA ext-apply: TRIGGERED for', job.company, '@', location.hostname, 'idx:', queue.currentIndex);
      sessionStorage.setItem('pja_last_action', 'triggered:' + job.company);

      waitForForm().then(() => runExternalApply(job, data.pja_answers || {}))
        .catch(e => console.log('PJA ext-apply outer promise catch:', e.message, e.stack?.slice(0,200)));
    });
  } catch(e) {
    console.log('PJA ext-apply: outer storage.get failed (context invalidated?):', e.message);
  }

  async function waitForForm() {
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('form input, form select, form textarea')) return;
      await sleep(500);
    }
  }

  async function runExternalApply(job, rawAnswers) {
    try {
    // Previous load's last action — read BEFORE overwriting. 'ready_to_submit:' here means
    // THIS tab clicked submit for this job and the confirmation page is a real submit landing;
    // anything else on a confirmation page means the application predates this run.
    const pjaPrevAction = sessionStorage.getItem('pja_last_action') || '';
    sessionStorage.setItem('pja_last_action', 'runExternalApply:' + job.company);
    // Stall watchdog: if this job neither submits nor skips within the window, force-advance the
    // queue so one hung page can't block an unattended batch. On normal completion navigateBack
    // navigates away and this timer dies with the page. Raised 4min→7min: forms with many
    // AI-answered screening questions (each a dev-server round-trip ~3-5s) + combobox retries
    // legitimately need longer than 4min, and were being force-skipped mid-fill (watchdog_timeout).
    setTimeout(() => {
      try { sessionStorage.setItem('pja_last_action', 'watchdog_timeout:' + job.company); } catch (_) {}
      try { recordResult(job, { success: false, reason: 'watchdog_timeout' }).then(() => navigateBack(job), () => navigateBack(job)); }
      catch (_) { try { navigateBack(job); } catch (__) {} }
    }, 420000);
    await sleep(1500); // let dynamic forms settle

    // Fall back to stored profile/answers if the job object doesn't include them
    let profile = (job.profile && Object.keys(job.profile).length > 0) ? job.profile : {};
    let answers = (rawAnswers && Object.keys(rawAnswers).length > 0) ? rawAnswers : {};
    try {
      const stored = await new Promise((resolve, reject) => {
        chrome.storage.local.get(['pja_profile', 'pja_answers'], d => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(d);
        });
      });
      if (!Object.keys(profile).length) profile = stored.pja_profile || {};
      if (!Object.keys(answers).length) answers = stored.pja_answers || {};
    } catch(e) {
      console.log('PJA ext-apply: profile storage read failed:', e.message, '— continuing with empty');
    }
    // Merge stored profile on top of defaults so new profile keys always have fallback values.
    const defaultProfile = (typeof window.PJA_DEFAULT_PROFILE !== 'undefined') ? window.PJA_DEFAULT_PROFILE : {};
    profile = Object.assign({}, defaultProfile, profile);
    const descClicks = job._descClicks || 0;

    console.log('PJA ext-apply:', job.company, '|', job.ats, '| profile.firstName:', profile.firstName || 'MISSING', '| descClicks:', descClicks);

    // --- Check if this is a job description page (no form inputs yet) ---
    const hasFormInputs = !!document.querySelector(
      'form input:not([type=hidden]):not([type=file]), form select, form textarea,' +
      'input[required]:not([type=hidden]):not([type=file]), select[required], textarea[required]'
    );
    // Workday SPA uses React without <form>/required attributes and handles auth state
    // internally — bypass the description-page check entirely for Workday sites.
    const isWorkdaySite = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
    console.log('PJA ext-apply hasFormInputs:', hasFormInputs, 'isWorkday:', isWorkdaySite, 'url:', location.href.slice(0,60));

    // ISSUE-4 — chatbot / conversational apply (e.g. "Chat to Apply", Paradox/Olivia,
    // text-to-apply). These can't be form-filled. Detect them up front and skip fast
    // with a clear, distinct reason + flag for manual follow-up, instead of clicking
    // into a dead end and burning the full wait loop.
    if (!hasFormInputs) {
      const pageTxt = (document.body?.innerText || '').toLowerCase();
      const chatApplyControl = Array.from(document.querySelectorAll('a,button'))
        .some(el => el.offsetParent && /chat to apply|text to apply|apply (via|with|by) (chat|text)|start (a )?chat|chat now to apply/i.test(el.textContent || ''));
      const chatbotWidget = /paradox\.ai|olivia\.paradox|chatbot|conversational apply/i.test(
        (document.documentElement.outerHTML || '').slice(0, 20000)
      );
      if (chatApplyControl || (chatbotWidget && /chat to apply|text to apply/.test(pageTxt))) {
        console.log('PJA ext-apply: chatbot apply detected — skipping for manual follow-up');
        await recordResult(job, { success: false, reason: 'chatbot_apply_manual' });
        navigateBack(job);
        return;
      }
    }

    if (!hasFormInputs && descClicks < 3 && !isWorkdaySite) {
      // On a job description page — find and click the Apply button to get to the actual form.
      // POLL for it: many ATS pages redirect (e.g. icims.com → careers.<co>.com) and/or render
      // the Apply button via JS a few seconds after load. A one-shot check evaluates the
      // intermediate/unrendered page and wrongly reports "no apply button". Retry for ~12s.
      const APPLY_RE = /^apply$|apply now|apply for this|apply for job|apply for position|apply today|apply here|apply online|apply to this|start application|i'?m interested|apply to job/i;
      const findApply = () => findButton(APPLY_RE)
        || Array.from(document.querySelectorAll('a[href]')).find(a => /\bapply\b/i.test(a.textContent.trim()) && !/sign.?in|log.?in|already applied/i.test(a.textContent))
        || Array.from(document.querySelectorAll('[role=button],[data-test*="apply" i],[class*="apply" i]')).find(b => b.offsetParent !== null && APPLY_RE.test((b.textContent || b.getAttribute('aria-label') || '').trim()));
      let applyBtn = null;
      for (let i = 0; i < 16 && !applyBtn; i++) {
        applyBtn = findApply();
        if (!applyBtn) await sleep(800);
      }
      if (applyBtn) {
        // Increment click counter so we don't loop forever
        await new Promise(resolve => chrome.storage.local.get('pja_ext_current', d => {
          const cur = d.pja_ext_current || job;
          cur._descClicks = descClicks + 1;
          chrome.storage.local.set({ pja_ext_current: cur }, resolve);
        }));
        const dbgLog = entries => chrome.storage.local.get('pja_dbg', d => {
          const arr = (d.pja_dbg || []).slice(-20);
          arr.push(...entries);
          chrome.storage.local.set({ pja_dbg: arr });
        });
        dbgLog([`applyBtn.click url=${location.href.slice(0,80)} btn="${applyBtn.textContent?.trim().slice(0,30)}"`]);
        // Many job-description "Apply" links open the real application in a NEW TAB
        // (target=_blank, e.g. SmashFly/Phenom → SuccessFactors). The queue only tracks
        // THIS tab, so a new tab would stall the run. Neutralize the new-tab behavior so
        // the application loads in-place and the queue tab follows it.
        if (applyBtn.tagName === 'A') {
          applyBtn.removeAttribute('target');
          const href = applyBtn.getAttribute('href');
          if (href && /^https?:\/\//i.test(href)) { window.location.href = href; }
          else { applyBtn.click(); }
        } else {
          applyBtn.click();
        }
        // Wait up to 12s for form to appear (SPA or full page nav)
        // Do NOT return early on URL change: Greenhouse/Lever use SPA pushState,
        // meaning URL changes but the same document continues — we need to keep waiting.
        const FORM_SEL = 'form input:not([type=hidden]):not([type=file]), form select, form textarea, input[required]:not([type=hidden]):not([type=file]), select[required], textarea[required]';
        for (let i = 0; i < 24; i++) {
          await sleep(500);
          // Full page navigation (e.g. Workday) invalidates the extension context.
          // When that happens, chrome.runtime.id becomes undefined — bail silently
          // so the new page's content script handles the job from scratch.
          try { if (!chrome.runtime?.id) return; } catch(_) { return; }
          dbgLog([`loop i=${i} url=${location.href.slice(0,80)} formSel=${!!document.querySelector(FORM_SEL)}`]);
          console.log('PJA ext-apply: wait-loop i=' + i + ' url=' + location.href.slice(0, 70));
          // Workday "Start Your Application" intermediary page — click "Apply Manually"
          const applyManuallyBtn = document.querySelector('[data-automation-id="applyManually"]')
            || Array.from(document.querySelectorAll('a,button')).find(el => /apply\s+manually/i.test(el.textContent.trim()));
          if (applyManuallyBtn) {
            console.log('PJA ext-apply: found Workday applyManually intermediary — clicking');
            applyManuallyBtn.click();
            i = 0; // reset counter and keep waiting for the login/form to appear
            continue;
          }
          if (document.querySelector(FORM_SEL)) {
            // SPA rendered the form — fill it directly
            await sleep(800);
            if (typeof pjaFillForm === 'function') {
              pjaFillForm(profile, answers);
              retryPhoneFill(profile);
            }
            if (typeof pjaFillUnknownTextFields === 'function') {
              const jobCtx = { title: job.title || '', company: job.company || '' };
              await new Promise(resolve => pjaFillUnknownTextFields(profile, answers, jobCtx, () => resolve()));
            }
            if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
            if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback();
            if (typeof pjaAutoCheckConsent === 'function') pjaAutoCheckConsent();
            if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
            if (typeof pjaForceCountryField === 'function') { const n = await pjaForceCountryField(profile.country || 'United States'); if (n) await addDbg('[country] forced via fiber n=' + n); }
            await sleep(500);
            let missing2 = findMissingRequired();
            if (missing2.length) {
              await pjaAnswerRequiredViaAI(job);
              await sleep(600);
              missing2 = findMissingRequired();
            }
            if (missing2.length) {
              await saveMissingQuestions(missing2, job);
              await recordResult(job, { success: false, reason: 'missing_required', fields: missing2.map(m => m.label) });
              navigateBack(job);
              return;
            }
            const submitBtn2 = findButton(/submit.*application|submit.*app|apply now|send application|complete application/i);
            if (!submitBtn2) { await recordResult(job, { success: false, reason: 'no_submit_after_spa' }); navigateBack(job); return; }
            submitBtn2.click();
            await sleep(4000);
            const success2 = /thank you|your application|received|submitted|confirmation|successfully/i.test(document.body.innerText);
            await recordResult(job, { success: success2, reason: success2 ? 'applied' : 'submit_unclear' });
            navigateBack(job);
            return;
          }
        }
        // Neither navigation nor form appeared — give up on this job.
        // DIAGNOSTIC: dump what IS in the DOM so a filler can be built for this ATS.
        try {
          const allInputs = Array.from(document.querySelectorAll('input,select,textarea'))
            .filter(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(_) { return true; } })
            .slice(0, 20)
            .map(el => (el.tagName.toLowerCase() + '[' + (el.type||'') + ']#' + (el.id||'') + '.n=' + (el.name||'') + '.ph=' + (el.placeholder||el.getAttribute('aria-label')||'').slice(0,20)));
          const iframes = Array.from(document.querySelectorAll('iframe')).map(f => (f.src||'').slice(0, 60));
          const btns = Array.from(document.querySelectorAll('button,a[role=button],[type=submit]')).map(b => (b.textContent||'').trim().slice(0,20)).filter(Boolean).slice(0,12);
          dbgLog(['[noform] inputs(' + allInputs.length + '): ' + allInputs.join(' | ')]);
          dbgLog(['[noform] iframes: ' + iframes.join(' | ')]);
          dbgLog(['[noform] buttons: ' + btns.join(' | ')]);
        } catch(_) {}
        console.log('PJA ext-apply: apply_btn_no_form, calling recordResult');
        sessionStorage.setItem('pja_last_action', 'recordResult:apply_btn_no_form:' + job.company);
        await recordResult(job, { success: false, reason: 'apply_btn_no_form' });
        navigateBack(job);
        return;
      }
      // No apply button found on description page — log all candidate controls (durable, to pja_dbg)
      const cand = Array.from(document.querySelectorAll('button,a[href],[role=button],input[type=submit]'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.tagName[0] + ':' + (b.textContent || b.value || b.getAttribute('aria-label') || '').trim()).slice(0, 30))
        .filter(s => s.length > 2).slice(0, 14);
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push(new Date().toISOString().slice(11,19)+' [EXT] no_apply_btn host='+location.hostname+' cand=['+cand.join(' | ')+']'); chrome.storage.local.set({pja_dbg:a}, r); }));
      console.log('PJA ext-apply: no_apply_btn_on_description. Buttons:', cand.join('|'));
      sessionStorage.setItem('pja_last_action', 'recordResult:no_apply_btn:' + job.company);
      await recordResult(job, { success: false, reason: 'no_apply_btn_on_description' });
      navigateBack(job);
      return;
    }

    // --- Handle login/sign-in forms first ---

    // Check if this is a post-Gmail-verification resume
    const { pja_wd_verify_result: _wdVerifyResult, pja_wd_pending_apply: _wdPendingApply } =
      await new Promise(r => chrome.storage.local.get(['pja_wd_verify_result', 'pja_wd_pending_apply'], r));

    if (_wdVerifyResult && _wdPendingApply &&
        _wdPendingApply.hostname === location.hostname &&
        _wdVerifyResult.hostname === location.hostname &&
        _wdVerifyResult.success === true &&
        Date.now() - _wdVerifyResult.ts < 120000) {
      await new Promise(r => chrome.storage.local.remove(['pja_wd_verify_result', 'pja_wd_pending_apply'], r));
      console.log('PJA ext-apply: resuming after Gmail verification, continuing apply flow');
      // Fall through — auth is now complete
    } else {

    // Capture page structure before handleSignIn for debugging
    const preSignInBtns = Array.from(document.querySelectorAll('button, input[type=password], input[data-automation-id]'))
      .map(el => el.tagName + ':' + (el.getAttribute('data-automation-id') || el.type || '') + ':' + (el.textContent||'').trim().slice(0,30))
      .filter(Boolean).slice(0, 20);
    await new Promise(r => chrome.storage.local.set({ pja_dbg_preauth: { url: location.href.slice(0,120), elems: preSignInBtns, ts: Date.now() } }, r));

    // ── Auth routing ────────────────────────────────────────────────────────────
    const isWorkday = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);

    if (isWorkday && typeof window.pjaWorkdayAuth !== 'undefined') {
      const { pja_job_password: _storedPw } = await new Promise(r =>
        chrome.storage.local.get('pja_job_password', r)
      );
      const jobPassword = _storedPw || 'ChangeMe#2025!';

      const authResult = await window.pjaWorkdayAuth.run(profile, jobPassword);
      console.log('PJA ext-apply: pjaWorkdayAuth result:', authResult);
      await new Promise(r => chrome.storage.local.set({
        pja_dbg_workday_auth: { result: authResult, url: location.href.slice(0, 120), ts: Date.now() }
      }, r));

      if (authResult === 'signed_in' || authResult === 'account_created_verified') {
        // Workday SPA: after auth the application form may take a few seconds to hydrate.
        // Poll until we see either form fields or the bottomNavigation elements.
        // Only match apply-form-specific elements — NOT selectinput (also present on auth forms).
        const WD_FORM_SEL = '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="bottomNavigationNext"], [data-automation-id="bottomNavigationSubmit"], [data-automation-id="progressBar"]';
        const WD_AUTH_SEL = 'input[data-automation-id="email"], input[type=password], [data-automation-id="createAccountLink"]';
        let wdWait = 0;
        while (wdWait++ < 20) {
          // After sign-in, Workday sometimes shows "Apply Manually" choice before the form.
          // Click it and reset the counter so we keep waiting for the actual form.
          const applyManBtn = document.querySelector('[data-automation-id="applyManually"]');
          if (applyManBtn) {
            console.log('PJA ext-apply: WD post-signin start_application — clicking applyManually');
            applyManBtn.click();
            wdWait = 0;
            await sleep(500);
            continue;
          }
          if (document.querySelector(WD_FORM_SEL)) break;
          if (document.querySelector(WD_AUTH_SEL)) { /* went back to auth page — unexpected */ break; }
          await sleep(500);
        }
        const wdFormFound = !!document.querySelector(WD_FORM_SEL);
        const wdAuthFound = !!document.querySelector(WD_AUTH_SEL);
        console.log('PJA ext-apply: Workday form wait done after', wdWait * 500, 'ms', 'formFound:', wdFormFound, 'authFound:', wdAuthFound);
        await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
          const arr = (d.pja_dbg || []).slice(-19);
          arr.push('[ext] WD form wait done: iters=' + wdWait + ' formFound=' + wdFormFound + ' authFound=' + wdAuthFound + ' url=' + location.pathname.slice(-40));
          chrome.storage.local.set({ pja_dbg: arr }, r);
        }));
        // Extra hydration wait: progressBar appears before form fields render. Give it 3s.
        if (wdFormFound) await sleep(3000);
        // Some tenants (e.g. AMAT) redirect to the External home/search after sign-in and
        // drop the apply context. If we're NOT on the form and NOT on an apply path,
        // re-navigate to the job's apply URL to resume (now signed in). Cap re-navs to avoid loops.
        // BUT never re-nav on a post-submit/confirmation page (that means we already applied).
        const onCompletedPage = /\/completed\/|\/confirmation|thankyou/i.test(location.pathname) ||
          /view my applications|application.*submitted|thank you for (applying|your)/i.test(document.body?.innerText || '');
        if (!wdFormFound && !onCompletedPage && job.applyUrl && !/\/apply(\/|$)/.test(location.pathname)) {
          let renav = 0;
          try { renav = parseInt(sessionStorage.getItem('pja_wd_renav_' + (job.id||'')) || '0', 10); } catch(_) {}
          if (renav < 2) {
            try { sessionStorage.setItem('pja_wd_renav_' + (job.id||''), String(renav + 1)); } catch(_) {}
            await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-19); a.push('[ext] post-signin re-nav to applyUrl attempt ' + (renav+1)); chrome.storage.local.set({pja_dbg:a}, r); }));
            location.href = job.applyUrl;
            return; // page reloads; external-apply re-runs, now signed in → reaches the form
          }
        }
        // Fall through to form fill
      } else if (authResult === 'needs_gmail_verify') {
        // Gmail verification in progress — store pending apply context (no password)
        await new Promise(r => chrome.storage.local.set({
          pja_wd_pending_apply: {
            applyUrl: job.applyUrl,
            jobId: job.id,
            hostname: location.hostname,
            ts: Date.now()
          }
        }, r));
        return; // Background will reload this tab when verification completes
      } else if (authResult === 'sso_only') {
        await recordResult(job, { success: false, reason: 'google_sso_only' });
        navigateBack(job); return;
      } else if (authResult === 'locked') {
        await recordResult(job, { success: false, reason: 'workday_account_locked' });
        navigateBack(job); return;
      } else if (authResult === 'captcha_blocked') {
        await recordResult(job, { success: false, reason: 'workday_captcha' });
        navigateBack(job); return;
      } else {
        await recordResult(job, { success: false, reason: `workday_auth_${authResult}` });
        navigateBack(job); return;
      }
    } else if (!isWorkday) {
      const handled = await handleSignIn(profile);
      console.log('PJA ext-apply: handleSignIn result:', handled);
      await new Promise(r => chrome.storage.local.set({
        pja_dbg_signin: { result: handled, url: location.href.slice(0, 120), ts: Date.now() }
      }, r));
      if (handled === 'needs_password') {
        await recordResult(job, { success: false, reason: 'needs_login' });
        navigateBack(job); return;
      }
      if (handled === 'google_sso_only') {
        await recordResult(job, { success: false, reason: 'google_sso_only' });
        navigateBack(job); return;
      }
    }
    // ── End auth — continue to form fill ────────────────────────────────────────

    } // end post-Gmail-verification else block

    // EARLY post-submit detection: if we (re)landed on a confirmation/completed page for this
    // job, it's already submitted — record applied and advance, before the form/step-loop runs.
    {
      const onDone = /\/completed\/|\/confirmation/i.test(location.pathname) ||
        /application submitted|we have received your application|view my applications|thank you for applying|you have applied/i.test(document.body?.innerText || '');
      if (onDone) {
        // Real submit only if THIS tab clicked Submit for this job in this run — detected by the
        // persistent per-job flag set at the step-loop Submit click (survives the navigation to
        // /completed/, unlike sessionStorage.pja_last_action which later iterations overwrite),
        // OR the sessionStorage marker as a fallback. Landing on /completed/ WITHOUT having
        // clicked Submit this run (a req applied in a PAST session) is NOT a new application →
        // already_applied, so the tally isn't inflated.
        const submitFlagKey = 'pja_wd_submitclick_' + (job.id || job.jobId || '');
        const submitClickTs = await new Promise(r => chrome.storage.local.get(submitFlagKey, d => r(d[submitFlagKey])));
        const realSubmit = pjaPrevAction.startsWith('ready_to_submit:') || (submitClickTs && (Date.now() - submitClickTs) < 180000);
        if (submitClickTs) { try { await new Promise(r => chrome.storage.local.remove(submitFlagKey, r)); } catch (_) {} }
        const verdict = realSubmit ? 'applied' : 'already_applied (prior session)';
        await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-19); a.push('[ext] early confirmation → ' + verdict + ': ' + job.company + ' ' + (job.id || '')); chrome.storage.local.set({pja_dbg:a}, r); }));
        sessionStorage.setItem('pja_last_action', 'recordResult:' + (realSubmit ? 'applied' : 'already_applied') + ':' + job.company);
        await recordResult(job, realSubmit
          ? { success: true, reason: 'applied' }
          : { success: false, reason: 'already_applied' });
        navigateBack(job);
        return;
      }
    }

    // --- Fill all form fields ---
    await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19);
      arr.push('[ext] form fill start: pjaFillForm=' + typeof pjaFillForm + ' url=' + location.pathname.slice(-40));
      chrome.storage.local.set({ pja_dbg: arr }, r);
    }));
    if (typeof pjaFillForm === 'function') {
      window._pjaComboChain = Promise.resolve(); // reset sequential combobox queue
      pjaFillForm(profile, answers);
      // Await sequential combobox fills (each takes up to ~550ms; 8 comboboxes ≈ 4.4s max)
      if (window._pjaComboChain) await window._pjaComboChain;
      await sleep(300);
      // Phone retry: fill any still-empty phone fields (uses label-classification, not just type/id)
      retryPhoneFill(profile);
      await sleep(200);
      // SECOND PASS — Greenhouse (and others) render sections like Education AFTER the
      // initial fill, so their comboboxes (School/Degree/Discipline) were absent the first
      // time. Re-run the fill to catch late-rendered fields, then await the combo chain.
      await sleep(800);
      window._pjaComboChain = Promise.resolve();
      pjaFillForm(profile, answers);
      if (window._pjaComboChain) await window._pjaComboChain;
      await sleep(300);
      // Greenhouse Education react-selects render late + ignore programmatic sets —
      // dedicated late pass (degree/discipline reliable; school best-effort).
      try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[gh-edu] call reached, typeof='+(typeof pjaFillGreenhouseEducation)+' host='+location.hostname); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
      if (typeof pjaFillGreenhouseEducation === 'function') {
        try { await pjaFillGreenhouseEducation(profile); } catch(e) { try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[gh-edu] ERROR '+(e.message||e)); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){} }
      }
    }

    // --- AI-fill open-ended required questions not in profile/answer bank ---
    if (typeof pjaFillUnknownTextFields === 'function') {
      const jobCtx = { title: job.title || '', company: job.company || '' };
      await new Promise(resolve => pjaFillUnknownTextFields(profile, answers, jobCtx, () => resolve()));
      await sleep(300);
    }

    // --- Best-effort resume upload ---
    await tryInjectResume(profile, answers);

    // --- Workday Application Questions (formField-* dropdowns) ---
    await pjaFillWorkdayAppQuestions(profile);

    // --- Workday Work Experience subsection (My Experience step) ---
    await pjaFillWorkdayWorkExperience(profile);

    // --- Fallback fills ---
    if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
    if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback();
    if (typeof pjaAutoCheckConsent === 'function') pjaAutoCheckConsent();
    // Combobox fallback: required comboboxes still empty after all above — fill Yes/No by pattern
    pjaFillRequiredComboboxFallback(profile, answers);

    await sleep(500);

    // --- Multi-step: handle Next button if needed ---
    const addDbg = msg => new Promise(r => chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19); arr.push(msg); chrome.storage.local.set({ pja_dbg: arr }, r);
    }));
    let steps = 0;
    let stuckOnWdSelectinput = false;
    await addDbg('[ext] step-loop start url=' + location.pathname.slice(-40));
    while (steps++ < 8) {
      // Workday uses click_filter divs as interactive "Next" buttons
      const wdNextClickFilter = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
        .find(el => /^next$|^continue$|save.*continue/i.test(el.getAttribute('aria-label') || ''));
      const nextBtn = wdNextClickFilter
        || document.querySelector('[data-automation-id="bottomNavigationNext"]')
        || document.querySelector('[data-automation-id="pageFooterNextButton"]')
        || findButton(/^next$|^continue$|^next step$|^save and continue$|^save & continue$|^proceed$|^proceed to next/i);
      if (!nextBtn) {
        // Consent/terms wall (e.g. Jobvite privacy gate): the only actionable button is
        // "I Accept"/"Agree" and the real form renders after it. Click it and re-loop
        // instead of breaking — but only once per step count to avoid a click loop.
        const consentBtn = findButton(/^i accept$|^accept( all)?$|^i agree$|^agree( and continue)?$|^accept (and|&) continue$/i);
        if (consentBtn) {
          await addDbg('[ext] step-loop: consent wall — clicking "' + (consentBtn.textContent || '').trim().slice(0, 20) + '"');
          consentBtn.click();
          await sleep(2500);
          if (typeof pjaFillForm === 'function') { try { pjaFillForm(profile, answers); } catch (_) {} }
          await sleep(800);
          continue;
        }
        const diagBtns = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||b.getAttribute('aria-label')||'').trim().slice(0,20)).filter(Boolean).slice(0,8);
        const diagCFs = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]')).map(cf => cf.getAttribute('aria-label')||'noLabel').slice(0,5);
        const diagBotNext = !!document.querySelector('[data-automation-id="bottomNavigationNext"]');
        const diagBotSub = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]');
        const diagFooter = !!document.querySelector('[data-automation-id="pageFooterNextButton"]');
        const diagStepText = document.body.innerText.match(/current step \d+/i)?.[0] || '?';
        await addDbg('[ext] step-loop break: no nextBtn step=' + steps + ' btns=[' + diagBtns.join('|') + '] cf=' + diagCFs.join('|') + ' botNext=' + diagBotNext + ' botSub=' + diagBotSub + ' footer=' + diagFooter + ' pg=' + diagStepText);
        break;
      }
      // Fill Workday Work Experience fields at the top of each iteration — they render
      // late (after step transition) so the initial fill pass misses them. Idempotent.
      if (typeof pjaFillWorkdayWorkExperience === 'function') { await pjaFillWorkdayWorkExperience(profile); await sleep(300); }
      const missing = findMissingRequired();
      // Workday selectinput fields can't be opened via JS — try Next anyway and let Workday validate.
      let hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
      if (hardMissing.length) {
        // Some required fields render AFTER the initial fill pass — e.g. Workday's
        // "My Experience" Work Experience subsection (workExperience-N--jobTitle/company/...).
        // Re-run the fillers once and re-check before bailing.
        await addDbg('[ext] hardMissing=' + hardMissing.map(m=>m.label).join('|') + ' — re-filling late fields');
        if (typeof pjaFillWorkdayWorkExperience === 'function') await pjaFillWorkdayWorkExperience(profile);
        pjaFillForm(profile, answers);
        await sleep(900);
        pjaFillRequiredComboboxFallback(profile, answers);
        await sleep(400);
        hardMissing = findMissingRequired().filter(m => m.type !== 'wd_selectinput');
        // Still-missing required fields → answer them with AI (profile + resume + prefs), then re-check.
        if (hardMissing.length) {
          await pjaAnswerRequiredViaAI(job);
          await sleep(600);
          hardMissing = findMissingRequired().filter(m => m.type !== 'wd_selectinput');
        }
        if (hardMissing.length) { await addDbg('[ext] step-loop break: hardMissing(after AI)=' + hardMissing.map(m=>m.label).join('|')); break; }
        await addDbg('[ext] re-fill+AI cleared hardMissing, continuing');
      }
      // If WD selectinput fields are missing, note the step text to detect if Workday blocks us.
      const stepTextBefore = (document.body.innerText.match(/current step (\d+)/i)?.[1] || '');
      const wdSelectMissing = missing.filter(m => m.type === 'wd_selectinput');
      const nextBtnDisabled = !!(nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true');
      const nextBtnText = (nextBtn.textContent || nextBtn.getAttribute('aria-label') || '').trim().slice(0,30);
      const nextBtnAid = nextBtn.getAttribute('data-automation-id') || '';
      const isWorkdayHost = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
      // SID form detected by its unique fields (disability checkbox + date spinner).
      const isWorkdaySidStep = isWorkdayHost && (
        !!document.querySelector('[data-automation-id="formField-dateSignedOn"]') ||
        !!document.querySelector('[data-automation-id="formField-disabilityStatus"]')
      );
      await addDbg('[ext] step ' + steps + ' clicking Next step=' + stepTextBefore + ' wdMissing=' + wdSelectMissing.map(m=>m.label).join('|') + ' btn=' + nextBtnAid + '/' + nextBtnText + (nextBtnDisabled ? '[DISABLED]' : '') + (isWorkdaySidStep ? '[SID-CDP]' : ''));
      // If THIS click is the final Submit (Workday multi-step forms submit via the footer/bottom
      // Submit button in the step loop), record a PERSISTENT per-job "submitted this run" flag so
      // the early-confirmation on the next /completed/ load records APPLIED — not already_applied.
      // sessionStorage.pja_last_action is too fragile (later step-loop iterations overwrite it
      // before /completed/ loads); chrome.storage.local survives the navigation intact.
      if (/submit/i.test(nextBtnText) || nextBtnAid === 'bottomNavigationSubmit') {
        try { sessionStorage.setItem('pja_last_action', 'ready_to_submit:' + job.company); } catch (_) {}
        try { await new Promise(r => chrome.storage.local.set({ ['pja_wd_submitclick_' + (job.id || job.jobId || '')]: Date.now() }, r)); } catch (_) {}
      }
      const preClickUrl = location.href;
      if (isWorkdaySidStep && nextBtnAid) {
        // SID form React handlers check isTrusted — synthetic events are ignored.
        // Other Workday steps work fine with synthetic events (CDP double-fires and breaks them).
        await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'WORKDAY_TRUSTED_CLICK',
            selector: '[data-automation-id="' + nextBtnAid + '"]'
          }, () => resolve());
        });
      } else {
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(evtType => {
          const evt = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
          nextBtn.dispatchEvent(evt);
        });
      }
      // Poll for step advance — Workday SID/EEO transitions can be slow (5s+).
      await new Promise(resolve => {
        let waited = 0;
        const poll = setInterval(() => {
          waited += 250;
          const errFound = isWorkdayHost &&
            Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
          const stepNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          const advanced = stepTextBefore ? stepNow !== stepTextBefore : false;
          const urlChanged = location.href !== preClickUrl;
          if (errFound || advanced || urlChanged || waited >= 20000) { clearInterval(poll); resolve(); }
        }, 250);
      });
      // Detect Workday validation errors after clicking Next:
      const wdValidationError = isWorkdayHost &&
        Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
      if (wdValidationError) {
        // Wait for Workday to re-render the form after showing "Errors Found".
        await new Promise(r => setTimeout(r, 2000));
        // Log which fields have Workday error markers to diagnose the actual failing field.
        // Include 0x0-size elements (hidden spinbuttons get aria-invalid but have no visible size).
        const errMarkers = Array.from(document.querySelectorAll('[data-automation-id$="-error"], [aria-invalid="true"]'))
          .map(el => {
            const r = el.getBoundingClientRect();
            const aid = el.getAttribute('data-automation-id') || el.getAttribute('aria-label') || el.id || el.tagName;
            return aid.slice(0,30) + (r.width === 0 ? '[0x0]' : '');
          })
          .filter(Boolean).slice(0, 8);
        // Also check disability combobox value after re-render
        const disabInput = document.querySelector('[data-automation-id^="selfIdentifiedDisabilityData--disabilit"] input, [data-automation-id="formField-disabilityStatus"] input');
        const disabVal = disabInput ? disabInput.value : 'not found';
        await addDbg('[ext] SID err markers: ' + (errMarkers.join('|')||'none') + ' disab="' + disabVal.slice(0,30) + '"');

        // General recovery: re-run every filler (work experience, dates, app questions,
        // combobox/radio fallbacks) then retry Next. Handles late-rendered required fields
        // and values that didn't commit before the first Next click.
        await pjaFillWorkdayWorkExperience(profile);
        if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers);
        await sleep(700);
        await pjaFillWorkdayAppQuestions(profile);
        pjaFillRequiredComboboxFallback(profile, answers);
        if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
        await sleep(700);
        {
          const beforeStepG = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          const reNext = document.querySelector('[data-automation-id="pageFooterNextButton"]')
            || document.querySelector('[data-automation-id="bottomNavigationNext"]')
            || findButton(/save and continue|^continue$|^next$/i);
          if (reNext) {
            reNext.click();
            await new Promise(resolve => { let w=0; const p=setInterval(()=>{ w+=250;
              const err=Array.from(document.querySelectorAll('button')).some(b=>/^errors found$/i.test(b.textContent.trim()));
              const sn=document.body.innerText.match(/current step (\d+)/i)?.[1]||'';
              if(!err||(beforeStepG&&sn!==beforeStepG)||w>=6000){clearInterval(p);resolve();} },250); });
            const stillErrG = Array.from(document.querySelectorAll('button')).some(b=>/^errors found$/i.test(b.textContent.trim()));
            if (!stillErrG) { await addDbg('[ext] step '+steps+' general re-fill cleared errors, advanced'); continue; }
            await addDbg('[ext] step '+steps+' general re-fill did NOT clear errors');
          }
        }
        // Re-fill the name field if empty (the most common cause of step 5 Errors Found).
        const nameFieldR = document.querySelector('[data-automation-id="formField-name"] input[type="text"]');
        const fullNameR = profile.fullName || ((profile.firstName||'') + ' ' + (profile.lastName||'')).trim();
        let didRetryName = false;
        if (nameFieldR && !nameFieldR.value && fullNameR) {
          const tempNameIdR = '__pja_name_r_' + Date.now();
          nameFieldR.setAttribute('id', tempNameIdR);
          const retryNameResult = await new Promise(resolve => {
            chrome.runtime.sendMessage({ type: 'WORKDAY_SET_SID', selector: '#' + CSS.escape(tempNameIdR), text: fullNameR }, r => {
              nameFieldR.removeAttribute('id');
              resolve(r || {});
            });
          });
          await addDbg('[ext] SID retry: name val="' + (retryNameResult.valAfter || nameFieldR.value || '').slice(0,15) + '"');
          didRetryName = true;
        } else {
          await addDbg('[ext] SID retry: nameField=' + !!nameFieldR + ' val="' + (nameFieldR?.value||'').slice(0,15) + '" fullName=' + !!fullNameR);
        }
        if (didRetryName || nameFieldR?.value) {
          nextBtn.click();
          await new Promise(resolve => {
            let w2 = 0;
            const p2 = setInterval(() => {
              w2 += 250;
              const errAgain = Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
              const stepNow2 = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
              if (!errAgain || (stepTextBefore && stepNow2 !== stepTextBefore) || w2 >= 5000) { clearInterval(p2); resolve(); }
            }, 250);
          });
          const stillErr = Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
          const stepAfterRetry = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          if (!stillErr) {
            await addDbg('[ext] step ' + steps + ' SID retry advanced to=' + stepAfterRetry);
            continue;
          }
        }
        const pageText = document.body.innerText.toLowerCase();
        // True resume step requires an actual file upload control, not just the word "resume" in text
        const hasFileUpload = !!document.querySelector('input[type="file"], [data-automation-id*="upload"], [data-automation-id*="resume-upload"], [class*="file-upload"], [class*="drop-zone"]');
        const isResumeStep = hasFileUpload && /resume|upload.*document|attach.*file|cv.*required|add.*resume/i.test(pageText);
        await addDbg('[ext] step ' + steps + ' Errors Found detected' + (isResumeStep ? ' (resume step)' : ''));
        stuckOnWdSelectinput = true;
        if (isResumeStep) { stuckOnWdSelectinput = 'resume'; }
        break;
      }
      if (stepTextBefore) {
        const stepTextAfter = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
        const urlAfter = location.href;
        if (urlAfter !== preClickUrl) {
          await addDbg('[ext] step ' + steps + ' url-advance: ' + urlAfter.slice(-50));
          // After SPA url-advance, check if we're on a submit/review page.
          // If so, break the step-loop so the submit section handles the final submission.
          const hasSubmitCF = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
            .some(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || ''));
          const hasSubmitBtn = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]')
            || !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
          if (hasSubmitCF || hasSubmitBtn) {
            await addDbg('[ext] step ' + steps + ' url-advance→submit page, breaking to submit section');
            break;
          }
          // Otherwise, run fill pass for the new page (e.g. terms checkbox on review page).
          await sleep(500);
          if (typeof pjaAutoCheckConsent === 'function') pjaAutoCheckConsent();
          await pjaFillWorkdayAppQuestions(profile);
          continue;
        }
        if (stepTextAfter === stepTextBefore) {
          const stuckBtns = Array.from(document.querySelectorAll('button,[data-automation-id="click_filter"]'))
            .map(b => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0,25)).filter(Boolean).slice(0,6);
          await addDbg('[ext] step ' + steps + ' stuck: stepText=' + stepTextBefore + ' url=' + location.href.slice(-40) + ' btns=' + stuckBtns.join('|'));
          stuckOnWdSelectinput = true;
          break;
        }
      }
      await addDbg('[ext] step ' + steps + ' advanced to=' + (document.body.innerText.match(/current step (\d+)/i)?.[1] || '?'));
      // Wait for new step's fields to render before filling (Workday animates transitions)
      await new Promise(resolve => {
        let waited = 0;
        const poll = setInterval(() => {
          waited += 150;
          const visibleFields = document.querySelectorAll(
            'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]):not([type=reset]):not([type=radio]):not([type=checkbox]),select,textarea'
          );
          const anyVisible = Array.from(visibleFields).some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          if (anyVisible || waited >= 3000) { clearInterval(poll); resolve(); }
        }, 150);
      });
      if (typeof pjaFillForm === 'function') {
        window._pjaComboChain = Promise.resolve();
        pjaFillForm(profile, answers);
        if (window._pjaComboChain) await window._pjaComboChain;
        await sleep(300);
      }
      if (typeof pjaFillUnknownTextFields === 'function') {
        const jobCtx = { title: job.title || '', company: job.company || '' };
        await new Promise(resolve => pjaFillUnknownTextFields(profile, answers, jobCtx, () => resolve()));
      }
      if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
      // Workday Application Questions: work auth / sponsorship radios often lack aria-required.
      // Fill all unchecked radio fieldsets that match key patterns, ignoring required attribute.
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        const wdRadioLog = [];
        for (const fs of document.querySelectorAll('fieldset')) {
          const radios = Array.from(fs.querySelectorAll('input[type=radio]'));
          if (!radios.length || radios.some(r => r.checked)) continue;
          const legend = (fs.querySelector('legend')?.textContent || '').toLowerCase().trim();
          if (!legend) continue;
          let defaultVal = null;
          if (/authoriz|eligible|legally|legal right/i.test(legend)) defaultVal = 'Yes';
          else if (/sponsor/i.test(legend)) defaultVal = 'No';
          else if (/relocat/i.test(legend)) defaultVal = profile.willingToRelocate === 'Yes' ? 'Yes' : 'No';
          else if (/background check|drug test|drug screen/i.test(legend)) defaultVal = 'Yes';
          else if (/certif|licens|credential/i.test(legend)) defaultVal = 'Yes';
          if (!defaultVal) {
            const vals = radios.map(r => r.value?.toLowerCase());
            if (vals.includes('yes') && vals.includes('no')) defaultVal = 'Yes';
          }
          if (!defaultVal) continue;
          const target = radios.find(r => (r.value || r.nextSibling?.textContent || '').toLowerCase().startsWith(defaultVal.toLowerCase()))
            || (defaultVal === 'Yes' ? radios[0] : radios[radios.length - 1]);
          if (target && typeof pjaClickRadio === 'function') {
            pjaClickRadio(target);
            wdRadioLog.push(legend.slice(0,30) + '→' + defaultVal);
          }
        }
        if (wdRadioLog.length) await addDbg('[ext] WD radio fill: ' + wdRadioLog.join(', '));
      }
      if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback();
      if (typeof pjaAutoCheckConsent === 'function') pjaAutoCheckConsent();
      await pjaFillWorkdayAppQuestions(profile);
      await tryInjectResume(profile, answers);
      // Wait for the next step's navigation button to appear (up to 3s).
      // Steps with no text inputs exit the field-wait early, but the nav button
      // (e.g. Workday EEO/SID steps) may render after a delayed React state update.
      await new Promise(resolve => {
        let waited = 0;
        const navPoll = setInterval(() => {
          waited += 200;
          const hasNav = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
            .some(el => /^next$|^continue$|save.*continue|submit/i.test(el.getAttribute('aria-label') || ''))
            || !!document.querySelector('[data-automation-id="bottomNavigationNext"],[data-automation-id="bottomNavigationSubmit"],[data-automation-id="pageFooterNextButton"]')
            || !!Array.from(document.querySelectorAll('button[type=submit],button[type=button],button'))
                .find(b => !b.disabled && /^next$|^continue$|save.*continue|^submit/i.test((b.textContent||b.getAttribute('aria-label')||'').trim()));
          if (hasNav || waited >= 3000) { clearInterval(navPoll); resolve(); }
        }, 200);
      });
    }

    // --- Check missing required fields ---
    await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19);
      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden])'));
      const inputDesc = inputs.map(el => {
        const aid = el.getAttribute('data-automation-id') || '';
        const uxi = el.getAttribute('data-uxi-widget-type') || '';
        const lbl = el.getAttribute('aria-label') || el.id || el.name || aid || '';
        const req = el.required || el.getAttribute('aria-required') === 'true' ? '*' : '';
        const r = el.getBoundingClientRect();
        return el.type + req + '[' + Math.round(r.width) + 'x' + Math.round(r.height) + ']' +
               (uxi ? '{'+uxi+'}' : '') + (lbl ? '('+lbl.slice(0,25)+')' : '');
      }).join(', ');
      // Also capture key Workday automation IDs on current step
      const wdAids = Array.from(document.querySelectorAll('[data-automation-id]'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => el.getAttribute('data-automation-id'))
        .filter((a,i,arr2) => arr2.indexOf(a) === i)
        .slice(0, 15).join('|');
      arr.push('[ext] pre-check inputs(' + inputs.length + '): ' + inputDesc.slice(0, 120));
      arr.push('[ext] pre-check aids: ' + wdAids.slice(0, 200));
      chrome.storage.local.set({ pja_dbg: arr }, r);
    }));
    // Commit the Greenhouse Country react-select via the fiber bridge before checking required
    // fields — the normal fill paths miss it (searchable 244-option select → country-error → the
    // whole submit is silently blocked even though every question is answered).
    if (typeof pjaForceCountryField === 'function') {
      const cf = await pjaForceCountryField((job.profile && job.profile.country) || 'United States');
      if (cf) { await addDbg('[country] forced via fiber n=' + cf); await sleep(300); }
    }
    let missing = findMissingRequired();
    let hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
    // Answer any still-missing required fields with AI (profile + resume + prefs), then re-check.
    if (hardMissing.length) {
      await pjaAnswerRequiredViaAI(job);
      await sleep(600);
      if (typeof pjaForceCountryField === "function") await pjaForceCountryField((job.profile && job.profile.country) || 'United States');
      missing = findMissingRequired();
      hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
    }
    if (hardMissing.length) {
      console.log('PJA ext-apply: missing_required, fields:', hardMissing.map(m => m.label).join('; '));
      sessionStorage.setItem('pja_last_action', 'recordResult:missing_required:' + job.company);
      await saveMissingQuestions(hardMissing, job);
      await recordResult(job, { success: false, reason: 'missing_required', fields: hardMissing.map(m => m.label) });
      navigateBack(job);
      return;
    }
    // If Workday's Next button was blocked (validation error or stuck step), record it properly.
    // Exception: if the page now has a submit button (e.g. SID form advanced to review page via
    // SPA nav without changing URL/step-text), fall through to the submit section below.
    if (stuckOnWdSelectinput) {
      const wdSubmitNow = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
        .find(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || ''))
        || document.querySelector('[data-automation-id="bottomNavigationSubmit"]')
        || findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
      if (wdSubmitNow) {
        await addDbg('[ext] stuck but submit btn found, falling through to submit');
        // fall through to submit section
      } else {
        const wdFields = missing.map(m => m.label);
        const isResume = stuckOnWdSelectinput === 'resume';
        const reason = isResume ? 'missing_resume' : 'wd_selectinput_blocked';
        const fields = isResume ? ['resume_required'] : (wdFields.length ? wdFields : ['unknown_wd_fields']);
        console.log('PJA ext-apply: WD blocked form advance reason=' + reason, 'fields:', fields.join('; '));
        sessionStorage.setItem('pja_last_action', 'recordResult:' + reason + ':' + job.company);
        if (missing.length) await saveMissingQuestions(missing, job);
        await recordResult(job, { success: false, reason, fields });
        navigateBack(job);
        return;
      }
    }

    // If the step-loop already clicked the final Submit (on Workday the review-page Submit
    // IS the pageFooterNextButton), we're now on the confirmation page → record as applied.
    {
      const alreadySubmitted = /\/completed\/|\/confirmation/i.test(location.pathname) ||
        /view my applications|your application (has been|was) submitted|thank you for applying|application received|you have applied/i.test(document.body?.innerText || '');
      if (alreadySubmitted) {
        await addDbg('[ext] post-submit confirmation detected → applied: ' + job.company);
        sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
        await recordResult(job, { success: true, reason: 'applied' });
        navigateBack(job);
        return;
      }
    }

    // --- Submit ---
    // Workday: the submit button is a click_filter div (role=button), not a <button>.
    // Check both the click_filter overlay and the underlying element by automation-id.
    const wdSubmitClickFilter = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
      .find(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || ''));
    const submitBtn = wdSubmitClickFilter
      || document.querySelector('[data-automation-id="bottomNavigationSubmit"]')
      || findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
    if (!submitBtn) {
      // Capture button list and URL to persistent storage for debugging
      const allBtns = pjaQueryAllExt('button, input[type=submit]').map(b => (b.textContent || b.value || '').trim().slice(0,40)).filter(Boolean);
      console.log('PJA ext-apply: no_submit_btn. All buttons:', allBtns.join(' | '));
      await new Promise(r => chrome.storage.local.set({ pja_dbg_nosubmit: { url: location.href.slice(0,120), btns: allBtns.slice(0,15), ts: Date.now() } }, r));
      sessionStorage.setItem('pja_last_action', 'recordResult:no_submit_btn:' + job.company);
      await recordResult(job, { success: false, reason: 'no_submit_btn' });
      navigateBack(job);
      return;
    }

    // Stop-before-submit gate: leave the filled application on screen for review.
    const stopBefore = await new Promise(r => {
      try { chrome.storage.local.get('pja_ext_stop_before_submit', d => r(d.pja_ext_stop_before_submit ?? PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT)); }
      catch(_) { r(PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT); }
    });
    if (stopBefore) {
      console.log('PJA ext-apply: stop-before-submit — leaving form for review:', job.company);
      sessionStorage.setItem('pja_last_action', 'ready_to_submit:' + job.company);
      await recordResult(job, { success: false, reason: 'ready_to_submit_review' });
      // Do NOT navigateBack — leave the completed form on screen for the user.
      return;
    }

    // Pre-mark as handled before click — page nav during submit kills this script,
    // so content.js resumeExtApplyOnLoad can still advance the queue via _handled flag
    job._handled = true;
    try { await new Promise(r => chrome.storage.local.set({ pja_ext_current: job }, r)); } catch(_) {}
    // Optimistic durable-log pre-write: we've passed validation + found the submit button, so
    // record 'submitting' BEFORE the click. If the submit navigates away and kills this script
    // (the Greenhouse under-count case), the entry already exists; the post-submit success path
    // and the resume path both upgrade it to 'applied'. Idempotent, so no duplicate.
    try { await pjaWriteAppliedLog(job, { status: 'submitting', reason: 'submit_clicked' }); } catch(_) {}

    console.log('PJA ext-apply: clicking submit:', submitBtn.textContent.trim().slice(0,40));
    sessionStorage.setItem('pja_last_action', 'submit_clicked:' + job.company);
    const preSubmitUrl = location.href;
    submitBtn.click();

    // Poll every 400ms for up to 8s. Capture success the moment it appears —
    // Greenhouse SPA shows a brief confirmation then navigates away, so a
    // single check after N seconds misses it. Also treat URL change or form
    // disappearance as success signals (redirect = submission went through).
    let success = false;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const hasSubmitButton = pjaQueryAllExt('button[type=submit], input[type=submit]')
        .some(b => /submit/i.test((b.textContent || '') + (b.value || '')));
      const hasFormFields = pjaQueryAllExt('form input, form select, form textarea')
        .some(el => { try { const r = el.getBoundingClientRect(); return el.type !== 'hidden' && r.width > 0 && r.height > 0; } catch (_) { return el.type !== 'hidden'; } });
      if (pjaIsSubmitSuccess({
        text: document.body.innerText, title: document.title, url: location.href,
        preSubmitUrl, hasSubmitButton, hasFormFields, iterations: i
      })) { success = true; break; }
    }
    console.log('PJA ext-apply: post-submit success:', success, '| url:', location.href.slice(0,80), '| pageText snippet:', document.body.innerText.slice(0,120));
    // DIAGNOSTIC: on submit_unclear, dump Greenhouse/ATS validation errors so we can see WHICH
    // field blocked the submit (the form stays up with error text / aria-invalid on the culprit).
    if (!success) {
      try {
        const errEls = pjaQueryAllExt('[aria-invalid="true"], [class*="error"]:not([class*="error-"]), [role="alert"], .field--error, [class*="invalid"]')
          .filter(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(_) { return false; } });
        const errs = errEls.slice(0, 8).map(el => {
          const lbl = (el.getAttribute('aria-label') || el.id || el.name || (el.closest('[class*="field"]')?.querySelector('label')?.textContent) || el.textContent || '').trim().replace(/\s+/g,' ').slice(0, 40);
          return lbl;
        }).filter(Boolean);
        await addDbg('[submit-fail] errs(' + errEls.length + '): ' + errs.join(' | ') + ' | pathHint=' + location.pathname.slice(-24));
      } catch(_) {}
    }
    sessionStorage.setItem('pja_last_action', 'recordResult:submit:' + (success ? 'applied' : 'unclear') + ':' + job.company);
    await recordResult(job, { success, reason: success ? 'applied' : 'submit_unclear' });
    navigateBack(job);
    } catch(e) {
      console.log('PJA ext-apply FATAL ERROR:', e.message, e.stack?.slice(0, 500));
      try { chrome.storage.local.set({ pja_ext_crash: { company: job?.company, error: e.message, url: location.href, ts: Date.now() } }); } catch(_) {}
    }
  }

  // ── Workday Application Questions (formField-* dropdowns) ───────────────
  // These are not <select> or radio — they use button + [role="listbox"] widget.
  // Workday "My Experience" → Work Experience subsection. These fields
  // (workExperience-N--jobTitle / companyName / location / roleDescription) often
  // render AFTER the main fill pass, so pjaFillForm misses them. Fill by automation-id.
  async function pjaFillWorkdayWorkExperience(profile) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
    const qAll = (sel) => (typeof pjaQueryAll === 'function' ? pjaQueryAll(sel) : Array.from(document.querySelectorAll(sel)));
    const setText = (el, val) => {
      if (!el || !val || el.value) return false;
      if (typeof pjaFillTextViaFiber === 'function') { try { pjaFillTextViaFiber(el, val); return true; } catch (_) {} }
      if (typeof pjaSetNative === 'function') { pjaSetNative(el, val); return true; }
      el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    };
    const loc = profile.currentLocation || ((profile.city && profile.state) ? profile.city + ', ' + profile.state : '');

    // Diagnostic: log every work-experience + date input so we can map exact automation-ids.
    const diag = Array.from(qAll('input,textarea,button')).filter(el => {
      const aid = el.getAttribute('data-automation-id') || '';
      return /workExperience|dateSection|currentlyWork|startDate|endDate/i.test(aid);
    }).map(el => {
      const aid = el.getAttribute('data-automation-id') || '';
      const v = (el.value || el.getAttribute('aria-valuetext') || (el.type==='checkbox'?('chk:'+el.checked):'')) ;
      return aid + '=' + String(v).slice(0,12) + '(' + (el.type||el.tagName) + ')';
    }).slice(0, 20);
    await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19); arr.push('[WD-DIAG] ' + (diag.join(' | ') || 'none')); chrome.storage.local.set({ pja_dbg: arr }, r);
    }));

    const map = [
      [/--jobTitle$/i, profile.currentTitle],
      [/--companyName$|--company$/i, profile.currentCompany],
      [/--location$/i, loc],
    ];
    let filled = 0;
    for (const [re, val] of map) {
      if (!val) continue;
      for (const c of Array.from(qAll('[data-automation-id]'))) {
        const aid = c.getAttribute('data-automation-id') || '';
        if (!/^workExperience-/i.test(aid) || !re.test(aid)) continue;
        const inp = (c.matches && c.matches('input,textarea')) ? c : (c.querySelector && c.querySelector('input,textarea'));
        if (inp && !inp.value && setText(inp, val)) filled++;
      }
    }

    // "I currently work here" checkbox — checking it removes the "To"-date requirement.
    const curCb = Array.from(qAll('input[type=checkbox]')).find(cb => {
      const aid = cb.getAttribute('data-automation-id') || cb.id || '';
      return /currentlyWorkHere|currentEmployment|currentlyWork/i.test(aid);
    });
    if (curCb && !curCb.checked) { curCb.click(); filled++; }

    // From-date (and To-date if not "currently work here"): Workday renders MM + YYYY
    // spinbutton inputs (dateSectionMonth-input / dateSectionYear-input). Fill the
    // first pair = "From" date with the current job's start.
    const startMonth = profile.currentStartMonth || '09';
    const startYear  = profile.currentStartYear  || '2024';
    const monthInputs = Array.from(qAll('input[data-automation-id="dateSectionMonth-input"]'));
    const yearInputs  = Array.from(qAll('input[data-automation-id="dateSectionYear-input"]'));
    if (monthInputs[0] && !monthInputs[0].value) { if (setText(monthInputs[0], startMonth)) filled++; }
    if (yearInputs[0]  && !yearInputs[0].value)  { if (setText(yearInputs[0],  startYear))  filled++; }

    if (filled) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19); arr.push('[WD] workExperience filled=' + filled); chrome.storage.local.set({ pja_dbg: arr }, r);
      }));
    }
    return filled;
  }

  // PURE: maps a LOWERCASED Workday question label + profile to an answer string, or one of
  // the sentinels '__YEARS__' / '__DECLINE__' (resolved against the option list), or null.
  // Branch ORDER is load-bearing — see the unit tests in test/unit/external-apply.test.js.
  function pjaWorkdayAnswerForLabel(label, profile) {
    profile = profile || {};
    // OPT/CPT/F-1 MUST come before the workAuth /eligible/ check, else
    // "Are you eligible for a 24-month OPT extension?" wrongly matches workAuth -> Yes.
    if (/optional practical training|opt extension|\bopt\b|curricular practical|\bcpt\b|f-1 visa|f1 visa|j-1 visa/i.test(label)) {
      return 'No';   // Canadian on TN — not on OPT/CPT/F-1
    } else if (/authoriz|eligible|legally|legal right/i.test(label)) {
      return profile.workAuth === 'Yes' ? 'Yes' : 'No';
    } else if (/sponsor/i.test(label)) {
      return profile.requireSponsorship === 'No' ? 'No' : 'Yes';
    } else if (/export control|us person/i.test(label)) {
      return /citizen|green card|permanent resident/i.test(profile.visaStatus || '') ? 'Yes' : 'No';
    } else if (/relocat/i.test(label)) {
      return profile.willingToRelocate === 'Yes' ? 'Yes' : 'No';
    } else if (/background check|drug test|drug screen/i.test(label)) {
      return 'Yes';
    } else if (/veteran/i.test(label)) {
      const v = (profile.veteran || '').toLowerCase();
      if (/not a veteran|not a protected/i.test(v)) return 'I AM NOT A VETERAN';
      if (/protected veteran|one or more/i.test(v)) return 'I IDENTIFY AS ONE OR MORE';
      return 'I DO NOT WISH TO SELF-IDENTIFY';
    } else if (/disab/i.test(label)) {
      const dis = (profile.disability || '').toLowerCase();
      if (/no|do not|don.t/i.test(dis)) return 'NO';
      if (/yes|have a disab/i.test(dis)) return 'YES';
      return "I DON'T WISH TO ANSWER";
    } else if (/how many years|years of (relevant )?(professional )?experience|years.*experience|level of experience/i.test(label)) {
      // MUST come before basic-requirements — "how many years ... do you have" would
      // otherwise match /do you have/ and wrongly answer "Yes".
      return '__YEARS__';
    } else if (/basic (job )?requirements|minimum (qualifications|requirements)|meet.*(the )?(basic|minimum).*requirements/i.test(label)) {
      return 'Yes';
    } else if (/artificial intelligence|\bai\b|machine learning.*(recruit|process|assess)|consent.*(ai|automated)/i.test(label)) {
      return 'Yes';   // consent to AI use in recruiting
    } else if (/worked (at|for)|employed (at|by)|are you (currently|now).*(employee|work)|former.*employee|previously work|current.*employee/i.test(label)) {
      return 'No';
    } else if (/18 years|over 18|at least 18|age of 18/i.test(label)) {
      return 'Yes';
    } else if (/ethnic|race|hispanic|latino/i.test(label)) {
      const e = (profile.ethnicity || '').toLowerCase();
      if (/asian/.test(e)) return 'Asian';
      if (/white|caucas/.test(e)) return 'White';
      if (/black|african/.test(e)) return 'Black';
      if (/hispanic|latino/.test(e)) return 'Hispanic';
      if (/two or more|multi/.test(e)) return 'Two or More';
      return '__DECLINE__';
    } else if (/gender|what is your sex|\bsex\b|male or female/i.test(label)) {
      const g = (profile.gender || '').toLowerCase();
      if (/female|woman/.test(g)) return 'Female';
      if (/male|man/.test(g)) return 'Male';
      return '__DECLINE__';
    }
    return null;
  }

  // PURE: given an answer (possibly a sentinel) and the dropdown's option texts, returns
  // the option text to pick (or null). __YEARS__ picks the numeric range containing
  // profile.yearsExperience; __DECLINE__ picks the "prefer not / decline" option.
  function pjaPickAnswerOption(answer, optionTexts, profile) {
    profile = profile || {};
    const texts = (optionTexts || []).map(s => (s || '').trim());
    if (answer === '__DECLINE__') {
      return texts.find(txt => /wish (not )?to|decline|prefer not|not to (disclose|answer|identify)|do not wish|choose not/i.test(txt)) || null;
    }
    if (answer === '__YEARS__') {
      const yrs = parseInt(profile.yearsExperience, 10) || 6;
      const hit = texts.find(txt => {
        const nums = (txt.match(/\d+/g) || []).map(Number);
        if (/\+|more than|over|at least|\bor more\b/i.test(txt) && nums.length) return yrs >= nums[0];
        if (nums.length >= 2) return yrs >= nums[0] && yrs <= nums[1];
        if (nums.length === 1) return yrs === nums[0];
        return false;
      });
      return hit || texts.find(txt => /\d/.test(txt)) || null;
    }
    const al = String(answer).toLowerCase();
    return texts.find(txt => { const ot = txt.toLowerCase(); return ot === al || ot.includes(al) || al.includes(ot); }) || null;
  }

  if (typeof window !== 'undefined') {
    window.pjaWorkdayAnswerForLabel = pjaWorkdayAnswerForLabel;
    window.pjaPickAnswerOption = pjaPickAnswerOption;
  }

  async function pjaFillWorkdayAppQuestions(profile) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return;
    const fields = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
    const log = [];
    for (const field of fields) {
      const btn = field.querySelector('button[type="button"]');
      if (!btn || btn.textContent.trim() !== 'Select One') continue;
      // Label lives in richText div OR in the button's aria-label (e.g. "Protected Veteran: Select One")
      const richLabel = field.querySelector('[data-automation-id="richText"]')?.textContent || '';
      const btnAriaLabel = btn.getAttribute('aria-label') || '';
      const label = (richLabel || btnAriaLabel.replace(/:\s*select one.*$/i, '')).toLowerCase();
      const answer = pjaWorkdayAnswerForLabel(label, profile);
      if (!answer) continue;
      // Close any stale open listbox before opening this field's dropdown
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      btn.click();
      // Poll up to 1.5s for a listbox to appear
      let listbox = null;
      for (let t = 0; t < 15; t++) {
        await new Promise(r => setTimeout(r, 100));
        listbox = document.querySelector('[role="listbox"]');
        if (listbox) break;
      }
      if (!listbox) continue;
      const optionEls = Array.from(listbox.querySelectorAll('[role="option"]'));
      const chosenText = pjaPickAnswerOption(answer, optionEls.map(o => (o.textContent || '').trim()), profile);
      const opt = chosenText == null ? null : optionEls.find(o => (o.textContent || '').trim() === chosenText);
      if (opt) {
        opt.click();
        await new Promise(r => setTimeout(r, 300));
        log.push(label.slice(0, 30) + '→' + answer);
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
      }
    }
    // Handle formField-disabilityStatus — FIRST, before name fill.
    // Clicking a checkbox triggers React re-render; if name was filled before the click,
    // the re-render would reset name to "" (React state was never updated by nativeInputValueSetter).
    // So we click the checkbox FIRST, then fill name via CDP trusted chars AFTER.
    const disField = document.querySelector('[data-automation-id="formField-disabilityStatus"]');
    if (disField && !disField.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) {
      const dis = (profile.disability || '').toLowerCase();
      const targetRe = /no|do not|don.t/i.test(dis) ? /no.*disab|not have.*disab/i
        : /yes|have a disab/i.test(dis) ? /yes.*disab|have.*disab/i
        : /do not want|not answer/i;
      for (const cb of disField.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
        const lbl = document.querySelector('label[for="'+cb.id+'"]');
        if (lbl && targetRe.test(lbl.textContent)) {
          cb.click();
          log.push('disability→' + lbl.textContent.trim().slice(0, 35));
          await new Promise(r => setTimeout(r, 300)); // wait for re-render to settle
          break;
        }
      }
    }
    // Handle formField-name (signature name on Self-Identify form).
    // Always fill via CDP regardless of current DOM value — pjaFillForm may have set the DOM
    // value via nativeInputValueSetter (which doesn't update React state), so !nameField.value
    // would be false even though React state is "". We always use CDP to ensure React state
    // is properly set and survives the disability-checkbox re-render.
    const nameField = document.querySelector('[data-automation-id="formField-name"] input[type="text"]');
    if (nameField) {
      const fullName = profile.fullName || ((profile.firstName||'') + ' ' + (profile.lastName||'')).trim();
      if (fullName) {
        const tempNameId = '__pja_name_' + Date.now();
        nameField.setAttribute('id', tempNameId);
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'WORKDAY_SET_SID', selector: '#' + CSS.escape(tempNameId), text: fullName }, r => {
            nameField.removeAttribute('id');
            resolve(r || {});
          });
        });
        log.push('formField-name→' + fullName + ' val="' + nameField.value.slice(0,15) + '"');
      }
    }
    // Handle formField-dateSignedOn — use CDP to type digits (trusted keydown events required)
    // nativeSetter/InputEvent alone don't propagate to Workday's Jotai form state.
    const dateField = document.querySelector('[data-automation-id="formField-dateSignedOn"]');
    if (dateField) {
      const today = new Date();
      // Find the base ID from the spinner IDs (e.g. "selfIdentifiedDisabilityData--dateSignedOn")
      const monthSpinner = dateField.querySelector('[role="spinbutton"][aria-label="Month"]');
      const baseId = monthSpinner?.id?.replace('-dateSectionMonth-input', '') || null;
      if (baseId) {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'WORKDAY_TYPE_DATE',
            baseId,
            month: today.getMonth() + 1,
            day: today.getDate(),
            year: today.getFullYear()
          }, () => resolve());
        });
        log.push('dateSignedOn→CDP today');
      } else {
        log.push('dateSignedOn→no baseId');
      }
    }
    // Check any required terms/consent checkboxes on this step.
    // Skip checkboxes inside a multi-checkbox fieldset (disability/race/etc. option groups)
    // — those are mutually-exclusive option pickers, not consent checkboxes.
    for (const cb of document.querySelectorAll('input[type="checkbox"][required], input[type="checkbox"][aria-required="true"], #termsAndConditions--acceptTermsAndAgreements')) {
      if (cb.checked) continue;
      const parentFieldset = cb.closest('fieldset');
      if (parentFieldset && parentFieldset.querySelectorAll('input[type="checkbox"]').length > 1) continue;
      cb.click();
      log.push('terms-checkbox checked');
    }
    // Diagnostic: capture SID form state (spinbutton values, checkbox state, name value)
    if (dateField) {
      const spinVals = Array.from(dateField.querySelectorAll('[role="spinbutton"]')).map(el => {
        const aria = el.getAttribute('aria-label') || el.id.slice(-10);
        const val = el.getAttribute('aria-valuenow') || el.getAttribute('aria-valuetext') || el.value || '?';
        return aria + '=' + val;
      });
      const nameVal = (document.querySelector('[data-automation-id="formField-name"] input[type="text"]') || {}).value || '?';
      const checkedDis = (() => {
        const lbl = Array.from(document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input[type="checkbox"]'))
          .filter(c => c.checked).map(c => (document.querySelector('label[for="'+c.id+'"]')?.textContent||'').trim().slice(0,20));
        return lbl.join('|') || 'none';
      })();
      log.push('SID diag: spinners=[' + spinVals.join(',') + '] name="' + nameVal.slice(0,15) + '" dis=' + checkedDis);
    }
    if (log.length) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19);
        arr.push('[ext] WD appQ fill: ' + log.join(', '));
        chrome.storage.local.set({ pja_dbg: arr }, r);
      }));
    }
  }

  // ── Best-effort resume file injection ────────────────────────────────────
  // Two strategies, tried in order:
  //   1. Greenhouse dynamic-input bridge: dispatch pja:injectresume to MAIN world,
  //      which overrides HTMLInputElement.prototype.click to intercept the file input
  //      that Greenhouse creates dynamically when the "Attach" button is clicked.
  //   2. Static file input: for non-Greenhouse ATS that already have an input[type=file]
  //      in the DOM, inject directly via Object.defineProperty.

  async function tryInjectResume(profile, answers) {
    return new Promise(resolve => {
      chrome.storage.local.get(['pja_resume_b64', 'pja_resume_filename'], async data => {
        if (!data.pja_resume_b64) { console.log('PJA tryInjectResume: no pja_resume_b64 in storage'); resolve(); return; }
        const b64 = data.pja_resume_b64;
        const filename = data.pja_resume_filename || 'resume.pdf';
        console.log('PJA tryInjectResume: starting, file=', filename, 'b64 len=', b64.length);

        // Build File object from stored base64 data URL
        function makeFile(b64, fname) {
          const parts = b64.split(',');
          const mimeMatch = (parts[0] || '').match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
          const binary = atob(parts[1] || parts[0]);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new File([bytes], fname, { type: mime });
        }

        // Inject a File object into a file input via DataTransfer (works in extension content scripts).
        // Falls back to Object.defineProperty if direct assignment is rejected.
        function injectFileIntoInput(el, file) {
          try {
            const dt = new DataTransfer();
            dt.items.add(file);
            try { el.files = dt.files; } catch(_) {}
            // Verify direct assignment worked
            if (el.files && el.files.length > 0) {
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
            // Fallback: Object.defineProperty
            Object.defineProperty(el, 'files', { value: dt.files, configurable: true });
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return el.files && el.files.length > 0;
          } catch(e) {
            console.warn('PJA: injectFileIntoInput failed', e.message);
            return false;
          }
        }

        function dbgResume(msg) {
          chrome.storage.local.get('pja_dbg', d => {
            const arr = (d.pja_dbg || []).slice(-19);
            arr.push('[resume] ' + msg);
            chrome.storage.local.set({ pja_dbg: arr });
          });
        }

        // Ensure fiber-main.js is loaded in MAIN world before Strategy 1 (request injection if needed).
        // Poll up to 1s instead of a fixed sleep to handle slow injection on cold tabs.
        if (!document.documentElement.hasAttribute('data-pja-fiber-main')) {
          await new Promise(r => chrome.runtime.sendMessage({ type: 'INJECT_FIBER_MAIN' }, r));
          for (let _i = 0; _i < 10 && !document.documentElement.hasAttribute('data-pja-fiber-main'); _i++) {
            await sleep(100);
          }
        }

        // Strategy 1: Dynamic-input bridge for Greenhouse, Lever, and similar ATS.
        // These ATS create <input type=file> dynamically when an Attach/Upload button is clicked.
        // The fiber-main.js MAIN-world override intercepts input.click() before the OS dialog opens.
        // Selector covers:
        //   Greenhouse: div.file-upload
        //   Lever: div.attach-file, div.attach-or-paste
        //   Ashby: [data-testid*="file-upload"], [data-testid*="resume"]
        //   Generic: class-name patterns
        const ghSection = Array.from(document.querySelectorAll(
          'div.file-upload, div[class*="file-upload"], div[class*="fileUpload"], ' +
          'div[class*="attach-file"], div[class*="attachFile"], div[class*="attach-or-paste"], ' +
          'div[class*="attachment-upload"], div[class*="resume-upload"], div[class*="upload-widget"], ' +
          'div[class*="document-upload"], div[class*="drop-zone"], div[class*="dropzone"], ' +
          '[data-testid*="file-upload"], [data-testid*="resume-upload"], [data-testid*="upload-resume"]'
        )).find(el => {
          const widgetText = el.textContent;
          const ancestorText = el.closest('section, .field, [class*="field"], [class*="question"], .form-group, [class*="document"], [class*="attachment"], [data-testid]')?.textContent || '';
          const nearbyLabel = el.parentElement?.querySelector('label,legend')?.textContent || '';
          return /resume|cv\b|curriculum/i.test(widgetText + ' ' + ancestorText + ' ' + nearbyLabel);
        });
        console.log('PJA tryInjectResume: ghSection found=', !!ghSection);
        dbgResume('strategy1 ghSection=' + !!ghSection + ' host=' + location.hostname.slice(0,30));
        if (ghSection) {
          // Buttons: Greenhouse uses <button>, Lever uses <span class="btn">, others use <a role="button">
          const allBtnsInSection = Array.from(ghSection.querySelectorAll(
            'button, a[role="button"], span[class*="btn"], [class*="attach-btn"], [class*="upload-btn"]'
          ));
          const attachBtn = allBtnsInSection.find(b => /attach|upload|browse|choose|select.*file/i.test(
            b.textContent + (b.getAttribute('aria-label') || '') + (b.getAttribute('data-action') || '')
          )) || allBtnsInSection[0]
            || ghSection.closest('section, .field, [class*="document"]')?.querySelector(
              'button, a[role="button"], span[class*="btn"]'
            );
          if (attachBtn) {
            // Arm the MAIN world override BEFORE clicking Attach — passes filename too
            document.dispatchEvent(new CustomEvent('pja:injectresume', {
              detail: { b64, filename },
              bubbles: false
            }));
            document.documentElement.removeAttribute('data-pja-resume-injected');
            attachBtn.click();
            let injected = false;
            for (let i = 0; i < 30; i++) {
              await sleep(100);
              const attr = document.documentElement.getAttribute('data-pja-resume-injected');
              if (attr === 'ok') { injected = true; break; }
              if (attr && attr.startsWith('err:')) { console.warn('PJA: resume inject MAIN world error:', attr); dbgResume('strategy1 bridge err: ' + attr); break; }
            }
            if (!injected) {
              // Bridge timed out — fiber-main.js may not have been loaded. Try direct DOM injection
              // on any file input that may have appeared in the DOM after clicking Attach.
              console.warn('PJA: resume inject bridge timed out, trying fallback DOM injection');
              dbgResume('strategy1 bridge timeout, trying fallback');
              await sleep(200);
              const newFileInput = ghSection.querySelector('input[type=file]')
                || document.querySelector('input[type=file]');
              if (newFileInput) {
                const file = makeFile(b64, filename);
                const ok = injectFileIntoInput(newFileInput, file);
                dbgResume('strategy1 fallback DOM inject ok=' + ok);
                if (!ok) { dbgResume('strategy1 fallback failed, no resume'); resolve(); return; }
              } else {
                dbgResume('strategy1 fallback: no file input in DOM either');
                resolve(); return;
              }
            } else {
              dbgResume('strategy1 bridge ok, waiting S3 upload');
            }
            console.log('PJA: resume file injected, waiting for upload confirmation…');
            let uploadConfirmed = false;
            // Also check in ancestor section for Lever (which shows filename outside ghSection)
            const confirmScope = ghSection.closest('section, .field, [class*="field"], [class*="question"], [class*="document"]') || ghSection;
            for (let i = 0; i < 60; i++) {
              await sleep(200);
              // Remove/delete link (Greenhouse, Lever after upload)
              const removeBtn = confirmScope.querySelector(
                'a[data-method="delete"], button[class*="remove"], a[class*="remove"], ' +
                '[aria-label*="remove" i], [aria-label*="delete" i], ' +
                'span[class*="remove"], [data-action*="remove"], [data-action*="delete"]'
              );
              if (removeBtn) { console.log('PJA: resume upload complete (Remove btn)'); uploadConfirmed = true; break; }
              // Attach button replaced or gone after upload
              if (!document.contains(attachBtn)) { console.log('PJA: resume upload complete (Attach btn gone)'); uploadConfirmed = true; break; }
              // Filename or uploaded state shown
              const filenameEl = confirmScope.querySelector(
                '[class*="filename"],[class*="file-name"],[class*="uploaded"],[class*="file-info"],' +
                '[class*="attachment-name"],[class*="resume-name"]'
              );
              if (filenameEl?.textContent?.trim()) { console.log('PJA: resume upload complete (filename shown)'); uploadConfirmed = true; break; }
            }
            dbgResume('strategy1 S3 upload confirmed=' + uploadConfirmed);
            resolve();
            return;
          }
        }

        // Strategy 1.3: Generic "Upload Resume" button heuristic (Ashby and others).
        // If no known widget div matched, look for any upload button near a resume label —
        // the button either has a hidden <input type=file> sibling or creates one dynamically.
        if (!ghSection) {
          const allPageBtns = Array.from(document.querySelectorAll(
            'button, [role="button"], label[for], span[class*="btn"], a[class*="btn"]'
          ));
          const uploadBtn1_3 = allPageBtns.find(b => {
            const txt = (b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('for') ? (document.getElementById(b.getAttribute('for'))?.accept || '') : '');
            if (!/upload|attach|browse|choose.*file|select.*file/i.test(txt)) return false;
            // Must be near "Resume/CV" text in ancestor
            const ancestor = b.closest('[class*="resume"],[class*="cv"],[data-testid*="resume"],[data-testid*="upload"],[data-testid*="document"],section,fieldset,.field') || b.parentElement?.parentElement;
            return ancestor && /resume|cv\b|curriculum/i.test(ancestor.textContent || '');
          });
          dbgResume('strategy1.3 uploadBtn=' + !!(uploadBtn1_3) +
            (uploadBtn1_3 ? ' text=' + (uploadBtn1_3.textContent||'').trim().slice(0,25) : ''));
          if (uploadBtn1_3) {
            document.dispatchEvent(new CustomEvent('pja:injectresume', { detail: { b64, filename }, bubbles: false }));
            document.documentElement.removeAttribute('data-pja-resume-injected');
            uploadBtn1_3.click();
            let injected = false;
            for (let i = 0; i < 35; i++) {
              await sleep(100);
              const attr = document.documentElement.getAttribute('data-pja-resume-injected');
              if (attr === 'ok') { injected = true; break; }
              if (attr && attr.startsWith('err:')) { dbgResume('strategy1.3 bridge err: ' + attr); break; }
            }
            if (!injected) {
              // Check if a static file input appeared or was already in DOM near the button
              const nearInput = uploadBtn1_3.closest('form,section,[class*="field"],[data-testid]')?.querySelector('input[type=file]')
                || document.querySelector('input[type=file]');
              if (nearInput) {
                const f = makeFile(b64, filename);
                const ok = injectFileIntoInput(nearInput, f);
                dbgResume('strategy1.3 fallback ok=' + ok);
              } else {
                dbgResume('strategy1.3 no injection, no file input');
              }
            } else {
              dbgResume('strategy1.3 bridge ok');
            }
            resolve();
            return;
          }
        }

        // Strategy 1.5: Workday dynamic bridge — Workday creates input[type=file] dynamically
        // when the upload button is clicked (same pattern as Greenhouse). We arm the fiber-main
        // bridge FIRST, then click the upload button so it intercepts the dynamic input.
        // data-pja-wd-test attribute enables this path on local test pages.
        if (/workday|myworkdayjobs/i.test(location.hostname) || document.documentElement.hasAttribute('data-pja-wd-test')) {
          // Skip if resume already uploaded — check Workday-specific and generic indicators
          const alreadyUploaded = !!document.querySelector(
            '[data-automation-id="file-upload-successful"],' +
            '[data-automation-id="file-upload-item-name"],' +
            '[data-automation-id*="resumeParsed"],[data-automation-id*="resume-parsed"],' +
            '[data-automation-id*="resume"] [class*="filename"],[data-automation-id*="resume"] [class*="file-name"]'
          );
          // Find the Workday upload button — it opens a file picker dynamically
          const wdUploadBtn = alreadyUploaded ? null : (
            document.querySelector('[data-automation-id="click-to-upload"]') ||
            document.querySelector('[data-automation-id="file-upload-button"]') ||
            document.querySelector('[data-automation-id*="upload"][data-automation-id*="resume"]') ||
            document.querySelector('[data-automation-id*="upload"][data-automation-id*="button"]') ||
            (() => {
              const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
              return btns.find(el =>
                /\bupload\b|\battach\b|\bbrowse\b|select\s+file|choose\s+file/i.test(
                  (el.textContent || '') + (el.getAttribute('aria-label') || '')
                ) && !/linkedin/i.test(el.textContent)
              );
            })()
          );
          dbgResume('strategy1.5 wd alreadyUploaded=' + alreadyUploaded + ' btn=' + !!wdUploadBtn +
            (wdUploadBtn ? ' text=' + (wdUploadBtn.textContent||wdUploadBtn.getAttribute('aria-label')||'').trim().slice(0,20) : '') +
            ' host=' + location.hostname.slice(0,25));
          if (wdUploadBtn) {
            document.dispatchEvent(new CustomEvent('pja:injectresume', { detail: { b64, filename }, bubbles: false }));
            document.documentElement.removeAttribute('data-pja-resume-injected');
            wdUploadBtn.click();
            let injected = false;
            for (let i = 0; i < 35; i++) {
              await sleep(100);
              const attr = document.documentElement.getAttribute('data-pja-resume-injected');
              if (attr === 'ok') { injected = true; break; }
              if (attr && attr.startsWith('err:')) { dbgResume('strategy1.5 bridge err: ' + attr); break; }
            }
            dbgResume('strategy1.5 bridge injected=' + injected);
            if (injected) {
              await waitResumeParseWorkday(profile, answers);
              resolve(); return;
            }
            // Fallback: Workday may have put the input in DOM after clicking button
            await sleep(300);
            const wdFileInput = document.querySelector('input[type=file]');
            if (wdFileInput) {
              const file = makeFile(b64, filename);
              const ok = injectFileIntoInput(wdFileInput, file);
              dbgResume('strategy1.5 fallback ok=' + ok + ' id=' + (wdFileInput.id||wdFileInput.name||'?'));
              if (ok) await waitResumeParseWorkday(profile, answers);
              resolve(); return;
            }
            dbgResume('strategy1.5 failed: no injection after btn click');
            // fall through to Strategy 2/3
          } else if (alreadyUploaded) {
            dbgResume('strategy1.5 wd: resume already uploaded, skipping');
            resolve(); return;
          } else {
            // No upload button and no file — this Workday step doesn't have resume upload
            dbgResume('strategy1.5 wd: no upload zone on this step, skipping');
            resolve(); return;
          }
        }

        // Strategy 2: Static file input already in DOM — first look for resume-labeled one,
        // then fall back to the first any visible file input (many ATS have only one).
        // Also check hidden inputs (Lever uses display:none but offsetParent check removes it).
        const allFileInputs = Array.from(document.querySelectorAll('input[type=file]'));
        const visibleFileInputs = allFileInputs.filter(el => el.offsetParent || getComputedStyle(el).display !== 'none');
        const fileInput = visibleFileInputs.find(el =>
          /resume|cv|curriculum/i.test(
            (el.getAttribute('accept') || '') + (el.getAttribute('name') || '') +
            (el.getAttribute('id') || '') + getLabelFor(el)
          )
        ) || allFileInputs.find(el =>
          /resume|cv|curriculum/i.test(
            (el.getAttribute('accept') || '') + (el.getAttribute('name') || '') +
            (el.getAttribute('id') || '') + getLabelFor(el)
          )
        ) || visibleFileInputs[0] || allFileInputs[0];

        dbgResume('strategy2 allInputs=' + allFileInputs.length + ' visible=' + visibleFileInputs.length + ' picked=' + (fileInput ? (fileInput.id||fileInput.name||'?') : 'none'));

        if (!fileInput) {
          // Strategy 3: Workday / drag-drop widgets — look for a hidden file input inside
          // a visible upload zone (e.g. [data-automation-id*="upload"] or .file-drop-zone)
          const uploadZone = document.querySelector(
            '[data-automation-id*="upload"],[data-automation-id*="resume"],[class*="drop-zone"],[class*="dropZone"],[class*="file-drop"]'
          );
          if (uploadZone) {
            const hiddenInput = uploadZone.querySelector('input[type=file]') ||
              uploadZone.parentElement?.querySelector('input[type=file]');
            if (hiddenInput) {
              const file = makeFile(b64, filename);
              const ok = injectFileIntoInput(hiddenInput, file);
              console.log('PJA: resume inject via hidden input in upload zone, ok=', ok);
              dbgResume('strategy3 upload-zone ok=' + ok);
              if (ok) await waitResumeParseWorkday(profile, answers);
              resolve();
              return;
            }
          }
          console.log('PJA tryInjectResume: no file input found');
          dbgResume('no file input found on ' + location.hostname.slice(0,30));
          resolve();
          return;
        }

        const file = makeFile(b64, filename);
        const ok = injectFileIntoInput(fileInput, file);
        console.log('PJA: resume inject via static file input ok=', ok, 'name=', fileInput.name || fileInput.id);
        dbgResume('strategy2 inject ok=' + ok + ' id=' + (fileInput.id||fileInput.name||'?'));

        if (ok) {
          // Strategy 4 (Workday): After injecting resume, Workday parses it server-side and
          // pre-fills form fields — which overwrites what pjaFillForm already filled.
          if (/workday|myworkdayjobs/i.test(location.hostname)) {
            await waitResumeParseWorkday(profile, answers);
          } else {
            // For all other ATS: wait up to 5s for the UI to acknowledge the file
            // (filename label, progress bar, "attached" badge, etc.)
            let uploadFeedback = false;
            const section = fileInput.closest('[class*="upload"],[class*="resume"],[class*="attach"],[class*="file"],[class*="document"]') || fileInput.parentElement;
            for (let i = 0; i < 25; i++) {
              await sleep(200);
              const feedback = section?.querySelector('[class*="file-name"],[class*="filename"],[class*="selected"],[class*="attached"],[class*="uploaded"],[aria-label*="remove" i],[aria-label*="delete" i]')
                || document.querySelector('[class*="file-name"],[class*="filename"],[class*="resume-name"],[data-testid*="filename"],[data-testid*="uploaded"]');
              if (feedback?.textContent?.trim()) { uploadFeedback = true; break; }
              // Also check if the input now has files (confirming it accepted the injection)
              if (fileInput.files && fileInput.files.length > 0) { uploadFeedback = true; break; }
            }
            dbgResume('strategy2 upload-feedback=' + uploadFeedback);
          }
        }

        resolve();
      });
    });
  }

  // Workday parses uploaded resumes server-side and overwrites form fields.
  // Poll until the parsed name appears (indicates parsing done), then re-fill.
  async function waitResumeParseWorkday(profile, answers) {
    console.log('PJA: waiting for Workday resume parse…');
    // Wait up to 12s for a "parsed" indicator: name field gets populated, or
    // a "resume parsed" notification appears, or the upload button label changes.
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      await sleep(500);
      const nameField = document.querySelector('[data-automation-id="legalNameSection_firstName"] input, [data-automation-id="firstName"] input');
      const uploadDone = document.querySelector('[data-automation-id*="resumeParsing"][data-automation-id*="complete"], [data-automation-id*="resume-parsed"]');
      const hasName = nameField && nameField.value && nameField.value.trim();
      if (hasName || uploadDone) {
        console.log('PJA: Workday resume parsed, re-filling fields');
        await sleep(300);
        if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers);
        break;
      }
    }
  }

  // ── Workday per-hostname credential helpers ──────────────────────────────

  function wdCredsKey() {
    return `pja_wd_creds_${location.hostname}`;
  }

  function getStoredWorkdayCreds() {
    return new Promise(resolve =>
      chrome.storage.local.get(wdCredsKey(), d => resolve(d[wdCredsKey()] || null))
    );
  }

  function storeWorkdayCreds(email, password) {
    return new Promise(resolve =>
      chrome.storage.local.set({ [wdCredsKey()]: { email, password } }, resolve)
    );
  }

  async function handleSignIn(profile) {
    // Accept Workday cookie consent banner if present (required for session cookies)
    const cookieAcceptBtn = document.querySelector('[data-automation-id="legalNoticeAcceptButton"]');
    if (cookieAcceptBtn) { cookieAcceptBtn.click(); await sleep(500); }

    // Strategy 1: prefer "Apply with Email" — skips OAuth entirely (Greenhouse, Ashby)
    const emailPathBtn = Array.from(document.querySelectorAll('a, button, [role=button]'))
      .find(el => /apply with email|sign in with email|use.*email|continue with email|email.*instead/i.test(
        el.textContent + (el.getAttribute('aria-label') || '')));
    if (emailPathBtn) {
      emailPathBtn.click();
      await sleep(1000);
      // Workday uses type="text" with data-automation-id="email", not type="email"
      const emailField = document.querySelector(
        'input[data-automation-id="email"], input[type=email], input[name*=email]:not([name="website"]), input[id*=email]'
      );
      if (emailField && typeof pjaSetNative === 'function') {
        pjaSetNative(emailField, profile.email);
        emailField.dispatchEvent(new Event('input', { bubbles: true }));
        emailField.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return 'email_path';
    }

    // Strategy 2: Workday / standard password form — auto-create or auto-sign-in
    // Use let so we can re-query after clicking "Create Account" navigation button (SPA).
    // Workday uses data-automation-id="email" with type="text" — NOT type="email".
    let pwFields = Array.from(document.querySelectorAll('input[type=password]'));
    if (pwFields.length) {
      const fill = typeof pjaSetNative === 'function' ? pjaSetNative : (el, v) => { el.value = v; };
      const getEmailField = () => document.querySelector(
        'input[data-automation-id="email"], input[type=email], ' +
        'input[name*=email]:not([name="website"]), input[id*=email]'
      );

      // ── Create Account form: 2 password fields (password + verify new password) ──
      if (pwFields.length >= 2) {
        const storedCreds = await getStoredWorkdayCreds();
        const email = profile.email;
        const password = storedCreds?.password || `Applicant_ATS_${new Date().getFullYear()}!`;

        // Helper: submit a Workday form via background's WORKDAY_SUBMIT_FORM (runs in MAIN world,
        // uses nativeInputValueSetter so React/Formik state is properly updated).
        const wdSubmitForm = (formType) => new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'WORKDAY_SUBMIT_FORM', email, password, formType }, r => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(r || { ok: false });
          });
        });

        // Poll until the sign-in form dismisses (success) or an error message appears (failure).
        // Returns { success: true } or { success: false, error: <string> }
        const wdPollAuthResult = async (maxMs = 12000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < maxMs) {
            await sleep(400);
            if (!document.querySelector('input[type=password]')) return { success: true };
            const errEl = document.querySelector(
              '[data-automation-id="errorMessage"], [data-automation-id*="Error"][data-automation-id*="sign"], ' +
              '[data-automation-id*="ValidationError"], [role=alert]'
            );
            const errText = errEl?.innerText?.trim();
            if (errText) return { success: false, error: errText };
          }
          return { success: false, error: 'timeout' };
        };

        // Helper: switch to Sign In view and sign in. Returns { success } or { success: false, error }.
        const doSignIn = async () => {
          const goSignIn = document.querySelector('[data-automation-id="signInLink"]')
            || findButton(/^sign.?in$/i);
          if (goSignIn) { goSignIn.click(); await sleep(1500); }
          console.log('PJA doSignIn: submitting via WORKDAY_SUBMIT_FORM (main world)');
          const submitResp = await wdSubmitForm('signin');
          console.log('PJA doSignIn: submit resp', JSON.stringify(submitResp));
          const result = await wdPollAuthResult(12000);
          console.log('PJA doSignIn: poll result', JSON.stringify(result));
          await new Promise(r => chrome.storage.local.set({ pja_dbg_signin: { submitResp, result } }, r));
          return result;
        };

        // If we already have stored creds, skip account creation and go straight to sign-in
        if (storedCreds) {
          const siResult = await doSignIn();
          if (siResult.success) return 'signed_in';
          // Stored creds are stale — clear them and fall through to create account
          console.log('PJA: stored creds sign-in failed:', siResult.error, '— clearing, trying create account');
          await new Promise(r => chrome.storage.local.remove(wdCredsKey(), r));
        }

        // No stored creds (or stale) — create a new account via WORKDAY_SUBMIT_FORM (main world)
        await storeWorkdayCreds(email, password);
        console.log('PJA: submitting Create Account via WORKDAY_SUBMIT_FORM');
        const caResp = await wdSubmitForm('createaccount');
        console.log('PJA: create account submit resp', JSON.stringify(caResp));
        const caResult = await wdPollAuthResult(12000);
        console.log('PJA: create account poll result', JSON.stringify(caResult));
        await new Promise(r => chrome.storage.local.set({ pja_dbg_createacct: { caResp, caResult } }, r));
        if (caResult.success) return 'account_created';

        // Account creation failed (likely email already registered) — try signing in
        console.log('PJA: create account failed:', caResult.error, '— trying sign-in');
        const siResult2 = await doSignIn();
        if (siResult2.success) return 'signed_in';
        console.log('PJA: sign-in also failed:', siResult2.error, '— giving up');
        await new Promise(r => chrome.storage.local.remove(wdCredsKey(), r));
        return 'needs_password';
      }

      // ── Sign In form: 1 password field ─────────────────────────────────────────
      const storedCreds = await getStoredWorkdayCreds();
      const emailField = getEmailField();
      const email1pw = storedCreds?.email || profile.email;
      const password1pw = storedCreds?.password || `Applicant_ATS_${new Date().getFullYear()}!`;

      if (storedCreds) {
        // Sign in with stored credentials via WORKDAY_SUBMIT_FORM (main world)
        const siResp = await new Promise(resolve => chrome.runtime.sendMessage({
          type: 'WORKDAY_SUBMIT_FORM', email: email1pw, password: password1pw, formType: 'signin'
        }, r => { if (chrome.runtime.lastError) resolve({ ok: false }); else resolve(r || { ok: false }); }));
        console.log('PJA: 1-pw sign-in resp', JSON.stringify(siResp));
        // Poll for result
        let si1Success = false;
        for (let i = 0; i < 30; i++) {
          await sleep(400);
          if (!document.querySelector('input[type=password]')) { si1Success = true; break; }
          const errEl = document.querySelector('[data-automation-id="errorMessage"], [role=alert]');
          if (errEl?.innerText?.trim()) break;
        }
        if (si1Success) return 'signed_in';
        // Stale stored creds — clear them
        await new Promise(r => chrome.storage.local.remove(wdCredsKey(), r));
      }

      // No stored creds (or stale) — click "Create Account" nav button, wait for 2-pw form to appear
      const goCreateBtn = document.querySelector('[data-automation-id="createAccountLink"]')
        || findButton(/create.{0,10}account/i);
      if (goCreateBtn) {
        goCreateBtn.click();
        for (let i = 0; i < 20; i++) {
          await sleep(400);
          pwFields = Array.from(document.querySelectorAll('input[type=password]'));
          if (pwFields.length >= 2) break;
        }
        if (pwFields.length >= 2) {
          await storeWorkdayCreds(email1pw, password1pw);
          const ca1Resp = await new Promise(resolve => chrome.runtime.sendMessage({
            type: 'WORKDAY_SUBMIT_FORM', email: email1pw, password: password1pw, formType: 'createaccount'
          }, r => { if (chrome.runtime.lastError) resolve({ ok: false }); else resolve(r || { ok: false }); }));
          console.log('PJA: 1-pw-branch create account resp', JSON.stringify(ca1Resp));
          let ca1Success = false;
          for (let i = 0; i < 30; i++) {
            await sleep(400);
            if (!document.querySelector('input[type=password]')) { ca1Success = true; break; }
            const errEl = document.querySelector('[data-automation-id="errorMessage"], [role=alert]');
            if (errEl?.innerText?.trim()) break;
          }
          if (ca1Success) return 'account_created';
          // Email already in use — fall back to sign-in
          const goSignIn3 = document.querySelector('[data-automation-id="signInLink"]') || findButton(/^sign.?in$/i);
          if (goSignIn3) { goSignIn3.click(); await sleep(1500); }
          await new Promise(resolve => chrome.runtime.sendMessage({
            type: 'WORKDAY_SUBMIT_FORM', email: email1pw, password: password1pw, formType: 'signin'
          }, r => { if (chrome.runtime.lastError) resolve({ ok: false }); else resolve(r || { ok: false }); }));
          for (let i = 0; i < 25; i++) {
            await sleep(400);
            if (!document.querySelector('input[type=password]')) return 'signed_in';
          }
        }
      }

      // Last resort: fill email only, bail on password
      if (emailField) fill(emailField, profile.email);
      return 'needs_password';
    }

    // Strategy 3: Google SSO — click and wait for OAuth popup to auto-complete
    const googleBtn = Array.from(document.querySelectorAll('button, a, [role=button]'))
      .find(el => /sign.?in with google|continue with google|google sign.?in|apply with google/i.test(
        el.textContent + (el.getAttribute('aria-label') || '')));
    if (googleBtn) {
      console.log('PJA handleSignIn: clicking Google SSO button');
      googleBtn.click();
      // Poll up to 12 seconds for OAuth popup to complete and form to appear.
      // Chrome auto-selects the account when already signed in, closing the popup
      // and reloading/updating the ATS page with the application form.
      const formReady = () => {
        const inputs = document.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image])'
        );
        const hasPw = document.querySelector('input[type=password]');
        // Consider form ready when 3+ visible inputs exist and we're past the auth screen
        const visibleInputs = Array.from(inputs).filter(i => i.offsetParent);
        return visibleInputs.length >= 3 && !hasPw;
      };
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        if (formReady()) {
          console.log('PJA handleSignIn: Google SSO complete, form detected');
          return 'google_sso_clicked';
        }
      }
      console.log('PJA handleSignIn: Google SSO timeout — no form after 12s');
      return 'google_sso_only';
    }

    return null;
  }

  // Shadow-DOM-aware query: use pjaQueryAll if available (loaded by autofill.js), else document
  const pjaQueryAllExt = typeof pjaQueryAll === 'function'
    ? pjaQueryAll.bind(null)
    : sel => Array.from(document.querySelectorAll(sel));

  function findButton(pattern) {
    return pjaQueryAllExt('button[type=submit], button[type=button], input[type=submit], button')
      .find(b => !b.disabled && pattern.test((b.textContent || b.value || b.getAttribute('aria-label') || '').trim()));
  }

  // Phone fields on some ATS (e.g. Greenhouse) use type="text" not type="tel",
  // so can't be found by type alone. Find by label classification + empty value.
  // Uses skipBlur=true because React onBlur validation may clear the field value.
  function retryPhoneFill(profile) {
    if (!profile.phone) return;
    const digitsPhone = profile.phone.replace(/\D/g, '');
    if (!digitsPhone) return;
    const allInputs = pjaQueryAllExt(
      'input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])'
    );
    for (const el of allInputs) {
      if (!el.offsetParent || el.value.trim()) continue;
      const label = getLabelFor(el);
      if (!label) continue;
      const key = typeof pjaClassify === 'function' ? pjaClassify(label) : null;
      const isPhoneById = /^phone$/i.test(el.id) || /^phone$/i.test(el.name);
      if (key === 'phone' || el.type === 'tel' || isPhoneById) {
        console.log('PJA ext-apply retryPhoneFill: filling', JSON.stringify(label), el.type, el.id);
        // Use fiber onChange to update React state directly; skip blur to avoid validation clearing.
        // pjaFillTextViaFiber is preferred; fall back to pjaSetNative with skipBlur.
        if (typeof pjaFillTextViaFiber === 'function') {
          pjaFillTextViaFiber(el, digitsPhone, true);
        } else if (typeof pjaSetNative === 'function') {
          pjaSetNative(el, digitsPhone, true);
        } else {
          el.value = digitsPhone;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: digitsPhone, inputType: 'insertText' }));
        }
      }
    }
  }

  function findMissingRequired() {
    const missing = [];
    const seen = new Set();

    for (const el of pjaQueryAllExt(
      'input[required]:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),' +
      'select[required], textarea[required],' +
      '[aria-required="true"]:not([type=hidden]):not([type=file])'
    )) {
      if (!el.offsetParent && el.getBoundingClientRect().width === 0) continue; // hidden
      // Skip div/button/section containers (e.g. Greenhouse file-upload wrappers) matched by aria-required
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (!['input','select','textarea'].includes(tag) &&
          !['combobox','listbox','spinbutton','slider','textbox'].includes(role)) continue;
      // Skip file-upload filename display inputs (Greenhouse shows a text input for the filename
      // next to the file input — we can't fill it, and the resume_b64 injection handles actual upload)
      const container = el.closest('[class*="upload"],[class*="resume"],[class*="file-input"]') ||
                        el.closest('[class*="attach"]');
      if (container && container.querySelector('input[type="file"]')) continue;
      // Skip ITI (intl-tel-input) phone widget controls — the country-code combobox (a div with
      // aria-required="true") has no .value property, causing a false missing report.
      // Only skip non-input elements inside ITI containers; the phone input itself is checked normally.
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && el.closest('.iti, [class*="iti__"]')) continue;
      let val = (el.value || '').trim();
      // react-select stores selected value in a sibling singleValue span, not el.value
      if (!val && role === 'combobox') {
        const rsContainer = el.closest('[class*="select__container"],[class*="select "]') ||
                            el.parentElement?.parentElement?.parentElement;
        const sv = rsContainer?.querySelector('[class*="single-value"],[class*="singleValue"]');
        if (sv?.textContent?.trim()) val = sv.textContent.trim();
      }
      // Workday selectinput: el.value is always "" even when items are selected.
      // Check the multiselect container's selectedItemList text instead.
      const isWdSelectinput = el.getAttribute('data-uxi-widget-type') === 'selectinput';
      if (!val && isWdSelectinput) {
        const msContainer = el.closest('[data-uxi-widget-type="multiselect"]');
        const selectedList = msContainer?.querySelector('[data-automation-id="selectedItemList"]');
        if (selectedList?.textContent?.trim()) val = selectedList.textContent.trim();
        else if (/\d+\s*item/i.test(msContainer?.textContent || '')) val = '1 item selected';
      }
      if (val && val !== 'Select an option' && val !== '' && val !== 'Select...') continue;
      const label = getLabelFor(el);
      // Skip labels that look like resume/cv upload display fields
      if (label && /^resume|^cv\b|curriculum vitae/i.test(label.trim())) continue;
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      missing.push({
        label,
        type: isWdSelectinput ? 'wd_selectinput'
            : el.tagName === 'SELECT' ? 'select'
            : el.getAttribute('role') === 'combobox' ? 'combobox'
            : el.tagName === 'TEXTAREA' ? 'textarea'
            : el.type || 'text',
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).map(o => o.text.trim()).filter(t => t && !/^select/i.test(t))
          : []
      });
    }

    // Also check required radio groups (shadow-DOM-aware)
    const radioGroups = {};
    for (const r of pjaQueryAllExt('input[type=radio][required], input[type=radio][aria-required="true"]')) {
      if (!r.offsetParent) continue;
      const name = r.name || r.getAttribute('aria-labelledby') || '';
      if (!name || radioGroups[name] !== undefined) continue;
      const root = r.getRootNode() || document;
      const checked = root.querySelector(`input[type=radio][name="${CSS.escape(name)}"]:checked`);
      if (!checked) {
        radioGroups[name] = true;
        const label = getLabelFor(r) || name;
        if (!seen.has(label.toLowerCase())) {
          seen.add(label.toLowerCase());
          missing.push({ label, type: 'radio', options: [] });
        }
      }
    }

    // Required checkbox-GROUP questions (Greenhouse single-select-as-checkboxes) — flagged so
    // they trigger the AI path pre-submit instead of silently failing validation on submit.
    if (typeof pjaFindRequiredCheckboxGroups === 'function') {
      for (const g of pjaFindRequiredCheckboxGroups(document)) {
        if (!g.question || seen.has(g.question.toLowerCase())) continue;
        seen.add(g.question.toLowerCase());
        missing.push({ label: g.question, type: 'checkboxgroup', options: g.options });
      }
    }

    return missing;
  }

  // PURE: pick the AI answer for a field label. Matches by normalized label and gates on
  // confidence — returns the trimmed answer string, or null (no match / empty / low-confidence,
  // so the field stays unfilled and surfaces as missing rather than a guessed value).
  // Policy/factual questions (consent, certification, work-auth, sponsorship, citizenship,
  // EEO, relocation, etc.) are pref-driven answers we always want applied — do NOT gate them
  // on the model's confidence (it hedges on long legalese). Confidence gating applies only to
  // open-ended experiential/knowledge questions, where a low-confidence guess is undesirable.
  // Decide the value to apply from a single AI answer object for `label`.
  // PURE: coerce a possibly-verbose answer to the option that best matches a fixed option list.
  // Handles the common AI shape "No. My background..." → "No", plus leading-token and substring
  // matches. Returns the matched OPTION string, or null when nothing matches (caller keeps the
  // original). Exported + unit-tested (test/unit/answer-correctness.test.js).
  function pjaCoerceToOption(answer, options) {
    const opts = (options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value)) || '')).filter(Boolean);
    if (!opts.length) return null;
    const a = String(answer || '').trim();
    if (!a) return null;
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const na = norm(a);
    // 1. exact (normalized) match
    let hit = opts.find(o => norm(o) === na);
    if (hit) return hit;
    // 2. leading Yes/No token — "no. my background is..." → the No option
    const lead = na.match(/^(yes|no)\b/);
    if (lead) { hit = opts.find(o => norm(o) === lead[1] || new RegExp('^' + lead[1] + '\\b').test(norm(o))); if (hit) return hit; }
    // 3. an option appears as a whole-word phrase inside the answer (longest option first)
    for (const o of [...opts].sort((x, y) => y.length - x.length)) {
      const no = norm(o);
      if (no.length >= 2 && new RegExp('\\b' + no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(na)) return o;
    }
    // 4. the answer is a prefix of exactly one option (or vice-versa)
    const pre = opts.filter(o => norm(o).startsWith(na) || na.startsWith(norm(o)));
    if (pre.length === 1) return pre[0];
    return null;
  }

  function pjaAnswerValue(label, a) {
    if (!a || a.answer == null) return null;
    const ans = String(a.answer).trim();
    if (!ans) return null;
    const isPolicy = /consent|certif|acknowledge|\bi agree\b|terms|gdpr|data (processing|privacy|protection)|authoriz|eligible to work|legally (authorized|entitled|able)|right to work|require.*sponsor|sponsorship|\bcitizen|permanent resident|export control|\bitar\b|\bear\b|clearance|18 (years|or older)|over 18|veteran|disab|gender|\bsex\b|ethnic|\brace\b|hispanic|reloca|background check|drug (test|screen|screening)|willing to|diploma|\bged\b|\bdegree\b|education|high school|bachelor/i.test(label || '');
    if (isPolicy) return ans;                                  // pref-driven → always apply
    if (String(a.confidence).toLowerCase() === 'low') return null; // experiential guess → skip
    return ans;
  }
  // PURE: deterministic answer for common policy questions — reliable across ALL ATSes
  // (esp. Lever .application-question radios that the fieldset-based fallbacks miss). Returns
  // the answer string or null (→ let the AI handle it, e.g. education level, novel questions).
  // Maps a custom-question label to a STANDARD profile value when the field is really a profile
  // field mis-registered as a Greenhouse question_* custom field (e.g. "LinkedIn Profile*",
  // "Location (City)*"). Returns the value string or null. Fixes these reaching the AI answerer
  // (which declines/guesses) instead of filling deterministically from the profile.
  function pjaProfileFieldForLabel(label, profile) {
    const L = String(label || '').toLowerCase();
    profile = profile || {};
    if (/linkedin/.test(L)) return profile.linkedin || null;
    if (/github/.test(L)) return profile.github || null;
    if (/(personal )?website|portfolio\b|\bblog\b/.test(L)) return profile.website || null;
    if (/location.*\(?city|city.*location|current location|where are you (located|based)|your location|location \(city/.test(L))
      return profile.currentLocation || (profile.city ? (profile.city + (profile.state ? ', ' + profile.state : '')) : null);
    return null;
  }
  if (typeof window !== 'undefined') window.pjaProfileFieldForLabel = pjaProfileFieldForLabel;

  function pjaDeterministicAnswer(label) {
    const t = String(label || '');
    if (/referr/i.test(t)) return 'No';
    if (/require.*sponsor|\bsponsorship\b|visa sponsor/i.test(t)) return 'No';
    if (/authoriz|eligible to work|legally (authorized|entitled|able)|right to work/i.test(t)) return 'Yes';
    if (/(now or have you ever|currently)[\s\S]{0,40}(employee|employed|worked? (for|at))/i.test(t)) return 'No';
    if (/worked (for|at)[\s\S]{0,30}(pricewaterhouse|pwc)/i.test(t)) return 'No';
    if (/\bat least 18\b|\bover 18\b|\b18 (years|or older)\b|are you 18/i.test(t)) return 'Yes';
    if (/willing to (relocate|travel|commute)|able to (relocate|commute|travel)|open to relocat/i.test(t)) return 'Yes';
    if (/background check|drug (test|screen)/i.test(t)) return 'Yes';
    if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application/i.test(t)) return 'LinkedIn';
    // Yes/No experience-screening — answer ONLY from her actual resume domains (honest, no
    // fabrication): Yes for documented skills, No for documented gaps, else defer to the AI.
    // Only fires on yes/no framings; excludes open-ended ("describe/explain/what") and numeric
    // ("how many years") prompts, which the AI answerer / years-resolver handles.
    if (!/how many|number of|years of|\byears\b|describe|explain|tell us|provide|\blist\b|what (is|are|was|were)|how (do|did|would|long)/i.test(t) &&
        /do you have (hands.?on )?experience|have you (ever )?(used|worked with)|are you familiar( with)?|are you proficient|hands.?on experience (with|in)/i.test(t)) {
      const LACKS = /\bfmea\b|\b8d\b|iso ?13485|optical metrolog|supplier audit|\bpython\b|\bcad\b|solidworks|programming|software (dev|engineer)|\bsql\b|machine learning|firmware/i;
      if (LACKS.test(t)) return 'No';
      const HAS = /quality|\bqa\b|\bqc\b|manufactur|metrolog|wafer|inspection|defect|thin film|photolith|cleanroom|\byield\b|\bgmp\b|\bspc\b|root cause|measurement|thickness|process (control|improvement)|semiconductor|production|assembly|calibrat|nonconform|\bcapa\b|document control|iso ?9001|continuous improvement|\b5s\b/i;
      if (HAS.test(t)) return 'Yes';
    }
    return null;
  }
  if (typeof window !== 'undefined') window.pjaDeterministicAnswer = pjaDeterministicAnswer;

  // Label-keyed lookup (used by unit tests + as the preferred match).
  function pjaSelectAiAnswer(label, aiAnswers) {
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const want = norm(label);
    return pjaAnswerValue(label, (aiAnswers || []).find(x => norm(x.label) === want));
  }
  if (typeof window !== 'undefined') { window.pjaSelectAiAnswer = pjaSelectAiAnswer; window.pjaAnswerValue = pjaAnswerValue; window.pjaCoerceToOption = pjaCoerceToOption; }
  // Exported so auto-apply.js (Easy Apply) can reuse the exact same answerer on the modal root.
  if (typeof window !== 'undefined') setTimeout(() => { try { window.pjaAnswerRequiredViaAI = pjaAnswerRequiredViaAI; window.pjaCollectRequiredEmptyFields = collectRequiredEmptyFields; } catch (_) {} }, 0);

  // A label too short/garbage to be a real question (e.g. "yes", a stray radio-option label,
  // a bare placeholder). Sending these to the AI confuses it into returning prose, not JSON.
  function pjaIsGarbageLabel(label) {
    const nl = (label || '').trim().toLowerCase();
    if (/^(yes|no|n\/a|na|true|false|select|select\.\.\.|select an option|choose|--|\.\.\.|other)$/.test(nl)) return true;
    if (nl.replace(/[^a-z0-9]/g, '').length < 3) return true; // essentially no content
    return false;
  }
  if (typeof window !== 'undefined') window.pjaIsGarbageLabel = pjaIsGarbageLabel;

  // Collect required-but-empty answerable fields WITH element refs + enriched options,
  // so they can be routed to the AI answerer and the answers applied to the right control.
  // scope: optional root (e.g. an Easy Apply modal element/shadow root) to confine the scan.
  // Defaults to the shadow-aware whole-document query used by external ATS pages.
  function collectRequiredEmptyFields(scope) {
    const out = [];
    const seen = new Set();
    const Q = sel => scope ? Array.from(scope.querySelectorAll(sel)) : pjaQueryAllExt(sel);
    for (const el of Q(
      'input[required]:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),' +
      'select[required], textarea[required],' +
      '[aria-required="true"]:not([type=hidden]):not([type=file])'
    )) {
      if (!el.offsetParent && el.getBoundingClientRect().width === 0) continue;
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (!['input','select','textarea'].includes(tag) && !['combobox','listbox','textbox'].includes(role)) continue;
      const container = el.closest('[class*="upload"],[class*="resume"],[class*="file-input"],[class*="attach"]');
      if (container && container.querySelector('input[type="file"]')) continue;
      if (el.getAttribute('data-uxi-widget-type') === 'selectinput') continue; // WD typeahead handled elsewhere
      let val = (el.value || '').trim();
      if (!val && role === 'combobox') {
        const rs = el.closest('[class*="select__container"],[class*="select "]') || el.parentElement?.parentElement?.parentElement;
        const sv = rs?.querySelector('[class*="single-value"],[class*="singleValue"]');
        if (sv?.textContent?.trim()) val = sv.textContent.trim();
      }
      if (val && !/^select( an option| \.\.\.|\.\.\.)?$/i.test(val)) continue;
      const label = getLabelFor(el);
      if (!label || /^resume|^cv\b|curriculum vitae/i.test(label.trim()) || pjaIsGarbageLabel(label) || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push({
        el, label,
        type: el.tagName === 'SELECT' ? 'select'
            : role === 'combobox' ? 'combobox'
            : el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).map(o => o.text.trim()).filter(t => t && !/^select/i.test(t)) : [],
        maxLength: parseInt(el.getAttribute('maxlength') || '0', 10) || 0,
      });
    }
    // Required radio groups (collect option labels + the group's radios)
    const groups = {};
    for (const r of Q('input[type=radio][required], input[type=radio][aria-required="true"]')) {
      if (!r.offsetParent) continue;
      const name = r.name || r.getAttribute('aria-labelledby') || '';
      if (!name || groups[name]) continue;
      const root = r.getRootNode() || document;
      const radios = Array.from(root.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`));
      if (radios.some(x => x.checked)) { groups[name] = true; continue; }
      groups[name] = true;
      const label = getLabelFor(r) || name;
      if (pjaIsGarbageLabel(label) || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      // Option text per radio = its OWN value/label, NOT getLabelFor (which now returns the
      // shared Lever card QUESTION for every radio in the group). Using the question as the
      // option text would give the AI useless choices (e.g. education-level picker).
      const optionText = x => {
        const v = (x.value || '').trim();
        if (v && v.toLowerCase() !== 'on') return v;
        const l = x.closest && x.closest('label');
        return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      out.push({ el: r, radios, label, type: 'radio',
        options: radios.map(optionText).filter(Boolean), maxLength: 0 });
    }
    // Asterisk-required scan: Greenhouse custom questions are often marked required ONLY by a
    // "*" in the label (no [required]/aria-required on the input), so the selectors above miss
    // them and the form fails validation on submit. Catch visible, empty, asterisk-labelled
    // text/select/combobox controls here too.
    for (const el of Q('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), select, textarea, [role="combobox"]')) {
      if (!el.offsetParent && el.getBoundingClientRect().width === 0) continue;
      if (el.value && el.value.trim()) continue;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (!role && !['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) continue;
      if (!pjaLabelHasAsterisk(el)) continue;
      const label = getLabelFor(el);
      if (!label || /^resume|^cv\b|curriculum vitae/i.test(label.trim()) || pjaIsGarbageLabel(label) || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push({
        el, label,
        type: el.tagName === 'SELECT' ? 'select' : role === 'combobox' ? 'combobox' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => o.text.trim()).filter(t => t && !/^select/i.test(t)) : [],
        maxLength: parseInt(el.getAttribute('maxlength') || '0', 10) || 0,
      });
    }
    // Required checkbox-GROUP questions (Greenhouse single-select rendered as checkboxes).
    if (typeof pjaFindRequiredCheckboxGroups === 'function') {
      for (const g of pjaFindRequiredCheckboxGroups(scope || document)) {
        if (!g.question || pjaIsGarbageLabel(g.question) || seen.has(g.question.toLowerCase())) continue;
        seen.add(g.question.toLowerCase());
        out.push({ el: g.members[0], members: g.members, label: g.question, type: 'checkboxgroup', options: g.options, maxLength: 0 });
      }
    }
    return out;
  }

  // True if the control's associated label/container text carries a required marker (* or ✱).
  function pjaLabelHasAsterisk(el) {
    const texts = [];
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) texts.push(l.textContent); }
    const lc = el.closest && el.closest('label'); if (lc) texts.push(lc.textContent);
    const al = el.getAttribute && el.getAttribute('aria-labelledby');
    if (al) al.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) texts.push(n.textContent); });
    const fld = el.closest && el.closest('.field, [class*="field"], [class*="question"], .form-group');
    if (fld) { const lbl = fld.querySelector('label, .label, legend'); if (lbl) texts.push(lbl.textContent); }
    return texts.some(t => /[*✱]/.test(t || ''));
  }

  // Route still-empty required fields to the AI answerer (background ANSWER_QUESTIONS ->
  // dev-server /answer-questions using profile + resume + pja_prefs) and apply the answers.
  // Honest by construction (prompt forbids fabricating skills she lacks). Low-confidence
  // answers are left unfilled (so they surface as missing rather than guessed).
  // scope: optional root to confine the scan (e.g. a LinkedIn Easy Apply modal). Reused by
  // both external ATS pages (scope=undefined → whole doc) and Easy Apply (scope=modal root).
  async function pjaAnswerRequiredViaAI(job, scope) {
    const dbg = m => new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-19); a.push(m); chrome.storage.local.set({pja_dbg:a}, r); }));
    let fields = collectRequiredEmptyFields(scope);
    if (!fields.length) return { applied: 0, asked: 0 };
    // Deterministic pre-pass: policy questions + profile fields (LinkedIn/location/website)
    // directly from truth — no AI flakiness, and covers TEXT fields (which the AI declined).
    const detProfile = job.profile || {};
    let detApplied = 0;
    for (const f of fields) {
      const ans = pjaDeterministicAnswer(f.label) || pjaProfileFieldForLabel(f.label, detProfile);
      if (!ans) continue;
      try {
        if (f.type === 'radio' && typeof pjaSelectRadio === 'function') pjaSelectRadio(f.radios || [], ans);
        else if (f.type === 'select' && typeof pjaFillSelect === 'function') pjaFillSelect(f.el, ans);
        else if (f.type === 'combobox' && typeof pjaFillCombobox === 'function') pjaFillCombobox(f.el, ans);
        else if ((f.type === 'text' || f.type === 'textarea') && f.el) {
          if (typeof pjaFillTextViaFiber === 'function') pjaFillTextViaFiber(f.el, ans);
          else if (typeof pjaSetNative === 'function') pjaSetNative(f.el, ans);
        }
        else continue;
        detApplied++;
      } catch (_) {}
    }
    if (detApplied) { await dbg('[ai] deterministic applied=' + detApplied); await sleep(500); fields = collectRequiredEmptyFields(scope); }
    if (!fields.length) return { applied: detApplied, asked: 0 };
    // checkboxgroup -> present to the AI as a 'select' so it sees the options and copies one exactly.
    const questions = fields.map(f => ({ label: f.label, type: f.type === 'checkboxgroup' ? 'select' : f.type, options: f.options || [], maxLength: f.maxLength || 0 }));
    await dbg('[ai] asking ' + questions.length + ' req Q: ' + questions.map(q=>q.label.slice(0,22)).join(' | ').slice(0,150));
    const resp = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'ANSWER_QUESTIONS', payload: { questions, jobContext: { title: job.title || '', company: job.company || '' } } },
          r => { if (chrome.runtime.lastError) resolve(null); else resolve(r); });
      } catch (_) { resolve(null); }
    });
    if (!resp || !resp.success || !Array.isArray(resp.answers)) {
      await dbg('[ai] no answers: ' + (resp && resp.error || 'null'));
      return { applied: detApplied, asked: questions.length };
    }
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let applied = detApplied, low = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      // Prefer exact label match; fall back to positional (dev-server returns answers in
      // question order — robust when the model reworords/truncates long legalese labels).
      const a = resp.answers.find(x => norm(x.label) === norm(f.label)) || resp.answers[i];
      let ans = pjaAnswerValue(f.label, a);
      if (!ans) { low++; continue; }
      // Option-typed fields (select/combobox/radio) need the answer to MATCH an option. The AI
      // often returns prose ("No. My background is...") for a Yes/No screen — coerce it to the
      // best-matching option so the filler can commit it (else it stays empty → skip).
      if (['select', 'combobox', 'radio'].includes(f.type) && Array.isArray(f.options) && f.options.length) {
        ans = pjaCoerceToOption(ans, f.options) || ans;
      }
      try {
        if (f.type === 'checkboxgroup' && typeof pjaCheckMatchingBox === 'function') pjaCheckMatchingBox(f.members || [], ans);
        else if (f.type === 'select' && typeof pjaFillSelect === 'function') pjaFillSelect(f.el, ans);
        else if (f.type === 'combobox' && typeof pjaFillCombobox === 'function') pjaFillCombobox(f.el, ans);
        else if (f.type === 'radio' && typeof pjaSelectRadio === 'function') pjaSelectRadio(f.radios || [], ans);
        else if (typeof pjaFillTextViaFiber === 'function') pjaFillTextViaFiber(f.el, ans);
        else if (typeof pjaSetNative === 'function') pjaSetNative(f.el, ans);
        applied++;
      } catch (_) {}
      await sleep(250);
    }
    // pjaFillCombobox QUEUES its selection on the sequential _pjaComboChain and returns
    // immediately — so `applied` counts calls, not commits. Await the chain (bounded) before
    // returning, else the caller's missing-required/submit check runs while a combobox is
    // still selecting → the field reads empty → skip (the Antora question_19018428004 skip).
    if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
      await Promise.race([
        window._pjaComboChain.catch(() => {}),
        new Promise(r => setTimeout(r, 6000)),
      ]);
    }
    await dbg('[ai] applied=' + applied + ' low=' + low + ' of ' + questions.length);
    return { applied, asked: questions.length, low };
  }

  function getLabelFor(el) {
    // Lever custom-question (cards[uuid][fieldN]): the real question is the card's
    // .application-label, not the radio/checkbox option's own "Yes"/"No" label. Each
    // sub-field has its own .application-question ancestor, so this stays distinct per field.
    const aq = el.closest && el.closest('.application-question');
    if (aq) {
      const ql = aq.querySelector('.application-label, .text');
      const qt = ql && ql.textContent.trim();
      if (qt) return qt.replace(/[✱*]+\s*$/, '').trim();
    }
    if (typeof pjaGetLabel === 'function') return pjaGetLabel(el);
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const closest = el.closest('label');
    if (closest) return closest.textContent.trim();
    const prev = el.previousElementSibling;
    if (prev?.tagName === 'LABEL') return prev.textContent.trim();
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('aria-label') || '';
  }

  async function saveMissingQuestions(missing, job) {
    return new Promise(resolve => {
      chrome.storage.local.get('pja_missing_questions', data => {
        const store = data.pja_missing_questions || {};
        for (const f of missing) {
          const key = f.label.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 100);
          if (!store[key]) {
            store[key] = { question: f.label, type: f.type, options: f.options, answer: null, seenCount: 0, contexts: [] };
          }
          store[key].seenCount = (store[key].seenCount || 0) + 1;
          const ctx = { jobId: job.jobId, company: job.company, title: job.title, url: location.href };
          if (!store[key].contexts.find(c => c.jobId === job.jobId)) store[key].contexts.push(ctx);
        }
        chrome.storage.local.set({ pja_missing_questions: store }, resolve);
      });
    });
  }

  // Durable applied-log writer: idempotent by company::title, and MERGES on re-write so an
  // optimistic 'submitting' pre-write at submit-click can be upgraded to 'applied' on
  // confirmation. This fixes the under-count where a submit-navigation (e.g. Greenhouse
  // redirect) killed the content script before recordResult's log write ran. Each record is
  // enriched with jobId/applyUrl/location/channel/url + a confirmedEmail flag so a later
  // verification pass (or a human) can reconcile against the inbox in one click.
  // status precedence: applied > submitting > skipped (never downgraded on merge).
  function pjaWriteAppliedLog(job, fields) {
    fields = fields || {};
    return new Promise(resolve => {
      try {
        chrome.storage.local.get('pja_applied_log', d => {
          const log = Array.isArray(d.pja_applied_log) ? d.pja_applied_log : [];
          const nz = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const key = nz(job.company) + '::' + nz(job.title);
          const RANK = { skipped: 0, submitting: 1, applied: 2 };
          const incomingStatus = fields.status || 'applied';
          // Same company::title can be DISTINCT postings (e.g. 10 AMAT reqs all titled
          // "Process Engineer") — when both sides carry a jobId, require it to match too,
          // else distinct reqs collapse into one merged entry (under-counts + poisons dedupe).
          // A legacy entry without jobId still matches (and gets enriched) so the
          // submitting→applied merge for the same job keeps working.
          const inId = String(job.jobId || job.id || '');
          const existing = log.find(e => nz(e.company) + '::' + nz(e.title) === key
            && (!inId || e.jobId == null || String(e.jobId) === inId));
          if (existing) {
            if ((RANK[incomingStatus] ?? 1) >= (RANK[existing.status] ?? 1)) existing.status = incomingStatus;
            if (fields.reason) existing.reason = fields.reason;
            // fill any enrichment fields we didn't have before
            const enr = { jobId: job.jobId || job.id, applyUrl: job.applyUrl, location: job.location, channel: job.channel || job.ats };
            for (const k in enr) { if (enr[k] != null && existing[k] == null) existing[k] = enr[k]; }
            existing.updatedAt = Date.now();
          } else {
            log.push({
              company: job.company, title: job.title,
              jobId: job.jobId || job.id || null,
              applyUrl: job.applyUrl || null,
              location: job.location || null,
              channel: job.channel || job.ats || 'external',
              url: (typeof location !== 'undefined' ? location.href.slice(0, 200) : null),
              status: incomingStatus,
              reason: fields.reason || null,
              confirmedEmail: false,
              appliedAt: Date.now()
            });
          }
          chrome.storage.local.set({ pja_applied_log: log }, () => resolve(log));
        });
      } catch (_) { resolve(null); }
    });
  }
  if (typeof window !== 'undefined') window.pjaWriteAppliedLog = pjaWriteAppliedLog;

  // Pure post-submit success detector (testable). Tightened to cut false 'submit_unclear':
  // broader confirmation phrasings + URL/title tokens, and a redirect only counts as success
  // when the application form is actually GONE (avoids false positives from in-page re-renders).
  const PJA_SUBMIT_SUCCESS_RE = /thank you|thanks for (applying|your (application|interest|submission))|your application|application (received|complete|completed|submitted|confirmed|has been (received|submitted|sent|completed)|was (received|submitted|sent))|we.?ve received|we have received|received your application|submitted successfully|applied successfully|you.?ve applied|you have applied|submission (complete|received|successful)|appreciate your (interest|application)|confirmation/i;
  function pjaIsSubmitSuccess(snap) {
    snap = snap || {};
    const text = String(snap.text || ''), title = String(snap.title || ''), url = String(snap.url || '');
    const preSubmitUrl = String(snap.preSubmitUrl || '');
    const hasSubmitButton = snap.hasSubmitButton !== false;
    const hasFormFields = snap.hasFormFields !== false;
    const iterations = Number.isFinite(snap.iterations) ? snap.iterations : 99;
    // 1. Confirmation text in title or body.
    if (PJA_SUBMIT_SUCCESS_RE.test((title + ' ' + text).slice(0, 6000))) return true;
    // 2. Landed on a confirmation/post-apply route.
    if (/thank|confirm|success|submitted|post-?apply|application[-_]?(complete|received|confirmation|success)|\/applied\b/i.test(url)) return true;
    // 3. Redirected to a DIFFERENT path AND the form is gone → submission went through + redirect.
    if (url && preSubmitUrl && url !== preSubmitUrl) {
      const pathOf = u => { try { return new URL(u).pathname; } catch (_) { return u; } };
      if (pathOf(url) !== pathOf(preSubmitUrl) && !hasFormFields) return true;
    }
    // 4. SPA replaced the form in-place (submit button + fields both gone) after a couple polls.
    if (!hasSubmitButton && !hasFormFields && iterations >= 2) return true;
    return false;
  }
  if (typeof window !== 'undefined') window.pjaIsSubmitSuccess = pjaIsSubmitSuccess;

  async function recordResult(job, result) {
    console.log('PJA ext-apply RESULT:', job.company, result.success ? '✓ APPLIED' : '✗ SKIP:', result.reason || '', result.fields?.join('; ') || '');
    // Mark job as handled so we don't re-process on reload
    job._handled = true;
    await new Promise(resolve => chrome.storage.local.set({ pja_ext_current: job }, resolve));

    // Bug2 fix: persist successful applies to a DURABLE log (pja_ext_queue gets overwritten each
    // run, so sourcing dedupe needs this to avoid re-surfacing already-applied roles).
    if (result.success) {
      await pjaWriteAppliedLog(job, { status: 'applied', reason: result.reason });
    }

    return new Promise(resolve => {
      chrome.storage.local.get('pja_ext_queue', data => {
        const queue = data.pja_ext_queue;
        if (!queue) { resolve(); return; }
        // Guard against overwriting a new queue that was seeded while this run was in progress.
        if (queue.runId && job.runId && queue.runId !== job.runId) {
          console.log('PJA ext-apply: runId mismatch in recordResult, not writing', job.runId, '→', queue.runId);
          resolve(); return;
        }

        // Normalize results to {applied, skipped} object regardless of how queue was seeded
        if (!queue.results || Array.isArray(queue.results)) queue.results = { applied: [], skipped: [] };
        const r = queue.results;
        if (result.success) {
          r.applied.push({ ...job, appliedAt: Date.now() });
        } else {
          r.skipped.push({ ...job, skipReason: result.fields?.slice(0, 3).join('; ') || result.reason });
        }

        queue.currentIndex++;
        if (queue.currentIndex >= queue.jobs.length) queue.status = 'done';

        chrome.storage.local.set({ pja_ext_queue: queue }, () => {
          // Push status to dev server for monitoring
          try {
            fetch('http://localhost:6174/queue-status', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: queue.status, currentIndex: queue.currentIndex, total: queue.jobs.length,
                applied: queue.results.applied.map(j => j.title + ' @ ' + j.company),
                skipped: queue.results.skipped.map(j => j.title + ' @ ' + j.company + ': ' + j.skipReason),
                ts: new Date().toISOString()
              })
            }).catch(() => {});
          } catch(e) {}
          resolve();
        });
      });
    });
  }

  function navigateBack(job) {
    // If next job in queue has a direct applyUrl, go there without LinkedIn roundtrip
    chrome.storage.local.get('pja_ext_queue', data => {
      const queue = data.pja_ext_queue;
      if (queue && queue.status === 'applying') {
        const nextJob = queue.jobs[queue.currentIndex];
        if (nextJob && nextJob.applyUrl) {
          const nextCurrent = {
            ...nextJob,
            profile: job.profile || {},
            answers: job.answers || {},
            returnUrl: job.returnUrl || 'https://www.linkedin.com/jobs/search/?f_AL=true'
          };
          chrome.storage.local.set({ pja_ext_current: nextCurrent, pja_navigate_to: nextJob.applyUrl }, () => {
            window.location.href = nextJob.applyUrl;
          });
          return;
        }
      }
      // Fall back: LinkedIn-based flow (pja_ext_ret=1 triggers resumeExtApplyOnLoad)
      let url = job.returnUrl || 'https://www.linkedin.com/jobs/search/?f_AL=true';
      try {
        const u = new URL(url);
        u.searchParams.set('pja_ext_ret', '1');
        url = u.toString();
      } catch(e) {}
      // Don't store LinkedIn returnUrl in pja_navigate_to — that key is for ATS→ATS recovery only.
      // Storing it causes the next queue run's ATS page to immediately redirect back to LinkedIn.
      chrome.storage.local.remove('pja_navigate_to', () => { window.location.href = url; });
    });
  }
})();
