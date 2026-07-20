'use strict';

(function (root) {

// Pure, append-only application audit ledger.
//
// Integration contract:
//   1. A single central owner (normally the MV3 service worker) serializes storage writes.
//   2. Producers send immutable events with eventId, runId, jobId/applyUrl and timestamps.
//   3. The owner calls reduceLedger(current, event). Concurrent replicas can be repaired with
//      mergeLedgers(a, b): event union is commutative, associative and idempotent.
//   4. Only auditLedger(...).counts.confirmed is a defensible submitted-application count.
//
// An `applied`/`submitted` status alone is deliberately NOT confirmation. Page confirmation
// requires confirmationSource:'page' + confirmedAt. Email confirmation requires a unique email
// id; reconcileEmails assigns any one email to at most one application.

const SCHEMA_VERSION = 1;
const POSITIVE = new Set(['applied', 'submitted', 'success', 'confirmed', 'complete', 'completed']);
const SUBMITTING = new Set(['submitting', 'submit_clicked', 'submitting_application']);
const PENDING = new Set(['pending', 'queued', 'ready', 'started', 'in_progress']);
const FAILED = new Set(['failed', 'failure', 'error', 'blocked', 'aborted']);
const SKIPPED = new Set(['skipped', 'skip', 'not_attempted']);
const INFERRED_REASON_RE = /(?:^|[^a-z])(?:pre[-_ ]?nav[-_ ]?handled|submitted[-_ ]?assumed|unverified|unconfirmed|submit[-_ ]?unclear|assumed|inferred)(?:$|[^a-z])/i;
const EMAIL_CONFIRM_RE = /thank(?:s| you) for (?:applying|your (?:application|interest|submission))|application (?:received|submitted|confirmed|complete)|we(?:'| ha)?ve received (?:your )?application|received your application|you have applied|thanks for applying|appreciate your (?:application|interest)/i;
const COMPANY_NOISE_RE = /\b(?:inc|llc|corp|corporation|co|ltd|limited|technologies|technology|labs|laboratories|systems|holdings|group|the|hiring|team|recruiting|careers|talent|no[- ]?reply)\b/g;

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, events: {} };
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[<>@].*$/, '')
    .replace(/[,.&\-\u2014_/]+/g, ' ')
    .replace(COMPANY_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roleKey(record) {
  const company = normCompany(record && record.company);
  const title = norm(record && record.title);
  return company && title ? `role:${company}::${title}` : '';
}

function canonicalApplyUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_.+|trk|trackingId|ref|referrer|source)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return String(value).trim().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const numeric = /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstMs(...values) {
  for (const value of values) {
    const parsed = toMs(value);
    if (parsed != null) return parsed;
  }
  return null;
}

// Stable FNV-1a hash. This is an idempotency key, not a security primitive.
function stableHash(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const jobId = String(raw.jobId || raw.sourceJobId || raw.externalJobId || '').trim();
  const applyUrl = canonicalApplyUrl(raw.applyUrl);
  const company = String(raw.company || '').trim();
  const title = String(raw.title || '').trim();
  const aliases = [];
  // Source IDs are tenant-local on several ATSes (for example, two Workday employers can both
  // publish R1234). Never treat a naked numeric/requisition ID as globally unique. A modern URL is
  // the strongest bridge; ID-only events are scoped to the exact employer + role instead.
  const role = roleKey({ company, title });
  if (jobId && role) aliases.push(`job:${role.slice(5)}::${jobId.toLowerCase()}`);
  if (applyUrl) aliases.push(`url:${applyUrl.toLowerCase()}`);
  const status = norm(raw.status || raw.result || (raw.success === true ? 'success' : (raw.success === false ? 'failed' : ''))).replace(/ /g, '_');
  const confirmationSource = norm(raw.confirmationSource || raw.confirmedBy || '').replace(/ /g, '_');
  const confirmedAt = firstMs(raw.confirmedAt, raw.emailDate);
  const applicationAt = firstMs(raw.applicationAt, raw.appliedAt, raw.submittedAt, raw.startedAt, raw.ts, raw.at);
  const occurredAt = firstMs(raw.occurredAt, raw.eventAt, confirmedAt, raw.updatedAt, raw.ts, raw.at, raw.appliedAt, applicationAt);
  const confirmationEmailId = String(raw.confirmationEmailId || raw.emailMessageId || raw.messageId || '').trim();
  const reason = String(raw.reason || raw.skipReason || '').trim();
  const eventSeed = [raw.runId || '', aliases.join('|'), role, status,
    confirmationSource, reason, confirmedAt == null ? '' : confirmedAt,
    occurredAt == null ? '' : occurredAt, confirmationEmailId].join('::');
  return {
    eventId: String(raw.eventId || `evt_${stableHash(eventSeed)}`),
    runId: raw.runId == null ? null : String(raw.runId),
    jobId: jobId || null,
    applyUrl: applyUrl || null,
    aliases: Array.from(new Set(aliases)).sort(),
    roleKey: role,
    company,
    title,
    channel: raw.channel || raw.ats || null,
    status: status || 'unknown',
    reason,
    success: raw.success === true ? true : (raw.success === false ? false : null),
    confirmationSource: confirmationSource || null,
    confirmationEmailId: confirmationEmailId || null,
    confirmedEmail: raw.confirmedEmail === true,
    confirmedAt,
    applicationAt,
    occurredAt,
  };
}

function isInferred(event) {
  return INFERRED_REASON_RE.test(String(event && event.reason || ''));
}

function confirmationKinds(event) {
  if (!event || isInferred(event) || !POSITIVE.has(event.status)) return [];
  const kinds = [];
  if (event.confirmationSource === 'page' && event.confirmedAt != null) kinds.push('page');
  const emailEvidence = event.confirmationSource === 'email' || event.confirmedEmail === true;
  if (emailEvidence && event.confirmationEmailId && event.confirmedAt != null) kinds.push('email');
  return kinds;
}

function stateOfEvent(event) {
  if (confirmationKinds(event).length) return 'confirmed';
  if (SUBMITTING.has(event.status)) return 'submitting';
  if (PENDING.has(event.status)) return 'pending';
  if (FAILED.has(event.status) || event.success === false) return 'failed';
  if (SKIPPED.has(event.status)) return 'skipped';
  // Positive-looking but unsupported/inferred records are intentionally visible as unverified.
  return 'unverified';
}

function eventStrength(event) {
  const rank = { confirmed: 100, failed: 70, submitting: 60, pending: 50, skipped: 40, unverified: 30 };
  return rank[stateOfEvent(event)] || 0;
}

function mergeSameEvent(left, right) {
  const a = normalizeEvent(left);
  const b = normalizeEvent(right);
  if (!a) return b;
  if (!b) return a;
  const strengthDelta = eventStrength(a) - eventStrength(b);
  const timeDelta = (a.occurredAt || 0) - (b.occurredAt || 0);
  const winner = strengthDelta > 0 || (strengthDelta === 0 && (timeDelta > 0
    || (timeDelta === 0 && JSON.stringify(a) >= JSON.stringify(b)))) ? a : b;
  const other = winner === a ? b : a;
  const merged = { ...other, ...winner };
  merged.aliases = Array.from(new Set([...(a.aliases || []), ...(b.aliases || [])])).sort();
  merged.confirmedEmail = a.confirmedEmail === true || b.confirmedEmail === true;
  const applicationTimes = [a.applicationAt, b.applicationAt].filter(value => value != null);
  merged.applicationAt = applicationTimes.length ? Math.min(...applicationTimes) : null;
  merged.confirmedAt = firstMs(winner.confirmedAt, other.confirmedAt);
  for (const field of ['runId', 'jobId', 'applyUrl', 'roleKey', 'company', 'title', 'channel',
    'reason', 'confirmationSource', 'confirmationEmailId']) {
    if (merged[field] == null || merged[field] === '') merged[field] = other[field];
  }
  return merged;
}

function reduceLedger(current, incoming) {
  const source = current && current.events && typeof current.events === 'object' ? current : emptyLedger();
  const next = { schemaVersion: SCHEMA_VERSION, events: { ...source.events } };
  const list = Array.isArray(incoming) ? incoming : [incoming];
  for (const raw of list) {
    const event = normalizeEvent(raw);
    if (!event) continue;
    const prior = next.events[event.eventId];
    next.events[event.eventId] = prior ? mergeSameEvent(prior, event) : event;
  }
  return next;
}

function mergeLedgers(...ledgers) {
  let merged = emptyLedger();
  for (const ledger of ledgers) {
    if (!ledger || !ledger.events) continue;
    merged = reduceLedger(merged, Object.values(ledger.events));
  }
  return merged;
}

function dayKey(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  if (!timeZone) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function selectedDay(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'day')) return options.day;
  return dayKey(options.now == null ? Date.now() : options.now, options.timeZone);
}

