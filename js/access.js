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
   Two questions, not one. They used to be the same function and that is how
   /explore came to tell the site's own owner they had bought the season.

     can()   may this person read?      admin, subscriber, legacy or owner.
     owns()  did this person BUY it?    subscriber or legacy, and nothing else.

   A founder reading with an admin flag and a laptop carrying the owner
   passphrase can both open all fifty-one stories. Neither of them paid for
   them, so neither may be told "You have all fifty-one." Padlocks are a can()
   question. Any sentence about entitlement is an owns() question.

   canRead(id) is the third one, and it is per-story: see "today's story" at
   the foot of this file.

   ---------------------------------------------------------------------------
   Five ways in, in order of authority

     admin       customers/{uid}.admin === true, or .role === "admin".
                 Written by the console or a function, never by a browser.
                 Founders and support get the same access a subscriber has.
                 Reads everything. Owns nothing.
     subscriber  customers/{uid}.premium === true. Written only by the Stripe
                 webhook, after Stripe has verified a real payment method.
     legacy      the local unlock flag. What a restore link sets, and what
                 anyone who subscribed before accounts existed still holds.
                 Qualified three ways below; still the only thing keeping a
                 pre-accounts buyer reading, so it is never deleted.
     owner       fb_owner_v1, set by js/owner.js from the passphrase. It opens
                 the site — that is the whole point of it — but it is a
                 convenience for one person on one device, not a purchase, and
                 it now reports itself as what it is instead of hiding inside
                 `legacy`. Lapses after OWNER_DAYS.
     none        everything else.

   ---------------------------------------------------------------------------
   What `legacy` is allowed to mean now

   It used to mean "this browser was unlocked once, by any means, forever". It
   granted paid access with no account, no subscription, offline, permanently,
   and it survived signing out. Three things narrow it, none of which deletes
   it and none of which can lock out somebody who is actually reading:

     1. It is not owner mode. FBO.grant() sets fb_unlocked_v1 AND fb_owner_v1.
        A browser carrying the owner mark is answered `owner`, not `legacy`.
     2. An account outranks the browser. While somebody is signed in and their
        billing answer has actually ARRIVED and says no, the account is the
        record — the same rule reading and saves already follow. The flag is
        left in place, so signing out gives it straight back, and the restore
        link never stops working.
     3. It lapses after LEGACY_DAYS of not being used. The clock is last-seen,
        not first-seen, deliberately: a restore link opened on a new phone is
        a visit, so it re-arms itself with no URL sniffing, and a browser that
        is genuinely being read on can never lapse. What lapses is a browser
        that was unlocked once and abandoned — a test, a demo, a borrowed
        phone. That is the hole, and it is the part that closes.

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

  var DAY_MS = 86400000;

  /* A browser-level entitlement with no clock on it is not an entitlement,
     it is a permanent grant. 400 days is a year plus a grace, measured from
     the last visit rather than the first, so nobody who is reading can ever
     hit it. 30 days for owner mode, which is nobody's purchase. */
  var LEGACY_DAYS = 400;
  var OWNER_DAYS  = 30;

  function store(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function put(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (e) {}
  }
  function drop(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  /* js/progress.js mirrors the unlock flag into a cookie as well as
     localStorage, because Instagram's and TikTok's in-app browsers hand out a
     localStorage that is wiped between sessions while cookies survive. That
     mirror is the reason forgetLegacy() did not work: see the note on it. */
  function killCookie(k) {
    try {
      document.cookie = k + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
    } catch (e) {}
  }

  var LEGACY_KEY = "fb_unlocked_v1";   /* owned by js/gate.js + js/progress.js */
  var LEGACY_AT  = "fb_unlocked_at_v1";/* owned here: last time it was seen */
  var OWNER_KEY  = "fb_owner_v1";      /* owned by js/owner.js */
  var OWNER_AT   = "fb_owner_at_v1";   /* owned by js/owner.js: when granted */

  function flag(k) { return store(k) === "1"; }

  function num(v) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /* A stamp that has never been written is written NOW, never back-dated.
     Every browser already holding one of these flags gets the full window
     from the moment this ships, so nothing that worked this morning stops
     working this afternoon. */
  function fresh(atKey, days) {
    var at = num(store(atKey));
    if (!at) return true;
    var age = Date.now() - at;
    if (age < 0) return true;               /* clock moved backwards */
    return age < days * DAY_MS;
  }

  function touch(key, atKey, days) {
    if (!flag(key)) return;
    var at = num(store(atKey));
    if (!at) { put(atKey, Date.now()); return; }
    if (Date.now() - at < 0) { put(atKey, Date.now()); return; }
    /* Only the flags that are still live get their clock wound on. An expired
       one must stay expired, or every page load would resurrect it. */
    if (!fresh(atKey, days)) return;
    if (Date.now() - at > DAY_MS) put(atKey, Date.now());   /* at most one write a day */
  }

  function ownerFlag() { return flag(OWNER_KEY); }
  function ownerMode() { return ownerFlag() && fresh(OWNER_AT, OWNER_DAYS); }

  /* Signing out has to take this with it.

     `legacy` means "this browser bought access before accounts existed" — it
     is a flag in localStorage, and nothing about signing out of Firebase
     touches localStorage. So a browser that had ever been unlocked stayed
     unlocked forever: sign out, and every story was still readable and no
     cover on the shelf wore a padlock, because the account was gone but the
     flag was not.

     Only ever called from an explicit sign-out. NOT from "the current identity
     is signed out", which is also true for the first ~600ms of every page load
     before Firebase has answered — clearing on that would wipe the flag of a
     genuine legacy reader who has no account to sign into.

     Someone who really did buy before accounts existed and has now signed out
     of one gets their access back from their restore link, which is what that
     link is for.

     IT HAS TO CLEAR THE COOKIE TOO, and it did not.

     js/progress.js keeps the same key in two stores and heals either one from
     the other: its dGet() reads localStorage, finds nothing, reads the cookie,
     and WRITES THE VALUE BACK into localStorage. So removing the localStorage
     copy alone un-signed-out nobody. Measured, in an isolated Chrome profile:
     sign out on /account, land on /explore, and localStorage.fb_unlocked_v1 is
     "1" again and the subtitle reads "You have all fifty-one." Both stores, or
     neither.

     fb_pass_v1 and fb_passsrc_v1 are deliberately left alone. They are the
     buyer's restore TOKEN, the thing FBP.restoreURL() rebuilds their link out
     of. Forgetting the unlock must not destroy the way back in. Nothing
     re-opens the site from a token on its own — js/progress.js only mints one
     when the unlock flag is already set — so keeping it costs no access and
     saves a support conversation. */
  function forgetLegacy() {
    drop(LEGACY_KEY);
    drop(LEGACY_AT);
    killCookie(LEGACY_KEY);
    announce();
  }

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

  /* --- what the browser flag is allowed to say --------------------------- */

  /* The account is the record.

     Only true once the billing answer has actually ARRIVED — billingKnown().
     Before that, "not premium" is the default value of a variable, not an
     answer, and treating it as one would padlock a paying reader for the
     ~600ms Firebase takes, which is the bug this whole file exists to stop.

     Signed out is not a denial either. It is true for the first moments of
     every page load, and it is the permanent state of the pre-accounts buyer
     this flag is for. */
  function accountDenies() {
    var u = fbu();
    if (!u) return false;
    try {
      if (!u.signedIn || !u.signedIn()) return false;
      if (!u.billingKnown || !u.billingKnown()) return false;
      return !isAdmin() && !isSubscriber();
    } catch (e) { return false; }
  }

  /* Identity has THREE states, and the bug is always in the third.

     Signed in, signed out, and NOT YET ANSWERED. Firebase arrives by dynamic
     import(), so on every page load there is a window — ~600ms warm, longer
     cold, forever if the SDK is blocked — in which nobody has said anything.
     accountDenies() above is careful about this in the direction that costs a
     paying reader: it will not deny during that window. This is the same care
     in the direction that costs US, and it is the one that was missing.

     During the unknown window a browser flag must not GRANT either. If it
     does, the page renders every story open and then has to take them away
     when the answer lands, and taking access away is the correction the site
     is worst at making — it is a reload, it is jarring, and any path that
     drops it leaves a signed-out reader looking at the whole season. Padlocks
     drawn and then removed are fine and are the site's render-then-correct
     rule. Padlocks absent and then added are the product being given away for
     as long as the answer takes.

     So: no answer yet, no grant from the browser flag. The wait is bounded by
     auth.js's own READY_MS, which sets known() true even when the SDK never
     loads, so this can never hang and can never be permanent.

     THE LEGACY BUYER IS NOT AFFECTED. This is not "signed out means locked" —
     signed out is a real answer and the flag is honoured on it, which is the
     whole point of the flag and the only thing keeping a pre-accounts buyer
     reading. It is only the moment BEFORE any answer that stops granting. And
     a page with no auth module at all (fbu() is null) is not an unanswered
     page, it is a page that never asks; that reader keeps their access. */
  function identityUnknown() {
    var u = fbu();
    if (!u) return false;
    try { return !(u.known && u.known()); } catch (e) { return false; }
  }

  function legacyFlag() { return flag(LEGACY_KEY); }

  function legacy() {
    if (!legacyFlag()) return false;
    if (identityUnknown()) return false;
    /* ownerFlag(), not ownerMode(): an EXPIRED owner mark still disqualifies
       the unlock flag it set. Owner mode lapsing must not quietly promote the
       same browser to "legacy buyer". */
    if (ownerFlag()) return false;
    if (accountDenies()) return false;
    return fresh(LEGACY_AT, LEGACY_DAYS);
  }

  /* The answer, and the reason for it — the reason is what makes a support
     conversation possible without guessing. */
  function why() {
    if (isAdmin()) return "admin";
    if (isSubscriber()) return "subscriber";
    if (legacy()) return "legacy";
    if (ownerMode()) return "owner";
    return "none";
  }

  function can() { return why() !== "none"; }

  /* Did this person BUY the season? Narrower than can() on purpose, and the
     only thing any sentence about entitlement may ask. An admin and an owner
     read everything and bought nothing. */
  function owns() {
    var a = why();
    return a === "subscriber" || a === "legacy";
  }

  /* why() with the near-misses spelled out, for support and for the console.
     Never rendered; it exists so "why am I seeing a paywall" is a question
     with an answer instead of a guess. */
  function detail() {
    var a = why();
    if (a !== "none") return a;
    if (legacyFlag() && ownerFlag()) return "none:owner-mode-lapsed";
    if (legacyFlag() && identityUnknown()) return "none:identity-not-yet-known";
    if (legacyFlag() && accountDenies()) return "none:legacy-outranked-by-account";
    if (legacyFlag()) return "none:legacy-lapsed";
    return "none";
  }

  /* Wind the clocks on, once per page. Both flags are stamped on first sight
     rather than back-dated, so shipping this locks nobody out today. */
  (function stamp() {
    try {
      touch(LEGACY_KEY, LEGACY_AT, LEGACY_DAYS);
      touch(OWNER_KEY, OWNER_AT, OWNER_DAYS);
    } catch (e) {}
  })();

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

  /* Render once the answer is known, and again if it changes. Every shelf
     wants exactly this, and hand-rolling it per page is how three surfaces
     ended up disagreeing about when access was knowable. */
  function paint(fn) {
    if (typeof fn !== "function") return;
    ready().then(function () {
      try { fn(can(), why()); } catch (e) {}
      onChange(function (allowed, reason) {
        try { fn(allowed, reason); } catch (e) {}
      });
    });
  }

  /* ------------------------------------------------------------------------
     correct(drew) — the only safe way for a page to say "redraw, I was wrong".

     A page renders as soon as it has an answer, and once in a while a better
     answer arrives afterwards: a cold Firestore, a phone waking from sleep, a
     subscription that lands a beat late. The page is then showing padlocks the
     reader has paid to remove, and it has to correct itself.

     The obvious way to write that is `onChange(function (a) { if (a) reload() })`,
     and it is how /stories came to reload forever. onChange fires IMMEDIATELY
     when the answer is already known. On the shelf it was registered at the top
     of the script, so it fired while the first render was still waiting on
     fetch — the page's "already drawn" flag was still false, so it reloaded, so
     it never finished the render, so it reloaded again. A signed-in reader
     could not get to the shelf at all.

     Three rules, in here, once, so no page can get them wrong again:

       1. A caller cannot register before it has drawn. `drew` IS the render —
          you pass the answer the thing on screen was actually built from — so
          "did I finish rendering?" is not a flag anyone can forget to set.
       2. A reload only happens when the answer got BETTER than what was drawn.
          Locked -> unlocked is worth a reload. Nothing else is.
       3. One reload per tab, ever. The flag lives in sessionStorage, because it
          has to survive the very reload it is guarding — a variable would be
          wiped by the reload and guard nothing. If some future path still gets
          rules 1 and 2 wrong, the reader sees one extra reload, not a loop.
     ------------------------------------------------------------------------ */
  var ONCE = "fbx_corrected_v1";
  function correct(drew) {
    drew = !!drew;
    onChange(function (allowed) {
      /* Both directions. Locked -> unlocked is a reader looking at a wall they
         have paid to pass. Unlocked -> locked is the other one, and it is the
         one that costs us money: sign out on a story and the page kept the
         text on screen, because nothing redrew it. Anything that still agrees
         with what was drawn is not a correction and must not reload. */
      if (allowed === drew) return;
      try {
        if (sessionStorage.getItem(ONCE) === "1") return;
        sessionStorage.setItem(ONCE, "1");
      } catch (e) { return; }            /* no session storage, no guard, no reload */
      try { location.reload(); } catch (e2) {}
    });
  }

  /* A reader who genuinely navigates gets the one correction back. Called on
     the first page of a new visit rather than on unload, which does not run
     reliably on iOS. */
  try {
    if (!/[?&]fbx=/.test(String(location.search || "")) &&
        performance && performance.navigation &&
        performance.navigation.type === 0) sessionStorage.removeItem(ONCE);
  } catch (e) {}


  /* ========================================================================
     Today's story, and the only per-story exception on the site.

     "Today's Factbox is supposed to be free for all users for that day —
     that one is free even if you're logged out." So the global question is
     no longer enough: canRead(id) is the per-story one, and it lives here
     because this file is the only place any access question is answered.

     canRead(id) is true when ANY of these holds:
       can()               admin, subscriber, legacy or owner
       the story is free   `free` in data/index.json — 01 and 02
       the story is today  the one story the date picks

     WHY THE ARITHMETIC MOVED HERE RATHER THAN BEING CALLED OUT OF today.js.
     Two surfaces need the answer and only one of them draws the front page:
     read.html decides between the story and the paywall and never loads
     js/today.js at all. Exporting the pick from today.js would mean read.html
     either loading the front page's renderer to ask one question, or keeping
     a second copy of the permutation — and a second copy is exactly how a
     reader gets shown an unlocked hero and then hits a wall on tapping it.
     So the calculation is here, once, and js/today.js reads its own hero back
     out of FBX.todayOf(). One arithmetic, two callers, nothing to drift.

     WHERE THE ANSWER COMES FROM NOW.
     The server, when it can be reached, and the arithmetic below when it
     cannot. `functions/today.js` decides — from ITS clock, the catalogue
     order and an editorial override document the owner can file — and
     `functions/story.js` honours the same answer, which is what turns "today
     is free" from a thing the browser believes into a thing the backend
     enforces. Story text for today's pick leaves the server without an
     account; text for any other paid story does not, whatever this file
     thinks.

     THE FALLBACK IS NOT OPTIONAL. A backend that can break the front page is
     worse than the client calculation it replaces, so every path below works
     with the network absent: the deterministic pick is computed first and
     used unless a server answer is actually in hand. Slow, down, blocked,
     offline, CORS-refused, or the reader is on a plane — the site picks a
     story, frees exactly one, and renders exactly as it did before any of
     this existed.

     WHAT THE DETERMINISTIC PICK IS DERIVED FROM, AND WHAT IT IS NOT.
     The UTC date and the catalogue — its length and its filed order. Nothing
     else. No query parameter, no hash, no header, no referrer. There is
     deliberately no setter: a reader cannot nominate a story as today's. The
     only input a reader can touch is their own device clock, and moving it
     still yields exactly one free story — a different day's, not an extra
     one, and one the server will refuse to hand over.

     UTC, so "today" means one thing for everybody, and a permutation rather
     than a shuffle — a stride coprime with the catalogue size visits all 51
     exactly once in 51 days, with nothing to seed and the same answer in
     every browser. This is the same scheme js/today.js has always used; it
     has only stopped being a private copy of it.
     ======================================================================== */

  function dayNumber() {
    try {
      var d = new Date();
      var ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      var n = Math.floor(ms / DAY_MS);
      return (isFinite(n) && n > 0) ? n : 0;
    } catch (e) { return 0; }
  }

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  /* The first number at or after ~0.618n that is coprime with n. */
  function strideFor(n) {
    if (!(n > 2)) return 1;
    var start = Math.floor(n * 0.618) || 1;
    var i, c;
    for (i = 0; i < n; i++) {
      c = ((start + i - 1) % (n - 1)) + 1;
      if (gcd(c, n) === 1) return c;
    }
    return 1;
  }

  /* The kth story of the permutation, as an index into a catalogue of n. */
  function indexAt(n, k) {
    if (!(n > 0)) return -1;
    return ((Math.floor(k) * strideFor(n)) % n + n) % n;
  }

  function todayIndex(n) { return indexAt(n, dayNumber()); }

  /* --- the catalogue ------------------------------------------------------
     Ids in filed order, with the permanent `free` flags. Handed in by
     js/today.js, which already has the array; fetched here on any page that
     does not. Either way it is data/index.json in its own order. */

  var CAT = null;
  var CAT_P = null;

  function norm(id) {
    try { return String(id == null ? "" : id).toUpperCase(); } catch (e) { return ""; }
  }

  /* Set once. The catalogue is the one input to today's pick that is not the
     clock, so it may be established exactly once per page and never replaced.
     Without that, `FBX.catalogue([{id:"44"}])` from a console is a way to
     nominate any story as today's — a static site cannot stop somebody with
     devtools reading data/stacks.json anyway (js/gate.js says so at the top),
     but the access module should not hand them a shorter path to it. */
  function catalogue(stacks) {
    try {
      if (CAT) return CAT;
      if (!stacks || !stacks.length) return CAT;
      var out = [], i, x;
      for (i = 0; i < stacks.length; i++) {
        x = stacks[i];
        if (x && typeof x === "object") out.push({ id: norm(x.id), free: !!x.free });
        else out.push({ id: norm(x), free: false });
      }
      if (out.length) CAT = out;
    } catch (e) {}
    return CAT;
  }

  function todayId() {
    if (!CAT || !CAT.length) return "";
    var t = serverId();
    if (t) return t;
    var i = todayIndex(CAT.length);
    return (i >= 0 && CAT[i]) ? CAT[i].id : "";
  }

  /* today.js's hero, chosen here so the two cannot disagree. Registers the
     catalogue on the way past, which is what makes isToday() synchronous for
     every cover it draws afterwards. */
  function todayOf(stacks) {
    catalogue(stacks);
    try {
      if (!stacks || !stacks.length) return null;
      /* The server's answer if one is already in hand — it is primed from
         localStorage synchronously at parse time, so on every day after the
         first this costs no network and no wait, and the hero is the curated
         pick from the very first frame. Otherwise the arithmetic, immediately.
         Either way this function returns before it returns; nothing here can
         make a page wait on a request. */
      var t = serverId(), j;
      if (t) {
        for (j = 0; j < stacks.length; j++) {
          if (stacks[j] && norm(stacks[j].id) === t) return stacks[j];
        }
      }
      var i = todayIndex(stacks.length);
      return (i >= 0) ? (stacks[i] || null) : null;
    } catch (e) { return null; }
  }

  function isFreeStory(id) {
    if (!CAT) return false;
    var want = norm(id), i;
    for (i = 0; i < CAT.length; i++) { if (CAT[i].id === want) return CAT[i].free; }
    return false;
  }

  /* ========================================================================
     The server's answer, and why this file still works without it.

     `functions/today.js` is the authority: it derives the day's pick from the
     server's clock, the catalogue order and an editorial override document,
     and `functions/story.js` refuses to hand out text for any other paid
     story. This is the client half. It has exactly one job and one rule.

     THE JOB. Confirm or correct the arithmetic above, so the padlocks and the
     hero agree with the thing that will actually serve the text.

     THE RULE. It may never be on a critical path. Concretely:

       - Nothing here runs before or during first paint. The answer for THIS
         UTC day is read out of localStorage synchronously when this file
         parses, which is a memory read, not a request; the network call only
         happens on the first visit of a new day, and it is deferred by a
         timer so it cannot compete with the parser or the first frame.
       - todayOf(), todayId() and isToday() stay synchronous and always return
         something. They prefer a server answer that is already in hand and
         fall back to the arithmetic otherwise. Neither ever waits.
       - canRead() is the only thing that waits, and only when the answer it
         would otherwise give is "no". Capped at ASK_MS, resolved instantly
         from the day cache after the first call, and a timeout, a 500, a
         blocked request, an ad blocker, a captive portal or no network at all
         all land in the same place: the deterministic pick, unchanged.

     A SERVER ANSWER IS ONLY EVER ACCEPTED IF IT NAMES A STORY WE HAVE. A
     malformed body, a story id that is not in the catalogue, a wrong-shaped
     payload — each is discarded and the arithmetic stands. The failure mode
     of a curation feature must not be an empty front page.

     WHAT THIS DOES NOT PRETEND TO BE. The cached answer lives in localStorage,
     which the reader owns; somebody with dev tools can edit it and make their
     own browser draw an unlocked hero. That was already true of every flag on
     this site and it buys them nothing, because `functions/story.js` never
     reads anything the client sends when it decides which story is today's.
     The client half is for drawing the right page. The server half is the
     rule.
     ======================================================================== */

  var TODAY_URL = "https://us-central1-factbox-7cb97.cloudfunctions.net/today";
  var TODAY_KEY = "fbx_today_v1";

  /* Long enough that a phone on a bad connection still gets the real answer,
     short enough that nobody stares at a reader page waiting for it. Only
     canRead() can ever spend it, and only once per day per browser. */
  var ASK_MS = 2500;

  var SERVER = null;      /* { d: "YYYY-MM-DD", id: "38" } once known */
  var ASK_P = null;       /* the in-flight or finished request, shared */
  var todayListeners = [];

  /* This browser's idea of the UTC date, in the same form the server sends
     back. The cache is keyed on it, so a reader who moves their clock simply
     misses the cache and re-asks — and the server answers with the real day.
     Failing toward one extra request is the right direction to fail. */
  function utcDate() {
    try {
      var d = new Date();
      var m = d.getUTCMonth() + 1, day = d.getUTCDate();
      return d.getUTCFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" +
             (day < 10 ? "0" : "") + day;
    } catch (e) { return ""; }
  }

  /* The server's pick, or "" — and "" is a complete, working answer, because
     every caller falls back to the arithmetic. Cross-checked against the
     catalogue whenever we have one: an id we do not recognise is not an
     instruction, it is a bug, and the arithmetic is what stands. */
  function serverId() {
    if (!SERVER || !SERVER.id) return "";
    if (SERVER.d !== utcDate()) return "";
    if (CAT && CAT.length) {
      var i;
      for (i = 0; i < CAT.length; i++) { if (CAT[i].id === SERVER.id) return SERVER.id; }
      return "";
    }
    return SERVER.id;
  }

  function isToday(id) {
    var t = todayId();
    return !!t && norm(id) === t;
  }

  /* Anything that wants to redraw when the server corrects the arithmetic.
     Deliberately its OWN list rather than the access listeners: today's pick
     changing is not an access change, why() has not moved, and firing the
     general listeners would push a non-event through every padlock pass and
     through FBX.correct() on every page on the site. */
  function onToday(fn) {
    if (typeof fn !== "function") return;
    todayListeners.push(fn);
    var t = todayId();
    if (t) { try { fn(t); } catch (e) {} }
  }

  function announceToday(before) {
    var now = todayId(), i;
    if (now === before) return;
    for (i = 0; i < todayListeners.length; i++) {
      try { todayListeners[i](now, before); } catch (e) {}
    }
  }

  /* --- the day cache ------------------------------------------------------
     One localStorage entry, holding one date and one story id. Read
     synchronously at parse; written once per day. This is what keeps the
     endpoint down to roughly one call per reader per UTC day rather than one
     per page load. */
  function loadCached() {
    try {
      var raw = store(TODAY_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      if (!o.d || !o.id) return null;
      if (String(o.d) !== utcDate()) return null;
      return { d: String(o.d), id: norm(o.id) };
    } catch (e) { return null; }
  }

  function saveCached(o) {
    try { put(TODAY_KEY, JSON.stringify({ d: o.d, id: o.id })); } catch (e) {}
  }

  /* Read the cache before anything on the page has rendered. No request, no
     await, no failure mode: a miss simply leaves SERVER null. */
  (function primeToday() {
    var hit = loadCached();
    if (hit) SERVER = hit;
  })();

  /* --- the request --------------------------------------------------------
     Resolves. Always. There is no rejection path out of this function, on
     purpose: every caller's error handler and success handler would do the
     same thing, and a promise that can reject is a promise somebody forgets
     to catch. */
  function askServer() {
    if (ASK_P) return ASK_P;
    ASK_P = new Promise(function (done) {
      /* Already answered for today, out of the cache or a previous call. */
      if (serverId()) { done(serverId()); return; }
      if (!window.fetch) { done(""); return; }

      var settled = false;
      var before = todayId();
      function finish(id) {
        if (settled) return;
        settled = true;
        done(id || "");
      }
      /* The cap is a plain timer rather than only an AbortController, so a
         browser that has neither still cannot hold canRead() open. */
      setTimeout(function () { finish(""); }, ASK_MS);

      var ctl = null;
      try { if (window.AbortController) ctl = new AbortController(); } catch (e) { ctl = null; }
      if (ctl) setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ASK_MS);

      var opts = { method: "GET", credentials: "omit", cache: "default" };
      if (ctl) opts.signal = ctl.signal;

      try {
        window.fetch(TODAY_URL, opts).then(function (r) {
          if (!r || !r.ok) { finish(""); return null; }
          return r.json();
        }).then(function (j) {
          if (!j || j.ok !== true) { finish(""); return; }
          var id = norm(j.id);
          var d = String(j.date || "");
          if (!/^[0-9]{2}[A-Z]?$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { finish(""); return; }
          SERVER = { d: d, id: id };
          /* Only cache what we would also accept on the way back in. */
          if (serverId()) saveCached(SERVER); else SERVER = null;
          finish(serverId());
          announceToday(before);
        }, function () { finish(""); });
      } catch (e) { finish(""); }
    });
    return ASK_P;
  }

  /* Warm the answer on the first visit of a new UTC day, off the critical
     path. A timer rather than a straight call so the request is issued after
     the parser is done with this file, and never before the first frame. It
     is one 300-byte GET per browser per day; every page load after it is
     answered out of localStorage with no network at all. */
  (function warmToday() {
    try {
      if (serverId()) return;                 /* cached; nothing to fetch */
      setTimeout(function () { try { askServer(); } catch (e) {} }, 600);
    } catch (e) {}
  })();

  /* One fetch, shared, and it is the same request js/gate.js already makes
     with cache:"force-cache" — not a second one. A page with no FB, or a
     failed fetch, resolves with no catalogue: canRead() then falls back to
     the global answer, which is the direction that cannot show a paid story
     to somebody who has not paid. */
  function needCatalogue() {
    if (CAT) return Promise.resolve(CAT);
    if (CAT_P) return CAT_P;
    CAT_P = new Promise(function (done) {
      var got = false;
      try {
        if (window.FB && FB.loadIndex) {
          got = true;
          FB.loadIndex().then(function (st) { catalogue(st); done(CAT); },
                              function () { done(null); });
        }
      } catch (e) { got = false; }
      if (!got) done(null);
    });
    return CAT_P;
  }

  /* Per-story, and asynchronous for the same reason ready() is: the answer is
     not knowable at parse time and pretending otherwise is what padlocked
     paying readers three times. */
  function canRead(id) {
    /* Started HERE, before the wait below and not after it. The day's answer
       and the account's answer are independent questions, and asking them in
       series would stack a network round trip on top of a wait that was
       already the slowest thing on the page. Measured, with the endpoint hung
       and never answering: 3,095 ms in series, 2,501 ms in parallel — which
       is ASK_MS exactly. And 1,829 ms, unchanged from before any of this
       existed, whenever the request fails fast, which is what an offline
       browser does. */
    var asked = askServer();
    return ready().then(function () {
      if (can()) return true;
      return needCatalogue().then(function () {
        /* Permanently free is a fact in the catalogue and needs nobody's
           opinion. Answered first so 01 and 02 never wait on anything. */
        if (isFreeStory(id)) return true;
        /* Everything else hinges on which story is today's, and that is the
           server's to say. Waited on HERE and nowhere else, because this is
           the only place the answer changes an outcome — and the wait is
           capped, resolves instantly once the day's answer is cached, and
           falls through to the arithmetic on any failure. A reader offline
           gets exactly the behaviour they got before this existed. */
        return asked.then(function () { return isToday(id); },
                          function () { return isToday(id); });
      });
    });
  }

  return {
    ready: ready,
    paint: paint,
    correct: correct,
    can: can,
    owns: owns,
    why: why,
    detail: detail,
    isAdmin: isAdmin,
    isSubscriber: isSubscriber,
    isLegacy: legacy,
    isOwnerMode: ownerMode,
    onChange: onChange,
    forgetLegacy: forgetLegacy,
    settled: function () { return settled; },

    /* per-story */
    canRead: canRead,
    catalogue: catalogue,
    todayOf: todayOf,
    todayId: todayId,
    isToday: isToday,
    onToday: onToday,
    askToday: askServer,
    dayNumber: dayNumber,
    todayIndex: todayIndex,

    CAP_MS: CAP_MS,
    LEGACY_DAYS: LEGACY_DAYS,
    OWNER_DAYS: OWNER_DAYS
  };
})();
