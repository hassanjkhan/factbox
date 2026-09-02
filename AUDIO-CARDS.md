# Per-card sound design — all 51 stacks, all 450 cards

`data/cardaudio.json` assigns a bed to every card in `data/stacks.json`, chosen
from that card's own `head`, `body`, `beat` and `cap` (the artwork line). This
file is the design note: what the vocabulary is, how it was decided, what the
next agent has to build, and what I could not do honestly.

I own exactly two files: `data/cardaudio.json` and this one. Nothing else in
the repo was touched.

---

## 1. The numbers, up front

| | |
|---|---|
| cards assigned | **450 / 450** |
| stacks | 51 (stack `26` has 9 cards, `n` runs 1–8 then 10 — handled) |
| beds referenced | **31** — 18 existing, **13 new** |
| average bed changes per story | **3.04** (155 changes over 51 stories) |
| distribution | 1 change ×1, 2 ×7, 3 ×33, 4 ×9, 5 ×1 |
| topic-ambient fallback | **31 cards, 6.9%** |
| meta cards held on the surrounding bed | **62 cards, 13.8%** |
| new audio to build | 13 files ≈ **1.7 MB** total at the existing 48 kbps / 32 kHz / 22 s |

**On the fallback number — read this one carefully, because there are two
honest ways to count it and the flattering one is not the whole story.**

* **6.9% (31 cards)** is the number of cards where the bed is the topic-level
  ambient (or the neutral `scroll`) *and the card gave me nothing* — abstract
  doctrine with no place, object, person, or weather anywhere in it. These are
  flagged `"fb": true` in the manifest so you can pull the list. They cluster
  exactly where you'd expect: the seven-deadly-sins virtue list (`04` 8–11),
  the Satan-doctrine stacks (`13`, `33`), Docetism (`47`), the Antichrist
  synthesis (`49`), Jesus's siblings as an interpretive dispute (`35` 5–8), and
  the trailing meta card of three Lincoln stacks.
* **13.8% (62 cards)** is the stricter count and the one I'd quote if pushed:
  every card whose headline begins "WHY…" — the closing meta-commentary card
  that nearly every stack ends on. These have no sonic identity *of their own*.
  They don't get their own bed; they **hold** the room the story just landed
  in, which is what the engine does anyway and what a coda should do. But the
  bed on those cards was not derived from those cards, and calling them
  "assigned" would be overclaiming.

So: roughly **one card in seven has no sound of its own and is riding the
previous card's room**, and roughly **one in fourteen fell all the way through
to the topic ambient**. The other ~79% have a place, an object, a crowd or a
sky named on the card itself, and the `why` string in every entry quotes it.

---

## 2. What I assumed about the engine

I read `js/audio-reader.js` before choosing the shape. Facts it gave me:

* `keyOf(el)` reads `data-stack`, `data-topic` and `data-beat` off the live
  card and resolves `stacks[stack].beats[beat] → stacks[stack].bed →
  topics[topic].beats[beat] → topics[topic].bed → default`.
* `read.html` already writes **`data-card="' + n + '"`** on every `<section>`,
  where `n` is the `s.cards.map(function (c, n) {…})` index — so it is
  **0-based**, not the 1-based `c.n` in `stacks.json`. (Confirmed by the
  `n === 0 ? fetchpriority="high"` branch on the same element.)
* `sync()` returns early when the resolved **key** is unchanged, so N cards on
  one bed cost N−1 no-ops: no fetch, no node, no ramp, no restart.
* A card resolving to `null` **holds** rather than cutting to silence.

**So the manifest is keyed by the 0-based `data-card` string, verbatim**, and
carries the 1-based `n` inside each entry so a human auditing against
`stacks.json` can find the card. Stack `26` proves the choice: its keys are
`"0"`…`"8"` while the `n` values run 1–8 then 10.

The engine change this needs is **two lines**:

```js
function pick(node, beat, card) {
  if (!node) return null;
  if (card != null && node.cards && node.cards[card] &&
      CFG.beds[node.cards[card].bed]) return node.cards[card].bed;   /* + */
  if (beat && node.beats && node.beats[beat] && CFG.beds[node.beats[beat]])
    return node.beats[beat];
  if (node.bed && CFG.beds[node.bed]) return node.bed;
  return null;
}
```

…and in `keyOf`, `var card = attr(el, "data-card");` passed into the two
`pick()` calls. Everything else — the LRU, the read-ahead, the crossfade, the
hold — works unchanged, because a per-card key is still just a bed key.

