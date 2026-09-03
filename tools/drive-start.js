/* Drives the onboarding in real Chrome and asserts, with numbers.

   IT DRIVES /join, NOT /start. The onboarding used to be six questions on
   /start that handed over to four more on /join; it is now eleven screens on
   /join and /start is a door. js/start.js is still the engine — the name is
   load-bearing, because five of the guards in check-analytics.js read that
   path — so this file keeps its name too.

   node drive-start.js   (from the repo's tools/ directory) */
const puppeteer = require("puppeteer-core");
const http = require("http");
const fs = require("fs");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8899";
const W = 430, H = 932;

let fails = 0;
function ok(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail === undefined ? "" : "  [" + detail + "]"));
  if (!cond) fails++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function head(url) {
  return new Promise(res => {
    http.get(url, r => { r.resume(); res(r.statusCode); }).on("error", () => res(0));
  });
}

/* Which onboarding screen is on display. */
/* offsetParent, not [hidden]: a screen inside a hidden container still
   carries no hidden attribute of its own, and reading the attribute reported
   a screen that was nowhere on the page. Ask the layout. */
async function screenId(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll(".st-screen");
    for (const s of all) if (s.offsetParent !== null) return s.getAttribute("data-sc");
    return "(none)";
  });
}

/* localStorage AND the cookie mirror: js/account.js falls back to the cookie
   when localStorage is empty, so clearing one leaves the reader remembered. */
async function wipe(page) {
  const cookies = await page.cookies();
  if (cookies.length) await page.deleteCookie(...cookies);
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) {}
    try {
      document.cookie = "fb_acct_v1=; Max-Age=0; path=/";
    } catch (e) {}
  });
}

async function waitScreen(page, want, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await screenId(page)) === want) return Date.now() - t0;
    await sleep(25);
  }
  return -1;
}

async function visibleText(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll(".st-screen");
    for (const s of all) {
      if (s.offsetParent !== null) {
        const clone = s.cloneNode(true);
        clone.querySelectorAll("[hidden]").forEach(n => n.remove());
        return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    return "";
  });
}

/* How far along the bar says we are. */
async function barPct(page) {
  /* The fill has a .38s width transition, so the rendered width mid-move is
     not the answer to "where does the bar say we are". Read the declared
     target; drawnPct() below checks it actually gets there. */
  return page.evaluate(() => {
    const t = document.getElementById("ob-track"), f = document.getElementById("ob-fill");
    if (!t || !f) return null;
    if (t.hasAttribute("hidden")) return -1;
    return parseInt(f.style.width, 10);
  });
}

async function drawnPct(page) {
  await sleep(500);                       /* past the .38s transition */
  return page.evaluate(() => {
    const t = document.getElementById("ob-track"), f = document.getElementById("ob-fill");
    if (!t || !f || t.hasAttribute("hidden")) return -1;
    const outer = t.getBoundingClientRect().width || 1;
    return Math.round((f.getBoundingClientRect().width / outer) * 100);
  });
}

/* Wait for the entrance animation to finish before measuring anything's
   position. .st-screen.is-in starts at translateY(10px), so a rect read
   mid-flight is up to 10px low — which reported the result screen's button as
   2px BELOW --bottom-safe when it is in fact 8px above it. A geometry check
   that measures during a transition is a geometry check that reports noise. */
async function settle(page) {
  try {
    await page.evaluate(() => Promise.all(
      document.getAnimations().map(a => a.finished.catch(() => {}))));
  } catch (e) {}
  await sleep(80);
}

/* Every tappable thing on screen right now, with its bottom edge. */
async function tappables(page) {
  return page.evaluate(() => {
    const bs = Math.max(0.13 * window.innerHeight, 64);   /* --bottom-safe */
    const line = window.innerHeight - bs;
    const out = [];
    document.querySelectorAll("button, a[href], [role='button']").forEach(n => {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (!n.offsetParent && getComputedStyle(n).position !== "fixed") return;
      out.push({
        tag: n.tagName.toLowerCase(),
        id: n.id || "",
        label: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34),
        bottom: Math.round(r.bottom)
      });
    });
    return { line: Math.round(line), vh: window.innerHeight, items: out };
  });
}

