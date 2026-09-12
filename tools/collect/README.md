# tools/collect — reading the numbers off the two accounts

Two collectors and one fallback, feeding the reel A/B board at
`admin_experiments/{id}/reels/{rid}`. Everything here reads the **owner's own
analytics for the owner's own two accounts**. Nothing touches anyone else's
data, and nothing here handles a password.

| file | what it does | state |
|---|---|---|
| `tiktok.py` | official Accounts API v1.3 `business/video/list/` | complete, **never run** — pending API access |
| `instagram.py` | reads an already-signed-in Chrome profile | plumbing verified; **extractor deliberately unwritten** |
| `ocr.py` | reads an Insights screenshot with macOS Vision, offline | working |
| `store.py` | matching, merging, and the write | verified against live Firestore |
| `_firestore.js` | the only thing that talks to Firestore | verified |
| `_ig_browser.js` | the only thing that drives a browser | launch + session detection verified |
| `_ocr.swift` | Vision text recognition | verified |

## The rule everything here is built around

TikTok stops serving `reach`, `full_video_watched_rate`, `total_time_watched`,
`average_time_watched` and `impression_sources` for a video that has had no
activity for **seven days**, and stops updating post data at all after **365
days**. There is no backfill. A number captured on day two and dropped on day
nine is gone for everybody, permanently.

So: **a null or absent value never overwrites a value we already have.** That
is enforced three times over — `store.merge_metrics()` drops absent keys before
they are sent, every Firestore write is a merge and not a replace, and every
run appends to a local ledger at `state/ledger.json` that is written before the
network is touched. If you change one thing in this directory, do not change
that.

## Dry run is the default

Every script writes nothing until you add `--write`. Start there.

```
python3 store.py                     # connectivity + what is on the board
python3 tiktok.py --raw /tmp/tt.json # dry run, and keep the raw response
python3 instagram.py --check         # is the session alive?
python3 instagram.py --discover      # THE FIRST RUN. see below
python3 ocr.py shot.png --show       # what Vision reads off a screenshot
```

## Instagram: sign in by hand, once

Nothing here will ever store, prompt for, or type an Instagram password. The
collector drives a dedicated Chrome profile at `~/.factbox-keys/chrome-ig/`
that you sign into yourself:

```
open -na "Google Chrome" --args --user-data-dir=$HOME/.factbox-keys/chrome-ig https://www.instagram.com/
```

Sign in, clear any checkpoint, close the window. If the session later lapses or
a challenge appears, the collector stops and tells you to do this again — it
does not retry and it does not attempt to solve a challenge. It runs a visible
Chrome window on purpose; headless is the strongest automation signal there is.

**`--discover` is the first run and it extracts nothing.** It dumps the text,
the numeric nodes and a screenshot of each of the owner's own surfaces into
`discovered/`. You then read those files and write `ig-labels.json` (copy
`ig-labels.example.json`) mapping the label text that is *actually* on the
screen to the board's ten metric keys. `--measure` refuses to run until that
file exists, because a selector written from imagination does not fail loudly —
it matches the wrong number and writes it to a row somebody decides from.

## Keys

`~/.factbox-keys/`, outside the repo, because the repo is public.
`admin.json` is the Firestore service account the other tools already use.
`tiktok.json` needs `client_id`, `client_secret`, `open_id` (the `open_id` from
`/tt_user/oauth2/token/`, which is what the API calls `business_id`), plus
`refresh_token`. The access token lives one day and is refreshed and rewritten
automatically at 0600.

## Installing the nightly job

`com.factbox.collect.plist` runs `nightly.sh` at 02:30 local, which runs both
collectors and logs to `state/nightly.log`. **It is not installed.** To install
it yourself: `cp com.factbox.collect.plist ~/Library/LaunchAgents/` then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.factbox.collect.plist`,
and check it with `launchctl list | grep factbox`. It must be a LaunchAgent and
not a LaunchDaemon because the Instagram collector opens a real Chrome window
and needs you to be logged in; to stop it, `launchctl bootout
gui/$(id -u)/com.factbox.collect`. Run `nightly.sh` by hand once first — the
first TikTok run should be watched, not scheduled.

## Two things that are not obvious

**Nothing here writes a field the board does not already have.** `firestore.rules`
pins a reel's key set with `hasOnly()`, and a service account bypasses rules —
so a collector writing `tiktokItemId` onto a reel would make that reel
permanently uneditable in the browser, for both admins, with no error either of
them could read. `store.REEL_KEYS` is that list, copied, and anything outside it
goes to the `admin_reel_measurements` archive instead. The same applies to
`source`: the rules allow `manual|api|instagram|tiktok`, so the reel carries the
platform name and the precise collector string (`tiktok-api`, `instagram-web`,
`ocr`) is carried in full on the archive document.

**A fetched post with no row on the board does not get one.** An experiment is
somebody's hypothesis with a variant and a pairing; a collector inventing one
would inject a number into an A/B comparison nobody designed. It goes to
`unmatched/` for a person to look at.
