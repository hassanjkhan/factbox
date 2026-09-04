# Working on Factbox

Read this first. It is written for a coding agent picking the repo up cold, and
it exists because most of what will bite you here is not visible in the code.

factbox.app is 51 history stories, 450 cards, one museum painting per card.
Static files on GitHub Pages, a Firebase backend for the parts that must not be
public, and Stripe for the money. There is no build step for the site itself:
what is in the repo is what is served.


## 1. Setup, once

```sh
git clone https://github.com/hassanjkhan/factbox
cd factbox

npm i -g firebase-tools
firebase login                       # your own Google account
firebase projects:list               # should show factbox-7cb97

npm install --prefix tools           # jsdom, for the render checks
cwebp -version || brew install webp   # only needed to add artwork
```

You need Owner or Editor on the Firebase project `factbox-7cb97`. Hassan grants
that in the console under Project settings -> Users and permissions. Confirm it
worked before doing anything else:

```sh
node tools/seed-firebase.js --dry-run
```

`51 stacks, 450 cards, 31 beds` and no error means you are in. This writes
nothing. There is no service-account key anywhere in this repo and there should
never be one — the seeder borrows the token from your own `firebase login`.


## 2. The one rule that matters

**Never ship a page that renders empty.**

This site has shipped a page with no words on it. Twice. Both times every check
passed: the HTML was valid, `node --check` was clean, every URL returned 200.
None of that runs the script. A `getElementById` for a deleted element threw at
the top of the file, before the observer that reveals text was installed, so the
deck was built and no card ever became visible.

So verification means running the page in a DOM and asserting real text is on
the screen. Status codes prove nothing.

```sh
python3 tools/serve-like-pages.py 8899 . &     # NOT python3 -m http.server
cd tools
node check-page.js  "stories.html"   ".card"    "Be disgustingly"
node check-page.js  "read.html?s=02" ".beat"    "seductress"
node check-page.js  "read.html?s=44" ".paywall" "Your next story is already waiting"
node check-page.js  "join"           "#jn-plan" "a year"
node check-story.js ../story.html
node check-backend.js
cd .. && python3 tools/check-structure.py
node tools/check-analytics.js
node tools/check-regressions.js
node tools/check-account-cache.js
```

**Use `tools/serve-like-pages.py`, not `python3 -m http.server`.** It resolves
`/foo` to `foo.html` the way GitHub Pages does; a plain `http.server` 404s every
clean URL on the site and makes a working redirect look broken. Confirm
`/explore` returns 200 before you trust a single result. That has produced a
false failure here more than once.

Each exits non-zero on a script error, on finding none of the expected elements,
or on missing expected text. Run them before every push. If you change anything
about how a page renders, add a case.

`.paywall` on `read.html?s=44` is the conversion sheet. **Both of its sheets are
in the DOM from the first frame**, hidden with `visibility:hidden` rather than
`display:none`, which is what makes that assertion possible: the sheet itself
only appears when the reader scrolls past the boundary, and no jsdom harness
scrolls. `RECOMMEND.md` §4 has the rest.

A checker cannot make the gesture, so the boundary is walked in real Chrome
instead — mouse wheel, trackpad, touch drag and keyboard, plus the bounce that
must **not** open it. `tools/node_modules` already has `puppeteer-core`; drive
`/Applications/Google Chrome.app`.

`tools/compose.py` carries the cheap half of the same idea: it refuses to build
a page whose script looks up an id the page does not contain.


## 3. House rules

- **ES5 only in shipped client code.** Most readers arrive through the Instagram
  and TikTok in-app browsers. No `let`, no `const`, no arrow functions, no
  template literals, no `URLSearchParams`, no `Array.prototype.findIndex`. The
  single exception is `js/auth.js`, which is a Firebase ES module loaded through
  a dynamic `import()`; everything else reaches it through the `whenFBU()`
  bridge described in `AUTH.md`.
- **No framework, no bundler, no npm dependency in the served site.** `tools/`
  may use whatever it likes; `/js` may not.
- **One question, one answer.** "May this person read this?" is answered in
  exactly one place, `js/access.js` (`FBX`). Do not add a second opinion — four
  surfaces once answered it four ways on four different clocks, and paying
  readers got padlocks. Details in section 6 of `SPEC.md`.
