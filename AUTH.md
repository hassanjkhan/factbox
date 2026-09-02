# Factbox — authentication

`js/auth.js`, `css/auth.css`, `login.html`, `account.html`.

This is the first layer on the site that can *check* something. `gate.js` asks
whether this browser holds an unlock flag, `progress.js` asks where this
browser stopped, `account.js` asks what this browser was told. All three are
per-browser and none of them can be verified. This one signs a reader in with
Firebase Auth and reads a boolean that only a Stripe webhook, running with
admin credentials, is allowed to write.

---

## 1 · The one flag

```
customers/{uid}.premium        boolean, written by the Stripe webhook
customers/{uid}/subscriptions/{id}
    status active cancelAtPeriodEnd currentPeriodEnd trialEnd amount currency interval
```

**`premium` is the only thing that decides access.** The subscription document
supplies what an account screen wants to *show* — a renewal date, a trial end,
an amount — and nothing on this site decides anything from it. If the two ever
disagree, the boolean is right. One flag, written in one place, read in one
place, is the difference between a bug and an argument.

Firestore rules already say a signed-in reader may read `customers/{their uid}`
and its `subscriptions` subcollection and nothing else. `auth.js` reads exactly
that and nothing else.

---

## 2 · Tags and load order

### `login.html` and `account.html` (already wired)

```html
<head>
  <link rel="stylesheet" href="css/app.css">      <!-- the design system      -->
  <link rel="stylesheet" href="css/account.css">  <!-- fields, panels, asides -->
  <link rel="stylesheet" href="css/auth.css">     <!-- adds only what is new  -->
  <script> …the four-line au-js failsafe, verbatim from either page… </script>
</head>
<body>
  …markup, every panel carrying its real copy…
  <script type="module" src="js/auth.js"></script>
  <script src="js/progress.js"></script>
  <script src="js/gate.js"></script>
  <script> …the page's own ES5, using whenFBU()… </script>
  <script src="js/analytics.js"></script>
</body>
```

`css/auth.css` **must** load after `css/app.css` and `css/account.css`. It adds
a provider button, an "or" rule, a labelled fact row and a state chip. It
defines no colour of its own; every value is a token from `app.css`.

### Any other page that wants FBU

```html
<script type="module" src="js/auth.js"></script>
<script src="js/progress.js"></script>
<script src="js/gate.js"></script>
<script> …your existing ES5… </script>
```

`js/auth.js` is a **module**, so the browser defers it: it runs after the
document is parsed and **before `DOMContentLoaded`**, whatever position the tag
is in. An inline classic script therefore cannot assume `window.FBU` exists at
the moment it runs. Six lines fix that, and they are the same six lines on both
of my pages — copy them:

```js
function whenFBU(cb) {
  var done = false;
  function go() { if (done) return; done = true; try { cb(window.FBU || null); } catch (e) {} }
  if (window.FBU) { go(); return; }
  try { window.addEventListener("fbu-ready", go, false); } catch (e) {}
  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, false);
    else setTimeout(go, 0);
  } catch (e) {}
  try { setTimeout(go, 4000); } catch (e) { go(); }
}
```

`cb` is called with `null` when `FBU` is genuinely absent — the file 404'd, the
browser ignores `type="module"`, or it failed to parse. **That is a state to
render, not to hide behind.** Both my pages have a panel for it with a way out
on it.

`js/auth.js` is the only file on this site allowed modern syntax, because the
Firebase SDK ships as ES modules. It imports them with dynamic `import()`, so
the file is loadable as a module *or* as a plain script and the import is not
part of the parse step. Everything it exposes is ES5-callable: plain functions,
plain objects, promises. No existing file has to change to use it.

---

## 3 · The `FBU` surface

Everything returns a safe value rather than throwing. Every promise settles.

### Lifecycle

