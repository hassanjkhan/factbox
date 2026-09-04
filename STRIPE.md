# Money

Everything about how a payment becomes an unlocked account. Read this before
touching `js/account.js`, `functions/index.js`, or anything that says `premium`.

**This repo is public.** Nothing in it is a secret and nothing in it may become
one. The payment links and the publishable side of Stripe are meant to be in
client code. The two values that are not — the API key and the webhook signing
secret — live in Google Secret Manager and in the functions runtime config, and
must never be pasted into a file, a commit message, or a chat log. If you ever
need them, ask Hassan directly; do not put them anywhere they can be indexed.


## 1. The shape of it

There is no server that sells anything. Checkout is three Stripe Payment Links,
and the only thing that turns a completed payment into a reader who can read is
a webhook writing one boolean into Firestore.

```
reader taps a plan
   -> buy.stripe.com/...?client_reference_id=<firebase uid>&prefilled_email=...
   -> Stripe takes the money
   -> Stripe POSTs to our webhook
   -> webhook writes customers/<uid>.premium = true
   -> js/access.js sees it on the next snapshot and the padlocks come off
```

`client_reference_id` **is the entire link between a payment and an account.**
If it is not on the checkout URL, the money arrives and nobody gets unlocked,
and there is no way to repair it afterwards except by hand. Any change to how
checkout URLs are built must be verified by actually clicking one and watching
the Firestore document flip. This has broken before: an edit to that function
called something that did not exist and shadowed the real one, so every plan
button silently went nowhere.


## 2. The ladder — what Stripe ACTUALLY charges

**Established 2026-09-03 by measurement, not by reading our own code.** Each
live Payment Link was loaded in real Chrome and the price object that Stripe's
own checkout fetched for it was read off the wire
(`merchant-ui-api.stripe.com/payment-links/<id>`). These are Stripe's numbers,
reported by Stripe, for the links this site actually links to.

| Plan | Stripe price id | Charges | Interval | Trial | In the offer? |
|---|---|---|---|---|---|
| Monthly | `price_1UBG2BAhj1M3E8TlTgdYJ6Xf` | **USD 4.99** (`499`) | every 1 month | 3 days | yes |
| Quarterly | `price_1UBG4LAhj1M3E8TlS3U7Hwto` | **USD 11.97** (`1197`) | every 3 months | 3 days | **no — retired, §6** |
| Annual | `price_1UBG4pAhj1M3E8Tl1x4YFAzB` | **USD 35.88** (`3588`) | every 1 year | 3 days | yes |

All three are prices on one product, `prod_VBdImvMmh9CI5L`
("Factbox - Season One"), on account `acct_1RKKQAAhj1M3E8Tl`, livemode.

**There is no coupon, no promotion code and no discounted price on this
account.** The measurement above found three prices on one product and nothing
else, and there is no `coupon`, `promotion_code`, `discount` or
`allow_promotion_codes` anywhere in this repository. That is why the save offer
on `/subscription` ships switched OFF — §10.

Two things the measurement also settled:

- **The 3-day trial is real and it is live.** Each link's checkout renders
  "3 days free / Then … starting September 6, 2026" — three days from the day
  it was read — and each carries `trial_period_days: 3`.
- **USD is the settlement currency.** The checkout presented CAD to a Canadian
  IP (CA$7.09 / CA$17.16 / CA$51.44) with the line "1 USD = 1.4336 CAD", and
  `3588 × 1.4336 = 5144`. The base amounts are the USD ones above; what a
  non-US reader sees is Stripe's Adaptive Pricing conversion of them.

### THERE IS NO $35/YEAR PRICE

The annual plan charges **$35.88**, not $35.00. A site that says "$35 a year"
would be charging every buyer 88¢ more than the figure they agreed to. That is
not a rounding question — it is the thing that produces chargebacks, and in
some jurisdictions it is illegal. **The code says 35.88 and will keep saying
35.88 until a $35.00 price exists in Stripe.** §7 is how to make one.

While you are in there: the product description on all three prices reads
*"Monthly subscription for Factbox."*, which is wrong on the quarterly and
annual checkout pages. §7 step 8 fixes it.

### Where the numbers live in the code

