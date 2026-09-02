#!/usr/bin/env python3
"""Build the sixteen ambient beds added for the 51-stack reader (read.html).

Part one, below, is the three that came with the beat-level map: vault, wind and
reactor. Part two, at the bottom of this file, is the thirteen the per-card map
needs -- court, battle, field, void, temple, crypt, hall, dig, fire, night,
storm, road and river. They are in one file so that the whole set regenerates
with one command; see AUDIO-CARDS.md for the brief behind each of the thirteen
and AUDIO-READER.md for what was measured.

PROVENANCE
==========
Nothing here is sourced. There is no `audio-src/`, no download, no recording,
no third-party file of any kind. Every sample in all sixteen files is generated
by ffmpeg's own `anoisesrc` generator and shaped by ffmpeg's own filters. The
only inputs are the seeds and filter constants in this file, so the output is
our own work and the licence is unambiguous.

Run it to regenerate:  ffmpeg -version >= 4.x, then `python3 build-reader-beds.py`
It is idempotent: the noise sources are seeded, so a re-run reproduces all
sixteen files byte for byte. Verified by running it three times over and
comparing md5s of every mp3 in the folder.

The 15 beds that were already in this folder are NOT touched by this script.
They are built by ../../build-beds.py from public-domain recordings; see
scenes/AUDIO.md for their provenance.

CONSTRUCTION
============
Same seamless-loop construction as build-beds.py: take L+X seconds of
material and crossfade the trailing X seconds back over the head with
equal-power (quarter-sine) curves. The result is exactly L seconds whose last
sample is the one immediately before its first, so the wrap is continuous by
construction rather than by luck.

Two rules every layer obeys, both from scenes/AUDIO.md:

  * No sustained pure tones. audio-reader.js loops *inside* the file (50 ms in,
    100 ms off the end) to step over MP3 encoder delay and padding, so the wrap
    skips ~150 ms of material. In broadband noise that jump is smaller than the
    signal's own sample-to-sample variation. In a sine it is a click per lap.
    Every "hum" here is therefore a narrow *noise* resonance, not an oscillator.
  * Real energy above 500 Hz. A phone speaker radiates almost nothing below
    that, and two of the shipped beds (door, coil) are near-inaudible on a
    phone for exactly this reason. Each of these three carries a deliberate
    upper layer so that it plays as something rather than as a failed download.

  * Every tremolo rate is >= 0.1 Hz (ffmpeg's minimum) and none of the periods
    divides the loop length, so no layer breathes in step with the wrap.
"""
import subprocess, pathlib, sys, shlex

HERE = pathlib.Path(__file__).parent           # factbox-site/audio
TMP  = HERE / "_reader-bed-tmp"; TMP.mkdir(exist_ok=True)
OUT  = HERE
SR   = 32000

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        print("FFMPEG FAIL:", " ".join(shlex.quote(a) for a in args))
        print(r.stderr[-1800:]); sys.exit(1)

def loop(desc, L, X, pre, out):
    """Synthesise `desc` (a lavfi source), shape it with `pre`, and fold the
    trailing X seconds back over the head to make an exactly-L-second loop."""
    fc = (f"[0:a]aformat=channel_layouts=mono:sample_rates={SR},{pre},asplit=2[p][q];"
          f"[p]atrim=0:{L},asetpts=N/SR/TB,afade=t=in:st=0:d={X}:curve=qsin[a];"
          f"[q]atrim={L}:{L+X},asetpts=N/SR/TB,afade=t=out:st=0:d={X}:curve=qsin,"
          f"apad=whole_dur={L}[b];"
          f"[a][b]amix=inputs=2:normalize=0,atrim=0:{L}[o]")
    run(["ffmpeg", "-hide_banner", "-v", "error", "-y",
         "-f", "lavfi", "-t", str(L + X + 1), "-i", desc,
         "-filter_complex", fc, "-map", "[o]", "-ar", str(SR), "-ac", "1", str(out)])

def mix(layers, out, lufs=-24):
    """layers: [(wav, gain_db)] -> one loudness-normalised mono 48 kbps MP3."""
    args = ["ffmpeg", "-hide_banner", "-v", "error", "-y"]
    for w, _ in layers: args += ["-i", str(w)]
    parts, names = [], []
    for i, (w, g) in enumerate(layers):
        parts.append(f"[{i}:a]volume={g}dB[v{i}]"); names.append(f"[v{i}]")
    parts.append("".join(names) +
                 f"amix=inputs={len(layers)}:normalize=0:duration=shortest,"
                 f"loudnorm=I={lufs}:TP=-3:LRA=11,"
                 f"aformat=sample_rates={SR}:channel_layouts=mono[o]")
    args += ["-filter_complex", ";".join(parts), "-map", "[o]",
             "-c:a", "libmp3lame", "-b:a", "48k", "-ar", str(SR), "-ac", "1",
             "-write_xing", "1", str(out)]
    run(args)

