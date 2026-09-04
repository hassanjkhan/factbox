# Factbox — the backend

SPEC.md §9 opens by admitting that the gate on this site is not a gate: `data/stacks.json`
is a public file, and anyone with dev tools reads all 51 stories. This document describes
the thing that fixes that, and is equally blunt about what it does not fix yet.

The short version. Story text now lives in Firestore, closed to every browser. A Cloud
Function verifies a Firebase ID token, reads the `premium` flag that the Stripe webhook
maintains, and only then hands over a paid story. Audio beds live in Cloud Storage behind
deny-all rules, reachable only through URLs that same function gives out. Images have not
moved and should not.

Everything below was measured against `factbox-7cb97`, not estimated.
`node tools/check-backend.js` re-runs all 39 assertions.

---

## 1. What is where

| | Firestore | Storage | GitHub Pages |
|---|---|---|---|
| Story text | **yes** | | `data/stacks.json` (source of truth, still served) |
| Covers / titles / hooks | `catalogue/v1` | | |
| Audio beds | URLs only | **31 mp3, 4.0 MB** | `audio/*.mp3` (still served) |
| Card plates | | | **stays** — 361 public-domain Wikimedia paintings |

Images do not move. They are public-domain paintings; gating them protects nothing, and
serving ~10 plates per story out of Firebase would be the single largest egress line in
this document by two orders of magnitude. GitHub Pages serves them for nothing.

`data/stacks.json` stays the source of truth (SPEC.md §5). Firestore is a serving copy and
`tools/seed-firebase.js` is what keeps the copy honest.

Four functions, four files, and they share nothing but `admin.initializeApp()`:
`index.js` is the Stripe webhook, `story.js` the gated read path (§4), `today.js` which
story is free (§4b) and `support.js` the support inbox (§4c).

---

## 2. Firestore layout

```
stories/{id}      51 docs   the full story, cards and all — no browser may read this
catalogue/v1       1 doc    51 covers, titles, hooks, lengths, credits — public
meta/content       1 doc    corpus version and counts — public
customers/{uid}             unchanged; written by the Stripe webhook, read by the gate
daily/{YYYY-MM-DD}          editorial override: which story is free that day — public read,
                            no client write. Absent = the deterministic pick. §4b
support/{stamp-xxxx}        what a reader typed on /support. Six fields, built by the
                            function, deny-all to every browser in both directions. §4c
support_meta/quota          today's date, today's stored count, today's mailed count. §4c
support_meta/salt           today's date and 32 random bytes, rotated daily, used to
                            HMAC a caller's IP into a rate-limit bucket id. §4c
support_ip/{hmac}           one counter per hashed IP per day. No address, no message.
                            TTL on `expiresAt` deletes it after ~26 hours. §4c
```

### One document per story, not nine

Firestore bills per document read, so this is the only layout decision that matters.
A story is nine to twelve cards and a reader who opens one reads all of them — there is no
access pattern in this product that wants a single card on its own. Splitting a story into
per-card documents would turn every open into 9–12 reads to serve exactly the same bytes:
a tenfold bill for nothing. One document, one read.

The obvious counter-argument is the 1 MiB document cap, so it was measured rather than
assumed. Measured against Firestore's own size accounting, not JSON length:

```
largest story  stories/05   13,419 B   1.28% of the 1 MiB cap
catalogue/v1                42,572 B   4.06%
```

Eighty times the headroom on the largest story in the corpus. A story would have to grow
from 12 cards to roughly 900 before the cap became a question, and the seeding tool throws
rather than writes if one ever does.

The other direction — all 51 stories in one document — fails on the same cap (423 KB of
text before credits, and it grows) and would ship every paid story to anyone entitled to
one. Per-story is also what makes the gate expressible: entitlement is per document.

### The catalogue is separate, and that is the point

`catalogue/v1` holds each story minus its `cards` and `supp`: artwork, title, hook, length,
topic, credits, card count. SPEC.md §4 says covers are the pitch and a locked story still
has to show its artwork, so this has to be readable by a stranger — and it must contain no
card body text, because that is the thing being sold. One document, so a whole library
screen costs one read instead of 51.

`hook` is in there deliberately. It is already the headline of card 1 and already on the
public marketing pages; it is the pitch, not the product.

### Idempotence

Every document carries a `hash` field — a SHA-256 over its content with object keys sorted,
so a re-serialisation with different key order is not mistaken for a change. The seeder
lists the existing hashes (51 reads), writes only what differs, and deletes documents that
no longer exist in `stacks.json`. `meta/content` is written only when something else was,
so a no-op run really is a no-op and `updatedAt` means what it says.

Proven, not asserted:

```
run 1:  audio: 31 uploaded (4.00 MB), 0 unchanged
        firestore: 51 stories changed, 0 unchanged, catalogue changed -> 53 write(s)
run 2:  audio: 0 uploaded, 31 unchanged
        firestore: 0 stories changed, 51 unchanged, catalogue unchanged -> 0 write(s)
run 3:  ... -> 0 write(s)
```

---

## 3. The seeding tool

`node tools/seed-firebase.js` — sync Firestore and Storage from `data/`.

```
--dry-run        report what would change, write nothing
--skip-audio     Firestore only
--skip-stories   Storage only
--rotate-tokens  mint new audio download tokens, invalidating every URL handed out
```

### REST API, not an admin function

There are no application-default credentials on this machine and no service-account key
file — and there should not be one, because a downloaded key is a permanent credential
sitting in a directory. That left two options.

