# Factbox — Firebase: the answers, and the second analytics sink

Two changes live in `js/profile-sync.js` and `js/analytics.js`:

1. **The onboarding answers now survive the browser.** A signed-in reader's
   answers are mirrored into their own Firestore document.
2. **Every analytics event now goes to two places.** PostHog, as before, and
   Google Analytics 4 through Firebase, as well.

The second one is a duplication. It is deliberate, the owner asked for it
knowing that, and §6 says plainly which one to keep and when.

Files: `js/profile-sync.js` (new), `js/analytics.js` (edited), `js/account.js`
(edited — header, the sync loader, and one shipped bug). Nothing else changed.

---

## 1 · The answers, in Firestore

### Where

```
customers/{uid}/profile/onboarding
```

**A subdocument, never `customers/{uid}` itself.** That document holds the
`premium` boolean, and it is written by the Stripe extension from a webhook
running with admin credentials. A browser writing there — even merging fields
the webhook does not use — races it, and the thing it can clobber is a
subscription state nobody on this site can rebuild. So the answers get a
document of their own, which nothing else writes and which nothing reads to
decide anything. `premium` is still the one flag. AUTH.md §1 is unchanged.

### What

Every field is something a human tapped. **A question that was skipped
produces no field at all** — not a null, not a zero, not a default. Nothing is
inferred, derived, scored or bucketed.

| Field | From `FBA` | Values |
|---|---|---|
| `draw` | `draw()` | `people` `turning` `thread` `tiktok` |
| `relates` | `relates()` | list of `notime` `unfinished` `stories` |
| `goalMinutes` | `goal()` | `5` `10` `20` `45` |
| `streakDays` | `streak()` | `7` `14` `30` `50` |
| `planAnswers` | `planAnswers()` | up to three `1`/`0` |
| `interests` | `interests()` | legacy topic keys, still stored if present |
| `frequency` | `frequency()` | legacy, same |
| `plan` | `plan()` | `monthly` `quarterly` `annual` |
| `name` | `name()` | first name, if given |
| `email` | `email()` | what they typed in the funnel, if given |
| `localAccountId` | `get().accountId` | the `fba…` id, **only if one already exists** |
| `onboardingComplete` | `onboarded()` | `true`, only when true |
| `schema` | — | `1` |
| `updatedAt` | — | `serverTimestamp()` |

Two of those are not answers and are here on purpose:

- **`localAccountId`** is the string that went to Stripe as
  `client_reference_id` on any checkout started before the reader had an
  account. Without it there is no way to join such a payment to this uid. It
  is read with `FBA.get()`, never `FBA.accountId()`, because that accessor
  *mints* an id as a side effect and a mirror must not change what it mirrors.
  On a browser that never had one, the field is absent.
- **`updatedAt`** is a server timestamp or nothing. A client clock is a value
  the reader did not give us and a number the rules cannot check.

### When

- On sign-in, and on every auth change (700ms after).
- Whenever an answer changes. `FBA`'s setters are wrapped in
  `profile-sync.js` — the mirror should not make the thing it mirrors know it
  exists — and each call schedules a write **1500ms** later, so a burst of taps
  through the funnel is one write, not eight. Never two writes closer than
  **4s**. An unchanged payload is never re-sent.
- On `pagehide` and on the tab going hidden, so a change made in the last
  second and a half of a page is not lost.
- **Never signed out.** No queue, no shadow copy, no "sync later" flag. `FBA`
  already is the local copy.

Two things the debounce alone would get wrong, and what is done instead:

- **A second phone.** A reader signing in on a new browser has an empty `FBA`.
  Writing that would blank the answers they gave on the first one. So a payload
  with no answers in it is never written. *Nothing to say* is not *saying
  nothing*.
- **A cleared answer.** Skip on a step they had already answered has to clear
  the field upstream, and a merge write cannot do that on its own. Any key this
  page has written before and is not writing now is sent as its empty value.
  Only keys we wrote ourselves, so the empty-browser case above still holds.

### Failure

`js/profile-sync.js` never throws, at top level or anywhere. Every storage
read, SDK call and promise has a catch.

