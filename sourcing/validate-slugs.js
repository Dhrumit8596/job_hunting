'use strict';
// Slug validator / registry auto-expander.
//   node sourcing/validate-slugs.js           # probe CANDIDATES, print live ones + eligible counts
//   node sourcing/validate-slugs.js --append  # also append live, non-duplicate, non-export-blocked
//                                             # candidates to sources.json
//
// "Live" = the public ATS API returns ≥1 posting. We also count how many roles survive the
// TN/CA eligibility filter so we add high-yield sources. Re-run anytime to grow the registry
// without hand-checking slugs — that's how a run scales to whatever volume is needed.
const fs = require('fs');
const path = require('path');
const greenhouse = require('./adapters/greenhouse');
const lever = require('./adapters/lever');
const { filterJobs, isExportControlledCompany } = require('./filter');

const ADAPTERS = { greenhouse, lever };
const SOURCES_PATH = path.resolve(__dirname, 'sources.json');

// Best-effort domain-fit candidates (medtech, lab/genomics tools, hardware, robotics, battery).
// Dead slugs simply return nothing and are dropped. Export-controlled firms are skipped on append.
const CANDIDATES = [
  // medical device (CA-heavy)
  { ats: 'greenhouse', slug: 'shockwavemedical', name: 'Shockwave Medical' },
  { ats: 'greenhouse', slug: 'inarimedical', name: 'Inari Medical' },
  { ats: 'greenhouse', slug: 'silkroadmedical', name: 'Silk Road Medical' },
  { ats: 'greenhouse', slug: 'nevro', name: 'Nevro' },
  { ats: 'greenhouse', slug: 'irhythmtechnologies', name: 'iRhythm Technologies' },
  { ats: 'lever', slug: 'noahmedical', name: 'Noah Medical' },
  // lab / genomics / diagnostics tools
  { ats: 'greenhouse', slug: 'singulargenomics', name: 'Singular Genomics' },
  { ats: 'greenhouse', slug: 'quantum-si', name: 'Quantum-Si' },
  { ats: 'greenhouse', slug: 'seer', name: 'Seer' },
  { ats: 'greenhouse', slug: 'akoyabio', name: 'Akoya Biosciences' },
  { ats: 'greenhouse', slug: 'bionanogenomics', name: 'Bionano' },
  { ats: 'greenhouse', slug: 'personalis', name: 'Personalis' },
  { ats: 'greenhouse', slug: 'vaxcyte', name: 'Vaxcyte' },
  // hardware / additive / robotics
  { ats: 'greenhouse', slug: 'velo3d', name: 'Velo3D' },
  { ats: 'greenhouse', slug: 'desktopmetal', name: 'Desktop Metal' },
  { ats: 'lever', slug: 'covariant', name: 'Covariant' },
  { ats: 'lever', slug: 'machinalabs', name: 'Machina Labs' },
  { ats: 'greenhouse', slug: 'divergent3d', name: 'Divergent' },
  { ats: 'greenhouse', slug: 'appliedintuition', name: 'Applied Intuition' },
  { ats: 'lever', slug: 'aeva', name: 'Aeva' },
  { ats: 'greenhouse', slug: 'ouster', name: 'Ouster' },
  // battery / energy / cleantech
  { ats: 'greenhouse', slug: 'quantumscape', name: 'QuantumScape' },
  { ats: 'greenhouse', slug: 'enovix', name: 'Enovix' },
  { ats: 'greenhouse', slug: 'ampriustechnologies', name: 'Amprius Technologies' },
  { ats: 'greenhouse', slug: 'silananotechnologies', name: 'Sila' },
  { ats: 'greenhouse', slug: 'lyten', name: 'Lyten' },
  { ats: 'greenhouse', slug: 'mitrachem', name: 'Mitra Chem' },
  { ats: 'greenhouse', slug: 'natronenergy', name: 'Natron Energy' },
  { ats: 'greenhouse', slug: 'electrichydrogen', name: 'Electric Hydrogen' },
  // semicap / test
  { ats: 'greenhouse', slug: 'aehrtestsystems', name: 'Aehr Test Systems' },
  { ats: 'greenhouse', slug: 'pdfsolutions', name: 'PDF Solutions' },
  // second batch — alternate slug formats / known GH+Lever users in domain
  { ats: 'greenhouse', slug: 'sutrobiopharma', name: 'Sutro Biopharma' },
  { ats: 'greenhouse', slug: 'denalitherapeutics', name: 'Denali Therapeutics' },
  { ats: 'greenhouse', slug: 'nurixtherapeutics', name: 'Nurix Therapeutics' },
  { ats: 'greenhouse', slug: 'cyteinc', name: 'Cyte' },
  { ats: 'lever', slug: 'matician', name: 'Matic' },
  { ats: 'lever', slug: 'pathrobotics', name: 'Path Robotics' },
  { ats: 'lever', slug: 'cobaltrobotics', name: 'Cobalt Robotics' },
  { ats: 'greenhouse', slug: 'formenergy', name: 'Form Energy' },
  { ats: 'greenhouse', slug: 'boomsupersonic', name: 'Boom (skip-check)' },
  { ats: 'greenhouse', slug: 'rocketlab', name: 'Rocket Lab (skip-check)' },
  { ats: 'greenhouse', slug: 'velodynelidar', name: 'Velodyne' },
  { ats: 'greenhouse', slug: 'pivotbio', name: 'Pivot Bio' },
  { ats: 'greenhouse', slug: 'impossiblefoods', name: 'Impossible Foods' },
  { ats: 'greenhouse', slug: 'chargepoint', name: 'ChargePoint' },
  { ats: 'greenhouse', slug: 'gecko', name: 'Gecko Robotics' },
];

