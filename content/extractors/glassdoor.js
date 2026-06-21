'use strict';

function extractGlassdoor() {
  const url = window.location.href;
  if (!url.includes('glassdoor.com')) return null;

  const titleSelectors = [
    '[data-test="job-title"]',
    '.job-title',
    'h1[class*="jobTitle"]',
    '.JobDetails_jobTitle__Rw_gn',
    '.css-1vg6q84',
    'h1.e1tk4kwz5',
    '[class*="JobDetails_jobTitle"]',
    'h1[class*="title"]'
  ];

  const companySelectors = [
    '[data-test="employer-name"]',
    '.employer-name',
    '[class*="employerName"]',
    '.JobDetails_companyName__t4sYr',
    '.e1tk4kwz1',
    '[class*="CompanyName"]',
    '[class*="companyName"]'
  ];

  const descSelectors = [
    '[class*="JobDetails_jobDescription"]',
    '[data-test="jobDescriptionContent"]',
    '.jobDescriptionContent',
    '.desc',
    '[class*="jobDescription"]',
    '#JobDescriptionContainer'
  ];

  const title = pickFirstGD(titleSelectors);
  const company = pickFirstGD(companySelectors);
  const description = pickFirstInnerGD(descSelectors);

  if (!title && !company) return null;
  return { title, company, description };
}

function pickFirstGD(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch (_) {}
  }
  return null;
}

function pickFirstInnerGD(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && (el.innerText || el.textContent).trim()) {
        return (el.innerText || el.textContent).trim();
      }
    } catch (_) {}
  }
  return null;
}
