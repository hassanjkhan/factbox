# Checks

The site once shipped with no words on it. The HTML was valid, the JavaScript
parsed, and every URL returned 200 — because none of those checks ever ran the
script. A `getElementById` for an element that had been deleted threw at top
level, before the IntersectionObserver was installed, so the deck was built but
no page ever got `.live`, and captions are `opacity:0` until it lands.

These run the page in a real DOM instead.

```sh
npm install                  # jsdom
python3 -m http.server 8899 --directory .. &

node check-story.js ../build/story.html                # the illustrated deck
node check-page.js  "story.html"      ".beat"  "Cleopatra"
node check-page.js  "cleopatra.html"  ".beat"  "Cleopatra"
node check-page.js  "firststory.html" ".beat"  "Cleopatra"
node check-plates.js "index.html"     ".card"        # every cover has a fallback
node check-regressions.js                            # bugs that must not come back
node check-analytics.js                              # the instrumentation is still there
# NOT stories.html — it is a forwarder now (location.replace to /explore),
# and jsdom cannot navigate, so this reports a script error for a page that
# is working exactly as intended. /explore below is the real coverage.
node check-page.js  "explore.html"   ".card"    "Be disgustingly"
node check-page.js  "read.html?s=02" ".beat"    "seductress"
node check-page.js  "read.html?s=44" ".paywall" "Your next story is already waiting"
node check-page.js  "index.html"     ".card"    "Be disgustingly"
# The apostrophe on that page is &rsquo;, so match a span without one —
# a check that fails on a typographic quote teaches people to ignore it.
node check-page.js  "start.html"     "button"   "actually remember"
node check-page.js  "credits.html"   "table tr" "Share-alike"
```

Each exits non-zero on a script error, on finding none of the expected
elements, or on missing expected text.

`compose.py` carries the cheaper half of the same idea: it refuses to build a
page whose script looks up an id the page does not contain.

**If you change the paywall's copy, change the assertion above with it.** It
used to read `"Two stories are free"`, which was the fine print under a button
that said "Read the rest of this story". That pane is now the trial paywall —
"Keep learning." over the cover of the story being unlocked, then what happens
today and in three days — and neither the sentence nor the button survives. A
check asserting text that no longer exists fails for the wrong reason and then
gets ignored, so the same string is written down in three places and all three
have to move together: here, `ONBOARDING.md` §2, and the
`the paywall check asserts text the paywall renders` entry in
`check-regressions.js`, which exists to make forgetting one of them fail loudly.

## Returning a buyer to their story

**Done.** A reader who taps through to checkout was trying to read one
particular story, and the right thing afterwards is that story rather than a
shelf.

`read.html` writes down which one, into `localStorage.fb_return_v1`, as
`{"s":"<stack id>","at":<ms>}`, immediately before it hands the reader to the
funnel. `explore.html` reads it on arrival: a reader who has paid goes
straight to that story, and the record is consumed either way, so it cannot
fire twice or hijack an ordinary visit later. One hour TTL.

This section said "nothing reads that key yet" for longer than it was true.

It cannot be read here. Stripe's three Payment Links redirect to
`https://factbox.app/stories?unlocked=1&session_id=...`, that URL lives in the
Stripe dashboard (`STRIPE.md` §7 step 6), and `stories.html` forwards to
`/explore` carrying the query string. So the buyer lands on `/explore`, and
nothing on that path belongs to the reader. Finishing it is four lines on
`explore.html`, after `js/gate.js` has claimed `?unlocked=1`:

```js
try {
  var r = JSON.parse(localStorage.getItem("fb_return_v1") || "null");
  localStorage.removeItem("fb_return_v1");
  if (r && r.s && Date.now() - r.at < 3600000) location.replace("/read?s=" + encodeURIComponent(r.s));
} catch (e) {}
```

One hour, so a key left over from a checkout that was abandoned days ago never
hijacks a shelf. `location.replace`, so Back does not bounce off it. And it has
to run **after** the claim, or the reader is redirected away from the page that
was about to unlock them.

The alternative is Hassan's, not a coding session's: change each Payment Link's
redirect to a URL that carries the story, which is `STRIPE.md` §7 step 6 done
three times.

## Structure

```sh
python3 check-structure.py          # audit every page
python3 check-structure.py --save   # record the current counts as the baseline
```

Counts the things that must balance in every page: comment delimiters, `<body>`,
`<head>`, one navigation bar, `<script>`/`</script>`, and the number of
`<link rel="preload">` tags, which is compared against a recorded baseline.

## Analytics

```sh
node check-analytics.js
```

Asserts the measurement has not quietly gone away — which is the way
measurement fails. Every page must load `js/analytics.js`, the file that sends
the `page_open` page view; the onboarding must still record an answer and a
dwell for each of its six questions and where the reader walked away; every
event name must be a literal in the source rather than built at runtime, and
must be legal GA4 (40 characters, `[a-z0-9_]`, not reserved); values must be
clipped to GA4's 100 characters; and nothing a reader typed may appear in any
event.

It exists because `start.html` shipped with no analytics tag at all, so every
event the six-question onboarding fired went nowhere for its whole life — and
the number that came back was zero, which reads exactly like a page nobody
visits.

It exists because a script removing an inline block from nine pages located the
block by prose in the comment ABOVE it, walked back to the previous `<script`
tag, and cut everything in between — six preload links and the opening `<!--`
of a comment whose `-->` was left behind. An unterminated comment does not
fail: the browser swallows the rest of the document. The page rendered nothing,
and the HTML validated, `node --check` passed, the URL returned 200, and
`check-page.js` said "script errors: none" — because there was no longer a
script for it to find.

Run it before every push. It takes about a tenth of a second.

