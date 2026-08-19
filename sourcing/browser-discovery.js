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

function buildBrowserDiscoveryPlan(options = {}) {
  const queries = boundedQueries(options.queries, options.maxQueries);
  const location = locationText(options.targetLocation);
  const radius = Math.max(1, Math.min(100, Number(options.targetRadiusMiles) || 50));
  const maxPages = Math.max(1, Math.min(5, Number(options.maxPages) || 1));
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
        scanOptions: { maxPages } });
    }
    if (sources.has('indeed')) {
      const url = new URL('https://www.indeed.com/jobs');
      url.searchParams.set('q', query);
      url.searchParams.set('l', location);
      url.searchParams.set('radius', String(radius));
      url.searchParams.set('fromage', '30');
      plan.push({ source: 'indeed', query, url: url.toString(), fast: true,
        scanOptions: { maxPages, hydrateDescriptions: false } });
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
  if (coverage) return { terminal: true, status: 'done', coverage };
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
    active.sort((a, b) => (a.source === 'indeed' ? -1 : 1) - (b.source === 'indeed' ? -1 : 1));
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
      acc.collected += Number(row.collected || 0);
      acc.easyApply += Number(row.easyApply || 0);
      acc.external += Number(row.external || 0);
      if (row.status === 'done') acc.completed++;
      else acc.incomplete++;
      return acc;
    }, { collected: 0, easyApply: 0, external: 0, completed: 0, incomplete: 0 }) };
}

module.exports = { boundedQueries, buildBrowserDiscoveryPlan, matchingCoverage, scanTerminal,
  boundDiscoveryPlan, runBoundedDiscoveryPlan };