L, X = 22, 3

# ---------------------------------------------------------------------------
# 1. vault — a large, dark stone interior with a long tail.
#    Base bed for church_history and medieval_modern: a council chamber, a
#    cathedral, a trial hall, a cellar. gallery.mp3 is the *bright cool* big
#    room; this is the dark one, a fifth of an octave lower and with a tail
#    roughly twice as long. The two are meant to be told apart.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=8201", L, X,
     "highpass=f=85,lowpass=f=1400,lowpass=f=1400,"
     "aecho=0.8:0.88:470|930:0.34|0.24,tremolo=f=0.1:d=0.22", TMP/"vau_a.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.65:seed=8202", L, X,
     "bandpass=f=150:width_type=q:w=1.1,tremolo=f=0.11:d=0.3", TMP/"vau_b.wav")
# the layer that survives a phone speaker: stone air, well above 500 Hz
loop(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=8203", L, X,
     "highpass=f=1700,lowpass=f=5400,aecho=0.8:0.8:390|710:0.25|0.15,"
     "tremolo=f=0.13:d=0.4", TMP/"vau_c.wav")
mix([(TMP/"vau_a.wav", 0), (TMP/"vau_b.wav", -8), (TMP/"vau_c.wav", -13)],
    OUT/"vault.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 2. wind — open, dry, outdoors, no water.
#    Base bed for old_testament and for the outdoor New Testament stacks, and
#    for Genghis Khan's steppe. The low (<220 Hz) layer is deliberately held
#    11 dB down: at -6 the bed measured 4 dB hot at the loop wrap, because a
#    signal that low moves too far between one sample and the next 21.9 s away.
#    Nothing in the shipped fifteen is "outside and
#    dry": sea/harbour are water, palace is a courtyard fountain, everything
#    else is an interior. Two bands drifting at incommensurate rates (0.1 and
#    0.17 Hz) so it moves without ever settling into a pulse you can count.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.6:seed=8301", L, X,
     "highpass=f=170,lowpass=f=2200,tremolo=f=0.1:d=0.5", TMP/"wnd_a.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=8302", L, X,
     "bandpass=f=700:width_type=q:w=0.7,tremolo=f=0.17:d=0.55", TMP/"wnd_b.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=8303", L, X,
     "lowpass=f=220,lowpass=f=220,tremolo=f=0.13:d=0.35", TMP/"wnd_c.wav")
# dry grit high up — the difference between "wind" and "a low rumble"
loop(f"anoisesrc=c=pink:r={SR}:a=0.28:seed=8304", L, X,
     "highpass=f=2400,lowpass=f=7200,tremolo=f=0.19:d=0.5", TMP/"wnd_d.wav")
mix([(TMP/"wnd_a.wav", 0), (TMP/"wnd_b.wav", -6), (TMP/"wnd_c.wav", -11),
     (TMP/"wnd_d.wav", -13)], OUT/"wind.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 3. reactor — a machine room. Cold, continuous, mechanical.
#    Built for the one `disaster` stack (Chernobyl), where every one of the
#    fifteen shipped beds is the wrong century or the wrong planet. Two narrow
#    noise resonances at 55 and 118 Hz stand in for a plant hum without ever
#    being a tone, a mid resonance at 620 Hz gives it a room, and a thin
#    3-9 kHz layer gives it the ventilation hiss that a phone can actually
#    reproduce. Deliberately NO clicks: a Geiger tick on a 22 s loop is a
#    metronome, which is the one thing the loop spec exists to prevent.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=brown:r={SR}:a=0.9:seed=8401", L, X,
     "bandpass=f=55:width_type=q:w=2.4,bandpass=f=55:width_type=q:w=2.4,"
     "tremolo=f=0.1:d=0.3", TMP/"rea_a.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.9:seed=8402", L, X,
     "bandpass=f=118:width_type=q:w=3.0,bandpass=f=118:width_type=q:w=3.0",
     TMP/"rea_b.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.45:seed=8403", L, X,
     "bandpass=f=620:width_type=q:w=1.0,aecho=0.8:0.8:210|430:0.28|0.18,"
     "tremolo=f=0.11:d=0.25", TMP/"rea_c.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=8404", L, X,
     "highpass=f=3000,lowpass=f=9000,tremolo=f=0.17:d=0.35", TMP/"rea_d.wav")
mix([(TMP/"rea_a.wav", 0), (TMP/"rea_b.wav", -5), (TMP/"rea_c.wav", -9),
     (TMP/"rea_d.wav", -15)], OUT/"reactor.mp3", lufs=-24)

