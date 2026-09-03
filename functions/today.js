/* ==========================================================================
   Factbox — which story is free today, decided here.

   THE REASON THIS FILE EXISTS. "Today's Factbox is free for everybody" was,
   until now, a sentence only the browser knew. js/access.js worked the pick
   out from the UTC date and the catalogue order, and that is a fine way to
   DRAW a page — but it is not a rule, because the thing being asked is the
   thing being trusted. Move the device clock and a different day's story
   unlocks. That cost little while `data/stacks.json` was public anyway, but
   `functions/story.js` exists precisely to hand out story text only to
   verified callers, and it could not honour a rule that lived in a browser.

   So the answer moves here, and story.js asks this module rather than
   inventing a second copy of the arithmetic. One answer, two callers, and the
   one that guards the text is the server's.

   WHAT THE ANSWER IS DERIVED FROM
     1. An editorial override — `daily/{YYYY-MM-DD}.id` in Firestore, if the
        owner has filed one. Curation without a deploy.
     2. Otherwise the deterministic pick: the UTC day number, the catalogue
        length and its filed order. Identical arithmetic to js/access.js's, so
        the client's guess and the server's ruling agree on every ordinary day.

   WHAT IT IS NOT DERIVED FROM, EVER
     The request. Not a query parameter, not a header, not a body, not a
     cookie, not the caller's clock. There is no input to this endpoint at
     all — GET it and you get today's answer, and there is deliberately no
     `?date=` to peek at another day with, because a debugging affordance on a
     public endpoint is an attack surface with a friendly name. An attacker
     cannot make this declare an arbitrary story free because there is nothing
     to send that it reads.

   WHY THE ARITHMETIC IS A PERMUTATION AND NOT A SHUFFLE
     A stride coprime with the catalogue size visits all 51 exactly once in 51
     days, with nothing to seed and the same answer everywhere. n = 51 gives a
     stride of 31. Same scheme js/today.js has used since the beginning.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

/* index.js initialises first when this is loaded through it; the guard is for
   the case where some future entry point loads this module on its own. */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const DAY_MS = 86400000;

/* Where the owner files a curated pick. One document per date, id as the
   date, so the Firebase console lists them in order and an override is one
   field in one document. firestore.rules: readable by anyone, writable by no
   browser. */
const OVERRIDE_COLLECTION = "daily";

/* How long an instance may hold the answer.

   Two clocks pull in opposite directions. The deterministic half of the answer
   changes exactly once a day and could be held for hours. The editorial half
   is a person typing into the Firebase console and then reloading the site to
   see whether it worked, and ten minutes of that is a person concluding the
   feature is broken.

   Two minutes is the compromise, and it is priced rather than guessed. Two
   reads per instance per two minutes, across the worst case of every instance
   both functions may run (5 + 20), is 36,000 reads a day against a free
   allowance of 50,000 a day — so the whole editorial loop still costs nothing.
   Shorter than story.js's ten minutes on purpose: story TEXT is immutable
   between seeding runs and this is somebody's editorial decision.

   Note what this is NOT: it is not how long the browser caches. That is the
   Cache-Control below — which uses the same number so a person refreshing to
   check their override is not held out by their own browser — and the client's
   day-keyed cache in js/access.js is what actually keeps this endpoint down to
   roughly one call per reader per day. */
const MEMO_TTL_MS = 2 * 60 * 1000;

/* The catalogue is 51 covers and changes only when the corpus is re-seeded.
   Held longer because the ORDER is the only part of it this file reads, and
   the order does not move. */
const CATALOGUE_TTL_MS = 60 * 60 * 1000;

let catMemo = null;      /* { at, ids: [...] } */
let pickMemo = null;     /* { at, date, value } */

/* --- the arithmetic, byte-for-byte js/access.js's ------------------------
   If you change one, change both. The whole value of this file is that the
   client's guess and the server's ruling agree on an ordinary day; two
   implementations that drift would produce a front page that offers a story
   the reader is then refused. */

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

/* The first number at or after ~0.618n that is coprime with n. */
function strideFor(n) {
  if (!(n > 2)) return 1;
  const start = Math.floor(n * 0.618) || 1;
  for (let i = 0; i < n; i++) {
    const c = ((start + i - 1) % (n - 1)) + 1;
    if (gcd(c, n) === 1) return c;
  }
  return 1;
}

function indexAt(n, k) {
  if (!(n > 0)) return -1;
  return ((Math.floor(k) * strideFor(n)) % n + n) % n;
}

/* The server's clock, in UTC, and nobody else's. */
function dayNumber(now) {
  const d = now || new Date();
  const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = Math.floor(ms / DAY_MS);
  return (isFinite(n) && n > 0) ? n : 0;
}

function dateKey(now) {
  return (now || new Date()).toISOString().slice(0, 10);
}

/* Seconds from now until the next UTC midnight — when this answer stops being
   true. Used for both the client's re-ask and the cache lifetime, so nothing
   anywhere holds yesterday's answer into today. */
