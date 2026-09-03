/* ==========================================================================
   Factbox — the front page.

   One page, served at two URLs. index.html (`/`) and explore.html (`/explore`)
   used to be two different answers to the same question — a shelf of all 51 on
   one, a search box and eighteen shelves on the other. Both now load this file
   and render the same thing, because a reader arriving from Instagram is not
   choosing between browsing modes, they are deciding whether to read one story
   in the next five minutes.

   What is on the page, in order:

     1. The greeting. For a reader with no history that is the pitch, and it is
        in the HTML rather than built here, so the page has real words on it
        before any script runs. For a returning reader this file replaces it
        with their own numbers.
     2. Continue — the story they are part-way through, with its bar.
     3. Today's Factbox — one story, chosen by the date.
     4. Trending now — a shelf of covers.
     5. Binge a series — one row per subject, opening the next unread story.

   Rules this file obeys without exception:
   - It must never throw. Every DOM lookup, every storage read and every helper
     on FB / FBP / FBX is guarded, and a failure renders a sentence the reader
     can act on rather than an empty page. This site has shipped blank twice.
   - ES5 only: var and function. No modules, no build step, no network beyond
     FB.loadIndex()'s one fetch of data/index.json.
   - It does not define or redefine FB, FBP, FBX or FBTAX. If progress.js never
     loaded, every cover renders unread and the greeting stays the pitch.
   - Covers are drawn with NO padlocks and the account's answer decorates them
     afterwards. A cover does not depend on who is asking; a padlock does.
     That direction is not symmetric — starting open and adding a lock costs a
     reader one glance at a cover they cannot open yet, while starting locked
     and removing them is a paying reader looking at locks on stories they
     bought, which this site has shipped twice.
   ========================================================================== */