- **Never reload the page on an access change.** Use `FBX.correct(drew)`. The
  hand-rolled version of that is how the shelf came to reload forever.
- **No error codes on screen, ever.** A reader sees a sentence, not a status.
- **The immersion is the product.** Do not write copy that explains the
  machinery ("this site is static files", "no server behind them").


## 4. Adding or changing a story

The corpus is `data/stacks.json`: 51 stacks, each with cards carrying `head`,
`body`, an image id, and a credit block. It has **two homes**, and a change has
to reach both:

```sh
node tools/seed-firebase.js --dry-run    # always look first
node tools/seed-firebase.js              # the gated copy, for people who paid
git push                                 # the static copy Pages serves
```

Skip the seeder and subscribers read the old text. Skip the push and everyone
else does. `--dry-run` prints exactly which stories changed.

Artwork is never hotlinked from Wikimedia. Every plate is fetched once,
re-encoded to WebP and re-hosted here:

```sh
python3 tools/ingest_cards.py <manifest.csv> . --workers 2
```

Two workers, not five. Wikimedia returns 429 above that, and the run is
resumable, so a rate-limited run is recoverable but a banned IP is not.

**Licences are not a style choice.** 416 plates are public domain and carry no
condition. 34 are CC BY-SA or CC BY, and for those, naming and linking the
licence on the card is the term that makes using the photograph lawful. That is
why `creditLine()` in `js/gate.js` prints a licence for some plates and not
others. Do not "tidy" it. `tools/build_credits.py` regenerates `credits.html`
from the same data.

Audio: `tools/build-beds.py` makes the ambient beds (seamless loops, built here
rather than licensed, so the provenance is ours), and `tools/build_cardaudio.py`
maps cards to beds in `data/cardaudio.json`.


## 5. Three pages are generated — do not edit them by hand

`story.html`, `cleopatra.html` and `firststory.html` are generated by
`tools/compose.py`. They are cuts of `read.html` pinned to story 01, each with
its own canonical URL, its own share card, and the sign-up ask appended — they
are the marketing funnel, and `/cleopatra` is the link in the founder's bio.
Each file opens with a GENERATED banner. Editing one works right up until the
next compose silently discards it.

Two things compose.py guards, because both have nearly shipped:

  * `read.html` carries `robots: noindex` — correct for a reader URL with a
    query string, and fatal if inherited, because it deindexes the flagship.
    compose strips it and refuses to emit a page that still has it.
  * The three must not share one identity. compose gives each its own
    canonical and `og:url` and fails the build if any is missing.

The illustrated scene deck still composes from `scenes/`, but to `build/`,
which is git-ignored and never served. `tools/check-story.js` asserts that
deck's shape, so run it against `build/story.html`, not the shipped page.

```sh
python3 tools/compose.py     # scenes/ -> story.html, cleopatra.html, firststory.html
```

`scenes/CONTRACT.md` says what the scene files may and may not assume.


## 6. URLs

The site serves clean URLs: `/read`, `/stories`, `/login` — never `.html`.

GitHub Pages resolves `/foo` to `foo.html` **before** `foo/index.html`. A
directory-based clean URL plus a leftover `foo.html` stub therefore serves the
stub, and a stub that redirects to its own clean URL redirects to itself. That
is a real bug this site shipped: "Sign in" led to a white screen reading "Moved
to /login". `curl -L` did not catch it, because following the redirect chain
ends at a 200. Check what a URL actually renders, not what it returns.

Every asset path is root-relative for the same reason: a relative path resolves
differently from inside `/explore/` than from `/`.


## 7. Backend

- **Firestore** holds `customers/{uid}` (`premium`, `admin`), the story
  documents, and onboarding answers. `firestore.rules` is closed by default;
  `customers/{uid}` is readable only by that user and never client-writable —
  only the Stripe webhook writes entitlement.
- **Cloud Functions** (`functions/`, Node 20, us-central1): `stripeWebhook`
  verifies Stripe's signature against `req.rawBody` — not the parsed body — and
  `story.js` serves gated story text to a verified premium caller.
- **Stripe** entitlement arrives by webhook. `client_reference_id` carries the
  Firebase UID; that is the entire link between a payment and an account.
- **Deploys**: `firebase deploy --only functions` / `--only firestore:rules`.
  If a functions deploy fails on Secret Manager, you need the Secret Manager
  Secret Accessor role — that is the Stripe webhook signing secret. Seeding
  stories does not touch it.