**One place: the `PRICING` block at the top of `js/account.js`.** Each rung
carries the charged amount and the Payment Link **in the same object**, so a
price cannot be edited without the URL that charges it, or vice versa. The
per-month figure is *derived* from the charged total, never the source — see
ACCOUNT.md §5 for why that direction matters.

Nothing else in this repo may contain a price. `join.html`'s plan markup is
overwritten by `renderPlans()` from `FBA.plans()` on load; the figures in
ACCOUNT.md and in this file are a dated record of a measurement, not an
editable copy.

`TRIAL_DAYS`, one constant beside `PRICING`, is the trial length. It only
*describes* what the three links are set to — nothing in this code can grant,
extend or end a trial.

**Do not change prices without asking Hassan.** Editing a link constant changes
what customers are charged. Cancellation is still Stripe's own billing portal
and nothing else — but there is now a flow in front of it at `/subscription`,
which is §9. Nothing in this repository can cancel a subscription.

## 3. The webhook

`functions/index.js`, deployed at
`https://us-central1-factbox-7cb97.cloudfunctions.net/stripeWebhook`.

Things about it that are load-bearing and not obvious:

- It verifies Stripe's signature against **`req.rawBody`**, not the parsed body.
  Express having already parsed the JSON is exactly what makes signature checks
  fail; if you refactor this and verification starts failing, that is why.
- `ACTIVE = ["active", "trialing", "past_due"]`. A three-day trial is
  `trialing`, so leaving it out locks out every trial user. `past_due` is
  deliberate: someone whose card just failed keeps reading while Stripe retries,
  rather than being locked out mid-story over a bank blip.
- It is idempotent. Stripe retries, and retries must not do anything twice.
- A `checkout.session.completed` names its subscription by id only. Reading it
  back needs `STRIPE_API_KEY`; if that is not set the code skips it and lets the
  following `customer.subscription.created` event do the work. So a missing API
  key degrades, it does not break.

The webhook is the only thing that writes entitlement. `firestore.rules` makes
`customers/{uid}` readable only by that user and **never client-writable** — a
reader cannot grant themselves premium from the console, and neither can a bug.

```sh
firebase deploy --only functions        # after any change in functions/
```

If that fails on Secret Manager permissions, you need the **Secret Manager
Secret Accessor** role — that is the webhook signing secret. Seeding stories
does not touch it.


## 4. Reading access in the site

Never check Stripe, `premium`, or a local flag directly. There is one module:

```js
FBX.can()          // may this person read? -> true/false
FBX.why()          // "admin" | "subscriber" | "legacy" | "none"
FBX.ready()        // resolves when the answer is genuinely knowable
FBX.paint(fn)      // render when known, render again if it changes
FBX.correct(drew)  // "I drew the locked view; reload if that turns out wrong"
```

Four ways in, in order of authority: **admin** (`customers/{uid}.admin`, for the
two founder accounts), **subscriber** (`.premium`, written only by the webhook),
**legacy** (a local flag from the pre-accounts restore links), **none**.

This exists because four surfaces once answered "may this person read?" four
different ways on four different clocks, and paying readers got padlocks. Adding
a fifth opinion anywhere is the wrong fix for whatever you are looking at.

`FBX.correct()` in particular: do not write `FBX.onChange(a => a && location.reload())`.
That is what had `/stories` reloading forever — `onChange` fires as soon as the
answer is known, which on a phone is before the page has finished its first
render, so it reloaded, so it never finished, so it reloaded again.


## 5. Testing without spending money

Use Stripe **test mode** — a separate dashboard toggle with its own keys, links
and webhook endpoint. Card `4242 4242 4242 4242`, any future expiry, any CVC.
`stripe listen --forward-to <url>` replays events at a local or deployed
function so you can watch the Firestore write happen.

The one thing test mode cannot tell you is whether the *live* links carry
`client_reference_id`, because those are different URLs. Check that by reading
the live link constants, not by trusting the test run.

Both founder accounts have `admin: true`, so you can read every story without
paying. That also means **you cannot see the paywall while signed in as
yourself** — use a private window or sign out to test what a visitor sees. More
than one "the paywall is broken" report has turned out to be this.


## 6. Quarterly is retired, and nobody on it is affected

The owner wants quarterly out of acquisition and **not deleted**. It is done
with one word:

```js
{ key: "quarterly", …, offered: false, … }   // js/account.js, PRICING.plans
```

`offered: false` removes the rung from `FBA.plans()`, which is the array
`renderPlans()` builds the plan screen from. That is the whole change.

**What it does NOT do, and this is the point:**

- The Stripe **price is untouched**. `price_1UBG4LAhj1M3E8TlS3U7Hwto` stays
  active. Nothing is archived, nothing is deleted.
- **Every existing quarterly subscriber keeps renewing at USD 11.97 every 3
  months**, exactly what they agreed to. Nobody is migrated to another price,
  nobody is repriced, nobody is cancelled, and none of them see any change.
- Their entitlement is unchanged. The webhook keys on subscription status, not
  on which price; `active` / `trialing` / `past_due` still write
  `customers/{uid}.premium = true` for them, forever, on every renewal.
- **The Payment Link keeps working.** Anyone holding the URL — a bookmark, an
  old email, a screenshot — can still complete a checkout on it and will still
  be unlocked. `FBA.checkoutURL("quarterly")` still returns the full URL with
  `client_reference_id` attached. We stopped *offering* it; we did not stop
  *honouring* it.
- The account page can still name the plan somebody is on:
  `FBA.planByKeyAny("quarterly")` returns it. Only `FBA.planByKey()` — "what
  may this reader buy right now" — returns `null` for it, which is deliberate:
  a returning reader whose stored plan is `quarterly` must not restore a
  selection the screen no longer shows.

To bring it back: `offered: true`. Nothing else.

**Do not delete the record.** Deleting it would make the account page unable to
name an existing subscriber's plan, and would break the bookmarked link. A
retired rung costs one line and is the difference between "we changed the
offer" and "we broke a paying customer".


## 7. Moving annual to $35.00 — the click-path, for Hassan only

Nobody in a coding session can do any of this; it is all dashboard. Until step
7 is done the site will keep showing **$35.88**, which is correct, because
that is what the current link charges.

Existing subscribers: **none of the steps below touch them.** A Stripe
subscription references the price object it was created with. Creating a new
price does not alter any subscription already pointing at the old one, and
archiving the old price does not either — archiving only stops *new*
subscriptions being created on it. Everybody who bought at $35.88 keeps being
charged $35.88 until they cancel, which is the amount they authorised. There
is nothing to migrate and nothing you should migrate.

1. **Log in** at <https://dashboard.stripe.com> and confirm the environment
   toggle at the top left says **Live mode**, not Test mode. Every id below is
   a live id; doing this in test mode produces a link that takes no money.

2. **Product catalog → Products →** open **Factbox - Season One**
   (`prod_VBdImvMmh9CI5L`). Do not create a second product — all three prices
   belong on this one, and the webhook does not care which price paid.

3. In that product's **Pricing** section, click **+ Add another price**.
   Set:
   - Price: **35.00**
   - Currency: **USD**
   - Recurring, billing period: **Yearly**
   - Leave "Charge tax on this price" as it already is on the $35.88 price.

   Save. Copy the new price id — it looks like `price_1…`. You will not paste
   it anywhere, but writing it down is how step 9 gets checked.

4. **Do NOT edit the existing $35.88 price.** Stripe will not let you change an
   amount in place, and any workaround that looks like it does is creating a
   new price anyway. Leave `price_1UBG4pAhj1M3E8Tl1x4YFAzB` exactly as it is;
   it is what your current annual subscribers renew on.

5. **Payment links → + New**. Choose **Existing product → Factbox - Season One
   → the new $35.00 / year price**. Quantity 1, adjustable quantity off.

6. In the link editor, open **Options** (or "More options") and set:
   - **Free trial → 3 days.** The trial lives on the link, not in our code.
     Miss this and the reader is charged immediately and the copy on our plan
     screen becomes false.
   - **After payment → Redirect customers to** and paste this literally,
     braces included:

     ```
     https://factbox.app/stories?unlocked=1&session_id={CHECKOUT_SESSION_ID}
     ```

     Stripe substitutes the real session id. Without the `session_id` part the
     buyer is still unlocked, but their restore link becomes a locally minted
     one no future server could verify.

