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
  /* A TITLE IS NEVER ALLOWED TO CARRY A SOURCE CITATION.

     The same guard js/today.js keeps, for the same reason and by the same
     three passes: a parenthesised markdown link, a bare parenthesised URL, an
     ordinary inline link. The corpus files its sources inline with the prose,
     which is right on a card and wrong on a cover — "...the Bible? ([Vatican
     News](https://...))" under a plate is a URL where a name belongs.

     No title in data/index.json carries one today; three hooks do. This is a
     guard against the day one does, and it exists here because the hero on
     /explore now shows a title too: if a title is only cleaned on one of the
     two pages, one story gets two names again, which is the whole thing this
     change was for. Duplicated rather than imported: this page must not go
     blank because one script 404ed. */
  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)\s*/g, " ")
      .replace(/\s*\(https?:\/\/[^)]*\)\s*/g, " ")
      .replace(/\s*\[([^\]]*)\]\([^)]*\)/g, " $1")
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  /* Half-minute steps, the same arithmetic as FB.minutes in gate.js. Whole
     minutes gave 49 of the 51 stories the same "2 min" label. If this and
     gate.js disagree, one story shows two lengths on two pages. */
  function mins(secs) {
    try { if (G && G.minutes) return G.minutes(secs); } catch (e) {}
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "\u00bd min";
    return whole + (halves % 2 ? "\u00bd" : "") + " min";
  }
  function track(n, x) { try { if (G && G.track) G.track(n, x); } catch (e) {} }

  /* SPEC §2.6: a missing plate falls back to the stack hero, never to a
     broken image box on a shelf. The same pair read.html puts on every card
     in the deck — the hero URL is carried on the element itself, because by
     the time onerror fires the story it was built from is long out of scope,
     and the handler clears itself so a missing hero cannot loop. */
  function heroFallback(slot) {
    return ' data-fallback="/img/stacks/' + esc(slot) + '.webp"' +
           ' onerror="this.onerror=null;this.src=this.getAttribute(\'data-fallback\')"';
  }
  /* What the covers on screen were drawn from.

     It starts TRUE — nothing wears a padlock before the answer is known — and
     the answer, when it lands, either leaves it alone or triggers one redraw.

     Two reasons it is a variable and not a call to G.unlocked() at render
     time. The first is that this page renders the moment the covers index
     arrives, which is well before Firebase has reported the subscription; a
     direct call there returns "no" and the page drew a padlock on every story
     a signed-in reader had already paid for, and never took it off, because
     nothing here re-rendered. That is the bug this replaces.

     The second is the direction of the mistake. Starting open and adding locks
     risks a reader briefly seeing a cover they cannot open yet. Starting
     locked and removing them shows a paying reader a wall — and if the
     correction never arrives, they simply believe it. The shelf and the home
     page already make the same choice for the same reason. */
  var OPEN = true;
  function unlocked() { return OPEN; }

  /* Did this reader BUY the season? A different question from the one above,
     and js/access.js is emphatic about the difference: an admin flag and a
     laptop carrying the owner passphrase both open all fifty-one stories and
     neither of them paid for one. can() decides padlocks. owns() decides
     whether the page is allowed to say "Member".

     It starts FALSE, the opposite of OPEN, and for the opposite reason.
     Guessing "open" wrong shows a paying reader one frame of a padlock;
     guessing "member" wrong tells somebody they have a subscription they do
     not have. So this claims nothing until FBX has actually answered. */
  var OWNS = false;

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
        '<a href="/explore">All stories</a></p>';
    } catch (e) {}
  }

  /* --- pieces -------------------------------------------------------------
     Deliberately the same markup as the shelf on / and /explore (js/today.js),
     so a cover looks and reads the same on both shelves. .card / .plate / .meta / .readbar / .lock all
     come from app.css; nothing here restyles them. */

  function href(s) {
    /* Stack 01 is the fully illustrated version and lives at the front page,
       so it points there rather than at the generic reader. Same rule as
       js/today.js — if it ever changes, it changes in both. */
    return s.id === "01" ? "/cleopatra" : "/read?s=" + encodeURIComponent(s.id);
  }

  function card(s, note) {
    var locked = !s.free && !unlocked();
    var st = stateOf(s.id, s.cards.length);
    /* The label and the bar are a record of this reader's own progress, so
       they are gated on having progress — never on access. A locked story
       they have read renders under "In progress" with the bar that says so;
       hiding it there left the heading contradicting the cover under it. */
    var meta = note ? note
             : (st.label ? st.label
                : s.cards.length + " cards · " + mins(s.secs));
    return '' +
      '<a class="card is-' + st.status + (locked ? " locked" : "") + '" href="' + href(s) + '">' +
        '<div class="plate">' +
          '<img loading="lazy" decoding="async" alt="" ' +
               'src="/img/thumbs/' + esc(s.img) + '.webp"' + heroFallback(s.img) + '>' +
          /* The padlock stays; the FREE ribbon is gone, matching js/today.js.
             A free cover is bright and unlocked and a paid one is dimmed and
             wears a lock — that contrast already says it, and the word "free"
             only reminded a reader that this one costs nothing. */
          (locked ? '<span class="lock" aria-hidden="true">🔒</span>' : '') +
          (st.pct ? '<i class="readbar" style="width:' + st.pct + '%"></i>' : '') +
        '</div>' +
        '<h3>' + esc(clean(s.title)) + '</h3>' +
        '<p class="meta">' + esc(meta) + '</p>' +
      '</a>';
  }

  /* A saved cover carries one extra control, and it cannot live inside the
     <a> — a button nested in a link is invalid and un-tappable on iOS. It
     sits under the cover in its own cell instead. */
  function savedCell(s) {
    return '<div class="savecell">' + card(s) +
      '<button class="unsave" type="button" data-fbt="-" data-unsave="' + esc(s.id) + '" aria-label="Remove ' + esc(clean(s.title)) + ' from your library">Remove</button></div>';
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
      '</p>';
  }

  /* --- the membership line -------------------------------------------------
     "Member · all 51 stories unlocked", under the stats, and only for somebody
     who actually subscribed. Two rules hold it up:

     1. owns(), never can(). js/access.js: "Padlocks are a can() question. Any
        sentence about entitlement is an owns() question." This is a sentence
        about entitlement, and telling the site's own owner they had bought the
        season is the bug that made those two functions separate in the first
        place.
     2. The count is the season that was actually fetched, not a number typed
        into this file. If a story is added or withdrawn the line follows it,
        and there is nothing here to go stale.

     No price, no plan name, no renewal date. A subscriber on this page is told
     what they have, never what it costs — /settings is where billing lives. */
  function memberNote(stacks) {
    if (!OWNS) return "";
    var n = stacks.length;
    if (!n) return "";
    return '<p class="libmember">Member · all ' + n +
           ' ' + (n === 1 ? "story" : "stories") + ' unlocked</p>';
  }

  /* --- continue reading ----------------------------------------------------
     Deliberately NOT FBP.continueReading(). That call is not a pure read: it
     asks FBP.unlocked(), which heals the unlock flag out of the cookie mirror
     and back into localStorage. On this page, of all pages, that would re-mint
     the exact flag signing out has to clear — /account carries the same note
     and works around it the same way.

     So the access question goes to FBX instead, through OPEN, which is what
     every cover on screen was already drawn from. That is a second gain: the
     resume block and the grid under it now answer to one variable, so this can
     never offer a story the grid beneath it is padlocking.

     MIN_RESUME is progress.js's, and it is 1: card 0 is the hook, and offering
     to "continue" a story from its first card is not a continuation. Ties on
     `at` fall back to catalogue order, which is arbitrary but stable — the
     sequence counter progress.js breaks them with is private to that file. */
  var MIN_RESUME = 1;

  function continueOf(stacks) {
    var best = null, bestAt = -1, i, s, st;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i];
      if (!s || !s.id || !s.cards) continue;
      if (!s.free && !unlocked()) continue;
      st = stateOf(s.id, s.cards.length);
      if (st.status !== "reading") continue;
      if (st.card < MIN_RESUME) continue;
      if (st.at > bestAt) { bestAt = st.at; best = { s: s, st: st }; }
    }
    if (!best) return null;
    return {
      stack: best.s, id: best.s.id, pct: best.st.pct,
      label: "Continue from card " + (best.st.card + 1),
      href: href(best.s)
    };
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

    /* Filters locked stacks itself, so the most prominent thing on the page
       can never be something the reader cannot open. */
    var cont = null;
    try { cont = continueOf(stacks); } catch (e) { cont = null; }

    var html = "";

    html += statsLine(stacks);
    html += memberNote(stacks);

    if (cont && cont.stack) {
      html += '<div class="sechead"><h2>Continue reading</h2>' +
              '<span>' + esc(cont.pct + "% in") + '</span></div>' +
              '<a class="resume" href="' + esc(cont.href) + '">' +
                '<div class="plate"><img alt="" src="/img/thumbs/' + esc(cont.stack.img) + '.webp"' +
                     heroFallback(cont.stack.img) + '></div>' +
                '<div class="t"><b>' + esc(clean(cont.stack.title)) + '</b>' +
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
          '<h2>Your library is empty</h2>' +
          /* No paragraph. The heading has already said the only thing there
             is to say, and the sentence that used to sit here explained where
             reading is stored to somebody who has not read anything yet. It
             was also, by the end, untrue: reading and saves now go to the
             account as well as to this browser. Removing it is a correction
             as much as a trim, and privacy.html §08 is where that belongs. */
          '<div class="emptygo">' +
            '<a class="go" href="/explore">Explore all stories</a>' +
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

    /* Let the waiting bar finish over the top rather than vanish mid-crawl.
       It is lifted out of the shelf first, so this is not delayed. */
    try {
      if (window.FBLoad && FBLoad.done) {
        FBLoad.done(shelf, function () { shelf.innerHTML = html; });
        return;
      }
    } catch (e) {}
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
    /* Covers only, so the covers index is enough; it falls back to the full
       corpus on its own if the split files are not deployed. */
    (G.loadIndex ? G.loadIndex() : G.load()).then(function (stacks) {
      try {
        _stacks = (stacks && stacks.length) ? stacks : [];
        render(_stacks);
        track("library_own_view", { saved: String(S && S.count ? S.count() : 0) });

        /* Registered after the first render, never before: FBX.paint fires
           immediately when the answer is already known, and a listener that
           can run before the page has drawn is how /stories once reloaded
           itself forever. Redraw only when the answer disagrees with what is
           on screen — in either direction, since signing out has to put the
           padlocks back as surely as subscribing takes them off.

           paint() hands over both halves of the answer: `allowed` is can(),
           and `reason` is why(), from which owns() is "subscriber or legacy"
           and nothing else. Both are compared, because the two move
           independently — an admin flag arriving turns the padlocks off
           without making anybody a member, and the page must not redraw as
           though it had. */
        try {
          if (window.FBX && FBX.paint) {
            FBX.paint(function (allowed, reason) {
              var owns = (reason === "subscriber" || reason === "legacy");
              if (OPEN === !!allowed && OWNS === owns) return;
              OPEN = !!allowed;
              OWNS = owns;
              rerender();
            });
          }
        } catch (e) {}

        /* And the same again for the two stores this shelf draws from, which
           retires a page reload.

           js/progress-sync.js repaints a shelf that is showing a departed
           reader's ticks by reloading the whole page — but only as a last
           resort, and its own guard says why: it returns early when
           `p.listeners() > 1`, on the grounds that something else will
           redraw. Subscribing here IS that something. The shelf redraws in
           place, the reader keeps their scroll position, and the one-shot
           reload stops being reachable from /library.

           Registered after the first render for the same reason as FBX.paint
           above: a listener that can run before the page has drawn is how
           /stories once reloaded itself forever.

           FBS is filtered on `why`. "local" is this tab's own save or unsave,
           which the click handler has already redrawn; redrawing it twice is
           work nobody asked for. Every other reason — the account answering,
           a sign-out clearing the cache — is news this shelf has not drawn
           yet. FBP is not filtered: a tick is only ever written by reading a
           story, which does not happen on this page, so there is no local
           echo to skip. Neither callback writes anything, so neither can
           feed itself. */
        try {
          if (window.FBP && FBP.onChange) FBP.onChange(function () { rerender(); });
          if (window.FBS && FBS.onChange) FBS.onChange(function (why) { if (why !== "local") rerender(); });
        } catch (e) {}
      } catch (e) {
        fail("Something went wrong drawing your library. Reload the page.");
      }
    }).catch(function () {
      fail("Could not load the stories. Check your connection and reload.");
    });
  }

  try { boot(); } catch (e) { fail("Could not load the stories. Reload the page."); }
})();
