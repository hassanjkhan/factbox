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
PAGES = ["stories", "explore", "library", "read", "join", "credits",
         "unlock", "privacy", "terms", "support", "login", "account"]
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
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<title>Redirecting</title>'
            f'<link rel="canonical" href="https://factbox.app{target}">'
            f'<meta http-equiv="refresh" content="0; url={target}">'
            f'<meta name="robots" content="noindex">'
            f'</head><body><p>Moved to <a href="{target}">{target}</a>.</p>'
            f'<script>location.replace("{target}"+location.search+location.hash)</script>'
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
