#!/usr/bin/env python3
"""
tiktok.py — the owner's OWN TikTok post data, from the official Accounts API.

    GET https://business-api.tiktok.com/open_api/v1.3/business/video/list/

WRITTEN AGAINST THE DOCS, NOT AGAINST A GUESS. Every request detail below was
read out of TikTok's own machine-readable doc API (doc_id 1762228421622786,
"Get post data of a TikTok account"; 1833997638479041 for the token; and
1746624508278786 for the latency table) rather than inferred from how other
APIs behave. Where the docs DO NOT say — there is exactly one such place, the
`filters` encoding — the code says so out loud at the point it matters.

THIS HAS NEVER BEEN RUN. The Accounts API access application was not approved
when this was written, so there is no token to run it with. It is complete and
it is unverified against a live response. The first real run should be
`--dry-run` (which is the default) with `--raw` so the actual payload can be
read before anything is written.

WHAT THE SEVEN-DAY RULE ACTUALLY SAYS, because the whole design of this file
turns on it, quoted from the doc:

    "If the data for the fields reach, full_video_watched_rate,
     total_time_watched, average_time_watched, impression_sources, and
     audience_countries are unavailable, the reason is usually that the video
     has not been active (viewed/liked/commented/shared) for more than 7 days."

    "Post data will stop updating 365 days after the post is published."

So those six fields go missing while likes/comments/shares/views/favorites
keep coming. A run on day nine returns a PARTIAL row, and a collector that
wrote that row straight through would erase the reach it captured on day two.
That is the worst bug this file could have, and store.merge_metrics() is the
answer: an absent value is never sent, and the write is a merge.

Also from the docs, and the reason a same-day run looks empty:

    everything except item_id / create_time / thumbnail_url / share_url /
    embed_url / caption is T + 24-48 hrs (UTC).

Credentials: ~/.factbox-keys/tiktok.json. The repo is public; nothing here
prints a token, and a refreshed token is written back with mode 0600.
"""

import argparse, json, os, sys, time, urllib.parse, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store

HOST     = "https://business-api.tiktok.com"
LIST_URL = HOST + "/open_api/v1.3/business/video/list/"
TOKEN_URL   = HOST + "/open_api/v1.3/tt_user/oauth2/token/"
REFRESH_URL = HOST + "/open_api/v1.3/tt_user/oauth2/refresh_token/"

KEYFILE = os.path.join(store.KEYS, "tiktok.json")

# max_count's documented maximum is 20 and its default is 10. Asking for more
# than 20 is an error, so this is a ceiling and not a preference.
MAX_COUNT = 20

# The two permission scopes, kept apart because an app approved for one and
# not the other gets an error naming a field rather than a partial row — so
# when --scope says we only have video.list, we must not ask for the rest.
LIST_FIELDS = [
    "item_id", "share_url", "thumbnail_url", "caption", "create_time",
    "video_duration", "likes", "comments", "shares", "favorites",
    "reach", "video_views", "media_type", "is_ad",
]
INSIGHT_FIELDS = [
    "total_time_watched", "average_time_watched", "full_video_watched_rate",
    "video_view_retention", "profile_views", "new_followers",
    "impression_sources",
]

# The six fields TikTok stops serving after 7 days of inactivity. Named here
# so a run can SAY which ones went quiet instead of silently writing less.
# The doc names six; audience_countries is not in that list because this
# collector never asks for it, and reporting a field we did not request as
# "missing" would cry wolf on every healthy run.
PERISHABLE = ["reach", "full_video_watched_rate", "total_time_watched",
              "average_time_watched", "impression_sources"]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")


# ------------------------------------------------------------------ http ----

def _call(url, data=None, headers=None, timeout=60):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("User-Agent", UA)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = (e.read() or b"")[:500].decode("utf-8", "replace")
        store.die("%s %s -> HTTP %s %s" % (req.get_method(), url.split("?")[0], e.code, detail))
    except urllib.error.URLError as e:
        store.die("could not reach %s: %s" % (url.split("?")[0], e.reason))
    try:
        env = json.loads(raw)
    except ValueError:
        store.die("TikTok returned non-JSON:\n" + raw[:500].decode("utf-8", "replace"))
    # The envelope is {request_id, code, message, data} and code 0 is success.
    if env.get("code") != 0:
        store.die("TikTok API error %s: %s (request_id %s)"
                  % (env.get("code"), env.get("message"), env.get("request_id")))
    return env.get("data") or {}


