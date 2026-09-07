# Factbox — measuring the quiz-funnel onboarding

A specification, not an implementation. It says what to fire, what it means,
what can be measured and — where it matters more — what cannot.

Companion documents this one does not repeat: `ANALYTICS.md` (the question-first
audit), `FIREBASE-ANALYTICS.md` (how it is collected, the two sinks, the GA4
rules), `ANALYTICS-API.md` (the query contract), `DASHBOARD.md` (what the admin
page draws and what it refuses to draw).

The flow being measured is roughly twelve screens: a welcome, four or five
questions with branching affirmation interstitials between them, a story-card
pick, a "building your feed" loader, a results screen, account creation, and the
paywall.

---

## 0 · The constraints this design is bent around

**1. Event names are scarce; property values are not.**

This is the constraint that decides the whole shape below, so it is stated first
and with its sources.

* GA4 event names must be ≤ 40 characters, `[a-z0-9_]`, start with a letter, and
  not collide with a reserved name or a reserved prefix. `js/analytics.js`'s
  `gaName()` (line 437) enforces it and `GA_RESERVED` (line 424) lists the
  reserved set. **`page_view` and `screen_view` are on that list** — which is
  exactly why the site's page event is called `page_open` and not `page_view`
  (`js/analytics.js:743-755`). A reserved name is not rejected loudly; GA4 drops
  it or the mapper silently renames it to `fb_page_view` for one sink only, and
  the two sinks then disagree about what the event is called.
* On the **distinct-name cap the repo does not speak with one voice**, and both
  halves bind:
  * `js/analytics.js:695-700` — *"GA4 charges a report against a distinct name
    and an app stream caps them at 500; a name built from a DOM id is an
    unbounded set."*
  * `FIREBASE-ANALYTICS.md:332` — *"GA4 web streams do not carry the app-stream
    cap of 500 distinct event names, and 45 is nowhere near it regardless."*
  * `tools/check-analytics.js:187` ships a guard, **"no event name is built at
    runtime"**, whose stated reason is *"GA4 caps distinct names and reports
    badly long before the cap. One literal name, detail in parameters."* That
    guard fails the build on `track("ob_" + id)`.
  * The cap becomes live rather than theoretical the moment an app stream exists,
    and `FIREBASE-ANALYTICS.md:§5` names *"one property covering the website and
    the iOS app"* as the reason GA4 might be kept at all.
* **The binding constraint today is not 500, it is 50.** GA4 registers **50
  event-scoped custom dimensions and 50 custom metrics per property**, and shows
  *none* of a parameter in any report until it is registered
  (`FIREBASE-ANALYTICS.md:316-322`). `js/analytics.js:709-714` counts the site at
  **28 of 50 already spent**. A new property name costs one of the remaining 22.

  So: cheap to add a screen id as a *value*; expensive to add a new *property
  name*; and a report-breaking mistake to add one event name per screen.

**Therefore: four new event names, twelve screens, screen identity in a
property.** Twelve screens × (show + leave) would have been twenty-four names —
half the app-stream budget, and twenty-four rows in a report nobody can fold.

**2. ES5 only in `/js`.** No `let`, `const`, arrow functions, template literals,
`URLSearchParams`, or `Array.prototype.findIndex`. `ONBOARDING.md:§3`. The
audience is the Instagram and TikTok in-app browsers, which is also why §2 below
is as pessimistic as it is.

**3. HogQL has no `toIntOrNull`.** It is `toInt(toString(properties.x))`, which
returns null on a value it cannot parse — which is the behaviour `toIntOrNull`
was being reached for. `toIntOrNull` rejects the whole query with a 400.
`functions/insights.js:490-495`. Every integer property below is read that way,
and a row whose cast came back NULL is dropped in JS, not in SQL.

**4. Existing dwell is clipped at both ends and the new dwell deliberately is
not.** `js/analytics.js:626` refuses to report a `card_view` under **900 ms** or
over **30 minutes**, and `DASHBOARD.md` item 10 says the consequence out loud:
*"a card somebody swiped past is missing from their list rather than zero"*.

  * **The 30-minute ceiling is inherited.** A screen "open" for longer than that
    is a machine that went to sleep. Over it, `ob_leave` is not sent.
  * **The 900 ms floor is NOT inherited, on purpose.** The affirmation
    interstitials are *designed* to be dismissed in well under a second. A floor
    that deletes every sub-second dismissal deletes the exact measurement the
    owner is asking for. Onboarding dwell has **no floor**; the only requirement
    is that the screen was committed (rendered plus one animation frame), so a
    mount flicker is not a screen view.
  * **Consequence, and it must be printed next to the number:** onboarding dwell
    and `card_view` dwell are measured under different rules and **must never be
    added together or compared**.
  * The clock is **engaged time** — it pauses on `visibilitychange` → hidden and
    resumes on visible, the way `story_time` does (`js/analytics.js:948-959`).
    A phone face-down in a pocket does not report an hour of onboarding.

**5. There is no session in the data.** `DASHBOARD.md` item 11: *"Nothing in
`js/analytics.js` opens or closes one."* A per-person count cannot separate a
reader's first attempt from their third. That is why every event below carries a
`run` id, and why "resumed" is answerable at all.

**6. No `unload` or `beforeunload` listener, anywhere.** Either one disqualifies
every page on this site from the back/forward cache, which `js/gate.js` depends
on, and `tools/check-analytics.js` fails the build if one appears
(`ANALYTICS.md:§2`). The only leave signals available are `pagehide` and
`visibilitychange`. §2 is honest about what that costs.

---

## 1 · The event set

**Four new names.** 47 today (`node tools/check-analytics.js`) → **51**.

