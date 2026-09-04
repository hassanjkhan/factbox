# The Library, and saved stories

Two new files with one job each.

- **`js/saves.js`** — one global, `FBS`. Bookmarks only. It does **not** store
  reading position or completion; `FBP` already does that and duplicating it
  would guarantee the two disagree.
- **`js/library.js`** — draws `library.html` into `#shelf`. Reads from `FBP`
  and `FBS`, writes nothing except through `FBS`.

`css/library.css` adds only what the shelf did not already have: the stats
line, the empty state, the Remove control on a saved cover, and the
storage-is-dead notice. Covers, grids, section heads, the read bar, the resume
block and the lock treatment are all `app.css`, untouched.

---

## 1. Script tags

**`library.html`** (already wired):

```html
<script src="js/progress.js"></script>
<script src="js/gate.js"></script>
<script src="js/saves.js"></script>
<script src="js/library.js"></script>
```

`progress.js` before `gate.js` for the reason PROGRESS.md gives — `gate.js`
strips the query string at parse time. `saves.js` is independent of both and
can go anywhere before `library.js`.

**`read.html`**, if the save button is wanted there: add one line after
`gate.js`.

```html
<script src="js/saves.js"></script>
```

`saves.js` needs no CSS, no `FB` and no `FBP`. Loading it alone on a page is
fine.

---

## 2. The `FBS` API

Nothing here throws, and nothing here touches the network. Every storage
access is wrapped; a store that refuses writes degrades to `FBS.ok === false`
and everything still returns a sane value for the length of the pageview.

| Call | Returns | Notes |
|---|---|---|
| `FBS.saved(id)` | `true` / `false` | Is this story on the shelf. |
| `FBS.toggle(id)` | `true` / `false` | The state **after** the call: `true` = now saved. |
| `FBS.add(id)` | `true` / `false` | `true` when saved after the call (already-saved counts). `false` only for an unusable id. Re-adding moves it to the front. |
| `FBS.remove(id)` | `true` / `false` | `true` only when something was actually removed. |
| `FBS.all()` | `[{id, at}, …]` | **Newest first.** `at` is ms epoch, `0` if unknown. |
| `FBS.ids()` | `["18","09", …]` | The same list, ids only, newest first. |
| `FBS.count()` | number | Length of the list. |
| `FBS.clear()` | `bool` | Wipes saves. Does not touch reading memory or access. |
| `FBS.ok` | `bool` | **Property, not a function.** `false` when no store will keep a write. Use it to avoid promising to remember. |
| `FBS.button(id, onChange)` | `HTMLButtonElement` or `null` | See below. |
| `FBS.KEY` | `"fb_saved_v1"` | The one localStorage key, exposed so nothing else has to guess it. |

An id must be a string or a number, non-empty, 40 characters or less.
Anything else — an object, `NaN`, `null` — is rejected and never reaches the
store, so a junk value can never render as a cover for a story that does not
exist.

### `FBS.button(id, onChange)`

A real `<button>` with `type="button"`, `aria-pressed`, an `aria-label` that
changes with state, and a 44px minimum target. **Styled entirely with inline
styles**, so it needs no stylesheet and no stylesheet can break it.

```js
var save = FBS.button(s.id, function (isSaved) {
  FB.track(isSaved ? "save_add" : "save_remove", { stack: s.id });
});
if (save) someContainer.appendChild(save);
```

- `onChange(isSaved, id)` fires after every successful toggle.
- `el.refresh()` repaints from the store — call it if saves change elsewhere
  on the same screen.
- `el.stackId` is the id it is bound to.
- Reads `＋ Save` / `✓ Saved`. When storage is dead it paints
  **"Saving unavailable"** and disables itself, because a save button that
  silently forgets is worse than one that says so.
- Returns `null` only when there is no DOM at all.

---

## 3. Storage shape

One key, `fb_saved_v1`:

```json
{"v":1,"s":[["18",1788326057],["09",1788322057]]}
```

Ids and **seconds**, newest first. Every stack in the season saved is still
under a kilobyte. Capped at 200 entries with oldest evicted first, an 8 KB
ceiling, and a shrink-and-retry on a quota error. A store that accepts a write
and hands back something else — a couple of in-app webviews do exactly this —
is detected at load by a probe write and counts as dead.

