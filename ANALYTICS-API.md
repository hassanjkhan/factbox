# Factbox — the analytics query API

**Status:** contract frozen. `functions/insights.js` implements it. The admin dashboard
under `admin/` is built against this file and nothing else.

One endpoint, one POST, a **named** query and a typed `params` object. The browser never
sends a query language and never sees a PostHog key. Thirteen of the fourteen queries
cannot return an identity; the fourteenth returns an email on purpose, and §6 says why
and how narrowly.

---

## 0. The one-paragraph version

The data already exists. `js/analytics.js` has been sending every meaningful event to
PostHog (through the Cloudflare proxy at `/ink`) and to GA4 for weeks. Building a second
pipeline into Firestore would duplicate it badly, cost a write on every card view, and
split the truth across two stores. So this is not a pipeline. It is a **door**: a Cloud
Function that proves the caller is an admin, picks one of fourteen queries the function
itself wrote, runs it against PostHog with the key held in Secret Manager, and hands back
plain rows.

Two things run across all of them and are not per-query features:

- **`exclude_admins`, and it defaults to `true`.** Three accounts exist on this project
  and all three are the founders'. Unfiltered, every figure is mostly their own testing.
  The function reads the admin uids from `customers` itself and leaves those
  `distinct_id`s out of the query; the uids never reach the browser. `meta.admin_filter`
  reports what it actually did.
- **One query returns personal data.** `reader_activity`, deliberately. §6.

---

## 1. Endpoint

```
POST https://us-central1-factbox-7cb97.cloudfunctions.net/insights
Content-Type: application/json
Authorization: Bearer <Firebase ID token>
```

`OPTIONS` is answered `204` for the CORS preflight. Every other method is `bad_query`.

**Origins.** The same allowlist `story.js` and `support.js` use: `https://factbox.app`,
`https://www.factbox.app`, `localhost`/`127.0.0.1` on any port, and `*.github.io`. There
is no `*`. A page that is not one of those gets no `Access-Control-Allow-Origin` header
and the browser refuses the response. CORS is not the security boundary — the token is —
but there is no reason to let an arbitrary page make an admin's browser fetch this.

**Body**

```json
{ "query": "card_dropoff", "params": { "story": "26", "days": 14 } }
```

`params` may be omitted entirely. Unknown keys inside `params` are ignored, not an error —
so a dashboard can send `days` to a query that does not take one.

Request bodies over 8 KB are refused before parsing.

---

## 2. Response

**Success — always this shape.**

```json
{
  "ok": true,
  "query": "card_dropoff",
  "rows": [
    { "story": "26", "card": 1, "views": 812, "readers": 640,
      "median_dwell_s": 6.4, "reach_pct": 100, "dropoff_pct": 0 },
    { "story": "26", "card": 2, "views": 731, "readers": 590,
      "median_dwell_s": 7.1, "reach_pct": 90.0, "dropoff_pct": 10.0 }
  ],
  "meta": {
    "query": "card_dropoff",
    "from": "2026-08-21T00:00:00.000Z",
    "to":   "2026-09-04T11:02:41.000Z",
    "days": 14,
    "rows": 2,
    "limit": 50,
    "params": { "story": "26", "days": 14, "exclude_admins": true },
    "source": "posthog",
    "admin_filter": "excluded",
    "admin_accounts": 3,
    "took_ms": 412
  }
}
```

`rows` is **always an array of plain objects**, never nested, never an array of arrays.
Values are strings, finite numbers, or `null`. Never `undefined`, never an object.
`meta.params` echoes the params **after** clamping, so the UI can show "showing 14 days"
without guessing what the server did with what it sent.

`meta.source` is `"posthog"`, or `"firestore"` for `subscription_totals`.

**`meta.admin_filter`** is what the switch actually did, in three values, and it is
what the UI must print rather than echoing the flag it sent:

| value | means |
|---|---|
| `excluded` | admin `distinct_id`s were left out of this query |
| `included` | they were not — either the switch was off, or no admin uid was found |
| `not_applicable` | `subscription_totals`: a Firestore count of accounts, with no event to leave out |

**`meta.admin_accounts`** is a **count**, never a list. The uids are not in any response
and must never be: filtering in a browser would ship them and would get the arithmetic
wrong on every aggregate, which is all of them.

Three queries add keys of their own — `reader_activity` adds `readers`, `with_email`,
`anonymous` and `truncated`; `firststory_funnel` adds `cohort`, `arrivals`,
`card_views_here`, `card_views_story`, `card_views_unattributed`, `deepest_card` and
`truncated`. They are documented with those queries below. A UI may read them; nothing
should branch on their absence.

**Failure — always this shape.**

```json
{ "ok": false, "error": "not_admin" }
```

### The four error codes. This list does not grow.

| code | HTTP | means | what the UI should do |
|---|---|---|---|
| `not_admin` | 403 | no token, bad token, expired token, revoked token, valid token belonging to a non-admin | Show the sign-in screen. Do **not** distinguish these — the server does not. |
| `bad_query` | 400 (405 for a wrong method) | unknown query name, a parameter of the wrong type, a parameter with an illegal character, an oversized body | A bug in the dashboard. Log it, show "that view is not available". |
| `rate_limited` | 429 | per-admin or global cap spent | Back off. `retry_after_s` is present when the answer is "wait"; absent when it is "come back tomorrow". |
| `upstream` | 502 | PostHog refused, timed out, or is not configured yet | "Analytics is unavailable." Retry once after a few seconds, then stop. |

A failure body may carry extra advisory keys — `field` on `bad_query`, `retry_after_s` on
`rate_limited`, `reason` on `upstream`. **Branch on `error` only.** The extras are for a
human reading the network tab, and one of them may be added or dropped without this being
a contract change.

`reason: "not_configured"` on an `upstream` is the specific case worth a nicer message:
it means nobody has set the PostHog key yet (§7). Everything else about the function
works; there is simply nothing upstream to ask.

---

## 3. The queries

Seventeen names. The function builds every one of them; nothing you send becomes SQL.

