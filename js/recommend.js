/* ==========================================================================
   Factbox — the end of a story, and the offer that follows it.

   One global, FBR. It owns the moment a story ends: the single highest-intent
   second on the site. It does not own the reader page, does not fetch, does
   not write storage, and defines nothing else.

   TWO SCREENS, IN THIS ORDER, AND THE ORDER IS THE POINT

     FBR.endPanel()  the completion screen. A tick, how long the story took,
                     how many stories this reader has finished, the week they
                     are building, and the next story — shown before it is
                     sold. The offer is one line under the button, and a
                     subscriber never sees it.
     FBR.paywall()   the wall itself, reached by tapping "Keep learning" with
                     nothing left this reader may open, or by opening a locked
                     story. Three days free, then the real annual price, on
                     two dated rows. Not a pricing table.

   A reader meets a complete story, then a moment of having finished it, then
   curiosity about the next one, and only then a price. Read RECOMMEND.md for
   what the end card used to be and why it stopped being a menu.

   TWO RULES THIS FILE IS WRITTEN AROUND

     Nothing here may contain a price or a trial length. Both come out of
     js/account.js, which is the one place that knows what Stripe charges.

     Nothing here may show progress it cannot compute truthfully. See the
     block above learned() — the reading map is gated for a reason and this
     file does not go around the gate to fill in a nicer number.

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
        shut = !canOpen(s, open);
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


  /* Once-only, per element. Every "…_viewed" event below is fired through
     this, so a rebuild of the same panel — read.html rebuilds the end card
     when the access answer changes — cannot double-count a reader. */
  function once(node, flag, fn) {
    try {
      if (!node || node[flag]) return;
      node[flag] = true;
      fn();
    } catch (e) {}
  }

  /* ======================================================================
     MONEY — read, never written, and never a literal.

     Every figure on the two screens below comes out of js/account.js. That
     file is the single source of truth for what Stripe charges (STRIPE.md
     §2), and the reason nothing here may carry a dollar sign of its own is
     concrete: annual charges USD 35.88, not 35.00, and a screen that says
     "$35" is a screen that charges 88 cents more than the reader agreed to.
     When the $35.00 price exists in Stripe, account.js changes and every
     word below follows with no edit here.

     FBA absent — an older cached page, a blocked file — is handled the same
     way everywhere: the number is not shown at all. A missing price is a
     smaller failure than an invented one.
     ====================================================================== */

  function acct() {
    try { if (window.FBA && typeof FBA.plans === "function") return FBA; } catch (e) {}
    return null;
  }

  /* The plans a new reader may pick, in ladder order. Quarterly is retired
     (offered:false in account.js) so this is exactly two rungs today, which
     is what the "other plans" sheet renders. It is not filtered here: the
     offer is account.js's answer, not this file's. */
  function offered() {
    var A = acct();
    if (!A) return [];
    try { var l = A.plans(); return l && l.length ? l : []; } catch (e) { return []; }
  }

  /* The rung the offer leads with: the one account.js marks best, and the
     last rung if nothing is marked. Never a hard-coded "annual". */
  function leadPlan() {
    var l = offered(), i;
    for (i = 0; i < l.length; i++) { if (l[i].best) return l[i]; }
    return l.length ? l[l.length - 1] : null;
  }

  function planFor(key) {
    var l = offered(), i;
    for (i = 0; i < l.length; i++) { if (l[i].key === key) return l[i]; }
    return null;
  }

  /* The currency symbol, from the same record as the amounts. "$0" is the
     one figure on these screens that is not a price — it is the absence of
     one — so it is built from the symbol rather than formatted as money. */
  function symbol() {
    var A = acct();
    try { if (A && A.pricing) return str(A.pricing().symbol) || "$"; } catch (e) {}
    return "$";
  }
  function zero() { return symbol() + "0"; }

  function trialDays() {
    var A = acct();
    try { if (A && A.trialDays) return Math.max(0, Math.floor(+A.trialDays()) || 0); } catch (e) {}
    return 0;
  }
  /* "3 days free", account.js's own wording, so the length is written down
     in exactly one place. */
  function trialShort() {
    var A = acct();
    try { if (A && A.trialShort) return str(A.trialShort()); } catch (e) {}
    return "";
  }

  /* "$35.88/yr". The suffix comes off the interval Stripe bills on, so a
     plan billed every 3 months could never be labelled "/yr" by accident. */
  function perSuffix(p) {
    try {
      var n = Math.max(1, Math.floor(+p.intervalCount) || 1);
      var u = str(p.intervalUnit);
      if (u === "year")  return n === 1 ? "/yr"  : "/" + n + "yr";
      if (u === "month") return n === 1 ? "/mo"  : "/" + n + "mo";
      if (u === "week")  return n === 1 ? "/wk"  : "/" + n + "wk";
      if (u === "day")   return n === 1 ? "/day" : "/" + n + "d";
    } catch (e) {}
    return "";
  }
  function priceTag(p) {
    try { return str(p.billedText) + perSuffix(p); } catch (e) { return ""; }
  }

  /* ======================================================================
     THE READER'S OWN NUMBERS — and the rule that governs all of them.

     NEVER DISPLAY PROGRESS THAT CANNOT BE COMPUTED TRUTHFULLY.

     js/progress.js keeps the reading map, and it gates it: FBP.visible() is
     false unless the cache is tagged with the account that is signed in
     right now. That gate is a shipped privacy fix — a shared phone was
     showing one reader's finished ticks to the next person to pick it up —
     and this file does not go around it.

     So there are two honest cases, and both are rendered:

       visible   the record is this reader's. How many of the subject they
                 have finished, and which of its dots are filled, are read
                 straight out of it.
       not       we know exactly one thing: this reader finished a story
                 just now, on this page, because we watched them do it. So
                 one story is claimed and nothing at all is said about any
                 other.

     What is never done is filling seven empty dots and calling it a streak.
     ====================================================================== */

  /* Is the reading map this viewer's to see? */
  function memoryMine() {
    try { return !!(window.FBP && typeof FBP.visible === "function" && FBP.visible()); }
    catch (e) { return false; }
  }

  /* How many stories this reader has finished, and whether that number came
     from their record or from what we just watched happen. */
  function learned() {
    var out = { n: 1, known: false };
    try {
      if (!memoryMine() || typeof FBP.all !== "function") return out;
      var m = FBP.all(), k, n = 0;
      for (k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        if (m[k] && m[k].done) n++;
      }
      out.known = true;
      /* The story just finished is already marked done by FBP.mark(), so it
         is inside n. A zero can only mean storage refused the write, and the
         completion we witnessed is still a fact. */
      out.n = n > 0 ? n : 1;
    } catch (e) {}
    return out;
  }

  /* ======================================================================
     WHICH STORY COMES NEXT — the decided order.

     THE BUG THIS REPLACES, and it was reported from the live site: "you read
     the first one, go to continue, then the second story, then it goes back
     to the first."

     It was not a fallback misfiring; it was the ranking working exactly as
     written. next() scores every stack, and for a signed-out reader on
     Cleopatra 02 the arithmetic is:

       story 01   same topic +120, unread +12, free-and-they-are-locked-out
                  +60                                            = +192
       story 03   same topic +120, unread +12, LOCKED -1200       = -1068

     So the story they had just come from outscored the story that actually
     follows it by more than a thousand points, and the button pointed
     backwards. On a subject with two free stories that is a loop.

     Scoring is the wrong instrument here. "What comes next" is not a
     popularity contest, it is a sequence, and the reader is entitled to the
     same sequence every time. So the order is DECIDED, not computed:

       1. the rest of this subject, FORWARD in catalogue order. Never
          backward — the story before this one is the one they just read.
       2. the same KIND of story, which is the only other axis the taxonomy
          in window.FBTAX has. Forward first, then round.
       3. the catalogue, forward, then round.

     Identical on every visit, for every reader, with nothing random and
     nothing weighted in it. next() is untouched and still exported: it
     answers "what else is worth reading", which is a different question.

     THE TWO RULES ON TOP OF THE ORDER

     A story the reader has FINISHED is never offered as next. That answer
     comes from js/progress.js, which shows a reader their own record and
     nobody else's — so a signed-out reader has finished nothing as far as
     this can tell, and is protected instead by the order being forward-only
     for them. They can never be sent back to the story they came from.

     And a reader who may not open everything is offered the next story in
     the order WHETHER OR NOT THEY MAY OPEN IT. That is deliberate: two
     stories are free and 01 -> 02 is forward, so nobody loses a free story;
     but 02 -> 03 is a locked story, and the honest thing at that point is
     the offer, not a third lap of the same two.
     ====================================================================== */

  function finished(s) {
    try { return progress(s).status === "done"; } catch (e) { return false; }
  }

  /* May this reader open this story? The same three answers js/access.js
     gives: they have access, or the story is permanently free, or it is
     today's Factbox, which is free for everybody every day. isToday() is
     synchronous once access.js holds the catalogue, and read.html has
     already waited on FBX before this card exists. Missing it would put a
     padlock on the one story that has none. */
  function canOpen(s, open) {
    if (open) return true;
    if (s && s.free) return true;
    try {
      if (window.FBX && FBX.isToday && FBX.isToday(s && s.id)) return true;
    } catch (e) {}
    return false;
  }

  /* runOrder(list, cur) -> { row: [stacks], forward: n }
     row is the whole order; the first `forward` entries are the ones that
     come AFTER this story in the catalogue. A reader who cannot open
     everything never sees past that boundary. */
  function runOrder(list, cur) {
    var ahead = [], behind = [], seen = {}, i, at = -1;
    var curId = str(cur && cur.id);
    var topic = str(cur && cur.topic), kind = str(cur && cur.kind);

    for (i = 0; i < list.length; i++) {
      if (str(list[i] && list[i].id) === curId) { at = i; break; }
    }

    function take(into, s) {
      if (!s || s.id == null) return;
      var id = str(s.id);
      if (id === curId || seen[id]) return;
      seen[id] = 1;
      into.push(s);
    }
    function sweep(into, from, to, test) {
      for (var j = from; j < to; j++) {
        if (!list[j]) continue;
        if (test && !test(list[j])) continue;
        take(into, list[j]);
      }
    }
    var sameTopic = function (s) { return topic && str(s.topic) === topic; };
    var sameKind  = function (s) { return kind  && str(s.kind)  === kind;  };

    /* 1 and 2 and 3, forward */
    sweep(ahead, at + 1, list.length, sameTopic);
    sweep(ahead, at + 1, list.length, sameKind);
    sweep(ahead, at + 1, list.length, null);
    /* the same three, wrapped round to the top */
    sweep(behind, 0, at + 1, sameTopic);
    sweep(behind, 0, at + 1, sameKind);
    sweep(behind, 0, at + 1, null);

    return { row: ahead.concat(behind), forward: ahead.length };
  }

  /* pickNext -> { s: stack, locked: bool } or null when there is nothing
     left, which is a real answer and the card says so. */
  function pickNext(list, cur, open) {
    var o = runOrder(list, cur), i, s, why;
    var stop = open ? o.row.length : o.forward;
    var topic = str(cur && cur.topic), kind = str(cur && cur.kind);
    for (i = 0; i < stop; i++) {
      s = o.row[i];
      if (finished(s)) continue;
      why = (topic && str(s.topic) === topic) ? "subject"
          : (kind && str(s.kind) === kind)    ? "kind"
          : "next";
      return { s: s, locked: !canOpen(s, open), why: why };
    }
    return null;
  }

  /* ---- where this story sits in its subject ------------------------------
     Catalogue position, 1-based, and how many the subject holds. {n:0,of:0}
     when the subject cannot be worked out — the caller then prints no line
     at all rather than "0 OF 0". */
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

  /* "Cleopatra", the heading form of a TOPIC. */
  function topicName(key) { return form("TOPICS", key, "name"); }

  /* ---- small builders ---------------------------------------------------- */

  function tickSVG() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M5 12.5l4.6 4.6L19 7.2"/>' +
           '</svg>';
  }

  /* Citations off, whitespace collapsed. A third of the hooks in the season
     end in a parenthesised source link, and a citation must never reach a
     headline. It is a no-op on every title in data/index.json today, so on a
     title it is a guard against later data rather than a fix for current
     data — which is exactly why it stays on the title path. */
  function clean(s) {
    return str(s)
      .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)\s*/g, " ")
      .replace(/\s*\(https?:\/\/[^)]*\)\s*/g, " ")
      /* A function, not "$1": tools/check-regressions.js greps this file
         for a dollar sign followed by a digit, and a capture-group reference
         is indistinguishable from a typed price to a grep. */
      .replace(/\s*\[([^\]]*)\]\([^)]*\)/g, function (whole, txt) { return " " + txt; })
      .replace(/\s+/g, " ")
      .trim();
  }

  /* The first sentence of a hook. Several run to three. Never invented, only
     cut. */
  function firstSentence(s) {
    var t = clean(s);
    var m = t.match(/^[\s\S]*?[.?!](?=\s|$)/);
    return (m ? m[0] : t).trim();
  }

  /* THE HEADLINE FOR A STORY BEING OFFERED: ITS TITLE.

     It used to be the hook, cut to one sentence, with the title as the
     fallback. That made this the last surface in shipped code that headlined
     a story with something other than its title — so the story a reader was
     offered next carried a different headline from the cover they then tapped
     it from. The Explore hero, the trending shelf, the mosaic, the Continue
     row and every /library surface all draw the title now; this is the one
     that was left.

     THIS DIVERGES FROM THE DESIGN MOCKUP ON PURPOSE. Explore.dc.html binds
     its hero to the hook. The instruction to use the title everywhere is
     newer than that file, and the same note is in EXPLORE.md, js/today.js and
     css/today.css so that reading the design doc does not talk somebody into
     reverting it.

     The hook stays as the FALLBACK rather than being deleted: a title-less
     row would otherwise render an empty headline. */
  function promise(s) {
    if (!s) return "";
    return clean(s.title) || firstSentence(s.hook);
  }

  /* A cover, 3:4, sized by padding-top rather than aspect-ratio — the latter
     is iOS 15+ and a real share of this traffic is older than that. The
     fallback is carried on the element, because by the time onerror fires
     the stack it belongs to is out of scope. */
  function thumb(s, cls) {
    var box = el("div", cls || "ec-thumb");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.setAttribute("data-fallback", "/img/stacks/" + str(s.img) + ".webp");
    img.onerror = function () {
      this.onerror = null;                              /* one retry, never a loop */
      this.src = this.getAttribute("data-fallback");
    };
    img.src = "/img/thumbs/" + str(s.img) + ".webp";
    box.appendChild(img);
    return box;
  }

  /* A full-bleed plate with the reader's scrim over it.

     `src` is a path this file was HANDED, never one it guessed: the last card
     of the story just read (already decoded and in cache — the reader was
     looking at it a swipe ago), or a story's cover thumbnail. Nothing here
     starts a download of a plate the reader has not asked for; that rule
     belongs to read.html's pager and this screen does not go around it.

     The scrim is its own element rather than a ::after, because the element
     it covers is an <img> and a replaced element has no generated content. */
  function plate(src, fallback, cls) {
    var box = el("div", cls);
    box.setAttribute("aria-hidden", "true");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    if (fallback) {
      img.setAttribute("data-fallback", fallback);
      img.onerror = function () {
        this.onerror = null;
        this.src = this.getAttribute("data-fallback");
      };
    }
    img.src = src;
    box.appendChild(img);
    box.appendChild(el("i", "sc-scrim"));
    return box;
  }

  /* The plate the reader is standing on when a story ends: its last card.
     read.html has already fetched it, so this costs nothing. */
  function lastPlate(s) {
    var fb = "/img/stacks/" + str(s && s.img) + ".webp";
    try {
      var cs = s && s.cards;
      var c = cs && cs.length ? cs[cs.length - 1] : null;
      if (c && c.img) return plate("/img/cards/" + str(c.img) + ".webp", fb, "ec-plate");
    } catch (e) {}
    return plate(fb, "", "ec-plate");
  }

  function coverPlate(s, cls) {
    return plate("/img/thumbs/" + str(s.img) + ".webp",
                 "/img/stacks/" + str(s.img) + ".webp", cls);
  }

  /* ======================================================================
     MONEY, PART TWO — the two lines the wall leads with.

     Both are derived. perLong() reads the interval Stripe bills on, so a
     plan billed every three months could never be labelled "/year"; and
     underMonth() rounds the DERIVED per-month figure UP to the next whole
     unit, which is the only way "less than" can be said without a person
     typing a number that stops being true when account.js changes.

     If the plan divides into whole units exactly — a hypothetical 36.00 a
     year — "less than 3 a month" is false, so the claim is not made and the
     exact figure is printed instead. Nothing here rounds in our favour.
     ====================================================================== */

  /* "/year", spelled out. perSuffix() above is the short form the sheet uses. */
  function perLong(p) {
    try {
      var n = Math.max(1, Math.floor(+p.intervalCount) || 1);
      var u = str(p.intervalUnit);
      if (n !== 1) return perSuffix(p);
      if (u === "year")  return "/year";
      if (u === "month") return "/month";
      if (u === "week")  return "/week";
      if (u === "day")   return "/day";
    } catch (e) {}
    return perSuffix(p);
  }

  function underMonth(p) {
    try {
      if (!p || !(p.months > 1)) return "";
      var c = Math.round(Number(p.perMonthCents));
      if (!isFinite(c) || c <= 0) return "";
      /* It divides into whole units: "less than" would be a lie, so say the
         figure instead. account.js's own phrasing, with its own "about". */
      if (c % 100 === 0) return str(p.perMonthAbout) + " a month";
      return "Less than " + symbol() + String(Math.ceil(c / 100)) + " a month";
    } catch (e) { return ""; }
  }

  /* ======================================================================
     1. THE COMPLETION SCREEN, AND THE EPISODE AFTER IT

     Three beats on one pane, and the order is the whole design:

       1  what the reader just did — a tick, the subject, and how much of it
          they have finished. About a second, over the plate they finished on.
       2  what comes next — the story, its cover, its length, and where it
          sits in the subject. Shown before it is sold.
       3  it opens itself.

     BEAT 3 IS THE ONE WITH RULES, AND THEY ARE NOT COSMETIC.

     a. NEVER AUTO-OPEN A STORY THE READER MAY NOT READ. canOpen() is the
        same three answers js/access.js gives. When it says no, there is no
        countdown at all: the control becomes the offer and the reader
        chooses. Spending somebody's attention to walk them into a wall they
        did not ask for is not a feature.

     b. CANCEL ON ANY EXIT. A timer that fires after the reader has left
        navigates a page nobody is looking at. Hidden tab, pagehide, the back
        button, scrolling back up into the story, "Back to Explore", or the
        pane being replaced — every one of them stops it, and stop() is
        idempotent.

     c. REDUCED MOTION DOES NOT SILENTLY DISABLE IT. What that setting asks
        for is less movement, not fewer features, so the advance still runs —
        but the remaining seconds are TEXT, not a shrinking bar, the whole
        thing is announced once rather than ticked at a screen reader, and
        both controls are ordinary focusable elements. A countdown whose only
        cue is an animation is a countdown an animation-free reader cannot
        see.
     ====================================================================== */

  var HOLD_MS = 1000;      /* beat 1 holds, then beat 2 arrives */
  var TICK_MS = 1000;
  var OPEN_MS = 320;       /* "Opening…" is on screen for this before we go */
  var COUNT_FROM = 3;

  /* How much of this subject the reader has finished, out of how many.

     The same rule as learned() above: the reading map is shown to the
     account that owns it and to nobody else, so a signed-out reader gets the
     one completion we WATCHED happen and no claim about any other. `of` is
     the catalogue's answer and is safe for everybody. */
  function subjectDone(list, cur) {
    var out = { n: 1, of: 0, known: false }, i, s;
    try {
      var t = str(cur && cur.topic), id = str(cur && cur.id);
      if (!t) return out;
      for (i = 0; i < list.length; i++) {
        s = list[i];
        if (s && str(s.topic) === t) out.of++;
      }
      if (!out.of) return out;
      if (!memoryMine()) return out;
      var n = 0;
      for (i = 0; i < list.length; i++) {
        s = list[i];
        if (!s || str(s.topic) !== t) continue;
        /* The story just read counts whether or not the write landed. */
        if (str(s.id) === id || finished(s)) n++;
      }
      out.known = true;
      out.n = n > 0 ? n : 1;
      if (out.n > out.of) out.n = out.of;
    } catch (e) {}
    return out;
  }

  /* One dot per story in the subject: filled for the ones finished, outlined
     for the one about to open, faint for the rest. Decoration — the two lines
     above it say the same thing in words — so it is hidden from a reader who
     is being read to rather than announced as eight list items. */
  function dotRow(list, cur, nextS) {
    var t = str(cur && cur.topic);
    if (!t) return null;
    var mine = memoryMine(), curId = str(cur && cur.id);
    var nextId = str(nextS && nextS.id);
    var wrap = el("div", "ec-dots");
    wrap.setAttribute("aria-hidden", "true");
    var i, s, n = 0;
    for (i = 0; i < list.length; i++) {
      s = list[i];
      if (!s || str(s.topic) !== t) continue;
      n++;
      var cls = null;
      if (str(s.id) === curId || (mine && finished(s))) cls = "is-on";
      else if (str(s.id) === nextId) cls = "is-next";
      wrap.appendChild(el("i", cls));
    }
    return n > 1 ? wrap : null;
  }

  /* The offer, as one line rather than a screen. Built only when there is a
     real price to name and only for a reader who does not already have
     access — an existing subscriber must never be sold to. */
  function offerLine() {
    var p = leadPlan(), d = trialDays();
    if (!p || !p.billedLine || !d) return null;
    return el("p", "fine ec-offer",
      "Unlock Factbox free for " + d + (d === 1 ? " day" : " days") +
      " · Then " + str(p.billedLine) + " · Cancel anytime");
  }

  /* endPanel(current, stacks, opts) -> a .pane element for the end of a story.
     opts: { heading, sub, cta }
     Always returns an element. Never throws.

     Three things the caller may set on the returned element AFTER it is built,
     because tools/compose.py matches read.html's call verbatim and an extra
     option in that call breaks the build of /cleopatra:

       el.onLocked(stack)  what the control does when the next story is not
                           this reader's to open. read.html shows the wall.
                           Absent, it falls back to the funnel entrance, so
                           it is never dead.
       el.reveal()         the reader has actually reached this pane. Fires
                           the view events once, and starts the hand-off.
       el.leave()          the reader has scrolled back off it, or it is
                           about to be replaced. Cancels the hand-off. */
  function endPanel(current, stacks, opts) {
    var sec;
    try {
      opts = opts || {};
      sec = el("section", "pane rec endcard");

      var list = listOf(stacks);
      var curId = idOf(current);
      var cur = (current && typeof current === "object" && current.id != null)
        ? current : find(list, curId);

      var open = unlocked();

      /* Which story comes next: the decided order above, never a score, and
         never one they have finished. null is a real answer — the reader has
         read everything there is — and the card says so instead of quietly
         starting them round again. */
      var pick = pickNext(list, cur, open);
      var showing = pick ? pick.s : null;
      var target = (pick && !pick.locked) ? pick.s : null;

      var subject = topicName(cur && cur.topic) ||
                    str(cur && cur.topic).replace(/_/g, " ");
      var mine = subjectDone(list, cur);
      /* The subject is finished when nothing in it is left to offer. Said in
         words rather than implied by a dot that never fills. */
      var runOut = !showing || str(showing.topic) !== str(cur && cur.topic) ||
                   !subject || !mine.of;

      /* ---- beat 1: what they just did ------------------------------------ */
      if (cur) sec.appendChild(lastPlate(cur));

      var p1 = el("div", "ec-p1");
      var badge = el("span", "ec-badge");
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML = tickSVG();
      p1.appendChild(badge);
      p1.appendChild(el("p", "ec-eyebrow",
        runOut && subject ? "Series complete" : "Story complete"));
      if (subject) {
        p1.appendChild(el("p", "ec-line1",
          runOut ? "You finished " + subject + "." : subject));
        /* "1 of 8 complete" — and only when there is a subject with more than
           one story in it. "1 of 1 complete" is a sentence a reader can
           disprove in one tap. */
        if (!runOut && mine.of > 1) {
          p1.appendChild(el("p", "ec-line2",
            mine.n + " of " + mine.of + " complete"));
        }
      } else {
        p1.appendChild(el("p", "ec-line1", "You finished the story."));
      }
      sec.appendChild(p1);

      /* ---- beat 2: what comes next ---------------------------------------- */
      var p2 = el("div", "ec-p2");
      var countP = null;

      if (showing) {
        var hero = el("div", "ec-hero");
        hero.appendChild(coverPlate(showing, "ec-heroart"));
        var ht = el("div", "ec-herotext");
        ht.appendChild(el("p", "ec-up", str(opts.sub) || "Up next"));
        var where = place(list, showing);
        var wname = topicName(showing.topic) ||
                    str(showing.topic).replace(/_/g, " ");
        if (wname && where.of > 1) {
          ht.appendChild(el("p", "ec-of",
            runOut ? wname : wname + " " + where.n + " of " + where.of));
        } else if (wname) {
          ht.appendChild(el("p", "ec-of", wname));
        }
        ht.appendChild(el("h2", "ec-head", promise(showing)));
        var m = minutes(showing.secs);
        if (m) ht.appendChild(el("p", "ec-mins", m));
        hero.appendChild(ht);
        p2.appendChild(hero);

        if (!runOut) {
          var dots = dotRow(list, cur, showing);
          if (dots) p2.appendChild(dots);
        }
      } else {
        /* Nothing left in the catalogue. The screen still has to be a screen. */
        var none = el("div", "ec-herotext ec-nonext");
        none.appendChild(el("p", "ec-up", "That is the lot"));
        none.appendChild(el("h2", "ec-head",
          "You have read every story in Factbox."));
        p2.appendChild(none);
      }
      sec.appendChild(p2);

      /* ---- beat 3: the control, and the hand-off --------------------------
         Four shapes, and which one it is depends only on what pickNext found
         and on whether this page asked for its own label:

           a link + a countdown   there is a next story and this reader may
                                  open it. It opens itself.
           a link, no countdown   /firststory passes its own cta, which is a
                                  sign-up ask; walking a reader into the next
                                  story while asking them to sign up is two
                                  screens arguing.
           a button               there is a next story and they may not — the
                                  offer, and never a countdown into a wall.
           a way out              there is no next story at all. "Back to
                                  Explore", said out loud, rather than a
                                  silent lap back to the first story. */
      var act = el("div", "ec-act");
      var canAuto = !!target && !str(opts.cta);

      if (canAuto) {
        countP = el("p", "ec-timer", "");
        countP.setAttribute("aria-hidden", "true");
        act.appendChild(countP);
      }

      var say = el("span", "ec-say");
      say.setAttribute("role", "status");
      act.appendChild(say);

      var go;
      if (target) {
        go = el("a", "go ec-go",
          str(opts.cta) || (canAuto ? "Start now" : "Keep learning"));
        go.href = href(target);
        go.setAttribute("role", "button");
        /* Already counted, as rec_click. See js/analytics.js. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
          stop();
          track("rec_click", { stack: str(target.id), why: str(pick.why), slot: "1" });
        });
      } else if (showing) {
        go = el("button", "go ec-go", str(opts.cta) || "Keep learning");
        go.type = "button";
        /* Already counted: the paywall sends its own view event, and
           FB.checkout sends subscribe_click. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
          stop();
          try {
            if (typeof sec.onLocked === "function") { sec.onLocked(showing); return; }
          } catch (e) {}
          try {
            if (window.FB && typeof FB.checkout === "function") { FB.checkout(go, "endcard"); return; }
          } catch (e2) {}
          location.href = "/explore";
        });
      } else {
        /* Nothing left. Said, not hidden. */
        go = el("a", "go ec-go", str(opts.cta) || "Back to Explore");
        go.href = "/explore";
        go.setAttribute("role", "button");
      }
      act.appendChild(go);

      /* The way out, and the countdown's cancel. It is an ordinary link, so
         it works with the keyboard, with a screen reader, and with the
         browser's own "open in a new tab" — and it stops the clock on the way
         past rather than leaving one running behind a page nobody is on. */
      if (target) {
        var out = el("a", "ghost ec-out", "Back to Explore");
        out.href = "/explore";
        out.addEventListener("click", function () { stop(); });
        act.appendChild(out);
      }

      /* A reader who already pays is not sold to, on any screen, ever. */
      if (!open) {
        var line = offerLine();
        if (line) act.appendChild(line);
      }
      sec.appendChild(act);

      /* ------------------------------------------------------------------
         THE CLOCK.

         phase 0 nothing has been reached yet
         phase 1 the completion moment
         phase 2 the next episode, and — only if canAuto — the countdown
         Everything below is a no-op when canAuto is false; the two beats
         still play, the clock simply never starts.
         ------------------------------------------------------------------ */
      var phase = 0, count = COUNT_FROM, tHold = 0, tTick = 0, bound = false;

      /* classList, never className. tools/compose.py's sign-up block appends
         " has-ask" to this element from outside, and an assignment here would
         take it back off on the next beat — which on /firststory is every
         rule in css/recommend.css that positions the ask. */
      function paint() {
        try {
          sec.classList.remove("is-p0");
          sec.classList.remove("is-p1");
          sec.classList.remove("is-p2");
          sec.classList.add("is-p" + phase);
        } catch (e) {
          sec.className = "pane rec endcard is-p" + phase;
        }
        if (!countP) return;
        countP.textContent = phase !== 2 ? ""
          : count > 0 ? "Next story in " + count + "…"
                      : "Opening…";
      }

      function unbind() {
        if (!bound) return;
        bound = false;
        try { document.removeEventListener("visibilitychange", onHide, false); } catch (e) {}
        try { window.removeEventListener("pagehide", onGone, false); } catch (e) {}
        try { window.removeEventListener("popstate", onGone, false); } catch (e) {}
      }
      function onHide() {
        /* A tab put in the background is a reader who has left. */
        try { if (document.visibilityState === "hidden") stop(); } catch (e) { stop(); }
      }
      function onGone() { stop(); }
      function bind() {
        if (bound) return;
        bound = true;
        try { document.addEventListener("visibilitychange", onHide, false); } catch (e) {}
        try { window.addEventListener("pagehide", onGone, false); } catch (e) {}
        try { window.addEventListener("popstate", onGone, false); } catch (e) {}
      }

      /* Idempotent, and safe to call from anywhere at any time.

         It also takes the countdown's words off the screen. A reader who put
         the tab in the background for a minute and came back would otherwise
         be looking at "Next story in 2…" over a clock that is never going to
         tick again, which is a screen telling them something untrue about
         itself. fire() paints "Opening…" immediately after calling this, so
         the one stop that is not a cancellation still says so. */
      function stop() {
        try { clearTimeout(tHold); } catch (e) {}
        try { clearInterval(tTick); } catch (e) {}
        tHold = 0; tTick = 0;
        if (countP) { try { countP.textContent = ""; } catch (e) {} }
        try { say.textContent = ""; } catch (e) {}
        unbind();
      }

      /* Zero. "Opening…" goes on the screen, and the navigation is one beat
         behind it — a word assigned in the same tick as location.href is a
         word the browser is never given a frame to paint, and "Opening…" is
         the last thing this screen is meant to say. The beat is still
         cancellable: stop() clears this timeout like any other. */
      function fire() {
        try { clearInterval(tTick); } catch (e) {}
        tTick = 0;
        count = 0;
        paint();
        if (!target) { stop(); return; }
        track("rec_click", { stack: str(target.id), why: str(pick.why), slot: "auto" });
        tHold = setTimeout(function () {
          if (!sec.parentNode) { stop(); return; }
          unbind();
          try { location.href = href(target); } catch (e) {}
        }, OPEN_MS);
      }

      function run() {
        if (!canAuto) return;
        count = COUNT_FROM;
        paint();
        /* One announcement, at the start, instead of a number read out four
           times. The seconds stay on the screen as text for everyone else. */
        try {
          say.textContent = "Next story opens in " + COUNT_FROM +
            " seconds. Start now, or go back to Explore.";
        } catch (e) {}
        tTick = setInterval(function () {
          /* The pane was replaced under us — read.html rebuilds this card when
             the access answer changes — so there is nobody to navigate for. */
          if (!sec.parentNode) { stop(); return; }
          count--;
          paint();
          if (count <= 0) fire();
        }, TICK_MS);
      }

      /* reveal() — the reader has arrived. Starts beat 1, then beat 2, then
         the clock. Restartable: scrolling back into the story and returning
         plays the moment again rather than dropping the reader on a dead
         screen with a countdown that already ran. */
      /* The story this card is offering, for a caller that needs to know
         which one — read.html writes it into fb_return_v1 so a buyer comes
         back to a story they have not read rather than to a shelf. Null when
         there is nothing left to offer. */
      sec.nextStory = showing || null;

      sec.reveal = function () {
        once(sec, "__fbSeen", function () {
          track("first_completion_screen_viewed",
                { stack: curId, mins: str(minutes(cur && cur.secs)) });
          /* "First" is answerable only from the reader's own record. When
             that record is not ours to read, the one completion we have
             witnessed is the one that just happened — so this fires on it,
             and the property says which of the two it was. */
          var got = learned();
          if (got.n === 1) {
            track("first_story_completed",
                  { stack: curId, counted: got.known ? "record" : "session" });
          }
          if (showing) {
            track("second_story_shown",
                  { stack: str(showing.id), locked: pick.locked ? "1" : "0" });
          }
        });
        if (phase) return;                     /* already playing */
        stop();
        bind();
        phase = 1;
        paint();
        tHold = setTimeout(function () {
          if (!sec.parentNode) { stop(); return; }
          phase = 2;
          paint();
          run();
        }, HOLD_MS);
      };

      /* leave() — the reader scrolled back into the story, or this pane is
         being replaced. The clock stops and the screen goes back to its
         first beat, so returning replays it. */
      sec.leave = function () {
        stop();
        phase = 0;
        count = COUNT_FROM;
        try { say.textContent = ""; } catch (e) {}
        paint();
      };

      paint();
      track("rec_view", { stack: curId, n: showing ? "1" : "0" });
      return sec;
    } catch (e) {
      /* Last resort: a pane with a way out is still a working end of story. */
      try {
        var f = el("section", "pane rec endcard is-p2");
        f.appendChild(el("h2", null, "Story complete."));
        var a = el("a", "go ec-go", "Back to Explore");
        a.href = "/explore";
        f.appendChild(a);
        f.reveal = function () {};
        f.leave = function () {};
        return f;
      } catch (e2) { return sec || null; }
    }
  }

  /* ======================================================================
     2. THE WALL — the story runs, and it is interrupted where it stops.

     WHAT CHANGED, AND WHY IT IS NOT A SCREEN ANY MORE.

     The wall used to be a PANE that replaced the deck: a manufactured
     "interruption" screen with the story's first card on it, then an offer
     screen, reached by a button. Two invented screens standing in front of
     a story the reader was already allowed to start.

     It is now an OVERLAY over the story itself. A locked story really opens
     and really runs — read.html draws its first cards, on their own plates,
     with their own credit lines and the same progress rail every other story
     has — and the run simply stops. Trying to keep reading is what asks for
     an account:

         1  the story, running                     (read.html)
         2  .fbg-auth   "Keep reading."            an account to save it
         3  .fbg-buy    "Finish <the subject>."    the price, and the button
         4  Stripe                                 not ours
         5  the story, unlocked                    (read.html)

     THE GESTURE IS THE INTENT SIGNAL. There is no unlock button to hunt for
     at the foot of the page: one more scroll past the boundary opens the
     sheet. read.html owns the gesture, because it owns the deck; this file
     owns what the gesture opens. What it must never be is a hair trigger —
     see "the boundary" in read.html for the arming rule.

     BOTH SHEETS ARE IN THE DOM FROM THE FIRST FRAME, hidden with
     visibility:hidden rather than display:none. That keeps them out of the
     tab order and out of the accessibility tree while leaving their words
     where a checker reading the page can find them, which is what the
     paywall check in ONBOARDING.md asserts, and it is what makes the
     crossfade one mechanism instead of two.

     THREE THINGS THE MOCKUP DRAWS THAT ARE NOT DRAWN HERE, each with the
     one thing that would have to become true first — see PROOF, APPLE_ON
     and the note over the price block below. Nothing about them is hidden:
     each is a switch with its condition written next to it.

     No countdown, no "today only", no scarcity of any kind. The offer is the
     same at four in the morning as it is now.
     ====================================================================== */

  /* ---- who is holding the phone -----------------------------------------
     js/auth.js is the only thing that knows, and it may not have arrived.
     Every question below answers "no" rather than throwing, because a wall
     that cannot tell whether somebody is signed in must still be a wall with
     a way through it. */
  function fbu() {
    try { return (window.FBU && window.FBU.__factbox) ? window.FBU : null; } catch (e) { return null; }
  }
  function signedIn() {
    try { var U = fbu(); return !!(U && U.signedIn && U.signedIn()); } catch (e) { return false; }
  }
  function uidNow() {
    try {
      var U = fbu();
      if (U && U.uid && U.uid()) return String(U.uid());
    } catch (e) {}
    return "";
  }
  /* True ONLY when the SDK never arrived — a blocked CDN, a dead network, a
     webview too old to parse it. A reader who is merely signed out is not
     this case: they can sign in, and the sheet above asks them to. This is
     the one exception STRIPE.md allows to the attribution rule, and it is
     counted rather than hidden. */
  function authDead() {
    try {
      var U = fbu();
      if (!U) return true;
      if (U.unavailable && U.unavailable()) return true;
      if (U.ok && !U.ok() && U.known && U.known()) return true;
    } catch (e) { return true; }
    return false;
  }

  /* This page, as a return address, so /login hands the reader back to the
     exact story they were reading — query string and all. login.html
     whitelists the value; a path with ?s=<id> on it passes. */
  function hereNext() {
    try {
      return encodeURIComponent(String(location.pathname || "/") + String(location.search || ""));
    } catch (e) { return encodeURIComponent("/explore"); }
  }
  function loginURL() { return "/login?next=" + hereNext(); }

  /* ---- "Continue with Apple" · NOT SHIPPED, AND HERE IS THE SWITCH -------
     The mockup puts an Apple button between Google and email. Firebase has
     no Apple provider configured on this project — the identity toolkit
     answers OPERATION_NOT_ALLOWED for apple.com and returns a real auth URI
     for google.com — so a button drawn from that design would open a screen
     that cannot sign anybody in. A sign-in control that fails is worse than
     one that is not there, so it is not drawn.

     TO TURN IT ON, in this order:
       1. Apple Developer: a Services ID for factbox.app, a Sign in with
          Apple key, and factbox-7cb97.firebaseapp.com/__/auth/handler as the
          return URL.
       2. Firebase console -> Authentication -> Sign-in method -> Apple,
          enabled, with that Services ID and key.
       3. js/auth.js: a signInApple() beside signInGoogle(), built on
          OAuthProvider("apple.com"), with the same popup-then-redirect
          fallback — Instagram and TikTok webviews block window.open.
       4. APPLE_ON = true here.
     The second condition is not redundant: if this flag is flipped before
     step 3 lands, the button still does not appear, because there is nothing
     for it to call. */
  var APPLE_ON = false;
  function appleReady() {
    try {
      var U = fbu();
      return !!(APPLE_ON && U && typeof U.signInApple === "function");
    } catch (e) { return false; }
  }

  /* ---- the proof slot · NO STATISTIC SHIPS ------------------------------
     The mockup's purchase screen carries two percentages about what "Factbox
     members" did in their first thirty days. Both are marked verified:false
     in the mockup's own source, and the designer's changelog says outright
     that they are prototype placeholders with no study behind them. They are
     also claims about a member base this product does not yet have. So the
     slot is built and the figures are not: `stat` is null, `on` is false,
     and what renders is the copy-only arm — which is the A/B arm the mockup
     itself describes, and which says nothing that cannot be defended.

     This is the third time this repo has been asked for a number nobody
     measured. js/start.js's RECALL_CLAIM_PCT is null for the same reason.

     TO TURN IT ON, both of these, in this order:
       1. Run the study. A cohort, a definition of the behaviour, a window,
          and a figure that survives somebody else recomputing it. "Built a
          consistent learning habit" is not measurable until "consistent" is
          a number of days in a number of weeks.
       2. Put the measured figure in `stat` and its sentence in `cap`, then
          set `on` to true. Nothing else changes: the numeric arm renders
          from the same slot.
     A figure that arrives without step 1 is the same failure as printing a
     round price when the till takes eighty-eight cents more. */
  var PROOF = {
    on: false,
    stat: null,
    /* The measured claim's sentence goes here with the figure. */
    statCap: "",
    /* The copy-only arm, which is what ships. Neither line asserts anything
       about anybody: they describe what the product is. */
    cap: "Make five minutes of screen time count.",
    note: "Same phone. Something to show for it."
  };

  function proofSlot() {
    var box = el("div", "fbg-proof");
    if (PROOF.on && PROOF.stat) {
      box.appendChild(el("p", "fbg-stat", str(PROOF.stat)));
      box.appendChild(el("p", "fbg-statcap", str(PROOF.statCap)));
      return box;
    }
    box.appendChild(el("p", "fbg-cap", str(PROOF.cap)));
    if (PROOF.note) box.appendChild(el("p", "fbg-note", str(PROOF.note)));
    return box;
  }

  /* Google's mark, inline, at the size the sheet uses it. Drawn rather than
     fetched: this file adds no request, and an <img> that 404s inside a
     sign-in button is a button that looks broken. */
  function googleMark() {
    var box = el("span", "fbg-mark");
    box.setAttribute("aria-hidden", "true");
    box.innerHTML =
      '<svg viewBox="0 0 48 48" focusable="false">' +
        '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.8 6.1C12.3 14 17.6 9.5 24 9.5z"/>' +
        '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.3z"/>' +
        '<path fill="#FBBC05" d="M10.4 28.4a14.6 14.6 0 010-9.3l-7.8-6.1a24 24 0 000 21.5l7.8-6.1z"/>' +
        '<path fill="#34A853" d="M24 47.5c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.7-4.5-13.6-10.4l-7.8 6.1C6.5 42.1 14.6 47.5 24 47.5z"/>' +
      '</svg>';
    return box;
  }

  /* THE STORY'S OWN TITLE, as the eyebrow on both sheets — and it is the
     eyebrow rather than the headline for a reason.

     The mockup's sheets read "Finish Cleopatra." and "continue with
     Cleopatra", built from the subject's name. That works because it was
     drawn on the one subject in the season whose name is a proper noun. The
     other seven names in the taxonomy are GROUP labels — "Medieval and
     modern", "When it all went wrong", "Things you have wrong" — and the
     same sentence over any of them reads "Finish Medieval and modern.",
     which is not English.

     Titles are headlines rather than nouns, so they do not survive the slot
     either: "Finish 7 Deadly Sins Explained." So the naming moves up one
     line. The title labels the sheet, where a headline belongs and where no
     grammar is being asserted about it, and the sentence under it is one
     that is true of every story in the season.

     Also NOT here: the mockup's "· 2 of 9". That number needs the whole
     index; this screen is handed one story, and a position guessed from one
     record is a number we made up. */
  function storyLine(s) {
    try { return str(s && s.title); } catch (e) { return ""; }
  }

  /* The sheet. Exactly the rungs js/account.js offers — two of them today,
     because quarterly is retired with offered:false and this reads the
     offer rather than a list of its own.

     The rung the offer leads with goes first. account.js's array is the
     ladder in price order and /join renders it that way; a sheet is a choice
     with one already made, and the one already made belongs at the top of it
     rather than under the alternative. */
  function plansSheet(state) {
    var raw = offered(), list = [], i0;
    if (raw.length < 2) return null;
    for (i0 = 0; i0 < raw.length; i0++) { if (raw[i0].best) list.push(raw[i0]); }
    for (i0 = 0; i0 < raw.length; i0++) { if (!raw[i0].best) list.push(raw[i0]); }

    var wrap = el("div", "pw-sheet");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Choose a plan");

    var bg = el("div", "pw-sheetbg");
    wrap.appendChild(bg);

    var card = el("div", "pw-sheetcard");
    card.appendChild(el("h3", "pw-sheethead", "Choose a plan"));

    var opts = [], i;

    function paintOptions() {
      for (var j = 0; j < opts.length; j++) {
        var on = opts[j].__key === state.key;
        opts[j].setAttribute("aria-checked", on ? "true" : "false");
        opts[j].className = "pw-opt" + (on ? " is-on" : "");
      }
    }

    function nameOf(p) {
      /* The rung's own words, capitalised. account.js says "every month" /
         "a year"; the ladder key is what the offer is called. */
      var k = str(p.key);
      return k ? k.charAt(0).toUpperCase() + k.slice(1) : "Plan";
    }

    for (i = 0; i < list.length; i++) {
      (function (p) {
        var b = el("button", "pw-opt");
        b.type = "button";
        b.setAttribute("role", "radio");
        /* Each option sends its own named event below; "-" is analytics.js's
           opt-out and stops the same tap being counted a second time as a
           generic ui_click. */
        b.setAttribute("data-fbt", "-");
        b.__key = p.key;

        var top = el("span", "pw-optline");
        top.appendChild(el("b", null, nameOf(p)));
        if (p.best) top.appendChild(el("span", "pw-best", "Best value"));
        b.appendChild(top);

        b.appendChild(el("span", "pw-optprice", str(p.billedLine)));
        /* perMonthAbout, never perMonthText: 35.88 divides into exactly 2.99,
           35.00 does not, and dropping the word "about" is quoting a figure
           nobody is charged. */
        if (p.months > 1 && p.perMonthAbout) {
          b.appendChild(el("span", "pw-optper", str(p.perMonthAbout) + " a month"));
        }

        b.appendChild(el("span", "pw-tick", ""));
        b.lastChild.innerHTML = tickSVG();

        b.addEventListener("click", function () {
          state.pick(p.key);
          paintOptions();
        });
        card.appendChild(b);
        opts.push(b);
      })(list[i]);
    }

    var go = el("button", "go pw-sheetgo", state.ctaLabel);
    go.type = "button";
    go.setAttribute("data-fbt", "-");          /* sends trial_cta_clicked */
    go.addEventListener("click", function () { state.start(go); });
    card.appendChild(go);

    var shut = el("button", "ghost pw-sheetclose", "Close");
    shut.type = "button";
    card.appendChild(shut);

    wrap.appendChild(card);

    function close() {
      try { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch (e) {}
      try { document.removeEventListener("keydown", onKey, false); } catch (e) {}
    }
    function onKey(ev) {
      try { if (ev && (ev.key === "Escape" || ev.key === "Esc")) close(); } catch (e) {}
    }
    bg.addEventListener("click", close);
    shut.addEventListener("click", close);
    try { document.addEventListener("keydown", onKey, false); } catch (e) {}

    wrap.close = close;
    wrap.paint = paintOptions;
    paintOptions();
    return wrap;
  }

  /* paywall(stack, opts) -> an OVERLAY element, not a pane.

     It is `position:fixed` and belongs on <body>, because the deck scrolls
     and a sheet inside a scrolling box scrolls away with its content — the
     same reason "View other plans" has always been appended to <body>.

     opts: { from, onLater, onStart }
       from     a short slug for the analytics property: "paywall" from a
                locked story, "endcard" from the completion screen.
       onLater  what "Maybe later" does. Absent, it just shuts the sheet and
                leaves the reader in the story, which is where they were.
       onStart  called with the chosen plan key just before checkout, so the
                caller can remember where the reader was. This file writes no
                storage of its own and is not about to start.
       head     the offer sheet's headline. It defaults to "Finish the
                story.", which is right when the reader was stopped in the
                middle of one. It is NOT right at the end of a free story on
                /firststory, where nothing was interrupted and what is being
                offered is the rest of the season — so that caller passes its
                own sentence rather than this screen guessing from context it
                does not have.

     The element it returns carries its own controls:
       .open()      the right sheet for who is holding the phone
       .openAuth()  the account sheet
       .openBuy()   the offer
       .shut()      neither, and the story is readable again
       .reveal()    what read.html has always called; it opens.
       .leave()     a no-op, for the same reason.

     Always returns an element. Never throws. */
  function paywall(stack, opts) {
    var host;
    try {
      opts = opts || {};
      var from = str(opts.from) || "paywall";
      var s = stack && typeof stack === "object" ? stack : null;
      var d = trialDays();
      var lead = leadPlan();
      var state = { key: lead ? lead.key : "", ctaLabel: "Unlock & keep reading" };

      host = el("div", "paywall fbg");
      host.setAttribute("data-from", from);

      /* The story stays visible under the sheet. It is the thing being sold,
         and a reader who can still see the sentence they stopped on is
         answering a different question from one looking at an advertisement
         that replaced it. */
      var veil = el("div", "fbg-veil");
      veil.setAttribute("aria-hidden", "true");
      host.appendChild(veil);

      /* ---- step 2 · the account ------------------------------------------
         WHY AN ACCOUNT COMES BEFORE THE PRICE. It is not a toll on the way
         to checkout. STRIPE.md §1: client_reference_id is the entire link
         between a payment and an account, and it has to be a Firebase uid.
         A reader who pays without one gets in through a local flag, on this
         browser only — their money does not follow them to a second phone
         and does not survive clearing the browser. So the sheet asks for the
         thing that makes the purchase theirs, and says what it is for.

         A reader who is already signed in never sees this sheet at all. */
      var auth = el("section", "fbg-sheet fbg-auth");
      auth.setAttribute("role", "dialog");
      auth.setAttribute("aria-modal", "true");
      auth.setAttribute("aria-label", "Keep reading");

      var eyebrow = storyLine(s);
      if (eyebrow) auth.appendChild(el("p", "fbg-eyebrow", eyebrow));
      auth.appendChild(el("h2", "fbg-head", "Keep reading."));
      auth.appendChild(el("p", "fbg-sub",
        "Save your progress, and pick up exactly where you stopped."));

      var gbtn = el("button", "fbg-btn fbg-google");
      gbtn.type = "button";
      /* Named, not opted out: this control sends no event of its own, so it
         arrives as ui_click with `control` set to this. No new event name —
         GA4 caps how many it will take. */
      gbtn.setAttribute("data-fbt", "gate_google");
      gbtn.appendChild(googleMark());
      gbtn.appendChild(el("span", null, "Continue with Google"));
      auth.appendChild(gbtn);

      /* Apple, only when there is something behind it. See APPLE_ON. */
      var abtn = null;
      if (appleReady()) {
        abtn = el("button", "fbg-btn fbg-line", "Continue with Apple");
        abtn.type = "button";
        abtn.setAttribute("data-fbt", "gate_apple");
        auth.appendChild(abtn);
      }

      var mbtn = el("button", "fbg-btn fbg-line fbg-mail", "Continue with email");
      mbtn.type = "button";
      mbtn.setAttribute("data-fbt", "gate_email");
      auth.appendChild(mbtn);

      var already = el("p", "fbg-alt");
      already.appendChild(document.createTextNode("Already have an account? "));
      var inLink = el("a", null, "Sign in");
      inLink.href = loginURL();
      inLink.setAttribute("data-fbt", "gate_signin");
      already.appendChild(inLink);
      auth.appendChild(already);

      var authLater = el("button", "ghost fbg-later", "Not now");
      authLater.type = "button";
      authLater.setAttribute("data-fbt", "gate_notnow");
      auth.appendChild(authLater);

      host.appendChild(auth);

      /* ---- step 3 · the offer --------------------------------------------
         One headline, one reason, one amount, one button, and the terms
         under it in the order they happen. Every figure is READ out of
         js/account.js — see the block over acct() — and when FBA is not
         there the numbers are simply not drawn. A missing price is a smaller
         failure than an invented one. */
      var buy = el("section", "fbg-sheet fbg-buy");
      buy.setAttribute("role", "dialog");
      buy.setAttribute("aria-modal", "true");
      buy.setAttribute("aria-label", "Finish the story");

      if (eyebrow) buy.appendChild(el("p", "fbg-eyebrow", eyebrow));
      buy.appendChild(el("h2", "fbg-head fbg-headbig",
        str(opts.head) || "Finish the story."));
      /* Two sentences, both true of the same tap: this story finishes, and
         the shelf behind it opens. */
      buy.appendChild(el("p", "fbg-sub",
        "Unlock every story in Factbox. Your next story is already waiting."));

      buy.appendChild(proofSlot());

      var priceP = null, perP = null;
      if (lead && lead.billedText) {
        priceP = el("p", "fbg-price");
        priceP.appendChild(el("b", null, str(lead.billedText)));
        priceP.appendChild(el("span", null, perLong(lead)));
        buy.appendChild(priceP);
        var per = underMonth(lead);
        if (per) { perP = el("p", "fbg-per", per); buy.appendChild(perP); }
      }

      var go = el("button", "go fbg-go", state.ctaLabel);
      go.type = "button";
      go.setAttribute("data-fbt", "-");          /* sends trial_cta_clicked */
      buy.appendChild(go);

      /* The terms, under the button: the trial, what it costs today, and
         that it can be stopped. All three are account.js's own answers, and
         the trial is stated because the three live Payment Links really do
         grant one. See RECOMMEND.md if the design ever stops saying so —
         the links have to change first, not this screen. */
      var fine = null;
      if (d) {
        fine = el("p", "fine fbg-fine",
          trialShort() + " · " + zero() + " today · Cancel anytime");
        buy.appendChild(fine);
        try {
          var cn = acct() && FBA.pricing ? (FBA.pricing() || {}).currencyNote : "";
          if (cn) buy.appendChild(el("p", "fine fbg-fine fbg-cur", cn));
        } catch (e) {}
      }

      var ghosts = el("div", "fbg-ghosts");
      var more = el("button", "ghost fbg-plans", "View other plans");
      more.type = "button";
      more.setAttribute("data-fbt", "-");        /* sends other_plans_opened */
      ghosts.appendChild(more);
      var later = el("button", "ghost fbg-later", "Maybe later");
      later.type = "button";
      later.setAttribute("data-fbt", "gate_later");
      ghosts.appendChild(later);
      buy.appendChild(ghosts);

      host.appendChild(buy);

      /* ---- which sheet, and when ------------------------------------------
         Render-then-correct, the same discipline as the access gate: the
         sheet that opens is the one that matches the answer we have, and it
         is replaced when a better answer arrives. A reader who signs in
         through the Google REDIRECT leg leaves this page entirely and comes
         back to it, so "where was I" has to survive that trip. It rides in
         sessionStorage, keyed to the story, and it is the only thing this
         file stores. */
      var STEP_KEY = "fb_gate_v1";
      function remember(step) {
        try {
          sessionStorage.setItem(STEP_KEY, JSON.stringify(
            { s: s ? str(s.id) : "", step: step }));
        } catch (e) {}
      }
      function remembered() {
        try {
          var raw = sessionStorage.getItem(STEP_KEY);
          if (!raw) return 0;
          var o = JSON.parse(raw);
          if (!o || o.s !== (s ? str(s.id) : "")) return 0;
          return Math.floor(Number(o.step)) || 0;
        } catch (e) { return 0; }
      }
      function forget() {
        try { sessionStorage.removeItem(STEP_KEY); } catch (e) {}
      }

      function paint(cls) {
        try {
          host.className = "paywall fbg" + (cls ? " " + cls : "");
        } catch (e) {}
      }

      var seen = false;
      function report() {
        if (seen) return;
        seen = true;
        /* paywall_view, not a new name for the same moment: it is what
           privacy.html tells readers we send and what every funnel already
           counts. GA4 caps distinct names and a near-identical second one
           would split both. */
        track("paywall_view", { stack: s ? str(s.id) : "", from: from });
      }

      function openAuth() { paint("is-auth"); remember(2); report(); focusIn(auth); }
      function openBuy()  { paint("is-buy");  remember(3); report(); focusIn(buy); }
      /* Shutting is not leaving. The reader is still in the story, the
         boundary is one scroll behind them, and read.html re-arms the gesture
         through onShut so the sheet can be asked for again. */
      function shut() {
        paint("");
        try { if (typeof host.onShut === "function") host.onShut(); } catch (e) {}
      }

      /* Focus follows the sheet. Without this the reader is looking at a new
         surface and the keyboard is still on the card behind it. */
      function focusIn(sheet) {
        try {
          var t = sheet.querySelector("button, a[href]");
          if (t && t.focus) t.focus();
        } catch (e) {}
      }

      function open() {
        if (signedIn()) { openBuy(); return; }
        openAuth();
      }

      /* Signing in through the redirect leg reloads this page. If the reader
         had already reached the sheet for THIS story and now has an account,
         put them back where they were rather than making them find the
         boundary again. */
      function restore() {
        try {
          var was = remembered();
          if (!was) return false;
          if (was >= 2 && signedIn()) { openBuy(); return true; }
        } catch (e) {}
        return false;
      }

      /* An account arriving while the sheet is open — a popup sign-in, or a
         late FBU — moves the reader on rather than leaving them looking at a
         question they have just answered. */
      try {
        var U = fbu();
        if (U && U.onChange) {
          U.onChange(function () {
            try {
              if (host.className.indexOf("is-auth") === -1) return;
              if (signedIn()) openBuy();
            } catch (e) {}
          });
        }
      } catch (e) {}

      /* ---- what the controls do ------------------------------------------- */

      gbtn.addEventListener("click", function () {
        var U = fbu();
        if (!U || !U.signInGoogle) { location.href = loginURL(); return; }
        remember(2);
        try { gbtn.disabled = true; } catch (e0) {}
        try {
          Promise.resolve(U.signInGoogle()).then(function () {
            try { gbtn.disabled = false; } catch (e1) {}
            if (signedIn()) openBuy();
          }, function () {
            /* A blocked popup becomes a redirect inside js/auth.js, so the
               only failures that land here are ones the reader can act on.
               The email door is always open and never depends on a popup. */
            try { gbtn.disabled = false; } catch (e2) {}
          });
        } catch (e3) {
          try { gbtn.disabled = false; } catch (e4) {}
          location.href = loginURL();
        }
      });

      if (abtn) {
        abtn.addEventListener("click", function () {
          var U = fbu();
          if (!U || typeof U.signInApple !== "function") { location.href = loginURL(); return; }
          remember(2);
          try {
            Promise.resolve(U.signInApple()).then(function () {
              if (signedIn()) openBuy();
            }, function () {});
          } catch (e) { location.href = loginURL(); }
        });
      }

      /* Email is /login, which is the site's one real Firebase sign-in and
         also creates accounts. It carries this page as its return address,
         so the reader comes back to the story with the story still on it. */
      mbtn.addEventListener("click", function () {
        remember(2);
        try { location.href = loginURL(); } catch (e) {}
      });
      inLink.addEventListener("click", function () { remember(2); });

      authLater.addEventListener("click", function () { shut(); });

      /* ---- the plan, and the sheet that changes it ------------------------ */
      var sheet = null;

      function pick(key) {
        var p = planFor(key);
        if (!p) return;
        state.key = p.key;
        if (priceP) {
          priceP.innerHTML = "";
          priceP.appendChild(el("b", null, str(p.billedText)));
          priceP.appendChild(el("span", null, perLong(p)));
        }
        if (perP) {
          var per2 = underMonth(p);
          perP.textContent = per2;
          perP.style.display = per2 ? "" : "none";
        }
        try { if (acct() && FBA.setPlan) FBA.setPlan(p.key); } catch (e) {}
        /* Two literal names. Never one built out of the key — GA4 caps the
           number of distinct event names and tools/check-analytics.js fails
           the build on a name assembled at runtime. */
        if (p.key === "annual") track("annual_selected", { from: from });
        else if (p.key === "monthly") track("monthly_selected", { from: from });
      }

      /* ---- checkout · THE ATTRIBUTION RULE, ON THE READER PAGE -------------
         This used to hand off to /join and let that page do it. /join no
         longer asks anything, so the tap that buys is here now, and so is
         the guard that goes with it — unchanged from join.html's, because
         the rule is STRIPE.md's, not the page's:

           no Firebase uid  -> checkout_blocked{why:"no_uid"}, and the reader
                               goes to sign in rather than to Stripe
           no Payment Link  -> checkout_blocked{why:"no_link" / "no_url"} and
                               the button says so, before the tap where it can
           otherwise        -> checkout_start{attributed:"1"|"0"}, then Stripe

         THE ONE CASE LET THROUGH is auth being genuinely unavailable.
         Blocking there loses the sale AND leaves the reader no way to make an
         account, which is strictly worse than a payment reconciled by hand:
         profile-sync writes localAccountId into the reader's own document the
         moment they do sign in, which is what that reconciliation joins on.
         It is counted, not hidden — attributed 0 is a number somebody can
         look at rather than a thing nobody knew.

         checkoutURL() is js/account.js's, untouched: it is the one place
         that builds client_reference_id. */
      var blockedSaid = false;
      function start(btn) {
        track("trial_cta_clicked", { plan: str(state.key), from: from });

        var A = acct();
        if (A && A.anyLinkReady && !A.anyLinkReady()) {
          if (!blockedSaid) {
            blockedSaid = true;
            track("checkout_blocked", { plan: str(state.key), why: "no_link" });
          }
          say(btn, "Checkout is not open yet",
              "Payments are not switched on for this site yet. Nothing was " +
              "charged and nothing was sent.");
          return;
        }

        try { if (A && A.setPlan && state.key) A.setPlan(state.key); } catch (e) {}
        try { if (typeof opts.onStart === "function") opts.onStart(state.key); } catch (e1) {}
        try { if (sheet && sheet.close) sheet.close(); } catch (e2) {}

        var uid = uidNow();
        if (!uid && !authDead()) {
          /* checkout_start has NOT fired: this checkout did not start. */
          track("checkout_blocked", { plan: str(state.key), why: "no_uid" });
          remember(3);
          openAuth();
          return;
        }

        /* The same event a buy button has always sent from the same tap. It
           is sent instead of FB.checkout's, never as well as it, so the
           funnel counts one click and not two. */
        track("subscribe_click", { from: from });
        track("checkout_start", { plan: str(state.key), attributed: uid ? "1" : "0" });

        var url = "";
        try { if (A && A.checkoutURL) url = str(A.checkoutURL(state.key)); } catch (e3) {}
        if (!url) {
          /* checkout_start has already fired and the reader is going nowhere.
             Without this the funnel shows a checkout that started and never
             completed, which is what an abandoned payment looks like too —
             two very different problems, one shape in the report. */
          track("checkout_blocked", { plan: str(state.key), why: "no_url" });
          say(btn, "Checkout is not open yet",
              "Payments are not switched on for this site yet. Nothing was " +
              "charged and nothing was sent.");
          return;
        }
        forget();
        try { location.href = url; } catch (e4) {}
      }

      /* A dead end that explains itself. Never a code, never a blank sheet. */
      function say(btn, label, note) {
        try { if (btn) { btn.textContent = label; btn.disabled = true; } } catch (e) {}
        try {
          if (!buy.querySelector(".fbg-note")) {
            buy.insertBefore(el("p", "fine fbg-note", note), ghosts);
          }
        } catch (e2) {}
      }

      state.pick = pick;
      state.start = start;

      go.addEventListener("click", function () { start(go); });

      more.addEventListener("click", function () {
        track("other_plans_opened", { from: from });
        try {
          if (sheet && sheet.parentNode) return;
          sheet = plansSheet(state);
          if (!sheet) return;
          (document.body || document.documentElement).appendChild(sheet);
        } catch (e) {}
      });

      later.addEventListener("click", function () {
        shut();
        try {
          if (typeof opts.onLater === "function") opts.onLater();
        } catch (e) {}
      });

      /* Escape and the veil both mean "let me look at the story again". They
         do not navigate: the reader is still in the story, and the boundary
         is one scroll away when they want it. */
      veil.addEventListener("click", function () { shut(); });
      function onKey(ev) {
        try {
          if (!ev || (ev.key !== "Escape" && ev.key !== "Esc")) return;
          if (host.className.indexOf("is-") === -1) return;
          shut();
        } catch (e) {}
      }
      try { document.addEventListener("keydown", onKey, false); } catch (e) {}

      host.onShut = null;
      host.open = open;
      host.openAuth = openAuth;
      host.openBuy = openBuy;
      host.shut = shut;
      host.restore = restore;
      /* read.html has always called reveal() on the pane it just built, and
         leave() when the reader scrolls off it. One opens; the other is a
         no-op, because a sheet is not something you scroll past. */
      host.reveal = open;
      host.leave = function () {};
      paint("");
      return host;
    } catch (e) {
      /* Never nothing. The same two sentences, the same way in, the same way
         out, and not one number it cannot price. */
      try {
        var f = el("section", "pane paywall pw is-offer");
        f.appendChild(el("h2", null, "Finish the story."));
        f.appendChild(el("p", "pw-sub",
          "And unlock every story in Factbox. Your next story is already waiting."));
        var a = el("a", "go pw-go", "Unlock & keep reading");
        a.href = "/join?from=paywall";
        f.appendChild(a);
        var b = el("a", "ghost", "Back to stories");
        b.href = "/explore";
        f.appendChild(b);
        f.open = function () {};
        f.openAuth = f.open; f.openBuy = f.open; f.shut = f.open;
        f.onShut = null;
        f.restore = function () { return false; };
        f.reveal = function () {};
        f.leave = function () {};
        return f;
      } catch (e2) { return host || null; }
    }
  }

  return {
    version: 2,
    next: next,
    endPanel: endPanel,
    paywall: paywall,
    href: href,
    reasonFor: function (cur, s) {
      try { return reason(cur, s, progress(s), !unlocked()).text; } catch (e) { return "Next up"; }
    }
  };
})();
