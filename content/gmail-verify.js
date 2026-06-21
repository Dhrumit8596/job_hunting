(function() {
'use strict';
if (window.__pjaGmailVerifyRunning) return;
window.__pjaGmailVerifyRunning = true;

console.log('PJA gmail-verify: injected into Gmail tab');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isOnSearchPage() {
  return location.hash.startsWith('#search/') || location.pathname.startsWith('/mail/');
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
    if (rows.length > 0) return Array.from(rows);
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

async function main() {
  await sleep(1000);
  if (!isOnSearchPage()) {
    console.log('PJA gmail-verify: not on search page, may be auth challenge');
    chrome.runtime.sendMessage({ type: 'WD_GMAIL_NO_EMAIL_FOUND', reason: 'not_on_search_page' });
    return;
  }

  let rows = await waitForEmailRows(15000);
  if (!rows || rows.length === 0) {
    console.log('PJA gmail-verify: no rows found, waiting 30s for email to arrive');
    await sleep(30000);
    rows = await waitForEmailRows(15000);
    if (!rows || rows.length === 0) {
      console.log('PJA gmail-verify: email never arrived');
      chrome.runtime.sendMessage({ type: 'WD_GMAIL_NO_EMAIL_FOUND', reason: 'email_not_found' });
      return;
    }
    location.reload();
    return;
  }

  console.log('PJA gmail-verify: found', rows.length, 'rows, clicking first');
  rows[0].click();
  await sleep(1500);

  const verifyUrl = await findLinkInEmailBody(8000);
  if (!verifyUrl) {
    console.log('PJA gmail-verify: no link found in email body');
    chrome.runtime.sendMessage({ type: 'WD_GMAIL_NO_EMAIL_FOUND', reason: 'link_not_found' });
    return;
  }

  console.log('PJA gmail-verify: sending WD_GMAIL_FOUND_LINK');
  chrome.runtime.sendMessage({ type: 'WD_GMAIL_FOUND_LINK', verifyUrl });
}

main().catch(err => {
  console.error('PJA gmail-verify error:', err);
  chrome.runtime.sendMessage({ type: 'WD_GMAIL_NO_EMAIL_FOUND', reason: 'exception' });
});
})();
