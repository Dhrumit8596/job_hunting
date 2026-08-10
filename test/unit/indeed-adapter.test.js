'use strict';

const adapter = require('../../sourcing/adapters/indeed');

module.exports = async (t) => {
  const htmlWithJobs = `\
<script type="application/json">\
{"props":{"pageProps":{"data":{"jobs":[
  {"jobkey":"jk_qa_001","title":"Process Engineer","companyName":"Acme Systems","formattedLocation":"Sunnyvale, CA","jobDescription":"Quality-focused engineer role.","jobkey":"jk_qa_001","indeedApply":true,"url":"/viewjob?jk=jk_qa_001"},
  {"jobkey":"jk_qa_002","title":"Manufacturing Engineer","companyName":"Beta Devices","formattedLocation":"San Jose, CA","snippet":"Manufacturing quality role.","url":"/viewjob?jk=jk_qa_002"}
 ]}}}}\
</script>`;

  const okResponse = {
    ok: true,
    text: async () => htmlWithJobs,
  };

  const originalFetch = global.fetch;
  let called = 0;
  global.fetch = async (url) => {
    called += 1;
    t.ok(String(url).includes('https://www.indeed.com/jobs'), 'indeed adapter calls indeed search endpoint');
    t.ok(/q=quality%20engineer/.test(String(url)), 'indeed adapter sends query term');
    return okResponse;
  };

  const first = await adapter.fetchJobs({}, { queries: ['quality engineer'], timeoutMs: 2000 });
  t.eq(called, 1, 'indeed adapter performs exactly one search request for one query');
  t.eq(first.length, 2, 'indeed adapter extracts two jobs from embedded JSON');
  const firstJob = first.find(j => j.id === 'jk_qa_001');
  t.eq(firstJob.channel, 'indeed_apply', 'indeed indeedApply=true becomes indeed_apply channel');
  t.eq(firstJob.platform, 'indeed', 'indeed adapter preserves platform hint');
  t.eq(firstJob.indeedApply, true, 'indeed adapter retains indeedApply signal for indeed easy apply');

  global.fetch = async () => ({
    ok: true,
    text: async () => '<html>cf-challenge</html>',
  });

  const blockedJobs = await adapter.fetchJobs({}, { queries: ['process engineer'], timeoutMs: 2000 });
  t.eq(blockedJobs.length, 0, 'blocked/empty responses return a deterministic empty list');

  const anchorHtml = '<a href="/viewjob?jk=jk_anchor_1">Senior QA Engineer</a> text <a href="https://www.indeed.com/viewjob?jk=jk_anchor_2">Manufacturing QA Lead</a>';
  const anchorParsed = adapter.extractJobsFromAnchorHints(anchorHtml);
  t.eq(anchorParsed.length, 2, 'fallback anchor parser extracts direct job links');
  t.eq(adapter.extractJobsFromAnchorHints('<html></html>').length, 0, 'anchor parser returns empty when there are no job links');

  global.fetch = originalFetch;
};
