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

**The subhead names the subject after a preposition.** "There's more to X", not
"X's story". Two of the eight subjects are plural phrases and the possessive is
not a sentence for them. And when a subject holds only one story — `disaster`
does — the phrase names the subject the reader is actually being sent to
instead, because "there's more to disasters" is a claim they can disprove in
one tap.

## The rail is not part of this

`css/reader-rail.css` owns the Save and sound controls at the foot of the right
edge. On the end card the rail is hidden entirely: that pane is the way out of
the story, not part of it, and two floating controls land on its words.
`read.html` toggles `.fb-rail.is-off` from its own scroll handler.
