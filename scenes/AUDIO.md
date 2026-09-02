# Factbox reader — ambient sound

Three files, one folder of MP3s.

| Owner | Files |
|---|---|
| Audio | `scenes/audio.js`, `scenes/audio.css`, `scenes/AUDIO.md`, `factbox-site/audio/*.mp3` |

Nothing the shell or the scenes own was touched. The sound system reads exactly
two things out of their DOM: the **`.live` class on `.page`**, which is the build
contract, and the **`s-*` class on that page's `.scene`**, which is how a beat
says which bed it wants. It knows nothing about `STORIES`, so a new beat or a
whole new story needs no change in here.

---

## Wiring it into the composer

Two lines in `compose.py`:

```python
css = "\n".join((S / f).read_text()
                for f in ("shell.css", "a.css", "b.css", "audio.css"))   # + audio.css
audio_js = (S / "audio.js").read_text()                                   # new

page = page.replace('<script src="shell.js"></script>',
                    f"<script>\n{js}\n</script>\n<script>\n{audio_js}\n</script>")
```

Order matters only in that `audio.js` must come after `shell.js` — it reads the
deck the shell has already built. `audio.css` can go anywhere in the block; it
does not override anything.

**Cost to the page:** +30.5 KB raw, +10.8 KB gzipped. Most of that is comments.
**No audio byte is fetched until a reader asks for sound**, so for the majority
who never tap it, the whole feature costs that ~11 KB and nothing else. Adding
the seven new beds added 3 KB raw / under 1 KB gzipped to the page — the beds
themselves are files on the server, not page weight.

`artifact_story.html` gets the same code, but the beds are relative URLs with
nothing to resolve against in an artifact preview — so they 404, and the control
quietly retires itself. That is the designed empty-folder path, not a bug.

---

## What it does

* One looping bed per scene, **crossfaded** as `.live` moves down the deck.
* **Off by default.** Nothing is created, fetched, or decoded until a tap.
* **One tap on, one tap off**, at any moment, from any beat.
* **Remembered** across beats and reloads (`localStorage["fb-sound"]`).
* **Silent no-op** if Web Audio is missing, if the context will not start, or if
  the beds are not on the server.

### The beds are keyed by scene, not by beat

Which is what makes the *hold, don't restart* requirement fall out for free —
beats 2 and 3 are both `s-fleet`, so moving between them resolves to the same
bed and the code does nothing at all: the sea rolls straight across the cut.

The story used to have eight scenes across thirteen beats, so five beats reused
a picture and five reused a bed. It now has thirteen scenes, and each one has
its own bed. Beat numbers are deliberately not in this table — the deck is
still being reordered as the new scenes land, and the mapping does not depend
on them.

| Scene | Bed | What it is |
|---|---|---|
| `s-door` | `door.mp3` | A closed, dark room. Low hush, a breath of air, nothing bright. |
| `s-fleet` | `sea.mp3` | Open sea. Holds across both Actium beats. |
| `s-harbour` | `harbour-arrival.mp3` | The Roman fleet entering the Great Harbour. Water on hulls, the sea behind it, a few hundred men across a quarter mile of water. |
| `s-triumph` | `triumph.mp3` | A crowd in the streets of Rome. The loudest, most populated bed in the story. |
| `s-bath` | `bath.mp3` | A palace bathing room. Poured water in a hard, reverberant room. |
| `s-letter` | `letter.mp3` | A still room and a stylus, with a tread somewhere beyond the door. |
| `s-coil` | `coil.mp3` | A low drone. The question and the verdict, unbroken. |
| `s-search` | `search.mp3` | The room after the guards searched it. Nearly silence. |
| `s-copies` | `copies.mp3` | A scriptorium. Dry, papery, patient. |
| `s-basket` | `basket.mp3` | Close, dry, small. |
| `s-mausoleum` | `vials.mp3` | A physician's table. Small glass, a pestle, careful handling. |
| `s-painting` | `gallery.mp3` | A big cool room with a long tail. |
| `s-pharos` | `harbour.mp3` | Sea and gulls at dusk. |
| `s-scroll` | `scroll.mp3` | *Kept as a fallback.* A still small interior. |
| `s-afternoon` | `palace.mp3` | *Kept as a fallback.* A fountain in a court, cicadas beyond it. |
| *(no scene class)* | — | **Holds** whatever is playing. An unmapped beat keeps the current bed rather than cutting to silence, so the closing card is a coda, not a hard stop. |

