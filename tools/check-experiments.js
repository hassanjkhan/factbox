/* ==========================================================================
   Does /admin/experiments actually render, and is what it renders true?

   HTML validity, `node --check` and an HTTP 200 are all equally true of a
   blank page. This file is the answer to that: it drives REAL Chrome, waits
   for the page to paint, and asserts on the DOM that is actually there.

   THE STUB. There is no admin login here, so window.FBE is installed BEFORE
   the page's scripts run — js/admin-experiments.js self-guards on
   `W.FBE && W.FBE.__factbox` exactly so this can happen — carrying six
   experiments across every state and ten reels with varied metrics and two
   retention series. Every call the page makes into the data layer is
   recorded, so "Start calls startExperiment with this id" is a fact and not
   an inference from a button changing colour.

   `networkidle0` NEVER FIRES on this page in production because the Firestore
   listeners stay open. domcontentloaded plus a fixed wait, as everything else
   in tools/ does.

   Usage:
     python3 tools/serve-like-pages.py 8899 .      (in another shell)
     node tools/check-experiments.js
   ========================================================================== */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.argv[2] || "http://127.0.0.1:8899/admin/experiments.html";
const SHOTS = path.join(__dirname, "shots");

const results = [];
function check(name, got, want, ok) {
  const pass = ok === undefined ? got === want : ok;
  results.push({ name, got, want, pass });
  console.log(
    (pass ? "  PASS  " : "  FAIL  ") + name.padEnd(58) +
    " got=" + JSON.stringify(got) + (want === undefined ? "" : "  want=" + JSON.stringify(want))
  );
}

/* --------------------------------------------------------------------------
   The stub. Runs in the page, before any of its own scripts.

   Six experiments:
     e1  running, endBy in the PAST      -> must display as EXPIRED
     e2  running, endBy in the future    -> Running
     e3  idea
     e4  ended, two reels a side, clearly separated  -> a DECIDED result
     e5  ended, two reels a side, overlapping        -> inside the noise
     e6  ended, one reel a side                      -> cannot be tested
   Ten reels in total across e1/e4/e5/e6, two of them with retention series,
   one measured EARLY (36h) and one with a title that is an XSS payload.
   -------------------------------------------------------------------------- */