**A one-shot admin function** would have to carry a copy of `stacks.json` inside
`functions/`, giving the corpus two homes and this repo the build step it has spent its
life not having. Worse, a seeding endpoint is an endpoint: it exists on the public internet
from the moment it deploys until somebody remembers to delete it, and an endpoint whose job
is "rewrite the entire corpus" is the worst possible thing to leave lying around behind a
guard nobody will re-audit. It would also make fixing a typo a deploy.

**The Firestore REST API** with the token the Firebase CLI already holds does the same work
with no new attack surface, no duplicated data, and no deploy in the loop. That is what the
tool does. The token comes from `~/.config/configstore/firebase-tools.json`, where
`firebase login` puts it; it carries the `cloud-platform` scope and lasts an hour. When it
is close to expiry the tool runs a cheap `firebase` command and lets the CLI refresh its own
credential — so no OAuth client secret is embedded in this repo.

If the token has gone stale, `firebase login` and re-run.

---

## 4. The gated read path

One function, `story`, deployed to `us-central1`:

```
https://us-central1-factbox-7cb97.cloudfunctions.net/story
```

### Auth model

The client is never believed. It sends a Firebase ID token; the function verifies the
signature against Google's keys via `admin.auth().verifyIdToken()` and then reads
`customers/{uid}.premium` out of Firestore **itself**. A custom claim in the token, a flag
in the body, a cookie, a query parameter — none of these decide anything.

That flag is worth trusting for one reason: the Stripe webhook in `functions/index.js` is
its only writer, and `firestore.rules` denies writes to `customers/{uid}` from every
browser. Verified in `check-backend.js`: a signed-in reader attempting to PATCH their own
`premium` to `true` gets `403 PERMISSION_DENIED`.

Entitlement is **never cached**. A cancelled subscriber loses access on their very next
open, not ten minutes later. That costs one Firestore read per paid story open, every time,
and being right about money is worth one read.

### Requests

**A story**

```http
GET /story?id=01
Authorization: Bearer <firebase ID token>      ← optional; required for paid stories
```

`id` is a string — `"01"`..`"50"` plus `"07B"` (SPEC.md §5: never parse it as a number).
Case is normalised, anything not matching `^[0-9]{2}[A-Z]?$` is a 400.

Success (`200`):

```json
{
  "ok": true,
  "id": "01",
  "access": "free",
  "story": {
    "id": "01", "title": "…", "hook": "…", "secs": 235, "words": 350,
    "topic": "cleopatra", "kind": "unsolved_mystery", "free": true,
    "img": "s01", "cap": "…", "cr": { … },
    "cards": [ { "n": 1, "beat": "hook", "head": "…", "body": "…",
                 "src": "…", "img": "c01-01", "cap": "…", "cr": { … } }, … ],
    "supp": [ { "img": "s01__2", "cap": "…", "cr": { … } } ],
    "audio": {
      "cards": ["palace","palace","palace","bath","basket", …],
      "beds": {
        "palace": { "file": "palace.mp3", "gain": 0.85,
                    "url": "https://firebasestorage.googleapis.com/v0/b/…?alt=media&token=…" }
      }
    }
  }
}
```

`story` is byte-for-byte the object from `stacks.json`, plus `audio`. Nothing the existing
reader code understands has changed shape.

`access` is `"free"` or `"subscriber"`.

Failures — always `{"ok": false, "error": "…"}`, never a partial story:

| HTTP | `error` | meaning |
|---|---|---|
| 400 | `bad_request` | missing or malformed `id` |
| 401 | `auth_required` | paid story, no token — **send the reader to `join.html`** |
| 401 | `bad_token` | token expired, forged, or from another project — **refresh it and retry once**, then treat as signed out |
| 403 | `subscription_required` | signed in, not paying — **show the plan screen** |
| 404 | `not_found` | no such story |
| 405 | `method_not_allowed` | |
| 503 | `not_seeded` | the corpus is missing; run the seeder |

`401`/`403` bodies also carry `{"id": "05", "free": false}` so the client can render the
locked cover without a second request.

**The catalogue**

```http
GET /story?catalogue=1
```

```json
{ "ok": true, "v": "<32-hex corpus version>", "stacks": [ { …cover fields…, "cards": 9 } ] }
```

No auth. `stacks[]` is `stacks.json` minus `cards` and `supp`, with `cards` replaced by the
card **count**. `v` changes whenever the corpus does, so a client can cache on it.

`catalogue/v1` and `meta/content` are also public in `firestore.rules`, so a page that
already carries the Firestore SDK can read them directly and skip this endpoint. Either
route costs one read.

### Headers

- **CORS**: an allowlist — `https://factbox.app`, `https://www.factbox.app`, any
  `localhost`/`127.0.0.1` port, and `*.github.io`. Not `*`: a subscriber's response is the
  thing they paid for, and `*` would let any page on the internet read it out of their
  logged-in browser. `Authorization` is in `Access-Control-Allow-Headers`; preflight is
  handled.
- **`X-Firestore-Reads`** on every response, including failures, exposed via
  `Access-Control-Expose-Headers`. The cost of an open should be observable on the wire, not
  only in a billing report a month later.
- **`Cache-Control`**: `public, max-age=300, s-maxage=300` for free stories and the
  catalogue — identical for everyone, so let a CDN have them. `private, no-store` for a
  paid story and for every refusal: that body belongs to one subscriber, and an in-app
  webview's shared HTTP cache is not where it should be left.
- **gzip** when the caller accepts it and the body is over 1 KB. Nothing in the Functions
  runtime compresses for you. Story 01 went out at 10,020 bytes and now goes out at 2,921;
  the catalogue at 42,683 and now 9,570. Roughly four times less to download on a phone on
  a bad connection, and four times less egress to pay for.

### Why it is cheap

