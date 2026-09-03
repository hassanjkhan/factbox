/* SPEC.md §2.6: "Missing plate -> fall back to the stack hero."
   Every cover this site draws from /img/thumbs/ must carry a one-retry
   fallback to /img/stacks/. js/recommend.js, js/start.js and read.html's deck
   already do; this asserts the shelves do too.

   Usage: node check-plates.js "<page>" "<selector to wait for>"          */
const { JSDOM, VirtualConsole } = require("jsdom");
const page = process.argv[2], sel = process.argv[3];

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message));

const CEILING = 9000, STEP = 150;
function waitFor(dom) {
  const started = Date.now();
  return new Promise(resolve => {
    (function poll() {
      let found = 0;
      try { found = dom.window.document.querySelectorAll(sel).length; } catch (e) {}
      if (found > 0 || Date.now() - started > CEILING) return resolve(dom);
      setTimeout(poll, STEP);
    })();
  });
}

JSDOM.fromURL("http://127.0.0.1:8899/" + page, {
  runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  resources: "usable",
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} };
    const base = "http://127.0.0.1:8899/";
    w.fetch = (u, o) => fetch(new URL(String(u), base).href, o);
  },
}).then(waitFor).then(dom => {
  const d = dom.window.document;
  const imgs = [].slice.call(d.querySelectorAll("img"));
  const thumbs = imgs.filter(i => {
    const s = i.getAttribute("src") || i.getAttribute("data-plate") || "";
    return s.indexOf("/img/thumbs/") === 0 || s.indexOf("/img/cards/") === 0;
  });
  /* Three shapes count as a fallback, because the site uses all three:
     an onerror= attribute naming the hero, a data-fallback= the attribute
     handler reads, or an onerror assigned as a property (js/start.js,
     js/recommend.js build their <img> with createElement). */
  const bare = thumbs.filter(i => {
    const attr = (i.getAttribute("onerror") || "") + (i.getAttribute("data-fallback") || "");
    if (attr.indexOf("/img/stacks/") !== -1) return false;
    if (typeof i.onerror === "function") return false;
    return true;
  }).map(i => i.getAttribute("src") || i.getAttribute("data-plate"));
  console.log("page          :", page);
  console.log("plates drawn  :", thumbs.length);
  console.log("no fallback   :", bare.length, bare.slice(0, 6));
  /* A page with no covers on it is not a failure. An empty library genuinely
     draws none, and check-page.js already asserts that the page rendered — a
     checker that cries wolf on the empty case gets switched off. What this
     one is for is covers that exist and have no fallback. */
  const ok = errors.length === 0 && bare.length === 0;
  if (thumbs.length === 0) console.log("(no covers on this page — nothing to check)");
  console.log(ok ? "PASS\n" : "FAIL\n");
  process.exit(ok ? 0 : 1);
}).catch(e => { console.log("harness error:", e.message); process.exit(1); });
