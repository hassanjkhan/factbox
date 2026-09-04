# Factbox — the questions, and which event answers them

This is the **question-first** document. It starts from what the owner wants to
know and works back to the event, rather than starting from the events and
hoping they add up to something.

Two companion documents, neither of which this one repeats:

* `FIREBASE-ANALYTICS.md` — *how* it is collected: two sinks, the GA4 naming
  rules, the proxy, and the decision to keep both for now.
* `privacy.html` §04 — what a reader is told is collected. That file is the
  published promise. **If this document and that page disagree, that page is
  wrong and has to be corrected**, because a policy that under-describes is as
  wrong as one that over-describes.

Everything on the site funnels through one function, `capture()` in
`js/analytics.js`, and out to PostHog and GA4. There is no second set of call
sites anywhere.

---

## 1 · The audit

Every row was checked by driving the real site in real Chrome against
`tools/serve-like-pages.py`, with every request to PostHog, GA4, Google and
Firebase blocked at the network layer and `capture()` recorded instead. Nothing
below is inferred from reading the source.

| The question | The event and property | Fires today? |
|---|---|---|
| Dwell on one page of a story: story name, page number, seconds | `card_view` → `story`, `card`, `dwell_ms`, `dwell_s`, plus `beat` and `topic` | **Yes.** Verified: `card_view{story:"01",card:0,beat:"hook",dwell_s:2.5}` on every card of a real read |
| Exactly how far people go in a story | `stack_complete` / `stack_dropoff` → `card` (the deepest card reached, 1-based) | **Yes** |
| When they drop off | `stack_dropoff` → `stack`, `card`; and `card_view` on the card they stopped on, which is stamped before the story total that counts it | **Yes** |
| How long a whole story held them | `story_time` → `stack`, `dwell_ms`, `cards`. Engaged time: the clock stops while the tab is hidden | **Yes** |
| Analytics for crash reports and other issues | `client_error` → `message`, `source`, `line`, `page`, `release` | **New — this pass.** Nothing listened on `window.onerror` or `unhandledrejection` on any page, ever |
| Every single button press | `ui_click` → `page`, `control` (one delegated listener in the capture phase, so a handler calling `stopPropagation` cannot hide a tap). Controls that already send a named event of their own are skipped so no tap is counted twice | **Yes**, with one naming defect left — §4. Two controls were found double-counting and were fixed this pass — §2 |
| Getting to the Stripe page | `checkout_start` → `plan`, `attributed`; and `checkout_blocked` → `why` when it could not start | **Yes** — but read §3, it does not mean what it looks like it means |
| Leaving the Stripe page | — | **No, and it cannot. §3.** |
| Coming back successfully | `access_gained` → `from` (`stripe` \| `restore` \| `local`), fired once per newly-minted access token | **Yes** |
| Making accounts | `signup_email`; `join_signup`; `signin_google` | **Partly.** §4 — a Google *sign-up* is indistinguishable from a Google *sign-in* |
| Using the audio button, then muting or playing | `ui_click` → `control` = `sound_on` (a play) \| `sound_off` (a mute), plus `was_on` as the measured cross-check | **New — this pass.** Before it, every mute and every unmute arrived as one undifferentiated `fb_rail` |
| Saving a story | `save_add` / `save_remove` → `stack` | **Fixed this pass.** It fired on page load for every story, free or locked, saved or not |

Everything above can additionally be split by `has_account`, `is_subscriber`
and `access`, which `js/analytics.js` registers on **every** event, and by the
Firebase uid once someone signs in.

---

## 2 · What was added, and the guards that hold it

`tools/check-analytics.js` went from 10 instrumentation guards to 17. Each new
guard was mutation-tested: the thing it guards was broken on purpose and the
check was confirmed to fail. A guard that has never failed is a guard nobody
knows works.

### `client_error`

```
client_error { message, source, line, page, release }
```

