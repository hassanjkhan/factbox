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

   HONEST LIMITATIONS:
   - Saves live in this browser's localStorage and are never sent anywhere.
     Clearing site data loses them, and Safari's tracking prevention can evict
     script-written storage after roughly seven days with no visit. There is
     no way to back them up without a server.
   - Private mode and some in-app webviews (Instagram, TikTok) refuse writes.
     There, FBS.ok is false: saving works for the length of the pageview and
     is gone on reload. The UI must say so rather than pretend.
   ========================================================================== */

var FBS = (function () {

  var KEY   = "fb_saved_v1";   /* one key, the whole list, JSON */
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

  function indexOf(id) {
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) { if (l[i][0] === id) return i; }
    } catch (e) {}
    return -1;
  }

  /* --- public surface ----------------------------------------------------- */

  function saved(id) {
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
    try {
      var l = list();
      for (var i = 0; i < l.length; i++) out.push(l[i][0]);
    } catch (e) {}
    return out;
  }

  function count() {
    try { return list().length; } catch (e) { return 0; }
  }

  function clear() {
    try { _list = []; lsDel(KEY); sync(); return true; } catch (e) { return false; }
  }

  /* --- the save button ----------------------------------------------------
     Built entirely from inline styles, so it needs no CSS from app.css or any
     file another agent owns, and cannot be broken by one. A real <button>
     with aria-pressed and a 44px target — a save control that is a <div> is
     invisible to a screen reader and unreachable from a keyboard.

     A bookmark, not the word "Save". This button lives on the reader, pinned
     over a painting, next to "← Stories" and the sound control — and the
     bookmark is the one icon every phone already teaches: Instagram, TikTok
     and X all save with it, all in the same corner, all filled-when-saved.
     A word there is a caption competing with the picture; the icon is read
     without being read. The outline fills with coral when the story is in
     the library, which is the whole state model, visible at a glance.

     The sentence still exists for anyone who cannot see the icon — it moved
     into aria-label ("Save to library: <title>" / "Remove from library:
     <title>") and aria-pressed, which is where a screen reader looks anyway.

     button(id, onChange, title) -> HTMLButtonElement, or null if there is no DOM.
       onChange(isSaved, id) fires after every successful toggle.
       title      the story's name, for the accessible label. Optional: with
                  no title the label is the same sentence without it.
       el.refresh()  repaints from the store (call it if you change saves
                     elsewhere on the same screen).
       el.stackId    the id it is bound to.

     When storage is dead the button paints "Saving unavailable" and disables
     itself. A button that silently forgets is worse than one that says so. */
  function button(id, onChange, title) {
    try {
      if (typeof document === "undefined" || !document || !document.createElement) return null;
      var k = keyOf(id);
      var name = (typeof title === "string" && title) ? ": " + title : "";

      var b = document.createElement("button");
      b.type = "button";
      b.className = "fbs-save";
      b.stackId = k;

      /* 38px circle: the same rail carries .back (38px, app.css) on the left
         and .fb-sound (38px) on the right, and three controls at three
         heights across one strip of glass is the thing you notice instead of
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
          if (!_lsOK || !k) {
            b.disabled = true;
            b.setAttribute("aria-disabled", "true");
            b.removeAttribute("aria-pressed");
            /* No room for a sentence on a 38px button, so the sentence goes
               where a disabled control is actually interrogated: the tooltip
               and the accessible name. The icon stays, dimmed, rather than
               vanishing — a control that disappears reads as a bug. */
            b.innerHTML = mark(false);
            b.title = k
              ? "This browser will not let the site remember anything."
              : "No story to save.";
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
            ? "background:rgba(76,155,232,.16);color:#4C9BE8;" +
              "border:1px solid rgba(76,155,232,.42);"
            : "background:rgba(20,16,26,.86);color:#FFF7ED;" +
              "border:1px solid rgba(255,247,237,.22);");
        } catch (e) {}
      }

      try {
        b.addEventListener("click", function () {
          try {
            if (!_lsOK || !k) return;
            var on = toggle(k);
            paint();
            if (typeof onChange === "function") onChange(on, k);
          } catch (e) {}
        });
      } catch (e) {}

      b.refresh = paint;
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
    button: button, ok: _lsOK, KEY: KEY
  };

  function sync() { try { api.ok = _lsOK; } catch (e) {} }

  /* Reading the key once here means `ok` is already correct for a store whose
     getItem throws, before anyone has tried to save anything. */
  try { list(); } catch (e) {}
  sync();

  return api;
})();
