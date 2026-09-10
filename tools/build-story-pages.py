#!/usr/bin/env python3
"""Give the 51 stories an address a crawler can reach, and a link preview.

WHY THIS EXISTS
---------------
Before this file the site had no search surface at all. /robots.txt and
/sitemap.xml were both 404. Every story lived behind /read?s=NN, which is
read.html, which carries `<meta name="robots" content="noindex">` — correctly,
because that page is the paid reader and its text is fetched at runtime. So the
only indexable pages were the shelf and three flagship stories, and / and
/explore shipped a byte-identical <title>. Fifty-one stories built on 450
museum paintings were, to Google, one page. Every share to Facebook, LinkedIn
or Slack pulled the same site-wide og:image, whichever story was being shared.

So: one static page per story at /history/<slug>, built from the fields that
are already public.

AND ONE PAGE THAT LINKS TO ALL OF THEM
--------------------------------------
Being in the sitemap is not the same as being linked to. A sitemap gets a URL
fetched; internal links are what say the URL belongs to the site. The 51 pages
shipped with no inbound link from anywhere, and the shelf could not give them
one: /explore serves a spinner and builds every card in js/today.js, so a
crawler that does not run JavaScript finds no card to hang a link on there.

So this file also writes history/index.html — /history/ — which lists all 51
with their hooks. / and /explore link to it in their footers, in the served
HTML, and every story page links back. See the block above hub_html().

WHAT MAY GO ON THESE PAGES, AND WHAT MAY NOT
--------------------------------------------
The only input is data/index.json. That file is published deliberately and
carries `title, hook, img, cap, cr, free, kind, secs, topic, words` per story
and, per card, ONLY `n` and `head`. Headlines are the shelf's own copy; the
hook is the cover line split-stacks publishes on purpose.

Card BODIES are not in that file and must never reach one of these pages. That
is the whole reason data/stacks.json was deleted and the corpus moved to the
untracked content/stacks.json — see the "no paid story's text ships as a static
file" check in tools/check-regressions.js. This generator therefore reads
data/index.json and nothing else: it cannot emit a body because it never holds
one. Do not "enrich" it from content/stacks.json. That file is also untracked,
so it is simply absent on a fresh clone, and a build that needs it is a build
that only runs on one laptop.

NO JAVASCRIPT, AND NO STYLESHEET LINK
-------------------------------------
A page whose title arrives via JS is a page Google may or may not index, and a
link preview scraper never runs JS at all. So nothing on these pages executes:
the only <script> is the application/ld+json data block, which is markup a
parser reads, not code a browser runs. The CSS is inlined rather than linked,
which also keeps these pages out of tools/stamp-assets.py — they reference no
/js and no /css, so there is no asset URL to stamp and no cache to bust.

USAGE
-----
    python3 tools/build-story-pages.py           # pages, hub, og jpegs, sitemap
    python3 tools/build-story-pages.py --check   # write nothing; exit 1 if stale

The --check mode is what tools/precommit.sh section 6 runs. It refuses and
prints the fix; it does not rewrite files under the committer, for the same
reason section 5 does not restamp — see the note there.
"""
import datetime, hashlib, html, json, math, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = "https://factbox.app"

INDEX    = ROOT / "data" / "index.json"
PAGES    = ROOT / "history"
OG       = ROOT / "img" / "og"
SITEMAP  = ROOT / "sitemap.xml"
LASTMOD  = ROOT / "tools" / "sitemap-lastmod.txt"

OG_W, OG_H, OG_Q = 1200, 630, 80
OG_FALLBACK = "/img/share-home.jpg"      # exists; used only when a cover does not

# The pages that are NOT generated here but belong in the sitemap, with the
# file each one is served from — the file's bytes are what decides whether its
# <lastmod> has moved. /read, /join, /login, /account, /settings, /unlock and
# /admin are deliberately absent: they are the reader and the money path, they
# need an account, and read.html says noindex about itself.
STATIC = [
    ("/",            "index.html"),
    ("/explore",     "explore.html"),
    # /stories is deprecated and canonicalises to /explore, so it will not be
    # indexed under its own URL — but Stripe's three Payment Links still return
    # buyers to it and links to it are in the wild, so it is a live page and
    # listing it is how a crawler learns the canonical it points at.
    ("/stories",     "stories.html"),
    ("/library",     "library.html"),
    ("/story",       "story.html"),
    ("/cleopatra",   "cleopatra.html"),
    ("/firststory",  "firststory.html"),
]


