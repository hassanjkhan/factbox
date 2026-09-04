# Accounts, onboarding and the price ladder

`join.html` · `js/account.js` (`FBA`) · `css/account.css`, plus the
`checkout()` area of `js/gate.js`.

Sections 1-9 are the **funnel**: what `/join` asks, what `FBA` stores and where
the prices live. Section 10 is the **two account screens** — `/account` and
`/settings` — which share `css/account.css` with the funnel and share nothing
else with it.

---

## 1. What the funnel is, and where it came from

The site used to ask for money first. A locked cover or the end of a story
showed one button — *Read all 51 stories · $3.99/mo* — wired to a single
Stripe Payment Link. The reader had told us nothing, we had told them nothing,
and the first thing we did was ask for a card.

Then it asked the wrong questions. The web funnel's step 2 was *"What are you
here for?"* over eight topic tiles, which is a content-taxonomy question
dressed up as an onboarding one. **The iOS app does not ask that.** It asks
about the reader's relationship with reading, learning and history — what
pulls them to it, what has gone wrong before, how much time they actually
have, and how long they will keep going — and it is written in the product's
voice and already tested by the founders.

So the web funnel is now a **port of that flow**, not a second opinion:

```
locked story / end of story / Explore buy bar
      │  FB.checkout()
      ▼
join.html
   1  what draws you to history      ← skippable   OnboardingDrawStep
   ·  the echo (their answer, back)                OnboardingPraiseStep
   2  sound familiar?                ← skippable   OnboardingRelateStep
   3  how much time do you have      ← skippable   OnboardingTimeStep
   4  how long will you stick        7 preselected OnboardingStreakStep
   5  your email (+ optional name)   ← or "log in" OnboardingNameStep's slot
   ·  building your plan                           OnboardingPlanLoaderStep
   6  pick a plan, 3-day trial
      │  FBA.checkoutURL(plan)
      ▼
Stripe Payment Link (one per plan, trial configured in Stripe)
      │  success URL
      ▼
stories.html?unlocked=1&session_id=…   → gate.js claim() → progress.js mints
                                          the restore link
```

Six numbered steps, two interstitials, money last.

### Why it is shaped like this

Four things carry the funnel, and all four are in the iOS flow already:

1. **The easy ask first.** Step 1 is one tap and no typing. Email moved from
   first to fifth, because the flow has to earn the address before it asks.
2. **The echo.** A whole screen that asks nothing: it repeats the answer back
   and then names what that answer just bought (`praiseTitle`, `praiseBody`,
   `praiseBenefit` in `OnboardingModel.swift`). Reinforcement is what makes
   people finish a funnel.
3. **The reinforcement lag.** Every answer is echoed *one step later*, not on
   the screen it was given — the daily goal on the streak screen, the streak
   on the loader, both on the plan screen. Seeing your own answer pay off on
   a screen you did not expect it on is the whole trick.
4. **The commitment, then the plan built in front of you.** The streak
   question is a promise; the loader then shows work being done using the
   answers just given. Both loader answers lead to the same place — the
   questions are theatre, and the iOS file says so — but it is the beat that
   converts, so it is ported rather than skipped.

The promise underneath every screen is one thing, and it is the app's own:
**five minutes a day, one story, and you actually remember it.**

### The copy is the app's copy

Question and answer wording is lifted from
`Sources/Chronicle/Features/Onboarding`. Where the phone app named its mascot
or an era it has and the web does not, the line is re-pointed at the season
rather than reinvented. The tables live in `join.html` next to the step that
shows them; the **answer vocabularies** live in `js/account.js`, which clamps
whatever it is handed to them, so a second surface cannot invent a fifth
answer.

### What is deliberately NOT ported

| iOS step | Why not |
|---|---|
| `welcome` carousel | The page the reader arrived from is the value story. A carousel before the first question is a second one. |
| `compare` (book vs a day of Factbox) | It is the strongest screen in the iOS funnel, but it belongs on the landing surfaces, not inside a six-step form. Not this file's to add. |
| `era` (pick your era → the mascot puts that hat on) | The payoff is Pip changing costume. There is no Pip on the web and no era model in `stacks.json`; a hatless era picker is a taxonomy question, which is exactly what was just removed. The draw answer names the loader's first phase instead. |
| `reminder` (time picker + notification pre-prompt) | Nothing here sends notifications or email. Asking when to nudge someone would be collecting an answer against a promise that is not kept. |
| `sources` and `trial` screens | `credits.html` and the plan screen's own terms already carry both, on the screens where they are actually load-bearing. |
| `allSet` confetti receipt | The plan screen's recap line does the receipt's job one screen earlier, where it is still deciding something. A celebration before payment celebrates nothing. |
| `name` as its own screen | Folded into the email step as an optional field, and used on the very next screen — the loader greets by it — so typing it visibly did something. |

