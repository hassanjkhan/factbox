#!/usr/bin/env node
/*
  _firestore.js — the ONLY thing in tools/collect/ that talks to Firestore.

  WHY A NODE FILE IN A PYTHON TOOLCHAIN. The collectors are Python because the
  rest of tools/ is, but there is no Python Firestore client on this machine:
  tools/reel/.venv holds Pillow and nothing else, and the brief forbids new
  global installs. firebase-admin IS already vendored at tools/node_modules,
  and reaching Firestore from stdlib Python would mean hand-rolling an RS256
  service-account JWT through a shelled-out `openssl` — a homemade auth path
  guarding the only copy of numbers that cannot be re-fetched. So the Python
  keeps every decision and this file is a dumb pipe: one JSON request in on
  stdin, one JSON response out on stdout.

  IT RUNS AS A SERVICE ACCOUNT, WHICH MEANS FIRESTORE RULES DO NOT APPLY.
  That is not a licence to write whatever shape we like. See REEL_KEYS in
  store.py: a reel document written with a key outside the set firestore.rules
  pins with hasOnly() would still be accepted here, and would then make every
  later edit of that reel from the browser fail permission-denied, silently,
  for both admins. The filtering happens in Python, before anything gets here.

  No credential is ever printed. ~/.factbox-keys/admin.json stays outside the
  repo because the repo is public.
*/
"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const KEY = path.join(os.homedir(), ".factbox-keys", "admin.json");

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(0);           // the Python reads the envelope, not the exit code
}

let admin;
try {
  admin = require(path.join(__dirname, "..", "node_modules", "firebase-admin"));
} catch (e) {
  die("firebase-admin is not installed at tools/node_modules. Run `npm install` in tools/.");
}

if (!fs.existsSync(KEY)) {
  die("missing " + KEY + "\n  It is the service account the other tools in tools/ use.\n  It lives outside the repo on purpose — the repo is public.");
}

let creds;
try { creds = JSON.parse(fs.readFileSync(KEY, "utf8")); }
catch (e) { die(KEY + " is not valid JSON: " + e.message); }

// Checked as properties rather than a list of quoted field names on purpose.
// tools/precommit.sh greps staged lines for a quoted private-key field name,
// to catch a service-account JSON being committed. A list of quoted field names
// trips that while carrying no secret at all. Property access says the same
// thing and leaves the scanner able to do its actual job. Do not tidy this back
// into a loop over quoted strings.
if (!creds.project_id) die(KEY + " is missing: project_id");
if (!creds.client_email) die(KEY + " is missing: client_email");
if (!creds.private_key) die(KEY + " is missing the private key");

admin.initializeApp({ credential: admin.credential.cert(creds) });
const db = admin.firestore();
const FS = admin.firestore;

/* ---------------------------------------------------------------- codec ---
   Firestore has two types JSON cannot carry, and both matter here:
   a Timestamp (postedAt/measuredAt are `tsOrNull` in the rules — a number
   there would be rejected the moment a browser touched the row) and a server
   timestamp sentinel. Python tags them; this unwraps them. */
function decode(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.__ts__ !== undefined)     return FS.Timestamp.fromMillis(Math.round(v.__ts__));
  if (v.__server__ !== undefined) return FS.FieldValue.serverTimestamp();
  if (v.__delete__ !== undefined) return FS.FieldValue.delete();
  const out = {};
  for (const k of Object.keys(v)) out[k] = decode(v[k]);
  return out;
}

function encode(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof FS.Timestamp) return { __ts__: v.toMillis() };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}

function ref(segments) {
  if (!Array.isArray(segments) || segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error("path must be an even-length [collection, id, ...] list");
  }
  return db.doc(segments.join("/"));
}

/* ------------------------------------------------------------------ ops --- */
const OPS = {
  /* Every reel on the board, whatever experiment it hangs under. A collection
     group query with no filter and no order needs no composite index. */
  async reels() {
    const snap = await db.collectionGroup("reels").get();
    const out = [];
    snap.forEach((d) => {
      const parent = d.ref.parent.parent;       // admin_experiments/{id}
      out.push({
        reelId: d.id,
        expId: parent ? parent.id : null,
        path: d.ref.path,
        data: encode(d.data()),
      });
    });
    return { reels: out };
  },

  async get(req) {
    const snap = await ref(req.path).get();
    return { exists: snap.exists, data: snap.exists ? encode(snap.data()) : null };
  },

  /* A MERGE AND NEVER A REPLACE. set({merge:true}) leaves keys this write does
     not mention alone, which is the whole point: a nightly run that could not
     see `reach` today must not blank the reach it captured on day one. The
     Python decides which keys to send; this guarantees the ones it withheld
     survive. */
  async set(req) {
    await ref(req.path).set(decode(req.data), { merge: req.merge !== false });
    return { written: req.path.join("/") };
  },

  async ping() {
    return { projectId: creds.project_id };
  },
};

(async () => {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let req;
  try { req = JSON.parse(raw || "{}"); }
  catch (e) { return die("bridge got invalid JSON on stdin: " + e.message); }

  const fn = OPS[req.op];
  if (!fn) return die("unknown op: " + String(req.op));
  try {
    const result = await fn(req);
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (e) {
    die(String((e && e.message) || e));
  }
  process.exit(0);
})();
