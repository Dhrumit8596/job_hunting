// Runs in MAIN world (declared in manifest.json with "world": "MAIN").
// Receives pja:fiberfill CustomEvents from the isolated-world content script,
// traverses the React fiber tree, and calls Formik's onChange directly.
(function () {
  'use strict';

  // Guard against duplicate injection — executeScript may be called multiple times
  if (document.documentElement.getAttribute('data-pja-fiber-main') === 'loaded') return;
  document.documentElement.setAttribute('data-pja-fiber-main', 'loaded');

  document.addEventListener('pja:fiberfill', function (evt) {
    var detail = evt.detail;
    if (!detail || !detail.uid) return;
    var uid = detail.uid;
    var value = String(detail.value !== undefined ? detail.value : '');

    var el = document.querySelector('[data-pja-fiber-id="' + uid + '"]');
    if (!el) return;
    el.removeAttribute('data-pja-fiber-id');

    // Find the React fiber key on the element
    var fk = null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternalInstance') === 0) {
        fk = keys[i];
        break;
      }
    }
    if (!fk) return;

    // Walk the fiber tree looking for Formik's onChange (has .name prop)
    var f = el[fk];
    var depth = 0;
    var named = null;
    var first = null;
    while (f && depth < 14) {
      var mp = f.memoizedProps;
      if (mp && typeof mp.onChange === 'function') {
        if (!first) first = mp;
        if (mp.name && !named) {
          named = mp;
          break;
        }
      }
      f = f.return;
      depth++;
    }

    var target = named || first;
    if (!target) return;

    var fieldName = target.name || el.name || el.id || '';

    // Set DOM value via prototype setter so React controlled-input reconciliation fires
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }

    // Invoke Formik's synthetic onChange
    target.onChange({
      target: { name: fieldName, value: value, type: el.type || 'text', id: el.id || '' },
      currentTarget: el,
      preventDefault: function () {},
      stopPropagation: function () {}
    });

    // Signal success back to isolated world via DOM attribute
    el.setAttribute('data-pja-fiber-done', 'ok');
  });

  // ── react-select onChange bridge ──────────────────────────────────────────
  // Handles Greenhouse react-select comboboxes (<input role="combobox">).
  // Strategy: walk the fiber tree to find the FORM-LEVEL component (which has
  // mp.name set, indicating a Formik field wrapper) and call its onChange(opt).
  // Greenhouse wraps react-select in a custom component that calls
  // setFieldValue(name, option.value) when invoked with a single argument.
  // Do NOT call the inner react-select Input's onChange — it throws.
  document.addEventListener('pja:reactselect', function (evt) {
    var detail = evt.detail;
    if (!detail || !detail.uid) return;
    var uid = detail.uid;
    var optionLabel = detail.optionLabel;
    var optionValue = detail.optionValue;

    var el = document.querySelector('[data-pja-fiber-id="' + uid + '"]');
    if (!el) return;
    el.removeAttribute('data-pja-fiber-id');

    // Find the React fiber key
    var fk = null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternalInstance') === 0) {
        fk = keys[i];
        break;
      }
    }
    if (!fk) return;

    var lv = String(optionLabel).toLowerCase().trim();
    var key = String(detail.key || '');
    function lbl(o) { return String(o.label !== undefined ? o.label : (o.value !== undefined ? o.value : '')).toLowerCase().trim(); }
    function pickOpt(opts) {
      // 1. exact label / value
      var o = opts.find(function(o) { return lbl(o) === lv; });
      if (o) return o;
      if (!o) o = opts.find(function(o) { return String(o.value !== undefined ? o.value : '').toLowerCase() === String(optionValue).toLowerCase() && String(optionValue) !== ''; });
      if (o) return o;
      // 2. Yes / No (incl. verbose prose like "No. My background is…")
      var lead = lv.match(/^(yes|no)\b/);
      if (lead) { o = opts.find(function(o){ return new RegExp('^'+lead[1]+'\\b').test(lbl(o)); }); if (o) return o; }
      // 3. honest-policy keys
      if (key === 'requireSponsorship' && /^no\b/.test(lv)) { o = opts.find(function(o){ return /not required|will not require|^no\b/.test(lbl(o)); }); if (o) return o; }
      if (key === 'workAuth' && /^yes\b/.test(lv)) { o = opts.find(function(o){ return /authorized/.test(lbl(o)) && !/not authorized/.test(lbl(o)); }); if (o) return o; }
      // 4. self-ID decline (banked "I decline to self-identify" ↔ option "Decline To Self Identify")
      if (/decline|prefer not|wish not|not to answer|do not wish|don'?t wish|rather not/.test(lv)) {
        o = opts.find(function(o){ return /decline|prefer not|wish not|not to answer|do not wish|don'?t wish|rather not/.test(lbl(o)); }); if (o) return o;
      }
      // 5. Affirmative / negative PROSE → binary yes/no option. The AI answerer may reply to a
      // Yes/No question with a full sentence ("I have supported manufacturing operations…" = yes;
      // "I do not currently require…" = no) instead of the bare token. Only map when the option
      // set is BINARY yes/no-like AND the leading sentiment is UNAMBIGUOUS — otherwise fall through
      // and leave unmatched (skipping is safer than committing a guessed answer). This normalizes
      // ANSWER FORMAT, not truth: the sentence already states the honest answer.
      var yesOpt = opts.find(function(o){ return /^yes\b/.test(lbl(o)); });
      var noOpt  = opts.find(function(o){ return /^no\b/.test(lbl(o)); });
      if ((yesOpt || noOpt) && opts.length <= 3) {
        if (/^(no\b|not\b|never\b|none\b|i (do not|don'?t|have not|haven'?t|am not|'?m not|was not|wasn'?t|cannot|can'?t|did not|didn'?t))/.test(lv)) { if (noOpt) return noOpt; }
        else if (/^(yes\b|absolutely\b|correct\b|affirmative\b|i've\b|i (have|am|'?m|do|can|could|would|will|was|did|'?ve)\b)/.test(lv)) { if (yesOpt) return yesOpt; }
      }
      // 6. leading-token / substring
      o = opts.find(function(o) { return lbl(o).indexOf(lv) === 0; });
      if (!o && lv.length > 2) o = opts.find(function(o) { return lbl(o).indexOf(lv) !== -1; });
      return o;
    }

    // Find candidates. The KEY one is the actual react-select <Select> component (identified by
    // classNamePrefix / getOptionValue / components in its props) — calling ITS onChange with the
    // react-select actionMeta drives react-select's own state -> Formik setFieldValue -> the
    // displayed value COMMITS. Calling the outer Formik-field wrapper's onChange(opt) does NOT
    // update the display (verified live: form-level fires but .select__single-value stays empty;
    // inner react-select node commits -> display shows the value). Prefer react-select > named > inner.
    var reactSelectCandidate = null;
    var namedCandidate = null;
    var innerCandidate = null;
    var f = el[fk];
    var depth = 0;
    while (f && depth < 50) {
      var mp = f.memoizedProps;
      if (mp && Array.isArray(mp.options) && mp.options.length && typeof mp.onChange === 'function') {
        var opt = pickOpt(mp.options);
        if (opt) {
          var isReactSelect = (mp.classNamePrefix !== undefined) || (typeof mp.getOptionValue === 'function') || (mp.components !== undefined);
          if (isReactSelect && !reactSelectCandidate) reactSelectCandidate = { mp: mp, opt: opt, rs: true };
          if (mp.name && !namedCandidate) namedCandidate = { mp: mp, opt: opt };
          if (!innerCandidate && depth >= 3) innerCandidate = { mp: mp, opt: opt };
        }
      }
      f = f.return;
      depth++;
    }

    var chosen = reactSelectCandidate || namedCandidate || innerCandidate;
    if (!chosen) return;

    try {
      if (chosen.rs) {
        // react-select onChange signature: (newValue, actionMeta) — drives its state + Formik.
        chosen.mp.onChange(chosen.opt, { action: 'select-option', option: chosen.opt, name: chosen.mp.name });
      } else {
        chosen.mp.onChange(chosen.opt);
      }
      el.setAttribute('data-pja-fiber-done', 'ok');
    } catch(e) {
      try {
        chosen.mp.onChange(chosen.opt, { action: 'select-option', option: chosen.opt });
        el.setAttribute('data-pja-fiber-done', 'ok');
      } catch(e2) {}
    }
  });

  // ── Resume file injection bridge ──────────────────────────────────────────
  // Greenhouse creates <input type=file> dynamically when "Attach" is clicked.
  // We override HTMLInputElement.prototype.click in MAIN world to intercept it
  // before the OS file dialog opens, inject our File object, and fire change.
  document.addEventListener('pja:injectresume', function(evt) {
    var detail = evt.detail;
    if (!detail || !detail.b64) return;
    var fname = detail.filename || 'resume.pdf';
    var orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
      if (this.type === 'file' && !this.__pja_injected) {
        this.__pja_injected = true;
        HTMLInputElement.prototype.click = orig;
        try {
          var parts = detail.b64.split(',');
          var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'application/pdf';
          var binary = atob(parts[1]);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          var file = new File([bytes], fname, { type: mime });
          var dt = new DataTransfer();
          dt.items.add(file);
          // Try direct assignment first (preferred); fall back to defineProperty
          try { this.files = dt.files; } catch(_) {}
          if (!this.files || !this.files.length) {
            Object.defineProperty(this, 'files', { value: dt.files, configurable: true });
          }
          var self = this;
          setTimeout(function() {
            self.dispatchEvent(new Event('change', { bubbles: true }));
            self.dispatchEvent(new Event('input', { bubbles: true }));
            document.documentElement.setAttribute('data-pja-resume-injected', 'ok');
          }, 50);
        } catch(e) {
          document.documentElement.setAttribute('data-pja-resume-injected', 'err:' + e.message);
        }
        return; // Don't open OS dialog
      }
      orig.call(this);
    };
  });
})();
