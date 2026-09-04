# Factbox reader (read.html) — ambient sound for all 51 stacks

Four files and three new MP3s. Nothing that any other agent owns was touched.

| Owner | Files |
|---|---|
| Audio | `js/audio-reader.js`, `css/audio-reader.css`, `data/audio.json`, `AUDIO-READER.md`, `audio/{vault,wind,reactor}.mp3`, `audio/build-reader-beds.py` |

**The control's colour is not this file's any more.** `css/audio-reader.css`
carried six literal colours — a near-black pill, a warm ring on the on-state,
two cream alphas and their fallbacks. Every one is now a token, and the two
that were the OLD accent are the new one: the on-state icon takes
`--accent-ink`, which the reader's palette resolves to `--accent-lift`
(`#8FC4FA`, 10.1:1 on the reader's ground), and the ring takes
`--accent-edge`. `--coral` is a fill and is never a 1px line. The focus ring
rule went entirely: `app.css`'s own `:focus-visible` already draws it in
`--ring`, and this file was overriding it with the fill colour at 2.2:1.

The flagship story (`story.html` / `scenes/audio.js`) is untouched and keeps its
own engine. This is a second, quieter engine for the new reader. They share the
`audio/` folder and the `fb-sound` localStorage key, so a reader who turns sound
on in one has it on in the other.

---

## Integration — the two lines

```html
<link rel="stylesheet" href="css/audio-reader.css">   <!-- head, after css/app.css -->
...
<script src="js/audio-reader.js"></script>            <!-- last thing before </body> -->
```

The script must come **after** the inline reader script, because it reads the
deck that script builds. It does not care whether the deck is populated yet — it
watches for it — but load order is one less thing to think about.

It reads exactly four things from the reader's DOM, all read-only, all of which
`read.html` already sets as of this build:

| What | Where | Why |
|---|---|---|
| `#deck` | the scroller | the only element it queries |
| `live` class | on `.beat` | which card is on screen |
| `data-stack` | on `.beat` | which story — picks the base bed and the accents |
| `data-topic` | on `.beat` | fallback for a story with no entry of its own |
| `data-beat` | on `.beat` | `hook`/`escalation`/…/`extra` — picks the accent |
| `data-card` | on `.beat` | which card of this story — picks the room, above all of the above |

`data-cam` is ignored. **`data-card` is 0-based** — it is the index
`s.cards.map(function (c, n) {…})` hands the template, not the 1-based `c.n` in
`stacks.json`, and the two diverge wherever a stack's numbering has a gap.
Stack `26` is the one that does: nine cards whose `n` runs 1–8 then **10**. Read
it as `c.n` and every card from the ninth on gets the wrong room, silently, in
that stack and in any later one with a gap. `data/audio.json`'s `cards` keys are
`"0"`…`"8"` for it, verbatim what the attribute says. `.pane` (the paywall and the end card)
carries none of these, which is correct: an unscored card **holds** the bed that
is already playing rather than cutting to silence, so the ending is a coda.

**If `.live` is never set, it still works.** `read.html`'s no-IntersectionObserver
path marks *every* card live at once, and between two cards there is briefly no
`.live` at all. So the engine trusts the class only when exactly one card carries
it, and otherwise falls back to `deck.scrollTop / deck.clientHeight`, which on a
full-height snapping deck gives the same answer. Being one card out costs nothing,
because the engine only acts when the resolved *bed* changes.

**Cost to the page:** ~11 KB raw, ~3.5 KB gzipped, most of it comment. **No audio
byte and not even `data/audio.json` is fetched until a reader taps.** For the
majority who never do, the whole feature costs those few KB and nothing else.

---

## What it does

* One looping bed per card, **crossfaded** when the bed changes and **held —
  nothing touched at all** — when it does not. Across all 51 stacks, **332 of
  450 cards hold**: no fetch, no node, no ramp, no restart. A story averages
  **2.3 crossfades** end to end. That is the whole design; the rest is plumbing.
* **Off by default.** The `AudioContext` is not constructed until a real tap.
  A remembered "on" does not autoplay either — autoplay is blocked and a page
  that tries and fails looks broken. The control shows the state it *will* be in,
  breathes, and waits for the reader's first swipe, about a second away.
* **One tap on, one tap off, remembered** across reloads and across stories
  (`localStorage`, per-origin, shared with the flagship).
* **Silent no-op** if Web Audio is missing, the context will not start, or the
  beds 404. In the last case the control says "No sound available" once and
  removes itself from the DOM; the remembered preference is cleared so the next
  reload is clean.
* Suspends on `visibilitychange` and `pagehide`. Nothing is ever heard from a
  page the reader is not looking at.

### Where the control sits, and why it is not negotiable

Top-**right**, on the same rail as the "← Stories" pill (top-left), same glass,
same pill radius, same 38 px height, `z-index: 32` — one above `.topbar` (31) and
the progress bar (30).

It is **not** in the bottom of the viewport, and must not be moved on the composed story pages there.
`--bottom-safe` in `app.css` is `max(13vh, toolbar + inset)` for one reason: the
Instagram and TikTok in-app browsers draw their own toolbar over the bottom of
the screen, and that is essentially all of our traffic. A control down there is a
control that cannot be tapped.

Below 340 px wide, or under 420 px tall (a phone in landscape), the label is
visually hidden and the pill becomes a 38 px square, which is the only width at
which the back pill could ever reach it.

---

## The volume, and why it is this number

| | flagship (`story.html`) | this reader |
|---|---|---|
| `LEVEL` | 0.26 | **0.17** |
| `LEVEL_CALM` (reduced motion) | 0.17 | **0.11** |

A **3.7 dB cut**: this reader's normal level is the flagship's reduced-motion
level. The founder's note was *"the audio was a little loud, make it a bit
quieter so it's not the main focus"*, and the target is that a reader is not
aware of the sound until they think about it.

Lowering a master cannot disturb the balance between beds — all eighteen move by
the same 3.7 dB — but it can push the quietest bed off the bottom, so the
flagship's rule was applied: **move the bed that falls off, not the master.**
Three were raised in `data/audio.json` and nothing else changed:

| Bed | flagship gain | here | why |
|---|---|---|---|
| `search` | 0.50 | **0.72** | the deliberate near-silence of the set; 3.7 dB below a near-silence is a bed that reads as a failed download |
| `coil` | 0.85 | **0.95** | almost nothing above 500 Hz, which is the band a phone speaker actually radiates |
| `door` | 0.90 | **0.95** | same, and worse (−55 dB above 500 Hz) |

`triumph` was pulled from 1.00 to **0.95**: in the flagship it is the loudest
moment of the story, here it is a one-card accent and should not be the loudest
thing in a reading session. `letter` and `copies` went 0.75/0.80 → **0.80/0.85**
because here they are whole-story base beds rather than single beats.

**Turn these down first if it is still loud** — `LEVEL` / `LEVEL_CALM` at the top
of `js/audio-reader.js` are the honest fix. Use a bed's own `gain` in
`data/audio.json` only when one bed sticks out.

---

## The map: `data/audio.json`

Resolution, most specific wins:

```
stacks[data-stack].cards[data-card]     the room THIS card is in
stacks[data-stack].beats[data-beat]     the accent this story wants on this beat
stacks[data-stack].bed                  this story's room
topics[data-topic].beats[data-beat]     a topic-wide accent
topics[data-topic].bed                  the topic's room
default  ("scroll")                     a still, small, neutral interior
(nothing)                               HOLD whatever is playing
```

Every rung is guarded on `beds[…]` existing, so a card naming a bed that is not
declared falls through to the next rung rather than to silence. That is tested,
not asserted; see Verification.

**The per-card rows are merged into `data/audio.json`, not fetched separately.**
They were authored in `data/cardaudio.json`, which stays in the repo as the
design record — it carries the 1-based `n`, a `why` string quoting the card text
that put each run there, and an `fb` flag on the cards that fell through. None of
that is any use to a browser, and `data/cardaudio.json` is 83 KB with it. What
the engine reads is `bed` and nothing else, so only `bed` was merged in:
`data/audio.json` goes 11 KB → **31.5 KB raw, 4.6 KB gzipped**, and the tap still
costs **one** fetch. Two files would have meant a second round trip on a phone
for a map that is 450 short strings, and a deep-merge branch in the loader for
the one place `CFG.stacks[k] = j.stacks[k]` replaces rather than merges. The
regeneration is a five-line pass over the two files; the assertions it makes
before writing are in Verification.

All 51 stacks have an explicit `stacks` entry, so in practice `topics` is the
safety net for stacks added later — a new stack sounds like its topic on the day
it ships, with no code change and no JSON change. Note the consequence of the
order: **a story's own `bed` outranks its topic's `beats`.** A story that has
named its own room has said something more specific than its topic's arc. Every
accent in this build is therefore authored per stack.

`data/audio.json` is fetched lazily, on the tap. `js/audio-reader.js` carries a
built-in fallback map — one bed per topic, no accents — so a missing or truncated
JSON degrades to *"every story sounds like its topic"* rather than to silence.
The fetched file is **merged over** the built-in one, never swapped for it, so a
partial file cannot take the sound out.

### Bed per topic

| Topic | Stacks | Base bed | Why |
|---|---|---|---|
| `cleopatra` | 8 | `palace` | a fountain in a court, cicadas beyond it. Alexandria in August. The flagship's own material, on its own subject. |
| `ancient_world` | 4 | `palace` | Rome and Macedon are the same Mediterranean summer. `triumph` for the two set in a city (Nero, the Ides). |
| `old_testament` | 7 | `wind` **(new)** | open, dry, outdoors, no water. Nothing in the shipped fifteen was outside and dry. |
| `new_testament` | 11 | `copies` | a scriptorium: dry, papery, patient. These stacks are mostly *"here is what the document actually says"*, and that is what a document being examined sounds like. The narrative ones (Jesus, Paul, Peter, the crucifixion) are moved to `wind` or `vault` per stack. |
| `church_history` | 11 | `vault` **(new)** | a large dark stone interior with a long tail: council chamber, cathedral, trial hall. The canon stacks (26, 30) move to `copies`. |
| `medieval_modern` | 5 | `vault` | the same room, five centuries later — Joan's trial, Rasputin's cellar. Genghis (44) moves to `wind`, Napoleon (39) to `gallery` because that story is about how he was painted. |
| `us_history` | 4 | `letter` | see the honest note below. |
| `disaster` | 1 | `reactor` **(new)** | see the honest note below. |

### The arc, per stack

Almost every stack is `base … base` with one or two moves:

* `question` → `coil` on the `violent_death` and `unsolved_mystery` stacks. The
  low drone under the question.
* `turn` → back to the base, or to a specific texture: `basket` (01, the asp
  under the figs), `vials` (18, 38, the physician's table), `triumph` (07, 15,
  20, 39, 42, a crowd), `gallery` (02, the paintings), `vault` (12, Peter in
  Rome).
* `landing` → `search` on the deaths and the disappearances. The room afterwards.
* `extra` → never overridden anywhere. The appendix cards hold the story's room.

The full arc for every stack is printed in the table at the bottom of this note.

---

## Which topics have no good bed — read this

**Most of this section is now history**, and it is left standing because it is
the record of what the beat-level map could and could not do. The per-card map
and the thirteen beds below answer three of the four complaints: `us_history`
gets `hall`, a nineteenth-century *wooden* interior, for Ford's Theatre and the
Illinois courthouse; the narrative New Testament stacks get `field`, `night`,
`road` and `storm` instead of standing on `wind`; and `door` now resolves. What
survives unchanged is the last paragraph's principle and the fact that **no bed
here claims to be a recording of anything.**

**`us_history` (4 stacks, all Lincoln) has no right bed and is not getting one
by force.** Nothing in the folder is nineteenth-century America. What it plays is
`letter.mp3` — a still room, a writing hand, and a tread somewhere beyond the
door — which is genuinely a *quiet interior with a person in it* and is the
correct bed for a story about a man in his study and a box at a theatre. It is
not *"Washington, 1865"*, and this note is here so nobody later thinks it is.
`harbour`, `palace`, `sea`, `bath`, `vials` and `basket` were all considered and
all are the wrong continent or the wrong century.

**`disaster` (1 stack, Chernobyl) had nothing at all**, which is why
`reactor.mp3` was synthesised. Every one of the fifteen shipped beds is the wrong
century or the wrong planet for a Soviet power station, and `harbour.mp3` suits
Alexandria, not Pripyat. `reactor` is a cold continuous machine-room hum with no
period in it, which is the honest thing to build: it does not claim to be a
recording of anything.

**`new_testament` is a compromise and it is worth saying so.** Eleven stacks on
`copies` is a lot of scriptorium. The split (text stacks on `copies`, narrative
stacks on `wind`) is an editorial judgement about what each story is *about*, not
a claim that first-century Judea sounded like either. If it reads as monotonous
across a session, the fix is more beds, not a different map.

**Beds that are mapped but never resolve.** `scroll` is the `default`, reached
only by a stack or topic that is not in the map — i.e. content added later.
`door` now resolves twice (`08`/3, the officer stepping away from the door
outside Lincoln's box, and `44`/6, Genghis Khan's concealed burial); it used to
resolve for nothing at all, and was kept in `beds` anyway because a mapped bed
that nothing carries costs **nothing** (beds are fetched by what is on screen)
whereas an *unmapped* key silently holds the previous bed, which is a bug you
find by ear. Wrong in the cheap direction. `harbour-arrival` now carries four
cards across two stacks (`02` and `19`).

---

## The three new beds — provenance

**Synthesised from nothing, by `audio/build-reader-beds.py`, which is committed
next to them.** There is no source folder, no download, no recording, no
third-party file of any kind. Every sample in `vault.mp3`, `wind.mp3` and
`reactor.mp3` comes out of ffmpeg's own `anoisesrc` generator and ffmpeg's own
filters. The only inputs are the seeds and the filter constants in that file, so
the output is our own work and the licence is unambiguous. The script is
idempotent — the noise sources are seeded — so a re-run reproduces all three byte
for byte. Verified.

```
python3 audio/build-reader-beds.py     # ffmpeg on PATH; nothing else needed
```

| Bed | What it is | Built from |
|---|---|---|
| `vault.mp3` | A large dark stone interior with a long tail. `gallery.mp3` is the bright cool big room; this is the dark one, lower and with a tail about twice as long. The two are meant to be told apart. | pink noise 85–1400 Hz with a 470/930 ms room, a 150 Hz brown resonance at −8, and a 1.7–5.4 kHz stone-air layer at −13 |
| `wind.mp3` | Open, dry, outdoors, no water. Desert, steppe, hillside. | pink noise 170–2200 Hz drifting at 0.10 Hz, a 700 Hz band drifting at 0.17 Hz, a low body at −11, dry grit 2.4–7.2 kHz at −13 |
| `reactor.mp3` | A machine room. Cold, continuous, mechanical, no century. | narrow **noise** resonances at 55 and 118 Hz (not oscillators — see below), a 620 Hz mid with a 210/430 ms room, ventilation hiss 3–9 kHz at −15 |

Two rules every layer obeys, both inherited from `scenes/AUDIO.md`:

* **No sustained pure tones.** The engine loops *inside* the file (50 ms in,
  100 ms off the end) to step over MP3 encoder delay and padding, so the wrap
  skips ~150 ms of material. In broadband noise that jump is smaller than the
  signal's own variation and is inaudible; in a sine it is a click every lap.
  So every "hum" here is a narrow noise resonance, never an oscillator. There
  are also deliberately **no clicks** in `reactor.mp3` — a Geiger tick on a 22 s
  loop is a metronome, which is the one thing the loop spec exists to prevent.
* **Real energy above 500 Hz.** A phone speaker radiates almost nothing below
  that; `door` and `coil` are near-inaudible on a phone for exactly this reason.
  Each of these three carries a deliberate upper layer so it plays as *something*
  rather than as a failed download.

All three use the same seamless-loop construction as `build-beds.py`: take
L+X seconds, crossfade the trailing X back over the head with quarter-sine
curves, so the wrap is continuous by construction rather than by luck.

### Measured, not heard

**Nobody on this build has heard these files**, exactly as with the fifteen
before them. What was done instead is the same battery, and all three sit inside
the envelope of the shipped set:

| Bed | dur | LUFS | >500 Hz | RMS p10→p90 | true peak | seam vs local RMS |
|---|---|---|---|---|---|---|
| `vault.mp3` | 22.0 s | −25.2 | −31.8 | 1.7 dB | −10.9 dBFS | −24.1 vs −24.4 (at or below) |
| `wind.mp3` | 22.0 s | −24.0 | −26.7 | 2.8 dB | −10.0 dBFS | −20.8 vs −22.8 (+2.0 dB) |
| `reactor.mp3` | 22.0 s | −24.2 | −39.3 | 2.4 dB | −7.4 dBFS | −24.2 vs −22.6 (below) |
| *(shipped, for scale)* `door.mp3` | 24.0 s | −25.1 | −55.4 | 3.5 dB | −9.4 dBFS | −19.0 vs −20.4 (+1.4 dB) |
| *(shipped, for scale)* `gallery.mp3` | 22.0 s | −26.2 | −29.4 | 1.5 dB | −12.4 dBFS | −28.4 vs −26.9 (below) |

The seam figure is the **median over a ±40 ms sweep** of the wrap point, not a
single sample: MP3 decode shifts the duration slightly and no two decoders agree,
so the honest question is "is the jump small wherever it lands", not "is it small
at one place". `wind` sits 2.0 dB above local RMS at the wrap, which is better
than `door.mp3`, a bed that shipped. Its <220 Hz layer is deliberately held 11 dB
down for this reason — at −6 it measured 4 dB hot, because a signal that low
moves too far between one sample and the next 21.9 s away.

That is a decent proxy for *"will not be annoying"*. **It is not a proxy for
"sounds good"**, and it is not a proxy for *"sounds like a reactor"*. Audition
`reactor.mp3` first — it is the one bed carrying a whole story on its own and the
one with the least above 500 Hz (−39), so it is the likeliest to play as nothing
on a phone. If it does, raise the `rea_c` (620 Hz) and `rea_d` (hiss) layers by
3–4 dB in `build-reader-beds.py` and re-run.

### What was NOT done

**No audio was downloaded, from anywhere.** The founder has already rejected
sourced audio twice on licensing (soundsnap via a Commons CC0 tag the uploader
was not entitled to apply; Freesound crowd recordings whose recordist cannot be
verified), and `scenes/AUDIO.md` records the rule: *if you cannot point at a
licence tag on a page you can link to, do not ship the file.* Synthesis from a
committed script sidesteps the question entirely — there is nothing to license.

Beds that would have improved this map and were **not** built, because they need
a real recording and synthesis would only be a worse `gallery`/`wind`:

* **A nineteenth-century American interior** for `us_history` — a wooden room,
  a clock, a street beyond a sash window.
* **A first-century outdoor Judea** for the narrative New Testament stacks —
  goats, distant voices, dry hillside. `wind` is standing in.
* **A crowd that is not a shopping mall.** `triumph.mp3` is three modern indoor
  crowds pitched down; see the shopping list in `scenes/AUDIO.md`, unchanged.

---

## The thirteen per-card beds — provenance

`data/cardaudio.json` assigns a bed to every one of the 450 cards and names 31
beds: the 18 already here and 13 new ones. `AUDIO-CARDS.md` is the design note
for that map and section 6 of it is the synthesis brief for each new bed. They
are built by **part two of `audio/build-reader-beds.py`**, in the same idiom and
under the same house rules as `vault`, `wind` and `reactor`, so the whole set of
sixteen regenerates with one command.

| bed | one line | cards |
|---|---|---|
| `court` | Indoor throne room. Hard marble, a low murmur that never becomes words. | 35 |
| `battle` | An army at middle distance. Mass, metal, low ground rumble. No voices. | 33 |
| `field` | Open warm countryside. Grass, insects, a bird. Galilee, Kentucky, a garden. | 29 |
| `void` | Vast and airless. A very low tone with a slow shimmer far above it. | 23 |
| `temple` | An enormous sacred stone interior. Vast slow air, a brazier, a held tone. | 22 |
| `crypt` | Small, dead, underground. A slow drip and a floor rumble. Tomb, cave, cell. | 15 |
| `hall` | A 19th-century wooden interior with people in it. Theatre, courthouse. | 15 |
| `dig` | An excavation outdoors. Loose grit, thin wind, sparse tool contact. | 13 |
| `fire` | A large fire close by. Broad roar with irregular crackle over it. | 13 |
| `night` | Outdoors after dark. Crickets, cool still air, one far-off dog. | 12 |
| `storm` | Rain on hard ground with distant thunder. | 9 |
| `road` | Travel on foot outdoors. Grit underfoot, wide dry air. | 8 |
| `river` | Moving fresh water close by, reeds on the bank. | 8 |

**Nothing here is sourced either.** No download, no recording, no third-party
file, no reference to one. Every sample is `anoisesrc` shaped by ffmpeg's own
filters; the seeds and constants in the script are the whole provenance, and the
noise sources are seeded so a re-run reproduces every file byte for byte.
`1,724,684 bytes` for thirteen beds — 132,668 each, the same 22 s / mono /
32 kHz / 48 kbps as the rest.

### The two transient recipes, and what had to change

Several of these beds need **events** — a crackle, a drip, a trowel, grit —
where the shipped three are all continuous layers. `AUDIO-CARDS.md` supplies two
ffmpeg-only ways of making them: multiply a bright noise by a slow noise
envelope, then `agate`. Recipe **(a)** is dense irregular texture, recipe **(b)**
is sparse point events. The *structure* is right and is what the beds are built
on. Five of the constants around it did not survive contact with ffmpeg 9.0.1
here, and each is recorded at the point it bites in the script:

1. **`aphaser=speed=0.08`** (`void`, layer B) is a hard error, not a clamp —
   ffmpeg's range is `[0.1, 2]`. Raised to the minimum.
2. **The modulator must be white noise, not pink.** Pink is 1/f, so after
   `lowpass=f=2` it is dominated by sub-0.1 Hz drift and the envelope crosses
   the gate once or twice in twelve seconds instead of eighteen. On white, the
   `lowpass=f=` cutoff really is the event rate, which is what the brief says
   that knob does. The recipe as printed names no colour for `[1:a]`, so this is
   a reading of it rather than a change to it.
3. **Both inputs are normalised to peak 1.0 before they are multiplied.** Left
   raw, recipe (b) produces a product whose peak is 0.017 against a gate
   threshold of 0.02: the gate never opens at all and the layer is silence.
   Normalising makes `agate=threshold=` an honest fraction of full scale, which
   is the only reading under which the brief's own tuning advice — *"the
   modulator's `volume=` against `agate=threshold=` sets sparseness"* — is
   actionable.
4. **Gate thresholds are re-derived on that scale by sweep, not copied.** Every
   recipe (a) layer sits at `0.30`; recipe (b) thresholds are per-layer. Ratio,
   attack and release are verbatim from the brief in every case, because those
   shape the character of a hit rather than how many of them there are.
5. **Recipe (b) adds `range=0.002`.** `agate` floors its gain reduction at
   `range`, default `0.06125` = −24 dB, so "74% near-silence" is unreachable
   with the default — the gaps between drips sit 24 dB down rather than gone.

Measured after those five, per layer, over 12 s in 10 ms frames:

| | frames above ¼ peak | near-silent | discrete events / 12 s |
|---|---|---|---|
| recipe (a) layers | 38–54% | 6–17% | — |
| recipe (b) layers | — | 79–88% | 16–23 |
| *the brief's figures* | *35%* | *11% / 74%* | *18* |

### The seam the engine actually plays, and the one bed that failed it

`loop()` folds the trailing 3 s back over the head, so the **file's** last sample
continues into its first. But the engine does not loop the whole file: it sets
`loopStart = 0.05 s` and `loopEnd = duration − 0.10 s` to step over MP3 encoder
delay and padding. The wrap a reader hears therefore joins ~21.90 s to ~0.05 s,
which the fold never made continuous. In broadband noise that is inaudible,
which is how the shipped eighteen get away with it. For a **sparse event layer**
it is not: cut a drip in half there and it clicks once a lap, forever.

`crypt` did exactly that on its first build — `+3.6 dB` above its own control in
the 2 kHz-and-up seam test, the only bed in the set that failed. The fix is
structural rather than a level tweak: every recipe (b) layer is now windowed to
silence across the whole swept trim region (0–100 ms, and 21.78 s on), so the
wrap is silence-to-silence for the one layer that could ever click at it. That
costs 1.5% of a layer which is near-silent 80% of the time anyway. `crypt`'s HF
seam went from +6.74 dB to +2.93 dB, below its own control.

### `court` — measured, and shipped whole

`AUDIO-CARDS.md` flags `court`'s murmur as the riskiest thing in the spec and
gives a fallback: *"If it comes out sounding like a bad vocal synth, cut layer B
entirely and ship `court` as marble air and tail only."* Nobody on this build can
listen, so the question was put to a number.

The standard correlate of speech intelligibility is the **envelope modulation
spectrum**: connected speech puts a large peak in the amplitude envelope of the
vowel-formant band at the syllable rate, 3–5 Hz, and every intelligibility model
in use — STI, the modulation transfer function, spectro-temporal models — is
built on that band. A room of people at a distance has speech's long-term
spectrum but *not* that peak, because many talkers at random phases average out
and only the sub-1 Hz swell of the crowd survives. That is exactly the difference
between "a murmur" and "a bad vocal synth", and it is measurable. So, over
250–520 Hz (the band layer B occupies), with the envelope taken at 100 Hz:

```
R = energy(2–8 Hz)  /  energy(0.2–1 Hz)
```

| | R |
|---|---|
| the 29 beds in the set with no murmur layer | median **5.25**, max 12.85 |
| `court` | **3.46** — 0.66× the null median |
| `court` layer B alone, before it is mixed | **2.65** — 0.51× the null median |
| `hall` (the same layer, quieter and higher) | **4.45** |

`court` has **less** syllable-band structure than twenty of the twenty-nine beds
that contain no murmur at all, and less than `triumph`'s neighbours in the table.
This is not an ambiguous result and the safe version was not needed: **`court`
ships whole, layer B included.** The mechanism is the brief's own — the 30 ms
attack and 400 ms release smear every gate opening across a third of a second, so
nothing in the layer can be as short as a syllable.

### Measured, not heard

**Nobody on this build has heard these files**, exactly as with the twenty-one
before them. What was done instead is the same battery as part one, with a null
added: the seam statistic is meaningless without one, because a 6 ms RMS window
wanders on its own in noise. So every seam figure is reported beside **the same
statistic computed at 81 contiguous interior points of the same file**, which is
what "at or near local RMS" means for this signal. A bed passes when its seam is
no worse than its own contiguous control. Worst case over a ±40 ms sweep of the
wrap in both columns, because no two MP3 decoders agree on the offset to better
than a few tens of ms.

| bed | LUFS | peak | >500 Hz | seam vs local | contiguous control | HF seam | HF control | verdict |
|---|---|---|---|---|---|---|---|---|
| `court` | -25.1 | -10.5 | -28.9 | +3.05 dB | +3.25 dB | +2.09 dB | +1.74 dB | pass |
| `battle` | -24.5 | -10.9 | -27.9 | +2.32 dB | +2.78 dB | +2.50 dB | +3.04 dB | pass |
| `field` | -24.1 | -10.7 | -27.3 | +2.13 dB | +2.93 dB | +2.25 dB | +2.27 dB | pass |
| `void` | -25.0 | -13.8 | -28.3 | +1.38 dB | +2.18 dB | +1.56 dB | +2.53 dB | pass |
| `temple` | -25.2 | -12.0 | -30.1 | +3.57 dB | +3.91 dB | +2.76 dB | +3.54 dB | pass |
| `crypt` | -25.0 | -10.7 | -29.9 | +2.68 dB | +2.73 dB | +2.93 dB | +3.17 dB | pass |
| `hall` | -24.2 | -10.2 | -28.0 | +3.04 dB | +3.73 dB | +3.13 dB | +2.78 dB | pass |
| `dig` | -24.0 | -10.7 | -27.1 | +1.90 dB | +2.95 dB | +3.73 dB | +4.69 dB | pass |
| `fire` | -23.9 | -12.0 | -27.2 | +2.45 dB | +2.60 dB | +2.36 dB | +5.19 dB | pass |
| `night` | -25.1 | -12.1 | -29.1 | +3.01 dB | +3.29 dB | +4.13 dB | +2.81 dB | pass |
| `storm` | -24.2 | -14.0 | -27.4 | +0.93 dB | +1.81 dB | +1.59 dB | +1.56 dB | pass |
| `road` | -24.0 | -9.7 | -27.1 | +1.60 dB | +2.26 dB | +2.56 dB | +3.23 dB | pass |
| `river` | -24.0 | -12.1 | -27.0 | +1.30 dB | +1.96 dB | +1.32 dB | +2.06 dB | pass |

All thirteen sit inside the shipped envelope: **−25.2 to −23.9 LUFS**, peaks
**−9.7 to −14.0 dBFS** (the bar is ≤ −7.4), and every seam **below** its own
contiguous control — i.e. the wrap is quieter than the material's own variation,
not louder. The `>500 Hz` column is the house rule that a phone speaker must have
something to radiate: these run −27 to −30 dB, between shipped `wind` (−26.7) and
shipped `vault` (−31.8), and far above `reactor` (−39.3), the one bed already
flagged as likely to play as nothing on a phone.

Two mix targets are **clamped**. The brief asks −23 LUFS for `fire` and −26 for
`night`; the envelope this set has to sit inside is −24 to −25, so both are
pulled to its edge. The intent is carried instead by the per-bed `gain` already
in the manifest, which is what that field is for: `fire` is the loudest new bed
at 0.88, `night` the quietest at 0.78. A bed 2 dB hot in the file is 2 dB hot in
every mix; a bed 2 dB hot in its gain is 2 dB hot only where it plays.

One more thing the script does that part one did not: **its intermediates go to a
system temp directory and are deleted on exit.** Part one leaves eleven WAVs in
`audio/_reader-bed-tmp/` and they are in git — 15 MB. Thirteen beds at up to five
layers is fifty more, ~70 MB, on a repo already around 120 MB. (The eleven that
are already tracked are pure build intermediates and could be dropped from the
repo; that is not this build's file to touch.)

---

## Memory and network discipline

* At most **3 decoded beds** held (`CACHE_MAX`), LRU, and a bed that is currently
  sounding is never evicted. A bed is ~3 MB decoded, so the ceiling is ~9 MB.
* The context runs at **32 kHz** (`latencyHint: "playback"`), which cuts the
  decoded footprint by a third against 48 kHz.
* On the tap: `data/audio.json` (**31.5 KB raw, 4.6 KB gzipped** since the
  per-card map was merged in) plus **two** beds — the current one and
  one probe. Thereafter one bed per crossfade, plus read-ahead of the **next
  bed that is different** (not the next card's, which is usually the one already
  playing), bounded to three cards ahead.
* A typical story therefore pulls **2–5 beds, ~300–670 KB**, over the two to
  three minutes of a read — the per-card map moved the mean from 2.3 bed changes
  a story to **3.04**, so it is roughly one more bed than before, ~130 KB. A reader who turns sound on at card 6 pays only for
  card 6 onward. A reader who never taps pulls nothing.
* A bed that 404s is marked failed and **never retried**.

---

## Verification

Run from `rendercheck/`, with `python3 -m http.server 8907` serving `factbox-site/`.

1. `node --check js/audio-reader.js` — passes. An ES5 scan of the same file
   (comments, strings and regex literals stripped first, then ES6+ syntax
   searched for) reports **no arrow functions, no `let`/`const`, no template
   literals, no classes, no shorthand methods, no destructuring, no spread, no
   `async`/`await`, no optional chaining** — before and after this change, an
   identical profile. Three ES6+ **APIs** are used and all three are
   feature-tested on the same line of the bail-out: `Promise`, `fetch`,
   `MutationObserver`.
2. `read.html?s=02` renders with **zero script errors, 11 cards, all 11 carrying
   `data-card` 0–10**, both with this build's files and against the pre-change
   tree served on the same port. The harness stubs Web Audio rather than
   omitting it, so `audio-reader.js` runs its whole path instead of returning at
   the feature test — the no-op path is real but it tests nothing.
3. Every one of the 31 beds referenced by `data/cardaudio.json` **exists in
   `audio/`, is declared in `data/audio.json` under the same filename, and
   serves 200** — asserted programmatically, **0 missing** on all three counts.
   The merge that produced `data/audio.json` asserts the same before it writes,
   plus that every card key it copies is present in the target stack, plus a
   `json.load()` of what it wrote.
4. **The 13 new beds measured**: −25.2 to −23.9 LUFS integrated, peaks −9.7 to
   −14.0 dBFS, and every seam at or **below** its own contiguous control over a
   ±40 ms sweep of the wrap. Table above. `crypt` failed this on its first build
   and was fixed structurally, not by ear.
5. **Regeneration is byte-identical.** `python3 audio/build-reader-beds.py` run
   three times in a row produces the same md5 for all 31 MP3s in `audio/`, and
   the 18 that predate this build come back identical to a copy taken before any
   of it started. Seeded sources, fixed constants, deterministic encoder.
6. **Driven end to end in jsdom** with a stubbed Web Audio and a stubbed bed
   fetch that hands each buffer its own bed name back, so every gain ramp names
   the bed it belongs to. Across three stories, moving `.live` card by card
   resolves **exactly** the sequence `data/cardaudio.json` specifies, and every
   consecutive same-bed card is observed as **nothing happening at all** — no
   fetch, no node, no ramp:

   | stack | resolved | changes | holds |
   |---|---|---|---|
   | `02` Cleopatra the seductress | palace ×2, harbour-arrival ×2, palace ×3, basket ×3, copies | 4 | 7 |
   | `09` Chernobyl | reactor ×7, **fire**, reactor ×2, wind ×2 | 3 | 9 |
   | `26` The Gnostics | coil, **void** ×2, vault ×2, **field**, **void** ×2, copies | 5 | 4 |

   `26` is the off-by-one canary — nine cards whose `n` runs 1–8 then 10 — and it
   resolves correctly, which it would not if `data-card` were read as `c.n`. Its
   card 5 also proves the ordering: that card's `data-beat` is `question`, which
   the stack's `beats` map sends to `coil`, and the engine correctly stays on the
   per-card `vault` instead.

7. **Four degradation paths, all silent, all zero script errors:**

   | what breaks | what happens |
   |---|---|
   | a card names a bed that is not in `beds{}` | falls through to the stack's bed (`copies`), and the undeclared name is never fetched |
   | `data-card` is a value not in the map | falls through to the beat rung, then the stack's bed |
   | `data-stack` *and* `data-card` both unknown | falls through to the topic's bed (`vault`) |
   | `data/audio.json` 404s | the built-in topic map runs — `palace`, `question` → `coil` — and sound still plays |
   | a bed MP3 404s | that card plays nothing and the next card recovers; the bed is marked failed and never retried |
   | the new engine against an `audio.json` with no `cards` at all | behaves exactly like the pre-change build |

---

## Replacing a bed, or adding one

Drop an MP3 into `audio/` and add a row to `beds` in `data/audio.json`. No code
change. If it is synthesised rather than sourced — and it should be — add it to
`audio/build-reader-beds.py` instead of building it by hand, so that the whole
set stays reproducible from one command and the licence stays unambiguous. The spec is unchanged from `scenes/AUDIO.md`: **mono, 32 kHz, 48 kbps
MP3** (not OGG — Safari cannot decode Vorbis), 15–30 s, under ~200 KB, −22 to
−26 LUFS integrated, true peak ≤ −3 dBFS, seamless loop, ambience only — no
sustained tones, no music, no intelligible speech, and no event that repeats on
the loop period.

If the arc feels busy, the single edit is to delete the `landing` accents from
`data/audio.json`: that removes one crossfade from each of the fourteen stacks
that end `… coil, base, search, base` and takes the mean from 2.3 to 1.8.

---

## Every stack, resolved

`·` means the bed did not change on that card — the engine does nothing at all:
no fetch, no node, no ramp. One column per card, in `data-card` order. **Bold**
is one of the thirteen new beds. 51 opening beds plus **155 changes** over 450
cards — **3.04 a story**, against 2.3 for the beat-level map this replaces.

| id | topic | title | bed per card |
|---|---|---|---|
| 01 | cleopatra | How did Cleopatra die? (the snake) | `palace` · · `bath` `basket` · · `search` · · |
| 02 | cleopatra | Cleopatra the seductress | `palace` · `harbour-arrival` · `palace` · · `basket` · · `copies` |
| 03 | cleopatra | Cleopatra's body has never been found | `harbour` · `sea` · **`dig`** · **`temple`** · |
| 04 | church_history | 7 Deadly Sins Explained | `vault` · `wind` · · **`field`** · `scroll` · · · |
| 05 | old_testament | The Ark of the Covenant | **`temple`** · · · · **`battle`** · `reactor` · **`dig`** · · |
| 06 | new_testament | The secret gospel of Mary Magdalene | **`night`** · **`crypt`** · **`field`** · `copies` · · · · |
| 07 | us_history | Lincoln's looks / the slavery debates | `letter` `triumph` · **`battle`** · **`hall`** · · · |
| 07B | old_testament | King David and Bathsheba | `bath` **`field`** · `bath` **`battle`** · **`court`** · · · · · · |
| 08 | us_history | How did Lincoln not have security? | **`hall`** · `door` **`hall`** · **`road`** `letter` · |
| 09 | disaster | Chernobyl | `reactor` · · · · · · **`fire`** `reactor` · `wind` · |
| 10 | new_testament | The death of the Apostle Paul | **`crypt`** **`road`** · · **`crypt`** · · · `copies` |
| 11 | new_testament | Saint Peter, the first pope | `sea` **`field`** · · **`night`** · `triumph` · `vault` · · |
| 12 | new_testament | Three facts about Saint Peter | **`field`** · **`night`** · · `triumph` `vault` · |
| 13 | church_history | Satan isn't God's rival | `coil` `vault` · · · **`fire`** · `vault` |
| 14 | church_history | Timeline of the Book of Revelation | **`void`** `sea` **`void`** · **`battle`** · · · · **`void`** · · |
| 15 | old_testament | Cyrus the Great | **`court`** · **`battle`** · **`temple`** · **`court`** · · |
| 16 | old_testament | The Dead Sea Scrolls | **`crypt`** · `copies` · · · · · · |
| 17 | cleopatra | Cleopatra's tomb | **`crypt`** · `harbour` **`temple`** · · **`dig`** · · |
| 18 | cleopatra | How Cleopatra died | `palace` · `bath` · `basket` · · `gallery` · |
| 19 | cleopatra | Cleopatra's situationships | `palace` · **`court`** · `harbour-arrival` · `sea` · · |
| 20 | cleopatra | The woman who made two powerful men fall | `palace` · · · `basket` · `palace` `triumph` · |
| 21 | us_history | Lincoln kept losing | **`field`** · **`hall`** · · · **`battle`** `letter` |
| 22 | new_testament | Galatians 5: the fruit test | `basket` `copies` **`field`** · · · · · `copies` |
| 23 | new_testament | Mary Magdalene wasn't a prostitute | **`night`** · **`road`** **`crypt`** · `copies` · `gallery` |
| 24 | new_testament | Why did they actually kill Jesus? | `triumph` · **`temple`** · **`court`** **`storm`** · · |
| 25 | new_testament | NASA and the darkness at the crucifixion | **`void`** **`storm`** · **`void`** · · · · |
| 26 | church_history | The Gnostics | `coil` **`void`** · `vault` · **`field`** **`void`** · `copies` |
| 27 | cleopatra | Cleopatra's four children | `palace` · · **`battle`** · `triumph` · `search` |
| 28 | us_history | Lincoln wasn't the only target | **`hall`** · · `letter` · · **`road`** `letter` |
| 29 | new_testament | Why did Jesus need to be betrayed? | **`temple`** · **`night`** · **`temple`** · · · |
| 30 | church_history | Who decided which books got into the Bible? | `copies` · · · `vault` `copies` · · |
| 31 | ancient_world | Alexander the Great's missing tomb | **`battle`** · · **`court`** · **`crypt`** **`dig`** · |
| 32 | medieval_modern | Joan of Arc | **`field`** · **`court`** **`battle`** · **`fire`** `vault` · |
| 33 | church_history | Satan does not rule Hell | **`fire`** `vault` · · · **`fire`** · `gallery` |
| 34 | old_testament | Biblical creatures look nothing like paintings | `gallery` **`void`** · · · · · `gallery` |
| 35 | new_testament | Jesus's brothers and sisters | `copies` **`field`** · `vault` `copies` · · · |
| 36 | church_history | What happened to Pontius Pilate? | **`court`** · **`storm`** **`battle`** · `search` · `vault` |
| 37 | old_testament | The Book of Enoch | `copies` · **`storm`** · **`crypt`** `copies` · · |
| 38 | ancient_world | What killed Alexander the Great? | **`court`** · · `vials` · · **`battle`** `search` |
| 39 | medieval_modern | Napoleon wasn't short | **`court`** · **`battle`** · · `gallery` · · |
| 40 | medieval_modern | Joan of Arc's trial reversed | **`fire`** `vault` · **`fire`** **`battle`** `vault` · · |
| 41 | ancient_world | Nero didn't fiddle while Rome burned | `palace` **`fire`** · · `palace` · · · |
| 42 | church_history | The emperor who converted | `vault` · **`battle`** · · **`court`** `vault` · |
| 43 | medieval_modern | Rasputin wouldn't die | **`river`** **`court`** · `vials` · **`river`** · · |
| 44 | medieval_modern | Genghis Khan's hidden grave | `wind` · · **`battle`** · `door` **`dig`** · |
| 45 | new_testament | Jesus's lost years | **`temple`** · **`field`** · **`road`** · `search` · |
| 46 | old_testament | Where was the Garden of Eden? | **`field`** **`river`** · · · **`dig`** **`field`** · |
| 47 | church_history | Christians who said Jesus didn't suffer | **`storm`** `vault` · · `copies` · `vault` · |
| 48 | church_history | 666 and the Roman emperor | `copies` · **`fire`** `copies` · · · · |
| 49 | church_history | The Antichrist | **`void`** `copies` · · · `vault` · `gallery` |
| 50 | ancient_world | The Ides of March | **`court`** · **`night`** **`court`** · · · · `gallery` |


## Where the control sits, now

Two answers, and they differ on purpose.

On **`/read`** the sound button is the top of `.fb-rail`, the vertical rail at
the foot of the right edge, with Save below it — the thumb's corner, the way a
feed app puts them. `js/audio-reader.js` mounts into `.fb-rail` when the page
has one.

On the **composed story pages** (`story.html`, `cleopatra.html`,
`firststory.html`) it is the rail too. Those three are cut from `read.html` by
`tools/compose.py`, so they carry the same `.fb-rail` and load the same
`css/reader-rail.css`; this paragraph used to say they had no rail and stayed
top-right, and that stopped being true the day compose started cutting from
`read.html` instead of from `scenes/`.

The top-right fixed position in `css/audio-reader.css` is therefore a fallback
rather than a second home: it is what the mount lands on for any page that
loads this stylesheet without a `.fb-rail`, and no page ships that way today.

What has not changed: it never goes below `--bottom-safe`. The Instagram and
TikTok in-app browsers draw their own toolbar over the bottom of the viewport,
and a control down there is a control that cannot be tapped. The rail's floor
sits on that line.
