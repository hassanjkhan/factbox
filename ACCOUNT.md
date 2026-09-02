# Accounts, onboarding and the price ladder

`join.html` · `js/account.js` (`FBA`) · `css/account.css`, plus the
`checkout()` area of `js/gate.js`.

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

### Money — unchanged

| Call | Returns |
|---|---|
| `FBA.plans()` | array of three plan objects, in ladder order |
| `FBA.planByKey("monthly"\|"quarterly"\|"annual")` | one plan, or `null` |
| `FBA.plan()` / `FBA.setPlan(key)` | the chosen key |
| `FBA.checkoutURL(key)` | full Stripe URL with `prefilled_email` and `client_reference_id`, or `""` when that plan has no link yet |
| `FBA.anyLinkReady()` | boolean — is checkout switched on at all |
| `FBA.money(n)` | `"$11.97"` |
| `FBA.TRIAL_DAYS` | `3` |

A plan object:

```js
{ key:"quarterly", perMonth:3.99, perMonthText:"$3.99", months:3,
  billedCents:1197, billed:11.97, billedText:"$11.97",
  cycle:"every 3 months", cycleShort:"3 months at a time",
  billedLine:"$11.97 every 3 months",
  savePct:20, best:false, trialDays:3,
  link:"https://buy.stripe.com/…", ready:true }
```

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

## 5. The price ladder — unchanged

Three numbers live in `PRICE_PER_MONTH` in `js/account.js`. **Every other
figure on the plan screen is computed from them** — the billed total, the
cycle sentence, the "save N%" — because a hard-coded percentage becomes a lie
the first time a price moves.

| Plan | Per month | Actually billed | Saving vs monthly |
|---|---|---|---|
| Monthly | $4.99 | $4.99 every month | — |
| Quarterly | $3.99 | **$11.97 every 3 months** | 20% |
| Annual · best value | $2.99 | **$35.88 a year** | 40% |

Both numbers are always shown together. A per-month figure on a plan billed in
a lump is the half of the truth that gets a refund request.

## 6. The three Stripe Payment Links

Live, and at the top of `js/account.js`. Full creation instructions are in the
comment block next to the constants they fill. In short, per link:

- one recurring price on one product — **$4.99 monthly**, **$11.97 every 3
  months**, **$35.88 yearly**
- **Include a free trial → 3 days** (this is set in Stripe; nothing in this
  code can grant, extend or end a trial)
- after payment → redirect to
  `https://factbox.app/stories.html?unlocked=1&session_id={CHECKOUT_SESSION_ID}`

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
                      # plan screen still reads $4.99 / $11.97 / $35.88 with
                      # all three Stripe links intact
node mirrorcheck.js   # the arithmetic, the Stripe URL, and that the no-JS
                      # fallback copy in join.html still matches plans()
node gatecheck.js     # stories / explore / read still render and still route
python3 es5scan.py …  # no ES6 outside comments and strings
```

Two things that check must keep asserting:

- **Every panel in `join.html` ships visible with its real copy**, including
  all three prices, both totals, all three loader questions and the loader's
  way out. The script hides what it is not showing. If the script never runs,
  or throws, the reader gets one long readable page rather than a blank one.
- **The rendered page contains none of the phrases in the check's `FORBID`
  list** — the fingerprints of the copy that was removed, the paragraph that
  explained our hosting model to a reader who came here to read about
  Cleopatra. If one of them comes back, the funnel has started explaining
  itself again. Add to that list, never subtract from it.
