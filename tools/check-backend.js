#!/usr/bin/env node
/* ==========================================================================
   Factbox — prove the backend gate actually holds.

   SPEC.md §2.4: "HTTP 200s are all equally true of a page with no text on it."
   The same trap applies here. A deploy that succeeds, rules that compile and a
   function that returns JSON prove nothing about whether a stranger can read
   story 05. So this asks, out loud, over the network, as each kind of caller:

     1  the Stripe webhook still rejects an unsigned POST
     2  a free story comes back to a caller with no account at all
     3  a paid story does not, to that same caller
     4  a paid story does not, to a signed-in reader who is not paying
     5  a paid story does, the moment `premium` goes true
     6  and stops again the moment it goes false
     7  firestore.rules refuses a signed-in reader direct access to the text
     8  ...while letting them read the catalogue, which is the pitch
     9  the audio bed URLs work, and the same object without its token does not
    10  every one of the 51 stories is present, with all 450 cards

   It creates a throwaway Firebase user, flips `premium` on that user's own
   customer record the way the webhook would, and deletes both at the end.

   Usage:  node tools/check-backend.js
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PROJECT = "factbox-7cb97";
const API_KEY = "AIzaSyD3GRAWOihX3kTEGgxz3QytfcMg6M-7mM8";  /* public web key */
const FN = "https://us-central1-factbox-7cb97.cloudfunctions.net";
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const FS_API = `https://firestore.googleapis.com/v1/${DB}`;
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;

function ok(label, condition, detail) {
  if (condition) { pass++; console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
}

function ownerToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  let store = JSON.parse(fs.readFileSync(p, "utf8"));
  if (((store.tokens || {}).expires_at || 0) - Date.now() < 5 * 60 * 1000) {
    try { execFileSync("firebase", ["projects:list"], { stdio: "ignore" }); } catch (e) {}
    store = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return store.tokens.access_token;
}

async function req(url, opts) {
  opts = opts || {};
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, json, headers: r.headers };
}