**A denied write is a no-op.** The rules deny this path until §2 below is
deployed; until then every write is rejected, and the correct reader-visible
outcome of that is nothing at all — no message, no console noise, no retry.
After a denial the file stops for the rest of the page, so a rejection cannot
become a loop against a rule that is not going to change mid-session. Offline
and transient failures are left for the next change to retry.

A reader whose sync never happens still has every answer on the phone in front
of them, and every screen reads the local copy either way.

### Wiring

The tag belongs in the markup of any page carrying the funnel, right after
`js/account.js`:

```html
<script src="js/account.js"></script>
<script src="js/profile-sync.js"></script>
```

Until that lands, `js/account.js` injects it after first paint. Loading it from
there rather than from `js/analytics.js` is deliberate: there is nothing to
mirror on a page with no `FBA`, and `analytics.js` loads on all fifty-one story
pages where there is none. `profile-sync.js` refuses to install twice, so
having both the tag and the injection is safe — but the tag is the better
answer, because a `<script>` the parser sees is one the browser can prioritise.

---

## 2 · The Firestore rule this needs

**Not applied here** — `firestore.rules` belongs to someone else. This is the
block to hand over. It goes inside the existing `match /customers/{uid}`,
alongside `checkout_sessions`, plus three helpers next to `isSelf()`.

```
    // --- Shape helpers for the one client-written document ---------------
    // Each is "absent, or the right type and small enough". Absent is legal
    // because a question the reader skipped must produce no field at all.
    function shortStr(k, n) {
      return !(k in request.resource.data)
        || (request.resource.data[k] is string && request.resource.data[k].size() <= n);
    }
    function smallList(k, n) {
      return !(k in request.resource.data)
        || (request.resource.data[k] is list && request.resource.data[k].size() <= n);
    }
    function smallInt(k, n) {
      return !(k in request.resource.data)
        || (request.resource.data[k] is int
            && request.resource.data[k] >= 0
            && request.resource.data[k] <= n);
    }
```

```
      // --- The reader's own onboarding answers -------------------------
      // js/profile-sync.js mirrors js/account.js's record here so it
      // survives losing the browser. This is the ONLY document on the site
      // a reader writes to about themselves, and it is deliberately a
      // subdocument: `customers/{uid}` itself belongs to the Stripe webhook,
      // and a client write racing that would clobber a subscription state
      // nothing here can rebuild.
      //
      // Nothing decides access from this. `premium` is still the one flag.
      // The worst a reader can do with a forged write is lie to us about
      // how many minutes a day they meant to read.
      //
      // The key list is closed, so a future field has to be added here on
      // purpose. Sizes are capped because this document is client-written
      // and an uncapped string is a free hosting bill.
      match /profile/{docId} {
        allow read: if isSelf(uid);
        allow delete: if isSelf(uid);
        allow create, update: if isSelf(uid)
          && docId == "onboarding"
          && request.resource.data.keys().hasOnly([
               "schema", "updatedAt", "draw", "relates", "goalMinutes",
               "streakDays", "planAnswers", "interests", "frequency",
               "plan", "name", "email", "localAccountId", "onboardingComplete"
             ])
          && request.resource.data.schema is int
          && (!("updatedAt" in request.resource.data)
              || request.resource.data.updatedAt == request.time)
          && shortStr("draw", 30)
          && shortStr("frequency", 20)
          && shortStr("plan", 20)
          && shortStr("name", 40)
          && shortStr("email", 120)
          && shortStr("localAccountId", 40)
          && smallList("relates", 8)
          && smallList("planAnswers", 3)
          && smallList("interests", 12)
          && smallInt("goalMinutes", 1440)
          && smallInt("streakDays", 3650)
          && (!("onboardingComplete" in request.resource.data)
              || request.resource.data.onboardingComplete is bool);
      }
```

Notes for whoever applies it:

- **`docId == "onboarding"`** keeps the collection to one document. Drop that
  clause only if a second profile document is genuinely wanted.
- The write is a **merge**, so `request.resource.data` is the *merged* result,
  not the delta. That is why the key list and the type checks have to cover
  every field the document may already hold, and they do.
