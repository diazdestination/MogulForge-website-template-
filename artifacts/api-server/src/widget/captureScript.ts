/**
 * capture.js — opt-in form listener for a client's EXISTING website forms.
 *
 * Embed:
 *   <script async src="https://.../api/v1/public/capture.js"
 *           data-capture-token="cap_..."
 *           data-form-selector="#contact-form, .quote-form"></script>
 *
 * It observes submissions of forms matching the selector and mirrors a copy
 * of the form data to the org's capture endpoint. It NEVER calls
 * preventDefault, never throws into the host page, and uses
 * sendBeacon/keepalive so the mirror survives navigation — if MogulForge
 * capture fails for any reason, the client's original form still works.
 */

export const CAPTURE_JS_VERSION = 1;

export const CAPTURE_JS = `(function () {
  'use strict';
  try {
    var script = document.currentScript;
    if (!script) {
      var scripts = document.querySelectorAll('script[data-capture-token]');
      script = scripts[scripts.length - 1];
    }
    if (!script) return;
    var token = script.getAttribute('data-capture-token');
    var selector = script.getAttribute('data-form-selector') || 'form';
    if (!token) return;
    var src = script.getAttribute('src') || '';
    var base = src.replace(/\\/public\\/capture\\.js.*$/, '');
    if (!/^https?:/.test(base)) {
      base = (src.charAt(0) === '/' ? window.location.origin : '') + base;
    }
    var url = base + '/public/capture/' + encodeURIComponent(token);

    function serialize(form) {
      var out = {};
      try {
        var fd = new FormData(form);
        fd.forEach(function (value, key) {
          if (typeof value !== 'string') return; // skip files
          if (/password|card|cvv|cvc|ssn/i.test(key)) return;
          if (out[key] === undefined) out[key] = value.slice(0, 2000);
        });
      } catch (e) { /* never break the host form */ }
      return out;
    }

    function mirror(form) {
      try {
        var payload = serialize(form);
        if (Object.keys(payload).length === 0) return;
        payload._idempotencyKey =
          'cjs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        var body = JSON.stringify(payload);
        var sent = false;
        if (navigator.sendBeacon) {
          try {
            sent = navigator.sendBeacon(
              url, new Blob([body], { type: 'application/json' }));
          } catch (e) { sent = false; }
        }
        if (!sent && window.fetch) {
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: body,
            keepalive: true,
            mode: 'cors'
          }).catch(function () { /* swallow: host form must not notice */ });
        }
      } catch (e) { /* swallow: host form must not notice */ }
    }

    // Capture phase, passive observation only — the event is never
    // cancelled or stopped, so the site's own handlers and native submit
    // proceed exactly as before.
    document.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        if (!form || form.nodeName !== 'FORM') return;
        if (!form.matches(selector)) return;
        mirror(form);
      } catch (e) { /* swallow */ }
    }, true);
  } catch (e) { /* never throw into the host page */ }
})();
`;
