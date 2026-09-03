# Where we got to — 3 September 2026

Written because the session ran out of budget mid-flight. Everything below is
either **pushed and live**, **half-finished in the working tree**, or **not
started**. Read the three lists before doing anything.

## Pushed and live

Every commit from `bab525b` to `79d84aa`. Highlights, newest first:

- Account page stripped to Name, Signed in as, Manage billing, Sign out.
- Pricing centralised in `js/account.js`. **Stripe charges $35.88/year, not
  $35.** Quarterly retired from the offer (`offered:false`) without touching
  the Stripe price, so existing quarterly subscribers are unaffected.
- `/stories` deprecated. It forwards to `/explore` **carrying the query
  string**, because Stripe returns every buyer to
  `stories.html?unlocked=1&session_id=…` and that URL is set in the Stripe
  dashboard, not here. Verified both paid paths.
- "Season one" removed site-wide; legal footer rows centred.
- Explore: headline no longer swaps for returning readers; subtitle swaps only
  for a subscriber; all 51 stories listed below the series.
- Privacy policy rewritten against what the code actually does.
- Support form delivers to a Cloud Function.
- Analytics: only transmits from factbox.app, identifies the reader, per-page
  and per-control events, onboarding answer + dwell + abandon.
- Paper/DM Sans repaint; reader stays night. `/firststory` asks for the signup.

## Half-finished in the working tree — DO NOT PUSH AS IS

Check `git status` first; these were live when the budget ran out.

| Files | State |
|---|---|
| `js/today.js`, `css/today.css` | **Instagram-style mosaic, mid-build.** Its own last note: "rows collapse at 4 columns and the last row leaves holes". `/explore` still renders and passes checks, but the mosaic is not finished. Either finish it or `git checkout` those two files. |
| `join.html`, `css/join.css`, `start.html`, `js/start.js` | **Onboarding rebuild, mid-flight.** `join.html` links `/css/join.css` which may not exist — a 404 on every load. Fix that first whichever way you go. |
| `js/progress.js`, `js/saves.js`, `js/progress-sync.js`, `firestore.rules` | **Reading progress and saves moving to Firestore.** Unverified. |

## The bug that is still live and matters most

**Signed-out readers see the previous reader's history.** `/explore` and
`/library` show finished ticks, progress bars and saved stories from whoever
last used the browser, because both live in localStorage with no notion of
who wrote them. On a shared or public machine that is somebody else's
activity on display. The fix is the Firestore work above: account is the
record, browser is a cache, clear on sign-out, paint from cache then correct.

## Not started

- **Paywall redesign.** Full spec given: 3 days free → $35/year, no pricing
  table, story-completion screen before any pricing, "View other plans" as a
  bottom sheet, return the buyer to the story they were trying to read.
  Blocked on the Stripe price below.
- **Story completion screen** and first-story-free flow.
- **Design consistency and functionality audits** — dispatched, killed before
  reporting. Worth re-running.
- **Legibility audit** — same.

## What only Hassan can do

1. **Create a $35.00/year price in Stripe.** There is no $35 price today;
   annual charges $35.88. `STRIPE.md` §7 is the click-path. Add a new price,
   never edit the old one — Stripe will not — then a new Payment Link with a
   3-day trial and the redirect
   `https://factbox.app/stories?unlocked=1&session_id={CHECKOUT_SESSION_ID}`.
   Send the new `buy.stripe.com` URL back; `link` and `amountCents` change
   together in one edit. Archiving the old price never touches an existing
   subscription.
2. **Fix the product description** — all three prices say "Monthly
   subscription for Factbox", wrong on quarterly and annual checkout pages.
3. **Deploy the PostHog Worker** if the ad-blocker loss matters:
   `cloudflare/README.md`. Two routes, `factbox.app/ink/*` AND
   `www.factbox.app/ink/*`. Until then everyone stays on the direct host.
4. **Decide on `terms.html`.** It still offers phone sign-in, which we
   removed, and still says access cannot move to a second phone, when signing
   in is now how it moves. It also still carries the "not reviewed by a
   lawyer" line that `privacy.html` lost, so the two documents disagree.
5. Rename the Stripe product if "season one" should be gone from there too —
   `js/account.js:73` quotes it deliberately.

## Routed but not applied

`join.html` L1065 and L1121 use `p.perMonthText`; both must become
**`p.perMonthAbout`**. $35.88 divides into exactly $2.99 so today's copy is
true, but $35.00 does not — it rounds to $2.92, twelve of which is $35.04.
The moment the price moves, `perMonthText` quotes a figure nobody is charged.

## How to check anything

```
python3 -m http.server 8899 &            # or tools/serve-like-pages.py 8899 .
cd tools && npm install
node check-page.js "<page>" "<selector>" "<text>"
node drive-start.js                       # onboarding, 85 assertions
node check-regressions.js                 # 9 bugs that must not come back
node check-analytics.js                   # 13 instrumentation guards
node check-plates.js "<page>" "<sel>"     # every cover has a fallback
cd .. && python3 tools/check-structure.py # comments, body, head, preloads
```

`tools/serve-like-pages.py` resolves `/foo` to `foo.html` the way GitHub Pages
does. A plain `http.server` does not, which will make a clean-URL redirect
look broken when it is not — that cost an hour today.

`tools/check-shelf.js` is stale: it asserts a buy bar that no longer exists.
Retarget or delete it; a check that always fails gets ignored.