| name | chars | fires when |
|---|---|---|
| `ob_step` | 7 | a screen has been committed to the display |
| `ob_answer` | 9 | an answer was chosen on a question screen |
| `ob_leave` | 8 | a screen stopped being displayed, however that happened |
| `ob_done` | 7 | the flow reached its terminus |

All four are legal GA4: lowercase, `[a-z0-9_]`, start with a letter, ≤ 40, not in
`GA_RESERVED`, no `ga_` / `google_` / `firebase_` prefix. `ob_` matches the
`ob-stage` / `.ob` naming the funnel markup already uses (`start.html:72`).

**Three new property names**, costing 3 of the 22 remaining registrations
(28 → 31 of 50): **`run`**, **`kind`**, **`screens`**. Everything else reuses a
name the site already registers — `page`, `step`, `n`, `q`, `answer`, `state`,
`why`, `dwell_ms`, `stack`, `answers`, `from`, `mins`, `days`.

`why` is reused for *why a screen ended*; `state` for *fresh / resumed /
changed*. Both are semantically close enough to their existing use to be
readable in a report, and each one saved is one of twenty-two.

All four events also carry, from `js/analytics.js` itself and free: `has_account`,
`is_subscriber`, `access`, and the Firebase uid once `identify()` has run.

### The screen vocabulary

A closed list. It is a constant in the onboarding script **and** a constant in
`functions/insights.js`, because the funnel's order must come from the source
that renders it and never be inferred from counts — the same rule `JOIN_STEPS`
already follows (`functions/insights.js:1321`, `shape()` case
`onboarding_funnel`): *"an inferred order is right until the day a step gains
traffic from somewhere else, and then it is silently wrong."*

| `step` | `kind` | `n` |
|---|---|---|
| `welcome` | `intro` | 1 |
| `q_draw` | `question` | 2 |
| `affirm_draw` | `affirm` | 3 |
| `q_relate` | `question` | 4 |
| `affirm_relate` | `affirm` | 5 |
| `q_time` | `question` | 6 |
| `q_streak` | `question` | 7 |
| `pick_story` | `pick` | 8 |
| `building` | `loader` | 9 |
| `results` | `results` | 10 |
| `account` | `account` | 11 |
| `paywall` | `paywall` | 12 |

`n` is the screen's **declared position in the flow**, not the count of screens
this reader has seen. Two readers who branch differently still compare.

### `ob_step` — a screen was shown

| property | type | values | notes |
|---|---|---|---|
| `page` | string | `"start"` | `pageName()`, already computed in `analytics.js` |
| `step` | string | `"q_draw"` | from the closed list above |
| `kind` | string | `"question"` | from the closed list above |
| `n` | number | `2` | declared position |
| `run` | string | `"r7k2m9qx"` | this run of the flow — see below |
| `state` | string | `"fresh"` \| `"resume"` | `"resume"` only on the FIRST `ob_step` of a run that reopened an abandoned one |
| `from` | string | `"story"` \| `"start"` \| `"home"` \| `"direct"` | how they arrived; the `?from=` the funnel is already linked with (`start.html`) |

Fires once per screen commit. A reader who goes back to `q_draw` and forward
again produces **two** `ob_step{step:"q_draw"}` in the same `run` — that is a
fact, not a duplicate. Per-screen people counts are `count(DISTINCT person_id)`;
per-screen run counts are `count(DISTINCT run)`; the raw count is `views`. All
three are returned, because they answer different questions and a panel that
picks one silently is a panel that argues with itself.

### `ob_answer` — an answer was chosen

| property | type | values | notes |
|---|---|---|---|
| `page` | string | `"start"` | |
| `step` | string | `"q_draw"` | the screen it was chosen on |
| `n` | number | `2` | |
| `run` | string | `"r7k2m9qx"` | |
| `q` | string | `"draw"` \| `"relates"` \| `"goal"` \| `"streak"` \| `"story"` | the question key |
| `answer` | string | `"people"`, `"notime\|stories"`, `"10"`, `"30"`, `"01"` | **a key or keys from a closed vocabulary, never a label and never typed text** |
| `state` | string | `"first"` \| `"changed"` | `"changed"` when this run already answered this `q` |

**`answer` values are the vocabularies `js/account.js` already owns**, so the
analytics and the stored profile cannot drift: `DRAWS = ["people","turning",
"thread","tiktok"]`, `RELATES = ["notime","unfinished","stories"]`,
`GOALS = [auto,5,10,15,20,45]`, `STREAKS = [7,14,30,50]`
(`js/account.js:513-556`). A multi-select sends the chosen keys sorted and joined
with `|` — the same separator `gaParams()` uses for arrays
(`js/analytics.js:482-486`) — so `"notime|stories"` is one value and one row.
The story pick sends the catalogue id (`"01"`).

**This is the event that makes answers correlatable with conversion**, because
`person_id` on it is the same `person_id` on `checkout_start` and
`access_gained`.

### `ob_leave` — a screen ended, and how

The workhorse. It carries dwell, forward presses and back presses in one event
rather than three names.

| property | type | values | notes |
|---|---|---|---|
| `page` | string | `"start"` | |
| `step` | string | `"affirm_draw"` | the screen being left |
| `kind` | string | `"affirm"` | |
| `n` | number | `3` | |
| `run` | string | `"r7k2m9qx"` | |
| `why` | string | see table below | how the screen ended |
| `dwell_ms` | number | `640` | engaged milliseconds; **no floor**, discarded above 1,800,000 |

| `why` | means | reliability |
|---|---|---|
| `forward` | our Continue / answer control advanced the flow | exact |
| `back` | our rendered Back control, **or** a `popstate` we caught and handled | exact for ours; §2 for `popstate` |
| `skip` | our Skip control | exact |
| `exit_back` | a `popstate` that took the reader out of the flow | best effort, §2 |
| `away` | `pagehide`, or the tab went hidden and never came back | best effort, §2 |

