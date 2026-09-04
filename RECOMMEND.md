# The end of a story, and the wall

`js/recommend.js` + `css/recommend.css`. Two panes, and each is really two
screens played in order, because the order is the whole point:

```
story -> "you finished it" -> the next episode -> it opens itself
story -> interrupted       -> the offer        -> /join
```

A reader meets a complete story, then a moment of having finished it, then
curiosity about the next one — and only then, and only if they cannot open it,
a price.

Both panes ride in the reader's own swipe deck. `read.html` owns the deck, the
plate pager, the rails and the access gate; this layer owns nothing above the
`.pane` it returns.

---

## 1. The end of a story — `FBR.endPanel()`, `.pane.rec`

Three beats. `js/recommend.js` puts `.is-p0` / `.is-p1` / `.is-p2` on the pane
and `css/recommend.css` does the rest.

### Beat 1 — `.ec-p1`, about a second

Over the plate the reader finished on. That plate is the last card's, which
they were looking at one swipe ago, so **this screen starts no download**.

```
    (tick)
  STORY COMPLETE
   Cleopatra
  3 OF 8 COMPLETE
```

| Line | Where it comes from |
|---|---|
| `STORY COMPLETE` | `Series complete` instead when nothing in the subject is left |
| `Cleopatra` | `topicName()` — the subject's heading form, out of `window.FBTAX` |
| `3 OF 8 COMPLETE` | `subjectDone()`. Drawn only when the subject holds more than one story |

### Beat 2 — `.ec-p2`

```
 [ the next story's cover, to the fold ]
   UP NEXT
   CLEOPATRA 2 OF 8
   The seductress is the most famous story
   about Cleopatra, but where did it come from?
   4½ min
  • • ○ · · · · ·

   Next story in 3…
  [      Start now      ]
      Back to Explore
```

| Element | Where it comes from |
|---|---|
| cover | `/img/thumbs/<img>.webp`, `/img/stacks/` as the fallback carried on the element |
| `CLEOPATRA 2 OF 8` | `place(list, next)` — catalogue position within the subject |
| headline | `promise()`: the story's **hook**, cut to its first sentence, with any citation stripped. Its title when it has no hook |
| `4½ min` | `FB.minutes()`, the same half-minute arithmetic every runtime on the site prints |
| dots | one per story in the subject: filled for finished, ringed for the one about to open. `aria-hidden` — the two lines above say it in words |
| countdown | see §3 |
| offer line | `FBA.plans()` / `FBA.trialDays()`. **Never drawn for a reader who already has access** |

### Never display progress that cannot be computed truthfully

`js/progress.js` gates the reading map: `FBP.visible()` is false unless the
cache is tagged with the account signed in right now. That gate is a shipped
privacy fix — a shared phone was showing one reader's finished ticks to the
next person to pick it up — and this file does not go around it.

So there are two honest cases and both are rendered:

* **the record is the viewer's.** `subjectDone()` counts the stories in this
  subject FBP marks `done`, and the dots fill from the same answer.
* **it is not.** The only thing we know is that this reader finished a story
  just now, because we watched them do it. So the line reads `1 OF 8 COMPLETE`,
  one dot is filled, and **nothing at all is claimed about any other story.**

FBP answers "is this yours?" twice — a synchronous hint at load, then the real
answer once Firebase has spoken — so `read.html` rebuilds the card on
`FBP.onChange` for `show` / `hide` / `clear` / `replace` only; `local` fires
from `FBP.mark()` on every scroll frame and rebuilding on that is a loop.

**What came off this screen**, and it was deliberate: the "You just learned
something in 4½ minutes" headline, the "4 stories learned" count and the
seven-day week strip. The design this was rebuilt to gives beat one four lines
and a second, and the reader's record now surfaces as the one line that is
about the thing they are in the middle of. `week()` and `minutesPhrase()` went
with them; `learned()` stayed, because `first_story_completed` still needs it.

---

## 2. Which story comes next — and the bug that decided how

Reported from the live site: *"you read the first one, go to continue, then the
second story, then it goes back to the first."*

It was not a fallback misfiring. The card picked its next story by SCORE, and
for a signed-out reader on Cleopatra 02 the arithmetic was:

```
story 01   same topic +120, unread +12, free-and-locked-out +60   = +204
story 03   same topic +120, unread +12, LOCKED            -1200   = -1068
```

The story they had just come from outscored the story that actually follows it
by more than a thousand points. With two free stories that is a loop.

