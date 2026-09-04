/* The account control, once.

   Nine pages each carried their own inline copy of the same forty lines of
   state logic — nine places for it to drift apart, and it had: three of them
   showed "Sign in" and "Sign up" as two separate pills, one showed a bare
   "Account" link, and the reader's name was truncated to a different length on
   each. This is that logic, in one file, and the nine copies are gone.

   What it draws is one insignia at the top right of every page that asks for
   it. One tap, one destination, both ways round:

       signed in   ->  /account
       signed out  ->  /login?next=<this page>

   There is no menu. There used to be one signed in — the reader's name, then
   Your account, Your library, Settings — and it was removed on the same
   reasoning that removed the signed-out one before it. Library is a top-level
   tab in this very masthead, two inches to the left. Settings is a row on
   /account itself. So the menu spent a tap offering one destination that was
   not already one tap away, and that destination was /account. Now the
   insignia simply is the way to /account.

   It carries no aria-haspopup and no aria-expanded, because announcing a
   popup that never opens is a lie to a screen reader, and its accessible name
   says where it goes rather than reading out the reader's initial.

   It stays a <button> that navigates, which is what the signed-out insignia
   has always been. An <a href> would be the truer element for a control whose
   whole job is to go somewhere, and it was built and measured that way first —
   but `.tabs a` in css/app.css styles every anchor in this masthead nav, at a
   higher specificity than `.acct-btn`, and the insignia lives inside that nav
   on all seven pages. As an anchor the disc came out 34x44 rather than 34x34
   — an ellipse — with the wrong colour, font, padding and transition. Ten
   properties, one of them state-dependent. Restoring them from here would put
   the design system inside a script. See ACCOUNT.md 10.8 for the one-line
   change to `.tabs a` that would let this become a real link.

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
   circle is drawn immediately — it is the same circle either way — and only
   its letter and its label wait for the answer. Nothing moves when the answer
   lands, because nothing about the circle's size depends on it. Where the tap
   goes is decided at the moment of the tap, not painted in advance, so it is
   never stale. A tap in that first beat goes to /login?next=<here>, which is
   where it went before this file drew a menu at all, and login.html sends a
   reader who turns out to be signed in straight on to `next`.
   ========================================================================== */
(function () {
  "use strict";

  var host = null, btn = null, FBU = null;

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

  /* --- where one tap lands ------------------------------------------------ */

  /* Where to come back to. A path, never a full URL, and never anything with a
     scheme or a host in it — this string is put straight into a query. */
  function here() {
    try {
      var p = String(location.pathname || "/").replace(/^\/+/, "");
      if (!/^[A-Za-z0-9._~\/-]{0,64}$/.test(p)) return "";
      return encodeURIComponent(p);
    } catch (e) { return ""; }
  }

  /* Where a signed-out reader goes. One place: the sign-in page, which already
     offers both signing in and creating an account on the same screen. */
  function signInURL() {
    var n = here();
    return "/login" + (n ? "?next=" + n : "");
  }

  function destination() {
    return signedIn() ? "/account" : signInURL();
  }

  /* --- painting ----------------------------------------------------------- */

  function paint() {
    try {
      var inNow = signedIn(), who = nameOf(), ini = initial();
      btn.className = "acct-btn" + (inNow ? " is-in" : "");
      /* The accessible name says where the tap goes. The initial inside the
         circle is the reader's, not a label — a screen reader announcing "H"
         has told nobody anything. Signed in the reader's name rides along,
         because the row that used to show it lived in the menu that is gone. */
      btn.setAttribute("aria-label", inNow
        ? (who ? "Your account, " + who : "Your account")
        : "Sign in");
      var slot = btn.querySelector(".acct-ini");
      if (slot) {
        if (ini) { slot.textContent = ini; slot.className = "acct-ini"; }
        else { slot.textContent = ""; slot.className = "acct-ini is-anon"; }
      }
    } catch (e) {}
  }

  /* --- boot -------------------------------------------------------------- */

  function mount() {
    host = document.getElementById("fb-acct");
    if (!host) return false;

    btn = el("button", "acct-btn");
    btn.type = "button";
    btn.id = "fb-acct-btn";
    btn.appendChild(el("span", "acct-ini is-anon"));

    host.innerHTML = "";
    host.appendChild(btn);

    /* One listener, on the control itself, and it IS the behaviour. Nothing is
       bound to document any more: the menu that needed a click-outside
       dismiss, an Escape key and a focusout trap is gone, and so are all
       three. A listener still firing for a menu that no longer exists is
       worse than no listener at all.

       A <button> fires this on Enter and on Space as well as on a tap, so the
       keyboard costs nothing extra. */
    btn.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      try { location.href = destination(); } catch (x) {}
    });

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
      if (!FBU) { paint(); return; }        /* no module: the signed-out link */
      try { FBU.onReady(function () { paint(); }); } catch (e) { paint(); }
      try { FBU.onChange(function () { paint(); }); } catch (e) {}
    });
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, false);
    else boot();
  } catch (e) {}
})();