### Accepted short names

`js/dashboard.js` was written in parallel with the function and against seven shorter
names. Both are accepted. The response reports the canonical name in `ok.query`, and
`meta.requested` echoes the short one when a short one was sent.

| sent | runs |
|---|---|
| `stories` | `story_performance` |
| `story_cards` | `card_dropoff` |
| `funnel` | `subscribe_funnel` |
| `onboarding` | `onboarding_funnel` |
| `events` | `button_presses` |
| `audio` | `audio_usage` |
| `errors` | `client_errors` |

The long names are preferred for anything new. `errors` will not age well the day there is
a second kind of error, and `events` is a whole table rather than the button presses it
currently means — **worth confirming that panel is the buttons panel**, because if it was
meant to be per-event volume the alias should point at `event_volume` instead.

### `story_performance` — how each story does
*Answers: which stories get opened, which get finished, how long they hold someone, and
how far in the average reader gets.*

Params: `days`, `limit`.

| column | from |
|---|---|
| `story` | `stack_open.stack` |
| `opens` | count of `stack_open` |
| `completions` | count of `stack_complete` |
| `completion_pct` | completions ÷ opens |
| `readers` | distinct people, **a count, never a list** |
| `median_dwell_s` | median of `story_time.dwell_ms` ÷ 1000 — engaged time, the clock stops when the tab hides |
| `median_cards` | median of `story_time.cards` |
| `median_last_card` | median of `card` on `stack_complete` / `stack_dropoff` — *where readers stop* |

### `card_dropoff` — per-card fall-off inside one story
*The one the owner described most precisely: story name, card number, dwell, and the
fall-off between cards.*

Params: `story` (optional — omit for every story), `days`, `limit`.

| column | from |
|---|---|
| `story` | `card_view.story` |
| `card` | `card_view.card` |
| `views` | count of `card_view` |
| `readers` | distinct people |
| `median_dwell_s` | median of `card_view.dwell_s` — **already on the event**, nothing new to instrument |
| `reach_pct` | this card's readers as a share of **card 1** of the same story |
| `dropoff_pct` | the share lost since the **previous** card |

`reach_pct` and `dropoff_pct` are computed in the function from the rows above, not in
SQL. Rows come back ordered by `story` then `card`, so the dashboard can render straight
down the array.

Two things to know. A `card_view` is only sent once a card has been on screen for **900 ms
or more** — a swipe passing through is not a reading, so these counts are attention, not
scroll position. And `card_view` names the story in a property called `story`, while
`stack_open` and `story_time` call it `stack`. That is a real inconsistency in
`js/analytics.js`; the function knows about it and the dashboard need not.

### `story_stop_points` — the histogram of last cards
*Answers: of the people who stopped, which card did they stop on?*

Params: `story` (optional), `days`, `limit`.
Columns: `story`, `last_card`, `stopped`, `completed`, `sessions`, `share_pct`.

`last_card` is `deepest + 1` as the readers report it — the card they actually reached. A
locked run is never a completion however far it scrolled, which is why `stopped` at the
paywall card is usually the tallest bar in a gated story.

### `subscribe_funnel` — the money path
*Answers: reached a locked story → opened the gate → signed in → made an account →
reached Stripe → came back → subscribed. Where do people fall out?*

Params: `days`. Rows come back in step order.

| step | event | the owner's words |
|---|---|---|
| `locked_story` | `paywall_view` | reached a locked story |
| `gate_opened` | `join_view` | opened the gate |
| `signed_in` | `signin_email`, `signin_google` | signed in |
| `account_created` | `signup_email`, `join_signup` | account created |
| `reached_stripe` | `checkout_start` | reached Stripe |
| `came_back` | `access_gained` | came back |
| `subscribed` | `access_gained` where `from = "stripe"` | subscribed |

Columns: `step`, `label`, `people`, `pct_of_first`, `pct_of_previous`.

**Read this before reading the numbers.** Two honest caveats, both of which the dashboard
should print next to the chart rather than hide:

1. **This is step reach, not a strict ordered funnel.** Each number is "distinct people who
   did this thing in the window". It does not verify that the same person did step 3 after
   step 2. A true sequential funnel needs PostHog's funnel engine and a person-level join;
   this is one aggregate scan and it costs a fraction as much. For a path this linear the
   two agree closely, but they are not the same measurement and the label must say so.
2. **The owner's step order is not the product's step order.** They described "signed in →
   reached Stripe → came back → account created". On the live site the account has to exist
   *before* checkout — `client_reference_id` on the Stripe URL is the Firebase uid, and
   `checkout_blocked` with `why: "no_uid"` is what fires when it does not. So the steps are
   ordered as the funnel actually runs. If those two rows look inverted against expectation,
   this is why.

A `blocked` row is appended: distinct people who hit `checkout_blocked` at all. It is not a
funnel step — it is a leak, and `checkout_blocks` says which one.

### `checkout_blocks` — why a checkout never started
Params: `days`, `limit`. Columns: `why`, `plan`, `blocks`, `people`.

`why` is one of `no_link`, `no_uid`, `no_url`. `no_uid` is a signed-out reader reaching
for a paid plan; `no_link`/`no_url` is a misconfigured payment link, which is a bug and
should be zero.

### `onboarding_funnel` — how far through `/join` people get
Params: `days`. Columns: `step`, `kind`, `people`, `events`, `reach_pct`, `finished`.

`kind` is `step` (from `join_step`) or `skip` (from `join_skip`). The five known steps —
`jn-you`, `jn-loading`, `jn-plan`, `jn-login`, `jn-done` — are returned in that fixed
order because it is the order `join.html` moves through them; anything else observed is
appended after, ordered by people. `finished` is `true` on `jn-done` and that row is the
answer to "how many finish". `reach_pct` is against the first step.

### `button_presses` — every control, by name
Params: `days`, `contains` (optional, case-insensitive substring), `page` (optional),
`limit`. Columns: `control`, `page`, `presses`, `people`.