print("built:", ", ".join(str((OUT/f).name) for f in
      ("vault.mp3", "wind.mp3", "reactor.mp3")))


# ===========================================================================
# PART TWO — the thirteen per-card beds
#
# data/cardaudio.json assigns a bed to every one of the 450 cards in
# data/stacks.json, and names 31 beds: the 18 already in this folder and the 13
# built below. AUDIO-CARDS.md section 6 carries the brief for each one. Same
# house rules as part one, unchanged: 22 s loop, 3 s qsin fold, mono 32 kHz
# 48 kbps, no sustained tones, real energy above 500 Hz, every tremolo >= 0.1 Hz
# with no period that divides 22 s.
#
# Nothing here is sourced either. Every sample is anoisesrc shaped by ffmpeg's
# own filters; the seeds and constants below are the whole provenance.
#
# WHERE THIS DEPARTS FROM THE BRIEF, AND WHY
# ------------------------------------------
# Five of AUDIO-CARDS.md's constants do not survive contact with ffmpeg 9.0.1
# here. Each is recorded at the point it bites; in summary:
#
#   1. `aphaser=speed=0.08` (void, layer B) is a hard error, not a clamp:
#      ffmpeg's range for `speed` is [0.1, 2]. Raised to the minimum, 0.1.
#   2. The transient recipes' MODULATOR must be white noise, not pink. Pink is
#      1/f, so after `lowpass=f=2` it is dominated by sub-0.1 Hz drift and the
#      envelope crosses the gate one or two times in twelve seconds instead of
#      eighteen. On white the `lowpass=f=` cutoff really is the event rate,
#      which is what the brief says that knob does. The recipe as printed does
#      not name a colour for `[1:a]`, so this is a reading of it, not a change.
#   3. Both inputs of a transient layer are normalised to peak 1.0 before they
#      are multiplied. Left raw, recipe (b) produces a product whose peak is
#      0.017 against a gate threshold of 0.02 -- the gate never opens at all,
#      and the layer is silence. Normalising makes `agate=threshold=` an honest
#      fraction of full scale, which is the only reading under which the
#      brief's own tuning advice ("the modulator's volume= against
#      agate=threshold= sets sparseness") is actionable.
#   4. Gate thresholds are therefore re-derived on that scale by sweep, not
#      copied. Recipe (a) layers all sit at 0.30; recipe (b) thresholds are
#      per-layer. Everything else the brief specifies for each gate -- ratio,
#      attack, release -- is verbatim, because that is what shapes the
#      character of a hit rather than how many of them there are.
#   5. Recipe (b) layers add `range=0.002`. ffmpeg's agate floors its gain
#      reduction at `range`, default 0.06125 = -24 dB, so "74% near-silence"
#      is unreachable with the default: the gaps between drips sit 24 dB down
#      rather than gone. At -54 dB they are gone.
#
#   Measured after those five, per layer, over 12 s in 10 ms frames:
#     recipe (a) layers   38-54% of frames above a quarter of peak,  6-17% near-silent
#     recipe (b) layers   16-23 discrete events per 12 s,          79-88% near-silent
#   against the brief's "35% / 11%" and "18 events in 12 s / 74%".
#
# TWO MIX TARGETS ARE CLAMPED. The brief asks -23 LUFS for `fire` and -26 for
# `night`; the shipped envelope this set has to sit inside is -24 to -25. Both
# are pulled to the edge of it (-24 and -25) and the intent is carried instead
# by the per-bed `gain` already written into data/cardaudio.json, which is what
# that field is for: fire is the loudest new bed at 0.88, night the quietest at
# 0.78. A bed that is 2 dB hot in the file is 2 dB hot in every mix; a bed that
# is 2 dB hot in its gain is 2 dB hot only where it plays.
# ===========================================================================
import tempfile, shutil, atexit, array, math

# Part one leaves its intermediates in audio/_reader-bed-tmp and they are in
# git. Thirteen beds at four layers is fifty more WAVs, ~70 MB, and the repo is
# already ~120 MB, so these go to a system temp that is deleted on the way out.
TMP2 = pathlib.Path(tempfile.mkdtemp(prefix="factbox-card-beds-"))
atexit.register(shutil.rmtree, str(TMP2), True)

