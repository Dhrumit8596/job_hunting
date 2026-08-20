'use strict';
// Offline registry invariants only. Requiring validate-slugs must never start network probes.
const path = require('path');
const root = path.resolve(__dirname, '../..');
const sources = require(path.join(root, 'sourcing/sources.json')).sources;
const {
  sourceKey,
  isBlockedSource,
  isPlaceholderSource,
  sourceShapeError,
  validateRegistry,
  candidateToSource,
} = require(path.join(root, 'sourcing/validate-slugs'));

module.exports = (t) => {
  t.eq(validateRegistry(sources), [], 'source registry passes all offline invariants');

  const identities = sources.map(sourceKey);
  t.eq(new Set(identities).size, identities.length, 'every ATS source identity is unique');
  t.eq(sources.some(s => /placeholder|\(check\)/i.test(s.name || '')), false,
    'registry contains no placeholder/check company names');
  t.eq(sources.some(isBlockedSource), false,
    'registry contains no source blocked by company name or slug');

  const smart = sources.filter(s => s.ats === 'smartrecruiters');
  t.eq(smart.map(s => s.slug).sort(), [
    'BoschGroup', 'INFICON2', 'Intuitive', 'RenesasElectronics', 'StaubliGroup', 'WesternDigital',
  ], 'six vetted SmartRecruiters employers are configured');
  t.eq(smart.every(s => s.country === 'us'), true,
    'every SmartRecruiters source is explicitly US-scoped');

  const eightfold = sources.filter(s => s.ats === 'eightfold');
  t.eq(eightfold.map(s => s.name).sort(), ['GlobalFoundries', 'Micron'],
    'two verified semiconductor Eightfold employers are configured');
  t.eq(eightfold.every(s => s.location === 'United States' && /^https:\/\//.test(s.origin)), true,
    'every Eightfold source is US-scoped and uses a secure branded origin');

  const successfactors = sources.filter(s => s.ats === 'successfactors');
  t.eq(successfactors.map(s => s.name), ['TSMC'],
    'verified TSMC SuccessFactors employer is configured');
  t.eq(successfactors.every(s => s.locationSearch === 'United States' && /^https:\/\//.test(s.baseUrl)), true,
    'every SuccessFactors source is US-scoped and uses a secure branded board');

  const jj = sources.find(s => s.ats === 'workday' && s.name === 'Johnson & Johnson');
  t.eq({ apiUrl: jj && jj.apiUrl, alias: jj && jj.aliases.includes('Shockwave Medical'),
    host: jj && jj.careerHosts.includes('careers.jnj.com') },
  { apiUrl: 'https://jj.wd5.myworkdayjobs.com/wday/cxs/jj/JJ/jobs', alias: true, host: true },
  'Johnson & Johnson Workday source carries the validated endpoint and exact Shockwave employer route metadata');
  const cisco = sources.find(s => s.ats === 'workday' && s.name === 'Cisco');
  t.eq({ apiUrl: cisco && cisco.apiUrl, host: cisco && cisco.careerHosts.includes('careers.cisco.com') },
  { apiUrl: 'https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers/jobs', host: true },
  'Cisco Workday source carries its validated public CXS endpoint and registered careers host');
  t.eq(sources.filter(s => s.ats === 'ashby' && ['skydio', 'marianaminerals'].includes(s.slug))
    .map(s => s.slug).sort(), ['marianaminerals', 'skydio'],
  'validated Skydio and Mariana Minerals Ashby boards are registered');
  const cellink = sources.find(s => s.ats === 'greenhouse' && s.slug === 'cellink');
  t.eq({ name: cellink && cellink.name, alias: cellink && cellink.aliases.includes('CelLink Corporation'),
    host: cellink && cellink.careerHosts.includes('cellinktechnologies.com') },
  { name: 'CelLink', alias: true, host: true },
  'validated CelLink Greenhouse board carries exact employer aliases and career-host metadata');
  const amat = sources.find(s => s.ats === 'workday' && s.name === 'Applied Materials');
  t.eq({ careerHosts: amat && amat.careerHosts.slice().sort(), routeHosts: amat && amat.routeHosts },
  { careerHosts: ['careers.appliedmaterials.com', 'jobs.appliedmaterials.com'], routeHosts: ['dsp.prng.co'] },
  'Applied Materials route hints require its registered employer hosts, including the bounded prng redirect origin');

  t.eq(sources.filter(s => s.ats === 'greenhouse' && s.slug === 'nuro').length, 1,
    'Nuro exact duplicate is removed');
  t.eq(sources.filter(s => s.slug === 'foundry-robotics').map(s => s.ats), ['ashby'],
    'dead Foundry Lever board removed while live Ashby board remains');
  t.eq(sources.filter(s => s.slug === 'wayve').map(s => s.name), ['Wayve', 'Wayve'],
    'Wayve uses one canonical company name across ATSes');

  const retired = new Set([
    'cerebrassystems', 'guardanthealth', 'pacificbiosciences', 'nanostring',
    'standardbiotools', 'benchling', 'gritstonebio', 'cariboubiosciences',
    'mammothbiosciences', 'matterport', 'saildrone', 'zipline', 'ouraring',
    'plenty', 'AtomicSemi', 'oklo', 'kairospower', 'astranis', 'lightmatter',
    'sambanovasystems', 'skyryse', 'sweetgreen',
  ]);
  t.eq(sources.some(s => retired.has(s.slug)), false,
    'dead, policy-blocked, duplicate-adjacent, and irrelevant placeholder sources stay removed');

  t.eq(sourceKey({ ats: 'Ashby', slug: 'Wayve/' }), 'ashby:wayve',
    'sourceKey normalizes ATS, case, whitespace, and trailing slash');
  t.eq(sourceKey({ ats: 'workday', apiUrl: 'HTTPS://ACME.WD1.MYWORKDAYJOBS.COM/jobs/' }),
    'workday:https://acme.wd1.myworkdayjobs.com/jobs', 'Workday identity uses normalized apiUrl');
  t.eq(sourceKey({ ats: 'Eightfold', origin: 'HTTPS://CAREERS.ACME.COM/', domain: 'ACME.COM' }),
    'eightfold:https://careers.acme.com|acme.com', 'Eightfold identity uses origin and employer domain');
  t.eq(sourceKey({ ats: 'SuccessFactors', baseUrl: 'HTTPS://CAREERS.ACME.COM/' }),
    'successfactors:https://careers.acme.com', 'SuccessFactors identity uses its branded board');
  t.eq(isBlockedSource({ name: 'Alias', slug: 'skyryse' }), true,
    'slug-based export block catches aliases that obscure the company name');
  t.eq(isBlockedSource({ name: 'Astranis (check)', slug: 'alias' }), true,
    'name-based export block remains enforced');
  t.eq(isPlaceholderSource({ name: 'Candidate (check)' }), true,
    'placeholder/check candidates are rejected before append');

  t.eq(sourceShapeError({ ats: 'workday', name: 'Acme', siteBase: 'https://x' }),
    'workday source missing apiUrl', 'Workday requires an explicit CXS apiUrl');
  t.eq(sourceShapeError({ ats: 'workday', name: 'Acme', apiUrl: 'https://x' }),
    'workday source missing siteBase', 'Workday requires a siteBase');
  t.eq(sourceShapeError({ ats: 'smartrecruiters', name: 'Acme', slug: 'Acme' }),
    'smartrecruiters source must be scoped to country=us', 'SmartRecruiters requires US scope');
  t.eq(sourceShapeError({ ats: 'eightfold', name: 'Acme', domain: 'acme.com' }),
    'eightfold source missing origin', 'Eightfold requires a branded origin');
  t.eq(sourceShapeError({ ats: 'eightfold', name: 'Acme', origin: 'http://careers.acme.com', domain: 'acme.com' }),
    'eightfold source origin must be https', 'Eightfold requires HTTPS');
  t.eq(sourceShapeError({ ats: 'successfactors', name: 'Acme', locationSearch: 'United States' }),
    'successfactors source missing baseUrl', 'SuccessFactors requires a branded base URL');
  t.eq(sourceShapeError({ ats: 'successfactors', name: 'Acme', baseUrl: 'http://careers.acme.com', locationSearch: 'United States' }),
    'successfactors source baseUrl must be https', 'SuccessFactors requires HTTPS');
  t.eq(sourceShapeError({ ats: 'successfactors', name: 'Acme', baseUrl: 'https://careers.acme.com' }),
    'successfactors source must be scoped to the United States', 'SuccessFactors requires a US scope');

  const duplicateErrors = validateRegistry([
    { ats: 'lever', slug: 'Acme', name: 'Acme' },
    { ats: 'LEVER', slug: 'acme/', name: 'Acme Duplicate' },
  ]);
  t.eq(duplicateErrors.some(e => e.includes('duplicate identity lever:acme')), true,
    'duplicate detection uses normalized identities');

  t.eq(candidateToSource({
    ats: 'SmartRecruiters', slug: 'Acme', name: 'Acme', country: 'us', live: true, total: 10,
  }), { ats: 'smartrecruiters', slug: 'Acme', name: 'Acme', country: 'us' },
  'candidateToSource preserves source configuration and drops probe metadata');
};