## 2. Sign-up, log-in, and what each can honestly do

There is no backend. "Sign up" means **this browser now remembers your email
and your answers**, and there is deliberately no credential field, because a
credential implies a check nothing here can perform.

So "log in" can honestly do exactly two things:

1. If this browser already holds access, open the stories.
2. Take a pasted **restore link** and use it — which works because the token
   *is* the access. See `js/progress.js` on why that is inherent here rather
   than a bug.

Anything beyond that is routed to `support.html`.

**How that reaches the reader is a separate question, and the answer is: it
mostly does not.** `join.html` is written in the product's voice and never
narrates our hosting model. The old copy — a paragraph on the first screen
explaining that there is nobody to check a credential against — was immersion
paid out for nothing, and it is gone. It has not been replaced by a different
apology. The rule, also stated at the top of `js/account.js`:

- Never claim something untrue. No "check your inbox", no "syncs across your
  devices", no reminder times we will not honour.
- Where a reader has to *act*, say it about **them**: "This browser will not
  remember you", "Coming from another phone? Your restore link is below."
- Where they do not have to act, say nothing at all.

## 3. `FBA` — the API surface

Load order: `progress.js` → `gate.js` → `account.js`. `FBA` requires neither
of the other two and never redefines them; every consumer must guard
`window.FBA` before use.

### Who

| Call | Returns | Notes |
|---|---|---|
| `FBA.signUp(email, firstName)` | `true` / `false` | `false` only means "that is not shaped like an email". Lower-cases and trims. `firstName` optional. |
| `FBA.has()` | boolean | Is an email stored in this browser. |
| `FBA.knows(email)` | boolean | Is *that* the stored email. The honest core of "log in"; it cannot look anyone up. |
| `FBA.email()` | string, `""` if none | |
| `FBA.name()` | string, `""` if none | |
| `FBA.accountId()` | string | Minted on first use. Alphanumerics/dash/underscore, ≤24 chars. Sent to Stripe as `client_reference_id`. Not a secret. |
| `FBA.validEmail(s)` | boolean | Deliberately loose — see the comment in the file. |
| `FBA.get()` | full snapshot, see below | A copy, not the record. |
| `FBA.forget()` | boolean | Clears the key and the cookie mirror. |

### The ported onboarding answers

Every setter clamps to its vocabulary and returns `false` on anything else.
Passing an empty value clears the answer, which is what Skip does — **a
skipped step must be indistinguishable from one never reached**, or the plan
screen reads back something the reader never said.

| Call | Returns | Vocabulary | From |
|---|---|---|---|
| `FBA.draw()` / `FBA.setDraw(k)` | `""` \| `people` \| `turning` \| `thread` \| `tiktok` | `FBA.DRAWS` | `enum HistoryDraw` (`people`, `turningPoints`, `howWeGotHere`, `tiktok`) |
| `FBA.relates()` / `FBA.setRelates(arr)` | array of `notime` \| `unfinished` \| `stories` | `FBA.RELATES` | `enum RelatableStatement` |
| `FBA.goal()` / `FBA.setGoal(n)` | `0` \| `5` \| `10` \| `20` \| `45` | `FBA.GOALS` | `enum DailyGoal`; `45` is "as long as it takes"; `0` is unanswered |
| `FBA.streak()` / `FBA.setStreak(n)` | `0` \| `7` \| `14` \| `30` \| `50` | `FBA.STREAKS` | `enum StreakCommitment` |
| `FBA.planAnswers()` / `FBA.addPlanAnswer(bool)` | array of `1`/`0`, max 3 | — | `OnboardingPlanLoaderStep`'s three yes/nos |
| `FBA.onboarded()` / `FBA.finishOnboarding()` | boolean | — | set when the loader finishes or is skipped past |

`0` from `goal()` and `streak()` means **unanswered**, and is not the same as
the default the UI names out loud. The plan screen only prints a recap once
something was actually answered.

