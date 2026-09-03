/* ==========================================================================
   Factbox — the support inbox.

   /support has two boxes. Until now both opened the reader's mail app, which
   works right up until the reader has no mail app configured — which is most
   people on a phone in an in-app browser, the exact audience this site has.
   The message was typed and then went nowhere.

   This is where it goes now: a document in `support/`, read in the Firebase
   console. Firestore rather than email because email needs a sending service
   and a credential, and this repo is public; a Firestore write needs neither,
   and it cannot bounce.

   WHY A FUNCTION AND NOT A CLIENT WRITE. Firestore rules could allow a
   client-side create with a shape check, and that would be shorter. What rules
   cannot do is rate-limit an anonymous browser: there is no uid to key on and
   no clock to compare against beyond `request.time`. A public write rule is a
   free write endpoint for anybody with a for-loop. So the collection stays
   deny-all in firestore.rules — no browser writes it, ever — and this function
   is the only door.

   THE THREE THINGS IT ENFORCES, in order of how much they matter:

   1. The document is BUILT here, not accepted from the caller. Six fields,
      named below, every one derived or sanitised. There is no path by which a
      key in the request body becomes a key in Firestore, so there is nothing
      to smuggle and no way to reach another collection.
   2. Hard length caps before anything is written. An uncapped string from a
      stranger is somebody else's hosting bill.
   3. A global daily quota, held in one Firestore document. An attacker who
      burns it has cost us a few hundred junk documents and has stopped the
      form for the day — at which point the page tells the reader to email
      hello@factbox.app, which is why that fallback is not decoration.

   WHAT IT DELIBERATELY DOES NOT DO. It stores no IP address and no hash of
   one. Per-IP throttling is in memory only (below), which is weaker than a
   Firestore-backed counter and is the right trade: the honest bound on abuse
   is the daily quota, and a salted-with-a-public-salt IP hash sitting in a
   database would be a privacy cost bought with no security.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* Where the founders read it. */
const COLLECTION = "support";
/* One document, holding today's date and today's count. */
const QUOTA_DOC = "support_meta/quota";

/* Caps. Every one of these is a number a stranger cannot argue with.
   4000 characters is about 700 words — longer than any real support message
   and short enough that ten thousand of them is a rounding error. */
const MAX_MESSAGE = 4000;
const MAX_EMAIL = 200;
const MAX_PAGE = 120;
const MAX_BODY_BYTES = 16 * 1024;   /* the whole request, before parsing */

/* Per-IP, in memory. maxInstances is 5, so a single attacker sees at worst
   five times these numbers; the daily quota is what actually bounds them. */
const MIN_GAP_MS = 20 * 1000;
const PER_IP_PER_HOUR = 8;
/* Per day, across everybody, in Firestore. Real volume is single digits. */
const PER_DAY = 300;

const seen = new Map();   /* ip -> { last: ms, hits: [ms, ...] } */

/* The two boxes on the page, and nothing else is a kind. Stored as the words
   a person wants to read in a console listing, not as an enum. */
const KINDS = {
  help: "Something is wrong",
  idea: "Story idea"
};

/* --- CORS ---------------------------------------------------------------
   The same allowlist story.js uses. Not `*`: nothing here is worth reading
   back, but a form endpoint that any page on the internet may POST to from a
   reader's browser is a page that can send us mail signed as that reader. */
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

function send(res, status, body) {
  res.set("Cache-Control", "private, no-store");
  return res.status(status).type("application/json").send(JSON.stringify(body));
}

/* --- Sanitising ---------------------------------------------------------
   Every one of these returns a value of a known type and a known maximum
   length, or null. Nothing downstream re-checks, because nothing downstream
   sees anything these did not produce. */

function text(v, max) {
  if (typeof v !== "string") return "";
  /* Control characters other than newline and tab are stripped rather than
     rejected: they arrive from paste, not from malice, and rejecting a
     message because of an invisible byte is a message thrown away. */
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s+|\s+$/g, "");
  return s.length > max ? s.slice(0, max) : s;
}

/* Deliberately loose, and matching js — the point is to catch a typo, not to
   argue about what an address may contain. */
