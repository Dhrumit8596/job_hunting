'use strict';

function extractIndeed() {
  const url = window.location.href;
  if (!url.includes('indeed.com')) return null;

  const titleSelectors = [
    'h1.jobsearch-JobInfoHeader-title',
    'h1[data-testid="jobsearch-JobInfoHeader-title"]',
    '.jobsearch-JobInfoHeader-title',
    '.icl-u-xs-mb--xs.icl-u-xs-mt--none',
    'h1.jobTitle',
    '[data-jk] h1',
    '.jobsearch-ViewJobLayout h1'
  ];

  const companySelectors = [
    '[data-testid="inlineHeader-companyName"] a',
    '[data-testid="inlineHeader-companyName"]',
    '.jobsearch-InlineCompanyRating-companyHeader a',
    '.jobsearch-InlineCompanyRating-companyHeader',
    '.icl-u-lg-mr--sm.icl-u-xs-mr--xs',
    '[data-company-name]',
    '.jobsearch-CompanyInfoContainer a'
  ];

  const descSelectors = [
    '#jobDescriptionText',
    '.jobsearch-jobDescriptionText',
    '[data-testid="jobsearch-JobComponent-description"]',
    '.jobsearch-JobComponent-description',
    '#job-content'
  ];

  const title = pickFirstText(titleSelectors);
  const company = pickFirstText(companySelectors);
  const description = pickFirstInnerText(descSelectors);

  if (!title && !company) return null;
  return { title, company, description };
}

function pickFirstText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

function pickFirstInnerText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || el.textContent).trim()) {
      return (el.innerText || el.textContent).trim();
    }
  }
  return null;
}
