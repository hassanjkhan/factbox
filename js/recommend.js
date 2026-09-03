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

  /* ======================================================================
     The end card.

     What this used to be: three covers, a Save beside each, a buy button and
     three links to a shelf the "← Stories" pill already reaches. Nine taps at
     the one moment on the site where the reader has just said yes to a whole
     story — a menu, at the exact second a menu is the wrong thing.

     What it is now: where they are, one cover with a tick on it, and Continue.
     One story, one button.
     ====================================================================== */

  /* "Cleopatra", the heading form of a TOPIC, for the progress line. */
  function topicName(key) { return form("TOPICS", key, "name"); }

  /* Where this story sits in its subject: catalogue order, 1-based, and how
     many the subject holds. {n:0, of:0} when the subject cannot be worked out
     — the caller then prints no progress line at all rather than "0 OF 0". */
  function place(list, cur) {
    var out = { n: 0, of: 0 };
    try {
      if (!cur) return out;
      var t = str(cur.topic), id = str(cur.id), i;
      if (!t) return out;
      for (i = 0; i < list.length; i++) {
        if (!list[i] || str(list[i].topic) !== t) continue;
        out.of++;
        if (str(list[i].id) === id) out.n = out.of;
      }
      /* Ranked against an index this story is not in — it still has a subject
         and the subject still has a length, so say the honest half. */
      if (!out.n) out.n = 1;
      if (out.of < out.n) out.of = out.n;
    } catch (e) { return { n: 0, of: 0 }; }
    return out;
  }

  /* CLEOPATRA · 1 OF 8, and a segment per story under it. The segments are
     decoration — the sentence above them already says the same thing — so the
     strip is aria-hidden and the label carries the meaning. */
  function progressRow(label, n, of) {
    var wrap = el("div", "ec-prog");
    wrap.appendChild(el("span", "ec-where", label));
    var segs = el("div", "ec-segs");
    segs.setAttribute("aria-hidden", "true");
    for (var i = 1; i <= of; i++) {
      segs.appendChild(el("i", i < n ? "is-done" : (i === n ? "is-now" : null)));
    }
    wrap.appendChild(segs);
    return wrap;
  }

  /* The cover they just finished. 4:3, a tick, the title and the runtime on
     the plate. No save control: this pane is the way out of the story, and a
     second thing to tap here is the thing the reader taps instead of Continue.
     The 4:3 box is a padding-top ratio rather than aspect-ratio, which is
     iOS 15+; a lot of this traffic is not. */
  function finishedPlate(s) {
    var fig = el("figure", "ec-plate");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = "/img/thumbs/" + str(s.img) + ".webp";
    img.onerror = function () {
      this.onerror = null;                                /* one retry, never a loop */
      this.src = "/img/stacks/" + str(s.img) + ".webp";
    };
    fig.appendChild(img);

    var tick = el("span", "ec-tick");
    tick.setAttribute("aria-hidden", "true");
    tick.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
           'stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 12.5l4.6 4.6L19 7.2"/>' +
      '</svg>';
    fig.appendChild(tick);

    var cap = el("figcaption", "ec-cap");
    cap.appendChild(el("b", null, str(s.title)));
    cap.appendChild(el("span", "ec-min", minutes(s.secs)));
    fig.appendChild(cap);
    return fig;
  }

  /* endPanel(current, stacks, opts) -> a .pane element for the end of a story.
     opts: { heading, sub, cta }
     Always returns an element. Never throws. */
  function endPanel(current, stacks, opts) {
    var sec;
    try {
      opts = opts || {};
      sec = el("section", "pane rec endcard");

      var list = listOf(stacks);
      var curId = idOf(current);
      var cur = (current && typeof current === "object" && current.id != null)
        ? current : find(list, curId);

      /* The one story we are sending them to: the best-ranked one this reader
         can actually open. next() already sinks the locked ones by 1200, so
         the first unlocked row IS the top pick, not a consolation. */
      var ranked = next(current, stacks, 999), target = null, i;
      for (i = 0; i < ranked.length; i++) {
        if (!ranked[i].locked) { target = ranked[i]; break; }
      }

      /* --- where they are ------------------------------------------------ */
      var pl = place(list, cur);
      if (pl.of) {
        var subject = topicName(cur && cur.topic) ||
                      str(cur && cur.topic).replace(/_/g, " ");
        if (subject) {
          sec.appendChild(progressRow(
            subject.toUpperCase() + " · " + pl.n + " OF " + pl.of, pl.n, pl.of));
        }
      }

      /* --- the question and the answer ------------------------------------
         "There's more to X", never "X's story". The subject phrase is
         generated for all eight groups and several of them end in a plural
         that will not take a possessive: "saints and sinners's story" and
         "disasters's story" are not sentences. A preposition reads for every
         one of the eight and says the same thing. Checked against all eight
         lower forms in the table at the top of this file. */
      sec.appendChild(el("h2", null,
        str(opts.heading) || "Want to know what happened next?"));

      var phrase = topicPhrase(cur && cur.topic);
      /* One subject holds exactly one story (disaster). Telling that reader
         there is more of it is a lie they can check in one tap, so we name
         the subject they are actually being sent to instead. */
      if (pl.of < 2 && target && str(target.topic)) {
        phrase = topicPhrase(str(target.topic)) || phrase;
      }
      if (!phrase) phrase = "the rest of the stories";
      sec.appendChild(el("p", "ec-sub", str(opts.sub) ||
        "Keep going. There’s more to " + phrase + ", and it gets stranger."));

      /* --- the cover they finished ---------------------------------------- */
      if (cur && cur.img) sec.appendChild(finishedPlate(cur));

      /* --- one button ------------------------------------------------------
         A link when there is somewhere to go, a button when the only thing
         left is the offer. Either way it is one control, and it is never
         dead. */
      var label = str(opts.cta) || "Continue";
      var go;
      if (target) {
        go = el("a", "go ec-go", label);
        go.href = target.href;
        go.setAttribute("role", "button");
        /* Already counted, as rec_click. See js/analytics.js. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
          track("rec_click", { stack: str(target.id), why: str(target.whyKey), slot: "1" });
        });
      } else {
        go = el("button", "go ec-go", label);
        go.type = "button";
        /* Already counted: FB.checkout sends subscribe_click. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
          try {
            if (window.FB && typeof FB.checkout === "function") { FB.checkout(go, "endcard"); return; }
          } catch (e) {}
          location.href = "/explore";
        });
      }
      sec.appendChild(go);

      track("rec_view", { stack: curId, n: target ? "1" : "0" });
      return sec;
    } catch (e) {
      /* Last resort: a pane with a way out is still a working end of story. */
      try {
        var f = el("section", "pane rec endcard");
        f.appendChild(el("h2", null, "Want to know what happened next?"));
        var a = el("a", "go ec-go", "Continue");
        a.href = "/explore";
        f.appendChild(a);
        return f;
      } catch (e2) { return sec || null; }
    }
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
