#!/usr/bin/env python3
"""Compose the three agents' files into one page.

Two outputs, same content:
  story.html   — for GitHub Pages. Painting stays an external <img>, which is
                 the whole point: the HTML lands in a few KB and the picture
                 arrives lazily. Every visitor is on a phone on cellular.
  artifact.html— for the Claude artifact preview. No <html>/<head>/<body>
                 wrapper (the publisher supplies one) and the painting inlined,
                 because a relative path has nothing to resolve against there.
"""
import base64, pathlib, re, sys

# The site serves clean URLs (/explore, not /explore.html), which means every
# asset path has to be root-relative — a relative one resolves differently from
# inside /explore/ than from /. This page is regenerated, so without applying
# the same rewrite here the next compose silently undoes the migration.
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cleanurls import rootify, cleanlinks

HERE = pathlib.Path(__file__).parent      # tools/
SITE = HERE.parent                        # the repo root: the site itself
S    = SITE / "scenes"                    # the flagship story's source

shell_html = (S / "shell.html").read_text()
SCENE_FILES = [f for f in ("a", "b", "c", "d", "e") if (S / f"{f}.css").exists()]
css = "\n".join((S / "shell.css").read_text()
                + "\n" for _ in [0]) + "\n".join(
      (S / f"{f}.css").read_text() for f in SCENE_FILES) + "\n" + (S / "audio.css").read_text()
js  = (S / "shell.js").read_text() + "\n" + (S / "audio.js").read_text()
scenes_html = "\n".join((S / f"{f}.html").read_text() for f in SCENE_FILES)

# --------------------------------------------------------------------------
# Build gate: no element lookup may reference an id the page does not contain.
#
# This exists because a `getElementById("wl").addEventListener(...)` was left
# behind when the waitlist was replaced by the shelf. It threw at top level,
# before the IntersectionObserver ran, so the deck was already built but no
# page ever got `.live` — and captions are opacity:0 until it lands. The page
# looked like a finished scene with no words on it, and every automated check
# still passed: the HTML was valid, the JS parsed, every URL returned 200.
# Only a human opening it on a phone caught it. So the check runs at build.
# --------------------------------------------------------------------------
def check_ids(page, label):
    ids = set(re.findall(r'\bid=["\']([A-Za-z0-9_-]+)["\']', page))
    js_blocks = re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', page, re.S)
    js = max(js_blocks, key=len) if js_blocks else ""
    # ids the script creates itself, inside template and quoted strings
    ids |= set(re.findall(r'id=\\?["\']([A-Za-z0-9_-]+)\\?["\']', js))
    used = set(re.findall(r'getElementById\(\s*["\']([A-Za-z0-9_-]+)["\']\s*\)', js))
    orphans = sorted(used - ids)
    if orphans:
        raise SystemExit(
            f"BUILD FAILED — {label} looks up ids that do not exist: {orphans}\n"
            f"  A null from getElementById throws at top level and stops the\n"
            f"  script before .live is set, which renders the deck wordless.")
    return sorted(used)


page = shell_html
page = page.replace("<!-- COMPOSE:SCENES-A -->", scenes_html)
page = page.replace("<!-- COMPOSE:SCENES-B -->", "")

# Replace the three dev stylesheet links with one inlined block.
page = re.sub(r'<link rel="stylesheet" href="(shell|a|b)\.css">\s*', "", page)
page = page.replace("<!-- COMPOSE:CSS", f"<style>\n{css}\n</style>\n<!-- css inlined; original note:")
page = page.replace('<script src="shell.js"></script>',
                    f"<script>\n{js}\n</script>\n"
                    '<script src="js/analytics.js"></script>')

# The painting. The scene agent leaves a placeholder src; point it at the file.
n_plate = len(re.findall(r'__PAINTING__', page))
site_page = page.replace("__PAINTING__", "img/tapestry.jpg")

art_page = page.replace(
    "__PAINTING__",
    "data:image/jpeg;base64," +
    base64.b64encode((SITE / "img" / "tapestry.jpg").read_bytes()).decode())
# The artifact publisher wraps the file itself.
art_page = re.sub(r'<!doctype html>\s*|<html[^>]*>\s*|</html>\s*', "", art_page, flags=re.I)

looked_up = check_ids(site_page, "story.html")
site_page = cleanlinks(rootify(site_page))

# THIS NO LONGER WRITES TO THE SITE.
#
# /story, /cleopatra and /firststory used to be this composed page: CSS scenes
# and animation instead of the museum plates every other story is told on. It
# reads as a different product, and the decision is that the flagship is not
# shown that way unless it is carrying the real paintings.
#
# Those three URLs are still real pages — /story is already out in the world
# and /cleopatra is the one in the bio, so 404ing them was never an option and
# SPEC.md 2.4 forbids a redirect stub. They are built from read.html now, with
# window.FB_STORY set to "01", and they show the reader on ten real plates.
#
# The build is kept because it still runs, still passes its checks, and is the
# thing to come back to if the scenes are ever redrawn on the artwork. It
# writes to build/ only. Nothing under build/ is served.
(BUILD_EARLY := SITE / "build").mkdir(exist_ok=True)
(BUILD_EARLY / "story.html").write_text(site_page)
for _name, _canon in (("cleopatra.html", "/cleopatra"), ("firststory.html", "/firststory")):
    _t = re.sub(r'<link rel="canonical" href="https://factbox\.app/[^"]*">',
                f'<link rel="canonical" href="https://factbox.app{_canon}">', site_page)
    _t = re.sub(r'<meta property="og:url" content="https://factbox\.app/[^"]*">',
                f'<meta property="og:url" content="https://factbox.app{_canon}">', _t)
    (BUILD_EARLY / _name).write_text(_t)
# The front page is the shelf now, not the story: someone arriving cold from a
# search sees fifty-one covers, and the story is the thing you link to.

BUILD = SITE / "build"; BUILD.mkdir(exist_ok=True)   # git-ignored
(BUILD / "artifact_story.html").write_text(art_page)

print(f"id lookups verified            : {', '.join(looked_up)}")
print(f"painting placeholders replaced : {n_plate}")
print(f"scene files                    : {', '.join(SCENE_FILES)}")
print(f"scene blocks found             : {len(re.findall(r'class=.scene s-', page))}")
for name, txt in (("build/story.html", site_page), ("build/artifact_story.html", art_page)):
    print(f"{name:22s} {len(txt)//1024}KB")
missing = [c for c in ("s-door", "s-painting", "s-fleet", "s-afternoon",
                       "s-scroll", "s-coil", "s-basket", "s-pharos")
           if f"s-{c.split('s-')[-1]}" not in page]
print("missing scenes:", missing or "none")