### Legacy, still defined — do not delete to tidy up

| Call | Returns | |
|---|---|---|
| `FBA.interests()` / `FBA.setInterests(arr)` | array of `data/stacks.json` `topic` keys | The old topic-tile question. **The funnel no longer sets this**, because the iOS flow does not ask it. The accessors stay defined and keep parsing anything already stored, so `explore.js` / `recommend.js` and anything else reading them keep a working call and an empty array rather than a `TypeError`. |
| `FBA.frequency()` / `FBA.setFrequency(k)` | `""` \| `daily` \| `few` \| `weekly` \| `binge` | Same story. `FBA.goal()` is the question that replaced it, and it is not the same question — one is a cadence, the other is minutes per sitting. Do not silently map one onto the other. |

If a shelf-ordering feature wants a signal, `draw()` is the honest one to
reach for now. Until something consumes an answer, **the onboarding copy must
not claim the answers change what you are shown** — and it does not.

### Money

Every one of these derives from the `PRICING` block in `js/account.js`. There
is no second place. See §5.

| Call | Returns |
|---|---|
| `FBA.plans()` | **the offer** — only the plans a new reader may pick, in ladder order. This is what the plan screen renders. |
| `FBA.planByKey(key)` | one *offered* plan, or `null`. Deliberately `null` for a retired plan, so a stored `"quarterly"` cannot restore a selection the screen no longer shows. |
| `FBA.allPlans()` | **the whole ladder**, retired rungs included. Never render the offer from this. |
| `FBA.planByKeyAny(key)` | one plan from the whole ladder — for naming what an existing subscriber is already on. |
| `FBA.plan()` / `FBA.setPlan(key)` | the chosen key |
| `FBA.checkoutURL(key)` | full Stripe URL with `prefilled_email` and `client_reference_id`, or `""` when that plan has no link. Retired plans still resolve: a bookmarked link must keep working. |
| `FBA.anyLinkReady()` | boolean — is checkout switched on at all |
| `FBA.money(11.97)` / `FBA.moneyCents(1197)` | `"$11.97"` |
| `FBA.pricing()` | a **copy** of the whole `PRICING` record — currency, base, trial, every plan including retired ones |
| `FBA.PRICING` | the same copy, taken once at load |
| `FBA.TRIAL_DAYS` / `FBA.trialDays()` | `3` |
| `FBA.trialShort()` | `"3 days free"` — for buttons |
| `FBA.trialWords()` | `"three days free"` — for sentences; capitalise at the call site |
| `FBA.words(3)` | `"three"` |

A plan object:

```js
{ key:"annual",
  /* what Stripe charges — the only figure that must be exact */
  amountCents:3588, billedCents:3588, billed:35.88, billedText:"$35.88",
  currency:"USD",
  intervalUnit:"year", intervalCount:1, months:12,
  cycle:"a year", cycleShort:"once a year",
  billedLine:"$35.88 a year",
  /* derived, secondary, and honest about it */
  perMonthCents:299, perMonth:2.99, perMonthText:"$2.99",
  perMonthExact:true, perMonthAbout:"$2.99",
  savePct:40, best:true, offered:true,
  priceId:"price_1UBG4pAhj1M3E8Tl1x4YFAzB", trialDays:3,
  link:"https://buy.stripe.com/…", ready:true }
```

Figures in that example, and in the table in §5, are a **record of what was
verified on 2026-09-03**, not a place to change a price. They carry a date and
a source for exactly that reason. The only editable copy of a price is
`PRICING` in `js/account.js`; if this file and that block ever disagree, the
block is right and this file is stale.

**`perMonthExact` is the one field that stops the site lying.** $35.88 a year
divides into twelve exactly equal $2.99 months, so `perMonthExact` is `true`
and `"$2.99 a month"` is a true sentence. $35.00 a year does not divide: the
per-month figure rounds to $2.92, twelve of which is $35.04, a price nobody is
charged. In that case `perMonthExact` is `false` and `perMonthAbout` reads
`"about $2.92"`. **Copy must render `perMonthAbout`, not `perMonthText`**, or
the plan screen quotes a price that does not exist.

`FBA.get()` returns
`{accountId, email, name, interests, frequency, plan, onboarded, at, draw,
relates, goal, streak, planAnswers}`.

### Meta

