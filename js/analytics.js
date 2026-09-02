/* ==========================================================================
   Factbox — analytics.

   One file owns the whole thing: loading PostHog, bridging the events the site
   already names, measuring how long each card is actually on screen, and the
   notice that tells a reader it is happening.

   Nothing else on the site knows PostHog exists. `FB.track()` in gate.js and
   `track()` on the illustrated story both route through here, so the 26 event
   names that were already wired keep working unchanged and there is exactly
   one place to swap the vendor.

   ---------------------------------------------------------------------------
   Consent

   PostHog persists an id, which under EU/UK rules is not "strictly necessary"
   and therefore needs consent. This ships opt-OUT: capture starts immediately
   and a dismissible notice explains it, with a working opt-out on the privacy
   page. That is the common US posture and it is not the strict EU one.

   To make it strict opt-IN — nothing captured until a reader agrees — set
   OPT_IN_REQUIRED to true below. Everything else is already written for it.
   ========================================================================== */

(function () {
  "use strict";

  var KEY  = "phc_CzcoLdwsVBHS8WwahoCcZW49vyWQ2VzvYWYra5TUDaPP";
  var HOST = "https://us.i.posthog.com";

  var OPT_IN_REQUIRED = false;   /* true = capture nothing until agreed */
  var NOTICE_KEY = "fb_analytics_notice_v1";
  var OPTOUT_KEY = "fb_analytics_optout_v1";

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v); return v;
    } catch (e) { return null; }
  }

  /* A reader who has opted out is never measured, and the loader never runs. */
  if (ls(OPTOUT_KEY) === "1") {
    window.FBQ = { capture: function () {}, optedOut: function () { return true; },
                   optOut: function () {}, optIn: function () {} };
    return;
  }

  /* ---- PostHog loader (their published snippet, unmodified) ------------- */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister identify setPersonProperties reset group opt_in_capturing opt_out_capturing has_opted_out_capturing get_distinct_id get_session_id onFeatureFlags isFeatureEnabled getFeatureFlag debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  try {
    posthog.init(KEY, {
      api_host: HOST,
      defaults: "2026-05-30",
      person_profiles: "identified_only",
      /* The reader is mid-story on a phone; a lost event costs less than a
         stalled main thread. */
      capture_pageleave: true,
      opt_out_capturing_by_default: OPT_IN_REQUIRED
    });
  } catch (e) {}

  function capture(name, props) {
    try {
      if (window.posthog && posthog.capture) posthog.capture(name, props || {});
    } catch (e) {}
  }

  /* ---- Bridge the events the site already names ------------------------ *
     gate.js's FB.track and the illustrated story's global track() both existed
     before any vendor did. Wrapping them here means the 26 names keep working
     and no other file learns what PostHog is. */
  function bridge() {
    try {
      if (window.FB && FB.track && !FB.track.__fbq) {
        var prev = FB.track;
        var wrapped = function (name, extra) {
          try { prev(name, extra); } catch (e) {}
          capture(name, extra || {});
        };
        wrapped.__fbq = true;
        FB.track = wrapped;
      }
    } catch (e) {}
    try {
      if (typeof window.track === "function" && !window.track.__fbq) {
        var prevT = window.track;
        var wrappedT = function (name, extra) {
          try { prevT(name, extra); } catch (e) {}
          capture(name, extra || {});
        };
        wrappedT.__fbq = true;
        window.track = wrappedT;
      }
    } catch (e) {}
  }
  bridge();
  /* The inline page scripts define these after this file runs, so try again
     once the document is parsed and once more after first paint. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bridge);
  }
  setTimeout(bridge, 0);
  setTimeout(bridge, 1200);

  /* ---- How long a card was actually on screen -------------------------- *
     Both readers already mark the card in view with `live` — the same class
     that drives the animation and the sound. So dwell needs no cooperation
     from either page: watch that one attribute and time it.

     Reported on leaving the card, so a reader who stops reading mid-story
     still produces a measurement for the card they stopped on. */
  var current = null, since = 0;

  function stamp() {
    if (!current) return;
    var ms = Date.now() - since;
    /* Under a second is a swipe passing through, not reading. */
    if (ms >= 900 && ms < 1000 * 60 * 30) {
      capture("card_view", {
        story: current.getAttribute("data-stack") || current.getAttribute("data-story") || "01",
        card: Number(current.getAttribute("data-card") || current.dataset && current.dataset.i || 0),
        beat: current.getAttribute("data-beat") || "",
        topic: current.getAttribute("data-topic") || "",
        dwell_ms: ms,
        dwell_s: Math.round(ms / 100) / 10
      });
    }
    current = null;
  }

  function onLive() {
    var el = document.querySelector(".beat.live, .page.live");
    if (el === current) return;
    stamp();
    if (el) { current = el; since = Date.now(); }
  }

  try {
    var mo = new MutationObserver(onLive);
    mo.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: ["class"]
    });
  } catch (e) {}
  setTimeout(onLive, 400);

  /* Leaving the page is the commonest way a card stops being read. */
  addEventListener("pagehide", stamp);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") stamp();
  });

  /* ---- The notice ------------------------------------------------------ */
  function notice() {
    if (ls(NOTICE_KEY) === "1") return;
    if (!document.body) { setTimeout(notice, 300); return; }
    var d = document.createElement("div");
    d.className = "fbq-notice";
    d.setAttribute("role", "note");
    d.innerHTML =
      '<span>We measure which stories people finish, to make better ones. ' +
      'No ads, no selling data. <a href="privacy.html">How it works</a>.</span>' +
      '<button type="button">Got it</button>';
    d.querySelector("button").addEventListener("click", function () {
      ls(NOTICE_KEY, "1");
      d.parentNode && d.parentNode.removeChild(d);
    });
    document.body.appendChild(d);
  }
  setTimeout(notice, 2500);

  window.FBQ = {
    capture: capture,
    optedOut: function () { return ls(OPTOUT_KEY) === "1"; },
    optOut: function () {
      ls(OPTOUT_KEY, "1");
      try { if (window.posthog && posthog.opt_out_capturing) posthog.opt_out_capturing(); } catch (e) {}
    },
    optIn: function () {
      try { localStorage.removeItem(OPTOUT_KEY); } catch (e) {}
      try { if (window.posthog && posthog.opt_in_capturing) posthog.opt_in_capturing(); } catch (e) {}
    }
  };
})();