`why` is never guessed. If the screen ends and we do not know why, it is `away`
— and `away` explicitly does **not** mean "abandoned", it means "we stopped
seeing them here".

### `ob_done` — the flow finished

Fires once per run, on committing the terminal screen (`results` for the flow
proper; the funnel's terminus is a product decision and this event names
whichever screen it is).

| property | type | values | notes |
|---|---|---|---|
| `page` | string | `"start"` | |
| `run` | string | `"r7k2m9qx"` | |
| `step` | string | `"results"` | which screen was the terminus |
| `screens` | number | `12` | distinct screens committed in this run |
| `answers` | number | `5` | distinct `q` answered in this run |
| `state` | string | `"fresh"` \| `"resume"` | whether this run resumed an abandoned one |

**No total-time property, on purpose.** The obvious fifth field is "how long the
whole run took", and it is not here: `onboarding_runs` sums `ob_leave.dwell_ms`
per `run` and gets the same number. A derivable figure is not worth one of the
twenty-two remaining GA4 registrations, and it is certainly not worth reusing an
unrelated existing name like `days` to avoid spending one.

### `run` — the identifier, and what it is not

An eight-character random string from `Math.random()`, minted when the funnel
opens, stored in `localStorage` under `fb_ob_run_v1` alongside the furthest
screen reached and a timestamp.

* **Resume** is: the funnel opens, that key exists, its screen is not the
  terminus, and its timestamp is inside 7 days. The reader is offered their
  place back. Whether they accept or restart, a **new** `run` is minted and the
  first `ob_step` carries `state:"resume"`. The old run stays abandoned in the
  data, which is what it was.
* It is **not** a session id, **not** derived from anything about the reader,
  **not** sent to Stripe, and it is cleared with the rest of `fb_*` local state.
* It exists because `DASHBOARD.md` item 11 is true: without it, one person's
  three attempts are one denominator and every drop-off percentage is wrong.
* It is a **new identifier stored in the browser** and therefore a privacy
  disclosure. §6.

### What is deliberately not here

* **No event per screen.** §0.1.
* **No `ob_abandon`.** Abandonment is the absence of `ob_done` for a run, which
  a query computes. An event that fires when somebody leaves is the one event
  that cannot be relied on to fire (§2), so naming a fifth event after it would
  put the least reliable number under the most confident label.
* **No new money events.** The path after onboarding is measured with the events
  that already exist and already have queries and dashboard labels behind them:
  `signup_email`, `join_signup`, `signin_email`, `signin_google`, `join_view`,
  `paywall_view`, `subscribe_click`, `checkout_start`, `checkout_blocked`,
  `access_gained`.
* **Nothing a reader typed.** §6.

### Double-counting: the controls must opt out of `ui_click`

`js/analytics.js`'s delegated listener fires `ui_click` on every tappable
element unless `skipControl()` recognises it (line 804). Back, Continue, Skip
and every answer option fire a named event **unconditionally from the same tap**,
which is precisely the test written down at `js/analytics.js:776-799`, so all of
them must be skipped or every tap is counted twice.

* Answer options already carry `data-k`, which `skipControl()` skips.
* Back / Continue / Skip must carry **`data-fbt="-"`**. This is the `.jn-yn`
  precedent (`ANALYTICS.md:§2`): the `ui_click` on those buttons was both a
  duplicate *and* the useless half of the pair, because it could not say which
  direction the press went. `ob_leave.why` can.

---

## 2 · Back-press capture: what is and is not detectable

Said plainly, because the difference between these two is the difference between
a number and a guess.

### What is trivially exact

**A Back control we render.** A `<button>` in the funnel chrome with a click
handler. It runs our code, so it knows the screen it is leaving, the screen it is
going to, and the elapsed time. `ob_leave{why:"back"}` with a real `dwell_ms`.
There is nothing uncertain about it. **This is the one we should build and the
one the owner should read.**

### What requires history manipulation, and half works

The browser/OS back gesture does not call our code. Catching it means owning the
history stack:

1. On funnel open — **after** `js/gate.js:62` and `js/progress.js:263` have done
   their parse-time `replaceState` — call
   `history.replaceState({fbob:1, i:1}, "")` to tag the entry we are standing on.
2. On each forward advance, `history.pushState({fbob:1, i:n}, "")`.
3. Listen on `popstate`. If `ev.state && ev.state.fbob` and its `i` is lower than
   the current screen, that was a back gesture: render the previous screen and
   fire `ob_leave{why:"back"}`. If the state is not ours, the reader has stepped
   out of the flow entirely: fire `ob_leave{why:"exit_back"}` and let the
   navigation happen — it cannot be prevented and must not be.

**The cost, which is not zero.** One history entry per forward step means a
reader who finishes has twelve entries to traverse to get out. Push **only while
inside the flow**, never on a re-render, and make every screen idempotent so a
back onto `results` re-renders rather than re-runs. `history.pushState` cannot be
undone, so there is no way to collapse the stack on completion; this is the
standard cost of the technique and it is being accepted, not solved.

`js/recommend.js:1087` already listens on `popstate` for the end-card countdown,
so the pattern is in-repo; the onboarding listener must not fight it.

### What will be missed, and will stay missed

* **In-app webview chrome.** Most readers here arrive through the Instagram and
  TikTok browsers (`ONBOARDING.md:§3`). Their back arrow is frequently **not**
  `history.back()` — it dismisses the webview, or reloads the entry URL. No
  `popstate` fires. Best case we get a `pagehide` and record `why:"away"`; worst
  case the webview is torn down and **no beacon leaves at all**.
* **iOS Safari edge-swipe from the flow's first entry.** There is nothing below
  it to pop to, so the reader leaves the site. No `popstate`. `pagehide` fires
  and PostHog's beacon usually survives; **GA4's frequently does not** — the same
  navigation-race that `ANALYTICS.md:§3` documents for `checkout_start`, and for
  the same reason (`gaQueue`). **PostHog is the sink to trust for `ob_leave`.**