* **`message`** — scrubbed, then clipped to 100 characters like every other
  string parameter here, so PostHog and GA4 store the same string rather than a
  long one and a truncated one. An unhandled promise rejection is marked
  `[rejection] ` at the front of the message rather than in a sixth parameter:
  GA4 registers fifty custom dimensions for the whole property, and the person
  reading a stack trace is reading the message anyway.
* **`source`** — a path, never a URL. The origin, the query and the fragment are
  gone before it leaves.
* **`line`** — a number. For a rejection it is dug out of `reason.stack`
  locally and the stack is then thrown away.
* **`release`** — see below.

**There is deliberately no `stack` parameter.** A stack is many lines of many
URLs, and this site puts secrets in URLs: `?restore=<token>` is a working key to
a paid season and Stripe's success redirect carries a `session_id`. One rejected
fetch inside a promise chain that had been handed a restore link would put that
token into two analytics vendors forever. `scrub()` removes, in order: the query
and fragment of any URL, `user:pass@` credentials, anything shaped like an email
address, and any unbroken run of 24 or more token characters. Verified — a
rejection whose message was

```
Failed to fetch https://factbox.app/explore?restore=abc123DEFghi456JKLmno789&session_id=cs_live_xyz
```

was sent as `Failed to fetch https://factbox.app/explore`, and
`auth refused for reader@example.com` was sent as `auth refused for <email>`.

**The rate limit is the point.** Both readers repaint on a `MutationObserver`
and on scroll, so a throw inside one of those is a throw *per frame*. Unlimited,
one phone on one story would post tens of thousands of events, drown the real
traffic in the same charts this exists to make readable, and be billed for
twice. An error report that makes the dashboard useless has done more damage
than the bug it was reporting. Two limits, both per page load, both arithmetic —
no timers, nothing that can be wrong on a phone whose clock is wrong:

1. **The same error is sent once.** Signature is message + source + line.
2. **At most `ERR_MAX` (8) events**, whatever they are.

So one page load cannot cost more than eight `client_error` events. That is a
bound that can be stated, not a rate that has to be believed. Verified in
Chrome: one throw → exactly one event; the *same* error thrown 400 times →
exactly one event; 400 *different* errors → exactly eight.

