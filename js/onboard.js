/* ==========================================================================
   Factbox — the quiz onboarding engine. One global: FBOB.

   WHAT THIS FILE IS. The eleven screens a reader walks after finishing the
   free story and before they are asked for an account. It renders them into
   an element it is handed, records every answer through FBA as it is given,
   emits the four ob_* events in ONBOARDING-ANALYTICS.md, and then hands
   control back. It does not do auth. It does not do payment. It does not
   navigate. mount() takes onDone and onExit and the page decides what those
   mean, because the screen after this one is a product decision and this file
   is not the place it gets made.

   WHY IT IS NOT js/start.js. The retired funnel had that name and
   tools/check-analytics.js:154 fails the build if it comes back without
   /join's question screens. Nothing here is named start.

   ---------------------------------------------------------------------------
   THE FOUR EVENTS, AND THE ONE THING THAT MUST NOT DRIFT

     ob_step    a screen was committed to the display
     ob_answer  an answer was chosen
     ob_leave   a screen stopped being displayed, and how
     ob_done    the flow reached its terminus

   Four names, thirteen screens, screen identity in a property. That trade is
   ONBOARDING-ANALYTICS.md §0.1 and it is the reason there is no ob_welcome.
   Every name below is a literal string at its call site; none is assembled,
   because tools/check-analytics.js:189 fails the build on a name built from a
   variable and it is right to.

   ---------------------------------------------------------------------------
   THE SCREEN LIST, AND THE ONE ROW ADDED TO IT

   ONBOARDING-ANALYTICS.md declares twelve screens. This engine declares
   THIRTEEN: q_genres is inserted at position 6, and everything from the old
   position 6 onward moves down one.

   Why: the agreed flow asks for a genre multi-pick, and that pick is the only
   answer in the whole funnel that actually drives anything — FBFIT.rank()
   reads it and nothing else. The declared list had no slot for it. Nothing
   else moved: welcome, q_draw, affirm_draw, q_relate and affirm_relate keep
   the exact positions the spec gave them, and every screen the spec named is
   still here under its own id. One insertion, no reorder, no renaming.

   THIS IS A CONTRACT CHANGE AND IT HAS A SECOND HALF. SCREENS below must be
   copied verbatim into OB_STEPS in functions/insights.js, because §7 guard 5
   is that the two lists are the same list in the same order, and because an
   inferred order is right until the day a step gains traffic from somewhere
   else and is then silently wrong. Exported as FBOB.SCREENS so the check can
   read it rather than re-type it.

   ---------------------------------------------------------------------------
   WHERE ANSWERS LIVE

   In FBA. There is no second store, and that is not a stylistic preference:
   js/profile-sync.js wraps FBA's setters to mirror them to Firestore, so an
   answer written anywhere else is an answer that never reaches the account.

     draw     FBA.setDraw()        DRAWS
     relates  FBA.setRelates()     RELATES, a list
     genres   FBA.setInterests()   FBFIT.GENRES keys, a list
     goal     FBA.setGoal()        GOALS, minutes, -1 for "you pick"
     streak   FBA.setStreak()      STREAKS, days
     plan     FBA.addPlanAnswer()  the loader's yes/nos
     story    the run record       see below

   THE STORY PICK IS THE EXCEPTION AND IT IS DELIBERATE. FBA has no field for
   it and inventing one here would be the wrong half of a three-file change:
   ONBOARDING-ANALYTICS.md §6(e) says the key list in firestore.rules, the
   sentence in privacy.html §07 and js/profile-sync.js all move together or
   the hasOnly() clause rejects the WHOLE write and silently stops mirroring
   the answers that do sync today. So the pick is kept in the run record,
   which is local and disclosed, until that field exists. When it does, this
   is one line.

   ---------------------------------------------------------------------------
   THE RUN RECORD

   fb_ob_run_v1, the key ONBOARDING-ANALYTICS.md names: the run id, the
   furthest screen reached, a timestamp, and the story pick. It is what makes
   resume possible and what makes one person's third attempt distinguishable
   from their first, which DASHBOARD.md item 11 says nothing else on this site
   can do. It is written after every answer, not at the end, because a reader
   who abandons is exactly the reader whose position matters.

   ---------------------------------------------------------------------------
   DOUBLE COUNTING

   Every button this file renders carries data-fbt="-". js/analytics.js's
   delegated listener fires ui_click on every tappable element it does not
   recognise, and every control here already fires ob_leave or ob_answer from
   the same tap unconditionally. That is the .jn-yn precedent and it has
   shipped as a bug twice. There is one helper that makes a button, and it
   sets the attribute; there is no path to a button that skips it.

   ES5. No arrow functions, no template literals, no block scoping. The
   audience is the Instagram and TikTok in-app browsers.
   ========================================================================== */