`FBA.stored()` — `false` once any write has been refused. `join.html` uses it
to say "this browser will not remember you" instead of quietly forgetting.
`FBA.KEY` — `"fb_acct_v1"`.

## 4. Storage

One key, `fb_acct_v1`, one JSON object, short field names, same discipline as
`progress.js`:

```
{ v:1, a:accountId, e:email, n:name,
  i:[topics], f:freq,            ← legacy
  d:draw, r:[relates], g:goalMins, s:streakDays, q:[planAnswers],
  p:plan, o:0|1, t:secs }
```

`localStorage` is the real store; a cookie mirrors the same string **only**
while it is under 700 bytes, because Instagram's and TikTok's webviews hand
out a `localStorage` that is wiped between sessions while cookies survive.

Over the cap, `save()` sheds in order of what costs least to lose and never
the email: legacy topic picks, then the loader's three yes/nos (theatre, and
already spent), then the ticked statements. The draw, the daily goal and the
streak stay, because the plan screen reads them back.

Every read, write and cookie access is wrapped. A dead store degrades to "not
remembered", never to a broken page — proved by the check below.

## 5. The price ladder — one source, and it is `PRICING`

**`PRICING` at the top of `js/account.js` is the single source of truth for
every figure the site shows about money, and for every URL that takes money.**
Nothing else in this repo may contain a price. If you are about to type a
dollar figure into markup, into copy, or into a `.md` file, stop.

Each rung carries the charge and the link *together*, in one record:

```js
{ key:"annual",
  link:        "https://buy.stripe.com/28E7sKa5b8Mj8DtgUO3F604",
  priceId:     "price_1UBG4pAhj1M3E8Tl1x4YFAzB",
  amountCents: 3588,          /* USD 35.88 — what Stripe charges */
  intervalUnit:"year", intervalCount:1,
  cycle:"a year", cycleShort:"once a year",
  offered:true, best:true }
```

That pairing is the point. Before, the displayed price lived in a
`PRICE_PER_MONTH` map and the charging URL lived in a separate
`PAY_LINK_ANNUAL` constant, so either could be edited without the other and
the site would go on showing a number Stripe had stopped charging. Now they
are two lines of one object and a price change touches both or neither.

**The total is the source; the per-month figure is derived.** It used to be
the other way round, which was not just backwards but *lossy*: if the total
is `perMonth × months`, the code cannot express any annual price that is not
a multiple of twelve cents. It literally could not represent "$35.00 a year".
Stripe charges a total, once per period; everything else is arithmetic on it.

| Plan | Charged | Works out at | Saving vs monthly | In the offer? |
|---|---|---|---|---|
| Monthly | **$4.99 every month** | $4.99/mo | — | yes |
| Quarterly | **$11.97 every 3 months** | $3.99/mo | 20% | **no — retired** |
| Annual · best value | **$35.88 a year** | $2.99/mo | 40% | yes |

Verified against the live Payment Links on 2026-09-03; STRIPE.md §2 records
how, and is the table to trust if these two ever disagree.

Both figures are always shown together. A per-month figure on a plan billed in
a lump is the half of the truth that gets a refund request.

### The trial is configuration, not a literal

`TRIAL_DAYS = 3`, one constant, immediately above `PRICING`. `trialShort()`
gives `"3 days free"` for buttons and `trialWords()` gives `"three days free"`
for sentences, so the 3-vs-7 test is one edit here and three edits in Stripe —
not a hunt through copy for the word "three".

**The trial itself is configured in Stripe, on each Payment Link.** Nothing in
this code can grant, extend or end one. `TRIAL_DAYS` only *describes* what the
links are set to, so it must be changed in Stripe first and here second.

### Retiring a plan without touching anybody's subscription

`offered: false` on a rung takes it off the plan screen and does nothing else.
The Stripe price is untouched, the Payment Link keeps working, and every
existing subscriber on it keeps renewing at exactly what they agreed to.
Nobody is migrated, repriced or cancelled. Do **not** delete the record: the
account page still has to be able to name the plan somebody is on, which is
what `planByKeyAny()` is for.

Quarterly is currently retired this way. See STRIPE.md §6.

## 6. The three Stripe Payment Links

Live, in `PRICING`, one per rung, beside the price each one charges. The
click-path for creating or replacing one is **STRIPE.md §7** — it is written
out there rather than here so there is one procedure, not two.

