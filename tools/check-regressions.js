/* Bugs that have already been fixed once, asserted so they cannot come back.

   Every entry here is a real defect that shipped or was about to. The site has
   a cofounder writing parallel branches against the same design document, so
   the realistic way each of these returns is a merge — someone takes a diff
   that looks reasonable and quietly reinstates the thing it took a day to
   find. A grep is a cheap guard against that.

   Static checks on the source, deliberately: a behavioural test only fails
   when the exact conditions line up, and several of these need a signed-in
   subscriber with a slow Firestore to reproduce.

   Run:  node tools/check-regressions.js
*/
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = f => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { return ""; } };

const CHECKS = [
  {
    name: "library draws open, then corrects",
    why: "Asking the gate at render time padlocks a paying reader, because the " +
         "subscription answer has not arrived yet, and nothing redraws. Reported " +
         "live: signed in, every cover locked, stories opening fine when tapped.",
    pass: () => {
      const s = read("js/library.js");
      return /var OPEN = true/.test(s) &&
             /function unlocked\(\)\s*\{\s*return OPEN;/.test(s) &&
             /FBX\.paint/.test(s);
    },
  },
  {
    name: "the streak treats FBP timestamps as milliseconds",
    why: "js/progress.js returns `at: r[2] * 1000`, already milliseconds. " +
         "Dividing by 1000 again before the day number makes every streak 0.",
    pass: () => {
      /* Every copy of this arithmetic, not just the first one written. The
         guard read only js/today.js, so when account.html grew its own week
         row the check went quiet without going red — a guard that passes
         because it is looking somewhere else is worse than no guard. */
      const files = ["js/today.js", "account.html", "js/recommend.js"];
      let seen = false;
      for (const f of files) {
        const s = read(f);
        if (!/streakOf/.test(s)) continue;           // this file has no copy
        seen = true;
        if (!/r\.at \/ DAY_MS/.test(s)) return `${f}: streakOf does not divide by DAY_MS`;
        if (/r\.at \* 1000/.test(s))    return `${f}: multiplies r.at by 1000 again`;
        if (/at \/ 1000/.test(s))       return `${f}: divides at by 1000 again`;
      }
      return true;                                   // nobody has one, fine
    },
  },
  {
    name: "no second global shadows another",
    why: "An account control that publishes window.FBA collides with " +
         "js/account.js's FBA, and the reader's own answers stop reaching /join.",
    pass: () => {
      const owners = {};
      for (const f of fs.readdirSync(path.join(ROOT, "js"))) {
        if (!f.endsWith(".js")) continue;
        const s = read("js/" + f);
        const re = /window\.(FB[A-Za-z]*)\s*=/g;
        let m;
        while ((m = re.exec(s))) {
          if (owners[m[1]] && owners[m[1]] !== f) return false;
          owners[m[1]] = f;
        }
      }
      return true;
    },
  },
  {
    name: "onboarding writes to one store, not two",
    why: "A private localStorage key means /join repaints from the old answers " +
         "and the reader is asked the same six questions twice.",
    pass: () => !/fb-onboarding/.test(read("js/start.js") + read("start.html")),
  },
  {
    name: "no page reloads itself on an access change",
    why: "FBX.onChange fires as soon as the answer is known — before the first " +
         "render finishes — so reload-on-change reloaded forever. /stories " +
         "shipped that. FBX.correct() is the only safe form.",
    pass: () => {
      for (const f of ["stories.html", "index.html", "explore.html", "library.html", "read.html"]) {
        const s = read(f);
        if (/onChange\s*\([^)]*\)[^;]{0,200}location\.reload/.test(s.replace(/\s+/g, " "))) return false;
      }
      return !/location\.reload/.test(read("js/library.js") + read("js/today.js"));
    },
  },
  {
    name: "analytics only transmits from the live site",
    why: "Without this every local test run posts into the production project. " +
         "One afternoon of verification put ~500 phantom users in the dashboard.",
    pass: () => /factbox\.app/.test(read("js/analytics.js")) && /onLiveSite/.test(read("js/analytics.js")),
  },
  {
    name: "every cover has a fallback plate",
    why: "A thumbnail that 404s leaves a hole in the grid with a title under it.",
    pass: () => {
      for (const f of ["stories.html", "start.html"]) {
        const s = read(f);
        if (/\/img\/thumbs\//.test(s) && !/data-fallback/.test(s)) return false;
      }
      for (const f of ["js/today.js", "js/library.js"]) {
        const s = read(f);
        if (/img\/thumbs/.test(s) && !/data-fallback/.test(s)) return false;
      }
      return true;
    },
  },
  {
    name: "the story pages are indexable and each has its own identity",
    why: "The retired /story, /cleopatra and /firststory are generated by " +
         "cutting read.html — which carries robots:noindex, because a reader " +
         "URL with a query string should not be indexed. Inherited unchanged, " +
         "that silently deindexes the flagship page in the founder's bio, and " +
         "all three would share one canonical and one og:url.",
    pass: () => {
      for (const f of ["story.html", "cleopatra.html", "firststory.html"]) {
        const s = read(f);
        if (!s) continue;
        const slug = f.replace(".html", "");
        if (/noindex/.test(s)) return false;
        if (!new RegExp('rel="canonical" href="https://factbox\\.app/' + slug + '"').test(s)) return false;
        if (!new RegExp('og:url" content="https://factbox\\.app/' + slug + '"').test(s)) return false;
      }
      return true;
    },
  },
  {
    name: "the paywall check asserts text the paywall renders",
    why: "tools/README.md and ONBOARDING.md both document a check-page.js run " +
         "against .paywall with an expected sentence in it. That sentence used " +
         "to be 'Two stories are free', under a button reading 'Read the rest " +
         "of this story'; the pane is now the trial paywall and neither " +
         "survives. A check asserting text that no longer exists fails for the " +
         "wrong reason and then gets ignored, which is how a real failure hides " +
         "behind a stale one. So the string is read out of the docs and looked " +
         "for in the two files that can actually draw it.",
    pass: () => {
      const re = /check-page\.js\s+"read\.html\?s=44"\s+"\.paywall"\s+"([^"]+)"/;
      const want = [];
      for (const f of ["tools/README.md", "ONBOARDING.md"]) {
        const m = re.exec(read(f));
        if (!m) return f + " no longer documents the paywall check";
        want.push([f, m[1]]);
      }
      if (want[0][1] !== want[1][1]) {
        return "the two docs assert different text: " +
               want.map(w => w[0] + ' -> "' + w[1] + '"').join(", ");
      }
      /* js/recommend.js draws the real paywall; read.html carries the
         fallback for a page whose recommend.js never arrived. Both have to
         contain it, or the assertion passes only on one of the two paths. */
      const text = want[0][1];
      for (const f of ["js/recommend.js", "read.html"]) {
        if (!read(f).includes(text)) return f + ' never renders "' + text + '"';
      }
      return true;
    },
  },
  {
    name: "the paywall carries no price of its own",
    why: "Stripe charges USD 35.88 a year, not 35.00. A dollar figure typed " +
         "into a screen is a figure that stops tracking what the till takes " +
         "the moment js/account.js changes, and the reader is then charged " +
         "something other than the number they agreed to. Every amount on the " +
         "reader's two money screens is derived from FBA.",
    pass: () => {
      for (const f of ["js/recommend.js", "css/recommend.css", "read.html"]) {
        const s = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
        if (/\$\s?\d/.test(s)) return f + " contains a typed price";
      }
      /* perMonthText quotes a flat per-month figure. $35.88 divides into
         exactly $2.99 so it is true today; $35.00 rounds to $2.92, twelve of
         which is $35.04. perMonthAbout is the one that stays true. */
      if (/perMonthText/.test(read("js/recommend.js").replace(/\/\*[\s\S]*?\*\//g, ""))) {
        return "js/recommend.js uses perMonthText; it must use perMonthAbout";
      }
      return true;
    },
  },
  {
    name: "an existing subscriber is never sold to on the end card",
    why: "The offer line under Keep learning is acquisition. A reader who " +
         "already pays seeing it is being asked for money they are already " +
         "giving, and the end card is rebuilt when the access answer lands " +
         "precisely so that never shows for more than a frame.",
    pass: () => /if \(!open\) \{[\s\S]{0,200}offerLine\(\)/.test(read("js/recommend.js")) &&
                /FBX\.paint/.test(read("read.html")),
  },
  {
    name: "the end card never sends a reader backwards",
    why: "Reported live: 'you read the first one, go to continue, then the " +
         "second story, then it goes back to the first.' The end card used to " +
         "pick its next story by SCORE, and on Cleopatra 02 signed out the " +
         "story just read scored +204 while the story that actually follows " +
         "it scored -1068 for being locked — so Continue pointed backwards, " +
         "and with two free stories that is a loop. What comes next is a " +
         "sequence, not a ranking: runOrder() is catalogue order, forward " +
         "first, pickNext() skips anything already finished, and when there " +
         "is nothing left the button says so.",
    pass: () => {
      const s = read("js/recommend.js");
      if (/var ranked = next\(current/.test(s)) return "the end card is scoring again";
      for (const need of ["function runOrder(", "function pickNext(",
                          "function finished(", "Back to Explore"]) {
        if (!s.includes(need)) return "js/recommend.js has lost " + need;
      }
      return true;
    },
  },
  {
    name: "today's story is free to everyone, on the reader too",
    why: "js/access.js answers three ways now — access, permanently free, or " +
         "today's Factbox — and canRead(id) is the only one that knows all " +
         "three. Asking FB.unlocked() alone puts a paywall in front of the " +
         "one story that is deliberately open to everybody, every day.",
    pass: () => /FBX\.canRead\(s\.id\)/.test(read("read.html")) &&
                /FBX\.isToday/.test(read("js/recommend.js")),
  },
  {
    name: "reading the unlock flag does not grant it",
    why: "js/progress.js's dGet() used to heal: read localStorage, find " +
         "nothing, read the cookie mirror, and WRITE IT BACK. gate.js and " +
         "progress.js's own claim() both call it at parse time on every page, " +
         "so a browser holding nothing but a stale unlock cookie was re-issued " +
         "a browser-level entitlement on its next load. Measured on /explore, " +
         "signed out: all fifty-one open, no padlocks, and the subtitle " +
         "'You have all fifty-one.' /account and /library each carried a " +
         "private 'never call FBP.unlocked() here' workaround; /explore never " +
         "got one. The read is pure now, so there is nothing to remember.",
    pass: () => {
      const s = read("js/progress.js");
      const m = /function dGet\(k\)\s*\{[\s\S]*?\n  \}/.exec(s);
      if (!m) return "dGet() not found in js/progress.js";
      const body = m[0];
      if (/lsSet\(|ckSet\(|localStorage\.setItem|document\.cookie\s*=/.test(body)) {
        return "dGet() writes to a store; a read must not grant access";
      }
      /* The deliberate heal is allowed to exist — the in-app-webview buyer " +
         needs it — but only corroborated by a valid restore token. */
      if (/dHeal\(/.test(s) && !/validToken\(ckGet\(K_TOKEN\)\)/.test(s)) {
        return "the heal is no longer corroborated by a valid restore token";
      }
      return true;
    },
  },
  {
    name: "?unlocked=1 is a parameter, not a substring",
    why: "js/gate.js tested location.search.indexOf('unlocked=1'), which is " +
         "true of any query containing those ten characters anywhere — a " +
         "campaign tag, an encoded next=, a pasted referrer. Measured: " +
         "/explore?ref=not_unlocked=1 minted the flag permanently and handed a " +
         "signed-out reader the whole season.",
    pass: () => {
      const s = read("js/gate.js");
      if (/search\.indexOf\(\s*["']unlocked=1["']\s*\)/.test(s)) {
        return "gate.js is back to a substring test on location.search";
      }
      return /\[\?&\]unlocked=1/.test(s) ||
             "gate.js no longer matches unlocked=1 as a whole parameter";
    },
  },
  {
    name: "a browser flag cannot grant before identity is known",
    why: "Identity has three states and the bug is always in the third. " +
         "Firebase arrives by dynamic import(), so there is a window in which " +
         "nobody has answered. accountDenies() already refuses to DENY in that " +
         "window, which protects a paying reader; nothing refused to GRANT in " +
         "it, which is the direction that gives the season away. Padlocks drawn " +
         "and then removed are the site's render-then-correct rule; padlocks " +
         "absent and then added are the product being given away for as long " +
         "as the answer takes.",
    pass: () => {
      const s = read("js/access.js");
      if (!/function identityUnknown\(\)/.test(s)) {
        return "js/access.js has no identityUnknown() guard";
      }
      const m = /function legacy\(\)\s*\{[\s\S]*?\n  \}/.exec(s);
      if (!m) return "legacy() not found in js/access.js";
      return /identityUnknown\(\)/.test(m[0]) ||
             "legacy() no longer consults identityUnknown()";
    },
  },
  {
    name: "the padlocks and the subtitle answer different questions",
    why: "Padlocks are can() — admin, subscriber, legacy or owner may all " +
         "read. The 'You have all fifty-one' subtitle is a claim about a " +
         "PURCHASE, so it is owns(): subscriber or legacy and nothing else. " +
         "They were one function once, and that is how /explore came to tell " +
         "the site's own owner they had bought the season they wrote.",
    pass: () => {
      const s = read("js/today.js");
      if (!/FBX\.owns \? FBX\.owns\(\)/.test(s)) {
        return "js/today.js no longer gates the subtitle on FBX.owns()";
      }
      const a = read("js/access.js");
      const m = /function owns\(\)\s*\{[\s\S]*?\n  \}/.exec(a);
      if (!m) return "owns() not found in js/access.js";
      if (/"admin"|"owner"/.test(m[0])) {
        return "owns() has been widened to admin or owner mode";
      }
      return true;
    },
  },
  {
    name: "the FREE ribbon is gone from every shelf",
    why: "Removed deliberately: a free cover is already bright and unlocked " +
         "while a paid one is dimmed and padlocked, so the badge added nothing " +
         "a reader could not see and spent a word on 'free' at the moment we " +
         "would rather they thought about the story. The is-free class and the " +
         "data-free attribute are a separate contract and must NOT go with it.",
    pass: () => {
      for (const f of ["js/today.js", "js/library.js"]) {
        if (/freetag/.test(read(f))) return `${f} still draws a .freetag`;
      }
      const t = read("js/today.js");
      if (!/data-free="/.test(t)) return "js/today.js dropped the data-free contract";
      if (!/is-free/.test(t)) return "js/today.js dropped the is-free class";
      return true;
    },
  },
  {
    name: "the story pages still carry the sign-up ask",
    why: "Those three URLs are the marketing funnel. Retiring the illustrated " +
         "deck must not take its call to action with it.",
    pass: () => {
      for (const f of ["story.html", "cleopatra.html", "firststory.html"]) {
        const s = read(f);
        if (!s) continue;
        if (!/\/join\?from=story/.test(s)) return false;
      }
      return true;
    },
  },
];

/* A check returns `true`, or a STRING saying what it found. It used to be
   read as `!!c.pass()`, which made every string a pass — including the ones
   written specifically to say what had broken, because a non-empty string is
   truthy. Three checks in this file reported "ok" while returning their own
   failure message. tools/check-analytics.js already had the right rule; this
   is the same one, and the reason is now printed. */
let bad = 0;
for (const c of CHECKS) {
  let r;
  try { r = c.pass(); } catch (e) { r = "threw: " + e.message; }
  if (r === true) { console.log("ok    " + c.name); continue; }
  bad++;
  console.log("FAIL  " + c.name + "\n      " + c.why +
              (typeof r === "string" ? "\n      -> " + r : "") + "\n");
}
console.log("\n" + CHECKS.length + " regressions guarded, " + bad + " reintroduced");
process.exit(bad ? 1 : 0);
