#!/usr/bin/env python3
"""Build the eight ambient beds.

Every bed is a seamless loop made the same way: take L+X seconds of material,
crossfade the trailing X seconds back over the head with equal-power (quarter
sine) curves. The result is exactly L seconds whose last sample is the one
immediately before its first sample in the original recording, so the wrap is
continuous by construction rather than by luck.
"""
import subprocess, pathlib, sys, shlex

HERE = pathlib.Path(__file__).parent
SRC  = HERE/"audio-src"
TMP  = HERE/"bed-tmp"; TMP.mkdir(exist_ok=True)
OUT  = HERE.parent/"audio"; OUT.mkdir(parents=True, exist_ok=True)
SR   = 32000

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        print("FFMPEG FAIL:", " ".join(shlex.quote(a) for a in args)); print(r.stderr[-1800:]); sys.exit(1)

def loop_from_file(src, start, L, X, pre, out):
    fc = (f"[0:a]atrim={start}:{start+L+X},asetpts=N/SR/TB,"
          f"aformat=channel_layouts=mono:sample_rates={SR},{pre},asplit=2[p][q];"
          f"[p]atrim=0:{L},asetpts=N/SR/TB,afade=t=in:st=0:d={X}:curve=qsin[a];"
          f"[q]atrim={L}:{L+X},asetpts=N/SR/TB,afade=t=out:st=0:d={X}:curve=qsin,"
          f"apad=whole_dur={L}[b];"
          f"[a][b]amix=inputs=2:normalize=0,atrim=0:{L}[o]")
    run(["ffmpeg","-hide_banner","-v","error","-y","-i",str(src),
         "-filter_complex",fc,"-map","[o]","-ar",str(SR),"-ac","1",str(out)])

def loop_from_lavfi(desc, L, X, pre, out):
    fc = (f"[0:a]aformat=channel_layouts=mono:sample_rates={SR},{pre},asplit=2[p][q];"
          f"[p]atrim=0:{L},asetpts=N/SR/TB,afade=t=in:st=0:d={X}:curve=qsin[a];"
          f"[q]atrim={L}:{L+X},asetpts=N/SR/TB,afade=t=out:st=0:d={X}:curve=qsin,"
          f"apad=whole_dur={L}[b];"
          f"[a][b]amix=inputs=2:normalize=0,atrim=0:{L}[o]")
    run(["ffmpeg","-hide_banner","-v","error","-y","-f","lavfi","-t",str(L+X+1),"-i",desc,
         "-filter_complex",fc,"-map","[o]","-ar",str(SR),"-ac","1",str(out)])

def mix(layers, out, lufs=-22):
    """layers: [(wav, gain_db)] -> one loudness-normalised mono mp3."""
    args=["ffmpeg","-hide_banner","-v","error","-y"]
    for w,_ in layers: args += ["-i", str(w)]
    parts=[]; names=[]
    for i,(w,g) in enumerate(layers):
        parts.append(f"[{i}:a]volume={g}dB[v{i}]"); names.append(f"[v{i}]")
    parts.append("".join(names)+f"amix=inputs={len(layers)}:normalize=0:duration=shortest,"
                 f"loudnorm=I={lufs}:TP=-3:LRA=11,aformat=sample_rates={SR}:channel_layouts=mono[o]")
    args += ["-filter_complex",";".join(parts),"-map","[o]",
             "-c:a","libmp3lame","-b:a","48k","-ar",str(SR),"-ac","1",
             "-write_xing","1", str(out)]
    run(args)

O = SRC/"Ocean_Waves_on_a_Tropical_Beach.ogg"
G = SRC/"Gulls_above_the_street_at_dawn.ogg"
F = SRC/"La_fontaine_de_la_place.ogg"
C = SRC/"Cicadas_in_Greece.ogg"
R = SRC/"Uneasy_rustling_ambience.ogg"
K = SRC/"Koulu-ambience1.wav"