`control` is the `data-fbt` name where a control has one, otherwise its `id`, `name`,
`data-k`, its own static label, or its first class — in that order, slugged to 40
characters. **Nothing a reader typed can reach this field**; the delegated listener in
`js/analytics.js` never reads the value of an input.

One wrinkle worth knowing: `contains` is matched with SQL `ILIKE '%…%'`, and `_` is a
single-character wildcard there. Searching `sub_why` therefore also matches `subXwhy`.
Harmless in practice — control names are slugs — but it explains an occasional extra row.

### `audio_usage` — who turns the sound on
Params: `days`. Returns `plays` and `mutes` as separate rows — the sound button
sets `data-fbt` to the state a press *produces*, so a play and a mute are
distinguishable. Presses recorded before that landed arrive under one name and
appear as `undirected_legacy_taps`, shown only when non-zero and never folded
into either side: adding them to one would invent a direction nobody measured.
Then `sound_users`, `readers` and `share_pct`.

This query was first written against a control named `fb-sound`, which never
shipped — the click listener walks up to the nearest ancestor with an id, so
every press was logged as `fb_rail`. It returned zero for its whole life.

**Resolved the same day this was written.** `js/audio-reader.js` now sets
`data-fbt` from its paint function to the state a press *produces* — `sound_on`
for a play, `sound_off` for a mute — mirroring the `aria-pressed` it already
maintained, and `ui_click` also carries `was_on` measured from that attribute.
The two are always inverses; if a report ever shows them agreeing, the
attribute has been flipped and `was_on` is the one to believe.

What remains is not fixable: presses made before that landed were all logged
under one name and cannot be split retroactively. They are reported separately
rather than folded into either side.

### `client_errors` — crashes and thrown errors
Params: `days`, `contains` (optional), `release` (optional), `limit`.
Columns: `message`, `source`, `line`, `page`, `release`, `errors`, `people`, `last_seen`.

This query was written against an event that did not exist yet, and **it now does**. The
client-side handler has landed in `js/analytics.js`: `window.onerror` and
`unhandledrejection`, reporting through the same `capture()` seam as everything else, as
one event named `client_error` with exactly `message`, `source`, `line`, `page`,
`release`. The two things this query needed are already true of it —

- **`message` carries no reader input.** That file scrubs query strings, `user:pass@`,
  email addresses and any unbroken 24-character run (a uid, a Stripe id, a restore token)
  before clipping to 100 characters. This query truncates to 200 as well, which is now
  redundant and stays as a floor in case the client cap ever moves.
- **`source` is a path, not a URL.** Grouping is on the exact string, so a cache-busting
  query parameter would have turned one bug into fifty rows.

There is deliberately no `stack` property, and this query does not ask for one: a stack is
many lines of many URLs, and this site puts working secrets in URLs.

`release` is the `RELEASE` constant at the top of `js/analytics.js` — currently
`2026-09-04a` — so a spike can be pinned to a deploy. It has to be bumped by hand when the
file changes; a release field that always says the same thing is worse than none.

Zero rows here means zero crashes reported, not a broken query.

### `event_volume` — one event, by day
Params: `event` (**required**, from a fixed allowlist), `days`, `limit`.
Columns: `day`, `events`, `people`.

The allowlist is every event name the site currently sends, held in `functions/insights.js`
as `KNOWN_EVENTS`. A name outside it is `bad_query`, not a query for a made-up event. When
`js/analytics.js` gains an event, add it there.

### `reader_activity` — who read what, and how far

**One of three queries that return personal data, and it is deliberate. Read §6.**
The other two are `reader_dwell` and `person_timeline`, and all three number readers off
**this** query's roster — see "one ordinal space" under `person_timeline`.

Params: `days`, `limit`, `exclude_admins`. `limit` here is clamped **1–400** and defaults
to 200, because a row is a (reader, story) pair rather than a person; every other query
keeps the published 1–200.

One row per reader per story, most recently active reader first.

| column | what it is |
|---|---|
| `reader` | an **ordinal** — `"1"`, `"2"`, `"3"` — assigned by the function per response, most recent first. It is not stable between two responses and is derived from nothing, so it cannot follow anyone. It exists so a UI can group a reader's story rows. |
| `email` | the account's email address, **or `null`** for a reader with no account |
| `last_seen` | when that reader was last active anywhere in the window |
| `stories` | how many stories this reader has rows for |
| `story` | the story id. **No title** — the function has no catalogue and should not grow one; the dashboard reads `/data/index.json`, which it already loads for the story picker. |
| `opens` | `stack_open` count for that reader and story |
| `cards_seen` | distinct cards with a `card_view` — the **maximum** across the reader's identities, never a sum, because a card seen under two ids is one card |
| `furthest_card` | the deepest card number reached |
| `finished` | boolean: a `stack_complete` was recorded |
| `story_last_seen` | last activity on that story |

**Where the email comes from.** Not PostHog. PostHog holds a `distinct_id`, which is the
Firebase uid once `js/analytics.js` has called `identify(uid)`; Firebase Auth turns that
into an email; the function holds credentials for both and does the join in memory, per
request, writing nothing. **An email must never be sent to PostHog.**

**The fold.** PostHog returns one row per (person, distinct id, story). A reader who read
signed out and then signed in has two distinct ids and one `person_id`, so the function
folds on the person — otherwise the same human appears twice, once anonymous and once by
name. Neither identifier is in the response.

**The bound.** The query asks for `limit + 1` rows and reports `meta.truncated: true` when
that extra row came back, so "there are more of these" is a fact rather than a guess. It
is for tens of people; at 400 rows it stops rather than tries.

`meta` adds `readers`, `with_email`, `anonymous`, `truncated`.

If **every** Firebase Auth batch fails, the query answers `upstream` with
`reason: "auth_lookup"` rather than returning a screen of readers labelled anonymous.
A partial failure is a gap in one column and is not an error.

### `geo_breakdown` — where the readers are

*Answers the owner's "what country they are from", as counts on a map and never as a
location beside a person's name.*

Params: `days` (or `from`/`to`), `limit`, `exclude_admins`.

