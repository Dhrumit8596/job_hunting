'use strict';

function extractGeneric() {
  // 1. Try JSON-LD schema.org/JobPosting
  const jsonLdResult = tryJsonLd();
  if (jsonLdResult) return jsonLdResult;

  // 2. Try Open Graph / meta tags
  const ogResult = tryMetaTags();
  if (ogResult) return ogResult;

  // 3. Try common heading + content patterns
  const heuristicResult = tryHeuristic();
  if (heuristicResult) return heuristicResult;

  return null;
}

function tryJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          return {
            title: item.title || item.name || null,
            company: item.hiringOrganization?.name || null,
            description: stripHtml(item.description || item.responsibilities || '')
          };
        }
      }
    } catch (_) {}
  }
  return null;
}

function tryMetaTags() {
  const title =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="twitter:title"]')?.content ||
    null;

  if (!title) return null;

  const siteName =
    document.querySelector('meta[property="og:site_name"]')?.content || null;

  const desc =
    document.querySelector('meta[property="og:description"]')?.content ||
    document.querySelector('meta[name="description"]')?.content ||
    null;

  return { title: title.trim(), company: siteName, description: desc };
}

function tryHeuristic() {
  const h1 = document.querySelector('h1');
  const title = h1?.textContent.trim() || document.title?.split(/[|\-–]/)[0].trim();

  // Try common company name selectors used across many job sites
  const companySelectors = [
    '.topcard__org-name-link', '.topcard__flavor a',
    '[class*="companyName"] a', '[class*="company-name"] a',
    '[class*="employer-name"] a', '[class*="employerName"] a',
    '[class*="companyName"]', '[class*="company-name"]',
    '[class*="employer-name"]', '[class*="employerName"]',
    '[data-company-name]', '[data-testid*="company"]',
    '.org-name', '.company', 'a[data-company]'
  ];
  let company = null;
  for (const sel of companySelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) { company = el.textContent.trim(); break; }
    } catch (_) {}
  }

  // Look for a large text block that looks like a job description
  const candidates = Array.from(document.querySelectorAll('div, section, article'));
  let longest = '';
  for (const el of candidates) {
    const text = el.innerText || el.textContent || '';
    if (text.length > longest.length && text.length < 20000) longest = text;
  }

  if (!title) return null;
  return { title, company, description: longest.trim().slice(0, 8000) };
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.innerText || div.textContent || '').trim();
}
