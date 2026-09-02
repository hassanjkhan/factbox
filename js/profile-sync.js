/* ==========================================================================
   Factbox — onboarding answers into Firestore.
   Exposes: window.FBPS

   WHAT THIS IS. `js/account.js` (FBA) holds everything a reader told the
   join funnel — what draws them to history, which statements sounded
   familiar, how many minutes a day, what streak they are aiming for, the
   plan loader's three yes/nos, their name and email. All of it lives in one
   localStorage key and one cookie, on one phone. Clear the browser and it is
   gone; open the site on a second phone and it was never there.

   This file mirrors that record — and only that record — into Firestore
   under the reader's own account, so it survives losing the browser.

   WHERE IT WRITES, AND WHERE IT DOES NOT.

       customers/{uid}/profile/onboarding      <- this file, client-written
       customers/{uid}                         <- the Stripe webhook. NEVER us.

   `customers/{uid}` carries the `premium` boolean that decides access, and
   it is written by the Stripe extension from a webhook running with admin
   credentials. A client write to that document — even a merge of unrelated
   fields — races the webhook and can clobber a subscription state that no
   one on this site can rebuild. So the answers go in a subdocument of their
   own, which nothing else writes and nothing else reads to make a decision.

   THE FIVE RULES THIS FILE OBEYS WITHOUT EXCEPTION:

   1. It never throws, at top level or anywhere else. Every storage read,
      every SDK call, every promise has a catch. A reader must never see a
      consequence of this file existing.

   2. A denied write is a no-op, not an error. The Firestore rules may not
      allow this path yet (see PROFILE-SYNC RULE in the report / the block in
      FIREBASE-ANALYTICS.md). Until they do, every write is rejected, and the
      correct reader-visible outcome of that is nothing at all. After a
      denial we stop trying for the rest of the page, so a rejected write
      cannot become a retry loop against a rule that is not going to change
      mid-session.

   3. Signed out, it does nothing. No queue, no local shadow copy, no
      "sync later" flag. FBA already is the local copy.

   4. It never writes anything the reader did not give us. Every field below
      is a value FBA stored because a human tapped it. Nothing is inferred,
      derived, scored or bucketed. An unanswered question has no field.

   5. It is debounced. Onboarding is a fast tapping flow and every tap moves
      FBA; one Firestore write per tap would be a write per tap. Changes are
      coalesced (DEBOUNCE_MS) and an unchanged payload is never re-sent.

   ES5 only, like every file here except js/auth.js. The one modern thing is
   the dynamic import that fetches the SDK, and it is built with `new
   Function` so that a browser too old to parse `import()` fails to build one
   function rather than failing to parse this whole file.
   ========================================================================== */

