/* Hold and drag with a mouse to move through a story.

   A snap deck is built for a thumb. On a desktop the same deck can only be
   moved with a wheel or the keyboard, and the first thing anyone tries — press
   and pull, the way you would flick it on a phone — does nothing at all. This
   makes that work.

   FBDrag.attach(el) and it is done. Nothing else on the page changes.

   ---------------------------------------------------------------------------
   Three things it has to be careful about

   1. It must not steal a click. A press that never moves is a tap on a link, a
      Save button, a sound toggle. So nothing is captured until the pointer has
      travelled THRESHOLD pixels; below that the browser keeps the event and
      the click lands as normal. Above it, the click that follows the release
      is swallowed once, so dragging across a link does not also open it.

   2. It must not fight the deck's own scrolling, which resists in two ways at
      once. `scroll-snap-type: y mandatory` pulls the deck back to the nearest
      card mid-gesture; `scroll-behavior: smooth` turns every scrollTop write
      into an animation, so sixty writes a second each cancel the last. With
      both left on, the deck does not move at all and nothing throws. Both are
      switched off for the length of the drag and restored on release —
      restoring snap is also what lands it on a card rather than between two.

   3. It must not touch touch. Fingers already work, and a phone is where
      almost all of the reading happens; the risk of breaking that for a
      desktop nicety is the wrong trade. Mouse pointers only — every other
      pointerType returns immediately.

   Text selection is suppressed only while a drag is actually running, so
   selecting a caption with the mouse still works.
   ========================================================================== */
window.FBDrag = (function () {
  "use strict";

  var THRESHOLD = 6;          /* px before a press becomes a drag            */

  function attach(deck) {
    if (!deck || !window.PointerEvent) return false;
    if (deck.getAttribute("data-drag")) return true;   /* once per element   */
    deck.setAttribute("data-drag", "1");

    var down = false, dragging = false;
    var startY = 0, startTop = 0, snapWas = "", behaveWas = "";

    function stop() {
      if (!down) return;
      down = false;
      if (dragging) {
        /* Restoring snap is what lands the deck on a card. Deferred a frame so
           the release does not race the last scrollTop we wrote. */
        try {
          var restore = function () {
            deck.style.scrollSnapType = snapWas;
            deck.style.scrollBehavior = behaveWas;
          };
          if (window.requestAnimationFrame) requestAnimationFrame(restore);
          else setTimeout(restore, 16);
        } catch (e) {}
        try { document.body.style.userSelect = ""; } catch (e) {}
        try { deck.style.cursor = ""; } catch (e) {}
      }
      dragging = false;
    }

    deck.addEventListener("pointerdown", function (e) {
      if (!e || e.pointerType !== "mouse" || e.button !== 0) return;
      down = true; dragging = false;
      startY = e.clientY;
      startTop = deck.scrollTop;
    }, true);

    deck.addEventListener("pointermove", function (e) {
      if (!down || e.pointerType !== "mouse") return;
      var dy = e.clientY - startY;

      if (!dragging) {
        if (Math.abs(dy) < THRESHOLD) return;    /* still just a click       */
        dragging = true;
        try {
          snapWas = deck.style.scrollSnapType;
          behaveWas = deck.style.scrollBehavior;
          deck.style.scrollSnapType = "none";
          /* Smooth scrolling has to go too, and it is the one that actually
             stopped this working. The deck is `scroll-behavior:smooth`, so
             every scrollTop write started an ANIMATION rather than a jump —
             sixty of them a second, each cancelling the last, while mandatory
             snapping pulled the whole thing back to the card it started on.
             The deck did not move a pixel and nothing threw. */
          deck.style.scrollBehavior = "auto";
          document.body.style.userSelect = "none";
          deck.style.cursor = "grabbing";
          if (deck.setPointerCapture) deck.setPointerCapture(e.pointerId);
        } catch (x) {}
      }

      /* Pull the deck with the pointer: drag up, move forward. */
      deck.scrollTop = startTop - dy;
      if (e.preventDefault) e.preventDefault();
    }, true);

    /* pointerup and pointercancel end a drag. pointerleave does NOT, and that
       is deliberate: these listeners are in the capture phase, and a
       capture-phase listener on an ancestor receives non-bubbling events aimed
       at its descendants. So every time the pointer crossed from one element
       inside the deck to another — which is constantly, mid-drag — the child's
       own pointerleave reached this handler and cancelled the gesture two
       moves in. The deck never moved and nothing threw.

       Leaving the element is already handled: setPointerCapture keeps the
       events coming even when the pointer goes outside. The window-level
       release below is the backstop for a button let go off-screen. */
    deck.addEventListener("pointerup", stop, true);
    deck.addEventListener("pointercancel", stop, true);
    try {
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("blur", stop, false);
    } catch (e) {}

    /* Swallow exactly the click that ends a drag, so pulling the deck by a
       link does not also follow it. A press that never dragged is untouched. */
    deck.addEventListener("click", function (e) {
      if (!dragging) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }, true);

    return true;
  }

  return { attach: attach };
})();