`s-bath`, `s-letter` and `s-search` take over what `s-afternoon` and `s-scroll`
used to cover twice each, as the new scenes land in the deck. Both old rows are
still in `BEDS` on purpose: a mapped
scene that no beat carries costs **nothing** — beds are fetched by what is on
screen, so an unused row is never requested — whereas an *unmapped* scene
silently holds the previous bed, which is a bug you find by ear. Wrong in the
cheap direction.

---

## The five constraints, and where each is answered

**1 — Autoplay is blocked; a failed attempt must be invisible.**
It never attempts. The `AudioContext` is not even constructed until a real tap.
A remembered "on" does not autoplay either: the control shows the state it will
be in, pulses gently, and waits for the reader's first `pointerdown` — which on
a scroll deck is their first swipe, about a second away. Verified: with
`fb-sound=on` in storage, **zero** requests to `audio/` until a gesture arrives.

**2 — Off by default, obvious, one tap, reversible.**
A glass pill top-right, mirroring the sources pill top-left: same height, same
blur, same border, same press. It states the state — *Sound off* / *Sound on* —
rather than the action, with the action in its `aria-label`. Two soft pulses on
the title beat so it is noticed, then never again, and never under reduced
motion. `aria-pressed` tracks it.

**3 — The iOS silent switch.**
The hardware switch mutes Web Audio in Safari and **there is no API that reports
it**: an `AnalyserNode` sees the graph, not the speaker. So the page cannot
detect it and cannot honestly pretend to. What it can do is stop the reader
concluding the page is broken — the moment sound actually starts, a one-line
note appears under the pill:

> Sound on. Hearing nothing? The silent switch on the side of your phone mutes this.

(Non-Apple devices get *"Check your device volume."*) Once per device, stored
under `fb-sound-hint`, then never again.

**4 — 121 KB, loads instantly on cellular.**
Nothing audio is requested until the tap. On the tap, exactly two beds are
fetched: the current one and one beat of read-ahead. Beds are mono, 32 kHz,
48 kbps MP3, **118–165 KB each**, and at most three are held decoded (LRU, and a
bed that is currently sounding is never evicted). A reader who never taps pulls
none of it.

**This got more expensive when the story went from eight scenes to thirteen,
and the number is worth saying out loud.** The whole set was 1.1 MB and is now
**2.0 MB**, because five beats that used to share a bed with a neighbour now
have their own. A reader who turns sound on at the first beat and reads to the
end now pulls about **1.9 MB** instead of about 1 MB, spread across three
minutes — roughly 10 KB/s, which is nothing on any connection that can load the
page's images at all, but it is not free and it is double what it was. Nothing
is prefetched beyond one beat, so the peak burst is still two files (~300 KB),
and a reader who turns sound on at beat 9 still only pays for beats 9 onward.

**5 — Reduced motion as a hint about this reader.**
Sound stays available (an explicit tap is an explicit tap), but under
`prefers-reduced-motion` the control stops drawing attention to itself — no
pulse, no breathing — and the beds play at 0.17 master instead of 0.26. Followed
live if the setting changes mid-read.

### The empty-folder path, exactly

A button that silently does nothing is worse than no button. So on the first tap
the system tries the current bed **and one other**; if both fail and nothing has
ever decoded, the folder is empty (or the host is serving HTML 404s) and the
control says **"No sound available"**, disables itself, fades, and removes itself
from the DOM. The remembered preference is cleared so the next reload is clean.
Two probes rather than one so that a single missing bed cannot retire the whole
system.

