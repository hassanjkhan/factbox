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

## 4. The wall — `FBR.paywall()`, `.pane.paywall`

Two screens on one pane. `.is-cut`, then `.is-offer`.

### 4a. The interruption — `.pw-cut`

```
 [ the story's plate, faded back ]

  Genghis Khan built the largest
  contiguous land empire in history.

  Then he made sure nobody could find his
  grave. Genghis Khan died in 1227, but the
  location of his burial remains ▓▓▓▓▓▓▓

  [      Continue      ]
```

The story is already running and it stops mid-thought. **Nothing is sold on
this screen and no number is on it** — a price flashed over a cliffhanger that
has not landed reads as an advertisement rather than as an interruption.

Every word is the story's own. The headline is `cards[0].head`, or the hook if
the caller had no cards at all. The paragraph is `cards[0].body` — and where
that is missing, the next card's line, which is not a nicety:

* a locked story opened directly arrives through `FB.loadStory()`, the whole
  file, and card one has a body;
* the same wall reached from the end of another story arrives through
  `FB.loadIndex()`, whose rows carry card **heads and no bodies at all**.

Without the fallback every wall reached that way was a headline over an empty
screen. Either way it is one card past the hook, and it fades out mid-sentence.
**Nothing here fetches anything** — it reads what the caller was already
holding, which is the same discipline the plate pager in `read.html` follows.
Nothing is written for this screen either, because a cliffhanger somebody
invented is a cliffhanger the story does not answer.

The whole screen advances on a tap — the same gesture the reader has used
between every other card — and there is a real `<button>` on it as well,
because a screen whose only affordance is "tap anywhere" cannot be reached from
a keyboard and does not say what happens next. `.pw-cut` does not scroll: the
paragraph is cut off by design, and a box you can scroll to read the rest of it
is the opposite of an interruption.

### 4b. The offer — `.pw-offer`

```
 [ the story's cover, a band across the top ]
  UNLOCK FACTBOX
  Finish the story.
  And unlock every story in Factbox. Your
  next story is already waiting.

  $35.88/year
  Less than $3 a month

  [ Unlock & keep reading ]
  3 days free · $0 today · Cancel anytime
  View other plans      Maybe later
```

**Not one figure on that screen is typed.** Every one is read out of
`js/account.js`, which is the single place that knows what Stripe charges:

| On screen | Read from |
|---|---|
| `$35.88` | `plan.billedText` — the charge, to the cent |
| `/year` | `perLong(plan)`, off `intervalUnit` / `intervalCount`, so a plan billed every three months could never be labelled `/year` |
| `Less than $3 a month` | `underMonth(plan)`: `perMonthCents` rounded **up** to the next whole unit, with `pricing().symbol` in front of it |
| `3 days free` | `FBA.trialShort()` |
| `$0 today` | `zero()` — the symbol and a nought, which is the one figure here that is not a price but the absence of one |

The mockup this screen is cut from renders **`$35` `/year`**. Stripe charges
**$35.88**. The rule, from the owner: *never display $35 if Stripe will
actually charge $35.88; pricing displayed to users must exactly match what they
authorize.* So the layout and the typography were taken and the number was not.

`underMonth()` earns its own paragraph. "Less than $3" is true today because
$35.88 ÷ 12 is $2.99, but it is a claim about a number, and a person typing it
is a person who will not be here when the number moves. So it is derived:
round the per-month figure **up**, never down, and if the plan divides into
whole units exactly — a hypothetical $36.00 a year — the claim is false and is
not made, and `perMonthAbout` is printed instead. Nothing rounds in our favour.

`tools/check-regressions.js` greps `js/recommend.js`, `css/recommend.css` and
`read.html` for a dollar sign followed by a digit and fails the build on one.
That guard is why `firstSentence()` uses a replacer function rather than `"$1"`
in a regex: a capture-group reference and a typed price look identical to a
grep, and the honest fix is to stop writing the thing that looks wrong.

### Why the button does not say "Start my 3 days free"

**It cannot start a trial.** Nothing on the reader page can: checkout is three
Stripe Payment Links reached from the end of `/join`, and this control opens
`/join` at its first question. A button that promises a trial and lands on
"what do you want to remember?" is the same class of untruth as printing a
round number when the till takes 88 cents more.

So the button names the outcome the reader is buying — unlock, and carry on
reading — and the trial is on the pane as **terms** under it rather than as the
button's promise. Nothing about the offer is hidden; only the claim that the
tap performs it.

