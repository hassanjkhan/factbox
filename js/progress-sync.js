/* ==========================================================================
   Factbox — reading progress and saves into Firestore.
   Exposes: window.FBPG

   WHAT THIS IS, AND THE BUG IT EXISTS FOR.

   Reading progress (js/progress.js, FBP) and saved stories (js/saves.js, FBS)
   were per-BROWSER: one localStorage key each and nothing else. Signing out of
   Firebase does not touch localStorage, so on a shared phone the shelf showed
   a signed-out visitor blue "Finished" ticks on stories they had never opened
   and a library of saves that were not theirs. They belonged to whoever used
   that browser last.

   The correction, in the owner's words:

     "What the user has read and how much of a story they've read should all
      be stored on Firebase, and it shouldn't be something that's cached
      locally. You could cache it, but once they've signed in or signed out,
      it should update and pull from the backend so this is up to date."

     "If someone's not even authorized, like they're not even logged in, then
      the UI should not have anything in the finished story... When they sign
      in, you can update the cache locally so all the UIs show up really
      quickly asynchronously while the UI is loading, and then you can update
      things once the async functions are done."

   So: FIRESTORE IS THE RECORD. localStorage is a cache of it, tagged with the
   uid it came from. Signed out, nothing personal is shown at all.

   WHERE IT WRITES, AND WHERE IT DOES NOT.

       customers/{uid}/profile/reading     <- this file, client-written
       customers/{uid}/profile/onboarding  <- js/profile-sync.js
       customers/{uid}                     <- the Stripe webhook. NEVER us.

   `customers/{uid}` carries the `premium` boolean that decides access, and it
   is written by the Stripe extension from a webhook running with admin
   credentials. A client write to that document races the webhook and can
   clobber a subscription state nothing on this site can rebuild. So this goes
   in a subdocument, exactly as js/profile-sync.js does, and nothing reads it
   to make a decision about money or access.

   THE MERGE RULE, and why it is two different rules.

     The cache is tagged with an owner (fb_cache_owner_v1). On sign-in as U:

       owner === U   UNION. Same account, and this device may hold minutes of
                     reading that never reached the server — a tunnel, a
                     killed tab. Reading progress is monotonic by design (see
                     js/progress.js: "progress never goes backwards"), so a
                     per-story max is exactly right and cannot lose anything.

       owner !== U   ADOPT the server's answer wholesale and throw the local
                     cache away. This covers signing in on a friend's phone
                     and on a library machine, and it is the case that must
                     fail safe: you may lose your own unsynced reading, you
                     may never inherit somebody else's.

     Saves are a list, not a monotone counter, so a union cannot express a
     REMOVED save — the removal would come back on the next pull, forever. So
     saves adopt the server's list and then re-apply the adds and removes made
     on this page since it loaded. See applyEdits().

   THE FIVE RULES THIS FILE OBEYS WITHOUT EXCEPTION, borrowed verbatim from
   js/profile-sync.js because they were right there:

   1. It never throws, at top level or anywhere else. A reader must never see
      a consequence of this file existing.
   2. A denied write is a no-op, not an error, and we stop trying for the rest
      of the page rather than retry against a rule that will not change.
   3. Signed out, it syncs nothing. There is no queue and no "sync later".
   4. It is debounced. Progress is written on EVERY card view; one Firestore
      write per card would be absurd. Local storage stays instant (FBP writes
      it at 1200ms); the network is coalesced at PUSH_MS and floored at
      MIN_GAP_MS, and flushed on pagehide.
   5. It degrades to exactly the old behaviour. No FBU, no SDK, no network, a
      browser that refuses storage: every path below is guarded and the site
      works from localStorage as it always did.

   It sends nothing to analytics. Not a story id, not a card number, not a
   count. What someone reads is not something to put in a log.

   ES5 only, like every file here except js/auth.js. The one modern thing is
   the dynamic import that fetches the SDK, built with `new Function` so a
   browser too old to parse `import()` fails to build one function rather than
   failing to parse this whole file.

   HOW IT IS LOADED. js/progress.js appends it, rather than a <script> tag in
   each of the twelve pages that carry progress. That is deliberate: it means
   this file cannot be present on a page where FBP is absent, cannot be
   forgotten when a thirteenth page is added, and cannot be added twice. It is
   async, so it never delays a paint, and if the fetch fails the site is the
   site it was before this file existed.
   ========================================================================== */