Verified headless with the folder empty: control appears, one tap, honest label,
gone — **no thrown errors, no unhandled rejections, no console output, no layout
shift** (the control is `position:fixed`; it cannot move the deck). The only
trace is two `404`s in the network panel, which is the unavoidable cost of
discovering that a file is absent.

---

## Why Web Audio and not `<audio>`

The long version is at the top of `audio.js`. The short version:

1. **iOS Safari ignores `HTMLMediaElement.volume`.** Setting it from script is a
   no-op on iPhone. An `<audio>` crossfade does not merely stutter on the
   platform that is ~all of our traffic — it does not exist. A `GainNode` is
   honoured everywhere.
2. `<audio loop>` re-buffers at the loop point and audibly gaps. An
   `AudioBufferSourceNode` with `loop = true` is sample-exact.
3. Gain ramps are scheduled on the audio thread, so a fade does not wobble when
   the main thread is busy — and it always is, because the reader is mid-snap.

The crossfade uses `setTargetAtTime`, not the textbook equal-power
`setValueCurveAtTime`. A reader flicking through beats fires overlapping fades,
and a value curve that overlaps a scheduled event *throws*, mid-story, on the
audio thread. `setTargetAtTime` cannot collide: it always starts from wherever
the value actually is. Two uncorrelated ambiences crossfaded exponentially dip
by well under a decibel in the middle, which nobody has ever heard.

---

## The beds that shipped — provenance

Everything below is either **CC0 / public domain with a citable licence tag**, or
**synthesised from filtered noise by this build**, which is nobody's copyright.
Nothing was used that could not be licensed. Sources, in full:

| Recording | Licence | By | File page |
|---|---|---|---|
| Ocean Waves on a Tropical Beach | **CC0** (`{{self\|cc-zero}}`) | Jarrod stanley / J.D. Savanyu, own work | <https://commons.wikimedia.org/wiki/File:Ocean_Waves_on_a_Tropical_Beach.ogg> |
| La fontaine de la place | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|aldor}}`) | aldor, pdsounds.org rec. 592 | <https://commons.wikimedia.org/wiki/File:La_fontaine_de_la_place.ogg> |
| Cicadas in Greece | **PD** (`{{PD-self}}`) | Channel R, own work | <https://commons.wikimedia.org/wiki/File:Cicadas_in_Greece.ogg> |
| Gulls above the street at dawn | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|earthcalling}}`) | earthcalling, pdsounds.org rec. 344 | <https://commons.wikimedia.org/wiki/File:Gulls_above_the_street_at_dawn.ogg> |
| Uneasy rustling ambience | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|stephan}}`) | stephan, pdsounds.org rec. 422 | <https://commons.wikimedia.org/wiki/File:Uneasy_rustling_ambience.ogg> |

### Added for the seven new beds

All fourteen are the same provenance: **pdsounds.org**, which released its whole
catalogue into the public domain, transferred to Commons by Fæ, each page
carrying `{{PD-pdsounds.org}}` plus `{{PD-author|<uploader>}}`. Every `Source`
field points at `pdsounds.org/audio/download/<id>/…` — the site itself, not a
third party — which is the check that matters and the one the rejected file
below failed.

| Recording | Licence | By | File page |
|---|---|---|---|
| High school cafeteria | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|aradlaw}}`) | aradlaw, pdsounds.org rec. 633 | <https://commons.wikimedia.org/wiki/File:High_school_cafeteria.ogg> |
| 1 minute at the alexa mall in berlin | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|thore}}`) | thore, pdsounds.org rec. 407 | <https://commons.wikimedia.org/wiki/File:1_minute_at_the_alexa_mall_in_berlin.ogg> |
| Church people walking steps with reverb | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|stephan}}`) | stephan, pdsounds.org rec. 295 | <https://commons.wikimedia.org/wiki/File:Church_people_walking_steps_with_reverb.ogg> |
| Le marche daligre | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|aldor}}`) | aldor, pdsounds.org | <https://commons.wikimedia.org/wiki/File:Le_marche_daligre.ogg> |
| Boat by a wharf 2 | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|ezwa}}`) | ezwa, pdsounds.org rec. 643 | <https://commons.wikimedia.org/wiki/File:Boat_by_a_wharf_2.ogg> |
| Boat by a wharf 3 | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|ezwa}}`) | ezwa, pdsounds.org rec. 644 | <https://commons.wikimedia.org/wiki/File:Boat_by_a_wharf_3.ogg> |
| Indoor swimming pool hall | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|stephan}}`) | stephan, pdsounds.org rec. 417 | <https://commons.wikimedia.org/wiki/File:Indoor_swimming_pool_hall.ogg> |
| Water flowing pouring trickling | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author}}`) | pdsounds.org | <https://commons.wikimedia.org/wiki/File:Water_flowing_pouring_trickling.ogg> |
| 20090610 0 ambience | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|nille}}`) | nille, pdsounds.org rec. 707 | <https://commons.wikimedia.org/wiki/File:20090610_0_ambience.ogg> |
| Pencil scratchings | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author}}`) | pdsounds.org | <https://commons.wikimedia.org/wiki/File:Pencil_scratchings.ogg> |
| Ambient classroom mono | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|rcrossley}}`) | rcrossley, pdsounds.org rec. 580 | <https://commons.wikimedia.org/wiki/File:Ambient_classroom_mono.ogg> |
| Water sloshing in a small bottle | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|tamanders}}`) | tamanders, pdsounds.org rec. 248 | <https://commons.wikimedia.org/wiki/File:Water_sloshing_in_a_small_bottle.ogg> |
| Binging glass | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author\|hugh}}`) | hugh, pdsounds.org rec. 548 | <https://commons.wikimedia.org/wiki/File:Binging_glass.ogg> |
| Mixing spices | **PD** (`{{PD-pdsounds.org}}` + `{{PD-author}}`) | pdsounds.org | <https://commons.wikimedia.org/wiki/File:Mixing_spices.ogg> |

