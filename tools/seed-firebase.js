#!/usr/bin/env node
/* ==========================================================================
   Factbox — push the story corpus and the audio beds into Firebase.

   `data/stacks.json` and `data/audio.json` stay the source of truth (SPEC.md
   §5). Firestore and Storage are a serving copy, and this is the thing that
   makes the copy match. It is a sync, not an import: run it as often as you
   like, and a run in which nothing has changed writes nothing at all.

   ---------------------------------------------------------------------------
   WHY THE REST API AND NOT AN ADMIN FUNCTION

   Two ways to write to Firestore with admin rights from here. There are no
   application-default credentials on this machine and no service-account key
   (there should not be one — a downloaded key is a permanent credential in a
   file), so the choices were:

     (a) deploy a one-shot HTTP function that carries the JSON in its bundle
         and writes it with the admin SDK, or
     (b) call the Firestore REST API directly with the token the Firebase CLI
         is already holding.

   (b), for three reasons. A seeding endpoint is an endpoint: it exists on the
   public internet from the moment it deploys until somebody remembers to
   remove it, and an endpoint that rewrites the entire corpus is the single
   worst thing to leave lying around with a weak guard on it. It would also
   have to ship a copy of stacks.json inside functions/, giving the corpus two
   homes and this repo the build step it does not have. And it makes an
   ordinary content fix — reseed after a typo — a deploy.

   The token comes from ~/.config/configstore/firebase-tools.json, which is
   where `firebase login` puts it. It carries the cloud-platform scope, it
   lasts an hour, and this script refreshes it the honest way: by running a
   cheap `firebase` command and letting the CLI do its own refresh. No OAuth
   client secret is embedded here.
   ---------------------------------------------------------------------------

   Usage:
     node tools/seed-firebase.js                 sync everything
     node tools/seed-firebase.js --dry-run       say what would change
     node tools/seed-firebase.js --skip-audio    Firestore only
     node tools/seed-firebase.js --skip-stories  Storage only
     node tools/seed-firebase.js --rotate-tokens new audio download tokens,
                                                 invalidating every URL handed
                                                 out so far
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");

const PROJECT = "factbox-7cb97";
const BUCKET = "factbox-7cb97.firebasestorage.app";
const ROOT = path.resolve(__dirname, "..");
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const FS_API = `https://firestore.googleapis.com/v1/${DB}`;

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.indexOf(f) !== -1;
const DRY = has("--dry-run");
const SKIP_AUDIO = has("--skip-audio");
const SKIP_STORIES = has("--skip-stories");
const ROTATE = has("--rotate-tokens");

/* ------------------------------------------------------------------ token */

function tokenPath() {
  return path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
}

function accessToken() {
  const p = tokenPath();
  if (!fs.existsSync(p)) {
    throw new Error("no firebase-tools credentials; run `firebase login` first");
  }
  let store = JSON.parse(fs.readFileSync(p, "utf8"));
  const expires = (store.tokens && store.tokens.expires_at) || 0;

  /* Within five minutes of expiry, make the CLI refresh it. The CLI owns this
     credential; asking Google directly would mean embedding the CLI's OAuth
     client secret in this repo, which is exactly the sort of thing that ends
     up in a screenshot. */
  if (expires - Date.now() < 5 * 60 * 1000) {
    try {
      execFileSync("firebase", ["projects:list"], { stdio: "ignore" });
      store = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      /* fall through and try the token we have */
    }
  }
  const t = store.tokens && store.tokens.access_token;
  if (!t) throw new Error("no access_token in firebase-tools.json; run `firebase login`");
  return t;
}

let TOKEN = null;

