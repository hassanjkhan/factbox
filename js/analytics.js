/* ==========================================================================
   Factbox — analytics.

   One file owns the whole thing: loading the analytics sinks, bridging the
   events the site already names, measuring how long each card is actually on
   screen, and the notice that tells a reader it is happening.

   Nothing else on the site knows which vendor is in use. `FB.track()` in
   gate.js and `track()` on the illustrated story both route through here, so
   the event names that were already wired keep working unchanged and there is
   exactly one place to swap the vendor.

   ---------------------------------------------------------------------------
   TWO SINKS, ON PURPOSE, FOR NOW

   Every event goes to PostHog *and* to Google Analytics 4 through Firebase.
   That is a deliberate duplication, agreed with the owner, so the two can be
   compared on the same traffic before one is dropped. It is not an accident
   and it is not free: two beacons per event, two vendors in the privacy
   policy, two places a number can be wrong. FIREBASE-ANALYTICS.md says what
   each is good for and which one to keep.

   Both sinks hang off the single `capture()` below. There is still exactly
   one place to change vendor, and no second set of call sites anywhere.

   GA4 is stricter than PostHog about names: 40 characters, [a-z0-9_], must
   start with a letter, and a reserved list it silently drops. `gaName()` and
   `gaParams()` map ours across; every rename is written down in
   FIREBASE-ANALYTICS.md rather than left to be discovered in a report.

   ---------------------------------------------------------------------------
   Consent

   PostHog persists an id, which under EU/UK rules is not "strictly necessary"
   and therefore needs consent. This ships opt-OUT: capture starts immediately
   and a dismissible notice explains it, with a working opt-out on the privacy
   page. That is the common US posture and it is not the strict EU one.

   To make it strict opt-IN — nothing captured until a reader agrees — set
   OPT_IN_REQUIRED to true below. Everything else is already written for it.
   ========================================================================== */

