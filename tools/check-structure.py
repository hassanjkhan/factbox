#!/usr/bin/env python3
"""Structural integrity of every page. Run before every push.

This exists because of a specific failure, and the failure is worth writing
down, because every other check in here missed it.

A script was removing an inline <script> block from nine pages. It located the
block by searching for prose in the COMMENT above it, then walked backwards to
the nearest "<script" — which was the previous script tag, further up the page.
The cut therefore took everything in between: six <link rel="preload"> tags,
and the opening "<!--" of a comment whose "-->" was left behind.

An unterminated comment does not fail. The browser swallows everything to the
next "-->" it can find, which on that page was most of the document. The page
rendered nothing at all. And:

  * the HTML "validated" — nothing here is malformed, only differently nested
  * node --check passed — the JavaScript was never reached to be parsed
  * the URL returned 200
  * check-page.js reported "script errors: none", because from the parser's
    point of view there was no script; it then reported zero cards, which read
    like a data problem rather than a structural one
  * the diff looked plausible: a block of lines removed by a script that was
    supposed to remove a block of lines

So the check is: count the things that must balance. It is crude on purpose —
a real parser would be more correct and would not have caught this any faster.

Usage:
    python3 tools/check-structure.py            # audit every page
    python3 tools/check-structure.py --save     # record the current counts
                                                # as the baseline to compare to
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = pathlib.Path(__file__).parent / "structure-baseline.json"

# Composed by tools/compose.py from scenes/, which supplies its own wrapper —
# these legitimately do not carry a <head> of their own.
COMPOSED = {"story.html", "cleopatra.html", "firststory.html"}


import re

def counts(text):
    """Comment delimiters are counted on the raw text; everything else is
    counted with comments stripped out.

    Prose inside a comment mentions tags — this file's own preload comment says
    "a <script> the parser reaches partway down" and "these links are in the
    <head>" — and counting those made the checker report two faults on a page
    that was perfectly sound. A checker that cries wolf gets switched off,
    which would be a worse outcome than not having written it."""
    stripped = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return {
        "comment_open":  text.count("<!--"),
        "comment_close": text.count("-->"),
        "body_open":     stripped.count("<body"),
        "body_close":    stripped.count("</body>"),
        "head_open":     stripped.count("<head>"),
        "head_close":    stripped.count("</head>"),
        "nav":           stripped.count('<nav class="tabs"'),
        "preload":       stripped.count('rel="preload"'),
        "script_open":   stripped.count("<script"),
        "script_close":  stripped.count("</script>"),
    }


def main():
    save = "--save" in sys.argv
    baseline = json.loads(BASE.read_text()) if BASE.exists() else {}
    now, failures = {}, []

    for path in sorted(ROOT.glob("*.html")):
        f = path.name
        c = counts(path.read_text())
        now[f] = c

        # Things that must balance in any HTML file, composed or not.
        if c["comment_open"] != c["comment_close"]:
            failures.append(f'{f}: {c["comment_open"]} "<!--" but {c["comment_close"]} "-->" — '
                            f"an unterminated comment hides everything after it")
        if c["script_open"] != c["script_close"]:
            failures.append(f'{f}: {c["script_open"]} <script but {c["script_close"]} </script>')

        if f not in COMPOSED:
            if c["body_open"] != 1 or c["body_close"] != 1:
                failures.append(f'{f}: {c["body_open"]} <body> / {c["body_close"]} </body> — expected one of each')
            if c["head_open"] != c["head_close"]:
                failures.append(f'{f}: {c["head_open"]} <head> / {c["head_close"]} </head>')
            if c["nav"] > 1:
                failures.append(f'{f}: {c["nav"]} navigation bars — the page has been duplicated')

        # Preloads are what the last accident silently deleted, and losing one
        # costs about a second on a cold load while breaking nothing visible.
        was = baseline.get(f, {}).get("preload")
        if was is not None and c["preload"] < was:
            failures.append(f'{f}: preload links dropped from {was} to {c["preload"]}')

    if save:
        BASE.write_text(json.dumps(now, indent=2, sort_keys=True) + "\n")
        print(f"baseline written for {len(now)} pages")
        return 0

    for line in failures:
        print("FAIL  " + line)
    print(f"\n{len(now)} pages checked, {len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
