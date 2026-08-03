/**
 * forms.js — embeddable smart-form runtime.
 *
 * One runtime for both surfaces:
 *  - third-party embeds: <script async src=".../public/forms.js"
 *      data-org-id="mfi_..." data-form="slug" data-target="#mount"></script>
 *  - hosted MogulForge pages (/public/form-page/:slug?key=...), which load
 *    this same script.
 *
 * Renders into a shadow root (style isolation), fetches the published form
 * definition, walks visible steps (branching), uploads photos through the
 * public upload endpoint, and submits with attribution (utm/referrer/landing
 * page). No template-literal interpolation inside the emitted JS — string
 * concatenation only. All user-provided text is rendered via textContent.
 */

export const FORMS_JS_VERSION = "3";

export const FORMS_JS = `(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var KEY = script.getAttribute("data-org-id") || "";
  var SLUG = script.getAttribute("data-form") || "";
  if (!KEY || !SLUG) return;
  var API = "";
  try {
    var src = new URL(script.src);
    API = src.origin + src.pathname.replace(/\\/public\\/forms\\.js.*$/, "");
  } catch (e) { return; }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["x-installation-key"] = KEY;
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(API + path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function attribution() {
    var out = {};
    try {
      out.landingPage = String(location.href).slice(0, 500);
      if (document.referrer) out.referrer = String(document.referrer).slice(0, 500);
      var q = new URLSearchParams(location.search);
      var map = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_term: "utmTerm", utm_content: "utmContent" };
      Object.keys(map).forEach(function (k) {
        var v = q.get(k);
        if (v) out[map[k]] = v.slice(0, 500);
      });
    } catch (e) {}
    return out;
  }

  // First-party visitor id (per browser) + session id (per tab session);
  // shared with closer.js so form fills link to the same visitor history.
  function storedId(storage, k) {
    try {
      var id = storage.getItem(k);
      if (!id) {
        id = "mf-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        storage.setItem(k, id);
      }
      return id;
    } catch (e) { return null; }
  }
  var anonId = storedId(window.localStorage, "mf_anon_id");
  var sessionId = storedId(window.sessionStorage, "mf_session_id");

  // Report approved first-party events through the key-scoped analytics
  // endpoint so form-only installs feed visitor intelligence too.
  function track(eventName, properties) {
    try {
      api("/public/analytics-events", {
        method: "POST",
        body: JSON.stringify({
          eventName: eventName,
          anonymousId: anonId || undefined,
          sessionId: sessionId || undefined,
          path: location.pathname,
          referrer: (document.referrer || "").slice(0, 500),
          properties: properties || {}
        })
      }).catch(function () {});
    } catch (e) {}
  }

  var CSS = ".mff{all:initial;display:block;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;max-width:560px;box-sizing:border-box}" +
    ".mff *{box-sizing:border-box;font-family:inherit}" +
    ".mff-progress{height:6px;background:#f3f4f6;border-radius:999px;overflow:hidden;margin-bottom:20px}" +
    ".mff-bar{height:100%;background:#f97316;transition:width .25s}" +
    ".mff-title{font-size:20px;font-weight:700;margin:0 0 4px}" +
    ".mff-desc{font-size:14px;color:#6b7280;margin:0 0 16px}" +
    ".mff-field{margin-bottom:14px}" +
    ".mff-label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}" +
    ".mff-req{color:#dc2626}" +
    ".mff-help{font-size:12px;color:#6b7280;margin-top:4px}" +
    ".mff-input,.mff-select,.mff-textarea{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:15px;background:#fff;color:#111827}" +
    ".mff-textarea{min-height:96px;resize:vertical}" +
    ".mff-check{display:flex;align-items:flex-start;gap:8px;font-size:14px;cursor:pointer}" +
    ".mff-check input{margin-top:3px}" +
    ".mff-error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px;border-radius:10px;padding:10px 12px;margin-bottom:12px;display:none}" +
    ".mff-nav{display:flex;justify-content:space-between;gap:12px;margin-top:18px}" +
    ".mff-btn{border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer;background:#f97316;color:#fff}" +
    ".mff-btn[disabled]{opacity:.6;cursor:default}" +
    ".mff-btn-ghost{background:transparent;color:#6b7280}" +
    ".mff-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}" +
    ".mff-photo{width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid #e5e7eb}" +
    ".mff-done{text-align:center;padding:24px 8px}" +
    ".mff-done h3{font-size:20px;margin:0 0 8px}" +
    ".mff-done p{font-size:15px;color:#374151;margin:0}" +
    ".mff-powered{margin-top:14px;text-align:center;font-size:11px;color:#9ca3af}";

  function mountPoint() {
    var sel = script.getAttribute("data-target");
    if (sel) {
      var t = document.querySelector(sel);
      if (t) return t;
    }
    var holder = document.createElement("div");
    if (script.parentNode) script.parentNode.insertBefore(holder, script.nextSibling);
    else document.body.appendChild(holder);
    return holder;
  }

  function init(form) {
    var host = mountPoint();
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    var box = el("div", "mff");
    root.appendChild(box);

    var answers = {};
    var uploads = {}; // fieldKey -> [{path,url}]
    var uploading = 0;
    var stepIdx = 0;

    function matches(cond) {
      var v = answers[cond.fieldKey];
      var has = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
      if (cond.op === "answered") return has;
      if (cond.op === "eq") return has && String(v) === String(cond.value);
      if (cond.op === "ne") return !has || String(v) !== String(cond.value);
      if (cond.op === "gte") return has && Number(v) >= Number(cond.value);
      if (cond.op === "lte") return has && Number(v) <= Number(cond.value);
      if (cond.op === "in") {
        if (!has || !Array.isArray(cond.value)) return false;
        var vals = cond.value.map(String);
        if (Array.isArray(v)) return v.some(function (x) { return vals.indexOf(String(x)) >= 0; });
        return vals.indexOf(String(v)) >= 0;
      }
      return false;
    }

    function visible() {
      return form.steps.filter(function (s) { return !s.showIf || matches(s.showIf); });
    }

    // hidden fields prefill from query params of the host page
    try {
      var q = new URLSearchParams(location.search);
      form.steps.forEach(function (s) {
        s.fields.forEach(function (f) {
          if (f.type === "hidden") {
            var v = q.get(f.key);
            if (v) answers[f.key] = v.slice(0, 500);
          }
        });
      });
    } catch (e) {}

    function showError(msg) {
      var e = box.querySelector(".mff-error");
      if (e) { e.textContent = msg; e.style.display = msg ? "block" : "none"; }
    }

    function renderField(f) {
      if (f.type === "hidden") return null;
      var wrap = el("div", "mff-field");
      wrap.setAttribute("data-field", f.key);
      var label = el("label", "mff-label", f.label);
      if (f.required) label.appendChild(el("span", "mff-req", " *"));
      wrap.appendChild(label);
      var set = function (v) { answers[f.key] = v; };
      var input;
      if (f.type === "textarea") {
        input = el("textarea", "mff-textarea");
        input.value = answers[f.key] || "";
        input.addEventListener("input", function () { set(input.value); });
      } else if (f.type === "select") {
        input = el("select", "mff-select");
        var ph = el("option", null, "Choose\\u2026");
        ph.value = "";
        input.appendChild(ph);
        (f.options || []).forEach(function (o) {
          var opt = el("option", null, o.label);
          opt.value = o.value;
          input.appendChild(opt);
        });
        input.value = answers[f.key] || "";
        input.addEventListener("change", function () { set(input.value); });
      } else if (f.type === "multiselect") {
        input = el("div");
        (f.options || []).forEach(function (o) {
          var lab = el("label", "mff-check");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = o.value;
          cb.checked = (answers[f.key] || []).indexOf(o.value) >= 0;
          cb.addEventListener("change", function () {
            var cur = answers[f.key] || [];
            if (cb.checked) cur = cur.concat([o.value]);
            else cur = cur.filter(function (x) { return x !== o.value; });
            set(cur);
          });
          lab.appendChild(cb);
          lab.appendChild(el("span", null, o.label));
          input.appendChild(lab);
        });
      } else if (f.type === "checkbox" || f.type === "consent") {
        wrap.removeChild(label);
        var lab2 = el("label", "mff-check");
        var cb2 = document.createElement("input");
        cb2.type = "checkbox";
        cb2.checked = answers[f.key] === true;
        cb2.addEventListener("change", function () { set(cb2.checked); });
        lab2.appendChild(cb2);
        var span = el("span", null, f.label + (f.required ? " *" : ""));
        lab2.appendChild(span);
        wrap.appendChild(lab2);
        input = null;
      } else if (f.type === "photos") {
        input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "image/jpeg,image/png,image/webp,image/heic,image/heif";
        input.className = "mff-input";
        var grid = el("div", "mff-photos");
        input.addEventListener("change", function () {
          var files = Array.prototype.slice.call(input.files || []);
          input.value = "";
          files.forEach(function (file) {
            if (file.size > 10 * 1024 * 1024) { showError(file.name + " is larger than 10MB."); return; }
            var list = uploads[f.key] || (uploads[f.key] = []);
            if (list.length >= 10) { showError("Up to 10 photos."); return; }
            uploading++;
            api("/public/uploads/request-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }) })
              .then(function (r) {
                return fetch(r.uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then(function (put) {
                  if (!put.ok) throw new Error("Upload failed");
                  list.push(r.objectPath);
                  answers[f.key] = list.slice();
                  var img = el("img", "mff-photo");
                  img.alt = file.name;
                  img.src = URL.createObjectURL(file);
                  grid.appendChild(img);
                });
              })
              .catch(function (err) { showError(err && err.message ? err.message : "Upload failed"); })
              .then(function () { uploading--; });
          });
        });
        wrap.appendChild(input);
        wrap.appendChild(grid);
        if (f.helpText) wrap.appendChild(el("div", "mff-help", f.helpText));
        return wrap;
      } else {
        input = document.createElement("input");
        input.className = "mff-input";
        input.type = f.type === "email" ? "email" : f.type === "phone" ? "tel" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
        if (f.placeholder) input.placeholder = f.placeholder;
        input.value = answers[f.key] != null ? answers[f.key] : "";
        input.addEventListener("input", function () { set(f.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value); });
      }
      if (input) wrap.appendChild(input);
      if (f.helpText) wrap.appendChild(el("div", "mff-help", f.helpText));
      return wrap;
    }

    function validateStep(step) {
      for (var i = 0; i < step.fields.length; i++) {
        var f = step.fields[i];
        if (!f.required) continue;
        var v = answers[f.key];
        var has = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
        if ((f.type === "checkbox" || f.type === "consent") && v !== true) return f.label + " must be accepted.";
        if (!has && f.type !== "checkbox" && f.type !== "consent") return f.label + " is required.";
      }
      return null;
    }

    function submit(btn) {
      if (uploading > 0) { showError("Photos are still uploading\\u2026"); return; }
      btn.disabled = true;
      api("/public/forms/" + encodeURIComponent(SLUG) + "/submissions", {
        method: "POST",
        body: JSON.stringify({ answers: answers, attribution: attribution(), anonymousId: anonId || undefined, sessionId: sessionId || undefined })
      }).then(function (r) {
        box.textContent = "";
        var done = el("div", "mff-done");
        done.appendChild(el("h3", null, "You're all set"));
        done.appendChild(el("p", null, r.guidance || "Thanks \\u2014 your request is in."));
        box.appendChild(done);
      }).catch(function (err) {
        btn.disabled = false;
        showError(err && err.message ? err.message : "Something went wrong. Please try again.");
      });
    }

    function render() {
      var steps = visible();
      if (stepIdx >= steps.length) stepIdx = steps.length - 1;
      var step = steps[stepIdx];
      box.textContent = "";
      var progress = el("div", "mff-progress");
      var bar = el("div", "mff-bar");
      bar.style.width = String(Math.round(((stepIdx + 1) / steps.length) * 100)) + "%";
      progress.appendChild(bar);
      box.appendChild(progress);
      box.appendChild(el("h2", "mff-title", step.title));
      if (step.description) box.appendChild(el("p", "mff-desc", step.description));
      var err = el("div", "mff-error");
      box.appendChild(err);
      step.fields.forEach(function (f) {
        var node = renderField(f);
        if (node) box.appendChild(node);
      });
      var nav = el("div", "mff-nav");
      var back = el("button", "mff-btn mff-btn-ghost", "Back");
      back.type = "button";
      back.style.visibility = stepIdx === 0 ? "hidden" : "visible";
      back.addEventListener("click", function () { stepIdx = Math.max(0, stepIdx - 1); render(); });
      var last = stepIdx === steps.length - 1;
      var next = el("button", "mff-btn", last ? ((form.settings && form.settings.submitLabel) || "Submit") : "Next");
      next.type = "button";
      next.addEventListener("click", function () {
        var msg = validateStep(step);
        if (msg) { showError(msg); return; }
        showError("");
        if (last) submit(next);
        else {
          var vs = visible();
          stepIdx = Math.min(vs.length - 1, stepIdx + 1);
          render();
        }
      });
      nav.appendChild(back);
      nav.appendChild(next);
      box.appendChild(nav);
      box.appendChild(el("div", "mff-powered", "Powered by MogulForge"));
    }

    render();
  }

  api("/public/forms/" + encodeURIComponent(SLUG))
    .then(function (form) {
      // Successful config fetch = live install; record the page view so
      // form-only sites feed visitor intelligence before conversion.
      track("page_view");
      init(form);
    })
    .catch(function () { /* form unpublished or key invalid: render nothing */ });
})();
`;
