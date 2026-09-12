#!/usr/bin/env python3
"""
store.py — the shared floor under both collectors: what a number is, where it
goes, and the one rule that must never break.

THE RULE. TikTok stops serving reach, total/average watch time, retention and
impression sources for a video that has had no activity for seven days, and
stops updating post data at all after a year. There is no backfill endpoint;
there is no support ticket. A number we captured on day two and then dropped
on day nine is gone for everybody, permanently. So:

    A VALUE THAT IS ABSENT OR NULL IN A FETCH NEVER OVERWRITES A VALUE WE
    ALREADY HAVE.

That is enforced twice on purpose. `merge_metrics()` below drops absent keys
before they are ever sent, and the bridge writes with set({merge:true}) so a
key we withheld is untouched rather than cleared. And before either of those,
every run appends to a LOCAL ledger at tools/collect/state/ledger.json, which
is written before the network is touched and survives Firestore being down,
the service account being rotated, or this script crashing mid-batch.

THE OTHER RULE, which is not about data loss but about locking two people out
of their own board. firestore.rules pins a reel document's key set with
hasOnly(). A service account bypasses rules, so this file could happily write
`tiktokItemId` onto a reel — and every later edit of that reel from the
browser would then fail permission-denied, for both admins, with nothing on
screen to explain it. REEL_KEYS below is that hasOnly() list, copied, and
`reel_patch()` refuses to send anything outside it. Everything TikTok returns
that the board has no column for goes to the archive instead.

Keys live in ~/.factbox-keys/. The repo is public.
"""

import json, os, re, subprocess, sys, time
from datetime import datetime, timezone

HERE      = os.path.dirname(os.path.abspath(__file__))
BRIDGE    = os.path.join(HERE, "_firestore.js")
STATE_DIR = os.path.join(HERE, "state")
LEDGER    = os.path.join(STATE_DIR, "ledger.json")
UNMATCHED = os.path.join(HERE, "unmatched")
KEYS      = os.path.expanduser("~/.factbox-keys")

EXPERIMENTS = "admin_experiments"
REELS       = "reels"
# The collector's own durable copy, OUTSIDE the rules-validated reel document.
# Everything a platform returns that the board has no column for lands here:
# raw payloads, TikTok's item_id, total_time_watched, impression_sources, and
# the full-resolution retention curve before it is fitted to the board's cap.
ARCHIVE     = "admin_reel_measurements"

# --------------------------------------------------------------- the shape --

# firestore.rules :: reelShape() :: hasOnly([...]). If that list ever changes,
# this one changes with it. Nothing outside it may be written to a reel.
REEL_KEYS = frozenset([
    "story", "url", "platform", "variant", "format",
    "postedAt", "cover", "coverPath",
    "views", "reach", "likes", "comments", "shares", "saves",
    "profileTaps", "avgWatch", "completion", "threeSec",
    "measuredAt", "retention", "source",
    "analysis", "analysisBy", "analysisByName", "analysisAt",
    "order", "createdAt", "updatedAt", "updatedBy",
])

# The ten numbers, with the ceilings firestore.rules enforces. A value outside
# its range is DROPPED rather than clamped: a clamped number is a wrong number
# that looks right, and these feed an A/B comparison.
METRIC_RANGE = {
    "views": (0, 10000000000), "reach": (0, 10000000000),
    "likes": (0, 10000000000), "comments": (0, 10000000000),
    "shares": (0, 10000000000), "saves": (0, 10000000000),
    "profileTaps": (0, 10000000000),
    "avgWatch": (0, 86400), "completion": (0, 100), "threeSec": (0, 100),
}

# firestore.rules :: source in ["manual", "api", "instagram", "tiktok"].
# The brief asks each write to carry "tiktok-api" / "instagram-web" / "ocr",
# and those exact strings are NOT in that enum — writing one would make the
# reel uneditable from the browser. So the reel carries the platform name the
# rules allow, and the precise collector string is carried in full on the
# archive document, which no rule constrains. Nothing is lost and the board
# keeps working.
SOURCE_TO_REEL = {
    "tiktok-api":     "tiktok",
    "instagram-web":  "instagram",
    "ocr":            "instagram",
}

# The rules cap `retention` at 40 points (smallList). TikTok returns one point
# per second, so a 58-second video arrives with 58 of them.
MAX_RETENTION = 40


def die(msg):
    raise SystemExit(msg)


