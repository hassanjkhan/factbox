/* ==========================================================================
   Factbox — the support inbox.

   /support has two boxes. Until recently both opened the reader's mail app,
   which works right up until the reader has no mail app configured — which is
   most people on a phone in an in-app browser, the exact audience this site
   has. The message was typed and then went nowhere.

   Two places it goes now, in this order and never the other way round:

     1. A document in `support/`, read in the Firebase console. This is the
        archive. It cannot bounce, it cannot be rate-limited by somebody
        else's service, and it is what the privacy policy describes.
     2. An email to hello@factbox.app, so nobody has to remember to open a
        console. This is a convenience laid on top of the archive and is
        allowed to fail: a support form that returns 500 because a mail
        provider is having an afternoon is worse than one that only archives.

   STORE FIRST, MAIL SECOND, AND NEVER LET THE MAIL DECIDE THE ANSWER. The
   response to the reader is settled by whether the document was written. If
   the mail key is absent, wrong, rate-limited or the provider is down, the
   reader still sees "Sent", because it was — to the place we actually read.

   WHY A FUNCTION AND NOT A CLIENT WRITE. Firestore rules could allow a
   client-side create with a shape check, and that would be shorter. What rules
   cannot do is rate-limit an anonymous browser: there is no uid to key on and
   no clock to compare against beyond `request.time`. A public write rule is a
   free write endpoint for anybody with a for-loop. So the collection stays
   deny-all in firestore.rules — no browser writes it, ever — and this function
   is the only door.

   WHAT IT ENFORCES, in order of how much it matters:

   1. The document is BUILT here, not accepted from the caller. Six fields,
      named below, every one derived or sanitised. There is no path by which a
      key in the request body becomes a key in Firestore, so there is nothing
      to smuggle and no way to reach another collection. Six is also the number
      the privacy policy publishes, so it does not grow without that changing.
   2. Hard length caps before anything is written. An uncapped string from a
      stranger is somebody else's hosting bill.
   3. Rate limits that survive a cold start. See the next block — this is the
      part that changed, and it changed because the old one did not.
   4. Separate budgets for storing and for mailing, because a stored message
      costs a fraction of a cent and a sent one spends a finite daily
      allowance at a third party. When the mail budget is gone the archive
      keeps accepting; the founders read the console for the rest of the day.

   --- WHY THE IN-MEMORY THROTTLE WAS NOT A THROTTLE ---------------------

   The previous version kept `const seen = new Map()` at module scope and
   counted per IP in it. That is per *instance*. Cloud Functions runs up to
   `maxInstances` containers, each with its own empty Map, and every cold start
   hands an attacker a fresh one. The real limit was therefore about
   `PER_IP_PER_HOUR × instances`, and anyone spreading requests over a few
   seconds — which is to say anyone at all — effectively had none.

   The Map is still here, and it is still the first thing consulted, because it
   is free and it catches the honest double tap without touching the database.
   It is no longer what decides. Underneath it is a Firestore document per IP
   bucket, read and written inside the same transaction that writes the
   message, which is shared by every instance and outlives all of them.

   --- WHAT THAT COSTS IN PRIVACY, SAID PLAINLY --------------------------

   A cross-instance per-IP counter has to key on something derived from the IP.
   This one stores HMAC-SHA-256(daily secret salt, IP), truncated, as a
   document id under `support_ip/`. It stores no address, no message and no
   account — only counts and two timestamps — the salt is a random 32 bytes
   regenerated every UTC day and held in a deny-all Firestore document, and
   every counter document carries `expiresAt` for a Firestore TTL policy so it
   deletes itself about a day later.

   Be honest about the limit of that: IPv4 is four billion addresses, so anyone
   holding the salt could brute-force the mapping back. The salt lives where
   only the project owners can read it and it is gone within the day. This is
   still strictly more than the previous version stored, which was nothing,
   and privacy.html §08 currently says "Your IP address is not stored, and
   neither is a hash of it." That sentence is now wrong and has to change —
   flagged, not edited, because that file belongs to another hand.

   IPv6 is truncated to its /64 before hashing, because a single subscriber is
   routinely handed a whole /64 and counting /128s would be counting nothing.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* --- The mail credential ------------------------------------------------
   Held in Secret Manager, never in the repo and never in an env file — this
   repository is public. The function deploys and runs with this set to
   anything at all, including the placeholder it ships with: a value that does
   not look like a Resend key means "mail is switched off", and switched off is
   a working support form that archives. See SUPPORT-EMAIL.md for the four
   things the owner has to do to switch it on. */
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/* --- Where things live -------------------------------------------------- */
const COLLECTION = "support";            /* the archive the founders read */
const QUOTA_DOC = "support_meta/quota";  /* today's date, today's two counts */
const SALT_DOC = "support_meta/salt";    /* today's date, today's HMAC salt */
const IP_COLLECTION = "support_ip";      /* one counter per hashed IP per day */

