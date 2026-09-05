# The launch alarm — three emails, and what stops them lying

Two videos went out and nobody has arrived: zero `/firststory` opens in thirty
hours. This is not a reporting tool — the dashboard is that. This is a thing
that goes off the morning that changes, says how many and how far they got, and
then shuts up until tomorrow.

It emails **hassanjkhan6@gmail.com**, which is deliberately not
`hello@factbox.app`: a launch alarm that lands in a shared support inbox is an
alarm nobody is holding.

**Sending is off right now.** `RESEND_API_KEY` still holds the placeholder
`disabled-see-SUPPORT-EMAIL.md`. Everything else works: alerts are raised,
counted and written to Firestore in full, and §6 is the four minutes of work
that turns the mail on. Nothing raised while it is off is lost.

---

## 1. The three alerts

| | Fires when | How it knows | Where |
|---|---|---|---|
| **1 · Somebody arrived** | a non-admin opened `/firststory`, or read a card there | PostHog, `page_open` where `page = 'firststory'`, or `card_view` on the same page | `alertsWatch`, every 15 min |
| **2 · Somebody reached login** | a non-admin opened `/login` or `/join` | PostHog, `page_open` where `page` is `login` or `join` | `alertsWatch`, every 15 min |
| **3 · Somebody created an account** | a Firebase Auth account was created | Firebase Auth, directly | `alertsNewAccount`, immediately |

**No new analytics event names.** All three read events `js/analytics.js`
already sends — `page_open`, `card_view`, `stack_complete` — with properties it
already carries. GA4's name budget is untouched.

**Alert 3 is built differently on purpose, and it is the good one.** An account
is a row in Firebase Auth, so the truth is local, arrives as an event, and
cannot be lost to an ad blocker, a closed tab or the 10–25% that client-side
analytics costs. There is no polling, no watermark and no analytics anywhere in
it. Alerts 1 and 2 have no such record — the only place a pageview exists is
PostHog — so they are polled.

**Alert 3 is a *background* Auth trigger, not `beforeUserCreated`.** A blocking
function that throws *stops the sign-up*. A mail provider having an afternoon
must never be able to prevent somebody joining the site. Same instinct as
`support.js`'s "store first, mail second, and never let the mail decide the
answer", applied to the one path where the answer is a person getting an
account at all.

**Alert 2 counts both doors.** `/login`, and the sign-up pane inside `/join`,
which is where the end card of `/firststory` sends people. Counting one of them
would answer the owner's question wrongly about half the time. The email breaks
them out.

---

## 2. How a false positive is prevented

The owner and Kathryn are the only people using this site. **An alarm that goes
off on their own testing is worse than no alarm**: it gets ignored within a day,
and the day it is ignored is the day a real person arrives. So every path would
rather send nothing than send something it cannot stand behind.

### Admins are excluded, and if they cannot be, nothing is sent

`insights.js`'s `adminUids()` — the same list the dashboard's "leave us out"
switch uses, so the alarm and the dashboard cannot drift into disagreeing about
who counts as a stranger. The clause is built by `insights.js`'s own
`notAdmins()`, so each uid goes through `lit()` at the point of placement.

There are two admin accounts on this project today and the alarm excludes both.
The clause it appends, with the uids abbreviated because this repository is
public and there is no reason to publish them:

```
AND distinct_id NOT IN ('IwFqaphk…', 'woJ4di0z…')
```

**An empty admin list is treated as a failure, not as "no admins".** It cannot
be right — the owner is one — so an empty list, a missing export, or a Firestore
read that fails all produce the same answer: **no mail, an ERROR in the log, and
the alert written to Firestore anyway.** `watchSql()` throws rather than build a
query with no exclusion in it. An alarm that quietly stops excluding the people
it exists to exclude does not look broken; it looks like a launch.

### The signup alert filters on the address, because a uid cannot help

**A brand-new account is never already an admin**, so a uid list cannot catch
the owner making one more test account — which is by far the likeliest false
positive on alert 3. What catches it is the address: the admins' own emails out
of Firebase Auth, plus the alert address itself.

