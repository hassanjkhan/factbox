/* ==========================================================================
   Factbox — access. The one file that answers "may this person read?"

   THIS IS THE ONLY PLACE THAT QUESTION IS ANSWERED. Nothing else on the site
   should look at a storage flag, ask Firebase directly, or invent its own
   timing. Call FBX.ready() then FBX.can(), or listen with FBX.onChange().

   Why it exists: the same question used to be answered in four places — the
   reader, the shelves, the profile and the funnel — each with its own logic
   and, worse, its own idea of when the answer was available. That produced
   three bugs in a row where a paying reader was shown a paywall, and each fix
   only moved the race somewhere else. A single answer with a single clock is
   the actual fix.

   ---------------------------------------------------------------------------
   Four ways in, in order of authority

     admin       customers/{uid}.admin === true, or .role === "admin".
                 Written by the console or a function, never by a browser.
                 Founders and support get the same access a subscriber has.
     subscriber  customers/{uid}.premium === true. Written only by the Stripe
                 webhook, after Stripe has verified a real payment method.
     legacy      the local unlock flag. What a restore link sets, and what
                 anyone who subscribed before accounts existed still holds.
                 It can open the site; it can never close it.
     none        everything else.

   ---------------------------------------------------------------------------
   Timing, which is where every previous bug lived

   Identity and entitlement arrive separately. FBU.ready() settles when we know
   *who* someone is; the subscription lands later, on a Firestore snapshot.
   ready() here waits for the second, never the first, and never times out
   sooner than the thing it is waiting on.
   ========================================================================== */

var FBX = (function () {
  "use strict";

  /* Comfortably past auth.js's own billing fallback. Capping under it does not
     make a page faster — it makes the answer wrong. */
  var CAP_MS = 7000;

  var settled = false;
  var listeners = [];
  var resolvers = [];

  function store(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }

  function legacy() { return store("fb_unlocked_v1") === "1"; }

  function fbu() {
    try { return (window.FBU && window.FBU.premium) ? window.FBU : null; }
    catch (e) { return null; }
  }

  function isAdmin() {
    var u = fbu();
    try { return !!(u && u.admin && u.admin()); } catch (e) { return false; }
  }

  function isSubscriber() {
    var u = fbu();
    try { return !!(u && u.premium && u.premium()); } catch (e) { return false; }
  }

  /* The answer, and the reason for it — the reason is what makes a support
     conversation possible without guessing. */
  function why() {
    if (isAdmin()) return "admin";
    if (isSubscriber()) return "subscriber";
    if (legacy()) return "legacy";
    return "none";
  }

  function can() { return why() !== "none"; }

  /* --- when the answer is knowable ------------------------------------- */

  function settle() {
    if (settled) return;
    settled = true;
    var i;
    for (i = 0; i < resolvers.length; i++) {
      try { resolvers[i](); } catch (e) {}
    }
    resolvers = [];
  }

  function ready() {
    return new Promise(function (done) {
      if (settled) { done(); return; }
      resolvers.push(done);

      /* Never wait longer than a reader will. Falling through with the answer
         we have is right: `legacy` still opens the site, and a wrong "no" is
         corrected by onChange below rather than left on screen. */
      setTimeout(settle, CAP_MS);

      function hook() {
        var u = fbu();
        if (!u) return false;
        try {
          if (u.billingReady) { u.billingReady().then(settle, settle); return true; }
          if (u.ready) { u.ready().then(settle, settle); return true; }
        } catch (e) {}
        return false;
      }

      if (hook()) return;
      /* auth.js is a deferred module: it runs after parse but before
         DOMContentLoaded. If it has not appeared in about a second and a half
         it is not coming — the page does not load it, or it failed. Waiting
         the full cap there would make every signed-out reader stare at a
         loading pane for seven seconds to be told what we already knew. */
      var n = 0;
      var t = setInterval(function () {
        n++;
        if (hook()) { clearInterval(t); return; }
        if (n > 8) { clearInterval(t); settle(); }
      }, 200);
    });
  }

  /* --- changes afterwards ------------------------------------------------ */

  var lastAnswer = null;
  function announce() {
    var a = why();
    if (a === lastAnswer) return;
    lastAnswer = a;
    var i;
    for (i = 0; i < listeners.length; i++) {
      try { listeners[i](a !== "none", a); } catch (e) {}
    }
  }

  function onChange(fn) {
    if (typeof fn !== "function") return;
    listeners.push(fn);
    if (settled) { try { fn(can(), why()); } catch (e) {} }
  }

  (function watch() {
    function attach() {
      var u = fbu();
      if (!u || !u.onPremium) return false;
      try { u.onPremium(announce); } catch (e) {}
      return true;
    }
    if (!attach()) {
      var n = 0;
      var t = setInterval(function () {
        n++;
        if (attach() || n > 25) clearInterval(t);
      }, 200);
    }
    try { ready().then(announce); } catch (e) {}
  })();

  return {
    ready: ready,
    can: can,
    why: why,
    isAdmin: isAdmin,
    isSubscriber: isSubscriber,
    isLegacy: legacy,
    onChange: onChange,
    settled: function () { return settled; },
    CAP_MS: CAP_MS
  };
})();
