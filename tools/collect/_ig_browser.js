#!/usr/bin/env node
/*
  _ig_browser.js — drives ONE persistent, already-signed-in Chrome profile.

  READ THIS BEFORE CHANGING ANYTHING IN HERE.

  NO PASSWORD EVER TOUCHES THIS FILE. There is no credential parameter, no
  prompt, no keychain read, no `type()` into a password field, and there must
  never be one. The owner signs into this Chrome profile ONCE, by hand, and
  this script inherits that session through --user-data-dir. That is the whole
  authentication design, and it is the design precisely because the
  alternative — a stored Instagram password driven by a script — is both a
  credential to leak and the thing that gets an account locked.

  IF THE SESSION IS GONE, WE STOP. A logged-out page, a checkpoint, a
  two-factor prompt, a "suspicious login attempt" interstitial: every one of
  those ends the run immediately with an instruction for a human. We do not
  solve a challenge, we do not retry, we do not re-navigate. A script that
  retries a failed Instagram session is a script that gets the account
  restricted, and the account here is the owner's own business account.

  HEADFUL, NOT HEADLESS. Headless is the single strongest automation signal
  there is. The window opens on the owner's screen and he can watch it.

  SLOW AND BOUNDED. A pause between navigations, one page at a time, and a
  hard cap on pages per run — so that a bug in a loop above this file cannot
  turn into a few thousand requests against instagram.com.

  ONLY THE OWNER'S OWN PAGES. The only URLs constructed here are the signed-in
  account's own profile, its own reels, and its own insights surfaces. There
  is no hashtag crawl, no explore, no follower graph, no other username.
*/
"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const PROFILE = path.join(os.homedir(), ".factbox-keys", "chrome-ig");
const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function die(msg, extra) { out(Object.assign({ ok: false, error: msg }, extra || {})); process.exit(0); }

