#!/usr/bin/env python3
"""
instagram.py — the owner's OWN Instagram reel numbers, read out of a browser
he is already signed into.

WHY A BROWSER AND NOT AN API. Instagram exposes no per-second retention curve
through any API it has ever published, and the Graph API's insights for a
reel require an app review that does not grant the one series this board
exists to compare. The numbers are on the owner's own professional dashboard,
in his own browser, and that is where they are read from.

THE THINGS THAT ARE NOT NEGOTIABLE IN THIS FILE:

  NO PASSWORD. Ever. There is no credential parameter, no prompt, no keychain
  read, no typing into a login form, and there must never be one. The owner
  signs into a dedicated Chrome profile ONCE, by hand. This inherits the
  session through --user-data-dir and nothing else.

  IF THE SESSION IS GONE, WE STOP. A logged-out page, a checkpoint, a
  two-factor prompt: the run ends immediately with an instruction for a
  human. No retry, no second attempt, no "solving" a challenge. A script that
  retries a failed Instagram session is a script that gets the account
  restricted, and this is the owner's own business account.

  HEADFUL. Headless is the strongest automation signal there is.

  SLOW AND BOUNDED. Seconds between navigations, one page at a time, a hard
  cap on pages per run. A bug in a loop cannot become a thousand requests.

  ONLY HIS OWN PAGES. The username is read off the signed-in page, never
  supplied; the only reel URLs visited are ones already written on the board.
  No hashtag crawl, no explore, no follower graph, no other account.

THE EXTRACTOR IS DELIBERATELY NOT WRITTEN YET, AND THAT IS THE POINT.

Nobody has seen what that signed-in dashboard actually contains. Instagram's
layout differs by account type and changes without notice, and a selector
written from imagination does not fail loudly — it matches the wrong number
and writes it to a row that a decision gets made from. So the first run is
`--discover`, which REPORTS what is on those pages into tools/collect/discovered/
and extracts nothing. `--measure` then reads tools/collect/ig-labels.json,
which is a mapping from the label text ACTUALLY OBSERVED in that dump to the
board's metric keys, and refuses to run until that file exists. See
ig-labels.example.json.
"""

import argparse, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store

HERE      = os.path.dirname(os.path.abspath(__file__))
DRIVER    = os.path.join(HERE, "_ig_browser.js")
DISCOVER  = os.path.join(HERE, "discovered")
LABELS    = os.path.join(HERE, "ig-labels.json")
PROFILE   = os.path.expanduser("~/.factbox-keys/chrome-ig")

SIGN_IN_BY_HAND = (
    "\n  Sign in by hand, once — nothing here will ever type a password:\n\n"
    "    open -na \"Google Chrome\" --args --user-data-dir=%s https://www.instagram.com/\n\n"
    "  Sign in in that window, clear any checkpoint, leave it signed in, close it,\n"
    "  then run this again." % PROFILE)


