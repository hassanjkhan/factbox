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
node check-page.js  "index.html"     ".card"    "Be disgustingly"
node check-page.js  "start.html"     "button"   "Remember history"
node check-page.js  "credits.html"   "table tr" "Share-alike"
```

Each exits non-zero on a script error, on finding none of the expected
elements, or on missing expected text.

`compose.py` carries the cheaper half of the same idea: it refuses to build a
page whose script looks up an id the page does not contain.

## Structure

```sh
python3 check-structure.py          # audit every page
python3 check-structure.py --save   # record the current counts as the baseline
```

Counts the things that must balance in every page: comment delimiters, `<body>`,
`<head>`, one navigation bar, `<script>`/`</script>`, and the number of
`<link rel="preload">` tags, which is compared against a recorded baseline.

It exists because a script removing an inline block from nine pages located the
block by prose in the comment ABOVE it, walked back to the previous `<script`
tag, and cut everything in between — six preload links and the opening `<!--`
of a comment whose `-->` was left behind. An unterminated comment does not
fail: the browser swallows the rest of the document. The page rendered nothing,
and the HTML validated, `node --check` passed, the URL returned 200, and
`check-page.js` said "script errors: none" — because there was no longer a
script for it to find.

Run it before every push. It takes about a tenth of a second.

