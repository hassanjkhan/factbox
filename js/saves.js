/* ==========================================================================
   Factbox — saved stories (bookmarks).   Exposes: window.FBS

   Sibling of progress.js, deliberately smaller. progress.js already remembers
   the furthest card reached and whether a story was finished; this file does
   NOT duplicate any of that. It stores one thing: the list of stories the
   reader put aside for later, newest first.

   Design rules, same as progress.js:
   - It must never throw. Every storage read and write is wrapped. A browser
     that refuses storage degrades to "saving unavailable" — a real, visible
     message — never to a broken page or a silently dead button.
   - ES5 only. No modules, no build step, no network calls.
   - It stands alone. It does not define, redefine or require FB or FBP. If
     neither ever loads, FBS still works.

   WHOSE SAVES ARE THESE? Saves used to belong to the BROWSER: one
   localStorage key and nothing else. On a shared phone /library showed a
   signed-out visitor five finished stories and one saved one, all of them
   the last reader's, because signing out of Firebase does not touch
   localStorage. Same defect as js/progress.js had, same fix, and
   deliberately the same shape rather than a second design:

     - customers/{uid}/profile/reading is the record. js/progress-sync.js
       carries this list there and back, alongside the reading map.
     - localStorage is a CACHE of that document, tagged with the uid it came
       from (fb_cache_owner_v1, the same key js/progress.js writes).
     - personal state is shown to a signed-in account and to nobody else.
       See the gate below.

   HONEST LIMITATIONS:
   - Signed out, this list is not shown and cannot be added to. That is the
     product decision, not an accident: a shared browser must not offer a
     stranger's library, and there is no signed-out identity to attach a save
     to. The button says so rather than silently doing nothing.
   - Safari's tracking prevention can evict script-written storage after
     roughly seven days with no visit. For a signed-in reader that now costs
     a round trip, not the list; signed out there is nothing to lose.
   - Private mode and some in-app webviews (Instagram, TikTok) refuse writes.
     There, FBS.ok is false: saving works for the length of the pageview and
     is gone on reload. The UI must say so rather than pretend.
   ========================================================================== */

