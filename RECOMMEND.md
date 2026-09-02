# "Read another one" — `js/recommend.js`

One file, one global, `FBR`. It owns the end of a story and nothing else. It
does not fetch, does not write storage, and defines no other global. Every
public function is wrapped in `try/catch`: **it cannot throw.**

Optional friends, all guarded: `FB` (gate), `FBP` (reading memory), `FBS`
(saves). Missing any of them costs a signal or a button, never the panel.

---

## 1. Wiring into `read.html`

```html
<link rel="stylesheet" href="css/recommend.css">   <!-- after css/app.css -->
...
<script src="js/progress.js"></script>
<script src="js/gate.js"></script>
<script src="js/recommend.js"></script>            <!-- after both -->
```

`recommend.css` is additive: it reuses `.pane`, `.plate`, `.lock`, `.go`,
`.ghost`, `.fine` from `app.css` and redefines none of them. Every selector is
scoped to `.rec`.

Replace the `endcard(next)` string with the element:

```js
deck.appendChild(FBR.endPanel(s, stacks, { n: 3 }));
```

(and delete the `endcard()` function plus the `next` loop above it).

## 2. The API

| Call | Returns |
|---|---|
| `FBR.next(current, stacks, n)` | up to `n` ranked rows. `current` may be a stack object **or** an id string; `stacks` may be the array **or** the raw `{stacks:[…]}` payload. |
| `FBR.endPanel(current, stacks, opts)` | a `<section class="pane rec">` **Element**, always. `opts = {n:3, heading, explore, library}`. |
| `FBR.href(stackOrId)` | `"story.html"` for `01`, `"read.html?s=ID"` for everything else. |
| `FBR.reasonFor(current, stack)` | the reader-facing why-line for one pair. |

A row from `next()` is a shallow copy of the stack plus:
`why` (reader sentence), `whyKey` (`topic|kind|resume|done|free|browse|next`),
`locked` (true = this reader cannot open it, **caller must mark it**),
`href`, `score`.

## 3. Ranking, plainly

Same topic **+120**, same kind **+45**, story they started and abandoned
**+90**, unread **+12**, free-when-the-reader-is-locked-out **+60**, already
finished **−400**, locked to this reader **−1200**, plus a fixed 0–16 spread
derived from the id pair.

The two penalties are sized to dominate: a finished story never outranks an
unread one, and a story they cannot open never outranks one they can — but
neither is deleted, so the panel is never empty. The current story is excluded
outright. No `Math.random()` anywhere: the spread is a string hash, so the same
reader state produces the same three covers on every reload, forever.

`endPanel` adds two product rules on top of the ranking:

- **Locked reader:** everything they can open, then at most **one** locked
  cover as a marked teaser (dimmed, padlock, "· Locked"), then one calm buy
  button and the way out. Six padlocks in a row is a nag.
- **One door, not the same door three times:** if all three picks share a
  reason, the last slot goes to the best-ranked candidate with a different one.

## 4. Verified

`rendercheck/checkrec.js` (85 assertions, all 51 stacks) and
`rendercheck/checkrece2e.js` (the panel built by the real scripts over HTTP,
inside a deck, locked and unlocked) and `rendercheck/checkrecsaves.js` (against the real
`js/saves.js`). All pass.