`STRIPE.md` is the whole money path — the plan ladder, why the webhook verifies
against `req.rawBody`, why `trialing` and `past_due` count as active, and how to
test without spending anything. Read it before touching `js/account.js` or
`functions/`. `BACKEND.md` and `AUTH.md` are the long versions of the rest. Node 20 is end-of-life for
Cloud Functions on **30 October 2026**; moving to Node 22 is outstanding.


## 8. Known and outstanding

### The conversion flow, and three things in its design that do not ship

The locked-story flow is `RECOMMEND.md` §4. Three things the mockup draws are
deliberately not built, each with a switch and a condition written beside it in
`js/recommend.js`:

- **The two percentages** about what "Factbox members" did in thirty days.
  `PROOF.on` is `false` and `PROOF.stat` is `null`; a copy-only slot renders
  instead. The figures are marked `verified:false` in the mockup's own source
  and are claims about a member base this product does not have. Run the study
  first. See §4e.
- **$35.00.** Stripe charges **USD 35.88**; there is no $35.00 price on the
  account. Every figure on the sheet is read out of `js/account.js`, and
  `tools/check-regressions.js` fails the build on a typed `$<digit>` in
  `js/recommend.js`, `css/recommend.css` or `read.html`. `STRIPE.md` §7 is the
  click-path, and `link` and `amountCents` change together in one edit.
- **"Continue with Apple."** The Firebase project has no Apple provider — the
  identity toolkit answers `OPERATION_NOT_ALLOWED` for `apple.com` and returns
  a real auth URI for `google.com`. `APPLE_ON` carries the four steps, in
  order, and is double-gated on `js/auth.js` growing a `signInApple()`.

**One mismatch to settle, and it is Hassan's, not a coding session's:** the new
design says "no trial", and all three live Payment Links carry
`trial_period_days: 3`. The screens still say "3 days free" because the till
still gives it. If the design is right, the links change first — `STRIPE.md` §7
step 6 on each of the three, then `TRIAL_DAYS` in `js/account.js`. Never the
code first.

### /join no longer asks anything

The five onboarding questions are retired. `/join` is the checkout — an email,
the plan loader, the real prices, sign-in, and the already-paid terminus — and
it is still a real page, because `/start`, `/firststory` and the three composed
story pages all link to it and `SPEC.md` §2.4 forbids a stub. `js/start.js` and
`tools/drive-start.js` went with the questions, and the five guards in
`tools/check-analytics.js` that asserted their instrumentation are replaced by
one that asserts the retirement stayed whole.

**The answers still parse.** `js/account.js` keeps every setter and every
vocabulary, because `js/profile-sync.js`'s `WATCHED` list names them and a
returning reader's stored record still references them. Removing a vocabulary
that a stored record uses is how that reader's profile becomes unreadable.
Nothing about `js/account.js`'s storage layer changed.

Two things this leaves inaccurate, neither of them in a file the conversion
work owns:

- `start.html` still says "A few quick questions and your feed is built" over a
  button reading "Build my feed" that goes to `/join`. There are no questions
  there any more.
- `privacy.html` §04 still lists `start_step`, `start_answer`, `start_abandon`
  and `start_ready`. Nothing sends them now.

### Everything else

- `data/stacks.json` is public. Every word of all 51 stories is readable without
  paying. Hassan knows and has decided to leave it for now; the Firestore path
  exists for when that changes.
- Email sign-ups have no display name yet (needs `FBU.setName()` around
  `updateProfile`).
- Audio is served with long-lived download tokens rather than signed URLs; the
  IAM grant needed for signing was blocked.

## 9. Secrets

This repo is public. Nothing in it is a secret, and nothing in it may become
one — no Stripe key, no webhook signing secret, no service-account JSON, in any
file, commit message or comment.

You should not need any of them. Firebase access comes from your own
`firebase login`; the two Stripe secrets already live in Secret Manager and the
functions runtime, and deploying does not require you to see their values.

If something genuinely needs one, ask Hassan directly and keep it out of the
repo and out of anything that gets logged.


## 10. Ask before

Pricing, the number of free stories, anything in `LEGAL.md`, and anything that
changes what an existing subscriber is charged.
