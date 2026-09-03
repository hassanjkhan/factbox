# LEGAL.md — what changed in privacy / terms / support, and what still needs a decision

Rewritten 2 September 2026. Scope: `privacy.html`, `terms.html`, `support.html`.
No other file was touched.

Everything asserted on those three pages was checked against the code that
implements it — `js/gate.js`, `js/progress.js`, `js/saves.js`, `js/owner.js`,
`js/audio-reader.js`, `read.html`, `stories.html` — or against `data/stacks.json`.
Where a fact could not be verified it was left out, and it is listed below
instead.

---

## 1. Why they had to be rewritten

The three pages described **a different product**: an iOS app, distributed
through TestFlight and the App Store, free of charge, with a streak, local
notifications, an in-app feedback form and Apple In-App Purchase. None of that
exists here. This is a paid subscription website.

They were also a second, incompatible design system — light-themed,
`prefers-color-scheme`-switching, with its own `--ground` / `--ink` tokens
holding the opposite values to the ones in `css/app.css`. Tapping "Privacy"
from a dark shelf landed the reader on a white serif document. SPEC §4 forbids
that. All three now load `css/app.css` and nothing else, and follow
`credits.html` as their structural template (`.doc`, `.mark`, `.ghost`-scale
type, one small page-local `<style>`).

## 2. False claims removed

| Claim | Was on | Why it is false |
|---|---|---|
| "Factbox is free. There is no subscription, no in-app purchase, and no advertising. There is nothing to cancel." | terms §03 | The site sells a subscription. |
| "No. Factbox is free, with no subscription, no in-app purchase and no advertising." | support §05 | Same. |
| "Every card cites at least two independent sources." | terms §07, support §01 | **20 of 450 cards** carry a `src` field, and not all 20 are citations — one is the gloss "spiritual apathy, not just laziness". The real figure is under 5%. |
| "…you can read them by tapping the book icon at the bottom of any card." | support §01 | No such control exists in `read.html`. |
| "There is no analytics, no tracking, no advertising identifier, and no third-party code" / "The app contains none" | privacy §02, §08 | `FB.track()` in `js/gate.js` calls `window.plausible(...)`, and 14 call sites use it. |
| "The app makes no network requests of its own. Nothing is uploaded anywhere." | privacy summary | The site fetches `data/stacks.json`, images and audio beds, and sends the reader to a Stripe checkout. |
| "a feedback form in the app, under the You tab" | privacy §04, support, terms §07 | No app, no You tab, no form. |
| Streak, daily reminder, local notifications, reminder time, onboarding name | privacy §02/§03/§07, support §03 | None exist on this site. |
| Apple In-App Purchase; "Managing or cancelling happens in your iOS Settings"; the whole Apple third-party-beneficiary clause | privacy §06, terms §10 | Payment is Stripe. There is no App Store distribution. |
| TestFlight section | privacy §05 | Not applicable to a website. |
| "Applies to: Factbox for iOS" / "Factbox for iOS" mastheads and footers | all three | Scope is now `factbox.app`, the website. |
| "delete the app and your progress is gone" framing | terms §04, support §02 | Correct in substance, wrong in mechanism — it is clearing browser site data, not deleting an app. |
| Dynamic Type / VoiceOver support claims | support §07 | iOS-app claims, unverifiable here. Replaced with the one accessibility fact that **is** verifiable: `css/app.css` honours `prefers-reduced-motion`, and `--tap: 44px`. |
| "read aloud by your own device" (my own first draft) | — | Corrected before shipping: `js/audio-reader.js` plays pre-recorded **ambient sound beds** from `audio/*.mp3` via Web Audio. It is not speech. |

## 3. What the pages now say that they did not before

