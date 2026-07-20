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
const { getAdapter } = require('./adapters');
const { filterJobs, isExportControlledCompany } = require('./filter');

const SOURCES_PATH = path.resolve(__dirname, 'sources.json');

function normalizeKeyPart(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

// Slug-backed ATSes are identified by slug. Workday tenants are identified by their exact CXS
// endpoint because they do not have a portable board slug in this registry.
function sourceKey(source) {
  const ats = normalizeKeyPart(source && source.ats);
  const identity = ats === 'workday'
    ? normalizeKeyPart(source && source.apiUrl)
    : ats === 'eightfold'
      ? [normalizeKeyPart(source && source.origin), normalizeKeyPart(source && source.domain)].filter(Boolean).join('|')
    : ats === 'successfactors'
      ? normalizeKeyPart(source && (source.baseUrl || source.origin || source.siteBase))
    : normalizeKeyPart(source && source.slug);
  return ats && identity ? `${ats}:${identity}` : '';
}

function isBlockedSource(source) {
  return isExportControlledCompany(source && source.name) ||
    isExportControlledCompany(source && source.slug);
}

function isPlaceholderSource(source) {
  return /placeholder|\(check\)/i.test(String(source && source.name || ''));
}

function sourceShapeError(source) {
  if (!source || typeof source !== 'object') return 'source must be an object';
  const ats = normalizeKeyPart(source.ats);
  if (!ats) return 'missing ats';
  if (!getAdapter(ats)) return `unsupported ats ${ats}`;
  if (!String(source.name || '').trim()) return 'missing name';
  if (ats === 'workday') {
    if (!String(source.apiUrl || '').trim()) return 'workday source missing apiUrl';
    if (!String(source.siteBase || '').trim()) return 'workday source missing siteBase';
  } else if (ats === 'eightfold') {
    if (!String(source.origin || '').trim()) return 'eightfold source missing origin';
    if (!String(source.domain || '').trim()) return 'eightfold source missing domain';
    try {
      const origin = new URL(String(source.origin));
      if (origin.protocol !== 'https:') return 'eightfold source origin must be https';
    } catch (_) { return 'eightfold source origin must be a valid URL'; }
  } else if (ats === 'successfactors') {
    if (!String(source.baseUrl || '').trim()) return 'successfactors source missing baseUrl';
    try {
      const baseUrl = new URL(String(source.baseUrl));
      if (baseUrl.protocol !== 'https:') return 'successfactors source baseUrl must be https';
    } catch (_) { return 'successfactors source baseUrl must be a valid URL'; }
    if (!/united states|\bus\b/i.test(String(source.locationSearch || source.location || ''))) {
      return 'successfactors source must be scoped to the United States';
    }
  } else if (!String(source.slug || '').trim()) {
    return `${ats} source missing slug`;
  }
  if (ats === 'smartrecruiters' && normalizeKeyPart(source.country) !== 'us') {
    return 'smartrecruiters source must be scoped to country=us';
  }
  return '';
}

function validateRegistry(sources) {
  if (!Array.isArray(sources)) return ['registry sources must be an array'];
  const errors = [];
  const seen = new Map();
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const label = `source[${i}] ${String(source && source.name || '').trim() || '(unnamed)'}`;
    const shapeError = sourceShapeError(source);
    if (shapeError) errors.push(`${label}: ${shapeError}`);
    const key = sourceKey(source);
    if (key) {
      if (seen.has(key)) errors.push(`${label}: duplicate identity ${key} (first at source[${seen.get(key)}])`);
      else seen.set(key, i);
    }
    if (isPlaceholderSource(source)) {
      errors.push(`${label}: placeholder/check name is not allowed`);
    }
    if (isBlockedSource(source)) errors.push(`${label}: export-controlled source is not allowed`);
  }
  return errors;
}

