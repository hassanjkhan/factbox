/* ==========================================================================
   Factbox — the onboarding. Eleven screens, on /join.

   ---------------------------------------------------------------------------
   WHY THIS FILE IS CALLED start.js AND RUNS ON /join

   There were two onboardings on this site. /join asked four questions and then
   sold a subscription; /start asked six of its own and handed the reader to
   /join, which asked four more into the same record. Two flows, one store, and
   a reader who answered "how much time have you got" twice.

   /join is the one that survives, for three reasons that are not preferences:

     1. It is where the traffic lands. /firststory, /story and /cleopatra all
        call to action at `/join?from=story`, those three pages are GENERATED
        by tools/compose.py, and tools/check-regressions.js fails the build if
        that link ever changes. The questions have to be where the readers
        arrive.
     2. The money is there. The sign-up form and the plan picker live in
        join.html and must keep behaving exactly as they did; moving the
        questions to another URL would put a navigation in the middle of the
        funnel.
     3. js/gate.js's JOIN_URL and js/acct.js's "Create account" both already
        point at /join.

   The ENGINE is this file, and it stays at js/start.js, for one reason that is
   also not a preference: five of the thirteen guards in tools/check-analytics.js
   read this exact path for the onboarding events, the per-question dwell and
   the abandon. Moving the code to js/join-flow.js would move the
   instrumentation out from under its own tests. So the file keeps its name,
   the events keep theirs — start_step, start_answer, start_abandon,
   start_ready — and /start is now a door rather than a flow.

   ES5 only. Every reader arrives through the Instagram or TikTok in-app
   webview: no let, no const, no arrows, no template literals, no
   URLSearchParams, no findIndex. Same rule as every file here except
   js/auth.js.

   ---------------------------------------------------------------------------
   THE ELEVEN

      1  intro        no bar, no question. One promise and one button.
      2  interests    MULTI-select, at least one
      3  motivation   single
      4  affirm       not a question — one counted number (see below)
      5  barrier      single
      6  scrolling    single
      7  reframe      not a question — 5 min/day into 365+ stories/year
      8  goal         single, five minutes marked Recommended
      9  future       single
     10  building     theatre, on a timer, auto-advances
     11  ready        their own answers, then TODAY / 30 DAYS / 3 MONTHS

   SINGLE-SELECT DOES NOT AUTO-ADVANCE. Tapping selects; Continue is disabled
   until something is selected and moves the reader on. The previous flow
   advanced on the tap itself, which is fewer taps and a worse screen: it
   removes the moment in which a mis-tap can be undone, and it makes an
   eleven-screen flow feel like it is being driven rather than answered.

   BACK NEVER WIPES ANYTHING. There is exactly one function that changes the
   screen, show_(i), and it takes an index — never "the next one". It clears
   the pending timers before it does anything else, so leaving screen 10 inside
   its own delay cannot be walked forward by a timer nobody cancelled. Nothing
   in this file clears an answer; the selected state lives on the buttons and
   is repainted from the store on load.

   ---------------------------------------------------------------------------
   WHERE THE ANSWERS GO, AND THE FOUR THAT DO NOT

   Through window.FBA — js/account.js — the store /join has always used: one
   localStorage key, one cookie mirror, and js/profile-sync.js copying it to
   customers/{uid}/profile/onboarding for a signed-in reader. No new key, no
   new Firestore path, no second store.

       screen  2 interests  -> FBA.setInterests(list)   the `interests` array
       screen  8 goal       -> FBA.setGoal(n)           GOALS: 5 | 10 | 20
       screen 10 building   -> FBA.finishOnboarding()

   THE FOUR THAT ARE NOT STORED: motivation, barrier, scrolling and future
   self. js/account.js has no field for any of them, its vocabularies clamp
   every value it does hold, and this rebuild was explicitly not allowed to
   edit that file. The three dishonest ways out were all available and all
   refused:

     * squeezing them into `relates`, whose vocabulary is three statements —
       two of the five barriers map, three would be silently dropped;
     * namespacing them into `interests` as "motivation:smarter", which is a
       parallel schema hidden inside a field and would reach Firestore as a
       reader's interests;
     * deriving them from the answers that ARE stored, which js/profile-sync.js
       forbids in as many words: "Nothing is inferred, derived, scored or
       bucketed."

   So they are recorded where they are actually actionable — one start_answer
   each, carrying the question, the answer and the dwell — and held in `picks`
   for the length of the visit, which is what screen 11 and the Back arrow
   need. They do not survive a refresh. The four setters that would fix that
   are named in the report that shipped this file.

   ---------------------------------------------------------------------------
   NOTHING HERE TOUCHES MONEY. This file does not name a price, a plan or the
   trial, and it does not read or write FBA.plan(), FBA.checkoutURL() or
   anything else in js/account.js's money half. The two functions it is allowed
   to call on the other side of the page are window.FBJN.login() and
   window.FBJN.plans(), and both of them simply hand over the screen.
   ========================================================================== */

