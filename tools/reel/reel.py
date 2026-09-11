#!/usr/bin/env python3
"""
reel.py — a script goes in, a finished vertical video comes out.

    python3 tools/reel/reel.py build tools/reel/scripts/cleopatra.md

The human parts are the script and the visual style. Everything between them
is assembly, and this is the assembly.

WHY THERE IS NO GAP-REMOVAL STEP
Every other version of this pipeline synthesises the whole script as one file,
then hunts for the silences the voice engine left between sentences and cuts
them out — by ear, or by silence detection, which is a guess dressed up as a
measurement. This synthesises ONE SENTENCE AT A TIME and joins the pieces
itself. There is no gap to remove because no gap is ever created, and every
sentence's duration is read off the file rather than inferred. That is also
what lets an image change land on a sentence boundary instead of on a blind
stopwatch grid.

WHY TEXT IS DRAWN IN PYTHON
The ffmpeg on this machine is built without freetype and libass, so there is
no drawtext and no subtitles filter. Drawing in Pillow is better anyway: real
font control, and the source images stay clean because captions are composited
as their own layer rather than burned in.

PROVIDERS
Voice and images are pluggable so the shape can be proved before the accounts
exist. `say` and `placeholder` need no key and no money and run today;
`elevenlabs` and `higgsfield` slot into the same interface and write the same
filenames, so nothing downstream can tell the difference.
"""

import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "runs")
W, H, FPS = 1080, 1920, 30

# The reel is set in the same faces as the site — DM Sans for anything that
# behaves like interface, Newsreader for display — so a reel and the app read
# as one product rather than two. Both are open-licensed and vendored in
# tools/reel/fonts so a run does not depend on what a given machine happens
# to have installed. System faces are a fallback, never the intent.
_BRAND = os.path.join(HERE, "fonts")
FACES = {
    "ui": [os.path.join(_BRAND, "DMSans-700.ttf"),
           "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
           "/System/Library/Fonts/Helvetica.ttc"],
    "body": [os.path.join(_BRAND, "DMSans-500.ttf"),
             os.path.join(_BRAND, "DMSans-700.ttf"),
             "/System/Library/Fonts/Supplemental/Arial.ttf"],
    "display": [os.path.join(_BRAND, "Newsreader-600.ttf"),
                "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
}
FONTS = FACES["ui"]
FONT = next((f for f in FONTS if os.path.exists(f)), None)


def _venv():
    """Re-exec into tools/reel/.venv when Pillow is not on this interpreter,
    so `python3 reel.py` works without anyone having to remember the venv."""
    try:
        import PIL  # noqa: F401
        return
    except ImportError:
        pass
    venv = os.path.join(HERE, ".venv", "bin", "python3")
    if os.path.exists(venv) and os.environ.get("_REEL_VENV") != "1":
        os.environ["_REEL_VENV"] = "1"
        os.execv(venv, [venv] + sys.argv)
    raise SystemExit("Pillow is needed: python3 -m venv tools/reel/.venv && "
                     "tools/reel/.venv/bin/pip install Pillow")


def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        sys.stderr.write("\n$ " + " ".join(str(c) for c in cmd[:14]) + " ...\n")
        sys.stderr.write((p.stderr or "")[-1500:] + "\n")
        raise SystemExit("command failed: " + cmd[0])
    return p.stdout


def probe(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path])
    return float(out.strip())


def slug(s, n=28):
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s[:n].strip("_") or "shot"


def ensure(p):
    os.makedirs(p, exist_ok=True)
    return p


def read_json(run_dir, name):
    return json.load(open(os.path.join(run_dir, name)))


def write_json(run_dir, name, doc):
    with open(os.path.join(run_dir, name), "w") as fh:
        json.dump(doc, fh, indent=1)


# ---------------------------------------------------------------- beats ----

def cmd_beats(run_dir, script_path=None, sec_per_image=2.0, **_):
    """The script becomes a list of sentences. A sentence is the unit of
    timing; images get dealt out inside it later."""
    lines = [l.strip() for l in open(script_path).read().splitlines()]
    lines = [l for l in lines if l and not l.startswith("#")]
    sents = []
    for line in lines:
        for part in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'])", line):
            part = part.strip()
            if part:
                sents.append(part)
    beats = [{"n": i + 1, "text": s, "slug": "%02d_%s" % (i + 1, slug(s))}
             for i, s in enumerate(sents)]
    doc = {"script": os.path.relpath(script_path, HERE),
           "sec_per_image": sec_per_image, "beats": beats}
    write_json(run_dir, "beats.json", doc)
    print("  beats            : %d sentences" % len(beats))
    return doc