# --------------------------------------------------------------------------
# slugs
# --------------------------------------------------------------------------
def slugify(title):
    """Title -> lowercase, non-alphanumerics to hyphens, collapsed, trimmed."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")


def slugs_for(stacks):
    """One slug per story, or a hard failure.

    A collision is resolved by a human editing a title, never by this script
    appending a number. An auto-suffixed slug is a URL that moves the next time
    the alphabetical order of two stories changes, and a URL that moves is a
    URL that loses whatever rank it had — the exact thing this file was written
    to build.
    """
    out, seen = {}, {}
    for s in stacks:
        sid, title = str(s["id"]), str(s.get("title") or "")
        slug = slugify(title)
        if not slug:
            raise SystemExit("story %s has a title with no usable characters: %r"
                             % (sid, title))
        if slug == "index":
            raise SystemExit(
                "story %s makes /history/index, which is the hub page's own "
                "file (history/index.html). Rename the title." % sid)
        if slug in seen:
            raise SystemExit(
                "slug collision: stories %s and %s both make /history/%s\n"
                "  %s: %r\n  %s: %r\n"
                "Rename one of the titles in the content package and rebuild "
                "data/index.json. This script will not number them apart."
                % (seen[slug], sid, slug, seen[slug],
                   [x["title"] for x in stacks if str(x["id"]) == seen[slug]][0],
                   sid, title))
        seen[slug] = sid
        out[sid] = slug
    return out


# --------------------------------------------------------------------------
# the cover, and the share image made from it
# --------------------------------------------------------------------------
def webp_size(path):
    """(width, height) from a WebP header, or None.

    Parsed here rather than shelled out to sips because --check must run
    without spawning 51 processes, and because the numbers only exist to put
    width/height on the <img> so the text does not jump when the plate decodes.
    """
    try:
        b = path.read_bytes()[:64]
    except OSError:
        return None
    if b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    kind = b[12:16]
    if kind == b"VP8X":
        return (int.from_bytes(b[24:27], "little") + 1,
                int.from_bytes(b[27:30], "little") + 1)
    if kind == b"VP8 " and b[23:26] == b"\x9d\x01\x2a":
        return (int.from_bytes(b[26:28], "little") & 0x3FFF,
                int.from_bytes(b[28:30], "little") & 0x3FFF)
    if kind == b"VP8L" and b[20] == 0x2F:
        n = int.from_bytes(b[21:25], "little")
        return ((n & 0x3FFF) + 1, ((n >> 14) & 0x3FFF) + 1)
    return None


def og_jpeg(src, dst):
    """Cover-crop `src` to 1200x630 JPEG at `dst`.

    The covers are WebP, and WebP is the one format an og:image may not be:
    Facebook and LinkedIn do not reliably render it, so a tag pointing at
    img/stacks/sNN.webp is a tag that shows nothing — which is worse than no
    tag, because it looks done.

    sips resamples to an exact height/width, so the proportional size is worked
    out here and the crop that follows is centred. Two flags, no dependency,
    and byte-identical on a second run, which is what keeps --check honest.
    """
    size = webp_size(src)
    if not size:
        return False
    w, h = size
    scale = max(OG_W / w, OG_H / h)
    rw, rh = max(OG_W, math.ceil(w * scale)), max(OG_H, math.ceil(h * scale))
    dst.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(OG_Q),
         "-z", str(rh), str(rw), "-c", str(OG_H), str(OG_W),
         str(src), "--out", str(dst)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return r.returncode == 0


# --------------------------------------------------------------------------
# the page
# --------------------------------------------------------------------------
def credit_html(cap, cr):
    """The attribution line under the plate.

    Same rule as tools/build_credits.py: the maker is named when the licence
    obliges it (9 of the 51 covers are share_alike or attribution), the licence
    is linked when it has a URL, and the source always is. `cap` is already the
    head of cr["line"], so printing both would say the artwork twice — the tail
    is what the caption does not already carry.
    """
    line = str(cr.get("line") or "").strip()
    tail = line[len(cap):].lstrip(". ").strip() if line.startswith(cap) else line
    who = str(cr.get("credit") or "").strip()
    bits = []
    if who and cr.get("tier") != "public_domain" and who not in cap:
        bits.append(html.escape(who))
    lic = str(cr.get("license") or "").strip()
    if lic:
        url = str(cr.get("licenseUrl") or "").strip()
        bits.append('<a href="%s" rel="noopener nofollow" target="_blank">%s</a>'
                    % (html.escape(url), html.escape(lic)) if url else html.escape(lic))
    elif tail:
        bits.append(html.escape(tail))
    src = str(cr.get("source") or "").strip()
    if src:
        bits.append('<a href="%s" rel="noopener nofollow" target="_blank">source</a>'
                    % html.escape(src))
    return " &middot; ".join(bits)


CSS = """
*{box-sizing:border-box}
/* The palette is copied from css/app.css rather than linked to it. These pages
   load no stylesheet at all — see the module docstring — so the six paper
   tokens are written out here. If app.css repaints, repaint this too. */