One row per country, **ordered by `people` descending**.

| column | what it is |
|---|---|
| `country` | `$geoip_country_name`, or the literal string `"Unknown"` for events PostHog could not place |
| `country_code` | `$geoip_country_code` — a two-letter ISO code, `null` on the Unknown row |
| `people` | distinct people seen from that country in the window |
| `opens` | `stack_open` count |
| `page_opens` | `page_open` count |
| `card_views` | `card_view` count |
| `located` | `false` on the Unknown row, `true` on every other |
| `people_pct` | `people` as a share of the summed `people` column (see the warning below) |

`meta` adds `countries`, `people_rows`, `unlocated_people_rows` and **`geo_usable`**.

#### Read `geo_usable` before you draw anything

`geo_usable` is `false` when the window contains one country or none. **Do not draw a map
on a false.** PostHog derives country from the IP at ingestion, and this site does not send
PostHog the reader's IP directly — every event goes through the Cloudflare Worker in
`cloudflare/posthog-proxy.js`, so the connection PostHog terminates is Cloudflare's. One
line of that Worker, `headers.set("X-Forwarded-For", ip)` from `CF-Connecting-IP`, is the
whole reason this data is the reader's country rather than a datacentre's. If that line is
ever lost the symptom is a panel that looks completely normal and is completely false:
every reader on earth in one place. So the failure is detected server-side and reported.

**It was checked against live data before this shipped, and it is real.** On 6 September
2026, over the whole 90-day history with admins excluded: United States 55 people / 101
story opens, Canada 7 / 16, Bangladesh 1, Ireland 1, United Kingdom 1 — five countries,
`geo_usable: true`, and **zero** unlocated events. Five countries again at a one-day
window, and again at three, seven and thirty-one. The Worker forwards the IP and PostHog
resolves it. (These are a snapshot of a live site and they move — the US row was 55 people
and 101 page opens at 16:32 UTC and 56 and 102 half an hour later, which is a reader
arriving, not a rounding error.)

#### Three things this column is not

- **`people` does not sum to the site's readers.** It is `count(DISTINCT person_id)` *per
  country*, so one reader who travelled — or turned on a VPN — is in two rows.
  `meta.people_rows` is the sum of the column and is named for what it is, not for the
  number of readers. `people_pct` is a share of that sum.
- **The Unknown row is a row.** Events that could not be placed are counted and labelled
  rather than dropped, because a map whose percentages quietly exclude the people it could
  not locate is the same lie in a smaller font.
- **`exclude_admins` moves the event counts and barely moves `people`.** Measured on the
  same day: excluded → included takes Canada's `page_opens` from 64 to 238 and the US
  `card_views` from 283 to 365, while `people` does not move at all. That is §4's
  documented `distinct_id` limitation showing up where it is most visible — the founders'
  *signed-in* events are removed, their pre-`identify` anonymous events are not, and those
  are enough to keep their `person_id` in the distinct count. **The event columns respect
  the switch; the `people` column is a floor, not a filtered number.**

#### What is deliberately not here

No city, no region, no timezone, no IP, and **no country on any per-person row**. PostHog
holds all of them. A country beside one named reader is a location attached to an
individual, which is a different promise to readers than a map is; it would need a
sentence in `privacy.html` that is not there yet.

### `reader_dwell` — how long each reader spent on each card

**Personal data, like `reader_activity`. Read §6.**

*Answers the owner's "dwell times per user on each page or card" — which cards, how long
on each, and a total per reader.*

Params: `days` (or `from`/`to`), `limit` (**1–600**, default **300**), `story` (optional),
`page` (optional), `roster_limit`, `exclude_admins`.

One row per (reader, page, story, card), grouped by reader, **in reading order within each
reader** — page, then story, then card ascending.

| column | what it is |
|---|---|
| `reader` | the **same ordinal** `reader_activity` prints. See "one ordinal space" below. `null` only when the roster truncated. |
| `email` | the account's email address, or `null` for a reader with no account |
| `page` | `card_view.page` — the address it was read at, or **`null` for a view recorded before that property shipped** |
| `story` | `card_view.story` |
| `card` | the card number |
| `views` | how many times this reader saw this card |
| `dwell_s` | **sum** of `card_view.dwell_s` for this reader and card — the raw total |
| `dwell_s_capped` | the same sum with each individual view first clipped to `meta.dwell_cap_s` |
| `median_dwell_s` | median of the individual views |
| `longest_dwell_s` | the longest single view |
| `last_seen` | last `card_view` of this card by this reader |
| `reader_cards` | how many card rows this reader has |
| `reader_views` | that reader's total `card_view` count |
| `reader_dwell_s` | that reader's raw total across every card |
| `reader_dwell_s_capped` | the same total, capped |
| `reader_median_card_dwell_s` | median of that reader's per-card totals |
| `reader_last_seen` | that reader's last card view |

The six `reader_*` columns are the **per-reader totals**, repeated on every row of that
reader's group — the same shape `reader_activity` uses for `stories` and `last_seen`. A UI
grouping by `reader` reads them off the first row and needs no second request.

`meta` adds `readers`, `with_email`, `anonymous`, `card_rows`, `unranked_rows`,
`dwell_cap_s`, `roster_readers`, `roster_truncated` and `truncated`.

#### There is no average, and here is why

`dwell_s` is time a card was **on screen**. `js/analytics.js` already refuses anything
under 900 ms (a swipe) or over 30 minutes (a machine that slept), so raw values are bounded
at 1800 — and 1800 seconds is still a tab somebody left open, which is enough to own a
mean.

**So nothing here returns a mean, at any grouping.** What comes back instead is the raw
sum, the same sum with every individual view clipped to `dwell_cap_s` (**180 seconds**),
the median, and the longest single view.

The clip is measured, not chosen. Over the whole live history on 6 September 2026 — 336
card views, admins excluded — a single view's median is **3.0 s**, its 75th percentile
6.5 s, 90th 23.7 s, 95th 50.7 s, 99th **222.4 s**, longest **923.6 s**. A 180 s clip
touches a little over one view in a hundred.