/* WCAG contrast, measured in the page against the real composited ground. */
const CONTRAST_FN = `(pairs) => {
  function parse(c){
    const m = String(c).match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    const p = m[1].split(",").map(x => parseFloat(x));
    return { r:p[0], g:p[1], b:p[2], a:(p.length>3?p[3]:1) };
  }
  function over(fg, bg){
    if (fg.a >= 1) return fg;
    return { r: fg.r*fg.a + bg.r*(1-fg.a), g: fg.g*fg.a + bg.g*(1-fg.a),
             b: fg.b*fg.a + bg.b*(1-fg.a), a:1 };
  }
  function groundOf(node){
    let n = node, seen = { r:255, g:255, b:255, a:1 };
    const stack = [];
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      n = n.parentElement;
    }
    let g = seen;
    for (let i = stack.length - 1; i >= 0; i--) g = over(stack[i], g);
    return g;
  }
  function lum(c){
    const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
  }
  const out = [];
  for (const p of pairs) {
    const node = document.querySelector(p.sel);
    if (!node) { out.push({ what: p.what, ratio: null, note: "not found: " + p.sel }); continue; }
    const cs = getComputedStyle(node);
    const g = groundOf(node.parentElement || document.body);
    const fg = over(parse(cs.color), g);
    const L1 = lum(fg), L2 = lum(g);
    const ratio = (Math.max(L1,L2) + 0.05) / (Math.min(L1,L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight,10) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    out.push({ what: p.what, ratio: Math.round(ratio*100)/100, px: Math.round(px*10)/10,
               large, need: large ? 3 : 4.5,
               fg: cs.color, bg: "rgb(" + [g.r,g.g,g.b].map(Math.round).join(",") + ")" });
  }
  return out;
}`;

/* The six questions, and the tap that answers each. */
const Q = [
  ["interests",  '#ob-interests-opts button[data-k="mysteries"]',  "#ob-interests-go"],
  ["motivation", '#ob-motivation-opts button[data-k="conversation"]', "#ob-motivation-go"],
  ["barrier",    '#ob-barrier-opts button[data-k="forget"]',       "#ob-barrier-go"],
  ["scrolling",  '#ob-scrolling-opts button[data-k="too_much"]',   "#ob-scrolling-go"],
  ["goal",       '#ob-goal-opts button[data-k="10"]',              "#ob-goal-go"],
  ["future",     '#ob-future-opts button[data-k="storyteller"]',   "#ob-future-go"]
];

const ORDER = ["intro", "interests", "motivation", "affirm", "barrier",
               "scrolling", "reframe", "goal", "future", "building", "ready"];

/* Walk from the intro to `stop`, answering everything on the way. */
async function walkTo(page, stop) {
  for (const name of ORDER) {
    if (name === stop) return;
    const q = Q.find(x => x[0] === name);
    if (q) {
      await page.evaluate(s => document.querySelector(s).click(), q[1]);
      await page.click(q[2]);
    } else if (name === "intro")   await page.click("#ob-intro-go");
    else if (name === "affirm")    await page.click("#ob-affirm-go");
    else if (name === "reframe")   await page.click("#ob-reframe-go");
    else if (name === "building")  { await waitScreen(page, "ready", 6000); return; }
    await sleep(120);
  }
}