If a link is ever emptied, the plan screen's button reads *"Checkout is not
open yet"*, is disabled, and explains itself in a line underneath — before the
tap, not after it.

## 7. What this still is not

Everything SPEC.md §9 says remains true. `data/stacks.json` is a public file;
anyone with dev tools reads all fifty-one stories without paying. The gate
stops a paying reader being asked to pay twice and nothing more. An "account"
with no backend is a preference store with an email in it. Making any of this
real needs a backend that checks a Stripe customer before serving content.

That is a note for whoever works on this next. It is **not** a thing to tell
the reader on a sign-up screen.

## 8. Analytics

Every step fires through `FB.track`, `join_*` names:

| Event | Props | When |
|---|---|---|
| `join_view` | `state` = `new` \| `signed_up` \| `returning` \| `unlocked` | on load |
| `join_step` | `step` = the panel id | every panel shown, interstitials included |
| `join_draw` | `draw` | step 1 answered |
| `join_praise` | `draw` (or `skipped`) | the echo screen rendered |
| `join_relate` | `n` = how many ticked | step 2 answered |
| `join_time` | `mins` | step 3 answered |
| `join_streak` | `days` | step 4 answered |
| `join_signup` | — | email accepted |
| `join_plan_start` | — | the loader began |
| `join_plan_ask` | `n` = 1–3 | a bar stalled and asked |
| `join_plan_answer` | `n`, `yes` | one of the three answered |
| `join_plan_built` | — | all three done |
| `join_skip` | `step` = `draw` \| `relate` \| `time` \| `plan_loader` | a Skip taken |
| `join_login_hit` / `join_login_known` / `join_login_miss` | — | the log-in detour |
| `join_restore_use` | — | a restore link pasted |
| `checkout_start` | `plan` | the buy button |

The funnel's drop-off shape is `join_step` counts; the two interstitials are
in that stream on purpose, because an echo screen people leave on is a copy
problem, not a question problem.

## 9. Verifying a change

Serve the site and run the checks in a real DOM — HTTP 200s and `node --check`
are equally true of a page with nothing on it.

```
python3 -m http.server 8905 --bind 127.0.0.1 --directory <site> &
node joincheck.js     # drives the funnel: all six steps, both interstitials,
                      # the echo's four variants, Back, every Skip, dead
                      # storage, FBA absent, reduced motion, the cookie-mirror
                      # return path, log in, already-unlocked, and that the
                      # plan screen still reads exactly what PRICING says
                      # and every offered plan's Stripe link is intact.
                      # Assert against FBA.plans(), never against typed
                      # figures -- a check with its own copy of the prices
                      # is a fourth place for them to drift.
node mirrorcheck.js   # the arithmetic, the Stripe URL, and that the no-JS
                      # fallback copy in join.html still matches plans()
node gatecheck.js     # stories / explore / read still render and still route
python3 es5scan.py …  # no ES6 outside comments and strings
```

Two things that check must keep asserting:

- **Every panel in `join.html` ships visible with its real copy**, including
  every offered plan's charged total, all three loader questions and the loader's
  way out. The script hides what it is not showing. If the script never runs,
  or throws, the reader gets one long readable page rather than a blank one.
- **The rendered page contains none of the phrases in the check's `FORBID`
  list** — the fingerprints of the copy that was removed, the paragraph that
  explained our hosting model to a reader who came here to read about
  Cleopatra. If one of them comes back, the funnel has started explaining
  itself again. Add to that list, never subtract from it.


---

# 10. The account screens — `/account` and `/settings`

`account.html` · `settings.html` · the `.ac-` block at the foot of
`css/account.css` · `js/acct.js`.

Rebuilt from the design mockup's screens 2f and 2g. Before that, `/account`
was four rows — name, signed in as, manage billing, sign out — and there was
no settings screen at all.

## 10.1 What is on each

**`/account` is a progress page.** Masthead and tabs, the reader's insignia,
name and email, then four sections drawn entirely from the reading record:

| Section | What it is | Source |
|---|---|---|
| Your Factbox | three counts: stories finished, cards read, series touched | `FBP.state()` per stack, joined to `data/index.json` |
| This week | seven day letters, seven dots, one line under them | the `at` timestamps in `FBP.all()` |
| Currently exploring | the subject holding the most recently touched story, how far in, and the next story in it | `FBP.state()` grouped by `topic` |
| Your history | up to six covers, most recently touched first, and "See all →" to `/library` | `FBP.all()` sorted on `at` |