function secondsToMidnight(now) {
  const d = now || new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - d.getTime()) / 1000));
}

/* Ids are `01`..`50` plus `07B` (SPEC.md §5: a string, never a number). Same
   shape check story.js applies. An override naming anything else is ignored
   rather than obeyed. */
function cleanId(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  return /^[0-9]{2}[A-Z]?$/.test(s) ? s : null;
}

/* --- the catalogue -------------------------------------------------------
   Ids in filed order, which is the only thing the pick needs. `catalogue/v1`
   is one document, so this is one read, and it is memoised for an hour. */
async function defaultCatalogue(reads) {
  if (catMemo && Date.now() - catMemo.at < CATALOGUE_TTL_MS) return catMemo.ids;
  reads.n++;
  const snap = await db.doc("catalogue/v1").get();
  if (!snap.exists) return null;
  const stacks = snap.get("stacks");
  if (!Array.isArray(stacks) || !stacks.length) return null;
  const ids = [];
  for (let i = 0; i < stacks.length; i++) {
    const x = stacks[i];
    ids.push(String((x && x.id != null) ? x.id : "").toUpperCase());
  }
  catMemo = { at: Date.now(), ids: ids, rows: stacks };
  return ids;
}

/**
 * Today's answer. `{ date, id, index, n, source }`, or null if the corpus is
 * not seeded.
 *
 * `catalogue` is an optional provider so story.js can hand in the copy it has
 * already read rather than paying for a second one. It must resolve to an
 * array of ids in filed order.
 */
async function todayPick(reads, catalogue) {
  const now = new Date();
  const date = dateKey(now);

  if (pickMemo && pickMemo.date === date && Date.now() - pickMemo.at < MEMO_TTL_MS) {
    return pickMemo.value;
  }

  const ids = catalogue ? await catalogue(reads) : await defaultCatalogue(reads);
  if (!ids || !ids.length) return null;
  const n = ids.length;

  /* The deterministic pick first, so it is always the value we fall back to
     if the override is missing, malformed, or names a story that is not in
     the corpus. An override is allowed to CHOOSE; it is not allowed to break
     the page. */
  let index = indexAt(n, dayNumber(now));
  if (!(index >= 0 && index < n)) index = 0;
  let id = ids[index];
  let source = "deterministic";

  /* The editorial override. One read, memoised with the pick above. */
  try {
    reads.n++;
    const snap = await db.doc(OVERRIDE_COLLECTION + "/" + date).get();
    if (snap.exists) {
      const want = cleanId(snap.get("id"));
      const at = want ? ids.indexOf(want) : -1;
      if (at >= 0) {
        index = at;
        id = ids[at];
        source = "editorial";
      } else if (want) {
        /* Loud, because it is a person's typo standing between them and the
           front page they meant to curate. */
        logger.warn("daily override names a story that is not in the corpus", {
          date: date, wanted: want
        });
      }
    }
  } catch (err) {
    /* Firestore refused or timed out. The deterministic pick is a complete,
       correct answer on its own — a curation feature must never be able to
       take down the thing it decorates. */
    logger.warn("daily override lookup failed", { date: date, message: err && err.message });
  }

  const value = { date: date, id: id, index: index, n: n, source: source };
  pickMemo = { at: Date.now(), date: date, value: value };
  return value;
}

/** Just the id, for story.js. Null if the corpus is not seeded. */
async function todayId(reads, catalogue) {
  const p = await todayPick(reads, catalogue);
  return p ? p.id : null;
}

/* --- the endpoint -------------------------------------------------------- */

/* The same allowlist story.js and support.js use. `*` would be defensible
   here — the answer is public and identical for everybody — but three
   allowlists that agree are easier to audit than two that agree and one that
   does not, and nothing is gained by widening it. */
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
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

/* --- rate limiting -------------------------------------------------------
   A public endpoint with no input is a cheap thing to hammer. Three bounds,
   in increasing order of how much they actually protect us:

     1. Per-IP, in memory, below. Weak on its own — an instance is one of
        several and memory is not shared — and it is still worth having,
        because the realistic abuse here is one script in a loop, not a
        botnet.
     2. maxInstances: 5. The hard ceiling on what any amount of traffic can
        cost, and the reason this is a bounded bill rather than an open one.
     3. The memo above. However many requests arrive, Firestore sees at most
        two reads per instance per ten minutes.

   The number is deliberately loose. A great many readers share one exit
   address — carrier-grade NAT, an office, a school — and this endpoint is
   asked once per reader per UTC DAY, so a tight per-IP cap would refuse real
   people to no purpose. 300 a minute stops one laptop in a loop, which is the
   only per-IP attack that exists here; everything larger is stopped by
   maxInstances, which is the bound that actually caps the bill. There is no
   minimum gap between calls for the same reason: two tabs opening at once is
   not abuse.

   A refusal is also harmless: js/access.js treats it exactly like a timeout
   and falls back to its own arithmetic. Nothing an attacker gets from a 429
   body, either — it is six words.

   WHAT THROTTLING THIS CANNOT DO, said plainly: it cannot stop somebody
   learning today's story id. That is on the front page. It is not a secret
   and it is not defended as one. */
