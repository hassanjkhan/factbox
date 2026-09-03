/* ==========================================================================
   Factbox — /start, the six-question onboarding.

   ES5 only. Every reader arrives from the Instagram or TikTok in-app webview,
   so: no let, no const, no arrows, no template literals, no URLSearchParams,
   no findIndex. Same rule as every file here except js/auth.js.

   ---------------------------------------------------------------------------
   ONE TAP PER ANSWER

   The previous shape of this flow was six questions with six Continue
   buttons: twelve taps for six answers, and the button only confirmed a
   choice the tap had already made. Tapping an answer now IS the answer. It is
   stored immediately, and ADVANCE_MS later the next screen is shown.

   That is also why there is a Back arrow. Removing the Continue button
   removes the pause in which a mis-tap could be undone, so the way back has
   to be on the screen. It is on every screen except the first, where there is
   nothing behind it.

   ---------------------------------------------------------------------------
   BACK GOES BACK

   A previous version of this flow had a Back arrow that advanced to the NEXT
   question. Two things in here exist to stop that happening again:

   1. There is exactly one function that changes the screen, show(i), and it
      is given an index — never "the next one". back() passes idx - 1 and
      cannot pass anything else.

   2. show() cancels the pending advance timer before it does anything else.
      Without that, tapping an answer and then Back inside ADVANCE_MS lands
      you on the previous screen and, a moment later, a timer nobody
      cancelled walks you forward again. That is a Back button that goes
      forwards, arriving by a different road.

   The browser's own back button is driven through the same function: each
   forward step pushes a history entry, the arrow calls history.back(), and
   popstate calls show(). One path, so the two cannot disagree. If pushState
   is unavailable the arrow calls show() directly and the flow still works.

   ---------------------------------------------------------------------------
   WHERE THE ANSWERS GO

   Through window.FBA — js/account.js — which is the store the /join funnel
   has always used: one localStorage key, one cookie mirror, and
   js/profile-sync.js copying it to customers/{uid}/profile/onboarding for a
   signed-in reader. No new key, no new field, no new Firestore path. The
   mapping is written out in start.html's comment.

   Nothing on this page reads or writes anything to do with money.
   ========================================================================== */

