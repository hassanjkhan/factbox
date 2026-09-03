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

  /* SPEC §2.6: a missing plate falls back to the stack hero, never to a
     broken image box in the middle of a shelf. The same pair read.html puts
     on every card in the deck — the hero URL is carried on the element
     itself, because by the time onerror fires the story it was built from is
     long out of scope, and the handler clears itself so a missing hero cannot
     loop. img/thumbs and img/stacks hold one file per slot today; this is the
     degrade path for the day one of them does not.

     srcset goes first. Today's Factbox names two candidates, and a browser
     re-runs that list when src changes — so leaving it in place would pick
     the broken file again and the swap would do nothing. Harmless on the
     covers, which carry no srcset. */
  function heroFallback(slot) {
    return ' data-fallback="/img/stacks/' + esc(slot) + '.webp"' +
           ' onerror="this.onerror=null;this.removeAttribute(\'srcset\');' +
           'this.src=this.getAttribute(\'data-fallback\')"';
  }

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
    if (!s || !s.id) return "/explore";
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
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "All stories";
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

  /* Today's story, and there is only one answer to that question on this site.

     It is not only what goes in the hero: today's pick is readable by
     everybody, every day, so it is also the answer to "does this cover wear a
     padlock", which js/access.js has to give on pages this file never runs on.
     Two files working the date out separately is two files that will disagree
     on a leap second or a refactor, and the reader who loses that argument is
     looking at a padlock on the story the front page just told them to read.

     So js/access.js OWNS it and this file asks. FBX.todayOf(stacks) is the
     entry point built for exactly this call: it hands back today's story AND
     registers the catalogue on the way past, which is what makes FBX.isToday()
     and FBX.canRead() answer synchronously for every cover drawn afterwards —
     including on the reader page, which never loads this file. FBX.todayIndex
     is the same answer without the registration, and is only used if some
     future access.js has one and not the other.

     The local arithmetic at the bottom is reached only when there is no
     js/access.js at all, which is the same condition under which this page
     falls back to FB.unlocked(). It is the same three lines as access.js's
     indexAt(); if you change one, change both. */
  function todayPick(stacks) {
    var n = stacks ? stacks.length : 0, i = -1, s;
    if (!n) return null;
    try {
      if (window.FBX && FBX.todayOf) {
        s = FBX.todayOf(stacks);
        if (s && s.id) return s;
      }
      if (window.FBX && FBX.todayIndex) i = Math.floor(FBX.todayIndex(n));
    } catch (e) { i = -1; }
    if (!(i >= 0 && i < n)) i = ((dayNumber() * strideFor(n)) % n + n) % n;
    return stacks[i] || null;
  }

  /* --- state -------------------------------------------------------------- */

  var STACKS = [];
  /* The id of today's pick, set by build() before a single cover is written.
     Every cover of it on the page — the hero, the shelf, a subject row, the
     mosaic tile — is marked from this one value, so they cannot disagree. */
  var TODAY_ID = "";
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

  /* data-free is the padlock pass's question, and the honest name for it is
     "can this be read without paying, right now" — which is true of the two
     permanently free stories AND of today's pick, every day. Widening the
     attribute rather than adding a second one is what keeps applyLocked()
     unchanged and keeps the hero, the shelf and the mosaic in step.

     The FREE ribbon is a different claim. It says the story is free FOREVER,
     so it is drawn from s.free and never from the attribute — today's pick is
     open today and locked on Thursday, and a badge that promised otherwise
     would be a lie with a date on it. */
  function openNow(s) { return !!(s && (s.free || (TODAY_ID && s.id === TODAY_ID))); }

  function cover(s) {
    if (!s || !s.id) return "";
    var total = cardCount(s);
    var st = pstate(s.id, total);
    var facts = total + " cards · " + mins(s.secs);
    return '' +
      '<a class="card is-' + st.status + (s.free ? " is-free" : "") + '"' +
         ' href="' + esc(href(s)) + '"' +
         ' data-id="' + esc(s.id) + '"' +
         ' data-free="' + (openNow(s) ? "1" : "") + '"' +
         ' data-meta="' + esc(facts) + '"' +
         ' data-label="' + esc(st.label || "") + '"' +
         ' data-pct="' + (st.pct || 0) + '">' +
        '<div class="plate">' +
          '<img loading="lazy" decoding="async" alt="" width="420" height="560" ' +
               'src="/img/thumbs/' + esc(s.img) + '.webp"' + heroFallback(s.img) + '>' +
          (s.free ? '<span class="freetag">FREE</span>' : '') +
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
    /* The mast's headline stays. It used to be swapped for "Welcome back.
       Ready for 5 minutes?", which meant the page introduced itself to a
       stranger and greeted a regular — two different pages sharing a URL. The
       owner wants one: "Be disgustingly well-informed." is the name of the
       thing, and it does not stop being true on a reader's second visit.

       So the streak and the finished count are the only thing this returns
       now, and they sit under the headline rather than replacing it. Not an
       h1 any more, because the mast's h1 is no longer hidden and a page with
       two visible h1s is a page a screen reader reads twice. */
    var out = '<ul class="tdy-stats">';
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
             'src="/img/thumbs/' + esc(c.stack.img) + '.webp"' +
             heroFallback(c.stack.img) + '></div>' +
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
      /* Always "1": this section IS today's pick, and today's pick is free for
         everybody every day. It used to carry (s.free ? "1" : ""), which put a
         padlock on the one story the whole page is built to get read. */
      '<section class="tdy-today" id="tdy-box" data-free="1">' +
        '<div class="tdy-art">' +
          '<img loading="eager" decoding="async" alt="" width="1280" height="800" ' +
               'src="/img/thumbs/' + slot + '.webp" ' +
               'srcset="/img/thumbs/' + slot + '.webp 420w, /img/stacks/' + slot + '.webp 1280w" ' +
               'sizes="(min-width:1024px) 560px, 100vw"' + heroFallback(s.img) + '>' +
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
         ' data-free="' + (openNow(next.stack) ? "1" : "") + '">' +
        '<div class="plate"><img loading="lazy" decoding="async" alt="" ' +
             'src="/img/thumbs/' + esc(next.stack.img) + '.webp"' +
             heroFallback(next.stack.img) + '></div>' +
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

  /* --- Everything there is: the mosaic -------------------------------------

     Eight subject rows told a reader how the season is organised. A wall of
     fifty-one covers tells them how much of it there is, which is the more
     useful thing to know on the page you land on.

     This one is not the shelf grid. Today's Factbox, Trending and Binge are
     curated — a card each, spaced, titled underneath. The catalogue is the
     opposite kind of object, and it is drawn the opposite way: tiles packed
     edge to edge with no gutter, in four sizes, title burned into the bottom
     left over a scrim and the reader's place in the story on a pill top
     right. The contrast is the point. If this section looked like the shelves
     above it, the shelves would stop reading as chosen.

     Two things had to be solved before any of it could ship, and the first
     attempt at this section was thrown away because it solved neither.

     1. COLLAPSED ROWS. A CSS grid sizes an implicit row from the tallest
        thing that STARTS in it. A row made only of the lower halves of tiles
        that began in the row above has nothing to size it, so it collapses to
        zero and the mosaic folds up. Sizing rows from the tiles is therefore
        the wrong direction entirely. layoutMosaic() measures the mosaic once,
        divides by the column count and writes that back as --m-row, so
        grid-auto-rows is an explicit length and NO row can depend on its
        contents. Spans and --m-row are written in the same pass and never
        exist without each other: if the script never runs, or the element has
        no width to measure, nothing is written and css/today.css draws fifty-
        one plain squares, which is a duller page and not a broken one.

     2. THE RAGGED TAIL. Fifty-one does not divide by three, four, five or
        six, and no repeating block of mixed sizes lands flush on it either —
        so the last row ends mid-way and the grid finishes with a bite out of
        it. The fix is to stop hoping and check: mosAttempt() lays every tile
        into a real occupancy grid and then REFUSES to return a layout unless
        the cells used come to exactly rows x columns and every one of them is
        covered. mosPlanFor() calls it with a rising number of double-width
        tiles in the tail until one comes back clean. The last 2n tiles carry
        no 2x2 and no tall tile for exactly this reason: they are the slack
        the arithmetic is taken out of, so the mosaic settles into plain
        squares at the bottom rather than leaving a hole. A plan that cannot
        be made flush is discarded rather than drawn.

     The rhythm is a function of the story's index in the catalogue, not of
     chance and not of where the tile happens to land, so story 27 is the same
     shape on every load and the page does not reflow differently on a second
     visit. A shape that will not fit where the packer has reached steps down
     — 2x2 to tall, wide to square — which is also deterministic, because the
     packer is fed the same tiles in the same order every time.

     `.card` is unchanged from the shelves', deliberately: same element, same
     classes, same data-free / data-meta / data-label / data-pct, same .plate
     with the read bar inside it. applyLocked() and applyOpen() find these
     without knowing the section was rebuilt, and the whole mosaic is CSS over
     that one contract. The only thing this file adds to a tile is its span,
     and it adds that to the element rather than to the markup, so a redraw
     and a padlock pass cannot fight over it. */

  var MOS_TILE_MIN = 3;      /* columns on a phone */

  /* Measured on the mosaic, not the window: on a wide screen this element is
     inside the content column, not the viewport. */
  function mosColsFor(w) {
    if (!(w > 0)) return MOS_TILE_MIN;
    if (w < 540) return 3;
    if (w < 820) return 4;
    if (w < 1100) return 5;
    return 6;
  }

  /* The rhythm. Nine is coprime with two, three and four, so the feature
     tiles do not line up into a column whatever the grid is that day.
       0 -> 2x2   4 -> tall   6 -> wide   everything else square */
  function mosDesire(i) {
    var m = i % 9;
    if (m === 0) return 4;
    if (m === 4) return 3;
    if (m === 6) return 2;
    return 1;
  }

  /* One packing attempt. Returns a plan only if the result is a complete
     rectangle — no holes anywhere, and none at the end. */
  function mosAttempt(count, n, extra, plain) {
    var grid = [], out = [], r = 0, c = 0, i = 0, used = 0, wides = 0;
    var tail = count - 2 * n;
    var w, h, d, y, x, a, b;

    function taken(yy, xx) { var row = grid[yy]; return !!(row && row[xx]); }
    function room(yy, xx, ww) {
      if (xx + ww > n) return false;
      var k;
      for (k = xx; k < xx + ww; k++) { if (taken(yy, k)) return false; }
      return true;
    }

    while (i < count && r < 400) {
      for (c = 0; c < n && i < count; c++) {
        if (taken(r, c)) continue;
        w = 1; h = 1;
        d = plain ? 1 : mosDesire(i);
        if (i >= tail) {
          /* The slack. Squares, plus however many double-width tiles it takes
             to make the total land on a whole number of rows. */
          if (wides < extra && room(r, c, 2)) { w = 2; wides++; }
        } else if (d === 4) {
          h = 2;
          if (room(r, c, 2)) w = 2;          /* 2x2, or tall if it will not fit */
        } else if (d === 3) {
          h = 2;
        } else if (d === 2 && room(r, c, 2)) {
          w = 2;
        }
        out[i] = [w, h];
        for (a = r; a < r + h; a++) {
          if (!grid[a]) grid[a] = [];
          for (b = c; b < c + w; b++) grid[a][b] = 1;
        }
        used += w * h;
        i++;
      }
      r++;
    }
    if (i < count) return null;              /* ran out of rows: not a layout */

    var rows = grid.length;
    if (used !== rows * n) return null;      /* the last row is short */
    for (y = 0; y < rows; y++) {
      for (x = 0; x < n; x++) { if (!taken(y, x)) return null; }
    }
    return { shapes: out, cols: n, rows: rows };
  }

  /* The rhythm first; plain squares as the answer that always exists. A plan
     of `count` squares with k = (n - count % n) % n of them widened is a full
     rectangle for every n, so the second loop cannot come back empty. */
  function mosPlanFor(count, n) {
    var extra, p;
    if (!(count > 0) || !(n > 0)) return null;
    for (extra = 0; extra <= 2 * n; extra++) {
      p = mosAttempt(count, n, extra, false);
      if (p) return p;
    }
    for (extra = 0; extra <= 2 * n; extra++) {
      p = mosAttempt(count, n, extra, true);
      if (p) return p;
    }
    return null;
  }

  function allHTML(stacks) {
    if (!stacks || !stacks.length) return "";
    var out = "", i;
    for (i = 0; i < stacks.length; i++) out += cover(stacks[i]);
    return '' +
      '<section class="row">' +
        '<div class="sechead"><h2>All stories</h2>' +
        '<span>' + stacks.length + ' to read</span></div>' +
        '<div class="tdy-mosaic" id="tdy-all">' + out + '</div>' +
      '</section>';
  }

  /* --- the page ----------------------------------------------------------- */

  function build(back) {
    var today = todayPick(STACKS);
    /* Before anything is drawn, because every cover reads it. */
    TODAY_ID = (today && today.id) ? today.id : "";
    var cont = continueOf(STACKS);
    return continueHTML(cont) +
           todayHTML(today) +
           shelf("Trending now", "picked for this week",
                 trending(STACKS, today)) +
           seriesHTML(STACKS, back) +
           allHTML(STACKS);
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
  /* The subtitle is the one line on this page that is not true for everybody.

     "Trade five minutes of scrolling for something worth remembering" is a
     pitch, and pitching the product to somebody who has already bought it
     reads as not knowing who they are. So a reader who can open everything
     gets told what they have instead. A reader who cannot keeps the pitch,
     because "You have all fifty-one" would simply be false for them — and the
     shelf makes exactly the same swap, with the same sentence, so the two
     pages cannot drift apart.

     Called from the access correction, not at first paint: before the answer
     arrives the honest line is the one already in the markup. */
  /* The swap is a change of claim, not a flicker, so it fades.

     It happens once, when the billing answer lands — measured at 247ms, 631ms
     and 1535ms after paint — and only ever pitch -> owned, because the pitch
     is what the markup ships. So nobody is ever shown the wrong sentence; they
     are shown a sentence that changes under them, and an unannounced change
     reads as a glitch. 160ms of fade is the whole treatment.

     There is no version of this that predicts the answer and avoids the swap.
     The only way would be to cache "this browser belonged to a subscriber last
     time", which is the browser-level entitlement claim that was just taken
     out of this site for being wrong. */
  function fades() {
    try {
      return !!(window.matchMedia &&
                !window.matchMedia("(prefers-reduced-motion:reduce)").matches);
    } catch (e) { return false; }
  }

  function pitchFor(open) {
    try {
      var p = document.getElementById("tdy-blurb");
      if (!p) return;
      var next = open
        ? "You have all fifty-one. New stories are added through the season."
        : "Trade five minutes of scrolling for something worth remembering.";
      /* Called again after any redraw. Re-running the fade on a sentence that
         is not changing is the flicker this is meant to prevent. */
      if (p.textContent === next) return;
      /* Reduced motion gets the swap with no dip: 160ms at zero opacity with
         nothing to ease it is a blink, which is the thing that setting asks
         not to be shown. */
      if (!fades()) { p.textContent = next; return; }
      p.style.opacity = "0";
      setTimeout(function () {
        try { p.textContent = next; p.style.opacity = "1"; } catch (e) {}
      }, 170);
    } catch (e) {}
  }

  function standDownPitch() {
    try {
      var main = view.parentNode;
      while (main && main.className !== undefined &&
             (" " + main.className + " ").indexOf(" lib ") === -1) {
        main = main.parentNode;
      }
      /* `is-back` used to hide the mast's headline and subtitle. It no longer
         does — see css/today.css — but the class is still set, because the
         stats row keys its top margin off it. Nothing about the header is
         touched from here. */
      if (main && main.className !== undefined && !hasClass(main, "is-back")) {
        main.className += " is-back";
      }
    } catch (e) {}
  }

  /* --- laying the mosaic out ----------------------------------------------

     Measure, plan, write the spans and the row height. Called after every
     draw and on every resize, and it is the only place either half is
     written, so a tile can never be spanning two rows on a grid whose rows
     are auto — which is the failure that collapses the layout.

     The plan is only recomputed when the column count or the number of tiles
     changes. --m-row is rewritten every time, because it is a length in
     pixels and the window can be dragged without crossing a breakpoint. */

  var mosCols = 0;          /* the column count the spans on screen assume */
  var mosPlan = null;

  function layoutMosaic() {
    var host, box, w, n, tiles, i, t, sh;
    try {
      host = el("tdy-all");
      if (!host) { mosCols = 0; mosPlan = null; return; }
      /* getBoundingClientRect, not clientWidth, so the row height matches the
         fractional width the 1fr columns actually resolve to. */
      w = 0;
      try { box = host.getBoundingClientRect(); w = box && box.width; } catch (e) {}
      if (!(w > 0)) w = host.clientWidth || 0;
      /* Not laid out yet — display:none, or a detached render. Leave the
         squares css/today.css already draws rather than divide by nothing. */
      if (!(w > 0)) return;

      n = mosColsFor(w);
      tiles = host.children;
      /* Written straight onto the element rather than through a custom
         property: `repeat(var(--n),1fr)` is legal CSS and is a whole
         declaration lost to `none` — one column, fifty-one tiles down the
         page — the moment a browser disagrees about substitution inside
         repeat(). This cannot fail that way.

         The row is the column: an explicit length, so the grid's rows never
         ask the tiles how tall they are. */
      host.style.gridTemplateColumns = "repeat(" + n + ",minmax(0,1fr))";
      host.style.gridAutoRows = (w / n) + "px";

      if (n === mosCols && mosPlan && mosPlan.shapes.length === tiles.length) return;
      mosCols = n;
      mosPlan = mosPlanFor(tiles.length, n);

      for (i = 0; i < tiles.length; i++) {
        t = tiles[i];
        sh = (mosPlan && mosPlan.shapes[i]) || [1, 1];
        try {
          t.style.gridColumnEnd = "span " + sh[0];
          t.style.gridRowEnd = "span " + sh[1];
          t.setAttribute("data-w", String(sh[0]));
          t.setAttribute("data-h", String(sh[1]));
        } catch (e) {}
      }
    } catch (e) {}
  }

  /* One listener, wired once, and it never rebuilds anything: a resize moves
     spans and a number, so no thumbnail is re-requested and no padlock is
     lost. ResizeObserver where there is one, because the mosaic's width can
     change without the window's — the account popover taking a scrollbar, for
     instance — and resize as the floor everywhere else. */
  var mosTimer = 0, mosWired = false;

  function mosSoon() {
    try {
      if (mosTimer) clearTimeout(mosTimer);
      mosTimer = setTimeout(function () { mosTimer = 0; layoutMosaic(); }, 90);
    } catch (e) { layoutMosaic(); }
  }

  function wireMosaic() {
    if (mosWired) return;
    mosWired = true;
    try { window.addEventListener("resize", mosSoon, false); } catch (e) {}
    try { window.addEventListener("orientationchange", mosSoon, false); } catch (e) {}
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(function () { mosSoon(); }).observe(view);
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
    fin(view, function () {
      view.innerHTML = build(back);
      /* Everything on screen is new markup, so the spans and the padlocks
         both have to be put back. drewOpen is what settle() checks to avoid
         doing the same pass twice; after a redraw the pass has NOT been done,
         and leaving it set is how a signed-out reader ends up looking at a
         wall of unlocked covers. */
      mosCols = 0; mosPlan = null;
      layoutMosaic();
      wireMosaic();
      var was = drewOpen;
      if (was !== null) { drewOpen = null; settle(was); }
    });
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
    /* Same moment the padlocks resolve, for the same reason: this is the first
       point at which the page knows who it is talking to.

       But it is not the same question. The padlocks above ask can() — may this
       person read? — which is true for an admin, for owner mode and for a
       legacy buyer, and all of them should see the season unlocked. The
       subtitle claims the reader OWNS the fifty-one, and that is owns():
       subscriber or legacy, nothing else. Told apart, an admin gets everything
       open and is not congratulated on a purchase they did not make. */
    try { pitchFor(!!(window.FBX && FBX.owns ? FBX.owns() : allowed)); }
    catch (e) { pitchFor(!!allowed); }
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

    /* Reading memory that arrives from the account after first paint. The
       page used to have no answer for it and the fallback was a reload; this
       redraws in place instead, which keeps the scroll position and the
       mosaic. "local" is this browser's own write, already on screen. */
    try {
      if (window.FBP && FBP.onChange) FBP.onChange(function (why) { if (why !== "local") draw(); });
    } catch (e) {}

    /* Today's pick, once the server has answered. The page draws immediately
       from the deterministic pick, which is right on every day nobody has
       overridden; this redraws the hero on the days somebody has. Only the
       first load of a new UTC day can disagree — after that the answer is in
       localStorage and the first frame is already right.

       A separate listener list from FBX.paint on purpose: today's pick moving
       is not an access change. Pushing it through FBX.correct() would be a
       reload loop, which is the bug /stories had. */
    try {
      if (window.FBX && FBX.onToday) FBX.onToday(function () { draw(); });
    } catch (e) {}
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
          '<a href="/explore">All stories</a>' +
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