Scoring is the wrong instrument. "What comes next" is a sequence, not a
popularity contest, and the reader is entitled to the same sequence every time.
So `runOrder()` is **decided**, not computed:

1. the rest of this subject, **forward** in catalogue order — never backward,
   because the story before this one is the one they just read;
2. the same **kind** of story, which is the only other axis `window.FBTAX`
   has, forward first and then round;
3. the catalogue, forward and then round.

`pickNext()` walks that order and applies two rules:

- **A finished story is never offered as next.** That answer comes from FBP,
  which shows a reader their own record and nobody else's.
- **A reader who cannot open everything sees only the forward half**, and is
  offered the next story in it *whether or not they may open it*. Two stories
  are free and 01 → 02 is forward, so nobody loses a free story; but 02 → 03 is
  locked, and the honest thing there is the offer, not a third lap of the same
  two.

`FBR.next()` — the scorer — is untouched and still exported. It answers "what
else is worth reading", which is a different question from "what is next".

### The control has four shapes

| When | Shape | Countdown |
|---|---|---|
| a next story this reader may open | `<a>` to it, **Start now** | yes |
| the same, but the page passed its own `opts.cta` (`/firststory`) | `<a>` with that label | **no** |
| a next story they may not open | `<button>` **Keep learning**, which opens the wall | **no** |
| no next story at all | `<a>` to `/explore`, reading **Back to Explore** | no |

The last is the one that used to be a silent loop back to story one. And
`canOpen()` asks the same three questions `js/access.js` does — access, or
permanently free, or **today's Factbox**, which is free for everybody every
day — so the one story that has no padlock never gets one drawn on it.

---

## 3. The clock, and the three things it has to get right

Beat 2 counts down from three and opens the next story. `Start now` skips it;
`Back to Explore` cancels it.

### a. It never auto-opens a story the reader may not read

`canAuto` is `!!target && !opts.cta`, and `target` is `pickNext()`'s answer
only when `canOpen()` said yes. When it did not there is **no countdown
element on the pane at all** — the control becomes the offer and the reader
chooses. Spending somebody's attention to walk them into a wall they did not
ask for is not a feature, and the mockup this was built from could not see the
problem because its Journey 2 reader is a subscriber with nothing locked.

### b. It cancels on every exit

`stop()` is idempotent and is called from all of these:

| Exit | Wired where |
|---|---|
| the tab is hidden | `visibilitychange` → `document.visibilityState === "hidden"` |
| the page is going away | `pagehide` |
| the back button | `popstate` |
| scrolling back up into the story | `read.html`'s scroll handler calls `el.leave()` whenever the current card index drops below the last card |
| `Back to Explore` | its own click handler, before the link is followed |
| `Start now` | its own click handler |
| the pane is replaced | `read.html` calls `el.leave()` before swapping in a rebuilt card, and every tick re-checks `sec.parentNode` |

`stop()` also takes the countdown's words off the screen. A reader who
backgrounded the tab for a minute and came back would otherwise be looking at
`Next story in 2…` over a clock that will never tick again — a screen telling
them something untrue about itself. `Start now` still works; cancelled means
cancelled, not paused.

`leave()` goes further and resets the pane to beat one, so a reader who scrolls
back into the story and returns gets the moment played again rather than a dead
screen.

And the one stop that is **not** a cancellation gets its own 320ms: `Opening…`
is painted, and the navigation is one beat behind it. A word assigned in the
same tick as `location.href` is a word the browser is never given a frame to
draw, and `Opening…` is the last thing this screen is meant to say. That beat
is cancellable too.

### c. Reduced motion does not silently disable it

What that setting asks for is less movement, not fewer features. So:

* the advance still runs;
* the remaining seconds are **text** — `Next story in 3…`, then `Opening…` —
  never a shrinking bar or a sweeping ring, because a cue whose only channel is
  animation is a cue a motion-free reader cannot see;
* the countdown paragraph is `aria-hidden`, and a visually-hidden
  `role="status"` sibling says the whole thing **once** at the start:
  *"Next story opens in 3 seconds. Start now, or go back to Explore."* A live
  region that ticks reads four numbers at somebody for no reason;
* both controls are an ordinary `<a>` and `<button>`, focusable, with the
  site's `:focus-visible` ring.

---

## 4. The wall — `FBR.paywall()`, `.fbg`

