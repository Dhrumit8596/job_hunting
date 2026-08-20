'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

module.exports = async (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const dev = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
  t.ok(source.includes("attempt ? where + '-retry' : where") &&
    source.includes('/debugger is not attached/i.test(message)') &&
    source.includes("pjaWithCdpDetachedRetry(tabId, 'key-activate'") &&
    source.includes("msg.type === 'LINKEDIN_TRUSTED_KEY_ACTIVATE'") &&
    source.includes('recovered: !!result?.recovered'),
  'LinkedIn trusted mouse/key activation shares one detached-CDP retry and reports recovery');
  t.ok(source.includes("'content/apply-router.js'") &&
    source.includes('const PJA_RANKED_LAUNCHERS = {') &&
    source.includes('async function pjaDispatchRankedJob(job, master)') &&
    source.includes('self.PJAApplyRouter.resolveStrategy(job, job.applyUrl)') &&
    source.includes('const tabId = await pjaDispatchRankedJob(job, master);'),
  'ranked dispatch: one executable router selects and launches every channel/ATS strategy');
  t.ok(source.includes('function pjaRankedTabMatchesJob(tab, job)') &&
    source.includes('tabUrl.hostname !== applyUrl.hostname') &&
    source.includes('const tabLinkedInId = self.PJAApplySelect?.linkedinJobId(tab.url') &&
    source.includes('return tabLinkedInId === jobLinkedInId') &&
    source.includes('Same-host Workday tabs are valid') &&
    source.includes('async function pjaRankedTabExists(tabId, job)') &&
    source.includes('chrome.tabs.get(tabId') &&
    source.includes('async function pjaHandleRankedMissingTab(master, source)') &&
    source.includes('one bounded relaunch') &&
    source.includes("const reason = 'no_active_tab_pre_submit'") &&
    source.includes('submitAttempted: false') &&
    source.includes('master.inFlightIndex = null') &&
    source.includes('master.inFlightTabId = null'),
  'ranked dispatch: a missing in-flight tab gets one pre-submit relaunch and then an explicit terminal event');

  t.ok(source.includes('reconciling stale currentIndex') &&
    source.includes("reason: 'stale_inflight_reconciled'") &&
    source.includes('master.currentIndex = matchIndex'),
  'ranked dispatch: terminal event for a later active job reconciles stale currentIndex instead of being ignored');

  t.ok(source.includes('async function pjaReconcileRankedExtCurrent(master)') &&
    source.includes('reconciling ext_current ahead of master') &&
    source.includes("['pja_ranked_apply', PJA_APPLICATION_LEDGER_KEY]") &&
    source.includes('master = await pjaReconcileRankedLedger(master') &&
    source.includes("const reason = 'ownership_lost_ext_current_advanced'") &&
    source.includes('master.results.skipped.push') &&
    source.includes('master.inFlightIndex = curIndex') &&
    source.includes('master = await pjaReconcileRankedExtCurrent(master)'),
  'ranked dispatch: pja_ext_current handoff rechecks durable ledger/master ownership before a manual skip');

  t.ok(source.includes('async function pjaRankedExternalApplyLoaded(tabId)') &&
    source.includes('window.__pjaExtApplyLoaded === true') &&
    source.includes('if (await pjaRankedExternalApplyLoaded(tabId)) return;') &&
    source.includes('Only repair a genuinely') && source.includes('missing content script'),
  'ranked dispatch: delayed reinjection never starts a second handler over a live content script');

  t.ok(source.includes('chrome.runtime.lastError') &&
    source.includes('external queue seed verification failed') &&
    source.includes('Retry each key separately') &&
    source.includes('pjaSameRankedJob(job, retry.pja_ext_current)'),
  'ranked dispatch: external launch verifies pja_ext_queue/current before opening an ATS tab');

  t.ok(source.includes('async function pjaReconcileRankedLedger(master, ledger)') &&
    source.includes('pjaRankedApplyTerminal(master, job, event)') &&
    source.includes('ledger_reconcile_gap') &&
    source.includes('master.currentIndex = idx + 1') &&
    source.includes('ranked = await pjaReconcileRankedLedger(ranked'),
  'ranked dispatch: terminal ledger events are replayed into pja_ranked_apply if master advance was missed');

  t.ok(source.includes('PJA_LAST_COMPLETED_APPLY_RUN_KEY') &&
    source.includes('pja_last_completed_apply_run') &&
    source.includes('async function pjaPersistCompletedRankedRun(master') &&
    source.includes('pjaCompactCompletedRankedRun(master') &&
    source.includes('await pjaPersistCompletedRankedRun(master'),
  'ranked dispatch: terminal runs persist a compact completed-run snapshot for status/report export after queue cleanup');

  t.ok(source.includes('function pjaRankedStopsOnTarget(master)') &&
    source.includes("master.runMode === 'all_above_score'") &&
    source.includes('pjaRankedStopsOnTarget(master) && master.remaining != null') &&
    source.includes('pjaRankedStopsOnTarget(master) && audit.counts.confirmed >= dailyTarget'),
  'ranked dispatch: all-above-score runs do not stop on the target-confirmed counter');

  t.ok(source.includes('async function pjaCloseRankedTab(tabId)') &&
    source.includes('const result = { tabId: tabId == null ? null : tabId, closed: false }') &&
    source.includes('master.tabCleanup = await pjaCloseRankedTab(tabToClose)') &&
    source.includes('master.lastTabCleanup = await pjaCloseRankedTab(tabToClose)'),
  'ranked dispatch: tab closure returns cleanup diagnostics and is recorded on ranked runs');

  t.ok(source.includes("event.reason || 'ready_to_submit_review'") &&
    source.includes("!/^(submitting|pending|queued|started|in_progress)$/.test(e.status)") &&
    source.includes("/^(submitting|pending|queued|started|in_progress)$/.test(event.status) && !/ready_to_submit/i.test(event.reason || '')") &&
    source.includes("ready_to_submit/i.test(event.reason || '')"),
  'ranked dispatch: stop-before-submit ready_to_submit_review is terminal, not an ignored pending event');

  t.ok(source.includes('function pjaRankedTenantBlockedHosts(master)') &&
    source.includes("workday_duplicate_record_same_tenant") &&
    source.includes("workday_captcha_same_tenant") &&
    source.includes("duplicateBlockedHosts.has(pjaRankedApplyHostname(master.jobs[master.currentIndex].applyUrl))"),
  'ranked dispatch: Workday tenant-level duplicate/captcha blockers skip remaining jobs on the same tenant');

  t.ok(source.includes('attemptedRecords: opts && opts.unattemptedOnly === true ? ledgerEvents : []') &&
    source.includes('unattemptedOnly: opts && opts.unattemptedOnly === true') &&
    source.includes('e2eSafe: !!(master && master.e2eSafe)') &&
    source.includes('unattemptedOnly: !!(master && master.unattemptedOnly)') &&
    source.includes('e2eSafe: !!run.e2eSafe') &&
    source.includes('unattemptedOnly: !!run.unattemptedOnly') &&
    dev.includes('const unattemptedOnly = o.unattemptedOnly === true;') &&
    dev.includes('retryBlockedHosts: Array.isArray(o.retryBlockedHosts) ? o.retryBlockedHosts : [],\n          unattemptedOnly,') &&
    dev.includes('unattemptedOnly: options.unattemptedOnly === true') &&
    dev.includes("First-attempt-only: ${ranked.unattemptedOnly === true ? 'yes' : 'no'}") &&
    dev.includes('stopBeforeSubmit, e2eSafe, unattemptedOnly'),
  'ranked planning: explicit first-attempt-only runs exclude prior identities and remain auditable without changing generic e2e-safe retries');

  const exactCandidateGate = dev.indexOf('PlanningDiagnostics.exactCandidateFailure({');
  const rankedStart = dev.indexOf("wsAsk('startRankedApply'");
  t.ok(dev.includes('requireExactCandidateIds: o.requireExactCandidateIds === true') &&
    dev.includes('ScoringFrontier.exactCandidateIdMembership(candidateIds, jobs)') &&
    dev.includes('if (!dryRun && requireExactCandidateIds && !candidateSelection.exact)') &&
    dev.includes("status: 'exact_candidate_ids_blocked'") &&
    exactCandidateGate >= 0 && rankedStart > exactCandidateGate &&
    dev.includes('requireExactCandidateIds, candidateSelection,') &&
    dev.includes('Exact candidate IDs: required; requested'),
  'ranked planning: opt-in exact candidate IDs refuse a partial live queue before start and remain visible in plans/reports');
  t.ok(source.includes("'apply-planning-diagnostics.js'") &&
    dev.includes('PlanningDiagnostics.compactWorkerFailure(applyResp.data)') &&
    dev.includes('JSON.stringify({ success: false, runId: requestedRunId, ...planningFailure })') &&
    dev.includes('PlanningDiagnostics.compactWorkerFailure(worker.data)') &&
    dev.includes('Object.assign(terminalPatch, ownedPlanningFailure)') &&
    source.includes('self.PJAPlanningDiagnostics.compactWorkerFailure(run)') &&
    dev.includes('const planningFailure = PlanningDiagnostics.compactWorkerFailure(ranked)') &&
    dev.includes('...(planningFailure || {})'),
  'ranked planning: sanitized exact-ID and scoring diagnostics survive internal bubbling, durable ownership, and exact-run observation');

  t.ok(dev.includes('(!requireEvidence || ScoringEvidence.isQualifyingTransferability(j))') &&
    dev.includes("reason = 'rescore_stretch_transferability'") &&
    dev.includes('stretch_transferability|below_threshold'),
  'ranked planning: evidence-required runs reject stretch transferability with an explicit planning-drop reason');

  t.ok(source.includes('async function pjaRecoverRankedLastFailure(master)') &&
    source.includes("recoveredReason = isSuccessFactors && reason === 'no_submit_btn' ? 'no_apply_path' : reason") &&
    source.includes('workday_duplicate_record|workday_account_locked') &&
    source.includes('stuck_budget|handler_timeout|watchdog_timeout|stuck_watchdog') &&
    source.includes('await pjaAppendApplicationEvent(event)') &&
    source.includes('master = await pjaRecoverRankedLastFailure(master)'),
  'ranked dispatch: resume recovers SuccessFactors landing-page no-submit failures as terminal no_apply_path events');

  t.ok(source.includes("['pja_ext_current', 'pja_wd_auth_diag', 'pja_dbg_workday_auth', workdaySubmitKey]") &&
    source.includes('current._submitPending') &&
    source.includes('workdaySubmitAt >= Number(ranked.inFlightAt || 0)') &&
    source.includes('classifyMissingTabOutcome(stuck, {') &&
    source.includes('const preSubmitProven = timeoutOutcome.kind') &&
    source.includes("preSubmitProven ? 'ranked_watchdog_timeout' : 'submit_observation_timeout'") &&
    source.includes("status: preSubmitProven ? 'failed' : 'submitted'") &&
    source.includes('success: preSubmitProven ? false : null') &&
    source.includes('submitAttempted: submitPending ? true : preSubmitProven ? false : null') &&
    source.includes('diagnosticOwnsRankedJob(authDiag, ranked, stuck)') &&
    source.includes('diagnosticOwnsRankedJob(authResult, ranked, stuck)'),
  'ranked watchdog: only exact durable pre-submit phase may fail; pending or unknown outcomes remain unverified for every ATS');

  t.ok(source.includes('ranked application tab disappeared after durable submit evidence') &&
    source.includes('ranked application tab disappeared without durable pre-submit phase evidence') &&
    source.includes("status: 'submitted', success: null, reason,") &&
    source.includes('submitAttempted: submitPending ? true : null') &&
    source.includes('phase: currentMatches ? current._applyPhase') &&
    source.includes('handled: !!(currentMatches && current._handled)') &&
    source.includes('String(current.runId || \'\') === String(master.runId || \'\')') &&
    source.includes('submit_observation_timeout') &&
    source.includes('tab_lost_outcome_unknown') &&
    source.includes("phase: 'submit_observation'") &&
    source.includes("const reason = 'no_active_tab_pre_submit'"),
  'ranked missing-tab recovery never relaunches a job after durable submit evidence');

  t.ok(source.includes('function pjaMergeProfileWrite(previous, incoming') &&
    source.includes('rejected_empty_profile_overwrite') &&
    source.includes('rejected_required_profile_field_deletion') &&
    source.includes('pja_profile_backup') &&
    source.includes('pja_profile_write_audit') &&
    source.includes('pjaSafeSetStorageFromExternal(msg.data'),
  'profile storage: background guards external/full-profile writes with merge, backup, audit, and empty-overwrite rejection');

  t.ok(source.includes("PJAIdb.getApplyPlanningCorpus(), 45000, 'PJAIdb.getApplyPlanningCorpus'") &&
    source.includes("chrome.storage applied records"),
  'ranked dispatch: apply-set uses a bounded compact corpus read so description-rich IDB data cannot wedge /apply-run');

  t.ok(source.includes("msg.cmd === 'getApplyDescriptions'") &&
    source.includes(".slice(0, 10)") && source.includes("getApplyDescriptions(ids)"),
  'ranked dispatch: description hydration is enforced as capped ten-job batches');

  t.ok(source.includes("msg.cmd === 'getSupplyAuditCorpus'") &&
    source.includes("getApplyPlanningCorpus()") && source.includes("supplyAuditCorpusReply"),
  'ranked dispatch: supply audit uses the description-free whole-corpus projection');

  t.ok(source.includes("msg.cmd === 'getBrowserShortlist'") &&
    source.includes('needsAtsResolution: !!j.needsAtsResolution') &&
    source.includes('routeResolutionAttempts: Number(j.routeResolutionAttempts) || 0') &&
    source.includes('routeResolutionAttemptedAt: j.routeResolutionAttemptedAt') &&
    source.includes("routeLandingStatus: j.routeLandingStatus || ''") &&
    source.includes('routeLandingAttempts: Number(j.routeLandingAttempts) || 0') &&
    source.includes('routeLandingAttemptedAt: j.routeLandingAttemptedAt') &&
    source.includes("hydrationStatus: j.hydrationStatus || ''") &&
    source.includes("hydrationReason: j.hydrationReason || ''") &&
    source.includes('hydrationAttempts: Number(j.hydrationAttempts) || 0') &&
    source.includes('firstDiscoveredAt: j.firstDiscoveredAt || j.discoveredAt') &&
    source.includes('lastSeenAt: j.lastSeenAt || j.scrapedAt || j.discoveredAt') &&
    source.includes('j.matchedQueries.slice(0, 20)') && source.includes('j.sourcePages.slice(-40)'),
  'browser shortlist: bounded projection preserves immutable discovery and current rediscovery provenance');

  t.ok(dev.includes('const linkedInHydrationCandidates = browserJobs.filter') &&
    dev.includes('selectHydrationFrontier(linkedInHydrationCandidates') &&
    dev.includes(': 50,') && dev.includes('browserRouteRetryCooldownMs') &&
    dev.includes('browserHydrationRetryCooldownMs') &&
    source.includes("Object.prototype.hasOwnProperty.call(result.applyUrls, id)") &&
    source.includes("if (platform !== 'linkedin' || !requested.has(id)) return job") &&
    source.includes('isVoyagerPostingSpecificRoute(route, routeStrategy)') &&
    source.includes('safeUnresolvedLandingUrl(route)') &&
    source.includes("resolutionMethod: 'linkedin_voyager_offsite_landing'") &&
    source.includes("resolutionConfidence: 'lookup_only'") &&
    source.includes('if (!route && !description) return patch') &&
    source.includes("msg.cmd === 'persistBrowserRouteInspection'") &&
    source.includes('self.PJABrowserBatch.mergeRouteInspection') &&
    dev.includes("wsAsk('persistBrowserRouteInspection'") &&
    dev.includes("'persistBrowserRouteInspectionReply'") &&
    dev.includes("SourceSafety.sourceError('route_inspection_persistence_failed'") &&
    source.includes('routeResolutionStatus: supportedRoute ? \'resolved\' : \'unresolved\'') &&
    source.includes("'voyager_destination_not_supported'") &&
    source.includes('self.PJAApplySelect.applyCapabilityStatus(route, routeStrategy)') &&
    source.includes('voyagerDestinationsObserved'),
  'browser enrichment: LinkedIn is filtered before the fifty-row frontier and every null/unsupported route is durably backed off');

  t.ok(source.includes("'pja_discovery_scan_tabs'") &&
    source.includes("chrome.tabs.create({ url: scanUrl, active: true }") &&
    source.includes('chrome.tabs.remove(priorId, () => createOwned())') &&
    source.includes('window.__pjaStartIndeedScan(scanOptions || {})') &&
    source.includes('window.__pjaStartScan({ ...(scanOptions || {}), fast })') &&
    source.includes('pja_linkedin_scan') &&
    source.includes("current && current.status === 'complete'") &&
    source.includes("files: ['browser-batch.js', 'content/job-scraper.js']") &&
    source.includes("state.error === 'scanner_not_loaded'") &&
    !source.includes('}, 4500);'),
  'browser discovery: owned tabs are reused and scanners launch without an MV3-vulnerable delay');

  t.ok(source.includes('const count = await self.PJAIdb.count()') &&
    !source.includes('const s = await self.PJAIdb.corpusSummary({ topN: 0 })'),
  'corpus import: post-import bookkeeping uses a native count instead of another full diagnostic scan');

  t.ok(dev.includes('transientStorageRead: true') && dev.includes('if (!storageReadObserved && runtimeHasCandidateProfile)'),
  'candidate preflight: a transient extension reconnect timeout cannot erase a previously verified runtime profile');

  t.ok(dev.includes('preflightHealth: admissionPreflight ? {') &&
    dev.includes('ApplyReportHealth.resolveReportHealth(storage || {}, runControl)') &&
    dev.includes('Profile/resume health source: successful admission preflight'),
  'exact-run report: successful admission health survives a sparse terminal storage export');

  const exactStatus = dev.slice(dev.indexOf("if (req.method === 'GET' && runStatusMatch)"),
    dev.indexOf("if (req.method === 'GET' && runEventsMatch)"));
  t.ok(source.includes("msg.cmd === 'getApplyRunSnapshot'") &&
    source.includes('pjaCompactObservedApplyRun') && source.includes('pjaCompactObservedRunEvents') &&
    source.includes("cmd: 'applyRunSnapshotReply'") &&
    dev.includes("wsAsk('getApplyRunSnapshot'") &&
    exactStatus.includes("code: 'application_run_state_unavailable'") &&
    exactStatus.includes('res.writeHead(503, CORS)') &&
    exactStatus.includes("'pja_profile'") && exactStatus.includes("'pja_resume_filename'") &&
    exactStatus.includes('writeApplyRunReport(reportStorage || {}, { runId })'),
  'exact-run observer returns compact owned state, retries transport gaps, and exports only from observed detail');

  t.ok(source.includes("const PJA_RUNTIME_BUILD = 'apply-observer-v5'") &&
    source.includes("msg.cmd === 'pingExtension'") && source.includes("cmd: 'pingExtensionReply'") &&
    dev.includes("wsAsk('pingExtension'") && dev.includes('extensionResponsive:') &&
    dev.includes('extensionBuild:'),
  'health: connected and command-responsive extension state are reported separately with a build marker');

  t.ok(source.includes("msg.cmd === 'getSourcingStorageSnapshot'") &&
    source.includes('compactSourcingStorage(storage || {})') &&
    source.includes("cmd: 'sourcingStorageSnapshotReply'") &&
    dev.includes("wsAsk('getSourcingStorageSnapshot'") &&
    dev.includes('getSourcingStorageFromExtension(timeoutMs)'),
  'sourcing observer: profile/dedupe state is compacted inside the worker before WebSocket transfer');

  t.ok(source.includes('Acknowledge the durable run install before network/tab launch work') &&
    source.includes('setTimeout(() => {') && source.includes('pjaDispatchRankedCurrent(msg.master).catch'),
  'ranked dispatch: start acknowledgement is not held hostage by slow reachability/tab-launch work');

  t.ok(source.includes("msg.type === 'REQUEST_APPLY_HELP'") &&
    source.includes('chrome.tabs.captureVisibleTab') &&
    source.includes("format: 'jpeg', quality: 45") &&
    source.includes('payload.screenshot') &&
    source.includes('dataUrl.length > 600000'),
  'background: apply-help captures a bounded screenshot for LLM recovery mode');

  t.ok(source.includes("msg.cmd === 'resetCorpusJobs'") &&
    source.includes("new Error(label + ' timed out')") &&
    source.includes('pja_reset_corpus_jobs_error') &&
    source.includes('resetCorpusJobsReply') &&
    source.includes('{ reset, errors }'),
  'background: reset-corpus-jobs is bounded and returns diagnostics instead of hanging');

  t.ok(source.includes("msg.type === 'CAPTURE_APPLY_DIAGNOSTIC'") &&
    source.includes('pja_last_post_click_diagnostic') &&
    source.includes('pja_post_click_diagnostics') &&
    source.includes('pja_apply_diagnostics') &&
    source.includes('chrome.tabs.captureVisibleTab') &&
    source.includes('dataUrl.length > 650000') &&
    source.includes('[diag] captured post-click'),
  'background: post-click submit diagnostics persist bounded screenshot plus compact history');

  t.ok(source.includes('function pjaCompactApplyDiagnostic(value)') &&
    source.includes('const diagnostic = pjaCompactApplyDiagnostic(event.diagnostic || job.diagnostic || null)') &&
    source.includes('diagnostic: pjaCompactApplyDiagnostic(failure)') &&
    source.includes('submit_unclear|submit_observation_timeout') &&
    source.includes('workday_transport_failure|missing_required|needs_manual'),
  'ranked dispatch: per-job diagnostics survive ledger reconciliation, resume recovery, and completed-run snapshots');

  t.ok(source.includes("chrome.tabs.create({ url: 'about:blank', active: true }") &&
    source.includes("pja_email_code_session") &&
    source.includes("chrome.tabs.update(tab.id, { url: gmailUrl })") &&
    source.includes("msg.type === 'CANCEL_EMAIL_CODE_SESSION'"),
  'background: generic Gmail code recovery stores session before Gmail navigation and supports cleanup');

  t.ok(source.includes('async function pjaEmailCodeOwnerIsCurrent(owner)') &&
    source.includes("sessionId: 'emailcode-'") &&
    source.includes("runId: String(msg.runId || '')") &&
    source.includes("jobId: String(msg.jobId || '')") &&
    source.includes("applyUrl: String(msg.applyUrl || '')") &&
    source.includes('sessionId: session.sessionId') &&
    source.includes("reason: 'stale_email_code_session'") &&
    source.includes('pjaEmailCodeResult(session,') &&
    source.includes('String(session.sessionId || \'\') !== String(msg.sessionId)') &&
    source.includes('await pjaRemoveEmailCodeSession(session)'),
  'background: generic Gmail code open/result/cancel is scoped to an immutable session plus exact application owner');

  t.ok(source.includes('const isWorkdaySession = !!(workdaySession && workdaySession.gmailTabId === tabId)') &&
    source.includes('emailCodeSession && emailCodeSession.gmailTabId === tabId') &&
    source.includes('if (!session) return;'),
  'background: simultaneous Workday and generic Gmail sessions are selected by exact Gmail tab rather than key precedence');

  t.ok(source.includes('sameApplyTab && sameJob && applyTabAlive') &&
    source.includes("reason: 'stale_gmail_tab'") &&
    source.includes('await pjaRemoveEmailCodeSession(session)') &&
    source.includes('await pjaRemoveEmailCodeSession(existing)'),
  'background: generic Gmail code recovery replaces abandoned sessions and ignores stale Gmail tabs');

  const gmailSource = fs.readFileSync(path.join(ROOT, 'content/gmail-verify.js'), 'utf8');
  const externalSource = fs.readFileSync(path.join(ROOT, 'content/external-apply.js'), 'utf8');
  t.ok(source.includes('searchQuery: query') &&
    source.includes("files: ['content/gmail-verify.js']") &&
    gmailSource.includes('async function runSearchFromInbox(query)') &&
    gmailSource.includes('async function waitForSearchContext(query, maxMs = 25000)') &&
    gmailSource.includes("input[aria-label=\"Search mail\"]") &&
    gmailSource.includes('Math.min(rows.length, 10)'),
  'generic Gmail code recovery stores the query, retries search from inbox, and scans enough result rows');

  t.ok(gmailSource.includes('const decodeGmailHref = (href) =>') &&
    gmailSource.includes("for (const key of ['url', 'q', 'u'])") &&
    gmailSource.includes('looksVerification') &&
    gmailSource.includes('looksOnlyApplicationReceipt') &&
    gmailSource.includes('contextualLink'),
  'Workday Gmail verification unwraps Gmail redirect links and accepts contextual Workday account links');
  t.ok(gmailSource.includes('function collectWorkdayRowEvidence(row)') &&
    gmailSource.includes('function collectOpenedWorkdayEmailEvidence()') &&
    gmailSource.includes("sendNoEmail('email_not_found', { rowCount: 0") &&
    gmailSource.includes("chrome.runtime.sendMessage({ type: 'WD_GMAIL_FOUND_LINK', verifyUrl, evidence,") &&
    source.includes('pja_wd_last_gmail_result') &&
    source.includes('targetEmail: msg.targetEmail ||') &&
    source.includes('searchQuery: session.searchQuery ||'),
  'Workday Gmail verification persists search/email/link evidence for success and failure diagnostics');

  const workdayGmailHandler = source.slice(
    source.indexOf("if (msg.type === 'WD_OPEN_GMAIL_TAB')"),
    source.indexOf("if (msg.type === 'CAPTURE_APPLY_DIAGNOSTIC')")
  );
  const workdayFoundLinkHandler = source.slice(
    source.indexOf("if (msg.type === 'WD_GMAIL_FOUND_LINK')"),
    source.indexOf("if (msg.type === 'WD_GMAIL_NO_EMAIL_FOUND')")
  );
  t.ok(source.includes('async function pjaWorkdayGmailOwnerIsCurrent(owner)') &&
    workdayGmailHandler.includes("chrome.tabs.create({ url: 'about:blank' }") &&
    workdayGmailHandler.includes('pja_wd_gmail_session: session') &&
    workdayGmailHandler.includes('pja_wd_pending_apply: {') &&
    workdayGmailHandler.includes('runId: owner.runId') &&
    workdayGmailHandler.includes('jobId: owner.jobId') &&
    workdayGmailHandler.includes('applyUrl: owner.applyUrl') &&
    workdayGmailHandler.includes('applyTabId') &&
    workdayGmailHandler.includes('sessionId: session.sessionId') &&
    workdayGmailHandler.includes('sendResponse({ ok: true, gmailTabId: tab.id, sessionId: session.sessionId })') &&
    workdayGmailHandler.indexOf('pja_wd_gmail_session: session') <
      workdayGmailHandler.indexOf('chrome.tabs.update(tab.id, { url: gmailUrl })') &&
    workdayFoundLinkHandler.includes('if (!await pjaWorkdayGmailOwnerIsCurrent(session))') &&
    workdayFoundLinkHandler.includes('chrome.tabs.update(session.applyTabId, { url: session.applyUrl })') &&
    !workdayFoundLinkHandler.includes('pja_wd_pending_apply'),
  'Workday Gmail flow persists an exact run/job/route/tab owner before navigation and never resumes from a newer global pending record');

  t.ok(source.includes('if (owner && owner.sessionId)') &&
    source.includes("String(active.sessionId || '') !== String(owner.sessionId)") &&
    source.includes('sessionId: session.sessionId') &&
    source.includes('if (!await pjaWorkdayGmailOwnerIsCurrent(session))') &&
    source.includes('Page inspection is asynchronous') &&
    source.includes('if (pw && await pjaWorkdayGmailOwnerIsCurrent(session))'),
  'Workday Gmail async callbacks and password-reset side effects require the exact still-active session owner');

  t.ok(source.includes("chrome.storage.local.remove(['pja_email_code_result', 'pja_navigate_to']") &&
    source.includes('chrome.tabs.query({ url: `https://mail.google.com/mail/${acctPath}/*` }') &&
    source.includes("chrome.tabs.update(tab.id, { active: true })"),
  'generic Gmail code recovery reuses an existing Gmail account tab and clears apply navigation recovery');

  t.ok(source.includes('delete window.__pjaGmailVerifyRunning') &&
    source.includes('reusedGmailTab') &&
    source.includes('!session.reusedGmailTab'),
  'generic Gmail code recovery resets the Gmail verifier guard and does not close reused Gmail tabs');

  t.ok(gmailSource.includes('function collectOpenedEmailEvidence(codeSession)') &&
    gmailSource.includes('sourceMatched') &&
    gmailSource.includes('securityMatched') &&
    gmailSource.includes('dateFresh') &&
    gmailSource.includes("reason: evidence?.code ? 'unverified_email_source' : 'code_not_found'") &&
    gmailSource.includes('if (!code && sourceMatched && securityMatched)') &&
    gmailSource.includes('sending EMAIL_CODE_FOUND from open email') &&
    gmailSource.includes('function collectRowEmailEvidence(row, codeSession)') &&
    gmailSource.includes('sending EMAIL_CODE_FOUND from row') &&
    gmailSource.includes('filter(isVisibleEl)') &&
    gmailSource.includes('if (codeSession.company && !rowEvidence.companyMatched)') &&
    gmailSource.includes('redactVerificationTokens') &&
    gmailSource.includes('copy and paste this code') &&
    gmailSource.includes('messageContainers'),
  'generic Gmail code recovery requires verified email source evidence before accepting row/body standalone 8-char tokens');

  t.ok(externalSource.includes("'in:anywhere'") &&
    externalSource.includes("'newer_than:30m'") &&
    externalSource.includes('emailCodeSearchQuery()'),
  'external apply: Greenhouse Gmail code search includes Spam/Trash while preserving fresh-message filtering');

  t.ok(externalSource.includes("'record_captcha_and_advance'") &&
    externalSource.includes("'record_needs_manual'") &&
    externalSource.includes("advanceReason = 'needs_manual'") &&
    externalSource.includes('terminal advance after missing_required'),
  'external apply: LLM recovery terminal actions record and advance instead of waiting for watchdog');

  t.ok(source.includes('verifiedEvidence') &&
    source.includes("reason: 'unverified_email_source'") &&
    source.includes('pja_last_email_code_result: successPublic') &&
    source.includes('evidence: compactEvidence'),
  'background: EMAIL_CODE_FOUND rejects codes without verified Gmail source evidence and persists source metadata');

  t.ok(source.includes("msg.cmd === 'resumeRankedApply'") &&
    source.includes('resumeRankedApplyReply') &&
    source.includes('master = await pjaDispatchRankedCurrent(master)'),
  'ranked dispatch: explicit resume command reconciles and dispatches active ranked runs');

  t.ok(source.includes('async function pjaCloseDuplicateRankedTabs(job, keepTabId)') &&
    source.includes('const sameLinkedInJob = !!(wantedLinkedInId && tabLinkedInId && wantedLinkedInId === tabLinkedInId)') &&
    source.includes('await pjaCloseDuplicateRankedTabs(job, tabId)') &&
    source.includes("msg.cmd === 'closeDuplicateActiveApplyTabs'"),
  'ranked dispatch: duplicate tabs for the active job are closed while keeping the owned in-flight tab');

  const smallInjectList = source.slice(source.indexOf('const scripts = ['), source.indexOf('try {', source.indexOf('const scripts = [')));
  const fullInjectList = source.slice(source.indexOf('const allScripts = ['), source.indexOf('];', source.indexOf('const allScripts = [')));
  const hasWorkdayAuthOrder = snippet =>
    snippet.includes("'content/autofill.js'") &&
    snippet.includes("'content/workday-engine.js'") &&
    snippet.includes("'content/workday-auth.js'") &&
    snippet.includes("'content/external-apply.js'") &&
    snippet.indexOf("'content/autofill.js'") < snippet.indexOf("'content/workday-engine.js'") &&
    snippet.indexOf("'content/workday-engine.js'") < snippet.indexOf("'content/workday-auth.js'") &&
    snippet.indexOf("'content/workday-auth.js'") < snippet.indexOf("'content/external-apply.js'");
  t.ok(source.includes('delete window.__pjaExtApplyLoaded') &&
    source.includes("files: allScripts") &&
    hasWorkdayAuthOrder(smallInjectList) &&
    hasWorkdayAuthOrder(fullInjectList),
  'ranked dispatch: dev reinjection resets external-apply loaded guard and loads Workday engine/auth before external-apply');

  t.ok(source.includes('async function pjaReinjectRankedTab(tabId, reason)') &&
    source.includes('function pjaScheduleRankedReinject(runId, index, tabId, delayMs)') &&
    source.includes('pjaScheduleRankedReinject(master.runId, master.currentIndex, tabId, 75000)') &&
    source.includes('pjaScheduleRankedReinject(master.runId, master.currentIndex, tabId, 150000)'),
  'ranked dispatch: active ATS tabs get bounded guard-reset reinjection watchdogs while still in-flight');

  t.ok(source.includes("pjaHandleRankedMissingTab(ranked, 'watchdog')") &&
    source.includes('if (!missing.terminal) await pjaDispatchRankedCurrent(missing.master)') &&
    source.includes('ranked = await pjaRecoverRankedLastFailure(ranked)') &&
    source.includes('ranked.inFlightIndex == null') &&
    source.includes('ranked.currentIndex <= (ranked.jobs || []).length') &&
    source.includes('await pjaDispatchRankedCurrent(ranked);'),
  'apply watchdog: terminal state is reconciled and missing tabs use the bounded recovery contract');

  t.ok(source.includes('const rankedIsWorkday = !!(rankedJob && /workday') &&
    source.includes('const configuredWorkdayCap = ranked && ranked.workdayAttemptTimeoutMs') &&
    source.includes('ranked && ranked.e2eSafe ? 5 * 60 * 1000 : 20 * 60 * 1000') &&
    source.includes('qIsWorkday ? { capMs: 20 * 60 * 1000 } : {}') &&
    source.includes('Date.now() - (ranked.inFlightAt || Date.now()) > rankedCapMs'),
  'ranked dispatch: Workday ranked runs get an ATS-aware longer watchdog cap while other E2E-safe runs stay short');

  t.ok(source.includes("Workday's month/day spinbuttons can treat a leading zero") &&
    source.includes("const padded = isYear ? String(value).padStart(4, '0') : String(value)"),
  'background: Workday CDP date typing does not zero-pad month/day spinbuttons');

  t.ok(source.includes('Strategy 3: explicit MAIN-world Workday/React commit') &&
    source.includes('[cdp] date s3=') &&
    source.includes("'onDatePicked', 'onDateSelected', 'onDateChange'") &&
    source.includes('{ year: y, month: m - 1, day: d }') &&
    source.includes("err: ok ? '' : firstErr") &&
    source.includes('errorDate'),
  'background: Workday CDP date typing runs a main-world React/date callback recovery pass and reports Error-Date state');

  t.ok(source.includes("const rankedOwnsQueueJob = !!(ranked && ranked.status === 'applying' && job.runId && ranked.runId === job.runId)") &&
    source.includes('if (rankedOwnsQueueJob)'),
  'apply watchdog: runId alone does not make a manual external queue ranked-owned');

  t.ok(source.includes("chrome.storage.local.get(['pja_ranked_apply', 'pja_ext_current', 'pja_last_apply_failure', 'pja_dbg']") &&
    source.includes('const inFlightTab = ranked?.inFlightTabId') &&
    source.includes('currentJob: currentJob ?') &&
    source.includes('selectedScore: scoreTab(tab)') &&
    source.includes('recentDebug: (st.pja_dbg || []).slice(-30)') &&
    source.includes('totalJobs: ranked.jobs && ranked.jobs.length') &&
    source.includes('lastFailure: st.pja_last_apply_failure') &&
    source.includes('const slimResults = rows =>') &&
    source.includes('confirmed: slimResults(ranked.results.confirmed)'),
  'ranked dispatch: inspectActiveApply targets the ranked active tab and returns sanitized run diagnostics');

  const devSource = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
  t.ok(devSource.includes("req.url === '/resume-apply'") &&
    devSource.includes("req.url === '/resume-apply-run'") &&
    devSource.includes("wsAsk('resumeRankedApply'") &&
    devSource.includes('resumeRankedApplyReply'),
  'dev server: /resume-apply endpoint triggers ranked apply resume command');

  t.ok(devSource.includes("req.url === '/recover-active-apply'") &&
    devSource.includes("wsAsk('inspectActiveApply'") &&
    devSource.includes("postLocalJson('/apply-help'") &&
    devSource.includes('structured recovery plan'),
  'dev server: /recover-active-apply inspects active apply tab and asks AI for structured recovery');

  t.ok(devSource.includes("req.url === '/close-duplicate-apply-tabs'") &&
    devSource.includes("wsAsk('closeDuplicateActiveApplyTabs'") &&
    devSource.includes('closeDuplicateActiveApplyTabsReply'),
  'dev server: /close-duplicate-apply-tabs keeps active tab and closes same-job duplicates');

  t.ok(devSource.includes('Keep the active ranked-run object compact') &&
    devSource.includes('scoring evidence remains persisted in the corpus') &&
    !devSource.includes('matchEvidence: j.matchEvidence || [], gaps: j.gaps || [], conflicts: j.conflicts || [],\\n          confidence'),
  'dev server: active ranked queue does not duplicate bulky scoring evidence into chrome.storage');

  t.ok(devSource.includes('"classification":"applied|captcha|missing_required') &&
    devSource.includes('recommendedActions') &&
    devSource.includes("retry_greenhouse_react_selects") &&
    devSource.includes("retry_workday_sid_transaction") &&
    devSource.includes("retry_workday_auth_reset") &&
    devSource.includes("capture_only") &&
    devSource.includes("record_captcha_and_advance") &&
    devSource.includes('data.recommendedActions = Array.isArray(data.recommendedActions)') &&
    devSource.includes('screenshot: snapshot.screenshot && snapshot.screenshot.dataUrl'),
  'dev server: apply-help returns structured classification plus whitelisted generic/Workday recovery actions with screenshot metadata');
};
