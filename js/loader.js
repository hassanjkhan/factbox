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

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { refresh(); }, false);
    } else { refresh(); }
  } catch (e) {}

  return { html: html, line: line, refresh: refresh, LINES: LINES };
})();
