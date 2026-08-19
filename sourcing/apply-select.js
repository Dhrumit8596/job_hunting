'use strict';
// Phase B core (APPLY_ENGINE_PLAN.md): pure selection + result-mapping for the corpus→apply driver.
// No I/O — the extension/dev-server supply the corpus + applied set and persist the outputs. Kept
// pure so the "what do we apply, and what does each outcome mean" logic is unit-tested without a browser.
//
// UMD: require in Node (dev-server, tests) + globalThis.PJAApplySelect in the service worker.
(function (root) {
  let DA = (root && root.PJADetectAts) || null;
  if (!DA && typeof require !== 'undefined') { try { DA = require('./detect-ats'); } catch (_) {} }
  const detectAts = (DA && DA.detectAts) || (() => '');
  let Evidence = (root && root.PJAScoringEvidence) || null;
  if (!Evidence && typeof require !== 'undefined') { try { Evidence = require('../scoring-evidence'); } catch (_) {} }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function roleKey(j) { return norm(j && j.company) + '::' + norm(j && j.title); }

  // LinkedIn renders a selected job at several equivalent URLs. In particular, the current
  // search UI keeps the job in `currentJobId` instead of navigating to `/jobs/view/:id`. Keep
  // the ID extraction here with the other pure identity helpers so tab ownership, duplicate
  // cleanup, and corpus de-duplication all agree on what constitutes the same posting.
  function linkedinJobId(value) {
    const raw = String(value == null ? '' : value).trim();
    const rawMatch = raw.match(/^(?:linkedin:)?(\d{6,})$/i);
    if (rawMatch) return rawMatch[1];
    try {
      const u = new URL(raw);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
      const selected = String(u.searchParams.get('currentJobId') || '').match(/^\d{6,}$/);
      if (selected) return selected[0];
      const view = u.pathname.match(/\/jobs\/view\/(?:[^/?]*?-)?(\d{6,})(?:\/|$)/i);
      return view ? view[1] : '';
    } catch (_) { return ''; }
  }

  function applyUrlKey(value) {
    try {
      const u = new URL(String(value || '')); u.hash = '';
      const linkedInId = linkedinJobId(u.href);
      if (linkedInId) {
        u.hostname = 'www.linkedin.com';
        u.pathname = '/jobs/view/' + linkedInId;
        u.search = '';
      }
      for (const k of Array.from(u.searchParams.keys())) if (/^(utm_.+|trk|trackingId|ref|refId|source|src|campaign|from)$/i.test(k)) u.searchParams.delete(k);
      u.searchParams.sort();
      return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
    } catch (_) { return ''; }
  }
  const CANONICAL_ID_RE = /^(greenhouse|lever|ashby|workday|smartrecruiters|linkedin|indeed|glassdoor|remotive|jobicy|eightfold|successfactors):/i;
  function scopedRawId(r, value) {
    const raw = value != null ? String(value).trim() : '';
    const company = norm(r && (r.company || r.companyName));
    const title = norm(r && (r.title || r.role || r.jobTitle));
    return raw && company && title ? `source:${company}::${title}::${raw.toLowerCase()}` : '';
  }
  function recordIdentityIds(r) {
    if (!r) return [];
    const out = [];
    for (const value of [r.id, r.jobId, r.sourceJobId]) {
      const id = value != null ? String(value).trim() : '';
      if (CANONICAL_ID_RE.test(id)) out.push(id);
    }
    for (const value of [r.jobId, r.sourceJobId]) {
      const scoped = scopedRawId(r, value);
      if (scoped) out.push(scoped);
    }
    return Array.from(new Set(out));
  }
  function stableRecordId(r) {
    return recordIdentityIds(r)[0] || '';
  }
  function appliedIdentity(records, legacyRoleKeys) {
    const ids = new Set(), urls = new Set(), roles = new Set(legacyRoleKeys || []);
    for (const r of records || []) {
      if (!r) continue;
      const recordIds = recordIdentityIds(r), url = applyUrlKey(r.applyUrl || r.url);
      for (const id of recordIds) ids.add(id);
      if (url) urls.add(url);
      if (!recordIds.length && !url) roles.add(roleKey({ company: r.company || r.companyName, title: r.title || r.role || r.jobTitle }));
    }
    return { ids, urls, roles };
  }

  // Some Greenhouse boards redirect job URLs to a corporate careers page that is outside the
  // extension's deliberately narrow host permissions (Samsara, Peak Energy). If the landing URL
  // carries the same gh_jid, route to Greenhouse's official embedded application instead.
  function greenhouseEmbedFallback(applyUrl, landedUrl) {
    try {
      const src = new URL(applyUrl), dst = new URL(landedUrl);
      if (src.hostname !== 'job-boards.greenhouse.io' || /greenhouse\.io$/i.test(dst.hostname)) return '';
      const m = src.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/i);
      if (!m) return '';
      const landedId = dst.searchParams.get('gh_jid') || dst.searchParams.get('job_id') || '';
      if (String(landedId) !== m[2]) return '';
      return 'https://boards.greenhouse.io/embed/job_app?for=' + encodeURIComponent(m[1]) + '&token=' + encodeURIComponent(m[2]);
    } catch (_) { return ''; }
  }

  function unsupportedAutonomousApplyReason(applyUrl, strategy) {
    let u;
    try { u = new URL(String(applyUrl || '')); } catch (_) { return 'invalid_apply_url'; }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const strat = String(strategy || '').toLowerCase();
    // SAP SuccessFactors Talent Community URLs are lead-capture/signup shells in the observed
    // corpus, not requisition application forms. They render only search/cookie/talent controls.
    if ((/successfactors|careers\.tsmc\.com/i.test(host + path) || strat === 'successfactors') && /\/talentcommunity\/apply\//i.test(path)) {
      return 'unsupported_successfactors_talentcommunity';
    }
    // Jobicy apply buttons open hash popups/outbound lead capture, not inline forms under our
    // current autonomous external-apply path.
    if (/(^|\.)jobicy\.com$/i.test(host) || strat === 'jobicy') return 'unsupported_jobicy_no_inline_form';
    // Eightfold/GF career portals require account-auth portal navigation before a real form; keep
    // them out of autonomous batches until that auth path is implemented.
    if (/careers\.gf\.com$/i.test(host) || /eightfold|phenompeople|oraclecloud/i.test(host) || strat === 'eightfold') {
      return 'unsupported_eightfold_portal_auth';
    }
    return '';
  }

  function applyCapabilityStatus(applyUrl, strategy) {
    const unsupportedReason = unsupportedAutonomousApplyReason(applyUrl, strategy);
    if (unsupportedReason) return { status: 'unsupported', reason: unsupportedReason };
    const s = String(strategy || '').toLowerCase();
    if (/^(workday|indeed|linkedin_ea)$/.test(s)) return { status: 'supported_but_auth_sensitive', reason: '' };
    if (/^(greenhouse|lever|ashby|smartrecruiters|workable|breezy|bamboohr|paylocity|rippling|jobvite|generic)$/.test(s)) {
      return { status: 'supported', reason: '' };
    }
    return { status: 'unknown_needs_resolution', reason: 'unknown_apply_strategy' };
  }

  function compactPlanJob(id, p, st, reason, extra = {}) {
    let strategy = extra.strategy || '';
    if (!strategy && p) strategy = detectAts(p.applyUrl) || p.detectedAts || p.ats || '';
    let channel = extra.channel || p && p.channel || '';
    if (!channel && p && (p.isEasyApply || (p.ats === 'linkedin' && p.sourcePlatform === 'linkedin'))) channel = p.isEasyApply ? 'linkedin_easy_apply' : '';
    if (!channel && p && p.indeedApply) channel = 'indeed_apply';
    if (!channel) channel = 'external';
    if (channel === 'linkedin_easy_apply') strategy = 'linkedin_ea';
    else if (channel === 'indeed_apply') strategy = 'indeed';
    return {
      id,
      company: p && p.company || '',
      title: p && p.title || '',
      channel,
      ats: p && (p.ats || p.detectedAts) || strategy || '',
      strategy,
      fitScore: st && st.fitScore != null && Number.isFinite(Number(st.fitScore)) ? Number(st.fitScore) : null,
      status: st && st.status || 'sourced',
      reason,
      applyUrl: p && p.applyUrl || '',
      descriptionStatus: p && p.descriptionStatus || '',
    };
  }

  function incrementCount(obj, key) {
    key = key || 'unknown';
    obj[key] = (obj[key] || 0) + 1;
  }

  function minEvidenceForFitScore(score) {
    const n = Number(score);
    return Number.isFinite(n) && n >= 75 ? 3 : 2;
  }

  function evidenceMaterialGaps(state) {
    if (Evidence && typeof Evidence.materialGaps === 'function') return Evidence.materialGaps(state);
    return Array.isArray(state && state.gaps) ? state.gaps.filter(Boolean) : [];
  }

  function hasCurrentScoringPolicy(state) {
    return !Evidence || typeof Evidence.isCurrentPolicy !== 'function' || Evidence.isCurrentPolicy(state);
  }

  function timestampMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return NaN;
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? numeric : NaN;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  // discoveredAt is immutable provenance. Rediscovery advances lastSeenAt, which is the actual
  // freshness contract used by sourcing and must also drive apply eligibility. Fall back only when
  // an older record genuinely has no usable last-seen value.
  function browserFreshnessAt(posting) {
    const lastSeen = timestampMs(posting && posting.lastSeenAt);
    if (Number.isFinite(lastSeen)) return lastSeen;
    return timestampMs(posting && posting.discoveredAt);
  }

  // Full corpus records carry the JD text; compact apply-planning projections deliberately carry
  // only a readiness bit. Treat both representations identically so removing description payloads
  // cannot change evidence gates or planning-drop diagnostics.
  function hasUsableDescription(posting) {
    if (!posting || /^(missing|stale|needs_description)$/i.test(String(posting.descriptionStatus || ''))) return false;
    if (posting.descriptionReady === true) return true;
    return !!String(posting.description || '').trim();
  }

  function planDropReason(id, p, st, opts, context) {
    const threshold = opts.threshold != null ? opts.threshold : 70;
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 3;
    const retryDeferred = opts.retryDeferred !== false;
    const requireEvidence = opts.requireEvidence === true;
    const maxGaps = opts.maxGaps != null ? Number(opts.maxGaps) : 2;
    const maxBrowserAgeMs = opts.maxBrowserAgeMs != null ? Number(opts.maxBrowserAgeMs) : null;
    const includeUnscored = opts.includeUnscored === true;
    const now = opts.now != null ? Number(opts.now) : Date.now();
    const atsAllow = opts.atsAllow && opts.atsAllow.length ? new Set(opts.atsAllow.map(x => String(x).toLowerCase())) : null;
    const channelAllow = opts.channelAllow && opts.channelAllow.length ? new Set(opts.channelAllow.map(x => String(x).toLowerCase())) : null;
    if (maxBrowserAgeMs != null && /^(linkedin|indeed|glassdoor)$/i.test(String(p.sourcePlatform || p.ats || ''))) {
      const seen = browserFreshnessAt(p);
      if (!Number.isFinite(seen) || now - seen > maxBrowserAgeMs) return 'stale_browser_listing';
    }
    const fit = st.fitScore;
    const hasFit = fit != null && Number.isFinite(Number(fit));
    if (!hasFit && !includeUnscored) return 'unscored';
    if (hasFit && Number(fit) < threshold) return 'below_threshold';
    if (requireEvidence) {
      if (!hasUsableDescription(p)) return 'missing_description_evidence';
      if (Object.prototype.hasOwnProperty.call(opts, 'candidateFingerprint')
          && (!opts.candidateFingerprint || st.candidateFingerprint !== opts.candidateFingerprint)) return 'candidate_fingerprint_mismatch';
      if (!hasCurrentScoringPolicy(st)) return 'scoring_policy_mismatch';
      const direct = Array.isArray(st.matchEvidence) ? st.matchEvidence.filter(Boolean) : [];
      const gaps = evidenceMaterialGaps(st);
      const conflicts = Array.isArray(st.conflicts) ? st.conflicts.filter(Boolean) : [];
      if (direct.length < minEvidenceForFitScore(fit)) return 'weak_match_evidence';
      if (gaps.length > maxGaps) return 'too_many_match_gaps';
      if (conflicts.length) return 'hard_match_conflict';
      if (!['high', 'medium'].includes(String(st.confidence || '').toLowerCase())) return 'low_score_confidence';
    }
    const postingIds = new Set(recordIdentityIds({ ...p, id }));
    for (const ref of (p.sourceRefs || [])) {
      for (const refId of recordIdentityIds({ ...p, ...ref, id: ref && ref.id || '' })) postingIds.add(refId);
    }
    const postingUrls = [p.applyUrl, p.listingUrl, ...(p.sourceRefs || []).flatMap(r => r ? [r.applyUrl, r.listingUrl] : [])].map(applyUrlKey).filter(Boolean);
    const identity = context.identity;
    if (Array.from(postingIds).some(x => identity.ids.has(x)) || postingUrls.some(x => identity.urls.has(x)) || identity.roles.has(roleKey(p))) return 'already_applied';
    const blockedIdentity = context.blockedIdentity;
    if (Array.from(postingIds).some(x => blockedIdentity.ids.has(x)) || postingUrls.some(x => blockedIdentity.urls.has(x)) || blockedIdentity.roles.has(roleKey(p))) return 'prior_blocked_record';
    let applyHost = '';
    try { applyHost = new URL(String(p.applyUrl || '')).hostname.toLowerCase(); } catch (_) {}
    if (applyHost && context.blockedHosts.has(applyHost)) return 'prior_blocked_host';
    const status = st.status || 'sourced';
    if (status === 'applied') return 'state_applied';
    if (status === 'dead') return 'state_dead';
    const deferred = status === 'needs_manual' || status === 'needs_login';
    if (deferred && !retryDeferred) return 'deferred_retry_disabled';
    if (deferred && (st.attempts || 0) >= maxAttempts) return 'deferred_max_attempts';
    const scorePending = includeUnscored && status === 'score_pending';
    if (!deferred && status !== 'sourced' && !scorePending) return 'ineligible_state';
    if (!p.applyUrl) return 'missing_apply_url';
    let channel = p.channel || '';
    if (!channel && (p.isEasyApply || (p.ats === 'linkedin' && p.sourcePlatform === 'linkedin'))) channel = p.isEasyApply ? 'linkedin_easy_apply' : '';
    if (!channel && p.indeedApply) channel = 'indeed_apply';
    if (!channel) channel = 'external';
    if (channelAllow && !channelAllow.has(String(channel).toLowerCase())) return 'channel_not_allowed';
    const strategy = channel === 'linkedin_easy_apply' ? 'linkedin_ea'
      : channel === 'indeed_apply' ? 'indeed'
      : detectAts(p.applyUrl) || p.detectedAts || p.ats || '';
    const aggregatorOnly = /(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(applyHost);
    if (channel === 'external' && aggregatorOnly && !detectAts(p.applyUrl)) return 'aggregator_without_apply_destination';
    const capability = applyCapabilityStatus(p.applyUrl, strategy || 'generic');
    if (capability.status === 'unsupported') return capability.reason;
    if (capability.status === 'unknown_needs_resolution') return capability.reason;
    if (atsAllow && !atsAllow.has(String(strategy).toLowerCase())) return 'ats_not_allowed';
    return 'eligible_not_selected';
  }

  function buildApplyPlan(corpus, opts = {}) {
    const jobs = buildApplySet(corpus, opts);
    const selectedIds = new Set(jobs.map(j => j.id));
    const index = (corpus && corpus.index) || {};
    const state = (corpus && corpus.state) || {};
    const identity = appliedIdentity(opts.appliedRecords || [], opts.appliedRoleKeys instanceof Set
      ? Array.from(opts.appliedRoleKeys) : (opts.appliedRoleKeys || []));
    const blockedIdentity = appliedIdentity(opts.blockedRecords || []);
    const blockedHosts = new Set((opts.blockedHosts || []).map(x => String(x || '').toLowerCase()).filter(Boolean));
    const context = { identity, blockedIdentity, blockedHosts };
    const dropLimit = opts.dropLimit != null ? Math.max(0, Number(opts.dropLimit) || 0) : 200;
    const dropped = [], dropCounts = {};
    for (const id of Object.keys(index)) {
      if (selectedIds.has(id)) continue;
      const p = index[id];
      const st = state[id] || { status: 'sourced', fitScore: null, attempts: 0 };
      const reason = planDropReason(id, p, st, opts, context);
      incrementCount(dropCounts, reason);
      if (dropped.length < dropLimit) dropped.push(compactPlanJob(id, p, st, reason));
    }
    return { jobs, total: Object.keys(index).length, droppedTotal: Object.keys(index).length - jobs.length,
      dropCounts, dropped };
  }

  // Build the ordered apply set from the corpus.
  //   corpus: { index:{id:posting}, state:{id:{fitScore,status,attempts}} }
  //   opts: { threshold=70, appliedRoleKeys=[], dailyCap=30, maxAttempts=3, retryDeferred=true }
  // A job is eligible when fit>=threshold, not already applied, not dead, and either fresh ('sourced')
  // or a deferred (needs_manual/needs_login) job we're retrying and still under maxAttempts.
  // Returns jobs sorted by fitScore desc, capped to dailyCap, each stamped with its strategy (ATS).
  function buildApplySet(corpus, opts = {}) {
    const threshold = opts.threshold != null ? opts.threshold : 70;
    const dailyCap = opts.dailyCap != null ? opts.dailyCap : 30;
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 3;
    const retryDeferred = opts.retryDeferred !== false;
    const requireEvidence = opts.requireEvidence === true;
    const maxGaps = opts.maxGaps != null ? Number(opts.maxGaps) : 2;
    const maxBrowserAgeMs = opts.maxBrowserAgeMs != null ? Number(opts.maxBrowserAgeMs) : null;
    const includeUnscored = opts.includeUnscored === true;
    const now = opts.now != null ? Number(opts.now) : Date.now();
    // Optional allow-list of ATS strategies (e.g. no-account ATSes for a supervised trial). When set,
    // only jobs whose detected strategy is in the list are eligible — a hard guarantee the run can't
    // touch an account-creation ATS.
    const atsAllow = opts.atsAllow && opts.atsAllow.length ? new Set(opts.atsAllow.map(x => String(x).toLowerCase())) : null;
    const channelAllow = opts.channelAllow && opts.channelAllow.length ? new Set(opts.channelAllow.map(x => String(x).toLowerCase())) : null;
    const identity = appliedIdentity(opts.appliedRecords || [], opts.appliedRoleKeys instanceof Set
      ? Array.from(opts.appliedRoleKeys) : (opts.appliedRoleKeys || []));
    const blockedIdentity = appliedIdentity(opts.blockedRecords || []);
    const blockedHosts = new Set((opts.blockedHosts || []).map(x => String(x || '').toLowerCase()).filter(Boolean));
    const index = (corpus && corpus.index) || {};
    const state = (corpus && corpus.state) || {};

    const out = [];
    for (const id of Object.keys(index)) {
      const p = index[id];
      if (maxBrowserAgeMs != null && /^(linkedin|indeed|glassdoor)$/i.test(String(p.sourcePlatform || p.ats || ''))) {
        const seen = browserFreshnessAt(p);
        if (!Number.isFinite(seen) || now - seen > maxBrowserAgeMs) continue;
      }
      const st = state[id] || { status: 'sourced', fitScore: null, attempts: 0 };
      const fit = st.fitScore;
      const hasFit = fit != null && Number.isFinite(Number(fit));
      if (!hasFit && !includeUnscored) continue;                    // not scored yet
      if (hasFit && Number(fit) < threshold) continue;              // below the match bar
      if (requireEvidence) {
        if (!hasUsableDescription(p)) continue;
        if (Object.prototype.hasOwnProperty.call(opts, 'candidateFingerprint')
            && (!opts.candidateFingerprint || st.candidateFingerprint !== opts.candidateFingerprint)) continue;
        if (!hasCurrentScoringPolicy(st)) continue;
        const direct = Array.isArray(st.matchEvidence) ? st.matchEvidence.filter(Boolean) : [];
        const gaps = evidenceMaterialGaps(st);
        const conflicts = Array.isArray(st.conflicts) ? st.conflicts.filter(Boolean) : [];
        if (direct.length < minEvidenceForFitScore(fit) || gaps.length > maxGaps || conflicts.length || !['high', 'medium'].includes(String(st.confidence || '').toLowerCase())) continue;
      }
      const postingIds = new Set(recordIdentityIds({ ...p, id }));
      for (const ref of (p.sourceRefs || [])) {
        for (const refId of recordIdentityIds({ ...p, ...ref, id: ref && ref.id || '' })) postingIds.add(refId);
      }
      const postingUrls = [p.applyUrl, p.listingUrl, ...(p.sourceRefs || []).flatMap(r => r ? [r.applyUrl, r.listingUrl] : [])].map(applyUrlKey).filter(Boolean);
      if (Array.from(postingIds).some(x => identity.ids.has(x)) || postingUrls.some(x => identity.urls.has(x)) || identity.roles.has(roleKey(p))) continue;
      if (Array.from(postingIds).some(x => blockedIdentity.ids.has(x)) || postingUrls.some(x => blockedIdentity.urls.has(x)) || blockedIdentity.roles.has(roleKey(p))) continue;
      let applyHost = '';
      try { applyHost = new URL(String(p.applyUrl || '')).hostname.toLowerCase(); } catch (_) {}
      if (applyHost && blockedHosts.has(applyHost)) continue;
      const status = st.status || 'sourced';
      if (status === 'applied' || status === 'dead') continue;       // done / dead posting
      const deferred = status === 'needs_manual' || status === 'needs_login';
      if (deferred && (!retryDeferred || (st.attempts || 0) >= maxAttempts)) continue;
      const scorePending = includeUnscored && status === 'score_pending';
      if (!deferred && status !== 'sourced' && !scorePending) continue; // in-flight/unknown → skip
      if (!p.applyUrl) continue;                                     // nothing to open
      let channel = p.channel || '';
      if (!channel && (p.isEasyApply || (p.ats === 'linkedin' && p.sourcePlatform === 'linkedin'))) channel = p.isEasyApply ? 'linkedin_easy_apply' : '';
      if (!channel && p.indeedApply) channel = 'indeed_apply';
      if (!channel) channel = 'external';
      if (channelAllow && !channelAllow.has(String(channel).toLowerCase())) continue;
      const strategy = channel === 'linkedin_easy_apply' ? 'linkedin_ea'
        : channel === 'indeed_apply' ? 'indeed'
        : detectAts(p.applyUrl) || p.detectedAts || p.ats || '';
      // Browser aggregator listings whose external destination was not resolved are valid sourcing
      // leads, but they are not safe autonomous-apply targets yet. Classify them before capability
      // lookup so LinkedIn/Indeed/Glassdoor external rows are not mislabeled unknown handlers.
      const aggregatorOnly = /(^|\.)(linkedin|indeed|glassdoor)\.com$/i.test(applyHost);
      if (channel === 'external' && aggregatorOnly && !detectAts(p.applyUrl)) continue;
      const capability = applyCapabilityStatus(p.applyUrl, strategy || 'generic');
      if (capability.status === 'unsupported' || capability.status === 'unknown_needs_resolution') continue;
      if (atsAllow && !atsAllow.has(String(strategy).toLowerCase())) continue; // outside the allow-list
      out.push({
        id, applyUrl: p.applyUrl, company: p.company, title: p.title, location: p.location,
        ats: p.ats || '', fitScore: hasFit ? Number(fit) : null, attempts: st.attempts || 0, strategy, channel,
        applyStrategyStatus: capability.status,
        sourcePlatform: p.sourcePlatform || '', sourceJobId: p.sourceJobId || '',
        discoveredAt: p.discoveredAt || '',
        jobId: p.sourceJobId || '', listingUrl: p.listingUrl || '',
        isEasyApply: !!p.isEasyApply, indeedApply: !!p.indeedApply,
        matchEvidence: st.matchEvidence || [], gaps: st.gaps || [],
        materialGaps: evidenceMaterialGaps(st), trainableGaps: st.trainableGaps || [],
        preferredGaps: st.preferredGaps || [], gapDetails: st.gapDetails || [],
        transferability: st.transferability || null, scoringPolicyVersion: st.scoringPolicyVersion || '',
        conflicts: st.conflicts || [],
        confidence: st.confidence || '', scoreKind: st.scoreKind || '',
        descriptionFingerprint: st.descriptionFingerprint || p.descriptionFingerprint || '',
        postingDescriptionFingerprint: p.descriptionFingerprint || '',
        evidenceFingerprint: st.evidenceFingerprint || '',
        candidateFingerprint: st.candidateFingerprint || '',
        description: p.description || '', descriptionStatus: p.descriptionStatus || '',
        descriptionReady: hasUsableDescription(p),
      });
    }
    out.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    // Per-company cap so a batch spans multiple employers instead of stacking one company (e.g.
    // PsiQuantum ×4). Default 2 → a 10-job run covers 5+ companies. perCompanyCap<=0 disables it.
    const perCompanyCap = opts.perCompanyCap != null ? opts.perCompanyCap : 2;
    const picked = [], perCo = {};
    for (const j of out) {
      if (dailyCap > 0 && picked.length >= dailyCap) break;
      const co = norm(j.company);
      if (perCompanyCap > 0 && (perCo[co] || 0) >= perCompanyCap) continue;
      perCo[co] = (perCo[co] || 0) + 1;
      picked.push(j);
    }
    return picked;
  }

  // Persistent per-job budget: the setTimeout watchdog is reset by page reloads, so a job that
  // reload-loops (e.g. a required react-select that never commits) never hits it and blocks the whole
  // batch. external-apply tracks {firstSeen, loads} per job in storage (survives reloads) and calls
  // this each time the apply page loads; when the wall-clock budget or reload count is exceeded, the
  // job is deferred to needs_manual and the queue advances. Pure so it's unit-tested.
  function exceededBudget(entry, now, opts = {}) {
    if (!entry) return false;
    const budgetMs = opts.budgetMs != null ? opts.budgetMs : 240000; // 4 min wall-clock across reloads
    const maxLoads = opts.maxLoads != null ? opts.maxLoads : 4;
    return (now - (entry.firstSeen || now)) > budgetMs || (entry.loads || 0) > maxLoads;
  }

  function externalJobBudgetOptions(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (/workday\.com|myworkdayjobs\.com/.test(host)) return { budgetMs: 12 * 60 * 1000, maxLoads: 12 };
    // SmartRecruiters' public posting can perform several full-page handoffs before /oneclick-ui
    // hydrates. Five quick loads are not proof of a stalled form; keep the wall-clock bound while
    // allowing the trusted landing click enough redirects to reach the application SPA.
    if (/smartrecruiters\.com/.test(host)) return { budgetMs: 7 * 60 * 1000, maxLoads: 8 };
    return {};
  }

  function queueJobKey(job) {
    if (!job || typeof job !== 'object') return '';
    const url = applyUrlKey(job.applyUrl || job.listingUrl);
    if (url) return `url:${url}`;
    const ids = recordIdentityIds(job);
    return ids[0] ? `id:${ids[0]}` : (roleKey(job) ? `role:${roleKey(job)}` : '');
  }

  // Service-worker watchdog decision (pure). The content-script setTimeout watchdog is unreliable on
  // backgrounded tabs (MV3 throttling), so the SW polls this on a chrome.alarm. Given the queue, the
  // last-seen tracker `wd` ({runId, idx, startedAt}), and now, it decides whether to reset the timer
  // (new job/run), keep waiting, or force-advance a job that's been stuck past the cap.
  function watchdogDecision(queue, wd, now, opts = {}) {
    // Live successful ATS forms consistently finish inside ~90s; beyond 3 minutes the observed
    // cases are wedged react-selects/reload loops. Keep enough room for two AI passes while avoiding
    // five-minute stalls across a large batch.
    const capMs = opts.capMs != null ? opts.capMs : 180000; // 3 min hard cap per job
    if (!queue || queue.status !== 'applying') return { action: 'idle' };
    const idx = queue.currentIndex || 0;
    const jobKey = queueJobKey((queue.jobs || [])[idx]);
    wd = wd || {};
    if (wd.runId !== queue.runId || wd.idx !== idx || String(wd.jobKey || '') !== jobKey) {
      return { action: 'reset', wd: { runId: queue.runId, idx, jobKey, startedAt: now } };
    }
    if (now - (wd.startedAt || now) < capMs) return { action: 'wait' };
    return { action: 'advance', idx };
  }

  // Result reason (from external-apply.js recordResult) → next corpus state.
  const APPLIED = new Set(['applied', 'already_applied']);
  const DEAD = new Set(['posting_not_found']);
  const NEEDS_LOGIN = new Set(['needs_login', 'auth_blocked', 'google_sso_only', 'workday_account_locked']);
  // Blocked by something a human must clear (never auto-solved) — defer immediately, don't retry-spin.
  // stuck_budget = exceeded the cross-reload wall-clock/load budget (unbounded stall) → defer.
  const NEEDS_MANUAL = new Set(['workday_captcha', 'captcha', 'captcha_or_antibot', 'captcha_after_submit', 'email_verification_required',
    'linkedin_checkpoint', 'daily_limit', 'linkedin_daily_limit', 'chatbot_apply_manual',
    'ready_to_submit_review', 'stuck_budget', 'handler_timeout', 'success_unverified', 'unsupported_strategy',
    'ownership_lost_ext_current_advanced',
    // These are stable ATS/UI blockers observed in live runs. Retrying them three times only
    // burns the batch budget; defer for manual review and let the queue advance immediately.
    'no_apply_btn_on_description', 'no_apply_path', 'no_submit_btn', 'wd_selectinput_blocked',
    'workday_auth_sign_in_error', 'workday_create_rejected_no_visible_error',
    'workday_account_exists_wrong_password', 'workday_duplicate_record',
    // Submit was attempted but acceptance could not be observed. Never retry an application that
    // may already exist; keep it visible for evidence reconciliation instead.
    'submit_unclear', 'submit_observation_timeout', 'workday_transport_failure']);

  // Everything else (missing_required, apply_btn_no_form,
  // watchdog_timeout, no_apply_btn_on_description, no_submit_after_spa, workday_auth_*) is TRANSIENT:
  // retry until maxAttempts, then defer to needs_manual.
  function resultToState(reason, attempts, maxAttempts = 3) {
    const r = String(reason || '');
    if (APPLIED.has(r)) return { status: 'applied', reason: r };
    if (DEAD.has(r)) return { status: 'dead', reason: r };
    if (NEEDS_LOGIN.has(r)) return { status: 'needs_login', reason: r, attempts: (attempts || 0) + 1 };
    if (NEEDS_MANUAL.has(r)) return { status: 'needs_manual', reason: r, attempts: (attempts || 0) + 1 };
    const n = (attempts || 0) + 1;
    if (n >= maxAttempts) return { status: 'needs_manual', reason: r, attempts: n };
    return { status: 'sourced', reason: r, attempts: n, retry: true }; // stays eligible next run
  }

  // Post-run summary over the corpus state: is the pool "cleared" (no fit>=threshold job still sourced)?
  function poolStatus(corpus, opts = {}) {
    const threshold = opts.threshold != null ? opts.threshold : 70;
    const index = (corpus && corpus.index) || {};
    const state = (corpus && corpus.state) || {};
    const counts = { applied: 0, needs_manual: 0, needs_login: 0, dead: 0, sourced_unresolved: 0, below_threshold: 0 };
    for (const id of Object.keys(index)) {
      const st = state[id] || { status: 'sourced', fitScore: null };
      if (st.fitScore == null || Number(st.fitScore) < threshold) { counts.below_threshold++; continue; }
      const s = st.status || 'sourced';
      if (s === 'applied') counts.applied++;
      else if (s === 'needs_manual') counts.needs_manual++;
      else if (s === 'needs_login') counts.needs_login++;
      else if (s === 'dead') counts.dead++;
      else counts.sourced_unresolved++;
    }
    counts.cleared = counts.sourced_unresolved === 0;   // every match resolved to a terminal/deferred state
    return counts;
  }

  const API = { buildApplySet, buildApplyPlan, resultToState, poolStatus, roleKey, applyUrlKey, linkedinJobId, stableRecordId,
    recordIdentityIds, appliedIdentity, greenhouseEmbedFallback, exceededBudget, externalJobBudgetOptions, queueJobKey,
    watchdogDecision, unsupportedAutonomousApplyReason, applyCapabilityStatus, hasUsableDescription,
    evidenceMaterialGaps, hasCurrentScoringPolicy, timestampMs, browserFreshnessAt };
  if (root) root.PJAApplySelect = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