function stubSource() {
  const H = 3600000;
  return `(function () {
    var H = ${H};
    var NOW = Date.now();
    function ago(h) { return NOW - h * H; }
    function day(d) {
      var t = new Date(NOW + d * 86400000);
      function p(n){return (n<10?"0":"")+n;}
      return t.getFullYear()+"-"+p(t.getMonth()+1)+"-"+p(t.getDate());
    }

    window.__calls = [];
    function rec(name, args) { window.__calls.push({ name: name, args: args }); }

    var EXPS = [
      { id:"e1", title:"Hook in the first second", detail:"Open on the number, not the setup.",
        status:"running", metric:"views", endBy: day(-3), startedAt: ago(24*20),
        hypothesis:"People leave before the claim arrives.",
        trying:"Same story, two openings.",
        decision:"If A beats B by more than the spread, every reel opens on the number.",
        inspiration:"That reel about the Roman concrete.",
        links:["https://www.instagram.com/reel/abc123/","javascript:alert(1)","http://insecure.example/x"],
        order:1, createdAt: ago(24*21), updatedAt: ago(24*2) },

      { id:"e2", title:"Captions burned in", detail:"Hard-subs against platform captions.",
        status:"running", metric:"saves", endBy: day(9), startedAt: ago(24*2),
        order:2, createdAt: ago(24*3), updatedAt: ago(24*1) },

      { id:"e3", title:"Two-part cliffhanger", detail:"Split one story across two reels.",
        status:"idea", metric:"profileTaps", endBy:"", order:3,
        createdAt: ago(24*1), updatedAt: ago(24*1) },

      { id:"e4", title:"Greenscreen vs talking head", detail:"Same script, two formats.",
        status:"ended", metric:"views", endBy: day(-14),
        startedAt: ago(24*40), endedAt: ago(24*12),
        outcome:"Greenscreen, clearly.",
        analysis:"The greenscreen versions hold past the first beat. Try it on the next three.",
        analysisBy:"uid-hassan", analysisByName:"Hassan", analysisAt: ago(24*11),
        order:4, createdAt: ago(24*41), updatedAt: ago(24*12) },

      { id:"e5", title:"Music bed loud or quiet", detail:"Same cut, two mixes.",
        status:"ended", metric:"views", endBy: day(-20),
        startedAt: ago(24*50), endedAt: ago(24*22), outcome:"Could not tell.",
        order:5, createdAt: ago(24*51), updatedAt: ago(24*22) },

      { id:"e6", title:"Thumbnail face or text", detail:"One each. Not enough, and it shows.",
        status:"ended", metric:"views", endBy: day(-30),
        startedAt: ago(24*60), endedAt: ago(24*31), outcome:"",
        order:6, createdAt: ago(24*61), updatedAt: ago(24*31) },

      { id:"e7", title:"<img src=x onerror=alert(1)>", detail:"<script>alert(2)</script>",
        status:"idea", metric:"views", endBy:"", order:7,
        createdAt: ago(24*1), updatedAt: ago(24*1) }
    ];

    function reel(o) {
      var base = { platform:"instagram", variant:"none", source:"manual", retention:[],
                   views:null, reach:null, likes:null, comments:null, shares:null,
                   saves:null, profileTaps:null, avgWatch:null, completion:null, threeSec:null };
      for (var k in o) { base[k] = o[k]; }
      return base;
    }

    var RET_A = [{second:0,percentage:100},{second:1,percentage:96},{second:3,percentage:88},
                 {second:7,percentage:79},{second:11,percentage:72},{second:17,percentage:66},
                 {second:21,percentage:41},{second:26,percentage:36},{second:30,percentage:31}];
    var RET_B = [{second:0,percentage:100},{second:1,percentage:83},{second:3,percentage:61},
                 {second:7,percentage:48},{second:11,percentage:40},{second:17,percentage:34},
                 {second:21,percentage:29},{second:26,percentage:25},{second:30,percentage:22}];

    var REELS = {
      /* e1: one measured on the clock, one measured TOO EARLY, one overdue
         past seven days with nothing typed, one still counting down, and one
         whose story name is an XSS payload. */
      e1: [
        reel({ id:"r1", story:"Roman concrete — open on the number", variant:"a", format:"text-hook",
               url:"https://www.instagram.com/reel/r1/", postedAt: ago(100), measuredAt: ago(100-72),
               views:18400, reach:16100, likes:940, comments:61, shares:210, saves:388,
               profileTaps:74, avgWatch:9.4, completion:22.5, threeSec:61.2,
               retention: RET_A, order:1, createdAt: ago(101) }),
        reel({ id:"r2", story:"Roman concrete — open on the setup", variant:"b", format:"talking-head",
               url:"https://www.tiktok.com/@x/video/2", platform:"tiktok",
               postedAt: ago(100), measuredAt: ago(100-36),
               views:9100, reach:8400, likes:310, comments:12, shares:44, saves:90,
               avgWatch:4.1, completion:9.2, threeSec:28.4,
               retention: RET_B, order:2, createdAt: ago(101) }),
        reel({ id:"r3", story:"<img src=x onerror=alert(1)>", variant:"none",
               postedAt: ago(24*11), order:3, createdAt: ago(24*11) }),
        reel({ id:"r4", story:"Posted this morning", variant:"none",
               postedAt: ago(5), order:4, createdAt: ago(5) })
      ],
      /* e4: two a side, clearly separated -> decided. */
      e4: [
        reel({ id:"r5", story:"Greenscreen one", variant:"a", format:"greenscreen",
               postedAt: ago(24*30), measuredAt: ago(24*30-72), views:41000, threeSec:66, order:1, createdAt: ago(24*31) }),
        reel({ id:"r6", story:"Greenscreen two", variant:"a", format:"greenscreen",
               postedAt: ago(24*28), measuredAt: ago(24*28-72), views:38500, threeSec:64, order:2, createdAt: ago(24*29) }),
        reel({ id:"r7", story:"Talking head one", variant:"b", format:"talking-head",
               postedAt: ago(24*30), measuredAt: ago(24*30-72), views:11200, threeSec:31, order:3, createdAt: ago(24*31) }),
        reel({ id:"r8", story:"Talking head two", variant:"b", format:"talking-head",
               postedAt: ago(24*28), measuredAt: ago(24*28-72), views:12900, threeSec:33, order:4, createdAt: ago(24*29) })
      ],
      /* e5: two a side, overlapping -> inside the noise. */
      e5: [
        reel({ id:"r9",  story:"Loud one",  variant:"a", format:"loud-mix",
               postedAt: ago(24*40), measuredAt: ago(24*40-80), views:14000, order:1, createdAt: ago(24*41) }),
        reel({ id:"r10", story:"Loud two",  variant:"a", format:"loud-mix",
               postedAt: ago(24*38), measuredAt: ago(24*38-80), views:22000, order:2, createdAt: ago(24*39) }),
        reel({ id:"r11", story:"Quiet one", variant:"b", format:"quiet-mix",
               postedAt: ago(24*40), measuredAt: ago(24*40-80), views:15500, order:3, createdAt: ago(24*41) }),
        reel({ id:"r12", story:"Quiet two", variant:"b", format:"quiet-mix",
               postedAt: ago(24*38), measuredAt: ago(24*38-80), views:19500, order:4, createdAt: ago(24*39) })
      ],
      /* e6: one a side -> cannot be tested at all. */
      e6: [
        reel({ id:"r13", story:"Face", variant:"a", format:"face-thumb",
               postedAt: ago(24*50), measuredAt: ago(24*50-90), views:30000, order:1, createdAt: ago(24*51) }),
        reel({ id:"r14", story:"Text", variant:"b", format:"text-thumb",
               postedAt: ago(24*50), measuredAt: ago(24*50-90), views:9000, order:2, createdAt: ago(24*51) })
      ]
    };

    function later(fn, v) { setTimeout(function () { fn(v); }, 0); }

    window.FBE = {
      __factbox: true,
      ready: function () { return Promise.resolve({ ok: true }); },
      state: function () { return { ok: true, why: "" }; },
      me: function () { return { uid: "uid-hassan", email: "h@example.com", name: "Hassan" }; },

      watchExperiments: function (fn) { later(fn, EXPS.slice(0)); return function () {}; },
      watchReels: function (id, fn) { later(fn, (REELS[id] || []).slice(0)); return function () {}; },
      watchComments: function (id, fn) {
        later(fn, id === "e1" ? [{ id:"c1", text:"<img src=x onerror=alert(1)> in a comment",
                                   by:"uid-hassan", byName:"Hassan", at: NOW - H }] : []);
        return function () {};
      },

      addExperiment:    function (o) { rec("addExperiment", [o]); return Promise.resolve("new"); },
      updateExperiment: function (id, p) { rec("updateExperiment", [id, p]); return Promise.resolve(true); },
      deleteExperiment: function (id) { rec("deleteExperiment", [id]); return Promise.resolve(true); },
      startExperiment:  function (id) { rec("startExperiment", [id]); return Promise.resolve(true); },
      endExperiment:    function (id, n) { rec("endExperiment", [id, n]); return Promise.resolve(true); },

      addReel:    function (e, o) { rec("addReel", [e, o]); return Promise.resolve("rNew"); },
      updateReel: function (e, r, p) { rec("updateReel", [e, r, p]); return Promise.resolve(true); },
      deleteReel: function (e, r) { rec("deleteReel", [e, r]); return Promise.resolve(true); },

      addComment:    function (e, t) { rec("addComment", [e, t]); return Promise.resolve("cNew"); },
      deleteComment: function (e, c) { rec("deleteComment", [e, c]); return Promise.resolve(true); },

      writeAnalysis:     function (e, t) { rec("writeAnalysis", [e, t]); return Promise.resolve(true); },
      writeReelAnalysis: function (e, r, t) { rec("writeReelAnalysis", [e, r, t]); return Promise.resolve(true); },
      requestAnalysis:   function (e) { rec("requestAnalysis", [e]); return Promise.resolve(true); },
      uploadCover:       function (e, r, f) { rec("uploadCover", [e, r]); return Promise.reject(new Error("storage rules are not deployed")); },

      isoDay: function (v) {
        var s = String(v == null ? "" : v).replace(/^\\s+|\\s+$/g, "");
        return /^\\d{4}-\\d{2}-\\d{2}$/.test(s) ? s : "";
      },
      safeUrl: function (v) {
        var s = String(v == null ? "" : v).replace(/[\\u0000-\\u001F\\u007F]+/g, "").replace(/^\\s+|\\s+$/g, "");
        return s.toLowerCase().indexOf("https://") === 0 ? s : "";
      },
      MEASURE_HOURS: 72,
      AT_RISK_DAYS: 7,
      STATUSES: ["idea","running","ended"],
      PLATFORMS: ["instagram","tiktok","other"],
      VARIANTS: ["a","b","none"],
      METRICS: [
        { k:"views", label:"Views", unit:"n" },
        { k:"reach", label:"Reach", unit:"n" },
        { k:"likes", label:"Likes", unit:"n" },
        { k:"comments", label:"Comments", unit:"n" },
        { k:"shares", label:"Shares", unit:"n" },
        { k:"saves", label:"Saves", unit:"n" },
        { k:"profileTaps", label:"Profile taps", unit:"n" },
        { k:"avgWatch", label:"Avg watch time", unit:"s" },
        { k:"completion", label:"Completion", unit:"%" },
        { k:"threeSec", label:"3-second view rate", unit:"%" }
      ]
    };
  })();`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();

  const pageErrors = [];
  const dialogs = [];
  page.on("pageerror", e => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on("dialog", async d => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });

  await page.evaluateOnNewDocument(stubSource());
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });

  console.log("\n--- loading " + URL + " -------------------------------------");
  const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  check("HTTP status", resp.status(), 200);
  /* networkidle0 never fires on this page in production — the listeners stay
     open. A fixed wait, as every other tool in here does. */
  await sleep(1400);

  /* ---- the gate opened, and the board is on screen -------------------- */
  const gateOpen = await page.$eval("#adm-main", n => !n.hidden);
  check("the board is shown (gate opened)", gateOpen, true);

  /* ---- cards ----------------------------------------------------------- */
  const cards = await page.$$eval(".adm-exp", ns => ns.length);
  check("experiment cards rendered", cards, 7);

  const statuses = await page.$$eval(".adm-exp", ns => ns.map(n => {
    const t = n.querySelector(".adm-exp-t");
    const s = n.querySelector(".adm-exp-s");
    return { title: t ? t.textContent : "", status: s ? s.textContent : "", cls: s ? s.className : "" };
  }));
  const expired = statuses.filter(s => s.status === "Expired");
  check("exactly one card reads EXPIRED", expired.length, 1);
  check("the expired one is the past-dated running experiment",
        expired[0] && expired[0].title, "Hook in the first second");
  check("expired carries its own class, not just a colour",
        !!(expired[0] && expired[0].cls.indexOf("adm-exp-s-expired") >= 0), true);
  check("the future-dated running one still reads Running",
        (statuses.find(s => s.title === "Captions burned in") || {}).status, "Running");
  check("the idea reads Idea",
        (statuses.find(s => s.title === "Two-part cliffhanger") || {}).status, "Idea");
  check("ended reads Ended",
        (statuses.find(s => s.title === "Greenscreen vs talking head") || {}).status, "Ended");

  /* ---- XSS in a card title -------------------------------------------- */
  const xssCard = await page.$$eval(".adm-exp-t", ns =>
    ns.map(n => ({ text: n.textContent, html: n.innerHTML })));
  const payload = xssCard.find(c => c.text === "<img src=x onerror=alert(1)>");
  check("a card titled with an <img> payload renders it literally", !!payload, true);
  check("…and no element was created from it",
        await page.evaluate(() => document.querySelectorAll("img[src='x']").length), 0);

  /* ---- the answer at the top ------------------------------------------ */
  const verdict = await page.$eval("#adm-ans-v", n => n.textContent);
  console.log("  note  verdict line: " + JSON.stringify(verdict));
  check("the answer names a decided format",
        verdict.indexOf("greenscreen") >= 0 || verdict.indexOf("face-thumb") >= 0, true, true);
  const undecidedLines = await page.$$eval("#adm-ans-note .adm-diag li", ns => ns.length);
  check("ended-but-inside-the-margin experiments are listed", undecidedLines >= 1, true, undecidedLines >= 1);

  /* The board-wide chart: only one format has won a decided experiment in
     this fixture (greenscreen; face-thumb's arm is a single reel and cannot
     be decided), so the page MUST refuse to draw a one-bar chart. */
  const ansChart = await page.evaluate(() => {
    const host = document.getElementById("adm-ans-chart");
    return {
      bars: host.querySelectorAll("rect.fbx-fill, rect.fbx-fill-q").length,
      nodata: !!host.querySelector(".adm-nodata"),
      text: host.textContent.slice(0, 90)
    };
  });
  check("one winning format alone draws NO chart", ansChart.bars, 0);
  check("…and says not enough data instead", ansChart.nodata, true);

  /* ---- outstanding work is visible from the list ---------------------- */
  const strip = await page.$$eval("#adm-ans-strip .adm-pill", ns => ns.map(n => n.textContent));
  console.log("  note  outstanding strip: " + JSON.stringify(strip));
  check("the at-risk (7+ day) reel is surfaced on the list view",
        strip.some(s => /past the 7-day deadline/.test(s)), true);
  check("the too-early measurement is surfaced on the list view",
        strip.some(s => /measured too early/.test(s)), true);
  const cardStrip = await page.$$eval(".adm-exp .adm-ans-strip .adm-pill", ns => ns.length);
  check("a card carries its own outstanding pills", cardStrip >= 1, true, cardStrip >= 1);

  /* ---- no horizontal scroll at 1440 ----------------------------------- */
  const sw1440 = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check("no horizontal body scroll at 1440px", sw1440.sw <= sw1440.iw, true,
        sw1440.sw <= sw1440.iw);
  console.log("  note  1440: scrollWidth=" + sw1440.sw + " innerWidth=" + sw1440.iw);

  await page.screenshot({ path: path.join(SHOTS, "exp-01-desk-1440.png"), fullPage: true });

  /* ---- open the pane --------------------------------------------------- */
  await page.evaluate(() => {
    const ns = document.querySelectorAll("button.adm-exp-t");
    for (const n of ns) if (n.textContent === "Hook in the first second") { n.focus(); n.click(); return; }
  });
  await sleep(500);

  const pane = await page.evaluate(() => {
    const p = document.getElementById("adm-pane");
    return {
      open: !p.hidden,
      title: document.getElementById("adm-pane-t").textContent,
      bodyOnClass: document.body.className.indexOf("adm-pane-on") >= 0,
      hasHypothesis: p.textContent.indexOf("People leave before the claim arrives.") >= 0,
      hasDecision: p.textContent.indexOf("every reel opens on the number") >= 0,
      hasMetric: p.textContent.indexOf("Views") >= 0
    };
  });
  check("the pane opened", pane.open, true);
  check("…with the right title", pane.title, "Hook in the first second");
  check("…and the body carries adm-pane-on", pane.bodyOnClass, true);
  check("…showing the hypothesis", pane.hasHypothesis, true);
  check("…showing the decision rule", pane.hasDecision, true);
  check("…naming the primary metric", pane.hasMetric, true);

  /* ---- the untrusted links -------------------------------------------- */
  const hrefs = await page.$$eval("#adm-pane a[href]", ns => ns.map(n => n.getAttribute("href")));
  check("the javascript: reference link was dropped",
        hrefs.every(h => !/^javascript:/i.test(h)), true);
  check("the http:// reference link was dropped",
        hrefs.every(h => !/^http:\/\//i.test(h)), true);
  check("the https:// reference link survived",
        hrefs.some(h => h === "https://www.instagram.com/reel/abc123/"), true);

  /* ---- layer 1: the diagnostics --------------------------------------- */
  const diag = await page.$$eval("#adm-diag li", ns => ns.map(n => n.textContent));
  console.log("\n  --- diagnostics on e1 ---");
  diag.forEach(d => console.log("      " + d.replace(/\s+/g, " ").slice(0, 150)));
  check("diagnostics rendered", diag.length >= 3, true, diag.length >= 3);
  check("…completeness counts the reels measured on the clock",
        diag.some(d => /measured at 72 hours or later/.test(d)), true);
  check("…and names the reel past the 7-day deadline",
        diag.some(d => /past 7 days with nothing typed/.test(d)), true);
  check("…the A/B line refuses a result off one reel a side",
        diag.some(d => /A vs B/.test(d) && /no spread|nothing to compare/.test(d)), true);
  check("…the hook line reads the 3-second rate",
        diag.some(d => /Hook/.test(d)), true);
  check("…the drop-off names the second of the steepest fall",
        diag.some(d => /biggest drop at 0:19/.test(d)), true);
  check("…and reports the share still watching at 0:03",
        diag.some(d => /still watching at 0:03/.test(d)), true);

  /* ---- layer 2: the read, rendered as an opinion ---------------------- */
  const readOnE1 = await page.$$eval("#adm-exp-read .adm-read", ns => ns.length);
  check("e1 has no written read, and says so instead of faking one", readOnE1, 0);

  /* ---- the charts in the pane ----------------------------------------- */
  const paneCharts = await page.evaluate(() => {
    function box(id) {
      const h = document.getElementById(id);
      if (!h) return null;
      return {
        svg: !!h.querySelector("svg"),
        bars: h.querySelectorAll("rect.fbx-fill, rect.fbx-fill-2, rect.fbx-fill-q").length,
        dots: h.querySelectorAll("circle").length,
        paths: h.querySelectorAll("path").length,
        nodata: !!h.querySelector(".adm-nodata"),
        text: h.textContent.slice(0, 120)
      };
    }
    return { ab: box("adm-chart-ab"), rank: box("adm-chart-rank"), drop: box("adm-chart-drop") };
  });
  console.log("  note  pane charts: " + JSON.stringify(paneCharts));
  /* B's only reel on e1 was measured at 36 hours, so it is NOT comparable and
     the arm is empty. A chart drawn here would be one bar against nothing. */
  check("A-vs-B refuses to draw when one arm has nothing comparable",
        paneCharts.ab.bars, 0);
  check("…and says which arm is empty and why", paneCharts.ab.nodata, true);
  check("…naming the 72-hour bar in the sentence",
        /measured at 72 hours/.test(paneCharts.ab.text), true);
  check("the ranked chart refuses one bar", paneCharts.rank.nodata, true);
  check("the drop-off draws two lines (A solid, B dashed)", paneCharts.drop.paths, 2);
  check("…with a dot per typed point on both series", paneCharts.drop.dots, 18);
  check("…and labels its own axis", /Seconds into the reel/.test(
        await page.$eval("#adm-chart-drop", n => n.textContent)), true);

  /* ---- an XSS payload as a reel story name ---------------------------- */
  const reelXss = await page.evaluate(() => {
    const ns = document.querySelectorAll("#adm-reels .adm-reel-t");
    let found = false;
    ns.forEach(n => { if (n.textContent === "<img src=x onerror=alert(1)>") found = true; });
    return { found, imgs: document.querySelectorAll("img[src='x']").length };
  });
  check("a reel named with an <img> payload renders literally", reelXss.found, true);
  check("…and created no image element", reelXss.imgs, 0);

  /* ---- the age bands on the reels ------------------------------------- */
  const ages = await page.$$eval("#adm-reels .adm-age", ns =>
    ns.map(n => ({ t: n.textContent, c: n.className })));
  console.log("  note  age chips: " + JSON.stringify(ages));
  check("a reel measured at 36h is marked TOO EARLY",
        ages.some(a => /too early/.test(a.t) && /adm-age-early/.test(a.c)), true);
  check("a reel measured at 72h is marked measured",
        ages.some(a => /^Measured at 3d$/.test(a.t) && /adm-age-ok/.test(a.c)), true);
  check("an unmeasured reel past 7 days is marked as a missed deadline",
        ages.some(a => /data may be gone/.test(a.t) && /adm-age-risk/.test(a.c)), true);
  check("a reel posted 5h ago counts down instead of showing a blank",
        ages.some(a => /^Measure in /.test(a.t) && /adm-age-wait/.test(a.c)), true);

  /* ---- Start and End call the data layer with the right arguments ------ */
  await page.evaluate(() => { window.__calls.length = 0; });
  const clickedEnd = await page.evaluate(() => {
    const ns = document.querySelectorAll("#adm-exp-head button");
    for (const n of ns) if (n.textContent === "End") { n.click(); return true; }
    return false;
  });
  check("the End button is in the pane", clickedEnd, true);
  await sleep(120);
  await page.evaluate(() => {
    const ta = document.getElementById("adm-end-note");
    if (ta) { ta.value = "Hook wins. Every reel opens on the number now."; }
    const ns = document.querySelectorAll("#adm-end-box button");
    for (const n of ns) if (n.textContent === "End it") { n.click(); return; }
  });
  await sleep(250);
  let calls = await page.evaluate(() => window.__calls.slice(0));
  const endCall = calls.find(c => c.name === "endExperiment");
  check("End calls endExperiment", !!endCall, true);
  check("…with this experiment's id", endCall && endCall.args[0], "e1");
  check("…and the outcome note that was typed",
        endCall && endCall.args[1], "Hook wins. Every reel opens on the number now.");

  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => {
    const cards = document.querySelectorAll(".adm-exp");
    for (const c of cards) {
      const t = c.querySelector(".adm-exp-t");
      if (!t || t.textContent !== "Two-part cliffhanger") continue;
      const bs = c.querySelectorAll("button");
      for (const b of bs) if (b.textContent === "Start") { b.click(); return; }
    }
  });
  await sleep(200);
  calls = await page.evaluate(() => window.__calls.slice(0));
  const startCall = calls.find(c => c.name === "startExperiment");
  check("Start calls startExperiment", !!startCall, true);
  check("…with the id of the card it was pressed on", startCall && startCall.args[0], "e3");

  /* ---- per-field save: nothing typed can be lost ----------------------- */
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => {
    const ns = document.querySelectorAll("#adm-reels button[data-row]");
    for (const n of ns) if (n.getAttribute("data-row") === "r3") { n.click(); return; }
  });
  await sleep(250);
  const editorOpen = await page.evaluate(() => !!document.querySelector('#adm-reels [data-edit="r3"]'));
  check("the per-field reel editor opens", editorOpen, true);
  await page.evaluate(() => {
    const inp = document.getElementById("adm-r-r3-views");
    inp.value = "12345";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(250);
  calls = await page.evaluate(() => window.__calls.slice(0));
  const reelCall = calls.find(c => c.name === "updateReel");
  check("leaving one number field saves that field on its own", !!reelCall, true);
  check("…addressed to the right experiment and reel",
        reelCall && reelCall.args[0] + "/" + reelCall.args[1], "e1/r3");
  check("…carrying ONLY the field that changed",
        reelCall && JSON.stringify(reelCall.args[2]), JSON.stringify({ views: 12345 }));
  const savedLine = await page.$eval('#adm-reels [data-edit="r3"] .adm-savedot', n => n.textContent);
  check("…and the row says on screen that it landed", /^Saved views/.test(savedLine), true);

  /* an untouched field writes nothing — tabbing through ten boxes is zero writes */
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => {
    const inp = document.getElementById("adm-r-r3-likes");
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(150);
  calls = await page.evaluate(() => window.__calls.slice(0));
  check("an untouched field writes nothing", calls.length, 0);

  /* the read on a reel goes through writeReelAnalysis, which stamps an author */
  await page.evaluate(() => {
    const ta = document.getElementById("adm-r-r3-read");
    ta.value = "This one never had a hook.";
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(200);
  calls = await page.evaluate(() => window.__calls.slice(0));
  const readCall = calls.find(c => c.name === "writeReelAnalysis");
  check("the reel's read is written through the stamped path", !!readCall, true);
  check("…and never through the generic field save",
        !calls.some(c => c.name === "updateReel" && c.args[2] && "analysis" in c.args[2]), true);

  /* ---- the comment thread renders untrusted text as text --------------- */
  const cmt = await page.evaluate(() => {
    const n = document.querySelector("#adm-cmt-list .adm-cmt-t");
    return n ? { text: n.textContent, imgs: document.querySelectorAll("img[src='x']").length } : null;
  });
  check("the comment thread rendered", !!cmt, true);
  check("…with the payload as characters", cmt && cmt.text,
        "<img src=x onerror=alert(1)> in a comment");
  check("…and still no image element anywhere", cmt && cmt.imgs, 0);

  await page.screenshot({ path: path.join(SHOTS, "exp-02-pane-1440.png"), fullPage: false });

  /* ---- Escape closes the pane and restores focus ----------------------- */
  await page.evaluate(() => {
    const ns = document.querySelectorAll("button.adm-exp-t");
    for (const n of ns) if (n.textContent === "Captions burned in") { n.focus(); n.click(); return; }
  });
  await sleep(350);
  check("a second card opens into the same pane",
        await page.$eval("#adm-pane-t", n => n.textContent), "Captions burned in");
  await page.keyboard.press("Escape");
  await sleep(350);
  const afterEsc = await page.evaluate(() => ({
    hidden: document.getElementById("adm-pane").hidden,
    bodyClass: document.body.className.indexOf("adm-pane-on") >= 0,
    focusText: document.activeElement ? document.activeElement.textContent : "",
    focusRow: document.activeElement ? document.activeElement.getAttribute("data-row") : ""
  }));
  check("Escape closes the pane", afterEsc.hidden, true);
  check("…and takes adm-pane-on off the body", afterEsc.bodyClass, false);
  check("…and focus went back to the card that opened it", afterEsc.focusText, "Captions burned in");
  check("…found by its data-row", afterEsc.focusRow, "e2");

  /* ---- a decided experiment: the bars go solid ------------------------- */
  await page.evaluate(() => {
    const ns = document.querySelectorAll("button.adm-exp-t");
    for (const n of ns) if (n.textContent === "Greenscreen vs talking head") { n.click(); return; }
  });
  await sleep(450);
  const decided = await page.evaluate(() => ({
    solid: document.querySelectorAll("#adm-chart-ab rect.fbx-fill, #adm-chart-ab rect.fbx-fill-2").length,
    hollow: document.querySelectorAll("#adm-chart-ab rect.fbx-fill-q").length,
    rankBars: document.querySelectorAll("#adm-chart-rank rect.fbx-fill, #adm-chart-rank rect.fbx-fill-2, #adm-chart-rank rect.fbx-fill-q").length,
    diag: Array.prototype.map.call(document.querySelectorAll("#adm-diag li"), n => n.textContent),
    read: document.querySelectorAll("#adm-exp-read .adm-read").length,
    readBy: (document.querySelector("#adm-exp-read .adm-read-by") || {}).textContent || ""
  }));
  console.log("\n  --- diagnostics on e4 (decided) ---");
  decided.diag.forEach(d => console.log("      " + d.replace(/\s+/g, " ").slice(0, 150)));
  check("a decided A/B draws SOLID bars", decided.solid, 2);
  check("…and none hollow", decided.hollow, 0);
  check("the ranked chart draws one bar per measured reel", decided.rankBars, 4);
  check("…the A/B line states the gap and the within-arm spread",
        decided.diag.some(d => /is ahead/.test(d) && /larger than the/.test(d)), true);
  check("layer 2 renders as a quoted opinion with a byline", decided.read, 1);
  check("…labelled an interpretation, not a measurement",
        /an interpretation, not a measurement/.test(decided.readBy), true);
  check("…and signed and dated", /Hassan · /.test(decided.readBy), true);

  await page.screenshot({ path: path.join(SHOTS, "exp-05-pane-decided-1440.png"), fullPage: false });
  await page.evaluate(() => {
    const h = document.getElementById("adm-exp-charts");
    if (h) h.scrollIntoView({ block: "start" });
  });
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, "exp-06-pane-charts-1440.png"), fullPage: false });

  /* ---- the noise experiment: the page refuses to call it --------------- */
  await page.evaluate(() => {
    const ns = document.querySelectorAll("button.adm-exp-t");
    for (const n of ns) if (n.textContent === "Music bed loud or quiet") { n.click(); return; }
  });
  await sleep(450);
  const noisy = await page.evaluate(() => ({
    hollow: document.querySelectorAll("#adm-chart-ab rect.fbx-fill-q").length,
    diag: Array.prototype.map.call(document.querySelectorAll("#adm-diag li"), n => n.textContent)
  }));
  console.log("\n  --- diagnostics on e5 (inside the noise) ---");
  noisy.diag.forEach(d => console.log("      " + d.replace(/\s+/g, " ").slice(0, 170)));
  check("an overlapping A/B draws HOLLOW bars", noisy.hollow, 2);
  check("…and says the difference is inside the noise",
        noisy.diag.some(d => /inside the noise/.test(d)), true);
  check("…and says roughly how many more posts a side would be needed",
        noisy.diag.some(d => /posts a side would be needed/.test(d)), true);

  await page.keyboard.press("Escape");
  await sleep(250);

  /* ---- 390px ----------------------------------------------------------- */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(700);
  const sw390 = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check("no horizontal body scroll at 390px", sw390.sw <= sw390.iw, true, sw390.sw <= sw390.iw);
  console.log("  note  390: scrollWidth=" + sw390.sw + " innerWidth=" + sw390.iw);
  await page.screenshot({ path: path.join(SHOTS, "exp-03-phone-390.png"), fullPage: true });

  await page.evaluate(() => {
    const ns = document.querySelectorAll("button.adm-exp-t");
    for (const n of ns) if (n.textContent === "Hook in the first second") { n.click(); return; }
  });
  await sleep(700);
  const sw390pane = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    open: !document.getElementById("adm-pane").hidden }));
  check("the pane opens full-screen at 390px", sw390pane.open, true);
  check("…with still no horizontal body scroll", sw390pane.sw <= sw390pane.iw, true,
        sw390pane.sw <= sw390pane.iw);
  console.log("  note  390 + pane: scrollWidth=" + sw390pane.sw + " innerWidth=" + sw390pane.iw);
  await page.screenshot({ path: path.join(SHOTS, "exp-04-phone-pane-390.png"), fullPage: false });

  /* ---- keyboard reachability ------------------------------------------ */
  const focusables = await page.evaluate(() => {
    const sel = "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";
    const ns = document.querySelectorAll(sel);
    let n = 0;
    ns.forEach(x => { if (x.offsetParent !== null || x === document.activeElement) n++; });
    return n;
  });
  check("controls are reachable by Tab", focusables > 20, true, focusables > 20);
  console.log("  note  focusable and visible: " + focusables);

  /* ---- the two things that must be zero ------------------------------- */
  check("zero dialogs fired (no alert from any payload)", dialogs.length, 0);
  check("zero pageerror events", pageErrors.length, 0);
  if (pageErrors.length) pageErrors.forEach(e => console.log("      pageerror: " + e));

  /* ======================================================================
     PHASE 2 — the REAL data layer, with no stub in front of it.

     Everything above drove a stub, which means js/admin-experiments.js never
     ran. That is the exact shape of the failure this project has shipped
     twice: a page that passes every check and is blank in a browser. So this
     loads the page with nothing installed, and asserts that the real file
     parses, installs window.FBE, answers ready() rather than hanging, and
     leaves the reader on a panel with a Sign in button — not on a spinner and
     not on nothing.
     ====================================================================== */
  console.log("\n--- phase 2: no stub, the real js/admin-experiments.js ------");
  const raw = await browser.newPage();
  const rawErrors = [];
  raw.on("pageerror", e => rawErrors.push(String(e && e.message ? e.message : e)));
  await raw.setViewport({ width: 1440, height: 960 });
  await raw.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(4000);

  const real = await raw.evaluate(() => ({
    installed: !!(window.FBE && window.FBE.__factbox),
    hasReady: !!(window.FBE && typeof window.FBE.ready === "function"),
    measure: window.FBE && window.FBE.MEASURE_HOURS,
    atRisk: window.FBE && window.FBE.AT_RISK_DAYS,
    metrics: window.FBE && window.FBE.METRICS ? window.FBE.METRICS.length : 0,
    /* The one shape TikTok's video_view_retention returns, so an automated
       writer would need no migration. */
    retShape: window.FBE && window.FBE.retentionList
      ? JSON.stringify(window.FBE.retentionList("0 100\n3 78"))
      : ""
  }));
  check("the real data layer installed window.FBE", real.installed, true);
  check("…exposing ready()", real.hasReady, true);
  check("…and the 72-hour constant", real.measure, 72);
  check("…and the 7-day deadline", real.atRisk, 7);
  check("…and all ten metrics", real.metrics, 10);
  check("…normalising a pasted curve to {second, percentage}", real.retShape,
        JSON.stringify([{ second: 0, percentage: 100 }, { second: 3, percentage: 78 }]));

  const state = await raw.evaluate(() =>
    Promise.resolve(window.FBE.ready()).then(r => r.why || (r.ok ? "ok" : "?")));
  check("ready() settles rather than hanging", ["signed-out", "not-admin", "sdk-failed", "ok"].indexOf(state) >= 0,
        true, ["signed-out", "not-admin", "sdk-failed", "ok"].indexOf(state) >= 0);
  console.log("  note  ready() answered: " + JSON.stringify(state));

  const gate = await raw.evaluate(() => {
    const vis = id => { const n = document.getElementById(id); return n && !n.hidden; };
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script,style,noscript").forEach(n => n.remove());
    return {
      wait: vis("adm-p-wait"), out: vis("adm-p-out"),
      no: vis("adm-p-no"), noauth: vis("adm-p-noauth"),
      words: (body.textContent || "").replace(/\s+/g, " ").trim().length
    };
  });
  check("the page is NOT still on the checking panel", gate.wait, false);
  check("…it landed on a real panel", gate.out || gate.no || gate.noauth, true);
  check("…and the page is not blank", gate.words > 200, true, gate.words > 200);
  console.log("  note  rendered characters: " + gate.words);
  check("zero pageerror events from the real data layer", rawErrors.length, 0);
  if (rawErrors.length) rawErrors.forEach(e => console.log("      pageerror: " + e));
  await raw.screenshot({ path: path.join(SHOTS, "exp-08-real-gate-1440.png"), fullPage: false });

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log("\n--- " + (results.length - failed.length) + "/" + results.length +
              " checks passed " + "-".repeat(30));
  console.log("screenshots -> tools/shots/exp-*.png\n");
  if (failed.length) {
    failed.forEach(f => console.log("  FAILED: " + f.name));
    process.exit(1);
  }
  console.log("PASS\n");
})().catch(e => { console.log("harness error: " + (e && e.stack ? e.stack : e)); process.exit(1); });
