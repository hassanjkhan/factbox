/* ==========================================================================
   Factbox — access gate and shared helpers.

   THAT LIMITATION IS FIXED, and the note is kept because the shape of the
   fix is worth knowing. This used to say: the site is static files on GitHub
   Pages, there is no server, so there is no way to actually withhold the
   text — data/stacks.json is fetchable by anyone who opens dev tools, and
   this gate is a product surface, not a security boundary. All of that was
   true and it meant the entire paid season was one URL away from anybody.

   There is a server now. functions/story.js serves one story per request,
   verifies the caller's Firebase ID token and reads customers/{uid}.premium
   out of Firestore before it hands over a card. No file under data/ carries
   the body text of a story anyone has to pay for; tools/check-regressions.js
   fails the build if one ever does again.

   So this file is still a product surface — it decides what a reader SEES,
   which screen, which offer — and it is no longer the only thing standing
   between a stranger and the corpus. What it must get right is the routing
   below: free text from a static file, everything else from the function,
   with the token attached, and a refusal drawn as the paywall.
   ========================================================================== */

var FB = (function () {

  /* The buy button no longer goes straight to Stripe.

     It used to: one Payment Link, asked for at the end of a story or on a
     locked cover, before the reader had told us anything or we had told them
     anything. Money was the first question.

     Now money is the last one. Every buy CTA on the site routes here, and
     here routes into the funnel: sign up or log in, three short onboarding
     questions, then a plan screen with the three prices and a 3-day trial.
     The Stripe Payment Links themselves — one per plan — live at the top of
     js/account.js with the instructions for creating them, because that is
     also where the price ladder they have to match is defined. One file
     holds the money.

     PAY_URL stays exported and empty so anything still reading FB.PAY_URL
     keeps a defined value rather than undefined. Nothing should read it. */
  var PAY_URL  = "";
  var JOIN_URL = "/join";

  var KEY = "fb_unlocked_v1";

  function store(k, v) {
    /* Private mode and some in-app webviews throw on write, not on read, so
       every access is guarded and the page works with no storage at all. */
    try { if (v === undefined) return localStorage.getItem(k);
          localStorage.setItem(k, v); return v; } catch (e) { return null; }
  }

  /* Stripe sends the buyer back to ?unlocked=1 on success.

     A PARAMETER, NOT A SUBSTRING. This was indexOf("unlocked=1"), which is
     true of any query string containing those ten characters ANYWHERE — as a
     value, inside an encoded `next=`, in a campaign tag, in a referrer someone
     pasted. Measured: /explore?ref=not_unlocked=1 minted the flag and the
     signed-out reader got all fifty-one stories and "You have all fifty-one."
     One ordinary-looking link gave the season away permanently, on any browser
     that ever loaded it, which is as intermittent as a bug gets.

     js/progress.js's own claim() has always parsed the query properly and
     tested Q.unlocked === "1". This is the same test, done here too, so the
     two files cannot disagree about whether a buyer came back from Stripe.

     ES5: no URLSearchParams. */
  function claim() {
    if (!/[?&]unlocked=1(&|$)/.test(String(location.search || ""))) return;
    store(KEY, "1");
    try {
      history.replaceState({}, "", location.pathname + location.hash);
    } catch (e) {}
  }
  claim();

  /* Access is decided in one place: js/access.js. This used to answer the
     question itself, which is how the site ended up with four answers and
     three bugs. FBX is guarded because a page may not load it. */
  function unlocked() {
    try {
      if (window.FBX && FBX.can) return FBX.can();
    } catch (e) {}
    return store(KEY) === "1";
  }

  /* --- Back, ten seconds after paying ------------------------------------

     REPORTED: buy, land on the shelf with all fifty-one open, tap Back inside
     the first few seconds — and the browser hands back the pre-purchase page,
     every padlock and "Trade five minutes of scrolling" included. The
     purchase looks undone. A refresh brings it back, which is worse than
     useless: by then the reader has decided the site took their money.

     Nothing on that page is stale in the ordinary sense. The back/forward
     cache does not re-run a page, it thaws one: the DOM, the heap, and every
     answer this file worked out at load are exactly as they were when the
     reader left, and no script gets a turn to notice that the world moved
     underneath them. The single event that does fire is pageshow with
     event.persisted true. That is the whole hook, and this is it.

     So the gate is ASKED AGAIN there — of storage, which is live, rather than
     of the painted DOM, which is a photograph — and the page is corrected
     only when the answer has actually got better since it was painted:

       painted locked, now unlocked   the purchase, or a restore link opened
                                      in another tab. Correct it.
       anything else                  leave the page alone.

     That is the site's render-then-correct rule in its bfcache form: the
     direction this fires in is towards showing MORE, never less. It cannot
     put a padlock on a page that is not wearing one.

     WHY A RELOAD AND NOT A REPAINT IN PLACE. The padlocks belong to the shelf
     that drew them, and this file does not own that markup. Reaching into it
     from here would put a second, competing renderer on the page, which is
     the exact shape of bug js/access.js exists to end. A reload is the same
     correction FBX.correct() makes when a better answer lands late, and it is
     what the reader already gets by pulling to refresh — measured working.

     WHY THIS DOES NOT COST EVERYONE THEIR BACK BUTTON. bfcache is not turned
     off. A pageshow listener does not disqualify a page from it; an unload or
     beforeunload listener would, and there is none anywhere on this site. So
     every ordinary back-navigation still thaws instantly. The only reader who
     ever pays for a reload here is the one whose access changed while the
     page was frozen, and they are paying it to be given what they bought.

     IT CANNOT LOOP, and the guard is not a flag anybody has to remember to
     set. `painted` is read once, at parse time, from the same storage: after
     the reload it is true, so the condition is dead for the life of that
     page. Reaching it a second time needs the flag to go back to 0 and up
     again, which is a sign-out followed by a fresh unlock — a correction that
     is owed. ES5 and wrapped throughout: a webview that fires no pageshow, or
     refuses a reload, is one where nothing here happens at all. */

  function unlockedRaw() {
    /* Deliberately NOT unlocked() above. That one asks js/access.js, whose
       answer is computed from an account state frozen at the same instant as
       the DOM — it would say "no" on exactly the page this is here to fix.
       The stored flag is the thing that actually changed under the snapshot,
       and FBP reads both stores, so a webview that kept only the cookie still
       gets its answer. */
    try {
      if (window.FBP && FBP.unlocked) return !!FBP.unlocked();
    } catch (e) {}
    return store(KEY) === "1";
  }

  var painted = unlockedRaw();

  /* Exported so the behaviour can be driven in a harness that has no back
     button. recheck(true) is "the browser just thawed this page". */
  function recheck(persisted) {
    if (!persisted) return false;
    if (painted) return false;              /* nothing has changed */
    if (!unlockedRaw()) return false;       /* still no access; leave it be */
    painted = true;                         /* one correction per page, ever */
    try {
      setTimeout(function () { try { location.reload(); } catch (e) {} }, 0);
    } catch (e2) {
      try { location.reload(); } catch (e3) {}
    }
    return true;
  }

  try {
    addEventListener("pageshow", function (ev) {
      try { recheck(!!(ev && ev.persisted)); } catch (e) {}
    }, false);
  } catch (e) {}

  /* joinURL(from) — the funnel entrance, with a note of where the reader was
     when they asked. Relative, so it works on factbox.app, on a preview
     origin and on a local server without a build step.

     Not URLSearchParams: it is absent on the older in-app webviews this site
     targets, and this is a top-level-reachable path. */
  function joinURL(from) {
    var u = JOIN_URL;
    try {
      var f = String(from == null ? "" : from).replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
      if (f) u += "?from=" + f;
    } catch (e) {}
    return u;
  }

  /* One place decides what a click on any buy button does, so the button can
     never silently do nothing — a dead button reads as a broken site.

     join.html is a static file that is always there, so unlike a Payment Link
     that may not have been created yet, this can never be empty. The honest
     "we are not taking payments yet" message still exists; it has moved to
     the plan screen, where it can explain itself instead of turning a button
     into a dead end. */
  function checkout(btn, from) {
    track("subscribe_click", from ? { from: from } : undefined);
    try {
      location.href = joinURL(from);
      return;
    } catch (e) {}
    /* location refused to move — the only case left is a webview in a state
       no button text can fix, so say what happened rather than nothing. */
    if (btn) {
      btn.textContent = "Open factbox.app/join.html to sign up";
      btn.disabled = true;
    }
  }

  function track(name, extra) {
    try {
      if (window.plausible) window.plausible(name, extra ? { props: extra } : undefined);
    } catch (e) {}
  }

  /* --- the corpus, and which half of it a browser may have ---------------

     data/stacks.json used to be fetched right here: 413KB, every word of all
     fifty-one stories, served by GitHub Pages to anyone who typed the URL.
     The gate above was a product surface and this was the hole underneath it
     — the whole paid season, free, no account, one request. That file is no
     longer published. The corpus lives at content/stacks.json, untracked
     (see .gitignore), as the build input for tools/seed-firebase.js and
     tools/split-stacks.js.

     What a browser can still fetch, and why each one is safe:

       data/index.json       every stack, with each card reduced to
                             { n, head }. Headlines, covers, credits,
                             durations, the cover hook: the pitch. A locked
                             story is still sold on it, and none of it is
                             what a subscriber is paying for.

       data/story/<ID>.json  ONE FILE PER PERMANENTLY FREE STORY, and nothing
                             else ever gets one. 01 and 02 are the top of the
                             funnel: free to everybody forever, wanted by
                             signed-out readers on /firststory and the
                             composed pages, and worth serving from a cache
                             that works offline.

     Every other story — the other forty-nine, and today's rotating free one
     — comes from functions/story.js, one story per request, with this
     reader's Firebase ID token on it. That function verifies the signature
     and reads customers/{uid}.premium out of Firestore itself before any
     card leaves the building; it also decides from the SERVER's clock which
     story is free today. Nothing in this file can grant access and nothing
     here tries to. It asks, and it renders whichever answer comes back:
     a 200 is a read this reader is entitled to, a 401 or 403 is the paywall.
     ---------------------------------------------------------------------- */

  /* The story endpoint. One URL, here, because js/gate.js is the only file
     that fetches story text. The gen-2 function answers on both its Cloud Run
     hostname and .../us-central1-factbox-7cb97.cloudfunctions.net/story;
     this is the one functions/story.js is deployed as. */
  var STORY_FN = "https://story-b3xuodosjq-uc.a.run.app";

  /* How long to wait for Firebase to say who is holding the phone before
     asking the function anyway. A subscriber whose token is not ready yet
     would be told 401 and shown a wall they have paid to pass, so this wait
     is worth having; a signed-out reader on today's free story must not be
     made to sit behind it, so it is capped. */
  var TOKEN_WAIT_MS = 4000;

  function getJSON(url) {
    return fetch(url, { cache: "force-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  /* Two failures, told apart, because they are two different screens.
       .locked   the server refused: the reader may not read this. Paywall.
       .offline  we never got an answer. "Check your connection." */
  function lockedErr(status) {
    var e = new Error("locked");
    e.locked = true; e.status = status;
    return e;
  }
  function offlineErr(why) {
    var e = new Error("unreachable: " + (why && why.message ? why.message : why));
    e.offline = true;
    return e;
  }

  /* Every stack, without the card bodies. Shelves want this; nothing that
     renders card text should. There is no monolith to fall back to any more,
     so a failure here is a real failure and says so — and the cached promise
     is dropped on the way out, so the next caller retries rather than
     inheriting one bad minute forever. */
  var _index = null;
  function loadIndex() {
    if (_index) return _index;
    _index = getJSON("/data/index.json")
      .then(function (d) {
        if (!d || !d.stacks || !d.stacks.length) throw new Error("empty index");
        return d.stacks;
      })
      .catch(function (e) { _index = null; throw offlineErr(e); });
    return _index;
  }

  /* FB.load() used to resolve with every word of the corpus. Nothing may have
     that any more, so it resolves with the index: every stack, every cover
     field, no card text. Its callers — join.html, js/today.js, read.html's
     fallback — all use it to LIST stories, which the index does exactly as
     well. It stays exported rather than deleted because a page can be fresh
     while a cached copy of it is not, and `FB.load is not a function` on a
     shipped page is a blank screen. */
  function load() { return loadIndex(); }

  function findStack(stacks, want) {
    for (var i = 0; i < stacks.length; i++) {
      if (String(stacks[i].id).toUpperCase() === want) return stacks[i];
    }
    return null;
  }

  /* An ID token if there is one going, "" if there is not.

     Waits for Firebase to settle first. js/auth.js publishes FBU.ready(),
     which resolves once the SDK knows whether anybody is signed in; asking
     for a token before that resolves gets null from a subscriber and earns
     them a 401 on a story they pay for. Capped at TOKEN_WAIT_MS so a reader
     whose auth never answers still gets today's free story. */
  function withToken(cb) {
    var done = false, timer = null;
    function go(t) {
      if (done) return;
      done = true;
      try { if (timer) clearTimeout(timer); } catch (e) {}
      cb(t || "");
    }
    var U = null;
    try { U = window.FBU; } catch (e) {}
    if (!U || typeof U.user !== "function") { go(""); return; }
    try { timer = setTimeout(function () { go(""); }, TOKEN_WAIT_MS); } catch (e) {}

    function ask() {
      var u = null;
      try { u = U.user(); } catch (e) {}
      if (!u || typeof u.getIdToken !== "function") { go(""); return; }
      try {
        u.getIdToken().then(function (t) { go(String(t || "")); },
                            function () { go(""); });
      } catch (e) { go(""); }
    }

    try {
      if (typeof U.ready === "function") { U.ready().then(ask, ask); return; }
      if (typeof U.onReady === "function") { U.onReady(ask); return; }
    } catch (e) {}
    ask();
  }

  /* One story, from the function that is allowed to decide.

     Resolves with the stack, resolves with null if there is no such story,
     rejects .locked on a refusal and .offline on anything else. The token is
     attached when there is one and left off when there is not — an anonymous
     request is a legitimate read of a free story, and today's free story
     comes back 200 to nobody in particular. */
  function fromFunction(want) {
    return new Promise(function (resolve, reject) {
      withToken(function (tok) {
        var opts = { method: "GET", cache: "no-store" };
        if (tok) opts.headers = { Authorization: "Bearer " + tok };
        fetch(STORY_FN + "?id=" + encodeURIComponent(want), opts)
          .then(function (r) {
            if (r.status === 401 || r.status === 403) {
              reject(lockedErr(r.status));
              return null;
            }
            if (r.status === 404) { resolve(null); return null; }
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json().then(function (d) {
              /* The function answers { ok, id, access, story }. The static
                 files answer { stack }. Accept either, so neither shape is
                 something the caller has to know about. */
              var st = d && (d.story || d.stack);
              if (!st || !st.cards || !st.cards.length) {
                throw new Error("empty story");
              }
              resolve(st);
              return null;
            });
          })
          .catch(function (e) {
            /* A rejection that has already happened is a no-op here; this is
               for the ones that have not. */
            reject(e && (e.locked || e.offline) ? e : offlineErr(e));
          });
      });
    });
  }

  function fromStatic(want) {
    return getJSON("/data/story/" + want + ".json").then(function (d) {
      var st = d && d.stack;
      if (!st || !st.cards || !st.cards.length) throw new Error("empty story");
      return st;
    });
  }

  /* One story, complete — for a reader who is allowed to have it.

     ROUTING, and it is the whole point of this file now:

       permanently free (`free: true` in data/index.json) -> the static file.
         Fast, cacheable, offline, and what /firststory and the composed
         pages serve. Its existence IS the free flag: tools/split-stacks.js
         writes a file for no other kind of story.

       anything else -> functions/story.js, with the token.

     Today's rotating free story is deliberately NOT decided here. js/access.js
     carries a note about the last time this arithmetic was done in a browser:
     the reader's own clock picked the free story, so moving the clock moved
     which story was free. The function works it out from the server's clock
     and hands the text over — or does not. A 200 to an anonymous caller IS
     the free read; a 401 is the wall.

     Resolves with the stack, or null for an id that is not in the season —
     which is a different answer from "the fetch failed", and the reader page
     renders a different screen for each. */
  function loadStory(id) {
    var want = String(id == null ? "" : id).toUpperCase();
    /* The id becomes a path segment and a query value, so only the characters
       ids actually use may reach either. Anything else is not a story. */
    if (!want || !/^[A-Z0-9_-]{1,24}$/.test(want)) return Promise.resolve(null);

    /* read.html issues the free-story request from its <head>, before this
       file has been fetched. Adopting that promise is a round trip earlier on
       a cold webview, and it is the same request rather than a second one.
       It is only ever issued for a story that has a file, so a resolved one
       is proof of a permanently free story and needs no index lookup. */
    var pre = null;
    try {
      if (window.FB_STORY_PRE && window.FB_STORY_PRE.id === want
          && window.FB_STORY_PRE.p) pre = window.FB_STORY_PRE.p;
    } catch (e) {}
    if (pre) {
      return pre.then(function (d) {
        var st = d && d.stack;
        if (!st || !st.cards || !st.cards.length) throw new Error("empty story");
        return st;
      }).catch(function () { return route(want); });
    }
    return route(want);
  }

  function route(want) {
    return loadIndex().then(function (stacks) {
      var meta = findStack(stacks, want);
      if (!meta) return null;                       /* not in this season */
      /* `=== true`, never truthy: this test decides whether a request for
         text goes to a public file or to the thing that checks the reader. */
      if (meta.free === true) {
        return fromStatic(want).catch(function () { return fromFunction(want); });
      }
      return fromFunction(want);
    }, function () {
      /* The index did not arrive. The function is the authority on access
         anyway, so ask it rather than giving up: a free story still opens and
         a paid one still gets its 401. */
      return fromFunction(want);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* One credit line per plate. The share-alike and attribution plates require
     the licence named and linked; the public-domain ones just get the caption. */
  function creditLine(cap, cr) {
    var bits = [];
    if (cap) bits.push(esc(cap));
    /* Only the plates that actually carry terms name their photographer.
       CC0 and "No restrictions" are public-domain-equivalent, so the tier
       decides this, never the licence string. */
    if (cr && cr.credit && cr.tier && cr.tier !== "public_domain"
        && String(cap || "").indexOf(cr.credit) === -1) {
      bits.push(esc(cr.credit));
    }
    var out = bits.join(" · ");

    /* The licence is named only where naming it is the obligation.

       A public-domain plate carries no condition at all, so "Public domain"
       under a painting is a fact about copyright law rather than anything a
       reader came here for — it reads as a disclaimer on work we chose. The
       artist still gets their name.

       The other 34 plates are CC BY or CC BY-SA, where naming and linking the
       licence is the term that makes using them lawful. That stays, on the
       card, not just on the credits page. Removing it would not be a tidier
       design, it would be using someone's photograph against its terms. */
    if (cr && cr.license && cr.tier && cr.tier !== "public_domain") {
      var lic = cr.licenseUrl
        ? '<a href="' + esc(cr.licenseUrl) + '" target="_blank" rel="noopener">' + esc(cr.license) + '</a>'
        : esc(cr.license);
      out += (out ? " · " : "") + lic;
    }
    return out;
  }

  /* Half-minute steps, because whole minutes hide the story.

     Every story here runs between about 90 seconds and two and a half minutes,
     so rounding to the nearest minute labelled 49 of 51 of them "2 min" — the
     one number a reader wants from that line, carrying no information at all.
     Half-minutes are the honest maximum resolution for content this length. */
  function minutes(secs) {
    var halves = Math.max(1, Math.round((Number(secs) || 0) / 30));
    var whole = Math.floor(halves / 2);
    if (whole === 0) return "\u00bd min";
    return whole + (halves % 2 ? "\u00bd" : "") + " min";
  }

  return { PAY_URL: PAY_URL, JOIN_URL: JOIN_URL, joinURL: joinURL,
           unlocked: unlocked, recheck: recheck, checkout: checkout,
           track: track, load: load, loadIndex: loadIndex, loadStory: loadStory,
           esc: esc, creditLine: creditLine,
           minutes: minutes };
})();
