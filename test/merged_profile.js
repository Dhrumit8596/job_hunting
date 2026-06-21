'use strict';
// Computes the extension's BASE merged profile = Object.assign({}, PJA_DEFAULT_PROFILE,
// storedProfile) — i.e. what runtime uses (external-apply.js does this merge). Used to
// prove the PII scrub (neutralizing hardcoded defaults + backfilling storage) leaves the
// merged runtime profile byte-for-byte identical.
//
// Usage: node test/merged_profile.js [storedProfileJsonPath]
//   storedProfileJsonPath: a JSON file that is either {pja_profile:{...}},
//   {data:{pja_profile:{...}}}, or a bare profile object. Defaults to storage-backup.local.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadContentScript } = require('./unit/load.js');

function extractStored(json) {
  if (json && json.data && json.data.pja_profile) return json.data.pja_profile;
  if (json && json.pja_profile) return json.pja_profile;
  return json || {};
}

function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort(), 2);
}

const pathArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const storedPath = pathArg || path.resolve(__dirname, '..', 'storage-backup.local.json');
const w = loadContentScript(path.resolve(__dirname, '..', 'content', 'autofill.js'));
const defaults = w.PJA_DEFAULT_PROFILE || {};
const stored = extractStored(JSON.parse(fs.readFileSync(storedPath, 'utf8')));
const merged = Object.assign({}, defaults, stored);
const out = canonical(merged);
const hash = crypto.createHash('sha256').update(out).digest('hex');

// --print: stdout = full merged JSON only (for snapshotting). Otherwise: stdout = hash only.
console.error('merged-profile keys:', Object.keys(merged).length, ' sha256:', hash);
if (process.argv.includes('--print')) process.stdout.write(out + '\n');
else console.log(hash);
