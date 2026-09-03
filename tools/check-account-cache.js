/* Reading progress and saves belong to the ACCOUNT, not to the browser.

   The defect this guards is the one the owner reported twice: a shared phone,
   signed out, showing blue "Finished" ticks and a library of saves that
   belonged to whoever used that browser last. The fix has several moving
   parts in three files and a rules deploy, and every one of them is the kind
   of thing a plausible-looking merge quietly undoes — a gate removed because
   it "looked redundant", a cap dropped from the rules, a `reason` check
   deleted from a listener that then writes in a loop.

   Static checks on the source, like tools/check-regressions.js, and for the
   same reason: the behavioural version of "a departed account's ticks are not
   shown" needs two real accounts, a real Firestore and a shared browser
   profile to reproduce. A grep runs in nine milliseconds and cannot be
   skipped because someone was in a hurry.

   Run:  node tools/check-account-cache.js
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = f => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { return ""; } };

/* Comments in these files quote the owner, name the storage keys and discuss
   `let` and template literals in prose. Checking the source with comments in
   is how a checker starts crying wolf. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const CHECKS = [
  {
    name: "signed out shows nothing: the read paths are gated",
    why: "The owner's rule is 'if they're not even logged in, the UI should not " +
         "have anything in the finished story'. FBP.rec() and FBS.saved/all/ids/" +
         "count are the only doors personal state comes out of. Ungate any one " +
         "of them and the shared browser wears the last reader's ticks again.",
    pass: () => {
      const p = strip(read("js/progress.js"));
      const s = strip(read("js/saves.js"));
      return /function rec\(k\)\s*\{\s*if \(!_visible\) return null;/.test(p) &&
             /function saved\(id\)\s*\{\s*if \(!_visible\) return false;/.test(s) &&
             /function all\(\)\s*\{\s*var out = \[\];\s*if \(!_visible\) return out;/.test(s) &&
             /function ids\(\)\s*\{\s*var out = \[\];\s*if \(!_visible\) return out;/.test(s) &&
             /function count\(\)\s*\{\s*if \(!_visible\) return 0;/.test(s);
    },
  },
  {
    name: "the gate starts closed",
    why: "_visible = true by default would paint the previous reader's ticks for " +
         "the ~600ms Firebase takes to answer, then hide them. That is the " +
         "reported bug, just briefly. The safe direction is an empty shelf that " +
         "fills in, never a full one that empties.",
    pass: () => /var _visible = false;/.test(strip(read("js/progress.js"))) &&
                /var _visible = false;/.test(strip(read("js/saves.js"))),
  },
  {
    name: "both stores agree on which account owns the cache",
    why: "js/progress.js writes the owner tag and js/saves.js reads it. Two " +
         "different key names and saves would be shown to an account that " +
         "progress had already decided the cache does not belong to.",
    pass: () => {
      const k = /"(fb_cache_owner_v1)"/;
      return k.test(read("js/progress.js")) && k.test(read("js/saves.js")) &&
             k.test(read("js/progress-sync.js"));
    },
  },
  {
    name: "the mirror never writes to customers/{uid} itself",
    why: "That document carries the `premium` flag and is written by the Stripe " +
         "webhook. A client write racing it can clobber a subscription state " +
         "nothing on this site can rebuild. Progress goes in a subdocument.",
    pass: () => {
      const s = strip(read("js/progress-sync.js"));
      if (!/sdk\.doc\(db, "customers", uid, COLL, DOC\)/.test(s)) return false;
      /* the only doc() call in the file, and it has four path segments */
      const docs = s.match(/sdk\.doc\([^)]*\)/g) || [];
      return docs.length === 1;
    },
  },
  {
    name: "our own write landing back in the cache is not a change",
    why: "FBP/FBS notify listeners on every change including replaceAll(), which " +
         "is the pull writing the account's answer in. Treating that as a local " +
         "edit schedules a push, which lands, which notifies, forever.",
    pass: () => {
      const s = strip(read("js/progress-sync.js")).replace(/\s+/g, " ");
      /* both listeners exist, and the FIRST thing each does is separate a
         local edit from our own write landing */
      const guarded = s.match(/onChange\(function \(why\) \{ if \(why === "local"\)/g) || [];
      if (guarded.length !== 2) return false;
      /* and nothing schedules a push from anywhere a "replace" could reach */
      const pushes = s.match(/schedule\(PUSH_MS\)/g) || [];
      return pushes.length === 2;
    },
  },
  {
    name: "nothing reloads the page on a sign-out",
    why: "account.html and login.html sign out as FBU.signOut() -> " +
         "FBX.forgetLegacy() -> location.replace('/'). FBU's onChange fires " +
         "inside signOut(), so a reload from the sync lands between line one " +
         "and line three and the handler never finishes. Measured: it destroyed " +
         "the execution context mid-handler.",
    pass: () => {
      const s = strip(read("js/progress-sync.js"));
      const m = s.match(/function repaint\(key\) \{[\s\S]*?\n  \}/);
      if (!m) return false;
      /* an empty key means "fire the event and stop", and the bail has to come
         before the reload rather than after it */
      if (!/if \(!key\) return;/.test(m[0])) return false;
      if (m[0].indexOf("if (!key) return;") > m[0].indexOf("location.reload")) return false;
      /* and the sign-out transition — the branch that runs inside the
         handler — has to be the one passing an empty key */
      return /if \(curUid\) \{ forget\(\); repaint\(""\); return; \}/.test(s);
    },
  },
  {
    name: "the size caps in the rules match the caps in the code",
    why: "The rules are the only thing standing between a hostile client and a " +
         "megabyte in someone's document. Both payloads go up as strings " +
         "precisely so a rule can cap them, and the numbers have to be the same " +
         "numbers js/progress.js and js/saves.js enforce on themselves.",
    pass: () => {
      const r = read("firestore.rules");
      if (!/docId == "reading"/.test(r)) return false;
      if (!/hasOnly\(\[\s*"schema", "updatedAt", "count", "map", "saveCount", "saves"\s*\]\)/.test(r.replace(/\s+/g, " ").replace(/hasOnly\(\[ /, "hasOnly([\n               "))) {
        if (!/"schema", "updatedAt", "count", "map", "saveCount", "saves"/.test(r)) return false;
      }
      if (!/request\.resource\.data\.map\.size\(\) <= 20000/.test(r)) return false;
      if (!/request\.resource\.data\.saves\.size\(\) <= 8000/.test(r)) return false;
      if (!/smallInt\("count", 60\)/.test(r)) return false;
      if (!/smallInt\("saveCount", 200\)/.test(r)) return false;
      /* and the code must not try to write more than the rule allows */
      const s = read("js/progress-sync.js");
      return /MAX_ENTRIES = 60/.test(s) && /MAP_BYTES   = 20000/.test(s) &&
             /MAX_SAVES   = 200/.test(s) && /SAVE_BYTES  = 8000/.test(s);
    },
  },
  {
    name: "customers/{uid} is still closed to every browser",
    why: "The whole point of putting progress in a subdocument. If this ever " +
         "opens, a client can grant itself a subscription.",
    pass: () => {
      const r = read("firestore.rules");
      return /match \/customers\/\{uid\} \{\s*allow read: if isSelf\(uid\);\s*allow write: if false;/.test(r);
    },
  },
  {
    name: "what someone reads is not sent to analytics",
    why: "A story id, a card number and a finished flag are a reading history. " +
         "Nothing here has any business in a log.",
    pass: () => {
      const s = strip(read("js/progress-sync.js"));
      return !/(FBT\b|gtag|dataLayer|analytics|google-analytics)/.test(s);
    },
  },
  {
    name: "ES5 only in the three shipped files",
    why: "Most readers arrive through the Instagram and TikTok in-app browsers. " +
         "js/auth.js is the site's one module and this is not it.",
    pass: () => {
      for (const f of ["js/progress.js", "js/saves.js", "js/progress-sync.js"]) {
        const s = strip(read(f))
          .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
        if (/(^|[^\w$.])(let|const)\s+[A-Za-z_$]/.test(s)) return false;
        if (/=>/.test(s)) return false;
        if (/`/.test(s)) return false;
        if (/\.\.\./.test(s)) return false;
        /* the one deliberate exception, and it is built with new Function so a
           browser that cannot parse it fails to build one function rather than
           failing to parse the file */
        if (/\bimport\s*\(/.test(s) && !/new Function\("u", "return import\(u\);"\)/.test(read(f))) return false;
      }
      return true;
    },
  },
  {
    name: "every page with reading memory gets the mirror",
    why: "js/progress.js appends js/progress-sync.js rather than each of the " +
         "twelve pages carrying a <script> tag, so it cannot be forgotten on a " +
         "thirteenth. Take that out and the pages silently stop syncing.",
    pass: () => {
      const s = read("js/progress.js");
      if (!/\/js\/progress-sync\.js/.test(s)) return false;
      if (!/s\.async = true/.test(s)) return false;
      return fs.existsSync(path.join(ROOT, "js/progress-sync.js"));
    },
  },
  {
    name: "the shelf still draws before the network answers",
    why: "The sync must never become something a render waits on. FBP and FBS " +
         "answer from memory, synchronously, with no promise anywhere on the " +
         "path a page reads.",
    pass: () => {
      for (const f of ["js/progress.js", "js/saves.js"]) {
        const s = strip(read(f));
        if (/(fetch\(|XMLHttpRequest|Promise|await |import\()/.test(s)) return false;
      }
      return true;
    },
  },
];

let bad = 0;
for (const c of CHECKS) {
  let ok = false;
  try { ok = !!c.pass(); } catch (e) { ok = false; }
  if (!ok) { bad++; console.log("FAIL  " + c.name + "\n      " + c.why + "\n"); }
  else console.log("ok    " + c.name);
}
console.log("\n" + CHECKS.length + " invariants guarded, " + bad + " broken");
process.exit(bad ? 1 : 0);
