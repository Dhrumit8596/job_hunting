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
  // wide net — domain employers (medtech / diagnostics / semicap / battery / hardware / cleantech)
  { ats: 'greenhouse', slug: 'cloudkitchens', name: 'CloudKitchens' },
  { ats: 'greenhouse', slug: 'gecko-robotics', name: 'Gecko Robotics 2' },
  { ats: 'greenhouse', slug: 'pacbio', name: 'PacBio alt' },
  { ats: 'greenhouse', slug: 'thematicbio', name: 'Thematic' },
  { ats: 'greenhouse', slug: 'fluidigm', name: 'Fluidigm' },
  { ats: 'greenhouse', slug: 'illumina', name: 'Illumina' },
  { ats: 'greenhouse', slug: 'bostondynamics', name: 'Boston Dynamics' },
  { ats: 'greenhouse', slug: 'velodyne', name: 'Velodyne alt' },
  { ats: 'greenhouse', slug: 'jabil', name: 'Jabil' },
  { ats: 'greenhouse', slug: 'flex', name: 'Flex' },
  { ats: 'greenhouse', slug: 'lamresearch', name: 'Lam Research' },
  { ats: 'greenhouse', slug: 'wolfspeed', name: 'Wolfspeed' },
  { ats: 'greenhouse', slug: 'skywatertechnology', name: 'SkyWater' },
  { ats: 'greenhouse', slug: 'bloomenergy', name: 'Bloom Energy' },
  { ats: 'greenhouse', slug: 'fiskerinc', name: 'Fisker' },
  { ats: 'greenhouse', slug: 'wisk', name: 'Wisk (check)' },
  { ats: 'greenhouse', slug: 'zeptolife', name: 'Zepto Life' },
  { ats: 'greenhouse', slug: 'genomicstools', name: 'placeholder' },
  { ats: 'lever', slug: 'eikontx', name: 'Eikon alt' },
  { ats: 'lever', slug: 'plenty', name: 'Plenty alt' },
  { ats: 'lever', slug: 'gobsmackgroup', name: 'placeholder2' },
  { ats: 'lever', slug: 'serve-robotics', name: 'Serve Robotics' },
  { ats: 'lever', slug: 'cruise', name: 'Cruise' },
  { ats: 'lever', slug: 'applied-intuition', name: 'Applied Intuition alt' },
  { ats: 'greenhouse', slug: 'rivosinc', name: 'Rivos' },
  { ats: 'greenhouse', slug: 'lightmatter', name: 'Lightmatter' },
  { ats: 'greenhouse', slug: 'ayarlabs', name: 'Ayar Labs' },
  { ats: 'greenhouse', slug: 'sambanovasystems', name: 'SambaNova' },
  { ats: 'greenhouse', slug: 'groq', name: 'Groq' },
  { ats: 'greenhouse', slug: 'astranis', name: 'Astranis (check)' },
  { ats: 'greenhouse', slug: 'temposystems', name: 'Tempo' },
  { ats: 'greenhouse', slug: 'phoenixhydrogen', name: 'placeholder3' },
  { ats: 'greenhouse', slug: 'sublimesystems', name: 'Sublime Systems' },
  { ats: 'greenhouse', slug: 'bostonmetal', name: 'Boston Metal' },
  { ats: 'greenhouse', slug: 'fervoenergy', name: 'Fervo Energy' },
  { ats: 'greenhouse', slug: 'crusoeenergy', name: 'Crusoe' },
  { ats: 'greenhouse', slug: 'universalhydrogen', name: 'placeholder4' },
  { ats: 'greenhouse', slug: 'addionics', name: 'Addionics' },
  { ats: 'greenhouse', slug: '24m', name: '24M' },
  { ats: 'greenhouse', slug: 'cuberg', name: 'Cuberg' },
  // batch 3 — medical device / diagnostics / lab tools / battery on GH+Lever (domain fit)
  { ats: 'greenhouse', slug: 'outsetmedical', name: 'Outset Medical' },
  { ats: 'greenhouse', slug: 'billiontoone', name: 'BillionToOne' },
  { ats: 'greenhouse', slug: 'freenome', name: 'Freenome' },
  { ats: 'greenhouse', slug: 'grail', name: 'GRAIL' },
  { ats: 'greenhouse', slug: 'nautilusbiotechnology', name: 'Nautilus Biotechnology' },
  { ats: 'greenhouse', slug: 'cuehealth', name: 'Cue Health' },
  { ats: 'greenhouse', slug: 'truvianhealth', name: 'Truvian' },
  { ats: 'greenhouse', slug: 'genedx', name: 'GeneDx' },
  { ats: 'lever', slug: 'vicarioussurgical', name: 'Vicarious Surgical' },
  { ats: 'lever', slug: 'diligentrobotics', name: 'Diligent Robotics' },
  { ats: 'lever', slug: 'bearrobotics', name: 'Bear Robotics' },
  { ats: 'greenhouse', slug: 'group14technologies', name: 'Group14' },
  { ats: 'greenhouse', slug: 'essinc', name: 'ESS Inc' },
  { ats: 'greenhouse', slug: 'sesai', name: 'SES AI' },
  { ats: 'greenhouse', slug: 'atomera', name: 'Atomera' },
  { ats: 'greenhouse', slug: 'nextinput', name: 'NextInput' },
  { ats: 'greenhouse', slug: 'inspiremedical', name: 'Inspire Medical' },
  { ats: 'greenhouse', slug: 'axonics', name: 'Axonics' },
  { ats: 'greenhouse', slug: 'pulmonx', name: 'Pulmonx' },
  { ats: 'greenhouse', slug: 'tandemdiabetes', name: 'Tandem Diabetes' },
  { ats: 'lever', slug: 'formlogic', name: 'Formlogic' },
  { ats: 'lever', slug: 'machinemetrics', name: 'MachineMetrics' },
  { ats: 'greenhouse', slug: 'velocitymicro', name: 'placeholder5' },
  { ats: 'greenhouse', slug: 'camtek', name: 'Camtek' },
  { ats: 'greenhouse', slug: 'nuvationenergy', name: 'Nuvation' },
  { ats: 'greenhouse', slug: 'amogy', name: 'Amogy' },
  { ats: 'greenhouse', slug: 'antoraenergy', name: 'Antora alt' },
  { ats: 'greenhouse', slug: 'phasegenomics', name: 'Phase Genomics' },
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
