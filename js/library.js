/* ==========================================================================
   Factbox — the Library page.   Renders into #shelf on library.html.

   This is the reader's own shelf: what they are in the middle of, what they
   have finished, what they put aside. Every number on it is derived from
   storage that already exists — FBP (reading memory) and FBS (saves). It
   invents nothing: no streaks, no "time saved", no counts it cannot compute.

   Design rules:
   - It must never throw. A page that throws at the top level ships blank, and
     this site has done that twice. Every entry point is wrapped and every
     failure has visible copy.
   - ES5 only, plain IIFE, no build step.
   - FBP and FBS are used through guards, so the page still renders (as an
     empty library) if either script fails to load.
   ========================================================================== */

(function () {

  var shelf = document.getElementById("shelf");
  if (!shelf) return;

  /* --- guards -------------------------------------------------------------
     Every dependency is optional. Missing FBP means "nothing remembered";
     missing FBS means "nothing saved". Neither is an error page. */

  var P = (typeof window !== "undefined" && window.FBP) ? window.FBP : null;
  var S = (typeof window !== "undefined" && window.FBS) ? window.FBS : null;
  var G = (typeof window !== "undefined" && window.FB)  ? window.FB  : null;

  function esc(s) {
    try { if (G && G.esc) return G.esc(s); } catch (e) {}
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function mins(secs) {
    try { if (G && G.minutes) return G.minutes(secs); } catch (e) {}
    return Math.max(1, Math.round((secs || 0) / 60)) + " min";
  }
  function track(n, x) { try { if (G && G.track) G.track(n, x); } catch (e) {} }
  function unlocked() { try { return !!(G && G.unlocked && G.unlocked()); } catch (e) { return false; } }

  /* Always an object, whatever FBP is doing. */
  function stateOf(id, total) {
    try {
      if (P && P.state) {
        var st = P.state(id, total);
        if (st && st.status) return st;
      }
    } catch (e) {}
    return { status: "unread", card: 0, total: total || 0, pct: 0, label: "", at: 0 };
  }

  function savedIds() {
    try { if (S && S.ids) return S.ids(); } catch (e) {}
    return [];
  }

  function fail(msg) {
    try {
      shelf.innerHTML = '<p class="libfail">' + esc(msg) + '</p>' +
        '<p class="fine" style="text-align:left">' +
        '<a href="stories.html">Back to the stories</a></p>';
    } catch (e) {}
  }

  /* --- pieces -------------------------------------------------------------
     Deliberately the same markup as stories.html, so a cover looks and reads
     the same on both shelves. .card / .plate / .meta / .readbar / .lock all
     come from app.css; nothing here restyles them. */

  function href(s) {
    /* Stack 01 is the fully illustrated version and lives at the front page,
       so it points there rather than at the generic reader. Same rule as
       stories.html — if it ever changes, it changes in both. */
    return s.id === "01" ? "story.html" : "read.html?s=" + encodeURIComponent(s.id);
  }

  function card(s, note) {
    var locked = !s.free && !unlocked();
    var st = stateOf(s.id, s.cards.length);
    var meta = note ? note
             : (!locked && st.label ? st.label
                : s.cards.length + " cards · " + mins(s.secs));
    return '' +
      '<a class="card is-' + st.status + (locked ? " locked" : "") + '" href="' + href(s) + '">' +
        '<div class="plate">' +
          '<img loading="lazy" decoding="async" alt="" ' +
               'src="img/thumbs/' + esc(s.img) + '.webp">' +
          (locked
            ? '<span class="lock" aria-hidden="true">🔒</span>'
            : (s.free ? '<span class="freetag">FREE</span>' : '')) +
          (!locked && st.pct ? '<i class="readbar" style="width:' + st.pct + '%"></i>' : '') +
        '</div>' +
        '<h3>' + esc(s.title) + '</h3>' +
        '<p class="meta">' + esc(meta) + '</p>' +
      '</a>';
  }

  /* A saved cover carries one extra control, and it cannot live inside the
     <a> — a button nested in a link is invalid and un-tappable on iOS. It
     sits under the cover in its own cell instead. */
  function savedCell(s) {
    return '<div class="savecell">' + card(s) +
      '<button class="unsave" type="button" data-unsave="' + esc(s.id) + '">Remove</button></div>';
  }

  function section(title, note, items, render) {
    if (!items || !items.length) return "";
    return '<div class="sechead"><h2>' + esc(title) + '</h2>' +
           '<span>' + esc(note) + '</span></div>' +
           '<div class="grid">' + items.map(render || function (s) { return card(s); }).join("") + '</div>';
  }

  /* --- the honest stats line ----------------------------------------------
     Three numbers, each one computable from what is actually stored:
       finished  — stacks whose status is "done"
       cards     — every card of a finished stack, plus (furthest + 1) of one
                   in progress
       minutes   — each stack's own listed `secs`, pro-rated by the share of
                   its cards read. It is an estimate and it says so; it is not
                   a measurement of time spent, which nothing here records.
     No streaks. Nothing about days. Those would need a history this does not
     keep, and inventing them would be lying to the reader about themselves. */
  function statsLine(stacks) {
    var done = 0, cards = 0, secs = 0, i, s, st, read;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i];
      if (!s || !s.cards) continue;
      st = stateOf(s.id, s.cards.length);
      if (st.status === "done") {
        done++; read = s.cards.length;
      } else if (st.status === "reading") {
        read = Math.min(s.cards.length, (st.card || 0) + 1);
      } else { continue; }
      cards += read;
      if (s.cards.length) secs += (s.secs || 0) * read / s.cards.length;
    }
    if (!cards) return "";
    var m = Math.max(1, Math.round(secs / 60));
    return '<p class="statline">' +
      '<b>' + done + '</b> ' + (done === 1 ? "story" : "stories") + ' finished' +
      ' · <b>' + cards + '</b> ' + (cards === 1 ? "card" : "cards") + ' read' +
      ' · about <b>' + m + '</b> min' +
      '<small>Minutes are estimated from each story’s own listed length, ' +
      'not from a clock. Nothing about your reading leaves this browser.</small></p>';
  }

  /* --- the whole page ------------------------------------------------------ */

  function render(stacks) {
    var byId = {}, i;
    for (i = 0; i < stacks.length; i++) { if (stacks[i] && stacks[i].id) byId[stacks[i].id] = stacks[i]; }

    /* In progress and finished, most recently touched first. `at` comes from
       FBP; a tie falls back to library order, which is arbitrary but stable. */
    var reading = [], finished = [], order = {};
    for (i = 0; i < stacks.length; i++) {
      var s = stacks[i];
      if (!s || !s.cards) continue;
      var st = stateOf(s.id, s.cards.length);
      if (st.status === "reading") { order[s.id] = st.at || 0; reading.push(s); }
      else if (st.status === "done") { order[s.id] = st.at || 0; finished.push(s); }
    }
    function recent(a, b) { return (order[b.id] || 0) - (order[a.id] || 0); }
    reading.sort(recent);
    finished.sort(recent);

    /* Saved: FBS holds ids, not stories, so anything whose id is no longer in
       the season is skipped rather than rendered as a broken cover. */
    var ids = savedIds(), savedStacks = [];
    for (i = 0; i < ids.length; i++) { if (byId[ids[i]]) savedStacks.push(byId[ids[i]]); }

    /* continueReading already filters locked stacks, so the most prominent
       thing on the page can never be something the reader cannot open. */
    var cont = null;
    try { if (P && P.continueReading) cont = P.continueReading(stacks); } catch (e) { cont = null; }

    var html = "";

    html += statsLine(stacks);

    if (cont && cont.stack) {
      html += '<div class="sechead"><h2>Continue reading</h2>' +
              '<span>' + esc(cont.pct + "% in") + '</span></div>' +
              '<a class="resume" href="' + (cont.id === "01" ? "story.html" : cont.href) + '">' +
                '<div class="plate"><img alt="" src="img/thumbs/' + esc(cont.stack.img) + '.webp"></div>' +
                '<div class="t"><b>' + esc(cont.stack.title) + '</b>' +
                '<span>' + esc(cont.label) + '</span></div>' +
              '</a>';
    }

    html += section("In progress", reading.length + (reading.length === 1 ? " story" : " stories"), reading);
    html += section("Finished", finished.length + (finished.length === 1 ? " story" : " stories"), finished);
    html += section("Saved for later",
                    savedStacks.length + (savedStacks.length === 1 ? " story" : " stories"),
                    savedStacks, savedCell);

    /* Nothing read, nothing saved. Send them somewhere, not to a blank page. */
    if (!cont && !reading.length && !finished.length && !savedStacks.length) {
      var free = [];
      for (i = 0; i < stacks.length; i++) { if (stacks[i] && stacks[i].free) free.push(stacks[i]); }
      html +=
        '<div class="empty">' +
          '<h2>Your library is empty.</h2>' +
          '<p>Everything you read shows up here — where you got to, what you ' +
          'finished, and anything you saved for later. Nothing is sent anywhere; ' +
          'it is all kept in this browser.</p>' +
          '<div class="emptygo">' +
            '<a class="go" href="explore.html">Explore all 51 stories</a>' +
            '<a class="ghost" href="stories.html">Season one</a>' +
          '</div>' +
        '</div>' +
        section("Start with these", "free to read", free);
    }

    /* Storage refused everything. Say so once, plainly, rather than letting
       the reader save things that quietly evaporate on reload. */
    var deadP = !!(P && P.ok === false);
    var deadS = !!(S && S.ok === false);
    if (deadP || deadS) {
      html +=
        '<p class="libnote"><b>This browser is not letting Factbox remember anything.</b> ' +
        'Private browsing and some in-app browsers block it. You can still read ' +
        'everything — the library just starts empty each time. Opening ' +
        'factbox.app in Safari or Chrome fixes it.</p>';
    }

    shelf.innerHTML = html;
  }

  /* --- wiring -------------------------------------------------------------- */

  var _stacks = null;

  function rerender() {
    try { if (_stacks) render(_stacks); } catch (e) { fail("Something went wrong drawing your library. Reload the page."); }
  }

  /* One delegated listener, so it survives every re-render. */
  try {
    shelf.addEventListener("click", function (ev) {
      try {
        var t = ev.target, id = null, hops = 0;
        while (t && hops++ < 4) {
          if (t.getAttribute && t.getAttribute("data-unsave")) { id = t.getAttribute("data-unsave"); break; }
          t = t.parentNode;
        }
        if (!id) return;
        ev.preventDefault();
        if (S && S.remove) S.remove(id);
        track("library_unsave", { stack: String(id) });
        rerender();
      } catch (e) {}
    });
  } catch (e) {}

  function boot() {
    if (!G || !G.load) {
      fail("Could not load the stories. Reload the page.");
      return;
    }
    G.load().then(function (stacks) {
      try {
        _stacks = (stacks && stacks.length) ? stacks : [];
        render(_stacks);
        track("library_own_view", { saved: String(S && S.count ? S.count() : 0) });
      } catch (e) {
        fail("Something went wrong drawing your library. Reload the page.");
      }
    }).catch(function () {
      fail("Could not load the stories. Check your connection and reload.");
    });
  }

  try { boot(); } catch (e) { fail("Could not load the stories. Reload the page."); }
})();
