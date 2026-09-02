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

  /* Stripe Payment Link — a hosted checkout URL. No server and no API key,
     which is the only reason a static site can take money at all.
     Set this to the link from the Stripe dashboard, and set that link's
     success URL to  https://factbox.app/stories.html?unlocked=1  */
  var PAY_URL = "";

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

  function unlocked() { return store(KEY) === "1"; }

  /* One place decides what a click on any buy button does, so the button can
     never silently do nothing — a dead button reads as a broken site. */
  function checkout(btn) {
    track("subscribe_click");
    if (PAY_URL) { location.href = PAY_URL; return; }
    if (btn) {
      btn.textContent = "Not taking payments yet";
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
    _cache = fetch("data/stacks.json", { cache: "force-cache" })
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

  return { PAY_URL: PAY_URL, unlocked: unlocked, checkout: checkout,
           track: track, load: load, esc: esc, creditLine: creditLine,
           minutes: minutes };
})();
