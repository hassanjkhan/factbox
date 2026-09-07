/* ==========================================================================
   Write the PUBLIC data files from the private corpus.

   The corpus is content/stacks.json: every word of all 51 stories. It is
   untracked (see .gitignore) and it is a build input, not a file the site
   serves. It used to live at data/stacks.json, where GitHub Pages served it
   to anybody who typed the URL — 413KB, the entire paid product, no account
   needed. That was the leak this script now exists to make impossible to
   reopen by accident.

   What this writes, and the rule each file obeys:

     data/index.json      every stack, every top-level field, and each card
                          reduced to { n, head }. NO CARD BODIES, for any
                          story, free or not. That is what the shelves need:
                          cards.length for the "12 cards" line, the headlines
                          for explore.js's search index, and the cover
                          metadata every locked story is still sold on.
                          ~21KB gz.

     data/story/<ID>.json ONE FILE PER PERMANENTLY FREE STORY, complete.
                          `free: true` is the only thing that earns a story a
                          static file. Stories 01 and 02 are the top of the
                          funnel — /firststory and the composed pages serve
                          them to signed-out readers, offline, from cache —
                          and there is nothing to protect, because they are
                          free to everybody forever.

   Every other story's text is served by functions/story.js, which verifies
   the caller's Firebase ID token and reads `customers/{uid}.premium` out of
   Firestore before a single card leaves the building. js/gate.js routes on
   the same `free` flag this script reads, so the two cannot disagree about
   which stories have a file.

   Today's rotating free story does NOT get a file. It is free because the
   server says it is free today, and a file would still be there tomorrow.

   Re-run after any edit to content/stacks.json:

     node tools/split-stacks.js

   tools/check-regressions.js asserts the result: no body text for a non-free
   story anywhere under data/.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "content", "stacks.json");
const OUT_INDEX = path.join(ROOT, "data", "index.json");
const OUT_DIR = path.join(ROOT, "data", "story");

/* The id travels in a URL and then in a filename, so it may only ever be the
   characters the ids actually use. Anything else is a bug upstream, not
   something to sanitise quietly. */
const SAFE = /^[A-Za-z0-9_-]{1,24}$/;

function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(
      "content/stacks.json is missing. The corpus is the untracked build " +
      "input now — it is NOT under data/ and never goes back there. " +
      "Rebuild it with tools/build_stacks.py, or copy it from wherever the " +
      "content package lives."
    );
  }
  const doc = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const stacks = doc.stacks;
  if (!Array.isArray(stacks) || !stacks.length) {
    throw new Error("content/stacks.json has no stacks array");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* Clear out story files for ids that are no longer free — a story that
     stops being free must stop having a file the same minute, or the gate
     routes to the function while the old text sits there being fetched
     directly. */
  const keep = new Set();

  let wrote = 0, bytes = 0;
  for (const s of stacks) {
    const id = String(s.id || "");
    if (!SAFE.test(id)) throw new Error("unsafe stack id: " + JSON.stringify(id));
    if (!Array.isArray(s.cards) || !s.cards.length) {
      throw new Error("stack " + id + " has no cards");
    }
    /* `=== true`, not truthy: the one test that decides whether text is
       published. A string, a 1, or an undefined field must all mean "paid". */
    if (s.free !== true) continue;
    keep.add(id + ".json");
    const body = JSON.stringify({ stack: s });
    fs.writeFileSync(path.join(OUT_DIR, id + ".json"), body);
    wrote++; bytes += Buffer.byteLength(body);
  }

  let removed = 0;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith(".json") && !keep.has(f)) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      console.log("removed " + f + " — not a permanently free story");
      removed++;
    }
  }

  /* The shelves read every top-level field, so drop nothing there. Only the
     card payload shrinks, and only to what a shelf can actually display:
     the count, and the headlines explore.js searches.

     `head` is a headline and `hook` is the cover line: both are the pitch,
     both are meant to be public, and neither is what a subscriber is paying
     for. `body` is, and it is not written here for any story. */
  const index = {
    stacks: stacks.map(s => {
      const out = {};
      for (const k of Object.keys(s)) {
        if (k !== "cards") out[k] = s[k];
      }
      out.cards = s.cards.map(c => ({ n: c.n, head: c.head }));
      return out;
    }),
  };
  const idxBody = JSON.stringify(index);
  fs.writeFileSync(OUT_INDEX, idxBody);

  console.log("free stories written :", wrote, "(" + Math.round(bytes / 1024) + "KB total)");
  console.log("paid files removed   :", removed);
  console.log("data/index.json      :", Math.round(idxBody.length / 1024) + "KB, no card bodies");

  /* A split that lost a card or a field is worse than no split, because
     nothing falls back any more — the file is there and it is wrong. */
  verify(stacks, index.stacks);
}

function verify(src, idx) {
  if (src.length !== idx.length) throw new Error("index lost a stack");
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = idx[i];
    if (a.id !== b.id) throw new Error("index reordered stacks at " + i);
    if (a.cards.length !== b.cards.length) {
      throw new Error("index changed card count for " + a.id);
    }
    for (const k of Object.keys(a)) {
      if (k === "cards") continue;
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        throw new Error("index changed field " + k + " on " + a.id);
      }
    }
    for (let j = 0; j < a.cards.length; j++) {
      if (a.cards[j].head !== b.cards[j].head) {
        throw new Error("index changed a headline on " + a.id);
      }
      if (b.cards[j].body !== undefined) {
        throw new Error("index kept a card body on " + a.id);
      }
    }

    const file = path.join(OUT_DIR, a.id + ".json");
    if (a.free === true) {
      const one = JSON.parse(fs.readFileSync(file, "utf8")).stack;
      if (JSON.stringify(one) !== JSON.stringify(a)) {
        throw new Error("story file for " + a.id + " is not identical to the corpus");
      }
    } else if (fs.existsSync(file)) {
      throw new Error("paid story " + a.id + " still has a file under data/story");
    }
  }
  console.log("verified             : every field, card and headline round-trips,");
  console.log("                       and only free stories have a file");
}

main();
