#!/usr/bin/env python3
"""Turn page.html into page/index.html so the site has real URLs.

GitHub Pages has no rewrite rules, so /explore can only work if there is an
explore/index.html behind it. That means three edits, and the second is the one
that silently breaks everything if you forget it:

  1. move the file
  2. make every asset path root-relative — `css/app.css` means something
     different from inside /explore/ than from /, and this applies to the
     shared scripts too, which are loaded from every depth. Missing them is
     exactly how the first attempt broke three pages: `fetch("data/stacks.json")`
     inside js/gate.js became /stories/data/stacks.json and 404'd.
  3. rewrite internal links to the clean form

Old .html paths stay as redirect stubs. Links to /story.html are already shared
and a launch is a bad time to break the URL people are pasting.
"""
import pathlib, re, sys

# index.html and story.html are the front door and keep their names.
#
# "stories" is NOT in this list, and must not be put back.
#
# /stories is deprecated — every internal link now goes to /explore — but
# stories.html is still a live landing page: Stripe's three Payment Links send
# every buyer to /stories.html?unlocked=1&session_id=..., and the restore links
# already in buyers' inboxes point at the same file. It is a forwarder that
# hands that query string on to /explore.
#
# Moving it would break both. `stub()` below overwrites the source file with a
# fixed redirect that carries no query string of its own, so applying this to
# "stories" would replace the forwarder with something that drops session_id
# and never unlocks the buyer. It would also shadow the real page the way the
# login stub did (SPEC.md 2.4): GitHub Pages resolves /stories to stories.html
# before stories/index.html.
PAGES = ["explore", "library", "read", "join", "credits",
         "unlock", "privacy", "terms", "support", "login", "account",
         "settings", "subscription"]
ASSET_DIRS = ["css", "js", "img", "data", "audio", "tools"]


def rootify(html: str) -> str:
    """Relative asset paths -> root-relative."""
    for d in ASSET_DIRS:
        html = re.sub(r'((?:src|href)\s*=\s*["\'])' + d + r'/', r'\1/' + d + '/', html)
        html = re.sub(r'(["\'])' + d + r'/', r'\1/' + d + '/', html)
    return html


def cleanlinks(html: str) -> str:
    """page.html -> /page, keeping any query string."""
    for p in PAGES:
        html = re.sub(r'(["\'(])' + p + r'\.html(\?)', r'\1/' + p + r'\2', html)
        html = re.sub(r'(["\'(])' + p + r'\.html(["\')])', r'\1/' + p + r'\2', html)
    html = re.sub(r'(["\'(])story\.html(["\')])', r'\1/story\2', html)
    html = re.sub(r'(["\'(])index\.html(["\')])', r'\1/\2', html)
    return html


def stub(target: str) -> str:
    """The old .html path, forwarding to the clean URL.

    SPEC.md 2.4 names the previous version of this function as the bug: a page
    reading "Moved to /login" and nothing else, which then shadowed the real
    /login. So this keeps a heading, a sentence and a link a reader can tap,
    and the script carries the query string and hash across — an old link with
    ?restore= or ?unlocked= has to arrive intact or the reader is not unlocked.

    The script runs before the stylesheet link for the same reason it does in
    stories.html: an inline script after a <link rel="stylesheet"> waits for
    that sheet to load.
    """
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Factbox &middot; This page moved</title>'
            f'<link rel="canonical" href="https://factbox.app{target}">'
            f'<script>location.replace("{target}"+location.search+location.hash)</script>'
            f'<link rel="stylesheet" href="/css/app.css">'
            f'</head><body><main class="lib"><header class="mast">'
            f'<p class="mark">FACTBOX</p>'
            f'<h1>This page moved to {target}.</h1>'
            f'<p>Taking you there now. If nothing happens, tap the link below.</p>'
            f'</header><p style="margin-top:26px">'
            f'<a class="go" href="{target}" style="display:inline-block;'
            f'text-decoration:none">Go to {target}</a></p></main>'
            f'<script src="/js/analytics.js"></script>'
            f'</body></html>\n')


def main():
    site = pathlib.Path(sys.argv[1])
    dry = "--apply" not in sys.argv
    moved, patched = [], []

    for p in PAGES:
        src = site / f"{p}.html"
        if not src.exists():
            continue
        html = cleanlinks(rootify(src.read_text()))
        dest = site / p / "index.html"
        if not dry:
            dest.parent.mkdir(exist_ok=True)
            dest.write_text(html)
            src.write_text(stub(f"/{p}"))
        moved.append(p)

    # The shared scripts load from every depth, so their relative paths are
    # ambiguous in a way they never were when every page sat at the root.
    for q in sorted((site / "js").glob("*.js")):
        js = q.read_text()
        fixed = cleanlinks(rootify(js))
        if fixed != js:
            if not dry:
                q.write_text(fixed)
            patched.append("js/" + q.name)

    # The two pages that stay at the root still need their links rewritten.
    for f in ("index.html", "story.html"):
        q = site / f
        if q.exists():
            html = cleanlinks(rootify(q.read_text()))
            if not dry:
                q.write_text(html)
            patched.append(f)

    print(("DRY RUN — " if dry else "APPLIED — ") + f"{len(moved)} pages")
    print("  moved  :", ", ".join(moved))
    print("  patched:", ", ".join(patched))
    if dry:
        print("\n  re-run with --apply to write")


if __name__ == "__main__":
    main()
