/* ==========================================================================
   Factbox — the shared task board, live, for the two people who run this.
   Exposes: window.FBT

   WHAT THIS IS. Hassan and Kathryn both keep a list of what is outstanding,
   and until now those lists were in two heads and a DM thread. This file is
   the storage under one board they both edit at the same time: two
   collections, live snapshots, and writes that stamp themselves.

       admin_tasks/{id}    a thing to do
       admin_goals/{id}    a thing to hit, with a human deadline

   It owns the DATA and nothing else. `admin/tasks.html` and whatever script
   paints it own every pixel; this file never touches the DOM, never reads a
   query string and has no opinion about columns. The UI asks for the allowed
   values (OWNERS / PRIORITIES / STATUSES / GOAL_STATUSES) rather than
   inventing a string the rules will reject.

   WHO MAY USE IT. Admins only — `customers/{uid}` with `admin == true` or
   `role == "admin"`, the same pair of flags js/auth.js accepts and
   functions/insights.js filters on. That is enforced in firestore.rules,
   which is the only boundary that counts; the check in here is so the page
   can say "you are not an admin" instead of showing an empty board that
   silently refuses every write.

   LIVE, NOT POLLED. Every read is an onSnapshot, exactly as js/auth.js
   watches the customer and subscription documents. Kathryn ticks something
   off and it is ticked on Hassan's screen without a reload, because the
   server pushed it, not because anything asked again.

   HOW TWO EDITS AT ONCE ARE RESOLVED. Every write in here is a FIELD-LEVEL
   merge: updateDoc for a patch, and setDoc(..., {merge:true}) never a bare
   setDoc. So the unit that can be lost is one field, not one task.

     - Different fields, same second: BOTH survive. Kathryn's status change
       and Hassan's retitle land on the same document and neither erases the
       other, because neither write mentions the other's field.
     - The SAME field, same second: last write to reach the server wins, and
       the loser is not told. That is deliberate — the alternative is a
       transaction that reads first and rejects on a version mismatch, which
       buys "your edit was refused, try again" on a two-person board where
       the honest resolution is that somebody typed second. What makes it
       safe is the snapshot: the winning value is on both screens within a
       second, so the person who lost sees the other value appear under their
       cursor rather than finding out tomorrow.
     - Deleting while the other edits: the patch rejects (no such document),
       the promise rejects, and the row is already gone from both boards.

   ES5 only, like every shipped file here except js/auth.js — most readers
   arrive through in-app browsers, and this file loads on a page that also
   carries the site's ordinary scripts. The one modern thing is the dynamic
   import that fetches the Firebase SDK, and it is built with `new Function`
   for the reason js/profile-sync.js gives: a browser too old to parse
   `import(` then fails to build one function instead of failing to parse the
   whole file.
   ========================================================================== */

