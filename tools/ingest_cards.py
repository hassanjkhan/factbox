#!/usr/bin/env python3
"""Ingest the per-card artwork manifest: 451 images, one per card.

Usage:  python3 ingest_cards.py <manifest.csv> <site-dir> [--limit N]

Wikimedia must not be hotlinked, so every file is fetched once, re-encoded and
served from our own origin. Wikimedia also requires a descriptive User-Agent and
will 403 a default one, so it is set explicitly and requests are paced.

Resumable: an image already downloaded and encoded is skipped, so a partial run
can be re-run without re-fetching hundreds of files.
"""
import csv, hashlib, json, pathlib, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

UA = ("FactboxBot/1.0 (https://factbox.app; hello@factbox.app) "
      "python-urllib — one-time fetch for re-hosting, not hotlinking")
CAP, QFLOOR = 450 * 1024, 68

def col(header, *names):
    """Find a column by any of several likely spellings."""
    low = {h.lower().strip(): h for h in header}
    for n in names:
        if n in low: return low[n]
    for n in names:
        for k, v in low.items():
            if n in k: return v
    return None

def fetch(url, dest, tries=4):
    """Fetch with curl.

    Python's urllib hangs indefinitely in this environment while curl returns
    the same file in about a second, so curl is the transport. It also gives
    us the response code and a hard timeout for free.
    """
    for i in range(tries):
        r = subprocess.run(
            ["curl", "-sS", "-L", "--max-time", "45", "--retry", "0",
             "-A", UA, "-o", str(dest), "-w", "%{http_code} %{content_type}", url],
            capture_output=True, text=True)
        out = (r.stdout or "").strip().split(" ", 1)
        code = out[0] if out else "000"
        ctype = (out[1] if len(out) > 1 else "").lower()
        if code == "200" and ctype.startswith("image/") and dest.exists() \
                and dest.stat().st_size > 3000:
            return None
        if code in ("429", "503") and i < tries - 1:
            time.sleep(8 * (i + 1) ** 2); continue
        if i < tries - 1:
            time.sleep(1.5 * (i + 1)); continue
        if dest.exists(): dest.unlink()
        return f"HTTP {code} {ctype or ''}".strip()
    return "exhausted"

def encode(raw_path, out, thumb=None):
    """WebP, stepping quality then resolution, never below the quality floor."""
    for w, q in [(1280, 80), (1280, 74), (1280, QFLOOR), (1100, 74), (1000, 74), (900, 74)]:
        r = subprocess.run(["cwebp", "-quiet", "-q", str(q), "-resize", str(w), "0",
                            str(raw_path), "-o", str(out)],
                           capture_output=True)
        if r.returncode != 0: return False, r.stderr.decode()[:80]
        if out.stat().st_size <= CAP: break
    if thumb:
        subprocess.run(["cwebp", "-quiet", "-q", "72", "-resize", "420", "0",
                        str(raw_path), "-o", str(thumb)], capture_output=True)
    return True, None

def main():
    man = pathlib.Path(sys.argv[1]); site = pathlib.Path(sys.argv[2])
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 2

    out_dir = site / "img" / "cards";  out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = site.parent / "_rawcards"; raw_dir.mkdir(parents=True, exist_ok=True)

    rows = list(csv.DictReader(open(man, newline="", encoding="utf-8-sig")))
    if not rows: sys.exit("manifest is empty")
    h = list(rows[0].keys())
    C = {k: col(h, *v) for k, v in {
        "stack": ("stack", "stack_id", "id"),
        "card":  ("card", "card_n", "n", "index"),
        "url":   ("image_url", "url", "image"),
        "lic":   ("license", "licence"),
        "attr":  ("attribution_line", "attribution", "credit"),
        "tier":  ("license_tier", "tier"),
        "cap":   ("commons_title", "caption", "artwork", "description"),
        "src":   ("source_page", "source", "file_page"),
    }.items()}
    missing = [k for k in ("stack", "card", "url") if not C[k]]
    if missing: sys.exit(f"manifest lacks required columns {missing}; saw {h}")
    print("column mapping:", {k: v for k, v in C.items() if v})

    out_index, failures = {}, []
    jobs = []
    for r in rows:
        sid  = str(r[C["stack"]]).strip()
        card = str(r[C["card"]]).strip()
        url  = (r[C["url"]] or "").strip()
        if not url:
            failures.append((sid, card, "no url")); continue
        slot = f"c{sid.lower()}-{int(card):02d}" if card.isdigit() else f"c{sid.lower()}-{card}"
        jobs.append((sid, card, url, slot, r))
    if limit: jobs = jobs[:limit]

    done = {"n": 0, "hit": 0}
    def work(job):
        sid, card, url, slot, r = job
        webp = out_dir / f"{slot}.webp"
        raw  = raw_dir / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".img")
        if webp.exists() and webp.stat().st_size > 3000:
            done["hit"] += 1
            return (sid, card, slot, r, None)
        if not raw.exists() or raw.stat().st_size < 3000:
            err = fetch(url, raw)
            if err: return (sid, card, slot, r, err)
        ok, err = encode(raw, webp)
        if not ok: return (sid, card, slot, r, f"encode: {err}")
        done["n"] += 1
        if done["n"] % 40 == 0:
            print(f"  {done['n']} encoded, {len(failures)} failed", flush=True)
        return (sid, card, slot, r, None)

    # Wikimedia returns 429 well before you expect it. Two at a time with a
    # real backoff finishes sooner than five that spend the run being refused.
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for sid, card, slot, r, err in ex.map(work, jobs):
            if err:
                failures.append((sid, card, err)); continue
            out_index.setdefault(sid, {})[card] = {
                "img": slot,
                "cap": (r.get(C["cap"]) or "").strip() if C["cap"] else "",
                "lic": (r.get(C["lic"]) or "").strip() if C["lic"] else "",
                "tier": (r.get(C["tier"]) or "").strip() if C["tier"] else "",
                "attr": (r.get(C["attr"]) or "").strip() if C["attr"] else "",
                "src": (r.get(C["src"]) or "").strip() if C["src"] else "",
                "credit": (r.get("credit") or "").strip(),
            }
    fetched, skipped = done["n"], done["hit"]

    (site / "data" / "cardimages.json").write_text(
        json.dumps(out_index, ensure_ascii=False, separators=(",", ":")))
    print(f"\nrows in manifest : {len(rows)}")
    print(f"newly encoded    : {fetched}")
    print(f"already present  : {skipped}")
    print(f"failures         : {len(failures)}")
    for f in failures[:25]: print("   ", f)
    print(f"stacks covered   : {len(out_index)}")
    print(f"cards covered    : {sum(len(v) for v in out_index.values())}")

if __name__ == "__main__":
    main()
