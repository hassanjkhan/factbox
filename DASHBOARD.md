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

Seventeen queries exist; this page draws **sixteen** of them. A full render
issues thirteen requests — fifteen with a story picked, sixteen once a reader
is chosen — **two at a time** through a queue in `js/dashboard.js`. `ANALYTICS-API.md` §5 caps an admin at
sixty a minute (raised from thirty when the panel count grew) and explicitly
asks for small batches. Pressing Refresh mid-render bumps a generation counter
and abandons the rest of the old batch, so two renders cannot paint over each
other.

| § | Section | Question | Query |
|---|---|---|---|
| 1 | **The journey** | /firststory → read → end card → sign-up → Stripe → paid → back a day later | `firststory_funnel` |
| 1b | **How far they scrolled** | how many people reached each card of /firststory | `firststory_cards` |
| 2 | **Stories** | which stories are doing well, which are not | `story_performance` |
| 3 | **Inside a story** | story name, card number, dwell, how far they get | `card_dropoff` |
| 3b | **Where they stop** | of those who stopped, which card was the last | `story_stop_points` |
| 4 | **Readers** | who read what, how far, and their email | `reader_activity` |
| 4b | **Where readers are** | which countries they were in | `geo_breakdown` |
| 4c | **Time on each card** | how long each reader spent on each card | `reader_dwell` |
| 4d | **One person, in order** | x then y then z, and the gap between | `person_timeline` |
| 5 | **Subscribers** | how many subscribers there actually are | `subscription_totals` |
| 5b | **Blocked before Stripe** | why a checkout never started | `checkout_blocks` |
| 6 | **Onboarding** | how far through `/join` people get, how many finish | `onboarding_funnel` |
| 7 | **Buttons** | every `data-fbt` control, searchable, with counts | `button_presses` |
| 7b | **One event, day by day** | is a given event going up or down | `event_volume` |
| 8 | **Audio** | who touches the sound, and how often | `audio_usage` |
| 9 | **Errors** | what broke, where, on which release | `client_errors` |
| — | *(not drawn)* | the site-wide subscribe path | `subscribe_funnel` |

### The one panel that was taken away

`subscribe_funnel` used to be **§3 The funnel**, charting the site-wide path:
locked story → gate → sign-in → account → Stripe → back → subscribed. It is no
longer on the page.

§1 now runs the same path over the people who actually arrived, and two funnels
on one page over two different populations is a specific failure, not a
richness: the reader has to work out which denominator each bar is against
before they can read either, and in practice they read whichever is nearer. One
funnel that says what it counts beats two that disagree.

**It is off the page, not out of the API.** `subscribe_funnel` is still
allow-listed, still documented in `ANALYTICS-API.md` §3, and still one `curl`
away. Putting the panel back is restoring six elements in
`admin/dashboard.html` and the `ask("subscribe_funnel", …)` block in
`js/dashboard.js`; both are named in a comment where they used to be.

### The three panels about people

The owner asked for three things in one sentence — *"what country they are
from, dwell times per user on each page or card… so we can see oh one person
did x then y then z and then an hour later someone else did that too"* — and
they are three panels because they are three questions with three shapes.

**§4b Where readers are — `geo_breakdown`.** A table biggest first and a bar
per country. **There is no map, and that is a decision.** With readers in
double figures a filled-in country is read as a claim about a place when what
is known is "seven people"; a bar labelled 7 says the same thing and stops
there. There is no city and no region either — at this size a city is close
enough to naming somebody, and the function does not ask PostHog for one.

The absence of this data is a state the panel renders rather than an empty
chart, and there are two of them:

- **The query is not there.** `bad_query` from a panel that sends nothing but a
  date window and the admin flag is the function refusing the NAME. One
  sentence says so and nothing is drawn. It cannot say *why* — an unknown query
  and a rejected parameter share a code — so it points at `ANALYTICS-API.md`,
  which is the record of whether the query was never built or is merely not
  deployed.
- **`meta.geo_usable` is false.** The function decides this, not the page: it
  is false when everybody landed in one country or in none. That is a plausible
  answer for a small site **and** it is exactly the shape of a proxy that has
  stopped forwarding the reader's IP — `cloudflare/posthog-proxy.js` sets
  `X-Forwarded-For` from `CF-Connecting-IP`, and without that line every reader
  is placed at a Cloudflare colo. The two cannot be told apart from here, so
  the panel prints both possibilities and draws nothing. A single bar at 100%
  would read as a finding about the readership, and it would not be one.

