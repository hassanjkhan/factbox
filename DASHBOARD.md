# The admin dashboard — `/admin/dashboard`

Three files: `admin/dashboard.html`, `css/dashboard.css`, `js/dashboard.js`.
Nothing else in the repo changed.

The contract it is built against is **`ANALYTICS-API.md`**. This file is the
other half: what each section on the page answers, which named query answers
it, what the page does when the answer does not come, and the four questions
the owner asked that the data cannot answer yet.

---

## 1 · Access, and why the gate is not the security

`js/auth.js` exposes `FBU.admin()`, read off the reader's own
`customers/{uid}` document. This page uses it to decide **what to draw**. It is
not what keeps anything safe, and it cannot be:

- factbox-site is a public repo served as static files. Everything in
  `js/dashboard.js` is delivered to every browser that asks for it.
- `FBU.admin()` is a boolean in a browser. A boolean in a browser is a boolean
  anyone can set from a console.

So assume a stranger opens `/admin/dashboard`, reads the source, and flips
every flag in it. **What they get is the layout.** What they do not get is
data, because there is no data in these three files and no route to any. Every
figure comes back from one POST to the `insights` function, which is handed a
Firebase ID token and verifies the admin claim server-side on every single
request.

The two checks fail closed in the same direction, and the server's is the one
that counts:

| What happens | What the page does |
|---|---|
| `FBU` never loaded (blocked, 404, browser ignores `type="module"`) | "We could not check who you are", with a reload and a way out |
| Signed out | "Sign in to see this", linking to `/login?next=/admin/dashboard` |
| Signed in, `FBU.admin()` false | "This account is not an admin" — no query is sent at all |
| `FBU.admin()` **true**, server answers `not_admin` | `deny()` — the drawn page is torn down, the queue is emptied, the refusal is shown |
| Signs out with the page open | `FBU.onChange` sends it back to the gate |

That fourth row is the one that matters. It is verified in a real browser: with
the browser flag lying, the page issues 2 requests, is refused, and shows the
refusal with `#dsh-main` hidden.

**The admin decision waits on `billingReady()`, not `ready()`.** `adminFlag` is
written by the same Firestore snapshot that answers the premium question, so it
is not known at `ready()`. Deciding earlier would show every admin the refusal
for a second and a half on every load. There is a 9-second backstop so a
promise that never settles cannot become a spinner that never stops.

**`<meta name="robots" content="noindex, nofollow">`.** Keep it. The page would
refuse to hand a stranger a number, but the section headings alone are a map of
the business, and `nofollow` because the links out of here name internal
routes.

---

## 2 · What each section answers, and what it calls

Eleven queries. A full render issues at most eleven requests, **two at a time**
through a queue in `js/dashboard.js` — `ANALYTICS-API.md` §5 caps an admin at
thirty a minute and explicitly asks for small batches rather than eleven at
once. Pressing Refresh mid-render bumps a generation counter and abandons the
rest of the old batch, so two renders cannot paint over each other.

| § | Section | Question | Query |
|---|---|---|---|
| 1 | **Stories** | which stories are doing well, which are not | `story_performance` |
| 2 | **Inside a story** | story name, card number, dwell, how far they get | `card_dropoff` |
| 2b | **Where they stop** | of those who stopped, which card was the last | `story_stop_points` |
| 3 | **The funnel** | locked story → gate → sign-in → account → Stripe → back → subscribed | `subscribe_funnel` |
| 3 | *(the true number)* | how many subscribers there actually are | `subscription_totals` |
| 3b | **Blocked before Stripe** | why a checkout never started | `checkout_blocks` |
| 4 | **Onboarding** | how far through `/join` people get, how many finish | `onboarding_funnel` |
| 5 | **Buttons** | every `data-fbt` control, searchable, with counts | `button_presses` |
| 5b | **One event, day by day** | is a given event going up or down | `event_volume` |
| 6 | **Audio** | who touches the sound, and how often | `audio_usage` |
| 7 | **Errors** | what broke, where, on which release | `client_errors` |

### The date range

