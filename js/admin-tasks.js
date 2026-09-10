/* ==========================================================================
   Factbox — the shared task board, live, for the two people who run this.
   Exposes: window.FBT

   WHAT THIS IS. Hassan and Kathryn both keep a list of what is outstanding,
   and until now those lists were in two heads and a DM thread. This file is
   the storage under one board they both edit at the same time: two
   collections, live snapshots, and writes that stamp themselves.

       admin_tasks/{id}    a thing to do, optionally by a day
       admin_goals/{id}    a thing to hit, with a human deadline
       .../{id}/comments/  what the two of them said about it, one document
                           each, under either of the two above

   A task carries LABELS — a list, several per task, invented by typing one —
   which replace the single `area` it used to have; `area` is still read for
   the rows that have not been migrated and is never written again. It also
   carries WHO MADE IT and WHO CLOSED IT from today onwards, and honestly
   admits it does not know for the 149 rows that predate those fields.

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

  /* COMMENTS LIVE UNDER THE TASK, one document each:

         admin_tasks/{id}/comments/{commentId}
         admin_goals/{id}/comments/{commentId}

     A SUBCOLLECTION AND NOT AN ARRAY FIELD ON THE TASK, for three reasons and
     the first is the one that decides it:

       1. The conflict rule at the top of this file is a FIELD-LEVEL merge, so
          the unit that can be lost is one field. An array of comments IS one
          field: Kathryn posting while Hassan posts means one array overwrites
          the other and a sentence somebody typed disappears with nothing on
          screen to say so. Two documents cannot collide.
       2. firestore.rules pins the task's key set with hasOnly(), and it can
          check the SHAPE of a document but not of every element of a growing
          array. A comment per document gets the same per-write validation
          every other document here gets — length, author, server clock.
       3. Every board on both screens listens to `admin_tasks`. A comment field
          on the task would push the whole thread to both browsers on every
          keystroke-sized write, for 140 tasks nobody has open. The subcollection
          is listened to only while its task's detail view is open, and torn
          down when it closes.

     The cost is that Firestore does not cascade a delete: removing a task
     leaves its comments behind. deleteTask() sweeps them, and the rules let
     either admin delete a comment whose task is already gone precisely so that
     sweep cannot half-fail on the other person's comments. */
  var COMMENTS = "comments";

  /* A thread hangs under a task OR a goal, and everything below is written
     once over the parent collection rather than twice: one watcher, one
     writer, one deleter, one set of rules. A goal is the thing most worth
     arguing about on this board and the argument belongs on the goal. */
  function parentOf(coll) {
    var c = "";
    try { c = String(coll || ""); } catch (e) { c = ""; }
    return (c === GOALS) ? GOALS : TASKS;
  }

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
  /* A comment is a remark on a task, not a document. Long enough for a
     paragraph and a link, short enough that the rules can refuse a megabyte
     pasted into the box by accident. */
  var MAX_COMMENT = 1000;
  /* A display name is a convenience, never the fact. See whoName(). */
  var MAX_NAME = 60;

  /* LABELS — the tags a task is filed under, several per task.

     They replace `area`, which was the same idea with one value and no way to
     make a new one from the board. `area` is still READ (149 rows carry one
     and nothing else) and is never written again; labelsOf() below folds an
     old row's single area into the list so a board looks the same before and
     after the migration.

         labels        a list of strings
         MAX_LABELS    6 per task
         MAX_LABEL     24 characters each
         shape         ^[a-z0-9][a-z0-9-]{0,23}$

     THE NORMALISATION, stated once, because a tag system whose members are
     "Back End", "back end" and "back-end" is three tag systems: lowercase,
     trim, every run of whitespace, underscore or hyphen collapses to ONE
     hyphen, everything outside [a-z0-9-] is dropped, leading and trailing
     hyphens are removed, empties are discarded, duplicates are discarded, and
     the list is sorted. Sorted rather than kept in typing order so that two
     browsers that add the same two labels in a different order converge on the
     same array instead of overwriting each other with equivalent values. */
  var MAX_LABELS = 6;
  var MAX_LABEL  = 24;

  /* ----------------------------------------------------------------------
     `due` — the day a task is WANTED by. A calendar day, and stored as the
     string "YYYY-MM-DD", not as a Timestamp. Three reasons, and the first is
     the one that decides it:

       1. A Timestamp is an INSTANT, so storing a day as one forces a
          time-of-day and a zone, and then reading it back in the browser's
          zone moves it. "due 10 Sep" written as 2026-09-10T00:00:00Z prints
          as 9 Sep for anybody west of Greenwich. `doneAt` is genuinely an
          instant — the moment somebody pressed the button — and stays a
          Timestamp for exactly that reason. A due date is not.
       2. It sorts and compares as a plain string: "2026-09-08" < "2026-09-10"
          is chronological, no arithmetic, no DST, no leap second.
       3. firestore.rules can pin the FORMAT of a string with matches(); it
          cannot say anything at all about which instant a timestamp is.

     It is OPTIONAL and the empty string is how "no date" is spelled — the
     same way `detail` and `area` are empty rather than absent. The 130-odd
     rows already on the board have no `due` key at all; isoDay() turns both
     that and an empty string into "", so nothing downstream has to tell them
     apart, and nothing ever hands a missing value to `new Date`.
     ---------------------------------------------------------------------- */
  var DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

  /* One label, normalised, or "". Total: a number, a null, an object, a string
     of punctuation and "  Back   END " all go in and either a clean tag or the
     empty string comes out. */
  function label(v) {
    var t = "";
    try { t = (v == null) ? "" : String(v); } catch (e) { return ""; }
    try {
      t = t.toLowerCase();
      t = t.replace(/[\s_-]+/g, "-");        /* spaces, underscores, dashes -> one dash */
      t = t.replace(/[^a-z0-9-]+/g, "");     /* everything else is dropped */
      t = t.replace(/-+/g, "-");
      t = t.replace(/^-+|-+$/g, "");
    } catch (e2) { return ""; }
    if (t.length > MAX_LABEL) t = t.slice(0, MAX_LABEL).replace(/-+$/g, "");
    return t;
  }

  /* A whole list, normalised, de-duplicated, sorted and capped. Accepts an
     array, a comma-separated string, or nothing. */
  function labelList(v) {
    var raw = [], out = [], seen = {}, i, one;
    if (v == null) return out;
    if (typeof v === "string") { raw = v.split(","); }
    else if (Object.prototype.toString.call(v) === "[object Array]") { raw = v; }
    else { return out; }
    for (i = 0; i < raw.length; i++) {
      one = label(raw[i]);
      if (!one) continue;
      if (Object.prototype.hasOwnProperty.call(seen, one)) continue;
      seen[one] = true;
      out.push(one);
      if (out.length >= MAX_LABELS) break;
    }
    out.sort();
    return out;
  }

  /* What a row is filed under, whichever era it was written in. `labels` when
     it has them; the old single `area` folded into a one-element list when it
     does not. One value for the UI to read, so nothing downstream has to know
     that a migration happened. */
  function labelsOf(d) {
    var have = labelList(d && d.labels);
    if (have.length) return have;
    var one = label(d && d.area);
    return one ? [one] : [];
  }

  /* A calendar day, or "". Total: undefined, null, a number, a Timestamp, a
     half-typed "2026-09-" and the string "next tuesday" all come back "".
     A shape that PARSES but is not a real day — "2026-02-31", "2026-13-01" —
     is refused too, by building the date in UTC and checking every field
     survived the round trip. UTC on purpose: this function must give the same
     answer in Auckland as in Los Angeles. */
  function isoDay(v) {
    var s = "";
    try { s = (v == null) ? "" : String(v); } catch (e) { return ""; }
    try { s = s.replace(/^\s+|\s+$/g, ""); } catch (e2) { return ""; }
    if (!s) return "";
    var m = DUE_RE.exec(s);
    if (!m) return "";
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!isFinite(y) || !isFinite(mo) || !isFinite(d)) return "";
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (!isFinite(t.getTime())) return "";
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== (mo - 1) || t.getUTCDate() !== d) return "";
    return s;
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

  /* { kind, parent, id, fn, unsub }. `kind` is the collection name, or
     "comments"; `parent` and `id` name the task or goal a thread hangs under
     and are "" for the other two. */
  var watchers = [];

  function normTask(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      title: str(d.title, MAX_TITLE),
      detail: str(d.detail, MAX_DETAIL),
      owner: oneOf(d.owner, OWNERS, "either"),
      priority: oneOf(d.priority, PRIORITIES, "low"),
      status: oneOf(d.status, STATUSES, "todo"),
      /* READ, never written again. Kept so a row that has not been migrated
         yet still shows the tag it was filed under. */
      area: str(d.area, MAX_AREA),
      labels: labelsOf(d),
      /* "" for the 130 rows written before this field existed, and for every
         row nobody put a date on. Never null, never 0, never a Date. */
      due: isoDay(d.due),
      order: num(d.order, 0),
      /* milliseconds, not Timestamps: the UI formats and sorts these, and a
         Timestamp is neither comparable nor printable without the SDK. 0
         means "not set", which for doneAt is the ordinary case. */
      createdAt: toMs(d.createdAt),
      updatedAt: toMs(d.updatedAt),
      doneAt: toMs(d.doneAt),
      updatedBy: str(d.updatedBy, 128),
      /* WHO MADE IT AND WHO CLOSED IT, and the honest part is that for most of
         this collection the answer is "" and must stay "".

         `updatedBy` is the LAST writer and nothing more. On ~125 of these rows
         it is literally the string "seed", because tools/seed-tasks.js wrote
         them from git commits; on the rest it is whoever touched the row most
         recently, which is not the same person as whoever typed it. There is
         no field anywhere in this collection that says who created a task
         before today, and there is no way to recover one. So these four are
         written from now on and are "" for every row that predates them, and
         the UI is required to say "not recorded" rather than fall back to
         `updatedBy` — a board that guesses at authorship on a shared record is
         worse than a board that admits it does not know.

         The uid is the FACT: firestore.rules pins createdBy and doneBy to the
         uid on the writer's own ID token, so neither can be forged. The name
         beside it is what that account called itself at the time, is supplied
         by the client, and is a convenience for printing — never evidence. */
      createdBy: str(d.createdBy, 128),
      createdByName: str(d.createdByName, MAX_NAME),
      doneBy: str(d.doneBy, 128),
      doneByName: str(d.doneByName, MAX_NAME),
      raw: d
    };
  }

  /* One remark on one task. `at` is the server's clock, `by` is the uid the
     rules checked, `byName` is what that account called itself. */
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

  function normGoal(id, d) {
    d = d || {};
    return {
      id: String(id || ""),
      title: str(d.title, MAX_TITLE),
      detail: str(d.detail, MAX_DETAIL),
      target: str(d.target, MAX_TARGET),
      /* A goal already carries a free-text `target` ("200 subscribers by the
         end of October"). That is the MEASURE and it stays prose; this is the
         date, and it is a date so the card can say "overdue" without anybody
         parsing English. */
      due: isoDay(d.due),
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

  /* Oldest first, which is the order a conversation happened in. A comment
     whose serverTimestamp() has not landed yet reads back as 0 for one frame;
     0 sorts it LAST rather than to the top of the thread, which is where the
     person who just typed it expects to see it. */
  function sortComments(rows) {
    rows.sort(function (a, b) {
      var aa = a.at || Infinity, bb = b.at || Infinity;
      if (aa !== bb) return aa - bb;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return rows;
  }

  function normFor(kind, id, d) {
    if (kind === TASKS) return normTask(id, d);
    if (kind === GOALS) return normGoal(id, d);
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
          var doc2 = qs.docs[i];
          rows.push(normFor(kind, doc2.id, doc2.data()));
        }
      }
    } catch (e2) {}
    return kind === COMMENTS ? sortComments(rows) : sortRows(rows);
  }

  /* The collection a watcher is watching. A comments watcher is the only one
     with a parent, and it is addressed by path segments rather than by a
     string join so an id with a slash in it cannot escape its task. */
  function colFor(w) {
    if (w.kind === COMMENTS) {
      if (!w.id || !w.parent) return null;
      return sdk.collection(db, w.parent, w.id, COMMENTS);
    }
    return sdk.collection(db, w.kind);
  }

  function attach(w) {
    if (w.unsub || !db || !sdk) return;
    try {
      var col = colFor(w);
      if (!col) { call(w.fn, []); return; }
      w.unsub = sdk.onSnapshot(
        col,
        function (qs) { call(w.fn, readSnap(qs, w.kind)); },
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

  function watch(kind, parent, id, fn) {
    if (!isFn(fn)) return noop;
    var w = { kind: kind, parent: parent || "", id: str(id, 200), fn: fn, unsub: null };
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

  function watchTasks(fn) { return watch(TASKS, "", "", fn); }
  function watchGoals(fn) { return watch(GOALS, "", "", fn); }

  /* The thread on ONE task, live, for exactly as long as somebody has that
     task open. Returns its own unsubscribe; the detail view calls it when it
     closes, and detachAll() catches it too if the account changes underneath.
     Nothing subscribes to a thread nobody is reading. */
  function watchComments(coll, id, fn) {
    var i = str(id, 200);
    if (!i) { if (isFn(fn)) later(function () { call(fn, []); }); return noop; }
    return watch(COMMENTS, parentOf(coll), i, fn);
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

  /* The display half of an authorship stamp. The uid beside it is the fact —
     the rules check it against the ID token and it cannot be forged — and this
     is only what the account calls itself, so that a detail view can print
     "Kathryn" instead of a 28-character uid nobody can read. It is written
     ONCE, at the moment the thing happens, and firestore.rules refuses to let
     a later edit change it: an authorship line that could be rewritten
     afterwards is not a record of anything. */
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
    /* `area` is never written by this file again — not on create, not on
       update, not even as "". The board sends `labels`; a caller that still
       passes an area has it folded into the list rather than stored, so the
       one-value era ends at the first edit of each row. */
    if (forCreate || has("labels") || has("area")) {
      out.labels = labelList(has("labels") ? o.labels : o.area);
    }
    /* Clearing a due date is `due: ""`, which is a write of the empty string
       rather than a deleteField(): the rules accept both "absent" and "", the
       board reads them identically, and "" needs no extra SDK import on a page
       that is deliberately one dynamic import deep. */
    if (forCreate || has("due"))      out.due      = isoDay(o.due);
    if (forCreate || has("order"))    out.order    = num(o.order, forCreate ? nowOrder() : 0);

    /* doneAt is derived, not typed. A task that just became done is stamped
       with the server's clock; a task that came back out of done loses the
       stamp. The caller may clear it explicitly with doneAt: null and may not
       set it to anything else — a board that lets you backdate a completion
       is a board that cannot answer "what did we do last week". */
    var m = me();

    function closedBy() {
      out.doneAt = sdk.serverTimestamp();
      out.doneBy = m ? m.uid : null;
      out.doneByName = m ? whoName() : null;
    }
    function notClosed() {
      out.doneAt = null;
      out.doneBy = null;
      out.doneByName = null;
    }

    if (has("status")) {
      if (out.status === "done") closedBy(); else notClosed();
    } else if (has("doneAt") && o.doneAt === null) {
      notClosed();
    } else if (forCreate) {
      if (out.status === "done") closedBy(); else notClosed();
    }

    /* WRITTEN ON CREATE AND NEVER AGAIN. The rules pin these to the ID token
       on the create and then require every later update to send them back
       unchanged — which also means an update can never ADD them to one of the
       140 rows that has none. That is deliberate and it is the whole point:
       the only way a task gets an author is by being created by somebody
       holding an account, and a row created before this existed stays
       honestly authorless rather than acquiring whoever edited it next.

       Omitted rather than written empty when there is somehow no signed-in
       user: "" is not a uid, and the rules would refuse the write outright
       rather than let a blank author through. */
    if (forCreate && m) {
      out.createdBy = m.uid;
      out.createdByName = whoName();
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
    if (forCreate || has("due"))    out.due    = isoDay(o.due);
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

  /* Deleting a task deletes its thread. Firestore does NOT cascade — a
     subcollection outlives its parent document and would sit there forever,
     invisible, counting against the bill and readable by anyone who guessed
     the path. So the task goes first and the comments are swept after:

       - task first, so that if the sweep fails half-way the row is already
         gone from both boards rather than sitting there with a thread nobody
         can see the top of;
       - and the rules let EITHER admin delete a comment whose task no longer
         exists, precisely so this sweep does not stop at the first comment the
         other person wrote. While the task is alive, a comment belongs to
         whoever wrote it.

     The sweep is best-effort by design: a dropped connection between the two
     writes leaves orphans, and the honest handling is that the task delete —
     the thing the person asked for — still reports success. */
  function sweepComments(coll, id) {
    if (!isFn(sdk.getDocs)) return Promise.resolve(true);
    var col;
    try { col = sdk.collection(db, parentOf(coll), id, COMMENTS); } catch (e) { return Promise.resolve(true); }
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

  function deleteTask(id) {
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      return delIn(TASKS, i).then(function () { return sweepComments(TASKS, i); });
    });
  }

  /* ======================================================================
     Comments. One document per remark under the task it is about.

     No update path, and that is a decision rather than an omission: a comment
     is a record of something one of them said, and a record that can be
     silently rewritten afterwards is not a record. Wrong comment, delete it
     and say the next thing — which leaves the fact that something was removed
     visible in the thread's shape rather than rewriting history in place.
     ====================================================================== */

  function addComment(coll, id, text) {
    return guard().then(function () {
      var c = parentOf(coll);
      var i = str(id, 200);
      if (!i) throw new Error("no id");
      var t = str(text, MAX_COMMENT);
      if (!t) throw new Error("a comment needs something in it");
      var m = me();
      if (!m) throw new Error("not writable: signed-out");
      var payload = {
        text: t,
        by: m.uid,
        byName: whoName(),
        /* The server's clock, never the browser's: a comment stamped by a
           phone with the wrong time would sort into the middle of a
           conversation it was not part of. */
        at: sdk.serverTimestamp()
      };
      var col = sdk.collection(db, c, i, COMMENTS);
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

  function deleteComment(coll, id, commentId) {
    return guard().then(function () {
      var p = parentOf(coll), i = str(id, 200), c = str(commentId, 200);
      if (!i || !c) throw new Error("no id");
      return Promise.resolve(sdk.deleteDoc(sdk.doc(db, p, i, COMMENTS, c)))
        .then(function () { return true; });
    });
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
    return guard().then(function () {
      var i = str(id, 200);
      if (!i) return reject("no id");
      return delIn(GOALS, i).then(function () { return sweepComments(GOALS, i); });
    });
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
    watchComments: watchComments,

    addTask: addTask,
    updateTask: updateTask,
    deleteTask: deleteTask,

    addComment: addComment,
    deleteComment: deleteComment,

    addGoal: addGoal,
    updateGoal: updateGoal,
    deleteGoal: deleteGoal,

    me: me,

    /* Published so the board and any future tool coerce a typed date exactly
       the way a write does, rather than each inventing its own idea of what
       "2026-02-31" means. */
    isoDay: isoDay,
    DUE_FORMAT: "YYYY-MM-DD",

    /* Published for the same reason isoDay is: the board, the label editor and
       any future tool must all agree on what "Back End" becomes, rather than
       each rolling its own and filling the collection with synonyms. */
    label: label,
    labelList: labelList,
    labelsOf: labelsOf,

    OWNERS: OWNERS,
    PRIORITIES: PRIORITIES,
    STATUSES: STATUSES,
    GOAL_STATUSES: GOAL_STATUSES,

    MAX_TITLE: MAX_TITLE,
    MAX_DETAIL: MAX_DETAIL,
    MAX_AREA: MAX_AREA,
    MAX_TARGET: MAX_TARGET,
    MAX_COMMENT: MAX_COMMENT,
    MAX_LABELS: MAX_LABELS,
    MAX_LABEL: MAX_LABEL,

    COLLECTIONS: { tasks: TASKS, goals: GOALS, comments: COMMENTS },
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