**It is not a pane any more.** It used to be a `.pane` that replaced the deck:
a manufactured "interruption" screen carrying the story's own first card, then
an offer screen behind a Continue button. The reader met a reproduction of the
story, and then a price.

Now a locked story really opens and really runs. `read.html` draws its first
cards on their own plates, with their own credit lines and the same progress
rail every other story has, and the run stops at a boundary the reader can see.
`FBR.paywall()` returns a **fixed overlay** that belongs on the document body,
and what the reader does at that boundary is what opens it.

```
 1  the story, running                    read.html
 2  .fbg-auth   "Keep reading."           an account, so the progress is theirs
 3  .fbg-buy    "Finish the story."       the amount, the terms, one button
 4  Stripe                                not ours
 5  the story, unlocked                   read.html
```

Five states, and one of them is Stripe's. A reader who is already signed in
never sees state 2 at all: `open()` asks `FBU.signedIn()` and goes straight to
the offer.

### 4a. The boundary, in the story — `.fbw-peek`, `.fbw-rule`, `.fbw-gap`

`read.html` draws `FREE_RUN` cards (two) and adds two things to the last of
them: the **next card's own opening line**, at the opacity of something you
cannot read yet, and a hairline with an inline-SVG padlock in it. Below the
last card sits a tail — the room the gesture needs, and the one way through for
a reader whose sheet never opened.

Two cards, not one and not three. One card is a headline and the reader has not
started; three is most of a five-minute story given away on every locked URL,
and there are fifty-one of them. Two is a hook and its turn, so stopping costs
something — which is the whole mechanism.

Nothing on the boundary is invented. The peek is the story's own next head,
dimmed. The rail counts the **whole** story, so a reader on card two of eight
sees eight: that is the argument, not a hidden fact.

### 4b. The gesture — one more scroll past the boundary

There is no unlock button to hunt for. Trying to keep reading **is** the intent
signal. `read.html` owns the gesture because it owns the deck; this file owns
what the gesture opens.

Two independent ways in, guarding different failures:

* **position** — the reader is more than 88px below the top of the boundary
  card, which is inside the tail. No arming needed, and it deliberately catches
  a hard flick that goes straight through, because at speed that is what "keep
  reading" looks like. It cannot be tripped by a bounce: a bounce at a card
  edge oscillates around that edge by a few pixels, and 88 is most of a
  paragraph past it. It latches, and un-latches only when the reader comes back
  up above the line.
* **gesture** — for the case where the deck *cannot* move: a snapping engine
  that takes the delta and puts the box back, a tail shorter than the
  threshold, a reader with no thumb on the glass. 90px of accumulated wheel in
  one push (400ms of quiet starts a new push), 56px of one upward finger drag,
  or ArrowDown / PageDown / Space / End. This one **does** need arming —
  otherwise the momentum of arriving would count as asking — so it waits for
  the deck to have been quiet for 160ms with the boundary card in place. A
  gesture copies that arming at its first frame, because a drag moves the deck
  and would otherwise arm itself out of existence on its own first pixel.

**Snapping goes from mandatory to proximity for a locked run**, through
`.deck.is-wall` in `css/recommend.css`. `css/app.css` gives the deck
`scroll-snap-type: y mandatory`, which is right for a story and wrong under a
boundary: mandatory makes the last card the last position the scroller will
rest on, so the tail can never be reached, the way-through link in it can never
be seen, and the one-more-scroll is undone by the engine before it finishes.
Every other story keeps mandatory.

**Dismissing is not consent.** "Not now", "Maybe later", Escape and a tap on
the veil all shut the sheet and leave the reader in the story, and both ways in
disarm — so the position they are left standing at cannot spring the sheet
straight back at them. Coming back to the boundary and going again re-opens it.

### 4c. The account sheet — `.fbg-auth`

Eyebrow: the story's own title. Head: *"Keep reading."* Sub: *"Save your
progress, and pick up exactly where you stopped."* Then Continue with Google,
Continue with email, "Already have an account? Sign in", and "Not now".

**Why an account comes before a price.** It is not a toll on the way to
checkout. `STRIPE.md` §1: `client_reference_id` is the entire link between a
payment and an account, and it has to be a Firebase uid. A reader who pays
without one gets in through a local flag, on that browser only — their money
does not follow them to a second phone and does not survive clearing the
browser. The sheet asks for the thing that makes the purchase theirs.