var FBS = (function () {

  var KEY   = "fb_saved_v1";   /* one key, the whole list, JSON */
  var K_OWNER = "fb_cache_owner_v1"; /* whose list this is. js/progress.js
                                        writes it; this file only reads. */
  var PROBE = "fb_saveprobe";  /* written and deleted once, to learn the truth early */

  var MAX_ENTRIES = 200;       /* 51 stacks today; a cap so the key cannot grow forever */
  var MAX_BYTES   = 8000;      /* far under any quota, even a stingy webview's */

  /* _list is the source of truth in memory: an array of [id, seconds],
     newest first. Storage is where it is mirrored, not where it lives — so a
     browser that refuses writes still behaves correctly for this pageview. */
  var _list  = null;
  var _lsOK  = true;

  /* --- storage ----------------------------------------------------------- */

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { _lsOK = false; return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { _lsOK = false; return false; }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); return true; } catch (e) { _lsOK = false; return false; }
  }

  /* Learn at load time whether this browser will keep anything, so the save
     button can be honest on first paint instead of lying until the first tap.
     A store that accepts a write and hands back something else (a couple of
     webviews do exactly this) counts as dead. */
  (function probe() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) { _lsOK = false; return; }
      if (!lsSet(PROBE, "1")) return;
      if (lsGet(PROBE) !== "1") { _lsOK = false; return; }
      lsDel(PROBE);
    } catch (e) { _lsOK = false; }
  })();

  function nowSec() {
    try { return Math.floor(Date.now() / 1000); } catch (e) { return 0; }
  }

  /* A non-empty string, short enough that a junk value can never bloat the
     key. Stricter than progress.js's version on purpose: an object coerces to
     "[object Object]", and this list is rendered as covers — one bad entry
     would show up on the shelf as a story that does not exist. */
  function keyOf(id) {
    try {
      if (typeof id !== "string" && typeof id !== "number") return null;
      var s = String(id);
      if (s === "NaN" || !s.length || s.length > 40) return null;
      return s;
    } catch (e) { return null; }
  }

  /* --- the list ----------------------------------------------------------
     Stored shape: {"v":1,"s":[["03",1788308428],["07",1788308000]]}
     Seconds, not milliseconds, and no object keys — this is the compact form,
     and it stays under a kilobyte with every story in the season saved. */

  function list() {
    if (_list) return _list;
    _list = [];
    try {
      var raw = lsGet(KEY);
      if (raw) {
        var o = JSON.parse(raw);
        var arr = o && o.s;
        if (arr && arr.length) {
          var seen = {}, i, e, id, at;
          for (i = 0; i < arr.length; i++) {
            e = arr[i];
            if (!e || !e.length) continue;
            id = keyOf(e[0]);
            if (!id || Object.prototype.hasOwnProperty.call(seen, id)) continue;
            at = +e[1] || 0;
            seen[id] = 1;
            _list.push([id, at]);
          }
          _list.sort(function (a, b) { return b[1] - a[1]; });   /* newest first */
        }
      }
    } catch (e) { _list = []; }
    return _list;
  }

  function save() {
    try {
      var l = list();
      if (l.length > MAX_ENTRIES) l.length = MAX_ENTRIES;   /* oldest evicted; list is newest-first */
      var s = JSON.stringify({ v: 1, s: l });
      if (s.length > MAX_BYTES) {
        l.length = Math.min(l.length, 60);
        s = JSON.stringify({ v: 1, s: l });
      }
      if (lsSet(KEY, s)) { sync(); return true; }
      /* Quota, or a store that refuses writes. One retry at a quarter of the
         size, then give up quietly — losing a bookmark is not worth a broken
         page, and the reader is told saving is unavailable either way. */
      l.length = Math.min(l.length, 15);
      lsSet(KEY, JSON.stringify({ v: 1, s: l }));
    } catch (e) {}
    sync();
    return false;
  }

  /* --- the gate and the account mirror -------------------------------------

     Everything here is the twin of the section of the same name in
     js/progress.js, on purpose: two stores with the same defect got one
     design, not two. Read that file's comments for the reasoning; this is the
     same three ideas applied to a list instead of a map.

       owner()    which uid this cache was reconciled with, "" for nobody.
                  Written by js/progress-sync.js through js/progress.js; this
                  file only reads the key, so there is exactly one writer.
       _visible   whether the list may be SHOWN. False by default, set
                  synchronously from the auth hint below so a returning
                  reader's library is right on the first paint, then set
                  authoritatively by progress-sync once Firebase has answered.
       onChange   so a shelf can redraw when the account's answer lands.

     Reads are gated; writes are not. add() and remove() still operate on the
     underlying list whatever the gate says, because the gate is about whose
     data may be displayed, not about whether this file works. The one place
     that matters to a reader is button(), which refuses to toggle while
     hidden and says why. */

  var _visible = false;
  var _subs = [];

  function owner() {
    try { var v = lsGet(K_OWNER); return v == null ? "" : String(v); }
    catch (e) { return ""; }
  }

  /* The synchronous half of js/progress.js's hint, and the same three-line
     reasoning: does Firebase have a live session for the uid that owns this
     cache? sessionStorage first (js/progress-sync.js writes it the moment FBU
     confirms a uid), then the localStorage key Firebase Auth falls back to
     when IndexedDB is unavailable. The IndexedDB half is not duplicated here;
     the initialiser at the end of this section borrows FBP's. */
  function hintUid() {
    try { var v = String(sessionStorage.getItem("fb_live_v1") || ""); if (v) return v; }
    catch (e) {}
    try {
      if (typeof localStorage === "undefined" || !localStorage) return "";
      var n = localStorage.length, i, k, raw, o;
      for (i = 0; i < n; i++) {
        k = localStorage.key(i);
        if (!k || k.indexOf("firebase:authUser:") !== 0) continue;
        raw = localStorage.getItem(k);
        if (!raw) continue;
        o = JSON.parse(raw);
        if (o && o.uid) return String(o.uid);
      }
    } catch (e) {}
    return "";
  }

  function onChange(fn) {
    if (typeof fn !== "function") return function () {};
    try { _subs.push(fn); } catch (e) { return function () {}; }
    return function () {
      try {
        for (var i = 0; i < _subs.length; i++) {
          if (_subs[i] === fn) { _subs.splice(i, 1); return; }
        }
      } catch (e) {}
    };
  }

  function notify(reason) {
    var l, i;
    try { l = _subs.slice(0); } catch (e) { return; }
    for (i = 0; i < l.length; i++) { try { l[i](String(reason || "")); } catch (e) {} }
  }

  function listeners() { try { return _subs.length; } catch (e) { return 0; } }

  function show(on) {
    var next = !!on;
    if (next === _visible) return false;
    _visible = next;
    notify(next ? "show" : "hide");
    return true;
  }

  function visible() { return _visible; }

  /* [[id, seconds], ...] newest first — the wire form, which is also the
     stored form, so a round trip through Firestore is lossless. */
  function snapshot() {
    var out = [];
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) out.push([ l[i][0], +l[i][1] || 0 ]);
    } catch (e) {}
    return out;
  }

  /* Swap the whole list for a reconciled one. Re-validated on the way in
     exactly as list() validates what it reads from storage: this argument
     came off a network and its shape is not to be trusted. */
  function replaceAll(rows) {
    try {
      var next = [], seen = {}, i, e, id, at;
      if (rows && rows.length) {
        for (i = 0; i < rows.length && next.length < MAX_ENTRIES; i++) {
          e = rows[i];
          if (!e || !e.length) continue;
          id = keyOf(e[0]);
          if (!id || Object.prototype.hasOwnProperty.call(seen, id)) continue;
          at = Math.max(0, Math.floor(+e[1]) || 0);
          seen[id] = 1;
          next.push([id, at]);
        }
        next.sort(function (a, b) { return b[1] - a[1]; });
      }
      _list = next;
      save();
      notify("replace");
      return true;
    } catch (e) { return false; }
  }

  /* The first paint's answer, from storage only, no network — then asked
     again of IndexedDB through js/progress.js, which owns that reader. FBP is
     on every page this file is, and loads before it, but the call is guarded
     anyway: without it the answer is simply the synchronous one, which is the
     safe one. */
  (function () {
    var o = "";
    try {
      o = owner();
      _visible = !!o && o === hintUid();
    } catch (e) { _visible = false; }
    if (_visible || !o) return;
    try {
      if (typeof window !== "undefined" && window.FBP &&
          typeof window.FBP.hintAsync === "function") {
        window.FBP.hintAsync(function (uid) {
          try { if (uid && uid === owner()) show(true); } catch (e) {}
        });
      }
    } catch (e) {}
  })();

  function indexOf(id) {
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) { if (l[i][0] === id) return i; }
    } catch (e) {}
    return -1;
  }

  /* --- public surface ----------------------------------------------------- */

  function saved(id) {
    if (!_visible) return false;         /* not this viewer's library */
    try { var k = keyOf(id); return k ? indexOf(k) !== -1 : false; } catch (e) { return false; }
  }

  /* add(id) -> true when the story is saved after the call (already-saved
     counts), false only when the id is unusable. It moves an existing save
     back to the top, because re-saving is the reader saying "this one again". */
  function add(id) {
    try {
      var k = keyOf(id);
      if (!k) return false;
      var l = list(), i = indexOf(k);
      if (i !== -1) l.splice(i, 1);
      l.unshift([k, nowSec()]);
      save();
      notify("local");
      return true;
    } catch (e) { return false; }
  }

  /* remove(id) -> true when something was actually removed. */
  function remove(id) {
    try {
      var k = keyOf(id);
      if (!k) return false;
      var i = indexOf(k);
      if (i === -1) return false;
      list().splice(i, 1);
      save();
      notify("local");
      return true;
    } catch (e) { return false; }
  }

  /* toggle(id) -> the state AFTER the call: true = saved, false = not saved. */
  function toggle(id) {
    try {
      if (saved(id)) { remove(id); return false; }
      return add(id) ? true : false;
    } catch (e) { return false; }
  }

  /* all() -> [{id, at}], newest first. `at` is ms epoch, or 0 if unknown. */
  function all() {
    var out = [];
    if (!_visible) return out;
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) out.push({ id: l[i][0], at: (l[i][1] || 0) * 1000 });
    } catch (e) {}
    return out;
  }

  /* ids() -> ["03","07"], newest first. The same list without the wrapper,
     for the common case of "is this id in the set". */
  function ids() {
    var out = [];
    if (!_visible) return out;
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) out.push(l[i][0]);
    } catch (e) {}
    return out;
  }

  function count() {
    if (!_visible) return 0;
    try { return list().length; } catch (e) { return 0; }
  }

  function clear() {
    try {
      _list = [];
      _visible = false;                  /* signed out shows nothing */
      lsDel(KEY);
      sync();
      notify("clear");
      return true;
    } catch (e) { return false; }
  }

  /* --- the save button ----------------------------------------------------
     Built entirely from inline styles, so it needs no CSS from app.css or any
     file another agent owns, and cannot be broken by one. A real <button>
     with aria-pressed and a 44px target — a save control that is a <div> is
     invisible to a screen reader and unreachable from a keyboard.

     A bookmark, not the word "Save". This button lives on the reader, pinned
     over a painting, at the foot of the right edge under the sound control —
     and the bookmark is the one icon every phone already teaches: Instagram,
     TikTok and X all save with it, all in that same corner, all
     filled-when-saved.
     A word there is a caption competing with the picture; the icon is read
     without being read. The outline fills with coral when the story is in
     the library, which is the whole state model, visible at a glance.

     The sentence still exists for anyone who cannot see the icon — it moved
     into aria-label ("Save to library: <title>" / "Remove from library:
     <title>") and aria-pressed, which is where a screen reader looks anyway.

     button(id, onToggle, title) -> HTMLButtonElement, or null if there is no DOM.
       onToggle(isSaved, id) fires after every successful toggle, and ONLY
                  then. It is a report of a TAP, not of a repaint. The
                  callers on all four readers turn it straight into
                  save_add / save_remove, so anything else that calls it is
                  a wrong number in the funnel — see the note at b.unbind.
       title      the story's name, for the accessible label. Optional: with
                  no title the label is the same sentence without it.
       el.refresh()  repaints from the store (call it if you change saves
                     elsewhere on the same screen).
       el.stackId    the id it is bound to.

     When storage is dead the button paints "Saving unavailable" and disables
     itself. A button that silently forgets is worse than one that says so. */
  function button(id, onToggle, title) {
    try {
      if (typeof document === "undefined" || !document || !document.createElement) return null;
      var k = keyOf(id);
      var name = (typeof title === "string" && title) ? ": " + title : "";

      var b = document.createElement("button");
      b.type = "button";
      b.className = "fbs-save";
      /* This button already reports itself: read.html passes an onToggle that
         fires save_add / save_remove. js/analytics.js's one delegated click
         listener reads data-fbt="-" as "counted elsewhere, do not send
         ui_click for this" — without it the same tap would be counted twice
         and every funnel built on save_add would be wrong. */
      try { b.setAttribute("data-fbt", "-"); } catch (e) {}
      b.stackId = k;

      /* 38px circle: the rail above it carries .fb-sound at 38px and the
         "← Stories" pill opposite is 38px too, and controls at three
         different sizes over one painting is the thing you notice instead of
         the painting. Under the 44px guideline, matching what this page has
         always shipped for the other two. */
      var BASE =
        "display:inline-flex;align-items:center;justify-content:center;" +
        "width:38px;height:38px;min-height:38px;padding:0;border-radius:999px;" +
        "cursor:pointer;-webkit-tap-highlight-color:transparent;" +
        "-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);";

      /* One path, drawn twice: stroked when the story is not saved, filled
         when it is. `currentColor` means the two states are one colour swap. */
      function mark(fill) {
        return '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" ' +
               'fill="' + (fill ? "currentColor" : "none") + '" stroke="currentColor" ' +
               'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
               '<path d="M6.5 3.75h11a.75.75 0 0 1 .75.75v15.4l-6.25-4.1-6.25 4.1V4.5a.75.75 0 0 1 .75-.75z"/>' +
               '</svg>';
      }

      function paint() {
        try {
          /* Signed out there is no library to put this in and nothing that
             would survive the tap, so the button says so instead of filling
             in and emptying again a second later. Same dimmed treatment as a
             dead store: the icon stays, because a control that vanishes reads
             as a bug. */
          /* Signed out is not the same as broken.

             This used to grey the button out and say, in a tooltip nobody on a
             phone can open, "Sign in to save stories to your library." A reader
             who wants to save a story was told no by a control that looked
             dead, with the way to say yes hidden inside an attribute. So the
             signed-out button is live now and takes them to sign in — the tap
             does something, which is the whole point of a button.

             The genuinely dead cases below are different and stay dead: no
             story to save, or a browser that refuses to remember anything.
             Nothing the reader does will change either. */
          if (!_visible && _lsOK && k) {
            b.disabled = false;
            b.removeAttribute("aria-disabled");
            b.removeAttribute("aria-pressed");
            b.innerHTML = mark(false);
            b.title = "Sign in to save this story";
            b.setAttribute("aria-label", b.title);
            b.style.cssText = BASE +
              "background:rgba(20,16,26,.86);color:#FFF7ED;" +
              "border:1px solid rgba(255,247,237,.22);";
            return;
          }
          if (!_lsOK || !k || !_visible) {
            b.disabled = true;
            b.setAttribute("aria-disabled", "true");
            b.removeAttribute("aria-pressed");
            /* No room for a sentence on a 38px button, so the sentence goes
               where a disabled control is actually interrogated: the tooltip
               and the accessible name. The icon stays, dimmed, rather than
               vanishing — a control that disappears reads as a bug. */
            b.innerHTML = mark(false);
            b.title = !k ? "No story to save."
              : (!_lsOK ? "This browser will not let the site remember anything."
                        : "Sign in to save stories to your library.");
            b.setAttribute("aria-label", b.title);
            /* .52, matching --dimmer in app.css. .42 did not clear contrast
               on --raise, and this button paints itself. */
            b.style.cssText = BASE +
              "background:rgba(255,247,237,.07);color:rgba(255,247,237,.52);" +
              "border:1px solid rgba(255,247,237,.13);cursor:default;";
            return;
          }
          var on = saved(k);
          b.setAttribute("aria-pressed", on ? "true" : "false");
          b.setAttribute("aria-label", (on ? "Remove from library" : "Save to library") + name);
          b.innerHTML = mark(on);
          b.title = on ? "Saved to your library" : "Save to your library";
          b.style.cssText = BASE + (on
            ? "background:rgba(255,122,92,.16);color:#FF7A5C;" +
              "border:1px solid rgba(255,122,92,.42);"
            : "background:rgba(20,16,26,.86);color:#FFF7ED;" +
              "border:1px solid rgba(255,247,237,.22);");
        } catch (e) {}
      }

      try {
        b.addEventListener("click", function () {
          try {
            /* Signed out: this is the sign-in button. Carry where they are so
               they come back to the story rather than to a home page — the
               same next= the account insignia uses. */
            if (!_visible && _lsOK && k) {
              var back = "";
              try {
                var pth = String(location.pathname || "").replace(/^\/+/, "") +
                          String(location.search || "");
                if (/^[A-Za-z0-9._~\/?=&-]{0,96}$/.test(pth)) back = encodeURIComponent(pth);
              } catch (x) {}
              try { location.href = "/login" + (back ? "?next=" + back : ""); } catch (x2) {}
              return;
            }
            if (!_lsOK || !k) return;
            var on = toggle(k);
            paint();
            if (typeof onToggle === "function") onToggle(on, k);
          } catch (e) {}
        });
      } catch (e) {}

      b.refresh = paint;
      /* The account's answer arrives ~600ms after the reader does. Without
         this the button is stuck on whatever the first paint guessed.

         THIS SUBSCRIBES TO THE STORE, NOT TO THE CALLER. It used to read
         `onChange(...)`, and until the parameter above was renamed that name
         resolved to the CALLER'S callback, not to the module's subscribe
         function eleven lines from the top of this file. So every reader
         built a save button by handing us a function, and we called that
         function back, once, at build time, with a function as its first
         argument — truthy — which read.html and the three composed story
         pages turn directly into:

             FB.track(isSaved ? "save_add" : "save_remove", { stack: s.id })

         One save_add per story opened, free or locked, saved or not, before
         the reader had touched anything. Every save_add on the dashboard
         since this button shipped is a page load. Reproduced in Chrome:
         /read?s=01, no interaction, save_add{stack:"01"} in the first
         second. The number was not slightly high, it was the story-open
         count wearing a different name.

         The rename is the fix, and it is the fix rather than a guard inside
         the callback because the caller cannot defend itself against being
         called: it has no way to tell a real toggle from this. `onToggle`
         now means a tap and nothing else, and the repaint hangs off the
         store's own subscribe, which is what it always meant to. */
      try { b.unbind = onChange(function () { try { paint(); } catch (e) {} }); }
      catch (e) {}
      paint();
      return b;
    } catch (e) { return null; }
  }

  /* --- exports ------------------------------------------------------------
     `ok` is a plain property, refreshed after every storage access, so a
     store that only fails on the first real write still reports the truth. */
  var api = {
    saved: saved, toggle: toggle, add: add, remove: remove,
    all: all, ids: ids, count: count, clear: clear,
    button: button, ok: _lsOK, KEY: KEY,
    /* the account mirror's seam — see js/progress-sync.js */
    owner: owner, hintUid: hintUid,
    show: show, visible: visible,
    snapshot: snapshot, replaceAll: replaceAll,
    onChange: onChange, listeners: listeners,
    LIMITS: { entries: MAX_ENTRIES, bytes: MAX_BYTES }
  };

  function sync() { try { api.ok = _lsOK; } catch (e) {} }

  /* Reading the key once here means `ok` is already correct for a store whose
     getItem throws, before anyone has tried to save anything. */
  try { list(); } catch (e) {}
  sync();

  return api;
})();