Then one row through to `/settings`, and the legal line. Billing, name, email
and signing out all live on `/settings` now, which is where the mockup puts
them and where a reader looks for them.

**`/settings` is quiet by design.** An Account group (Name, Email,
Subscription), a Help group (Contact us, Artwork credits, Privacy, Terms), and
Sign out. Nothing on it is a *preference*, because there is nothing here to
prefer: the site has one theme, sends no notifications, and has no reminder
times to honour. A settings page full of switches that do nothing is worse
than a short one.

## 10.2 Every number is real or it is absent

`FBP` gates the whole reading record on the account that owns the cache. Signed
out, or on a cache tagged with a different uid, `FBP.all()` is `{}` and
`FBP.state()` answers `"unread"` for every story. So a signed-out reader gets
the empty state and **never another reader's history**. Verified in Chrome:
signed out, `#ac-stats` has zero items and `#ac-hist` zero covers.

**There is no zero state either.** Three zeroes under "Your Factbox" and seven
grey dots under "This week" describe the furniture, not the reader. Each
section is `[hidden]` until it has something true in it, and a signed-in reader
with nothing read yet gets one sentence with a link out of it. Measured: with
no record, `document.querySelectorAll(".ac-dot").length` is **0** — the dots
are not in the DOM at all, rather than in it and grey.

### What the record cannot support, and is therefore not claimed

`js/progress.js` stores **one** timestamp per story — `r[2]`, the last time
that story was touched, overwritten on every touch. There is no per-day log
anywhere on this site. So a day whose only story was later re-opened has left
the record, and both the week row and the streak **under-count and can never
over-count**, which is the direction this has to fail in.

That is exactly the resolution `js/today.js` and `js/recommend.js` already
ship, and this screen borrows both framings rather than inventing a third:

- the line is **"5 days this week"** — a count of days, the wording
  `js/recommend.js`'s `weekRow()` uses on the completion screen
- the streak is appended only when it is greater than one, and it uses
  `js/today.js`'s `streakOf()` arithmetic unchanged

Nothing here says "longest streak", "days in a row this month", or anything
else needing a history this site does not keep. **`FBA.streak()` is not a
streak** — it is the number of days a reader said in onboarding they were
*aiming* for. Never render it as one.

`RECALL_CLAIM_PCT` is `null` and stays `null`. Neither of these screens quotes
a percentage, a survey or any statistic at all.

**If you move the streak here, extend the guard.**
`tools/check-regressions.js`'s "the streak treats FBP timestamps as
milliseconds" only reads `js/today.js`. `FBP.rec()` returns `at: r[2] * 1000`,
already milliseconds; dividing again makes every streak zero. `account.html`
divides by `DAY_MS` and by nothing else, but the guard does not know that.

## 10.3 Two calls this page must never make

`FBP.unlocked()` **is not a pure read.** `dGet()` reads localStorage, finds
nothing, reads the cookie, and writes the value back — so calling it re-mints
the unlock flag that `FBX.forgetLegacy()` has to remove. `FBP.continueReading()`
calls it internally, which is why the "Currently exploring" row builds its own
next-in-series instead of using it.

Every access question on these two screens goes to **`FBX`**, which is the one
file allowed to answer them.

## 10.4 Signing out

Three things, in a fixed order, on `/settings`:

```
FBU.signOut()  →  FBX.forgetLegacy()  →  location.replace("/")
```

`forgetLegacy()` clears `fb_unlocked_v1` and `fb_unlocked_at_v1` from
localStorage **and kills the `fb_unlocked_v1` cookie**. Both stores, or
neither: `js/progress.js` heals either one from the other, so clearing only
localStorage un-signed-out nobody, and for a long time signing out never
actually locked the browser.

`replace()`, not `href`, so Back does not return to a settings screen for an
account that is gone. And the order matters —
`tools/check-account-cache.js`'s "nothing reloads the page on a sign-out"
records that `FBU`'s `onChange` fires *inside* `signOut()`, so a reload landing
between line one and line three destroys the execution context mid-handler.

**It does not touch reading progress or saved stories.** Those live in `FBP`
and `FBS`, keyed to the account that owns them, and they simply stop being
visible when nobody is signed in. The line under the button says so.

