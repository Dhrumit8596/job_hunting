(function() {
'use strict';
if (window.__pjaGmailVerifyRunning) return;
window.__pjaGmailVerifyRunning = true;

console.log('PJA gmail-verify: injected into Gmail tab');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendNoEmail(reason) {
  chrome.storage.local.get('pja_email_code_session', d => {
    const details = {
      reason,
      pageUrl: location.href,
      pageTitle: document.title || '',
      hasSearchInput: !!document.querySelector('input[aria-label="Search mail"], input[placeholder="Search mail"], form[role="search"] input'),
      hash: location.hash || ''
    };
    if (d && d.pja_email_code_session) chrome.runtime.sendMessage({ type: 'EMAIL_CODE_NOT_FOUND', ...details });
    else chrome.runtime.sendMessage({ type: 'WD_GMAIL_NO_EMAIL_FOUND', ...details });
  });
}

function isOnSearchPage() {
  return location.hash.startsWith('#search/') || /\/#search\//.test(location.href);
}

async function runSearchFromInbox(query) {
  if (!query) return false;
  const input = document.querySelector('input[aria-label="Search mail"], input[placeholder="Search mail"], form[role="search"] input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, query);
  else input.value = query;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: query, inputType: 'insertText' }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  const btn = document.querySelector('button[aria-label="Search mail"], button[aria-label="Search"]');
  if (btn) btn.click();
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (isOnSearchPage()) return true;
  }
  return isOnSearchPage();
}

async function waitForSearchContext(query, maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (isOnSearchPage()) return true;
    const shellReady = !!document.querySelector('input[aria-label="Search mail"], input[placeholder="Search mail"], form[role="search"] input');
    if (shellReady && await runSearchFromInbox(query)) return true;
    await sleep(750);
  }
  return isOnSearchPage();
}

async function waitForEmailRows(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(500);
    const rows = document.querySelectorAll(
      'tr.zA, ' +
      '[role="row"][data-legacy-last-message-id], ' +
      'tr[data-thread-id], ' +
      '[data-thread-id]'
    );
    const visibleRows = Array.from(rows).filter(isVisibleEl);
    if (visibleRows.length > 0) return visibleRows;
  }
  return null;
}

async function findLinkInEmailBody(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(400);
    const msgBody = document.querySelector('div.a3s.aiL, div.a3s, [data-message-id] div.ii.gt');
    if (!msgBody) continue;

    const links = Array.from(msgBody.querySelectorAll('a[href]'));
    const verifyLink = links.find(a =>
      /verify|confirm|activate|reset.*password|click here|get started/i.test(a.textContent.trim()) &&
      /workday|myworkdayjobs/i.test(a.href)
    );
    if (verifyLink) return verifyLink.href;

    const tokenLink = links.find(a =>
      /myworkdayjobs\.com|workday\.com/i.test(a.href) &&
      /[?&](token|key|code|verify|reset|confirm)=/i.test(a.href)
    );
    if (tokenLink) return tokenLink.href;
  }
  return null;
}

function extractVerificationCode(text, expectedLength) {
  const body = String(text || '').replace(/\s+/g, ' ');
  const len = Number(expectedLength || 0);
  const patterns = [
    /(?:security|verification|confirm(?:ation)?|one[- ]?time|email)\s+code(?:\s+is|\s*:)?\s*([A-Z0-9]{6,10})/i,
    /code\s+into\s+the\s+security\s+code\s+field\s+on\s+your\s+application\s*:\s*([A-Z0-9]{6,10})/i,
    /enter\s+(?:the\s+)?(?:\d[- ]?)?(?:character\s+)?code\s+([A-Z0-9]{6,10})/i,
    /\bcode\s*[:#-]?\s*([A-Z0-9]{6,10})\b/i
  ];
  const candidates = [];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) candidates.push(m[1].trim().toUpperCase());
  }
  return candidates.find(c => /^[A-Z0-9]{6,10}$/.test(c) && (!len || c.length === len)) ||
    candidates.find(c => /^[A-Z0-9]{6,10}$/.test(c)) || null;
}