* **Backgrounding on iOS.** `pagehide` is not guaranteed. We get the
  `visibilitychange` pause and a dwell that is correct up to that moment, and
  then nothing.
* **Which kind of back it was.** A hardware button, an edge swipe, a browser
  chevron and a trackpad gesture all arrive as one `popstate`. They cannot be
  told apart and the spec does not pretend otherwise.
* **No `beforeunload` rescue.** Forbidden (§0.6). Not negotiable for a marginal
  gain in flush reliability.

### The honest reporting rule

Because of the above, the panel must carry a fourth number beside
forward / back / skip:

> **`unaccounted`** — runs whose furthest screen has no `ob_leave` of any kind.

That is the size of the blind spot, printed rather than absorbed into "away". A
back-press count reported without it would be "back presses we managed to catch"
labelled "back presses", and on this audience the gap is large enough to change
a decision.

---

## 3 · The funnel definition

Ordered steps, each with the exact event + property predicate that defines it, so
a drop-off chart is a computation and not a judgement call.

**Counting unit.** Steps 1–12 are counted **both** by `count(DISTINCT run)` (the
honest denominator for "how far does an attempt get") and by
`count(DISTINCT person_id)` (the honest denominator for "how many people"). Steps
13 onward are people only — a run id does not survive the trip to Stripe. Both
are returned; the panel labels which it is drawing.

| # | Step | Predicate |
|---|---|---|
| 1 | Onboarding opened | `ob_step` AND `step = 'welcome'` |
| 2 | First question shown | `ob_step` AND `step = 'q_draw'` |
| 3 | First question answered | `ob_answer` AND `q = 'draw'` |
| 4 | Second question answered | `ob_answer` AND `q = 'relates'` |
| 5 | Third question answered | `ob_answer` AND `q = 'goal'` |
| 6 | Fourth question answered | `ob_answer` AND `q = 'streak'` |
| 7 | Story pick shown | `ob_step` AND `step = 'pick_story'` |
| 8 | Story picked | `ob_answer` AND `q = 'story'` |
| 9 | Loader shown | `ob_step` AND `step = 'building'` |
| 10 | Results shown | `ob_step` AND `step = 'results'` |
| 11 | Onboarding completed | `ob_done` |
| 12 | Account screen shown | `ob_step` AND `step = 'account'` |
| 13 | **Reached login** | `ob_step` AND `step = 'account'`, **or** `join_view` — either surface counts, and the query returns them split |
| 14 | Signed in or signed up | `event IN ('signin_email','signin_google','signup_email','join_signup')` |
| 15 | **Account created** | `event IN ('signup_email','join_signup')` — **undercounted**, see below |
| 16 | **Reached paywall** | `ob_step` AND `step = 'paywall'`, **or** `paywall_view`, **or** `join_view` |
| 17 | Plan chosen | `subscribe_click` OR `join_plan_pick` |
| 18 | **Started checkout** | `checkout_start` |
| 19 | Returned with access | `access_gained` AND `properties.from = 'stripe'` |
| 20 | **Paid** | **not an event.** `subscription_totals` / the Stripe webhook record |
| 21 | **Returned later** | `count(DISTINCT toDate(timestamp)) > 1` over any event in the window |

**A leak, not a step:** `checkout_blocked`, counted separately and never placed in
the chain — the `subscribe_funnel` precedent (`functions/insights.js` `shape()`),
where a refused checkout is deliberately kept out of the ladder so it is not read
as an abandoned one.

Five things about this ladder that must be printed under it, not assumed:

* **Step 15 is undercounted by every account created with Google.**
  `login.html:597` fires `signin_google` for a new account and a returning one
  alike. `ANALYTICS.md:§4` item 2 and `firststory_funnel`'s own comment both say
  so; the one-line fix (`getAdditionalUserInfo(cred).isNewUser`) is held in
  `js/auth.js`. Until it lands, step 14 is the trustworthy line and step 15 is
  context.
* **Step 20 is the only authoritative payment number**, and it does not come from
  the browser. `ANALYTICS.md:§3`: everything between `checkout_start` and
  `access_gained` is on Stripe's origin and is dark. `checkout_start` with no
  `access_gained` is **"started checkout, no return seen in this browser"** — the
  union of never-arrived, arrived-and-left, declined, closed-the-tab, and paid on
  a phone but came back on a laptop. It is not an abandonment rate and must not
  be drawn as one.
* **Step 21's rule is a definition, not an observation.** More than one calendar
  day (UTC) with any event inside the window. Identical to `firststory_funnel`'s,
  deliberately, so the two panels agree. `DASHBOARD.md` item 8.
* **Steps 13–21 use `person_id`, so they cross runs.** A person who ran the
  funnel twice and paid once contributes one to step 20 and two to step 1.
* **The window truncates the tail.** Somebody who answered on day 1 of a 14-day
  window and paid on day 20 is counted at step 3 and not at step 20. Widening the
  window moves the number; the panel states the window it answered about.

---

## 4 · New insights queries

Four, following the conventions in `functions/insights.js`: each is
`{ sql, columns }` built from already-validated params, every one carries a
`timestamp >=` floor and a `LIMIT`, every integer read via
`toInt(toString(properties.x))`, `notAdmins(p)` appended to every WHERE.

**Names must not collide with what is already there.** `onboarding_funnel` and
its short alias `onboarding` are **taken** by `/join`'s five panes
(`functions/insights.js:748`, `ANALYTICS-API.md:§3`, `js/dashboard.js:1590`) and
must be left alone while `/join` still fires `join_step`.

