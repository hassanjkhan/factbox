# Scenes — integration note

Motion and atmosphere for the reader. Two files, both additive:

| File | What it does |
|---|---|
| `css/scenes.css` | Camera moves, eight atmosphere layers, caption choreography, reduced-motion |
| `js/scenes.js` | Picks the atmosphere class from `data-topic`, tags the caption, arms the reveal |

Neither owns any markup. If both were deleted the reader would look exactly as
it did before.

---

## 1. Wiring

In `read.html`, after the existing app stylesheet:

```html
<link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/scenes.css">
```

and after `gate.js`:

```html
<script src="js/gate.js"></script>
<script src="js/scenes.js" defer></script>
```

`defer` is deliberate — nothing in `scenes.js` needs to run before the deck
exists, and it watches for the deck being filled.

## 2. What each `.beat` needs

You are already writing all of it. For the record, the contract is:

| Attribute | Values | Used by | Required? |
|---|---|---|---|
| `data-cam` | `"0"`–`"5"`, `index % 6` | `scenes.css`, camera | yes |
| `data-topic` | the stack's `topic` string | `scenes.js`, atmosphere | yes |
| `class="is-hook"` / `is-landing` | as now | `scenes.css`, camera | yes |
| `.live` on the beat on screen | as now | everything | yes |
| `data-beat`, `data-card`, `data-stack` | as now | nothing here | no |

Do **not** put `class="js"` on `<html>` in the markup. `scenes.js` adds it, and
the safety in §5 depends on it being able to take it off again.

`data-cam` uses `index % 6`, so cards 0 and 6 of a twelve-card stack share a
move. They are never adjacent, which is all the requirement asks.

## 3. Camera

A slow Ken Burns on `.beat .art img`, six variants cycled by `data-cam`,
27–38s each, `ease-in-out alternate infinite`. Barely perceptible — a
documentary hold that drifts, not a pan.

Two beats override their variant:

- **`is-hook`** gets the confident move: a 30s push from `scale(1.06)` to
  `scale(1.18)` that runs **once and holds**. It does not breathe back out.
- **`is-landing`** settles: 20s from `scale(1.09)` to `scale(1.06)`, once, then
  stops dead. The last thing the reader looks at is a still painting.

The plate can never show an edge. Minimum scale is 1.06 everywhere; every
translate is written *before* the scale, so the scale does not multiply it, and
the largest is 1.4% against an available overhang of 6%.

## 4. Atmosphere

`scenes.js` appends one `<div class="atm atm-NAME" aria-hidden="true">` to each
`.art`. It is the **last child**, so it paints above the plate and below
`.art::after` — your scrim still lands on top of it and text contrast is
untouched. `scenes.css` also sets `isolation:isolate` on `.beat .art` so that
order is not a matter of luck.

| Topic | Class | What it is |
|---|---|---|
| `cleopatra` | `atm-shimmer` | gold sheen crossing the upper plate, faint water lines |
| `old_testament` | `atm-dust` | a tilted shaft of light with dust standing in it |
| `new_testament` | `atm-halo` | a bloom over the top of the frame, breathing |
| `church_history` | `atm-candle` | lamplight in one corner that will not sit still |
| `us_history` | `atm-grain` | paper tooth and a vignette that breathes |
| `ancient_world` | `atm-haze` | dry heat: two slow opposed bands |
| `medieval_modern` | `atm-cold` | cold lilac haze off stone, closing vignette |
| `disaster` | `atm-ember` | a glow above and embers climbing into it |
| *(missing / unknown)* | `atm-veil` | a quiet room: faint tooth, vignette, a few motes |

All eight topics in `data/stacks.json` are covered; `atm-veil` exists so a new
topic degrades to something rather than nothing.

Gradients only — no images, no data URIs, no filters, no external assets. Only
palette hues from `app.css` (`--butter`, `--coral`, `--coral-deep`, `--lilac`,
`--parchment`, `--night`). Every animation is `transform` or `opacity`, so the
layers composite instead of repainting.

**The caption's half of the screen is protected structurally.** Every layer that
*adds light* carries a mask that fades it out by 58% down the frame. The only
full-bleed layers are the three vignettes, which darken toward the edges and
therefore raise contrast rather than lower it.

## 5. Captions — read this before touching it

Headline rises first, body 0.10s behind, citation 0.22s behind that, keyed off
`--d` exactly like `.rise` in the flagship shell.

The hidden state (`opacity:0`) exists **only** inside `html.js`. The default,
with no script at all, is plain visible untransformed text. `scenes.js` adds
`js` only after it has dressed real beats, and takes it off again — permanently
— if either of these happens:

- no `.beat.live` or `.pane.live` exists three seconds after arming, or
- any uncaught error fires on `window`, from any script on the page.

So the class that can hide the words has to keep justifying itself, and a later
sweep cannot silently re-hide them. Under `prefers-reduced-motion:reduce` the
reveal is forced visible with `!important`; `app.css`'s blanket `*{animation:none}`
does not reach pseudo-elements, so `scenes.css` zeroes those itself and every
scene still composes as a still frame.

If you ever need to disable the reveal wholesale, delete the `script` tag. Do
not hardcode `html.js`.

## 6. Cost

Animation is `animation-play-state:paused` by default and `running` only under
`.beat.live`, and `will-change` is promoted only there. With your observer that
is one card animating: one image transform plus at most two composited pseudo
layers. The other eight are still paintings.

## 7. Verified

`rendercheck/checkscenes.js`, `checkfailsafe.js`, `checkcss.js`:

- `node --check js/scenes.js` — clean.
- All **51 stacks** rendered in jsdom over HTTP: no script errors, every beat
  has its headline, one `.atm` per beat with the right class for its topic,
  `data-cam` covering 0–5, `.rise` on every caption line.
- Failsafe: live set → armed; nothing sets live → disarms; page throws →
  disarms. Captions cannot be left hidden.
- `scenes.css` parses to 61 rules / 16 keyframes / 1 media block, no `px`.
- `read.html` on its own still passes unchanged.
