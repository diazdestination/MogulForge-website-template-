/**
 * Source of the embeddable `closer.js` loader served at
 * GET /v1/public/closer.js.
 *
 * Kept as a plain string so the API bundle needs no extra build target or
 * static-file copy step. The script itself is dependency-free vanilla JS:
 *  - reads its installation key from the <script data-org-id> attribute
 *  - initializes once per page, fails silently on any error
 *  - fetches the org's public widget config (key + Origin enforced serverside)
 *  - renders a lead-capture launcher + form inside a Shadow DOM so host-page
 *    styles never bleed in (and ours never bleed out)
 *  - posts leads with UTM/referrer/landing-page attribution
 *
 * NOTE: avoid template literals with ${} inside the script body — it is
 * embedded in a TS template string. Use string concatenation instead.
 */

/** Bump when the script changes; used for the ETag/version query. */
export const CLOSER_JS_VERSION = "4";

export const CLOSER_JS: string = `(function () {
  "use strict";
  if (window.__mfCloser) return;
  window.__mfCloser = true;
  try {
    var script = document.currentScript;
    if (!script) {
      var candidates = document.querySelectorAll("script[data-org-id]");
      for (var i = 0; i < candidates.length; i++) {
        if ((candidates[i].src || "").indexOf("closer.js") !== -1) { script = candidates[i]; break; }
      }
    }
    if (!script) return;
    var key = script.getAttribute("data-org-id");
    var src = script.src || "";
    if (!key || !src) return;
    // .../v1/public/closer.js -> .../v1
    var apiBase = src.split("?")[0].replace(/\\/public\\/closer\\.js$/, "");
    if (apiBase === src) return;

    function api(path, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      opts.headers["x-installation-key"] = key;
      return fetch(apiBase + path, opts);
    }

    function attribution() {
      var out = { landingPage: location.href.slice(0, 500), referrer: (document.referrer || "").slice(0, 500) };
      try {
        var params = new URLSearchParams(location.search);
        var map = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_term: "utmTerm", utm_content: "utmContent" };
        for (var k in map) { var v = params.get(k); if (v) out[map[k]] = v.slice(0, 200); }
      } catch (e) {}
      return out;
    }

    // First-party visitor id (per browser) + session id (per tab session).
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
    // endpoint so third-party installs feed visitor intelligence too.
    function track(eventName, properties) {
      try {
        api("/public/analytics-events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

    // ---- AI concierge chat module -------------------------------------
    function renderChat(config) {
      var ap = config.appearance || {};
      var cz = config.concierge || {};
      var color = ap.primaryColor || "#0f766e";
      var side = ap.position === "left" ? "left" : "right";
      var buttonLabel = ap.buttonLabel || "Chat with us";
      var title = cz.assistantName || "Assistant";
      var greeting = cz.greeting || "Hi! How can I help today?";

      var host = document.createElement("div");
      host.style.cssText = "position:fixed;bottom:0;" + side + ":0;z-index:2147483000;";
      var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML =
        '<style>' +
        ':host{all:initial}' +
        '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
        '.mf-launch{margin:16px;padding:12px 18px;border:0;border-radius:999px;background:' + color + ';color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
        '.mf-launch:focus-visible{outline:3px solid #111;outline-offset:2px}' +
        '.mf-panel{display:none;width:360px;max-width:calc(100vw - 24px);margin:0 12px 12px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden}' +
        '.mf-panel.open{display:flex;flex-direction:column;height:480px;max-height:calc(100vh - 90px)}' +
        '.mf-head{background:' + color + ';color:#fff;padding:12px 16px;flex:none}' +
        '.mf-head h2{margin:0;font-size:15px}' +
        '.mf-close{float:right;background:none;border:0;color:#fff;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}' +
        '.mf-log{flex:1;overflow-y:auto;padding:12px;font-size:14px;color:#111;background:#f8fafc}' +
        '.mf-msg{max-width:85%;margin:0 0 8px;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}' +
        '.mf-msg.bot{background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}' +
        '.mf-msg.me{background:' + color + ';color:#fff;margin-left:auto;border-bottom-right-radius:4px}' +
        '.mf-qr{padding:0 12px 8px;background:#f8fafc;display:flex;flex-wrap:wrap;gap:6px;flex:none}' +
        '.mf-qr button{border:1px solid ' + color + ';color:' + color + ';background:#fff;border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer}' +
        '.mf-bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e2e8f0;flex:none;background:#fff}' +
        '.mf-bar input{flex:1;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;color:#111}' +
        '.mf-bar input:focus{outline:2px solid ' + color + '}' +
        '.mf-bar button{border:0;border-radius:8px;background:' + color + ';color:#fff;font-size:14px;font-weight:600;padding:8px 14px;cursor:pointer}' +
        '.mf-bar button[disabled]{opacity:.6;cursor:default}' +
        '</style>' +
        '<div class="mf-panel" role="dialog" aria-label="' + title.replace(/"/g, "&quot;") + '">' +
        '<div class="mf-head"><button type="button" class="mf-close" aria-label="Close chat">&times;</button><h2></h2></div>' +
        '<div class="mf-log" role="log" aria-live="polite"></div>' +
        '<div class="mf-qr"></div>' +
        '<div class="mf-bar"><input type="text" aria-label="Type your message" placeholder="Type your message…"><button type="button" class="mf-send">Send</button></div>' +
        '</div>' +
        '<button type="button" class="mf-launch"></button>';

      root.querySelector(".mf-head h2").textContent = title;
      var launch = root.querySelector(".mf-launch");
      launch.textContent = buttonLabel;
      var panel = root.querySelector(".mf-panel");
      var log = root.querySelector(".mf-log");
      var qrBox = root.querySelector(".mf-qr");
      var input = root.querySelector(".mf-bar input");
      var send = root.querySelector(".mf-send");
      launch.setAttribute("aria-expanded", "false");

      var STORE = "mfCloserChat:" + key;
      var session = null;
      try { session = JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch (e) {}
      if (!session || !session.id) session = null;

      function save() {
        try { sessionStorage.setItem(STORE, JSON.stringify(session)); } catch (e) {}
      }
      function addMsg(role, text) {
        var el = document.createElement("div");
        el.className = "mf-msg " + (role === "me" ? "me" : "bot");
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
      }
      function setQuick(replies) {
        qrBox.innerHTML = "";
        (replies || []).forEach(function (r) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = r;
          b.addEventListener("click", function () { submit(r); });
          qrBox.appendChild(b);
        });
      }
      function applyReply(data, remember) {
        (data.messages || []).forEach(function (m) {
          addMsg("bot", m);
          if (remember) session.msgs.push({ r: "bot", c: m });
        });
        setQuick(data.quickReplies || []);
        if (remember) { session.qr = data.quickReplies || []; save(); }
      }
      function start() {
        api("/public/concierge/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "closer-widget", attribution: attribution(), anonymousId: anonId || undefined })
        }).then(function (res) {
          if (!res.ok) throw new Error("failed");
          return res.json();
        }).then(function (data) {
          session = { id: data.conversationId, msgs: [], qr: [] };
          applyReply(data, true);
        }).catch(function () {
          addMsg("bot", "Sorry — I can't connect right now. Please try again in a moment.");
        });
      }
      var sending = false;
      function submit(text) {
        text = (text || "").trim();
        if (!text || sending || !session) return;
        sending = true;
        send.disabled = true;
        addMsg("me", text);
        session.msgs.push({ r: "me", c: text });
        save();
        setQuick([]);
        input.value = "";
        api("/public/concierge/conversations/" + session.id + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text })
        }).then(function (res) {
          if (!res.ok) throw new Error("failed");
          return res.json();
        }).then(function (data) {
          applyReply(data, true);
        }).catch(function () {
          addMsg("bot", "Sorry — that didn't go through. Please try again.");
        }).then(function () {
          sending = false;
          send.disabled = false;
        });
      }

      var started = false;
      function setOpen(open) {
        panel.classList.toggle("open", open);
        launch.setAttribute("aria-expanded", open ? "true" : "false");
        if (open && !started) {
          started = true;
          if (session && session.msgs && session.msgs.length) {
            session.msgs.forEach(function (m) { addMsg(m.r, m.c); });
            setQuick(session.qr || []);
          } else {
            session = null;
            start();
          }
        }
        if (open) input.focus();
      }
      launch.addEventListener("click", function () { setOpen(!panel.classList.contains("open")); });
      root.querySelector(".mf-close").addEventListener("click", function () { setOpen(false); launch.focus(); });
      panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { setOpen(false); launch.focus(); } });
      send.addEventListener("click", function () { submit(input.value); });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(input.value); });

      document.body.appendChild(host);
    }

    function render(config) {
      if (!config || !config.modules) return;
      // The concierge chat supersedes the plain lead form when both are on.
      if (config.modules.concierge) { renderChat(config); return; }
      if (!config.modules.leadCapture) return;
      var ap = config.appearance || {};
      var color = ap.primaryColor || "#0f766e";
      var side = ap.position === "left" ? "left" : "right";
      var greeting = ap.greeting || "Have a question? Leave your details and we'll get right back to you.";
      var buttonLabel = ap.buttonLabel || "Get in touch";
      var title = config.businessName || "Contact us";

      var host = document.createElement("div");
      host.style.cssText = "position:fixed;bottom:0;" + side + ":0;z-index:2147483000;";
      var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML =
        '<style>' +
        ':host{all:initial}' +
        '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
        '.mf-launch{margin:16px;padding:12px 18px;border:0;border-radius:999px;background:' + color + ';color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
        '.mf-launch:focus-visible{outline:3px solid #111;outline-offset:2px}' +
        '.mf-panel{display:none;width:320px;max-width:calc(100vw - 24px);margin:0 12px 12px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden}' +
        '.mf-panel.open{display:block}' +
        '.mf-head{background:' + color + ';color:#fff;padding:14px 16px}' +
        '.mf-head h2{margin:0;font-size:16px}' +
        '.mf-head p{margin:6px 0 0;font-size:13px;opacity:.92}' +
        '.mf-body{padding:14px 16px}' +
        'label{display:block;font-size:12px;font-weight:600;color:#333;margin:8px 0 3px}' +
        'input,textarea{width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;color:#111;background:#fff}' +
        'input:focus,textarea:focus{outline:2px solid ' + color + '}' +
        '.mf-submit{width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;background:' + color + ';color:#fff;font-size:14px;font-weight:600;cursor:pointer}' +
        '.mf-submit[disabled]{opacity:.6;cursor:default}' +
        '.mf-close{float:right;background:none;border:0;color:#fff;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}' +
        '.mf-err{color:#b91c1c;font-size:12px;margin:8px 0 0;display:none}' +
        '.mf-ok{padding:22px 16px;font-size:14px;color:#111;text-align:center;display:none}' +
        '</style>' +
        '<div class="mf-panel" role="dialog" aria-label="' + title.replace(/"/g, "&quot;") + '">' +
        '<div class="mf-head"><button type="button" class="mf-close" aria-label="Close">&times;</button><h2></h2><p></p></div>' +
        '<form class="mf-body" novalidate>' +
        '<label for="mf-name">Name *</label><input id="mf-name" name="name" autocomplete="name" required>' +
        '<label for="mf-phone">Phone *</label><input id="mf-phone" name="phone" type="tel" autocomplete="tel" required>' +
        '<label for="mf-email">Email</label><input id="mf-email" name="email" type="email" autocomplete="email">' +
        '<label for="mf-msg">How can we help?</label><textarea id="mf-msg" name="message" rows="3"></textarea>' +
        '<p class="mf-err" role="alert"></p>' +
        '<button type="submit" class="mf-submit">Send</button>' +
        '</form>' +
        '<div class="mf-ok" role="status">Thanks! We received your message and will reach out shortly.</div>' +
        '</div>' +
        '<button type="button" class="mf-launch"></button>';

      root.querySelector(".mf-head h2").textContent = title;
      root.querySelector(".mf-head p").textContent = greeting;
      var launch = root.querySelector(".mf-launch");
      launch.textContent = buttonLabel;
      var panel = root.querySelector(".mf-panel");
      launch.setAttribute("aria-expanded", "false");
      function setOpen(open) {
        panel.classList.toggle("open", open);
        launch.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) { var f = root.querySelector("#mf-name"); if (f) f.focus(); }
      }
      launch.addEventListener("click", function () { setOpen(!panel.classList.contains("open")); });
      root.querySelector(".mf-close").addEventListener("click", function () { setOpen(false); launch.focus(); });
      panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { setOpen(false); launch.focus(); } });

      var form = root.querySelector("form");
      var err = root.querySelector(".mf-err");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        err.style.display = "none";
        var name = root.querySelector("#mf-name").value.trim();
        var phone = root.querySelector("#mf-phone").value.trim();
        if (!name || phone.replace(/\\D/g, "").length < 7) {
          err.textContent = "Please enter your name and a valid phone number.";
          err.style.display = "block";
          return;
        }
        var parts = name.split(/\\s+/);
        var btn = root.querySelector(".mf-submit");
        btn.disabled = true;
        api("/public/widget-leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: parts[0],
            lastName: parts.slice(1).join(" ") || undefined,
            phone: phone,
            email: root.querySelector("#mf-email").value.trim() || undefined,
            message: root.querySelector("#mf-msg").value.trim() || undefined,
            attribution: attribution(),
            anonymousId: anonId || undefined
          })
        }).then(function (res) {
          if (!res.ok) throw new Error("failed");
          form.style.display = "none";
          root.querySelector(".mf-ok").style.display = "block";
        }).catch(function () {
          btn.disabled = false;
          err.textContent = "Something went wrong — please try again.";
          err.style.display = "block";
        });
      });

      document.body.appendChild(host);
    }

    // Admin preview flag: with the org in test mode the widget only renders
    // when the page URL carries mf_preview=1 (the server enforces this too).
    var preview = false;
    try { preview = new URLSearchParams(location.search).get("mf_preview") === "1"; } catch (e) {}

    function init() {
      api("/public/widget-config" + (preview ? "?preview=1" : "")).then(function (res) {
        if (!res.ok) return;
        // Successful config fetch = healthy installation; report it so the
        // dashboard can show connection health without crawling the site.
        api("/public/widget-heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: "4", host: location.hostname })
        }).catch(function () {});
        return res.json();
      }).then(function (config) {
        if (config) {
          track("page_view");
          render(config);
        }
      }).catch(function () {});
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  } catch (e) { /* never break the host page */ }
})();
`;