function scopedEvents(ledger, options) {
  const runId = options.runId == null ? null : String(options.runId);
  const day = selectedDay(options);
  return Object.values((ledger && ledger.events) || {}).filter(event => {
    if (runId != null && event.runId !== runId) return false;
    if (day == null) return true;
    const at = event.applicationAt != null ? event.applicationAt : event.occurredAt;
    return at != null && dayKey(at, options.timeZone) === day;
  });
}

// Modern events are joined only by exact job-id/apply-URL aliases. Legacy role-only events attach
// to a modern posting only when that role is unambiguous; two same-title requisitions never merge.
function groupEvents(events) {
  const modern = events.filter(event => event.aliases && event.aliases.length);
  const legacy = events.filter(event => !event.aliases || !event.aliases.length);
  const parent = modern.map((_, index) => index);
  const find = index => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    while (parent[index] !== index) { const next = parent[index]; parent[index] = cursor; index = next; }
    return cursor;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const aliases = new Map();
  modern.forEach((event, index) => {
    for (const alias of event.aliases) {
      if (aliases.has(alias)) union(index, aliases.get(alias));
      else aliases.set(alias, index);
    }
  });
  const components = new Map();
  modern.forEach((event, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(event);
  });
  const groups = Array.from(components.values());
  const roleToGroups = new Map();
  groups.forEach((group, index) => {
    for (const key of new Set(group.map(event => event.roleKey).filter(Boolean))) {
      if (!roleToGroups.has(key)) roleToGroups.set(key, []);
      roleToGroups.get(key).push(index);
    }
  });
  const legacyGroups = new Map();
  for (const event of legacy) {
    const candidates = roleToGroups.get(event.roleKey) || [];
    if (event.roleKey && candidates.length === 1) groups[candidates[0]].push(event);
    else {
      const key = event.roleKey || `event:${event.eventId}`;
      if (!legacyGroups.has(key)) legacyGroups.set(key, []);
      legacyGroups.get(key).push(event);
    }
  }
  return groups.concat(Array.from(legacyGroups.values()));
}