---

## 4. What `library.html` shows

In order, and each section is omitted entirely when it is empty:

1. **Stats line** — see below.
2. **Membership line** — `Member · all 51 stories unlocked`, small capitals in
   `--accent-ink`, and only for a reader `FBX.owns()` says actually bought the
   season. See §7.
3. **Continue reading** — `continueOf(stacks)`, local to `js/library.js`, as
   the wide `.resume` block. It filters locked stacks against the same `OPEN`
   the covers were drawn from, so it can never offer something the reader
   cannot open — and it is **not** `FBP.continueReading()`, for the reason in
   §7.
4. **In progress** — every stack whose `FBP.state()` is `"reading"`, most
   recently touched first, showing `Card 6 of 8` and the `.readbar`.
5. **Finished** — status `"done"`, most recently finished first, with the
   existing `.is-done` check.
6. **Saved for later** — `FBS.ids()`, newest first, each with a quiet
   **Remove** control. A saved id no longer in the season is skipped rather
   than drawn as a broken cover.
7. **Empty state** — for a reader with nothing at all. The owner's spec, and
   it is short: the heading `Your library is empty`, **no subtitle
   paragraph**, and one button reading **`Explore all stories`**. The free
   covers follow it under "Start with these", so the page is never one box on
   an empty screen.
8. **Storage notice** — only when `FBP.ok === false` or `FBS.ok === false`.

Stack `01` links to `story.html`; everything else to `read.html?s=ID`. Locked
stacks keep the existing `.locked` / `.lock` treatment.

### The stats line

Three numbers, each derived from storage that already exists:

- **stories finished** — count of stacks with status `"done"`.
- **cards read** — every card of a finished stack, plus `furthest + 1` of one
  in progress.
- **about N min** — each stack's own listed `secs`, pro-rated by the share of
  its cards read, summed. It keeps the word **about** because it is an
  estimate from each story's listed length, not a measurement of time spent —
  nothing here records a clock.

**There are no streaks and no "time spent".** Neither can be computed from
what is stored — there is no visit history and no clock — and a number a
reader cannot check is a number they are right to distrust.

---

## 5. Honest limitations

1. **Saves live in one browser.** They are never sent anywhere, so there is
   nothing to leak and nothing to restore. Clearing site data loses them, and
   Safari's tracking prevention can evict script-written storage after roughly
   seven days without a visit. Fixing that needs a server.
2. **Private mode and some in-app webviews refuse storage.** There, `FBS.ok`
   is `false`: saving lasts the pageview and the shelf is empty on reload. The
   page says so rather than pretending.
3. **The library only ever shows stories in the current season.** A saved id
   that is dropped from `stacks.json` disappears from the shelf silently.
4. **`at` for a save is the moment it was saved**, not the moment it was read.
   The in-progress and finished sections order by `FBP`'s timestamp instead.

---

## 6. Verification

`node --check` passes on `js/saves.js` and `js/library.js`.

**68 assertions across two harnesses, all passing**, run against the real
`library.html` and the real `stacks.json` over HTTP.

`rendercheck/checklibrary.js` — 55 assertions:

```
=== 1. seeded library (2 reading, 2 finished, 2 saved, unlocked) ===
  script errors : none
  sections      : {"Continue reading":0,"In progress":2,"Finished":2,"Saved for later":2}
  continue      : Cleopatra's body has never been found — Continue from card 6
  in progress   : read.html?s=03, read.html?s=05        (newest first)
  finished      : read.html?s=02, read.html?s=04        (newest first)
  saved         : read.html?s=18, read.html?s=09        (newest first)
  card label    : Card 6 of 8
  stats line    : 2 stories finished · 32 cards read · about 7 min
  after Remove  : {"Saved for later":1} | FBS.count() 1
=== 2. brand-new reader, nothing in storage ===
  empty heading : Your library is empty.   free covers: 2   no stats invented
=== 3. localStorage throws on every access ===
  FBS.ok === false | no call throws | page renders | warning shown | 761 chars
  button        : Saving unavailable | disabled true
=== 4. FBS store: round trip, ordering, button ===
  all() newest first, toggle round-trips, re-save moves to front,
  junk ids never reach the store, aria-pressed flips, min-height 44px
55 assertions, 0 failed
```