A story open is one document read, and story text does not change between seeding runs, so
a warm instance holds it for ten minutes. Entitlement is not cached, for the reason above.

Measured live, off the `X-Firestore-Reads` header:

| open | cold instance | warm instance |
|---|---|---|
| free story (`01`, `02`) | 1 | **0** |
| paid story | 2 | **1** |
| catalogue | 1 | **0** |

The ten-minute cache has one consequence worth knowing: for up to ten minutes after a
re-seed, a warm instance still serves the old text. Redeploy the function to clear it
immediately, or wait.

---

## 4b. Which story is free today

Today's Factbox is free to everybody, signed in or not. Until now that sentence lived only
in `js/access.js`: the browser worked the pick out from its own UTC clock and the catalogue
order, and `functions/story.js` knew nothing about it. That is fine for **drawing** a page
and useless as a boundary — move the device clock and a different day's story unlocks — and
it meant the one function that actually guards story text could not honour the one rule that
gives text away.

The answer now lives on the server. `functions/today.js` decides it; `functions/story.js`
asks that same module rather than keeping a second copy; `js/access.js` consumes it and
never depends on it.

```
https://us-central1-factbox-7cb97.cloudfunctions.net/today
```

### The request has no inputs

That is the security property, so it is stated first. There is no `?date=`, no `?id=`, no
header, no body, no cookie and no token that changes the answer. `GET /today` is a nullary
function of the server's clock, `catalogue/v1`, and `daily/{YYYY-MM-DD}`. A debugging
`?date=` was deliberately not built: on a public endpoint it is an attack surface with a
friendly name.

### Response

```http
GET /today
```

```json
{
  "ok": true,
  "date": "2026-09-03",
  "id": "38",
  "index": 38,
  "n": 51,
  "source": "deterministic",
  "until": 3623,
  "story": {
    "id": "38",
    "title": "What killed Alexander the Great?",
    "hook": "Alexander the Great died at 32, and nobody can agree on what killed him.",
    "img": "s38",
    "cap": "The Azara herm, Roman copy of a portrait of Alexander the Great by Lysippos, Musee du Louvre",
    "secs": 183, "words": 260, "topic": "ancient_world", "free": false
  }
}
```

415 bytes. `source` is `"deterministic"` or `"editorial"`. `until` is seconds to the next UTC
midnight, when the answer stops being true. `story` is the cover — a closed allowlist of nine
fields, every one of which is already in `data/index.json` on the public web — so the front
page needs no second round trip to draw the hero.

Failures: `503 not_seeded` (uncached, `private, no-store`, because a cached 503 would keep a
client on its fallback after the cause was fixed), `405 method_not_allowed`, `429 too_many`.

### How the pick is made

1. **The deterministic pick, always computed first.** UTC day number × a stride coprime with
   the catalogue size, modulo it. n = 51 gives stride 31, so all 51 stories are visited
   exactly once in 51 days with nothing to seed. Byte-for-byte the arithmetic in
   `js/access.js`, which is what makes the client's guess and the server's ruling agree on
   an ordinary day. **If you change one, change both.**
2. **Then the editorial override**, if `daily/{YYYY-MM-DD}` exists and names a story that is
   actually in the corpus. A missing document, a malformed one, a typo'd id, or a Firestore
   failure all leave the deterministic pick standing and log a warning. A curation feature
   must never be able to take down the thing it decorates.

### Editorial override — how the owner uses it

