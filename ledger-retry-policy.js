'use strict';

// Shared pure policy for deciding whether a ledger outcome may be retried automatically. This is
// UMD because both the MV3 service worker and the Node dev server must use the exact same rules.
(function (root) {
  const AMBIGUOUS_SUBMISSION_RE = /submit_unclear|submit_observation_timeout|workday_transport_failure|submit_unconfirmed|success_unverified|submitted_unverified|tab_lost_outcome_unknown/i;
  const EXTERNAL_BLOCKER_RE = /captcha|daily_limit|checkpoint|email_verification_required|workday_account_locked|workday_account_exists_wrong_password|workday_captcha|google_sso_only/i;
  const MANUAL_ONLY_RE = /workday_duplicate_record|ready_to_submit_review|chatbot_apply_manual|unsupported_|no_apply_path|no_easy_apply/i;
  const HOST_BLOCKER_RE = /workday_duplicate_record|workday_captcha|workday_account_locked/i;
  const INFERRED_REASON_RE = /(?:^|[^a-z])(?:pre[-_ ]?nav[-_ ]?handled|submitted[-_ ]?assumed|unverified|unconfirmed|submit[-_ ]?unclear|assumed|inferred)(?:$|[^a-z])/i;

  function text(value) { return String(value == null ? '' : value).trim().toLowerCase(); }
  function hostOf(value) {
    try { return new URL(String(value || '')).hostname.toLowerCase(); } catch (_) { return ''; }
  }
  function hasExplicitConfirmation(event) {
    if (!event) return false;
    if (INFERRED_REASON_RE.test(String(event.reason || ''))) return false;
    const source = text(event.confirmationSource || event.confirmedBy);
    const rawConfirmedAt = event.confirmedAt == null || event.confirmedAt === '' ? null : event.confirmedAt;
    const numericConfirmedAt = rawConfirmedAt == null ? null : Number(rawConfirmedAt);
    const confirmedAt = Number.isFinite(numericConfirmedAt) ? numericConfirmedAt : Date.parse(String(rawConfirmedAt || ''));
    const page = source === 'page' && confirmedAt != null && Number.isFinite(confirmedAt);
    const email = (source === 'email' || event.confirmedEmail === true) &&
      !!String(event.confirmationEmailId || event.emailMessageId || event.messageId || '').trim() &&
      confirmedAt != null && Number.isFinite(confirmedAt);
    return page || email;
  }

  function hasExplicitNoSubmitEvidence(event) {
    if (!event || event.submitAttempted !== false && !(event.diagnostic && event.diagnostic.submitAttempted === false)) {
      return false;
    }
    const phase = text(event.phase || event.diagnostic && event.diagnostic.phase).replace(/[^a-z0-9]+/g, '_');
    return /^(?:pre_submit|page_load|navigation|form_fill|validation)$/.test(phase);
  }

  function classifyLedgerEvent(event) {
    const status = text(event && (event.status || event.result)).replace(/[^a-z0-9]+/g, '_');
    const reason = text(event && (event.reason || event.skipReason));
    if (hasExplicitConfirmation(event)) {
      return { category: 'confirmed', blocksAutomaticRetry: true, manualReconciliation: false,
        externalBlocker: false, confirmed: true, status, reason };
    }
    if (/ranked_watchdog_timeout/i.test(reason)) {
      if (hasExplicitNoSubmitEvidence(event)) {
        return { category: 'failed_retryable', blocksAutomaticRetry: false,
          manualReconciliation: false, externalBlocker: false, confirmed: false, status, reason };
      }
      return { category: 'submitted_unverified_blocked', blocksAutomaticRetry: true,
        manualReconciliation: true, externalBlocker: false, confirmed: false, status, reason };
    }
    if (AMBIGUOUS_SUBMISSION_RE.test(reason)) {
      return { category: 'submitted_unverified_blocked', blocksAutomaticRetry: true,
        manualReconciliation: true, externalBlocker: false, confirmed: false, status, reason };
    }
    if (EXTERNAL_BLOCKER_RE.test(reason)) {
      return { category: 'external_blocker', blocksAutomaticRetry: true,
        manualReconciliation: true, externalBlocker: true, confirmed: false, status, reason };
    }
    if (MANUAL_ONLY_RE.test(reason)) {
      return { category: status === 'skipped' ? 'skipped_manual' : 'failed_manual',
        blocksAutomaticRetry: true, manualReconciliation: true, externalBlocker: false,
        confirmed: false, status, reason };
    }
    if (/^(failed|failure|error|aborted)$/.test(status) || event && event.success === false) {
      return { category: 'failed_retryable', blocksAutomaticRetry: false,
        manualReconciliation: false, externalBlocker: false, confirmed: false, status, reason };
    }
    if (/^(submitted|submitting|applied|success|confirmed|complete|completed|unverified)$/.test(status)) {
      return { category: 'submitted_unverified_blocked', blocksAutomaticRetry: true,
        manualReconciliation: true, externalBlocker: false, confirmed: false, status, reason };
    }
    if (/^(skipped|needs_manual|blocked)$/.test(status)) {
      return { category: 'skipped_manual', blocksAutomaticRetry: false,
        manualReconciliation: true, externalBlocker: false, confirmed: false, status, reason };
    }
    return { category: 'other', blocksAutomaticRetry: false, manualReconciliation: false,
      externalBlocker: false, confirmed: false, status, reason };
  }

  function blockedLedgerRecords(events, options = {}) {
    if (options.retryBlocked === true) return [];
    const retryHosts = new Set((options.retryBlockedHosts || [])
      .map(value => text(value)).filter(Boolean));
    return (events || []).filter(event => {
      const classification = classifyLedgerEvent(event);
      if (!classification.blocksAutomaticRetry || classification.confirmed) return false;
      return !retryHosts.has(hostOf(event && (event.applyUrl || event.url)));
    });
  }

  function blockedHosts(events, options = {}) {
    if (options.retryBlocked === true) return [];
    const retryHosts = new Set((options.retryBlockedHosts || [])
      .map(value => text(value)).filter(Boolean));
    return Array.from(new Set((events || [])
      .filter(event => HOST_BLOCKER_RE.test(text(event && (event.reason || event.status))))
      .map(event => hostOf(event && (event.applyUrl || event.url)))
      .filter(host => host && !retryHosts.has(host))));
  }

  function summarizeLedgerEvents(events) {
    const categories = {
      confirmed: 0,
      submitted_unverified_blocked: 0,
      failed_retryable: 0,
      failed_manual: 0,
      skipped_manual: 0,
      external_blocker: 0,
      other: 0,
    };
    const blocked = [];
    for (const event of events || []) {
      const classification = classifyLedgerEvent(event);
      categories[classification.category] = (categories[classification.category] || 0) + 1;
      if (classification.blocksAutomaticRetry && !classification.confirmed) {
        blocked.push({ event, classification });
      }
    }
    return { categories, blocked };
  }

  const api = { classifyLedgerEvent, blockedLedgerRecords, blockedHosts, summarizeLedgerEvents,
    hasExplicitConfirmation, hasExplicitNoSubmitEvidence, hostOf };
  if (root) root.PJALedgerRetryPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
