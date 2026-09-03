/* What actually takes the time, from navigation to words on the screen.

   Every other check in here answers "did it render?". This one answers "when,
   and what were we waiting for?" — because "the stories load slowly" is not a
   thing a pass/fail check can see, and guessing at it has already cost a day.

   It drives real Chrome, so these are real numbers: real HTTP, real parse,
   real JavaScript, real paint. It records four things:

     * every network request, with size and duration
     * the access gate's own milestones, via window.__fbmark() which access.js
       calls if it exists (absent in production; the page works either way)
     * when the first card is genuinely on screen — not in the DOM, ON SCREEN,
       which means non-zero size and not opacity:0, because this site's whole
       history of shipping blank pages is elements that existed and could not
       be read
     * when the shelf's padlocks settle, which is a different moment again

   Usage:
     node timeline.js https://factbox.app/read?s=05
     node timeline.js http://127.0.0.1:8899/stories.html --cold
     node timeline.js <url> --signed-in <email> <password>
*/
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const url  = process.argv[2];
const cold = process.argv.includes("--cold");
const si   = process.argv.indexOf("--signed-in");
const creds = si > -1 ? { email: process.argv[si + 1], pass: process.argv[si + 2] } : null;
if (!url) { console.error("usage: node timeline.js <url> [--cold] [--signed-in <email> <pass>]"); process.exit(1); }

const ms = n => (n === null || n === undefined ? "     —" : (n / 1).toFixed(0).padStart(5) + "ms");
const kb = n => (n ? (n / 1024).toFixed(1).padStart(7) + "KB" : "        ");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });
  if (cold) await page.setCacheEnabled(false);

  if (creds) {
    const origin = new URL(url).origin;
    await page.goto(origin + "/login", { waitUntil: "networkidle2" });
    await page.type("#email", creds.email).catch(() => {});
    await page.type("#pass", creds.pass).catch(() => {});
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => {}),
      page.click("#go").catch(() => {}),
    ]);
    await new Promise(r => setTimeout(r, 2500));   // let the snapshot land
    console.log("signed in as " + creds.email + "\n");
  }

  const reqs = [];
  page.on("response", async r => {
    const t = r.timing();
    let len = 0;
    try { len = Number(r.headers()["content-length"] || 0); } catch (e) {}
    reqs.push({ url: r.url(), status: r.status(), len,
                start: t ? t.requestTime : null, recv: t ? t.receiveHeadersEnd : null });
  });

  await page.evaluateOnNewDocument(() => {
    window.__marks = [];
    window.__fbmark = n => window.__marks.push({ n, t: performance.now() });
    /* The moment the first card is READABLE — laid out, sized, not transparent.
       An element that exists but is opacity:0 is exactly the failure this site
       has shipped, so "in the DOM" is not the question being asked. */
    /* Poll, do not observe. A MutationObserver fires between layout passes,
       so getBoundingClientRect inside it reports the geometry of a moment that
       has not been laid out yet — every element measures 0x0 and nothing is
       ever judged readable. rAF runs after layout, which is the whole point. */
    const seen = {};
    const stamp = n => { if (!seen[n]) { seen[n] = true; window.__marks.push({ n, t: performance.now() }); } };
    const readable = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const o = parseFloat(getComputedStyle(el).opacity || "1");
      return r.width > 0 && r.height > 0 && o > 0.05 && (el.textContent || "").trim().length > 4;
    };
    (function tick() {
      /* "Readable" is not "this site's card markup" — every page has to be
         measurable, including the ones with no cards on them. So: the first
         element that is laid out, opaque, and carrying real words, searched in
         the order a reader's eye would find them. */
      var MAIN = ".beat, #shelf .card, .paywall h2, main h1, main h2, .wrap h1, " +
                 "h1, h2, .card, table tbody tr, form label, p";
      var list = document.querySelectorAll(MAIN);
      for (var i = 0; i < list.length; i++) {
        if (readable(list[i])) { stamp("FIRST CONTENT READABLE"); break; }
      }
      if (readable(document.querySelector(".paywall h2"))) stamp("paywall readable");
      if (document.querySelector("#shelf .card.locked")) stamp("padlocks applied");
      if (document.querySelector(".buybar:not([hidden])")) stamp("buy bar shown");
      requestAnimationFrame(tick);
    })();
  });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const domReady = Date.now() - t0;
  await new Promise(r => setTimeout(r, 9000));      // past FBX's 7s ceiling

  const marks = await page.evaluate(() => window.__marks || []);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] || {};
    return { ttfb: n.responseStart, domInt: n.domInteractive, domDone: n.domComplete };
  });
  const res = await page.evaluate(() => performance.getEntriesByType("resource").map(r => ({
    url: r.name, start: r.startTime, dur: r.duration, size: r.transferSize, kind: r.initiatorType })));

  console.log("=".repeat(78));
  console.log(url + (cold ? "   [cold cache]" : "   [warm cache]"));
  console.log("=".repeat(78));
  console.log("\nNETWORK — every request, in the order it started\n");
  console.log("   start    dur     size  status  url");
  res.sort((a, b) => a.start - b.start).forEach(r => {
    const short = r.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 46);
    console.log("  " + ms(r.start) + " " + ms(r.dur) + " " + kb(r.size) + "          " + short);
  });

  console.log("\nTIMELINE — what the reader actually waits for\n");
  const rows = [
    ["TTFB (server responded)", nav.ttfb],
    ["DOM interactive", nav.domInt],
    ...marks.map(m => [m.n, m.t]),
    ["DOM complete", nav.domDone],
  ].filter(r => r[1] != null).sort((a, b) => a[1] - b[1]);
  let prev = 0;
  rows.forEach(([n, t]) => {
    const gap = t - prev; prev = t;
    const bar = "█".repeat(Math.min(40, Math.round(t / 100)));
    console.log("  " + ms(t) + "  (+" + ms(gap).trim() + ")  " + n.padEnd(30) + " " + bar);
  });

  const first = rows.find(r => r[0] === "FIRST CONTENT READABLE");
  console.log("\n  " + (first
    ? "TIME TO FIRST READABLE CONTENT: " + Math.round(first[1]) + "ms"
    : "NOTHING EVER BECAME READABLE — this is the blank-page failure."));
  console.log("");
  await browser.close();
  process.exit(first ? 0 : 1);
})().catch(e => { console.error("harness error:", e.message); process.exit(1); });