Normalised before comparing, because `hassan.j.khan+test2@gmail.com` and
`hassanjkhan@gmail.com` are one mailbox. Dots and a `+tag` are stripped for
gmail/googlemail; only the tag elsewhere, because dots are significant at most
other providers. Verified against a real plus-addressed account for both the
alert address and a live admin's address — both suppressed, no mail attempted,
both still archived with `suppressed: "own_account"`.

### One alert per type per UTC day

The first arrival is the news; the eleventh that morning is not, and forty
emails would be worse than none. The mail says **how many there were**, not one
mail each. The eleventh arrival is counted in `alerts_meta/state` and is silent.

**The day is a UTC day**, because that is how `support.js` counts a day, how
`insights.js` counts a day, and how Resend rolls its own allowance — one clock,
rather than a fourth opinion about when today is. The honest consequence: UTC
midnight is **8pm in Toronto**, so a launch evening busy on both sides of it can
produce two arrival alerts rather than one. Two is not the failure this cap
exists to prevent; forty is. It is written down here rather than left to be
discovered at 8:01pm.

---

## 3. What this cannot tell — read this before believing an alert

**A signed-out browser of your own is indistinguishable from a stranger.**

The exclusion matches on `distinct_id`, which is a Firebase uid only after
`js/analytics.js` has called `identify(uid)` — that is, only once signed in.
ANALYTICS-API.md §4 already says this about the dashboard, and it is the same
limit here, but it bites harder: a dashboard with the founders' own pageviews in
it is a slightly wrong number, whereas **an alarm with the founders' own
pageviews in it is a false alarm.**

I looked for something else to filter on and there is nothing honest. IP and
city would exclude real strangers in the same city. A `person_id` subquery would
stitch a signed-out session to its owner — but only *after* they next sign in,
which is too late for a fifteen-minute alarm, and `insights.js` declines the
same construct as untested HogQL that takes the whole query down rather than one
row of it. So the limit is stated rather than papered over, and **it is stated
in every arrival and login email**, not only here:

> A signed-out browser of your own still looks like a stranger — nothing in
> the event stream separates the two.

**The one real mitigation, and it needs no code.** The site already has an
off switch. In each browser you test the live site from, once:

```js
localStorage.setItem("fb_analytics_optout_v1", "1")
```

`js/analytics.js` reads that before either loader runs, so neither PostHog nor
GA4 is even fetched. That browser then cannot produce a false alarm at all. It
is the same key the privacy page's opt-out sets.

**Browser automation is already excluded — but only because of where it runs.**
`js/analytics.js` sends nothing unless the hostname is `factbox.app` or
`www.factbox.app` (or `fb_analytics_local=1` has been set on purpose). A
headless browser on `127.0.0.1` is invisible to this alarm; that guard is the
fix for the afternoon that put 500-odd robot "users" into the dashboard. **A
headless browser pointed at production is not excluded and looks exactly like a
stranger.** Do not drive the live site to test this — drive the check script in
§7 instead.

**Late ingestion.** Each check stops two minutes short of `now` and moves the
watermark to there, so the common case of an event landing a few seconds late
is inside the next window. An event ingested more than two minutes after its own
timestamp, once the watermark has passed it, is not alerted on. It is still in
PostHog and still in the dashboard. This is an alarm, not an accounting system.

---

## 4. What stops the same arrival being reported twice

Two different things could double-report and they need two different answers.
Both live in **`alerts_meta/state`**, one Firestore document, so both survive a
cold start, a redeploy, a second instance, and this file being edited. Neither
is in memory anywhere.

```
alerts_meta/state
  day             "2026-09-05"            UTC; the per-day fields reset with it
  arrivalThrough  "2026-09-05 21:55:49"   watermarks, ClickHouse format
  loginThrough    "2026-09-05 21:55:49"
  sent            { arrival: <ts|null>, login: <ts|null>, signup: <ts|null> }
  seen            { arrival: 4, login: 2, signup: 1 }   today's totals
  checks          41      scheduled runs today
  upstream        41      PostHog queries today   -> the cost cap
  mailed          2       alert emails today      -> the emergency ceiling
  lastCheckAt, updatedAt
```