# ------------------------------------------------------------- the token ----

def load_creds():
    """The access token lives ONE DAY. The refresh token lives a year. A
    nightly job on a one-day token would work the first night and fail every
    night after, so refreshing is not a nicety here — it is the difference
    between a collector and a one-shot script."""
    cfg = store.load_key("tiktok", ["client_id", "client_secret", "open_id"])
    if not cfg.get("access_token") and not cfg.get("refresh_token"):
        store.die("%s has neither access_token nor refresh_token.\n"
                  "  Complete the OAuth flow once and save what /tt_user/oauth2/token/\n"
                  "  returns: access_token, refresh_token, open_id." % KEYFILE)
    return cfg


def save_creds(cfg):
    """Write the refreshed token back, 0600, never printed."""
    tmp = KEYFILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, KEYFILE)


def refresh(cfg):
    data = _call(REFRESH_URL, {
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "grant_type": "refresh_token",
        "refresh_token": cfg["refresh_token"],
    })
    cfg["access_token"] = data.get("access_token") or cfg.get("access_token")
    if data.get("refresh_token"):
        cfg["refresh_token"] = data["refresh_token"]
    if data.get("open_id"):
        cfg["open_id"] = data["open_id"]
    cfg["access_token_expires_at"] = store.now_ms() + int(data.get("expires_in") or 86400) * 1000
    if data.get("scope"):
        cfg["scope"] = data["scope"]
    save_creds(cfg)
    return cfg


def ensure_token(cfg, force=False):
    """Refresh when the token is expired, nearly expired, or absent."""
    exp = cfg.get("access_token_expires_at") or 0
    stale = force or not cfg.get("access_token") or (exp and exp - store.now_ms() < 10 * 60 * 1000)
    if stale:
        if not cfg.get("refresh_token"):
            store.die("the TikTok access token is expired and %s has no refresh_token.\n"
                      "  Re-run the authorisation flow by hand." % KEYFILE)
        sys.stderr.write("access token is stale — refreshing\n")
        cfg = refresh(cfg)
    return cfg


def scopes(cfg):
    """`scope` comes back as a comma-separated string from the token call."""
    s = cfg.get("scope") or ""
    if isinstance(s, list):
        return set(s)
    return set(x.strip() for x in s.split(",") if x.strip())


# ---------------------------------------------------------- the video list --

def fetch_videos(cfg, fields, video_ids=None, ad_post_only=False,
                 cursor=None, max_pages=25, raw_dump=None):
    """Page through /business/video/list/.

    PAGINATE ON has_more AND NEVER ON PAGE SIZE. The doc is explicit:

        "Due to our trust and safety policies, it is possible that the
         endpoint returns less than max_count number of videos even if the
         response parameter has_more is true."

    A loop that stopped when a page came back short would silently drop the
    tail of the account's posts.
    """
    out, pages = [], 0
    # `business_id` is the open_id from /tt_user/oauth2/token/ — not a numeric
    # advertiser id, and not the @handle.
    params_base = {"business_id": cfg["open_id"]}
    while pages < max_pages:
        params = dict(params_base)
        # fields is a JSON ARRAY LITERAL in the query string. Not repeated
        # params, not comma-separated — this is the form in TikTok's own curl
        # example, and item_id must always be in it or "an error may occur".
        params["fields"] = json.dumps(fields)
        params["max_count"] = MAX_COUNT
        if cursor is not None:
            # UTC epoch MILLISECONDS, and it means "posted before this".
            params["cursor"] = int(cursor)
        if video_ids:
            # THE ONE THING THE DOCS DO NOT SHOW. `filters` is documented as an
            # object with `video_ids` and `ad_post_only`, but there is no
            # example anywhere in TikTok's doc tree that encodes it in a query
            # string. A JSON object literal is the same convention `fields`
            # uses and is the reasonable inference — it is an inference all the
            # same. If a filtered call ever comes back with the whole account
            # instead of the asked-for ids, THIS LINE is the first suspect.
            params["filters"] = json.dumps(
                {"video_ids": list(video_ids), "ad_post_only": bool(ad_post_only)})
        url = LIST_URL + "?" + urllib.parse.urlencode(params)
        data = _call(url, headers={"Access-Token": cfg["access_token"]})
        got = data.get("videos") or []
        out.extend(got)
        pages += 1
        if raw_dump is not None:
            raw_dump.append({"page": pages, "count": len(got), "data": data})
        if not data.get("has_more"):
            break
        nxt = data.get("cursor")
        if nxt in (None, 0) or nxt == cursor:
            break
        cursor = nxt
    return out