def src_peak(desc, pre, secs):
    """Peak of a lavfi source after `pre`. Used to normalise the two inputs of
    a transient layer to full scale before they are multiplied, so that the
    agate thresholds below are fractions of full scale rather than fractions of
    whatever amplitude anoisesrc happened to hand us."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y",
                        "-f", "lavfi", "-t", str(secs), "-i", desc,
                        "-af", f"aformat=channel_layouts=mono:sample_rates={SR},{pre}",
                        "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                       capture_output=True)
    a = array.array("f"); a.frombytes(r.stdout)
    return max(max(a), -min(a)) if len(a) else 1.0

# The engine does not loop the whole file: audio-reader.js sets loopStart to
# HEAD_TRIM (50 ms) and loopEnd to duration - TAIL_TRIM (100 ms) to step over
# MP3 encoder delay and padding, and no two decoders agree on that offset to
# better than a few tens of ms. So the wrap the reader hears is NOT the point
# the fold made continuous -- it joins ~21.90 s to ~0.05 s. For continuous
# noise that is inaudible, which is why the shipped beds get away with it. For
# a sparse EVENT layer it is not: cut a drip in half there and it clicks once a
# lap forever. (Measured: crypt's first build was +3.6 dB above its own control
# in the 2 kHz-and-up seam test, and it was the only bed in the set that
# failed.) So every recipe (b) layer is windowed to silence across the whole
# swept trim region -- 0 to 100 ms and 21.78 s on -- which is 1.5% of a layer
# that is near-silent 80% of the time anyway, and makes the wrap silence-to-
# silence for the one layer that could ever click at it.
EDGE = (f"afade=t=in:st=0.10:d=0.12:curve=qsin,"
        f"afade=t=out:st={L - 0.34}:d=0.12:curve=qsin")

def loopx(src, spre, mod, mpre, mvol, gate, L, X, out, edge=False):
    """The transient variant of loop(): a bright noise multiplied by a slow
    noise envelope and gated -- recipes (a) and (b) of AUDIO-CARDS.md section 6
    -- folded into a seamless L-second loop by exactly the construction loop()
    uses. amultiply needs both inputs at the same length and rate, so both are
    generated at L+X+1 seconds like loop() does. `edge` applies EDGE above."""
    secs = L + X + 1
    sp, mp = src_peak(src, spre, secs), src_peak(mod, mpre, secs)
    fc = (f"[0:a]aformat=channel_layouts=mono:sample_rates={SR},{spre},"
          f"volume={1.0 / sp:.6f}[hi];"
          f"[1:a]aformat=channel_layouts=mono:sample_rates={SR},{mpre},"
          f"volume={1.0 / mp:.6f},volume={mvol}[mo];"
          f"[hi][mo]amultiply,{gate},asplit=2[p][q];"
          f"[p]atrim=0:{L},asetpts=N/SR/TB,afade=t=in:st=0:d={X}:curve=qsin[a];"
          f"[q]atrim={L}:{L+X},asetpts=N/SR/TB,afade=t=out:st=0:d={X}:curve=qsin,"
          f"apad=whole_dur={L}[b];"
          f"[a][b]amix=inputs=2:normalize=0,atrim=0:{L}"
          + (f",{EDGE}" if edge else "") + f"[o]")
    run(["ffmpeg", "-hide_banner", "-v", "error", "-y",
         "-f", "lavfi", "-t", str(secs), "-i", src,
         "-f", "lavfi", "-t", str(secs), "-i", mod,
         "-filter_complex", fc, "-map", "[o]", "-ar", str(SR), "-ac", "1", str(out)])

# Part one's layers are all continuous noise built the same way, so their raw
# levels were close enough that the dB in mix() meant what it said. These are
# not: a gated drip and a broadband roar off the same generator are 20 dB
# apart before anyone has decided anything. So every layer is first trimmed to
# a common reference and the brief's dB is applied on top, which restores the
# only reading that makes those numbers comparable -- "this layer sits N dB
# under the bed's A layer". Continuous layers are referenced by RMS; the sparse
# event layers by peak, because what you hear of a drip is its peak and its RMS
# is mostly the silence between drips.
REF_RMS  = -20.0
REF_PEAK = -6.0

def lay(w, db, mode="rms"):
    """-> the (wav, gain_dB) pair mix() wants, reference-trimmed."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-i", str(w),
                        "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                       capture_output=True)
    a = array.array("f"); a.frombytes(r.stdout)
    pk = max(max(a), -min(a)) or 1e-9
    s = 0.0
    for v in a: s += v * v
    rms = math.sqrt(s / len(a)) or 1e-9
    ref = (REF_PEAK - 20 * math.log10(pk)) if mode == "peak" \
          else (REF_RMS - 20 * math.log10(rms))
    return (w, round(db + ref, 2))

# Recipe (a) -- dense irregular texture. One threshold for all of them; the
# ratio/attack/release that follow are per-layer and come from the brief.
GA = "agate=threshold=0.30:ratio={r}:attack={a}:release={d}"
# Recipe (b) -- sparse point events. Threshold is the per-layer sparseness knob.
GB = "agate=threshold={t}:ratio=20:range=0.002:attack=0.5:release=25"
# The resonant body every recipe (b) source is given before it is gated.
BODY = "aecho=0.8:0.7:60|110:0.3|0.18"

