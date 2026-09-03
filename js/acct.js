/* The account control, once.

   Nine pages each carried their own inline copy of the same forty lines of
   state logic — nine places for it to drift apart, and it had: three of them
   showed "Sign in" and "Sign up" as two separate pills, one showed a bare
   "Account" link, and the reader's name was truncated to a different length on
   each. This is that logic, in one file, and the nine copies are gone.

   What it draws is one insignia at the top right of every page. Asked for:
   "ON EVERY SINGLE PAGE THAT EXISTS, THERE SHOULD NOT BE A SIGN IN OR SIGN UP
   BUTTON. IT SHOULD JUST BE AN UPPER RIGHT HAND PROFILE INSIGNIA THAT OPENS A
   DROP DOWN TO EITHER SIGN IN OR SIGN UP."

   Signed out the menu offers Sign in and Create account. Signed in it shows the
   reader's name, their account and their library. Escape closes it; so does a
   click anywhere else; so does moving focus out of it.

   ---------------------------------------------------------------------------
   The contract with a page

   A page provides one empty element and loads this file:

       <span class="acct" id="fb-acct"></span>
       <script src="/js/acct.js"></script>

   Everything inside it belongs to this file. A page that does not have that
   element gets nothing and no error — the reader page deliberately has no
   account control at all, because every pane there points at the story or at
   the next one.

   ---------------------------------------------------------------------------
   Why it never flashes

   Auth answers a beat after first paint, so a control that renders "signed
   out" and then corrects itself is a visible flicker on every page load. The
   button is drawn immediately — it is the same circle either way — and only
   its letter and its menu wait for the answer. Nothing moves when the answer
   lands, because nothing about the button's size depends on it.
   ========================================================================== */
(function () {
  "use strict";

  var host = null, btn = null, menu = null, open = false, FBU = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* A display name is text the reader typed, so it is trimmed, capped and
     scrubbed before it reaches the DOM. An auth error code is not a name:
     "auth/invalid-credential" has appeared in this slot before, which is both
     ugly and the one thing the house style forbids — no error codes on screen,
     ever. */
  function nameOf() {
    var s = "";
    try { s = String((FBU && FBU.name && FBU.name()) || ""); } catch (e) {}
    if (!s) {
      var m = "";
      try { m = String((FBU && FBU.email && FBU.email()) || ""); } catch (e2) {}
      var at = m.indexOf("@");
      s = at > 0 ? m.slice(0, at) : "";
    }
    s = s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!s || s.indexOf("auth/") !== -1 || s.toLowerCase().indexOf("firebase") !== -1) return "";
    return s.length > 22 ? (s.slice(0, 21) + "…") : s;
  }

  function signedIn() {
    try { return !!(FBU && FBU.signedIn && FBU.signedIn()); } catch (e) { return false; }
  }

  function initial() {
    var n = nameOf();
    return n ? n.charAt(0).toUpperCase() : "";
  }

  /* --- the menu ---------------------------------------------------------- */

  function item(href, text) {
    var a = el("a", "acct-item", text);
    a.setAttribute("href", href);
    a.setAttribute("role", "menuitem");
    return a;
  }

  function build() {
    menu.innerHTML = "";
    if (signedIn()) {
      var who = nameOf();
      if (who) {
        var h = el("p", "acct-who", who);
        menu.appendChild(h);
      }
      menu.appendChild(item("/account", "Your account"));
      menu.appendChild(item("/library", "Your library"));
    } else {
      menu.appendChild(item("/login?next=" + here(), "Sign in"));
      menu.appendChild(item("/join", "Create account"));
    }
  }

  /* Where to come back to. A path, never a full URL, and never anything with a
     scheme or a host in it — this string is put straight into a query. */
  function here() {
    try {
      var p = String(location.pathname || "/").replace(/^\/+/, "");
      if (!/^[A-Za-z0-9._~\/-]{0,64}$/.test(p)) return "";
      return encodeURIComponent(p);
    } catch (e) { return ""; }
  }

  function show(on) {
    open = !!on;
    try {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) build();
    } catch (e) {}
  }

  function paint() {
    try {
      var ini = initial();
      btn.className = "acct-btn" + (signedIn() ? " is-in" : "");
      btn.setAttribute("aria-label", signedIn()
        ? (nameOf() ? "Account menu for " + nameOf() : "Account menu")
        : "Sign in or create an account");
      var slot = btn.querySelector(".acct-ini");
      if (slot) {
        if (ini) { slot.textContent = ini; slot.className = "acct-ini"; }
        else { slot.textContent = ""; slot.className = "acct-ini is-anon"; }
      }
      if (open) build();
    } catch (e) {}
  }

  /* --- boot -------------------------------------------------------------- */

  function mount() {
    host = document.getElementById("fb-acct");
    if (!host) return false;

    btn = el("button", "acct-btn");
    btn.type = "button";
    btn.id = "fb-acct-btn";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(el("span", "acct-ini is-anon"));

    menu = el("div", "acct-menu");
    menu.id = "fb-acct-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    host.innerHTML = "";
    host.appendChild(btn);
    host.appendChild(menu);

    btn.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      show(!open);
    });

    /* Three ways out, because a menu you cannot dismiss is a trap on a phone:
       anywhere else on the page, Escape, and focus leaving the control. */
    document.addEventListener("click", function (e) {
      if (!open) return;
      try { if (host.contains(e.target)) return; } catch (x) {}
      show(false);
    }, true);
    document.addEventListener("keydown", function (e) {
      if (open && e && (e.key === "Escape" || e.keyCode === 27)) { show(false); btn.focus(); }
    }, false);
    host.addEventListener("focusout", function () {
      setTimeout(function () {
        try { if (open && !host.contains(document.activeElement)) show(false); } catch (x) {}
      }, 0);
    }, false);

    paint();
    return true;
  }

  /* The same bridge every page used to carry inline: js/auth.js is a module,
     so it runs after this file whatever order the tags are in. */
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
    if (!mount()) return;
    whenFBU(function (api) {
      FBU = api;
      if (!FBU) { paint(); return; }        /* no module: the signed-out menu */
      try { FBU.onReady(function () { paint(); }); } catch (e) { paint(); }
      try { FBU.onChange(function () { paint(); }); } catch (e) {}
    });
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, false);
    else boot();
  } catch (e) {}
})();