# ----------------------------------------------------------- the mapping ----

def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return f


def retention_points(raw):
    """TikTok's video_view_retention -> the board's `retention`, in EXACTLY
    the shape js/admin-experiments.js already stores: [{second, percentage}].
    Those two key names were chosen on the board precisely so that this is a
    copy and not a migration.

    Two real conversions happen here. `second` arrives as a STRING in the
    docs' own type table, so it is cast. And the percentage's SCALE is not
    documented: the sibling rate field, full_video_watched_rate, is an
    explicit 0-1 rate, so `percentage` may well be too. The board's rules cap
    a percentage at 100 and a curve of 0.98 would chart as 0.98%, which reads
    as a video nobody watched. So: if no point in the curve exceeds 1.0, it is
    treated as a 0-1 rate and scaled. A real retention curve starts at or near
    100% at second 0, so a curve whose maximum is under 1.0 being a percentage
    would mean nobody watched the first second of the video — which cannot be
    true of a video with views. The untouched array goes to the archive either
    way, so if this reading is ever proved wrong the original is still there.
    """
    pts = []
    for p in (raw or []):
        if not isinstance(p, dict):
            continue
        s, pc = _num(p.get("second")), _num(p.get("percentage"))
        if s is None or pc is None:
            continue
        pts.append([int(s), pc])
    if not pts:
        return []
    if max(p[1] for p in pts) <= 1.0:
        pts = [[s, pc * 100.0] for s, pc in pts]
    return store.fit_retention([{"second": s, "percentage": pc} for s, pc in pts])


def to_board(v):
    """One TikTok video object -> (board metric fields, archive extras).

    A field TikTok did not return is left as None and store.merge_metrics()
    drops it before the write. That is the seven-day rule being honoured.
    """
    full = _num(v.get("full_video_watched_rate"))
    fields = {
        "views":       _num(v.get("video_views")),
        "reach":       _num(v.get("reach")),
        "likes":       _num(v.get("likes")),
        "comments":    _num(v.get("comments")),
        "shares":      _num(v.get("shares")),
        # TikTok calls it a favorite; the board's Insights-screen ordering
        # calls the same act a save. Same number, two vocabularies.
        "saves":       _num(v.get("favorites")),
        "profileTaps": _num(v.get("profile_views")),
        # Documented as a float. The docs do not name the unit; seconds is the
        # only reading consistent with video_duration also being a float and
        # with total_time_watched being its sum. If a value ever arrives that
        # is wildly larger than video_duration, it is milliseconds and this is
        # where to fix it — store.clean_metrics() caps avgWatch at 86400, so a
        # millisecond value would be DROPPED rather than silently charted.
        "avgWatch":    _num(v.get("average_time_watched")),
        # full_video_watched_rate is documented as a 0-1 rate (e.g. 0.0395).
        # The board's `completion` is a percentage 0-100.
        "completion":  (full * 100.0) if full is not None else None,
        # THERE IS NO THREE-SECOND-VIEW FIELD IN THIS API. `threeSec` stays
        # absent rather than being derived from the retention curve: the
        # board's other rows have it typed off Instagram's Insights screen,
        # and a number computed a different way would be compared against
        # those as though it were the same measurement.
        "threeSec":    None,
    }
    retention = retention_points(v.get("video_view_retention"))
    if retention:
        fields["retention"] = retention

    created = _num(v.get("create_time"))
    if created is not None:
        # create_time is a STRING holding Unix epoch SECONDS.
        fields["postedAt"] = store.ts(int(created * 1000))

    extras = {
        "itemId": v.get("item_id"),
        "mediaType": v.get("media_type"),
        "isAd": v.get("is_ad"),
        "caption": v.get("caption"),
        "shareUrl": v.get("share_url"),
        "videoDuration": _num(v.get("video_duration")),
        # Not columns on the board, and worth keeping: the seven-day clock is
        # running on these too.
        "totalTimeWatched": _num(v.get("total_time_watched")),
        "newFollowers": _num(v.get("new_followers")),
        "impressionSources": v.get("impression_sources"),
        # The curve at FULL resolution, before it was fitted to the board's
        # 40-point cap, and before the scale heuristic above touched it.
        "videoViewRetentionRaw": v.get("video_view_retention"),
    }
    missing = [f for f in PERISHABLE if f in v and v.get(f) in (None, "", [])]
    missing += [f for f in PERISHABLE if f not in v]
    if missing:
        extras["perishableMissing"] = sorted(set(missing))
    return fields, extras


