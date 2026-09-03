/* ==========================================================================
   Factbox — Explore.

   The job: someone just finished a story and wants the next one. So this page
   is built to make the season feel big and the choice feel small — shelves you
   can flick through, two ways of grouping the same 51 covers, and a search box
   that answers before you finish typing.

   Rules this file obeys without exception:
   - It must never throw. Every DOM lookup, every storage read, every helper on
     FB/FBP is guarded, and a failure renders a sentence a reader can act on
     rather than an empty page. This site has shipped blank twice.
   - ES5 only: var and function. No modules, no build step, no network beyond
     FB.load()'s one fetch of data/stacks.json.
   - It does not define or redefine FB or FBP. If progress.js never loaded,
     every cover simply renders unread.
   ========================================================================== */

(function () {

  /* --- guarded access to the shared globals -------------------------------
     esc and minutes are duplicated rather than required, because a page that
     goes blank when one script 404s is worse than eight lines of overlap. */

  function esc(s) {
    try { if (window.FB && FB.esc) return FB.esc(s); } catch (e) {}
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Half-minute steps, the same arithmetic as FB.minutes in gate.js. Whole
     minutes labelled 49 of the 51 stories "2 min", which is the one number a
     reader wants from that line carrying no information at all. If this and
     gate.js ever disagree the same story shows two lengths on two pages. */
  function mins(secs) {
    try { if (window.FB && FB.minutes) return FB.minutes(secs); } catch (e) {}
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "\u00bd min";
    return whole + (halves % 2 ? "\u00bd" : "") + " min";
  }

  /* Always an object. No FBP, no reading memory, every cover unread. */
  function pstate(id, total) {
    try {
      if (window.FBP && FBP.state) {
        var st = FBP.state(id, total);
        if (st && st.status) return st;
      }
    } catch (e) {}
    return { status: "unread", pct: 0, label: "", at: 0 };
  }

  function readAt(id) {
    try {
      if (window.FBP && FBP.get) { var r = FBP.get(id); if (r) return r.at || 0; }
    } catch (e) {}
    return 0;
  }

  function unlocked() {
    try { if (window.FB && FB.unlocked) return !!FB.unlocked(); } catch (e) {}
    try { if (window.FBP && FBP.unlocked) return !!FBP.unlocked(); } catch (e) {}
    return false;
  }

  function track(name) { try { if (window.FB && FB.track) FB.track(name); } catch (e) {} }

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  /* --- display names ------------------------------------------------------
     The raw keys are how the data is filed, not how a reader thinks. Every
     name below is what someone would say out loud, and every note under it is
     a plain description of what is actually in that group — never a claim the
     stories do not make.

     THIS IS THE ONE COPY. Two tables meant one group had two names, and one of
     them was wrong ("the medieval world", over a group containing Rasputin,
     who died in 1916). So each record carries every form the site needs:

       name   the heading form            "Medieval and modern"
       lower  the mid-sentence form       "More on the medieval and modern world"
       note   what is in the group        "Joan of Arc to Rasputin"
       note1  the same note when the group holds exactly one story; omitted
              where the plural form already reads correctly for one

     KINDS carry `more`, the "read another like this one" form, for the same
     reason. Published on window.FBTAX at the bottom of this file so the
     reader page's recommender can read it instead of keeping its own copy. */

  var TOPICS = [
    { key: "cleopatra",      name: "Cleopatra",              lower: "Cleopatra",
      note: "her death, her tomb, her reputation" },
    { key: "new_testament",  name: "The New Testament",      lower: "the New Testament",
      note: "Jesus, Paul, Peter, Mary Magdalene" },
    { key: "church_history", name: "Saints and sinners", lower: "saints and sinners",
      note: "what the early church argued about" },
    { key: "old_testament",  name: "The Old Testament",      lower: "the Old Testament",
      note: "the Ark, the scrolls, the kings" },
    { key: "us_history",     name: "America",                lower: "America",
      note: "Lincoln, and the night he was shot" },
    { key: "ancient_world",  name: "The ancient world",      lower: "the ancient world",
      note: "Rome, Greece, Alexander" },
    { key: "medieval_modern",name: "Medieval and modern",    lower: "the medieval and modern world",
      note: "Joan of Arc to Rasputin" },
    { key: "disaster",       name: "When it all went wrong", lower: "disasters",
      note: "disasters, hour by hour", note1: "one disaster, hour by hour" }
  ];

  var KINDS = [
    { key: "unsolved_mystery", name: "Unsolved mysteries",   more: "Another unsolved one",
      note: "nobody knows the answer" },
    { key: "myth_correction",  name: "Things you have wrong", more: "Another myth, corrected",
      note: "the version everyone repeats, checked" },
    { key: "violent_death",    name: "Deaths",               more: "Another grisly one",
      note: "how they actually died" },
    { key: "list_explainer",   name: "The whole thing, explained", more: "Another explainer",
      note: "laid out in order" },
    { key: "moral_reversal",   name: "The turn nobody mentions", more: "Another one that flips",
      note: "the part that complicates it" },
    { key: "hidden_meaning",   name: "Hidden meanings",      more: "Another hidden meaning",
      note: "what it meant to the people who wrote it" }
  ];

  /* One story under a plural note reads as a claim the shelf does not keep —
     "1 story · disasters, hour by hour". Records that need a different
     sentence for one story carry note1; the rest fall through unchanged. */
  function noteFor(rec, n) {
    if (!rec) return "";
    return (n === 1 && rec.note1) ? rec.note1 : (rec.note || "");
  }

  function nameOf(list, key) {
    for (var i = 0; i < list.length; i++) { if (list[i].key === key) return list[i].name; }
    return key;
  }

  /* --- state --------------------------------------------------------------
     One filter at a time plus a query. Both compose: pick a theme, then search
     inside it. */

  var STACKS = [];
  var INDEX  = {};          /* id -> lowercased haystack */
  var OPEN   = false;
  var Q      = "";
  var FTYPE  = "";          /* "topic" | "kind" | "" */
  var FKEY   = "";

  var view, tally, input, clearBtn, chips, buybar;

  /* --- small helpers ------------------------------------------------------ */

  function take(arr, n) { return arr.slice(0, n); }

  function count(n) { return n + (n === 1 ? " story" : " stories"); }

  function by(field, key) {
    return STACKS.filter(function (s) { return s && s[field] === key; });
  }

  function href(s) {
    /* Stack 01 is the fully illustrated build and lives at the front page, so
       its cover points there rather than at the generic reader — same rule as
       the home shelf. A locked cover still points at read.html, which is where
       the paywall lives; it is not this page's job to sell. */
    if (s.id === "01") return "/cleopatra";
    return "/read?s=" + encodeURIComponent(s.id);
  }

  /* --- one cover ----------------------------------------------------------
     Deliberately identical to the home shelf's card: same classes, same lock,
     same readbar, all already styled in app.css. A cover that looks different
     on two pages reads as two different stories. */

  function card(s) {
    if (!s || !s.id) return "";
    var total  = s.cards && s.cards.length ? s.cards.length : 0;
    var locked = !s.free && !OPEN;
    var st     = pstate(s.id, total);
    return '' +
      '<a class="card is-' + st.status + (locked ? " locked" : "") + '"' +
         ' data-id="' + esc(s.id) + '" href="' + esc(href(s)) + '">' +
        '<div class="plate">' +
          '<img loading="lazy" decoding="async" alt="" ' +
               'src="/img/thumbs/' + esc(s.img) + '.webp">' +
          (locked
            ? '<span class="lock" aria-hidden="true">🔒</span>'
            : (s.free ? '<span class="freetag">FREE</span>' : '')) +
          (st.pct ? '<i class="readbar" style="width:' + st.pct + '%"></i>' : '') +
        '</div>' +
        '<h3>' + esc(s.title) + '</h3>' +
        '<p class="meta">' + (st.label ? esc(st.label)
            : total + ' cards · ' + mins(s.secs)) + '</p>' +
      '</a>';
  }

  /* A shelf you flick sideways. Used everywhere on this page except search
     results, because a cover is the pitch and a wall of them is a chore. */
  function shelf(title, note, items, cap) {
    if (!items || !items.length) return "";
    var shown = cap ? take(items, cap) : items;
    return '' +
      '<section class="row">' +
        '<div class="sechead"><h2>' + esc(title) + '</h2>' +
        '<span>' + esc(note) + '</span></div>' +
        '<div class="shelf">' + shown.map(card).join("") + '</div>' +
      '</section>';
  }

  /* Results and filtered views get a grid, because there the reader is looking
     for one specific thing and wants to see the whole answer at once. */
  function grid(title, note, items) {
    if (!items || !items.length) return "";
    return '' +
      '<section class="row">' +
        '<div class="sechead"><h2>' + esc(title) + '</h2>' +
        '<span>' + esc(note) + '</span></div>' +
        '<div class="grid">' + items.map(card).join("") + '</div>' +
      '</section>';
  }

  function ghead(title, note) {
    return '<div class="ghead"><h2>' + esc(title) + '</h2>' +
           '<p>' + esc(note) + '</p></div>';
  }

  /* --- search -------------------------------------------------------------
     Title, hook and every card headline, lowercased once at load. Fifty-one
     short strings; there is nothing here worth debouncing. */

  function buildIndex() {
    for (var i = 0; i < STACKS.length; i++) {
      var s = STACKS[i];
      if (!s || !s.id) continue;
      var bits = [s.title || "", s.hook || "", nameOf(TOPICS, s.topic), nameOf(KINDS, s.kind)];
      try {
        var cs = s.cards || [];
        for (var j = 0; j < cs.length; j++) {
          if (cs[j] && cs[j].head) bits.push(cs[j].head);
        }
      } catch (e) {}
      try { INDEX[s.id] = bits.join(" ").toLowerCase(); }
      catch (e) { INDEX[s.id] = String(s.title || "").toLowerCase(); }
    }
  }

  /* Every word has to appear somewhere, so "cleopatra tomb" narrows rather
     than widens. Curly apostrophes are folded, because nobody types one. */
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
  }

  function matches(s, words) {
    var hay = INDEX[s.id] || "";
    hay = hay.replace(/[‘’ʼ]/g, "'");
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(words[i]) === -1) return false;
    }
    return true;
  }

  function search(pool, q) {
    var words = norm(q).split(" ");
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      if (matches(pool[i], words)) out.push(pool[i]);
    }
    return out;
  }

  /* --- chips --------------------------------------------------------------
     Rendered once and mutated by class, so tapping one never steals focus from
     the search field or reflows the whole control strip. */

  function chipHTML() {
    var out = '<p class="chiplab">Theme</p><div class="chiprow" role="group" aria-label="Filter by theme">';
    out += '<button type="button" class="chip on" data-t="" data-k="">All 51</button>';
    var i;
    for (i = 0; i < TOPICS.length; i++) {
      var n = by("topic", TOPICS[i].key).length;
      if (!n) continue;
      out += '<button type="button" class="chip" data-t="topic" data-k="' + esc(TOPICS[i].key) + '">' +
             esc(TOPICS[i].name) + ' <b>' + n + '</b></button>';
    }
    out += '</div><p class="chiplab">Kind of story</p>' +
           '<div class="chiprow" role="group" aria-label="Filter by kind of story">';
    for (i = 0; i < KINDS.length; i++) {
      var m = by("kind", KINDS[i].key).length;
      if (!m) continue;
      out += '<button type="button" class="chip" data-t="kind" data-k="' + esc(KINDS[i].key) + '">' +
             esc(KINDS[i].name) + ' <b>' + m + '</b></button>';
    }
    return out + '</div>';
  }

  function syncChips() {
    if (!chips || !chips.querySelectorAll) return;
    var all = chips.querySelectorAll(".chip");
    for (var i = 0; i < all.length; i++) {
      var on = (all[i].getAttribute("data-t") || "") === FTYPE &&
               (all[i].getAttribute("data-k") || "") === FKEY;
      all[i].className = on ? "chip on" : "chip";
      try { all[i].setAttribute("aria-pressed", on ? "true" : "false"); } catch (e) {}
    }
  }

  /* --- the default browse -------------------------------------------------
     Every shelf below is derived from the data in hand — seconds, card counts,
     kind, and this browser's own reading memory. Nothing here asserts anything
     about a story that the story does not say itself. */

  function browse() {
    var out = "";
    var i;

    /* One answer to "where was I", same component as the home shelf. */
    try {
      if (window.FBP && FBP.continueReading) {
        var cont = FBP.continueReading(STACKS);
        if (cont && cont.stack) {
          out += '<a class="resume" href="' +
                   esc(cont.id === "01" ? "/cleopatra" : cont.href) + '">' +
                   '<div class="plate"><img alt="" src="/img/thumbs/' +
                      esc(cont.stack.img) + '.webp"></div>' +
                   '<div class="t"><b>' + esc(cont.stack.title) + '</b>' +
                   '<span>' + esc(cont.label) + '</span></div></a>';
        }
      }
    } catch (e) {}

    var reading = [], done = [], fresh = [];
    for (i = 0; i < STACKS.length; i++) {
      var st = pstate(STACKS[i].id, (STACKS[i].cards || []).length);
      if (st.status === "reading") reading.push(STACKS[i]);
      else if (st.status === "done") done.push(STACKS[i]);
      else fresh.push(STACKS[i]);
    }
    /* Most recently touched first — the one you abandoned last is the one you
       are most likely to want back. */
    reading.sort(function (a, b) { return readAt(b.id) - readAt(a.id); });

    out += shelf("Keep reading", count(reading.length) + " you started", reading, 14);

    var free = STACKS.filter(function (s) { return !!s.free; });
    if (!OPEN) out += shelf("Start here", "free, no account", free, 14);

    /* Shortest by the season's own recorded read time. */
    var quick = STACKS.slice().sort(function (a, b) { return (a.secs || 0) - (b.secs || 0); });
    out += shelf("Quickest reads", "the shortest in the season", quick, 12);

    /* Longest by card count, and the threshold is stated rather than implied. */
    var long_ = STACKS.filter(function (s) { return (s.cards || []).length >= 11; })
                      .sort(function (a, b) { return (b.cards || []).length - (a.cards || []).length; });
    out += shelf("The long ones", "eleven cards or more", long_, 12);

    /* Only worth a shelf once the reader has actually read something —
       otherwise "you have not opened these" is all fifty-one. */
    if (fresh.length && fresh.length < STACKS.length) {
      out += shelf("You have not opened these", count(fresh.length) + " left", fresh, 16);
    }
    if (done.length) {
      out += shelf("Finished", count(done.length) + " · read them again", done, 14);
    }

    out += ghead("Browse by theme",
                 "Eight subjects. Tap a name above to see one on its own.");
    for (i = 0; i < TOPICS.length; i++) {
      var t = by("topic", TOPICS[i].key);
      out += shelf(TOPICS[i].name, count(t.length) + " · " + noteFor(TOPICS[i], t.length), t);
    }

    out += ghead("Browse by kind of story",
                 "The same fifty-one, sorted by what the story does to you.");
    for (i = 0; i < KINDS.length; i++) {
      var k = by("kind", KINDS[i].key);
      out += shelf(KINDS[i].name, count(k.length) + " · " + noteFor(KINDS[i], k.length), k);
    }
    return out;
  }

  /* --- render -------------------------------------------------------------
     One function, one source of truth. Filter, then search inside the filter. */

  function render() {
    if (!view) return;
    var pool = STACKS;
    var label = "";

    if (FTYPE === "topic") { pool = by("topic", FKEY); label = nameOf(TOPICS, FKEY); }
    else if (FTYPE === "kind") { pool = by("kind", FKEY); label = nameOf(KINDS, FKEY); }

    var q = norm(Q);
    var hits = q ? search(pool, q) : pool;

    if (clearBtn) clearBtn.hidden = !Q;

    if (!q && !FTYPE) {
      if (tally) tally.textContent = count(STACKS.length) + " in season one";
      view.innerHTML = browse();
      return;
    }

    if (tally) {
      tally.textContent = count(hits.length) +
        (q ? ' matching “' + Q + '”' : "") +
        (label ? " in " + label : "");
    }

    if (!hits.length) {
      /* A real empty state: says what happened, and gives a way out that is
         one tap rather than a re-typed query. */
      view.innerHTML =
        '<div class="void">' +
          '<b>Nothing matches “' + esc(Q) + '”' + (label ? " in " + esc(label) : "") + '.</b>' +
          '<p>Search runs over every title, hook and card headline in the ' +
          'season. Try a name — Cleopatra, Lincoln, Napoleon, Nero — or a ' +
          'single word from the story.</p>' +
          '<button type="button" class="reset" id="reset">Show all 51 stories</button>' +
        '</div>';
      wireReset();
      return;
    }

    var head = label || "Results";
    var note = q ? count(hits.length) + " matching" : count(hits.length);
    view.innerHTML =
      grid(head, note, hits) +
      '<div class="void slim">' +
        '<button type="button" class="reset" id="reset">Show all 51 stories</button>' +
      '</div>';
    wireReset();
  }

  function wireReset() {
    var b = el("reset");
    if (!b) return;
    try {
      b.addEventListener("click", function () {
        Q = ""; FTYPE = ""; FKEY = "";
        if (input) input.value = "";
        syncChips();
        render();
        try { window.scrollTo(0, 0); } catch (e) {}
      });
    } catch (e) {}
  }

  /* --- failure ------------------------------------------------------------
     Never a silent empty page. If the data will not load, the reader gets a
     sentence and two links that still work. */
  function fail() {
    if (!view) return;
    view.innerHTML =
      '<div class="void">' +
        '<b>The story list did not load.</b>' +
        '<p>This usually means the connection dropped. Reload the page, or ' +
        'open the season shelf, which lists all fifty-one.</p>' +
        '<a class="reset" href="/stories">All stories</a>' +
      '</div>';
    if (tally) tally.textContent = "";
  }

  /* --- boot --------------------------------------------------------------- */

  function boot() {
    view     = el("view");
    tally    = el("tally");
    input    = el("q");
    clearBtn = el("qx");
    chips    = el("chips");
    buybar   = el("buybar");

    if (!view) return;                       /* nothing to render into */

    if (!window.FB || !FB.load) { fail(); return; }

    /* Deliberately not read here. This runs before the account has answered,
       so reading it now paints padlocks over stories the reader has paid for.
       It is set inside the load below, after FBX.ready() has settled. */

    if (buybar) buybar.hidden = OPEN;
    var pay = el("pay");
    if (pay) {
      try {
        pay.addEventListener("click", function () {
          try { if (FB.checkout) FB.checkout(this, "explore"); } catch (e) {}
        });
      } catch (e) {}
    }

    if (input) {
      try {
        input.addEventListener("input", function () {
          Q = this.value || "";
          render();
        });
        /* Enter must not reload the page inside an in-app webview. */
        input.addEventListener("keydown", function (ev) {
          if (ev && ev.key === "Enter") { try { ev.preventDefault(); } catch (e) {} }
        });
      } catch (e) {}
    }
    if (clearBtn) {
      try {
        clearBtn.addEventListener("click", function () {
          Q = "";
          if (input) { input.value = ""; try { input.focus(); } catch (e) {} }
          render();
        });
      } catch (e) {}
    }
    if (chips) {
      try {
        chips.addEventListener("click", function (ev) {
          var t = ev && ev.target;
          while (t && t !== chips && (!t.className || String(t.className).indexOf("chip") === -1)) {
            t = t.parentNode;
          }
          if (!t || t === chips) return;
          var ty = t.getAttribute("data-t") || "";
          var ky = t.getAttribute("data-k") || "";
          if (ty === FTYPE && ky === FKEY) { FTYPE = ""; FKEY = ""; }
          else { FTYPE = ty; FKEY = ky; }
          syncChips();
          render();
        });
      } catch (e) {}
    }

    var _wait = (window.FBX && FBX.ready) ? FBX.ready() : Promise.resolve();
    Promise.all([FB.load(), _wait]).then(function (_r) {
      var stacks = _r[0];
      try {
        OPEN = unlocked();
        if (buybar) buybar.hidden = OPEN;
        STACKS = (stacks && stacks.length) ? stacks : [];
        if (!STACKS.length) { fail(); return; }
        buildIndex();
        if (chips) { chips.innerHTML = chipHTML(); syncChips(); }
        render();
        track("explore_view");
      } catch (e) { fail(); }
    })["catch"](function () { fail(); });
  }

  /* --- the taxonomy, published ---------------------------------------------
     js/recommend.js needs the same names on the reader page, where this file
     is not loaded. Rather than a second table that drifts, it reads this one
     and falls back to its own mirror when explore.js is absent. Additive: it
     defines a new global and redefines nothing. */
  try {
    if (typeof window !== "undefined") window.FBTAX = { TOPICS: TOPICS, KINDS: KINDS };
  } catch (e) {}

  /* The script tag is at the end of the body, so the DOM is already parsed —
     but boot is guarded either way, and the whole thing is wrapped so a
     surprise from any helper degrades to a message rather than a blank page. */
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        try { boot(); } catch (e) { fail(); }
      });
    } else {
      boot();
    }
  } catch (e) {
    try { fail(); } catch (e2) {}
  }
})();
