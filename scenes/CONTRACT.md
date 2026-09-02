# Factbox web reader — build contract

A full-bleed, vertically-scrolled story reader. Instagram Reels / DramaBox
mechanics: one full-viewport **animated illustrated scene** per beat, caption
text over the top, scroll down for the next beat. No like button, no save
button, almost no chrome. The picture does the work.

The art style is the app's onboarding scenes: **flat shapes, a period palette,
one idea per scene, gentle continuous motion.** Never a diagram — always a
moment. Think a stage set lit for one shot, not an illustration of a noun.

---

## File ownership

| Owner | Files |
|---|---|
| Scenes A | `scenes/a.html`, `scenes/a.css` |
| Scenes B | `scenes/b.html`, `scenes/b.css` |
| Shell | `scenes/shell.html`, `scenes/shell.css`, `scenes/shell.js` |

Nobody edits a file they do not own. The composer concatenates them.

---

## The scene contract — every scene must obey this

```html
<div class="scene s-NAME" aria-hidden="true">
  …layers…
</div>
```

1. **Scoped.** Every selector you write starts with `.s-NAME`. No bare element
   selectors, no shared class names. Two scenes must never collide.
2. **Full bleed.** The root `.scene` is already `position:absolute; inset:0;
   overflow:hidden` — the shell provides that. Your layers position inside it.
3. **Sized in `%`, `vmin` or `em`, never `px`.** These run from a 360pt phone to
   a desktop window. A scene that only composes at one size is a failed scene.
4. **Animation runs only when live.** Put motion behind
   `.page.live .s-NAME <thing> { animation-play-state: running }` and default to
   `paused`. Eight scenes animating off-screen is a hot phone.
5. **Reduced motion.** The shell sets `.no-motion` on `<html>`. Under
   `html.no-motion` every animation must be `none` and the scene must still
   compose as a still frame.
6. **Nothing in the middle third.** The caption sits vertically centred with a
   scrim behind it. Keep your subject in the top or bottom third, or make the
   middle quiet — a horizon, a wash, a gradient. Test with text over it.
7. **No external assets.** CSS shapes and inline SVG only. One exception is
   named in the assignments (the painting), and the composer injects it.

## Palette — from the app's Theme.swift, use these

```
parchment  #FFF7ED   ink        #3E2F4A   ink-soft   #8B7B93
coral      #FF7A5C   coral-deep #E85F41   crimson    #A81F38
teal       #4FC3B8   teal-deep  #1F7A72   butter     #FFD36E
butter-dp  #9A6B00   lilac      #B79CED   lilac-deep #6B4BB0
mint       #8FDCA8   blush      #FFB3C1   steel      #9AA3AE
night      #1B1620   (grounds for dark scenes)
```

A scene may define its own darker/lighter siblings of these, locally. It may not
invent a new hue family.

## Motion vocabulary

Slow. Nothing snappy, nothing that loops visibly fast. Periods from the app:
drift 2.6s, breathe 2.2s, amble 4s, approach 54s. A scene should feel like it is
*breathing*, not playing. One primary moving element; everything else is a
whisper. `ease-in-out`, `infinite`, `alternate` where it suits.
