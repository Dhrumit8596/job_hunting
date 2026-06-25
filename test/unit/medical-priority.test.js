'use strict';
// medicalWaferBoost: ranks the candidate's core domain (wafer/metrology/inspection/quality/process)
// at MEDICAL-DEVICE companies highest (medical-device domain relevance), without touching off-domain
// or non-medical scores. SYNTHETIC data only.
const { medicalWaferBoost } = require('../../sourcing/filter');

module.exports = (t) => {
  // medical-device + her CORE domain → +12
  t.eq(medicalWaferBoost('Wafer Inspection Engineer', 'Medtronic', 'medical device metrology + defect detection', 80), 92,
    'medical: wafer-inspection at a medical-device co gets the full +12');
  t.eq(medicalWaferBoost('Metrology Engineer', 'BioPoint Diagnostics', 'in-vitro diagnostics, cleanroom', 78), 90,
    'medical: metrology at a diagnostics co boosted +12');

  // medical-device adjacent (quality/manufacturing, not core wafer/metrology) → +7
  t.eq(medicalWaferBoost('Quality Engineer', 'Acme Point-of-Care', 'ISO 13485 medical device quality', 75), 82,
    'medical-adjacent: quality eng at a medical-device co gets +7');

  // non-medical semiconductor → NO boost (still strong, but not the priority)
  t.eq(medicalWaferBoost('Wafer Inspection Engineer', 'Intel', 'semiconductor fab, yield', 85), 85,
    'non-medical semiconductor wafer role unchanged');
  t.eq(medicalWaferBoost('Process Engineer', 'Lam Research', 'etch process development', 88), 88,
    'non-medical process role unchanged');

  // boost caps at 100
  t.eq(medicalWaferBoost('Process Development Engineer', 'Stryker', 'implant manufacturing, surgical device', 95), 100,
    'boost caps at 100 (medical implant + process development)');

  // null/invalid score passes through
  t.eq(medicalWaferBoost('Wafer Inspection Engineer', 'Medtronic', 'medical', null), null, 'null score → null');
};