| Call | Gives |
|---|---|
| `FBU.ready()` | Promise → the user, or `null`. **Everything waits on this.** Never rejects, never hangs: after 8s it resolves signed-out and `onChange` corrects the page if the SDK turns up late. |
| `FBU.onReady(fn)` | The same thing as a callback, for code that would rather not touch a promise. |
| `FBU.billingReady()` | Promise → the premium boolean, once `customers/{uid}` has answered (or after 6s, or immediately when signed out). |
| `FBU.known()` | Has auth state been observed even once. |
| `FBU.ok()` | The SDK loaded and auth is live. |
| `FBU.unavailable()` | The SDK never arrived — blocked CDN, dead network, ancient webview. |
| `FBU.timedOut()` | `ready()` settled on the clock rather than on an answer. |

### Who

| Call | Gives |
|---|---|
| `FBU.user()` | The Firebase user object, or `null`. |
| `FBU.uid()` | `""` when signed out. **This is the id Stripe must carry.** |
| `FBU.email()` `FBU.phone()` `FBU.name()` | `""` when absent. |
| `FBU.emailVerified()` | Boolean. |
| `FBU.signedIn()` | Boolean. |
| `FBU.provider()` `FBU.providers()` | `"password"` / `"google.com"` / `"phone"`. |
| `FBU.providerText()` | Already a sentence: "Google", "Email and password". |
| `FBU.onChange(fn)` | Fires on every auth change, and immediately if state is known. Returns an unsubscribe. |
| `FBU.refresh()` | Re-reads the user from the server — the only way this tab learns that a verification link was clicked in another one. |

### Email and password

| Call | Notes |
|---|---|
| `FBU.signUpEmail(email, password)` | Creates the account **and sends the verification email**. A failure to send is swallowed: an account with no mail sent is recoverable from the account screen, an account that failed to be created is not. Rejects before the network on a password under six characters. |
| `FBU.signInEmail(email, password)` | — |
| `FBU.resetPassword(email)` | **Resolves even when there is no such account.** Saying "no account with that email" out loud tells a stranger which addresses are registered; Firebase's own newer default does the same. |
| `FBU.resendVerification()` | Sends to the current user. |

### Google

| Call | Notes |
|---|---|
| `FBU.signInGoogle()` | Resolves `{ user }` **or** `{ redirecting: true }`. The second is a success — the page is leaving. A caller that gets it should say so and stop, not re-enable its button. |
| `FBU.redirectError()` | A sentence, or `null`, describing a redirect that came back with nobody attached. |
| `FBU.redirectPending()` | A redirect is in flight. |
| `FBU.inAppWebview()` | True inside Instagram, TikTok, Facebook, Snapchat, Line, WeChat, LinkedIn, and any iOS browser that is not Safari. |

**The fallback, and why it is the main path.** Nearly all of this site's traffic
is inside an in-app webview, where `window.open` is either blocked outright or
opens a window with no way back to the page that opened it. So: a recognised
in-app webview never attempts the popup at all and goes straight to
`signInWithRedirect`; anywhere else the popup is tried and, on
`auth/popup-blocked`, `auth/operation-not-supported-in-this-environment`,
`auth/web-storage-unsupported`, `auth/internal-error` or an error with no code
at all, becomes a redirect within a second. A popup the reader **closed
themselves** is not bounced into a redirect — that is them saying no, and
answering it by navigating the page away is the kind of thing that gets an app
uninstalled. `getRedirectResult` runs on every load, and a `sessionStorage`
flag lets the page tell "came back with nobody" from "never went".

### Phone

| Call | Notes |
|---|---|
| `FBU.startPhone(number, containerId)` | Invisible reCAPTCHA. If the container id is missing from the page, one is created — a missing element is not a reason to fail a sign-in. Resolves a handle. |
| `FBU.confirmPhone(handle, code)` | `handle` may be `null`; the last one is remembered. |
| `FBU.normalisePhone(s)` | E.164 or `""`. A bare ten-digit number is assumed North American; every other shape must carry its own country code, and the error copy says so rather than guessing wrong. |

### Money