`ob_step`, `ob_answer`, `ob_leave` and `ob_done` must also be added to
**`KNOWN_EVENTS`** (`functions/insights.js:466`) and to its copy in
`js/dashboard.js:78-88`, or `event_volume` refuses the names; and to
`EVENT_LABELS` (`js/dashboard.js:~2980`) or the timeline prints raw ids.

### `onboarding_steps` — per-screen drop-off, dwell and direction

* **params** `["exclude_admins", "days"]` (plus the shared `from`/`to`)
* **bounds** `days` 1–90, default 14, no per-query ceiling. `LIMIT 60` fixed —
  the screen set is closed and twelve long, and a caller cannot widen it. Same
  shape as `onboarding_funnel`'s fixed `LIMIT 60`.
* **grouping** `GROUP BY step, kind`

Rows from upstream:

| column | type | notes |
|---|---|---|
| `step` | string | |
| `kind` | string | |
| `views` | int | raw `ob_step` count |
| `runs` | int | `count(DISTINCT toString(properties.run))` |
| `people` | int | `count(DISTINCT person_id)` |
| `forwards` | int | `countIf(event='ob_leave' AND why='forward')` |
| `backs` | int | `why IN ('back')` |
| `skips` | int | `why = 'skip'` |
| `exits` | int | `why IN ('exit_back','away')` |
| `dwell_s` | float | `sum(dwell_ms)/1000` |
| `dwell_s_capped` | float | each view clipped to `DWELL_CAP_S` (180) first — the `reader_dwell` convention (`functions/insights.js:230-247`), because a mean is never returned and a raw sum can be owned by one abandoned tab |
| `median_dwell_s` | float | |

Added by `shape()`, not by SQL:

| column | notes |
|---|---|
| `label` | human label, from the `OB_STEPS` constant beside the query |
| `order` | declared position — **rows are sorted by this, never by counts** |
| `reach_pct` | against the first declared step's `people` |
| `dropoff_pct` | against the previous declared step's `people` |
| `never_fired` | `true` for a declared step with no upstream row |
| `unaccounted` | `views - (forwards+backs+skips+exits)`, floored at 0 — §2 |

`never_fired` is the point of declaring the step list server-side: a screen that
has never been instrumented and a screen nobody reached are the same zero
upstream and completely different findings.

### `onboarding_conversion` — the end-to-end ladder

* **params** `["exclude_admins", "days"]`
* **bounds** `days` 1–90, default 14. `LIMIT 1` — one aggregate row.
* Mirrors `subscribe_funnel` exactly: one wide upstream row of
  `count(DISTINCT if(<predicate>, person_id, NULL))` columns, expanded by
  `shape()` into a labelled ladder from an `OB_FUNNEL_STEPS` constant.

Upstream columns: `opened`, `q1_shown`, `q1_answered`, `q2_answered`,
`q3_answered`, `q4_answered`, `pick_shown`, `picked`, `loader`, `results`,
`finished`, `account_screen`, `reached_login`, `signed_any`, `account_created`,
`reached_paywall`, `plan_picked`, `stripe`, `came_back`, `subscribed`,
`returned_later`, `blocked`.

Rows after `shape()`:

```
{ step: "reached_paywall", label: "Reached the paywall",
  people: 4, pct_of_first: 12.9, pct_of_previous: 80.0 }
```

with a final non-step row `{ step:"blocked", label:"Blocked before Stripe",
people: n, pct_of_first: n, pct_of_previous: null }` — `pct_of_previous` is
`null` because it is a leak and not a rung, which is how `subscribe_funnel`
already does it.

### `onboarding_answers` — which answers, and whether they converted

* **params** `["exclude_admins", "days", "limit"]`
* **bounds** `days` 1–90 default 14; `limit` 1–200 default 50 (the standard
  clamp). Roster bound `ANSWER_ROWS_MAX = 2000` on the first upstream query.
* **two upstream queries**, the `reader_dwell` / `person_timeline` pattern
  (`functions/insights.js:1251`, and the two-query rate accounting at line 2824):
  1. `(person_id, q, answer)` triples from `ob_answer`, `LIMIT 2000`.
  2. `(person_id, finished, account, stripe, subscribed)` per person over the
     outcome events, `LIMIT 400`.
  Joined in JS on `person_id`. `meta.truncated` when either hit its bound.

Rows:

| column | type | notes |
|---|---|---|
| `q` | string | |
| `answer` | string | closed-vocabulary key(s) |
| `people` | int | |
| `runs` | int | |
| `finished` | int | also produced `ob_done` |
| `finished_pct` | float | |
| `accounts` | int | |
| `subscribed` | int | |
| `subscribed_pct` | float | |

Stated beside it: the outcome columns count **inside this window only**; someone
who answered on day 1 and paid on day 20 of a 14-day window is `subscribed: 0`
here and is not a lost sale. At the current traffic these percentages are
descriptive, never predictive, and the panel must not offer them as a reason to
change a question.

### `onboarding_runs` — abandonment and resume

* **params** `["exclude_admins", "days"]`
* **bounds** `days` 1–90 default 14. Upstream `LIMIT RUN_ROWS_MAX = 1000` run
  rows; bucketing happens in `shape()`, not in SQL — a HogQL subquery is an
  untested construct here and `functions/insights.js:1206` is explicit that an
  untested construct takes the whole panel down rather than one row of it.
* **grouping** `GROUP BY toString(properties.run)`, returning per run:
  `person_id`, `screens`, `furthest_n`, `resumed`, `finished`, `total_s`.

Rows after `shape()`:

| column | type | values |
|---|---|---|
| `bucket` | string | `finished_first_run` \| `finished_after_resume` \| `abandoned_once` \| `abandoned_and_restarted` |
| `label` | string | |
| `runs` | int | |
| `people` | int | |
| `median_screens` | float | |
| `median_furthest_n` | float | |
| `median_total_s` | float | |