- **The same arrival counted in two consecutive checks** — the watermark. An
  alert fires only if some qualifying event is *strictly newer* than the last
  checked-through instant.

  Both sides of that comparison are normalised to a fixed 26 characters —
  seconds, a dot, six digits — and every cutoff is snapped to a whole second.
  **This is not fussiness, it is a bug that real PostHog exposed and a stub
  never would.** `timestamp` there is a `DateTime64`, so `toString()` returns
  `2026-09-05 16:25:29.366000`; the watermark was written from a JavaScript
  `Date` and had no fraction. Compared as plain strings, the longer one wins on
  the shared prefix:

  ```
  '2026-09-05 21:49:52.100000' > '2026-09-05 21:49:52'   ->  true
  ```

  so an event in the *same second* as the watermark read as newer than it and
  would have been reported twice. Truncating both to seconds instead swaps it
  for the opposite bug — the window is `timestamp < cutoff`, so an event at
  `…52.5` falls outside the window ending at `…52` and would then compare
  *equal* to the watermark next time and never be reported at all. Fixed width
  is the only version with neither hole, and there is now a test for the exact
  boundary second.
- **A second email about the same morning** — the `sent` marks.

**The watermarks are deliberately not reset when the day rolls.** A day boundary
is a fact about the calendar, not a reason to re-report something already
reported. The per-day marks reset; the watermark does not. Those two sentences
are the whole difference between "one alert a day" and "the same arrival every
morning".

**The watermark advances on every successful check, mailed or not.** It means
"PostHog has been read up to here", not "everything up to here has been
emailed" — the once-a-day cap is a separate fact, in `sent`.

---

## 5. Interval and cost

**Every 15 minutes**, UTC, `maxInstances: 1`, `retryCount: 0`. Not every minute,
because this is an alarm for a morning rather than a trading system, and 96 runs
a day is inside every free tier while 1,440 starts to matter. Not hourly,
because "the moment it starts working" should not mean "up to an hour after".

96 runs a day, ~2,920 a month:

| | Per month | Free allowance | Cost |
|---|---|---|---|
| Cloud Scheduler | 1 job | 3 jobs free per billing account | **$0** |
| Function invocations | ~2,920 | 2,000,000 | **$0** |
| Compute | ~1,460 GiB-s, ~5,840 vCPU-s | 400,000 GiB-s / 200,000 vCPU-s | **$0** |
| Egress | ~6 MB | 5 GB | **$0** |
| Firestore | ~580 reads + ~190 writes **a day** | 50,000 reads + 20,000 writes a day | **$0** |
| PostHog query API | ~2,920 queries | no per-query charge; well inside the rate limit | **$0** |
| Resend | ≤93 emails (3/day) | 3,000/month, 100/day | **$0** |
| Secret Manager | no new secrets | — | **$0** |

**Total: $0/month.** Every line is inside a free tier, and this is the first of
three free Cloud Scheduler jobs. If that free tier ever changes, the exposed
line is $0.10/month for the job.

The two figures worth showing the working for, because both were wrong in the
first draft. Compute is billed at the **`availableCpu: 1`** the deployed
function actually reports, not the fraction a 256 MiB function used to get:
2,920 runs × ~2 s × 1 vCPU ≈ 5,840 vCPU-seconds, which is 2.9% of the free
200,000. Firestore is ~6 reads and 2 writes a run — two transactions on
`alerts_meta/state`, plus the two `customers` queries `adminUids()` makes when
its 60-second cache is cold, which on a job that runs once every fifteen
minutes it always is. That is ~1% of the daily free read allowance.

**What a bad day can do is capped, twice:**

- `MAX_UPSTREAM_PER_DAY = 120` — past it, the function still runs and still
  reads its own state, but **does not call PostHog**. The slot is claimed in a
  transaction *before* the query, so a run that dies mid-query has still paid
  for it and the cap cannot be walked past by crashing.
- `MAX_MAIL_PER_DAY = 10` — an **emergency ceiling, not the design cap**. The
  design cap is three a day (three alerts, one each) and is enforced by the
  `sent` marks. This number is set well above three on purpose: a shared
  counter set *at* the design maximum can be exhausted by the two lesser alerts
  and then starve the signup alert, which is the most valuable of the three. A
  ceiling that can silence the alarm it is protecting is not a safety feature.
  (The first draft set it to 3 and the check script caught exactly that.)

