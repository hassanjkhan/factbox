/* ==========================================================================
   Factbox — founding members. The live count behind "the first 1000".

   THE OFFER IS A FACT, NOT A DEVICE. "The first 1000 subscribers get this
   price" is a sentence about the world, and the only reason it may be printed
   on the plan screen is that a server counts it. The Stripe webhook in
   functions/index.js assigns every account a permanent `foundingNumber` the
   first time it becomes paying, inside the same transaction that grants
   premium, and maintains `meta/founding` = { claimed, cap } as it goes. This
   file reads that document and nothing else.

   IT REPLACED A COUNTDOWN TIMER, deliberately. A timer that restarts on
   reload is a lie the reader can catch with one gesture, and the whole pitch
   of this product is that the numbers on it are real. A counter that only
   moves when somebody actually pays cannot be caught out, because there is
   nothing to catch.

   ---------------------------------------------------------------------------
   THE ONE RULE: NEVER INVENT A NUMBER.

   Every failure — offline, blocked, timed out, 500, malformed body, rules
   changed — lands in the same place: known() is false, and the caller renders
   the price with NO founding claim at all. Not "1000 places left", not the
   last number we saw, not a rounded one, not a hedged one. Nothing. A price
   with no scarcity line beside it is a complete, honest screen; a scarcity
   line with a made-up number in it is the exact failure this file exists to
   make impossible.

   That rule is also why the count is held in memory for the life of the page
   and NEVER written to localStorage. A cached count is a count that keeps
   being displayed after it stopped being true, which is a false claim wearing
   a true claim's clothes. One page load, one answer, no persistence.

   A 404 IS NOT A FAILURE. The document is created by the webhook when the
   first subscriber pays. No document means nobody has paid, which is
   claimed = 0 — a real answer, and known() is true. A 403 IS a failure: it
   means firestore.rules stopped allowing the public read, and the honest
   response to "I am not allowed to see the number" is to say nothing.

   ---------------------------------------------------------------------------
   HOW IT READS. A plain XMLHttpRequest against the Firestore REST API. No
   Firebase SDK, no auth, no second cloud function, nothing added to the
   critical path of a page whose only job is to take money.

     GET .../v1/projects/factbox-7cb97/databases/(default)/documents/meta/founding
     -> { fields: { claimed: { integerValue: "7" }, cap: { integerValue: "1000" } } }

   firestore.rules has `match /meta/{doc} { allow read: if true; }`, so this
   works signed out, which is the state every reader on /join is in.

   ---------------------------------------------------------------------------
   USING IT. One call, and it draws twice:

     FBFOUND.paint(function (known, claimed, cap, left) {
       if (!known) { hide the founding line; }
       else { "Founding member — " + claimed + " of " + cap + " places taken" }
     });

   The first call happens immediately with known = false, so the page paints a
   correct screen before the network has been asked anything; the second
   happens when the real number lands. Same render-then-correct shape as
   FBX.paint() in js/access.js, for the same reason: the honest state is
   drawable at once, so nothing waits.
   ========================================================================== */