An **Unknown** row is a row, counted and labelled, never dropped: percentages
that quietly exclude the people they could not place are the same lie in a
smaller font.

**§4c Time on each card — `reader_dwell`.** One block per reader; inside it the
cards in the order they were read, with the time on each drawn as a bar
**against that reader's own longest card**. Two blocks cannot be compared by
bar length and are not meant to be — the times are written on every row — but
within one reader the place they stopped and stared is the widest bar in the
block, which is the whole point of the panel. The longest card is named in the
block heading as well, so a collapsed block still answers it.

Three things this panel does that the readers panel does not need to:

- **The cards fold away.** On the live project one reader has 165 timed cards
  and there are twenty-odd readers: drawn open, this section was **twelve
  thousand pixels tall** and the panel under it was unreachable. The first
  three blocks are open, the rest are one click, and the heading carries the
  answer either way.
- **A column that is the same on every row of a block moves into the heading** —
  the story, the address — exactly as §3 already does with the story id. Seven
  copies of a story title wrapping to two lines is width spent saying nothing.
- **A column identical to another column on every row is dropped.** Where a
  card was seen once, its median, its longest single view and its capped time
  ARE the time on it, and four columns of one number is the duplicated column
  this page has shipped before.

`page` is a column and not decoration: story 01 is served at three addresses,
so the same card read at two of them is two rows with two different answers.

**§4d One person, in order — `person_timeline`.** A vertical timeline, oldest
first, **with the gap written between every pair of events**, because "and then
an hour later" is the part of the owner's sentence the data has to answer. A
gap long enough to be a second sitting cuts the spine and says so in words:
three taps in a row and an hour's absence must not look the same on the way
down.

**The gap is the function's, not the page's.** `person_timeline` returns
`gap_s` and a `session` counter computed from the same timestamps it returned,
and this page draws the break where that counter changes rather than
re-deriving it from two strings a browser parsed — two answers to one question
is how a page ends up drawing a break the server did not count. The threshold
is printed under the timeline rather than assumed.

### The reader number is per answer, and this cost a design

`reader_activity` assigns an **ordinal** — 1, 2, 3 — most recent first, *for
that response only*. It is derived from nothing and cannot follow anybody,
which is exactly why it is safe and exactly why it is awkward:

- **The session panel sends `roster_limit`** — the same `limit` the readers
  panel sent — because an ordinal means "the Nth row of a `reader_activity`
  answer" and only resolves to the same person against the same roster size.
  One constant in `js/dashboard.js` feeds both.
- **All three personal queries number readers off the same roster**, so
  reader 5 is one person in every table on this page and a button in the dwell
  panel opens the right timeline. That is what `roster_limit` buys, and it is
  why §4c costs two upstream calls: an earlier draft of the function numbered
  its own rows and produced a second, silently different ordinal space.
- **`reader_dwell` returns `reader: null`** for a row whose reader is past the
  end of a truncated roster. Those rows are not merged into one block — there
  is no way to tell one unnumbered reader from another, and a block headed
  "longest 4m on card 3" over several people is a finding about nobody. They
  are shown together at the bottom, labelled, with no total and no longest, and
  `meta.unranked_rows` is printed in the section's own line.
- **A refresh renumbers everybody**, so the session panel remembers the email
  and looks the number up again. A reader with no account has nothing to look
  up: the panel clears and says why instead of following their old number to
  whoever now holds it.
- **An ordinal past the end of the roster is a race, not an error** — somebody
  read a card and everyone shuffled down. The function answers `reader_found:
  false` with no rows, and the panel says the numbering moved.

### The admin switch

One control, beside the dates, applying to **every** panel — a select rather
than a checkbox so that both states are written out in words. It sends one
boolean, `exclude_admins`, injected into every request by `ask()` rather than
by fourteen call sites, so a panel added tomorrow inherits it.

**It defaults to on.** Three accounts exist on this project and all three are
the founders'. Unfiltered, every figure on this page is mostly their own
testing, which is worse than no figure at the moment they are trying to read a
launch. The honest default is "numbers about strangers".

