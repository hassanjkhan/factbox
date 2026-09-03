/* ==========================================================================
   Factbox — Today.

   The front door. It answers "what should I read right now?" before it offers
   any browsing, which is why Explore is no longer a separate destination: its
   shelves are the bottom of this page.

   Rules this file obeys, the same as js/explore.js:
   - It must never throw. Every DOM lookup, every storage read, every helper on
     FB/FBP is guarded, and a failure renders a sentence a reader can act on
     rather than an empty page. This site has shipped blank twice.
   - ES5 only: var and function. No modules, no build step, no network beyond
     FB.load()'s one fetch of data/stacks.json.
   - It defines nothing global except FBT, and redefines neither FB nor FBP.
   ========================================================================== */

var FBT = (function () {
  "use strict";

  function esc(s) {
    try { if (window.FB && FB.esc) return FB.esc(s); } catch (e) {}
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function str(s) { return s == null ? "" : String(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function track(name, props) { try { if (window.FB && FB.track) FB.track(name, props); } catch (e) {} }
  function unlocked() {
    try { if (window.FB && FB.unlocked) return !!FB.unlocked(); } catch (e) {}
    try { if (window.FBP && FBP.unlocked) return !!FBP.unlocked(); } catch (e) {}
    return false;
  }
  function progress(s) {
    var blank = { status: "unread", card: 0, total: 0, pct: 0 };
    try {
      if (!window.FBP || !FBP.state) return blank;
      var st = FBP.state(str(s.id), s.cards && s.cards.length ? s.cards.length : 0);
      return st && st.status ? st : blank;
    } catch (e) { return blank; }
  }
  function minutes(secs) {
    var m = Math.round((+secs || 0) / 30) / 2;
    if (!m) return "a minute";
    var whole = Math.floor(m), half = (m - whole) >= .5;
    return (whole ? whole : "") + (half ? (whole ? "½" : "½") : "") + " min";
  }
  /* The site's own convention, copied rather than reinvented: js/explore.js,
     stories.html, js/library.js and js/recommend.js all link this way, and
     story 01 is not a deck at all — it is the composed page at /cleopatra.
     Linking it to /read?s=01 sent readers to a second, thinner copy of the
     flagship story. */
  function href(s) {
    var id = str(s.id);
    if (id === "01") return "/cleopatra";
    return "/read?s=" + encodeURIComponent(id);
  }

  /* ---- the taxonomy -------------------------------------------------------
     js/explore.js publishes the group names on window.FBTAX; this mirror is
     used only when that file is not on the page, which is the case here. The
     names are the reader-facing ones, and they are the same table the end card
     reads, so a topic is called one thing across the whole product. */
  var TOPICS = [
    { key: "cleopatra",       name: "Cleopatra" },
    { key: "new_testament",   name: "The New Testament" },
    { key: "church_history",  name: "Saints and sinners" },
    { key: "old_testament",   name: "The Old Testament" },
    { key: "us_history",      name: "America" },
    { key: "ancient_world",   name: "The ancient world" },
    { key: "medieval_modern", name: "Medieval and modern" },
    { key: "disaster",        name: "When it all went wrong" }
  ];
  function topicName(key) {
    var t = null, i;
    try { if (window.FBTAX && FBTAX.TOPICS) t = FBTAX.TOPICS; } catch (e) {}
    var table = t || TOPICS;
    for (i = 0; i < table.length; i++) if (table[i].key === key) return table[i].name || key;
    return key;
  }

  /* ---- today --------------------------------------------------------------
     One story a day, the same one for everybody, decided by the date rather
     than by a server this site does not have. Days since the epoch modulo the
     catalogue, over a stable id order, so every reader on the same day gets
     the same story and tomorrow's is already determined.

     If the reader has finished it, we walk forward from there rather than
     showing them something they have read — the shared pick is the default,
     not a rule worth being unhelpful over. */
  function pickToday(stacks) {
    try {
      if (!stacks || !stacks.length) return null;
      var pool = stacks.slice().sort(function (a, b) {
        return str(a.id) < str(b.id) ? -1 : (str(a.id) > str(b.id) ? 1 : 0);
      });
      var day = Math.floor(Date.now() / 86400000);
      var start = ((day % pool.length) + pool.length) % pool.length, i, s;
      for (i = 0; i < pool.length; i++) {
        s = pool[(start + i) % pool.length];
        if (progress(s).status !== "done") return s;
      }
      return pool[start];
    } catch (e) { return null; }
  }

  /* ---- the streak ---------------------------------------------------------
     Counted from the timestamps already on every reading record, not tracked
     separately: nothing new is stored, and a reader who clears the site loses
     the streak along with the progress it was counted from, which is the
     honest behaviour rather than a number that outlives its evidence. */
  function streak() {
    try {
      if (!window.FBP || !FBP.all) return 0;
      var recs = FBP.all(), days = {}, k, at, n = 0;
      for (k in recs) {
        if (!Object.prototype.hasOwnProperty.call(recs, k)) continue;
        at = recs[k] && recs[k].at;
        if (at) days[Math.floor((+at * 1000) / 86400000)] = 1;
      }
      var today = Math.floor(Date.now() / 86400000);
      /* A streak that breaks the moment you sleep in is a punishment, so today
         OR yesterday starts it — the same grace every habit app gives. */
      var cursor = days[today] ? today : (days[today - 1] ? today - 1 : null);
      if (cursor === null) return 0;
      while (days[cursor]) { n++; cursor--; }
      return n;
    } catch (e) { return 0; }
  }
  function finishedCount(stacks) {
    var n = 0, i;
    try { for (i = 0; i < stacks.length; i++) if (progress(stacks[i]).status === "done") n++; } catch (e) {}
    return n;
  }

  /* ---- pieces -------------------------------------------------------------
     The hook is the sell, so it is the biggest text on a card and the topic is
     a label above it. The title is not shown twice: on a shelf the hook says
     more than the name does, and both together is the same sentence written
     out at two sizes. */
  function plate(s) {
    var p = el("div", "plate");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.src = "/img/thumbs/" + str(s.img) + ".webp";
    img.onerror = function () {
      this.onerror = null;                                  /* one retry, never a loop */
      this.src = "/img/stacks/" + str(s.img) + ".webp";
    };
    p.appendChild(img);
    return p;
  }

  function tile(s, slot) {
    var a = el("a", "td-tile card");
    a.href = href(s);
    a.appendChild(plate(s));
    a.appendChild(el("span", "td-cat", topicName(str(s.topic))));
    a.appendChild(el("b", null, str(s.hook) || str(s.title)));
    var p = progress(s);
    a.appendChild(el("p", "td-meta",
      p.status === "reading" && p.total
        ? (p.card + 1) + " of " + p.total + " cards"
        : (s.cards ? s.cards.length + " cards · " : "") + minutes(s.secs)));
    a.addEventListener("click", function () {
      track("today_click", { stack: str(s.id), slot: String(slot + 1) });
    });
    return a;
  }

  function hero(s, opts) {
    opts = opts || {};
    var a = el("a", "td-hero");
    a.href = href(s);

    var art = el("div", "td-hero-art");
    art.appendChild(plate(s).firstChild);
    a.appendChild(art);

    var body = el("div", "td-hero-body");
    body.appendChild(el("p", "td-eyebrow", opts.eyebrow || "Today's Factbox"));
    body.appendChild(el("p", "td-hook", str(opts.hook || s.hook || s.title)));
    body.appendChild(el("p", "td-meta", opts.meta ||
      ((s.cards ? s.cards.length + " cards · " : "") + minutes(s.secs))));

    if (opts.pct != null) {
      var bar = el("div", "td-bar");
      var t = el("div", "td-bar-t");
      var fill = el("i");
      fill.style.width = Math.max(4, Math.min(100, opts.pct)) + "%";
      t.appendChild(fill);
      bar.appendChild(t);
      body.appendChild(bar);
    }

    var go = el("span", "go", opts.cta || "Start story");
    body.appendChild(go);
    a.appendChild(body);
    a.addEventListener("click", function () {
      track("today_hero", { stack: str(s.id), kind: opts.kind || "today" });
    });
    return a;
  }

  function section(title, count, node) {
    var sec = el("section", "td-sec");
    var h = el("h2", null, title);
    if (count) h.appendChild(el("span", null, count));
    sec.appendChild(h);
    sec.appendChild(node);
    return sec;
  }

  function shelf(list) {
    var row = el("div", "td-shelf"), i;
    for (i = 0; i < list.length; i++) row.appendChild(tile(list[i], i));
    return row;
  }

  /* Series: the topics, named, with how far in the reader is. A count is a
     library and easy to abandon; an unfinished thing of known length is not. */
  function seriesRows(stacks) {
    var by = {}, order = [], i, s, k;
    for (i = 0; i < stacks.length; i++) {
      s = stacks[i]; k = str(s.topic);
      if (!k) continue;
      if (!by[k]) { by[k] = []; order.push(k); }
      by[k].push(s);
    }
    var wrap = el("div", "td-series");
    order.sort(function (a, b) { return by[b].length - by[a].length; });
    for (i = 0; i < order.length; i++) {
      k = order[i];
      if (by[k].length < 2) continue;              /* one story is not a series */
      var done = 0, j;
      for (j = 0; j < by[k].length; j++) if (progress(by[k][j]).status === "done") done++;
      var a = el("a", "td-row");
      a.href = "/explore#" + encodeURIComponent(k);
      a.appendChild(plate(by[k][0]));
      var t = el("div", "td-row-t");
      t.appendChild(el("b", null, topicName(k)));
      t.appendChild(el("span", "td-meta",
        done ? done + " of " + by[k].length + " read" : by[k].length + " stories"));
      a.appendChild(t);
      var ch = el("span", "td-chev");
      ch.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
      a.appendChild(ch);
      wrap.appendChild(a);
    }
    return wrap;
  }

  function chips() {
    var wrap = el("div", "td-chips"), i;
    var table = TOPICS;
    try { if (window.FBTAX && FBTAX.TOPICS) table = FBTAX.TOPICS; } catch (e) {}
    for (i = 0; i < table.length; i++) {
      var a = el("a", "td-chip", table[i].name || table[i].key);
      a.href = "/explore#" + encodeURIComponent(table[i].key);
      wrap.appendChild(a);
    }
    return wrap;
  }

  /* ---- render ------------------------------------------------------------- */
  function render(root, stacks) {
    var page = el("div", "td");
    var open = unlocked();
    var resume = null;
    try { if (window.FBP && FBP.continueReading) resume = FBP.continueReading(stacks); } catch (e) {}
    var days = streak(), fin = finishedCount(stacks);

    /* A returning reader is greeted and pointed back at the thing they left;
       a new one is told what this is. Same page, two openings. */
    if (resume || days || fin) {
      page.appendChild(el("h1", "td-h1", "Welcome back. Ready for 5 minutes?"));
      if (days || fin) {
        var stats = el("div", "td-stats");
        if (days) {
          var sk = el("span", "td-streak");
          sk.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" ' +
            'aria-hidden="true"><path d="M13.5 2.2c.4 3-1.2 4.3-2.6 5.6C9.3 9.3 8 10.6 8 13a4.9 4.9 0 0 0 ' +
            '1.6 3.6c-.3-1.7.4-3 1.5-4-.2 2 .9 3 2 3.9 1 .8 1.6 1.7 1.6 3a5 5 0 0 0 2.6-4.4c0-2.3-1-3.6-2-4.8-1.2' +
            '-1.4-2.3-2.6-1.8-5-.9.4-1.6 1-2 1.7.2-1.6.9-3.2 2-4.8z"/></svg>';
          sk.appendChild(document.createTextNode(
            " " + days + (days === 1 ? " day streak" : " day streak")));
          stats.appendChild(sk);
        }
        if (days && fin) stats.appendChild(el("span", "td-dot"));
        if (fin) stats.appendChild(el("span", "td-stat",
          fin + (fin === 1 ? " story finished" : " stories finished")));
        page.appendChild(stats);
      }
    } else {
      page.appendChild(el("h1", "td-h1", "Get smarter about history in 5 minutes a day."));
      page.appendChild(el("p", "td-sub",
        "The wildest stories, people, scandals, and mysteries from history, " +
        "broken into bite-sized lessons."));
    }

    if (resume && resume.stack) {
      page.appendChild(hero(resume.stack, {
        eyebrow: "Continue",
        hook: str(resume.stack.hook) || str(resume.stack.title),
        meta: (resume.card + 1) + " of " + resume.total + " cards",
        pct: resume.pct, cta: "Keep going", kind: "resume"
      }));
    }

    var today = pickToday(stacks);
    if (today && (!resume || str(today.id) !== str(resume.id))) {
      page.appendChild(hero(today, { kind: "today" }));
    }

    /* Everything below is the browsing that used to be its own tab. */
    var rest = [], i;
    for (i = 0; i < stacks.length; i++) {
      if (today && str(stacks[i].id) === str(today.id)) continue;
      if (resume && str(stacks[i].id) === str(resume.id)) continue;
      if (progress(stacks[i]).status === "done") continue;
      rest.push(stacks[i]);
    }
    if (rest.length) page.appendChild(section("Trending now", null, shelf(rest.slice(0, 8))));

    page.appendChild(section("Pick an obsession", null, chips()));
    page.appendChild(section("Binge a series", null, seriesRows(stacks)));

    var search = el("a", "td-search");
    search.href = "/explore";
    search.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
    search.appendChild(document.createTextNode("Search all " + stacks.length + " stories"));
    page.appendChild(search);

    root.innerHTML = "";
    root.appendChild(page);
    track("today_view", { open: open ? "1" : "0", streak: String(days) });
  }

  function boot(rootId) {
    var root = null;
    try { root = document.getElementById(rootId || "td"); } catch (e) {}
    if (!root) return;
    try {
      FB.load().then(function (stacks) {
        try { render(root, stacks); }
        catch (e) {
          root.innerHTML = '<p class="fine" style="margin-top:28px">' +
            "Something went wrong drawing this page. " +
            '<a href="/explore">Browse every story</a> instead.</p>';
        }
      }).catch(function () {
        root.innerHTML = '<p class="fine" style="margin-top:28px">' +
          "Could not load the stories. Check your connection and reload.</p>";
      });
    } catch (e) {
      root.innerHTML = '<p class="fine" style="margin-top:28px">' +
        "Could not load the stories. Check your connection and reload.</p>";
    }
  }

  return { boot: boot, streak: streak, pickToday: pickToday, version: 1 };
})();
