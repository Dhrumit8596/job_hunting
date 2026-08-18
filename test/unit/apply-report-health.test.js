'use strict';

const Health = require('../../apply-report-health');

module.exports = t => {
  const fallback = { preflightHealth: {
    profileConfigured: true,
    resumeConfigured: true,
    profileFieldCount: 14,
    verifiedAt: 1234,
  } };
  const fromPreflight = Health.resolveReportHealth({ pja_ranked_apply: { runId: 'r1' } }, fallback);
  t.eq(fromPreflight.profileConfigured, true,
    'apply report health: successful admission preflight prevents profile unknown on sparse export reads');
  t.eq(fromPreflight.resumeConfigured, true,
    'apply report health: successful admission preflight prevents false resume missing');
  t.eq(fromPreflight.source, 'preflight', 'apply report health: fallback source is explicit');

  const direct = Health.resolveReportHealth({
    pja_profile: { firstName: 'A', lastName: 'B', city: 'Configured' },
    pja_resume_filename: '',
  }, fallback);
  t.eq(direct.profileConfigured, true, 'apply report health: current storage overrides preflight profile state');
  t.eq(direct.resumeConfigured, false, 'apply report health: an explicit empty current resume overrides fallback');
  t.eq(direct.source, 'storage', 'apply report health: complete direct health reads are identified');
};
