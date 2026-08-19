'use strict';

function boundedQueries(values, maxQueries = 20) {
  const limit = Math.max(1, Math.min(20, Number(maxQueries) || 20));
  const seen = new Set(), out = [];
  for (const value of values || []) {
    const query = String(value || '').replace(/\s+/g, ' ').trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key); out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

function locationText(target) {
  target = target && typeof target === 'object' ? target : {};
  return [target.city, target.state].filter(Boolean).join(', ') || target.label || target.zip || 'United States';
}

const TARGET_ORDER = ['quality engineer', 'manufacturing quality engineer', 'process engineer',
  'metrology engineer', 'inspection engineer', 'supplier quality engineer', 'validation engineer',
  'test engineer', 'equipment engineer', 'failure analysis engineer', 'manufacturing engineer',
  'reliability engineer', 'product development engineer', 'wafer inspection engineer',
  'semiconductor metrology engineer', 'semiconductor process engineer', 'yield engineer',
  'process integration engineer', 'process development engineer', 'process quality engineer',
  'product quality engineer'];

function baseLevelQuery(value) {
  return String(value || '').toLowerCase().replace(/\s+(?:i|ii|iii|iv|[1-4])$/i, '').trim();
}

function prioritizeQueries(values, yieldRows = []) {
  const queries = boundedQueries(values, 20);
  const stats = new Map();
  for (const row of yieldRows || []) {
    const key = String(row && row.query || '').trim().toLowerCase();
    if (!key) continue;
    const current = stats.get(key) || { observations: 0, discovered: 0, persisted: 0, unique: 0, direct: 0 };
    current.observations++; current.discovered += Number(row.discovered || 0);
    current.persisted += Number(row.persisted || 0); current.unique += Number(row.unique || 0);
    current.direct += Number(row.directRoute || 0);
    stats.set(key, current);
  }
  const originalOrder = new Map(queries.map((query, index) => [query, index]));
  return queries.sort((a, b) => {
    const score = query => {
      const key = query.toLowerCase();
      const exact = TARGET_ORDER.indexOf(key);
      const baseKey = baseLevelQuery(key);
      const base = TARGET_ORDER.indexOf(baseKey);
      let value = exact >= 0 ? 1000 - exact * 20 : base >= 0 ? 970 - base * 20 : 300;
      // An unobserved Engineer I/II variant inherits only its base query's measured family yield;
      // the variant still needs its own observations before it can outrank the productive base.
      const measured = stats.get(key) || (base !== exact ? stats.get(baseKey) : null);
      if (measured && measured.observations >= 2) value += Math.min(350,
        measured.unique * 12 + measured.persisted * 2 + measured.direct * 2 -
        Math.max(0, measured.discovered - measured.persisted));
      return value;
    };
    return score(b) - score(a) || originalOrder.get(a) - originalOrder.get(b);
  });
}

function buildBrowserDiscoveryPlan(options = {}) {
  const queries = prioritizeQueries(options.queries, options.yieldStats)
    .slice(0, Math.max(1, Math.min(20, Number(options.maxQueries) || 20)));
  const location = locationText(options.targetLocation);
  const radius = Math.max(1, Math.min(100, Number(options.targetRadiusMiles) || 50));
  const linkedInMaxPages = Math.max(1, Math.min(5,
    Number(options.linkedInMaxPages != null ? options.linkedInMaxPages : options.maxPages) || 3));
  // Indeed is deliberately conservative until the current session proves challenge-free.
  const indeedMaxPages = Math.max(1, Math.min(5, Number(options.indeedMaxPages != null
    ? options.indeedMaxPages : options.maxPages != null ? options.maxPages : 1) || 1));
  const sources = new Set((options.sources || ['linkedin', 'indeed']).map(x => String(x || '').toLowerCase()));
  const plan = [];
  for (const query of queries) {
    if (sources.has('linkedin')) {
      const url = new URL('https://www.linkedin.com/jobs/search/');
      url.searchParams.set('keywords', query);
      url.searchParams.set('location', location);
      url.searchParams.set('distance', String(radius));
      url.searchParams.set('f_TPR', 'r2592000'); // last 30 days; no Easy Apply-only filter
      plan.push({ source: 'linkedin', query, url: url.toString(), fast: true,
        scanOptions: { maxPages: linkedInMaxPages } });
    }
    if (sources.has('indeed')) {
      const url = new URL('https://www.indeed.com/jobs');
      url.searchParams.set('q', query);
      url.searchParams.set('l', location);
      url.searchParams.set('radius', String(radius));
      url.searchParams.set('fromage', '30');
      plan.push({ source: 'indeed', query, url: url.toString(), fast: true,
        scanOptions: { maxPages: indeedMaxPages, hydrateDescriptions: false } });
    }
  }
  return plan;
}

function matchingCoverage(storage, item, startedAt) {
  const rows = Array.isArray(storage && storage.pja_scan_coverage) ? storage.pja_scan_coverage : [];
  const query = String(item && item.query || '').trim().toLowerCase();
  return rows.slice().reverse().find(row => row && row.source === item.source &&
    String(row.query || '').trim().toLowerCase() === query && Number(row.ts || 0) >= Number(startedAt || 0)) || null;
}

function scanTerminal(storage, item, startedAt) {
  const coverage = matchingCoverage(storage, item, startedAt);
  if (coverage) return { terminal: true, status: coverage.status || 'done',
    reason: coverage.reason || '', coverage };
  if (item && item.source === 'linkedin') {
    const scan = storage && storage.pja_linkedin_scan;
    if (scan && String(scan.q || '').trim().toLowerCase() === String(item.query || '').trim().toLowerCase() &&
        Number(scan.ts || 0) >= Number(startedAt || 0) && /^(done|failed|paused)$/i.test(String(scan.status || ''))) {
      return { terminal: true, status: scan.status, reason: scan.reason || '', scan };
    }
  }
  if (item && item.source === 'indeed') {
    const scan = storage && storage.pja_indeed_scan;
    if (scan && String(scan.q || '').trim().toLowerCase() === String(item.query || '').trim().toLowerCase() &&
        Number(scan.ts || 0) >= Number(startedAt || 0) && /^(done|failed|paused)$/i.test(String(scan.status || ''))) {
      return { terminal: true, status: scan.status, reason: scan.reason || '', scan };
    }
  }
  return { terminal: false, status: 'running' };
}

function boundDiscoveryPlan(plan, options = {}) {
  const input = Array.isArray(plan) ? plan.slice() : [];
  const totalBudgetMs = Math.max(1, Number(options.totalBudgetMs) || 1);
  const requested = Math.max(1, Number(options.perQueryTimeoutMs) || 120000);
  const minimum = Math.max(1, Number(options.minimumPerItemMs) || 5000);
  if (!input.length) return { plan: [], perQueryTimeoutMs: Math.min(requested, totalBudgetMs),
    totalBudgetMs, scheduledWorstCaseMs: 0, truncated: 0, clamped: requested > totalBudgetMs };
  let bounded = input;
  let perQueryTimeoutMs = Math.min(requested, Math.floor(totalBudgetMs / input.length));
  if (perQueryTimeoutMs < minimum) {
    const maxItems = Math.floor(totalBudgetMs / minimum);
    if (maxItems < 1) {
      const error = new Error('browser discovery budget is too small for one bounded scan');
      error.code = 'invalid_sourcing_timeout_budget';
      throw error;
    }
    bounded = input.slice(0, maxItems);
    perQueryTimeoutMs = Math.min(requested, Math.floor(totalBudgetMs / bounded.length));
  }
  return { plan: bounded, perQueryTimeoutMs, totalBudgetMs,
    scheduledWorstCaseMs: bounded.length * perQueryTimeoutMs,
    truncated: input.length - bounded.length,
    clamped: perQueryTimeoutMs !== requested };
}

async function runBoundedDiscoveryPlan(plan, options = {}) {
  const bounded = boundDiscoveryPlan(plan, options);
  const guard = options.guard || (async () => ({ ok: true }));
  const runItem = options.runItem;
  if (typeof runItem !== 'function') throw new Error('runBoundedDiscoveryPlan requires runItem');
  const blockedSources = new Set(), scans = [];
  const requestedQueries = Array.from(new Set((plan || []).map(item => item.query)));
  const queries = Array.from(new Set(bounded.plan.map(item => item.query)));
  for (const query of queries) {
    const active = bounded.plan.filter(item => item.query === query && !blockedSources.has(item.source));
    // LinkedIn is scanned first so a challenge on Indeed cannot consume the useful-query budget.
    // Work remains query-fair: each query receives at most one bounded scanner launch.
    active.sort((a, b) => (a.source === 'linkedin' ? -1 : 1) - (b.source === 'linkedin' ? -1 : 1));
    for (const item of active) {
      const decision = await guard('before_source_query_launch', item);
      if (!decision || decision.ok !== true) {
        return { requestedQueries, scheduledQueries: queries, scans, blockedSources: Array.from(blockedSources),
          terminalError: decision && decision.code || 'source_ownership_lost', budget: bounded };
      }
      const row = await runItem(item, { perQueryTimeoutMs: bounded.perQueryTimeoutMs, guard });
      scans.push(row);
      if (row && row.terminalError) {
        return { requestedQueries, scheduledQueries: queries, scans, blockedSources: Array.from(blockedSources),
          terminalError: row.terminalError, budget: bounded };
      }
      if (row && row.source === 'indeed' && /^(paused|failed)$/i.test(String(row.status || '')) &&
          /challenge|captcha|verification/i.test(String(row.reason || ''))) blockedSources.add(row.source);
    }
    for (const item of bounded.plan.filter(item => item.query === query && blockedSources.has(item.source))) {
      if (!scans.some(row => row.source === item.source && row.query === item.query)) {
        scans.push({ source: item.source, query: item.query, status: 'skipped_source_blocked' });
      }
    }
  }
  return { requestedQueries, scheduledQueries: queries, scans, blockedSources: Array.from(blockedSources),
    budget: bounded, totals: scans.reduce((acc, row) => {
      acc.discovered += Number(row.discovered != null ? row.discovered : row.collected || 0);
      acc.collected = acc.discovered; // compatibility; reports should prefer the precise discovered term
      acc.persistenceAcknowledged += Number(row.persistenceAcknowledged || 0);
      acc.batchAttempts += Number(row.batchAttempts || 0);
      acc.batchRetries += Number(row.batchRetries || 0);
      acc.persistenceFailures += Number(row.persistenceFailures || 0);
      acc.easyApply += Number(row.easyApply || 0);
      acc.external += Number(row.external || 0);
      if (row.status === 'done') acc.completed++;
      else acc.incomplete++;
      return acc;
    }, { discovered: 0, collected: 0, persistenceAcknowledged: 0,
      batchAttempts: 0, batchRetries: 0, persistenceFailures: 0, easyApply: 0, external: 0,
      completed: 0, incomplete: 0 }) };
}

module.exports = { boundedQueries, prioritizeQueries, buildBrowserDiscoveryPlan, matchingCoverage, scanTerminal,
  boundDiscoveryPlan, runBoundedDiscoveryPlan };