# ---- 1. door — beat 1. A shut door in near-dark. A room with a sea somewhere
#         outside it: the ocean bed with everything above 190 Hz taken off is a
#         slow, breathing hush that reads as "still night room", not as "sea".
loop_from_file(O, 60, 24, 3, "highpass=f=35,lowpass=f=190,lowpass=f=190", TMP/"door_a.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.6:seed=7101", 24, 3,
                "lowpass=f=130,lowpass=f=130,tremolo=f=0.11:d=0.35", TMP/"door_b.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.2:seed=7110", 24, 3,
                "highpass=f=1200,lowpass=f=6000,tremolo=f=0.15:d=0.5", TMP/"door_c.wav")
mix([(TMP/"door_a.wav", 0), (TMP/"door_b.wav", -9), (TMP/"door_c.wav", -22)],
    OUT/"door.mp3", lufs=-25)

# ---- 2. sea — beats 2 and 3. Actium, and the year Octavian takes to follow.
loop_from_file(O, 25, 27, 3, "highpass=f=45", TMP/"sea.wav")
mix([(TMP/"sea.wav", 0)], OUT/"sea.mp3")

# ---- 3. scroll — beats 4 and 9. A still interior. Synthesised: see AUDIO.md.
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=7102", 20, 3,
                "highpass=f=70,lowpass=f=900,lowpass=f=900,tremolo=f=0.13:d=0.3",
                TMP/"scroll_a.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.25:seed=7103", 20, 3,
                "highpass=f=1600,lowpass=f=7000,tremolo=f=0.17:d=0.45", TMP/"scroll_b.wav")
mix([(TMP/"scroll_a.wav", 0), (TMP/"scroll_b.wav", -13)], OUT/"scroll.mp3", lufs=-25)

# ---- 4. palace — beats 5 and 6. Her last afternoon: a fountain in the court,
#         cicadas beyond it. Alexandria, August.
loop_from_file(F, 56, 20, 3, "highpass=f=60", TMP/"pal_a.wav")
loop_from_file(C,  3, 20, 3, "highpass=f=300,lowpass=f=6500", TMP/"pal_b.wav")
mix([(TMP/"pal_a.wav", 0), (TMP/"pal_b.wav", -16)], OUT/"palace.mp3", lufs=-23)

# ---- 5. coil — beats 7 and 8. The question, and the verdict. Synthesised:
#         two narrow noise resonances a fifth apart, which is a drone with no
#         steady phase to click at the loop point.
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.9:seed=7107", 24, 3,
                "bandpass=f=88:width_type=q:w=1.6,bandpass=f=88:width_type=q:w=1.6,"
                "tremolo=f=0.1:d=0.5", TMP/"coil_a.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.9:seed=7109", 24, 3,
                "bandpass=f=132:width_type=q:w=2.2,bandpass=f=132:width_type=q:w=2.2",
                TMP/"coil_b.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.3:seed=7108", 24, 3,
                "highpass=f=2500,lowpass=f=9000,tremolo=f=0.12:d=0.6", TMP/"coil_c.wav")
mix([(TMP/"coil_a.wav",0),(TMP/"coil_b.wav",-7),(TMP/"coil_c.wav",-20)],
    OUT/"coil.mp3", lufs=-24)

# ---- 6. basket — beats 10 and 11. Close, dry, small. A quiet granular rustle
#         over a dark floor.
loop_from_file(R, 20, 22, 3, "highpass=f=200,lowpass=f=9000", TMP/"bas_a.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.8:seed=7104", 22, 3,
                "lowpass=f=250,lowpass=f=250,tremolo=f=0.1:d=0.4", TMP/"bas_b.wav")
mix([(TMP/"bas_a.wav", -9), (TMP/"bas_b.wav", 0)], OUT/"basket.mp3", lufs=-25)

