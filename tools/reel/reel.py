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

FONTS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
         "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/System/Library/Fonts/Helvetica.ttc"]
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

def cmd_beats(run_dir, script_path=None, sec_per_image=0.7, **_):
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


def cmd_voice(run_dir, provider="say", join_gap=0.10, voice="Daniel", rate=190, **_):
    """Synthesise each sentence alone, measure it, join with a gap WE choose."""
    doc = read_json(run_dir, "beats.json")
    parts_dir = ensure(os.path.join(run_dir, "voice_parts"))
    parts, t = [], 0.0
    for b in doc["beats"]:
        wav = os.path.join(parts_dir, b["slug"] + ".wav")
        if provider == "say":
            say_one(b["text"], wav, voice=voice, rate=rate)
        else:
            raise SystemExit("voice provider not wired yet: " + provider)
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
    doc["voice"] = {"provider": provider, "file": "voice.wav",
                    "join_gap": join_gap, "duration": round(probe(out), 3)}
    write_json(run_dir, "beats.json", doc)
    print("  voice            : %s, %d parts, %.2fs "
          "(the %.2fs gaps are chosen, not left over)"
          % (provider, len(parts), doc["voice"]["duration"], join_gap))
    return doc


# ------------------------------------------------------------- timeline ----

def cmd_timeline(run_dir, **_):
    """Deal images out inside each sentence. A sentence long enough for three
    images gets three, a short one gets one. Every cut lands on speech, which
    a fixed grid cannot promise."""
    doc = read_json(run_dir, "beats.json")
    spi = doc.get("sec_per_image", 0.7)
    shots = []
    for b in doc["beats"]:
        n = max(1, int(round(b["dur"] / spi)))
        each = b["dur"] / n
        for k in range(n):
            shots.append({"i": len(shots) + 1, "beat": b["n"], "text": b["text"],
                          "slug": "%02d_%s" % (len(shots) + 1, slug(b["text"])),
                          "start": round(b["start"] + k * each, 3),
                          "dur": round(each, 3)})
    doc["shots"] = shots
    doc["duration"] = doc["voice"]["duration"]
    write_json(run_dir, "beats.json", doc)
    print("  timeline         : %d shots over %.2fs (mean %.2fs on screen)"
          % (len(shots), doc["duration"], doc["duration"] / len(shots)))
    return doc


# --------------------------------------------------------------- images ----

def _font(size, bold=True):
    from PIL import ImageFont
    for f in FONTS:
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
    if provider != "placeholder":
        raise SystemExit("image provider not wired yet: " + provider)
    for s in doc["shots"]:
        p = os.path.join(d, s["slug"] + ".png")
        v = 26 + (s["beat"] * 11) % 58
        img = Image.new("RGB", (W, H), (v, max(0, v - 5), min(255, v + 12)))
        dr = ImageDraw.Draw(img)
        big = _font(190)
        num = "%02d" % s["i"]
        dr.text(((W - dr.textlength(num, font=big)) / 2, 210), num, font=big,
                fill=(min(255, 90 + v), min(255, 90 + v), min(255, 100 + v)))
        body = _font(64)
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
    font = _font(58)
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


STAGES = [("beats", cmd_beats), ("voice", cmd_voice), ("timeline", cmd_timeline),
          ("images", cmd_images), ("captions", cmd_captions), ("render", cmd_render)]


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    stage, script_path = argv[1], argv[2]
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
