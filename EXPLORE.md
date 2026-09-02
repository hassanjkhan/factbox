# Explore

`explore.html` + `js/explore.js` + `css/explore.css`. Where a reader who just
finished a story goes to find the next one. Sibling of `stories.html`; same
covers, same classes, same tone.

## What is on the page

Search field → filter chips (theme, then kind of story) → a running tally →
the view. With no query and no chip selected the view is the default browse:

| Shelf | Where it comes from |
|---|---|
| Resume strip | `FBP.continueReading(stacks)` — same component as the home shelf |
| Keep reading | `FBP.state` = `reading`, most recently touched first |
| Start here | `stack.free` — hidden once the reader has paid |
| Quickest reads | `secs` ascending, 12 |
| The long ones | `cards.length >= 11` |
| You have not opened these | `FBP.state` = `unread` — hidden until something *has* been read, otherwise it is all 51 |
| Finished | `FBP.state` = `done` |
| Browse by theme | one shelf per `topic`, 8 |
| Browse by kind of story | one shelf per `kind`, 6 |

Every editorial shelf is derived from `secs`, `cards.length`, `kind` or this
browser's own reading memory. Nothing on this page asserts a fact about a story
that the story does not assert itself.

## Display names

`topic` and `kind` are how the data is filed, not how a reader talks. The map
lives in `TOPICS` and `KINDS` at the top of `js/explore.js` — change it there.

- `cleopatra` → Cleopatra · `new_testament` → The New Testament ·
  `church_history` → **Devils, saints and heresies** · `old_testament` → The Old
  Testament · `us_history` → America · `ancient_world` → The ancient world ·
  `medieval_modern` → Medieval and modern · `disaster` → When it all went wrong
- `unsolved_mystery` → Unsolved mysteries · `myth_correction` → Things you have
  wrong · `violent_death` → Deaths · `list_explainer` → The whole thing,
  explained · `moral_reversal` → The turn nobody mentions · `hidden_meaning` →
  Hidden meanings

## Search

Client-side, no network. One lowercased haystack per stack built at load from
title + hook + every card headline + the two display names, so "unsolved" and
"mysteries" find the group as well as the words. Every typed word must appear,
so a second word narrows. Curly apostrophes are folded — nobody types one.
No results renders `.void`: what happened, what search covers, and one tap back
to all 51.

## Rules

- Never throws. Every DOM lookup, every `FB`/`FBP` call and every storage read
  is guarded, and a data failure renders a sentence with a way out — never a
  blank page. `esc` and `minutes` have local fallbacks so a 404 on `gate.js`
  cannot empty the page.
- Works with `FBP` absent: every cover simply renders unread, no shelf breaks.
- ES5 only, plain IIFE, no build step.
- `explore.css` adds only what app.css has no answer for: the search field,
  chips, the horizontal `.shelf`, the `.ghead` dividers and `.void`. Covers,
  locks, read bars and `.sechead` come from app.css untouched.
- Stack `01` links to `story.html`; everything else to `read.html?s=<id>`,
  locked included — the paywall lives in the reader, not here.

## Checks

`rendercheck/checkexplore.js` (add `nofbp` to strip progress.js in memory) and
`rendercheck/checkexplorestate.js` (add `unlocked`) against
`python3 -m http.server 8899 --directory <site>`.