It shares Resend's allowance with `support.js`, which caps itself at 80/day;
80 + 10 = 90, under the provider's 100/day.

---

## 6. Switching sending on — what the owner has to do

**One thing, and it is not in this feature.** `RESEND_API_KEY` is shared with
the support form, so SUPPORT-EMAIL.md §3 steps 1–3 — the Resend account, the
`send.factbox.app` sending domain, the three Cloudflare DNS records — are the
same setup and only need doing once. If they are already done, the whole of
switching this on is:

```
firebase functions:secrets:set RESEND_API_KEY     # paste the re_… key
firebase deploy --only functions:alertsWatch,functions:alertsNewAccount,functions:support
```

The redeploy is required, and for both generations: a function is pinned to the
secret *version* it was deployed with, so setting a new version changes nothing
until the function is deployed again. `alertsWatch` is 2nd gen and
`alertsNewAccount` is 1st gen; both need it. `support` is in the list because it
holds the same secret and should pick up the same version.

Nothing else. No new secret, no new DNS record, no new dependency.

### And one line elsewhere, which is blocking all three alerts

`functions/insights.js` exports `_notAdmins` (which *builds* the exclusion
clause from a list) but **not `adminUids` (which *reads* the list)**. Writing a
second reader in `alerts.js` was the obvious move and is the wrong one: if
`insights.js` ever changes what counts as an admin, the copy diverges silently,
and the direction it diverges in is *"the alarm starts firing on the owner."*

So it is imported optionally and its absence fails closed. **Until this line is
added, every alert is archived and none is emailed** — see the ERROR in the
logs, which quotes it. Add to the export block at the bottom of
`functions/insights.js`:

```js
exports._adminUids = adminUids;
```

then `firebase deploy --only functions:alertsWatch,functions:alertsNewAccount,functions:insights`.

*(`insights.js` was off-limits to this change, so the line is written here
rather than made.)*

### Optional, and lower stakes

`functions/support.js` exports `_mailPayload`, `_MAIL_TO` and `_replyTo` but not
`sendMail`, `mailKey` or `mailOn`, so `alerts.js` carries a second sender —
same Resend JSON API, same constant `to`, same fail-soft, same 5-second bound.
The duplication is disclosed rather than hidden, and it is the cheap half to
duplicate: if the two drift, the cost is an alert email that does not send,
which is logged and whose text is already in Firestore. Adding
`exports._sendMail = sendMail;` to `support.js` would let it be deleted.

---

## 7. What the emails look like

Plain text. **No `html` field is sent at all.** `to` is a constant. Nothing from
outside reaches a header — the subjects are built from constants and integers
the server counted. There is no `reply_to`; there is nobody to reply to. Short
enough to read on a lock screen without opening it.

**Alert 1 — somebody arrived.** Subject: `Factbox — 2 people opened /firststory`

```
2 people opened /firststory.

People today   : 2
New this check : 2
Furthest card  : 9
Finished it    : 1 of 2
Latest         : 2026-09-05 21:31:14 UTC

One of these a day. However many more arrive today, the next /firststory
alert is tomorrow — the count above is today so far.

Left out: 2 admin accounts, by uid, once signed in.
A signed-out browser of your own still looks like a stranger — nothing in
the event stream separates the two. ALERTS.md, "what this cannot tell".
```

"Furthest card" and "Finished it" are the point of that email: *somebody arrived
and read one card* and *somebody arrived and finished the story* are very
different mornings, and the subject line alone cannot tell them apart.

**Alert 2 — somebody reached login.** Subject: `Factbox — 2 people reached the login page`

```
2 people reached the login page.

People today   : 2
New this check : 2
/login opens   : 1
/join opens    : 2
Latest         : 2026-09-05 21:55:13 UTC

Both doors are counted: /login, and the sign-up pane inside /join, which
is where the end card of /firststory sends people.

One of these a day. The count above is today so far.

Left out: 2 admin accounts, by uid, once signed in.
A signed-out browser of your own still looks like a stranger — nothing in
the event stream separates the two. ALERTS.md, "what this cannot tell".
```

