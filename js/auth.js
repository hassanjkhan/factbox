/* ==========================================================================
   Factbox — real authentication and the live premium flag.
   Exposes: window.FBU

   WHAT THIS IS. Every other layer on this site answers "is this browser
   unlocked" (gate.js), "where did this browser stop" (progress.js) or "what
   did this browser tell us" (account.js). All three are per-browser and none
   of them can be checked. This file is the first one that can: it signs a
   reader in with Firebase Auth and reads a `premium` boolean that only a
   Stripe webhook, running with admin credentials, is allowed to write.

   THE ONE FLAG. `customers/{uid}.premium` is the whole contract. Subscription
   documents carry the detail an account screen wants — renewal date, trial
   end, amount — but nothing on this site decides access from them. One flag,
   written in one place, read in one place.

   WHY THIS FILE IS THE ONLY MODERN ONE. The Firebase SDK ships as ES modules.
   It is imported here with dynamic import(), which keeps this file loadable
   both as <script type="module"> and as a plain <script>, and keeps the
   import out of the parse step so a browser that cannot fetch gstatic still
   gets a working FBU that simply reports "signed out". Everything this file
   EXPOSES is ES5-callable: plain functions, plain objects, promises. No
   consumer needs to change.

   THE FIVE RULES THIS FILE OBEYS WITHOUT EXCEPTION:

   1. It never throws at top level. The whole body is inside a try/catch and
      every public method is individually guarded. An old webview that cannot
      parse this file leaves window.FBU undefined, which every consumer must
      already survive — see AUTH.md.

   2. ready() always settles. Never rejects, never hangs. If gstatic is
      blocked, if IndexedDB is walled off, if the network dies mid-handshake,
      ready() resolves with null after READY_MS and the page renders a real
      signed-out screen instead of a spinner that never stops.

   3. No Firebase error code ever reaches a reader. message() maps codes to
      sentences and scrubs anything containing "auth/" as a last resort, so a
      code we have never seen still renders as English.

   4. Google sign-in falls back to redirect. Nearly all traffic here is inside
      the Instagram and TikTok webviews, where window.open is either blocked
      or opens a window with no way back. Popup is tried where it can work and
      abandoned the moment it cannot.

   5. Storage access is guarded. Private mode and in-app webviews throw on
      write, not on read.
   ========================================================================== */

