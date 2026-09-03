/* The waiting state.

   "Loading…" tells a reader the one thing they already know. What it does not
   do is say how long, or give the eye anything to rest on, so three quiet
   seconds read as a broken page — which is how this site's waiting states were
   being read.

   So: a bar that visibly moves, and a line of copy in the voice of the thing
   being fetched. The copy is the point. It is a history app; the wait is a
   reasonable moment to be a history app at someone.

   ---------------------------------------------------------------------------
   Why the bar stops at 92%

   It is not measuring anything. Nothing here can honestly measure a fetch —
   there is no progress event on a JSON body worth reading, and a bar that
   claims 40% when it means "some time has passed" is a lie told in a widget.
   What it can honestly say is "still going", and the shape of that is a curve
   that decelerates and never arrives. Ninety-two percent reads as work in
   progress. One hundred, sitting still, reads as stuck.

   ---------------------------------------------------------------------------
   Why the copy is in the markup as well as in here

   Each page ships one line baked into its HTML, so the waiting state is
   complete at first paint with no JavaScript at all — the bar is CSS, the
   words are already there. This file then swaps in a random one, which happens
   within a few milliseconds of the parser reaching it. A reader with a dead
   script gets a real sentence rather than an empty box, which is the same rule
   the rest of the site follows.
   ========================================================================== */