(function () {
  "use strict";

  var W = (typeof window !== "undefined" && window) ? window : null;
  if (!W) { return; }
  if (W.FBPS && W.FBPS.__factbox) { return; }   /* never install twice */

  /* ======================================================================
     Configuration. Same project, same public config as js/auth.js — this is
     the web API key Firebase publishes in every client, not a secret. It is
     repeated rather than imported because js/auth.js is a module and this
     file is not; if the two ever disagree, js/auth.js is right.
     ====================================================================== */

  var SDK_VERSION = "10.14.1";
  var SDK_BASE    = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";

  var CONFIG = {
    apiKey:            "AIzaSyD3GRAWOihX3kTEGgxz3QytfcMg6M-7mM8",
    authDomain:        "factbox-7cb97.firebaseapp.com",
    projectId:         "factbox-7cb97",
    storageBucket:     "factbox-7cb97.firebasestorage.app",
    messagingSenderId: "790045781901",
    appId:             "1:790045781901:web:527527387e7dd3285497c4"
  };

  /* The path. Two segments under the reader's own document, so it is a
     document and not a stray field on theirs. */
  var COLL = "profile";
  var DOC  = "onboarding";

  var SCHEMA      = 1;
  var DEBOUNCE_MS = 1500;   /* coalesce a burst of taps into one write */
  var FIRST_MS    = 700;    /* the sign-in write can be quicker; nothing is typing */
  var MIN_GAP_MS  = 4000;   /* never two writes closer together than this */
  var READY_MS    = 9000;   /* longer than FBU's own 8s; we are never the reason */

  /* ======================================================================
     Guarded primitives.
     ====================================================================== */

  function noop() {}

  function fba() {
    try { return (W.FBA && typeof W.FBA.get === "function") ? W.FBA : null; }
    catch (e) { return null; }
  }
  function fbu() {
    try { return (W.FBU && typeof W.FBU.uid === "function") ? W.FBU : null; }
    catch (e) { return null; }
  }

  /* State. All of it is per-page-load; nothing here persists. */
  var sdk      = null;    /* the flattened Firebase namespace */
  var db       = null;
  var loading  = null;   /* the in-flight SDK load, shared by every caller */
  var loadFail = false;
  var denied   = false;   /* rules said no. Stop, silently, for this page. */
  var lastJSON = "";      /* the payload we last successfully wrote */
  var lastSent = null;    /* which keys that payload carried (see clears()) */
  var lastAt   = 0;
  var timer    = null;
  var writes   = 0;
  var errs     = 0;
  var installed = false;

  /* ======================================================================
     The payload.

     One field per answer FBA holds, and not one field more. `get()` is used
     rather than the individual accessors because it copies the record
     without minting anything — `FBA.accountId()` would create an id as a
     side effect of being asked, and a sync must not change what it syncs.
     ====================================================================== */

  function str(v, max) {
    try {
      var s = String(v == null ? "" : v);
      return s.length > max ? s.slice(0, max) : s;
    } catch (e) { return ""; }
  }

  function strList(v, maxLen, maxEach) {
    var out = [];
    try {
      if (!v || !v.length) return out;
      for (var i = 0; i < v.length && out.length < maxLen; i++) {
        var s = str(v[i], maxEach);
        if (s) out.push(s);
      }
    } catch (e) {}
    return out;
  }

  function numList(v, maxLen) {
    var out = [];
    try {
      if (!v || !v.length) return out;
      for (var i = 0; i < v.length && out.length < maxLen; i++) {
        var n = Number(v[i]);
        out.push(isFinite(n) ? (n ? 1 : 0) : 0);
      }
    } catch (e) {}
    return out;
  }

  /* The empty value for each field, so a cleared answer can be cleared
     upstream rather than left behind. See clears(). */
  var EMPTY = {
    draw: "", relates: [], goalMinutes: 0, streakDays: 0, planAnswers: [],
    interests: [], frequency: "", plan: "", name: "", email: "",
    localAccountId: "", onboardingComplete: false
  };

  function answers() {
    var out = {};
    var A = fba();
    if (!A) return out;

    var r;
    try { r = A.get(); } catch (e) { return out; }
    if (!r || typeof r !== "object") return out;

    /* The ported iOS funnel. 0 and "" mean "not answered", which is a
       different thing from any legal answer, so they produce no field. */
    var draw = str(r.draw, 30);                     if (draw) out.draw = draw;
    var rel  = strList(r.relates, 8, 30);           if (rel.length) out.relates = rel;
    var goal = Math.floor(Number(r.goal) || 0);     if (goal > 0) out.goalMinutes = goal;
    var strk = Math.floor(Number(r.streak) || 0);   if (strk > 0) out.streakDays = strk;
    var q    = numList(r.planAnswers, 3);           if (q.length) out.planAnswers = q;

    /* Legacy but permanent — see the note in js/account.js. Other layers
       still read them, so they are still the reader's answers. */
    var ints = strList(r.interests, 12, 30);        if (ints.length) out.interests = ints;
    var freq = str(r.frequency, 20);                if (freq) out.frequency = freq;

    /* What they picked and who they said they were. */
    var plan = str(r.plan, 20);                     if (plan) out.plan = plan;
    var nm   = str(r.name, 40);                     if (nm) out.name = nm;
    var em   = str(r.email, 120);                   if (em) out.email = em;

    /* The local join key, only if one already exists. This is the string
       that went to Stripe as client_reference_id on any checkout started
       before this reader had an account; without it there is no way to
       reconcile such a payment with this uid. It is not data about the
       reader and nothing is derived from it. */
    var aid = str(r.accountId, 40);                 if (aid) out.localAccountId = aid;

    if (r.onboarded === true) out.onboardingComplete = true;

    return out;
  }

  /* A field the reader has cleared — Skip on a step they had answered — must
     come back out of Firestore, or the account remembers something they
     un-said. Merge writes cannot do that on their own, so any key we have
     written before and are not writing now is sent as its empty value. Only
     keys we ourselves wrote, so a blank browser never blanks a full record
     (a reader signing in on a second phone has an empty FBA; see sync()). */
  function clears(now) {
    if (!lastSent) return;
    for (var k in lastSent) {
      if (!Object.prototype.hasOwnProperty.call(lastSent, k)) continue;
      if (Object.prototype.hasOwnProperty.call(now, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(EMPTY, k)) continue;
      var e = EMPTY[k];
      now[k] = (e && e.length === 0 && typeof e !== "string") ? [] : e;
    }
  }

  function stamp(payload) {
    payload.schema = SCHEMA;
    /* A server timestamp, or no timestamp at all. A client clock is a value
       the reader did not give us and a number the rules cannot check. */
    try {
      if (sdk && typeof sdk.serverTimestamp === "function") {
        payload.updatedAt = sdk.serverTimestamp();
      }
    } catch (e) {}
    return payload;
  }

  /* Comparable form — the payload minus the sentinel, which is a new object
     every call and would make every write look like a change. */
  function fingerprint(payload) {
    try {
      var copy = {}, k;
      for (k in payload) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        if (k === "updatedAt") continue;
        copy[k] = payload[k];
      }
      return JSON.stringify(copy);
    } catch (e) { return ""; }
  }

  function countAnswers(o) {
    var n = 0;
    try {
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k) &&
            k !== "schema" && k !== "updatedAt" && k !== "localAccountId") n++;
      }
    } catch (e) {}
    return n;
  }

  /* ======================================================================
     The SDK. Same dynamic-import pattern as js/auth.js, with the same
     documented seam so the render checks can drive this without a network.

     `new Function` rather than a literal import(): this file is a classic
     script on pages that also carry the reader's whole funnel, and a browser
     old enough to treat `import(` as a syntax error would fail to parse the
     entire file rather than fail to build one function. Failing here costs a
     sync. Failing at parse would cost the page.
     ====================================================================== */

  var dynImport = null;
  try { dynImport = new Function("u", "return import(u);"); } catch (e) { dynImport = null; }

  function loadSDK() {
    try {
      if (W.FBPS_SDK) return Promise.resolve(W.FBPS_SDK);
      if (W.FBU_SDK)  return Promise.resolve(W.FBU_SDK);
    } catch (e) {}
    if (!dynImport) return Promise.reject(new Error("no dynamic import"));
    try {
      return Promise.all([
        dynImport(SDK_BASE + "firebase-app.js"),
        dynImport(SDK_BASE + "firebase-firestore.js")
      ]).then(function (mods) {
        var out = {}, i, k;
        for (i = 0; i < mods.length; i++) {
          for (k in mods[i]) { try { out[k] = mods[i][k]; } catch (e) {} }
        }
        return out;
      });
    } catch (e) { return Promise.reject(e); }
  }

  /* The app. getApp() first, so we share js/auth.js's instance and therefore
     its signed-in auth state — a Firestore handle from a different app would
     write as nobody and be denied for the wrong reason. initializeApp with
     the identical options returns that same default app when auth.js has not
     booted yet, which is the only other case. */
  function appFor() {
    if (!sdk) return null;
    try { if (typeof sdk.getApp === "function") return sdk.getApp(); } catch (e) {}
    try { if (typeof sdk.initializeApp === "function") return sdk.initializeApp(CONFIG); }
    catch (e2) {}
    return null;
  }

  /* One load, shared by every caller. Two answers changed inside the same
     second must not start two SDK fetches. */
  function need() {
    if (db) return Promise.resolve(db);
    if (loadFail) return Promise.reject(new Error("sdk unavailable"));
    if (loading) return loading;
    loading = loadSDK().then(function (mod) {
      sdk = mod || null;
      if (!sdk || typeof sdk.doc !== "function" || typeof sdk.setDoc !== "function") {
        loadFail = true;
        throw new Error("sdk incomplete");
      }
      var app = appFor();
      try { db = sdk.getFirestore(app); } catch (e) { db = null; }
      if (!db) { loadFail = true; throw new Error("no firestore"); }
      return db;
    }, function (e) {
      loadFail = true;
      throw e;
    });
    return loading;
  }

  /* ======================================================================
     The write.
     ====================================================================== */

  function ref(uid) {
    try { return sdk.doc(db, "customers", uid, COLL, DOC); } catch (e) { return null; }
  }

  function write(uid, payload) {
    var r = ref(uid);
    if (!r) return Promise.reject(new Error("no ref"));
    /* merge, so this write can never remove a field a later version of this
       file learns to keep. Cleared answers are handled explicitly above. */
    try { return sdk.setDoc(r, payload, { merge: true }); }
    catch (e) { return Promise.reject(e); }
  }

  /* Rejections that mean "the rules said no". None of these are worth
     retrying inside one page load, and none of them are worth a word on
     screen: a reader whose answers did not reach the server still has every
     one of them on the phone in front of them, and the page reads the local
     copy either way. */
  function isDenied(e) {
    try {
      var c = String((e && (e.code || e.name)) || "");
      var m = String((e && e.message) || "");
      return c.indexOf("permission-denied") !== -1 ||
             c.indexOf("unauthenticated")   !== -1 ||
             m.indexOf("permission")        !== -1 ||
             m.indexOf("PERMISSION_DENIED") !== -1 ||
             m.indexOf("insufficient")      !== -1;
    } catch (e2) { return false; }
  }

  function flush() {
    timer = null;
    if (denied || loadFail) return;

    var U = fbu();
    if (!U) return;                                   /* no auth layer at all */
    var uid = "";
    try { uid = U.uid ? String(U.uid() || "") : ""; } catch (e) { uid = ""; }
    if (!uid) return;                                 /* signed out: nothing to do */

    var A = fba();
    if (!A) return;                                   /* no funnel on this page */

    var payload = answers();
    /* A reader who signs in on a second phone has an empty FBA. Writing that
       would blank the answers they gave on the first one. Nothing to say is
       not the same as saying nothing. */
    if (countAnswers(payload) === 0 && !lastSent) return;

    clears(payload);

    var fp = fingerprint(payload);
    if (fp && fp === lastJSON) return;                /* unchanged; do not write */

    var now = 0;
    try { now = Date.now(); } catch (e) { now = 0; }
    if (lastAt && now && (now - lastAt) < MIN_GAP_MS) {
      schedule(MIN_GAP_MS - (now - lastAt));
      return;
    }

    need().then(function () {
      stamp(payload);
      return write(uid, payload).then(function () {
        writes++;
        lastAt   = now || lastAt;
        lastJSON = fp;
        lastSent = {};
        for (var k in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, k) &&
              Object.prototype.hasOwnProperty.call(EMPTY, k)) lastSent[k] = 1;
        }
        return null;
      });
    }).then(null, function (e) {
      errs++;
      if (isDenied(e)) denied = true;
      /* Everything else — offline, a transient 5xx, an SDK that never
         arrived — is left for the next change to retry. Nothing is shown,
         nothing is logged, nothing is thrown. */
      return null;
    });
  }

  function schedule(ms) {
    if (denied || loadFail) return;
    try {
      if (timer) { W.clearTimeout(timer); timer = null; }
      timer = W.setTimeout(function () {
        try { flush(); } catch (e) {}
      }, typeof ms === "number" ? ms : DEBOUNCE_MS);
    } catch (e) {
      /* No timers is not a reason to write on every tap; it is a reason not
         to sync. */
      timer = null;
    }
  }

  /* ======================================================================
     Watching for changes.

     FBA has no change event, so the setters are wrapped here rather than in
     js/account.js — the mirror should not make the thing it mirrors know it
     exists. Every page calls these through `FBA.setX(...)`, so replacing the
     property is enough; the original is called first and its return value is
     passed straight back, so a wrapped setter is indistinguishable from the
     one it replaced.
     ====================================================================== */

  var WATCHED = ["setDraw", "setRelates", "setGoal", "setStreak",
                 "addPlanAnswer", "setInterests", "setFrequency", "setPlan",
                 "signUp", "finishOnboarding", "forget"];

  function wrap() {
    var A = fba();
    if (!A) return false;
    var wrapped = 0;
    for (var i = 0; i < WATCHED.length; i++) {
      (function (nm) {
        try {
          var fn = A[nm];
          if (typeof fn !== "function" || fn.__fbps) return;
          var next = function () {
            var out;
            try { out = fn.apply(A, arguments); }
            catch (e) { out = false; }
            try { schedule(DEBOUNCE_MS); } catch (e2) {}
            return out;
          };
          next.__fbps = true;
          A[nm] = next;
          wrapped++;
        } catch (e) {}
      })(WATCHED[i]);
    }
    return wrapped > 0;
  }

  /* The AUTH.md §2 bridge, verbatim. js/auth.js is a deferred module, so an
     ES5 file cannot assume window.FBU exists at the moment it runs. */
  function whenFBU(cb) {
    var done = false;
    function go() { if (done) return; done = true; try { cb(W.FBU || null); } catch (e) {} }
    if (W.FBU) { go(); return; }
    try { W.addEventListener("fbu-ready", go, false); } catch (e) {}
    try {
      if (W.document && W.document.readyState === "loading") {
        W.document.addEventListener("DOMContentLoaded", go, false);
      } else { W.setTimeout(go, 0); }
    } catch (e) {}
    try { W.setTimeout(go, 4000); } catch (e) { go(); }
  }

  function install() {
    if (installed) return;
    installed = true;

    wrap();
    /* join.html builds its steps after this file runs on some paths, and a
       second surface may define FBA late. Cheap to try again. */
    try { W.setTimeout(wrap, 0); } catch (e) {}
    try { W.setTimeout(wrap, 1500); } catch (e) {}

    /* Another tab of the same site changing the record. */
    try {
      W.addEventListener("storage", function (ev) {
        try {
          if (!ev || !ev.key) return;
          var A = fba();
          if (A && A.KEY && ev.key !== A.KEY) return;
          schedule(DEBOUNCE_MS);
        } catch (e) {}
      }, false);
    } catch (e) {}

    /* Leaving the page is the last chance to catch a change made in the last
       second and a half of it. */
    try {
      W.addEventListener("pagehide", function () {
        try { if (timer) { W.clearTimeout(timer); timer = null; } flush(); } catch (e) {}
      }, false);
    } catch (e) {}
    try {
      if (W.document) {
        W.document.addEventListener("visibilitychange", function () {
          try {
            if (W.document.visibilityState === "hidden") {
              if (timer) { W.clearTimeout(timer); timer = null; }
              flush();
            }
          } catch (e) {}
        }, false);
      }
    } catch (e) {}

    /* Sign-in, sign-out, and the first answer of the session. */
    whenFBU(function (U) {
      if (!U) return;                     /* no auth on this page: nothing syncs */
      try {
        if (typeof U.onChange === "function") {
          U.onChange(function () {
            /* A sign-out clears the destination, not the source. FBA is
               per-browser and per AUTH.md §6 signing out does not forget it. */
            lastJSON = ""; lastSent = null; denied = false;
            schedule(FIRST_MS);
          });
        } else if (typeof U.onReady === "function") {
          U.onReady(function () { schedule(FIRST_MS); });
        }
      } catch (e) {}
      /* Belt and braces: if neither listener ever fires, ask once. */
      try { W.setTimeout(function () { schedule(FIRST_MS); }, READY_MS); } catch (e) {}
    });
  }

  /* ======================================================================
     The surface. Small on purpose — nothing on the site needs to call this
     file, and nothing does. It exists so a render check can look, and so a
     future account screen can offer "sync now" without reaching inside.
     ====================================================================== */

  var FBPS = {
    __factbox: true,
    path: function () {
      var U = fbu(), uid = "";
      try { uid = (U && U.uid()) || ""; } catch (e) { uid = ""; }
      return uid ? ("customers/" + uid + "/" + COLL + "/" + DOC) : "";
    },
    /* What would be written right now, for a person reading their own data.
       Never the sentinel — this is for looking at, not for writing. */
    preview: function () { try { return answers(); } catch (e) { return {}; } },
    sync: function () { try { schedule(0); } catch (e) {} },
    state: function () {
      return { writes: writes, errors: errs, denied: denied,
               loaded: !!db, loadFailed: loadFail, watching: installed };
    },
    SCHEMA: SCHEMA
  };

  try { W.FBPS = FBPS; } catch (e) {}
  try { install(); } catch (e) {}
})();
