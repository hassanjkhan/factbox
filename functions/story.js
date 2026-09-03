/* ==========================================================================
   Factbox — the gated read path.

   This is the half of the product that the static site could never do. On
   GitHub Pages `data/stacks.json` is a public file: the gate there is a
   product surface, not a boundary (SPEC.md §9 says so plainly). Here the text
   lives in Firestore, the browser cannot read it, and the only way to obtain a
   paid story is to ask this function while holding a Firebase ID token that
   belongs to somebody Stripe says is paying.

   Two rules govern everything below.

   1. The client is never believed. It sends an ID token; we verify the
      signature against Google's keys and then read `customers/{uid}.premium`
      out of Firestore ourselves. A claim in the token, a flag in the body, a
      cookie — none of those decide anything. The webhook in index.js is the
      only writer of that flag and the browser cannot write it (firestore.rules
      denies it), so the flag is worth trusting and the client is not.

   2. It runs on every story open, so it must be cheap. One story is one
      document, so serving it is one read — and a warm instance serves it from
      memory for CONTENT_TTL_MS, which takes the amortised figure to roughly
      zero. The entitlement check is deliberately NOT cached: a cancelled
      subscriber should lose access on their next open, not ten minutes later.
      One read to be right about money is worth paying every time.

   3. "Today's Factbox is free for everybody" is now a rule this function
      enforces, not a claim the browser makes. It used to be worked out only in
      js/access.js, from the reader's own clock — which is fine for drawing a
      page and worthless as a boundary, because moving a device clock moved
      which story was free. today.js owns the answer now: the server's clock,
      the catalogue order, and an editorial override document nobody's browser
      can write. This function asks that module rather than keeping a second
      copy of the arithmetic, so the story the front page offers and the story
      this function will hand over are the same story, by construction.

      Nothing in the REQUEST touches that answer. Not a query parameter, not a
      header, not a cookie, not a body, not a token. The only way to make a
      different story free is to write `daily/{date}` in Firestore, which
      firestore.rules denies to every browser in the world.
   ========================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const zlib = require("zlib");
/* Which story is free today. NOT a second copy of the arithmetic — the module
   that owns the answer, so this function and the /today endpoint cannot
   disagree about what the front page just offered the reader. */
const daily = require("./today");

/* index.js initialises first when this is loaded through it; the guard is for
   the case where some future entry point loads this module on its own. */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* Story text is immutable between seeding runs, so an instance may hold it.
   Ten minutes is the window in which a re-seed is invisible to a warm
   instance — short enough that a typo fix lands the same session, long enough
   that a reader flicking through a topic pays for almost none of it. */
const CONTENT_TTL_MS = 10 * 60 * 1000;
const contentCache = new Map();

/* Every Firestore document read this function performs goes through here, and
   the count rides back on the response as `X-Firestore-Reads`. Billing is per
   document read, so the number that matters is not one an architecture diagram
   should be trusted for — it should be observable on the wire. It is.

   `reads` is per-request state on a function with concurrency 80, so it cannot
   be a module-level counter; it is threaded through as a small object. */
function counter() {
  return { n: 0 };
}

async function readDoc(reads, path) {
  reads.n++;
  return db.doc(path).get();
}

function cached(key) {
  const hit = contentCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CONTENT_TTL_MS) {
    contentCache.delete(key);
    return null;
  }
  return hit.value;
}

function remember(key, value) {
  /* Bounded so a pathological id-scan cannot grow the heap without limit.
     53 documents is the entire corpus; 128 is headroom, not a policy. */
  if (contentCache.size > 128) contentCache.clear();
  contentCache.set(key, { at: Date.now(), value: value });
  return value;
}

/* --- CORS ---------------------------------------------------------------
   An allowlist, not `*`. The response to a subscriber carries the thing they
   paid for, and `*` would let any page on the internet read it out of a
   logged-in reader's browser. localhost is here so the site can be developed
   against the real backend without a proxy. */
