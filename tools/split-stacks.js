/* ==========================================================================
   Split data/stacks.json into the two shapes the site actually reads.

   Every page used to fetch the whole 413KB corpus — all 51 stories, every
   word of every card — to render one story, or to draw a shelf that shows no
   card text at all. On the in-app webviews this site targets that is ~95KB
   gzipped before the first word can appear.

   This writes:

     data/index.json      every stack, every top-level field, and each card
                          reduced to { n, head }. That is what the shelves
                          need: cards.length for the "12 cards" line, and the
                          headlines for explore.js's search index. ~21KB gz.

     data/story/<ID>.json one stack, complete, as { stack: {...} }. ~3KB gz.

   The monolith stays exactly where it is and stays the source of truth. The
   client falls back to it whenever a split file 404s, so a stale or missing
   build of this script degrades to the old behaviour rather than to an empty
   page. Re-run after any edit to data/stacks.json:

     node tools/split-stacks.js

   ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "data", "stacks.json");
const OUT_INDEX = path.join(ROOT, "data", "index.json");
const OUT_DIR = path.join(ROOT, "data", "story");

/* The id travels in a URL and then in a filename, so it may only ever be the
   characters the ids actually use. Anything else is a bug upstream, not
   something to sanitise quietly. */
const SAFE = /^[A-Za-z0-9_-]{1,24}$/;

function main() {
  const doc = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const stacks = doc.stacks;
  if (!Array.isArray(stacks) || !stacks.length) {
    throw new Error("data/stacks.json has no stacks array");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* Clear out story files for ids that no longer exist, so a renamed or
     deleted story cannot keep serving its old text forever. */
  const keep = new Set();

  let wrote = 0, bytes = 0;
  for (const s of stacks) {
    const id = String(s.id || "");
    if (!SAFE.test(id)) throw new Error("unsafe stack id: " + JSON.stringify(id));
    if (!Array.isArray(s.cards) || !s.cards.length) {
      throw new Error("stack " + id + " has no cards");
    }
    keep.add(id + ".json");
    const body = JSON.stringify({ stack: s });
    fs.writeFileSync(path.join(OUT_DIR, id + ".json"), body);
    wrote++; bytes += Buffer.byteLength(body);
  }

  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith(".json") && !keep.has(f)) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      console.log("removed stale " + f);
    }
  }

  /* The shelves read every top-level field, so drop nothing there. Only the
     card payload shrinks, and only to what a shelf can actually display:
     the count, and the headlines explore.js searches. */
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

  const mono = fs.statSync(SRC).size;
  console.log("stories written   :", wrote, "(" + Math.round(bytes / 1024) + "KB total)");
  console.log("data/index.json   :", Math.round(idxBody.length / 1024) + "KB");
  console.log("data/stacks.json  :", Math.round(mono / 1024) + "KB (unchanged, still the fallback)");

  /* A split that lost a card or a field is worse than no split, because the
     fallback never fires — the file is there and it is wrong. */
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
    }
    const one = JSON.parse(
      fs.readFileSync(path.join(OUT_DIR, a.id + ".json"), "utf8")
    ).stack;
    if (JSON.stringify(one) !== JSON.stringify(a)) {
      throw new Error("story file for " + a.id + " is not identical to the monolith");
    }
  }
  console.log("verified          : every field, card and headline round-trips");
}

main();