window.FBLoad = (function () {
  "use strict";

  /* Dry, not zany. The house voice says "nobody actually knows" on a card
     about a queen's death; it does not do exclamation marks. Each of these is
     something a person might plausibly be doing in the next room. */
  var LINES = [
    "Dusting off the archive…",
    "Waking the archivist…",
    "Cross-referencing three unreliable sources…",
    "Asking someone who was probably there…",
    "Unrolling the scroll. It is a long one…",
    "Separating the legend from the paperwork…",
    "Checking whether this actually happened…",
    "Translating from the original Greek…",
    "Finding the footnote everyone skips…",
    "Arguing with a Victorian historian…",
    "Opening a very old box…",
    "Reading someone else's mail from 1503…",
    "Persuading the museum to turn the lights on…",
    "Carbon-dating the good bits…",
    "Looking for the snake…",
    "Digging, carefully…",
    "Checking the date twice…",
    "Waiting for the paint to dry. It has been 400 years…",
    "Consulting a monk with excellent handwriting…",
    "Deciding which chronicler to believe…",
    "Blowing the dust off a primary source…",
    "Following a citation into a footnote into a rumour…",
    "Asking the Romans to be more specific…",
    "Measuring a king who may not have been short…"
  ];

  var last = -1;
  function line() {
    /* Never the same line twice running. On a two-page visit, repeating is the
       one thing that makes a random list look like a fixed string. */
    var i = Math.floor(Math.random() * LINES.length);
    if (i === last) i = (i + 1) % LINES.length;
    last = i;
    return LINES[i];
  }

  /* The markup, for anything building a waiting state from script. */
  function html(extraClass) {
    return '<div class="fbload' + (extraClass ? " " + extraClass : "") + '">' +
             '<div class="fbload-track" aria-hidden="true">' +
               '<i class="fbload-fill"></i>' +
             '</div>' +
             '<p class="fbload-say" role="status">' + line() + '</p>' +
           '</div>';
  }

  /* Swap the baked-in line on every waiting state already in the document. */
  function refresh(root) {
    try {
      var n = (root || document).querySelectorAll(".fbload-say"), i;
      for (i = 0; i < n.length; i++) n[i].textContent = line();
    } catch (e) {}
  }

  /* ------------------------------------------------------------------------
     Finishing.

     Content used to simply overwrite the waiting state, so the bar vanished at
     whatever percentage it had crawled to. That reads as an interruption
     rather than an ending — the one moment the reader is watching the bar is
     the moment it disappears, and it disappears unfinished.

     So it completes — but not at the reader's expense. The bar is lifted out
     of the container it lives in, pinned where it already was, and run to 100%
     there while the real content drops in underneath at full speed. The ending
     is visible; it costs nothing.

     The exception is a wait too short to have been a wait. Under MIN_SHOW the
     bar has only just appeared, and rushing it to 100% would be a flash of
     something arriving and leaving — worse than never showing it. So it is
     removed outright and the content goes straight in, with no delay added to
     the fastest case, which is the one that least needs decorating.

     Failures do not get this. An error message replaces the bar immediately:
     a completion animation in front of "could not load this story" is a lie
     with a flourish on it. */
  var START = nowMs();
  var MIN_SHOW = 260, RUSH = 150, FADE = 130;

  function nowMs() {
    try { return performance.now(); } catch (e) { return +new Date(); }
  }

  function done(host, render) {
    function paint() { try { render(); } catch (e) {} }
    try {
      if (typeof render !== "function") return;
      /* Three shapes to find. Most pages wrap the bar in a .fbload block; the
         host may BE that block; and the sign-in and account rows put the track
         straight into their own .au-wait panel with no wrapper, because that
         panel already had the padding and the live region. */
      var box = null;
      if (host) {
        if (host.className && (" " + host.className + " ").indexOf(" fbload ") > -1) box = host;
        else box = host.querySelector(".fbload") ||
                   (host.querySelector(".fbload-fill") ? host : null);
      }
      if (!box || nowMs() - START < MIN_SHOW) { paint(); return; }

      /* The bar is lifted out of the container BEFORE the container is
         rewritten, pinned to the pixels it already occupied, and finished
         there while the real content goes in underneath it at full speed.

         The obvious version — finish the bar, then swap the content — costs
         the reader 300ms to watch an animation, which is a strange thing to
         charge for on the day we spent the afternoon removing 5.8 seconds.
         And it cannot be written that way anyway: at every one of these call
         sites the lines after the swap go straight on to query the DOM that
         the swap just built, so deferring it breaks them all.

         Lifting the bar out solves both. Content is never delayed by a single
         frame, and the completion plays over the top as it arrives. */
      /* Measured BEFORE anything moves. Re-inserting an element restarts its
         CSS animations, so the keyframe jumps back to the start of the curve
         the instant the box is re-parented — read the fill afterwards and you
         capture a bar that has just reset. Measured in the browser: the rush
         began from 47% instead of the 92% the reader was looking at. */
      var fillW = 0, trackW = 0;
      try {
        var f0 = box.querySelector(".fbload-fill");
        if (f0 && f0.parentNode) {
          fillW  = f0.getBoundingClientRect().width;
          trackW = f0.parentNode.getBoundingClientRect().width;
        }
      } catch (e) {}

      var r = box.getBoundingClientRect();
      box.style.position = "fixed";
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.margin = "0";
      box.style.zIndex = "40";
      box.style.pointerEvents = "none";
      document.body.appendChild(box);      /* out of the host, still on screen */

      paint();                             /* content, immediately            */

      var fill = box.querySelector(".fbload-fill");
      if (fill) {
        /* Where the bar actually IS has to be pinned before the keyframe is
           dropped. The rule underneath says width:4%, so killing the animation
           first sends the fill back to almost empty, and the rush then runs
           from there — the bar visibly jumps backwards before racing to full,
           which is the opposite of the reassurance it exists to give. Measured
           in the browser: 92% -> 4% -> 98% -> 100%.

           So: the width captured above goes back on as an inline style, the
           animation is killed, layout is forced so that width is what the
           transition starts from, and only then does it go to 100%. */
        if (trackW > 0) fill.style.width = (fillW / trackW * 100) + "%";
        fill.style.animation = "none";
        /* Reading layout here is the point, not an accident: without it the
           browser coalesces the two width writes and nothing animates. */
        /* eslint-disable-next-line no-unused-expressions */
        fill.offsetWidth;
        fill.style.transition = "width " + RUSH + "ms cubic-bezier(.2,.85,.25,1)";
        fill.style.width = "100%";
      }
      box.className += " is-done";
      setTimeout(function () {
        try { if (box.parentNode) box.parentNode.removeChild(box); } catch (e) {}
      }, RUSH + FADE + 60);
    } catch (e) { paint(); }
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { refresh(); }, false);
    } else { refresh(); }
  } catch (e) {}

  return { html: html, line: line, refresh: refresh, done: done, LINES: LINES };
})();
