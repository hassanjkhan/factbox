#!/usr/bin/env python3
"""Stamp every local script and stylesheet URL with a hash of its contents.

    <script src="/js/recommend.js">  ->  <script src="/js/recommend.js?v=ab12cd34">

WHY THIS EXISTS
---------------
GitHub Pages serves /js and /css with `cache-control: max-age=600` and an
ETag, and neither of those helps here. Inside that window a browser has no
reason to revalidate at all, and in practice Chrome held the files far longer
across a tab session. Nothing in the repo ever changed the URL, so a deploy
that changed the funnel changed nothing a returning browser could see: the
owner's incognito window showed the new page, his normal profile ran the old
scripts, and the funnel was reported as "not shipped" three times before
anyone thought to look at the cache. The URL is the only cache key a static
host gives us, so the URL is what has to move.

WHY A CONTENT HASH AND NOT A BUILD NUMBER
-----------------------------------------
A single build id — ?v=2026-09-07, or a commit sha — is one line of code and
is wrong for this site. It changes on EVERY deploy, which expires every asset
on every deploy, for every returning reader, whether or not a byte of it
changed. tools/README.md notes the 100GB/month soft limit on Pages, and the
audio and the paintings are the bulk of that budget; spending it re-sending
byte-identical JavaScript to people who already have it is the kind of cost
that only shows up as a bill. A hash of the file's own bytes means the URL of
an unchanged file does not move, so it stays cached, and the URL of a changed
file always moves, so it cannot be stale. Those are exactly the two properties
we want, and a build id has neither.

WHAT IT WILL AND WILL NOT TOUCH
-------------------------------
Only root-relative /js/*.js and /css/*.css, in src= and href=. Deliberately
NOT:

  * anything on another origin — fonts.googleapis.com serves a stylesheet
    whose URL we do not own and whose query string means something to Google.
  * data: URIs — there is no file to hash and no cache to bust.
  * images, audio and JSON. img/cards/*.webp and audio/*.mp3 are already
    content-addressed by NAME: a new plate is a new filename. Stamping them
    would add no correctness and would be the one change capable of invalidating
    the megabytes rather than the kilobytes.
  * relative paths (`js/analytics.js`). The site is served on clean URLs, so a
    relative asset path is a bug of its own; tools/cleanurls.py is what fixes
    those, and silently stamping one here would hide it.

USAGE
-----
    python3 tools/stamp-assets.py                # stamp every shipped page
    python3 tools/stamp-assets.py a.html b.html  # stamp just these
    python3 tools/stamp-assets.py --check        # report staleness, write
                                                 # nothing, exit 1 if stale

It is idempotent: any existing ?v= is stripped before the current hash is
applied, so running it twice in a row produces a byte-identical file, and it
is safe to run at any point in a build.
"""
import hashlib, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent   # the site itself

# Every page that is SERVED. Enumerated rather than globbed: a glob would pick
# up whatever HTML happens to be lying at the root, and the composed pages are
# stamped by tools/compose.py itself (see MANAGED_BY_COMPOSE below) — stamping
# them from here as a second pass is what makes precommit.sh's section 4 fail
# forever, because compose would then keep rewriting the file it just read.
#
# read.html IS in this list. It carries noindex, but it is served — it is what
# /read?s=NN renders, which is 50 of the site's 51 stories.
MANAGED_BY_COMPOSE = ["story.html", "cleopatra.html", "firststory.html"]

PAGES = [
    "index.html", "explore.html", "read.html", "library.html", "stories.html",
    "join.html", "login.html", "account.html", "settings.html",
    "subscription.html", "unlock.html", "start.html", "support.html",
    "credits.html", "terms.html", "privacy.html",
    "admin/dashboard.html",
    "admin/index.html",
    "admin/tasks.html",
    "admin/experiments.html",
]