function safeRe(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function redactVerificationTokens(text) {
  return normalizeText(text).replace(/\b(?=[A-Za-z0-9]{6,10}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]+\b/g, '[code]');
}

function isVisibleEl(el) {
  try {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (_) {
    return false;
  }
}

function firstVisible(selector) {
  return Array.from(document.querySelectorAll(selector)).find(isVisibleEl) || null;
}

function parsePossibleDateMs(text) {
  const raw = String(text || '').replace(/\([^)]*\)/g, ' ').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectOpenedEmailEvidence(codeSession) {
  const subject = normalizeText(
    firstVisible('h2.hP, .ha h2, [data-legacy-message-id] h2, [role="main"] h2')?.textContent || ''
  ).slice(0, 200);
  const messageContainers = Array.from(document.querySelectorAll('[data-message-id], div.adn.ads, div.gs'))
    .filter(isVisibleEl);
  const bodyEls = Array.from(document.querySelectorAll('div.a3s.aiL, div.a3s, [data-message-id] div.ii.gt, .ii.gt'))
    .filter(isVisibleEl);
  const candidates = messageContainers.length > 0 ? messageContainers : bodyEls;
  const company = String(codeSession?.company || '').trim();
  const companyRe = company ? new RegExp(safeRe(company).replace(/\s+/g, '\\s+'), 'i') : null;
  const startedAt = Number(codeSession?.startedAt || 0);
  const evidences = candidates.map(container => {
    const bodyText = normalizeText(container.innerText || container.textContent || '');
    const senderEl = container.querySelector?.('[email], .gD[email], span[email], [data-hovercard-id]') || firstVisible('[email], .gD[email], span[email], [data-hovercard-id]');
    const sender = normalizeText(
      senderEl?.getAttribute('email') || senderEl?.getAttribute('data-hovercard-id') || senderEl?.textContent || ''
    ).slice(0, 180);
    const dateCandidates = Array.from(container.querySelectorAll?.('[title], [aria-label]') || [])
      .map(el => el.getAttribute('title') || el.getAttribute('aria-label') || '')
      .concat(bodyText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/ig) || [])
      .filter(txt => /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4})\b/i.test(txt))
      .slice(0, 20);
    const dateMs = dateCandidates.map(parsePossibleDateMs).find(v => v && Number.isFinite(v)) || null;
    const joined = `${subject} ${sender} ${bodyText}`;
    const companyMatched = !!companyRe && companyRe.test(joined);
    const vendorMatched = /greenhouse/i.test(joined);
    const sourceMatched = companyRe ? (companyMatched && vendorMatched) : vendorMatched;
    const securityMatched = /security code|verification code|confirm (?:your email|you'?re a human|you are human)|8[- ]?character code|one[- ]?time code|email code|copy and paste this code/i.test(joined);
    let code = extractVerificationCode(bodyText, codeSession?.expectedLength || 8);
    // Greenhouse often renders the code as a standalone large token. Accept that shape only after
    // the opened message is already verified as a Greenhouse/company security-code email.
    if (!code && sourceMatched && securityMatched) {
      const standalone = bodyText.match(/\b([A-Z0-9]{8})\b/i);
      if (standalone && standalone[1]) code = standalone[1].trim().toUpperCase();
    }
    const dateFresh = dateMs ? (!startedAt || dateMs >= startedAt - 10 * 60 * 1000) : null;
    const verified = !!code && sourceMatched && securityMatched && dateFresh !== false;
    return {
      verified,
      sourceMatched,
      companyMatched,
      securityMatched,
      dateFresh,
      dateMs,
      dateCandidates: dateCandidates.slice(0, 5),
      subject,
      sender,
      vendorMatched,
      pageUrl: location.href,
      pageTitle: document.title || '',
      snippet: redactVerificationTokens(bodyText).slice(0, 600),
      code,
      codeLength: code ? code.length : 0,
    };
  }).filter(Boolean);
  return evidences.find(e => e.verified) ||
    evidences.filter(e => e.code).sort((a, b) => Number(b.dateMs || 0) - Number(a.dateMs || 0))[0] ||
    evidences[0] || {
      verified: false,
      sourceMatched: false,
      companyMatched: false,
      securityMatched: false,
      dateFresh: null,
      dateMs: null,
      dateCandidates: [],
      subject,
      sender: '',
      vendorMatched: false,
      pageUrl: location.href,
      pageTitle: document.title || '',
      snippet: '',
      code: null,
      codeLength: 0,
    };
}

