#!/usr/bin/env python3
"""Join the content package to the licence metadata and emit the site's data file.

The image ids here must match the encoder's: lowercase stack id, and __2/__3
for supplementary artwork. Stack "07B" and stack "07"'s second image both
wanted "s07b" under the obvious scheme, which is one file on a case-insensitive
disk and two on Linux — hence the suffix rather than a letter.
"""
import json, pathlib, re, sys

SRC  = pathlib.Path("/Users/hassankhan/Downloads/scroll-images")
SITE = pathlib.Path(sys.argv[1])
FREE = {"01", "02"}          # 01 is the animated front page; 02 shows the reader format

# --------------------------------------------------------------------------
# Repairs to the content package.
#
# Three defects, all of them artefacts of how long cards were split, not
# opinions about the writing. Everything else ships exactly as written.
# Kept here rather than edited into the source file so that a fresh drop of
# scroll-content.json can be rebuilt and the same three fixes reapplied.
# --------------------------------------------------------------------------
REPAIRS = {
    # An editorial note to the team ("I think the strongest next sets are...")
    # was parsed in as card 9 of the Gnostics stack. It is not story content.
    ("26", 9): None,

    # Card 2's body ended "...into new U.S." and card 3 opened "territories,
    # although his views...". The split landed mid-sentence. The words are
    # unchanged; only the boundary punctuation moves.
    ("07", 2): {"body_suffix": " territories."},
    ("07", 3): {"head": "His views on racial equality were considerably more "
                        "complicated, and less egalitarian, than they are often "
                        "portrayed today."},

    # Two sentences run together with no full stop between "Western Desert"
    # and "A lawyer turned archaeologist". Split at the real boundary.
    ("03", 4): {"head": "Leading theories point to submerged sites near ancient "
                        "Alexandria or tombs in the Western Desert.",
                "body": "A lawyer turned archaeologist, Kathleen Martinez, argues "
                        "Cleopatra may have secretly arranged to be buried 30 miles "
                        "away at Taposiris Magna, possibly to prevent the Romans "
                        "from taking her body."},
}

def repair(sid, cards):
    """Apply REPAIRS to one stack's card list, returning the new list."""
    out = []
    for c in cards:
        key = (sid, c["n"])
        if key in REPAIRS:
            fix = REPAIRS[key]
            if fix is None:
                continue                      # card dropped entirely
            c = dict(c)
            if "head" in fix: c["headline"] = fix["head"]
            if "body" in fix: c["body"] = fix["body"]
            if "body_suffix" in fix:
                c["body"] = (c.get("body") or "").rstrip() + fix["body_suffix"]
        out.append(c)
    return out


# --------------------------------------------------------------------------
# Per-card artwork.
#
# The manifest gives one plate per card, joined on (stack, ORIGINAL card
# number). The original number matters: stack 26 lost a card in REPAIRS, so
# position in the list no longer equals the number the manifest uses.
#
# The CSV names a licence but never links one, and a share-alike plate has to
# link its terms, so the URL is derived from the name here.
# --------------------------------------------------------------------------
CARDIMG = {}
_ci = SITE / "data" / "cardimages.json"
if _ci.exists():
    CARDIMG = json.loads(_ci.read_text())

def licence_url(name):
    n = (name or "").strip().lower()
    if n in ("public domain", "no restrictions", ""): return ""
    if n == "cc0": return "https://creativecommons.org/publicdomain/zero/1.0/"
    if n == "attribution": return ""
    m = re.match(r"cc (by(?:-sa)?) (\d\.\d)", n)
    if m: return f"https://creativecommons.org/licenses/{m.group(1)}/{m.group(2)}/"
    return ""

# --------------------------------------------------------------------------
# Reading time.
#
# The content package listed est_read_seconds computed at roughly 165 wpm with
# no per-card cost, and every value landed between 91s and 172s — which rounds
# to "2 min" for 49 of 51 stories. The real spread is nearly 2x (246 to 476
# words), so the label was hiding exactly the thing a reader wants from it.
#
# Recomputed from the words actually on the cards. 220 wpm: Brysbaert's 2019
# meta-analysis puts adult silent reading of non-fiction near 238, and this is
# a phone, one card per screen.
#
# The per-card cost was 2.5s, which only paid for the swipe. That was wrong
# about what this product is: every card is a full-screen painting, and people
# stop and look at it. Fourteen seconds is a realistic look at one picture with
# a line of caption under it — and it is the larger half of the number, which
# is the honest shape for a reader who is here for the images as much as the
# text. It moves the season from 1.5-2.5 minutes to 3-5.
# --------------------------------------------------------------------------
WPM, PER_CARD_SECONDS = 220, 14.0

def count_words(cards):
    n = 0
    for c in cards:
        n += len(re.findall(r"[\w'\u2019-]+", (c.get("head") or "") + " " + (c.get("body") or "")))
    return n

def read_seconds(cards):
    return count_words(cards) / WPM * 60.0 + len(cards) * PER_CARD_SECONDS

def plate_title(commons_name, artist):
    """A line a reader can actually read.

    The manifest's title field is the Commons filename, so
    "Alma-tadema-antony-cleopatra.jpeg" is what would otherwise appear under
    the painting. Prefer the artist; fall back to the filename tidied up.
    """
    if artist and artist.strip():
        return artist.strip()
    t = re.sub(r"\.(jpe?g|png|webp|tiff?|svg)$", "", commons_name or "", flags=re.I)
    t = t.replace("_", " ").replace("-", " ").strip()
    return re.sub(r"\s+", " ", t)

