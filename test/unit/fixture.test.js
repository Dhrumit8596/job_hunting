'use strict';
// Offline fixture-fill regression test: loads test/test-apply-form.html into jsdom,
// runs the real pjaFillForm against a SYNTHETIC profile, asserts fields populate.
// Guards DOM-traversal / label-classification / select-fill regressions without a browser.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '../..');

function loadFixture(rel, url) {
  const html = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const window = dom.window;
  window.chrome = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: (p) => p },
  };
  // jsdom does no layout, so getBoundingClientRect is all-zero and pjaFillForm's
  // visibility filter would drop every field. Stub it to a non-zero box.
  window.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  window.eval(fs.readFileSync(path.resolve(ROOT, 'content/autofill.js'), 'utf8'));
  return window;
}

module.exports = (t) => {
  const w = loadFixture('test/test-apply-form.html', 'https://job-boards.greenhouse.io/acme/jobs/1');
  const doc = w.document;
  const profile = {
    firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '555-123-4567',
    city: 'Springfield', state: 'CA', zip: '90001', currentTitle: 'QA Engineer',
    currentCompany: 'Acme Test Co', yearsExperience: '5',
    workAuth: 'Yes', requireSponsorship: 'No', willingToRelocate: 'Yes',
  };
  w.pjaFillForm(profile, {});
  const val = (id) => { const el = doc.getElementById(id); return el ? el.value : '<no-el>'; };

  t.eq(val('first-name'), 'Jane', 'fixture: first name');
  t.eq(val('last-name'), 'Doe', 'fixture: last name');
  t.eq(val('email'), 'jane@example.com', 'fixture: email');
  t.eq(val('phone'), '5551234567', 'fixture: phone digits-only');
  t.eq(val('city'), 'Springfield', 'fixture: city');
  t.eq(val('state'), 'CA', 'fixture: state');
  t.eq(val('zip'), '90001', 'fixture: zip');
  t.eq(val('current-title'), 'QA Engineer', 'fixture: current title');
  t.eq(val('current-company'), 'Acme Test Co', 'fixture: current company');
  t.eq(val('work-auth'), 'yes', 'fixture: work-auth select -> yes');
  t.eq(val('sponsorship'), 'no', 'fixture: sponsorship select -> no');
  t.eq(val('relocate'), 'yes', 'fixture: relocate select -> yes');

  // --- Bug1: required checkbox-group detection + selection ---
  const groups = w.pjaFindRequiredCheckboxGroups(doc);
  t.eq(groups.length, 1, 'checkboxgroup: detects the required group');
  const g = groups[0] || {};
  t.ok(/years of experience/i.test(g.question || ''), 'checkboxgroup: question text');
  t.eq(g.anyChecked, false, 'checkboxgroup: none checked yet');
  t.eq(g.options, ['Less than 1', '1-2', '2-5', '5+'], 'checkboxgroup: options from labels');
  // select the "5+" option (label via label[for], value is a numeric id) — confirm exactly that
  // box is checked and the group is then satisfied.
  w.pjaCheckMatchingBox(g.members, '5+');
  const checked = g.members.filter(m => m.checked);
  t.eq(checked.length, 1, 'checkboxgroup: exactly one option checked');
  t.eq(checked[0].id, 'yq_d', 'checkboxgroup: checks the "5+" option matched via label[for]');
  t.eq(w.pjaFindRequiredCheckboxGroups(doc).length, 0, 'checkboxgroup: satisfied group no longer reported');

  // Multi-select answers retain every truthful match instead of clearing siblings.
  const multi = doc.createElement('div');
  multi.innerHTML = '<label><input type="checkbox" name="skills[]_a" value="SPC"></label>' +
    '<label><input type="checkbox" name="skills[]_b" value="GMP"></label>';
  doc.body.appendChild(multi);
  const multiMembers = Array.from(multi.querySelectorAll('input'));
  t.eq(w.pjaCheckMatchingBoxes(multiMembers, 'SPC, GMP'), 2, 'checkboxgroup: multi-select matches both options');
  t.eq(multiMembers.filter(m => m.checked).length, 2, 'checkboxgroup: multi-select preserves both checks');
};
