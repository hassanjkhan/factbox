#!/usr/bin/env python3
"""Build data/index.json — the browse-sized copy of the season.

data/stacks.json is 413KB because it carries every card of all fifty-one
stories. Four pages need none of that: the home page, Explore, the library and
the opening of signup draw covers, titles, hooks, card counts and runtimes.
They were each downloading the whole season to read a dozen fields per story.

This writes the same records without the card bodies — 16KB, 96% smaller — and
keeps `cards` as an array of the right length, because the browse code counts
it and guards on it being there.

Run it whenever data/stacks.json changes. gate.js falls back to the full file
if this one is missing, so a stale or absent index degrades to slow, never to
wrong.
"""
import json, pathlib

ROOT = pathlib.Path(__file__).parent.parent
KEEP = ("id", "title", "hook", "img", "topic", "kind", "secs", "free", "words")

src = json.loads((ROOT / "data" / "stacks.json").read_text(encoding="utf-8"))
out = []
for s in src["stacks"]:
    rec = {k: s[k] for k in KEEP if k in s}
    rec["cards"] = [{} for _ in (s.get("cards") or [])]
    out.append(rec)

body = json.dumps({"version": 1, "stacks": out},
                  ensure_ascii=False, separators=(",", ":"))
(ROOT / "data" / "index.json").write_text(body, encoding="utf-8")

full = (ROOT / "data" / "stacks.json").stat().st_size
print("index.json  %d stories  %.1fKB  (stacks.json %.1fKB, %d%% smaller)"
      % (len(out), len(body.encode()) / 1024, full / 1024,
         100 * (full - len(body.encode())) / full))