/* --- Caps. Every one of these is a number a stranger cannot argue with. ---
   4000 characters is about 700 words — longer than any real support message
   and short enough that ten thousand of them is a rounding error. */
const MAX_MESSAGE = 4000;
const MAX_EMAIL = 200;
const MAX_PAGE = 120;
const MAX_BODY_BYTES = 16 * 1024;   /* the whole request, before parsing */

/* Per IP. The first two are unchanged in value and completely changed in
   effect: they are now counted in Firestore, so they mean what they say
   however many instances are running and however cold each one is.
   MIN_GAP_MS is also repeated in support.html, so a double tap is answered
   locally instead of over the wire; changing it here wants changing there. */
const MIN_GAP_MS = 20 * 1000;
const PER_IP_PER_HOUR = 8;
const PER_IP_PER_DAY = 20;

/* Per day, across everybody. Real volume is single digits. Two budgets, and
   the mail one is deliberately the smaller: storing is ours and costs a
   fraction of a cent, mailing spends a third party's daily allowance. When
   MAIL_PER_DAY is gone the form still works and the console still fills. */
const PER_DAY = 300;
const MAIL_PER_DAY = 80;
const MAIL_PER_IP_PER_DAY = 5;

/* How long a per-IP counter document is worth keeping. Longer than the day it
   counts, so a rollover cannot lose the count mid-write; short enough that
   nothing here accumulates. Enforced by a Firestore TTL policy on
   `support_ip.expiresAt`; the field is written whether or not the policy is
   installed, so installing it later needs no code change. */
const IP_TTL_MS = 26 * 60 * 60 * 1000;

/* --- Mail ---------------------------------------------------------------
   TO is a constant and is never, under any circumstances, taken from the
   request. A `To:` a stranger can set is an open relay that sends spam signed
   by our own domain, from our own reputation, and it is the single most
   expensive mistake available on this page.

   FROM must be an address at a domain verified in Resend. `send.factbox.app`
   is recommended over the root domain precisely because the root domain is
   where hello@factbox.app is delivered, and a sending setup should not be
   able to break the mailbox it sends to. This is the one line to change if
   the owner verifies something else. */
const MAIL_TO = "hello@factbox.app";
const MAIL_FROM = "Factbox support <support@send.factbox.app>";
const MAIL_ENDPOINT = "https://api.resend.com/emails";
const MAIL_TIMEOUT_MS = 5000;

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
     message because of an invisible byte is a message thrown away.
     Carriage returns go with them — \r\n becomes \n and a lone \r becomes
     nothing. That is worth saying twice, because a bare CR is half of the
     classic header-injection sequence and this is where it dies. */
  const s = v.replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "")
    .replace(/^\s+|\s+$/g, "");
  return s.length > max ? s.slice(0, max) : s;
}

/* Deliberately loose, and matching js — the point is to catch a typo, not to
   argue about what an address may contain. This is what gets STORED. */