Google is `FBU.signInGoogle()`, which falls back to a redirect inside the
Instagram and TikTok webviews. Email is `/login?next=<this page>`, the site's
one real Firebase sign-in, which also creates accounts. Both come back to the
same story with the same query string on it.

**"Continue with Apple" is in the mockup and is not built.** Firebase has no
Apple provider on this project — the identity toolkit answers
`OPERATION_NOT_ALLOWED` for `apple.com` and returns a real auth URI for
`google.com` — so a button drawn from that design would open a screen that
cannot sign anybody in, and a sign-in control that fails is worse than one that
is not there. `APPLE_ON` in `js/recommend.js` carries the four steps that would
have to happen first, in order. The flag is double-gated: flipping it before
`js/auth.js` grows a `signInApple()` still draws nothing.

### 4d. The offer — `.fbg-buy`

Eyebrow: the story's title. Head: *"Finish the story."* Sub: *"Unlock every
story in Factbox. Your next story is already waiting."* Then the proof slot,
the amount, the button, the terms, and two ghosts.

**The title is the eyebrow, not the headline, and that is a deviation from the
mockup.** The mockup reads *"Finish Cleopatra."*, built from the subject's
name. That works because it was drawn on the one subject in the season whose
name is a proper noun. The other seven names in the taxonomy are group labels —
"Medieval and modern", "When it all went wrong", "Things you have wrong" — and
the same sentence over any of them reads *"Finish Medieval and modern."*, which
is not English. Titles do not survive the slot either: *"Finish 7 Deadly Sins
Explained."* So the naming moves up one line, where a headline belongs and
where no grammar is being asserted about it. The mockup's "· 2 of 9" is not
here either: that number needs the whole index, this screen is handed one
story, and a position guessed from one record is a number we made up.

**EVERY FIGURE IS READ, NEVER TYPED.** `billedText` is what Stripe charges to
the cent; `perLong()` is the interval it charges on; `underMonth()` divides it
down and rounds **up**, so the softer line can never quote a figure below the
one the reader authorises; `trialShort()` and `zero()` are the terms.
`tools/check-regressions.js` greps `js/recommend.js`, `css/recommend.css` and
`read.html` for a typed `$<digit>` and fails the build on one.

> Stripe charges **USD 35.88** a year, not 35.00. The mockup's ladder says
> `annual: 3500` "at the $35 the owner wants". There is no $35.00 price in
> Stripe. Until there is, this screen says what `FBA` says. `STRIPE.md` §7 is
> the click-path, and `link` and `amountCents` change together in one edit.
> The currency symbol is `FBA`'s too — `PRICING.symbol` is `"US$"`, because
> Stripe presents a non-US buyer their own currency and the annual link renders
> CA$51.63 from a Canadian address.

**The trial is stated because the till gives one.** All three live Payment
Links carry `trial_period_days: 3`. The mockup's changelog says the new design
is "one $35/year price, no trial" — if the screens stop saying so while Stripe
still grants it, the screen and the till disagree. Change the links first
(`STRIPE.md` §7 step 6, on all three, then `TRIAL_DAYS`), never this screen
first.

### 4e. The proof slot — `.fbg-proof`, and the statistics that do not ship

The mockup's purchase screen carries two percentages about what "Factbox
members" did in their first thirty days. **Neither renders.** Both are marked
`verified: false` in the mockup's own source, the designer's changelog says
outright that they are prototype placeholders with no study behind them, and
they are claims about a member base this product does not yet have.

`PROOF` in `js/recommend.js` is the switch, and it ships `on: false`,
`stat: null`. What renders is the copy-only arm — the A/B arm the mockup itself
describes — and neither of its lines asserts anything about anybody:

```
Make five minutes of screen time count.
Same phone. Something to show for it.
```

To turn the numeric arm on, both of these, in this order:

1. **Run the study.** A cohort, a definition of the behaviour, a window, and a
   figure that survives somebody else recomputing it. "Built a consistent
   learning habit" is not measurable until "consistent" is a number of days in
   a number of weeks.
2. Put the measured figure in `PROOF.stat` and its sentence in `PROOF.statCap`,
   then set `PROOF.on`. Nothing else changes; `.fbg-stat` is already styled.

A figure that arrives without step 1 is the same failure as printing a round
price when the till takes eighty-eight cents more. This is the third time this
repo has been asked for a number nobody measured; `RECALL_CLAIM_PCT` was null
for the same reason.

### 4f. Checkout — the attribution rule, on the reader page

