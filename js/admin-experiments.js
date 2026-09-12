/* ==========================================================================
   Factbox — the reel experiments board, live, for the two people who post.
   Exposes: window.FBE

   WHAT THIS IS. Two people post a few reels a week and decide what worked
   from memory. This file is the storage under one surface that makes an
   experiment get RUN and get READ: what we think, what we tried, what the
   numbers said at a fixed age, and what we decided because of it.

       admin_experiments/{id}              one experiment
       admin_experiments/{id}/reels/{rid}  one reel posted under it
       admin_experiments/{id}/comments/{cid}  what the two of them said

   It owns the DATA and nothing else. `admin/experiments.html` owns every
   pixel; this file never touches the DOM and has no opinion about charts.
   Written to the same contract as js/admin-tasks.js — same guard, same
   dynamic import, same live onSnapshot, same field-level merges, same
   "every write stamps itself" — because these two surfaces sit next to each
   other and a second idiom is the one that drifts.

   THE ONE RULE THE WHOLE THING IS FOR: A REEL IS MEASURED AT 72 HOURS OLD.

     Never on a calendar date. Reels have long tails, so comparing a
     two-day-old video against a six-hour-old one measures AGE, not quality,
     and every conclusion drawn from it is noise wearing a number's clothes.

     This file stores `postedAt` and `measuredAt` as two separate instants
     rather than storing "the numbers" and a date, precisely so the age at
     measurement is RECOVERABLE and a too-early reading can be shown as
     too early instead of being silently averaged in with the honest ones.
     MEASURE_HOURS is published below; the page derives from it and nothing
     here throws a reading away.

   WHAT IS OPTIONAL, AND WHY ALMOST EVERYTHING IS. An experiment board that
   takes four minutes a reel to fill in is an experiment board nobody fills
   in, and then it is worth less than the memory it replaced. So a reel needs
   a STORY NAME and nothing else: no URL, no platform, no metrics, no
   measurement. A half-filled row is enormously better than a row nobody
   types. The rules below enforce exactly that one required field.

   SOURCE, AND THE AUTOMATED PATH THAT DOES NOT EXIST YET. Every reel carries
   `source`, and today it is always "manual" because every number on this
   board is typed off the Insights screen by hand. It is written NOW, on every
   write, so that the day an Instagram or TikTok fetch lands it can write
   `source: "instagram"` into the same collection with the same shape and no
   migration — and, more to the point, so a chart can tell a typed number from
   a fetched one instead of assuming. firestore.rules already lists the three
   values; adding the fetch is a client change, not a schema change.

   ES5 only, like every shipped file here except js/auth.js. The one modern
   thing is the dynamic import that fetches the Firebase SDK, and it is built
   with `new Function` for the reason js/profile-sync.js gives: a browser too
   old to parse `import(` then fails to build one function instead of failing
   to parse the whole file.
   ========================================================================== */

