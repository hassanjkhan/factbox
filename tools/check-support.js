/* ==========================================================================
   Factbox — the support inbox, end to end.

   /support collects two things a reader typed and, until now, handed them to
   a mail app that half this site's audience does not have. This asserts the
   replacement actually delivers: that a signed-out stranger's message reaches
   Firestore, that it reaches it in the shape the console expects, that
   everything else about the endpoint is shut, and that no browser can write
   the collection directly.

   It writes real documents into `support/` and deletes them afterwards, and
   it creates a throwaway Firebase user for the signed-in case and deletes
   that too. It takes about half a minute, because proving the per-IP throttle
   means waiting for it.

   Usage:  node tools/check-support.js
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PROJECT = "factbox-7cb97";
const API_KEY = "AIzaSyD3GRAWOihX3kTEGgxz3QytfcMg6M-7mM8";  /* public web key */
const FN = "https://us-central1-factbox-7cb97.cloudfunctions.net/support";
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const FS_API = `https://firestore.googleapis.com/v1/${DB}`;

/* The six fields the console shows, in the order it shows them — Firestore
   sorts a document's fields alphabetically, so this list is also the reading
   order a founder gets. */
const FIELDS = ["at", "from", "kind", "message", "page", "uid"];
const GAP_MS = 20 * 1000;   /* the function's per-IP minimum gap */

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
  const r = await fetch(url, opts || {});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, json, headers: r.headers };
}

