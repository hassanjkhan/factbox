/* The shelf, in a real DOM, in both access states.

   It draws covers before the access answer arrives, so "does it have words
   and pictures" is no longer the whole question. The other half is whether
   the padlocks end up in the right place, and this asserts both:

     signed out -> the 49 paid covers carry .locked and a .lock badge,
                   the 2 free ones do not, and the buy bar is showing.
     subscriber -> nothing carries .locked, there is one section heading
                   reading "All stories", and the buy bar is hidden.

   node tools/check-shelf.js [baseURL] [out|in]
   ========================================================================== */
const { JSDOM, VirtualConsole } = require("jsdom");
const BASE = (process.argv[2] || "http://127.0.0.1:8899").replace(/\/$/, "");
const MODE = process.argv[3] || "out";           /* "out" | "in" */

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

JSDOM.fromURL(`${BASE}/stories.html`, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  resources: "usable",
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} };
    w.fetch = (u, o) => fetch(new URL(String(u), BASE + "/").href, o);
    /* Stand in for the account, the way the page will really be told. The
       real FBX is built by access.js after this runs, so trap the assignment
       rather than trying to define the object before it exists. */
    let real;
    Object.defineProperty(w, "FBX", {
      configurable: true,
      get() { return real; },
      set(v) {
        real = v;
        if (!v) return;
        const allowed = MODE === "in";
        v.paint = fn => setTimeout(() => { try { fn(allowed, allowed ? "subscriber" : "none"); } catch (e) {} }, 300);
        v.can = () => allowed;
        v.why = () => (allowed ? "subscriber" : "none");
        v.ready = () => Promise.resolve();
      },
    });
  },
})
  .then(dom => new Promise(r => setTimeout(() => r(dom), 2500)))
  .then(dom => {
    const d = dom.window.document;
    const all = [...d.querySelectorAll("#shelf .card")];
    const locked = all.filter(a => a.classList.contains("locked"));
    const badges = d.querySelectorAll("#shelf .lock").length;
    const free = all.filter(a => a.getAttribute("data-free"));
    const heads = [...d.querySelectorAll("#shelf .sechead h2")].map(h => h.textContent.trim());
    const bar = d.getElementById("buybar");
    const withImg = all.filter(a => (a.querySelector("img") || {}).getAttribute?.("src"));
    const withTitle = all.filter(a => (a.querySelector("h3")?.textContent || "").trim().length > 3);

    console.log("mode          :", MODE === "in" ? "subscriber" : "signed out");
    console.log("script errors :", errors.length ? errors : "none");
    console.log("covers        :", all.length, "| with image:", withImg.length, "| with title:", withTitle.length);
    console.log("free covers   :", free.length);
    console.log("locked covers :", locked.length, "| lock badges:", badges);
    console.log("section heads :", JSON.stringify(heads));
    console.log("buybar hidden :", bar ? bar.hidden : "(no bar)");

    let ok = errors.length === 0 && all.length === 51 &&
             withImg.length === 51 && withTitle.length === 51;
    if (MODE === "in") {
      ok = ok && locked.length === 0 && badges === 0 &&
           heads.length === 1 && heads[0] === "All stories" && bar.hidden === true;
    } else {
      ok = ok && locked.length === 49 && badges === 49 &&
           free.length === 2 && heads.length === 2 && bar.hidden === false &&
           free.every(a => !a.classList.contains("locked"));
    }
    console.log(ok ? "PASS\n" : "FAIL\n");
    process.exit(ok ? 0 : 1);
  })
  .catch(e => { console.log("harness error:", e.message); process.exit(1); });