One control, shared by every section: two real dates sent as `from` / `to`,
with presets that fill them. `to` includes its own day. The API clamps a span
to 90 days, and so does the picker, so the dates on screen are the dates that
will be scanned.

The line under the control bar reports **`meta.from` / `meta.to` / `meta.days`
— the window the server actually scanned**, not the one the page asked for. If
the server moved the start forward, the line says so. A clamp the reader cannot
see is the server quietly answering a different question.

`subscription_totals` takes no window; it counts what is true now.

### Rendering rows

`rows` is plain objects and the page renders whatever arrives. It does not
hard-code a schema:

- **Preferred columns first**, in a per-section order; then every other key the
  rows turned out to have, in the order it first appeared. A column added
  upstream tomorrow appears tomorrow, labelled from its own name, with no
  change here. The only way a column is dropped is a caller naming it in
  `omit` — used once, for the story id that is already printed under its title.
- **Units come off the key name.** `_ms` is a duration, `_s` is seconds, `_pct`
  is *already* a percentage, `_rate` / `_share` between 0 and 1 is a fraction of
  one. That rule is written down in `fmtPct()` because guessing silently is how
  a 91% completion rate gets reported as 0.9%.
- `median_dwell_s: 214.5` renders as `3m 35s`, never `214.5`.
- Two metric/value tables (`audio_usage`, `subscription_totals`) carry several
  units in one `value` column, so those sections pass a formatter that reads
  the unit off the `metric` name.
- Every table sorts on a real `<button>` inside the `<th>`, with `aria-sort` on
  the `th`.

---

## 3 · Charts

A line, a bar and a funnel, drawn as **inline SVG by `js/dashboard.js`**. No
CDN: this site loads no third-party JavaScript and is not going to start for a
bar chart.

- Each is drawn at the **pixel width of its container** and redrawn when that
  changes, so nothing is ever scaled — 13px type is 13px type at 375 and at
  1920. Below 560px the chart scrolls inside its own `overflow-x:auto` box
  rather than shrinking, because an SVG squeezed to a third of its width has
  5px numbers on it and is a picture of some data instead of the data.
- **Every value is written on the chart as text, and again in the table
  underneath.** A chart nobody can read a value off is decoration.
- Both axes of a line chart are labelled with real numbers at three gridlines.
- The funnel writes the fall-out between rows in `--crimson` — *"↓ 728 lost
  here — 58.7% of the step above"* — because the fall-out is the point of the
  chart and should not be left to be inferred from two bar lengths.

**There is a trap here that cost a rebuild.** A section draws its chart and
*then* unhides the box it lives in. At the moment of the first draw the box is
still `display:none`, so `clientWidth` is 0 and every chart on the page
rendered at the 720px fallback inside a 1244px box. The fix is in `chart()`,
not at the eight call sites: draw, then re-measure on the next turn of the
event loop and redraw if the width changed. That also picks up the web font
landing.

**Colour.** No colour is defined in `css/dashboard.css`; every value is a token
from `app.css`. `--coral` is a fill (2.40:1 on `--raise`), so it fills bars and
never writes a word; each bar carries a `--coral-deep` stroke (5.44:1) so the
shape itself clears the 3:1 a meaningful graphic needs. Text is `--ink`
(11.21:1), `--dim` (6.8:1), `--dimmer` (5.4:1), `--accent-ink` (5.79:1),
`--crimson` (6.06:1), `--teal-ink` (7.44:1) — all on the real composited
`--raise`.

---

## 4 · When the answer does not come

The four codes in `ANALYTICS-API.md` §2, and three of our own for failures that
never reached the function. **The page branches on `error` only**; the advisory
keys (`field`, `retry_after_s`, `reason`) are read for the message and never
for the decision.

| Code | What the page does |
|---|---|
| `not_admin` | tears the whole page down — see §1 |
| `bad_query` | says it is a bug in this page, names `field` if given |
| `rate_limited` | says how long to wait if `retry_after_s` is present, otherwise "resets tomorrow" |
| `upstream` | says it is upstream, names `reason`, points at Refresh |
| `upstream` + `reason: "not_configured"` | **a state, not a fault** — see below |
| network / timeout | "We could not reach the analytics function" |
| no ID token | "Sign out and back in" |