And what it removes is the reason the pair of numbers exists: those few views are **21.5%
of all dwell on the site** — 4,743 raw seconds against 3,725 capped — and **820 of the
1,018 seconds removed belong to one reader whose median card is 3.0 s**. A mean would have
been that person's abandoned tab wearing everybody else's name. Show `dwell_s` and
`dwell_s_capped` together; where they disagree loudly, that *is* the finding.

#### `page` is nearly empty today, and that is correct

`card_view.page` is a new property and **cannot be backfilled**. On 6 September 2026 only
**4 of 219** rows carried one; the rest are `null`, meaning "this story, at whichever
address". It fills as readers pick up the current client. A `null` page is not the home
page and must not be labelled as one.

#### The bound

The query asks for `limit + 1` rows; `meta.truncated: true` means the extra row came back.
**When it is true, the `reader_*` totals of the readers nearest the cut are partial** —
rows are ordered by recency across everybody, so a cap takes a reader's older cards away.
The whole 90-day history is 219 rows against a default cap of 300, so this does not bite
today.

### `person_timeline` — one reader's session, in order

**Personal data, and the most of it. Read §6.**

*Answers the owner's "one person did x then y then z and then an hour later" — the events,
in time order, with the time between them.*

Params: `reader` (**required**), `days` (or `from`/`to`, **ceiling 31 days**), `limit`
(**1–500**, default **200**), `roster_limit`, `exclude_admins`.

Rows come back **oldest first**, which is the order the story reads in.

| column | what it is |
|---|---|
| `at` | the event timestamp, ISO |
| `event` | the event name, exactly as `js/analytics.js` sent it |
| `detail` | a short human string built by the function from named properties — `"story 01 · card 7 · 6.6s on screen"`, `"pressed fb_acct_btn · on /home"`, `"/explore"`. **Empty when the event carries nothing to say**, in which case the event name is the whole fact. |
| `gap_s` | **seconds since the previous row**, and `null` on the first. This is the "and then an hour later". |
| `session` | 1, 2, 3 … incremented whenever `gap_s` reaches `meta.session_gap_s` (1800 s) |
| `page`, `story`, `card`, `dwell_s` | the named fields `detail` was built from, so a UI can lay this out as a table instead of parsing prose back apart |

`meta` adds `reader_found`, `reader_email`, `reader_last_seen`, `reader_stories`,
`roster_readers`, `roster_truncated`, `sessions`, `first_event`, `last_event`,
`longest_gap_s`, `card_views`, `reading_s`, `reading_s_capped`, `dwell_cap_s`,
`session_gap_s` and `truncated`. The `reading_*` and `card_views` figures describe **the
rows returned**, not the whole window — when `truncated` is true there is more.

#### `reader` is an ordinal, and the resolution happens server-side

Send the integer `reader_activity` printed. The function re-runs that roster, folds it the
same way, takes the *n*-th record and asks PostHog for that person's events. **No
`person_id`, no `distinct_id` and no uid crosses the wire in either direction.** This is
why the query costs two upstream calls instead of one.

**The ordinal is as of a window, so pass the same window.** The roster is built from the
parameters *you* send; different parameters give a different roster and therefore a
different person. Two things make that safe rather than sharp:

- Pass an absolute **`from`/`to`** rather than `days` and the roster stops moving underneath
  you between the table being drawn and the row being clicked.
- Every response echoes **`meta.reader_email`** and **`meta.reader_last_seen`**. Print them
  beside the timeline: a human can then see at a glance that it is still the row they
  clicked.
- If the table was drawn with a non-default `limit`, send that same number as
  `roster_limit`. Ordinals are stable under truncation for every reader *before* the cut,
  so this only matters when the roster actually truncated — but "usually the right person"
  is not a property this query is allowed to have.

**An ordinal past the end of the roster is not an error.** A reader who was 7th when the
table was drawn is 8th after somebody else reads a card. The answer is `200` with
`rows: []` and **`meta.reader_found: false`**. Branch on that, not on an error code.

#### One ordinal space, across all three personal queries

`reader_activity`, `reader_dwell` and `person_timeline` all number readers off the **same**
roster — `reader_activity`'s query through the function's one `foldReaders()`. **"Reader 5"
is one person in every table on the page**, so a row clicked in the dwell table opens the
right timeline. This is why `reader_dwell` also costs two upstream calls: an earlier draft
numbered its own rows and produced a second, silently different ordinal space.

#### The bounds, and what a wide window costs

- **Rows:** `limit + 1` is asked for; `meta.truncated: true` means there is older history
  this response does not contain. A cap that bites drops the **oldest** events, never the
  most recent.
- **Window: 31 days, hard.** Ask for 90 and you get 31 with `meta.params.clamped_to_days:
  31`. This query filters on a *person* rather than an event name, so ClickHouse scans the
  window instead of using the event index.
- **Measured** end to end on the live project on 6 September 2026, both upstream calls plus
  the Firebase Auth join: 1 day **101 ms**, 7 days **845 ms**, 31 days **576–722 ms**,
  a 98-day range clamped to 31 **2282 ms**. Nothing near a timeout — the ceiling is kept
  because the scan grows with the whole site's volume while the answer stays one person's
  afternoon, and a month is the window a human reads a timeline over.

#### What a row will never carry

- **`client_error.message`.** It is the one field on any event this site sends that can
  hold something a reader typed. `client_errors` reports it, grouped, where it is a bug
  report rather than a person's afternoon.
- **PostHog's own autocapture.** `$pageview`, `$pageleave`, `$autocapture` and
  `$web_vitals` are excluded. They outnumber the site's own events roughly four to one —
  the first run of this query filled all 500 rows with three days of one person's
  `$pageleave` and reported itself truncated. Nothing is lost: `page_open` fires on every
  page of this site and carries the page's **name**, which `$pageview` does not.
- **The reader's country.** See `geo_breakdown`.

### `firststory_cards` — how far people scrolled on /firststory

