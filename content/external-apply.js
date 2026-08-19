'use strict';
// Runs on ATS pages (Greenhouse, Lever, Workday, etc.) during external apply automation.
// Reads pja_ext_current from chrome.storage.local, fills form, records result.

(function () {
  if (window.__pjaExtApplyLoaded) return;
  window.__pjaExtApplyLoaded = true;

  // Never run on Google/Gmail pages — Gmail is used by the verification helper, and external
  // apply queue recovery must not treat that tab as an ATS page or navigate it back to LinkedIn.
  if (/(^|\.)google\.com$/i.test(location.hostname)) return;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function pjaClassifyExternalPreflight(signals) {
    const policy = window.PJAPreflight;
    if (!policy || typeof policy.classifyPreflight !== 'function') return null;
    return policy.classifyPreflight(signals || {});
  }
  window.pjaClassifyExternalPreflight = pjaClassifyExternalPreflight;

  // When true, the flow fills the form and stops WITHOUT clicking the final submit,
  // leaving the completed application on screen for the user to review + submit.
  // Set false to auto-submit. (Read live from storage so it can be toggled per run.)
  // User preference: real E2E runs submit by default. A particular ranked run can still opt into
  // review mode by setting pja_ext_stop_before_submit / stopBeforeSubmit explicitly.
  const PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT = false;

  let pjaRuntimeProfile = {};
  let pjaRuntimeAnswers = {};

  function pjaSanitizeRuntimeProfile(p) {
    const src = p && typeof p === 'object' ? p : {};
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (/^(resumeDataUrl|resumeText|resume|pja_resume_b64)$/i.test(k)) continue;
      if (typeof v === 'string' && /^data:.*;base64,/i.test(v.slice(0, 80))) continue;
      out[k] = v;
    }
    return out;
  }

  async function pjaAddExtDbg(msg) {
    try {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const a = (d.pja_dbg || []).slice(-40);
        a.push(String(msg || '').slice(0, 500));
        chrome.storage.local.set({ pja_dbg: a }, r);
      }));
    } catch (_) {}
  }

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
  const CONCRETE_ATS_HOST_PATTERNS = /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs\.com|jobvite\.com|icims\.com|smartrecruiters\.com|ashbyhq\.com|bamboohr\.com|taleo\.net|applytojob\.com|jazz\.co|recruitee\.com|rippling\.com|successfactors\.com|smashfly\.com/i;

  // Recovery: if navigateBack stored a destination that survived a page redirect, navigate there now.
  // This handles cases where an ATS page redirected before our setTimeout could fire. Top frame only
  // — an embedded ATS iframe must not self-navigate away from the form.
  try {
    if (window.self !== window.top) throw new Error('skip-recovery-in-iframe');
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
    chrome.storage.local.get(['pja_ext_current', 'pja_answers', 'pja_ext_queue', 'pja_ranked_apply'], async data => {
      // Never run on LinkedIn/Indeed/Glassdoor (those are handled by content.js)
      if (/linkedin\.com|indeed\.com|glassdoor\.com/i.test(location.hostname)) return;

      // Frame coordination for embedded-ATS forms: many companies embed the ATS application form in
      // a cross-origin iframe (e.g. job-boards.greenhouse.io/embed inside company.com/apply). With
      // all_frames:true the fill suite runs in BOTH the top frame and the iframe. The IFRAME (an ATS
      // host) has the actual form and handles it; the TOP frame should defer when it merely embeds an
      // ATS iframe, so the two frames don't both process the same job.
      const _inIframe = window.self !== window.top;
      if (!_inIframe && !ATS_PATTERNS.test(location.hostname)) {
        const atsFrame = document.querySelector('iframe[src*="greenhouse.io"],iframe[src*="lever.co"],iframe[src*="ashbyhq.com"],iframe[src*="icims.com"],iframe[src*="myworkdayjobs.com"],iframe[src*="workday.com"],iframe[src*="jobvite.com"],iframe[src*="smartrecruiters.com"]');
        if (atsFrame) { console.log('PJA ext-apply: top frame embeds an ATS iframe — deferring to the iframe'); return; }
      }

      let job = data.pja_ext_current;
      let queue = data.pja_ext_queue;
      const urlKey = u => {
        try {
          const x = new URL(u, location.href);
          return (x.hostname + x.pathname).replace(/\/+$/, '').toLowerCase();
        } catch (_) {
          return String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
        }
      };
      // Ranked apply opens one ATS tab per reserve. Many Greenhouse jobs share the same hostname,
      // so a host-only guard can let a stale pja_ext_current process the wrong job URL. If the
      // current page exactly matches the ranked master's current job, repair the one-job queue and
      // pja_ext_current before any fill/submit work starts.
      const ranked = data.pja_ranked_apply || null;
      const rankedJob = ranked && ranked.status === 'applying' && Array.isArray(ranked.jobs)
        ? ranked.jobs[ranked.currentIndex] : null;
      if (rankedJob && ranked.runId && urlKey(rankedJob.applyUrl) === urlKey(location.href) &&
          (!job || job.runId !== ranked.runId || !pjaSameQueuedJob(job, rankedJob))) {
        const repaired = Object.assign({}, rankedJob, {
          returnUrl: 'https://www.linkedin.com/jobs/',
          runId: ranked.runId,
          rankedRun: true,
          applicationAt: rankedJob.applicationAt || ranked.inFlightAt || Date.now(),
        });
        const repairedQueue = {
          status: 'applying',
          jobs: [repaired],
          currentIndex: 0,
          results: { applied: [], skipped: [] },
          runId: ranked.runId,
          startedAt: queue?.startedAt || ranked.inFlightAt || Date.now(),
        };
        await new Promise(r => chrome.storage.local.set({
          pja_ext_current: repaired,
          pja_ext_queue: repairedQueue,
        }, r));
        job = repaired;
        queue = repairedQueue;
        console.log('PJA ext-apply: repaired stale ranked current from URL match', repaired.company, repaired.title);
      }
      if (!job) { console.log('PJA ext-apply: no pja_ext_current, skipping'); return; }
      console.log('PJA ext-apply: job read v2, _handled=', job._handled, 'company=', job.company);

      // Only treat per-job lifecycle flags as valid for the queue run that created them.
      const sameRun = queue && job.runId && job.runId === queue.runId;
      function pjaSanitizeResultJob(j) {
        const out = {};
        const allowed = [
          'id', 'jobId', 'sourceJobId', 'runId', 'applyUrl', 'listingUrl', 'company', 'title',
          'location', 'ats', 'strategy', 'channel', 'fitScore', 'confidence', 'applicationAt',
          '_confirmationSource', '_confirmedAt',
        ];
        for (const k of allowed) if (j && Object.prototype.hasOwnProperty.call(j, k)) out[k] = j[k];
        return out;
      }
      let profile = pjaSanitizeRuntimeProfile((job.profile && Object.keys(job.profile).length > 0) ? job.profile : {});
      let answers = (data.pja_answers && Object.keys(data.pja_answers).length > 0) ? data.pja_answers : {};
      pjaRuntimeProfile = profile;
      pjaRuntimeAnswers = answers;

      // A submit may navigate before the original content-script instance can inspect the result.
      // Recover that lifecycle here, but only promote it after the NEW page supplies a genuine
      // confirmation signal. A navigation by itself is not proof that an application was accepted.
      if (job._submitPending && sameRun && String(job._preSubmitUrl || '') !== String(location.href)) {
        let confirmed = false;
        for (let i = 0; i < 12; i++) {
          if (i) await sleep(400);
          const hasSubmitButton = pjaQueryAllExt('button[type=submit], input[type=submit]')
            .some(b => /submit/i.test((b.textContent || '') + (b.value || '')));
          const hasFormFields = pjaQueryAllExt('form input, form select, form textarea')
            .some(el => el.type !== 'hidden');
          confirmed = pjaIsSubmitSuccess({ text: document.body?.innerText || '', title: document.title,
            url: location.href, preSubmitUrl: job._preSubmitUrl || '', hasSubmitButton,
            hasFormFields, iterations: i });
          if (confirmed) break;
        }
        delete job._submitPending;
        delete job._preSubmitUrl;
        delete job._submitStartedAt;
        await new Promise(r => chrome.storage.local.set({ pja_ext_current: job }, r));
        await recordResult(job, { success: confirmed,
          reason: confirmed ? 'post_navigation_confirmation' : 'submit_unconfirmed_after_navigation' });
        navigateBack(job);
        return;
      }

      // Guard: never redirect a non-ATS tab (e.g. google.com) — check expected host first.
      // Allow the mismatch when we've landed on a known ATS: company career domains
      // routinely redirect to their underlying ATS (e.g. jobs.jbsfoodsgroup.com → jobvite.com).
      if (job.applyUrl) {
        try {
          const expectedHost = new URL(job.applyUrl).hostname;
          const expectedConcreteAts = CONCRETE_ATS_HOST_PATTERNS.test(expectedHost);
          const actualConcreteAts = CONCRETE_ATS_HOST_PATTERNS.test(location.hostname);
          if (location.hostname !== expectedHost && expectedConcreteAts && actualConcreteAts) {
            await pjaAddExtDbg('[guard] concrete ATS host mismatch early skip actual=' + location.hostname +
              ' expected=' + expectedHost + ' job=' + String(job.company || '').slice(0, 60));
            console.log('PJA ext-apply: concrete ATS hostname mismatch early:', location.hostname, '≠', expectedHost, '— skipping');
            return;
          }
          if (location.hostname !== expectedHost && !ATS_PATTERNS.test(location.hostname)) {
            console.log('PJA ext-apply: hostname mismatch early:', location.hostname, '≠', expectedHost, '— skipping');
            return;
          }
        } catch(e) {}
      }

      // `_handled` is now written only after result verification. Legacy optimistic handled flags
      // lack `_confirmationSource`; never let those inflate the confirmed application count.
      if (job._handled && sameRun) {
        // recordResult may not have run if page navigation killed the script during submit.
        // Advance the queue now if currentIndex still points to this job, then navigate.
        const myIdx = queue.jobs.findIndex(j => (j.id || j.jobId) === (job.id || job.jobId));
        if (queue.status === 'applying' && myIdx >= 0 && queue.currentIndex === myIdx) {
          const wasConfirmed = job._confirmationSource === 'page';
          console.log('PJA ext-apply: handled recovery, confirmed=', wasConfirmed, 'for', job.company);
          const bucket = wasConfirmed ? queue.results.applied : queue.results.skipped;
          bucket.push(wasConfirmed
            ? { ...pjaSanitizeResultJob(queue.jobs[myIdx]), appliedAt: Date.now(), note: 'confirmed-before-navigation' }
            : { ...pjaSanitizeResultJob(queue.jobs[myIdx]), skipReason: 'legacy_submit_unverified' });
          queue.currentIndex = myIdx + 1;
          if (queue.currentIndex >= queue.jobs.length) queue.status = 'done';
          const persist = wasConfirmed
            ? pjaWriteAppliedLog(job, { status: 'applied', reason: 'confirmed-before-navigation',
              confirmationSource: 'page', confirmedAt: job._confirmedAt || Date.now() })
            : pjaWriteAppliedLog(job, { status: 'submitting', reason: 'legacy_submit_unverified' });
          persist.then(() => chrome.storage.local.set({ pja_ext_queue: queue }, () => {
            if (chrome.runtime.lastError) console.warn('PJA ext-apply: queue recovery write failed', chrome.runtime.lastError.message);
            // Crash-recovery must also notify the serialized ledger/master. Previously this repaired
            // only the legacy queue, leaving the global ranked run stuck until its watchdog marked a
            // genuinely confirmed submission as failed.
            const event = {
              runId: job.runId || queue.runId || null, jobId: job.jobId || job.id || null,
              applyUrl: job.applyUrl || location.href, company: job.company, title: job.title,
              channel: job.channel || job.ats || 'external',
              status: wasConfirmed ? 'applied' : 'submitted', success: wasConfirmed ? true : null,
              reason: wasConfirmed ? 'confirmed-before-navigation' : 'legacy_submit_unverified',
              confirmationSource: wasConfirmed ? 'page' : null,
              confirmedAt: wasConfirmed ? (job._confirmedAt || Date.now()) : null,
              applicationAt: job.applicationAt || queue.startedAt || Date.now(), occurredAt: Date.now(),
            };
            try {
              chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', event,
                closeTab: !!job.rankedRun }, () => { void chrome.runtime.lastError; navigateBack(job); });
            } catch (_) { navigateBack(job); }
          }));
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
          const expectedConcreteAts = CONCRETE_ATS_HOST_PATTERNS.test(expectedHost);
          const actualConcreteAts = CONCRETE_ATS_HOST_PATTERNS.test(location.hostname);
          if (location.hostname !== expectedHost && expectedConcreteAts && actualConcreteAts) {
            await pjaAddExtDbg('[guard] concrete ATS host mismatch skip actual=' + location.hostname +
              ' expected=' + expectedHost + ' job=' + String(job.company || '').slice(0, 60));
            console.log('PJA ext-apply: concrete ATS hostname mismatch:', location.hostname, '≠', expectedHost, '— skipping');
            return;
          }
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

      startExternalApply(job, data.pja_answers || {}, 'initial')
        .catch(e => console.log('PJA ext-apply outer promise catch:', e.message, e.stack?.slice(0,200)));
    });
  } catch(e) {
    console.log('PJA ext-apply: outer storage.get failed (context invalidated?):', e.message);
  }

  async function startExternalApply(job, rawAnswers, reason) {
    const currentUrl = location.href;
    if (window.__pjaExtApplyInFlight) {
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        try {
          await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
            const a = (d.pja_dbg || []).slice(-40);
            a.push('[WD] ext runner skip reason=' + reason + ' activeUrl=' +
              String(window.__pjaExtApplyInFlightUrl || '').slice(0, 120) + ' newUrl=' + currentUrl.slice(0, 120));
            chrome.storage.local.set({ pja_dbg: a }, r);
          }));
        } catch (_) {}
      }
      return;
    }
    const runToken = Date.now() + ':' + Math.random().toString(36).slice(2, 8);
    window.__pjaExtApplyInFlight = true;
    window.__pjaExtApplyInFlightUrl = currentUrl;
    window.__pjaExtApplyInFlightToken = runToken;
    try {
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
          const a = (d.pja_dbg || []).slice(-40);
          a.push('[WD] ext runner start reason=' + reason + ' url=' + currentUrl.slice(0, 220));
          chrome.storage.local.set({ pja_dbg: a }, r);
        }));
      }
      await waitForForm();
      if (await pjaOpenWorkdayListingEntry(job, reason)) return { handled: true, reason: 'workday_listing_entry_navigation' };
      const router = window.PJAApplyRouter;
      if (router && typeof router.executeStrategy === 'function') {
        const dispatched = await router.executeStrategy(job, {
          url: location.href,
          signals: typeof router.readSignals === 'function' ? router.readSignals(document) : null,
          rawAnswers: rawAnswers || {},
          reason,
        });
        if (dispatched && dispatched.handled) return dispatched;
        // The generic external handler should always be registered below. Fail explicitly if a
        // future strategy is added without an executor so the master queue gets a useful result.
        throw new Error((dispatched && dispatched.reason) || 'missing_apply_handler');
      }
      return await runExternalApply(job, rawAnswers || {});
    } finally {
      if (window.__pjaExtApplyInFlightToken === runToken) {
        window.__pjaExtApplyInFlight = false;
        window.__pjaExtApplyInFlightUrl = '';
        window.__pjaExtApplyInFlightToken = '';
      }
    }
  }

  async function pjaOpenWorkdayListingEntry(job, reason) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
    if (/\/apply(?:\/|$)/i.test(location.pathname)) return false;
    const hasForm = !!document.querySelector('form input, form select, form textarea, [data-automation-id="textInputBox"], [data-automation-id="selectWidget"], [data-automation-id="bottomNavigationNext"], [data-automation-id="pageFooterNextButton"]');
    if (hasForm) return false;
    const visible = el => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (_) {
        return false;
      }
    };
    const controls = Array.from(document.querySelectorAll('a,button,[role=button]'))
      .filter(visible)
      .map(el => ({
        el,
        text: (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '),
        href: el.href || el.getAttribute('href') || '',
      }))
      .filter(x => x.text);
    const entry = controls.find(x => /continue application/i.test(x.text)) ||
      controls.find(x => /^apply$/i.test(x.text) || /apply now|start application/i.test(x.text));
    if (!entry) return false;

    const navKey = 'pja_wd_pre_router_entry_' + String((job && (job.id || job.jobId || job.applyUrl)) || location.pathname || '')
      .replace(/[^\w-]+/g, '_').slice(-90);
    const attempts = parseInt(sessionStorage.getItem(navKey) || '0', 10) || 0;
    if (attempts >= 6) {
      await pjaAddExtDbg('[WD] pre-router listing entry exhausted reason=' + String(reason || '') + ' controls=[' + controls.map(x => x.text).slice(0, 8).join('|') + ']');
      return false;
    }
    sessionStorage.setItem(navKey, String(attempts + 1));

    let targetUrl = '';
    if (entry.href) {
      try { targetUrl = new URL(entry.href, location.href).href; } catch (_) {}
    }
    if (!targetUrl || targetUrl.replace(/[?#].*$/, '') === location.href.replace(/[?#].*$/, '')) {
      const sourceUrl = String((job && job.applyUrl) || location.href || '').trim();
      const cleanUrl = sourceUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
      targetUrl = /\/apply\/applyManually(?:\/|$)/i.test(cleanUrl)
        ? cleanUrl.replace(/\/apply\/applyManually$/i, '/apply')
        : /\/apply(?:\/|$)/i.test(cleanUrl)
          ? sourceUrl
          : cleanUrl + '/apply';
    }

    await pjaAddExtDbg('[WD] pre-router listing entry attempt=' + (attempts + 1) +
      ' text=' + entry.text.slice(0, 80) + ' target=' + String(targetUrl || '').slice(0, 180));
    if (targetUrl && targetUrl.replace(/[?#].*$/, '') !== location.href.replace(/[?#].*$/, '')) {
      location.assign(targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'pja_wd_entry_retry=' + (attempts + 1));
      return true;
    }
    if (typeof trustedWorkdayClick === 'function') {
      try {
        if (await trustedWorkdayClick(entry.el, 'pre-router-listing-apply')) return true;
      } catch (_) {}
    }
    try { entry.el.click(); return true; } catch (_) {}
    return false;
  }

  // The existing external engine contains mature ATS-specific branches. Register those branches
  // behind the shared router now; subsequent work can move each wrapper into its own module without
  // changing queue orchestration or the handler/result contract.
  function runExternalStrategy(context) {
    return runExternalApply(context.job, context.rawAnswers || {});
  }
  if (window.PJAApplyRouter && typeof window.PJAApplyRouter.registerHandler === 'function') {
    ['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'eightfold', 'icims', 'taleo',
      'successfactors', 'jobvite', 'workable', 'breezy', 'bamboohr', 'paylocity', 'rippling', 'generic']
      .forEach(name => window.PJAApplyRouter.registerHandler(name, runExternalStrategy));
  }

  if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
    let lastWorkdayWatchKey = '';
    setInterval(() => {
      if (!/\/apply(?:\/|$)/i.test(location.pathname)) return;
      const key = location.href.replace(/[?#].*$/, '');
      if (key === lastWorkdayWatchKey && window.__pjaExtApplyInFlight && window.__pjaExtApplyInFlightUrl === location.href) return;
      chrome.storage.local.get(['pja_ext_current', 'pja_answers', 'pja_ext_queue'], data => {
        const job = data.pja_ext_current;
        const queue = data.pja_ext_queue;
        if (!job || !queue || queue.status !== 'applying') return;
        if (queue.runId) job.runId = queue.runId;
        try {
          const expectedHost = new URL(job.applyUrl || location.href, location.href).hostname;
          if (expectedHost !== location.hostname) return;
        } catch (_) {}
        lastWorkdayWatchKey = key;
        startExternalApply(job, data.pja_answers || {}, 'workday-url-watch')
          .catch(e => console.log('PJA ext-apply Workday watch catch:', e.message, e.stack?.slice(0,200)));
      });
    }, 2000);
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
    let profile = pjaSanitizeRuntimeProfile(
      job && job.profile && Object.keys(job.profile).length > 0 ? job.profile : pjaRuntimeProfile
    );
    let answers = rawAnswers && Object.keys(rawAnswers).length > 0 ? rawAnswers : pjaRuntimeAnswers;
    pjaRuntimeProfile = profile;
    pjaRuntimeAnswers = answers || {};
    const writeLocal = (obj) => new Promise(r => chrome.storage.local.set(obj, r));
    const readRecentDbg = () => new Promise(r => chrome.storage.local.get('pja_dbg', d => r((d.pja_dbg || []).slice(-12))));
    const addDbg = msg => new Promise(r => chrome.storage.local.get('pja_dbg', d => {
      const arr = (d.pja_dbg || []).slice(-19); arr.push(msg); chrome.storage.local.set({ pja_dbg: arr }, r);
    }));
    const collectApplyDomSummary = () => {
      try {
        const controls = pjaQueryAllExt('button, input, select, textarea, [role="button"], [role="combobox"], spl-select, spl-autocomplete')
          .filter(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return false; } })
          .slice(0, 40)
          .map(el => ({
            tag: el.tagName,
            type: el.type || '',
            role: el.getAttribute('role') || '',
            id: (el.id || '').slice(0, 80),
            name: (el.name || '').slice(0, 80),
            text: ((el.textContent || el.value || el.getAttribute('aria-label') || '')).trim().replace(/\s+/g, ' ').slice(0, 120),
            required: !!(el.required || el.getAttribute('aria-required') === 'true'),
            invalid: el.getAttribute('aria-invalid') || '',
          }));
        const errors = pjaQueryAllExt('[aria-invalid="true"], [role="alert"], [class*="error"], [class*="invalid"]')
          .filter(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return false; } })
          .slice(0, 20)
          .map(el => ((el.textContent || el.getAttribute('aria-label') || el.id || el.className || '')).trim().replace(/\s+/g, ' ').slice(0, 160))
          .filter(Boolean);
        return {
          url: location.href,
          title: document.title,
          workday: window.PJAWorkdayEngine && typeof window.PJAWorkdayEngine.snapshot === 'function'
            ? window.PJAWorkdayEngine.snapshot(document)
            : null,
          controls,
          errors,
          required: findMissingRequired().slice(0, 20).map(m => ({ label: m.label, type: m.type, options: (m.options || []).slice(0, 10) })),
          textTail: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(-1500),
        };
      } catch (e) {
        return { error: e.message, url: location.href, title: document.title };
      }
    };
    const redactVisibleText = text => String(text || '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g, '[phone]');
    const collectPostClickPageSnapshot = () => {
      try {
        const visible = el => {
          try {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          } catch (_) {
            return false;
          }
        };
        const textOf = el => {
          const tag = (el.tagName || '').toLowerCase();
          const type = (el.type || '').toLowerCase();
          // Do not persist typed profile answers. Button/submit values are labels, not applicant data.
          const val = (tag === 'button' || type === 'button' || type === 'submit') ? (el.value || '') : '';
          return redactVisibleText((el.textContent || val || el.getAttribute('aria-label') || el.placeholder || '').trim().replace(/\s+/g, ' ')).slice(0, 180);
        };
        const controls = pjaQueryAllExt('button, input, select, textarea, [role="button"], [role="combobox"], [role="textbox"]')
          .filter(visible)
          .slice(0, 60)
          .map(el => ({
            tag: el.tagName,
            type: el.type || '',
            role: el.getAttribute('role') || '',
            name: (el.name || '').slice(0, 80),
            id: (el.id || '').slice(0, 80),
            label: textOf(el),
            required: !!(el.required || el.getAttribute('aria-required') === 'true'),
            invalid: el.getAttribute('aria-invalid') || '',
            disabled: !!el.disabled,
          }));
        const errors = pjaQueryAllExt('[aria-invalid="true"], [role="alert"], [class*="error"], [class*="invalid"]')
          .filter(visible)
          .slice(0, 30)
          .map(el => redactVisibleText((el.textContent || el.getAttribute('aria-label') || el.id || el.className || '').trim().replace(/\s+/g, ' ')).slice(0, 240))
          .filter(Boolean);
        return {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          workday: window.PJAWorkdayEngine && typeof window.PJAWorkdayEngine.snapshot === 'function'
            ? window.PJAWorkdayEngine.snapshot(document)
            : null,
          activeElement: document.activeElement ? {
            tag: document.activeElement.tagName,
            type: document.activeElement.type || '',
            role: document.activeElement.getAttribute?.('role') || '',
            label: textOf(document.activeElement),
          } : null,
          controls,
          errors,
          successDetected: pjaIsSubmitSuccess({
            text: document.body?.innerText || '',
            title: document.title,
            url: location.href,
            preSubmitUrl: job._preSubmitUrl || job.applyUrl || '',
            hasSubmitButton: !!findButton(/submit/i),
            hasFormFields: !!pjaQueryAllExt('form input, form select, form textarea').length,
            iterations: 0,
          }),
          textTail: redactVisibleText(document.body?.innerText || '').replace(/\s+/g, ' ').slice(-1800),
          ts: Date.now(),
        };
      } catch (e) {
        return { error: e.message, url: location.href, title: document.title, ts: Date.now() };
      }
    };
    async function capturePostClickDiagnostic(reason, extra = {}) {
      const snapshot = {
        reason,
        company: job.company,
        title: job.title,
        applyUrl: job.applyUrl || location.href,
        runId: job.runId || '',
        phase: sessionStorage.getItem('pja_last_action') || '',
        stepLog: await readRecentDbg(),
        page: collectPostClickPageSnapshot(),
        extra,
      };
      await writeLocal({ pja_last_post_click_diagnostic_pending: { ...snapshot, ts: Date.now() } });
      const resp = await new Promise(resolve => {
        try {
          chrome.runtime.sendMessage({ type: 'CAPTURE_APPLY_DIAGNOSTIC', snapshot }, r => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(r || { ok: false, error: 'no-response' });
          });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
      await addDbg('[diag] post-click ' + reason + ' => ' + (resp.ok ? 'captured' : ('failed:' + String(resp.error || 'unknown').slice(0, 60))));
      return resp;
    }
    const applyHelpReasons = new Set([
      'captcha', 'workday_captcha', 'submit_unclear', 'watchdog_timeout', 'stuck_budget',
      'no_submit_btn', 'no_apply_btn_on_description', 'no_submit_after_spa',
      'wd_selectinput_blocked', 'workday_auth_sign_in_error', 'needs_login',
      'workday_create_rejected_no_visible_error', 'workday_account_exists_wrong_password',
      'workday_duplicate_record',
      'apply_btn_no_form', 'posting_not_found', 'missing_required', 'email_verification_required', 'chatbot_apply_manual'
    ]);
    const isSmartRecruitersHost = /smartrecruiters\.com/i.test(location.hostname);
    const visibleApplicationControls = () => pjaQueryAllExt(
      'input:not([type=hidden]), textarea, select, spl-input, spl-autocomplete, spl-phone-field, spl-checkbox, spl-select, [role="combobox"], [role="textbox"], ' +
      'button, input[type=submit], [role=button]'
    ).filter(el => {
      try {
        const txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        if (/^cookie settings$/i.test(txt)) return false;
        // SmartRecruiters can leave decorative/floating controls (observed: a lone "🔬" button)
        // on an otherwise empty SPA step. Those are not application controls and must not suppress
        // the empty-step retry/no_submit_after_spa path.
        if (/^[\s🔬]+$/.test(txt)) return false;
        const tag = (el.tagName || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        if ((tag === 'button' || role === 'button' || el.type === 'submit') &&
            !/next|continue|submit|apply|save|review|upload|attach|manual|done|finish/i.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (_) {
        return false;
      }
    });
    async function recoverSmartRecruitersEmptyStep(phase) {
      if (!isSmartRecruitersHost) return false;
      if (visibleApplicationControls().length) return false;
      const key = 'pja_sr_empty_step_retry_' + (job.id || job.jobId || job.applyUrl || '') + '_' + phase;
      if (sessionStorage.getItem(key) === '1') {
        await addDbg('[SR] empty SPA step persisted phase=' + phase + ' url=' + location.pathname.slice(-60));
        return 'empty';
      }
      sessionStorage.setItem(key, '1');
      await addDbg('[SR] empty SPA step after advance; waiting for hydrated form phase=' + phase);
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (visibleApplicationControls().length) {
          await addDbg('[SR] hydrated controls appeared after empty step phase=' + phase + ' n=' + visibleApplicationControls().length);
          return 'rerun';
        }
      }
      await addDbg('[SR] empty SPA step timeout phase=' + phase + ' url=' + location.pathname.slice(-80));
      return 'empty';
    }
    async function maybeRequestApplyHelp(reason, extra = {}) {
      if (!applyHelpReasons.has(String(reason || ''))) return null;
      try {
        const snapshot = {
          reason,
          company: job.company,
          title: job.title,
          ats: job.ats || '',
          applyUrl: job.applyUrl || location.href,
          hostname: location.hostname,
          phase: sessionStorage.getItem('pja_last_action') || '',
          stuckForMs: extra.stuckForMs || 0,
          missingRequired: Array.isArray(extra.missingRequired) ? extra.missingRequired : [],
          visibleErrors: Array.isArray(extra.visibleErrors) ? extra.visibleErrors : [],
          formSummary: extra.formSummary || '',
          recoveryAttempt: extra.recoveryAttempt || 0,
          previousRecovery: Array.isArray(extra.previousRecovery) ? extra.previousRecovery.slice(-5) : [],
          afterState: extra.afterState || null,
          stepLog: await readRecentDbg(),
          domSummary: collectApplyDomSummary(),
        };
        await writeLocal({ pja_last_apply_failure: { ...snapshot, ts: Date.now() } });
        const data = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({ type: 'REQUEST_APPLY_HELP', snapshot }, resp => {
              if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
              else resolve(resp || { success: false, error: 'no-response' });
            });
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        });
        await addDbg('[help] ' + reason + ' => ' + (data.likelyCause || data.error || 'no-response'));
        if (Array.isArray(data.recommendedActions) && data.recommendedActions.length) {
          await addDbg('[recover] proposed ' + data.recommendedActions.map(a => a.type).join(',').slice(0, 120));
        }
        await writeLocal({ pja_last_apply_help: { ts: Date.now(), reason, response: data } });
        return data;
      } catch (e) {
        await addDbg('[help] ' + reason + ' request failed: ' + e.message);
        return null;
      }
    }

    async function executeRecoveryActions(help, contextReason) {
      const actions = help && Array.isArray(help.recommendedActions) ? help.recommendedActions : [];
      if (!actions.length) return { executed: 0, retrySubmit: false };
      const allowed = new Set([
        'retry_fill_phone','retry_fill_country','retry_fill_phone_country_code',
        'retry_greenhouse_react_selects','retry_smartrecruiters_custom_fields','retry_answer_required',
        'retry_workday_prompt_buttons','retry_workday_app_questions','retry_workday_terms_checkbox',
        'retry_workday_sid_transaction','retry_workday_advance','retry_workday_auth_reset',
        'capture_only','wait_for_hydration','retry_submit_once','check_gmail_confirmation',
        'record_captcha_and_advance','record_needs_manual'
      ]);
      let executed = 0, retrySubmit = !!help.shouldRetrySubmit, advanceReason = '';
      for (const action of actions.slice(0, 4)) {
        const type = String(action && action.type || '');
        if (!allowed.has(type)) continue;
        try {
          await addDbg('[recover] exec ' + type + ' reason=' + String(contextReason || '').slice(0, 24));
          if (type === 'retry_fill_phone') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && typeof forceWorkdayPhoneNumberTrustedCommit === 'function') {
              await forceWorkdayPhoneNumberTrustedCommit(profile, 'recover');
            } else if (typeof pjaForcePhoneField === 'function') {
              await pjaForcePhoneField(profile.phone || job.profile?.phone || '');
            }
            if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) retryPhoneFill(profile);
          } else if (type === 'retry_fill_country') {
            if (typeof pjaForceCountryField === 'function') await pjaForceCountryField((job.profile && job.profile.country) || profile.country || 'United States');
          } else if (type === 'retry_fill_phone_country_code') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && typeof forceWorkdayPhoneCountryCode === 'function') await forceWorkdayPhoneCountryCode();
            if (typeof pjaForceCountryField === 'function') await pjaForceCountryField('United States');
          } else if (type === 'retry_greenhouse_react_selects') {
            if (/greenhouse\.io/i.test(location.hostname) && typeof pjaFillGreenhouseEducation === 'function') await withTimeout(pjaFillGreenhouseEducation(profile), 45000, 'recover-gh-edu');
            if (typeof pjaForceAllPolicyReactSelects === 'function') await withTimeout(pjaForceAllPolicyReactSelects(profile), 30000, 'recover-policy-rs');
          } else if (type === 'retry_smartrecruiters_custom_fields') {
            if (/smartrecruiters\.com/i.test(location.hostname) && typeof pjaFillSmartRecruitersCustomFields === 'function') await withTimeout(pjaFillSmartRecruitersCustomFields(profile), 25000, 'recover-sr-fields');
          } else if (type === 'retry_answer_required') {
            if (typeof pjaAnswerRequiredViaAI === 'function') await withTimeout(pjaAnswerRequiredViaAI(job), 120000, 'recover-ai-required');
          } else if (type === 'retry_workday_prompt_buttons') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && typeof pjaFillWorkdayPromptButtons === 'function') {
              await withTimeout(pjaFillWorkdayPromptButtons(profile), 30000, 'recover-wd-prompts');
            }
          } else if (type === 'retry_workday_app_questions') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && typeof pjaFillWorkdayAppQuestions === 'function') {
              await withTimeout(pjaFillWorkdayAppQuestions(profile), 45000, 'recover-wd-appq');
            }
          } else if (type === 'retry_workday_terms_checkbox') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && typeof pjaForceWorkdayTermsCheckbox === 'function') {
              await withTimeout(pjaForceWorkdayTermsCheckbox('recover'), 20000, 'recover-wd-terms');
            } else if (typeof pjaAutoCheckConsent === 'function') {
              pjaAutoCheckConsent();
            }
          } else if (type === 'retry_workday_sid_transaction') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) &&
                typeof isWorkdaySelfIdentifyStep === 'function' && isWorkdaySelfIdentifyStep() &&
                typeof workdaySelfIdentifyTransaction === 'function') {
              await withTimeout(workdaySelfIdentifyTransaction(profile, 'recover-loop'), 50000, 'recover-wd-sid');
            }
          } else if (type === 'retry_workday_advance') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
              const nextBtn = document.querySelector('[data-automation-id="bottomNavigationNext"], [data-automation-id="pageFooterNextButton"]') ||
                findButton(/save and continue|continue|next|review/i);
              if (nextBtn) {
                if (typeof trustedWorkdayClick === 'function') await trustedWorkdayClick(nextBtn, 'recover-advance');
                else nextBtn.click();
              }
            }
          } else if (type === 'retry_workday_auth_reset') {
            if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname) && window.pjaWorkdayAuth && typeof window.pjaWorkdayAuth.run === 'function') {
              const { pja_job_password: _storedPw } = await new Promise(r => chrome.storage.local.get('pja_job_password', r));
              await withTimeout(window.pjaWorkdayAuth.run(profile, _storedPw || 'ChangeMe#2025!'), 120000, 'recover-wd-auth');
            }
          } else if (type === 'capture_only') {
            // No-op action used when the dev server wants another screenshot/DOM round before
            // making a terminal decision.
          } else if (type === 'wait_for_hydration') {
            await sleep(4000);
          } else if (type === 'retry_submit_once') {
            retrySubmit = true;
          } else if (type === 'check_gmail_confirmation') {
            const emailRecovery = await recoverEmailVerificationCode(contextReason);
            if (emailRecovery.filled) retrySubmit = true;
          } else if (type === 'record_captcha_and_advance') {
            advanceReason = 'captcha';
          } else if (type === 'record_needs_manual') {
            advanceReason = 'needs_manual';
          }
          executed++;
          await sleep(500);
        } catch (e) {
          await addDbg('[recover] ' + type + ' failed: ' + e.message.slice(0, 80));
        }
      }
      return { executed, retrySubmit, advanceReason };
    }

    async function appendRecoveryLog(entry) {
      try {
        await new Promise(r => chrome.storage.local.get('pja_recovery_log', d => {
          const log = (Array.isArray(d.pja_recovery_log) ? d.pja_recovery_log : []).slice(-199);
          log.push({ ts: Date.now(), runId: job.runId || '', jobId: job.id || job.jobId || '',
            company: job.company || '', title: job.title || '', url: location.href.slice(0, 220), ...entry });
          chrome.storage.local.set({ pja_recovery_log: log }, r);
        }));
      } catch (_) {}
    }

    async function runApplyRecoveryLoop(reason, extra = {}, opts = {}) {
      const isWorkdayHost = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
      const maxAttempts = opts.maxAttempts || (isWorkdayHost ? 3 : 2);
      const transcript = [];
      let last = { executed: 0, retrySubmit: false, advanceReason: '' };
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const before = collectApplyDomSummary();
        const help = await maybeRequestApplyHelp(reason, {
          ...extra,
          recoveryAttempt: attempt,
          previousRecovery: transcript,
          afterState: attempt > 1 ? before : null,
        });
        const recovery = await executeRecoveryActions(help, reason);
        await sleep(opts.settleMs || 900);
        const after = collectApplyDomSummary();
        const recovered = typeof opts.verify === 'function' ? !!(await opts.verify({ attempt, help, recovery, before, after })) : false;
        const item = {
          attempt, reason,
          classification: help?.classification || '',
          likelyCause: help?.likelyCause || help?.error || '',
          actionsProposed: Array.isArray(help?.recommendedActions) ? help.recommendedActions.map(a => a.type).slice(0, 6) : [],
          actionsExecuted: recovery.executed || 0,
          retrySubmit: !!recovery.retrySubmit,
          advanceReason: recovery.advanceReason || '',
          recovered,
          beforeUrl: before?.url || location.href,
          afterUrl: after?.url || location.href,
          beforeErrors: Array.isArray(before?.errors) ? before.errors.slice(0, 6) : [],
          afterErrors: Array.isArray(after?.errors) ? after.errors.slice(0, 6) : [],
        };
        transcript.push(item);
        await appendRecoveryLog(item);
        await addDbg('[recover-loop] ' + reason + ' attempt=' + attempt +
          ' class=' + (item.classification || 'none') +
          ' exec=' + item.actionsExecuted + ' recovered=' + recovered +
          (item.advanceReason ? ' advance=' + item.advanceReason : ''));
        last = recovery;
        if (recovery.advanceReason || recovered) return { ...recovery, recovered, transcript, help };
        if (!recovery.executed && !recovery.retrySubmit && help && help.shouldRetry === false) break;
      }
      return { ...last, recovered: false, transcript };
    }

    function emailCodeSearchQuery() {
      const company = String(job.company || '').replace(/["()]/g, ' ').trim();
      const host = location.hostname || '';
      const vendor = /greenhouse\.io/i.test(host) ? 'greenhouse' : /ashbyhq\.com/i.test(host) ? 'ashby' : host.split('.').slice(-2).join('.');
      const quotedCompany = company ? `"${company.replace(/"/g, '')}"` : '';
      return [
        'in:anywhere',
        'newer_than:30m',
        '("security code" OR "verification code" OR "confirm your email" OR "confirm you are human" OR "8-character code" OR "one-time code")',
        `(${vendor} OR ${quotedCompany || vendor})`
      ].join(' ');
    }

    function findEmailCodeField() {
      const candidates = pjaQueryAllExt('input:not([type=hidden]):not([type=file]), textarea')
        .filter(el => {
          try {
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return false;
            const text = [
              el.id || '',
              el.name || '',
              el.placeholder || '',
              el.getAttribute('aria-label') || '',
              typeof pjaGetLabel === 'function' ? pjaGetLabel(el) : '',
              el.closest?.('label, div, fieldset, section')?.textContent || ''
            ].join(' ').replace(/\s+/g, ' ');
            return /security code|verification code|email code|confirm.*human|8[- ]?character code|one[- ]?time code|otp/i.test(text);
          } catch (_) {
            return false;
          }
        });
      return candidates[0] || null;
    }

    function findEmailCodeActionButton() {
      const codeField = findEmailCodeField();
      const buttonText = el => (el.textContent || el.value || el.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        try {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch (_) {
          return true;
        }
      };
      const controls = pjaQueryAllExt('button, input[type=submit], input[type=button], [role=button]');
      const preferred = controls.find(el => visible(el) &&
        /verify|confirm|continue|next|submit.*code|send code|complete verification|confirm email/i.test(buttonText(el)));
      if (preferred) return preferred;
      if (codeField) {
        const scope = codeField.closest?.('form, [role=form], section, div') || document;
        const scoped = Array.from(scope.querySelectorAll?.('button, input[type=submit], input[type=button], [role=button]') || [])
          .find(el => visible(el) && !/resend|cancel|back/i.test(buttonText(el)));
        if (scoped) return scoped;
      }
      return findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
    }

    async function waitForEmailCodeRecoveryOutcome(preSubmitUrl, branch, clickedAfterCode) {
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        const hasSubmitButton = !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
        const hasFormFields = !!pjaQueryAllExt('form input, form select, form textarea').length;
        if (pjaIsSubmitSuccess({ text: document.body?.innerText || '', title: document.title,
          url: location.href, preSubmitUrl, hasSubmitButton, hasFormFields, iterations: i })) {
          return { success: true };
        }
        // Some ATSes use a two-phase gate: code verification first, then the original submit
        // button reappears/enables. Click it once rather than recording a false verification
        // failure immediately after the code field disappears.
        if (i >= 2 && !findEmailCodeField() && hasSubmitButton) {
          const submitAfterVerify = findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
          if (submitAfterVerify && !submitAfterVerify.dataset.pjaEmailCodeSubmitRetried) {
            submitAfterVerify.dataset.pjaEmailCodeSubmitRetried = '1';
            await addDbg('[email-code] code verified; clicking final submit');
            try { await pjaCdpClickEl(submitAfterVerify); } catch (_) { try { submitAfterVerify.click(); } catch (__) {} }
          }
        }
      }
      await addDbg('[email-code] submit after code did not confirm');
      await capturePostClickDiagnostic('email_code_submit_unconfirmed', {
        branch,
        clickedAfterCode,
      });
      return { success: false };
    }

    async function recoverEmailVerificationCode(contextReason) {
      const codeField = findEmailCodeField();
      if (!codeField) {
        await addDbg('[email-code] no visible code field reason=' + String(contextReason || '').slice(0, 30));
        return { filled: false, reason: 'no_code_field' };
      }
      const recoveryKey = 'pja_email_code_recovery_' + (job.id || job.jobId || job.applyUrl || '');
      if (sessionStorage.getItem(recoveryKey) === '1') {
        await addDbg('[email-code] already attempted for job');
        return { filled: false, reason: 'already_attempted' };
      }
      sessionStorage.setItem(recoveryKey, '1');
      const searchQuery = emailCodeSearchQuery();
      await addDbg('[email-code] opening gmail search for verification code');
      const openResp = await new Promise(resolve => {
        try {
          chrome.runtime.sendMessage({
            type: 'OPEN_GMAIL_CODE_TAB',
            searchQuery,
            hostname: location.hostname,
            company: job.company || '',
            title: job.title || '',
            expectedLength: 8
          }, resp => {
            if (chrome.runtime.lastError) resolve({ ok: false, reason: chrome.runtime.lastError.message });
            else resolve(resp || { ok: false, reason: 'no_response' });
          });
        } catch (e) {
          resolve({ ok: false, reason: e.message });
        }
      });
      if (!openResp.ok) {
        await addDbg('[email-code] gmail open failed: ' + String(openResp.reason || 'unknown').slice(0, 60));
        return { filled: false, reason: openResp.reason || 'open_failed' };
      }
      let result = null;
      const started = Date.now();
      while (Date.now() - started < 90000) {
        await sleep(1000);
        const data = await new Promise(r => chrome.storage.local.get('pja_email_code_result', r));
        const r = data.pja_email_code_result;
        if (r && r.ts >= started - 1000) { result = r; break; }
      }
      await new Promise(r => chrome.storage.local.remove('pja_email_code_result', r));
      if (!result || !result.success || !result.code) {
        if (!result) {
          try {
            chrome.runtime.sendMessage({ type: 'CANCEL_EMAIL_CODE_SESSION', reason: 'timeout' }, () => {});
          } catch (_) {}
        }
        await addDbg('[email-code] code not found: ' + String(result?.reason || 'timeout').slice(0, 60));
        return { filled: false, reason: result?.reason || 'timeout' };
      }
      try {
        if (typeof pjaSetNative === 'function') pjaSetNative(codeField, result.code);
        else {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && codeField instanceof HTMLInputElement) setter.call(codeField, result.code);
          else codeField.value = result.code;
          codeField.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: result.code, inputType: 'insertText' }));
          codeField.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        await addDbg('[email-code] filled verification code len=' + String(result.codeLength || result.code.length));
        return { filled: true };
      } catch (e) {
        await addDbg('[email-code] fill failed: ' + e.message.slice(0, 60));
        return { filled: false, reason: 'fill_failed' };
      }
    }
    // Stall watchdog: if this job neither submits nor skips within the window, force-advance the
    // queue so one hung page can't block an unattended batch. On normal completion navigateBack
    // navigates away and this timer dies with the page. Raised 4min→7min: forms with many
    // AI-answered screening questions (each a dev-server round-trip ~3-5s) + combobox retries
    // legitimately need longer than 4min, and were being force-skipped mid-fill (watchdog_timeout).
    const pageWatchdogMs = /workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? 12 * 60 * 1000 : 7 * 60 * 1000;
    setTimeout(() => {
      void (async () => {
      try { sessionStorage.setItem('pja_last_action', 'watchdog_timeout:' + job.company); } catch (_) {}
      const recovery = await runApplyRecoveryLoop('watchdog_timeout', {
          formSummary: 'watchdog timer fired before submit or skip',
          stuckForMs: pageWatchdogMs,
        }, {
          maxAttempts: /workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? 2 : 1,
          settleMs: 2500,
          verify: ({ before, after, recovery: rec }) => !!(rec.advanceReason ||
            after?.url !== before?.url ||
            after?.workday?.step !== before?.workday?.step ||
            ((before?.errors || []).length && (after?.errors || []).length < (before?.errors || []).length))
        });
      if (recovery.recovered || recovery.retrySubmit) {
        await addDbg('[watchdog] recovered timeout; keeping job active');
        return;
      }
      // A hung form (filled but never submits) is the dominant degraded-CDP signal — report it so
      // the self-heal ladder can escalate. If a react-select-commit control is still erroring, flag it.
      try {
        const rsErr = (typeof pjaQueryAllExt === 'function' ? pjaQueryAllExt('[class*="select__control--error"],[class*="select__control--is-invalid"],[aria-invalid="true"]').length : 0) > 0
          || !!document.querySelector('[class*="select__control--error"]');
        chrome.runtime.sendMessage({ type: 'PJA_APPLY_OUTCOME', outcome: { filled: true, submitted: false, reactSelectError: rsErr }, applyUrl: job.applyUrl });
      } catch (_) {}
      try { recordResult(job, { success: false, reason: 'watchdog_timeout' }).then(() => navigateBack(job), () => navigateBack(job)); }
      catch (_) { try { navigateBack(job); } catch (__) {} }
      })();
    }, pageWatchdogMs);

    // Persistent cross-reload budget: the setTimeout watchdog above is reset every time the page
    // reloads, so a job that reload-loops (e.g. a required react-select that never commits, like the
    // Greenhouse country/degree remix selects) never hits it and blocks the whole batch. Track
    // {firstSeen, loads} per job in storage (survives reloads); when the wall-clock budget or reload
    // count is exceeded, defer this job to needs_manual and advance so the batch keeps moving.
    try {
      const clockKey = (job.runId || 'norun') + '::' + (job.id || job.applyUrl || job.company || 'job');
      const now = Date.now();
      const clock = await new Promise(r => chrome.storage.local.get('pja_ext_jobclock', d => r(d.pja_ext_jobclock || {})));
      // prune stale entries (>6h) so the map can't grow unbounded across runs
      for (const k of Object.keys(clock)) { if (now - (clock[k].firstSeen || now) > 21600000) delete clock[k]; }
      const entry = clock[clockKey] || { firstSeen: now, loads: 0 };
      const stepSig = /workday\.com|myworkdayjobs\.com/i.test(location.hostname)
        ? ((document.body?.innerText || '').match(/current step \d+ of \d+\s+[^\n]+/i)?.[0] || location.pathname)
        : location.pathname;
      if (entry.stepSig && stepSig && entry.stepSig !== stepSig) {
        entry.firstSeen = now;
        entry.loads = 0;
      }
      entry.stepSig = stepSig;
      entry.loads += 1;
      clock[clockKey] = entry;
      await new Promise(r => chrome.storage.local.set({ pja_ext_jobclock: clock }, r));
      const workdayBudgetOpts = (typeof window.PJAApplySelect !== 'undefined' &&
          typeof window.PJAApplySelect.externalJobBudgetOptions === 'function')
        ? window.PJAApplySelect.externalJobBudgetOptions(location.hostname)
        : /workday\.com|myworkdayjobs\.com/i.test(location.hostname)
          ? { budgetMs: 12 * 60 * 1000, maxLoads: 12 }
          : /smartrecruiters\.com/i.test(location.hostname)
            ? { budgetMs: 7 * 60 * 1000, maxLoads: 8 }
            : {};
      const overBudget = (typeof window.PJAApplySelect !== 'undefined' && window.PJAApplySelect.exceededBudget)
        ? window.PJAApplySelect.exceededBudget(entry, now, workdayBudgetOpts)
        : (now - entry.firstSeen > 240000 || entry.loads > 4);
      if (overBudget) {
        try { chrome.runtime.sendMessage({ type: 'PJA_APPLY_OUTCOME', outcome: { filled: true, submitted: false, reactSelectError: true }, applyUrl: job.applyUrl }); } catch (_) {}
        const maxLoads = workdayBudgetOpts.maxLoads != null ? workdayBudgetOpts.maxLoads : 4;
        const detail = entry.loads > maxLoads ? entry.loads + ' loads' : Math.round((now - entry.firstSeen) / 1000) + 's';
        console.log('PJA ext-apply: stuck_budget exceeded (' + detail + ') — deferring', job.company);
        const recovery = await runApplyRecoveryLoop('stuck_budget', {
          formSummary: 'cross-reload budget exceeded',
          stuckForMs: now - entry.firstSeen,
          visibleErrors: [detail],
        }, {
          maxAttempts: /workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? 2 : 1,
          settleMs: 2500,
          verify: ({ before, after, recovery: rec }) => !!(rec.advanceReason ||
            after?.url !== before?.url ||
            after?.workday?.step !== before?.workday?.step ||
            ((before?.errors || []).length && (after?.errors || []).length < (before?.errors || []).length))
        });
        if (recovery.recovered || recovery.retrySubmit) {
          entry.firstSeen = Date.now();
          entry.loads = 0;
          clock[clockKey] = entry;
          await new Promise(r => chrome.storage.local.set({ pja_ext_jobclock: clock }, r));
          await addDbg('[budget] recovered stuck_budget; continuing active job');
        } else {
        await recordResult(job, { success: false, reason: 'stuck_budget', fields: ['budget:' + detail] });
        navigateBack(job);
        return;
        }
      }
    } catch (_) {}

    await sleep(1500); // let dynamic forms settle

    // Fall back to stored profile/answers if the job object doesn't include them
    profile = (profile && Object.keys(profile).length > 0) ? profile : {};
    answers = (answers && Object.keys(answers).length > 0) ? answers : {};
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
    profile = pjaSanitizeRuntimeProfile(Object.assign({}, defaultProfile, profile));
    pjaRuntimeProfile = profile;
    pjaRuntimeAnswers = answers || {};
    if (!String(profile.phoneCountryCode || '').trim()) profile.phoneCountryCode = defaultProfile.phoneCountryCode || 'United States of America (+1)';
    if (!String(profile.referralSource || '').trim()) profile.referralSource = defaultProfile.referralSource || 'LinkedIn';
    // Promote explicit answer-bank EEO values into the in-memory profile so Workday prompt
    // buttons can use saved user answers without guessing sensitive demographics.
    if (!String(profile.hispanicOrLatino || profile.hispanic || '').trim()) {
      let fallbackHispanicAnswer = '';
      for (const [rawLabel, rec] of Object.entries(answers || {})) {
        const label = String(rawLabel || '').toLowerCase();
        const ans = String((rec && (rec.answer ?? rec)) || '').trim();
        if (/hispanic|latino/.test(label) && ans) {
          if (/^yes\b|^no\b|not hispanic|not latino/i.test(ans)) {
            profile.hispanicOrLatino = ans;
            break;
          }
          if (!fallbackHispanicAnswer) fallbackHispanicAnswer = ans;
        }
      }
      if (!String(profile.hispanicOrLatino || '').trim() && fallbackHispanicAnswer) {
        profile.hispanicOrLatino = fallbackHispanicAnswer;
      }
    }
    // Write the merged profile back onto the job so downstream helpers that read job.profile —
    // notably pjaAnswerRequiredViaAI's deterministic pre-pass (LinkedIn/website/location) — get the
    // real data. The queue seeds jobs with profile:{}, so without this the deterministic answerer
    // saw an empty profile and asked the LLM for fields like "LinkedIn Profile" (which then failed).
    job.profile = profile;
    const descClicks = job._descClicks || 0;

    console.log('PJA ext-apply:', job.company, '|', job.ats, '| profile.firstName:', profile.firstName || 'MISSING', '| descClicks:', descClicks);

    // EARLY generic post-submit detection. This must run BEFORE the description-page/no-apply
    // branch below: Lever and similar ATSes can navigate from /apply to a sparse post-submit
    // landing page with no form. If we already clicked Submit for THIS job in THIS tab/run, a
    // verified confirmation page should be recorded instead of being misclassified as
    // no_apply_btn_on_description.
    {
      const earlyHasSubmitButton = pjaQueryAllExt('button[type=submit], input[type=submit]')
        .some(b => /submit/i.test((b.textContent || '') + (b.value || '')));
      const earlyHasFormFields = pjaQueryAllExt('form input, form select, form textarea')
        .some(el => { try { const r = el.getBoundingClientRect(); return el.type !== 'hidden' && r.width > 0 && r.height > 0; } catch (_) { return el.type !== 'hidden'; } });
      const earlyPriorSubmit = pjaPrevAction === 'submit_clicked:' + String(job.company || '') || !!job._submitPending;
      if (pjaIsSubmitSuccess({
        text: document.body?.innerText || '', title: document.title, url: location.href,
        preSubmitUrl: job._preSubmitUrl || '', hasSubmitButton: earlyHasSubmitButton,
        hasFormFields: earlyHasFormFields, priorSubmit: earlyPriorSubmit,
      })) {
        delete job._submitPending;
        delete job._preSubmitUrl;
        delete job._submitStartedAt;
        try { await new Promise(r => chrome.storage.local.set({ pja_ext_current: job }, r)); } catch (_) {}
        await addDbg('[ext] early generic confirmation → applied: ' + job.company);
        sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
        await recordResult(job, { success: true, reason: 'applied' });
        navigateBack(job);
        return;
      }
    }

    // --- Check if this is a job description page (no form inputs yet) ---
    const formInputSel = 'form input:not([type=hidden]):not([type=file]), form select, form textarea,' +
      'input[required]:not([type=hidden]):not([type=file]), input[aria-required="true"]:not([type=hidden]):not([type=file]), select[required], textarea[required],' +
      'spl-input[required], spl-autocomplete[required], spl-phone-field[required], oc-input.ng-invalid, oc-location-autocomplete.ng-invalid';
    const hasFormishInputs = (sel = formInputSel) => {
      try {
        if (document.querySelector(sel)) return true;
        return pjaQueryAllExt(sel).some(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      } catch (_) { return false; }
    };
    let hasFormInputs = hasFormishInputs();
    // Some ATS apply forms are SPAs that render fields progressively AFTER a bare initial page
    // (e.g. SmartRecruiters "one-click" /oneclick-ui, which first shows only a resume file input).
    // If the URL is already an application form, POLL a few seconds so we fill it instead of
    // wrongly treating it as a description page and hunting for a non-existent Apply button.
    const looksLikeFormUrl = /oneclick-ui|\/apply(\b|\/|\?)|application|job_app|\/embed\//i.test(location.href);
    // SmartRecruiters one-click is RESUME-FIRST: only a file input renders until the resume is
    // uploaded+parsed, which then reveals name/email/question fields. Upload the resume FIRST so
    // the form appears, instead of timing out and misreading it as a description page.
    const isResumeFirst = /oneclick-ui/i.test(location.href)
      && !hasFormInputs && !!document.querySelector('input[type=file]');
    if (isResumeFirst) {
      try { await tryInjectResume(profile, answers); } catch (_) {}
      // After the resume parses, SmartRecruiters reveals fields OUTSIDE a <form> and unmarked,
      // so the strict formInputSel misses them — also accept standalone text/email inputs.
      const anyFieldSel = formInputSel + ', input[type=text], input[type=email], input:not([type]):not([type=file]), spl-input, spl-autocomplete, spl-phone-field';
      for (let _i = 0; _i < 25 && !hasFormInputs; _i++) { await sleep(600); hasFormInputs = hasFormishInputs(anyFieldSel); }
      // DIAGNOSTIC: if the form still didn't appear, dump where it might be (iframe? same-origin?
      // buttons to advance?) so we can see the real post-upload structure without claude-in-chrome.
      if (!hasFormInputs) {
        try {
          const frames = Array.from(document.querySelectorAll('iframe')).map(f => {
            let host = '?'; try { host = new URL(f.src, location.href).host; } catch (_) {}
            let inner = 'x-origin'; try { inner = f.contentDocument ? f.contentDocument.querySelectorAll('input,select,textarea').length + 'fld' : 'null-doc'; } catch (_) { inner = 'blocked'; }
            return host + ':' + inner;
          });
          const btns = Array.from(document.querySelectorAll('button,a[role=button],[class*=btn]')).filter(b => b.offsetParent).map(b => (b.textContent || '').trim().slice(0, 18)).filter(Boolean).slice(0, 8);
          const allInputs = pjaQueryAllExt('input:not([type=hidden]), spl-input, spl-autocomplete, spl-phone-field').length;
          const line = '[sr-diag] frames=[' + frames.join(' ') + '] inputs=' + allInputs + ' btns=[' + btns.join('|') + ']';
          await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a = (d.pja_dbg || []).slice(-40); a.push(line); chrome.storage.local.set({ pja_dbg: a }, r); }));
        } catch (_) {}
      }
    }
    if (!hasFormInputs && looksLikeFormUrl) {
      for (let _i = 0; _i < 12 && !hasFormInputs; _i++) { await sleep(500); hasFormInputs = hasFormishInputs(); }
    }
    // Workday SPA uses React without <form>/required attributes and handles auth state
    // internally — bypass the description-page check entirely for Workday sites.
    const isWorkdaySite = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
    console.log('PJA ext-apply hasFormInputs:', hasFormInputs, 'isWorkday:', isWorkdaySite, 'url:', location.href.slice(0,60));

    // Workday job-description pages often render a plain <a role="button">Apply</a> with zero
    // form inputs. The generic description-page launcher is intentionally skipped for Workday so
    // auth/account creation can run through pjaWorkdayAuth, but signed-out and tenant-specific
    // posting pages still need a deterministic entry route. Navigate directly to Workday's stable
    // manual-apply URL instead of letting the run fall through to no_submit_btn.
    if (!hasFormInputs && isWorkdaySite && !/\/apply(?:\/|$)/i.test(location.pathname)) {
      const pageControls = Array.from(document.querySelectorAll('a,button,[role=button]'))
        .filter(el => el.offsetParent !== null)
        .map(el => (el.textContent || el.getAttribute('aria-label') || '').trim())
        .filter(Boolean);
      const hasApplyEntry = pageControls.some(txt => /^apply$/i.test(txt) || /apply now|start application|continue application|sign in/i.test(txt));
      if (hasApplyEntry) {
        const continueBtn = Array.from(document.querySelectorAll('a,button,[role=button]'))
          .filter(el => el.offsetParent !== null)
          .find(el => /continue application/i.test(el.textContent || el.getAttribute('aria-label') || ''));
        const sourceUrl = String(job.applyUrl || location.href || '').trim();
        const cleanUrl = sourceUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
        const entryUrl = /\/apply\/applyManually(?:\/|$)/i.test(cleanUrl)
          ? cleanUrl.replace(/\/apply\/applyManually$/i, '/apply')
          : /\/apply(?:\/|$)/i.test(cleanUrl)
            ? sourceUrl
            : cleanUrl + '/apply';
        const navKey = 'pja_wd_desc_manual_nav_' + (job.id || job.jobId || '') + '_' +
          String(job.applyUrl || location.pathname || '').replace(/[^\w-]+/g, '_').slice(-80);
        let navs = 0;
        try { navs = parseInt(sessionStorage.getItem(navKey) || '0', 10); } catch (_) {}
        if (continueBtn && navs < 6) {
          try { sessionStorage.setItem(navKey, String(navs + 1)); } catch (_) {}
          await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
            const a = (d.pja_dbg || []).slice(-40);
            a.push('[WD] description entry → clicking Continue Application attempt=' + (navs + 1) +
              ' controls=[' + pageControls.slice(0, 8).join('|') + ']');
            chrome.storage.local.set({ pja_dbg: a }, r);
          }));
          const continueHref = continueBtn.href || continueBtn.getAttribute('href') || '';
          if (continueHref) {
            const continueUrl = new URL(continueHref, location.href).href;
            const currentUrl = new URL(location.href, location.href).href;
            await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
              const a = (d.pja_dbg || []).slice(-40);
              a.push('[WD] description Continue href=' + continueUrl.slice(0, 220));
              chrome.storage.local.set({ pja_dbg: a }, r);
            }));
            if (continueUrl.replace(/[?#].*$/, '') !== currentUrl.replace(/[?#].*$/, '')) {
              location.href = continueUrl;
              await sleep(1200);
              if (location.href.replace(/[?#].*$/, '') !== continueUrl.replace(/[?#].*$/, '')) {
                try { location.assign(continueUrl); } catch (_) {}
                await sleep(1200);
              }
              if (location.href.replace(/[?#].*$/, '') !== continueUrl.replace(/[?#].*$/, '')) {
                try { location.replace(continueUrl); } catch (_) {}
                await sleep(1200);
              }
              if (location.href.replace(/[?#].*$/, '') === continueUrl.replace(/[?#].*$/, '')) {
                return runExternalApply(job, rawAnswers);
              }
            }
            await sleep(1000);
            return runExternalApply(job, rawAnswers);
          }
          if (!await trustedWorkdayClick(continueBtn, 'continue-application')) {
            try { continueBtn.click(); } catch (_) {}
          }
          await sleep(3000);
          return runExternalApply(job, rawAnswers);
        }
        if (entryUrl && entryUrl !== location.href && navs < 6) {
          try { sessionStorage.setItem(navKey, String(navs + 1)); } catch (_) {}
          const retryUrl = entryUrl + (entryUrl.includes('?') ? '&' : '?') + 'pja_wd_entry_retry=' + (navs + 1);
          await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
            const a = (d.pja_dbg || []).slice(-40);
            a.push('[WD] description entry → apply route nav attempt=' + (navs + 1) + ' controls=[' + pageControls.slice(0, 8).join('|') + ']');
            chrome.storage.local.set({ pja_dbg: a }, r);
          }));
          location.replace(retryUrl);
          return;
        }
      }
    }

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
      const preflight = pjaClassifyExternalPreflight({ hasApplyForm: hasFormInputs,
        hasChatbot: chatApplyControl || (chatbotWidget && /chat to apply|text to apply/.test(pageTxt)) });
      if (preflight && preflight.action === 'skip' && preflight.reason === 'chatbot_apply_manual') {
        console.log('PJA ext-apply: chatbot apply detected — skipping for manual follow-up');
        await recordResult(job, { success: false, reason: preflight.reason });
        navigateBack(job);
        return;
      }
    }

    if (!hasFormInputs && descClicks < 3 && !isWorkdaySite) {
      // On a job description page — find and click the Apply button to get to the actual form.
      // POLL for it: many ATS pages redirect (e.g. icims.com → careers.<co>.com) and/or render
      // the Apply button via JS a few seconds after load. A one-shot check evaluates the
      // intermediate/unrendered page and wrongly reports "no apply button". Retry for ~12s.
      const APPLY_RE = /^apply$|apply now|apply for this|apply for job|apply for position|apply today|apply here|apply online|apply to this|apply with indeed|apply with seek|start application|i'?m interested|apply to job/i;
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
        } else if (isSmartRecruitersHost) {
          // SmartRecruiters' Stencil landing button may ignore a synthetic DOM click or reload the
          // public posting instead of entering /oneclick-ui. Use the existing trusted point-click
          // bridge for this non-submit navigation, then keep the safe synthetic fallback.
          const clicked = await trustedPointClick(applyBtn);
          await addDbg('[SR] trusted Apply landing click=' + clicked);
          if (!clicked) applyBtn.click();
        } else {
          applyBtn.click();
        }
        // Wait up to 12s for form to appear (SPA or full page nav)
        // Do NOT return early on URL change: Greenhouse/Lever use SPA pushState,
        // meaning URL changes but the same document continues — we need to keep waiting.
        const FORM_SEL = 'form input:not([type=hidden]):not([type=file]), form select, form textarea, input[required]:not([type=hidden]):not([type=file]), input[aria-required="true"]:not([type=hidden]):not([type=file]), select[required], textarea[required], spl-input[required], spl-autocomplete[required], spl-phone-field[required], oc-input.ng-invalid, oc-location-autocomplete.ng-invalid';
        for (let i = 0; i < 24; i++) {
          await sleep(500);
          // Full page navigation (e.g. Workday) invalidates the extension context.
          // When that happens, chrome.runtime.id becomes undefined — bail silently
          // so the new page's content script handles the job from scratch.
          try { if (!chrome.runtime?.id) return; } catch(_) { return; }
          dbgLog([`loop i=${i} url=${location.href.slice(0,80)} formSel=${hasFormishInputs(FORM_SEL)}`]);
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
          if (hasFormishInputs(FORM_SEL)) {
            // SPA rendered the form — fill it directly
            await sleep(800);
            if (typeof pjaFillForm === 'function') {
              window._pjaComboChain = Promise.resolve();
              pjaFillForm(profile, answers);
              if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
                await Promise.race([window._pjaComboChain.catch(() => {}), sleep(30000)]);
              }
              if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) retryPhoneFill(profile);
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
            const preSubmitUrl2 = location.href;
            job._submitPending = true;
            job._preSubmitUrl = preSubmitUrl2;
            job._submitStartedAt = Date.now();
            try { await new Promise(r => chrome.storage.local.set({ pja_ext_current: job }, r)); } catch (_) {}
            submitBtn2.click();
            let success2 = false;
            for (let wait = 0; wait < 20; wait++) {
              await sleep(400);
              const hasSubmitButton = pjaQueryAllExt('button[type=submit], input[type=submit]')
                .some(b => /submit/i.test((b.textContent || '') + (b.value || '')));
              const hasFormFields = pjaQueryAllExt('form input, form select, form textarea')
                .some(el => el.type !== 'hidden');
              if (pjaIsSubmitSuccess({ text: document.body?.innerText || '', title: document.title,
                url: location.href, preSubmitUrl: preSubmitUrl2, hasSubmitButton, hasFormFields,
                iterations: wait })) { success2 = true; break; }
            }
            if (!success2) {
              const help = await maybeRequestApplyHelp('submit_unclear', {
                formSummary: 'SPA form still present after submit click',
                visibleErrors: collectApplyDomSummary().errors || [],
              });
              const recovery = await executeRecoveryActions(help, 'submit_unclear');
              if (recovery.advanceReason) {
                await recordResult(job, { success: false, reason: recovery.advanceReason });
                navigateBack(job);
                return;
              }
              if (recovery.retrySubmit) {
                if (typeof pjaFillForm === 'function') {
                  window._pjaComboChain = Promise.resolve();
                  pjaFillForm(profile, answers);
                  if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
                    await Promise.race([window._pjaComboChain.catch(() => {}), sleep(30000)]);
                  }
                }
                if (typeof pjaForceAllPolicyReactSelects === 'function') await withTimeout(pjaForceAllPolicyReactSelects(profile), 20000, 'spa-recover-gh-policy');
                await sleep(600);
                const retryBtn = findButton(/submit.*application|submit.*app|apply now|send application|complete application/i);
                if (retryBtn) {
                  retryBtn.click();
                  for (let wait = 0; wait < 25; wait++) {
                    await sleep(400);
                    const hasSubmitButton = pjaQueryAllExt('button[type=submit], input[type=submit]')
                      .some(b => /submit/i.test((b.textContent || '') + (b.value || '')));
                    const hasFormFields = pjaQueryAllExt('form input, form select, form textarea')
                      .some(el => el.type !== 'hidden');
                    if (pjaIsSubmitSuccess({ text: document.body?.innerText || '', title: document.title,
                      url: location.href, preSubmitUrl: preSubmitUrl2, hasSubmitButton, hasFormFields,
                      iterations: wait })) { success2 = true; break; }
                  }
                }
              }
            }
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
        await maybeRequestApplyHelp('apply_btn_no_form', { formSummary: 'apply button found but no form' });
        await recordResult(job, { success: false, reason: 'apply_btn_no_form' });
        navigateBack(job);
        return;
      }
      // Dead/closed posting: a stale queued applyUrl often 404s or shows a "no longer accepting"
      // shell (e.g. Ashby renders a "Page not found" page whose only controls are footer links).
      // Detect this BEFORE the generic no_apply_btn path so we record a distinct, honest reason
      // and don't waste retry cycles hunting for an Apply button that will never exist.
      const _bodyTxt = (document.body.innerText || '').slice(0, 400);
      const closedPreflight = pjaClassifyExternalPreflight({ isDeadPosting: pjaIsClosedPosting(_bodyTxt) });
      if (closedPreflight && closedPreflight.action === 'skip' && closedPreflight.reason === 'posting_not_found') {
        await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push(new Date().toISOString().slice(11,19)+' [EXT] posting_not_found host='+location.hostname+' url='+location.pathname.slice(-40)); chrome.storage.local.set({pja_dbg:a}, r); }));
        console.log('PJA ext-apply: posting_not_found (404/closed) — skipping.');
        sessionStorage.setItem('pja_last_action', 'recordResult:posting_not_found:' + job.company);
        await maybeRequestApplyHelp('posting_not_found', { formSummary: 'posting unavailable or closed' });
        await recordResult(job, { success: false, reason: closedPreflight.reason });
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
      await maybeRequestApplyHelp('no_apply_btn_on_description', { visibleErrors: cand, formSummary: 'description page without apply button' });
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

      // Gmail verification is completed asynchronously by background.js while pjaWorkdayAuth.run()
      // is still waiting. Background needs the CURRENT job context at that time to navigate the
      // apply tab back after the verification link succeeds. Do this before auth starts so stale
      // pending records from prior Workday tenants cannot hijack the resume.
      await new Promise(r => chrome.storage.local.set({
        pja_wd_pending_apply: {
          applyUrl: job.applyUrl,
          jobId: job.id || job.jobId,
          hostname: location.hostname,
          ts: Date.now()
        }
      }, r));

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
        // Some tenants (e.g. AMAT/Dexcom) redirect to the job description after sign-in and
        // drop the apply context. Re-opening the description URL just loops because the Workday
        // auth branch intentionally does not run the generic description-page Apply clicker.
        // Resume at Workday's stable manual-apply route instead. Cap re-navs to avoid loops.
        // BUT never re-nav on a post-submit/confirmation page (that means we already applied).
        const onCompletedPage = /\/completed\/|\/confirmation|thankyou/i.test(location.pathname) ||
          /view my applications|application.*submitted|thank you for (applying|your)/i.test(document.body?.innerText || '');
        if (!wdFormFound && !onCompletedPage && job.applyUrl && !/\/apply(\/|$)/.test(location.pathname)) {
          let renav = 0;
          try { renav = parseInt(sessionStorage.getItem('pja_wd_renav_' + (job.id||'')) || '0', 10); } catch(_) {}
          if (renav < 2) {
            try { sessionStorage.setItem('pja_wd_renav_' + (job.id||''), String(renav + 1)); } catch(_) {}
            await new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-19); a.push('[ext] post-signin re-nav to applyUrl attempt ' + (renav+1)); chrome.storage.local.set({pja_dbg:a}, r); }));
            const sourceUrl = String(job.applyUrl || '').trim();
            const cleanUrl = sourceUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
            const resumeUrl = /\/apply\/applyManually$/i.test(cleanUrl)
              ? cleanUrl.replace(/\/apply\/applyManually$/i, '/apply')
              : /\/apply(?:\/|$)/i.test(cleanUrl)
                ? sourceUrl
                : cleanUrl + '/apply';
            location.href = resumeUrl;
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
      } else if (authResult === 'needs_navigation') {
        await addDbg('[WD] auth requested navigation; waiting for reloaded apply page');
        return;
      } else if (authResult === 'sso_only') {
        await maybeRequestApplyHelp('google_sso_only', { formSummary: 'workday sign-in requires Google SSO' });
        await recordResult(job, { success: false, reason: 'google_sso_only' });
        navigateBack(job); return;
      } else if (authResult === 'locked') {
        await maybeRequestApplyHelp('workday_auth_sign_in_error', { formSummary: 'workday sign-in locked', visibleErrors: [authResult] });
        await recordResult(job, { success: false, reason: 'workday_account_locked' });
        navigateBack(job); return;
      } else if (authResult === 'captcha_blocked') {
        await maybeRequestApplyHelp('workday_captcha', { formSummary: 'workday auth captcha', visibleErrors: [authResult] });
        await recordResult(job, { success: false, reason: 'workday_captcha' });
        navigateBack(job); return;
      } else if (authResult === 'create_rejected_no_visible_error' || authResult === 'account_exists_wrong_password') {
        const mappedReason = authResult === 'account_exists_wrong_password'
          ? 'workday_account_exists_wrong_password'
          : 'workday_create_rejected_no_visible_error';
        await maybeRequestApplyHelp(mappedReason, { formSummary: 'workday account creation/sign-in classification', visibleErrors: [authResult] });
        await recordResult(job, { success: false, reason: mappedReason });
        navigateBack(job); return;
      } else {
        await maybeRequestApplyHelp(`workday_auth_${authResult}`, { formSummary: 'workday auth failure', visibleErrors: [authResult] });
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

    // Greenhouse can synchronously reload the original application after a delivered Submit click
    // without showing validation errors or a confirmation. Retrying the identical form on every
    // load only burns the cross-reload budget. The session marker is tab-local and names the job,
    // so record one ambiguous attempt and advance; never promote it to applied without confirmation.
    if (/greenhouse\.io/i.test(location.hostname) &&
        pjaPrevAction === 'submit_clicked:' + String(job.company || '')) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const a = (d.pja_dbg || []).slice(-39);
        a.push('[submit] original form reloaded after click → submit_unclear');
        chrome.storage.local.set({ pja_dbg: a }, r);
      }));
      sessionStorage.setItem('pja_last_action', 'recordResult:submit_unclear:' + job.company);
      await recordResult(job, { success: false, reason: 'submit_unclear' });
      navigateBack(job);
      return;
    }

    // Phase logger + per-step timeout so NO single fill sub-step can hang the whole apply. The
    // Antora watchdog_timeout was an unbounded await in a fill sub-step (e.g. pjaFillUnknownTextFields'
    // AI round-trip never calling back). On timeout we log and proceed — findMissingRequired then
    // catches anything still empty → missing_required (fast), instead of burning the 7-min watchdog.
    function phaseLog(m) { try { chrome.storage.local.get('pja_dbg', d => { const a = (d.pja_dbg || []).slice(-39); a.push('[phase] ' + m); chrome.storage.local.set({ pja_dbg: a }); }); } catch (_) {} }
    function withTimeout(p, ms, label) {
      let to;
      const timeout = new Promise(res => { to = setTimeout(() => { phaseLog(label + ' TIMEOUT ' + ms + 'ms'); res(); }, ms); });
      const wrapped = Promise.resolve(p)
        .then(value => { phaseLog(label + ' done'); return value; })
        .catch(e => { phaseLog(label + ' err ' + ((e && e.message) || e)); return undefined; })
        .finally(() => clearTimeout(to));
      return Promise.race([wrapped, timeout]);
    }

    async function repairAshbyRequiredFields(phase) {
      if (!/ashbyhq\.com/i.test(location.hostname)) return 0;
      const visible = el => {
        try {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !el.disabled;
        } catch (_) {
          return false;
        }
      };
      const optionText = radio => {
        let txt = radio.getAttribute('aria-label') || '';
        try { if (!txt && radio.id) txt = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent || ''; } catch (_) {}
        txt = txt || radio.closest('label')?.textContent || radio.parentElement?.textContent || radio.value || '';
        return String(txt || '').replace(/\s+/g, ' ').trim();
      };
      const groupText = radios => {
        const first = radios[0];
        const field = first.closest('fieldset,[role="group"],[class*="field"],[class*="question"],[data-testid*="question"],div');
        const legend = field?.querySelector('legend,[class*="label"],label')?.textContent || '';
        return String(legend || field?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      };
      const answerFor = question => {
        const field = { label: question, type: 'radio', options: [] };
        const context = { profile, answers: answers || {}, prefs: job && job.prefs || {} };
        if (typeof pjaResolveRequiredAnswer === 'function') {
          try {
            const resolved = pjaResolveRequiredAnswer(field, context);
            const answer = String(resolved && resolved.answer || '').trim();
            if (answer) return answer;
          } catch (_) {}
        }
        for (const [rawLabel, rec] of Object.entries(answers || {})) {
          const q = String(question || '').toLowerCase();
          const label = String(rawLabel || '').toLowerCase();
          const answer = String((rec && (rec.answer ?? rec)) || '').trim();
          if (answer && (q.includes(label.slice(0, 40)) || label.includes(q.slice(0, 40)))) return answer;
        }
        return '';
      };
      const groups = new Map();
      for (const radio of pjaQueryAllExt('input[type="radio"]')) {
        if (!visible(radio)) continue;
        const key = radio.name || radio.closest('fieldset,[role="group"],[class*="field"],[class*="question"]')?.textContent?.slice(0, 120) || radio.id || Math.random();
        const arr = groups.get(key) || [];
        arr.push(radio);
        groups.set(key, arr);
      }
      let repaired = 0;
      for (const radios of groups.values()) {
        if (!radios.length || radios.some(r => r.checked)) continue;
        const question = groupText(radios);
        const answer = answerFor(question);
        if (!answer) continue;
        let committed = false;
        try {
          if (typeof pjaSelectRadio === 'function') committed = !!pjaSelectRadio(radios, answer, '');
        } catch (_) {}
        if (!radios.some(r => r.checked)) {
          const lv = answer.toLowerCase();
          const target = radios.find(r => optionText(r).toLowerCase() === lv || String(r.value || '').toLowerCase() === lv)
            || radios.find(r => optionText(r).toLowerCase().startsWith(lv))
            || (/^yes/i.test(answer) ? radios[0] : radios[radios.length - 1]);
          if (target) {
            if (typeof pjaClickRadio === 'function') pjaClickRadio(target);
            else { target.checked = true; target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); target.click(); }
          }
        }
        await sleep(120);
        committed = radios.some(r => r.checked);
        if (committed) repaired++;
        await addDbg('[ashby-repair] phase=' + phase + ' question=' + question.slice(0, 70) + ' answer=' + answer + ' committed=' + committed);
      }
      return repaired;
    }

    // Some Greenhouse forms require a cover letter but initially expose only an "Enter manually"
    // button, so the regular required-field/AI sweep cannot see a textarea. Reveal it and fill a
    // truthful resume-grounded letter. Honor explicit keyword instructions on the form without
    // inventing experience or credentials.
    const prepareRequiredCoverLetter = async () => {
      const groups = Array.from(document.querySelectorAll('fieldset,[role="group"],.field,[class*="field"],[class*="question"]'));
      const group = groups.find(g => /cover letter\s*\*/i.test((g.textContent || '').slice(0, 300)));
      if (!group) return false;
      let textarea = group.querySelector('textarea');
      if (!textarea) {
        const manual = Array.from(group.querySelectorAll('button,a,[role="button"]'))
          .find(b => /^enter manually$/i.test((b.textContent || '').trim()));
        if (manual) { manual.click(); await sleep(500); textarea = group.querySelector('textarea'); }
      }
      if (!textarea || (textarea.value || '').trim()) return !!textarea;
      const keyword = (document.body?.innerText || '').match(/include the word\s+["“']?([a-z][a-z-]*)["”']?/i)?.[1] || '';
      const role = job.title || 'this role';
      const company = job.company || 'your organization';
      const runtimeSummary = String(profile.coverLetterSummary || profile.professionalSummary || profile.summary || '').trim().slice(0, 2000);
      const fitSentence = runtimeSummary ? ` ${runtimeSummary}` : ' My experience aligns with the role requirements, and I would bring a careful, data-driven approach while being candid about areas I am still learning.';
      const signature = profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Candidate';
      const letter = `Dear Hiring Team,\n\nI am applying for the ${role} position at ${company}.${fitSentence}${keyword ? `\n\n${keyword}` : ''}\n\nThank you for your consideration.\n${signature}`;
      if (typeof pjaSetNative === 'function') pjaSetNative(textarea, letter);
      else { textarea.value = letter; textarea.dispatchEvent(new Event('input', { bubbles: true })); textarea.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    };
    await withTimeout(prepareRequiredCoverLetter(), 10000, 'cover-letter');

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
      if (window._pjaComboChain) await withTimeout(window._pjaComboChain, 30000, 'comboChain1');
      await sleep(300);
      // Phone retry: fill any still-empty phone fields (uses label-classification, not just type/id)
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) retryPhoneFill(profile);
      await sleep(200);
      // SECOND PASS — Greenhouse (and others) render sections like Education AFTER the
      // initial fill, so their comboboxes (School/Degree/Discipline) were absent the first
      // time. Re-run the fill to catch late-rendered fields, then await the combo chain.
      await sleep(800);
      window._pjaComboChain = Promise.resolve();
      pjaFillForm(profile, answers);
      if (window._pjaComboChain) await withTimeout(window._pjaComboChain, 30000, 'comboChain2');
      await sleep(300);
      // Greenhouse Education react-selects render late + ignore programmatic sets —
      // dedicated late pass (degree/discipline reliable; school best-effort).
      try { chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-40); a.push('[gh-edu] call reached, typeof='+(typeof pjaFillGreenhouseEducation)+' host='+location.hostname); chrome.storage.local.set({pja_dbg:a}); }); } catch(_){}
      if (typeof pjaFillGreenhouseEducation === 'function') {
        await withTimeout(pjaFillGreenhouseEducation(profile), 45000, 'gh-edu');
      }
    }

    // --- AI-fill open-ended required questions not in profile/answer bank ---
    if (typeof pjaFillUnknownTextFields === 'function') {
      const jobCtx = { title: job.title || '', company: job.company || '' };
      // Bounded: the AI answerer makes dev-server round-trips; if one hangs, don't stall the apply.
      await withTimeout(new Promise(resolve => pjaFillUnknownTextFields(profile, answers, jobCtx, () => resolve())), 120000, 'ai-answerer');
      await sleep(300);
    }

    // --- Best-effort resume upload ---
    await withTimeout(tryInjectResume(profile, answers), 90000, 'resume');

    // --- Workday Application Questions (formField-* dropdowns) ---
    await withTimeout(pjaFillWorkdayAppQuestions(profile), 45000, 'wd-appq');
    if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      await withTimeout(pjaForceWorkdayTermsCheckbox('initial'), 20000, 'wd-terms-initial');
    }

    // --- Workday Work Experience subsection (My Experience step) ---
    await withTimeout(pjaFillWorkdayWorkExperience(profile), 45000, 'wd-workexp');
    await withTimeout(pjaFillWorkdaySelfIdentifyDate(profile), 20000, 'wd-selfid-date');

    // --- Fallback fills ---
    const forceWorkdayPhoneCountryCode = async () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
      if (typeof pjaFillCombobox !== 'function') return 0;
      const wdSelectedText = root => (root?.querySelector('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]')?.textContent || '').trim();
      const targets = pjaQueryAllExt(
        'input[data-uxi-widget-type="selectinput"], input[role="combobox"], input[required], input[aria-required="true"]'
      ).filter(el => {
        const label = [
          (typeof getLabelFor === 'function' ? getLabelFor(el) : ''),
          el.getAttribute('aria-label') || '',
          el.getAttribute('aria-labelledby') || '',
          el.id || '',
          el.closest('[data-automation-id^="formField"], fieldset, [data-uxi-widget-type="multiselect"], div')?.textContent || '',
        ].join(' ').replace(/\s+/g, ' ');
        if (!/(country|territory).{0,60}phone.{0,30}code|phone.{0,30}(country|territory).{0,30}code|country\s*\/\s*territory\s*phone\s*code|dial(?:ing|ling) code/i.test(label)) return false;
        const ms = el.closest('[data-uxi-widget-type="multiselect"]');
        const selected = wdSelectedText(ms);
        return !/united states/i.test(selected) || !/\+?1\b/.test(selected);
      });
      for (const el of targets) pjaFillCombobox(el, profile.phoneCountryCode || 'United States of America (+1)', 'phoneCountryCode');
      if (targets.length && window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
        await Promise.race([window._pjaComboChain.catch(() => {}), sleep(10000)]);
      }
      if (typeof pjaFillWorkdayPromptButtons === 'function') {
        try { await withTimeout(pjaFillWorkdayPromptButtons(profile), 12000, 'wd-phone-code-prompts'); } catch (_) {}
      }
      if (targets.length) await addDbg('[WD] forced phoneCountryCode n=' + targets.length);
      return targets.length;
    };
    const trustedWorkdayClick = async (el, label) => {
      if (!el || !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
      const priorId = el.id;
      const tempId = priorId || ('__pja_wd_click_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      if (!priorId) el.id = tempId;
      try {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const resp = await new Promise(resolve => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; resolve({ ok: false, error: 'trusted_click_timeout' }); }
          }, 7000);
          chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_CLICK', selector: '#' + CSS.escape(tempId), single: true }, r => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || {}));
          });
        });
        await addDbg('[WD] trusted click ' + (label || '') + ' ok=' + !!resp.ok + (resp.error ? ' err=' + String(resp.error).slice(0, 60) : ''));
        if (resp.ok) return true;
        if (/submit|advance|continue|next|retry|recover/i.test(String(label || ''))) {
          const fallback = await new Promise(resolve => {
            try {
              chrome.runtime.sendMessage({
                type: 'WORKDAY_ADVANCE_STEP',
                selector: '#' + CSS.escape(tempId),
                label: label || ''
              }, r => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {})));
            } catch (e) {
              resolve({ ok: false, error: e.message });
            }
          });
          await addDbg('[WD] trusted click fallback ' + (label || '') + ' ok=' + !!fallback.ok +
            (fallback.reason || fallback.error ? ' reason=' + String(fallback.reason || fallback.error).slice(0, 60) : ''));
          return !!fallback.ok;
        }
        return false;
      } catch (e) {
        await addDbg('[WD] trusted click ' + (label || '') + ' threw=' + String(e && e.message || e).slice(0, 60));
        return false;
      } finally {
        if (!priorId && el.id === tempId) el.removeAttribute('id');
      }
    };
    const trustedWorkdayEnter = async (el, label) => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
      try {
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          try { el.focus(); } catch (_) {}
        }
        const resp = await new Promise(resolve => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; resolve({ ok: false, error: 'trusted_enter_timeout' }); }
          }, 7000);
          chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_ENTER' }, r => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || {}));
          });
        });
        await addDbg('[WD] trusted Enter ' + (label || '') + ' ok=' + !!resp.ok + (resp.error ? ' err=' + String(resp.error).slice(0, 60) : ''));
        return !!resp.ok;
      } catch (e) {
        await addDbg('[WD] trusted Enter ' + (label || '') + ' threw=' + String(e && e.message || e).slice(0, 60));
        return false;
      }
    };
    const mainWorldWorkdayAdvance = async (el, label) => {
      if (!el || !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
      const priorId = el.id;
      const tempId = priorId || ('__pja_wd_advance_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      if (!priorId) el.id = tempId;
      try {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const resp = await new Promise(resolve => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; resolve({ ok: false, error: 'main_advance_timeout' }); }
          }, 9000);
          chrome.runtime.sendMessage({
            type: 'WORKDAY_ADVANCE_STEP',
            selector: '#' + CSS.escape(tempId),
            label: label || ''
          }, r => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || {}));
          });
        });
        await addDbg('[WD] main advance ' + (label || '') + ' ok=' + !!resp.ok +
          (resp.via ? ' via=' + resp.via : '') + (resp.error ? ' err=' + String(resp.error).slice(0, 60) : ''));
        return !!resp.ok;
      } catch (e) {
        await addDbg('[WD] main advance ' + (label || '') + ' threw=' + String(e && e.message || e).slice(0, 60));
        return false;
      } finally {
        if (!priorId && el.id === tempId) el.removeAttribute('id');
      }
    };
    const forceWorkdayReferralSource = async () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
      let filled = 0;
      const referralCommitted = text => {
        let cleaned = String(text || '')
          .replace(/\bExpanded\b/ig, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const selectedItem = cleaned.match(/\b\d+\s+items?\s+selected,?\s+(.+)$/i);
        if (selectedItem) cleaned = selectedItem[1].trim();
        if (!cleaned) return false;
        if (/^\d+\s+items?\s+selected$/i.test(cleaned)) return false;
        if (/^(select one|select\.{0,3}|choose|search|type to search|required only)$/i.test(cleaned)) return false;
        if (/select one|select\.\.\.|choose an option|required only/i.test(cleaned)) return false;
        if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application/i.test(cleaned)) return false;
        return true;
      };
      const selectedReferralText = el => {
        const chipText = (typeof pjaWorkdaySelectedChipText === 'function' ? pjaWorkdaySelectedChipText(el) : '') ||
          (el.closest('[data-uxi-widget-type="multiselect"], [data-automation-id^="formField-"]')
            ?.querySelector('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]')
            ?.textContent || '');
        if (chipText) return chipText.replace(/\s+/g, ' ').trim();
        const container = el.closest('[data-automation-id^="formField-"], [data-uxi-widget-type="multiselect"]');
        const containerText = (container?.textContent || '').replace(/\s+/g, ' ').trim();
        const selectedAnchor = Array.from(container?.querySelectorAll('a, [data-automation-id="promptOption"], [data-automation-id="selectedItem"]') || [])
          .map(a => (a.textContent || '').replace(/\s+/g, ' ').trim())
          .find(txt => referralCommitted(txt));
        if (selectedAnchor) return selectedAnchor;
        const fallback = ['LinkedIn Connection', 'Careers Website', 'Career Website', 'Company Website', 'Career Site',
          'LinkedIn', 'Indeed', 'Job Board or Social Media', 'Social Media', 'Job Board', 'Online Job Board', 'Internet', 'Online']
          .find(txt => new RegExp('(^|\\\\b)' + txt.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&') + '(\\\\b|$)', 'i').test(containerText));
        return fallback || '';
      };
      if (typeof pjaFillCombobox === 'function') {
        const referralInputs = pjaQueryAllExt('input[data-uxi-widget-type="selectinput"], input[role="combobox"]').filter(el => {
          const id = el.id || el.name || el.getAttribute('data-automation-id') || '';
          const label = (typeof getLabelFor === 'function' ? getLabelFor(el) : '') || el.getAttribute('aria-label') || id || '';
          const fieldText = (el.closest('[data-automation-id^="formField-"], [data-uxi-widget-type="multiselect"], div')?.textContent || '')
            .replace(/\s+/g, ' ');
          const text = [id, label, fieldText].join(' ');
          return /source--source/i.test(id) || /how did you hear|referral source|source of (this )?application|\bsource\b/i.test(text);
        });
        const committedInputs = referralInputs.filter(el => referralCommitted(selectedReferralText(el)));
        if (committedInputs.length) await addDbg('[WD] forced referralSource already committed');
        const inputs = referralInputs.filter(el => !referralCommitted(selectedReferralText(el)));
        for (const el of inputs) {
          pjaFillCombobox(el, profile.referralSource || 'LinkedIn', 'referralSource');
          filled++;
        }
        if (inputs.length && window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
          await Promise.race([window._pjaComboChain.catch(() => {}), sleep(12000)]);
        }
      }
      const buttons = pjaQueryAllExt('button, [role="button"]').filter(btn => {
        const id = btn.id || btn.getAttribute('data-automation-id') || '';
        const label = (typeof getLabelFor === 'function' ? getLabelFor(btn) : '') || btn.getAttribute('aria-label') || id || btn.textContent || '';
        if (!/source--source/i.test(id) && !/how did you hear|referral source|source/i.test(label)) return false;
        const selected = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
        return btn.getAttribute('aria-invalid') === 'true' || !selected || /select one|select\.\.\./i.test(selected) || !referralCommitted(selected);
      });
      const ownText = opt => {
        const clone = opt.cloneNode(true);
        clone.querySelectorAll('[role="option"]').forEach(child => child.remove());
        return (clone.textContent || '').trim().replace(/\s+/g, ' ');
      };
      const fallbacks = ['LinkedIn', 'LinkedIn Connection', 'Careers Website', 'Career Website', 'Company Website', 'Career Site', 'Indeed', 'Job Board or Social Media', 'Social Media', 'Job Board', 'Online Job Board', 'Internet', 'Online'];
      for (const btn of buttons) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(150);
        if (!await trustedWorkdayClick(btn, 'referralSource')) btn.click();
        try {
          const r = btn.getBoundingClientRect();
          await new Promise(resolve => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 5000);
            chrome.runtime.sendMessage({ type: 'CDP_TYPE_AT', x: r.left + r.width / 2,
              y: r.top + r.height / 2, text: profile.referralSource || 'LinkedIn' }, resp => {
              clearTimeout(timer);
              if (!done) { done = true; resolve(resp); }
            });
          });
        } catch (_) {}
        let option = null;
        for (let w = 0; w < 18 && !option; w++) {
          await sleep(150);
          const listbox = document.querySelector('[data-automation-id="activeListContainer"], [role="listbox"]:not([hidden])');
          const opts = listbox ? Array.from(listbox.querySelectorAll('[role="option"]')) : [];
          for (const fb of fallbacks) {
            option = opts.find(o => ownText(o).toLowerCase().includes(fb.toLowerCase()));
            if (option) break;
          }
        }
        if (option) {
          const target = option.querySelector('[data-automation-id="promptLeafNode"]') || option;
          if (!await trustedWorkdayClick(target, 'referralOption')) target.click();
          filled++;
          await sleep(350);
        } else {
          await addDbg('[WD] forced referralSource no option for ' + (btn.id || btn.getAttribute('aria-label') || '').slice(0, 40));
        }
      }
      await closeWorkdayTransientMenus();
      if (filled) await addDbg('[WD] forced referralSource n=' + filled);
      return filled;
    };
    const workdayPhoneNumberDigits = (sourceProfile) => {
      const raw = String(sourceProfile?.phone || job.profile?.phone || '').replace(/\D/g, '');
      if (/^(?:1)?\d{10}$/.test(raw)) return raw.slice(-10);
      return raw;
    };
    const workdayPhoneNumberVariants = (sourceProfile) => {
      const digits = workdayPhoneNumberDigits(sourceProfile);
      if (!/^\d{10}$/.test(digits)) return digits ? [digits] : [];
      return Array.from(new Set([
        digits,
        digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
        '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6)
      ]));
    };
    const forceWorkdayPhoneNumberTrustedCommit = async (sourceProfile, label) => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
      const digits = workdayPhoneNumberDigits(sourceProfile);
      if (!digits) return 0;
      const variants = workdayPhoneNumberVariants(sourceProfile);
      const inputs = pjaQueryAllExt('input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')
        .filter(el => {
          const r = el.getBoundingClientRect();
          if ((!el.offsetParent && r.width === 0) || r.height === 0) return false;
          const text = [getLabelFor(el), el.id, el.name].join(' ');
          if (/\b(phone\s*)?extension\b|--extension\b/i.test(text)) return false;
          if (el.getAttribute('data-uxi-widget-type') === 'selectinput' || el.getAttribute('role') === 'combobox') return false;
          return /^phoneNumber(?:--phoneNumber)?$/i.test(el.id || '') ||
            /^phoneNumber(?:--phoneNumber)?$/i.test(el.name || '');
        });
      let committed = 0;
      for (const el of inputs) {
        const priorId = el.id;
        const tempId = priorId || ('__pja_wd_phone_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
        if (!priorId) el.id = tempId;
        try {
          let resp = { ok: false, reason: 'not-run' };
          let ok = false;
          let valDigits = '';
          let invalid = '';
          let used = '';
          for (const text of variants) {
            resp = await new Promise(resolve => {
              chrome.runtime.sendMessage({ type: 'WORKDAY_SET_SID', selector: '#' + CSS.escape(tempId), text }, r => {
                resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {}));
              });
            });
            await sleep(350);
            valDigits = String(el.value || '').replace(/\D/g, '');
            invalid = el.getAttribute('aria-invalid') || '';
            used = text;
            ok = valDigits.includes(digits.slice(-7)) && invalid !== 'true';
            if (ok) break;
          }
          if (ok) committed++;
          await addDbg('[WD-MYINFO] trusted phoneNumber insertText ' + (label || '') +
            ' ok=' + !!resp.ok + ' committed=' + ok + ' invalid=' + invalid +
            ' used=' + used.replace(/\D/g, '').length + ':' + (used.includes('-') ? 'fmt' : 'digits') +
            ' valLen=' + valDigits.length + (resp.error ? ' err=' + String(resp.error).slice(0, 50) : ''));
        } catch (e) {
          await addDbg('[WD-MYINFO] trusted phoneNumber insertText error=' + String(e && e.message || e).slice(0, 80));
        } finally {
          if (!priorId && el.id === tempId) el.removeAttribute('id');
        }
      }
      return committed;
    };
    const summarizeWorkdayCriticalSelects = async (label) => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return;
      try {
        const rows = pjaQueryAllExt('input[data-uxi-widget-type="selectinput"], button, [role="button"]')
          .map(el => {
            const id = el.id || el.getAttribute('data-automation-id') || '';
            const rawLabel = (typeof getLabelFor === 'function' ? getLabelFor(el) : '') ||
              el.getAttribute('aria-label') || id || '';
            const text = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
          const root = el.closest('[data-uxi-widget-type="multiselect"]') ||
            el.closest('[data-automation-id^="formField"], fieldset') ||
            el.parentElement;
            const selected = (root?.querySelector('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]')?.textContent || '').trim().replace(/\s+/g, ' ');
            return { id, rawLabel, text, selected, invalid: el.getAttribute('aria-invalid') === 'true', valuePresent: 'value' in el ? !!String(el.value || '').trim() : undefined };
          })
          .filter(row => /source--source|how did you hear|referral source|country|territory|phone.{0,20}code|dial(?:ing|ling) code/i.test(
            [row.id, row.rawLabel, row.text, row.selected].join(' ')
          ))
          .slice(0, 8)
          .map(row => {
            const name = (row.rawLabel || row.id || row.text || 'field').slice(0, 55);
            const state = row.selected ? 'selected=' + row.selected.slice(0, 55)
              : row.valuePresent ? 'valuePresent'
              : row.text ? 'text=' + row.text.slice(0, 55)
              : 'empty';
            return name + ' {' + state + (row.invalid ? ',invalid' : '') + '}';
          });
        await addDbg('[WD-DIAG] ' + label + ': ' + (rows.join(' | ') || 'none'));
      } catch (e) {
        await addDbg('[WD-DIAG] ' + label + ' error=' + String(e && e.message || e).slice(0, 80));
      }
    };
    const closeWorkdayTransientMenus = async () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return;
      for (let i = 0; i < 2; i++) {
        try {
          const esc = new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
            bubbles: true, cancelable: true
          });
          (document.activeElement || document).dispatchEvent(esc);
          document.dispatchEvent(esc);
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
        } catch (_) {}
        await sleep(150);
      }
    };
    const workdayFieldText = (fieldPattern) => {
      const fields = pjaQueryAllExt('[data-automation-id^="formField"], fieldset')
        .filter(el => fieldPattern.test((el.textContent || '').replace(/\s+/g, ' ')));
      for (const field of fields) {
        const selected = field.querySelector(
          '[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]'
        );
        const button = Array.from(field.querySelectorAll('button,[role="button"]'))
          .find(btn => !btn.disabled && !/^errors found$/i.test((btn.textContent || '').trim()));
        const input = Array.from(field.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea'))
          .find(el => el.getAttribute('data-uxi-widget-type') !== 'selectinput' && (el.value || '').trim());
        return [
          selected?.textContent || '',
          button?.textContent || button?.getAttribute('aria-label') || '',
          input?.value || '',
        ].join(' ').replace(/\s+/g, ' ').trim();
      }
      return '';
    };
    const workdaySelectedTextFor = (el) => {
      if (!el || !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return '';
      try {
        const roots = [
          el.closest('[data-uxi-widget-type="multiselect"]'),
          el.closest('[data-automation-id^="formField"], [data-automation-id^="question"], fieldset'),
          el.parentElement,
        ].filter(Boolean);
        for (const root of roots) {
          const selected = Array.from(root.querySelectorAll(
            '[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]'
          )).map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
            .find(txt => txt && !/^select one|select\.\.\.|required|choose$/i.test(txt));
          if (selected) return selected;
          const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
          if (/\d+\s*item selected/i.test(text)) return text;
          if (/united states(?: of america)?\s*\(\+?1\)/i.test(text)) return text;
          if (/linkedin|indeed|job board|social media|career(?:s)? website|company website/i.test(text) &&
              !/select one|select\.\.\.|required only/i.test(text)) return text;
        }
      } catch (_) {}
      return '';
    };
    const workdayMyInfoCommitGaps = () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return [];
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const looksLikeMyInfo = /my information|contact information|address|phone device type|country\s*\/\s*territory phone code/i.test(bodyText);
      if (!looksLikeMyInfo) return [];
      const gaps = [];
      const unresolved = txt => !txt || /select one|required|choose|select\.\.\./i.test(txt);
      const stateWanted = String(profile.state || '').trim();
      const phoneWanted = workdayPhoneNumberDigits(profile);
      const countryTxt = workdayFieldText(/^country\b(?!.*phone)/i);
      const stateTxt = workdayFieldText(/^(state|state\/region|administrative area)\b/i);
      const phoneTypeTxt = workdayFieldText(/^phone device type\b/i);
      const phoneCodeTxt = workdayFieldText(/(country|territory).{0,60}phone.{0,30}code|phone.{0,30}(country|territory).{0,30}code|dial(?:ing|ling) code/i);
      const referralTxt = workdayFieldText(/how did you hear|where did you (hear|find)|referral source|source of (this )?application|\bsource\b/i);
      const phoneInput = pjaQueryAllExt('input:not([type=hidden]):not([type=file])').find(el => {
        const r = el.getBoundingClientRect();
        if ((!el.offsetParent && r.width === 0) || r.height === 0) return false;
        const idName = [el.id || '', el.name || ''].join(' ');
        return !/\b(phone\s*)?extension\b|--extension\b/i.test(idName) &&
          /^phoneNumber(?:--phoneNumber)?$/i.test(el.id || el.name || '');
      });
      if (countryTxt && unresolved(countryTxt)) gaps.push('country');
      if (stateWanted && stateTxt && unresolved(stateTxt)) gaps.push('state');
      if (phoneTypeTxt && !/mobile|cell|home|work/i.test(phoneTypeTxt)) gaps.push('phoneDeviceType');
      if (phoneCodeTxt && !(/united states/i.test(phoneCodeTxt) && /\+?1\b/.test(phoneCodeTxt))) gaps.push('phoneCountryCode');
      if (phoneInput && phoneWanted &&
          (phoneInput.getAttribute('aria-invalid') === 'true' ||
           !String(phoneInput.value || '').replace(/\D/g, '').includes(phoneWanted.slice(-7)))) gaps.push('phoneNumber');
      if (referralTxt && unresolved(referralTxt)) gaps.push('referralSource');
      return Array.from(new Set(gaps));
    };
    const finalizeWorkdayMyInformation = async (label) => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return [];
      const stepLine = (document.body?.innerText || '').match(/current step \d+ of \d+\s+([^\n]+)/i)?.[1] || '';
      const initialGaps = workdayMyInfoCommitGaps();
      if (!initialGaps.length && !/my information/i.test(stepLine)) {
        await addDbg('[WD-MYINFO] ' + (label || '') + ' skipped step=' + (stepLine || 'unknown'));
        return [];
      }
      await closeWorkdayTransientMenus();
      // Country/state prompt commits can trigger Workday to re-render and clear downstream address
      // fields. My Information values are dependent: country/state prompt commits can re-render and clear
      // address/city/postal/phone. Do two prompt→text passes, then verify committed display state.
      for (let pass = 0; pass < 2; pass++) {
        if (typeof pjaFillWorkdayPromptButtons === 'function') {
          await withTimeout(pjaFillWorkdayPromptButtons(profile), 20000, 'wd-myinfo-prompts-' + pass);
          await sleep(250);
        }
        if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers);
        if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
          await Promise.race([window._pjaComboChain.catch(() => {}), sleep(15000)]);
        }
        await withTimeout(forceWorkdayPhoneCountryCode(), 15000, 'wd-myinfo-phone-code-' + pass);
        await withTimeout(forceWorkdayReferralSource(), 15000, 'wd-myinfo-referral-' + pass);
        const wdp = forceWorkdayPhoneNumberCommit(profile);
        if (wdp) await addDbg('[WD-MYINFO] phoneNumber commit n=' + wdp + ' pass=' + pass);
        await forceWorkdayPhoneNumberTrustedCommit(profile, 'pass=' + pass);
        // Do not run the generic CDP phone filler on Workday after the dedicated trusted
        // insertText path. It can contend for the debugger and re-clear the React phone state.
        await closeWorkdayTransientMenus();
        const gaps = workdayMyInfoCommitGaps();
        await addDbg('[WD-MYINFO] ' + (label || 'finalize') + ' pass=' + pass + ' gaps=' + (gaps.join('|') || 'none'));
        if (!gaps.length) return [];
      }
      return workdayMyInfoCommitGaps();
    };
    const isWorkdaySelfIdentifyStep = () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const hasSidControls = !!document.querySelector(
        '[data-automation-id="formField-dateSignedOn"], ' +
        '[data-automation-id="formField-disabilityStatus"], ' +
        '[data-automation-id*="selfIdentifiedDisabilityData"]'
      );
      if (hasSidControls) return true;
      // Do not match the Workday left/top step navigation text alone. It contains
      // "Self Identify" on every step, including My Information. Require content that
      // exists in the active disability form itself.
      return /public burden statement|omb control number|please check one of the boxes below/i.test(bodyText) &&
        /disability|date signed|signed on/i.test(bodyText);
    };
    const workdaySelfIdentifyDateParts = () => {
      const dateField = document.querySelector('[data-automation-id="formField-dateSignedOn"]') || document;
      const read = sel => {
        const el = dateField.querySelector(sel);
        const raw = String(el?.value || el?.getAttribute('aria-valuenow') || el?.getAttribute('aria-valuetext') || '').trim();
        return { el, raw, invalid: el?.getAttribute('aria-invalid') === 'true' };
      };
      return {
        month: read('input[data-automation-id="dateSectionMonth-input"], [role="spinbutton"][aria-label="Month"]'),
        day: read('input[data-automation-id="dateSectionDay-input"], [role="spinbutton"][aria-label="Day"]'),
        year: read('input[data-automation-id="dateSectionYear-input"], [role="spinbutton"][aria-label="Year"]')
      };
    };
    const workdaySelfIdentifyDateValid = () => {
      const parts = workdaySelfIdentifyDateParts();
      const m = parseInt(parts.month.raw, 10);
      const d = parseInt(parts.day.raw, 10);
      const y = parseInt(parts.year.raw, 10);
      const yearOk = (y >= 2020 && y <= 2100) || (y >= 20 && y <= 99);
      return !parts.month.invalid && !parts.day.invalid && !parts.year.invalid &&
        m >= 1 && m <= 12 && d >= 1 && d <= 31 && yearOk;
    };
    const workdayTodaySignatureDate = () => {
      // Workday's "Date Signed" validator is tenant-side and commonly rejects stale
      // profile.signatureDate values. A job application signature should be today's date.
      const today = new Date();
      return { month: today.getMonth() + 1, day: today.getDate(), year: today.getFullYear() };
    };
    const workdaySelfIdentifyDateMatches = (desired) => {
      const parts = workdaySelfIdentifyDateParts();
      const m = parseInt(parts.month.raw, 10);
      const d = parseInt(parts.day.raw, 10);
      const y = parseInt(parts.year.raw, 10);
      return workdaySelfIdentifyDateValid() &&
        m === parseInt(desired.month, 10) &&
        d === parseInt(desired.day, 10) &&
        (y === parseInt(desired.year, 10) || y === parseInt(String(desired.year).slice(-2), 10));
    };
    const workdaySidDateErrorPresent = () => {
      const dateField = document.querySelector('[data-automation-id="formField-dateSignedOn"]') || document;
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      if (dateField.querySelector('[aria-invalid="true"]')) return true;
      return Array.from(document.querySelectorAll('[data-automation-id="Error-Date"], button'))
        .some(el => visible(el) && /error[-\s:]*date|^date$/i.test((el.getAttribute('data-automation-id') || el.textContent || '').trim()));
    };
    const workdaySelfIdentifyDisabilitySelected = () => {
      const disField = document.querySelector('[data-automation-id="formField-disabilityStatus"]');
      if (!disField) return true;
      const inputs = Array.from(disField.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
      if (inputs.length) return inputs.some(input => input.checked);
      return disField.getAttribute('aria-invalid') !== 'true' &&
        !disField.querySelector('[aria-invalid="true"], [data-automation-id$="-error"]');
    };
    const workdaySelfIdentifyNameCommitted = (profileArg) => {
      const fullName = String(profileArg?.fullName || ((profileArg?.firstName || '') + ' ' + (profileArg?.lastName || '')).trim()).trim();
      const nameField = document.querySelector('[data-automation-id="formField-name"] input[type="text"]');
      if (!nameField) return true;
      const value = String(nameField.value || '').trim();
      return !!value && (!fullName || value.length >= Math.min(4, fullName.length));
    };
    const workdaySelfIdentifyGaps = (profileArg) => {
      if (!isWorkdaySelfIdentifyStep()) return [];
      const gaps = [];
      if (!workdaySelfIdentifyDisabilitySelected()) gaps.push('disabilityStatus');
      if (!workdaySelfIdentifyNameCommitted(profileArg)) gaps.push('signatureName');
      if (document.querySelector('[data-automation-id="formField-dateSignedOn"]') &&
          (!workdaySelfIdentifyDateValid() || workdaySidDateErrorPresent())) gaps.push('dateSignedOn');
      return gaps;
    };
    const workdayCommitSelfIdentifyDisability = async (profileArg) => {
      const disField = document.querySelector('[data-automation-id="formField-disabilityStatus"]');
      if (!disField) return { present: false, selected: true };
      const dis = String(profileArg?.disability || '').toLowerCase();
      const targetRe = /no|do not|don.t/i.test(dis) ? /no.*disab|not have.*disab|without.*disab/i
        : /yes|have a disab/i.test(dis) ? /yes.*disab|have.*disab/i
        : /do not want|not answer|decline|prefer not/i;
      const inputs = Array.from(disField.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
      let target = null;
      let targetLabel = '';
      for (const input of inputs) {
        const lbl = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
        const text = (lbl?.textContent || input.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (text && targetRe.test(text)) {
          target = input;
          targetLabel = text;
          break;
        }
      }
      if (!target && /no|do not|don.t/i.test(dis) && inputs.length === 3) {
        target = inputs[1];
        targetLabel = 'No disability fallback option 2';
      }
      if (!target && inputs.length) {
        target = inputs.find(input => !input.checked) || inputs[0];
        targetLabel = 'fallback disability option';
      }
      if (!target) return { present: true, selected: false };
      const labelEl = target.id ? document.querySelector('label[for="' + CSS.escape(target.id) + '"]') : null;
      for (const other of inputs) {
        if (other !== target && other.checked) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          try { setter ? setter.call(other, false) : (other.checked = false); } catch (_) { other.checked = false; }
          other.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          other.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
      }
      if (!target.checked || !workdaySelfIdentifyDisabilitySelected()) {
        if (labelEl) {
          await trustedWorkdayClick(labelEl, 'sid-disability-label');
        } else {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          try { setter ? setter.call(target, true) : (target.checked = true); } catch (_) { target.checked = true; }
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        await sleep(650);
      }
      const selected = workdaySelfIdentifyDisabilitySelected();
      await addDbg('[WD-SID] disability selected=' + selected + ' target=' + targetLabel.slice(0, 45));
      return { present: true, selected };
    };
    const workdayCommitSelfIdentifyName = async (profileArg) => {
      const nameField = document.querySelector('[data-automation-id="formField-name"] input[type="text"]');
      const fullName = String(profileArg?.fullName || ((profileArg?.firstName || '') + ' ' + (profileArg?.lastName || '')).trim()).trim();
      if (!nameField || !fullName) return { present: !!nameField, committed: !nameField };
      const priorId = nameField.id;
      const tempId = priorId || ('__pja_sid_name_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      if (!priorId) nameField.id = tempId;
      try {
        const resp = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'WORKDAY_SET_SID', selector: '#' + CSS.escape(tempId), text: fullName }, r => {
            resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {}));
          });
        });
        await sleep(350);
        const committed = workdaySelfIdentifyNameCommitted(profileArg);
        await addDbg('[WD-SID] name committed=' + committed + ' ok=' + !!resp.ok +
          (resp.error ? ' err=' + String(resp.error).slice(0, 50) : ''));
        return { present: true, committed };
      } finally {
        if (!priorId && nameField.id === tempId) nameField.removeAttribute('id');
      }
    };
    const workdayCommitSelfIdentifyDate = async (profileArg) => {
      const dateField = document.querySelector('[data-automation-id="formField-dateSignedOn"]');
      if (!dateField) return { present: false, committed: true };
      const desired = workdayTodaySignatureDate();
      const setNativeDateDom = () => {
        const fresh = workdaySelfIdentifyDateParts();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const apply = (part, value) => {
          const el = part?.el;
          if (!el) return false;
          try { el.focus(); } catch (_) {}
          try { setter ? setter.call(el, String(value)) : (el.value = String(value)); } catch (_) { el.value = String(value); }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          try { el.blur(); } catch (_) {}
          return true;
        };
        let n = 0;
        if (apply(fresh.month, desired.month)) n++;
        if (apply(fresh.day, desired.day)) n++;
        if (apply(fresh.year, desired.year)) n++;
        return n;
      };
      const monthSpinner = dateField.querySelector('[role="spinbutton"][aria-label="Month"], input[data-automation-id="dateSectionMonth-input"]');
      const baseId = monthSpinner?.id?.replace('-dateSectionMonth-input', '') || null;
      if (!baseId) {
        await addDbg('[WD-SID] date no baseId');
        return { present: true, committed: false };
      }
      let resp = { ok: false, reason: 'not-run' };
      for (let attempt = 0; attempt < 2; attempt++) {
        resp = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'WORKDAY_TYPE_DATE',
            baseId,
            month: desired.month,
            day: desired.day,
            year: desired.year
          }, r => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {})));
        });
        await sleep(800);
        if (workdaySelfIdentifyDateMatches(desired) && !workdaySidDateErrorPresent()) break;
        const nativeSet = setNativeDateDom();
        await sleep(750);
        try {
          const partsAfterNative = workdaySelfIdentifyDateParts();
          const lastPart = partsAfterNative.year.el || partsAfterNative.day.el || partsAfterNative.month.el;
          lastPart?.focus?.();
          lastPart?.blur?.();
        } catch (_) {}
        await addDbg('[WD-SID] date nativeFallback n=' + nativeSet + ' attempt=' + attempt +
          ' errorDate=' + workdaySidDateErrorPresent());
        if (workdaySelfIdentifyDateMatches(desired) && !workdaySidDateErrorPresent()) break;
      }
      const dateError = workdaySidDateErrorPresent();
      const committed = workdaySelfIdentifyDateMatches(desired) && !dateError;
      const parts = workdaySelfIdentifyDateParts();
      await addDbg('[WD-SID] date committed=' + committed + ' values=' +
        [parts.month.raw || '?', parts.day.raw || '?', parts.year.raw || '?'].join('/') +
        ' invalid=' + [parts.month.invalid ? 'm' : '', parts.day.invalid ? 'd' : '', parts.year.invalid ? 'y' : ''].join('') +
        ' errorDate=' + dateError +
        ' ok=' + !!resp.ok + (resp.error ? ' err=' + String(resp.error).slice(0, 50) : ''));
      return { present: true, committed };
    };
    const workdaySelfIdentifyTransaction = async (profileArg, phase) => {
      if (!isWorkdaySelfIdentifyStep()) return { ok: true, gaps: [] };
      await closeWorkdayTransientMenus();
      await addDbg('[WD-SID] transaction start phase=' + (phase || ''));
      // Order is load-bearing. Disability is first because its React re-render can clear
      // text/date inputs. Date is before name because Workday/CDP focus races can send a
      // date digit into the previously focused text input; the final committed field must
      // therefore be the signature name.
      await workdayCommitSelfIdentifyDisability(profileArg);
      await workdayCommitSelfIdentifyDate(profileArg);
      await workdayCommitSelfIdentifyName(profileArg);
      await closeWorkdayTransientMenus();
      const gaps = workdaySelfIdentifyGaps(profileArg);
      await addDbg('[WD-SID] verify phase=' + (phase || '') + ' gaps=' + (gaps.join('|') || 'none'));
      return { ok: !gaps.length, gaps };
    };
    const hasWorkdayDuplicateRecordError = () => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return false;
      const txt = String(document.body?.innerText || '').replace(/\s+/g, ' ');
      return /previous worker information already exists for this application|an address already exists for this application|update existing previous worker information|update or delete the address/i.test(txt);
    };
    const workdayDraftApplyUrl = () => {
      const base = String(location.href || job.applyUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
      const draftBase = /\/apply\/applyManually$/i.test(base)
        ? base.replace(/\/apply\/applyManually$/i, '/apply')
        : /\/apply$/i.test(base)
          ? base
          : base + '/apply';
      return draftBase + '?pja_wd_draft_retry=1';
    };
    const workdayDuplicateRetryKey = () => 'pja_wd_duplicate_draft_retry_' +
      (job.runId || 'norun') + '_' + (job.id || job.jobId || job.applyUrl || '');
    const workdayDuplicateRecoveryAction = () => {
      const input = {
        hasError: hasWorkdayDuplicateRecordError(),
        pathname: location.pathname,
        search: location.search,
        retryUsed: sessionStorage.getItem(workdayDuplicateRetryKey()) === '1',
      };
      return window.PJAWorkdayEngine?.duplicateRecordRecoveryAction
        ? window.PJAWorkdayEngine.duplicateRecordRecoveryAction(input)
        : !input.hasError || !/\/apply\/applyManually(?:\/|$)/i.test(input.pathname)
          ? 'none'
          : input.retryUsed || /(?:^|[?&])pja_wd_draft_retry=1(?:&|$)/.test(input.search)
            ? 'terminal'
            : 'reroute';
    };
    const rerouteWorkdayDuplicateDraft = async (phaseLabel) => {
      const recoveryAction = workdayDuplicateRecoveryAction();
      if (recoveryAction === 'none') return false;
      const duplicateRetryKey = workdayDuplicateRetryKey();
      if (recoveryAction === 'terminal') {
        await addDbg('[WD] duplicate record validation still present after draft retry; manual deferral');
        return false;
      }
      sessionStorage.setItem(duplicateRetryKey, '1');
      const draftUrl = workdayDraftApplyUrl();
      await addDbg('[WD] duplicate record validation ' + (phaseLabel || 'on applyManually') + '; retrying draft /apply route');
      location.assign(draftUrl);
      return true;
    };
    // A marked draft recovery that returns to applyManually with the same duplicate validation is
    // already exhausted. Terminalize before the expensive Workday fill chain can consume the
    // ranked watchdog and obscure this known manual blocker as ranked_watchdog_timeout.
    if (workdayDuplicateRecoveryAction() === 'terminal') {
      const fields = ['workday_duplicate_previous_worker_or_address'];
      await addDbg('[WD] duplicate record persisted on marked draft retry; recording workday_duplicate_record before fill');
      sessionStorage.setItem('pja_last_action', 'recordResult:workday_duplicate_record:' + job.company);
      await maybeRequestApplyHelp('workday_duplicate_record', {
        missingRequired: fields,
        formSummary: 'Workday duplicate Previous Worker or Address draft record blocked step advance',
      });
      await recordResult(job, { success: false, reason: 'workday_duplicate_record', fields });
      navigateBack(job);
      return;
    }
    const retryWorkdayBlockedAdvance = async (reasonHint) => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return { advanced: false };
      const stepBefore = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
      const retryKey = 'pja_wd_block_retry_' + (job.runId || 'norun') + '_' +
        (job.id || job.jobId || job.applyUrl || '') + '_' + (reasonHint || 'blocked') + '_' +
        (stepBefore || 'nostep') + '_' + location.pathname.slice(-32);
      if (sessionStorage.getItem(retryKey) === '1') {
        await addDbg('[WD] blocked advance retry already used step=' + (stepBefore || '?'));
        return { advanced: false };
      }
      sessionStorage.setItem(retryKey, '1');
      await summarizeWorkdayCriticalSelects('before-retry ' + (reasonHint || 'blocked'));
      await addDbg('[WD] blocked advance retry start reason=' + (reasonHint || 'blocked') + ' step=' + (stepBefore || '?'));
      try {
        if (reasonHint === 'resume') {
          await addDbg('[WD] blocked advance retry: retrying resume upload');
          await withTimeout(tryInjectResume(profile, answers), 90000, 'wd-resume-blocked-retry');
          await sleep(1200);
        }
        if (isWorkdaySelfIdentifyStep()) {
          await withTimeout(workdaySelfIdentifyTransaction(profile, 'blocked-retry'), 45000, 'wd-sid-blocked-retry');
        } else {
          await withTimeout(forceWorkdayPhoneCountryCode(), 18000, 'wd-phone-code-blocked-retry');
          await finalizeWorkdayMyInformation('blocked-retry');
          await withTimeout(pjaFillWorkdayAppQuestions(profile), 30000, 'wd-appq-blocked-retry');
        }
        await addDbg('[WD] post-prompt text refill done');
        if (!isWorkdaySelfIdentifyStep()) {
          if (typeof pjaFillRequiredComboboxFallback === 'function') pjaFillRequiredComboboxFallback(profile, answers);
          if (typeof pjaFillRequiredSelectFallback === 'function') pjaFillRequiredSelectFallback();
          if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
        }
        await sleep(700);
        await summarizeWorkdayCriticalSelects('after-refill ' + (reasonHint || 'blocked'));
        await closeWorkdayTransientMenus();
        const reNext = Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
          .find(el => /^next$|^continue$|save.*continue/i.test(el.getAttribute('aria-label') || ''))
          || document.querySelector('[data-automation-id="bottomNavigationNext"]')
          || document.querySelector('[data-automation-id="pageFooterNextButton"]')
          || findButton(/^next$|^continue$|^next step$|^save and continue$|^save & continue$|^proceed$|^proceed to next/i);
        if (!reNext) {
          await addDbg('[WD] blocked advance retry no next button');
          return { advanced: false };
        }
        const urlBefore = location.href;
        const label = reNext.getAttribute('data-automation-id') || (reNext.textContent || reNext.getAttribute('aria-label') || '').trim().slice(0, 30);
        const waitForBlockedAdvance = timeoutMs => new Promise(resolve => {
          let waited = 0;
          const poll = setInterval(() => {
            waited += 250;
            const stepNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
            const submitNow = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]') ||
              Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
                .some(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || ''));
            const doneNow = /\/completed\/|\/confirmation/i.test(location.pathname) ||
              /view my applications|your application (has been|was) submitted|thank you for applying|application received/i.test(document.body?.innerText || '');
            if ((stepBefore && stepNow !== stepBefore) || location.href !== urlBefore || submitNow || doneNow || waited >= timeoutMs) {
              clearInterval(poll);
              resolve();
            }
          }, 250);
        });
        const readBlockedAdvanceState = () => {
          const stepAfterNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          const submitFoundNow = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]') ||
            Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
              .some(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || '')) ||
            !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
          const completedNow = /\/completed\/|\/confirmation/i.test(location.pathname) ||
            /view my applications|your application (has been|was) submitted|thank you for applying|application received/i.test(document.body?.innerText || '');
          return {
            stepAfter: stepAfterNow,
            submitFound: submitFoundNow,
            completed: completedNow,
            advanced: completedNow || submitFoundNow || location.href !== urlBefore || (stepBefore && stepAfterNow !== stepBefore)
          };
        };
        const mainOk = await mainWorldWorkdayAdvance(reNext, 'blocked-retry-' + label);
        await addDbg('[WD] blocked advance main-first ok=' + !!mainOk + ' label=' + label);
        if (mainOk) await waitForBlockedAdvance(isWorkdaySelfIdentifyStep() ? 8000 : 5000);
        let retryState = readBlockedAdvanceState();
        let stepAfter = retryState.stepAfter;
        let submitFound = retryState.submitFound;
        let completed = retryState.completed;
        let advanced = retryState.advanced;
        if (!advanced) {
          if (!(await trustedWorkdayClick(reNext, 'blocked-retry-' + label))) {
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(evtType => {
              reNext.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
            });
          }
          await waitForBlockedAdvance(10000);
          retryState = readBlockedAdvanceState();
          stepAfter = retryState.stepAfter;
          submitFound = retryState.submitFound;
          completed = retryState.completed;
          advanced = retryState.advanced;
        }
        if (!advanced && await rerouteWorkdayDuplicateDraft('on applyManually')) {
          return { advanced: true, rerouted: true };
        }
        if (!advanced && await trustedWorkdayEnter(reNext, 'blocked-retry-' + label)) {
          await new Promise(resolve => {
            let waited = 0;
            const poll = setInterval(() => {
              waited += 250;
              const stepNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
              const submitNow = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]') ||
                Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
                  .some(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || ''));
              const doneNow = /\/completed\/|\/confirmation/i.test(location.pathname) ||
                /view my applications|your application (has been|was) submitted|thank you for applying|application received/i.test(document.body?.innerText || '');
              if ((stepBefore && stepNow !== stepBefore) || location.href !== urlBefore || submitNow || doneNow || waited >= 7000) {
                clearInterval(poll);
                resolve();
              }
            }, 250);
          });
          stepAfter = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          submitFound = !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]') ||
            Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
              .some(el => /submit.*application|apply now|^submit$/i.test(el.getAttribute('aria-label') || '')) ||
            !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
          completed = /\/completed\/|\/confirmation/i.test(location.pathname) ||
            /view my applications|your application (has been|was) submitted|thank you for applying|application received/i.test(document.body?.innerText || '');
          advanced = completed || submitFound || location.href !== urlBefore || (stepBefore && stepAfter !== stepBefore);
          if (!advanced && await rerouteWorkdayDuplicateDraft('after Enter')) {
            return { advanced: true, rerouted: true };
          }
        }
        await addDbg('[WD] blocked advance retry result advanced=' + !!advanced + ' submit=' + !!submitFound + ' completed=' + !!completed + ' step=' + (stepBefore || '?') + '→' + (stepAfter || '?'));
        return { advanced, submitFound, completed };
      } catch (e) {
        await addDbg('[WD] blocked advance retry error=' + String(e && e.message || e).slice(0, 100));
        return { advanced: false, error: String(e && e.message || e) };
      }
    };
    await withTimeout(forceWorkdayPhoneCountryCode(), 15000, 'wd-phone-code');
    await withTimeout(forceWorkdayReferralSource(), 15000, 'wd-referral-source');
    if (typeof pjaForcePhoneField === 'function' && !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      const pf0 = await pjaForcePhoneField(/workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? workdayPhoneNumberDigits(profile) : (profile.phone || job.profile?.phone || ''));
      if (pf0) { await addDbg('[phone] pre-step forced via trusted typing n=' + pf0); await sleep(300); }
    }
    // These helpers are best-effort and shared with Easy Apply. A site-specific DOM edge case in
    // any one of them must not abort the entire external-apply coroutine (previously that left the
    // queue stuck until the five-minute SW watchdog advanced it). Isolate each helper and retain a
    // precise phase marker so live runs identify the failing helper without sacrificing the job.
    const safeFallback = async (name, fn) => {
      if (typeof fn !== 'function') return;
      try { fn(); await addDbg('[phase] ' + name + ' done'); }
      catch (e) { await addDbg('[phase] ' + name + ' error=' + String(e && e.message || e).slice(0, 120)); }
    };
    await safeFallback('radio-fallback', typeof pjaFillRequiredRadioFallback === 'function' ? pjaFillRequiredRadioFallback : null);
    await safeFallback('select-fallback', typeof pjaFillRequiredSelectFallback === 'function' ? pjaFillRequiredSelectFallback : null);
    await safeFallback('consent-fallback', typeof pjaAutoCheckConsent === 'function' ? pjaAutoCheckConsent : null);
    // Combobox fallback: required comboboxes still empty after all above — fill Yes/No by pattern.
    await safeFallback('combobox-fallback', typeof pjaFillRequiredComboboxFallback === 'function'
      ? () => pjaFillRequiredComboboxFallback(profile, answers) : null);
    if (typeof pjaFillSmartRecruitersCustomFields === 'function') {
      await withTimeout(pjaFillSmartRecruitersCustomFields(profile), 20000, 'sr-custom-fields');
      await sleep(250);
    }

    await sleep(500);
    // Workday's State / Country / Phone Device Type prompts render as BUTTONS after the regular
    // input fields hydrate. Run the dedicated trusted-click filler here, when the full step DOM is
    // present, rather than relying only on pjaFillForm's earlier render-time pass.
    if (typeof pjaFillWorkdayPromptButtons === 'function') {
      await withTimeout(pjaFillWorkdayPromptButtons(profile), 20000, 'wd-prompts');
      await sleep(300);
    }
    await withTimeout(forceWorkdayPhoneCountryCode(), 15000, 'wd-phone-code-post');
    await withTimeout(forceWorkdayReferralSource(), 15000, 'wd-referral-source-post');
    if (typeof pjaForcePhoneField === 'function' && !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      const pf1 = await pjaForcePhoneField(/workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? workdayPhoneNumberDigits(profile) : (profile.phone || job.profile?.phone || ''));
      if (pf1) { await addDbg('[phone] wd-post forced via trusted typing n=' + pf1); await sleep(250); }
    }
    await finalizeWorkdayMyInformation('pre-loop');

    // --- Multi-step: handle Next button if needed ---
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
        // Workday can temporarily unmount the step body during SPA transitions after Save/Continue:
        // it says "current step 1", exposes top navigation + "Back to Job Posting", but no form
        // inputs and no Next/Submit footer. Do not immediately click Back — that can undo a valid
        // transition. Wait for hydration first; only reload the apply route once if the shell stays
        // empty.
        const isWorkdayDeadEnd = /workday\.com|myworkdayjobs\.com/i.test(location.hostname)
          && /current step \d+/i.test(document.body.innerText || '')
          && pjaQueryAllExt('input, textarea, select').filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length === 0;
        if (isWorkdayDeadEnd) {
          const bodyTextNow = document.body.innerText || '';
          const hasWorkdayErrorShell = /something went wrong/i.test(bodyTextNow) &&
            /refresh the page and then try again/i.test(bodyTextNow);
          if (hasWorkdayErrorShell) {
            const errorRetryKey = 'pja_wd_error_shell_retry_' + (job.runId || 'norun') + '_' + (job.id || job.jobId || job.applyUrl || '');
            const errorTries = parseInt(sessionStorage.getItem(errorRetryKey) || '0', 10);
            if (errorTries < 2) {
              sessionStorage.setItem(errorRetryKey, String(errorTries + 1));
              await addDbg('[WD] error shell; refreshing apply route retry=' + (errorTries + 1));
              location.reload();
              return;
            }
            await addDbg('[WD] error shell persisted; recording stuck_budget');
            await recordResult(job, { success: false, reason: 'stuck_budget', fields: ['workday_error_shell'] });
            navigateBack(job);
            return;
          }
          const deadEndRetryKey = 'pja_wd_deadend_retry_' + (job.id || job.jobId || job.applyUrl || '');
          const deadEndTries = parseInt(sessionStorage.getItem(deadEndRetryKey) || '0', 10);
          if (deadEndTries < 3) {
            sessionStorage.setItem(deadEndRetryKey, String(deadEndTries + 1));
            await addDbg('[WD] empty step shell; waiting for hydration before recovery try=' + (deadEndTries + 1));
            let hydrated = false;
            for (let w = 0; w < 90 && !hydrated; w++) {
              await sleep(500);
              const visibleInputs = pjaQueryAllExt('input, textarea, select').filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }).length;
              const bodyNow = document.body.innerText || '';
              const nextNow = !!document.querySelector('[data-automation-id="pageFooterNextButton"],[data-automation-id="bottomNavigationNext"],[data-automation-id="bottomNavigationSubmit"]') ||
                Array.from(document.querySelectorAll('[data-automation-id="click_filter"]'))
                  .some(el => /next|continue|submit|apply now/i.test(el.getAttribute('aria-label') || ''));
              const stepNow = bodyNow.match(/current step (\d+)/i)?.[1] || '';
              const stillLoadingOnly = /\bLoading\b/i.test(bodyNow) && !/Errors Found|required field|select one|required/i.test(bodyNow);
              hydrated = visibleInputs > 0 || nextNow || (stepNow && stepNow !== '1' && !stillLoadingOnly);
            }
            if (hydrated) {
              await addDbg('[WD] empty step shell hydrated; re-entering fill path');
              return runExternalApply(job, rawAnswers);
            }
            const currentBase = String(location.href || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
            const jobBase = String(job.applyUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
            const sourceBase = /\/apply(?:\/|$)/i.test(currentBase) ? currentBase : (jobBase || currentBase);
            const draftBase = /\/apply\/applyManually$/i.test(sourceBase)
              ? sourceBase.replace(/\/apply\/applyManually$/i, '/apply')
              : /\/apply$/i.test(sourceBase)
                ? sourceBase
                : sourceBase + '/apply';
            const retryUrl = draftBase +
              '?pja_wd_entry_retry=1&pja_wd_hydrate_retry=' + (deadEndTries + 1);
            await addDbg('[WD] empty step shell persisted; navigating draft apply route retry=' + (deadEndTries + 1));
            location.assign(retryUrl);
            await sleep(5000);
            return runExternalApply(job, rawAnswers);
          }
          await addDbg('[WD] empty step shell exhausted retries; recording stuck_budget');
          await recordResult(job, { success: false, reason: 'stuck_budget', fields: ['workday_empty_shell'] });
          navigateBack(job);
          return;
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
      const isWorkdayHost = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
      const sidStepAtTop = isWorkdaySelfIdentifyStep();
      if (sidStepAtTop) {
        await withTimeout(workdaySelfIdentifyTransaction(profile, 'step-' + steps), 45000, 'wd-sid-step-' + steps);
      } else {
        if (typeof pjaFillWorkdayWorkExperience === 'function') { await withTimeout(pjaFillWorkdayWorkExperience(profile), 12000, 'wd-workexp-step-' + steps); await sleep(300); }
        if (typeof pjaFillWorkdaySelfIdentifyDate === 'function') { await withTimeout(pjaFillWorkdaySelfIdentifyDate(profile), 12000, 'wd-selfid-date-step-' + steps); await sleep(150); }
        if (typeof pjaForceWorkdayTermsCheckbox === 'function') await withTimeout(pjaForceWorkdayTermsCheckbox('step-' + steps), 12000, 'wd-terms-step-' + steps);
        await finalizeWorkdayMyInformation('step-' + steps);
        await addDbg('[WD] post-prompt step text refill done');
      }
      const missing = findMissingRequired();
      // Workday selectinput fields can't be opened via JS — try Next anyway and let Workday validate.
      let hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
      if (hardMissing.length) {
        // Some required fields render AFTER the initial fill pass — e.g. Workday's
        // "My Experience" Work Experience subsection (workExperience-N--jobTitle/company/...).
        // Re-run the fillers once and re-check before bailing.
        await addDbg('[ext] hardMissing=' + hardMissing.map(m=>m.label).join('|') + ' — re-filling late fields');
        if (isWorkdaySelfIdentifyStep()) {
          await withTimeout(workdaySelfIdentifyTransaction(profile, 'hardMissing-refill'), 45000, 'wd-sid-hardMissing-refill');
        } else {
          if (typeof pjaFillWorkdayWorkExperience === 'function') await withTimeout(pjaFillWorkdayWorkExperience(profile), 12000, 'wd-workexp-hardMissing');
          if (typeof pjaFillWorkdaySelfIdentifyDate === 'function') await withTimeout(pjaFillWorkdaySelfIdentifyDate(profile), 12000, 'wd-selfid-date-hardMissing');
          if (typeof pjaForceWorkdayTermsCheckbox === 'function') await withTimeout(pjaForceWorkdayTermsCheckbox('hardMissing-refill'), 12000, 'wd-terms-hardMissing');
          pjaFillForm(profile, answers);
          if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
            await Promise.race([window._pjaComboChain.catch(() => {}), sleep(30000)]);
          }
          await sleep(300);
          await finalizeWorkdayMyInformation('hardMissing-refill');
          pjaFillRequiredComboboxFallback(profile, answers);
          await sleep(400);
        }
        hardMissing = findMissingRequired().filter(m => m.type !== 'wd_selectinput');
        // Still-missing required fields → answer them with AI (profile + resume + prefs), then re-check.
        if (hardMissing.length) {
          await withTimeout(pjaAnswerRequiredViaAI(job), 120000, 'answerer-step');
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
      // SID form detected by its unique fields (disability checkbox + date spinner).
      const isWorkdaySidStep = isWorkdaySelfIdentifyStep();
      await addDbg('[ext] step ' + steps + ' clicking Next step=' + stepTextBefore + ' wdMissing=' + wdSelectMissing.map(m=>m.label).join('|') + ' btn=' + nextBtnAid + '/' + nextBtnText + (nextBtnDisabled ? '[DISABLED]' : '') + (isWorkdaySidStep ? '[SID-CDP]' : ''));
      if (isWorkdayHost) {
        if (isWorkdaySidStep) {
          const sidReadyRaw = await withTimeout(workdaySelfIdentifyTransaction(profile, 'pre-click-' + steps), 45000, 'wd-sid-pre-click-' + steps);
          const sidReady = sidReadyRaw && typeof sidReadyRaw === 'object'
            ? sidReadyRaw
            : { ok: false, gaps: ['sid_transaction_no_result'] };
          if (!sidReady.ok) {
            const sidGaps = Array.isArray(sidReady.gaps) ? sidReady.gaps : ['sid_transaction_failed'];
            await addDbg('[WD-SID] pre-click gaps remain=' + sidGaps.join('|'));
          }
        } else {
          await finalizeWorkdayMyInformation('pre-click-' + steps);
          if (typeof pjaForceWorkdayTermsCheckbox === 'function') await withTimeout(pjaForceWorkdayTermsCheckbox('pre-click-' + steps), 12000, 'wd-terms-pre-click-' + steps);
        }
      }
      // If THIS click is the final Submit (Workday multi-step forms submit via the footer/bottom
      // Submit button in the step loop), record a PERSISTENT per-job "submitted this run" flag so
      // the early-confirmation on the next /completed/ load records APPLIED — not already_applied.
      // sessionStorage.pja_last_action is too fragile (later step-loop iterations overwrite it
      // before /completed/ loads); chrome.storage.local survives the navigation intact.
      if (/submit/i.test(nextBtnText) || nextBtnAid === 'bottomNavigationSubmit') {
        const stopBeforeFinalSubmit = await new Promise(r => {
          try { chrome.storage.local.get('pja_ext_stop_before_submit', d => r(d.pja_ext_stop_before_submit ?? PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT)); }
          catch(_) { r(PJA_EXT_STOP_BEFORE_SUBMIT_DEFAULT); }
        });
        if (stopBeforeFinalSubmit) {
          await addDbg('[ext] stop-before-submit at Workday final Submit — leaving review screen');
          sessionStorage.setItem('pja_last_action', 'ready_to_submit:' + job.company);
          await recordResult(job, { success: false, reason: 'ready_to_submit_review' });
          return;
        }
        try { sessionStorage.setItem('pja_last_action', 'ready_to_submit:' + job.company); } catch (_) {}
        try { await new Promise(r => chrome.storage.local.set({ ['pja_wd_submitclick_' + (job.id || job.jobId || '')]: Date.now() }, r)); } catch (_) {}
      }
      const preClickUrl = location.href;
      const preClickBodyMarker = !isWorkdayHost && !stepTextBefore
        ? String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 4000)
        : '';
      if (isWorkdayHost) {
        const clickLabel = nextBtnAid || nextBtnText || 'next';
        const waitForWorkdayAdvance = timeoutMs => new Promise(resolve => {
          let waited = 0;
          const poll = setInterval(() => {
            waited += 250;
            const errFound = Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
            const stepNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
            const advanced = stepTextBefore ? stepNow !== stepTextBefore : false;
            const urlChanged = location.href !== preClickUrl;
            if (errFound || advanced || urlChanged || waited >= timeoutMs) {
              clearInterval(poll);
              resolve({ errFound, advanced, urlChanged, stepNow });
            }
          }, 250);
        });
        let advanceObserved = false;
        if (isWorkdaySidStep || nextBtnAid === 'pageFooterNextButton' || nextBtnAid === 'bottomNavigationNext' || /submit/i.test(nextBtnText)) {
          const mainOk = await mainWorldWorkdayAdvance(nextBtn, clickLabel);
          if (mainOk) {
            const observed = await waitForWorkdayAdvance(isWorkdaySidStep ? 6000 : 3000);
            advanceObserved = !!(observed.errFound || observed.advanced || observed.urlChanged);
            await addDbg('[WD] main-first observed=' + advanceObserved + ' step=' + (observed.stepNow || '') +
              (observed.urlChanged ? ' urlChanged=true' : '') + (observed.errFound ? ' errors=true' : ''));
          }
        }
        if (!advanceObserved) {
          const clicked = await Promise.race([
            trustedWorkdayClick(nextBtn, clickLabel),
            sleep(10000).then(async () => { await addDbg('[WD] trusted click ' + clickLabel + ' TIMEOUT 10000ms'); return false; })
          ]);
          if (!clicked) {
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(evtType => {
              const evt = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
              nextBtn.dispatchEvent(evt);
            });
          }
        }
      } else if (isSmartRecruitersHost) {
        const clicked = await trustedPointClick(nextBtn);
        await addDbg('[SR] trusted Next click=' + clicked);
        if (!clicked) {
          ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(evtType => {
            const evt = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
            nextBtn.dispatchEvent(evt);
          });
        }
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
      if (isWorkdayHost && location.href === preClickUrl) {
        const stepAfterClick = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
        const errAfterClick = Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
        if (stepTextBefore && stepAfterClick === stepTextBefore && !errAfterClick) {
          await addDbg('[WD] no advance after trusted click; trying MAIN-world advance');
          await mainWorldWorkdayAdvance(nextBtn, nextBtnAid || nextBtnText || 'next');
          await new Promise(resolve => {
            let waited = 0;
            const poll = setInterval(() => {
              waited += 250;
              const errFound = Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
              const stepNow = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
              const advanced = stepNow !== stepTextBefore;
              const urlChanged = location.href !== preClickUrl;
              if (errFound || advanced || urlChanged || waited >= 10000) { clearInterval(poll); resolve(); }
            }, 250);
          });
        }
      }
      if (!isWorkdayHost && !stepTextBefore && location.href === preClickUrl) {
        const postClickBodyMarker = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 4000);
        const submitNow = !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
        if (postClickBodyMarker === preClickBodyMarker && !submitNow) {
          await addDbg('[ext] step ' + steps + ' no observable advance after Next; breaking to terminal handling');
          stuckOnWdSelectinput = isSmartRecruitersHost ? 'smartrecruiters' : true;
          break;
        }
      }
      // Detect Workday validation errors after clicking Next:
      const wdValidationError = isWorkdayHost &&
        Array.from(document.querySelectorAll('button')).some(b => /^errors found$/i.test(b.textContent.trim()));
      if (wdValidationError) {
        // Wait for Workday to re-render the form after showing "Errors Found".
        await new Promise(r => setTimeout(r, 2000));
        // Keep a value-free snapshot of the controls that Workday rejected. The rolling pja_dbg
        // buffer is too small to retain this evidence through the recovery fill passes, and raw
        // input values can contain personal data. Labels, control metadata, and boolean presence
        // flags are sufficient to diagnose a tenant-specific required question safely.
        try {
          const workdayErrorLabels = (typeof pjaCollectWorkdayErrorLabels === 'function')
            ? pjaCollectWorkdayErrorLabels().slice(0, 20)
            : [];
          const rejectedControls = Array.from(document.querySelectorAll(
            '[aria-invalid="true"], [data-automation-id$="-error"], input[id^="question_"], ' +
            'input[role="combobox"], [data-uxi-widget-type="selectinput"]'
          )).map(el => {
            const root = el.closest('fieldset,[data-automation-id^="formField"],[data-automation-id^="question"],div') || el.parentElement;
            const selected = root?.querySelector('[data-automation-id="selectedItemList"], [class*="singleValue"], [class*="single-value"]');
            const wdSelected = typeof workdaySelectedTextFor === 'function' ? workdaySelectedTextFor(el) : '';
            const rawLabel = (typeof getLabelFor === 'function' ? getLabelFor(el) : '') ||
              root?.querySelector('legend,label')?.textContent || el.getAttribute('aria-label') || '';
            return {
              id: String(el.id || '').slice(0, 80),
              automationId: String(el.getAttribute('data-automation-id') || '').slice(0, 100),
              tag: String(el.tagName || '').toLowerCase(),
              type: String(el.getAttribute('type') || '').slice(0, 30),
              role: String(el.getAttribute('role') || '').slice(0, 30),
              widget: String(el.getAttribute('data-uxi-widget-type') || '').slice(0, 40),
              label: String(rawLabel).trim().replace(/\s+/g, ' ').slice(0, 180),
              required: !!el.required || el.getAttribute('aria-required') === 'true',
              invalid: el.getAttribute('aria-invalid') === 'true' || /-error$/.test(el.getAttribute('data-automation-id') || ''),
              valuePresent: 'value' in el ? !!String(el.value || '').trim() : undefined,
              selectedPresent: !!(wdSelected || selected?.textContent?.trim()),
              selectedText: String(wdSelected || selected?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
            };
          }).filter((item, index, all) => item.label || item.id || item.automationId)
            .filter((item, index, all) => index === all.findIndex(other =>
              other.id === item.id && other.automationId === item.automationId && other.label === item.label))
            .slice(0, 80);
          await new Promise(resolve => chrome.storage.local.set({
            pja_wd_error_diag: {
              ts: Date.now(), runId: job.runId || '', jobId: job.id || job.jobId || '',
              company: job.company || '', title: job.title || '', applyUrl: job.applyUrl || location.href,
              url: location.href, step: stepTextBefore || '', controls: rejectedControls, errorLabels: workdayErrorLabels
            }
          }, resolve));
        } catch (_) {}
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
        if (hasWorkdayDuplicateRecordError()) {
          if (await rerouteWorkdayDuplicateDraft('on applyManually')) return;
          await addDbg('[WD] duplicate record validation cannot be auto-cleared; recording workday_duplicate_record');
          stuckOnWdSelectinput = 'workday_duplicate_record';
          break;
        }

        // General recovery: re-run the correct scoped filler, then retry Next. On the
        // Workday Self Identify page, do not run generic form/My Info fillers; they can
        // trigger React re-renders that clear the signature date/name/checkbox state.
        if (isWorkdaySelfIdentifyStep()) {
          await withTimeout(workdaySelfIdentifyTransaction(profile, 'validation-error-' + steps), 45000, 'wd-sid-validation-' + steps);
        } else {
          await withTimeout(pjaFillWorkdayWorkExperience(profile), 12000, 'wd-workexp-validation');
          await withTimeout(pjaFillWorkdaySelfIdentifyDate(profile), 12000, 'wd-selfid-date-validation');
          if (typeof pjaFillForm === 'function') pjaFillForm(profile, answers);
          if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
            await Promise.race([window._pjaComboChain.catch(() => {}), sleep(30000)]);
          }
          await sleep(300);
          await finalizeWorkdayMyInformation('validation-error-' + steps);
          await pjaFillWorkdayAppQuestions(profile);
          if (typeof pjaForceWorkdayTermsCheckbox === 'function') await withTimeout(pjaForceWorkdayTermsCheckbox('validation-error-' + steps), 12000, 'wd-terms-validation');
          pjaFillRequiredComboboxFallback(profile, answers);
          if (typeof pjaFillRequiredRadioFallback === 'function') pjaFillRequiredRadioFallback();
        }
        await sleep(700);
        {
          const beforeStepG = document.body.innerText.match(/current step (\d+)/i)?.[1] || '';
          const reNext = document.querySelector('[data-automation-id="pageFooterNextButton"]')
            || document.querySelector('[data-automation-id="bottomNavigationNext"]')
            || findButton(/save and continue|^continue$|^next$/i);
          if (reNext) {
            await closeWorkdayTransientMenus();
            if (!(await trustedWorkdayClick(reNext, 'validation-retry'))) reNext.click();
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
          await closeWorkdayTransientMenus();
          if (!(await trustedWorkdayClick(nextBtn, 'sid-name-retry'))) nextBtn.click();
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
          if (typeof pjaForceWorkdayTermsCheckbox === 'function') await pjaForceWorkdayTermsCheckbox('url-advance-' + steps);
          continue;
        }
        if (stepTextAfter === stepTextBefore) {
          const stuckBtns = Array.from(document.querySelectorAll('button,[data-automation-id="click_filter"]'))
            .map(b => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0,25)).filter(Boolean).slice(0,6);
          await addDbg('[ext] step ' + steps + ' stuck: stepText=' + stepTextBefore + ' url=' + location.href.slice(-40) + ' btns=' + stuckBtns.join('|'));
          const recovered = await retryWorkdayBlockedAdvance('same_step');
          if (recovered.completed) {
            await addDbg('[ext] same-step retry reached confirmation');
            sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
            await recordResult(job, { success: true, reason: 'applied' });
            navigateBack(job);
            return;
          }
          if (recovered.advanced) {
            await addDbg('[ext] same-step retry advanced; re-entering fill path');
            return runExternalApply(job, rawAnswers);
          }
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
    if (typeof pjaForcePhoneField === 'function' && !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      const pf = await pjaForcePhoneField(/workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? workdayPhoneNumberDigits(profile) : (profile.phone || job.profile?.phone || ''));
      if (pf) { await addDbg('[phone] forced via trusted typing n=' + pf); await sleep(300); }
    }
    if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      const wdp = forceWorkdayPhoneNumberCommit(profile);
      if (wdp) { await addDbg('[WD] forced phoneNumber commit n=' + wdp); await sleep(250); }
    }
    if (/greenhouse\.io/i.test(location.hostname) && typeof pjaFillGreenhouseEducation === 'function') {
      await addDbg('[gh-edu] pre-check pass');
      await withTimeout(pjaFillGreenhouseEducation(profile), 45000, 'gh-edu-precheck');
      await sleep(300);
    }
    if (/smartrecruiters\.com/i.test(location.hostname) && typeof pjaFillSmartRecruitersCustomFields === 'function') {
      await withTimeout(pjaFillSmartRecruitersCustomFields(profile), 20000, 'sr-custom-precheck');
      await sleep(250);
    }
    await withTimeout(repairAshbyRequiredFields('precheck'), 12000, 'ashby-repair-precheck');
    const srEmptyPrecheck = await recoverSmartRecruitersEmptyStep('precheck');
    if (srEmptyPrecheck === 'rerun') return runExternalApply(job, rawAnswers);
    if (srEmptyPrecheck === 'empty') {
      const help = await maybeRequestApplyHelp('no_submit_after_spa', {
        visibleErrors: [],
        missingRequired: ['smartrecruiters_empty_step'],
        formSummary: 'SmartRecruiters advanced but no application controls hydrated',
      });
      const recoveryKey = 'pja_recovery_sr_empty_' + (job.id || job.jobId || job.applyUrl || '') + '_precheck';
      if (!sessionStorage.getItem(recoveryKey)) {
        sessionStorage.setItem(recoveryKey, '1');
        const recovery = await executeRecoveryActions(help, 'no_submit_after_spa');
        if (recovery.executed) {
          await sleep(1200);
          if (visibleApplicationControls().length) {
            await addDbg('[recover] sr empty SPA recovered controls; re-entering submit path');
            return runExternalApply(job, rawAnswers);
          }
        }
      }
      sessionStorage.setItem('pja_last_action', 'recordResult:no_submit_after_spa:' + job.company);
      await recordResult(job, { success: false, reason: 'no_submit_after_spa', fields: ['smartrecruiters_empty_step'] });
      navigateBack(job);
      return;
    }
    // Force-commit all required policy react-selects (sponsorship/work-auth/onsite/ack) via the
    // proven fiber bridge — the collect→answer flow intermittently missed them, failing submit.
    if (typeof pjaForceAllPolicyReactSelects === 'function') {
      try { const pn = await pjaForceAllPolicyReactSelects(profile); if (pn) { await addDbg('[policy-rs] committed n=' + pn); await sleep(300); } } catch (_) {}
    }
    let missing = findMissingRequired();
    let hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
    // Always run the answerer: findMissingRequired only sees [required]/aria-required, so it
    // MISSES Greenhouse react-select custom questions (e.g. the Export Control acknowledgment)
    // that are required by an asterisk in the label only. collectRequiredEmptyFields' asterisk
    // scan catches those, and the answerer early-returns when nothing is empty — so this is
    // safe for ATSes that had nothing missing. Without it, those questions block submit silently.
    {
      // Bounded: the post-fill answerer makes dev-server round-trips; unwrapped it could hang the
      // whole job (observed on the embedded-iframe path) until the SW watchdog force-advanced it.
      await withTimeout(pjaAnswerRequiredViaAI(job), 120000, 'answerer-postfill');
      await sleep(600);
      if (typeof pjaForceCountryField === "function") {
        try { await withTimeout(pjaForceCountryField((job.profile && job.profile.country) || 'United States'), 8000, 'country-postfill'); } catch (_) {}
      }
      if (typeof pjaForcePhoneField === 'function' && !/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        try { await withTimeout(pjaForcePhoneField(/workday\.com|myworkdayjobs\.com/i.test(location.hostname) ? workdayPhoneNumberDigits(profile) : (profile.phone || job.profile?.phone || '')), 8000, 'phone-postfill'); } catch (_) {}
      }
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        const wdp = forceWorkdayPhoneNumberCommit(profile);
        if (wdp) { await addDbg('[WD] postfill phoneNumber commit n=' + wdp); await sleep(250); }
      }
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        try { await withTimeout(forceWorkdayPhoneCountryCode(), 15000, 'wd-phone-code-postfill'); } catch (_) {}
        try { await withTimeout(forceWorkdayReferralSource(), 15000, 'wd-referral-source-postfill'); } catch (_) {}
        try { await finalizeWorkdayMyInformation('postfill'); } catch (_) {}
      }
      if (typeof pjaForceAllPolicyReactSelects === 'function') {
        try { const pn = await withTimeout(pjaForceAllPolicyReactSelects(profile), 30000, 'policy-postfill'); if (pn) await addDbg('[policy-rs] post-AI committed n=' + pn); } catch (_) {}
      }
      missing = findMissingRequired();
      hardMissing = missing.filter(m => m.type !== 'wd_selectinput');
    }
    if (hardMissing.length) {
      const missingLabels = hardMissing.map(m => m.label);
      if (isSmartRecruitersHost && missingLabels.length === 1 && missingLabels[0] === '*') {
        const srEmptyMissing = await recoverSmartRecruitersEmptyStep('missing-required-sentinel');
        if (srEmptyMissing === 'rerun') return runExternalApply(job, rawAnswers);
        const help = await maybeRequestApplyHelp('no_submit_after_spa', {
          visibleErrors: [],
          missingRequired: ['smartrecruiters_required_sentinel_no_controls'],
          formSummary: 'SmartRecruiters required-field sentinel appeared with zero visible application controls',
        });
        const recoveryKey = 'pja_recovery_sr_empty_' + (job.id || job.jobId || job.applyUrl || '') + '_sentinel';
        if (!sessionStorage.getItem(recoveryKey)) {
          sessionStorage.setItem(recoveryKey, '1');
          const recovery = await executeRecoveryActions(help, 'no_submit_after_spa');
          if (recovery.executed) {
            await sleep(1200);
            if (visibleApplicationControls().length) {
              await addDbg('[recover] sr sentinel recovered controls; re-entering submit path');
              return runExternalApply(job, rawAnswers);
            }
          }
        }
        sessionStorage.setItem('pja_last_action', 'recordResult:no_submit_after_spa:' + job.company);
        await recordResult(job, { success: false, reason: 'no_submit_after_spa', fields: ['smartrecruiters_required_sentinel_no_controls'] });
        navigateBack(job);
        return;
      }
      const emailVerification = missingLabels.some(label =>
        /verification code|code (?:was )?sent|sent to .*@|enter (?:the )?(?:8|six|6)?[- ]?(?:character )?code|email.*verify|verify.*email/i.test(label)
      ) || /verification code (?:was )?sent|enter (?:the )?(?:8|six|6)?[- ]?(?:character )?code|verify your email/i.test(document.body?.innerText || '');
      if (emailVerification) {
        const bodyText = document.body?.innerText || '';
        const realCaptchaWidget = !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], [class*="captcha" i]') ||
          /protected by\s+reCAPTCHA|verify you are human/i.test(bodyText);
        const emailCodeGate = /security code|verification code|code (?:was )?sent|sent to .*@|enter (?:the )?(?:8|six|6)?[- ]?(?:character )?code|confirm you'?re a human/i.test(bodyText);
        if (realCaptchaWidget && !emailCodeGate) {
          console.log('PJA ext-apply: captcha/human verification, fields:', missingLabels.join('; '));
          sessionStorage.setItem('pja_last_action', 'recordResult:captcha:' + job.company);
          await maybeRequestApplyHelp('captcha', {
            missingRequired: missingLabels,
            formSummary: 'reCAPTCHA/human challenge blocked submission',
          });
          await recordResult(job, { success: false, reason: 'captcha', fields: missingLabels });
          navigateBack(job);
          return;
        }
        console.log('PJA ext-apply: email_verification_required, fields:', missingLabels.join('; '));
        sessionStorage.setItem('pja_last_action', 'recoverEmailCode:' + job.company);
        const help = await maybeRequestApplyHelp('email_verification_required', {
          missingRequired: missingLabels,
          formSummary: 'external email security-code verification required before final submission',
        });
        const recovery = await recoverEmailVerificationCode('email_verification_required');
        if (recovery.filled) {
          const btn = findEmailCodeActionButton();
          if (btn) {
            await addDbg('[email-code] retrying verification/submit after gmail code');
            let clickedAfterCode = false;
            try {
              clickedAfterCode = await Promise.race([
                (async () => { await pjaCdpClickEl(btn); return true; })(),
                new Promise(resolve => setTimeout(() => resolve(false), 8000))
              ]);
            } catch (_) {}
            if (!clickedAfterCode) {
              await addDbg('[email-code] cdp verify after code timed out; using DOM click fallback');
              try { btn.click(); clickedAfterCode = true; } catch (_) {}
            }
            const outcome = await waitForEmailCodeRecoveryOutcome(job._preSubmitUrl || job.applyUrl || '', 'pre_submit_code_gate', clickedAfterCode);
            if (outcome.success) {
              sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
              await recordResult(job, { success: true, reason: 'applied' });
              navigateBack(job);
              return;
            }
          }
        }
        if (help && help.shouldAdvance === false) await addDbg('[email-code] dev-server advised not to advance without code');
        sessionStorage.setItem('pja_last_action', 'recordResult:email_verification_required:' + job.company);
        await recordResult(job, { success: false, reason: 'email_verification_required', fields: missingLabels,
          diagnostic: collectPostClickPageSnapshot() });
        navigateBack(job);
        return;
      }
      console.log('PJA ext-apply: missing_required, fields:', hardMissing.map(m => m.label).join('; '));
      sessionStorage.setItem('pja_last_action', 'recordResult:missing_required:' + job.company);
      const recoveryKey = 'pja_recovery_missing_' + (job.id || job.jobId || job.applyUrl || '');
      if (!sessionStorage.getItem(recoveryKey)) {
        sessionStorage.setItem(recoveryKey, '1');
        const recovery = await runApplyRecoveryLoop('missing_required', {
          missingRequired: missingLabels,
          formSummary: 'required fields still missing after fill',
        }, {
          verify: async () => {
            const afterRecovery = findMissingRequired().filter(m => m.type !== 'wd_selectinput');
            return !afterRecovery.length;
          }
        });
        if (recovery.advanceReason) {
          await addDbg('[recover] terminal advance after missing_required: ' + recovery.advanceReason);
          await saveMissingQuestions(hardMissing, job);
          await recordResult(job, { success: false, reason: recovery.advanceReason, fields: missingLabels });
          navigateBack(job);
          return;
        }
        if (recovery.recovered) {
          await addDbg('[recover] missing_required cleared by loop; re-entering submit path');
          return runExternalApply(job, rawAnswers);
        }
        const afterRecovery = findMissingRequired().filter(m => m.type !== 'wd_selectinput');
        await addDbg('[recover] missing_required remains after loop: ' + afterRecovery.map(m => m.label).join('|').slice(0, 100));
      }
      await saveMissingQuestions(hardMissing, job);
      await recordResult(job, { success: false, reason: 'missing_required', fields: missingLabels });
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
        const recovered = await retryWorkdayBlockedAdvance(stuckOnWdSelectinput === 'resume' ? 'resume' : 'terminal_selectinput');
        if (recovered.completed) {
          await addDbg('[ext] terminal stuck retry reached confirmation');
          sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
          await recordResult(job, { success: true, reason: 'applied' });
          navigateBack(job);
          return;
        }
        if (recovered.advanced) {
          await addDbg('[ext] terminal stuck retry advanced; re-entering fill path');
          return runExternalApply(job, rawAnswers);
        }
        const wdFields = missing.map(m => m.label);
        const isResume = stuckOnWdSelectinput === 'resume';
        const isDuplicateRecord = stuckOnWdSelectinput === 'workday_duplicate_record' || hasWorkdayDuplicateRecordError();
        const reason = isResume ? 'missing_resume'
          : isDuplicateRecord ? 'workday_duplicate_record'
          : stuckOnWdSelectinput === 'smartrecruiters' ? 'missing_required'
          : 'wd_selectinput_blocked';
        const fields = isResume ? ['resume_required']
          : isDuplicateRecord ? ['workday_duplicate_previous_worker_or_address']
          : wdFields.length ? wdFields
          : stuckOnWdSelectinput === 'smartrecruiters' ? ['smartrecruiters_blocked_advance']
          : ['unknown_wd_fields'];
        console.log('PJA ext-apply: WD blocked form advance reason=' + reason, 'fields:', fields.join('; '));
        sessionStorage.setItem('pja_last_action', 'recordResult:' + reason + ':' + job.company);
        await maybeRequestApplyHelp(reason, {
          missingRequired: fields,
          formSummary: stuckOnWdSelectinput === 'smartrecruiters'
            ? 'SmartRecruiters required controls blocked step advance'
            : isDuplicateRecord
              ? 'Workday duplicate Previous Worker or Address draft record blocked step advance'
            : 'workday selectinput or resume gate blocked advance',
        });
        if (missing.length) await saveMissingQuestions(missing, job);
        await recordResult(job, { success: false, reason, fields });
        navigateBack(job);
        return;
      }
    }

    // If the step-loop already clicked the final Submit (on Workday the review-page Submit
    // IS the pageFooterNextButton), we're now on the confirmation page → record as applied.
    {
      const alreadySubmitted = pjaIsSubmitSuccess({
        text: document.body?.innerText || '',
        title: document.title,
        url: location.href,
        preSubmitUrl: job._preSubmitUrl || job.applyUrl || '',
        hasSubmitButton: !!document.querySelector('[data-automation-id="bottomNavigationSubmit"]') ||
          !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i),
        hasFormFields: pjaQueryAllExt('form input, form select, form textarea')
          .some(el => el.type !== 'hidden'),
      });
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
      const allBtns = pjaQueryAllExt('button, input[type=submit], [role=button], [data-automation-id="click_filter"]')
        .map(b => (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().slice(0,40))
        .filter(Boolean);
      const isSuccessFactors = /successfactors\.com|talentcommunity/i.test(location.hostname + location.pathname + location.href);
      const sfRetryKey = 'pja_sf_start_' + (job.id || job.jobId || job.applyUrl || '');
      if (isSuccessFactors && sessionStorage.getItem(sfRetryKey) !== '1') {
        sessionStorage.setItem(sfRetryKey, '1');
        const sfResp = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({ type: 'SUCCESSFACTORS_START' }, r => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || {})));
          } catch (e) { resolve({ ok: false, error: e.message }); }
        });
        await addDbg('[SF] start handler ok=' + !!sfResp.ok + (sfResp.error ? ' err=' + String(sfResp.error).slice(0, 60) : ''));
        await sleep(5000);
        return runExternalApply(job, rawAnswers);
      }
      const sfLandingWithoutForm = isSuccessFactors && (
        /\/(?:search|talentcommunity)(?:\/|$)|\/$/i.test(location.pathname || '/') ||
        /talent community|search by keyword|job search|candidate profile/i.test(document.body?.innerText || '')
      ) && !pjaQueryAllExt('input[required], textarea[required], select[required], [aria-required="true"]').length;
      if (sfLandingWithoutForm) {
        await addDbg('[SF] no application form after start handler; classifying no_apply_path url=' + location.pathname.slice(0, 60));
        await maybeRequestApplyHelp('no_apply_btn_on_description', {
          visibleErrors: allBtns,
          formSummary: 'successfactors/talentcommunity landing page without application form',
        });
        sessionStorage.setItem('pja_last_action', 'recordResult:no_apply_path:' + job.company);
        await recordResult(job, { success: false, reason: 'no_apply_path' });
        navigateBack(job);
        return;
      }
      const isWorkdayNoSubmit = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
      const wdVisibleInputCount = isWorkdayNoSubmit ? pjaQueryAllExt('input, textarea, select').filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length : 0;
      const wdAuthGateVisible = isWorkdayNoSubmit && (
        !!document.querySelector('[data-automation-id="createAccountLink"], [data-automation-id="signInLink"], [data-automation-id="utilityButtonSignIn"], input[type=password], input[data-automation-id="email"], input[type=email]') ||
        /sign.?in with email|continue with email|create.{0,10}account|candidate home|sign.?in to|log.?in to/i.test(document.body?.innerText || '')
      );
      const wdNoSubmitAuthRetryKey = 'pja_wd_nosubmit_auth_retry_' + (job.id || job.jobId || job.applyUrl || '');
      if (isWorkdayNoSubmit && wdAuthGateVisible && sessionStorage.getItem(wdNoSubmitAuthRetryKey) !== '1') {
        sessionStorage.setItem(wdNoSubmitAuthRetryKey, '1');
        await addDbg('[WD] no_submit auth-gate recovery inputs=' + wdVisibleInputCount + ' url=' + location.pathname.slice(-45));
        if (typeof window.pjaWorkdayAuth !== 'undefined') {
          const { pja_job_password: _storedPw2 } = await new Promise(r => chrome.storage.local.get('pja_job_password', r));
          const authResult2 = await window.pjaWorkdayAuth.run(profile, _storedPw2 || 'ChangeMe#2025!');
          await addDbg('[WD] no_submit auth-gate recovery result=' + authResult2);
          if (authResult2 === 'needs_gmail_verify') {
            await new Promise(r => chrome.storage.local.set({
              pja_wd_pending_apply: { applyUrl: job.applyUrl, jobId: job.id, hostname: location.hostname, ts: Date.now() }
            }, r));
            return;
          }
          if (authResult2 === 'signed_in' || authResult2 === 'account_created_verified') {
            await sleep(2500);
            return runExternalApply(job, rawAnswers);
          }
          if (authResult2 === 'captcha_blocked') {
            await maybeRequestApplyHelp('workday_captcha', { formSummary: 'workday auth captcha from no-submit recovery', visibleErrors: allBtns });
            sessionStorage.setItem('pja_last_action', 'recordResult:workday_captcha:' + job.company);
            await recordResult(job, { success: false, reason: 'workday_captcha' });
            navigateBack(job);
            return;
          }
          if (authResult2 === 'locked') {
            await maybeRequestApplyHelp('workday_auth_sign_in_error', { formSummary: 'workday auth lock from no-submit recovery', visibleErrors: allBtns });
            sessionStorage.setItem('pja_last_action', 'recordResult:workday_account_locked:' + job.company);
            await recordResult(job, { success: false, reason: 'workday_account_locked' });
            navigateBack(job);
            return;
          }
          if (authResult2 === 'create_rejected_no_visible_error' || authResult2 === 'account_exists_wrong_password') {
            const mappedReason2 = authResult2 === 'account_exists_wrong_password'
              ? 'workday_account_exists_wrong_password'
              : 'workday_create_rejected_no_visible_error';
            await maybeRequestApplyHelp(mappedReason2, { formSummary: 'workday auth create/sign-in failed from no-submit recovery', visibleErrors: allBtns });
            sessionStorage.setItem('pja_last_action', 'recordResult:' + mappedReason2 + ':' + job.company);
            await recordResult(job, { success: false, reason: mappedReason2 });
            navigateBack(job);
            return;
          }
        }
      }
      console.log('PJA ext-apply: no_submit_btn. All buttons:', allBtns.join(' | '));
      await new Promise(r => chrome.storage.local.set({ pja_dbg_nosubmit: { url: location.href.slice(0,120), btns: allBtns.slice(0,15), ts: Date.now() } }, r));
      await maybeRequestApplyHelp('no_submit_btn', {
        visibleErrors: allBtns,
        formSummary: 'submit button absent',
      });
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

    await withTimeout(repairAshbyRequiredFields('pre-submit'), 12000, 'ashby-repair-pre-submit');

    // Persist a PENDING submit before the click so a navigation can be recovered. Pending is
    // deliberately distinct from handled/applied: the destination page must still prove success.
    const preSubmitUrl = location.href;
    job._submitPending = true;
    job._preSubmitUrl = preSubmitUrl;
    job._submitStartedAt = Date.now();
    try { await new Promise(r => chrome.storage.local.set({ pja_ext_current: job }, r)); } catch(_) {}
    // Optimistic durable-log pre-write: we've passed validation + found the submit button, so
    // record 'submitting' BEFORE the click. If the submit navigates away and kills this script
    // (the Greenhouse under-count case), the entry already exists; the post-submit success path
    // and the resume path both upgrade it to 'applied'. Idempotent, so no duplicate.
    try { await pjaWriteAppliedLog(job, { status: 'submitting', reason: 'submit_clicked' }); } catch(_) {}
    try {
      chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', event: {
        runId: job.runId || null, jobId: job.jobId || job.id || null,
        applyUrl: job.applyUrl || location.href, company: job.company, title: job.title,
        channel: job.channel || job.ats || 'external', status: 'submitting',
        reason: 'submit_clicked', applicationAt: job._submitStartedAt, occurredAt: Date.now()
      } }, () => void chrome.runtime.lastError);
    } catch (_) {}

    console.log('PJA ext-apply: clicking submit:', submitBtn.textContent.trim().slice(0,40));
    sessionStorage.setItem('pja_last_action', 'submit_clicked:' + job.company);
    let workdaySubmitDelivery = '';
    if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
      const clicked = await Promise.race([
        trustedWorkdayClick(submitBtn, 'submit'),
        sleep(10000).then(async () => { await addDbg('[WD] trusted click submit TIMEOUT 10000ms'); return false; })
      ]);
      workdaySubmitDelivery = clicked ? 'trusted' : 'transport_failed';
      if (!clicked) {
        try {
          submitBtn.click();
          workdaySubmitDelivery = 'dom_fallback';
        } catch (_) {}
      }
    } else if (/greenhouse\.io|ashbyhq\.com/i.test(location.hostname)) {
      // Several Remix tenants accept synthetic field events but reject a synthetic final click:
      // the page simply reloads with zero validation errors and no confirmation. Deliver the final
      // action through CDP so event.isTrusted is true, as we already do for Remix option commits.
      submitBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const sr = submitBtn.getBoundingClientRect();
      const submitDelivery = await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, 5000);
        try {
          chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 }, resp => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(chrome.runtime.lastError || resp?.error ? 'failed' : 'cdp');
          });
        } catch (_) { if (!done) { done = true; clearTimeout(timer); resolve('failed'); } }
      });
      await addDbg('[submit] ' + (/ashbyhq\.com/i.test(location.hostname) ? 'ashby' : 'greenhouse') + ' delivery=' + submitDelivery);
      if (submitDelivery === 'failed') submitBtn.click();
    } else {
      submitBtn.click();
    }

    // Poll every 400ms for up to 8s. Capture success the moment it appears —
    // Greenhouse SPA shows a brief confirmation then navigates away, so a
    // single check after N seconds misses it. URL changes and form disappearance are observed,
    // but the strict detector still requires explicit confirmation text or a confirmation route.
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
    // Greenhouse and similar ATSes can leave the form visible after the submit click when a
    // reCAPTCHA challenge is required. Do not label that ambiguous state as submit_unclear:
    // explicitly classify it so the queue skips the job and advances without retrying or
    // implying that an application may have been sent.
    const visibleValidationErrors = () => {
      try {
        return pjaQueryAllExt('[aria-invalid="true"], [class*="error"]:not([class*="error-"]), [role="alert"], .field--error, [class*="invalid"]')
          .filter(el => {
            try {
              const r = el.getBoundingClientRect();
              if (!(r.width > 0 && r.height > 0)) return false;
              const txt = (el.textContent || el.getAttribute('aria-label') || el.id || '').replace(/\s+/g, ' ').trim();
              if (!txt) return false;
              if (/cookie settings|powered by|privacy policy/i.test(txt)) return false;
              return true;
            } catch(_) {
              return false;
            }
          });
      } catch (_) {
        return [];
      }
    };
    if (!success) {
      const errElsBeforeCaptcha = visibleValidationErrors();
      const explicitMissingErrors = errElsBeforeCaptcha.some(el => /missing entry|required field|field.*required|value is required|needs corrections|please provide|select.+required/i.test(el.textContent || el.getAttribute('aria-label') || ''));
      const postSubmitText = document.body?.innerText || '';
      const postSubmitEmailCodeGate = /security code|verification code|code (?:was )?sent|sent to .*@|enter (?:the )?(?:8|six|6)?[- ]?(?:character )?code|confirm you'?re a human/i.test(postSubmitText) && findEmailCodeField();
      if (postSubmitEmailCodeGate && !explicitMissingErrors) {
        await addDbg('[submit-fail] email verification code gate detected after submit');
        const help = await maybeRequestApplyHelp('email_verification_required', {
          formSummary: 'email security-code verification required after submit click',
        });
        const recovery = await recoverEmailVerificationCode('post_submit_email_code');
        if (recovery.filled) {
          const btn = findEmailCodeActionButton();
          if (btn) {
            await addDbg('[email-code] retrying verification/submit once after post-submit code');
            let clickedAfterCode = false;
            try {
              clickedAfterCode = await Promise.race([
                (async () => { await pjaCdpClickEl(btn); return true; })(),
                new Promise(resolve => setTimeout(() => resolve(false), 8000))
              ]);
            } catch (_) {}
            if (!clickedAfterCode) {
              await addDbg('[email-code] cdp submit after code timed out; using DOM click fallback');
              try { btn.click(); clickedAfterCode = true; } catch (_) {}
            }
            const outcome = await waitForEmailCodeRecoveryOutcome(preSubmitUrl, 'post_submit_code_gate', clickedAfterCode);
            if (outcome.success) {
              sessionStorage.setItem('pja_last_action', 'recordResult:applied:' + job.company);
              await recordResult(job, { success: true, reason: 'applied' });
              navigateBack(job);
              return;
            }
          }
        }
        if (help && help.shouldAdvance === false) await addDbg('[email-code] recovery incomplete; recording email_verification_required');
        sessionStorage.setItem('pja_last_action', 'recordResult:email_verification_required:' + job.company);
        await recordResult(job, { success: false, reason: 'email_verification_required',
          diagnostic: collectPostClickPageSnapshot() });
        navigateBack(job);
        return;
      }
      const captchaWidgetVisible = pjaQueryAllExt('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], [class*="captcha" i]')
        .some(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return true; } })
        || /protected by\s+reCAPTCHA|verify you are human/i.test(postSubmitText);
      if (captchaWidgetVisible && !explicitMissingErrors) {
        await addDbg('[submit-fail] captcha detected after submit click; deferring');
        sessionStorage.setItem('pja_last_action', 'recordResult:captcha:' + job.company);
        await maybeRequestApplyHelp('captcha', { formSummary: 'captcha visible after submit' });
        await recordResult(job, { success: false, reason: 'captcha' });
        navigateBack(job);
        return;
      }
      const isWorkdayPostSubmit = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
      if (isWorkdayPostSubmit && window.PJAWorkdayEngine?.classifySubmissionObservation) {
        const accountBlocker = /account (?:is )?(?:locked|disabled)|too many unsuccessful|sign.?in attempts exceeded/i.test(postSubmitText);
        const observation = window.PJAWorkdayEngine.classifySubmissionObservation({
          pathname: location.pathname,
          text: postSubmitText,
          duplicateRecord: hasWorkdayDuplicateRecordError(),
          validationError: errElsBeforeCaptcha.length > 0,
          accountBlocker,
          captcha: captchaWidgetVisible,
          transportError: workdaySubmitDelivery === 'transport_failed',
          submitAttempted: workdaySubmitDelivery !== 'transport_failed',
          hasSubmitButton: !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i),
          hasFormFields: pjaQueryAllExt('form input, form select, form textarea').some(el => el.type !== 'hidden'),
        });
        if (observation.kind === 'duplicate_record' || observation.kind === 'account_blocker' ||
            observation.kind === 'transport_failure' || observation.kind === 'submitted_unverified') {
          await addDbg('[WD] post-submit observation=' + observation.kind + ' reason=' + observation.reason +
            ' delivery=' + (workdaySubmitDelivery || 'unknown'));
          await capturePostClickDiagnostic(observation.reason, {
            workdayObservation: observation.kind,
            submitDelivery: workdaySubmitDelivery || 'unknown',
          });
          sessionStorage.setItem('pja_last_action', 'recordResult:' + observation.reason + ':' + job.company);
          await recordResult(job, { success: false, reason: observation.reason,
            fields: ['workday_observation:' + observation.kind] });
          navigateBack(job);
          return;
        }
        // Only explicit validation evidence makes a Workday correction/re-submit safe. All
        // ambiguous submit attempts returned above as submitted/unverified.
        await addDbg('[WD] post-submit observation=' + observation.kind + ' retrySafe=' + observation.retrySafe);
      }
    }
    // DIAGNOSTIC: on submit_unclear, dump Greenhouse/ATS validation errors so we can see WHICH
    // field blocked the submit (the form stays up with error text / aria-invalid on the culprit).
    let reactSelectError = false;
    if (!success) {
      try {
        const errEls = visibleValidationErrors();
        // A react-select-commit failure (degraded-CDP signature) = the blocking fields are
        // country/state/education/location/question comboboxes, or an errored select__control.
        reactSelectError = errEls.some(el => /country|\bstate\b|school|degree|discipline|location|question_|select__control/i.test(
          (el.getAttribute('aria-label') || el.id || el.className || '') + ' ' + (el.closest('[class*="field"]')?.querySelector('label')?.textContent || '')))
          || pjaQueryAllExt('[class*="select__control--error"],[class*="select__control--is-invalid"]').length > 0;
        const errs = errEls.slice(0, 8).map(el => {
          const lbl = (el.getAttribute('aria-label') || el.id || el.name || (el.closest('[class*="field"]')?.querySelector('label')?.textContent) || el.textContent || '').trim().replace(/\s+/g,' ').slice(0, 40);
          return lbl;
        }).filter(Boolean);
        await addDbg('[submit-fail] errs(' + errEls.length + '): ' + errs.join(' | ') + ' | pathHint=' + location.pathname.slice(-24));
        const isWorkdayHost = /workday\.com|myworkdayjobs\.com/i.test(location.hostname);
        const explicitRequiredError = errEls.some(el => /missing entry|required field|field.*required|value is required|needs corrections|please provide|select.+required/i.test(el.textContent || el.getAttribute('aria-label') || ''));
        if (/ashbyhq\.com/i.test(location.hostname) && explicitRequiredError) {
          const ashbyRepaired = await withTimeout(repairAshbyRequiredFields('post-submit:' + errs.join('|').slice(0, 80)), 12000, 'ashby-repair-post-submit');
          if (ashbyRepaired) {
            const submitAgainAshby = findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
            if (submitAgainAshby) {
              await addDbg('[ashby-repair] retrying submit once after required-field repair n=' + ashbyRepaired);
              try {
                submitAgainAshby.scrollIntoView({ block: 'center', behavior: 'instant' });
                const ar = submitAgainAshby.getBoundingClientRect();
                const deliveredAshby = await new Promise(resolve => {
                  try { chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x: ar.left + ar.width / 2, y: ar.top + ar.height / 2 }, resp => resolve(!(chrome.runtime.lastError || resp?.error))); }
                  catch (_) { resolve(false); }
                });
                if (!deliveredAshby) submitAgainAshby.click();
              } catch (_) { try { submitAgainAshby.click(); } catch (_) {} }
              await sleep(4500);
              success = pjaIsSubmitSuccess({
                text: document.body?.innerText || '',
                title: document.title,
                url: location.href,
                preSubmitUrl,
                hasSubmitButton: !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i),
                hasFormFields: pjaQueryAllExt('form input, form select, form textarea').some(el => el.type !== 'hidden'),
              });
              if (success) {
                await addDbg('[ashby-repair] retry submit confirmed success');
                await recordResult(job, { success: true, reason: 'applied' });
                navigateBack(job);
                return;
              }
            }
          }
        }
        const terminalHelpReason = reactSelectError && isWorkdayHost ? 'wd_selectinput_blocked' : explicitRequiredError ? 'missing_required' : 'submit_unclear';
        const recoveryKey = 'pja_recovery_submit_' + (job.id || job.jobId || job.applyUrl || '');
        if (!success && !sessionStorage.getItem(recoveryKey)) {
          sessionStorage.setItem(recoveryKey, '1');
          const recovery = await runApplyRecoveryLoop(terminalHelpReason, {
            visibleErrors: errs,
            formSummary: 'post-submit validation errors on ' + location.hostname,
          }, {
            verify: async () => pjaIsSubmitSuccess({
              text: document.body?.innerText || '',
              title: document.title,
              url: location.href,
              preSubmitUrl,
              hasSubmitButton: !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i),
              hasFormFields: pjaQueryAllExt('form input, form select, form textarea').some(el => el.type !== 'hidden'),
            })
          });
          if (recovery.advanceReason) {
            await addDbg('[recover] terminal advance after ' + terminalHelpReason + ': ' + recovery.advanceReason);
            await recordResult(job, { success: false, reason: recovery.advanceReason, fields: errs });
            navigateBack(job);
            return;
          }
          if (recovery.recovered) {
            await addDbg('[recover] loop confirmed success after ' + terminalHelpReason);
            await recordResult(job, { success: true, reason: 'applied' });
            navigateBack(job);
            return;
          }
          if (recovery.executed || recovery.retrySubmit) {
            await sleep(900);
            const submitAgain = findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i);
            if (submitAgain && (recovery.retrySubmit || recovery.executed)) {
              await addDbg('[recover] retrying submit once after LLM recovery');
              try {
                submitAgain.scrollIntoView({ block: 'center', behavior: 'instant' });
                const rr = submitAgain.getBoundingClientRect();
                const delivered = await new Promise(resolve => {
                  try { chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 }, resp => resolve(!(chrome.runtime.lastError || resp?.error))); }
                  catch (_) { resolve(false); }
                });
                if (!delivered) submitAgain.click();
              } catch (_) { try { submitAgain.click(); } catch (_) {} }
              await sleep(4500);
              const postRetrySuccess = pjaIsSubmitSuccess({
                text: document.body?.innerText || '',
                title: document.title,
                url: location.href,
                preSubmitUrl,
                hasSubmitButton: !!findButton(/submit.*application|submit.*app|apply now|send application|complete application|^submit$|^submit application$/i),
                hasFormFields: pjaQueryAllExt('form input, form select, form textarea').some(el => el.type !== 'hidden'),
              });
              if (postRetrySuccess) {
                await addDbg('[recover] retry submit confirmed success');
                await recordResult(job, { success: true, reason: 'applied' });
                navigateBack(job);
                return;
              }
            }
          }
        }
        // Keep a non-rolling failure ledger. pja_dbg is intentionally tiny and the next job's fill
        // logs overwrite the useful validation evidence before a batch monitor can read it.
        try {
          await new Promise(r => chrome.storage.local.get('pja_submit_failures', d => {
            const failures = (Array.isArray(d.pja_submit_failures) ? d.pja_submit_failures : []).slice(-99);
            failures.push({ ts: Date.now(), runId: job.runId || '', jobId: job.id || job.jobId || '',
              company: job.company || '', title: job.title || '', url: location.href.slice(0, 180),
              errors: errs, reactSelectError });
            chrome.storage.local.set({ pja_submit_failures: failures }, r);
          }));
        } catch (_) {}
        // Dump the ACTUAL element structure of the country + phone widgets so we know what they
        // really are (react-select vs native <select> vs custom) instead of guessing at the fix.
        const describe = (kw) => {
          const wrap = pjaQueryAllExt('[class*="field"], [class*="Field"], fieldset, div')
            .find(el => { const lb = el.querySelector('label'); return lb && new RegExp('^\\s*' + kw, 'i').test(lb.textContent || ''); });
          if (!wrap) return kw + ': <no wrap>';
          const inp = wrap.querySelector('input,select,textarea,[role="combobox"],[role="listbox"]');
          const desc = inp ? (inp.tagName.toLowerCase() + '[type=' + (inp.type||'') + '][role=' + (inp.getAttribute('role')||'') + '] id=' + (inp.id||'') + ' name=' + (inp.name||'')) : '<no input>';
          const cls = (wrap.querySelector('[class*="select__control"],[class*="iti"],[class*="Phone"],[class*="control"]')?.className || wrap.className || '').slice(0, 60);
          return kw + ': ' + desc + ' | ctrlCls=' + cls;
        };
        await addDbg('[field-struct] ' + describe('Country'));
        await addDbg('[field-struct] ' + describe('Phone'));
      } catch(_) {}
    }
    sessionStorage.setItem('pja_last_action', 'recordResult:submit:' + (success ? 'applied' : 'unclear') + ':' + job.company);
    // P1c: report the outcome so background's self-heal ladder can detect degraded CDP
    // (K consecutive fill-but-no-submit-with-react-select-error) and escalate recovery.
    try { chrome.runtime.sendMessage({ type: 'PJA_APPLY_OUTCOME', outcome: { filled: true, submitted: !!success, reactSelectError }, applyUrl: job.applyUrl }); } catch (_) {}
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
    const hasUsefulTextValue = (el) => {
      const v = String(el?.value || '').trim();
      return !!v && !/^(mm|m{1,2}|dd|d{1,2}|yyyy|yy)$/i.test(v);
    };
    const setText = (el, val) => {
      if (!el || !val || hasUsefulTextValue(el)) return false;
      if (typeof pjaFillTextViaFiber === 'function') { try { pjaFillTextViaFiber(el, val); return true; } catch (_) {} }
      if (typeof pjaSetNative === 'function') { pjaSetNative(el, val); return true; }
      el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    };
    const loc = profile.currentLocation || ((profile.city && profile.state) ? profile.city + ', ' + profile.state : '');
    const hasWorkExperienceSection = Array.from(qAll('[data-automation-id]')).some(el =>
      /^workExperience-/i.test(el.getAttribute('data-automation-id') || '')
    ) || /\bWork Experience\b/i.test(document.body?.innerText || '');

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

    // From-date (and To-date if not "currently work here"): Workday renders MM + DD + YYYY
    // spinbutton inputs (dateSectionMonth-input / dateSectionDay-input / dateSectionYear-input).
    // Fill the first set = "From" date with the current job's start. Workday may expose
    // placeholders ("MM", "DD", "YYYY") as .value, so setText treats those as empty.
    if (hasWorkExperienceSection) {
      const startMonth = profile.currentStartMonth || '09';
      const startDay = profile.currentStartDay || '01';
      const startYear  = profile.currentStartYear  || '2024';
      const monthInputs = Array.from(qAll('input[data-automation-id="dateSectionMonth-input"]'));
      const dayInputs = Array.from(qAll('input[data-automation-id="dateSectionDay-input"]'));
      const yearInputs  = Array.from(qAll('input[data-automation-id="dateSectionYear-input"]'));
      if (monthInputs[0]) { if (setText(monthInputs[0], startMonth)) filled++; }
      if (dayInputs[0]) { if (setText(dayInputs[0], startDay)) filled++; }
      if (yearInputs[0])  { if (setText(yearInputs[0],  startYear))  filled++; }
    }

    if (filled) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19); arr.push('[WD] workExperience filled=' + filled); chrome.storage.local.set({ pja_dbg: arr }, r);
      }));
    }
    return filled;
  }

  async function pjaFillWorkdaySelfIdentifyDate(profile) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
    const pageTxt = document.body?.innerText || '';
    if (!/self identify|self-identif|disability|public burden statement|omb control number/i.test(pageTxt)) return 0;
    const qAll = (sel) => (typeof pjaQueryAll === 'function' ? pjaQueryAll(sel) : Array.from(document.querySelectorAll(sel)));
    const monthInputs = Array.from(qAll('input[data-automation-id="dateSectionMonth-input"]'));
    const dayInputs = Array.from(qAll('input[data-automation-id="dateSectionDay-input"]'));
    const yearInputs = Array.from(qAll('input[data-automation-id="dateSectionYear-input"]'));
    if (!monthInputs[0] && !dayInputs[0] && !yearInputs[0]) return 0;
    // Always sign Workday self-identification forms with today's date. Reusing a
    // profile-stored signature date can look visibly filled but fail tenant validation.
    const now = new Date();
    const mm = String(now.getMonth() + 1);
    const dd = String(now.getDate());
    const yyyy = String(now.getFullYear());
    const setTextForce = (el, val) => {
      if (!el || !val) return false;
      if (String(el.value || '').trim() === String(val) && el.getAttribute('aria-invalid') !== 'true') return false;
      try { el.focus(); } catch (_) {}
      if (typeof pjaFillTextViaFiber === 'function') { try { pjaFillTextViaFiber(el, val); return true; } catch (_) {} }
      if (typeof pjaSetNative === 'function') { pjaSetNative(el, val); return true; }
      el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
    };
    let filled = 0;
    if (monthInputs[0] && setTextForce(monthInputs[0], mm)) filled++;
    if (dayInputs[0] && setTextForce(dayInputs[0], dd)) filled++;
    if (yearInputs[0] && setTextForce(yearInputs[0], yyyy)) filled++;
    if (filled) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19);
        arr.push('[WD] self-identify date filled=' + filled + ' value=' + mm + '/' + dd + '/' + yyyy);
        chrome.storage.local.set({ pja_dbg: arr }, r);
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
    if (/state and federal law[\s\S]{0,160}(health care professional|hcp|physician|prescriber|payments and transfers of value)|payments and transfers of value[\s\S]{0,120}(physician|prescriber|health care professional|hcp)|massachusetts-licensed prescriber|none of the above/i.test(label)) {
      return 'C';    // Abbott HCP tracking disclosure: C = none of the listed HCP/prescriber categories.
    } else if (/(terms(?:\s+and\s+conditions)?|acceptTermsAndAgreements)[\s\S]{0,120}(read|agree|acknowledge|consent|accept)|(read|agree|acknowledge|consent|accept)[\s\S]{0,120}(terms(?:\s+and\s+conditions)?|acceptTermsAndAgreements)/i.test(label)) {
      // Some Workday tenants render this as a Yes/No questionnaire button rather than the
      // usual checkbox. It is an acknowledgement of the displayed application terms, not a
      // candidate-specific factual question, so the truthful answer is Yes.
      return 'Yes';
    } else if (/optional practical training|opt extension|\bopt\b|curricular practical|\bcpt\b|f-1 visa|f1 visa|j-1 visa/i.test(label)) {
      return 'No';   // Canadian on TN — not on OPT/CPT/F-1
    } else if (/sponsor/i.test(label)) {
      const sponsorPref = String(profile.requireSponsorship || '').trim();
      if (/^yes\b/i.test(sponsorPref)) return 'Yes';
      if (/^no\b/i.test(sponsorPref)) return 'No';
      return (typeof pjaDeterministicAnswer === 'function') ? pjaDeterministicAnswer(label) : null;
    } else if (/authoriz|eligible|legally|legal right/i.test(label)) {
      return profile.workAuth === 'Yes' ? 'Yes' : 'No';
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
    } else if (/ongoing negotiations|rfps?|procurements/i.test(label) && /current employer|employer/i.test(label)) {
      return 'No';
    } else if (/safely|efficiently|able|can you|perform/i.test(label) && /essential (functions|duties)|essential functions of the position/i.test(label)) {
      return 'Yes';
    } else if (/\btemp\b|temporary|contractor/i.test(label)) {
      return 'No';
    } else if (/worked (at|for)|employed (at|by)|are you (currently|now).*(employee|work)|former.*employee|previously work|current.*employee/i.test(label)) {
      return 'No';
    } else if (/signed (a )?document[\s\S]{0,120}restrict[\s\S]{0,120}(ability to work|employ|competitor)|agreement[\s\S]{0,140}(prohibit|limit|restrict)[\s\S]{0,100}(employment|work)/i.test(label)) {
      return 'No';
    } else if (/18 years|over 18|at least 18|age of 18/i.test(label)) {
      return 'Yes';
    } else if (/hispanic|latino/i.test(label)) {
      const h = String(profile.hispanicOrLatino || profile.hispanic || '').toLowerCase();
      if (/^no\b|not hispanic|not latino|decline|prefer not|choose not|do not wish/i.test(h)) {
        return /^no\b|not hispanic|not latino/i.test(h) ? 'No' : '__DECLINE__';
      }
      if (/^yes\b|hispanic|latino/i.test(h)) return 'Yes';
      const e = (profile.ethnicity || '').toLowerCase();
      if (/hispanic|latino/.test(e)) return 'Yes';
      return '__DECLINE__';
    } else if (/ethnic|race/i.test(label)) {
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
    } else if (/referred\b.*\b(employee|internal)|\b(employee|internal)\b.*\brefer/i.test(label)) {
      return 'No';
    } else if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application|\bsource\b/i.test(label)) {
      return profile.referralSource || 'LinkedIn';
    }
    const det = (typeof pjaDeterministicAnswer === 'function') ? pjaDeterministicAnswer(label) : null;
    return det || null;
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
    const candidates = texts.filter(txt => !/^(select one|select|choose|--|-)?$/i.test(txt));
    if (/^(yes|true)$/i.test(String(answer || ''))) {
      const agree = candidates.find(txt => /^(agree|i agree|yes,? i agree|acknowledge|confirm)/i.test(txt) && !/disagree|do not agree/i.test(txt));
      if (agree) return agree;
    }
    if (/^(no|false)$/i.test(String(answer || ''))) {
      const disagree = candidates.find(txt => /^(disagree|i disagree|do not agree)/i.test(txt));
      if (disagree) return disagree;
    }
    if (/^i am not a veteran$/i.test(String(answer || ''))) {
      const nonVeteran = candidates.find(txt => /(^|\b)(i am )?not a veteran\b|do not identify as (a )?veteran|no,?\s*i am not/i.test(txt));
      if (nonVeteran) return nonVeteran;
      const notProtected = candidates.find(txt => /not a protected veteran/i.test(txt) &&
        !/identify as (a )?veteran|i am a veteran|as a veteran/i.test(txt));
      if (notProtected) return notProtected;
      return candidates.find(txt => /wish (not )?to|decline|prefer not|not to (disclose|answer|identify)|do not wish|choose not/i.test(txt)) || null;
    }
    return candidates.find(txt => { const ot = txt.toLowerCase(); return ot === al || ot.includes(al) || al.includes(ot); }) || null;
  }

  if (typeof window !== 'undefined') {
    window.pjaWorkdayAnswerForLabel = pjaWorkdayAnswerForLabel;
    window.pjaPickAnswerOption = pjaPickAnswerOption;
  }

  function pjaCollectWorkdayErrorLabels() {
    const clean = s => String(s || '').trim().replace(/\s+/g, ' ');
    const fromErrorButtons = Array.from(document.querySelectorAll('button'))
      .map(b => clean(b.textContent || b.getAttribute('aria-label') || ''))
      .filter(txt => /^Error-/i.test(txt))
      .map(txt => clean(txt.replace(/^Error-?/i, '')));
    // Workday often renders validation as page text rather than tying the error button to the
    // invalid "Select One Required" control:
    //   Error: The field <real question label> is required and must have a value.
    const bodyText = document.body?.innerText || '';
    const fromBodyErrors = Array.from(bodyText.matchAll(
      /Error:\s*The field\s+([\s\S]{5,650}?)\s+is required and must have a value\./gi
    )).map(m => clean(m[1]));
    return Array.from(new Set([...fromErrorButtons, ...fromBodyErrors]))
      .filter(txt => txt && !/^select one required$/i.test(txt));
  }
  if (typeof window !== 'undefined') window.pjaCollectWorkdayErrorLabels = pjaCollectWorkdayErrorLabels;

  function pjaNearestQuestionTextBefore(el) {
    try {
      const chunks = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (el.contains(node)) break;
        if (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
        const txt = String(node.nodeValue || '').trim().replace(/\s+/g, ' ');
        if (txt) chunks.push(txt);
        if (chunks.join(' ').length > 5000) chunks.splice(0, chunks.length - 80);
      }
      const tail = chunks.join(' ').replace(/\s+/g, ' ').slice(-1800);
      const q = tail.match(/([^.!?]{12,650}\?)(?:\s*(?:Select One|Required|Yes|No|Acknowledge\/Confirm))*$/i);
      if (q) return q[1].trim();
      const colon = tail.match(/([^.!?]{12,650}:)(?:\s*(?:Select One|Required|Yes|No|Acknowledge\/Confirm))*$/i);
      return colon ? colon[1].trim() : '';
    } catch (_) {
      return '';
    }
  }

  async function pjaFillWorkdayAppQuestions(profile) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return;
    if (document.querySelector(
      '[data-automation-id="formField-dateSignedOn"], ' +
      '[data-automation-id="formField-disabilityStatus"], ' +
      '[data-automation-id*="selfIdentifiedDisabilityData"]'
    )) {
      await new Promise(r => chrome.storage.local.get('pja_dbg', d => {
        const arr = (d.pja_dbg || []).slice(-19);
        arr.push('[ext] WD appQ fill: SID skipped; transaction-owned');
        chrome.storage.local.set({ pja_dbg: arr }, r);
      }));
      return;
    }
    const fields = Array.from(new Set([
      ...document.querySelectorAll('[data-automation-id^="formField-"]'),
      ...document.querySelectorAll('button[aria-invalid="true"], [role="button"][aria-invalid="true"]'),
      ...document.querySelectorAll('button[id^="primaryQuestionnaire--"]')
    ]));
    const errorLabels = pjaCollectWorkdayErrorLabels();
    let invalidButtonOrdinal = 0;
    const log = [];
    const ownText = opt => {
      const clone = opt.cloneNode(true);
      clone.querySelectorAll('[role="option"]').forEach(child => child.remove());
      return (clone.textContent || '').trim().replace(/\s+/g, ' ');
    };
    const trustedClick = el => new Promise(resolve => {
      if (!el) return resolve(false);
      const priorId = el.id;
      const tempId = priorId || ('__pja_wd_appq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
      if (!priorId) el.id = tempId;
      try {
        chrome.runtime.sendMessage({ type: 'WORKDAY_TRUSTED_CLICK', selector: '#' + CSS.escape(tempId), single: true }, resp => {
          if (!priorId && el.id === tempId) el.removeAttribute('id');
          resolve(!!(resp && resp.ok));
        });
      } catch (_) {
        if (!priorId && el.id === tempId) el.removeAttribute('id');
        resolve(false);
      }
    });
    for (const field of fields) {
      const fieldIsButton = field.matches?.('button, [role="button"]');
      const btn = fieldIsButton ? field : field.querySelector('button[type="button"], button[aria-haspopup], [role="button"]');
      if (!btn) continue;
      // Label lives in richText div OR in the button's aria-label (e.g. "Protected Veteran: Select One")
      const richLabel = field.querySelector('[data-automation-id="richText"]')?.textContent || '';
      const btnAriaLabel = btn.getAttribute('aria-label') || '';
      const buttonId = btn.id || btn.getAttribute('data-automation-id') || '';
      const isQuestionnaireButton = /^primaryQuestionnaire--/i.test(buttonId);
      const pairedErrorLabel = fieldIsButton && btn.getAttribute('aria-invalid') === 'true'
        ? (errorLabels[invalidButtonOrdinal++] || '')
        : '';
      const nearbyQuestion = fieldIsButton && (btn.getAttribute('aria-invalid') === 'true' || isQuestionnaireButton)
        ? pjaNearestQuestionTextBefore(btn)
        : '';
      const idLabel = /hispanicOrLatino/i.test(buttonId) ? 'Are you Hispanic or Latino?'
        : /personalInfoUS--ethnicity/i.test(buttonId) ? 'Please select the ethnicity to which you most accurately identify yourself.'
        : /personalInfoUS--gender/i.test(buttonId) ? 'Please select your gender.'
        : /personalInfoUS--veteranStatus/i.test(buttonId) ? 'Please select your veteran status.'
        : '';
      const labelCandidates = [
        idLabel,
        pairedErrorLabel,
        richLabel,
        nearbyQuestion,
        btnAriaLabel.replace(/:\s*select one.*$/i, ''),
        buttonId
      ].map(s => String(s || '').trim())
        .filter(s => s && !/^select one required$/i.test(s));
      let label = '';
      let answer = null;
      for (const candidate of labelCandidates) {
        const candidateLabel = candidate.toLowerCase();
        const candidateAnswer = pjaWorkdayAnswerForLabel(candidateLabel, profile);
        if (candidateAnswer) {
          label = candidateLabel;
          answer = candidateAnswer;
          break;
        }
      }
      if (!answer) continue;
      const selectedText = (btn.textContent || btnAriaLabel || '').trim();
      const selectedStateText = (selectedText + ' ' + btnAriaLabel).replace(/\bRequired\b/ig, '').trim();
      const unresolved = /select one|select\.\.\./i.test(selectedStateText) ||
        btn.getAttribute('aria-invalid') === 'true' || /source--source/i.test(buttonId);
      const selectedClean = selectedText.replace(/\bRequired\b/ig, '').trim();
      const selectedMatchesAnswer = !!selectedClean && !!pjaPickAnswerOption(answer, [selectedClean], profile);
      const mustCorrectSelected = /sponsor|veteran|relatives?[\s\S]{0,60}work|immediate family[\s\S]{0,80}(employee|work)|agreement[\s\S]{0,140}(prohibit|limit|restrict)[\s\S]{0,100}(employment|work)/i.test(label) &&
        !selectedMatchesAnswer;
      if (!unresolved && selectedText && selectedText !== 'Select One' && !mustCorrectSelected) continue;
      // Close any stale open listbox before opening this field's dropdown
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      if (!await trustedClick(btn)) btn.click();
      // Poll up to 1.5s for a listbox to appear
      let listbox = null;
      for (let t = 0; t < 15; t++) {
        await new Promise(r => setTimeout(r, 100));
        listbox = document.querySelector('[role="listbox"]');
        if (listbox) break;
      }
      if (!listbox) continue;
      const optionEls = Array.from(listbox.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="selectedItem"]'));
      const optionTexts = optionEls.map(ownText);
      let chosenText = pjaPickAnswerOption(answer, optionTexts, profile);
      if (!chosenText && /how did you hear|referral source|\bsource\b/i.test(label)) {
        const fallbacks = ['LinkedIn', 'Job Board or Social Media', 'Social Media', 'Job Board', 'Online Job Board', 'Internet', 'Online', 'Career Site'];
        chosenText = fallbacks.find(fb => optionTexts.some(txt => txt.toLowerCase().includes(fb.toLowerCase()))) || null;
      }
      const opt = chosenText == null ? null : optionEls.find(o => ownText(o) === chosenText);
      if (opt) {
        const target = opt.querySelector('[data-automation-id="promptLeafNode"]') || opt;
        if (!await trustedClick(target)) target.click();
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
    if (disField) {
      const dis = (profile.disability || '').toLowerCase();
      const targetRe = /no|do not|don.t/i.test(dis) ? /no.*disab|not have.*disab/i
        : /yes|have a disab/i.test(dis) ? /yes.*disab|have.*disab/i
        : /do not want|not answer/i;
      const disInvalid = disField.getAttribute('aria-invalid') === 'true' ||
        !!disField.querySelector('[aria-invalid="true"], [data-automation-id$="-error"]');
      const disInputs = Array.from(disField.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
      for (const cb of disInputs) {
        const lbl = document.querySelector('label[for="'+cb.id+'"]');
        const fallbackNoCheckbox = !lbl && /no|do not|don.t/i.test(dis) && disInputs.length === 3 && cb === disInputs[1];
        if ((lbl && targetRe.test(lbl.textContent)) || fallbackNoCheckbox) {
          const nativeChecked = Object.getOwnPropertyDescriptor(
            cb instanceof HTMLInputElement ? HTMLInputElement.prototype : Object.getPrototypeOf(cb), 'checked'
          )?.set;
          for (const other of disField.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
            if (other !== cb && other.checked) {
              try { nativeChecked ? nativeChecked.call(other, false) : (other.checked = false); } catch (_) { other.checked = false; }
              other.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
              other.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
          }
          if (!cb.checked || disInvalid) {
            try { nativeChecked ? nativeChecked.call(cb, true) : (cb.checked = true); } catch (_) { cb.checked = true; }
            cb.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
            cb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          const labelText = lbl ? lbl.textContent.trim() : 'No disability fallback option 2';
          log.push('disability→' + labelText.slice(0, 35) + (disInvalid ? ' forced-invalid' : ''));
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
    const terms = await pjaForceWorkdayTermsCheckbox('appq');
    if (terms.filled) log.push('terms-checkbox checked');
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

  async function pjaForceWorkdayTermsCheckbox(phase) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return { filled: 0, remainingInvalid: 0 };
    const dbg = msg => new Promise(resolve => {
      try {
        chrome.storage.local.get('pja_dbg', d => {
          const arr = (d.pja_dbg || []).slice(-40);
          arr.push(msg);
          chrome.storage.local.set({ pja_dbg: arr }, resolve);
        });
      } catch (_) {
        resolve();
      }
    });
    const checkboxes = Array.from(document.querySelectorAll(
      'input[type="checkbox"][required], input[type="checkbox"][aria-required="true"], #termsAndConditions--acceptTermsAndAgreements'
    )).filter(cb => {
      const explicitWorkdayTerms = /termsAndConditions--acceptTermsAndAgreements|acceptTermsAndAgreements/i
        .test([cb.id || '', cb.name || '', cb.getAttribute('data-automation-id') || ''].join(' '));
      const parentFieldset = cb.closest('fieldset');
      if (!explicitWorkdayTerms && parentFieldset && parentFieldset.querySelectorAll('input[type="checkbox"]').length > 1) return false;
      const label = [
        typeof pjaGetLabel === 'function' ? pjaGetLabel(cb) : '',
        cb.id || '',
        cb.name || '',
        cb.getAttribute('aria-label') || '',
        cb.closest('label, [data-automation-id^="formField"], div')?.textContent || ''
      ].join(' ').replace(/\s+/g, ' ');
      if (explicitWorkdayTerms) return true;
      return /privacy notice|privacy policy|read and agree|declare that you have read|terms|terms and conditions|accept terms|consent to the terms|termsAndConditions|acceptTermsAndAgreements|acknowledge the terms/i.test(label);
    });
    let filled = 0;
    for (const cb of checkboxes) {
      const labelEl = cb.id ? document.querySelector('label[for="' + CSS.escape(cb.id) + '"]') : null;
      const target = labelEl || cb.closest('label') || cb;
      const invalidBefore = cb.getAttribute('aria-invalid') === 'true';
      if (!cb.checked || invalidBefore) {
        if (!await trustedWorkdayClick(target, 'terms-checkbox')) {
          try { cb.click(); } catch (_) {}
        }
        await sleep(500);
      }
      if (!cb.checked || cb.getAttribute('aria-invalid') === 'true') {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        try { setter ? setter.call(cb, true) : (cb.checked = true); } catch (_) { cb.checked = true; }
        cb.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        try { cb.blur(); } catch (_) {}
        await sleep(500);
      }
      if (cb.checked) filled++;
    }
    const remainingInvalid = checkboxes.filter(cb => cb.getAttribute('aria-invalid') === 'true' || !cb.checked).length;
    if (checkboxes.length) await dbg('[WD] terms checkbox phase=' + (phase || '') +
      ' filled=' + filled + '/' + checkboxes.length + ' remainingInvalid=' + remainingInvalid);
    return { filled, remainingInvalid };
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
        const ashbyResumeInput = /ashbyhq\.com$/i.test(location.hostname)
          ? document.querySelector('input[type="file"][name="_systemfield_resume"], input[type="file"][required]')
          : null;
        const ashbyResumeSection = ashbyResumeInput?.closest('[class*="field"], [class*="Field"], section, form > div');
        const ghSection = ashbyResumeSection || Array.from(document.querySelectorAll(
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
            document.documentElement.removeAttribute('data-pja-resume-injected');
            document.dispatchEvent(new CustomEvent('pja:injectresume', {
              detail: { b64, filename },
              bubbles: false
            }));
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
            for (let i = 0; i < 80; i++) {
              await sleep(250);
              // Direct signal: a file input now holds our file. Works even inside embedded iframes
              // where the ATS's remove/filename UI affordances differ or render late.
              const fi = (typeof pjaQueryAllExt === 'function' ? pjaQueryAllExt('input[type=file]') : Array.from(document.querySelectorAll('input[type=file]')))
                .find(inp => inp.files && inp.files.length > 0);
              if (fi) { console.log('PJA: resume attached (file present on input)'); uploadConfirmed = true; break; }
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
            document.documentElement.removeAttribute('data-pja-resume-injected');
            document.dispatchEvent(new CustomEvent('pja:injectresume', { detail: { b64, filename }, bubbles: false }));
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
            // Ashby may acknowledge the MAIN-world interception and then replace the file input,
            // discarding its FileList. Verify persistence instead of equating bridge "ok" with an
            // attached resume; re-inject into the current required input if necessary.
            let persisted = false;
            for (let i = 0; i < 20; i++) {
              await sleep(200);
              persisted = Array.from(document.querySelectorAll('input[type=file]'))
                .some(inp => inp.files && inp.files.length > 0);
              if (persisted || !document.contains(uploadBtn1_3) || /replace|remove/i.test(uploadBtn1_3.textContent || '')) break;
            }
            if (!persisted) {
              const currentInput = uploadBtn1_3.closest('form,section,[class*="field"],[data-testid]')?.querySelector('input[type=file]')
                || document.querySelector('input[type=file][required], input[type=file]');
              if (currentInput) {
                persisted = injectFileIntoInput(currentInput, makeFile(b64, filename));
                await sleep(500);
                persisted = persisted && !!(currentInput.files && currentInput.files.length);
                dbgResume('strategy1.3 persistence reinject=' + persisted);
              }
            }
            dbgResume('strategy1.3 persisted=' + persisted);
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
            document.documentElement.removeAttribute('data-pja-resume-injected');
            document.dispatchEvent(new CustomEvent('pja:injectresume', { detail: { b64, filename }, bubbles: false }));
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
    // Use only the password the applicant explicitly saved in Settings. Generic ATS account
    // creation previously invented a predictable fallback password, which could create an account
    // the user did not know how to access later. Per-tenant credentials still take precedence.
    const { pja_job_password: savedJobPassword } = await new Promise(resolve =>
      chrome.storage.local.get('pja_job_password', resolve)
    );

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

    // Generic non-Workday candidate-auth gate (Eightfold/SAP-style): email field + Continue/
    // social sign-in/create-account controls but no application form yet. We do not create
    // arbitrary non-Workday accounts in E2E-safe mode; defer and advance instead of stalling.
    const genericEmailGate = document.querySelector(
      'input[type=email], input[name*=email]:not([name="website"]), input[id*=email]'
    );
    const genericGateText = document.body?.innerText || '';
    const genericContinue = findButton(/^continue$/i) || findButton(/create.{0,10}account/i);
    if (genericEmailGate && genericContinue &&
        /sign in|first time here|create.{0,10}account|candidate authentication|join talent network|sign in using/i.test(genericGateText) &&
        !document.querySelector('input[type=password]')) {
      if (typeof pjaSetNative === 'function') {
        pjaSetNative(genericEmailGate, profile.email || '');
      } else {
        genericEmailGate.value = profile.email || '';
        genericEmailGate.dispatchEvent(new InputEvent('input', { bubbles: true, data: profile.email || '', inputType: 'insertText' }));
      }
      try { chrome.storage.local.get('pja_dbg', d => {
        const a = (d.pja_dbg || []).slice(-160);
        a.push('[auth] generic email gate needs_login host=' + location.hostname);
        chrome.storage.local.set({ pja_dbg: a });
      }); } catch (_) {}
      return 'needs_password';
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
        const password = storedCreds?.password || savedJobPassword;
        if (!password) return 'needs_password';

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
      const password1pw = storedCreds?.password || savedJobPassword;
      if (!password1pw) {
        if (emailField) fill(emailField, profile.email);
        return 'needs_password';
      }

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

  // Detect a dead/closed posting from visible page text — a stale queued applyUrl that 404s or
  // shows a "no longer accepting / filled / closed" shell (e.g. Ashby renders a "Page not found"
  // page whose only controls are footer links). Kept as a small pure function so it's unit-tested.
  function pjaIsClosedPosting(bodyText) {
    const t = String(bodyText || '');
    return /page not found|the page you requested was not found|no longer accepting applications|this (job|position|posting) (is )?(no longer|has been) (available|filled|closed)|position (has been )?(filled|closed)|posting (is )?closed|job (is )?(no longer available|has been filled)/i.test(t);
  }
  if (typeof window !== 'undefined') window.pjaIsClosedPosting = pjaIsClosedPosting;

  // Shadow-DOM-aware query: use pjaQueryAll if available (loaded by autofill.js), else document
  const pjaQueryAllExt = typeof pjaQueryAll === 'function'
    ? pjaQueryAll.bind(null)
    : sel => Array.from(document.querySelectorAll(sel));

  function findButton(pattern) {
    return pjaQueryAllExt('button[type=submit], button[type=button], input[type=submit], button, [role=button], [data-automation-id="click_filter"], spl-button, oc-button')
      .find(b => !b.disabled && pattern.test((b.textContent || b.value || b.getAttribute('aria-label') || '').trim()));
  }
  function trustedPointClick(el) {
    return new Promise(resolve => {
      if (!el) return resolve(false);
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      const r = el.getBoundingClientRect();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 5000);
      try {
        chrome.runtime.sendMessage({ type: 'LINKEDIN_TRUSTED_CLICK', x: r.left + r.width / 2, y: r.top + r.height / 2 }, resp => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(!(chrome.runtime.lastError || resp?.error));
        });
      } catch (_) {
        if (!done) { done = true; clearTimeout(timer); resolve(false); }
      }
    });
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
      if (/^iti-\d+__search-input$/i.test(el.id || '') ||
          el.type === 'search' ||
          el.getAttribute('role') === 'combobox' ||
          el.getAttribute('aria-autocomplete') ||
          (el.type === 'search' && el.closest('[class*="iti"]'))) continue;
      if (!el.offsetParent || el.value.trim()) continue;
      const label = getLabelFor(el) || pjaAsteriskLabelText(el);
      if (!label) continue;
      if (/\b(phone\s*)?extension\b|--extension\b/i.test([label, el.id, el.name].join(' '))) continue;
      const key = typeof pjaClassify === 'function' ? pjaClassify(label) : null;
      const isPhoneById = /^(phone|phoneNumber)$/i.test(el.id || '') || /^(phone|phoneNumber)$/i.test(el.name || '');
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

  function forceWorkdayPhoneNumberCommit(profile) {
    if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) return 0;
    const rawDigits = String(profile && profile.phone || '').replace(/\D/g, '');
    // Workday stores country code separately; entering a leading US "1" in Phone Number can be
    // rejected/cleared by the React validator even though the DOM briefly shows the value.
    const digitsPhone = /^(?:1)?\d{10}$/.test(rawDigits) ? rawDigits.slice(-10) : rawDigits;
    if (!digitsPhone) return 0;
    let count = 0;
    const targets = pjaQueryAllExt(
      'input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])'
    ).filter(el => {
      if (!el.offsetParent) return false;
      const text = [getLabelFor(el), el.id, el.name].join(' ');
      if (/\b(phone\s*)?extension\b|--extension\b/i.test(text)) return false;
      if (el.getAttribute('data-uxi-widget-type') === 'selectinput' || el.getAttribute('role') === 'combobox') return false;
      return /^phoneNumber(?:--phoneNumber)?$/i.test(el.id || '') ||
        /^phoneNumber(?:--phoneNumber)?$/i.test(el.name || '');
    });
    for (const el of targets) {
      try {
        if (typeof pjaFillTextViaFiber === 'function') pjaFillTextViaFiber(el, digitsPhone, true);
        else if (typeof pjaSetNative === 'function') pjaSetNative(el, digitsPhone, true);
        else {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, digitsPhone); else el.value = digitsPhone;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: digitsPhone, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Workday phone number rejects/clears valid national digits on blur in some tenants while
        // never extension: the optional phone extension must not be touched by this helper.
        // the country code is a separate committed chip. Keep the field focused and let the
        // trusted insertText path above update React state without an immediate blur.
        try { el.focus(); } catch (_) {}
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: digitsPhone, inputType: 'insertText' }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: digitsPhone, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const valDigits = String(el.value || '').replace(/\D/g, '');
        if (valDigits.includes(digitsPhone.slice(-7))) count++;
      } catch (_) {}
    }
    return count;
  }

  function findMissingRequired() {
    const missing = [];
    const seen = new Set();

    const committedReactSelectValue = (el) => {
      try {
        if (!el) return '';
        const containers = [
          el.closest('[class*="select__container"],[class*="select-container"],[class*="select "]'),
          el.closest('[class*="select__control"],[class*="select-control"]')?.parentElement,
          el.parentElement?.parentElement?.parentElement,
        ].filter(Boolean);
        for (const rsContainer of containers) {
          const sv = rsContainer.querySelector('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
          const txt = (sv?.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && !/^select( an option| \.\.\.|\.\.\.)?$/i.test(txt)) return txt;
        }
      } catch (_) {}
      return '';
    };

    for (const el of pjaQueryAllExt(
      'input[required]:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),' +
      'select[required], textarea[required],' +
      '[aria-required="true"]:not([type=hidden]):not([type=file])'
    )) {
      if (!el.offsetParent && el.getBoundingClientRect().width === 0) continue; // hidden
      // Workday prompt flyouts contain a transient required search input with an opaque generated
      // id (for example "x9ie0"). It is a menu control, not an application question; treating it
      // as an empty required field blocks the step immediately after State was selected.
      if (el.closest('[data-automation-id="activeListContainer"], [role="listbox"]')) continue;
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
      // SmartRecruiters Stencil/Angular custom selects can expose the committed selection on the
      // host attribute after a trusted keyboard fallback even when the internal hidden control keeps
      // an empty .value. Treat that as filled so recovery does not loop on "Country/Region".
      if (!val && /smartrecruiters\.com/i.test(location.hostname)) {
        const srHost = (tag === 'spl-select' ? el : el.closest?.('spl-select'));
        const srVal = srHost && (srHost.value || srHost.getAttribute('value') || srHost.getAttribute('data-pja-value') || '');
        if (srVal && !/^select( an option| \.\.\.|\.\.\.)?$/i.test(String(srVal).trim())) val = String(srVal).trim();
      }
      // react-select stores selected value in a sibling singleValue span, not el.value
      if (!val && role === 'combobox') val = committedReactSelectValue(el);
      // Workday selectinput: el.value is always "" even when items are selected.
      // Check the multiselect container's selectedItemList text instead.
      const isWdSelectinput = el.getAttribute('data-uxi-widget-type') === 'selectinput';
      if (!val && isWdSelectinput) {
        const selectedText = typeof workdaySelectedTextFor === 'function' ? workdaySelectedTextFor(el) : '';
        if (selectedText) val = selectedText;
        const msContainer = el.closest('[data-uxi-widget-type="multiselect"]');
        const selectedList = msContainer?.querySelector('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]');
        if (!val && selectedList?.textContent?.trim()) val = selectedList.textContent.trim();
        if (!val && /\d+\s*item/i.test(msContainer?.textContent || '')) val = '1 item selected';
        if (!val) {
          const fieldText = (el.closest('[data-automation-id^="formField"], [data-uxi-widget-type="multiselect"], fieldset, div')?.textContent || '')
            .replace(/\s+/g, ' ');
          if (/(country|territory).{0,60}phone.{0,30}code|phone.{0,30}(country|territory).{0,30}code|dial(?:ing|ling) code/i.test(fieldText) &&
              /\d+\s*item selected/i.test(fieldText) && /united states/i.test(fieldText) && /\+?1\b/.test(fieldText)) {
            val = 'United States of America (+1)';
          }
        }
      }
      if (val && val !== 'Select an option' && val !== '' && val !== 'Select...') continue;
      const label = getLabelFor(el) || pjaAsteriskLabelText(el);
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
    // Equivalent EEO terminology varies across ATS forms. Map only exact demographic synonyms;
    // this is profile truth, not an inference about qualifications.
    const eeoAliases = { female: ['woman', 'women'], male: ['man', 'men'],
      'non binary': ['nonbinary', 'gender non conforming', 'genderqueer'] };
    const aliases = eeoAliases[na] || [];
    if (aliases.length) { hit = opts.find(o => aliases.includes(norm(o))); if (hit) return hit; }
    // 2. leading Yes/No token — "no. my background is..." → the No option
    const lead = na.match(/^(yes|no)\b/);
    if (lead) { hit = opts.find(o => norm(o) === lead[1] || new RegExp('^' + lead[1] + '\\b').test(norm(o))); if (hit) return hit; }
    // A required one-option checkbox group is an acknowledgment, not a Yes/No picker. Greenhouse
    // renders these as e.g. ["Acknowledge/Confirm"]. A deterministic Yes means check that sole
    // policy option; leaving it unmatched silently blocks submit.
    if (na === 'yes' && opts.length === 1 && /acknowledge|confirm|agree|certify|consent/i.test(opts[0])) return opts[0];
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
    // Recurring profile-mappable questions that kept deferring to needs_manual (pja_missing_questions):
    if (/what state|which state|state (do you|you)[\s\S]{0,20}(live|reside|based)|state of residence|current state/.test(L)) return profile.state || null;
    if (/\bzip\b|zip ?code|postal code/.test(L)) return profile.zip || null;
    if (/\bcity\b (you|do you)[\s\S]{0,15}(live|reside)|what city|which city/.test(L)) return profile.city || null;
    if (/earliest[\s\S]{0,40}(available|availability|start)|when (?:can|could|will|would|are) you[\s\S]{0,35}(start|available)|available start date|start date/.test(L))
      return profile.startDate || profile.availability || profile.noticePeriod || null;
    if (/(country|territory).{0,40}phone.{0,20}code|phone.{0,20}(country|territory).{0,20}code|dial(?:ing|ling) code/.test(L)) return profile.phoneCountryCode || 'United States of America (+1)';
    if (/highest (level of )?education|level of education|education (level|completed)|education you have (completed|attained)/.test(L)) return profile.degree || profile.education || null;
    if (/discipline|field of study|\bmajor\b|area of study|concentration/.test(L)) return profile.major || null;
    if (/visa (type|status)|immigration status|if yes[\s\S]{0,30}(visa|status)/.test(L)) return profile.visaStatus || null;
    if (/gender identity|how (?:do|would) you describe your gender|\bgender\b/.test(L)) return profile.gender || null;
    return null;
  }
  if (typeof window !== 'undefined') window.pjaProfileFieldForLabel = pjaProfileFieldForLabel;

  function pjaDeterministicAnswer(label) {
    const t = String(label || '');
    if (/referr/i.test(t)) return 'No';
    if (/require.*sponsor|\bsponsorship\b|visa sponsor/i.test(t)) return 'No';
    if (/authoriz|eligible to work|legally (authorized|entitled|able)|right to work/i.test(t)) return 'Yes';
    if (/ongoing negotiations|rfps?|procurements/i.test(t) && /current employer|employer/i.test(t)) return 'No';
    if (/(now or have you ever|currently|previously)[\s\S]{0,50}(employee|employed|worked? (for|at))|previously worked? (for|at)/i.test(t)) return 'No';
    if (/worked (for|at)[\s\S]{0,30}(pricewaterhouse|pwc)/i.test(t)) return 'No';
    if (/\bat least 18\b|\bover 18\b|\b18 (years|or older)\b|are you 18/i.test(t)) return 'Yes';
    if (/willing to (relocate|travel|commute)|able to[\s\S]{0,25}(relocate|commute|travel)|open to relocat|reliably commute|commute to /i.test(t)) return 'Yes';
    // Onsite / in-office ability. This deterministic Yes assumes the user has set open-to-onsite
    // preferences; specific location conflicts still defer to manual/AI handling below.
    if (/able (?:and willing )?to (come|be|work|report)[\s\S]{0,20}(on[ -]?site|in.?office|in person)|available to work at[\s\S]{0,50}(office|site)[\s\S]{0,30}(day|week)|come on[ -]?site|on[ -]?site as (required|needed)|work (on[ -]?site|in.?office|in person)|report to (the )?office|commute to (the )?(office|site)/i.test(t)) return 'Yes';
    // Shift schedules (swing/night/rotating/weekends) — candidate is open to any shift.
    if (/shift schedule|swing shift|night shift|graveyard|rotating shift|able to work[\s\S]{0,15}shift|work[\s\S]{0,10}(nights|weekends)/i.test(t)) return 'Yes';
    // Located-in / commutable. Defer clearly distant cities to the AI/needs_manual path rather
    // than fabricating a commute.
    if (/located in|currently (live|reside)|do you (live|reside)|commutable (distance|to)|within \d+ ?miles|reside (in|within)|based in|bay area/i.test(t)) {
      if (/oxnard|rosemead|valencia|los angeles|\bl\.?a\.?\b|san diego|irvine|carlsbad|orange county|so ?cal|southern california/i.test(t)) return null;
      return 'Yes';
    }
    // Years-of-experience gates: 3+ years in configured core domains → Yes when N<=3; known gaps → No;
    // unknown domain → defer (null) so the honest AI answerer decides. Never claims a gap skill.
    { const ym = t.match(/(\d+)\s*\+?\s*(?:or more\s*)?years?/i);
      if (ym && /experience|exp\b/i.test(t)) {
        if (/fmea|8d\b|iso ?13485|optical metrolog|\bpython\b|\bcad\b|solidworks|supplier audit|\bc\+\+\b|verilog/i.test(t)) return 'No';
        if (/quality|manufactur|process|metrolog|wafer|inspection|semiconductor|\btest\b|reliability|equipment|clean ?room|thin film|yield|\bspc\b|\bgmp\b/i.test(t)) return parseInt(ym[1], 10) <= 3 ? 'Yes' : 'No';
      }
    }
    // Conflict-of-interest / relatives at the company → No.
    if (/friends or relatives|relatives?[\s\S]{0,40}(presently\s+)?work(?:ing)?\s+(?:at|for)|related to (an?|any)[\s\S]{0,30}(employee|customer)|immediate family[\s\S]{0,60}(employee|employed|work(?:s|ing)? (?:at|for)|health care|use or prescribe)|conflict of interest|affiliated with a company that does business/i.test(t)) return 'No';
    if (/(?:ever|currently)[\s\S]{0,35}employed by[\s\S]{0,45}(?:u\.?s\.? )?federal government|contractor[\s\S]{0,45}performed work for[\s\S]{0,35}federal government|served in the military|political appointee/i.test(t)) return 'No';
    if (/relatives[\s\S]{0,45}(?:employed by|work(?:ing)? for|serves? in)[\s\S]{0,80}(?:federal government|department of (?:health|defense)|military)|relatives[\s\S]{0,100}political appointee/i.test(t)) return 'No';
    if (/\bdebarred\b|\bexcluded\b[\s\S]{0,30}(federal|government|health care|program)|\bsuspended\b[\s\S]{0,30}(federal|government|program)/i.test(t)) return 'No';
    // US-person / citizenship (export-control framings) — honest No: TN status is not a US person.
    if (/\bu\.?s\.? person\b|are you a (u\.?s\.? )?(citizen|national)\b|protected individual/i.test(t)) return 'No';
    // Greenhouse/Pure Storage wording: the described deemed-export restriction applies only to
    // citizens of sanctioned nations without a second non-sanctioned nationality/residency. The
    // applicant is Canadian, so it does not affect employment.
    if (/deemed export rule[\s\S]{0,50}affect (?:your )?employment/i.test(t)) return 'No';
    // Degree specifically in EE/ME — honest No (candidate's degree is Environmental Engineering).
    if (/degree in (electrical|mechanical)|electrical or mechanical engineering|(b\.?s\.?|m\.?s\.?) in (electrical|mechanical)/i.test(t)) return 'No';
    if (/background check|drug (test|screen)/i.test(t)) return 'Yes';
    // Non-compete: honest No for a California-based candidate — CA Bus. & Prof. Code §16600 voids
    // non-compete agreements, so a CA applicant is not bound by an enforceable one.
    if (/non-?compete|noncompete/i.test(t) && /\b(bound|subject|signed|have|are you)\b/i.test(t)) return 'No';
    if (/agreement[\s\S]{0,140}(prohibit|limit|restrict)[\s\S]{0,100}(employment|work)|prohibit or limit your employment|signed (a )?document[\s\S]{0,120}restrict[\s\S]{0,120}(ability to work|employ|competitor)/i.test(t)) return 'No';
    if (/referred\b.*\b(employee|internal)|\b(employee|internal)\b.*\brefer/i.test(t)) return 'No';
    if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application/i.test(t)) return 'LinkedIn';
    if (/salary[\s\S]{0,80}(benefits|matched)|benefits[\s\S]{0,80}(salary|matched)/i.test(t))
      return '$80,000 - $95,000 depending on role and responsibilities; standard health, dental, vision, retirement, and PTO benefits.';
    if (/desired (?:base )?salary|salary expectation|expected (?:base )?(?:salary|compensation)|compensation expectation/i.test(t))
      return '$80,000 - $95,000 depending on role and responsibilities';
    if (/how many years[\s\S]{0,80}hands.?on[\s\S]{0,80}deposition equipment|hands.?on[\s\S]{0,80}deposition equipment[\s\S]{0,80}years/i.test(t))
      return '0 years of direct hands-on deposition equipment experience; 6 years of inspection, metrology, and manufacturing quality experience.';
    // Acknowledgment / certification statements ("I have read and understand the Export Control
    // statement…", "I acknowledge…", "I certify…", "I agree…") — honest Yes: reading and agreeing
    // to a posted statement is part of applying. Excludes eligibility/legal-status framings, which
    // the sponsorship/authorization rules above answer, and open-ended prompts.
    if (/^\s*(?:i )?(?:have read|acknowledge(?:\/confirm)?|certify|verify|understand|agree|consent)\b|i have read and (understand|agree)|acknowledge (that i|and (agree|understand))|i certify that|application submission is truthful and accurate/i.test(t) &&
        !/how many|describe|explain|please (provide|list|specify)/i.test(t)) return 'Yes';
    if (/export control|u\.?s\.? export|itar\b|ear\b|export administration regulation/i.test(t) &&
        !/have read|read and understand|acknowledge|certify|agree|consent|statement/i.test(t)) return 'No';
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
    const committedReactSelectValue = (el) => {
      try {
        if (!el) return '';
        const containers = [
          el.closest('[class*="select__container"],[class*="select-container"],[class*="select "]'),
          el.closest('[class*="select__control"],[class*="select-control"]')?.parentElement,
          el.parentElement?.parentElement?.parentElement,
        ].filter(Boolean);
        for (const rsContainer of containers) {
          const sv = rsContainer.querySelector('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
          const txt = (sv?.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && !/^select( an option| \.\.\.|\.\.\.)?$/i.test(txt)) return txt;
        }
      } catch (_) {}
      return '';
    };
    for (const el of Q(
      'input[required]:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),' +
      'select[required], textarea[required],' +
      '[aria-required="true"]:not([type=hidden]):not([type=file])'
    )) {
      if (!el.offsetParent && el.getBoundingClientRect().width === 0) continue;
      if (/workday\.com|myworkdayjobs\.com/i.test(location.hostname)) {
        if (el.closest('[data-automation-id="activeListContainer"], [role="listbox"]')) continue;
        const wdMs = el.closest('[data-uxi-widget-type="multiselect"]');
        if (wdMs) {
          const selectedText = typeof workdaySelectedTextFor === 'function'
            ? workdaySelectedTextFor(el)
            : (wdMs.querySelector('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]')?.textContent || '')
              .replace(/\s+/g, ' ').trim();
          if (selectedText && !/^select one|select\.\.\./i.test(selectedText)) continue;
        }
      }
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (!['input','select','textarea'].includes(tag) && !['combobox','listbox','textbox'].includes(role)) continue;
      const container = el.closest('[class*="upload"],[class*="resume"],[class*="file-input"],[class*="attach"]');
      if (container && container.querySelector('input[type="file"]')) continue;
      if (el.getAttribute('data-uxi-widget-type') === 'selectinput') continue; // WD typeahead handled elsewhere
      let val = (el.value || '').trim();
      if (!val && role === 'combobox') val = committedReactSelectValue(el);
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
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (!role && !['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) continue;
      const committed = (el.value && el.value.trim()) || (role === 'combobox' ? committedReactSelectValue(el) : '');
      if (committed && !/^select( an option| \.\.\.|\.\.\.)?$/i.test(committed)) continue;
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
    const fld = el.closest && el.closest('.application-question, [class*="application-question"], .field, [class*="field"], [class*="question"], .form-group');
    if (fld) { const lbl = fld.querySelector('label, .label, legend'); if (lbl) texts.push(lbl.textContent); }
    const ast = pjaAsteriskLabelText(el);
    if (ast) texts.push(ast);
    return texts.some(t => /[*✱]/.test(t || ''));
  }

  function pjaAsteriskLabelText(el) {
    try {
      const root = el.closest && el.closest('.application-question, [class*="application-question"], [class*="question"], .field, [class*="field"], .form-group');
      if (!root) return '';
      const direct = root.querySelector('label, legend, .application-label, [class*="label"], [class*="question-title"], [class*="question_text"]');
      if (direct && /[*✱]/.test(direct.textContent || '')) return direct.textContent.replace(/\s+/g, ' ').trim();
      const clone = root.cloneNode(true);
      clone.querySelectorAll('input, textarea, select, button, [role="listbox"], [class*="select__menu"], [class*="select-menu"]').forEach(n => n.remove());
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      const star = text.match(/([^*✱]{8,260}[*✱])/);
      return star ? star[1].trim() : '';
    } catch (_) { return ''; }
  }
  if (typeof window !== 'undefined') window.pjaAsteriskLabelText = pjaAsteriskLabelText;

  // Route still-empty required fields to the AI answerer (background ANSWER_QUESTIONS ->
  // dev-server /answer-questions using profile + resume + pja_prefs) and apply the answers.
  // Honest by construction (prompt forbids fabricating skills she lacks). Low-confidence
  // answers are left unfilled (so they surface as missing rather than guessed).
  // scope: optional root to confine the scan (e.g. a LinkedIn Easy Apply modal). Reused by
  // both external ATS pages (scope=undefined → whole doc) and Easy Apply (scope=modal root).
  async function pjaAnswerRequiredViaAI(job, scope) {
    const dbg = m => new Promise(r => chrome.storage.local.get('pja_dbg', d => { const a=(d.pja_dbg||[]).slice(-19); a.push(m); chrome.storage.local.set({pja_dbg:a}, r); }));
    const workdayComboKeyFor = f => {
      if (!/workday\.com|myworkdayjobs\.com/i.test(location.hostname) || !f) return null;
      const text = [
        f.label || '',
        f.el?.getAttribute?.('aria-label') || '',
        f.el?.id || '',
        f.el?.closest?.('[data-automation-id^="formField-"], [data-uxi-widget-type="multiselect"]')?.textContent || '',
      ].join(' ').replace(/\s+/g, ' ');
      if (/(country|territory).{0,60}phone.{0,30}code|phone.{0,30}(country|territory).{0,30}code|dial(?:ing|ling) code/i.test(text)) return 'phoneCountryCode';
      if (/how did you hear|where did you (hear|find)|referral source|source of (this )?application|\bsource\b/i.test(text)) return 'referralSource';
      return null;
    };
    const applyComboboxAnswer = async (f, ans) => {
      if (typeof pjaFillCombobox !== 'function') return false;
      const key = workdayComboKeyFor(f);
      if (key === 'phoneCountryCode') {
        const fieldText = (f.el?.closest?.('[data-automation-id^="formField-"], [data-uxi-widget-type="multiselect"]')?.textContent || '')
          .replace(/\s+/g, ' ');
        if (/united states(?: of america)?\s*\(\+?1\)/i.test(fieldText)) {
          void dbg('[WD] ai combobox skip phone code already US');
          return true;
        }
      }
      // Greenhouse Remix react-select fields can show the selected text while Formik still has an
      // empty value. For AI-answered custom questions, go straight through the trusted option-click
      // path and force it to ignore stale display text.
      const ctrl = f.el?.closest?.('[class*="select__control"]');
      const isGreenhouseReactSelect = /greenhouse\.io/i.test(location.hostname) && !!ctrl;
      if (isGreenhouseReactSelect && typeof pjaForceReactSelectCommit === 'function') {
        const ok = await pjaForceReactSelectCommit(f.el, ans, { force: true });
        if (ok) return true;
      }
      pjaFillCombobox(f.el, ans, key || undefined);
      return true;
    };
    let fields = collectRequiredEmptyFields(scope);
    await dbg('[ai] collected(' + fields.length + '): ' + fields.map(f => f.type + ':' + (f.label || '').slice(0, 24)).join(' | ').slice(0, 170));
    if (!fields.length) return { applied: 0, asked: 0 };
    // Deterministic pre-pass: policy questions + profile fields (LinkedIn/location/website)
    // directly from truth — no AI flakiness, and covers TEXT fields (which the AI declined).
    const detProfile = Object.assign({}, pjaRuntimeProfile || {}, job.profile || {});
    const resolverContext = { profile: detProfile, answers: pjaRuntimeAnswers || {}, prefs: job.prefs || {} };
    let detApplied = 0;
    for (const f of fields) {
      const resolved = typeof pjaResolveRequiredAnswer === 'function'
        ? pjaResolveRequiredAnswer(f, resolverContext)
        : null;
      const ans = (resolved && resolved.answer) || pjaDeterministicAnswer(f.label) || pjaProfileFieldForLabel(f.label, detProfile);
      if (!ans) continue;
      try {
        // Greenhouse Location (City) is a Google-Places autocomplete: it's often collected as a
        // plain 'text' field (no role=combobox), but a bare value-set doesn't commit — it needs
        // the Places listbox pick that pjaFillCombobox's candidate-location branch performs. Route
        // any location/city field there so it commits reliably (was a ~50% flaky skip otherwise).
        const isLocationField = /location|\bcity\b/i.test(f.label || '') && (f.el.id === 'candidate-location' || /location|city/i.test(f.el.id || '') || f.el.getAttribute('role') === 'combobox' || f.el.getAttribute('aria-autocomplete'));
        if (isLocationField && typeof pjaFillCombobox === 'function') pjaFillCombobox(f.el, ans, workdayComboKeyFor(f) || undefined);
        else if (f.type === 'radio' && typeof pjaSelectRadio === 'function') pjaSelectRadio(f.radios || [], ans);
        else if (f.type === 'checkboxgroup' && typeof pjaCheckMatchingBox === 'function') {
          const choice = pjaCoerceToOption(ans, f.options || []) || ans;
          const multi = /select all|all that apply|multiple|check all/i.test(f.label || '');
          if (multi && typeof pjaCheckMatchingBoxes === 'function') pjaCheckMatchingBoxes(f.members || [], ans);
          else pjaCheckMatchingBox(f.members || [], choice);
        }
        else if (f.type === 'select' && typeof pjaFillSelect === 'function') pjaFillSelect(f.el, ans);
        else if (f.type === 'combobox') await applyComboboxAnswer(f, ans);
        else if ((f.type === 'text' || f.type === 'textarea') && f.el) {
          if (typeof pjaFillTextViaFiber === 'function') pjaFillTextViaFiber(f.el, ans);
          else if (typeof pjaSetNative === 'function') pjaSetNative(f.el, ans);
        }
        else continue;
        detApplied++;
        await dbg('[resolve] ' + (resolved?.source || 'deterministic') + ' ' +
          (resolved?.canonicalKey || '').slice(0, 40) + ' label=' + (f.label || '').slice(0, 36));
      } catch (_) {}
    }
    if (detApplied) {
      await dbg('[ai] deterministic applied=' + detApplied);
      // AWAIT the combobox commit chain before re-collecting: pjaFillCombobox queues its
      // react-select commit on _pjaComboChain and returns immediately, so a re-collect after a
      // bare sleep still sees the field EMPTY → it gets re-sent to the AI, whose answer then
      // OVERWRITES the correct deterministic one (observed: an Export Control acknowledgment the
      // deterministic pass set to the honest "Yes" was re-collected and the AI committed "No").
      if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
        await Promise.race([window._pjaComboChain.catch(() => {}), new Promise(r => setTimeout(r, 6000))]);
      }
      await sleep(500);
      fields = collectRequiredEmptyFields(scope);
    }
    if (!fields.length) return { applied: detApplied, asked: 0 };
    // checkboxgroup -> present to the AI as a 'select' so it sees the options and copies one exactly.
    const questions = fields.map(f => {
      const unresolved = typeof pjaResolveRequiredAnswer === 'function'
        ? pjaResolveRequiredAnswer(f, resolverContext)
        : null;
      return { label: f.label, type: f.type === 'checkboxgroup' ? 'select' : f.type, options: f.options || [], maxLength: f.maxLength || 0,
        canonicalKey: unresolved && unresolved.canonicalKey || null,
        sensitive: !!(unresolved && unresolved.sensitive),
        ats: location.hostname };
    });
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
    const answerCache = {}; // normalized label -> final answer, for the verify-and-retry pass
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      // Prefer exact label match; fall back to positional (dev-server returns answers in
      // question order — robust when the model reworords/truncates long legalese labels).
      const a = resp.answers.find(x => norm(x.label) === norm(f.label)) || resp.answers[i];
      // The deterministic answer (policy/acknowledgment/profile truth) MUST win over the AI's:
      // the model sometimes returns a wrong value for a fixed-truth question (observed: it answered
      // "No" to "I have read and understand the Export Control statement", where the honest answer
      // is "Yes"). When a deterministic answer exists, use it and ignore the AI's for that field.
      const resolved = typeof pjaResolveRequiredAnswer === 'function'
        ? pjaResolveRequiredAnswer(f, resolverContext)
        : null;
      const det = (resolved && resolved.answer) || pjaDeterministicAnswer(f.label) || pjaProfileFieldForLabel(f.label, detProfile);
      let ans = det || pjaAnswerValue(f.label, a);
      if (!ans) { low++; continue; }
      // Option-typed fields (select/combobox/radio) need the answer to MATCH an option. The AI
      // often returns prose ("No. My background is...") for a Yes/No screen — coerce it to the
      // best-matching option so the filler can commit it (else it stays empty → skip).
      if (['select', 'combobox', 'radio', 'checkboxgroup'].includes(f.type) && Array.isArray(f.options) && f.options.length) {
        ans = pjaCoerceToOption(ans, f.options) || ans;
      }
      answerCache[norm(f.label)] = ans;
      try {
        if (f.type === 'checkboxgroup' && typeof pjaCheckMatchingBox === 'function') pjaCheckMatchingBox(f.members || [], ans);
        else if (f.type === 'select' && typeof pjaFillSelect === 'function') pjaFillSelect(f.el, ans);
        else if (f.type === 'combobox') await applyComboboxAnswer(f, ans);
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
    // VERIFY-AND-RETRY: the react-select fiber commit is intermittent — a single onChange call
    // sometimes doesn't stick (observed: the Export Control ack committed on some runs, not others,
    // failing submit on question_*-error). Re-collect the still-empty required option-fields and
    // re-fire their answer from the cache, up to 3 rounds. This is the "verify display shows the
    // value, then commit" step: collectRequiredEmptyFields reads the react-select single-value, so
    // a field only reappears here if it genuinely did NOT commit.
    for (let round = 0; round < 3; round++) {
      const still = collectRequiredEmptyFields(scope).filter(f => answerCache[norm(f.label)]);
      if (!still.length) break;
      await dbg('[ai] retry round ' + (round + 1) + ': ' + still.map(f => (f.label || '').slice(0, 18)).join(' | ').slice(0, 120));
      for (const f of still) {
        const ans = answerCache[norm(f.label)];
        const isLoc = /location|\bcity\b/i.test(f.label || '') && (f.el.id === 'candidate-location' || /location|city/i.test(f.el.id || '') || f.el.getAttribute('role') === 'combobox' || f.el.getAttribute('aria-autocomplete'));
        try {
          if (isLoc && typeof pjaFillCombobox === 'function') pjaFillCombobox(f.el, ans, workdayComboKeyFor(f) || undefined);
          else if (f.type === 'radio' && typeof pjaSelectRadio === 'function') pjaSelectRadio(f.radios || [], ans);
          else if (f.type === 'checkboxgroup' && typeof pjaCheckMatchingBox === 'function') {
            if (/select all|all that apply|multiple|check all/i.test(f.label || '') && typeof pjaCheckMatchingBoxes === 'function') pjaCheckMatchingBoxes(f.members || [], ans);
            else pjaCheckMatchingBox(f.members || [], ans);
          }
          else if (f.type === 'select' && typeof pjaFillSelect === 'function') pjaFillSelect(f.el, ans);
          // combobox retry: the fiber onChange fired but didn't persist — use the reliable
          // open-menu → type → click-option path (same mechanism that makes country commit).
          else if (f.type === 'combobox' && typeof pjaForceReactSelectCommit === 'function') await pjaForceReactSelectCommit(f.el, ans, { force: /greenhouse\.io/i.test(location.hostname) });
          else if (f.type === 'combobox') await applyComboboxAnswer(f, ans);
          else if ((f.type === 'text' || f.type === 'textarea') && typeof pjaSetNative === 'function') pjaSetNative(f.el, ans);
        } catch (_) {}
        await sleep(250);
      }
      if (window._pjaComboChain && typeof window._pjaComboChain.then === 'function') {
        await Promise.race([window._pjaComboChain.catch(() => {}), new Promise(r => setTimeout(r, 6000))]);
      }
      await sleep(400);
    }
    const remainingAfterAi = collectRequiredEmptyFields(scope);
    if (remainingAfterAi.length) {
      await saveMissingQuestions(remainingAfterAi, job, {
        phase: 'answerer_unresolved',
        attemptedAnswers: answerCache,
        resolverContext,
      });
      await dbg('[ai] unresolved=' + remainingAfterAi.map(f => (f.label || '').slice(0, 18)).join(' | ').slice(0, 120));
    }
    await dbg('[ai] applied=' + applied + ' low=' + low + ' of ' + questions.length);
    return { applied, asked: questions.length, low, unresolved: remainingAfterAi.length };
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

  async function saveMissingQuestions(missing, job, meta = {}) {
    return new Promise(resolve => {
      chrome.storage.local.get('pja_missing_questions', data => {
        const store = data.pja_missing_questions || {};
        for (const f of missing) {
          const normalizedLabel = typeof pjaNormalizeLabel === 'function'
            ? pjaNormalizeLabel(f.label)
            : String(f.label || '').toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 100);
          const resolved = typeof pjaResolveRequiredAnswer === 'function'
            ? pjaResolveRequiredAnswer(f, meta.resolverContext || { profile: (job && job.profile) || pjaRuntimeProfile || {}, answers: pjaRuntimeAnswers || {} })
            : null;
          const key = normalizedLabel;
          if (!store[key]) {
            store[key] = {
              question: f.label,
              rawLabel: f.label,
              normalizedLabel,
              canonicalKey: resolved && resolved.canonicalKey || null,
              ats: (job && (job.ats || job.strategy || job.channel)) || '',
              type: f.type,
              fieldType: f.type,
              options: f.options || [],
              answer: null,
              proposedAnswer: null,
              source: resolved && resolved.source || 'unresolved',
              confidence: resolved && resolved.confidence || 'low',
              sensitive: !!(resolved && resolved.sensitive),
              status: 'needs_user',
              seenCount: 0,
              contexts: [],
              examples: [],
              diagnostics: [],
            };
          }
          store[key].seenCount = (store[key].seenCount || 0) + 1;
          store[key].rawLabel = store[key].rawLabel || f.label;
          store[key].normalizedLabel = store[key].normalizedLabel || normalizedLabel;
          store[key].canonicalKey = store[key].canonicalKey || (resolved && resolved.canonicalKey) || null;
          store[key].ats = store[key].ats || (job && (job.ats || job.strategy || job.channel)) || '';
          store[key].fieldType = store[key].fieldType || f.type;
          store[key].source = resolved && resolved.source !== 'unresolved' ? resolved.source : (store[key].source || 'unresolved');
          store[key].confidence = resolved && resolved.confidence || store[key].confidence || 'low';
          store[key].sensitive = !!(store[key].sensitive || resolved && resolved.sensitive);
          if (resolved && resolved.answer && !store[key].answer && !store[key].proposedAnswer) {
            store[key].proposedAnswer = resolved.answer;
            store[key].status = resolved.confidence === 'high' && !resolved.sensitive ? 'proposed' : 'needs_user';
          }
          const ctx = { jobId: job.jobId || job.id || '', runId: job.runId || '', company: job.company, title: job.title, url: location.href };
          if (!store[key].contexts.find(c => (c.jobId || c.url) === (ctx.jobId || ctx.url))) store[key].contexts.push(ctx);
          store[key].examples = store[key].contexts;
          const attempted = meta.attemptedAnswers && meta.attemptedAnswers[String(f.label || '').toLowerCase().replace(/\s+/g, ' ').trim()];
          const diag = {
            ts: Date.now(),
            phase: meta.phase || sessionStorage.getItem('pja_last_action') || '',
            selector: f.el && (f.el.id ? ('#' + f.el.id) : (f.el.name ? ('[name="' + f.el.name + '"]') : f.el.tagName)) || '',
            attemptedAnswer: attempted || null,
            answerSource: resolved && resolved.source || 'unresolved',
            commitVerified: false,
            visibleError: '',
          };
          store[key].diagnostics = (Array.isArray(store[key].diagnostics) ? store[key].diagnostics : []).slice(-9);
          store[key].diagnostics.push(diag);
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
            const enr = { jobId: job.jobId || job.id, applyUrl: job.applyUrl, location: job.location,
            channel: job.channel || job.ats, runId: job.runId,
            confirmationSource: fields.confirmationSource,
            confirmedAt: fields.confirmedAt };
            for (const k in enr) { if (enr[k] != null && existing[k] == null) existing[k] = enr[k]; }
            existing.updatedAt = Date.now();
          } else {
            log.push({
              company: job.company, title: job.title,
              jobId: job.jobId || job.id || null,
              applyUrl: job.applyUrl || null,
              location: job.location || null,
              channel: job.channel || job.ats || 'external',
              runId: job.runId || null,
              url: (typeof location !== 'undefined' ? location.href.slice(0, 200) : null),
              status: incomingStatus,
              reason: fields.reason || null,
              confirmationSource: fields.confirmationSource || null,
              confirmedAt: fields.confirmedAt || null,
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

  // Pure post-submit success detector (testable). It intentionally requires an explicit
  // confirmation phrase or route. A redirect/form disappearance is useful diagnostic evidence,
  // but is not strong enough to claim that an application was accepted.
  const PJA_SUBMIT_SUCCESS_RE = /thank(?:s| you) for (?:applying|your (?:application|submission))|application (?:received|complete|completed|submitted|confirmed|has been (?:received|submitted|sent|completed)|was (?:received|submitted|sent))|we.?ve received (?:your )?application|we have received (?:your )?application|received your application|submitted successfully|applied successfully|you.?ve applied|you have applied|submission (?:complete|received|successful)|appreciate your application|application confirmation/i;
  function pjaIsSubmitSuccess(snap) {
    snap = snap || {};
    const text = String(snap.text || ''), title = String(snap.title || ''), url = String(snap.url || '');
    // Validation errors commonly re-render the original form alongside static career-site phrases
    // such as "we appreciate your interest." An application form still being present always wins.
    if (snap.hasSubmitButton === true || snap.hasFormFields === true) return false;
    // 1. Confirmation text in title or body (generic + per-ATS phrases via PJAAccount.matchesSuccess,
    // e.g. iCIMS "congratulations", so a real submit isn't misread as submit_unclear).
    const body6k = (title + ' ' + text).slice(0, 6000);
    if (PJA_SUBMIT_SUCCESS_RE.test(body6k)) return true;
    // Lever sometimes lands on a minimal post-submit page whose only visible controls are
    // "Return to the main page", company-home, and "Jobs powered by". That page is ambiguous
    // in isolation, so accept it ONLY when this same run just clicked Submit and the form is gone.
    if (snap.priorSubmit === true && /jobs\.lever\.co/i.test(url) &&
        /return to (?:the )?main page|jobs powered by/i.test(body6k)) return true;
    try {
      if (typeof window.PJAAccount !== 'undefined' && window.PJAAccount.matchesSuccess) {
        const ats = (typeof window.PJADetectAts !== 'undefined' && window.PJADetectAts.detectAts) ? window.PJADetectAts.detectAts(url) : '';
        if (window.PJAAccount.matchesSuccess(body6k, ats)) return true;
      }
    } catch (_) {}
    // 2. Landed on a confirmation/post-apply PATH. Never scan the hostname: otherwise every
    // successfactors.com apply URL is a false positive merely because its domain contains "success".
    let path = '';
    try { path = new URL(url).pathname; } catch (_) { path = url.replace(/[?#].*$/, ''); }
    if (/(?:^|\/)(?:thank(?:-?you)?|confirm(?:ation)?|success|submitted|post-?apply|application[-_]?(?:complete|received|confirmation|success)|applied)(?:\/|$)/i.test(path)) return true;
    return false;
  }
  if (typeof window !== 'undefined') window.pjaIsSubmitSuccess = pjaIsSubmitSuccess;

  function pjaSameQueuedJob(a, b) {
    if (!a || !b) return false;
    const aid = String(a.id || a.jobId || ''), bid = String(b.id || b.jobId || '');
    if (aid && bid) return aid === bid;
    return !!a.applyUrl && !!b.applyUrl && String(a.applyUrl) === String(b.applyUrl);
  }
  if (typeof window !== 'undefined') window.pjaSameQueuedJob = pjaSameQueuedJob;

  function pjaDiagnosticText(value, max = 180) {
    return String(value || '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g, '[phone]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function inferDiagnosticPhase(reason) {
    const r = String(reason || '').toLowerCase();
    if (/posting_not_found|no_apply|apply_btn_no_form/.test(r)) return 'preflight';
    if (/missing_required|selectinput|needs_manual/.test(r)) return 'required_field_check';
    if (/resume/.test(r)) return 'resume_upload';
    if (/submit|captcha|email_verification|transport/.test(r)) return 'post_submit_confirmation';
    if (/watchdog|stuck/.test(r)) return 'watchdog';
    return 'fill';
  }

  async function buildTerminalApplyDiagnostic(job, result, applicationAt) {
    const reason = result && result.reason || '';
    const dom = collectApplyDomSummary();
    const missing = Array.from(new Set([
      ...(Array.isArray(result && result.fields) ? result.fields : []),
      ...(Array.isArray(dom && dom.required) ? dom.required.map(m => m && (m.label || m.name || m.type || '')).filter(Boolean) : []),
    ].map(x => pjaDiagnosticText(x, 140)).filter(Boolean))).slice(0, 30);
    const controls = Array.isArray(dom && dom.controls) ? dom.controls : [];
    const controlCounts = {};
    for (const c of controls) {
      const key = [String(c.tag || '').toLowerCase(), String(c.type || c.role || '').toLowerCase()].filter(Boolean).join(':') || 'unknown';
      controlCounts[key] = (controlCounts[key] || 0) + 1;
    }
    const submitButtons = controls
      .filter(c => /button|submit/i.test(String(c.tag || '') + ' ' + String(c.type || '') + ' ' + String(c.role || '') + ' ' + String(c.text || '')))
      .map(c => pjaDiagnosticText(c.text || c.name || c.id || '', 120))
      .filter(Boolean)
      .slice(0, 12);
    const radioGroups = (() => {
      try {
        const groups = {};
        for (const input of pjaQueryAllExt('input[type="radio"]')) {
          const name = input.name || input.id || 'radio';
          let label = input.getAttribute('aria-label') || '';
          try { if (!label && input.id) label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent || ''; } catch (_) {}
          label = label || input.closest('label')?.textContent || input.parentElement?.textContent || input.value || '';
          const g = groups[name] || { name: pjaDiagnosticText(name, 100), checked: 0, options: [] };
          if (input.checked) g.checked++;
          if (g.options.length < 8) g.options.push(pjaDiagnosticText(label, 100));
          groups[name] = g;
        }
        return Object.values(groups).slice(0, 12);
      } catch (_) {
        return [];
      }
    })();
    let recovery = [];
    try {
      const rlog = await new Promise(resolve => chrome.storage.local.get('pja_recovery_log', d => resolve(Array.isArray(d.pja_recovery_log) ? d.pja_recovery_log : [])));
      const jid = String(job.id || job.jobId || '');
      recovery = rlog.filter(x => x && x.runId === (job.runId || '') &&
        (String(x.jobId || '') === jid || (x.company === job.company && x.title === job.title))).slice(-6);
    } catch (_) {}
    const visibleErrors = Array.from(new Set([
      ...(Array.isArray(dom && dom.errors) ? dom.errors : []),
      ...(result && result.diagnostic && Array.isArray(result.diagnostic.visibleErrors) ? result.diagnostic.visibleErrors : []),
    ].map(x => pjaDiagnosticText(x, 180)).filter(Boolean))).slice(0, 30);
    return {
      schemaVersion: 1,
      runId: job.runId || '',
      jobId: job.jobId || job.id || '',
      company: pjaDiagnosticText(job.company, 120),
      title: pjaDiagnosticText(job.title, 160),
      ats: pjaDiagnosticText(job.ats || job.strategy || '', 80),
      strategy: pjaDiagnosticText(job.strategy || job.ats || '', 80),
      channel: pjaDiagnosticText(job.channel || job.ats || 'external', 80),
      applyUrl: pjaDiagnosticText(job.applyUrl || location.href, 260),
      url: pjaDiagnosticText(location.href, 260),
      hostname: location.hostname,
      phase: inferDiagnosticPhase(reason),
      reason: pjaDiagnosticText(reason, 100),
      missingRequired: missing,
      visibleErrors,
      formSummary: pjaDiagnosticText(`controls=${controls.length} missing=${missing.length} errors=${visibleErrors.length} title=${document.title || ''}`, 320),
      controlCounts,
      submitButtons,
      radioGroups,
      recovery,
      stepLog: await readRecentDbg(),
      applicationAt,
      capturedAt: Date.now(),
    };
  }

  async function persistTerminalApplyDiagnostic(job, diagnostic) {
    if (!diagnostic) return null;
    try {
      await new Promise(resolve => chrome.storage.local.get('pja_apply_diagnostics', d => {
        const list = (Array.isArray(d.pja_apply_diagnostics) ? d.pja_apply_diagnostics : []).slice(-199);
        const key = [diagnostic.runId || '', diagnostic.jobId || '', diagnostic.applyUrl || '', diagnostic.reason || '', diagnostic.phase || ''].join('::');
        const existing = list.findIndex(x => [x.runId || '', x.jobId || '', x.applyUrl || '', x.reason || '', x.phase || ''].join('::') === key);
        if (existing >= 0) list[existing] = diagnostic;
        else list.push(diagnostic);
        chrome.storage.local.set({
          pja_apply_diagnostics: list,
          pja_last_apply_failure: { ...diagnostic, ts: Date.now() },
        }, resolve);
      }));
    } catch (_) {}
    return diagnostic;
  }

  async function recordResult(job, result) {
    console.log('PJA ext-apply RESULT:', job.company, result.success ? '✓ APPLIED' : '✗ SKIP:', result.reason || '', result.fields?.join('; ') || '');
    // A recovered/reopened tab can finish after another tab or the service-worker watchdog has
    // already advanced the queue. Never let that stale result append duplicates, mutate corpus
    // state, or advance the NEW current job (observed after queue recovery: 27 skips for 21 jobs).
    const ownership = await new Promise(resolve => chrome.storage.local.get(['pja_ext_queue', 'pja_ext_current'], d => {
      const q = d.pja_ext_queue, current = q && q.jobs && q.jobs[q.currentIndex];
      const queueOwns = !!q && q.status === 'applying' && pjaSameQueuedJob(current, job);
      const currentOwns = pjaSameQueuedJob(d.pja_ext_current, job);
      // Ranked apply uses one-job queues and may repoint pja_ext_current during dispatcher
      // recovery/reload. The queue is the durable owner for result recording; requiring both
      // keys to match caused valid terminal results (captcha/missing_required) to be ignored,
      // leaving pja_ext_queue stuck on the old job.
      resolve({ owns: queueOwns && (currentOwns || !!job.rankedRun), handled: currentOwns && !!d.pja_ext_current?._handled });
    }));
    if (!ownership.owns || ownership.handled) {
      console.log('PJA ext-apply: stale/duplicate result ignored', job.company, job.title);
      return;
    }
    // Mark handled only after the outcome was verified. This flag used to be written before the
    // click, which allowed a bare navigation to become a false positive on reload.
    const applicationAt = job._submitStartedAt || Date.now();
    job._handled = true;
    if (result.success) {
      job._confirmationSource = 'page';
      job._confirmedAt = Date.now();
    }
    delete job._submitPending;
    delete job._preSubmitUrl;
    delete job._submitStartedAt;
    await new Promise(resolve => chrome.storage.local.set({ pja_ext_current: job }, () => {
      if (chrome.runtime.lastError) console.warn('PJA ext-apply: current result write failed', chrome.runtime.lastError.message);
      resolve();
    }));

    const alreadyApplied = /^already_applied\b/i.test(String(result.reason || ''));
    let terminalDiagnostic = null;
    if (!result.success && !alreadyApplied) {
      terminalDiagnostic = result.diagnostic && result.diagnostic.schemaVersion
        ? result.diagnostic
        : await buildTerminalApplyDiagnostic(job, result, applicationAt);
      await persistTerminalApplyDiagnostic(job, terminalDiagnostic);
      result.diagnostic = terminalDiagnostic;
    }

    // Persist successful applies — and prior-session already-applied detections — to a DURABLE log
    // (pja_ext_queue gets overwritten each run, so sourcing dedupe needs this to avoid re-surfacing
    // the same roles). Prior-session already_applied is not counted as a new confirmed submission.
    if (result.success || alreadyApplied) {
      await pjaWriteAppliedLog(job, { status: 'applied', reason: result.reason,
        confirmationSource: result.success ? 'page' : 'prior_session',
        confirmedAt: result.success ? job._confirmedAt : null });
    }

    const uncertain = /unconfirmed|unclear|assumed|inferred/i.test(String(result.reason || ''));
    const pending = /ready_to_submit/i.test(String(result.reason || ''));
    const ledgerEvent = {
        runId: job.runId || null, jobId: job.jobId || job.id || null,
        applyUrl: job.applyUrl || location.href, company: job.company, title: job.title,
        channel: job.channel || job.ats || 'external',
        status: result.success ? 'applied' : alreadyApplied ? 'skipped' : pending ? 'pending' : uncertain ? 'submitted' : 'failed',
        success: result.success ? true : (uncertain || pending ? null : false), reason: result.reason || '',
        confirmationSource: result.success ? 'page' : null,
        confirmedAt: result.success ? job._confirmedAt : null,
        diagnostic: terminalDiagnostic,
        applicationAt, occurredAt: Date.now()
      };

    // Write the outcome back into the corpus (pja_job_state) so the pool reflects progress and
    // re-runs are idempotent. Fire-and-forget; background maps the reason via PJAApplySelect and
    // skips jobs that aren't in the corpus (non-corpus queues are a no-op).
    try {
      chrome.runtime.sendMessage({
        type: 'UPDATE_CORPUS_STATE',
        id: job.id,
        runId: job.runId,
        reason: result.success ? 'applied' : (result.reason || 'unknown'),
      }, () => void chrome.runtime.lastError);
    } catch (_) {}

    return new Promise(resolve => {
      chrome.storage.local.get('pja_ext_queue', data => {
        const queue = data.pja_ext_queue;
        if (!queue) {
          try { chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', event: ledgerEvent, closeTab: !!job.rankedRun }, () => void chrome.runtime.lastError); } catch (_) {}
          resolve(); return;
        }
        // Guard against overwriting a new queue that was seeded while this run was in progress.
        if (queue.runId && job.runId && queue.runId !== job.runId) {
          console.log('PJA ext-apply: runId mismatch in recordResult, not writing', job.runId, '→', queue.runId);
          resolve(); return;
        }

        // Normalize results to {applied, skipped} object regardless of how queue was seeded
        if (!queue.results || Array.isArray(queue.results)) queue.results = { applied: [], skipped: [] };
        const r = queue.results;
        if (result.success) {
          r.applied.push({ ...pjaSanitizeResultJob(job), appliedAt: Date.now() });
        } else {
          const skipped = { ...pjaSanitizeResultJob(job), skipReason: result.fields?.slice(0, 3).join('; ') || result.reason };
          if (result.diagnostic) skipped.diagnostic = result.diagnostic;
          r.skipped.push(skipped);
        }

        queue.currentIndex++;
        if (queue.currentIndex >= queue.jobs.length) queue.status = 'done';

        chrome.storage.local.set({ pja_ext_queue: queue }, () => {
          if (chrome.runtime.lastError) {
            console.warn('PJA ext-apply: queue result write failed', chrome.runtime.lastError.message);
            try { addDbg('[result] queue write failed: ' + chrome.runtime.lastError.message.slice(0, 120)); } catch (_) {}
          }
          // Signal the global ranked dispatcher only after this one-job queue is durably finished;
          // otherwise its next queue could be overwritten by this callback.
          try { chrome.runtime.sendMessage({ type: 'APPLICATION_LEDGER_EVENT', event: ledgerEvent, closeTab: !!job.rankedRun }, () => void chrome.runtime.lastError); } catch (_) {}
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
    // The central ranked dispatcher owns cross-job navigation and will close this one-job tab after
    // its ledger event. Never race it by reading/reusing the next queue from this page.
    if (job && job.rankedRun) return;
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
            runId: queue.runId || job.runId || '',
            returnUrl: job.returnUrl || 'https://www.linkedin.com/jobs/search/?f_AL=true'
          };
          chrome.storage.local.set({ pja_ext_current: nextCurrent, pja_navigate_to: nextJob.applyUrl }, () => {
            // Let the service worker update the owning tab. Cross-origin embedded ATS frames can
            // silently fail to assign window.top.location, leaving the queue stuck between jobs.
            try {
              chrome.runtime.sendMessage({ type: 'OPEN_EXT_NEXT', url: nextJob.applyUrl }, resp => {
                if (chrome.runtime.lastError || !resp?.ok) { try { window.top.location.href = nextJob.applyUrl; } catch (_) {} }
              });
            } catch (_) { try { window.top.location.href = nextJob.applyUrl; } catch (_) {} }
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
      chrome.storage.local.remove('pja_navigate_to', () => { window.top.location.href = url; });
    });
  }
})();
