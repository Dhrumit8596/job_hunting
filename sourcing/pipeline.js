'use strict';
// Orchestrates sourcing: per-source fetch (isolated) -> filter -> dedupe -> fit-score -> route.
const { getAdapter } = require('./adapters');
const { filterJobs } = require('./filter');
const { dedupe, appliedKeySet } = require('./dedupe');

function ageDays(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/posted\s+today/i.test(text)) return 0;
  if (/posted\s+yesterday/i.test(text)) return 1;
  const relative = text.match(/posted\s+(\d+)(\+)?\s+days?\s+ago/i);
  if (relative) return Number(relative[1]) + (relative[2] ? 1 : 0);
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 86400000)) : null;
}

function sourceYieldStats(label, ats, jobs, opts = {}, error = '') {
  const rows = Array.isArray(jobs) ? jobs : [];
  const eligible = filterJobs(rows, opts);
  const ages = rows.map(j => ageDays(j.postedAt || j.discoveredAt)).filter(v => v != null);
  return {
    src: label,
    source: label,
    ats: ats || '',
    count: rows.length,
    jobsDiscovered: rows.length,
    newlyImported: null,
    fresh7d: ages.filter(v => v <= 7).length,
    fresh30d: ages.filter(v => v <= 30).length,
    freshnessKnown: ages.length,
    successfullyHydrated: rows.filter(j => j.description &&
      !/^(missing|stale|needs_description)$/i.test(String(j.descriptionStatus || ''))).length,
    deterministicallyEligible: eligible.length,
    sentForAiScoring: 0,
    evidenceScored: 0,
    qualified: 0,
    planned: 0,
    attempted: 0,
    confirmed: 0,
    submittedUnverified: 0,
    failed: 0,
    modelCalls: 0,
    tokensConsumed: null,
    error: error || undefined,
  };
}

// Fetch all sources with bounded concurrency. One source failing never breaks the run.
async function fetchAll(sources, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 6);
  const jobs = [];
  const stats = [];
  let i = 0;
  async function worker() {
    while (i < sources.length) {
      const src = sources[i++];
      const ad = getAdapter(src.ats);
      const label = src.name || src.slug || src.ats;
      if (!ad) { stats.push(sourceYieldStats(label, src.ats, [], opts, 'no-adapter')); continue; }
      try {
        const got = await ad.fetchJobs(src, opts);
        for (const job of got) if (job && !job.sourceBoard) job.sourceBoard = label;
        jobs.push(...got);
        stats.push(sourceYieldStats(label, src.ats, got, opts));
      } catch (e) {
        stats.push(sourceYieldStats(label, src.ats, [], opts, String((e && e.message) || e)));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length || 1) }, worker));
  return { jobs, stats };
}

// PURE: split scored jobs into auto-queue (>= threshold) vs shortlist (rest / unscored).
function routeJobs(scored, threshold = 70) {
  const queue = [], shortlist = [];
  for (const j of scored) {
    const s = (j && j.fitScore != null) ? Number(j.fitScore) : null;
    if (s != null && s >= threshold) queue.push(j); else shortlist.push(j);
  }
  return { queue, shortlist };
}

// Full pipeline. scoreFn(jobs)->Promise<jobs with fitScore> is injected (dev-server supplies the
// real one). appliedRecords seed dedupe. Pass opts.jobs to skip network (testing).
async function runPipeline({ sources = [], opts = {}, appliedRecords = [], scoreFn } = {}) {
  let fetched, stats;
  if (Array.isArray(opts.jobs)) { fetched = opts.jobs; stats = []; }
  else { const r = await fetchAll(sources, opts); fetched = r.jobs; stats = r.stats; }

  const eligible = filterJobs(fetched, opts);
  const deduped = dedupe(eligible, appliedKeySet(appliedRecords));
  let scored = deduped;
  if (typeof scoreFn === 'function' && deduped.length) {
    try { scored = await scoreFn(deduped); } catch (_) { scored = deduped; }
  }
  const threshold = opts.threshold != null ? opts.threshold : 70;
  const { queue, shortlist } = routeJobs(scored, threshold);
  return {
    stats,
    totals: { fetched: fetched.length, eligible: eligible.length, deduped: deduped.length, queued: queue.length, shortlisted: shortlist.length },
    queue, shortlist, scored,
  };
}

module.exports = { fetchAll, routeJobs, runPipeline, sourceYieldStats };