# src="/js/x.js" or href="/css/x.css", with or without a stamp already on it.
#
# The leading "/" is required and is load-bearing twice over: it excludes
# relative paths, and it excludes protocol-relative "//fonts.googleapis.com/"
# URLs, which would otherwise match the second slash. The quote character is
# captured and required to match at the end, so an attribute is never closed
# with the wrong one.
ASSET = re.compile(
    r'((?:src|href)\s*=\s*)'          # 1: the attribute and its =
    r'(["\'])'                        # 2: the opening quote
    r'(/(?:js|css)/[A-Za-z0-9._-]+\.(?:js|css))'   # 3: the path, no query
    r'(\?v=[0-9a-fA-F]+)?'            # 4: a stamp from a previous run
    r'\2'                             # the same quote again
)

# ---------------------------------------------------------------------------
# Scripts that are INJECTED at runtime rather than written into a page.
#
# Two files load a sibling by building a <script> element and setting .src:
#
#   js/progress.js  -> /js/progress-sync.js   (the reading-progress mirror)
#   js/account.js   -> /js/profile-sync.js    (the account mirror)
#
# Both are deliberate — appending once from the file that needs them means
# they cannot be forgotten on a page that carries the parent, and cannot be
# added twice. But it also means the URL appears in NO HTML, so the regex
# above never saw it, and js/progress-sync.js was the one asset on the whole
# site still able to go stale: every <script src> moved on deploy while that
# one kept serving out of cache for Pages' full max-age=600. A cache bug in
# the file that syncs reading position across devices is exactly the kind
# that gets reported as "it lost my place" and reproduces for nobody.
#
# So the same stamp is applied to the string LITERAL in the injecting file.
#
# It is opt-in per literal, by a trailing `/* stamped */` marker, and that is
# not decoration. "Any string in this file that looks like /js/*.js" is the
# obvious rule and it is wrong twice over in js/account.js alone, which spells
# the markup it is standing in for inside a doc comment:
#
#       <script src="/js/account.js"></script>
#       <script src="/js/profile-sync.js"></script>
#
# Stamping prose would be merely wrong; stamping THAT prose does not even
# terminate, because writing account.js's hash into account.js changes
# account.js's bytes, which changes its hash. A --check gate built on it would
# fail forever and no edit could make it pass. The marker means the tool
# rewrites only what someone deliberately marked, and a reader of the line can
# see that it is rewritten.
#
# Order matters and is handled in main(): these are stamped BEFORE the pages,
# because stamping js/progress.js changes js/progress.js, which changes the
# hash every page's <script src="/js/progress.js"> has to carry.
INJECTORS = ["js/progress.js", "js/account.js"]

JS_ASSET = re.compile(
    r'(["\'])'                                     # 1: the opening quote
    r'(/(?:js|css)/[A-Za-z0-9._-]+\.(?:js|css))'   # 2: the path, no query
    r'(\?v=[0-9a-fA-F]+)?'                         # 3: a previous stamp
    r'\1'                                          # the same quote again
    r'(\s*;?[ \t]*/\*\s*stamped\s*\*/)'            # 4: the opt-in marker
)