# ---- 7. gallery — beat 12. Four hundred years of painters. A big cool room
#         with a long tail. Synthesised: the one real corridor tone that was
#         available (Koulu-ambience1.wav, CC0) has footfalls in it every few
#         seconds, and a footfall on an eight-second loop is a metronome.
#         See AUDIO.md — a real gallery room tone is the upgrade here.
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.55:seed=7105", 22, 3,
                "highpass=f=110,lowpass=f=3200,lowpass=f=3200,"
                "aecho=0.8:0.85:290|610:0.3|0.2,tremolo=f=0.1:d=0.25", TMP/"gal_a.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.6:seed=7106", 22, 3,
                "bandpass=f=200:width_type=q:w=1.2,tremolo=f=0.12:d=0.3", TMP/"gal_b.wav")
mix([(TMP/"gal_a.wav", 0), (TMP/"gal_b.wav", -8)], OUT/"gallery.mp3", lufs=-26)

# ---- 8. harbour — beat 13. Alexandria at dusk: the sea, and gulls over it.
loop_from_file(O, 200, 28, 3, "highpass=f=45,lowpass=f=11000", TMP/"har_a.wav")
loop_from_file(G,  25, 28, 3, "highpass=f=420", TMP/"har_b.wav")
mix([(TMP/"har_a.wav", 0), (TMP/"har_b.wav", -11)], OUT/"harbour.mp3", lufs=-22)

# =============================================================================
#  The seven beds added for the new scenes (harbour arrival, triumph, bath,
#  letter, search, copies, vials).  Everything below uses the same construction
#  as the eight above: L+X seconds of material, trailing X crossfaded back over
#  the head with quarter-sine curves, so the wrap is continuous by construction.
#
#  Two extra tools were needed and are added rather than changing anything
#  above:
#
#   * `loop_src(..., sloop=n)` — `-stream_loop` on the input, for source
#     recordings shorter than L+X.  Tiling a raw file joins its tail to its head
#     and clicks, so a short source is looped in TWO stages: first make a
#     seamless sub-loop with loop_src(), then tile *that*, which is continuous
#     by construction.  See `vials` below.
#
#   * `asetrate=<32000*k>,aresample=32000` inside `pre` — plays the material k
#     slower and k lower.  Used on the crowd recordings (all of which are
#     modern, and two of which are teenagers) to drop the voices into a lower,
#     heavier register and out of any resemblance to a school canteen.  It also
#     yields (L+X)/k seconds of material, which is why some windows below look
#     shorter than they need to be.
# =============================================================================

def loop_src(src, start, L, X, pre, out, sloop=0):
    """As loop_from_file, plus -stream_loop for sources shorter than L+X."""
    fc = (f"[0:a]atrim={start}:{start+L+X},asetpts=N/SR/TB,"
          f"aformat=channel_layouts=mono:sample_rates={SR},{pre},asplit=2[p][q];"
          f"[p]atrim=0:{L},asetpts=N/SR/TB,afade=t=in:st=0:d={X}:curve=qsin[a];"
          f"[q]atrim={L}:{L+X},asetpts=N/SR/TB,afade=t=out:st=0:d={X}:curve=qsin,"
          f"apad=whole_dur={L}[b];"
          f"[a][b]amix=inputs=2:normalize=0,atrim=0:{L}[o]")
    run(["ffmpeg","-hide_banner","-v","error","-y"]
        + (["-stream_loop", str(sloop)] if sloop else [])
        + ["-i", str(src), "-filter_complex", fc, "-map", "[o]",
           "-ar", str(SR), "-ac", "1", str(out)])