(async () => {
  const index = await new Promise(res => {
    http.get(BASE + "/data/index.json", r => {
      let b = ""; r.on("data", c => b += c); r.on("end", () => res(JSON.parse(b)));
    });
  });
  const cards = index.stacks.reduce((n, s) => n + s.cards.length, 0);
  console.log(`data/index.json: ${index.stacks.length} stories, ${cards} cards`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=" + W + "," + (H + 100)],
    defaultViewport: { width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  const jsErrors = [];
  page.on("pageerror", e => jsErrors.push(String(e.message)));
  const badReqs = [];
  page.on("requestfailed", r => badReqs.push(r.url()));
  page.on("response", r => { if (r.status() >= 400) badReqs.push(r.status() + " " + r.url()); });
  page.on("console", m => { if (m.type() === "error") jsErrors.push("console: " + m.text()); });

  await page.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await sleep(500);

  console.log("\n== 1. the intro, and no site chrome ==");
  ok("lands on the intro", (await screenId(page)) === "intro", await screenId(page));
  ok("no progress bar on screen 1", (await barPct(page)) === -1);
  const chrome = await page.evaluate(() => {
    const vis = s => { const n = document.querySelector(s);
      return !!(n && n.offsetParent !== null); };
    return {
      body: document.body.className,
      nav: vis(".mast .tabs"), mast: vis(".mast h1"), legal: vis("#jn-legal"),
      insignia: vis("#fb-acct"), haveacct: vis(".jn-haveacct"),
      wordmark: vis(".ob-mark"), signin: vis("#ob-signin"),
      money: [...document.querySelectorAll(".jn-panel")]
               .filter(n => n.offsetParent !== null).map(n => n.id)
    };
  });
  ok("body carries ob-on", chrome.body.indexOf("ob-on") !== -1, JSON.stringify(chrome.body));
  ok("Explore/Library nav hidden", !chrome.nav);
  ok("marketing headline hidden", !chrome.mast);
  ok("Privacy/Terms/Support hidden", !chrome.legal);
  ok("account insignia hidden", !chrome.insignia);
  ok("no money panel on screen", chrome.money.length === 0, JSON.stringify(chrome.money));
  ok("the wordmark is kept", chrome.wordmark);
  ok('the one "Already have an account? Sign in" is kept', chrome.signin);
  await settle(page);
  await page.screenshot({ path: "/tmp/ob-1-intro.png" });

  console.log("\n== 2. multi-select needs one; single-select does not auto-advance ==");
  await page.click("#ob-intro-go");
  ok("Build my feed -> interests", (await waitScreen(page, "interests")) >= 0);
  let dis = await page.evaluate(() => document.getElementById("ob-interests-go").disabled);
  ok("Continue is disabled with nothing chosen", dis === true);
  await page.evaluate(() => document.querySelector('#ob-interests-opts button[data-k="mysteries"]').click());
  await sleep(500);
  ok("tapping an interest does NOT auto-advance", (await screenId(page)) === "interests", await screenId(page));
  dis = await page.evaluate(() => document.getElementById("ob-interests-go").disabled);
  ok("Continue enables after one", dis === false);
  await page.evaluate(() => document.querySelector('#ob-interests-opts button[data-k="betrayal"]').click());
  const picked = await page.evaluate(() =>
    [...document.querySelectorAll('#ob-interests-opts button[aria-pressed="true"]')].map(n => n.dataset.k));
  ok("multi-select really is multi", picked.length === 2, JSON.stringify(picked));
  await settle(page);
  await page.screenshot({ path: "/tmp/ob-2-interests.png" });
  const bar2 = await barPct(page);
  await page.click("#ob-interests-go");
  ok("Continue -> motivation", (await waitScreen(page, "motivation")) >= 0);

  dis = await page.evaluate(() => document.getElementById("ob-motivation-go").disabled);
  ok("single-select Continue starts disabled", dis === true);
  await page.evaluate(() => document.querySelector('#ob-motivation-opts button[data-k="conversation"]').click());
  await sleep(600);
  ok("single-select does NOT auto-advance", (await screenId(page)) === "motivation", await screenId(page));
  dis = await page.evaluate(() => document.getElementById("ob-motivation-go").disabled);
  ok("and Continue is now enabled", dis === false);
  const bar3 = await barPct(page);
  ok("the bar moved forward", bar3 > bar2, bar2 + "% -> " + bar3 + "%");

  console.log("\n== 3. Back preserves answers and moves the bar BACK ==");
  await page.click("#ob-back");
  ok("Back -> interests", (await waitScreen(page, "interests")) >= 0);
  const bar2b = await barPct(page);
  const drawn2b = await drawnPct(page);
  ok("the bar moved back", bar2b === bar2, bar3 + "% -> " + bar2b + "% (was " + bar2 + "%)");
  ok("and it is actually drawn there", Math.abs(drawn2b - bar2b) <= 2,
     "rendered " + drawn2b + "% vs declared " + bar2b + "%");
  const kept = await page.evaluate(() =>
    [...document.querySelectorAll('#ob-interests-opts button[aria-pressed="true"]')].map(n => n.dataset.k));
  ok("both interests still selected after Back", kept.length === 2, JSON.stringify(kept));
  await page.click("#ob-interests-go"); await waitScreen(page, "motivation");
  const keptM = await page.evaluate(() =>
    [...document.querySelectorAll('#ob-motivation-opts button[aria-checked="true"]')].map(n => n.dataset.k));
  ok("the motivation answer survived the round trip", keptM.join() === "conversation", JSON.stringify(keptM));

  console.log("\n== 4. screen 4 makes no claim about anybody ==");
  await page.click("#ob-motivation-go");
  ok("-> affirm", (await waitScreen(page, "affirm")) >= 0);
  const affirm = await visibleText(page);
  console.log("  screen 4 reads: " + affirm);
  const banned = ["%", "87", "92", "78", "of Factbox readers", "more confident",
                  "more knowledgeable", "survey", "studies show"];
  for (const b of banned) ok('screen 4 does not contain "' + b + '"', affirm.indexOf(b) === -1);
  const stat = await page.evaluate(() => document.getElementById("ob-stat").textContent.trim());
  ok("the big number is the real card count", stat === String(cards),
     stat + " vs index.json " + cards);
  await settle(page);
  await page.screenshot({ path: "/tmp/ob-4-affirm.png" });

  console.log("\n== 5. every screen has visible words, and nothing below --bottom-safe ==");
  await wipe(page);
  await page.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await sleep(400);
  ok("a wiped browser is asked the questions again",
     (await screenId(page)) === "intro", await screenId(page));
  const lens = {};
  for (const name of ORDER) {
    if (name === "building") { await waitScreen(page, "building", 3000); }
    const here = await screenId(page);
    ok("on " + name, here === name, "saw " + here);
    const t = await visibleText(page);
    lens[name] = t.length;
    ok("  " + name + " has visible text", t.length > 30,
       t.length + " chars: " + t.slice(0, 58) + "…");
    await settle(page);
    const tap = await tappables(page);
    const below = tap.items.filter(x => x.bottom > tap.line);
    const lowest = tap.items.length ? Math.max(...tap.items.map(x => x.bottom)) : 0;
    ok("  " + name + ": nothing tappable below --bottom-safe (" + tap.line + "px of " + tap.vh + ")",
       below.length === 0,
       below.length ? JSON.stringify(below) : tap.items.length + " controls, lowest " + lowest + "px");
    if (name === "reframe") await settle(page);
  await page.screenshot({ path: "/tmp/ob-7-reframe.png" });
    if (name === "ready") break;
    const q = Q.find(x => x[0] === name);
    if (q) { await page.evaluate(s => document.querySelector(s).click(), q[1]); await page.click(q[2]); }
    else if (name === "intro")    await page.click("#ob-intro-go");
    else if (name === "affirm")   await page.click("#ob-affirm-go");
    else if (name === "reframe")  await page.click("#ob-reframe-go");
    else if (name === "building") { await waitScreen(page, "ready", 6000); }
    await sleep(150);
  }

  console.log("\n== 6. screen 11 shows the answers actually given ==");
  const ready = await page.evaluate(() => ({
    text: document.getElementById("sc-ready").innerText.replace(/\s+/g, " ").trim(),
    feed: document.getElementById("ob-sum-feed").textContent.trim(),
    goal: document.getElementById("ob-sum-goal").textContent.trim(),
    why: document.getElementById("ob-sum-why").textContent.trim(),
    cta: document.getElementById("ob-ready-go").getAttribute("href"),
    ctaText: document.getElementById("ob-ready-go").textContent.trim()
  }));
  console.log("  feed: " + ready.feed + "\n  goal: " + ready.goal + "\n  why : " + ready.why);
  ok("feed line is the interest that was tapped", /Mysteries/i.test(ready.feed), ready.feed);
  ok("goal line is the goal that was tapped (10)", ready.goal === "10 minutes a day", ready.goal);
  ok("why line is the motivation that was tapped",
     ready.why === "Better things to talk about", ready.why);
  ok("the arc is there", /Today/i.test(ready.text) && /30 days/i.test(ready.text) &&
     /3 months/i.test(ready.text));
  ok('CTA reads "Start my first story"', ready.ctaText === "Start my first story", ready.ctaText);
  ok("CTA points into the free story", /^\/read\?s=01$/.test(ready.cta), ready.cta);
  ok("and that URL renders", (await head(BASE + "/read.html?s=01")) === 200);
  await settle(page);
  await page.screenshot({ path: "/tmp/ob-11-ready.png" });

  console.log("\n== 7. what was stored ==");
  const rec = await page.evaluate(() => ({
    ls: localStorage.getItem("fb_acct_v1"),
    cookie: document.cookie.indexOf("fb_acct_v1") !== -1,
    fba: window.FBA ? window.FBA.get() : null,
    preview: window.FBPS ? window.FBPS.preview() : null
  }));
  console.log("  localStorage fb_acct_v1 = " + rec.ls);
  console.log("  FBPS.preview()          = " + JSON.stringify(rec.preview));
  ok("one localStorage key, the existing one", !!rec.ls);
  ok("cookie mirror written", rec.cookie);
  ok("interests = the screen-2 taps",
     JSON.stringify(rec.fba.interests) === '["mysteries"]', JSON.stringify(rec.fba.interests));
  ok("goal = the screen-8 tap", rec.fba.goal === 10, rec.fba.goal);
  ok("onboarding marked finished", rec.fba.onboarded === true);
  ok("nothing money-shaped stored", rec.fba.plan === "" && rec.fba.email === "",
     "plan=" + JSON.stringify(rec.fba.plan) + " email=" + JSON.stringify(rec.fba.email));

  console.log("\n== 7b. progress survives a refresh ==");
  await page.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await wipe(page);
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(400);
  await page.click("#ob-intro-go"); await waitScreen(page, "interests");
  await page.evaluate(() => document.querySelector('#ob-interests-opts button[data-k="wars_empires"]').click());
  await page.click("#ob-interests-go"); await waitScreen(page, "motivation");
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(500);
  const kept2 = await page.evaluate(() =>
    [...document.querySelectorAll('#ob-interests-opts button[aria-pressed="true"]')].map(n => n.dataset.k));
  ok("the stored answer is repainted after a refresh",
     kept2.join() === "wars_empires", JSON.stringify(kept2));
  const dis2 = await page.evaluate(() => document.getElementById("ob-interests-go").disabled);
  ok("and its Continue is enabled again without re-tapping", dis2 === false);

  /* Finish the flow so section 8 has a reader who has been through it. */
  await page.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await sleep(300);
  await walkTo(page, "ready");
  await waitScreen(page, "ready", 8000);

  console.log("\n== 8. the money side is reachable and untouched ==");
  await page.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await sleep(600);
  const money = await page.evaluate(() => ({
    screens: [...document.querySelectorAll(".st-screen")].filter(n => n.offsetParent !== null).length,
    panel: [...document.querySelectorAll(".jn-panel")].filter(n => n.offsetParent !== null).map(n => n.id),
    body: document.body.className,
    nav: !!document.querySelector(".mast .tabs") && document.querySelector(".mast .tabs").offsetParent !== null,
    legal: !!document.getElementById("jn-legal") && document.getElementById("jn-legal").offsetParent !== null
  }));
  ok("a reader who finished the questions is not asked again",
     money.screens === 0, money.screens + " onboarding screens visible");
  ok("and no onboarding screen is left claiming to be on display",
     (await screenId(page)) === "(none)", await screenId(page));
  ok("they land on the sign-up form", money.panel.join() === "jn-you", JSON.stringify(money.panel));
  ok("ob-on is off", money.body.indexOf("ob-on") === -1, JSON.stringify(money.body));
  ok("the site chrome is back for the money side", money.nav && money.legal);

  const plan = await page.evaluate(() => {
    /* jump to the prices the way the loader does */
    const s = document.getElementById("jn-plan");
    return { exists: !!s };
  });
  ok("#jn-plan is still in the page", plan.exists);

  console.log("\n== 9. the Continue button against --bottom-safe, at three sizes ==");
  for (const [w, h, label] of [[430, 932, "phone"], [375, 667, "small phone"], [1440, 900, "desktop"]]) {
    const p2 = await browser.newPage();
    await p2.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await p2.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
    await wipe(p2);
    await p2.reload({ waitUntil: "networkidle0" });
    await sleep(400);
    const rows = [];
    for (const name of ORDER) {
      const here = await screenId(p2);
      if (here !== name) { rows.push(name + ": NOT REACHED (on " + here + ")"); break; }
      await settle(p2);
      const m = await p2.evaluate(() => {
        const bs = Math.max(0.13 * window.innerHeight, 64);
        const line = window.innerHeight - bs;
        const s = [...document.querySelectorAll(".st-screen")].find(n => !n.hasAttribute("hidden"));
        const go = s ? s.querySelector(".go") : null;
        const r = go ? go.getBoundingClientRect() : null;
        return {
          line: Math.round(line), vh: window.innerHeight,
          bottom: r ? Math.round(r.bottom) : null,
          scrolls: document.documentElement.scrollHeight > window.innerHeight + 1
        };
      });
      rows.push(name.padEnd(11) + " CTA bottom " + String(m.bottom).padStart(4) +
                "px  line " + m.line + "px  clearance " +
                (m.bottom === null ? "n/a" : String(m.line - m.bottom) + "px") +
                (m.scrolls ? "  PAGE SCROLLS" : ""));
      if (m.bottom !== null && m.bottom > m.line) fails++;
      if (m.scrolls) fails++;
      if (name === "ready") break;
      if (name === "building") { await waitScreen(p2, "ready", 6000); continue; }
      const q = Q.find(x => x[0] === name);
      if (q) { await p2.evaluate(s => document.querySelector(s).click(), q[1]); await p2.click(q[2]); }
      else if (name === "intro")   await p2.click("#ob-intro-go");
      else if (name === "affirm")  await p2.click("#ob-affirm-go");
      else if (name === "reframe") await p2.click("#ob-reframe-go");
      await sleep(140);
    }
    console.log("  --- " + label + " " + w + "x" + h + " ---");
    for (const r of rows) console.log("      " + r);
    if (w === 430) {
      /* landscape, which is shorter than any portrait phone */
      await p2.setViewport({ width: 932, height: 430, isMobile: true, hasTouch: true });
      await sleep(300);
      await settle(p2);
      const land = await p2.evaluate(() => {
        const bs = Math.max(0.13 * window.innerHeight, 64);
        const line = window.innerHeight - bs;
        const s = [...document.querySelectorAll(".st-screen")].find(n => !n.hasAttribute("hidden"));
        const go = s ? s.querySelector(".go, a.go") : null;
        const r = go ? go.getBoundingClientRect() : null;
        return { line: Math.round(line), bottom: r ? Math.round(r.bottom) : null,
                 scrolls: document.documentElement.scrollHeight > window.innerHeight + 1 };
      });
      console.log("      landscape 932x430  CTA bottom " + land.bottom + "px  line " +
                  land.line + "px" + (land.scrolls ? "  PAGE SCROLLS" : ""));
      ok("landscape: CTA above --bottom-safe",
         land.bottom === null || land.bottom <= land.line, JSON.stringify(land));
    }
    await p2.close();
  }

  console.log("\n== 10. contrast, measured ==");
  const cpage = await browser.newPage();
  await cpage.setViewport({ width: W, height: H });
  await cpage.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  await wipe(cpage);
  await cpage.reload({ waitUntil: "networkidle0" });
  await sleep(400);
  await cpage.click("#ob-intro-go"); await waitScreen(cpage, "interests");
  await cpage.evaluate(() => document.querySelector('#ob-interests-opts button[data-k="mysteries"]').click());
  const fn = await cpage.evaluateHandle(`(${CONTRAST_FN})`);
  const pairs = await cpage.evaluate((f, p) => f(p), fn, [
    { what: "question headline on the page", sel: "#sc-interests-h" },
    { what: "the sub-line under it", sel: "#sc-interests > .ob-sub" },
    { what: "answer card label on the card", sel: '#ob-interests-opts button[data-k="wars_empires"] b' },
    { what: "SELECTED answer card label", sel: '#ob-interests-opts button[data-k="mysteries"] b' },
    { what: "the wordmark", sel: ".ob-mark" },
    { what: "Continue label on the accent fill", sel: "#ob-interests-go" },
    { what: '"Already have an account?"', sel: "#ob-signin" }
  ]);
  for (const p of pairs) {
    if (p.ratio === null) { ok(p.what, false, p.note); continue; }
    ok(p.what.padEnd(34) + " " + p.ratio + ":1 (needs " + p.need + ")",
       p.ratio >= p.need, p.px + "px" + (p.large ? " large" : "") + "  " + p.fg + " on " + p.bg);
  }

  console.log("\n== 11. the page with no JavaScript at all ==");
  const dead = await browser.newPage();
  await dead.setViewport({ width: W, height: H });
  await dead.setJavaScriptEnabled(false);
  await dead.goto(BASE + "/join.html", { waitUntil: "networkidle0" });
  const raw = await dead.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
  const musts = ["History you’ll actually remember.",
                 "What can you never resist reading about?",
                 "What do you want to get out of Factbox?",
                 "cards of history",
                 "What usually gets in the way of learning?",
                 "How much time do you spend scrolling every day?",
                 "You already have time to learn.",
                 "How much time do you want to spend getting smarter each day?",
                 "Three months from now",
                 "Building your Factbox",
                 "A smarter 5 minutes, built for you.",
                 "What’s your email?", "Pick a plan", "days free"];
  ok("script-less page still carries every screen's words",
     musts.every(m => raw.indexOf(m) !== -1), raw.length + " chars, missing: " +
     JSON.stringify(musts.filter(m => raw.indexOf(m) === -1)));
  await dead.close();

  console.log("\n== 12. /start is a door, not a second flow ==");
  const st = await browser.newPage();
  await st.setViewport({ width: W, height: H });
  await st.goto(BASE + "/start.html", { waitUntil: "networkidle0" });
  const door = await st.evaluate(() => ({
    screens: document.querySelectorAll(".st-screen").length,
    opts: document.querySelectorAll("[data-k]").length,
    action: document.querySelector("form") ? document.querySelector("form").getAttribute("action") : null,
    button: !!document.querySelector("button"),
    text: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 70)
  }));
  ok("/start asks no questions", door.opts === 0, door.opts + " option buttons");
  ok("/start is one screen", door.screens === 1, door.screens);
  ok("/start has a real button", door.button);
  ok("/start's door goes to /join", door.action === "/join", door.action);
  console.log("  /start reads: " + door.text);
  await st.close();

  console.log("\n== 13. errors and requests ==");
  console.log("  requests that did not return 200: " + JSON.stringify(badReqs));
  const realErrors = jsErrors.filter(e => e.indexOf("Failed to load resource") === -1);
  const notFavicon = badReqs.filter(u => u.indexOf("favicon") === -1);
  ok("no page script errors", realErrors.length === 0, JSON.stringify(realErrors));
  ok("no failed request other than the favicon this local server does not have",
     notFavicon.length === 0, JSON.stringify(notFavicon));

  const shots = ["/tmp/ob-1-intro.png", "/tmp/ob-2-interests.png", "/tmp/ob-4-affirm.png",
                 "/tmp/ob-7-reframe.png", "/tmp/ob-11-ready.png"];
  console.log("\n  screenshots: " + shots.filter(f => fs.existsSync(f)).join(", "));

  console.log("\n" + (fails ? fails + " FAILED" : "ALL PASSED"));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("harness error: " + e.stack); process.exit(1); });