`rendercheck/checksaves-standalone.js` — 13 assertions: `saves.js` loading and
working with **no `FB` and no `FBP`** on the page, and the locked treatment —
a reader who has not paid sees their two paid saves as `.locked` with the lock
glyph, the free one open, and no continue-reading block offering a locked
stack.

`node rendercheck/checkdata.js library.html ".card" "Your library"` → PASS.

`read.html`, `stories.html`, `credits.html`, `css/app.css`, `js/gate.js`,
`js/progress.js`, `explore.*` and `recommend.*` were not modified.

---

## 7. The mockup pass, September 2026

`/library` was rebuilt against panel **1b** of the design mockup. Most of it
did not need rebuilding: `.mast`, `.tabs`, `.acct-btn`, `.sechead`, `.grid`,
`.card`, `.plate`, `.freetag`, `.lock`, `.readbar` and `.resume` in
`css/app.css` already **are** the mockup, token for token — the panel's
`repeat(auto-fill,minmax(148px,1fr))` with `gap:16px 13px`, its 34px avatar on
`rgba(59,158,244,.14)` with a `rgba(27,95,168,.32)` ring, its 2px underline
under the current tab, its 22px done-check bottom-right, all of it. The
mockup's own arithmetic for the stats line (`Math.max(1, Math.round(secs/60))`,
`doneWord`, `pct + "% in"`, `n + " stor(y|ies)"`) is character-for-character
what `js/library.js` was already computing.

Four things changed.

### 7.1 The membership line — new

`Member · all 51 stories unlocked`, `.libmember`, directly under the stats.
The count is `stacks.length` — the season that was actually fetched, never a
number typed into a file.

It is gated on **`owns()`, not `can()`**, and that distinction is the whole
rule. From `js/access.js`: *"Padlocks are a can() question. Any sentence about
entitlement is an owns() question."* An admin flag and a laptop in owner mode
both open all fifty-one stories and neither of them paid for one; telling the
site's own owner they had bought the season is the bug those two functions
were split apart to prevent. `OWNS` therefore starts **`false`** — the
opposite of `OPEN`, and for the opposite reason. Guessing "open" wrong shows a
paying reader one frame of a padlock. Guessing "member" wrong tells somebody
they have a subscription they do not have.

`FBX.paint(fn)` hands over `(can(), why())`, and both are compared before a
redraw: they move independently, and an admin flag landing must take the
padlocks off without congratulating anybody on a purchase.

### 7.2 `FBP.continueReading()` is gone

Replaced by `continueOf()`, local to `js/library.js`. **`FBP.unlocked()` is
not a pure read** — it heals the unlock flag out of the cookie mirror back
into localStorage, and `FBP.continueReading()` calls it. On this page that
would re-mint the exact flag signing out has to clear. `/account` carries the
same note and works around it the same way.

The access question goes to `FBX` instead, through the same `OPEN` the covers
were drawn from, which is a second gain: the resume block and the grid under
it now answer to one variable, so the page cannot offer a story the grid
beneath it is padlocking.

### 7.3 The FREE ribbon is the permanent flag

`s.free` from `data/index.json`, and nothing else. Never "readable right now":
today's pick is open today and locked on Thursday, and a ribbon promising
otherwise is a lie with a date on it. Padlocks are `FBX.can()`; the ribbon is
the catalogue.

### 7.4 The masthead tile

`library.html` was the only page of the five with a masthead and no logo tile
— `/`, `/explore`, `/account` and `/settings` all carry it, and Explore and
Library are two tabs of one screen, so the wordmark jumped sideways by 31px
every time a reader moved between them. `app.css` already styles `.mark img`;
nothing is new but the tag. This is a deliberate departure from panel 1b,
which draws the wordmark alone.

---

## 8. No pricing anywhere in this row

The owner's rule, verbatim: *"Journey 2 · Signed in and subscribed. Explore
and Library are 1a and 1b. **No pricing anywhere in this row.**"*