`meta.truncated` when 1000 runs were not enough.

### `meta` keys these queries add

Following the precedent that three queries already add keys of their own
(`ANALYTICS-API.md:§2`), and the `geo_usable` precedent that **the function
decides usability and the page obeys**:

| key | on | means |
|---|---|---|
| `pct_usable` | `onboarding_steps`, `onboarding_conversion` | false when the first declared step has fewer than `PCT_MIN_PEOPLE` (20) people. The page suppresses every percentage in the panel when it is false. |
| `first_people` | both | the denominator, so the page can name it in its sentence without recomputing |
| `truncated` | `onboarding_answers`, `onboarding_runs` | a row bound was hit |

Nothing branches on their absence.

### Rate-limit arithmetic

`PER_ADMIN_PER_MIN = 60` (`functions/insights.js:176`), and a full render is
currently fourteen requests. Adding these four — one of which makes two upstream
calls — puts a full render at **nineteen upstream queries**, so roughly **three
full refreshes a minute** before an admin locks themselves out of their own
numbers. That is still headroom, but it is worth stating before a fifth panel is
added: the cap was already raised once from 30 for this reason.

---

## 5 · The dashboard panel

### How it is wired, following the existing convention

There is no panel registry in `js/dashboard.js` — a panel is four things done by
hand, and the new one is built the same way:

1. **Markup** in `admin/dashboard.html`: a `<section class="dsh-sec"
   id="dsh-sec-obquiz">` with a `sechead` (h2 + span), a `<p class="dsh-q">`
   blurb, a `<div class="dsh-state" id="dsh-obq-state" role="status">`, and
   `dsh-kpis` / `dsh-scroll > dsh-chart` / `dsh-scroll > table.dsh-tbl` /
   `p.dsh-note`, all `hidden`. Asset hrefs stay root-absolute.
2. **A body-id array** at module scope:
   `var OBQ_BODY = ["dsh-obq-kpis", "dsh-obq-chartbox", "dsh-obq-tblbox", "dsh-obq-convbox"];`
3. **`function runObQuiz(win)`** — `stateOf(...,"Loading…",false)` → `bodyOf(OBQ_BODY,false)`
   → `dropChart(...)` → `ask(name, { from: win.from, to: win.to }, cb)`. `ask()`
   adds `exclude_admins` itself; the caller never passes it.
4. **One line added to `runAll()`**, placed after `runOnboarding(win)` so the two
   onboarding panels read together. The request queue is two deep.

Primitives it uses, all existing: `funnelSVG(w, steps, title)` with
`steps: [{label, value}]`, `drawTable(id, rows, {prefer, nameCol})`,
`kpi(n, l)` / `setKpis`, `noteOn(id, text, extra)`, `disclosure(summary, pairs)`,
`metaSay(res, "screens")`, `failed(...)`.

**This page loads no `js/analytics.js` and must not start.** *"A dashboard that
measures its own use answers a different question every time you look at it."*
No event name in this spec exists because of this page.

**`ob_step`, `ob_answer`, `ob_leave` and `ob_done` must be added to
`KNOWN_EVENTS` in `functions/insights.js:466` FIRST, then to its hand-copied
mirror in `js/dashboard.js:78-88`**, and to `EVENT_LABELS` (`js/dashboard.js`
~2980) or `person_timeline` prints raw ids. The mirror's own comment states the
order.

### The four blocks

1. **KPI tiles** — Opened · Finished the flow · Reached login · Reached the
   paywall · Started checkout · Paid. **Counts, always. Never a percentage in a
   tile.**
2. **Screen ladder** — `funnelSVG` over `onboarding_steps`, one bar per declared
   screen in declared order.
3. **Screen table** — `drawTable` with
   `prefer: ["label","kind","people","runs","views","median_dwell_s","forwards","backs","skips","exits","unaccounted"]`,
   `nameCol: "label"`.
4. **Conversion ladder** — a second `funnelSVG` over `onboarding_conversion`,
   with the `onboarding_answers` table below it.

### What it must do when the data is thin

This product has almost no real users. A funnel chart with n=3 that reads like a
trend is the likeliest way this panel misleads its only reader.

**The decision is made server-side and the page obeys it.** There is no
minimum-n constant anywhere in `js/dashboard.js` today, and the repo's existing
answer to exactly this problem is `geo_breakdown`'s `meta.geo_usable`
(`functions/insights.js:2276`), which the page follows rather than second-guessing
from the rows:

> *"THE FUNCTION ITSELF SAYS WHETHER THIS IS USABLE, and this panel obeys it
> rather than second-guessing it from the rows."*

So: **`onboarding_steps` and `onboarding_conversion` return `meta.pct_usable`**,
false when the first declared step has fewer than **20 people**. The threshold is
a constant in `functions/insights.js` (`PCT_MIN_PEOPLE = 20`) beside the queries,
not in the page.

* **`pct_usable: false` → percentages are suppressed everywhere in this panel** —
  bars, tiles and tables. `funnelSVG` gains a fourth argument, `showPct`; when
  false it prints the count alone. Today it always appends `" · " + pct + "%"`
  (`js/dashboard.js:1010-1011`), and its between-row drop line
  (`"↓ 4 lost here — 33.3% of the step above"`) drops its percentage clause too.
* **The bars still draw.** A proportion of seven is an honest picture of seven.
  This is deliberately weaker than the geo panel, which draws nothing — geo's
  problem is that one bar at 100% is indistinguishable from a broken proxy, and
  this panel has no such ambiguity.
* **One visible sentence, and the rest inside `disclosure()`.** The state line
  reads: *"Counts only — 7 people reached the first screen. A percentage of 7 is
  a sentence about 7 people."* Everything else about small numbers goes in the
  `<details>` block, because *"454 words under a chart is how the funnel's
  caveats got collapsed once already, and a caveat nobody finishes reading is not
  a caveat."*