None of these require attribution. Crediting them anyway would be in character
for this product; a line in the closing card's sources sheet would do it.

### Which bed is made of what

| Bed | Recording | Synthesised | Notes |
|---|---|---|---|
| `door.mp3` | Ocean Waves, everything above 190 Hz removed | + low brown-noise room tone, + a whisper of air | The sea heavily low-passed is a slow breathing hush that reads as *still night room*, not as *sea*. The next beat opening up to the real thing is the point. |
| `sea.mp3` | Ocean Waves, 25–52 s | — | The whole bed. |
| `scroll.mp3` | — | **all** | Filtered brown noise + a little air. |
| `palace.mp3` | Fountain 56–76 s + Cicadas at −16 dB | — | Alexandria, August. |
| `coil.mp3` | — | **all** | Two wide noise resonances a fifth apart (88 / 132 Hz) + a slow tremolo. |
| `basket.mp3` | Uneasy rustling at −9 dB | + dark low floor | See the warning below. |
| `gallery.mp3` | — | **all** | Pink noise, band-limited, with a 290/610 ms room around it. |
| `harbour.mp3` | Ocean Waves 200–228 s + Gulls at −11 dB | — | Gulls high-passed at 420 Hz to drop the street under them. |
| `harbour-arrival.mp3` | Boat by a wharf 2 (58 s) + Ocean Waves (90 s) at −6 + cafeteria at −13 + church footfalls at −15 + Boat by a wharf 3 at −12 | + a swell layer at −12 | See below on the crowd, and on the oars that are not there. |
| `triumph.mp3` | Cafeteria + mall at −5 + market at −9 + church footfalls at −7 | + a low processional rumble at −14 | Three uncorrelated crowds, two of them pitched down 6–8%. |
| `bath.mp3` | Water flowing/trickling (30 s) + swimming pool hall at −11 | + a dark floor at −8 | The water gets a 170/330 ms room; the pool supplies a real hard-room tail. |
| `letter.mp3` | Still-room ambience (1 s) + pencil at −14 + church footfalls at −18 | + air at −24 | The footfalls are low-passed to 600 Hz — a tread through a wall. |
| `search.mp3` | Still-room ambience (1 s), low-passed to 1.5 kHz | + a floor at −6, + a drifting 2–7 kHz layer at −18 | The quietest bed in the set. See the note on phone speakers. |
| `copies.mp3` | Pencil at 16 s + the same pencil at 55 s, −8% and echoed, at −9 + classroom tone at −16 | + dry paper air at −22 | Two windows 40 s apart are uncorrelated: one hand near, one across the room. |
| `vials.mp3` | Water sloshing (two rates) + spice grinding at −12 + glass at −21 | + cool air at −20, + a low floor at −7 | Two-stage tiling; see `build-beds.py`. |

