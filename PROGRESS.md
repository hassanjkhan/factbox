# Paid access that survives, and reading memory

`js/progress.js` — one file, one global, `FBP`. It does not define, redefine or
require `FB`; it only agrees with it. If `gate.js` never loads, `FBP` still
works. If `progress.js` never loads, nothing else breaks.

Everything below is verified under jsdom — 91 assertions plus a whole-page
render, output at the bottom.

---

## 1. Where the script tags go

**`progress.js` must load BEFORE `gate.js`.** This matters and is easy to get
wrong:

`gate.js`'s `claim()` runs at parse time and does
`history.replaceState({}, "", location.pathname + location.hash)`, which throws
away the entire query string. If `progress.js` runs after that, Stripe's
`session_id` is already gone.

```html
<script src="js/progress.js"></script>
<script src="js/gate.js"></script>
```

in **`stories.html`** and **`read.html`**, replacing the existing lone
`<script src="js/gate.js"></script>` line.

Loading it after `gate.js` is not fatal — it detects the already-set unlock
flag and mints a local token instead — it just loses Stripe's id.

**One Stripe change to go with it.** Set the Payment Link's success URL to:

```
https://factbox.app/stories.html?unlocked=1&session_id={CHECKOUT_SESSION_ID}
```

Stripe substitutes the placeholder. It is not required — everything works
without it — but it makes each buyer's restore token a real Stripe checkout
session id, which means if a server is ever added, every restore link already
in the wild becomes verifiable against Stripe with no reissue. If the success
URL is misconfigured and the literal `{CHECKOUT_SESSION_ID}` comes back, that
is detected and a local token is used instead.

**`story.html`** (the illustrated stack `01`) is not wired by any of this. It
gets no reading memory until someone adds the same two calls there.

---

## 2. The `FBP` API

Every function is wrapped in `try/catch` and returns a sane value when storage
is dead. None of them throw. None of them touch the network.

### Access

| Call | Returns | Notes |
|---|---|---|
| `FBP.unlocked()` | `true` / `false` | Reads localStorage **or** cookie. Always agrees with `FB.unlocked()`. |
| `FBP.restoreURL()` | `"https://factbox.app/stories.html?restore=fb1-…"` or `null` | The buyer's link. `null` until they have paid. |
| `FBP.token()` | token string or `null` | The raw token, if you want to show it as a code. |
| `FBP.source()` | `"stripe"` \| `"restore"` \| `"local"` \| `null` | Where access came from. `"stripe"` = a genuine checkout session id. |
| `FBP.restoreFailed()` | `true` / `false` | `true` when this pageload had a `?restore=` that was mangled or truncated. Show "that link looks incomplete". |
| `FBP.unlock(token?)` | `true` / `false` | Force-unlock, e.g. a support code pasted into a box. |
| `FBP.lock()` | `true` / `false` | Clears access only; keeps reading memory. |
| `FBP.RESTORE_NOTE` | string | The one-line honesty copy to print under the link. |

### Reading memory

| Call | Returns | Notes |
|---|---|---|
| `FBP.mark(stackId, cardIndex, totalCards)` | `bool` | 0-based `cardIndex`, clamped; may be one past the end. Monotonic — never goes backwards. Throttled to one write per 1.2s. |
| `FBP.complete(stackId, totalCards)` | `bool` | Marks finished and writes immediately. |
| `FBP.flush()` | — | Forces the pending write. Already auto-fires on `pagehide` and on `visibilitychange` → hidden. |
| `FBP.get(stackId)` | `{card, total, done, at, pct}` or `null` | `at` is ms epoch. |
| `FBP.all()` | `{stackId: {…}}` | Everything remembered. |
| `FBP.state(stackId, totalCards)` | `{status, card, total, pct, label, at}` — **always an object** | `status` is `"unread"` \| `"reading"` \| `"done"`. `label` is `""` \| `"Card 6 of 8"` \| `"Finished"`. Safe on a cover never opened. |
| `FBP.resumeFor(stackId)` | `{card, total, pct, at, label}` or `null` | `null` means *start at the top* — which is the right answer for an unread story **and** a finished one. |
| `FBP.continueReading(stacks)` | `{stack, id, card, total, pct, at, label, href}` or `null` | Pass the array straight from `FB.load()`. Most recently touched unfinished story the reader can actually open — it never points at a locked stack. |
| `FBP.clear()` | `bool` | Wipes reading memory, keeps access. |
| `FBP.clearAll()` | `bool` | Wipes both. |
| `FBP.ok` | `bool` | `false` when no store would take a write. Use it to hide any "we remembered" copy rather than lying. |

### Optional UI

| Call | Returns |
|---|---|
| `FBP.resumeChip(stackId, totalCards, onResume)` | An `HTMLElement`, or `null` if there is nothing to resume |

