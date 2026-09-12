#!/bin/zsh
# nightly.sh — what launchd runs. One reading a night, and a log either way.
#
# EACH COLLECTOR IS ALLOWED TO FAIL WITHOUT TAKING THE OTHER DOWN. TikTok's
# token can expire and Instagram's session can hit a checkpoint on the same
# night; neither is a reason to skip the other, and the seven-day clock is
# running on both.
set -u
HERE="${0:A:h}"
LOG="$HERE/state/nightly.log"
mkdir -p "$HERE/state"

say() { print -r -- "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; }

say "--- run start ---"

# TikTok: headless, no GUI needed, safe to run whenever.
if /usr/bin/env python3 "$HERE/tiktok.py" --write >> "$LOG" 2>&1; then
  say "tiktok ok"
else
  say "tiktok FAILED (exit $?) — see above"
fi

# Instagram: opens a REAL Chrome window and therefore needs a logged-in macOS
# session. Under launchd that means a LaunchAgent while the owner is logged in,
# not a LaunchDaemon. If the Instagram session has lapsed this exits 2 and says
# so in the log; it never tries to sign itself in.
if /usr/bin/env python3 "$HERE/instagram.py" --measure --write >> "$LOG" 2>&1; then
  say "instagram ok"
else
  say "instagram FAILED (exit $?) — usually a lapsed session; sign in by hand"
fi

say "--- run end ---"

# Keep the log from growing without limit.
if [[ -f "$LOG" ]] && (( $(wc -c < "$LOG") > 2000000 )); then
  tail -c 500000 "$LOG" > "$LOG.trim" && mv "$LOG.trim" "$LOG"
fi