CAF  = SRC/"High_school_cafeteria.ogg"                     # crowd walla, indoors
MAL  = SRC/"1_minute_at_the_alexa_mall_in_berlin.ogg"      # big hall, low rumble
CHW  = SRC/"Church_people_walking_steps_with_reverb.ogg"   # footfalls in reverb
MKT  = SRC/"Le_marche_daligre.ogg"                         # open-air market crowd
BW2  = SRC/"Boat_by_a_wharf_2.ogg"                         # water against a hull
BW3  = SRC/"Boat_by_a_wharf_3.ogg"                         # hull knocks, rope
POOL = SRC/"Indoor_swimming_pool_hall.ogg"                 # water in a hard room
WTR  = SRC/"Water_flowing_pouring_trickling.ogg"           # poured / trickling
AMB  = SRC/"20090610_0_ambience.ogg"                       # a genuinely still room
PEN  = SRC/"Pencil_scratchings.ogg"                        # continuous writing
CLS  = SRC/"Ambient_classroom_mono.ogg"                    # a room with people in
SLO  = SRC/"Water_sloshing_in_a_small_bottle.ogg"          # small glass, liquid
BNG  = SRC/"Binging_glass.ogg"                             # glass handled
MIX  = SRC/"Mixing_spices.ogg"                             # grinding in a bowl

# ---- 9. harbour-arrival — the Roman fleet entering the Great Harbour.
#         Water against a hull is the foreground; the open sea is the mass
#         behind it; the crowd is the canteen recording low-passed to 800 Hz,
#         which is what a few hundred men sound like across a quarter mile of
#         water — no words survive that filter. No oar stroke is synthesised:
#         a stroke is a rhythm, and a rhythm in a 26 s bed is a metronome. The
#         swell layer carries two slow tremolos at incommensurate rates (0.41
#         and 0.33 Hz) so they beat against each other and never lock.
loop_from_file(BW2, 58, 26, 3, "highpass=f=40,lowpass=f=9000", TMP/"har2_a.wav")
loop_from_file(O,   90, 26, 3, "highpass=f=45,lowpass=f=2600", TMP/"har2_b.wav")
loop_from_file(CAF, 29, 26, 3,
               "asetrate=29440,aresample=32000,highpass=f=110,lowpass=f=800,lowpass=f=800",
               TMP/"har2_c.wav")
loop_from_file(CHW, 0.5, 26, 3, "lowpass=f=1500,lowpass=f=1500", TMP/"har2_d.wav")
loop_from_file(BW3,  2,  26, 3, "highpass=f=120,lowpass=f=7000", TMP/"har2_e.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.8:seed=7201", 26, 3,
                "lowpass=f=400,lowpass=f=400,tremolo=f=0.41:d=0.26,tremolo=f=0.33:d=0.22",
                TMP/"har2_f.wav")
mix([(TMP/"har2_a.wav", 0), (TMP/"har2_b.wav", -6), (TMP/"har2_c.wav", -13),
     (TMP/"har2_d.wav", -15), (TMP/"har2_e.wav", -12), (TMP/"har2_f.wav", -12)],
    OUT/"harbour-arrival.mp3", lufs=-22)

# ---- 10. triumph — the crowd. The loudest, most populated bed in the story.
#          Three uncorrelated crowds (indoor canteen, shopping hall, open-air
#          market) summed and pitched down 6–8%: no two of them share a room,
#          so nothing in the sum is a sentence any more, and the mass is much
#          denser than any one of them. The footfalls are real and irregular,
#          from a church recording whose original filename is literally
#          "church_walla_and_people_walking".
loop_from_file(CAF, 29, 26, 3,
               "asetrate=30080,aresample=32000,highpass=f=90,lowpass=f=5000",
               TMP/"tri_a.wav")
loop_from_file(MAL, 20, 26, 3, "highpass=f=30,lowpass=f=3000", TMP/"tri_b.wav")
loop_from_file(MKT, 94, 26, 3,
               "asetrate=30400,aresample=32000,highpass=f=70,lowpass=f=2600",
               TMP/"tri_c.wav")
loop_from_file(CHW, 0.5, 26, 3, "highpass=f=60,lowpass=f=6000", TMP/"tri_d.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.85:seed=7202", 26, 3,
                "lowpass=f=160,lowpass=f=160,tremolo=f=0.1:d=0.3", TMP/"tri_e.wav")