// Defensive invariant: even if two buggy producers attach the same message id to two jobs,
// only one group retains that email evidence. The owner is deterministic, so replica merge order
// cannot change the count.
function enforceUniqueEmailEvidence(groups) {
  const groupKey = group => {
    const aliases = Array.from(new Set(group.flatMap(event => event.aliases || []))).sort();
    return aliases[0] || group.map(event => event.roleKey || `event:${event.eventId}`).sort()[0];
  };
  const claims = new Map();
  groups.forEach((group, groupIndex) => {
    for (const event of group) {
      if (!confirmationKinds(event).includes('email') || !event.confirmationEmailId) continue;
      if (!claims.has(event.confirmationEmailId)) claims.set(event.confirmationEmailId, []);
      claims.get(event.confirmationEmailId).push({ groupIndex, key: groupKey(group), eventId: event.eventId });
    }
  });
  const rejected = new Map();
  for (const entries of claims.values()) {
    const owners = entries.slice().sort((a, b) => a.key.localeCompare(b.key) || a.eventId.localeCompare(b.eventId));
    const ownerGroup = owners[0].groupIndex;
    for (const entry of owners) {
      if (entry.groupIndex === ownerGroup) continue;
      if (!rejected.has(entry.groupIndex)) rejected.set(entry.groupIndex, new Set());
      rejected.get(entry.groupIndex).add(entry.eventId);
    }
  }
  return groups.map((group, groupIndex) => group.map(event => {
    if (!rejected.get(groupIndex)?.has(event.eventId)) return event;
    return {
      ...event,
      confirmationSource: event.confirmationSource === 'email' ? null : event.confirmationSource,
      confirmedEmail: false,
      confirmationEmailId: null,
      reason: 'duplicate_email_assignment_unverified',
    };
  }));
}