Built entirely from inline styles, so it needs no CSS from `app.css` or
`scenes.css` and cannot be broken by either. It is **never inserted
automatically** — a resume that moves the page on its own is exactly the
disorienting jump this is meant to avoid. It has a "Continue from card N"
button and a `×` that dismisses it. `onResume(cardIndex, info)` fires on the
button; the chip removes itself either way. `el.dismiss()` removes it
manually — call that once the reader scrolls, so it does not sit there forever.

---

## 3. Exactly what to call

### `read.html`

`read.html` already computes `deepest` (a pane index; the end card counts as
`s.cards.length`). Two calls total.

**On scroll** — inside the existing `onScroll()`, after `if (n > deepest) deepest = n;`:

```js
FBP.mark(s.id, deepest, s.cards.length);
```

Safe to call on every scroll frame: writes are throttled to one per 1.2s and
flushed automatically when the page hides. No extra listener needed — the
existing `report()` path and `FBP`'s own `pagehide` handler are independent.

**On complete** — inside the existing `report()`, next to the `stack_complete`
track call:

```js
if (deepest >= s.cards.length) FBP.complete(s.id, s.cards.length);
```

Optional but recommended, since it writes through immediately rather than
waiting on the throttle.

**Resume offer** — after `deck.innerHTML = html + endcard(next);`:

```js
var chip = FBP.resumeChip(s.id, s.cards.length, function (card) {
  deck.scrollTo({ top: card * deck.clientHeight, behavior: "smooth" });
  FB.track("resume_used", { stack: s.id, card: String(card + 1) });
});
if (chip) {
  document.body.appendChild(chip);
  /* Let it get out of the way the moment the reader starts reading. */
  deck.addEventListener("scroll", function once() {
    deck.removeEventListener("scroll", once);
    setTimeout(function () { try { chip.dismiss(); } catch (e) {} }, 2500);
  }, { passive: true });
}
```

If you would rather build the affordance in `app.css`, use the data instead
and skip the chip entirely:

```js
var r = FBP.resumeFor(s.id);   // null, or {card, total, pct, label}
```

A finished story returns `null` and starts at the beginning, as specified.

### `stories.html`

**Per cover** — inside `card(s)`, alongside the existing `locked` line:

```js
var st = FBP.state(s.id, s.cards.length);
// st.status: "unread" | "reading" | "done"
// st.label : ""       | "Card 6 of 8" | "Finished"
// st.pct   : 0        | 1..99         | 100
```

Then add `" is-" + st.status` to the `class`, and either swap the `.meta` line
for `st.label` when there is one, or drop in a bar:

```js
'<p class="meta">' + (st.label || (s.cards.length + ' cards · ' + FB.minutes(s.secs))) + '</p>' +
(st.pct ? '<i class="readbar" style="width:' + st.pct + '%"></i>' : '')
```

**Continue-reading entry** — inside the `FB.load().then(...)`, before the
sections are written:

```js
var c = FBP.continueReading(stacks);
if (c) {
  var href = c.id === "01" ? "story.html" : c.href;   // same stack-01 rule as card()
  shelf.innerHTML = '<div class="sechead"><h2>Pick up where you left off</h2></div>' +
    '<a class="card resume" href="' + href + '">' +
      '<div class="plate"><img alt="" src="img/thumbs/' + FB.esc(c.stack.img) + '.webp"></div>' +
      '<h3>' + FB.esc(c.stack.title) + '</h3>' +
      '<p class="meta">' + FB.esc(c.label) + ' · ' + c.pct + '%</p>' +
    '</a>' + shelf.innerHTML;
}
```

`continueReading` already filters out locked stacks, so this can never offer
something the reader cannot open.

**The receipt** — when `location.search` had `unlocked=1` (or just: whenever
`FBP.unlocked()` and the reader has not seen it), show the restore link:

```js
var url = FBP.restoreURL();
if (url) {
  // an <input readonly value=url> plus a copy button, and:
  //   <p class="fine">FBP.RESTORE_NOTE</p>
  // Keep it reachable forever — support.html is the natural home.
}
if (FBP.restoreFailed()) {
  // "That restore link looks incomplete — copy the whole thing."
}
if (!FBP.ok) {
  // storage is dead; do not promise to remember anything
}
```

---

## 4. The restore link

**Shape:** `https://factbox.app/stories.html?restore=fb1-s-cs_live_a1B2c3…-18ql`

`fb1` version · `s` or `l` (Stripe session id, or locally minted) · the id ·
a four-character checksum.

**The checksum is not authentication.** It cannot be — there is nothing on a
static site to authenticate against. Its only job is to tell a truncated or
mistyped link apart from a real one, so the buyer gets *"that link looks
incomplete"* instead of a page that silently does nothing.