### privacy.html
- Scoped to the website, not an iOS app.
- Covers the sign-up funnel that landed in parallel (`join.html`, `js/account.js`) — see §7 below.
- **A full table of every localStorage key the code writes**, with what each holds, the caps on the two big ones, and what the values look like. Plus the one `sessionStorage` key.
- **The first-party cookie**: which three values are mirrored, the exact attributes (`path=/`, `SameSite=Lax`, `Secure` on HTTPS, one year), and *why* — in-app webviews from Instagram and TikTok wipe localStorage between sessions but keep cookies, so without it a buyer is asked to pay twice. States explicitly that the reading map and the saves list are **never** put in a cookie.
- **Plausible analytics**: the complete list of event names, that it is cookieless and identifier-free, that it carries at most a story id and a card number, and how to stop it (block `plausible.io`; every call is guarded so the site is identical without it).
- Notes that the illustrated front-page story carries a second, older counter whose `ENDPOINT` is `""`, so it logs to the console and sends nothing.
- **Stripe**: hosted checkout, card details never touch this site, what comes back is a success flag and a session id.
- **The restore link is a bearer token** — its own callout box, in those words, saying that anyone holding it has access.
- Reading progress never leaves the browser, and the symmetrical consequence: we cannot leak it and we cannot restore it.
- **GitHub Pages hosting** and the ordinary request data any web server receives.
- Artwork is re-hosted, so reading a story sends no request to Wikimedia.
- Data rights with concrete mechanics (dev tools to inspect; clear-site-data to delete; the warning that this deletes access too; Stripe holds the billing record).
- A security section that states the two real limits rather than implying a lock: the bearer token, and the fact that the access flag is remembered rather than enforced.

### terms.html
- Describes the actual offer: two free stories, a subscription to a website, Stripe billing, auto-renewal, cancel any time.
- **No prices are stated anywhere.** §03 says the price, billing period and trial "are the ones shown on the checkout page for the plan you pick", and says explicitly that the page does not restate them so it cannot contradict the till. This is deliberate so the incoming three-plan change ($4.99 monthly / $3.99 quarterly / $2.99 annual, 3-day trial) needs **no edit to this page**.
- Trial handled conditionally: "if the plan you choose includes a free trial…", so it stays true whether or not a given plan has one.
- Cancellation section, including the honest mechanical note that cancelling stops billing but does not automatically re-lock an already-unlocked browser, because there is no server.
- Access-and-restore-link section: bearer token, do not share it, clearing site data erases access.
- Accuracy section rewritten to a defensible standard: where a card rests on a specific document or a disputed reading it says so, **not every card carries a citation, and we do not claim otherwise**.
- Ownership section rewritten around the real licensing position (Wikimedia Commons, CC attribution and share-alike named and linked, no adaptation), pointing at `credits.html`.
- Apple sections deleted.

### support.html
- Answers the questions a reader of *this site* actually has, in this order: what it is; what it costs; how to cancel; "I paid and it is asking me to pay again" (the restore link, with the specific Instagram/TikTok in-app-browser warning); what happens to reading progress; nothing is loading; the ambient sound; where the artwork comes from (links `credits.html`); how to report a factual error; suggesting a story; what we know about you; accessibility.
- The restore-link answer tells the reader to save it, keep it private, and what to do if it is lost.

## 4. TODO(owner) — decisions I could not make

