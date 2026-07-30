'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

module.exports = async (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  t.ok(source.includes('async function pjaRankedTabExists(tabId)') &&
    source.includes('chrome.tabs.get(tabId') &&
    source.includes('in-flight tab missing; relaunching current job') &&
    source.includes('master.inFlightIndex = null') &&
    source.includes('master.inFlightTabId = null'),
  'ranked dispatch: missing in-flight browser tab clears in-flight state so the current job can relaunch');

  t.ok(source.includes('reconciling stale currentIndex') &&
    source.includes("reason: 'stale_inflight_reconciled'") &&
    source.includes('master.currentIndex = matchIndex'),
  'ranked dispatch: terminal event for a later active job reconciles stale currentIndex instead of being ignored');

  t.ok(source.includes('async function pjaReconcileRankedExtCurrent(master)') &&
    source.includes('reconciling ext_current ahead of master') &&
    source.includes("reason = hadSubmitClick ? 'submit_unclear_ext_current_advanced' : 'stale_ext_current_reconciled'") &&
    source.includes('master.inFlightIndex = curIndex') &&
    source.includes('master = await pjaReconcileRankedExtCurrent(master)'),
  'ranked dispatch: pja_ext_current ahead of master reconciles stale one-job queue advancement');

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

  t.ok(source.includes('async function pjaRecoverRankedLastFailure(master)') &&
    source.includes("recoveredReason = isSuccessFactors && reason === 'no_submit_btn' ? 'no_apply_path' : reason") &&
    source.includes('await pjaAppendApplicationEvent(event)') &&
    source.includes('master = await pjaRecoverRankedLastFailure(master)'),
  'ranked dispatch: resume recovers SuccessFactors landing-page no-submit failures as terminal no_apply_path events');

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
    source.includes('chrome.tabs.captureVisibleTab') &&
    source.includes('dataUrl.length > 650000') &&
    source.includes('[diag] captured post-click'),
  'background: post-click submit diagnostics persist bounded screenshot plus compact history');

  t.ok(source.includes("chrome.tabs.create({ url: 'about:blank', active: true }") &&
    source.includes("pja_email_code_session") &&
    source.includes("chrome.tabs.update(tab.id, { url: gmailUrl })") &&
    source.includes("msg.type === 'CANCEL_EMAIL_CODE_SESSION'"),
  'background: generic Gmail code recovery stores session before Gmail navigation and supports cleanup');

  t.ok(source.includes('sameApplyTab && sameJob && applyTabAlive') &&
    source.includes("reason: 'stale_gmail_tab'") &&
    source.includes("chrome.storage.local.remove('pja_email_code_session')"),
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

  t.ok(source.includes('const rankedCapMs = ranked && ranked.e2eSafe ? 3 * 60 * 1000 : 10 * 60 * 1000') &&
    source.includes('Date.now() - (ranked.inFlightAt || Date.now()) > rankedCapMs'),
  'ranked dispatch: E2E-safe ranked runs use the short watchdog cap instead of waiting 10 minutes');

  t.ok(source.includes("const rankedOwnsQueueJob = !!(ranked && ranked.status === 'applying' && job.runId && ranked.runId === job.runId)") &&
    source.includes('if (rankedOwnsQueueJob)'),
  'apply watchdog: runId alone does not make a manual external queue ranked-owned');

  t.ok(source.includes("chrome.storage.local.get(['pja_ranked_apply', 'pja_last_apply_failure']") &&
    source.includes('totalJobs: ranked.jobs && ranked.jobs.length') &&
    source.includes('lastFailure: st.pja_last_apply_failure') &&
    source.includes('const slimResults = rows =>') &&
    source.includes('confirmed: slimResults(ranked.results.confirmed)'),
  'ranked dispatch: inspectActiveApply returns sanitized ranked-run counts, result buckets, and last failure');

  const devSource = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
  t.ok(devSource.includes("req.url === '/resume-apply'") &&
    devSource.includes("wsAsk('resumeRankedApply'") &&
    devSource.includes('resumeRankedApplyReply'),
  'dev server: /resume-apply endpoint triggers ranked apply resume command');

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
