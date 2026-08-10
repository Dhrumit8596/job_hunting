'use strict';
// Contract tests for the executable strategy registry. No browser, network, or live application.
const router = require('../../content/apply-router');

module.exports = async (t) => {
  t.eq(router.resolveStrategy({ channel: 'linkedin_easy_apply' }).name, 'linkedin_ea',
    'apply router: LinkedIn queue channel selects LinkedIn Easy Apply handler');
  t.eq(router.resolveStrategy({ channel: 'indeed_apply' }).name, 'indeed',
    'apply router: Indeed queue channel selects Indeed handler');
  t.eq(router.resolveStrategy({ applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/X' }).name, 'workday',
    'apply router: Workday URL selects Workday handler');
  t.eq(router.resolveStrategy({ applyUrl: 'https://jobs.smartrecruiters.com/Acme/123' }).name, 'smartrecruiters',
    'apply router: SmartRecruiters URL selects SmartRecruiters handler');

  let received = null;
  router.registerHandler('greenhouse', async context => {
    received = context;
    return { outcome: 'ready_to_submit_review' };
  });
  const result = await router.executeStrategy(
    { id: 'synthetic-gh', applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' },
    { rawAnswers: { synthetic: true } }
  );
  t.eq(result.handled, true, 'apply router: registered strategy handler is executed');
  t.eq(result.route.name, 'greenhouse', 'apply router: executor preserves selected route');
  t.eq(result.outcome, 'ready_to_submit_review', 'apply router: handler result is preserved');
  t.eq(received.job.id, 'synthetic-gh', 'apply router: handler receives the canonical job record');

  const unsupported = await router.executeStrategy({ applyUrl: 'https://example.test/not-an-application' }, { signals: {} });
  t.eq(unsupported.handled, false, 'apply router: unsupported page never falls through to a form handler');
  t.eq(unsupported.reason, 'unsupported_apply_strategy', 'apply router: unsupported page has a normalized reason');
};