There is no automatic retry. A retry loop against a 30-per-minute cap is a good
way to turn one failure into a lockout; the Refresh button is the retry.

### `not_configured` is the state it is in **today**

Until someone sets `POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID` in Secret Manager
and redeploys, every PostHog-backed query answers `502 upstream
not_configured`. That is nine of the eleven panels.

The page treats that as a state of the world rather than a fault:

- it is **not** painted in the stop colour, because teaching whoever opens this
  first to ignore red is the one thing red must not do;
- the full explanation and the two commands appear **once**, in a note under
  the date picker, and each section carries a single line pointing at it. It
  used to be the per-section message, which put the same six-line paragraph on
  screen eight times and made the page unreadable;
- **`subscription_totals` still works** — it is Firestore, not PostHog — so the
  subscriber tiles are populated while everything else is empty. That is the
  evidence that nothing else is wrong, and it is why the note says so;
- the story picker still fills, from the public catalogue rather than from the
  analytics answer, so a story can be chosen and its honest reason read.

---

## 5 · What the owner asked for that the data cannot answer

Four things. None of them is drawn as a chart that implies otherwise.

**1. "Are people muting the music or playing it?" — half answered.**
`audio_usage` says how many people touch the sound and how often. It **cannot**
say how many turned it on versus muted it. This is a missing attribute, not a
missing measurement: the ambient-sound button in `js/audio-reader.js` carries no
`data-fbt`, no `id` and no `name`, so the delegated click listener records it by
its first class — `fb-sound` — and reads that class *before* the toggle flips.
Every tap looks identical. **The fix is one attribute**, set from that file's
paint function: `data-fbt="sound_on"` / `data-fbt="sound_off"` mirroring
`aria-pressed`. Until it lands the tile reads "Sound toggled", never "sound
turned on", and the caveat is printed under the section. `js/audio-reader.js` is
not one of my files; this is a request, not a change.

**2. The funnel is step *reach*, not a strict ordered funnel.** Each number is
the distinct people who did that thing in the window. It does not verify that
the same person did step three after step two — someone arriving at Stripe from
a bookmark counts at that step without the ones before it. A true sequential
funnel needs a person-level join. For a path this linear the two agree closely,
but they are not the same measurement, and **the page says so beside the
chart** rather than in a document nobody opens.

**3. The funnel's step order is the product's, not the intuitive one.** The
owner described *"signed in → reached Stripe → came back → account created"*. On
the live site the account has to exist **before** checkout, because
`client_reference_id` on the Stripe URL is the Firebase uid and a checkout that
cannot be attributed does not start — that is what `checkout_blocked` with
`why: "no_uid"` is. So "Created an account" precedes "Reached Stripe" and the
chart is **not** reordered to look more natural. This is also said on screen.

**4. "The number of subscribers" has two answers and one of them is better.**
The last funnel step is a browser event, and browser events lose 10–25% to ad
blockers, closed tabs and dead connections. `subscription_totals` is a Firestore
`count()` over `customers` and is the number that is true. Both are on the page,
the true one is labelled as such, and the note says which wins when they
disagree.

Two smaller ones worth knowing:

- **A `card_view` needs 900ms on screen.** A swipe passing through is not a
  reading, so §2 counts *attention*, not scroll position. Printed under the
  table.
- **`contains` is matched with SQL `ILIKE`, where `_` is a single-character
  wildcard.** Searching `sub_why` also matches `subXwhy`. Harmless for slugs,
  but it explains an occasional extra row.

---

## 6 · This page sends no analytics, on purpose

**`admin/dashboard.html` is the only page on the site that does not load
`js/analytics.js`.** That script sends `page_open` on load and a `ui_click` for
every tap on any control. On this page that would put every column sort and
every range change into the very counts the page reports — and straight into
`button_presses`, which is a table this page draws. A dashboard that measures
its own use answers a different question every time you look at it.

**No event name in this repo is new because of this page**, and none was
renamed. `js/dashboard.js` contains no `track(` or `capture(` call.