1. **TODO(owner): the contact address.** All three pages use `hello@getdonny.com`, which was already in the files. That is a **getdonny.com** address on a **factbox.app** site — a different product's domain. It works, but a reader who checks will wonder who they are writing to, and it weakens the "a person reads this" promise. `hello@factbox.app` would be the natural address. Confirm or change; it appears in 8 places across the three pages (16 occurrences, counting each mailto href and its link text).
2. **TODO(owner): the legal entity.** "Iris Monet Labs LLC, a limited liability company registered in California" is carried forward from the old `terms.html`. I could not verify it exists, that it is the right entity for this site, or that it is the Stripe account holder. If the Stripe account is in a different name, the terms name the wrong counterparty.
3. **TODO(owner): governing law.** Carried forward as California. Consistent with #2; needs the same confirmation. Note that a subscription sold to UK/EU readers pulls in local consumer law regardless of this clause, which is why §10 says so.
4. **TODO(owner): refund policy.** There is none written down anywhere in the repo, so I did not invent one. The pages say only how to *ask* (email us) and that statutory cancellation rights apply where they apply. Decide the actual policy — in particular whether a mid-period cancellation is ever refunded — and state it. Until then support cannot answer the question consistently.
5. **TODO(owner): how a subscriber actually cancels.** `js/gate.js` uses a Stripe hosted Payment Link with `PAY_URL = ""` and there is no customer-portal link anywhere in the site. The pages therefore say "email us and we will cancel it, or use the management link in your Stripe receipt **if** there is one". Enable the Stripe customer portal and put its link in the receipt (and ideally on `stories.html`), then the conditional can be dropped. As written today, cancellation depends on a human reading an inbox.
6. **TODO(owner): keep or drop the "not reviewed by a lawyer" disclosure.** It was in the old `privacy.html` and it is still true, so I kept it — on `privacy.html` and `terms.html`, in a `.note` box near the top and again in the footer stamp. This is your call, not mine: it is unusually candid for a paid product, and removing it while it is still true would be the dishonest option. Either get the review, or leave it.
7. **TODO(owner): Plausible.** `privacy.html` §04 currently states, truthfully, that **no Plausible script is loaded on any page** — I checked every HTML file; `window.plausible` is never defined, so all 14 `FB.track` call sites are no-ops today. `support.html` repeats it. **The moment you add the Plausible snippet, both statements become false.** The event list is already written and correct, so the fix is small — delete the "not currently loaded" sentence in `privacy.html` §04 and the one in `support.html`'s "What do you know about me?" — but it has to happen in the same commit as the snippet.
8. **TODO(owner): the effective date.** Set to 2 September 2026 on both `privacy.html` and `terms.html`, since the documents were materially rewritten. If you would rather the record show continuity from the previous 1 September date, change it before publishing.
9. **TODO(owner): price-change notice.** `terms.html` §03 says a price change "takes effect from a renewal, never part-way through a period you have already paid for" — a factual consequence of Stripe billing. It does **not** promise advance notice of a price change, because I could not commit you to a process. Several jurisdictions expect notice; consider adding it deliberately.
10. **TODO(owner): §11 forfeiture clause.** `terms.html` §11 says that if access is ended for sharing the restore link, the unused part of the paid period is refunded. That is my judgement of what is fair and defensible, not a policy you have set. Confirm it.

## 5. Things I could not verify

- Whether `Iris Monet Labs LLC` exists or is the Stripe account holder (see TODO 2).
- Whether `hello@getdonny.com` is monitored, and the "usually within a couple of days" reply time on `support.html` — carried forward from the old page as a service promise, not a checkable fact.
- Whether any refund has ever been given, or on what basis (TODO 4).
- Whether the Stripe receipt currently contains a subscription-management link (TODO 5). The pages are worded to be true either way.
- The exact plan line-up. `stories.html`'s buy bar currently reads `$3.99/mo` and `read.html`'s paywall says "Cancel any time. Two stories are free to read first." Neither is mine to edit, and neither is contradicted by anything I wrote — the legal pages name no price at all.

## 6. Verification run

Served from `python3 -m http.server 8902`, each page loaded over HTTP in jsdom
with scripts enabled and every subresource request intercepted. All three:
zero script errors; `compatMode === "CSS1Compat"`; `documentElement.lang === "en"`;
`<meta charset>` and `<meta name="viewport">` present; exactly one `<h1>`;
sane heading order; **zero requests to any external host** (the only subresource
any of them fetches is `css/app.css`); all four footer links return 200.
The only off-site references are three `<a href>` links the reader must tap —
`stripe.com`, `stripe.com/privacy`, `plausible.io/privacy` — which fetch nothing
on load.

---

## 7. Late change: the sign-up funnel landed in parallel

While these pages were being rewritten, the agent that owns `join.html`,
`js/account.js` and `js/gate.js` replaced the direct-to-Stripe buy button with a
sign-up funnel. That is a **material privacy change**, and the drafts I had
written up to that point contained the sentence "There is no account, no
sign-up... The site never asks for your name or your email address", which those
files make false. I re-read `js/account.js` and `join.html` and corrected all
three pages before finishing. What is now documented:

- **New storage key and cookie: `fb_acct_v1`.** One JSON record holding a random
  local id, the email address typed at sign-up, first name (optional), topic
  picks, reading frequency, chosen plan, an onboarding-done flag and a created
  timestamp. Capped at 700 bytes; mirrored to a cookie only while it is under
  that cap. Listed in the privacy table beside the other keys.
- **The cookie section now says four names, not three.**
- **"Sign up" is not an account.** No server, no password, no authentication.
  The privacy policy says this in a dedicated subsection, and says plainly that
  logging in on a second device cannot move access — only the restore link can.
  `terms.html` §05 and `support.html` say the same.
- **Two things are transmitted at checkout**, and the policy names both: the
  email as Stripe's `prefilled_email`, and the local id as
  `client_reference_id`. Nothing else about a reader leaves the browser.
- **Nine new analytics event names** added to the privacy list: `join_view`,
  `join_step`, `join_skip`, `join_interests`, `checkout_start`, `join_signup`,
  `join_login_hit`, `join_login_known`, `join_login_miss`, `join_restore_use`.
  The policy states that these carry a step name, a topic count or a plan name —
  and never the email or the answers themselves, which is what the code does.
- The pricing decision holds: `js/account.js` defines the ladder
  (`PRICE_PER_MONTH = { monthly: 4.99, quarterly: 3.99, annual: 2.99 }`,
  `TRIAL_DAYS = 3`, billed 4.99 / 11.97 / 35.88) and **`terms.html` still names
  no number**, so a price move needs no legal edit.

### TODO(owner) items this created

11. **TODO(owner): `FBA.forget()` is not wired to anything.** `js/account.js`
    exports a `forget()` that clears `fb_acct_v1` from both stores, but no page
    calls it — there is no sign-out or "forget me" control anywhere. I removed
    the sentence that referenced one. A stored email address with no in-product
    way to delete it, other than clearing all site data, is the weakest point in
    the current privacy story and the easiest to fix: one button on `join.html`.
12. **TODO(owner): the onboarding answers are collected but unused.** Nothing
    outside `join.html` reads `FBA` — not `recommend.js`, not `explore.js`, not
    `stories.html`. The privacy policy therefore says, accurately, that nothing
    else currently reads them. Asking a reader for topics and pace and then not
    using them is a promise the product has not kept yet; either wire it up or
    drop the questions, and tell me so the sentence can change.
13. **TODO(owner): these three pages now depend on the funnel shipping.** If
    `join.html` and `js/account.js` are pulled before launch, delete: the
    `fb_acct_v1` table row and the "The sign-up record" subsection in
    `privacy.html` §02; the fourth cookie name in §03; the `join_*` /
    `checkout_start` bullets in §04; the `prefilled_email` /
    `client_reference_id` paragraph in §05; the `fb_acct_v1` bullet in §09;
    the two sign-up sentences in the short version; the sign-up sentence in
    `terms.html` §05; and the sign-up sentences in `support.html`. Everything
    else stands on its own.

---

## 8. 3 September 2026 — `privacy.html` rewritten against a site that grew a backend

Scope: `privacy.html` only. `terms.html` and `support.html` were not touched;
what they now get wrong is listed at the end of this section.

The page dated 2 September described a site with **no server**. That sentence,
or a consequence of it, appeared in seven places, and it is no longer true.
Between then and now the site acquired Firebase Authentication, a Firestore
record per reader, a Stripe webhook that writes a `premium` flag, a Cloud
Function that serves paid story text, a second analytics vendor, a Cloudflare
proxy in front of the first, and a webfont from Google on every page. Every
claim below was re-read against the file and line named.

### 8.1 What was removed at the owner's instruction

