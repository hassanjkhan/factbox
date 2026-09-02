# Factbox web — technical spec

The reference for anyone (human or agent) changing this site. Where this
document and the code disagree, the code is the bug.

---

## 1. What this is

A static site on GitHub Pages at `factbox.app`. 51 history stories, 450 cards,
one Wikimedia plate per card. No server, no build step, no framework, no
package manager at runtime. Plain HTML, CSS and ES5-safe JavaScript, served as
written.

**Every reader is on a phone, in an in-app browser.** Traffic comes from
Instagram and TikTok, which means WKWebView: a viewport that resizes mid-scroll
and a toolbar that covers the bottom 44–60pt. Every layout decision answers to
that, not to a desktop window.

---

## 2. The invariants

These are not style preferences. Each one is here because breaking it has
already cost us a shipped bug.

### 2.1 A script must never throw at top level
The site shipped twice showing a scene with **no words on it**. Cause: a
`getElementById` for an element that had been deleted, on a top-level line. It
threw before the code that adds `.live` ran, and captions are `opacity:0` until
`.live` lands.

- Guard every DOM lookup. Guard every storage access — private mode and in-app
  webviews throw on *write*, not on read.
- `compose.py` refuses to build a page whose script looks up an id the page
  does not contain. Do not remove that gate.

### 2.2 Text is visible by default; JavaScript opts into hiding it
Caption animation is armed by `html.js`, which **JavaScript adds**. It is never
in the markup. `scenes.js` removes it permanently if nothing goes live within
3s or if any script throws. If JS fails entirely, the words are simply there.

### 2.3 A caught error must not render an empty page
A page that catches its own failure and renders nothing reports zero script
errors while showing the reader nothing. Always render a real message.

### 2.4 Verification runs the page
HTML validity, `node --check`, and HTTP 200s are all equally true of a page
with no text on it. Every check must execute the script in a real DOM. See §7.

### 2.5 Degrade downward, never to blank
No IntersectionObserver → mark everything live (costs battery, keeps words).
No storage → no memory, page fine. No Web Audio → control removes itself.
Missing plate → fall back to the stack hero. Missing `FBP`/`FBS` → feature off.

---

## 3. Layout constraints

| Token | Meaning |
|---|---|
| `--bottom-safe` | `max(13vh, safe-area-inset-bottom + 60px + 4px)`. **Nothing tappable or essential below this.** The in-app toolbar sits there. |
| `--top-safe` | `safe-area-inset-top + 12px` |
| `--tap` | `44px` minimum touch target, everywhere |

- Height is `100dvh` with a `100vh` fallback declared **first**. Never pin a
  pixel height from `window.innerHeight` — that produced a deck shorter than
  the screen with the body showing through.
- Scene geometry in `%`, `vmin`, `em`. Not `px`.
- Wide content scrolls in its own `overflow-x:auto` container. The body never
  scrolls sideways.

---

## 4. Design system

Defined in `css/app.css`. **Reuse before adding.** A new page that redefines
`.card` has forked the design system.

