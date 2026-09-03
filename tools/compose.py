#!/usr/bin/env python3
"""Build the flagship story's three pages, and keep the retired deck buildable.

Two jobs, and they used to be one.

1. The three SHIPPED pages — story.html, cleopatra.html, firststory.html.
   Cut from read.html: story 01 in the reader, on its ten museum plates, with
   its own canonical, its own share card, and the sign-up ask the old deck
   ended on. read.html is read, never written.

2. The RETIRED illustrated deck, composed from scenes/ as it always was, but
   written to build/ only — nothing under build/ is served. It is kept because
   it still builds and still passes its checks, and it is what to come back to
   if those scenes are ever redrawn on the real artwork.
     build/story.html          the page as it would ship
     build/artifact_story.html the Claude artifact preview: no <html>/<head>/
                               <body> wrapper, painting inlined, because a
                               relative path has nothing to resolve against.
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

BUILD = SITE / "build"; BUILD.mkdir(exist_ok=True)   # git-ignored

# --------------------------------------------------------------------------
# The illustrated deck is no longer served.
#
# /story, /cleopatra and /firststory were this page: CSS scenes and animation
# instead of the museum plates every other story is told on. It reads as a
# different product, and the decision is that the flagship is not shown that
# way unless the scenes are redrawn on the real artwork.
#
# The build is kept because it still runs and still passes its checks, and it
# is the thing to come back to if that ever happens. It writes to build/ only.
# Nothing under build/ is served.
# --------------------------------------------------------------------------
(BUILD / "story.html").write_text(site_page)
for _name, _canon in (("cleopatra.html", "/cleopatra"), ("firststory.html", "/firststory")):
    _t = re.sub(r'<link rel="canonical" href="https://factbox\.app/[^"]*">',
                f'<link rel="canonical" href="https://factbox.app{_canon}">', site_page)
    _t = re.sub(r'<meta property="og:url" content="https://factbox\.app/[^"]*">',
                f'<meta property="og:url" content="https://factbox.app{_canon}">', _t)
    (BUILD / _name).write_text(_t)
(BUILD / "artifact_story.html").write_text(art_page)

# ==========================================================================
# What /story, /cleopatra and /firststory actually serve now.
#
# Three real pages, not redirect stubs: /story is already out in the world,
# /cleopatra is the one that goes in a bio, /firststory is the generic alias.
# A stub that shadows a real page is what broke sign-in, and SPEC.md 2.4
# forbids it, so 404ing or redirecting these was never on the table.
#
# They are read.html — story 01 in the reader, on its ten museum plates —
# with four differences, all of them applied here rather than in read.html,
# which this build must not touch:
#
#   1. window.FB_STORY carries the story id, because these paths have no ?s=.
#   2. Their own canonical and og:url, one per path. Three URLs serving one
#      story is deliberate; three URLs claiming to be canonical is not.
#   3. The share card the flagship has always had — title, description and
#      /img/share.jpg — and no robots:noindex, which read.html carries and
#      these three must not: they are the pages people are sent to.
#   4. The sign-up ask at the foot of the deck. The retired deck ended on
#      one, it is why these URLs exist, and read.html's own end panel is a
#      recommendation rather than an ask.
#
# Everything else about the reader — the paywall, the gate, the audio rail,
# progress, recommendations — is read.html's, unmodified and unforked.
# ==========================================================================
READER = (SITE / "read.html").read_text()
STORY_ID = "01"

TITLE = "How did Cleopatra die? — Factbox"
OGTITLE = "How did Cleopatra die?"
OGDESC = ("The snake is in every painting of her, and nobody has ever found it. "
          "A three-minute history story, every card sourced.")
OGALT = ("An old-master painting of Cleopatra with an asp, beside the words "
         "“How did Cleopatra die?”")

if READER.count("<head>") != 1 or READER.count("</body>") != 1:
    raise SystemExit(
        "BUILD FAILED — read.html no longer has exactly one <head> and one\n"
        "  </body>. The three story pages are cut from it and the injection\n"
        "  points are gone. Fix this file before shipping, or /cleopatra —\n"
        "  the URL in the bio — ships as whatever this produced last.")

# read.html reads the story id off the query string. These three paths carry
# no query string, so the ternary falls back to window.FB_STORY. Patched here,
# on a copy, so read.html itself keeps exactly one way of knowing what to draw.
_ID_RE = re.compile(r'(var id\s*=\s*m\s*\?[^;]*?)\s*:\s*""\s*;')
READER, _n_id = _ID_RE.subn(r'\1\n             : String(window.FB_STORY || "");', READER)
if _n_id != 1:
    raise SystemExit(
        "BUILD FAILED — could not find read.html's `var id = m ? ... : \"\";`\n"
        f"  line ({_n_id} matches, expected 1). Without the fallback these\n"
        "  three pages have no story id and render “that story is not in\n"
        "  this season”, which is a wordless page by another name.")

# The two head preloads bail out when there is no ?s=, which would cost these
# pages the first plate and the story JSON on a cold load. Best effort: if the
# shape changes the pages still work, they are just a round trip slower.
READER, _n_pre = re.subn(r'\.exec\(location\.search \|\| ""\)',
                         '.exec(location.search || "?s=" + (window.FB_STORY || ""))',
                         READER)

_HEAD = """<!-- ======================================================================
     GENERATED by tools/compose.py from read.html. Do not edit this file:
     the next compose silently discards anything written here.

     This path is one of the flagship's three public URLs. It used to be the
     composed page of CSS scenes in scenes/; it is now story {sid} in the
     reader, on the same museum plates as every other story. Real page, not
     a redirect stub (SPEC.md 2.4).
     ====================================================================== -->