async function probe(c) {
  const adapter = ADAPTERS[c.ats];
  if (!adapter) return { ...c, live: false, total: 0, eligible: 0, err: 'no adapter' };
  try {
    const jobs = await adapter.fetchJobs(c);
    const total = jobs.length;
    const eligible = filterJobs(jobs).length;
    return { ...c, live: total > 0, total, eligible };
  } catch (e) {
    return { ...c, live: false, total: 0, eligible: 0, err: e.message };
  }
}

(async () => {
  const append = process.argv.includes('--append');
  const reg = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const existing = new Set(reg.sources.map(s => s.ats + ':' + s.slug));

  const results = [];
  for (const c of CANDIDATES) { results.push(await probe(c)); }

  results.sort((a, b) => b.eligible - a.eligible || b.total - a.total);
  console.log('\n  ATS         SLUG                       TOTAL  ELIGIBLE  STATUS');
  for (const r of results) {
    const dup = existing.has(r.ats + ':' + r.slug);
    const blocked = isExportControlledCompany(r.name);
    const status = !r.live ? 'dead' : dup ? 'already in registry' : blocked ? 'export-blocked' : 'NEW';
    console.log(`  ${r.ats.padEnd(11)} ${r.slug.padEnd(26)} ${String(r.total).padStart(5)}  ${String(r.eligible).padStart(8)}  ${status}`);
  }

  if (append) {
    const toAdd = results.filter(r => r.live && !existing.has(r.ats + ':' + r.slug) && !isExportControlledCompany(r.name))
      .map(r => ({ ats: r.ats, slug: r.slug, name: r.name }));
    if (toAdd.length) {
      reg.sources.push(...toAdd);
      fs.writeFileSync(SOURCES_PATH, JSON.stringify(reg, null, 2) + '\n');
      console.log(`\n  appended ${toAdd.length} live source(s): ${toAdd.map(s => s.name).join(', ')}`);
    } else {
      console.log('\n  nothing new to append.');
    }
  } else {
    const newLive = results.filter(r => r.live && !existing.has(r.ats + ':' + r.slug) && !isExportControlledCompany(r.name)).length;
    console.log(`\n  ${newLive} new live source(s) available — re-run with --append to add them.`);
  }
})();