function email(v) {
  const s = text(v, MAX_EMAIL);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

/* And this is what may become a Reply-To header, which is a different and
   much less forgiving question. Loose is right for a database field nobody
   parses; loose is wrong for a header. One address, no display name, no
   comment, no list, no quoting, ASCII only, and a hard rejection of every
   character that could end a header line or start a new one.

   Resend takes reply_to as a JSON field rather than a raw header, so it
   escapes this for us and a CRLF here cannot split a header even if it got
   through. That is a second lock, not the first one. If this ever moves to
   SMTP, this function is the only thing standing between an anonymous
   textarea and an injected Bcc, so it stays strict. */
function replyTo(addr) {
  const s = String(addr || "");
  if (!s || s.length > 254) return "";
  if (/[^\x21-\x7E]/.test(s)) return "";              /* no space, no control, no CR/LF, ASCII only */
  if (/[<>,;:"'\\()\[\]]/.test(s)) return "";         /* no display name, list, comment or quoting */
  const at = s.split("@");
  if (at.length !== 2) return "";
  const local = at[0], domain = at[1];
  if (!local || local.length > 64 || !domain || domain.length > 189) return "";
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return "";
  if (local.charAt(0) === "." || local.charAt(local.length - 1) === "." || local.indexOf("..") !== -1) return "";
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) return "";
  return s;
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
  const ip = first || req.ip || "unknown";
  /* An IPv6 subscriber is routinely handed a whole /64 to spend, so counting
     /128s would be counting nothing at all. Four hextets, and no further:
     bucketing more coarsely than a /64 starts to catch strangers together. */
  if (ip.indexOf(":") !== -1) {
    return ip.toLowerCase().split(":").slice(0, 4).join(":") + "::/64";
  }
  return ip;
}

/* --- The free first pass ------------------------------------------------
   Per instance, per IP, in memory. Not the throttle — the throttle is in
   Firestore, below — but it costs nothing, it needs no read, and it turns the
   commonest abusive shape (one client hammering one warm instance) into zero
   database traffic. Anything it lets through is checked properly. */
const seen = new Map();

function throttledLocally(ip) {
  const now = Date.now();
  if (seen.size > 5000) seen.clear();   /* bounded: a botnet must not grow the heap */
  const rec = seen.get(ip) || { last: 0, hits: [] };
  if (now - rec.last < MIN_GAP_MS) return "too_fast";
  rec.hits = rec.hits.filter((t) => now - t < 60 * 60 * 1000);
  if (rec.hits.length >= PER_IP_PER_HOUR) return "too_many";
  rec.last = now;
  rec.hits.push(now);
  seen.set(ip, rec);
  return "";
}

/* Today and this hour, as the quota counts them. UTC in both cases, which is
   also how Resend's own daily allowance rolls over. */
function today(d) { return (d || new Date()).toISOString().slice(0, 10); }
function thisHour(d) { return (d || new Date()).toISOString().slice(0, 13); }

/* --- The per-IP key -----------------------------------------------------
   A random salt per UTC day, in a deny-all document, memoised per instance so
   this costs one transaction per instance per day rather than one per
   request. The memo cannot be allowed to drift between instances — two
   instances holding two different salts for the same day would split every
   counter in half and quietly reinstate exactly the bug this replaces — so
   the rotation happens inside a transaction and the loser adopts the winner's
   salt rather than keeping its own. */
let saltMemo = { day: "", value: "" };

async function dailySalt(day) {
  if (saltMemo.day === day && saltMemo.value) return saltMemo.value;
  const ref = db.doc(SALT_DOC);
  let value = "";
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    if (cur.day === day && typeof cur.salt === "string" && cur.salt.length >= 32) {
      value = cur.salt;
      return;
    }
    value = crypto.randomBytes(32).toString("hex");
    tx.set(ref, {
      day: day,
      salt: value,
      rotatedAt: admin.firestore.Timestamp.now()
    });
  });
  saltMemo = { day: day, value: value };
  return value;
}

