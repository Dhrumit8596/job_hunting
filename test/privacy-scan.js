'use strict';

// Release guard: real candidate identifiers must never enter tracked source.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
const forbidden = [
  /pooja/i,
  /pujapatel/i,
  /301429119/,
  /8736882634/,
  /pujapatel1216@gmail\.com/i
];
const hits = [];
for (const rel of tracked) {
  if (/^(node_modules|\.git)\//.test(rel)) continue;
  if (rel === 'test/privacy-scan.js') continue;
  const file = path.join(root, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const re of forbidden) if (re.test(text)) hits.push(`${rel}: ${re}`);
}
if (hits.length) {
  console.error('Privacy scan failed:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`Privacy scan passed (${tracked.length} tracked files checked)`);