It carries the story with it, twice, because the two carriers fail differently:
`/join?from=<where>&s=<id>` (composed from `FB.joinURL()`, so `from` is still
sanitised in one place) and `localStorage.fb_return_v1`, which `read.html`
writes and which is the one that survives the trip out to Stripe and back.

### What is deliberately NOT here

The mockup puts four screens between the interruption and checkout: one
question, one affirmation, "Save your progress" with Continue with Google and
Continue with email, and a Stripe hand-off. **None of them is built.**
Onboarding is `/join`'s, it is being redesigned separately, and a second copy
of those screens living on the reader page would be a second thing to keep in
step with it. Where the flow would ask for an account it hands off to
`/join?from=paywall&s=<id>`, exactly as it did before.

The affirmation screen's `71%` and `78%` are marked in the mockup's own source
as unverified placeholders. They are not here either, and nothing on these two
screens states a statistic.

### "View other plans" — `.pw-sheet`

Exactly the rungs `FBA.plans()` offers, which is two: **Annual**, marked BEST
VALUE and selected on open, and **Monthly**. Quarterly is retired with
`offered:false` in `js/account.js` and never reaches this file. The rung the
offer leads with is listed first — a sheet is a choice with one already made.

Picking a rung repaints the amount and the per-month line and calls
`FBA.setPlan()`, which is the value `/join` restores when it paints its plan
screen, so the price on the wall and the price on the plan screen are the same
one. The CTA does not change its words; it changes what it carries.
`perMonthAbout`, never `perMonthText`.

---

## 5. The layout rule all four screens obey

**The button is never below `--bottom-safe`, and never below the fold.**

`--bottom-safe` is `max(13vh, inset + 60px toolbar + 4px)`: the line the
Instagram and TikTok in-app browsers draw their own toolbar over, and that is
essentially all of this traffic. So each action group is absolutely positioned
against the bottom — `bottom: calc(var(--bottom-safe) + 8px)` — rather than at
a percentage of the height, which clears the toolbar at every viewport height
rather than at the one the last person tested on.

**Both action groups sit on the PANE, not inside the screen they belong to**,
and are hidden with it by a class. `.ec-p2` and `.pw-offer` scroll when the
copy is taller than the viewport, and an absolutely positioned child of a
scrolling box scrolls away with its content — which is the bottom anchor
defeated on exactly the short phones it exists for. `.ec-act` has a second
reason: `tools/compose.py`'s sign-up block appends its own line beside it.

Measured last controls against the floor, `--bottom-safe` in brackets, in real
Chrome at 375×667 (87), 390×844 (110), 430×932 (121), 768×1024 (133),
1440×900 (117), 1920×1080 (140) and 844×390 landscape (64): **nothing on either
pane crosses it, and nothing is off screen.**

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
control for an `<a href="/join?from=story">` and adds the site's usual "Already
have an account? Sign in" line under it, marking the card `.has-ask`.

Two consequences, both deliberate:

* **there is no countdown on that page.** `canAuto` is false whenever
  `opts.cta` is set: walking a reader into the next story while asking them to
  sign up is two screens arguing.
* **`paint()` uses `classList`, never `className`.** The ask block appends
  `has-ask` from outside this file, and an assignment on the next beat would
  take it straight back off — along with every rule in `css/recommend.css` that
  positions the ask.

Because compose matches `FBR.endPanel(s, stacks, { n: 3 })` verbatim, nothing
new may be passed through that call. Three things are set on the returned
element instead: `el.onLocked(stack)`, `el.reveal()` and `el.leave()`.

---

## 7. Events

No new event name was invented. GA4 caps distinct names and `privacy.html`
lists what we send.

`first_completion_screen_viewed`, `first_story_completed`,
`second_story_shown`, `other_plans_opened`, `annual_selected`,
`monthly_selected`, `trial_cta_clicked`, `rec_view`, `rec_click`,
`paywall_view`, `subscribe_click`.

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
edge, **and the reader's palette**. On both panes the rail is hidden entirely:
they are the way out of the story rather than part of it, and two floating
controls land on their words. `read.html` toggles `.fb-rail.is-off` and
`.vrail.is-off` from its own scroll handler.

Nothing in `css/recommend.css` names a colour. Every literal in the reader is
in the one `:root` block in `css/reader-rail.css`, which read.html loads last.
