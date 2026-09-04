# Explore

`/` and `/explore` serve the same page — the home page. `index.html` and
`explore.html` are byte-identical below the `<head>`; both load `js/today.js`
and `css/today.css`. `/stories` forwards here, carrying its query string,
because Stripe's success URL is set in the Stripe dashboard and points there.

The page was rebuilt in September 2026 against a design mockup drawn at
390×844. What follows is what is on it and which of its parts are load-bearing.

## What is on the page, in order

1. **Masthead** — logo tile + FACTBOX wordmark, the way home.
2. **Tabs** — Explore / Library, with the account insignia pushed right.
   Both tab styling and the insignia are `css/app.css` + `js/acct.js`; this
   page owns neither. The insignia has two states and they are the mockup's:
   an initial in a blue disc signed in (`.acct-btn.is-in`), a CSS-drawn person
   glyph in a quiet disc signed out.
3. **Headline and subtitle.** Both are in the HTML, not built by script, so
   the page has real words on it with JavaScript disabled. The headline is set
   in `--display` (Newsreader 500) at 34px on a 390px phone.
4. **The streak line** — `<b>5</b> day streak · <b>15</b> min learned`.
   Signed-in only, and only because `js/progress.js` gates reading memory on
   the account that owns it. Signed out this slot is empty and collapses.
5. **Continue** — the most recently touched unfinished story, with its bar.
6. **Today's Factbox** — a 16/10 plate, the eyebrow, the hook in the display
   serif, the facts line, and the Start story pill.
7. **Trending now** — a horizontal rail of 136px covers (158px above 700px).
8. **Binge a series** — one row per subject, opening the next unread story.
9. **All stories** — the mosaic: all 51, edge to edge, on `--night`.

## The two fonts

DM Sans is the site. **Newsreader** is `--display` in `css/app.css` and sets
exactly two things here: the `h1` and Today's hook. A token cannot fetch a
font, so **both `index.html` and `explore.html` carry Newsreader in their
Google Fonts `<link>`**. Drop that and the two headlines fall to Georgia,
which is the fallback in the token and the reason the page still reads.

## Titles and hooks are cleaned

Three hooks in `data/index.json` end in a markdown source link — stack 09 to
the IAEA, 10 to Vatican News, 08 mid-sentence. `clean()` in `js/today.js`
strips the markup and keeps the link text; `firstSentence()` then cuts the
hook to its first sentence. 33 of the 51 hooks are shortened by it, from an
average of 126 characters to 74. **A citation must never appear in a
headline** — the credit belongs on the card, where `read.html` draws it.

## The mosaic, and the two things it has to get right

The rhythm is `m = i % 8`: `m === 0` is a 2×2, `m === 5` is a tall tile,
everything else is a square. It is a function of the story's index, so story
27 is the same shape on every load.

1. **Rows must not collapse.** A CSS grid sizes an implicit row from the
   tallest thing that STARTS in it, and this layout has rows holding nothing
   but the lower halves of tiles that began above. `layoutMosaic()` measures
   the mosaic, divides by the column count and writes that back as an explicit
   `grid-auto-rows` length, so no row can depend on its contents. **Do not put
   `grid-auto-rows` back in `css/today.css`.**
2. **The tail must not leave holes.** 51 divides by nothing useful.
   `mosAttempt()` lays every tile into a real occupancy grid and refuses to
   return a plan unless cells-used === rows × cols with every cell covered;
   `mosPlanFor()` raises the number of widened tail tiles until one comes back
   clean, then falls back to plain squares, which always fits. A plan that
   cannot be made flush is discarded rather than drawn.

Spans and the row height are written in the same pass and never exist without
each other. If the script never runs, neither is written and `css/today.css`
draws 51 plain squares — duller, not broken.

**There is no `grid-auto-flow: dense`, deliberately.** The packer's scan
order IS the CSS sparse auto-placement algorithm, and because the plan
guarantees every tile fits where the scan reached, the browser reproduces the
plan exactly. `dense` back-fills and would diverge from the verified plan.

The pill — "Card 4 of 12" — is drawn for `.is-reading` only. The catalogue
line is inventory, and inventory painted over 51 museum plates is not a reason
to tap any of them. The `.meta` element always exists and is clipped rather
than `display:none`, so it stays in the link's accessible name and
`applyLocked()` / `applyOpen()` go on rewriting it.

## What must keep working

- **`FBX` is the only answer to "may this person read?"** Padlocks come from
  `FBX.can()` via `FBX.paint()`; the "you own it" subtitle from `FBX.owns()`,
  which is narrower — an admin reads everything and bought nothing.
- **Render open, correct afterwards.** Covers are drawn with no padlocks and
  the account's answer decorates them. Never the reverse: a paying reader
  looking at locks on stories they bought has shipped twice.
- **The FREE ribbon comes from the permanent `free` flag, never from
  "readable right now".** Today's pick is open today and locked on Thursday.
  `data-free` is the padlock's question and is wider (free **or** today);
  the ribbon is `s.free` alone. Verified: the ribbon count is 3 in all three
  reader states.
- **Today's pick comes from `js/access.js`** — `FBX.todayOf()`, which
  registers the catalogue on the way past so `FBX.isToday()` answers
  synchronously everywhere else, with `FBX.onToday()` for the backend's
  answer. The local arithmetic at the bottom of `todayPick()` is reached only
  when there is no `access.js` at all. **Do not add a second date
  calculation.**
- **The `.card` contract**: `data-id`, `data-free`, `data-meta`, `data-label`,
  `data-pct` and the `is-unread` / `is-reading` / `is-done` / `is-free`
  classes. Other code decorates these without knowing which section drew them.
- **Nothing tappable below `--bottom-safe`.** That is Instagram's toolbar.
- **ES5 only.** `var` and `function`. `js/auth.js` is the sole exception on
  the page and it is a module.

## Wide windows

The column is `css/app.css`'s 900px at every width — 1024, 1440 and 1920 show
the same page, centred. Above 1024 Today's Factbox lays the painting beside
the words instead of above them, and the mosaic comes inside the column with a
radius on it. Measured column counts: 3 up to 540px of mosaic, 4 to 820, 5 to
1100, 6 beyond — which on a 900px column means 5 at every desktop size.

## js/explore.js

Not this page's layout. It publishes `window.FBTAX = { TOPICS, KINDS }` — the
season's own names for things, read at call time rather than at load because
`js/recommend.js` may run first. It is the one place a subject is named;
`js/recommend.js`, `js/today.js` and the end card each carry a fallback copy,
so a rename happens here first and the fallbacks follow.

The `lower` form exists because the end card says "There's more to X".
"Devils, saints and heresies's story" is not a sentence; naming the subject
after a preposition reads correctly for all eight.