Measured in Chrome, subscriber → signed out: padlocks on `/explore` went
**0 → 66**, `localStorage.fb_unlocked_v1` and the cookie both `null`, and both
still `null` after a second page load.

## 10.5 What is deliberately not built

| Not built | Why |
|---|---|
| **Change your name** | The write is Firebase's `updateProfile`, and `js/auth.js` — the only file allowed to touch the SDK — exposes no wrapper. The mockup draws Name and Email as tappable rows; they are plain rows here, because a chevron would promise a screen that does not exist. Add `FBU.setName()` and they become links. |
| **"Member since"** | Firebase carries `creationTime` on the raw user object, but `FBU` exposes no accessor and reaching around it into `FBU.user().metadata` would make this page the second file with an opinion about the SDK's shape. The line shows the email instead. |
| **Minutes, as a stat tile** | It is an estimate pro-rated from each story's listed `secs`, so it needs the word "about" to be true, and a three-digit tile has nowhere to put it. `/library`'s `statsLine()` still carries it, in the sentence form that has room for the qualifier. |
| **A subscription screen** | `/subscription` is another agent's. The Settings row links to it and this page decides nothing about a plan — a second telling of what Stripe charged can only ever disagree with the first. |

## 10.6 Layout, and the two specificity traps

Both screens live inside `.lib`, which caps the column at **900px** and centres
it. At 1440 and 1920 that is what you get: the same 900px column in the middle
of the window, not a phone layout stretched across a monitor. Two things do use
the extra room — the history grid goes 3 → 4 → 6 tracks, and the stat row and
week strip cap at 520px (the site's own measurement, shared with `.go`,
`.fine` and `.au-2nd`) so seven dots do not spread into a timeline.

Tested at 375, 390, 430, 768, 1024, 1440, 1920 and landscape 932×430: no
horizontal overflow at any width, and nothing tappable below `--bottom-safe`.

That last one needs measuring properly rather than eyeballing, and it caught
something. The footer links get 44px hit areas out of a negative vertical
margin, so the *layout* box is the height of the text but the *hit* box hangs
about 14px lower — and that paragraph is the last thing on both pages, right
above the strip `.lib` reserves for the in-app toolbar. It left **2px** of
clearance at 932×430. `.ac-fine` now carries a matching bottom margin, written
as the overhang's own expression so it tracks `--tap`. Re-measured, scrolled to
the very bottom, lowest tappable against the required strip: 81px vs 64 at
932×430, 104 vs 87 at 375×667, and more at every other size.

**`css/auth.css` loads after `css/account.css`, and it bites twice.**

1. `.au-panel > p` is (0,1,1). Every eyebrow, name and streak line on these
   screens is a `<p>`, and a bare class is (0,1,0) — it would lose, the same
   way `.au-or` and `.au-say` did before their selectors were doubled up.
   Rather than double seven selectors, **both pages wrap their contents in one
   `.ac-body` div**, so no `<p>` of theirs is a *direct* child of the panel and
   the rule cannot reach them. That wrapper is load-bearing. Do not flatten it.
2. `.au-panel{text-align:center}` centres the sign-in screen. These are
   left-aligned columns, so the panels carry `.ac-left` — (0,2,0) beats
   (0,1,0) — and `.ac-body` sets `text-align:left`.

Everything new is prefixed `.ac-` so it cannot collide with `.jn-` (the funnel,
in the same file), `.au-` or anything the core owns. There is not one colour
literal in the block; `--display` is not used, which is why neither page asks
Google for Newsreader.

## 10.7 Nothing renders empty, with or without JavaScript

The signed-out panel on **each** page ships **visible** — no `hidden`
attribute — and the script hides it once it knows somebody is signed in. That
is SPEC.md §2.2's rule applied to routing: text is visible by default and
JavaScript opts into hiding it.

- **Scripting off:** `au-js` never reaches `<html>`, so the panel stays.
  Measured: `/account` 473 characters of visible text and 11 working links;
  `/settings` 533 characters and 12 working links, including the whole Help
  group and the route to the subscription screen.
- **Scripting on:** `html.au-js .au-panel{display:none}` hides every panel for
  the beat auth takes to answer, so a signed-in reader never sees it.
- **Scripting on and broken:** the unconditional 4s timer in each page's head
  strips `au-js` whatever happened, and the reader gets the real markup.