(function () {
  "use strict";

  var W = (typeof window !== "undefined" && window) ? window
        : (typeof globalThis !== "undefined" ? globalThis : null);
  if (!W) { return; }
  if (W.FBU && W.FBU.__factbox) { return; }   /* never install twice */

  /* ======================================================================
     Configuration. Live project, already provisioned; factbox.app is an
     authorized domain and Email/Password, Google and Phone are enabled.
     Changing any of this means changing it in the Firebase console too.
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

  /* How long a page may be asked to wait before it must render something.
     Eight seconds is long for a phone and short for a webview cold-starting
     a 200KB SDK over 3G. Past it, ready() resolves signed-out and onChange()
     corrects the page if the SDK turns up late. */
  var READY_MS   = 8000;
  /* The same idea for the billing read, measured from the moment a uid is
     known. Access questions must not wait on Firestore forever. */
  var BILLING_MS = 6000;

  var RKEY = "fb_auth_redirect_v1";   /* sessionStorage: a redirect is in flight */

  /* ======================================================================
     Guarded primitives.
     ====================================================================== */

  function noop() {}

  function ssGet(k) {
    try { return W.sessionStorage ? W.sessionStorage.getItem(k) : null; }
    catch (e) { return null; }
  }
  function ssSet(k, v) {
    try { if (W.sessionStorage) W.sessionStorage.setItem(k, v); return true; }
    catch (e) { return false; }
  }
  function ssDel(k) {
    try { if (W.sessionStorage) W.sessionStorage.removeItem(k); } catch (e) {}
  }

  function doc$() { try { return W.document || null; } catch (e) { return null; } }
  function ua() {
    try { return String((W.navigator && W.navigator.userAgent) || ""); }
    catch (e) { return ""; }
  }

  /* Call every registered listener, one bad listener never stopping the next. */
  function fanout(list, a, b) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b); } catch (e) {}
    }
  }
  function drop(list, fn) {
    return function () {
      try {
        var i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      } catch (e) {}
    };
  }

  /* ======================================================================
     Reader-facing error copy.

     A Firebase error code is a debugging aid, not a sentence. Every code we
     can plausibly hit is mapped; anything unmapped falls through to a real
     sentence, and scrub() guarantees that even a code we have never seen
     cannot be printed on a page.
     ====================================================================== */

  var COPY = {
    /* email + password */
    "auth/invalid-email":
      "That email address does not look right. Check it and try again.",
    "auth/missing-email":
      "Type your email address first.",
    "auth/missing-password":
      "Type your password first.",
    "auth/weak-password":
      "Pick a password with at least six characters.",
    "auth/email-already-in-use":
      "You already have an account with that email. Enter your password to sign in.",
    "auth/user-not-found":
      "No account here with that email yet. Create one below — it takes a moment.",
    "auth/wrong-password":
      "That password does not match. Try again, or reset it below.",
    "auth/invalid-credential":
      "That email and password do not match. Try again, or reset your password below.",
    "auth/invalid-login-credentials":
      "That email and password do not match. Try again, or reset your password below.",
    "auth/user-disabled":
      "This account has been turned off. Support can sort it out.",
    "auth/requires-recent-login":
      "For safety, sign in again before changing this.",

    /* rate limits and the network */
    "auth/too-many-requests":
      "Too many tries from this phone. Wait a minute, then try again.",
    "auth/network-request-failed":
      "No connection. Check your signal and try again.",
    "auth/timeout":
      "That took too long. Try again.",
    "auth/quota-exceeded":
      "Too many codes have been sent from here today. Use email instead.",

    /* Google, popups and redirects */
    "auth/popup-blocked":
      "This browser blocked the Google window. Taking you to Google instead.",
    "auth/popup-closed-by-user":
      "The Google window closed before you finished. Try again.",
    "auth/cancelled-popup-request":
      "The Google window closed before you finished. Try again.",
    "auth/operation-not-supported-in-this-environment":
      "This browser cannot open the Google window. Taking you to Google instead.",
    "auth/account-exists-with-different-credential":
      "You already signed up with that email a different way. Use your email and password below.",
    "auth/credential-already-in-use":
      "That sign-in already belongs to another account here.",
    "auth/operation-not-allowed":
      "That way of signing in is not switched on. Try another one.",
    "auth/unauthorized-domain":
      "Sign-in is not allowed from this address. Open factbox.app and try there.",
    "auth/web-storage-unsupported":
      "This browser is blocking the storage sign-in needs. Open factbox.app in Safari or Chrome.",

    /* phone */
    "auth/invalid-phone-number":
      "That phone number does not look right. Include the country code, like +1 555 123 4567.",
    "auth/missing-phone-number":
      "Type your phone number first.",
    "auth/invalid-verification-code":
      "That code is not right. Check the six digits and try again.",
    "auth/missing-verification-code":
      "Type the six-digit code first.",
    "auth/code-expired":
      "That code has expired. Send yourself a new one.",
    "auth/captcha-check-failed":
      "The robot check did not pass. Reload the page and try again.",
    "auth/missing-app-credential":
      "The robot check did not finish. Reload the page and try again.",

    /* ours, not Firebase's */
    "fb/unavailable":
      "Could not reach the sign-in service. Check your connection and reload.",
    "fb/no-code":
      "Send yourself a code first, then type it here.",
    "fb/bad-phone":
      "That phone number does not look right. Include the country code, like +1 555 123 4567.",
    "fb/no-recaptcha":
      "This browser cannot run the robot check. Sign in with Google or email instead."
  };

  var FALLBACK = "Something went wrong. Try that again in a moment.";

  /* The last line of defence. Whatever else happens, a string containing a
     Firebase error code does not get rendered. */
  function scrub(s) {
    var t = "";
    try { t = String(s == null ? "" : s); } catch (e) { return FALLBACK; }
    if (!t) return FALLBACK;
    if (t.indexOf("auth/") !== -1) return FALLBACK;
    if (t.indexOf("Firebase") !== -1) return FALLBACK;
    if (t.indexOf("firebase") !== -1) return FALLBACK;
    if (t.indexOf("permission-denied") !== -1) return FALLBACK;
    if (t.length > 220) return FALLBACK;
    return t;
  }

  function codeOf(err) {
    try {
      if (!err) return "";
      if (typeof err === "string") return err;
      if (err.code) return String(err.code);
      return "";
    } catch (e) { return ""; }
  }

  /* message(err) — the only thing a page should ever print. */
  function message(err) {
    try {
      var c = codeOf(err);
      if (c && COPY[c]) return COPY[c];
      /* Firebase sometimes nests the code inside the message text. Fish it
         out rather than surrendering to the generic line. */
      if (err && err.message) {
        var m = String(err.message).match(/auth\/[a-z0-9-]+/);
        if (m && COPY[m[0]]) return COPY[m[0]];
      }
      if (err && err.friendly) return scrub(err.friendly);
      return FALLBACK;
    } catch (e) { return FALLBACK; }
  }

  /* Every rejection this file produces is already a sentence. `code` stays on
     the object for logging and for the one place login.html branches on it
     (email-already-in-use, which becomes a mode switch rather than an error). */
  function fail(code, cause) {
    var e;
    try { e = new Error(message(code ? { code: code } : cause)); }
    catch (e2) { e = { message: FALLBACK }; }
    try {
      e.code = code || codeOf(cause) || "";
      e.friendly = e.message;
      e.cause = cause || null;
    } catch (e3) {}
    return e;
  }
  function wrap(err) { return fail(codeOf(err), err); }

  /* ======================================================================
     State.
     ====================================================================== */

  var sdk = null;          /* the flattened Firebase namespace once loaded */
  var auth = null;
  var db = null;
  var loadErr = null;      /* the reason the SDK never arrived, if any */

  var curUser = null;
  var authKnown = false;   /* has auth state been observed even once */
  var timedOut = false;

  var premiumFlag = false;
  var adminFlag   = false;
  var subNow = null;
  var billingKnown = false;

  var changeFns = [], premFns = [], subFns = [];

  var unsubAuth = null, unsubCust = null, unsubSubs = null;
  var phoneHandle = null, verifier = null;
  var redirectErr = null;

  function defer() {
    var d = { done: false, resolve: noop, promise: null };
    try {
      d.promise = new Promise(function (res) {
        d.resolve = function (v) { if (!d.done) { d.done = true; try { res(v); } catch (e) {} } };
      });
    } catch (e) {
      /* No Promise at all. Nothing here can work, but nothing may throw. */
      d.promise = { then: function () { return this; }, catch: function () { return this; } };
      d.resolve = function () { d.done = true; };
    }
    return d;
  }

  var readyD   = defer();
  var billingD = defer();
  var sdkD     = defer();   /* resolves with sdk, or with null on failure */

  /* Settles once, on the first billing answer this page ever gets, and is
     never replaced.

     billingD IS replaced: onUser() swaps in a fresh deferred every time the
     signed-in identity changes, so a caller asking afterwards waits for that
     user's entitlement rather than the previous one's. That is correct, and
     it is also what made every page on this site take exactly CAP_MS.

     billingReady() used to hand out billingD.promise. access.js grabs it as
     soon as window.FBU exists — about 50ms in, long before Firebase has
     reported an auth state. onUser() then threw that deferred away and
     resolved its replacement. The promise access.js was still holding was
     left dangling forever, FBX.ready() fell through to its 7-second cap, and
     the first card of every story waited the full seven seconds behind a
     gate that had in fact answered at about 600ms.

     A promise already handed to a caller has to keep resolving after the
     internals move on underneath it, so billingReady() returns this one.
     Later changes of answer were never this promise's job: they arrive
     through onPremium(), which is what FBX.onChange() listens to. */
  var billingFirstD = defer();

  function settleReady() {
    authKnown = true;
    readyD.resolve(curUser);
  }
  function settleBilling() {
    billingKnown = true;
    billingD.resolve(premiumFlag);
    billingFirstD.resolve(premiumFlag);
  }

  try { W.setTimeout(function () {
    if (!readyD.done) { timedOut = true; settleReady(); }
    /* The pathological case: the SDK loaded but never reported an auth
       state. Nothing may wait on billingReady() forever either. */
    if (!billingD.done || !billingFirstD.done) { settleBilling(); }
  }, READY_MS); } catch (e) {}

  /* ======================================================================
     Loading the SDK.

     W.FBU_SDK is a documented seam: if a flattened Firebase namespace is
     already on the page, it is used instead of the network. It exists so the
     render checks can drive every branch of this file in jsdom, which cannot
     execute a real ES module from a CDN, and so a future self-hosted bundle
     needs no edit here.
     ====================================================================== */

  function loadSDK() {
    try {
      if (W.FBU_SDK) { return Promise.resolve(W.FBU_SDK); }
    } catch (e) {}
    try {
      return Promise.all([
        import(SDK_BASE + "firebase-app.js"),
        import(SDK_BASE + "firebase-auth.js"),
        import(SDK_BASE + "firebase-firestore.js")
      ]).then(function (mods) {
        var out = {}, i, k;
        for (i = 0; i < mods.length; i++) {
          for (k in mods[i]) {
            try { out[k] = mods[i][k]; } catch (e) {}
          }
        }
        return out;
      });
    } catch (e) {
      /* A browser old enough to treat import() as a syntax error never gets
         here — it failed at parse and FBU is simply absent. This catches the
         rarer case of import() present but refusing to run. */
      return Promise.reject(e);
    }
  }

  /* ======================================================================
     Billing. One document, one boolean.
     ====================================================================== */

  function setPremium(v) {
    var b = !!v;
    if (b === premiumFlag && billingKnown) return;
    premiumFlag = b;
    settleBilling();
    fanout(premFns, premiumFlag);
  }

  function toMs(v) {
    try {
      if (v == null) return 0;
      if (typeof v === "number") return v > 1e11 ? v : v * 1000;
      if (typeof v === "string") {
        var n = Number(v);
        if (isFinite(n) && n > 0) return n > 1e11 ? n : n * 1000;
        var p = Date.parse(v);
        return isFinite(p) ? p : 0;
      }
      if (typeof v.toMillis === "function") return v.toMillis();
      if (typeof v.toDate === "function") { var d = v.toDate(); return d ? d.getTime() : 0; }
      if (typeof v.seconds === "number") return v.seconds * 1000;
      if (typeof v._seconds === "number") return v._seconds * 1000;
    } catch (e) {}
    return 0;
  }

  function normSub(id, d) {
    if (!d) return null;
    var status = "";
    try { status = String(d.status || ""); } catch (e) {}
    return {
      id: String(id || ""),
      status: status,
      active: d.active === true || status === "active" || status === "trialing",
      trialing: status === "trialing",
      cancelAtPeriodEnd: d.cancelAtPeriodEnd === true || d.cancel_at_period_end === true,
      currentPeriodEnd: toMs(d.currentPeriodEnd != null ? d.currentPeriodEnd : d.current_period_end),
      trialEnd: toMs(d.trialEnd != null ? d.trialEnd : d.trial_end),
      amount: (typeof d.amount === "number") ? d.amount : null,
      currency: d.currency ? String(d.currency) : "",
      interval: d.interval ? String(d.interval) : "",
      raw: d
    };
  }

  /* The best subscription to show a reader: an active one, and among several,
     the one that runs longest. Cancelled and past ones are not shown at all —
     "your plan" is the plan you have, not the ones you had. */
  function pickSub(list) {
    var best = null, i;
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.active) continue;
      if (!best || s.currentPeriodEnd > best.currentPeriodEnd) best = s;
    }
    return best;
  }

  function setSub(s) {
    subNow = s || null;
    fanout(subFns, subNow);
  }

  function snapData(snap) {
    try {
      if (!snap) return null;
      var ex = snap.exists;
      if (typeof ex === "function") { if (!snap.exists()) return null; }
      else if (ex === false) { return null; }
      return snap.data ? snap.data() : null;
    } catch (e) { return null; }
  }

  function stopWatch() {
    try { if (unsubCust) unsubCust(); } catch (e) {}
    try { if (unsubSubs) unsubSubs(); } catch (e) {}
    unsubCust = null; unsubSubs = null;
  }

  function watchBilling(uid) {
    stopWatch();
    if (!uid || !sdk || !db) {
      setSub(null);
      setPremium(false);
      settleBilling();
      return;
    }
    /* Firestore may be slow, blocked or denied. None of those may leave a
       page waiting on billingReady() forever. */
    try { W.setTimeout(function () { settleBilling(); }, BILLING_MS); } catch (e) {}

    try {
      unsubCust = sdk.onSnapshot(
        sdk.doc(db, "customers", uid),
        function (snap) {
          var d = snapData(snap);
          /* Admin comes off the same document as premium — one read, one
             snapshot, one source of truth. Only the webhook and the console
             can write here; the rules deny every client write. */
          adminFlag = !!(d && (d.admin === true || d.role === "admin"));
          setPremium(!!(d && d.premium === true));
          settleBilling();
        },
        function () {
          /* Denied or offline. Not premium is the safe answer, and the page
             says "we could not check" rather than "you have not paid". */
          setPremium(false);
          settleBilling();
        }
      );
    } catch (e) { setPremium(false); settleBilling(); }

    try {
      unsubSubs = sdk.onSnapshot(
        sdk.collection(db, "customers", uid, "subscriptions"),
        function (qs) {
          var list = [];
          try {
            if (qs && typeof qs.forEach === "function") {
              qs.forEach(function (d) { list.push(normSub(d.id, d.data ? d.data() : null)); });
            } else if (qs && qs.docs) {
              for (var i = 0; i < qs.docs.length; i++) {
                list.push(normSub(qs.docs[i].id, qs.docs[i].data()));
              }
            }
          } catch (e) {}
          setSub(pickSub(list));
        },
        function () { setSub(null); }
      );
    } catch (e) { setSub(null); }
  }

  /* ======================================================================
     Wiring, once the SDK is in hand.
     ====================================================================== */

  var seenUser = false;   /* has onAuthStateChanged reported even once */

  function onUser(u) {
    var was = curUser ? curUser.uid : null;
    curUser = u || null;
    var now = curUser ? curUser.uid : null;
    /* The first report matters even when it is "nobody": signed out is an
       answer, and billingReady() has to settle on it too. */
    if (!seenUser || was !== now) {
      seenUser = true;
      billingKnown = false;
      billingD = defer();
      premiumFlag = false;
      adminFlag = false;
      subNow = null;
      watchBilling(now);
    }
    settleReady();
    fanout(changeFns, curUser);
  }

  function boot() {
    return loadSDK().then(function (mod) {
      sdk = mod;
      sdkD.resolve(sdk);
      var app = sdk.initializeApp(CONFIG);
      auth = sdk.getAuth(app);
      try { db = sdk.getFirestore(app); } catch (e) { db = null; }
      try { if (auth) auth.useDeviceLanguage && auth.useDeviceLanguage(); } catch (e) {}

      /* The redirect leg of Google sign-in. Called on every load, because the
         only way to know a redirect came back is to ask. Its failures are
         recorded, never thrown: the page is about to render a sign-in screen
         either way. */
      var pending = ssGet(RKEY) === "1";
      var rr;
      try { rr = sdk.getRedirectResult(auth); } catch (e) { rr = Promise.reject(e); }

      return rr.then(function (res) {
        ssDel(RKEY);
        if (res && res.user) { /* onAuthStateChanged will fire with it */ }
        else if (pending) {
          /* We sent them to Google and came back with nobody. Almost always
             a webview that dropped the session between the two pages. */
          redirectErr = "That sign-in did not come back. Try Google once more, or use your email and password.";
        }
        return null;
      }, function (e) {
        ssDel(RKEY);
        redirectErr = message(e);
        return null;
      }).then(function () {
        try {
          unsubAuth = sdk.onAuthStateChanged(auth, onUser, function () { settleReady(); });
        } catch (e) { settleReady(); }
        return null;
      });
    }, function (e) {
      loadErr = e;
      sdkD.resolve(null);
      settleReady();
      settleBilling();
      return null;
    }).catch(function (e) {
      loadErr = e;
      sdkD.resolve(null);
      settleReady();
      settleBilling();
      return null;
    });
  }

  /* need() — every method that talks to Firebase starts here, so "the SDK
     never loaded" is one sentence in one place rather than a thrown
     TypeError in nine. */
  function need() {
    return sdkD.promise.then(function (s) {
      if (!s || !auth) throw fail("fb/unavailable");
      return s;
    });
  }

  /* ======================================================================
     Email and password.
     ====================================================================== */

  function cleanEmail(s) {
    try { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }
    catch (e) { return ""; }
  }

  function signUpEmail(mail, pass) {
    var e = cleanEmail(mail);
    if (!e) return Promise.reject(fail("auth/missing-email"));
    if (!pass) return Promise.reject(fail("auth/missing-password"));
    if (String(pass).length < 6) return Promise.reject(fail("auth/weak-password"));
    return need().then(function (s) {
      return s.createUserWithEmailAndPassword(auth, e, String(pass));
    }).then(function (cred) {
      var u = cred && cred.user ? cred.user : null;
      /* The verification email is part of signing up, not a second step the
         reader has to discover. It is sent, and its failure is swallowed:
         an account that exists with no email sent is recoverable from the
         account screen; an account that fails to be created is not. */
      return sendVerify(u).then(function () { return u; }, function () { return u; });
    }, function (err) { throw wrap(err); });
  }

  function signInEmail(mail, pass) {
    var e = cleanEmail(mail);
    if (!e) return Promise.reject(fail("auth/missing-email"));
    if (!pass) return Promise.reject(fail("auth/missing-password"));
    return need().then(function (s) {
      return s.signInWithEmailAndPassword(auth, e, String(pass));
    }).then(function (cred) {
      return cred && cred.user ? cred.user : null;
    }, function (err) { throw wrap(err); });
  }

  function resetPassword(mail) {
    var e = cleanEmail(mail);
    if (!e) return Promise.reject(fail("auth/missing-email"));
    return need().then(function (s) {
      return s.sendPasswordResetEmail(auth, e);
    }).then(function () { return true; }, function (err) {
      /* "No account with that email" is a real answer to "reset my password",
         but saying it out loud tells a stranger which addresses are
         registered. Firebase's own newer behaviour is to say nothing; we
         match it and report success either way. */
      var c = codeOf(err);
      if (c === "auth/user-not-found" || c === "auth/invalid-email") return true;
      throw wrap(err);
    });
  }

  function sendVerify(u) {
    return need().then(function (s) {
      var user = u || curUser;
      if (!user) throw fail("fb/unavailable");
      if (user.emailVerified) return true;
      var url = "";
      try { url = W.location ? (W.location.origin + "/account.html") : ""; } catch (e) {}
      var opts = url ? { url: url, handleCodeInApp: false } : undefined;
      return s.sendEmailVerification(user, opts).then(function () { return true; });
    }, function (err) { throw wrap(err); });
  }

  function resendVerification() {
    return sendVerify(null).then(function () { return true; }, function (err) { throw wrap(err); });
  }

  /* refresh() — verification happens in a different tab or a different app,
     so the only way this tab learns about it is to ask. */
  function refresh() {
    return need().then(function () {
      if (!curUser || !curUser.reload) return null;
      return curUser.reload().then(function () {
        try { curUser = auth.currentUser || curUser; } catch (e) {}
        fanout(changeFns, curUser);
        return curUser;
      });
    }, function () { return curUser; }).catch(function () { return curUser; });
  }

  /* ======================================================================
     Google.

     Popup first where a popup can work, redirect everywhere else. The list
     below is not exhaustive and does not need to be: an unrecognised webview
     tries the popup, fails, and lands in the same redirect within a second.
     ====================================================================== */

  var INAPP = /FBAN|FBAV|FB_IAB|Instagram|Messenger|TikTok|musical_ly|BytedanceWebview|Snapchat|Pinterest|LinkedInApp|Line\/|Twitter|GSA\/|MicroMessenger|WebView|; wv\)/i;

  function inAppWebview() {
    try {
      var s = ua();
      if (!s) return false;
      if (INAPP.test(s)) return true;
      /* An iOS browser that is neither Safari nor a known third party is a
         WKWebView inside somebody's app. */
      if (/iPhone|iPad|iPod/i.test(s) && !/Safari/i.test(s)) return true;
      return false;
    } catch (e) { return false; }
  }

  function popupUsable() {
    try {
      if (inAppWebview()) return false;
      if (typeof W.open !== "function") return false;
      return true;
    } catch (e) { return false; }
  }

  var REDIRECT_ON = {
    "auth/popup-blocked": 1,
    "auth/popup-closed-by-user": 0,          /* they chose to close it; do not bounce them */
    "auth/cancelled-popup-request": 0,
    "auth/operation-not-supported-in-this-environment": 1,
    "auth/web-storage-unsupported": 1,
    "auth/internal-error": 1,
    "auth/network-request-failed": 0
  };

  function googleProvider(s) {
    var p = new s.GoogleAuthProvider();
    try { p.setCustomParameters({ prompt: "select_account" }); } catch (e) {}
    return p;
  }

  function goRedirect(s, p) {
    ssSet(RKEY, "1");
    return Promise.resolve(s.signInWithRedirect(auth, p)).then(function () {
      return { redirecting: true, user: null };
    }, function (err) {
      ssDel(RKEY);
      throw wrap(err);
    });
  }

  /* Resolves either with { user } or with { redirecting:true }. A caller that
     gets `redirecting` should say so and stop — the page is leaving. */
  function signInGoogle() {
    return need().then(function (s) {
      var p = googleProvider(s);
      if (!popupUsable()) return goRedirect(s, p);
      return Promise.resolve(s.signInWithPopup(auth, p)).then(function (cred) {
        return { redirecting: false, user: (cred && cred.user) || null };
      }, function (err) {
        var c = codeOf(err);
        if (REDIRECT_ON[c] === 1 || !c) return goRedirect(s, p);
        throw wrap(err);
      });
    });
  }

  /* ======================================================================
     Phone.

     Invisible reCAPTCHA. The container must exist and must stay on the page;
     if the caller did not give us one, we make one, because a missing element
     is not a reason to fail a sign-in.
     ====================================================================== */

  function recaptchaHost(containerId) {
    var d = doc$();
    if (!d) return null;
    var el = null;
    try { if (containerId) el = d.getElementById(containerId); } catch (e) {}
    if (el) return el;
    try {
      el = d.createElement("div");
      el.id = containerId || "fbu-recaptcha";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
      if (d.body) d.body.appendChild(el);
      return el;
    } catch (e) { return null; }
  }

  function clearVerifier() {
    try { if (verifier && verifier.clear) verifier.clear(); } catch (e) {}
    verifier = null;
  }

  /* normalisePhone — E.164 or nothing. A bare ten-digit number is assumed to
     be North American because that is where this season's readers are; every
     other shape has to carry its own country code, and the error copy says
     so rather than guessing wrong. */
  function normalisePhone(s) {
    try {
      var v = String(s == null ? "" : s).replace(/[^\d+]/g, "");
      if (!v) return "";
      if (v.charAt(0) === "+") {
        return (v.length >= 8 && v.length <= 17) ? v : "";
      }
      if (v.length === 10) return "+1" + v;
      if (v.length === 11 && v.charAt(0) === "1") return "+" + v;
      return "";
    } catch (e) { return ""; }
  }

  function startPhone(number, containerId) {
    var e164 = normalisePhone(number);
    if (!e164) return Promise.reject(fail("fb/bad-phone"));
    return need().then(function (s) {
      if (!s.RecaptchaVerifier) throw fail("fb/no-recaptcha");
      var host = recaptchaHost(containerId);
      if (!host) throw fail("fb/no-recaptcha");
      clearVerifier();
      try {
        verifier = new s.RecaptchaVerifier(auth, host.id || host, { size: "invisible" });
      } catch (e) {
        /* Older signature: (containerOrId, params, auth). Try it before
           giving up, so an SDK version bump cannot silently kill phone. */
        try { verifier = new s.RecaptchaVerifier(host.id || host, { size: "invisible" }, auth); }
        catch (e2) { throw fail("fb/no-recaptcha"); }
      }
      return Promise.resolve(s.signInWithPhoneNumber(auth, e164, verifier));
    }).then(function (cr) {
      phoneHandle = { phone: e164, at: Date.now ? Date.now() : 0, _cr: cr };
      return phoneHandle;
    }, function (err) {
      clearVerifier();
      throw (err && err.friendly) ? err : wrap(err);
    });
  }

  function confirmPhone(handle, code) {
    var h = handle && handle._cr ? handle : phoneHandle;
    var c = "";
    try { c = String(code == null ? "" : code).replace(/[^\d]/g, ""); } catch (e) {}
    if (!h || !h._cr) return Promise.reject(fail("fb/no-code"));
    if (!c) return Promise.reject(fail("auth/missing-verification-code"));
    return Promise.resolve(h._cr.confirm(c)).then(function (cred) {
      clearVerifier();
      phoneHandle = null;
      return (cred && cred.user) || null;
    }, function (err) { throw wrap(err); });
  }

  /* ======================================================================
     Signing out.

     This signs out of Firebase and nothing else. FBP's reading memory and
     FBS's saves are per-browser and are deliberately left alone — see
     AUTH.md. Wiping them here would mean that lending someone your phone for
     one story costs you fifty-one stories' worth of place-keeping.
     ====================================================================== */

  function doSignOut() {
    stopWatch();
    clearVerifier();
    phoneHandle = null;
    ssDel(RKEY);
    return need().then(function (s) {
      return s.signOut(auth);
    }).then(function () {
      return true;
    }, function () {
      /* Even a failed sign-out must leave the page in a signed-out state as
         far as this file is concerned, or the reader taps a button that
         appears to do nothing. */
      onUser(null);
      return true;
    });
  }

  /* ======================================================================
     The public surface. Everything below is ES5-callable.
     ====================================================================== */

  function user() { return curUser; }
  function uid() { try { return curUser ? String(curUser.uid) : ""; } catch (e) { return ""; } }
  function email$() {
    try {
      if (!curUser) return "";
      return String(curUser.email || "");
    } catch (e) { return ""; }
  }
  function phone$() {
    try { return curUser ? String(curUser.phoneNumber || "") : ""; } catch (e) { return ""; }
  }
  function name$() {
    try { return curUser ? String(curUser.displayName || "") : ""; } catch (e) { return ""; }
  }
  function emailVerified() {
    try { return !!(curUser && curUser.emailVerified); } catch (e) { return false; }
  }
  function signedIn() { return !!curUser; }

  var PROVIDER_NAME = {
    "password": "Email and password",
    "google.com": "Google",
    "phone": "Phone number",
    "apple.com": "Apple"
  };

  function providers() {
    var out = [];
    try {
      var d = curUser && curUser.providerData;
      if (d && d.length) {
        for (var i = 0; i < d.length; i++) {
          var id = d[i] && d[i].providerId ? String(d[i].providerId) : "";
          if (id && out.indexOf(id) === -1) out.push(id);
        }
      }
    } catch (e) {}
    return out;
  }
  function provider() { var p = providers(); return p.length ? p[0] : ""; }
  function providerText() {
    var p = providers(), bits = [], i;
    for (i = 0; i < p.length; i++) bits.push(PROVIDER_NAME[p[i]] || "Another sign-in");
    return bits.length ? bits.join(" and ") : "Email and password";
  }

  function onChange(fn) {
    if (typeof fn !== "function") return noop;
    changeFns.push(fn);
    if (authKnown) { try { fn(curUser); } catch (e) {} }
    return drop(changeFns, fn);
  }
  function onPremium(fn) {
    if (typeof fn !== "function") return noop;
    premFns.push(fn);
    if (billingKnown) { try { fn(premiumFlag); } catch (e) {} }
    return drop(premFns, fn);
  }
  function onSubscription(fn) {
    if (typeof fn !== "function") return noop;
    subFns.push(fn);
    if (billingKnown) { try { fn(subNow); } catch (e) {} }
    return drop(subFns, fn);
  }

  function ready() { return readyD.promise; }
  function onReady(fn) {
    if (typeof fn !== "function") return;
    try { readyD.promise.then(function (u) { try { fn(u); } catch (e) {} }); }
    catch (e) { try { fn(null); } catch (e2) {} }
  }
  /* The one that survives onUser() replacing billingD underneath it. */
  function billingReady() { return billingFirstD.promise; }

  var FBU = {
    __factbox: true,

    /* lifecycle */
    ready: ready, onReady: onReady, known: function () { return authKnown; },
    billingReady: billingReady,
    ok: function () { return !!sdk && !!auth; },
    unavailable: function () { return !!loadErr || (authKnown && !sdk); },
    timedOut: function () { return timedOut; },

    /* who */
    user: user, uid: uid, email: email$, phone: phone$, name: name$,
    emailVerified: emailVerified, signedIn: signedIn,
    provider: provider, providers: providers, providerText: providerText,
    onChange: onChange, refresh: refresh,

    /* email and password */
    signUpEmail: signUpEmail, signInEmail: signInEmail,
    resetPassword: resetPassword, resendVerification: resendVerification,

    /* google */
    signInGoogle: signInGoogle,
    redirectPending: function () { return ssGet(RKEY) === "1"; },
    redirectError: function () { return redirectErr; },
    inAppWebview: inAppWebview,

    /* phone */
    startPhone: startPhone, confirmPhone: confirmPhone,
    normalisePhone: normalisePhone,

    /* out */
    signOut: doSignOut,

    /* money — one flag, live */
    premium: function () { return premiumFlag; },
    admin: function () { return adminFlag; },
    onPremium: onPremium,
    subscription: function () { return subNow; },
    onSubscription: onSubscription,
    billingKnown: function () { return billingKnown; },
    PORTAL: "https://billing.stripe.com/p/login/aFa9AS5OVgeL7zp4823F600",

    /* copy */
    message: message,

    /* meta */
    SDK_VERSION: SDK_VERSION
  };

  try { W.FBU = FBU; } catch (e) {}

  /* Consumers that loaded before this module ran get told once. Anything
     that runs on DOMContentLoaded or later will already see window.FBU,
     because a module script is deferred and runs before that event. */
  try {
    if (W.document && W.CustomEvent) {
      W.dispatchEvent(new W.CustomEvent("fbu-ready", { detail: FBU }));
    } else if (W.dispatchEvent && W.document && W.document.createEvent) {
      var ev = W.document.createEvent("Event");
      ev.initEvent("fbu-ready", false, false);
      W.dispatchEvent(ev);
    }
  } catch (e) {}

  try { boot(); } catch (e) {
    loadErr = e; sdkD.resolve(null); settleReady(); settleBilling();
  }
})();
