/* ==========================================================================
   Factbox — paid-access persistence and reading memory.   Exposes: window.FBP

   Companion to gate.js. gate.js decides whether the reader is unlocked right
   now; this file decides whether that survives — a cleared webview, a second
   browser, a phone swapped for a laptop — and remembers where in each story
   the reader stopped.

   HONEST LIMITATIONS, kept next to the code so they cannot drift:

   1. This is still not a security boundary. gate.js says it and it is still
      true: data/stacks.json is a public file. Anyone who opens dev tools can
      read all fifty-one stories without paying, and nothing here changes
      that. What this file buys is that a person who DID pay is not asked to
      pay twice.

   2. The restore link is a bearer token. There is no server, so there is
      nothing to check a token against — possession is the whole proof.
      Anyone the buyer forwards the link to gets access, and so does anyone
      who finds it in a screenshot. That is inherent to a static site, not a
      bug in this file. The only fix is a server.

   3. Access still cannot follow a person to a device they never opened the
      link on. Storage is per-browser. The restore link is the bridge, and it
      only works if the buyer still has it — which is why it is minted at
      purchase, stored, and rebuildable from FBP.restoreURL() forever after.

   4. Reading memory is no longer per-browser for a reader with an account.
      js/progress-sync.js mirrors it to customers/{uid}/profile/reading, so
      it follows the person rather than the phone. localStorage is now a
      CACHE of that document, not the record. Two things follow, and both
      are load-bearing:

        - the cache is TAGGED with the uid it came from (K_OWNER). A map
          tagged with an account is not shown to a different account, and is
          not shown to a signed-out visitor. That is the whole of the bug
          this was written for: a shared browser wearing the last reader's
          blue ticks.
        - a reader with no account still gets everything they had before.
          Untagged progress is theirs, stays local, is never sent anywhere,
          and is never cleared by anything here.

   Design rules this file obeys without exception:
   - It must never throw. Every storage read, every storage write, every
      cookie access and every DOM lookup is wrapped. A storage failure
      degrades to "no memory"; it never degrades to a blank page.
   - ES5 only. No modules, no build step, no network calls.
   - It does not define, redefine or require FB. If gate.js loaded first,
      FBP agrees with it. If gate.js never loads, FBP still works.
   ========================================================================== */

