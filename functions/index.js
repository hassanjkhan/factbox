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
   to `canceled` on its own once the retries run out. */
const ACTIVE = ["active", "trialing", "past_due"];

/**
 * Everything about a subscription that the site actually needs, written flat.
 * The reader's own row is read on every page load, so it holds one boolean
 * rather than forcing the client to interpret Stripe's state machine.
 */
async function writeSubscription(uid, sub) {
  if (!uid) return;
  const active = ACTIVE.indexOf(sub.status) !== -1;
  const item = (sub.items && sub.items.data && sub.items.data[0]) || {};
  const price = item.price || {};

  const batch = db.batch();

  batch.set(
    db.doc(`customers/${uid}/subscriptions/${sub.id}`),
    {
      id: sub.id,
      status: sub.status,
      active,
      priceId: price.id || null,
      amount: typeof price.unit_amount === "number" ? price.unit_amount : null,
      currency: price.currency || null,
      interval: (price.recurring && price.recurring.interval) || null,
      intervalCount: (price.recurring && price.recurring.interval_count) || null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end
        ? admin.firestore.Timestamp.fromMillis(sub.current_period_end * 1000)
        : null,
      trialEnd: sub.trial_end
        ? admin.firestore.Timestamp.fromMillis(sub.trial_end * 1000)
        : null,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  /* The flag the site reads. Derived from every subscription this person has,
     not just the one that changed — somebody who cancels a monthly plan while
     holding an annual one is still a subscriber. */
  const snap = await db.collection(`customers/${uid}/subscriptions`).get();
  let anyActive = active;
  snap.forEach((d) => {
    const v = d.data();
    if (d.id !== sub.id && v && v.active) anyActive = true;
  });

  batch.set(
    db.doc(`customers/${uid}`),
    {
      uid,
      premium: anyActive,
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();
  logger.info("subscription written", { uid, sub: sub.id, status: sub.status, premium: anyActive });
}

/* A subscription event names the customer, not the account. This walks back to
   the uid we recorded at checkout — the only place the two are introduced. */
async function uidForCustomer(customerId) {
  if (!customerId) return null;
  const q = await db
    .collection("customers")
    .where("stripeCustomerId", "==", customerId)
    .limit(1)
    .get();
  return q.empty ? null : q.docs[0].id;
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
          /* The introduction. Every checkout URL carries the Firebase uid here. */
          const uid = s.client_reference_id || null;
          const customerId = typeof s.customer === "string" ? s.customer : null;

          if (uid && customerId) {
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
            /* Worth a loud log rather than a silent shrug: it means someone paid
               and we cannot yet say who they are. Recoverable by email. */
            logger.warn("checkout without a uid", {
              session: s.id, hasUid: !!uid, hasCustomer: !!customerId
            });
          }

          if (s.subscription) {
            const full = await stripeWithKey(event).subscriptions.retrieve(
              typeof s.subscription === "string" ? s.subscription : s.subscription.id
            ).catch(() => null);
            if (full && uid) await writeSubscription(uid, full);
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
            logger.warn("subscription for an unknown customer", { customer: customerId });
            break;
          }
          await writeSubscription(uid, sub);
          break;
        }

        default:
          /* Everything else is acknowledged and ignored. Returning non-200 makes
             Stripe retry an event we were never going to act on. */
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