Params: `days`, `limit`, `exclude_admins`.
Columns: `card`, `views`, `people`, `median_dwell_s`, `reach_pct`, `dropoff_pct`.

The drop-off graph for the cold-arrival page the launch videos point at. **It filters on
`card_view.page`, not on the story id**, and the difference matters: story `01` is served
at `/read?s=01`, `/cleopatra` **and** `/firststory`, so filtering on the story answers
"how far did people get in Cleopatra" — a different question, and answering the second
with the first would be the kind of wrong that looks right.

`page` on `card_view` is **new** and **cannot be backfilled**: card views recorded before
it shipped carry no page and are in none of these rows. Zero rows before the client is
pushed to readers is the correct answer, not a broken query.
`reach_pct`/`dropoff_pct` are computed in the function, against **people**, not views.

### `firststory_funnel` — arrived at /firststory, then what

Params: `days`, `exclude_admins`. Returns funnel rows in step order.

**A cohort, not site-wide step reach.** Everybody counted opened `/firststory` or read a
card there inside the window; every step is counted only inside that group. That is what
makes "of the people who reached the end, how many signed up" answerable at all — it is a
question about the same person doing two things, which no table of totals can answer.

Columns: `step`, `label`, `people`, `pct_of_first`, `pct_of_previous`.

| step | from |
|---|---|
| `arrived` | `page_open` where `page = 'firststory'` |
| `read_a_card` | `card_view` where `page = 'firststory'` |
| `reached_the_end` | `first_completion_screen_viewed` where `stack = '01'` |
| `opened_the_gate` | `join_view` |
| `signed_in` | `signin_email`, `signin_google`, `signup_email`, `join_signup` |
| `reached_stripe` | `checkout_start` |
| `paid` | `access_gained` where `from = 'stripe'` |
| `came_back_later` | active on **more than one calendar day (UTC)** inside the window, any page |

Then four rows with **`pct_of_previous: null`**, which is how a row says "I am not a
step" — the same signal `subscribe_funnel`'s `blocked` row carries: `end_card_built`,
`finished_the_story`, `account_created_email`, `opened_the_home_page`.

**Five things a caller must print rather than imply.**

1. **Step reach, not a strict ordered path**, exactly as `subscribe_funnel` §3 says. The
   cohort stops a stranger appearing at step 6 with nothing above it, but it does not
   verify that the same person did step 3 after step 2. A later bar **can be taller than
   the one above it** — the sign-up page is reachable from the paywall part-way through
   the story, not only from the end card.
2. **`reached_the_end` cannot be narrowed to the sign-up ask.** `/firststory` builds its
   end card with `cta: "Sign up to read more"` (firststory.html line 14), which replaces
   the countdown with a sign-up control — and **nothing records that**. `rec_view` carries
   `stack` and `n`; `first_completion_screen_viewed` carries `stack` and `mins`; neither
   carries the cta and neither carries the page. So the step is "reached the end card of
   story 01, having been on /firststory", an attribution by person. One property on either
   event would close it.
3. **`reached_stripe` means we sent them.** Whether Stripe's page rendered, and what
   happened on it, is on another origin and no event of ours can see it.
4. **`paid` undercounts.** It is a browser event; somebody who pays on a phone and returns
   on a laptop is missed. `subscription_totals` is not, and wins.
5. **`signed_in` is one step, not two.** `login.html` fires `signin_google` for a new
   account and a returning one alike (ANALYTICS.md §4 item 2), so a separate sign-up count
   undercounts by every Google sign-up. The email-only split is the
   `account_created_email` context row, labelled as the undercount it is.

`meta` adds `cohort`, `arrivals` (page opens at /firststory, events not people),
`card_views_here`, `card_views_story`, **`card_views_unattributed`**, `deepest_card`,
`truncated`.

`card_views_unattributed` is card views of story 01 that name **no** address at all —
recorded before `page` shipped on `card_view`. It is a subtraction (`card_views_story`
minus the views naming one of the three known addresses) rather than a test for absence,
because a missing property is `NULL` in HogQL and `NULL = ''` is `NULL`, so testing for
`''` would have reported zero of these forever. They are not counted as `/firststory` and
they are not thrown away.

The scan is per person and capped at 5,000 rows, ordered so the /firststory people come
first; `meta.truncated` says when the cap was hit and the answer is a sample.

### `subscription_totals` — the authoritative subscriber count
Params: none. `meta.source` is `"firestore"`.

Rows: `accounts`, `premium_accounts`, `premium_pct`, and `admin_accounts`.

**The admin switch does not apply here, and `admin_accounts` is why it does not apply
silently.** These are Firestore counts of ACCOUNTS, not of analytics events: there is no
event to leave out, and subtracting the founders would stop this being the authoritative
subscriber number, which is the only thing it is for. So the totals stay whole, the count
of admin accounts is returned beside them, and `meta.admin_filter` is `not_applicable`. A
UI must say so on the tile rather than let the switch appear to have been honoured.

The one query that does not touch PostHog. The last step of `subscribe_funnel` is derived
from a browser event and is therefore subject to ad blockers, tab closes and the 10–25%
loss any client-side analytics carries. **This is the number that is true**, read with
Firestore `count()` aggregations over `customers` — two aggregation queries, no documents
fetched, no field read but the count itself. When the funnel and this disagree, this wins.

---

## 4. Parameters, and what each will accept

Every parameter is validated against a type and a character set before anything is built.
A value that does not match is `bad_query` with a `field`. Nothing is coerced silently
except clamping, and clamping is echoed back in `meta.params`.

### The time window: `days`, or `from`/`to`

Every query that has a date window takes either form, and the response says which was
used.

- **`days`** — a relative floor. An integer, clamped to 1–90, and then to the query's own
  ceiling if it has one: `event_volume` and `person_timeline` are capped at **31 days**.
  When a ceiling moves the number, `meta.params.clamped_to_days` says so.

  > **Fixed on 6 September 2026.** The per-query ceiling was only ever applied on the
  > `from`/`to` path. `event_volume` — whose ceiling exists *because* a 36-day day-by-day
  > scan timed out upstream with a 502 — answered `{"days": 90}` by running the 90-day
  > scan. Found by asking `person_timeline` for 90 days and getting 90 days. Both paths
  > clamp now.
