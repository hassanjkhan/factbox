/* ==========================================================================
   Factbox — access gate and shared helpers.

   HONEST LIMITATION, stated here so nobody is surprised later: this site is
   static files on GitHub Pages. There is no server, so there is no way to
   actually withhold the text — data/stacks.json is fetchable by anyone who
   opens dev tools. This gate is a product surface, not a security boundary.
   It is the right trade for a launch test (does anyone pay at all?) and the
   wrong one for a real subscription business. Turning it into a real gate
   means a server that checks a Stripe customer before serving the content.
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

  /* Stripe sends the buyer back to ?unlocked=1 on success. */
  function claim() {
    if (location.search.indexOf("unlocked=1") === -1) return;
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

  var _cache = null;
  function load() {
    if (_cache) return _cache;
    _cache = fetch("/data/stacks.json", { cache: "force-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) { return d.stacks; });
    return _cache;
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
    if (cr && cr.license) {
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
           unlocked: unlocked, checkout: checkout,
           track: track, load: load, esc: esc, creditLine: creditLine,
           minutes: minutes };
})();