(function () {
  "use strict";

  var D = document;

  /* ======================================================================
     THE NUMBER ON SCREEN 4.  READ ALL OF THIS.

     The screen was specified as "N% of Factbox readers say they remember more
     of what they learn". NO SUCH RESEARCH EXISTS. No survey has been run, and
     the product measures neither recall nor confidence, so there is nothing to
     run one against. A page that tells a prospective customer a fabricated
     fact about existing customers, on the way to taking their money, is worse
     than any bug this flow could ship.

     So the claim is one constant, and its default is null.

       null  ->  screen 4 shows a number that is COUNTED, live, out of
                 data/index.json: how many cards there are. 450 today. It is
                 true, it is checkable, and it makes no claim about anybody.
                 This is what ships.

       a number  ->  the screen becomes the survey sentence instead. DO NOT set
                 it until a real survey has been run and you can name it. There
                 is deliberately no plausible-looking default to leave in by
                 accident: the failure mode of forgetting this constant is a
                 true sentence about the corpus, not a false one about people.

     tools/drive-start.js fails if a percent sign reaches screen 4 while this
     is null. That check is the point of it.
     ====================================================================== */
  var RECALL_CLAIM_PCT = null;

  /* The sentence that goes with a real figure, if there ever is one. Kept
     next to the constant so the two cannot drift apart. */
  var RECALL_CLAIM_TEXT = "of Factbox readers say they remember more of what they learn.";

  /* ms the building screen runs before it advances itself. Long enough to
     read four lines, short enough that nobody wonders. Nothing is waiting on
     a server: adding real latency to a screen whose only job is to have some
     would be adding a wait, not measuring one. */
  var BUILD_MS = 2400;
  var BUILD_STEP_MS = 520;   /* between one status line ticking and the next */

  /* The screens, in order. The only ordering in this file. */
  var SCREENS = ["intro", "interests", "motivation", "affirm", "barrier",
                 "scrolling", "reframe", "goal", "future", "building", "ready"];

  /* Which of them are questions, and which number each one is. */
  var QNUM = { interests: 1, motivation: 2, barrier: 3,
               scrolling: 4, goal: 5, future: 6 };

  /* The reader-facing question each screen asks, as a stable key. Reused as
     the `question` parameter so a report reads "barrier" rather than "q3". */
  var QKEY = { interests: "interests", motivation: "motivation",
               barrier: "barrier", scrolling: "scrolling",
               goal: "goal", future: "future" };

  /* Screens with no Back arrow: the first, because there is nothing behind
     it, and the building screen, because it is moving on by itself. */
  var NO_BACK = { intro: 1, building: 1 };

  /* ======================================================================
     Reader-facing labels for the keys that get stored or said back. The keys
     themselves are the data-k attributes in join.html and nothing else.
     ====================================================================== */

  var INTEREST_LABEL = {
    powerful_people: "powerful people",
    betrayal:        "betrayal & scandal",
    mysteries:       "mysteries & conspiracies",
    wars_empires:    "wars & empires",
    religion:        "religion & belief",
    inventions:      "inventions & discoveries",
    how_we_got_here: "how the world got here"
  };

  var MOTIVE_LABEL = {
    smarter:        "Feeling smarter every day",
    understand:     "Actually understanding history",
    conversation:   "Better things to talk about",
    less_scrolling: "Less mindless scrolling",
    missed_school:  "The bits school missed"
  };

  var GOAL_LABEL = { "5": "5 minutes a day", "10": "10 minutes a day",
                     "20": "20 minutes a day" };

  /* The Today line on screen 11, in the reader's own number. */
  var ARC_TODAY = { "5": "Your first story, free, in about five minutes.",
                    "10": "Your first two stories, free, in about ten minutes.",
                    "20": "Your first stories, free, and time to sit with them." };

  /* ======================================================================
     Guarded primitives. Nothing in here may throw at top level; a page that
     throws before it shows a screen is a page with no words on it.
     ====================================================================== */

  function el(id) { try { return D.getElementById(id); } catch (e) { return null; } }

  function on(node, ev, fn) {
    try { if (node && node.addEventListener) node.addEventListener(ev, fn, false); }
    catch (e) {}
  }

  function show(node, yes) {
    try { if (node) { if (yes) node.removeAttribute("hidden"); else node.setAttribute("hidden", "hidden"); } }
    catch (e) {}
  }

  function text(node, s) {
    try { if (node) node.textContent = String(s == null ? "" : s); } catch (e) {}
  }

  function addClass(node, c) {
    try {
      if (!node) return;
      var cur = " " + (node.className || "") + " ";
      if (cur.indexOf(" " + c + " ") === -1) {
        node.className = ((node.className || "") + " " + c).replace(/^\s+/, "");
      }
    } catch (e) {}
  }
  function removeClass(node, c) {
    try {
      if (!node) return;
      node.className = (" " + (node.className || "") + " ")
        .replace(" " + c + " ", " ").replace(/^\s+|\s+$/g, "");
    } catch (e) {}
  }

  function bodyClass(c, yes) {
    try { if (yes) addClass(D.body, c); else removeClass(D.body, c); } catch (e) {}
  }

  function opts(id) {
    var box = el(id), out = [], i;
    if (!box) return out;
    try {
      var kids = box.getElementsByTagName("button");
      for (i = 0; i < kids.length; i++) out.push(kids[i]);
    } catch (e) {}
    return out;
  }

  function A() {
    try { return (window.FBA && typeof window.FBA.setGoal === "function") ? window.FBA : null; }
    catch (e) { return null; }
  }

  function track(nm, extra) {
    try { if (window.FB && window.FB.track) window.FB.track(nm, extra); } catch (e) {}
  }

  /* ======================================================================
     MEASURING THE FUNNEL.

     Four event names, all literal — start_step, start_answer, start_abandon,
     start_ready. Not `start_interests`, not `answer_<key>`: GA4 caps distinct
     event names and reports badly long before the cap, so the question and the
     answer are PARAMETERS.

     NOTHING TYPED IS SENT. `answer` is a button's data-k, one of a fixed list
     written into join.html. There is no text input anywhere in these eleven
     screens — no name, no email, no search box — and nothing in this file
     reads an input's value. The sign-up form on the same page belongs to the
     other script and is never touched from here.

     EVERY PARAMETER IS BOUNDED: values clipped to GA4's 100 characters, dwells
     to half an hour, so a phone left on a question overnight reports a ceiling
     rather than a number that ruins an average.

     NOTHING HERE MAY THROW OR DELAY A TAP. Every call is wrapped, and the
     measurement happens after the answer has been marked and stored.
     ====================================================================== */

  var DWELL_MAX = 1000 * 60 * 30;   /* half an hour is not a question */

  function nowMs() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function clip(v, n) {
    try {
      var t = String(v == null ? "" : v);
      return t.length > n ? t.slice(0, n) : t;
    } catch (e) { return ""; }
  }

  var screenAt = 0;      /* when the screen on display was shown */
  var shown    = false;  /* has any screen been shown yet */
  var answers  = {};     /* which questions have been answered */
  var readyHit = false;  /* the feed finished building: not an abandon */
  var leftSaid = false;  /* start_abandon is reported once, like stack_dropoff */

  /* Time on the screen currently displayed. */
  function dwell() {
    try {
      if (!screenAt) return 0;
      var ms = nowMs() - screenAt;
      if (ms < 0) return 0;
      return ms > DWELL_MAX ? DWELL_MAX : ms;
    } catch (e) { return 0; }
  }

  function answerCount() {
    var n = 0, k;
    try { for (k in answers) if (Object.prototype.hasOwnProperty.call(answers, k)) n++; }
    catch (e) {}
    return n;
  }

  /* ======================================================================
     What the reader has told us.

     `interests` and `goal` are written straight through to FBA the moment
     they are tapped. The other four have no field to be written to — see the
     block at the top of this file — and live here only.
     ====================================================================== */

  var picks = { interests: [], motivation: "", barrier: "",
                scrolling: "", goal: "", future: "" };

  function hasInterest(k) {
    try { return picks.interests.indexOf(k) !== -1; } catch (e) { return false; }
  }

  function toggleInterest(k) {
    try {
      var i = picks.interests.indexOf(k);
      if (i === -1) picks.interests.push(k); else picks.interests.splice(i, 1);
      var a = A();
      if (a) a.setInterests(picks.interests.slice(0));
    } catch (e) {}
  }

  /* "auto" is the reader saying "you decide", and js/account.js's word for a
     question with no answer is 0 — which is also what it stores for a skip.
     The two are indistinguishable in the record, and that is a known cost of
     not being able to add a field. In this session they are distinct, and
     screen 11 says "Factbox picks your pace" rather than a number. */
  function storeGoal(k) {
    try {
      var a = A();
      if (!a) return;
      a.setGoal(k === "auto" ? 0 : (Number(k) || 0));
    } catch (e) {}
  }

  /* ======================================================================
     The corpus. data/index.json, through js/gate.js's loader when it is on
     the page so this is the same request the shelves make.

     Screen 4's number is counted out of it. It degrades to the count already
     in the markup, which is the same real number — a dead fetch costs the
     reader nothing on screen and cannot turn a true number into a false one,
     because the fallback IS the figure.
     ====================================================================== */

  var stacks = null;

  function loadIndex() {
    try {
      if (window.FB && window.FB.loadIndex) return window.FB.loadIndex();
    } catch (e) {}
    try {
      return fetch("/data/index.json", { cache: "force-cache" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (d) {
        if (!d || !d.stacks || !d.stacks.length) throw new Error("empty index");
        return d.stacks;
      });
    } catch (e2) {}
    return null;
  }

  function cardCount() {
    var n = 0, i;
    if (!stacks || !stacks.length) return 0;
    for (i = 0; i < stacks.length; i++) {
      try { n += (stacks[i].cards && stacks[i].cards.length) ? stacks[i].cards.length : 0; }
      catch (e) {}
    }
    return n;
  }

  /* Screen 4, painted. Two shapes, and which one you get is decided entirely
     by RECALL_CLAIM_PCT at the top of this file. */
  function paintAffirm() {
    var stat = el("ob-stat"), cap = el("sc-affirm-h"), note = el("ob-stat-note");
    var tail = "Turns out, learning sticks better when the story is actually " +
               "worth remembering.";
    if (RECALL_CLAIM_PCT !== null && RECALL_CLAIM_PCT !== undefined) {
      text(stat, String(RECALL_CLAIM_PCT) + "%");
      text(cap, RECALL_CLAIM_TEXT);
      text(note, tail);
      return;
    }
    /* The shipping shape: a count, not a claim. */
    var n = cardCount();
    if (n) text(stat, String(n));
    text(cap, "cards of history, written to be remembered rather than revised.");
    text(note, tail);
  }

  /* ======================================================================
     The screens.
     ====================================================================== */

  var idx = 0;
  var running = false;
  var buildTimer = null;
  var stepTimers = [];
  var histOK = false;
  /* A generation token. Leaving a timed screen bumps it and every timer still
     in flight becomes a no-op, so two runs of the building screen can never
     tick the same list. */
  var runId = 0;

  function screenNode(i) { return el("sc-" + SCREENS[i]); }

  function clearTimers() {
    runId++;
    try { if (buildTimer) { window.clearTimeout(buildTimer); buildTimer = null; } } catch (e) {}
    try {
      for (var i = 0; i < stepTimers.length; i++) window.clearTimeout(stepTimers[i]);
    } catch (e2) {}
    stepTimers = [];
  }

  function paintChrome() {
    var here = SCREENS[idx];
    show(el("ob-back"), !NO_BACK[here]);

    /* The bar is the whole step indicator. No "Step 3 of 8" anywhere. */
    var bar = el("ob-track"), fill = el("ob-fill");
    show(bar, idx > 0);
    try {
      var pct = Math.round((idx / (SCREENS.length - 1)) * 100);
      if (fill) fill.style.width = pct + "%";
      if (bar) bar.setAttribute("aria-valuenow", String(idx));
    } catch (e) {}
  }

  /* Move focus to the screen's heading so a screen reader announces it.
     Never to a control: the first render is the page loading, and taking
     focus there fights the browser rather than helping. */
  function focusHead(node) {
    try {
      if (!node) return;
      var h = node.getElementsByTagName("h1")[0] || node.getElementsByTagName("h2")[0];
      if (!h) return;
      h.setAttribute("tabindex", "-1");
      h.focus();
    } catch (e) {}
  }

  /* The one function that changes the screen. It takes an index. */
  function show_(i) {
    clearTimers();
    if (i < 0) i = 0;
    if (i > SCREENS.length - 1) i = SCREENS.length - 1;

    /* Read the outgoing screen BEFORE idx moves. Its dwell rides on the event
       for the screen being shown, which is how the two affirmation screens and
       the building screen get measured without three more event names:
       whatever the reader spent on "You already have time to learn" arrives as
       from_ms on the goal step. */
    var fromName = shown ? SCREENS[idx] : "";
    var fromMs   = shown ? dwell() : 0;
    idx = i;

    var j, node;
    for (j = 0; j < SCREENS.length; j++) {
      node = screenNode(j);
      show(node, j === i);
      if (node) removeClass(node, "is-in");
    }
    paintChrome();

    /* Top of the new screen. Set the property rather than calling
       window.scrollTo: the render check runs this file in jsdom, where
       scrollTo is a hard "not implemented", and a check that cries wolf on a
       page that renders perfectly is a check nobody runs. */
    try { if (D.documentElement) D.documentElement.scrollTop = 0; } catch (e) {}
    try { if (D.body) D.body.scrollTop = 0; } catch (e) {}

    var here = SCREENS[i];
    var node2 = screenNode(i);

    if (here === "affirm")   paintAffirm();
    if (here === "building") runBuilding();
    if (here === "ready")    paintReady();

    /* Restart the entrance animation. Reading offsetHeight between the two is
       what makes the browser treat it as a new animation rather than the same
       one continuing. */
    try {
      if (node2 && shown) { node2.offsetHeight; addClass(node2, "is-in"); }
    } catch (e2) {}

    if (shown) focusHead(node2);

    var p = { step: here, q: QNUM[here] || 0 };
    if (fromName) { p.from = fromName; p.from_ms = fromMs; }
    track("start_step", p);
    screenAt = nowMs();
    shown = true;
  }

  function go(i) {
    if (i === idx) return;
    if (histOK) {
      try { window.history.pushState({ fbs: i }, ""); } catch (e) {}
    }
    show_(i);
  }

  function back() {
    if (idx <= 0) return;
    /* Screen 11 sits behind the building screen, which advances itself. Going
       back through it would replay the theatre; the reader means the last
       question they answered. */
    var to = (SCREENS[idx] === "ready") ? idx - 2 : idx - 1;
    if (to < 0) to = 0;
    if (histOK) {
      try { window.history.back(); return; } catch (e) {}
    }
    show_(to);
  }

  /* ======================================================================
     Answering.

     Tapping marks. Continue moves. Two shapes of question and one shape of
     footer button, which is disabled until the screen has an answer.
     ====================================================================== */

  function setGo(id, enabled) {
    try {
      var b = el(id);
      if (!b) return;
      if (enabled) b.removeAttribute("disabled");
      else b.setAttribute("disabled", "disabled");
    } catch (e) {}
  }

  function markOne(id, k) {
    var list = opts(id), i, node, mine;
    for (i = 0; i < list.length; i++) {
      node = list[i];
      mine = node.getAttribute("data-k") === String(k);
      if (mine) addClass(node, "on"); else removeClass(node, "on");
      try { node.setAttribute("aria-checked", mine ? "true" : "false"); } catch (e) {}
    }
  }

  function markMany(id) {
    var list = opts(id), i, node, mine;
    for (i = 0; i < list.length; i++) {
      node = list[i];
      mine = hasInterest(node.getAttribute("data-k"));
      if (mine) addClass(node, "on"); else removeClass(node, "on");
      try { node.setAttribute("aria-pressed", mine ? "true" : "false"); } catch (e) {}
    }
  }

  /* The delegated tap handler for one screen's option list. `pick` is called
     with the data-k and decides what marking and storing mean for that screen;
     `ready` says whether Continue may be enabled now. */
  function wire(boxId, screen, goId, pick, ready) {
    var box = el(boxId);
    if (!box) return;
    on(box, "click", function (ev) {
      var t = ev.target;
      try {
        while (t && t !== box && String(t.tagName || "").toLowerCase() !== "button") t = t.parentNode;
      } catch (e) { t = null; }
      if (!t || t === box) return;
      var k = t.getAttribute("data-k");
      if (!k) return;
      /* Only the screen you are on can answer. A hidden screen's button
         cannot be tapped, but nothing about that should be load-bearing. */
      if (SCREENS[idx] !== screen) return;

      /* The dwell is read before the answer is applied, so it measures the
         time the question took rather than the time the marking took. */
      var ms = dwell();
      try { pick(k); } catch (e2) {}
      setGo(goId, !!ready());

      try {
        track("start_answer", {
          step: screen,
          q: QNUM[screen] || 0,
          question: QKEY[screen] || screen,
          answer: clip(k, 100),
          dwell_ms: ms
        });
        answers[screen] = 1;
      } catch (e3) {}
    });
  }

  /* A single-select screen: five of the six questions are this. */
  function wireSingle(boxId, screen, goId, field) {
    wire(boxId, screen, goId,
      function (k) {
        picks[field] = k;
        markOne(boxId, k);
        if (field === "goal") storeGoal(k);
      },
      function () { return !!picks[field]; });
  }

  /* ======================================================================
     Screen 10 — building. Four status lines, one at a time, then on.
     ====================================================================== */

  function runBuilding() {
    var mine = runId, i;
    /* Every line starts un-ticked, including on a second visit. */
    for (i = 0; i < 4; i++) removeClass(el("ob-step-" + i), "on");

    /* finishOnboarding() is stamped here rather than on screen 11, because
       this is the last screen a reader can be on and still be mid-flow. It is
       what stops /join asking the eleven questions a second time. */
    try { var a = A(); if (a) a.finishOnboarding(); } catch (e) {}

    for (i = 0; i < 4; i++) {
      (function (n) {
        stepTimers.push(window.setTimeout(function () {
          if (mine !== runId) return;
          addClass(el("ob-step-" + n), "on");
        }, BUILD_STEP_MS * (n + 1)));
      })(i);
    }

    buildTimer = window.setTimeout(function () {
      buildTimer = null;
      if (mine !== runId) return;
      readyHit = true;
      track("start_ready", { answers: answerCount() });
      go(idx + 1);
    }, BUILD_MS);
  }

  /* ======================================================================
     Screen 11 — the result, in the reader's own answers.

     Everything below is read back from what they tapped. Where they tapped
     nothing, the markup's own line stands: a summary of defaults nobody chose
     would be putting words in their mouth, which is the same rule the plan
     screen's recap has always followed.
     ====================================================================== */

  function interestLine() {
    var out = [], i, lab;
    for (i = 0; i < picks.interests.length && out.length < 3; i++) {
      lab = INTEREST_LABEL[picks.interests[i]];
      if (lab) out.push(lab);
    }
    if (!out.length) return "";
    var more = picks.interests.length - out.length;
    var s = out.join(", ");
    /* Sentence case: the labels are lower case so they read inside a list. */
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return more > 0 ? (s + ", +" + more + " more") : s;
  }

  function paintReady() {
    var line = interestLine();
    if (line) text(el("ob-sum-feed"), line);

    if (picks.goal === "auto") {
      text(el("ob-sum-goal"), "Factbox picks your pace");
    } else if (GOAL_LABEL[picks.goal]) {
      text(el("ob-sum-goal"), GOAL_LABEL[picks.goal]);
    }

    if (MOTIVE_LABEL[picks.motivation]) {
      text(el("ob-sum-why"), MOTIVE_LABEL[picks.motivation]);
    }

    if (ARC_TODAY[picks.goal]) text(el("ob-arc-0"), ARC_TODAY[picks.goal]);
  }

  /* ======================================================================
     Wiring, and the one door out.
     ====================================================================== */

  function wireOnce() {
    /* History first, so the very first pushState has somewhere to come back
       to that is ours. */
    try {
      if (window.history && window.history.pushState) {
        window.history.replaceState({ fbs: 0 }, "");
        histOK = true;
      }
    } catch (e) { histOK = false; }

    on(window, "popstate", function (ev) {
      if (!running) return;
      var i = 0;
      try { i = (ev && ev.state && typeof ev.state.fbs === "number") ? ev.state.fbs : 0; }
      catch (e) { i = 0; }
      show_(i);
    });

    on(el("ob-back"), "click", back);

    /* The one door to the money side that exists inside the questions. */
    on(el("ob-signin"), "click", function () {
      try {
        stop();
        if (window.FBJN && window.FBJN.login) window.FBJN.login();
      } catch (e) {}
    });

    /* The screens that only have a Continue. */
    on(el("ob-intro-go"),   "click", function () { go(idx + 1); });
    on(el("ob-affirm-go"),  "click", function () { go(idx + 1); });
    on(el("ob-reframe-go"), "click", function () { go(idx + 1); });

    /* Screen 2 · multi-select, at least one. */
    wire("ob-interests-opts", "interests", "ob-interests-go",
      function (k) { toggleInterest(k); markMany("ob-interests-opts"); },
      function () { return picks.interests.length > 0; });
    on(el("ob-interests-go"), "click", function () { go(idx + 1); });

    /* Screens 3, 5, 6, 8, 9 · single select, no auto-advance. */
    wireSingle("ob-motivation-opts", "motivation", "ob-motivation-go", "motivation");
    on(el("ob-motivation-go"), "click", function () { go(idx + 1); });

    wireSingle("ob-barrier-opts", "barrier", "ob-barrier-go", "barrier");
    on(el("ob-barrier-go"), "click", function () { go(idx + 1); });

    wireSingle("ob-scrolling-opts", "scrolling", "ob-scrolling-go", "scrolling");
    on(el("ob-scrolling-go"), "click", function () { go(idx + 1); });

    wireSingle("ob-goal-opts", "goal", "ob-goal-go", "goal");
    on(el("ob-goal-go"), "click", function () { go(idx + 1); });

    wireSingle("ob-future-opts", "future", "ob-future-go", "future");
    on(el("ob-future-go"), "click", function () { go(idx + 1); });

    /* Screen 11's button is an <a> to the free story and needs no handler:
       the reader leaves the page, and leaving after start_ready is not an
       abandon. Its href is in the markup so it works with no script at all. */

    /* ---- Where the reader walked away -------------------------------------
       The drop-off, question by question. Reported on pagehide and on the tab
       going hidden — the same two moments js/analytics.js's card dwell and
       read.html's stack_dropoff use, because on a phone they are the only
       reliable ones; there is no unload worth trusting in an in-app webview.

       ONCE per page load, and only while the flow never reached the ready
       screen. That is the same bargain stack_dropoff makes: a reader who
       backgrounds the app on the barrier question, comes back and finishes
       produces one start_abandon and one start_ready, and a funnel that
       excludes sessions carrying start_ready is correct. */
    function abandon() {
      try {
        if (!running || leftSaid || readyHit) return;
        leftSaid = true;
        var here = SCREENS[idx];
        track("start_abandon", {
          step: here,
          q: QNUM[here] || 0,
          question: QKEY[here] || here,
          dwell_ms: dwell(),
          answers: answerCount()
        });
      } catch (e) {}
    }
    on(window, "pagehide", abandon);
    on(D, "visibilitychange", function () {
      try { if (D.visibilityState === "hidden") abandon(); } catch (e) {}
    });
  }

  /* Anything this browser already said, said back, so nobody answers the same
     question twice. Only the two that FBA can hold come back — the other four
     are gone with the tab, which is written up at the top of this file. */
  function repaint() {
    try {
      var a = A();
      if (a) {
        var ints = a.interests();
        if (ints && ints.length) {
          picks.interests = [];
          for (var i = 0; i < ints.length; i++) {
            if (INTEREST_LABEL[ints[i]]) picks.interests.push(ints[i]);
          }
          markMany("ob-interests-opts");
        }
        var g = a.goal();
        if (g) { picks.goal = String(g); markOne("ob-goal-opts", picks.goal); }
      }
    } catch (e) {}

    setGo("ob-interests-go", picks.interests.length > 0);
    setGo("ob-motivation-go", !!picks.motivation);
    setGo("ob-barrier-go", !!picks.barrier);
    setGo("ob-scrolling-go", !!picks.scrolling);
    setGo("ob-goal-go", !!picks.goal);
    setGo("ob-future-go", !!picks.future);
  }

  /* ======================================================================
     window.FBOB — the whole of what the rest of the page may do to this file.
     ====================================================================== */

  var wired = false;

  function start() {
    try {
      if (!el("ob-stage")) return false;      /* not a page with the screens on it */
      if (running) return true;
      if (!wired) { wireOnce(); wired = true; }
      running = true;
      bodyClass("ob-on", true);
      show(el("ob-main"), true);
      repaint();
      show_(0);

      var p = loadIndex();
      if (p && p.then) {
        p.then(function (rows) {
          stacks = rows || null;
          /* Only repaint the screen if it is the one this number is on. */
          if (SCREENS[idx] === "affirm") paintAffirm();
          return null;
        }, function () { return null; });
      }
      return true;
    } catch (e) { return false; }
  }

  /* Hand the screen to the money side. Everything here is idempotent: the
     inline block in join.html calls it on paths where the onboarding never
     started at all. */
  function stop() {
    try {
      clearTimers();
      running = false;
      bodyClass("ob-on", false);
      show(el("ob-main"), false);
      /* Hide the individual screens too, not just the box around them.
         Hiding only the container leaves eleven sections still saying "I am
         the visible one" to anything that reads the attribute rather than the
         layout — which is exactly what the driver did, and it reported a
         screen that was not on the page. Ambiguous state is a bug even when
         nothing renders wrong. */
      for (var i = 0; i < SCREENS.length; i++) show(screenNode(i), false);
    } catch (e) {}
    return true;
  }

  /* Back off the sign-up form returns to the result screen, with every answer
     still on it. */
  function resume() {
    try {
      if (!el("ob-stage")) return false;
      if (!wired) { wireOnce(); wired = true; }
      running = true;
      bodyClass("ob-on", true);
      show(el("ob-main"), true);
      repaint();
      show_(SCREENS.length - 1);
      return true;
    } catch (e) { return false; }
  }

  try {
    window.FBOB = { start: start, stop: stop, resume: resume, __factbox: 1 };
  } catch (e) {}

  /* This file does NOT start itself. join.html's inline block is the router:
     it knows whether this reader has already been through the questions or
     already paid, and it calls start() or stop() accordingly. Exactly one of
     the two halves of that page is ever on screen, and one script decides
     which — two scripts each deciding for themselves is how a page ends up
     showing both, or neither. */
})();
