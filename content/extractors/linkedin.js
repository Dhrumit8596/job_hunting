'use strict';

function extractLinkedIn() {
  const url = window.location.href;
  if (!url.includes('linkedin.com')) return null;

  // ── Title ──────────────────────────────────────────────────────────────────
  const titleSelectors = [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title h1',
    '.jobs-unified-top-card__job-title',
    '.jobs-search__job-details h1',
    '.job-details-module h1',
    '.t-24.t-bold.inline',
    'h1.t-24',
    'h1.job-title',
    '.job-title h1',
    '[data-test="job-title"]',
    '.jobs-top-card__job-title',
    '.topcard__title',
    'h1.topcard__title'
  ];

  // ── Company ────────────────────────────────────────────────────────────────
  const companySelectors = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.job-details-jobs-unified-top-card__primary-description-without-tagline a',
    '.jobs-search__job-details .artdeco-entity-lockup__subtitle a',
    '.jobs-details-top-card__company-url',
    '.topcard__org-name-link',
    '.topcard__flavor a',
    '[data-test="job-company-name"]'
  ];

  // ── Description ────────────────────────────────────────────────────────────
  const descSelectors = [
    '.jobs-description-content__text',
    '.jobs-description__content .jobs-description-content',
    '#job-details',
    '.jobs-box__html-content',
    '.description__text',
    '.jobs-description',
    '[data-test="job-description"]',
    '.show-more-less-html__markup'
  ];

  const title = pickFirst(titleSelectors);
  const company = pickFirst(companySelectors);
  const description = pickFirstInner(descSelectors);

  if (!title && !company) return null;
  return { title, company, description };
}

function pickFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

function pickFirstInner(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || el.textContent).trim()) {
      return (el.innerText || el.textContent).trim();
    }
  }
  return null;
}