:root{
  --ground:#E7E0D3; --raise:#F1EBDF; --ink:#172E5B; --dim:rgba(23,46,91,.82);
  --dimmer:rgba(23,46,91,.74); --accent:#1A5BA1; --fill:#3B9EF4;
  --hair:rgba(23,46,91,.14);
}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);
  font:400 16px/1.55 "DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  /* No webfont is fetched. Newsreader is the site's display serif and Georgia
     is the fallback declared in the token; a render-blocking request to
     fonts.googleapis.com is a poor trade on a page whose whole job is to be
     read quickly by a machine. */
  overflow-wrap:break-word}
a{color:var(--accent)}
.wrap{max-width:720px;margin:0 auto;padding:14px 18px 64px}
.mast{font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;
  font-weight:600;margin:0 0 18px}
.mast a{text-decoration:none;color:var(--dimmer)}
figure{margin:0 0 18px}
figure img{display:block;width:100%;height:auto;border-radius:14px;
  background:#0F1420}
figcaption{margin-top:8px;font-size:.78rem;line-height:1.5;color:var(--dimmer)}
figcaption .cr{display:block;margin-top:3px}
h1{font:500 clamp(1.6rem,5.6vw,2.3rem)/1.18 Newsreader,Georgia,serif;
  letter-spacing:-.015em;margin:0 0 10px}
.hook{font:400 clamp(1.02rem,3.4vw,1.15rem)/1.5 Newsreader,Georgia,serif;
  color:var(--dim);margin:0 0 14px}
.meta{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;
  font-weight:600;color:var(--dimmer);margin:0 0 20px}
.cta{display:inline-block;background:var(--fill);color:#0B1C33;
  text-decoration:none;font-weight:600;border-radius:999px;
  padding:13px 24px;font-size:.98rem}
.cta:hover{background:#2E90E8}
h2{font-size:.78rem;letter-spacing:.11em;text-transform:uppercase;
  color:var(--dimmer);font-weight:600;margin:34px 0 0;padding-top:16px;
  border-top:1px solid var(--hair)}
.beats{margin:14px 0 26px;padding:0;list-style:none;counter-reset:b}
.beats li{position:relative;padding:11px 0 11px 40px;
  border-bottom:1px solid var(--hair);font-size:.98rem;line-height:1.45}
.beats li:before{counter-increment:b;content:counter(b);position:absolute;
  left:0;top:11px;width:26px;text-align:right;color:var(--dimmer);
  font-size:.8rem;font-variant-numeric:tabular-nums}
.tail{margin:26px 0 0;font-size:.9rem;color:var(--dim)}
.foot{margin:40px 0 0;padding-top:16px;border-top:1px solid var(--hair);
  font-size:.82rem;color:var(--dimmer)}
.foot a{margin-right:14px}
"""


def page_html(s, slug, og_url, cards, ntotal):
    sid    = str(s["id"])
    title  = str(s.get("title") or "")
    hook   = str(s.get("hook") or "")
    cap    = str(s.get("cap") or "")
    cr     = s.get("cr") or {}
    url    = "%s/history/%s" % (SITE, slug)
    read   = "/read?s=%s" % sid
    mins   = max(1, int(round(int(s.get("secs") or 0) / 60.0)))
    cover  = ROOT / "img" / "stacks" / ("%s.webp" % s.get("img"))
    size   = webp_size(cover)
    dims   = ' width="%d" height="%d"' % size if size else ""
    e      = html.escape

    # Structured data. Only fields this page can actually stand behind: no
    # datePublished, because the corpus carries no publication date and an
    # invented one is a lie a rich result would repeat. isAccessibleForFree is
    # the honest signal for the 49 stories that are paid.
    ld = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": hook,
        "image": SITE + og_url if og_url.startswith("/") else og_url,
        "url": url,
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "articleSection": str(s.get("topic") or "").replace("_", " "),
        "timeRequired": "PT%dM" % mins,
        "isAccessibleForFree": bool(s.get("free") is True),
        "publisher": {"@type": "Organization", "name": "Factbox",
                      "url": SITE + "/"},
        "author": {"@type": "Organization", "name": "Factbox"},
    }
    ldj = json.dumps(ld, ensure_ascii=False, indent=None,
                     separators=(",", ":")).replace("<", "\\u003c")

    beats = "\n".join(
        "  <li>%s</li>" % e(str(c.get("head") or "")) for c in cards)

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title} &mdash; Factbox</title>
<meta name="description" content="{hook}">
<meta name="theme-color" content="#E7E0D3">
<!-- No robots meta. read.html carries noindex because it is the paid reader;
     this page is the opposite of that page and must not inherit it. -->
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/img/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Factbox">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{hook}">
<!-- A JPEG, not the WebP cover: this tag is read by Facebook and LinkedIn,
     which do not reliably render WebP. Built by tools/build-story-pages.py. -->
<meta property="og:image" content="{site}{og}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="{ogw}">
<meta property="og:image:height" content="{ogh}">
<meta property="og:image:alt" content="{cap}">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{ldj}</script>
<style>{css}</style>
</head>
<body>
<main class="wrap">

<p class="mast"><a href="/">Factbox</a></p>

<article>
  <figure>
    <img src="/img/stacks/{img}.webp"{dims} alt="{cap}" decoding="async">
    <figcaption>{cap}<span class="cr">{credit}</span></figcaption>
  </figure>

  <h1>{title}</h1>
  <p class="hook">{hook}</p>
  <p class="meta">{mins} min read &middot; {ncards} cards &middot; {access}</p>

  <p><a class="cta" href="{read}">Read this story</a></p>

  <h2>What the story covers</h2>
  <!-- The headlines, and only the headlines. They are public in
       data/index.json; the card bodies are not in that file, are not on this
       page, and are served to a paying reader by functions/story.js. -->
  <ol class="beats">
{beats}
  </ol>

  <p class="tail">Told one card at a time, on paintings from the world&rsquo;s
    museums. <a href="{read}">Open it in the reader</a>.</p>
</article>

<p class="foot">
  <a href="/explore">All stories</a>
  <!-- The hub. This is the other half of the link graph: /history/ lists all
       {ntotal} of these pages, and every one of them points back at it, so a
       crawler that lands on any single story can reach the other {nother}
       without going through a page that builds its shelf in JavaScript. -->
  <a href="/history/">Story index</a>
  <a href="/library">Your library</a>
  <a href="/credits">Artwork credits</a>
</p>

</main>
</body>
</html>
""".format(title=e(title), hook=e(hook), cap=e(cap), url=e(url),
           site=SITE, og=e(og_url), ogw=OG_W, ogh=OG_H,
           img=e(str(s.get("img") or "")), dims=dims,
           credit=credit_html(cap, cr), mins=mins, ncards=len(cards),
           access="free to read" if s.get("free") is True else "for members",
           read=e(read), beats=beats, ldj=ldj, css=CSS,
           ntotal=ntotal, nother=max(0, ntotal - 1))


# --------------------------------------------------------------------------
# the hub: /history/, the one page that links to all of them
# --------------------------------------------------------------------------
# WHY THIS PAGE EXISTS AT ALL
# --------------------------
# The 51 pages above were orphans. They were in sitemap.xml and nothing on the
# site linked to them, and those are two different things: a sitemap gets a URL
# fetched, internal links are what tell Google the URL is part of the site and
# worth ranking. A page with no inbound link is a page that gets crawled once
# and filed under "we found this, nobody references it".
#
# The obvious place to put those links is the shelf, and the shelf cannot hold
# them. /explore ships a spinner and a <noscript>; every card on it is built by
# js/today.js from data/index.json AFTER the page loads. A crawler that does
# not run JavaScript sees no cards, so there is no card to hang a link on. That
# is also why the "make the card an anchor to /history/<slug> and intercept the
# click" idea does not survive contact with this page: the anchor it would
# upgrade does not exist until the script that would upgrade it has already
# run. It would be progressive enhancement with nothing underneath, and it
# would put every human tap one broken handler away from the wrong page.
#
# So the link that has to exist in the served bytes is a link to ONE page, and
# that page carries the other 51. /explore and / link here in their footers,
# every story page links back here, and the loop closes.
#
# It is generated, not written, for the reason section 6 of precommit exists: a
# hand-kept index of 51 titles is an index that is wrong the first time a story
# is retitled, and a wrong link here is a 404 with the site's own name on it.

HUB_CSS = """
.lede{font:400 clamp(1.02rem,3.4vw,1.15rem)/1.5 Newsreader,Georgia,serif;
  color:var(--dim);margin:0 0 26px}
.idx{margin:0;padding:0;list-style:none}
.idx li{padding:14px 0;border-top:1px solid var(--hair)}
.idx a{font:500 1.06rem/1.35 Newsreader,Georgia,serif;text-decoration:none;
  letter-spacing:-.01em}
.idx a:hover{text-decoration:underline}
.idx .say{margin:5px 0 0;font-size:.92rem;line-height:1.45;color:var(--dim)}
.idx .m{display:block;margin-top:5px;font-size:.72rem;letter-spacing:.1em;
  text-transform:uppercase;font-weight:600;color:var(--dimmer)}
"""


def hub_html(stacks, slugs):
    """One page, 51 links, no script.

    Titles and hooks only. Both are published in data/index.json on purpose —
    the headline is the shelf's own copy and the hook is the cover line — and
    the card bodies are not in that file, so, exactly as with the story pages,
    this cannot leak one because it never holds one.
    """
    e = html.escape
    url = "%s/history/" % SITE
    rows, items = [], []
    for s in stacks:
        sid = str(s["id"])
        slug = slugs[sid]
        title = str(s.get("title") or "")
        hook = str(s.get("hook") or "")
        mins = max(1, int(round(int(s.get("secs") or 0) / 60.0)))
        n = len(s.get("cards") or [])
        meta = "%d cards &middot; %d min" % (n, mins)
        if s.get("free") is True:
            meta += " &middot; free to read"
        rows.append(
            '  <li><a href="/history/%s">%s</a>'
            '<p class="say">%s</p><span class="m">%s</span></li>'
            % (e(slug), e(title), e(hook), meta))
        items.append({"@type": "ListItem", "position": len(items) + 1,
                      "url": "%s/history/%s" % (SITE, slug), "name": title})

    ld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "Every Factbox story",
        "description": "All %d Factbox history stories." % len(stacks),
        "url": url,
        "isPartOf": {"@type": "WebSite", "name": "Factbox", "url": SITE + "/"},
        "mainEntity": {"@type": "ItemList", "numberOfItems": len(items),
                       "itemListElement": items},
    }
    ldj = json.dumps(ld, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Every Factbox story &mdash; Factbox</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#E7E0D3">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/img/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<!-- The trailing slash is the address. GitHub Pages serves history/index.html
     at /history/ and 301s /history to it, so every link on the site says
     /history/ and no crawler spends a hop on the redirect. -->
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Factbox">
<meta property="og:title" content="Every Factbox story">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{site}{og}">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{ldj}</script>
<style>{css}</style>
</head>
<body>
<main class="wrap">

<p class="mast"><a href="/">Factbox</a></p>

<h1>Every Factbox story</h1>
<p class="lede">All {n} of them, in the order the archive files them. Each
  one is about five minutes, told one card at a time on paintings from the
  world&rsquo;s museums. <a href="/explore">The shelf</a> is where you read
  them.</p>

<ol class="idx">
{rows}
</ol>

<p class="foot">
  <a href="/explore">All stories</a>
  <a href="/library">Your library</a>
  <a href="/credits">Artwork credits</a>
</p>

</main>
</body>
</html>
""".format(desc=e("All %d Factbox history stories, from Cleopatra to the "
                  "twentieth century — five minutes each." % len(stacks)),
           url=e(url), site=SITE, og=OG_FALLBACK, ldj=ldj,
           css=CSS + HUB_CSS, n=len(stacks), rows="\n".join(rows))


# --------------------------------------------------------------------------
# <lastmod>, which has to survive being built on another machine
# --------------------------------------------------------------------------
def read_lastmod():
    """The recorded (sha, date) per URL.

    A sitemap needs a date, and every obvious source for one is wrong here.
    today() is not idempotent — precommit would fail every midnight on a repo
    nobody had touched. A file mtime is not preserved by git, so a fresh clone
    would date everything to the moment it was cloned. A git commit date only
    exists AFTER the commit, so the check would go stale the instant you
    committed and could never be satisfied in the same commit.

    So the date is carried in this table, keyed by a hash of what the page is
    built from, and only moves when those bytes move. It is committed, so every
    machine produces the same sitemap.
    """
    out = {}
    if not LASTMOD.exists():
        return out
    for ln in LASTMOD.read_text().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        parts = ln.split(None, 2)
        if len(parts) == 3:
            out[parts[2]] = (parts[1], parts[0])
    return out


def write_lastmod(rows):
    body = [
        "# <lastmod> for sitemap.xml, carried rather than stamped.",
        "#",
        "# Written by tools/build-story-pages.py. Each line is",
        "#     <date>  <sha256[:12] of what the URL is built from>  <url>",
        "# and the date only moves when that hash does, so building on another",
        "# machine, or on another day, produces a byte-identical sitemap.",
        "# Do not hand-edit: run the generator.",
        "",
    ]
    for url, sha, date in rows:
        body.append("%s  %s  %s" % (date, sha, url))
    return "\n".join(body) + "\n"


def sha(b):
    return hashlib.sha256(b).hexdigest()[:12]


def sitemap_xml(rows):
    """The URLs worth crawling, and nothing that needs an account.

    No <changefreq> or <priority>: Google ignores both, and a field nobody
    reads is a field that quietly goes wrong.
    """
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           "<!-- Generated by tools/build-story-pages.py from data/index.json.",
           "     /read, /join, /login, /account, /settings, /unlock and /admin",
           "     are deliberately absent: they need an account or they are the",
           "     paid reader, which says noindex about itself. -->",
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, _s, date in rows:
        out.append("  <url><loc>%s%s</loc><lastmod>%s</lastmod></url>"
                   % (SITE, html.escape(url), date))
    out.append("</urlset>")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------
def main(argv):
    check = "--check" in argv
    today = datetime.date.today().isoformat()

    try:
        stacks = json.loads(INDEX.read_text())["stacks"]
    except Exception as exc:                                  # noqa: BLE001
        print("cannot read %s: %s" % (INDEX, exc))
        return 1
    if not stacks:
        print("data/index.json has no stacks")
        return 1

    slugs = slugs_for(stacks)
    prev, rows, stale, warn = read_lastmod(), [], [], []

    # 1 · the static pages, dated by the bytes they are served from
    for url, fname in STATIC:
        f = ROOT / fname
        if not f.exists():
            warn.append("%s is in the sitemap but %s is missing" % (url, fname))
            continue
        h = sha(f.read_bytes())
        old = prev.get(url)
        rows.append((url, h, old[1] if old and old[0] == h else today))
        if not old or old[0] != h:
            stale.append("%s changed" % url)

    # 2 · the hub, /history/. It is written before the stories so its <loc>
    #     lands between the static pages and the 51, which is also the shape
    #     of the link graph: the footers of / and /explore reach it, and it
    #     reaches every story page.
    want_pages, want_og, og_bytes, made = set(), set(), 0, 0

    hub_file = PAGES / "index.html"
    hub = hub_html(stacks, slugs).encode("utf-8")
    want_pages.add(hub_file.name)
    h = sha(hub)
    old = prev.get("/history/")
    rows.append(("/history/", h, old[1] if old and old[0] == h else today))
    on_disk = hub_file.read_bytes() if hub_file.exists() else None
    if check:
        if on_disk != hub:
            stale.append("history/index.html is out of date")
        elif not old or old[0] != h:
            stale.append("/history/ has no recorded lastmod")
    elif on_disk != hub:
        hub_file.parent.mkdir(parents=True, exist_ok=True)
        hub_file.write_bytes(hub)

    # 3 · a page per story
    for s in stacks:
        sid, slug = str(s["id"]), slugs[str(s["id"])]
        cover = ROOT / "img" / "stacks" / ("%s.webp" % s.get("img"))
        jpg = OG / ("%s.jpg" % sid)

        if cover.exists():
            og_url = "/img/og/%s.jpg" % sid
            want_og.add(jpg.name)
            if check:
                if not jpg.exists():
                    stale.append("img/og/%s.jpg is missing" % sid)
            else:
                if og_jpeg(cover, jpg):
                    made += 1
                else:
                    warn.append("sips could not convert %s" % cover.name)
        else:
            # Never emit a tag pointing at a 404: a broken og:image is a share
            # that renders as a grey box, which reads as a broken site.
            og_url = OG_FALLBACK
            warn.append("no cover img/stacks/%s.webp for story %s — og:image "
                        "falls back to %s" % (s.get("img"), sid, OG_FALLBACK))

        out = PAGES / ("%s.html" % slug)
        want_pages.add(out.name)
        text = page_html(s, slug, og_url, s.get("cards") or [], len(stacks))
        blob = text.encode("utf-8")

        url = "/history/%s" % slug
        h = sha(blob)
        old = prev.get(url)
        rows.append((url, h, old[1] if old and old[0] == h else today))

        on_disk = out.read_bytes() if out.exists() else None
        if check:
            if on_disk != blob:
                stale.append("history/%s.html is out of date" % slug)
            elif not old or old[0] != h:
                stale.append("%s has no recorded lastmod" % url)
        elif on_disk != blob:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(blob)

    # 4 · anything left behind. A story dropped from the index must not leave a
    #     live page and a stale share image on the site.
    for d, want, label in ((PAGES, want_pages, "history"), (OG, want_og, "img/og")):
        if not d.exists():
            continue
        for f in sorted(d.iterdir()):
            if f.name.startswith(".") or f.name in want:
                continue
            if check:
                stale.append("%s/%s is not in data/index.json" % (label, f.name))
            else:
                f.unlink()
    if OG.exists():
        og_bytes = sum(f.stat().st_size for f in OG.glob("*.jpg"))

    # 5 · the sitemap and the date table
    xml, tbl = sitemap_xml(rows).encode("utf-8"), write_lastmod(rows).encode("utf-8")
    if check:
        if not SITEMAP.exists() or SITEMAP.read_bytes() != xml:
            stale.append("sitemap.xml is out of date")
    else:
        SITEMAP.write_bytes(xml)
        LASTMOD.write_bytes(tbl)

    for w in warn:
        print("warn  " + w)

    if check:
        if stale:
            for x in stale[:12]:
                print("stale  " + x)
            if len(stale) > 12:
                print("stale  ... and %d more" % (len(stale) - 12))
            return 1
        print("%d story pages + hub + %d sitemap URLs current"
                  % (len(stacks), len(rows)))
        return 0

    print("%d story pages + /history/ hub, %d og jpegs (%s bytes), %d sitemap URLs"
          % (len(stacks), made, "{:,}".format(og_bytes), len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
