# Factbox reader (read.html) — ambient sound for all 51 stacks

Four files and three new MP3s. Nothing that any other agent owns was touched.

| Owner | Files |
|---|---|
| Audio | `js/audio-reader.js`, `css/audio-reader.css`, `data/audio.json`, `AUDIO-READER.md`, `audio/{vault,wind,reactor}.mp3`, `audio/build-reader-beds.py` |

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

`data-card` and `data-cam` are ignored. `.pane` (the paywall and the end card)
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

It is **not** in the bottom of the viewport, and must never be moved there.
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
stacks[data-stack].beats[data-beat]     the accent this story wants on this card
stacks[data-stack].bed                  this story's room
topics[data-topic].beats[data-beat]     a topic-wide accent
topics[data-topic].bed                  the topic's room
default  ("scroll")                     a still, small, neutral interior
(nothing)                               HOLD whatever is playing
```

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
`door` resolves for nothing at all; it is kept in `beds` because a mapped bed
that nothing carries costs **nothing** (beds are fetched by what is on screen)
whereas an *unmapped* key silently holds the previous bed, which is a bug you
find by ear. Wrong in the cheap direction. `harbour-arrival` carries exactly one
stack (17, Cleopatra's tomb).

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

## Memory and network discipline

* At most **3 decoded beds** held (`CACHE_MAX`), LRU, and a bed that is currently
  sounding is never evicted. A bed is ~3 MB decoded, so the ceiling is ~9 MB.
* The context runs at **32 kHz** (`latencyHint: "playback"`), which cuts the
  decoded footprint by a third against 48 kHz.
* On the tap: `data/audio.json` (~11 KB) plus **two** beds — the current one and
  one probe. Thereafter one bed per crossfade, plus read-ahead of the **next
  bed that is different** (not the next card's, which is usually the one already
  playing), bounded to three cards ahead.
* A typical story therefore pulls **2–4 beds, ~300–550 KB**, over the two to
  three minutes of a read. A reader who turns sound on at card 6 pays only for
  card 6 onward. A reader who never taps pulls nothing.
* A bed that 404s is marked failed and **never retried**.

---

## Verification

Run from `rendercheck/`, with `python3 -m http.server 8899` serving `factbox-site/`.

1. `node --check js/audio-reader.js` — passes.
2. `node checkdata.js "read.html?s=02" ".beat" "Cleopatra"` — **PASS**, 11 cards,
   no script errors, both with and without this file included. jsdom ships no
   Web Audio, which is exactly the no-op path: `window.AudioContext` is
   undefined, the script returns before it creates anything, and no control is
   added to the page. A blank page is the one failure mode that matters here and
   the whole body is inside a `try/catch` besides.
3. Every filename in `data/audio.json` exists in `audio/` — checked
   programmatically, 18/18 present, 0 missing.
4. Driven end to end in jsdom with a stubbed Web Audio API and a stubbed
   network: nothing of ours fetched before the tap; on the tap exactly the config
   plus two beds; the label toggles and the preference is stored; every card of
   the story marked live in turn produces the expected number of crossfades and
   **holds on the rest**; tapping off stops every voice.

---

## Replacing a bed, or adding one

Drop an MP3 into `audio/` and add a row to `beds` in `data/audio.json`. No code
change. The spec is unchanged from `scenes/AUDIO.md`: **mono, 32 kHz, 48 kbps
MP3** (not OGG — Safari cannot decode Vorbis), 15–30 s, under ~200 KB, −22 to
−26 LUFS integrated, true peak ≤ −3 dBFS, seamless loop, ambience only — no
sustained tones, no music, no intelligible speech, and no event that repeats on
the loop period.

If the arc feels busy, the single edit is to delete the `landing` accents from
`data/audio.json`: that removes one crossfade from each of the fourteen stacks
that end `… coil, base, search, base` and takes the mean from 2.3 to 1.8.

---

## Every stack, resolved

`·` means the bed did not change on that card — the engine does nothing at all.
Cards are in order: hook, escalation, evidence, complication, question, turn, landing, then extras.

| id | topic | title | bed per card |
|---|---|---|---|
| 01 | cleopatra | How did Cleopatra die? (the snake) | `palace` · · · `coil` `basket` `palace` · · · |
| 02 | cleopatra | Cleopatra the seductress | `palace` · · · · `gallery` `palace` · · · · |
| 03 | cleopatra | Cleopatra's body has never been found | `harbour` · · · `coil` `harbour` `search` `harbour` |
| 04 | church_history | 7 Deadly Sins Explained | `vault` · · · · · · · · · · |
| 05 | old_testament | The Ark of the Covenant | `vault` · · · `coil` `vault` `search` `vault` · · · · |
| 06 | new_testament | The secret gospel of Mary Magdalene | `copies` · · · `coil` `copies` · · · · · |
| 07 | us_history | Lincoln's looks / the slavery debates | `letter` · · · · `triumph` `letter` · · |
| 07B | old_testament | King David and Bathsheba | `bath` · · · `coil` `bath` · · · · · · · |
| 08 | us_history | How did Lincoln not have security? | `letter` · · · `coil` `letter` `search` `letter` |
| 09 | disaster | Chernobyl | `reactor` · · · `coil` `reactor` `search` `reactor` · · · · |
| 10 | new_testament | The death of the Apostle Paul | `vault` · · · `coil` `vault` `search` `vault` · |
| 11 | new_testament | Saint Peter, the first pope | `vault` · · · `coil` `vault` `search` `vault` · · · |
| 12 | new_testament | Three facts about Saint Peter | `sea` · · · · `vault` `sea` · |
| 13 | church_history | Satan isn't God's rival | `vault` · · · `coil` `vault` · · |
| 14 | church_history | Timeline of the Book of Revelation | `vault` · · · `coil` `vault` · · · · · · |
| 15 | old_testament | Cyrus the Great | `wind` · · · · `triumph` `wind` · · |
| 16 | old_testament | The Dead Sea Scrolls | `wind` `copies` · · · · · · · |
| 17 | cleopatra | Cleopatra's tomb | `harbour-arrival` · · · `coil` `harbour-arrival` `search` `harbour-arrival` · |
| 18 | cleopatra | How Cleopatra died | `palace` · · · `coil` `vials` `palace` · · |
| 19 | cleopatra | Cleopatra's situationships | `palace` · · · · · · · · |
| 20 | cleopatra | The woman who made two powerful men fall | `palace` · · · · `triumph` `palace` · · |
| 21 | us_history | Lincoln kept losing | `letter` · · · · · · · |
| 22 | new_testament | Galatians 5: the fruit test | `copies` · · · · · · · · |
| 23 | new_testament | Mary Magdalene wasn't a prostitute | `copies` · · · · · · · |
| 24 | new_testament | Why did they actually kill Jesus? | `wind` · · · `coil` `wind` `search` `wind` |
| 25 | new_testament | NASA and the darkness at the crucifixion | `wind` · · · `coil` `wind` · · |
| 26 | church_history | The Gnostics | `copies` · · · `coil` `copies` · · · |
| 27 | cleopatra | Cleopatra's four children | `palace` · · · · · `triumph` `palace` |
| 28 | us_history | Lincoln wasn't the only target | `letter` · · · `coil` `letter` `search` `letter` |
| 29 | new_testament | Why did Jesus need to be betrayed? | `wind` · · · `coil` `wind` · · |
| 30 | church_history | Who decided which books got into the Bible? | `copies` · · · · · · · |
| 31 | ancient_world | Alexander the Great's missing tomb | `gallery` · · · `coil` `gallery` `search` `gallery` |
| 32 | medieval_modern | Joan of Arc | `vault` · · · `coil` `vault` `search` `vault` |
| 33 | church_history | Satan does not rule Hell | `vault` · · · `coil` `vault` · · |
| 34 | old_testament | Biblical creatures look nothing like paintings | `gallery` · · · · · · · |
| 35 | new_testament | Jesus's brothers and sisters | `copies` · · · · · · · |
| 36 | church_history | What happened to Pontius Pilate? | `vault` · · · `coil` `vault` `search` `vault` |
| 37 | old_testament | The Book of Enoch | `copies` · · · `coil` `copies` · · |
| 38 | ancient_world | What killed Alexander the Great? | `palace` · · · `coil` `vials` `palace` · |
| 39 | medieval_modern | Napoleon wasn't short | `gallery` · · · · `triumph` `gallery` · |
| 40 | medieval_modern | Joan of Arc's trial reversed | `vault` · · · `coil` `vault` · · |
| 41 | ancient_world | Nero didn't fiddle while Rome burned | `triumph` · · · `coil` `triumph` · · |
| 42 | church_history | The emperor who converted | `vault` · · · · `triumph` `vault` · |
| 43 | medieval_modern | Rasputin wouldn't die | `vault` · · · `coil` `vault` `search` `vault` |
| 44 | medieval_modern | Genghis Khan's hidden grave | `wind` · · · `coil` `wind` `search` `wind` |
| 45 | new_testament | Jesus's lost years | `wind` · · · `coil` `wind` `search` `wind` |
| 46 | old_testament | Where was the Garden of Eden? | `wind` · · · `coil` `wind` · · |
| 47 | church_history | Christians who said Jesus didn't suffer | `vault` · · · · · · · |
| 48 | church_history | 666 and the Roman emperor | `vault` · · · `coil` `vault` · · |
| 49 | church_history | The Antichrist | `vault` · · · `coil` `vault` · · |
| 50 | ancient_world | The Ides of March | `triumph` · · · `coil` `triumph` `search` `triumph` · |