The tap that buys is here now, and so is the guard, unchanged from the one
`join.html` has been carrying, because the rule is `STRIPE.md`'s and not the
page's:

| what is missing | what happens |
|---|---|
| no Payment Link | `checkout_blocked{why:"no_link"}`, once per page, and the button says so |
| no Firebase uid | `checkout_blocked{why:"no_uid"}`, and the reader is put back on the account sheet. `checkout_start` has **not** fired: this checkout did not start |
| no URL for the plan | `checkout_start` has already fired, so `checkout_blocked{why:"no_url"}` says the reader went nowhere — otherwise it looks exactly like an abandoned payment |
| nothing | `subscribe_click`, then `checkout_start{attributed:"1"\|"0"}`, then Stripe |

**The one case let through** is auth being genuinely unavailable — a blocked
CDN, a dead network, a webview too old for the SDK. Blocking there loses the
sale *and* leaves the reader no way to make an account, which is strictly worse
than a payment reconciled by hand: `profile-sync` writes `localAccountId` into
the reader's own document the moment they do sign in, which is what that
reconciliation joins on. It is counted rather than hidden, so "how much of the
revenue cannot be attributed" is a number somebody can look at.

`FBA.checkoutURL()` is untouched. It is the one place that builds
`client_reference_id`, and nothing here goes around it.

### 4g. The origin story

`read.html` writes `localStorage.fb_return_v1` on the tap that leaves for
Stripe, through the gate's `onStart`. What it writes is the story the reader
should be handed back to, which is **not always the one the sheet is about**:

* from a locked story — that story.
* from `/firststory`'s ask — the **next** story, because sending somebody back
  to the one they just finished is not "more stories".

`explore.html` reads it after `gate.js` claims `?unlocked=1`, checks
`FBX.canRead(id)`, and `location.replace`s. Its TTL is one hour.

### 4h. Coming back from sign-in — `fb_gate_v1`

Signing in is a real navigation. "Continue with email" goes to `/login` and
comes back; Google inside an in-app webview is a **redirect**, so the reader
leaves the origin entirely and returns through the Firebase handler. Nothing
held in a variable survives that, and what was being lost was the worst thing
to lose: the reader had just handed over an account and was one tap from the
offer, and they came back to the **top of the story** with the whole scroll to
do again.

`js/recommend.js` writes `localStorage.fb_gate_v1` — `{"s":"<stack id>",
"step":2|3,"at":<ms>}` — every time a sheet opens, and drops it the moment the
trip ends. **localStorage, not sessionStorage**, which is what this was: a
redirect sign-in does not always come back to the tab it left, and a per-tab
record then reads as absent. **Thirty minutes**, half `fb_return_v1`'s hour,
because an auth round trip is shorter than a card number and a 3-D Secure
detour, and the record has to be dead long before the same reader opens the
same story tomorrow. The empty story id is legitimate: `/firststory`'s ask
sells the season rather than one story and writes `""`.

Two places rebuild the sheet, because the sheet opens in two places:

* **a locked story's boundary** — `read.html` calls `gate.restore()` on the
  gate it just built, and puts the deck back on the boundary card when a trip
  is standing. It lands the reader **on** that card, not past it, so `passed`
  stays false and nothing springs at somebody whose sign-in failed.
* **the end card** — `restoreWall()`, for the ask at the end of `/firststory`
  and for the wall `/story` and `/cleopatra` open over a locked next story.
  None of those runs are locked, so none of them reach the block above.

Both go through the same `restore()`, and it refuses three things. It does not
decide on an answer it does not have: `signedIn()` at build time is a guess, so
it waits on `FBU.ready()` — that wait is the bug this used to have. It does not
sell to somebody who already pays: entitlement is asked **after** identity, via
`FBX.canRead(id)`, which is true for a subscriber, a permanently free story and
today's Factbox alike. And it is one shot — dropped when it has been acted on,
and dropped just as firmly when the trip ended signed out, so an abandoned
sign-in leaves no price waiting on the next page load. "Maybe later", Escape
and the veil all drop it too: a sheet that returns on every reload for half an
hour is one the reader cannot dismiss.

`dropWall()` names `is-auth` and `is-buy` rather than testing the `is-` prefix,
and that is not a tidiness point. `js/recommend.js`'s last-resort pane — the
one it returns when building the sheet throws — is `pane paywall pw is-offer`.
A prefix test matches it, holds it on the screen for ever, and leaves a wall
nobody asked for standing on the body with a subscriber sitting under it.