### Rejected, and why — this matters more than what shipped

* **`292934-152 Writing-pen-paper…wav`** — tagged `{{cc-zero}}` on Commons, but
  its stated source is **soundsnap.com**, a commercial stock library. A CC0 tag
  applied by an uploader to somebody else's paid catalogue is not a licence.
  Rejected. It was the best pen-on-paper bed available and it is not worth it.
* **`Koulu-ambience1.wav`** (genuinely CC0) — a school corridor with footfalls
  every few seconds. A footfall on an 8-second loop is a metronome. Rejected on
  quality, not licence; `gallery.mp3` is synthesised instead.
* **`Old book.ogg`, `Book paper pages assorted.ogg`** (PD) — 38 dB and 18 dB
  peak-to-median spread. Page turns, not ambience. Nothing to loop.

### Rejected for the seven new beds

The founder asked for *"people murmuring, walking, crowds"*, and human sound is
the most dangerous category on Commons: crowd, walla and footstep recordings are
the bread and butter of commercial stock libraries, and they are the ones that
get re-uploaded with a licence tag the uploader was not entitled to apply. The
rule used was **check the stated source, not the tag** — and the source has to
be somewhere that had the right to release it.

* **`360703 eguobyte large-crowd-medium-distance-stereo.wav`**,
  **`211146 unfa another-crowd.flac`**, **`442697-SBssa-Crowd Talking 003.wav`**
  — the leading numeral is a Freesound sound ID, i.e. these are Freesound
  imports. Freesound CC0 is a real licence *when the Freesound uploader is the
  recordist*, and for a generic large-crowd recording that is exactly the thing
  that cannot be verified from the Commons page. Not used: `triumph.mp3` did not
  need them, and taking a chance on provenance to save one layer is the trade
  the previous agent already refused once.
* **`Cathedralofthedowns.ogg`** (PD-pdsounds, licence fine) — rejected on
  content. Its spectrogram is a stack of harmonics pulsing about every 1.2 s:
  it is singing or an organ, not a room. Music in a loop is unlistenable twice.
* **`Bathtub water splashes.ogg`** (PD-pdsounds) — 31.5 dB peak-to-median
  spread over 20 s. A series of splashes, not a bathing room. It is the obvious
  file for `bath.mp3` and it is the wrong one; `bath.mp3` is built from a
  continuous trickle and a real reverberant water hall instead.
* **`Chiming pottery.ogg`** (PD-pdsounds) — 26.7 dB spread, four clear strikes.
  Same problem for `vials.mp3`; the dense region of `Binging glass.ogg` was used
  instead, because dense is a texture and sparse is an event.
* **`Group discussion 1.ogg`, `Group discussion 3.ogg`, `Restaurant
  ambience.ogg`** (all PD-pdsounds) — close, intelligible speech. A bed with
  words in it is a bed the reader listens *to*.
* **An oar stroke for `harbour-arrival.mp3`** — not rejected, never made. A
  stroke is a rhythm and a rhythm in a 26 s bed is a metronome, which is the one
  thing the whole loop spec exists to prevent. What is there instead is water on
  a hull plus a swell layer carrying two slow tremolos at 0.41 and 0.33 Hz,
  which beat against each other and never lock into a beat you can count.

---

## Honest limitations — read this before shipping