Two deliberate compatibility choices:

1. **My `stacks` entries carry only `cards`** (plus `title` / `topic` /
   `changes` as audit metadata). No `bed`, no `beats`. That way
   `data/audio.json`'s existing stack-level map stays the authority underneath,
   and a missing card key degrades to the story's bed, then its topic, then
   `scroll` — the existing ladder, untouched.
2. **Same top-level shape as `audio.json`** (`version`, `note`, `base`,
   `default`, `beds`, `topics`, `stacks`). You can either merge this file into
   `audio.json` or fetch it as a second config and deep-merge `stacks[*].cards`
   in. I'd merge — one fetch is better than two on a phone — but the shape
   supports both. `beds[*].status` (`"existing"` / `"new"`) is extra and the
   engine ignores it; strip it if you prefer.

---

## 3. The bed vocabulary — 31 beds

### The 18 that already exist (all 18 are referenced)

| bed | one line |
|---|---|
| `palace` | Fountain in a courtyard, cicadas beyond. The Ptolemaic court. |
| `harbour` | Sea and gulls at dusk. Alexandria from the quay. |
| `harbour-arrival` | Water on hulls, mass, a crowd a quarter-mile off. A ship coming in. |
| `sea` | Open sea, no land. |
| `triumph` | A crowd in the street. The busiest bed in the set. |
| `bath` | Poured water in a hard, reverberant room. |
| `letter` | A still room, a writing hand, a tread beyond the door. |
| `copies` | A scriptorium. Dry, papery, patient. A document being examined. |
| `scroll` | A still small interior. Nowhere in particular, which is the point. |
| `basket` | Close, dry, small. A rustle inside a container. |
| `vials` | A physician's table. Small glass, a pestle, careful handling. |
| `gallery` | A big cool room with a long tail. The room where the paintings are. |
| `vault` | A large dark stone interior. Council chamber, cathedral, trial hall. |
| `wind` | Open, dry, outdoors, no water. Desert, steppe, hillside. |
| `reactor` | A machine room. Cold, continuous, mechanical, no century. |
| `door` | ACCENT. A shut door in near-dark. The room going quiet. |
| `coil` | ACCENT. A low drone under a question. |
| `search` | ACCENT. The room after it was searched. The near-silence of the set. |

`harbour` really is Alexandria and it gets Alexandria (`03`, `17`). `vault`
really is a stone interior and it carries the councils, the trials and the
basilicas. `reactor` carries Chernobyl **and** the 1988 CIA remote-viewing lab
in `05`, which is the same kind of room 40 years apart.

### The 13 new ones

| bed | one line | cards |
|---|---|---|
| `court` | Indoor throne room. Hard marble, a low murmur that never resolves into words. | 35 |
| `battle` | An army at middle distance. Mass, metal, low ground rumble. No voices. | 33 |
| `field` | Open warm countryside. Grass, insects, a bird or two. Galilee, Kentucky, a garden. | 29 |
| `void` | Vast and airless. A very low tone with a slow shimmer far above it. Heaven, the sky, the cosmos. | 23 |
| `temple` | An enormous sacred stone interior. Vast slow air, a brazier hiss, a deep held tone. | 22 |
| `crypt` | Small, dead, underground. No outside at all, a slow drip, a floor rumble. Tomb, cave, cell. | 15 |
| `hall` | A 19th-century wooden interior with people in it. Theatre, courthouse, meeting house. | 15 |
| `dig` | An excavation outdoors. Loose grit and soil, thin wind, sparse tool contact. | 13 |
| `fire` | A large fire close by. Broad roar with irregular crackle over it. | 13 |
| `night` | Outdoors after dark. Crickets, cool still air, one far-off dog. | 12 |
| `storm` | Rain on hard ground with distant thunder. The sky closing over. | 9 |
| `road` | Travel on foot outdoors. Grit underfoot, wide dry air. | 8 |
| `river` | Moving fresh water close by, reeds on the bank. | 8 |

### Beds I designed and then cut, and why

I wrote briefs for six more and deleted them on the same rule: **a bed that
cannot reach five cards is not worth its bandwidth on a phone.**

* `geiger` (sparse radiation clicks) — Chernobyl is the only nuclear story and
  it reached **2 cards**. Those cards went back to `reactor` and `wind`.