mix([(TMP/"tri_a.wav", 0), (TMP/"tri_b.wav", -5), (TMP/"tri_c.wav", -9),
     (TMP/"tri_d.wav", -7), (TMP/"tri_e.wav", -14)],
    OUT/"triumph.mp3", lufs=-22)

# ---- 11. bath — a palace bathing room. Trickling and poured water in front,
#          a hard reverberant water hall behind it low-passed to 2.8 kHz so no
#          voice detail survives, and a dark floor under both. Deliberately not
#          a splashing bathhouse: the splash recording that was available has a
#          31 dB peak-to-median spread and is a series of events, not ambience.
loop_from_file(WTR, 30, 22, 3,
               "highpass=f=90,lowpass=f=7000,aecho=0.8:0.85:170|330:0.28|0.16",
               TMP/"bat_a.wav")
loop_from_file(POOL, 22, 22, 3, "highpass=f=60,lowpass=f=2800", TMP/"bat_b.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.8:seed=7203", 22, 3,
                "lowpass=f=220,lowpass=f=220,tremolo=f=0.1:d=0.35", TMP/"bat_c.wav")
mix([(TMP/"bat_a.wav", 0), (TMP/"bat_b.wav", -11), (TMP/"bat_c.wav", -8)],
    OUT/"bath.mp3", lufs=-25)

# ---- 12. letter — a quiet room and a stylus. The scene card asks for the
#          interruption too, and a loop cannot carry one: an event that arrives
#          once a lap is the metronome the whole spec forbids. So the approach
#          is here as a texture rather than an event — footfalls low-passed to
#          600 Hz, which is a tread through a wall, present but not locatable
#          and never resolving into someone arriving. The interruption itself
#          is the cut to `search`.
loop_from_file(AMB, 1, 20, 3, "highpass=f=40,lowpass=f=1800", TMP/"let_a.wav")
loop_from_file(PEN, 16, 20, 3, "highpass=f=200,lowpass=f=5000", TMP/"let_b.wav")
loop_from_file(CHW, 0.5, 20, 3, "lowpass=f=600,lowpass=f=600", TMP/"let_c.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.22:seed=7204", 20, 3,
                "highpass=f=1500,lowpass=f=6000,tremolo=f=0.16:d=0.45", TMP/"let_d.wav")
mix([(TMP/"let_a.wav", 0), (TMP/"let_b.wav", -14), (TMP/"let_c.wav", -18),
     (TMP/"let_d.wav", -24)],
    OUT/"letter.mp3", lufs=-25)

# ---- 13. search — the room after the search. Nearly silence, and it has to
#          read as nearly silence rather than as a failed download, so there is
#          always something there: a real still-room recording low-passed to
#          1.2 kHz, a floor under it, and one very faint high layer that drifts
#          — the settling. It is encoded at −26 LUFS like every other bed
#          (a bed encoded quiet is a bed encoded noisy at 48 kbps) and made
#          quiet where quiet belongs, in BEDS["s-search"].gain.
#
#          The high layer sits at −18 dB rather than the −26 it wants to, and
#          the room is low-passed at 1.5 kHz rather than 1.2, for one reason:
#          a phone speaker has almost nothing below 500 Hz. A bed that is only
#          low end measures fine and plays as silence on the device this is
#          actually read on, which for THIS bed is indistinguishable from the
#          failure it exists to avoid. The 2–7 kHz layer is the part a phone
#          can actually reproduce, so it has to be there.
loop_from_file(AMB, 1, 20, 3, "highpass=f=35,lowpass=f=1500,lowpass=f=1500",
               TMP/"sea2_a.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.7:seed=7205", 20, 3,
                "lowpass=f=110,lowpass=f=110,tremolo=f=0.1:d=0.4", TMP/"sea2_b.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.2:seed=7206", 20, 3,
                "highpass=f=2000,lowpass=f=7000,tremolo=f=0.13:d=0.6", TMP/"sea2_c.wav")
