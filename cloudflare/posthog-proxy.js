/* ==========================================================================
   factbox.app — first-party PostHog proxy (Cloudflare Worker)

   WHAT IT DOES
   Serves PostHog from our own domain. Everything under

       https://factbox.app/ink/*

   is forwarded to PostHog and the answer handed back, so to the browser the
   analytics traffic is same-origin first-party traffic to factbox.app. Two
   upstreams, chosen by path:

       /ink/static/…   ->  us-assets.i.posthog.com/static/…   (array.js,
       /ink/array/…    ->  us-assets.i.posthog.com/array/…     recorder.js,
                                                               remote config)
       everything else ->  us.i.posthog.com/…                 (/e/, /i/v0/e/,
                                                               /flags/, /s/ …)

   The /ink prefix is stripped before forwarding: /ink/e/ becomes /e/.

   WHY IT EXISTS
   Blocker lists (EasyPrivacy, uBlock, Brave, and the ones baked into the
   Instagram and TikTok in-app browsers) match PostHog by hostname —
   *.i.posthog.com and *-assets.i.posthog.com. PostHog's own dashboard puts
   the loss at 10-25% of events. This site's readers arrive almost entirely
   through those in-app browsers on phones, so that is the worst case, not the
   average one. A request to factbox.app matches no list, because the list
   cannot know what factbox.app/ink is without blocking the site itself.

   This follows PostHog's documented Cloudflare pattern
   (posthog.com/docs/advanced/proxy/cloudflare). Two deliberate departures:

     1. A PATH on the apex domain, not a subdomain. A subdomain (e.factbox.app)
        would need its own DNS record and its own certificate, and a subdomain
        that exists only to carry analytics is itself a fingerprint. A path on
        the site's own origin is indistinguishable from the site.

     2. The prefix is /ink, not /analytics or /ph. PostHog's docs are explicit
        that obvious names get list-matched on the path instead. /ink is the
        site's own vocabulary and collides with nothing it serves.

   WHY A WORKER AND NOT CLOUDFLARE RULES
   Rules cannot do this on the current plan. A URL Rewrite Rule can strip the
   /ink prefix (free), but sending the request to a DIFFERENT origin needs
   Origin Rules' Resolve Override / Host Header Override, which is a Business
   and Enterprise feature. The DNS + Page Rules route in PostHog's own docs
   carries the same "Cloudflare Enterprise plan" prerequisite. Nothing on the
   free plan can retarget the origin, so a Worker it is. It also buys the two
   things below, which Rules could not express anyway.

   WHAT THIS WORKER DOES THAT A DUMB PASS-THROUGH WOULD NOT

     - Strips the Cookie header before forwarding. factbox.app carries Firebase
       auth cookies on its own origin, and /ink/* is on that origin, so the
       browser attaches them to every ingestion request. PostHog has no use for
       them and must not receive them. This is the one line here that is a
       security control rather than plumbing.

     - Sets X-Forwarded-For from CF-Connecting-IP, so PostHog geolocates the
       reader rather than a Cloudflare edge node. Without it every reader
       appears to be in the datacentre nearest them.

     - Caches asset responses at the edge. array.js is ~270KB and identical for
       every reader; it should be served from the colo, not fetched from
       PostHog per page view.

   NOT SECRET
   Nothing in this file is a credential. The PostHog project token never
   appears here — the browser sends it in the request body, and this Worker
   does not read or need it.

   DEPLOY / VERIFY: see cloudflare/README.md in this repo.
   ========================================================================== */

const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";

/* Must match PROXY_PATH in js/analytics.js. Change one, change both. */
const PREFIX = "/ink";

/* Paths under the prefix that are static files rather than ingestion. */
const ASSET_PATHS = ["/static/", "/array/"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* The route pattern should mean this is always true. If a route is ever
       widened by accident, pass the request to the real origin (GitHub Pages)
       untouched rather than forwarding the whole site to PostHog. */
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) {
      return fetch(request);
    }

    /* /ink/e/ -> /e/ , /ink -> / */
    const path = url.pathname.slice(PREFIX.length) || "/";
    const pathWithSearch = path + url.search;

    const isAsset = ASSET_PATHS.some((p) => path.startsWith(p));
    return isAsset
      ? retrieveAsset(request, pathWithSearch, ctx)
      : forwardRequest(request, pathWithSearch);
  },
};

/* ---- static assets: array.js, recorder.js, remote config ------------------
   Cached in the colo so one reader's fetch serves the next reader's. The cache
   key is the incoming request, so it is already scoped to this domain and
   path. Only successful GETs are stored: caching a 404 from a half-deployed
   Worker would pin the outage for as long as the edge kept it. */
async function retrieveAsset(request, pathWithSearch, ctx) {
  if (request.method !== "GET") {
    return forwardTo(request, ASSET_HOST, pathWithSearch);
  }

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(`https://${ASSET_HOST}${pathWithSearch}`, {
    headers: passthroughHeaders(request),
  });

  if (response.ok) {
    /* cache.put rejects on some responses (Set-Cookie, 206, …). A failure to
       cache is not a failure to serve. */
    try {
      ctx.waitUntil(cache.put(request, response.clone()));
    } catch (e) {}
  }
  return response;
}

/* ---- ingestion: /e/, /i/v0/e/, /flags/, /s/ ------------------------------ */
async function forwardRequest(request, pathWithSearch) {
  return forwardTo(request, API_HOST, pathWithSearch);
}

async function forwardTo(request, host, pathWithSearch) {
  const headers = new Headers(request.headers);

  /* Same-origin means the browser attached this site's cookies. PostHog is a
     third party; it does not get them. */
  headers.delete("cookie");

  /* Cloudflare rewrites Host on the outgoing fetch, but a stale Host header
     copied from the incoming request confuses some upstreams. Let fetch set it. */
  headers.delete("host");

  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Forwarded-For", ip);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  const originRequest = new Request(`https://${host}${pathWithSearch}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : null,
    redirect: request.redirect,
  });

  return fetch(originRequest);
}

function passthroughHeaders(request) {
  const headers = new Headers();
  /* Only what actually changes the bytes returned. Everything else — cookies
     included — is dropped. */
  for (const name of ["accept", "accept-encoding", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