const ALLOWED = [
  "https://factbox.app",
  "https://www.factbox.app"
];

function originAllowed(origin) {
  if (!origin) return null;
  if (ALLOWED.indexOf(origin) !== -1) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  /* GitHub Pages preview origins for the same repo. */
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) return origin;
  return null;
}

function cors(req, res) {
  const ok = originAllowed(req.headers.origin);
  if (ok) res.set("Access-Control-Allow-Origin", ok);
  res.set("Vary", "Origin, Accept-Encoding");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

/* Cloud Run does not compress for you, and nothing in the Functions runtime
   does either — a story went out as 10 KB of JSON on the wire when it is 2.6 KB
   gzipped. Every reader here is on a phone in an in-app browser (SPEC.md §1),
   so this is four times less to download on a bad connection as well as four
   times less egress to pay for. Sixteen lines is a fair price for that.

   Below ~1 KB the gzip header costs more than it saves, so small refusals go
   out plain. */
function sendJSON(req, res, reads, status, body) {
  res.set("X-Firestore-Reads", String(reads.n));
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  res.status(status).type("application/json");
  if (accepts && raw.length > 1024) {
    const gz = zlib.gzipSync(raw, { level: 6 });
    res.set("Content-Encoding", "gzip");
    res.set("Content-Length", String(gz.length));
    return res.end(gz);
  }
  res.set("Content-Length", String(raw.length));
  return res.end(raw);
}

function fail(req, res, reads, status, error, extra) {
  res.set("Cache-Control", "private, no-store");
  const body = { ok: false, error: error };
  if (extra) Object.keys(extra).forEach((k) => { body[k] = extra[k]; });
  return sendJSON(req, res, reads, status, body);
}

/* Ids are `01`..`50` plus `07B` (SPEC.md §5: a string, never a number). The
   whitelist is a shape check, not a lookup — a miss still 404s below. */
function cleanId(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  return /^[0-9]{2}[A-Z]?$/.test(s) ? s : null;
}

/**
 * Who is asking. Returns { uid, premium } or null for an anonymous caller.
 * Throws only on a token that was offered and failed — an absent token is a
 * legitimate anonymous read of a free story, not an error.
 */
async function identify(req, reads) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (err) {
    /* Expired, forged, or from another project. All the same answer. */
    const e = new Error("bad_token");
    e.code = "bad_token";
    throw e;
  }

  /* The read that actually decides. Never the token, never the client. */
  const snap = await readDoc(reads, "customers/" + decoded.uid);
  const premium = snap.exists && snap.get("premium") === true;
  return { uid: decoded.uid, premium: premium };
}

async function getCatalogue(reads) {
  const hit = cached("catalogue");
  if (hit) return hit;
  const snap = await readDoc(reads, "catalogue/v1");
  if (!snap.exists) return null;
  return remember("catalogue", snap.data());
}

/* Ids in filed order, handed to today.js so it uses the copy this function has
   already paid for rather than reading `catalogue/v1` a second time. On a warm
   instance that makes today's pick cost one read (the override document) and
   often zero, because today.js memoises the whole answer for ten minutes. */
async function catalogueIds(reads) {
  const cat = await getCatalogue(reads);
  const stacks = cat && Array.isArray(cat.stacks) ? cat.stacks : null;
  if (!stacks || !stacks.length) return null;
  return stacks.map((x) => String((x && x.id != null) ? x.id : "").toUpperCase());
}

async function getStory(reads, id) {
  const hit = cached("s:" + id);
  if (hit) return hit;
  const snap = await readDoc(reads, "stories/" + id);
  if (!snap.exists) return null;
  return remember("s:" + id, snap.data());
}