def card_plate(sid, n):
    """The plate for one card, or None to fall back to the stack hero."""
    e = (CARDIMG.get(sid) or {}).get(str(n))
    if not e: return None
    tier = e.get("tier") or ""
    return {
        "img": e["img"],
        "cap": plate_title(e.get("cap"), e.get("credit")),
        "cr": {
            "artwork": e.get("cap") or "",
            "file":    e.get("cap") or "",
            "credit":  e.get("credit") or "",
            "license": e.get("lic") or "",
            "licenseUrl": licence_url(e.get("lic")),
            "tier":    tier,
            "source":  e.get("src") or "",
            "attrib":  tier != "public_domain",
            "line":    e.get("attr") or "",
        },
    }


content = json.load(open(SRC / "scroll-content.json"))
imeta   = json.load(open(SRC / "scroll-images.json"))
imgs    = imeta["images"] if isinstance(imeta, dict) else imeta

def slot(sid, n): return f"s{sid.lower()}" + ("" if n == 0 else f"__{n+1}")

# Licence metadata, keyed by the source filename — the only field both files share.
lic = {i["file"]: i for i in imgs}

def credit(fname):
    m = lic.get(fname)
    if not m: return None
    return {
        "artwork": m.get("artwork") or "",
        "credit":  m.get("credit") or "",
        "license": m.get("license") or "",
        # The tier is authoritative. The licence *string* is not: seven plates
        # are "CC0" or "No restrictions", which are unrestricted but do not
        # contain the word "public", so string-matching misfiled them.
        "tier":    m.get("license_tier") or "",
        "licenseUrl": m.get("license_url") or "",
        "source":  m.get("source_page") or "",
        "attrib":  bool(m.get("requires_attribution")),
        "line":    m.get("attribution_line") or "",
    }

out = []
for s in content["stacks"]:
    sid = s["id"]
    hero_file = (s.get("image") or {}).get("file", "")
    cards = []
    for c in repair(sid, s["cards"]):
        head = c.get("headline", "") or ""
        card = {
            "n":    c["n"],
            "beat": c.get("beat", ""),
            "head": head,
            "body": c.get("body", "") or "",
            "src":  c.get("source", "") or "",
        }
        plate = card_plate(sid, c["n"])
        if plate:
            card["img"] = plate["img"]
            card["cap"] = plate["cap"]
            card["cr"]  = plate["cr"]
        # A 200-character headline set at headline size is a wall of type over a
        # painting. The copy is the author's, so it is the type that gives, not
        # the words: the reader drops these to body scale.
        if len(head) > 120: card["long"] = True
        cards.append(card)

    supp = []
    for i, sp in enumerate(s.get("supplementary_images") or []):
        f = sp.get("file")
        if not f: continue
        supp.append({"img": slot(sid, i + 1),
                     "cap": sp.get("caption", "") or "",
                     "cr":  credit(f)})

    tags = s.get("experiment_tags") or {}
    out.append({
        "id":    sid,
        "title": s["title"],
        "hook":  s["hook"],
        "cards": cards,
        "img":   slot(sid, 0),
        "cap":   (s.get("image") or {}).get("caption", "") or "",
        "cr":    credit(hero_file),
        "supp":  supp,
        "secs":  int(round(read_seconds(cards))),
        "words": count_words(cards),
        "topic": tags.get("topic", ""),
        "kind":  tags.get("hook_type", ""),
        "free":  sid in FREE,
    })

(SITE / "data").mkdir(exist_ok=True)
p = SITE / "data" / "stacks.json"
p.write_text(json.dumps({"stacks": out}, ensure_ascii=False, separators=(",", ":")))

n_att = sum(1 for s in out if (s["cr"] or {}).get("attrib"))
tiers = {}
for x in out:
    for cr in [x["cr"]] + [y["cr"] for y in x["supp"]]:
        if cr: tiers[cr["tier"]] = tiers.get(cr["tier"], 0) + 1
print(f"licence tiers : {tiers}")
print(f"stacks        : {len(out)}")
print(f"cards         : {sum(len(s['cards']) for s in out)}")
print(f"free          : {sorted(s['id'] for s in out if s['free'])}")
print(f"supplementary : {sum(len(s['supp']) for s in out)}")
print(f"heroes needing attribution : {n_att}")
print(f"missing credit block       : {[s['id'] for s in out if not s['cr']] or 'none'}")
print(f"repairs applied            : {len(REPAIRS)}")
print(f"long headlines flagged     : {sum(1 for x in out for c in x['cards'] if c.get('long'))}")
own = sum(1 for x in out for c in x["cards"] if c.get("img"))
allc = sum(len(x["cards"]) for x in out)
print(f"cards with own plate       : {own}/{allc}"
      + (f"  ({allc-own} fall back to the stack hero)" if own < allc else ""))
_t = {}
for x in out:
    for c in x["cards"]:
        if c.get("cr"): _t[c["cr"]["tier"]] = _t.get(c["cr"]["tier"], 0) + 1
print(f"card licence tiers         : {_t}")
print(f"share-alike missing a link : "
      f"{[c['cr']['license'] for x in out for c in x['cards'] if c.get('cr') and c['cr']['tier']=='share_alike' and not c['cr']['licenseUrl']] or 'none'}")
_secs = sorted(x["secs"] for x in out)
print(f"reading time               : {_secs[0]}s - {_secs[-1]}s "
      f"(median {_secs[len(_secs)//2]}s), {sum(x['words'] for x in out)} words total")
print(f"data/stacks.json           : {p.stat().st_size//1024} KB")

# Every referenced image must exist on disk, or a card renders on a blank ground.
have = {f.stem for f in (SITE/'img'/'stacks').glob('*.webp')}
want = {s["img"] for s in out} | {x["img"] for s in out for x in s["supp"]}
print(f"referenced images missing  : {sorted(want - have) or 'none'}")