| Removed | Replaced with |
|---|---|
| The `.note` box beginning "**Not reviewed by a lawyer.** This is written to describe what the site genuinely does today…", and the "Not reviewed by a lawyer." clause in the footer stamp. | Nothing. Both are gone. **This resolves TODO 6 above by choosing "remove", not by choosing "get the review".** The policy is still not lawyer-reviewed. The disclaimer's disappearance is a decision, not a change in the underlying fact, and it should stay a knowing one. |
| The phrase "this website", in the dateline (`Applies to: factbox.app, this website`) and in §01 (`This policy covers this website only`). | `Applies to: factbox.app`, and "This policy covers the site and the small backend behind it." The page now says "the site", "these pages" or "Factbox" throughout; there are zero occurrences of "this website". |
| The opening paragraph: "Factbox is a website with real accounts, and a small amount of server behind them. Almost everything it remembers about you is written into your own browser and stays there…" | A new lead doing the same job, and truer to the current shape: most of what the site remembers is in the browser, some of it is not, and the page's structure is that division. |

### 8.2 Claims that were wrong and are now fixed

- **"You can sign in with … or a phone number"** — no phone field, no SMS step
  and no reCAPTCHA container exists on any page. `js/auth.js` still carries the
  phone functions (`:830`), but nothing calls them and `login.html`'s own
  description says "Google or email". §04 now says so, and says phone sign-in
  was withdrawn.
- **"Nothing on this list is transmitted to us or to anyone else"** (§02) —
  false since `js/profile-sync.js`. For a signed-in reader the contents of
  `fb_acct_v1`, **including name and email address**, are written to
  `customers/{uid}/profile/onboarding` (`js/profile-sync.js:176-206`, allowed by
  `firestore.rules` `match /profile/{docId}`).
- **"That email leaves your browser in exactly one place"** — it now leaves in
  two: Stripe's `prefilled_email` (`js/account.js:237`) and Firestore.
- **`client_reference_id` is "the random local id from your sign-up record"** —
  it is the **Firebase uid** now, falling back to the local id only when signed
  out (`js/account.js:229-238`). That is the join between a payment and an
  account, and the webhook depends on it (`functions/index.js`).
- **"There is nothing on our side that knows you"**, "no server", "no account to
  break into, no reader database to leak" — all false. `customers/{uid}` exists,
  the Stripe webhook writes it (`functions/index.js:44-99`), and
  `js/access.js:18-26` decides access from it. §07 and §12 are rewritten around
  what is actually held.
- **"Clearing this site's data … deletes everything the site holds. You do not
  have to ask us, because there is no copy anywhere else."** — no longer true
  for a signed-in reader. §11 now separates the two halves and says plainly that
  there is no in-product delete button and that deletion is by email.
- **"A content blocker that blocks `posthog.com` does the same thing"** —
  analytics is sent to `factbox.app/ink/*` and forwarded by
  `cloudflare/posthog-proxy.js`, specifically so that blocker lists do not match
  it. §05 now says this in those words, and names the two things the Worker does
  that a pass-through would not: it deletes the `Cookie` header before
  forwarding (`:144`) and sets `X-Forwarded-For` from `CF-Connecting-IP`
  (`:150-151`).
- **"Every one of those carries at most a story id, a card number, a step name
  or a plan name … Not the answers themselves"** — `start_answer` carries the
  answer the reader tapped (`js/start.js:392-398`), and every event now carries
  `has_account`, `is_subscriber` and `access` as registered super-properties,
  plus the Firebase uid once `identify()` has been called
  (`js/analytics.js:525-543`). §05 says all of it.
- **"PostHog … is not shared with anyone" / two-vendor comparison** — the GA4
  half was described but the identify/register half was not. Both sinks are fed
  from one `capture()` (`js/analytics.js:494-503`).
- **The 26-name event list** — was out of date in both directions. It named
  `explore_view`, `rec_save` and `join_interests`, none of which exist any more,
  and omitted 27 names that do. The list in §05 is now the full 51, grouped, and
  matches a grep of `js/` and `*.html`.
- **The `sessionStorage` row** — the old page listed one key, `fb-story`, which
  no file writes any more. The two that are written are `fbx_corrected_v1`
  (`js/access.js:227`) and `fb_auth_redirect_v1` (`js/auth.js:85`).