const send = (body, headers) => req(FN, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json", Origin: "https://factbox.app" }, headers || {}),
  body: JSON.stringify(body)
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Firestore's REST shape, flattened to something worth asserting against. */
function plain(doc) {
  const out = {};
  Object.keys(doc.fields || {}).forEach((k) => {
    const v = doc.fields[k];
    out[k] = v.stringValue !== undefined ? v.stringValue
           : v.timestampValue !== undefined ? v.timestampValue
           : v.integerValue !== undefined ? Number(v.integerValue)
           : JSON.stringify(v);
  });
  return out;
}

async function main() {
  const OWNER = ownerToken();
  const asOwner = { Authorization: "Bearer " + OWNER, "Content-Type": "application/json" };
  const made = [];
  let user = null;

  /* ------------------------------------------------------------------ 1 */
  console.log("\n1  the endpoint accepts nothing but the shape it expects");
  {
    const g = await req(FN, { method: "GET" });
    ok("GET is refused", g.status === 405, "HTTP " + g.status);

    const k = await send({ kind: "sales", message: "hello" });
    ok("an unknown kind is refused", k.status === 400 && k.json.error === "bad_request",
       "HTTP " + k.status + " " + k.text);

    /* KINDS is a plain object, so this is the prototype-key case. */
    const proto = await send({ kind: "constructor", message: "hello" });
    ok("a prototype key is not a kind", proto.status === 400, "HTTP " + proto.status + " " + proto.text);

    const empty = await send({ kind: "help", message: "   \n  " });
    ok("an empty message is refused", empty.status === 400 && empty.json.error === "empty",
       "HTTP " + empty.status + " " + empty.text);

    const long = await send({ kind: "help", message: "x".repeat(4001) });
    ok("4,001 characters is refused", long.status === 400 && long.json.error === "too_long",
       "HTTP " + long.status + " " + long.text);

    const huge = await req(FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "help", message: "x".repeat(200000) })
    });
    ok("a 200 KB body never reaches the parser", huge.status === 413 || huge.status === 400,
       "HTTP " + huge.status);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log("\n2  a signed-out stranger's message arrives");
  let anonId = null;
  {
    const stamp = "check-support anonymous " + Date.now();
    const r = await send({
      kind: "help",
      message: stamp,
      email: "stranger@example.com",
      page: "/support",
      /* Everything below is the attack: extra keys, hoping one of them lands. */
      uid: "somebody-elses-uid",
      premium: true,
      admin: true,
      at: "1999-01-01T00:00:00Z"
    });
    ok("it is accepted", r.status === 200 && r.json && r.json.ok === true, "HTTP " + r.status + " " + r.text);

    const list = await req(FS_API + "/support?pageSize=100", { headers: asOwner });
    const doc = (list.json.documents || []).find((d) => plain(d).message === stamp);
    ok("the document is in Firestore", !!doc);

    if (doc) {
      anonId = doc.name.split("/").pop();
      made.push(anonId);
      const f = plain(doc);
      console.log("        id      : " + anonId);
      console.log("        fields  : " + JSON.stringify(f, null, 2).split("\n").join("\n        "));

      ok("exactly the six expected fields", JSON.stringify(Object.keys(f).sort()) === JSON.stringify(FIELDS),
         Object.keys(f).sort().join(", "));
      ok("no smuggled uid", f.uid === "", JSON.stringify(f.uid));
      ok("no smuggled premium/admin", f.premium === undefined && f.admin === undefined);
      ok("the timestamp is the server's, not the caller's", f.at.slice(0, 4) !== "1999", f.at);
      ok("the reply address is kept", f.from === "stranger@example.com", f.from);
      ok("the kind reads as words", f.kind === "Something is wrong", f.kind);
      ok("the document id sorts by time", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-z0-9]{4}$/.test(anonId), anonId);
    }
  }

  /* ------------------------------------------------------------------ 3 */
  console.log("\n3  one browser cannot flood it");
  {
    const r = await send({ kind: "idea", message: "a second message, straight away" });
    ok("a second message inside the gap is refused", r.status === 429, "HTTP " + r.status + " " + r.text);
  }

  /* ------------------------------------------------------------------ 4 */
  console.log("\n4  a signed-in reader is identified, and only by their token");
  {
    console.log(`     (waiting ${GAP_MS / 1000}s for the throttle to clear)`);
    await wait(GAP_MS + 1500);

    const signup = await req(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `support-check-${Date.now()}@example.com`,
                               password: "Throwaway-" + Date.now(), returnSecureToken: true }) }
    );
    if (!signup.json || !signup.json.idToken) {
      ok("a throwaway account could be created", false, signup.text.slice(0, 200));
    } else {
      user = signup.json;
      const stamp = "check-support signed in " + Date.now();

      const bad = await send({ kind: "help", message: "token nonsense " + Date.now() },
                             { Authorization: "Bearer not-a-token" });
      ok("a broken token does not lose the message", bad.status === 200, "HTTP " + bad.status + " " + bad.text);
      const badList = await req(FS_API + "/support?pageSize=100", { headers: asOwner });
      const badDoc = (badList.json.documents || []).find((d) => plain(d).message.indexOf("token nonsense") === 0);
      if (badDoc) {
        made.push(badDoc.name.split("/").pop());
        ok("...and it is filed as anonymous", plain(badDoc).uid === "", JSON.stringify(plain(badDoc).uid));
      }

      await wait(GAP_MS + 1500);

      const r = await send({ kind: "help", message: stamp },
                           { Authorization: "Bearer " + user.idToken });
      ok("a signed-in message is accepted", r.status === 200, "HTTP " + r.status + " " + r.text);

      const list = await req(FS_API + "/support?pageSize=100", { headers: asOwner });
      const doc = (list.json.documents || []).find((d) => plain(d).message === stamp);
      if (doc) {
        made.push(doc.name.split("/").pop());
        ok("the uid is attached, from the verified token", plain(doc).uid === user.localId,
           plain(doc).uid);
      } else {
        ok("the signed-in document is in Firestore", false);
      }
    }
  }

  /* ------------------------------------------------------------------ 5 */
  console.log("\n5  no browser writes or reads the collection directly");
  {
    const asReader = user
      ? { Authorization: "Bearer " + user.idToken, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" };

    /* The shape the function itself writes — the rules refuse it anyway,
       which is the point: there is no shape a browser can get through. */
    const create = await req(`${FS_API}/support?documentId=forged-${Date.now()}&key=${API_KEY}`, {
      method: "POST", headers: asReader,
      body: JSON.stringify({ fields: {
        at: { timestampValue: new Date().toISOString() },
        from: { stringValue: "forged@example.com" },
        kind: { stringValue: "Something is wrong" },
        message: { stringValue: "written straight to Firestore" },
        page: { stringValue: "/support" },
        uid: { stringValue: "" }
      } })
    });
    ok("a well-formed direct create is denied", create.status === 403 || create.status === 401,
       "HTTP " + create.status + " " + (create.json && create.json.error ? create.json.error.status : ""));
    console.log("        rejection: " + create.text.replace(/\s+/g, " ").slice(0, 220));

    const read = await req(`${FS_API}/support?pageSize=1&key=${API_KEY}`, { headers: asReader });
    ok("a browser cannot read the inbox", read.status === 403 || read.status === 401, "HTTP " + read.status);

    const quota = await req(`${FS_API}/support_meta/quota?key=${API_KEY}`, { headers: asReader });
    ok("a browser cannot read or reset the quota", quota.status === 403 || quota.status === 401,
       "HTTP " + quota.status);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log("\n6  cleanup");
  {
    for (const id of made) {
      const d = await req(`${FS_API}/support/${id}`, { method: "DELETE", headers: asOwner });
      ok("deleted " + id, d.status === 200, "HTTP " + d.status);
    }
    if (user) {
      const d = await req(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: user.idToken })
      });
      ok("throwaway account deleted", d.status === 200, "HTTP " + d.status);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