function summarizeGroup(events) {
  const ordered = events.slice().sort((a, b) => (a.occurredAt || 0) - (b.occurredAt || 0)
    || a.eventId.localeCompare(b.eventId));
  const aliases = Array.from(new Set(ordered.flatMap(event => event.aliases || []))).sort();
  const confirmations = { page: [], email: [] };
  for (const event of ordered) {
    for (const kind of confirmationKinds(event)) confirmations[kind].push(event.eventId);
  }
  let state = 'confirmed';
  let decisive = ordered[ordered.length - 1];
  if (!confirmations.page.length && !confirmations.email.length) {
    decisive = ordered.slice().sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0)
      || eventStrength(b) - eventStrength(a) || b.eventId.localeCompare(a.eventId))[0];
    state = stateOfEvent(decisive);
  }
  const rich = ordered.slice().reverse();
  const pick = field => (rich.find(event => event[field] != null && event[field] !== '') || {})[field] || null;
  const times = ordered.map(event => event.applicationAt != null ? event.applicationAt : event.occurredAt).filter(v => v != null);
  return {
    identity: aliases[0] || pick('roleKey') || `event:${ordered[0].eventId}`,
    aliases,
    company: pick('company'),
    title: pick('title'),
    jobId: pick('jobId'),
    applyUrl: pick('applyUrl'),
    channel: pick('channel'),
    runIds: Array.from(new Set(ordered.map(event => event.runId).filter(Boolean))).sort(),
    state,
    reason: decisive ? decisive.reason || null : null,
    confirmationSources: Object.keys(confirmations).filter(kind => confirmations[kind].length),
    confirmations,
    firstAttemptAt: times.length ? Math.min(...times) : null,
    lastEventAt: Math.max(...ordered.map(event => event.occurredAt || 0)),
    eventIds: ordered.map(event => event.eventId),
  };
}

function auditLedger(ledger, options = {}) {
  const target = Math.max(0, Number.isFinite(Number(options.target)) ? Number(options.target) : 50);
  const day = selectedDay(options);
  const applications = enforceUniqueEmailEvidence(groupEvents(scopedEvents(ledger, options))).map(summarizeGroup)
    .sort((a, b) => (b.firstAttemptAt || 0) - (a.firstAttemptAt || 0) || a.identity.localeCompare(b.identity));
  const buckets = {
    confirmed: applications.filter(app => app.state === 'confirmed'),
    submitting: applications.filter(app => app.state === 'submitting'),
    pending: applications.filter(app => app.state === 'pending'),
    failed: applications.filter(app => app.state === 'failed'),
    skipped: applications.filter(app => app.state === 'skipped'),
    unverified: applications.filter(app => app.state === 'unverified'),
  };
  const confirmedPage = buckets.confirmed.filter(app => app.confirmationSources.includes('page')).length;
  const confirmedEmail = buckets.confirmed.filter(app => app.confirmationSources.includes('email')).length;
  const confirmedBoth = buckets.confirmed.filter(app => app.confirmationSources.length === 2).length;
  return {
    runId: options.runId == null ? null : String(options.runId),
    day,
    target,
    remaining: Math.max(0, target - buckets.confirmed.length),
    counts: {
      total: applications.length,
      confirmed: buckets.confirmed.length,
      confirmedPage,
      confirmedEmail,
      confirmedPageOnly: confirmedPage - confirmedBoth,
      confirmedEmailOnly: confirmedEmail - confirmedBoth,
      confirmedBoth,
      submitting: buckets.submitting.length,
      pending: buckets.pending.length,
      inFlight: buckets.submitting.length + buckets.pending.length,
      failed: buckets.failed.length,
      skipped: buckets.skipped.length,
      unverified: buckets.unverified.length,
    },
    applications,
    buckets,
  };
}

function titleScore(title, text) {
  const wanted = norm(title);
  const haystack = norm(text);
  if (!wanted || !haystack) return 0;
  if (haystack.includes(wanted)) return 120;
  const words = wanted.split(' ').filter(word => word.length > 2);
  if (!words.length) return 0;
  const hits = words.filter(word => haystack.includes(word)).length;
  const ratio = hits / words.length;
  return ratio >= 0.6 ? Math.round(ratio * 60) : 0;
}

function emailId(email) {
  const explicit = email && (email.messageId || email.id || email.threadId);
  if (explicit) return String(explicit);
  return `derived_${stableHash([email && email.from, email && email.subject, email && email.date].join('|'))}`;
}

function isConfirmationEmail(email) {
  return !!email && EMAIL_CONFIRM_RE.test(`${email.subject || ''} ${email.snippet || ''}`);
}