7. **Create link**, then copy the resulting `https://buy.stripe.com/…` URL and
   send it to whoever is editing the code. In `js/account.js`, inside
   `PRICING.plans`, the `annual` record changes **two lines, together, in one
   edit**:

   ```js
   link:        "https://buy.stripe.com/<the new one>",
   amountCents: 3500,
   ```

   Nothing else anywhere. The plan screen, the terms line under the button and
   the saving percentage all recompute from those two values.

   Changing one without the other IS the discrepancy this whole document
   exists to prevent: `amountCents` alone changes what the site *says*, `link`
   alone changes what the reader *pays*.

8. While you are in the product: its **description** currently reads
   *"Monthly subscription for Factbox."* and Stripe shows it on the quarterly
   and annual checkout pages too, where it is wrong. Edit it to something
   period-neutral — *"Factbox — all fifty-one stories."* — and save. This is
   cosmetic, affects no charge, and changes nothing for existing subscribers.

9. **Archive the old annual price so nobody new lands on $35.88.** Product →
   the $35.88 yearly price → **⋯ → Archive**. Then Payment links → the old
   annual link (`28E7sKa5b8Mj8DtgUO3F604`) → **⋯ → Deactivate**. Archiving a
   price does not cancel, reprice or notify a single existing subscriber; it
   only stops new subscriptions being created on it. Do this **after** step 7
   has shipped, never before, or the site links to a deactivated link.

### How to verify it afterwards — three checks, in this order

- **In Stripe.** Open the new payment link URL in a private window. The header
  must read **"3 days free"** and **"Then $35.00 per year starting <a date
  three days from today>"**. If it says any other amount, or shows no trial,
  step 3 or step 6 went wrong. (Outside the US, Stripe converts: you will see
  a local amount with a "1 USD = …" line under it. Multiply back; the base
  must be 35.00.)

- **In the site.** Load `/join`, reach the plan screen, and read the annual
  card. It must say **$35.00 a year**. `35.00 ÷ 12 = 2.9166…`, which does not
  divide evenly, so the per-month line must read **"about $2.92 a month"** —
  the word "about" is generated by `perMonthExact: false` and is not
  decoration. If it reads a flat "$2.92 a month", the copy is quoting a price
  nobody is charged; fix the caller to render `perMonthAbout`.

- **In the browser's address bar.** Click the annual button and, before
  paying, check the URL you land on. It must be the **new** `buy.stripe.com`
  id and it must carry **`client_reference_id=<a firebase uid>`**. No
  `client_reference_id`, no unlock — see §1. Then pay once with a real card,
  watch `customers/<uid>.premium` flip in Firestore, and refund yourself.

### The same path for the 3-vs-7 day trial test

The trial is on the link, so switching to 7 days is: edit each live Payment
Link → Options → Free trial → 7 → save, on **all three** links, and then
`TRIAL_DAYS = 7` in `js/account.js`. **Stripe first, code second** — if the
code says 7 while a link still says 3, the site is promising a trial the till
will not give. Every piece of copy that names the length derives from that
constant, so there is nothing else to edit.


## 8. What only Hassan can do

- **Create the $35.00/year price and its Payment Link (§7).** Nothing in a
  coding session can do this, and until it exists the site must keep showing
  $35.88.
- **Create the save offer's coupon, if the save offer is wanted at all (§10).**
  Until it exists, `/subscription` shows no discount to anybody, which is
  correct, because there is no discount.
- Change any price, or create, archive and deactivate Payment Links.
- Change the free-trial length on a link — the 3-vs-7 test starts here, not in
  the code.
- Fix the product description, which currently says "Monthly subscription"
  on all three plans (§7 step 8).
- Anything in the Stripe dashboard: refunds, disputes, payout details, the
  business name on statements.
- Rotate the API key or the webhook signing secret.
- Change the Firebase billing account (the Blaze plan is on his card, with a
  $10 budget alert).

Ask before touching pricing, the number of free stories, or `LEGAL.md`.


## 9. Cancelling — the flow at `/subscription`, and what actually ends a plan

`subscription.html` · `css/subscription.css` · `js/subscription.js`

Five screens on one page: **the plan → why are you leaving → one save attempt
→ confirm → the receipt.** Hash routes (`#cancel`, `#offer`, `#confirm`,
`#done`) so the phone's Back button walks back out of it.

