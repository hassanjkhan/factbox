/* The data-driven pages load an external script and a JSON file, so this one
   runs them over a real HTTP origin with resources enabled. */
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");
const page = process.argv[2], sel = process.argv[3], expect = process.argv[4] || "";

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

JSDOM.fromURL("http://127.0.0.1:8899/" + page, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  resources: "usable",
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} };
    /* jsdom exposes no window.fetch; every browser this ships to has one.
       Bridge it to Node's, resolving relative URLs against the page origin. */
    const base = "http://127.0.0.1:8899/";
    w.fetch = (u, o) => fetch(new URL(String(u), base).href, o);
  },
}).then(dom => new Promise(r => setTimeout(() => r(dom), 2000))).then(dom => {
  const d = dom.window.document;
  const n = d.querySelectorAll(sel).length;
  const txt = (d.body.innerText || d.body.textContent || "").replace(/\s+/g," ").trim();
  console.log("script errors :", errors.length ? errors : "none");
  console.log(`matched "${sel}"`.padEnd(15) + ":", n);
  if (expect) console.log("expects text  :", txt.includes(expect) ? "found" : "MISSING: " + expect);
  const ok = errors.length === 0 && n > 0 && (!expect || txt.includes(expect));
  console.log(ok ? "PASS\n" : "FAIL\n");
  process.exit(ok ? 0 : 1);
}).catch(e => { console.log("harness error:", e.message); process.exit(1); });