(function () {
  "use strict";

  var W = (typeof window !== "undefined" && window) ? window : null;
  if (!W) { return; }
  if (W.FBT && W.FBT.__factbox) { return; }   /* never install twice */

  /* ======================================================================
     Configuration. Same project and same public config as js/auth.js and
     js/profile-sync.js — this is the web API key Firebase publishes in every
     client, not a secret. It is repeated rather than imported because
     js/auth.js is a module and this file is not; if the two ever disagree,
     js/auth.js is right.
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

  var TASKS = "admin_tasks";
  var GOALS = "admin_goals";

  /* The allowed values, in one place, because firestore.rules holds the same
     three lists and a client that invents a fourth is simply denied. The UI
     builds its dropdowns from these. */
  var OWNERS        = ["hassan", "kathryn", "either"];
  var PRIORITIES    = ["high", "low"];
  var STATUSES      = ["todo", "doing", "done"];
  var GOAL_STATUSES = ["open", "hit", "missed"];

  var MAX_TITLE  = 120;
  var MAX_DETAIL = 600;
  var MAX_AREA   = 40;
  var MAX_TARGET = 40;

  /* How long to wait for js/auth.js to exist and answer before giving up and
     telling the page the truth. A board that never resolves is worse than a
     board that says it could not sign you in. */
  var BOOT_MS = 12000;

  /* ======================================================================
     Small helpers. All ES5, all total — nothing in here throws.
     ====================================================================== */

  function noop() {}

  function isFn(f) { return typeof f === "function"; }

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

  /* Firestore hands back a Timestamp; a board wants a number it can sort and
     format. Same shape of coercion as js/auth.js's toMs, and 0 for "not set"
     so nothing downstream has to null-check before comparing. */
  function toMs(v) {
    try {
      if (v == null) return 0;
      if (typeof v === "number") return v > 1e11 ? v : v * 1000;
      if (typeof v === "string") {
        var p = Date.parse(v);
        return isFinite(p) ? p : 0;
      }
      if (isFn(v.toMillis)) return v.toMillis();
      if (isFn(v.toDate)) { var d = v.toDate(); return d ? d.getTime() : 0; }
      if (typeof v.seconds === "number") return v.seconds * 1000;
      if (typeof v._seconds === "number") return v._seconds * 1000;
    } catch (e) {}
    return 0;
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
    try { e.fbt = true; } catch (e2) {}
    return Promise.reject(e);
  }

  /* ======================================================================
     The auth layer. js/auth.js is a module and therefore deferred, so on a
     page that loads this file as a classic script FBU may not exist yet. It
     announces itself with `fbu-ready`; the poll is the belt to that braces,
     because a script appended late misses the event entirely.
     ====================================================================== */

  function fbu() {
    try { return (W.FBU && W.FBU.__factbox) ? W.FBU : null; } catch (e) { return null; }
  }

  function whenFBU() {
    var have = fbu();
    if (have) return Promise.resolve(have);
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
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
     The SDK. Same dynamic import as js/profile-sync.js, same documented
     seam (W.FBT_SDK / W.FBPS_SDK / W.FBU_SDK) so a render check can drive
     every branch of this file in jsdom, which cannot execute a real ES
     module off a CDN.
     ====================================================================== */

  var dynImport = null;
  try { dynImport = new Function("u", "return import(u);"); } catch (e) { dynImport = null; }

  var sdk = null;
  var db = null;
  var loading = null;
  var loadFail = false;

  function loadSDK() {
    try {
      if (W.FBT_SDK)  return Promise.resolve(W.FBT_SDK);
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
     signed-in auth state — a Firestore handle from a different app would
     write as nobody and be denied for the wrong reason. */
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
    }, function (e) {
      loadFail = true;
      throw e;
    });
    return loading;
  }

  /* ======================================================================
     ready(). One promise, memoised, that always settles and never rejects.

         { ok: true }
         { ok: false, why: "signed-out" }   nobody is signed in
         { ok: false, why: "not-admin" }    signed in, but not one of us
         { ok: false, why: "sdk-failed" }   no auth layer, no SDK, or a
                                            browser that cannot load either

     The admin answer comes off js/auth.js, which reads `customers/{uid}`
     once in the snapshot it already has open for billing — so asking here
     costs no extra read, and it is the same document the rules consult.
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
          return need().then(function () {
            return { ok: true };
          }, function () {
            return { ok: false, why: "sdk-failed" };
          });
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
      /* Nothing may wait on this forever: a blocked CDN, an SDK that loads
         and never reports, a browser with third-party storage off. */
      try { W.setTimeout(function () { finish({ ok: false, why: "sdk-failed" }); }, BOOT_MS + 3000); } catch (e) {}
      try {
        decide().then(function (v) { finish(v || { ok: false, why: "sdk-failed" }); },
                      function () { finish({ ok: false, why: "sdk-failed" }); });
      } catch (e2) { finish({ ok: false, why: "sdk-failed" }); }
    });
    return readyP;
  }

  /* Signing out, or signing in as somebody else, must not leave the previous
     account's board on screen being written to by the new one. Everything is
     torn down and rebuilt from scratch, which for a non-admin means every
     watcher is handed an empty list. */
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
        /* Re-decide immediately: the watchers are still registered and
           attachAll() runs again the moment the answer is yes. */
        ready().then(function (v) { if (!v.ok) fanoutEmpty(); });
      });
    } catch (e2) {}
  }

  /* ======================================================================
     The live reads.

     One onSnapshot per collection per watcher. No orderBy in the query: the
     board sorts on `order` within a column and Firestore would need a
     composite index for every combination the UI might ask for, so the sort
     happens here on a list that is two people's to-do list, not a corpus.
     ====================================================================== */

  var watchers = [];      /* { coll, fn, unsub } */

  function normTask(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      title: str(d.title, MAX_TITLE),
      detail: str(d.detail, MAX_DETAIL),
      owner: oneOf(d.owner, OWNERS, "either"),
      priority: oneOf(d.priority, PRIORITIES, "low"),
      status: oneOf(d.status, STATUSES, "todo"),
      area: str(d.area, MAX_AREA),
      order: num(d.order, 0),
      /* milliseconds, not Timestamps: the UI formats and sorts these, and a
         Timestamp is neither comparable nor printable without the SDK. 0
         means "not set", which for doneAt is the ordinary case. */
      createdAt: toMs(d.createdAt),
      updatedAt: toMs(d.updatedAt),
      doneAt: toMs(d.doneAt),
      updatedBy: str(d.updatedBy, 128),
      raw: d
    };
  }

  function normGoal(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      title: str(d.title, MAX_TITLE),
      detail: str(d.detail, MAX_DETAIL),
      target: str(d.target, MAX_TARGET),
      status: oneOf(d.status, GOAL_STATUSES, "open"),
      order: num(d.order, 0),
      createdAt: toMs(d.createdAt),
      updatedAt: toMs(d.updatedAt),
      updatedBy: str(d.updatedBy, 128),
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

  function readSnap(qs, coll) {
    var rows = [];
    try {
      if (qs && isFn(qs.forEach)) {
        qs.forEach(function (doc) {
          var d = null;
          try { d = doc.data ? doc.data() : null; } catch (e) { d = null; }
          rows.push(coll === TASKS ? normTask(doc.id, d) : normGoal(doc.id, d));
        });
      } else if (qs && qs.docs) {
        for (var i = 0; i < qs.docs.length; i++) {
          var doc2 = qs.docs[i];
          rows.push(coll === TASKS ? normTask(doc2.id, doc2.data()) : normGoal(doc2.id, doc2.data()));
        }
      }
    } catch (e2) {}
    return sortRows(rows);
  }

  function attach(w) {
    if (w.unsub || !db || !sdk) return;
    try {
      w.unsub = sdk.onSnapshot(
        sdk.collection(db, w.coll),
        function (qs) { call(w.fn, readSnap(qs, w.coll)); },
        function () {
          /* Denied, offline, or the rules changed under us. An empty board is
             the honest answer; ready() already told the page why. */
          call(w.fn, []);
        }
      );
    } catch (e) { call(w.fn, []); }
  }

  function call(fn, rows) {
    try { fn(rows); } catch (e) {}
  }

  function attachAll() {
    for (var i = 0; i < watchers.length; i++) attach(watchers[i]);
  }

  function detachAll() {
    for (var i = 0; i < watchers.length; i++) {
      try { if (watchers[i].unsub) watchers[i].unsub(); } catch (e) {}
      watchers[i].unsub = null;
    }
  }

  function fanoutEmpty() {
    for (var i = 0; i < watchers.length; i++) call(watchers[i].fn, []);
  }

  function watch(coll, fn) {
    if (!isFn(fn)) return noop;
    var w = { coll: coll, fn: fn, unsub: null };
    watchers.push(w);
    var remove = drop(watchers, w);

    ready().then(function (v) {
      if (v.ok) attach(w);
      else later(function () { call(fn, []); });   /* a board, not a spinner */
    });

    return function () {
      try { if (w.unsub) w.unsub(); } catch (e) {}
      w.unsub = null;
      remove();
    };
  }

  function watchTasks(fn) { return watch(TASKS, fn); }
  function watchGoals(fn) { return watch(GOALS, fn); }

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

  function guard() {
    return ready().then(function (v) {
      if (!v.ok) throw new Error("not writable: " + v.why);
      if (!me()) throw new Error("not writable: signed-out");
      return true;
    });
  }

  /* ======================================================================
     The writes.

     Two rules hold for every one of them:

       1. The caller passes fields a human typed. updatedAt and updatedBy are
          added here, from the server clock and the ID token, never from the
          caller.
       2. Nothing overwrites a whole document. addTask writes a complete new
          one; every change after that is updateDoc with only the fields that
          changed, so an edit to `status` cannot revert a `title` this
          browser last saw ten seconds ago. See the conflict note at the top.
     ====================================================================== */

  function taskFromInput(o, forCreate) {
    o = o || {};
    var out = {};
    var has = function (k) { return Object.prototype.hasOwnProperty.call(o, k); };

    if (forCreate || has("title")) {
      var t = str(o.title, MAX_TITLE);
      if (!t) return { err: "a task needs a title" };
      out.title = t;
    }
    if (forCreate || has("detail"))   out.detail   = str(o.detail, MAX_DETAIL);
    if (forCreate || has("owner"))    out.owner    = oneOf(o.owner, OWNERS, "either");
    if (forCreate || has("priority")) out.priority = oneOf(o.priority, PRIORITIES, "low");
    if (forCreate || has("status"))   out.status   = oneOf(o.status, STATUSES, "todo");
    if (forCreate || has("area"))     out.area     = str(o.area, MAX_AREA);
    if (forCreate || has("order"))    out.order    = num(o.order, forCreate ? nowOrder() : 0);

    /* doneAt is derived, not typed. A task that just became done is stamped
       with the server's clock; a task that came back out of done loses the
       stamp. The caller may clear it explicitly with doneAt: null and may not
       set it to anything else — a board that lets you backdate a completion
       is a board that cannot answer "what did we do last week". */
    if (has("status")) {
      out.doneAt = (out.status === "done") ? sdk.serverTimestamp() : null;
    } else if (has("doneAt") && o.doneAt === null) {
      out.doneAt = null;
    } else if (forCreate) {
      out.doneAt = (out.status === "done") ? sdk.serverTimestamp() : null;
    }
    return { ok: out };
  }

  function goalFromInput(o, forCreate) {
    o = o || {};
    var out = {};
    var has = function (k) { return Object.prototype.hasOwnProperty.call(o, k); };

    if (forCreate || has("title")) {
      var t = str(o.title, MAX_TITLE);
      if (!t) return { err: "a goal needs a title" };
      out.title = t;
    }
    if (forCreate || has("detail")) out.detail = str(o.detail, MAX_DETAIL);
    if (forCreate || has("target")) out.target = str(o.target, MAX_TARGET);
    if (forCreate || has("status")) out.status = oneOf(o.status, GOAL_STATUSES, "open");
    if (forCreate || has("order"))  out.order  = num(o.order, forCreate ? nowOrder() : 0);
    return { ok: out };
  }

  /* A new row goes to the bottom of its column, and two rows added in the
     same minute keep the order they were added in. The UI overwrites this
     the moment anybody drags anything. */
  function nowOrder() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function addIn(coll, payload) {
    var col = sdk.collection(db, coll);
    payload.createdAt = sdk.serverTimestamp();
    stamp(payload);
    if (isFn(sdk.addDoc)) {
      return Promise.resolve(sdk.addDoc(col, payload)).then(function (ref) {
        return String(ref && ref.id ? ref.id : "");
      });
    }
    /* Older flattened namespaces expose doc()/setDoc() but not addDoc(). */
    var ref2 = sdk.doc(col);
    return Promise.resolve(sdk.setDoc(ref2, payload)).then(function () {
      return String(ref2 && ref2.id ? ref2.id : "");
    });
  }

  function patchIn(coll, id, payload) {
    var i = str(id, 200);
    if (!i) return reject("no id");
    var ref = sdk.doc(db, coll, i);
    stamp(payload);
    /* updateDoc, not setDoc: a patch that names three fields writes three
       fields. It also fails rather than resurrecting a task the other person
       deleted while this one was open. */
    return Promise.resolve(sdk.updateDoc(ref, payload)).then(function () { return true; });
  }

  function delIn(coll, id) {
    var i = str(id, 200);
    if (!i) return reject("no id");
    return Promise.resolve(sdk.deleteDoc(sdk.doc(db, coll, i))).then(function () { return true; });
  }

  function addTask(o) {
    return guard().then(function () {
      var v = taskFromInput(o, true);
      if (v.err) throw new Error(v.err);
      return addIn(TASKS, v.ok);
    });
  }

  function updateTask(id, patch) {
    return guard().then(function () {
      var v = taskFromInput(patch, false);
      if (v.err) throw new Error(v.err);
      return patchIn(TASKS, id, v.ok);
    });
  }

  function deleteTask(id) {
    return guard().then(function () { return delIn(TASKS, id); });
  }

  function addGoal(o) {
    return guard().then(function () {
      var v = goalFromInput(o, true);
      if (v.err) throw new Error(v.err);
      return addIn(GOALS, v.ok);
    });
  }

  function updateGoal(id, patch) {
    return guard().then(function () {
      var v = goalFromInput(patch, false);
      if (v.err) throw new Error(v.err);
      return patchIn(GOALS, id, v.ok);
    });
  }

  function deleteGoal(id) {
    return guard().then(function () { return delIn(GOALS, id); });
  }

  /* ======================================================================
     The public surface. Everything here is ES5-callable and every promise
     either resolves or rejects with an Error carrying a sentence a human
     wrote.
     ====================================================================== */

  var FBT = {
    __factbox: true,

    ready: ready,
    state: function () { return { ok: state.ok, why: state.why || "" }; },

    watchTasks: watchTasks,
    watchGoals: watchGoals,

    addTask: addTask,
    updateTask: updateTask,
    deleteTask: deleteTask,

    addGoal: addGoal,
    updateGoal: updateGoal,
    deleteGoal: deleteGoal,

    me: me,

    OWNERS: OWNERS,
    PRIORITIES: PRIORITIES,
    STATUSES: STATUSES,
    GOAL_STATUSES: GOAL_STATUSES,

    MAX_TITLE: MAX_TITLE,
    MAX_DETAIL: MAX_DETAIL,
    MAX_AREA: MAX_AREA,
    MAX_TARGET: MAX_TARGET,

    COLLECTIONS: { tasks: TASKS, goals: GOALS },
    SDK_VERSION: SDK_VERSION
  };

  try { W.FBT = FBT; } catch (e) {}

  /* Anything that loaded before this file runs gets told once, the same way
     js/auth.js announces FBU. */
  try {
    if (W.document && W.CustomEvent) {
      W.dispatchEvent(new W.CustomEvent("fbt-ready", { detail: FBT }));
    } else if (W.dispatchEvent && W.document && W.document.createEvent) {
      var ev = W.document.createEvent("Event");
      ev.initEvent("fbt-ready", false, false);
      W.dispatchEvent(ev);
    }
  } catch (e2) {}

  /* Start deciding straight away, so the first watchTasks() call does not pay
     for the SDK fetch, and start listening for the account changing. */
  try { ready(); } catch (e3) {}
  try { whenFBU().then(function () { watchAuth(); }); } catch (e4) {}
})();