(function () {
  "use strict";

  var W = (typeof window !== "undefined" && window) ? window : null;
  if (!W) { return; }
  /* NEVER INSTALL TWICE, and this is load-bearing beyond tidiness: the render
     check in tools/check-experiments.js installs a STUB window.FBE before this
     script runs, so that the page can be driven with six experiments and ten
     reels without an admin login. Same guard as FBT. */
  if (W.FBE && W.FBE.__factbox) { return; }

  /* ======================================================================
     Configuration. Same project and same public config as js/auth.js and
     js/admin-tasks.js — this is the web API key Firebase publishes in every
     client, not a secret. Repeated rather than imported because js/auth.js
     is a module and this file is not; if the two disagree, js/auth.js is
     right.
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

  var EXPS     = "admin_experiments";
  var REELS    = "reels";
  var COMMENTS = "comments";

  /* THE FIXED AGE. Published rather than kept private because the page prints
     it in about nine sentences and a second copy of the number is how a UI
     ends up saying "72 hours" over a rule that checks 48. */
  var MEASURE_HOURS = 72;

  /* THE DEADLINE, AND IT IS A REAL ONE — THERE IS NO BACKFILL.

     TikTok stops serving reach, watch time, retention and impression sources
     for a video that has had no activity for SEVEN DAYS, and stops updating
     post data at all after a year. Instagram has never exposed a retention
     curve through any API and never will; that series is typed off the
     Insights screen by hand or it does not exist.

     So a reel whose numbers are not written down within days of posting has
     those numbers GONE, permanently, for everybody. Nothing on this board may
     be built on the assumption that somebody can catch up at the weekend —
     not a "fill this in later" affordance, not a quiet empty cell, not a
     placeholder. An unmeasured reel past this age is a deadline that has been
     missed, and the page is required to say so in those words.

     Published so the page bands an age into the three states that matter and
     cannot invent a fourth:

         under MEASURE_HOURS      too early — the numbers are still moving
         up to AT_RISK_DAYS       ready — write them down
         past AT_RISK_DAYS        at risk — TikTok may already have dropped them */
  var AT_RISK_DAYS = 7;

  /* The allowed values, in one place, because firestore.rules holds the same
     lists and a client that invents a fourth value is simply denied. */
  var STATUSES  = ["idea", "running", "ended"];
  var PLATFORMS = ["instagram", "tiktok", "other"];
  /* "none" rather than "" so that a reel that is not part of a pair has a
     value somebody chose, and the A/B chart can say "3 reels are not in the
     pair" instead of quietly dropping them. */
  var VARIANTS  = ["a", "b", "none"];
  /* WHERE A NUMBER CAME FROM. Everything on this board is "manual" today —
     typed off a phone screen by a person — and "api" is here so that a writer
     which is not a person needs no migration to say so. "instagram" and
     "tiktok" name the platform when that ever matters. NOTHING FETCHES
     ANYTHING; this is a field, not a plan. */
  var SOURCES   = ["manual", "api", "instagram", "tiktok"];

  /* EVERY NUMBER A REEL CAN CARRY, in the order the Insights screen shows
     them, because these are typed off that screen top to bottom and a form in
     a different order is a form that gets typed wrong.

       k     the field name, which is also the firestore.rules key
       label what a human calls it
       unit  "n" a count, "s" seconds, "%" a percentage 0-100
       max   the ceiling the rules enforce — generous, and there to refuse a
             pasted phone number, not to second-guess a good week

     `primary` on an experiment is one of these keys and nothing else. */
  var METRICS = [
    { k: "views",       label: "Views",              unit: "n", max: 1e10 },
    { k: "reach",       label: "Reach",              unit: "n", max: 1e10 },
    { k: "likes",       label: "Likes",              unit: "n", max: 1e10 },
    { k: "comments",    label: "Comments",           unit: "n", max: 1e10 },
    { k: "shares",      label: "Shares",             unit: "n", max: 1e10 },
    { k: "saves",       label: "Saves",              unit: "n", max: 1e10 },
    { k: "profileTaps", label: "Profile taps",       unit: "n", max: 1e10 },
    { k: "avgWatch",    label: "Avg watch time",     unit: "s", max: 86400 },
    { k: "completion",  label: "Completion",         unit: "%", max: 100 },
    { k: "threeSec",    label: "3-second view rate", unit: "%", max: 100 }
  ];

  function metricKeys() {
    var out = [], i;
    for (i = 0; i < METRICS.length; i++) out.push(METRICS[i].k);
    return out;
  }
  var METRIC_KEYS = metricKeys();

  var MAX_TITLE   = 120;
  var MAX_LINE    = 240;    /* the one-line description on a card */
  var MAX_PROSE   = 600;    /* hypothesis, trying, decision, inspiration, outcome */
  var MAX_STORY   = 120;
  var MAX_URL     = 500;
  var MAX_COVER   = 1000;   /* a Storage download URL carries a token and is long */
  var MAX_PATH    = 300;
  var MAX_COMMENT = 1000;
  var MAX_NAME    = 60;
  /* THE WRITTEN READ. Longer than the other prose fields because it is the
     only field on the board whose job is to say what a result MEANS and what
     to try next, and a paragraph that has to fit in 600 characters gets
     written as a headline instead of as a thought. */
  var MAX_ANALYSIS = 1200;
  var MAX_LINKS   = 8;
  var MAX_FORMAT  = 24;
  /* A drop-off curve typed off the Insights graph by hand. Forty points is
     far more than anybody will type and is there so a paste cannot put four
     thousand objects in one document. */
  var MAX_RETENTION = 40;

  var BOOT_MS = 12000;

  var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /* ======================================================================
     Small helpers. All ES5, all total — nothing in here throws.
     ====================================================================== */

  function noop() {}
  function isFn(f) { return typeof f === "function"; }
  function has(o, k) {
    try { return Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return false; }
  }

  function str(v, max) {
    var s = "";
    try { s = (v == null) ? "" : String(v); } catch (e) { s = ""; }
    try { s = s.replace(/^\s+|\s+$/g, ""); } catch (e2) {}
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  function oneOf(v, list, fallback) {
    var s = "";
    try { s = String(v == null ? "" : v).toLowerCase(); } catch (e) { s = ""; }
    for (var i = 0; i < list.length; i++) { if (list[i] === s) return s; }
    return fallback;
  }

  function num(v, fallback) {
    var n = Number(v);
    return (typeof n === "number" && isFinite(n)) ? n : fallback;
  }

  /* A METRIC VALUE, or null. null and not 0, and this is the decision the
     whole board rests on: a reel nobody typed a `saves` figure for has no
     saves figure, and writing 0 would put a made-up point on every chart and
     drag every average down. "" and "  " are null too, because that is what
     an empty box hands over. Negatives are refused rather than clamped —
     minus four shares is a typo, and a typo silently turned into 0 is worse
     than a typo refused. */
  function metricVal(v, max) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && !str(v)) return null;
    var n = Number(v);
    if (typeof n !== "number" || !isFinite(n)) return null;
    if (n < 0) return null;
    if (max && n > max) n = max;
    /* Rounded to one decimal: these are typed off a screen that shows at most
       one, and a float with fourteen digits of noise in it prints badly and
       compares worse. */
    return Math.round(n * 10) / 10;
  }

  /* AN INSTANT somebody typed — when a reel went up, when its numbers were
     read. Not a server stamp: both of these are facts about the past and the
     server clock knows nothing about either. Total: a Date, a number of
     milliseconds, an ISO string, a Firestore Timestamp and an empty box all
     go in, and either a Date or null comes out. Null is how "not recorded"
     is spelled, so nothing downstream has to tell absent from 1970. */
  function instant(v) {
    var ms = toMs(v);
    if (!ms) return null;
    var d = new Date(ms);
    if (!isFinite(d.getTime())) return null;
    return d;
  }

  /* A calendar day, or "". Same function, same reasoning and the same UTC
     round trip as isoDay() in js/admin-tasks.js: `endBy` is the day an
     experiment is meant to STOP by, and a day held as a Timestamp prints as
     the day before for anybody west of Greenwich. "2026-02-31" is refused
     here because RE2 in firestore.rules cannot count the days in a month. */
  function isoDay(v) {
    var s = "";
    try { s = (v == null) ? "" : String(v); } catch (e) { return ""; }
    try { s = s.replace(/^\s+|\s+$/g, ""); } catch (e2) { return ""; }
    if (!s) return "";
    var m = DAY_RE.exec(s);
    if (!m) return "";
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!isFinite(y) || !isFinite(mo) || !isFinite(d)) return "";
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (!isFinite(t.getTime())) return "";
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== (mo - 1) || t.getUTCDate() !== d) return "";
    return s;
  }

  function toMs(v) {
    try {
      if (v == null) return 0;
      if (typeof v === "number") return isFinite(v) ? (v > 1e11 ? v : v * 1000) : 0;
      if (typeof v === "string") {
        var p = Date.parse(v);
        return isFinite(p) ? p : 0;
      }
      if (isFn(v.toMillis)) return v.toMillis();
      if (isFn(v.toDate)) { var d = v.toDate(); return d ? d.getTime() : 0; }
      if (isFn(v.getTime)) { var g = v.getTime(); return isFinite(g) ? g : 0; }
      if (typeof v.seconds === "number") return v.seconds * 1000;
      if (typeof v._seconds === "number") return v._seconds * 1000;
    } catch (e) {}
    return 0;
  }

  /* A URL SOMEBODY PASTED IS UNTRUSTED, and this is the only gate it passes
     through before the page is allowed to put it in an href.

     https:// AND NOTHING ELSE. Not http (a reel URL is https on both
     platforms and a mixed-content link would be blocked anyway), and
     emphatically not the schemes that are not locations at all —
     `javascript:`, `data:`, `vbscript:` — because an href is an execution
     surface and a scheme check is the whole of the defence. The test is on
     the value AFTER leading whitespace and control characters are stripped,
     since "\n\tjavascript:alert(1)" is a URL the browser will happily run and
     a naive indexOf("https://") === 0 would let through.

     Returns "" for anything else, and "" is never rendered as a link. */
  function safeUrl(v, max) {
    var s = "";
    try { s = (v == null) ? "" : String(v); } catch (e) { return ""; }
    /* Strip every C0/C1 control character and space anywhere in the prefix —
       browsers ignore them when resolving a scheme, so we must too. */
    try { s = s.replace(/[\u0000-\u001F\u007F]+/g, ""); } catch (e2) {}
    try { s = s.replace(/^[\s\u00A0\u2000-\u200B\uFEFF]+/, ""); } catch (e3) {}
    s = str(s, max || MAX_URL);
    if (s.toLowerCase().indexOf("https://") !== 0) return "";
    if (s.length < 9) return "";     /* "https://" and at least one character */
    return s;
  }

  /* The reference links on an experiment: somebody else's reel that made us
     want to try this. A list of URLs and not of {url, label} objects, for the
     reason firestore.rules says out loud about labels — THESE RULES CANNOT
     CHECK THE ELEMENTS OF A LIST, there is no loop in that language — so the
     smaller the element, the less there is to get wrong. A bare URL also has
     the property that the link text is the destination, which no amount of
     user-authored label text can be made to be. */
  function linkList(v) {
    var raw = [], out = [], seen = {}, i, one;
    if (v == null) return out;
    if (typeof v === "string") { raw = v.split(/[\s,]+/); }
    else if (Object.prototype.toString.call(v) === "[object Array]") { raw = v; }
    else { return out; }
    for (i = 0; i < raw.length; i++) {
      one = safeUrl(raw[i], MAX_URL);
      if (!one || has(seen, one)) continue;
      seen[one] = true;
      out.push(one);
      if (out.length >= MAX_LINKS) break;
    }
    return out;
  }

  /* A FORMAT TAG — "talking-head", "greenscreen", "text-hook". One per reel,
     optional, and normalised exactly the way a task label is (see the long
     note in js/admin-tasks.js): a tag system whose members are "Talking Head",
     "talking head" and "talking-head" is three tag systems that look like one,
     and the chart that answers "which formats have won" would then split one
     winner three ways. */
  function formatTag(v) {
    var t = "";
    try { t = (v == null) ? "" : String(v); } catch (e) { return ""; }
    try {
      t = t.toLowerCase();
      t = t.replace(/[\s_-]+/g, "-");
      t = t.replace(/[^a-z0-9-]+/g, "");
      t = t.replace(/-+/g, "-");
      t = t.replace(/^-+|-+$/g, "");
    } catch (e2) { return ""; }
    if (t.length > MAX_FORMAT) t = t.slice(0, MAX_FORMAT).replace(/-+$/g, "");
    return t;
  }

  /* THE DROP-OFF CURVE, typed off the Insights graph by hand.

     [{ second: n, percentage: n }], sorted by second, de-duplicated on the
     second, capped at MAX_RETENTION.

     THOSE TWO KEY NAMES ARE NOT AN ACCIDENT AND NOT A STYLE CHOICE. TikTok's
     Accounts API returns video_view_retention as an array of exactly
     { second, percentage }. Storing the same two names means that if that
     application is ever approved, the writer that fills this in is a loop that
     copies the array across — not a migration over every reel on the board.
     Instagram will never supply this by any API, so the hand-typed path is
     permanent whatever happens to the other one.

     Accepts an array of objects (second/percentage, or the shorter s/p some
     paste tools emit), an array of [second, percentage] pairs, or the thing a
     human actually does, which is paste lines into a textarea:

         0 100
         1, 92
         3: 74

     Any two numbers on a line are read as second and percent, in that order.
     A line with no numbers is skipped rather than becoming {s:0,p:0} — an
     invented point at the origin is a fabricated finding, and this curve is
     the one chart where a made-up point changes the conclusion.

     firestore.rules can pin that this is a LIST and that it is short. It
     cannot look inside it. That is said in full in the rules file above
     reelShape(); the shape of each point is this function's promise and
     nothing else's. */
  function retentionList(v) {
    var raw = [], out = [], seen = {}, i, one, s, p;
    if (v == null) return out;
    if (typeof v === "string") { raw = v.split(/[\r\n;]+/); }
    else if (Object.prototype.toString.call(v) === "[object Array]") { raw = v; }
    else { return out; }

    for (i = 0; i < raw.length; i++) {
      one = raw[i];
      s = null; p = null;
      if (one && typeof one === "object" && Object.prototype.toString.call(one) !== "[object Array]") {
        s = metricVal(one.second == null ? one.s : one.second, 86400);
        p = metricVal(one.percentage == null
                        ? (one.percent == null ? one.p : one.percent)
                        : one.percentage, 100);
      } else if (Object.prototype.toString.call(one) === "[object Array]") {
        s = metricVal(one[0], 86400);
        p = metricVal(one[1], 100);
      } else {
        var m = null;
        try { m = String(one == null ? "" : one).match(/-?\d+(?:\.\d+)?/g); } catch (e) { m = null; }
        if (!m || m.length < 2) continue;
        s = metricVal(m[0], 86400);
        p = metricVal(m[1], 100);
      }
      if (s === null || p === null) continue;
      if (has(seen, String(s))) continue;
      seen[String(s)] = true;
      out.push({ second: s, percentage: p });
      if (out.length >= MAX_RETENTION) break;
    }
    out.sort(function (a, b) { return a.second - b.second; });
    return out;
  }

  function drop(arr, item) {
    return function () {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === item) { arr.splice(i, 1); return; }
      }
    };
  }

  function later(fn) {
    try { W.setTimeout(fn, 0); } catch (e) { try { fn(); } catch (e2) {} }
  }

  function reject(msg) {
    var e = new Error(msg);
    try { e.fbe = true; } catch (e2) {}
    return Promise.reject(e);
  }

  /* ======================================================================
     The auth layer. Identical to js/admin-tasks.js: js/auth.js is a module
     and therefore deferred, so on a page that loads this file as a classic
     script FBU may not exist yet. The event is the fast path, the poll is
     the belt to its braces.
     ====================================================================== */

  function fbu() {
    try { return (W.FBU && W.FBU.__factbox) ? W.FBU : null; } catch (e) { return null; }
  }

  function whenFBU() {
    var have = fbu();
    if (have) return Promise.resolve(have);
    return new Promise(function (resolve) {
      var done = false, timer = null;
      function finish(v) {
        if (done) return;
        done = true;
        try { if (timer) W.clearInterval(timer); } catch (e) {}
        try { W.removeEventListener("fbu-ready", onEvt); } catch (e2) {}
        resolve(v);
      }
      function onEvt() { var u = fbu(); if (u) finish(u); }
      try { W.addEventListener("fbu-ready", onEvt); } catch (e) {}
      var waited = 0;
      try {
        timer = W.setInterval(function () {
          waited += 120;
          var u = fbu();
          if (u) { finish(u); return; }
          if (waited >= BOOT_MS) finish(null);
        }, 120);
      } catch (e3) { finish(null); }
    });
  }

  /* ======================================================================
     The SDK. Same dynamic import and the same documented seam as
     js/admin-tasks.js (W.FBE_SDK / W.FBT_SDK / W.FBPS_SDK / W.FBU_SDK), so a
     render check can drive every branch without a real ES module.
     ====================================================================== */

  var dynImport = null;
  try { dynImport = new Function("u", "return import(u);"); } catch (e) { dynImport = null; }

  var sdk = null, db = null, loading = null, loadFail = false;

  function loadSDK() {
    try {
      if (W.FBE_SDK) return Promise.resolve(W.FBE_SDK);
      if (W.FBT_SDK) return Promise.resolve(W.FBT_SDK);
      if (W.FBPS_SDK) return Promise.resolve(W.FBPS_SDK);
      if (W.FBU_SDK) return Promise.resolve(W.FBU_SDK);
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
    } catch (e2) { return Promise.reject(e2); }
  }

  function appFor() {
    if (!sdk) return null;
    try { if (isFn(sdk.getApp)) return sdk.getApp(); } catch (e) {}
    try { if (isFn(sdk.initializeApp)) return sdk.initializeApp(CONFIG); } catch (e2) {}
    return null;
  }

  function need() {
    if (db) return Promise.resolve(db);
    if (loadFail) return Promise.reject(new Error("sdk unavailable"));
    if (loading) return loading;
    loading = loadSDK().then(function (mod) {
      sdk = mod || null;
      if (!sdk || !isFn(sdk.doc) || !isFn(sdk.onSnapshot) || !isFn(sdk.collection)) {
        loadFail = true;
        throw new Error("sdk incomplete");
      }
      var app = appFor();
      try { db = sdk.getFirestore(app); } catch (e) { db = null; }
      if (!db) { loadFail = true; throw new Error("no firestore"); }
      return db;
    }, function (e) { loadFail = true; throw e; });
    return loading;
  }

  /* ======================================================================
     ready(). One promise, memoised, that always settles and never rejects.
     Same four answers as FBT, spelled the same way, because admin/index.html
     and both boards already normalise exactly these strings.
     ====================================================================== */

  var readyP = null;
  var state = { ok: false, why: "sdk-failed" };
  var bootUid = "";

  function decide() {
    return whenFBU().then(function (U) {
      if (!U) return { ok: false, why: "sdk-failed" };
      return Promise.resolve(U.ready()).then(function () {
        if (!U.signedIn || !U.signedIn()) return { ok: false, why: "signed-out" };
        return Promise.resolve(U.billingReady()).then(function () {
          if (!isFn(U.admin) || !U.admin()) return { ok: false, why: "not-admin" };
          bootUid = me() ? me().uid : "";
          return need().then(function () { return { ok: true }; },
                            function () { return { ok: false, why: "sdk-failed" }; });
        }, function () { return { ok: false, why: "sdk-failed" }; });
      }, function () { return { ok: false, why: "sdk-failed" }; });
    }, function () { return { ok: false, why: "sdk-failed" }; });
  }

  function ready() {
    if (readyP) return readyP;
    readyP = new Promise(function (resolve) {
      var settled = false;
      function finish(v) {
        if (settled) return;
        settled = true;
        state = v;
        resolve(v);
        if (v.ok) attachAll();
      }
      try { W.setTimeout(function () { finish({ ok: false, why: "sdk-failed" }); }, BOOT_MS + 3000); } catch (e) {}
      try {
        decide().then(function (v) { finish(v || { ok: false, why: "sdk-failed" }); },
                      function () { finish({ ok: false, why: "sdk-failed" }); });
      } catch (e2) { finish({ ok: false, why: "sdk-failed" }); }
    });
    return readyP;
  }

  function watchAuth() {
    var U = fbu();
    if (!U || !isFn(U.onChange)) return;
    try {
      U.onChange(function () {
        var now = "";
        try { var m = me(); now = m ? m.uid : ""; } catch (e) { now = ""; }
        if (now === bootUid) return;
        bootUid = now;
        detachAll();
        readyP = null;
        state = { ok: false, why: "signed-out" };
        ready().then(function (v) { if (!v.ok) fanoutEmpty(); });
      });
    } catch (e2) {}
  }

  /* ======================================================================
     The live reads.

     One onSnapshot per collection per watcher, no orderBy — the list is two
     people's experiments, sorted here, and a composite index per sort the UI
     might want is a migration nobody asked for.

     REELS AND COMMENTS ARE SUBCOLLECTIONS, and the reel case is the one worth
     arguing. Reels could have been an array field on the experiment. They are
     not, for the three reasons js/admin-tasks.js gives for comments, and one
     more that is specific to this board:

       1. The conflict rule here is a FIELD-LEVEL merge, so the unit that can
          be lost is one field. An array of reels IS one field: Kathryn typing
          reel B's numbers while Hassan types reel A's means one array
          overwrites the other and somebody's minute of typing disappears with
          nothing on screen to say so. Two documents cannot collide.
       2. firestore.rules can pin a document's keys with hasOnly() and cannot
          say anything about the elements of a growing array. A reel carries
          ten numbers, two instants and a URL; per-document validation is the
          only way any of that is checked at the boundary.
       3. The board lists six experiments and opens one. A reels array would
          push every number of every reel to both browsers on every snapshot
          of the LIST; the subcollection is listened to only while its
          experiment is open.
       4. A retention series is up to forty points. Reels-as-array would put
          four hundred of them in one 1MB document and would eventually stop
          being a hypothetical.
     ====================================================================== */

  var watchers = [];

  function normExperiment(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      title: str(d.title, MAX_TITLE),
      detail: str(d.detail, MAX_LINE),
      status: oneOf(d.status, STATUSES, "idea"),
      hypothesis: str(d.hypothesis, MAX_PROSE),
      trying: str(d.trying, MAX_PROSE),
      /* The metric every chart in the detail view ranks on. One of
         METRIC_KEYS and nothing else; "views" is the fallback because it is
         the number both platforms show first. */
      metric: oneOf(d.metric, METRIC_KEYS, "views"),
      decision: str(d.decision, MAX_PROSE),
      inspiration: str(d.inspiration, MAX_PROSE),
      links: linkList(d.links),
      /* The day this was PLANNED to stop. A running experiment past it reads
         as EXPIRED on the card — and expired is derived from this and the
         clock, never stored, because a stored fourth status would be wrong at
         midnight and nothing would rewrite it. */
      endBy: isoDay(d.endBy),
      startedAt: toMs(d.startedAt),
      endedAt: toMs(d.endedAt),
      outcome: str(d.outcome, MAX_PROSE),
      order: num(d.order, 0),

      /* ---- LAYER 2: THE WRITTEN READ ----------------------------------
         An OPINION, with a name and a clock on it, and it is stored rather
         than computed for exactly that reason. Everything the page derives
         from the numbers — the hook check, the drop-off, the noise test — is
         arithmetic that is true whenever it is run and needs no author. This
         is the other kind of statement: "this looks like the hook is the
         problem, try opening on the number". It cannot be recomputed, it can
         be wrong, and a reader must be able to see WHO thought it and WHEN,
         which is why the three fields travel together and why the page is
         required to render them apart from the measured lines.

         WRITTEN BY A PERSON TODAY. Nothing here calls an AI API and nothing
         here holds a key — this repo is public, and a key in client
         JavaScript is a key in the world. The shape is the seam: a Cloud
         Function or an agent with a service-account credential can write
         exactly these fields and the page will render the result without a
         line changing, because the page reads the field and never asks where
         the sentence came from. `analysisRequestedAt` is the flag such a job
         would watch. There is no job. */
      analysis: str(d.analysis, MAX_ANALYSIS),
      analysisBy: str(d.analysisBy, 128),
      analysisByName: str(d.analysisByName, MAX_NAME),
      analysisAt: toMs(d.analysisAt),
      analysisRequestedAt: toMs(d.analysisRequestedAt),

      createdAt: toMs(d.createdAt),
      updatedAt: toMs(d.updatedAt),
      updatedBy: str(d.updatedBy, 128),
      createdBy: str(d.createdBy, 128),
      createdByName: str(d.createdByName, MAX_NAME),
      raw: d
    };
  }

  function normReel(id, d) {
    d = d || {};
    var out = {
      id: String(id || ""),
      story: str(d.story, MAX_STORY),
      url: safeUrl(d.url, MAX_URL),
      platform: oneOf(d.platform, PLATFORMS, "instagram"),
      variant: oneOf(d.variant, VARIANTS, "none"),
      format: formatTag(d.format),
      /* Two instants, both typed by a person, both milliseconds or 0 here.
         The gap between them is the age at measurement and it is the only
         thing on this board that decides whether a number may be compared
         with another number. */
      postedAt: toMs(d.postedAt),
      measuredAt: toMs(d.measuredAt),
      cover: safeUrl(d.cover, MAX_COVER),
      coverPath: str(d.coverPath, MAX_PATH),
      retention: retentionList(d.retention),
      source: oneOf(d.source, SOURCES, "manual"),
      /* The same written read, one reel deep — "this one died at the cut".
         Same three stamped fields, same rule that the page renders it as an
         opinion and never where a number is expected. */
      analysis: str(d.analysis, MAX_ANALYSIS),
      analysisBy: str(d.analysisBy, 128),
      analysisByName: str(d.analysisByName, MAX_NAME),
      analysisAt: toMs(d.analysisAt),
      order: num(d.order, 0),
      createdAt: toMs(d.createdAt),
      updatedAt: toMs(d.updatedAt),
      updatedBy: str(d.updatedBy, 128),
      raw: d
    };
    /* null, never 0, for every metric — see metricVal(). A board that turned
       "nobody typed this" into a zero would put a fabricated point on every
       chart it draws. */
    for (var i = 0; i < METRICS.length; i++) {
      out[METRICS[i].k] = metricVal(d[METRICS[i].k], METRICS[i].max);
    }
    return out;
  }

  function normComment(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      text: str(d.text, MAX_COMMENT),
      by: str(d.by, 128),
      byName: str(d.byName, MAX_NAME),
      at: toMs(d.at),
      raw: d
    };
  }

  function sortRows(rows) {
    rows.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return rows;
  }

  function sortComments(rows) {
    rows.sort(function (a, b) {
      var aa = a.at || Infinity, bb = b.at || Infinity;
      if (aa !== bb) return aa - bb;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return rows;
  }

  function normFor(kind, id, d) {
    if (kind === EXPS) return normExperiment(id, d);
    if (kind === REELS) return normReel(id, d);
    return normComment(id, d);
  }

  function readSnap(qs, kind) {
    var rows = [];
    try {
      if (qs && isFn(qs.forEach)) {
        qs.forEach(function (doc) {
          var d = null;
          try { d = doc.data ? doc.data() : null; } catch (e) { d = null; }
          rows.push(normFor(kind, doc.id, d));
        });
      } else if (qs && qs.docs) {
        for (var i = 0; i < qs.docs.length; i++) {
          rows.push(normFor(kind, qs.docs[i].id, qs.docs[i].data()));
        }
      }
    } catch (e2) {}
    return kind === COMMENTS ? sortComments(rows) : sortRows(rows);
  }

  /* Addressed by path SEGMENTS rather than by a string join, so an id with a
     slash in it cannot escape its experiment. */
  function colFor(w) {
    if (w.kind === EXPS) return sdk.collection(db, EXPS);
    if (!w.id) return null;
    return sdk.collection(db, EXPS, w.id, w.kind);
  }

  function call(fn, rows, err) { try { fn(rows, err || null); } catch (e) {} }

  /* THE LAST READ ERROR, kept so the page can tell "nothing here" apart from
     "you were refused". They look identical from a snapshot callback — both
     arrive as no rows — and reporting a refusal as an empty board sends
     somebody reloading a page that was never going to change. It cost exactly
     that once: rules for this collection had not been deployed, and the board
     cheerfully said 0 experiments. */
  var lastErr = null;
  function noteErr(e) {
    var code = (e && (e.code || e.name)) ? String(e.code || e.name) : "";
    lastErr = {
      code: code,
      denied: code.indexOf("permission-denied") >= 0 || code.indexOf("PERMISSION") >= 0,
      message: (e && e.message) ? String(e.message) : "the read was refused"
    };
    return lastErr;
  }

  function attach(w) {
    if (w.unsub || !db || !sdk) return;
    try {
      var col = colFor(w);
      if (!col) { call(w.fn, []); return; }
      w.unsub = sdk.onSnapshot(
        col,
        function (qs) { call(w.fn, readSnap(qs, w.kind)); },
        function () { call(w.fn, []); }
      );
    } catch (e) { call(w.fn, []); }
  }

  function attachAll() { for (var i = 0; i < watchers.length; i++) attach(watchers[i]); }

  function detachAll() {
    for (var i = 0; i < watchers.length; i++) {
      try { if (watchers[i].unsub) watchers[i].unsub(); } catch (e) {}
      watchers[i].unsub = null;
    }
  }

  function fanoutEmpty() {
    for (var i = 0; i < watchers.length; i++) call(watchers[i].fn, []);
  }

  function watch(kind, id, fn) {
    if (!isFn(fn)) return noop;
    var w = { kind: kind, id: str(id, 200), fn: fn, unsub: null };
    watchers.push(w);
    var remove = drop(watchers, w);
    ready().then(function (v) {
      if (v.ok) attach(w);
      else later(function () { call(fn, []); });
    });
    return function () {
      try { if (w.unsub) w.unsub(); } catch (e) {}
      w.unsub = null;
      remove();
    };
  }

  function watchExperiments(fn) { return watch(EXPS, "", fn); }

  /* The reels of ONE experiment, live, for exactly as long as somebody has it
     open. Nothing subscribes to numbers nobody is reading. */
  function watchReels(id, fn) {
    var i = str(id, 200);
    if (!i) { if (isFn(fn)) later(function () { call(fn, []); }); return noop; }
    return watch(REELS, i, fn);
  }

  function watchComments(id, fn) {
    var i = str(id, 200);
    if (!i) { if (isFn(fn)) later(function () { call(fn, []); }); return noop; }
    return watch(COMMENTS, i, fn);
  }

  /* ======================================================================
     Who is writing. Every write stamps this itself, so no caller can forget
     and no caller can lie: firestore.rules refuses any write whose
     `updatedBy` is not the uid on the request's own ID token.
     ====================================================================== */

  function me() {
    var U = fbu();
    if (!U || !isFn(U.uid)) return null;
    var uid = "";
    try { uid = String(U.uid() || ""); } catch (e) { uid = ""; }
    if (!uid) return null;
    var email = "", name = "";
    try { email = String(U.email() || ""); } catch (e2) {}
    try { name = String(U.name() || ""); } catch (e3) {}
    return { uid: uid, email: email, name: name };
  }

  function stamp(payload) {
    var m = me();
    if (!m) return null;
    payload.updatedAt = sdk.serverTimestamp();
    payload.updatedBy = m.uid;
    return payload;
  }

  function whoName() {
    var m = me();
    if (!m) return "";
    return str(m.name || m.email || "", MAX_NAME);
  }

  function guard() {
    return ready().then(function (v) {
      if (!v.ok) throw new Error("not writable: " + v.why);
      if (!me()) throw new Error("not writable: signed-out");
      return true;
    });
  }

  function nowOrder() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  /* ======================================================================
     The writes. Same two rules as the task board:

       1. The caller passes fields a human typed. updatedAt and updatedBy are
          added here, from the server clock and the ID token, never from the
          caller.
       2. Nothing overwrites a whole document — updateDoc with only the fields
          that changed, so typing reel B's saves cannot revert reel A's title.
     ====================================================================== */

  function expFromInput(o, forCreate) {
    o = o || {};
    var out = {};
    function h(k) { return has(o, k); }

    if (forCreate || h("title")) {
      var t = str(o.title, MAX_TITLE);
      if (!t) return { err: "an experiment needs a title" };
      out.title = t;
    }
    if (forCreate || h("detail"))      out.detail      = str(o.detail, MAX_LINE);
    if (forCreate || h("status"))      out.status      = oneOf(o.status, STATUSES, "idea");
    if (forCreate || h("hypothesis"))  out.hypothesis  = str(o.hypothesis, MAX_PROSE);
    if (forCreate || h("trying"))      out.trying      = str(o.trying, MAX_PROSE);
    if (forCreate || h("metric"))      out.metric      = oneOf(o.metric, METRIC_KEYS, "views");
    if (forCreate || h("decision"))    out.decision    = str(o.decision, MAX_PROSE);
    if (forCreate || h("inspiration")) out.inspiration = str(o.inspiration, MAX_PROSE);
    if (forCreate || h("links"))       out.links       = linkList(o.links);
    if (forCreate || h("endBy"))       out.endBy       = isoDay(o.endBy);
    if (forCreate || h("outcome"))     out.outcome     = str(o.outcome, MAX_PROSE);
    if (forCreate || h("order"))       out.order       = num(o.order, forCreate ? nowOrder() : 0);

    /* THE TWO INSTANTS ARE DERIVED, NOT TYPED. `startedAt` is stamped by
       start() and `endedAt` by end(); a caller may CLEAR either with null and
       may not set either to anything else. A board that let you backdate the
       start of an experiment is a board that cannot answer "was this reel
       posted under that experiment or before it". */
    if (forCreate) { out.startedAt = null; out.endedAt = null; }
    if (h("startedAt") && o.startedAt === null) out.startedAt = null;
    if (h("endedAt") && o.endedAt === null) out.endedAt = null;

    /* `analysis` AND ITS THREE STAMPS ARE NOT SETTABLE HERE, deliberately, in
       the same way and for the same reason `doneBy` is not settable on a task:
       a caller that could pass an author and a time alongside a paragraph
       could put Kathryn's name and last Tuesday on a read she never wrote.
       The only door is writeAnalysis() below, which takes the text and stamps
       the rest from the ID token and the server clock. */
    if (forCreate) {
      out.analysis = "";
      out.analysisBy = null;
      out.analysisByName = null;
      out.analysisAt = null;
      out.analysisRequestedAt = null;
      var m = me();
      if (m) { out.createdBy = m.uid; out.createdByName = whoName(); }
    }
    return { ok: out };
  }

  function reelFromInput(o, forCreate) {
    o = o || {};
    var out = {}, i, mk;
    function h(k) { return has(o, k); }

    /* THE ONE REQUIRED FIELD ON THE WHOLE BOARD. Everything else about a reel
       is optional on purpose — see the note at the top of this file. */
    if (forCreate || h("story")) {
      var s = str(o.story, MAX_STORY);
      if (!s) return { err: "a reel needs a story name" };
      out.story = s;
    }
    if (forCreate || h("url"))       out.url       = safeUrl(o.url, MAX_URL);
    if (forCreate || h("platform"))  out.platform  = oneOf(o.platform, PLATFORMS, "instagram");
    if (forCreate || h("variant"))   out.variant   = oneOf(o.variant, VARIANTS, "none");
    if (forCreate || h("format"))    out.format    = formatTag(o.format);
    if (forCreate || h("cover"))     out.cover     = safeUrl(o.cover, MAX_COVER);
    if (forCreate || h("coverPath")) out.coverPath = str(o.coverPath, MAX_PATH);
    if (forCreate || h("retention")) out.retention = retentionList(o.retention);
    if (forCreate || h("order"))     out.order     = num(o.order, forCreate ? nowOrder() : 0);

    if (forCreate || h("postedAt"))   out.postedAt   = instant(o.postedAt);
    if (forCreate || h("measuredAt")) out.measuredAt = instant(o.measuredAt);

    for (i = 0; i < METRICS.length; i++) {
      mk = METRICS[i].k;
      if (forCreate || h(mk)) out[mk] = metricVal(o[mk], METRICS[i].max);
    }

    /* WRITTEN ON EVERY WRITE, and always "manual" today, because every number
       above was typed off a screen by a person. It is here so the automated
       path can be added without a migration and, more usefully, so a chart
       can one day tell a typed number from a fetched one rather than assuming
       they are the same kind of thing. A caller may already pass "instagram"
       or "tiktok"; nothing does yet. */
    if (forCreate || h("source")) out.source = oneOf(o.source, SOURCES, "manual");

    /* Same rule as the experiment: the read is written by writeReelAnalysis()
       and stamped there, never passed in alongside a forged author. */
    if (forCreate) {
      out.analysis = "";
      out.analysisBy = null;
      out.analysisByName = null;
      out.analysisAt = null;
    }
    return { ok: out };
  }

  function addIn(col, payload) {
    payload.createdAt = sdk.serverTimestamp();
    stamp(payload);
    if (isFn(sdk.addDoc)) {
      return Promise.resolve(sdk.addDoc(col, payload)).then(function (ref) {
        return String(ref && ref.id ? ref.id : "");
      });
    }
    var ref2 = sdk.doc(col);
    return Promise.resolve(sdk.setDoc(ref2, payload)).then(function () {
      return String(ref2 && ref2.id ? ref2.id : "");
    });
  }

  function patchRef(ref, payload) {
    stamp(payload);
    return Promise.resolve(sdk.updateDoc(ref, payload)).then(function () { return true; });
  }

  function addExperiment(o) {
    return guard().then(function () {
      var v = expFromInput(o, true);
      if (v.err) throw new Error(v.err);
      return addIn(sdk.collection(db, EXPS), v.ok);
    });
  }

  function updateExperiment(id, patch) {
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      var v = expFromInput(patch, false);
      if (v.err) throw new Error(v.err);
      return patchRef(sdk.doc(db, EXPS, i), v.ok);
    });
  }

  /* START. Stamps the server's clock and moves the status in one write, so
     the two can never disagree — a "running" experiment with no start, or a
     start on an idea, is a state this API cannot produce. Restarting one that
     has ended clears `endedAt` and `outcome` for the same reason. */
  function startExperiment(id) {
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      return patchRef(sdk.doc(db, EXPS, i), {
        status: "running",
        startedAt: sdk.serverTimestamp(),
        endedAt: null,
        outcome: ""
      });
    });
  }

  /* END. The outcome note is the point of the button, not a nicety: an
     experiment that stops without a sentence saying what we decided is an
     experiment that will be re-run from memory in six weeks. It is still
     allowed to be empty — refusing the write would just teach people not to
     press End — and the UI asks for it. */
  function endExperiment(id, outcome) {
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      return patchRef(sdk.doc(db, EXPS, i), {
        status: "ended",
        endedAt: sdk.serverTimestamp(),
        outcome: str(outcome, MAX_PROSE)
      });
    });
  }

  /* Firestore does NOT cascade a delete: both subcollections outlive the
     document and would sit there forever, invisible, counting against the
     bill and readable by anyone who guessed the path. The experiment goes
     first — so a sweep that fails half-way leaves the board correct rather
     than showing an experiment whose reels cannot be reached — and the rules
     let either admin delete a child whose parent is already gone precisely so
     the sweep does not stop at the first thing the other person wrote. */
  function sweep(id, kind) {
    if (!isFn(sdk.getDocs)) return Promise.resolve(true);
    var col;
    try { col = sdk.collection(db, EXPS, id, kind); } catch (e) { return Promise.resolve(true); }
    return Promise.resolve(sdk.getDocs(col)).then(function (qs) {
      var jobs = [];
      try {
        qs.forEach(function (d) {
          jobs.push(Promise.resolve(sdk.deleteDoc(d.ref)).then(noop, noop));
        });
      } catch (e2) {}
      return Promise.all(jobs);
    }, noop).then(function () { return true; }, function () { return true; });
  }

  function deleteExperiment(id) {
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      return Promise.resolve(sdk.deleteDoc(sdk.doc(db, EXPS, i))).then(function () {
        return sweep(i, REELS).then(function () { return sweep(i, COMMENTS); });
      }).then(function () { return true; });
    });
  }

  function addReel(expId, o) {
    return guard().then(function () {
      var i = str(expId, 200);
      if (!i) throw new Error("no experiment id");
      var v = reelFromInput(o, true);
      if (v.err) throw new Error(v.err);
      return addIn(sdk.collection(db, EXPS, i, REELS), v.ok);
    });
  }

  function updateReel(expId, reelId, patch) {
    return guard().then(function () {
      var i = str(expId, 200), r = str(reelId, 200);
      if (!i || !r) throw new Error("no id");
      var v = reelFromInput(patch, false);
      if (v.err) throw new Error(v.err);
      return patchRef(sdk.doc(db, EXPS, i, REELS, r), v.ok);
    });
  }

  function deleteReel(expId, reelId) {
    return guard().then(function () {
      var i = str(expId, 200), r = str(reelId, 200);
      if (!i || !r) throw new Error("no id");
      return Promise.resolve(sdk.deleteDoc(sdk.doc(db, EXPS, i, REELS, r)))
        .then(function () { return true; });
    });
  }

  /* ======================================================================
     LAYER 2 — the written read.

     Two layers sit in the detail view and the whole design depends on the
     reader being able to tell them apart at a glance:

       LAYER 1 is DIAGNOSTICS — the hook against the rest of the board, the
       steepest fall in a retention series, and the test of whether an A/B gap
       is bigger than the spread within each arm. It is pure arithmetic over
       the reels, it is computed in the page on every paint, it is stored
       nowhere, and it is true whenever it is run. It has no author because it
       needs none.

       LAYER 2 is this: a paragraph somebody wrote about what they think it
       means and what to try next. It is an OPINION. It carries the uid off
       the ID token (the fact), the name that account went by (a convenience
       for printing), and the server's clock.

     Never let the two blur. A number that turns out to be an opinion is worse
     than no number, and this board exists because two people were already
     deciding what worked from memory.

     WRITTEN BY A PERSON TODAY, AND POSSIBLY BY A JOB LATER. Nothing in this
     file calls a model and nothing in this repo may hold a key for one — the
     repo is public. What is here is the SEAM: a Cloud Function, or an agent
     holding a service-account credential, writes these same four fields and
     the page renders the result unchanged, because the page reads a field and
     never asks who typed it. requestAnalysis() below sets a flag such a job
     could watch. THERE IS NO JOB; the flag is a place for one to arrive.
     ====================================================================== */

  function analysisStamp(text) {
    var m = me();
    if (!m) throw new Error("not writable: signed-out");
    return {
      analysis: str(text, MAX_ANALYSIS),
      analysisBy: m.uid,
      analysisByName: whoName(),
      /* The SERVER's clock. A browser with the wrong time cannot date a read
         into last week, which is the one thing that would make the "this is
         an opinion from a moment" framing a lie. */
      analysisAt: sdk.serverTimestamp()
    };
  }

  function writeAnalysis(expId, text) {
    return guard().then(function () {
      var i = str(expId, 200);
      if (!i) throw new Error("no id");
      return patchRef(sdk.doc(db, EXPS, i), analysisStamp(text));
    });
  }

  function writeReelAnalysis(expId, reelId, text) {
    return guard().then(function () {
      var i = str(expId, 200), r = str(reelId, 200);
      if (!i || !r) throw new Error("no id");
      return patchRef(sdk.doc(db, EXPS, i, REELS, r), analysisStamp(text));
    });
  }

  /* A FLAG AND NOTHING ELSE. Sets the moment somebody asked for a read to be
     written for them. No job reads it yet, and the page says so in those
     words rather than showing a spinner for something that is not coming —
     a pending state with nothing behind it is the most expensive kind of lie
     a tool can tell. */
  function requestAnalysis(expId) {
    return guard().then(function () {
      var i = str(expId, 200);
      if (!i) throw new Error("no id");
      return patchRef(sdk.doc(db, EXPS, i), {
        analysisRequestedAt: sdk.serverTimestamp()
      });
    });
  }

  /* Comments. Identical in shape to the task board's, and deliberately so —
     same document shape, same commentShape() in firestore.rules, no update
     path. A comment is a record of something one of them said, and a record
     that can be silently rewritten afterwards is not a record. */
  function addComment(expId, text) {
    return guard().then(function () {
      var i = str(expId, 200);
      if (!i) throw new Error("no id");
      var t = str(text, MAX_COMMENT);
      if (!t) throw new Error("a comment needs something in it");
      var m = me();
      if (!m) throw new Error("not writable: signed-out");
      var payload = { text: t, by: m.uid, byName: whoName(), at: sdk.serverTimestamp() };
      var col = sdk.collection(db, EXPS, i, COMMENTS);
      if (isFn(sdk.addDoc)) {
        return Promise.resolve(sdk.addDoc(col, payload)).then(function (ref) {
          return String(ref && ref.id ? ref.id : "");
        });
      }
      var ref2 = sdk.doc(col);
      return Promise.resolve(sdk.setDoc(ref2, payload)).then(function () {
        return String(ref2 && ref2.id ? ref2.id : "");
      });
    });
  }

  function deleteComment(expId, commentId) {
    return guard().then(function () {
      var i = str(expId, 200), c = str(commentId, 200);
      if (!i || !c) throw new Error("no id");
      return Promise.resolve(sdk.deleteDoc(sdk.doc(db, EXPS, i, COMMENTS, c)))
        .then(function () { return true; });
    });
  }

  /* ======================================================================
     COVER IMAGES — Cloud Storage, and the bytes never go in Firestore.

     A Firestore document is capped at 1MB and is pushed to every open
     listener on every change. A base64 cover would be ~1.4x the file, would
     blow that cap on the second reel, and would re-send the image to both
     browsers every time somebody edited a number. So the bucket holds the
     file and the document holds a URL and a path.

         admin/experiments/{expId}/{name}

     SCOPED TO THE EXPERIMENT, so the rule that guards it can be written once
     over a prefix, and so deleting an experiment has one place to look.

     WHAT THE URL IS. getDownloadURL() mints a tokenised URL that bypasses
     Storage rules by design — that is what makes an <img> work, since an
     <img> cannot send an Authorization header. storage.rules says this out
     loud already about the audio beds. The consequence here is small: a cover
     image is a video thumbnail we posted publicly anyway.

     THE HONEST LIMIT, and it is the reason the page also has a paste-a-URL
     box: these rules are NOT DEPLOYED and Storage rules cannot read
     `customers/{uid}.admin` the way firestore.rules can, without the
     cross-service `firestore.get()` extension. If that upload is refused, the
     promise rejects with the reason and the pasted URL path still works — the
     board does not lose a feature, it loses a convenience.
     ====================================================================== */

  var storageMod = null, storageLoading = null;

  function needStorage() {
    if (storageMod) return Promise.resolve(storageMod);
    if (storageLoading) return storageLoading;
    storageLoading = (function () {
      try { if (W.FBE_STORAGE) return Promise.resolve(W.FBE_STORAGE); } catch (e) {}
      if (!dynImport) return Promise.reject(new Error("no dynamic import"));
      return dynImport(SDK_BASE + "firebase-storage.js");
    })().then(function (mod) {
      if (!mod || !isFn(mod.ref) || !isFn(mod.uploadBytes) || !isFn(mod.getDownloadURL)) {
        throw new Error("storage sdk incomplete");
      }
      storageMod = mod;
      return mod;
    }, function (e) { storageLoading = null; throw e; });
    return storageLoading;
  }

  /* A file name that cannot escape its folder and cannot collide: the reel's
     own id, the clock, and an extension taken from a fixed list rather than
     from whatever the file said it was called. */
  var EXT_OK = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  var MAX_COVER_BYTES = 5 * 1024 * 1024;

  function uploadCover(expId, reelId, file) {
    return guard().then(function () {
      var i = str(expId, 200), r = str(reelId, 200) || "cover";
      if (!i) throw new Error("no experiment id");
      if (!file) throw new Error("no file chosen");
      var type = "";
      try { type = String(file.type || "").toLowerCase(); } catch (e) { type = ""; }
      if (!has(EXT_OK, type)) {
        throw new Error("a cover must be a JPEG, PNG, WebP or GIF");
      }
      var size = 0;
      try { size = Number(file.size) || 0; } catch (e2) { size = 0; }
      if (size > MAX_COVER_BYTES) throw new Error("that cover is over 5MB");

      return needStorage().then(function (S) {
        var app = appFor();
        var st = S.getStorage(app);
        var path = "admin/experiments/" + i + "/" + r + "-" + nowOrder() + "." + EXT_OK[type];
        var ref = S.ref(st, path);
        return Promise.resolve(S.uploadBytes(ref, file, { contentType: type }))
          .then(function () { return S.getDownloadURL(ref); })
          .then(function (url) {
            return { url: safeUrl(url, MAX_COVER), path: path };
          });
      });
    });
  }

  /* ======================================================================
     The public surface. Everything here is ES5-callable and every promise
     either resolves or rejects with an Error carrying a sentence a human
     wrote.
     ====================================================================== */

  var FBE = {
    __factbox: true,

    ready: ready,
    state: function () { return { ok: state.ok, why: state.why || "" }; },
    me: me,

    readError: function () { return lastErr; },
    watchExperiments: watchExperiments,
    watchReels: watchReels,
    watchComments: watchComments,

    addExperiment: addExperiment,
    updateExperiment: updateExperiment,
    deleteExperiment: deleteExperiment,
    startExperiment: startExperiment,
    endExperiment: endExperiment,

    addReel: addReel,
    updateReel: updateReel,
    deleteReel: deleteReel,

    addComment: addComment,
    deleteComment: deleteComment,

    writeAnalysis: writeAnalysis,
    writeReelAnalysis: writeReelAnalysis,
    requestAnalysis: requestAnalysis,

    uploadCover: uploadCover,

    /* Published so the page coerces a typed value exactly the way a write
       does, rather than each inventing its own idea of what "2026-02-31",
       "javascript:alert(1)" or "Talking Head" means. */
    isoDay: isoDay,
    safeUrl: safeUrl,
    formatTag: formatTag,
    retentionList: retentionList,
    DAY_FORMAT: "YYYY-MM-DD",

    MEASURE_HOURS: MEASURE_HOURS,
    AT_RISK_DAYS: AT_RISK_DAYS,
    METRICS: METRICS,
    METRIC_KEYS: METRIC_KEYS,
    STATUSES: STATUSES,
    PLATFORMS: PLATFORMS,
    VARIANTS: VARIANTS,
    SOURCES: SOURCES,

    MAX_TITLE: MAX_TITLE,
    MAX_LINE: MAX_LINE,
    MAX_PROSE: MAX_PROSE,
    MAX_STORY: MAX_STORY,
    MAX_URL: MAX_URL,
    MAX_COMMENT: MAX_COMMENT,
    MAX_ANALYSIS: MAX_ANALYSIS,
    MAX_LINKS: MAX_LINKS,
    MAX_FORMAT: MAX_FORMAT,
    MAX_RETENTION: MAX_RETENTION,

    COLLECTIONS: { experiments: EXPS, reels: REELS, comments: COMMENTS },
    SDK_VERSION: SDK_VERSION
  };

  try { W.FBE = FBE; } catch (e) {}

  try {
    if (W.document && W.CustomEvent) {
      W.dispatchEvent(new W.CustomEvent("fbe-ready", { detail: FBE }));
    } else if (W.dispatchEvent && W.document && W.document.createEvent) {
      var ev = W.document.createEvent("Event");
      ev.initEvent("fbe-ready", false, false);
      W.dispatchEvent(ev);
    }
  } catch (e2) {}

  try { ready(); } catch (e3) {}
  try { whenFBU().then(function () { watchAuth(); }); } catch (e4) {}
})();