So a signed-in subscriber must see no price, on `/`, `/explore` or `/library`.
Audited in real Chrome, subscribed, by walking the rendered DOM and testing
every visible text run against a regex for money, periods, trials, plans,
upgrades, checkout and billing.

- **`/library` — zero hits**, visible or in the DOM. 595 characters of text and
  fifteen links, none of which leaves the reading surface: `/explore`,
  `/library`, `/read`, `/cleopatra`, and the standing footer row.
- **`/` and `/explore` — zero real hits.** The two matches on both pages are
  the story title *"Joan of Arc's **trial** reversed"*, which is a story, not
  an offer. There is no price string, no plan, no upgrade nudge and no route
  to one in a single tap: the only outbound links are `/read`, `/cleopatra`,
  `/library`, `/explore`, `/account`, `/credits`, `/privacy`, `/terms`,
  `/support`. `js/today.js` already tells a subscriber *"You have all
  fifty-one. New stories are added through the season."* — and it picks that
  sentence with `FBX.owns()`, for the same reason §7.1 does.

Nothing to fix in the row. The rule holds today; what would break it is a
paywall redesign dropping a "see the plans" row onto a shelf, so this section
is where to check.

### What `/library` measured

Real Chrome, `tools/serve-like-pages.py` on 8899, `/explore` confirmed 200
first. Three states, seeded with 2 reading, 2 finished, 2 saved.

```
signed out          empty state, "Your library is empty", "Explore all
                    stories", no subtitle. NO history: 0 stats, 0 member line,
                    0 progress covers. Verified against the LIVE Firebase SDK,
                    not a stub — js/auth.js hands the answer to
                    js/progress-sync.js, whose settle() calls forget() and
                    DELETES fb_read_v1 and fb_cache_owner_v1 outright. Traced
                    to the stack frame. The privacy fix is load-bearing and
                    was not weakened.
signed in, no sub   stats "2 stories finished · 32 cards read · about 12 min",
                    NO member line, NO Continue reading (its only candidate is
                    locked), 5 padlocks, 1 FREE ribbon, order newest-first
                    03,05 / 02,04 / 18,09.
subscribed          + "Member · all 51 stories unlocked", + Continue reading
                    "75% in / Continue from card 6", 0 padlocks, 1 FREE ribbon
                    (unchanged — it is the permanent flag).
pageerror           0 in all three.
no JavaScript       179 characters of real words: wordmark, both tabs, "Your
                    library", the standfirst, "Finding where you left off…",
                    the footer row.
```

Contrast, every text run against its real composited ground, subscribed:

```
10.14  h1, current tab, section heads, .statline b, .card h3
 6.34  standfirst, .statline
 6.27  FREE ribbon on --coral
 5.79  .resume .t span
 5.24  .mark, .libmember (11px/500), .card.is-reading .meta
 5.10  unselected tab, .meta, .unsave, .fine
```

Lowest run 5.10:1. Nothing under 4.5.

Responsive, 375 / 390 / 430 / 768 / 1024 / 1440 / 1920 and landscape 932×430:

```
375-768   full width, 18px gutters, 2 columns to 430, 4 at 768
1024+     the .lib container caps at its 900px max-width and centres:
          62px margins at 1024, 270px at 1440, 510px at 1920, 5 columns
          of 162px. The covers do not stretch; a section holding two
          stories fills two cells and leaves the rest, which is what
          auto-fill is for.
932x430   900px container, 16px margins, 5 columns.
every size   no horizontal scroll, and nothing tappable below
             --bottom-safe (measured 64-140px depending on viewport).
```

**Known, not fixed, not mine:** the footer `.fine` links (Account · Artwork
credits · Privacy · Terms · Support) measure 16px tall against a 44px target.
`.fine` is `css/app.css`'s and the row is byte-identical on `/`, `/explore`
and `/library`, so fixing it on one page would break the three apart. The
wordmark (24px) and the account disc (34px) both look short to a bounding-box
measurement and are not: `app.css` gives each an invisible 44px band in a
`::after`, deliberately, so the header's baseline does not move.