**Alert 3 — somebody created an account.** Subject: `Factbox — someone created an account`

```
Somebody created a Factbox account.

Email    : reader@example.com
Provider : password
Account  : Dufn3jakloUXNOm5DPfXZXhgAD82
When     : 2026-09-05 21:53:18 UTC
Today    : account number 1

Not one of the 2 admin accounts, and not hassanjkhan6@gmail.com.

One of these a day. If more accounts are made today they are counted in
alerts_meta/state and not mailed.
```

Counts are **people, not events**: one person reloading `/firststory` eleven
times is one arrival. That is the difference between an alarm and a noise
generator.

The address is in the body and never in the subject, forced onto one line
because it is the only string in any of these mails the server did not generate.
It is included in full and not masked on purpose: it is the one field that tells
*a stranger joined* from *Kathryn made another test account*, which is the
entire question alert 3 exists to answer. It is the owner's own site, mailed to
the owner's own address, and the same value is already on screen in the Firebase
Auth console.

---

## 8. What is stored, so nothing is lost while mail is off

**`alerts/{stamp-xxxx}`** — one document per alert **raised**, written *before*
the mail is attempted and written whether or not the mail can go. Store first,
mail second; a mail failure is an ERROR log line and a field on a document that
already exists.

```
signal      "arrival" | "login" | "signup"
at, day
to          hassanjkhan6@gmail.com
subject     the exact subject
text        the exact body, in full
mail        "off" | "pending" | "sent" | "failed" | "suppressed"
mailWhy     the reason, when it failed
suppressed  "own_account" | "already_alerted_today" | "admin_list_unavailable" | …
people, fresh, window, adminsExcluded          (alerts 1 and 2)
uid, email, provider, todayCount               (alert 3)
```

So **"what did I miss while the mail was off" is a question the archive answers**
rather than one that needs the event stream re-read. The document id sorts by
time, so the console lists them in order:

<https://console.firebase.google.com/project/factbox-7cb97/firestore/data/~2Falerts>

Alerts deliberately **not** mailed are in the same collection with `suppressed`
saying which and why — so "did it see that?" has an answer, rather than a
silence that looks the same as a bug.

**No `expiresAt` and no TTL policy**, unlike `support_ip` and `insights_rate`.
Those are counters that stop mattering after a day; this is the archive, and an
archive that deletes itself answers "what did I miss" with nothing.

Both collections are **deny-all to every browser in both directions** in
`firestore.rules`, written out explicitly rather than left to the `{document=**}`
catch-all, for the reason `insights_rate` gives: so a future rule for a
neighbouring path cannot widen it by accident, and so the collections have
somewhere to be explained. A client that could write `alerts_meta/state` could
silence the alarm or make it fire on demand; a client that could read `alerts/`
could read a new reader's email address.

---

## 9. Loose ends

**`privacy.html` needs a sentence, and it belongs to another hand.** §09's
processor list does not name a mail provider, and §08 says where a support
message goes and stops at Firestore. Alert 3 emails a new account's address to
the owner via Resend, which is a processor and a disclosure. Not urgent while
the mail is off; due before the key goes in — the same batch of edits
SUPPORT-EMAIL.md §5 already asks for.

**`page_open`'s `page` values are read off the client, not off a contract.**
ANALYTICS-API.md names `firststory` and nothing else. `login` and `join` come
from `js/analytics.js`'s `pageName()`, which is the last path segment with the
extension stripped. **If a page is ever renamed, the alarm goes quiet without
saying so.** `FIRSTSTORY_PAGE`, `LOGIN_PAGE` and `JOIN_PAGE` in `alerts.js` are
the three constants to change.

**Node 20** is decommissioned for Cloud Functions on **30 October 2026**. Noted,
not migrated. `alerts.js` adds no dependency and uses nothing newer than global
`fetch`, so it moves to Node 22 whenever the other five move, in one change.
That is now six functions on one runtime pin rather than five.

**These are the first two functions on this project that are not HTTP** — the
first scheduled one and the first background trigger. BACKEND.md documents five
`onRequest` functions and has no section for either; it should gain one.