var FBOB = (function () {
  "use strict";

  var VERSION = "1.0.0";

  /* ======================================================================
     The declared screen list. Copy into OB_STEPS in functions/insights.js.
     "n" is the screen's declared position, never the count of screens this
     reader saw, so two readers who branch differently still compare.
     ====================================================================== */
  var SCREENS = [
    { id: "welcome",       kind: "intro",    n: 1  },
    { id: "q_draw",        kind: "question", n: 2  },
    { id: "affirm_draw",   kind: "affirm",   n: 3  },
    { id: "q_relate",      kind: "question", n: 4  },
    { id: "affirm_relate", kind: "affirm",   n: 5  },
    { id: "q_genres",      kind: "question", n: 6  },
    { id: "q_time",        kind: "question", n: 7  },
    { id: "q_streak",      kind: "question", n: 8  },
    { id: "pick_story",    kind: "pick",     n: 9  },
    { id: "building",      kind: "loader",   n: 10 },
    { id: "results",       kind: "results",  n: 11 },
    { id: "account",       kind: "account",  n: 12 },
    { id: "paywall",       kind: "paywall",  n: 13 }
  ];

  /* The eleven this engine renders. account and paywall are other surfaces;
     they are declared above so the funnel is one list, and fired by whoever
     owns them. FLOW is what mount() walks and what progress() counts. */
  var FLOW = ["welcome", "q_draw", "affirm_draw", "q_relate", "affirm_relate",
              "q_genres", "q_time", "q_streak", "pick_story", "building",
              "results"];

  var TERMINUS = "results";

  /* The five question screens, in flow order, for the phase chrome. The
     interstitials, the loader and the payoff are not work to get through and
     do not appear on the bar. */
  var QSTEPS = ["q_draw", "q_relate", "q_genres", "q_time", "q_streak"];
  var PHASES = [
    { label: "You",   keys: ["q_draw", "q_relate"] },
    { label: "Taste", keys: ["q_genres"] },
    { label: "Habit", keys: ["q_time", "q_streak"] }
  ];

  /* ======================================================================
     Copy. Adapted from the Quiz Funnel mockup, journey 3a.

     Three branch points and nothing else, which is the mockup's own rule:
     acknowledge the answer, then say what Factbox does about it. No praise,
     no "great choice", no statistics anywhere.
     ====================================================================== */

  /* Branch 1 — SCHOOL, rekeyed onto DRAWS. The mockup asked how much history
     you remember from school and branched four ways; the store owns a
     four-key vocabulary for what draws you to history, and answer values must
     come from a vocabulary js/account.js owns or the analytics and the stored
     profile drift apart. Same four variants, same register, three of them
     word for word. */
  var AFFIRM_DRAW = {
    people: ["People are why any of it sticks.",
             "Factbox tells history through the people in it — their motives, their mistakes, and what it cost them."],
    turning: ["Let’s fill in the good parts.",
              "You know the basics. Factbox gives you the scandals, mysteries and details they usually leave out."],
    thread: ["You’re definitely not alone.",
             "History is hard to remember when it’s taught as dates and names. It’s much easier when it feels like a story."],
    tiktok: ["Good. We can skip the boring stuff.",
             "Factbox goes beyond the textbook into the details, controversies and rabbit holes worth knowing."]
  };

  /* Branch 2 — SCROLL, verbatim, including the skip. The mockup skips this
     screen outright rather than padding it with a variant that has nothing to
     say; here the empty answer is the one with nothing to acknowledge. */
  var AFFIRM_RELATE = {
    stories: ["Your scrolling isn’t the problem.",
              "What you’re scrolling is. Let’s make five minutes of it worth remembering."],
    other: ["Let’s make more of it stick.",
            "Five minutes is enough to learn one story you’ll still remember tomorrow."]
  };

  /* Branch 3 — IDENTITY, rekeyed onto the goal in minutes. Copy on an
     existing screen rather than a screen of its own, which is what the mockup
     does with it. All five variants survive. */
  var IDENTITY = {
    "-1": ["There’s a lot you were never taught.",
           "Five minutes at a time, you’ll start connecting the people, events and ideas that shaped the world."],
    "5": ["Five minutes is enough.",
          "No chapters. No hour-long lessons. Just one fascinating story at a time."],
    "10": ["Keep the scroll. Upgrade what’s in it.",
           "You don’t need another productivity routine. Just make five minutes of your existing screen time count."],
    "15": ["Never run out of things to talk about.",
           "The best stories have a way of coming back up. At dinner, on dates, at work, everywhere."],
    "0": ["History makes more sense as a story.",
          "Factbox connects the people, motives and consequences so you understand what actually happened."]
  };

  var DRAW_OPTS = [
    { k: "people",  b: "The people in it" },
    { k: "turning", b: "The moment it all turned" },
    { k: "thread",  b: "How we got from there to here" },
    { k: "tiktok",  b: "A clip I couldn’t stop thinking about" }
  ];

  var RELATE_OPTS = [
    { k: "notime",     b: "I never seem to find the time" },
    { k: "unfinished", b: "I start things and don’t finish them" },
    { k: "stories",    b: "I read a ton and remember almost none of it" }
  ];

  var TIME_OPTS = [
    { k: "5",    v: 5,  b: "Five minutes" },
    { k: "10",   v: 10, b: "Ten minutes" },
    { k: "15",   v: 15, b: "Fifteen minutes" },
    { k: "auto", v: -1, b: "You pick for me" }
  ];

  var STREAK_OPTS = [
    { k: "7",  v: 7,  b: "A week" },
    { k: "14", v: 14, b: "Two weeks" },
    { k: "30", v: 30, b: "A month" },
    { k: "50", v: 50, b: "Fifty days" }
  ];

  /* The pick screen. Four real covers, hook first, straight from the mockup —
     Factbox has no JFK story, so the fourth is the Ides of March. The ids are
     catalogue ids and the answer value IS the id. */
  var COVERS = [
    { id: "23", head: "The Bible’s most misunderstood woman", who: "Mary Magdalene", img: "s23" },
    { id: "17", head: "The tomb no one has found in 2,000 years", who: "Cleopatra",      img: "s17" },
    { id: "41", head: "The emperor who allegedly watched Rome burn", who: "Nero",        img: "s41" },
    { id: "50", head: "The general his own senators stabbed", who: "Julius Caesar",      img: "s50" }
  ];

  /* The loader's two interruptions. This is the whole point of the loader:
     dead time turned into commitment. They are yes/no, they are stored
     through FBA.addPlanAnswer, and both answers lead to the same place —
     which the iOS file this vocabulary came from says out loud. They are
     still the reader's, so they are kept rather than discarded. */
  var INTERRUPTS = [
    { at: 34, head: "Would you rather spend five minutes on one of these…",
      sub: "…than scrolling another twenty posts you’ll forget?" },
    { at: 72, head: "If it only took five minutes a day, would you keep it up?",
      sub: "" }
  ];

  var YES = "Yes";
  var NO  = "Not sure";

  /* ======================================================================
     Small helpers.
     ====================================================================== */

  function W() { return typeof window !== "undefined" ? window : null; }
  function D() { try { return window.document; } catch (e) { return null; } }
  function fba() { try { return window.FBA || null; } catch (e) { return null; } }
  function fbfit() { try { return window.FBFIT || null; } catch (e) { return null; } }

  function str(v) { return v == null ? "" : String(v); }

  function has(list, v) {
    if (!list || typeof list.length !== "number") return false;
    for (var i = 0; i < list.length; i++) { if (list[i] === v) return true; }
    return false;
  }

  function screenAt(i) {
    var id = FLOW[i];
    for (var j = 0; j < SCREENS.length; j++) {
      if (SCREENS[j].id === id) return SCREENS[j];
    }
    return { id: str(id), kind: "unknown", n: i + 1 };
  }

  function indexOfStep(id) {
    for (var i = 0; i < FLOW.length; i++) { if (FLOW[i] === id) return i; }
    return -1;
  }

  /* pageName(), the same shape js/analytics.js computes for itself. It is not
     exported from there, and the alternative is sending no "page" at all,
     which would put these four events in a different shape from every other
     event on the site. */
  function pageName() {
    try {
      var p = String(location.pathname || "/").replace(/\/+$/, "");
      var i = p.lastIndexOf("/");
      if (i > -1) p = p.slice(i + 1);
      p = p.replace(/\.html?$/i, "");
      if (!p || p === "index") return "home";
      return p.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40) || "home";
    } catch (e) { return "unknown"; }
  }

  /* How they arrived. The closed list the spec names, and "direct" for
     anything else — never the raw query value, which is reader-supplied. */
  var FROMS = ["story", "start", "home", "direct"];
  function fromParam() {
    try {
      var m = /[?&]from=([a-z_]{1,20})/i.exec(String(location.search || ""));
      var v = m ? m[1].toLowerCase() : "";
      return has(FROMS, v) ? v : "direct";
    } catch (e) { return "direct"; }
  }

  /* ======================================================================
     The run record. fb_ob_run_v1 — the key ONBOARDING-ANALYTICS.md names.
     ====================================================================== */

  var RUN_KEY   = "fb_ob_run_v1";
  var RESUME_MS = 7 * 24 * 60 * 60 * 1000;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } }

  function readRun() {
    try {
      var raw = lsGet(RUN_KEY);
      if (!raw) return null;
      var r = JSON.parse(raw);
      if (!r || typeof r !== "object") return null;
      return r;
    } catch (e) { return null; }
  }

  function writeRun(r) {
    try { return lsSet(RUN_KEY, JSON.stringify(r)); } catch (e) { return false; }
  }

  /* Eight characters from Math.random. Not a session id, not derived from
     anything about the reader, never sent to Stripe. */
  function mint() {
    var s = "";
    while (s.length < 8) {
      s += Math.random().toString(36).slice(2);
    }
    return s.slice(0, 8);
  }

  /* ======================================================================
     Analytics. Four literal names, and nothing built at runtime.
     ====================================================================== */

  function track(name, props) {
    try {
      if (window.FB && typeof FB.track === "function") FB.track(name, props);
    } catch (e) {}
  }

  var DWELL_CEIL = 1800000;   /* thirty minutes: a machine that went to sleep.
                                 There is NO floor, on purpose — the affirmation
                                 screens are designed to be dismissed in well
                                 under a second and a floor deletes exactly the
                                 measurement being asked for. Onboarding dwell
                                 and card_view dwell are measured under
                                 different rules and must never be compared. */

  /* ======================================================================
     State. One flow at a time; mount() on a second element replaces the
     first, which is what a bottom sheet reopening does.
     ====================================================================== */

  var host    = null;     /* the element handed to mount() */
  var idx     = -1;       /* index into FLOW, or -1 when not mounted */
  var run     = "";
  var runState = "fresh"; /* "fresh" | "resume", for the first ob_step */
  var firstStep = true;
  var from    = "direct";
  var page    = "start";
  var opts    = {};
  var seen    = {};       /* step ids committed this run */
  var answered = {};      /* q keys answered this run, for ob_done.answers */
  var slots   = {};       /* answer slots filled this run, for ob_answer.state */
  var doneSent = false;
  var stacks  = null;

  /* the clock: engaged time only, paused while the tab is hidden, the way
     story_time is. A phone face-down in a pocket does not report an hour. */
  var markAt  = 0;
  var acc     = 0;
  var paused  = false;
  var committed = false;  /* rendered plus one frame; a mount flicker is not a
                             screen view and does not get an ob_step */
  var rafId   = 0;
  var pending = 0;        /* the screen index waiting on its frame */

  /* the loader */
  var loadPct = 0;
  var loadTimer = 0;
  var interruptAt = -1;   /* index into INTERRUPTS while one is showing */
  var interruptsDone = 0;

  /* the affirmation auto-release */
  var affirmTimer = 0;

  /* ======================================================================
     DOM.
     ====================================================================== */

  function el(tag, cls, text) {
    var e = D().createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* THE ONLY WAY A BUTTON IS MADE IN THIS FILE.

     data-fbt="-" is set here and nowhere else, so there is no path to a
     button without it. js/analytics.js fires ui_click on every tappable
     element it does not recognise; every control this file renders already
     fires ob_leave or ob_answer from the same tap, unconditionally, so
     without this every tap in the funnel is counted twice. That bug has
     shipped twice. */
  function btn(cls, text, onTap) {
    var b = el("button", cls, text);
    b.type = "button";
    b.setAttribute("data-fbt", "-");
    if (onTap) {
      b.onclick = function (ev) {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) {}
        try { onTap(this); } catch (e2) {}
        return false;
      };
    }
    return b;
  }

  function tick(cls) {
    var i = el("i", cls || "ob-tick");
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  function art(imgName, cls) {
    var box = el("div", cls);
    box.setAttribute("aria-hidden", "true");
    var im = D().createElement("img");
    im.alt = "";
    im.decoding = "async";
    im.setAttribute("data-fallback", "/img/stacks/" + str(imgName) + ".webp");
    im.onerror = function () {
      this.onerror = null;                       /* one retry, never a loop */
      this.src = this.getAttribute("data-fallback");
    };
    im.src = "/img/thumbs/" + str(imgName) + ".webp";
    box.appendChild(im);
    return box;
  }

  /* ======================================================================
     Reading the answers back out of FBA. Every screen renders from the store
     rather than from a local copy, which is what makes Back and resume the
     same code path: there is one source of truth and it survives a refresh.
     ====================================================================== */

  function getDraw()    { var A = fba(); try { return A ? A.draw() : ""; } catch (e) { return ""; } }
  function getRelates() { var A = fba(); try { return A ? A.relates() : []; } catch (e) { return []; } }
  function getGenres()  { var A = fba(); try { return A ? A.interests() : []; } catch (e) { return []; } }
  function getGoal()    { var A = fba(); try { return A ? A.goal() : 0; } catch (e) { return 0; } }
  function getStreak()  { var A = fba(); try { return A ? A.streak() : 0; } catch (e) { return 0; } }
  function getPlans()   { var A = fba(); try { return A ? A.planAnswers() : []; } catch (e) { return []; } }

  function getStory() {
    var r = readRun();
    return r && typeof r.c === "string" ? r.c : "";
  }

  function setStory(id) {
    var r = readRun() || {};
    r.c = str(id);
    stampRun(r);
  }

  function stampRun(r) {
    var rec = r || readRun() || {};
    rec.v = 1;
    rec.r = run || rec.r || "";
    rec.t = Date.now();
    if (idx > (typeof rec.i === "number" ? rec.i : -1)) rec.i = idx;
    if (typeof rec.i !== "number") rec.i = idx < 0 ? 0 : idx;
    writeRun(rec);
    return rec;
  }

  /* The genre list, clamped. Two is the floor because one pick ranks almost
     nothing, three is the ceiling because FBFIT weights the picks and a
     reader who taps all six has said nothing. */
  var GENRE_MIN = 2;
  var GENRE_MAX = 3;

  function genreList() {
    var F = fbfit();
    if (F && F.GENRES) return F.GENRES;
    return [];
  }

  /* ======================================================================
     The events.
     ====================================================================== */

  function emitStep(sc) {
    track("ob_step", {
      page:  page,
      step:  sc.id,
      kind:  sc.kind,
      n:     sc.n,
      run:   run,
      state: firstStep ? runState : "fresh",
      from:  from
    });
    firstStep = false;
    seen[sc.id] = 1;
  }

  /* 'slot' exists for one case: the loader asks two questions and both are
     stored through FBA.addPlanAnswer, so both report q:"plan". Keying 'state'
     off q alone made the second one "changed", which is the word for a reader
     going back and correcting themselves — a different fact, and the one the
     dashboard reads that column for. 'state' is keyed by the SLOT; the count
     in ob_done.answers stays keyed by q, because that number is distinct
     questions answered and the two interruptions are one question in the
     vocabulary. */
  function emitAnswer(sc, q, answer, slot) {
    var key = slot || q;
    var st = slots[key] ? "changed" : "first";
    slots[key] = 1;
    answered[q] = 1;
    track("ob_answer", {
      page:   page,
      step:   sc.id,
      n:      sc.n,
      run:    run,
      q:      q,
      answer: str(answer),
      state:  st
    });
  }

  function emitLeave(sc, why, ms) {
    if (ms > DWELL_CEIL) return;          /* a device that went to sleep */
    track("ob_leave", {
      page:     page,
      step:     sc.id,
      kind:     sc.kind,
      n:        sc.n,
      run:      run,
      why:      why,
      dwell_ms: Math.round(ms < 0 ? 0 : ms)
    });
  }

  function emitDone(sc) {
    if (doneSent) return;
    doneSent = true;
    var nScreens = 0, k;
    for (k in seen) { if (seen.hasOwnProperty(k)) nScreens++; }
    var nAnswers = 0;
    for (k in answered) { if (answered.hasOwnProperty(k)) nAnswers++; }
    track("ob_done", {
      page:    page,
      run:     run,
      step:    sc.id,
      screens: nScreens,
      answers: nAnswers,
      state:   runState
    });
  }

  /* ======================================================================
     The clock.
     ====================================================================== */

  function clockStart() {
    acc = 0;
    paused = false;
    markAt = Date.now();
  }

  function clockRead() {
    var t = acc;
    if (!paused && markAt) t += (Date.now() - markAt);
    return t;
  }

  function onVis() {
    try {
      if (idx < 0) return;
      if (D().hidden) {
        if (!paused) { acc += (Date.now() - markAt); paused = true; }
        /* The tab went away. If it never comes back this is the last thing we
           will know, so the screen is left here rather than never. */
        leave("away");
      } else if (paused) {
        paused = false;
        markAt = Date.now();
      }
    } catch (e) {}
  }

  function onHide() {
    try { if (idx >= 0) leave("away"); } catch (e) {}
  }

  /* leave() is idempotent per commit: a screen ends once. pagehide followed
     by visibilitychange is two signals for one departure and must not be two
     events. */
  var leftThisScreen = false;

  function leave(why) {
    if (idx < 0 || !committed || leftThisScreen) return;
    leftThisScreen = true;
    emitLeave(screenAt(idx), why, clockRead());
  }

  /* ======================================================================
     History. Best effort by design — ONBOARDING-ANALYTICS.md §2 is explicit
     that the in-app browsers this audience uses frequently do not call our
     code at all. Everything here degrades to nothing rather than to a broken
     flow, and the rendered Back control is the one that is exact.
     ====================================================================== */

  var popBound = false;

  function markHistory(replace) {
    try {
      if (!window.history || !history.pushState) return;
      var st = { fbob: 1, i: idx };
      if (replace) history.replaceState(st, "");
      else history.pushState(st, "");
    } catch (e) {}
  }

  function onPop(ev) {
    if (idx < 0) return;
    var st = null;
    try { st = ev && ev.state; } catch (e) {}
    if (st && st.fbob) {
      var to = typeof st.i === "number" ? st.i : 0;
      if (to < 0) to = 0;
      if (to > FLOW.length - 1) to = FLOW.length - 1;
      if (to === idx) return;
      leave(to < idx ? "back" : "forward");
      show(to, false);
      return;
    }
    /* Not ours. The reader has stepped out of the flow entirely. It cannot be
       prevented and must not be. */
    leave("exit_back");
    var why = "exit_back";
    teardown();
    try { if (typeof opts.onExit === "function") opts.onExit(why); } catch (e2) {}
  }

  function bindGlobals() {
    if (popBound) return;
    try {
      window.addEventListener("popstate", onPop, false);
      D().addEventListener("visibilitychange", onVis, false);
      window.addEventListener("pagehide", onHide, false);
      /* No unload and no beforeunload, ever: either one disqualifies every
         page on this site from the back/forward cache, which js/gate.js
         depends on, and tools/check-analytics.js fails the build on one. */
      popBound = true;
    } catch (e) {}
  }

  function unbindGlobals() {
    if (!popBound) return;
    try {
      window.removeEventListener("popstate", onPop, false);
      D().removeEventListener("visibilitychange", onVis, false);
      window.removeEventListener("pagehide", onHide, false);
    } catch (e) {}
    popBound = false;
  }

  /* ======================================================================
     Timers.
     ====================================================================== */

  function clearTimers() {
    try { if (loadTimer) { clearInterval(loadTimer); loadTimer = 0; } } catch (e) {}
    try { if (affirmTimer) { clearTimeout(affirmTimer); affirmTimer = 0; } } catch (e2) {}
    try {
      if (rafId && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
    } catch (e3) {}
    rafId = 0;
  }

  /* ======================================================================
     Skips. One branch, and it is the mockup's: the second interstitial has
     nothing to acknowledge when nothing was picked, so it is skipped rather
     than padded with a variant that says nothing.
     ====================================================================== */

  function skipped(i) {
    var id = FLOW[i];
    /* Caught by the harness, and it is the mockup's own rule rather than a
       new one: an interstitial exists to acknowledge an answer, so with no
       answer it has nothing to say. Before this, skipping the draw question
       showed the reader the "people" variant of a branch they never picked —
       a screen telling them what pulls them into history when they had just
       declined to say. Both branch screens now stand down the same way, and
       an unanswered question costs one screen rather than one lie. */
    if (id === "affirm_draw")   return !getDraw();
    if (id === "affirm_relate") return getRelates().length === 0;
    return false;
  }

  function nextIndex(i) {
    var j = i + 1;
    while (j < FLOW.length && skipped(j)) j++;
    return j >= FLOW.length ? FLOW.length - 1 : j;
  }

  function prevIndex(i) {
    var j = i - 1;
    while (j > 0 && skipped(j)) j--;
    return j < 0 ? 0 : j;
  }

  /* ======================================================================
     Moving.
     ====================================================================== */

  function advance(why) {
    if (idx < 0) return;
    leave(why || "forward");
    var to = nextIndex(idx);
    if (to === idx) { finish(); return; }
    show(to, true);
  }

  function goBack() {
    if (idx < 0) return;
    leave("back");
    if (idx === 0) {
      teardown();
      try { if (typeof opts.onExit === "function") opts.onExit("back"); } catch (e) {}
      return;
    }
    show(prevIndex(idx), false);
  }

  function finish() {
    var A = fba();
    try { if (A && A.finishOnboarding) A.finishOnboarding(); } catch (e) {}
    var rec = readRun() || {};
    rec.i = FLOW.length - 1;
    rec.d = 1;
    stampRun(rec);
    var sum = summary();
    teardown();
    try { if (typeof opts.onDone === "function") opts.onDone(sum); } catch (e2) {}
  }

  function summary() {
    var picks = getGenres();
    var F = fbfit();
    var ranked = [];
    try { if (F && F.rank) ranked = F.rank(picks, stacks); } catch (e) {}
    return {
      run: run,
      state: runState,
      from: from,
      complete: true,
      screens: FLOW.length,
      answers: {
        draw:    getDraw(),
        relates: getRelates(),
        genres:  picks,
        goal:    getGoal(),
        streak:  getStreak(),
        story:   getStory(),
        plan:    getPlans()
      },
      ranked: ranked
    };
  }

  /* ======================================================================
     show(i, push) — render screen i and commit it.

     The commit is one animation frame after the render, because a screen that
     was replaced inside the same frame was never on the display and must not
     produce an ob_step. Where there is no rAF the frame is a timeout, and
     where there is neither the commit is synchronous — measuring nothing is
     worse than measuring it a millisecond early.
     ====================================================================== */

  function show(i, push) {
    if (!host) return;
    clearTimers();
    idx = i;
    committed = false;
    leftThisScreen = false;
    loadPct = 0;
    interruptAt = -1;
    interruptsDone = 0;

    render();
    stampRun(null);
    markHistory(!push);

    pending = i;
    var fire = function () {
      rafId = 0;
      if (idx !== pending) return;             /* replaced inside the frame */
      committed = true;
      clockStart();
      emitStep(screenAt(idx));
      afterCommit();
    };
    try {
      if (window.requestAnimationFrame) rafId = window.requestAnimationFrame(fire);
      else rafId = setTimeout(fire, 16);
    } catch (e) { fire(); }
  }

  /* Things that must not start until the screen is really on the display:
     the loader's clock, and the first interstitial's auto-release. */
  function afterCommit() {
    var id = FLOW[idx];
    if (id === "building") startLoader();
    if (id === "affirm_draw" && opts.autoAffirm !== false) {
      /* The mockup releases this one after 1.5s: it has one job, which is to
         acknowledge the answer. The second interstitial keeps its tap, being
         the strongest screen in the flow. */
      try {
        affirmTimer = setTimeout(function () {
          affirmTimer = 0;
          if (FLOW[idx] === "affirm_draw") advance("forward");
        }, 1500);
      } catch (e) {}
    }
    if (id === TERMINUS) emitDone(screenAt(idx));
  }

  /* ======================================================================
     Rendering.
     ====================================================================== */

  function render() {
    var id = FLOW[idx];
    while (host.firstChild) host.removeChild(host.firstChild);

    var root = el("div", "fbob");
    root.setAttribute("data-step", id);

    root.appendChild(chrome());

    var body = el("div", "ob-body");
    root.appendChild(body);

    var foot = el("div", "ob-foot");
    root.appendChild(foot);

    if (id === "welcome")       screenWelcome(body, foot);
    else if (id === "q_draw")   screenSingle(body, foot, "draw", "What pulls you into a history story?", "", DRAW_OPTS, getDraw(), setDraw);
    else if (id === "affirm_draw")   screenAffirm(body, foot, AFFIRM_DRAW[getDraw() || "people"] || AFFIRM_DRAW.people);
    else if (id === "q_relate") screenRelate(body, foot);
    else if (id === "affirm_relate") screenAffirm(body, foot, has(getRelates(), "stories") ? AFFIRM_RELATE.stories : AFFIRM_RELATE.other);
    else if (id === "q_genres") screenGenres(body, foot);
    else if (id === "q_time")   screenNumber(body, foot, "goal", "How long should one Factbox take?", TIME_OPTS, getGoal(), setGoalAnswer);
    else if (id === "q_streak") screenNumber(body, foot, "streak", "How many days in a row do you want to aim for?", STREAK_OPTS, getStreak(), setStreakAnswer);
    else if (id === "pick_story") screenPick(body, foot);
    else if (id === "building")   screenBuilding(body, foot);
    else if (id === "results")    screenResults(body, foot);

    host.appendChild(root);
  }

  /* ---- chrome: Back, and the phase bar over the question screens --------- */

  function chrome() {
    var top = el("div", "ob-top");

    var back = btn("ob-back", "Back", function () { goBack(); });
    back.setAttribute("aria-label", "Back");
    top.appendChild(back);

    var id = FLOW[idx];
    var at = -1;
    for (var i = 0; i < QSTEPS.length; i++) { if (QSTEPS[i] === id) at = i; }

    var bar = el("div", "ob-phases");
    if (at < 0) bar.className = "ob-phases is-off";
    for (var p = 0; p < PHASES.length; p++) {
      var ph = PHASES[p];
      var lo = QSTEPS.length, hi = -1, q;
      for (q = 0; q < QSTEPS.length; q++) {
        if (has(ph.keys, QSTEPS[q])) { if (q < lo) lo = q; if (q > hi) hi = q; }
      }
      var span = (hi - lo + 1) || 1;
      var pct = at > hi ? 100 : (at < lo ? 0 : Math.round((at - lo + 1) / span * 100));
      var seg = el("div", "ob-phase" + (at >= lo && at <= hi ? " is-on" : ""));
      var track = el("div", "ob-track");
      var fill = el("i", "ob-fill");
      fill.style.width = pct + "%";
      track.appendChild(fill);
      seg.appendChild(track);
      seg.appendChild(el("p", "ob-plabel", ph.label));
      bar.appendChild(seg);
    }
    top.appendChild(bar);
    return top;
  }

  function heads(body, head, sub) {
    body.appendChild(el("h2", "ob-head", head));
    if (sub) body.appendChild(el("p", "ob-sub", sub));
  }

  function cta(foot, label, on, fn) {
    var b = btn("ob-cta" + (on ? "" : " is-off"), label, function () {
      if (on) fn();
    });
    if (!on) b.setAttribute("aria-disabled", "true");
    foot.appendChild(b);
    return b;
  }

  /* Skip clears the answer. A skipped step must be indistinguishable from one
     never reached, or a later screen reads back something the reader never
     said — which is js/account.js's own rule for its setters. */
  function skipBtn(foot, clear) {
    var b = btn("ob-skip", "Skip", function () {
      try { if (clear) clear(); } catch (e) {}
      advance("skip");
    });
    foot.appendChild(b);
    return b;
  }

  /* ---- 1 · welcome ------------------------------------------------------ */

  function screenWelcome(body, foot) {
    body.appendChild(art("s20", "ob-hero"));
    heads(body, "Know the stories everyone should know.",
          "Trade five minutes of scrolling for history you’ll actually remember.");
    body.appendChild(el("p", "ob-fine",
      "Six questions. Nothing to fill in, nothing to sign up for yet."));
    cta(foot, "Get started", true, function () { advance("forward"); });
  }

  /* ---- 2 · a single-select question ------------------------------------- */

  function setDraw(k) {
    var A = fba();
    try { if (A && A.setDraw) A.setDraw(k); } catch (e) {}
  }

  function screenSingle(body, foot, q, head, hint, list, cur, put) {
    heads(body, head, hint);
    var wrap = el("div", "ob-opts");
    var i;
    for (i = 0; i < list.length; i++) {
      (function (o) {
        var on = cur === o.k;
        var b = btn("ob-opt" + (on ? " is-on" : ""), null, function () {
          put(o.k);
          emitAnswer(screenAt(idx), q, o.k);
          stampRun(null);
          advance("forward");
        });
        b.setAttribute("data-k", o.k);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.appendChild(el("span", "ob-b", o.b));
        b.appendChild(tick());
        wrap.appendChild(b);
      })(list[i]);
    }
    body.appendChild(wrap);
    skipBtn(foot, function () { put(""); });
  }

  /* ---- 3 · an interstitial ---------------------------------------------- */

  function screenAffirm(body, foot, pair) {
    var p = pair || ["", ""];
    body.appendChild(el("p", "ob-eyebrow", "Noted"));
    heads(body, p[0], p[1]);
    cta(foot, "Continue", true, function () { advance("forward"); });
  }

  /* ---- 4 · the multi-select ---------------------------------------------- */

  function screenRelate(body, foot) {
    var cur = getRelates();
    heads(body, "Which of these sounds like you?",
          "Pick any that fit. If none of them do, skip it.");
    var wrap = el("div", "ob-opts");
    var i;
    for (i = 0; i < RELATE_OPTS.length; i++) {
      (function (o) {
        var on = has(cur, o.k);
        var b = btn("ob-opt" + (on ? " is-on" : ""), null, function () {
          var list = getRelates(), at = -1, j;
          for (j = 0; j < list.length; j++) { if (list[j] === o.k) at = j; }
          if (at > -1) list.splice(at, 1); else list.push(o.k);
          var A = fba();
          try { if (A && A.setRelates) A.setRelates(list); } catch (e) {}
          stampRun(null);
          render();
        });
        b.setAttribute("data-k", o.k);
        b.setAttribute("role", "checkbox");
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.appendChild(el("span", "ob-b", o.b));
        b.appendChild(tick("ob-tick is-sq"));
        wrap.appendChild(b);
      })(RELATE_OPTS[i]);
    }
    body.appendChild(wrap);
    cta(foot, "Continue", true, function () {
      var list = getRelates();
      /* Sorted and joined with the pipe gaParams() already uses for arrays,
         so a multi-select is one value and one row rather than three. */
      emitAnswer(screenAt(idx), "relates", list.slice(0).sort().join("|"));
      advance("forward");
    });
  }

  /* ---- 6 · the genre pick. The one answer that drives anything. ---------- */

  function screenGenres(body, foot) {
    var F = fbfit();
    var cur = getGenres();
    var list = genreList();
    heads(body, "What kind of stories pull you in?",
          "Pick two or three. This is what sets the order of your feed.");
    var wrap = el("div", "ob-opts ob-grid");
    var i;
    for (i = 0; i < list.length; i++) {
      (function (g) {
        var on = has(cur, g.key);
        var b = btn("ob-opt ob-gopt" + (on ? " is-on" : ""), null, function () {
          var picks = getGenres(), at = -1, j;
          for (j = 0; j < picks.length; j++) { if (picks[j] === g.key) at = j; }
          if (at > -1) picks.splice(at, 1);
          else if (picks.length < GENRE_MAX) picks.push(g.key);
          else return;                       /* three is the ceiling */
          var A = fba();
          try { if (A && A.setInterests) A.setInterests(picks); } catch (e) {}
          stampRun(null);
          render();
        });
        b.setAttribute("data-k", g.key);
        b.setAttribute("role", "checkbox");
        b.setAttribute("aria-checked", on ? "true" : "false");
        if (g.cover) b.appendChild(art(coverImg(g.cover), "ob-tile"));
        var txt = el("span", "ob-btext");
        txt.appendChild(el("span", "ob-b", g.label));
        if (g.blurb) txt.appendChild(el("span", "ob-blurb", g.blurb));
        b.appendChild(txt);
        b.appendChild(tick("ob-tick is-sq"));
        wrap.appendChild(b);
      })(list[i]);
    }
    body.appendChild(wrap);

    /* Not decoration. FBFIT's own header calls this the sentence that makes
       the personalization honest rather than a cheque the catalogue cannot
       cash, and says a template that drops it is overclaiming. */
    var disc = "";
    try { disc = F && F.disclosure ? F.disclosure() : ""; } catch (e2) {}
    if (disc) body.appendChild(el("p", "ob-fine", disc));

    var ready = cur.length >= GENRE_MIN;
    cta(foot, ready ? "Continue" : "Pick two", ready, function () {
      emitAnswer(screenAt(idx), "genres", getGenres().slice(0).sort().join("|"));
      advance("forward");
    });
  }

  function coverImg(id) {
    var s = stackById(str(id));
    return (s && s.img) ? s.img : ("s" + str(id));
  }

  /* ---- 7, 8 · the two number questions ---------------------------------- */

  function setGoalAnswer(v) {
    var A = fba();
    try { if (A && A.setGoal) A.setGoal(v); } catch (e) {}
  }

  function setStreakAnswer(v) {
    var A = fba();
    try { if (A && A.setStreak) A.setStreak(v); } catch (e) {}
  }

  function screenNumber(body, foot, q, head, list, cur, put) {
    heads(body, head, "");
    var wrap = el("div", "ob-opts");
    var i;
    for (i = 0; i < list.length; i++) {
      (function (o) {
        var on = cur === o.v;
        var b = btn("ob-opt" + (on ? " is-on" : ""), null, function () {
          put(o.v);
          /* The key, not the number: "auto" is a real answer and 0 is the
             store's word for "never asked". Sending 0 for both would make
             them the same row. */
          emitAnswer(screenAt(idx), q, o.k);
          stampRun(null);
          advance("forward");
        });
        b.setAttribute("data-k", o.k);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.appendChild(el("span", "ob-b", o.b));
        b.appendChild(tick());
        wrap.appendChild(b);
      })(list[i]);
    }
    body.appendChild(wrap);
    skipBtn(foot, function () { put(0); });
  }

  /* ---- 9 · which would you click first ---------------------------------- */

  function stackById(id) {
    try {
      var list = stacks;
      if (list && !(typeof list.length === "number") && list.stacks) list = list.stacks;
      if (!list || typeof list.length !== "number") return null;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
    } catch (e) {}
    return null;
  }

  function screenPick(body, foot) {
    var cur = getStory();
    heads(body, "Which one would you click first?",
          "There is no wrong answer. It tells us what a good hook looks like to you.");
    var grid = el("div", "ob-covers");
    var i;
    for (i = 0; i < COVERS.length; i++) {
      (function (c) {
        var s = stackById(c.id);
        var on = cur === c.id;
        var b = btn("ob-cover" + (on ? " is-on" : ""), null, function () {
          setStory(c.id);
          emitAnswer(screenAt(idx), "story", c.id);
          advance("forward");
        });
        b.setAttribute("data-k", c.id);
        b.appendChild(art((s && s.img) ? s.img : c.img, "ob-covart"));
        var cap = el("div", "ob-cap");
        cap.appendChild(el("span", "ob-who", c.who));
        cap.appendChild(el("span", "ob-chead", c.head));
        b.appendChild(cap);
        b.appendChild(tick("ob-tick is-mark"));
        grid.appendChild(b);
      })(COVERS[i]);
    }
    body.appendChild(grid);
    skipBtn(foot, null);
  }

  /* ---- 10 · the loader that interrupts itself ---------------------------
     Dead time turned into commitment. The bar runs on one interval; at two
     points it stops and asks something, and it does not resume until the
     reader answers. The questions are stored through FBA.addPlanAnswer and
     reported as ob_answer{q:"plan"} on step "building" — a value in the
     existing q dimension, not a fifth event name.
     --------------------------------------------------------------------- */

  function startLoader() {
    var ms = typeof opts.tickMs === "number" ? opts.tickMs : 320;
    try {
      loadTimer = setInterval(function () {
        if (interruptAt > -1) return;                   /* held on a question */
        if (loadPct >= 100) return;
        loadPct = Math.min(100, loadPct + 7);
        var nx = INTERRUPTS[interruptsDone];
        if (nx && loadPct >= nx.at) {
          interruptAt = interruptsDone;
        }
        paintLoader();
      }, ms);
    } catch (e) {}
    paintLoader();
  }

  function answerInterrupt(yes) {
    var A = fba();
    try { if (A && A.addPlanAnswer) A.addPlanAnswer(!!yes); } catch (e) {}
    emitAnswer(screenAt(idx), "plan", yes ? "yes" : "no",
               interruptsDone === 0 ? "plan_a" : "plan_b");
    interruptsDone++;
    interruptAt = -1;
    stampRun(null);
    paintLoader();
  }

  function screenBuilding(body, foot) {
    body.setAttribute("data-ob-load", "1");
    paintLoader();
  }

  /* Repaints the loader in place rather than re-rendering the screen, so the
     screen is never replaced and never produces a second ob_step. */
  function paintLoader() {
    if (FLOW[idx] !== "building" || !host) return;
    var body = host.querySelector(".ob-body");
    var foot = host.querySelector(".ob-foot");
    if (!body || !foot) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    while (foot.firstChild) foot.removeChild(foot.firstChild);

    var F = fbfit();
    var picks = getGenres();
    var copy = null;
    try { copy = F && F.copyFor ? F.copyFor(picks) : null; } catch (e) {}

    if (interruptAt > -1) {
      var q = INTERRUPTS[interruptAt];
      body.appendChild(el("p", "ob-eyebrow", "One moment —"));
      heads(body, q.head, q.sub);
      var pair = el("div", "ob-yn");
      pair.appendChild(btn("ob-opt ob-ynb", YES, function () { answerInterrupt(true); }));
      pair.appendChild(btn("ob-opt ob-ynb", NO, function () { answerInterrupt(false); }));
      var kids = pair.childNodes;
      kids[0].setAttribute("data-k", "yes");
      kids[1].setAttribute("data-k", "no");
      body.appendChild(pair);
      return;
    }

    body.appendChild(el("p", "ob-eyebrow", "Building your feed"));
    heads(body, copy ? copy.loaderHead : "Putting your stories in order.",
          copy ? copy.loaderSub : "");

    var track = el("div", "ob-loadtrack");
    var fill = el("i", "ob-loadfill");
    fill.style.width = loadPct + "%";
    track.appendChild(fill);
    body.appendChild(track);
    var pctLine = el("p", "ob-pct", loadPct + "%");
    pctLine.setAttribute("role", "status");
    body.appendChild(pctLine);

    var ul = el("ul", "ob-ticks");
    var i;
    for (i = 0; i < picks.length; i++) {
      var shownAt = (i + 1) * (100 / (picks.length + 1));
      var li = el("li", "ob-tickrow" + (loadPct >= shownAt ? " is-on" : ""));
      li.appendChild(tick("ob-tick is-round"));
      li.appendChild(el("span", "ob-b", labelOf(picks[i])));
      ul.appendChild(li);
    }
    body.appendChild(ul);

    var done = loadPct >= 100;
    cta(foot, done ? "See my stories" : "Building…", done, function () {
      advance("forward");
    });
  }

  function labelOf(key) {
    var F = fbfit();
    try { if (F && F.labelOf) return F.labelOf(key); } catch (e) {}
    return str(key);
  }

  /* ---- 11 · the payoff --------------------------------------------------- */

  function mins(secs) {
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "½ min";
    return whole + (halves % 2 ? "½" : "") + " min";
  }

  function screenResults(body, foot) {
    var F = fbfit();
    var picks = getGenres();
    var goal = getGoal();
    var id = IDENTITY[String(goal)] || IDENTITY["0"];

    body.appendChild(el("p", "ob-eyebrow", "Your first stories are ready"));
    heads(body, id[0], id[1]);

    var ranked = [];
    try { if (F && F.rank) ranked = F.rank(picks, stacks); } catch (e) {}

    /* The story they said they would click first leads, if it is real. They
       told us; ignoring it on the very next screen would be the funnel asking
       a question it does not use. */
    var story = getStory();
    if (story) {
      var at = -1, j;
      for (j = 0; j < ranked.length; j++) { if (ranked[j] === story) at = j; }
      if (at > -1) ranked = [story].concat(ranked.slice(0, at)).concat(ranked.slice(at + 1));
    }

    var listEl = el("ul", "ob-cards");
    var shown = 0, i;
    for (i = 0; i < ranked.length && shown < 3; i++) {
      var s = stackById(ranked[i]);
      var li = el("li", "ob-card");
      li.appendChild(art(s && s.img ? s.img : ("s" + str(ranked[i])), "ob-cardart"));
      var txt = el("div", "ob-cardtext");
      txt.appendChild(el("p", "ob-cardhead", s && s.title ? s.title : ("Story " + str(ranked[i]))));
      if (s) {
        txt.appendChild(el("p", "ob-meta",
          (s.cards ? s.cards.length : 0) + " cards · " + mins(s.secs)));
      }
      li.appendChild(txt);
      listEl.appendChild(li);
      shown++;
    }
    body.appendChild(listEl);

    var copy = null;
    try { copy = F && F.copyFor ? F.copyFor(picks) : null; } catch (e2) {}
    if (copy && copy.labels) {
      body.appendChild(el("p", "ob-note", "Picked from " + copy.labels + "."));
    }
    /* Again, and for the same reason as on the genre grid. */
    if (copy && copy.disclosure) body.appendChild(el("p", "ob-fine", copy.disclosure));

    cta(foot, "Start reading", true, function () { advance("forward"); });
  }

  /* ======================================================================
     Mount, teardown, and the public API.
     ====================================================================== */

  function teardown() {
    clearTimers();
    unbindGlobals();
    idx = -1;
    committed = false;
    host = null;
  }

  /* Where a reader who abandoned comes back to.

     Two sources, in order. The run record is the exact one: it is written
     after every answer and it knows the screen. FBA is the fallback, because
     a reader can have answers and no run record — cleared storage, a second
     browser profile, a record older than seven days — and putting them back
     on screen one to re-answer questions the store already holds is the worst
     of the three options. */
  function fromAnswers() {
    if (getStreak()) return indexOfStep("pick_story");
    if (getGoal())   return indexOfStep("q_streak");
    if (getGenres().length) return indexOfStep("q_time");
    if (getRelates().length) return indexOfStep("q_genres");
    if (getDraw())   return indexOfStep("q_relate");
    return 0;
  }

  function resumeAt() {
    var A = fba();
    try { if (A && A.onboarded && A.onboarded()) return 0; } catch (e) {}
    var r = readRun();
    if (r && r.d) return 0;                       /* finished; start over */
    if (r && typeof r.i === "number" && r.t &&
        (Date.now() - r.t) < RESUME_MS &&
        r.i > 0 && r.i < FLOW.length) {
      return skipped(r.i) ? nextIndex(r.i - 1) : r.i;
    }
    var d = fromAnswers();
    return d > 0 && d < FLOW.length ? d : 0;
  }

  function progress() {
    return {
      step: idx < 0 ? 0 : idx,
      total: FLOW.length,
      complete: idx >= 0 ? FLOW[idx] === TERMINUS : !!(readRun() && readRun().d)
    };
  }

  function reset() {
    clearTimers();
    lsDel(RUN_KEY);
    run = "";
    seen = {};
    answered = {};
    slots = {};
    doneSent = false;
    runState = "fresh";
    firstStep = true;
    idx = -1;
    return true;
  }

  function mount(node, o) {
    if (!node || !D()) return false;
    if (host) teardown();

    opts = o || {};
    host = node;
    stacks = opts.stacks || null;
    page = opts.page ? str(opts.page) : pageName();
    from = opts.from && has(FROMS, opts.from) ? opts.from : fromParam();

    /* The resume decision, and the honest bookkeeping around it. Whether they
       accept their place back or start over, a NEW run is minted and the
       first ob_step carries state:"resume". The old run stays abandoned in
       the data, which is what it was. */
    var old = readRun();
    var at = typeof opts.startAt === "number" ? opts.startAt : resumeAt();
    if (at < 0) at = 0;
    if (at > FLOW.length - 1) at = FLOW.length - 1;
    while (at > 0 && skipped(at)) at--;

    var resumed = !!(old && !old.d && at > 0 &&
                     old.t && (Date.now() - old.t) < RESUME_MS);

    run = mint();
    runState = resumed ? "resume" : "fresh";
    firstStep = true;
    seen = {};
    answered = {};
    slots = {};
    doneSent = false;

    var rec = { v: 1, r: run, i: at, t: Date.now(), c: old && old.c ? old.c : "" };
    writeRun(rec);

    bindGlobals();
    idx = at;
    markHistory(true);
    show(at, false);
    return true;
  }

  return {
    VERSION: VERSION,

    /* the API */
    mount: mount,
    progress: progress,
    resumeAt: resumeAt,
    reset: reset,

    /* THE contract. STEPS is the declared screen list, in declared order, and
       it is the list functions/insights.js must carry a copy of. FLOW is the
       subset this engine renders; account and paywall are other surfaces. */
    STEPS: (function () {
      var out = [], i;
      for (i = 0; i < SCREENS.length; i++) out.push(SCREENS[i].id);
      return out;
    })(),
    SCREENS: SCREENS,
    FLOW: FLOW,
    TERMINUS: TERMINUS,

    /* for a check, and for a page that wants to say what it is about to ask */
    RUN_KEY: RUN_KEY,
    RESUME_MS: RESUME_MS,
    DWELL_CEIL: DWELL_CEIL,
    GENRE_MIN: GENRE_MIN,
    GENRE_MAX: GENRE_MAX,

    /* the current run id, for a page that wants to join its own event to it */
    run: function () { return run; }
  };
})();

if (typeof window !== "undefined") { window.FBOB = FBOB; }
if (typeof module !== "undefined" && module.exports) { module.exports = FBOB; }