- `allow delete` is there so a reader can erase their own answers. Nothing in
  the client uses it.
- Rules cannot cheaply check the *element* types inside `relates`,
  `planAnswers` or `interests`; the size caps are the guard. The blast radius
  is a reader lying to us about their own reading goals.
- **This block has not been through the rules compiler.** There is no Java
  runtime on this machine, so the Firestore emulator could not be started.
  Braces, parens and brackets balance, and the syntax follows the existing
  file's. Run `firebase emulators:start --only firestore` once before
  deploying.

---

## 3 · Firebase Analytics (GA4)

### How it loads

Through the same dynamic-import pattern `js/auth.js` uses, so nothing else on
the site had to become a module. One difference, and it matters:

`js/auth.js` writes `import(...)` literally, because it is `type="module"` — a
browser that cannot parse it simply skips it, and that is a state that file
already renders. `js/analytics.js` is a **classic script on every page**. A
browser old enough to treat `import(` as a syntax error would fail to parse the
*whole file*, taking PostHog, the dwell measurement and `window.FBQ` down with
it. So the import is built at runtime with `new Function("u", "return
import(u);")` inside a try/catch. Such a browser now fails to build one
function; everything else carries on.

Analytics is a **second, named Firebase app** (`"fbq"`). The default app
belongs to `auth.js`, and its config carries no `measurementId`, so asking it
for an Analytics instance would fail. A named app also means nothing here can
disturb the auth or billing wiring next door.

`isSupported()` is checked before `getAnalytics()`, because it is false in a
webview with no IndexedDB and calling through anyway throws there. Events fired
before the SDK arrives are queued (80 max) and flushed on arrival.

`window.FBQ_SDK` is a documented seam mirroring `auth.js`'s `FBU_SDK`: a
flattened namespace already on the page is used instead of the network.

### The seam

There is still exactly one place every event passes through — `capture()` in
`js/analytics.js`, which `FB.track` and the illustrated story's `track()` are
both wrapped into. **No second set of call sites was added anywhere.** Both
sinks hang off that one function; deleting a vendor is deleting one line in it.

### Opt-out

`FBQ.optedOut()` is checked before either loader runs — the early return at the
top of `js/analytics.js` now covers both, and also sets gtag's own
`window['ga-disable-G-VELZ9B3E3Q']` kill switch in case anything ever brings GA
in by another route. The privacy page promises the script *does not load*, not
that it loads and stays quiet, and that is still true of both.

Pressing the button mid-session stops GA logging immediately, drops the queue
and sets the kill switch; on the next load neither sink arrives at all.

### The event mapping

**Forty-five event names. Zero renamed.** Every name the site already fires is
already legal GA4: lowercase, `[a-z0-9_]`, starts with a letter, longest is 16
characters against a 40-character limit, and none collides with a reserved
name or a reserved prefix (`ga_`, `google_`, `firebase_`).

```
answered            explore_view        join_step           rec_save
billing_portal      join_draw           join_streak         rec_view
card_view           join_login_hit      join_time           resume_used
checkout_start      join_login_known    join_view           save_add
join_login_miss     library_own_view    save_remove         signin_email
join_plan_answer    library_unsave      signin_google       signin_phone
join_plan_ask       library_view        signout             signup_email
join_plan_built     owner_unlock        sources_open        stack_complete
join_plan_start     paywall_view        stack_dropoff       stack_open
join_praise         reached_end         started             subscribe_click
join_relate         rec_click           join_restore_use    join_signup
join_skip
```

`gaName()` maps anyway, so the *next* name added cannot break quietly:

| Input | GA4 | Why |
|---|---|---|
| `join_plan_answer` | `join_plan_answer` | already legal — the case for all 45 |
| `session_start` | `fb_session_start` | GA4 reserved name; prefixed, not dropped |
| `firebase_x` | `fb_firebase_x` | reserved prefix |
| `Card View!` | `card_view_` | lowercased, illegal characters to `_` |
| 60 × `a` | first 40 | 40-character cap |

Call it and check: `FBQ.gaName("session_start")`.

