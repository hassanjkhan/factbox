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
   WHAT IT LOOKS LIKE: JOURNEY 3a, PORTED

   The screens are the Quiz Funnel mockup's journey 3a, ported rather than
   interpreted. The mockup draws inside a 390x844 phone and every block in it
   sits on an absolute offset against that frame, so css/onboard.css makes
   .fbob that frame and this file builds the blocks into it. The mockup's own
   numbers — 600px of hero, an interstitial's 430px of painting, the loader's
   cover at top:474 — are in the stylesheet, not here.

   THE FUNNEL IS CREAM. #E7E0D3 ground, #172E5B ink, #3B9EF4 fills. It is
   mounted on the reader, which css/reader-rail.css paints for night, so the
   stylesheet re-declares the paper palette at .fbob. There is no colour in
   THIS file: a screen that needed one would be a screen that could invert.

   FOUR THINGS THE MOCKUP DOES THAT THIS FILE NOW DOES TOO
     · Chrome — a back arrow, the wordmark and three phase bars — is on the
       QUESTIONS and nowhere else. The welcome, the interstitials, the loader
       and the payoff carry none.
     · Tapping an option selects it. Continue is what moves. That is why the
       CTA has a disabled state, and it is why there is no Skip: the mockup
       has none, and a question you cannot answer wrongly does not need one.
     · The loader is not a bar in a field of nothing. It names the genres and
       ticks them off, it runs a percentage, and it cycles a cover from the
       feed being built with dot indicators under it.
     · The payoff is three full-bleed plates with the story's own headline on
       them, out of data/index.json. See THE CATALOGUE below.

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
     welcome, the interstitials, the loader and the payoff are not work to get
     through and carry no chrome at all — which is how the mockup draws them.
     The story pick is the sixth thing asked and keeps the bar with every
     phase full; see chromeAt(). */
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
  /* Third entry is the story whose painting the screen is drawn on. The
     mockup called for four photographs under img/onboarding/ that this repo
     does not have; the season's own art is what it does have, and a plate the
     reader is about to meet in their feed is a better acknowledgement than a
     stock library interior would have been. */
  var AFFIRM_DRAW = {
    people: ["People are why any of it sticks.",
             "Factbox tells history through the people in it — their motives, their mistakes, and what it cost them.",
             "20"],
    turning: ["Let’s fill in the good parts.",
              "You know the basics. Factbox gives you the scandals, mysteries and details they usually leave out.",
              "50"],
    thread: ["You’re definitely not alone.",
             "History is hard to remember when it’s taught as dates and names. It’s much easier when it feels like a story.",
             "31"],
    tiktok: ["Good. We can skip the boring stuff.",
             "Factbox goes beyond the textbook into the details, controversies and rabbit holes worth knowing.",
             "41"]
  };

  /* Branch 2 — SCROLL, verbatim, including the skip. The mockup skips this
     screen outright rather than padding it with a variant that has nothing to
     say; here the empty answer is the one with nothing to acknowledge. */
  var AFFIRM_RELATE = {
    stories: ["Your scrolling isn’t the problem.",
              "What you’re scrolling is. Let’s make five minutes of it worth remembering.",
              "17"],
    other: ["Let’s make more of it stick.",
            "Five minutes is enough to learn one story you’ll still remember tomorrow.",
            "19"]
  };

  /* Branch 3 — IDENTITY, rekeyed onto the goal in minutes.

     NOT RENDERED, AND DELIBERATELY KEPT. The mockup gives this its own screen
     (is10) between the goal question and the loader. FLOW is the published
     contract — js/recommend.js reads it and functions/insights.js carries a
     copy of SCREENS — so a twelfth screen is not this file's to add, and the
     payoff screen it used to borrow is now the mockup's is12 word for word.
     The five variants stay here so that adding the screen is one render
     function and not a rewrite of the copy. */
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
    { at: 34, head: "Would you rather spend five minutes learning this…",
      sub: "…than scrolling through another 20 posts you’ll forget?",
      art: "20" },
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
  var loadCycle = 0;      /* which cover is showing, and which dot is long */
  var loadIds = null;     /* one story per picked genre; computed once */
  var interruptAt = -1;   /* index into INTERRUPTS while one is showing */
  var interruptsDone = 0;

  /* True for the first render of a screen and false for every repaint of it.
     The fade belongs to ARRIVING somewhere; running it again because a tick
     was ticked makes every answer flash the whole screen, which is not what
     the mockup does and is not what a tap should feel like. */
  var entering = false;

  /* the affirmation auto-release, and the beat the story pick holds for so
     its tick is seen before the screen changes */
  var affirmTimer = 0;
  var pickTimer = 0;

  /* ---- motion state. Presentation only; nothing below decides a screen. --
     tappedKey     the option key tapped in THIS synchronous render, so the row
                   that is about to be rebuilt can spring rather than snap.
     pickShown     which loader genre rows have already ticked, so a tick pops
                   the once it lights and not on every 320ms repaint.
     phasePrev     the phase percentages the last chrome drew, so the new one
                   can start there and travel rather than appear finished.
     loadMode      "run" or "ask", so the loader morphs its plate when it
                   swaps between the cover card and an interruption and NOT
                   on every cover cycle.
     ------------------------------------------------------------------- */
  var tappedKey = "";
  var pickShown = {};
  var phasePrev = null;
  var loadMode = "";
  var loadPctPrev = 0;

  /* ======================================================================
     THE MOTION SYSTEM.

     One rule decides whether any of it runs: prefers-reduced-motion. When it
     is set, motionOff() is true, every helper below returns the element it
     was handed untouched, and css/onboard.css kills the keyframes as well —
     so the reduced screen is not "the animation, faster", it is the final
     frame and nothing else.

     Two more rules, and they are the reason the code is shaped like this:

       · TRANSFORM AND OPACITY ONLY, with one exception the design asks for:
         the 6px blur a headline word resolves out of. The bars that used to
         transition `width` are scaleX() now. The audience is Instagram and
         TikTok webviews on mid-range phones and a paint-triggering funnel is
         a stuttering funnel.

       · NOTHING MAY STICK. Every keyframe ends at the resting state with
         fill-mode both, so an animation that is interrupted leaves a visible
         element; every transition that has cleanup hanging off transitionend
         ALSO has a timeout, because transitionend does not fire for a node
         that was detached mid-flight and a plate stuck at scale(8) is a blank
         screen to the reader.

     Nothing here is on the tap path. Options are rendered with their final
     hit area from the first frame; an element mid-fade is still tappable.
     ====================================================================== */

  var MORPH_MS = 520;
  var EASE = "cubic-bezier(.2,.75,.25,1)";

  function motionOff() {
    try {
      if (!window.matchMedia) return false;
      return !!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  }

  /* Marks an element for its entry animation, and ONLY on the render that
     first puts it on screen. enterNow is false for every repaint — a tick
     being ticked must not re-run the whole screen, and the loader repaints
     itself three times a second. The class is what CSS keys off; the delay is
     the stagger. */
  function enter(node, cls, delay) {
    if (!node) return node;
    if (!enterNow || motionOff()) return node;
    node.className = node.className ? node.className + " " + cls : cls;
    if (delay) { try { node.style.animationDelay = delay + "ms"; } catch (e) {} }
    return node;
  }

  /* A · THE WORD-BY-WORD HEADLINE.

     One heading element, one string, word spans inside it. The whitespace
     stays as real text nodes between the spans, so the line still wraps where
     the browser would have wrapped it and a word can never be broken across
     a line; the spans are inline-block, which is what stops the split from
     becoming a place to break. To a screen reader the heading's text is the
     same one string it was before — this restructures nothing above the word.

     When the screen is a repaint rather than an arrival the spans are still
     built, with no animation class, so the two renders lay out identically
     and a tap cannot shift the headline by a hair. */
  function headWords(tag, cls, text) {
    var h = el(tag, cls ? cls + " ob-words" : "ob-words");
    var t = str(text);
    if (!t) return h;
    var parts = t.split(/(\s+)/);
    var anim = enterNow && !motionOff();
    var n = 0, i, w;
    for (i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (/^\s+$/.test(parts[i])) {
        h.appendChild(D().createTextNode(parts[i]));
        continue;
      }
      w = el("span", anim ? "ob-w is-in" : "ob-w");
      w.appendChild(D().createTextNode(parts[i]));
      if (anim) { try { w.style.animationDelay = (n * 75) + "ms"; } catch (e) {} }
      h.appendChild(w);
      n++;
    }
    return h;
  }

  /* B · THE PERSISTING PLATE.

     The painting is the only thing on these eleven screens that is on more
     than one of them, so it is the thing that carries the reader between
     them: it does not cross-dissolve with a second plate, it TRAVELS.

     FLIP, and nothing cleverer. Measure the outgoing plate before the screen
     is torn down, render the new screen, measure the incoming plate, put the
     incoming one back where the outgoing one was with a transform, force the
     reflow that makes that start state real, and then release it to identity.
     One element moves. There is never a second plate on screen.

     WHAT TRAVELS IS THE CARD, NOT THE PICTURE INSIDE IT. This is the whole
     difference between a morph and a picture sliding around behind a hole
     that was already the right size: the thing carrying the reader's eye is
     the FRAME — the rounded, clipped box the painting sits in — so that is
     the element the transform goes on. The first version of this moved the
     image layer inside a card that was already at rest, and it read exactly
     as wrong as that sounds.

     THE CONTENT CORRECTION, which is the difference between a morph and a
     squash. A cover on the pick screen is 3:4.4 and the loader's card is
     nearly 3:2, so a plain FLIP would stretch the painting sideways for half
     a second on the way over. So the FRAME takes the full non-uniform scale —
     it is the window, and a window is what changes shape — while the plate
     inside it takes back the inverse of only the ASPECT half, leaving the
     painting scaled uniformly by max(sx,sy). Uniform means undistorted; the
     max means it always covers the window rather than letting the plate's
     dark ground show at an edge. What you see is a frame reshaping over a
     picture that only ever grows and shrinks, which is what a card opening
     looks like.

     The old painting rides along as a ghost <img> inside the same plate,
     under the same correction, fading out — so the artwork cross-fades while
     the frame travels. Everything ELSE the frame holds — the scrim, the
     headline over it, the tick — fades up over the trip rather than being
     dragged through the scale, because a caption stretched to half its width
     and back is the one part of this a reader would notice as a wobble.

     It falls back to nothing at all — the screen just arrives — when either
     plate is missing, either rect is empty, or the scale is far enough out of
     range that the morph would be a smear rather than a move. */

  var morphTimer = 0;
  var morphState = null;

  function morphDone() {
    try { if (morphTimer) { clearTimeout(morphTimer); morphTimer = 0; } } catch (e) {}
    var m = morphState;
    morphState = null;
    if (!m) return;
    try {
      if (m.plate && m.plate.removeEventListener) {
        m.plate.removeEventListener("transitionend", m.end, false);
      }
    } catch (e1) {}
    var i, n;
    for (i = 0; i < m.nodes.length; i++) {
      n = m.nodes[i];
      try {
        n.style.transition = "";
        n.style.transform = "";
        n.style.transformOrigin = "";
        n.style.willChange = "";
        /* the overlays were the only thing this ever set opacity on, and
           clearing it is what guarantees nothing is left invisible */
        n.style.opacity = "";
      } catch (e2) {}
    }
    try { if (m.ghost && m.ghost.parentNode) m.ghost.parentNode.removeChild(m.ghost); } catch (e3) {}
  }

  /* The one CARD on a screen that is the through-line, in priority order —
     the clipped, rounded box, not the image inside it. A selected cover beats
     an unselected one because the reader has just told us which picture they
     meant; the big art blocks beat the small tiles because a screen holding
     both is a screen whose subject is the big one. */
  var HERO = [".ob-cover.is-on",
              ".ob-w-art",
              ".ob-i-art",
              ".ob-demo",
              ".ob-covercard",
              ".ob-card",
              ".ob-cover",
              ".ob-tile"];

  function heroFrame(root) {
    if (!root || !root.querySelector) return null;
    var i, n;
    for (i = 0; i < HERO.length; i++) {
      try { n = root.querySelector(HERO[i]); } catch (e) { n = null; }
      if (n && n.querySelector && n.querySelector(".ob-plate img")) return n;
    }
    return null;
  }

  function grabHero(root) {
    if (motionOff()) return null;
    var f = heroFrame(root);
    if (!f) return null;
    var r = null;
    try { r = f.getBoundingClientRect(); } catch (e) { return null; }
    if (!r || !(r.width > 1) || !(r.height > 1)) return null;
    var im = null;
    try { im = f.querySelector(".ob-plate img"); } catch (e2) {}
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             src: (im && im.src) ? im.src : "" };
  }

  function runMorph(from, root) {
    morphDone();
    if (!from || motionOff() || !host) return false;
    var p = heroFrame(root);
    if (!p) return false;
    var r = null;
    try { r = p.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || !(r.width > 1) || !(r.height > 1)) return false;

    var sx = from.w / r.width, sy = from.h / r.height;
    var dx = from.x - r.left, dy = from.y - r.top;
    if (!isFinite(sx) || !isFinite(sy) || !isFinite(dx) || !isFinite(dy)) return false;
    if (!(sx > 0.03) || !(sy > 0.03) || sx > 24 || sy > 24) return false;
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5 &&
        Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02) return false;

    /* The travelling plate must be OPAQUE for the whole trip. Anything above
       it that was going to fade or deal itself in stands down — the first
       results card is the card that arrived by morphing, and the two under it
       still deal in behind it. The screen's own arrival fade goes too. */
    var a = p, cn;
    while (a && a !== host && a.nodeType === 1) {
      cn = a.className ? String(a.className) : "";
      if (cn.indexOf("ob-in") > -1) {
        a.className = cn.replace(/ob-in[a-z-]*/g, "");
        try { a.style.animation = "none"; a.style.opacity = "1"; } catch (e2) {}
      }
      if (cn.indexOf("ob-screen") > -1 && cn.indexOf("is-morph") < 0) {
        a.className = a.className + " is-morph";
      }
      a = a.parentNode;
    }

    /* the plate is the picture layer; everything else the frame holds is an
       overlay that fades up rather than being dragged through the scale */
    var plate = null;
    try { plate = p.querySelector(".ob-plate"); } catch (ep) {}
    var nodes = [p], over = [], i, k, kn = p.childNodes;
    for (i = 0; i < kn.length; i++) {
      if (kn[i].nodeType === 1 && kn[i] !== plate) over.push(kn[i]);
    }

    var ghost = null;
    if (from.src && plate) {
      ghost = D().createElement("img");
      ghost.className = "ob-ghostplate";
      ghost.alt = "";
      ghost.setAttribute("aria-hidden", "true");
      ghost.src = from.src;
      plate.appendChild(ghost);
    }

    /* the aspect-only inverse: uniform max(sx,sy) on the picture */
    var kmax = sx > sy ? sx : sy;
    var cx = kmax / sx, cy = kmax / sy;

    p.style.transformOrigin = "0 0";
    p.style.willChange = "transform";
    p.style.transition = "none";
    p.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")";
    if (plate) {
      nodes.push(plate);
      plate.style.transformOrigin = "50% 50%";
      plate.style.willChange = "transform";
      plate.style.transition = "none";
      plate.style.transform = "scale(" + cx + "," + cy + ")";
    }
    for (i = 0; i < over.length; i++) {
      k = over[i];
      nodes.push(k);
      k.style.willChange = "opacity";
      k.style.transition = "none";
      k.style.opacity = "0";
    }
    if (ghost) ghost.style.opacity = "1";

    /* the reflow that makes the start state a real frame rather than a value
       the browser is free to coalesce away */
    var flush = 0;
    try { flush = p.offsetWidth; } catch (e3) {}
    if (flush < 0) return false;

    var tr = "transform " + MORPH_MS + "ms " + EASE;
    var op = "opacity " + MORPH_MS + "ms " + EASE;
    p.style.transition = tr;
    p.style.transform = "translate(0px,0px) scale(1,1)";
    if (plate) {
      plate.style.transition = tr;
      plate.style.transform = "scale(1,1)";
    }
    for (i = 0; i < over.length; i++) {
      over[i].style.transition = op;
      over[i].style.opacity = "1";
    }
    if (ghost) {
      ghost.style.transition = op;
      ghost.style.opacity = "0";
    }

    var end = function () { morphDone(); };
    morphState = { plate: p, nodes: nodes, ghost: ghost, end: end };
    try { p.addEventListener("transitionend", end, false); } catch (e4) {}
    /* the fallback that matters: a node torn down mid-flight never fires
       transitionend, and the cleanup must still run */
    try { morphTimer = setTimeout(end, MORPH_MS + 180); } catch (e5) {}
    return true;
  }

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

  /* ======================================================================
     Reading the answers back out of FBA. Every screen renders from the store
     rather than from a local copy, which is what makes Back and resume the
     same code path: there is one source of truth and it survives a refresh.
     ====================================================================== */

  function getDraw()    { var A = fba(); try { return A ? A.draw() : ""; } catch (e) { return ""; } }
  function getRelates() { var A = fba(); try { return A ? A.relates() : []; } catch (e) { return []; } }
  /* Only keys FBFIT actually knows.

     FBA.interests() is a general-purpose field: it predates this funnel and
     has been written with stacks.json TOPIC keys ("cleopatra", "disaster") by
     older code and by anyone whose browser still carries a record from then.
     FBFIT.labelOf() returns its argument unchanged when it does not recognise
     it, so those went to the screen raw — the loader told the owner it was
     prioritising "cleopatra" and "disaster", in lower case, next to two
     properly-titled genres.

     Filtering here rather than at the label means every consumer of this —
     the loader rows, the ranking, the results note — sees the same clean set,
     and a stale record degrades to fewer genres rather than to nonsense. */
  function knownGenre(k) {
    var F = fbfit(), i, list;
    try {
      list = F && F.GENRES;
      if (!list || !list.length) return true;   /* no map loaded: do not filter */
      for (i = 0; i < list.length; i++) if (list[i].key === k) return true;
    } catch (e) { return true; }
    return false;
  }

  function getGenres() {
    var A = fba(), raw, out = [], i;
    try { raw = A ? A.interests() : []; } catch (e) { raw = []; }
    if (!raw || !raw.length) return [];
    for (i = 0; i < raw.length; i++) {
      if (knownGenre(raw[i])) out.push(raw[i]);
    }
    return out;
  }
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

  /* ======================================================================
     The events.
     ====================================================================== */

  /* WHICH BUILD THIS SCREEN WAS DRAWN BY.

     js/analytics.js's RELEASE constant, read through FBQ rather than copied,
     because a second literal is a release id that is right until somebody
     bumps one of them. Returns "" when analytics never loaded or the reader
     opted out — in which case nothing is being sent anyway.

     `release` is NOT a new property name. analytics.js has put it on
     client_error since before this file existed, so GA4 has it registered
     already and this costs none of the twenty-two remaining registrations.
     It is here, and on no other ob_ event, because it is a fact about the
     RUN and every event of a run has an ob_step in front of it. */
  function rel() {
    try {
      var r = window.FBQ && FBQ.RELEASE;
      return typeof r === "string" ? r : "";
    } catch (e) { return ""; }
  }

  function emitStep(sc) {
    track("ob_step", {
      page:  page,
      step:  sc.id,
      kind:  sc.kind,
      n:     sc.n,
      run:   run,
      state: firstStep ? runState : "fresh",
      from:  from,
      release: rel()
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
    morphDone();
    try { if (loadTimer) { clearInterval(loadTimer); loadTimer = 0; } } catch (e) {}
    try { if (affirmTimer) { clearTimeout(affirmTimer); affirmTimer = 0; } } catch (e2) {}
    try { if (pickTimer) { clearTimeout(pickTimer); pickTimer = 0; } } catch (e2b) {}
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
    /* B · the outgoing plate, measured while it is still on the display.
       After render() there is nothing left to measure. */
    var came = grabHero(host);
    idx = i;
    committed = false;
    leftThisScreen = false;
    loadPct = 0;
    loadCycle = 0;
    loadIds = null;
    interruptAt = -1;
    interruptsDone = 0;
    entering = true;
    pickShown = {};
    loadMode = "";
    loadPctPrev = 0;

    render();
    runMorph(came, host);
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
     THE CATALOGUE, AND WHY THIS FILE LOADS IT ITSELF.

     Every title and every painting on the last three screens comes out of
     data/index.json. The caller passes it as opts.stacks — js/recommend.js
     kicks FB.loadIndex() off when the sheet is BUILT so the tap never waits
     on a fetch — but the caller is allowed not to, and for a while it did
     not, which is how the payoff screen shipped reading "Story 50" instead
     of "The Ides of March". A catalogue id is not a headline and must never
     reach the display as one.

     So the engine asks for the index itself the moment it mounts, and takes
     whichever answer arrives. FB.loadIndex() is the right door: it is cached
     in js/gate.js and read.html has usually already opened it. A direct
     fetch is the fallback for a page that never loaded gate.js at all.

     When the catalogue lands late, the screen that wanted it is repainted —
     render() only builds DOM, so a repaint costs nothing in the funnel and
     emits no second ob_step.
     ====================================================================== */

  var stacksLoading = false;

  function normStacks(v) {
    if (!v) return null;
    if (typeof v.length === "number") return v.length ? v : null;
    if (v.stacks && typeof v.stacks.length === "number" && v.stacks.length) {
      return v.stacks;
    }
    return null;
  }

  function haveStacks() { return !!(stacks && stacks.length); }

  function adoptStacks(list) {
    var got = normStacks(list);
    if (!got) return;
    stacks = got;
    loadIds = null;
    if (idx < 0 || !host) return;
    if (FLOW[idx] === "building") { paintLoader(); return; }
    render();
  }

  function loadStacks() {
    if (haveStacks() || stacksLoading) return;
    stacksLoading = true;
    var ok = function (list) { stacksLoading = false; adoptStacks(list); };
    var no = function () { stacksLoading = false; };
    try {
      if (window.FB && typeof FB.loadIndex === "function") {
        FB.loadIndex().then(ok, no);
        return;
      }
    } catch (e) {}
    try {
      if (typeof window.fetch === "function") {
        window.fetch("/data/index.json", { cache: "force-cache" })
          .then(function (r) {
            if (!r || !r.ok) throw new Error("HTTP");
            return r.json();
          })
          .then(function (d) { ok(d && d.stacks ? d.stacks : d); }, no);
        return;
      }
    } catch (e2) {}
    stacksLoading = false;
  }

  function stackById(id) {
    try {
      var list = normStacks(stacks);
      if (!list) return null;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
    } catch (e) {}
    return null;
  }

  /* The image name for a story. The catalogue carries it; without the
     catalogue it is the id lowercased, which is how js/personalize.js does it
     and the only reason "07B" resolves to s07b.webp. */
  function imgFor(id) {
    var s = stackById(id);
    if (s && s.img) return str(s.img);
    return "s" + str(id).toLowerCase();
  }

  function titleOf(id) {
    var s = stackById(id);
    return (s && s.title) ? str(s.title) : "";
  }

  /* ======================================================================
     Rendering. A port of journey 3a of the Quiz Funnel mockup: the frame is
     390x844 and every block below sits on the offset the mockup gave it.
     ====================================================================== */

  function logoImg() {
    var im = D().createElement("img");
    im.src = "/img/logo-96.png";
    im.alt = "";
    im.width = 22;
    im.height = 22;
    return im;
  }

  /* A painting. A <span> rather than a <div> because half of these live
     inside a <button>. data-fallback is the second file to try: the thumbs
     and the stacks directories carry the same picture at two sizes and a
     404 in either must cost a slower plate, never a hole. */
  function plate(cls, src, fallback) {
    var box = el("span", "ob-plate" + (cls ? " " + cls : ""));
    box.setAttribute("aria-hidden", "true");
    var im = D().createElement("img");
    im.alt = "";
    im.decoding = "async";
    if (fallback) im.setAttribute("data-fallback", fallback);
    im.onerror = function () {
      this.onerror = null;                       /* one retry, never a loop */
      var f = this.getAttribute("data-fallback");
      if (f) this.src = f;
    };
    im.src = src;
    box.appendChild(im);
    return box;
  }

  function smallPlate(id, cls) {
    var n = imgFor(id);
    return plate(cls, "/img/thumbs/" + n + ".webp", "/img/stacks/" + n + ".webp");
  }

  function bigPlate(id, cls) {
    var n = imgFor(id);
    return plate(cls, "/img/stacks/" + n + ".webp", "/img/thumbs/" + n + ".webp");
  }

  function scrim(cls) {
    var s = el("span", "ob-scrim" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  function glyph(cls) {
    var i = el("i", cls, "✓");
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  function cta(label, on, fn) {
    var b = btn("ob-cta" + (on ? "" : " is-off"), label, function () {
      if (on) fn();
    });
    if (!on) b.setAttribute("aria-disabled", "true");
    return b;
  }

  /* "ob-screen" plus the entry animation, and only on arrival. */
  var enterNow = false;
  function screenCls() { return "ob-screen" + (enterNow ? " is-enter" : ""); }

  function render() {
    var id = FLOW[idx], scr = null;
    morphDone();
    enterNow = entering;
    entering = false;
    while (host.firstChild) host.removeChild(host.firstChild);

    var root = el("div", "fbob");
    root.setAttribute("data-step", id);

    if (chromeAt(id) > -1) root.appendChild(chrome(id));

    if (id === "welcome")            scr = screenWelcome();
    else if (id === "q_draw")        scr = qDraw();
    else if (id === "affirm_draw")   scr = screenAffirm(AFFIRM_DRAW[getDraw()] || AFFIRM_DRAW.people);
    else if (id === "q_relate")      scr = qRelate();
    else if (id === "affirm_relate") scr = screenAffirm(has(getRelates(), "stories") ? AFFIRM_RELATE.stories : AFFIRM_RELATE.other);
    else if (id === "q_genres")      scr = qGenres();
    else if (id === "q_time")        scr = qNumber("goal", "How long should one Factbox take?", TIME_OPTS, getGoal(), setGoalAnswer);
    else if (id === "q_streak")      scr = qNumber("streak", "How many days in a row do you want to aim for?", STREAK_OPTS, getStreak(), setStreakAnswer);
    else if (id === "pick_story")    scr = screenPick();
    else if (id === "building")      scr = screenBuilding();
    else if (id === "results")       scr = screenResults();

    if (scr) root.appendChild(scr);
    host.appendChild(root);

    /* The loader paints its own body, and its first paint is an ARRIVAL —
       so enterNow is still standing here and goes down after it, not before.
       Every later repaint runs with it false and animates nothing. */
    if (id === "building") paintLoader();
    enterNow = false;
  }

  /* ---- chrome ------------------------------------------------------------
     The mockup's fixed top bar, and it is on the QUESTIONS only: the welcome,
     the two interstitials, the loader and the payoff carry none, exactly as
     the mockup draws them. The story pick is the sixth thing the reader is
     asked, so it keeps the bar with every phase full — the questions really
     are done by then, and a bar that jumped backwards there would be lying.
     --------------------------------------------------------------------- */

  function chromeAt(id) {
    var i;
    for (i = 0; i < QSTEPS.length; i++) { if (QSTEPS[i] === id) return i; }
    if (id === "pick_story") return QSTEPS.length;
    return -1;
  }

  function chrome(id) {
    var at = chromeAt(id);
    var top = el("div", "ob-top");

    var row = el("div", "ob-toprow");
    var back = btn("ob-back", "←", function () { goBack(); });
    back.setAttribute("aria-label", "Back");
    row.appendChild(back);

    var mark = el("span", "ob-mark");
    mark.appendChild(logoImg());
    mark.appendChild(el("span", "ob-markw", "FACTBOX"));
    row.appendChild(mark);
    row.appendChild(el("span", "ob-topgap"));
    top.appendChild(row);

    var bar = el("div", "ob-phases");
    var p, q, ph, lo, hi, span, pct, on, seg, track, fill, was;
    var now = [];
    for (p = 0; p < PHASES.length; p++) {
      ph = PHASES[p];
      lo = QSTEPS.length; hi = -1;
      for (q = 0; q < QSTEPS.length; q++) {
        if (has(ph.keys, QSTEPS[q])) { if (q < lo) lo = q; if (q > hi) hi = q; }
      }
      span = (hi - lo + 1) || 1;
      pct = at > hi ? 100 : (at < lo ? 0 : Math.round((at - lo + 1) / span * 100));
      on = at >= lo && at <= hi;
      seg = el("div", "ob-phase" + (on ? " is-on" : ""));
      track = el("div", "ob-track");
      fill = el("i", "ob-fill");
      /* D · the bar ADVANCES rather than arriving finished. The chrome is
         rebuilt for every screen, so a fresh element has nothing to
         transition from — it is started at the percentage the last screen
         left it on and released to this one over 420ms. scaleX, not width:
         a width transition repaints the bar every frame. */
      now[p] = pct;
      was = (phasePrev && typeof phasePrev[p] === "number") ? phasePrev[p] : pct;
      if (enterNow && !motionOff() && was !== pct) {
        fill.style.transform = "scaleX(" + (was / 100) + ")";
        travel(fill, pct);
      } else {
        fill.style.transform = "scaleX(" + (pct / 100) + ")";
      }
      track.appendChild(fill);
      seg.appendChild(track);
      seg.appendChild(el("p", "ob-plabel", ph.label));
      bar.appendChild(seg);
    }
    phasePrev = now;
    top.appendChild(bar);
    return top;
  }

  /* Two frames, then the transition — one frame is not reliably enough for a
     node that was appended in the same task. The timeout is not a nicety: if
     rAF never runs (a backgrounded tab), the bar would otherwise stay at the
     percentage it started from. go() is idempotent. */
  function travel(node, pct) {
    var go = function () {
      try {
        node.style.transition = "transform 420ms " + EASE;
        node.style.transform = "scaleX(" + (pct / 100) + ")";
      } catch (e) {}
    };
    try {
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(go);
        });
      }
    } catch (e2) {}
    try { setTimeout(go, 140); } catch (e3) {}
  }

  /* ---- 1 · welcome. The mockup's is1. ----------------------------------- */

  function link(href, text) {
    var a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    /* Same reason as every button here: js/analytics.js fires ui_click on any
       tappable element it does not recognise, and this one is inside a screen
       that already reports its own departure. */
    a.setAttribute("data-fbt", "-");
    return a;
  }

  function screenWelcome() {
    var s = el("div", screenCls() + " ob-welcome");

    var art = el("div", "ob-w-art");
    art.appendChild(plate(null, "/img/cards/c01-05.webp", "/img/stacks/s01.webp"));
    art.appendChild(scrim("ob-w-artscrim"));
    s.appendChild(enter(art, "ob-in-art", 0));
    s.appendChild(enter(scrim("ob-w-floor"), "ob-in-art", 0));

    var t = el("div", "ob-w-text");
    var mark = el("p", "ob-w-mark");
    mark.appendChild(logoImg());
    mark.appendChild(D().createTextNode("FACTBOX"));
    t.appendChild(enter(mark, "ob-in", 40));
    t.appendChild(headWords("h1", "ob-w-head", "Know the stories everyone should know."));
    t.appendChild(enter(el("p", "ob-w-lede",
      "Trade five minutes of scrolling for history you’ll actually remember."), "ob-in", 260));
    s.appendChild(t);

    var f = enter(el("div", "ob-w-foot"), "ob-in", 340);
    f.appendChild(cta("Continue", true, function () { advance("forward"); }));
    var fine = el("p", "ob-terms");
    fine.appendChild(D().createTextNode("By continuing you agree to our "));
    fine.appendChild(link("/terms", "Terms"));
    fine.appendChild(D().createTextNode(" and "));
    fine.appendChild(link("/privacy", "Privacy Policy"));
    fine.appendChild(D().createTextNode("."));
    f.appendChild(fine);
    s.appendChild(f);
    return s;
  }

  /* ---- a question. The mockup's q block. --------------------------------
     Tapping an option SELECTS it and nothing else; Continue is what moves.
     That is the mockup's own behaviour and the reason it has a disabled CTA
     at all, and it is what lets a reader change their mind before committing.
     --------------------------------------------------------------------- */

  function optRow(o, on, multi, onTap, at) {
    /* D · the row that was just tapped springs, and its tick lands. The tap
       rebuilds the screen, so the row that took it no longer exists by the
       time anything could be animated on it — the key is carried across the
       rebuild instead and the NEW row is born acknowledging. */
    var b = btn("ob-opt" + (on ? " is-on" : "") +
                (tappedKey && tappedKey === o.k ? " is-tap" : ""), null, onTap);
    /* C · and the whole set staggers in on arrival. */
    enter(b, "ob-in-row", 120 + (at || 0) * 40);
    b.setAttribute("data-k", o.k);
    b.setAttribute("role", multi ? "checkbox" : "radio");
    b.setAttribute("aria-checked", on ? "true" : "false");
    if (o.img) {
      var tile = el("span", "ob-tile");
      tile.appendChild(smallPlate(o.img));
      b.appendChild(tile);
    }
    b.appendChild(el("span", "ob-b", o.b));
    b.appendChild(glyph("ob-tick" + (multi ? " is-sq" : "")));
    return b;
  }

  function demoCard(id, tail) {
    var f = D().createDocumentFragment();
    var d = el("div", "ob-demo");
    d.appendChild(smallPlate(id));
    d.appendChild(scrim("ob-demoscrim"));
    var t = titleOf(id);
    if (t) d.appendChild(el("p", "ob-demotitle", t));
    f.appendChild(enter(d, "ob-in-art", 110));
    if (tail) f.appendChild(enter(el("p", "ob-demotail", tail), "ob-in", 200));
    return f;
  }

  /* spec: head, hint, fine, demo{id,tail}, opts, multi, isOn, tap,
           ready, ctaLabel, bare */
  function screenQuestion(spec) {
    var s = el("div", screenCls());
    var sc = el("div", "ob-scroll ob-qscroll" + (spec.bare ? " is-bare" : ""));

    sc.appendChild(headWords("h1", "ob-qhead", spec.head));
    if (spec.hint) sc.appendChild(enter(el("p", "ob-qhint", spec.hint), "ob-in", 110));
    if (spec.demo) sc.appendChild(demoCard(spec.demo.id, spec.demo.tail));

    var wrap = el("div", "ob-optwrap");
    var opts = el("div", "ob-opts" + (spec.pair ? " ob-yn" : ""));
    var i;
    for (i = 0; i < spec.opts.length; i++) {
      (function (o, at) {
        opts.appendChild(optRow(o, !!spec.isOn(o), !!spec.multi, function () {
          tappedKey = o.k;
          try { spec.tap(o); } catch (e) {}
          tappedKey = "";
        }, at));
      })(spec.opts[i], i);
    }
    wrap.appendChild(opts);
    sc.appendChild(wrap);

    if (spec.fine) sc.appendChild(enter(el("p", "ob-fine", spec.fine), "ob-in", 240));
    s.appendChild(sc);

    if (spec.next) {
      var f = enter(el("div", "ob-ctawrap"), "ob-in", 180);
      f.appendChild(cta(spec.ctaLabel || "Continue", !!spec.ready, spec.next));
      s.appendChild(f);
    }
    return s;
  }

  function setDraw(k) {
    var A = fba();
    try { if (A && A.setDraw) A.setDraw(k); } catch (e) {}
  }

  function setGoalAnswer(v) {
    var A = fba();
    try { if (A && A.setGoal) A.setGoal(v); } catch (e) {}
  }

  function setStreakAnswer(v) {
    var A = fba();
    try { if (A && A.setStreak) A.setStreak(v); } catch (e) {}
  }

  /* ---- 2 · what pulls you in -------------------------------------------- */

  function qDraw() {
    var cur = getDraw();
    return screenQuestion({
      head: "What pulls you into a history story?",
      opts: DRAW_OPTS,
      isOn: function (o) { return cur === o.k; },
      tap: function (o) {
        setDraw(o.k);
        emitAnswer(screenAt(idx), "draw", o.k);
        stampRun(null);
        render();
      },
      ready: !!cur,
      next: function () { advance("forward"); }
    });
  }

  /* ---- 4 · which of these sounds like you (multi) ------------------------ */

  function qRelate() {
    var cur = getRelates();
    return screenQuestion({
      head: "Which of these sounds like you?",
      hint: "Pick any that fit. If none of them do, just continue.",
      opts: RELATE_OPTS,
      multi: true,
      isOn: function (o) { return has(cur, o.k); },
      tap: function (o) {
        var list = getRelates(), at = -1, j;
        for (j = 0; j < list.length; j++) { if (list[j] === o.k) at = j; }
        if (at > -1) list.splice(at, 1); else list.push(o.k);
        var A = fba();
        try { if (A && A.setRelates) A.setRelates(list); } catch (e) {}
        stampRun(null);
        render();
      },
      ready: true,
      next: function () {
        /* Sorted and joined with the pipe gaParams() already uses for arrays,
           so a multi-select is one value and one row rather than three. */
        emitAnswer(screenAt(idx), "relates", getRelates().slice(0).sort().join("|"));
        advance("forward");
      }
    });
  }

  /* ---- 3, 5 · an interstitial. The mockup's is3 / is6. ------------------- */

  function screenAffirm(pair) {
    var p = pair || ["", "", "20"];
    var s = el("div", screenCls());

    var a = el("div", "ob-i-art");
    a.appendChild(bigPlate(p[2] || "20"));
    s.appendChild(enter(a, "ob-in-art", 0));

    var t = el("div", "ob-i-text");
    t.appendChild(headWords("h1", "ob-i-head", p[0]));
    t.appendChild(enter(el("p", "ob-i-body", p[1]), "ob-in", 170));
    s.appendChild(t);

    /* This screen releases itself after 1500ms, so its Continue cannot be
       three quarters of a second into arriving when it does. */
    var f = enter(el("div", "ob-i-foot"), "ob-in", 210);
    f.appendChild(cta("Continue", true, function () { advance("forward"); }));
    s.appendChild(f);
    return s;
  }

  /* ---- 6 · the genre pick. The one answer that drives anything. ---------- */

  function genreList() {
    var F = fbfit();
    if (F && F.GENRES) return F.GENRES;
    return [];
  }

  function qGenres() {
    var F = fbfit();
    var cur = getGenres();
    var list = genreList();
    var opts = [], i;
    for (i = 0; i < list.length; i++) {
      opts.push({ k: list[i].key, b: list[i].label, img: list[i].cover });
    }
    var disc = "";
    try { disc = F && F.disclosure ? F.disclosure() : ""; } catch (e) {}

    return screenQuestion({
      head: "What kind of stories pull you in?",
      hint: "Pick two or three. The first three set your feed.",
      opts: opts,
      multi: true,
      isOn: function (o) { return has(cur, o.k); },
      tap: function (o) {
        var picks = getGenres(), at = -1, j;
        for (j = 0; j < picks.length; j++) { if (picks[j] === o.k) at = j; }
        if (at > -1) picks.splice(at, 1);
        else if (picks.length < GENRE_MAX) picks.push(o.k);
        else return;                              /* three is the ceiling */
        var A = fba();
        try { if (A && A.setInterests) A.setInterests(picks); } catch (e) {}
        stampRun(null);
        render();
      },
      /* Not decoration. js/personalize.js calls this the sentence that makes
         the personalization honest rather than a cheque the catalogue cannot
         cash, and says a template that drops it is overclaiming. */
      fine: disc,
      ready: cur.length >= GENRE_MIN,
      ctaLabel: cur.length >= GENRE_MIN ? "Continue" : "Pick two",
      next: function () {
        emitAnswer(screenAt(idx), "genres", getGenres().slice(0).sort().join("|"));
        advance("forward");
      }
    });
  }

  /* ---- 7, 8 · the two number questions ---------------------------------- */

  function qNumber(q, head, list, cur, put) {
    return screenQuestion({
      head: head,
      opts: list,
      isOn: function (o) { return cur === o.v; },
      tap: function (o) {
        put(o.v);
        /* The key, not the number: "auto" is a real answer and 0 is the
           store's word for "never asked". Sending 0 for both would make them
           the same row. */
        emitAnswer(screenAt(idx), q, o.k);
        stampRun(null);
        render();
      },
      ready: !!cur,
      next: function () { advance("forward"); }
    });
  }

  /* ---- 9 · which would you click first. The mockup's is8. ---------------
     No Continue: the tap is the answer, and it holds for a beat so the tick
     is seen before the screen changes. That beat is the mockup's own 260ms.
     --------------------------------------------------------------------- */

  function screenPick() {
    var cur = getStory();
    var s = el("div", screenCls());
    var sc = el("div", "ob-scroll ob-pickscroll");
    sc.appendChild(headWords("h1", "ob-qhead", "Which one would you click first?"));

    var g = el("div", "ob-covers");
    var i;
    for (i = 0; i < COVERS.length; i++) {
      (function (c, at) {
        var on = cur === c.id;
        var b = btn("ob-cover" + (on ? " is-on" : "") +
                    (tappedKey === c.id ? " is-tap" : ""), null, function () {
          tappedKey = c.id;
          setStory(c.id);
          emitAnswer(screenAt(idx), "story", c.id);
          render();
          tappedKey = "";
          try {
            pickTimer = setTimeout(function () {
              pickTimer = 0;
              if (FLOW[idx] === "pick_story") advance("forward");
            }, 260);
          } catch (e) { advance("forward"); }
        });
        b.setAttribute("data-k", c.id);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.appendChild(smallPlate(c.id));
        b.appendChild(scrim("ob-coverscrim"));
        var cap = el("span", "ob-cap");
        cap.appendChild(el("span", "ob-chead", c.head));
        cap.appendChild(el("span", "ob-who", c.who));
        b.appendChild(cap);
        b.appendChild(glyph("ob-mark2"));
        /* F's language, one screen early: the four covers deal in. */
        g.appendChild(enter(b, "ob-in-deal", 120 + at * 70));
      })(COVERS[i], i);
    }
    sc.appendChild(g);
    sc.appendChild(el("div", "ob-pickpad"));
    s.appendChild(sc);
    return s;
  }

  /* ---- 10 · the loader. The mockup's is11. ------------------------------
     The bar runs on one interval. The genres the reader picked stand under
     the headline and tick off as the bar passes them, and a cover from their
     own feed cycles underneath with dot indicators, so the wait is the thing
     being built rather than a spinner.

     At two points the bar stops and asks something. That pause is NOT in the
     mockup — it is this engine's own, it is the reason the dead time is worth
     having, and it borrows the mockup's demo-question layout rather than
     inventing a third look. Both answers lead to the same place; they are
     still the reader's, so they are kept.
     --------------------------------------------------------------------- */

  function labelOf(key) {
    var F = fbfit();
    try { if (F && F.labelOf) return F.labelOf(key); } catch (e) {}
    return str(key);
  }

  /* One story per picked genre — the best-ranked story for that pick alone,
     so the covers that cycle really are of the feed being built. */
  function cycleIds() {
    if (loadIds) return loadIds;
    var F = fbfit();
    var picks = getGenres();
    var out = [], seenId = {}, i, one;
    for (i = 0; i < picks.length; i++) {
      one = null;
      /* The genre's own best, with the two feed passes off: `lead` promotes a
         free story into slot one and `spread` holds the faith-first stories
         apart, and both are right for a feed and wrong here — they hand every
         genre the same two covers, which is a carousel of one picture. */
      try {
        one = F && F.rank
          ? F.rank([picks[i]], stacks, { lead: false, spread: false })[0]
          : null;
      } catch (e) {}
      if (one && !seenId[one]) { seenId[one] = 1; out.push(one); }
    }
    if (!out.length) {
      try {
        var all = F && F.rank ? F.rank(picks, stacks) : [];
        for (i = 0; i < all.length && out.length < 3; i++) out.push(all[i]);
      } catch (e2) {}
    }
    loadIds = out;
    return out;
  }

  function startLoader() {
    /* 320ms read as a flicker — the bar was through its 7% steps before the
       eye had settled on the genre it had just lit, which made the one screen
       that is supposed to feel like work look like a glitch. 480 gives the
       same fifteen steps about seven seconds, and each tick pop its own beat. */
    var ms = typeof opts.tickMs === "number" ? opts.tickMs : 480;
    loadCycle = 0;
    loadIds = null;
    try {
      loadTimer = setInterval(function () {
        loadCycle++;
        if (interruptAt > -1) { return; }             /* held on a question */
        if (loadPct < 100) {
          loadPct = Math.min(100, loadPct + 7);
          var nx = INTERRUPTS[interruptsDone];
          if (nx && loadPct >= nx.at) interruptAt = interruptsDone;
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

  function screenBuilding() {
    var s = el("div", screenCls());

    /* G · the ghost word. Newsreader, enormous, five per cent of the ink,
       drifting through the empty band between the percentage and the cover
       card and passing behind the card. It is the wordmark and no new copy,
       it is aria-hidden, and it is built HERE rather than in paintLoader
       because paintLoader empties itself three times a second and a drift
       that restarts every 320ms is a flicker. */
    var g = el("div", "ob-ghostword");
    g.setAttribute("aria-hidden", "true");
    g.appendChild(el("span", null, "FACTBOX"));
    s.appendChild(g);

    /* The body the loader repaints. A plain static box, so everything inside
       it still resolves its absolute offsets against the screen. */
    var w = el("div", "ob-loadbody");
    w.setAttribute("data-ob-load", "1");
    s.appendChild(w);
    return s;
  }

  /* Repaints the loader in place rather than re-rendering the screen, so the
     screen is never replaced and never produces a second ob_step. */
  function paintLoader() {
    if (FLOW[idx] !== "building" || !host) return;
    var wrap = host.querySelector("[data-ob-load]");
    if (!wrap) return;

    /* B, inside one screen. The loader swaps its cover card for an
       interruption and back, and that swap is a plate arriving somewhere
       else — so it morphs, exactly as a screen change does. It morphs on the
       SWAP and never on a cover cycle, which happens three times a second. */
    var mode = interruptAt > -1 ? "ask" : "run";

    /* AND A PLATE THAT IS STILL TRAVELLING IS NOT REPAINTED OVER.

       This function empties the loader's body and rebuilds it, three times a
       second, from four callers. A plate arriving here from the pick screen
       is mid-flight for 520ms of that, and a repaint would tear it out of the
       DOM and drop the new one in at rest — the swap the morph exists to
       abolish, visible as a snap a third of the way over. So a repaint that
       is NOT itself a swap stands down while one is running; the swap itself
       still goes through, because runMorph() retires the old one first.

       This can hold for at most one morph: morphDone() runs on transitionend
       or, for a node torn down before it fires, on its timeout. */
    if (morphState && mode === loadMode) return;

    var came = (loadMode && loadMode !== mode) ? grabHero(wrap) : null;
    loadMode = mode;

    var ghost = null;
    try { ghost = wrap.parentNode.querySelector(".ob-ghostword"); } catch (eg) {}
    if (ghost) ghost.style.display = (mode === "ask") ? "none" : "";

    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    if (interruptAt > -1) {
      wrap.appendChild(loaderAsk(INTERRUPTS[interruptAt]));
      if (came) runMorph(came, wrap);
      return;
    }

    var picks = getGenres();
    var top = el("div", "ob-l-top");
    top.appendChild(headWords("h1", "ob-l-head", "Building your history feed"));
    top.appendChild(enter(el("p", "ob-l-sub",
      "Based on what you picked, we’ll prioritize:"), "ob-in", 120));

    var rows = el("div", "ob-picks");
    var i, shown, row, tick;
    for (i = 0; i < picks.length; i++) {
      shown = loadPct >= (i + 1) * (100 / (picks.length + 1));
      /* E · a tick pops the once it lights. pickShown is what makes it once:
         the rows are rebuilt on every repaint and a class alone would pop
         them again three times a second. */
      row = el("p", "ob-pick" + (shown ? " is-on" : "") +
                    (shown && !pickShown[i] && !motionOff() ? " is-pop" : ""));
      if (shown) pickShown[i] = 1;
      tick = glyph("ob-ptick");
      row.appendChild(tick);
      row.appendChild(el("span", "ob-b", labelOf(picks[i])));
      rows.appendChild(row);
    }
    top.appendChild(enter(rows, "ob-in", 180));

    var track = enter(el("div", "ob-loadtrack"), "ob-in", 230);
    var fill = el("i", "ob-loadfill");
    /* scaleX rather than width, and started from where the last paint left
       it so the bar slides its seven per cent rather than jumping it. */
    if (!motionOff() && loadPctPrev !== loadPct) {
      fill.style.transform = "scaleX(" + (loadPctPrev / 100) + ")";
      creep(fill, loadPct);
    } else {
      fill.style.transform = "scaleX(" + (loadPct / 100) + ")";
    }
    loadPctPrev = loadPct;
    track.appendChild(fill);
    top.appendChild(track);
    var pct = enter(el("p", "ob-pct", loadPct + "%"), "ob-in", 270);
    pct.setAttribute("role", "status");
    top.appendChild(pct);
    wrap.appendChild(top);

    var ids = cycleIds();
    if (ids.length) {
      var ci = loadCycle % ids.length;
      var cover = el("div", "ob-l-cover");
      var card = el("div", "ob-covercard");
      card.appendChild(smallPlate(ids[ci]));
      card.appendChild(scrim("ob-cardscrim"));
      var t = titleOf(ids[ci]);
      if (t) card.appendChild(el("p", "ob-covertitle", t));
      cover.appendChild(card);
      var dots = el("div", "ob-dots"), j;
      for (j = 0; j < ids.length; j++) {
        dots.appendChild(el("i", "ob-dot" + (j === ci ? " is-on" : "")));
      }
      cover.appendChild(dots);
      wrap.appendChild(enter(cover, "ob-in-art", 140));
    }

    var done = loadPct >= 100;
    var f = enter(el("div", "ob-l-foot"), "ob-in", 320);
    f.appendChild(cta(done ? "See my stories" : "Building…", done, function () {
      advance("forward");
    }));
    wrap.appendChild(f);
    if (came) runMorph(came, wrap);
  }

  /* The loader bar's own two-frame release. Same shape and same reason as
     travel(): the element is new every paint, so it is started at the last
     percentage and let go to this one. */
  function creep(node, pct) {
    var go = function () {
      try {
        node.style.transition = "transform 300ms linear";
        node.style.transform = "scaleX(" + (pct / 100) + ")";
      } catch (e) {}
    };
    try {
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(go);
        });
      }
    } catch (e2) {}
    try { setTimeout(go, 120); } catch (e3) {}
  }

  function loaderAsk(q) {
    /* The second question names no story of its own, so it is asked over the
       reader's — the same cover the loader was cycling a moment ago. Two
       buttons alone in an empty cream field is the screen this pause is
       supposed to be worth interrupting for, and it is not. */
    var artId = q.art || cycleIds()[0] || "";
    return screenQuestion({
      bare: true,
      head: q.head,
      demo: artId ? { id: artId, tail: q.sub } : null,
      hint: artId ? "" : q.sub,
      pair: true,
      opts: [{ k: "yes", b: YES }, { k: "no", b: NO }],
      isOn: function () { return false; },
      tap: function (o) { answerInterrupt(o.k === "yes"); }
    });
  }

  /* ---- 11 · the payoff. The mockup's is12. ------------------------------ */

  function mins(secs) {
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "½ min";
    return whole + (halves % 2 ? "½" : "") + " min";
  }

  /* The three the reader is handed. Ranked by their picks, with the story
     they SAID they would click first promoted to the front — they told us,
     and ignoring it on the very next screen would be the funnel asking a
     question it does not use. An id with no catalogue row behind it is
     skipped rather than printed: a number is not a headline. */
  function firstThree() {
    var F = fbfit();
    var picks = getGenres();
    var ranked = [];
    try { if (F && F.rank) ranked = F.rank(picks, stacks); } catch (e) {}

    var story = getStory();
    if (story) {
      var at = -1, j;
      for (j = 0; j < ranked.length; j++) { if (ranked[j] === story) at = j; }
      if (at > -1) {
        ranked = [story].concat(ranked.slice(0, at)).concat(ranked.slice(at + 1));
      }
    }

    var out = [], i, s;
    for (i = 0; i < ranked.length && out.length < 3; i++) {
      s = stackById(ranked[i]);
      if (s && s.title) out.push(s);
    }
    return out;
  }

  function screenResults() {
    var F = fbfit();
    var picks = getGenres();
    var copy = null;
    try { copy = F && F.copyFor ? F.copyFor(picks) : null; } catch (e) {}

    var s = el("div", screenCls());
    var sc = el("div", "ob-scroll ob-res");
    var inn = el("div", "ob-resin");

    inn.appendChild(headWords("h1", "ob-r-head", "Your first stories are ready."));
    if (copy && copy.labels) {
      inn.appendChild(enter(el("p", "ob-r-note", "Picked from " + copy.labels + "."),
                            "ob-in", 120));
    }

    var rows = firstThree();
    var ul = el("ul", "ob-cards");
    var i, st, li;
    for (i = 0; i < rows.length; i++) {
      st = rows[i];
      li = el("li", "ob-card");
      li.appendChild(bigPlate(st.id));
      li.appendChild(scrim("ob-cardscrim2"));
      li.appendChild(el("p", "ob-cardhead", str(st.title)));
      li.appendChild(el("p", "ob-meta",
        (st.cards ? st.cards.length : 0) + " cards · " + mins(st.secs)));
      /* F · the three deal in. The first one is usually the plate that
         morphed here from the loader, and runMorph() stands its deal down so
         it does not fade underneath its own arrival. */
      ul.appendChild(enter(li, "ob-in-deal", 160 + i * 110));
    }
    if (rows.length) inn.appendChild(ul);
    else {
      /* The catalogue has not landed. loadStacks() repaints this screen the
         moment it does; until then the screen says so rather than showing a
         card with an id where its headline goes. */
      inn.appendChild(enter(el("p", "ob-r-note", "Your shelf is coming up now…"),
                            "ob-in", 120));
    }

    /* Again, and for the same reason as on the genre grid. */
    if (copy && copy.disclosure) {
      inn.appendChild(enter(el("p", "ob-fine", copy.disclosure), "ob-in", 300));
    }

    sc.appendChild(inn);
    s.appendChild(sc);

    var f = enter(el("div", "ob-r-foot"), "ob-in", 260);
    f.appendChild(cta("Start reading", true, function () { advance("forward"); }));
    s.appendChild(f);
    return s;
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
    stacks = normStacks(opts.stacks);
    /* Started here rather than on the screen that needs it: the payoff is ten
       screens away, so by the time a title is wanted this has long resolved,
       and the reader never waits on a fetch. */
    loadStacks();
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
    phasePrev = null;
    tappedKey = "";

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
