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

  /* ---- Where PostHog is reached --------------------------------------- *
     Two answers, tried in that order.

     FIRST-PARTY. Blocker lists match PostHog by hostname — *.i.posthog.com
     and *-assets.i.posthog.com are on EasyPrivacy, on uBlock's default set,
     in Brave, and in the lists the Instagram and TikTok in-app browsers
     carry. PostHog's own dashboard puts the resulting loss at 10-25% of
     events, and nearly every reader here arrives through one of those two
     in-app browsers on a phone, so that is the case to design for rather
     than the average. Requests to factbox.app/ink/... match no list, because
     no list can block them without blocking the site.

     PROXY_PATH is deliberately not /analytics, /tracking or /posthog —
     PostHog's own docs say those get matched on the path instead. It is
     served by the Cloudflare Worker in cloudflare/posthog-proxy.js, which
     forwards /ink/static/* and /ink/array/* to the asset host and everything
     else to the ingestion host. Change the path here and change it there.

     Built from location.origin rather than hardcoded, so it is correct on
     both factbox.app and www.factbox.app with one Worker per route and no
     cross-origin request from either.

     DIRECT, if the proxy does not answer. A proxy that quietly swallows
     every event is worse than the blocking it was meant to fix: blocked
     analytics loses a known 10-25%, a broken proxy loses 100% and looks
     exactly like "nobody visited today". So the loader below watches the
     first script load and falls back to PostHog's own hosts if it fails. */
  var PROXY_PATH = "/ink";
  var HOST       = "https://us.i.posthog.com";        /* direct ingestion  */
  var ASSET_HOST = "https://us-assets.i.posthog.com"; /* direct assets     */

  /* posthog-js derives its dashboard links from api_host by string
     replacement (".i.posthog.com" -> ".posthog.com"). Through the proxy that
     replacement no longer matches and every link would point at
     factbox.app/ink/project/..., which does not exist. ui_host is the
     documented answer. Set unconditionally: for the direct host it is
     byte-identical to what the replacement produces, so it changes nothing
     there. */
  var UI_HOST = "https://us.posthog.com";

  /* How long to let the proxy's array.js be in flight before giving up on it.
     Generous on purpose: a blocked or missing path fails instantly through
     the script's error event, so this timer only ever covers a hang, and a
     phone on a bad connection must not be mistaken for a broken proxy.
     Events fired meanwhile queue on the snippet stub and are replayed. */
  var PROXY_WAIT_MS = 8000;

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

  /* ---- Which build a report came from ---------------------------------- *
     `client_error` carries this so a spike can be pinned to a deploy instead
     of to a day. It is a hand-set literal and it is the ONE thing in this file
     that is not self-maintaining, so it is worth being blunt about:

       THIS SITE HAS NO BUILD STEP. The .js and .html files are served raw off
       GitHub Pages at the same URLs forever, and there is nothing in a
       browser — not a filename hash, not an ETag, not a header a script may
       read — that changes when a commit lands. There is no honest way to
       derive a release id at runtime. So it is written down, or it does not
       exist.

     Bump it in the same commit that changes site behaviour. A stale value is
     a wrong answer, not a missing one, which is why tools/check-analytics.js
     asserts the SHAPE (yyyy-mm-dd plus a letter) rather than pretending it can
     assert the truth of it. If nobody is going to bump it, delete the constant
     and the parameter together — a release field that always says the same
     thing is worse than no release field, because a reader of the dashboard
     believes it. */
  var RELEASE = "2026-09-04a";

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

  /* ---- Start it, on the proxy, with a way back ------------------------- *
     The snippet above inserts <api_host>/static/array.js the moment init() is
     called, and its only failure handling is to null its own private handle.
     So the fallback is built around three facts about array.js 1.425.1, all
     read out of the shipped bundle rather than assumed:

       1. With an api_host that is not a posthog.com host, its request router
          reports region "custom" and routes EVERY path — /static/, /array/
          and ingestion alike — at api_host. That is why the Worker has to
          answer all three, and why nothing else here needs configuring.

       2. On load it walks window.posthog._i and calls init() once per entry.
          init() returns immediately if it has already run ("Re-initializing
          is a no-op"), so the FIRST entry wins. A fallback therefore has to
          REPLACE _i, not append to it.

       3. That same walk is what replays the calls queued on the stub. So
          init() must be called before the script is loaded, not after, or
          everything captured during the load is dropped on the floor.

     Hence: init on the proxy now, watch that one script element, and if it
     fails, rewrite _i and load PostHog's own copy instead. Whichever lands
     first wins; a second array.js arriving later is a complete no-op, because
     its bootstrap runs only while window.posthog is still an array stub. */

  function phConfig(host) {
    return {
      api_host: host,
      ui_host: UI_HOST,
      defaults: "2026-05-30",
      person_profiles: "identified_only",
      /* The reader is mid-story on a phone; a lost event costs less than a
         stalled main thread. */
      capture_pageleave: true,
      opt_out_capturing_by_default: OPT_IN_REQUIRED
    };
  }

  function proxyHost() {
    try {
      if (location.origin) return location.origin + PROXY_PATH;
      return location.protocol + "//" + location.host + PROXY_PATH;
    } catch (e) { return "https://factbox.app" + PROXY_PATH; }
  }

  /* The real SDK sets __loaded on init; the stub never has the property. */
  function phLoaded() {
    try { return !!(window.posthog && window.posthog.__loaded === true); }
    catch (e) { return false; }
  }

  /* Still the un-loaded snippet stub, i.e. _i is an array waiting to be
     walked. Guards the fallback against clobbering a pre-installed
     window.posthog — the seam the render checks use. */
  function phIsStub() {
    try {
      return !!window.posthog &&
             Object.prototype.toString.call(window.posthog._i) === "[object Array]";
    } catch (e) { return false; }
  }

  function phInsert(src, onFail) {
    var s = document.createElement("script");
    s.type = "text/javascript";
    s.crossOrigin = "anonymous";
    s.async = true;
    s.src = src;
    if (onFail) s.onerror = onFail;
    try {
      var f = document.getElementsByTagName("script")[0];
      if (f && f.parentNode) { f.parentNode.insertBefore(s, f); return s; }
    } catch (e) {}
    try { (document.head || document.documentElement).appendChild(s); return s; }
    catch (e) { return null; }
  }

  var phVia  = "";      /* "proxy" | "direct" | "" once anything is loaded  */
  var phTried = false;  /* the fallback runs at most once                   */

  function phFallback() {
    if (phTried || phLoaded() || !phIsStub()) return;
    phTried = true;
    try { window.posthog._i = [[KEY, phConfig(HOST), "posthog"]]; }
    catch (e) { return; }
    phVia = "direct";
    phInsert(ASSET_HOST + "/static/array.js", function () { phVia = ""; });
  }

  var PH_PROXY = proxyHost();
  try {
    posthog.init(KEY, phConfig(PH_PROXY));
    phVia = "proxy";
  } catch (e) {}

  /* Find the element the snippet just inserted — it did so synchronously,
     inside that init() — and watch it. addEventListener rather than .onerror,
     so the snippet's own handler is left intact. */
  try {
    var phSrc = PH_PROXY + "/static/array.js";
    var phEl  = null, phAll = document.getElementsByTagName("script"), phI;
    for (phI = phAll.length - 1; phI >= 0; phI--) {
      if (String(phAll[phI].src || "") === phSrc) { phEl = phAll[phI]; break; }
    }
    if (phEl && phEl.addEventListener) {
      /* A 404 from GitHub Pages — the Worker route missing or misspelled —
         and a blocked request both arrive here. */
      phEl.addEventListener("error", function () { phFallback(); }, false);
      /* 200 with something that is not the SDK: the script "loads" fine and
         never fires error. Its bootstrap is synchronous, so by this event
         __loaded is either true or never coming. */
      phEl.addEventListener("load", function () {
        if (!phLoaded()) phFallback();
      }, false);
    } else if (!phEl) {
      /* init threw, or the snippet was already satisfied. */
      phFallback();
    }
    /* Neither event fires for a request that simply hangs. */
    setTimeout(function () { if (!phLoaded()) phFallback(); }, PROXY_WAIT_MS);
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
    /* `stack_open` is fired by read.html and by the three composed story pages
       and means "the deck is on screen". story_time below starts its clock on
       it rather than asking those four files to call something new — two of
       them are generated and must not be hand-edited. Watching the seam is
       how this file already learns about every other event. */
    try { if (name === "stack_open") storyOpen(props); } catch (e) {}
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
      storyCards++;      /* what story_time reports as `cards` */
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


  /* ======================================================================
     SITE-WIDE COVERAGE.

     Everything below is new instrumentation, and all of it lives here rather
     than in eleven page scripts, for two reasons:

       1. This file is the only one loaded by every page. Six pages — the home
          page, /explore, /library, /start, /support and /credits — had no
          analytics call of any kind in them, and three more (/story,
          /cleopatra, /firststory) are GENERATED from read.html and must not be
          hand-edited. A listener installed here covers all of them, including
          the generated three, without touching a single one of those files.

       2. FIREBASE-ANALYTICS.md's whole point is that there is one seam.
          Everything here goes through capture() — the same function FB.track
          is bridged into — so both sinks get it and there is still no second
          set of call sites anywhere.

     GA4's limits are hard and it drops what breaks them SILENTLY, so:

       * Event names are literals. There is no `click_<id>`, no `view_<page>`.
         GA4 charges a report against a distinct name and an app stream caps
         them at 500; a name built from a DOM id is an unbounded set. The
         detail goes in PARAMETERS, which is what parameters are for.
       * A name is <= 40 characters, [a-z0-9_], starts with a letter, and is
         not on GA_RESERVED above. `page_view` and `screen_view` ARE reserved,
         which is why the page event below is `page_open` — a reserved name
         would be silently renamed to `fb_page_view` for GA4 only, and the two
         sinks would then disagree about what the event is called.
       * Parameter names are <= 40 characters and values are clipped to 100
         HERE, not just in gaParams(), so PostHog and GA4 store the same string
         rather than a long one and a truncated one.
       * The registration budget is the real constraint (50 event-scoped custom
         dimensions, 50 metrics). The site carried 20 parameter names; these
         additions bring 8 more — page, control, cards, q, question, answer,
         from_ms, answers — for 28 in total. Existing names are reused wherever
         the meaning matches: `stack` for a story id, `from` for a provenance,
         `plan`, `why`, `step`, `dwell_ms`.
     ====================================================================== */

  var CLIP = 100;   /* GA4's cap on a string parameter value */

  function clip(v, n) {
    try {
      var s = String(v == null ? "" : v);
      return s.length > n ? s.slice(0, n) : s;
    } catch (e) { return ""; }
  }

  /* A slug that cannot be anything but [a-z0-9_], because a parameter VALUE
     has no character rule but a report is unreadable without one. */
  function slug(v, n) {
    try {
      var s = String(v == null ? "" : v).toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "");
      return s.slice(0, n || 40);
    } catch (e) { return ""; }
  }

  /* ---- Which page this is ---------------------------------------------- *
     One event name, a `page` parameter. `/`, `/index.html` and `/index` are
     one page ("home"); `/read` and `/read.html` are one page ("read"). The
     query string is deliberately dropped: read.html?s=26 would otherwise put
     51 values in a dimension where `stack_open` already carries the story id
     properly. */
  function pageName() {
    try {
      var p = String(location.pathname || "/").replace(/\/+$/, "");
      var i = p.lastIndexOf("/");
      if (i > -1) p = p.slice(i + 1);
      p = p.replace(/\.html?$/i, "");
      if (!p || p === "index") return "home";
      return slug(p, 40) || "home";
    } catch (e) { return "unknown"; }
  }
  var PAGE = pageName();

  capture("page_open", { page: PAGE });

  /* ---- Every meaningful control, once ----------------------------------- *
     ONE delegated listener on the document, not 102 wired handlers. It is
     registered in the capture phase so a control whose own handler calls
     stopPropagation is still counted, and it does four things and no others:
     read attributes, build two strings, call capture(), return. It never
     calls preventDefault, never touches the event, never reads the value of
     an input, and cannot throw into the handler that follows it.

     WHAT IS NOT SENT. Nothing typed. This reads `data-fbt`, `id`, `name`,
     `data-k`, the element's own static label and its class — all of them site
     copy written in the repo. It never reads `value`, never reads an
     <input>/<textarea>/<select>, and deliberately never reads `aria-label`,
     because js/library.js templates a story title into one and the next
     person to do that may template something else.

     WHAT IS NOT COUNTED. A control that already sends its own named event.
     Sending ui_click alongside it would double-count the same tap and break
     every funnel built on the specific name. Each matcher below names the
     event the control already sends. */
  /* WHAT BELONGS ON THESE LISTS, AND WHAT DOES NOT. The test is whether the
     named event fires from the SAME TAP, UNCONDITIONALLY. If it does, ui_click
     is a second count of one tap and the control is skipped. If the named
     event is conditional — it fires only when a promise resolves — then the
     two are different facts and BOTH are wanted: ui_click counts the attempt
     and the named event counts the success, and the pair is a funnel.

     So #au-go, #au-google, #au-out and #st-out are deliberately NOT here.
     signin_email, signup_email, signin_google and signout all fire inside a
     .then(); skipping their buttons would throw away every failed sign-in,
     which is the half of "making accounts" that says why it is not working.

     #st-billing IS here: settings.html fires billing_portal on the same tap
     with nothing in front of it. subscription.html's four portal links were
     given data-fbt="-" for exactly this and this one was missed, so it has
     been counting one tap twice for as long as both have existed.

     .jn-yn is here for the same reason: join.html's three yes/no questions
     already send join_plan_answer{n, yes} as the first line of answerPhase(),
     which carries WHICH WAY they answered — something ui_click could never
     say, because both halves of a question sit inside one #jn-q-N and so
     report the same control name. Verified in Chrome: one tap on Yes sent
     ui_click{control:"jn_q_0"} and join_plan_answer{n:"1",yes:"1"}. The
     ui_click was the useless half of the pair as well as the duplicate one. */
  var SKIP_IDS   = { pay: 1, "jn-buy": 1, "st-billing": 1 };
  var SKIP_CLASS = ["fbs-save", "ec-go", "jn-yn"];
  var HOPS = 6;

  function skipControl(n) {
    try {
      var t = n, hops = 0, a;
      while (t && t.getAttribute && hops++ < HOPS) {
        /* Explicit opt-out, for anything this file cannot recognise. */
        a = t.getAttribute("data-fbt");
        if (a === "-") return true;
        if (a) return false;                       /* an explicit name wins */
        if (t.id && SKIP_IDS[t.id] === 1) return true;       /* subscribe_click / checkout_start / billing_portal */
        if (t.getAttribute("data-unsave")) return true;      /* library_unsave */
        /* Every answer option in /start and /join carries data-k, and every
           one of them already sends start_answer, join_draw, join_relate,
           join_time, join_streak or join_plan_pick. */
        if (t.getAttribute("data-k")) return true;
        var c = " " + String(t.className || "") + " ";
        for (var i = 0; i < SKIP_CLASS.length; i++) {
          if (c.indexOf(" " + SKIP_CLASS[i] + " ") !== -1) return true;   /* save_add/remove, rec_click, join_plan_answer */
        }
        t = t.parentNode;
      }
    } catch (e) {}
    return false;
  }

  /* The control's name, from the first of these that answers. */
  function controlName(n) {
    try {
      var t = n, hops = 0, v;
      while (t && t.getAttribute && hops++ < HOPS) {
        v = t.getAttribute("data-fbt");    if (v && v !== "-") return slug(v, 40);
        v = t.id;                          if (v) return slug(v, 40);
        v = t.getAttribute("name");        if (v) return slug(v, 40);
        v = t.getAttribute("data-k");      if (v) return slug(v, 40);
        t = t.parentNode;
      }
      /* No identifier anywhere. Fall back to the button's own words — site
         copy, in the repo, never anything a reader typed. */
      var tag = String(n.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") {
        v = slug(n.textContent, 40);
        if (v) return v;
      }
      v = slug(String(n.className || "").split(/\s+/)[0], 40);
      return v || tag || "control";
    } catch (e) { return "control"; }
  }

  /* A tappable ancestor, or nothing. A tap lands on the <b> inside a button. */
  function controlOf(n) {
    try {
      var t = n, hops = 0, tag, role;
      while (t && t.getAttribute && hops++ < HOPS) {
        tag = String(t.tagName || "").toLowerCase();
        role = t.getAttribute("role");
        if (tag === "button" || tag === "summary" ||
            (tag === "a" && t.getAttribute("href")) ||
            (tag === "input" && /^(submit|button|checkbox|radio)$/i.test(t.getAttribute("type") || "")) ||
            role === "button" || role === "radio" || role === "tab" || role === "switch") return t;
        t = t.parentNode;
      }
    } catch (e) {}
    return null;
  }

  /* A toggle reports which way it was pointing when it was pressed.

     WHY THIS EXISTS. "Are people using the audio button and then muting the
     music or playing it?" could not be answered. The reader's sound control
     sends ui_click and nothing else, so a mute and an unmute were the same
     row in the same report, and the count of them together answered neither
     half of the question.

     WHY aria-pressed AND NOT A SPECIAL CASE FOR THE SOUND BUTTON. aria-pressed
     is the platform's own word for "this control is a toggle and here is its
     state" — it is already on the sound button and on the save bookmark
     because both had to be reachable from a screen reader, not because anyone
     was thinking about analytics. Reading it is therefore free, it is correct
     for every toggle this site ever adds, and it needs no cooperation from
     any page. A branch on className would have been a special case that goes
     stale the first time the button is restyled.

     WHAT THE VALUE MEANS, EXACTLY. This listener is registered in the CAPTURE
     phase, so it runs before the control's own handler flips anything. The
     value is therefore the state the control was in AT THE MOMENT IT WAS
     PRESSED, which is a thing that was observed, not a thing inferred about
     what happened next:

         was_on true   the sound was on and they pressed it  -> a mute
         was_on false  the sound was off and they pressed it -> a play

     It is deliberately NOT "the state it ended up in". That would be a guess
     about a handler this file does not own: a control that is disabled, that
     throws, or that opens a dialog instead of toggling would be reported as
     having changed when it did not. Wrong in a way nobody would ever notice
     is the one kind of wrong this file is not allowed to be.

     A control with no aria-pressed sends no was_on at all, rather than a
     false — absent means "not a toggle", false means "a toggle that was off",
     and collapsing those two would put every button on the site into the
     "was off" bucket. */
  function toggleState(n) {
    try {
      var v = n.getAttribute("aria-pressed");
      if (v === "true") return true;
      if (v === "false") return false;
    } catch (e) {}
    return null;                       /* not a toggle */
  }

  try {
    document.addEventListener("click", function (ev) {
      try {
        var n = controlOf(ev && ev.target);
        if (!n) return;
        if (skipControl(n)) return;
        var props = { page: PAGE, control: clip(controlName(n), CLIP) };
        var was = toggleState(n);
        if (was !== null) props.was_on = was;
        capture("ui_click", props);
      } catch (e) {}
      /* No preventDefault, no return value, nothing that can delay the tap. */
    }, true);
  } catch (e) {}

  /* ---- How long a story actually held someone -------------------------- *
     card_view above measures one card. This measures the whole visit: from
     the moment the deck renders (`stack_open`, which read.html and the three
     composed pages already fire) to the moment the reader goes away.

     ENGAGED time, not wall-clock: the clock stops while the tab is hidden, so
     a phone left face-down in a pocket for an hour does not report an hour of
     reading. Reported on pagehide and on the tab going hidden, which is how
     stack_dropoff already reports, and exactly once — the same `reported`
     flag that event uses, for the same reason. */
  var story = "", storyAt = 0, storyMs = 0, storyCards = 0, storyDone = false;

  function storyOpen(props) {
    try {
      story = clip((props && props.stack) || "", 24);
      storyAt = Date.now();
      storyMs = 0; storyCards = 0; storyDone = false;
    } catch (e) {}
  }

  function storyPause() {
    try {
      if (!story || !storyAt) return;
      var d = Date.now() - storyAt;
      if (d > 0 && d < 1000 * 60 * 60 * 6) storyMs += d;
      storyAt = 0;
    } catch (e) {}
  }

  function storyResume() {
    try { if (story && !storyAt) storyAt = Date.now(); } catch (e) {}
  }

  function storyReport() {
    try {
      if (!story || storyDone) return;
      storyDone = true;
      storyPause();
      if (storyMs < 500) return;      /* opened and gone: not a reading */
      capture("story_time", { stack: story, dwell_ms: storyMs, cards: storyCards });
    } catch (e) {}
  }

  /* ---- Coming back from Stripe ------------------------------------------ *
     The one genuinely silent step in the money path. `checkout_start` fires on
     /join, the reader leaves for Stripe, and the success redirect lands on
     ?unlocked=1 — which js/gate.js's claim() strips out of the URL with
     replaceState at parse time, long before this file runs. So there was no
     event anywhere for "the payment worked", which is the only step in the
     funnel that pays.

     This reads the answer rather than the URL, so the stripping does not
     matter: js/progress.js already records how access arrived (stripe |
     restore | local) and mints a token for it. First time this browser sees a
     given token, that is a new unlock. Read-only — nothing here decides,
     grants or changes access, and the marker is this file's own key.

     The token itself is NEVER sent: it can carry the Stripe session id. Only
     its first eight characters are kept, in localStorage, as a local
     "have I already reported this one" marker. */
  var SEEN_KEY = "fb_access_seen_v1";

  function accessCheck() {
    try {
      if (!window.FBP || !FBP.unlocked || !FBP.unlocked()) return;
      var src = "", tok = "";
      try { src = String((FBP.source && FBP.source()) || ""); } catch (e) {}
      try { tok = String((FBP.token && FBP.token()) || ""); } catch (e) {}
      var sig = slug(src, 12) + "|" + clip(tok, 8);
      if (ls(SEEN_KEY) === sig) return;
      ls(SEEN_KEY, sig);
      capture("access_gained", { from: slug(src, 20) || "unknown", page: PAGE });
    } catch (e) {}
  }
  accessCheck();
  try { if (window.FBX && FBX.paint) FBX.paint(function () { accessCheck(); }); } catch (e) {}
  setTimeout(accessCheck, 3000);

  /* One place for the two leave paths, so the last card is stamped before the
     story total that counts it. */
  function leaving() {
    stamp();
    storyReport();
  }
  addEventListener("pagehide", leaving);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") leaving();
    else storyResume();
  });

  /* ======================================================================
     WHEN THE SITE BREAKS IN SOMEBODY ELSE'S BROWSER.

     Nothing listened on window.onerror or unhandledrejection before this, on
     any page, ever. A reader whose story threw on card three saw a dead deck
     and left, and the only trace it left on the dashboard was a stack_dropoff
     that looked exactly like boredom. Those two are the same shape in every
     report the site has, and they need completely different fixes.

     ONE EVENT NAME, `client_error`, with five parameters:

         message   what threw, scrubbed and clipped (see below)
         source    the file, as a path. Never a full URL, never a query
         line      the line number, a number
         page      the same page name every other event here carries
         release   the RELEASE constant at the top of this file

     There is no `stack` parameter, on purpose. A stack is many lines of many
     URLs and this site puts secrets in URLs — ?restore=<token> is a working
     key to a paid season, and Stripe's success redirect carries a session_id.
     One rejected fetch inside a promise chain that was handed a restore link
     would put that token in an analytics event, in two vendors, forever. So
     the stack is used LOCALLY, to find a file and a line, and then dropped;
     what leaves is a path and an integer.

     ---------------------------------------------------------------------
     THE RATE LIMIT IS THE POINT.

     A render loop is not a hypothetical here: both readers repaint on a
     MutationObserver and on scroll, so a throw inside one of those is a throw
     per frame — sixty a second, for as long as the reader stays. Unlimited,
     one phone on one story would post tens of thousands of events, drown the
     genuine traffic in the same charts the owner is trying to read, and be
     billed for by two vendors. An error report that makes the dashboard
     useless has done more damage than the bug it was reporting.

     Two limits, both counted per page load, both arithmetic — no timers, no
     clock, nothing that can be wrong on a phone whose clock is wrong:

       1. THE SAME ERROR IS SENT ONCE. Signature is message + source + line.
          A loop throws the identical error every frame, so the loop costs
          exactly one event.
       2. AT MOST ERR_MAX EVENTS, whatever they are. A loop throwing a
          different error every frame is rarer and nastier, and this is the
          ceiling that makes the worst case a known, small number rather than
          an unbounded one. Eight is enough to see a cascade start; nobody
          debugs from the ninth.

     So one page load cannot cost more than ERR_MAX events. That is a bound
     that can be stated, not a rate that has to be believed.

     ---------------------------------------------------------------------
     NOT WHILE THE PAGE IS LEAVING.

     A navigation cancels every request in flight, and the rejections that
     produces ("Failed to fetch", "The operation was aborted") are not faults
     — they are what leaving a page looks like from inside it. Reporting them
     fills the report with the site working correctly. `pagehide` fires before
     the page goes, and this file already listens to it, so from that moment
     nothing more is sent.

     pagehide is also how a page enters the back/forward cache, and a page can
     come back out of it. `pageshow` clears the flag, or a reader who taps
     Back would have a live page that has silently stopped reporting for the
     rest of its life. No `unload` and no `beforeunload` listener is added
     here: either one would disqualify every page on this site from bfcache,
     which js/gate.js depends on and says so.

     ---------------------------------------------------------------------
     IT CANNOT BECOME THE BUG.

     addEventListener, not window.onerror — assigning onerror would silently
     replace whatever the page had, and js/scenes.js already listens for
     `error` its own way. Nothing here calls preventDefault, so the browser
     still logs to the console exactly as before, and a devtools breakpoint
     still stops where it always did. `sending` guards re-entry, so a throw
     inside the reporting path cannot report itself into a loop. And the whole
     handler is wrapped: a failure to report an error must not be an error.
     ====================================================================== */

  var ERR_MAX  = 8;         /* hard ceiling on client_error, per page load */
  var errSeen  = {};        /* signature -> 1, so one loop costs one event */
  var errSent  = 0;
  var sending  = false;
  var leftPage = false;     /* set on pagehide, cleared on pageshow        */

  /* Anything that could be a credential, taken out before the string is sent.
     Order matters: URLs first, so their query strings are gone before the
     long-run rule below gets a chance to look at what was in them. */
  function scrub(v) {
    try {
      var s = String(v == null ? "" : v);
      /* A URL keeps its origin and path and loses its query and fragment.
         ?restore=<token> and ?session_id=<id> both live in a query. */
      s = s.replace(/(https?:\/\/[^\s'"()]*?)[?#][^\s'"()]*/gi, "$1");
      /* user:pass@host, which some fetch errors echo back verbatim. */
      s = s.replace(/(https?:\/\/)[^\s'"()@\/]*@/gi, "$1");
      /* An email address is PII wherever it turns up, and a thrown auth error
         is entirely capable of quoting the one that was just typed. */
      s = s.replace(/[^\s'"<>()]+@[^\s'"<>()]+\.[A-Za-z]{2,}/g, "<email>");
      /* A long unbroken run of token characters is a token, an id or a hash.
         Nothing written in English gets to twenty-four characters without a
         space, a hyphen at a word break or a full stop, so this cannot eat a
         real sentence; it does eat a Firebase uid, a Stripe id and a restore
         token that arrived by some route the rules above did not cover. */
      s = s.replace(/[A-Za-z0-9_-]{24,}/g, "<id>");
      return s;
    } catch (e) { return ""; }
  }

  /* A file, not a URL: the path, with the origin, the query and the fragment
     gone. "/js/read.js" rather than
     "https://factbox.app/js/read.js?restore=<token>". */
  function fileOf(v) {
    try {
      var s = String(v == null ? "" : v);
      if (!s) return "";
      s = s.split("#")[0].split("?")[0];
      s = s.replace(/^https?:\/\/[^\/]+/i, "");
      return clip(s, 60);
    } catch (e) { return ""; }
  }

  /* A rejection has no source or line of its own. Its stack has both, so the
     stack is read HERE and thrown away: the first frame that names a file and
     a line wins, and only the path and the integer leave this function. */
  function fromStack(stk) {
    var out = { source: "", line: 0 };
    try {
      var m = String(stk || "").match(/((?:https?:\/\/|\/)[^\s'"()]+?):(\d+):\d+/);
      if (m) { out.source = fileOf(m[1]); out.line = Number(m[2]) || 0; }
    } catch (e) {}
    return out;
  }

  function report(message, source, line) {
    if (sending) return;                 /* no reporting the reporter       */
    sending = true;
    try {
      if (leftPage) return;              /* the page is going; not a fault  */
      if (errSent >= ERR_MAX) return;

      var msg = clip(scrub(message), CLIP);
      if (!msg) return;                  /* nothing to say is not an error  */
      var src = fileOf(source);
      var ln  = Number(line) || 0;

      var sig = msg + "|" + src + "|" + ln;
      if (errSeen[sig] === 1) return;    /* the loop, paid for once         */
      errSeen[sig] = 1;
      errSent++;

      capture("client_error", {
        message: msg, source: src, line: ln, page: PAGE, release: RELEASE
      });
    } catch (e) {
      /* Deliberately silent. A failure to report an error is not an error. */
    } finally { sending = false; }
  }

  /* An uncaught exception. `false` for the phase: a window listener that is
     not in the capture phase does not see resource load failures, and a
     missing image or a blocked font is not a client error — it is a 404, and
     it would be the loudest thing in the report. */
  try {
    addEventListener("error", function (ev) {
      try {
        /* A resource error is a plain Event with no message. Belt and braces:
           the phase above should already have excluded it. */
        if (!ev || typeof ev.message !== "string" || !ev.message) return;
        report(ev.message, ev.filename, ev.lineno);
      } catch (e) {}
      /* No preventDefault: the console still gets it, and so does devtools. */
    }, false);
  } catch (e) {}

  /* A promise nobody caught. `reason` is whatever was thrown, which is an
     Error most of the time and absolutely anything the rest of it. */
  try {
    addEventListener("unhandledrejection", function (ev) {
      try {
        var r = ev && ev.reason, msg = "", at = { source: "", line: 0 };
        if (r && typeof r === "object") {
          msg = String(r.message || r.name || "");
          at = fromStack(r.stack);
        }
        if (!msg) { try { msg = String(r); } catch (e2) { msg = ""; } }
        if (!msg || msg === "[object Object]") msg = "rejected with no reason";
        /* Marked in the message rather than in a sixth parameter: a rejection
           and a throw are different bugs, and the person who reads this is
           reading the message anyway. Parameters are the scarce thing here —
           GA4 registers fifty of them for the whole property. */
        report("[rejection] " + msg, at.source, at.line);
      } catch (e) {}
    }, false);
  } catch (e) {}

  addEventListener("pagehide", function () { leftPage = true; });
  /* Out of the back/forward cache and live again. Without this, one Back tap
     leaves the reader on a page that will never report anything again. */
  addEventListener("pageshow", function () { leftPage = false; });

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
    MEASUREMENT_ID: MEASUREMENT_ID,

    /* Which PostHog host actually served the SDK: "proxy" while the
       first-party path is working, "direct" once it has fallen back, ""
       if neither arrived. sinks() deliberately still answers the older
       question — is there something to capture into — so nothing that
       checks it changes meaning. */
    phVia: function () { return phLoaded() ? phVia : ""; },
    phHost: function () {
      if (!phLoaded()) return "";
      return phVia === "direct" ? HOST : PH_PROXY;
    }
  };
})();
