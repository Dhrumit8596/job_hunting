'use strict';
// Orchestrates sourcing: per-source fetch (isolated) -> filter -> dedupe -> fit-score -> route.
const { getAdapter } = require('./adapters');
const { filterJobs } = require('./filter');
const { dedupe, appliedKeySet } = require('./dedupe');

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
      if (!ad) { stats.push({ src: label, ats: src.ats, count: 0, error: 'no-adapter' }); continue; }
      try {
        const got = await ad.fetchJobs(src, opts);
        jobs.push(...got);
        stats.push({ src: label, ats: src.ats, count: got.length });
      } catch (e) {
        stats.push({ src: label, ats: src.ats, count: 0, error: String((e && e.message) || e) });
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

module.exports = { fetchAll, routeJobs, runPipeline };
