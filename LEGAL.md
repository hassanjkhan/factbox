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