function collectRowEmailEvidence(row, codeSession) {
  const rowText = normalizeText(row?.innerText || row?.textContent || '');
  const company = String(codeSession?.company || '').trim();
  const companyRe = company ? new RegExp(safeRe(company).replace(/\s+/g, '\\s+'), 'i') : null;
  const companyMatched = !!companyRe && companyRe.test(rowText);
  const vendorMatched = /greenhouse/i.test(rowText);
  const sourceMatched = companyRe ? (companyMatched && vendorMatched) : vendorMatched;
  const securityMatched = /security code|verification code|confirm (?:your email|you'?re a human|you are human)|8[- ]?character code|one[- ]?time code|email code/i.test(rowText);
  let code = extractVerificationCode(rowText, codeSession?.expectedLength || 8);
  if (!code && sourceMatched && securityMatched) {
    const standalone = rowText.match(/\b([A-Z0-9]{8})\b/i);
    if (standalone && standalone[1]) code = standalone[1].trim().toUpperCase();
  }
  const verified = !!code && sourceMatched && securityMatched;
  return {
    verified,
    sourceMatched,
    companyMatched,
    vendorMatched,
    securityMatched,
    dateFresh: null,
    dateMs: null,
    dateCandidates: [],
    subject: rowText.match(/Security code for your application to [^-]+/i)?.[0]?.slice(0, 200) || '',
    sender: rowText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '',
    pageUrl: location.href,
    pageTitle: document.title || '',
    snippet: redactVerificationTokens(rowText).slice(0, 600),
    code,
    codeLength: code ? code.length : 0,
  };
}

async function findCodeInEmailBody(maxMs = 8000, expectedLength = 8, codeSession = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(400);
    const msgBody = firstVisible('div.a3s.aiL, div.a3s, [data-message-id] div.ii.gt');
    if (!msgBody) continue;
    const evidence = collectOpenedEmailEvidence({ ...(codeSession || {}), expectedLength });
    if (evidence.code) return evidence;
  }
  return null;
}

