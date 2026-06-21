'use strict';
// Loads a content script (an IIFE that assigns window.*) into a stubbed environment
// so its exported pja* functions can be unit-tested in Node without a browser.
// All DOM/chrome usage in the scripts is inside function bodies, so minimal stubs
// suffice for load time; tests only call the pure (string-logic) functions.
const fs = require('fs');

function makeStubs() {
  const noop = () => {};
  const window = { addEventListener: () => {}, removeEventListener: () => {} };
  const elStub = () => ({ style: {}, setAttribute: noop, appendChild: noop, click: noop,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, dispatchEvent: noop, focus: noop, blur: noop });
  const document = {
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: elStub, createEvent: () => ({ initEvent: noop }),
    body: { innerText: '', querySelectorAll: () => [] },
    documentElement: {}, head: elStub(),
  };
  const chrome = {
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
    runtime: { sendMessage: noop, onMessage: { addListener: noop }, getURL: (p) => p, id: 'test' },
    tabs: { create: noop, query: noop },
  };
  const location = { hostname: 'localhost', href: 'http://localhost/', pathname: '/', search: '' };
  window.location = location;
  return {
    window, document, chrome, location,
    self: window,
    navigator: { userAgent: 'node' },
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({}),
    MouseEvent: class {}, KeyboardEvent: class {}, InputEvent: class {}, Event: class {},
    CSS: { escape: (s) => s },
  };
}

function loadContentScript(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const stubs = makeStubs();
  const names = Object.keys(stubs);
  const vals = names.map(n => stubs[n]);
  // Run the IIFE with stubs injected as locals; it assigns onto `window`.
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, src + '\n;return window;');
  return fn(...vals);
}

module.exports = { loadContentScript, makeStubs };