# ---------------------------------------------------------------------------
# 4. court — an indoor throne room. 35 cards, the most-used new bed.
#    Sits between vault and palace: brighter and smaller than vault, indoors
#    where palace is a courtyard. Layer B is the murmur of a room of people and
#    is the riskiest thing in the whole spec — a voice cannot be honestly
#    synthesised from noise, so it is aimed deliberately BELOW intelligibility.
#    The long attack (30 ms) and very long release (400 ms) are what keep it
#    from sounding like speech: they smear every gate opening across a third of
#    a second, so nothing in it can be as short as a syllable. Verified by
#    measuring the envelope modulation spectrum — see the report in
#    AUDIO-READER.md; the 2-8 Hz syllable band is where speech lives.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=8501", L, X,
     "highpass=f=110,lowpass=f=2600,aecho=0.8:0.85:230|370:0.28|0.18,"
     "tremolo=f=0.11:d=0.2", TMP2/"crt_a.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=8502",
      "bandpass=f=380:width_type=q:w=1.4",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=8503", "lowpass=f=3", 4,
      GA.format(r=6, a=30, d=400), L, X, TMP2/"crt_b.wav")
# marble air, the layer a phone speaker can actually radiate
loop(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=8504", L, X,
     "highpass=f=2000,lowpass=f=6500,aecho=0.8:0.75:190|310:0.22|0.12,"
     "tremolo=f=0.13:d=0.35", TMP2/"crt_c.wav")
mix([lay(TMP2/"crt_a.wav", 0), lay(TMP2/"crt_b.wav", -10),
     lay(TMP2/"crt_c.wav", -13)], OUT/"court.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 5. battle — an army at middle distance. Mass and metal, no voices.
#    Middle distance is the point: this plays under cards about wars, not under
#    a duel. The ground layer is held 11 dB down for the reason wind's was —
#    anything below ~220 Hz measures hot at the wrap. Layer C is deliberately
#    irregular; a rhythm up there reads as marching and pins the century.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=8601", L, X,
     "lowpass=f=180,tremolo=f=0.1:d=0.45", TMP2/"bat_a.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.6:seed=8602", L, X,
     "highpass=f=200,lowpass=f=1800,aecho=0.8:0.6:700|1300:0.2|0.12,"
     "tremolo=f=0.13:d=0.5", TMP2/"bat_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=8603",
      "bandpass=f=3200:width_type=q:w=2.5,aecho=0.8:0.6:80|150:0.25|0.15",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=8604", "lowpass=f=5", 5,
      GA.format(r=10, a=1, d=60), L, X, TMP2/"bat_c.wav")
mix([lay(TMP2/"bat_a.wav", -11), lay(TMP2/"bat_b.wav", 0),
     lay(TMP2/"bat_c.wav", -14)], OUT/"battle.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 6. field — open warm countryside. Galilee, Lincoln's Kentucky, Eden.
#    Must be clearly distinct from wind: wind is dry and empty, this is alive.
#    Two passes of the same narrow band at 4.6 kHz give the steady shimmer of a
#    warm afternoon without ever being a tone. The bird is at -20 dB, i.e.
#    barely there, and band-limited, so it reads only in its own band.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=8701", L, X,
     "highpass=f=200,lowpass=f=1600,tremolo=f=0.1:d=0.3", TMP2/"fld_a.wav")
loop(f"anoisesrc=c=white:r={SR}:a=0.45:seed=8702", L, X,
     "bandpass=f=4600:width_type=q:w=1.8,bandpass=f=4600:width_type=q:w=1.8,"
     "tremolo=f=0.19:d=0.25", TMP2/"fld_b.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.4:seed=8703", L, X,
     "highpass=f=900,lowpass=f=3000,tremolo=f=0.14:d=0.55", TMP2/"fld_c.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=8704",
      "bandpass=f=2800:width_type=q:w=4," + BODY,
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=8705", "lowpass=f=1.5", 2,
      GB.format(t=0.40), L, X, TMP2/"fld_d.wav", edge=True)
mix([lay(TMP2/"fld_a.wav", 0), lay(TMP2/"fld_b.wav", -12),
     lay(TMP2/"fld_c.wav", -10), lay(TMP2/"fld_d.wav", -20, "peak")],
    OUT/"field.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 7. void — vast and airless. Heaven, the sky, the cosmos, Ezekiel's wheels.
#    The one bed with no room in it at all: no aecho anywhere, because there
#    are no surfaces. Layer A is a very narrow NOISE resonance at 55 Hz, not a
#    sine, and is nearly inaudible on a phone by design — it is felt on
#    headphones. Layer B is what survives a phone speaker and the reason void
#    is not just a dark drone; the slow phaser is something enormous turning.
#    The brief asks aphaser=speed=0.08, which ffmpeg rejects outright (range is
#    0.1 to 2), so it runs at the minimum: 10 s per sweep, and 22/10 is not an
#    integer, so it never breathes in step with the wrap.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=8801", L, X,
     "bandpass=f=55:width_type=q:w=0.5,tremolo=f=0.1:d=0.15", TMP2/"vod_a.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.35:seed=8802", L, X,
     "highpass=f=3500,lowpass=f=9000,tremolo=f=0.12:d=0.6,"
     "aphaser=speed=0.1:decay=0.3", TMP2/"vod_b.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=8803", L, X,
     "bandpass=f=700:width_type=q:w=0.6,tremolo=f=0.17:d=0.4", TMP2/"vod_c.wav")
