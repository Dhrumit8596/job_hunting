// Run this from the extension settings page (chrome-extension://...settings.html)
// It reads your real profile + answers, injects the test queue, and opens the first job.
(async function launchTestQueue() {
  const JOBS = [
    { id: 'lev-sqa-pcba-inspector', title: 'PCBA Quality Inspector', company: 'SQA Services', ats: 'lever',
      applyUrl: 'https://jobs.lever.co/sqaservices/bc7debbc-0b83-46bc-a0ae-9659cdb0616a/apply' },
    { id: 'gh-harbinger-metrology', title: 'Quality Technician, Metrology (Contract)', company: 'Harbinger Motors', ats: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/harbingermotors/jobs/4873922007' },
    { id: 'gh-chaos-hardware-quality', title: 'Hardware Quality Engineer', company: 'CHAOS Industries', ats: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/chaosindustries/jobs/5112064007' },
    { id: 'gh-astranis-prod-quality', title: 'Senior Production Quality Engineer', company: 'Astranis', ats: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/astranis/jobs/4676417006' },
    { id: 'gh-natera-qa-specialist', title: 'Quality Assurance Specialist', company: 'Natera', ats: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/natera/jobs/5973444004' },
    { id: 'wday-amat-eng-tech-iii', title: 'Engineering Technician III (T3)', company: 'Applied Materials', ats: 'workday',
      applyUrl: 'https://amat.wd1.myworkdayjobs.com/en-US/External/job/Engineering-Technician-III----T3-_R2513946/apply/applyManually' },
    { id: 'wday-amat-quality-eng', title: 'Operations and Customer Quality Engineer', company: 'Applied Materials', ats: 'workday',
      applyUrl: 'https://amat.wd1.myworkdayjobs.com/en-US/External/job/Operations-and-Customer-Quality-Engineer_R2415228/apply/applyManually' },
    { id: 'tesla-quality-eng-lathrop', title: 'Quality Engineer', company: 'Tesla', ats: 'tesla',
      applyUrl: 'https://www.tesla.com/careers/search/job/271474' },
  ];

  const data = await new Promise(resolve => chrome.storage.local.get(['pja_profile', 'pja_answers'], resolve));
  const profile = data.pja_profile || {};
  const answers = data.pja_answers || {};

  if (!profile.firstName) {
    alert('Profile is empty! Go to Settings and fill in your profile first.');
    return;
  }

  const queue = {
    status: 'applying',
    jobs: JOBS,
    currentIndex: 0,
    results: { applied: [], skipped: [] },
    profile,
    answers,
    startedAt: Date.now(),
    source: 'test-queue'
  };

  const first = JOBS[0];
  const firstCurrent = { ...first, profile, answers, returnUrl: 'https://www.linkedin.com/jobs/search/?f_AL=true', applyUrl: first.applyUrl };

  await new Promise(resolve => chrome.storage.local.set({ pja_ext_queue: queue, pja_ext_current: firstCurrent }, resolve));

  console.log('PJA test queue set:', JOBS.length, 'jobs. Starting with:', first.title, '@', first.company);
  window.open(first.applyUrl, '_blank');
})();
