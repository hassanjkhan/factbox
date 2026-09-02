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

node check-story.js ../story.html                      # illustrated story
node check-page.js  "stories.html"   ".card"    "Season one"
node check-page.js  "read.html?s=02" ".beat"    "seductress"
node check-page.js  "read.html?s=44" ".paywall" "Two stories are free"
node check-page.js  "credits.html"   "table tr" "Share-alike"
```

Each exits non-zero on a script error, on finding none of the expected
elements, or on missing expected text.

`compose.py` carries the cheaper half of the same idea: it refuses to build a
page whose script looks up an id the page does not contain.
