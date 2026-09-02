# Accounts, onboarding and the price ladder

`join.html` · `js/account.js` (`FBA`) · `css/account.css`, plus the
`checkout()` area of `js/gate.js`.

---

## 1. What changed and why

The site used to ask for money first. A locked cover or the end of a story
showed one button — *Read all 51 stories · $3.99/mo* — wired to a single
Stripe Payment Link. The reader had told us nothing, we had told them nothing,
and the first thing we did was ask for a card.

The funnel now runs in the other order:

```
locked story / end of story / Explore buy bar
      │  FB.checkout()
      ▼
join.html  ──1──▶ email (+ optional first name)        ← or "log in"
           ──2──▶ which subjects                        ← skippable
           ──3──▶ how often                             ← skippable
           ──4──▶ pick a plan, 3-day trial
      │  FBA.checkoutURL(plan)
      ▼
Stripe Payment Link (one per plan, trial configured in Stripe)
      │  success URL
      ▼
stories.html?unlocked=1&session_id=…   → gate.js claim() → progress.js mints
                                          the restore link
```

Money is the last screen. Every step before it is skippable except the email,
which is the thing the funnel exists to collect.

## 2. There is no password, and that is deliberate

This is static files on GitHub Pages. There is no server, so there is nobody
to register with and nothing to authenticate against. A password field would
imply a check we cannot perform, and a login form that accepts anything is
worse than no login form.

So "sign up" means **this browser now remembers your email and your answers**,
and "log in" can honestly do exactly two things:

1. If this browser already holds access, open the stories.
2. Take a pasted **restore link** and use it — which works because the token
   *is* the access. See `js/progress.js` on why that is inherent to a static
   site rather than a bug.

Anything beyond that is routed to `support.html`. `join.html` says all of this
in the copy, on the screen, rather than only here.

## 3. `FBA` — the API surface

Load order: `progress.js` → `gate.js` → `account.js`. `FBA` requires neither
of the other two and never redefines them; every consumer must guard
`window.FBA` before use.

### Who

| Call | Returns | Notes |
|---|---|---|
| `FBA.signUp(email, firstName)` | `true` / `false` | `false` only means "that is not shaped like an email". Lower-cases and trims. `firstName` optional. |
| `FBA.has()` | boolean | Is an email stored in this browser. |
| `FBA.knows(email)` | boolean | Is *that* the stored email. The honest core of "log in"; it cannot look anyone up. |
| `FBA.email()` | string, `""` if none | |
| `FBA.name()` | string, `""` if none | |
| `FBA.accountId()` | string | Minted on first use. Alphanumerics/dash/underscore, ≤24 chars. Sent to Stripe as `client_reference_id`. Not a secret. |
| `FBA.validEmail(s)` | boolean | Deliberately loose — see the comment in the file. |
| `FBA.get()` | `{accountId,email,name,interests,frequency,plan,onboarded,at}` | A copy, not the record. |
| `FBA.forget()` | boolean | Clears the key and the cookie mirror. |

### Onboarding answers

| Call | Returns | Notes |
|---|---|---|
| `FBA.interests()` | array of `topic` keys | The real `data/stacks.json` values: `cleopatra`, `new_testament`, `church_history`, `old_testament`, `us_history`, `ancient_world`, `medieval_modern`, `disaster`. Empty array when skipped. |
| `FBA.setInterests(array)` | boolean | De-duplicates, caps at 12. |
| `FBA.frequency()` | `""` \| `daily` \| `few` \| `weekly` \| `binge` | |
| `FBA.setFrequency(key)` | boolean | |
| `FBA.onboarded()` | boolean | True once the reader reached the plan screen via the button. |
| `FBA.finishOnboarding()` | boolean | |

**Nothing consumes `interests()` yet.** `js/explore.js` and `js/recommend.js`
are the two obvious readers — ordering shelves, or adding a weight to
`FBR`'s scoring. Until one of them does, the onboarding copy must not claim
the answers change anything, and it does not.

### Money

