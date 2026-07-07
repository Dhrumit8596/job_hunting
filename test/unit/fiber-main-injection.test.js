'use strict';
// Regression guard: fiber-main.js (the MAIN-world react-select onChange bridge) MUST be
// declared as a MAIN-world content script that loads BEFORE the ISOLATED fill pass.
// Bug it prevents: fiber-main was only injected lazily at the resume-upload step, which runs
// AFTER the combobox/AI-answer fill — so pjaFillViaReactFiber dispatched pja:reactselect with
// no MAIN-world listener present, silently returned false, and every react-select fell to the
// flaky click path (FAIL→native → required question left blank → whole application skipped,
// e.g. PsiQuantum "are you friends or relatives with any current employees?*").
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

module.exports = (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const blocks = manifest.content_scripts || [];

  const fiberBlock = blocks.find(cs =>
    cs.world === 'MAIN' && (cs.js || []).some(f => /fiber-main\.js$/.test(f)));

  t.ok(!!fiberBlock, 'manifest declares a MAIN-world content-script block for fiber-main.js');
  if (!fiberBlock) return;

  // Must run at document_start so the bridge exists before external-apply (document_idle) fills.
  t.eq(fiberBlock.run_at, 'document_start',
    'fiber-main MAIN block runs at document_start (before the document_idle fill pass)');

  // Must cover the ATS hosts where we fill react-selects. external-apply matches <all_urls>;
  // the bridge must match at least as broadly so it is present wherever we fill.
  t.ok((fiberBlock.matches || []).includes('<all_urls>'),
    'fiber-main MAIN block matches <all_urls> (parity with the external-apply fill scope)');
};