mix([lay(TMP2/"vod_a.wav", -12), lay(TMP2/"vod_b.wav", 0),
     lay(TMP2/"vod_c.wav", -15)], OUT/"void.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 8. temple — an enormous sacred stone interior. The Holy of Holies.
#    Bigger than vault and warmer: three echo taps out to 2.3 s where vault
#    stops at 930 ms, a held low resonance at 115 Hz narrow enough to read as a
#    pitch but noisy enough not to click at the wrap, and a brazier you cannot
#    see. Layer D is the phone layer.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=8901", L, X,
     "highpass=f=90,lowpass=f=1200,aecho=0.8:0.9:800|1500|2300:0.4|0.28|0.18,"
     "tremolo=f=0.1:d=0.2", TMP2/"tmp_a.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.6:seed=8902", L, X,
     "bandpass=f=115:width_type=q:w=0.8,tremolo=f=0.11:d=0.25", TMP2/"tmp_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=8903",
      "highpass=f=2200,lowpass=f=7000",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=8904", "lowpass=f=4", 4,
      GA.format(r=8, a=2, d=120), L, X, TMP2/"tmp_c.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=8905", L, X,
     "highpass=f=1800,lowpass=f=5200,aecho=0.8:0.8:600|1100:0.3|0.18,"
     "tremolo=f=0.13:d=0.35", TMP2/"tmp_d.wav")
mix([lay(TMP2/"tmp_a.wav", 0), lay(TMP2/"tmp_b.wav", -10),
     lay(TMP2/"tmp_c.wav", -16), lay(TMP2/"tmp_d.wav", -12)],
    OUT/"temple.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 9. crypt — small, dead, underground. A tomb, a cave at Qumran, a cell.
#    The inverse of vault: a tiny hard box with almost no tail (35/60 ms taps,
#    against vault's 470/930) and almost no movement, because a crypt does not
#    breathe. The drip is the signature and the layer a phone reproduces; its
#    echo taps are lengthened from the recipe's 60/110 to 70/130 for the ring
#    of stone rather than of tile.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9001", L, X,
     "highpass=f=120,lowpass=f=1100,aecho=0.8:0.35:35|60:0.25|0.15,"
     "tremolo=f=0.1:d=0.12", TMP2/"cry_a.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.6:seed=9002", L, X,
     "bandpass=f=90:width_type=q:w=0.7,tremolo=f=0.11:d=0.2", TMP2/"cry_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9003",
      "bandpass=f=2400:width_type=q:w=3,aecho=0.8:0.7:70|130:0.3|0.18",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9004", "lowpass=f=2", 3,
      GB.format(t=0.80), L, X, TMP2/"cry_c.wav", edge=True)
mix([lay(TMP2/"cry_a.wav", 0), lay(TMP2/"cry_b.wav", -13),
     lay(TMP2/"cry_c.wav", -8, "peak")], OUT/"crypt.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 10. hall — a 19th-century wooden interior with people in it.
#     Ford's Theatre, an Illinois courthouse, a meeting house. Wood, not stone,
#     is the whole distinction from vault and court: short bright taps for a
#     boxy room with a low ceiling, and a timber resonance at 170 Hz. Layer C
#     is court's murmur made quieter, drier and higher — a room where people
#     are waiting, not talking. Layer D is one board settling.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=9101", L, X,
     "highpass=f=130,lowpass=f=3200,aecho=0.8:0.55:110|175:0.3|0.2,"
     "tremolo=f=0.11:d=0.2", TMP2/"hal_a.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.55:seed=9102", L, X,
     "bandpass=f=170:width_type=q:w=1.2,tremolo=f=0.13:d=0.3", TMP2/"hal_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9103",
      "bandpass=f=520:width_type=q:w=1.6",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9104", "lowpass=f=3", 4,
      GA.format(r=6, a=25, d=300), L, X, TMP2/"hal_c.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9105",
      "bandpass=f=900:width_type=q:w=5," + BODY,
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9106", "lowpass=f=0.8", 2,
      GB.format(t=0.30), L, X, TMP2/"hal_d.wav", edge=True)
