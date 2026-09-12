#!/usr/bin/env python3
"""
ocr.py — read the numbers off a screenshot of an Insights screen.

THIS IS THE FALLBACK FOR ONE METRIC, NOT THE MAIN EVENT. Instagram draws the
per-second retention curve in its mobile app and, as far as anyone here has
been able to establish, nowhere on the web. So the owner screenshots his own
Insights screen, and this reads it.

OFFLINE, WITH NO SERVICE AND NO KEY. It uses the Vision framework that ships
with macOS, through _ocr.swift. Nothing is uploaded, there is no account, and
a screenshot of the owner's own analytics never leaves the machine. That was
the deciding factor over any hosted OCR: the alternative is posting a picture
of his business's performance to somebody else's server every night.

WHAT IT WILL NOT DO. It will not read the retention CURVE itself. A line on a
chart is not text and Vision does not return it; what this gets from that
screen is the axis labels and the summary numbers beside it. Digitising the
curve from pixels is a different job and it is not attempted here — a curve
invented from a chart's pixels is exactly the kind of fabricated series the
board's own notes forbid.

It shares ig-labels.json with instagram.py on purpose: the words beside a
number are the same words whether they were read out of the DOM or off a
picture of the same screen, and two separate label maps would drift.
"""

import argparse, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store
import instagram as ig

HERE  = os.path.dirname(os.path.abspath(__file__))
SWIFT = os.path.join(HERE, "_ocr.swift")
CACHE = os.path.join(HERE, "state", "_ocr")     # compiled once, gitignored


