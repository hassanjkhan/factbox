/* ==========================================================================
   Factbox — scenes.js
   Companion to css/scenes.css. Two jobs, both additive:

     1. Hang one atmosphere layer inside each card's .art, chosen from the
        card's data-topic. CSS cannot pick a class from an attribute value, so
        this is the only thing here that must be script.
     2. Arm the caption reveal.

   The camera move needs nothing from this file — read.html writes data-cam
   and css/scenes.css does the rest. If this script never runs, every card is
   still a slowly moving painting with plainly visible words on it. That is the
   design, not the fallback.

   Two rules govern every line below.

   It must never throw. A top-level exception here blanks the reader, so every
   DOM lookup is guarded and the whole body sits in try/catch.

   It must never leave text invisible. `html.js` is what switches the caption
   to opacity:0 and hands the reveal to `.beat.live`. So `js` goes on only
   after we have confirmed something is driving `.live`, comes off again if
   nothing has gone live within three seconds, and comes off on any script
   error from anywhere on the page. The site shipped wordless twice. The class
   that can hide the words is the class that has to justify itself.
   ========================================================================== */

(function () {
  var doc = document.documentElement;
  if (!doc) return;

  /* Topic -> atmosphere. Every topic in data/stacks.json has an entry; anything
     new, or a card built without a topic, falls through to the quiet one. */
  var ATM = {
    cleopatra:       "atm-shimmer",
    old_testament:   "atm-dust",
    new_testament:   "atm-halo",
    church_history:  "atm-candle",
    us_history:      "atm-grain",
    ancient_world:   "atm-haze",
    medieval_modern: "atm-cold",
    disaster:        "atm-ember"
  };
  var FALLBACK = "atm-veil";

  /* Headline, then body, then citation. Same rhythm as the flagship. */
  var DELAY_BODY = ".10s";
  var DELAY_CITE = ".22s";

  var armed = false;
  var killed = false;      /* one way. Once the reveal is unsafe it stays off. */
  var watchdog = 0;

  function has(el, c) {
    return el && el.className && (" " + el.className + " ").indexOf(" " + c + " ") > -1;
  }
  function add(el, c) {
    if (!el || has(el, c)) return;
    try { el.className = el.className ? el.className + " " + c : c; } catch (e) {}
  }

  function arm() {
    if (armed || killed) return;
    armed = true;
    add(doc, "js");
  }
  /* Permanent, deliberately. A later sweep must not quietly re-hide captions
     that we have already judged unsafe to hide. */
  function disarm() {
    armed = false;
    killed = true;
    try {
      doc.className = (" " + doc.className + " ")
        .replace(/\sjs\s/g, " ").replace(/^\s+|\s+$/g, "");
    } catch (e) {}
  }

  /* The reveal is only safe while something is actually setting `.live`.
     Nothing has? Then the words go back to being words. */
  function guard() {
    if (watchdog) return;
    watchdog = setTimeout(function () {
      try {
        if (armed && !document.querySelector(".beat.live, .pane.live")) disarm();
      } catch (e) {}
    }, 3000);
  }

  /* Any uncaught error on the page — ours, the reader's, a third party's —
     drops the reveal rather than risking a blank card. */
  try {
    window.addEventListener("error", function () { try { disarm(); } catch (e) {} });
  } catch (e) {}

  function dress(beat) {
    if (!beat || beat.getAttribute("data-scene") === "1") return;
    beat.setAttribute("data-scene", "1");

    /* -- atmosphere ------------------------------------------------------ */
    var art = beat.querySelector ? beat.querySelector(".art") : null;
    if (art && !art.querySelector(".atm")) {
      var topic = beat.getAttribute("data-topic") || "";
      var layer = document.createElement("div");
      layer.className = "atm " + (ATM[topic] || FALLBACK);
      layer.setAttribute("aria-hidden", "true");
      /* Appended, so it paints above the plate and below .art::after — the
         scrim app.css puts the caption on. Nothing here touches contrast. */
      art.appendChild(layer);
    }

    /* -- caption choreography -------------------------------------------- */
    var copy = beat.querySelector ? beat.querySelector(".copy") : null;
    if (!copy) return;

    var head = copy.querySelector("h2");
    if (head) { add(head, "rise"); setDelay(head, "0s"); }

    var ps = copy.querySelectorAll ? copy.querySelectorAll("p") : [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      add(p, "rise");
      setDelay(p, has(p, "cite") ? DELAY_CITE : DELAY_BODY);
    }
  }

  function setDelay(el, d) {
    try {
      if (el.style && el.style.setProperty) el.style.setProperty("--d", d);
    } catch (e) {}
  }

  function sweep() {
    var deck = document.getElementById("deck");
    if (!deck || !deck.querySelectorAll) return 0;
    var beats = deck.querySelectorAll(".beat");
    if (!beats.length) return 0;
    for (var i = 0; i < beats.length; i++) {
      try { dress(beats[i]); } catch (e) {}
    }
    arm();
    guard();
    return beats.length;
  }

  /* The deck is filled asynchronously, after stacks.json lands, and can be
     replaced wholesale (paywall, error pane). Watch for that; fall back to a
     short poll where MutationObserver is missing. Neither path is required for
     the page to read — they only decide when the atmosphere shows up. */
  function boot() {
    try { sweep(); } catch (e) {}

    var deck = document.getElementById("deck");
    if (!deck) return;

    if (window.MutationObserver) {
      try {
        new MutationObserver(function () {
          try { sweep(); } catch (e) {}
        }).observe(deck, { childList: true, subtree: true });
        return;
      } catch (e) {}
    }

    var tries = 0;
    var poll = setInterval(function () {
      try {
        if (sweep() || ++tries > 30) clearInterval(poll);
      } catch (e) { clearInterval(poll); }
    }, 200);
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        try { boot(); } catch (e) {}
      });
    } else {
      boot();
    }
  } catch (e) {}
})();
