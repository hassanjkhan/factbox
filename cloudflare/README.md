# Cloudflare — first-party PostHog proxy

`posthog-proxy.js` makes analytics look like the site. Everything the PostHog
SDK does — loading `array.js`, fetching remote config, sending events — goes to
`https://factbox.app/ink/…`, which Cloudflare forwards to PostHog. Blocker
lists match `*.i.posthog.com` by hostname; they cannot match this without
blocking factbox.app.

---

## STATUS — as of 2026-09-10 this proxy is NOT live, and the switch is OFF

`js/analytics.js` has `var PROXY_ENABLED = false`, so it starts PostHog on
`us.i.posthog.com` directly and **never requests `/ink/…` at all**. Analytics
work; they are just back to losing the 10–25% of events that blockers eat.

It was turned off because the proxy could not work and was 404ing on every
page load. The evidence, which anyone can re-run:

```sh
dig +short factbox.app
#   185.199.108.153 … 185.199.111.153     <- GitHub Pages IPs, not Cloudflare's

curl -sI https://factbox.app | grep -i 'server\|cf-ray'
#   server: GitHub.com                    <- no cf-ray, no cloudflare
```

The zone IS on Cloudflare (`dig +short factbox.app NS` → `faye`/`pranab
.ns.cloudflare.com`), but the apex record is **grey-cloud "DNS only"**.
Requests never enter Cloudflare's edge, so the Worker route cannot fire
whether or not the Worker is deployed. Every `/ink/static/array.js` fell
through to GitHub Pages as a 404, and `js/analytics.js` fell back — correctly,
but only after paying for a doomed round trip on every page view.

**Fixing this needs the owner's Cloudflare dashboard access.** Nothing in this
repo can do it. See "Before you start", then flip the switch in step 8.

---

## Before you start

**The `factbox.app` DNS record must be Proxied (orange cloud).** Worker routes
only run on proxied records; on a grey-cloud "DNS only" record the route is
silently ignored and every `/ink/…` request falls through to GitHub Pages as a
404. Check under **DNS → Records** for `factbox.app` and `www`.

**This is the thing that is currently wrong.** Both records are grey-cloud
today. Toggling them to Proxied is step zero; the rest of this page is a
no-op until it is done.

Workers routes are on the free plan. Ingestion counts against the free Worker
allowance (100,000 requests/day); at this site's traffic that is not close.

---

## Deploy — the click path

1. Cloudflare dashboard → left sidebar **Compute (Workers)** → **Workers & Pages**.
2. **Create** → **Workers** → **Start with Hello World!** → **Deploy**.
   - Name it `posthog-proxy`. The name is cosmetic; the route is what matters.
   - Deploying the placeholder first is deliberate — a Worker has to exist
     before it can be given a route.
3. On the Worker's page: **Edit code** (`</>` icon, top right).
4. Select everything in `worker.js` and replace it with the **entire contents
   of `cloudflare/posthog-proxy.js` from this repo**. Paste the comment header
   too; the next person to open this needs it.
5. **Deploy** → **Save and deploy**.
6. Back on the Worker's page: **Settings** → **Domains & Routes** → **Add** →
   **Route**.
   - Zone: `factbox.app`
   - Route: `factbox.app/ink/*`
   - Failure mode: **Fail open**. If the Worker errors, the request goes to the
     origin and 404s, which `js/analytics.js` treats as "proxy missing" and
     falls back. Fail closed would return a 5xx that behaves the same way, but
     fail open is the honest description of what should happen.
7. **Add** a second route the same way: `www.factbox.app/ink/*`.
   `js/analytics.js` builds the proxy URL from `location.origin`, so a reader
   who arrives on `www` uses the `www` route. Without it, `www` readers silently
   fall back to the direct host — which still works, and still gets blocked.

8. **Flip the switch in the site.** In `js/analytics.js` set

   ```js
   var PROXY_ENABLED = true;
   ```

   then `python3 tools/stamp-assets.py && python3 tools/compose.py` and deploy.
   Until this is flipped the site does not ask for `/ink/…` at all, so steps
   1–7 change nothing a reader can see. **Run verify step 1 below BEFORE
   flipping it** — if that curl is not a 200, flipping this just reinstates a
   404 on every page load.

That is the whole deploy. No environment variables, no secrets, no bindings.

---

## Verify — run these, in order

**1. Assets are proxied.** Should be `200` and about 270 KB of JavaScript:

```sh
curl -s -o /dev/null -w "%{http_code} %{size_download} %{content_type}\n" \
  https://factbox.app/ink/static/array.js
```

Expect: `200 27xxxx text/javascript` (or `application/javascript`).
`404` here means the route is not attached, or the DNS record is grey-cloud.

**2. It is really PostHog's file**, not something else answering:

```sh
curl -s https://factbox.app/ink/static/array.js | grep -o 'LIB_VERSION="[0-9.]*"'
```

Expect: `LIB_VERSION="1.425.1"` (or newer — PostHog rolls this forward).

**3. Remote config is proxied** — this is the `/array/` path, which is a
different upstream branch in the Worker than `/static/`:

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://factbox.app/ink/array/phc_CzcoLdwsVBHS8WwahoCcZW49vyWQ2VzvYWYra5TUDaPP/config.js"
```

Expect: `200`.

**4. Ingestion is proxied.** This sends one real event into the production
project, named so it is obvious in the dashboard:

```sh
curl -s "https://factbox.app/ink/e/" \
  -H 'Content-Type: application/json' \
  -d '{"api_key":"phc_CzcoLdwsVBHS8WwahoCcZW49vyWQ2VzvYWYra5TUDaPP",
       "event":"proxy_smoke_test",
       "distinct_id":"proxy-check",
       "properties":{"via":"curl"}}'
```

Expect: `{"status":1}`.
Then PostHog → **Activity** and look for `proxy_smoke_test` from
`proxy-check` within about a minute. If step 1 passes and this does not, the
Worker is routing `/static/` but not ingestion — check that the route pattern
ends in `/*` and not `/static/*`.

**5. Cookies are not leaking to PostHog.** The Worker strips them; confirm the
site's own cookies exist and are therefore being attached by the browser, which
is what makes stripping necessary:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://factbox.app/ink/e/ \
  -H 'Cookie: pretend_session=leak' -H 'Content-Type: application/json' \
  -d '{"api_key":"phc_CzcoLdwsVBHS8WwahoCcZW49vyWQ2VzvYWYra5TUDaPP","event":"proxy_smoke_test","distinct_id":"proxy-check","properties":{}}'
```

Expect `200`. There is no way to observe the stripped header from outside; the
guarantee is the `headers.delete("cookie")` line in the Worker, which is why it
carries a comment saying so.

**6. In a real browser.** Open `https://factbox.app/read?s=02` with DevTools →
Network, filter `ink`. Expect requests to `factbox.app/ink/static/array.js` and
then `factbox.app/ink/e/` or `/ink/i/v0/e/`, and **no** request to
`us.i.posthog.com` or `us-assets.i.posthog.com`. In the console:

```js
FBQ.phVia()    // "proxy"   — "direct" means it fell back; "" means neither loaded
FBQ.phHost()   // "https://factbox.app/ink"
```

**7. With a blocker on.** Same page in Brave, or Chrome with uBlock Origin.
`FBQ.phVia()` should still be `"proxy"` and events should still leave. That is
the entire point of this Worker; if it reads `"direct"` or `""` under a blocker,
the path name has been listed and should be changed (in both
`js/analytics.js`'s `PROXY_PATH` and this Worker's `PREFIX`).

---

## If you change the path

`/ink` appears in exactly three places. All three must match:

| Where | What |
|---|---|
| `cloudflare/posthog-proxy.js` | `const PREFIX = "/ink"` |
| `js/analytics.js` | `var PROXY_PATH = "/ink"` |
| Cloudflare routes | `factbox.app/ink/*` and `www.factbox.app/ink/*` |

`tools/check-regressions.js` asserts the first two agree, so a path changed in
one place and not the other fails the precommit rather than silently 404ing.

Do not pick `/analytics`, `/track`, `/telemetry`, `/ph` or `/posthog`. PostHog's
own documentation warns that blocker lists match those paths regardless of the
domain they sit on, which would give back the problem the Worker exists to fix.

---

## Rolling it back

Set `PROXY_ENABLED = false` in `js/analytics.js`, restamp, deploy. The site
stops asking for `/ink/…` entirely and measurement continues on the direct
hosts at the pre-proxy hit rate. Then delete the two routes at leisure; the
Worker itself can be left deployed and unrouted.

Do it in that order. Deleting the routes first — or leaving `PROXY_ENABLED`
true with the DNS grey-clouded, which is the state this repo was found in —
still works, because `js/analytics.js` falls back within one script-error
event, but it puts a 404 on every page load in the meantime.