mix([lay(TMP2/"hal_a.wav", 0), lay(TMP2/"hal_b.wav", -9),
     lay(TMP2/"hal_c.wav", -14), lay(TMP2/"hal_d.wav", -18, "peak")],
    OUT/"hall.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 11. dig — an excavation outdoors. Taposiris Magna, Burkhan Khaldun.
#     wind with work happening in it, and a shallower, more granular air:
#     layer A is deliberately weaker than wind's, because this site is
#     sheltered by the trench. A trowel every few seconds, not every second.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.45:seed=9201", L, X,
     "highpass=f=250,lowpass=f=1900,tremolo=f=0.1:d=0.4", TMP2/"dig_a.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9202",
      "highpass=f=2500,lowpass=f=9000",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9203", "lowpass=f=4", 5,
      GA.format(r=8, a=2, d=90), L, X, TMP2/"dig_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9204",
      "bandpass=f=1400:width_type=q:w=4," + BODY,
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9205", "lowpass=f=1.2", 2.5,
      GB.format(t=0.50), L, X, TMP2/"dig_c.wav", edge=True)
loop(f"anoisesrc=c=brown:r={SR}:a=0.5:seed=9206", L, X,
     "lowpass=f=160,tremolo=f=0.13:d=0.3", TMP2/"dig_d.wav")
mix([lay(TMP2/"dig_a.wav", 0), lay(TMP2/"dig_b.wav", -8),
     lay(TMP2/"dig_c.wav", -13, "peak"), lay(TMP2/"dig_d.wav", -14)],
    OUT/"dig.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 12. fire — a large fire close by. Rome in 64 CE, Rouen in 1431, Reactor 4.
#     Layer B is the whole thing: a broad roar without crackle is wind. It runs
#     only 4 dB under the roar and all of it is above 1.8 kHz, which is both
#     where a crackle lives and what a phone can radiate. The brief asks -23
#     LUFS; clamped to -24 to stay inside the shipped envelope, with the extra
#     carried by fire's 0.88 gain in data/cardaudio.json, the highest of the 13.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.65:seed=9301", L, X,
     "highpass=f=150,lowpass=f=4000,tremolo=f=0.1:d=0.35", TMP2/"fir_a.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9302",
      "highpass=f=1800,lowpass=f=9000",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9303", "lowpass=f=8", 8,
      GA.format(r=9, a=1, d=50), L, X, TMP2/"fir_b.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.6:seed=9304", L, X,
     "lowpass=f=200,tremolo=f=0.17:d=0.5", TMP2/"fir_c.wav")
mix([lay(TMP2/"fir_a.wav", 0), lay(TMP2/"fir_b.wav", -4),
     lay(TMP2/"fir_c.wav", -12)], OUT/"fire.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 13. night — outdoors after dark. Gethsemane, the courtyard of the denials.
#     field cooled down: the insects narrow and rise to 5.2 kHz, the air loses
#     its mid, and the whole thing drops. The 0.23 Hz tremolo on the crickets
#     gives the pulse without ever landing on a beat you could count, and 22 s
#     is not a multiple of its 4.35 s period. The far dog is one event every
#     few seconds with 300/520 ms taps, which is what puts it a field away.
#     The brief asks -26 LUFS; clamped to -25, with night's 0.78 gain — the
#     lowest of the 13, tied with crypt — carrying the rest.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.4:seed=9401", L, X,
     "highpass=f=180,lowpass=f=1200,tremolo=f=0.1:d=0.25", TMP2/"nit_a.wav")
loop(f"anoisesrc=c=white:r={SR}:a=0.5:seed=9402", L, X,
     "bandpass=f=5200:width_type=q:w=3.5,bandpass=f=5200:width_type=q:w=3.5,"
     "tremolo=f=0.23:d=0.4", TMP2/"nit_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9403",
      "bandpass=f=700:width_type=q:w=6,aecho=0.8:0.5:300|520:0.3|0.2",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9404", "lowpass=f=0.6", 1.8,
      GB.format(t=0.30), L, X, TMP2/"nit_c.wav", edge=True)
loop(f"anoisesrc=c=brown:r={SR}:a=0.45:seed=9405", L, X,
     "lowpass=f=140,tremolo=f=0.11:d=0.2", TMP2/"nit_d.wav")
mix([lay(TMP2/"nit_a.wav", 0), lay(TMP2/"nit_b.wav", -9),
     lay(TMP2/"nit_c.wav", -19, "peak"), lay(TMP2/"nit_d.wav", -15)],
    OUT/"night.mp3", lufs=-25)

