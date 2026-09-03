/* Drives /start in real Chrome at 430x932 and asserts, with numbers.
   node drive-start.js   (from the repo's tools/ directory) */
const puppeteer = require("puppeteer-core");
const http = require("http");

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

async function screenId(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll(".st-screen");
    for (const s of all) if (!s.hasAttribute("hidden")) return s.getAttribute("data-sc");
    return "(none)";
  });
}

async function waitScreen(page, want, ms = 2500) {
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
      if (!s.hasAttribute("hidden")) {
        const clone = s.cloneNode(true);
        clone.querySelectorAll("[hidden]").forEach(n => n.remove());
        return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    return "";
  });
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
        label: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34),
        bottom: Math.round(r.bottom)
      });
    });
    return { line: Math.round(line), vh: window.innerHeight, items: out };
  });
}

(async () => {
  const index = await new Promise(res => {
    http.get(BASE + "/data/index.json", r => {
      let b = ""; r.on("data", c => b += c); r.on("end", () => res(JSON.parse(b)));
    });
  });
  const titles = index.stacks.map(s => s.title);
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

  await page.goto(BASE + "/start.html", { waitUntil: "networkidle0" });
  await sleep(400);

  console.log("\n== 1. the open screen ==");
  ok("lands on the open screen", (await screenId(page)) === "open", await screenId(page));
  const covers = await page.evaluate(() => {
    const box = document.getElementById("st-covers");
    return {
      from: box.getAttribute("data-from"),
      items: [...box.querySelectorAll("li")].map(li => ({
        src: li.querySelector("img") ? li.querySelector("img").getAttribute("src") : null,
        natural: li.querySelector("img") ? li.querySelector("img").naturalWidth : 0,
        title: li.querySelector("b").textContent.trim()
      }))
    };
  });
  ok("covers were built from index.json", covers.from === "index.json", "data-from=" + covers.from);
  ok("three covers", covers.items.length === 3, covers.items.length);
  for (const c of covers.items) {
    const code = await head(BASE + c.src);
    ok("cover " + c.src + " -> " + code, code === 200, "painted " + c.natural + "px wide");
    ok('title is real: "' + c.title + '"', titles.indexOf(c.title) !== -1,
       "index #" + titles.indexOf(c.title));
  }

  console.log("\n== 2. forward: six questions, six taps ==");
  const ANSWERS = [
    ["q1", '#st-q1-opts button[data-k="cleopatra"]', "q2"],
    ["q2", '#st-q2-opts button[data-k="turning"]', "q3"],
    ["q3", '#st-q3-opts button[data-k="stories"]', "q4"],
    ["q4", '#st-q4-opts button[data-k="us_history"]', "q5"],
    ["q5", '#st-q5-opts button[data-k="10"]', "turn"],
    ["q6", '#st-q6-opts button[data-k="30"]', "wait"]
  ];
  let answerTaps = 0, otherTaps = 0;
  const seen = [];

  await page.click("#st-open-go"); otherTaps++;
  ok("Start -> q1", (await waitScreen(page, "q1")) >= 0);

  for (const [from, sel, to] of ANSWERS) {
    if (from === "q6") {
      /* the turn asks nothing; its one control is not an answer */
      await page.click("#st-turn-go"); otherTaps++;
      ok("turn -> q6", (await waitScreen(page, "q6")) >= 0);
    }
    const before = await screenId(page);
    const t = await page.evaluate(s => { document.querySelector(s).click(); return 1; }, sel);
    answerTaps += t;
    const ms = await waitScreen(page, to);
    ok(`one tap on ${from} -> ${to}`, ms >= 0, ms + "ms, no second press");
    seen.push(before + "->" + (await screenId(page)));
  }
  ok("six questions cost exactly six taps", answerTaps === 6, "answer taps=" + answerTaps + ", non-answer taps (Start, Makes sense)=" + otherTaps);
  console.log("  path: " + seen.join(" "));

  console.log("\n== 3. every screen has visible words ==");
  await waitScreen(page, "wait");
  /* walk back, reading each screen on the way */
  const order = ["wait", "q6", "turn", "q5", "q4", "q3", "q2", "q1", "open"];
  const lens = {};
  for (let i = 0; i < order.length; i++) {
    const here = await screenId(page);
    ok("Back lands on " + order[i], here === order[i], "saw " + here);
    const t = await visibleText(page);
    lens[here] = t.length;
    ok("  " + here + " has visible text", t.length > 40, t.length + " chars: " + t.slice(0, 62) + "…");
    const tap = await tappables(page);
    const below = tap.items.filter(x => x.bottom > tap.line);
    ok("  " + here + ": nothing tappable below --bottom-safe (" + tap.line + "px of " + tap.vh + ")",
       below.length === 0, below.length ? JSON.stringify(below) : tap.items.length + " controls, lowest " +
       Math.max(...tap.items.map(x => x.bottom)) + "px");
    if (i < order.length - 1) {
      const t0 = Date.now();
      await page.click("#st-back");
      const got = await waitScreen(page, order[i + 1]);
      ok("  Back from " + here + " goes BACK", got >= 0, (Date.now() - t0) + "ms");
    }
  }
  const backHidden = await page.evaluate(() => document.getElementById("st-back").hasAttribute("hidden"));
  ok("no Back arrow on the first screen", backHidden === true);

  console.log("\n== 4. Back does not become Forward ==");
  await page.click("#st-open-go"); await waitScreen(page, "q1");
  await page.evaluate(() => document.querySelector('#st-q1-opts button[data-k="disaster"]').click());
  await sleep(60);                       /* inside the 260ms advance */
  await page.click("#st-back");
  await sleep(900);                      /* long past when the timer would have fired */
  ok("answer then Back inside 260ms stays on the open screen",
     (await screenId(page)) === "open", await screenId(page));

  console.log("\n== 5. the phone's own back button ==");
  await page.click("#st-open-go"); await waitScreen(page, "q1");
  await page.evaluate(() => document.querySelector('#st-q1-opts button[data-k="cleopatra"]').click());
  await waitScreen(page, "q2");
  await page.goBack();
  ok("Chrome back goes q2 -> q1", (await waitScreen(page, "q1")) >= 0, await screenId(page));

  console.log("\n== 6. the turn screen ==");
  /* forward again to the turn */
  await page.evaluate(() => document.querySelector('#st-q1-opts button[data-k="cleopatra"]').click());
  await waitScreen(page, "q2");
  await page.evaluate(() => document.querySelector('#st-q2-opts button[data-k="people"]').click());
  await waitScreen(page, "q3");
  await page.evaluate(() => document.querySelector('#st-q3-opts button[data-k="stories"]').click());
  await waitScreen(page, "q4");
  await page.evaluate(() => document.querySelector('#st-q4-opts button[data-k="us_history"]').click());
  await waitScreen(page, "q5");
  await page.evaluate(() => document.querySelector('#st-q5-opts button[data-k="5"]').click());
  await waitScreen(page, "turn");
  const turn = await visibleText(page);
  console.log("  turn screen reads: " + turn);
  const banned = ["92%", "87%", "4.2", "%", "more knowledgeable", "more confident"];
  for (const b of banned) ok('turn screen does not contain "' + b + '"', turn.indexOf(b) === -1);
  const facts = await page.evaluate(() => ({
    stories: document.getElementById("st-fact-stories").textContent.trim(),
    cards: document.getElementById("st-fact-cards").textContent.trim(),
    mins: document.getElementById("st-fact-mins").textContent.trim()
  }));
  ok("stories count is the real one", facts.stories === String(index.stacks.length),
     facts.stories + " vs index.json " + index.stacks.length);
  ok("cards count is the real one", facts.cards === String(cards),
     facts.cards + " vs index.json " + cards);
  const secs = index.stacks.map(s => s.secs).sort((a, b) => a - b);
  const med = secs.length % 2 ? secs[(secs.length - 1) / 2]
                              : Math.round((secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2);
  const halves = Math.max(1, Math.round(med / 30));
  const want = Math.floor(halves / 2) + (halves % 2 ? "½" : "") + " min";
  ok("median length is the real one", facts.mins === want, facts.mins + " vs computed " + want + " (median " + med + "s)");

  console.log("\n== 7. the wait, and the hand-off ==");
  await page.click("#st-turn-go"); await waitScreen(page, "q6");
  await page.evaluate(() => document.querySelector('#st-q6-opts button[data-k="14"]').click());
  await waitScreen(page, "wait");
  const building = await page.evaluate(() => {
    const b = document.getElementById("st-building");
    return { shown: !b.hasAttribute("hidden"), text: b.innerText.replace(/\s+/g, " ").trim() };
  });
  ok("the wait names the reader's own picks", building.shown &&
     /Cleopatra/i.test(building.text) && /American history/i.test(building.text) &&
     /five minutes/i.test(building.text) && /14 days/.test(building.text), building.text);
  await sleep(1800);
  const ready = await page.evaluate(() => {
    const r = document.getElementById("st-ready");
    return {
      shown: !r.hasAttribute("hidden"),
      text: r.innerText.replace(/\s+/g, " ").trim(),
      feedFrom: document.getElementById("st-feed").getAttribute("data-from"),
      feed: [...document.querySelectorAll("#st-feed li")].map(li => li.childNodes[0].textContent.trim()),
      handoff: document.getElementById("st-hand-off").getAttribute("href"),
      home: document.getElementById("st-home").getAttribute("href")
    };
  });
  ok("ready state shows", ready.shown, ready.text.slice(0, 80));
  ok("feed built from index.json", ready.feedFrom === "index.json");
  ok("feed titles are real stories", ready.feed.every(t => titles.indexOf(t) !== -1), JSON.stringify(ready.feed));
  ok("feed is the topic that was picked",
     ready.feed.every(t => {
       const s = index.stacks.find(x => x.title === t);
       return s.topic === "cleopatra" || s.topic === "us_history";
     }), ready.feed.map(t => index.stacks.find(x => x.title === t).topic).join(", "));
  ok("hands over to /join", ready.handoff === "/join", ready.handoff);
  ok("and offers home", ready.home === "/", ready.home);
  ok("/join.html still renders", (await head(BASE + "/join.html")) === 200);
  const waitTap = await tappables(page);
  const belowW = waitTap.items.filter(x => x.bottom > waitTap.line);
  ok("ready screen: nothing tappable below --bottom-safe", belowW.length === 0,
     belowW.length ? JSON.stringify(belowW) : "lowest " + Math.max(...waitTap.items.map(x => x.bottom)) +
     "px of " + waitTap.line);

  console.log("\n== 8. what was stored ==");
  const rec = await page.evaluate(() => ({
    ls: localStorage.getItem("fb_acct_v1"),
    cookie: document.cookie.indexOf("fb_acct_v1") !== -1,
    fba: window.FBA ? window.FBA.get() : null,
    path: window.FBPS ? window.FBPS.path() : "(no FBPS)",
    preview: window.FBPS ? window.FBPS.preview() : null
  }));
  console.log("  localStorage fb_acct_v1 = " + rec.ls);
  console.log("  FBPS.preview()          = " + JSON.stringify(rec.preview));
  ok("one localStorage key, the existing one", !!rec.ls);
  ok("cookie mirror written", rec.cookie);
  ok("interests = [q1, q4]", JSON.stringify(rec.fba.interests) === '["cleopatra","us_history"]', JSON.stringify(rec.fba.interests));
  ok("draw = q2", rec.fba.draw === "people", rec.fba.draw);
  ok("relates = q3", JSON.stringify(rec.fba.relates) === '["stories"]', JSON.stringify(rec.fba.relates));
  ok("goal = q5", rec.fba.goal === 5, rec.fba.goal);
  ok("streak = q6", rec.fba.streak === 14, rec.fba.streak);
  ok("nothing money-shaped stored", rec.fba.plan === "" && rec.fba.email === "",
     "plan=" + JSON.stringify(rec.fba.plan) + " email=" + JSON.stringify(rec.fba.email));
  console.log("  requests that did not return 200: " + JSON.stringify(badReqs));
  const realErrors = jsErrors.filter(e => e.indexOf("Failed to load resource") === -1);
  const notFavicon = badReqs.filter(u => u.indexOf("favicon") === -1);
  ok("no page script errors", realErrors.length === 0, JSON.stringify(realErrors));
  ok("no failed request other than the favicon this local server does not have",
     notFavicon.length === 0, JSON.stringify(notFavicon));

  console.log("\n== 9. the page with no JavaScript at all ==");
  const dead = await browser.newPage();
  await dead.setViewport({ width: W, height: H });
  await dead.setJavaScriptEnabled(false);
  await dead.goto(BASE + "/start.html", { waitUntil: "networkidle0" });
  const raw = await dead.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
  const musts = ["Remember history without studying it.", "What do you want to uncover first?",
                 "What hooks you?", "how much of it do you remember?",
                 "what do you wish you knew more about?", "How much time have you got?",
                 "History is easier to remember", "What would you love to get from Factbox?",
                 "Building your Factbox", "51", "450"];
  ok("script-less page still carries every screen's words",
     musts.every(m => raw.indexOf(m) !== -1), raw.length + " chars, missing: " +
     JSON.stringify(musts.filter(m => raw.indexOf(m) === -1)));
  await dead.close();

  console.log("\n" + (fails ? fails + " FAILED" : "ALL PASSED"));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("harness error: " + e.stack); process.exit(1); });
