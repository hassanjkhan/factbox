/* ==========================================================================
   Assert that the first card of the reader is actually readable.

   check-page.js counts elements and looks for a phrase anywhere on the page.
   That is not enough for the reader: a deck can contain twelve <section
   class="beat"> elements with empty headings and a broken image src and
   still satisfy a count. This one looks at card zero specifically and
   demands the two things a reader needs from it — words, and a picture that
   resolves to a real file.

     node tools/check-first-card.js [baseURL] [id]

   Defaults to http://127.0.0.1:8899 and story 02 (free). Pass a locked id
   and it asserts the paywall's title and plate instead, because that is
   what card zero legitimately is for a locked story.

   Exits non-zero on: a script error, a missing heading, a heading shorter
   than four characters, a missing or empty image src, or an image URL that
   does not return 200.
   ========================================================================== */
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = (process.argv[2] || "http://127.0.0.1:8899").replace(/\/$/, "");
const ID = process.argv[3] || "02";

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

JSDOM.fromURL(`${BASE}/read.html?s=${encodeURIComponent(ID)}`, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  resources: "usable",
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} };
    w.fetch = (u, o) => fetch(new URL(String(u), BASE + "/").href, o);
  },
})
  .then(dom => new Promise(r => setTimeout(() => r(dom), 2500)))
  .then(async dom => {
    const d = dom.window.document;
    const card = d.querySelector(".beat") || d.querySelector(".paywall");
    const kind = d.querySelector(".beat") ? "story card" : "paywall";

    if (!card) {
      console.log("script errors :", errors.length ? errors : "none");
      console.log("FAIL — no first card of any kind in the deck.");
      process.exit(1);
    }

    const h = card.querySelector("h2");
    const text = h ? (h.textContent || "").replace(/\s+/g, " ").trim() : "";
    const img = card.querySelector("img");
    const src = img ? (img.getAttribute("src") || "") : "";

    let imgStatus = "not checked";
    let imgOK = false;
    if (src) {
      try {
        const r = await fetch(new URL(src, BASE + "/").href, { method: "HEAD" });
        imgStatus = String(r.status);
        imgOK = r.ok && Number(r.headers.get("content-length") || 0) > 1000;
      } catch (e) { imgStatus = "fetch failed: " + e.message; }
    }

    console.log("story         :", ID, "(" + kind + ")");
    console.log("script errors :", errors.length ? errors : "none");
    console.log("card 0 heading:", JSON.stringify(text.slice(0, 70)));
    console.log("card 0 img src:", JSON.stringify(src));
    console.log("img HTTP      :", imgStatus, imgOK ? "(real file)" : "(NOT usable)");
    if (kind === "story card") {
      const body = card.querySelector(".copy p");
      console.log("card 0 body   :",
        JSON.stringify(((body && body.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 70)));
    }

    const ok = errors.length === 0 && text.length >= 4 && !!src && imgOK;
    console.log(ok ? "PASS — the first card has words and a picture.\n" : "FAIL\n");
    process.exit(ok ? 0 : 1);
  })
  .catch(e => { console.log("harness error:", e.message); process.exit(1); });