var FBFOUND = (function () {
  "use strict";

  var URL_ = "https://firestore.googleapis.com/v1/projects/factbox-7cb97/" +
             "databases/(default)/documents/meta/founding";

  /* The same cap as FOUNDING_CAP in functions/index.js, and used for exactly
     the same two things: the value the document is first written with, and
     the fallback when the field is missing. The document's own `cap` always
     wins when it has one, so the cap can be raised in the console without a
     deploy of either half. This is a constant of the offer, not a count —
     it is never a substitute for a `claimed` we do not have. */
  var DEFAULT_CAP = 1000;

  /* The same budget js/access.js gives its one blocking request, for the same
     reason: long enough that a phone on a bad connection still gets the real
     number, short enough that nobody watches a plan screen wait for a line
     that is optional anyway. Nothing on this site blocks on this file, so the
     cap is really a promise about when paint()'s second call stops being
     possible, not about when the reader sees a price. */
  var ASK_MS = 2500;

  /* In memory, for this page, and nowhere else. See the note above on why
     there is no localStorage here and must never be one. */
  var KNOWN   = false;
  var CLAIMED = 0;
  var CAP     = DEFAULT_CAP;

  var LOAD_P  = null;   /* the in-flight or finished request, shared */
  var painters = [];    /* paint() callbacks awaiting the correction */

  function known()   { return KNOWN; }
  function claimed() { return KNOWN ? CLAIMED : 0; }
  function cap()     { return CAP; }

  /* Places left, floored at zero. The counter is allowed to pass the cap on
     purpose — functions/index.js honours a checkout that was already on a
     reader's screen when the last place went — and "-3 places left" is not a
     sentence anybody should ever be shown. */
  function left() {
    if (!KNOWN) return 0;
    var n = CAP - CLAIMED;
    return n > 0 ? n : 0;
  }

  function open() { return KNOWN && CLAIMED < CAP; }

  /* A Firestore REST integerValue arrives as a STRING ("7"), and may also
     arrive as doubleValue if the field was ever written from a language with
     one number type. Anything that is not a whole, finite, non-negative
     number is not an answer. */
  function intOf(field) {
    if (!field || typeof field !== "object") return null;
    var raw = null;
    if (typeof field.integerValue !== "undefined") raw = field.integerValue;
    else if (typeof field.doubleValue !== "undefined") raw = field.doubleValue;
    else return null;
    var n = Number(raw);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n < 0) return null;
    return n;
  }

  /* Accept an answer, or refuse it whole. There is no partial acceptance: a
     document with a cap and no claimed tells us nothing we may print. */
  function accept(claimedN, capN) {
    if (claimedN === null) return false;
    CLAIMED = claimedN;
    CAP = (capN !== null && capN > 0) ? capN : DEFAULT_CAP;
    KNOWN = true;
    return true;
  }

  /* The whole of the success path. Kept apart from the transport so the shape
     of an accepted answer is one readable thing. */
  function readBody(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { return false; }
    if (!j || typeof j !== "object") return false;
    /* Firestore returns errors as 200-shaped JSON in some proxies; an `error`
       key is never a document. */
    if (j.error) return false;
    if (!j.fields || typeof j.fields !== "object") return false;
    return accept(intOf(j.fields.claimed), intOf(j.fields.cap));
  }

  function announce() {
    var i, list = painters;
    painters = [];
    for (i = 0; i < list.length; i++) {
      try { list[i](KNOWN, claimed(), CAP, left()); } catch (e) {}
    }
  }

  /* load() — resolves. Always. There is no rejection path out of this
     function on purpose, the same as askServer() in js/access.js: every
     caller's error handler and success handler would do the identical thing
     (say nothing about founding), and a promise that can reject is a promise
     somebody forgets to catch — on the one screen where an uncaught error
     costs a sale. */
  function load() {
    if (LOAD_P) return LOAD_P;
    LOAD_P = new Promise(function (done) {
      var settled = false;

      function finish() {
        if (settled) return;
        settled = true;
        announce();
        done(KNOWN);
      }

      if (typeof XMLHttpRequest === "undefined") { finish(); return; }

      var xhr;
      try { xhr = new XMLHttpRequest(); } catch (e) { finish(); return; }

      /* A plain timer as well as xhr.timeout, because a browser that ignores
         one still cannot hold paint()'s second call open past the budget. */
      setTimeout(function () {
        if (settled) return;
        try { xhr.abort(); } catch (e) {}
        finish();
      }, ASK_MS);

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        try {
          /* 200 — a document. Believe it only if it parses into a claimed.
             404 — no document, so nobody has subscribed yet. That is a real
                   answer of zero, and the one non-200 we accept.
             403 — the public read rule is gone. We are not allowed to know
                   the number, so we say nothing about it.
             anything else, including 0 for a network or CORS failure — the
                   same silence, arrived at from a different direction. */
          if (xhr.status === 200) { readBody(xhr.responseText); }
          else if (xhr.status === 404) { accept(0, null); }
        } catch (e) {}
        finish();
      };

      try {
        xhr.open("GET", URL_, true);
        xhr.timeout = ASK_MS;
        xhr.ontimeout = finish;
        xhr.onerror = finish;
        /* No credentials, no headers: an unauthenticated read of a world
           readable document is a simple request, and adding either would
           trigger a CORS preflight for nothing. */
        xhr.withCredentials = false;
        xhr.send(null);
      } catch (e) { finish(); }
    });
    return LOAD_P;
  }

  /* paint() — render, then correct. The house pattern, and the reason the
     honest fallback costs nothing: fn is called SYNCHRONOUSLY with what we
     have, which on a cold page is known = false, so the screen is drawn
     correct-and-quiet before a single byte moves. It is called a second time
     only if the answer actually changed the state — a failed load leaves the
     screen exactly as it was drawn, with no flicker and no second pass. */
  function paint(fn) {
    if (typeof fn !== "function") return;
    var wasKnown = KNOWN;

    try { fn(KNOWN, claimed(), CAP, left()); } catch (e) {}

    if (KNOWN) return;                  /* already answered; nothing to add */
    painters.push(function (nowKnown, c, cp, l) {
      if (nowKnown === wasKnown) return;   /* still unknown: leave it alone */
      fn(nowKnown, c, cp, l);
    });
    load();
  }

  return {
    load: load,
    paint: paint,
    known: known,
    claimed: claimed,
    cap: cap,
    left: left,
    open: open,
    ASK_MS: ASK_MS,
    DEFAULT_CAP: DEFAULT_CAP
  };
})();
