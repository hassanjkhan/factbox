# The end of a story, and the offer that follows it

`js/recommend.js` + `css/recommend.css`. Two screens, in this order, and the
order is the whole point:

```
story -> completion -> the next story, shown -> the offer -> onboarding
```

A reader meets a complete story, then a moment of having finished it, then
curiosity about the next one, and only then a price.

## 1. The completion screen — `FBR.endPanel()`, `.pane.rec`

| Element | What it says | Where the number comes from |
|---|---|---|
| Badge | a tick, and **STORY COMPLETE** | — |
| Headline | "You just learned something in 4½ minutes." | `FB.minutes(s.secs)`, the same half-minute arithmetic every runtime on the site is printed with |
| Place | `CLEOPATRA · 2 OF 8` | catalogue position within the subject. `· the only one` when the subject holds one; `· 8 of 8, the last` on the last |
| Count | "1 story learned" / "4 stories learned" | `FBP.all()`, counting `done` — **only when `FBP.visible()`** |
| Week | seven dots, today filled, and a label | `FBP.all()` timestamps, one dot per calendar day — **only when `FBP.visible()`** |
| Teaser | "Your next story is ready", with its cover, headline and runtime | `pickNext()` |
| Button | **Keep learning** | a link, a button, or "Back to Explore" — see below |
| Offer | *Unlock Factbox free for 3 days · Then $35.88 a year · Cancel anytime* | `FBA.plans()` and `FBA.trialDays()`. **Never drawn for a reader who already has access.** |

### Never display progress that cannot be computed truthfully

`js/progress.js` gates the reading map: `FBP.visible()` is false unless the
cache is tagged with the account signed in right now. That gate is a shipped
privacy fix — a shared phone was showing one reader's finished ticks to the
next person to pick it up — and this file does not go around it.

So there are two honest cases and both are rendered. When the record is the
viewer's, the count and the days come out of it and the label reads
`THIS WEEK · 5 DAYS`. When it is not, the only thing we know is that this
reader finished a story just now, because we watched them do it: one story is
claimed, one dot is filled, the label reads `YOUR FIRST WEEK`, and **nothing
is said about any other day.** Six empty dots are never presented as a streak.

FBP answers "is this yours?" twice — a synchronous hint at load, then the real
answer once Firebase has spoken — so the card renders and then corrects, the
same rule the shelf and the access gate follow. `read.html` rebuilds it on
`FBP.onChange` for `show` / `hide` / `clear` / `replace` only; `local` fires
from `FBP.mark()` on every scroll frame and rebuilding on that is a loop.

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

### The button has three shapes

| When | Shape |
|---|---|
| there is a next story this reader may open | `<a>` to it |
| there is a next story and they may not | `<button>` that opens the paywall |
| there is no next story at all | `<a>` to `/explore`, reading **Back to Explore** |

The third is the one that used to be a silent loop back to story one. And
`canOpen()` asks the same three questions `js/access.js` does — access, or
permanently free, or **today's Factbox**, which is free for everybody every
day — so the one story that has no padlock never gets one drawn on it.

## 3. The paywall — `FBR.paywall()`, `.pane.paywall`

Not a pricing table. Not three cards.

```
Keep learning.
Your next story is already waiting.
[the cover, large, and the story's name]

TRY FACTBOX — 3 DAYS FREE
  TODAY       $0          Full access
  IN 3 DAYS   $35.88/yr   First charge

[ Keep reading ]
$0 today · Cancel anytime
View other plans        Maybe later
```

**The cover is large on purpose.** The picture is the argument — it is what
makes somebody want in — and the story's own hook is deliberately *not* printed
under the title: for about a third of the corpus the hook opens with the title,
so the two stacked read as the same line printed twice. That shipped, and was
reported as a rendering bug.

There is no countdown, no expiry and no scarcity. The offer is the same at four
in the morning as it is now.

### Why the button does not say "Start my 3 days free"

**It cannot start a trial.** Nothing on the reader page can: checkout is three
Stripe Payment Links reached from the end of `/join`, and this control opens
`/join` at its first question. A button that promises a trial and lands on
"what do you want to remember?" is the same class of untruth as printing $35
when the till takes $35.88.

So the button names what the reader is about to do — carry on reading — and the
trial is on the pane as **terms** rather than as the button's promise. Nothing
about the offer is hidden; only the claim that the tap performs it.

It carries the story with it, twice, because the two carriers fail differently:
`/join?from=<where>&s=<id>` (composed from `FB.joinURL()`, so `from` is still
sanitised in one place) and `localStorage.fb_return_v1`, which is the one that
survives the trip out to Stripe and back.