**Palette** (from the iOS app's `Theme.swift`): `--parchment #FFF7ED`,
`--ink #3E2F4A`, `--coral #FF7A5C`, `--coral-deep #E85F41`, `--night #1B1620`,
`--ground #0E0B12`, `--raise #181320`, `--hair`, `--dim`, `--dimmer`.
Type: `ui-rounded` / SF Pro Rounded, system stack. No web fonts.

**Single committed dark theme.** The artwork is the page; a light variant would
be a different product. So every page paints `body` background and its colours
explicitly and does **not** use `prefers-color-scheme`.

**Shared classes**: `.card` `.plate` `.grid` `.meta` `.lock` `.freetag`
`.readbar` `.resume` `.go` `.fine` `.pane` `.ghost` `.tabs` `.beat` `.copy`
`.cite` `.plate-credit` `.is-unread` `.is-reading` `.is-done`.

**Selected nav tab is not a filled pill** — brighter text plus a coral hairline
underneath. A coloured capsule reads as a button not yet pressed.

**Covers are the pitch.** A locked story still shows its artwork, dimmed, with
a small lock. Never hide the thing you are selling.

---

## 5. Data contracts

### `data/stacks.json`
```
{ stacks: [ {
    id, title, hook, secs, topic, kind, free,
    img, cap, cr,                       // stack hero (cover + fallback plate)
    cards: [ { n, beat, head, body, src, long?, img?, cap?, cr? } ],
    supp: [ { img, cap, cr } ]          // legacy, superseded by per-card img
} ] }
```
- `id` is a **string** (`"01"`, `"07B"`). Never parse it as a number.
- `n` is the card's **original** number. Stack 26 lost a card in repairs, so
  position in `cards[]` ≠ `n`. Joins to the artwork manifest use `n`.
- `cr` = `{artwork, credit, license, licenseUrl, tier, source, attrib, line}`.
  `tier` ∈ `public_domain | share_alike | attribution` and is **authoritative**.
  Never infer the tier from the licence string: `CC0` and `No restrictions` are
  public-domain-equivalent but contain no word "public".

`topic` ∈ cleopatra, old_testament, new_testament, church_history, us_history,
ancient_world, medieval_modern, disaster
`kind` ∈ myth_correction, list_explainer, unsolved_mystery, violent_death,
moral_reversal, hidden_meaning
`beat` ∈ hook, escalation, evidence, complication, question, turn, landing, extra

### Images
- `img/cards/c<stack>-<nn>.webp` — one plate per card, 1280w, WebP q≥68, ≤450KB
- `img/thumbs/<slot>.webp` — 420w covers
- `img/stacks/<slot>.webp` — stack heroes, now only the fallback
- Filenames are lowercase with `__2` for second plates. Stack `07B`'s hero and
  stack `07`'s second plate both wanted `s07b`: one file on a case-insensitive
  disk, two on Linux.

---

## 6. Runtime globals

Load order matters: `progress.js` → `gate.js` → everything else.
`progress.js` must precede `gate.js` because `gate.js` clears the query string.

| Global | File | Owns |
|---|---|---|
| `FB` | `js/gate.js` | access flag, `load()`, `esc()`, `minutes()`, `creditLine()`, `track()` |
| `FBP` | `js/progress.js` | reading memory, resume, restore link |
| `FBS` | `js/saves.js` | bookmarks |
| `FBR` | `js/recommend.js` | end-of-story recommendations |

Every consumer guards `window.X` before use. No global may redefine another.

**`live`** is the one cross-cutting class: the reader sets it on the on-screen
`.beat`, and motion, atmosphere and audio all key off it. At most one card
animates or plays.

---

## 7. Verification

`tools/check-story.js` and `tools/check-page.js` load a page in jsdom, run its
scripts, and assert real rendered text. A change is not done until:

1. `node --check` on every JS file touched
2. the page renders with **zero script errors**
3. the expected elements are present **and** carry text
4. no known error-state copy appears
5. for reader changes: the sweep across **all 51 stacks** passes

jsdom lacks `fetch`, `IntersectionObserver` and Web Audio; the harnesses stub
them. That is a harness gap, not a page bug — but code must survive their
absence, because the no-op paths are real on old webviews.

---

## 8. Licensing

361 distinct plates, all Wikimedia Commons: 328 public domain, 26 share-alike,
7 attribution.

- **Never hotlink Wikimedia.** Every file is fetched once and re-hosted here.
  Their CDN returns 429 readily: fetch at ≤2 concurrent with backoff.
- Share-alike plates must **name and link** the licence, on the card and in
  `credits.html`. The build fails if any share-alike plate lacks a link.
- Resizing for delivery is permitted under every CC version here and never
  creates adapted material. Do not crop, recolour or filter the files we serve;
  the browser frames them at display time.

---

## 9. Access — what it is and is not

**Not a paywall.** `data/stacks.json` is public; dev tools reads all 51. The
gate stops a paying reader being asked to pay twice. It does not stop anyone
else. This is inherent to static hosting and is the right trade for a launch
test, and the wrong one for a subscription business.

The restore link is a **bearer token** — anyone holding it is unlocked. Access
is mirrored to a first-party cookie because in-app webviews wipe localStorage.

Stripe: a hosted Payment Link (no server, no API key). Success URL must be
`https://factbox.app/stories.html?unlocked=1&session_id={CHECKOUT_SESSION_ID}`.

---

## 10. File ownership

`read.html` `stories.html` `credits.html` `css/app.css` `js/gate.js`
`js/progress.js` are the shared core — change them deliberately.
`explore.*`, `library.*`, `saves.js`, `recommend.js`, `scenes.*`,
`audio-reader.*` are self-contained layers. A layer may read the core's
globals and classes; it may not edit the core.
