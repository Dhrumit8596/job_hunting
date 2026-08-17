'use strict';

const ApplySelect = require('../../sourcing/apply-select');

module.exports = t => {
  const state = id => ({ status: 'sourced', fitScore: 90, attempts: 0 });
  const corpus = {
    index: {
      gh: { company: 'A', title: 'GH', applyUrl: 'https://boards.greenhouse.io/a/jobs/1', channel: 'external', descriptionReady: true },
      li: { company: 'B', title: 'LI', applyUrl: 'https://www.linkedin.com/jobs/view/123456789', channel: 'linkedin_easy_apply', isEasyApply: true, descriptionReady: true },
      ind: { company: 'C', title: 'Indeed', applyUrl: 'https://www.indeed.com/viewjob?jk=abc', channel: 'indeed_apply', indeedApply: true, descriptionReady: true },
    },
    state: { gh: state('gh'), li: state('li'), ind: state('ind') },
  };
  const external = ApplySelect.buildApplySet(corpus, { threshold: 70, channelAllow: ['external'], dailyCap: 10 });
  t.eq(external.map(j => j.id), ['gh'], 'category filter: external channel cannot launch native jobs');
  const linkedIn = ApplySelect.buildApplySet(corpus, { threshold: 70, channelAllow: ['linkedin_easy_apply'], dailyCap: 10 });
  t.eq(linkedIn.map(j => j.id), ['li'], 'category filter: LinkedIn-only run cannot spill into other channels');
  const plan = ApplySelect.buildApplyPlan(corpus, { threshold: 70, channelAllow: ['indeed_apply'], dailyCap: 10 });
  t.eq(plan.jobs.map(j => j.id), ['ind'], 'category filter: plan selects only requested channel');
  t.eq(plan.dropCounts.channel_not_allowed, 2, 'category filter: excluded channels have a deterministic drop reason');
};