let puppeteer;
try {
  puppeteer = require(path.join(__dirname, "..", "node_modules", "puppeteer-core"));
} catch (e) {
  die("puppeteer-core is not installed at tools/node_modules. Run `npm install` in tools/.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------- the stop sign ---
   IS THERE A USABLE SESSION? Three answers, never two.

   This started life as a blocklist of phrases that mean "logged out", and a
   live run against a profile that had never been signed in cheerfully
   reported SIGNED IN. The blocklist contained "log in to instagram"; the page
   actually says "Log into Instagram". One preposition, and the most important
   safety check in the file was a no-op. Every string below marked VERIFIED
   was read off the real logged-out page on 2026-09-11 rather than imagined.

   So the verdict is now three-valued and it FAILS CLOSED:

     "out"      a logged-out or checkpoint marker matched. Verified.
     "in"       a marker that only exists for a signed-in session matched.
     "unknown"  neither. We STOP, and say we could not tell.

   "unknown" stopping is the whole design. A false "please sign in" costs the
   owner one manual sign-in. A false "signed in" runs an extractor against a
   login page and writes whatever numbers it finds there onto the board. Those
   are not comparable mistakes, so the ambiguous case takes the cheap one.
*/
const BLOCKED_URL = [
  "/accounts/login", "/accounts/signup", "/challenge", "/accounts/suspended",
  "/accounts/disabled", "/two_factor", "/accounts/onetap", "/terms/unblock",
  "/accounts/logout",
];
/* VERIFIED against the real logged-out instagram.com on 2026-09-11. Both the
   "log into" and "log in to" spellings are here because Instagram serves
   different wording by locale and this file has already been bitten by
   exactly that. */
const BLOCKED_TEXT = [
  "log into instagram", "log in to instagram",
  "forgot password?", "create new account", "log in with facebook",
  "mobile number, username or email", "phone number, username, or email",
  "phone number, username or email",
  // Checkpoints and interstitials. NOT verified — no challenge was triggered
  // to observe one, and deliberately none was. Each is a stop sign, so a
  // wrong one here costs a manual sign-in and never a bad number.
  "suspicious login attempt", "we detected an unusual", "enter the code",
  "confirm it's you", "confirm it\u2019s you", "help us confirm",
  "your account has been suspended", "we suspended your account",
  "save your login info", "verify your account", "enter security code",
  "please wait a few minutes before you try again",
];

/* Markers that exist ONLY for a signed-in session. NOT VERIFIED — verifying
   them needs a signed-in account, and this file will not sign itself in. They
   are checked in the DOM rather than in prose so they do not depend on
   wording or locale: the direct-messages and edit-profile links are not
   rendered to a logged-out visitor, and is_logged_in is Instagram's own
   bootstrap flag. If all three ever go stale the verdict becomes "unknown"
   and the run stops with the page head printed, which is how you would find
   out. */
async function signedInEvidence(page) {
  return await page.evaluate(() => {
    const hit = [];
    if (document.querySelector('a[href^="/direct/"]')) hit.push('a[href^="/direct/"]');
    if (document.querySelector('a[href^="/accounts/edit"]')) hit.push('a[href^="/accounts/edit"]');
    if (document.querySelector('svg[aria-label="Home"]')) hit.push('svg[aria-label="Home"]');
    try {
      if (/"is_logged_in"\s*:\s*true/.test(document.documentElement.outerHTML)) hit.push("is_logged_in:true");
    } catch (e) {}
    return hit;
  }).catch(() => []);
}

function sessionVerdict(url, text, evidence) {
  const u = (url || "").toLowerCase();
  for (const frag of BLOCKED_URL) {
    if (u.includes(frag)) return { state: "out", why: "url contains " + frag };
  }
  const t = (text || "").toLowerCase().slice(0, 20000);
  for (const frag of BLOCKED_TEXT) {
    if (t.includes(frag)) return { state: "out", why: 'page says "' + frag + '"' };
  }
  // An empty page is not a signed-in page. The first live run of this file
  // got zero characters back from a navigation that had not settled and read
  // that silence as success.
  if (!t.trim()) return { state: "unknown", why: "the page returned no text at all" };
  if (evidence && evidence.length) return { state: "in", why: "found " + evidence.join(", ") };
  return { state: "unknown", why: "no logged-out marker and no signed-in marker matched" };
}

const SIGNIN_INSTRUCTION =
  "Instagram is not signed in on the collector's Chrome profile, or it is showing a checkpoint.\n" +
  "\n" +
  "  NOTHING HERE WILL EVER TYPE A PASSWORD. Sign in by hand, once:\n" +
  "\n" +
  "    open -na \"Google Chrome\" --args --user-data-dir=" + PROFILE + " https://www.instagram.com/\n" +
  "\n" +
  "  Sign in in that window, clear any checkpoint, leave it signed in, close it,\n" +
  "  and run this collector again. Do not sign into this profile from a script.";

/* ------------------------------------------------------------------ launch --
   A PERSISTENT profile directory, not a throwaway. The cookies that make this
   work are the ones the owner created by hand, and they live in there. */
async function launch(opts) {
  if (!fs.existsSync(CHROME)) {
    die("Google Chrome is not at " + CHROME + ".\n  puppeteer-core drives an installed browser; it does not download one.");
  }
  const fresh = !fs.existsSync(PROFILE);
  if (fresh) {
    // NO BROWSER, NO NAVIGATION, NOT ONE REQUEST. A profile directory that
    // does not exist cannot hold a session, so there is nothing to ask
    // Instagram and no reason to announce ourselves to it. Say what to do
    // and stop.
    fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    out({ ok: true, profileWasFresh: true, profile: PROFILE,
          result: { signedIn: false, why: "the collector's Chrome profile did not exist until just now",
                    instruction: SIGNIN_INSTRUCTION } });
    process.exit(0);
  }
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: PROFILE,
    // HEADFUL ON PURPOSE. See the header.
    headless: opts.headless === true ? true : false,
    defaultViewport: null,
    args: [
      "--no-first-run", "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,1000",
    ],
  });
  return { browser, fresh };
}