def asset_hash(path: pathlib.Path) -> str:
    """First 8 hex of a sha256 of the file's bytes.

    Bytes, not text: a stamp that depended on this machine's default encoding
    or on line endings would differ between two checkouts of the same commit,
    which turns the precommit gate into a coin toss.

    Eight hex is 4 billion values for ~40 files. A collision would have to be
    between two versions of the SAME file to matter at all, and the cost of
    one would be one stale asset until the next edit — traded against a
    shorter, readable URL.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def stamp_text(html: str, root: pathlib.Path = ROOT):
    """Return (stamped_html, warnings). Pure: reads assets, writes nothing."""
    warnings = []
    seen = {}

    def one(m):
        attr, quote, path = m.group(1), m.group(2), m.group(3)
        f = root / path.lstrip("/")
        if not f.is_file():
            # A URL we cannot hash. Leave it EXACTLY as written — including
            # any stamp a previous run put on it — and say so. A missing asset
            # is a real problem, but it is not this tool's problem to decide
            # about: failing the build here would mean a typo in one page's
            # script tag blocks every deploy, and stamping a hash of nothing
            # would invent a URL that is guaranteed to 404.
            warnings.append(path)
            return m.group(0)
        if path not in seen:
            seen[path] = asset_hash(f)
        # Note that m.group(4), any previous ?v=, is simply not carried over.
        # That is the whole of the idempotence: the output depends only on the
        # path and on the bytes on disk, never on what the input said.
        return f'{attr}{quote}{path}?v={seen[path]}{quote}'

    return ASSET.sub(one, html), warnings


def stamp_js_text(src: str, root: pathlib.Path = ROOT):
    """Stamp the marked asset literals in a JS file. Returns (text, warnings).

    Same contract as stamp_text: pure, idempotent, and any previous ?v= is
    discarded rather than carried, so the output depends only on the path and
    on the bytes on disk.
    """
    warnings = []
    seen = {}

    def one(m):
        quote, path, marker = m.group(1), m.group(2), m.group(4)
        f = root / path.lstrip("/")
        if not f.is_file():
            warnings.append(path)
            return m.group(0)
        if path not in seen:
            seen[path] = asset_hash(f)
        return f'{quote}{path}?v={seen[path]}{quote}{marker}'

    return JS_ASSET.sub(one, src), warnings


def stamp_js_file(path: pathlib.Path, write: bool = True):
    """Stamp one injecting JS file in place. Returns (changed, warnings)."""
    before = path.read_text()
    after, warnings = stamp_js_text(before, ROOT)
    changed = after != before
    if changed and write:
        path.write_text(after)
    return changed, warnings


def unstamp_text(html: str) -> str:
    """Strip every stamp, leaving the bare URLs.

    tools/compose.py needs this. It cuts three shipped pages out of read.html,
    which is itself stamped, and its build gates search that copy for the
    literal `src="/js/gate.js"` — a page that lost its gate script still
    renders, as a paywall with no paywall. Normalising the input means those
    gates keep looking for what they were written to look for, and means the
    composed output is the same whatever stamp state read.html was left in.
    """
    return ASSET.sub(lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}{m.group(2)}',
                     html)


def stamp_file(path: pathlib.Path, write: bool = True):
    """Stamp one file in place. Returns (changed, warnings)."""
    before = path.read_text()
    after, warnings = stamp_text(before, ROOT)
    changed = after != before
    if changed and write:
        path.write_text(after)
    return changed, warnings


def main(argv):
    check = "--check" in argv
    names = [a for a in argv if not a.startswith("-")]

    if names:
        targets = [pathlib.Path(n) if pathlib.Path(n).is_absolute()
                   else ROOT / n for n in names]
    else:
        targets = [ROOT / p for p in PAGES]

    stale, missing, done = [], [], 0

    # The injecting JS files first, and only on a whole-site run. Stamping one
    # of them REWRITES it, which moves its own hash, so the pages that load it
    # have to be stamped afterwards in the same pass or the run leaves the site
    # inconsistent and --check disagrees with the run that just happened.
    # Explicitly-named targets are left alone: `stamp-assets.py one.html` means
    # that file, and quietly rewriting two JS files as well would be a side
    # effect nobody asked for.
    if not names:
        for rel in INJECTORS:
            p = ROOT / rel
            if not p.is_file():
                print(f"  no such injector: {rel}")
                return 2
            changed, warnings = stamp_js_file(p, write=not check)
            for w in warnings:
                missing.append(f"{rel}: {w}")
            if changed:
                stale.append(rel)
            done += 1

    for t in targets:
        if not t.is_file():
            print(f"  no such page: {t}")
            return 2
        changed, warnings = stamp_file(t, write=not check)
        try:
            rel = t.resolve().relative_to(ROOT)
        except ValueError:
            rel = t
        for w in warnings:
            missing.append(f"{rel}: {w}")
        if changed:
            stale.append(str(rel))
        done += 1

    for line in sorted(set(missing)):
        print(f"  WARNING no such asset on disk, left unstamped — {line}")

    if check:
        if stale:
            print(f"  {len(stale)} page(s) carry an out-of-date stamp: "
                  + ", ".join(stale))
            return 1
        print(f"  {done} pages stamped and current")
        return 0

    if stale:
        print(f"  restamped {len(stale)} of {done}: " + ", ".join(stale))
    else:
        print(f"  {done} pages already current")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
