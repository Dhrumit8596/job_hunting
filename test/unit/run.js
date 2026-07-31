'use strict';
// Tiny zero-dependency test runner. Each *.test.js exports (t) => { ...assertions... }.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
const t = {
  eq(actual, expected, msg) {
    const A = JSON.stringify(actual), E = JSON.stringify(expected);
    if (A === E) { pass++; }
    else { fail++; fails.push(`${msg || 'eq'}\n      expected ${E}\n      got      ${A}`); }
  },
  ok(cond, msg) { this.eq(!!cond, true, msg); },
};

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

(async () => {
  for (const f of files) {
    // Tests export (t) => void | Promise<void>; await so async tests (timer-driven
    // combobox/DOM flows) complete before we tally results.
    try { await require(path.join(dir, f))(t); }
    catch (e) { fail++; fails.push(`${f} threw: ${e.stack || e.message}`); }
  }

  console.log(`\n${pass} passed, ${fail} failed  (${files.length} test files)`);
  if (fail) { console.log('\nFAILURES:'); fails.forEach(x => console.log('  ✗ ' + x)); process.exit(1); }
  console.log('All green.');
  process.exit(0);
})();