# ---------------------------------------------------------------- voice ----

def say_one(text, out_wav, voice="Daniel", rate=190):
    aiff = out_wav + ".aiff"
    run(["say", "-v", voice, "-r", str(rate), "-o", aiff, text])
    run(["ffmpeg", "-y", "-v", "error", "-i", aiff, "-ar", "44100", "-ac", "1", out_wav])
    os.remove(aiff)


def cmd_voice(run_dir, provider="say", join_gap=0.10, voice="Daniel", rate=190,
              tempo=1.0, **_):
    """Synthesise each sentence alone, measure it, join with a gap WE choose.

    TEMPO IS FREE AND SEPARATE FROM SPEED. ElevenLabs hard-caps voice speed at
    1.2 — it rejects anything higher outright — and short-scene pacing wants
    faster than that. So each paid sentence is kept as a .raw.wav and the
    delivery speed is applied afterwards with ffmpeg atempo, which shortens the
    audio without raising the pitch. Changing tempo therefore costs nothing and
    never re-buys a character: the raw file is the receipt, the .wav is a
    derived artefact. Durations are measured AFTER the change, so the cut
    follows the new delivery automatically."""
    doc = read_json(run_dir, "beats.json")
    parts_dir = ensure(os.path.join(run_dir, "voice_parts"))
    parts, t = [], 0.0
    reused, spent = 0, 0
    for b in doc["beats"]:
        wav = os.path.join(parts_dir, b["slug"] + ".wav")
        # A sentence is only ever synthesised once. ElevenLabs bills per
        # character, and re-running the pipeline to fix an image or a caption
        # would otherwise re-buy the entire voice track every time. The stamp
        # holds the text, voice and provider, so a REWRITTEN sentence is
        # correctly paid for again and an unchanged one is not.
        raw = os.path.join(parts_dir, b["slug"] + ".raw.wav")
        stamp = raw + ".stamp"
        want = "%s\n%s\n%s" % (provider, voice if provider == "say" else "", b["text"])
        have = open(stamp).read() if os.path.exists(stamp) else None
        if os.path.exists(raw) and have == want:
            reused += 1
        else:
            if provider == "say":
                say_one(b["text"], raw, voice=voice, rate=rate)
            elif provider == "elevenlabs":
                import providers
                providers.elevenlabs_say(b["text"], raw, run)
            else:
                raise SystemExit("unknown voice provider: " + provider)
            open(stamp, "w").write(want)
            spent += len(b["text"])
        # atempo tops out at 2.0 per stage, so chain stages for anything faster
        if abs(tempo - 1.0) < 0.001:
            run(["ffmpeg", "-y", "-v", "error", "-i", raw, "-c", "copy", wav])
        else:
            t, chain = tempo, []
            while t > 2.0:
                chain.append("atempo=2.0"); t /= 2.0
            while t < 0.5:
                chain.append("atempo=0.5"); t /= 0.5
            chain.append("atempo=%.4f" % t)
            run(["ffmpeg", "-y", "-v", "error", "-i", raw, "-filter:a",
                 ",".join(chain), wav])
        d = probe(wav)
        b["audio"] = os.path.relpath(wav, run_dir)
        b["start"] = round(t, 3)
        b["dur"] = round(d, 3)
        b["end"] = round(t + d, 3)
        parts.append(wav)
        t += d + join_gap
    sil = os.path.join(parts_dir, "_gap.wav")
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
         "anullsrc=r=44100:cl=mono", "-t", str(join_gap), sil])
    listing = os.path.join(parts_dir, "_concat.txt")
    with open(listing, "w") as fh:
        for i, p in enumerate(parts):
            fh.write("file '%s'\n" % p.replace("'", "'\\''"))
            if i != len(parts) - 1:
                fh.write("file '%s'\n" % sil)
    out = os.path.join(run_dir, "voice.wav")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing,
         "-c", "copy", out])
    doc["voice"] = {"provider": provider, "file": "voice.wav", "tempo": tempo,
                    "join_gap": join_gap, "duration": round(probe(out), 3)}
    write_json(run_dir, "beats.json", doc)
    print("  voice            : %s, %d parts, %.2fs "
          "(the %.2fs gaps are chosen, not left over)"
          % (provider, len(parts), doc["voice"]["duration"], join_gap))
    if provider == "elevenlabs":
        print("                     %d characters bought, %d sentences reused free"
              % (spent, reused))
    return doc


