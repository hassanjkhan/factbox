#!/bin/bash
# ---------------------------------------------------------------------------
# What has to be true before anything is committed.
#
# This exists because of a specific failure, not as ceremony. A commit staged
# with `git add -A` swept up the deletion of CNAME — the one file whose absence
# takes the WHOLE SITE down, silently, while every other check stays green. The
# staged file list was read that day, but read for leaked secrets, which was the
# habit. The deletion was in the same list and went straight past.
#
# So the first section is deletions, and it REFUSES rather than warns. Everything
# after it is the suite that already existed.
#
#   bash tools/precommit.sh                 # run it
#   ALLOW_DELETIONS=1 bash tools/precommit.sh   # when a deletion IS the point
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
red()  { printf "\033[31m%s\033[0m\n" "$1"; }
grn()  { printf "\033[32m%s\033[0m\n" "$1"; }
head_() { printf "\n\033[1m%s\033[0m\n" "$1"; }

head_ "1 · what is being REMOVED"
DEL=$(git diff --cached --name-status --diff-filter=D | awk '{print $2}')
REN=$(git diff --cached --name-status --diff-filter=R | awk '{print $2" -> "$3}')
if [ -n "$DEL" ] || [ -n "$REN" ]; then
  [ -n "$DEL" ] && { red "  DELETING:"; echo "$DEL" | sed 's/^/    /'; }
  [ -n "$REN" ] && { red "  RENAMING:"; echo "$REN" | sed 's/^/    /'; }
  if [ "${ALLOW_DELETIONS:-0}" = "1" ]; then
    echo "  ALLOW_DELETIONS=1 — taken as deliberate."
  else
    red "  Refusing. If these are meant, re-run with ALLOW_DELETIONS=1."
    FAIL=1
  fi
else
  grn "  nothing removed"
fi

head_ "2 · secrets in the staged content"
# `:(exclude)` this file: it is the scanner, so its own patterns match itself
# and it refused its own first commit. That is a real hole — this one file's
# staged lines are not scanned — so it is the ONE exclusion, it is named
# literally rather than by glob, and the only thing that belongs in it is a
# pattern. Never widen this.
HITS=$(git diff --cached -U0 -- . ':(exclude)tools/precommit.sh' | grep -E "^\+" \
  | grep -EinC0 'sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|phx_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|"private_key"' \
  | head -5)
if [ -n "$HITS" ]; then red "  possible credential in staged lines:"; echo "$HITS" | sed 's/^/    /'; FAIL=1
else grn "  none"; fi

head_ "3 · the checks"
run() { printf "  %-26s " "$1"; shift; if out=$("$@" 2>&1); then echo "$(echo "$out" | tail -1)"; else red "FAILED"; echo "$out" | tail -3 | sed 's/^/      /'; FAIL=1; fi; }
run "check-structure"     python3 tools/check-structure.py
run "check-regressions"   node tools/check-regressions.js
run "check-analytics"     node tools/check-analytics.js
run "check-account-cache" node tools/check-account-cache.js
run "check-stripe"        node tools/check-stripe.js

head_ "4 · the composed pages are current"
before=$(md5 -q story.html 2>/dev/null)
python3 tools/compose.py >/dev/null 2>&1
after=$(md5 -q story.html 2>/dev/null)
if [ "$before" != "$after" ]; then
  red "  compose.py changed story.html — the composed pages were stale. Stage them."
  FAIL=1
else grn "  story/cleopatra/firststory match read.html"; fi

head_ "5 · every asset URL carries its file's content hash"
# This section exists because of an hour spent on a deploy that HAD shipped.
# The funnel was live, incognito showed it, the owner's normal Chrome profile
# ran the previous scripts out of its cache and he reported "not shipped"
# three times. GitHub Pages sends max-age=600 and nothing in the repo moved
# the URL, so a returning browser had no reason to fetch anything again.
#
# The stamp is only worth having if it cannot be forgotten, and the moment it
# is forgotten is not when a page is edited — it is when a JS file is edited
# and the pages that load it are not touched at all. So this checks EVERY
# shipped page against the assets on disk, not just the ones in the staged
# list, which is why a commit that only changes js/ can fail here.
#
# It refuses; it does not restamp. Rewriting seventeen files underneath a
# committer who typed `git commit` is how content nobody reviewed gets into a
# commit — the same reasoning as section 1. Section 4 has already re-run
# compose, so story/cleopatra/firststory are current by the time we get here;
# these are the other seventeen.
if out=$(python3 tools/stamp-assets.py --check 2>&1); then
  grn "  $(echo "$out" | tail -1)"
else
  echo "$out" | sed 's/^/  /'
  red "  Out-of-date asset URLs. Browsers will keep serving the old files."
  red "  Fix with:  python3 tools/stamp-assets.py && python3 tools/compose.py"
  red "  then stage the pages it rewrote."
  FAIL=1
fi

echo
if [ "$FAIL" = "0" ]; then grn "ready to commit"; else red "NOT ready — fix the above"; fi
exit $FAIL