(function () {
  "use strict";

  var TREND_N = 12;         /* covers on the trending shelf */
  var DAY_MS  = 86400000;

  /* --- guarded access to the shared globals -------------------------------
     esc and minutes are duplicated rather than required, because a page that
     goes blank when one script 404s is worse than ten lines of overlap. */

  function esc(s) {
    try { if (window.FB && FB.esc) return FB.esc(s); } catch (e) {}
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Half-minute steps, the same arithmetic as FB.minutes in gate.js. Whole
     minutes label 49 of the 51 stories "2 min", which is the one number a
     reader wants from that line carrying no information at all. */
  function mins(secs) {
    try { if (window.FB && FB.minutes) return FB.minutes(secs); } catch (e) {}
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "½ min";
    return whole + (halves % 2 ? "½" : "") + " min";
  }

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function track(name) { try { if (window.FB && FB.track) FB.track(name); } catch (e) {} }

  /* Always an object. No FBP, no reading memory, every cover unread. */
  function pstate(id, total) {
    try {
      if (window.FBP && FBP.state) {
        var st = FBP.state(id, total);
        if (st && st.status) return st;
      }
    } catch (e) {}
    return { status: "unread", card: 0, total: total || 0, pct: 0, label: "", at: 0 };
  }

  function pget(id) {
    try { if (window.FBP && FBP.get) return FBP.get(id); } catch (e) {}
    return null;
  }

  function memory() {
    try { if (window.FBP && FBP.all) return FBP.all() || {}; } catch (e) {}
    return {};
  }

  function has(o, k) {
    try { return Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return false; }
  }

  function cardCount(s) {
    try { return (s && s.cards && s.cards.length) ? s.cards.length : 0; } catch (e) { return 0; }
  }

  /* Stack 01 is the fully illustrated build and lives at its own page, so its
     cover points there rather than at the generic reader — the same rule the
     rest of the site follows. */
  function href(s) {
    if (!s || !s.id) return "/stories";
    if (s.id === "01") return "/cleopatra";
    return "/read?s=" + encodeURIComponent(s.id);
  }

  /* --- the subjects -------------------------------------------------------
     The display names live in js/explore.js and arrive on window.FBTAX. If
     that file is missing the subjects are still built, from the keys the data
     itself carries — a missing name file costs prettier headings, never a
     section. */

  function taxTopics() {
    try {
      if (window.FBTAX && FBTAX.TOPICS && FBTAX.TOPICS.length) return FBTAX.TOPICS;
    } catch (e) {}
    return [];
  }

  function subjectName(key) {
    var t = taxTopics(), i;
    for (i = 0; i < t.length; i++) { if (t[i] && t[i].key === key) return t[i].name; }
    var s = String(key == null ? "" : key).replace(/_/g, " ");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Season one";
  }

  function subjectNote(key, n) {
    var t = taxTopics(), i, rec = null;
    for (i = 0; i < t.length; i++) { if (t[i] && t[i].key === key) { rec = t[i]; break; } }
    if (!rec) return "";
    return (n === 1 && rec.note1) ? rec.note1 : (rec.note || "");
  }

  /* Subjects in the taxonomy's order first, then anything the data has that
     the taxonomy has not heard of, and only the ones with stories in them. */
  function subjectKeys(stacks) {
    var seen = {}, order = [], i, k;
    var t = taxTopics();
    for (i = 0; i < t.length; i++) {
      k = t[i] && t[i].key;
      if (k && !seen[k]) { seen[k] = 1; order.push(k); }
    }
    for (i = 0; i < stacks.length; i++) {
      k = stacks[i] && stacks[i].topic;
      if (k && !seen[k]) { seen[k] = 1; order.push(k); }
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      if (inSubject(stacks, order[i]).length) out.push(order[i]);
    }
    return out;
  }

  function inSubject(stacks, key) {
    var out = [], i;
    for (i = 0; i < stacks.length; i++) {
      if (stacks[i] && stacks[i].topic === key) out.push(stacks[i]);
    }
    return out;
  }

  /* --- the date -----------------------------------------------------------

     Today's Factbox is chosen by the day, not by chance, so that every reader
     opening the site on the same date gets the same story, tomorrow's is
     already decided, and a reload never swaps it out from under someone
     half-way through reading the hook.

     UTC, deliberately. Local time would hand two readers in two time zones
     different stories on the same date and would move the story sideways when
     a phone crosses one — "today" has to mean one thing for everybody.

     The day number is not used as the index directly: consecutive days would
     then walk the catalogue in filed order, 01, 02, 03, which reads as a list
     rather than a choice. Multiplying by a stride that shares no factor with
     the catalogue size visits every story exactly once before repeating, so
     it is a permutation rather than a shuffle — no randomness, nothing to
     seed, and the same answer in every browser. */

  function dayNumber() {
    try {
      var d = new Date();
      var ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      var n = Math.floor(ms / DAY_MS);
      return (isFinite(n) && n > 0) ? n : 0;
    } catch (e) { return 0; }
  }

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  /* The first number at or after ~0.618n that is coprime with n. Deterministic
     for a given catalogue size, and 1 for a catalogue too small to stride. */
  function strideFor(n) {
    if (!(n > 2)) return 1;
    var start = Math.floor(n * 0.618) || 1;
    var i, c;
    for (i = 0; i < n; i++) {
      c = ((start + i - 1) % (n - 1)) + 1;
      if (gcd(c, n) === 1) return c;
    }
    return 1;
  }

  /* nth(k) — the kth story of the permutation, for any whole k. */
  function pickAt(stacks, k) {
    var n = stacks.length;
    if (!n) return null;
    var i = ((Math.floor(k) * strideFor(n)) % n + n) % n;
    return stacks[i] || null;
  }

  /* --- state -------------------------------------------------------------- */

  var STACKS = [];
  var view = null, say = null;
  var drewOpen = null;         /* what the thing on screen was built from */

  /* --- one cover ----------------------------------------------------------
     Deliberately identical to the covers the rest of the site draws: same
     classes, same read bar, all already styled in app.css. A cover that looks
     different on two pages reads as two different stories.

     Drawn open — no padlock on anything. Everything the lock pass needs to
     decorate it, and to undo that if the answer improves, is carried on the
     element itself, so nothing is ever re-rendered and no thumbnail is ever
     re-requested. */

  function cover(s) {
    if (!s || !s.id) return "";
    var total = cardCount(s);
    var st = pstate(s.id, total);
    var facts = total + " cards · " + mins(s.secs);
    return '' +
      '<a class="card is-' + st.status + '"' +
         ' href="' + esc(href(s)) + '"' +
         ' data-id="' + esc(s.id) + '"' +
         ' data-free="' + (s.free ? "1" : "") + '"' +
         ' data-meta="' + esc(facts) + '"' +
         ' data-label="' + esc(st.label || "") + '"' +
         ' data-pct="' + (st.pct || 0) + '">' +
        '<div class="plate">' +
          '<img loading="lazy" decoding="async" alt="" width="420" height="560" ' +
               'src="/img/thumbs/' + esc(s.img) + '.webp">' +
          (st.pct ? '<i class="readbar" style="width:' + st.pct + '%"></i>' : '') +
        '</div>' +
        '<h3>' + esc(s.title) + '</h3>' +
        '<p class="meta">' + esc(st.label || facts) + '</p>' +
      '</a>';
  }

  function shelf(title, note, items) {
    if (!items || !items.length) return "";
    var out = "", i;
    for (i = 0; i < items.length; i++) out += cover(items[i]);
    return '' +
      '<section class="row">' +
        '<div class="sechead"><h2>' + esc(title) + '</h2>' +
        '<span>' + esc(note) + '</span></div>' +
        '<div class="tdy-shelf">' + out + '</div>' +
      '</section>';
  }

  /* --- the greeting -------------------------------------------------------

     A streak counted from what progress.js actually stores, which is one
     timestamp per story: the last time that story was touched. So a day counts
     when some story was last touched on it. Reading three stories in one day
     is one day, and re-opening an old story moves its day forward — this is
     the honest maximum resolution of the memory we keep, and it is not
     described to the reader as anything more than a streak of days. */

  function streakOf(map) {
    var days = {}, k, r, n = 0;
    for (k in map) {
      if (!has(map, k)) continue;
      r = map[k];
      if (!r || !r.at) continue;
      days[Math.floor(r.at / DAY_MS)] = 1;
    }
    var today = dayNumber();
    var cur = days[today] ? today : (days[today - 1] ? today - 1 : 0);
    if (!cur) return 0;
    while (days[cur]) { n++; cur--; }
    return n;
  }

  function finishedOf(map) {
    var k, n = 0;
    for (k in map) { if (has(map, k) && map[k] && map[k].done) n++; }
    return n;
  }

  function touchedOf(map) {
    var k, n = 0;
    for (k in map) { if (has(map, k)) n++; }
    return n;
  }

  function stat(value, label) {
    return '<li class="tdy-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></li>';
  }

  function greetHTML(map) {
    var streak = streakOf(map);
    var done = finishedOf(map);
    /* An h1, because the mast's own h1 is hidden the moment this one is
       shown: the page has exactly one VISIBLE h1 in either state. */
    var out = '<h1 class="tdy-head">Welcome back. Ready for 5 minutes?</h1>' +
              '<ul class="tdy-stats">';
    if (streak > 0) out += stat(streak, "day streak");
    out += stat(done, done === 1 ? "story finished" : "stories finished");
    return out + '</ul>';
  }

  /* --- Continue -----------------------------------------------------------

     The most recently touched unfinished story. Deliberately NOT
     FBP.continueReading, which filters out anything the local unlock flag does
     not cover: at first paint a subscriber has no local flag yet, so their own
     half-read story would vanish from the hero and appear a beat later, which
     is the flicker this page is built to avoid. Whether they may finish it is
     the reader page's question, and it answers it. Card 0 is the hook, so a
     story opened and abandoned on its first card is not "in progress". */

  function continueOf(stacks) {
    var best = null, bestAt = -1, i, s, r;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i];
      if (!s || !s.id) continue;
      r = pget(s.id);
      if (!r || r.done) continue;
      if (!(r.card >= 1)) continue;
      if (r.at > bestAt) { bestAt = r.at; best = { s: s, r: r }; }
    }
    if (!best) return null;
    var total = best.r.total || cardCount(best.s);
    return { stack: best.s, card: best.r.card, total: total,
             pct: best.r.pct || 0 };
  }

  function continueHTML(c) {
    if (!c) return "";
    var where = c.total ? ("Card " + (c.card + 1) + " of " + c.total)
                        : "In progress";
    return '' +
      '<a class="tdy-cont" href="' + esc(href(c.stack)) + '">' +
        '<div class="plate"><img loading="eager" decoding="async" alt="" ' +
             'src="/img/thumbs/' + esc(c.stack.img) + '.webp"></div>' +
        '<div class="t">' +
          '<p class="tdy-eyebrow">Continue</p>' +
          '<b>' + esc(c.stack.title) + '</b>' +
          '<span class="tdy-where">' + esc(where) + '</span>' +
          '<div class="tdy-bar"><i style="width:' + Math.max(2, Math.min(100, c.pct)) + '%"></i></div>' +
        '</div>' +
      '</a>';
  }

  /* --- Today's Factbox ---------------------------------------------------- */

  function todayHTML(s) {
    if (!s || !s.id) return "";
    var total = cardCount(s);
    var slot = esc(s.img);
    return '' +
      '<section class="tdy-today" id="tdy-box" data-free="' + (s.free ? "1" : "") + '">' +
        '<div class="tdy-art">' +
          '<img loading="eager" decoding="async" alt="" width="1280" height="800" ' +
               'src="/img/thumbs/' + slot + '.webp" ' +
               'srcset="/img/thumbs/' + slot + '.webp 420w, /img/stacks/' + slot + '.webp 1280w" ' +
               'sizes="(min-width:1024px) 560px, 100vw">' +
        '</div>' +
        '<div class="tdy-body">' +
          '<p class="tdy-kicker">Today’s Factbox</p>' +
          '<p class="tdy-subject">' + esc(subjectName(s.topic)) + '</p>' +
          '<h2 class="tdy-hook">' + esc(s.hook || s.title) + '</h2>' +
          '<p class="tdy-facts">' + total + ' cards · ' + esc(mins(s.secs)) + '</p>' +
          '<a class="go" href="' + esc(href(s)) + '">Start story</a>' +
        '</div>' +
      '</section>';
  }

  /* --- Trending -----------------------------------------------------------
     A window onto the same permutation, moved on once a week, with today's
     story left out of it because it is already the biggest thing on the page.
     Same for everybody, and settled a week ahead. */

  function trending(stacks, today) {
    var week = Math.floor(dayNumber() / 7);
    var out = [], seen = {}, i, s;
    for (i = 0; i < TREND_N + 2 && out.length < TREND_N; i++) {
      s = pickAt(stacks, week * TREND_N + i);
      if (!s || !s.id) continue;
      if (today && s.id === today.id) continue;
      if (seen[s.id]) continue;
      seen[s.id] = 1;
      out.push(s);
    }
    return out;
  }

  /* --- Binge a series -----------------------------------------------------
     A subject is one row, not a list of covers. It says how far in the reader
     is, and opens the next story they have not finished — the reader has
     already chosen the subject by tapping it, so handing them a menu is asking
     the same question twice. The plate is that next story, so the row shows
     where the tap goes. */

  function nextIn(list) {
    var i, st;
    for (i = 0; i < list.length; i++) {
      st = pstate(list[i].id, cardCount(list[i]));
      if (st.status !== "done") return { stack: list[i], fresh: true };
    }
    return { stack: list[0], fresh: false };
  }

  function doneIn(list) {
    var i, n = 0;
    for (i = 0; i < list.length; i++) {
      if (pstate(list[i].id, cardCount(list[i])).status === "done") n++;
    }
    return n;
  }

  /* `back` is "this reader has read something". It decides which of two true
     sentences the row carries: someone who has read nothing at all is told
     what is in the subject, because eight rows each saying "0 of 11 read"
     describes the reader rather than the season. Once they are reading, every
     row says how far in they are, including the ones they have not started. */
  function serieHTML(key, list, back) {
    var next = nextIn(list);
    if (!next || !next.stack) return "";
    var done = doneIn(list);
    var pct = list.length ? Math.round(done / list.length * 100) : 0;
    var where = done + " of " + list.length + " read";
    if (!done && !back) {
      var note = subjectNote(key, list.length);
      where = list.length + (list.length === 1 ? " story" : " stories") +
              (note ? " · " + note : "");
    }
    return '' +
      '<a class="tdy-serie' + (next.fresh ? "" : " is-done") + '"' +
         ' href="' + esc(href(next.stack)) + '"' +
         ' data-id="' + esc(next.stack.id) + '"' +
         ' data-free="' + (next.stack.free ? "1" : "") + '">' +
        '<div class="plate"><img loading="lazy" decoding="async" alt="" ' +
             'src="/img/thumbs/' + esc(next.stack.img) + '.webp"></div>' +
        '<div class="t">' +
          '<b>' + esc(subjectName(key)) + '</b>' +
          '<span class="tdy-where">' + esc(where) + '</span>' +
          (done ? '<div class="tdy-bar"><i style="width:' + Math.max(2, pct) + '%"></i></div>' : '') +
        '</div>' +
      '</a>';
  }

  function seriesHTML(stacks, back) {
    var keys = subjectKeys(stacks), out = "", i, list;
    for (i = 0; i < keys.length; i++) {
      list = inSubject(stacks, keys[i]);
      out += serieHTML(keys[i], list, back);
    }
    if (!out) return "";
    return '' +
      '<section class="row">' +
        '<div class="sechead"><h2>Binge a series</h2>' +
        '<span>picks up where you left off</span></div>' +
        '<div class="tdy-series">' + out + '</div>' +
      '</section>';
  }

  /* --- the page ----------------------------------------------------------- */

  function build(back) {
    var today = pickAt(STACKS, dayNumber());
    var cont = continueOf(STACKS);
    return continueHTML(cont) +
           todayHTML(today) +
           shelf("Trending now", "picked for this week",
                 trending(STACKS, today)) +
           seriesHTML(STACKS, back);
  }

  /* The waiting bar gets to finish rather than just stop: FBLoad.done lifts it
     out of the container and runs it to 100% over the top, so the content
     below is not delayed by a single frame. Without the module the content
     simply appears. */
  function fin(host, fn) {
    try { if (window.FBLoad && FBLoad.done) { FBLoad.done(host, fn); return; } } catch (e) {}
    fn();
  }

  /* The pitch in the mast is stood down only for someone who has read
     something. Everyone else keeps the words that were already on screen,
     which is why those words are in the HTML and not in here.

     The header's own markup is never rewritten — `is-back` goes on the main
     element, which this page owns, and css/today.css does the rest. If the
     header is later rebuilt without an h1, the class matches nothing and the
     greeting below simply stands on its own. */
  function standDownPitch() {
    try {
      var main = view.parentNode;
      while (main && main.className !== undefined &&
             (" " + main.className + " ").indexOf(" lib ") === -1) {
        main = main.parentNode;
      }
      if (main && main.className !== undefined && !hasClass(main, "is-back")) {
        main.className += " is-back";
      }
    } catch (e) {}
  }

  function draw() {
    var map = memory();
    var back = false;
    try { back = touchedOf(map) > 0; } catch (e) { back = false; }
    try {
      if (say && back) {
        say.innerHTML = greetHTML(map);
        standDownPitch();
      }
    } catch (e) {}
    fin(view, function () { view.innerHTML = build(back); });
  }

  /* --- the account's answer, afterwards -----------------------------------
     Decoration in place, both directions, no reload: FBX.correct() exists for
     pages that CANNOT repair themselves, and reloading a page that has already
     corrected itself only throws away what it just drew. */

  function covers() {
    try { return [].slice.call(view.querySelectorAll(".card,.tdy-serie")); }
    catch (e) { return []; }
  }

  function hasClass(n, c) {
    try { return (" " + (n.className || "") + " ").indexOf(" " + c + " ") !== -1; }
    catch (e) { return false; }
  }

  function addLock(host) {
    try {
      if (!host || host.querySelector(".lock")) return;
      var lock = document.createElement("span");
      lock.className = "lock";
      lock.setAttribute("aria-hidden", "true");
      lock.textContent = "🔒";
      host.appendChild(lock);
    } catch (e) {}
  }

  function dropLock(host) {
    try {
      if (!host) return;
      var l = host.querySelector(".lock");
      if (l && l.parentNode) l.parentNode.removeChild(l);
    } catch (e) {}
  }

  function applyLocked() {
    var list = covers(), i, a, plate, rb, meta;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      if (a.getAttribute("data-free")) continue;
      if (hasClass(a, "locked")) continue;
      a.className += " locked";
      plate = a.querySelector(".plate");
      addLock(plate);
      /* A locked cover shows neither progress bar nor progress label. */
      rb = a.querySelector(".readbar");
      if (rb && rb.parentNode) rb.parentNode.removeChild(rb);
      meta = a.querySelector(".meta");
      if (meta) meta.textContent = a.getAttribute("data-meta") || "";
    }
    var box = el("tdy-box");
    if (box && !box.getAttribute("data-free")) addLock(box.querySelector(".tdy-art"));
  }

  function applyOpen() {
    var list = covers(), i, a, plate, meta, pct, bar;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      if (!hasClass(a, "locked")) continue;
      a.className = String(a.className).replace(/(^|\s)locked(\s|$)/g, " ")
                                       .replace(/^\s+|\s+$/g, "");
      plate = a.querySelector(".plate");
      dropLock(plate);
      meta = a.querySelector(".meta");
      if (meta) meta.textContent = a.getAttribute("data-label") ||
                                   a.getAttribute("data-meta") || "";
      pct = parseInt(a.getAttribute("data-pct") || "0", 10);
      if (pct > 0 && plate && !plate.querySelector(".readbar")) {
        try {
          bar = document.createElement("i");
          bar.className = "readbar";
          bar.style.width = pct + "%";
          plate.appendChild(bar);
        } catch (e) {}
      }
    }
    var box = el("tdy-box");
    if (box) dropLock(box.querySelector(".tdy-art"));
  }

  function settle(allowed) {
    allowed = !!allowed;
    if (drewOpen === allowed) return;
    drewOpen = allowed;
    try { if (allowed) applyOpen(); else applyLocked(); } catch (e) {}
  }

  function decorate() {
    var painted = false;
    try {
      if (window.FBX && FBX.paint) {
        painted = true;
        FBX.paint(function (allowed) { settle(!!allowed); });
      }
    } catch (e) { painted = false; }
    /* No FBX at all — an old cached access.js, or a webview that dropped it.
       Fall back to the synchronous answer rather than leaving the page in its
       undecided state forever. */
    if (!painted) {
      try { settle(!!(window.FB && FB.unlocked && FB.unlocked())); }
      catch (e) { settle(false); }
    }
  }

  /* --- failure ------------------------------------------------------------
     Never a silent empty page. If the data will not load, the reader gets a
     sentence and a link that still works. */

  function fail() {
    try {
      if (!view) return;
      view.innerHTML =
        '<div class="tdy-void">' +
          '<b>The stories did not arrive.</b>' +
          '<p>That usually means the connection dropped on the way. Reload the ' +
          'page, or open the season shelf, which lists all fifty-one.</p>' +
          '<a href="/stories">All stories</a>' +
        '</div>';
    } catch (e) {}
  }

  /* --- boot --------------------------------------------------------------- */

  function boot() {
    view = el("view");
    say  = el("tdy-say");
    if (!view) return;                       /* nothing to render into */

    if (!window.FB || (!FB.loadIndex && !FB.load)) { fail(); return; }

    /* Covers and titles only — data/index.json, a quarter the size of the
       corpus, with the same fallback to it. Nothing on this page renders card
       text, so nothing on this page needs the 95KB.

       Not gated on the account: a cover, a hook, a card count and a runtime
       are the same for everybody. */
    (FB.loadIndex ? FB.loadIndex() : FB.load()).then(function (stacks) {
      STACKS = (stacks && stacks.length) ? stacks : [];
      if (!STACKS.length) throw new Error("no stacks");
      draw();                                /* on screen now, no padlocks */
      track("home_view");
      decorate();                            /* and the answer, whenever */
    })["catch"](function () { fail(); });
  }

  /* The script tag is at the end of the body, so the DOM is already parsed —
     but boot is guarded either way, and the whole thing is wrapped so a
     surprise from any helper degrades to a message rather than a blank page. */
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        try { boot(); } catch (e) { fail(); }
      }, false);
    } else {
      boot();
    }
  } catch (e) {
    try { fail(); } catch (e2) {}
  }
})();