async function main() {
  await sleep(1000);
  const sessionData = await new Promise(r => chrome.storage.local.get('pja_email_code_session', r));
  const codeSession = sessionData && sessionData.pja_email_code_session;
  if (!isOnSearchPage()) {
    const ready = codeSession && await waitForSearchContext(codeSession.searchQuery || '');
    if (!ready) {
      console.log('PJA gmail-verify: not on search page, may be auth challenge');
      sendNoEmail('not_on_search_page');
      return;
    }
  }

  let rows = await waitForEmailRows(15000);
  if (!rows || rows.length === 0) {
    console.log('PJA gmail-verify: no rows found, waiting 30s for email to arrive');
    await sleep(30000);
    rows = await waitForEmailRows(15000);
    if (!rows || rows.length === 0) {
      console.log('PJA gmail-verify: email never arrived');
      sendNoEmail('email_not_found');
      return;
    }
    location.reload();
    return;
  }

  if (codeSession && codeSession.mode === 'code') {
    // Gmail may land directly in the newest matching thread. Handle that first; otherwise the row
    // selector can match many background/thread elements and the verifier wastes the whole window.
    if (document.querySelector('div.a3s.aiL, div.a3s, [data-message-id] div.ii.gt')) {
      const openEvidence = await findCodeInEmailBody(8000, codeSession.expectedLength || 8, codeSession);
      if (openEvidence?.verified) {
        console.log('PJA gmail-verify: sending EMAIL_CODE_FOUND from open email len=' + openEvidence.code.length + ' subject=' + openEvidence.subject);
        chrome.runtime.sendMessage({ type: 'EMAIL_CODE_FOUND', code: openEvidence.code, codeLength: openEvidence.code.length,
          evidence: { ...openEvidence, code: undefined } });
        return;
      }
      if (openEvidence?.code) {
        console.log('PJA gmail-verify: rejected open-email code source', JSON.stringify({
          sourceMatched: openEvidence.sourceMatched,
          securityMatched: openEvidence.securityMatched,
          dateFresh: openEvidence.dateFresh,
          subject: openEvidence.subject,
          sender: openEvidence.sender,
        }));
      }
    }
    console.log('PJA gmail-verify: found', rows.length, 'rows, scanning for verification code');
    let evidence = null;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const fresh = Array.from(document.querySelectorAll('tr.zA, [role="row"][data-legacy-last-message-id], tr[data-thread-id], [data-thread-id]'))
        .filter(isVisibleEl);
      if (!fresh[i]) break;
      const rowEvidence = collectRowEmailEvidence(fresh[i], codeSession);
      if (rowEvidence?.verified) {
        console.log('PJA gmail-verify: sending EMAIL_CODE_FOUND from row len=' + rowEvidence.code.length + ' subject=' + rowEvidence.subject);
        chrome.runtime.sendMessage({ type: 'EMAIL_CODE_FOUND', code: rowEvidence.code, codeLength: rowEvidence.code.length,
          evidence: { ...rowEvidence, code: undefined } });
        return;
      }
      if (codeSession.company && !rowEvidence.companyMatched) {
        evidence = evidence || rowEvidence;
        continue;
      }
      fresh[i].click();
      await sleep(1500);
      evidence = await findCodeInEmailBody(6000, codeSession.expectedLength || 8, codeSession);
      if (evidence?.verified) break;
      if (evidence?.code && !evidence.verified) {
        console.log('PJA gmail-verify: rejected unverified code source', JSON.stringify({
          sourceMatched: evidence.sourceMatched,
          securityMatched: evidence.securityMatched,
          dateFresh: evidence.dateFresh,
          subject: evidence.subject,
          sender: evidence.sender,
        }));
      }
      if (isOnSearchPage()) { /* already list */ } else { history.back(); await sleep(1200); }
    }
    if (!evidence?.verified) {
      console.log('PJA gmail-verify: no verification code found in top emails');
      chrome.runtime.sendMessage({ type: 'EMAIL_CODE_NOT_FOUND', reason: evidence?.code ? 'unverified_email_source' : 'code_not_found',
        evidence: evidence ? { ...evidence, code: undefined } : null });
      return;
    }
    console.log('PJA gmail-verify: sending EMAIL_CODE_FOUND len=' + evidence.code.length + ' subject=' + evidence.subject);
    chrome.runtime.sendMessage({ type: 'EMAIL_CODE_FOUND', code: evidence.code, codeLength: evidence.code.length,
      evidence: { ...evidence, code: undefined } });
    return;
  }

  console.log('PJA gmail-verify: found', rows.length, 'rows, scanning top', Math.min(rows.length, 4));
  // Broad search may return several rows — open the newest few until one has a Workday link.
  let verifyUrl = null;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    // rows go stale after navigation; re-query each pass.
    const fresh = document.querySelectorAll('tr.zA, [role="row"][data-legacy-last-message-id], tr[data-thread-id], [data-thread-id]');
    if (!fresh[i]) break;
    fresh[i].click();
    await sleep(1500);
    verifyUrl = await findLinkInEmailBody(6000);
    if (verifyUrl) break;
    // go back to the results list for the next row
    if (isOnSearchPage()) { /* already list */ } else { history.back(); await sleep(1200); }
  }
  if (!verifyUrl) {
    console.log('PJA gmail-verify: no Workday link found in top emails');
    sendNoEmail('link_not_found');
    return;
  }

  console.log('PJA gmail-verify: sending WD_GMAIL_FOUND_LINK');
  chrome.runtime.sendMessage({ type: 'WD_GMAIL_FOUND_LINK', verifyUrl });
}

main().catch(err => {
  console.error('PJA gmail-verify error:', err);
  sendNoEmail('exception');
});
})();