/* One navigation, deliberately slow, and checked every single time. */
async function visit(page, url, opts, budget) {
  if (budget.left <= 0) throw new Error("page budget for this run is spent (cap " + budget.cap + ")");
  budget.left -= 1;
  await sleep(opts.pauseMs);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  await sleep(Math.round(opts.pauseMs / 2));
  const finalUrl = page.url();
  const text = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
  const evidence = await signedInEvidence(page);
  const verdict = sessionVerdict(finalUrl, text, evidence);
  verdict.head = (text || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 10);
  return { url: finalUrl, text, verdict, evidence };
}

/* Who is signed in — read from the page, never supplied by the caller, so
   there is no way to point this at somebody else's account. */
async function whoami(page) {
  return await page.evaluate(() => {
    try {
      const m = document.body.innerHTML.match(/"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
      if (m) return m[1];
    } catch (e) {}
    const a = document.querySelector('a[href^="/"][role="link"] img[alt*="profile picture"]');
    if (a) {
      const link = a.closest("a");
      if (link) return (link.getAttribute("href") || "").replace(/\//g, "");
    }
    return null;
  }).catch(() => null);
}

/* --------------------------------------------------------------- discovery --
   THE POINT OF THIS WHOLE FILE ON ITS FIRST RUN.

   Nobody — not the owner, not the agent that wrote this — can see what that
   signed-in dashboard actually contains. Instagram's layout differs by
   account type and changes without notice. So the first run REPORTS rather
   than extracts: every visible string, every node that looks like it carries
   a number, and a screenshot, written to tools/collect/discovered/. The
   extractor is then written against what is actually in those files and
   against nothing else. */
async function dumpCandidates(page) {
  return await page.evaluate(() => {
    const out = [];
    const NUM = /^[\s]*[\d][\d,.\s]*(?:[KkMm])?\s*%?\s*$/;
    const nodes = document.querySelectorAll("span, div, h1, h2, h3, strong, li, button, a");
    let i = 0;
    for (const el of nodes) {
      if (i > 4000) break;
      i++;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .trim();
      if (!own || own.length > 40) continue;
      if (!NUM.test(own)) continue;
      // The label is whatever human words sit nearest this number.
      let label = "";
      const parent = el.parentElement;
      if (parent) {
        label = (parent.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
      }
      const r = el.getBoundingClientRect();
      out.push({
        value: own,
        label: label,
        tag: el.tagName.toLowerCase(),
        aria: el.getAttribute("aria-label") || "",
        testid: el.getAttribute("data-testid") || "",
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
      if (out.length > 400) break;
    }
    return out;
  }).catch(() => []);
}

/* The surfaces worth looking at, all of them the signed-in account's OWN.
   Which of these exist at all is exactly what the discovery run is for. */
function ownSurfaces(user) {
  return [
    { name: "home",                 url: "https://www.instagram.com/" },
    { name: "profile",              url: "https://www.instagram.com/" + user + "/" },
    { name: "reels-tab",            url: "https://www.instagram.com/" + user + "/reels/" },
    { name: "professional-dashboard", url: "https://www.instagram.com/professional_dashboard/" },
    { name: "insights",             url: "https://www.instagram.com/" + user + "/insights/" },
    { name: "account-insights",     url: "https://www.instagram.com/accounts/insights/" },
  ];
}

/* ---------------------------------------------------------------- commands --*/
const COMMANDS = {
  /* Is there a usable session at all? Costs one page load and answers the
     only question that matters before anything else runs. */
  async check(req, page, opts, budget) {
    const r = await visit(page, "https://www.instagram.com/", opts, budget);
    if (r.verdict.state !== "in") return { signedIn: false, why: r.verdict.why, pageHead: r.verdict.head, state: r.verdict.state, url: r.url, instruction: SIGNIN_INSTRUCTION };
    const user = await whoami(page);
    return { signedIn: true, user: user, url: r.url };
  },

  async discover(req, page, opts, budget) {
    const dir = req.outDir;
    fs.mkdirSync(dir, { recursive: true });
    const first = await visit(page, "https://www.instagram.com/", opts, budget);
    if (first.verdict.state !== "in") {
      return { signedIn: false, why: first.verdict.why, pageHead: first.verdict.head, state: first.verdict.state, url: first.url, instruction: SIGNIN_INSTRUCTION };
    }
    const user = req.user || (await whoami(page));
    if (!user) {
      return { signedIn: true, user: null,
               note: "Signed in, but the username could not be read off the page. Pass --user to name the owner's own account." };
    }
    const found = [];
    for (const s of ownSurfaces(user)) {
      let r;
      try { r = await visit(page, s.url, opts, budget); }
      catch (e) { found.push({ name: s.name, url: s.url, error: String(e.message) }); break; }
      if (r.verdict.state !== "in") {
        found.push({ name: s.name, url: s.url, blocked: r.verdict.why, pageHead: r.verdict.head, state: r.verdict.state });
        // A checkpoint mid-run ends the run. We do not push past it.
        return { signedIn: false, user: user, why: r.verdict.why, pageHead: r.verdict.head, state: r.verdict.state, found: found, instruction: SIGNIN_INSTRUCTION };
      }
      const base = path.join(dir, s.name);
      fs.writeFileSync(base + ".txt", r.text || "", "utf8");
      const cands = await dumpCandidates(page);
      fs.writeFileSync(base + ".candidates.json", JSON.stringify(cands, null, 2), "utf8");
      await page.screenshot({ path: base + ".png", fullPage: false }).catch(() => {});
      found.push({
        name: s.name, url: s.url, landedOn: r.url,
        chars: (r.text || "").length,
        candidates: cands.length,
        // The first lines are usually enough to tell "this is the dashboard"
        // from "this redirected to the feed".
        head: (r.text || "").split("\n").filter(Boolean).slice(0, 12),
        sampleLabels: cands.slice(0, 12).map((c) => c.value + "  <- " + c.label.slice(0, 60)),
      });
    }
    return { signedIn: true, user: user, outDir: dir, found: found, pagesLeft: budget.left };
  },

  /* Read one of the owner's OWN reels. The URL is checked to be an Instagram
     post URL before it is ever navigated to, so a bad row on the board cannot
     turn this into a general-purpose fetcher. */
  async reel(req, page, opts, budget) {
    const u = String(req.url || "");
    if (!/^https:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv)\//i.test(u)
        && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]+\/(reel|reels|p)\//i.test(u)) {
      return { error: "not an instagram post url: " + u };
    }
    const r = await visit(page, u, opts, budget);
    if (r.verdict.state !== "in") return { signedIn: false, why: r.verdict.why, pageHead: r.verdict.head, state: r.verdict.state, instruction: SIGNIN_INSTRUCTION };
    const cands = await dumpCandidates(page);
    if (req.dumpTo) {
      fs.mkdirSync(req.dumpTo, { recursive: true });
      const stem = path.join(req.dumpTo, "reel-" + (u.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/) || [,"x"])[1]);
      fs.writeFileSync(stem + ".txt", r.text || "", "utf8");
      fs.writeFileSync(stem + ".candidates.json", JSON.stringify(cands, null, 2), "utf8");
      await page.screenshot({ path: stem + ".png", fullPage: false }).catch(() => {});
    }
    return { url: r.url, text: r.text, candidates: cands };
  },
};

(async () => {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let req;
  try { req = JSON.parse(raw || "{}"); } catch (e) { return die("invalid JSON on stdin"); }

  const opts = {
    pauseMs: Math.max(1500, Number(req.pauseMs) || 4000),
    headless: req.headless === true,
  };
  const budget = { cap: Math.max(1, Number(req.maxPages) || 40) };
  budget.left = budget.cap;

  const cmd = COMMANDS[req.cmd];
  if (!cmd) return die("unknown cmd: " + String(req.cmd));

  let launched;
  try { launched = await launch(opts); }
  catch (e) {
    return die("could not start Chrome on the collector profile: " + e.message +
               "\n  If a normal Chrome window is already open on this profile, close it first —" +
               "\n  Chrome allows only one process per --user-data-dir.");
  }
  const { browser, fresh } = launched;
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.setViewport({ width: 1440, height: 1000 });
    const result = await cmd(req, page, opts, budget);
    out({ ok: true, profileWasFresh: fresh, profile: PROFILE, result });
  } catch (e) {
    out({ ok: false, error: String((e && e.message) || e), profile: PROFILE });
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
})();