* **No line chart, no area chart, no sparkline, at any n.** Drop-off over time is
  not offered here: *"a line chart with an unlabelled axis says 'it went down'
  and nothing else."*
* **`n = 1` draws nothing** and says so. One person's path is a
  `person_timeline`; the panel points there rather than drawing a one-person
  funnel that reads as a rate.

### What it must do when a step has never fired

**This is new behaviour in both files.** `onboarding_funnel` today groups by the
`properties.step` values it observed, so a step nobody reached returns no row and
**silently vanishes from the chart and the table** — the funnel narrows instead
of showing a zero. `JOIN_STEPS` exists server-side for ordering only; there is no
zero-fill convention anywhere to hang this on. That gap is why `OB_STEPS` is
declared server-side and why `shape()` zero-fills.

* **`never_fired: true`** → the row renders with an em-dash, in the muted style,
  labelled **"not seen in this window"**. Never `0`. Never `0%`. A zero implies a
  measurement was taken.
* **`never_fired: true` on a step that has a LATER step with rows** → an explicit
  line: *"No `ob_step` with `step="pick_story"` arrived, but later screens did.
  That screen is probably not instrumented — check the funnel script before
  reading this as a drop-off."* At this traffic that is the most useful sentence
  the panel can print, and it costs one comparison.
* **A step that is a leak rather than a rung** — `blocked` — carries
  `pct_of_previous: null`, which the page already reads generically to keep a row
  out of the funnel and in the table (`js/dashboard.js:2036`, the
  `firststory_funnel` case). No new convention needed.
* **No rows at all** → reuse the existing sentence verbatim so the two onboarding
  panels read the same, and follow the house pattern of saying whether zero is
  the *right* answer: *"Nobody started the opening questions in this window. If
  the flow is not linked from anywhere yet, that is the right answer; if it is,
  widen the range."*
* **Admin switch on and nothing left** → the `runReaders` two-branch pattern:
  *"Nobody outside the admin accounts started the opening questions in this
  window. Switch "Admin accounts" to Included above to see your own."*
* **`unaccounted > 0`** → always shown, labelled **"Left without us seeing how"**,
  with §2's one-line reason beside it. Never folded into `exits`.
* **`meta.truncated`** → appended to the state line, the existing wording:
  *"The per-person scan hit its cap, so this is a sample of the window rather
  than all of it — narrow the dates."*
* **Error codes** inherit the existing table unchanged. A `bad_query` here is *a
  state, not a fault* — the panel sends nothing but a date window and the admin
  flag, so a refusal is the function refusing the query **name**: the queries are
  written but not deployed. Same copy shape as `reader_dwell`'s.
* **Dwell columns carry their own caveat line**, because they are measured under
  different rules from every other dwell number on the page: *"Onboarding screen
  time has no minimum, unlike card time, which ignores anything under 900ms. The
  two are not comparable."* (§0.4.)

---

## 6 · Privacy delta

`privacy.html` §05 publishes the complete list of event names and what each one
carries. Its closing paragraph — *"None of these carries your email address, your
name, or anything you typed into a box"* — must stay true, and it does under this
spec.

### Free text: the audit

Checked against every property proposed above.

* **Nothing here captures reader-typed text.** `answer` is a key from a closed
  vocabulary that `js/account.js` already owns (`DRAWS`, `RELATES`, `GOALS`,
  `STREAKS`, plus a catalogue story id). `step`, `kind`, `why` and `state` are
  literals from lists in this document. `run` is machine-generated. `n`,
  `screens`, `answers` and `dwell_ms` are integers.
* **⚠ Flagged, and it is the only real risk in the design:** if any question
  gains an **"Other — tell us"** free-text field, or if the account screen's
  email is ever put on an event, this breaks. **The rule: send `answer:"other"`
  and nothing else.** `tools/check-analytics.js:426-445` already fails the build
  on `.value`, `password`, `email:` or `name:` inside a `track()` / `capture()`
  call — that guard is the enforcement, and it should be extended with the
  onboarding call sites in the same commit.
* The **account screen** carries email and password inputs. No event named here
  touches them, and `js/analytics.js`'s delegated `ui_click` listener already
  *"never reads `value`, never reads an `<input>`/`<textarea>`/`<select>`"*
  (line 764). The email that a signed-in reader gives goes to the Firestore
  mirror at `customers/{uid}/profile/onboarding`, which is a **separate system
  from analytics** and is already disclosed by `FIREBASE-ANALYTICS.md:§7`. The
  two must not be conflated in the policy.

### Fields that must be newly disclosed

| new thing | where it goes |
|---|---|
| four new event names | the §05 event list |
| screen name, screen position, screen kind | in those `<li>`s |
| the answer key chosen, and whether it was changed | in those `<li>`s |
| direction of travel (forward / back / skip / left) | in those `<li>`s |
| **time on each onboarding screen, with no minimum** | in those `<li>`s, said explicitly, because the `card_view` entry currently promises a one-second floor and a reader would reasonably read that as covering the whole site |
| **a third identifier stored in the browser** (`fb_ob_run_v1`) | the "Both services also keep an identifier of their own in your browser" paragraph |

### Draft copy

**(a) Four new `<li>`s**, to go in the §05 `<ul>` immediately after the
`join_*` item:

```html
<li><code>ob_step</code> — a screen of the opening questions was shown, carrying the screen's name, its number in the sequence, what kind of screen it is (a question, an interstitial, the loader, the results), and whether you were picking up an unfinished run.</li>
<li><code>ob_answer</code> — you chose an answer, carrying which question it was and <strong>which of the fixed options you picked</strong>, as a short key like <code>people</code> or <code>notime|stories</code>. These are the options printed on the screen, written in our own repository. There is no text box in these questions, and nothing you type anywhere on the site is in this event.</li>
<li><code>ob_leave</code> — a screen ended, carrying its name and <strong>how many milliseconds it was on your display</strong>, along with how it ended: you pressed Continue, you pressed Back, you skipped it, or you went away. <strong>Unlike card time, there is no minimum here</strong> — a screen you dismissed in a fifth of a second is recorded as a fifth of a second, because how fast people move through these screens is the thing we are trying to see. Anything over thirty minutes is treated as a device that went to sleep and is not sent.</li>
<li><code>ob_done</code> — you reached the end of the opening questions, carrying how many screens you saw, how many questions you answered, and whether this run had been picked up from an earlier one.</li>
```

**(b) One sentence into the "identifier of their own in your browser"
paragraph**, after the existing two:

```html
<p>The opening questions also keep <strong>a short random code of their own in
   this browser</strong>, so that one run through them can be told from another
   and we can see where people stop. It is generated by your browser, it is not
   derived from anything about you, it is never sent to Stripe or to anyone
   else, and clearing this site's data removes it.</p>
```

**(c) One clause into the existing `card_view` `<li>`**, so the one-second floor
is not read as a site-wide promise. Change:

> Anything under a second is treated as a swipe passing through and is not sent.

to:

> Anything under a second is treated as a swipe passing through and is not sent.
> (This applies to story cards. The opening questions are measured with no
> minimum — see <code>ob_leave</code> above.)

**(d) The dashboard-visibility paragraphs at the end of §05** describe three
views that name readers by email address. The onboarding data joins those views
through `person_timeline`, which shows *"the buttons they pressed by name"* — so
one reader's answers will be visible to an administrator beside their email
address. The existing text already covers it in shape, but the third paragraph's
*"it shows nothing that is not already in the list of events above"* only stays
true once (a) has landed. **Land (a) and the timeline change in the same
deploy.**

**(e) §07 must stay consistent.** §07 already publishes the *exhaustive* list of
what `customers/{uid}/profile/onboarding` may hold — *"the whole of what that
document may contain is fixed in our database rules, and it is this and nothing
else"* — and that list is enforced by the `hasOnly([...])` clause in
`firestore.rules` (`FIREBASE-ANALYTICS.md:§2`). **If the new flow stores an
answer that is not already in that list, three things change in one commit: the
rules key list, §07's sentence, and `js/profile-sync.js`.** The story-card pick
is the likely one — there is no field for it today. Not an analytics change, but
it will be missed if it is not written down here.

**What does NOT need new copy: retention.** `privacy.html` states no retention
period for analytics anywhere, and this spec does not create one. §11's deletion
bullet — *"the off switch in §05 stops future events… write to us; we can ask
both to delete the records tied to a user id"* — already covers the new events
unamended, because they are tied to the same user id. The opt-out in §05 covers
them for the same reason: it stops both scripts loading at all, so there is no
per-event exception to write.

### Three things to correct while in there

1. **`ONBOARDING.md`'s "Known and outstanding" says *"`privacy.html` §04 still
   lists `start_step`, `start_answer`, `start_abandon` and `start_ready`"*. It
   does not.** None of the four appears in `privacy.html` at all; they survive
   only in `ONBOARDING.md`, `LEGAL.md`, `tools/check-analytics.js` and one
   comment in `js/analytics.js`. Strike the note, so nobody removes something
   already gone — or worse, trusts the rest of that list by association.
2. **The section number moved.** `ANALYTICS.md:§5` and `FIREBASE-ANALYTICS.md:§7`
   both send the reader to `privacy.html` **§04** for the event list. §04 is now
   *"Signing in"*; the event list is **§05 · Analytics**. Two hand-over
   instructions point at the wrong section, and one of them ("§04 — two lines to
   change") reads as already applied when it is not.
3. **`LEGAL.md:229`** still frames the answer-key promise against the retired
   `start_answer` name. The promise itself — answers are disclosed as *keys*,
   never free text — is the one this spec leans on, and it is worth restating
   under the `ob_answer` name in the same pass.

---

## 7 · Verification, before this is believed

Nothing above is measured until it has been driven. The bar this repo already
sets (`ANALYTICS.md:§6`): a parsing check is not a rendering check and neither is
an instrumentation check.

```sh
python3 tools/serve-like-pages.py 8899 .
node    tools/check-analytics.js      # expect 51 event names, 19+ guards, 0 broken
node    tools/check-regressions.js
python3 tools/check-structure.py
```

New guards to add to `tools/check-analytics.js`, each mutation-tested — break the
thing on purpose and confirm the check fails, because *"a guard that has never
failed is a guard nobody knows works"*:

1. The four onboarding names are literals, never built from a variable (the
   existing runtime-name guard covers this; confirm it sees the new file).
2. Back, Continue and Skip carry `data-fbt="-"`, so no tap is counted twice.
3. `ob_leave` has no lower dwell bound and does have the 30-minute upper one.
4. No `ob_*` call site passes `.value`, `email:` or `name:` (extend the existing
   typed-text guard's file list).
5. The screen list in the funnel script and `OB_STEPS` in
   `functions/insights.js` are the same list in the same order.
6. No `unload` / `beforeunload` listener was added (the existing guard covers the
   site; confirm the new file is in `ALL`).

Then, in real Chrome on a real phone profile, with the vendors blocked and
`capture()` recorded: walk the flow forwards, walk it backwards with the rendered
Back control, walk it backwards with the browser gesture, background the tab
mid-screen and return, abandon it and resume it a day later. **Every number in §2
comes from that walk or it does not get printed.**

Do **not** name the engine `js/start.js`. `tools/check-analytics.js:154` guards
that *"the retired onboarding is retired in one piece"* and fails if that file
returns without `/join`'s old question screens, or vice versa.