exports.story = onRequest(
  {
    region: "us-central1",
    cors: false,          /* handled above, with an allowlist */
    memory: "256MiB",
    maxInstances: 20,
    concurrency: 80,
    timeoutSeconds: 20
  },
  async (req, res) => {
    cors(req, res);
    const reads = counter();
    /* Exposed so the browser can read it too: the cost of a story open should
       be observable from the client, not only from a billing report. Written on
       the way out of every branch below, failures included — a 403 that cost a
       read still cost a read. */
    res.set("Access-Control-Expose-Headers", "X-Firestore-Reads");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return fail(req, res, reads, 405, "method_not_allowed");
    }

    /* ---- the catalogue -------------------------------------------------
       Covers, titles and hooks for all 51 stories, and nothing a reader is
       paying for. SPEC.md §4: "covers are the pitch" — a locked story still
       has to show its artwork. One document, so one read, and cacheable at
       the edge because it is identical for everyone. */
    if (req.query.catalogue) {
      const cat = await getCatalogue(reads);
      if (!cat) {
        logger.error("catalogue missing - run tools/seed-firebase.js");
        return fail(req, res, reads, 503, "not_seeded");
      }
      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      return sendJSON(req, res, reads, 200, { ok: true, v: cat.v || null, stacks: cat.stacks || [] });
    }

    const id = cleanId(req.query.id);
    if (!id) return fail(req, res, reads, 400, "bad_request");

    const story = await getStory(reads, id);
    if (!story) return fail(req, res, reads, 404, "not_found");

    /* A free story is served to anybody, signed in or not, without spending a
       read on entitlement. Stories 01 and 02 are the top of the funnel; making
       an anonymous reader wait on an auth round-trip to see them would be
       taxing the one thing we want to be frictionless. */
    if (story.free === true) {
      /* Still identify if a token came along, purely so the response can say
         so — but never let a bad token turn a free story into an error. */
      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      return sendJSON(req, res, reads, 200, { ok: true, id: id, access: "free", story: story });
    }

    /* ---- today's story, free to everybody ------------------------------
       The rule that used to live only in the browser. js/access.js still works
       the pick out for itself so the front page paints instantly, but THIS is
       the answer that decides whether text leaves the building, and it is
       derived from the server's clock, the catalogue order and an editorial
       override document — never from anything in this request. A reader who
       moves their device clock changes what their own page draws and changes
       nothing here.

       Placed after the permanent `free` check and before the entitlement one,
       so 01 and 02 keep their old cheap path and a paid story is still refused
       on every day that is not its day. */
    let todaysId = null;
    try {
      todaysId = await daily.todayId(reads, catalogueIds);
    } catch (err) {
      /* A failure here must not lock the reader out of a story they have paid
         for: fall through to the entitlement check, which is the answer that
         was correct before this block existed. It can only ever cost the free
         reader today's story, never the subscriber theirs. */
      logger.warn("today lookup failed", { message: err && err.message });
    }

    if (todaysId && id === todaysId) {
      /* Cacheable, but never past the moment it stops being true. At UTC
         midnight this story is paid again, and a shared cache holding a
         200 for it would be giving away tomorrow's product. */
      const ttl = Math.min(300, daily.secondsToMidnight());
      res.set("Cache-Control", "public, max-age=" + ttl + ", s-maxage=" + ttl);
      return sendJSON(req, res, reads, 200, { ok: true, id: id, access: "today", story: story });
    }

    let who = null;
    try {
      who = await identify(req, reads);
    } catch (err) {
      return fail(req, res, reads, 401, "bad_token", { id: id, free: false });
    }

    if (!who) return fail(req, res, reads, 401, "auth_required", { id: id, free: false });
    if (!who.premium) {
      return fail(req, res, reads, 403, "subscription_required", { id: id, free: false });
    }

    /* no-store, not merely private: this body is one subscriber's, and an
       in-app webview's shared HTTP cache is not a place to leave it. */
    res.set("Cache-Control", "private, no-store");
    return sendJSON(req, res, reads, 200, { ok: true, id: id, access: "subscriber", story: story });
  }
);