(function () {
  "use strict";

  var D = document;

  /* ms between the tap and the next screen. Long enough to see the answer
     highlight, short enough that it never feels like a wait. */
  var ADVANCE_MS = 260;
  /* how long "Building your Factbox…" runs before the feed is shown. */
  var BUILD_MS   = 1500;

  /* The screens, in order. The only ordering in this file. */
  var SCREENS = ["open", "q1", "q2", "q3", "q4", "q5", "turn", "q6", "wait"];

  /* Which of them are questions, and which dot each one lights. */
  var QNUM = { q1: 1, q2: 2, q3: 3, q4: 4, q5: 5, q6: 6 };

  /* Reader-facing names for the keys we store, used on the wait screen. The
     keys themselves are js/account.js's vocabularies, unchanged. */
  var TOPIC_LABEL = {
    cleopatra:       "Cleopatra & Egypt",
    ancient_world:   "the ancient world",
    new_testament:   "the New Testament",
    old_testament:   "the Old Testament",
    church_history:  "the early church",
    medieval_modern: "medieval to modern",
    us_history:      "American history",
    disaster:        "disasters"
  };
  var DRAW_LABEL = {
    people:  "the people in it",
    turning: "the turning points",
    thread:  "how we got here",
    tiktok:  "TikTok, honestly"
  };
  var RELATE_LABEL = {
    notime:     "there is never time for it",
    unfinished: "books get started, not finished",
    stories:    "the stories stick, the dates don\u2019t"
  };
  var GOAL_LABEL = {
    "5":  "five minutes",
    "10": "ten minutes",
    "20": "twenty minutes",
    "45": "as long as it takes"
  };

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
      if (cur.indexOf(" " + c + " ") === -1) node.className = ((node.className || "") + " " + c).replace(/^\s+/, "");
    } catch (e) {}
  }
  function removeClass(node, c) {
    try {
      if (!node) return;
      node.className = (" " + (node.className || "") + " ")
        .replace(" " + c + " ", " ").replace(/^\s+|\s+$/g, "");
    } catch (e) {}
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
    try { return (window.FBA && typeof window.FBA.setDraw === "function") ? window.FBA : null; }
    catch (e) { return null; }
  }

  function track(name, extra) {
    try { if (window.FB && window.FB.track) window.FB.track(name, extra); } catch (e) {}
  }

  /* Same half-minute rounding js/gate.js prints everywhere else, so a length
     on this page reads exactly as it does on the shelf. */
  function minutes(secs) {
    try {
      if (window.FB && window.FB.minutes) return window.FB.minutes(secs);
    } catch (e) {}
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "\u00bd min";
    return whole + (halves % 2 ? "\u00bd" : "") + " min";
  }

  /* ======================================================================
     What the reader has told us. Every one of these is written straight
     through to FBA at the moment it is tapped; this object is only so the
     wait screen can say it back.
     ====================================================================== */

  var picks = { topic: "", wish: "", draw: "", relate: "", goal: 0, streak: 0 };

  /* Q1 and Q4 are both topic picks and both live in FBA's `interests` — the
     list js/account.js documents as "an array of stacks.json topic keys".
     First pick first. */
  function saveTopics() {
    var list = [], a = A();
    if (picks.topic) list.push(picks.topic);
    if (picks.wish && picks.wish !== picks.topic) list.push(picks.wish);
    try { if (a) a.setInterests(list); } catch (e) {}
  }

  /* ======================================================================
     The screens.
     ====================================================================== */

  var idx = 0;
  var advTimer = null;
  var buildTimer = null;
  var histOK = false;

  function screenNode(i) { return el("sc-" + SCREENS[i]); }

  function clearTimers() {
    try { if (advTimer) { window.clearTimeout(advTimer); advTimer = null; } } catch (e) {}
    try { if (buildTimer) { window.clearTimeout(buildTimer); buildTimer = null; } } catch (e) {}
  }

  function paintChrome() {
    var name = SCREENS[idx];
    show(el("st-back"), idx > 0);

    var q = QNUM[name] || 0;
    var lit = q ? q : (name === "open" ? 0 : (name === "turn" ? 5 : 6));

    var dots = el("st-dots");
    show(dots, idx > 0);
    try {
      if (dots) {
        var li = dots.getElementsByTagName("li");
        for (var i = 0; i < li.length; i++) {
          if (i < lit) addClass(li[i], "on"); else removeClass(li[i], "on");
        }
      }
    } catch (e) {}

    var count = el("st-count");
    show(count, !!q);
    if (q) text(count, "Question " + q + " of 6");
  }

  /* The one function that changes the screen. It takes an index. */
  function show_(i) {
    clearTimers();
    if (i < 0) i = 0;
    if (i > SCREENS.length - 1) i = SCREENS.length - 1;
    idx = i;
    for (var j = 0; j < SCREENS.length; j++) show(screenNode(j), j === i);
    paintChrome();
    /* Top of the new screen. Set the property rather than calling
       window.scrollTo: the render check runs this file in jsdom, where
       scrollTo is a hard "not implemented" and a check that cries wolf on a
       page that renders perfectly is a check nobody runs. */
    try { if (D.documentElement) D.documentElement.scrollTop = 0; } catch (e) {}
    try { if (D.body) D.body.scrollTop = 0; } catch (e) {}

    var name = SCREENS[i];
    if (name === "q4") prepQ4();
    if (name === "wait") runWait();
    track("start_step", { step: name });
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
    if (histOK) {
      try { window.history.back(); return; } catch (e) {}
    }
    show_(idx - 1);
  }

  /* ======================================================================
     Answering. One tap: mark it, store it, and ADVANCE_MS later move on.
     ====================================================================== */

  function markOne(id, k) {
    var list = opts(id), i, node;
    for (i = 0; i < list.length; i++) {
      node = list[i];
      var mine = node.getAttribute("data-k") === String(k);
      if (mine) addClass(node, "on"); else removeClass(node, "on");
      try { node.setAttribute("aria-checked", mine ? "true" : "false"); } catch (e) {}
    }
  }

  function answered(store) {
    clearTimers();
    var next = idx + 1;
    try { store(); } catch (e) {}
    advTimer = window.setTimeout(function () {
      advTimer = null;
      go(next);
    }, ADVANCE_MS);
  }

  function wire(id, screen, handler) {
    var box = el(id);
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
      markOne(id, k);
      answered(function () { handler(k); });
    });
  }

  /* Q4 offers everything except the subject just picked in Q1 — asking the
     same question twice with the same list reads as a bug. */
  function prepQ4() {
    var list = opts("st-q4-opts"), i, k, shown = 0;
    for (i = 0; i < list.length; i++) {
      k = list[i].getAttribute("data-k");
      var hide = (k && k === picks.topic);
      show(list[i], !hide);
      if (hide && picks.wish === k) { picks.wish = ""; saveTopics(); }
      if (!hide) shown++;
    }
    if (!shown) for (i = 0; i < list.length; i++) show(list[i], true);
    markOne("st-q4-opts", picks.wish);
  }

  /* ======================================================================
     The wait. One screen, two states, so Back out of it lands on Q6 and
     stays there.
     ====================================================================== */

  function pickLine(map, k, fallback) {
    var v = map[String(k)];
    return v ? v : fallback;
  }

  function runWait() {
    text(el("st-pick-topic"),  pickLine(TOPIC_LABEL, picks.topic, "the whole shelf"));
    text(el("st-pick-wish"),   pickLine(TOPIC_LABEL, picks.wish, "whatever is next"));
    text(el("st-pick-draw"),   pickLine(DRAW_LABEL, picks.draw, "the people in it"));
    text(el("st-pick-relate"), pickLine(RELATE_LABEL, picks.relate, "the stories stick, the dates don\u2019t"));
    text(el("st-pick-goal"),   pickLine(GOAL_LABEL, picks.goal, "five minutes"));
    text(el("st-pick-streak"), (picks.streak ? picks.streak : 7) + " days");

    paintFeed();

    var bar = el("st-bar");
    removeClass(bar, "is-done");
    /* Restart the CSS animation on a re-entry rather than showing a bar that
       is already full. */
    try {
      var fill = bar ? bar.getElementsByTagName("i")[0] : null;
      if (fill) { fill.style.animation = "none"; fill.offsetHeight; fill.style.animation = ""; }
    } catch (e) {}

    show(el("st-building"), true);
    show(el("st-ready"), false);

    buildTimer = window.setTimeout(function () {
      buildTimer = null;
      addClass(el("st-bar"), "is-done");
      show(el("st-building"), false);
      show(el("st-ready"), true);
      track("start_ready", null);
    }, BUILD_MS);
  }

  /* ======================================================================
     The corpus. data/index.json, fetched once, through js/gate.js's loader
     when it is on the page so this is the same request the shelves make.

     Everything below degrades to what is already in the markup: the same
     three covers, the same real counts. A dead fetch costs the reader
     nothing on screen.
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

  function coverImg(s) {
    var img = D.createElement("img");
    img.alt = "";
    img.setAttribute("width", "240");
    img.setAttribute("height", "320");
    img.onerror = function () {
      /* thumbs/ is the small plate; stacks/ is the same painting, larger.
         One retry, then leave the box as it is. */
      this.onerror = null;
      this.src = "/img/stacks/" + String(s.img) + ".webp";
    };
    img.src = "/img/thumbs/" + String(s.img) + ".webp";
    return img;
  }

  /* Three real stories on the open screen: the free ones first, because they
     are the ones a reader can open a second later, then the first story from
     a subject not already on the shelf — three covers off one topic reads as
     one story shown three times. */
  function paintCovers() {
    var box = el("st-covers");
    if (!box || !stacks || !stacks.length) return;
    var chosen = [], topics = {}, i, s;
    function take(s) { chosen.push(s); topics[String(s.topic)] = 1; }
    for (i = 0; i < stacks.length && chosen.length < 3; i++) {
      if (stacks[i] && stacks[i].free) take(stacks[i]);
    }
    for (i = 0; i < stacks.length && chosen.length < 3; i++) {
      s = stacks[i];
      if (s && !s.free && !topics[String(s.topic)]) take(s);
    }
    for (i = 0; i < stacks.length && chosen.length < 3; i++) {
      s = stacks[i];
      if (s && chosen.indexOf(s) === -1) take(s);
    }
    if (chosen.length < 3) return;

    try {
      while (box.firstChild) box.removeChild(box.firstChild);
      for (i = 0; i < chosen.length; i++) {
        var li = D.createElement("li");
        li.appendChild(coverImg(chosen[i]));
        var b = D.createElement("b");
        b.textContent = String(chosen[i].title || "");
        li.appendChild(b);
        box.appendChild(li);
      }
      box.setAttribute("data-from", "index.json");
    } catch (e) {}
  }

  function median(list) {
    var v = list.slice(0);
    v.sort(function (a, b) { return a - b; });
    if (!v.length) return 0;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  }

  /* The three numbers on the turn screen. All three are counted out of the
     file that was just fetched — there is nothing here that is not a count
     of something in data/index.json. */
  function paintFacts() {
    if (!stacks || !stacks.length) return;
    var cards = 0, secs = [], i;
    for (i = 0; i < stacks.length; i++) {
      try {
        cards += (stacks[i].cards && stacks[i].cards.length) ? stacks[i].cards.length : 0;
        if (stacks[i].secs) secs.push(Number(stacks[i].secs) || 0);
      } catch (e) {}
    }
    text(el("st-fact-stories"), stacks.length);
    if (cards) text(el("st-fact-cards"), cards);
    if (secs.length) text(el("st-fact-mins"), minutes(median(secs)));
  }

  /* How many stories each topic actually has, on the topic buttons. A topic
     with nothing in it is not offered. */
  function paintTopicCounts() {
    if (!stacks || !stacks.length) return;
    var counts = {}, i, t;
    for (i = 0; i < stacks.length; i++) {
      t = stacks[i] && stacks[i].topic ? String(stacks[i].topic) : "";
      if (!t) continue;
      counts[t] = (counts[t] || 0) + 1;
    }
    var ids = ["st-q1-opts", "st-q4-opts"], n;
    for (n = 0; n < ids.length; n++) {
      var list = opts(ids[n]);
      for (i = 0; i < list.length; i++) {
        var k = list[i].getAttribute("data-k");
        var c = counts[k] || 0;
        if (!c) { show(list[i], false); continue; }
        try {
          var sp = list[i].getElementsByTagName("span")[0];
          if (sp) sp.textContent = c + (c === 1 ? " story" : " stories");
        } catch (e) {}
      }
    }
  }

  /* The feed on the ready screen: real stories carrying the topics the
     reader picked, longest-standing order, then anything else to make three.
     This is the personalisation, and it is visible — three titles they can
     read before they decide anything. */
  function paintFeed() {
    var box = el("st-feed");
    if (!box || !stacks || !stacks.length) return;
    var want = [], chosen = [], i, s;
    if (picks.topic) want.push(picks.topic);
    if (picks.wish && picks.wish !== picks.topic) want.push(picks.wish);

    var w, seen = {};
    for (w = 0; w < want.length; w++) {
      for (i = 0; i < stacks.length && chosen.length < 3; i++) {
        s = stacks[i];
        if (!s || seen[s.id]) continue;
        if (String(s.topic) === want[w]) { seen[s.id] = 1; chosen.push(s); }
      }
    }
    for (i = 0; i < stacks.length && chosen.length < 3; i++) {
      s = stacks[i];
      if (!s || seen[s.id]) continue;
      seen[s.id] = 1; chosen.push(s);
    }
    if (!chosen.length) return;

    try {
      while (box.firstChild) box.removeChild(box.firstChild);
      for (i = 0; i < chosen.length; i++) {
        var li = D.createElement("li");
        li.appendChild(D.createTextNode(String(chosen[i].title || "")));
        var em = D.createElement("em");
        em.textContent = (chosen[i].free ? "Free \u00b7 " : "") + minutes(chosen[i].secs);
        li.appendChild(em);
        box.appendChild(li);
      }
      box.setAttribute("data-from", "index.json");
    } catch (e) {}
  }

  /* ======================================================================
     Wiring.
     ====================================================================== */

  function start() {
    /* History first, so the very first pushState has somewhere to come back
       to that is ours. */
    try {
      if (window.history && window.history.pushState) {
        window.history.replaceState({ fbs: 0 }, "");
        histOK = true;
      }
    } catch (e) { histOK = false; }

    on(window, "popstate", function (ev) {
      var i = 0;
      try { i = (ev && ev.state && typeof ev.state.fbs === "number") ? ev.state.fbs : 0; }
      catch (e) { i = 0; }
      show_(i);
    });

    on(el("st-back"), "click", back);
    on(el("st-open-go"), "click", function () { go(idx + 1); });
    on(el("st-turn-go"), "click", function () { go(idx + 1); });

    wire("st-q1-opts", "q1", function (k) { picks.topic = k; saveTopics(); });
    wire("st-q2-opts", "q2", function (k) {
      picks.draw = k;
      var a = A(); try { if (a) a.setDraw(k); } catch (e) {}
    });
    wire("st-q3-opts", "q3", function (k) {
      picks.relate = k;
      var a = A(); try { if (a) a.setRelates([k]); } catch (e) {}
    });
    wire("st-q4-opts", "q4", function (k) { picks.wish = k; saveTopics(); });
    wire("st-q5-opts", "q5", function (k) {
      picks.goal = Number(k) || 0;
      var a = A(); try { if (a) a.setGoal(picks.goal); } catch (e) {}
    });
    wire("st-q6-opts", "q6", function (k) {
      picks.streak = Number(k) || 0;
      var a = A(); try { if (a) a.setStreak(picks.streak); } catch (e) {}
    });

    /* Anything this browser already said, said back, so nobody answers the
       same question twice. Same repaint /join does on arrival. */
    try {
      var a = A();
      if (a) {
        var ints = a.interests();
        if (ints && ints.length) {
          picks.topic = ints[0] || "";
          picks.wish = ints.length > 1 ? ints[1] : "";
        }
        picks.draw = a.draw() || "";
        var rel = a.relates();
        picks.relate = (rel && rel.length) ? rel[0] : "";
        picks.goal = a.goal() || 0;
        picks.streak = a.streak() || 0;
        markOne("st-q1-opts", picks.topic);
        markOne("st-q2-opts", picks.draw);
        markOne("st-q3-opts", picks.relate);
        markOne("st-q4-opts", picks.wish);
        markOne("st-q5-opts", picks.goal);
        markOne("st-q6-opts", picks.streak);
      }
    } catch (e2) {}

    show_(0);

    var p = loadIndex();
    if (p && p.then) {
      p.then(function (rows) {
        stacks = rows || null;
        paintCovers();
        paintFacts();
        paintTopicCounts();
        if (SCREENS[idx] === "wait") paintFeed();
        return null;
      }, function () { return null; });
    }
  }

  /* This file's tag sits after the markup it needs, so it runs the moment the
     parser reaches it rather than waiting for DOMContentLoaded. Waiting would
     show all nine screens at once for a frame — which is what a reader with no
     JavaScript correctly gets, and what a reader with JavaScript should never
     see. If the tag is ever moved above the markup, the fallback still fires. */
  try {
    if (el("sc-open")) { start(); }
    else if (D.readyState === "loading") {
      D.addEventListener("DOMContentLoaded", function () { try { start(); } catch (e) {} }, false);
    } else {
      start();
    }
  } catch (e) {
    /* Even this must not blank the page: every screen is in the markup and
       visible until something hides it. */
  }
})();