async function main() {
  const OWNER = ownerToken();
  const admin = (extra) => Object.assign(
    { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" }, extra || {}
  );

  /* ---------------------------------------------------------------- 1 */
  console.log("\n1  the webhook is untouched");
  {
    const r = await req(FN + "/stripeWebhook", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    });
    ok("unsigned POST is rejected", r.status === 400, "HTTP " + r.status);
    const r2 = await req(FN + "/stripeWebhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: "{}"
    });
    ok("forged signature is rejected", r2.status === 400, "HTTP " + r2.status);
  }

  /* ---------------------------------------------------------------- 2,3 */
  console.log("\n2  a stranger, holding nothing");
  {
    const free = await req(FN + "/story?id=01");
    const cards = free.json && free.json.story && free.json.story.cards;
    ok("story 01 is served", free.status === 200 && Array.isArray(cards),
       `HTTP ${free.status}, ${cards ? cards.length : 0} cards, ` +
       `${free.headers.get("x-firestore-reads")} read(s)`);
    ok("story 01 carries real body text",
       !!(cards && cards.some((c) => (c.body || "").length > 40)));

    const free2 = await req(FN + "/story?id=02");
    ok("story 02 is served", free2.status === 200 && !!(free2.json || {}).ok,
       "HTTP " + free2.status);

    for (const id of ["03", "05", "26", "50", "07B"]) {
      const r = await req(FN + "/story?id=" + id);
      ok(`story ${id} is refused`,
         r.status === 401 && (r.json || {}).error === "auth_required",
         `HTTP ${r.status} ${(r.json || {}).error}`);
      ok(`story ${id} leaks no text`, r.text.indexOf('"cards"') === -1);
    }

    const bogus = await req(FN + "/story?id=99");
    ok("an unknown id 404s", bogus.status === 404, "HTTP " + bogus.status);
    const junk = await req(FN + "/story?id=../../customers");
    ok("a path-traversal id is refused", junk.status === 400, "HTTP " + junk.status);
    const badtok = await req(FN + "/story?id=05", { headers: { Authorization: "Bearer nonsense" } });
    ok("a forged ID token is refused",
       badtok.status === 401 && (badtok.json || {}).error === "bad_token",
       `HTTP ${badtok.status} ${(badtok.json || {}).error}`);
  }

  /* ------------------------------------------------------ a throwaway user */
  console.log("\n3  a signed-in reader who is not paying");
  const email = `backend-check-${Date.now()}@factbox-test.invalid`;
  const signup = await req(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Test-" + Date.now() + "!x", returnSecureToken: true }) }
  );
  if (signup.status !== 200) {
    console.log("  FAIL  could not create a test user — " + signup.text.slice(0, 300));
    fail++;
    return report();
  }
  const UID = signup.json.localId;
  const ID_TOKEN = signup.json.idToken;
  console.log(`  (test uid ${UID})`);

  const asReader = { Authorization: "Bearer " + ID_TOKEN };

  try {
    let r = await req(FN + "/story?id=05", { headers: asReader });
    ok("story 05 is refused to a non-subscriber",
       r.status === 403 && (r.json || {}).error === "subscription_required",
       `HTTP ${r.status} ${(r.json || {}).error}, ` +
       `${r.headers.get("x-firestore-reads")} read(s)`);
    ok("the refusal leaks no text", r.text.indexOf('"cards"') === -1);

    r = await req(FN + "/story?id=01", { headers: asReader });
    ok("story 01 still works while signed in", r.status === 200);

    /* -------------------------------------------------------------- 5 */
    console.log("\n4  the same reader, once Stripe says they are paying");
    await req(`${FS_API}/customers/${UID}?updateMask.fieldPaths=premium&updateMask.fieldPaths=uid`, {
      method: "PATCH", headers: admin(),
      body: JSON.stringify({ fields: { premium: { booleanValue: true }, uid: { stringValue: UID } } })
    });
    r = await req(FN + "/story?id=05", { headers: asReader });
    const paidCards = r.json && r.json.story && r.json.story.cards;
    ok("story 05 is now served",
       r.status === 200 && (r.json || {}).access === "subscriber" && Array.isArray(paidCards),
       `HTTP ${r.status}, ${paidCards ? paidCards.length : 0} cards, ` +
       `${r.headers.get("x-firestore-reads")} read(s)`);
    ok("it carries real body text",
       !!(paidCards && paidCards.some((c) => (c.body || "").length > 40)));
    ok("it is not cacheable by a shared cache",
       /no-store/.test(r.headers.get("cache-control") || ""),
       r.headers.get("cache-control"));

    /* the read count for a warm second open */
    const warm = await req(FN + "/story?id=05", { headers: asReader });
    console.log(`  reads on a warm repeat open of a paid story: ` +
                `${warm.headers.get("x-firestore-reads")}`);
    const warmFree = await req(FN + "/story?id=01");
    console.log(`  reads on a warm repeat open of a free story: ` +
                `${warmFree.headers.get("x-firestore-reads")}`);

    /* -------------------------------------------------------------- 6 */
    console.log("\n5  and when the subscription ends");
    await req(`${FS_API}/customers/${UID}?updateMask.fieldPaths=premium`, {
      method: "PATCH", headers: admin(),
      body: JSON.stringify({ fields: { premium: { booleanValue: false } } })
    });
    r = await req(FN + "/story?id=05", { headers: asReader });
    ok("access is withdrawn immediately",
       r.status === 403 && (r.json || {}).error === "subscription_required",
       `HTTP ${r.status} ${(r.json || {}).error}`);

    /* -------------------------------------------------------------- 7,8 */
    console.log("\n6  firestore.rules, asked directly by that same reader");
    r = await req(`${FS_API}/stories/05`, { headers: asReader });
    ok("direct read of stories/05 is denied", r.status === 403,
       `HTTP ${r.status} ${(r.json && r.json.error && r.json.error.status) || ""}`);
    ok("nothing came back with it", r.text.indexOf('"cards"') === -1);

    r = await req(`${FS_API}/stories/01`, { headers: asReader });
    ok("even the free story is closed at the database", r.status === 403, "HTTP " + r.status);

    r = await req(`${FS_API}:runQuery`, {
      method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, asReader),
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "stories" }], limit: 5 } })
    });
    ok("a collection query over stories is denied", r.status === 403, "HTTP " + r.status);

    r = await req(`${FS_API}/catalogue/v1`, { headers: asReader });
    const cat = r.json && r.json.fields && r.json.fields.stacks;
    const n = cat ? (cat.arrayValue.values || []).length : 0;
    ok("the catalogue is readable", r.status === 200 && n === 51,
       `HTTP ${r.status}, ${n} covers`);
    ok("and holds no card text", r.text.indexOf('"beat"') === -1);

    r = await req(`${FS_API}/customers/${UID}`, {
      method: "PATCH", headers: Object.assign({ "Content-Type": "application/json" }, asReader),
      body: JSON.stringify({ fields: { premium: { booleanValue: true } } })
    });
    ok("a reader cannot grant themselves premium", r.status === 403, "HTTP " + r.status);

  } finally {
    /* ---- clean up the throwaway ------------------------------------- */
    await req(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: ID_TOKEN })
    });
    await req(`${FS_API}/customers/${UID}`, { method: "DELETE", headers: admin() });
    console.log("\n  (test user and customer record deleted)");
  }

  /* ------------------------------------------------------------------ 9 */
  console.log("\n7  the audio beds");
  {
    const s = await req(FN + "/story?id=01");
    const beds = ((s.json || {}).story || {}).audio || {};
    const names = Object.keys(beds.beds || {});
    ok("a story carries its resolved beds",
       names.length > 0 && Array.isArray(beds.cards),
       `${names.length} beds, ${(beds.cards || []).length} cards mapped`);

    const url = beds.beds[names[0]].url;
    const r = await req(url, { method: "GET" });
    ok("the tokenised URL plays", r.status === 200 && r.text.length > 10000,
       `HTTP ${r.status}, ${r.text.length} bytes`);

    const naked = url.split("&token=")[0];
    const r2 = await req(naked);
    ok("the same object without its token is refused", r2.status === 403,
       "HTTP " + r2.status);

    const list = await req(
      "https://firebasestorage.googleapis.com/v0/b/factbox-7cb97.firebasestorage.app/o");
    ok("the bucket cannot be listed by a stranger", list.status === 403 || list.status === 401,
       "HTTP " + list.status);
  }

  /* ----------------------------------------------------------------- 10 */
  console.log("\n8  the corpus is complete");
  {
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "stacks.json"), "utf8")).stacks;
    let docs = [], pageToken = "";
    for (;;) {
      const r = await req(
        `${FS_API}/stories?pageSize=300&mask.fieldPaths=hash` +
        (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""),
        { headers: admin() });
      docs = docs.concat(r.json.documents || []);
      if (!r.json.nextPageToken) break;
      pageToken = r.json.nextPageToken;
    }
    ok("all 51 stories are in Firestore", docs.length === src.length,
       `${docs.length} of ${src.length}`);

    const ids = docs.map((d) => d.name.split("/").pop()).sort();
    const want = src.map((s) => s.id).sort();
    ok("the ids match exactly", JSON.stringify(ids) === JSON.stringify(want));

    /* Card totals, read straight back out of the database. */
    let total = 0, mismatched = [];
    for (const s of src) {
      const r = await req(`${FS_API}/stories/${s.id}?mask.fieldPaths=cards`, { headers: admin() });
      const got = (((r.json.fields || {}).cards || {}).arrayValue || {}).values || [];
      total += got.length;
      if (got.length !== s.cards.length) mismatched.push(s.id);
    }
    ok("all 450 cards are present", total === 450 && mismatched.length === 0,
       `${total} cards` + (mismatched.length ? `, wrong in ${mismatched.join(",")}` : ""));
  }

  report();
}

function report() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