function candidateToSource(candidate) {
  const keys = ['ats', 'slug', 'name', 'apiUrl', 'siteBase', 'country', 'query', 'queries',
    'origin', 'domain', 'baseUrl', 'searchPath', 'location', 'locationSearch',
    'pageSize', 'perQueryMax'];
  const source = {};
  for (const key of keys) if (candidate[key] != null) source[key] = candidate[key];
  source.ats = normalizeKeyPart(source.ats);
  return source;
}

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
  // batch 4 — sectors with many manufacturing/quality/hardware roles (no-login GH/Lever)
  { ats: 'greenhouse', slug: 'eightsleep', name: 'Eight Sleep' },
  { ats: 'greenhouse', slug: 'whoop', name: 'WHOOP' },
  { ats: 'greenhouse', slug: 'sonos', name: 'Sonos' },
  { ats: 'greenhouse', slug: 'fictiv', name: 'Fictiv' },
  { ats: 'greenhouse', slug: 'xometry', name: 'Xometry' },
  { ats: 'greenhouse', slug: 'protolabs', name: 'Protolabs' },
  { ats: 'greenhouse', slug: 'markforged', name: 'Markforged' },
  { ats: 'lever', slug: 'berkshiregrey', name: 'Berkshire Grey' },
  { ats: 'lever', slug: 'fetchrobotics', name: 'Fetch Robotics' },
  { ats: 'greenhouse', slug: 'locusrobotics', name: 'Locus Robotics' },
  { ats: 'greenhouse', slug: 'rivian', name: 'Rivian' },
  { ats: 'greenhouse', slug: 'canoo', name: 'Canoo' },
  { ats: 'greenhouse', slug: 'proterra', name: 'Proterra' },
  { ats: 'greenhouse', slug: 'harbingermotors', name: 'Harbinger' },
  { ats: 'greenhouse', slug: 'moxionpower', name: 'Moxion Power' },
  { ats: 'greenhouse', slug: 'basepowercompany', name: 'Base Power' },
  { ats: 'greenhouse', slug: 'sciencecorp', name: 'Science Corp' },
  { ats: 'greenhouse', slug: 'openwater', name: 'Openwater' },
  { ats: 'greenhouse', slug: 'synchron', name: 'Synchron' },
  { ats: 'greenhouse', slug: 'paradromics', name: 'Paradromics' },
  { ats: 'greenhouse', slug: 'czbiohub', name: 'CZ Biohub' },
  { ats: 'greenhouse', slug: 'altoslabs', name: 'Altos Labs' },
  { ats: 'greenhouse', slug: 'arcadia', name: 'Arcadia' },
  { ats: 'greenhouse', slug: 'crusoe', name: 'Crusoe' },
  { ats: 'greenhouse', slug: 'terabase', name: 'Terabase Energy' },
  { ats: 'greenhouse', slug: 'lydianlabs', name: 'Lydian' },
  { ats: 'greenhouse', slug: 'cyclicmaterials', name: 'Cyclic Materials' },
  { ats: 'greenhouse', slug: 'nthcycle', name: 'Nth Cycle' },
  { ats: 'greenhouse', slug: 'ascend-elements', name: 'Ascend Elements' },
  { ats: 'greenhouse', slug: 'phoenixtailings', name: 'Phoenix Tailings' },
  { ats: 'greenhouse', slug: 'twelve', name: 'Twelve' },
  { ats: 'greenhouse', slug: 'heirloomcarbon', name: 'Heirloom' },
  { ats: 'greenhouse', slug: 'mainspring', name: 'Mainspring Energy' },
  { ats: 'greenhouse', slug: 'zinc8', name: 'placeholder6' },
  { ats: 'lever', slug: 'matician', name: 'Matic' },
  { ats: 'lever', slug: 'pathrobotics', name: 'Path Robotics' },
  { ats: 'greenhouse', slug: 'glydways', name: 'Glydways' },
  { ats: 'greenhouse', slug: 'skyryse', name: 'placeholder7' },
  // batch 5 — manufacturing-heavy (EV / contract-mfg / industrial / medtech-mfg), no-login GH/Lever
  { ats: 'greenhouse', slug: 'xostrucks', name: 'Xos Trucks' },
  { ats: 'greenhouse', slug: 'lioneletric', name: 'Lion Electric' },
  { ats: 'lever', slug: 'apptronik', name: 'Apptronik' },
  { ats: 'lever', slug: 'rapidrobotics', name: 'Rapid Robotics' },
  { ats: 'greenhouse', slug: 'hadrian', name: 'Hadrian' },
  { ats: 'greenhouse', slug: 'fastradius', name: 'Fast Radius' },
  { ats: 'greenhouse', slug: 'establishmentlabs', name: 'Establishment Labs' },
  { ats: 'greenhouse', slug: 'treace', name: 'Treace Medical' },
  { ats: 'greenhouse', slug: 'telabio', name: 'TELA Bio' },
  { ats: 'greenhouse', slug: 'proceptbiorobotics', name: 'PROCEPT BioRobotics' },
  { ats: 'greenhouse', slug: 'shoulderinnovations', name: 'Shoulder Innovations' },
  { ats: 'greenhouse', slug: 'nuvasive', name: 'NuVasive' },
  { ats: 'greenhouse', slug: 'temposystems', name: 'Tempo' },
  { ats: 'lever', slug: 'veo-robotics', name: 'Veo Robotics' },
  { ats: 'greenhouse', slug: 'monogram', name: 'Monogram Orthopedics' },
  { ats: 'greenhouse', slug: 'kodiakrobotics', name: 'Kodiak Robotics' },
  { ats: 'greenhouse', slug: 'gatik', name: 'Gatik' },
  { ats: 'lever', slug: 'stackav', name: 'Stack AV' },
  { ats: 'greenhouse', slug: 'electra', name: 'Electra' },
  { ats: 'greenhouse', slug: 'lineagelogistics', name: 'Lineage' },
  { ats: 'greenhouse', slug: 'sweetgreen', name: 'placeholder8' },
  { ats: 'greenhouse', slug: 'velo3d', name: 'Velo3D' },
  { ats: 'greenhouse', slug: 'seurat', name: 'Seurat' },
  { ats: 'greenhouse', slug: 'vulcanforms', name: 'VulcanForms' },
  { ats: 'greenhouse', slug: 'machinalabs', name: 'Machina Labs' },
];