const MIN_GAP_MS = 0;
const PER_IP_PER_MINUTE = 300;
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
  const rec = seen.get(ip) || { last: 0, hits: [] };
  if (MIN_GAP_MS && now - rec.last < MIN_GAP_MS) return "too_fast";
  rec.hits = rec.hits.filter((t) => now - t < 60 * 1000);
  if (rec.hits.length >= PER_IP_PER_MINUTE) return "too_many";
  rec.last = now;
  rec.hits.push(now);
  seen.set(ip, rec);
  return "";
}

/* What the front page needs to draw the hero, and not one field more. Every
   one of these is already in `data/index.json` on the public web, so this
   leaks nothing; the list is closed so that a future catalogue field cannot
   quietly start being published here. */
const COVER_FIELDS = ["id", "title", "hook", "img", "cap", "secs", "words", "topic", "free"];

async function coverFor(reads, id) {
  /* Off the same memo the pick already filled, so the cover is free: no
     second read, and no second chance for the two to disagree. */
  const ids = await defaultCatalogue(reads);
  if (!ids || !catMemo) return null;
  const rows = catMemo.rows || [];
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i] && rows[i].id).toUpperCase() === id) {
      const out = {};
      for (const k of COVER_FIELDS) {
        if (rows[i][k] !== undefined) out[k] = rows[i][k];
      }
      return out;
    }
  }
  return null;
}

exports.today = onRequest(
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
    const reads = { n: 0 };
    res.set("Access-Control-Expose-Headers", "X-Firestore-Reads");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Cache-Control", "private, no-store");
      res.set("X-Firestore-Reads", "0");
      return res.status(405).type("application/json")
        .send(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    }

    const slow = throttled(clientIp(req));
    if (slow) {
      res.set("Cache-Control", "private, no-store");
      res.set("X-Firestore-Reads", "0");
      res.set("Retry-After", "1");
      return res.status(429).type("application/json")
        .send(JSON.stringify({ ok: false, error: slow }));
    }

    let pick = null;
    try {
      pick = await todayPick(reads);
    } catch (err) {
      logger.error("today failed", { message: err && err.message });
    }

    res.set("X-Firestore-Reads", String(reads.n));

    if (!pick) {
      /* Not seeded, or Firestore is down. Say so plainly and do NOT cache it:
         the client falls back to its own arithmetic, and a cached 503 would
         keep it there after the cause was fixed. */
      res.set("Cache-Control", "private, no-store");
      return res.status(503).type("application/json")
        .send(JSON.stringify({ ok: false, error: "not_seeded" }));
    }

    /* --- the cache strategy ---------------------------------------------
       This answer is identical for every reader on earth and stops being true
       at UTC midnight, so it is cached to exactly that moment — but never for
       longer than the memo window, so an editorial override filed at noon is
       not held out by a browser that asked at breakfast.

       stale-while-revalidate is the part that matters for availability: a
       shared cache that already holds an answer serves it instantly for a
       further day and refreshes underneath, so a slow or dead function is
       invisible to anyone behind one. There is no Google-managed CDN in front
       of a bare cloudfunctions.net URL, so today this is honoured by browsers
       and in-app webview caches only; it is written correctly so that putting
       Firebase Hosting or the Cloudflare worker in front changes nothing but
       the hit rate.

       The client's day-keyed localStorage cache in js/access.js is the layer
       that actually bounds the bill: one call per reader per UTC day. */
    const ttl = Math.min(secondsToMidnight(), Math.floor(MEMO_TTL_MS / 1000));
    res.set("Cache-Control",
      "public, max-age=" + ttl + ", s-maxage=" + ttl + ", stale-while-revalidate=86400");

    const body = {
      ok: true,
      date: pick.date,
      id: pick.id,
      index: pick.index,
      n: pick.n,
      source: pick.source,
      until: secondsToMidnight()
    };

    /* The hero, so the front page needs no second round trip. Best effort:
       the id is the answer and the cover is a convenience, so a catalogue
       hiccup must not turn a good answer into a bad response. */
    try {
      const cover = await coverFor(reads, pick.id);
      if (cover) body.story = cover;
    } catch (err) { /* the id alone is a complete answer */ }

    res.set("X-Firestore-Reads", String(reads.n));
    return res.status(200).type("application/json").send(JSON.stringify(body));
  }
);

/* story.js imports these. Exported off the module rather than duplicated
   there, which is the entire point: one arithmetic, one override lookup, one
   answer. */
exports.todayPick = todayPick;
exports.todayId = todayId;
exports.secondsToMidnight = secondsToMidnight;