- **`from`` / ``to`** — two `YYYY-MM-DD` strings, an absolute range, which is what a date
  picker actually has. `to` is **inclusive of its own day**: 21 August to 4 September
  scans both of those days. Give one end and the other is today. Give them backwards and
  they are swapped. Give a span over 90 days and `from` moves forward — a picker dragged
  across a year is a picker at its end, not an error, and 90 days is a cost bound however
  the range was written. `2026-02-31` matches the shape and is not a date, so it is
  refused.

`meta.from`, `meta.to` and `meta.days` always report the window that was actually scanned.

| param | type | rule | default |
|---|---|---|---|
| `days` | integer | clamped to **1–90**; ignored when `from`/`to` are given | 14 |
| `from`, `to` | string | `YYYY-MM-DD`, a real calendar date, span clamped to 90 days | — |
| `limit` | integer | clamped to **1–200** | 50 |
| `story` | string | `^[A-Za-z0-9_-]{1,24}$` | all stories |
| `page` | string | `^[a-z0-9_]{1,40}$` | all pages |
| `contains` (or `q`) | string | `^[A-Za-z0-9 _.:/-]{1,40}$` | no filter |
| `release` | string | `^[A-Za-z0-9._-]{1,40}$` | all releases |
| `event` | string | must be in `KNOWN_EVENTS` | — (required) |
| `reader` | integer | **1–400**, and a JSON number or string only — refused, never clamped. `person_timeline` only. | — (required) |
| `roster_limit` | integer | 1–400. `person_timeline` and `reader_dwell` only. | 200 |
| `exclude_admins` | boolean | `true`/`false`, and `1`/`0`/`"true"`/`"false"`/`"yes"`/`"no"`. Anything else is `bad_query`. | **`true`** |