var FBP = (function () {

  /* --- keys ---------------------------------------------------------------
     fb_unlocked_v1 is gate.js's key and is deliberately shared, so the two
     files can never disagree about whether the reader has paid. */
  var K_UNLOCK = "fb_unlocked_v1";
  var K_TOKEN  = "fb_pass_v1";      /* the restore token, so the link is rebuildable */
  var K_SRC    = "fb_passsrc_v1";   /* where access came from: stripe | restore | local */
  var K_READ   = "fb_read_v1";      /* the whole reading memory, one key, JSON */
  var K_OWNER  = "fb_cache_owner_v1"; /* whose personal state this browser holds.
                                         js/saves.js reads the same key. */

  var CANON        = "https://factbox.app";
  var MAX_ENTRIES  = 60;      /* 51 stacks today; room to grow, still tiny */
  var MAX_BYTES    = 20000;   /* well under any localStorage quota */
  var WRITE_DELAY  = 1200;    /* ms; scroll fires constantly, storage should not */
  var MIN_RESUME   = 1;       /* card 0 is the hook — never offer to resume it */

  var RESTORE_NOTE =
    "This link re-opens your stories on any phone or browser. Anyone you " +
    "send it to gets in too, so keep it to yourself.";

  /* --- storage: two stores, either one is enough --------------------------
     localStorage is the real store. A cookie mirrors only the two small
     access values, because some in-app webviews (Instagram, TikTok) hand out
     a localStorage that is wiped between sessions while cookies survive.
     The reading map is never mirrored to a cookie: it is far too big, and
     cookies ride along on every request. */

  var lsOK = true;

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { lsOK = false; return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { lsOK = false; return false; }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); return true; } catch (e) { return false; }
  }

  function ckGet(k) {
    try {
      var all = " " + (document.cookie || "");
      var i = all.indexOf(" " + k + "=");
      if (i === -1) { i = all.indexOf(";" + k + "="); if (i === -1) return null; }
      var s = all.indexOf("=", i) + 1;
      var e = all.indexOf(";", s); if (e === -1) e = all.length;
      return decodeURIComponent(all.slice(s, e));
    } catch (e) { return null; }
  }
  function ckSet(k, v, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + (days || 365) * 86400000);
      document.cookie = k + "=" + encodeURIComponent(v) +
        ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax" +
        (location.protocol === "https:" ? ";Secure" : "");
      return true;
    } catch (e) { return false; }
  }
  function ckDel(k) {
    try { document.cookie = k + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"; } catch (e) {}
  }

  /* Read either store, and heal the one that is missing the value. */
  function dGet(k) {
    var a = lsGet(k), b = ckGet(k);
    if (a != null && a !== "") { if (b == null) ckSet(k, a); return a; }
    if (b != null && b !== "") { lsSet(k, b); return b; }
    return null;
  }
  function dSet(k, v) { var ok = lsSet(k, v); ckSet(k, v); return ok; }
  function dDel(k) { lsDel(k); ckDel(k); }

  /* --- restore tokens -----------------------------------------------------
     Shape:  fb1-<kind>-<id>-<check>
       kind  s = a real Stripe checkout session id, l = locally minted
       id    URL-safe, never guessable in the Stripe case
       check four base36 chars over the rest

     The check digit is NOT authentication — it cannot be, there is nothing
     to authenticate against. Its whole job is to tell a mistyped or
     truncated link apart from a real one, so the buyer gets "that link looks
     wrong" instead of a page that silently does nothing.

     Using Stripe's own {CHECKOUT_SESSION_ID} as the id is deliberate: it is
     unique per purchase and, if a server is ever added, every link already
     in the wild becomes verifiable against Stripe with no reissue. */

  function hash36(s) {
    var h = 5381, i;
    try {
      for (i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
    } catch (e) { return "0000"; }
    return ("000" + h.toString(36)).slice(-4);
  }

  function clean(s) {
    try { return String(s).replace(/[^A-Za-z0-9_]/g, "").slice(0, 80); }
    catch (e) { return ""; }
  }

  function mint(kind, id) {
    var k = (kind === "s") ? "s" : "l";
    var body = clean(id);
    if (body.length < 8) {
      /* No usable id: make one. Math.random is fine — this is a bookmark
         key, not a secret that protects anything. */
      body = "";
      try {
        while (body.length < 18) { body += Math.random().toString(36).slice(2); }
        body = body.slice(0, 18);
      } catch (e) { body = "fallback0000000000"; }
      k = "l";
    }
    return "fb1-" + k + "-" + body + "-" + hash36(k + "-" + body);
  }

  function validToken(t) {
    if (!t || typeof t !== "string") return false;
    var p = t.split("-");
    if (p.length !== 4) return false;
    if (p[0] !== "fb1") return false;
    if (p[1] !== "s" && p[1] !== "l") return false;
    if (p[2].length < 8) return false;
    return hash36(p[1] + "-" + p[2]) === p[3];
  }

  /* --- query string -------------------------------------------------------
     Captured at load, before anything is stripped from the URL. gate.js's
     claim() rewrites location.search on ?unlocked=1, so if progress.js runs
     AFTER gate.js the Stripe session id is already gone. It still works —
     it just mints a local token instead of carrying Stripe's id. Loading
     this file first is strictly better. */

  var Q = {};
  (function () {
    try {
      var s = location.search || "";
      if (s.charAt(0) === "?") s = s.slice(1);
      var parts = s.split("&");
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var eq = parts[i].indexOf("=");
        var k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
        var v = eq === -1 ? "" : parts[i].slice(eq + 1);
        try { Q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); }
        catch (e) { Q[k] = v; }
      }
    } catch (e) {}
  })();

  function dropParams(names) {
    try {
      if (!history.replaceState) return;
      var s = location.search || "";
      if (s.charAt(0) === "?") s = s.slice(1);
      var keep = [], parts = s.split("&"), i, j, k, drop;
      for (i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        k = parts[i].split("=")[0];
        drop = false;
        for (j = 0; j < names.length; j++) { if (k === names[j]) drop = true; }
        if (!drop) keep.push(parts[i]);
      }
      history.replaceState({}, "",
        location.pathname + (keep.length ? "?" + keep.join("&") : "") + location.hash);
    } catch (e) {}
  }

  /* --- access -------------------------------------------------------------
     Three ways in, in priority order:
       ?restore=<token>   a buyer arriving on a new device
       ?unlocked=1        Stripe's success redirect (with session_id if the
                          payment link's success URL passes it through)
       stored flag        every visit after that
  */

  var _restoreBad = false;

  (function claim() {
    try {
      var t = Q.restore;
      if (t) {
        if (validToken(t)) {
          dSet(K_UNLOCK, "1");
          dSet(K_TOKEN, t);
          dSet(K_SRC, "restore");
        } else {
          _restoreBad = true;
        }
        dropParams(["restore"]);
      }

      if (Q.unlocked === "1") {
        dSet(K_UNLOCK, "1");
        if (!validToken(dGet(K_TOKEN))) {
          var sid = Q.session_id || Q.sessionId || "";
          /* Stripe's placeholder comes back literally if the success URL was
             set up wrong; treat that as no id rather than as an id. */
          if (sid.indexOf("{") !== -1) sid = "";
          dSet(K_TOKEN, mint(sid ? "s" : "l", sid));
          dSet(K_SRC, sid ? "stripe" : "local");
        }
        /* The query itself is left alone — gate.js strips it, and stripping
           it here first would make gate.js's own claim() a no-op. */
      }

      /* gate.js may have unlocked and stripped the URL before this file ran.
         Mint a token anyway, so the buyer always has a restore link. */
      if (dGet(K_UNLOCK) === "1" && !validToken(dGet(K_TOKEN))) {
        dSet(K_TOKEN, mint("l", ""));
        if (!dGet(K_SRC)) dSet(K_SRC, "local");
      }
    } catch (e) {}
  })();

  function unlocked() {
    try { return dGet(K_UNLOCK) === "1"; } catch (e) { return false; }
  }

  function token() {
    try { var t = dGet(K_TOKEN); return validToken(t) ? t : null; } catch (e) { return null; }
  }

  function origin() {
    try {
      if (location.protocol === "http:" || location.protocol === "https:") {
        if (location.origin) return location.origin;
      }
    } catch (e) {}
    return CANON;
  }

  function restoreURL() {
    var t = token();
    if (!t) return null;
    return origin() + "/explore?restore=" + encodeURIComponent(t);
  }

  /* Force-unlock, e.g. from a support code the lead pastes in. */
  function unlock(t) {
    try {
      dSet(K_UNLOCK, "1");
      if (t && validToken(t)) { dSet(K_TOKEN, t); dSet(K_SRC, "restore"); }
      else if (!validToken(dGet(K_TOKEN))) { dSet(K_TOKEN, mint("l", "")); dSet(K_SRC, "local"); }
      return true;
    } catch (e) { return false; }
  }

  function lock() {
    try { dDel(K_UNLOCK); dDel(K_TOKEN); dDel(K_SRC); return true; } catch (e) { return false; }
  }

  function source() { try { return dGet(K_SRC) || null; } catch (e) { return null; } }
  function restoreFailed() { return _restoreBad; }

  /* --- reading memory -----------------------------------------------------
     One key, one JSON object, so 51 stacks cost one read and one write:
       { v:1, m:{ "07B":[card, total, seconds, done] } }
     Seconds, not milliseconds, and a 0/1 done flag, because every byte here
     is a byte closer to a quota error on a webview with a small budget.
     done is stored rather than derived: a stack's card count changes when the
     story is edited, and a finished read should stay finished. */

  /* Whether the memory below may be SHOWN. See the gate section further
     down; declared here because rec() consults it. Default false: the safe
     direction is an empty shelf that fills in, never someone else's ticks
     that fade out. */
  var _visible = false;

  var _mem = null;     /* the parsed map, in memory */
  var _dirty = false;
  var _timer = null;

  /* Timestamps are whole seconds, so two stories read in the same second tie.
     This session-only counter breaks the tie toward whichever was actually
     touched last. It is never persisted — across page loads a tie falls back
     to library order, which is arbitrary but harmless. */
  var _seq = {}, _seqN = 0;

  function nowSec() { try { return Math.floor(Date.now() / 1000); } catch (e) { return 0; } }

  function mem() {
    if (_mem) return _mem;
    _mem = {};
    try {
      var raw = lsGet(K_READ);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.m && typeof o.m === "object") {
          for (var k in o.m) {
            if (!Object.prototype.hasOwnProperty.call(o.m, k)) continue;
            var a = o.m[k];
            if (a && a.length >= 3) {
              _mem[k] = [ +a[0] || 0, +a[1] || 0, +a[2] || 0, a[3] ? 1 : 0 ];
            }
          }
        }
      }
    } catch (e) { _mem = {}; }
    return _mem;
  }

  /* Oldest-first eviction, so the stories someone is actually reading are the
     last to go. */
  function trim(m, target) {
    try {
      var keys = [], k;
      for (k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) keys.push(k); }
      if (keys.length <= target) return;
      keys.sort(function (a, b) { return (m[a][2] || 0) - (m[b][2] || 0); });
      for (var i = 0; i < keys.length - target; i++) { delete m[keys[i]]; }
    } catch (e) {}
  }

  function save() {
    _dirty = false;
    try {
      var m = mem();
      trim(m, MAX_ENTRIES);
      var s = JSON.stringify({ v: 1, m: m });
      if (s.length > MAX_BYTES) { trim(m, 25); s = JSON.stringify({ v: 1, m: m }); }
      if (lsSet(K_READ, s)) return true;
      /* Quota, or a store that refuses writes. One retry at half the size,
         then give up quietly — losing a bookmark is not worth a broken page. */
      trim(m, 12);
      lsSet(K_READ, JSON.stringify({ v: 1, m: m }));
    } catch (e) {}
    return false;
  }

  function schedule() {
    _dirty = true;
    try {
      if (_timer) return;
      _timer = setTimeout(function () { _timer = null; if (_dirty) save(); }, WRITE_DELAY);
    } catch (e) { save(); }
  }

  function flush() { try { if (_timer) { clearTimeout(_timer); _timer = null; } } catch (e) {}
                     if (_dirty) save(); }

  /* A phone leaving the page never fires unload; pagehide and a hidden
     visibilitychange are the two that actually run. */
  (function () {
    try {
      addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", function () {
        try { if (document.visibilityState === "hidden") flush(); } catch (e) {}
      });
    } catch (e) {}
  })();

  function keyOf(id) {
    try {
      var s = String(id == null ? "" : id);
      return s.length && s.length <= 40 ? s : null;
    } catch (e) { return null; }
  }

  /* mark(stackId, cardIndex, totalCards)
     cardIndex is 0-based and may point one past the last card (/read's
     end card); it is clamped. Monotonic — progress never goes backwards, and
     re-reading a finished story does not un-finish it. */
  function mark(id, cardIndex, totalCards) {
    try {
      var k = keyOf(id);
      if (!k) return false;
      var total = Math.floor(+totalCards) || 0;
      var card  = Math.floor(+cardIndex);
      if (!isFinite(card) || card < 0) card = 0;
      if (total > 0 && card > total - 1) card = total - 1;

      var m = mem();
      var r = m[k] || [0, total, 0, 0];
      if (card > r[0]) r[0] = card;
      if (total > 0) r[1] = total;
      r[2] = nowSec();
      if (r[1] > 0 && r[0] >= r[1] - 1) r[3] = 1;
      m[k] = r;
      _seq[k] = ++_seqN;
      _reading = true;
      schedule();
      notify("local");
      return true;
    } catch (e) { return false; }
  }

  /* Reaching the end explicitly, when the reader knows better than the
     scroll position does. */
  function complete(id, totalCards) {
    try {
      var k = keyOf(id);
      if (!k) return false;
      var total = Math.floor(+totalCards) || (mem()[k] ? mem()[k][1] : 0);
      var m = mem();
      var r = m[k] || [0, total, 0, 0];
      if (total > 0) { r[1] = total; if (r[0] < total - 1) r[0] = total - 1; }
      r[2] = nowSec();
      r[3] = 1;
      m[k] = r;
      _seq[k] = ++_seqN;
      _reading = true;
      flush();
      notify("local");
      return true;
    } catch (e) { return false; }
  }

  function pctOf(card, total) {
    if (!total || total < 1) return 0;
    var p = Math.round((card + 1) / total * 100);
    return Math.max(1, Math.min(100, p));
  }

  function rec(k) {
    if (!_visible) return null;          /* not this viewer's memory */
    var r = mem()[k];
    if (!r) return null;
    return { card: r[0], total: r[1], done: !!r[3], at: r[2] * 1000,
             pct: r[3] ? 100 : pctOf(r[0], r[1]) };
  }

  function get(id) {
    try { var k = keyOf(id); return k ? rec(k) : null; } catch (e) { return null; }
  }

  function all() {
    var out = {};
    try {
      var m = mem(), k, r;
      for (k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        r = rec(k);
        if (r) out[k] = r;
      }
    } catch (e) {}
    return out;
  }

  /* state(stackId, totalCards) — always an object, safe to call for a cover
     that has never been opened. */
  function state(id, totalCards) {
    var total = Math.floor(+totalCards) || 0;
    var blank = { status: "unread", card: 0, total: total, pct: 0, label: "", at: 0 };
    try {
      var r = get(id);
      if (!r) return blank;
      var t = r.total || total;
      if (r.done) {
        return { status: "done", card: t ? t - 1 : r.card, total: t, pct: 100,
                 label: "Finished", at: r.at };
      }
      return { status: "reading", card: r.card, total: t, pct: pctOf(r.card, t),
               label: t ? "Card " + (r.card + 1) + " of " + t : "In progress",
               at: r.at };
    } catch (e) { return blank; }
  }

  /* resumeFor(stackId) — null means "just start at the top", which is the
     right answer for an unread story AND for a finished one. */
  function resumeFor(id) {
    try {
      var r = get(id);
      if (!r || r.done) return null;
      if (r.card < MIN_RESUME) return null;
      return { card: r.card, total: r.total, pct: r.pct, at: r.at,
               label: "Continue from card " + (r.card + 1) };
    } catch (e) { return null; }
  }

  /* continueReading(stacks) — the most recently touched unfinished story the
     reader can actually open. Pass the array straight from FB.load(). */
  function continueReading(stacks) {
    try {
      if (!stacks || !stacks.length) return null;
      var open = unlocked(), best = null, bestAt = -1, bestSeq = -1;
      for (var i = 0; i < stacks.length; i++) {
        var s = stacks[i];
        if (!s || !s.id) continue;
        if (!s.free && !open) continue;
        var r = get(s.id);
        if (!r || r.done) continue;
        if (r.card < MIN_RESUME) continue;
        var seq = _seq[s.id] || 0;
        if (r.at > bestAt || (r.at === bestAt && seq >= bestSeq)) {
          bestAt = r.at; bestSeq = seq; best = { s: s, r: r };
        }
      }
      if (!best) return null;
      var total = best.r.total || (best.s.cards ? best.s.cards.length : 0);
      return {
        stack: best.s, id: best.s.id, card: best.r.card, total: total,
        pct: pctOf(best.r.card, total), at: best.r.at,
        label: "Continue from card " + (best.r.card + 1),
        href: "/read?s=" + encodeURIComponent(best.s.id)
      };
    } catch (e) { return null; }
  }

  /* --- whose memory is this? ----------------------------------------------

     THE BUG THIS EXISTS FOR. Reading memory used to be one localStorage key
     and nothing else, so it belonged to the BROWSER. On a shared phone the
     shelf showed blue "Finished" ticks to a signed-out visitor who had never
     opened those stories: they were the last reader's, and signing out of
     Firebase does not touch localStorage.

     The fix is one string. K_OWNER records which account the map in K_READ
     was last reconciled with:

       ""          nobody's yet — read signed out, on this device only.
                   This is the common case and it is never touched by any of
                   the account machinery. A reader with no account keeps
                   exactly what they had before this file changed.
       "<uid>"     this map has been reconciled with that account.

     js/progress-sync.js is the only caller that sets it. Everything below is
     storage plumbing; the merge policy lives over there, next to the network
     call it needs, so this file stays offline-only and cannot fail to load a
     page because Firestore was slow.
     ---------------------------------------------------------------------- */

  /* --- the gate: may this memory be shown? --------------------------------

     THE RULE, from the owner, verbatim: "If someone's not even authorized,
     like they're not even logged in, then the UI should not have anything in
     the finished story."

     So personal state is shown to a signed-in account and to nobody else.
     _visible is that answer. It starts false and is set three ways:

       1. the HINT, below, synchronously at load, so a returning reader's
          shelf is correct on the FIRST paint rather than a beat later;
       2. js/progress-sync.js calling show(), once Firebase has actually
          answered who this is — that is the authoritative one;
       3. clear(), on sign-out, which empties the cache as well as hiding it.

     WHY A HINT AT ALL. Firebase takes roughly 600ms to say who someone is,
     because it fetches 200KB of SDK first. Neither of the two obvious things
     to do in that window is acceptable on its own:

       paint the cache   the shared browser flashes the last reader's blue
                         ticks. That is the reported bug, briefly.
       paint nothing     safe, but every returning reader's shelf blinks, and
                         the pages that draw progress do not repaint
                         themselves yet.

     So we ask, synchronously, whether Firebase HAS A LIVE SESSION for the uid
     that owns this cache. Not whether they may read anything — that is
     js/access.js's job and this file does not touch it — only whether the
     ticks about to be drawn belong to whoever is holding the phone.

     THREE PLACES THAT ANSWER, and they are tried in that order because that
     is the order of how cheap they are, not how much they are trusted; all
     three are Firebase's own record of its own session, and all three fail to
     the same safe answer.

       1. sessionStorage. Written by js/progress-sync.js the moment FBU
          confirms a uid, and gone when the tab closes. Exact, free, and it
          makes every navigation after the first one in a tab instant.
       2. localStorage, key prefix "firebase:authUser:". Where Firebase Auth
          persists the user when IndexedDB is unavailable — private mode, and
          several in-app webviews.
       3. IndexedDB, database "firebaseLocalStorageDb". Where it persists by
          default, which means this is the normal case on a returning reader's
          first page load. Asynchronous, so it cannot inform the very first
          statement of a render — but it is a local read of a tiny store and
          it usually lands before the shelf has finished fetching its JSON,
          which is what it is racing. When it loses that race the shelf paints
          empty and fills in; it never paints somebody else's.

     Points 2 and 3 read a store Firebase owns and whose layout is Firebase's
     business, not ours. That is a deliberate, bounded coupling: it is read
     only, it is wrapped, and if a future SDK renames either of them the hint
     simply stops finding a session. Every shelf then paints empty for 600ms
     and fills in correctly, which is the same behaviour as a reader whose
     IndexedDB is slow. A hint that has gone stale cannot leak anything
     either, because it can only turn the cache on for the uid that ALREADY
     OWNS IT — and if the session it found turns out to be revoked, FBU says
     so within a second and js/progress-sync.js takes the ticks back off the
     screen.
     ---------------------------------------------------------------------- */

  var AUTH_HINT_PREFIX = "firebase:authUser:";
  var K_LIVE = "fb_live_v1";        /* sessionStorage: this tab saw this uid */
  var IDB_DB = "firebaseLocalStorageDb";
  var IDB_STORE = "firebaseLocalStorage";

  function liveUid() {
    try { return String(sessionStorage.getItem(K_LIVE) || ""); } catch (e) { return ""; }
  }

  /* Called by js/progress-sync.js once FBU has actually confirmed the uid, so
     the next page in this tab does not have to wait 600ms to find out again. */
  function noteLive(uid) {
    try {
      if (uid) sessionStorage.setItem(K_LIVE, String(uid));
      else sessionStorage.removeItem(K_LIVE);
      return true;
    } catch (e) { return false; }
  }

  function hintUid() {
    var v = liveUid();
    if (v) return v;
    try {
      if (typeof localStorage === "undefined" || !localStorage) return "";
      var n = localStorage.length, i, k, raw, o;
      for (i = 0; i < n; i++) {
        k = localStorage.key(i);
        if (!k || k.indexOf(AUTH_HINT_PREFIX) !== 0) continue;
        raw = localStorage.getItem(k);
        if (!raw) continue;
        o = JSON.parse(raw);
        if (o && o.uid) return String(o.uid);
      }
    } catch (e) {}
    return "";
  }

  /* The IndexedDB half. cb(uid) with "" for "no session, or could not tell".
     Every branch calls back exactly once, including the ones that fail, so a
     caller can rely on being told something. */
  function hintAsync(cb) {
    var done = false;
    function fin(v) { if (done) return; done = true; try { cb(String(v || "")); } catch (e) {} }
    try {
      if (typeof indexedDB === "undefined" || !indexedDB || !indexedDB.open) { fin(""); return; }
      /* Never hold a paint hostage on a store that is not answering. */
      setTimeout(function () { fin(""); }, 1500);
      var req = indexedDB.open(IDB_DB);
      req.onerror = function () { fin(""); };
      req.onblocked = function () { fin(""); };
      /* onupgradeneeded means the database did not exist: Firebase has never
         stored a session here. Abort rather than create an empty one in
         somebody's browser as a side effect of asking a question. */
      req.onupgradeneeded = function () {
        try { req.transaction.abort(); } catch (e) {}
        fin("");
      };
      req.onsuccess = function () {
        var db = req.result, all;
        try {
          if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); fin(""); return; }
          all = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
          all.onerror = function () { try { db.close(); } catch (e) {} fin(""); };
          all.onsuccess = function () {
            var rows = all.result || [], i, r, v = "";
            for (i = 0; i < rows.length; i++) {
              r = rows[i];
              if (!r || !r.fbase_key) continue;
              if (String(r.fbase_key).indexOf(AUTH_HINT_PREFIX) !== 0) continue;
              if (r.value && r.value.uid) { v = String(r.value.uid); break; }
            }
            try { db.close(); } catch (e) {}
            fin(v);
          };
        } catch (e) { try { db.close(); } catch (e2) {} fin(""); }
      };
    } catch (e) { fin(""); }
  }

  /* show(true|false) — the authoritative answer, from progress-sync.js.
     Returns whether it changed anything, and tells listeners when it did, so
     a shelf can redraw without polling. */
  function show(on) {
    var next = !!on;
    if (next === _visible) return false;
    _visible = next;
    notify(next ? "show" : "hide");
    return true;
  }

  function visible() { return _visible; }

  function owner() {
    try { var v = lsGet(K_OWNER); return v == null ? "" : String(v); }
    catch (e) { return ""; }
  }

  function setOwner(uid) {
    try {
      var u = uid ? String(uid).slice(0, 128) : "";
      if (u) lsSet(K_OWNER, u); else lsDel(K_OWNER);
      return true;
    } catch (e) { return false; }
  }

  /* --- change notification ------------------------------------------------
     Two directions, and callers must be able to tell them apart or they will
     loop. reason is:

       "local"    mark() or complete(); the reader moved through a story.
                  progress-sync pushes these up.
       "replace"  progress-sync just wrote the account's answer in. Pushing
                  this back up is how you get an infinite write loop.
       "clear"    a sign-out emptied the cache.

     A listener that throws is dropped on the floor, not propagated: a shelf
     with a broken redraw must not stop a reader turning a card. */

  var _subs = [];

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
    var list, i;
    try { list = _subs.slice(0); } catch (e) { return; }
    for (i = 0; i < list.length; i++) {
      try { list[i](String(reason || "")); } catch (e) {}
    }
  }

  function listeners() { try { return _subs.length; } catch (e) { return 0; } }

  /* True once a card has actually been viewed on this page — i.e. this is a
     reader, not a shelf. progress-sync uses it to refuse to do anything
     disruptive to someone who is mid-story. */
  var _reading = false;
  function reading() { return _reading; }

  /* A plain copy of the map, safe to serialise. Deliberately the raw
     [card, total, seconds, done] arrays rather than rec()'s friendly objects:
     this is what goes on the wire and what comes back off it, and the two
     have to be the same shape or a round trip is lossy. */
  function snapshot() {
    var out = {};
    try {
      var m = mem(), k, r;
      for (k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        r = m[k];
        if (!r) continue;
        out[k] = [ +r[0] || 0, +r[1] || 0, +r[2] || 0, r[3] ? 1 : 0 ];
      }
    } catch (e) {}
    return out;
  }

  /* Swap the whole map for a reconciled one and record whose it is. Every
     value is re-validated on the way in exactly as mem() validates what it
     reads from storage — this argument arrived over a network, and the fact
     that it came from our own Firestore document is not a reason to trust its
     shape. A hostile value produces a dropped entry, never a throw. */
  function replaceAll(map, ownerUid) {
    try {
      var next = {}, k, a, n = 0;
      if (map && typeof map === "object") {
        for (k in map) {
          if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
          if (!keyOf(k)) continue;
          a = map[k];
          if (!a || typeof a.length !== "number" || a.length < 3) continue;
          next[k] = [ Math.max(0, Math.floor(+a[0]) || 0),
                      Math.max(0, Math.floor(+a[1]) || 0),
                      Math.max(0, Math.floor(+a[2]) || 0),
                      a[3] ? 1 : 0 ];
          n++;
          if (n >= MAX_ENTRIES * 2) break;   /* nothing legitimate is this big */
        }
      }
      _mem = next;
      _dirty = true;
      save();                    /* trims to MAX_ENTRIES / MAX_BYTES for us */
      setOwner(ownerUid);
      notify("replace");
      return true;
    } catch (e) { return false; }
  }

  /* The first paint's answer, computed now, from storage only — then asked
     again of IndexedDB, which is where Firebase actually keeps the session on
     a returning reader's first page load. The second answer usually arrives
     before the shelf has finished fetching data/stacks.json, so the common
     case is one correct paint and no redraw at all. */
  (function () {
    var o = "";
    try {
      o = owner();
      _visible = !!o && o === hintUid();
    } catch (e) { _visible = false; }
    if (_visible || !o) return;
    try {
      hintAsync(function (uid) {
        try { if (uid && uid === owner()) show(true); } catch (e) {}
      });
    } catch (e) {}
  })();

  function clear() {
    try {
      _mem = {}; _dirty = false;
      _visible = false;              /* signed out shows nothing */
      try { if (_timer) { clearTimeout(_timer); _timer = null; } } catch (e2) {}
      lsDel(K_READ);
      setOwner("");
      noteLive("");
      notify("clear");
      return true;
    } catch (e) { return false; }
  }
  function clearAll() { clear(); lock(); return true; }

  /* --- optional UI ---------------------------------------------------------
     A resume chip built entirely from inline styles, so it needs no CSS from
     any file another agent owns and cannot be broken by one. Returns an
     element or null; it is never inserted automatically, because a resume
     that moves the page on its own is exactly the disorienting jump this is
     meant to avoid. */
  function resumeChip(id, totalCards, onResume) {
    try {
      var r = resumeFor(id);
      if (!r) return null;
      if (!document || !document.createElement) return null;

      var wrap = document.createElement("div");
      wrap.className = "fbp-resume";
      wrap.setAttribute("role", "status");
      wrap.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);" +
        "bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:60;" +
        "display:flex;align-items:center;gap:10px;max-width:min(92vw,420px);" +
        "padding:10px 12px;border-radius:999px;" +
        "background:rgba(20,16,26,.92);color:#F4F0FA;" +
        "border:1px solid rgba(255,255,255,.16);" +
        "box-shadow:0 8px 30px rgba(0,0,0,.45);" +
        "font:500 15px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);";

      var go = document.createElement("button");
      go.type = "button";
      go.textContent = r.label;
      go.style.cssText =
        "flex:1 1 auto;min-height:36px;padding:0 6px;border:0;background:none;" +
        "color:inherit;font:inherit;text-align:left;cursor:pointer;";

      var no = document.createElement("button");
      no.type = "button";
      no.setAttribute("aria-label", "Start from the beginning");
      no.textContent = "×";
      no.style.cssText =
        "flex:0 0 auto;width:32px;height:32px;border-radius:50%;border:0;" +
        "background:rgba(255,255,255,.10);color:inherit;font:600 17px/1 sans-serif;" +
        "cursor:pointer;";

      function close() { try { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch (e) {} }
      try {
        go.addEventListener("click", function () {
          close();
          try { if (typeof onResume === "function") onResume(r.card, r); } catch (e) {}
        });
        no.addEventListener("click", close);
      } catch (e) {}

      wrap.appendChild(go); wrap.appendChild(no);
      wrap.dismiss = close;
      wrap.resume = r;
      return wrap;
    } catch (e) { return null; }
  }

  return {
    /* access */
    unlocked: unlocked, unlock: unlock, lock: lock,
    token: token, restoreURL: restoreURL, source: source,
    restoreFailed: restoreFailed, RESTORE_NOTE: RESTORE_NOTE,
    /* reading memory */
    mark: mark, complete: complete, flush: flush,
    get: get, all: all, state: state,
    resumeFor: resumeFor, continueReading: continueReading,
    clear: clear, clearAll: clearAll,
    /* the account mirror's seam — see js/progress-sync.js */
    owner: owner, setOwner: setOwner,
    show: show, visible: visible,
    hintUid: hintUid, hintAsync: hintAsync, noteLive: noteLive,
    snapshot: snapshot, replaceAll: replaceAll,
    onChange: onChange, listeners: listeners, reading: reading,
    LIMITS: { entries: MAX_ENTRIES, bytes: MAX_BYTES },
    /* optional UI */
    resumeChip: resumeChip,
    /* meta — false when no store would take a write */
    get ok() { return lsOK; }
  };
})();

/* ==========================================================================
   The account mirror.

   js/progress-sync.js carries the map above — and js/saves.js's list — to and
   from customers/{uid}/profile/reading, so reading progress follows the
   reader instead of the phone. It is appended here rather than added as a
   <script> to each of the twelve pages that carry this file, for three
   reasons: it cannot then be present where FBP is absent, it cannot be
   forgotten when a thirteenth page is added, and it cannot be added twice.

   async, so it never delays a paint, and every failure is silent: no
   dynamic import, no network, a blocked gstatic, a Content-Security-Policy
   that refuses the tag — any of those and the site is exactly the site it was
   before this existed, running from localStorage. FBP above does not call
   into it and does not know whether it arrived.
   ========================================================================== */
(function () {
  try {
    if (typeof document === "undefined" || !document.createElement) return;
    if (typeof window !== "undefined" && window.FBPG) return;
    if (document.getElementById("fbp-sync")) return;
    var s = document.createElement("script");
    s.id = "fbp-sync";
    s.src = "/js/progress-sync.js";
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
