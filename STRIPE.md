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


## 2. The ladder

Defined in `js/account.js`, deliberately priced like drink sizes — the longer
commitment is the cheaper month.

| Plan      | Charged      | Works out at | Trial  |
|-----------|--------------|--------------|--------|
| Monthly   | USD 4.99 /mo | $4.99/mo     | 3 days |
| Quarterly | USD 11.97 /3mo | $3.99/mo   | 3 days |
| Annual    | USD 35.88 /yr | $2.99/mo    | 3 days |

The live link constants are `PAY_LINK_MONTHLY`, `PAY_LINK_QUARTERLY` and
`PAY_LINK_ANNUAL` at the top of `js/account.js`, with the procedure for
regenerating one in the comment above them. Cancellation is Stripe's own billing
portal — the link is in `js/account.js` and on the profile page; we do not build
a cancel flow.

**Do not change prices without asking Hassan.** Editing a link constant changes
what customers are charged.


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


## 6. What only Hassan can do

- Change prices, or create and archive Payment Links.
- Anything in the Stripe dashboard: refunds, disputes, payout details, the
  business name on statements.
- Rotate the API key or the webhook signing secret.
- Change the Firebase billing account (the Blaze plan is on his card, with a
  $10 budget alert).

Ask before touching pricing, the number of free stories, or `LEGAL.md`.
