'use strict';
// Runs `node --check` on every project .js file (excluding node_modules). Fails loudly.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules', '.git']);
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error('  ✗ syntax error: ' + path.relative(root, f) + '\n' + (e.stderr || e.message)); }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
if (failed) process.exit(1);