| Call | Gives |
|---|---|
| `FBU.premium()` | The boolean, live from `onSnapshot`. |
| `FBU.onPremium(fn)` | Fires on every change, and immediately once billing is known. Returns an unsubscribe. |
| `FBU.subscription()` | The active subscription, normalised, or `null`. |
| `FBU.onSubscription(fn)` | Same shape. |
| `FBU.billingKnown()` | False while the read is still in flight — the difference between "free" and "we have not checked", which is the difference between a correct screen and a refund request. |
| `FBU.PORTAL` | The Stripe billing portal URL. |

The normalised subscription: `{ id, status, active, trialing, cancelAtPeriodEnd,
currentPeriodEnd, trialEnd, amount, currency, interval, raw }`. Dates are
milliseconds, converted from whichever shape the writer used — Firestore
`Timestamp`, `{seconds}`, seconds-since-epoch, milliseconds, or an ISO string.
Amounts stay in the currency's smallest unit, the way Stripe sends them.

### Copy

`FBU.message(err)` is the only thing a page should ever print.

---

## 4 · No error code ever reaches a reader

Thirty-five Firebase codes are mapped to sentences. Anything unmapped falls
through to *"Something went wrong. Try that again in a moment."*, and a final
scrub throws away any string containing `auth/`, `Firebase`, `firebase` or
`permission-denied` — so a code invented in a future SDK release still renders
as English. Both pages repeat the scrub at the point of printing, because the
page that does the rendering is the last one that can stop it.

Rejections still carry `.code`, off-screen, for the one place a page needs to
branch on it.

**`auth/email-already-in-use` is not an error a reader should ever read.** It
means they have an account and are on the wrong tab. `login.html` catches that
code, switches to the sign-in tab, focuses the password field and says *"You
already have an account with that email. Enter your password to sign in."* The
code never renders; the useful half of it does.

---

## 5 · Unverified email addresses can read. Here is the reasoning.

**Decision: yes. Signing up sends a verification email and nothing waits for
it.** An unverified account can sign in, can be premium, and can read all
fifty-one stories.

The case for blocking is that an unverified address might not belong to the
person who typed it. The case against is arithmetic:

- **Verification protects nothing here.** Access is decided by
  `customers/{uid}.premium`, which only a Stripe webhook can write, and Stripe
  has already verified a payment method. An unverified address gains nothing by
  being unverified: it cannot read a paid story, it cannot see anyone else's
  row, it cannot write anything at all. The rules are the boundary; the mailbox
  is not.
- **The failure mode is one-sided.** A reader who has just paid, on a phone,
  inside the Instagram browser, whose confirmation mail Gmail filed under
  Promotions, is a reader we have taken money from and locked out. That is a
  refund and a bad review. The symmetrical harm — someone reading history
  stories on an address they mistyped — does not exist.
- **The in-app webview makes it worse than usual.** Leaving Instagram to open
  a mail app, then coming back, is a context switch this audience does not
  reliably complete. Anything gated behind it is gated behind a coin flip.

What we do instead: the verification email goes out at sign-up, `account.html`
shows the state plainly — *"Not verified yet — you can still read
everything"* — and offers a resend on both pages. Verification stays useful for
password recovery and for support, which is what it is actually for.

**If this ever needs to change**, the one-line version is: in `login.html`'s
success path, check `FBU.emailVerified()` before `leave()`. Do not put the
check in `auth.js`; access decisions belong on the page that can explain them.

---

## 6 · Signing out does not touch reading progress or saves

`FBP` (reading memory, `fb_read_v1`) and `FBS` (saves, `fb_saved_v1`) are
per-browser, not per-account. **`FBU.signOut()` leaves both exactly as they
were.** It also does not touch `fb_unlocked_v1`, `fb_pass_v1` or `fb_passsrc_v1`
— gate.js and progress.js own those and nothing here writes them.

Why, in one sentence: signing out is not the same statement as *forget me*, and
treating it as one means that lending a friend your phone for one story costs
you fifty-one stories' worth of place-keeping.

The longer version. There are three plausible policies:

1. **Wipe on sign-out.** Correct on a shared computer, wrong everywhere else.
   These are phones, one person each, and the common reason to sign out here is
   to sign in as somebody else for a minute or to fix a stuck session. Wiping
   punishes the majority for the minority's threat model, and it destroys data
   that has no copy anywhere — progress is local-only; there is no server to
   restore it from.
2. **Keep it, silently.** Loses nothing, but a reader who signed out to hand
   the phone over is surprised to find their history still on the shelf.
3. **Keep it, and say so.** What we do. `account.html` carries a line directly
   under the sign-out button: *"Signing out leaves your place in each story, and
   anything you saved, on this phone. Neither is tied to your account."* Nothing
   is destroyed, and nothing is a surprise.

The regression test asserts this: after `signOut()`, `fb_read_v1`,
`fb_saved_v1` and `fb_unlocked_v1` are all still there.

If a *forget this browser* action is ever wanted, it belongs on `account.html`
as its own button calling `FBP.clearAll()` and `FBS.clear()`, with a
confirmation — an explicit act, never a side effect of leaving.

---

## 7 · What I need you to change, in files I do not own

Listed hardest-consequence first.

### 7.1 · `js/account.js` — `client_reference_id` must be the Firebase uid

**Without this, `premium` can never become true and the whole layer is
decorative.** `checkoutURL()` currently sends `FBA.accountId()`, a local
`fba…` string minted by `Math.random`. The Stripe webhook has no way to turn
that into a Firebase uid, so it cannot know which `customers/{uid}` to write.

```js
/* js/account.js, inside checkoutURL() */
var ref = "";
try { if (window.FBU && FBU.uid()) ref = FBU.uid(); } catch (e) {}
if (!ref) ref = accountId();          /* pre-auth fallback, still recorded */
if (ref) { url += sep + P_REF + "=" + encodeURIComponent(ref); }
```

And prefer the signed-in address for `prefilled_email`, so the Stripe customer
and the Firebase account agree:

```js
var e = "";
try { if (window.FBU && FBU.email()) e = FBU.email(); } catch (e2) {}
if (!e) e = email();
```

Because that value has to exist *before* checkout, **`join.html` must require a
signed-in account before the plan screen** — see 7.3.

The header comment on `account.js` also says, in bold, that there is no backend
behind it and that "log in" cannot move access between devices. That is no
longer true. Worth a sentence pointing at this file.

### 7.2 · `js/gate.js` — let the account answer the access question

`FB.unlocked()` reads `fb_unlocked_v1` and nothing else. A signed-in reader's
account should outrank it. `FBU` is asynchronous and `FB.unlocked()` is not, so
the wiring is a mirror rather than a read-through — do it once, on each page,
after `ready()`:

```js
whenFBU(function (FBU) {
  if (!FBU) return;                       /* no auth: today's behaviour, unchanged */
  FBU.onPremium(function (isPremium) {
    if (isPremium) { if (window.FBP) FBP.unlock(); render(); return; }
    /* Only an account that has actually answered may take access away, and
       only from a browser whose access was not restored from a bearer link. */
    if (FBU.billingKnown() && window.FBP && FBP.source() !== "restore") FBP.lock();
    render();
  });
});
```

Two things to decide with your eyes open:

- **The `lock()` half is what makes cancelling mean anything.** Without it a
  cancelled subscriber reads forever on the browser they bought in. With it, a
  reader who signs in with a *new* account on a browser that already holds a
  legitimate pre-auth unlock loses it. The `source() !== "restore"` guard covers
  the restore-link case; it does not cover a Stripe-sourced local flag from
  before this migration existed. If there are live pre-auth buyers, ship the
  `unlock()` half now and the `lock()` half after they have been migrated.
- SPEC §9 still applies. `data/stacks.json` is public, so none of this withholds
  text from anyone determined to read it. It stops a paying reader being asked
  to pay twice, which is what the gate has always been for.

### 7.3 · `join.html` — put the account before the plan

