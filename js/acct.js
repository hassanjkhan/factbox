/* ==========================================================================
   Factbox — the account control.   Exposes: window.FBA

   One insignia in the top right of every page. Signed out it opens on "Sign
   in" and "Create account"; signed in it opens on the reader's name, their
   library and a way out. It replaced a pair of text links that said "Sign in"
   and "Sign up" side by side in the header of nine pages — from the reader's
   side that is one errand printed twice, and it was the only thing in the
   header that was not about reading.

   This file is the whole control: markup, state and behaviour. Every page used
   to carry its own copy of the state half as an inline script, nine copies of
   the same forty lines, which is nine places for them to drift apart.

   ES5 only. Every lookup guarded. If auth never loads, the menu still opens
   and still offers to sign in — which is the correct signed-out state anyway.
   ========================================================================== */

var FBA = (function () {
  "use strict";

  var ICON = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" ' +
    'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="8.6" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(href, label, cls) {
    var a = el("a", cls || null, label);
    a.href = href;
    a.setAttribute("role", "menuitem");
    return a;
  }
  function reveal() {
    try {
      var h = document.documentElement;
      if (h) h.className = h.className.replace(/(^|\s)fb-hdr(\s|$)/g, " ")
                                      .replace(/^\s+|\s+$/g, "");
    } catch (e) {}
  }

  /* A display name is text the reader typed, going straight into the header,
     so it is trimmed, capped and scrubbed before it reaches the DOM. Never an
     error code on screen. Lifted from the inline scripts this replaces. */
  function label(FBU) {
    var s = "";
    try { s = String(FBU.name() || ""); } catch (e) {}
    if (!s) {
      var m = "";
      try { m = String(FBU.email() || ""); } catch (e2) {}
      var at = m.indexOf("@");
      s = at > 0 ? m.slice(0, at) : "";
    }
    s = s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!s) return "Account";
    if (s.indexOf("auth/") !== -1) return "Account";
    if (s.indexOf("Firebase") !== -1 || s.indexOf("firebase") !== -1) return "Account";
    return s.length > 18 ? (s.slice(0, 17) + "…") : s;
  }

  function next() {
    try {
      var p = String(location.pathname || "/").replace(/\.html$/, "");
      if (p === "/" || !p) p = "/";
      return encodeURIComponent(p + String(location.search || ""));
    } catch (e) { return "%2F"; }
  }

  /* A link, not a menu. The menu was a second decision stacked on top of the
     first: a reader who taps a profile icon has already decided they want
     their account, and /login is the page that works out whether that means
     signing in or making one. Signed in, it points at the account page. */
  function build(host) {
    var a = el("a", "acct-btn");
    a.href = "/login?next=" + next();
    a.innerHTML = ICON;
    a.setAttribute("aria-label", "Sign in");
    host.innerHTML = "";
    host.appendChild(a);

    return function paint(FBU) {
      var on = false;
      try { on = !!(FBU && FBU.signedIn()); } catch (e) {}
      try {
        a.href = on ? "/account" : ("/login?next=" + next());
        a.setAttribute("aria-label", on ? label(FBU) : "Sign in");
      } catch (e) {}
      reveal();
    };
  }

  function whenFBU(cb) {
    var done = false;
    function go() { if (done) return; done = true; try { cb(window.FBU || null); } catch (e) {} }
    if (window.FBU) { go(); return; }
    try { window.addEventListener("fbu-ready", go, false); } catch (e) {}
    try {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, false);
      else setTimeout(go, 0);
    } catch (e) {}
    try { setTimeout(go, 4000); } catch (e) { go(); }
  }

  function boot() {
    var host = null;
    try { host = document.getElementById("fb-acct"); } catch (e) {}
    if (!host) return;
    var paint;
    try { paint = build(host); } catch (e) { reveal(); return; }
    paint(null);                                   /* signed out until told otherwise */
    whenFBU(function (FBU) {
      if (!FBU) { paint(null); return; }
      paint(FBU);
      try { if (FBU.onChange) FBU.onChange(function () { paint(FBU); }); } catch (e) {}
    });
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, false);
    } else { boot(); }
  } catch (e) {}

  return { boot: boot, version: 1 };
})();