def _binary():
    """Compile _ocr.swift once and reuse it. `swift file.swift` recompiles on
    every run and costs about five seconds; a nightly job over a folder of
    screenshots should pay that once."""
    if os.path.exists(CACHE) and os.path.getmtime(CACHE) > os.path.getmtime(SWIFT):
        return CACHE
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    p = subprocess.run(["swiftc", "-O", "-o", CACHE, SWIFT],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0 or not os.path.exists(CACHE):
        sys.stderr.write("could not compile _ocr.swift, falling back to the interpreter:\n"
                         + (p.stderr or b"").decode("utf-8", "replace")[:400] + "\n")
        return None
    return CACHE


def read_image(path):
    """-> (width, height, [{text, confidence, box}])"""
    if not os.path.exists(path):
        store.die("no such screenshot: " + path)
    exe = _binary()
    cmd = [exe, path] if exe else ["swift", SWIFT, path]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if p.returncode != 0:
        store.die("OCR failed on %s:\n%s" % (path, (p.stderr or b"").decode("utf-8", "replace")[:400]))
    try:
        return json.loads(p.stdout)
    except ValueError:
        store.die("OCR returned non-JSON for " + path)


def pair(lines, max_gap_ratio=0.6):
    """Turn loose OCR strings into {label, value} pairs.

    An Insights screen is a list of rows: a word on the left, a number on the
    right, or a number with its word underneath. So a number is paired with
    the nearest text that is NOT a number and that sits on the same row — or
    immediately above or below it in the same column.

    A number with no plausible label is DROPPED. It is better to read six of
    the seven numbers on a screen than to attach the seventh to whatever text
    happened to be nearest.
    """
    items = []
    for ln in lines:
        t = (ln.get("text") or "").strip()
        if not t:
            continue
        b = ln.get("box") or {}
        items.append({
            "text": t, "conf": ln.get("confidence") or 0,
            "x": b.get("x", 0), "y": b.get("y", 0),
            "w": b.get("w", 0), "h": b.get("h", 0),
        })
    numbers = [i for i in items if ig.parse_count(i["text"]) is not None]
    words   = [i for i in items if ig.parse_count(i["text"]) is None and re.search(r"[A-Za-z]", i["text"])]
    pairs = []
    for n in numbers:
        ncy = n["y"] + n["h"] / 2.0
        best, best_d = None, None
        for w in words:
            wcy = w["y"] + w["h"] / 2.0
            dy = abs(wcy - ncy)
            same_row = dy <= max(n["h"], w["h"]) * max_gap_ratio
            # or stacked: a big number with its caption directly under it
            stacked = (abs((w["x"] + w["w"] / 2.0) - (n["x"] + n["w"] / 2.0))
                       < max(n["w"], w["w"]) * 0.9) and dy < max(n["h"], w["h"]) * 2.6
            if not (same_row or stacked):
                continue
            d = dy * 3 + abs(w["x"] - n["x"]) * 0.2
            if best_d is None or d < best_d:
                best, best_d = w, d
        if best is not None:
            pairs.append({"label": best["text"], "value": n["text"],
                          "confidence": min(n["conf"], best["conf"]),
                          "box": {k: n[k] for k in ("x", "y", "w", "h")}})
    return pairs


def main():
    ap = argparse.ArgumentParser(
        description="Read an Insights screenshot with macOS Vision, offline, and put the numbers on the board.")
    ap.add_argument("images", nargs="+", help="screenshot file(s), or a directory of them")
    ap.add_argument("--url", help="the reel this screenshot is of. Required to write — "
                                  "a screenshot does not say which post it came from.")
    ap.add_argument("--write", action="store_true",
                    help="actually write. Without it this is a DRY RUN, which is the default.")
    ap.add_argument("--min-confidence", type=float, default=0.5,
                    help="drop anything Vision was less sure of than this. Default 0.5.")
    ap.add_argument("--show", action="store_true",
                    help="just print what was read and pair it up; write nothing, need no --url.")
    ap.add_argument("--force", action="store_true", help="ignore the 24h idempotence window.")
    args = ap.parse_args()

    paths = []
    for p in args.images:
        if os.path.isdir(p):
            paths += [os.path.join(p, f) for f in sorted(os.listdir(p))
                      if f.lower().endswith((".png", ".jpg", ".jpeg", ".heic"))]
        else:
            paths.append(p)
    if not paths:
        store.die("no images to read.")

    labels = None if args.show else ig.load_labels()

    for path in paths:
        doc = read_image(path)
        pairs = [p for p in pair(doc.get("lines") or [])
                 if p["confidence"] >= args.min_confidence]
        print("\n%s  (%dx%d, %d text runs, %d label/number pairs)"
              % (os.path.basename(path), doc.get("width", 0), doc.get("height", 0),
                 len(doc.get("lines") or []), len(pairs)))
        for p in pairs:
            print("    %-28s %s" % (p["label"][:28], p["value"]))
        if args.show:
            continue

        hits, ambiguous = ig.extract(pairs, labels)
        for a in ambiguous:
            print("    AMBIGUOUS, not used: %s" % a)
        if not hits:
            print("    nothing matched a label in ig-labels.json — nothing to write.")
            continue
        print("    -> %s" % hits)

        if not args.url:
            # A SCREENSHOT DOES NOT KNOW WHICH POST IT IS OF. Without --url
            # there is no honest way to pick a row, and picking the wrong one
            # writes one reel's numbers over another's.
            print("    (no --url given, so there is no row to attach this to. "
                  "Re-run with --url https://www.instagram.com/reel/...)")
            continue

        key = store.canon_url(args.url)
        if not key:
            store.die("--url is not a post URL this can match: " + args.url)
        run = store.Run("ocr", dry_run=not args.write)
        if not args.force and run.measured_recently(key):
            print("    skipped — measured within the last 24h. --force overrides.")
            continue
        index, _rows = store.load_reels()
        row = index.get(key)
        if row is None:
            run.unmatched({"key": key, "url": args.url,
                           "fields": hits, "extra": {"screenshot": os.path.basename(path)}})
        else:
            run.write_reel(row, hits, key=key,
                           archive_extra={"screenshot": os.path.basename(path),
                                          "pairs": pairs, "ambiguous": ambiguous})
        out = run.finish()
        print(run.report())
        if out:
            print("unmatched written to %s" % out)
        if not args.write:
            print("\n(nothing was written — add --write to commit this to Firestore)")


if __name__ == "__main__":
    main()