The funnel asks for an email at step 5 and stores it locally with no
credential. That email cannot become a `customers/{uid}` row. Smallest change
that works:

- Replace step 5's local `FBA.signUp()` with a real one. Either send them to
  `login.html?next=join.html` and read `FBU.email()` back when they return, or
  call `FBU.signUpEmail()` in place with the same two fields plus a password.
  The first is less work and reuses a screen that already handles Google, phone,
  reset and every error sentence.
- The two "I have read here before" buttons (`#jn-to-login`, `#jn-to-login-2`)
  should go to `login.html?next=stories.html` rather than the local `#jn-login`
  panel. `FBA.knows()` can only answer "has this browser been told that
  address", which is now the weaker of the two available answers.
- The `#jn-login` restore-link box stays. It is still the only bridge for a
  reader who bought before accounts existed.
- The plan buttons should be inert until `FBU.signedIn()` — a checkout with no
  uid attached is a payment we cannot honour on any other device.

### 7.4 · `stories.html`, `read.html`, `explore.html`, `library.html`

- Add `<script type="module" src="js/auth.js"></script>` above the existing
  script tags, and the `whenFBU()` bridge from §2 inside the page IIFE.
- `stories.html`: the `.keep` restore-link box is now the *second* best answer
  to "how do I read this on my other phone". Lead with the account — *"Sign in
  on your other phone and it is there"* — and keep the restore link underneath
  for readers who bought before accounts existed.
- A **"Your account"** link belongs in the footer row of each of these pages
  (`account.html`), next to Privacy and Terms. Right now the only route to it is
  from `login.html`.
- Nothing needs a rewrite: `FB.unlocked()` keeps working exactly as it does
  today on every browser where `FBU` is absent.

### 7.5 · Firebase console

- **Authorized domains** must include `factbox.app` (it does) and any preview
  origin you test from, or Google sign-in fails there with
  *"Sign-in is not allowed from this address"*.
- The verification email's continue URL is `<origin>/account.html`. Same list.
- Worth doing later: serve auth from `auth.factbox.app` via Firebase Hosting
  instead of `factbox-7cb97.firebaseapp.com`. Cross-site storage partitioning in
  in-app webviews is the single most likely reason a Google redirect comes back
  empty, and a same-site auth domain removes it. `FBU.redirectError()` exists to
  measure how often that happens before deciding.
- The reCAPTCHA phone flow needs the domain allow-listed for reCAPTCHA too.

---

## 8 · Degradation, and what a reader sees

| What broke | What they get |
|---|---|
| `type="module"` unsupported, `auth.js` 404s, or it fails to parse | `FBU` is absent. Both pages show a real panel: *"Sign-in will not start in this browser"*, with a link to the free stories, to support, and — on `account.html` — to the Stripe portal, which needs nothing from us. |
| gstatic blocked | `FBU` exists, `ready()` resolves signed-out after 8s, every method rejects with *"Could not reach the sign-in service."* |
| Firestore denied or offline | `premium()` stays false, `billingKnown()` stays false, and `account.html` says *"Looking up your plan"* rather than reporting FREE to somebody who is paying. |
| The page script throws before it can reveal anything | The `au-js` failsafe in `<head>` removes the hiding class after four seconds no matter what. The reader gets the real markup — the form, the copy, the links out. This is the bug that shipped a wordless page twice; the timer is unconditional for exactly that reason. |
| No JavaScript at all | `<noscript>` on both pages. `account.html`'s points at the Stripe portal, which is Stripe's own page and cancels a plan without us. |

Nothing on either page renders "signed out" and then flips. Both wait on
`ready()` behind a spinner that carries a sentence, because on a cold webview
that spinner can be up for several seconds and a spinner with no words is
indistinguishable from a hang.

---

## 9 · Verification

Run against a `python3 -m http.server 8911 --bind 127.0.0.1` from the site
root, with jsdom from `../rendercheck/node_modules`. **All green: 0 failing
checks, 58 logic assertions, 16 page renders.** The harnesses lived in a scratch
directory and were deleted afterwards; what they assert is written out here so
they can be rebuilt exactly, and so a change that breaks one of these is a
change somebody has to argue for.

