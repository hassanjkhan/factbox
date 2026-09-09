/* ==========================================================================
   Factbox — promo codes for the comment→DM campaign.

   THE CAMPAIGN. Kathryn posts a reel: "comment HISTORY and I'll DM you a week
   free." ManyChat DMs every commenter a link carrying a code minted for them
   alone — https://factbox.app/join?code=XXXX-XXXX-XXXX. That link must give
   them a SEVEN day trial. Everybody else gets the standard trial, whatever
   `TRIAL_DAYS` in js/account.js says it is.

   THE RULE THIS FILE EXISTS TO ENFORCE. The site must never say "a week free"
   unless the reader is actually getting a week. The code in the URL is a
   CLAIM. Only this function's answer is a FACT, and the browser renders its
   trial copy from the answer, never from the URL. A code that is expired,
   already spent or invented falls back to the standard wording SILENTLY —
   never an error page, and never the week-free copy with a three-day checkout
   behind it. That last combination is the worst outcome available here: it
   promises something the till will not honour.

   WHAT A CODE DOES AND DOES NOT DO. Read this before extending anything here.

     A PROMO CODE NEVER GRANTS ACCESS. `customers/{uid}.premium` is written by
     the Stripe webhook in index.js and by nothing else, ever. All a code does
     is change WHICH Stripe Payment Link the reader is sent to — one whose
     trial_period_days is 7 instead of 3. Entitlement still arrives the only
     way it has ever arrived: Stripe takes the card, Stripe posts the webhook,
     the webhook writes the boolean. If a future change to this file can make
     somebody premium without a Stripe event, that change is wrong.

   WHERE THE CODES LIVE. `promo_codes/{CODE}` — the document id IS the
   normalised code, which is what makes minting a `create()` that cannot
   silently overwrite somebody else's live code, and what makes validate a
   single get by id rather than a query. firestore.rules denies the browser
   both read and write on that collection, exactly the way it denies
   `stories/`: the ONLY reader is this function, which runs with admin
   credentials and therefore does not pass through the rules at all. Making
   the function the only door means the door can be watched — and means a
   browser holding the Firestore SDK cannot enumerate the campaign and drain
   it.

   TWO OPERATIONS, AND THE SPLIT MATTERS.

     validate — "what is this code?" Called on page load. It performs NO
                write. A reader may open their DM link twice, may reload, may
                come back tomorrow, and may bounce through /login on the way
                to checkout; every one of those is a second validate, and if
                validate spent the code the second visit would silently
                demote them to the standard trial they were not promised.

     redeem   — "this person is starting checkout now." Marks the code used,
                bound to a Firebase uid, in a transaction. Requires a verified
                Firebase ID token, because "used by whom" is worth nothing if
                the browser gets to name the whom.

   REDEEM IS IDEMPOTENT FOR THE UID THAT HOLDS IT. A reader who reaches Stripe,
   changes their mind and comes back must not find their own code spent
   against them. `usedByUid === this uid` answers `valid`, not `used`.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

/* index.js initialises first when this is loaded through it; the guard is for
   the case where some future entry point loads this module on its own. Same
   shape as today.js and story.js. */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COLLECTION = "promo_codes";

/* ==========================================================================
   THE LENGTH OF THE PROMOTIONAL TRIAL.

   THIS NUMBER MUST EQUAL `PROMO.trialDays` IN js/account.js, AND BOTH MUST
   EQUAL THE `trial_period_days` ON THE PROMO PAYMENT LINKS IN STRIPE.

   Three copies of one fact, in three systems that cannot import from each
   other, so a guard asserts the first two agree:
   tools/check-regressions.js, "the promo trial length agrees everywhere".
   The third — Stripe's own setting — is checked by loading the link, the way
   STRIPE.md §2 established the three-day figure.

   It is also a CLAMP, not just a default. A minted document carries its own
   `trialDays`, and this function refuses to report any value other than the
   one below — a mis-minted 30-day code comes back `unknown` rather than
   putting a month of free copy on a screen backed by a week-long link. The
   copy the reader sees is only ever as long as the link the reader gets.
   ========================================================================== */
const PROMO_TRIAL_DAYS = 7;

/* --- the alphabet -------------------------------------------------------
   Must match tools/mint-promo-codes.js exactly.

   28 symbols. Every vowel is gone (A, E, I, O, U) and so is L. That does two
   jobs at once:

     1. It removes every pair that is confusable in a DM read on a phone or
        retyped by hand — O against 0, I against 1 against l — by removing
        BOTH members of each pair, so there is nothing to "helpfully" map on
        input and no chance of mapping it the wrong way.
     2. No vowels means no code can accidentally spell a word. A campaign is
        thousands of random strings; without this, one of them eventually
        arrives in somebody's DMs spelling something the brand has to answer
        for.

   S/5 and Z/2 survive, and that is a deliberate, priced trade: these codes
   are CLICKED from a DM, not dictated over a phone, and removing four more
   symbols to cover a case that barely occurs costs entropy for nothing. */
const ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN = 12;                       /* 28^12 ≈ 2.3e17 ≈ 57.7 bits */
const CODE_SHAPE = new RegExp("^[" + ALPHABET + "]{" + CODE_LEN + "}$");

/* Codes are minted, printed and pasted as XXXX-XXXX-XXXX. The hyphens are
   punctuation for a human eye and are not part of the code, so they are
   stripped here rather than required — a reader who retypes it without them,
   or with a space, or in lower case, still resolves to the same document.
   Nothing else is repaired: an unrecognised character simply fails to match
   the shape, which is the designed outcome (standard trial, silently). */
function normalise(v) {
  if (typeof v !== "string") return "";
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length > 64 ? s.slice(0, 64) : s;
}

/* --- CORS ---------------------------------------------------------------
   The same allowlist story.js, support.js and today.js use. Four that agree
   are easier to audit than three that agree and one that does not. */
const ALLOWED = [
  "https://factbox.app",
  "https://www.factbox.app"
];

function originAllowed(origin) {
  if (!origin) return null;
  if (ALLOWED.indexOf(origin) !== -1) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) return origin;
  return null;
}

function cors(req, res) {
  const ok = originAllowed(req.headers.origin);
  if (ok) res.set("Access-Control-Allow-Origin", ok);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

/* Never cached, in any shared cache, ever. A cached `valid` would hand one
   person's week to whoever asked next from the same egress. */
function send(res, status, body) {
  res.set("Cache-Control", "private, no-store");
  return res.status(status).type("application/json").send(JSON.stringify(body));
}

/* --- rate limiting -------------------------------------------------------
   Different from today.js's, because the threat is different. today.js hands
   out a public fact and is throttled only to bound the bill. This endpoint
   answers "is this string a live code", which is an oracle: hammer it and you
   are guessing codes.

   The real defence is the entropy — 57.7 bits, so a thousand guesses a second
   for a century is still nothing — and per-IP memory is the cheap second
   layer against the only attack that exists in practice, one script in a
   loop. maxInstances caps the bill however hard it is hit.

   Loose enough not to refuse real readers: a great many share one exit
   address, and a genuine reader spends one validate on load and one redeem
   on the buy tap. */
const PER_IP_PER_MINUTE = 60;
const seen = new Map();

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  const first = fwd.split(",")[0].replace(/^\s+|\s+$/g, "");
  return first || req.ip || "unknown";
}

function throttled(ip) {
  const now = Date.now();
  /* Bounded so a spray from many addresses cannot grow the heap. */
  if (seen.size > 5000) seen.clear();
  const rec = seen.get(ip) || { hits: [] };
  rec.hits = rec.hits.filter((t) => now - t < 60 * 1000);
  if (rec.hits.length >= PER_IP_PER_MINUTE) return "too_many";
  rec.hits.push(now);
  seen.set(ip, rec);
  return "";
}

/* --- reading a code -----------------------------------------------------

   THE FOUR STATES, and what the browser does with each:

     valid    the only one that changes anything. The browser may render the
              longer wording and send the reader to the promo Payment Link.
     used     spent already, by somebody else or on another device.
     expired  the campaign window has closed.
     unknown  no such document — a typo, a guess, a code from a campaign that
              was deleted, or a mis-minted trial length this build refuses.

   The last three are ALL the same instruction to the browser: say nothing,
   change nothing, render the standard trial. They are distinguished only so
   that a support conversation and the logs can tell "your code was already
   used" from "that is not a code", which is the difference between a reader
   we can help and a reader who mistyped. */

function millis(v) {
  try {
    if (!v) return 0;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
  } catch (e) { /* a malformed stamp is not a reason to fail a read */ }
  return 0;
}

/* The state of a document, with no writes and no opinions about who is
   asking. `uid` is optional and only affects the used/valid split. */
function stateOf(data, uid) {
  if (!data) return "unknown";

  /* The clamp. A document minted with some other trial length is not a
     shorter offer, it is a code this build has no honest link for. */
  const days = Number(data.trialDays);
  if (days !== PROMO_TRIAL_DAYS) return "unknown";

  const exp = millis(data.expiresAt);
  if (exp && exp <= Date.now()) return "expired";

  const usedBy = typeof data.usedByUid === "string" ? data.usedByUid : "";
  if (data.usedAt || usedBy) {
    /* Their own code, coming back. Not spent against them. */
    if (uid && usedBy && usedBy === uid) return "valid";
    return "used";
  }

  return "valid";
}