**The filtering is server-side and there is no browser half of it.** The
function reads the admin uids out of `customers` and leaves those `distinct_id`s
out of the queries. This page never learns a uid — and could not do the job if
it did, because most of these figures are aggregates and a person cannot be
subtracted from a median after the fact.

**The mode is written on screen, always.** `#dsh-mode` under the control bar
carries the requested mode before the first answer arrives and the server's own
`meta.admin_filter` afterwards. A number whose meaning changed without saying so
is worse than no switch. The line also says the count of admin accounts, which
is a number; the uids are not in any response.

**`subscription_totals` is the exception, and it says so.** It is a Firestore
`count()` over accounts rather than a count of events, so there is nothing to
leave out, and taking the founders out would stop it being the authoritative
subscriber number — the only thing it is for. `meta.admin_filter` comes back
`not_applicable`, the tiles carry a fourth tile counting the admin accounts, and
the note under them says all of this rather than letting the switch appear to
have been honoured.

### The panels that show people — now three of them

**§4 Readers, §4c Time on each card and §4d One person, in order are the
panels that return an identity.** §4 was the only one when this page was
built; `reader_dwell` and `person_timeline` are marked `personal: true` in
`functions/insights.js` for the same reason and with the same protections, and
the verification below was widened from "an email appears nowhere outside
`#dsh-sec-readers`" to those three sections. **`geo_breakdown` is not one of
them**: it returns countries with counts beside them and never a country
beside a person, which is a different promise and the reason there is no
country on a timeline row.

The paragraph below is about §4 and holds for all three. It is the
deliberate exception recorded in `ANALYTICS-API.md` §6: with a handful of
readers, aggregate percentages tell the owner nothing and a list of actual
people tells them everything.

- The email is joined **server-side, from Firebase Auth**, to the Firebase uid
  PostHog holds because `identify(uid)` put it there. **PostHog has never been
  sent an email and must not be.**
- No uid reaches this page. Rows carry an ordinal the function assigns per
  response, which is what lets the page group a reader's stories without being
  told who they are.
- A reader with no account is drawn as *"Anonymous — no account"* with their
  reading intact. Nothing is invented to fill the column.
- It respects the admin switch like everything else: with the switch on, the
  founders are not in their own reader list.