// Conservative email reconciliation. Company (or exact job/url) evidence is mandatory, each
// email is consumed once, and each pass assigns at most one email to each application.
function reconcileEmails(ledger, emails, options = {}) {
  const audit = auditLedger(ledger, options);
  const usedEmailIds = new Set(Object.values((ledger && ledger.events) || {})
    .filter(event => confirmationKinds(event).includes('email') && event.confirmationEmailId)
    .map(event => event.confirmationEmailId));
  const assignedApplications = new Set();
  const matches = [];
  const unmatched = [];
  const windowMs = (options.windowDays == null ? 7 : Number(options.windowDays)) * 86400000;
  let next = ledger && ledger.events ? ledger : emptyLedger();
  const candidates = (emails || []).filter(isConfirmationEmail).slice().sort((a, b) =>
    (toMs(a.date) || 0) - (toMs(b.date) || 0) || emailId(a).localeCompare(emailId(b)));

  for (const email of candidates) {
    const id = emailId(email);
    if (usedEmailIds.has(id)) { unmatched.push({ emailId: id, reason: 'already_used' }); continue; }
    const at = toMs(email.date);
    if (at == null) { unmatched.push({ emailId: id, reason: 'missing_email_timestamp' }); continue; }
    const emailApplyUrl = canonicalApplyUrl(email.applyUrl);
    const explicitAliases = new Set([
      email.jobId ? `job:${String(email.jobId).toLowerCase()}` : '',
      emailApplyUrl ? `url:${emailApplyUrl.toLowerCase()}` : '',
    ].filter(Boolean));
    const text = `${email.company || ''} ${email.from || ''} ${email.subject || ''} ${email.snippet || ''}`;
    const emailCompany = normCompany(email.company || email.from);
    const scored = [];
    for (const app of audit.applications) {
      if (assignedApplications.has(app.identity) || app.firstAttemptAt == null) continue;
      if (at != null && (at < app.firstAttemptAt - 3600000 || at > app.firstAttemptAt + windowMs)) continue;
      const exact = app.aliases.some(alias => explicitAliases.has(alias));
      const appCompany = normCompany(app.company);
      const normalizedText = normCompany(text);
      const companyHit = !!appCompany && ((emailCompany && (emailCompany.includes(appCompany) || appCompany.includes(emailCompany)))
        || normalizedText.includes(appCompany));
      if (!exact && !companyHit) continue;
      const score = (exact ? 1000 : 0) + (companyHit ? 200 : 0) + titleScore(app.title, text);
      scored.push({ app, score, delta: at == null ? 0 : Math.abs(at - app.firstAttemptAt) });
    }
    scored.sort((a, b) => b.score - a.score || a.delta - b.delta || a.app.identity.localeCompare(b.app.identity));
    const winner = scored[0];
    if (!winner) { unmatched.push({ emailId: id, reason: 'no_unique_application_match' }); continue; }
    const app = winner.app;
    const runId = options.runId == null ? (app.runIds[0] || null) : String(options.runId);
    const event = {
      eventId: `email_${stableHash(`${id}|${app.identity}`)}`,
      runId,
      jobId: app.jobId,
      applyUrl: app.applyUrl,
      company: app.company,
      title: app.title,
      channel: app.channel,
      status: 'confirmed',
      reason: 'email_confirmation',
      confirmationSource: 'email',
      confirmationEmailId: id,
      confirmedEmail: true,
      confirmedAt: at,
      applicationAt: app.firstAttemptAt,
      occurredAt: at,
    };
    next = reduceLedger(next, event);
    usedEmailIds.add(id);
    assignedApplications.add(app.identity);
    matches.push({ emailId: id, identity: app.identity, company: app.company, title: app.title });
  }
  return { ledger: next, matches, unmatched };
}

const PJA_APPLICATION_LEDGER_API = {
  emptyLedger,
  normalizeEvent,
  reduceLedger,
  mergeLedgers,
  auditLedger,
  reconcileEmails,
  isConfirmationEmail,
  canonicalApplyUrl,
  roleKey,
  confirmationKinds,
  dayKey,
};
if (root) root.PJAApplicationLedger = PJA_APPLICATION_LEDGER_API;
if (typeof module !== 'undefined' && module.exports) module.exports = PJA_APPLICATION_LEDGER_API;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
