'use strict';

const path = require('path');
const fs = require('fs');

module.exports = (t) => {
  const contentSource = fs.readFileSync(path.resolve(__dirname, '../../content/content.js'), 'utf8');
  t.ok(
    contentSource.includes('pointer-events:none') &&
      contentSource.includes('z-index:auto;pointer-events:none') &&
      contentSource.includes("host.style.zIndex = '2147483647'") &&
      contentSource.includes("host.style.zIndex = 'auto'") &&
      contentSource.includes('function isExternalAtsPage()') &&
      contentSource.includes('myworkdayjobs\\.com') &&
      contentSource.includes('function maybeAutoOpenSidebar()') &&
      contentSource.includes('else closeSidebar()') &&
      contentSource.includes('function isLinkedInApplyRoute(value)') &&
      contentSource.includes('jobs\\/(?:search|search-results)') &&
      contentSource.includes("u.searchParams.get('currentJobId')") &&
      contentSource.includes('resumeApplyOnLoad();') &&
      contentSource.includes('activeEasyApplyResumeKey === resumeKey') &&
      contentSource.includes('if (isLinkedInApplyRoute(location.href)) resumeApplyOnLoad();') &&
      contentSource.includes('if (!s) return;') &&
      contentSource.includes('#pja-sidebar') &&
      contentSource.includes('pointer-events: auto'),
    'content UI: external ATS pages keep the sidebar closed/click-through unless manually opened',
  );
};
