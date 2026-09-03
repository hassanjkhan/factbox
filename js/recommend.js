/* ==========================================================================
   Factbox — "read another one".

   One global, FBR. It owns the moment a story ends: the single highest-intent
   second on the site. It does not own the reader page, does not fetch, does
   not write storage, and defines nothing else.

   Hard rule, learned the expensive way: this file must never throw. Every
   public function is wrapped, every dependency is optional. If FBP (reading
   memory) is missing, ranking simply loses one signal. If FBS (saves) is
   missing, the rows lose one button. If the data is empty or malformed, the
   panel still renders and still points somewhere.
   ========================================================================== */

var FBR = (function () {
  "use strict";

  /* ---- scoring weights ---------------------------------------------------
     Ordered so the two penalties dominate: a finished story can never
     outrank an unread one, and a story the reader cannot open can never
     outrank one they can. Both stay in the list rather than vanishing, so
     the panel is never empty. */
  var W = {
    topic:    120,   /* same subject as the story just finished — strongest */
    kind:     45,    /* same shape of story — weaker, but real */
    resume:   90,    /* they started it and walked away */
    freeOpen: 60,    /* locked-out reader: a story they can actually read */
    unread:   12,    /* mild nudge toward something new */
    done:     -400,  /* already finished — hard deprioritise, not hidden */
    shut:     -1200  /* locked to this reader — last resort only, and marked */
  };

  /* ---- the taxonomy ------------------------------------------------------
     js/explore.js owns the group names and publishes them on window.FBTAX.
     A second table here is how "the medieval world" ended up over a group
     that contains Rasputin, who died in 1916 — so this is a mirror used only
     when explore.js is not on the page (which is every reader page), and the
     lookups below always prefer the published copy.

     `lower` is the mid-sentence form of a TOPIC ("More on the ancient world");
     `more` is the "one more like this" form of a KIND. Both live on the same
     record as the heading name, so there is one table, not two. */
  var FALLBACK = {
    TOPICS: [
      { key: "cleopatra",       name: "Cleopatra",                   lower: "Cleopatra" },
      { key: "new_testament",   name: "The New Testament",           lower: "the New Testament" },
      { key: "church_history",  name: "Saints and sinners",          lower: "saints and sinners" },
      { key: "old_testament",   name: "The Old Testament",           lower: "the Old Testament" },
      { key: "us_history",      name: "America",                     lower: "America" },
      { key: "ancient_world",   name: "The ancient world",           lower: "the ancient world" },
      { key: "medieval_modern", name: "Medieval and modern",         lower: "the medieval and modern world" },
      { key: "disaster",        name: "When it all went wrong",      lower: "disasters" }
    ],
    KINDS: [
      { key: "unsolved_mystery", name: "Unsolved mysteries",          more: "Another unsolved one" },
      { key: "myth_correction",  name: "Things you have wrong",       more: "Another myth, corrected" },
      { key: "violent_death",    name: "Deaths",                      more: "Another grisly one" },
      { key: "list_explainer",   name: "The whole thing, explained",  more: "Another explainer" },
      { key: "moral_reversal",   name: "The turn nobody mentions",    more: "Another one that flips" },
      { key: "hidden_meaning",   name: "Hidden meanings",             more: "Another hidden meaning" }
    ]
  };

  /* Read at call time, not at load: explore.js may define FBTAX after this
     file parses, and a table that is missing or malformed must never throw. */
  function taxon(which) {
    try {
      var t = window.FBTAX && window.FBTAX[which];
      /* Records, not just something with a length — a string has one too. */
      if (t && t.length && t[0] && t[0].key) return t;
    } catch (e) {}
    return FALLBACK[which];
  }

  function form(which, key, field) {
    try {
      var t = taxon(which), i;
      for (i = 0; i < t.length; i++) {
        if (t[i] && t[i].key === key) return str(t[i][field] || t[i].name);
      }
    } catch (e) {}
    return "";
  }

  /* "More on the ancient world" */
  function topicPhrase(key) { return form("TOPICS", key, "lower"); }
  /* "Another myth, corrected" */
  function kindPhrase(key)  { return form("KINDS",  key, "more"); }

  /* ---- tiny helpers ---------------------------------------------------- */

  function isArr(x) { return Object.prototype.toString.call(x) === "[object Array]"; }

  function str(x) { return x == null ? "" : String(x); }

  /* stacks may arrive as the array, or as the raw {stacks:[...]} payload. */
  function listOf(stacks) {
    if (isArr(stacks)) return stacks;
    if (stacks && isArr(stacks.stacks)) return stacks.stacks;
    return [];
  }

  /* current may be the stack object, its id, or nothing. */
  function idOf(current) {
    if (current == null) return "";
    if (typeof current === "string" || typeof current === "number") return String(current);
    return str(current.id);
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && str(list[i].id) === id) return list[i];
    }
    return null;
  }

  function unlocked() {
    try { if (window.FB && typeof FB.unlocked === "function") return !!FB.unlocked(); } catch (e) {}
    try { if (window.FBP && typeof FBP.unlocked === "function") return !!FBP.unlocked(); } catch (e) {}
    return false;
  }

  /* Reading memory is optional. Absent, everything is "unread", which is a
     correct answer for a reader whose memory we do not have. */
  function progress(s) {
    var blank = { status: "unread", card: 0, pct: 0 };
    try {
      if (!window.FBP || typeof FBP.state !== "function") return blank;
      var st = FBP.state(str(s.id), s.cards && s.cards.length ? s.cards.length : 0);
      return st && st.status ? st : blank;
    } catch (e) { return blank; }
  }

  /* Half-minute steps, the same arithmetic as FB.minutes in gate.js. A row
     that says "2 min" beside a reader page saying "1½ min" is the same story
     with two lengths. */
  function minutes(secs) {
    try {
      if (window.FB && typeof FB.minutes === "function") return FB.minutes(secs);
    } catch (e) {}
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "\u00bd min";
    return whole + (halves % 2 ? "\u00bd" : "") + " min";
  }

  /* Stack 01 is the illustrated one-off page; everything else is the reader. */
  function href(s) {
    var id = idOf(s);
    if (id === "01") return "/cleopatra";
    return "/read?s=" + encodeURIComponent(id);
  }

  /* Deterministic spread. Without it the tail of every ranking is just
     catalogue order, so the same three covers follow every story in a topic.
     With it the order is varied but identical on every reload, forever. */
  function hash(a, b) {
    var s = str(a) + "|" + str(b), h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h % 17;   /* 0..16 — smaller than any real signal weight */
  }

  /* ---- why is this here, in the reader's language ---------------------- */

  function reason(cur, s, p, readerLocked) {
    var topic = cur ? str(cur.topic) : "";
    var kind  = cur ? str(cur.kind)  : "";
    if (p.status === "reading" && p.card > 0) return { key: "resume", text: "You started this one" };
    if (p.status === "done")                  return { key: "done",   text: "Worth a second read" };
    if (topic && str(s.topic) === topic) {
      var name = topicPhrase(s.topic) || str(s.topic).replace(/_/g, " ");
      return { key: "topic", text: "More on " + name };
    }
    if (readerLocked && s.free)               return { key: "free",   text: "Free to read now" };
    if (kind && str(s.kind) === kind)         return { key: "kind",   text: kindPhrase(s.kind) || "Another one like it" };
    var browse = s.topic ? topicPhrase(str(s.topic)) : "";
    if (browse)                               return { key: "browse", text: "More on " + browse };
    return { key: "next", text: "Next up" };
  }

  /* ---- ranking ---------------------------------------------------------- */

  /* next(current, stacks, n) -> array of up to n rows.
     Each row is a shallow copy of the stack with four fields added:
       why    reader-facing sentence  ("More on Cleopatra")
       whyKey machine tag             ("topic" | "kind" | "resume" | "done" | "free" | "browse" | "next")
       locked true when this reader cannot open it — the caller MUST mark it
       href   where to send them
     Deterministic: same inputs, same output, every reload. */
  function next(current, stacks, n) {
    try {
      var list = listOf(stacks);
      var want = Math.max(1, Math.min(list.length, Math.floor(+n) || 3));
      if (!list.length) return [];

      var curId = idOf(current);
      var cur = (current && typeof current === "object" && current.id != null)
        ? current : find(list, curId);
      var open = unlocked();
      var rows = [], i, s, p, sc, shut;

      for (i = 0; i < list.length; i++) {
        s = list[i];
        if (!s || s.id == null) continue;
        if (str(s.id) === curId) continue;           /* never the story they are on */

        p = progress(s);
        shut = !s.free && !open;
        sc = 0;

        if (cur && s.topic && str(s.topic) === str(cur.topic)) sc += W.topic;
        if (cur && s.kind  && str(s.kind)  === str(cur.kind))  sc += W.kind;
        if (p.status === "reading" && p.card > 0) sc += W.resume;
        else if (p.status === "done") sc += W.done;
        else sc += W.unread;
        if (!open && s.free) sc += W.freeOpen;
        if (shut) sc += W.shut;
        sc += hash(curId, s.id);

        var r = shallow(s);
        var why = reason(cur, s, p, !open);
        r.why = why.text;
        r.whyKey = why.key;
        r.locked = shut;
        r.href = href(s);
        r.score = sc;
        rows.push(r);
      }

      /* Total order — score, then id — so sort stability is never relied on. */
      rows.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return str(a.id) < str(b.id) ? -1 : (str(a.id) > str(b.id) ? 1 : 0);
      });

      return rows.slice(0, want);
    } catch (e) { return []; }
  }

  function shallow(s) {
    var o = {}, k;
    for (k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k]; }
    return o;
  }

  /* ---- DOM -------------------------------------------------------------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function track(name, props) {
    try { if (window.FB && typeof FB.track === "function") FB.track(name, props); } catch (e) {}
  }

  function cover(s) {
    var plate = el("div", "plate");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.src = "/img/thumbs/" + str(s.img) + ".webp";
    img.onerror = function () {
      this.onerror = null;                                  /* one retry, never a loop */
      this.src = "/img/stacks/" + str(s.img) + ".webp";
    };
    plate.appendChild(img);
    if (s.locked) {
      /* The glyph is decoration: the meta line already says "· locked", so
         without this the link's accessible name ends in "lock". */
      var lk = el("span", "lock", "\ud83d\udd12");
      lk.setAttribute("aria-hidden", "true");
      plate.appendChild(lk);
    }
    return plate;
  }

  /* How many of this topic are still unread, and what the topic is called
     mid-sentence. The `lower` form already exists on the taxonomy for exactly
     this ("More on Cleopatra" / "more on the New Testament") — it is not a new
     table. Returns null when there is nothing honest to say. */
  function remaining(current, stacks) {
    try {
      var topic = str(current && current.topic);
      if (!topic || !stacks || !stacks.length) return null;
      var left = 0, i, s2;
      for (i = 0; i < stacks.length; i++) {
        s2 = stacks[i];
        if (str(s2.topic) !== topic) continue;
        if (idOf(s2) === idOf(current)) continue;
        if (progress(s2).status === "done") continue;
        left++;
      }
      if (!left) return null;

      /* The bar counts the whole topic, including this story: a reader who has
         just finished one of eight should see one segment filled, not none. */
      var total = 0, done = 0;
      for (i = 0; i < stacks.length; i++) {
        if (str(stacks[i].topic) !== topic) continue;
        total++;
        if (idOf(stacks[i]) === idOf(current) || progress(stacks[i]).status === "done") done++;
      }

      var table = taxon("TOPICS"), name = null, disp = null;
      for (i = 0; i < table.length; i++) if (table[i].key === topic) {
        name = table[i].lower || table[i].name;
        disp = table[i].name || table[i].lower;
      }
      if (!name) return null;
      return { n: left, name: name, disp: disp, done: done, total: total };
    } catch (e) { return null; }
  }

  /* Numbers under about a dozen read better as words in a sentence. Past that
     the digit is clearer, and no topic in season one is anywhere near it. */
  var WORDS = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
               "Eight", "Nine", "Ten", "Eleven", "Twelve"];
  function count(n) { return (n > 0 && n < WORDS.length) ? WORDS[n] : String(n); }

  /* One segment per story in the topic, filled for the ones behind you. A
     percentage bar would be a smaller lie about the same thing; these are
     countable, so they get counted. Capped, because a topic of thirty would
     draw thirty hairlines nobody can tell apart. */
  function bar(done, total) {
    var wrap = el("div", "rec-bar"), i, seg;
    if (!total || total > 14) return null;
    for (i = 0; i < total; i++) {
      seg = el("i", i < done ? "on" : null);
      wrap.appendChild(seg);
    }
    wrap.setAttribute("aria-hidden", "true");   /* the line above it says the same */
    return wrap;
  }

  /* One story, given the whole width: the plate, the title on it, and how long
     it takes. 4:3, not wider — every plate in the library is a 3:4 portrait
     painting, and a 16:10 crop throws the subject out of frame on most of
     them. The whole tile is the link; there is no second control on it. */
  function plate(s2) {
    var a = el("a", "rec-plate" + (s2.locked ? " is-locked" : ""));
    a.href = s2.href;

    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = "/img/thumbs/" + str(s2.img) + ".webp";
    img.onerror = function () {
      this.onerror = null;                                  /* one retry, never a loop */
      this.src = "/img/stacks/" + str(s2.img) + ".webp";
    };
    a.appendChild(img);
    a.appendChild(el("span", "rec-scrim"));

    var t = el("div", "rec-plate-t");
    t.appendChild(el("b", null, str(s2.title)));
    t.appendChild(el("span", "rec-meta", minutes(s2.secs) + (s2.locked ? " · locked" : "")));
    a.appendChild(t);

    a.addEventListener("click", function () {
      track("rec_click", { stack: str(s2.id), why: str(s2.whyKey), slot: "1" });
    });
    return a;
  }

  /* The story they just finished, with a tick on it. It costs one cover and it
     is the only thing on this pane that looks backwards — everything below it
     is the next tap. A reader who has just spent three minutes should see that
     it counted before being asked to spend three more. */
  function doneBadge(s) {
    try {
      if (!s || !s.img) return null;
      var w = el("div", "rec-done");
      var plate = el("div", "plate");
      var img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.src = "/img/thumbs/" + str(s.img) + ".webp";
      img.onerror = function () {
        this.onerror = null;                                /* one retry, never a loop */
        this.src = "/img/stacks/" + str(s.img) + ".webp";
      };
      plate.appendChild(img);
      var tick = el("span", "rec-check");
      tick.setAttribute("aria-hidden", "true");
      tick.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
        'stroke="currentColor" stroke-width="3.4" stroke-linecap="round" ' +
        'stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 6.5"/></svg>';
      w.appendChild(plate);
      /* Sibling of the plate, not a child of it: .plate clips to its own
         rounded corners (overflow:hidden, app.css) and the tick overhangs the
         top-right corner by 7px, so inside it the badge loses a bite. */
      w.appendChild(tick);
      return w;
    } catch (e) { return null; }
  }

  /* endPanel(current, stacks, opts) -> a .pane element for the end of a story.
     opts: { n:3, heading:"...", explore:true, library:true }
     Always returns an element. Never throws. */
  function endPanel(current, stacks, opts) {
    var sec;
    try {
      opts = opts || {};
      sec = el("section", "pane rec");
      var open = unlocked();
      var want = Math.max(2, Math.min(4, Math.floor(+opts.n) || 3));
      var ranked = next(current, stacks, 999), i;

      /* A locked reader gets everything they can open, plus at most one
         locked cover as a marked teaser. Six padlocks in a row is a nag. */
      var pool = ranked, teaser = null;
      if (!open) {
        var canOpen = [], shut = [];
        for (i = 0; i < ranked.length; i++) (ranked[i].locked ? shut : canOpen).push(ranked[i]);
        pool = canOpen;
        teaser = shut.length ? shut[0] : null;
      }
      var picks = pool.slice(0, want);

      /* Three rows reading "More on Cleopatra, More on Cleopatra, More on
         Cleopatra" is one door, printed three times. When every pick shares a
         reason, the last slot goes to the best candidate with a different one
         — still ranked, still deterministic, but it offers a second way out. */
      if (picks.length === want && want >= 3) {
        var same = true;
        for (i = 1; i < picks.length; i++) if (picks[i].whyKey !== picks[0].whyKey) same = false;
        if (same) {
          for (i = want; i < pool.length; i++) {
            if (pool[i].whyKey !== picks[0].whyKey) { picks[want - 1] = pool[i]; break; }
          }
        }
      }
      if (picks.length < want && teaser) picks.push(teaser);

      var pick = picks.length ? picks[0] : null;

      var done = doneBadge(current);
      if (done) {
        sec.appendChild(done);
        /* Headway's line from the finished cover down into the next choice.
           Decoration, so it is not in the accessible tree. */
        var thread = el("div", "rec-thread");
        thread.setAttribute("aria-hidden", "true");
        sec.appendChild(thread);
      }

      /* Where they are in the topic, then the reason to keep going.

         "There's more to Cleopatra" rather than "Cleopatra's story": the
         sentence is generated for eight topics and the possessive only reads
         for one of them — "saints and sinners's story" and
         "disasters's story" are not sentences. Same line, one word moved. */
      var rest = remaining(current, stacks);

      if (rest) {
        sec.appendChild(el("p", "rec-count",
          rest.disp + " \u00b7 " + rest.done + " of " + rest.total));
        var b = bar(rest.done, rest.total);
        if (b) sec.appendChild(b);
      }

      var head = str(opts.heading) ||
                 (rest ? "Want to know what happened next?" : "That is the whole story");
      sec.appendChild(el("h2", null, head));

      var lede = rest
        ? "Keep going. There\u2019s more to " + rest.name + ", and it gets stranger."
        : (picks.length ? "Read another one." : "That is every story for now.");
      sec.appendChild(el("p", "rec-lede", lede));

      if (pick) sec.appendChild(plate(pick));

      /* One button. A reader who still has something they can open is sent to
         it; the offer waits until they actually run out. */
      if (pick && !pick.locked) {
        var go = el("a", "go", "Continue");
        go.href = pick.href;
        go.addEventListener("click", function () {
          track("rec_click", { stack: str(pick.id), why: str(pick.whyKey), slot: "cta" });
        });
        sec.appendChild(go);
      } else {
        var buy = el("button", "go", "Read the rest of season one");
        buy.type = "button";
        buy.addEventListener("click", function () {
          try {
            if (window.FB && typeof FB.checkout === "function") { FB.checkout(buy, "endcard"); return; }
          } catch (e) {}
          location.href = "/stories";
        });
        sec.appendChild(buy);
        sec.appendChild(el("p", "fine", "Cancel any time."));
      }

      track("rec_view", { stack: idOf(current), n: String(picks.length) });
      return sec;
    } catch (e) {
      /* Last resort: a pane with a way out is still a working end of story. */
      try {
        var f = el("section", "pane rec");
        f.appendChild(el("h2", null, "That is the whole story"));
        var l = el("div", "rec-links");
        l.appendChild(link("/stories", "All stories"));
        f.appendChild(l);
        return f;
      } catch (e2) { return sec || null; }
    }
  }

  function link(h, text) {
    var a = el("a", "ghost", text);
    a.href = h;
    return a;
  }

  return {
    version: 1,
    next: next,
    endPanel: endPanel,
    href: href,
    reasonFor: function (cur, s) {
      try { return reason(cur, s, progress(s), !unlocked()).text; } catch (e) { return "Next up"; }
    }
  };
})();
