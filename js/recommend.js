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

  /* The funnel entrance, with the story attached.

     gate.js's FB.checkout() is the one place that decides what a buy button
     does, and it builds "/join?from=<where>". It cannot carry a second value,
     and /join needs one now: a reader arriving from a locked story lands on
     the first onboarding question with THAT story behind it, and is handed
     back to it when the questions end. So the path is composed from gate.js's
     own joinURL() rather than rebuilt — one source for the route, one place
     that sanitises `from` — and the id is appended here.

     The id is written down twice on purpose. A query string does not survive
     the trip out to Stripe and back; localStorage does, and does not survive
     a private window that refuses writes. Two carriers, one fact, and both
     say the same thing to whichever end reads first. */
  function joinFor(from, s) {
    try {
      if (!window.FB || typeof FB.joinURL !== "function") return "";
      var u = str(FB.joinURL(from));
      if (!u) return "";
      var id = (s && s.id != null) ? String(s.id) : "";
      if (!id) return u;
      return u + (u.indexOf("?") === -1 ? "?" : "&") + "s=" + encodeURIComponent(id);
    } catch (e) { return ""; }
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

       visible   the record is this reader's. The count of finished stories
                 and the days they read on are read straight out of it.
       not       we know exactly one thing: this reader finished a story
                 just now, on this page, because we watched them do it. So
                 one story is claimed and one day is filled, and nothing is
                 said about any other day.

     What is never done is filling six empty dots and calling it a streak.
     ====================================================================== */

  var DAY_MS = 86400000;

  function dayStart(ms) {
    var d = new Date(Number(ms) || 0);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

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

  /* Seven days ending today; index 6 is today.
     Today is true for everybody, because finishing a story is what put this
     screen on the screen. The six before it are only filled from the
     reader's own record, and only when that record is theirs to show.

     FBP stores ONE timestamp per story — the last time it was touched — so a
     day whose only story was later re-opened is not in the map any more.
     That under-counts and can never over-count, which is the direction this
     has to fail in. */
  function week() {
    var out = { day: [false, false, false, false, false, false, true],
                n: 1, known: false };
    try {
      if (!memoryMine() || typeof FBP.all !== "function") return out;
      var today = dayStart(Date.now());
      var m = FBP.all(), k, at, i, n = 1;
      out.known = true;
      for (k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
        /* FBP.rec() already returns milliseconds. Multiplying or dividing
           again here is the bug tools/check-regressions.js guards on the
           shelf, and it makes every streak zero. */
        at = m[k] && m[k].at;
        if (!at) continue;
        i = 6 - Math.round((today - dayStart(at)) / DAY_MS);
        if (i >= 0 && i < 6 && !out.day[i]) { out.day[i] = true; n++; }
      }
      out.n = n;
    } catch (e) {}
    return out;
  }

  /* "3 minutes", "3½ minutes", "half a minute" — the same half-minute
     arithmetic every runtime on the site is printed with, so the completion
     line can never disagree with the row that offered the story. */
  function minutesPhrase(secs) {
    try {
      var v = minutes(secs).replace(/\s*min$/, "");
      if (v === "\u00bd") return "half a minute";
      return v + (v === "1" ? " minute" : " minutes");
    } catch (e) { return ""; }
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

  /* CLEOPATRA · 1 OF 8 — and it has to stop implying more when there is no
     more. `disaster` holds exactly one story, and "1 of 1" under a screen
     about carrying on is a sentence a reader can disprove in one tap;
     RECOMMEND.md records the subhead already special-casing it. So: one
     story in the subject says so in words, and the last of a subject is
     marked rather than left looking like the middle. */
  function placeLine(list, cur) {
    var pl = place(list, cur);
    if (!pl.of) return null;
    var subject = topicName(cur && cur.topic) ||
                  str(cur && cur.topic).replace(/_/g, " ");
    if (!subject) return null;
    var tail;
    if (pl.of === 1)          tail = " · the only one";
    else if (pl.n >= pl.of)   tail = " · " + pl.n + " of " + pl.of + ", the last";
    else                      tail = " · " + pl.n + " of " + pl.of;
    return el("p", "ec-place", subject + tail);
  }

  /* ---- small builders ---------------------------------------------------- */

  function tickSVG() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M5 12.5l4.6 4.6L19 7.2"/>' +
           '</svg>';
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

  /* The paywall's cover, at size.

     Deliberately not the little row below. The picture is the argument — it
     is what makes somebody want in — and a 60px thumbnail with a sentence
     beside it is a list item, not an argument. The story's name goes under
     it, and its own hook does NOT: for a good third of the corpus the hook
     opens with the title, so a title and a hook stacked read as the same
     line printed twice, which looks like a bug and was reported as one. */
  function bigPlate(s) {
    var wrap = el("div", "pw-cover");
    wrap.appendChild(thumb(s, "pw-plate"));
    wrap.appendChild(el("h3", "pw-title", str(s.title)));
    var m = minutes(s.secs);
    if (m) wrap.appendChild(el("p", "pw-min", m));
    return wrap;
  }

  /* The next story: its cover, its headline and its runtime. The same three
     facts on the completion screen and on the paywall, so the thing being
     unlocked is the thing that was just promised. */
  function nextRow(s) {
    var row = el("div", "nextrow ec-next");
    row.appendChild(thumb(s));
    var t = el("div", "t");
    t.appendChild(el("b", null, str(s.title)));
    t.appendChild(el("span", null, minutes(s.secs)));
    row.appendChild(t);
    return row;
  }

  /* ======================================================================
     1. THE COMPLETION SCREEN

     A moment before an offer. The reader has just finished a whole story,
     and what they get first is the fact that they did: a tick, the time it
     took, how many they have now read, and the week they are building. The
     next story is shown before it is sold. The offer is one quiet line
     under the button, and a subscriber never sees it at all.
     ====================================================================== */

  function completeHead() {
    var wrap = el("div", "ec-done");
    var badge = el("span", "ec-badge");
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = tickSVG();
    wrap.appendChild(badge);
    wrap.appendChild(el("span", "ec-eyebrow", "Story complete"));
    return wrap;
  }

  /* Seven dots. The label carries the meaning, so the strip itself is
     decoration and is hidden from a screen reader rather than read out as
     seven empty list items. */
  function weekRow(w) {
    var wrap = el("div", "ec-week");
    wrap.appendChild(el("span", "ec-weeklabel",
      w.known ? ("This week · " + w.n + (w.n === 1 ? " day" : " days"))
              : "Your first week"));
    var dots = el("div", "ec-dots");
    dots.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 7; i++) {
      dots.appendChild(el("i", w.day[i] ? (i === 6 ? "is-today" : "is-on") : null));
    }
    wrap.appendChild(dots);
    return wrap;
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

     Two things the caller may set on the returned element AFTER it is built,
     because tools/compose.py matches read.html's call verbatim and an extra
     option in that call breaks the build of /cleopatra:

       el.onLocked(stack)  what "Keep learning" does when the next story is
                           not this reader's to open. read.html shows the
                           paywall. Absent, the control falls back to the
                           funnel entrance, so it is never dead.
       el.reveal()         the reader has actually reached this pane. Fires
                           the view events; safe to call many times. */
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

      /* --- the moment ----------------------------------------------------- */
      sec.appendChild(completeHead());

      var mins = cur ? minutesPhrase(cur.secs) : "";
      sec.appendChild(el("h2", null,
        str(opts.heading) ||
        (mins ? "You just learned something in " + mins + "."
              : "You just learned something.")));

      /* Where this story sat in its subject. It is the one fact that makes
         "there is more" a statement rather than a promise — and the one that
         has to stop being printed when there is no more. */
      var pl = placeLine(list, cur);
      if (pl) sec.appendChild(pl);

      var got = learned();
      var count = el("p", "ec-count",
        got.n === 1 ? "1 story learned" : got.n + " stories learned");
      sec.appendChild(count);

      var weekBox = weekRow(week());
      sec.appendChild(weekBox);

      /* Render, then correct — the same rule the shelf, the library and the
         access gate follow, for the same reason.

         js/progress.js answers "is this record this viewer's?" twice: a
         synchronous hint off Firebase's own storage so a returning reader's
         first paint is right, and then the real answer once Firebase has
         actually said who is holding the phone. When the second answer
         disagrees — a shared browser, a signed-out session, a revoked token —
         the numbers here have to come back off the screen rather than sit
         there being somebody else's. Measured: without this the card kept
         "4 stories learned · this week 5 days" for a viewer FBP had already
         decided was nobody. */
      try {
        if (window.FBP && typeof FBP.onChange === "function") {
          var off = FBP.onChange(function () {
            /* Self-unsubscribing: this panel is replaced whenever the access
               answer changes, and a listener on a detached node is a leak. */
            if (!sec.parentNode) { try { off(); } catch (e) {} return; }
            try {
              var g2 = learned();
              count.textContent =
                g2.n === 1 ? "1 story learned" : g2.n + " stories learned";
              var fresh2 = weekRow(week());
              if (weekBox.parentNode) {
                weekBox.parentNode.replaceChild(fresh2, weekBox);
                weekBox = fresh2;
              }
            } catch (e) {}
          });
        }
      } catch (e) {}

      /* --- what is next ---------------------------------------------------- */
      if (showing) {
        sec.appendChild(el("p", "ec-nextlabel", str(opts.sub) || "Your next story is ready"));
        sec.appendChild(nextRow(showing));
      }

      /* --- one action, and one quiet line under it --------------------------
         Three shapes, and which one it is depends only on what pickNext
         found:

           a link      there is a next story and this reader may open it
           a button    there is a next story and they may not — the offer
           a way out   there is no next story at all. "Back to Explore",
                       said out loud, rather than a silent lap back to the
                       first story, which is the loop this replaces.

         opts.cta still wins on the label, because tools/compose.py builds
         /firststory by passing one. */
      var act = el("div", "ec-act");
      var go;
      if (target) {
        go = el("a", "go ec-go", str(opts.cta) || "Keep learning");
        go.href = href(target);
        go.setAttribute("role", "button");
        /* Already counted, as rec_click. See js/analytics.js. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
          track("rec_click", { stack: str(target.id), why: str(pick.why), slot: "1" });
        });
      } else if (showing) {
        go = el("button", "go ec-go", str(opts.cta) || "Keep learning");
        go.type = "button";
        /* Already counted: the paywall sends its own view event, and
           FB.checkout sends subscribe_click. */
        try { go.setAttribute("data-fbt", "-"); } catch (e) {}
        go.addEventListener("click", function () {
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

      /* A reader who already pays is not sold to, on any screen, ever. */
      if (!open) {
        var line = offerLine();
        if (line) act.appendChild(line);
      }
      sec.appendChild(act);

      sec.reveal = function () {
        once(sec, "__fbSeen", function () {
          track("first_completion_screen_viewed",
                { stack: curId, mins: str(minutes(cur && cur.secs)) });
          /* "First" is answerable only from the reader's own record. When
             that record is not ours to read, the one completion we have
             witnessed is the one that just happened — so this fires on it,
             and the property says which of the two it was. */
          if (got.n === 1) {
            track("first_story_completed",
                  { stack: curId, counted: got.known ? "record" : "session" });
          }
          if (showing) {
            track("second_story_shown",
                  { stack: str(showing.id), locked: pick.locked ? "1" : "0" });
          }
        });
      };

      track("rec_view", { stack: curId, n: showing ? "1" : "0" });
      return sec;
    } catch (e) {
      /* Last resort: a pane with a way out is still a working end of story. */
      try {
        var f = el("section", "pane rec endcard");
        f.appendChild(el("h2", null, "Story complete."));
        var a = el("a", "go ec-go", "Back to Explore");
        a.href = "/explore";
        f.appendChild(a);
        f.reveal = function () {};
        return f;
      } catch (e2) { return sec || null; }
    }
  }

  /* ======================================================================
     2. THE PAYWALL

     Not a pricing table and not three cards. One sentence, the story they
     are about to unlock, and what happens on two dates: nothing today, the
     real annual price in three days. Everything else is behind "View other
     plans", which is a sheet with the two rungs account.js still offers.

     No countdown, no "today only", no scarcity of any kind. The offer is
     the same at four in the morning as it is now.
     ====================================================================== */

  /* One row of the two-date table. */
  function payRow(when, amount, note, cls) {
    var row = el("div", "pw-row" + (cls ? " " + cls : ""));
    row.appendChild(el("span", "pw-when", when));
    var amt = el("span", "pw-amt", amount);
    row.appendChild(amt);
    row.appendChild(el("span", "pw-note", note));
    row.__amt = amt;
    return row;
  }

  /* The sheet. Exactly the rungs account.js offers — two of them today,
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
        /* perMonthAbout, never perMonthText: $35.88 divides into exactly
           $2.99, $35.00 does not, and dropping the word "about" is quoting
           a figure nobody is charged. */
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

  /* paywall(stack, opts) -> a .pane element.
     opts: { from, onLater, onStart }
       from     a short slug for the analytics property and for the funnel
                entrance: "paywall" from a locked story, "endcard" from the
                completion screen.
       onLater  what "Maybe later" does. Absent, it goes to /explore.
       onStart  called with the chosen plan key just before checkout, so the
                caller can remember where the reader was. This file writes no
                storage of its own and is not about to start.
     Always returns an element. Never throws. */
  function paywall(stack, opts) {
    var sec;
    try {
      opts = opts || {};
      var from = str(opts.from) || "paywall";
      sec = el("section", "pane paywall pw");

      var s = stack && typeof stack === "object" ? stack : null;
      var d = trialDays();
      var lead = leadPlan();

      /* ONE PRIMARY ACTION, AND IT IS NOT "START MY 3 DAYS FREE".

         This button cannot start a trial. Nothing on the reader page can:
         checkout is three Stripe Payment Links reached from the end of
         /join, and this control opens /join at its first question. A button
         that promises a trial and lands on "what do you want to remember?"
         is the same class of untruth as printing $35 when the till takes
         $35.88, which is the rule the whole of this repo is built around.

         So the button names what the reader is actually about to do — carry
         on reading — and the trial is stated on the pane as TERMS rather
         than as the button's promise: "3 days free" over two dated rows,
         nothing today, the real annual price in three days, cancel anytime.
         Everything about the offer is on the screen before the tap; only the
         claim that the tap performs it is gone.

         It is also the momentum: the reader is engaged with one particular
         story, and that story goes with them — see joinFor() above. */
      var state = { key: lead ? lead.key : "", ctaLabel: "Keep reading" };

      sec.appendChild(el("h2", null, "Keep learning."));
      sec.appendChild(el("p", "pw-sub", "Your next story is already waiting."));

      /* What they are unlocking, named and pictured. A wall with nothing
         behind it is a wall. */
      if (s && s.img) sec.appendChild(bigPlate(s));

      /* --- what happens, and when ------------------------------------------
         Two dates and two amounts. No countdown and no expiry: this offer is
         the same tomorrow, and a clock on it would be a lie told to hurry
         somebody. */
      var row2 = null;
      if (lead && d) {
        var box = el("div", "pw-trial");
        /* trialShort() is account.js's own phrase for the length — "3 days
           free" — so the words and the number move together with TRIAL_DAYS
           and there is nothing here to keep in step. */
        box.appendChild(el("p", "pw-trialhead", "Try Factbox — " + trialShort()));
        box.appendChild(payRow("Today", zero(), "Full access", "is-now"));
        row2 = payRow("In " + d + (d === 1 ? " day" : " days"),
                      priceTag(lead), "First charge");
        box.appendChild(row2);
        sec.appendChild(box);
      }

      /* --- the actions ------------------------------------------------------ */
      var act = el("div", "pw-act");

      var go = el("button", "go pw-go", state.ctaLabel);
      go.type = "button";
      go.setAttribute("data-fbt", "-");        /* sends trial_cta_clicked */
      act.appendChild(go);

      if (d) {
        act.appendChild(el("p", "fine pw-fine",
          zero() + " today · Cancel anytime"));
      }

      /* One wrapper, so the two can sit side by side on a phone turned
         sideways where 88px of stacked ghosts is a quarter of the viewport. */
      var ghosts = el("div", "pw-ghosts");

      var more = el("button", "ghost pw-plans", "View other plans");
      more.type = "button";
      more.setAttribute("data-fbt", "-");      /* sends other_plans_opened */
      ghosts.appendChild(more);

      /* The only way out. "Back to stories" used to sit under it going to the
         same place as the fixed "back to Stories" pill at the top left of this
         same screen, which is one destination offered twice. */
      var later = el("button", "ghost pw-later", "Maybe later");
      later.type = "button";
      ghosts.appendChild(later);

      act.appendChild(ghosts);

      sec.appendChild(act);

      /* --- selection --------------------------------------------------------
         The chosen rung is remembered through FBA.setPlan(), which is the
         same value /join restores when it paints the plan screen. So the
         button "following the selection" is not a second checkout path — it
         is the one the site already has, told which rung was picked. */
      var sheet = null;

      function pick(key) {
        var p = planFor(key);
        if (!p) return;
        state.key = p.key;
        if (row2 && row2.__amt) row2.__amt.textContent = priceTag(p);
        try { if (acct() && FBA.setPlan) FBA.setPlan(p.key); } catch (e) {}
        /* Two literal names. Never one built out of the key — GA4 caps the
           number of distinct event names and tools/check-analytics.js fails
           the build on a name assembled at runtime. */
        if (p.key === "annual") track("annual_selected", { from: from });
        else if (p.key === "monthly") track("monthly_selected", { from: from });
      }

      function start(btn) {
        track("trial_cta_clicked", { plan: str(state.key), from: from });
        /* Carry the rung the reader was actually looking at, whether they
           opened the sheet or not. /join restores it through FBA.plan() and
           paints the plan screen with it selected, so the price on the wall
           and the price on the plan screen are the same one. Written on the
           TAP, never at render: a plan nobody has acted on is not a choice. */
        try { if (acct() && FBA.setPlan && state.key) FBA.setPlan(state.key); } catch (e) {}
        try { if (typeof opts.onStart === "function") opts.onStart(state.key); } catch (e) {}
        try { if (sheet && sheet.close) sheet.close(); } catch (e) {}
        var url = joinFor(from, s);
        if (url) {
          /* The same event FB.checkout would have sent from the same tap.
             This path is taken instead of it, never as well as it, so the
             funnel counts one click and not two. */
          track("subscribe_click", { from: from });
          try { location.href = url; return; } catch (e) {}
        }
        /* No joinURL — an older cached gate.js. The one place that decides
           what a buy button does still knows the way, it just cannot carry
           the story. A reader in the funnel beats a dead button. */
        try {
          if (window.FB && typeof FB.checkout === "function") { FB.checkout(btn, from); return; }
        } catch (e2) {}
        location.href = "/join";
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
        try {
          if (typeof opts.onLater === "function") { opts.onLater(); return; }
        } catch (e) {}
        location.href = "/explore";
      });

      sec.reveal = function () {
        once(sec, "__fbSeen", function () {
          /* paywall_view, not a new name for the same moment. It is what
             privacy.html tells readers we send and what every funnel already
             counts, and a second near-identical name would split both. */
          track("paywall_view", { stack: s ? str(s.id) : "", from: from });
        });
      };
      /* The wall is drawn and seen in the same breath, unlike the end card
         which is built a dozen cards before anyone reaches it. */
      sec.reveal();

      return sec;
    } catch (e) {
      try {
        var f = el("section", "pane paywall pw");
        f.appendChild(el("h2", null, "Keep learning."));
        f.appendChild(el("p", "pw-sub", "Your next story is already waiting."));
        var a = el("a", "go pw-go", "Keep reading");
        a.href = "/join?from=paywall";
        f.appendChild(a);
        var b = el("a", "ghost", "Back to stories");
        b.href = "/explore";
        f.appendChild(b);
        f.reveal = function () {};
        return f;
      } catch (e2) { return sec || null; }
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