`tools/check-analytics.js` requires the analytics tag on every **top-level**
page (`fs.readdirSync(ROOT)`, not recursive), so a page under `admin/` is
outside that guard and the checker passes. If this page is ever moved to the
repo root it will fail that check, and the answer is to keep it where it is
rather than to load the script.

`js/dashboard.js` copies `KNOWN_EVENTS` from `functions/insights.js` for the
event picker, because no query returns that list. **When `js/analytics.js`
gains an event: add it to `insights.js` first, then here.** A name that has
drifted out of the allowlist comes back as `bad_query` and is rendered as a
sentence, not a crash.

---

## 7 · Serving, and the one path assumption

GitHub Pages resolves `/admin/dashboard` to `admin/dashboard.html` before it
would look for `admin/dashboard/index.html`. **Confirmed** against
`tools/serve-like-pages.py`, which reproduces that ordering: both
`/admin/dashboard` and `/admin/dashboard.html` return 200 and the same file.
There is no `admin/dashboard/` directory and there must not be one.

**Every asset path is root-absolute** — `/css/app.css`, `/js/dashboard.js` —
and that is not stylistic. Served at `/admin/dashboard` a relative
`css/app.css` resolves to `/css/app.css`; served at `/admin/dashboard.html` the
same string resolves to `/admin/css/app.css`. The two addresses disagree and
only the absolute form is stable at both.

---

## 8 · How it was verified

`python3 tools/serve-like-pages.py 8899 .` — **not** `python3 -m http.server`,
which 404s every clean URL and has produced a false result in this repo before.
`/explore` returning 200 was confirmed first.

**Real Chrome, via puppeteer-core, fifteen scenarios.** The `insights` function
is not reachable from this machine, so responses are stubbed **at the network
layer** with request interception: the page's own `XMLHttpRequest`, its own
`Authorization` header, the CORS preflight and its own JSON parsing all run for
real, and only the bytes coming back are fixtures shaped exactly as
`ANALYTICS-API.md` documents. Auth is stubbed by installing a `window.FBU`
before any script runs — `js/auth.js` opens with
`if (W.FBU && W.FBU.__factbox) return`, so a stub wearing that flag makes the
real module stand down and the page takes its production code path.

Scenarios, all green:

- admin at **375, 414, 768, 1024, 1440 and 1920**, with a story picked, a
  search typed and a column sorted;
- signed-in non-admin, signed-out, and `js/auth.js` 404'd;
- the API answering `not_admin`, `bad_query`, `rate_limited`, `upstream`,
  `upstream`+`not_configured`, and a dead network.

Asserted every run: **zero `pageerror`**, zero `console.error` from the page,
`document.body.scrollWidth` never exceeds the viewport, **every `[hidden]`
element computes `display:none`**, nothing overflows the viewport outside a
`.dsh-scroll` box, the rendered text is never near-empty, and the text never
contains `undefined`, `NaN`, `[object Object]` or the forbidden copy
`check-page.js` looks for.

Screenshots of every state were read, not just measured. That caught four
things no structural check would have: a `flex-basis` on a control inside a
column-flex field stretching the story picker to 220px tall, two different
columns both headed "Finished", a duplicated story-id column, and SVG `<text>`
collapsing the whitespace between two figures so they ran together.

Also green: `check-structure.py`, `check-regressions.js`, `check-analytics.js`,
`check-account-cache.js`, and `check-page.js` against both
`admin/dashboard` and `admin/dashboard.html`. Note that jsdom does not execute
`type="module"`, so `check-page.js` exercises parse, load and script errors and
lands on the no-FBU panel; the state verification is the Chrome harness above.

---

## 9 · Asks

- **A link from `/settings`.** There is no route to `/admin/dashboard` from
  anywhere in the site — it is reachable only by typing it. A line in
  `settings.html`, shown behind `FBU.admin()`, would fix that. `settings.html`
  is not one of my files, so this is a request rather than a change.
- **`data-fbt="sound_on"` / `"sound_off"` on the ambient-sound button** in
  `js/audio-reader.js` — §5.1. One attribute, and the audio section answers the
  whole question the owner asked instead of half of it.
- **`POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID`** in Secret Manager, then
  redeploy `insights`. Until then the page is honest and mostly empty.