# ------------------------------------------------------------------ main ----

def main():
    ap = argparse.ArgumentParser(
        description="Collect the owner's own TikTok post metrics into the experiments board.")
    ap.add_argument("--write", action="store_true",
                    help="actually write. Without it this is a DRY RUN, which is the default.")
    ap.add_argument("--video-id", action="append", dest="video_ids",
                    help="only this item_id (repeatable). Uses the `filters` param.")
    ap.add_argument("--ad-post-only", action="store_true",
                    help="filters.ad_post_only — only valid alongside --video-id.")
    ap.add_argument("--since-days", type=int, default=0,
                    help="only posts newer than N days (sets the cursor, which is a 'posted before' boundary, and stops paging past it).")
    ap.add_argument("--max-pages", type=int, default=25,
                    help="hard cap on pages of 20. Default 25 = 500 posts.")
    ap.add_argument("--no-insights", action="store_true",
                    help="ask only for video.list fields — use if video.insights is not approved yet.")
    ap.add_argument("--refresh-token", action="store_true",
                    help="force an access-token refresh before running.")
    ap.add_argument("--raw", metavar="FILE",
                    help="write the untouched API response here. Do this on the first real run.")
    ap.add_argument("--force", action="store_true",
                    help="ignore the 24h idempotence window.")
    args = ap.parse_args()

    cfg = ensure_token(load_creds(), force=args.refresh_token)

    fields = list(LIST_FIELDS)
    have = scopes(cfg)
    if args.no_insights:
        sys.stderr.write("asking for video.list fields only — no retention, no watch time.\n")
    elif have and "video.insights" not in have:
        sys.stderr.write("WARNING: %s lists scopes %s, which does not include video.insights.\n"
                         "  Asking anyway; TikTok will say if it is not granted. Use --no-insights to skip.\n"
                         % (KEYFILE, sorted(have)))
        fields += INSIGHT_FIELDS
    else:
        fields += INSIGHT_FIELDS

    cursor = None
    floor_ms = 0
    if args.since_days:
        floor_ms = store.now_ms() - args.since_days * 86400000

    raw_dump = [] if args.raw else None
    videos = fetch_videos(cfg, fields,
                          video_ids=args.video_ids,
                          ad_post_only=args.ad_post_only,
                          cursor=cursor, max_pages=args.max_pages,
                          raw_dump=raw_dump)
    if args.raw:
        with open(args.raw, "w") as f:
            json.dump(raw_dump, f, indent=2, sort_keys=True)
        sys.stderr.write("raw response written to %s\n" % args.raw)

    run = store.Run("tiktok-api", dry_run=not args.write)
    index, rows = store.load_reels()
    print("board has %d reel row(s); TikTok returned %d video(s)" % (len(rows), len(videos)))

    for v in videos:
        share = v.get("share_url") or ""
        key = store.canon_url(share)
        created = _num(v.get("create_time"))
        if floor_ms and created is not None and created * 1000 < floor_ms:
            continue
        if not args.force and key and run.measured_recently(key):
            run.skipped.append(share or v.get("item_id"))
            continue
        fields_out, extras = to_board(v)
        row = index.get(key)
        if row is None:
            # NO ROW IS INVENTED. An experiment is a hypothesis with a variant
            # and a pairing; a collector guessing one would inject a number
            # into an A/B comparison nobody designed.
            run.unmatched({
                "key": key, "url": share, "itemId": v.get("item_id"),
                "caption": (v.get("caption") or "")[:200],
                "fields": {k: x for k, x in fields_out.items() if x is not None},
                "extra": extras,
            })
            continue
        if row.get("_clash"):
            sys.stderr.write("  %s matches more than one reel row (%s) — skipped, "
                             "fix the duplicate URL on the board.\n"
                             % (share, ", ".join(row["_clash"])))
            continue
        run.write_reel(row, fields_out, archive_extra=extras, key=key)

    path = run.finish()
    print(run.report())
    if path:
        print("unmatched posts written to %s" % path)
    if not args.write:
        print("\n(nothing was written — add --write to commit this to Firestore)")


if __name__ == "__main__":
    main()