**What the buyer sees.** Stripe returns them to
`stories.html?unlocked=1&session_id=…`. They are unlocked instantly and land
on the full library. Underneath the masthead: their restore link, a copy
button, and one line — *"This link re-opens your stories on any phone or
browser. Anyone you send it to gets in too, so keep it to yourself."*
(`FBP.RESTORE_NOTE`.) The prompt should be *"email this to yourself"*, because
that is the one place they will still be able to find it in a month.

The link is rebuildable from `FBP.restoreURL()` on any device that already has
access, so it should also live permanently on `support.html` — that is the
page someone lands on when they have lost it.

**Two stores.** Access is written to `localStorage` **and** a first-party
cookie (`SameSite=Lax`, `Secure` on https, 365 days), and read from either,
healing whichever is missing. Instagram and TikTok webviews sometimes hand out
a `localStorage` that is wiped between sessions while cookies survive. The
reading map is **never** put in a cookie — it is far too big and cookies ride
along on every request.

---

## 5. The honest limitations — relay these

1. **This is still not a paywall.** `gate.js` says it and it is still true:
   `data/stacks.json` is a public file. Anyone who opens dev tools reads all
   fifty-one stories for free, and nothing here changes that. What this file
   buys is that a person who *did* pay is not asked to pay twice.

2. **The restore link is a bearer token — anyone holding it gets in.** No
   server means nothing to check a token against, so possession is the whole
   proof. If a buyer tweets their link, everyone who clicks it is unlocked
   forever. If it leaks widely the only remedy is to change the token format
   and reissue, which breaks every existing buyer's link too. This is inherent
   to static hosting, not a flaw in the implementation. **The user should
   decide knowingly whether they are fine with this.** For a launch test —
   *does anyone pay at all?* — it is the right trade. For a real subscription
   it is not.

3. **A curious reader can unlock themselves in about five seconds** by typing
   `localStorage.fb_unlocked_v1 = "1"` in a console, or by guessing that
   `?unlocked=1` is what Stripe redirects to — that URL alone unlocks anyone
   who visits it, with or without paying. Both were already true before this
   change; `?restore=` adds no new hole.

4. **Access still cannot follow someone to a browser they never opened the
   link in.** Storage is per-browser, always. The restore link is the bridge
   and it only works if the buyer kept it — which is why it must be shown at
   purchase *and* be findable again on `support.html`.

5. **Reading memory is per-browser and never leaves the device.** Nothing is
   sent anywhere. Clearing site data loses it, and Safari's tracking
   prevention can evict script-written storage after roughly seven days with
   no visit to the site. There is no way to back it up without a server. For a
   site with no accounts this is the right trade — nothing to leak.

6. **Some browsers refuse storage entirely** (private mode, locked-down
   webviews). There, access lasts one pageview and nothing is remembered. The
   page works perfectly; it just forgets. `FBP.ok` is `false` in that case —
   use it to avoid promising something that will not happen.

7. **Memory is capped at 60 stories** (51 today), oldest evicted first, with a
   20 KB ceiling and a shrink-and-retry on quota errors. Worst case it forgets
   the oldest reads. It never breaks the page.

---

## 6. Verification

`node --check js/progress.js` passes.

**91 assertions in `rendercheck/checkprogress.js`, all passing** — a first
visit's defaults; marking four stacks and reading them back; monotonic
progress; clamping past the end card; memory surviving a fresh page load;
resume offered for a part-read story and correctly withheld for finished,
barely-started and unread ones; `continueReading` skipping locked stacks while
locked and returning the most-recently-touched unfinished one while unlocked;
the resume chip's element and callback; the Stripe→restore-link→second-device
round trip; a mangled token rejected; the literal-`{CHECKOUT_SESSION_ID}`
fallback; a cookie alone re-unlocking and healing localStorage; the 60-entry
cap; and junk input (`null`, `NaN`, `{}`, negative indexes) never throwing.

**The storage-refuses-everything path** is tested with a `localStorage` whose
`getItem`/`setItem` both throw *and* a `document.cookie` that throws on read
and write: no script errors at load, `FBP` still defined, every one of the
sixteen API calls returns a sane default, nothing throws.

**Whole-page render** — a temporary `_progresstest.html` loading
`progress.js` → `gate.js` → real `stacks.json` over HTTP, since deleted:

```
script errors : none
covers built  : 51
  unread      : 48
  reading     : 2
  done        : 1
RESTORE http://127.0.0.1:8899/stories.html?restore=fb1-s-cs_live_Zx99Tt77Qq11-dwf3 | unlocked true | FB agrees true
CONTINUE King David and Bathsheba — Continue from card 3 (23%)
URL after load:  (gate.js stripped it)
FBP.state(03) : {"status":"reading","card":5,"total":8,"pct":75,"label":"Card 6 of 8","at":1788308428000}
FBP.resumeFor : {"card":5,"total":8,"pct":75,"at":1788308428000,"label":"Continue from card 6"}
```

`read.html`, `stories.html`, `css/app.css` and `js/gate.js` were not modified.