/* 24 hex characters is 96 bits of the HMAC. Collisions at this volume are not
   a thing that happens, and a shorter id is a shorter thing to leak. */
function ipKey(salt, ip, day) {
  return crypto.createHmac("sha256", salt).update(day + "|" + ip).digest("hex").slice(0, 24);
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

/* --- Is mail switched on? ----------------------------------------------
   The secret always exists, because a v2 function that declares a secret will
   not deploy without one. It ships holding a placeholder. Anything that is
   not shaped like a Resend key is read as "off", and off is a support form
   that archives and answers 200 — which is the entire point of building it
   this way round. */
function mailKey() {
  try {
    return String(RESEND_API_KEY.value() || "").trim();
  } catch (err) {
    return "";
  }
}
function mailOn(key) {
  return /^re_[A-Za-z0-9_-]{16,}$/.test(key);
}

/* --- The email ----------------------------------------------------------
   Written by an anonymous stranger, so:

   • It is TEXT. No html field is sent at all. The message may be full of
     markup and it will be read as the characters it is, in a mail client
     that has nothing to execute.
   • Nothing the reader typed reaches a header. The subject is built from a
     constant and the document id. `to` is a constant. `reply_to` is the one
     exception and it has been through replyTo() above, which permits one
     bare address of ASCII and rejects everything else.
   • The message sits between two fences and is announced as unverified,
     because the address at the top of it is a string somebody typed into a
     box, not an identity anybody checked. A reply to it goes wherever they
     said, and that is worth reading before hitting reply.
   • It is already capped at MAX_MESSAGE by the time it gets here.

   The payload is built by its own function so a test can look at it without a
   mail account, a network or a key. That is the whole security surface of
   this feature in one object; it is worth being able to assert on. */
/* Everything that goes into the metadata block is forced onto one line
   first. In practice none of these can hold a newline by the time they get
   here — email() and page() reject anything with whitespace and the rest are
   generated — but the payload builder should not be the place that depends on
   somebody else having checked. */
function oneLine(v, max) {
  return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").slice(0, max || 200);
}

function mailPayload(doc) {
  const id = oneLine(doc.id, 60);
  const kind = oneLine(doc.kind, 40);
  const where = oneLine(doc.page, MAX_PAGE);
  const uid = oneLine(doc.uid, 128);
  const given = oneLine(doc.from, MAX_EMAIL);
  const from = replyTo(given);

  /* THE FENCE CARRIES THE DOCUMENT ID, and that is not decoration. The id is
     minted on this server after the message was typed, so a stranger cannot
     know it and cannot write a line that looks like the end of their own
     message. With a fixed fence they can, and then everything they write
     after it reads as ours — which is how a plausible-looking instruction
     ends up in an email that appears to come from the site itself. */
  const open  = "----- message begins [" + id + "] -----";
  const close = "----- message ends [" + id + "] -----";

  const lines = [
    "A message from the Factbox support page.",
    "",
    "Box      : " + kind,
    "Page     : " + where,
    "Account  : " + (uid || "not signed in"),
    "Reply to : " + (given || "no address given, so there is nowhere to reply"),
    "Archived : support/" + id,
    ""
  ];

  if (from) {
    lines.push(
      "THAT REPLY ADDRESS IS UNVERIFIED. It is whatever was typed into the box and",
      "nobody proved they own it. Replying tells that address a human read this."
    );
  } else if (given) {
    lines.push(
      "The address given is not one plain address, so Reply-To is not set on this",
      "email. It is stored, and shown above, as text."
    );
  } else {
    lines.push("No address was given, so Reply-To is not set on this email.");
  }

  lines.push(
    "",
    open,
    doc.message,
    close,
    "",
    "Read it, and delete it, in the Firebase console:",
    "https://console.firebase.google.com/project/factbox-7cb97/firestore/data/~2Fsupport~2F" + id
  );

  const payload = {
    from: MAIL_FROM,
    to: [MAIL_TO],                       /* CONSTANT. Never from the request. */
    subject: "Factbox \u2014 " + kind + " \u2014 " + id,
    text: lines.join("\n")
  };
  /* Only if it survived the strict parse. An address that did not is still in
     the body above, where it is text and cannot be a header. */
  if (from) payload.reply_to = from;
  return payload;
}

/* Returns a short string: "" for sent, or a reason. It never throws and its
   return value never reaches the reader. */
async function sendMail(key, doc) {
  const payload = mailPayload(doc);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAIL_TIMEOUT_MS);
  try {
    const r = await fetch(MAIL_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        /* So a retry anywhere in the stack cannot mail the same message
           twice. The document id is unique per message by construction. */
        "Idempotency-Key": doc.id
      },
      body: JSON.stringify(payload)
    });
    if (r.status >= 200 && r.status < 300) return "";
    const detail = await r.text().catch(() => "");
    return "http_" + r.status + " " + detail.replace(/\s+/g, " ").slice(0, 200);
  } catch (err) {
    return (err && err.name === "AbortError") ? "timeout" : ("failed: " + (err && err.message));
  } finally {
    clearTimeout(timer);
  }
}