**Nothing is reported from a page that is leaving.** A navigation cancels every
request in flight, and the rejections that produces ("Failed to fetch", "The
operation was aborted") are what leaving a page looks like from inside it, not a
fault. `pagehide` stops reporting; `pageshow` starts it again, or one tap on
Back would leave a live page that never reports for the rest of its life. **No
`unload` or `beforeunload` listener was added** — either one disqualifies every
page on this site from the back/forward cache, which `js/gate.js`'s
back-after-paying correction depends on and says so. There is now a guard that
fails if one appears anywhere on the site.

**It cannot become the bug.** `addEventListener`, not `window.onerror`, so
nothing a page already had is replaced and `js/scenes.js` keeps its own `error`
listener. The listener is not in the capture phase, so a missing image or a
blocked font — a 404, not a client error, and it would be the loudest thing in
the report — is not counted. Nothing calls `preventDefault`, so the console
still logs exactly as before. A `sending` flag guards re-entry so a throw inside
the reporting path cannot report itself in a loop.

**A useful null result:** with every third-party host blocked — Firebase, the
Google fonts, the Cloud Function — all nineteen pages loaded, rendered, and
produced **zero** `client_error`. The channel is quiet when the site is working,
which is what makes a spike mean something.

### `release`

`RELEASE` is a hand-set literal at the top of `js/analytics.js`. It is the one
thing in that file that is not self-maintaining, and it is worth being blunt
about why:

> This site has no build step. The `.js` and `.html` files are served raw off
> GitHub Pages at the same URLs forever, and there is nothing a browser can read
> — not a filename hash, not an ETag, not a header — that changes when a commit
> lands. There is no honest way to derive a release id at runtime. So it is
> written down, or it does not exist.

**Bump it in the same commit that changes site behaviour.** `check-analytics.js`
asserts the *shape* (`yyyy-mm-dd` with an optional letter, so two deploys in one
day are two releases). It cannot assert that somebody remembered, and pretending
it could would be exactly the fabricated number this repo keeps refusing. If
nobody is going to bump it, delete the constant and the parameter together: a
release field that always says the same thing is worse than no release field,
because whoever reads the dashboard believes it.

### The sound button: `sound_on` / `sound_off`, and `was_on`

This is the control the owner asked about by name, so it gets both halves.

**The name.** The button carried no `id`, no `name` and no `data-fbt`, so
`js/analytics.js` had to guess one by walking up to six ancestors — and on all
four readers the first thing it finds is `#fb-rail`, the control *column* the
button sits in. Every mute and every unmute the site has ever recorded arrived
on the dashboard as **`fb_rail`**: one undifferentiated number named after a
piece of layout. (`js/audio-reader.js` was unowned; this pass took it.)

`paint()` now sets `data-fbt` alongside the `aria-pressed` it already
maintained, and the value names **what the next press will do**:

| `control` | `was_on` | meaning |
|---|---|---|
| `sound_on` | `false` | the sound was off and they pressed it → **a play** |
| `sound_off` | `true` | the sound was on and they pressed it → **a mute** |

**The direction is the whole thing, and the obvious version is backwards.** The
delegated listener reads `data-fbt` in the **capture phase**, before the
button's own handler has flipped anything. An attribute naming the *current*
state would therefore be read one press out of date and would file every play as
a mute and every mute as a play — a number that is exactly wrong and looks
completely plausible. So the attribute is the **inverse** of the state, and
`check-analytics.js` asserts the inverse rather than trusting it. Verified by
pressing it both ways on all four readers and reading the captured event, not by
reasoning about it.

Naming an outcome would normally be a guess about a handler. It is not one here:
the handler is eleven lines below in the same file and does exactly one thing,
`if (on || armed) turnOff(); else turnOn();`, off the same `live` the attribute
is computed from, and `paint()` runs on every state change.

A **retired** button — the folder is empty, or the host is serving 404s — stays
on screen and tappable for another 2.6 seconds while its handler returns
immediately. It now sets `data-fbt="-"`, so a tap that does nothing is not
reported as a play that never happened.

**`was_on` is the cross-check, and it is the measured one.** On this button the
two are always inverses: `control:"sound_off"` travels with `was_on:true`. If a
report ever shows them agreeing, the attribute has been flipped and **the
measured one is the one to believe**.

### `was_on` on `ui_click`

The section above fixes the sound button by name. `was_on` is the general rule
underneath it, and it costs nothing extra: it is one parameter that works for
every toggle this site will ever have, without a per-control attribute on any of
them.

`was_on` is read from **`aria-pressed`**, which is already on the sound button
and the save bookmark because both had to be reachable from a screen reader —
not because anyone was thinking about analytics. It is therefore free, it is
correct for every toggle this site ever adds, and it needs no cooperation from
any page. A branch on `className` would have been a special case that goes stale
the first time the button is restyled.

The click listener runs in the **capture phase**, before the control's own
handler flips anything, so:

| | means |
|---|---|
| `was_on: true` | the sound was on and they pressed it → **a mute** |
| `was_on: false` | the sound was off and they pressed it → **a play** |
| no `was_on` at all | not a toggle |

It is deliberately *not* "the state it ended up in". That would be a guess about
a handler this file does not own: a control that is disabled, that throws, or
that opens a dialog instead of toggling would be reported as having changed when
it did not. Absent rather than `false` for a non-toggle, because collapsing
those two would put every button on the site into the "was off" bucket.

**The auto-on is not a press, and does not look like one.** Sound is on by
default and `js/audio-reader.js` arms it to start on the reader's first gesture
— a swipe, usually about a second in. That path fires no `click` on the button,
so it produces no `ui_click` and no `was_on`. Verified: a tap-and-scroll on the
deck turned the sound on and emitted `card_view` and nothing else.

### Two taps that were being counted twice

`skipControl()` exists so a control that already sends a named event of its own
does not also send `ui_click`; the guard that protects it has been in
`check-analytics.js` since before this pass. Driving every button on every page
in Chrome found two controls the list had never been told about.

| Control | Was sending | Now |
|---|---|---|
| `/settings` `#st-billing` | `ui_click{control:"st_billing"}` **and** `billing_portal` | `billing_portal` only |
| `/join` `.jn-yn` (six buttons) | `ui_click{control:"jn_q_N"}` **and** `join_plan_answer{n, yes}` | `join_plan_answer` only |

`subscription.html`'s four portal links were given `data-fbt="-"` for exactly
this and `#st-billing` was missed, so `/settings` has been counting one tap
twice for as long as both have existed. The `.jn-yn` case was worse than a
duplicate: both halves of a question sit inside one `#jn-q-N`, so the `ui_click`
could not say *which way* they answered, while the `join_plan_answer` it was
duplicating carries `yes` and always could.

**The test for that list is now written down, because the obvious tidy-up is
wrong.** A named event that fires *unconditionally* from the same tap makes
`ui_click` a duplicate. A named event that fires inside a `.then()` does not:
`ui_click` counts the **attempt** and the named event counts the **success**,
and the pair is a funnel. That is why `#au-go`, `#au-google`, `#au-out` and
`#st-out` are deliberately *not* skipped — `signin_email`, `signup_email`,
`signin_google` and `signout` all fire on success only, and skipping their
buttons would delete every failed sign-in from the record, which is the half of
"making accounts" that says why it is not working. A guard now fails if any of
the four is added to the skip list.

### `save_add`, at the save

`js/saves.js`'s `button()` took a callback parameter named `onChange`, which
**shadowed the module's own subscribe function of the same name** eleven lines
from the top of the file. The repaint subscription at the bottom of `button()`
therefore called *the caller* back, once, at build time, with a function as its
first argument — truthy — and all four readers turn that argument straight into

```js
FB.track(isSaved ? "save_add" : "save_remove", { stack: s.id })
```

One `save_add` per story opened: free or locked, saved or not, before the reader
had touched anything. **Every `save_add` on the dashboard since this button
shipped is a story being opened.** The number was not slightly high — it was the
story-open count wearing a different name. Historic `save_add` totals should be
treated as unusable, not as adjustable.

The parameter is now `onToggle`, which means a tap and nothing else. The fix
also repaired a second, silent bug in the same line: because the subscription
was never made, the bookmark **never repainted when the account's answer landed
~600ms after the reader**, which is the exact thing the comment above it says it
is there to prevent. Verified: `FBS.show(true)` now flips the button from "Sign
in to save this story" to "Save to your library", and a tap sends exactly one
`save_add`, and an untap exactly one `save_remove`.

---

## 3 · The Stripe leg: what is knowable, and what is genuinely dark

This is the owner's stated priority, so it gets said plainly rather than
covered with a proxy metric.

The reader's path is: our plan screen → `buy.stripe.com` → back to us on
`?unlocked=1`. **We own the first and third parts of that and none of the
middle.**

| Step | Event | What it actually means |
|---|---|---|
| Chose a plan | `subscribe_click` → `from` | Observed on our page |
| Could not start | `checkout_blocked` → `plan`, `why` (`no_uid` \| `no_url`) | Observed. It exists so a checkout that was *refused* is not counted as one that was abandoned — two very different problems, one shape in the report |
| Started checkout | `checkout_start` → `plan`, `attributed` | **Fired the instant before `location.href` is set.** It means *we sent them*, not *Stripe's page rendered* |
| Stripe's page loaded | — | **Dark** |
| Card entered, or abandoned, or declined | — | **Dark** |
| Came back with access | `access_gained` → `from` = `stripe` | Observed, once per newly-minted token |

### Where the blind spot genuinely is

Between `checkout_start` and `access_gained` there is a page on someone else's
origin that we cannot instrument and should not try to. `checkout_start` with no
matching `access_gained` is **not** "abandoned checkout". It is the union of at
least: never arrived (a dead connection on the redirect), arrived and left,
arrived and was declined, paid and closed the tab before the redirect, and paid
on a phone and came back on a laptop — where the purchase is real and simply
landed on a different browser than the one that fired `checkout_start`.

Reporting that union as an abandonment rate would be inventing a number. It
should be reported as **"started checkout, no return seen in this browser"**,
which is what it is.

### One thing that is knowable and is not being read

Stripe's own record — the webhook's customer/subscription row — is the only
place the middle of that funnel exists, and it is the *authoritative* count of
who actually paid, because it does not depend on a browser coming back at all.
`functions/*` is being built by another agent and was not touched here. The
honest funnel is: `checkout_start` from us on one side, the webhook's own count
on the other, and `access_gained` measuring only the third thing — **whether
access worked once they returned**, which is a different question and a
worthwhile one.

### One risk worth knowing about

`checkout_start` is captured on the line before `location.href` is set. If the
Firebase Analytics SDK has not finished loading at that moment the event is
still sitting in `gaQueue` and goes nowhere; PostHog's own beacon is more likely
to survive the navigation. So the two sinks may not agree on the
`checkout_start` count, and **PostHog is the one to trust for it**. This is a
pre-existing property of the two-sink design, not something this pass changed.

---

## 4 · What the data still cannot answer

Listed as questions, with what it would take, and no proxy quietly labelled as
the real thing.

**1. Anything that happens on Stripe's page.** §3. It would take reading the
Stripe side — the webhook record already being built in `functions/*` — and
joining it to `checkout_start` by the uid `attributed` already carries. There is
no client-side answer and there should not be one.

**2. Whether a Google sign-in created an account or reused one.**
`login.html:597` fires `signin_google` on both. "Making accounts" is therefore
undercounted by every account created with Google, and `signup_email` alone is
not the answer. It would take one line: `js/auth.js`'s `signInGoogle()` result
carries Firebase's `isNewUser`, so `FB.track(isNew ? "signup_google" : "signin_google")`.
Both files are held — see the hand-over list below.

**3. Whether a control that borrows its container's name is the one that was
pressed.** `ui_click` names a control from the first identifier it finds,
walking up to six ancestors. Where a button has no id of its own it inherits its
*container's*, which is right for a card that is one big link and wrong for two
buttons inside one box. The two places this actually bit — the sound button and
`/join`'s yes/no pairs — are both fixed, in §2 and §3 below. Nothing else on the
site was found doing it harmfully, but the mechanism is still there.

The general fix would be to make `controlName()` stop at the resolved control.
That is **not** worth doing: it would rename about twenty existing series at
once and silently break every chart built on them, which is a bigger change than
the bug. Per-control `data-fbt` is the seam, it is one attribute on one line,
and it renames nothing else.

**4. Whether music was actually playing during a given reading.** `was_on`
counts *presses*, which is what was asked. It does not count the majority who
never touch the button and read with the default on. Answering that would mean
putting the sound state on `story_time` — one more parameter, one more thing on
the privacy page — and it has not been done, because it was not asked for and
this file does not add events on speculation.

**5. Which card someone was on when the site broke.** `client_error` carries
`page`, not `card`. Joining it to the nearest preceding `card_view` for the same
session gets close, and PostHog can do that in a session query. Putting `card`
on `client_error` directly would mean the error path reading the reader's DOM,
which is exactly the state that is most likely to be broken at that moment.

---

## 5 · Hand-over: files this pass does not own

### `privacy.html` — two lines to change

`privacy.html` §04 publishes what every event carries. Two events changed shape,
so **as it stands that page now under-describes what is collected.** These are
the exact edits.

**(a) `ui_click` — replace the existing `<li>`** with:

```html
<li><code>ui_click</code> — a button or link was tapped, carrying the page and the control's name. The name comes from the element's id or the words printed on it, which are copy written in our own repository. It never reads a text box, a menu or anything you typed. If the control is an on/off switch — the ambient-sound button, the save bookmark — it also carries whether that switch was on or off at the moment you pressed it. The sound button's name says which way you turned it: <code>sound_on</code> or <code>sound_off</code>.</li>
```

**(b) `client_error` — a new `<li>`**, best placed immediately after the
`ui_click` one:

```html
<li><code>client_error</code> — something on the page failed. This carries the error message, the file and line it came from, the page name and which release of the site you were on. The message and the filename are stripped of anything that could identify you or unlock anything before they are sent: web addresses lose their query strings, so a restore link or a Stripe session id cannot travel with them; anything shaped like an email address is replaced with the word <code>&lt;email&gt;</code>; and any long unbroken run of letters and numbers, which is what an id or a token looks like, is replaced with <code>&lt;id&gt;</code>. We never send the full stack trace. A single page load can send at most eight of these, and none at all once you have started navigating away.</li>
```

The closing paragraph of §04 — "None of these carries your email address, your
name, or anything you typed into a box" — remains true.

### `subscription.html:253` — one attribute, or a decision

```html
<button class="go" type="button" id="sb-accept" data-fbt="sub_offer_take"></button>
```

`js/subscription.js:833` fires `subscribe_click` from this same tap,
unconditionally, so one press of the save-offer button sends two events. The
four portal links on the same page carry `data-fbt="-"` for exactly this reason
and this one does not. Either change it to `data-fbt="-"`, or keep both on
purpose and know that **`subscribe_click` counts include people taking a
cancellation save offer**, which is not what that name suggests. This was left
alone rather than guessed at, because unlike the other two it is arguable.

### `login.html:597` and `js/auth.js:754`

`signin_google` fires for a new account and for a returning one — §4 item 2.
This is **not** a one-line change, and it is worth saying why before anyone
promises it is:

* `signInGoogle()` at `js/auth.js:754` resolves
  `{ redirecting: false, user: cred.user }` — it keeps `cred.user` and drops
  the credential, and `isNewUser` lives on the credential, via Firebase's
  `getAdditionalUserInfo(cred)`. So `auth.js` has to pass it out.
* That covers the **popup** path only. Most readers here arrive in the
  Instagram or TikTok in-app browser, where `popupUsable()` is false and
  sign-in goes through `goRedirect()`; the answer then comes back on the next
  page load through `getRedirectResult` at `js/auth.js:568`, in a different
  file's lifetime. Both paths need it, or the count is biased towards desktop —
  which is the opposite of this audience.

---

## 6 · Verification

Run the server on a port of your choosing and confirm `/explore` answers first:

```sh
python3 tools/serve-like-pages.py 8899 .
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/explore   # 200
```

Then, all of which passed on the commit this document was written for:

```sh
node   tools/check-analytics.js       # 47 event names, 17 guards, 0 broken
node   tools/check-regressions.js     # 20 regressions guarded, 0 reintroduced
python3 tools/check-structure.py      # 19 pages checked, 0 problems
node   tools/check-account-cache.js   # 12 invariants guarded, 0 broken
cd tools
node   check-page.js "read.html?s=01" ".beat" "Cleopatra"   # PASS
node   check-page.js "explore.html"   ".card"               # PASS
node   check-page.js "story.html"     ".beat" "Cleopatra"   # PASS
```

A parsing check is not a rendering check and neither is a rendering check an
instrumentation check. Everything in §1 marked "verified" was driven in real
Chrome, on this server, with the vendors blocked and `capture()` recorded.