function email(v) {
  const s = text(v, MAX_EMAIL);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

/* A path, and only a path. No origin, no query string, no fragment: the point
   is "which page were they on", and anything richer than that is a field a
   stranger can write prose into. */
function page(v) {
  const s = text(v, MAX_PAGE);
  return /^\/[A-Za-z0-9._~/-]*$/.test(s) ? s : "";
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  const first = fwd.split(",")[0].replace(/^\s+|\s+$/g, "");
  return first || req.ip || "unknown";
}

/* Per-instance, per-IP. Returns "" if the caller may proceed. */
function throttled(ip) {
  const now = Date.now();
  /* Bounded: an id-scan from a botnet must not grow the heap. */
  if (seen.size > 5000) seen.clear();

  const rec = seen.get(ip) || { last: 0, hits: [] };
  if (now - rec.last < MIN_GAP_MS) return "too_fast";

  rec.hits = rec.hits.filter((t) => now - t < 60 * 60 * 1000);
  if (rec.hits.length >= PER_IP_PER_HOUR) return "too_many";

  rec.last = now;
  rec.hits.push(now);
  seen.set(ip, rec);
  return "";
}

/* Today, as the console shows it and as the quota counts it. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/* A document id that sorts. The console lists documents by id, so a random
   auto-id means an inbox in no order at all; this one puts today's messages
   at the bottom of the list and reads as a date on its own.
   The four random characters are there so two messages in the same second do
   not collide, not for secrecy. */
function docId(when) {
  const stamp = when.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  let tail = "";
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  for (let i = 0; i < 4; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  return stamp + "-" + tail;
}

/**
 * Who is asking, if they said. A support message from a signed-in reader is
 * worth more than one from a stranger — it can be answered through the
 * account — but a bad token must never stop a message: the people who most
 * need support are the ones whose sign-in is broken.
 */
async function whoIfKnown(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return "";
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    return decoded && decoded.uid ? String(decoded.uid) : "";
  } catch (err) {
    return "";
  }
}

exports.support = onRequest(
  {
    region: "us-central1",
    cors: false,          /* handled above, with an allowlist */
    memory: "256MiB",
    maxInstances: 5,
    concurrency: 40,
    timeoutSeconds: 20
  },
  async (req, res) => {
    cors(req, res);

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });

    /* Before parsing, not after. */
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX_BODY_BYTES) return send(res, 413, { ok: false, error: "too_long" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const asked = String(body.kind || "");
    const kind = Object.prototype.hasOwnProperty.call(KINDS, asked) ? asked : "";
    if (!kind) return send(res, 400, { ok: false, error: "bad_request" });

    /* The one thing the reader definitely typed. Measured before truncation,
       so "you wrote 6,000 characters" is answered honestly rather than
       silently keeping the first 4,000. */
    const raw = typeof body.message === "string" ? body.message : "";
    if (raw.replace(/^\s+|\s+$/g, "").length > MAX_MESSAGE) {
      return send(res, 400, { ok: false, error: "too_long", max: MAX_MESSAGE });
    }
    const message = text(raw, MAX_MESSAGE);
    if (!message) return send(res, 400, { ok: false, error: "empty" });

    const ip = clientIp(req);
    const slow = throttled(ip);
    if (slow) return send(res, 429, { ok: false, error: slow });

    const uid = await whoIfKnown(req);
    const when = new Date();
    const ref = db.doc(COLLECTION + "/" + docId(when));

    try {
      await db.runTransaction(async (tx) => {
        const day = today();
        const quotaRef = db.doc(QUOTA_DOC);
        const snap = await tx.get(quotaRef);
        const cur = snap.exists ? snap.data() : {};
        const count = cur.day === day ? Number(cur.count || 0) : 0;
        if (count >= PER_DAY) {
          const e = new Error("quota");
          e.code = "quota";
          throw e;
        }

        /* Field ORDER is field NAME here: the Firestore console sorts a
           document's fields alphabetically, so the only way to control what
           the founders read first is what the fields are called. In order:
           when, who to reply to, which box, what they said, where from, and
           their account if they had one. */
        tx.create(ref, {
          at: admin.firestore.Timestamp.fromDate(when),
          from: email(body.email),
          kind: KINDS[kind],
          message: message,
          page: page(body.page) || "/support",
          uid: uid
        });

        tx.set(quotaRef, { day: day, count: count + 1 }, { merge: true });
      });
    } catch (err) {
      if (err && err.code === "quota") {
        logger.warn("support quota spent", { day: today(), cap: PER_DAY });
        return send(res, 429, { ok: false, error: "quota" });
      }
      logger.error("support write failed", { message: err && err.message });
      return send(res, 500, { ok: false, error: "write_failed" });
    }

    /* Logged without the message in it. The document is the message; a log
       line is for knowing one arrived. */
    logger.info("support message", { id: ref.id, kind: kind, signedIn: !!uid, chars: message.length });
    return send(res, 200, { ok: true });
  }
);