**Nobody on this build has heard these files.** There were no ears in the loop,
for the seven new beds either. What was done instead, per bed:

* **Stationarity** — per-second RMS across the whole loop. All fifteen sit
  within 0.7–4.5 dB p10→p90 spread, i.e. no lump that will announce itself once
  a lap. (The seven new ones are 0.7–3.0 dB.)
* **Loudness** — EBU R128 integrated, −22.2 to −26.2 LUFS, true peak ≤ −3.3 dBFS.
* **Loop seam** — the sample discontinuity at the point the browser actually
  wraps, measured against the local RMS around it. All fifteen are at or below
  local RMS, i.e. indistinguishable from the signal.
* **Spectrograms** — inspected by eye for tonal artefacts, periodic events, and
  (for the crowds) for the harmonic tracks that would mean an intelligible
  voice. The three crowd recordings show a broadband wash with no sustained
  formant tracks even before they are summed and low-passed.

That is a decent proxy for "will not be annoying". **It is not a proxy for
"sounds good", and it is not a proxy for "sounds like Rome".** Nothing here has
been checked against the thing it is supposed to depict; it has been checked
against the things that make a loop unbearable.

**Audition these three first, in this order:**

1. **`vials.mp3`** — the busiest of the new beds. Its spectrogram is a dense
   field of small transients, which is what "small glass, a pestle, careful
   handling" ought to look like and is also what gravel looks like. If it reads
   as clutter rather than as a table being worked at, drop the `via_b` slosh
   layer and the `via_d` glass layer in `build-beds.py`; the base slosh and the
   grinding alone will still carry it.
2. **`harbour-arrival.mp3`** — heavily weighted below 2 kHz. Measured, it is
   correct: water, mass, arrival. Heard, it may just be a big low rumble with
   the crowd and the rigging buried under it. If so, raise the `har2_c` (crowd)
   and `har2_e` (hull knocks) layers by 3–4 dB.