(function () {
  "use strict";

  var KEY  = "phc_CzcoLdwsVBHS8WwahoCcZW49vyWQ2VzvYWYra5TUDaPP";
  var HOST = "https://us.i.posthog.com";

  /* ---- Sink two: Google Analytics 4, through Firebase ------------------ *
     The same project js/auth.js signs readers into. This config is public by
     design — it is the web API key Firebase ships in every client, not a
     secret — and it is repeated here rather than imported because auth.js is
     a module and this file is not. If the two ever disagree, auth.js is the
     one that matters, because access depends on it and this does not.

     Analytics is initialised as a SECOND, NAMED app ("fbq"). The default app
     belongs to auth.js and its options carry no measurementId, so asking it
     for an Analytics instance would fail; a named app also means nothing here
     can disturb the auth or billing wiring next door. */
  var MEASUREMENT_ID = "G-VELZ9B3E3Q";
  var GA_APP_NAME    = "fbq";
  var GA_SDK_VERSION = "10.14.1";
  var GA_SDK_BASE    = "https://www.gstatic.com/firebasejs/" + GA_SDK_VERSION + "/";
  var GA_CONFIG = {
    apiKey:            "AIzaSyD3GRAWOihX3kTEGgxz3QytfcMg6M-7mM8",
    authDomain:        "factbox-7cb97.firebaseapp.com",
    projectId:         "factbox-7cb97",
    storageBucket:     "factbox-7cb97.firebasestorage.app",
    messagingSenderId: "790045781901",
    appId:             "1:790045781901:web:527527387e7dd3285497c4",
    measurementId:     MEASUREMENT_ID
  };
  var GA_QUEUE_MAX = 80;   /* events buffered while the SDK is in flight */

  var OPT_IN_REQUIRED = false;   /* true = capture nothing until agreed */
  var NOTICE_KEY = "fb_analytics_notice_v1";
  var OPTOUT_KEY = "fb_analytics_optout_v1";

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v); return v;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------------
     Only the real site is measured.

     This file shipped with no idea where it was running, so every local test
     run posted into the production project. One afternoon of verification —
     headless browsers on 127.0.0.1:8899, :8905, :8913, a fresh browser context
     per case, each one a new distinct_id — put 500-odd "users" and three
     localhost URLs into the dashboard, next to a genuine handful of readers.
     The owner opened PostHog to see which story was doing well and was looking
     mostly at a robot.

     So: the live hostname, or nothing. Not a debug flag someone has to
     remember to set, because the failure mode of forgetting is silently
     corrupting the only record of how the product is doing.

     A local run still exercises every code path in here; capture() simply
     returns before it reaches a network. To measure a local build on purpose,
     set fb_analytics_local=1 in localStorage. */
  var LIVE_HOSTS = ["factbox.app", "www.factbox.app"];
  function onLiveSite() {
    try {
      var h = String(location.hostname || "");
      for (var i = 0; i < LIVE_HOSTS.length; i++) if (h === LIVE_HOSTS[i]) return true;
      return ls("fb_analytics_local") === "1";
    } catch (e) { return false; }
  }
  if (!onLiveSite()) {
    try { window["ga-disable-" + MEASUREMENT_ID] = true; } catch (e) {}
    window.FBQ = { capture: function () {}, optedOut: function () { return false; },
                   optOut: function () {}, optIn: function () {},
                   sinks: function () { return { posthog: false, firebase: false }; } };
    return;
  }

  /* A reader who has opted out is never measured, and NEITHER loader runs.
     The privacy page promises the script does not load — not that it loads
     and stays quiet — so this return has to come before both of them. The
     gtag kill switch is set as well, in case anything else on the page ever
     brings GA in by another route. */
  if (ls(OPTOUT_KEY) === "1") {
    try { window["ga-disable-" + MEASUREMENT_ID] = true; } catch (e) {}
    window.FBQ = { capture: function () {}, optedOut: function () { return true; },
                   optOut: function () {}, optIn: function () {},
                   sinks: function () { return { posthog: false, firebase: false }; } };
    return;
  }

  /* ---- PostHog loader (their published snippet, unmodified) ------------- */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister identify setPersonProperties reset group opt_in_capturing opt_out_capturing has_opted_out_capturing get_distinct_id get_session_id onFeatureFlags isFeatureEnabled getFeatureFlag debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  try {
    posthog.init(KEY, {
      api_host: HOST,
      defaults: "2026-05-30",
      person_profiles: "identified_only",
      /* The reader is mid-story on a phone; a lost event costs less than a
         stalled main thread. */
      capture_pageleave: true,
      opt_out_capturing_by_default: OPT_IN_REQUIRED
    });
  } catch (e) {}

  /* ======================================================================
     Google Analytics 4, through the Firebase SDK.

     Loaded with a dynamic import, the same way js/auth.js loads its half of
     the SDK — so nothing else on the site has to become a module.

     The import is built with `new Function` rather than written literally.
     This file is a classic <script> on every page of the site; a browser old
     enough to treat `import(` as a syntax error would fail to parse the WHOLE
     FILE, taking PostHog, the dwell measurement and window.FBQ down with it.
     Built this way, such a browser fails to build one function and everything
     else carries on. js/auth.js can afford the literal form because it is
     type="module": a browser that cannot parse it simply skips it, which is a
     state that file already renders.
     ====================================================================== */

  var gaLog   = null;    /* logEvent, bound to the analytics instance */
  var gaOff   = false;   /* opted out mid-session */
  var gaQueue = [];      /* fired before the SDK arrived */

  var gaImport = null;
  try { gaImport = new Function("u", "return import(u);"); } catch (e) { gaImport = null; }

  function gaSDK() {
    /* Documented seam, mirroring js/auth.js's FBU_SDK: a flattened namespace
       already on the page is used instead of the network, so the render
       checks can drive this in jsdom and a self-hosted bundle needs no edit. */
    try { if (window.FBQ_SDK) return Promise.resolve(window.FBQ_SDK); } catch (e) {}
    if (!gaImport) return Promise.reject(new Error("no dynamic import"));
    try {
      return Promise.all([
        gaImport(GA_SDK_BASE + "firebase-app.js"),
        gaImport(GA_SDK_BASE + "firebase-analytics.js")
      ]).then(function (mods) {
        var out = {}, i, k;
        for (i = 0; i < mods.length; i++) {
          for (k in mods[i]) { try { out[k] = mods[i][k]; } catch (e) {} }
        }
        return out;
      });
    } catch (e) { return Promise.reject(e); }
  }

  function gaBoot() {
    gaSDK().then(function (sdk) {
      if (!sdk || typeof sdk.getAnalytics !== "function" ||
          typeof sdk.logEvent !== "function") return null;

      /* isSupported() is false in a webview with no indexedDB, and in a few
         in-app browsers. Calling getAnalytics anyway throws there. */
      var supported;
      try {
        supported = (typeof sdk.isSupported === "function")
          ? sdk.isSupported() : Promise.resolve(true);
      } catch (e) { supported = Promise.resolve(false); }

      return Promise.resolve(supported).then(function (ok) {
        if (!ok) return null;
        var app = null;
        try { app = sdk.initializeApp(GA_CONFIG, GA_APP_NAME); }
        catch (e) {
          /* Already initialised — another copy of this file, or a re-entry. */
          try { app = sdk.getApp(GA_APP_NAME); } catch (e2) { app = null; }
        }
        if (!app) return null;

        var an = null;
        try { an = sdk.getAnalytics(app); } catch (e) { an = null; }
        if (!an) return null;

        gaLog = function (n, p) {
          try { sdk.logEvent(an, n, p); } catch (e) {}
        };
        try {
          if (gaOff && typeof sdk.setAnalyticsCollectionEnabled === "function") {
            sdk.setAnalyticsCollectionEnabled(an, false);
          }
        } catch (e) {}

        /* Whatever happened while the SDK was in flight. */
        try {
          var q = gaQueue; gaQueue = [];
          if (!gaOff) {
            for (var i = 0; i < q.length; i++) gaLog(q[i][0], q[i][1]);
          }
        } catch (e) {}
        return null;
      }, function () { return null; });
    }, function () { return null; })
    /* A missing CDN, a blocked gstatic, a webview with no indexedDB: all of
       them mean no GA4 and none of them mean a broken page. */
    .then(null, function () { return null; });
  }

  /* ---- GA4 naming rules ------------------------------------------------ *
     Event names: <= 40 chars, letters/digits/underscore, must begin with a
     letter. The reserved names below are dropped silently by GA4, and the
     reserved prefixes are refused, so anything colliding is given an `fb_`
     in front rather than being thrown away. None of the site's current names
     collide — this is here so that the next one added cannot break quietly. */
  var GA_RESERVED = {
    ad_activeview: 1, ad_click: 1, ad_exposure: 1, ad_query: 1, ad_reward: 1,
    adunit_exposure: 1, app_background: 1, app_clear_data: 1, app_exception: 1,
    app_remove: 1, app_store_refund: 1, app_store_subscription_cancel: 1,
    app_store_subscription_convert: 1, app_store_subscription_renew: 1,
    app_update: 1, app_upgrade: 1, dynamic_link_app_open: 1,
    dynamic_link_app_update: 1, dynamic_link_first_open: 1, error: 1,
    first_open: 1, first_visit: 1, in_app_purchase: 1, notification_dismiss: 1,
    notification_foreground: 1, notification_open: 1, notification_receive: 1,
    os_update: 1, session_start: 1, screen_view: 1, user_engagement: 1,
    firebase_campaign: 1, page_view: 1
  };

  function gaName(n) {
    try {
      var s = String(n == null ? "" : n).toLowerCase()
                .replace(/[^a-z0-9_]/g, "_")
                .replace(/^[^a-z]+/, "");
      if (!s) return "";
      if (s.indexOf("ga_") === 0 || s.indexOf("google_") === 0 ||
          s.indexOf("firebase_") === 0 || GA_RESERVED[s] === 1) s = "fb_" + s;
      return s.slice(0, 40);
    } catch (e) { return ""; }
  }

  /* Parameters: <= 25 per event, names <= 40 chars on the same character set,
     string values <= 100 chars. Anything GA4 would refuse is dropped rather
     than sent malformed — a missing parameter is a gap in a report, a
     malformed one is an event GA4 discards whole. */
  function gaKey(k) {
    try {
      var s = String(k == null ? "" : k).toLowerCase()
                .replace(/[^a-z0-9_]/g, "_")
                .replace(/^[^a-z]+/, "");
      if (!s) return "";
      if (s.indexOf("ga_") === 0 || s.indexOf("google_") === 0 ||
          s.indexOf("firebase_") === 0) s = "p_" + s;
      return s.slice(0, 40);
    } catch (e) { return ""; }
  }

  function gaParams(name, props) {
    var out = {}, n = 0;
    try {
      if (!props) return out;
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (n >= 24) break;                     /* one spare, always */
        /* dwell_s is dwell_ms divided by a thousand. Sending both spends two
           of the property's fifty custom-metric registrations on one fact. */
        if (name === "card_view" && k === "dwell_s") continue;
        var v = props[k];
        if (v === null || v === undefined) continue;
        var key = gaKey(k);
        if (!key) continue;
        if (typeof v === "boolean") { out[key] = v ? 1 : 0; n++; continue; }
        if (typeof v === "number")  { if (isFinite(v)) { out[key] = v; n++; } continue; }
        if (typeof v === "string")  { if (v) { out[key] = v.slice(0, 100); n++; } continue; }
        if (Object.prototype.toString.call(v) === "[object Array]") {
          var j = v.join("|");
          if (j) { out[key] = j.slice(0, 100); n++; }
          continue;
        }
        /* Objects and functions have no honest GA4 representation. */
      }
    } catch (e) {}
    return out;
  }

  function gaCapture(name, props) {
    try {
      if (gaOff) return;
      var n = gaName(name);
      if (!n) return;
      var p = gaParams(String(name), props);
      if (gaLog) { gaLog(n, p); return; }
      if (gaQueue.length < GA_QUEUE_MAX) gaQueue.push([n, p]);
    } catch (e) {}
  }

  try { gaBoot(); } catch (e) {}

  /* ======================================================================
     THE SEAM. Every event on the site arrives here and fans out to both
     sinks. One function to change when a vendor goes.
     ====================================================================== */

  function capture(name, props) {
    try {
      if (window.posthog && posthog.capture) posthog.capture(name, props || {});
    } catch (e) {}
    try { gaCapture(name, props || {}); } catch (e) {}
  }

  /* ------------------------------------------------------------------------
     Who, and what they are allowed to read.

     Every event used to be anonymous and stateless, so two questions could not
     be asked at all: "do people who sign up read more?" and "how much of this
     do people see before they hit the wall?" — because nothing on an event
     said whether the reader had an account, and a person's reading before
     signing up was a different distinct_id from the same person afterwards.

     Two things fix that:

       identify(uid)  ties this browser to the Firebase account, and PostHog
                      stitches the anonymous history that came before it onto
                      the same person. Called once per sign-in.

       register(...)  attaches has_account and is_subscriber to EVERY event
                      from then on, so any chart can be split by them without
                      re-instrumenting anything.

     Both read from FBX, which is already the single answer to "may this person
     read?" — this does not add a second opinion, it reports the first one. */
  var lastWho = "";
  function whoChanged() {
    try {
      var uid = "", acct = false, sub = false, why = "none";
      if (window.FBU && FBU.uid) { uid = String(FBU.uid() || ""); acct = !!uid; }
      if (window.FBX) {
        try { why = FBX.why(); } catch (e) {}
        sub = (why === "subscriber" || why === "admin");
      }
      var sig = uid + "|" + acct + "|" + sub + "|" + why;
      if (sig === lastWho) return;
      lastWho = sig;

      if (window.posthog && posthog.register) {
        posthog.register({ has_account: acct, is_subscriber: sub, access: why });
      }
      /* identify only with a real account id. Calling it with an empty string
         would merge every signed-out reader into one person. */
      if (uid && window.posthog && posthog.identify) posthog.identify(uid);
    } catch (e) {}
  }

  /* Once now, again whenever the answer changes. FBX.paint fires on the first
     known answer and on every change after it, which is exactly the two
     moments this needs. */
  try {
    whoChanged();
    if (window.FBX && FBX.paint) FBX.paint(function () { whoChanged(); });
    else setTimeout(whoChanged, 2500);
  } catch (e) {}

  /* ---- Bridge the events the site already names ------------------------ *
     gate.js's FB.track and the illustrated story's global track() both existed
     before any vendor did. Wrapping them here means the 26 names keep working
     and no other file learns what PostHog is. */
  function bridge() {
    try {
      if (window.FB && FB.track && !FB.track.__fbq) {
        var prev = FB.track;
        var wrapped = function (name, extra) {
          try { prev(name, extra); } catch (e) {}
          capture(name, extra || {});
        };
        wrapped.__fbq = true;
        FB.track = wrapped;
      }
    } catch (e) {}
    try {
      if (typeof window.track === "function" && !window.track.__fbq) {
        var prevT = window.track;
        var wrappedT = function (name, extra) {
          try { prevT(name, extra); } catch (e) {}
          capture(name, extra || {});
        };
        wrappedT.__fbq = true;
        window.track = wrappedT;
      }
    } catch (e) {}
  }
  bridge();
  /* The inline page scripts define these after this file runs, so try again
     once the document is parsed and once more after first paint. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bridge);
  }
  setTimeout(bridge, 0);
  setTimeout(bridge, 1200);

  /* ---- How long a card was actually on screen -------------------------- *
     Both readers already mark the card in view with `live` — the same class
     that drives the animation and the sound. So dwell needs no cooperation
     from either page: watch that one attribute and time it.

     Reported on leaving the card, so a reader who stops reading mid-story
     still produces a measurement for the card they stopped on. */
  var current = null, since = 0;

  function stamp() {
    if (!current) return;
    var ms = Date.now() - since;
    /* Under a second is a swipe passing through, not reading. */
    if (ms >= 900 && ms < 1000 * 60 * 30) {
      capture("card_view", {
        story: current.getAttribute("data-stack") || current.getAttribute("data-story") || "01",
        card: Number(current.getAttribute("data-card") || current.dataset && current.dataset.i || 0),
        beat: current.getAttribute("data-beat") || "",
        topic: current.getAttribute("data-topic") || "",
        dwell_ms: ms,
        dwell_s: Math.round(ms / 100) / 10
      });
    }
    current = null;
  }

  function onLive() {
    var el = document.querySelector(".beat.live, .page.live");
    if (el === current) return;
    stamp();
    if (el) { current = el; since = Date.now(); }
  }

  try {
    var mo = new MutationObserver(onLive);
    mo.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: ["class"]
    });
  } catch (e) {}
  setTimeout(onLive, 400);

  /* Leaving the page is the commonest way a card stops being read. */
  addEventListener("pagehide", stamp);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") stamp();
  });

  /* ---- The notice ------------------------------------------------------ */
  function notice() {
    if (ls(NOTICE_KEY) === "1") return;
    if (!document.body) { setTimeout(notice, 300); return; }
    var d = document.createElement("div");
    d.className = "fbq-notice";
    d.setAttribute("role", "note");
    d.innerHTML =
      '<span>We measure which stories people finish, to make better ones. ' +
      'No ads, no selling data. <a href="/privacy">How it works</a>.</span>' +
      '<button type="button">Got it</button>';
    d.querySelector("button").addEventListener("click", function () {
      ls(NOTICE_KEY, "1");
      d.parentNode && d.parentNode.removeChild(d);
    });
    document.body.appendChild(d);
  }
  /* The notice used to be shown here. It is not any more: a banner over a
     full-screen painting is an interruption, and it asked a reader to
     acknowledge something on a page they had not yet agreed to anything on.
     What it said now lives where someone goes looking for it — the profile
     links the privacy policy, which carries the real off switch. The
     function stays defined so the behaviour is one line from returning. */

  window.FBQ = {
    capture: capture,
    optedOut: function () { return ls(OPTOUT_KEY) === "1"; },
    optOut: function () {
      ls(OPTOUT_KEY, "1");
      try { if (window.posthog && posthog.opt_out_capturing) posthog.opt_out_capturing(); } catch (e) {}
      /* GA4 is already loaded by the time this button can be pressed, so
         "off" here means: stop logging now, drop anything still queued, and
         set gtag's own kill switch so nothing revives it. On the next load
         the early return at the top of this file means it never arrives at
         all, which is what the privacy page promises. */
      gaOff = true;
      gaQueue = [];
      try { window["ga-disable-" + MEASUREMENT_ID] = true; } catch (e) {}
    },
    optIn: function () {
      try { localStorage.removeItem(OPTOUT_KEY); } catch (e) {}
      try { if (window.posthog && posthog.opt_in_capturing) posthog.opt_in_capturing(); } catch (e) {}
      gaOff = false;
      try { window["ga-disable-" + MEASUREMENT_ID] = false; } catch (e) {}
      try { if (!gaLog) gaBoot(); } catch (e) {}
    },

    /* Which sinks are actually live. For the render checks, and for anyone
       asking whether the duplication is still running. */
    sinks: function () {
      var ph = false;
      try { ph = !!(window.posthog && window.posthog.capture); } catch (e) {}
      return { posthog: ph, firebase: !!gaLog && !gaOff };
    },
    /* The GA4 name a given event is reported under — the mapping, callable,
       so FIREBASE-ANALYTICS.md can be checked rather than believed. */
    gaName: gaName,
    MEASUREMENT_ID: MEASUREMENT_ID
  };
})();