def drive(cmd, timeout=600, **kw):
    """One command to the puppeteer driver. The driver owns the browser and
    always closes it, including on a thrown error."""
    req = dict(kw); req["cmd"] = cmd
    try:
        p = subprocess.run(["node", DRIVER], input=json.dumps(req).encode(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except FileNotFoundError:
        store.die("node is not on PATH.")
    except subprocess.TimeoutExpired:
        store.die("the browser run exceeded %ds and was stopped. Nothing was written." % timeout)
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    if not out:
        store.die("the browser driver said nothing. stderr:\n"
                  + (p.stderr or b"").decode("utf-8", "replace")[:900])
    try:
        env = json.loads(out.splitlines()[-1])
    except ValueError:
        store.die("the browser driver returned non-JSON:\n" + out[:900])
    if not env.get("ok"):
        store.die("instagram: " + str(env.get("error")))
    return env


def require_session(res):
    """One place where a dead session ends the run, so there is no path that
    quietly continues past a checkpoint — and none that continues past "I
    could not tell", either.

    The driver answers in three states. "out" is a verified logged-out or
    checkpoint page. "unknown" is neither marker matching, which happens when
    Instagram changes its wording or a navigation did not settle, and it stops
    the run just as hard: the cost of being wrong in the optimistic direction
    is an extractor reading a login screen onto the board."""
    if res.get("signedIn") is False:
        state = res.get("state") or "out"
        if state == "unknown":
            print("Could not tell whether Instagram is signed in: %s" % res.get("why"))
            print("  Stopping rather than guessing. What the page actually said:")
            for line in (res.get("pageHead") or [])[:10]:
                print("      | %s" % line[:100])
            print("  If that looks like a signed-in Instagram, the signed-in markers in")
            print("  _ig_browser.js have gone stale and need updating against this text.")
        else:
            print("Instagram session is not usable: %s" % res.get("why", "unknown"))
            for line in (res.get("pageHead") or [])[:6]:
                print("      | %s" % line[:100])
        print(res.get("instruction") or SIGN_IN_BY_HAND)
        raise SystemExit(2)


# ------------------------------------------------------------- the numbers --

_SUFFIX = {"k": 1000, "m": 1000000, "b": 1000000000}


def parse_count(s):
    """"12.3K" -> 12300. "1,204" -> 1204. "48%" -> 48.0. "0:09" -> 9 seconds.

    Returns None for anything it cannot read, and None is the right answer —
    store.merge_metrics() drops it, so an unreadable number leaves whatever we
    already had alone instead of replacing it with a wrong one.

    NOTE THE PRECISION LOSS THAT IS INHERENT HERE, not a bug in this function:
    Instagram renders large counts abbreviated, so "12.3K" is anywhere from
    12,250 to 12,349. That is what the screen says and it is all the screen
    says. A number read this way is accurate to three significant figures and
    an A/B comparison between two reels both read this way is fine; a
    comparison against a TikTok figure read from the API is not like-for-like
    and the board's `source` field is how that stays visible.
    """
    if s is None:
        return None
    t = str(s).strip().replace(" ", "").replace("\xa0", " ").strip()
    if not t:
        return None
    m = re.match(r"^(\d+):(\d{1,2})$", t)          # 0:09 -> seconds
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    pct = t.endswith("%")
    t = t.rstrip("%").strip()
    m = re.match(r"^([\d][\d,\.\s]*)\s*([KkMmBb])?$", t)
    if not m:
        return None
    num = m.group(1).replace(",", "").replace(" ", "")
    if num.count(".") > 1:
        return None
    try:
        v = float(num)
    except ValueError:
        return None
    if m.group(2):
        v *= _SUFFIX[m.group(2).lower()]
    if pct:
        return round(v, 2)
    return int(v) if float(v).is_integer() else v


def load_labels():
    """The label -> metric map, written BY A PERSON after reading a discovery
    dump. It does not ship with a default, because a default would be a guess
    about a screen nobody has looked at, and a guessed label that happens to
    match writes the wrong number into a row someone decides from."""
    if not os.path.exists(LABELS):
        print("There is no %s yet, so there is nothing to extract with." % LABELS)
        print("""
  This is on purpose. The extractor is driven by the label text that is
  ACTUALLY on the owner's dashboard, and nobody has seen it yet.

    1. python3 instagram.py --discover
    2. read tools/collect/discovered/*.candidates.json — each entry is a
       number that was on the page and the words nearest it
    3. cp ig-labels.example.json ig-labels.json and fill in the real labels
    4. python3 instagram.py --measure      (still a dry run by default)
""")
        raise SystemExit(2)
    try:
        cfg = json.load(open(LABELS))
    except ValueError as e:
        store.die("%s is not valid JSON: %s" % (LABELS, e))
    out = {}
    for metric, pats in (cfg.get("labels") or {}).items():
        if metric not in store.METRIC_RANGE:
            store.die("%s maps to '%s', which is not a metric on the board. "
                      "The ten are: %s" % (LABELS, metric, ", ".join(sorted(store.METRIC_RANGE))))
        out[metric] = [re.compile(p, re.I) for p in (pats if isinstance(pats, list) else [pats])]
    if not out:
        store.die("%s has no labels in it." % LABELS)
    return out


def extract(candidates, labels):
    """Turn the observed {value, label} nodes into board metrics.

    AMBIGUITY IS REFUSED, NOT RESOLVED. If two different numbers on the page
    both match the pattern for one metric, neither is used and the metric is
    reported as ambiguous — because picking the first one is picking at
    random, and this is a file whose entire job is not writing a wrong number
    over a right one."""
    hits, ambiguous = {}, []
    for metric, pats in labels.items():
        found = []
        for c in candidates:
            # Join only the parts that exist, and strip. An empty aria-label
            # used to leave a trailing space on the haystack, which made every
            # ANCHORED pattern ("^views$") silently fail to match "Views" —
            # and a label map that silently matches nothing looks exactly like
            # a screen with no numbers on it.
            hay = " ".join(x for x in [(c.get("label") or "").strip(),
                                       (c.get("aria") or "").strip()] if x)
            if any(p.search(hay) for p in pats):
                v = parse_count(c.get("value"))
                if v is not None:
                    found.append(v)
        uniq = sorted(set(found))
        if len(uniq) == 1:
            hits[metric] = uniq[0]
        elif len(uniq) > 1:
            ambiguous.append("%s matched %s" % (metric, uniq))
    return hits, ambiguous


# ------------------------------------------------------------------ modes --

def do_check(args):
    env = drive("check", pauseMs=args.pause * 1000, maxPages=args.max_pages)
    res = env.get("result") or {}
    if env.get("profileWasFresh"):
        print("The collector's Chrome profile did not exist and has just been created:")
        print("  %s" % PROFILE)
        print("It cannot possibly be signed in yet." + SIGN_IN_BY_HAND)
        raise SystemExit(2)
    require_session(res)
    print("signed in as @%s" % (res.get("user") or "(username not readable)"))
    return res


def do_discover(args):
    """THE FIRST RUN. Reports what is on those pages; extracts nothing."""
    os.makedirs(DISCOVER, exist_ok=True)
    env = drive("discover", outDir=DISCOVER, user=args.user,
                pauseMs=args.pause * 1000, maxPages=args.max_pages)
    res = env.get("result") or {}
    if env.get("profileWasFresh"):
        print("The collector's Chrome profile did not exist and has just been created:")
        print("  %s" % PROFILE)
        print("Nothing was discovered, because it cannot be signed in yet."
              + SIGN_IN_BY_HAND)
        raise SystemExit(2)
    require_session(res)
    print("signed in as @%s" % (res.get("user") or "?"))
    print("dumps written to %s\n" % DISCOVER)
    for f in res.get("found") or []:
        print("  %-24s %s" % (f.get("name"), f.get("url")))
        if f.get("landedOn") and f["landedOn"].rstrip("/") != f["url"].rstrip("/"):
            print("      REDIRECTED TO %s  <- this surface does not exist for this account"
                  % f["landedOn"])
        if f.get("blocked"):
            print("      BLOCKED: %s" % f["blocked"]); continue
        if f.get("error"):
            print("      ERROR: %s" % f["error"]); continue
        print("      %s chars of text, %s numeric nodes" % (f.get("chars"), f.get("candidates")))
        for line in (f.get("head") or [])[:6]:
            print("      | %s" % line[:100])
        for s in (f.get("sampleLabels") or [])[:8]:
            print("      # %s" % s)
        print()
    print("WHAT TO DO WITH THIS: open the .candidates.json files. Each entry is a")
    print("number that was on the page and the words nearest it. Copy the real")
    print("label text into ig-labels.json (see ig-labels.example.json).")
    print()
    print("EXPECT THE PER-SECOND RETENTION CURVE NOT TO BE HERE. On most accounts")
    print("that graph is drawn only in the mobile app. If no dump contains it,")
    print("that one metric comes from ocr.py against a phone screenshot instead.")
    return res


def do_measure(args):
    labels = load_labels()
    index, rows = store.load_reels()
    mine = [r for r in rows if store.canon_url(r.get("url") or "").startswith("instagram:")]
    if not mine:
        print("No reel row on the board has an Instagram URL, so there is nothing to measure.")
        return
    run = store.Run("instagram-web", dry_run=not args.write)
    todo = []
    for r in mine:
        k = store.canon_url(r["url"])
        if not args.force and run.measured_recently(k):
            run.skipped.append(r["url"]); continue
        todo.append(r)
    # The cap is a safety rail, not a preference: one navigation per reel plus
    # the session check, and never more than the run's page budget.
    budget = max(1, args.max_pages - 1)
    if len(todo) > budget:
        print("capping this run at %d reels (of %d) — raise --max-pages to do more."
              % (budget, len(todo)))
        todo = todo[:budget]

    do_check(args)
    for r in todo:
        env = drive("reel", url=r["url"], dumpTo=DISCOVER if args.dump else None,
                    pauseMs=args.pause * 1000, maxPages=args.max_pages)
        res = env.get("result") or {}
        require_session(res)
        if res.get("error"):
            print("  %s: %s" % (r["url"], res["error"])); continue
        hits, ambiguous = extract(res.get("candidates") or [], labels)
        for a in ambiguous:
            sys.stderr.write("  %s: %s — not used\n" % (r["url"], a))
        if not hits:
            print("  %s: no metric matched a label in %s. Nothing written."
                  % (r["url"], os.path.basename(LABELS)))
            continue
        run.write_reel(r, hits, key=store.canon_url(r["url"]),
                       archive_extra={"ambiguous": ambiguous})
    path = run.finish()
    print(run.report())
    if path:
        print("unmatched written to %s" % path)
    if not args.write:
        print("\n(nothing was written — add --write to commit this to Firestore)")


def main():
    ap = argparse.ArgumentParser(
        description="Read the owner's own Instagram reel numbers from a browser he is already signed into.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="is the session alive? one page load.")
    mode.add_argument("--discover", action="store_true",
                      help="THE FIRST RUN. Dump what the dashboard actually contains; extract nothing.")
    mode.add_argument("--measure", action="store_true", help="read the reels on the board.")
    ap.add_argument("--write", action="store_true",
                    help="actually write. Without it this is a DRY RUN, which is the default.")
    ap.add_argument("--user", help="the owner's own handle, if it cannot be read off the page.")
    ap.add_argument("--pause", type=float, default=4.0,
                    help="seconds between navigations. Default 4. Do not lower this.")
    ap.add_argument("--max-pages", type=int, default=40,
                    help="hard cap on page loads per run. Default 40.")
    ap.add_argument("--dump", action="store_true",
                    help="also write each reel page's text/candidates/screenshot to discovered/.")
    ap.add_argument("--force", action="store_true", help="ignore the 24h idempotence window.")
    args = ap.parse_args()

    if args.check:
        do_check(args)
    elif args.discover:
        do_discover(args)
    elif args.measure:
        do_measure(args)
    else:
        ap.print_help()
        print("\nStart with --check, then --discover. See the module docstring for why.")


if __name__ == "__main__":
    main()