### 4i. "View other plans" — `.pw-sheet`

Unchanged, and kept although the mockup drops it. Exactly the rungs
`js/account.js` still offers — annual (best value, preselected) and monthly;
quarterly is retired with `offered:false` over there and never reaches this
file. Removing the monthly rung is a change to the offer, and `ONBOARDING.md`
§10 says to ask before touching pricing. Picking calls `FBA.setPlan()`.

### 4j. What is deliberately NOT here

* the mockup's four-step questionnaire and affirmation screens. The redesign
  retired them; see `join.html`.
* a plate of its own. The story's card is behind the sheet, still on screen,
  dimmed by `.fbg-veil` — which is the point of a sheet rather than a screen.
* any countdown, "today only" or scarcity. The offer is the same at four in the
  morning as it is now.

## 5. The layout rule every screen here obeys

**The button is never below `--bottom-safe`, and never below the fold.**

`--bottom-safe` is `max(13vh, inset + 60px toolbar + 4px)`: the line the
Instagram and TikTok in-app browsers draw their own toolbar over, and that is
essentially all of this traffic. So each action group is absolutely positioned
against the bottom — `bottom: calc(var(--bottom-safe) + 8px)` — rather than at
a percentage of the height, which clears the toolbar at every viewport height
rather than at the one the last person tested on.

**The completion card's action group sits on the PANE, not inside the beat it
belongs to**, and is hidden with it by a class. `.ec-p2` scrolls when the copy
is taller than the viewport, and an absolutely positioned child of a scrolling
box scrolls away with its content — the bottom anchor defeated on exactly the
short phones it exists for. It has a second reason too: `tools/compose.py`'s
sign-up block appends its own line beside it.

**The two sheets end their padding on that line rather than on the viewport's**
— `padding-bottom: calc(var(--bottom-safe) + 10px)` — and are absolutely
positioned against the host's floor rather than flowed, because two siblings in
a flex column would reserve space for the hidden one and push the visible one
up the screen by its height.

**What gives way, and in what order, is the order of what things are for.**
Breathing room first (700px). Then the proof slot and the currency note, which
are the two things on the offer that are neither the offer nor the terms
(620px — set above 568 on purpose, because a 320×568 phone is the smallest
viewport this site sees and it has to clear). Then, sideways, the eyebrow and
the sentence under the headline (460px). The price, the button and the terms
never go at any height, because those three are what the reader is agreeing to.

Measured the LAST control on each sheet — "Not now" and "Maybe later", not the
button above them — against the floor in real Chrome, after the open
transition has settled:

| viewport | `--bottom-safe` | floor | last control | sheet scrolls |
|---|---|---|---|---|
| 320×568 | 74 | 494 | 484 | no |
| 375×667 | 87 | 580 | 570 | no |
| 375×812 | 106 | 706 | 696 | no |
| 393×852 | 111 | 741 | 731 | no |
| 430×932 | 121 | 811 | 801 | no |
| 412×915 | 119 | 796 | 786 | no |
| 744×1133 | 147 | 986 | 976 | no |
| 844×390 landscape | 64 | 326 | 316 | no |

**Nothing crosses the floor, nothing scrolls inside a sheet, the body never
scrolls sideways, and there are zero page errors at any of the eight.**

One trap, written down because it cost a measurement: read the rect **after**
the open transition. `.fbg-sheet` opens from `translateY(18px)`, and
`getBoundingClientRect()` mid-transition reports a sheet 18px lower than it
ends up — which reads exactly like a control 18px under the floor.

### Contrast, over the real composited artwork

Measured against the brightest pixel actually painted behind each run, with the
text's own alpha composited onto it — not against a token, and not against a
flat swatch.

The one that failed and why it is worth writing down: `UP NEXT` in
`--accent-ink` measured **1.99:1**. The next story's text block is four lines
tall, so its top edge lands about 39% up the cover, where the band gradient has
already lifted to roughly .9 and a bright plate comes through. Deepening the
band would have cost the painting, so the block got its own local scrim —
`.ec-herotext::before`, `--pane-scrim`, `z-index:-1` — which composites with
the band to about .978 and takes the same label to **7.7:1** while leaving the
top two thirds of the plate exactly as bright as it was.

---

## 6. /firststory asks instead of continuing