Parameters are sanitised the same way — names lowercased to `[a-z0-9_]`, 40
characters; string values cut at 100; booleans to `1`/`0`; arrays joined with
`|`; objects and functions dropped; 24 parameters maximum, one below GA4's 25
so there is always a spare. **A missing parameter is a gap in a report; a
malformed one is an event GA4 discards whole**, which is why anything doubtful
is dropped rather than sent.

### `card_view`, checked against GA4's limits

This is the one that fires often — once per card leave, 450 cards in the
corpus, so a determined reader produces hundreds in a session. What I found:

- **Event name**: fine. `card_view` is not reserved. (`screen_view` and
  `page_view` are; `card_view` is not either of them.)
- **Parameters per event**: it carries 6 in PostHog (`story`, `card`, `beat`,
  `topic`, `dwell_ms`, `dwell_s`). GA4 allows 25. Not a problem.
- **`dwell_s` is dropped for GA4.** It is `dwell_ms` divided by a thousand.
  Sending both spends two of the property's **50 event-scoped custom metric**
  registrations on one fact. PostHog still gets both, because PostHog charges
  nothing for a redundant property.
- **The registration budget is the real constraint, not volume.** Across the
  whole site the events carry 20 distinct parameter names — `stack`, `step`,
  `n`, `state`, `from`, `draw`, `correct`, `yes`, `why`, `slot`, `saved`,
  `plan`, `on`, `mins`, `days`, `card`, `story`, `beat`, `topic`, `dwell_ms`.
  GA4 shows **none of them in any report until each is registered** as a custom
  dimension or metric, against a limit of 50 dimensions and 50 metrics. 20 fits
  — but it is 40% of the budget spent on day one, and `n`, `on` and `state` are
  names nobody will recognise in a report in three months.
- **Cardinality is where `card_view` will actually disappoint.** `card` has
  ~450 distinct values and `story` 51; crossed, that is thousands of rows, and
  GA4 collapses high-cardinality dimensions into `(other)` once a report
  exceeds its daily row limit. The per-card dwell question — *where exactly
  does story 26 lose people* — is answerable in PostHog and is **not reliably
  answerable in the GA4 UI**. BigQuery export (free tier) answers it; the
  standard reports will not.
- **Volume**: GA4 web streams do not carry the app-stream cap of 500 distinct
  event names, and 45 is nowhere near it regardless. The cost of `card_view` is
  a second beacon per card alongside PostHog's — on a phone in the Instagram
  webview, that is real, and it is the strongest practical argument for §6.

---

## 4 · What is now collected, in both systems

**Both sinks receive exactly the same events with the same properties**, minus
`dwell_s` on `card_view` for GA4. No new call site exists: everything still goes
through the one `capture()` seam. `node tools/check-analytics.js` prints the
current count of event names in the source, which is the number to trust rather
than one written down here and left to go stale — it is **47** as of the pass
described in `ANALYTICS.md`.

> **Changed since this section was first written**, and both are set out in
> `ANALYTICS.md` §2 with what `privacy.html` §04 needs to say about them:
>
> * **`client_error`** is new — `{ message, source, line, page, release }`, the
>   first error reporting this site has ever had. Rate-limited to at most eight
>   per page load, scrubbed of anything that could identify or unlock, and with
>   no stack parameter on purpose.
> * **`ui_click`** carries `was_on` when the control is a toggle, read from
>   `aria-pressed` in the capture phase — so a mute and an unmute on the sound
>   button are no longer the same row.

|  | PostHog | Firebase / GA4 |
|---|---|---|
| Events | all of them | all of them |
| Identifier stored in the browser | yes, `ph_…` in localStorage | yes, `_ga` cookie + `measurementId` |
| Where | United States | Google, region per property |
| Opt-out | the privacy-page button | the same button |
| Reader's email or name | never | never |
| Onboarding answers | never (only *that* a step happened) | never |

The Firestore mirror in §1 is a **separate system from both**. It holds the
answers themselves and the email, tied to a real account, and it is not
analytics: it is the reader's own record, readable only by them, deleted with
their account. Do not conflate the two in the privacy policy — §5 keeps them
apart.

---

## 5 · What each one is good for