**Stripe's billing portal is what cancels. Nothing here can.** The confirm
screen's red button is an `<a>` pointing at
`https://billing.stripe.com/p/login/aFa9AS5OVgeL7zp4823F600` — the same URL
`/account`, `/support` and `/terms` already carry, and the same one
`FBU.PORTAL` returns. Stripe takes the cancellation on its own page, works out
the proration, and sends the confirmation email. Then:

```
reader taps "Cancel subscription" on /subscription#confirm
   -> sessionStorage records WHICH subscription they went to cancel
   -> Stripe's portal. Stripe cancels it.
   -> customer.subscription.updated -> the webhook in functions/index.js
   -> customers/{uid}/subscriptions/{id}.cancelAtPeriodEnd = true
   -> js/auth.js's live snapshot -> FBU.onSubscription
   -> and THAT is what draws "Subscription cancelled."
```

**The receipt screen is drawn by Stripe's answer and by nothing else.**
`render()` refuses `#done` unless `FBU.subscription().cancelAtPeriodEnd` is
true, so typing `#done` into the address bar gets the plan screen. A reader who
opens the portal and changes their mind comes back to a plan that still says
*Active*. There is no local flag, no optimistic state and no way for this site
to claim a cancellation that did not happen.

**Why the portal and not a Cloud Function on the Stripe API.** Fewer moving
parts on the path that carries revenue: no second writer, no API key in a new
place, and no reimplementation of proration, dunning and the confirmation
email. `functions/index.js` stays a read-only-to-us webhook that nothing in a
session needs to touch.

### Every figure on those screens, and where it comes from

All of them come off `customers/{uid}/subscriptions/{id}` — the document the
webhook writes straight from the price object Stripe charged — through
`FBU.subscription()`. **Not from `PRICING`**, which is the ladder a reader may
*buy*; a subscriber on the retired quarterly rung is charged something that is
not in the offer.

| On screen | Field | If it is missing |
|---|---|---|
| "Annual plan" | `priceId` matched against `FBA.pricing()`, else the interval | "Your plan" |
| "Active" / "Free trial" / "Payment overdue" / "Cancelling" | `status`, `cancelAtPeriodEnd` | the line is not shown |
| "$35.88 a year" | `amount` + `currency` + `interval` + `intervalCount` | the line is not shown |
| "Renews 23 March 2027" | `currentPeriodEnd` | the line is not shown |
| "keep full access until …" | `currentPeriodEnd` | the sentence drops the date rather than inventing one |

There is no default amount, no assumed currency, and above all **no computed
renewal date**. "A year after the last one" is a guess, and a guess about
somebody's money is a lie with arithmetic in front of it.

### Who sees it

Only a reader with a **live Stripe subscription**. `FBX.owns()` is "did they
buy it" and `FBX.can()` is "may they read"; a cancel flow is narrower than
either. Signed out gets the sign-in panel, a free reader gets the plans, an
admin is told nothing is being charged, a comped account is told there is no
subscription on file, and a legacy restore-link buyer is told that is a one-off
unlock and not a subscription. None of them is shown a cancel button.

### Instrumentation

No new event names. The steps ride on `ui_click` (every control carries a
`data-fbt`, which is what `js/analytics.js` reports as `control`) and the two
hops to Stripe send the existing `billing_portal`. The note box on the "anything
we should know?" screen posts to the same Cloud Function `/support` posts to,
as `kind: "help"`, and the screen says so.


## 10. The save offer — OFF, and exactly what turns it on

The design offers **50% off for another year** on the save screen. **It is
switched off and it must stay off until the coupon exists**, because §2 is the
measurement and there is no coupon, promotion code or discounted price on
`acct_1RKKQAAhj1M3E8Tl`. A save screen quoting a discount nobody can redeem is
worse than no save screen: it is the $35-vs-$35.88 defect with a bigger gap.

Until then, a reader who says "it costs more than I want to spend" gets the
*"Anything we should know?"* screen, which asks a real question and quotes no
figure.

The screen itself is built and works. One object at the top of
`js/subscription.js` is the whole switch:

```js
var SAVE_OFFER = {
  on:          false,
  percentOff:  0,       /* the number printed in 80px type: 50 means "50% OFF" */
  amountCents: 0,       /* WHAT STRIPE WILL ACTUALLY CHARGE, in cents         */
  currency:    "usd",
  months:      12,      /* how long the discounted period runs                */
  thenCents:   0,       /* what Stripe charges AFTER those months, in cents   */
  link:        "",      /* the URL that applies it. Empty keeps it off.       */
  id:          ""       /* the coupon or price id, for re-verification        */
};
```

`thenCents` is the one that is easy to get wrong, and it differs between the
two shapes below. A **coupon** reverts to the price it was applied to, so
`thenCents` is the reader's current amount — `3588`. A **discounted price on a
Payment Link does not revert**: it renews at the discounted amount forever, so
`thenCents` is `1794`. The screen prints it in the sentence beginning *"Then"*,
and it is configured rather than assumed precisely because those two answers
are different and only one of them is true for whichever you built.

### What Hassan has to create in Stripe

Live mode, on the existing product **Factbox - Season One**
(`prod_VBdImvMmh9CI5L`). Two shapes work; pick one.

**Either — a discounted price and a Payment Link for it** (the same shape as §7
and the one this site already understands):

1. Product catalog → Products → **Factbox - Season One** → **+ Add another
   price**. Amount **17.94**, currency **USD**, recurring, **Yearly**. Save and
   copy the `price_…` id. *(17.94 is exactly half of the 35.88 the annual plan
   charges today. If the annual price moves to $35.00 first, this becomes
   **17.50** and `amountCents` becomes `1750` — the two must always match, and
   the code refuses to render if they do not.)*
2. Payment links → **+ New** → Existing product → that new price. **No free
   trial** — this is an existing subscriber, not a new one.
3. After payment → Redirect customers to, pasted literally:
   `https://factbox.app/stories?unlocked=1&session_id={CHECKOUT_SESSION_ID}`
4. Create link, copy the `https://buy.stripe.com/…` URL.
5. Send back **the price id and the link URL**, and `SAVE_OFFER` becomes:
   `on: true, percentOff: 50, amountCents: 1794, currency: "usd", months: 12,
   thenCents: 1794, link: "<the new buy.stripe.com URL>",
   id: "<the new price_… id>"`. `thenCents` is 1794 and not 3588 here: this
   price renews at its own amount and never goes back up.

   *Caveat worth knowing before you choose this shape:* it creates a **second**
   subscription rather than repricing the first, so the reader must then cancel
   the old one in the portal. That is one more step for them and one more thing
   to explain.

**Or — a coupon, applied in the portal** (cleaner for the reader, more setup):

1. Product catalog → **Coupons** → **+ New**. Percentage discount **50%**,
   Duration **Repeating**, **12 months**, applies to the annual price. Save and
   copy the `coupon_…` id.
2. Settings → Billing → **Customer portal** → turn on the flow that offers the
   coupon when a customer starts a cancellation, and attach the coupon to it.
3. Then `link` is the portal URL, `id` is the coupon id, and **`thenCents` is
   `3588`** — a coupon expires and the subscription goes back to the price it
   was applied to.

### The check the code makes anyway

`offerLive()` will not draw the screen unless **all** of `on`, `link`,
`percentOff` (1–99), `amountCents` (> 0) and `thenCents` (> 0) are set, the
currency matches the reader's own subscription, **and**

```
Math.round(sub.amount * (100 - percentOff) / 100) === amountCents
```

— the figure on the screen has to be the figure the till produces, for *that
reader*. So a quarterly subscriber, or anyone on an amount the discount does
not resolve to, is never shown it; they get the no-figure screen instead. Fill
in three of the seven fields and nothing appears. That is deliberate: a half-
configured discount must fail closed.

### How to verify it afterwards

- **In Stripe.** Open the new link (or start a cancellation in the portal) in a
  private window. The header must read **$17.94**, and there must be **no
  trial**.
- **On the site.** `/subscription` → Cancel subscription → *"It costs more than
  I want to spend"*. The screen must read **50% OFF**, **"$17.94 for the next 12
  months"**, and then either **"Then $35.88 a year."** (a coupon) or **"Then
  $17.94 a year."** (a discounted price) — whichever is true of the thing you
  built. If any of the three disagrees with Stripe by a cent, `amountCents` or
  `thenCents` is wrong; fix it there and nowhere else.
- **In the address bar.** Tap the button and check you land on the id you
  created.
