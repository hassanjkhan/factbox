/* The data-driven pages load an external script and a JSON file, so this one
   runs them over a real HTTP origin with resources enabled. */
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");
const page = process.argv[2], sel = process.argv[3], expect = process.argv[4] || "";

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(e.message));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

/* Wait for the page to be finished, not for a fixed two seconds.

   A flat 2000ms was silently wrong for anything behind the access gate: the
   reader does not draw its paywall until FBX has settled (~1.6s with no
   account) AND 413KB of story text has arrived, and on a cold local server
   that is regularly past the deadline. The check then reported "matched
   .paywall: 0" for a page that renders it perfectly — a check that cries wolf
   gets ignored, which is worse than no check.

   So: poll for the selector, up to a ceiling well past FBX.CAP_MS (7s), and
   return the moment it appears. Passing runs get faster, not slower. A page
   that genuinely never renders still fails, it just takes the full ceiling to
   say so. */
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
    /* jsdom exposes no window.fetch; every browser this ships to has one.
       Bridge it to Node's, resolving relative URLs against the page origin. */
    const base = "http://127.0.0.1:8899/";
    w.fetch = (u, o) => fetch(new URL(String(u), base).href, o);
  },
}).then(waitFor).then(dom => {
  const d = dom.window.document;
  const n = d.querySelectorAll(sel).length;
  /* textContent includes inline <script> source, so the checker was reading
     the page's own error-handling code as if it were words on the screen.
     Clone, strip scripts and styles, then read what a reader would see. */
  const clone = d.body.cloneNode(true);
  clone.querySelectorAll("script,style,template,noscript").forEach(n => n.remove());
  const txt = (clone.textContent || "").replace(/\s+/g, " ").trim();
  console.log("script errors :", errors.length ? errors : "none");
  console.log(`matched "${sel}"`.padEnd(15) + ":", n);
  if (expect) console.log("expects text  :", txt.includes(expect) ? "found" : "MISSING: " + expect);
  /* A page can swallow its own error into a friendly failure state, which
     reports zero script errors while showing the reader nothing. Treat the
     known error copy as a failure in its own right. */
  const FORBID = ["Could not load", "Not taking payments yet"];
  const tripped = FORBID.filter(f => txt.includes(f));
  if (tripped.length) console.log("error state   :", tripped);
  const ok = errors.length === 0 && n > 0 && !tripped.length
             && (!expect || txt.includes(expect));
  console.log(ok ? "PASS\n" : "FAIL\n");
  process.exit(ok ? 0 : 1);
}).catch(e => { console.log("harness error:", e.message); process.exit(1); });