# ------------------------------------------------------------- timeline ----

def prompts_path(doc):
    name = os.path.splitext(os.path.basename(doc["script"]))[0]
    return os.path.join(HERE, "scripts", name + ".prompts.json")


def load_prompts(doc):
    """Prompts are keyed by BEAT — the sentence — not by shot. A value is either
    one prompt, or a list of prompts for a sentence that earns more than one
    picture. Returns {beat number: [prompt, ...]}."""
    p = prompts_path(doc)
    if not os.path.exists(p):
        return {}
    raw = json.load(open(p))
    out = {}
    for k, v in raw.items():
        try:
            n = int(k)
        except ValueError:
            continue
        out[n] = [v] if isinstance(v, str) else list(v)
    return out


def _prompt_counts(doc):
    return {k: len(v) for k, v in load_prompts(doc).items()}


def cmd_timeline(run_dir, max_shot=0, **_):
    """ONE IMAGE PER SENTENCE, HELD FOR AS LONG AS THE SENTENCE TAKES TO SAY.

    This is the rule, and it overrides any target seconds-per-image. An image
    illustrates a sentence, so it belongs on screen for exactly that sentence:
    "It works." is under a second and "So according to the ancient historian
    Plutarch, she has herself secretly carried into Caesar's quarters inside a
    bedding sack" is five, and both get one picture. Cutting to a clock instead
    splits a single thought across three frames and lands changes mid-phrase,
    which is what makes an assembled reel feel assembled. Picture and voice
    change together or the edit is fighting itself.

    A SENTENCE MAY CARRY MORE THAN ONE IMAGE — but only when the sentence holds
    more than one thing worth seeing, and that is a judgement about the story,
    not about the clock. "Within weeks, Antony is dead, Cleopatra is dead, and
    her dynasty is over" is three deaths and can take three pictures; "She has
    been driven out of Egypt" is one picture however long it runs.

    So the PROMPTS decide the cut, not arithmetic. A beat whose entry in
    <script>.prompts.json is a list of two prompts gets two shots, splitting
    that sentence's own time between them. Writing a second prompt IS the
    decision to cut again, made where the scene is being imagined rather than
    afterwards by a divider. A beat with a single prompt, or no prompts file at
    all, gets one image for the whole sentence.

    max_shot remains as a blunt fallback, off by default, for a long line with
    no second prompt written for it yet."""
    doc = read_json(run_dir, "beats.json")
    per_beat = _prompt_counts(doc)
    shots = []
    for b in doc["beats"]:
        n = per_beat.get(b["n"], 0)
        if not n:
            n = 1
            if max_shot and b["dur"] > max_shot:
                n = int(b["dur"] / max_shot) + 1
        each = b["dur"] / n
        for k in range(n):
            shots.append({"i": len(shots) + 1, "beat": b["n"], "sub": k,
                          "of": n, "text": b["text"],
                          "slug": "%02d_%s" % (len(shots) + 1, slug(b["text"])),
                          "start": round(b["start"] + k * each, 3),
                          "dur": round(each, 3)})
    # Sentences are separated by a chosen join gap, so shots laid strictly
    # inside their sentence leave a hole at every join — nineteen of them on
    # this script. On a timeline that is a blank frame; in a straight concat
    # render it is worse, because the images close up and drift ahead of the
    # voice a little further at every join. Stretch each shot to meet the next
    # one so the track is continuous and every image stays on its own words.
    for a, b in zip(shots, shots[1:]):
        a["dur"] = round(b["start"] - a["start"], 3)
    shots[-1]["dur"] = round(doc["voice"]["duration"] - shots[-1]["start"], 3)

    # Re-attach any image already generated for this slug. Rebuilding the
    # timeline must never orphan pictures that are already paid for — and the
    # timeline gets rebuilt every time a pacing rule changes.
    img_dir = os.path.join(run_dir, "images")
    for sh in shots:
        f = os.path.join(img_dir, sh["slug"] + ".png")
        if os.path.exists(f):
            sh["image"] = os.path.relpath(f, run_dir)

    doc["shots"] = shots
    doc["duration"] = doc["voice"]["duration"]
    write_json(run_dir, "beats.json", doc)
    print("  timeline         : %d shots over %.2fs (mean %.2fs on screen), %d with art"
          % (len(shots), doc["duration"], doc["duration"] / len(shots),
             sum(1 for x in shots if x.get("image"))) if False else
          "  timeline         : %d shots over %.2fs (mean %.2fs on screen)"
          % (len(shots), doc["duration"], doc["duration"] / len(shots)))
    return doc


