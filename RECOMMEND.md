# The end card

`js/recommend.js` + `css/recommend.css`. What a reader sees when a story runs
out.

## What it is

One story and one button.

| Element | What it says |
|---|---|
| Progress | `CLEOPATRA · 1 OF 8` — the subject, and where they are in it, a segment per story |
| Headline | Want to know what happened next? |
| Subhead | Keep going. There's more to Cleopatra, and it gets stranger. |
| Plate | The cover they just finished, 4:3, with a tick, its title and runtime |
| Button | **Continue** — an `<a>` to the next story they can open, or a `<button>` to checkout when there is none |

## Why it is one thing and not nine

It used to be three ranked covers, a Save beside each, the offer, and three
links back to a shelf that the "← Stories" pill already reaches. That is nine
tappable things at the highest-intent second on the site — the moment someone
has just finished something and is deciding whether to have another.

## Two details that are load-bearing

**The button sits at 73% of the pane, in viewport units.** `top:73%` inside a
pane that is exactly one viewport tall is correct; the padding that reserves
room below it is `27vh`, not `27%`, because percentage padding resolves against
*width* — on a 430×932 phone that is 116px where 252px was meant, and the
button lands on the in-app browser's toolbar where it cannot be tapped.

**The subhead centres itself with a heavier selector than app.css.** It is
`max-width:32ch`, so it has to. `.pane p{margin:0}` in app.css is 0-1-1 and beat
the old `.ec-sub` at 0-1-0, which pinned the paragraph to the pane's left
padding at every width where 32ch fits — 22px left, 188px right inside a 560px
pane. `.pane.rec .ec-sub{margin:0 auto}` is 0-3-0 and wins. One `margin`
shorthand, never `margin-inline` with a shorthand after it.

**The subhead names the subject after a preposition.** "There's more to X", not
"X's story". Two of the eight subjects are plural phrases and the possessive is
not a sentence for them. And when a subject holds only one story — `disaster`
does — the phrase names the subject the reader is actually being sent to
instead, because "there's more to disasters" is a claim they can disprove in
one tap.

## /firststory asks instead of continuing

`tools/compose.py` builds `story.html`, `cleopatra.html` and `firststory.html`
out of `read.html`. On `/firststory` only, it sets `window.FB_ENDCTA`, which
reaches `endPanel` as `opts.cta`, and a small appended block then swaps the
control for an `<a href="/join?from=story">` and adds the site's usual
"Already have an account? Sign in" line under it, marking the card `.has-ask`.

`.has-ask` is the only thing `css/recommend.css` uses to tell the two apart, so
the end card every other story ends on is untouched. Under `.has-ask` the
button and the sign-in line share one anchor line, clamped to
`min(73%, 100% - var(--bottom-safe) - 84px)`: 73% plus a fixed 76px clears the
in-app toolbar only above ~543px of viewport, and a phone turned sideways is
below it.

## The rail is not part of this

`css/reader-rail.css` owns the Save and sound controls at the foot of the right
edge. On the end card the rail is hidden entirely: that pane is the way out of
the story, not part of it, and two floating controls land on its words.
`read.html` toggles `.fb-rail.is-off` from its own scroll handler.
