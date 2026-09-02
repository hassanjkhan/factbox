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
2. **Continue reading** — `FBP.continueReading(stacks)`, as the wide `.resume`
   block. Already filters locked stacks, so it can never offer something the
   reader cannot open.
3. **In progress** — every stack whose `FBP.state()` is `"reading"`, most
   recently touched first, showing `Card 6 of 8` and the `.readbar`.
4. **Finished** — status `"done"`, most recently finished first, with the
   existing `.is-done` check.
5. **Saved for later** — `FBS.ids()`, newest first, each with a quiet
   **Remove** control. A saved id no longer in the season is skipped rather
   than drawn as a broken cover.
6. **Empty state** — for a reader with nothing at all: what the shelf is for,
   a link to Explore, a link to the season, and the free stories underneath.
7. **Storage notice** — only when `FBP.ok === false` or `FBS.ok === false`.

Stack `01` links to `story.html`; everything else to `read.html?s=ID`. Locked
stacks keep the existing `.locked` / `.lock` treatment.

### The stats line

Three numbers, each derived from storage that already exists:

- **stories finished** — count of stacks with status `"done"`.
- **cards read** — every card of a finished stack, plus `furthest + 1` of one
  in progress.
- **about N min** — each stack's own listed `secs`, pro-rated by the share of
  its cards read, summed. It is labelled *about*, and one line of small print
  says it is estimated from the listed length rather than measured.

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