# --------------------------------------------------------------- images ----

def _font(size, face="ui"):
    from PIL import ImageFont
    for f in FACES.get(face, FACES["ui"]):
        try:
            return ImageFont.truetype(f, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _wrap(draw, text, font, max_w):
    words, lines, line = text.split(), [], ""
    for w in words:
        t = (line + " " + w).strip()
        if draw.textlength(t, font=font) > max_w and line:
            lines.append(line)
            line = w
        else:
            line = t
    if line:
        lines.append(line)
    return lines


def cmd_images(run_dir, provider="placeholder", **_):
    """placeholder draws the shot number and its line, so the CUT can be judged
    before a credit is spent. higgsfield swaps in here and writes the same
    filenames."""
    from PIL import Image, ImageDraw
    doc = read_json(run_dir, "beats.json")
    d = ensure(os.path.join(run_dir, "images"))
    if provider == "higgsfield":
        return _higgsfield_images(run_dir, doc, d, **_)
    if provider != "placeholder":
        raise SystemExit("unknown image provider: " + provider)
    for s in doc["shots"]:
        p = os.path.join(d, s["slug"] + ".png")
        v = 26 + (s["beat"] * 11) % 58
        img = Image.new("RGB", (W, H), (v, max(0, v - 5), min(255, v + 12)))
        dr = ImageDraw.Draw(img)
        big = _font(190)
        num = "%02d" % s["i"]
        dr.text(((W - dr.textlength(num, font=big)) / 2, 210), num, font=big,
                fill=(min(255, 90 + v), min(255, 90 + v), min(255, 100 + v)))
        body = _font(64, "display")
        lines = _wrap(dr, s["text"], body, W - 200)[:7]
        y = H // 2 - (len(lines) * 82) // 2
        for ln in lines:
            dr.text(((W - dr.textlength(ln, font=body)) / 2, y), ln, font=body,
                    fill=(238, 238, 240))
            y += 82
        tag = _font(34)
        dr.text((70, H - 130), "beat %d  ·  %.2fs" % (s["beat"], s["dur"]),
                font=tag, fill=(150, 150, 160))
        img.save(p)
        s["image"] = os.path.relpath(p, run_dir)
    write_json(run_dir, "beats.json", doc)
    print("  images           : %d %s frames" % (len(doc["shots"]), provider))
    return doc


def _higgsfield_images(run_dir, doc, d, approved=0, limit=0, **_):
    """Real images, real money. Three rules are enforced here rather than
    trusted to whoever runs it:

    THE STYLE GUIDE IS APPENDED VERBATIM. It is read from a file and pasted
    unchanged onto every prompt. A style described in prose, or re-typed per
    shot, drifts — and a set that drifts is a set you pay for twice.

    THE FIRST SHOT IS APPROVED BY EYE. The run stops after shot 1 until it is
    passed --approved=1. A locked character that looks wrong looks wrong 69
    times, and the reference thumbnail is too small to judge from.

    FAILURES ARE NEVER RETRIED SILENTLY. They are listed at the end for a
    human to reword. Roughly one in six trips the content filter or errors,
    and a silent retry loop is how a bug becomes a bill."""
    import providers
    name = os.path.splitext(os.path.basename(doc["script"]))[0]
    base = os.path.join(HERE, "scripts")
    pf = os.path.join(base, name + ".prompts.json")
    sf = os.path.join(base, name + ".style.txt")
    if not os.path.exists(pf):
        raise SystemExit(
            "no prompts file at %s\n"
            "  Each shot needs a written prompt — that is the one step still worth a\n"
            "  human's judgement and a model's time. Shape: {\"01\": \"SHOT 01 — ...\"}\n"
            "  with one entry per shot in beats.json." % pf)
    prompts = load_prompts(doc)
    style = open(sf).read().strip() if os.path.exists(sf) else ""
    if not style:
        print("  WARNING          : no %s — every image will drift in style" % os.path.basename(sf))

    shots = doc["shots"][:limit] if limit else doc["shots"]
    if not approved:
        shots = shots[:1]
    todo = [s for s in shots if not os.path.exists(os.path.join(d, s["slug"] + ".png"))]
    print("  higgsfield       : %d to generate (%d already on disk)"
          % (len(todo), len(shots) - len(todo)))

    failed = []
    for s in todo:
        # Prompts are keyed by the SENTENCE, and a sentence may hold several.
        # s["sub"] says which picture within that sentence this is.
        group = prompts.get(s["beat"], [])
        tag = "SHOT %02d" % s["beat"]
        if s["sub"] >= len(group):
            failed.append((tag, "sentence %d has %d prompt(s) but the timeline wants %d"
                           % (s["beat"], len(group), s["of"])))
            continue
        prompt = group[s["sub"]].strip()
        if tag not in prompt:
            failed.append((tag, "prompt is not tagged %s — refusing to spend a credit "
                           "on a prompt that may belong to another sentence" % tag))
            continue
        # the base tag is what the guard counts inside the prompt; the label is
        # only what gets printed, so a second picture on one sentence reads as
        # 08.2 without breaking the check
        label = "%s.%d" % (tag, s["sub"] + 1) if s["of"] > 1 else tag
        if style:
            prompt = prompt + "\n\n" + style
        p = os.path.join(d, s["slug"] + ".png")
        res = providers.higgsfield_image(prompt, p, tag)
        if res.get("ok"):
            print("    %s ok" % label)
        else:
            failed.append((label, res.get("why") + (" — " + res["hint"] if res.get("hint") else "")))
            print("    %s FAILED: %s" % (label, res.get("why")))

    # Re-read before writing. A batch takes half an hour, and the timeline can
    # legitimately be rebuilt while it runs — a pacing rule changes, shots are
    # renumbered. Writing back the copy loaded thirty minutes ago silently
    # reverts all of it, which is exactly what happened once: a 20-shot
    # timeline came back as 25 with the old numbering.
    fresh = read_json(run_dir, "beats.json")
    for s in fresh["shots"]:
        p = os.path.join(d, s["slug"] + ".png")
        if os.path.exists(p):
            s["image"] = os.path.relpath(p, run_dir)
    write_json(run_dir, "beats.json", fresh)

    if failed:
        print("  %d shot(s) need rewording:" % len(failed))
        for t, why in failed:
            print("    %-10s %s" % (t, why))
    if not approved:
        print("  STOPPED after shot 1 on purpose. Look at it — the character and the\n"
              "  style are being judged here, not later. Then re-run with --approved=1.")
    return doc


# ------------------------------------------------------------- captions ----

def srt_time(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return "%02d:%02d:%02d,%03d" % (h, m, int(s), round((s - int(s)) * 1000))


def cmd_captions(run_dir, **_):
    """Cues come off the MEASURED audio, so they cannot drift. Each is also a
    transparent card, because captions are a layer over the images rather than
    something burned into them."""
    from PIL import Image, ImageDraw
    doc = read_json(run_dir, "beats.json")
    with open(os.path.join(run_dir, "captions.srt"), "w") as fh:
        for i, b in enumerate(doc["beats"], 1):
            fh.write("%d\n%s --> %s\n%s\n\n"
                     % (i, srt_time(b["start"]), srt_time(b["end"]), b["text"]))
    d = ensure(os.path.join(run_dir, "captions"))
    font = _font(58, "ui")
    for b in doc["beats"]:
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        dr = ImageDraw.Draw(img)
        lines = _wrap(dr, b["text"], font, W - 220)[-3:]
        y = H - 420 - len(lines) * 74
        for ln in lines:
            x = (W - dr.textlength(ln, font=font)) / 2
            for ox, oy in ((-3, 0), (3, 0), (0, -3), (0, 3),
                           (-2, -2), (2, 2), (-2, 2), (2, -2)):
                dr.text((x + ox, y + oy), ln, font=font, fill=(0, 0, 0, 235))
            dr.text((x, y), ln, font=font, fill=(255, 255, 255, 255))
            y += 74
        p = os.path.join(d, "%02d.png" % b["n"])
        img.save(p)
        b["caption_png"] = os.path.relpath(p, run_dir)
    write_json(run_dir, "beats.json", doc)
    print("  captions         : %d cues off the measured audio" % len(doc["beats"]))
    return doc


# --------------------------------------------------------------- render ----

def cmd_render(run_dir, music=None, captions=1, **_):
    doc = read_json(run_dir, "beats.json")
    listing = os.path.join(run_dir, "_frames.txt")
    with open(listing, "w") as fh:
        for s in doc["shots"]:
            p = os.path.join(run_dir, s["image"]).replace("'", "'\\''")
            fh.write("file '%s'\nduration %.3f\n" % (p, s["dur"]))
        # The concat demuxer ignores the duration on the LAST entry, which
        # silently clips the final sentence. Repeat the last frame with room
        # to spare and cut the whole thing to the measured audio instead.
        last = os.path.join(run_dir, doc["shots"][-1]["image"]).replace("'", "'\\''")
        fh.write("file '%s'\nduration 3.000\nfile '%s'\n" % (last, last))
    out = os.path.join(run_dir, "reel.mp4")

    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing,
           "-i", os.path.join(run_dir, "voice.wav")]
    idx = 2
    music_idx = None
    if music and os.path.exists(music):
        cmd += ["-stream_loop", "-1", "-i", music]
        music_idx = idx
        idx += 1
    cap_first = idx
    if captions:
        for b in doc["beats"]:
            cmd += ["-i", os.path.join(run_dir, b["caption_png"])]

    fc = ["[0:v]scale=%d:%d:force_original_aspect_ratio=increase,"
          "crop=%d:%d,fps=%d,format=yuv420p[v0]" % (W, H, W, H, FPS)]
    cur = "v0"
    if captions:
        for k, b in enumerate(doc["beats"]):
            nxt = "v%d" % (k + 1)
            fc.append("[%s][%d:v]overlay=0:0:enable='between(t,%.3f,%.3f)'[%s]"
                      % (cur, cap_first + k, b["start"], b["end"], nxt))
            cur = nxt
    if music_idx is not None:
        fc.append("[1:a]volume=1.0[sp];[%d:a]volume=0.12[mu];"
                  "[sp][mu]amix=inputs=2:duration=first[a]" % music_idx)
        amap = "[a]"
    else:
        amap = "1:a"
    cmd += ["-filter_complex", ";".join(fc), "-map", "[%s]" % cur, "-map", amap,
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "192k",
            "-t", "%.3f" % doc["duration"], out]
    run(cmd)
    got = probe(out)
    print("  render           : reel.mp4  %.2fs  %.1f MB" % (got, os.path.getsize(out) / 1e6))
    if abs(got - doc["duration"]) > 0.20:
        raise SystemExit("render is %.2fs but the voice is %.2fs — the last line "
                         "is being clipped" % (got, doc["duration"]))
    return doc


def cmd_capcut(run_dir, project=None, **_):
    """Hand the whole cut to CapCut, laid out and timed, so the only work left
    is the work that needs a person."""
    sys.path.insert(0, HERE)
    import capcut
    doc = read_json(run_dir, "beats.json")
    name = project or ("factbox_" + os.path.basename(run_dir))
    if os.popen("pgrep -x CapCut").read().strip():
        raise SystemExit("CapCut is running — quit it first. It holds the project "
                         "list in memory and will write over a draft added behind "
                         "its back.")
    folder, nv, nt, na = capcut.build(run_dir, doc, name)
    print("  capcut           : %s" % folder)
    print("                     %d images, %d voice clips, %d captions, %.2fs"
          % (nv, na, nt, doc["duration"]))
    return doc


def cmd_check(run_dir=None, **_):
    """python3 tools/reel/reel.py check — are the keys good, before spending."""
    import providers
    return providers.check()


STAGES = [("beats", cmd_beats), ("voice", cmd_voice), ("timeline", cmd_timeline),
          ("images", cmd_images), ("captions", cmd_captions), ("render", cmd_render),
          ("capcut", cmd_capcut)]


def main(argv):
    if len(argv) == 2 and argv[1] == "check":
        sys.path.insert(0, HERE)
        import providers
        return 0 if providers.check() else 1
    if len(argv) < 3:
        print(__doc__)
        return 2
    stage, script_path = argv[1], argv[2]
    if stage == "check":
        import providers
        raise SystemExit(0 if providers.check() else 1)
    opts = {}
    for a in argv[3:]:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            try:
                v = float(v) if "." in v else int(v)
            except ValueError:
                pass
            opts[k.replace("-", "_")] = v
    name = os.path.splitext(os.path.basename(script_path))[0]
    run_dir = ensure(os.path.join(RUNS, name))
    print("  run              : %s" % os.path.relpath(run_dir, HERE))
    todo = STAGES if stage == "build" else [s for s in STAGES if s[0] == stage]
    if not todo:
        raise SystemExit("unknown stage: " + stage)
    for nm, fn in todo:
        fn(run_dir, script_path=script_path, **opts)
    print("  done             : %s"
          % os.path.join(os.path.relpath(run_dir, HERE), "reel.mp4"))
    return 0


if __name__ == "__main__":
    _venv()
    raise SystemExit(main(sys.argv))