- One block per reader rather than one flat table, because a table repeating an
  address down fourteen rows answers "what did this person read" worse.

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
| `bad_query` on §4b/§4c/§4d | **a state, not a fault.** Those three send nothing but a date window, the admin flag and (for §4d) a reader number, so a refusal is the function refusing the query NAME. The panel says the query is not there, draws nothing, and points at `ANALYTICS-API.md` rather than claiming a bug it cannot prove. |
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
not_configured`. That is twelve of the thirteen panels this page draws.

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

Thirteen things. None of them is drawn as a chart that implies otherwise.

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

**2. The journey funnel is step *reach* inside a cohort, not a strict ordered
path.** The cohort — everyone who opened `/firststory` or read a card there —
does stop a stranger appearing at "Reached Stripe" with nothing above them. It
does **not** verify that the same person did step three after step two, and one
consequence is visible on the chart: a lower bar can be **taller** than the one
above it, because the sign-up page is reachable from the paywall part-way
through the story and not only from the end card. **The page says so beside the
chart** rather than in a document nobody opens.

**3. "Saw the sign-up ask" cannot be separated from "saw the end card".** This
is the one step in the owner's list that the logging cannot answer, and it is
worth being exact about why. `/firststory` builds its end card with
`cta: "Sign up to read more"` (`firststory.html` line 14), and `js/recommend.js`
uses that string to suppress the auto-advance countdown and put a sign-up
control where "Start now" would be. **Nothing sends it.** `rec_view` carries
`stack` and `n` — and fires when the card is *built*, a dozen cards before
anyone reaches it. `first_completion_screen_viewed` fires on `reveal()`, which
is the card actually being seen, and carries `stack` and `mins`. Neither carries
the cta, and neither carries the page.

So the step is drawn as *"Reached the end card"* and labelled as an attribution
**by person**: reached the end card of story 01, having been on `/firststory` in
this window. That is as close as the instrumentation allows and the page says
which of the two it is. **The fix is one property** — see §9.

**4. Stripe's own page is invisible.** "Reached Stripe" is `checkout_start`: we
sent them. Whether the page rendered, and what they did on it, is on another
origin. `ANALYTICS.md` §4 item 1 has the server-side answer, which is joining
the Stripe webhook record to `checkout_start` by the uid `attributed` already
carries.

**5. A Google sign-up cannot be told from a Google sign-in.** `login.html` fires
`signin_google` for both (`ANALYTICS.md` §4 item 2), so the journey funnel has
**one** step, "Signed in or created an account", rather than two that would both
be wrong. The email-only sign-up count is a context row labelled as the
undercount it is.

**6. Card views before `page` shipped cannot be attributed.** `card_view` now
carries the page, which is what makes "how far did people get on `/firststory`"
answerable at all — story `01` is served at three addresses. It cannot be
backfilled. Those views are counted as `card_views_unattributed` and printed
under the funnel as their own sentence: not folded into `/firststory`, not
thrown away.

**7. "The number of subscribers" has two answers and one of them is better.**
"Paid and came back with access" is a browser event, and browser events lose
10–25% to ad blockers, closed tabs and dead connections — and somebody who pays
on a phone and comes back on a laptop is missed by it outright.
`subscription_totals` is a Firestore `count()` over `customers` and is the
number that is true. Both are on the page, the true one is labelled as such, and
the note says which wins when they disagree.

**8. "Came back later" is a definition, not an event.** There is no return
event, so retention is computed: active on **more than one calendar day (UTC)**
inside the window, on any page. That rule is printed under the chart, because a
retention number whose rule is not on screen is a number nobody can argue
with.

**9. A country is a guess, and it is per event rather than per person.** It is
derived by PostHog from the IP the event arrived with. A VPN, a corporate
network or a phone roaming across a border all move somebody, and a reader who
travelled inside the window is in two rows. `people` is a distinct count within
a country, so the countries do not add up to the number of people on the site —
the tile says "added across countries" rather than "people".

**10. Dwell is bounded at both ends, by the client, and neither bound can be
recovered.** `js/analytics.js` refuses to report a card view under 900ms or
over thirty minutes. So a card somebody swiped past is **missing from their
list rather than zero**, and the longest stall the page can ever show is capped
at half an hour — a genuinely long read is indistinguishable from a tab
abandoned just under the limit. The function returns every dwell figure twice,
raw and with each view clipped to three minutes, and §4c prints both on a block
where they disagree by more than a fifth, because that disagreement IS the
finding: somebody left the page open.

**11. There is no session in the data.** Nothing in `js/analytics.js` opens or
closes one. "A different sitting" is a thirty-minute gap, drawn by the function
and printed on screen as a number so a different line can be drawn by eye.

**12. A timeline is what the site records, not what the person did.** Reading
with a blocker on, or on a second device before signing in, leaves no events —
so a quiet stretch is not evidence of a quiet reader. And §4d reads at most
**31 days** where the rest of the page reads 90: the query filters on a person
rather than on an event, so it scans the window rather than using the event
index. When the range above is longer, the panel says which 31 days it
answered about.

**13. An anonymous reader cannot be followed across a refresh**, because the
only handle on them is an ordinal that the next answer reassigns. That is a
property of the ordinal being derived from nothing, which is the property that
makes it safe to send to a browser at all.

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

**Real Chrome, via puppeteer-core, fifteen scenarios.** Responses are stubbed
**at the network layer** with request interception: the page's own
`XMLHttpRequest`, its own `Authorization` header, the CORS preflight and its
own JSON parsing all run for real, and only the bytes coming back are fixtures
shaped exactly as `ANALYTICS-API.md` documents. Auth is stubbed by installing a
`window.FBU` before any script runs — `js/auth.js` opens with
`if (W.FBU && W.FBU.__factbox) return`, so a stub wearing that flag makes the
real module stand down and the page takes its production code path.

**And against the live function, which is now reachable.** The three panels
below were also driven against the deployed `insights` with a real Firebase ID
token for an admin uid, from `localhost:8899` — an origin the function's
allowlist already carries — so the same code path ran over real PostHog rows:
26 readers, 5 countries, one reader with 165 timed cards and one 60-event
timeline. **That is where the twelve-thousand-pixel section was found**, which
no fixture of three tidy readers would ever have shown. The fixtures remain,
because the states that matter — a query that is not there, one country holding
everybody, `not_configured` — cannot be produced on demand from live data.

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

**The three panels about people were driven the same way**, at 1440 and 375, in
five modes: live, fixtures, `geo_usable: false`, the three new queries answering
`bad_query`, and everything answering `upstream`/`not_configured`. Every run
asserted zero `pageerror`, zero `console.error` from the page, no horizontal
body scroll, **every `[hidden]` element computing `display:none`**, nothing
overflowing outside a `.dsh-scroll`, and no `undefined` / `NaN` /
`[object Object]` in the rendered text. Every request body was read: **all
sixteen carry `exclude_admins`**, which is what makes "the switch applies to
the new panels too" a fact rather than an assumption about `ask()`.

The screenshots were read, not just measured, and four things came out of that
which no assertion would have caught: the section that was twelve thousand
pixels tall; a story title repeated down seven rows and wrapping to two lines
in each; four columns showing the same number because a card seen once has one
dwell; and a geography panel whose sentence said "6 countries" beside a tile
saying "5 Countries", because Unknown is a row and is not a country.

**The admin switch, the readers panel and the journey funnel were driven the
same way**, with one addition that matters: the stub reads
`params.exclude_admins` out of each request body and answers with a **different
fixture set**, so "the numbers change when the switch moves" is asserted rather
than claimed. With the switch on the fixture reports 420 people on
`/firststory` and three reader blocks; flipped off, 672 and five, with
`hassan@getdonny.com` and `shrey@factbox.app` at the top of the list. Also
asserted every run:

- **every request carries `exclude_admins`** — the harness reads each POST body,
  so a panel that forgot to send it fails the run rather than quietly reporting
  unfiltered numbers;
- **an email address appears nowhere on the page outside `#dsh-sec-readers`,
  `#dsh-sec-dwell` and `#dsh-sec-person`** — every leaf element is scanned for
  something email-shaped and the section it sits in is recorded. That list grew
  from one to three when `reader_dwell` and `person_timeline` landed, and it
  grew deliberately: those two are `personal: true` in the function for the
  same reason §4 is. Nothing else on the page may show one;