`#ac-in` and `#ac-dead` stay `[hidden]`: one is a record that does not exist
until it is counted, the other an apology for a failure that has not happened.

## 10.8 The insignia, and `js/acct.js`

`js/acct.js` still owns the one profile control on all nine pages that carry
`<span class="acct" id="fb-acct">`. Two behaviours are load-bearing and were
kept:

- **Signed out there is no menu.** One tap goes straight to
  `/login?next=<this page>`. A menu of "Sign in" and "Create account" spends a
  tap choosing between two names for the same screen.
- **`aria-haspopup` only when there is a popup.** It is removed signed out;
  announcing a popup that never opens is a lie to a screen reader.

The only change: the signed-in menu gained a third item, **Settings →
`/settings`**. That menu is on nine pages and the Settings row is on one, so a
reader who wants to cancel or sign out should not have to pass through
`/account` to find out where it went.

`?next=` still survives. `login.html`'s `NEXT_OK` is a whitelist on *shape*,
not a list of known pages, so `?next=settings` needs nothing added to it.
Verified in Chrome: `/login?next=account` → `/account`,
`/login?next=settings` → `/settings`.

## 10.9 Analytics

**No new event names.** GA4 caps them, and `tools/check-analytics.js` guard 11
enforces the format. These screens fire exactly what they fired before:

| Event | Where |
|---|---|
| `page_open` | automatic, `js/analytics.js`, one name with a `page` parameter |
| `ui_click` | automatic, the one delegated listener |
| `billing_portal` | the Subscription row on `/settings` |
| `signout` | the Sign out button on `/settings` |

`settings.html` loads `/js/analytics.js`, which guard 1 requires of every page
in the repo.

## 10.10 Verifying a change

```
python3 tools/serve-like-pages.py 8899 .     # NOT python3 -m http.server —
                                             # that 404s every clean URL, and
                                             # confirming /explore returns 200
                                             # first is how you know
cd tools
node check-page.js "account.html"  ".au-panel" ""
node check-page.js "settings.html" "a" ""
node check-regressions.js && node check-analytics.js && node check-account-cache.js
cd .. && python3 tools/check-structure.py
```

`check-structure.py` needs **no baseline entry** for a new page: the preload
ratchet is skipped when a filename is absent from `structure-baseline.json`,
and everything else it asserts is generic. Do not run `--save` to add one
unless you mean to re-baseline every other page at the same time.

None of that runs the page in a real browser, and every one of those checks is
equally true of a page with nothing on it. The things that only Chrome will
tell you, and that were measured for this rebuild:

- three auth states on both screens — signed out, signed in free, subscriber —
  plus signed in with no reading record at all
- padlock count on `/explore` before and after signing out, and the unlock
  flag in **both** stores after a second page load
- contrast for every text pair against its real *composited* ground, not
  against the token it was written with
- the seven viewports, and that nothing tappable ends below `--bottom-safe`
- zero `pageerror` in every state

## 10.11 Contrast, measured

Every pair on both screens, composited against the ground actually behind it.
All clear WCAG AA for their size and weight; the tightest is 5.1:1 against a
4.5:1 requirement.

| Pair | px/weight | Ground | Ratio |
|---|---|---|---|
| Name | 21/700 | `--ground` | 10.14 |
| Email line, stat labels, eyebrows, day letters, row values | 11–15/400–500 | `--ground` | 5.10 |
| Stat numbers, week line, row labels, history titles | 13–27/600–700 | `--ground` | 10.14 |
| Series name | 17/700 | `--raise` | 11.21 |
| Series count | 13/500 | `--raise` | 5.40 |
| Series CTA (`--accent-ink`) | 14/600 | `--raise` | 5.79 |
| "See all →" (`--accent-ink`) | 14/600 | `--ground` | 5.24 |
| Back link (`--dim`) | 15/600 | `--ground` | 6.34 |
| **Sign out (`--crimson`)** | 15/600 | `--ground` | **5.48** |

`--crimson` is quoted on both grounds because it is the one control that could
move: **5.48:1 on `--ground`**, which is the bare page it actually sits on
today, and **6.06:1 on `--raise`** if it is ever put inside a card. Colour
only, no fill — a red *button* competes with the blue primary action and turns
signing out into an alarm, when the reader is signing out, not deleting an
account.