async function api(url, opts) {
  opts = opts || {};
  if (!TOKEN) TOKEN = accessToken();
  const headers = Object.assign(
    { Authorization: "Bearer " + TOKEN },
    opts.headers || {}
  );
  const r = await fetch(url, { method: opts.method || "GET", headers, body: opts.body });
  const text = await r.text();
  if (!r.ok) {
    /* One retry on a 401: the hour may simply have run out mid-run. */
    if (r.status === 401 && !opts._retried) {
      TOKEN = null;
      TOKEN = accessToken();
      return api(url, Object.assign({}, opts, { _retried: true }));
    }
    throw new Error(`${r.status} ${url.slice(0, 120)} :: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

/* ------------------------------------------- Firestore value encoding ---- */

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (!isFinite(v)) throw new Error("non-finite number in source data");
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) {
    /* Firestore has no nested arrays. The corpus has none today; this is here
       so that the day somebody adds one, it fails loudly at seed time rather
       than quietly at read time. */
    v.forEach((x) => {
      if (Array.isArray(x)) throw new Error("nested array: Firestore cannot store it");
    });
    return { arrayValue: { values: v.map(toValue) } };
  }
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  throw new Error("unencodable value: " + typeof v);
}

function toFields(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { out[k] = toValue(obj[k]); });
  return out;
}

function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}

function fromFields(f) {
  const out = {};
  Object.keys(f).forEach((k) => { out[k] = fromValue(f[k]); });
  return out;
}

/* Firestore's own size accounting, per the documented rules — string is
   utf8 length + 1, number 8, bool 1, null 1, a map costs 32 plus its entries,
   and the document name and 32 bytes of overhead ride on top. The limit is
   1 MiB and the point of measuring is to know how much room is left, not to
   discover one day that a longer story would not fit. */
function docBytes(name, obj) {
  function size(v) {
    if (v === null || v === undefined) return 1;
    if (typeof v === "boolean") return 1;
    if (typeof v === "number") return 8;
    if (typeof v === "string") return Buffer.byteLength(v, "utf8") + 1;
    if (Array.isArray(v)) return v.reduce((a, x) => a + size(x), 0);
    return Object.keys(v).reduce(
      (a, k) => a + Buffer.byteLength(k, "utf8") + 1 + size(v[k]), 32
    );
  }
  return Buffer.byteLength(name, "utf8") + 16 + size(obj) + 32;
}

/* Stable hash of a document's content. Key order is normalised so that a
   re-serialisation with different key order is not mistaken for a change —
   without this, "idempotent" would be a claim rather than a property. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = canonical(v[k]); });
    return out;
  }
  return v;
}

function hashOf(obj) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonical(obj)))
    .digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------- the audio */

const GCS = "https://storage.googleapis.com/storage/v1/b/" + BUCKET + "/o";
const GCS_UP = "https://storage.googleapis.com/upload/storage/v1/b/" + BUCKET + "/o";

function downloadURL(objectPath, token) {
  return "https://firebasestorage.googleapis.com/v0/b/" + BUCKET +
    "/o/" + encodeURIComponent(objectPath) + "?alt=media&token=" + token;
}

async function objectMeta(objectPath) {
  try {
    return await api(GCS + "/" + encodeURIComponent(objectPath));
  } catch (e) {
    if (/^404 /.test(e.message)) return null;
    throw e;
  }
}

async function uploadObject(objectPath, buf, contentType, token) {
  const boundary = "fbx" + crypto.randomBytes(12).toString("hex");
  const meta = {
    name: objectPath,
    contentType: contentType,
    cacheControl: "public, max-age=86400",
    metadata: { firebaseStorageDownloadTokens: token }
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(meta)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return api(GCS_UP + "?uploadType=multipart", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/related; boundary=" + boundary,
      "Content-Length": String(body.length)
    },
    body: body
  });
}

/**
 * Put every bed in Storage and hand back name -> { file, gain, url }.
 *
 * Two things keep this idempotent. An mp3 whose local MD5 already matches the
 * object in the bucket is not re-uploaded, and — more importantly — an object
 * that already has a download token keeps it. Minting a fresh token on every
 * run would change every URL, which would change every story document, which
 * would mean nothing in this script was ever idempotent. `--rotate-tokens` is
 * the deliberate way to invalidate them.
 */
async function syncAudio(audio) {
  const beds = audio.beds || {};
  const names = Object.keys(beds);
  const out = {};
  let uploaded = 0, unchanged = 0, rotated = 0, bytes = 0;

  for (const name of names) {
    const file = beds[name].file;
    const local = path.join(ROOT, "audio", file);
    if (!fs.existsSync(local)) throw new Error("missing bed file: " + local);
    const buf = fs.readFileSync(local);
    const md5 = crypto.createHash("md5").update(buf).digest("base64");
    const objectPath = "audio/" + file;

    const existing = await objectMeta(objectPath);
    let token = existing && existing.metadata &&
      existing.metadata.firebaseStorageDownloadTokens;
    if (token) token = String(token).split(",")[0];

    const needsUpload = !existing || existing.md5Hash !== md5 || !token || ROTATE;

    if (needsUpload) {
      if (ROTATE || !token) { token = crypto.randomUUID(); if (existing) rotated++; }
      if (!DRY) await uploadObject(objectPath, buf, "audio/mpeg", token);
      uploaded++;
      bytes += buf.length;
    } else {
      unchanged++;
    }

    out[name] = {
      file: file,
      gain: typeof beds[name].gain === "number" ? beds[name].gain : 1,
      url: downloadURL(objectPath, token || "PENDING")
    };
  }

  console.log(
    `audio:     ${uploaded} uploaded (${(bytes / 1048576).toFixed(2)} MB), ` +
    `${unchanged} unchanged, ${rotated} tokens rotated, ${names.length} beds total`
  );
  return out;
}

/* ------------------------------------------------- bed resolution ------- */

/* The order is audio.json's own, quoted from its `note` field:
     stacks[stack].cards[card] -> stacks[stack].beats[beat]
       -> stacks[stack].bed -> topics[topic].beats[beat]
       -> topics[topic].bed -> default
   `card` is the 0-based index the reader writes, not the 1-based `n` in
   stacks.json, and those differ wherever a stack lost a card in repairs
   (SPEC.md §5). Resolving here, once, at seed time means the function does no
   work at read time and the browser no longer needs data/audio.json at all. */
function resolveBeds(stack, audio) {
  const s = (audio.stacks || {})[stack.id] || {};
  const t = (audio.topics || {})[stack.topic] || {};
  const used = new Set();

  const cards = stack.cards.map((card, i) => {
    const entry = (s.cards || {})[String(i)];
    let bed =
      (entry && (typeof entry === "string" ? entry : entry.bed)) ||
      (s.beats || {})[card.beat] ||
      s.bed ||
      (t.beats || {})[card.beat] ||
      t.bed ||
      audio.default ||
      null;
    if (bed && !(audio.beds || {})[bed]) bed = null;   /* a bed with no file holds */
    if (bed) used.add(bed);
    return bed;
  });

  return { cards: cards, used: Array.from(used) };
}

/* -------------------------------------------------------- Firestore sync */

async function listHashes(collection) {
  const out = {};
  let pageToken = "";
  for (;;) {
    const url = `${FS_API}/${collection}?pageSize=300&mask.fieldPaths=hash` +
      (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const page = await api(url);
    (page.documents || []).forEach((d) => {
      const id = d.name.split("/").pop();
      out[id] = (d.fields && d.fields.hash && d.fields.hash.stringValue) || "";
    });
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return out;
}

async function commit(writes) {
  /* Chunked well under the 500-mutation and 10 MiB commit limits. Each chunk
     is atomic on its own; the sync as a whole is not a transaction, and does
     not need to be, because every write is a full replace of an idempotent
     document. A half-finished run followed by a re-run converges. */
  for (let i = 0; i < writes.length; i += 10) {
    await api(FS_API + ":commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes: writes.slice(i, i + 10) })
    });
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  const stacks = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "stacks.json"), "utf8")
  ).stacks;
  const audio = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "audio.json"), "utf8")
  );

  const cardCount = stacks.reduce((a, s) => a + s.cards.length, 0);
  console.log(`source:    ${stacks.length} stacks, ${cardCount} cards, ` +
              `${Object.keys(audio.beds || {}).length} beds` + (DRY ? "  [DRY RUN]" : ""));

  const bedURLs = SKIP_AUDIO ? null : await syncAudio(audio);

  if (SKIP_STORIES) return;

  /* ---- build the documents ------------------------------------------- */
  const docs = {};      /* stories/{id} */
  const summaries = [];

  stacks.forEach((s) => {
    const story = {};
    Object.keys(s).forEach((k) => { story[k] = s[k]; });
    story.free = s.free === true;

    if (bedURLs) {
      const r = resolveBeds(s, audio);
      const beds = {};
      r.used.forEach((n) => { beds[n] = bedURLs[n]; });
      story.audio = { cards: r.cards, beds: beds };
    }

    docs[s.id] = story;

    /* The catalogue is the story minus the thing being sold. Everything a
       cover needs — artwork, title, hook, length, topic — and not one card. */
    const sum = {};
    Object.keys(s).forEach((k) => {
      if (k !== "cards" && k !== "supp") sum[k] = s[k];
    });
    sum.free = s.free === true;
    sum.cards = s.cards.length;
    summaries.push(sum);
  });

  /* ---- size check ----------------------------------------------------- */
  let biggest = { id: null, bytes: 0 };
  Object.keys(docs).forEach((id) => {
    const b = docBytes(`${DB}/stories/${id}`, docs[id]);
    if (b > biggest.bytes) biggest = { id: id, bytes: b };
    if (b > 1048576) throw new Error(`stories/${id} is ${b} bytes, over the 1 MiB cap`);
  });
  const catBytes = docBytes(`${DB}/catalogue/v1`, { stacks: summaries });
  console.log(
    `size:      largest story stories/${biggest.id} ${biggest.bytes} B ` +
    `(${(biggest.bytes / 1048576 * 100).toFixed(2)}% of the 1 MiB cap); ` +
    `catalogue/v1 ${catBytes} B (${(catBytes / 1048576 * 100).toFixed(2)}%)`
  );
  if (catBytes > 1048576) throw new Error("catalogue/v1 is over the 1 MiB cap");

  /* ---- diff against what is there ------------------------------------- */
  const existing = await listHashes("stories");
  const writes = [];
  let changed = 0, same = 0;

  Object.keys(docs).forEach((id) => {
    const h = hashOf(docs[id]);
    if (existing[id] === h) { same++; return; }
    changed++;
    writes.push({
      update: {
        name: `${DB}/stories/${id}`,
        fields: toFields(Object.assign({}, docs[id], { hash: h }))
      }
    });
  });

  const stale = Object.keys(existing).filter((id) => !(id in docs));
  stale.forEach((id) => writes.push({ delete: `${DB}/stories/${id}` }));

  /* catalogue */
  const catHash = hashOf({ stacks: summaries });
  const catNow = await listHashes("catalogue");
  const catChanged = catNow.v1 !== catHash;
  if (catChanged) {
    writes.push({
      update: {
        name: `${DB}/catalogue/v1`,
        fields: toFields({ v: catHash, stacks: summaries, hash: catHash })
      }
    });
  }

  /* meta — written only when something else was, so that a no-op run really
     is a no-op and `updatedAt` means what it says. */
  if (changed || stale.length || catChanged) {
    writes.push({
      update: {
        name: `${DB}/meta/content`,
        fields: toFields({
          v: catHash,
          stories: stacks.length,
          cards: cardCount,
          beds: bedURLs ? Object.keys(bedURLs).length : 0,
          updatedAt: new Date().toISOString(),
          hash: catHash
        })
      }
    });
  }

  console.log(
    `firestore: ${changed} stories changed, ${same} unchanged, ` +
    `${stale.length} stale deleted, catalogue ${catChanged ? "changed" : "unchanged"} ` +
    `-> ${writes.length} write(s)`
  );

  if (DRY) { console.log("dry run: nothing written"); return; }
  if (writes.length) await commit(writes);

  /* ---- read back and assert ------------------------------------------- */
  const back = await listHashes("stories");
  const ids = Object.keys(back);
  if (ids.length !== stacks.length) {
    throw new Error(`expected ${stacks.length} story docs, found ${ids.length}`);
  }
  const one = await api(`${FS_API}/stories/${biggest.id}`);
  const readCards = ((one.fields.cards || {}).arrayValue || {}).values || [];
  console.log(
    `verify:    ${ids.length} story documents present; ` +
    `stories/${biggest.id} has ${readCards.length} cards; ` +
    `catalogue/v1 ${catNow.v1 || catChanged ? "present" : "MISSING"}`
  );
  console.log("done.");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