async function probe(c, opts = {}) {
  const adapter = getAdapter(c && c.ats);
  if (!adapter) return { ...c, live: false, total: 0, eligible: 0, err: 'no adapter' };
  try {
    const jobs = await adapter.fetchJobs(c, opts);
    const total = jobs.length;
    const nationwideUS = normalizeKeyPart(c && c.country) === 'us';
    const eligible = filterJobs(jobs, { nationwideUS }).length;
    return { ...c, live: total > 0, total, eligible };
  } catch (e) {
    return { ...c, live: false, total: 0, eligible: 0, err: e.message };
  }
}

async function runCli() {
  const append = process.argv.includes('--append');
  const reg = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const registryErrors = validateRegistry(reg.sources);
  if (registryErrors.length) {
    throw new Error(`registry validation failed:\n${registryErrors.map(e => `  - ${e}`).join('\n')}`);
  }
  const existing = new Set(reg.sources.map(sourceKey).filter(Boolean));

  const results = [];
  for (const c of CANDIDATES) { results.push(await probe(c)); }

  results.sort((a, b) => b.eligible - a.eligible || b.total - a.total);
  console.log('\n  ATS         IDENTIFIER                                    TOTAL  ELIGIBLE  STATUS');
  for (const r of results) {
    const dup = existing.has(sourceKey(r));
    const blocked = isBlockedSource(r);
    const placeholder = isPlaceholderSource(r);
    const status = !r.live ? 'dead' : dup ? 'already in registry' : blocked ? 'export-blocked' : placeholder ? 'invalid-name' : 'NEW';
    const identity = String(r.slug || r.apiUrl || '-');
    console.log(`  ${String(r.ats).padEnd(11)} ${identity.padEnd(45)} ${String(r.total).padStart(5)}  ${String(r.eligible).padStart(8)}  ${status}`);
  }

  if (append) {
    const toAdd = results.filter(r => r.live && !existing.has(sourceKey(r)) && !isBlockedSource(r) && !isPlaceholderSource(r))
      .map(candidateToSource);
    if (toAdd.length) {
      reg.sources.push(...toAdd);
      const errors = validateRegistry(reg.sources);
      if (errors.length) throw new Error(`refusing invalid append:\n${errors.map(e => `  - ${e}`).join('\n')}`);
      fs.writeFileSync(SOURCES_PATH, JSON.stringify(reg, null, 2) + '\n');
      console.log(`\n  appended ${toAdd.length} live source(s): ${toAdd.map(s => s.name).join(', ')}`);
    } else {
      console.log('\n  nothing new to append.');
    }
  } else {
    const newLive = results.filter(r => r.live && !existing.has(sourceKey(r)) && !isBlockedSource(r) && !isPlaceholderSource(r)).length;
    console.log(`\n  ${newLive} new live source(s) available — re-run with --append to add them.`);
  }
}

if (require.main === module) {
  runCli().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = {
  CANDIDATES,
  SOURCES_PATH,
  normalizeKeyPart,
  sourceKey,
  isBlockedSource,
  isPlaceholderSource,
  sourceShapeError,
  validateRegistry,
  candidateToSource,
  probe,
  runCli,
};
