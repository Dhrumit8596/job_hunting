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

module.exports = { boundedQueries, buildBrowserDiscoveryPlan, matchingCoverage, scanTerminal };