| Call | Returns |
|---|---|
| `FBA.plans()` | array of three plan objects, in ladder order |
| `FBA.planByKey("monthly"\|"quarterly"\|"annual")` | one plan, or `null` |
| `FBA.plan()` / `FBA.setPlan(key)` | the chosen key |
| `FBA.checkoutURL(key)` | full Stripe URL with `prefilled_email` and `client_reference_id`, or `""` when that plan has no link yet |
| `FBA.anyLinkReady()` | boolean — is checkout switched on at all |
| `FBA.money(n)` | `"$11.97"` |
| `FBA.TRIAL_DAYS` | `3` |

A plan object:

```js
{ key:"quarterly", perMonth:3.99, perMonthText:"$3.99", months:3,
  billedCents:1197, billed:11.97, billedText:"$11.97",
  cycle:"every 3 months", cycleShort:"3 months at a time",
  billedLine:"$11.97 every 3 months",
  savePct:20, best:false, trialDays:3, link:"", ready:false }
```

### Meta

`FBA.stored()` — `false` once any write has been refused. `join.html` uses it
to say "this browser will not remember you" instead of quietly forgetting.
`FBA.KEY` — `"fb_acct_v1"`.

## 4. Storage

One key, `fb_acct_v1`, one JSON object, short field names, same discipline as
`progress.js`:

```
{ v:1, a:accountId, e:email, n:name, i:[topics], f:freq, p:plan, o:0|1, t:secs }
```

`localStorage` is the real store; a cookie mirrors the same string **only**
while it is under 700 bytes, because Instagram's and TikTok's webviews hand
out a `localStorage` that is wiped between sessions while cookies survive.
Every read, write and cookie access is wrapped. A dead store degrades to
"not remembered", never to a broken page — proved by the check below.

## 5. The price ladder

Three numbers live in `PRICE_PER_MONTH` in `js/account.js`. **Every other
figure on the plan screen is computed from them** — the billed total, the
cycle sentence, the "save N%" — because a hard-coded percentage becomes a lie
the first time a price moves.

| Plan | Per month | Actually billed | Saving vs monthly |
|---|---|---|---|
| Monthly | $4.99 | $4.99 every month | — |
| Quarterly | $3.99 | **$11.97 every 3 months** | 20% |
| Annual · best value | $2.99 | **$35.88 a year** | 40% |

Both numbers are always shown together. A per-month figure on a plan billed in
a lump is the half of the truth that gets a refund request.

## 6. The three Stripe Payment Links

They do not exist yet. The three constants at the top of `js/account.js` are
empty, and while they are, the plan screen's button reads *"Checkout is not
open yet"*, is disabled, and explains itself in a line underneath — before the
tap, not after it.

Full creation instructions are in the comment block at the top of
`js/account.js`, next to the constants they fill. In short, per link:

- one recurring price on one product — **$4.99 monthly**, **$11.97 every 3
  months**, **$35.88 yearly**
- **Include a free trial → 3 days** (this is set in Stripe; nothing in this
  code can grant, extend or end a trial)
- after payment → redirect to
  `https://factbox.app/stories.html?unlocked=1&session_id={CHECKOUT_SESSION_ID}`

## 7. What this still is not

Everything SPEC.md §9 says remains true. `data/stacks.json` is a public file;
anyone with dev tools reads all fifty-one stories without paying. The gate
stops a paying reader being asked to pay twice and nothing more. An "account"
with no server is a preference store with an email in it. Making any of this
real needs a backend that checks a Stripe customer before serving content.

## 8. Verifying a change

Serve the site and run the checks in a real DOM — HTTP 200s and `node --check`
are equally true of a page with nothing on it.

```
python3 -m http.server 8901 --bind 127.0.0.1 --directory <site> &
node joincheck.js     # drives the funnel: every step, Back, Skip, dead storage,
                      # FBP absent, FBA absent, log in, already-unlocked
node mirrorcheck.js   # the arithmetic, the Stripe URL, and that the no-JS
                      # fallback copy in join.html still matches plans()
node gatecheck.js     # stories / explore / read still render and still route
python3 es5scan.py …  # no ES6 outside comments and strings
```

The no-JS fallback deserves its own note: **every panel in `join.html` ships
visible with its real copy**, including all three prices and both totals, and
the script hides what it is not showing. If the script never runs, or throws,
the reader gets one long readable page rather than a blank one. `mirrorcheck`
asserts that fallback copy still agrees with `plans()`, so it cannot drift.