3. **`basket.mp3`** — unchanged from the previous build; the original warning
   still stands (it is a baby's rattle, and it may sound like one).

### Two things the measurements found that are worth knowing

**Phone speakers cut off below about 500 Hz, and some of these beds are almost
entirely below it.** Measured as integrated loudness after a 500 Hz high-pass —
a rough stand-in for what a phone driver actually radiates — the set ranges from
`triumph` at −23 dB down to `door` at −55 dB and `coil` at −50 dB. Those last
two are *shipped* beds and they are near-inaudible on a phone regardless of the
master; on a laptop or headphones they are exactly right. This is not a defect
introduced here, but it is the reason `search.mp3` is built with a deliberate
2–7 kHz layer at −18 dB instead of the −26 it wants: it is a near-silence, and a
near-silence made only of low end is a file that plays as nothing on the device
this is actually read on — which is indistinguishable from the failed download
the whole system is designed never to look like.

**The drop from `coil` into `search` inverts on a phone.** Full-band, `coil`
plays at an effective −37 LUFS and `search` at −44, so the aftermath of the
search is a 7 dB drop into near-silence, as intended. Above 500 Hz, `coil` is
−63 and `search` is −55, so on a phone speaker the same cut is a slight *rise*
into a faint hush. Both readings are defensible — "the room is too quiet" still
lands either way — but if this matters, the fix is in `coil.mp3` (give the drone
some 1–2 kHz), not in `search.mp3`, and `coil.mp3` is a bed the founder has
already heard and not complained about. Flagged, not changed.

---

## Replacing a bed, or supplying your own

Drop a file into `factbox-site/audio/` with the right name and it works. No code
change, no rebuild, no cache-bust.

```
factbox-site/audio/door.mp3
factbox-site/audio/sea.mp3
factbox-site/audio/harbour-arrival.mp3
factbox-site/audio/triumph.mp3
factbox-site/audio/bath.mp3
factbox-site/audio/letter.mp3
factbox-site/audio/coil.mp3
factbox-site/audio/search.mp3
factbox-site/audio/copies.mp3
factbox-site/audio/basket.mp3
factbox-site/audio/vials.mp3
factbox-site/audio/gallery.mp3
factbox-site/audio/harbour.mp3
factbox-site/audio/scroll.mp3      # mapped, currently unused
factbox-site/audio/palace.mp3      # mapped, currently unused
```

Every one is optional. A missing bed means that beat is silent and the rest of
the story still sounds; only an *entirely* empty folder retires the control.

**The spec each file must meet**

| | |
|---|---|
| Format | **MP3.** Not OGG (Safari cannot decode Vorbis), not M4A (Firefox is unreliable). |
| Channels / rate | Mono, 32 kHz, 48 kbps. Stereo is wasted on a phone speaker and costs double. |
| Length | 15–30 s. Under 12 s the repeat becomes audible; over 40 s costs memory for nothing. |
| Size | Keep under ~200 KB. |
| Loudness | −22 to −26 LUFS integrated, true peak ≤ −3 dBFS. |
| Seam | Must loop seamlessly. Build it by crossfading the tail back over the head — see below. |
| Content | **Ambience only.** No sustained pure tones, no music, no intelligible speech, no event that repeats on the loop period (a bell, a footstep, a bird that always lands at 0:14). |

**Why no sustained pure tones:** MP3 decoding adds encoder delay at the head and
padding at the tail, and no browser strips it consistently, so `audio.js` loops
*inside* the file (50 ms in, 100 ms off the end) to step over both. That means
the wrap skips ~150 ms of material. In broadband ambience the jump is smaller
than the signal's own sample-to-sample variation and is inaudible. In a sustained
sine it is a click, every lap. Keep the beds noise-like and the problem does not
exist.

**Making a seamless loop** — take `L + X` seconds of material and crossfade the
trailing `X` back over the head with equal-power (quarter-sine) curves. The
result is exactly `L` seconds whose last sample is the one immediately before its
first in the original recording, so the wrap is continuous by construction rather
than by luck. `build-beds.py` (next to `compose.py`) does this; it is idempotent
and the noise sources are seeded, so re-running it reproduces all fifteen files
byte for byte — verified: after the seven new beds were appended to it, a full
re-run reproduced the original eight bit-for-bit identical to the shipped ones.
Re-fetch the nineteen source recordings from the file pages above into
`audio-src/` first.

Two tools were added to `build-beds.py` for the new beds and are documented in
it: `loop_src(..., sloop=n)` for sources shorter than `L + X` (tiled in **two**
stages — a raw file tiled by `-stream_loop` joins its own tail to its own head
and clicks, so the sub-loop is made seamless *first*), and
`asetrate=<32000·k>,aresample=32000` inside `pre`, which plays material k
slower and k lower. The second is what turns a school canteen into a crowd of
grown men.

**Two knobs, both in `audio.js`:**

* `LEVEL` (**0.26**) and `LEVEL_CALM` (**0.17**) — the master, on and under
  reduced motion. Turn these down first if the beds feel loud; they are the
  honest fix.
* `BEDS[key].gain` — one bed relative to the others. Use it when one bed sticks
  out, not to raise the whole mix.

### The master was halved, and why that is not just a smaller number

It was 0.50 / 0.32. The founder's note on the shipped build was *"the audio was
a little loud, make it a bit quieter so it's not the main focus"*, and the
target is that a reader is not aware of the sound until they think about it.
It is now **0.26 / 0.17**, a 5.7 dB cut.

Halving the master cannot disturb the balance between beds — every one of the
fifteen moves by the same 5.7 dB — so the mix that was mastered against itself
still is. What it *can* do is push the quietest bed off the bottom, and it did:

* **`search` was raised from 0.40 to 0.50.** It is the deliberate near-silence
  of the set, and 5.7 dB below a near-silence is a bed that reads as a failed
  download. At the new master it plays at an effective −44 LUFS: still the
  quietest bed by 3.4 dB, still 5–7 dB below the beats either side of it, and
  still above four of the shipped eight on the >500 Hz measure that predicts
  whether a phone will reproduce it at all. **This is the rule if the master is
  ever lowered again: move the bed that falls off the bottom, not the master.**
* **`harbour-arrival` was pulled back from 0.95 to 0.86**, so that `triumph`
  sits clearly on top of it rather than level with it. `triumph` is meant to be
  the loudest moment in the story, but the intent is *"the room got busier"*,
  not *"the volume went up"* — so the separation is deliberately small in level
  (1.4 dB) and large in content: `triumph` carries about **7 dB more energy
  above 500 Hz** than either neighbour, which is the band a phone speaker
  actually radiates. It should arrive as density, not as volume.

Everything else kept the gain it had.

`BASE` (`"audio/"`) is the folder, relative to `story.html`.

---

## Shopping list — the beds worth upgrading

Four of the fifteen are wholly synthesised noise and three more lean on
recordings that are the right texture but the wrong century. They are
inoffensive and they hold the room, but a real recording will always be better.
In priority order:

**1. `triumph.mp3` — the crowd. A genuinely licensable one.**
25–30 s. What is there is three modern indoor crowds pitched down and summed,
which measures beautifully (0.7 dB spread, no formant tracks) and is still a
shopping mall underneath. What it wants is an outdoor crowd at middle distance —
a procession, a large market, a stadium concourse — with no PA, no music, no
vehicles. Search *"crowd walla outdoor"*, *"large crowd distant"* on **Freesound
with the licence filter set to CC0** — and then, before using anything, open the
sound's own page and check the uploader recorded it. That is the check that
matters; the tag is not.

**2. `harbour-arrival.mp3` — rigging, and men on a quay.**
25–30 s. The water is genuine and good. What is missing is rope, block and spar:
search *"rigging creak"*, *"sailing ship deck"*, *"halyard"* on **Freesound
CC0**. Anything with a repeating creak is useless — it has to be irregular.

**3. `vials.mp3` — a real physician's table.**
20 s. Small glass handled slowly at a distance of about a metre, with a stone
mortar. Search *"mortar pestle grinding"*, *"glass vials handling"* on
**Freesound CC0**. Keep it *sparse and dense at once* — many small events, none
of them loud.

**4. `gallery.mp3` — a museum hall.**
20–25 s. Large-room tone, a distant footfall or two is fine as long as nothing
lands on the loop period. Search *"museum ambience"*, *"cathedral room tone"*,
*"large hall tone"* — **Freesound CC0** is much the best source for this one.

**5. `basket.mp3` — close, dry, small.**
20–25 s. Dry leaves or dry palm fronds moving slightly; low, close, no impacts.
Search *"dry leaves rustle ambience"*, *"palm leaves wind"* — **Freesound CC0**,
or **archive.org** (filter to `licenseurl:*publicdomain*`).

**6. `coil.mp3` — tension under the question.**
Optional as a bed, but see the phone-speaker note above: it is almost entirely
below 500 Hz and therefore nearly absent on a phone, which flattens the drop
into `search`. If you rebuild it, 20–30 s, a low drone with no melody and no
rhythm, nothing that resolves, **and some energy in the 1–2 kHz band**. The
**YouTube Audio Library** (filter: *no attribution required*) has usable dark
ambient beds; check the per-track licence line, as some do require credit.

`scroll.mp3` and `palace.mp3` stop being carried by any beat once the new
scenes are all in the deck, and are not worth spending on unless a beat moves
back onto them.

Whatever you pick, run it through the same measurements before shipping:
`build-beds.py` for the loop, then `check.py` for the seam, loudness and
stationarity, then `check-phone.py` for the effective level of every bed at the
current master and for how much of it survives a 500 Hz high-pass — which is
the number that tells you whether a phone will play it at all. All three are in
the scratchpad next to `compose.py`.

**A rule worth keeping:** if you cannot point at a licence tag on a page you can
link to, do not ship the file. This product's entire differentiator is citing
sources; a sound bed we cannot prove we may use is the one place it would be
embarrassing to be sloppy.