jsdom cannot execute a module from a CDN, so the SDK is handed in through the
documented `window.FBU_SDK` seam — the same seam a future self-hosted bundle
would use — and `js/auth.js` is `eval`'d into a jsdom window as a classic
script. That works because the file has no static imports and no top-level
await; the only modern thing in it is the dynamic `import()` the seam bypasses.

**1 · Syntax.** `node --check` (via `new vm.Script`) on `js/auth.js` and on
**both inline scripts of both pages** — the `au-js` failsafe in `<head>` and the
page script at the foot. Plus a scan of the error table asserting that not one
of its 35 sentences contains `auth/`, `fb/` or the word Firebase.

**2 · `js/auth.js` against a stubbed Firebase.** 58 assertions in nine groups:

- the full documented surface exists and is callable; `ready()` and
  `billingReady()` both settle signed-out
- every probed code — including one that does not exist,
  `auth/quantum-flux-detected` — maps to a plain sentence; a code nested inside
  an error's `.message` is still mapped; rejections carry a reader sentence in
  `.message` and the raw code in `.code`
- sign-up calls `createUser` **and** `sendEmailVerification`; a taken address
  rejects with the sentence and the code; a short password is refused before
  the network; a reset for an unknown address resolves rather than disclosing
- **the Google fallback, four ways**: a working popup is used and no redirect
  happens; a blocked popup becomes a redirect, tells the caller the page is
  leaving, and sets the sessionStorage return flag; an Instagram user-agent
  never attempts the popup at all; a popup the reader *closed* is not bounced
  into a redirect. Plus both empty-return paths — a redirect that came back
  with nobody, and one that threw — reported in English with the flag cleared
- `premium` flips live from an `onSnapshot`; listeners fire; the active
  subscription is picked over a cancelled one; Firestore `Timestamp`,
  seconds-since-epoch and millisecond dates all normalise to milliseconds
- a denied or offline billing read leaves `premium()` false and still settles
  `billingReady()`
- phone: normalisation, the invisible reCAPTCHA, a wrong code, the right code,
  and a reCAPTCHA container that is not on the page
- **sign-out leaves `fb_read_v1`, `fb_saved_v1` and `fb_unlocked_v1` intact**
- with no SDK at all, `ready()` still resolves, `unavailable()` says so, and a
  sign-in attempt fails in English with zero script errors

**3 · Both pages in a real DOM**, over HTTP, with the real `progress.js`,
`gate.js` and `analytics.js` loading alongside. Twelve states:
`absent` (no `FBU` whatsoever), `out`, `in-free`, `in-unverified`, `in-trial`,
`in-cancel`, `in-phone`, `in-nobilling`, `in-actions`, `err` (every call
rejects, one with a code that does not exist), `ok`, and `google` (a redirect
that came back empty). Each run asserts: zero script errors, `au-js` removed so
nothing is left hidden, exactly one panel showing and the right one, the
expected copy present, and at least 250 characters of visible text — the check
that would have caught the wordless page.

It snapshots the visible DOM after **every** simulated tap, not just at the
end, and scans each snapshot for `auth/…`, `Firebase: Error`, `undefined`,
`[object Object]`, `NaN` and `Invalid Date`. Checking only the final DOM would
let a leaked code flash on screen and be cleared by the next tap, which is
exactly the bug the rule exists to prevent. Visible text means text a reader
sees: `[hidden]` subtrees, `<noscript>` and `.jn-vh` are excluded.

jsdom cannot navigate, so a successful sign-in surfaces as a "Not implemented:
navigation" notice. That is counted as the assertion *the page tried to leave*
rather than as an error — and the `err` run asserts the opposite, that a failed
sign-in stays put and shows a sentence.

`TZ=UTC` only pins the expected date strings; the page formats renewal dates in
the reader's own timezone, which is correct — `currentPeriodEnd` is an instant,
not a date.