# ---------------------------------------------------------------------------
# 14. storm — rain on hard ground, distant thunder.
#     Effectively the crucifixion bed as well as the Watchers' flood: "darkness
#     covered the land for roughly three hours". Layer B is the spatter that
#     separates rain from hiss. There are deliberately NO discrete thunderclaps
#     — a clap on a 22 s loop is a metronome, which is the one thing the loop
#     spec exists to prevent — so the thunder is a slow 0.11 Hz roll instead.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=white:r={SR}:a=0.6:seed=9501", L, X,
     "highpass=f=700,lowpass=f=11000,tremolo=f=0.1:d=0.2", TMP2/"sto_a.wav")
loopx(f"anoisesrc=c=white:r={SR}:a=0.5:seed=9502",
      "highpass=f=3000,lowpass=f=13000",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9503", "lowpass=f=12", 10,
      GA.format(r=6, a=0.5, d=30), L, X, TMP2/"sto_b.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=9504", L, X,
     "lowpass=f=220,aecho=0.8:0.7:900|1700:0.35|0.22,tremolo=f=0.11:d=0.6",
     TMP2/"sto_c.wav")
mix([lay(TMP2/"sto_a.wav", 0), lay(TMP2/"sto_b.wav", -7),
     lay(TMP2/"sto_c.wav", -12)], OUT/"storm.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 15. road — travel on foot outdoors. Paul's journeys, Booth's manhunt.
#     Explicitly NOT footsteps in a rhythm: a regular tread on a loop is the
#     single most obvious repeat in the set. The grit layer is gated on noise,
#     so no two "steps" are the same distance apart. Close to wind but with
#     less high-band drift — a road is lower and more enclosed than a steppe.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9601", L, X,
     "highpass=f=220,lowpass=f=2000,tremolo=f=0.1:d=0.45", TMP2/"rod_a.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9602",
      "highpass=f=1600,lowpass=f=7500",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9603", "lowpass=f=7", 6,
      GA.format(r=8, a=1, d=55), L, X, TMP2/"rod_b.wav")
loop(f"anoisesrc=c=white:r={SR}:a=0.35:seed=9604", L, X,
     "bandpass=f=4200:width_type=q:w=1.5,tremolo=f=0.19:d=0.3", TMP2/"rod_c.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.5:seed=9605", L, X,
     "lowpass=f=170,tremolo=f=0.13:d=0.35", TMP2/"rod_d.wav")
mix([lay(TMP2/"rod_a.wav", 0), lay(TMP2/"rod_b.wav", -9),
     lay(TMP2/"rod_c.wav", -14), lay(TMP2/"rod_d.wav", -13)],
    OUT/"road.mp3", lufs=-24)

# ---------------------------------------------------------------------------
# 16. river — moving fresh water, reeds on the bank. Eden, the Malaya Nevka.
#     Must not sound like sea: no swell, no cycle, no gulls. A river is
#     continuous where the sea breathes, so layer A's tremolo depth is 0.12 —
#     almost no amplitude cycle at all. The eddies get 25/45 ms taps, a small
#     water event, against crypt's 70/130 for a drip in a stone room.
# ---------------------------------------------------------------------------
loop(f"anoisesrc=c=white:r={SR}:a=0.6:seed=9701", L, X,
     "highpass=f=500,lowpass=f=8000,tremolo=f=0.1:d=0.12", TMP2/"riv_a.wav")
loop(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=9702", L, X,
     "bandpass=f=900:width_type=q:w=0.8,tremolo=f=0.13:d=0.25", TMP2/"riv_b.wav")
loopx(f"anoisesrc=c=pink:r={SR}:a=0.5:seed=9703",
      "bandpass=f=1800:width_type=q:w=5,aecho=0.8:0.5:25|45:0.2|0.12",
      f"anoisesrc=c=white:r={SR}:a=0.5:seed=9704", "lowpass=f=3", 3,
      GB.format(t=0.80), L, X, TMP2/"riv_c.wav", edge=True)
loop(f"anoisesrc=c=pink:r={SR}:a=0.35:seed=9705", L, X,
     "highpass=f=2600,lowpass=f=6000,tremolo=f=0.17:d=0.5", TMP2/"riv_d.wav")
loop(f"anoisesrc=c=brown:r={SR}:a=0.5:seed=9706", L, X,
     "lowpass=f=150,tremolo=f=0.11:d=0.2", TMP2/"riv_e.wav")
mix([lay(TMP2/"riv_a.wav", 0), lay(TMP2/"riv_b.wav", -7),
     lay(TMP2/"riv_c.wav", -12, "peak"), lay(TMP2/"riv_d.wav", -15),
     lay(TMP2/"riv_e.wav", -14)], OUT/"river.mp3", lufs=-24)

CARD_BEDS = ("court", "battle", "field", "void", "temple", "crypt", "hall",
             "dig", "fire", "night", "storm", "road", "river")
print("built:", ", ".join(b + ".mp3" for b in CARD_BEDS))