**PostHog is better at the questions this site actually asks.**

- Session replay, funnels and retention out of the box. "Which step of `join`
  loses people" is three clicks; in GA4 it is an exploration you have to build.
- High-cardinality properties are free. `card` × `story` — the per-card dwell
  question, the whole reason `card_view` exists — is a normal query.
- Person-level history. "Did anyone come back for a second story" is what the
  identifier in §4 is *for*, and PostHog answers it directly.
- Events arrive in seconds, which matters when you are watching a launch.

**GA4 is better at the questions the business asks around it.**

- Acquisition. It is the only one of the two that will tell you what Instagram
  and TikTok traffic is worth, because it is the one Google Ads and Search
  Console join to.
- Free BigQuery export, with no row cap and no sampling — which is also the
  only way it answers the `card_view` question honestly (§3).
- It is the same property the iOS app would report into, so a future
  web-plus-app view of one reader is possible in GA4 and is not in PostHog
  without paying for it.
- Nobody has to be granted a seat in a second tool.

---

## 6 · Two systems is a duplication. It was accepted on purpose.

Say it plainly, because the code will not:

> **Every event on this site is now sent twice, to two vendors, and there is
> no analytical reason for that.** The owner asked for it knowing so — "it's
> okay if we have a duplicate for now" — in order to compare the two on the
> same traffic before choosing. It is not an accident and it is not free.

What it costs, so the decision can be made on facts:

- **Two beacons per event on a phone in an in-app webview.** `card_view` is the
  worst of it: hundreds per session, doubled.
- **Two vendors in the privacy policy**, and therefore two things a reader has
  to be told about and two things the opt-out has to actually turn off.
- **Two places a number can be wrong**, and the near-certainty that the two
  will disagree — GA4's sessionisation and PostHog's are different, and
  somebody will spend a day on the gap.
- **A second identifier in every reader's browser.**

### Which to keep

**Keep PostHog. Drop GA4** — *unless* paid acquisition becomes real.

The site's actual open questions are which stories lose people and where in a
story they stop. PostHog answers both directly and GA4 answers the second one
only through BigQuery (§3, cardinality). Nothing on this site currently needs
Google Ads attribution.

**Reverse it if any of these becomes true:** money goes into Google Ads;
someone wants one property covering the website and the iOS app; PostHog's free
tier stops covering the volume.

### Decide by a date, not by drift

Give it **one month of real traffic**, then compare, in both, for the same
week: sessions, `stack_open`, `checkout_start`, and `stack_complete` /
`stack_open`. Whichever tool answered fastest and disagreed least with
Stripe's own count of checkouts is the one to keep.

**Removing GA4 is one file.** In `js/analytics.js`: delete the GA4 block and
the one `gaCapture` line in `capture()`. Nothing else on the site references
it. Removing PostHog is the same size, in the same function. That symmetry is
the point of the seam.

---

## 7 · The paragraph `privacy.html` needs

Not applied — `privacy.html` belongs to someone else. Drop this into §04 after
the PostHog paragraphs and before *"Turning it off"*, and the second block into
§01 or §02 near the account copy.