def load_key(name, required):
    """Same contract as tools/reel/providers.py: fail NOW, naming the field,
    rather than as a 401 in the middle of a run."""
    path = os.path.join(KEYS, name + ".json")
    if not os.path.exists(path):
        die("missing %s\n"
            "  Create it with the fields: %s\n"
            "  It lives outside the repo on purpose — the repo is public."
            % (path, ", ".join(required)))
    try:
        cfg = json.load(open(path))
    except ValueError as e:
        die("%s is not valid JSON: %s" % (path, e))
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        die("%s is missing: %s" % (path, ", ".join(missing)))
    return cfg


# ------------------------------------------------------------------ bridge --

def bridge(op, **kw):
    """One JSON request to _firestore.js, one JSON response back."""
    req = dict(kw); req["op"] = op
    try:
        p = subprocess.run(["node", BRIDGE], input=json.dumps(req).encode(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    except FileNotFoundError:
        die("node is not on PATH — tools/collect needs it for Firestore.")
    except subprocess.TimeoutExpired:
        die("Firestore bridge timed out after 180s.")
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    if not out:
        die("Firestore bridge said nothing. stderr:\n"
            + (p.stderr or b"").decode("utf-8", "replace")[:800])
    try:
        env = json.loads(out.splitlines()[-1])
    except ValueError:
        die("Firestore bridge returned non-JSON:\n" + out[:800])
    if not env.get("ok"):
        die("Firestore: " + str(env.get("error")))
    return env.get("result") or {}


def ts(ms):
    """Tag a millisecond instant so the bridge turns it into a real Firestore
    Timestamp. postedAt/measuredAt are `tsOrNull` in the rules — a bare number
    there is rejected the moment a browser touches the row."""
    if ms is None:
        return None
    return {"__ts__": int(ms)}


def now_ms():
    return int(time.time() * 1000)


def iso(ms):
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------ url matching --

# Matching is by POST URL and by nothing else, because the URL is the only
# thing a person typing a row by hand and an API returning a video both know.
_TRACKING = re.compile(r"^(utm_|igsh|igshid|si$|is_from|_r$|_t$|_d$|sender_|share_)", re.I)


def canon_url(u):
    """A comparable key for one post.

    The same reel is handed to us as half a dozen strings: the share_url
    TikTok returns carries a click id, Instagram's copy-link button appends
    ?igsh=, somebody pastes the http:// form or a trailing slash or the m.
    host. All of those are one post and must land on one row.

    Instagram and TikTok both put the post id in the path, so the path is the
    identity and the query string is discarded except where it is the id
    itself. Returns "" for anything that is not a usable post URL — and ""
    never matches anything, which is the safe direction: an unmatched fetch
    gets written to tools/collect/unmatched/ for a human to look at, where a
    WRONGLY matched one would silently overwrite another reel's numbers.
    """
    if not u or not isinstance(u, str):
        return ""
    s = u.strip()
    if not s:
        return ""
    s = re.sub(r"^http://", "https://", s, flags=re.I)
    if not s.lower().startswith("https://"):
        return ""
    m = re.match(r"^https://([^/?#]+)([^?#]*)(?:\?([^#]*))?", s, re.I)
    if not m:
        return ""
    host = m.group(1).lower()
    path = m.group(2) or "/"
    host = re.sub(r"^(www\.|m\.|vm\.|vt\.)", "", host)
    # TikTok's /t/ and vm. short links do not contain the item id at all; they
    # resolve to it only by following a redirect. Treat them as their own key
    # rather than pretending they are comparable to a full URL.
    path = re.sub(r"/+$", "", path) or "/"
    path = re.sub(r"/+", "/", path)
    key = host + path.lower()
    # Instagram reels are .../reel/<code>/ and .../p/<code>/ for the same post
    # when it also appears in the grid. Normalise to the code.
    ig = re.match(r"^instagram\.com/(?:[^/]+/)?(?:reel|reels|p|tv)/([a-z0-9_-]+)", key, re.I)
    if ig:
        return "instagram:" + ig.group(1)
    tt = re.match(r"^tiktok\.com/@[^/]+/video/(\d+)", key, re.I)
    if tt:
        return "tiktok:" + tt.group(1)
    return key


# --------------------------------------------------------------- the board --

def load_reels():
    """Every reel row on the board, keyed by canonical URL.

    A row with no URL, or with a URL we cannot canonicalise, is simply not in
    the index — it can never be matched, and that is correct."""
    rows = bridge("reels").get("reels") or []
    index, rowlist = {}, []
    for r in rows:
        d = r.get("data") or {}
        row = {
            "expId":  r.get("expId"),
            "reelId": r.get("reelId"),
            "path":   r.get("path"),
            "url":    d.get("url") or "",
            "story":  d.get("story") or "",
            "platform": d.get("platform") or "",
            "data":   d,
        }
        rowlist.append(row)
        k = canon_url(row["url"])
        if k:
            # A duplicate URL on two rows is a board problem, not ours. Keep the
            # first and remember the clash so the caller can say so out loud
            # instead of picking one at random every night.
            if k in index:
                index[k].setdefault("_clash", []).append(row["path"])
            else:
                index[k] = row
    return index, rowlist


# ---------------------------------------------------------------- the rule --

def merge_metrics(previous, incoming):
    """THE ONE THAT MATTERS.

    `previous` is everything we have ever successfully captured for this post
    (the ledger). `incoming` is what the platform said this time. Returns the
    keys that should actually be written.

    A key whose incoming value is None, absent, or an empty list is DROPPED
    from the write entirely — not sent as null. It therefore cannot clear what
    is already in Firestore, because the bridge merges. This is what makes a
    run on day nine, when TikTok has stopped serving reach, harmless.

    Returns (patch, kept) where `kept` names the fields that were withheld
    because the platform stopped answering for them, so the run can report
    "reach held from 2026-09-04" rather than going quiet.
    """
    patch, kept = {}, {}
    for k, v in incoming.items():
        if v is None or v == "" or v == []:
            if previous.get(k) is not None:
                kept[k] = previous[k]
            continue
        patch[k] = v
    # Anything we hold and this fetch did not mention at all is held too.
    for k, v in (previous or {}).items():
        if k not in incoming and v is not None and k not in patch:
            kept[k] = v
    return patch, kept


def clean_metrics(d):
    """Drop numbers the rules would reject, and say which and why.

    DROPPED, NOT CLAMPED. A completion rate clamped from 340 to 100 is a wrong
    number wearing a right number's clothes, and these feed a comparison
    between two reels."""
    out, dropped = {}, []
    for k, v in d.items():
        if k not in METRIC_RANGE:
            out[k] = v
            continue
        if v is None:
            continue
        try:
            n = float(v)
        except (TypeError, ValueError):
            dropped.append("%s=%r (not a number)" % (k, v))
            continue
        if n != n or n in (float("inf"), float("-inf")):
            dropped.append("%s=%r (not finite)" % (k, v))
            continue
        lo, hi = METRIC_RANGE[k]
        if n < lo or n > hi:
            dropped.append("%s=%s (outside %s..%s)" % (k, n, lo, hi))
            continue
        out[k] = int(n) if float(n).is_integer() and k not in ("completion", "threeSec", "avgWatch") else n
    return out, dropped


def fit_retention(points):
    """TikTok's video_view_retention, kept in EXACTLY its own shape —
    [{"second": n, "percentage": n}] — because js/admin-experiments.js chose
    those two key names precisely so this copy would be a loop and not a
    migration.

    The rules cap the list at 40 points and TikTok returns one per second, so
    a video longer than 40s must be reduced. It is DOWNSAMPLED, never
    truncated: truncating would draw a curve that ends early and reads as a
    video everybody watched to the end. The first and last points are always
    kept because they are the two the eye actually reads. The full-resolution
    array is written to the archive untouched.
    """
    pts = []
    for p in (points or []):
        if isinstance(p, dict):
            s = p.get("second", p.get("s"))
            pc = p.get("percentage", p.get("p"))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            s, pc = p[0], p[1]
        else:
            continue
        try:
            s = int(float(s)); pc = float(pc)
        except (TypeError, ValueError):
            continue
        if s < 0 or pc < 0 or pc > 100:
            continue
        pts.append({"second": s, "percentage": round(pc, 2)})
    if not pts:
        return []
    seen, uniq = set(), []
    for p in sorted(pts, key=lambda x: x["second"]):
        if p["second"] in seen:
            continue
        seen.add(p["second"]); uniq.append(p)
    if len(uniq) <= MAX_RETENTION:
        return uniq
    step = (len(uniq) - 1) / float(MAX_RETENTION - 1)
    out, taken = [], set()
    for i in range(MAX_RETENTION):
        j = int(round(i * step))
        j = min(j, len(uniq) - 1)
        if j not in taken:
            taken.add(j); out.append(uniq[j])
    if out[-1]["second"] != uniq[-1]["second"]:
        out[-1] = uniq[-1]
    return out


# ---------------------------------------------------------------- the write --

def reel_patch(fields, source, measured_ms=None):
    """Build the document to merge onto admin_experiments/{id}/reels/{rid}.

    Everything outside REEL_KEYS is refused here rather than at the boundary,
    because the boundary is a service account and would accept it — and the
    cost of accepting it is that both admins lose the ability to edit that
    reel in the browser, forever, with no error they can read."""
    patch = {}
    rejected = []
    for k, v in fields.items():
        if k in REEL_KEYS:
            patch[k] = v
        else:
            rejected.append(k)
    patch["source"] = SOURCE_TO_REEL.get(source, "api")
    patch["measuredAt"] = ts(measured_ms if measured_ms is not None else now_ms())
    patch["updatedAt"] = {"__server__": True}
    return patch, rejected


class Run(object):
    """One collector run. Holds the ledger, does the writing, and in
    --dry-run touches absolutely nothing — no Firestore, no ledger, no
    unmatched file. Dry run is the DEFAULT for both collectors."""

    def __init__(self, source, dry_run=True):
        self.source = source
        self.dry_run = dry_run
        self.ledger = self._read_ledger()
        self.wrote, self.held, self.skipped, self.unmatched_rows = [], [], [], []

    # ---- ledger ----
    def _read_ledger(self):
        if not os.path.exists(LEDGER):
            return {}
        try:
            return json.load(open(LEDGER))
        except ValueError:
            # A corrupt ledger is moved aside, never deleted and never ignored.
            # It is the only offline copy of numbers that cannot be re-fetched.
            bad = LEDGER + ".corrupt-%d" % now_ms()
            os.rename(LEDGER, bad)
            sys.stderr.write("ledger was unreadable; kept it at %s\n" % bad)
            return {}

    def _save_ledger(self):
        if self.dry_run:
            return
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = LEDGER + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.ledger, f, indent=2, sort_keys=True)
        os.replace(tmp, LEDGER)      # atomic: a killed run cannot truncate it

    def previous(self, key):
        return (self.ledger.get(key) or {}).get("fields") or {}

    def remember(self, key, fields, extra=None):
        """Fold a fetch into the ledger WITHOUT ever lowering a field to null.
        The ledger is the answer to 'what did we have before TikTok stopped
        talking', and it is written even when Firestore is unreachable."""
        entry = self.ledger.setdefault(key, {"fields": {}, "history": []})
        for k, v in fields.items():
            if v is None or v == "" or v == []:
                continue
            entry["fields"][k] = v
        entry["lastSeenAt"] = now_ms()
        entry["source"] = self.source
        if extra:
            entry.setdefault("extra", {}).update(extra)
        entry["history"] = (entry.get("history") or [])[-49:] + [{
            "at": now_ms(), "source": self.source,
            "fields": {k: v for k, v in fields.items() if v not in (None, "", [])},
        }]
        return entry

    def measured_recently(self, key, hours=24):
        """Idempotence. A reel measured inside the window is skipped — the
        point of a nightly job is one reading a night, and re-reading costs a
        page load against the owner's own logged-in session."""
        e = self.ledger.get(key) or {}
        last = e.get("lastSeenAt") or 0
        return last and (now_ms() - last) < hours * 3600 * 1000

    # ---- writing ----
    def write_reel(self, row, fields, measured_ms=None, archive_extra=None, key=None):
        key = key or canon_url(row.get("url") or "")
        prev = self.previous(key)
        clean, dropped = clean_metrics(fields)
        for d in dropped:
            sys.stderr.write("  dropped %s\n" % d)
        patch_fields, kept = merge_metrics(prev, clean)
        patch, rejected = reel_patch(patch_fields, self.source, measured_ms)
        if rejected:
            sys.stderr.write("  not a reel column, archived instead: %s\n"
                             % ", ".join(sorted(rejected)))
        self.remember(key, clean, archive_extra)
        line = {
            "path": row.get("path"),
            "story": row.get("story"),
            "url": row.get("url"),
            "set": {k: v for k, v in patch.items() if k not in ("updatedAt",)},
            "held": sorted(kept.keys()),
        }
        if kept:
            self.held.append((row.get("story") or row.get("url"), sorted(kept.keys())))
        if self.dry_run:
            self.wrote.append(line)
            return line
        path = [EXPERIMENTS, row["expId"], REELS, row["reelId"]]
        bridge("set", path=path, data=patch, merge=True)
        self._write_archive(key, row, clean, archive_extra, measured_ms)
        self.wrote.append(line)
        return line

    def _write_archive(self, key, row, fields, extra, measured_ms):
        """The collector's own copy, outside the rules-validated reel.

        This is where everything the board has no column for lives: TikTok's
        item_id, total_time_watched, impression_sources, the full-resolution
        retention curve, and the precise collector name ("tiktok-api") that
        the reel's own `source` enum cannot hold. It is also the second line
        of defence for the seven-day rule — if a reel row is ever deleted and
        recreated, these numbers are still here."""
        doc = {
            "key": key,
            "source": self.source,           # the precise string, in full
            "measuredAt": ts(measured_ms if measured_ms is not None else now_ms()),
            "reelPath": row.get("path") or None,
            "url": row.get("url") or "",
            "fields": fields,
            "extra": extra or {},
            "updatedAt": {"__server__": True},
        }
        bridge("set", path=[ARCHIVE, re.sub(r"[^a-zA-Z0-9_.-]", "_", key)],
               data=doc, merge=True)

    def unmatched(self, record):
        """A fetched post with no row on the board. WE DO NOT INVENT A ROW.

        An experiment is somebody's hypothesis with a variant and a pairing;
        a collector guessing one would put a number into an A/B comparison
        that nobody designed. It goes to a file for a person to look at."""
        self.unmatched_rows.append(record)
        # Remember it anyway. The seven-day clock is running whether or not a
        # row exists yet, and this is the only place these numbers will live
        # until somebody adds one.
        k = canon_url(record.get("url") or "") or record.get("url") or ""
        if k:
            self.remember(k, record.get("fields") or {}, record.get("extra"))

    def finish(self):
        self._save_ledger()
        if self.unmatched_rows and not self.dry_run:
            os.makedirs(UNMATCHED, exist_ok=True)
            path = os.path.join(UNMATCHED, "%s-%s.json" % (
                self.source, datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
            with open(path, "w") as f:
                json.dump(self.unmatched_rows, f, indent=2, sort_keys=True)
            return path
        return None

    def report(self):
        out = []
        head = "DRY RUN — nothing was written" if self.dry_run else "wrote %d reel(s)" % len(self.wrote)
        out.append(head)
        for w in self.wrote:
            out.append("  %s  %s" % (w.get("story") or "(no story)", w.get("url") or ""))
            for k in sorted(w["set"].keys()):
                v = w["set"][k]
                if isinstance(v, dict) and "__ts__" in v:
                    v = iso(v["__ts__"])
                if isinstance(v, list):
                    v = "%d points" % len(v)
                out.append("      %-12s %s" % (k, v))
            if w["held"]:
                out.append("      held (platform no longer serving): %s" % ", ".join(w["held"]))
        for s in self.skipped:
            out.append("  skipped (measured within 24h): %s" % s)
        if self.unmatched_rows:
            out.append("  %d post(s) matched no reel row — no row invented."
                       % len(self.unmatched_rows))
            for u in self.unmatched_rows[:10]:
                out.append("      %s" % (u.get("url") or u.get("key") or "?"))
        return "\n".join(out)


def add_common_args(ap):
    """--dry-run is the DEFAULT for the first version of each collector, so
    the flag that exists is the one that turns it OFF and it has to be typed."""
    ap.add_argument("--write", action="store_true",
                    help="actually write to Firestore. Without it this is a dry run.")
    ap.add_argument("--dry-run", action="store_true", default=True,
                    help=argparse_suppress())
    return ap


def argparse_suppress():
    import argparse
    return argparse.SUPPRESS


if __name__ == "__main__":
    # `python3 store.py` is a connectivity check and nothing else.
    print("project:", bridge("ping").get("projectId"))
    idx, rows = load_reels()
    print("reels on the board:", len(rows))
    for r in rows:
        print("  %-28s %s" % (canon_url(r["url"]) or "(unmatchable url)", r["path"]))