- **"The illustrated front-page story contains a second, older counter … Its
  endpoint is an empty string"** — that page was retired in `5bfa0e1`. The
  paragraph is gone. `js/gate.js:100-103` still calls `window.plausible` if it
  exists; no page defines it, so it remains a no-op — which is why the page no
  longer mentions Plausible at all rather than asserting anything about it.
  (This supersedes TODO 7: there is no Plausible sentence left to correct.)
- **"There are no others"** about cookies — narrowed to "those four are the ones
  our own code sets", because PostHog and Firebase Analytics set their own on
  this domain.

### 8.3 What was added

- **§04 Signing in** — the two remaining methods, that Firebase holds the
  password, that signing up and resetting a password make Google send mail, and
  what Google receives when the Google button is used.
- **§05** — the identify/register paragraph, the proxy paragraph, the
  "analytics only transmits from `factbox.app`" fact (`js/analytics.js:151-159`),
  and the full event catalogue.
- **§07 Your account, and what is held under it** — the three writers of a
  reader's record, field by field, from `js/auth.js`, `functions/index.js:44-99`
  and `js/profile-sync.js:176-206`; and the story-serving function.
- **§09** — every third-party host a page load reaches. `fonts.googleapis.com`
  and `fonts.gstatic.com` are on **all 17 pages** and are hit signed out, which
  makes an IP address visible to Google on every visit; that was not disclosed
  at all before.
- **§11** — an analytics-deletion route, and the honest statement that account
  deletion is by email because no button exists.
- Two rows in the storage table that were missing: `fb_analytics_optout_v1` and
  `fb_access_seen_v1`.

### 8.4 One behaviour change, in `privacy.html`'s own script

The off switch could turn analytics off but not back on. `js/analytics.js`
returns early for an opted-out reader (`:171-177`) and installs an `FBQ` whose
`optIn` is a no-op, so the button relabelled itself to "Turn analytics back on"
and then did nothing. The page's inline script now sets and clears
`fb_analytics_optout_v1` directly as well as calling `FBQ`, which is the value
that actually decides whether the scripts load next time. Verified in Chrome:
off writes `"1"`, on removes the key, and the label follows both ways.

### 8.5 Also changed: the storage table on a phone

`table{min-width:460px}` inside a `.wrap{overflow-x:auto}` clipped the second
column at 430px — the description was cut mid-word and could only be read by
dragging the table sideways. A `@media (max-width:560px)` block stacks each row
(key, then what it holds) and hides the column headings visually while leaving
them for a screen reader. Checked at 1200 / 768 / 430 / 360 / 320px: no sideways
scroll at any of them.

### 8.6 Not verified

- Whether PostHog or Google Analytics actually honour a deletion request for a
  given user id, and how long each retains events. §11 promises only to ask and
  to report back what came back, because that is all that can be promised from
  the code.
- The retention period for anything in Firestore or in Firebase Auth. Nothing in
  the repo sets one, and the page therefore claims none.
- Whether the Stripe webhook and the story function are deployed. Both exist in
  `functions/` and `js/access.js` reads the flag they write; the page describes
  them as live because the access path depends on them.
- The exact storage names PostHog, Google Analytics and Firebase use in a
  browser. The page says each keeps storage "under names they choose rather than
  ones written here" rather than naming keys that could be wrong.
- `/support` — at the time of writing, the submit path in the tree is still a
  `mailto:` handoff (`support.html:306-323`): pressing Send composes a message in
  the reader's own mail app and nothing is posted anywhere. §08 describes exactly
  that. **If the support form is given a real endpoint, §08's last paragraph and
  the `support_send` / `support_idea` bullet in §05 both become false and must be
  rewritten in the same commit.**

### 8.7 What `terms.html` now gets wrong (not mine to edit)

- `terms.html:54` — "you can sign in with Google, an email and password, or a
  phone number". Phone sign-in does not exist.
- `terms.html:117-118` — "logging in on a second phone therefore cannot bring
  your access with it. Access lives in the browser you bought it in." That is
  the pre-account behaviour. Signing in is now exactly how access moves.
- `terms.html` also still carries the "not reviewed by a lawyer" disclosure that
  has just been removed from `privacy.html`. Two documents on the same site now
  disagree about whether that is worth saying.