No deploy, no code, no CLI. In the [Firestore console](https://console.firebase.google.com/project/factbox-7cb97/firestore/data/~2Fdaily):

1. Collection **`daily`**.
2. Document ID: the **UTC date**, `YYYY-MM-DD`. Not the local date — the site's day rolls
   over at UTC midnight, and `until` in the response says how long that is.
3. One field, **`id`**, type **string**, the story id: `"44"`, `"07B"`, `"05"`. A string,
   never a number (SPEC.md §5 — `07B` is not a number and `01` is not `1`).
4. Optional: a `note` field for your future self. Nothing reads it.

It takes effect within **two minutes** (`MEMO_TTL_MS`), on both `/today` and the `story`
function. Delete the document and the deterministic pick returns, within the same two
minutes. Measured end to end below.

Filing tomorrow's row today is safe — the function only ever looks up the document whose id
is today's date, so a row for a future date does nothing until that date.

`firestore.rules`: **`match /daily/{date}` is `read: if true`, `write: if false`.** Readable
by anyone because the answer is announced on the front page anyway; writable by no browser,
because a client that could write here could nominate any of the 51 stories and then demand
it from the `story` function — which honours this collection — and be handed the text for
nothing. Verified: an unauthenticated `PATCH` to `daily/2026-09-03` returns
`403 PERMISSION_DENIED`.

### What `functions/story.js` now enforces

The order in the handler is: permanently free (`01`, `02`) → **today's pick** → entitlement.

| request | before | now |
|---|---|---|
| `GET /story?id=38` (today), no `Authorization` | `401 auth_required` | **`200`, `"access":"today"`, 8,631 bytes, full card text** |
| `GET /story?id=44` (not today), no `Authorization` | `401 auth_required` | `401 auth_required` |
| `GET /story?id=01`, no `Authorization` | `200 "access":"free"` | `200 "access":"free"` |
| paid story, subscriber token | `200 "access":"subscriber"` | unchanged |

Cache-Control on a `"today"` response is `public, max-age=min(300, seconds-to-UTC-midnight)`
— cacheable, but never past the moment it stops being true, so no shared cache can be
serving yesterday's free story into today.

If the `today` lookup throws, `story.js` logs and falls through to the entitlement check —
the answer that was correct before this existed. That failure can cost a signed-out reader
today's story; it can never cost a subscriber theirs.

### What an attacker can and cannot do

**Can:**

- Learn which story is free today. It is on the front page. It is not a secret and is not
  defended as one.
- Read today's story in full, without an account. That is the product decision this whole
  section implements.
- Read `daily/{date}` for any date directly out of Firestore, and so learn a curated pick
  before it lands. Deemed acceptable: it is a public-domain painting and a headline.
- Make **their own browser** draw an unlocked hero, by editing `localStorage.fbx_today_v1`
  in dev tools. That was already true of every flag on this site and it buys them nothing:
  `story.js` reads nothing the client sends when it decides which story is today's.

**Cannot:**

- Induce either function to declare a different story free. Every one of these was tried
  against production and refused: `?id=44&today=44`, `?id=44&free=1&access=today`,
  `?id=44&date=2026-09-14`, `X-Today: 44`, `X-Free: 1`, a spoofed `Date:` header, a JSON
  body on a GET, a `Cookie: fb_today=44`, and `POST`/`PUT` (both `405`). The request carries
  no input the answer is derived from, so there is nothing to smuggle.
- Move the answer by moving a clock. The server reads its own clock. A reader with a wrong
  device clock changes what their own page draws — and, because the client prefers a server
  answer whenever it has one, usually not even that.
- Forge entitlement. `bad_token` on a self-signed JWT; the `premium` read is unchanged.
- Write `daily/{date}`. `403 PERMISSION_DENIED` from every browser, signed in or not.
- Run up an unbounded bill. `maxInstances: 5` is the ceiling; per-IP 300/minute stops one
  laptop in a loop; the memo means Firestore sees at most two reads per instance per two
  minutes however hard the endpoint is hit.

The per-IP limit is deliberately loose — carrier-grade NAT puts thousands of real readers
behind one address and this endpoint is asked once per reader per **day**. A 429 is harmless
anyway: the client treats it exactly like a timeout and falls back.

### Cache strategy, and what it costs

Three layers, in order of how much work each actually does.

| layer | what it holds | lifetime |
|---|---|---|
| **`localStorage`, `fbx_today_v1`** | `{"d":"2026-09-03","id":"38"}`, keyed on the UTC date | the day |
| **HTTP `Cache-Control`** | `public, max-age=120, s-maxage=120, stale-while-revalidate=86400` | 2 min fresh, 24 h stale-usable |
| **in-instance memo** | the whole answer, and the catalogue for an hour | 2 min |

The `localStorage` layer is the one that matters, and it is why this is not a per-page-load
function invocation: the day's answer is read back **synchronously when `js/access.js`
parses** — a memory read, not a request — so on every page load after the first of a new UTC
day the endpoint is not called at all. Measured, second load of the day with the network
blocked entirely: **0 calls to `/today`**, hero correct from the first frame.

`s-maxage` and `stale-while-revalidate` are written correctly but do little today: there is
**no Google-managed CDN in front of a bare `cloudfunctions.net` URL**. They are honoured by
browsers and in-app webview caches, and putting Firebase Hosting or the Cloudflare worker in
`cloudflare/` in front changes nothing but the hit rate. `stale-while-revalidate=86400` is
the availability line: any shared cache that already holds an answer serves it instantly for
a further day and refreshes underneath, so a slow or dead function is invisible behind one.

Two minutes rather than "until midnight" is the deliberate compromise, and it is priced
rather than guessed: the deterministic half of the answer changes once a day and could be
held for hours, but the editorial half is a person typing into a console and reloading to
see whether it worked. Two reads per instance per two minutes, across the worst case of
every instance both functions may run (5 + 20), is 36,000 Firestore reads a day against a
free allowance of 50,000 a day — so the whole editorial loop still costs nothing.

**Cost at 1,000 readers a day** — 30,000 reader-days a month:

| line | usage | free allowance | cost |
|---|---|---|---|
| `/today` invocations | 1,000/day = 30,000/mo | 2,000,000/mo | $0 |
| `/today` egress | 415 B × 1,000/day ≈ 12.5 MB/mo | 1 GiB/mo | $0 |
| Firestore reads (memo-bounded) | ≤ 2 per instance per 2 min; ≤ 36,000/day at max instances | 50,000/**day** | $0 |
| compute (~120 ms × 30,000, 256 MiB) | ~900 GiB-s/mo | 360,000 GiB-s/mo | $0 |

**$0.00/month.** The nearest line is 1.5% of its allowance. It stays $0 to roughly 65,000
readers a day, where invocations reach 2M/month; past that they cost $0.40 per million, so
100,000 readers a day is about **$0.40/month**.

Measured live, off `X-Firestore-Reads`:

| call | cold instance | warm instance |
|---|---|---|
| `GET /today` | 2 (catalogue + override doc) | **0** |
| `GET /story?id=<today>` | 3 (story + catalogue + override) | **0** |
| `GET /story?id=<paid>` anonymous | 1 | 1 |

Latency: 1.35 s cold, **0.11 s** warm (five consecutive calls: 0.107, 0.125, 0.113, 0.123 s).

### The fallback, and proof it holds

**A backend that can break the front page is worse than the client calculation it
replaces.** So `js/access.js` keeps the deterministic arithmetic, computes it first, and
uses a server answer only when it actually has one in hand.

- `todayOf()`, `todayId()` and `isToday()` stay **synchronous** and always return something.
  They prefer a server answer already in memory (primed from `localStorage` at parse) and
  fall back to the arithmetic. Neither ever waits on a request.
- `canRead(id)` is the only thing that waits, and only on the path that would otherwise
  answer **no** — `can()` and the permanently-free check both short-circuit before it. The
  wait is capped at `ASK_MS` (2,500 ms), is started in parallel with `FBX.ready()` rather
  than after it, and resolves instantly once the day is cached.
- A server answer naming a story that is not in the catalogue, a malformed body, a
  wrong-shaped payload — each is discarded and the arithmetic stands.
- Nothing runs before or during first paint. The network call happens once per browser per
  UTC day, on a 600 ms timer, and only on a cache miss.

Proven in a real DOM (jsdom over the real local server, `index.html`, signed out), with the
endpoint made unreachable four different ways:

| `/today` is… | script errors | covers drawn | `todayId()` | free to a signed-out reader | earliest `canRead("44")` |
|---|---|---|---|---|---|
| rejected (offline) | none | 63 | `38` | `01, 02, 38` | 1,829 ms → `false` |
| `503` | none | 63 | `38` | `01, 02, 38` | — |
| hung, never answers | none | 63 | `38` | `01, 02, 38` | **2,501 ms** → `false` |
| live | none | 63 | `38` | `01, 02, 38` | 1,830 ms → `false` |
| answering `44` | none | 63 | `44` | `01, 02, 44` | — |
| answering `44`, **cached, network blocked** | none | 63 | `44` | `01, 02, 44` | 0 calls made |

Every row renders — 3,680 characters of body text, hero present — picks a story, and frees
**exactly one** beyond the two permanently-free ones. 2,501 ms is `ASK_MS` exactly; 1,829 ms
is `FBX.ready()`, unchanged from before any of this existed, which is what an offline
browser costs.

**Client and server agree.** On 2026-09-03 the client computes day number 20699, index 38,
id `38`; `/today` returns `"index":38,"id":"38"`; `/story?id=38` serves it anonymously.

### The one line `js/today.js` still wants

`js/access.js` exports `FBX.onToday(fn)` — its own listener list, deliberately not the access
listeners, because today's pick changing is not an access change and pushing a non-event
through every padlock pass and through `FBX.correct()` on every page would be a reload bug
waiting to happen.

Nothing subscribes to it yet. `js/today.js` is owned elsewhere; the line it wants, next to
its existing `FBX.paint` registration in `decorate()`, is:

```js
try { if (window.FBX && FBX.onToday) FBX.onToday(function () { draw(); }); } catch (e) {}
```

Without it, the **first** page load of a new UTC day draws the hero from the deterministic
pick even when an editorial override says otherwise; the padlocks and `read.html` follow the
server correctly either way, and every load after the first is correct from the first frame
because the answer is already in `localStorage`. With it, the front page redraws in place the
moment the server answers.

---

## 4c. The support inbox

`/support` has two boxes. Both post `{kind, message, email, page}` to
`functions/support.js`. Two things happen to a message, in this order and never the
other way round: **it is stored, and then it is emailed.**

### Where a message is stored

One document in `support/`, and the function builds every field itself — there is no
path by which a key in the request body becomes a key in Firestore.

```
support/2026-09-04T19-12-44Z-5b7k
  at       timestamp   the server's clock, never the caller's
  from     string      the reply address if they typed one, "" if not
  kind     string      "Something is wrong" | "Story idea"
  message  string      what they typed, capped at 4,000 characters
  page     string      the path they were on, e.g. "/read/07"
  uid      string      their account, from a verified ID token, "" if signed out
```

**Six fields, and the list does not grow.** `privacy.html` §08 publishes the number and
`tools/check-support.js` asserts it. Whether the email went is a log line, not a seventh
field. The id sorts by time on purpose: the console lists documents by id, so a random
auto-id would be an inbox in no order at all.

### And then it is emailed

To **hello@factbox.app**, plain text, via the Resend API — one `fetch`, no new
dependency, bounded at 5 seconds. **It is switched off right now** and the form works
anyway. SUPPORT-EMAIL.md is the whole story: why Resend and not the extension or SMTP,
what the owner has to create, and the five decisions that keep an email whose body is
written by anonymous strangers from becoming a header-injection or open-relay problem.

The rule that matters here: **the reader's answer is settled by the Firestore write.**
If the key is absent, wrong, expired or the provider is down, the reader still sees
"Sent", because it is — in the archive the founders actually read. A mail failure is an
ERROR log line and nothing else.

### The rate limiting, and why it was rewritten

The previous version kept `const seen = new Map()` at module scope and counted per IP in
it. That is per **instance**. Cloud Functions runs up to `maxInstances` containers, each
with its own empty Map, and every cold start hands an attacker a fresh one. The real
limit was about `PER_IP_PER_HOUR × instances`, and anyone spreading requests over a few
seconds effectively had none. The file said so itself and called it "weaker than a
Firestore-backed counter"; it was weaker than that in a way that made the number
meaningless rather than merely approximate.

Five limits now, and the first is the only one that is not authoritative:

| limit | value | where it is held | what it stops |
|---|---|---|---|
| in-memory gap + hourly | 20s / 8 | per instance, `seen` | the honest double tap, for **zero** database reads |
| minimum gap | 20s | `support_ip/{hash}` | the same thing, for real, across instances |
| per IP per hour | 8 | `support_ip/{hash}` | one browser flooding |
| per IP per day | 20 | `support_ip/{hash}` | one browser flooding slowly |
| **stored per day, everyone** | **300** | `support_meta/quota` | a distributed flood costing money |
| **mailed per day, everyone** | **80** | `support_meta/quota` | a distributed flood spending a mail quota |
| mailed per IP per day | 5 | `support_ip/{hash}` | one browser spending everyone's mail budget |

The Map is still the first thing consulted, because it is free and needs no read.
It is no longer what decides.

**Two budgets, not one, and the mail one is smaller.** Storing a message is ours and
costs a fraction of a cent; mailing one spends a finite daily allowance at a third
party. When the mail budget is gone the archive keeps accepting and the founders read
the console for the rest of the day. Only `PER_DAY` — the *storage* ceiling — can refuse
a reader, and when it does, `/support` tells them to email hello@factbox.app, which is
why that fallback is not decoration.

**The counters and the message are written in one transaction.** Two reads, three
writes. That is the whole reason this holds across instances: there is no window in
which two containers both read "seven this hour" and both write the eighth. A refusal
throws before any write, so a client hammering the endpoint costs two reads and nothing
else — and if it is hammering one warm instance, not even that.

### What that costs in privacy, said plainly

A cross-instance per-IP counter has to key on something derived from the IP. This one
stores `HMAC-SHA-256(daily salt, day|IP)`, truncated to 96 bits, as a document id under
`support_ip/`. The document holds counts and two timestamps. No address, no message, no
account:

```
support_ip/12813e75b695f169dc85dac1
  day 2026-09-04   dayCount 4   hour 2026-09-04T19   hourCount 4
  mailCount 0      last 1788548604142
  expiresAt 2026-09-05T21:03:24Z      ← a Firestore TTL policy deletes it
```

The salt is a random 32 bytes in `support_meta/salt`, regenerated every UTC day, in a
deny-all document. It rotates inside a transaction and the losing instance adopts the
winner's salt rather than keeping its own — two instances holding two salts for the same
day would split every counter in half and quietly reinstate the exact bug this replaces.

Be honest about the limit of it: **IPv4 is four billion addresses**, so anyone holding
the salt could brute-force the mapping back. The salt is readable only with project
credentials and is gone within the day. This is still strictly more than the previous
version stored, which was nothing, and **`privacy.html` §08 currently says "Your IP
address is not stored, and neither is a hash of it." That sentence is now wrong.** It is
flagged rather than edited because that file belongs to another hand.

IPv6 is truncated to its /64 before hashing. A single subscriber is routinely handed a
whole /64, so counting /128s would be counting nothing.

### App Check — investigated, and the answer is no

Not enabled, and not recommended, for four reasons found rather than assumed:

1. **There is no App Check anywhere in this repo.** No `firebase/app-check` import, no
   provider, no site key — enabling enforcement would reject every real reader until
   `js/` and `support.html` were changed, and those belong to other hands.
2. **The web providers are reCAPTCHA v3 and reCAPTCHA Enterprise**, both of which load
   Google script and lean on iframes and third-party storage. This site's audience is
   specifically people in the Instagram and TikTok in-app webviews, which partition or
   block exactly that. reCAPTCHA v3 does not challenge, it scores — and a webview scores
   badly. The failure mode is not a puzzle, it is a silent rejection of genuine readers
   whose only recourse is the `mailto:`.
3. **It would make two shipped pages untrue.** `privacy.html:229` says there is no
   reCAPTCHA on the site, and LEGAL.md §8.2 lists that as a claim it went and fixed.
4. **It is the wrong tool for the actual threat.** App Check attests that a request came
   from our page; it does nothing about a real browser on our real page sending a
   hundred messages. The Firestore counters do, and they cost one read.

Revisit if the form is ever actually abused by a script rather than a person — and
revisit it as "reCAPTCHA Enterprise with a score threshold", after measuring what real
in-app-webview readers score.

### Cost, on a normal day and a bad one

Per accepted message: **2 reads, 3 writes**, plus one salt transaction per instance per
day. Per message refused by Firestore: **2 reads, 0 writes**. Per message refused by the
in-memory gate: **nothing at all**.

| a day of | stored | emailed | Firestore | cost |
|---|---|---|---|---|
| 10 messages — reality | 10 | 10 | 20 reads, 30 writes | **$0.00** |
| 1,000 attempts | 300 (capped) | 80 (capped) | ~2,000 reads, 900 writes | **$0.00** |
| 10,000 attempts | 300 (capped) | 80 (capped) | ~19,400 reads, 900 writes | **$0.00** |
| 100,000 attempts from 100k distinct IPs | 300 (capped) | 80 (capped) | ~200k reads, 900 writes | **~$0.12** |

The free tier is 50,000 reads and 20,000 writes a day, so everything down to the last
row is genuinely free rather than nearly free. **The bill cannot run away, because the
writes are capped at 300 and the reads are capped by `maxInstances: 5 × concurrency: 40`
— at 200 requests in flight the endpoint sheds load long before it spends money.** The
mail quota cannot run away either: 80 a day against a Resend free tier of 100 a day and
3,000 a month.

Where the caps sit, all in `functions/support.js`: `PER_DAY` (300),
`MAIL_PER_DAY` (80), `MAIL_PER_IP_PER_DAY` (5), `PER_IP_PER_DAY` (20),
`PER_IP_PER_HOUR` (8), `MIN_GAP_MS` (20s), `MAX_MESSAGE` (4,000),
`MAX_BODY_BYTES` (16 KB).

`MIN_GAP_MS` is repeated in `support.html` as `GAP_MS` so a double tap is answered
locally instead of over the wire. Changing it here wants changing there.

### What the reader sees on each refusal

No status code ever reaches the reader, their words never leave the textarea, and every
refusal hands back a `mailto:` already carrying what they typed.

| the function says | the reader reads |
|---|---|
| `429 too_fast` / `too_many` / `quota` | "We cannot take that one just now. Send it to hello@factbox.app and it reaches exactly the same person." |
| `400 too_long` | "That is longer than this box can send. Trim it, or send the whole thing to hello@factbox.app." |
| `400 empty` | "Tell us what happened first — even one line helps." (idea box: "Tell us what to cover first.") |
| `500`, or anything unrecognised | "That did not send. Your words are still in the box above — this will put them in an email to hello@factbox.app instead." |
| never reached at all | "That did not send — the connection did not reach us. Nothing is lost: your words are still in the box above…" |


---

## 5. Audio, and the trade

31 ambience beds, 4.0 MB, now in `factbox-7cb97.firebasestorage.app` under `audio/`.

`<audio>` and Web Audio cannot send an `Authorization` header. They are a browser fetching a
URL, not a caller holding a credential. So "gated audio" can never mean "the SDK checks the
rules before it plays" — it can only mean **the URL itself is the credential, and only an
entitled reader is ever told it**. Three ways to build that:

**Public read.** Simplest, free, and no gate at all. Rejected: only 9 of the 31 beds are
reachable from the two free stories, so 22 of them really are behind the paywall and worth
holding.

**V4 signed URLs, minted per request.** The strongest option: they *expire*, so a leaked URL
dies in an hour. **Not available.** Minting them requires the functions runtime service
account (`790045781901-compute@developer.gserviceaccount.com`) to hold
`roles/iam.serviceAccountTokenCreator` on itself, and that grant could not be made from this
session. To enable it:

```
gcloud iam service-accounts add-iam-policy-binding \
  790045781901-compute@developer.gserviceaccount.com \
  --member="serviceAccount:790045781901-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" --project=factbox-7cb97
```

With that in place the swap is small: sign in `story.js` at response time instead of reading
the stored URL, and cache each signed URL in the instance for its lifetime so a warm
instance signs each bed once an hour rather than once a request.

**Firebase download tokens — what is deployed.** Each object carries a random token in its
metadata; the URL is `…/o/audio%2Fpalace.mp3?alt=media&token=<uuid>`. `storage.rules` denies
every client read, write and listing, so a browser cannot enumerate the bucket, cannot guess
its way in, and cannot mint a URL of its own. The tokens live in the story documents, which
no browser can read, and reach a reader only in a response the function decided they were
entitled to.

**The honest limit, stated plainly: a download token does not expire.** It bypasses
`storage.rules` by design — that is exactly what makes `getDownloadURL()` work. A subscriber
who copies 31 URLs out of dev tools has something they can pass around indefinitely. The
remedy is rotation, not expiry:

```
node tools/seed-firebase.js --rotate-tokens
```

which mints new tokens and rewrites every story document to match, killing every URL ever
handed out. That is a blunt instrument on a schedule, where a signed URL would be a sharp
one automatically. It is the best available without the IAM grant above, and it is a real
improvement on a public bucket: today the only way to a bed is through the gate.

Verified live: the tokenised URL returns 200 and 114,730 bytes of mp3; the same URL with
`&token=` stripped returns 403; listing the bucket returns 403.

---

## 6. Cost, honestly

Measured, not modelled. Per story open:

| | |
|---|---|
| Firestore reads | 1 free / 2 paid cold; 0 free / 1 paid warm |
| Function egress, story JSON | ~2.9 KB gzipped (10.0 KB raw) |
| Function egress, catalogue | 9.6 KB gzipped (42.7 KB raw), once per session, CDN-cacheable |
| **Storage egress, audio** | **mean 453 KB** — 3.47 beds per story; median 495 KB, max 700 KB, min 247 KB |
| Image egress from Firebase | **zero** — the plates stay on GitHub Pages |

Audio is 99% of the bytes. Everything else is rounding error.

### 1,000 readers a month

Assuming 5 story opens each — 5,000 opens, 1,000 catalogue loads — and pessimistically
that every open is a cold instance serving a paid story:

| line | usage | free allowance | cost |
|---|---|---|---|
| Firestore document reads | 10,000 / mo | 50,000 / **day** | $0 |
| Firestore stored data | ~0.6 MB | 1 GiB | $0 |
| Function invocations | 6,000 / mo | 2,000,000 / mo | $0 |
| Function compute | ~180 GiB-s | 360,000 GiB-s / mo | $0 |
| Function egress | ~25 MB / mo | 1 GiB / mo (N. America) | $0 |
| Storage stored | 4.0 MB | 5 GB | $0 |
| **Storage download** | **2.27 GB / mo (~76 MB/day)** | **1 GB / day** | **$0** |
| Storage download ops | ~17,400 / mo (~580/day) | 50,000 / day | $0 |

**$0.00.** Nothing at 1,000 readers comes within an order of magnitude of the Blaze free
allowance — the closest line, audio download, uses about 7% of it.

There is a small fixed floor unrelated to traffic: Artifact Registry storing the function
container images (~$0.05/mo) and Secret Manager holding `STRIPE_WEBHOOK_SECRET` (~$0.06/mo).
Under **$0.15/month** whether anybody reads anything or not.

### Where it stops being free

Audio egress, and nothing else, is the first thing that costs money.

| readers / mo | audio egress | bill |
|---|---|---|
| 1,000 | 2.3 GB | $0 |
| 10,000 | 22.6 GB | $0 (just under) |
| ~13,800 | ~31 GB | the line — 1 GB/day |
| 50,000 | 113 GB | ~**$10/mo** at $0.12/GB |
| 200,000 | 453 GB | ~**$51/mo** |

Firestore reads only become a bill at roughly 1.5M/month — about 150,000 readers, ten times
later than audio. If this ever needs to get cheaper, the lever is the beds: 31 files at
~130 KB each, and halving the bitrate halves the largest line in the table.

---

## 7. What this does not do yet

**The paywall is not closed until the old files come down.** `data/stacks.json` and
`audio/*.mp3` are still served from GitHub Pages, deliberately — the site has to keep
working until the client is switched. Until they are deleted from that repo, the backend
gate is a second door on a house whose first door is open. It is real, it is tested, and it
protects nothing while `factbox.app/data/stacks.json` returns 200. Deleting them is the last
step of the client switch, not an optional follow-up. SPEC.md §9 should be rewritten the day
it happens.

**Download tokens do not expire.** §5. Rotate, or make the IAM grant.

**A re-seed is up to ten minutes stale** on a warm function instance. §4.

**`past_due` still reads.** The `premium` flag is whatever the webhook wrote, and the
webhook counts `active`, `trialing` and `past_due` as active — a failed card should prompt a
fix, not an instant lockout. That is inherited behaviour, unchanged here, and correct.

**The Stripe webhook secret is still a placeholder.** Until the real one is installed no
`premium` flag is ever written by Stripe, so no real reader can pass the gate. Nothing in
this document changes that or depends on it; the gate was tested by writing the flag
directly, the way the webhook will.

**Support email is built and switched off.** `functions/support.js` will email every
message to hello@factbox.app the moment `RESEND_API_KEY` holds a real key; it holds the
placeholder `disabled-see-SUPPORT-EMAIL.md` today, and a placeholder means the function
archives, answers 200, and logs `"mail":"off"`. Four steps to switch it on — Resend
account, `send.factbox.app` verified, three DNS records at Cloudflare, key into Secret
Manager and redeploy — all of them in **SUPPORT-EMAIL.md §3**. Nothing about the form is
broken while it is off.

**`privacy.html` §08 has one sentence that is now wrong.** "Your IP address is not
stored, and neither is a hash of it." The Firestore rate limiter stores a daily-salted
HMAC of it — §4c says exactly what and why. Two more places in the same file will want a
look before the mail key goes in: the processor list in §09 does not name a mail
provider, and §08 describes a support message as going to Firestore and stopping there.
Flagged rather than edited: that file belongs to another hand.

**Node 20 is deprecated** and decommissions **2026-10-30**. All four functions will need
Node 22 before then; the deploy already warns on every run. `firebase-functions` is a major
version behind. Noted, not fixed here — `functions/package.json` still says `"node": "20"`
and this change did not touch the runtime.

**An editorial override is up to two minutes late**, in both directions, for the same reason
a re-seed is ten. §4b. Redeploy `today` to clear the memo immediately, or wait.

**Nothing subscribes to `FBX.onToday` yet**, so on the first page load of a new UTC day the
front-page hero can show the deterministic pick while the padlocks and the reader show the
override. One line in `js/today.js`, quoted in §4b.

---

## 8. Verification

```
node --check functions/index.js functions/story.js functions/today.js functions/support.js              tools/seed-firebase.js tools/check-backend.js tools/check-support.js
node tools/seed-firebase.js --dry-run
node tools/check-backend.js
node tools/check-support.js
```

`check-support.js` is the support inbox end to end and **writes to production**, deleting
what it wrote. 27 assertions, all passing after the rewrite in §4c: the shape checks, a
signed-out stranger's message arriving with exactly six fields and nothing smuggled into
them, the throttle refusing a second message inside the gap, a signed-in reader's uid
coming from a verified token and a broken token costing the message nothing, and
`firestore.rules` refusing a browser a direct read or write of the collection and of the
quota.

Three things it does not cover, checked by hand at the time of the rewrite and worth
repeating if the limits are ever touched:

- **The throttle across a cold start** — the case the old in-memory Map failed. Fill the
  per-IP hour bucket, redeploy `support` so Cloud Run replaces every container, and send
  again: it must still be `429 too_many`, because the count is in Firestore and not in a
  Map that a new container starts empty.
- **The mail payload against a hostile message.** `functions/support.js` exports
  `_replyTo` and `_mailPayload` for exactly this and for nothing else — `index.js` takes
  `.support` and only `.support`, so nothing extra is deployed or reachable. Assert that
  `to` is the constant, that there is no `html` field, that a CRLF address produces no
  `reply_to`, and that a message containing the fence cannot forge it.
- **The global ceiling.** Set `support_meta/quota.count` to `PER_DAY`, send, expect
  `429 quota`, and restore the count immediately — it is a live collection.

For the free-story rule specifically:

```
curl -s https://us-central1-factbox-7cb97.cloudfunctions.net/today            # the answer
curl -s "https://us-central1-factbox-7cb97.cloudfunctions.net/story?id=$(     # today, anonymous
  curl -s https://us-central1-factbox-7cb97.cloudfunctions.net/today   | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)" | head -c 120
```

The second should print `{"ok":true,"id":"…","access":"today"` and the same request with any
other paid id should print `{"ok":false,"error":"auth_required"`.

`check-backend.js` creates a throwaway Firebase user, flips `premium` on it the way the
webhook would, and deletes both afterwards. It asserts the webhook still rejects an unsigned
POST, that free stories serve anonymously, that paid ones do not, that access appears and
disappears with the flag, that `firestore.rules` refuses a signed-in reader direct access to
story text while allowing the catalogue, that a reader cannot grant themselves premium, that
audio works only with its token, and that all 51 stories and 450 cards are present. 39
assertions, all passing (re-run after §4b shipped: 39 passed, 0 failed).

**One trap in it, dated.** `check-backend.js` uses `05` as its example of a paid story, in
six assertions. `05` sits at index 4 in the catalogue, so once every 51 days it IS today's
Factbox — and on that day `story.js` will correctly serve it to an anonymous caller and the
check will correctly report a failure for a system that is working. The fix is one line: ask
`/today` first and pick any id that is not the one it names. It has not been applied here
because `tools/` belongs to another hand. `05` is next due on **2026-09-20** (UTC day
20716), and every 51 days after.