<script>window.FB_STORY = "{sid}";</script>
<link rel="canonical" href="https://factbox.app{canon}">
<meta name="description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Factbox">
<meta property="og:title" content="{ogtitle}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="https://factbox.app{canon}">
<meta property="og:image" content="https://factbox.app/img/share.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{ogalt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{ogtitle}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="https://factbox.app/img/share.jpg">
<meta name="twitter:image:alt" content="{ogalt}">
"""

# The ask. ES5, guarded, and it adds nothing until a real card is on screen —
# a story that failed to load must not be followed by a sign-up pitch.
#
# It keeps itself the last child of the deck because read.html appends its
# recommendation panel late, after data/index.json lands. The observer and the
# poll are belt and braces: either alone is enough, and neither can run away
# because the reposition is a no-op once the pane is already last.
_ASK = """
<!-- The sign-up ask the retired deck ended on. Its button goes where that
     one went: FB.checkout(, "story") -> /join?from=story. -->
<script>
(function () {
  "use strict";
  var deck = document.getElementById("deck");
  if (!deck) return;
  var pane = null, ticks = 0, mo = null;

  function build() {
    var s = document.createElement("section");
    s.className = "pane endask";
    s.innerHTML =
      '<h2>Come read more stories.</h2>' +
      '<p>Fifty more, sourced the same way. Cleopatra, the Bible, Rome, and ' +
      'the people we have flattened into statues.</p>' +
      '<button class="go" id="endask-go" type="button">Read the rest of ' +
      'season one</button>' +
      '<p class="fine">Sign up first &mdash; three days free before anything ' +
      'is charged.</p>' +
      '<a class="ghost" href="/stories">See what is inside first</a>' +
      '<p class="fine">Already have an account? ' +
      '<a href="/login?next=%2Fstories">Sign in</a></p>';
    var b = s.querySelector("#endask-go");
    if (b) {
      b.addEventListener("click", function () {
        try {
          if (window.FB && typeof FB.checkout === "function") {
            FB.checkout(b, "story");
            return;
          }
        } catch (e) {}
        location.href = "/join?from=story";
      }, false);
    }
    return s;
  }

  /* Only after the story is on the screen, and always last. */
  function place() {
    try {
      if (!deck.querySelector(".beat")) return;
      if (!pane) pane = build();
      var last = deck.lastElementChild || deck.lastChild;
      if (last !== pane) deck.appendChild(pane);
    } catch (e) {}
  }

  try {
    if (window.MutationObserver) {
      mo = new MutationObserver(place);
      mo.observe(deck, { childList: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 40000);
    }
  } catch (e) {}

  (function tick() {
    place();
    ticks++;
    if (ticks < 60) setTimeout(tick, 300);
  })();
})();
</script>
"""

_written = []
for _name, _canon in (("story.html", "/story"),
                      ("cleopatra.html", "/cleopatra"),
                      ("firststory.html", "/firststory")):
    _p = READER
    _p = _p.replace("<head>",
                    "<head>\n" + _HEAD.format(sid=STORY_ID, canon=_canon,
                                              desc=OGDESC, ogtitle=OGTITLE,
                                              ogalt=OGALT).rstrip("\n"), 1)
    _p = _p.replace("<title>Factbox</title>", f"<title>{TITLE}</title>", 1)
    # These are the pages people are sent to. read.html is not.
    _p = _p.replace('<meta name="robots" content="noindex">\n', "", 1)
    _p = _p.replace("</body>", _ASK.strip("\n") + "\n</body>", 1)
    _p = cleanlinks(rootify(_p))
    check_ids(_p, _name)
    (SITE / _name).write_text(_p)
    _written.append((_name, _p))

# The one rule: never ship a page that renders empty. This is the cheap half —
# the page must still contain the things the reader is built out of. The other
# half is tools/check-page.js, which runs it in a DOM.
for _name, _p in _written:
    for _need in ('id="deck"', 'src="/js/gate.js"', 'window.FB_STORY',
                  '<link rel="canonical"', 'og:url', 'endask-go',
                  "/join?from=story"):
        if _need not in _p:
            raise SystemExit(f"BUILD FAILED — {_name} is missing {_need!r}.")
    if 'content="noindex"' in _p:
        raise SystemExit(f"BUILD FAILED — {_name} still says noindex; it is a "
                         "page people are sent to.")

print(f"id lookups verified            : {', '.join(looked_up)}")
print(f"painting placeholders replaced : {n_plate}")
print(f"scene files                    : {', '.join(SCENE_FILES)}")
print(f"scene blocks found             : {len(re.findall(r'class=.scene s-', page))}")
print(f"read.html patches              : id fallback {_n_id}, preload {_n_pre}")
for name, txt in (("build/story.html", site_page),
                  ("build/artifact_story.html", art_page)):
    print(f"{name:30s} {len(txt)//1024}KB")
_CANON_RE = re.compile(r'<link rel="canonical" href="([^"]+)">')
for name, txt in _written:
    _c = _CANON_RE.search(txt)
    print(f"{name:30s} {len(txt)//1024}KB  canonical -> {_c.group(1) if _c else '??'}")
missing = [c for c in ("s-door", "s-painting", "s-fleet", "s-afternoon",
                       "s-scroll", "s-coil", "s-basket", "s-pharos")
           if f"s-{c.split('s-')[-1]}" not in page]
print("missing scenes:", missing or "none")