* `snow` (cold, muffled, thin high wind) — only Rasputin is wintry. **3 cards.**
  Rasputin now opens and closes on `river`, which the cards actually name.
* `ship` (timber creak, rigging) — `sea` and `harbour-arrival` already cover
  every water card. Paul's "thirty years on the road" is literally the headline,
  so it went to `road`.
* `forge` (hammer, bellows) — the Ark's acacia-and-gold construction, the
  Watchers teaching weapons, and Jesus the *tekton*. **3 cards, three stories,
  one card each.** Folded into `temple`, `storm` and `field`.
* `market` (bazaar, closer than `triumph`) — the Temple money-changers and a
  basket of figs. **~4 cards.** Folded into `temple` and `basket`.
* `tent` (goat-hair cloth, ropes) — the tabernacle. `wind` already is the
  wilderness.

That's why the count is 31 and not 45. I'd rather hand you 13 beds that each
carry 8+ cards than 20 where seven are a one-card novelty the reader pays for
on a mobile connection.

### The three accents, used sparingly on purpose

`door`, `coil` and `search` are single-card accents, and a one-card accent is
exactly the "room changes every swipe" pattern you warned about. So they are
used **13 times in 450 cards**, only where the card is doing the thing the
accent is for:

* `coil` — twice, and both times on **card 1**, the safest possible place
  because nothing precedes it: `13` ("Satan isn't God's rival") and `26`
  ("Why did some early Christians believe the Christian God was evil?").
* `door` — twice: `08`/3 "THEN PARKER DISAPPEARED" (the officer steps away from
  the door outside Lincoln's box) and `44`/6 (Genghis Khan's concealed burial,
  everyone who met the procession killed). Both are the room going quiet.
* `search` — nine cards, always as a landing: "no snake was ever found in the
  room" (`01`), the children who walk out of the record (`27`), history losing
  Pilate (`36`), no body left to test (`38`), eighteen missing years (`45`).

---

## 4. How the stories move

Target was 2–4 changes per story landing on the beats where the story actually
moves. Result: **3.04 average**, 33 stories on exactly 3, and only two outliers.

The two outliers are both honest rather than lazy:

* **`16` The Dead Sea Scrolls — 1 change.** Two runs: `crypt` for the caves at
  Qumran, then `copies` for cards 3–9, which are entirely scholars comparing
  the Great Isaiah Scroll to the Masoretic text on a table. There is no second
  room in that story. Adding one would be a lie.
* **`26` The Gnostics — 5 changes.** `coil` → `void` → `vault` → `field` →
  `void` → `copies`, across 9 cards. It earns them: it moves from a question,
  to a God beyond the material universe, to the Hebrew Bible's creator, to the
  Garden of Eden and the serpent, back to the higher realm, and finally to a
  jar of manuscripts found in 1945.

