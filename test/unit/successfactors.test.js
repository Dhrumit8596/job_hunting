'use strict';
// SuccessFactors/RMK adapter tests use synthetic HTML only; no network or personal data.
const fs = require('fs');
const path = require('path');
const sf = require('../../sourcing/adapters/successfactors');
const ROOT = path.resolve(__dirname, '../..');

const SOURCE = {
  ats: 'successfactors',
  name: 'Acme Semiconductor',
  baseUrl: 'https://careers.acme.example',
  locationSearch: 'United States',
  pageSize: 25,
};

function searchHtml() {
  return `
    <table id="searchresults"><tbody>
      <tr class="data-row">
        <td><a href="/job/Phoenix-Mask-Process%2FEquipment-Engineer-AZ/1063271366/" class="jobTitle-link">Mask Process/Equipment Engineer</a></td>
        <td><span class="jobLocation">Phoenix, AZ, US, 85001</span></td>
        <td><span class="jobDate">Jul 4, 2026</span></td>
      </tr>
      <tr class="data-row featured">
        <td><a class="jobTitle-link" href="/job/Phoenix-Quality-&amp;-Systems-Analyst-AZ/22/">Quality &amp; Systems Analyst</a></td>
        <td><span class="jobLocation visible-phone"><span class="jobLocation">Phoenix, AZ, US</span></span></td>
        <td><span class="jobDate">Jul 3, 2026</span></td>
      </tr>
    </tbody></table>`;
}

function detailHtml() {
  return `
    <head><link rel="canonical" href="https://careers.acme.example/job/Phoenix-Mask-Process-Engineer-AZ/1063271366/"></head>
    <div class="jobDisplayShell" itemscope itemtype="http://schema.org/JobPosting">
      <span itemprop="jobLocation"><span itemprop="address">
        <meta content="Phoenix" itemprop="addressLocality"><meta itemprop="addressRegion" content="AZ">
        <meta itemprop="postalCode" content="85001"><meta content="US" itemprop="addressCountry">
      </span></span>
      <meta itemprop="datePosted" content="Sat Jul 04 16:00:00 UTC 2026">
      <meta itemprop="hiringOrganization" content="Acme Arizona">
      <a class="btn apply dialogApplyBtn" href="/talentcommunity/apply/1063271366/?locale=en_US">Apply now</a>
      <h1><span itemprop="title">Mask Process/Equipment Engineer</span></h1>
      <span class="outer" itemprop="description"><span class="jobdescription">
        <p>Own EUV mask <span>process control</span> and metrology.</p>
        <p><b>Minimum:</b> SPC &amp; DOE experience.</p>
      </span></span>
    </div>`;
}

module.exports = async (t) => {
  t.eq(sf.decodeEntities('Quality &amp; DOE &#x2013; 3&#43; years'),
    'Quality & DOE – 3+ years', 'successfactors: named and numeric entities decoded');

  const url = new URL(sf.searchUrl(SOURCE, 50, 'process engineer'));
  t.eq(url.pathname, '/search/', 'successfactors: canonical public search path');
  t.eq(url.searchParams.get('q'), 'process engineer', 'successfactors: keyword query encoded');
  t.eq(url.searchParams.get('locationsearch'), 'United States', 'successfactors: location scope encoded');
  t.eq(url.searchParams.get('startrow'), '50', 'successfactors: startrow pagination encoded');

  const rows = sf.parseSearchPage(searchHtml(), SOURCE);
  t.eq(rows.length, 2, 'successfactors: one record per server-rendered result row');
  t.eq(rows[0].id, '1063271366', 'successfactors: stable posting id parsed from detail URL');
  t.eq(rows[0].location, 'Phoenix, AZ, US, 85001', 'successfactors: listing location parsed');
  t.eq(rows[1].title, 'Quality & Systems Analyst', 'successfactors: listing title entities decoded');

  const detail = sf.parseDetailPage(detailHtml(), SOURCE,
    'https://careers.acme.example/job/Phoenix-Mask-Process-Engineer-AZ/1063271366/');
  t.eq(detail.id, '1063271366', 'successfactors: detail id comes from canonical URL');
  t.eq(detail.title, 'Mask Process/Equipment Engineer', 'successfactors: microdata title parsed');
  t.eq(detail.location, 'Phoenix, AZ, US, 85001', 'successfactors: PostalAddress microdata combined');
  t.ok(detail.description.includes('process control and metrology'),
    'successfactors: nested spans do not truncate full job description');
  t.ok(detail.description.includes('SPC & DOE experience'),
    'successfactors: requirements retained as matching evidence');
  t.eq(detail.applyUrl,
    'https://careers.acme.example/talentcommunity/apply/1063271366/?locale=en_US',
    'successfactors: direct public apply route preferred over landing page');

  const normalized = sf.normalize(detail, SOURCE);
  t.eq(normalized.ats, 'successfactors', 'successfactors: normalized ATS set');
  t.eq(normalized.company, 'Acme Semiconductor', 'successfactors: configured company is authoritative');
  t.ok(normalized.description.length > 60, 'successfactors: normalized record carries grounded JD text');

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (requestUrl, options = {}) => {
    calls.push({ url: String(requestUrl), method: options.method });
    if (String(requestUrl).includes('/search/')) {
      return { ok: true, status: 200, text: async () => searchHtml() };
    }
    if (String(requestUrl).includes('/1063271366/')) {
      return { ok: true, status: 200, text: async () => detailHtml() };
    }
    throw new Error('unexpected URL');
  };
  try {
    const jobs = await sf.fetchJobs(SOURCE, { max: 25, detailMax: 25, detailConcurrency: 2 });
    t.eq(jobs.length, 2, 'successfactors: fetch returns complete search page');
    t.ok(jobs[0].description.includes('SPC & DOE experience'),
      'successfactors: engineering result enriched from detail page');
    t.eq(jobs[1].description, '', 'successfactors: non-engineering result avoids unnecessary detail GET');
    t.eq(calls.length, 2, 'successfactors: one search GET plus one relevant detail GET');
    t.ok(calls.every(call => call.method === 'GET'), 'successfactors: adapter is read-only GET only');
  } finally { global.fetch = originalFetch; }

  // Regression guard for the acknowledged dev-server ↔ extension bridge that starts
  // RMK's client-side Apply Now flow without filling or submitting an application itself.
  const serverSource = fs.readFileSync(path.join(ROOT, 'dev-server.js'), 'utf8');
  const backgroundSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  t.ok(serverSource.includes("req.url === '/successfactors-start'") &&
    serverSource.includes("wsAsk('successFactorsStart'") &&
    serverSource.includes("'successFactorsStartReply', 15000"),
  'successfactors: HTTP route uses an acknowledged 15s WS round trip');
  t.ok(backgroundSource.includes("msg.cmd === 'successFactorsStart'") &&
    backgroundSource.includes("world: 'MAIN'") &&
    backgroundSource.includes('apply.handleApplyNowButton'),
  'successfactors: background invokes the RMK handler in the page MAIN world');
  t.ok(backgroundSource.includes("cmd: 'successFactorsStartReply'") &&
    backgroundSource.includes("host.startsWith('careers.')") &&
    backgroundSource.includes("host.includes('successfactors')"),
  'successfactors: bridge acknowledges diagnostics and has careers/SuccessFactors fallback matching');
};
