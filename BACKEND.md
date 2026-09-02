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

---

## 2. Firestore layout

```
stories/{id}      51 docs   the full story, cards and all — no browser may read this
catalogue/v1       1 doc    51 covers, titles, hooks, lengths, credits — public
meta/content       1 doc    corpus version and counts — public
customers/{uid}             unchanged; written by the Stripe webhook, read by the gate
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

**Node 20 is deprecated** and decommissions 2026-10-30. Both functions will need Node 22
before then. `firebase-functions` is a major version behind.

---

## 8. Verification

```
node --check functions/index.js functions/story.js tools/seed-firebase.js tools/check-backend.js
node tools/seed-firebase.js --dry-run
node tools/check-backend.js
```

`check-backend.js` creates a throwaway Firebase user, flips `premium` on it the way the
webhook would, and deletes both afterwards. It asserts the webhook still rejects an unsigned
POST, that free stories serve anonymously, that paid ones do not, that access appears and
disappears with the flag, that `firestore.rules` refuses a signed-in reader direct access to
story text while allowing the catalogue, that a reader cannot grant themselves premium, that
audio works only with its token, and that all 51 stories and 450 cards are present. 39
assertions, all passing.