/* --- who is asking ------------------------------------------------------
   Only redeem needs this. `verifyIdToken` with checkRevoked, the same call
   insights.js makes, because "used by whom" is worth nothing if the browser
   names the whom. */
async function uidFrom(req) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return "";
  try {
    const decoded = await admin.auth().verifyIdToken(m[1], true);
    return (decoded && decoded.uid) ? String(decoded.uid) : "";
  } catch (err) {
    logger.warn("promo: id token rejected", { message: err && err.message });
    return "";
  }
}

/* --- the endpoint -------------------------------------------------------- */

exports.promo = onRequest(
  {
    region: "us-central1",
    cors: false,          /* handled above, with an allowlist */
    memory: "256MiB",
    maxInstances: 5,
    concurrency: 80,
    timeoutSeconds: 10
  },
  async (req, res) => {
    cors(req, res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") {
      return send(res, 405, { ok: false, error: "method_not_allowed" });
    }

    const slow = throttled(clientIp(req));
    if (slow) {
      res.set("Retry-After", "1");
      return send(res, 429, { ok: false, error: slow });
    }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const op = String(body.op || "validate");
    const code = normalise(body.code);

    /* A malformed code is answered exactly like a code that does not exist,
       with no Firestore read spent on it. `ok` is true because the QUESTION
       was answered; `state` carries the news. A 4xx here would put an error
       in the browser console of every reader who fat-fingered a URL, and the
       whole design of this feature is that a bad code is a non-event. */
    if (!CODE_SHAPE.test(code)) {
      return send(res, 200, { ok: true, state: "unknown", trialDays: 0 });
    }

    const ref = db.collection(COLLECTION).doc(code);

    /* ---- validate: read only, and that is load-bearing ------------------ */
    if (op === "validate") {
      /* A uid is welcome but never required — the page validates before the
         reader has necessarily signed in. It is used only so a reader who
         already redeemed on this device is told `valid` rather than `used`. */
      let uid = "";
      try { uid = await uidFrom(req); } catch (e) { uid = ""; }

      let snap = null;
      try {
        snap = await ref.get();
      } catch (err) {
        /* Firestore refused or timed out. Say so honestly with a 503 and let
           the browser keep the standard copy it is already showing. What must
           NOT happen is inventing a `valid` on a failed read. */
        logger.error("promo validate failed", { message: err && err.message });
        return send(res, 503, { ok: false, error: "unavailable" });
      }

      const data = snap.exists ? snap.data() : null;
      const state = stateOf(data, uid);
      return send(res, 200, {
        ok: true,
        state: state,
        trialDays: state === "valid" ? PROMO_TRIAL_DAYS : 0,
        campaign: (state === "valid" && data && typeof data.campaign === "string")
          ? data.campaign : ""
      });
    }

    /* ---- redeem: one transaction, at the moment checkout starts ---------- */
    if (op === "redeem") {
      const uid = await uidFrom(req);
      if (!uid) {
        /* No verified account, no redemption. The client refuses to start an
           unattributed checkout anyway (STRIPE.md §1), so by the time this is
           called there is always a uid; this is the same refusal on the
           server side, because a one-sided defence is no defence. */
        return send(res, 401, { ok: false, error: "unauthenticated" });
      }

      let state = "unknown";
      let campaign = "";
      try {
        state = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const data = snap.exists ? snap.data() : null;
          const s = stateOf(data, uid);
          if (data && typeof data.campaign === "string") campaign = data.campaign;
          if (s !== "valid") return s;

          /* Already ours: nothing to write, and rewriting `usedAt` would move
             the redemption timestamp every time they bounce back from Stripe. */
          if (data && data.usedByUid === uid) return "valid";

          tx.update(ref, {
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
            usedByUid: uid
          });
          return "valid";
        });
      } catch (err) {
        logger.error("promo redeem failed", { message: err && err.message });
        return send(res, 503, { ok: false, error: "unavailable" });
      }

      if (state === "valid") {
        /* Loud on purpose. This is the join key between a DM and a checkout:
           when Kathryn asks how the reel did, this line and the document are
           the record. No email, no name — a uid and a campaign. */
        logger.info("promo redeemed", { campaign: campaign, uid: uid });
      }

      return send(res, 200, {
        ok: true,
        state: state,
        trialDays: state === "valid" ? PROMO_TRIAL_DAYS : 0,
        campaign: state === "valid" ? campaign : ""
      });
    }

    return send(res, 400, { ok: false, error: "unknown_op" });
  }
);

/* Exported for tools/check-regressions.js and for any future caller that
   needs the campaign's shape without re-typing it. */
exports.PROMO_TRIAL_DAYS = PROMO_TRIAL_DAYS;
exports.ALPHABET = ALPHABET;
exports.CODE_LEN = CODE_LEN;
exports.COLLECTION = COLLECTION;