- the anonymous reader renders with their reading intact, the row cap prints
  *"That is the cap: there were more…"*, and the unattributed card views print
  their own sentence under the funnel.

Two things only the screenshots caught, both fixed: the step label *"Reached
Stripe — we sent them, not that it rendered"* ran past the end of its bar
(`barsSVG` caps the value column at 210px), and the readers table headed its
boolean column *"Finished the flow"*, which is the onboarding funnel's meaning
of the word and the wrong one there.

Also green: `check-structure.py`, `check-regressions.js`, `check-analytics.js`,
`check-account-cache.js`, and `check-page.js` against both
`admin/dashboard` and `admin/dashboard.html`. Note that jsdom does not execute
`type="module"`, so `check-page.js` exercises parse, load and script errors and
lands on the no-FBU panel; the state verification is the Chrome harness above.

---

## 9 · Asks

- **`page` and `cta` on the two end-card events** in `js/recommend.js` — §5.3.
  `track("rec_view", { stack, n })` and
  `track("first_completion_screen_viewed", { stack, mins })` both need the page
  they fired on, and the completion one needs whether `opts.cta` was set. Two
  properties on two existing events, no new event name, and "how many saw the
  sign-up ask" stops being an attribution by person and becomes a count. That
  file is not one of mine; this is a request rather than a change.
- **`isNewUser` on the Google sign-in** — §5.5. `js/auth.js`'s `signInGoogle()`
  result carries it, so `FB.track(isNew ? "signup_google" : "signin_google")` is
  one line and splits a step this page currently has to keep merged.
  `ANALYTICS.md` §4 item 2 has already asked for it.
- **A link from `/settings`.** There is no route to `/admin/dashboard` from
  anywhere in the site — it is reachable only by typing it. A line in
  `settings.html`, shown behind `FBU.admin()`, would fix that. `settings.html`
  is not one of my files, so this is a request rather than a change.
- **`data-fbt="sound_on"` / `"sound_off"` on the ambient-sound button** in
  `js/audio-reader.js` — resolved; kept here because the historical presses
  cannot be split. One attribute, and the audio section answers the
  whole question the owner asked instead of half of it.
- **`POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID`** in Secret Manager, then
  redeploy `insights`. Until then the page is honest and mostly empty.
