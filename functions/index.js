/* ==========================================================================
   Factbox — Stripe webhook.

   One job: when Stripe says someone subscribed, write that under their Firebase
   account, so signing in on any device is enough. That single hop is the whole
   difference between "this browser once visited a success URL" and "this person
   is a subscriber".

   Why this and not the official extension: Firebase Extensions shut down on
   31 March 2027. The extension also does far more than we need — it syncs a
   product catalogue and creates checkout sessions — while we use Stripe Payment
   Links and need exactly one half of it. This is that half, and nothing here
   gets deprecated out from under us.

   The link between a payment and an account is `client_reference_id`, which
   every checkout URL on the site already carries. It was put there for exactly
   this, which is why no existing payment link has to be reissued.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

/* Held in Secret Manager, never in the repo and never in an env file. */
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

/* Statuses that mean "let them read". `trialing` is deliberate: the whole
   funnel promises three days before anything is charged, so a trialing reader
   is a paying reader as far as access goes. `past_due` is also here — a failed
   card should prompt a fix, not an immediate lockout, and Stripe will move it
   to `canceled` on its own once the retries run out.

   Everything NOT in this list revokes: `canceled`, `unpaid`,
   `incomplete`, `incomplete_expired` and `paused`. A trial that ends without
   a card becomes one of those, so the three free days close by themselves. */
const ACTIVE = ["active", "trialing", "past_due"];

/* --------------------------------------------------------------------------
   THE SECOND HALF OF THE ATTRIBUTION DEFENCE.

   `client_reference_id` is whatever the browser put on the checkout URL, and
   for one live checkout that was a LOCAL id — js/account.js's accountId(),
   which is "fba" plus a random tail, sliced to 24 characters. The webhook
   believed it and wrote `customers/fba0c2kqadg5iwjme09b8d4n`, a document no
   account will ever read, with `premium: true` on it. The client refuses to
   start an unattributed checkout now; this is the same refusal on the money
   side, because a defence on one side of a money path is a defence with a
   single point of failure.

   A Firebase Auth uid on this project is 28 characters. A local id can never
   reach 28 — accountId() slices to 24 — so the length alone separates them,
   with no prefix special-case that a future id format could slip past. The
   character class is also what keeps the value safe to put in a document
   path: no slashes, no dots, nothing that could address a different document.

   Anything that fails this is NOT written under `customers/`. It is filed in
   `stripe_unattributed/{session or customer id}` with every join key we have
   — the id the browser sent, the Stripe customer, the email, the amount — and
   logged as an error, so a payment that cannot be honoured is a row somebody
   can find rather than a silence. Nothing reads that collection; it exists to
   be detectable. `firestore.rules` denies the browser both ends of it. */
const UID_SHAPE = /^[A-Za-z0-9_-]{28,128}$/;

function looksLikeUid(v) {
  if (typeof v !== "string") return false;
  return UID_SHAPE.test(v.trim());
}

/* One place, so every branch files the same shape. Keyed on a Stripe id, so
   a retry of the same event overwrites its own row instead of adding one. */
async function fileUnattributed(key, why, fields) {
  if (!key) return;
  try {
    await db.doc(`stripe_unattributed/${key}`).set(
      Object.assign(
        { why, at: admin.firestore.FieldValue.serverTimestamp() },
        fields || {}
      ),
      { merge: true }
    );
  } catch (err) {
    logger.error("could not file an unattributed payment", { key, message: err.message });
  }
}

/* Stripe moved `current_period_end` off the subscription and onto the
   subscription ITEM in a later API version, and which shape arrives here is
   decided by the version on the webhook endpoint in the dashboard, not by the
   pin below. Reading both means the renewal date on /subscription survives
   somebody upgrading that version — and a missing date is not cosmetic there:
   that page refuses to invent one, so the line simply disappears. */
function secs(v) {
  return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
}