A worked example, `01` (the flagship's own story), 3 changes over 10 cards:

```
1–3   palace   Octavian invades Alexandria; barricaded inside the royal palace
4     bath     "she took a bath, dressed in royal attire and ate a final meal"
5–7   basket   the asp smuggled in beneath figs in a basket
8–10  search   "no snake was ever found in the room"
```

And `09` Chernobyl, 3 changes over 12:

```
1–7   reactor  the turbine, the cooling pumps, the test at low power, the surge
8     fire     firefighters sent at burning debris without being told what it was
9–10  reactor  Pripyat unevacuated; the reactor releasing for ten days
11–12 wind     a permanent exclusion zone and an abandoned city
```

---

## 5. Licensing

**Nothing here is sourced.** No download, no field recording, no third-party
file, no reference to one. Every one of the 13 new beds is specified below as
`anoisesrc` (ffmpeg's own generator) plus ffmpeg's own filters, in the same
idiom as `audio/build-reader-beds.py`, which built `vault`, `wind` and
`reactor`. The only inputs are the seeds and constants you write down, so the
output is unambiguously ours.

Two things I therefore did **not** specify, having wanted both: a **human
crowd with words in it** and a **struck bell**. A voice cannot be honestly
synthesised from noise, and a bell needs sustained partials, which the shipped
construction forbids (see below). `court` gets a murmur *below intelligibility*
instead, and nothing in the set rings.

---

## 6. Synthesis briefs for the 13 new beds

### House rules — inherited from `audio/build-reader-beds.py`, do not break them

* **22 s loop, 3 s equal-power (`qsin`) fold** — `L, X = 22, 3`, same `loop()`
  helper. The last sample is the one before the first by construction.
* **Mono, 32 kHz, 48 kbps MP3**, `loudnorm=I=-24:TP=-3:LRA=11` (`-25` for the
  darker beds). ≈130 KB each over the wire, ~3 MB decoded.
* **No sustained pure tones.** The engine loops *inside* the file (50 ms in,
  100 ms off the end), so the wrap skips ~150 ms. In noise that's smaller than
  the signal's own sample-to-sample variation; in a sine it's a click per lap.
  Every "tone" and "hum" below is a **narrow noise resonance**
  (`bandpass=…:width_type=q:w=<small>`), never an oscillator.
* **Real energy above 500 Hz.** A phone speaker radiates almost nothing below
  it. Every bed carries a deliberate upper layer or it plays as a failed
  download. This is why `door` and `coil` are near-inaudible on a phone and why
  they stay accents.
* **Every `tremolo` rate ≥ 0.1 Hz, and no period divides 22 s** — otherwise a
  layer breathes in step with the wrap.
* Seed every source. A re-run must reproduce the file byte for byte.

### Two transient recipes — both verified working on ffmpeg 9.0.1 here

The shipped beds are all continuous layers. Several of these need **events**
(crackle, drips, grit, metal). Two ffmpeg-only ways, both tested:

**(a) Dense irregular crackle** — multiply a bright noise by a very slow noise
envelope, then gate:

```
[0:a]highpass=f=1500,lowpass=f=8000[hi];
[1:a]lowpass=f=6,volume=6[mod];
[hi][mod]amultiply,agate=threshold=0.05:ratio=9:attack=1:release=70
```
Measured: 35% of 10 ms frames above ¼ peak, 11% near-silent. Bursty, aperiodic.

**(b) Sparse point events (a drip, a tool strike, a hoof)** — slower modulator,
lower gain, higher ratio, fast release, and a resonant body on the source:

```
[0:a]bandpass=f=2400:width_type=q:w=3,aecho=0.8:0.7:60|110:0.3|0.18[hi];
[1:a]lowpass=f=2,volume=3[mod];
[hi][mod]amultiply,agate=threshold=0.02:ratio=20:attack=0.5:release=25,volume=14dB
```
Measured: **18 discrete events in 12 s, 74% near-silence.**

Tuning axes: the modulator's `lowpass=f=` sets event *rate*; the modulator's
`volume=` against `agate=threshold=` sets *sparseness*; the source's
`bandpass` Q sets the *body* of each hit. `amultiply` needs both inputs the same
length and rate — generate both at `L+X+1` seconds like `loop()` does.

---

### `court` — indoor throne room *(35 cards, the most-used new bed)*
Hard marble, a low human murmur that never becomes words. **Sits between
`vault` and `palace`:** brighter and smaller than `vault`, indoors where
`palace` is a courtyard. Used for Caesar's Senate, Cyrus's empire, David's
house, Alexander's deathbed, Napoleon's throne, the Moika Palace.

* **A — room.** `anoisesrc=c=pink:a=0.55` → `highpass=f=110,lowpass=f=2600,
  aecho=0.8:0.85:230|370:0.28|0.18,tremolo=f=0.11:d=0.2`. Shorter tail than
  `vault`'s 470/930 ms — this room has furniture in it.
* **B — the murmur.** This is the whole character. `anoisesrc=c=pink:a=0.5` →
  `bandpass=f=380:width_type=q:w=1.4` (the vowel-formant region), then recipe
  **(a)** with a *slow* modulator (`lowpass=f=3, volume=4`, gate
  `threshold=0.04:ratio=6:attack=30:release=400`). Long attack and release is
  what keeps it from sounding like speech — you want the *rise and fall of a
  room of people*, never a syllable. −10 dB.
* **C — marble air, the phone-speaker layer.** `anoisesrc=c=pink:a=0.3` →
  `highpass=f=2000,lowpass=f=6500,aecho=0.8:0.75:190|310:0.22:0.12,
  tremolo=f=0.13:d=0.35`. −13 dB.
* Mix `-25 LUFS`. **If B ever resolves into anything you could transcribe, it
  is wrong — widen the bandpass and lengthen the gate.**

### `battle` — an army at middle distance *(33)*
Mass and metal, no voices, no music. Middle distance is the point: this plays
under cards about wars, not under a duel.

* **A — ground.** `anoisesrc=c=brown:a=0.7` → `lowpass=f=180,
  tremolo=f=0.1:d=0.45`, held **−11 dB** (same rule `wind` learned: anything
  below ~220 Hz measures hot at the wrap).
* **B — mass.** `anoisesrc=c=pink:a=0.6` → `highpass=f=200,lowpass=f=1800,
  aecho=0.8:0.6:700|1300:0.2|0.12,tremolo=f=0.13:d=0.5`. 0 dB. The echo taps
  are long and quiet — an open field, not a room.
* **C — metal.** Recipe **(a)**, source
  `bandpass=f=3200:width_type=q:w=2.5,aecho=0.8:0.6:80|150:0.25|0.15`,
  modulator `lowpass=f=5,volume=5`, gate `threshold=0.05:ratio=10:attack=1:
  release=60`. −14 dB. Irregular, never a rhythm — a rhythm reads as marching
  and pins the century.
* Mix `-24 LUFS`.

### `field` — open warm countryside *(29)*
Galilee, Lincoln's Kentucky, the Garden of Eden, a hillside sermon. **Must be
clearly distinct from `wind`:** `wind` is dry and empty; this is alive and has
insects in it.

* **A — air.** `anoisesrc=c=pink:a=0.5` → `highpass=f=200,lowpass=f=1600,
  tremolo=f=0.1:d=0.3`. 0 dB. Gentler than `wind`'s two drifting bands.
* **B — insect bed.** `anoisesrc=c=white:a=0.45` →
  `bandpass=f=4600:width_type=q:w=1.8,bandpass=f=4600:width_type=q:w=1.8,
  tremolo=f=0.19:d=0.25`. −12 dB. Two passes of the same narrow band gives the
  steady high shimmer of a warm afternoon without a tone.
* **C — grass.** `anoisesrc=c=pink:a=0.4` → `highpass=f=900,lowpass=f=3000,
  tremolo=f=0.14:d=0.55`. −10 dB.
* **D — one bird, very sparse.** Recipe **(b)** at `bandpass=f=2800:w=4`,
  modulator `lowpass=f=1.5,volume=2`. −20 dB, i.e. barely there. Optional —
  cut it if it reads as a loop point.
* Mix `-24 LUFS`.

### `void` — vast and airless *(23)*
Heaven, the sky, the cosmos, Revelation's throne room, Ezekiel's wheels, a
lunar eclipse. **The one bed with no room in it at all** — no echo taps, no
reflections, because there are no surfaces.

* **A — the low.** `anoisesrc=c=brown:a=0.7` →
  `bandpass=f=55:width_type=q:w=0.5,tremolo=f=0.1:d=0.15`, **−12 dB**. A very
  narrow *noise* resonance, not a sine. Nearly inaudible on a phone by design;
  it is felt on headphones.
* **B — the shimmer.** `anoisesrc=c=pink:a=0.35` →
  `highpass=f=3500,lowpass=f=9000,tremolo=f=0.12:d=0.6,aphaser=speed=0.08:
  decay=0.3`. 0 dB. **This is the layer that survives a phone speaker** and the
  reason `void` is not just a dark drone. The slow phaser gives the sense of
  something enormous turning.
* **C — mid emptiness.** `anoisesrc=c=pink:a=0.3` →
  `bandpass=f=700:width_type=q:w=0.6,tremolo=f=0.17:d=0.4`. −15 dB.
* No `aecho` anywhere in this bed. Mix `-25 LUFS`.

### `temple` — an enormous sacred stone interior *(22)*
The Holy of Holies, the Jerusalem Temple, Taposiris Magna. **Bigger than
`vault` and warmer:** longer tail, a low held resonance, and a brazier.

* **A — the volume of air.** `anoisesrc=c=pink:a=0.55` → `highpass=f=90,
  lowpass=f=1200,aecho=0.8:0.9:800|1500|2300:0.4|0.28|0.18,tremolo=f=0.1:d=0.2`.
  Three taps out to 2.3 s — `vault` stops at 930 ms. 0 dB.
* **B — the held tone.** `anoisesrc=c=brown:a=0.6` →
  `bandpass=f=115:width_type=q:w=0.8,tremolo=f=0.11:d=0.25`. −10 dB. Narrow
  enough to read as a pitch, noisy enough not to click at the wrap.
* **C — brazier.** Recipe **(a)** at low density: source
  `highpass=f=2200,lowpass=f=7000`, modulator `lowpass=f=4,volume=4`, gate
  `threshold=0.06:ratio=8:attack=2:release=120`. −16 dB. A fire you cannot see.
* **D — stone air (phone layer).** `anoisesrc=c=pink:a=0.3` →
  `highpass=f=1800,lowpass=f=5200,aecho=0.8:0.8:600|1100:0.3|0.18,
  tremolo=f=0.13:d=0.35`. −12 dB.
* Mix `-25 LUFS`.

### `crypt` — small, dead, underground *(15)*
A tomb, a cave at Qumran, a Roman cell. The **inverse of `vault`**: `vault` is
a big stone room with a long tail, this is a tiny one with almost none. No
outside at all.

* **A — dead air.** `anoisesrc=c=pink:a=0.5` → `highpass=f=120,lowpass=f=1100,
  aecho=0.8:0.35:35|60:0.25|0.15,tremolo=f=0.1:d=0.12`. 0 dB. Very short, very
  quiet taps = a small hard box. Almost no movement — a crypt does not breathe.
* **B — floor rumble.** `anoisesrc=c=brown:a=0.6` →
  `bandpass=f=90:width_type=q:w=0.7,tremolo=f=0.11:d=0.2`, **−13 dB**.
* **C — the drip.** Recipe **(b)** verbatim, ~18 events per 12 s, at −8 dB. This
  is the bed's signature and the layer a phone reproduces. Vary the two `aecho`
  taps (60/110 ms) for the ring of the surface it lands on.
* Mix `-25 LUFS`.

### `hall` — a 19th-century wooden interior with people in it *(15)*
Ford's Theatre, an Illinois courthouse, a meeting house. **Wood, not stone** —
that's the whole distinction from `vault` and `court`. Timber absorbs the top
end and rings low.

* **A — wooden room.** `anoisesrc=c=pink:a=0.55` → `highpass=f=130,
  lowpass=f=3200,aecho=0.8:0.55:110|175:0.3|0.2,tremolo=f=0.11:d=0.2`. 0 dB.
  Short bright taps: a boxy room with a low ceiling.
* **B — timber resonance.** `anoisesrc=c=brown:a=0.55` →
  `bandpass=f=170:width_type=q:w=1.2,tremolo=f=0.13:d=0.3`. −9 dB.
* **C — audience.** Same construction as `court`'s murmur but **quieter, drier
  and higher** — `bandpass=f=520:width_type=q:w=1.6`, gate
  `threshold=0.05:ratio=6:attack=25:release=300`, −14 dB. A room where people
  are waiting, not talking.
* **D — one board settling.** Recipe **(b)**, very sparse (modulator
  `lowpass=f=0.8,volume=2`), `bandpass=f=900:w=5`. −18 dB.
* Mix `-24 LUFS`.

### `fire` — a large fire close by *(13)*
Rome in 64 CE, Rouen in 1431, the lake of fire, Reactor 4's debris.

* **A — roar.** `anoisesrc=c=pink:a=0.65` → `highpass=f=150,lowpass=f=4000,
  tremolo=f=0.1:d=0.35`. 0 dB. Broad and continuous — the body of the sound.
* **B — crackle.** Recipe **(a)** at full density: modulator
  `lowpass=f=8,volume=8`, gate `threshold=0.04:ratio=9:attack=1:release=50`,
  source `highpass=f=1800,lowpass=f=9000`. **−4 dB — loud.** This is the layer
  that makes it fire rather than wind, and it is all above 500 Hz.
* **C — heat.** `anoisesrc=c=brown:a=0.6` → `lowpass=f=200,
  tremolo=f=0.17:d=0.5`, **−12 dB**.
* Mix `-23 LUFS` — this is the second-loudest bed in the set after `triumph`.

### `dig` — an excavation outdoors *(13)*
Taposiris Magna, the search for Alexander's tomb, Burkhan Khaldun. **`wind`
with work happening in it**, and a shallower, more granular air than `wind`'s
open steppe.

* **A — thin wind.** `anoisesrc=c=pink:a=0.45` → `highpass=f=250,
  lowpass=f=1900,tremolo=f=0.1:d=0.4`. 0 dB. Deliberately weaker than `wind`'s
  A layer — this site is sheltered by the trench.
* **B — loose grit.** Recipe **(a)**, source `highpass=f=2500,lowpass=f=9000`,
  modulator `lowpass=f=4,volume=5`, gate `threshold=0.05:ratio=8:attack=2:
  release=90`. −8 dB. Sand and spoil moving.
* **C — sparse tool contact.** Recipe **(b)**, `bandpass=f=1400:w=4`,
  modulator `lowpass=f=1.2,volume=2.5`. −13 dB. A trowel every few seconds, not
  every second.
* **D — ground.** `anoisesrc=c=brown:a=0.5` → `lowpass=f=160,
  tremolo=f=0.13:d=0.3`, **−14 dB**.
* Mix `-24 LUFS`.

### `night` — outdoors after dark *(12)*
Gethsemane, the courtyard of the denials, Calpurnia's night before the Ides.
**`field` cooled down:** the insects narrow and get higher, the air loses its
mid, and the whole thing drops several dB.

* **A — cool air.** `anoisesrc=c=pink:a=0.4` → `highpass=f=180,lowpass=f=1200,
  tremolo=f=0.1:d=0.25`. 0 dB.
* **B — crickets.** `anoisesrc=c=white:a=0.5` →
  `bandpass=f=5200:width_type=q:w=3.5,bandpass=f=5200:width_type=q:w=3.5,
  tremolo=f=0.23:d=0.4`. −9 dB. Narrower and higher than `field`'s insect band;
  the `tremolo` gives the pulse without ever landing on a countable beat.
* **C — one far dog / one far bird.** Recipe **(b)**, extremely sparse
  (modulator `lowpass=f=0.6,volume=1.8`), `bandpass=f=700:w=6,
  aecho=0.8:0.5:300|520:0.3|0.2` — the long taps put it a field away. −19 dB.
* **D — low still air.** `anoisesrc=c=brown:a=0.45` → `lowpass=f=140,
  tremolo=f=0.11:d=0.2`, **−15 dB**.
* Mix `-26 LUFS` — the quietest non-accent bed.

### `storm` — rain on hard ground, distant thunder *(9)*
This is effectively **the crucifixion bed** (`24`, `25`, `36`, `47`) as well as
the Watchers' flood in `37`. "Darkness covered the land for roughly three
hours" is the brief.

* **A — rain.** `anoisesrc=c=white:a=0.6` → `highpass=f=700,lowpass=f=11000,
  tremolo=f=0.1:d=0.2`. 0 dB. Broad, bright, continuous.
* **B — rain on a hard surface.** Recipe **(a)** at very high density: modulator
  `lowpass=f=12,volume=10`, gate `threshold=0.03:ratio=6:attack=0.5:release=30`,
  source `highpass=f=3000,lowpass=f=13000`. −7 dB. Gives it the *spatter* that
  separates rain from hiss.
* **C — distant thunder.** `anoisesrc=c=brown:a=0.7` →
  `lowpass=f=220,aecho=0.8:0.7:900|1700:0.35|0.22,tremolo=f=0.11:d=0.6`,
  **−12 dB**. The slow deep `tremolo` is the rolling; do **not** try to gate
  discrete thunderclaps — a clap on a 22 s loop becomes a metronome.
* Mix `-24 LUFS`.

### `road` — travel on foot outdoors *(8)*
Paul's four journeys, the Damascus road, Booth's twelve-day manhunt, the
invented journeys to India. **Not footsteps in a rhythm** — a regular tread on
a loop is the single most obvious repeat in the set.

* **A — wide dry air.** `anoisesrc=c=pink:a=0.5` → `highpass=f=220,
  lowpass=f=2000,tremolo=f=0.1:d=0.45`. 0 dB. Close to `wind` but with less
  high-band drift; the road is lower and more enclosed than the steppe.
* **B — grit underfoot.** Recipe **(a)**, source `highpass=f=1600,
  lowpass=f=7500`, modulator `lowpass=f=7,volume=6`, gate `threshold=0.05:
  ratio=8:attack=1:release=55`. −9 dB. Deliberately **aperiodic** — the gate
  opens on noise, so no two "steps" are the same distance apart.
* **C — heat haze.** `anoisesrc=c=white:a=0.35` →
  `bandpass=f=4200:width_type=q:w=1.5,tremolo=f=0.19:d=0.3`. −14 dB.
* **D — ground.** `anoisesrc=c=brown:a=0.5` → `lowpass=f=170,
  tremolo=f=0.13:d=0.35`, **−13 dB**.
* Mix `-24 LUFS`.

### `river` — moving fresh water, reeds on the bank *(8)*
The four rivers of Eden, the Malaya Nevka. **Must not sound like `sea`:**
no swell, no cycle, no gulls. A river is continuous where the sea breathes.

* **A — moving water.** `anoisesrc=c=white:a=0.6` → `highpass=f=500,
  lowpass=f=8000,tremolo=f=0.1:d=0.12`. 0 dB. The shallow `tremolo` depth is
  the point — almost no amplitude cycle at all.
* **B — the body of the flow.** `anoisesrc=c=pink:a=0.55` →
  `bandpass=f=900:width_type=q:w=0.8,tremolo=f=0.13:d=0.25`. −7 dB.
* **C — bubbles / eddies.** Recipe **(b)** at medium density (modulator
  `lowpass=f=3,volume=3`), `bandpass=f=1800:w=5,aecho=0.8:0.5:25|45:0.2|0.12`.
  −12 dB. Short taps = a small water event, not a drip in a stone room.
* **D — reeds.** `anoisesrc=c=pink:a=0.35` → `highpass=f=2600,lowpass=f=6000,
  tremolo=f=0.17:d=0.5`. −15 dB.
* **E — bank.** `anoisesrc=c=brown:a=0.5` → `lowpass=f=150,
  tremolo=f=0.11:d=0.2`, **−14 dB**.
* Mix `-24 LUFS`.

---

## 7. Verification — run and shown

Produced by the generator at
`<scratchpad>/build_cardaudio.py` (kept out of the repo — I own only
`data/cardaudio.json` and this file). It asserts before it writes:

```
cards assigned      : 450 / 450
stacks              : 51
beds referenced     : 31  (18 existing, 13 new)
bed changes / story : 3.04  (total 155 over 51 stories)
topic-ambient fallback cards : 31  (6.9%)
meta 'WHY...' cards held on the surrounding bed : 62  (13.8%)
file bytes          : 82745
```

The assertions:

* **`total == sum(len(s["cards"]) for s in stacks) == 450`** — the per-stack
  card set is compared element-by-element (`sorted(seen) == sorted(ns)`), so a
  run that overshot or skipped a card fails the build rather than silently
  producing a gap. This is what catches stack `26`'s missing `n = 9`.
* **every bed a run names is in `BEDS`**, and every bed `used` is emitted into
  the `beds` section.
* **every bed marked `existing` has a real file**: `os.path.exists(audio/<k>.mp3)`
  for all 18. None of the 13 new names collides with an existing file.
* **`json.load()` on the written file** before the script exits.

---

## 8. What I could not do honestly

1. **62 cards (13.8%) have no sound of their own.** They are the closing
   "WHY THIS STILL MATTERS" cards, and they hold the previous room. That is the
   right behaviour, but it is a hold, not a design decision about that card, and
   I've counted it as such above rather than folding it into the 79%.
2. **31 cards (6.9%) fell through to the topic ambient** and are flagged `fb`.
   Abstract theology is the bulk of it. There is no sound of "Satan is a created
   being rather than God's equal", and `vault` is a room a church story can sit
   in without lying.
3. **`court`'s murmur is the riskiest thing in this spec.** A room of people is
   the sound I most wanted and the one noise synthesis is worst at. The brief
   deliberately aims *below* intelligibility. If it comes out sounding like a
   bad vocal synth, cut layer B entirely and ship `court` as marble air and tail
   only — it will be a weaker bed but not an embarrassing one. That call belongs
   to whoever hears it.
4. **No bells, no chant, no instrument** anywhere, in a set that is half church
   history. Both are unsynthesisable under the no-sustained-tones rule and the
   no-sourced-audio rule. `vault` and `temple` carry those stories on
   architecture instead.
5. **`why` strings are per-run, not per-card.** Every card carries the evidence
   for *why its run exists*, quoting the specific card text that put the run
   there — but three cards on `basket` share one `why`. Auditing "is this run
   right" works; auditing "is card 6 specifically right" means reading the run.
6. **I could not listen to anything.** The existing 18 beds were judged from
   `data/audio.json`'s notes and `build-reader-beds.py`'s construction, not by
   ear. If `gallery` and `vault` are in practice harder to tell apart than their
   notes claim, some of my `vault` assignments in the church stacks are sitting
   on a distinction that doesn't exist.
7. **The 13 new beds are unheard by definition.** The two transient recipes are
   measured working here (event counts and silence fractions in §6), but "35% of
   frames above quarter-peak" is not the same as "sounds like fire". Expect to
   tune the mix levels; the layer *structure* is the part I'd defend.
