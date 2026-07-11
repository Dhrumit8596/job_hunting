'use strict';
// LIVE end-to-end verification of the "Find 200+" gate through the REAL dev-server.
//
//   Terminal 1:  node dev-server.js
//   Terminal 2:  node test/live-verify.js
//
// A protocol-compatible storage client (same WS getStorage/setStorage/storageReply protocol the
// extension uses) mirrors chrome.storage in memory AND imports the corpus into the REAL IndexedDB
// engine (idb-store + fake-indexeddb). It then runs the goal's exact curl-equivalent checks,
// including a two-pass applied-exclusion proof. Exit 0 = gate satisfied.
//
// When the ACTUAL Chrome extension is connected instead of this client, the same /source-v2 +
// /get-storage calls verify against real extension storage — this proves the wiring is correct.
require('fake-indexeddb/auto');
const path = require('path');
const WebSocket = require(path.resolve(__dirname, '../node_modules/ws'));
const idb = require(path.resolve(__dirname, '../idb-store'));
const { roleKey } = require(path.resolve(__dirname, '../sourcing/jobid'));

const BASE = 'http://localhost:6174';
const store = {};
let appliedSeed = [];

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:6174');
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.cmd === 'getStorage') {
        const data = {};
        for (const k of msg.keys || []) {
          if (k === 'pja_applied_log') data[k] = appliedSeed;
          else if (k in store) data[k] = store[k];
        }
        ws.send(JSON.stringify({ cmd: 'storageReply', reqId: msg.reqId, data }));
      } else if (msg.cmd === 'setStorage') {
        Object.assign(store, msg.data || {});
        if (msg.data && msg.data.pja_job_index) {
          try { await idb.clearAll(); await idb.importNormalized({ index: msg.data.pja_job_index, state: msg.data.pja_job_state || {} }); }
          catch (e) { console.error('idb import failed:', e.message); }
        }
      }
    });
  });
}

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

function checkGate(label, index, state, applied) {
  const ids = Object.keys(index);
  const mods = new Set(ids.map(id => index[id].modality));
  const allScored = ids.every(id => state[id] && state[id].fitScore != null);
  const counts = {};
  for (const id of ids) { const c = (index[id].company || '?').toLowerCase().trim(); counts[c] = (counts[c] || 0) + 1; }
  let max = 0, maxCo = ''; for (const c in counts) if (counts[c] > max) { max = counts[c]; maxCo = c; }
  const share = ids.length ? max / ids.length : 0;
  const appliedRk = new Set((applied || []).map(a => roleKey(a)));
  const dupes = ids.filter(id => appliedRk.has(index[id].roleKey));
  const checks = {
    atLeast200: ids.length >= 200, twoModalities: mods.size >= 2, allScored,
    concentrationOk: share <= 0.25, noAppliedDupes: dupes.length === 0,
  };
  checks.PASS = Object.values(checks).every(Boolean);
  console.log('\n=== ' + label + ' ===');
  console.log('  unique ids        :', ids.length, checks.atLeast200 ? '✅ (>=200)' : '❌');
  console.log('  modalities        :', [...mods].join(', '), checks.twoModalities ? '✅' : '❌');
  console.log('  all fit-scored    :', checks.allScored ? '✅' : '❌');
  console.log('  max company share :', (share * 100).toFixed(1) + '%', checks.concentrationOk ? '✅' : '❌', '—', maxCo + ' (' + max + ')');
  console.log('  applied dupes     :', dupes.length, checks.noAppliedDupes ? '✅ (0)' : '❌');
  console.log('  GATE              :', checks.PASS ? '✅ PASS' : '❌ FAIL');
  return checks;
}

(async () => {
  const ws = await connectClient();
  await new Promise(r => setTimeout(r, 300));
  const health = await (await fetch(BASE + '/health')).json();
  console.log('health:', JSON.stringify(health), health.clients >= 1 ? '✅ client connected' : '❌ no client');

  console.log('\n[pass 1] POST /source-v2 ...');
  const r1 = await post('/source-v2', {});
  console.log('  /source-v2 gate ->', JSON.stringify(r1.report.gate));
  const got1 = (await post('/get-storage', { keys: ['pja_job_index', 'pja_job_state'] })).data || {};
  const idx1 = got1.pja_job_index || {}, st1 = got1.pja_job_state || {};
  const c1 = checkGate('LIVE VERIFY (pass 1)', idx1, st1, []);
  const idbCount = await idb.count();
  console.log('\n  IndexedDB corpus count:', idbCount, idbCount >= 200 ? '✅ (corpus persisted to IDB)' : '❌');

  const topId = Object.keys(idx1).sort((a, b) => (st1[b].fitScore || 0) - (st1[a].fitScore || 0))[0];
  const topRole = { company: idx1[topId].company, title: idx1[topId].title };
  appliedSeed = [topRole];
  console.log('\n[pass 2] seeded pja_applied_log =', JSON.stringify(topRole), '-> POST /source-v2 ...');
  await post('/source-v2', {});
  const got2 = (await post('/get-storage', { keys: ['pja_job_index', 'pja_job_state'] })).data || {};
  const idx2 = got2.pja_job_index || {}, st2 = got2.pja_job_state || {};
  const c2 = checkGate('LIVE VERIFY (pass 2, applied excluded)', idx2, st2, appliedSeed);
  const excludedRk = roleKey(topRole);
  const stillPresent = Object.keys(idx2).some(id => idx2[id].roleKey === excludedRk);
  console.log('  applied role excluded from index:', !stillPresent ? '✅ (removed)' : '❌');

  const overall = c1.PASS && c2.PASS && !stillPresent && idbCount >= 200;
  console.log('\n================  OVERALL: ' + (overall ? '✅ GATE SATISFIED (live)' : '❌ FAIL') + '  ================');
  ws.close();
  process.exit(overall ? 0 : 1);
})().catch(e => { console.error('verify failed:', e); process.exit(1); });