(function () {
  "use strict";

  var W = (typeof window !== "undefined" && window) ? window : null;
  if (!W) { return; }
  if (W.FBPG && W.FBPG.__factbox) { return; }   /* never install twice */

  /* ======================================================================
     Configuration. Same project, same public config as js/auth.js — the web
     API key Firebase publishes in every client, not a secret. Repeated rather
     than imported because js/auth.js is a module and this file is not; if the
     two ever disagree, js/auth.js is right.
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

  var COLL = "profile";
  var DOC  = "reading";

  var SCHEMA     = 1;
  var PUSH_MS    = 4000;    /* coalesce a run of card views into one write */
  var FIRST_MS   = 700;     /* the write straight after a pull can be quicker */
  var MIN_GAP_MS = 8000;    /* never two writes closer together than this */

  /* The size discipline, mirrored from the two stores and again in
     firestore.rules. A hostile client cannot write a megabyte here: the rule
     caps both strings, and these caps mean a well-behaved one never tries. */
  var MAX_ENTRIES = 60;     /* js/progress.js MAX_ENTRIES */
  var MAP_BYTES   = 20000;  /* js/progress.js MAX_BYTES   */
  var MAX_SAVES   = 200;    /* js/saves.js    MAX_ENTRIES */
  var SAVE_BYTES  = 8000;   /* js/saves.js    MAX_BYTES   */

  /* ======================================================================
     Guarded handles on the two stores. Either may be absent — js/saves.js is
     not on every page that carries js/progress.js — and neither is required.
     ====================================================================== */

  function P() {
    try {
      return (W.FBP && typeof W.FBP.replaceAll === "function" &&
              typeof W.FBP.snapshot === "function") ? W.FBP : null;
    } catch (e) { return null; }
  }
  function S() {
    try {
      return (W.FBS && typeof W.FBS.replaceAll === "function" &&
              typeof W.FBS.snapshot === "function") ? W.FBS : null;
    } catch (e) { return null; }
  }
  function fbu() {
    try { return (W.FBU && typeof W.FBU.uid === "function") ? W.FBU : null; }
    catch (e) { return null; }
  }

  /* State. All per-page-load; nothing here persists. */
  var sdk       = null;
  var db        = null;
  var loading   = null;
  var loadFail  = false;
  var denied    = false;
  var curUid    = "";       /* the uid we are currently reconciled with */
  var bootDone  = false;    /* FBU has answered once */
  var lastJSON  = "";       /* fingerprint of the last payload written */
  var lastAt    = 0;
  var timer     = null;
  var pulls = 0, writes = 0, errs = 0;
  var installed = false;

  /* The saves list as it stood when this page loaded, so a pull can tell an
     edit made on this page apart from a save that was already there. */
  var baseSaves = null;

  function noop() {}

  /* ======================================================================
     Shapes on the wire.

     The reading map goes up as a JSON STRING rather than a Firestore map, and
     that is a security decision, not a lazy one. Rules cannot iterate a map
     whose keys are story ids they do not know, so `m is map && m.size() <= 60`
     would cap the number of entries and say nothing at all about their
     values: sixty keys times a 16KB string is very nearly the 1MiB document
     limit, written by anyone with an account. A string has one length and the
     rule caps it exactly, in the same units js/progress.js already uses for
     its own MAX_BYTES. Nothing queries this field, so nothing is lost.
     ====================================================================== */

  function mapJSON(m) {
    try { return JSON.stringify(m || {}); } catch (e) { return "{}"; }
  }

  function countKeys(o) {
    var n = 0, k;
    try {
      for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) n++; }
    } catch (e) {}
    return n;
  }

  /* Oldest-first eviction until it fits, the same rule and the same direction
     as js/progress.js's trim(): the stories someone is actually reading are
     the last to go. */
  function fitMap(m) {
    var out = {}, k, keys = [];
    try {
      for (k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) keys.push(k); }
      keys.sort(function (a, b) { return (m[b][2] || 0) - (m[a][2] || 0); });  /* newest first */
      if (keys.length > MAX_ENTRIES) keys.length = MAX_ENTRIES;
      for (var i = 0; i < keys.length; i++) out[keys[i]] = m[keys[i]];
      while (keys.length && mapJSON(out).length > MAP_BYTES) {
        delete out[keys[keys.length - 1]];
        keys.length = keys.length - 1;
      }
    } catch (e) { return {}; }
    return out;
  }

  function fitSaves(rows) {
    var out = [];
    try {
      out = (rows || []).slice(0, MAX_SAVES);
      while (out.length && mapJSON(out).length > SAVE_BYTES) out.length = out.length - 1;
    } catch (e) { return []; }
    return out;
  }

  /* Parsing what came back. Everything is re-validated: this arrived over a
     network, and the fact that it came out of our own document is not a
     reason to trust its shape. A bad value is a dropped entry, never a throw
     and never a broken shelf. */
  function parseMap(raw) {
    var out = {};
    try {
      var o = JSON.parse(String(raw || "{}"));
      if (!o || typeof o !== "object") return out;
      var k, a, n = 0;
      for (k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        if (!k.length || k.length > 40) continue;
        a = o[k];
        if (!a || typeof a.length !== "number" || a.length < 3) continue;
        out[k] = [ Math.max(0, Math.floor(+a[0]) || 0),
                   Math.max(0, Math.floor(+a[1]) || 0),
                   Math.max(0, Math.floor(+a[2]) || 0),
                   a[3] ? 1 : 0 ];
        n++;
        if (n >= MAX_ENTRIES) break;
      }
    } catch (e) { return {}; }
    return out;
  }

  function parseSaves(raw) {
    var out = [];
    try {
      var a = JSON.parse(String(raw || "[]"));
      if (!a || typeof a.length !== "number") return out;
      var seen = {}, i, e, id;
      for (i = 0; i < a.length && out.length < MAX_SAVES; i++) {
        e = a[i];
        if (!e || typeof e.length !== "number" || !e.length) continue;
        id = String(e[0] == null ? "" : e[0]);
        if (!id.length || id.length > 40) continue;
        if (Object.prototype.hasOwnProperty.call(seen, id)) continue;
        seen[id] = 1;
        out.push([ id, Math.max(0, Math.floor(+e[1]) || 0) ]);
      }
    } catch (e2) { return []; }
    return out;
  }

  /* ======================================================================
     The merge.
     ====================================================================== */

  /* Per story: the deepest card, the later timestamp, and finished is sticky.
     `total` is taken from whichever record was touched more recently, not the
     larger of the two — a story that was EDITED shorter must not keep the old
     count, or every reader of it is permanently one card from the end. */
  function unionMap(local, remote) {
    var out = {}, k, a, b, card, total, at, done;
    try {
      for (k in remote) {
        if (Object.prototype.hasOwnProperty.call(remote, k)) out[k] = remote[k];
      }
      for (k in local) {
        if (!Object.prototype.hasOwnProperty.call(local, k)) continue;
        a = local[k];
        b = out[k];
        if (!b) { out[k] = a; continue; }
        card  = Math.max(a[0] || 0, b[0] || 0);
        at    = Math.max(a[2] || 0, b[2] || 0);
        total = ((a[2] || 0) >= (b[2] || 0)) ? (a[1] || 0) : (b[1] || 0);
        done  = (a[3] || b[3]) ? 1 : 0;
        if (total > 0 && card > total - 1) card = total - 1;
        if (total > 0 && card >= total - 1) done = 1;
        out[k] = [card, total, at, done];
      }
    } catch (e) { return remote || {}; }
    return out;
  }

  /* Saves adopt the server's list, then this page's own edits are put back on
     top. Without the second half, tapping the bookmark at 200ms and having the
     pull land at 500ms would silently undo the tap. */
  function applyEdits(adopted) {
    var out = [], seen = {}, i, id;
    try {
      var now = (S() ? S().snapshot() : []) || [];
      var base = baseSaves || [];
      var wasBase = {}, isNow = {};
      for (i = 0; i < base.length; i++) wasBase[base[i][0]] = base[i][1] || 0;
      for (i = 0; i < now.length; i++) isNow[now[i][0]] = now[i][1] || 0;

      /* removed here since load: drop, even if the server still has it */
      for (i = 0; i < adopted.length; i++) {
        id = adopted[i][0];
        if (Object.prototype.hasOwnProperty.call(wasBase, id) &&
            !Object.prototype.hasOwnProperty.call(isNow, id)) continue;
        if (Object.prototype.hasOwnProperty.call(seen, id)) continue;
        seen[id] = 1;
        out.push(adopted[i]);
      }
      /* added here since load: keep, even though the server has never seen it */
      for (i = 0; i < now.length; i++) {
        id = now[i][0];
        if (Object.prototype.hasOwnProperty.call(wasBase, id)) continue;
        if (Object.prototype.hasOwnProperty.call(seen, id)) continue;
        seen[id] = 1;
        out.push(now[i]);
      }
      out.sort(function (a, b) { return (b[1] || 0) - (a[1] || 0); });
    } catch (e) { return adopted || []; }
    return out;
  }

  /* ======================================================================
     The SDK. Same dynamic-import pattern, and the same documented seam, as
     js/profile-sync.js and js/auth.js.
     ====================================================================== */

  var dynImport = null;
  try { dynImport = new Function("u", "return import(u);"); } catch (e) { dynImport = null; }

  function loadSDK() {
    try {
      if (W.FBPG_SDK) return Promise.resolve(W.FBPG_SDK);
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

  /* getApp() first, so we share js/auth.js's instance and therefore its
     signed-in auth state — a Firestore handle from a different app would act
     as nobody and be denied for the wrong reason. */
  function appFor() {
    if (!sdk) return null;
    try { if (typeof sdk.getApp === "function") return sdk.getApp(); } catch (e) {}
    try { if (typeof sdk.initializeApp === "function") return sdk.initializeApp(CONFIG); }
    catch (e2) {}
    return null;
  }

  function need() {
    if (db) return Promise.resolve(db);
    if (loadFail) return Promise.reject(new Error("sdk unavailable"));
    if (loading) return loading;
    loading = loadSDK().then(function (mod) {
      sdk = mod || null;
      if (!sdk || typeof sdk.doc !== "function" || typeof sdk.setDoc !== "function" ||
          typeof sdk.getDoc !== "function") {
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

  function ref(uid) {
    try { return sdk.doc(db, "customers", uid, COLL, DOC); } catch (e) { return null; }
  }

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

  /* ======================================================================
     Pull — the authoritative direction.
     ====================================================================== */

  function pull(uid) {
    if (!uid || denied || loadFail) return;
    var p = P(), s = S();
    if (!p) return;

    var beforeMap    = p.snapshot();
    var beforeSaves  = s ? s.snapshot() : [];
    var beforeVisible = !!p.visible();
    var mine = (p.owner() === uid);

    need().then(function () {
      var r = ref(uid);
      if (!r) throw new Error("no ref");
      return sdk.getDoc(r);
    }).then(function (snap) {
      /* The reader may have signed out again while this was in flight. */
      if (curUid !== uid) return null;

      var d = null;
      try { d = (snap && snap.exists && snap.exists()) ? snap.data() : null; } catch (e) { d = null; }

      var remoteMap   = d ? parseMap(d.map)     : {};
      var remoteSaves = d ? parseSaves(d.saves) : [];

      var nextMap   = mine ? unionMap(beforeMap, remoteMap) : remoteMap;
      var nextSaves = applyEdits(mine ? unionSavesKeepingRemoval(beforeSaves, remoteSaves)
                                      : remoteSaves);

      p.replaceAll(nextMap, uid);
      if (s) s.replaceAll(nextSaves);
      p.show(true);
      if (s) s.show(true);
      pulls++;
      baseSaves = s ? s.snapshot() : [];

      var changed = (mapJSON(nextMap) !== mapJSON(beforeMap)) ||
                    (mapJSON(nextSaves) !== mapJSON(beforeSaves)) ||
                    (beforeVisible !== true);

      /* Anything the union added that the server has not got yet. A reader
         signing in with nothing to say gets no document written for them:
         `!d` is deliberately NOT a reason to write, or every sign-in would
         mint an empty row. */
      if (mapJSON(nextMap) !== mapJSON(remoteMap) ||
          mapJSON(nextSaves) !== mapJSON(remoteSaves)) schedule(FIRST_MS);

      if (changed) repaint(uid);
      return null;
    }).then(null, function (e) {
      errs++;
      if (isDenied(e)) denied = true;
      /* Offline, a cold Firestore, an SDK that never arrived. The cache we
         already have is what the reader sees, which is the old behaviour and
         is a perfectly good page. Nothing is shown and nothing is thrown.

         One thing still has to happen: this reader IS signed in, and the
         cache is theirs (owner matched), so it may be shown. Refusing to
         paint a reader's own progress because the network is down would be a
         worse bug than the one this file fixes. */
      try {
        if (curUid === uid && mine) {
          if (P()) P().show(true);
          if (S()) S().show(true);
          if (!beforeVisible) repaint(uid);
        }
      } catch (e2) {}
      return null;
    });
  }

  /* Same account, so a save the server has and this device does not is a save
     made on another device — keep it. A save this device has and the server
     does not is one made here since the last push — keep that too. A removal
     made on this page is put back by applyEdits() afterwards. */
  function unionSavesKeepingRemoval(local, remote) {
    var out = [], seen = {}, i, e;
    try {
      for (i = 0; i < remote.length; i++) {
        e = remote[i];
        if (Object.prototype.hasOwnProperty.call(seen, e[0])) continue;
        seen[e[0]] = 1; out.push(e);
      }
      for (i = 0; i < local.length; i++) {
        e = local[i];
        if (Object.prototype.hasOwnProperty.call(seen, e[0])) continue;
        seen[e[0]] = 1; out.push(e);
      }
      out.sort(function (a, b) { return (b[1] || 0) - (a[1] || 0); });
    } catch (e2) { return remote || []; }
    return out;
  }

  /* ======================================================================
     Push — debounced, never on the card view itself.
     ====================================================================== */

  function payload() {
    var p = P(), s = S();
    var m = fitMap(p ? p.snapshot() : {});
    var rows = fitSaves(s ? s.snapshot() : []);
    return {
      schema: SCHEMA,
      count: countKeys(m),
      map: mapJSON(m),
      saveCount: rows.length,
      saves: mapJSON(rows)
    };
  }

  function fingerprint(o) {
    try { return o.count + "|" + o.map + "|" + o.saveCount + "|" + o.saves; }
    catch (e) { return ""; }
  }

  /* force=true is the page going away. MIN_GAP_MS exists to stop a reader
     turning cards from writing four times a second; it must not stop the ONE
     write that carries everything they just read. Without this, closing the
     tab within MIN_GAP_MS of the previous write silently lost the difference —
     which is most of a short session. */
  function flush(force) {
    timer = null;
    if (denied || loadFail) return;
    if (!curUid) return;                    /* signed out: nothing to do */
    var p = P();
    if (!p) return;
    /* Never push a cache we are not showing. Hidden means "we do not believe
       this is the signed-in reader's data", and uploading it into their
       account would be the original bug with a longer reach. */
    if (!p.visible()) return;

    var body = payload();
    var fp = fingerprint(body);
    if (fp && fp === lastJSON) return;      /* unchanged; do not write */

    var now = 0;
    try { now = Date.now(); } catch (e) { now = 0; }
    if (!force && lastAt && now && (now - lastAt) < MIN_GAP_MS) {
      schedule(MIN_GAP_MS - (now - lastAt));
      return;
    }

    var uid = curUid;
    need().then(function () {
      var r = ref(uid);
      if (!r) throw new Error("no ref");
      /* A server timestamp, or none at all. A client clock is a number the
         rules cannot check, and the rule requires request.time if the field
         is present. */
      try {
        if (typeof sdk.serverTimestamp === "function") body.updatedAt = sdk.serverTimestamp();
      } catch (e) {}
      /* merge, so this write can never remove a field a later version of this
         file learns to keep. */
      return sdk.setDoc(r, body, { merge: true });
    }).then(function () {
      if (curUid !== uid) return null;
      writes++;
      lastAt = now || lastAt;
      lastJSON = fp;
      return null;
    }, function (e) {
      errs++;
      if (isDenied(e)) denied = true;
      return null;
    });
  }

  function schedule(ms) {
    if (denied || loadFail) return;
    try {
      if (timer) { W.clearTimeout(timer); timer = null; }
      timer = W.setTimeout(function () { try { flush(); } catch (e) {} },
                           typeof ms === "number" ? ms : PUSH_MS);
    } catch (e) { timer = null; }
  }

  function flushNow() {
    try { if (timer) { W.clearTimeout(timer); timer = null; } } catch (e) {}
    try { flush(true); } catch (e) {}
  }

  /* ======================================================================
     Sign-out.

     js/access.js exposes FBX.forgetLegacy() and the sign-out handlers in
     account.html and login.html already call it. It is wrapped here rather
     than edited there for two reasons: this file owns the caches, and a hook
     added to two pages is a hook a third page can forget. The original runs
     first only if it cannot throw — it can, in principle, so the caches are
     emptied BEFORE it, because the handler navigates immediately afterwards
     and a clear that does not happen before location.replace() never happens.

     A sign-out empties the caches; it does not touch the Firestore document.
     That document is the point — it is what the reader signs back in to find.
     ====================================================================== */

  function forget() {
    curUid = "";
    lastJSON = "";
    lastAt = 0;
    baseSaves = [];
    try { if (timer) { W.clearTimeout(timer); timer = null; } } catch (e) {}
    try { if (P()) P().clear(); } catch (e) {}
    try { if (S()) S().clear(); } catch (e) {}
    /* js/saves.js is not on every page that carries js/progress.js — /explore
       and the front page have progress and no saves — so a sign-out there
       would leave fb_saved_v1 behind for /library to find. Measured: signing
       out on /explore, then opening /library, and the departed reader's two
       saves were still in storage. The gate hid them, which is the point, but
       leaving a stranger's data on the device because the page that could
       clear it was not loaded is not the deal. This file syncs both stores;
       it clears both, whether or not both are on the page. */
    try { localStorage.removeItem("fb_saved_v1"); } catch (e) {}
    try { localStorage.removeItem("fb_read_v1"); } catch (e) {}
    try { localStorage.removeItem("fb_cache_owner_v1"); } catch (e) {}
  }

  function wrapForget() {
    try {
      var X = W.FBX;
      if (!X || typeof X.forgetLegacy !== "function") return false;
      if (X.forgetLegacy.__fbpg) return true;
      var orig = X.forgetLegacy;
      var next = function () {
        try { forget(); } catch (e) {}
        try { return orig.apply(X, arguments); } catch (e2) { return undefined; }
      };
      next.__fbpg = true;
      X.forgetLegacy = next;
      return true;
    } catch (e) { return false; }
  }

  /* ======================================================================
     Redraw.

     The correct seam is FBP.onChange / FBS.onChange: a shelf registers once,
     after its first render, and redraws when the account's answer lands. That
     is the same render-then-correct shape js/today.js and js/library.js
     already use for padlocks through FBX.paint, and the one-line hook for each
     surface is in the report that came with this file.

     Until those lines exist, a signed-in reader on a device with an empty
     cache would draw an empty shelf and never fill it in, so there is a
     fallback: ONE reload, with harder guards than FBX.correct()'s. It turns
     itself off the moment any surface subscribes — FBP.listeners() > 1 means
     something on this page will redraw itself and a reload would be rude.

     The guards, all of which must hold:
       1. something actually changed (the caller decides);
       2. nothing is listening, so nothing else will repaint;
       3. this is not a story page — FBP.reading() is true once a card has
          been viewed, and reloading someone mid-story is unforgivable;
       4. the page has a shelf on it at all;
       5. js/access.js has not already spent this tab's one reload;
       6. once per tab per uid, in sessionStorage so it survives the reload it
          is guarding — a variable would be wiped by it and guard nothing.
     ====================================================================== */

  var ONCE = "fbpg_pulled_v1";

  function fire(name) {
    try {
      var ev;
      if (typeof W.CustomEvent === "function") ev = new W.CustomEvent(name);
      else if (W.document && W.document.createEvent) {
        ev = W.document.createEvent("Event");
        ev.initEvent(name, false, false);
      }
      if (ev) W.dispatchEvent(ev);
    } catch (e) {}
  }

  /* Which story a cover is for. /explore and the front page put it in
     data-id; /library does not, and its covers are identified by the href the
     reader would follow. Anything we cannot name is skipped rather than
     guessed at. */
  function idOfCard(a) {
    try {
      var v = a.getAttribute("data-id");
      if (v) return String(v);
      var h = String(a.getAttribute("href") || "");
      var m = h.match(/[?&]s=([^&#]+)/);
      if (m) return decodeURIComponent(m[1]);
      if (h.indexOf("/cleopatra") !== -1) return "01";
    } catch (e) {}
    return "";
  }

  /* Does the screen disagree with the store?

     This is the whole justification for the fallback reload below, and asking
     it directly is much better than the pile of heuristics it replaces. The
     covers carry their state in a class — is-done, is-reading, is-unread — so
     "what was drawn" is readable, and FBP.state() is "what is true now". If
     they agree there is nothing to correct and a reload would be vandalism.

     It also gets the ordering right for free. When the account's answer lands
     BEFORE the shelf has drawn — the common case, because the IndexedDB hint
     usually beats the shelf's own fetch — there are no covers to compare, this
     is false, and the shelf simply draws correctly the first time. */
  function disagrees() {
    try {
      var d = W.document, p = P();
      if (!d || !d.querySelectorAll || !p || !p.state) return false;
      var list = d.querySelectorAll("a.card"), i, id, cls, drawn, st;
      if (!list.length) return false;
      for (i = 0; i < list.length; i++) {
        id = idOfCard(list[i]);
        if (!id) continue;
        cls = " " + (list[i].className || "") + " ";
        drawn = cls.indexOf(" is-done ") !== -1 ? "done"
              : cls.indexOf(" is-reading ") !== -1 ? "reading" : "unread";
        st = p.state(id, 0);
        if (drawn !== (st && st.status)) return true;
      }
    } catch (e) { return false; }
    return false;
  }

  function hasShelf() {
    try {
      if (!W.document || !W.document.querySelector) return false;
      /* A reader, never. FBP.reading() catches this the moment a card is
         actually viewed, but the reader's own first mark() can land a beat
         after FBU answers, and reloading someone out of a story is the one
         mistake here that is not recoverable by waiting. .beat is read.html's
         card and the three composed story pages carry it too. */
      if (W.document.querySelector(".beat, .deck")) return false;
      return !!W.document.querySelector("#shelf, .card, .grid, .tdy-serie");
    } catch (e) { return false; }
  }

  /* `key` is both "may this reload?" and the once-per-tab token. An empty key
     means fire the event and stop.

     THE ONE CASE THAT MUST NOT RELOAD is a sign-out the reader asked for. The
     handlers in account.html and login.html run

         FBU.signOut()  ->  FBX.forgetLegacy()  ->  location.replace("/")

     and FBU's onChange fires INSIDE signOut(), so a reload from here lands
     between the first line and the third and the rest of the handler never
     runs. Measured: it destroyed the execution context mid-handler. Nothing
     is lost by staying out of the way — the handler navigates one line later
     and the page it lands on paints from an empty cache.

     THE ONE CASE THAT MUST is the auth hint having lied. The hint paints the
     cache when a persisted Firebase session names the uid that owns it; if
     that session turns out to be stale or revoked, we have already drawn a
     departed reader's ticks and no handler is about to navigate away from
     them. That is the reported bug, on screen, and it has to come off.

     The two are told apart structurally rather than by a flag, because a flag
     would be set too late: an asked-for sign-out is a TRANSITION (curUid was
     set), a stale session is the page's FIRST answer (curUid never was). */
  function repaint(key) {
    fire("fbp-progress");
    if (!key) return;

    try {
      var p = P();
      if (!p) return;
      if (p.listeners() > 1) return;                    /* something will redraw */
      if (p.reading()) return;                          /* mid-story */
      if (!hasShelf()) return;
      if (!disagrees()) return;                         /* the screen is already right */
      if (W.sessionStorage.getItem("fbx_corrected_v1") === "1") return;
      if (W.sessionStorage.getItem(ONCE) === key) return;
      W.sessionStorage.setItem(ONCE, key);
    } catch (e) { return; }                             /* no guard, no reload */
    try { W.location.reload(); } catch (e2) {}
  }

  /* ======================================================================
     Identity.

     Two entry points, and the difference matters. onReady() settles once, when
     Firebase has actually answered; onChange() fires on every transition after
     that. js/access.js learned this the hard way: "the current identity is
     signed out" is also true for the first ~600ms of every page load, and
     acting on it clears the storage of someone who was never signed in.

     So nothing destructive happens until bootDone, and even then a signed-out
     answer is only believed when Firebase is genuinely reachable and has
     genuinely answered.
     ====================================================================== */

  function uidOf(U) {
    try { return U && U.uid ? String(U.uid() || "") : ""; } catch (e) { return ""; }
  }

  function trustSignedOut(U) {
    try {
      if (!U) return false;
      if (typeof U.unavailable === "function" && U.unavailable()) return false;
      if (typeof U.timedOut === "function" && U.timedOut()) return false;
      if (typeof U.known === "function" && !U.known()) return false;
      return true;
    } catch (e) { return false; }
  }

  function settle(U) {
    var uid = uidOf(U);

    if (uid) {
      if (uid === curUid) return;
      curUid = uid;
      lastJSON = "";
      denied = false;

      /* Two things happen before the network is touched, and the order is the
         owner's: "update the cache locally so all the UIs show up really
         quickly asynchronously while the UI is loading, and then you can
         update things once the async functions are done."

         noteLive() writes the uid where the NEXT page in this tab can read it
         synchronously, so it does not spend 600ms deciding whether to draw a
         tick. Then, if this cache is already this account's, it is shown
         immediately — from localStorage, with no Firestore round trip. The
         pull below corrects it a few hundred milliseconds later. */
      var p0 = P();
      try { if (p0 && p0.noteLive) p0.noteLive(uid); } catch (e) {}
      try {
        if (p0 && p0.owner() === uid && !p0.visible()) {
          p0.show(true);
          if (S()) S().show(true);
          repaint(uid);
        }
      } catch (e2) {}

      pull(uid);
      return;
    }

    /* Signed out. */
    if (!trustSignedOut(U)) return;

    var p = P();
    if (curUid) { forget(); repaint(""); return; }   /* a real sign-out this page */

    /* First answer of the page, and it is "nobody". A cache tagged with an
       account is a departed reader's and is destroyed. An untagged cache was
       never anyone's but this device's — it is not shown (the owner's rule:
       signed out shows nothing) but it is not destroyed either, because
       destroying data nobody asked us to destroy is not our call. */
    try {
      if (p && p.owner()) {
        /* A cache tagged with an account, and no account. If the hint painted
           it before Firebase answered, those ticks are on screen right now and
           belong to somebody else. */
        var painted = !!p.visible();
        forget();
        if (painted) repaint("out");
      } else {
        if (p) p.show(false);
        if (S()) S().show(false);
      }
    } catch (e) {}
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

    try { baseSaves = S() ? S().snapshot() : []; } catch (e) { baseSaves = []; }

    /* js/access.js may not have run yet; it is one <script> away either
       direction depending on the page. Cheap to try again. */
    if (!wrapForget()) {
      var n = 0;
      try {
        var t = W.setInterval(function () {
          n++;
          if (wrapForget() || n > 25) W.clearInterval(t);
        }, 200);
      } catch (e) {}
    }

    /* Local changes schedule a push. "replace" is OUR OWN write landing in the
       cache; treating it as a change is how you get an infinite write loop. */
    try {
      if (P()) P().onChange(function (why) {
        if (why === "local") { schedule(PUSH_MS); return; }
        /* "show" is the IndexedDB hint landing. It usually lands before the
           shelf draws, in which case disagrees() finds nothing and this costs
           one querySelectorAll. When it lands after — a slow store, a slow
           phone — the covers on screen are stale and this is what notices.
           Deferred a tick so a gate opened mid-render is compared against the
           finished render, not a half-built one. */
        if (why === "show" || why === "replace") {
          try { W.setTimeout(function () { repaint(curUid || "out"); }, 0); } catch (e) {}
        }
      });
    } catch (e) {}
    try {
      if (S()) S().onChange(function (why) { if (why === "local") schedule(PUSH_MS); });
    } catch (e) {}

    /* A phone leaving the page never fires unload; these two do. */
    try { W.addEventListener("pagehide", flushNow, false); } catch (e) {}
    try {
      if (W.document) {
        W.document.addEventListener("visibilitychange", function () {
          try { if (W.document.visibilityState === "hidden") flushNow(); } catch (e) {}
        }, false);
      }
    } catch (e) {}

    whenFBU(function (U) {
      if (!U) {
        /* No auth layer on this page at all. Nothing syncs, and nothing is
           shown: there is no identity, so by the rule there is no personal
           state. The cache is left exactly as it is. */
        try { if (P()) P().show(false); } catch (e) {}
        try { if (S()) S().show(false); } catch (e) {}
        return;
      }
      try {
        if (typeof U.onReady === "function") {
          U.onReady(function () { bootDone = true; try { settle(U); } catch (e) {} });
        } else { bootDone = true; }
      } catch (e) { bootDone = true; }
      try {
        if (typeof U.onChange === "function") {
          U.onChange(function () {
            if (!bootDone) return;          /* boot is onReady's job */
            try { settle(U); } catch (e) {}
          });
        }
      } catch (e) {}
    });
  }

  /* ======================================================================
     The surface. Small on purpose: nothing on the site needs to call this,
     and nothing does. It exists so a check can look, and so a future account
     screen can offer "sync now" without reaching inside.
     ====================================================================== */

  var FBPG = {
    __factbox: true,
    path: function () { return curUid ? ("customers/" + curUid + "/" + COLL + "/" + DOC) : ""; },
    uid: function () { return curUid; },
    /* What would be written right now, for a person reading their own data. */
    preview: function () { try { return payload(); } catch (e) { return {}; } },
    sync: function () { try { schedule(0); } catch (e) {} },
    pull: function () { try { if (curUid) pull(curUid); } catch (e) {} },
    forget: forget,
    state: function () {
      var p = P(), s = S();
      return {
        uid: curUid, pulls: pulls, writes: writes, errors: errs,
        denied: denied, loaded: !!db, loadFailed: loadFail,
        booted: bootDone, watching: installed,
        owner: p ? p.owner() : "",
        visible: p ? p.visible() : false,
        savesVisible: s ? s.visible() : false
      };
    },
    SCHEMA: SCHEMA,
    LIMITS: { entries: MAX_ENTRIES, mapBytes: MAP_BYTES,
              saves: MAX_SAVES, saveBytes: SAVE_BYTES }
  };

  try { W.FBPG = FBPG; } catch (e) {}
  try { install(); } catch (e) { noop(); }
})();