### "View other plans" — `.pw-sheet`

Exactly the rungs `FBA.plans()` offers, which is two: **Annual**, marked BEST
VALUE and selected on open, and **Monthly**. Quarterly is retired with
`offered:false` in `js/account.js` and never reaches this file. The rung the
offer leads with is listed first — a sheet is a choice with one already made.

Picking a rung repaints the `IN 3 DAYS` row and calls `FBA.setPlan()`, which is
the value `/join` restores when it paints its plan screen, so the price on the
wall and the price on the plan screen are the same one. The CTA does not change
its words; it changes what it carries.

**No price or trial length is written down in this file, in the stylesheet, or
in `read.html`.** Everything comes from `js/account.js`:
`billedText`, `billedLine`, **`perMonthAbout`** (never `perMonthText` —
$35.88 divides into exactly $2.99, $35.00 does not), `trialDays()`,
`trialShort()` and `pricing().symbol`. `tools/check-regressions.js` fails on a
typed dollar figure in any of the three.

## 4. The layout rule both screens obey

**The button is never below `--bottom-safe`, and never below the fold.**

`--bottom-safe` is `max(13vh, inset + 60px toolbar + 4px)`: the line the
Instagram and TikTok in-app browsers draw their own toolbar over, and that is
essentially all of this traffic.

The old end card pinned one button at `top:73%` of a pane exactly one viewport
tall. That worked for four elements. These screens carry eight and eleven, so
the action group is anchored to the bottom instead —
`bottom: calc(var(--bottom-safe) + 8px)` — and the column above reserves that
much padding. Where the copy is still taller than what is left (short phones,
and landscape) the pane scrolls behind a **docked footer** with a hairline,
rather than a fade over moving text, which reads as a rendering fault.

A phone turned sideways is not a short screen, it is a **wide** one, so below
520px of height and above 600px of width both panes become two columns and
spend the width that is going spare. Measured before that rule: the price table
sat 121px behind the action group.

Measured bottoms against the floor, `--bottom-safe` in brackets:

| | 430×932 (121) | 375×667 (87) | 1440×900 (117) | 667×375 (64) |
|---|---|---|---|---|
| completion, last control | 803 / 811 | 572 / 580 | 775 / 783 | 303 / 311 |
| paywall, last control | 803 / 811 | 572 / 580 | 775 / 783 | 303 / 311 |
| sheet, last control | 803 / 811 | — | — | — |

## 5. /firststory asks instead of continuing

`tools/compose.py` builds `story.html`, `cleopatra.html` and `firststory.html`
out of `read.html`. On `/firststory` only, it sets `window.FB_ENDCTA`, which
reaches `endPanel` as `opts.cta`, and a small appended block then swaps the
control for an `<a href="/join?from=story">` and adds the site's usual "Already
have an account? Sign in" line under it, marking the card `.has-ask`.

`.has-ask` is the only thing `css/recommend.css` uses to tell the two apart.
Under it the sign-in line takes the floor and the action group sits one
`--tap` above it, and **the offer line is hidden**: that page's whole button is
the offer, and two of them stacked is the same ask twice.

Because compose matches `FBR.endPanel(s, stacks, { n: 3 })` verbatim, nothing
new may be passed through that call. Two things are set on the returned element
instead: `el.onLocked(stack)` — what Keep learning does when the next story is
not this reader's to open — and `el.reveal()`, which `read.html` calls from its
scroll handler when the reader genuinely arrives, because the card is built a
dozen cards before anyone reaches it.

## 6. Events

`first_completion_screen_viewed`, `first_story_completed`,
`second_story_shown`, `other_plans_opened`, `annual_selected`,
`monthly_selected`, `trial_cta_clicked` — plus the names that already existed
and still fire: `rec_view`, `rec_click`, `paywall_view`, `subscribe_click`.

`paywall_view` was kept rather than renamed: `privacy.html` tells readers that
is what we send, every funnel already counts it, and GA4's distinct-name budget
is managed deliberately. Every other control on both screens carries
`data-fbt="-"` or falls through to `js/analytics.js`'s one delegated
`ui_click`. No name is built at runtime and nothing typed is ever sent.

## 7. The rail is not part of this

`css/reader-rail.css` owns the Save and sound controls at the foot of the right
edge. On the end card the rail is hidden entirely: that pane is the way out of
the story, not part of it, and two floating controls land on its words.
`read.html` toggles `.fb-rail.is-off` from its own scroll handler, and the same
handler hides it on the paywall pane appended after it.