mix([(TMP/"sea2_a.wav", 0), (TMP/"sea2_b.wav", -6), (TMP/"sea2_c.wav", -18)],
    OUT/"search.mp3", lufs=-25.6)

# ---- 14. copies — a scriptorium. Two windows of the same pencil recording,
#          40 s apart so they are uncorrelated, the second pitched down 8% and
#          given a short echo: the same hand near, and someone else's across
#          the room. Under them a real occupied-room tone at −16 dB and low-
#          passed to 2.2 kHz, for the fact of other people without any of them.
loop_from_file(PEN, 16, 22, 3, "highpass=f=250,lowpass=f=8000", TMP/"cop_a.wav")
loop_from_file(PEN, 55, 22, 3,
               "asetrate=29440,aresample=32000,highpass=f=200,lowpass=f=4000,"
               "aecho=0.8:0.8:120|240:0.25|0.14", TMP/"cop_b.wav")
loop_from_file(CLS, 34, 22, 3, "highpass=f=50,lowpass=f=2200", TMP/"cop_c.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.25:seed=7207", 22, 3,
                "highpass=f=2500,lowpass=f=8000,tremolo=f=0.14:d=0.4", TMP/"cop_d.wav")
mix([(TMP/"cop_a.wav", 0), (TMP/"cop_b.wav", -9), (TMP/"cop_c.wav", -16),
     (TMP/"cop_d.wav", -22)],
    OUT/"copies.mp3", lufs=-24)

# ---- 15. vials — a physician's table. The two-stage tiling lives here: the
#          liquid recording is 7.5 s and the grinding 11.7 s, so each is first
#          made into a seamless sub-loop and only then tiled, which cannot
#          click. Two copies of the liquid at 0.93x and 1.09x give periods of
#          6.45 s and 5.50 s, whose common period is far longer than the bed,
#          so nothing in it repeats on the lap. The glass window is chosen for
#          where the taps are *densest*: dense is a texture, sparse is an event.
loop_src(SLO, 0.4, 6, 1, "anull", TMP/"via_slo.wav")
loop_src(MIX, 1.0, 9, 1.5, "anull", TMP/"via_mix.wav")
loop_src(TMP/"via_slo.wav", 0, 20, 3,
         "asetrate=29760,aresample=32000,highpass=f=150,lowpass=f=7000",
         TMP/"via_a.wav", sloop=6)
loop_src(TMP/"via_slo.wav", 1.7, 20, 3,
         "asetrate=34880,aresample=32000,highpass=f=200,lowpass=f=9000",
         TMP/"via_b.wav", sloop=6)
loop_src(TMP/"via_mix.wav", 0, 20, 3, "highpass=f=200,lowpass=f=6000",
         TMP/"via_c.wav", sloop=4)
loop_from_file(BNG, 34, 20, 3, "highpass=f=400,lowpass=f=11000", TMP/"via_d.wav")
loop_from_lavfi(f"anoisesrc=c=pink:r={SR}:a=0.25:seed=7208", 20, 3,
                "highpass=f=3000,lowpass=f=9000,tremolo=f=0.14:d=0.5", TMP/"via_e.wav")
loop_from_lavfi(f"anoisesrc=c=brown:r={SR}:a=0.75:seed=7209", 20, 3,
                "lowpass=f=200,lowpass=f=200,tremolo=f=0.11:d=0.3", TMP/"via_f.wav")
mix([(TMP/"via_a.wav", 0), (TMP/"via_b.wav", -9), (TMP/"via_c.wav", -12),
     (TMP/"via_d.wav", -21), (TMP/"via_e.wav", -20), (TMP/"via_f.wav", -7)],
    OUT/"vials.mp3", lufs=-25)


for f in sorted(OUT.glob("*.mp3")):
    print(f"{f.name:14s} {f.stat().st_size/1024:7.1f} KB")