`limit` is clamped 1–200 everywhere except the three queries whose rows are not
people: `reader_activity` 1–400 (default 200, rows are reader×story pairs),
`reader_dwell` 1–600 (default 300, rows are reader×page×story×card), and
`person_timeline` 1–500 (default 200, rows are one reader's raw events).

**`reader` is refused rather than clamped**, unlike every other integer here. `reader: 0`
and `reader: 900` are not a slider at its end — they are a caller that has lost track of
which row was clicked, and quietly answering about reader 1 instead would put one person's
afternoon under another person's name. It also refuses anything that is not a JSON number
or string: `[1]` used to coerce through `String()` to `1`, which was found by sending
exactly that.

### `exclude_admins`, and what it actually does

Every query takes it, including `subscription_totals`, which echoes it and does not apply
it. For the PostHog-backed queries the function appends
`AND distinct_id NOT IN ('…','…')` — built here, out of uids read here from `customers`
where `admin === true` or `role === "admin"`, plus the calling admin's own uid, each one
quoted through the same `lit()` that guards every other value. **A caller cannot send a
uid, see one, or influence which are in the list.** The lookup is cached for 60 seconds,
so a fourteen-panel render is one collection scan rather than fourteen.

**It defaults to on.** The honest default is "numbers about strangers"; seeing your own
traffic is the special case and has to be asked for.

**The one honest limit.** It matches on `distinct_id`, which is a Firebase uid only after
`identify(uid)` has run. Events an admin sent **before signing in on a device** carry an
anonymous distinct_id and are not removed, even though PostHog has stitched them to the
same person. The founders sign in and stay signed in, so this is a rounding error — but it
is a rounding error, not a guarantee, and a UI that says "excluded" should not claim more
than that. Matching on `person_id` would need a subquery over a table this function has
never run against, and an untested HogQL construct takes a whole panel down rather than
one row of it.

Note what those character sets exclude: quote, double quote, backslash, semicolon,
parenthesis, brace, percent, comma, newline. A parameter cannot contain a character that
would end a string literal, and a final assertion re-checks that immediately before the
value is placed into the query text — see §6.

---

## 5. Rate limits

Per admin, and globally, counted in **Firestore** so they hold across instances and cold
starts. The numbers are sized for a dashboard that loads a dozen panels at once and
refreshes now and then, not for a script.

| limit | value |
|---|---|
| per admin, per minute | 60 |
| per admin, per hour | 480 |
| per admin, per day | 1000 |
| all admins, upstream queries per day | 3000 |

A `rate_limited` for the minute or hour cap carries `retry_after_s`. The day and global
caps do not — the answer is tomorrow.

`subscription_totals` counts against the per-admin limits but not the global upstream one,
because it never leaves Google.

**The global cap counts upstream queries, not requests.** One request is normally one
PostHog query, but `person_timeline` and `reader_dwell` make **two** — a roster call to
resolve the reader ordinal, then the query itself — and each spends two of the 3000. A
query that cost two and was billed one would let the ceiling be overshot by half,
quietly.

The per-minute and per-hour caps were 30 and 240 while the dashboard had eleven panels.
A full render is now **thirteen requests** (fourteen queries, less `subscribe_funnel`,
which the page no longer draws; fifteen when a story is picked), and at 30 a minute an
admin pressing Refresh twice while reading a launch would lock themselves out of their own
numbers — a cap protecting nothing from anybody.

The dashboard should load its panels **sequentially or in small batches**, not thirteen at
once every render. Sixty a minute is generous for a human and stingy for a render loop,
which is the intent.

---

## 6. What the browser cannot do

Worth stating plainly, because the obvious version of this feature is a hole.

**There is no way to send a query.** Not HogQL, not SQL, not a fragment, not a column
name, not a table name, not an ORDER BY. The seventeen query texts are string constants in
`functions/insights.js`. `params` contributes values only, at positions the function
chose, and every value has already been checked against a character set that contains no
quote and no backslash. A read-only PostHog key still reads *everything* in the project —
so the defence cannot be "the key is read-only", it has to be "the browser never gets to
write a query". It does not.

**Fourteen of the seventeen queries cannot get an identity out.** They select no
`distinct_id`, no `person_id`, no `$ip`, no email and no person property. People are
counted with `count(DISTINCT …)` and the count is what is returned. There is no
`SELECT *` anywhere in the file. The one query that touches Firestore uses `count()`
aggregations, which return a number and never open a document.

**`reader_activity`, `reader_dwell` and `person_timeline` are the exceptions, and they
are deliberate.** This paragraph used to say "there is no way to get an identity out"
without qualification, and it is being changed rather than quietly left to rot, because a
reader of this file must not conclude from fourteen queries that the other three are
impossible.

The owner asked to see "the emails / accounts and which stories they viewed, how far they
got", then "dwell times per user on each page or card", then "one person did x then y then
z and then an hour later". With a handful of readers an aggregate percentage says nothing
and a list of people says everything. So three queries return one email per reader. Five
things keep all three narrow, and every one of them is a property of the code rather than
a promise:

1. **The email never comes from PostHog.** It is not there and must not be put there.
   PostHog holds the uid because `identify(uid)` put it there; Firebase Auth holds the
   email; the function holds credentials for both and joins them in memory, per request.
   Nothing is written anywhere.
2. **The uid and the person id never reach the browser.** Rows carry an ordinal assigned
   per response, so a row cannot be matched to a row in another response. There is **one**
   such ordinal space, shared by all three queries, built by one `foldReaders()` — so
   "reader 5" is one person across the whole page. `person_timeline` is the reason this
   matters most: a caller asks about a person by sending back the integer it was shown,
   and the resolution to a `person_id` happens upstream, inside one request, and is
   discarded with it.
3. **A reader with no account stays anonymous.** `email` is `null`, the behaviour is
   intact, and nothing is invented to fill the column.
4. **They are bounded**: a row cap on all three, `meta.truncated` as a fact rather than a
   guess, most-recent-first ordering — and on `person_timeline` a hard **31-day** window
   ceiling as well, because one person's month is a timeline and one person's year is a
   dossier.
5. **They are logged.** A second log line — `insights personal` — names the admin uid, the
   query, the reader count and the email count, and for a timeline also **which ordinal
   was asked for and whether it resolved**. It carries no email, no uid, no person id and
   no story. A personal-data read that leaves no trace is one nobody can answer a question
   about later.

Four queries return a `person_id` **from PostHog** and drop it inside the function:
`firststory_funnel` folds per-person rows into funnel steps, and `reader_activity`,
`reader_dwell` and `person_timeline` fold them onto a person. **No `person_id` is in any
response** — verified by grepping the live responses of all four for a UUID and for the
calling admin's uid, and finding neither. That is worth knowing before editing any fold.

**Geography is counted, never attached.** `geo_breakdown` reads PostHog's `$geoip_*`
properties and returns counts by country. It returns no city, no region, no timezone, no
IP, and **no country on any per-person row** — including `person_timeline`'s. A country
beside a named reader is a location attached to an individual, which needs a sentence in
`privacy.html` that is not there.

**No other query gained an identity.** Sweep for it after any change here: nothing but
those three may put an `email` on a row.

**There is no way to reach another project.** The PostHog project id is a secret read
server-side and interpolated into the URL by the function; it is not a parameter.

---

## 7. What has to exist before this returns rows

Three things, all the owner's, none of them in the repo:

1. A **PostHog personal API key** with the `query:read` scope, from
   *PostHog → Settings → Personal API keys*. Scope it to the one project.
2. The **project id** — the number in the PostHog dashboard URL, `.../project/12345/...`.
3. Both put into Secret Manager:

   ```
   firebase functions:secrets:set POSTHOG_API_KEY     --project factbox-7cb97
   firebase functions:secrets:set POSTHOG_PROJECT_ID  --project factbox-7cb97
   firebase deploy --only functions:insights --project factbox-7cb97
   ```

Until then every PostHog-backed query answers `{"ok":false,"error":"upstream",
"reason":"not_configured"}` — a `502`, deliberately, because the dashboard is not broken
and the caller is not at fault. `subscription_totals` works immediately; it needs no key.

Two more `upstream` reasons exist and both mean the function could not do a job it holds
credentials for, not that PostHog refused: `admin_list` (the `customers` scan for admin
uids failed **while `exclude_admins` was on** — it fails closed rather than answering with
unfiltered numbers under a label that says filtered) and `auth_lookup` (every Firebase
Auth batch for `reader_activity` failed).

Admin itself is granted by setting `admin: true` on `customers/<uid>` in the Firebase
console. `firestore.rules` denies every client write to that document, so it is a
console-or-webhook field only. `role: "admin"` also works — `js/auth.js` accepts either
and this function matches it exactly.

---

## 8. Curl, for when the dashboard is the thing under suspicion

```bash
TOKEN=...   # a Firebase ID token for an admin account
curl -s -X POST https://us-central1-factbox-7cb97.cloudfunctions.net/insights \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"card_dropoff","params":{"story":"26","days":14}}'
```

The three that answer the owner's questions about people:

```bash
# where readers are — check meta.geo_usable before drawing a map
-d '{"query":"geo_breakdown","params":{"days":90}}'

# how long each reader spent on each card
-d '{"query":"reader_dwell","params":{"days":31,"limit":600}}'

# who is reader 3 — then reader 3's afternoon, in order, with the gaps
-d '{"query":"reader_activity","params":{"from":"2026-08-06","to":"2026-09-06"}}'
-d '{"query":"person_timeline","params":{"reader":3,"from":"2026-08-06","to":"2026-09-06"}}'
```

Send `reader_activity` and `person_timeline` the **same window**, and prefer `from`/`to`
over `days` — the ordinal is a position in a roster that keeps moving. Check
`meta.reader_email` against the row you clicked.

The quickest way to get a token: sign in on factbox.app as the admin account and run
`await FBU.user().getIdToken()` in the console. That is also how the dashboard should get
one — `FBU.user()` is the Firebase user object, `getIdToken()` refreshes it when it is
close to expiring, and it must be called per request rather than cached for the hour.
