'use strict';

module.exports = t => {
  const { DEFAULT_MAX_CHARS, scoringExcerpt } = require('../../scoring-context');

  t.eq(scoringExcerpt('Short posting'), 'Short posting', 'scoring context: short posting is unchanged');

  const marketing = Array.from({ length: 180 }, (_, i) => `Company marketing paragraph ${i} with general information.`).join('\n');
  const requirements = [
    'Minimum qualifications',
    'Must have five years of semiconductor manufacturing experience.',
    'Preferred: a bachelor degree in mechanical engineering.',
  ].join('\n');
  const long = `${marketing}\n${requirements}\n${marketing}`;
  const excerpt = scoringExcerpt(long);
  t.ok(excerpt.length <= DEFAULT_MAX_CHARS, 'scoring context: long posting is bounded');
  t.ok(excerpt.includes('five years of semiconductor manufacturing experience'),
    'scoring context: requirement-bearing lines are retained');
  t.ok(excerpt.includes('[POSTING OPENING]') && excerpt.includes('[POSTING CLOSING]'),
    'scoring context: opening and closing evidence are labeled');
};