exports.support = onRequest(
  {
    region: "us-central1",
    cors: false,          /* handled above, with an allowlist */
    secrets: [RESEND_API_KEY],
    memory: "256MiB",
    maxInstances: 5,
    concurrency: 40,
    timeoutSeconds: 30    /* was 20; the mail hop is bounded at 5s of it */
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

    /* Free, per instance, and not authoritative. */
    const localBlock = throttledLocally(ip);
    if (localBlock) return send(res, 429, { ok: false, error: localBlock });

    const uid = await whoIfKnown(req);
    const when = new Date();
    const day = today(when);
    const hour = thisHour(when);
    const id = docId(when);
    const ref = db.doc(COLLECTION + "/" + id);

    const key = mailKey();
    const wantMail = mailOn(key);

    /* --- One transaction: the counters and the message ------------------
       Two reads, three writes, atomically. Doing the limits in the same
       transaction as the write is the whole reason this holds across
       instances: there is no window in which two containers both read "seven
       this hour" and both write the eighth.

       A refusal throws before any write, so a hammering client costs two
       reads and nothing else. Firestore retries a transaction on contention,
       not on an error thrown by this callback, so a refusal is final. */
    let mayMail = false;
    try {
      const salt = await dailySalt(day);
      const ipRef = db.doc(IP_COLLECTION + "/" + ipKey(salt, ip, day));
      const quotaRef = db.doc(QUOTA_DOC);

      await db.runTransaction(async (tx) => {
        const snaps = await tx.getAll(ipRef, quotaRef);
        const ipSnap = snaps[0], quotaSnap = snaps[1];
        const rec = ipSnap.exists ? (ipSnap.data() || {}) : {};
        const q = quotaSnap.exists ? (quotaSnap.data() || {}) : {};
        const now = when.getTime();

        function deny(code) {
          const e = new Error(code);
          e.code = code;
          return e;
        }

        /* Per IP, authoritative. Counts reset by simply not matching the
           stored hour or day — no sweep, no cleanup, no array of timestamps
           growing inside a document somebody else pays to read. */
        if (now - Number(rec.last || 0) < MIN_GAP_MS) throw deny("too_fast");
        const perHour = rec.hour === hour ? Number(rec.hourCount || 0) : 0;
        if (perHour >= PER_IP_PER_HOUR) throw deny("too_many");
        const perDay = rec.day === day ? Number(rec.dayCount || 0) : 0;
        if (perDay >= PER_IP_PER_DAY) throw deny("too_many");

        /* Global, and the honest bound on what a distributed flood can do. */
        const stored = q.day === day ? Number(q.count || 0) : 0;
        if (stored >= PER_DAY) throw deny("quota");

        /* The mail budget is spent here and reserved here, so two concurrent
           requests cannot both take the last one. Running out changes what
           this function does next and changes nothing the reader sees. */
        const mailedToday = q.day === day ? Number(q.mailCount || 0) : 0;
        const mailedByIp = rec.day === day ? Number(rec.mailCount || 0) : 0;
        mayMail = wantMail
          && mailedToday < MAIL_PER_DAY
          && mailedByIp < MAIL_PER_IP_PER_DAY;

        /* Field ORDER is field NAME here: the Firestore console sorts a
           document's fields alphabetically, so the only way to control what
           the founders read first is what the fields are called. In order:
           when, who to reply to, which box, what they said, where from, and
           their account if they had one.

           SIX FIELDS, and this list does not grow. privacy.html §08 publishes
           the number and tools/check-support.js asserts it. Whether the email
           went is a log line, not a seventh field. */
        tx.create(ref, {
          at: admin.firestore.Timestamp.fromDate(when),
          from: email(body.email),
          kind: KINDS[kind],
          message: message,
          page: page(body.page) || "/support",
          uid: uid
        });

        /* Written whole rather than merged: every field is computed above, so
           a merge would only preserve stale ones. */
        tx.set(ipRef, {
          last: now,
          hour: hour,
          hourCount: perHour + 1,
          day: day,
          dayCount: perDay + 1,
          mailCount: mailedByIp + (mayMail ? 1 : 0),
          expiresAt: admin.firestore.Timestamp.fromMillis(now + IP_TTL_MS)
        });

        tx.set(quotaRef, {
          day: day,
          count: stored + 1,
          mailCount: mailedToday + (mayMail ? 1 : 0)
        }, { merge: true });
      });
    } catch (err) {
      const code = err && err.code;
      if (code === "too_fast" || code === "too_many") {
        return send(res, 429, { ok: false, error: code });
      }
      if (code === "quota") {
        logger.warn("support quota spent", { day: day, cap: PER_DAY });
        return send(res, 429, { ok: false, error: "quota" });
      }
      logger.error("support write failed", { message: err && err.message });
      return send(res, 500, { ok: false, error: "write_failed" });
    }

    /* --- Stored. Everything from here on cannot change the answer. ------
       The reader is told 200 whatever the mail provider does. The one thing
       this is allowed to do is take up to MAIL_TIMEOUT_MS, and it is awaited
       rather than left running because a Cloud Run container may have its CPU
       throttled the moment the response is written — work started after
       res.send() is work that may simply never happen. */
    let mailResult = mayMail ? "pending" : (wantMail ? "budget_spent" : "off");
    if (mayMail) {
      const failure = await sendMail(key, {
        id: id,
        kind: KINDS[kind],
        message: message,
        page: page(body.page) || "/support",
        from: email(body.email),
        uid: uid
      });
      mailResult = failure ? failure : "sent";
      if (failure) {
        /* Loud, because it means the founders are reading the console and do
           not know it. Never louder than a log line: the message is safe. */
        logger.error("support mail failed", { id: id, reason: failure });
      }
    }

    /* Logged without the message in it. The document is the message; a log
       line is for knowing one arrived. */
    logger.info("support message", {
      id: id,
      kind: kind,
      signedIn: !!uid,
      chars: message.length,
      mail: mailResult
    });
    return send(res, 200, { ok: true });
  }
);

/* --- Exported for a test, and for nothing else --------------------------
   `functions/index.js` takes `.support` and only `.support`, so nothing added
   here is deployed as a function or reachable over HTTP. These are the parts
   worth pointing a test at without a live mail account, a network or a key:
   the parser that decides whether anything a stranger typed may reach a
   header at all, the builder that decides what is actually sent, and the
   constant address it is sent to. */
exports._replyTo = replyTo;
exports._mailPayload = mailPayload;
exports._MAIL_TO = MAIL_TO;