/**
 * Everything about a subscription that the site actually needs, written flat.
 * The reader's own row is read on every page load, so it holds one boolean
 * rather than forcing the client to interpret Stripe's state machine.
 *
 * ORDERING. Stripe retries, and retries can arrive out of order: a `trialing`
 * that was delayed can land after the `canceled` that followed it, and the
 * old code would have restored access to a subscription that had ended. Each
 * write stamps the `created` of the event that caused it and a write refuses
 * to run when the event that carries it is STRICTLY older than the one
 * already recorded. Equal timestamps still apply — two events in the same
 * second are not out of order, and the write is idempotent either way.
 *
 * The read-then-write also has to be one operation. It was a read followed by
 * a batch, so two concurrent retries could both read the old state and both
 * write. A transaction is the same cost here and cannot interleave.
 */
async function writeSubscription(uid, sub, event) {
  if (!looksLikeUid(uid)) {
    logger.error("refusing to write a subscription under a non-account id", {
      ref: uid || null, sub: sub && sub.id
    });
    return false;
  }
  const active = ACTIVE.indexOf(sub.status) !== -1;
  const item = (sub.items && sub.items.data && sub.items.data[0]) || {};
  const price = item.price || {};
  const periodEnd = secs(sub.current_period_end) || secs(item.current_period_end);
  const stamp = event && typeof event.created === "number" ? event.created : 0;

  const subRef  = db.doc(`customers/${uid}/subscriptions/${sub.id}`);
  const custRef = db.doc(`customers/${uid}`);
  const subsCol = db.collection(`customers/${uid}/subscriptions`);

  const out = await db.runTransaction(async (t) => {
    /* Every read first: a Firestore transaction may not read after it writes. */
    const prev = await t.get(subRef);
    const had = prev.exists ? prev.data() : null;
    if (had && stamp && typeof had.eventCreated === "number" && stamp < had.eventCreated) {
      return { stale: true, have: had.eventCreated, got: stamp, status: had.status || null };
    }
    const all = await t.get(subsCol);

    /* The flag the site reads. Derived from every subscription this person
       has, not just the one that changed — somebody who cancels a monthly
       plan while holding an annual one is still a subscriber. */
    let anyActive = active;
    all.forEach((d) => {
      const v = d.data();
      if (d.id !== sub.id && v && v.active) anyActive = true;
    });

    t.set(subRef, {
      id: sub.id,
      status: sub.status,
      active,
      priceId: price.id || null,
      amount: typeof price.unit_amount === "number" ? price.unit_amount : null,
      currency: price.currency || null,
      interval: (price.recurring && price.recurring.interval) || null,
      intervalCount: (price.recurring && price.recurring.interval_count) || null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: periodEnd
        ? admin.firestore.Timestamp.fromMillis(periodEnd * 1000)
        : null,
      trialEnd: sub.trial_end
        ? admin.firestore.Timestamp.fromMillis(sub.trial_end * 1000)
        : null,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : null,
      /* The ordering stamp. Read at the top of the next transaction. */
      eventId: (event && event.id) || null,
      eventType: (event && event.type) || null,
      eventCreated: stamp || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    t.set(custRef, {
      uid,
      premium: anyActive,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { stale: false, premium: anyActive };
  });

  if (out.stale) {
    logger.warn("stale event ignored", {
      uid, sub: sub.id, status: sub.status,
      eventCreated: out.got, alreadyHave: out.have, keptStatus: out.status
    });
    return false;
  }
  logger.info("subscription written", {
    uid, sub: sub.id, status: sub.status, premium: out.premium
  });
  return true;
}

/* A Stripe customer that no longer exists cannot send another event, so the
   last one it sends has to be the one that closes the account out. Stripe
   deletes the subscriptions first and we normally see those, but a delete
   that arrives without them would otherwise leave `premium: true` forever. */
async function revokeCustomer(uid, customerId) {
  if (!looksLikeUid(uid)) return false;
  const custRef = db.doc(`customers/${uid}`);
  const subsCol = db.collection(`customers/${uid}/subscriptions`);
  await db.runTransaction(async (t) => {
    const all = await t.get(subsCol);
    all.forEach((d) => {
      t.set(d.ref, {
        active: false,
        status: "canceled",
        stripeCustomerDeleted: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    t.set(custRef, {
      uid,
      premium: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  logger.info("customer deleted at Stripe, access revoked", { uid, customer: customerId });
  return true;
}

/* A subscription event names the customer, not the account. This walks back to
   the uid we recorded at checkout — the only place the two are introduced.

   IT SKIPS PAST A JUNK ROW RATHER THAN STOPPING AT ONE. `customers/fba0c2…`
   still exists in production carrying a `stripeCustomerId`, and the old
   `.limit(1)` could hand it back — which is how one orphan quietly took over
   every later event for that customer. Reading a few and returning the first
   that is actually an account id means the real row wins whichever order
   Firestore returns them in, and the junk one is reported rather than
   believed. Five is plenty: one Stripe customer should map to exactly one
   account, and more than that is itself the thing worth logging. */
async function uidForCustomer(customerId) {
  if (!customerId) return null;
  const q = await db
    .collection("customers")
    .where("stripeCustomerId", "==", customerId)
    .limit(5)
    .get();
  if (q.empty) return null;
  const bad = [];
  for (const d of q.docs) {
    if (looksLikeUid(d.id)) {
      if (bad.length) {
        logger.error("a Stripe customer is also mapped to a non-account id", {
          customer: customerId, ref: bad, used: d.id
        });
      }
      return d.id;
    }
    bad.push(d.id);
  }
  logger.error("a Stripe customer maps only to non-account ids", {
    customer: customerId, ref: bad
  });
  return null;
}

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_WEBHOOK_SECRET], region: "us-central1", cors: false },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("missing signature");

    const stripe = new Stripe("sk_unused", { apiVersion: "2024-11-20.acacia" });

    let event;
    try {
      /* rawBody, not body. An already-parsed body cannot be verified, and a
         webhook you cannot verify is an open endpoint anyone may POST to. */
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.warn("signature rejected", { message: err.message });
      return res.status(400).send(`signature: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object;
          /* The introduction. Every checkout URL on the site is supposed to
             carry the Firebase uid here — and one of them, once, carried a
             local browser id instead. See looksLikeUid() above. */
          const ref = typeof s.client_reference_id === "string"
            ? s.client_reference_id.trim() : "";
          const customerId = typeof s.customer === "string" ? s.customer : null;
          const uid = looksLikeUid(ref) ? ref : null;

          if (!uid) {
            /* Loud, and recorded. Somebody paid and we cannot say who they
               are; the row below is every key a human would need to join it
               up by hand, and it is written INSTEAD of a junk customers row
               rather than as well as one. */
            await fileUnattributed(s.id, ref ? "client_reference_id is not an account id"
                                             : "no client_reference_id", {
              session: s.id,
              clientReferenceId: ref || null,
              stripeCustomerId: customerId,
              subscription: typeof s.subscription === "string" ? s.subscription : null,
              email: s.customer_details ? s.customer_details.email || null : null,
              amountTotal: typeof s.amount_total === "number" ? s.amount_total : null,
              currency: s.currency || null,
              livemode: !!event.livemode
            });
            logger.error("checkout could not be attributed to an account", {
              session: s.id, ref: ref || null, customer: customerId
            });
            break;
          }

          if (customerId) {
            await db.doc(`customers/${uid}`).set(
              {
                uid,
                stripeCustomerId: customerId,
                email: s.customer_details ? s.customer_details.email || null : null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );
          } else {
            logger.warn("checkout with a uid but no customer", { session: s.id, uid });
          }

          if (s.subscription) {
            const full = await stripeWithKey(event).subscriptions.retrieve(
              typeof s.subscription === "string" ? s.subscription : s.subscription.id
            ).catch(() => null);
            if (full) await writeSubscription(uid, full, event);
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "customer.subscription.paused":
        case "customer.subscription.resumed": {
          const sub = event.data.object;
          const customerId = typeof sub.customer === "string" ? sub.customer : null;
          const uid = await uidForCustomer(customerId);
          if (!uid) {
            /* Filed as well as logged. This is the other end of the same
               failure: the checkout was never joined to an account, so no
               subscription event for it ever can be either. */
            await fileUnattributed(customerId || sub.id, "no account for this Stripe customer", {
              stripeCustomerId: customerId,
              subscription: sub.id,
              status: sub.status || null,
              livemode: !!event.livemode
            });
            logger.warn("subscription for an unknown customer", { customer: customerId, sub: sub.id });
            break;
          }
          await writeSubscription(uid, sub, event);
          break;
        }

        /* A deleted customer takes its subscriptions with it and normally
           sends those events too, but nothing may depend on that: this is the
           last chance to stop paying access from outliving the record. */
        case "customer.deleted": {
          const c = event.data.object;
          const uid = await uidForCustomer(typeof c.id === "string" ? c.id : null);
          if (!uid) {
            logger.warn("deleted customer with no account", { customer: c && c.id });
            break;
          }
          await revokeCustomer(uid, c.id);
          break;
        }

        default:
          /* Everything else is acknowledged and ignored. Returning non-200
             makes Stripe retry an event we were never going to act on.

             The two worth naming, because they look like they should be here
             and are not: `invoice.payment_failed` and `invoice.paid` change
             nothing this webhook stores — Stripe moves the subscription to
             `past_due`, `unpaid` or `active` at the same moment and sends
             `customer.subscription.updated` with it, and that is the event
             that carries the status. `customer.subscription.trial_will_end`
             is three days of notice with no state change in it. Acting on any
             of the three would be a second writer racing the first. */
          break;
      }
    } catch (err) {
      logger.error("handler failed", { type: event.type, message: err.message });
      /* 500 asks Stripe to retry, which is right for a transient Firestore
         failure and harmless for anything idempotent — every write here is. */
      return res.status(500).send("handler error");
    }

    return res.status(200).send("ok");
  }
);

/* The webhook payload carries almost everything, but a checkout session names
   its subscription by id only. Reading it back needs an API key; if none is
   configured we skip that step and let the subsequent
   customer.subscription.created event do the work instead. */
function stripeWithKey(event) {
  const key = process.env.STRIPE_API_KEY || "";
  if (!key) {
    return { subscriptions: { retrieve: () => Promise.reject(new Error("no api key")) } };
  }
  return new Stripe(key, { apiVersion: "2024-11-20.acacia" });
}

/* --------------------------------------------------------------------------
   The gated read path lives in its own file. Kept out of this one on purpose:
   the webhook above is deployed, working and load-bearing for revenue, and the
   cheapest way to keep it that way is to not edit it. `admin.initializeApp()`
   has already run by the time this line executes, which is why story.js only
   guards against a double init rather than performing one.
   -------------------------------------------------------------------------- */
exports.story = require("./story").story;

/* --------------------------------------------------------------------------
   The support inbox, likewise in its own file and for the same reason. It
   shares nothing with the webhook above except `admin.initializeApp()`, which
   has already run by the time this line executes.
   -------------------------------------------------------------------------- */
exports.support = require("./support").support;

/* --------------------------------------------------------------------------
   Which story is free today. Its own file for the same reason as the two
   above, and loaded here so it deploys alongside them. `story` requires it
   directly rather than through this file, so the two agree on the answer even
   if some future entry point loads one without the other.
   -------------------------------------------------------------------------- */
exports.today = require("./today").today;

/* --------------------------------------------------------------------------
   The admin analytics door. Its own file for the same reason as the three
   above, and the reason applies hardest here: this one is new, it is the only
   function that talks to a third party on an admin's behalf, while the webhook
   at the top of this file is deployed, working and load-bearing for revenue. `insights.js`
   verifies a Firebase ID token, re-reads the admin flag from Firestore itself,
   and runs one of eleven queries IT wrote against PostHog — it never accepts a
   query from a browser and never lets the PostHog key near one. The contract
   the dashboard is built against is ANALYTICS-API.md.
   -------------------------------------------------------------------------- */
exports.insights = require("./insights").insights;
