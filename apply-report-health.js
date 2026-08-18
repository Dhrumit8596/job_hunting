'use strict';

function compactPreflightHealth(value) {
  if (!value || typeof value !== 'object') return null;
  const fieldCount = value.profileFieldCount == null ? null : Math.max(0, Number(value.profileFieldCount) || 0);
  return {
    profileConfigured: value.profileConfigured === true,
    resumeConfigured: value.resumeConfigured === true,
    profileFieldCount: fieldCount,
    verifiedAt: Number(value.verifiedAt) || null,
  };
}

function resolveReportHealth(storage = {}, runControl = null) {
  const fallback = compactPreflightHealth(runControl && runControl.preflightHealth);
  const hasProfile = Object.prototype.hasOwnProperty.call(storage, 'pja_profile');
  const profileFieldCount = hasProfile && storage.pja_profile && typeof storage.pja_profile === 'object'
    ? Object.entries(storage.pja_profile).filter(([key, value]) =>
      key !== 'savedAt' && value != null && String(value).trim()).length
    : fallback && fallback.profileFieldCount;
  const profileConfigured = hasProfile
    ? profileFieldCount != null && profileFieldCount >= 3
    : fallback ? fallback.profileConfigured : null;
  const hasResume = Object.prototype.hasOwnProperty.call(storage, 'pja_resume_filename');
  const resumeConfigured = hasResume
    ? !!String(storage.pja_resume_filename || '').trim()
    : fallback ? fallback.resumeConfigured : null;
  return { profileConfigured, profileFieldCount, resumeConfigured, source: hasProfile && hasResume ? 'storage' : fallback ? 'preflight' : 'unknown' };
}

module.exports = { compactPreflightHealth, resolveReportHealth };