`tools/compose.py` builds `story.html`, `cleopatra.html` and `firststory.html`
out of `read.html`. On `/firststory` only, it sets `window.FB_ENDCTA`, which
reaches `endPanel` as `opts.cta`, and a small appended block then swaps the
control for an `<a>` and adds the site's usual "Already have an account? Sign
in" line under it, marking the card `.has-ask`.

**Where that ask goes changed with the rest of this.** It used to navigate to
`/join?from=story`, which was five screens of onboarding questions and is now
the plan screen. Sending a stranger there is sending them to a price with no
account behind it — the exact shape of the bug this rebuild removes: they tap
to pay, checkout refuses because there is no uid to attribute it to, and they
discover they needed an account on a screen that never mentioned one.

So the ask opens **the same sheet the locked-story boundary opens**, over the
end card they are already looking at. Three fallbacks, in order:

1. `window.FB_ENDGATE()`, published by `read.html`'s end-card block. It calls
   `wall(null, { blank:true, from:"story", head:"Read the rest.", keep:<next
   story> })`. `null` for the stack is deliberate: nothing was interrupted, the
   next story on the card may be free, and putting its title on a purchase
   sheet would be selling something that is already open.
2. `FB.checkout(el, "story")` → `/join?from=story`, if the hook is not there —
   an older cached `read.html`, or a story that never loaded.
3. the `href`, if no script runs at all.

All three composed pages still carry the `/join?from=story` string, and
`compose.py`'s build gate now also requires `window.FB_ENDGATE()` on the page
that asks.

Two other consequences of the ask, both unchanged and both deliberate:

* **there is no countdown on that page.** `canAuto` is false whenever
  `opts.cta` is set: walking a reader into the next story while asking them to
  sign up is two screens arguing.
* **`paint()` uses `classList`, never `className`.** The ask block appends
  `has-ask` from outside this file, and an assignment on the next beat would
  take it straight back off — along with every rule in `css/recommend.css` that
  positions the ask.

Because compose matches `FBR.endPanel(s, stacks, { n: 3 })` verbatim, nothing
new may be passed through that call. Four things are set on the returned
element instead: `el.onLocked(stack)`, `el.nextStory`, `el.reveal()` and
`el.leave()`.

---

## 7. Events

No new event name was invented. GA4 caps distinct names and `privacy.html`
lists what we send.

`first_completion_screen_viewed`, `first_story_completed`,
`second_story_shown`, `other_plans_opened`, `annual_selected`,
`monthly_selected`, `trial_cta_clicked`, `rec_view`, `rec_click`,
`paywall_view`, `subscribe_click`, `checkout_start`, `checkout_blocked`.

The last two moved here from `join.html` with the tap that buys. They are the
same two names that page has always sent, with the same parameters, so the
funnel is one funnel and not two.

`paywall_view` now fires when the **sheet opens**, which is when the subscribe
screen is actually shown — the meaning `privacy.html` gives it. It used to fire
when the wall was drawn. A locked story that a reader abandons on card one is
counted by `stack_open` and `stack_dropoff{card}`, which is where it belongs.

The account sheet's controls send no event of their own and arrive as
`ui_click` with `control` set from `data-fbt`: `gate_google`, `gate_apple`,
`gate_email`, `gate_signin`, `gate_notnow`, `gate_later`. Parameter values, not
names.

The auto-advance fires **`rec_click`** — it is the same funnel step as tapping
Start now — with `slot: "auto"` instead of `slot: "1"`. The distinction is a
parameter value, which is free; a second name would have split the funnel.

`paywall_view` was kept rather than renamed for the same reason. Every other
control carries `data-fbt="-"` or falls through to `js/analytics.js`'s one
delegated `ui_click`. No name is built at runtime and nothing typed is ever
sent.

---

## 8. The rail is not part of this

`css/reader-rail.css` owns the Save and sound controls at the foot of the right
edge, **and the reader's palette**. On the completion pane the rail is hidden
entirely: it is the way out of the story rather than part of it, and two
floating controls land on its words. `read.html` toggles `.fb-rail.is-off` and
`.vrail.is-off` from its own scroll handler, and does the same in the tail
below a locked run, where there is no card left for the rail to point at. On
the story itself — including the free run of a locked one — the rail stays,
because a locked story is a story until it is not.

Nothing in `css/recommend.css` names a colour. Every literal in the reader is
in the one `:root` block in `css/reader-rail.css`, which read.html loads last.