> **We also send the same events to Google Analytics.** Alongside PostHog,
> every event listed above goes to
> [Google Analytics 4](https://policies.google.com/privacy), through Firebase.
> It is exactly the same list — the same story ids, card numbers, step names
> and dwell times, and still never your email address, your name, or the
> content of your answers. Google stores an identifier in your browser too, in
> a cookie, for the same reason PostHog does: so two visits can be recognised
> as the same reader.
>
> **Running two analytics services is a duplication, and it is temporary.** We
> are comparing them on the same traffic in order to keep one. Until we do,
> your visit is measured twice. The off switch below turns off **both** — it
> always has covered everything on this page and it still does.

And, for the accounts section — because the site now has real accounts, and the
current copy ("no server-side account", "the answers never leave this browser")
is no longer true:

> **If you sign in, your onboarding answers are saved to your account.** What
> draws you to history, which statements sounded familiar, the daily goal and
> the streak you picked, your first name and your email — the same things this
> browser already remembers — are copied to your own record on Google Firebase
> so they survive losing this phone. They are stored under your account and
> readable by nobody else, they are used only to set up your reading plan, and
> they go nowhere near the analytics above. **If you are not signed in, nothing
> is copied anywhere**; the answers stay in this browser exactly as they did
> before. Deleting your account deletes them.

Three existing sentences now contradict the code and need the owner's eye:

- §01 lead — *"a website with no accounts and no server of its own"*.
- The bullet at the top — *"There is no server-side account and no password."*
- The paragraph near *"in to another phone or another browser, because there is
  no account to log into."*

All three predate `js/auth.js`. They are not mine to change, and neither is
`privacy.html`, but shipping the sync without fixing them ships a privacy page
that is wrong about the most important thing on it.

---

## 8 · Verification

Served from the site root on port **8915**, jsdom from `../rendercheck/`,
Firebase and PostHog both stubbed through the documented seams
(`FBQ_SDK`, `FBPS_SDK`, a pre-installed `window.posthog`). Every request to a
host other than the local server is aborted, which is what a blocked CDN looks
like on a real phone.

**All green: 74 assertions, 0 failing.** The harness lived in a scratch
directory and was deleted; what it asserts is written out here so it can be
rebuilt exactly.

1. **Syntax.** `node --check` on `js/profile-sync.js`, `js/analytics.js`,
   `js/account.js`.
2. **`stories.html` and `read.html?s=02`**, over HTTP, with both new files
   loaded the way markup would load them: zero script errors, `FBA`, `FBPS` and
   `FBQ` all present, more than 250 characters of *visible* text (`<script>`
   source excluded — scanning `textContent` for "sync" finds a variable name,
   not a leak), and no `permission-denied` / `[object Object]` / `Firebase:
   Error` anywhere on either page.
3. **One event, both sinks.** `FB.track("stack_open", …)` arrives once in
   PostHog and once in GA4, with its parameters; GA4 is initialised as the
   named `fbq` app, not the default; `FBQ.sinks()` reports both live.
   `card_view` keeps `dwell_ms` and drops `dwell_s` for GA4 while keeping it for
   PostHog. `gaName()` checked on a legal name, a reserved name, a reserved
   prefix, illegal characters and a 60-character name.
4. **Opted out, neither loads.** `posthog.init` never called, no Firebase app
   created, `getAnalytics` never called, the gtag kill switch set, and events
   fired afterwards reach nothing.
5. **Signed out, `profile-sync` is inert.** Four answers given while signed
   out: zero Firestore writes attempted, `FBPS.path()` empty, the answers still
   in localStorage, zero script errors, and nothing about syncing on screen.
6. **Signed in, it works.** A burst of six answers becomes exactly **one**
   merge write to `customers/UID123/profile/onboarding`, carrying `draw`,
   `goalMinutes`, `streakDays`, `relates`, `planAnswers`, `name`, `email` and a
   server-timestamp sentinel; no field outside the documented set; no field for
   a question that was not answered. An unchanged record is not re-written. A
   cleared answer is written back as empty.
7. **A denied write surfaces nothing.** With `setDoc` rejecting
   `permission-denied`: no unhandled rejection, no script error, the visible
   page byte-identical before and after, no error word anywhere on it, no
   retry, and the reader's answers still on the phone.
8. **Degradation.** With no SDK, no `FBU` and no dynamic import at all: `FBPS`
   still installs, PostHog still captures, `FBQ.sinks()` honestly reports
   Firebase off, zero script errors, and the page still has words on it.

---

## 9 · One shipped bug, fixed in passing

`js/account.js`'s `checkoutURL()` opened with:

```js
var link = linkFor(key);      // ReferenceError, every time
```

`linkFor` does not exist — the function is `link()` — and `var link` shadowed
it for the whole body anyway, so renaming the call alone would not have helped.
`checkoutURL()` has no try/catch, so **every plan button on `join.html` threw
and went nowhere.** Now:

```js
var dest = link(key);
```

The two query parameters also went in as bare strings while `P_EMAIL` and
`P_REF` sat unused directly above them; they now use the constants. One
identifier, the entire funnel.
